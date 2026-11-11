"""Real local end-to-end relationship prototype tests (no mocked APIs or real email).

Run: python3 client/tests/test_integrated_relationship_e2e.py
Requires npm workspace dependencies, Python Playwright, and /usr/bin/chromium.
Each run starts loopback-only Vite + Express on ephemeral ports, uses a fresh
SQLite database and random JWT key, and blocks browser traffic to other origins.
It never reads a project .env or production database. The real QR is decoded
locally, then passed to a simulated camera detector; no email is sent.
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
from urllib.parse import urlsplit
from urllib.request import urlopen

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
PASSWORD = 'local-only-synthetic-password'
GC = 'synthetic-gc@example.invalid'
SUB = 'synthetic-sub@example.invalid'


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


class IntegratedRelationshipTests(unittest.TestCase):
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
                   'RELATIONSHIP_PROTOTYPE_ENABLED': 'true', 'VITE_RELATIONSHIP_PROTOTYPE_ENABLED': 'true',
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
        self.contexts, self.requests = [], []
    def tearDown(self):
        for context in self.contexts: context.close()
    def context(self):
        context = self.browser.new_context(viewport={'width': 1100, 'height': 900})
        self.contexts.append(context)
        def guard(route):
            parts = urlsplit(route.request.url)
            if parts.scheme in ('http', 'https') and (parts.hostname != '127.0.0.1' or parts.port != urlsplit(self.origin).port): route.abort()
            else: route.continue_()
        context.route('**/*', guard)
        context.on('request', lambda r: self.requests.append((r.method, r.url, r.headers.get('referer', ''), r.post_data)))
        return context
    def login(self, page, email):
        page.goto(self.origin + '/login')
        page.get_by_label('Email', exact=True).fill(email)
        page.get_by_label('Password', exact=True).fill(PASSWORD)
        page.get_by_role('button', name='Sign in', exact=True).click()
        page.wait_for_url('**' + ('/dashboard' if email == GC else '/subcontractor'), timeout=15000)
    def insert_coi(self, id, carrier):
        now = '2026-01-01T00:00:00.000Z'
        with sqlite3.connect(self.db) as db:
            db.execute('INSERT INTO cois (id,subcontractor_id,carrier,policy_number,effective_date,expiration_date,certificate_url,certificate_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', (id, 'sub-profile', carrier, id+'-policy', '2026-01-01', '2028-01-01', 'https://secret.invalid/file.pdf', 'secret-key', now, now))
            db.execute('INSERT INTO coi_coverages (id,coi_id,type,per_occurrence_limit,notes) VALUES (?,?,?,?,?)', (id+'-coverage', id, 'Synthetic Liability', '1000000', id+' coverage'))
    def test_actual_qr_to_gc_scanner_current_future_cois_and_revoke(self):
        self.insert_coi('current-test', 'Synthetic Current Carrier')
        sub = self.context().new_page()
        self.login(sub, SUB)
        scope = sub.get_by_test_id('qr-disclosure-scope')
        expect(scope).to_contain_text('current and future')
        issue = sub.get_by_role('button', name='Issue one-use QR')
        expect(issue).to_be_disabled()
        sub.get_by_label('I explicitly agree to the full disclosure above before issuing a QR.').check()
        issue.click()
        expect(sub.get_by_role('img', name='One-use relationship QR containing the bearer token')).to_be_visible()
        token = sub.evaluate("async () => (await import('/tests/decode-relationship-qr.ts')).decodeRelationshipQr()")
        self.assertRegex(token, r'^[A-Za-z0-9_-]{43}$')
        self.assertEqual(sub.get_by_label('Raw bearer token for manual entry').input_value(), token)
        gc_context = self.context()
        # Inject only the value decoded from the real rendered QR into a mocked
        # camera detector. Camera hardware and optics are not exercised.
        gc_context.add_init_script("""(() => {
          window.__stopped = false;
          Object.defineProperty(navigator, 'mediaDevices', {configurable:true, value:{getUserMedia:async()=>({getTracks:()=>[{onended:null,stop(){window.__stopped=true}}]})}});
          HTMLMediaElement.prototype.play = async function() {};
          Object.defineProperties(HTMLVideoElement.prototype, {readyState:{configurable:true,get:()=>4},videoWidth:{configurable:true,get:()=>300},videoHeight:{configurable:true,get:()=>300},srcObject:{configurable:true,get(){return this.__s},set(v){this.__s=v}}});
          window.BarcodeDetector = class {static async getSupportedFormats(){return ['qr_code']} async detect(){return [{rawValue: TOKEN_VALUE}]} };
        })()""".replace('TOKEN_VALUE', json.dumps(token)))
        gc = gc_context.new_page()
        self.login(gc, GC)
        gc.goto(self.origin + '/subcontractors')
        expect(gc.get_by_role('heading', name='GC relationship prototype')).to_be_visible()
        expect(gc.get_by_role('button', name='Create test invitation')).to_be_disabled()
        # Default staged scanner rejects the identical raw capability without making an API call.
        gc.get_by_role('button', name='Add subcontractor', exact=True).first.click()
        gc.get_by_role('button', name='Scan subcontractor QR').click()
        staged = gc.get_by_role('region', name='Scan subcontractor QR')
        staged.get_by_label('Or paste the connection link').fill(token)
        staged.get_by_role('button', name='Look up').click()
        expect(staged.get_by_role('alert')).to_contain_text('not a valid')
        self.assertFalse(any('/api/invitations/sub-qr/info' in url for _,url,_,_ in self.requests))
        staged.get_by_role('button', name='Close QR scanner').click()
        # Close the modal using its accessible button.
        gc.get_by_role('button', name='Cancel', exact=True).first.click()
        gc.get_by_role('button', name='Scan or paste a subcontractor QR').click()
        scanner = gc.get_by_role('region', name='Scan subcontractor QR')
        scanner.get_by_role('button', name='Start camera').click()
        expect(scanner.get_by_text('Synthetic Sub Company', exact=True)).to_be_visible()
        self.assertTrue(gc.evaluate('window.__stopped'))
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM prototype_relationships').fetchone()[0], 0)
        scanner.get_by_role('button', name='Confirm test connection').click()
        panel = gc.get_by_role('region', name='GC relationship prototype')
        expect(panel.get_by_text('Synthetic Current Carrier', exact=True)).to_be_visible()
        expect(panel.get_by_text('current-test coverage', exact=True)).to_be_visible()
        self.insert_coi('future-test', 'Synthetic Future Carrier')
        panel.get_by_role('button', name='Refresh list').click()
        expect(panel.get_by_text('Synthetic Future Carrier', exact=True)).to_be_visible()
        expect(panel.get_by_text('future-test coverage', exact=True)).to_be_visible()
        self.assertNotIn('secret.invalid', panel.inner_text())
        self.assertNotIn('secret-key', panel.inner_text())
        self.assertNotIn(token, gc.url)
        for method, url, referer, body in self.requests:
            self.assertNotIn(token, url)
            self.assertNotIn(token, referer)
        sub.get_by_role('button', name='Refresh connections').click()
        expect(sub.get_by_text('Synthetic GC Company', exact=False)).to_be_visible()
        sub.get_by_role('button', name='Revoke connection').click()
        expect(sub.get_by_text('No active connections.')).to_be_visible()
        panel.get_by_role('button', name='Refresh list').click()
        expect(panel.get_by_text('No active test connections.')).to_be_visible()
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM cois').fetchone()[0], 2)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM client_share_links').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM project_subcontractors').fetchone()[0], 0)
if __name__ == '__main__': unittest.main(verbosity=2)
