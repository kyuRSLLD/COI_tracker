"""Offline browser tests: python3 client/tests/test_staged_invitations.py
Requires npm dependencies, Python Playwright and Chromium. All API replies are synthetic;
external requests are blocked, and the Vite servers run locally with no backend.
Run npm run build first for the production gate test.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import unittest
from urllib.parse import urlsplit, parse_qs, unquote
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
TOKEN = 'a' * 43
SUB_TOKEN = 'b' * 43
NOTICE = 'Development preview — requests are not yet connected to the live subcontractor dashboard or COIs'
EXPIRES = '2099-01-01T00:00:00.000Z'

def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

def user(role):
    return {'id': 'test-user', 'email': 'person@example.invalid', 'name': 'Test Person', 'role': role}

class StagedInvitationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.servers = []
        cls.origins = {}
        for name, flag, preview in [('on', 'true', False), ('off', 'false', False), ('production', 'true', True)]:
            port = free_port()
            env = dict(os.environ, VITE_STAGED_INVITES_ENABLED=flag)
            cmd = [str(ROOT / 'node_modules/.bin/vite')]
            if preview: cmd += ['preview']
            cmd += ['--host', '127.0.0.1', '--port', str(port), '--strictPort']
            proc = subprocess.Popen(cmd, cwd=ROOT / 'client', env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            cls.servers.append(proc)
            origin = f'http://127.0.0.1:{port}'
            for _ in range(120):
                try:
                    with urlopen(origin, timeout=1): break
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
        for proc in cls.servers: proc.terminate(); proc.wait(timeout=5)

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 960, 'height': 850})
        self.page = self.context.new_page()
        self.requests = []
        self.role = None
        self.login_role = 'sub'
        self.accept_status = 'staged'
        self.page.route('**/*', self.route)

    def tearDown(self): self.context.close()

    def route(self, route):
        req = route.request
        parts = urlsplit(req.url)
        if parts.hostname != '127.0.0.1': return route.abort()
        if not parts.path.startswith('/api/'):
            return route.continue_()
        body = req.post_data_json if req.post_data else None
        self.requests.append((parts.path, req.method, body, req.url))
        path = parts.path
        status = 200
        if path == '/api/auth/me':
            if self.role: data = {'user': user(self.role)}
            else: status, data = 401, {'error': 'not signed in'}
        elif path == '/api/auth/login':
            self.role = self.login_role
            data = {'token': 'mock-auth-only', 'user': user(self.role)}
        elif path == '/api/subcontractors': data = {'subcontractors': []} if req.method == 'GET' else {'subcontractor': {'id': 'test-sub'}}
        elif path == '/api/settings': data = {'settings': {}}
        elif path == '/api/sub/my': data = {'subcontractor': {'company_name': 'Synthetic Sub', 'trade': 'Electrical'}, 'cois': [], 'requests': [], 'public_share_url': '/share/test'}
        elif path == '/api/sub/sent-emails': data = {'emails': []}
        elif path == '/api/invitations': data = {'id': 'test-gc-id', 'token': TOKEN, 'expires_at': EXPIRES}
        elif path == '/api/invitations/info': data = {'gc_company_name': 'Synthetic GC'}
        elif path == '/api/invitations/accept': data = {'status': self.accept_status}
        elif path == '/api/invitations/sub-qr' and req.method == 'POST': data = {'id': 'test-qr-id', 'token': SUB_TOKEN, 'expires_at': EXPIRES}
        elif path == '/api/invitations/sub-qr/info': data = {'company_name': 'Synthetic Sub', 'trade': 'Electrical'}
        elif path == '/api/invitations/sub-qr/accept': data = {'status': self.accept_status}
        elif path == '/api/invitations/sub-qr/test-qr-id' and req.method == 'DELETE': data = {'ok': True}
        else: status, data = 404, {'error': 'unmocked synthetic endpoint'}
        route.fulfill(status=status, content_type='application/json', body=json.dumps(data))

    def start(self, role, path='/subcontractors', server='on'):
        self.role = role
        if role:
            self.context.add_init_script("localStorage.setItem('coi_token','mock-auth-only'); localStorage.setItem('coi_user', " + json.dumps(json.dumps(user(role))) + ");")
        self.page.goto(self.origins[server] + path)

    def open_add(self):
        self.page.get_by_role('button', name='Add subcontractor', exact=True).first.click()

    def endpoint(self, path): return [r for r in self.requests if r[0] == path]

    def assert_no_token_in_network_url(self):
        self.assertTrue(all(TOKEN not in r[3] and SUB_TOKEN not in r[3] for r in self.requests))

    def test_gc_invitation_email_qr_and_manual_add(self):
        self.start('gc'); self.open_add()
        self.page.get_by_role('button', name='Invite', exact=True).click()
        expect(self.page.get_by_text(NOTICE)).to_be_visible()
        self.page.get_by_role('button', name='Create invitation').click()
        expect(self.page.get_by_text('Scan or share this invitation')).to_be_visible()
        self.assertEqual(self.endpoint('/api/invitations')[0][1:3], ('POST', {'max_uses': 1}))
        link = self.origins['on'] + '/invite-sub#' + TOKEN
        expect(self.page.get_by_text(link, exact=True)).to_be_visible()
        self.assertEqual(self.page.locator('svg[aria-label="Subcontractor invitation QR code"]').count() + self.page.locator('svg title').filter(has_text='Subcontractor invitation QR code').count(), 1)
        self.page.get_by_label('Recipient email').fill('recipient@example.invalid')
        draft = self.page.get_by_role('link', name='Open email draft')
        parsed = urlsplit(draft.get_attribute('href'))
        self.assertEqual(unquote(parsed.path), 'recipient@example.invalid')
        self.assertIn(link, parse_qs(parsed.query)['body'][0])
        expect(self.page.get_by_text('This opens a draft', exact=False)).to_be_visible()
        self.assertFalse(any('email' in r[0] for r in self.requests))
        self.page.get_by_role('button', name='Manual add').click()
        self.page.locator('input[placeholder="e.g. Horizon Electrical Services"]').fill('Synthetic Manual Co')
        self.page.get_by_role('button', name='Add subcontractor', exact=True).last.click()
        expect(self.page.get_by_text('Subcontractor saved')).to_be_visible()
        self.assertTrue(any(r[1] == 'POST' and r[2]['company_name'] == 'Synthetic Manual Co' for r in self.endpoint('/api/subcontractors')))
        self.assert_no_token_in_network_url()

    def test_scanner_rejects_unsafe_links_and_confirms_staged_only(self):
        self.start('gc'); self.open_add(); self.page.get_by_role('button', name='Scan subcontractor QR').click()
        self.page.get_by_role('button', name='Start camera').click()
        expect(self.page.get_by_role('alert')).to_contain_text('Camera', timeout=10000)
        field = self.page.get_by_label('Or paste the connection link')
        bad = [f'https://evil.invalid/connect-sub#{SUB_TOKEN}', f'{self.origins["on"]}/connect-sub/{SUB_TOKEN}', f'{self.origins["on"]}/connect-sub?token={SUB_TOKEN}', f'{self.origins["on"]}/connect-sub?x=1#{SUB_TOKEN}', f'javascript:/connect-sub#{SUB_TOKEN}', f'//evil.invalid/connect-sub#{SUB_TOKEN}']
        for value in bad:
            field.fill(value); self.page.get_by_role('button', name='Look up').click()
            expect(self.page.get_by_role('alert')).to_contain_text('not a valid')
        self.assertEqual(len(self.endpoint('/api/invitations/sub-qr/info')), 0)
        field.fill(self.origins['on'] + '/connect-sub#' + SUB_TOKEN)
        self.page.get_by_role('button', name='Look up').click()
        expect(self.page.get_by_text('Synthetic Sub', exact=True)).to_be_visible()
        self.assertEqual(self.endpoint('/api/invitations/sub-qr/info')[0][2], {'token': SUB_TOKEN})
        self.accept_status = 'unexpected'
        self.page.get_by_role('button', name='Confirm test relationship').click()
        expect(self.page.get_by_role('alert')).to_contain_text('Unable to record')
        self.accept_status = 'staged'
        self.page.get_by_role('button', name='Confirm test relationship').click()
        expect(self.page.get_by_role('status').filter(has_text='Test relationship recorded')).to_be_visible()
        self.assertEqual(self.endpoint('/api/invitations/sub-qr/accept')[-1][2], {'token': SUB_TOKEN})
        self.assert_no_token_in_network_url()

    def test_camera_scans_a_synthetic_qr_without_navigation(self):
        self.context.add_init_script("""(() => {
          window.__testStopped = false;
          Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
            getUserMedia: async () => ({ getTracks: () => [{ onended: null, stop() { window.__testStopped = true } }] })
          }});
          HTMLMediaElement.prototype.play = async function () {};
          Object.defineProperties(HTMLVideoElement.prototype, {
            readyState: { configurable: true, get: () => 4 },
            videoWidth: { configurable: true, get: () => 300 },
            videoHeight: { configurable: true, get: () => 300 },
            srcObject: { configurable: true, get() { return this.__source }, set(value) { this.__source = value } }
          });
          window.BarcodeDetector = class {
            static async getSupportedFormats() { return ['qr_code'] }
            async detect() { return [{rawValue: location.origin + '/connect-sub#' + 'b'.repeat(43)}] }
          };
        })()""")
        self.start('gc'); self.open_add(); self.page.get_by_role('button', name='Scan subcontractor QR').click()
        self.page.get_by_role('button', name='Start camera').click()
        expect(self.page.get_by_text('Synthetic Sub', exact=True)).to_be_visible()
        self.assertTrue(self.page.evaluate('window.__testStopped'))
        self.assertEqual(self.endpoint('/api/invitations/sub-qr/info')[-1][2], {'token': SUB_TOKEN})
        self.assertNotIn('/connect-sub', self.page.url)
        self.assert_no_token_in_network_url()

    def test_sub_opt_in_generate_and_revoke(self):
        self.start('sub', '/subcontractor')
        expect(self.page.get_by_text(NOTICE)).to_be_visible()
        self.assertEqual(len(self.endpoint('/api/invitations/sub-qr')), 0)
        self.page.get_by_label('Trade to share with the contractor').fill('Electrical')
        self.page.get_by_role('button', name='Generate connection code').click()
        expect(self.page.get_by_role('img', name='Connection QR code for a general contractor to scan')).to_be_visible()
        self.page.get_by_role('button', name='Revoke code').click()
        expect(self.page.get_by_role('status').filter(has_text='revoked')).to_be_visible()
        self.assertEqual(self.endpoint('/api/invitations/sub-qr/test-qr-id')[0][1], 'DELETE')
        self.assert_no_token_in_network_url()

    def test_recipient_fragment_login_confirm_and_cleanup(self):
        self.start(None, '/invite-sub#' + TOKEN)
        expect(self.page.get_by_text('Synthetic GC', exact=False)).to_be_visible()
        self.assertEqual(urlsplit(self.page.url).fragment, '')
        self.assertEqual(self.endpoint('/api/invitations/info')[-1][2], {'token': TOKEN})
        self.assertEqual(self.page.evaluate("sessionStorage.getItem('coi_staged_invite')"), TOKEN)
        self.page.get_by_label('Email').fill('person@example.invalid')
        self.page.get_by_label('Password').fill('synthetic-password')
        self.page.get_by_role('button', name='Sign in', exact=True).click()
        expect(self.page.get_by_text('Signed in as', exact=False)).to_be_visible()
        self.accept_status = 'unexpected'
        self.page.get_by_role('button', name='Confirm test relationship').click()
        expect(self.page.get_by_role('alert')).to_contain_text('Unable to record')
        self.accept_status = 'staged'
        self.page.get_by_role('button', name='Confirm test relationship').click()
        expect(self.page.get_by_role('status').filter(has_text='Test relationship recorded')).to_be_visible()
        self.assertIsNone(self.page.evaluate("sessionStorage.getItem('coi_staged_invite')"))
        self.assertEqual(self.endpoint('/api/invitations/accept')[-1][2], {'token': TOKEN})
        self.assertFalse(any('/api/sub/join' in r[0] for r in self.requests))
        self.assert_no_token_in_network_url()

    def test_pending_login_survives_reload_without_fragment(self):
        self.start(None, '/invite-sub#' + TOKEN)
        expect(self.page.get_by_text('Synthetic GC', exact=False)).to_be_visible()
        self.page.reload()
        expect(self.page.get_by_text('Synthetic GC', exact=False)).to_be_visible()
        self.assertEqual(self.page.evaluate("sessionStorage.getItem('coi_staged_invite')"), TOKEN)
        self.assertNotIn(TOKEN, self.page.url)
        self.assertFalse(any('/api/sub/join' in r[0] for r in self.requests))

    def test_sub_qr_hidden_for_non_sub(self):
        self.start('gc', '/subcontractor')
        expect(self.page.get_by_text('Synthetic Sub', exact=True)).to_be_visible()
        self.assertEqual(self.page.get_by_role('button', name='Generate connection code').count(), 0)
        self.assertEqual(len(self.endpoint('/api/invitations/sub-qr')), 0)

    def test_wrong_role_cannot_accept(self):
        self.start('gc', '/invite-sub#' + TOKEN)
        expect(self.page.get_by_role('button', name='Sign out and use a subcontractor account')).to_be_visible()
        self.assertEqual(self.page.get_by_role('button', name='Confirm test relationship').count(), 0)
        self.assertEqual(len(self.endpoint('/api/invitations/accept')), 0)

    def test_gate_disabled_and_production(self):
        for server in ['off', 'production']:
            with self.subTest(server=server):
                self.role = 'gc'; self.requests.clear()
                self.context.add_init_script("localStorage.setItem('coi_token','mock-auth-only'); localStorage.setItem('coi_user', " + json.dumps(json.dumps(user('gc'))) + ");")
                self.page.goto(self.origins[server] + '/subcontractors')
                self.open_add()
                self.assertEqual(self.page.get_by_role('button', name='Invite', exact=True).count(), 0)
                self.assertEqual(self.page.get_by_role('button', name='Scan subcontractor QR').count(), 0)
                self.page.goto(self.origins[server] + '/invite-sub#' + TOKEN)
                self.page.wait_for_timeout(250)
                self.assertNotIn(TOKEN, self.page.url)
                self.assertFalse(any(r[0].startswith('/api/invitations') or r[0].startswith('/api/sub/join') for r in self.requests))

if __name__ == '__main__': unittest.main(verbosity=2)
