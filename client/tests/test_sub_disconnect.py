"""Offline dashboard tests: python3 client/tests/test_sub_disconnect.py."""
import json
import os
from pathlib import Path
from datetime import datetime, timedelta, timezone
import socket
import subprocess
import time
import unittest
from urllib.request import urlopen
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
USER = {'id': 'sub1', 'email': 'sub@example.invalid', 'name': 'Sub', 'role': 'sub'}
SUB = {'id': 'profile1', 'company_name': 'Test Sub', 'trade': 'Testing'}
GC = {'gc_id': 'gc1', 'company_name': 'Test Contractor', 'email': 'gc@example.invalid'}
COIS = [
    {'id': 'c1', 'carrier': 'Missing Expiration', 'policy_number': None, 'effective_date': '', 'expiration_date': '', 'status': 'pending_review', 'coverages': []},
    {'id': 'c2', 'carrier': 'Invalid Expiration', 'policy_number': None, 'effective_date': '', 'expiration_date': 'not-a-date', 'status': 'pending_review', 'coverages': []},
    {'id': 'c3', 'carrier': 'Malformed Expiration', 'policy_number': None, 'effective_date': '', 'expiration_date': '2026-02-30', 'status': 'pending_review', 'coverages': []},
]

class SubDisconnectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        cls.origin = f'http://127.0.0.1:{port}'
        cls.server = subprocess.Popen([str(ROOT / 'node_modules/.bin/vite'), '--host', '127.0.0.1', '--port', str(port), '--strictPort'], cwd=ROOT / 'client', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                with urlopen(cls.origin, timeout=1):
                    break
            except Exception:
                time.sleep(.1)
        else:
            cls.server.terminate()
            raise RuntimeError('Vite did not start')
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(executable_path=os.environ.get('CHROME_BIN', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.server.terminate()
        cls.server.wait(timeout=5)

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 390, 'height': 844})
        self.page = self.context.new_page()
        self.connections = [GC.copy()]
        self.calls = []
        self.status = 200
        self.availability = True
        self.page.route('**/*', self.route)
        self.page.add_init_script(f"localStorage.setItem('coi_user', {json.dumps(json.dumps(USER))}); localStorage.setItem('coi_token', 'session-1');")
        self.page.goto(self.origin + '/subcontractor')
        self.panel = self.page.get_by_role('region', name='Connected general contractors')
        self.panel.get_by_text('Test Contractor').wait_for()

    def tearDown(self):
        self.context.close()

    def route(self, route):
        req = route.request
        url = req.url.split('?', 1)[0]
        if url.endswith('/api/auth/me'):
            return route.fulfill(json={'user': USER})
        if url.endswith('/api/sub/my'):
            data = {'subcontractor': SUB, 'cois': COIS, 'requests': [], 'connected_gcs': self.connections, 'public_share_url': '/none'}
            if self.availability is not None:
                data['disconnect_available'] = self.availability
            return route.fulfill(json=data)
        if url.endswith('/api/connection-qr') and req.method == 'POST':
            expires = (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat()
            return route.fulfill(json={'token': 'a' * 43, 'expiresAt': expires})
        if url.endswith('/api/sub/connections/gc1') and req.method == 'DELETE':
            self.calls.append((req.method, req.headers.get('authorization')))
            if self.status == 200:
                self.connections = []
                return route.fulfill(json={'success': True})
            if self.status == 503:
                return route.fulfill(status=503, json={'error': 'Removing connections is temporarily unavailable. Please try again later.', 'code': 'CONNECTION_REMOVAL_UNAVAILABLE'})
            return route.fulfill(status=self.status, json={'error': 'Removal failed'})
        if req.url.startswith(self.origin):
            return route.continue_()
        return route.abort()

    def test_confirmation_cancel_success_and_expiration(self):
        self.assertEqual(self.page.get_by_text('Expiration not provided', exact=False).count(), 6)
        self.assertNotIn('NaNd', self.page.locator('body').inner_text())
        messages = []
        def cancel(dialog):
            messages.append(dialog.message)
            dialog.dismiss()
        self.page.once('dialog', cancel)
        self.panel.get_by_role('button', name='Remove connection to Test Contractor').click()
        self.assertEqual(self.calls, [])
        self.assertIn('files already downloaded cannot be recalled', messages[0])
        self.assertIn('cancel all your unused connection codes', messages[0])
        share = self.page.get_by_role('region', name='Share with a general contractor')
        share.get_by_role('checkbox').check()
        share.get_by_role('button', name='Generate QR code').click()
        share.get_by_role('img', name='QR code to connect one general contractor').wait_for()
        self.page.once('dialog', lambda dialog: dialog.accept())
        self.panel.get_by_role('button', name='Remove connection to Test Contractor').click()
        self.panel.get_by_text('No connected general contractors.').wait_for()
        self.assertEqual(share.locator('canvas').count(), 0)
        self.assertTrue(share.get_by_role('button', name='Generate QR code').is_disabled())
        self.assertEqual(self.calls, [('DELETE', 'Bearer session-1')])

    def test_failure_leaves_connection_visible(self):
        self.status = 500
        self.page.once('dialog', lambda dialog: dialog.accept())
        self.panel.get_by_role('button', name='Remove connection to Test Contractor').click()
        self.page.get_by_text('Removal failed').wait_for()
        self.assertTrue(self.panel.get_by_text('Test Contractor').is_visible())

    def test_account_change_between_display_and_confirmation_is_rejected(self):
        # Set storage before confirming, simulating another tab changing identity.
        self.page.evaluate("localStorage.setItem('coi_token', 'session-2')")
        self.page.once('dialog', lambda dialog: dialog.accept())
        self.panel.get_by_role('button', name='Remove connection to Test Contractor').click()
        # The session-change event immediately unmounts the old dashboard.
        self.page.wait_for_timeout(500)
        self.assertEqual(self.calls, [])

    def test_paused_and_missing_availability_fail_closed_without_blocking_qr(self):
        for availability in (False, None):
            self.availability = availability
            self.page.reload()
            button = self.panel.get_by_role('button', name='Remove connection to Test Contractor')
            button.wait_for()
            self.assertTrue(button.is_disabled())
            self.assertTrue(self.panel.get_by_text('Existing connections remain active', exact=False).is_visible())
            self.assertEqual(self.calls, [])
            share = self.page.get_by_role('region', name='Share with a general contractor')
            share.get_by_role('checkbox').check()
            share.get_by_role('button', name='Generate QR code').click()
            share.get_by_role('img', name='QR code to connect one general contractor').wait_for()

    def test_stale_available_flag_server_pause_disables_button(self):
        self.status = 503
        self.page.once('dialog', lambda dialog: dialog.accept())
        self.panel.get_by_role('button', name='Remove connection to Test Contractor').click()
        self.page.get_by_text('Removing connections is temporarily unavailable', exact=False).first.wait_for()
        self.assertTrue(self.panel.get_by_role('button', name='Remove connection to Test Contractor').is_disabled())
        self.assertTrue(self.panel.get_by_text('Test Contractor').is_visible())
        self.assertEqual(len(self.calls), 1)

if __name__ == '__main__':
    unittest.main()
