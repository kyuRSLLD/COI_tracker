#!/usr/bin/env python3
"""Synthetic intercepted browser tests. Run only against loopback Vite port 5183."""
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

BASE = 'http://127.0.0.1:5183'
QR = 'A' * 43
OTHER = 'B' * 43
P1 = '11111111-1111-4111-8111-111111111111'
P2 = '22222222-2222-4222-8222-222222222222'


def make_handler(state, calls):
    def handler(route):
        request = route.request
        url = urlparse(request.url)
        assert url.netloc == '127.0.0.1:5183' and not url.query
        assert request.headers.get('authorization') in ('Bearer synthetic-gc-one', 'Bearer synthetic-gc-two')
        assert request.headers.get('referer') is None
        assert request.headers.get('cookie') is None
        calls.append((url.path, request.method, request.post_data_json if request.post_data else None, request.headers['authorization']))
        if url.path == '/api/v2/connections/qr/redeem':
            assert request.method == 'POST' and set(request.post_data_json) == {'token'}
            raw = request.post_data_json['token']
            if state.get('redeem_error'):
                return route.fulfill(status=state['redeem_error'], json={'error': 'not displayed'})
            if raw == QR and not state['redeemed']:
                state['redeemed'] = True
                return route.fulfill(status=204, body='')
            return route.fulfill(status=404, json={'error': 'Unavailable'})
        if url.path == '/api/v2/connections/subcontractors':
            if state.get('profiles_error'):
                return route.fulfill(status=state['profiles_error'], json={'error': 'private error'})
            if request.headers['authorization'].endswith('two'):
                return route.fulfill(json={'subcontractors': [{'id': 'two', 'profile_id': P2, 'company_name': 'Second GC company', 'trade': 'Roofing', 'evidence_type': 'fresh_self_asserted_email_control_v1'}]})
            rows = [{'id': 'one', 'profile_id': P1, 'company_name': 'Synthetic Electric', 'trade': 'Electrical', 'evidence_type': 'fresh_self_asserted_email_control_v1', 'secret': 'PROFILE_SECRET'}] if state['redeemed'] else []
            return route.fulfill(json={'subcontractors': rows})
        if url.path == '/api/v2/self-reported-coi-metadata/granted':
            if state.get('metadata_error'):
                return route.fulfill(status=state['metadata_error'], json={'error': 'private error'})
            if request.headers['authorization'].endswith('two'):
                return route.fulfill(json={'records': []})
            rows = [{'id': 'r1', 'profile_id': P1, 'carrier': 'Synthetic Carrier', 'effective_date': '2026-01-01', 'expiration_date': '2027-01-01', 'created_at': '2026-01-01T00:00:00.000Z', 'coverage': [{'type': 'General liability', 'limitCents': 100000000}], 'reporting_status': 'self_reported_unverified', 'file_url': 'PRIVATE_DOCUMENT'}, {'id': 'r2', 'profile_id': P2, 'carrier': 'Other tenant secret', 'effective_date': '2026-01-01', 'expiration_date': '2027-01-01', 'created_at': '2026-01-01T00:00:00.000Z', 'coverage': [], 'reporting_status': 'self_reported_unverified'}] if state['redeemed'] else []
            return route.fulfill(json={'records': rows})
        raise AssertionError('Unexpected/legacy API: ' + url.path)
    return handler


def setup(browser, script='', mobile=False):
    context = browser.new_context(viewport={'width': 390, 'height': 844} if mobile else {'width': 1280, 'height': 850})
    if script:
        context.add_init_script(script)
    page = context.new_page()
    state = {'redeemed': False}
    calls = []
    page.route('**/api/**', make_handler(state, calls))
    page.goto(BASE + '/tests/v2-gc/index.html')
    expect(page.get_by_text('No connected subcontractors are currently available.')).to_be_visible()
    return context, page, state, calls


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    scanner = """
      window.__value = '""" + QR + """';
      window.BarcodeDetector = class { constructor() {} async detect() { return [{rawValue: window.__value}]; } };
      Object.defineProperty(navigator, 'mediaDevices', {value: {getUserMedia: async () => {
        window.__stream = document.createElement('canvas').captureStream(); return window.__stream;
      }}, configurable: true});
      HTMLMediaElement.prototype.play = async function() {};
    """
    context, page, state, calls = setup(browser, scanner)
    page.get_by_role('button', name='Start camera').click()
    expect(page.get_by_text('Connected. Refreshing', exact=False)).to_be_visible()
    expect(page.get_by_role('heading', name='Synthetic Electric')).to_be_visible()
    expect(page.get_by_text('Synthetic Carrier')).to_be_visible()
    expect(page.get_by_text('$1,000,000.00', exact=False)).to_be_visible()
    assert page.evaluate("window.__stream.getTracks().every(t => t.readyState === 'ended')")
    assert [c[0] for c in calls].count('/api/v2/connections/subcontractors') == 2
    assert [c[0] for c in calls].count('/api/v2/self-reported-coi-metadata/granted') == 2
    assert [c for c in calls if c[0].endswith('/redeem')][0][2] == {'token': QR}
    assert 'Other tenant secret' not in page.content() and 'PRIVATE_DOCUMENT' not in page.content() and 'PROFILE_SECRET' not in page.content()
    assert QR not in page.url and QR not in page.content() and 'synthetic-gc-one' not in page.content()
    assert page.evaluate('Object.keys(localStorage).length + Object.keys(sessionStorage).length') == 0

    # Replay is deliberately indistinguishable from expiry and other unavailability.
    page.get_by_label('Raw one-time code').fill(QR)
    page.get_by_role('button', name='Connect', exact=True).click()
    expect(page.get_by_role('alert')).to_contain_text('expired, already been used')
    expect(page.get_by_label('Raw one-time code')).to_have_value('')
    count = len([c for c in calls if c[0].endswith('/redeem')])
    page.get_by_label('Raw one-time code').fill('https://malicious.example/?token=' + OTHER)
    page.get_by_role('button', name='Connect', exact=True).click()
    expect(page.get_by_role('alert')).to_contain_text('links and query strings are not accepted')
    assert len([c for c in calls if c[0].endswith('/redeem')]) == count
    page.evaluate("window.__value = 'https://malicious.example/?token=" + OTHER + "'")
    page.get_by_role('button', name='Start camera').click()
    expect(page.get_by_role('alert')).to_contain_text('links and query strings are not accepted')
    assert len([c for c in calls if c[0].endswith('/redeem')]) == count
    assert page.evaluate("window.__stream.getTracks().every(t => t.readyState === 'ended')")
    page.evaluate("window.__value = '" + QR + "\\n'")
    page.get_by_role('button', name='Start camera').click()
    expect(page.get_by_role('alert')).to_contain_text('Invalid code format')
    assert len([c for c in calls if c[0].endswith('/redeem')]) == count

    # Error clears stale metadata, and another account must not inherit prior account data.
    state['metadata_error'] = 503
    page.get_by_role('button', name='Refresh list').click()
    expect(page.get_by_text('Granted metadata: This information is unavailable', exact=False)).to_be_visible()
    assert 'Synthetic Carrier' not in page.content()
    state['metadata_error'] = 0
    page.get_by_role('button', name='Switch synthetic account').click()
    expect(page.get_by_role('heading', name='Second GC company')).to_be_visible()
    assert 'Synthetic Electric' not in page.content() and 'Synthetic Carrier' not in page.content()
    expect(page.get_by_text('No explicitly granted metadata is currently available', exact=False)).to_be_visible()
    context.close()

    # Permission denied leaves an actionable manual path; manual success also refreshes.
    denial = """
      window.BarcodeDetector = class { async detect() { return []; } };
      Object.defineProperty(navigator, 'mediaDevices', {value: {getUserMedia: async () => { throw new DOMException('denied', 'NotAllowedError') }}, configurable: true});
    """
    context, page, state, calls = setup(browser, denial, mobile=True)
    page.get_by_role('button', name='Start camera').click()
    expect(page.get_by_role('alert')).to_contain_text('Camera permission was denied')
    page.get_by_label('Raw one-time code').fill(QR)
    page.get_by_role('button', name='Connect', exact=True).click()
    expect(page.get_by_role('heading', name='Synthetic Electric')).to_be_visible()
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    state['profiles_error'] = 401
    page.get_by_role('button', name='Refresh list').click()
    expect(page.get_by_role('alert')).to_contain_text('Sign in again')
    assert 'Synthetic Electric' not in page.content() and 'Synthetic Carrier' not in page.content()
    state['profiles_error'] = 0
    state['redeem_error'] = 503
    page.get_by_label('Raw one-time code').fill(OTHER)
    page.get_by_role('button', name='Connect', exact=True).click()
    expect(page.get_by_text('The connection could not be confirmed.', exact=False)).to_contain_text('may have been consumed')
    context.close()

    # Unsupported browser falls back to manual entry without issuing a request.
    unsupported = "delete window.BarcodeDetector;"
    context, page, state, calls = setup(browser, unsupported)
    page.get_by_role('button', name='Start camera').click()
    expect(page.get_by_role('alert')).to_contain_text('not supported')
    assert not any(c[0].endswith('/redeem') for c in calls)
    page.get_by_label('Raw one-time code').fill(QR)
    page.get_by_role('button', name='Connect', exact=True).click()
    expect(page.get_by_role('heading', name='Synthetic Electric')).to_be_visible()
    context.close()

    # Delayed old-account replies cannot overwrite or disclose data after a credential change,
    # even if an underlying transport ignores cancellation and resolves late.
    delayed = """
      const originalFetch = window.fetch;
      window.__slow = false; window.__delayed = 0;
      window.__gate = new Promise(resolve => { window.__release = resolve; });
      window.fetch = async (url, init) => {
        const response = await originalFetch(url, init);
        if (window.__slow && init.headers.Authorization === 'Bearer synthetic-gc-one' && init.method === 'GET') {
          window.__delayed++; await window.__gate;
        }
        return response;
      };
    """
    context, page, state, calls = setup(browser, delayed)
    page.get_by_label('Raw one-time code').fill(QR)
    page.get_by_role('button', name='Connect', exact=True).click()
    expect(page.get_by_role('heading', name='Synthetic Electric')).to_be_visible()
    page.evaluate('window.__slow = true')
    page.get_by_role('button', name='Refresh list').click()
    page.wait_for_function('window.__delayed === 2')
    page.get_by_role('button', name='Switch synthetic account').click()
    expect(page.get_by_role('heading', name='Second GC company')).to_be_visible()
    page.evaluate('window.__release()')
    page.wait_for_timeout(250)
    assert 'Synthetic Electric' not in page.content() and 'Synthetic Carrier' not in page.content()
    context.close()
    browser.close()
print('PASS: synthetic camera/manual redemption, automatic refresh, replay, hostile QR rejection, denial/fallback, scoped grants, error states, account isolation, storage and mobile')
