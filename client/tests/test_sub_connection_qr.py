"""Offline QR sharing tests: python3 client/tests/test_sub_connection_qr.py

Requires Python Playwright, Chromium, and the project's frontend dependencies.
All API calls are intercepted; no production data or external network is used.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import unittest
from datetime import datetime, timedelta, timezone
from urllib.request import urlopen

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
TOKEN = 'a' * 43  # A dummy credential for the mocked server only.
USER = {'id': 'user1', 'email': 'test@example.invalid', 'name': 'Test User', 'role': 'sub'}
SUB = {'id': 'sub1', 'company_name': 'Acme Test', 'trade': 'Electrical'}


class SubConnectionQrTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            cls.port = sock.getsockname()[1]
        cls.origin = f'http://127.0.0.1:{cls.port}'
        cls.server = subprocess.Popen(
            [str(ROOT / 'node_modules/.bin/vite'), '--host', '127.0.0.1', '--port', str(cls.port), '--strictPort'],
            cwd=ROOT / 'client', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        for _ in range(100):
            try:
                with urlopen(cls.origin, timeout=1):
                    break
            except Exception:
                time.sleep(.1)
        else:
            cls.server.terminate()
            raise RuntimeError('Vite did not start')
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(
            executable_path=os.environ.get('CHROME_BIN', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'],
        )

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.terminate()
        cls.server.wait(timeout=5)

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 390, 'height': 844})
        self.page = self.context.new_page()
        self.page.set_default_timeout(8000)
        self.calls = []
        self.qr_requests = []
        self.create_status = 200
        self.revoke_status = 200
        self.expiry_seconds = 900
        self.page.route('**/*', self.route)
        self.page.add_init_script(f'''
          localStorage.setItem('coi_user', {json.dumps(json.dumps(USER))});
          localStorage.setItem('coi_token', 'test-session');
          window.testClipboard = {{}};
          Object.defineProperty(navigator, 'clipboard', {{ value: {{
            writeText: async text => {{ window.testClipboard.text = text }},
            write: async items => {{ window.testClipboard.types = items[0].types }},
          }} }});
        ''')
        self.page.goto(self.origin + '/subcontractor')
        self.region = self.page.get_by_role('region', name='Share with a general contractor')
        self.region.wait_for()
        self.opener = self.region.get_by_role('button', name='Show connection QR code')
        self.panel = self.page.get_by_role('dialog')
        self.assertEqual(self.calls, [])
        self.assertEqual(self.qr_requests, [])
        self.open_modal()
        self.assertEqual(self.calls, [])
        self.assertEqual(self.qr_requests, [])

    def tearDown(self):
        self.context.close()

    def route(self, route):
        request = route.request
        path = request.url.split('?', 1)[0]
        if '/api/connection-qr' in path:
            self.qr_requests.append((request.method, path.removeprefix(self.origin)))
        if path.endswith('/api/auth/me'):
            return route.fulfill(json={'user': USER})
        if path.endswith('/api/sub/my'):
            return route.fulfill(json={'subcontractor': SUB, 'cois': [], 'requests': []})
        if path.endswith('/api/connection-qr') and request.method == 'POST':
            self.calls.append(('create', request.post_data_json))
            expiry = (datetime.now(timezone.utc) + timedelta(seconds=self.expiry_seconds)).isoformat()
            return route.fulfill(status=self.create_status, json={'token': TOKEN, 'expiresAt': expiry} if self.create_status == 200 else {'error': 'error'})
        if path.endswith('/api/connection-qr/revoke') and request.method == 'POST':
            self.calls.append(('revoke', request.post_data_json))
            return route.fulfill(status=self.revoke_status, json={'success': True} if self.revoke_status == 200 else {'error': 'error'})
        if '/api/connection-qr' in path:
            return route.abort()  # Never allow an unexpected QR request onto the network.
        if request.url.startswith(self.origin):
            return route.continue_()
        return route.abort()

    def open_modal(self):
        self.opener.click()
        self.panel.wait_for(state='visible')
    def close_modal(self):
        self.panel.get_by_role('button', name='Close', exact=False).click()
        self.panel.wait_for(state='hidden')
    def generate(self):
        self.panel.get_by_role('checkbox').check()
        self.panel.get_by_role('button', name='Generate QR code').click()

    def test_mobile_dialog_fills_viewport_and_controls_remain_reachable(self):
        # A showModal() dialog is natively modal even without an aria-modal attribute.
        self.assertTrue(self.panel.evaluate("el => el.matches(':modal') || el.getAttribute('aria-modal') === 'true'"))
        for width, height in [(390, 844), (320, 568)]:
            with self.subTest(viewport=(width, height)):
                self.page.set_viewport_size({'width': width, 'height': height})
                bounds = self.panel.bounding_box()
                self.assertIsNotNone(bounds)
                for actual, expected in [(bounds['x'], 0), (bounds['y'], 0),
                                         (bounds['width'], width), (bounds['height'], height)]:
                    self.assertAlmostEqual(actual, expected, delta=2)
                self.panel.get_by_role('checkbox').scroll_into_view_if_needed()
                self.assertTrue(self.panel.get_by_role('checkbox').is_visible())
                self.assertTrue(self.panel.get_by_role('button', name='Generate QR code').is_disabled())
        self.assertEqual(self.calls, [])
    def test_generated_qr_and_actions_are_reachable_on_narrow_mobile(self):
        self.page.set_viewport_size({'width': 320, 'height': 568})
        self.generate()
        qr = self.panel.get_by_role('img', name='QR code to connect one general contractor')
        qr.wait_for()
        qr.scroll_into_view_if_needed()
        bounds = qr.bounding_box()
        self.assertIsNotNone(bounds)
        self.assertGreater(bounds['width'], 0)
        self.assertGreaterEqual(bounds['x'], 0)
        self.assertLessEqual(bounds['x'] + bounds['width'], 320)
        self.panel.get_by_role('button', name='Copy link').click()
        self.assertEqual(self.page.evaluate('window.testClipboard.text'), 'https://safecoi.com/connect-sub#' + TOKEN)
        self.panel.get_by_role('button', name='Revoke / cancel QR code').scroll_into_view_if_needed()
        self.assertTrue(self.panel.get_by_role('button', name='Revoke / cancel QR code').is_visible())
        self.assertEqual(self.calls, [('create', {'consent': True})])
    def test_closing_while_generate_is_pending_does_not_duplicate_or_revoke(self):
        self.page.evaluate("""() => {
          const realFetch = window.fetch;
          window.deferredCreateCalls = 0;
          window.fetch = (...args) => {
            if (String(args[0]).endsWith('/api/connection-qr') && args[1]?.method === 'POST') {
              window.deferredCreateCalls++;
              return new Promise(resolve => { window.finishCreate = () => resolve(new Response(
                JSON.stringify({token: 'a'.repeat(43), expiresAt: new Date(Date.now()+900000).toISOString()}),
                {status:200, headers:{'Content-Type':'application/json'}})) });
            }
            return realFetch(...args);
          };
        }""")
        self.generate()
        self.page.wait_for_function('window.finishCreate !== undefined')
        self.close_modal()
        self.page.evaluate('window.finishCreate()')
        self.open_modal()
        self.panel.get_by_role('img', name='QR code to connect one general contractor').wait_for()
        self.assertEqual(self.panel.get_by_label('Private connection link').input_value(),
                         'https://safecoi.com/connect-sub#' + TOKEN)
        self.assertEqual(self.page.evaluate('window.deferredCreateCalls'), 1)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.qr_requests, [])  # The deferred create was intercepted above fetch.
    def test_desktop_dialog_is_bounded_and_centered(self):
        self.page.set_viewport_size({'width': 1280, 'height': 900})
        bounds = self.panel.bounding_box()
        self.assertIsNotNone(bounds)
        self.assertGreater(bounds['width'], 0)
        self.assertGreater(bounds['height'], 0)
        self.assertLess(bounds['width'], 1000)
        self.assertLess(bounds['height'], 900)
        self.assertGreater(bounds['x'], 0)
        self.assertGreater(bounds['y'], 0)
        self.assertAlmostEqual(bounds['x'] + bounds['width'] / 2, 640, delta=3)
        self.assertAlmostEqual(bounds['y'] + bounds['height'] / 2, 450, delta=3)
        self.assertEqual(self.calls, [])
    def test_keyboard_escape_closes_and_returns_focus_to_launcher(self):
        self.page.keyboard.press('Escape')
        self.panel.wait_for(state='hidden')
        self.page.wait_for_function("""() => document.activeElement?.textContent?.includes('Show connection QR code')""")
        self.assertTrue(self.opener.evaluate('(el) => document.activeElement === el'))
        self.assertEqual(self.calls, [])
        self.page.keyboard.press('Enter')
        self.panel.wait_for(state='visible')
        self.assertTrue(self.panel.get_by_role('button', name='Generate QR code').is_disabled())
        self.assertEqual(self.calls, [])
    def test_close_does_not_revoke_and_reopen_preserves_same_code(self):
        self.generate()
        self.panel.get_by_role('img', name='QR code to connect one general contractor').wait_for()
        expected = self.panel.get_by_label('Private connection link').input_value()
        self.assertEqual(self.calls, [('create', {'consent': True})])
        self.close_modal()
        self.assertEqual(self.calls, [('create', {'consent': True})])
        self.open_modal()
        self.assertEqual(self.panel.get_by_label('Private connection link').input_value(), expected)
        self.assertEqual(self.calls, [('create', {'consent': True})])
        self.page.keyboard.press('Escape')
        self.panel.wait_for(state='hidden')
        self.open_modal()
        self.assertEqual(self.panel.get_by_label('Private connection link').input_value(), expected)
        self.assertEqual(self.calls, [('create', {'consent': True})])
        self.assertEqual(self.qr_requests, [('POST', '/api/connection-qr')])
    def test_closed_code_expires_without_revoke_and_requires_new_consent(self):
        self.expiry_seconds = 1
        self.generate()
        self.panel.get_by_role('img').wait_for()
        self.close_modal()
        self.page.wait_for_timeout(1500)
        self.open_modal()
        self.panel.get_by_text('This QR code has expired.', exact=False).wait_for(timeout=5000)
        self.assertEqual(self.panel.locator('canvas').count(), 0)
        self.assertFalse(self.panel.get_by_role('checkbox').is_checked())
        self.assertTrue(self.panel.get_by_role('button', name='Generate QR code').is_disabled())
        self.assertEqual(self.calls, [('create', {'consent': True})])
        self.assertEqual(self.qr_requests, [('POST', '/api/connection-qr')])
    def test_closed_code_not_restored_after_session_switch(self):
        self.generate()
        self.panel.get_by_role('img').wait_for()
        self.close_modal()
        self.switch_session()
        self.assertEqual(self.panel.locator('canvas').count(), 0)
        self.assertFalse(self.panel.get_by_role('checkbox').is_checked())
        self.assertTrue(self.panel.get_by_role('button', name='Generate QR code').is_disabled())
        self.assertEqual(self.calls, [('create', {'consent': True})])
    def test_consent_payload_qr_copy_and_revocation(self):
        self.assertIn('all current and future', self.panel.inner_text().lower())
        self.assertIn('ongoing access', self.panel.inner_text().lower())
        self.assertIn('anonymized insurance information', self.panel.inner_text().lower())
        self.assertIn('client reports', self.panel.inner_text().lower())
        self.assertIn('only show or share this code with the intended general contractor', self.panel.inner_text().lower())
        self.assertIn('already connected', self.panel.inner_text().lower())
        self.assertTrue(self.panel.get_by_role('button', name='Generate QR code').is_disabled())
        self.assertEqual(self.calls, [])
        self.assertEqual(self.panel.locator('canvas').count(), 0)
        self.generate()
        self.panel.get_by_role('img', name='QR code to connect one general contractor').wait_for()
        self.assertEqual(self.calls, [('create', {'consent': True})])
        expected = 'https://safecoi.com/connect-sub#' + TOKEN
        self.assertEqual(self.panel.get_by_label('Private connection link').input_value(), expected)
        # Decode the rendered canvas to check it contains exactly the URL, not metadata.
        self.page.add_script_tag(path=str(ROOT / 'node_modules/jsqr/dist/jsQR.js'))
        decoded = self.page.evaluate('''() => {
          const canvas = document.querySelector('canvas');
          const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
          return jsQR(pixels.data, pixels.width, pixels.height).data;
        }''')
        self.assertEqual(decoded, expected)
        self.panel.get_by_role('button', name='Copy link').click()
        self.assertEqual(self.page.evaluate('window.testClipboard.text'), expected)
        self.panel.get_by_role('button', name='Copy QR code').click()
        self.page.get_by_text('QR code copied.', exact=False).wait_for()
        self.assertEqual(self.page.evaluate('window.testClipboard.types'), ['image/png'])
        storage = self.page.evaluate('JSON.stringify(localStorage) + JSON.stringify(sessionStorage)')
        self.assertNotIn(TOKEN, storage)
        self.panel.get_by_role('button', name='Revoke / cancel QR code').click()
        self.panel.get_by_text('The QR code was revoked.', exact=False).wait_for()
        self.assertEqual(self.calls[-1], ('revoke', {'token': TOKEN}))
        self.assertEqual(self.panel.locator('canvas').count(), 0)
        self.assertFalse(self.panel.get_by_role('checkbox').is_checked())
        self.assertTrue(self.panel.get_by_role('button', name='Generate QR code').is_disabled())

    def test_errors_and_retry_do_not_expose_token(self):
        self.create_status = 500
        self.generate()
        self.panel.get_by_role('alert').get_by_text('Could not generate a QR code.', exact=False).wait_for()
        self.assertEqual(self.panel.locator('canvas').count(), 0)
        self.create_status = 200
        self.panel.get_by_role('button', name='Generate QR code').click()
        self.panel.get_by_role('img').wait_for()
        self.revoke_status = 500
        self.panel.get_by_role('button', name='Revoke / cancel QR code').click()
        self.panel.get_by_role('alert').get_by_text('Could not revoke the QR code.', exact=False).wait_for()
        self.assertEqual(self.panel.locator('canvas').count(), 1)
        self.assertNotIn(TOKEN, self.panel.get_by_role('alert').inner_text())
        self.revoke_status = 200
        self.panel.get_by_role('button', name='Revoke / cancel QR code').click()
        self.panel.get_by_text('The QR code was revoked.', exact=False).wait_for()

    def test_keyboard_and_clipboard_fallback(self):
        checkbox = self.panel.get_by_role('checkbox')
        checkbox.focus()
        self.page.keyboard.press('Space')
        self.page.keyboard.press('Tab')
        self.assertTrue(self.panel.get_by_role('button', name='Generate QR code').evaluate('(el) => document.activeElement === el'))
        self.page.keyboard.press('Enter')
        self.panel.get_by_role('img').wait_for()
        self.page.evaluate('''() => {
          navigator.clipboard.writeText = async () => { throw new Error('blocked') };
          navigator.clipboard.write = async () => { throw new Error('blocked') };
        }''')
        self.panel.get_by_role('button', name='Copy link').click()
        self.panel.get_by_role('alert').get_by_text('Could not copy automatically.', exact=False).wait_for()
        self.assertTrue(self.panel.get_by_label('Private connection link').evaluate('(el) => document.activeElement === el && el.selectionStart === 0 && el.selectionEnd === el.value.length'))
        self.panel.get_by_role('button', name='Copy QR code').click()
        self.panel.get_by_role('alert').get_by_text('You can take a screenshot', exact=False).wait_for()

    def test_expiration_hides_code_and_requires_new_consent(self):
        self.expiry_seconds = 1
        self.generate()
        self.panel.get_by_role('img').wait_for()
        self.panel.get_by_text('This QR code has expired.', exact=False).wait_for(timeout=5000)
        self.assertEqual(self.panel.locator('canvas').count(), 0)
        self.assertFalse(self.panel.get_by_role('checkbox').is_checked())
        self.assertTrue(self.panel.get_by_role('button', name='Generate QR code').is_disabled())
        self.assertEqual(len(self.calls), 1)

    def switch_session(self):
        old_opener = self.opener.element_handle()
        with self.page.expect_response(lambda r: '/api/auth/me' in r.url and
                                       r.request.headers.get('authorization') == 'Bearer other-sub-session'):
            self.page.evaluate('''() => {
              localStorage.setItem('coi_token', 'other-sub-session');
              window.dispatchEvent(new StorageEvent('storage', {key:'coi_token', storageArea:localStorage}));
            }''')
        # Wait for React's verified-session remount, not just the network response.
        self.page.wait_for_function('(old) => !old.isConnected', arg=old_opener)
        self.panel.wait_for(state='hidden')
        self.opener.wait_for(state='visible')
        self.open_modal()
        self.panel.get_by_role('checkbox').wait_for()

    def test_create_completion_is_ignored_after_account_switch(self):
        self.page.evaluate('''() => {
          const realFetch = window.fetch;
          window.fetch = (...args) => {
            if (String(args[0]).endsWith('/api/connection-qr') && args[1]?.method === 'POST') {
              window.createdAuthorization = args[1].headers.Authorization;
              return new Promise(resolve => { window.finishCreate = () => resolve(new Response(JSON.stringify({token: 'a'.repeat(43), expiresAt: new Date(Date.now()+900000).toISOString()}), {status:200, headers:{'Content-Type':'application/json'}})) });
            }
            return realFetch(...args);
          };
        }''')
        self.generate()
        self.page.wait_for_function('window.finishCreate !== undefined')
        self.assertEqual(self.page.evaluate('window.createdAuthorization'), 'Bearer test-session')
        self.switch_session()
        self.page.evaluate('window.finishCreate()')
        self.page.wait_for_timeout(100)
        self.assertEqual(self.panel.locator('canvas').count(), 0)
        self.assertFalse(self.panel.get_by_role('checkbox').is_checked())
        self.assertEqual(self.calls, [])

    def test_stale_revoke_and_copy_are_not_sent_under_new_session(self):
        self.generate()
        self.panel.get_by_role('img').wait_for()
        self.page.evaluate('''() => {
          HTMLCanvasElement.prototype.toBlob = function(cb) { window.finishBlob = () => cb(new Blob(['png'], {type:'image/png'})); };
        }''')
        self.panel.get_by_role('button', name='Copy QR code').click()
        self.page.wait_for_function('window.finishBlob !== undefined')
        self.switch_session()
        self.page.evaluate('window.finishBlob()')
        self.page.wait_for_timeout(100)
        self.assertIsNone(self.page.evaluate('window.testClipboard.types || null'))
        self.assertEqual(self.calls, [('create', {'consent': True})])
        self.assertEqual(self.panel.locator('canvas').count(), 0)

    def test_actions_reject_token_change_before_reverification(self):
        self.generate()
        self.panel.get_by_role('img').wait_for()
        self.page.evaluate("localStorage.setItem('coi_token', 'other-sub-session')")
        self.panel.get_by_role('button', name='Revoke / cancel QR code').click()
        self.page.wait_for_timeout(100)
        self.assertEqual(self.calls, [('create', {'consent': True})])
        self.assertIsNone(self.page.evaluate('window.testClipboard.text || null'))

    def test_revoke_completion_is_ignored_after_account_switch(self):
        self.generate()
        self.panel.get_by_role('img').wait_for()
        self.page.evaluate('''() => {
          const realFetch = window.fetch;
          window.fetch = (...args) => {
            if (String(args[0]).endsWith('/api/connection-qr/revoke')) {
              window.revokeAuthorization = args[1].headers.Authorization;
              return new Promise(resolve => { window.finishRevoke = () => resolve(new Response(JSON.stringify({success:true}), {status:200, headers:{'Content-Type':'application/json'}})) });
            }
            return realFetch(...args);
          };
        }''')
        self.panel.get_by_role('button', name='Revoke / cancel QR code').click()
        self.page.wait_for_function('window.finishRevoke !== undefined')
        self.assertEqual(self.page.evaluate('window.revokeAuthorization'), 'Bearer test-session')
        self.switch_session()
        self.page.evaluate('window.finishRevoke()')
        self.page.wait_for_timeout(100)
        self.assertEqual(self.panel.get_by_text('The QR code was revoked.', exact=False).count(), 0)
        self.assertEqual(self.panel.locator('canvas').count(), 0)
        self.assertFalse(self.panel.get_by_role('checkbox').is_checked())

    def test_copy_link_does_not_start_after_session_change(self):
        self.generate()
        self.panel.get_by_role('img').wait_for()
        self.page.evaluate("localStorage.setItem('coi_token', 'other-sub-session')")
        self.panel.get_by_role('button', name='Copy link').click()
        self.page.wait_for_timeout(100)
        self.assertIsNone(self.page.evaluate('window.testClipboard.text || null'))


if __name__ == '__main__':
    unittest.main()
