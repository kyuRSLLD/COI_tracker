"""Isolated GC connection regressions. Run: python3 client/tests/test_gc_connection_qr.py
Requires Python Playwright, Chromium, and npm dependencies. Starts frontend-only
Vite with no proxy; every nonlocal request is blocked and all APIs are mocked.
"""
import json
import base64
import os
from pathlib import Path
import socket
import subprocess
import time
import unittest
from urllib.parse import urlsplit
from urllib.request import urlopen
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
CODE = 'A' * 43
AUTH = 'mock-gc-session'
USERS = {r: {'id': r, 'email': f'{r}@example.invalid', 'name': r, 'role': r} for r in ['gc', 'sub']}
STATS = {'totals': {'total': 0, 'compliant': 0, 'expiring': 0, 'expired': 0, 'missing': 0, 'pending': 0, 'score': 0}, 'projects_count': 0, 'share_links_count': 0, 'trades': [], 'upcoming': []}

class GCConnectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); cls.port = sock.getsockname()[1]
        cls.origin = f'http://127.0.0.1:{cls.port}'
        js = """import { createServer } from 'vite'; import react from '@vitejs/plugin-react';
const s=await createServer({configFile:false,root:process.cwd(),plugins:[react()],server:{host:'127.0.0.1',port:Number(process.argv[1]),strictPort:true,hmr:false,proxy:{}},logLevel:'error'});await s.listen();"""
        cls.server = subprocess.Popen(['node', '--input-type=module', '-e', js, str(cls.port)], cwd=ROOT/'client', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                with urlopen(cls.origin, timeout=1): break
            except Exception: time.sleep(.1)
        else: raise RuntimeError('Vite did not start')
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(executable_path=os.environ.get('CHROME_BIN', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.terminate(); cls.server.wait(timeout=5)

    def setUp(self):
        self.role = 'gc'; self.redeems = []; self.invites = 0; self.unknown = []; self.errors = []; self.redeem_status = 200
        self.context = self.browser.new_context(service_workers='block')
        self.context.route('**/*', self.route)
        self.context.route_web_socket('**/*', lambda ws: None)
        self.page = self.context.new_page()
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))

    def tearDown(self):
        self.context.close()
        self.assertFalse(self.unknown, f'Unexpected API: {self.unknown}')
        self.assertFalse(self.errors, f'Browser error: {self.errors}')

    def route(self, route):
        req = route.request; url = urlsplit(req.url)
        if f'{url.scheme}://{url.netloc}' != self.origin: return route.abort()
        if not url.path.startswith('/api/'): return route.continue_()
        def reply(data, status=200): return route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if url.path == '/api/auth/login': return reply({'token': AUTH, 'user': USERS[self.role]})
        if url.path == '/api/auth/me': return reply({'user': USERS[self.role]})
        if url.path == '/api/connection-qr/redeem':
            self.redeems.append({'method': req.method, 'body': req.post_data_json, 'auth': req.headers.get('authorization')})
            if self.redeem_status != 200: return reply({'error': 'Unavailable'}, self.redeem_status)
            return reply({'success': True, 'subcontractor': {'id': 'sub-1', 'company_name': 'Sample Plumbing'}})
        if url.path == '/api/settings/qr-invite':
            self.invites += 1
            return reply({'invite_url': 'https://safecoi.com/join/join-123', 'invite_code': 'join-123', 'company_name': 'Mock GC'})
        payloads = {'/api/subcontractors': {'subcontractors': []}, '/api/settings': {'settings': {'expiration_warning_days': 30}}, '/api/stats': STATS, '/api/cois': {'cois': []}, '/api/projects': {'projects': []}}
        if url.path in payloads: return reply(payloads[url.path])
        self.unknown.append(url.path); return reply({'error': 'Unexpected API'}, 500)

    def sign_in(self):
        self.page.get_by_label('Email', exact=True).fill('gc@example.invalid')
        self.page.get_by_label('Password', exact=True).fill('dummy-password')
        self.page.get_by_role('button', name='Sign in', exact=True).click()

    def load_gc_subs(self):
        self.context.add_init_script(f'localStorage.setItem("coi_token", {json.dumps(AUTH)})')
        self.page.goto(self.origin + '/subcontractors')
        self.page.get_by_role('heading', name='Subcontractors', exact=True).wait_for()
        self.page.get_by_role('button', name='Add subcontractor', exact=True).click()

    def qr_png(self, value):
        # Generate a real QR using the application's existing qrcode.react dependency.
        js = """import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {QRCodeSVG} from 'qrcode.react'; console.log(renderToStaticMarkup(React.createElement(QRCodeSVG,{value:process.argv[1],size:400,marginSize:4})));"""
        svg = subprocess.check_output(['node', '--input-type=module', '-e', js, value], cwd=ROOT, text=True)
        tmp = self.context.new_page(); tmp.set_content('<body style="margin:0">' + svg + '</body>')
        image = tmp.locator('svg').screenshot(); tmp.close(); return image

    def upload(self, image):
        with self.page.expect_file_chooser() as chooser:
            self.page.get_by_role('button', name='Upload sub QR', exact=True).click()
        self.assertEqual(chooser.value.element.get_attribute('type'), 'file')
        self.assertEqual(chooser.value.element.get_attribute('accept'), 'image/png,image/jpeg')
        chooser.value.set_files({'name': 'code.png', 'mimeType': 'image/png', 'buffer': image})

    def install_camera_mock(self, supported=True):
        # The only mocked parts are capture/playback and the video-to-canvas copy.
        # jsQR still sees real pixels generated by qr_png; no decoder is stubbed.
        self.context.add_init_script('''(() => {
          Object.defineProperty(navigator, 'mediaDevices', {configurable:true, value:undefined});
        })();''' if not supported else '''(() => {
          const mock = window.cameraMock = {calls:[], streams:[], mode:'ok', frame:null};
          mock.makeStream = () => {
            const track = new EventTarget();
            track.stops = 0;
            track.stop = () => { track.stops++; };
            const stream = {getTracks:() => [track], track};
            mock.streams.push(stream);
            return stream;
          };
          mock.setFrame = async dataUrl => {
            const image = new Image();
            image.src = dataUrl;
            await image.decode();
            mock.frame = image;
          };
          Object.defineProperty(navigator, 'mediaDevices', {configurable:true, value:{
            getUserMedia: constraints => {
              mock.calls.push(constraints);
              if (mock.mode === 'denied') return Promise.reject(new DOMException('Denied', 'NotAllowedError'));
              if (mock.mode === 'pending') return new Promise(resolve => { mock.resolvePending = () => resolve(mock.makeStream()); });
              return Promise.resolve(mock.makeStream());
            }
          }});
          Object.defineProperties(HTMLVideoElement.prototype, {
            srcObject: {configurable:true, get() { return this._fakeStream || null; }, set(v) { this._fakeStream = v; }},
            readyState: {configurable:true, get() { return 4; }},
            videoWidth: {configurable:true, get() { return 400; }},
            videoHeight: {configurable:true, get() { return 400; }}
          });
          HTMLVideoElement.prototype.play = function() { return Promise.resolve(); };
          const drawImage = CanvasRenderingContext2D.prototype.drawImage;
          CanvasRenderingContext2D.prototype.drawImage = function(source, ...args) {
            if (!(source instanceof HTMLVideoElement)) return drawImage.call(this, source, ...args);
            if (mock.frame) return drawImage.call(this, mock.frame, ...args);
            this.fillStyle = 'white'; this.fillRect(0, 0, this.canvas.width, this.canvas.height);
          };
        })();''')

    def camera_frame(self, value):
        png = self.qr_png(value)
        data_url = 'data:image/png;base64,' + base64.b64encode(png).decode('ascii')
        self.page.evaluate('value => window.cameraMock.setFrame(value)', data_url)

    def open_camera(self):
        self.page.get_by_role('button', name='Scan QR code', exact=True).click()
        self.page.get_by_role('region', name='Camera QR scanner').wait_for()

    def start_camera(self):
        self.page.get_by_role('button', name='Start camera', exact=True).click()
        self.page.wait_for_function('window.cameraMock.streams.length === 1')
        self.page.get_by_text('Point the camera', exact=False).wait_for()

    def assert_camera_stopped(self):
        self.page.wait_for_function('window.cameraMock.streams[0].track.stops === 1')
        self.assertFalse(self.redeems)

    def test_camera_real_qr_requires_explicit_connect(self):
        self.install_camera_mock()
        self.load_gc_subs()
        self.open_camera()
        self.assertEqual(self.page.evaluate('window.cameraMock.calls.length'), 0, 'Opening the scanner must not request camera access')
        self.start_camera()
        self.assertEqual(self.page.evaluate('window.cameraMock.calls[0]'), {'audio': False, 'video': {'facingMode': {'ideal': 'environment'}}})
        self.camera_frame('https://evil.example/connect-sub#' + CODE)
        self.page.get_by_text('not a SafeCOI subcontractor connection code', exact=False).wait_for()
        self.assertEqual(self.page.evaluate('window.cameraMock.streams[0].track.stops'), 0)
        self.assertFalse(self.redeems)
        self.camera_frame('https://safecoi.com/connect-sub#' + CODE)
        self.page.get_by_text('Connect to add or link this subcontractor', exact=False).wait_for()
        self.assert_camera_stopped()
        self.page.get_by_role('button', name='Connect subcontractor', exact=True).click()
        self.page.get_by_role('status').get_by_text('Sample Plumbing').wait_for()
        self.assertEqual(self.redeems, [{'method': 'POST', 'body': {'token': CODE}, 'auth': 'Bearer ' + AUTH}])

    def test_camera_stops_when_switching_modes_or_closing(self):
        self.install_camera_mock()
        for action in ('email', 'manual', 'close scanner', 'close modal'):
            with self.subTest(action=action):
                self.load_gc_subs()
                self.open_camera()
                self.start_camera()
                if action == 'email':
                    self.page.get_by_role('button', name='Invite by email', exact=True).click()
                    self.page.get_by_label('Subcontractor email').wait_for()
                elif action == 'manual':
                    self.page.get_by_role('button', name='Enter manually', exact=True).click()
                    self.page.get_by_placeholder('e.g. Horizon Electrical Services').wait_for()
                elif action == 'close scanner':
                    self.page.get_by_role('button', name='Close scanner', exact=True).click()
                else:
                    self.page.get_by_role('button', name='Close', exact=True).click()
                self.assert_camera_stopped()
                self.assertFalse(self.page.get_by_role('region', name='Camera QR scanner').is_visible())

    def test_switching_camera_to_screenshot_stops_track(self):
        self.install_camera_mock()
        self.load_gc_subs()
        self.open_camera()
        self.start_camera()
        self.upload(self.qr_png('https://safecoi.com/connect-sub#' + CODE))
        self.assert_camera_stopped()
        self.page.get_by_text('Connect to add or link this subcontractor', exact=False).wait_for()
        self.assertFalse(self.redeems)

    def test_camera_stops_on_verified_session_change(self):
        self.install_camera_mock()
        self.load_gc_subs()
        self.open_camera()
        self.start_camera()
        self.page.evaluate('''() => {
          localStorage.setItem('coi_token', 'second-gc-session');
          window.dispatchEvent(new StorageEvent('storage', {key:'coi_token', storageArea:localStorage}));
        }''')
        self.assert_camera_stopped()
        self.assertFalse(self.page.get_by_role('region', name='Camera QR scanner').is_visible())
        self.assertEqual(self.page.get_by_role('button', name='Connect subcontractor', exact=True).count(), 0)

    def test_camera_decoded_after_silent_token_change_is_not_staged(self):
        self.install_camera_mock()
        self.load_gc_subs()
        self.open_camera()
        self.start_camera()
        # No storage event: the decoder callback itself must notice the new token.
        self.page.evaluate("localStorage.setItem('coi_token', 'second-gc-session')")
        self.camera_frame('https://safecoi.com/connect-sub#' + CODE)
        self.assert_camera_stopped()
        self.page.wait_for_function("!document.querySelector('[aria-label=\"Camera QR scanner\"]')")
        self.assertEqual(self.page.get_by_role('button', name='Connect subcontractor', exact=True).count(), 0)
        self.assertFalse(self.redeems)

    def test_camera_staged_code_cannot_redeem_after_token_change(self):
        self.install_camera_mock()
        self.load_gc_subs()
        self.open_camera()
        self.start_camera()
        self.camera_frame('https://safecoi.com/connect-sub#' + CODE)
        self.page.get_by_role('button', name='Connect subcontractor', exact=True).wait_for()
        self.assert_camera_stopped()
        self.page.evaluate("localStorage.setItem('coi_token', 'second-gc-session')")
        self.page.get_by_role('button', name='Connect subcontractor', exact=True).click()
        self.page.wait_for_timeout(100)
        self.assertFalse(self.redeems)

    def test_camera_permission_denied_can_retry(self):
        self.install_camera_mock()
        self.load_gc_subs()
        self.open_camera()
        self.page.evaluate("window.cameraMock.mode = 'denied'")
        self.page.get_by_role('button', name='Start camera', exact=True).click()
        self.page.get_by_role('alert').get_by_text('permission was denied', exact=False).wait_for()
        self.assertEqual(self.page.evaluate('window.cameraMock.streams.length'), 0)
        self.assertFalse(self.redeems)
        self.page.evaluate("window.cameraMock.mode = 'ok'")
        self.page.get_by_role('button', name='Try camera again', exact=True).click()
        self.page.get_by_text('Point the camera', exact=False).wait_for()
        self.assertEqual(self.page.evaluate('window.cameraMock.calls.length'), 2)
        self.page.get_by_role('button', name='Close scanner', exact=True).click()
        self.assert_camera_stopped()

    def test_camera_unavailable_shows_upload_fallback(self):
        self.install_camera_mock(supported=False)
        self.load_gc_subs()
        self.open_camera()
        self.page.get_by_text('Camera scanning is unavailable', exact=False).wait_for()
        self.assertEqual(self.page.get_by_role('button', name='Start camera', exact=True).count(), 0)
        self.assertTrue(self.page.get_by_role('button', name='Upload sub QR', exact=True).is_visible())
        self.assertFalse(self.redeems)

    def test_camera_late_permission_result_is_stopped_after_close(self):
        self.install_camera_mock()
        self.load_gc_subs()
        self.open_camera()
        self.page.evaluate("window.cameraMock.mode = 'pending'")
        self.page.get_by_role('button', name='Start camera', exact=True).click()
        self.page.wait_for_function('typeof window.cameraMock.resolvePending === "function"')
        self.page.get_by_role('button', name='Close scanner', exact=True).click()
        self.page.evaluate('window.cameraMock.resolvePending()')
        self.assert_camera_stopped()
        self.assertFalse(self.page.get_by_role('region', name='Camera QR scanner').is_visible())

    def test_camera_late_permission_result_is_stopped_after_session_change(self):
        self.install_camera_mock()
        self.load_gc_subs()
        self.open_camera()
        self.page.evaluate("window.cameraMock.mode = 'pending'")
        self.page.get_by_role('button', name='Start camera', exact=True).click()
        self.page.wait_for_function('typeof window.cameraMock.resolvePending === "function"')
        self.page.evaluate('''() => {
          localStorage.setItem('coi_token', 'second-gc-session');
          window.dispatchEvent(new StorageEvent('storage', {key:'coi_token', storageArea:localStorage}));
        }''')
        self.page.wait_for_function("!document.querySelector('[aria-label=\"Camera QR scanner\"]')")
        self.page.evaluate('window.cameraMock.resolvePending()')
        self.assert_camera_stopped()
        self.assertEqual(self.page.get_by_role('button', name='Connect subcontractor', exact=True).count(), 0)

    def test_scanned_anonymous_then_gc_requires_explicit_connect(self):
        self.page.goto(self.origin + '/connect-sub#' + CODE)
        self.page.get_by_role('heading', name='Connect a subcontractor').wait_for()
        self.assertEqual(urlsplit(self.page.url).fragment, '')
        self.assertIsNone(self.page.evaluate("sessionStorage.getItem('coi_pending_sub_connection')"))
        self.assertEqual(self.redeems, [])
        self.sign_in()
        self.page.get_by_role('button', name='Connect subcontractor').wait_for()
        self.assertEqual(urlsplit(self.page.url).path, '/connect-sub')
        self.assertEqual(self.redeems, [])
        self.page.get_by_role('button', name='Connect subcontractor').click()
        self.page.get_by_role('status').get_by_text('Sample Plumbing').wait_for()
        self.assertEqual(self.redeems, [{'method': 'POST', 'body': {'token': CODE}, 'auth': 'Bearer ' + AUTH}])
        self.assertIsNone(self.page.evaluate("sessionStorage.getItem('coi_pending_sub_connection')"))

    def test_sub_account_switch_then_gc_connects(self):
        self.role = 'sub'; self.page.goto(self.origin + '/connect-sub#' + CODE); self.sign_in()
        self.page.get_by_text('Only general contractor accounts can connect a subcontractor.', exact=False).wait_for()
        self.assertFalse(self.redeems)
        self.page.get_by_role('button', name='Switch account').click()
        self.role = 'gc'; self.sign_in()
        self.page.get_by_role('button', name='Connect subcontractor').click()
        self.page.get_by_text('Sample Plumbing').wait_for()
        self.assertEqual(len(self.redeems), 1)

    def test_add_screen_offers_qr_and_email_before_manual_and_file_chooser_works(self):
        self.load_gc_subs()
        qr = self.page.get_by_role('button', name='Upload sub QR', exact=True)
        email = self.page.get_by_role('button', name='Invite by email', exact=True)
        manual = self.page.get_by_role('button', name='Enter manually', exact=True)
        for option in (qr, email, manual):
            self.assertTrue(option.is_visible(), f'Expected visible option: {option}')
        # Check both the DOM order and the actual visual order, including wrapping.
        self.assertTrue(qr.evaluate('(e, other) => !!(e.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING)', email.element_handle()))
        self.assertTrue(email.evaluate('(e, other) => !!(e.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING)', manual.element_handle()))
        positions = [option.bounding_box() for option in (qr, email, manual)]
        self.assertEqual(positions, sorted(positions, key=lambda box: (round(box['y']), box['x'])))

        # Selecting email then QR proves both choices are actionable, not just labels.
        email.click()
        self.page.get_by_label('Subcontractor email').wait_for()
        image = self.qr_png('https://safecoi.com/connect-sub#' + CODE)
        self.upload(image)
        self.page.get_by_text('Connection QR detected.', exact=False).wait_for()
        self.assertFalse(self.redeems, 'Selecting a screenshot must not redeem without confirmation')

    def test_screenshot_valid_invalid_and_expired(self):
        self.load_gc_subs()
        self.upload(self.qr_png('https://evil.example/connect-sub#' + CODE))
        self.page.get_by_role('alert').get_by_text('not a valid SafeCOI', exact=False).wait_for()
        self.assertFalse(self.redeems)
        self.upload(self.qr_png('https://safecoi.com/connect-sub#' + CODE))
        self.page.get_by_text('Connection QR detected.', exact=False).wait_for()
        self.assertFalse(self.redeems)
        self.redeem_status = 404
        self.page.get_by_role('button', name='Connect subcontractor').click()
        self.page.get_by_role('alert').get_by_text('invalid, expired', exact=False).wait_for()
        self.redeem_status = 200
        self.page.get_by_role('button', name='Connect subcontractor').click()
        self.page.get_by_role('status').get_by_text('Sample Plumbing').wait_for()
        self.assertEqual(len(self.redeems), 2)
        self.assertTrue(all(r['body'] == {'token': CODE} and r['auth'] == 'Bearer ' + AUTH for r in self.redeems))

    def test_email_draft_does_not_send(self):
        self.load_gc_subs()
        self.page.get_by_role('button', name='Invite by email').click()
        self.page.get_by_label('Subcontractor email').fill('sub@example.invalid')
        self.page.get_by_role('button', name='Prepare invitation').click()
        link = self.page.get_by_role('link', name='Open email application')
        link.wait_for()
        self.assertIn('mailto:sub%40example.invalid', link.get_attribute('href'))
        self.page.get_by_text('No email has been sent automatically', exact=False).wait_for()
        self.assertEqual(self.invites, 1); self.assertFalse(self.redeems)

    def test_manual_create_form_still_available(self):
        self.load_gc_subs()
        self.page.get_by_role('button', name='Enter manually').click()
        self.assertTrue(self.page.get_by_placeholder('e.g. Horizon Electrical Services').is_visible())
        self.assertFalse(self.redeems)

    def test_url_parser_rejects_lookalike_and_invalid_targets(self):
        self.page.goto(self.origin + '/')
        values = [
            'https://safecoi.com/connect-sub#' + CODE,
            'https://www.safecoi.com/connect-sub#' + CODE,
            'http://safecoi.com/connect-sub#' + CODE,
            'https://safecoi.com.evil.invalid/connect-sub#' + CODE,
            'https://www.safecoi.com.evil.invalid/connect-sub#' + CODE,
            'https://evil.invalid@www.safecoi.com/connect-sub#' + CODE,
            'https://www.safecoi.com:443/connect-sub#' + CODE,
            'https://safecoi.com/connect-sub/?x=1#' + CODE,
            'https://safecoi.com/connect-sub#' + CODE + '=',
            'https://safecoi.com/connect-sub#' + CODE[:-1],
            'https://safecoi.com/connect-sub#' + CODE + '\n',
        ]
        result = self.page.evaluate("async values => { const m = await import('/src/components/ConnectionOptions.tsx'); return values.map(m.tokenFromQr) }", values)
        self.assertEqual(result, [CODE, CODE, None, None, None, None, None, None, None, None, None])

    def test_www_screenshot_is_accepted_and_cancel_discards_it(self):
        self.load_gc_subs()
        self.upload(self.qr_png('https://www.safecoi.com/connect-sub#' + CODE))
        self.page.get_by_text('Connection QR detected.', exact=False).wait_for()
        self.page.get_by_role('button', name='Cancel', exact=True).click()
        self.assertEqual(self.page.get_by_text('Connection QR detected.', exact=False).count(), 0)
        self.assertFalse(self.redeems)

    def test_cancel_removes_pending_code_and_back_does_not_restore_it(self):
        self.page.goto(self.origin + '/')
        self.page.goto(self.origin + '/connect-sub#' + CODE)
        self.page.get_by_role('button', name='Cancel connection').click()
        self.assertIsNone(self.page.evaluate("sessionStorage.getItem('coi_pending_sub_connection')"))
        self.assertEqual(urlsplit(self.page.url).fragment, '')
        self.page.get_by_text('No valid connection code is available.', exact=False).wait_for()
        self.page.go_back()
        self.page.go_forward()
        self.page.get_by_text('No valid connection code is available.', exact=False).wait_for()
        self.assertFalse(self.redeems)

    def test_abandonment_clears_on_unmount_and_browser_back(self):
        self.page.goto(self.origin + '/connect-sub#' + CODE)
        self.page.get_by_role('button', name='Cancel connection').wait_for()
        self.assertIsNone(self.page.evaluate("sessionStorage.getItem('coi_pending_sub_connection')"))
        self.page.get_by_role('link', name='Back to home').click()
        self.assertIsNone(self.page.evaluate("sessionStorage.getItem('coi_pending_sub_connection')"))
        self.page.go_back()
        self.page.get_by_text('No valid connection code is available.', exact=False).wait_for()
        self.assertIsNone(self.page.evaluate("sessionStorage.getItem('coi_pending_sub_connection')"))
        self.assertFalse(self.redeems)

    def test_unmount_without_cancel_clears_pending_code(self):
        self.page.goto(self.origin + '/connect-sub#' + CODE)
        self.page.get_by_role('button', name='Cancel connection').wait_for()
        self.page.evaluate("history.pushState({}, '', '/'); window.dispatchEvent(new PopStateEvent('popstate'))")
        self.page.get_by_role('button', name='Cancel connection').wait_for(state='detached')
        self.page.go_back()
        self.page.get_by_text('No valid connection code is available.', exact=False).wait_for()
        self.assertFalse(self.redeems)

    def test_delayed_redemption_does_not_show_result_after_account_switch(self):
        self.context.add_init_script(f'localStorage.setItem("coi_token", {json.dumps(AUTH)})')
        self.page.goto(self.origin + '/connect-sub#' + CODE)
        self.page.get_by_role('button', name='Connect subcontractor').wait_for()
        self.page.evaluate('''() => {
          const realFetch = window.fetch;
          window.fetch = (...args) => {
            if (String(args[0]).endsWith('/api/connection-qr/redeem')) {
              window.redeemAuthorization = args[1].headers.Authorization;
              return new Promise(resolve => { window.finishRedeem = () => resolve(new Response(JSON.stringify({success:true, subcontractor:{id:'sub-1',company_name:'Previous Account Sub'}}), {status:200,headers:{'Content-Type':'application/json'}})) });
            }
            return realFetch(...args);
          };
        }''')
        self.page.get_by_role('button', name='Connect subcontractor').click()
        self.page.wait_for_function('window.finishRedeem !== undefined')
        self.assertEqual(self.page.evaluate('window.redeemAuthorization'), 'Bearer ' + AUTH)
        self.page.evaluate('''() => {
          localStorage.setItem('coi_token', 'second-gc-session');
          window.dispatchEvent(new StorageEvent('storage', {key:'coi_token', storageArea:localStorage}));
        }''')
        self.page.get_by_role('button', name='Connect subcontractor').wait_for()
        self.page.evaluate('window.finishRedeem()')
        self.page.wait_for_timeout(100)
        self.assertEqual(self.page.get_by_text('Previous Account Sub').count(), 0)
        self.assertIsNone(self.page.evaluate("sessionStorage.getItem('coi_pending_sub_connection')"))
        self.assertTrue(self.page.get_by_role('button', name='Connect subcontractor').is_visible())

    def test_bad_image_and_changed_session_cannot_redeem(self):
        self.load_gc_subs()
        self.upload(b'not an image')
        self.page.get_by_role('alert').get_by_text('Could not read this image', exact=False).wait_for()
        self.upload(self.qr_png('https://safecoi.com/connect-sub#' + CODE))
        self.page.get_by_text('Connection QR detected.', exact=False).wait_for()
        self.page.evaluate("localStorage.setItem('coi_token', 'different-session')")
        self.page.get_by_role('button', name='Connect subcontractor').click()
        self.page.wait_for_timeout(200)
        self.assertFalse(self.redeems)

    def test_reload_clears_abandoned_code(self):
        self.page.goto(self.origin + '/connect-sub#' + CODE)
        self.page.reload()
        self.assertIsNone(self.page.evaluate("sessionStorage.getItem('coi_pending_sub_connection')"))
        self.assertEqual(urlsplit(self.page.url).fragment, '')
        self.page.get_by_text('No valid connection code is available.', exact=False).wait_for()
        self.assertFalse(self.redeems)

    def test_abandonment_before_react_mount_cannot_restore_code(self):
        # Boot captured a fragment but React has not mounted the destination yet.
        # Do not emit popstate: the existing '/' tree must stay mounted.
        self.page.goto(self.origin + '/')
        stored = self.page.evaluate('''async code => {
          const m = await import('/src/pages/ConnectSubPage.tsx');
          history.pushState({}, '', '/connect-sub#' + code);
          m.captureConnectionFragment();
          const stored = sessionStorage.getItem('coi_pending_sub_connection');
          window.dispatchEvent(new PageTransitionEvent('pagehide'));
          return stored;
        }''', CODE)
        self.assertIsNone(stored)
        self.page.reload()
        self.assertIsNone(self.page.evaluate("sessionStorage.getItem('coi_pending_sub_connection')"))
        self.page.get_by_text('No valid connection code is available.', exact=False).wait_for()
        self.assertFalse(self.redeems)

    def test_legacy_stored_code_is_removed_not_restored(self):
        self.page.goto(self.origin + '/')
        self.page.evaluate("code => sessionStorage.setItem('coi_pending_sub_connection', code)", CODE)
        self.page.goto(self.origin + '/connect-sub')
        self.page.get_by_text('No valid connection code is available.', exact=False).wait_for()
        self.assertIsNone(self.page.evaluate("sessionStorage.getItem('coi_pending_sub_connection')"))
        self.assertFalse(self.redeems)

    def test_pagehide_invalidates_inflight_login_and_restored_view(self):
        self.page.goto(self.origin + '/connect-sub#' + CODE)
        self.page.get_by_role('button', name='Sign in', exact=True).wait_for()
        self.page.evaluate('''() => {
          const realFetch = window.fetch;
          window.fetch = (...args) => {
            if (String(args[0]).endsWith('/api/auth/login')) {
              return new Promise(resolve => {
                window.finishLogin = () => resolve(new Response(JSON.stringify({token:'mock-gc-session', user:{id:'gc',email:'gc@example.invalid',name:'gc',role:'gc'}}), {status:200,headers:{'Content-Type':'application/json'}}));
              });
            }
            return realFetch(...args);
          };
        }''')
        self.sign_in()
        self.page.wait_for_function('window.finishLogin !== undefined')
        self.page.evaluate('''async () => {
          window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted:true}));
          window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}));
          window.finishLogin();
          await new Promise(resolve => setTimeout(resolve, 100));
        }''')
        self.page.get_by_text('No valid connection code is available.', exact=False).wait_for()
        self.assertIsNone(self.page.evaluate("localStorage.getItem('coi_token')"))
        self.assertIsNone(self.page.evaluate("sessionStorage.getItem('coi_pending_sub_connection')"))
        self.assertEqual(self.page.get_by_role('button', name='Connect subcontractor').count(), 0)
        self.assertFalse(self.redeems)

    def test_pagehide_clears_authenticated_restored_view_without_redeeming(self):
        self.context.add_init_script(f'localStorage.setItem("coi_token", {json.dumps(AUTH)})')
        self.page.goto(self.origin + '/connect-sub#' + CODE)
        self.page.get_by_role('button', name='Connect subcontractor').wait_for()
        self.page.evaluate('''() => {
          window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted:true}));
          window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}));
        }''')
        self.page.get_by_text('No valid connection code is available.', exact=False).wait_for()
        self.assertEqual(self.page.get_by_role('button', name='Connect subcontractor').count(), 0)
        self.assertFalse(self.redeems)

    def test_inflight_login_after_in_app_abandonment_is_not_committed(self):
        self.page.goto(self.origin + '/connect-sub#' + CODE)
        self.page.get_by_role('button', name='Sign in', exact=True).wait_for()
        self.page.evaluate('''() => {
          const realFetch = window.fetch;
          window.fetch = (...args) => String(args[0]).endsWith('/api/auth/login')
            ? new Promise(resolve => { window.finishLogin = () => resolve(new Response(JSON.stringify({token:'mock-gc-session',user:{id:'gc',email:'gc@example.invalid',name:'gc',role:'gc'}}), {status:200,headers:{'Content-Type':'application/json'}})); })
            : realFetch(...args);
        }''')
        self.sign_in()
        self.page.wait_for_function('window.finishLogin !== undefined')
        self.page.evaluate('''async () => {
          history.pushState({key:'home'}, '', '/');
          window.dispatchEvent(new PopStateEvent('popstate'));
          window.finishLogin();
          await new Promise(resolve => setTimeout(resolve, 100));
        }''')
        self.assertIsNone(self.page.evaluate("localStorage.getItem('coi_token')"))
        self.page.go_back()
        self.page.get_by_text('No valid connection code is available.', exact=False).wait_for()
        self.assertFalse(self.redeems)

    def test_replacing_page_with_new_qr_keeps_only_new_code(self):
        next_code = 'B' * 43
        self.context.add_init_script(f'localStorage.setItem("coi_token", {json.dumps(AUTH)})')
        self.page.goto(self.origin + '/connect-sub#' + CODE)
        self.page.get_by_role('button', name='Connect subcontractor').wait_for()
        self.page.evaluate('''code => {
          history.pushState({key:'next-code'}, '', '/connect-sub#' + code);
          window.dispatchEvent(new PopStateEvent('popstate'));
        }''', next_code)
        self.page.wait_for_function("location.hash === ''")
        self.page.get_by_role('button', name='Connect subcontractor').click()
        self.page.get_by_role('status').get_by_text('Sample Plumbing').wait_for()
        self.assertEqual(self.redeems, [{'method':'POST', 'body':{'token':next_code}, 'auth':'Bearer ' + AUTH}])
        self.assertIsNone(self.page.evaluate("sessionStorage.getItem('coi_pending_sub_connection')"))

    def test_blocked_session_storage_still_allows_explicit_connection(self):
        self.context.add_init_script("Object.defineProperty(window, 'sessionStorage', {get() { throw new Error('blocked'); }});")
        self.page.goto(self.origin + '/connect-sub#' + CODE)
        self.sign_in()
        self.page.get_by_role('button', name='Connect subcontractor').click()
        self.page.get_by_role('status').get_by_text('Sample Plumbing').wait_for()
        self.assertEqual(self.redeems, [{'method':'POST', 'body':{'token':CODE}, 'auth':'Bearer ' + AUTH}])

    def test_pagehide_suppresses_response_to_already_submitted_redemption(self):
        self.context.add_init_script(f'localStorage.setItem("coi_token", {json.dumps(AUTH)})')
        self.page.goto(self.origin + '/connect-sub#' + CODE)
        self.page.get_by_role('button', name='Connect subcontractor').wait_for()
        self.page.evaluate('''() => {
          const realFetch = window.fetch;
          window.fetch = (...args) => String(args[0]).endsWith('/api/connection-qr/redeem')
            ? new Promise(resolve => { window.finishRedeem = () => resolve(new Response(JSON.stringify({success:true,subcontractor:{id:'sub-1',company_name:'Late Sub'}}), {status:200,headers:{'Content-Type':'application/json'}})); })
            : realFetch(...args);
        }''')
        self.page.get_by_role('button', name='Connect subcontractor').click()
        self.page.wait_for_function('window.finishRedeem !== undefined')
        self.page.evaluate('''async () => {
          window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted:true}));
          window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}));
          window.finishRedeem();
          await new Promise(resolve => setTimeout(resolve, 100));
        }''')
        self.page.get_by_text('No valid connection code is available.', exact=False).wait_for()
        self.assertEqual(self.page.get_by_text('Late Sub').count(), 0)
        self.assertEqual(self.page.get_by_role('status').count(), 0)

    def test_immediate_reload_repeatedly_discards_code(self):
        for _ in range(10):
            self.page.goto(self.origin + '/connect-sub#' + CODE)
            self.page.reload()
            self.assertIsNone(self.page.evaluate("sessionStorage.getItem('coi_pending_sub_connection')"))
            self.assertEqual(urlsplit(self.page.url).fragment, '')
            self.page.get_by_text('No valid connection code is available.', exact=False).wait_for()
        self.assertFalse(self.redeems)

if __name__ == '__main__': unittest.main(verbosity=2)
