"""Synthetic browser-only OCR tests; run: python3 client/tests/test_coi_ocr.py.

Requires Python Playwright and Chromium. No actual insurance data is used.
"""
import os
from pathlib import Path
import socket
import subprocess
import time
import unittest
from urllib.request import urlopen
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
SYNTHETIC_FORM = (ROOT / 'client/tests/synthetic_coi.js').read_text()


class CoiOcrTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            cls.port = sock.getsockname()[1]
        cls.origin = f'http://127.0.0.1:{cls.port}'
        cls.server = subprocess.Popen(
            [str(ROOT / 'node_modules/.bin/vite'), '--host', '127.0.0.1', '--port', str(cls.port), '--strictPort', '--base', '/nested/'],
            cwd=ROOT / 'client', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                with urlopen(cls.origin + '/nested/', timeout=1):
                    break
            except Exception:
                time.sleep(.1)
        else:
            raise RuntimeError('Vite did not start')
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(executable_path=os.environ.get('CHROME_BIN', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.terminate()
        cls.server.wait(timeout=10)

    def setUp(self):
        self.context = self.browser.new_context()
        self.external = []
        self.requests = []
        def route(r):
            req = r.request
            if not req.url.startswith(self.origin + '/'):
                self.external.append(req.url)
                r.abort()
            elif req.url == self.origin + '/nested/ocr-harness.html':
                r.fulfill(status=200, content_type='text/html', body='<!doctype html><title>OCR test</title>')
            else:
                self.requests.append((req.method, req.url))
                if req.method != 'GET':
                    r.abort()
                else:
                    r.continue_()
        self.context.route('**/*', route)
        self.page = self.context.new_page()
        self.page.goto(self.origin + '/nested/ocr-harness.html', wait_until='domcontentloaded')

    def tearDown(self):
        self.assertEqual(self.external, [], 'OCR must never call a third-party origin')
        self.assertTrue(all(method == 'GET' for method, _ in self.requests), 'OCR must not upload')
        self.context.close()

    def test_real_ocr_synthetic_png(self):
        console = []
        self.page.on('console', lambda msg: console.append(msg.text))
        result = self.page.evaluate('''async () => {
          const { extractCoiImage } = await import('/nested/src/lib/coiOcr.ts');
          const canvas = document.createElement('canvas'); canvas.width = 1400; canvas.height = 350;
          const c = canvas.getContext('2d'); c.fillStyle = 'white'; c.fillRect(0, 0, 1400, 350);
          c.fillStyle = 'black'; c.font = 'bold 48px Arial';
          c.fillText('PRODUCER: SAMPLE AGENCY', 50, 85);
          c.fillText('INSURED: SAMPLE CONTRACTOR', 50, 165);
          c.fillText('PRODUCER PHONE: 212-555-1234', 50, 245);
          const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
          const progress = [];
          const result = await extractCoiImage(new File([blob], 'synthetic.png', {type: 'image/png'}), p => progress.push(p));
          return {result, progress};
        }''')
        details = result['result']['details']
        self.assertIn('SAMPLE AGENCY', result['result']['rawText'])
        self.assertEqual(details['producer']['name'], 'SAMPLE AGENCY')
        self.assertEqual(details['insured']['name'], 'SAMPLE CONTRACTOR')
        self.assertEqual(details['source'], 'ocr')
        self.assertEqual(result['progress'][-1], 1)
        self.assertEqual(sorted(result['progress']), result['progress'])
        self.assertTrue(result['result']['warnings'])
        paths = [url for _, url in self.requests]
        self.assertTrue(any('/nested/ocr/supervisor.js' in url for url in paths))
        self.assertTrue(any('/nested/ocr/lang/eng.traineddata' in url for url in paths))
        self.assertTrue(any('/nested/ocr/core/tesseract-core-' in url for url in paths))
        self.assertNotIn('SAMPLE AGENCY', '\n'.join(console))
        self.assertNotIn('SAMPLE CONTRACTOR', '\n'.join(console))
        print('Synthetic PNG: real local Tesseract OCR recognized producer and insured.')

    def run_form(self, options=None, mime='image/png'):
        return self.page.evaluate('''async ({source, options, mime}) => {
          const {extractCoiImage} = await import('/nested/src/lib/coiOcr.ts');
          const canvas = (eval(source))(options);
          const blob = await new Promise(r => canvas.toBlob(r, mime, 0.98));
          return extractCoiImage(new File([blob], mime === 'image/png' ? 'form.png' : 'form.jpg', {type: mime}));
        }''', {'source': SYNTHETIC_FORM, 'options': options or {}, 'mime': mime})

    def test_real_ocr_multicolumn_form(self):
        result = self.run_form()
        details = result['details']
        self.assertEqual(details['source'], 'ocr')
        self.assertTrue(result['warnings'])
        self.assertEqual(details['producer']['name'], 'Northwood Sample Agency')
        self.assertEqual(details['insured']['name'], 'Orchard Example Builders LLC')
        self.assertEqual(details['insurers'], [
            {'letter': 'A', 'name': 'Example Harbor Insurance Co', 'naic': '01234'},
            {'letter': 'B', 'name': 'Fictional Meadow Mutual', 'naic': '56789'},
            {'letter': 'C', 'name': 'Synthetic Valley Casualty', 'naic': '23456'},
        ])
        policies = details['policies']
        self.assertEqual([p['type'] for p in policies], [
            'Commercial General Liability', 'Automobile Liability', 'Umbrella Liability',
            'Workers Compensation and Employers Liability'])
        self.assertEqual([p['policyNumber'] for p in policies], ['GL-1000123', 'AU-2000456', 'UM-3000789', 'WC-4000123'])
        self.assertEqual([p['effectiveDate'] for p in policies], ['01/01/2026', '02/01/2026', '03/01/2026', '04/01/2026'])
        self.assertEqual([p['expirationDate'] for p in policies], ['01/01/2027', '02/01/2027', '03/01/2027', '04/01/2027'])
        self.assertEqual(policies[0]['insurerLetter'], 'A')
        self.assertEqual(policies[0]['limits'], [
            {'label': 'each occurrence', 'amount': '$1,000,000'},
            {'label': 'general aggregate', 'amount': '$2,000,000'},
            {'label': 'products - comp/op agg', 'amount': '$2,000,000'},
        ])
        self.assertEqual(policies[1]['limits'], [{'label': 'combined single limit', 'amount': '$3,000,000'}])
        self.assertEqual(policies[2]['limits'], [
            {'label': 'each occurrence', 'amount': '$4,000,000'},
            {'label': 'aggregate', 'amount': '$4,000,000'},
        ])
        self.assertEqual(policies[3]['limits'], [
            {'label': 'e.l. each accident', 'amount': '$500,000'},
            {'label': 'e.l. disease - policy limit', 'amount': '$500,000'},
        ])

    def test_real_ocr_ambiguous_policy_and_limit_stay_blank(self):
        result = self.run_form({'duplicatePolicy': True, 'duplicateLimit': True})
        policies = result['details']['policies']
        general = policies[0]
        self.assertEqual(general['type'], 'Commercial General Liability')
        self.assertEqual(general['policyNumber'], '')
        self.assertEqual(general['effectiveDate'], '')
        self.assertEqual(general['expirationDate'], '')
        self.assertEqual(general['insurerLetter'], '')
        self.assertEqual(general['limits'], [])
        self.assertEqual(policies[1]['policyNumber'], 'AU-2000456')
        self.assertEqual(policies[1]['limits'], [{'label': 'combined single limit', 'amount': '$3,000,000'}])
        self.assertTrue(result['warnings'])

    def test_real_ocr_multicolumn_jpeg(self):
        result = self.run_form(mime='image/jpeg')
        self.assertEqual(result['details']['producer']['name'], 'Northwood Sample Agency')
        self.assertEqual(result['details']['insured']['name'], 'Orchard Example Builders LLC')
        self.assertEqual([p['policyNumber'] for p in result['details']['policies']], ['GL-1000123', 'AU-2000456', 'UM-3000789', 'WC-4000123'])
        self.assertEqual(result['details']['policies'][1]['limits'], [{'label': 'combined single limit', 'amount': '$3,000,000'}])

    def test_real_ocr_shifted_scaled_form_with_different_values(self):
        result = self.run_form({'variant': True})
        d = result['details']
        self.assertEqual(d['producer']['name'], 'Fictional Pine Brokerage')
        self.assertEqual(d['insured']['name'], 'Sample Brickworks Inc')
        self.assertEqual(d['insurers'][0], {'letter': 'A', 'name': 'Mock River Insurance Co', 'naic': '09876'})
        self.assertEqual([p['policyNumber'] for p in d['policies']], ['TEST-7654321', 'AUTO-7654321', 'UMB-7654321', 'WORK-7654321'])
        self.assertEqual([p['effectiveDate'] for p in d['policies']], ['05/01/2026', '06/01/2026', '07/01/2026', '08/01/2026'])
        self.assertEqual(d['policies'][2]['limits'][0], {'label': 'each occurrence', 'amount': '$4,000,000'})

    def test_real_ocr_orphan_amount_does_not_attach_to_a_limit(self):
        result = self.run_form({'duplicateLimit': True})
        general = result['details']['policies'][0]
        self.assertEqual(general['policyNumber'], 'GL-1000123')
        self.assertEqual(general['limits'], [])
        self.assertEqual(result['details']['policies'][1]['limits'][0]['amount'], '$3,000,000')

    def test_layout_adversarial_geometry(self):
        cases = self.page.evaluate('''async () => {
          const {extractCoiFieldsFromLayout} = await import('/nested/src/lib/coiOcrLayout.ts');
          function make(kind) {
            const rows=[];
            const add=(text,x,y,w=70,confidence=95) => rows.push(`5\\t1\\t1\\t1\\t1\\t1\\t${x}\\t${y}\\t${w}\\t20\\t${confidence}\\t${text}`);
            add('INSR',50,665,45); add('TYPE',145,678,62); add('OF',215,678,32); add('INSURANCE',256,678,140);
            add('POLICY',882,678,87); add('NUMBER',978,678,103);
            add('POLICY',1222,663,83); add('EFF',1314,663,41);
            if(kind !== 'missing-header') { add('POLICY',1482,663,83); add('EXP',1574,663,43); }
            add('LIMITS',1802,678,76);
            add('A',70,750,18); add('COMMERCIAL',146,750,177); add('GENERAL',332,750,126); add('LIABILITY',467,750,122);
            add('GL-1000123',876,750,153); add('01/01/2026',1221,kind === 'off-row' ? 785 : 750,138); add('01/01/2027',1481,750,138);
            add('EACH',1752,750,66); add('OCCURRENCE',1828,750,177); add('$',2161,750,12); add('1,000,000',2183,750,108);
            if(kind === 'conflicting-dates') add('02/30/2026',1221,810,138);
            if(kind === 'competing-amounts') { add('$',2010,750,12); add('9,000,000',2040,750,108); }
            if(kind === 'other-coverage') {
              add('OTHER',145,850,95); add('RISK',250,850,60);
              add('EACH',1752,850,66); add('OCCURRENCE',1828,850,177); add('$',2161,850,12); add('9,000,000',2183,850,108);
            }
            if(kind !== 'missing-bottom') { add('DESCRIPTION',57,1673,160); add('OF',227,1673,31); add('OPERATIONS',267,1673,155); }
            return extractCoiFieldsFromLayout(rows.join('\\n'),2400,1900);
          }
          return Object.fromEntries(['normal','missing-header','missing-bottom','off-row','conflicting-dates','competing-amounts','other-coverage'].map(k => [k,make(k)]));
        }''')
        self.assertEqual(cases['normal']['policies'][0]['limits'], [{'label': 'each occurrence', 'amount': '$1,000,000'}])
        self.assertEqual(cases['missing-header']['policies'], [])
        self.assertEqual(cases['missing-bottom']['policies'], [])
        self.assertEqual(cases['off-row']['policies'][0]['effectiveDate'], '')
        self.assertEqual(cases['conflicting-dates']['policies'][0]['policyNumber'], '')
        self.assertEqual(cases['conflicting-dates']['policies'][0]['limits'], [])
        self.assertEqual(cases['competing-amounts']['policies'][0]['limits'], [])
        self.assertEqual(cases['other-coverage']['policies'][0]['limits'], [{'label': 'each occurrence', 'amount': '$1,000,000'}])

    def test_conservative_text_parser(self):
        details = self.page.evaluate('''async () => {
          const {extractCoiFieldsFromText} = await import('/nested/src/lib/coiOcr.ts');
          return extractCoiFieldsFromText(`PRODUCER: Example Broker\nPRODUCER ADDRESS: 10 Test Ave\nPRODUCER EMAIL: fake@example.com\nINSURED: Sample Builders\nINSURER A: Test Carrier | NAIC: 00123\nPOLICY TYPE: General Liability | INSURER LETTER: A | POLICY NUMBER: 000012-03 | EFFECTIVE DATE: 01/02/2026 | EXPIRATION DATE: 01/02/2027 | LIMIT EACH OCCURRENCE: $1,000,000\nGENERAL LIABILITY B 009 02/03/2026 02/03/2027\n`);
        }''')
        self.assertEqual(details['insurers'], [{'letter': 'A', 'name': 'Test Carrier', 'naic': '00123'}])
        self.assertEqual(len(details['policies']), 1)
        self.assertEqual(details['policies'][0]['policyNumber'], '000012-03')
        self.assertEqual(details['policies'][0]['effectiveDate'], '01/02/2026')
        self.assertEqual(details['policies'][0]['limits'], [{'label': 'each occurrence', 'amount': '$1,000,000'}])
        ambiguous = self.page.evaluate('''async () => {
          const {extractCoiFieldsFromText} = await import('/nested/src/lib/coiOcr.ts');
          return extractCoiFieldsFromText(`PRODUCER: ONE\nPRODUCER: TWO\nINSURER A: Alpha\nINSURER A: Beta\nGENERAL LIABILITY A ABC123 01/01/2026 01/01/2027\nPOLICY TYPE: General Liability | INSURER LETTER: AB | POLICY NUMBER: UNKNOWN | EFFECTIVE DATE: 02/30/2026 | EXPIRATION DATE: 2027-01-01`);
        }''')
        self.assertEqual(ambiguous['producer']['name'], '')
        self.assertEqual(ambiguous['insurers'], [])
        self.assertEqual(len(ambiguous['policies']), 1)
        self.assertEqual(ambiguous['policies'][0]['insurerLetter'], '')
        self.assertEqual(ambiguous['policies'][0]['policyNumber'], '')
        self.assertEqual(ambiguous['policies'][0]['effectiveDate'], '')
        self.assertEqual(ambiguous['policies'][0]['expirationDate'], '2027-01-01')

    def test_fallbacks_timeout_and_cancellation(self):
        results = self.page.evaluate('''async () => {
          const {extractCoiImage} = await import('/nested/src/lib/coiOcr.ts');
          const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 100;
          const c = canvas.getContext('2d'); c.fillStyle = 'white'; c.fillRect(0,0,300,100); c.fillStyle = 'black'; c.font = '20px Arial'; c.fillText('Synthetic test',10,40);
          const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
          const good = new File([blob], 'test.png', {type:'image/png'});
          const b = new Uint8Array(await blob.arrayBuffer()); new DataView(b.buffer).setUint32(16, 6001);
          const pdf = await extractCoiImage(new File(['%PDF-1.4'], 'test.pdf', {type:'application/pdf'}));
          const disguisedPdf = await extractCoiImage(new File(['%PDF-1.4'], 'test.png', {type:'image/png'}));
          const invalid = await extractCoiImage(new File(['not png'], 'test.png', {type:'image/png'}));
          const huge = await extractCoiImage(new File([b], 'test.png', {type:'image/png'}));
          const large = await extractCoiImage(new File([new Uint8Array(10*1024*1024+1)], 'test.png', {type:'image/png'}));
          const controller = new AbortController(); let terminated = 0;
          const OriginalWorker = window.Worker;
          window.Worker = class extends OriginalWorker { terminate() { terminated++; return super.terminate(); } };
          const pending = extractCoiImage(good, p => {if (p >= 0.05) controller.abort()}, {signal:controller.signal});
          const cancelled = await pending;
          const timed = await extractCoiImage(good, undefined, {timeoutMs: 1});
          window.Worker = OriginalWorker;
          return {pdf, disguisedPdf, invalid, huge, large, cancelled, timed, terminated};
        }''')
        for name in ['pdf', 'disguisedPdf', 'invalid', 'huge', 'large', 'cancelled', 'timed']:
            self.assertEqual(results[name]['details']['source'], 'manual', name)
            self.assertEqual(results[name]['rawText'], '', name)
        self.assertIn('PDF', results['pdf']['warnings'][0])
        self.assertIn('dimensions', results['huge']['warnings'][0])
        self.assertIn('cancelled', results['cancelled']['warnings'][0])
        self.assertIn('timed out', results['timed']['warnings'][0])
        self.assertGreaterEqual(results['terminated'], 1)

    def test_missing_local_language_fails_without_cdn_fallback(self):
        self.context.route('**/ocr/lang/eng.traineddata', lambda route: route.abort())
        result = self.page.evaluate('''async () => {
          const {extractCoiImage} = await import('/nested/src/lib/coiOcr.ts');
          const canvas = document.createElement('canvas'); canvas.width=400; canvas.height=100;
          const c=canvas.getContext('2d'); c.fillStyle='white'; c.fillRect(0,0,400,100);
          const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));
          return extractCoiImage(new File([blob], 'test.png', {type:'image/png'}), undefined, {timeoutMs:10000});
        }''')
        self.assertEqual(result['details']['source'], 'manual')
        self.assertEqual(result['rawText'], '')
        self.assertIn('failed', result['warnings'][0].lower())

    def test_real_jpeg(self):
        result = self.page.evaluate('''async () => {
          const {extractCoiImage} = await import('/nested/src/lib/coiOcr.ts');
          const canvas = document.createElement('canvas'); canvas.width=1000; canvas.height=180;
          const c=canvas.getContext('2d'); c.fillStyle='white'; c.fillRect(0,0,1000,180); c.fillStyle='black'; c.font='bold 45px Arial'; c.fillText('INSURED: SAMPLE BUILDER', 30, 95);
          const blob=await new Promise(r=>canvas.toBlob(r,'image/jpeg',0.95));
          return extractCoiImage(new File([blob], 'synthetic.jpg', {type:'image/jpeg'}));
        }''')
        self.assertEqual(result['details']['insured']['name'], 'SAMPLE BUILDER')
        self.assertEqual(result['details']['source'], 'ocr')
        print('Synthetic JPEG: real local Tesseract OCR recognized insured.')

if __name__ == '__main__':
    unittest.main(verbosity=2)
