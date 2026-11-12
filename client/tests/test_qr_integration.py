"""Real browser + real Express QR integration, isolated from production.

Run: python3 client/tests/test_qr_integration.py
Requires Python Playwright, Chromium, frontend dependencies, and installed server
node_modules. SERVER_DEPS can point to a compatible server node_modules directory;
the default uses this project if installed, otherwise coi-invitations in this sandbox.

Copies application source to a temporary directory; SQLite, uploads, Vite cache,
logs and HOME are disposable. No production credentials are inherited. Browser
requests to the *synthetic* https://safecoi.com origin are intercepted and sent
only to the local Vite server, which proxies to a loopback-only Express server;
all other browser destinations are blocked. This is not production networking.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
import unittest
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
NODE = shutil.which('node')
DEFAULT_SERVER_DEPS = ROOT/'node_modules' if (ROOT/'node_modules/sqlite3').exists() else Path('/home/ubuntu/coi-invitations/node_modules')
SERVER_DEPS = Path(os.environ.get('SERVER_DEPS', str(DEFAULT_SERVER_DEPS))).resolve()
PASSWORD = 'SyntheticPassword-123!'
ORIGIN = 'https://safecoi.com'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aWQAAAAASUVORK5CYII=')


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def tree_hash(p):
    h = hashlib.sha256()
    for f in sorted(x for x in p.rglob('*') if x.is_file()):
        h.update(str(f.relative_to(p)).encode() + b'\0' + f.read_bytes() + b'\0')
    return h.hexdigest()


# This gate is applied to both Node processes, including any library proxy call.
NETWORK_GUARD = """import net from 'node:net';
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const arg = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof arg === 'object' && arg ? (arg.host || arg.hostname) : (typeof args[1] === 'string' ? args[1] : undefined);
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Blocked socket destination: ' + String(host));
  return connect.apply(this, args);
};
"""


class RealQrIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not NODE or not (SERVER_DEPS / 'sqlite3').exists():
            raise RuntimeError('Node or server dependencies missing; set SERVER_DEPS')
        cls.temp = tempfile.TemporaryDirectory(prefix='coi-real-qr-')
        cls.work = Path(cls.temp.name)
        cls.procs, cls.files = [], []
        try:
            cls.server_port, cls.vite_port = free_port(), free_port()
            if cls.server_port == cls.vite_port: cls.vite_port = free_port()
            cls.db = cls.work / 'test.sqlite'
            # Snapshot source so local storage stays under the temporary root.
            cls.source_hashes = {}
            for source, target in [(ROOT/'server/src', cls.work/'server/src'), (ROOT/'client/src', cls.work/'client/src')]:
                before = tree_hash(source)
                shutil.copytree(source, target)
                assert before == tree_hash(target) == tree_hash(source), 'source changed during snapshot'
                cls.source_hashes[source] = before
            for name in ['index.html', 'package.json', 'tailwind.config.js', 'postcss.config.js']:
                shutil.copy2(ROOT/'client'/name, cls.work/'client'/name)
            (cls.work/'server/node_modules').symlink_to(SERVER_DEPS, target_is_directory=True)
            (cls.work/'node_modules').symlink_to(ROOT/'node_modules', target_is_directory=True)
            (cls.work/'client/node_modules').mkdir()
            (cls.work/'client/node_modules/date-fns').symlink_to(ROOT/'client/node_modules/date-fns', target_is_directory=True)
            env = {'PATH': str(Path(NODE).parent) + ':/usr/bin:/bin', 'HOME': str(cls.work),
                   'NODE_ENV': 'test', 'SQLITE_PATH': str(cls.db), 'DATABASE_URL': '',
                   'JWT_SECRET': 'synthetic-test-secret-only', 'AWS_REGION': '', 'AWS_S3_BUCKET': '',
                   'AWS_ACCESS_KEY_ID': '', 'AWS_SECRET_ACCESS_KEY': '', 'CLIENT_URL': 'http://127.0.0.1'}
            backend = NETWORK_GUARD + """
const { createApp } = await import('./server/src/app.ts');
const { isPostgres } = await import('./server/src/db/db.ts');
const { LOCAL_UPLOADS, isS3Configured } = await import('./server/src/services/storage.ts');
if (isPostgres || isS3Configured || LOCAL_UPLOADS !== process.cwd() + '/server/uploads') throw Error('Unsafe configuration');
const app = await createApp({ maintenanceMode: false });
app.listen(Number(process.argv[2]), '127.0.0.1', () => console.log('BACKEND_READY'));
"""
            vite = NETWORK_GUARD + """
import { createServer } from 'vite'; import react from '@vitejs/plugin-react';
// Tailwind's content globs are relative to the frontend working directory.
// Without this, the isolated server silently omits component utility classes.
const root = process.cwd() + '/client'; process.chdir(root);
const s = await createServer({configFile:false,root,plugins:[react()],cacheDir:root + '/../vite-cache',
 server:{host:'127.0.0.1',port:Number(process.argv[2]),strictPort:true,hmr:false,proxy:{'/api':{target:'http://127.0.0.1:' + process.argv[3],changeOrigin:true},'/uploads':{target:'http://127.0.0.1:' + process.argv[3],changeOrigin:true}}},logLevel:'error'}); await s.listen(); console.log('VITE_READY');
"""
            for filename, code, args in [('backend.mjs', backend, [str(cls.server_port)]), ('frontend.mjs', vite, [str(cls.vite_port), str(cls.server_port)])]:
                script = cls.work/filename; script.write_text(code)
                log = open(cls.work/(filename+'.log'), 'w+'); cls.files.append(log)
                proc = subprocess.Popen([NODE, '--experimental-strip-types', str(script), *args], cwd=cls.work, env=env, stdout=log, stderr=log)
                cls.procs.append(proc)
            cls.base = f'http://127.0.0.1:{cls.vite_port}'
            for path in ['/api/health', '/']:
                for _ in range(150):
                    try:
                        with urlopen(cls.base + path, timeout=1) as r:
                            if path == '/api/health':
                                health = json.load(r); assert health['database'] == 'sqlite' and health['storage'] == 'local'
                            break
                    except Exception:
                        if any(p.poll() is not None for p in cls.procs): break
                        time.sleep(.1)
                else: raise RuntimeError('Timed out starting ' + path)
                if any(p.poll() is not None for p in cls.procs):
                    for f in cls.files: f.flush(); f.seek(0); print(f.read())
                    raise RuntimeError('Server failed')
            cls.pw = sync_playwright().start()
            cls.browser = cls.pw.chromium.launch(executable_path=os.environ.get('CHROME_BIN', '/usr/bin/chromium'), headless=True,
                args=['--no-sandbox', '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'])
        except Exception:
            cls.cleanup()
            raise

    @classmethod
    def cleanup(cls):
        if hasattr(cls, 'browser'): cls.browser.close()
        if hasattr(cls, 'pw'): cls.pw.stop()
        for p in getattr(cls, 'procs', []): p.terminate()
        for p in getattr(cls, 'procs', []):
            try: p.wait(timeout=5)
            except subprocess.TimeoutExpired: p.kill(); p.wait()
        for f in getattr(cls, 'files', []): f.close()
        if hasattr(cls, 'temp'): cls.temp.cleanup()

    @classmethod
    def tearDownClass(cls): cls.cleanup()

    def new_page(self):
        context = self.browser.new_context(service_workers='block', viewport={'width': 1280, 'height': 900})
        self.addCleanup(context.close)
        def route(r):
            u = urlsplit(r.request.url)
            if u.scheme == 'https' and u.netloc == 'safecoi.com':
                # Never contact safecoi.com: browser retains the origin while every
                # HTTP response comes from loopback, including all API requests.
                target = self.base + u.path + (('?' + u.query) if u.query else '')
                return r.fulfill(response=r.fetch(url=target, max_redirects=0))
            return r.abort()
        context.route('**/*', route)
        context.route_web_socket('**/*', lambda ws: None)
        page = context.new_page()
        page.set_default_timeout(12000)
        return page

    def register(self, role, email, company):
        payload = json.dumps({'email': email, 'password': PASSWORD, 'name': company, 'company_name': company, 'role': role}).encode()
        req = Request(self.base+'/api/auth/register', data=payload, headers={'Content-Type':'application/json'})
        with urlopen(req) as r: return json.load(r)['user']

    def login(self, page, email):
        page.goto(ORIGIN + '/login')
        page.get_by_label('Email', exact=True).fill(email)
        page.get_by_label('Password', exact=True).fill(PASSWORD)
        with page.expect_response(lambda r: urlsplit(r.url).path == '/api/auth/login' and r.request.method == 'POST') as response:
            page.get_by_role('button', name='Sign in', exact=True).click()
        self.assertEqual(response.value.status, 200)

    def api(self, page, method, path, data=None):
        return page.evaluate('''async ({method,path,data}) => {
          const r = await fetch(path, {method, headers: {'Authorization':'Bearer '+localStorage.getItem('coi_token'), ...(data ? {'Content-Type':'application/json'} : {})}, ...(data ? {body:JSON.stringify(data)} : {})});
          return {status:r.status, body:await r.json()};
        }''', {'method':method, 'path':path, 'data':data})

    def assert_no_qr_in_url_or_storage(self, page, token):
        self.assertEqual(page.url, ORIGIN + '/connect-sub')
        self.assertNotIn(token, page.url)
        stores = page.evaluate('''() => Object.fromEntries(
          ['localStorage', 'sessionStorage'].map(name => {
            const storage = window[name];
            return [name, Object.keys(storage).map(key => [key, storage.getItem(key)])];
          })
        )''')
        for name, entries in stores.items():
            with self.subTest(storage=name):
                self.assertNotIn('coi_pending_sub_connection', dict(entries))
                for key, value in entries:
                    self.assertNotIn(token, key)
                    self.assertNotIn(token, value)

    def qr(self, page):
        region = page.get_by_role('region', name='Share with a general contractor')
        region.wait_for()
        panel = page.get_by_role('dialog')
        if not panel.is_visible():
            region.get_by_role('button', name='Show connection QR code').click()
            panel.wait_for()
        # Catch a broken isolated Tailwind setup rather than scanning a clipped QR.
        self.assertLess(panel.bounding_box()['width'], page.viewport_size['width'])
        self.assertTrue(panel.get_by_role('button', name='Generate QR code').is_disabled())
        panel.get_by_role('checkbox').check()
        with page.expect_response(lambda r: urlsplit(r.url).path == '/api/connection-qr' and r.request.method == 'POST') as created:
            panel.get_by_role('button', name='Generate QR code').click()
        self.assertEqual(created.value.status, 200)
        qr = panel.get_by_role('img', name='QR code to connect one general contractor')
        qr.wait_for()
        link = panel.get_by_label('Private connection link').input_value()
        self.assertTrue(link.startswith(ORIGIN+'/connect-sub#'))
        return link.rsplit('#', 1)[1], qr.screenshot(), panel

    def test_real_end_to_end(self):
        sub = self.register('sub', 'sub@example.test', 'Synthetic Sub LLC')
        gc = self.register('gc', 'gc@example.test', 'Synthetic GC')
        other = self.register('gc', 'other@example.test', 'Unrelated GC')
        sub_id, sub_user, gc_user = sub['subcontractor_id'], sub['id'], gc['id']
        sub_page = self.new_page(); self.login(sub_page, 'sub@example.test')
        sub_page.get_by_role('region', name='Share with a general contractor').wait_for()
        # Actual multipart sub upload before connection, not a seeded mock COI.
        upload = sub_page.evaluate('''async b64 => {
          const bytes=Uint8Array.from(atob(b64), c=>c.charCodeAt(0)); const f=new FormData();
          f.append('certificate',new Blob([bytes],{type:'image/png'}),'sub.png');
          for(const [k,v] of Object.entries({carrier:'Sub Synthetic Carrier',policy_number:'SUB-TEST-001',effective_date:'2026-01-01',expiration_date:'2099-01-01'})) f.append(k,v);
          const r=await fetch('/api/sub/quick-upload',{method:'POST',headers:{Authorization:'Bearer '+localStorage.getItem('coi_token')},body:f});return {status:r.status,body:await r.json()};
        }''', base64.b64encode(PNG).decode())
        self.assertEqual(upload['status'], 200, upload)
        coi_id = upload['body']['id']
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute('SELECT subcontractor_id, owner_sub_user_id, owner_gc_user_id FROM cois WHERE id=?',(coi_id,)).fetchone(), (sub_id, sub_user, None))
        print('PASS real sub login and previously sub-owned multipart COI', flush=True)
        qr_writes = []
        sub_page.on('request', lambda request: qr_writes.append((urlsplit(request.url).path, request.method))
                    if urlsplit(request.url).path.startswith('/api/connection-qr') else None)
        token, image, panel = self.qr(sub_page)
        self.assertEqual(qr_writes, [('/api/connection-qr', 'POST')])
        panel.get_by_role('button', name='Close', exact=False).click()
        panel.wait_for(state='hidden')
        self.assertEqual(qr_writes, [('/api/connection-qr', 'POST')])
        sub_page.get_by_role('region', name='Share with a general contractor').get_by_role('button', name='Show connection QR code').click()
        panel.wait_for()
        self.assertEqual(panel.get_by_label('Private connection link').input_value(), ORIGIN+'/connect-sub#'+token)
        self.assertEqual(qr_writes, [('/api/connection-qr', 'POST')])
        with sqlite3.connect(self.db) as db:
            self.assertIsNone(db.execute('SELECT revoked_at FROM sub_connection_qr_tokens WHERE token_hash=?', (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()[0])
        print('PASS explicit consent creates actual app-rendered QR; close/reopen keeps it without API writes or revocation', flush=True)

        gc_page = self.new_page(); self.login(gc_page, 'gc@example.test')
        gc_page.goto(ORIGIN+'/subcontractors')
        gc_page.get_by_role('heading', name='Subcontractors', exact=True).wait_for()
        self.assertEqual(self.api(gc_page, 'GET', '/api/subcontractors')['body']['subcontractors'], [])
        gc_page.get_by_role('button', name='Add subcontractor', exact=True).click()
        with gc_page.expect_file_chooser() as chooser:
            gc_page.get_by_role('button', name='Upload sub QR', exact=True).click()
        chooser.value.set_files({'name':'qr.png','mimeType':'image/png','buffer':image})
        try:
            gc_page.get_by_text('Connection QR detected.', exact=False).wait_for(timeout=5000)
        except Exception as exc:
            self.fail(f'Could not detect the actual QR screenshot: {gc_page.get_by_role("alert").all_text_contents()}; {exc}')
        # Code has not been redeemed just by scanning the screenshot.
        self.assertEqual(self.api(gc_page, 'GET', '/api/subcontractors')['body']['subcontractors'], [])
        with gc_page.expect_response(lambda r: urlsplit(r.url).path == '/api/connection-qr/redeem' and r.request.method == 'POST') as redeem:
            gc_page.get_by_role('button', name='Connect subcontractor').click()
        self.assertEqual(redeem.value.status, 200)
        self.assertEqual(redeem.value.json()['subcontractor'], {'id':sub_id,'company_name':'Synthetic Sub LLC'})
        gc_page.get_by_role('status').get_by_text('Synthetic Sub LLC').wait_for()
        print('PASS GC real login, screenshot decoder and explicit redeem', flush=True)
        subs = self.api(gc_page, 'GET', '/api/subcontractors')['body']['subcontractors']
        self.assertEqual([s['id'] for s in subs], [sub_id])
        self.assertEqual(subs[0]['coi_count'], 1)
        self.assertEqual(subs[0]['best_coi']['id'], coi_id)
        detail = self.api(gc_page, 'GET', '/api/subcontractors/'+sub_id)
        self.assertEqual([c['id'] for c in detail['body']['subcontractor']['cois']], [coi_id])
        self.assertEqual([c['id'] for c in self.api(gc_page,'GET','/api/cois')['body']['cois']], [coi_id])
        gc_page.goto(ORIGIN+'/subcontractors')
        row = gc_page.locator('tr').filter(has_text='Synthetic Sub LLC'); row.wait_for()
        self.assertIn('Sub Synthetic Carrier', row.inner_text())
        row.click(); gc_page.get_by_text('SUB-TEST-001', exact=False).last.wait_for()
        print('PASS GC list + detail UI and real API show exact sub and earlier COI', flush=True)

        repeat = self.api(gc_page,'POST','/api/connection-qr/redeem',{'token':token})
        self.assertEqual(repeat['status'],200,repeat)
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM gc_sub_connections WHERE gc_user_id=? AND subcontractor_id=?',(gc_user,sub_id)).fetchone()[0],1)
        other_page = self.new_page(); self.login(other_page, 'other@example.test')
        other_page.goto(ORIGIN+'/subcontractors'); other_page.get_by_role('heading', name='Subcontractors', exact=True).wait_for()
        self.assertEqual(self.api(other_page,'POST','/api/connection-qr/redeem',{'token':token})['status'],404)
        self.assertEqual(self.api(other_page,'GET','/api/subcontractors')['body']['subcontractors'],[])
        self.assertEqual(self.api(other_page,'GET','/api/subcontractors/'+sub_id)['status'],404)
        self.assertEqual(self.api(other_page,'GET','/api/cois/'+coi_id)['status'],404)
        self.assertEqual(self.api(other_page,'GET','/api/cois')['body']['cois'],[])
        denied_upload = other_page.evaluate('''async ({subId,b64}) => {
          const bytes=Uint8Array.from(atob(b64), c=>c.charCodeAt(0)); const f=new FormData();
          for(const [k,v] of Object.entries({subcontractor_id:subId,carrier:'Denied Carrier',effective_date:'2026-01-01',expiration_date:'2099-01-01'})) f.append(k,v);
          f.append('certificate',new Blob([bytes],{type:'image/png'}),'denied.png');
          const r=await fetch('/api/cois',{method:'POST',headers:{Authorization:'Bearer '+localStorage.getItem('coi_token')},body:f});return r.status;
        }''', {'subId':sub_id,'b64':base64.b64encode(PNG).decode()})
        self.assertEqual(denied_upload, 404)
        print('PASS same-GC retry is idempotent; other GC denied token, sub and COI', flush=True)

        # Upload through the real GC modal and backend multipart endpoint.
        gc_page.get_by_role('button', name='Upload COI for Synthetic Sub LLC').click()
        dialog = gc_page.get_by_role('dialog', name='Upload COI')
        dialog.get_by_label('Insurance carrier').fill('GC Synthetic Carrier')
        dialog.get_by_label('Policy number').fill('GC-TEST-002')
        dialog.get_by_label('Effective date').fill('2026-01-01')
        dialog.get_by_label('Expiration date').fill('2098-01-01')
        dialog.locator('#coi-file').set_input_files({'name':'gc.png','mimeType':'image/png','buffer':PNG})
        with gc_page.expect_response(lambda r: urlsplit(r.url).path == '/api/cois' and r.request.method == 'POST') as result:
            dialog.get_by_role('button', name='Upload COI', exact=True).click()
        self.assertEqual(result.value.status, 201, result.value.text())
        gc_coi = result.value.json()['coi']['id']
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute('SELECT subcontractor_id,owner_gc_user_id,owner_sub_user_id FROM cois WHERE id=?',(gc_coi,)).fetchone(),(sub_id,gc_user,None))
        self.assertEqual(self.api(other_page,'GET','/api/cois/'+gc_coi)['status'],404)
        self.assertEqual({c['id'] for c in self.api(gc_page,'GET','/api/cois')['body']['cois']},{coi_id,gc_coi})
        self.assertEqual(len(list((self.work/'server/uploads').iterdir())),2)
        print('PASS real GC upload modal -> multipart endpoint, local file, GC ownership and other-GC denial', flush=True)

        # In non-production Express mounts local uploads as static files. Check
        # whether possession of the URL bypasses the COI metadata protections.
        certificate_url = self.api(gc_page,'GET','/api/cois/'+coi_id)['body']['coi']['certificate_url']
        self.assertTrue(certificate_url.startswith('/uploads/'))
        access = other_page.evaluate('''async path => {
          const result = [];
          for (const headers of [{}, {Authorization:'Bearer '+localStorage.getItem('coi_token')}]) {
            const r = await fetch(path, {headers}); const bytes = new Uint8Array(await r.arrayBuffer());
            result.push({status:r.status, bytes:Array.from(bytes)});
          }
          return result;
        }''', certificate_url)
        for who, r in zip(['anonymous', 'unrelated GC'], access):
            with self.subTest(local_certificate_fetch=who):
                self.assertIn(r['status'], [401,403,404], f'{who} directly fetched local certificate: HTTP {r["status"]}, identical synthetic PNG={bytes(r["bytes"]) == PNG}; non-production static storage only')

        # Also exercise the direct link in an anonymous tab and real login.
        sub_page.reload(); linked_token, _, _ = self.qr(sub_page)
        link_page = self.new_page()
        direct_redeems = []
        link_page.on('request', lambda request: direct_redeems.append(request)
                     if urlsplit(request.url).path == '/api/connection-qr/redeem' else None)
        link_page.goto(ORIGIN+'/connect-sub#'+linked_token)
        link_page.get_by_role('heading', name='Connect a subcontractor').wait_for()
        link_page.get_by_role('button',name='Sign in',exact=True).wait_for()
        self.assert_no_qr_in_url_or_storage(link_page, linked_token)
        link_page.get_by_label('Email',exact=True).fill('gc@example.test')
        link_page.get_by_label('Password',exact=True).fill(PASSWORD)
        with link_page.expect_response(lambda r: urlsplit(r.url).path == '/api/auth/login' and r.request.method == 'POST') as login:
            link_page.get_by_role('button',name='Sign in',exact=True).click()
        self.assertEqual(login.value.status,200)
        link_page.get_by_role('button',name='Connect subcontractor').wait_for()
        self.assert_no_qr_in_url_or_storage(link_page, linked_token)
        self.assertEqual(direct_redeems, [])
        with sqlite3.connect(self.db) as db:
            self.assertIsNone(db.execute('SELECT redeemed_by_gc_user_id FROM sub_connection_qr_tokens WHERE token_hash=?',(hashlib.sha256(linked_token.encode()).hexdigest(),)).fetchone()[0])
        with link_page.expect_response(lambda r: urlsplit(r.url).path == '/api/connection-qr/redeem' and r.request.method == 'POST') as claim:
            link_page.get_by_role('button',name='Connect subcontractor').click()
        self.assertEqual(claim.value.status,200)
        self.assertEqual(claim.value.request.post_data_json, {'token':linked_token})
        self.assertEqual(claim.value.request.headers.get('authorization'), 'Bearer ' + link_page.evaluate("localStorage.getItem('coi_token')"))
        self.assertEqual(claim.value.json()['subcontractor'], {'id':sub_id,'company_name':'Synthetic Sub LLC'})
        link_page.get_by_role('status').get_by_text('Synthetic Sub LLC').wait_for()
        self.assertEqual(len(direct_redeems), 1)
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute('SELECT redeemed_by_gc_user_id FROM sub_connection_qr_tokens WHERE token_hash=?',(hashlib.sha256(linked_token.encode()).hexdigest(),)).fetchone()[0], gc_user)
        self.assert_no_qr_in_url_or_storage(link_page, linked_token)
        print('PASS direct-link memory-only capture, real GC login and authenticated explicit redemption', flush=True)

        # Reloading an unredeemed direct link must discard its memory-only code.
        sub_page.reload(); abandoned_token, _, _ = self.qr(sub_page)
        abandoned_page = self.new_page()
        abandoned_redeems = []
        abandoned_page.on('request', lambda request: abandoned_redeems.append(request)
                          if urlsplit(request.url).path == '/api/connection-qr/redeem' else None)
        abandoned_page.goto(ORIGIN+'/connect-sub#'+abandoned_token)
        abandoned_page.get_by_role('button',name='Sign in',exact=True).wait_for()
        self.assert_no_qr_in_url_or_storage(abandoned_page, abandoned_token)
        abandoned_page.reload()
        abandoned_page.get_by_text('No valid connection code is available.',exact=False).wait_for()
        self.assert_no_qr_in_url_or_storage(abandoned_page, abandoned_token)
        self.assertEqual(abandoned_redeems, [])
        with sqlite3.connect(self.db) as db:
            self.assertIsNone(db.execute('SELECT redeemed_by_gc_user_id FROM sub_connection_qr_tokens WHERE token_hash=?',(hashlib.sha256(abandoned_token.encode()).hexdigest(),)).fetchone()[0])
        print('PASS reload discards unredeemed direct-link code without restoring or redeeming it', flush=True)

        sub_page.reload(); revoked, _, panel = self.qr(sub_page)
        with sub_page.expect_response(lambda r: urlsplit(r.url).path == '/api/connection-qr/revoke' and r.request.method == 'POST') as revoke:
            panel.get_by_role('button', name='Revoke / cancel QR code').click()
        self.assertEqual(revoke.value.status,200)
        panel.get_by_text('The QR code was revoked.',exact=False).wait_for()
        self.assertEqual(self.api(sub_page,'POST','/api/connection-qr/revoke',{'token':revoked})['status'],200)
        self.assertEqual(self.api(gc_page,'POST','/api/connection-qr/redeem',{'token':revoked})['status'],404)
        self.assertEqual([s['id'] for s in self.api(gc_page,'GET','/api/subcontractors')['body']['subcontractors']],[sub_id])
        print('PASS UI revoke, repeated revoke, rejected redemption, existing link retained', flush=True)
        expired, expired_image, _ = self.qr(sub_page)
        # Force server expiry in disposable SQLite; no 15 minute wait or response mocking.
        with sqlite3.connect(self.db, timeout=10) as db:
            changed = db.execute('UPDATE sub_connection_qr_tokens SET expires_at=? WHERE token_hash=?',('2000-01-01T00:00:00.000Z',hashlib.sha256(expired.encode()).hexdigest())).rowcount
            self.assertEqual(changed,1)
        other_page.get_by_role('button', name='Add subcontractor', exact=True).click()
        with other_page.expect_file_chooser() as chooser:
            other_page.get_by_role('button', name='Upload sub QR', exact=True).click()
        chooser.value.set_files({'name':'expired.png','mimeType':'image/png','buffer':expired_image})
        other_page.get_by_text('Connection QR detected.',exact=False).wait_for()
        with other_page.expect_response(lambda r: urlsplit(r.url).path == '/api/connection-qr/redeem' and r.request.method == 'POST') as expired_result:
            other_page.get_by_role('button',name='Connect subcontractor').click()
        self.assertEqual(expired_result.value.status,404)
        other_page.get_by_role('alert').get_by_text('invalid, expired',exact=False).wait_for()
        self.assertEqual(self.api(other_page,'GET','/api/subcontractors')['body']['subcontractors'],[])
        print('PASS server rejects forced-expired token and GC screenshot UI shows error', flush=True)
        for source, before in self.source_hashes.items():
            self.assertEqual(tree_hash(source),before, f'{source} changed during test; rerun')
        print('PASS frontend and backend source snapshots unchanged during run', flush=True)


if __name__ == '__main__': unittest.main(verbosity=2)
