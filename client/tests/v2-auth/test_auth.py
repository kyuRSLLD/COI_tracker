#!/usr/bin/env python3
"""Synthetic, intercepted tests only. Run against the isolated Vite preview on 127.0.0.1:5178."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = 'http://127.0.0.1:5178'
OUT = Path(__file__).parent / 'screenshots'
OUT.mkdir(exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1365, 'height': 900})
    page = context.new_page()
    calls = []
    response = {'status': 200, 'body': {}}
    def intercept(route):
        req = route.request
        calls.append({'path': req.url.removeprefix(BASE), 'body': req.post_data_json, 'headers': req.headers})
        if response.get('abort'):
            route.abort('failed')
        else:
            route.fulfill(status=response['status'], json=response['body'])
    page.route('**/api/v2/auth/**', intercept)
    page.goto(BASE + '/v2-auth-preview/index.html')
    expect(page.get_by_role('heading', name='Sign in to your account')).to_be_visible()
    page.screenshot(path=str(OUT / 'sign-in-desktop.png'), full_page=True)
    page.get_by_label('Email address').fill('Synthetic@Example.com')
    page.get_by_label('Password').fill('wrong')
    response.update(status=401, body={'error': '<img src=x onerror=alert(1)>'})
    page.get_by_role('button', name='Sign in', exact=True).click()
    expect(page.get_by_role('alert')).to_contain_text('could not be verified')
    assert calls[-1]['path'] == '/api/v2/auth/login'
    assert calls[-1]['body'] == {'email': 'synthetic@example.com', 'password': 'wrong'}
    assert '<img' not in page.locator('body').inner_text()
    response.update(status=503, body={'error': 'Authentication unavailable'})
    page.get_by_role('button', name='Sign in', exact=True).click()
    expect(page.get_by_role('alert')).to_contain_text('unavailable')
    response.update(status=200, body={'token': 'not-a-jwt', 'token_type': 'Bearer', 'expires_in': 900})
    page.get_by_role('button', name='Sign in', exact=True).click()
    expect(page.get_by_role('alert')).to_contain_text('unavailable')

    page.get_by_role('button', name='Create account').click()
    assert page.evaluate('document.activeElement.id') == 'v2-auth-heading'
    response['abort'] = True
    page.get_by_role('button', name='Send verification code').click()
    expect(page.get_by_role('alert')).to_contain_text('may or may not have been sent')
    del response['abort']
    response.update(status=503, body={'error': 'Registration unavailable'})
    page.get_by_role('button', name='Send verification code').click()
    expect(page.get_by_role('alert')).to_contain_text('unavailable')
    expect(page.get_by_role('heading', name='Create an account')).to_be_visible()
    response.update(status=202, body={'message': 'If eligible, check your email for next steps.'})
    page.get_by_role('button', name='Send verification code').click()
    expect(page.get_by_role('heading', name='Complete your registration')).to_be_visible()
    assert calls[-1]['body'] == {'email': 'synthetic@example.com'}
    assert calls[-1]['path'] == '/api/v2/auth/register/request'
    page.screenshot(path=str(OUT / 'registration-desktop.png'), full_page=True)
    code = 'A' * 43
    page.get_by_label('Verification code').fill(code)
    page.get_by_label('First name').fill('Test')
    page.get_by_label('Last name').fill('User')
    page.get_by_label('US phone number').fill('(312) 555-0199')
    page.get_by_label('Password').fill('short')
    before = len(calls)
    page.get_by_role('button', name='Submit registration').click()
    expect(page.get_by_role('alert')).to_contain_text('at least 12 characters')
    assert len(calls) == before
    page.get_by_label('Password').fill('a synthetic password')
    page.get_by_label('Verification code').fill('A' * 42 + 'B')
    page.get_by_role('button', name='Submit registration').click()
    expect(page.get_by_role('alert')).to_contain_text('43-character')
    assert len(calls) == before
    page.get_by_label('Verification code').fill(code)
    response.update(status=400, body={'error': 'Invalid request'})
    page.get_by_role('button', name='Submit registration').click()
    expect(page.get_by_role('alert')).to_contain_text('Check the code and your details')
    response['abort'] = True
    page.get_by_role('button', name='Submit registration').click()
    expect(page.get_by_role('alert')).to_contain_text('could not confirm the outcome')
    del response['abort']
    response.update(status=503, body={'error': 'Registration unavailable'})
    page.get_by_role('button', name='Submit registration').click()
    expect(page.get_by_role('alert')).to_contain_text('could not confirm the outcome')
    gc_body = calls[-1]['body']
    assert gc_body == {'token': code, 'role': 'gc', 'password': 'a synthetic password', 'first_name': 'Test', 'last_name': 'User', 'phone': '(312) 555-0199'}
    assert calls[-1]['path'] == '/api/v2/auth/register/confirm'
    page.get_by_role('radio', name='Subcontractor').check()
    page.get_by_label('Company name').fill('Example Co')
    page.get_by_label('Trade').fill('Electrical')
    response.update(status=200, body={'message': 'If eligible, registration is complete. You may try signing in.'})
    page.get_by_role('button', name='Submit registration').click()
    expect(page.get_by_role('heading', name='Try signing in')).to_be_visible()
    expect(page.get_by_text('Account creation is not confirmed', exact=False)).to_be_visible()
    assert calls[-1]['body'] == {**gc_body, 'role': 'sub', 'company_name': 'Example Co', 'trade': 'Electrical'}
    assert code not in page.url and code not in page.content()
    assert page.evaluate('Object.keys(localStorage).length') == 0
    assert page.evaluate('Object.keys(sessionStorage).length') == 0
    page.get_by_role('button', name='Go to sign in').click()
    expect(page.get_by_label('Password')).to_have_value('')
    page.get_by_label('Password').fill('a synthetic password')
    response.update(status=200, body={'token': 'header.payload.signature', 'token_type': 'Bearer', 'expires_in': 900})
    page.get_by_role('button', name='Sign in', exact=True).click()
    expect(page.get_by_role('heading', name='Signed in')).to_be_visible()
    assert 'header.payload.signature' not in page.content() and 'header.payload.signature' not in page.url
    assert page.evaluate('Object.keys(localStorage).length + Object.keys(sessionStorage).length') == 0
    context.close()

    # A test-only host verifies the callback received exactly the synthetic session.
    context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    page = context.new_page()
    page.route('**/api/v2/auth/login', lambda route: route.fulfill(status=200, json={'token': 'header.payload.signature', 'token_type': 'Bearer', 'expires_in': 900}))
    page.goto(BASE + '/tests/v2-auth/callback.html')
    page.screenshot(path=str(OUT / 'sign-in-mobile.png'), full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    page.route('**/api/v2/auth/register/request', lambda route: route.fulfill(status=202, json={'message': 'If eligible, check your email for next steps.'}))
    page.get_by_role('button', name='Create account').click()
    page.get_by_label('Email address').fill('synthetic@example.com')
    page.get_by_role('button', name='Send verification code').click()
    expect(page.get_by_role('heading', name='Complete your registration')).to_be_visible()
    page.screenshot(path=str(OUT / 'registration-mobile.png'), full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    page.get_by_role('button', name='Sign in', exact=True).click()
    page.get_by_label('Email address').fill('synthetic@example.com')
    page.get_by_label('Password').fill('a synthetic password')
    page.get_by_role('button', name='Sign in', exact=True).click()
    expect(page.get_by_test_id('callback-result')).to_be_visible()
    assert 'header.payload.signature' not in page.content()
    context.close()
    browser.close()
print('PASS: synthetic login, request, GC/sub confirmation, validation, ambiguous failures, callback, storage, XSS-safe text and responsive layout')
