"""Offline mobile sign-in/MFA regressions; no server or external network.

Run: python3 client/tests/test_login_mfa.py
Requires Python Playwright and Chromium (CHROME_BIN can override /usr/bin/chromium).
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import unittest
from urllib.request import urlopen

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
ADMIN = {'id': 'admin-test', 'email': 'admin@example.invalid', 'name': 'Test Admin', 'role': 'admin'}


class LoginMfaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            cls.port = sock.getsockname()[1]
        cls.origin = f'http://127.0.0.1:{cls.port}'
        cls.server = subprocess.Popen([str(ROOT / 'node_modules/.bin/vite'), '--host', '127.0.0.1', '--port', str(cls.port), '--strictPort'], cwd=ROOT / 'client', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(100):
                try:
                    with urlopen(cls.origin, timeout=1):
                        break
                except Exception:
                    time.sleep(.1)
            else:
                raise RuntimeError('Vite did not start')
            cls.playwright = sync_playwright().start()
            cls.browser = cls.playwright.chromium.launch(executable_path=os.environ.get('CHROME_BIN', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
        except BaseException:
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
        self.context = self.browser.new_context(viewport={'width': 320, 'height': 740})
        self.page = self.context.new_page()
        self.enrolled = True
        self.malformed = False
        self.verify_calls = []
        self.enroll_calls = []
        self.page.route('**/*', self.route)

    def tearDown(self):
        self.context.close()

    def route(self, route):
        req = route.request
        url = req.url
        path = url.split('?', 1)[0]
        payload, status = None, 200
        if path.endswith('/api/auth/login'):
            payload = {'token': 'unverified', 'user': ADMIN} if self.malformed else {'mfa_required': True, 'challenge_token': 'challenge-only', 'enrolled': self.enrolled}
        elif path.endswith('/api/auth/admin-mfa/enroll'):
            self.enroll_calls.append(req.headers.get('authorization'))
            payload = {'secret': 'SYNTHETIC', 'otp_uri': 'otpauth://totp/test?secret=SYNTHETIC'}
        elif path.endswith('/api/auth/admin-mfa/verify'):
            self.verify_calls.append((req.headers.get('authorization'), req.post_data_json))
            if req.post_data_json['code'] == '123456':
                payload = {'token': 'verified-admin', 'user': ADMIN}
            else:
                status, payload = 401, {'error': 'Invalid authenticator code'}
        elif path.endswith('/api/auth/me'):
            if req.headers.get('authorization') == 'Bearer verified-admin':
                payload = {'user': ADMIN}
            else:
                status, payload = 401, {'error': 'Not signed in'}
        elif '/api/' in path:
            status, payload = 404, {'error': 'Mock endpoint not found'}
        if payload is not None:
            return route.fulfill(status=status, content_type='application/json', body=json.dumps(payload))
        if url.startswith(self.origin):
            return route.continue_()
        return route.abort()

    def open_login(self):
        self.page.goto(self.origin + '/login')
        self.page.get_by_role('heading', name='Sign in to your account').wait_for()

    def submit_password(self):
        self.page.get_by_label('Email').fill('admin@example.invalid')
        self.page.get_by_label('Password').fill('not-a-real-password')
        self.page.get_by_role('button', name='Sign in', exact=True).click()

    def assert_no_session(self):
        self.assertIsNone(self.page.evaluate('localStorage.getItem("coi_token")'))
        self.assertIsNone(self.page.evaluate('localStorage.getItem("coi_user")'))

    def test_mobile_registration_controls(self):
        self.open_login()
        self.assertEqual(self.page.get_by_label('Email').evaluate('(e) => getComputedStyle(e).fontSize'), '16px')
        self.assertEqual(self.page.evaluate('document.documentElement.scrollWidth <= innerWidth'), True)
        self.page.get_by_role('button', name='Need an account? Register').click()
        self.assertEqual(self.page.get_by_role('button', name='General Contractor').get_attribute('aria-pressed'), 'true')
        self.page.get_by_role('button', name='Subcontractor', exact=True).click()
        self.assertEqual(self.page.get_by_role('button', name='Subcontractor', exact=True).get_attribute('aria-pressed'), 'true')
        self.assertEqual(self.page.get_by_label('Password').get_attribute('autocomplete'), 'new-password')
        self.assertEqual(self.page.evaluate('document.documentElement.scrollWidth <= innerWidth'), True)
        self.page.get_by_role('button', name='Have an account? Sign in').click()
        self.assertEqual(self.page.get_by_label('Password').get_attribute('autocomplete'), 'current-password')

    def test_admin_verification_requires_valid_code_before_session(self):
        self.open_login()
        self.submit_password()
        self.page.get_by_role('heading', name='Administrator verification').wait_for()
        self.assert_no_session()
        self.assertEqual(self.page.get_by_role('button', name='Need an account? Register').count(), 0)
        self.page.get_by_label('Authenticator code').fill('000000')
        self.page.get_by_role('button', name='Verify and sign in').click()
        self.page.get_by_role('alert').get_by_text('Invalid authenticator code').wait_for()
        self.assert_no_session()
        self.assertEqual(self.verify_calls[-1], ('Bearer challenge-only', {'code': '000000'}))
        self.page.get_by_label('Authenticator code').fill('123456')
        self.page.get_by_role('button', name='Verify and sign in').click()
        self.page.wait_for_url('**/staff')
        self.assertEqual(self.page.evaluate('localStorage.getItem("coi_token")'), 'verified-admin')
        self.assertEqual(self.verify_calls[-1], ('Bearer challenge-only', {'code': '123456'}))

    def test_enrollment_and_return_to_sign_in(self):
        self.enrolled = False
        self.open_login()
        self.submit_password()
        self.page.get_by_role('heading', name='Set up an authenticator app').wait_for()
        self.page.get_by_text('SYNTHETIC', exact=True).wait_for()
        self.assertEqual(self.enroll_calls, ['Bearer challenge-only'])
        self.assert_no_session()
        self.page.get_by_role('button', name='Return to sign in').click()
        self.page.get_by_role('heading', name='Sign in to your account').wait_for()
        self.assertEqual(self.page.get_by_label('Password').input_value(), '')
        self.assert_no_session()

    def test_reject_admin_session_without_challenge(self):
        self.malformed = True
        self.open_login()
        self.submit_password()
        self.page.get_by_role('alert').get_by_text('Administrator verification was not offered.', exact=False).wait_for()
        self.assert_no_session()
        self.assertEqual(self.page.evaluate('location.pathname'), '/login')


if __name__ == '__main__':
    unittest.main(verbosity=2)
