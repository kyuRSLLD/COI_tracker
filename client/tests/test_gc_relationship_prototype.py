"""Offline synthetic browser tests; no backend, real identities, or emails.
Run: python3 client/tests/test_gc_relationship_prototype.py
Requires Node dependencies, Python Playwright and Chromium.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, unquote, urlsplit
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
CLIENT = ROOT / 'client'
VITE = ROOT / 'node_modules/.bin/vite'
CONFIG = CLIENT / 'tests/fixtures/gc-prototype.vite.config.ts'
PAGE = '/tests/fixtures/gc-prototype.html'
SUB = 'b' * 43
INVITE = 'a' * 43
BASE = '/api/relationship-prototype'

def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

def expiry(seconds=3600):
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()

class GcPrototypeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='gc-ui-test-')
        cls.procs, cls.origins = [], {}
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': cls.temp.name, 'TMPDIR': cls.temp.name, 'VITE_RELATIONSHIP_PROTOTYPE_ENABLED': 'true', 'GC_TEST_OUT_DIR': cls.temp.name, 'GC_TEST_ENV_DIR': cls.temp.name}
        subprocess.run([str(VITE), 'build', '--config', str(CONFIG)], cwd=CLIENT, env=env, check=True, stdout=subprocess.DEVNULL)
        for name, flag, production in [('on', 'true', False), ('off', 'false', False), ('prod', 'true', True)]:
            p = port()
            runenv = dict(env, VITE_RELATIONSHIP_PROTOTYPE_ENABLED=flag)
            cmd = [str(VITE)] + (['preview'] if production else []) + ['--config', str(CONFIG), '--host', '127.0.0.1', '--port', str(p), '--strictPort']
            proc = subprocess.Popen(cmd, cwd=CLIENT, env=runenv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            cls.procs.append(proc)
            origin = f'http://127.0.0.1:{p}'
            for _ in range(120):
                try:
                    with urlopen(origin + PAGE, timeout=1): break
                except Exception:
                    if proc.poll() is not None: raise RuntimeError('Vite exited early')
                    time.sleep(.1)
            else: raise RuntimeError('Vite failed to start')
            cls.origins[name] = origin
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(executable_path=os.environ.get('CHROME_BIN', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()
        for proc in cls.procs: proc.terminate(); proc.wait(timeout=5)
        cls.temp.cleanup()

    def setUp(self):
        self.context = self.browser.new_context()
        self.page = self.context.new_page()
        self.requests = []
        self.linked = False
        self.accept_status = 'connected'
        self.fail_list = False
        self.invite_expiry = expiry()
        self.page.route('**/*', self.route)

    def tearDown(self): self.context.close()

    def route(self, route):
        req = route.request
        u = urlsplit(req.url)
        if u.hostname != '127.0.0.1': return route.abort()
        if not u.path.startswith('/api/'): return route.continue_()
        body = req.post_data_json if req.post_data else None
        self.requests.append((req.method, u.path, body, req.url, req.headers))
        status = 200
        if u.path == BASE + '/gc/connections':
            if self.fail_list: status, data = 503, {}
            elif not self.linked: data = {'connections': []}
            else:
                data = {'connections': [{'sub_user_id': 'sub-synthetic', 'company_name': 'Synthetic Sparks', 'trade': 'Electrical', 'connected_at': '2026-01-01', 'cois': [{'id':'coi-synthetic','carrier':'Synthetic Carrier','am_best_rating':'A','policy_number':'TEST-POLICY','effective_date':'2026-01-01','expiration_date':'2027-01-01','status':'approved','reviewer_notes':'Test review','review_date':'2026-01-02','certificate_name':'test certificate','certificate_size':123,'certificate_mime':'application/pdf','created_at':'2026-01-01','updated_at':'2026-01-02','coverages':[{'id':'cov-test','type':'General Liability','per_occurrence_limit':'1000000','aggregate_limit':'2000000','additional_insured':1,'waiver_of_subrogation':0,'notes':'Synthetic coverage'}]}]}]}
        elif u.path == BASE + '/sub-qr/preview': data = {'company_name':'Synthetic Sparks','trade':'Electrical','expires_at':expiry()}
        elif u.path == BASE + '/sub-qr/accept':
            data = {'status': self.accept_status}
            if self.accept_status == 'connected': self.linked = True
        elif u.path == BASE + '/gc-invitations': data = {'id':'gc-invite-test-id','token':INVITE,'expires_at':self.invite_expiry}
        elif u.path == BASE + '/capabilities/gc-invite-test-id': data = {'revoked':True}
        else: status, data = 404, {}
        route.fulfill(status=status, content_type='application/json', body=json.dumps(data))

    def start(self, name='on', role='gc'):
        user = json.dumps(json.dumps({'id':'synthetic', 'role':role}))
        self.context.add_init_script(f"localStorage.setItem('coi_token','synthetic-jwt');localStorage.setItem('coi_user',{user});")
        self.page.goto(self.origins[name] + PAGE)

    def endpoint(self, suffix): return [r for r in self.requests if r[1] == BASE + suffix]

    def assert_secret_transport(self):
        self.assertTrue(all(SUB not in r[3] and INVITE not in r[3] for r in self.requests))
        self.assertTrue(all(r[4].get('authorization') == 'Bearer synthetic-jwt' for r in self.requests))
        self.assertFalse(any(r[1].startswith('/api/invitations') or r[1] in ['/api/subcontractors', '/api/cois'] for r in self.requests))

    def test_scan_confirmation_refresh_and_coverage(self):
        self.start()
        expect(self.page.get_by_text('No active test connections.')).to_be_visible()
        self.page.get_by_role('button', name='Scan or paste a subcontractor QR').click()
        link = self.page.get_by_label('Or paste the raw prototype token or connection link')
        for value in [f'https://evil.invalid/connect-sub#{SUB}', f'{self.origins["on"]}/connect-sub?token={SUB}', f'{self.origins["on"]}/connect-sub/{SUB}', f'//evil.invalid/connect-sub#{SUB}', f'{self.origins["on"]}/connect-sub#bad']:
            link.fill(value); self.page.get_by_role('button', name='Look up').click()
            expect(self.page.get_by_role('alert').filter(has_text='not a valid')).to_contain_text('not a valid')
        self.assertFalse(self.endpoint('/sub-qr/preview'))
        link.fill(self.origins['on'] + '/connect-sub#' + SUB)
        self.page.get_by_role('button', name='Look up').click()
        expect(self.page.get_by_text('Synthetic Sparks', exact=True)).to_be_visible()
        self.assertEqual(self.endpoint('/sub-qr/preview')[-1][2], {'token':SUB})
        self.assertFalse(self.endpoint('/sub-qr/accept'))
        self.accept_status = 'unexpected'
        self.page.get_by_role('button', name='Confirm test connection').click()
        expect(self.page.get_by_role('alert').filter(has_text='Unable to record')).to_contain_text('Unable to record')
        self.assertEqual(len(self.endpoint('/gc/connections')), 1)
        self.accept_status = 'connected'
        self.page.get_by_role('button', name='Confirm test connection').click()
        expect(self.page.get_by_text('General Liability', exact=True)).to_be_visible()
        for text in ['Synthetic Sparks', 'Synthetic Carrier', 'TEST-POLICY', '1000000', 'Synthetic coverage', 'Test review']:
            expect(self.page.get_by_text(text, exact=True)).to_be_visible()
        expect(self.page.get_by_text('certificate file download is unavailable', exact=False).first).to_be_visible()
        self.assertEqual(self.endpoint('/sub-qr/accept')[-1][2], {'token':SUB})
        self.assertEqual(len(self.endpoint('/gc/connections')), 2)
        self.assert_secret_transport()
        self.fail_list = True
        self.page.get_by_role('button', name='Refresh list').click()
        expect(self.page.get_by_role('alert').filter(has_text='Could not load')).to_contain_text('Could not load')
        self.assertEqual(self.page.get_by_text('Synthetic Carrier', exact=True).count(), 0)

    def test_camera_stops_and_does_not_navigate(self):
        self.context.add_init_script("""(() => {
          window.__stopped = false;
          Object.defineProperty(navigator, 'mediaDevices', {configurable: true, value: {getUserMedia: async () => ({getTracks: () => [{onended:null, stop() {window.__stopped=true}}]})}});
          HTMLMediaElement.prototype.play = async function() {};
          Object.defineProperties(HTMLVideoElement.prototype, {readyState:{configurable:true,get:()=>4},videoWidth:{configurable:true,get:()=>300},videoHeight:{configurable:true,get:()=>300},srcObject:{configurable:true,get(){return this.__s},set(v){this.__s=v}}});
          window.BarcodeDetector = class {static async getSupportedFormats(){return ['qr_code']} async detect(){return [{rawValue:location.origin+'/connect-sub#'+'b'.repeat(43)}]}};
        })()""")
        self.start(); self.page.get_by_role('button', name='Scan or paste a subcontractor QR').click(); self.page.get_by_role('button', name='Start camera').click()
        expect(self.page.get_by_text('Synthetic Sparks', exact=True)).to_be_visible()
        self.assertTrue(self.page.evaluate('window.__stopped'))
        self.assertNotIn('/connect-sub', self.page.url)
        self.assertEqual(self.endpoint('/sub-qr/preview')[-1][2], {'token': SUB})
        self.assert_secret_transport()

    def test_invitation_disabled_without_secure_recipient_route(self):
        self.start()
        expect(self.page.get_by_role('button', name='Create test invitation')).to_be_disabled()
        expect(self.page.get_by_role('alert')).to_contain_text('Recipient route is not configured')
        self.assertEqual(self.endpoint('/gc-invitations'), [])
        self.assertEqual(self.page.get_by_role('link', name='Open email draft').count(), 0)
    def test_raw_token_validation_and_manual_entry(self):
        self.start()
        self.page.get_by_role('button', name='Scan or paste a subcontractor QR').click()
        field = self.page.get_by_label('Or paste the raw prototype token or connection link')
        for value in ['b' * 42, 'b' * 44, '!' + 'b' * 42, ' ' + SUB, SUB + '/', 'https://evil.invalid/connect-sub#' + SUB]:
            field.fill(value)
            self.page.get_by_role('button', name='Look up').click()
            expect(self.page.get_by_role('alert').filter(has_text='not a valid')).to_contain_text('not a valid')
        self.assertFalse(self.endpoint('/sub-qr/preview'))
        field.fill(SUB)
        self.page.get_by_role('button', name='Look up').click()
        expect(self.page.get_by_text('Synthetic Sparks', exact=True)).to_be_visible()
        self.assertEqual(self.endpoint('/sub-qr/preview')[-1][2], {'token': SUB})
        self.assertNotIn(SUB, self.page.url)
    def test_gates_and_role(self):
        for name, role in [('off','gc'), ('prod','gc'), ('on','sub')]:
            with self.subTest(name=name, role=role):
                context = self.browser.new_context(); page = context.new_page(); calls = []
                page.route('**/api/**', lambda r: (calls.append(r.request.url), r.abort()))
                context.add_init_script(f"localStorage.setItem('coi_token','synthetic');localStorage.setItem('coi_user',{json.dumps(json.dumps({'role':role}))});")
                page.goto(self.origins[name] + PAGE); page.wait_for_timeout(250)
                self.assertEqual(page.get_by_text('GC relationship prototype').count(), 0)
                self.assertEqual(calls, [])
                context.close()

if __name__ == '__main__': unittest.main(verbosity=2)
