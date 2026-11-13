/// <reference types="vite/client" />
import { emptyCoiFields, type CoiFields } from './coiFields'
import { extractCoiFieldsFromLayout } from './coiOcrLayout'

export type CoiOcrResult = { details: CoiFields; rawText: string; warnings: string[] }
export type CoiOcrOptions = { signal?: AbortSignal; timeoutMs?: number }

const MAX_BYTES = 10 * 1024 * 1024
const MAX_DIMENSION = 6000
const MAX_PIXELS = 20_000_000
const DEFAULT_TIMEOUT = 60_000
const MAX_TIMEOUT = 120_000
const REVIEW = 'OCR can be inaccurate or incomplete. Compare every field and the text with the original certificate and correct them manually.'
let running = false

function manual(reason: string): CoiOcrResult {
  return { details: emptyCoiFields(), rawText: '', warnings: [reason] }
}

/** Parse dimensions without decoding; reject animated PNG and malformed or unsupported headers. */
function imageDimensions(bytes: Uint8Array): { kind: 'png' | 'jpeg'; width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const isPng = bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
  if (isPng) {
    if (view.getUint32(8) !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null
    const width = view.getUint32(16), height = view.getUint32(20)
    let pos = 8, ihdr = 0, ended = false
    while (pos + 12 <= bytes.length) {
      const length = view.getUint32(pos)
      if (length > bytes.length - pos - 12) return null
      const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8))
      if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') return null
      if (type === 'IHDR' && ++ihdr !== 1) return null
      pos += length + 12
      if (type === 'IEND') { ended = true; break }
    }
    if (!ended || pos !== bytes.length) return null
    return { kind: 'png', width, height }
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let pos = 2
  let frame: { kind: 'jpeg'; width: number; height: number } | null = null
  while (pos < bytes.length) {
    if (bytes[pos++] !== 0xff) return null
    while (pos < bytes.length && bytes[pos] === 0xff) pos++
    const marker = bytes[pos++]
    if (marker === 0xda) return frame
    if (marker === 0xd9) return null
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (pos + 2 > bytes.length) return null
    const length = view.getUint16(pos)
    if (length < 2 || pos + length > bytes.length) return null
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      if (length < 8 || frame) return null
      frame = { kind: 'jpeg', height: view.getUint16(pos + 3), width: view.getUint16(pos + 5) }
    }
    pos += length
  }
  return null
}

function unique(values: string[]): string {
  const items = [...new Set(values.map(v => v.trim()).filter(Boolean))]
  return items.length === 1 ? items[0] : ''
}

function safeValue(value: string): string {
  const v = value.trim()
  return v.length <= 180 && !/[|:\t]/.test(v) ? v : ''
}

function validDate(value: string): string {
  const v = value.trim()
  let year: number, month: number, day: number
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (m) { year = +m[1]; month = +m[2]; day = +m[3] }
  else {
    m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v)
    if (!m) return ''
    month = +m[1]; day = +m[2]; year = +m[3]
  }
  if (year < 1900 || month < 1 || month > 12 || day < 1) return ''
  const d = new Date(Date.UTC(year, month - 1, day))
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? v : ''
}

/** Extract only explicit, single-line labels. Never infer relationships from nearby rows or columns. */
export function extractCoiFieldsFromText(rawText: string): CoiFields {
  const details = emptyCoiFields()
  details.source = 'ocr'
  const lines = rawText.split(/\r?\n/).slice(0, 5000).map(s => s.trim()).filter(Boolean)
  const labeled = (label: RegExp): string => unique(lines.map(line => {
    const m = label.exec(line)
    return m ? safeValue(m[1]) : ''
  }))
  details.producer.name = labeled(/^producer(?:\s+name)?\s*:\s*(.+)$/i)
  details.producer.address = labeled(/^producer\s+address\s*:\s*(.+)$/i)
  details.producer.phone = labeled(/^producer\s+phone\s*:\s*(.+)$/i)
  if (!/^[+\d().\-\s]{7,30}$/.test(details.producer.phone)) details.producer.phone = ''
  details.producer.email = labeled(/^producer\s+email\s*:\s*(.+)$/i)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.producer.email)) details.producer.email = ''
  details.insured.name = labeled(/^insured(?:\s+name)?\s*:\s*(.+)$/i)
  details.insured.address = labeled(/^insured\s+address\s*:\s*(.+)$/i)

  // Each insurer must have an explicit letter and name on a single line. NAIC is optional.
  const insurers: CoiFields['insurers'] = []
  for (const line of lines) {
    const match = /^insurer\s+([a-z])\s*:\s*([^|:]+?)(?:\s*\|\s*naic\s*:\s*(\d{5}))?\s*$/i.exec(line)
    if (match && safeValue(match[2])) insurers.push({ letter: match[1].toUpperCase(), name: safeValue(match[2]), naic: match[3] || '' })
  }
  details.insurers = insurers.filter(i => insurers.filter(j => j.letter === i.letter).length === 1)

  // Only explicit pipe-delimited policy records are safe to associate; ACORD's flattened
  // table text often interleaves unrelated columns and is intentionally left blank.
  for (const line of lines) {
    if (!/^policy\s+type\s*:/i.test(line) || !line.includes('|')) continue
    const fields: Record<string, string[]> = {}
    let malformed = false
    for (const part of line.split('|')) {
      const m = /^\s*(policy type|insurer letter|policy number|effective date|expiration date|limit [a-z][a-z /-]*)\s*:\s*(.*?)\s*$/i.exec(part)
      if (!m) { malformed = true; break }
      const key = m[1].toLowerCase()
      ;(fields[key] ||= []).push(m[2])
    }
    if (malformed || Object.values(fields).some(v => v.length !== 1)) continue
    const type = safeValue(fields['policy type']?.[0] || '')
    if (!/^(general liability|commercial general liability|automobile liability|auto liability|umbrella liability|excess liability|workers['’]? compensation(?: and employers['’]? liability)?|employers['’]? liability)$/i.test(type)) continue
    const letter = fields['insurer letter']?.[0]?.trim() || ''
    const number = fields['policy number']?.[0]?.trim() || ''
    const policyNumber = /^(?=.{1,40}$)(?=.*\d)[A-Za-z0-9][A-Za-z0-9./-]*$/.test(number) ? number : ''
    const limits: Array<{ label: string; amount: string }> = []
    for (const [key, values] of Object.entries(fields)) {
      if (!key.startsWith('limit ')) continue
      const amount = values[0].trim()
      if (/^\$?\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})?$/.test(amount) || /^\$?\s*\d+(?:\.\d{2})?$/.test(amount)) {
        limits.push({ label: key.slice(6), amount })
      }
    }
    details.policies.push({ type, insurerLetter: /^[A-Za-z]$/.test(letter) ? letter.toUpperCase() : '', policyNumber,
      effectiveDate: validDate(fields['effective date']?.[0] || ''), expirationDate: validDate(fields['expiration date']?.[0] || ''), limits })
  }
  return details
}

function combineCandidates(text: CoiFields, layout: CoiFields): CoiFields {
  const choose = (a: string, b: string) => a && b && a.toLowerCase() !== b.toLowerCase() ? '' : (a || b)
  for (const key of ['name', 'address', 'phone', 'email'] as const) text.producer[key] = choose(text.producer[key], layout.producer[key])
  for (const key of ['name', 'address'] as const) text.insured[key] = choose(text.insured[key], layout.insured[key])
  for (const candidate of layout.insurers) {
    const existing = text.insurers.find(i => i.letter === candidate.letter)
    if (!existing) text.insurers.push(candidate)
    else if (existing.name.toLowerCase() !== candidate.name.toLowerCase() || (existing.naic && candidate.naic && existing.naic !== candidate.naic)) {
      text.insurers = text.insurers.filter(i => i !== existing)
    } else existing.naic = existing.naic || candidate.naic
  }
  // A text record and spatial record for the same coverage cannot safely be paired.
  if (!text.policies.length) text.policies = layout.policies
  else if (layout.policies.length) text.policies = text.policies.filter(p => !layout.policies.some(l => l.type.toLowerCase() === p.type.toLowerCase()))
  return text
}

/** Run OCR entirely in same-origin browser workers. AbortSignal cancellation is optional. */
export async function extractCoiImage(file: File, onProgress?: (p: number) => void, options: CoiOcrOptions = {}): Promise<CoiOcrResult> {
  if (options.signal?.aborted) return manual('OCR cancelled. Enter the certificate details manually.')
  if (running) return manual('Another OCR job is running. Try again or enter the details manually.')
  if (!file || typeof file.arrayBuffer !== 'function') return manual('No readable image was provided. Enter the details manually.')
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return manual('PDF OCR is not supported yet. Enter the certificate details manually.')
  if (file.size === 0 || file.size > MAX_BYTES) return manual('Image must be nonempty and at most 10 MiB. Enter the details manually.')
  if (file.type && !['image/png', 'image/jpeg'].includes(file.type.toLowerCase())) return manual('Only PNG and JPEG images are supported. Enter the details manually.')

  running = true
  let worker: Worker | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined
  let finished = false
  let lastProgress = 0
  const progress = (p: number) => {
    if (finished || !onProgress) return
    const next = Math.max(lastProgress, Math.min(1, Math.max(0, p)))
    lastProgress = next
    try { onProgress(next) } catch (_) { /* A consumer callback must not break cleanup. */ }
  }
  try {
    return await new Promise<CoiOcrResult>(resolve => {
      const finish = (result: CoiOcrResult) => {
        if (finished) return
        finished = true
        if (timer) clearTimeout(timer)
        if (abortListener) options.signal?.removeEventListener('abort', abortListener)
        worker?.terminate()
        resolve(result)
      }
      const ms = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(MAX_TIMEOUT, options.timeoutMs!)) : DEFAULT_TIMEOUT
      timer = setTimeout(() => finish(manual('OCR timed out. Enter the certificate details manually.')), ms)
      abortListener = () => finish(manual('OCR cancelled. Enter the certificate details manually.'))
      options.signal?.addEventListener('abort', abortListener, { once: true })
      if (options.signal?.aborted) { abortListener(); return }
      progress(0)
      void file.arrayBuffer().then(buffer => {
        if (finished) return
        const bytes = new Uint8Array(buffer)
        if (bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-') {
          finish(manual('PDF OCR is not supported yet. Enter the certificate details manually.')); return
        }
        const image = imageDimensions(bytes)
        if (!image || (file.type && file.type.toLowerCase() !== (image.kind === 'png' ? 'image/png' : 'image/jpeg'))) {
          finish(manual('Invalid, animated, or unsupported image. Use a static PNG or JPEG, or enter the details manually.')); return
        }
        if (!image.width || !image.height || image.width > MAX_DIMENSION || image.height > MAX_DIMENSION || image.width * image.height > MAX_PIXELS) {
          finish(manual('Image dimensions exceed the 6000-pixel side or 20-megapixel limit. Enter the details manually.')); return
        }
        try {
          // BASE_URL also supports deployments below a same-origin subpath.
          const base = new URL(import.meta.env.BASE_URL, window.location.href)
          if (base.origin !== window.location.origin) throw new Error('Cross-origin assets disallowed')
          worker = new Worker(new URL('ocr/supervisor.js', base))
          worker.onerror = event => { event.preventDefault(); finish(manual('Local OCR could not start. Enter the details manually.')) }
          worker.onmessageerror = () => finish(manual('Local OCR failed. Enter the details manually.'))
          worker.onmessage = event => {
            const data = event.data
            if (data?.kind === 'progress' && Number.isFinite(data.progress)) progress(0.1 + 0.89 * Math.max(0, Math.min(1, data.progress)))
            if (data?.kind === 'error') finish(manual('Local OCR failed. Enter the details manually.'))
            if (data?.kind === 'result' && typeof data.text === 'string') {
              const rawText = data.text.slice(0, 100_000)
              const warnings = [REVIEW]
              if (data.text.length > rawText.length) warnings.push('OCR text was truncated; review the original document.')
              if (data.tsvTruncated) warnings.push('OCR layout data was too large; enter missing fields manually.')
              if (!rawText.trim()) warnings.push('No text was recognized; enter the details manually.')
              warnings.push('Some layouts, values, or relationships may not be recognized; enter missing fields manually.')
              const layout = typeof data.tsv === 'string' && ((data.width === image.width && data.height === image.height) || (data.width === image.height && data.height === image.width))
                ? extractCoiFieldsFromLayout(data.tsv, data.width, data.height) : emptyCoiFields()
              progress(1)
              finish({ details: combineCandidates(extractCoiFieldsFromText(rawText), layout), rawText, warnings })
            }
          }
          progress(0.05)
          worker.postMessage({ file, width: image.width, height: image.height })
        } catch (_) { finish(manual('Local OCR is unavailable. Enter the details manually.')) }
      }).catch(() => finish(manual('The image could not be read. Enter the details manually.')))
    })
  } finally { running = false }
}
