"""Isolated browser regressions for login and stale session responses.

Run from the repository root: python3 client/tests/test_login_session.py
Requires Python Playwright, Chromium (CHROME_BIN overrides /usr/bin/chromium),
and the project's installed Node dependencies. A local Vite server is started
with configFile=false, no API proxy, and no HMR. Every browser HTTP request is
intercepted: same-origin API calls are mocked, all other nonlocal URLs blocked.
No backend, production service, database, or real credentials are used.
"""
import json
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
USERS = {role: {'id': f'user-{role}', 'email': f'{role}@example.invalid',
                'name': f'Test {role}', 'role': role} for role in ('gc', 'sub', 'admin')}
HOMES = {'gc': ('/dashboard', 'Dashboard'),
         'sub': ('/subcontractor', 'Mock Subcontractor'),
         'admin': ('/staff', 'Staff')}
TOKEN = 'mock-new-token'
OLD_TOKEN = 'mock-old-token'
OLD_USER = {'id': 'old-user', 'email': 'old@example.invalid', 'name': 'Old User', 'role': 'sub'}
MOCK_EMAIL = 'fixture@example.invalid'
MOCK_PASSWORD = 'not-a-real-password'
STATS = {'totals': {'total': 0, 'compliant': 0, 'expiring': 0, 'expired': 0,
                    'missing': 0, 'pending': 0, 'score': 0},
         'projects_count': 0, 'share_links_count': 0, 'trades': [], 'upcoming': []}
OVERVIEW = {'users': {'total': 0, 'new_this_month': 0, 'admins': 0, 'gcs': 0},
            'revenue': {'mrr': 0, 'arr': 0, 'paying_subscribers': 0, 'arpu': 0,
                        'plan_breakdown': [], 'available_plans': []},
            'platform': {'companies': 0, 'subcontractors': 0, 'cois': 0,
                         'client_share_links': 0, 'pending_reviews': 0, 'verified_cois': 0},
            'growth': []}


class LoginSessionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            cls.port = sock.getsockname()[1]
        cls.origin = f'http://127.0.0.1:{cls.port}'
        # No project vite.config.ts means no /api or /uploads backend proxy, even
        # if an interception is missed; this server only serves frontend files.
        server_js = '''
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const server = await createServer({configFile:false, root:process.cwd(),
  plugins:[react()], server:{host:'127.0.0.1',port:Number(process.argv[1]),
  strictPort:true,hmr:false,proxy:{}}, logLevel:'error'});
await server.listen();
'''
        cls.server = subprocess.Popen(['node', '--input-type=module', '-e', server_js, str(cls.port)],
                                      cwd=ROOT / 'client', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(100):
                if cls.server.poll() is not None:
                    raise RuntimeError('Isolated Vite server exited during startup')
                try:
                    with urlopen(cls.origin, timeout=1):
                        break
                except Exception:
                    time.sleep(.1)
            else:
                raise RuntimeError('Isolated Vite server did not start')
            cls.playwright = sync_playwright().start()
            cls.browser = cls.playwright.chromium.launch(
                executable_path=os.environ.get('CHROME_BIN', '/usr/bin/chromium'),
                headless=True, args=['--no-sandbox'])
        except Exception:
            cls.server.terminate()
            cls.server.wait(timeout=5)
            raise

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.terminate()
        cls.server.wait(timeout=5)

    def setUp(self):
        self.context = self.browser.new_context(service_workers='block')
        self.context.route('**/*', self.route)
        # A routed WebSocket does not connect to a server unless explicitly
        # connected; leave it mocked rather than calling the blocking close API.
        self.context.route_web_socket('**/*', lambda ws: None)
        self.page = self.context.new_page()
        self.role = 'gc'
        self.login_status = 200
        self.new_me_mode = 'success'  # success, hold, or transient
        self.hold_old_me = False
        self.held_old = []
        self.held_new = []
        self.seen = []
        self.login_requests = []
        self.unknown_api = []
        self.page_errors = []
        self.page.on('pageerror', lambda error: self.page_errors.append(str(error)))

    def close_context_and_assert(self):
        self.context.close()
        self.assertFalse(self.unknown_api, f'Unexpected API calls (blocked, not proxied): {self.unknown_api}')
        self.assertFalse(self.page_errors, f'Uncaught browser exceptions: {self.page_errors}')

    def tearDown(self):
        self.close_context_and_assert()

    @staticmethod
    def reply(route, payload, status=200):
        route.fulfill(status=status, content_type='application/json', body=json.dumps(payload))

    def route(self, route):
        request = route.request
        url = urlsplit(request.url)
        if f'{url.scheme}://{url.netloc}' != self.origin:
            return route.abort()  # Block all remote origins, including font CDNs.
        path = url.path
        if not path.startswith('/api/'):
            return route.continue_()  # This Vite server has no backend proxy.
        auth = request.headers.get('authorization', '')
        self.seen.append((request.method, path, auth))
        if path == '/api/auth/login':
            self.login_requests.append((request.method, auth, request.post_data_json))
            if self.login_status == 401:
                return self.reply(route, {'error': 'Invalid email or password'}, 401)
            return self.reply(route, {'token': TOKEN, 'user': USERS[self.role]})
        if path == '/api/auth/me':
            if auth == f'Bearer {OLD_TOKEN}' and self.hold_old_me:
                self.held_old.append(route)
                return
            if auth == f'Bearer {TOKEN}':
                if self.new_me_mode == 'hold':
                    self.held_new.append(route)
                    return
                if self.new_me_mode == 'transient':
                    return self.reply(route, {'error': 'Temporary server error'}, 503)
                return self.reply(route, {'user': USERS[self.role]})
            return self.reply(route, {'error': 'Unauthorized'}, 401)
        payloads = {
            '/api/stats': STATS,
            '/api/subcontractors': {'subcontractors': []},
            '/api/cois': {'cois': []},
            '/api/settings': {'settings': {'expiration_warning_days': 30}},
            '/api/sub/my': {'subcontractor': {'id': 'fixture-sub', 'company_name': 'Mock Subcontractor', 'trade': 'Test', 'cois': []},
                            'cois': [], 'requests': [], 'connected_gcs': [], 'public_share_url': '/sub/share/fixture'},
            '/api/sub/sent-emails': {'emails': []},
            '/api/admin/overview': OVERVIEW,
            '/api/admin/companies': {'companies': []},
            '/api/admin/users': {'users': []},
        }
        if path in payloads:
            return self.reply(route, payloads[path])
        self.unknown_api.append((request.method, path))
        return self.reply(route, {'error': 'Unexpected mocked API request'}, 501)

    def seed_old_token(self):
        self.page.add_init_script(f'localStorage.setItem("coi_token", {json.dumps(OLD_TOKEN)}); localStorage.removeItem("coi_user");')

    def start(self):
        self.page.goto(self.origin + '/login', wait_until='domcontentloaded')
        self.page.get_by_role('heading', name='Sign in to your account').wait_for(timeout=10000)

    def sign_in(self):
        self.page.get_by_label('Email', exact=True).fill(MOCK_EMAIL)
        self.page.get_by_label('Password', exact=True).fill(MOCK_PASSWORD)
        self.page.get_by_role('button', name='Sign in', exact=True).click()

    def assert_session(self, role):
        path, heading = HOMES[role]
        self.page.wait_for_url(self.origin + path, timeout=5000)
        self.page.get_by_role('heading', name=heading, exact=True).first.wait_for(timeout=5000)
        self.assertEqual(self.page.evaluate('localStorage.getItem("coi_token")'), TOKEN)
        self.assertEqual(self.page.evaluate('JSON.parse(localStorage.getItem("coi_user"))'), USERS[role])

    def release(self, routes, payload, status=200):
        while routes:
            self.reply(routes.pop(0), payload, status)
        # Let fetch promise continuations and React updates run after responses.
        self.page.wait_for_timeout(350)

    def test_successful_login_navigates_by_role_without_waiting_for_me(self):
        for role in ('gc', 'sub', 'admin'):
            with self.subTest(role=role):
                # Each role gets its own empty browser storage.
                if role != 'gc':
                    self.close_context_and_assert()
                    self.setUp()
                self.role = role
                self.new_me_mode = 'hold'
                self.start()
                self.sign_in()
                self.assert_session(role)
                self.assertEqual(self.login_requests, [('POST', '', {'email': MOCK_EMAIL, 'password': MOCK_PASSWORD})])
                if role == 'admin':
                    deadline = time.monotonic() + 5
                    while not self.held_new and time.monotonic() < deadline:
                        self.page.wait_for_timeout(50)
                    self.assertTrue(self.held_new, 'Expected admin dashboard /me request to be held')
                self.release(self.held_new, {'user': USERS[role]})
                self.assert_session(role)

    def test_invalid_credentials_stay_on_login_and_show_error(self):
        self.login_status = 401
        self.start()
        self.sign_in()
        self.page.get_by_role('alert').get_by_text('Invalid email or password').wait_for(timeout=5000)
        self.assertEqual(urlsplit(self.page.url).path, '/login')
        self.assertIsNone(self.page.evaluate('localStorage.getItem("coi_token")'))
        self.assertIsNone(self.page.evaluate('localStorage.getItem("coi_user")'))
        self.assertEqual(self.login_requests, [('POST', '', {'email': MOCK_EMAIL, 'password': MOCK_PASSWORD})])

    def test_stale_initial_me_must_not_override_newer_login(self):
        for status, payload in ((401, {'error': 'Old session expired'}), (200, {'user': OLD_USER})):
            with self.subTest(stale_status=status):
                if status == 200:
                    self.close_context_and_assert()
                    self.setUp()
                self.role = 'gc'
                self.hold_old_me = True
                self.seed_old_token()
                self.page.goto(self.origin + '/login', wait_until='domcontentloaded')
                # StrictMode issues two startup checks. Resolve the latest with
                # a temporary error, switch accounts and sign in while the
                # earlier startup check remains pending.
                deadline = time.monotonic() + 5
                while len(self.held_old) < 2 and time.monotonic() < deadline:
                    self.page.wait_for_timeout(50)
                self.assertGreaterEqual(len(self.held_old), 2, 'Race setup requires two boot-time checks (React StrictMode)')
                self.page.get_by_text('Checking your session…').wait_for(timeout=5000)
                self.reply(self.held_old.pop(), {'error': 'Temporary server error'}, 503)
                self.page.get_by_role('button', name='Switch account').click(timeout=5000)
                self.page.get_by_role('heading', name='Sign in to your account').wait_for(timeout=5000)
                self.sign_in()
                self.assert_session('gc')
                self.assertEqual(self.login_requests, [('POST', '', {'email': MOCK_EMAIL, 'password': MOCK_PASSWORD})])
                self.release(self.held_old, payload, status)
                self.assert_session('gc')

    def test_transient_initial_me_failure_preserves_token_and_retry_recovers(self):
        self.role = 'gc'
        self.new_me_mode = 'transient'
        self.page.add_init_script(f'localStorage.setItem("coi_token", {json.dumps(TOKEN)});')
        self.page.goto(self.origin + '/login', wait_until='domcontentloaded')
        self.page.get_by_role('alert').get_by_text('Could not verify your session:', exact=False).wait_for(timeout=5000)
        self.assertEqual(self.page.evaluate('localStorage.getItem("coi_token")'), TOKEN)
        self.new_me_mode = 'success'
        self.page.get_by_role('button', name='Retry').click()
        self.assert_session('gc')
        self.assertGreaterEqual(sum(path == '/api/auth/me' and auth == f'Bearer {TOKEN}' for _, path, auth in self.seen), 2)


if __name__ == '__main__':
    unittest.main(verbosity=2)
