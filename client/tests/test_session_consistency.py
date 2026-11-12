"""Offline regressions: python3 client/tests/test_session_consistency.py

The inherited isolated Vite/Playwright setup mocks every API request; no backend or
production data is used. Pages in each test share one browser storage context.
"""
import time
import unittest
from urllib.parse import urlsplit

import test_login_session as support

TOKEN, OLD_TOKEN = support.TOKEN, support.OLD_TOKEN

SUB_A = {'id': 'sub-a', 'email': 'a@example.invalid', 'name': 'Sub A', 'role': 'sub'}
SUB_B = {'id': 'sub-b', 'email': 'b@example.invalid', 'name': 'Sub B', 'role': 'sub'}
GC_A = {'id': 'gc-a', 'email': 'gc-a@example.invalid', 'name': 'GC A', 'role': 'gc'}
GC_B = {'id': 'gc-b', 'email': 'gc-b@example.invalid', 'name': 'GC B', 'role': 'gc'}


class ConsistencyTests(support.LoginSessionTests):
    def setUp(self):
        super().setUp()
        self.me_users = {OLD_TOKEN: SUB_A, TOKEN: SUB_B}
        self.hold_tokens = set()
        self.held_me = []
        self.hold_invites = set()
        self.held_invites = []
        self.hold_subs_for = set()
        self.held_subs = []
        self.join_status = 200
        self.password_status = 401
        self.password_error = 'Current password is incorrect'
        self.join_calls = []
        self.hold_join = False
        self.held_join = []

    def route(self, route):
        request = route.request
        path = urlsplit(request.url).path
        auth = request.headers.get('authorization', '')
        token = auth.removeprefix('Bearer ')
        if path == '/api/auth/me' and token in self.me_users:
            self.seen.append((request.method, path, auth))
            if token in self.hold_tokens:
                self.held_me.append((token, route))
                return
            return self.reply(route, {'user': self.me_users[token]})
        if path.startswith('/api/sub/join-info/'):
            self.seen.append((request.method, path, auth))
            code = path.rsplit('/', 1)[1]
            if code in self.hold_invites:
                self.held_invites.append((code, route))
                return
            return self.reply(route, self.invite(code))
        if path.startswith('/api/sub/join/'):
            self.seen.append((request.method, path, auth))
            self.join_calls.append((path, auth))
            if self.hold_join:
                self.held_join.append(route)
                return
            if self.join_status != 200:
                return self.reply(route, {'error': 'Unavailable' if self.join_status == 503 else 'Invalid or expired token'}, self.join_status)
            return self.reply(route, {'linked': True, 'gc_company_name': 'GC ' + path.rsplit('/', 1)[1]})
        if path == '/api/auth/change-password':
            self.seen.append((request.method, path, auth))
            return self.reply(route, {'error': self.password_error}, self.password_status)
        if path == '/api/subcontractors' and token in self.hold_subs_for:
            self.seen.append((request.method, path, auth))
            self.held_subs.append((token, route))
            return
        if path == '/api/subcontractors' and token in self.me_users:
            self.seen.append((request.method, path, auth))
            return self.reply(route, {'subcontractors': [{'id': 'new-sub', 'company_name': 'New GC Sub', 'trade': 'HVAC'}]})
        return super().route(route)

    @staticmethod
    def invite(code):
        return {'valid': True, 'invite_code': code, 'gc': {'company_name': 'GC ' + code}}

    def wait_until(self, predicate, message):
        end = time.monotonic() + 5
        while time.monotonic() < end:
            if predicate():
                return
            self.page.wait_for_timeout(50)
        self.fail(message)

    def seed(self, token):
        self.page.goto(self.origin + '/', wait_until='domcontentloaded')
        self.page.evaluate('(token) => localStorage.setItem("coi_token", token)', token)

    def navigate(self, path):
        self.page.evaluate('(path) => { history.pushState({}, "", path); dispatchEvent(new PopStateEvent("popstate")); }', path)

    def second_tab(self):
        page = self.context.new_page()
        page.goto(self.origin + '/', wait_until='domcontentloaded')
        return page

    def test_two_tabs_revalidate_and_bind_join_to_displayed_identity(self):
        self.seed(OLD_TOKEN)
        self.page.goto(self.origin + '/join/A')
        self.page.get_by_text(SUB_A['email'], exact=True).wait_for()
        self.page.get_by_role('checkbox').check()
        other = self.second_tab()
        self.hold_tokens.add(TOKEN)
        other.evaluate('(token) => localStorage.setItem("coi_token", token)', TOKEN)
        self.page.get_by_text('Checking your session…').wait_for()
        self.assertEqual(self.page.get_by_text(SUB_A['email'], exact=True).count(), 0)
        self.wait_until(lambda: any(t == TOKEN for t, _ in self.held_me), 'new session check missing')
        self.assertEqual(self.join_calls, [])
        self.hold_tokens.remove(TOKEN)
        for token, route in self.held_me:
            self.reply(route, {'user': self.me_users[token]})
        self.held_me.clear()
        self.page.get_by_text(SUB_B['email'], exact=True).wait_for()
        self.assertFalse(self.page.get_by_role('checkbox').is_checked())
        self.assertTrue(self.page.get_by_role('button', name='Connect my account to GC A').is_disabled())
        self.page.get_by_role('checkbox').check()
        self.page.get_by_role('button', name='Connect my account to GC A').click()
        self.page.get_by_text("You're now linked to GC A", exact=False).wait_for()
        self.assertEqual(self.join_calls, [('/api/sub/join/A', f'Bearer {TOKEN}')])

    def test_token_drift_before_storage_event_blocks_join(self):
        self.seed(OLD_TOKEN)
        self.page.goto(self.origin + '/join/A')
        self.page.get_by_text(SUB_A['email'], exact=True).wait_for()
        self.page.get_by_role('checkbox').check()
        self.hold_tokens.add(TOKEN)
        # Same-tab storage changes do not emit a storage event. Mutate and click
        # in the same JS task, before any re-render or cross-tab event can run.
        self.page.evaluate('''token => {
          localStorage.setItem('coi_token', token);
          [...document.querySelectorAll('button')].find(b => b.textContent.includes('Connect my account to')).click();
        }''', TOKEN)
        self.page.get_by_text('Checking your session…').wait_for()
        self.assertEqual(self.join_calls, [])
        self.assertEqual(self.page.evaluate('localStorage.getItem("coi_token")'), TOKEN)
        for token, route in self.held_me:
            self.reply(route, {'user': self.me_users[token]})
        self.held_me.clear()

    def test_changed_token_during_me_does_not_stick_checking(self):
        self.hold_tokens.add(OLD_TOKEN)
        self.seed(OLD_TOKEN)
        self.page.goto(self.origin + '/join/A')
        self.wait_until(lambda: any(t == OLD_TOKEN for t, _ in self.held_me), 'old /me missing')
        # No storage event in this page; completion must notice and revalidate.
        self.page.evaluate('(token) => localStorage.setItem("coi_token", token)', TOKEN)
        for _, route in self.held_me:
            self.reply(route, {'user': SUB_A})
        self.held_me.clear()
        self.page.get_by_text(SUB_B['email'], exact=True).wait_for(timeout=5000)
        self.assertEqual(self.page.get_by_text('Checking your session…').count(), 0)

    def test_invite_change_clears_consent_and_old_responses(self):
        self.seed(OLD_TOKEN)
        self.hold_invites.add('A')
        self.page.goto(self.origin + '/join/A')
        self.wait_until(lambda: len(self.held_invites) >= 2, 'expected held StrictMode invite requests')
        # Resolve one A response; the other is deliberately late.
        _, route = self.held_invites.pop()
        self.reply(route, self.invite('A'))
        self.page.get_by_text('GC A', exact=True).first.wait_for()
        self.page.get_by_text(SUB_A['email'], exact=True).wait_for()
        self.page.get_by_role('checkbox').check()
        self.hold_invites.add('B')
        self.navigate('/join/B')
        self.page.get_by_text('Loading invite…').wait_for()
        self.assertEqual(self.page.get_by_text('GC A', exact=True).count(), 0)
        self.assertEqual(self.page.get_by_role('checkbox').count(), 0)
        self.wait_until(lambda: any(c == 'B' for c, _ in self.held_invites), 'B request missing')
        for code, route in self.held_invites:
            if code == 'B':
                self.reply(route, self.invite('B'))
        self.held_invites = [(code, route) for code, route in self.held_invites if code != 'B']
        self.page.get_by_text('GC B', exact=True).first.wait_for()
        for _, route in self.held_invites:
            self.reply(route, self.invite('A'))
        self.held_invites.clear()
        self.page.wait_for_timeout(200)
        self.assertEqual(self.page.get_by_text('GC A', exact=True).count(), 0)
        self.assertFalse(self.page.get_by_role('checkbox').is_checked())
        self.assertTrue(self.page.get_by_role('button', name='Connect my account to GC B').is_disabled())
        self.page.get_by_role('checkbox').check()
        self.page.get_by_role('button', name='Connect my account to GC B').click()
        self.assertEqual(self.join_calls, [('/api/sub/join/B', f'Bearer {OLD_TOKEN}')])

    def test_delayed_invite_signup_cannot_replace_new_route_session(self):
        self.page.goto(self.origin + '/join/A')
        self.page.get_by_text('GC A', exact=True).first.wait_for()
        self.page.get_by_role('button', name='Existing account').click()
        self.page.get_by_role('checkbox').check()
        self.page.locator('input[type=email]').fill('old@example.invalid')
        self.page.locator('input[type=password]').fill('not-a-real-password')
        self.hold_join = True
        self.page.get_by_role('button', name='Sign in & link to GC A').click()
        self.wait_until(lambda: bool(self.held_join), 'old credential join missing')
        self.navigate('/join/B')
        self.page.get_by_text('GC B', exact=True).first.wait_for()
        for route in self.held_join:
            self.reply(route, {'linked': True, 'token': OLD_TOKEN, 'user': SUB_A, 'gc_company_name': 'GC A'})
        self.held_join.clear()
        self.page.wait_for_timeout(200)
        self.assertIsNone(self.page.evaluate('localStorage.getItem("coi_token")'))
        self.assertEqual(self.page.get_by_text(SUB_A['email'], exact=True).count(), 0)
        self.assertEqual(self.page.get_by_text('GC A', exact=True).count(), 0)
        self.assertFalse(self.page.get_by_role('checkbox').is_checked())

    def test_gc_sub_list_cannot_cross_session(self):
        self.me_users = {OLD_TOKEN: GC_A, TOKEN: GC_B}
        self.hold_subs_for.add(OLD_TOKEN)
        self.seed(OLD_TOKEN)
        self.page.goto(self.origin + '/dashboard')
        self.page.get_by_text(GC_A['email'], exact=True).first.wait_for()
        self.wait_until(lambda: bool(self.held_subs), 'old list request missing')
        other = self.second_tab()
        other.evaluate('(token) => localStorage.setItem("coi_token", token)', TOKEN)
        self.page.get_by_text(GC_B['email'], exact=True).first.wait_for()
        for _, route in self.held_subs:
            self.reply(route, {'subcontractors': [{'id': 'old-sub', 'company_name': 'Old GC Secret', 'trade': 'Old'}]})
        self.held_subs.clear()
        self.page.wait_for_timeout(200)
        self.page.get_by_title('Request certificate of insurance').click()
        self.page.locator('option').filter(has_text='New GC Sub').wait_for(state='attached')
        self.assertEqual(self.page.get_by_text('Old GC Secret', exact=False).count(), 0)

    def test_stale_401_cannot_log_out_new_session(self):
        self.seed(OLD_TOKEN)
        self.page.goto(self.origin + '/join/A')
        self.page.get_by_text(SUB_A['email'], exact=True).wait_for()
        self.page.get_by_role('checkbox').check()
        self.hold_join = True
        self.page.get_by_role('button', name='Connect my account to GC A').click()
        self.wait_until(lambda: bool(self.held_join), 'held join missing')
        other = self.second_tab()
        other.evaluate('(token) => localStorage.setItem("coi_token", token)', TOKEN)
        self.page.get_by_text(SUB_B['email'], exact=True).wait_for()
        for route in self.held_join:
            self.reply(route, {'error': 'Invalid or expired token'}, 401)
        self.held_join.clear()
        self.page.wait_for_timeout(200)
        self.assertEqual(self.page.evaluate('localStorage.getItem("coi_token")'), TOKEN)
        self.assertEqual(self.page.get_by_text(SUB_B['email'], exact=True).count(), 1)
        self.assertFalse(self.page.get_by_role('checkbox').is_checked())
        other.evaluate('localStorage.removeItem("coi_token")')
        self.page.get_by_role('button', name='Existing account').wait_for()
        self.assertEqual(self.page.get_by_text(SUB_B['email'], exact=True).count(), 0)

    def test_public_credential_401_does_not_log_out_session(self):
        self.seed(OLD_TOKEN)
        self.page.goto(self.origin + '/join/A')
        self.page.get_by_text(SUB_A['email'], exact=True).wait_for()
        self.join_status = 401
        result = self.page.evaluate('''async () => {
          const api = await import('/src/api.ts');
          try { await api.apiSub.join('B', { email: 'no@example.invalid', password: 'bad' }); }
          catch(e) { return e.status; }
        }''')
        self.assertEqual(result, 401)
        self.assertEqual(self.join_calls, [('/api/sub/join/B', '')])
        self.assertEqual(self.page.evaluate('localStorage.getItem("coi_token")'), OLD_TOKEN)
        self.assertEqual(self.page.get_by_text(SUB_A['email'], exact=True).count(), 1)

    def test_central_401_and_503_and_password_credential_rejection(self):
        self.seed(OLD_TOKEN)
        self.page.goto(self.origin + '/join/A')
        self.page.get_by_text(SUB_A['email'], exact=True).wait_for()
        self.page.get_by_role('checkbox').check()
        # Real credential rejection must not expire a valid bearer session.
        result = self.page.evaluate('''async () => {
          const api = await import('/src/api.ts');
          try { await api.apiChangePassword('bad', 'new-password'); } catch(e) { return e.message; }
        }''')
        self.assertEqual(result, 'Current password is incorrect')
        self.assertEqual(self.page.evaluate('localStorage.getItem("coi_token")'), OLD_TOKEN)
        self.join_status = 503
        self.page.get_by_role('button', name='Connect my account to GC A').click()
        self.page.get_by_role('alert').get_by_text('Unavailable').wait_for()
        self.assertEqual(self.page.evaluate('localStorage.getItem("coi_token")'), OLD_TOKEN)
        self.join_status = 401
        self.page.get_by_role('button', name='Connect my account to GC A').click()
        self.page.get_by_text('Your session has expired.', exact=False).wait_for()
        self.assertIsNone(self.page.evaluate('localStorage.getItem("coi_token")'))
        self.assertEqual(self.page.get_by_text(SUB_A['email'], exact=True).count(), 0)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ConsistencyTests(name) for name in ConsistencyTests.__dict__ if name.startswith('test_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
