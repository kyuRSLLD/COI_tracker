"""Real local end-to-end staging tests (no mocked APIs or real email).

Run: python3 client/tests/test_staged_integration.py
Requires npm workspace dependencies, Python Playwright, and /usr/bin/chromium.
Each run starts loopback-only Vite + Express on ephemeral ports, uses a fresh
SQLite database and random JWT key, and blocks browser traffic to other origins.
It never reads a project .env or production database. The test email draft is
inspected locally; it is never opened or sent. Only clipboard is simulated.
"""
import json
import os
import re
import secrets
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit
from urllib.request import urlopen

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
PASSWORD = 'local-only-synthetic-password'
GC = 'synthetic-gc@example.invalid'
SUB = 'synthetic-sub@example.invalid'
TABLES = ('users', 'gc_settings', 'subcontractors', 'cois', 'coi_coverages',
          'upload_requests', 'project_subcontractors', 'email_logs')


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def wait_server(url, proc, log):
    for _ in range(150):
        if proc.poll() is not None:
            raise RuntimeError(f'Server exited ({proc.returncode}): {log.read_text()}')
        try:
            with urlopen(url, timeout=1) as r:
                if r.status == 200:
                    return
        except Exception:
            time.sleep(.1)
    raise RuntimeError(f'Server startup timed out: {log.read_text()}')


class RealStagedBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix='coi-browser-isolated-'))
        cls.processes = []
        cls.logs = []
        cls.pw = cls.browser = None
        try:
            backend_port, frontend_port = free_port(), free_port()
            while frontend_port == backend_port:
                frontend_port = free_port()
            cls.origin = f'http://127.0.0.1:{frontend_port}'
            cls.db = cls.tmp / 'isolated.sqlite'
            # Whitelist rather than inherit the host environment, including its
            # HOME, cloud credentials, database URLs, or dotenv configuration.
            env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
                   'HOME': str(cls.tmp), 'TMPDIR': str(cls.tmp),
                   'NODE_ENV': 'test', 'STAGED_INVITES_ENABLED': 'true',
                   'VITE_STAGED_INVITES_ENABLED': 'true',
                   'JWT_SECRET': secrets.token_hex(48), 'DATABASE_URL': '',
                   'SQLITE_PATH': str(cls.db), 'CLIENT_URL': cls.origin,
                   'AWS_S3_BUCKET': '', 'AWS_ACCESS_KEY_ID': '',
                   'AWS_SECRET_ACCESS_KEY': ''}
            # cwd is a new directory, so dotenv cannot load a repository .env.
            backend_script = (
                f"import {{createApp}} from {json.dumps((ROOT / 'server/src/app.ts').as_uri())};"
                f"const app=await createApp();app.listen({backend_port},'127.0.0.1',()=>console.log('local ready'));"
            )
            backend_log = cls.tmp / 'backend.log'
            cls.logs.append(backend_log.open('w+'))
            backend = subprocess.Popen(['node', '--experimental-strip-types', '--input-type=module', '-e', backend_script],
                                       cwd=cls.tmp, env=env, stdout=cls.logs[-1], stderr=subprocess.STDOUT)
            cls.processes.append(backend)
            wait_server(f'http://127.0.0.1:{backend_port}/api/health', backend, backend_log)
            with urlopen(f'http://127.0.0.1:{backend_port}/api/health') as r:
                assert json.load(r)['database'] == 'sqlite'
            assert cls.db.is_file() and str(cls.db) in backend_log.read_text()
            # bcrypt is the project's own implementation; no authentication is forged.
            bcrypt_js = str(ROOT / 'node_modules/bcryptjs')
            password_hash = subprocess.check_output(
                ['node', '-e', f"console.log(require({json.dumps(bcrypt_js)}).hashSync({json.dumps(PASSWORD)},10))"],
                cwd=cls.tmp, env=env, text=True).strip()
            now = '2026-01-01T00:00:00.000Z'
            with sqlite3.connect(cls.db) as db:
                assert db.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 0
                db.executemany('INSERT INTO users (id,email,password_hash,name,company_name,role,subcontractor_id,created_at) VALUES (?,?,?,?,?,?,?,?)', [
                    ('gc-test', GC, password_hash, 'Synthetic GC', 'Synthetic GC Company', 'gc', None, now),
                    ('sub-test', SUB, password_hash, 'Synthetic Sub', 'Synthetic Sub Company', 'sub', 'sub-profile', now)])
                db.execute('INSERT INTO gc_settings (id,user_id,company_name,email,updated_at) VALUES (?,?,?,?,?)',
                           ('gc-settings', 'gc-test', 'Synthetic GC Company', GC, now))
                db.execute('INSERT INTO subcontractors (id,user_id,company_name,trade,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
                           ('sub-profile', 'sub-test', 'Synthetic Sub Company', 'Electrical', SUB, now, now))
                assert db.execute("SELECT count(*) FROM gc_settings WHERE user_id='gc-test'").fetchone()[0] == 1
            # Copy the app's actual Vite config, substituting only its proxy port
            # and isolated envDir. Resolve Vite plugins from existing workspace deps.
            (cls.tmp / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
            vite_config = (ROOT / 'client/vite.config.ts').read_text().replace(
                "target: 'http://127.0.0.1:5001'", f"target: 'http://127.0.0.1:{backend_port}'")
            vite_config = vite_config.replace('export default defineConfig({',
                f'export default defineConfig({{\n  root: {json.dumps(str(ROOT / "client"))},\n  envDir: {json.dumps(str(cls.tmp))},')
            config_path = cls.tmp / 'vite.config.ts'
            config_path.write_text(vite_config)
            frontend_log = cls.tmp / 'frontend.log'
            cls.logs.append(frontend_log.open('w+'))
            frontend = subprocess.Popen([str(ROOT / 'node_modules/.bin/vite'), '--config', str(config_path),
                                         '--host', '127.0.0.1', '--port', str(frontend_port), '--strictPort'],
                                        cwd=ROOT / 'client', env=env, stdout=cls.logs[-1], stderr=subprocess.STDOUT)
            cls.processes.append(frontend)
            wait_server(cls.origin, frontend, frontend_log)
            cls.pw = sync_playwright().start()
            cls.browser = cls.pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        except BaseException:
            cls.cleanup()
            raise

    @classmethod
    def cleanup(cls):
        if cls.browser: cls.browser.close()
        if cls.pw: cls.pw.stop()
        for p in cls.processes:
            p.terminate()
        for p in cls.processes:
            try: p.wait(timeout=5)
            except subprocess.TimeoutExpired: p.kill(); p.wait()
        for f in cls.logs: f.close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    @classmethod
    def tearDownClass(cls): cls.cleanup()

    def setUp(self):
        with sqlite3.connect(self.db) as db:
            for table in ('staged_gc_sub_relationships', 'staged_gc_invitations', 'staged_sub_qr_capabilities', 'staged_invite_rate_limit'):
                db.execute(f'DELETE FROM {table}')
        self.contexts, self.requests, self.responses, self.secrets = [], [], [], []
        self.before = self.legacy_snapshot()

    def tearDown(self):
        for context in self.contexts: context.close()

    def legacy_snapshot(self):
        with sqlite3.connect(self.db) as db:
            return {t: db.execute(f'SELECT * FROM {t} ORDER BY rowid').fetchall() for t in TABLES}

    def query(self, sql, params=()):
        with sqlite3.connect(self.db) as db:
            return db.execute(sql, params).fetchall()

    def context(self):
        context = self.browser.new_context(viewport={'width': 1100, 'height': 900})
        self.contexts.append(context)
        # Only block outbound nonlocal resources; all app/API traffic is real.
        def guard(route):
            parts = urlsplit(route.request.url)
            if parts.scheme in ('http', 'https') and (parts.hostname != '127.0.0.1' or parts.port != urlsplit(self.origin).port):
                route.abort()
            else:
                route.continue_()
        context.route('**/*', guard)
        context.on('request', lambda r: self.requests.append((r.method, r.url, r.headers.get('referer', ''), r.post_data)))
        context.on('response', lambda r: self.responses.append((r.request.method, urlsplit(r.url).path, r.status)))
        context.add_init_script("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async s=>{window.__localClipboard=s}}})")
        return context

    def login(self, page, email):
        page.goto(self.origin + '/login')
        page.get_by_label('Email', exact=True).fill(email)
        page.get_by_label('Password', exact=True).fill(PASSWORD)
        page.get_by_role('button', name='Sign in', exact=True).click()
        expected = '/dashboard' if email == GC else '/subcontractor'
        page.wait_for_url('**' + expected, timeout=15000)
        self.assertTrue(any(m == 'POST' and path == '/api/auth/login' and status == 200 for m, path, status in self.responses))

    def open_add(self, page):
        page.goto(self.origin + '/subcontractors')
        page.get_by_role('button', name='Add subcontractor', exact=True).first.click()

    def assert_network_privacy(self):
        self.assertTrue(self.secrets)
        for method, url, referer, body in self.requests:
            for token in self.secrets:
                self.assertNotIn(token, url, f'capability in {method} request URL')
                self.assertNotIn(token, referer, f'capability in {method} referrer')
            path = urlsplit(url).path
            self.assertFalse(path.startswith('/api/sub/join/'), f'legacy onboarding was called: {path}')
            self.assertNotIn(path, ('/api/sub/join', '/api/emails/send', '/api/sub/email-coi'))
        self.assertEqual(self.legacy_snapshot(), self.before, 'staging must not alter legacy profiles, COIs, requests or email logs')

    def test_gc_invites_sub_by_qr_and_local_email_draft(self):
        gc = self.context().new_page()
        sub = self.context().new_page()
        self.login(gc, GC)
        self.open_add(gc)
        gc.get_by_role('button', name='Invite', exact=True).click()
        gc.get_by_role('button', name='Create invitation').click()
        expect(gc.get_by_text('Scan or share this invitation')).to_be_visible(timeout=12000)
        expect(gc.locator('svg title').filter(has_text='Subcontractor invitation QR code')).to_have_count(1)
        gc.get_by_label('Recipient email').fill(SUB)
        href = gc.get_by_role('link', name='Open email draft').get_attribute('href')
        parts = urlsplit(href)
        self.assertEqual((parts.scheme, unquote(parts.path)), ('mailto', SUB))
        body = parse_qs(parts.query)['body'][0]
        invite = re.search(re.escape(self.origin) + r'/invite-sub#[A-Za-z0-9_-]{43}', body).group(0)
        token = urlsplit(invite).fragment
        self.secrets.append(token)
        self.assertEqual(self.query('SELECT max_uses, uses FROM staged_gc_invitations'), [(1, 0)])
        self.assertEqual(self.query('SELECT * FROM staged_gc_sub_relationships'), [])
        # Only a local synthetic draft is shown. Mask both the QR pixels and
        # the bearer URL so the illustration cannot disclose a usable token.
        output = Path('/home/ubuntu/outputs/invitation-preview.png')
        output.parent.mkdir(parents=True, exist_ok=True)
        modal = gc.get_by_role('heading', name='Add a new subcontractor').locator('xpath=ancestor::div[contains(@class,"rounded-3xl")][1]')
        panel = gc.get_by_role('region', name='Invite a subcontractor')
        self.assertEqual(gc.get_by_role('heading', name='Add a new subcontractor').evaluate("el => getComputedStyle(el).fontWeight"), '800', 'Vite must load project Tailwind styles')
        modal.screenshot(path=str(output), mask=[panel.locator('svg:has(title)'), panel.locator('p.break-all')], mask_color='#cbd5e1')
        self.login(sub, SUB)
        sub.goto(invite)
        expect(sub.get_by_text('Synthetic GC Company', exact=False)).to_be_visible()
        self.assertEqual(urlsplit(sub.url).fragment, '')
        self.assertNotIn(token, sub.url)
        self.assertEqual(self.query('SELECT * FROM staged_gc_sub_relationships'), [])
        sub.get_by_role('button', name='Confirm test relationship').click()
        expect(sub.get_by_role('status').filter(has_text='Test relationship recorded')).to_be_visible()
        self.assertIsNone(sub.evaluate("sessionStorage.getItem('coi_staged_invite')"))
        self.assertEqual(self.query('SELECT gc_user_id,sub_user_id,source FROM staged_gc_sub_relationships'), [('gc-test', 'sub-test', 'gc_invite')])
        self.assertEqual(self.query('SELECT max_uses,uses FROM staged_gc_invitations'), [(1, 1)])
        self.assertTrue(any(m == 'POST' and p == '/api/invitations/accept' and s == 200 for m,p,s in self.responses))
        self.assertEqual(sub.evaluate("token => fetch('/api/invitations/info',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})}).then(r=>r.status)", token), 404)
        self.assert_network_privacy()

    def test_sub_qr_gc_paste_preview_then_confirm(self):
        sub = self.context().new_page()
        gc = self.context().new_page()
        self.login(sub, SUB)
        sub.get_by_label('Trade to share with the contractor').fill('Electrical')
        sub.get_by_role('button', name='Generate connection code').click()
        expect(sub.get_by_role('img', name='Connection QR code for a general contractor to scan')).to_be_visible(timeout=12000)
        self.assertTrue(any(m == 'POST' and urlsplit(u).path == '/api/invitations/sub-qr' and json.loads(b or '{}') == {'trade': 'Electrical'} for m,u,_,b in self.requests))
        sub.get_by_role('button', name='Copy connection link').click()
        link = sub.evaluate('window.__localClipboard')
        self.assertRegex(link, re.escape(self.origin) + r'/connect-sub#[A-Za-z0-9_-]{43}$')
        token = urlsplit(link).fragment
        self.secrets.append(token)
        # Opening the QR target itself also strips its fragment synchronously;
        # scanner lookup below must never navigate to that value.
        probe = sub.context.new_page()
        probe.goto(link)
        expect(probe.get_by_text('Scan this code from the general contractor', exact=False)).to_be_visible()
        self.assertEqual(urlsplit(probe.url).fragment, '')
        self.assertNotIn(token, probe.url)
        self.assertIsNone(probe.evaluate('window.__stagedFragment ?? null'))
        self.login(gc, GC)
        self.open_add(gc)
        gc.get_by_role('button', name='Scan subcontractor QR').click()
        gc.get_by_label('Or paste the connection link').fill(link)
        gc.get_by_role('button', name='Look up').click()
        preview = gc.get_by_role('region', name='Scan subcontractor QR')
        expect(preview.get_by_text('Synthetic Sub Company', exact=True)).to_be_visible()
        expect(preview.get_by_text('Electrical', exact=True)).to_be_visible()
        self.assertEqual(self.query('SELECT * FROM staged_gc_sub_relationships'), [])
        self.assertEqual(self.query('SELECT consumed_at FROM staged_sub_qr_capabilities'), [(None,)])
        gc.get_by_role('button', name='Confirm test relationship').click()
        expect(gc.get_by_role('status').filter(has_text='Test relationship recorded')).to_be_visible()
        self.assertEqual(self.query('SELECT gc_user_id,sub_user_id,source FROM staged_gc_sub_relationships'), [('gc-test', 'sub-test', 'sub_qr')])
        self.assertIsNotNone(self.query('SELECT consumed_at FROM staged_sub_qr_capabilities')[0][0])
        self.assertTrue(any(m == 'POST' and p == '/api/invitations/sub-qr/accept' and s == 200 for m,p,s in self.responses))
        self.assertEqual(gc.evaluate("token => fetch('/api/invitations/sub-qr/info',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+localStorage.getItem('coi_token')},body:JSON.stringify({token})}).then(r=>r.status)", token), 404)
        self.assert_network_privacy()


if __name__ == '__main__':
    unittest.main(verbosity=2)
