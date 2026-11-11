"""Isolated browser tests: intercepted synthetic API only; no backend or real data.

Run from repository root: python3 client/tests/test_relationship_prototype_ui.py
Requires installed workspace dependencies, Python Playwright and /usr/bin/chromium.
"""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from urllib.parse import urlsplit
from urllib.request import urlopen

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = '/tests/relationship-prototype-fixture.html'
BASE = '/api/relationship-prototype'
TOKEN = 'A' * 43
OTHER_TOKEN = 'B' * 43
EXPIRY = '2099-01-01T00:00:00.000Z'
D = {'version': 'synthetic-v1', 'scope': 'Exact synthetic ALL current and future scope. No PDFs. No client access.',
     'qr': 'Exact QR bearer text: any GC may redeem.', 'invitation': 'Exact invitation text for the previewed GC.'}


def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def wait(url, proc):
    for _ in range(150):
        if proc.poll() is not None:
            raise RuntimeError('Test server stopped')
        try:
            with urlopen(url, timeout=1):
                return
        except Exception:
            time.sleep(.1)
    raise RuntimeError('Test server did not start')


class RelationshipPrototypeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix='relationship-ui-test-'))
        cls.procs = []
        cls.logs = []
        cls.pw = cls.browser = None
        try:
            (cls.tmp / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
            config = cls.tmp / 'vite.config.mjs'
            config.write_text("import { defineConfig } from 'vite'; import react from '@vitejs/plugin-react';\n" +
                              'export default defineConfig({root:' + json.dumps(str(ROOT / 'client')) +
                              ', envDir:' + json.dumps(str(cls.tmp)) + ', plugins:[react()], build:{rollupOptions:{input:' +
                              json.dumps(str(ROOT / 'client/tests/relationship-prototype-fixture.html')) + '}}});')
            cls.config = config
            cls.on = cls.start_vite('true')
            cls.off = cls.start_vite('false')
            env = cls.env('true'); env['NODE_ENV'] = 'production'
            build = subprocess.run([str(ROOT / 'node_modules/.bin/vite'), 'build', '--config', str(config), '--outDir', str(cls.tmp / 'dist')], cwd=cls.tmp, env=env, capture_output=True, text=True)
            if build.returncode: raise RuntimeError(build.stdout + build.stderr)
            p = port()
            log = (cls.tmp / 'static.log').open('w+'); cls.logs.append(log)
            server = subprocess.Popen(['python3', '-m', 'http.server', str(p), '--bind', '127.0.0.1', '--directory', str(cls.tmp / 'dist')], cwd=cls.tmp, env=env, stdout=log, stderr=log)
            cls.procs.append(server); cls.production = f'http://127.0.0.1:{p}'
            wait(cls.production + FIXTURE, server)
            cls.pw = sync_playwright().start()
            cls.browser = cls.pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        except BaseException:
            cls.cleanup()
            raise

    @classmethod
    def env(cls, flag):
        return {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(cls.tmp), 'TMPDIR': str(cls.tmp), 'VITE_RELATIONSHIP_PROTOTYPE_ENABLED': flag}

    @classmethod
    def start_vite(cls, flag):
        p = port(); origin = f'http://127.0.0.1:{p}'
        log = (cls.tmp / f'vite-{flag}.log').open('w+'); cls.logs.append(log)
        proc = subprocess.Popen([str(ROOT / 'node_modules/.bin/vite'), '--config', str(cls.config), '--host', '127.0.0.1', '--port', str(p), '--strictPort'], cwd=cls.tmp, env=cls.env(flag), stdout=log, stderr=log)
        cls.procs.append(proc); wait(origin + FIXTURE, proc)
        return origin

    @classmethod
    def cleanup(cls):
        if cls.browser: cls.browser.close()
        if cls.pw: cls.pw.stop()
        for p in cls.procs: p.terminate()
        for p in cls.procs:
            try: p.wait(timeout=5)
            except subprocess.TimeoutExpired: p.kill(); p.wait()
        for f in cls.logs: f.close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    @classmethod
    def tearDownClass(cls): cls.cleanup()

    def setUp(self):
        self.calls = []
        self.current = dict(D)
        self.preview_disclosure = dict(D)
        self.fail_disclosure = False
        self.sub_connections = [{'gc_user_id': 'gc-1', 'gc_company_name': 'Synthetic GC', 'connected_at': '2026-01-01', 'source': 'gc_invite'}]
        self.gc_connections = [{'sub_user_id': 'sub-1', 'company_name': 'Synthetic Sub', 'trade': 'Electrical', 'connected_at': '2026-01-01', 'cois': [{'id': 'coi-1', 'carrier': 'Synthetic carrier', 'file_url': 'https://unsafe.invalid/file.pdf', 'coverages': [{'type': 'General liability', 'notes': 'synthetic', 'secret_file_url': 'https://unsafe.invalid/coverage'}]}]}]
        self.context = self.browser.new_context()
        self.context.route('**/*', self.route)
        self.page = self.context.new_page()

    def tearDown(self): self.context.close()

    def route(self, route):
        request = route.request
        parts = urlsplit(request.url)
        if parts.hostname != '127.0.0.1':
            route.abort(); return
        if not parts.path.startswith(BASE):
            route.continue_(); return
        body = json.loads(request.post_data) if request.post_data else None
        self.calls.append((request.method, parts.path, body, request.headers))
        status = 200
        result = {}
        path = parts.path[len(BASE):]
        if path == '/disclosure':
            if self.fail_disclosure: status = 503; result = {'error': 'synthetic secret should not appear'}
            else: result = self.current
        elif path == '/sub/connections' and request.method == 'GET': result = {'connections': self.sub_connections}
        elif path == '/gc/connections': result = {'connections': self.gc_connections}
        elif path == '/sub-qr' and request.method == 'POST': result = {'id': 'qr-1', 'token': TOKEN, 'expires_at': EXPIRY}
        elif path == '/gc-invitations' and request.method == 'POST': result = {'id': 'invite-1', 'token': OTHER_TOKEN, 'expires_at': EXPIRY}
        elif path == '/gc-invitations/preview': result = {'gc_user_id': 'gc-1', 'gc_company_name': 'Synthetic GC', 'expires_at': EXPIRY, 'disclosure': self.preview_disclosure}
        elif path == '/gc-invitations/accept': result = {'status': 'connected'}
        elif path == '/sub-qr/preview': result = {'company_name': 'Synthetic Sub', 'trade': 'Electrical', 'expires_at': EXPIRY}
        elif path == '/sub-qr/accept': result = {'status': 'connected'}
        elif path.startswith('/sub/connections/') and request.method == 'DELETE': self.sub_connections = []; result = {'revoked': True}
        elif path.startswith('/capabilities/') and request.method == 'DELETE': result = {'revoked': True}
        else: status = 404; result = {'error': 'missing mock'}
        route.fulfill(status=status, content_type='application/json', body=json.dumps(result))

    def open(self, origin=None, gc=False):
        self.page.goto((origin or self.on) + FIXTURE + ('?gc' if gc else ''))

    def post_calls(self, endpoint):
        return [c for c in self.calls if c[0] == 'POST' and c[1] == BASE + endpoint]

    def test_qr_requires_exact_disclosure_opt_in_and_revocation(self):
        self.open()
        expect(self.page.get_by_test_id('qr-disclosure-scope')).to_have_text(D['scope'])
        expect(self.page.get_by_test_id('qr-disclosure-flow')).to_have_text(D['qr'])
        issue = self.page.get_by_role('button', name='Issue one-use QR')
        expect(issue).to_be_disabled(); self.assertEqual(self.post_calls('/sub-qr'), [])
        self.page.get_by_label('I explicitly agree to the full disclosure above before issuing a QR.').check()
        issue.click()
        expect(self.page.get_by_role('img', name='One-use relationship QR containing the bearer token')).to_be_visible()
        expect(self.page.get_by_label('Raw bearer token for manual entry')).to_have_value(TOKEN)
        self.assertEqual(self.page.evaluate('window.decodePrototypeQr()'), TOKEN)
        self.assertEqual(self.post_calls('/sub-qr')[0][2], {'consent': True, 'consent_version': D['version']})
        self.page.get_by_role('button', name='Revoke connection').click()
        expect(self.page.get_by_text('No active connections.')).to_be_visible()
        expect(self.page.get_by_role('img', name='One-use relationship QR containing the bearer token')).to_have_count(0)
        expect(issue).to_be_disabled()
        self.assertIn(('DELETE', BASE + '/sub/connections/gc-1'), [(c[0], c[1]) for c in self.calls])
        self.assertTrue(all(TOKEN not in c[1] and OTHER_TOKEN not in c[1] for c in self.calls))
        self.assertTrue(all(c[3].get('authorization') == 'Bearer synthetic-auth' for c in self.calls))
        self.assertNotIn(TOKEN, self.page.url)
        self.assertNotIn(TOKEN, self.page.evaluate('JSON.stringify(localStorage) + JSON.stringify(sessionStorage)'))
        self.assertTrue(all(TOKEN not in c[3].get('referer', '') for c in self.calls))

    def test_qr_capability_can_be_revoked_without_connection(self):
        self.open(); expect(self.page.get_by_test_id('qr-disclosure-scope')).to_be_visible()
        self.page.get_by_label('I explicitly agree to the full disclosure above before issuing a QR.').check()
        self.page.get_by_role('button', name='Issue one-use QR').click()
        expect(self.page.get_by_label('Raw bearer token for manual entry')).to_have_value(TOKEN)
        self.page.get_by_role('button', name='Revoke or clear this code').click()
        expect(self.page.get_by_role('button', name='Issue one-use QR')).to_be_disabled()
        self.assertIn(('DELETE', BASE + '/capabilities/qr-1'), [(c[0], c[1]) for c in self.calls])

    def test_changed_disclosure_requires_new_consent(self):
        self.open(); expect(self.page.get_by_test_id('qr-disclosure-scope')).to_have_text(D['scope'])
        self.page.get_by_label('I explicitly agree to the full disclosure above before issuing a QR.').check()
        self.current = {**D, 'version': 'synthetic-v2', 'scope': 'Updated exact scope.'}
        self.page.get_by_role('button', name='Issue one-use QR').click()
        expect(self.page.get_by_text('The disclosure changed. Review it and opt in again.')).to_be_visible()
        expect(self.page.get_by_test_id('qr-disclosure-scope')).to_have_text('Updated exact scope.')
        expect(self.page.get_by_role('button', name='Issue one-use QR')).to_be_disabled()
        self.assertEqual(self.post_calls('/sub-qr'), [])

    def test_invitation_identity_bound_and_opt_in(self):
        self.open(); expect(self.page.get_by_test_id('qr-disclosure-scope')).to_be_visible()
        self.page.get_by_label('GC invitation bearer token').fill(OTHER_TOKEN)
        self.page.get_by_role('button', name='Preview invitation').click()
        expect(self.page.get_by_text('Synthetic GC', exact=False).first).to_be_visible()
        expect(self.page.get_by_test_id('invite-disclosure-scope')).to_have_text(D['scope'])
        expect(self.page.get_by_test_id('invite-disclosure-flow')).to_have_text(D['invitation'])
        accept = self.page.get_by_role('button', name='Accept invitation')
        expect(accept).to_be_disabled(); self.assertEqual(self.post_calls('/gc-invitations/accept'), [])
        self.page.get_by_label('I explicitly accept the full disclosure above and authorize this identified GC to receive all current and future COI information as described.').check()
        accept.click(); expect(self.page.get_by_text('Connection accepted.')).to_be_visible()
        self.assertEqual(self.post_calls('/gc-invitations/accept')[0][2], {'token': OTHER_TOKEN, 'gc_user_id': 'gc-1', 'gc_company_name': 'Synthetic GC', 'consent': True, 'consent_version': D['version']})
        self.assertTrue(all(OTHER_TOKEN not in c[1] for c in self.calls))

    def test_invitation_changed_after_preview_is_not_accepted(self):
        self.open(); expect(self.page.get_by_test_id('qr-disclosure-scope')).to_be_visible()
        self.page.get_by_label('GC invitation bearer token').fill(OTHER_TOKEN)
        self.page.get_by_role('button', name='Preview invitation').click()
        self.page.get_by_label('I explicitly accept the full disclosure above and authorize this identified GC to receive all current and future COI information as described.').check()
        self.current = {**D, 'version': 'synthetic-v2', 'invitation': 'Changed invitation text.'}
        self.page.get_by_role('button', name='Accept invitation').click()
        expect(self.page.get_by_text('The disclosure changed. Review it and opt in again.')).to_be_visible()
        self.assertEqual(self.post_calls('/gc-invitations/accept'), [])
        expect(self.page.get_by_role('button', name='Accept invitation')).to_have_count(0)

    def test_mismatched_preview_disclosure_and_failed_refresh_fail_closed(self):
        self.preview_disclosure = {**D, 'scope': 'Different scope'}
        self.open(); expect(self.page.get_by_test_id('qr-disclosure-scope')).to_be_visible()
        self.page.get_by_label('GC invitation bearer token').fill(OTHER_TOKEN)
        self.page.get_by_role('button', name='Preview invitation').click()
        expect(self.page.get_by_role('alert')).to_contain_text('Could not preview')
        self.assertEqual(self.post_calls('/gc-invitations/accept'), [])
        self.fail_disclosure = True
        self.page.get_by_role('button', name='Refresh disclosure').click()
        expect(self.page.get_by_text('Current disclosure unavailable. No code can be issued.')).to_be_visible()
        expect(self.page.get_by_role('button', name='Issue one-use QR')).to_be_disabled()
        self.assertNotIn('synthetic secret', self.page.locator('body').inner_text())

    def test_disabled_in_development_and_production(self):
        for origin in (self.off, self.production):
            for gc in (False,):
                self.calls.clear(); self.open(origin, gc)
                expect(self.page.locator('[data-relationship-prototype]')).to_have_count(0)
                self.page.wait_for_timeout(200)
                self.assertEqual(self.calls, [])


if __name__ == '__main__': unittest.main(verbosity=2)
