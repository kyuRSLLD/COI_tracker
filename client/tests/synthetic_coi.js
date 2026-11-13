// Entirely fictional ACORD-like layout. This is a drawing fixture, not a form or customer data.
(options = {}) => {
  const canvas = document.createElement('canvas'); canvas.width = 2400; canvas.height = 1900;
  const c = canvas.getContext('2d'); c.fillStyle = 'white'; c.fillRect(0, 0, canvas.width, canvas.height);
  c.fillStyle = 'black'; c.strokeStyle = 'black'; c.lineWidth = 2;
  if (options.variant) c.setTransform(.9, 0, 0, .9, 100, 70);
  const replacements = options.variant ? {
    'Northwood Sample Agency': 'Fictional Pine Brokerage', 'Orchard Example Builders LLC': 'Sample Brickworks Inc',
    'Example Harbor Insurance Co': 'Mock River Insurance Co', '01234': '09876',
    'GL-1000123': 'TEST-7654321', 'AU-2000456': 'AUTO-7654321', 'UM-3000789': 'UMB-7654321', 'WC-4000123': 'WORK-7654321',
    '01/01/2026': '05/01/2026', '01/01/2027': '05/01/2027',
    '02/01/2026': '06/01/2026', '02/01/2027': '06/01/2027',
    '03/01/2026': '07/01/2026', '03/01/2027': '07/01/2027',
    '04/01/2026': '08/01/2026', '04/01/2027': '08/01/2027'
  } : {};
  const text = (s, x, y, size = 27, bold = false) => { c.font = `${bold ? 'bold ' : ''}${size}px Arial`; c.fillText(replacements[s] || s, x, y) };
  const line = (x1,y1,x2,y2) => { c.beginPath(); c.moveTo(x1,y1); c.lineTo(x2,y2); c.stroke() };
  text('CERTIFICATE OF LIABILITY INSURANCE', 600, 65, 38, true);
  line(40,100,2360,100); line(40,100,40,580); line(1120,100,1120,580); line(2360,100,2360,580);
  line(40,300,1120,300); line(1120,255,2360,255); line(1120,305,2360,305);
  text('PRODUCER', 55, 132, 24, true); text('Northwood Sample Agency', 60, 178, 31);
  text('10 Fictional Road', 60, 218, 27); text('Sampleville, ZZ 00000', 60, 255, 27);
  text('INSURED', 55, 333, 24, true); text('Orchard Example Builders LLC', 60, 380, 31);
  text('200 Imaginary Lane', 60, 420, 27); text('Sampleville, ZZ 00000', 60, 458, 27);
  text('CONTACT', 1140, 132, 24, true); text('PHONE', 1140, 175, 24, true); text('EMAIL', 1140, 215, 24, true);
  text('INSURER(S) AFFORDING COVERAGE', 1140, 290, 24, true); text('NAIC #', 2220, 290, 24, true);
  text('INSURER A :', 1140, 345, 25, true); text('Example Harbor Insurance Co', 1340, 345, 27); text('01234', 2220, 345, 27);
  text('INSURER B :', 1140, 395, 25, true); text('Fictional Meadow Mutual', 1340, 395, 27); text('56789', 2220, 395, 27);
  text('INSURER C :', 1140, 445, 25, true); text('Synthetic Valley Casualty', 1340, 445, 27); text('23456', 2220, 445, 27);
  line(40,580,2360,580); text('COVERAGES', 55, 620, 27, true); text('CERTIFICATE NUMBER: TEST-ONLY', 1100, 620, 25);
  const xs = [40,120,850,1200,1460,1720,2360];
  for (const x of xs) line(x,650,x,1650);
  for (const y of [650,725,995,1200,1390,1650]) line(40,y,2360,y);
  text('INSR', 50, 680, 20, true); text('LTR', 50, 710, 20, true);
  text('TYPE OF INSURANCE', 145, 695, 24, true);
  text('POLICY NUMBER', 880, 695, 24, true);
  text('POLICY EFF', 1220, 680, 23, true); text('(MM/DD/YYYY)', 1210, 710, 19);
  text('POLICY EXP', 1480, 680, 23, true); text('(MM/DD/YYYY)', 1470, 710, 19);
  text('LIMITS', 1800, 695, 24, true);
  text('A', 70, 770, 27, true); text('COMMERCIAL GENERAL LIABILITY', 145, 770, 26, true);
  text('GL-1000123', 875, 770, 28); text('01/01/2026', 1220, 770, 28); text('01/01/2027', 1480, 770, 28);
  text('EACH OCCURRENCE', 1750, 770, 25); text('$ 1,000,000', 2160, 770, 25);
  text('GENERAL AGGREGATE', 1750, 830, 25); text('$ 2,000,000', 2160, 830, 25);
  text('PRODUCTS - COMP/OP AGG', 1750, 890, 24); text('$ 2,000,000', 2160, 890, 25);
  text('B', 70, 1040, 27, true); text('AUTOMOBILE LIABILITY', 145, 1040, 26, true);
  text('AU-2000456', 875, 1040, 28); text('02/01/2026', 1220, 1040, 28); text('02/01/2027', 1480, 1040, 28);
  text('COMBINED SINGLE LIMIT', 1750, 1040, 24); text('$ 3,000,000', 2160, 1040, 25);
  text('BODILY INJURY (Per person)', 1750, 1100, 23);
  text('C', 70, 1245, 27, true); text('UMBRELLA LIABILITY', 145, 1245, 26, true);
  text('UM-3000789', 875, 1245, 28); text('03/01/2026', 1220, 1245, 28); text('03/01/2027', 1480, 1245, 28);
  text('EACH OCCURRENCE', 1750, 1245, 25); text('$ 4,000,000', 2160, 1245, 25);
  text('AGGREGATE', 1750, 1305, 25); text('$ 4,000,000', 2160, 1305, 25);
  text('A', 70, 1435, 27, true); text('WORKERS COMPENSATION', 145, 1435, 26, true); text('AND EMPLOYERS LIABILITY', 145, 1470, 24, true);
  text('WC-4000123', 875, 1435, 28); text('04/01/2026', 1220, 1435, 28); text('04/01/2027', 1480, 1435, 28);
  text('E.L. EACH ACCIDENT', 1750, 1435, 24); text('$ 500,000', 2160, 1435, 25);
  text('E.L. DISEASE - POLICY LIMIT', 1750, 1495, 23); text('$ 500,000', 2160, 1495, 25);
  if (options.duplicatePolicy) text('OTHER-98765', 875, 820, 28);
  if (options.duplicateLimit) text('$ 9,999,999', 2160, 800, 25);
  line(40,1650,2360,1650); text('DESCRIPTION OF OPERATIONS', 55, 1690, 24, true);
  text('Synthetic example only; all names and values are invented.', 55, 1730, 24);
  return canvas;
}
