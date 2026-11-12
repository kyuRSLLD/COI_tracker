#!/usr/bin/env python3
"""Test-only loopback integration: real browser, pilot, SQL limiter and TLS PostgreSQL."""
import ctypes
import io
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import time
from urllib.request import urlopen
from PIL import Image
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[3]
WORK = Path(os.environ['E2E_WORK'])
PASSWORD = 'unique synthetic password 123'
server = vite = None

def interrupt(signum, _frame):
    raise SystemExit(128 + signum)
def timeout(_signum, _frame):
    raise TimeoutError('Synthetic pilot browser test timed out')
signal.signal(signal.SIGTERM, interrupt)
signal.signal(signal.SIGINT, interrupt)
signal.signal(signal.SIGALRM, timeout)
signal.alarm(180)

def wait_file(path, process):
    for _ in range(200):
        if path.exists(): return
        if process.poll() is not None: raise RuntimeError('Test server exited before readiness')
        time.sleep(.1)
    raise RuntimeError('Test server not ready')

def stop(proc):
    if not proc: return 0
    try: os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError: pass
    try: result = proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try: os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        result = proc.wait()
    try: os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError: pass
    return result

def decode_qr(png):
    z = ctypes.CDLL('libzbar.so.0'); void = ctypes.c_void_p
    def sig(name, args, result):
        fn = getattr(z, name); fn.argtypes = args; fn.restype = result; return fn
    scanner = sig('zbar_image_scanner_create', [], void)()
    image = sig('zbar_image_create', [], void)()
    try:
        pixels = Image.open(io.BytesIO(png)).convert('L'); raw = pixels.tobytes(); buf = ctypes.create_string_buffer(raw)
        sig('zbar_image_set_format', [void, ctypes.c_ulong], None)(image, 0x30303859)
        sig('zbar_image_set_size', [void, ctypes.c_uint, ctypes.c_uint], None)(image, *pixels.size)
        sig('zbar_image_set_data', [void, void, ctypes.c_ulong, void], None)(image, buf, len(raw), None)
        assert sig('zbar_scan_image', [void, void], ctypes.c_int)(scanner, image) == 1
        return sig('zbar_symbol_get_data', [void], ctypes.c_char_p)(sig('zbar_image_first_symbol', [void], void)(image)).decode()
    finally:
        sig('zbar_image_destroy', [void], None)(image)
        sig('zbar_image_scanner_destroy', [void], None)(scanner)

try:
    with (WORK / 'server.log').open('w') as server_log, (WORK / 'vite.log').open('w') as vite_log:
        server = subprocess.Popen(['node', '--experimental-strip-types', 'server/test/pilot-e2e-server.ts'], cwd=ROOT, stdout=server_log, stderr=subprocess.STDOUT, env=os.environ.copy(), start_new_session=True)
        wait_file(WORK / 'ports.json', server)
        ports = json.loads((WORK / 'ports.json').read_text())
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); vite_port = sock.getsockname()[1]
        base = f'http://127.0.0.1:{vite_port}'
        vite = subprocess.Popen([str(ROOT / 'node_modules/.bin/vite'), '--config', 'client/tests/pilot-e2e/vite.config.ts', '--port', str(vite_port), '--strictPort'], cwd=ROOT, stdout=vite_log, stderr=subprocess.STDOUT, env={**os.environ, 'E2E_BACKEND_PORT': str(ports['first'])}, start_new_session=True)
        for _ in range(200):
            try:
                with urlopen(base + '/tests/pilot-e2e/index.html', timeout=1) as r: assert r.status == 200
                break
            except OSError:
                if vite.poll() is not None: raise RuntimeError('Vite exited')
                time.sleep(.1)
        else: raise RuntimeError('Vite not ready')
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox', '--disable-background-networking', '--disable-sync', '--no-first-run'])
            contexts, paths, external = [], [], []
            def new_page():
                context = browser.new_context(viewport={'width': 390, 'height': 844}, service_workers='block')
                contexts.append(context)
                def network(route):
                    url = route.request.url
                    if not url.startswith(base + '/'):
                        external.append(url.split(':', 1)[0]); route.abort(); return
                    path = url[len(base):]
                    if path.startswith('/api/'): paths.append(path)
                    route.continue_()
                context.route('**/*', network)
                page = context.new_page(); page.goto(base + '/tests/pilot-e2e/index.html')
                return page
            def signup(page, mailbox, role, first):
                page.get_by_role('button', name='Create account').click()
                page.get_by_label('Email address').fill(mailbox + '@example.test')
                with page.expect_response(lambda r: r.url.endswith('/api/v2/auth/register/request') and r.request.method == 'POST') as request:
                    page.get_by_role('button', name='Send verification code').click()
                assert request.value.status == 202
                expect(page.get_by_role('heading', name='Complete your registration')).to_be_visible()
                mail = WORK / ('mail-' + mailbox); wait_file(mail, server)
                assert mail.stat().st_mode & 0o777 == 0o600
                code = mail.read_text(); assert re.fullmatch(r'[A-Za-z0-9_-]{43}', code)
                page.get_by_label('Verification code').fill(code)
                page.get_by_label('Subcontractor' if role == 'sub' else 'General contractor', exact=True).check()
                page.get_by_label('First name').fill(first); page.get_by_label('Last name').fill('Synthetic')
                page.get_by_label('US phone number').fill('(202) 555-0123'); page.get_by_label('Password').fill(PASSWORD)
                if role == 'sub':
                    page.get_by_label('Company name').fill('Synthetic Electric'); page.get_by_label('Trade', exact=True).fill('Electrical')
                with page.expect_response(lambda r: r.url.endswith('/api/v2/auth/register/confirm') and r.request.method == 'POST') as confirmation:
                    page.get_by_role('button', name='Submit registration').click()
                assert confirmation.value.status == 200
                expect(page.get_by_role('heading', name='Try signing in')).to_be_visible()
                page.get_by_role('button', name='Go to sign in').click()
                page.get_by_label('Email address').fill(mailbox + '@example.test'); page.get_by_label('Password').fill(PASSWORD)
                with page.expect_response(lambda r: r.url.endswith('/api/v2/auth/login') and r.request.method == 'POST') as login:
                    with page.expect_response(lambda r: r.url.endswith('/api/v2/auth/me')) as me:
                        page.get_by_role('button', name='Sign in', exact=True).click()
                assert login.value.status == 200 and me.value.status == 200
                token, identity = login.value.json()['token'], me.value.json()
                assert identity['role'] == role and identity['subject']
                expect(page.get_by_role('heading', name='Profile connections' if role == 'sub' else 'Subcontractor connections')).to_be_visible()
                return token, identity['subject']
            sub, gc, other = new_page(), new_page(), new_page()
            sub_token, _ = signup(sub, 'sub', 'sub', 'Sub')
            gc_token, gc_id = signup(gc, 'gc', 'gc', 'Intended')
            other_token, other_id = signup(other, 'other', 'gc', 'Other')
            assert gc_id != other_id
            headers = lambda token: {'Authorization': 'Bearer ' + token}
            api = sub.context.request
            consent = api.get(base + '/api/v2/connections/consent', headers=headers(sub_token))
            profile = api.get(base + '/api/v2/connections/profile', headers=headers(sub_token))
            assert consent.status == 200 and profile.status == 200
            disclosure, profile_id = consent.json(), profile.json()['profileId']
            expect(sub.get_by_text(disclosure['qrText'], exact=True)).to_be_visible()
            agree = sub.get_by_label('I have read and agree to the exact disclosure above.', exact=True)
            generate = sub.get_by_role('button', name='Generate one-use QR')
            assert not agree.is_checked() and generate.is_disabled() and '/api/v2/connections/qr' not in paths
            agree.check()
            with sub.expect_response(lambda r: r.url.endswith('/api/v2/connections/qr') and r.request.method == 'POST') as qr:
                generate.click()
            assert qr.value.status == 200 and qr.value.request.post_data_json == {'profileId': profile_id, 'consentVersion': disclosure['version'], 'affirmative': True}
            image = sub.get_by_role('img', name='One-use connection QR code'); expect(image).to_be_visible()
            raw = decode_qr(image.screenshot())
            assert re.fullmatch(r'[A-Za-z0-9_-]{43}', raw) and raw == qr.value.json()['token'] and raw not in sub.url
            expect(gc.get_by_text('No connected subcontractors are currently available.')).to_be_visible()
            expect(other.get_by_text('No connected subcontractors are currently available.')).to_be_visible()
            gc.get_by_label('Raw one-time code').fill(raw)
            with gc.expect_response(lambda r: r.url.endswith('/api/v2/connections/qr/redeem') and r.request.method == 'POST') as redemption:
                gc.get_by_role('button', name='Connect', exact=True).click()
            assert redemption.value.status == 204 and redemption.value.request.post_data_json == {'token': raw}
            expect(gc.get_by_role('heading', name='Synthetic Electric')).to_be_visible()
            own = gc.context.request.get(base + '/api/v2/connections/subcontractors', headers=headers(gc_token))
            foreign = other.context.request.get(base + '/api/v2/connections/subcontractors', headers=headers(other_token))
            assert own.status == 200 and len(own.json()['subcontractors']) == 1 and own.json()['subcontractors'][0]['profile_id'] == profile_id
            assert foreign.status == 200 and foreign.json() == {'subcontractors': []}
            replay = other.context.request.post(base + '/api/v2/connections/qr/redeem', headers=headers(other_token), data={'token': raw})
            assert replay.status == 404
            assert other.context.request.get(base + '/api/v2/connections/subcontractors', headers=headers(other_token)).json() == {'subcontractors': []}
            assert api.get(base + '/api/v2/connections/profile').status == 401
            # Existing API revocation is exercised directly, not claimed as a UI test.
            revoked = api.post(base + '/api/v2/connections/revoke', headers=headers(sub_token), data={'profileId': profile_id, 'gcUserId': gc_id})
            assert revoked.status == 204
            assert gc.context.request.get(base + '/api/v2/connections/subcontractors', headers=headers(gc_token)).json() == {'subcontractors': []}
            gc.get_by_role('button', name='Refresh list').click()
            expect(gc.get_by_text('No connected subcontractors are currently available.')).to_be_visible()
            for page in (sub, gc, other):
                assert page.get_by_role('button', name='Private files').count() == 0
                assert page.get_by_role('button', name='Shared files').count() == 0
                assert page.get_by_role('heading', name='Self-reported COI metadata').count() == 0
                assert page.get_by_text('does not verify insurance', exact=False).count() >= 1
                assert page.evaluate("async () => ({local: Object.keys(localStorage), session: Object.keys(sessionStorage), cookie: document.cookie, db: (await indexedDB.databases()).map(x=>x.name), caches: await caches.keys()})") == {'local': [], 'session': [], 'cookie': '', 'db': [], 'caches': []}
                assert page.context.cookies() == []
            assert not any(path.startswith(('/api/v2/self-reported-coi-metadata', '/api/v2/self-reported-private-files')) for path in paths)
            assert not external
            for path in ['/api/v2/self-reported-coi-metadata/own', '/api/v2/self-reported-private-files/own/list', '/api/v2/connections/cois', '/api/v2/connections/invitations', '/api/v2/auth/me?x=1', '/api/v2/%61uth/login', '/api/v2/auth/login/', '/api/client/share/synthetic']:
                assert api.get(base + path, headers=headers(sub_token)).status == 404, path
            gc.get_by_role('button', name='Sign out').click()
            expect(gc.get_by_text('Signed out.', exact=True)).to_be_visible()
            assert gc.context.request.get(base + '/api/v2/auth/me', headers=headers(gc_token)).status == 401
            # Use a fresh synthetic non-account so prior sign-ins do not consume this
            # identity budget. Cross two real factory instances within one fixed minute.
            while time.time() % 60 > 48: time.sleep(.25)
            start_minute = int(time.time() // 60)
            statuses = []
            for n in range(6):
                endpoint = f'http://127.0.0.1:{ports["first" if n % 2 == 0 else "second"]}'
                email = 'Budget@Example.Test' if n % 2 else 'budget@example.test'
                response = api.post(endpoint + '/api/v2/auth/login', data={'email': email, 'password': 'not a real password 123'})
                statuses.append(response.status)
            assert int(time.time() // 60) == start_minute, 'Limiter test crossed fixed-minute boundary'
            assert statuses == [401, 401, 401, 401, 401, 503], statuses
            for context in contexts: context.close()
            browser.close()
        assert stop(server) == 0, 'Pilot stub shutdown checks failed; see server log'
        server = None
        print('PASS: actual pilot + SQL limiter + connection-only shell: synthetic signup/login, disclosure, real QR, replay, tenant isolation, API revoke, logout, routes and shared login budget')
finally:
    signal.alarm(0)
    stop(vite)
    stop(server)
