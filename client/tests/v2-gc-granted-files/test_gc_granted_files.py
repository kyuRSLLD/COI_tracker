#!/usr/bin/env python3
"""Offline synthetic tests; no backend, real user, credentials, storage, or external network."""
import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import time
from urllib.request import urlopen

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[3]
P = '/api/v2/self-reported-private-files'
RECORD = '11111111-1111-4111-8111-111111111111'
PHOTO = '22222222-2222-4222-8222-222222222222'
PDF = '33333333-3333-4333-8333-333333333333'
OTHER = '44444444-4444-4444-8444-444444444444'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a1sAAAAASUVORK5CYII=')
PDF_BYTES = b'%PDF-1.4\n% synthetic file\n%%EOF\n'


def item(fid, mime='image/png', size=None):
    if size is None:
        size = len(PNG) if mime == 'image/png' else len(PDF_BYTES)
    return {'id': fid, 'coiId': RECORD, 'mime': mime, 'sizeBytes': size,
            'createdAt': '2026-01-01T00:00:00.000Z', 'reportingStatus': 'self_reported_unverified'}


with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
base = f'http://127.0.0.1:{port}'
server = subprocess.Popen([str(ROOT / 'node_modules/.bin/vite'), '--config', 'tests/v2-gc-granted-files/vite.config.ts', '--host', '127.0.0.1', '--port', str(port), '--strictPort'], cwd=ROOT / 'client', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(100):
        try:
            with urlopen(base + '/tests/v2-gc-granted-files/index.html', timeout=1) as response:
                assert response.status == 200
            break
        except OSError:
            if server.poll() is not None: raise RuntimeError('Vite failed to start')
            time.sleep(.1)
    else: raise RuntimeError('Vite did not start')

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROME_BIN', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
        state = {'empty': True, 'revoke': False, 'bad_type': False, 'bad_size': False, 'paged': False, 'list_error': False}
        calls = []
        def intercept(route):
            req = route.request
            if not req.url.startswith(base + '/'):
                route.abort(); return
            path = req.url[len(base):]
            if not path.startswith('/api/'):
                route.continue_(); return
            assert '?' not in path and path.startswith(P + '/granted/'), (req.method, path)
            auth = req.headers.get('authorization')
            assert auth in ('Bearer synthetic-a', 'Bearer synthetic-b')
            assert req.headers.get('referer') is None
            calls.append((req.method, path, auth, req.post_data))
            if path == P + '/granted/list':
                if state['list_error']:
                    route.fulfill(status=503, json={'error': 'SECRET-SERVER-DETAIL'}); return
                if auth.endswith('synthetic-b'):
                    result = {'files': [item(OTHER)], 'nextCursor': None}
                elif state['empty']:
                    result = {'files': [], 'nextCursor': None}
                elif req.method == 'POST':
                    assert json.loads(req.post_data) == {'after': PHOTO}
                    result = {'files': [item(PDF, 'application/pdf')], 'nextCursor': None}
                else:
                    result = {'files': [item(PHOTO)] if state['paged'] else [item(PHOTO), item(PDF, 'application/pdf')], 'nextCursor': PHOTO if state['paged'] else None}
                route.fulfill(status=200, json=result); return
            assert req.method == 'GET'
            fid = path.rsplit('/', 1)[-1]
            assert fid in (PHOTO, PDF, OTHER)
            if state['revoke']:
                route.fulfill(status=404, json={'error': 'SECRET-SERVER-DETAIL'}); return
            content = PNG if fid in (PHOTO, OTHER) else PDF_BYTES
            if state['bad_size']: content += b'overflow'
            mime = 'text/html' if state['bad_type'] else ('image/png' if fid in (PHOTO, OTHER) else 'application/pdf')
            route.fulfill(status=200, body=content, headers={'content-type': mime}); return
        context = browser.new_context(viewport={'width': 390, 'height': 844})
        context.route('**/*', intercept)
        context.add_init_script(f'''(() => {{
          window.__created=[]; window.__revoked=[]; window.__aborts=0;
          const nativeTimer=window.setTimeout.bind(window);
          window.setTimeout=(fn,ms,...args)=>nativeTimer(fn,window.__quickDeadline && ms===30000 ? 25 : ms,...args);
          const create=URL.createObjectURL.bind(URL), revoke=URL.revokeObjectURL.bind(URL), native=window.fetch.bind(window);
          URL.createObjectURL=b=>{{const u=create(b); window.__created.push(u); return u}};
          URL.revokeObjectURL=u=>{{window.__revoked.push(u); return revoke(u)}};
          window.fetch=(url,init)=>{{
            const isList=String(url).endsWith('/granted/list');
            const isPhoto=String(url).endsWith('/granted/{PHOTO}');
            if (window.__streamOverflow && isPhoto) {{
              window.__streamOverflow=false;
              return Promise.resolve(new Response(new ReadableStream({{start(c){{c.enqueue(new Uint8Array({len(PNG) + 1}));c.close()}}}}),{{headers:{{'content-type':'image/png'}}}}));
            }}
            if ((window.__holdList && isList) || (window.__holdView && isPhoto)) {{
              const heldList=!!window.__holdList && isList;
              window.__holdList=false; window.__holdView=false;
              init.signal.addEventListener('abort',()=>window.__aborts++);
              return new Promise(resolve=>{{
                window.__resolveHeld=()=>{{
                  if (heldList) resolve(new Response(JSON.stringify({{files:[{json.dumps(item(PHOTO))}],nextCursor:null}}),{{headers:{{'content-type':'application/json'}}}}));
                  else {{const raw=atob('{base64.b64encode(PNG).decode()}'); resolve(new Response(Uint8Array.from(raw,c=>c.charCodeAt(0)),{{headers:{{'content-type':'image/png'}}}}))}}
                }};
              }});
            }}
            return native(url,init);
          }};
        }})()''')
        page = context.new_page()
        page.goto(base + '/tests/v2-gc-granted-files/index.html')
        expect(page.get_by_text('No separately shared files were returned.')).to_be_visible()
        assert page.get_by_role('button', name='View file', exact=True).count() == 0
        assert len(calls) == 1 and calls[0][1] == P + '/granted/list'  # no metadata-only access
        state.update(empty=False, paged=True)
        page.get_by_role('button', name='Refresh list').click()
        expect(page.get_by_role('button', name=f'View file {PHOTO}')).to_be_visible()
        assert page.get_by_role('button', name=f'View file {PDF}').count() == 0
        page.get_by_role('button', name='Load more files').click()
        expect(page.get_by_role('button', name=f'View file {PDF}')).to_be_visible()
        assert any(c[0] == 'POST' and json.loads(c[3]) == {'after': PHOTO} for c in calls)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        opener = page.get_by_role('button', name=f'View file {PHOTO}')
        opener.click()
        dialog = page.get_by_role('dialog', name='Self-reported document')
        expect(dialog.get_by_alt_text('Self-reported document preview')).to_be_visible()
        assert dialog.get_by_alt_text('Self-reported document preview').get_attribute('src').startswith('blob:')
        assert dialog.get_by_role('button', name='Back to files').evaluate('(e) => document.activeElement === e')
        dialog.get_by_role('button', name='Back to files').click()
        expect(dialog).to_have_count(0)
        expect(opener).to_be_focused()
        assert page.evaluate('__created.length === 1 && __revoked.length === 1')
        page.get_by_role('button', name=f'View file {PDF}').click()
        frame = dialog.get_by_title('Self-reported PDF preview')
        expect(frame).to_be_visible()
        assert frame.get_attribute('sandbox') == '' and frame.get_attribute('src').startswith('blob:')
        page.keyboard.press('Escape')
        expect(dialog).to_have_count(0)
        assert page.evaluate('__created.length === 2 && __revoked.length === 2')
        # Revocation between list and download: deny, clear all stale entries, no detail leakage.
        state['revoke'] = True
        opener.click()
        expect(dialog.get_by_role('alert')).to_contain_text('unavailable or access may have changed')
        dialog.get_by_role('button', name='Back to files').click()
        expect(page.get_by_role('alert')).to_contain_text('Files are unavailable')
        expect(page.get_by_role('button', name='Refresh list')).to_be_focused()
        assert page.get_by_text(PHOTO).count() == 0 and page.get_by_text('SECRET-SERVER-DETAIL').count() == 0
        state.update(revoke=False, empty=True)
        page.get_by_role('button', name='Refresh list').click()
        expect(page.get_by_text('No separately shared files were returned.')).to_be_visible()
        state['list_error'] = True
        page.get_by_role('button', name='Refresh list').click()
        expect(page.get_by_role('alert')).to_contain_text('Files are unavailable')
        assert page.get_by_text('SECRET-SERVER-DETAIL').count() == 0
        state['list_error'] = False
        # Invalid content or length never creates a preview URL.
        for fault in ('bad_type', 'bad_size'):
            state.update(empty=False, paged=False); state[fault] = True
            page.get_by_role('button', name='Refresh list').click()
            page.get_by_role('button', name=f'View file {PHOTO}').click()
            expect(dialog.get_by_role('alert')).to_be_visible()
            assert page.evaluate('__created.length === 2')
            dialog.get_by_role('button', name='Back to files').click()
            state[fault] = False
        page.get_by_role('button', name='Refresh list').click()
        expect(page.get_by_role('button', name=f'View file {PHOTO}')).to_be_visible()
        page.evaluate('__streamOverflow=true')
        page.get_by_role('button', name=f'View file {PHOTO}').click()
        expect(dialog.get_by_role('alert')).to_be_visible()
        assert page.evaluate('__created.length === 2')
        dialog.get_by_role('button', name='Back to files').click()
        # A deadline aborts even a non-cooperative fetch and invalidates the listing.
        page.get_by_role('button', name='Refresh list').click()
        expect(page.get_by_role('button', name=f'View file {PHOTO}')).to_be_visible()
        page.evaluate('__quickDeadline=true; __holdView=true')
        page.get_by_role('button', name=f'View file {PHOTO}').click()
        expect(dialog.get_by_role('alert')).to_be_visible()
        page.evaluate('__resolveHeld(); __quickDeadline=false')
        dialog.get_by_role('button', name='Back to files').click()
        assert page.evaluate('__created.length === 2 && __aborts === 1')
        # Ignored abort on a slow preview cannot create an object URL after back.
        page.get_by_role('button', name='Refresh list').click()
        expect(page.get_by_role('button', name=f'View file {PHOTO}')).to_be_visible()
        page.evaluate('__holdView=true')
        page.get_by_role('button', name=f'View file {PHOTO}').click()
        expect(dialog.get_by_text('Loading private preview…')).to_be_visible()
        dialog.get_by_role('button', name='Back to files').click()
        page.evaluate('__resolveHeld()'); page.wait_for_timeout(150)
        assert page.evaluate('__created.length === 2 && __aborts === 2')
        # Old account list response ignores abort and resolves after switching accounts.
        page.evaluate('__holdList=true')
        page.get_by_role('button', name='Refresh list').click()
        expect(page.get_by_text('Loading shared files…')).to_be_visible()
        page.get_by_role('button', name='Switch synthetic session').click()
        expect(page.get_by_role('button', name=f'View file {OTHER}')).to_be_visible()
        page.evaluate('__resolveHeld()'); page.wait_for_timeout(150)
        assert page.get_by_text(PHOTO).count() == 0 and page.evaluate('__aborts === 3')
        page.get_by_role('button', name='Switch to first session').click()
        expect(page.get_by_role('button', name=f'View file {PHOTO}')).to_be_visible()
        page.evaluate('__holdView=true')
        page.get_by_role('button', name=f'View file {PHOTO}').click()
        expect(dialog.get_by_text('Loading private preview…')).to_be_visible()
        # Host session events can occur independently of the modal UI.
        page.get_by_role('button', name='Switch synthetic session').evaluate('(e) => e.click()')
        expect(page.get_by_role('button', name=f'View file {OTHER}')).to_be_visible()
        page.evaluate('__resolveHeld()'); page.wait_for_timeout(150)
        assert page.evaluate('__created.length === 2 && __aborts === 4')
        assert page.get_by_text(PHOTO).count() == 0
        # Session change/sign-out disposes open preview URLs.
        page.get_by_role('button', name=f'View file {OTHER}').click()
        expect(dialog.get_by_alt_text('Self-reported document preview')).to_be_visible()
        page.get_by_role('button', name='Sign out').evaluate('(e) => e.click()')
        expect(page.get_by_text('A GC session is required.')).to_be_visible()
        assert page.evaluate('__created.length === 3 && __revoked.length === 3')
        assert page.get_by_text(OTHER).count() == 0
        assert all(c[1].startswith(P + '/granted/') for c in calls)
        context.close(); browser.close()
        print('PASS: synthetic GC granted-file browser tests (mobile, empty, pagination, PNG/PDF, revoke, bounds, session, stale responses, close/back)')
finally:
    server.terminate()
    try: server.wait(timeout=5)
    except subprocess.TimeoutExpired: server.kill(); server.wait()
