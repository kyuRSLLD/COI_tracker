"""Mocked, offline browser tests: python3 client/tests/test_upload_portal.py.

All API calls are intercepted in the browser; no application server or production
credentials are used. Requires Python Playwright, Chromium and client dependencies.
"""
import json
import os
from email import policy
from email.parser import BytesParser
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from urllib.parse import urlsplit
from urllib.request import urlopen

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
TOKEN = 'synthetic-upload-token'
VALIDATION = {
    'subcontractor': {'company_name': 'Synthetic Electrical Co', 'trade': 'Electrical'},
    'gc': {'company_name': 'Synthetic GC'},
    'request': {'expires_at': '2036-01-01T12:00:00.000Z'},
}
PDF = b'%PDF-1.4\n% synthetic certificate\n%%EOF\n'


def multipart(request):
    header = f"Content-Type: {request.headers['content-type']}\r\nMIME-Version: 1.0\r\n\r\n".encode()
    message = BytesParser(policy=policy.default).parsebytes(header + request.post_data_buffer)
    return {part.get_param('name', header='content-disposition'): {
        'filename': part.get_filename(), 'body': part.get_payload(decode=True),
    } for part in message.iter_parts()}


class UploadPortalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='upload-portal-test-')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        cls.origin = f'http://127.0.0.1:{port}'
        # No inherited database, cloud or application secrets.
        node = shutil.which('node')
        if not node:
            raise RuntimeError('Node is required to start Vite')
        env = {'PATH': str(Path(node).parent) + ':/usr/local/bin:/usr/bin:/bin', 'HOME': cls.temp.name}
        cls.server = subprocess.Popen(
            [str(ROOT / 'node_modules/.bin/vite'), '--host', '127.0.0.1', '--port', str(port), '--strictPort'],
            cwd=ROOT / 'client', env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            for _ in range(100):
                try:
                    with urlopen(cls.origin, timeout=1):
                        break
                except Exception:
                    time.sleep(.1)
            else:
                raise RuntimeError('Vite did not start')
            cls.pw = sync_playwright().start()
            cls.browser = cls.pw.chromium.launch(
                executable_path=os.environ.get('CHROME_BIN', '/usr/bin/chromium'), headless=True,
                args=['--no-sandbox', '--disable-background-networking',
                      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
            )
        except Exception:
            cls.cleanup()
            raise

    @classmethod
    def cleanup(cls):
        if hasattr(cls, 'browser'):
            cls.browser.close()
        if hasattr(cls, 'pw'):
            cls.pw.stop()
        if hasattr(cls, 'server'):
            cls.server.terminate()
            cls.server.wait(timeout=5)
        if hasattr(cls, 'temp'):
            cls.temp.cleanup()

    @classmethod
    def tearDownClass(cls):
        cls.cleanup()

    def setUp(self):
        self.context = self.browser.new_context(service_workers='block', viewport={'width': 1280, 'height': 900})
        self.addCleanup(self.context.close)
        self.context.route('**/*', self.route)
        self.page = self.context.new_page()
        self.page.set_default_timeout(8000)
        self.calls = []
        self.forms = []
        self.used = False
        self.invalid = False
        self.fail_submit = False
        self.validation = json.loads(json.dumps(VALIDATION))

    def route(self, route):
        req = route.request
        url = urlsplit(req.url)
        if req.url.startswith(self.origin + '/api/'):
            self.calls.append((req.method, url.path, req.headers.get('authorization')))
            if url.path == f'/api/upload/validate/{TOKEN}' and req.method == 'GET':
                if self.used or self.invalid:
                    return route.fulfill(status=410, json={'error': 'This upload link has already been used. Please ask for a new link.'})
                return route.fulfill(json=self.validation)
            if url.path == f'/api/upload/submit/{TOKEN}' and req.method == 'POST':
                self.forms.append(multipart(req))
                if self.fail_submit:
                    return route.fulfill(status=500, json={'error': 'Unable to submit certificate. Please ask for a new link.'})
                if self.used:
                    return route.fulfill(status=410, json={'error': 'This upload link has already been used. Please ask for a new link.'})
                self.used = True
                return route.fulfill(json={'success': True, 'coi': {'status': 'pending_review'}})
            # Unrecognized API requests are never forwarded to Vite's proxy.
            return route.fulfill(status=404, json={'error': 'Unexpected test API request'})
        if req.url.startswith(self.origin + '/'):
            return route.continue_()
        return route.abort()

    def open(self):
        self.page.goto(f'{self.origin}/upload/{TOKEN}')
        self.page.get_by_role('heading', name='Upload your COI').wait_for()

    def policy_step(self):
        self.page.get_by_role('button', name='Next: policy info').click()
        self.page.get_by_role('heading', name='Policy information').wait_for()

    def fill_policy(self):
        self.page.get_by_label('Insurance carrier *').fill('Synthetic Carrier')
        self.page.get_by_label('Effective date *').fill('2026-01-01')
        self.page.get_by_label('Expiration date *').fill('2027-01-01')

    def advance_to_review(self, attach=True):
        self.page.get_by_role('button', name='Next: certificate file').click()
        if attach:
            self.page.locator('input[type=file]').set_input_files({
                'name': 'synthetic.pdf', 'mimeType': 'application/pdf', 'buffer': PDF,
            })
        self.page.get_by_role('button', name='Next: review').click()
        self.page.get_by_role('heading', name='Review & submit').wait_for()

    def test_minimal_response_blank_fields_and_successful_file_upload(self):
        self.open()
        body = self.page.locator('body').inner_text()
        self.assertIn('Synthetic GC', body)
        self.assertIn('2036-01-01T12:00:00.000Z', body)
        self.assertIn('Requirements are not included in this link', body)
        for fabricated in ['$1M', '$2M', '$5M', 'Statutory', 'project standard', 'Renewal reminders', 'View all submissions']:
            self.assertNotIn(fabricated, body)
        readonly = self.page.locator('input[readonly]')
        self.assertEqual(readonly.count(), 2)
        self.assertEqual(readonly.nth(0).input_value(), 'Synthetic Electrical Co')
        self.assertEqual(readonly.nth(1).input_value(), 'Electrical')
        self.assertIn('not subcontractor profile or contact changes', body)
        self.policy_step()
        self.assertEqual(self.page.get_by_label('Effective date *').input_value(), '')
        self.assertEqual(self.page.get_by_label('Expiration date *').input_value(), '')
        self.assertTrue(self.page.get_by_role('button', name='Next: certificate file').is_disabled())
        for field in self.page.get_by_placeholder('Per occurrence').all() + self.page.get_by_placeholder('Aggregate').all():
            self.assertEqual(field.input_value(), '')
        for checkbox in self.page.get_by_role('checkbox').all():
            self.assertFalse(checkbox.is_checked())
        self.fill_policy()
        self.advance_to_review()
        self.assertIn('synthetic.pdf', self.page.locator('body').inner_text())
        self.page.get_by_role('button', name='Submit certificate').click()
        self.page.get_by_role('heading', name='Submission received — thank you!').wait_for()
        text = self.page.locator('body').inner_text()
        self.assertIn('pending GC review', text)
        self.assertIn('only once', text)
        self.assertNotIn('View all submissions', text)
        self.assertNotIn('confirmation email', text)
        self.assertEqual(len(self.forms), 1)
        form = self.forms[0]
        self.assertEqual(json.loads(form['coverages']['body']), [])
        self.assertEqual(form['certificate']['filename'], 'synthetic.pdf')
        self.assertEqual(form['certificate']['body'], PDF)
        self.assertEqual(form['carrier']['body'], b'Synthetic Carrier')
        self.assertEqual(form['effective_date']['body'], b'2026-01-01')
        self.assertEqual(form['expiration_date']['body'], b'2027-01-01')
        self.assertEqual(set(form), {'carrier', 'am_best_rating', 'policy_number', 'effective_date', 'expiration_date', 'coverages', 'certificate'})
        self.assertTrue(all(auth is None for _, _, auth in self.calls))
        self.assertGreaterEqual(sum(method == 'GET' and path == f'/api/upload/validate/{TOKEN}' for method, path, _ in self.calls), 1)
        self.assertEqual(sum(method == 'POST' and path == f'/api/upload/submit/{TOKEN}' for method, path, _ in self.calls), 1)
        self.assertTrue(all(path in (f'/api/upload/validate/{TOKEN}', f'/api/upload/submit/{TOKEN}') for _, path, _ in self.calls))
        self.assertNotIn(TOKEN, text)
        self.page.reload()
        self.page.get_by_role('heading', name='Invalid upload link').wait_for()
        self.assertIn('already been used', self.page.locator('body').inner_text())
        self.assertFalse(any('/api/upload/my/' in path for _, path, _ in self.calls))

    def test_explicit_coverage_is_submitted_without_other_lines(self):
        self.open()
        self.policy_step()
        self.fill_policy()
        self.page.get_by_placeholder('Per occurrence').nth(0).fill('$250,000')
        self.page.get_by_placeholder('Aggregate').nth(0).fill('$500,000')
        self.page.get_by_role('checkbox', name='Additional Insured').nth(0).check()
        self.advance_to_review(attach=False)
        self.assertIn('None (you can still submit)', self.page.locator('body').inner_text())
        self.page.get_by_role('button', name='Submit certificate').click()
        self.page.get_by_role('heading', name='Submission received — thank you!').wait_for()
        self.assertNotIn('certificate', self.forms[0])
        self.assertEqual(json.loads(self.forms[0]['coverages']['body']), [{
            'type': 'General Liability', 'per_occurrence_limit': '$250,000',
            'aggregate_limit': '$500,000', 'additional_insured': True, 'waiver_of_subrogation': False,
        }])

    def test_submission_error_does_not_claim_success_or_destroy_form(self):
        self.open()
        self.policy_step()
        self.fill_policy()
        self.advance_to_review()
        self.fail_submit = True
        self.page.get_by_role('button', name='Submit certificate').click()
        self.page.get_by_role('alert').wait_for()
        self.assertIn('Please ask for a new link', self.page.get_by_role('alert').inner_text())
        self.assertEqual(self.page.get_by_role('heading', name='Invalid upload link').count(), 0)
        self.assertEqual(self.page.get_by_role('heading', name='Submission received — thank you!').count(), 0)
        self.assertIn('synthetic.pdf', self.page.locator('body').inner_text())
        self.assertFalse(any('/api/upload/my/' in path for _, path, _ in self.calls))

    def test_invalid_link_and_missing_optional_trade_and_expiry(self):
        self.validation['subcontractor']['trade'] = None
        self.validation['request']['expires_at'] = None
        self.open()
        self.assertEqual(self.page.locator('input[readonly]').nth(1).input_value(), '')
        self.assertNotIn('Link expires:', self.page.locator('body').inner_text())
        self.invalid = True
        self.page.reload()
        self.page.get_by_role('heading', name='Invalid upload link').wait_for()
        self.assertIn('already been used', self.page.locator('body').inner_text())
        self.assertFalse(any('/api/upload/my/' in path for _, path, _ in self.calls))


if __name__ == '__main__':
    unittest.main()
