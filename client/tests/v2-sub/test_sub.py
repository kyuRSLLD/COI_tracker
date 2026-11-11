#!/usr/bin/env python3
"""Synthetic browser-only tests; all API traffic is intercepted and off-origin traffic blocked."""
import ctypes
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import time
from datetime import datetime, timedelta, timezone
from urllib.request import urlopen
from PIL import Image
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[3]
FIX = json.loads((Path(__file__).parent / 'fixtures.json').read_text())

def decode_qr(png):
    # Independently decode the rendered QR with the system zbar library.
    z = ctypes.CDLL('libzbar.so.0')
    void = ctypes.c_void_p
    def sig(name, args, result):
        fn = getattr(z, name); fn.argtypes = args; fn.restype = result; return fn
    scanner = sig('zbar_image_scanner_create', [], void)()
    image = sig('zbar_image_create', [], void)()
    try:
        pixels = Image.open(io.BytesIO(png)).convert('L')
        raw = pixels.tobytes(); buf = ctypes.create_string_buffer(raw)
        sig('zbar_image_set_format', [void, ctypes.c_ulong], None)(image, 0x30303859) # Y800
        sig('zbar_image_set_size', [void, ctypes.c_uint, ctypes.c_uint], None)(image, *pixels.size)
        sig('zbar_image_set_data', [void, void, ctypes.c_ulong, void], None)(image, buf, len(raw), None)
        count = sig('zbar_scan_image', [void, void], ctypes.c_int)(scanner, image)
        assert count == 1, f'Expected one readable QR, got {count}'
        symbol = sig('zbar_image_first_symbol', [void], void)(image)
        return sig('zbar_symbol_get_data', [void], ctypes.c_char_p)(symbol).decode()
    finally:
        sig('zbar_image_destroy', [void], None)(image)
        sig('zbar_image_scanner_destroy', [void], None)(scanner)

with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
base = f'http://127.0.0.1:{port}'
server = subprocess.Popen([str(ROOT / 'node_modules/.bin/vite'), '--host', '127.0.0.1', '--port', str(port), '--strictPort'], cwd=ROOT / 'client', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for i in range(100):
        try:
            with urlopen(base + '/tests/v2-sub/index.html', timeout=1) as response: assert response.status == 200
            break
        except OSError:
            if server.poll() is not None: raise RuntimeError('Vite failed to start')
            time.sleep(.1)
    else: raise RuntimeError('Vite did not become ready')
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        context = browser.new_context(viewport={'width': 1100, 'height': 850})
        calls = []; state = {'empty': False, 'fail_consent': False, 'fail_qr': False, 'created': []}
        def intercept(route):
            req = route.request
            if not req.url.startswith(base + '/'):
                route.abort(); return
            path = req.url[len(base):]
            if not path.startswith('/api/'):
                route.continue_(); return
            assert '?' not in path
            assert req.headers.get('authorization') == 'Bearer synthetic-access-token'
            body = req.post_data_json if req.post_data else None
            calls.append((req.method, path, body))
            conn = '/api/v2/connections'; meta = '/api/v2/self-reported-coi-metadata'
            if path == conn + '/profile': out = FIX['profile']
            elif path == conn + '/consent':
                if state['fail_consent']: route.fulfill(status=503, json={'error':'Unavailable'}); return
                out = FIX['connectionConsent']
            elif path == conn + '/qr':
                if state['fail_qr']: route.fulfill(status=503, json={'error':'Unavailable'}); return
                out = {'token': FIX['qrToken'], 'expiresAt': (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()}
            elif path == meta + '/consent': out = FIX['metadataConsent']
            elif path == meta + '/own' and req.method == 'GET': out = {'records': ([] if state['empty'] else FIX['records']) + state['created']}
            elif path == meta + '/own' and req.method == 'POST':
                assert set(body) == {'carrier','effectiveDate','expirationDate','coverage'}
                state['created'].append({'id':'33333333-3333-4333-8333-333333333333','profile_id':FIX['profile']['profileId'],'carrier':body['carrier'],'effective_date':body['effectiveDate'],'expiration_date':body['expirationDate'],'coverage':body['coverage'],'created_at':'2026-01-01T00:00:00Z','reporting_status':'self_reported_unverified'})
                out = {'id':state['created'][-1]['id']}
            elif path == meta + '/connected-gcs': out = {'generalContractors': [] if state['empty'] else FIX['gcs']}
            elif path in (meta + '/grant', meta + '/revoke'):
                route.fulfill(status=204, body=''); return
            else: raise AssertionError(f'Unexpected API {req.method} {path}')
            route.fulfill(status=200, json=out)
        context.route('**/*', intercept)
        page = context.new_page()
        page.clock.install()
        page.goto(base + '/tests/v2-sub/index.html')
        expect(page.get_by_role('heading', name='Connections & insurance information')).to_be_visible()
        expect(page.get_by_text(FIX['connectionConsent']['qrText'], exact=True)).to_be_visible()
        qr_checkbox = page.get_by_label('I have read and agree to the exact disclosure above.', exact=True)
        qr_button = page.get_by_role('button', name='Generate one-use QR')
        assert not qr_checkbox.is_checked(); assert qr_button.is_disabled()
        assert not [c for c in calls if c[1].endswith('/qr')]
        qr_checkbox.check()
        # Two clicks within the same event loop must not issue two capabilities.
        qr_button.evaluate('(b) => { b.click(); b.click(); }')
        expect(page.get_by_text('QR code generated')).to_be_visible()
        assert len([c for c in calls if c[1].endswith('/qr')]) == 1
        assert [c for c in calls if c[1].endswith('/qr')][0][2] == {'profileId':FIX['profile']['profileId'], 'consentVersion':FIX['connectionConsent']['version'], 'affirmative':True}
        qr = page.get_by_role('img', name='One-use connection QR code')
        assert decode_qr(qr.screenshot()) == FIX['qrToken']
        assert qr_button.is_disabled()
        assert page.locator('time').get_attribute('datetime')
        page.clock.fast_forward('05:01')
        expect(page.get_by_text('The QR code expired and is no longer displayed.')).to_be_visible()
        assert not qr_checkbox.is_checked(); assert qr_button.is_disabled()
        # Save one record using exact strict input fields and multiple coverage lines.
        page.get_by_label('Carrier', exact=True).fill(' New Carrier ')
        page.get_by_label('Effective date').fill('2026-02-01'); page.get_by_label('Expiration date').fill('2027-02-01')
        page.get_by_label('Coverage type 1').fill('Auto'); page.get_by_label('Limit in cents 1').fill('123456')
        page.get_by_role('button', name='Add coverage').click(); page.get_by_label('Coverage type 2').fill('Workers Comp'); page.get_by_label('Limit in cents 2').fill('500')
        page.get_by_role('button', name='Save self-reported record').click()
        expect(page.get_by_text('New Carrier', exact=True)).to_be_visible()
        created = [c[2] for c in calls if c[0] == 'POST' and c[1].endswith('/own')]
        assert created == [{'carrier':'New Carrier','effectiveDate':'2026-02-01','expirationDate':'2027-02-01','coverage':[{'type':'Auto','limitCents':123456},{'type':'Workers Comp','limitCents':500}]}]
        page.get_by_label('Record', exact=True).select_option(FIX['records'][0]['id'])
        page.get_by_label('Connected GC account').select_option(FIX['gcs'][0]['gc_user_id'])
        expect(page.get_by_text(FIX['metadataConsent']['text'], exact=True)).to_be_visible()
        share = page.get_by_role('button', name='Share this record’s metadata')
        agree = page.get_by_label('I have read and agree to the exact disclosure above for this record and account.')
        assert share.is_disabled() and not agree.is_checked()
        agree.check(); page.get_by_label('Connected GC account').select_option(FIX['gcs'][1]['gc_user_id'])
        assert not agree.is_checked() and share.is_disabled()
        agree.check(); page.get_by_role('button', name='Refresh connected GC accounts').click()
        expect(agree).not_to_be_checked()
        agree.check(); share.click()
        expect(page.get_by_text('Sharing request recorded for this record and GC account. No files are shared.')).to_be_visible()
        assert [c for c in calls if c[1].endswith('/grant')][-1][2] == {'coiId':FIX['records'][0]['id'],'gcUserId':FIX['gcs'][1]['gc_user_id'],'consentVersion':FIX['metadataConsent']['version'],'affirmative':True}
        assert not agree.is_checked()
        page.get_by_role('button', name='Revoke metadata access for this selection').click()
        expect(page.get_by_text('Revocation request recorded for this record and GC account. Previously viewed information cannot be recalled.')).to_be_visible()
        assert [c for c in calls if c[1].endswith('/revoke')][-1][2] == {'coiId':FIX['records'][0]['id'],'gcUserId':FIX['gcs'][1]['gc_user_id']}
        expect(page.get_by_text('Not available yet.', exact=True)).to_be_visible()
        assert page.get_by_role('button', name='Upload not available yet').is_disabled()
        assert page.evaluate('localStorage.length') == 0 and page.evaluate('sessionStorage.length') == 0
        # Empty, mobile, and GET failure/retry; no sensitive information from errors is shown.
        state.update(empty=True, fail_consent=True, created=[])
        mobile = context.new_page()
        mobile.set_viewport_size({'width': 375, 'height': 812})
        mobile.goto(base + '/tests/v2-sub/index.html')
        expect(mobile.get_by_text('Could not load connection disclosure. Check your session or try again.')).to_be_visible()
        expect(mobile.get_by_text('No self-reported records yet.')).to_be_visible()
        expect(mobile.get_by_text('No connected GC accounts available. A profile connection must be made first.')).to_be_visible()
        assert mobile.evaluate('document.documentElement.scrollWidth <= innerWidth')
        state['fail_consent'] = False
        mobile.get_by_role('button', name='Retry connection disclosure').click()
        expect(mobile.get_by_text(FIX['connectionConsent']['qrText'], exact=True)).to_be_visible()
        # A possibly successful but unconfirmed QR issuance is not retried automatically.
        state['fail_qr'] = True
        mobile.get_by_label('I have read and agree to the exact disclosure above.', exact=True).check()
        before = len([c for c in calls if c[1].endswith('/qr')])
        mobile.get_by_role('button', name='Generate one-use QR').click()
        expect(mobile.get_by_text('The result could not be confirmed.', exact=False)).to_be_visible()
        assert len([c for c in calls if c[1].endswith('/qr')]) == before + 1
        assert mobile.get_by_role('button', name='Generate one-use QR').is_disabled()
        mobile.get_by_label('Carrier', exact=True).fill('Synthetic Carrier')
        mobile.get_by_label('Effective date').fill('2026-01-01'); mobile.get_by_label('Expiration date').fill('2026-12-31')
        mobile.get_by_label('Coverage type 1').fill('Auto'); mobile.get_by_label('Limit in cents 1').fill('100')
        mobile.get_by_role('button', name='Add coverage').click()
        mobile.get_by_label('Coverage type 2').fill('auto'); mobile.get_by_label('Limit in cents 2').fill('200')
        before_own = len([c for c in calls if c[0] == 'POST' and c[1].endswith('/own')])
        mobile.get_by_role('button', name='Save self-reported record').click()
        expect(mobile.get_by_text('Check the carrier, real dates, unique coverage types', exact=False).first).to_be_visible()
        assert len([c for c in calls if c[0] == 'POST' and c[1].endswith('/own')]) == before_own
        assert all(c[1].startswith(('/api/v2/connections/', '/api/v2/self-reported-coi-metadata/')) for c in calls)
        browser.close()
    print('PASS: mocked v2 browser tests, raw QR decode, consent, creation, revocation, expiry, retry and mobile')
finally:
    server.terminate()
    try: server.wait(timeout=5)
    except subprocess.TimeoutExpired: server.kill(); server.wait()
