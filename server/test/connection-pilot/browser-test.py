#!/usr/bin/env python3
"""Built UI + local synthetic server only. Requires installed Python Playwright and Chromium."""
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[3]
server = subprocess.Popen(['node', '--experimental-strip-types', 'server/test/connection-pilot/browser-fixture.ts'], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    port = int(server.stdout.readline().strip())
    base = f'http://127.0.0.1:{port}'
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        context = browser.new_context(viewport={'width': 390, 'height': 844}, service_workers='block')
        context.add_init_script("""window.BarcodeDetector = class { async detect() { return [{rawValue:'A'.repeat(43)}] } };
          Object.defineProperty(navigator, 'mediaDevices', {value:{getUserMedia:async()=>{window.__stream=document.createElement('canvas').captureStream();return window.__stream}},configurable:true});
          HTMLMediaElement.prototype.play=async function() {};""")
        page = context.new_page()
        calls, violations = [], []
        page.on('request', lambda req: calls.append((req.url, req.headers)))
        page.on('console', lambda msg: violations.append(msg.text) if 'Content Security Policy' in msg.text else None)
        page.goto(base + '/')
        expect(page.get_by_role('heading', name='Sign in to your account')).to_be_visible()
        assert page.evaluate("getComputedStyle(document.querySelector('main')).minHeight") != '0px'
        def login(role):
            page.get_by_label('Email address').fill(role + '@example.test')
            page.get_by_label('Password').fill('synthetic password 123')
            page.get_by_role('button', name='Sign in', exact=True).click()
        login('sub')
        expect(page.get_by_role('heading', name='Profile connections')).to_be_visible()
        expect(page.get_by_text('Synthetic disclosure')).to_be_visible()
        assert page.get_by_role('heading', name='Self-reported COI metadata').count() == 0
        page.get_by_label('I have read and agree to the exact disclosure above.').check()
        page.get_by_role('button', name='Generate one-use QR').click()
        expect(page.get_by_role('img', name='One-use connection QR code')).to_be_visible()
        assert page.evaluate("document.querySelector('svg[aria-label=\"One-use connection QR code\"] path:last-child').getAttribute('d').length") > 100
        page.get_by_role('button', name='Sign out').click()
        expect(page.get_by_text('Signed out.', exact=True)).to_be_visible()
        login('gc')
        expect(page.get_by_role('heading', name='Synthetic Sub')).to_be_visible()
        page.get_by_label('Raw one-time code').fill('A' * 43)
        page.get_by_role('button', name='Connect', exact=True).click()
        expect(page.get_by_text('Connected. Refreshing your subcontractors.')).to_be_visible()
        page.get_by_role('button', name='Start camera').click()
        page.wait_for_function("window.__stream && window.__stream.getTracks().every(t => t.readyState === 'ended')")
        assert page.evaluate("async () => ({local:Object.keys(localStorage), session:Object.keys(sessionStorage), cookie:document.cookie, db:(await indexedDB.databases()).map(x=>x.name), caches:await caches.keys()})") == {'local': [], 'session': [], 'cookie': '', 'db': [], 'caches': []}
        assert context.cookies() == []
        assert all(url.startswith(base + '/') for url, headers in calls)
        assert not [url for url, headers in calls if '/self-reported-' in url or '/uploads/' in url]
        assert all('cookie' not in headers for url, headers in calls)
        assert all(not headers.get('referer') for url, headers in calls if '/api/' in url)
        assert not violations, violations
        # The transport prevents credential leakage to other paths/origins, bounds body,
        # concurrency and slow/oversize responses; use synthetic tokens only.
        result = page.evaluate('''async () => {
          const attempt = async (url, options) => { try { await fetch(url, options); return false } catch { return true } };
          const headers = {Authorization:'Bearer synthetic'};
          const controllers = Array.from({length:8}, () => new AbortController());
          const pending = controllers.map(c => attempt('/api/v2/auth/me', {headers:{Authorization:'Bearer slow'},signal:c.signal}));
          const excess = await attempt('/api/v2/auth/me', {headers});
          controllers.forEach(c => c.abort()); await Promise.all(pending);
          return {
            excess,
            other: await attempt('https://example.invalid/', {headers}),
            metadata: await attempt('/api/v2/self-reported-coi-metadata/own', {headers}),
            query: await attempt('/api/v2/auth/me?token=synthetic', {headers}),
            body: await attempt('/api/v2/auth/login', {method:'POST',body:'x'.repeat(8193)}),
            large: await attempt('/api/v2/auth/me', {headers:{Authorization:'Bearer large'}}),
            slow: await attempt('/api/v2/auth/me', {headers:{Authorization:'Bearer slow'}}),
          }
        }''')
        assert all(result.values()), result
        assert not [url for url, _ in calls if 'example.invalid' in url]
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        browser.close()
    print('PASS: built shell, CSP, same-origin synthetic login/QR/redeem, no cookies or storage, restrictions and network limits')
finally:
    server.terminate()
    try: server.wait(timeout=5)
    except subprocess.TimeoutExpired: server.kill(); server.wait()
