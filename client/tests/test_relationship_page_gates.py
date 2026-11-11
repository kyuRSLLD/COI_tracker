"""Offline synthetic page-mount/gate tests. No backend or external network.
Run: python3 client/tests/test_relationship_page_gates.py
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest
from urllib.parse import urlsplit
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect
ROOT = Path(__file__).resolve().parents[2]


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class PageGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='relationship-page-gates-')
        tmp = Path(cls.temp.name)
        (tmp / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        config = (ROOT / 'client/vite.config.ts').read_text().replace(
            'export default defineConfig({',
            'export default defineConfig({\n  root: ' + json.dumps(str(ROOT / 'client')) + ',\n  envDir: ' + json.dumps(str(tmp)) + ',')
        path = tmp / 'vite.config.ts'
        path.write_text(config)
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(tmp), 'TMPDIR': str(tmp), 'VITE_RELATIONSHIP_PROTOTYPE_ENABLED': 'true'}
        build = subprocess.run([str(ROOT / 'node_modules/.bin/vite'), 'build', '--config', str(path), '--outDir', str(tmp / 'dist')], cwd=tmp, env=env, capture_output=True, text=True)
        if build.returncode: raise RuntimeError(build.stdout + build.stderr)
        cls.procs, cls.origins = [], {}
        for name, enabled, production in [('on', 'true', False), ('off', 'false', False), ('prod', 'true', True)]:
            p = port()
            cmd = [str(ROOT / 'node_modules/.bin/vite')] + (['preview'] if production else []) + ['--config', str(path), '--host', '127.0.0.1', '--port', str(p), '--strictPort']
            if production: cmd += ['--outDir', str(tmp / 'dist')]
            proc = subprocess.Popen(cmd, cwd=tmp, env={**env, 'VITE_RELATIONSHIP_PROTOTYPE_ENABLED': enabled}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            cls.procs.append(proc)
            origin = f'http://127.0.0.1:{p}'
            for _ in range(150):
                try:
                    with urlopen(origin, timeout=1): break
                except Exception:
                    if proc.poll() is not None: raise RuntimeError('Vite stopped')
                    time.sleep(.1)
            else: raise RuntimeError('Vite timed out')
            cls.origins[name] = origin
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()
        for proc in cls.procs: proc.terminate(); proc.wait(timeout=5)
        cls.temp.cleanup()

    def test_mounts_only_for_appropriate_role_in_enabled_development(self):
        for name in ('on', 'off', 'prod'):
            for role in ('gc', 'sub', 'admin'):
                with self.subTest(mode=name, role=role):
                    user = {'id': 'synthetic', 'email': 'test@example.invalid', 'name': 'Test', 'role': role}
                    context = self.browser.new_context()
                    context.add_init_script("localStorage.setItem('coi_token','synthetic');localStorage.setItem('coi_user'," + json.dumps(json.dumps(user)) + ");")
                    page = context.new_page()
                    calls = []
                    def route(r):
                        req = r.request
                        url = urlsplit(req.url)
                        if url.hostname != '127.0.0.1': return r.abort()
                        if not url.path.startswith('/api/'): return r.continue_()
                        calls.append(url.path)
                        if url.path == '/api/auth/me': data = {'user': user}
                        elif url.path == '/api/sub/my': data = {'subcontractor': {'company_name': 'Synthetic Sub', 'trade': 'Electrical'}, 'cois': [], 'requests': [], 'public_share_url': '/share/test'}
                        elif url.path == '/api/sub/sent-emails': data = {'emails': []}
                        elif url.path == '/api/subcontractors': data = {'subcontractors': []}
                        elif url.path == '/api/settings': data = {'settings': {}}
                        elif url.path == '/api/relationship-prototype/disclosure': data = {'version':'v1','scope':'synthetic scope','qr':'synthetic qr','invitation':'synthetic invitation'}
                        elif url.path in ('/api/relationship-prototype/gc/connections', '/api/relationship-prototype/sub/connections'): data = {'connections': []}
                        else: data = {}
                        r.fulfill(status=200, content_type='application/json', body=json.dumps(data))
                    page.route('**/*', route)
                    page.goto(self.origins[name] + ('/subcontractor' if role == 'sub' else '/subcontractors'))
                    if role == 'sub': expect(page.get_by_text('Subcontractor insurance portal', exact=False)).to_be_visible()
                    else: expect(page.get_by_role('heading', name='Subcontractors', exact=True)).to_be_visible()
                    panel = page.locator('[data-relationship-prototype="sub"]') if role == 'sub' else page.get_by_role('heading', name='GC relationship prototype')
                    if name == 'on' and role in ('gc', 'sub'):
                        expect(panel).to_be_visible()
                    else:
                        expect(panel).to_have_count(0)
                        page.wait_for_timeout(150)
                        self.assertFalse(any(p.startswith('/api/relationship-prototype') for p in calls))
                    context.close()


if __name__ == '__main__': unittest.main(verbosity=2)
