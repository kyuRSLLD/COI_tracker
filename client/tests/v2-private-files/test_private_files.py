#!/usr/bin/env python3
"""Synthetic-only browser tests. No production service, credentials or data."""
import base64
import json
import socket
import subprocess
import time
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[3]
with socket.socket() as s:
    s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]
base = f'http://127.0.0.1:{port}'
server = subprocess.Popen([str(ROOT / 'node_modules/.bin/vite'), '--host', '127.0.0.1', '--port', str(port), '--strictPort'], cwd=ROOT / 'client', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
P = '/api/v2/self-reported-private-files'
M = '/api/v2/self-reported-coi-metadata'
RECORD = '11111111-1111-4111-8111-111111111111'
F1 = '22222222-2222-4222-8222-222222222222'
F2 = '33333333-3333-4333-8333-333333333333'
F3 = '44444444-4444-4444-8444-444444444444'
FNEW = '55555555-5555-4555-8555-555555555555'
GC1, GC2 = 'synthetic-gc-one', 'synthetic-gc-two'
TEXT = 'I consent to share this specific private file with the identified connected general contractor account until revoked. This does not share other files, future replacements, or provide client access. This document is self-reported and not verified. Profile and metadata consent alone do not share files.'
VERSION = 'share-one-private-coi-file-v1'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a1sAAAAASUVORK5CYII=')
def item(fid, mime='image/png', size=len(PNG)):
    return {'id': fid, 'coiId': RECORD, 'mime': mime, 'sizeBytes': size, 'createdAt': '2026-01-01T00:00:00.000Z', 'reportingStatus': 'self_reported_unverified'}
try:
    for _ in range(100):
        try:
            with urlopen(base + '/tests/v2-private-files/index.html', timeout=1) as response: assert response.status == 200
            break
        except OSError:
            if server.poll() is not None: raise RuntimeError('Vite failed to start')
            time.sleep(.1)
    else: raise RuntimeError('Vite did not start')
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        context = browser.new_context(viewport={'width': 1100, 'height': 900})
        calls = []
        state = {'consent_error': False, 'list_error': False, 'preview_bad': False, 'uploaded': False, 'grant_error': False}
        def intercept(route):
            req = route.request
            if not req.url.startswith(base + '/'):
                route.abort(); return
            path = req.url[len(base):]
            if not path.startswith('/api/'):
                route.continue_(); return
            assert '?' not in path
            auth = req.headers.get('authorization')
            assert auth in ('Bearer synthetic-a', 'Bearer synthetic-b')
            assert req.headers.get('referer') is None
            body = req.post_data_buffer
            calls.append((req.method, path, auth, body, req.headers.get('content-type')))
            if path == M + '/own':
                out = {'records': [{'id': RECORD, 'carrier': 'Synthetic Carrier', 'effective_date': '2026-01-01', 'expiration_date': '2027-01-01'}]}
            elif path == M + '/connected-gcs': out = {'generalContractors': [{'gc_user_id': GC1, 'gc_name': 'Synthetic GC 1'}, {'gc_user_id': GC2, 'gc_name': 'Synthetic GC 2'}]}
            elif path == P + '/consent':
                if state['consent_error']: route.fulfill(status=503, json={'error': 'secret-server-detail'}); return
                out = {'version': VERSION, 'text': TEXT}
            elif path == P + '/own/list':
                if state['list_error']: route.fulfill(status=503, json={'error': 'secret-server-detail'}); return
                if auth.endswith('synthetic-b'): out = {'files': [item(F3)], 'nextCursor': None}
                elif req.method == 'POST':
                    assert json.loads(body) == {'after': F1}
                    out = {'files': [item(F2, 'application/pdf', 5)], 'nextCursor': None}
                else: out = {'files': [item(F1)] + ([item(FNEW, 'application/pdf', 5)] if state['uploaded'] else []), 'nextCursor': F1}
            elif path == P + '/own/' + RECORD and req.method == 'PUT':
                assert req.headers['content-type'] in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
                assert body == b'hello'
                state['uploaded'] = True
                route.fulfill(status=201, json={'id': FNEW}); return
            elif path.startswith(P + '/own/') and req.method == 'GET':
                fid = path.rsplit('/', 1)[1]
                assert fid in (F1, F2, F3, FNEW)
                route.fulfill(status=200, body=PNG if fid in (F1, F3) else b'hello', headers={'content-type': 'text/html' if state['preview_bad'] else ('image/png' if fid in (F1, F3) else 'application/pdf')}); return
            elif path in (P + '/grant', P + '/revoke'):
                if state['grant_error']: route.fulfill(status=404, json={'error':'private-detail'}); return
                route.fulfill(status=204, body=''); return
            else: raise AssertionError(f'Unexpected API: {req.method} {path}')
            route.fulfill(status=200, json=out)
        context.route('**/*', intercept)
        context.add_init_script("""(() => {
          window.__created=[]; window.__revoked=[]; window.__aborts=0;
          const create=URL.createObjectURL.bind(URL), revoke=URL.revokeObjectURL.bind(URL);
          URL.createObjectURL=(b)=>{const u=create(b); window.__created.push(u); return u};
          URL.revokeObjectURL=(u)=>{window.__revoked.push(u); return revoke(u)};
          const native=window.fetch.bind(window);
          window.fetch=(url,init)=>{
            if(window.__holdPreview && String(url).endsWith('/own/22222222-2222-4222-8222-222222222222')) {
              window.__holdPreview=false; init.signal.addEventListener('abort',()=>window.__aborts++);
              return new Promise(resolve=>window.__resolvePreview=()=>{
                const raw=atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a1sAAAAASUVORK5CYII=');
                resolve(new Response(Uint8Array.from(raw,c=>c.charCodeAt(0)),{headers:{'content-type':'image/png'}}));
              });
            }
            if(window.__hold && init?.method==='PUT') {
              const mode=window.__hold; window.__hold=false;
              return new Promise((resolve,reject)=>{
                init.signal.addEventListener('abort',()=>{window.__aborts++; if(mode==='cooperative') reject(new DOMException('Aborted','AbortError'))});
                window.__resolveHeld=()=>resolve(new Response(JSON.stringify({id:'55555555-5555-4555-8555-555555555555'}),{status:201,headers:{'content-type':'application/json'}}));
              });
            }
            return native(url,init);
          };
        })()""")
        page = context.new_page()
        page.goto(base + '/tests/v2-private-files/index.html')
        expect(page.get_by_role('heading', name='Your self-reported files')).to_be_visible()
        expect(page.get_by_text(F1, exact=False).first).to_be_visible()
        expect(page.get_by_text('No ready files yet.')).to_have_count(0)
        assert page.get_by_text(F2, exact=False).count() == 0
        page.get_by_role('button', name='Load more files').click()
        expect(page.get_by_text(F2, exact=False).first).to_be_visible()
        assert any(c[0] == 'POST' and c[1] == P + '/own/list' for c in calls)
        # Preview only the owner's endpoint; each blob URL is revoked on close, replacement, refresh and unmount.
        page.get_by_role('button', name=f'Preview file {F1}').click()
        expect(page.get_by_alt_text('Your private document preview')).to_be_visible()
        assert page.locator('img[alt="Your private document preview"]').get_attribute('src').startswith('blob:')
        page.get_by_role('button', name='Close preview').click()
        assert page.evaluate('window.__created.length === 1 && window.__revoked.length === 1')
        page.get_by_role('button', name=f'Preview file {F2}').click()
        expect(page.get_by_title('Private PDF preview')).to_be_visible()
        assert page.get_by_title('Private PDF preview').get_attribute('sandbox') == ''
        page.get_by_role('button', name=f'Preview file {F1}').click()
        expect(page.get_by_alt_text('Your private document preview')).to_be_visible()
        assert page.evaluate('window.__created.length === 3 && window.__revoked.length === 2')
        page.get_by_role('button', name='Refresh', exact=True).click()
        expect(page.get_by_role('button', name=f'Preview file {F1}')).to_be_visible()
        assert page.evaluate('window.__created.length === 3 && window.__revoked.length === 3')
        state['preview_bad'] = True
        page.get_by_role('button', name=f'Preview file {F1}').click()
        expect(page.get_by_text('Preview is unavailable. Refresh the file list and try again.')).to_be_visible()
        assert page.evaluate('window.__created.length === 3')
        state['preview_bad'] = False
        page.evaluate('window.__holdPreview=true')
        page.get_by_role('button', name=f'Preview file {F1}').click()
        expect(page.get_by_text('Loading preview…')).to_be_visible()
        page.get_by_role('button', name='Close preview').click()
        page.evaluate('window.__resolvePreview()')
        page.wait_for_timeout(100)
        assert page.evaluate('window.__created.length === 3 && window.__aborts === 1')
        assert page.get_by_alt_text('Your private document preview').count() == 0
        # Validation rejects unsupported, zero-byte and over-limit files before any API request.
        page.get_by_label('Self-reported COI record').select_option(RECORD)
        picker = page.get_by_label('File', exact=True)
        before = len([c for c in calls if c[0] == 'PUT'])
        for name, mime, data in [('bad.txt','text/plain',b'hello'), ('empty.pdf','application/pdf',b''), ('big.pdf','application/pdf',b'x'*1025)]:
            picker.set_input_files({'name':name, 'mimeType':mime, 'buffer':data})
            page.get_by_role('button', name='Upload private file').click()
            expect(page.get_by_role('alert').filter(has_text='Choose a nonempty')).to_be_visible()
        assert len([c for c in calls if c[0] == 'PUT']) == before
        for name, mime in [('a.pdf','application/pdf'),('a.jpg','image/jpeg'),('a.png','image/png'),('a.webp','image/webp')]:
            picker.set_input_files({'name':name, 'mimeType':mime, 'buffer':b'hello'})
            page.get_by_role('button', name='Upload private file').click()
            expect(page.get_by_text('Upload recorded.', exact=False)).to_be_visible()
        ups = [c for c in calls if c[0] == 'PUT']
        assert [c[4] for c in ups] == ['application/pdf','image/jpeg','image/png','image/webp'] and all(c[3] == b'hello' for c in ups)
        # Affirmation follows the exact server disclosure and is scoped to both selections.
        page.get_by_label('Ready file').select_option(F1)
        page.get_by_label('Connected GC account').select_option(GC1)
        expect(page.get_by_text(TEXT, exact=True)).to_be_visible()
        agree = page.get_by_label('I have read and agree to the exact disclosure above for this file and GC account.')
        grant = page.get_by_role('button', name='Share this file')
        assert grant.is_disabled()
        agree.check(); page.get_by_label('Connected GC account').select_option(GC2)
        assert not agree.is_checked() and grant.is_disabled()
        agree.check(); grant.click()
        expect(page.get_by_text('Share request recorded for this file and GC account.')).to_be_visible()
        assert json.loads([c for c in calls if c[1] == P + '/grant'][-1][3]) == {'fileId': F1, 'gcUserId': GC2, 'consentVersion': VERSION, 'affirmative': True}
        assert not agree.is_checked()
        page.get_by_role('button', name='Revoke access to this file').click()
        expect(page.get_by_text('Revocation request recorded', exact=False)).to_be_visible()
        assert json.loads([c for c in calls if c[1] == P + '/revoke'][-1][3]) == {'fileId': F1, 'gcUserId': GC2}
        # Service errors must not echo server detail, and consent failure cannot enable grant.
        state['grant_error'] = True; agree.check(); grant.click()
        expect(page.get_by_text('The sharing outcome could not be confirmed.', exact=False)).to_be_visible()
        assert not agree.is_checked() and page.get_by_text('private-detail').count() == 0
        state['grant_error'] = False; state['consent_error'] = True; state['list_error'] = True
        page.get_by_role('button', name='Refresh', exact=True).click()
        expect(page.get_by_text('Could not load the file disclosure.', exact=False)).to_be_visible()
        expect(page.get_by_text('Could not load your files.', exact=False)).to_be_visible()
        assert page.get_by_text('secret-server-detail').count() == 0 and page.get_by_role('button', name='Share this file').count() == 0
        state['consent_error'] = False; state['list_error'] = False
        page.get_by_role('button', name='Refresh', exact=True).click()
        expect(page.get_by_role('button', name=f'Preview file {F1}')).to_be_visible()
        # User cancellation reports an uncertain result and does not auto-retry.
        page.get_by_label('Self-reported COI record').select_option(RECORD)
        picker.set_input_files({'name':'cancel.pdf','mimeType':'application/pdf','buffer':b'hello'})
        page.evaluate("window.__hold='cooperative'")
        page.get_by_role('button', name='Upload private file').click()
        page.get_by_role('button', name='Cancel upload').click()
        expect(page.get_by_text('Upload outcome could not be confirmed.', exact=False)).to_be_visible()
        assert page.evaluate('window.__aborts') == 2
        # Held upload ignores abort; session switch must still suppress the old completion.
        page.get_by_role('button', name=f'Preview file {F1}').click()
        expect(page.get_by_alt_text('Your private document preview')).to_be_visible()
        page.get_by_label('Self-reported COI record').select_option(RECORD)
        picker.set_input_files({'name':'hold.pdf','mimeType':'application/pdf','buffer':b'hello'})
        page.evaluate("window.__hold='ignore'")
        page.get_by_role('button', name='Upload private file').click()
        expect(page.get_by_role('button', name='Cancel upload')).to_be_visible()
        page.get_by_role('button', name='Switch synthetic session').click()
        expect(page.get_by_role('button', name=f'Preview file {F3}')).to_be_visible()
        assert page.evaluate('window.__aborts') == 3
        assert page.evaluate('window.__created.length === window.__revoked.length')
        page.evaluate('window.__resolveHeld()')
        page.wait_for_timeout(100)
        assert page.get_by_text('Upload recorded.', exact=False).count() == 0
        assert page.get_by_text(F1, exact=False).count() == 0
        # Unmount revokes preview URLs, and neither token nor files reach Web Storage.
        page.get_by_role('button', name=f'Preview file {F3}').click()
        expect(page.get_by_alt_text('Your private document preview')).to_be_visible()
        page.get_by_role('button', name='Toggle test component').click()
        assert page.evaluate('window.__created.length === window.__revoked.length')
        assert page.evaluate('localStorage.length === 0 && sessionStorage.length === 0')
        page.get_by_role('button', name='Toggle test component').click()
        expect(page.get_by_role('button', name=f'Preview file {F3}')).to_be_visible()
        page.set_viewport_size({'width': 320, 'height': 800})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        page.evaluate('document.activeElement.blur()')
        page.keyboard.press('Tab')
        assert page.evaluate("['BUTTON','SELECT','INPUT'].includes(document.activeElement.tagName)")
        print('PASS: synthetic private-file browser contract, validation, consent, pagination, grants, abort/session, preview cleanup, errors and mobile')
        browser.close()
finally:
    server.terminate()
    try: server.wait(timeout=5)
    except subprocess.TimeoutExpired: server.kill(); server.wait()
