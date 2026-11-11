"""Offline browser regression tests.

Run from the repo root after installing frontend dependencies:
  python3 client/tests/test_certificate_viewer.py
Requires Python Playwright and Chromium (CHROME_BIN may override /usr/bin/chromium).
All APIs and certificate files are mocked; no server data or external network is used.
"""
import base64
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
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')


def pdf_bytes():
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
               b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
               b'<< /Length 53 >>\nstream\nBT /F1 18 Tf 40 100 Td (Test Certificate) Tj ET\nendstream',
               b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    out = b'%PDF-1.4\n'
    offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(out))
        out += f'{i} 0 obj\n'.encode() + obj + b'\nendobj\n'
    xref = len(out)
    out += f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode()
    out += b''.join(f'{offset:010d} 00000 n \n'.encode() for offset in offsets[1:])
    return out + f'trailer << /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()


def coi(name, url, mime, id):
    return {'id': id, 'carrier': name, 'certificate_name': name, 'certificate_url': url,
            'certificate_mime': mime, 'policy_number': 'POL', 'effective_date': '2026-01-01',
            'expiration_date': '2027-12-31', 'status': 'pending_review', 'coverages': []}


COIS = [
    coi('photo.png', '/test/photo.png', 'image/png', 'image'),
    coi('policy.PDF', 'https://signed-s3.invalid/policy?signature=test', 'application/pdf', 'pdf'),
    coi('missing.jpg', '/test/missing.jpg', 'image/jpeg', 'missing'),
    coi('document.html', '/test/document.html', 'text/html', 'html'),
    coi('unsafe.pdf', 'javascript:alert(1)', 'application/pdf', 'unsafe'),
    coi('fake.pdf', '/test/fake.pdf', 'application/pdf', 'fake'),
    coi('no-cors.pdf', 'https://no-cors.invalid/policy.pdf', 'application/pdf', 'no-cors'),
    coi('from-name.PDF', 'https://signed-s3.invalid/policy?signature=test', None, 'name'),
]
SUB = {'id': 'sub1', 'company_name': 'Acme Test', 'trade': 'Electrical', 'computed_status': 'pending_review', 'cois': COIS, 'upload_requests': []}


class ViewerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            cls.port = sock.getsockname()[1]
        cls.origin = f'http://127.0.0.1:{cls.port}'
        cls.server = subprocess.Popen([str(ROOT / 'node_modules/.bin/vite'), '--host', '127.0.0.1', '--port', str(cls.port), '--strictPort'], cwd=ROOT / 'client', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.terminate()
        cls.server.wait(timeout=5)

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 390, 'height': 844}, accept_downloads=True)
        self.page = self.context.new_page()
        self.role = 'sub'
        self.page.route('**/*', self.route)

    def tearDown(self):
        self.context.close()

    def route(self, route):
        url = route.request.url
        path = url.split('?', 1)[0]
        user = {'id': 'user1', 'email': 'test@example.invalid', 'name': 'Test User', 'role': self.role}
        payload = None
        if path.endswith('/api/auth/me'):
            payload = {'user': user}
        elif path.endswith('/api/sub/my'):
            payload = {'subcontractor': SUB, 'cois': COIS, 'requests': [], 'connected_gcs': [], 'public_share_url': '/sub/share/sub1'}
        elif path.endswith('/api/sub/carriers'):
            payload = {'carriers': []}
        elif path.endswith('/api/draft-review/my/drafts'):
            payload = {'drafts': []}
        elif path.endswith('/api/draft-review/my/permissions'):
            payload = {'permissions': []}
        elif path.endswith('/api/sub/sent-emails'):
            payload = {'emails': []}
        elif path.endswith('/api/subcontractors'):
            payload = {'subcontractors': [SUB]}
        elif path.endswith('/api/subcontractors/sub1'):
            payload = {'subcontractor': SUB}
        elif path.endswith('/api/settings'):
            payload = {'settings': {'expiration_warning_days': 30}}
        if payload is not None:
            return route.fulfill(status=200, content_type='application/json', body=json.dumps(payload))
        if '/api/' in path:
            return route.fulfill(status=404, content_type='application/json', body='{"error":"Unmocked API endpoint"}')
        if path.endswith('/test/photo.png'):
            return route.fulfill(status=200, content_type='image/png', body=PNG)
        if path.endswith('/test/missing.jpg'):
            return route.fulfill(status=404, body='missing')
        if path.endswith('/test/fake.pdf'):
            return route.fulfill(status=200, content_type='text/html', body='<script>parent.postMessage("executed", "*")</script><p>Not a PDF</p>')
        if url.startswith('https://no-cors.invalid/'):
            if route.request.resource_type == 'fetch':
                return route.abort()
            return route.fulfill(status=200, content_type='text/html', body='<script>parent.postMessage("executed", "*")</script>')
        if url.startswith('https://signed-s3.invalid/'):
            return route.fulfill(status=200, content_type='application/pdf', body=pdf_bytes(), headers={'Access-Control-Allow-Origin': '*'})
        if url.startswith(self.origin):
            return route.continue_()
        return route.abort()  # No external network, including fonts.

    def login(self, role, path):
        self.role = role
        user = {'id': 'user1', 'email': 'test@example.invalid', 'name': 'Test User', 'role': role}
        self.page.add_init_script(f'localStorage.setItem("coi_user", {json.dumps(json.dumps(user))}); localStorage.setItem("coi_token", "test");')
        self.page.goto(self.origin + path)

    def test_subcontractor_mobile_back_focus_escape_and_errors(self):
        self.login('sub', '/subcontractor')
        opener = self.page.get_by_role('button', name='View uploaded paper (photo.png)')
        opener.click()
        dialog = self.page.get_by_role('dialog', name='Certificate document')
        self.assertTrue(dialog.is_visible())
        self.assertTrue(dialog.get_by_role('button', name='Back to dashboard').evaluate('(el) => document.activeElement === el'))
        image = dialog.get_by_role('img', name='Certificate: photo.png')
        image.wait_for(state='visible')
        self.page.wait_for_function('document.querySelector("dialog img").naturalWidth > 0')
        self.assertEqual(self.page.evaluate('location.pathname'), '/subcontractor')
        self.page.keyboard.press('Escape')
        self.assertEqual(dialog.count(), 0)
        self.assertTrue(opener.evaluate('(el) => document.activeElement === el'))
        self.page.get_by_role('button', name='View uploaded paper (missing.jpg)').click()
        self.page.get_by_role('alert').get_by_text('The certificate could not be displayed.', exact=False).wait_for()
        self.page.get_by_role('button', name='Back to dashboard').click()
        self.page.get_by_role('button', name='View uploaded paper (document.html)').click()
        self.assertEqual(self.page.locator('dialog iframe').count(), 0)
        self.page.get_by_text('This file cannot be previewed here.', exact=False).wait_for()
        self.page.keyboard.press('Escape')
        self.page.get_by_role('button', name='View uploaded paper (unsafe.pdf)').click()
        self.assertEqual(self.page.locator('dialog iframe').count(), 0)
        self.assertEqual(self.page.get_by_role('button', name='Download original').count(), 0)

    def test_gc_page_and_review_modal_preserve_notes(self):
        self.login('gc', '/subcontractors')
        self.page.get_by_text('Acme Test', exact=True).first.click()
        self.page.get_by_role('button', name='View certificate file').first.click()
        self.page.get_by_role('button', name='Back to subcontractors').click()
        self.assertTrue(self.page.get_by_role('heading', name='Acme Test').is_visible())
        self.page.get_by_role('button', name='Review', exact=True).first.click()
        notes = self.page.get_by_placeholder('e.g. Limits verified. Endorsement page looks good.')
        notes.fill('Keep these notes')
        self.page.get_by_role('button', name='Open', exact=True).click()
        self.page.get_by_role('button', name='Back to review').click()
        self.assertEqual(notes.input_value(), 'Keep these notes')
        self.assertTrue(self.page.get_by_role('heading', name='Review certificate').is_visible())
        self.assertTrue(self.page.get_by_role('button', name='Open', exact=True).evaluate('(el) => document.activeElement === el'))

    def test_pdf_sandbox_and_download(self):
        self.login('sub', '/subcontractor')
        self.page.get_by_role('button', name='View uploaded paper (policy.PDF)').click()
        frame = self.page.locator('dialog iframe')
        frame.wait_for()
        self.assertIsNone(frame.get_attribute('sandbox'))
        self.assertTrue(frame.get_attribute('src').startswith('blob:'))
        self.page.wait_for_function('Array.from(document.querySelectorAll("dialog iframe")).length === 1')
        self.page.wait_for_timeout(1000)
        self.assertTrue(any(f.url.startswith('chrome-extension://') for f in self.page.frames), 'Chromium PDF viewer did not load')
        self.page.get_by_text('If the PDF does not appear', exact=False).wait_for()
        with self.page.expect_download() as info:
            self.page.get_by_role('button', name='Download original').click()
        download = info.value
        self.assertEqual(download.suggested_filename, 'policy.PDF')
        self.page.keyboard.press('Escape')
        self.page.evaluate('window.executed = false; window.addEventListener("message", () => window.executed = true)')
        self.page.get_by_role('button', name='View uploaded paper (fake.pdf)').click()
        self.page.get_by_role('alert').get_by_text('The certificate could not be displayed.', exact=False).wait_for()
        self.assertEqual(self.page.locator('dialog iframe').count(), 0)
        self.page.keyboard.press('Escape')
        self.page.get_by_role('button', name='View uploaded paper (no-cors.pdf)').click()
        fallback = self.page.locator('dialog iframe')
        fallback.wait_for()
        self.assertEqual(fallback.get_attribute('sandbox'), '')
        self.page.wait_for_timeout(500)
        self.assertFalse(self.page.evaluate('window.executed'))
        self.page.get_by_role('button', name='Download original').click()
        self.page.get_by_role('alert').get_by_text('Download was blocked', exact=False).wait_for()
        self.page.keyboard.press('Escape')
        self.page.get_by_role('button', name='View uploaded paper (from-name.PDF)').click()
        self.page.locator('dialog iframe[src^="blob:"]').wait_for()


if __name__ == '__main__':
    unittest.main(verbosity=2)
