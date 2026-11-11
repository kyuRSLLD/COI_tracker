#!/usr/bin/env python3
"""Disposable browser integration; no API interceptions or real external services."""
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
FILES = '/api/v2/self-reported-private-files'

def interrupt(signum, _frame):
    raise SystemExit(128 + signum)

def timed_out(_signum, _frame):
    raise TimeoutError('Browser test exceeded the 120-second deadline')

signal.signal(signal.SIGTERM, interrupt)
signal.signal(signal.SIGINT, interrupt)
signal.signal(signal.SIGALRM, timed_out)
signal.alarm(120)

def qr_decode(png):
    z = ctypes.CDLL('libzbar.so.0')
    void = ctypes.c_void_p
    def sig(name, args, result):
        fn = getattr(z, name); fn.argtypes = args; fn.restype = result; return fn
    scanner = sig('zbar_image_scanner_create', [], void)()
    image = sig('zbar_image_create', [], void)()
    try:
        pixels = Image.open(io.BytesIO(png)).convert('L')
        raw = pixels.tobytes(); buf = ctypes.create_string_buffer(raw)
        sig('zbar_image_set_format', [void, ctypes.c_ulong], None)(image, 0x30303859)
        sig('zbar_image_set_size', [void, ctypes.c_uint, ctypes.c_uint], None)(image, *pixels.size)
        sig('zbar_image_set_data', [void, void, ctypes.c_ulong, void], None)(image, buf, len(raw), None)
        assert sig('zbar_scan_image', [void, void], ctypes.c_int)(scanner, image) == 1
        symbol = sig('zbar_image_first_symbol', [void], void)(image)
        return sig('zbar_symbol_get_data', [void], ctypes.c_char_p)(symbol).decode()
    finally:
        sig('zbar_image_destroy', [void], None)(image)
        sig('zbar_image_scanner_destroy', [void], None)(scanner)

def wait_file(path, process):
    for _ in range(200):
        if path.exists(): return
        if process.poll() is not None: raise RuntimeError('Test process exited before readiness; see temporary logs')
        time.sleep(.1)
    raise RuntimeError('Timed out waiting for test process')

def stop(proc):
    if proc:
        # A dedicated process group covers Vite's esbuild worker even if its
        # parent already exited. Never signal processes from outside this run.
        try: os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        try: proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            try: os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            proc.wait()
        # A detached worker may outlive a cleanly exited group leader.
        try: os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError: pass

try:
    with (WORK / 'server.log').open('w') as server_log, (WORK / 'vite.log').open('w') as vite_log:
        server = subprocess.Popen(['node', '--experimental-strip-types', 'server/test/browser-v2-server.ts'], cwd=ROOT, stdout=server_log, stderr=subprocess.STDOUT, env=os.environ.copy(), start_new_session=True)
        wait_file(WORK / 'ports.json', server)
        ports = json.loads((WORK / 'ports.json').read_text())
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); vite_port = sock.getsockname()[1]
        base = f'http://127.0.0.1:{vite_port}'
        env = {**os.environ, 'E2E_BACKEND_PORT': str(ports['enabled'])}
        vite = subprocess.Popen([str(ROOT / 'node_modules/.bin/vite'), '--config', 'client/tests/v2-e2e/vite.config.ts', '--port', str(vite_port), '--strictPort'], cwd=ROOT, stdout=vite_log, stderr=subprocess.STDOUT, env=env, start_new_session=True)
        for _ in range(200):
            try:
                with urlopen(base + '/tests/v2-e2e/index.html', timeout=1) as response: assert response.status == 200
                break
            except OSError:
                if vite.poll() is not None: raise RuntimeError('Vite failed to start')
                time.sleep(.1)
        else: raise RuntimeError('Vite did not become ready')
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
            contexts = []
            def new_page(camera=False):
                ctx = browser.new_context(viewport={'width': 1200, 'height': 900}, service_workers='block')
                contexts.append(ctx)
                # Network isolation only: all same-origin requests, including API calls, pass through unchanged.
                ctx.route('**/*', lambda route: route.continue_() if route.request.url.startswith(base + '/') else route.abort())
                if camera:
                    ctx.add_init_script("""window.__qr = '';
                        window.BarcodeDetector = class { async detect() { return [{rawValue: window.__qr}]; } };
                        Object.defineProperty(navigator, 'mediaDevices', {value: {getUserMedia: async () => { window.__stream = document.createElement('canvas').captureStream(); return window.__stream; }}, configurable: true});
                        HTMLMediaElement.prototype.play = async function() {};
                    """)
                page = ctx.new_page()
                page.goto(base + '/tests/v2-e2e/index.html')
                return page
            def signup(page, mailbox, role, first):
                page.get_by_role('button', name='Create account').click()
                page.get_by_label('Email address').fill(mailbox + '@example.test')
                with page.expect_response(lambda r: r.url.endswith('/api/v2/auth/register/request') and r.request.method == 'POST') as pending:
                    page.get_by_role('button', name='Send verification code').click()
                assert pending.value.status == 202
                expect(page.get_by_role('heading', name='Complete your registration')).to_be_visible()
                mail = WORK / ('mail-' + mailbox)
                wait_file(mail, server)
                code = mail.read_text()
                assert re.fullmatch(r'[A-Za-z0-9_-]{43}', code)
                page.get_by_label('Verification code').fill(code)
                page.get_by_label('Subcontractor' if role == 'sub' else 'General contractor', exact=True).check()
                page.get_by_label('First name').fill(first); page.get_by_label('Last name').fill('Synthetic')
                page.get_by_label('US phone number').fill('(202) 555-0123')
                page.get_by_label('Password').fill(PASSWORD)
                if role == 'sub':
                    page.get_by_label('Company name').fill('Synthetic Electric')
                    page.get_by_label('Trade', exact=True).fill('Electrical')
                with page.expect_response(lambda r: r.url.endswith('/api/v2/auth/register/confirm') and r.request.method == 'POST') as pending:
                    page.get_by_role('button', name='Submit registration').click()
                assert pending.value.status == 200
                expect(page.get_by_role('heading', name='Try signing in')).to_be_visible()
                page.get_by_role('button', name='Go to sign in').click()
                return login(page, mailbox, role)
            def login(page, mailbox, role):
                page.get_by_label('Email address').fill(mailbox + '@example.test')
                page.get_by_label('Password').fill(PASSWORD)
                with page.expect_response(lambda r: r.url.endswith('/api/v2/auth/login') and r.request.method == 'POST') as login_response:
                    with page.expect_response(lambda r: r.url.endswith('/api/v2/auth/me')) as me_response:
                        page.get_by_role('button', name='Sign in', exact=True).click()
                assert login_response.value.status == 200 and me_response.value.status == 200
                token = login_response.value.json()['token']
                me = me_response.value.json()
                assert me['role'] == role and me['subject']
                expect(page.get_by_role('heading', name='Connections & insurance information' if role == 'sub' else 'Subcontractor connections')).to_be_visible()
                return token, me['subject']
            sub, gc, other = new_page(), new_page(), new_page(camera=True)
            sub_token, _ = signup(sub, 'sub', 'sub', 'Sub')
            gc_token, gc_id = signup(gc, 'gc', 'gc', 'Intended')
            other_token, other_id = signup(other, 'other', 'gc', 'Other')
            assert gc_id != other_id
            # Factory defaults stay off, even with a valid session; explicit unsafe options are test-only.
            for path in ['/api/v2/connections/consent', '/api/v2/self-reported-coi-metadata/own', FILES + '/consent']:
                response = sub.context.request.get(f'http://127.0.0.1:{ports["disabled"]}' + path, headers={'Authorization': 'Bearer ' + sub_token})
                assert response.status == 503 and response.json() == {'error': 'Service unavailable'}
            def make_qr(page, token):
                # Retrieve and compare the real disclosure, and assert exactly the server-issued version/profile in POST.
                api = page.context.request
                disclosure = api.get(base + '/api/v2/connections/consent', headers={'Authorization': 'Bearer ' + token}).json()
                profile = api.get(base + '/api/v2/connections/profile', headers={'Authorization': 'Bearer ' + token}).json()
                expect(page.get_by_text(disclosure['qrText'], exact=True)).to_be_visible()
                check = page.get_by_label('I have read and agree to the exact disclosure above.', exact=True)
                button = page.get_by_role('button', name='Generate one-use QR')
                assert not check.is_checked() and button.is_disabled()
                check.check()
                with page.expect_response(lambda r: r.url.endswith('/api/v2/connections/qr') and r.request.method == 'POST') as qr_response:
                    button.click()
                response = qr_response.value
                assert response.status == 200
                assert response.request.post_data_json == {'profileId': profile['profileId'], 'consentVersion': disclosure['version'], 'affirmative': True}
                expect(page.get_by_text('QR code generated')).to_be_visible()
                raw = qr_decode(page.get_by_role('img', name='One-use connection QR code').screenshot())
                assert raw == response.json()['token'] and re.fullmatch(r'[A-Za-z0-9_-]{43}', raw)
                return raw
            raw = make_qr(sub, sub_token)
            expect(gc.get_by_text('No connected subcontractors are currently available.')).to_be_visible()
            gc.get_by_label('Raw one-time code').fill(raw)
            with gc.expect_response(lambda r: r.url.endswith('/api/v2/connections/qr/redeem') and r.request.method == 'POST') as redeem:
                gc.get_by_role('button', name='Connect', exact=True).click()
            assert redeem.value.status == 204 and redeem.value.request.post_data_json == {'token': raw}
            expect(gc.get_by_role('heading', name='Synthetic Electric')).to_be_visible()  # no manual refresh
            expect(gc.get_by_text('No explicitly granted metadata is currently available', exact=False)).to_be_visible()
            # Login again in a separate sub page to issue another one-use code for the other GC.
            # Reloading loses the on-screen QR guard; it does not invalidate a server capability.
            sub2 = new_page()
            sub2_token, _ = login(sub2, 'sub', 'sub')
            assert sub2_token != sub_token
            raw2 = make_qr(sub2, sub2_token)
            other.evaluate('(value) => { window.__qr = value }', raw2)
            with other.expect_response(lambda r: r.url.endswith('/api/v2/connections/qr/redeem') and r.request.method == 'POST') as redeem2:
                other.get_by_role('button', name='Start camera').click()
            assert redeem2.value.status == 204 and redeem2.value.request.post_data_json == {'token': raw2}
            expect(other.get_by_role('heading', name='Synthetic Electric')).to_be_visible()
            assert other.evaluate('window.__stream.getTracks().every(t => t.readyState === "ended")')
            # The sub creates a record in the actual API; ID and GC identity come from responses.
            sub.get_by_label('Carrier', exact=True).fill('Synthetic Insurer')
            sub.get_by_label('Effective date').fill('2026-01-01'); sub.get_by_label('Expiration date').fill('2027-01-01')
            sub.get_by_label('Coverage type 1').fill('General liability'); sub.get_by_label('Limit in cents 1').fill('100000000')
            with sub.expect_response(lambda r: r.url.endswith('/api/v2/self-reported-coi-metadata/own') and r.request.method == 'POST') as creation:
                sub.get_by_role('button', name='Save self-reported record').click()
            assert creation.value.status == 200
            record_id = creation.value.json()['id']
            expect(sub.get_by_text('Synthetic Insurer', exact=True)).to_be_visible()
            sub.get_by_role('button', name='Refresh connected GC accounts').click()
            expect(sub.get_by_label('Connected GC account').locator('option')).to_have_count(3)
            sub.get_by_label('Record', exact=True).select_option(record_id)
            sub.get_by_label('Connected GC account').select_option(gc_id)
            expect(sub.get_by_text('Intended Synthetic', exact=False).last).to_be_visible()
            meta = sub.context.request.get(base + '/api/v2/self-reported-coi-metadata/consent', headers={'Authorization': 'Bearer ' + sub_token}).json()
            expect(sub.get_by_text(meta['text'], exact=True)).to_be_visible()
            agree = sub.get_by_label('I have read and agree to the exact disclosure above for this record and account.')
            share = sub.get_by_role('button', name='Share this record’s metadata')
            assert not agree.is_checked() and share.is_disabled()
            agree.check()
            with sub.expect_response(lambda r: r.url.endswith('/api/v2/self-reported-coi-metadata/grant') and r.request.method == 'POST') as granted:
                share.click()
            assert granted.value.status == 204
            assert granted.value.request.post_data_json == {'coiId': record_id, 'gcUserId': gc_id, 'consentVersion': meta['version'], 'affirmative': True}
            expect(sub.get_by_text('Sharing request recorded for this record and GC account. No files are shared.')).to_be_visible()
            gc.get_by_role('button', name='Refresh list').click()
            expect(gc.get_by_text('Synthetic Insurer', exact=True)).to_be_visible()
            expect(gc.get_by_text('$1,000,000.00', exact=False)).to_be_visible()
            other.get_by_role('button', name='Refresh list').click()
            expect(other.get_by_text('No explicitly granted metadata is currently available', exact=False)).to_be_visible()
            denied = other.context.request.get(base + '/api/v2/self-reported-coi-metadata/granted', headers={'Authorization': 'Bearer ' + other_token})
            assert denied.status == 200 and denied.json() == {'records': []}
            # Mount the private-file component in the test host only, after creating
            # metadata. Upload real fixture bytes via the real backend, not API mocks.
            sub.get_by_role('button', name='Open private files').click()
            expect(sub.get_by_role('heading', name='Your self-reported files')).to_be_visible()
            sub.get_by_label('Self-reported COI record').select_option(record_id)
            fixture_dir = ROOT / 'server/test/fixtures/private-inspection'
            sub.get_by_label('File', exact=True).set_input_files({'name': 'not-a-fixture.pdf', 'mimeType': 'application/pdf', 'buffer': b'%PDF-not-a-test-fixture'})
            with sub.expect_response(lambda r: r.url.endswith(FILES + '/own/' + record_id) and r.request.method == 'PUT') as rejected_upload:
                sub.get_by_role('button', name='Upload private file').click()
            assert rejected_upload.value.status == 404
            expect(sub.get_by_text('Upload outcome could not be confirmed.', exact=False)).to_be_visible()
            initial_list = sub.context.request.get(base + FILES + '/own/list', headers={'Authorization': 'Bearer ' + sub_token})
            assert initial_list.status == 200 and initial_list.json() == {'files': [], 'nextCursor': None}
            samples = [('sample.pdf', 'application/pdf'), ('sample.png', 'image/png')]
            file_ids = []
            for filename, mime in samples:
                data = (fixture_dir / filename).read_bytes()
                sub.get_by_label('File', exact=True).set_input_files({'name': filename, 'mimeType': mime, 'buffer': data})
                with sub.expect_response(lambda r: r.url.endswith(FILES + '/own/' + record_id) and r.request.method == 'PUT') as uploaded:
                    sub.get_by_role('button', name='Upload private file').click()
                assert uploaded.value.status == 201
                assert uploaded.value.request.header_value('content-type') == mime
                assert uploaded.value.request.post_data_buffer == data
                fid = uploaded.value.json()['id']
                assert re.fullmatch(r'[0-9a-f-]{36}', fid) and fid not in file_ids
                file_ids.append(fid)
                expect(sub.get_by_role('button', name='Preview file ' + fid)).to_be_visible()
                with sub.expect_response(lambda r: r.url.endswith(FILES + '/own/' + fid) and r.request.method == 'GET') as preview:
                    sub.get_by_role('button', name='Preview file ' + fid).click()
                assert preview.value.status == 200 and preview.value.header_value('content-type') == mime
                assert preview.value.body() == data
                if mime == 'application/pdf':
                    frame = sub.get_by_title('Private PDF preview')
                    expect(frame).to_be_visible()
                    assert frame.get_attribute('sandbox') == '' and frame.get_attribute('src').startswith('blob:')
                else:
                    image = sub.get_by_alt_text('Your private document preview')
                    expect(image).to_be_visible()
                    assert image.get_attribute('src').startswith('blob:')
                    expect(image).to_have_js_property('naturalWidth', 2)
                sub.get_by_role('button', name='Close preview').click()
            pdf_id, png_id = file_ids
            headers = lambda token: {'Authorization': 'Bearer ' + token}
            def download(page, token, fid):
                return page.context.request.get(base + FILES + '/granted/' + fid, headers=headers(token))
            def denied_file(response):
                assert response.status == 404 and response.json() == {'error': 'Unavailable'}
            def granted_files(page, token):
                response = page.context.request.get(base + FILES + '/granted/list', headers=headers(token))
                assert response.status == 200
                return response.json()
            assert granted_files(gc, gc_token) == {'files': [], 'nextCursor': None}
            assert granted_files(other, other_token) == {'files': [], 'nextCursor': None}
            gc.get_by_role('button', name='Open shared files').click()
            other.get_by_role('button', name='Open shared files').click()
            expect(gc.get_by_text('No separately shared files were returned.')).to_be_visible()
            expect(other.get_by_text('No separately shared files were returned.')).to_be_visible()
            for fid in file_ids:
                denied_file(download(gc, gc_token, fid))  # metadata grant is insufficient
                denied_file(download(other, other_token, fid))
            wrong_version = sub.context.request.post(base + FILES + '/grant', headers=headers(sub_token), data={'fileId': pdf_id, 'gcUserId': gc_id, 'consentVersion': meta['version'], 'affirmative': True})
            denied_file(wrong_version)
            denied_file(download(gc, gc_token, pdf_id))
            disclosure_response = sub.context.request.get(base + FILES + '/consent', headers=headers(sub_token))
            assert disclosure_response.status == 200
            disclosure = disclosure_response.json()
            assert disclosure['version'] != meta['version'] and disclosure['text']
            sub.get_by_label('Ready file').select_option(pdf_id)
            sub.get_by_role('region', name='Share or revoke a file').get_by_label('Connected GC account').select_option(gc_id)
            expect(sub.get_by_text(disclosure['text'], exact=True)).to_be_visible()
            file_agree = sub.get_by_label('I have read and agree to the exact disclosure above for this file and GC account.')
            file_share = sub.get_by_role('button', name='Share this file')
            assert not file_agree.is_checked() and file_share.is_disabled()
            file_agree.check()
            with sub.expect_response(lambda r: r.url.endswith(FILES + '/grant') and r.request.method == 'POST') as file_grant:
                file_share.click()
            assert file_grant.value.status == 204
            assert file_grant.value.request.post_data_json == {'fileId': pdf_id, 'gcUserId': gc_id, 'consentVersion': disclosure['version'], 'affirmative': True}
            expect(sub.get_by_text('Share request recorded for this file and GC account.')).to_be_visible()
            assert not file_agree.is_checked()
            listed = granted_files(gc, gc_token)
            assert listed['nextCursor'] is None and [item['id'] for item in listed['files']] == [pdf_id]
            assert granted_files(other, other_token) == {'files': [], 'nextCursor': None}
            gc.get_by_role('button', name='Refresh list').click()
            expect(gc.get_by_role('button', name='View file ' + pdf_id)).to_be_visible()
            assert gc.get_by_role('button', name='View file ' + png_id).count() == 0
            with gc.expect_response(lambda r: r.url.endswith(FILES + '/granted/' + pdf_id) and r.request.method == 'GET') as viewer_response:
                gc.get_by_role('button', name='View file ' + pdf_id).click()
            assert viewer_response.value.status == 200 and viewer_response.value.body() == (fixture_dir / 'sample.pdf').read_bytes()
            frame = gc.get_by_title('Self-reported PDF preview')
            expect(frame).to_be_visible()
            assert frame.get_attribute('sandbox') == '' and frame.get_attribute('src').startswith('blob:')
            gc.get_by_role('button', name='Back to files').click()
            other.get_by_role('button', name='Refresh list').click()
            expect(other.get_by_text('No separately shared files were returned.')).to_be_visible()
            # The separate composition has no anonymous client-report access to private files.
            for path in ['/api/client/share/synthetic-token', '/api/v2/client/share/synthetic-token']:
                assert gc.context.request.get(base + path).status == 404
            actual = download(gc, gc_token, pdf_id)
            assert actual.status == 200 and actual.headers['content-type'] == 'application/pdf'
            assert actual.body() == (fixture_dir / 'sample.pdf').read_bytes()
            assert actual.headers['cache-control'] == 'private, no-store'
            denied_file(download(other, other_token, pdf_id))
            denied_file(download(gc, gc_token, png_id))  # no implicit grant for another file
            with sub.expect_response(lambda r: r.url.endswith(FILES + '/revoke') and r.request.method == 'POST') as file_revoke:
                sub.get_by_role('button', name='Revoke access to this file').click()
            assert file_revoke.value.status == 204
            assert file_revoke.value.request.post_data_json == {'fileId': pdf_id, 'gcUserId': gc_id}
            expect(sub.get_by_text('Revocation request recorded for this file and GC account.', exact=False)).to_be_visible()
            # A previously listed file must be reauthorized on open, and a denial clears the stale list.
            with gc.expect_response(lambda r: r.url.endswith(FILES + '/granted/' + pdf_id) and r.request.method == 'GET') as revoked_view:
                gc.get_by_role('button', name='View file ' + pdf_id).click()
            assert revoked_view.value.status == 404
            expect(gc.get_by_role('dialog').get_by_role('alert')).to_contain_text('unavailable or access may have changed')
            gc.get_by_role('button', name='Back to files').click()
            expect(gc.get_by_role('alert')).to_contain_text('Files are unavailable')
            assert gc.get_by_role('button', name='View file ' + pdf_id).count() == 0
            denied_file(download(gc, gc_token, pdf_id))
            denied_file(download(other, other_token, pdf_id))
            assert granted_files(gc, gc_token) == {'files': [], 'nextCursor': None}
            owner_after = sub.context.request.get(base + FILES + '/own/' + pdf_id, headers=headers(sub_token))
            assert owner_after.status == 200 and owner_after.body() == (fixture_dir / 'sample.pdf').read_bytes()
            gc.get_by_role('button', name='Return to connections').click()
            expect(gc.get_by_role('heading', name='Subcontractor connections')).to_be_visible()
            sub.get_by_role('button', name='Return to connections').click()
            with sub.expect_response(lambda r: r.url.endswith('/api/v2/self-reported-coi-metadata/revoke') and r.request.method == 'POST') as revoked:
                sub.get_by_role('button', name='Revoke metadata access for this selection').click()
            assert revoked.value.status == 204 and revoked.value.request.post_data_json == {'coiId': record_id, 'gcUserId': gc_id}
            expect(sub.get_by_text('Revocation request recorded for this record and GC account.', exact=False)).to_be_visible()
            gc.get_by_role('button', name='Refresh list').click()
            expect(gc.get_by_text('No explicitly granted metadata is currently available', exact=False)).to_be_visible()
            assert gc.get_by_text('Synthetic Insurer', exact=True).count() == 0
            after = gc.context.request.get(base + '/api/v2/self-reported-coi-metadata/granted', headers={'Authorization': 'Bearer ' + gc_token})
            assert after.status == 200 and after.json() == {'records': []}
            for page in [sub, sub2, gc, other]:
                assert page.evaluate('localStorage.length + sessionStorage.length') == 0
            for ctx in contexts: ctx.close()
            browser.close()
    print('PASS: real synthetic HTTP + PostgreSQL 16 browser signup/login, QR, metadata, PDF/PNG owner previews, GC viewer, per-GC/per-file consent, revocation and client-report denial; defaults off')
finally:
    signal.alarm(0)
    stop(vite)
    stop(server)
