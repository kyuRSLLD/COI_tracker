import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import dotenv from 'dotenv'

dotenv.config()

const run = promisify(execFile)

const API_KEY = (process.env.OPENAI_API_KEY || '').trim()
const API_BASE = (process.env.OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/+$/, '')
const MODEL = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim()

export const isOcrConfigured = Boolean(API_KEY)
// Backward-compat alias so existing route imports keep working.
export const isTextractConfigured = isOcrConfigured

export interface CoiFieldDocument {
  producer?: { name?: string; address?: string; phone?: string; email?: string }
  insured?: { name?: string; address?: string }
  insurers?: Array<{ letter?: string; name?: string; naic?: string }>
  policies?: Array<{
    type?: string
    insurerLetter?: string
    policyNumber?: string
    effectiveDate?: string
    expirationDate?: string
    limits?: Array<{ label?: string; amount?: string }>
  }>
  source?: 'ocr' | 'manual' | 'mixed'
}

export interface ExtractionResult {
  ok: boolean
  fields?: CoiFieldDocument
  error?: string
  errorCode?: string
}

export function normalizeDate(s?: string): string | undefined {
  if (!s) return undefined
  const t = s.trim()
  const m1 = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
  if (m1) return `${m1[2].padStart(2, '0')}/${m1[3].padStart(2, '0')}/${m1[1]}`
  const m2 = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/)
  if (m2) {
    const y = m2[3].length === 2 ? `20${m2[3]}` : m2[3]
    return `${m2[1].padStart(2, '0')}/${m2[2].padStart(2, '0')}/${y}`
  }
  return undefined
}

export function cleanPolicyNumber(s?: string): string | undefined {
  if (!s) return undefined
  return s.trim().replace(/^[#\s]+/, '').replace(/^(?:policy\s*#?|number|no[.:]?)\s*/i, '').trim() || undefined
}

export function normalizeAmount(s?: string): string | undefined {
  if (!s) return undefined
  const raw = s.replace(/[$,]/g, '').trim()
  if (!raw) return undefined
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return s.trim() || undefined
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Convert the first page of a PDF into a PNG buffer. Prefers `pdftoppm`
// (fast, crisp), falls back to ImageMagick `convert`.
async function pdfToPng(pdf: Buffer): Promise<Buffer> {
  const tmp = path.join(os.tmpdir(), `coi-pdf-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(tmp, { recursive: true })
  const inPath = path.join(tmp, 'doc.pdf')
  const outPrefix = path.join(tmp, 'page')
  try {
    await fs.writeFile(inPath, pdf)
    try {
      await run('pdftoppm', ['-png', '-r', '150', '-f', '1', '-l', '1', inPath, outPrefix])
      const files = await fs.readdir(tmp)
      const page = files.filter(f => f.startsWith('page') && f.endsWith('.png')).sort()[0]
      if (page) return await fs.readFile(path.join(tmp, page))
    } catch {
      // pdftoppm unavailable — fall through to convert
    }
    const outPath = path.join(tmp, 'page.png')
    await run('convert', [`${inPath}[0]`, '-density', '150', outPath])
    return await fs.readFile(outPath)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

// Ensure the buffer is a JPEG/PNG suitable for the OpenAI vision API.
// PDF → page-1 PNG; TIFF → PNG; JPEG/PNG pass through.
async function renderToImage(buffer: Buffer): Promise<{ buffer: Buffer; mime: string } | null> {
  const isPng = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const isJpg = buffer[0] === 0xff && buffer[1] === 0xd8
  const isPdf = buffer.subarray(0, 4).toString('ascii') === '%PDF'
  const isTiff = buffer.subarray(0, 2).equals(Buffer.from([0x49, 0x49])) || buffer.subarray(0, 2).equals(Buffer.from([0x4d, 0x4d]))
  if (isPng) return { buffer, mime: 'image/png' }
  if (isJpg) return { buffer, mime: 'image/jpeg' }
  if (isPdf) {
    try {
      return { buffer: await pdfToPng(buffer), mime: 'image/png' }
    } catch (e) {
      console.error('PDF rasterization failed:', e)
      return null
    }
  }
  if (isTiff) {
    const tmp = path.join(os.tmpdir(), `coi-tif-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const inPath = tmp + '.tif'
    const outPath = tmp + '.png'
    try {
      await fs.writeFile(inPath, buffer)
      await run('convert', [inPath, outPath])
      return { buffer: await fs.readFile(outPath), mime: 'image/png' }
    } catch (e) {
      console.error('TIFF conversion failed:', e)
      return null
    } finally {
      await fs.unlink(inPath).catch(() => {})
      await fs.unlink(outPath).catch(() => {})
    }
  }
  return null
}

const SYSTEM_PROMPT = `You extract structured fields from Certificate of Insurance (COI) documents. Return ONLY a JSON object with this exact shape:
{
  "producer": {"name": "...", "address": "...", "phone": "...", "email": "..."},
  "insured": {"name": "...", "address": "..."},
  "insurers": [{"letter": "A", "name": "...", "naic": "..."}],
  "policies": [{
    "type": "General Liability",
    "insurerLetter": "A",
    "policyNumber": "...",
    "effectiveDate": "MM/DD/YYYY",
    "expirationDate": "MM/DD/YYYY",
    "limits": [{"label": "each occurrence", "amount": "1000000"}]
  }]
}
Rules:
- Omit any field not visible in the document.
- Dates MUST be MM/DD/YYYY. Convert YYYY-MM-DD or other formats accordingly.
- List all insurers under "insurers" with their letter (A, B, C...) and NAIC number (the 5-digit insurance company code under the NAIC # column, if shown).
- Capture every insurer affording coverage on the certificate (INSURER A, INSURER B, INSURER C, etc.).
- Extract every policy line (common types: General Liability, Automobile Liability, Umbrella/Excess Liability, Workers Compensation). Use the exact insurer letter column.
- Amounts must be formatted as currency with two decimals, for example $1,000,000.00 (not 1000000).`

const USER_PROMPT = 'Extract all insurance certificate fields visible in this document image: producer (agency), insured company information, insurers affording coverage with NAIC numbers, and every policy line with type of insurance, policy number, effective date, expiration date, and all coverage limits.'

function coerceString(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim()
    return t ? t : undefined
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return undefined
}

function normalizeRaw(raw: any): CoiFieldDocument {
  const producer = raw?.producer && typeof raw.producer === 'object' ? raw.producer : null
  const insured = raw?.insured && typeof raw.insured === 'object' ? raw.insured : null
  const insurersRaw = Array.isArray(raw?.insurers) ? raw.insurers : []
  const insurers = insurersRaw
    .map((x: any) => ({
      letter: coerceString(x?.letter || x?.code)?.toUpperCase(),
      name: coerceString(x?.name || x?.label),
      naic: coerceString(x?.naic)?.replace(/\D/g, '') || undefined,
    }))
    .filter((x: any) => x.name || x.naic)
    .slice(0, 10)
  const policiesRaw = Array.isArray(raw?.policies) ? raw.policies : []
  const policies = policiesRaw
    .map((p: any) => {
      const limitsRaw = Array.isArray(p?.limits) ? p.limits : []
      const limits = limitsRaw
        .map((l: any) => ({ label: coerceString(l?.label), amount: normalizeAmount(coerceString(l?.amount)) }))
        .filter((l: any) => l.label && l.amount)
        .slice(0, 8)
      return {
        type: coerceString(p?.type || p?.coverage),
        insurerLetter: coerceString(p?.insurerLetter)?.toUpperCase(),
        policyNumber: cleanPolicyNumber(coerceString(p?.policyNumber || p?.policy_number)),
        effectiveDate: normalizeDate(coerceString(p?.effectiveDate || p?.effective)),
        expirationDate: normalizeDate(coerceString(p?.expirationDate || p?.expiration)),
        limits: limits.length ? limits : undefined,
      }
    })
    .filter((p: any) => p.type || p.policyNumber || p.effectiveDate || p.expirationDate || p.limits)
    .slice(0, 10)
  const out: CoiFieldDocument = {}
  if (producer) {
    const p = {
      name: coerceString(producer.name),
      address: coerceString(producer.address),
      phone: coerceString(producer.phone),
      email: coerceString(producer.email),
    }
    if (p.name || p.address || p.phone || p.email) out.producer = p
  }
  if (insured) {
    const i = {
      name: coerceString(insured.name),
      address: coerceString(insured.address),
    }
    if (i.name || i.address) out.insured = i
  }
  if (insurers.length) out.insurers = insurers
  if (policies.length) out.policies = policies
  const hasData = out.producer || out.insured || out.insurers || out.policies
  out.source = hasData ? 'ocr' : 'manual'
  return out
}

export async function analyzeCoiDocument(buffer: Buffer): Promise<{ fields: CoiFieldDocument }> {
  if (!API_KEY) throw new Error('AI extraction is not configured — add OPENAI_API_KEY to Railway variables')
  const rendered = await renderToImage(buffer)
  if (!rendered) throw Object.assign(new Error('Unsupported file format for AI extraction'), { name: 'UnsupportedDocumentException' })
  const b64 = rendered.buffer.toString('base64')
  const dataUrl = `data:${rendered.mime};base64,${b64}`
  const body = JSON.stringify({
    model: MODEL,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: USER_PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    max_completion_tokens: 4000,
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 75000)
  let res: Response
  try {
    res = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: controller.signal,
    })
  } catch (e: any) {
    if (e?.name === 'AbortError') throw Object.assign(new Error('AI extraction timed out'), { name: 'TimeoutException' })
    throw Object.assign(new Error(`Could not reach the AI extraction service: ${e?.message || e}`), { name: 'NetworkException' })
  } finally {
    clearTimeout(timer)
  }
  const text = await res.text()
  if (!res.ok) {
    let msg = text
    try {
      const j = JSON.parse(text)
      msg = j?.error?.message || j?.error || text
    } catch {}
    if (res.status === 401) throw Object.assign(new Error('Invalid OpenAI API key — verify OPENAI_API_KEY in Railway variables'), { name: 'AuthException' })
    if (res.status === 429) throw Object.assign(new Error('OpenAI rate limit or credit quota reached'), { name: 'QuotaException' })
    throw Object.assign(new Error(`AI extraction error (${res.status}): ${msg}`), { name: 'ApiException' })
  }
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    throw Object.assign(new Error('AI extraction returned invalid JSON'), { name: 'BadResponseException' })
  }
  const content = parsed?.choices?.[0]?.message?.content
  if (!content) throw Object.assign(new Error('AI extraction returned an empty response'), { name: 'EmptyResponseException' })
  let raw: any
  try {
    raw = JSON.parse(content)
  } catch {
    throw Object.assign(new Error('AI extraction output was not valid JSON'), { name: 'BadResponseException' })
  }
  return { fields: normalizeRaw(raw) }
}

export async function tryAnalyzeCoiDocument(buffer: Buffer): Promise<ExtractionResult> {
  if (!isOcrConfigured) return { ok: false, error: 'AI extraction is not configured — add OPENAI_API_KEY to Railway variables', errorCode: 'NotConfigured' }
  try {
    const { fields } = await analyzeCoiDocument(buffer)
    const empty = !fields.producer && !fields.insured && !fields.insurers && !fields.policies
    return empty ? { ok: false, error: 'The AI could not find readable insurance fields in this document', errorCode: 'NoFields' } : { ok: true, fields }
  } catch (err: any) {
    console.error('AI extraction failed:', err)
    const name = err?.name || 'Error'
    const msg = err?.message || String(err)
    if (name === 'AuthException') return { ok: false, error: 'Invalid OpenAI API key — check OPENAI_API_KEY in Railway variables', errorCode: name }
    if (name === 'QuotaException') return { ok: false, error: 'OpenAI quota reached — check your OpenAI account billing at platform.openai.com', errorCode: name }
    if (name === 'TimeoutException') return { ok: false, error: 'AI extraction timed out — try again or enter the details manually', errorCode: name }
    if (name === 'UnsupportedDocumentException') return { ok: false, error: 'Unsupported file format — upload a PNG, JPEG, PDF, or HEIC photo', errorCode: name }
    if (name === 'NetworkException') return { ok: false, error: 'Could not contact the AI extraction service — try again shortly', errorCode: name }
    return { ok: false, error: `AI extraction error: ${msg}`, errorCode: name }
  }
}
