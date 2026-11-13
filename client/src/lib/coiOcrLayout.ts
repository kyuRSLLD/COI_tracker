import { emptyCoiFields, type CoiFields } from './coiFields'

type Word = { text: string; x: number; y: number; right: number; bottom: number; confidence: number }
type Line = { words: Word[]; y: number }

// Deliberately narrow: spatial OCR is evidence for suggestions, never verification.
// Unsupported/misaligned layouts and low-confidence or conflicting cells remain blank.
export function extractCoiFieldsFromLayout(tsv: string, width: number, height: number): CoiFields {
  const result = emptyCoiFields()
  result.source = 'ocr'
  if (!tsv || tsv.length > 2_000_000 || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 6000 || height > 6000 || width * height > 20_000_000) return result
  const words: Word[] = []
  const records = tsv.split(/\r?\n/)
  if (records.length > 10_000) return result
  for (const record of records) {
    const p = record.split('\t')
    if (p.length !== 12 || p[0] !== '5' || !p[11].trim()) continue
    const [x, y, w, h, confidence] = p.slice(6, 11).map(Number)
    if (![x,y,w,h,confidence].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > width || y + h > height || p[11].length > 180) continue
    words.push({ text: p[11].trim(), x, y, right: x + w, bottom: y + h, confidence })
  }
  if (words.length < 10 || words.length > 5_000) return result
  const heights = words.map(w => w.bottom - w.y).sort((a,b) => a-b)
  const median = heights[Math.floor(heights.length / 2)]
  const center = (w: Word) => (w.y + w.bottom) / 2
  const lines: Line[] = []
  for (const word of [...words].sort((a,b) => center(a)-center(b))) {
    const row = lines[lines.length - 1]
    if (row && Math.abs(center(word) - row.y) <= Math.max(3, median * .62)) {
      row.words.push(word)
      row.y += (center(word) - row.y) / row.words.length
    } else lines.push({ words: [word], y: center(word) })
  }
  for (const line of lines) line.words.sort((a,b) => a.x-b.x)
  const clean = (s: string) => s.toUpperCase().replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, '')
  const find = (parts: string[]) => {
    const hits: Array<{ words: Word[]; y: number; x: number; right: number }> = []
    for (const line of lines) for (let i = 0; i <= line.words.length - parts.length; i++) {
      const sub = line.words.slice(i, i + parts.length)
      if (sub.every((w,j) => clean(w.text) === parts[j] && w.confidence >= 55) && sub.every((w,j) => j === 0 || w.x - sub[j-1].right < width * .05)) {
        hits.push({ words: sub, y: line.y, x: sub[0].x, right: sub[sub.length-1].right })
      }
    }
    return hits
  }
  const one = (parts: string[]) => { const hits = find(parts); return hits.length === 1 ? hits[0] : undefined }
  const type = one(['TYPE','OF','INSURANCE']), number = one(['POLICY','NUMBER'])
  const eff = one(['POLICY','EFF']) || one(['POLICY','EFFECTIVE'])
  const exp = one(['POLICY','EXP']) || one(['POLICY','EXPIRATION'])
  const limits = one(['LIMITS'])
  const ltr = one(['INSR']) || one(['INSURER','LTR'])
  // Require all major table columns in sequence and approximately on one header row.
  if (!type || !number || !eff || !exp || !limits || !ltr || !(ltr.x < type.x && type.x < number.x && number.x < eff.x && eff.x < exp.x && exp.x < limits.x) || Math.max(type.y,number.y,eff.y,exp.y,limits.y,ltr.y) - Math.min(type.y,number.y,eff.y,exp.y,limits.y,ltr.y) > height * .035) return result
  const top = Math.max(type.y,number.y,eff.y,exp.y,limits.y,ltr.y)
  const typeLeft = (ltr.right + type.x) / 2
  const numberLeft = (type.right + number.x) / 2
  const effLeft = (number.right + eff.x) / 2
  const expLeft = (eff.right + exp.x) / 2
  const limitsLeft = (exp.right + limits.x) / 2
  const inX = (w: Word, left: number, right: number) => (w.x + w.right) / 2 >= left && (w.x + w.right) / 2 < right
  const rowWords = (line: Line, left: number, right: number) => line.words.filter(w => inX(w,left,right))
  const joined = (items: Word[]) => items.map(w => w.text).join(' ').replace(/\s+([,:])/g, '$1').trim()
  const safeName = (items: Word[]) => {
    const text = joined(items)
    return items.length && items.every(w => w.confidence >= 55) && text.length <= 180 && /[A-Za-z]/.test(text) && !/[|:\t]/.test(text) && !/^(?:PRODUCER|INSURED|ADDRESS|CONTACT|PHONE|EMAIL|INSURER|COVERAGES)\b/i.test(text) ? text : ''
  }
  const producer = one(['PRODUCER']), insured = one(['INSURED'])
  // Isolate left boxes from the adjacent contact/insurer column.
  const contact = one(['CONTACT'])
  const insurerHeader = find(['INSURER','A']).find(h => h.y < top)
  const split = contact?.x || insurerHeader?.x
  if (producer && insured && split && producer.x < split && insured.x < split && producer.y < insured.y && insured.y < top) {
    const firstValue = (after: number, before: number) => {
      const candidates = lines.filter(line => line.y > after + median * .6 && line.y < before && rowWords(line,0,split).length)
      return candidates.length && candidates[0].y - after <= median * 3.5 ? safeName(rowWords(candidates[0],0,split)) : ''
    }
    result.producer.name = firstValue(producer.y, insured.y)
    result.insured.name = firstValue(insured.y, top)
  }
  const naicHeader = one(['NAIC'])
  if (naicHeader && naicHeader.y < top) {
    const insurers: CoiFields['insurers'] = []
    for (const line of lines.filter(l => l.y > naicHeader.y && l.y < top)) {
      const ws = line.words
      for (let i=0; i<ws.length-1; i++) {
        if (clean(ws[i].text) !== 'INSURER' || ws[i].confidence < 55 || !/^[A-F]$/i.test(clean(ws[i+1].text)) || ws[i+1].confidence < 55 || ws[i+1].x - ws[i].right > width*.03 || ws[i].x >= naicHeader.x) continue
        const tail = ws.slice(i+2).filter(w => w.x < naicHeader.x - width*.02 && !/^[:\-—]+$/.test(w.text))
        const name = safeName(tail)
        const naicWords = ws.filter(w => w.x >= naicHeader.x - width*.02)
        const naic = naicWords.length === 1 && naicWords[0].confidence >= 55 && /^\d{5}$/.test(naicWords[0].text) ? naicWords[0].text : ''
        if (name) insurers.push({ letter: clean(ws[i+1].text), name, naic })
      }
    }
    result.insurers = insurers.filter(i => insurers.filter(j => j.letter === i.letter).length === 1)
  }
  const coverage = (text: string): string => {
    const s = text.toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g,' ').trim()
    if (/^(?:COMMERCIAL )?GENERAL LIABILITY$/.test(s)) return 'Commercial General Liability'
    if (/^(?:AUTOMOBILE|AUTO) LIABILITY$/.test(s)) return 'Automobile Liability'
    if (/^UMBRELLA (?:LIABILITY|LIAB)$/.test(s)) return 'Umbrella Liability'
    if (/^EXCESS (?:LIABILITY|LIAB)$/.test(s)) return 'Excess Liability'
    if (/^(?:WORKERS|WORKER S|WORKERS ) COMPENSATION(?: AND EMPLOYERS LIABILITY)?$/.test(s)) return 'Workers Compensation and Employers Liability'
    return ''
  }
  const endMarkers = lines.filter(l => l.y > top && /^(?:DESCRIPTION OF OPERATIONS|CERTIFICATE HOLDER|CANCELLATION)\b/i.test(joined(rowWords(l,0,width))))
  // Without a known end to the table, footer amounts could be attributed to its last row.
  if (!endMarkers.length) return result
  const tableBottom = endMarkers[0].y
  const headings = lines.filter(l => l.y > top + median && l.y < tableBottom).map(l => ({line:l, type:coverage(joined(rowWords(l,typeLeft,numberLeft)))})).filter(h => h.type)
  if (headings.length > 50) return result
  const headingLines = new Set(headings.map(h => h.line))
  const unknownBoundary = (l: Line) => {
    const s = joined(rowWords(l,typeLeft,numberLeft)).toUpperCase().replace(/^[X\[\]☐✓\s]+/, '').trim()
    if (!s) return false
    // Common check-box/continuation lines are not separate coverage headings.
    // Unknown text stops the section: otherwise its values could be attributed to
    // the preceding known coverage (notably the generic OTHER row on ACORD 25).
    return !/^(?:AND EMPLOYERS LIABILITY|CLAIMS[- ]MADE|OCCUR|GEN.?L AGGREGATE LIMIT APPLIES PER|POLICY|PRO[- ]?JECT|LOC|ANY AUTO|ALL OWNED AUTOS|SCHEDULED AUTOS|HIRED AUTOS(?: ONLY)?|NON[- ]OWNED AUTOS(?: ONLY)?|OWNED AUTOS(?: ONLY)?|DED|RETENTION|Y\s*\/\s*N|N\s*\/\s*A)(?:\b|$)/.test(s)
  }
  const amountPattern = /^\$?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?$/
  const allowedLimits: Record<string, RegExp> = {
    'Commercial General Liability': /^(EACH OCCURRENCE|GENERAL AGGREGATE|PERSONAL (?:&|AND) ADV INJURY|PRODUCTS\s*-\s*COMP\/OP AGG|MED EXP.*|DAMAGE TO RENTED PREMISES.*)$/i,
    'Automobile Liability': /^(COMBINED SINGLE LIMIT.*|BODILY INJURY.*|PROPERTY DAMAGE.*)$/i,
    'Umbrella Liability': /^(EACH OCCURRENCE|AGGREGATE)$/i,
    'Excess Liability': /^(EACH OCCURRENCE|AGGREGATE)$/i,
    'Workers Compensation and Employers Liability': /^E\.?L\.?\s+(EACH ACCIDENT|DISEASE\s*-\s*EA EMPLOYEE|DISEASE\s*-\s*POLICY LIMIT)$/i,
  }
  const validDate = (s: string) => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s)
    if (!m) return ''
    const month=+m[1], day=+m[2], year=+m[3], d=new Date(Date.UTC(year,month-1,day))
    return year >= 1900 && d.getUTCFullYear() === year && d.getUTCMonth() === month-1 && d.getUTCDate() === day ? s : ''
  }
  for (const heading of headings) {
    const next = lines.find(l => l.y > heading.line.y + median && l.y < tableBottom && (headingLines.has(l) || unknownBoundary(l)))
    const bottom = next?.y ?? tableBottom
    const section = lines.filter(l => l.y >= heading.line.y - median*.5 && l.y < bottom - median*.5)
    const cells = (left: number, right: number) => section.flatMap(l => rowWords(l,left,right))
    const numberCell = cells(numberLeft,effLeft), effCell = cells(effLeft,expLeft), expCell = cells(expLeft,limitsLeft)
    const nums = numberCell.filter(w => /^(?=.{1,40}$)(?=.*\d)[A-Za-z0-9][A-Za-z0-9./-]*$/.test(w.text) && !validDate(w.text))
    const dateLike = (w: Word) => /^\d{1,4}[\/.-]\d{1,2}[\/.-]\d{2,4}$/.test(w.text)
    const starts = effCell.filter(dateLike)
    const ends = expCell.filter(dateLike)
    // Multiple rows in a cell could represent different policies; never combine them.
    const ambiguous = numberCell.length > 1 || effCell.length > 1 || expCell.length > 1
    const record: CoiFields['policies'][number] = { type: heading.type, insurerLetter: '', policyNumber: '', effectiveDate: '', expirationDate: '', limits: [] }
    if (!ambiguous) {
      const nearby = section.filter(l => Math.abs(l.y-heading.line.y) <= median * 1.1)
      const letters = nearby.flatMap(l => rowWords(l,ltr.x - width*.02,typeLeft)).filter(w => /^[A-F]$/.test(w.text) && w.confidence >= 55)
      if (letters.length === 1) record.insurerLetter = letters[0].text
      // A value elsewhere in a tall section might belong to another, unrecognized row.
      const aligned = (w: Word) => Math.abs(center(w)-heading.line.y) <= median * 1.1
      if (nums.length === 1 && nums[0].confidence >= 55 && aligned(nums[0])) record.policyNumber = nums[0].text
      if (starts.length === 1 && starts[0].confidence >= 55 && aligned(starts[0])) record.effectiveDate = validDate(starts[0].text)
      if (ends.length === 1 && ends[0].confidence >= 55 && aligned(ends[0])) record.expirationDate = validDate(ends[0].text)
      const limitCandidates: Array<{label:string; amount:string}> = []
      let orphanAmount = false
      for (const line of section) {
        const ws = rowWords(line,limitsLeft,width)
        if (!ws.length) continue
        const firstAmount = ws.findIndex(w => /^\$/.test(w.text) || /^\d[\d,.]*$/.test(w.text))
        if (firstAmount === 0) orphanAmount = true
        if (firstAmount <= 0 || ws.some(w => w.confidence < 55)) continue
        const label = joined(ws.slice(0,firstAmount)), amount = joined(ws.slice(firstAmount)).replace(/^\$\s+/, '$')
        if (allowedLimits[heading.type].test(label) && amountPattern.test(amount)) limitCandidates.push({label:label.toLowerCase(), amount})
      }
      if (!orphanAmount) record.limits = limitCandidates.filter(c => limitCandidates.filter(d => d.label === c.label).length === 1)
    }
    result.policies.push(record)
  }
  return result
}
