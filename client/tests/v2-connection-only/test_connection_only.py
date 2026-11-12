#!/usr/bin/env python3
"""Loopback-only synthetic browser tests; no real credentials or services are used."""
import socket
import subprocess
import time
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[3]
C = '/api/v2/connections'
M = '/api/v2/self-reported-coi-metadata'
F = '/api/v2/self-reported-private-files'
PROFILE = '11111111-1111-4111-8111-111111111111'
QR = 'A' * 43
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
base = f'http://127.0.0.1:{port}'
server = subprocess.Popen([str(ROOT / 'node_modules/.bin/vite'), '--host', '127.0.0.1', '--port', str(port), '--strictPort'], cwd=ROOT / 'client', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(100):
        try:
            with urlopen(base + '/tests/v2-connection-only/index.html', timeout=1) as r:
                assert r.status == 200
            break
        except OSError:
            if server.poll() is not None:
                raise RuntimeError('Vite exited')
            time.sleep(.1)
    else:
        raise RuntimeError('Vite did not start')
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        context = browser.new_context(viewport={'width': 390, 'height': 844}, service_workers='block')
        calls = []
        state = {'me': 200, 'gcs': [{'gc_user_id': 'gc-one', 'gc_name': 'Same'}, {'gc_user_id': 'gc-two', 'gc_name': 'Same'}], 'list': 'ok', 'revoke': 'ok'}
        def intercept(route):
            req = route.request
            if not req.url.startswith(base + '/'):
                route.abort()
                return
            path = req.url[len(base):]
            if not path.startswith('/api/'):
                route.continue_()
                return
            assert '?' not in path and req.headers.get('referer') is None and req.headers.get('cookie') is None
            body = req.post_data_json if req.post_data else None
            auth = req.headers.get('authorization')
            calls.append((req.method, path, body, auth))
            if path == '/api/v2/auth/login':
                role = body['email'].split('@')[0]
                assert role in ('sub', 'gc') and body['password'] == 'synthetic password 123'
                out = {'token': role + '.token.signature', 'token_type': 'Bearer', 'expires_in': 900}
            elif path == '/api/v2/auth/me':
                if state['me'] != 200:
                    route.fulfill(status=state['me'], json={}); return
                role = auth.split(' ')[1].split('.')[0]
                out = {'subject': 'synthetic-subject', 'role': role}
            elif path == '/api/v2/auth/logout':
                assert req.method == 'POST'
                route.fulfill(status=204, body=''); return
            elif path == C + '/profile': out = {'profileId': PROFILE, 'evidenceType': 'fresh_self_asserted_email_control_v1'}
            elif path == C + '/general-contractors':
                assert req.method == 'GET'
                if state['list'] == 'fail': route.fulfill(status=503, json={'error': 'Unavailable'}); return
                if state['list'] == 'invalid': route.fulfill(status=200, json={'generalContractors': [{'gc_user_id': 'gc-one', 'gc_name': 'Same', 'email': 'poison'}]}); return
                out = {'generalContractors': list(state['gcs'])}
            elif path == C + '/revoke':
                assert body['profileId'] == PROFILE and body['gcUserId'] in ('gc-one', 'gc-two') and sorted(body) == ['gcUserId', 'profileId']
                state['gcs'] = [x for x in state['gcs'] if x['gc_user_id'] != body['gcUserId']]
                if state['revoke'] == 'ambiguous': route.fulfill(status=503, json={'error': 'Unavailable'}); return
                route.fulfill(status=204, body=''); return
            elif path == C + '/consent': out = {'version': 'qr-v1', 'qrText': 'Synthetic connection disclosure'}
            elif path == C + '/qr':
                assert body == {'profileId': PROFILE, 'consentVersion': 'qr-v1', 'affirmative': True}
                out = {'token': QR, 'expiresAt': '2099-01-01T00:00:00Z'}
            elif path == C + '/qr/redeem':
                assert body == {'token': QR}
                route.fulfill(status=204, body=''); return
            elif path == C + '/subcontractors': out = {'subcontractors': [{'id': 'r', 'profile_id': PROFILE, 'company_name': 'Synthetic Sub', 'trade': 'Electric', 'evidence_type': 'fresh_self_asserted_email_control_v1'}]}
            elif path == M + '/granted': out = {'records': [{'id': 'record', 'profile_id': PROFILE, 'carrier': 'Synthetic Carrier', 'effective_date': '2026-01-01', 'expiration_date': '2027-01-01', 'created_at': '2026-01-01T00:00:00Z', 'reporting_status': 'self_reported_unverified', 'coverage': []}]}
            elif path == M + '/own': out = {'records': []}
            elif path == M + '/connected-gcs': out = {'generalContractors': []}
            elif path == M + '/consent': out = {'version': 'meta-v1', 'text': 'Synthetic metadata disclosure'}
            elif path == F + '/own/list' or path == F + '/granted/list': out = {'files': [], 'nextCursor': None}
            elif path == F + '/consent': out = {'version': 'files-v1', 'text': 'Synthetic file disclosure'}
            else: raise AssertionError(f'Unexpected API: {req.method} {path}')
            route.fulfill(status=200, json=out)
        context.route('**/*', intercept)
        context.add_init_script("""
          window.__cameraCalls = 0;
          window.BarcodeDetector = class { async detect() { return [{rawValue: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'}]; } };
          Object.defineProperty(navigator, 'mediaDevices', {value: {getUserMedia: async () => {
            window.__cameraCalls++; window.__stream = document.createElement('canvas').captureStream(); return window.__stream;
          }}, configurable: true});
          HTMLMediaElement.prototype.play = async function() {};
        """)
        page = context.new_page()
        def login(role):
            page.get_by_label('Email address').fill(role + '@example.test')
            page.get_by_label('Password').fill('synthetic password 123')
            page.get_by_role('button', name='Sign in', exact=True).click()
        def no_restricted(since=0):
            assert not [c for c in calls[since:] if c[1].startswith((M, F))], calls[since:]
        def no_sensitive_storage():
            assert page.evaluate("async () => ({local: Object.keys(localStorage), session: Object.keys(sessionStorage), cookie: document.cookie, db: (await indexedDB.databases()).map(x=>x.name), caches: await caches.keys()})") == {'local': [], 'session': [], 'cookie': '', 'db': [], 'caches': []}
            assert context.cookies() == []
        def no_file_or_metadata_ui():
            assert page.get_by_role('button', name='Private files').count() == 0
            assert page.get_by_role('button', name='Shared files').count() == 0
            assert page.get_by_role('heading', name='Self-reported COI metadata').count() == 0
            assert page.get_by_role('heading', name='Separately granted COI metadata').count() == 0
            assert page.get_by_role('heading', name='File upload').count() == 0
            assert page.get_by_text('does not verify insurance', exact=False).count() >= 1
        page.goto(base + '/tests/v2-connection-only/index.html')
        login('sub')
        expect(page.get_by_role('heading', name='Profile connections')).to_be_visible()
        expect(page.get_by_text('Synthetic connection disclosure')).to_be_visible()
        no_file_or_metadata_ui(); no_restricted()
        agree = page.get_by_label('I have read and agree to the exact disclosure above.', exact=True)
        generate = page.get_by_role('button', name='Generate one-use QR')
        assert not agree.is_checked() and generate.is_disabled()
        assert not any(c[1] == C + '/qr' for c in calls)
        agree.check(); generate.click()
        expect(page.get_by_role('img', name='One-use connection QR code')).to_be_visible()
        no_restricted(); no_sensitive_storage()
        expect(page.get_by_role('heading', name='Connected GC accounts')).to_be_visible()
        select = page.get_by_label('Connected GC account', exact=True)
        expect(select.locator('option')).to_have_count(3)
        select.select_option('gc-one')
        page.get_by_role('button', name='Disconnect selected GC').click()
        expect(page.get_by_text('Disconnect Same (ID: gc-one)?', exact=False)).to_be_visible()
        page.get_by_role('button', name='Cancel', exact=True).click()
        assert not any(c[1] == C + '/revoke' for c in calls)
        page.get_by_role('button', name='Disconnect selected GC').click()
        page.get_by_role('button', name='Confirm disconnect').click()
        expect(page.get_by_text('Disconnect request recorded.', exact=False)).to_be_visible()
        expect(select.locator('option')).to_have_count(2)
        assert page.get_by_role('img', name='One-use connection QR code').count() == 0
        expect(page.get_by_text('A disconnect was attempted.', exact=False)).to_be_visible()
        state['revoke'] = 'ambiguous'
        select.select_option('gc-two')
        page.get_by_role('button', name='Disconnect selected GC').click()
        page.get_by_role('button', name='Confirm disconnect').click()
        expect(page.get_by_text('The disconnect outcome could not be confirmed.', exact=False)).to_be_visible()
        expect(page.get_by_text('No GC accounts currently have profile access.')).to_be_visible()
        state['list'] = 'fail'
        page.get_by_role('button', name='Refresh connected GC accounts').click()
        expect(page.get_by_text('Could not load connected GC accounts.', exact=False)).to_be_visible()
        state['list'] = 'invalid'
        page.get_by_role('button', name='Retry connected GC accounts').click()
        expect(page.get_by_text('Could not load connected GC accounts.', exact=False)).to_be_visible()
        state['list'] = 'ok'
        page.get_by_role('button', name='Retry connected GC accounts').click()
        expect(page.get_by_text('No GC accounts currently have profile access.')).to_be_visible()
        # Simulate an indefinitely hanging transport that ignores abort; the UI must recover without claiming success.
        state['gcs'] = [{'gc_user_id': 'gc-one', 'gc_name': 'Same'}]
        page.get_by_role('button', name='Refresh connected GC accounts').click()
        expect(select.locator('option')).to_have_count(2)
        page.evaluate("""() => {
          window.__savedFetch = window.fetch; window.__savedTimeout = window.setTimeout;
          window.fetch = (url, init) => String(url).endsWith('/connections/revoke') ? new Promise(() => {}) : window.__savedFetch(url, init);
          window.setTimeout = (fn, ms, ...rest) => window.__savedTimeout(fn, ms === 10000 ? 50 : ms, ...rest);
        }""")
        select.select_option('gc-one'); page.get_by_role('button', name='Disconnect selected GC').click(); page.get_by_role('button', name='Confirm disconnect').click()
        expect(page.get_by_text('The disconnect outcome could not be confirmed.', exact=False)).to_be_visible()
        expect(select.locator('option')).to_have_count(2)
        page.evaluate("() => { window.fetch = window.__savedFetch; window.setTimeout = window.__savedTimeout; }")
        no_restricted(); no_sensitive_storage()
        assert QR not in page.url
        # Restore ordinary mode, navigate to files, then opt back in from that view.
        page.get_by_role('button', name='Toggle test mode').click()
        expect(page.get_by_role('heading', name='Self-reported COI metadata')).to_be_visible()
        page.get_by_role('button', name='Private files').click()
        expect(page.get_by_role('heading', name='Your self-reported files')).to_be_visible()
        before = len(calls)
        page.get_by_role('button', name='Toggle test mode').click()
        expect(page.get_by_role('heading', name='Profile connections')).to_be_visible()
        no_file_or_metadata_ui(); no_restricted(before)
        assert page.get_by_role('img', name='One-use connection QR code').count() == 0
        page.get_by_role('button', name='Sign out').click()
        expect(page.get_by_text('Signed out.', exact=True)).to_be_visible()
        login('gc')
        expect(page.get_by_role('heading', name='Synthetic Sub')).to_be_visible()
        no_file_or_metadata_ui()
        before = len(calls)
        page.get_by_role('button', name='Refresh list').click()
        expect(page.get_by_role('heading', name='Synthetic Sub')).to_be_visible()
        assert page.evaluate('window.__cameraCalls') == 0
        page.get_by_role('button', name='Start camera').click()
        expect(page.get_by_text('Connected. Refreshing your subcontractors.', exact=True)).to_be_visible()
        assert page.evaluate("window.__stream.getTracks().every(t => t.readyState === 'ended')")
        assert any(c[1] == C + '/qr/redeem' for c in calls[before:])
        no_restricted(before); no_sensitive_storage()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        # Session checks still fail closed in this mode and retry restores it.
        state['me'] = 503
        page.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(page.get_by_text('Session verification is unavailable.', exact=False)).to_be_visible()
        assert page.get_by_role('heading', name='Subcontractor connections').count() == 0
        state['me'] = 200
        page.get_by_role('button', name='Retry session check').click()
        expect(page.get_by_role('heading', name='Subcontractor connections')).to_be_visible()
        page.get_by_role('button', name='Sign out').click()
        expect(page.get_by_text('Signed out.', exact=True)).to_be_visible()
        # Directly mounted components enforce the same restriction, including the standalone file placeholder.
        before = len(calls)
        page.goto(base + '/tests/v2-connection-only/index.html?component=sub')
        expect(page.get_by_text('Synthetic connection disclosure')).to_be_visible()
        no_file_or_metadata_ui(); no_restricted(before)
        page.get_by_role('button', name='Toggle test mode').click()
        expect(page.get_by_role('heading', name='Self-reported COI metadata')).to_be_visible()
        expect(page.get_by_role('heading', name='File upload')).to_be_visible()
        before = len(calls)
        page.get_by_role('button', name='Toggle test mode').click()
        expect(page.get_by_role('heading', name='Profile connections')).to_be_visible()
        no_file_or_metadata_ui(); no_restricted(before)
        before = len(calls)
        page.goto(base + '/tests/v2-connection-only/index.html?component=gc')
        expect(page.get_by_role('heading', name='Synthetic Sub')).to_be_visible()
        no_file_or_metadata_ui(); no_restricted(before)
        page.get_by_label('Raw one-time code').fill(QR)
        page.get_by_role('button', name='Connect', exact=True).click()
        expect(page.get_by_text('Connected. Refreshing your subcontractors.', exact=True)).to_be_visible()
        no_restricted(before)
        page.get_by_role('button', name='Toggle test mode').click()
        expect(page.get_by_text('Synthetic Carrier')).to_be_visible()
        before = len(calls)
        page.get_by_role('button', name='Toggle test mode').click()
        expect(page.get_by_role('heading', name='Synthetic Sub')).to_be_visible()
        assert page.get_by_text('Synthetic Carrier').count() == 0
        no_restricted(before); no_sensitive_storage()
        # A late old-mode response must not expose metadata after the mode changes.
        page.evaluate("""() => {
          const original = window.fetch;
          window.__metaWaiting = false;
          window.__gate = new Promise(resolve => { window.__release = resolve; });
          window.fetch = async (url, init) => {
            const response = await original(url, init);
            if (String(url).endsWith('/self-reported-coi-metadata/granted')) {
              window.__metaWaiting = true; await window.__gate;
            }
            return response;
          };
        }""")
        page.get_by_role('button', name='Toggle test mode').click()
        page.wait_for_function('window.__metaWaiting')
        before = len(calls)
        page.get_by_role('button', name='Toggle test mode').click()
        expect(page.get_by_role('heading', name='Synthetic Sub')).to_be_visible()
        page.evaluate('window.__release()')
        page.wait_for_timeout(200)
        assert page.get_by_text('Synthetic Carrier').count() == 0
        no_restricted(before)
        # An active camera is stopped if the host changes mode.
        page.evaluate("() => { window.BarcodeDetector = class { async detect() { return []; } }; }")
        page.get_by_role('button', name='Start camera').click()
        page.wait_for_function('window.__stream && window.__stream.getTracks().some(t => t.readyState === "live")')
        page.get_by_role('button', name='Toggle test mode').click()
        page.wait_for_function('window.__stream.getTracks().every(t => t.readyState === "ended")')
        browser.close()
    print('PASS: connection-only shell and standalone modes, requests, consent/QR, camera/manual redeem, transitions, session, storage and mobile')
finally:
    server.terminate()
    try: server.wait(timeout=5)
    except subprocess.TimeoutExpired: server.kill(); server.wait()
