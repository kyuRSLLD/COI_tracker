"""Offline public-share regression; run python3 client/tests/test_client_share_privacy.py.

Requires frontend dependencies, Python Playwright, and Chromium. API responses are mocked.
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


def coverage(kind, **fields):
    return {'type': kind, 'additional_insured': False, 'waiver_of_subrogation': False, **fields}


class ClientShareTests(unittest.TestCase):
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
            cls.browser = cls.playwright.chromium.launch(
                executable_path=os.environ.get('CHROME_BIN', '/usr/bin/chromium'),
                headless=True, args=['--no-sandbox'],
            )
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

    def test_missing_limits_are_not_verified_and_private_fields_never_render(self):
        coi = {
            'id': 'private-coi', 'carrier': 'Secret Carrier', 'policy_number': 'SECRET-POLICY',
            'certificate_url': 'https://private.invalid/original.pdf', 'effective_date': '2026-01-01',
            'expiration_date': '2027-01-01', 'status': 'pending_review',
            'coverages': [
                coverage('Absent'),
                coverage('Null', per_occurrence_limit=None),
                coverage('Empty', per_occurrence_limit=''),
                coverage('Whitespace', per_occurrence_limit='  ', aggregate_limit='$2,000,000'),
                coverage('Provided', per_occurrence_limit='$1,000,000', aggregate_limit='$3,000,000'),
            ],
        }
        simulated = {**coi, 'coverages': [], 'simulated_carrier_connect': True}
        payload = {
            'project': {'name': 'Example Project', 'code': 'P1', 'address': '123 Private Street'},
            'contractor': {'company_name': 'General Contractor', 'phone': '555-123-9999', 'email': 'gc@private.invalid'},
            'scorecard': {'score': 0, 'total': 2, 'compliant': 0, 'expiring': 0, 'expired': 0, 'missing': 0, 'pending': 2},
            'subcontractors': [
                {'id': 'secret-id-1', 'company_name': 'Secret Subcontractor', 'trade': 'Secret Trade',
                 'phone': '555-987-1234', 'email': 'sub@private.invalid', 'computed_status': 'pending_review', 'cois': [coi]},
                {'id': 'secret-id-2', 'company_name': 'Secret Sub Two', 'trade': 'Secret Trade',
                 'computed_status': 'pending_review', 'cois': [simulated]},
            ],
            'share': {'created_at': '2026-01-01T00:00:00Z'}, 'generated_at': '2026-11-12T00:00:00Z',
        }
        context = self.browser.new_context()
        page = context.new_page()

        def route(r):
            if '/api/client/share/' in r.request.url:
                return r.fulfill(status=200, content_type='application/json', body=json.dumps(payload))
            if r.request.url.startswith(self.origin):
                return r.continue_()
            return r.abort()

        page.route('**/*', route)
        try:
            page.goto(self.origin + '/share/test-token')
            page.get_by_text('Absent:', exact=False).wait_for()
            rows = page.locator('main table tbody tr')
            self.assertEqual(rows.count(), 2)
            first = rows.nth(0).inner_text()
            for kind in ('Absent', 'Null', 'Empty', 'Whitespace'):
                self.assertIn(f'{kind}: Limit not provided', first)
            self.assertIn('Limit not provided / $2,000,000 agg', first)
            self.assertIn('Provided: $1,000,000 / $3,000,000 agg', first)
            self.assertIn('Pending review', first)
            self.assertIn('Simulated — not verified', rows.nth(1).inner_text())
            self.assertIn('does not verify insurance with carriers', page.locator('body').inner_text())
            page.get_by_role('button', name='Print compliance report').click()
            page.get_by_text('Print preview', exact=False).wait_for()
            text = page.locator('body').inner_text()
            for private in ('Secret Subcontractor', 'Secret Sub Two', 'Secret Trade', 'Secret Carrier',
                            'SECRET-POLICY', '555-123-9999', '555-987-1234', 'gc@private.invalid',
                            'sub@private.invalid', '123 Private Street'):
                self.assertNotIn(private, text)
            self.assertNotIn('limits verified', text.lower())
            self.assertNotIn('carrier verified', text.lower())
            self.assertEqual(page.locator('a[href*="private.invalid"]').count(), 0)
            self.assertEqual(page.locator('iframe').count(), 0)
            self.assertIn('Subcontractor 1', text)
            self.assertIn('Subcontractor 2', text)
        finally:
            context.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
