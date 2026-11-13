"""Offline synthetic integration regression.

Run: python3 client/tests/test_coi_integrated_offline.py
Copies sources to a disposable sandbox, uses SQLite/local storage, blocks external
browser/Node networking, and never reads real credentials or application data.
Reports source races and invalidates the run if project sources change.
Requires Python Playwright, Chromium and existing node_modules.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
WATCH = ['server/src', 'client/src', 'client/public', 'client/index.html',
         'client/package.json', 'client/vite.config.ts', 'server/package.json', 'package-lock.json']

def fingerprints():
    out = {}
    for entry in WATCH:
        p = ROOT / entry
        for f in ([p] if p.is_file() else sorted(p.rglob('*'))):
            if f.is_file(): out[str(f.relative_to(ROOT))] = hashlib.sha256(f.read_bytes()).hexdigest()
    return out

def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

def wait_url(url, process):
    for _ in range(150):
        if process.poll() is not None: raise RuntimeError('Server exited before readiness')
        try:
            with urlopen(url, timeout=1) as r:
                if r.status == 200: return
        except Exception: time.sleep(.1)
    raise RuntimeError('Server startup timed out: ' + url)

class IntegratedOffline(unittest.TestCase):
    def test_complete_flow(self):
        before = fingerprints()
        with tempfile.TemporaryDirectory(prefix='coi-integrated-offline-') as work:
            base = Path(work)
            shutil.copytree(ROOT / 'server/src', base / 'server/src')
            shutil.copytree(ROOT / 'client/src', base / 'client/src')
            shutil.copytree(ROOT / 'client/public', base / 'client/public')
            for name in ['index.html', 'package.json', 'postcss.config.js', 'tailwind.config.js', 'tailwind.config.ts']:
                if (ROOT / 'client' / name).is_file(): shutil.copy2(ROOT / 'client' / name, base / 'client' / name)
            os.symlink(ROOT / 'node_modules', base / 'node_modules', target_is_directory=True)
            if before != fingerprints(): self.fail('Source changed while copying; postpone the final run')
            for rel, digest in before.items():
                p = base / rel
                if p.is_file(): self.assertEqual(hashlib.sha256(p.read_bytes()).hexdigest(), digest, rel)
            bport, vport = port(), port()
            origin = f'http://127.0.0.1:{vport}'
            backend = f'http://127.0.0.1:{bport}'
            (base / 'server/package.json').write_text('{"type":"module"}')
            (base / 'server/runner.mjs').write_text('''import net from 'node:net';
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const a=Array.isArray(args[0])?args[0][0]:args[0];const h=typeof a==='object'&&a?(a.host||a.hostname):(typeof args[1]==='string'?args[1]:undefined);if(!['127.0.0.1','localhost','::1'].includes(h))throw Error('Blocked non-loopback socket: '+h);return connect.apply(this,args)};
const {createApp}=await import('./src/app.ts');const {isPostgres}=await import('./src/db/db.ts');const {isS3Configured,LOCAL_UPLOADS}=await import('./src/services/storage.ts');
if(isPostgres||isS3Configured||!LOCAL_UPLOADS.startsWith(process.cwd()))throw Error('Unsafe test setup');
(await createApp()).listen(Number(process.env.PORT),'127.0.0.1');''')
            (base / 'vite.mjs').write_text(f'''import {{createServer}} from 'vite'; import react from '@vitejs/plugin-react';
const s=await createServer({{configFile:false,root:{json.dumps(str(base / 'client'))},cacheDir:{json.dumps(str(base / 'vite-cache'))},plugins:[react()],server:{{host:'127.0.0.1',port:{vport},strictPort:true,hmr:false,proxy:{{'/api':'{backend}','/uploads':'{backend}'}}}},logLevel:'error'}});await s.listen();''')
            env = {'PATH': os.environ.get('PATH','/usr/bin:/bin'), 'HOME': work, 'NODE_ENV':'test',
                   'SQLITE_PATH':str(base/'test.sqlite'), 'DATABASE_URL':'', 'PORT':str(bport),
                   'JWT_SECRET':'synthetic-local-secret-only', 'AWS_S3_BUCKET':'', 'AWS_REGION':'',
                   'AWS_ACCESS_KEY_ID':'', 'AWS_SECRET_ACCESS_KEY':'', 'AWS_S3_ENDPOINT':'', 'CLIENT_URL':origin}
            log = open(base/'process.log', 'w+')
            be = subprocess.Popen(['node','--experimental-strip-types',str(base/'server/runner.mjs')], cwd=base, env=env, stdout=log, stderr=log)
            vite = subprocess.Popen(['node',str(base/'vite.mjs')], cwd=base, env=env, stdout=log, stderr=log)
            pw = browser = None
            try:
                wait_url(backend+'/api/health', be); wait_url(origin, vite)
                with urlopen(backend+'/api/health') as r:
                    health = json.load(r)
                self.assertEqual((health['database'],health['storage']),('sqlite','local'))
                def api(method, path, token=None, data=None):
                    h = {'Authorization':'Bearer '+token} if token else {}
                    if data is not None: h['Content-Type']='application/json'
                    request = Request(backend+path, method=method, headers=h, data=json.dumps(data).encode() if data is not None else None)
                    try:
                        with urlopen(request, timeout=10) as r: return r.status, json.load(r)
                    except HTTPError as e: return e.code, json.load(e)
                pw = sync_playwright().start()
                browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                  args=['--no-sandbox','--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'])
                blocked = []
                def context():
                    c = browser.new_context(service_workers='block',viewport={'width':1280,'height':900})
                    def route(r):
                        if r.request.url.startswith(origin+'/'): r.continue_()
                        else: blocked.append(r.request.url); r.abort()
                    c.route('**/*',route)
                    c.route_web_socket('**/*',lambda ws: None)
                    return c
                c = context(); p = c.new_page(); p.set_default_timeout(12000)
                p.goto(origin+'/login'); p.get_by_role('button',name='Need an account? Register').click()
                p.get_by_role('button',name='Subcontractor',exact=True).click()
                for label,value in [('First name','Synthetic'),('Last name','Sub'),('Phone number','3125550199'),('Company name','Synthetic Sub Company'),('Email','sub@example.test'),('Password','Synthetic-Password-123')]: p.get_by_label(label,exact=True).fill(value)
                with p.expect_response(lambda r:'/api/auth/register' in r.url and r.request.method=='POST') as reg: p.get_by_role('button',name='Create account').click()
                self.assertEqual(reg.value.status,200); user=reg.value.json()['user']; subid=user['subcontractor_id']
                p.get_by_text('Upload your insurance paper').wait_for(); print('PASS browser signup')
                c.close(); c=context(); p=c.new_page(); p.set_default_timeout(12000)
                p.goto(origin+'/login'); p.get_by_label('Email',exact=True).fill('sub@example.test'); p.get_by_label('Password',exact=True).fill('Synthetic-Password-123')
                with p.expect_response(lambda r:'/api/auth/login' in r.url and r.request.method=='POST') as login: p.get_by_role('button',name='Sign in',exact=True).click()
                self.assertEqual(login.value.status,200); subtoken=login.value.json()['token']; p.get_by_text('Upload your insurance paper').wait_for(); print('PASS browser login')
                img = p.evaluate('''() => {const c=document.createElement('canvas'); c.width=1400;c.height=350;const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,c.width,c.height);x.fillStyle='black';x.font='bold 48px Arial';x.fillText('PRODUCER: SAMPLE AGENCY',50,85);x.fillText('INSURED: SAMPLE CONTRACTOR',50,165);x.fillText('PRODUCER PHONE: 212-555-1234',50,245);return c.toDataURL('image/png').split(',')[1]}''')
                png=base64.b64decode(img); paths=[]
                p.on('request', lambda req: paths.append(req.url))
                p.locator('input[type=file]').set_input_files({'name':'synthetic.png','mimeType':'image/png','buffer':png})
                p.get_by_placeholder('e.g. Liberty Mutual').fill('Synthetic Carrier'); p.get_by_placeholder('e.g. LM-GL-2026-00123').fill('SYN-1'); p.locator('input[type=date]').fill('2030-12-31')
                with p.expect_response(lambda r:'/api/sub/quick-upload' in r.url and r.request.method=='POST') as upload: p.get_by_role('button',name='Upload certificate').click()
                self.assertEqual(upload.value.status,200); coi=upload.value.json(); cid=coi['id']; self.assertEqual(coi['status'],'pending_review')
                expect(p.get_by_label('Producer name')).to_have_value('SAMPLE AGENCY',timeout=90000)
                self.assertEqual(p.get_by_label('Insured name').input_value(),'SAMPLE CONTRACTOR')
                self.assertTrue(any('/ocr/supervisor.js' in u for u in paths), paths)
                self.assertTrue(any('/ocr/lang/eng.traineddata' in u for u in paths), paths)
                self.assertTrue(any('/ocr/core/tesseract-core-' in u for u in paths), paths)
                self.assertIn('not independently confirmed or insurance verification',p.locator('body').inner_text())
                print('PASS real local OCR on uploaded PNG; pending review')
                p.get_by_label('Producer name').fill('CORRECTED SECRET PRODUCER')
                p.get_by_label('Insured name').fill('CORRECTED SECRET INSURED')
                p.get_by_role('button',name='Add insurer').click()
                p.get_by_label('Letter',exact=True).fill('A'); p.get_by_label('Insurer name').fill('Synthetic Insurance'); p.get_by_label('NAIC #').fill('00123')
                for i,values in enumerate([
                    ('General Liability','A','GL-001','01/02/2026','01/02/2030','Each occurrence','$1,000,000'),
                    ('Automobile Liability','A','AUTO-002','02/03/2026','02/03/2030','Combined single limit','$2,000,000')]):
                    p.get_by_role('button',name='Add policy').click()
                    for label,value in zip(['Type of insurance','Insurer letter','Policy number','Effective date','Expiration date'],values[:5]): p.get_by_label(label,exact=True).nth(i).fill(value)
                    p.get_by_role('button',name=f'Add limit to policy {i+1}').click()
                    p.get_by_label('Limit 1 label').nth(i).fill(values[5]); p.get_by_label('Limit 1 amount').nth(i).fill(values[6])
                with p.expect_response(lambda r:f'/api/coi-fields/{cid}' in r.url and r.request.method=='PUT') as saved: p.get_by_role('button',name='Save changes').click()
                self.assertEqual(saved.value.status,200); details=saved.value.json()['details']; self.assertEqual(details['source'],'mixed'); self.assertEqual(len(details['policies']),2)
                p.get_by_text('Document data saved.').wait_for(); p.reload(); p.get_by_role('button',name='Review document data').click()
                expect(p.get_by_label('Producer name')).to_have_value('CORRECTED SECRET PRODUCER'); self.assertEqual(p.get_by_label('Policy number').nth(1).input_value(),'AUTO-002'); self.assertEqual(p.get_by_label('Expiration date').nth(1).input_value(),'02/03/2030'); self.assertEqual(p.get_by_label('Limit 1 amount').nth(1).input_value(),'$2,000,000')
                status,reopened=api('GET',f'/api/coi-fields/{cid}',subtoken); self.assertEqual(status,200); self.assertEqual(reopened['details'],details)
                print('PASS saved corrections survive refresh/reopen including two policies, dates and limits')
                gc={}
                for key in ['gc','other']:
                    status,obj=api('POST','/api/auth/register',data={'email':key+'@example.test','password':'Synthetic-Password-123','name':'Synthetic '+key,'role':'gc','company_name':'Synthetic GC'})
                    self.assertEqual(status,200); gc[key]=obj
                status,_=api('PUT','/api/settings',gc['gc']['token'],{'company_name':'Synthetic GC','email':'gc@example.test'}); self.assertEqual(status,200)
                status,invite=api('GET','/api/settings/qr-invite',gc['gc']['token']); self.assertEqual(status,200)
                status,intent=api('POST','/api/sub/join-intent/'+invite['invite_code'],subtoken,{}); self.assertEqual(status,200)
                status,joined=api('POST','/api/sub/join/'+invite['invite_code'],subtoken,{'intent':intent['intent'],'consent':True}); self.assertEqual(status,200); self.assertTrue(joined['linked'])
                status,gr=api('GET',f'/api/coi-fields/{cid}',gc['gc']['token']); self.assertEqual(status,200); self.assertFalse(gr['editable']); self.assertEqual(gr['details'],details)
                status,_=api('PUT',f'/api/coi-fields/{cid}',gc['gc']['token'],{'sourceTag':gr['sourceTag'],'reviewRevision':gr['reviewRevision'],'details':details}); self.assertEqual(status,403)
                for method in ['GET','PUT']:
                    status,_=api(method,f'/api/coi-fields/{cid}',gc['other']['token'], {'sourceTag':gr['sourceTag'],'reviewRevision':gr['reviewRevision'],'details':details} if method=='PUT' else None); self.assertEqual(status,404)
                print('PASS connected GC read/403 write; unrelated GC 404 read/write')
                g=context(); pg=g.new_page(); pg.set_default_timeout(12000); pg.goto(origin+'/login'); pg.get_by_label('Email',exact=True).fill('gc@example.test'); pg.get_by_label('Password',exact=True).fill('Synthetic-Password-123'); pg.get_by_role('button',name='Sign in',exact=True).click(); pg.wait_for_url('**/dashboard'); pg.goto(origin+'/subcontractors')
                pg.get_by_role('row').filter(has_text='Synthetic Sub Company').click(); pg.get_by_role('button',name='Review fields').click(); dlg=pg.get_by_role('dialog',name='Review certificate fields'); expect(dlg.get_by_label('Producer name')).to_have_value('CORRECTED SECRET PRODUCER'); self.assertTrue(dlg.get_by_label('Producer name').get_attribute('readonly') is not None); self.assertEqual(dlg.get_by_role('button',name='Save changes').count(),0); print('PASS connected GC UI is read only')
                status,project=api('POST','/api/projects',gc['gc']['token'],{'name':'Synthetic Project'}); self.assertEqual(status,201); pid=project['project']['id']
                status,_=api('POST',f'/api/projects/{pid}/subcontractors',gc['gc']['token'],{'subcontractor_id':subid}); self.assertEqual(status,201)
                status,share=api('POST',f'/api/projects/{pid}/share',gc['gc']['token'],{}); self.assertEqual(status,201); tok=share['share']['token']
                status,report=api('GET','/api/client/share/'+tok); self.assertEqual(status,200); reportstr=json.dumps(report).lower()
                self.assertEqual(len(report['subcontractors']),1); self.assertEqual(report['subcontractors'][0]['cois'][0]['status'],'pending_review')
                for secret in ['corrected secret producer','corrected secret insured','00123','producer','insured','naic','gl-001','auto-002']: self.assertNotIn(secret,reportstr)
                public=context(); page=public.new_page(); page.goto(origin+'/share/'+tok); page.get_by_text('Subcontractors on this project').wait_for(); text=page.locator('body').inner_text().lower()
                for secret in ['corrected secret producer','corrected secret insured','00123','naic','limits verified']: self.assertNotIn(secret,text)
                self.assertIn('pending or simulated records are not verification of insurance',text)
                print('PASS public report excludes producer, insured, NAIC and structured policies; pending is not verification')
                self.assertEqual(details['policies'][0]['effectiveDate'],'01/02/2026'); self.assertEqual(details['policies'][0]['limits'][0]['amount'],'$1,000,000'); self.assertEqual(details['policies'][1]['expirationDate'],'02/03/2030'); self.assertEqual(details['policies'][1]['limits'][0]['amount'],'$2,000,000')
                print('PASS both nested policies retain dates and named limits')
                # A pending, GC-entered coverage without an occurrence limit is not
                # verified. Exercise the actual report rather than only its API.
                status,created=api('POST','/api/cois',gc['gc']['token'],{'subcontractor_id':subid,'carrier':'Synthetic Other Carrier','effective_date':'2026-01-01','expiration_date':'2099-01-01','coverages':json.dumps([{'type':'General Liability','per_occurrence_limit':'','aggregate_limit':'$2,000,000'}])})
                self.assertEqual(status,201)
                status,report2=api('GET','/api/client/share/'+tok); self.assertEqual(status,200)
                self.assertEqual(report2['subcontractors'][0]['cois'][0]['status'],'pending_review')
                self.assertIsNone(report2['subcontractors'][0]['cois'][0]['coverages'][0]['per_occurrence_limit'])
                page.reload(); page.get_by_text('Subcontractors on this project').wait_for()
                self.assertNotIn('limits verified',page.locator('body').inner_text().lower(), 'A missing, unverified limit must not be described as verified')
                print('PASS missing pending limit is not claimed verified')
                print('External browser requests blocked:',len(blocked))
            finally:
                if browser: browser.close()
                if pw: pw.stop()
                for proc in [vite,be]:
                    proc.terminate()
                    try: proc.wait(timeout=10)
                    except subprocess.TimeoutExpired: proc.kill(); proc.wait()
                log.flush(); log.seek(0); contents=log.read(); log.close()
                if be.returncode not in (0,-15): print('Backend/server log:',contents[-4000:])
                after=fingerprints()
                if before != after:
                    changed=sorted(k for k in set(before)|set(after) if before.get(k)!=after.get(k))
                    self.fail('SOURCE CHANGED DURING RUN — RESULTS INVALID; postpone final run: '+str(changed))
                print('PASS source fingerprint unchanged during run')

if __name__ == '__main__': unittest.main(verbosity=2)
