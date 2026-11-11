#!/usr/bin/env python3
"""Isolated synthetic browser tests. All API requests are intercepted; external requests are blocked."""
import json
import socket
import subprocess
import time
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[3]
M = '/api/v2/self-reported-coi-metadata'
P = '/api/v2/self-reported-private-files'
C = '/api/v2/connections'
PROFILE = '11111111-1111-4111-8111-111111111111'
RECORD = '22222222-2222-4222-8222-222222222222'
FILE = '33333333-3333-4333-8333-333333333333'
GC = 'actual-connected-gc-user'
PASSWORD = 'synthetic password 123'
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
base = f'http://127.0.0.1:{port}'
server = subprocess.Popen([str(ROOT / 'node_modules/.bin/vite'), '--host', '127.0.0.1', '--port', str(port), '--strictPort'], cwd=ROOT / 'client', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(100):
        try:
            with urlopen(base + '/tests/v2-shell/index.html', timeout=1) as r: assert r.status == 200
            break
        except OSError:
            if server.poll() is not None: raise RuntimeError('Vite failed to start')
            time.sleep(.1)
    else: raise RuntimeError('Vite did not start')
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        context = browser.new_context(viewport={'width': 1200, 'height': 900}, service_workers='block')
        calls = []
        state = {'me': 200, 'logout': 204, 'ttl': 900, 'child_error': False, 'role_override': None}
        def intercept(route):
            req = route.request
            if not req.url.startswith(base + '/'):
                route.abort(); return
            path = req.url[len(base):]
            if not path.startswith('/api/'):
                route.continue_(); return
            assert path.startswith('/api/v2/') and '?' not in path, path
            auth = req.headers.get('authorization')
            body = req.post_data_json if req.post_data and req.headers.get('content-type', '').startswith('application/json') else None
            calls.append((req.method, path, auth, body))
            assert req.headers.get('referer') is None
            if path == '/api/v2/auth/register/request':
                assert body == {'email': 'new@example.test'}
                route.fulfill(status=202, json={}); return
            if path == '/api/v2/auth/register/confirm':
                assert body['role'] == 'sub' and body['company_name'] == 'Test Company' and body['trade'] == 'Electric'
                route.fulfill(status=200, json={}); return
            if path == '/api/v2/auth/login':
                assert body['password'] == PASSWORD
                account = body['email'].split('@')[0]
                assert account in ('gc', 'sub')
                route.fulfill(status=200, json={'token': f'{account}.token.signature', 'token_type': 'Bearer', 'expires_in': state['ttl']}); return
            assert auth in ('Bearer gc.token.signature', 'Bearer sub.token.signature'), (path, auth)
            if path == '/api/v2/auth/me':
                if state['me'] != 200: route.fulfill(status=state['me'], json={'error': 'private server diagnostic'}); return
                # The server, not a token claim or signup choice, is authoritative.
                role = state['role_override'] or auth.split(' ')[1].split('.')[0]
                route.fulfill(status=200, json={'subject': role + '-subject', 'role': role}); return
            if path == '/api/v2/auth/logout':
                assert req.method == 'POST'
                route.fulfill(status=state['logout'], body=''); return
            if state['child_error'] and path == M + '/own':
                route.fulfill(status=403, json={'error': 'private server diagnostic'}); return
            if path == C + '/profile': out = {'profileId': PROFILE, 'evidenceType': 'fresh_self_asserted_email_control_v1'}
            elif path == C + '/consent': out = {'version':'qr-v1','qrText':'Synthetic QR disclosure'}
            elif path == C + '/qr':
                assert body == {'profileId': PROFILE, 'consentVersion': 'qr-v1', 'affirmative': True}
                out = {'token': 'A' * 43, 'expiresAt': '2099-01-01T00:00:00Z'}
            elif path == C + '/subcontractors': out = {'subcontractors':[{'id':'relation-id','profile_id':PROFILE,'company_name':'Synthetic Sub','trade':'Electric','evidence_type':'fresh_self_asserted_email_control_v1'}]}
            elif path == M + '/granted': out = {'records':[{'id':RECORD,'profile_id':PROFILE,'carrier':'Synthetic Carrier','effective_date':'2026-01-01','expiration_date':'2027-01-01','created_at':'2026-01-01T00:00:00Z','reporting_status':'self_reported_unverified','coverage':[]}]}
            elif path == M + '/own': out = {'records':[{'id':RECORD,'profile_id':PROFILE,'carrier':'Synthetic Carrier','effective_date':'2026-01-01','expiration_date':'2027-01-01','created_at':'2026-01-01T00:00:00Z','reporting_status':'self_reported_unverified','coverage':[]}]}
            elif path == M + '/connected-gcs': out = {'generalContractors':[{'gc_user_id':GC,'gc_name':'Synthetic GC'}]}
            elif path == M + '/consent': out = {'version':'meta-v1','text':'Synthetic metadata disclosure'}
            elif path == P + '/consent': out = {'version':'files-v1','text':'Synthetic file disclosure'}
            elif path == P + '/own/list': out = {'files':[{'id':FILE,'coiId':RECORD,'mime':'image/png','sizeBytes':1,'createdAt':'2026-01-01T00:00:00Z','reportingStatus':'self_reported_unverified'}], 'nextCursor':None}
            elif path == P + '/grant':
                assert body == {'fileId':FILE,'gcUserId':GC,'consentVersion':'files-v1','affirmative':True}
                route.fulfill(status=204, body=''); return
            else: raise AssertionError(f'Unexpected API: {req.method} {path}')
            route.fulfill(status=200, json=out)
        context.route('**/*', intercept)
        context.add_init_script("""window.__cameraCalls=0; window.BarcodeDetector = class {}; Object.defineProperty(navigator, 'mediaDevices', {value:{getUserMedia:async()=>{window.__cameraCalls++; throw new DOMException('denied','NotAllowedError')}}, configurable:true});""")
        page = context.new_page()
        page.goto(base + '/tests/v2-shell/index.html')
        def login(role):
            page.get_by_label('Email address').fill(role + '@example.test')
            page.get_by_label('Password').fill(PASSWORD)
            page.get_by_role('button', name='Sign in', exact=True).click()
        def signout(): page.get_by_role('button', name='Sign out', exact=True).click()
        def storage_empty():
            assert page.evaluate("""async () => ({local: Object.keys(localStorage), session: Object.keys(sessionStorage), cookies: document.cookie, db: (await indexedDB.databases()).map(x=>x.name), caches: await caches.keys()})""") == {'local': [], 'session': [], 'cookies': '', 'db': [], 'caches': []}
            assert context.cookies() == []
        def fit(): assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        for width in (320, 375, 768, 1440):
            page.set_viewport_size({'width':width,'height':850}); fit()
        # Registration is real UI and explicit email-code flow; it does not authenticate.
        page.get_by_role('button', name='Create account').click()
        page.get_by_label('Email address').fill('new@example.test')
        page.get_by_role('button', name='Send verification code').click()
        expect(page.get_by_role('heading', name='Complete your registration')).to_be_visible()
        page.get_by_label('Verification code').fill('A' * 43)
        page.get_by_label('Subcontractor', exact=True).check()
        page.get_by_label('First name').fill('Synthetic'); page.get_by_label('Last name').fill('User')
        page.get_by_label('US phone number').fill('(202) 555-0123')
        page.get_by_label('Company name').fill('Test Company'); page.get_by_label('Trade', exact=True).fill('Electric')
        page.get_by_label('Password').fill(PASSWORD)
        page.get_by_role('button', name='Submit registration').click()
        expect(page.get_by_role('heading', name='Try signing in')).to_be_visible()
        assert not any(c[1] == '/api/v2/auth/me' for c in calls)
        page.get_by_role('button', name='Go to sign in').click()
        login('sub')
        expect(page.get_by_role('heading', name='Connections & insurance information')).to_be_visible()
        expect(page.get_by_text(PROFILE, exact=False).first).to_be_visible()
        expect(page.get_by_text('Synthetic Carrier', exact=True).first).to_be_visible()
        assert page.get_by_text('Upload not available yet').count() == 0
        page.get_by_label('I have read and agree to the exact disclosure above.', exact=False).first.check()
        page.get_by_role('button', name='Generate one-use QR').click()
        expect(page.get_by_text('QR code generated')).to_be_visible()
        page.get_by_role('button', name='Private files').click()
        expect(page.get_by_role('heading', name='Your self-reported files')).to_be_visible()
        expect(page.get_by_text(FILE, exact=False).first).to_be_visible()
        page.get_by_label('Ready file').select_option(FILE)
        page.get_by_label('Connected GC account').select_option(GC)
        page.get_by_label('I have read and agree to the exact disclosure above for this file and GC account.').check()
        page.get_by_role('button', name='Share this file').click()
        expect(page.get_by_text('Share request recorded for this file and GC account.')).to_be_visible()
        for width in (320, 375, 768, 1440):
            page.set_viewport_size({'width':width,'height':850}); fit()
        storage_empty(); signout()
        expect(page.get_by_text('Signed out.', exact=True)).to_be_visible()
        assert ('POST', '/api/v2/auth/logout', 'Bearer sub.token.signature', None) in calls
        login('gc')
        expect(page.get_by_role('heading', name='Subcontractor connections')).to_be_visible()
        expect(page.get_by_text('Synthetic Sub', exact=True)).to_be_visible()
        expect(page.get_by_text('Synthetic Carrier', exact=True)).to_be_visible()
        for width in (320, 375, 768, 1440):
            page.set_viewport_size({'width':width,'height':850}); fit()
        assert page.get_by_role('button', name='Private files').count() == 0
        assert page.evaluate('window.__cameraCalls') == 0
        page.get_by_role('button', name='Start camera').click()
        expect(page.get_by_text('Camera permission was denied.', exact=False)).to_be_visible()
        assert page.evaluate('window.__cameraCalls') == 1
        storage_empty()
        # A revoked session is detected on focus and discarded; logout 401 also discards.
        state['me'] = 401
        page.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(page.get_by_text('Your session expired or was revoked. Please sign in again.')).to_be_visible()
        expect(page.get_by_role('heading', name='Sign in to your account')).to_be_visible()
        state['me'] = 200; state['logout'] = 401
        login('gc'); expect(page.get_by_role('heading', name='Subcontractor connections')).to_be_visible(); signout()
        expect(page.get_by_text('Session was already expired or revoked; signed out locally.')).to_be_visible()
        # Failed logout must not claim server revocation; sensitive data is gone immediately.
        state['logout'] = 503
        login('sub'); expect(page.get_by_role('heading', name='Connections & insurance information')).to_be_visible(); signout()
        expect(page.get_by_text('Signed out locally, but server-side logout could not be confirmed.', exact=False)).to_be_visible()
        assert page.get_by_text(PROFILE, exact=False).count() == 0
        # A failed server identity check is fail-closed, and retry can recover.
        state['me'] = 503
        login('sub'); expect(page.get_by_text('Session verification is unavailable.', exact=False)).to_be_visible()
        assert page.get_by_role('heading', name='Connections & insurance information').count() == 0
        assert page.get_by_text('private server diagnostic').count() == 0
        state['me'] = 200; state['child_error'] = True
        page.get_by_role('button', name='Retry session check').click()
        expect(page.get_by_text('Could not load records.', exact=False)).to_be_visible()
        assert page.get_by_text('private server diagnostic').count() == 0
        state['child_error'] = False; state['logout'] = 204
        signout(); expect(page.get_by_text('Signed out.', exact=True)).to_be_visible()
        # An unsupported server role never renders either workspace.
        state['role_override'] = 'admin'
        login('sub'); expect(page.get_by_text('This workspace does not support administrator accounts.', exact=False)).to_be_visible()
        assert page.get_by_role('heading', name='Connections & insurance information').count() == 0
        signout(); expect(page.get_by_text('Signed out.', exact=True)).to_be_visible()
        state['role_override'] = None
        # A reload intentionally drops the in-memory token rather than restoring a session.
        login('gc'); expect(page.get_by_role('heading', name='Subcontractor connections')).to_be_visible()
        page.reload(); expect(page.get_by_role('heading', name='Sign in to your account')).to_be_visible()
        # Expiry from login TTL removes token/data even without another request.
        state['ttl'] = 1
        login('sub'); expect(page.get_by_role('heading', name='Connections & insurance information')).to_be_visible()
        expect(page.get_by_text('Your session expired or was revoked. Please sign in again.')).to_be_visible(timeout=5000)
        storage_empty()
        assert all(c[1].startswith('/api/v2/') for c in calls)
        print('PASS: isolated signup, sub/GC navigation, actual IDs and consent, camera denial, storage, account switch, expiry/revocation, logout and failures, widths 320–1440')
        browser.close()
finally:
    server.terminate()
    try: server.wait(timeout=5)
    except subprocess.TimeoutExpired: server.kill(); server.wait()
