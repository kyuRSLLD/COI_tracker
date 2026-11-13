import { TextractClient, AnalyzeDocumentCommand, type AnalyzeDocumentCommandOutput } from '@aws-sdk/client-textract'
import dotenv from 'dotenv'
dotenv.config()
const REGION = (process.env.AWS_REGION || '').trim()
const ENABLED = process.env.TEXTRACT_ENABLED !== 'false'
const validRegion = /^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/.test(REGION)
export const isTextractConfigured = validRegion && ENABLED
let client: TextractClient | null = null
function getClient(): TextractClient {
  if (!isTextractConfigured) throw new Error('Textract is not configured')
  if (!client) client = new TextractClient({ region: REGION, maxAttempts: 3 })
  return client
}
// Normalize a raw field label or value for case-insensitive matching.
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}
// Best fuzzy match of `query` (a norm'd label) against a map of norm'd -> raw.
function pick(map: Map<string, string>, query: string): string | undefined {
  const q = norm(query)
  if (map.has(q)) return map.get(q)
  for (const [k, v] of map) if (k.includes(q)) return v
  return undefined
}
function parseKv(analysis: AnalyzeDocumentCommandOutput): Map<string, string> {
  const blocks = analysis.Blocks || []
  const byId = new Map(blocks.map(b => [b.Id!, b]))
  const kvs = new Map<string, string>()
  const textOf = (ids?: string[]) => (ids || []).map(id => byId.get(id)?.Text || '').filter(Boolean).join(' ')
  for (const b of blocks) {
    if (b.BlockType !== 'KEY_VALUE_SET' || !b.EntityTypes?.includes('KEY')) continue
    const key = textOf(b.Relationships?.find(r => r.Type === 'CHILD')?.Ids)
    const valRel = b.Relationships?.find(r => r.Type === 'VALUE')
    const valBlock = valRel?.Ids?.[0] && byId.get(valRel.Ids[0])
    const value = textOf(valBlock && byId.get(valBlock.Id!) ? (valBlock.Relationships?.find(r => r.Type === 'CHILD')?.Ids) : [])
    if (key) kvs.set(norm(key), value)
  }
  return kvs
}
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
function extractDates(kv: Map<string, string>, prefix: string): { eff?: string; exp?: string } {
  const eff = pick(kv, `${prefix} effective date`) || pick(kv, 'policy eff date')
  const exp = pick(kv, `${prefix} expiration date`) || pick(kv, 'policy exp date')
  return { eff, exp }
}
export function mapAnalysisToFields(analysis: AnalyzeDocumentCommandOutput): CoiFieldDocument {
  const kv = parseKv(analysis)
  const lines = (analysis.Blocks || []).filter(b => b.BlockType === 'LINE').map(b => b.Text || '')
  // Producer block
  const producerName = pick(kv, 'producer') || pick(kv, 'agent') || pick(kv, 'broker')
  const producerPhone = pick(kv, 'producer phone') || pick(kv, 'phone')
  const producerEmail = pick(kv, 'e mail') || pick(kv, 'email')
  const producerAddress = pick(kv, 'producer address')
  // Insured
  const insuredName = pick(kv, 'insured') || pick(kv, 'named insured')
  const insuredAddress = pick(kv, 'insured address')
  // Insurers A-F with NAIC
  const insurers: CoiFieldDocument['insurers'] = []
  for (const letter of ['A', 'B', 'C', 'D', 'E', 'F']) {
    const name = pick(kv, `insurer ${letter}`) || pick(kv, `ins ${letter}`) || pick(kv, `insurer ${letter} affording coverage`)
    const naic = pick(kv, `insurer ${letter} naic`) || pick(kv, `insurer ${letter} naic #`) || pick(kv, `naic #${letter.toLowerCase()}`) || pick(kv, `naic ${letter.toLowerCase()}`)
    if (name || naic) insurers.push({ letter, name, naic })
  }
  // Policy lines per coverage type
  const policyTypes = [
    { label: 'General Liability', keys: ['general liability', 'commercial general liability', 'gen liab'] },
    { label: 'Automobile Liability', keys: ['automobile liability', 'automobile liability', 'auto liability'] },
    { label: 'Umbrella Liability', keys: ['umbrella liability', 'umbrella', 'excess liability'] },
    { label: "Workers' Compensation", keys: ["workers compensation", "workers comp", 'wc'] },
  ]
  const policies: NonNullable<CoiFieldDocument['policies']> = []
  for (const { label, keys } of policyTypes) {
    let pNum: string | undefined
    for (const k of keys) {
      pNum = pick(kv, `${k} policy number`) || pick(kv, `${k} policy #`)
      if (pNum) break
    }
    const { eff, exp } = extractDates(kv, keys[0])
    // Find limits for this line
    const limits: Array<{ label?: string; amount?: string }> = []
    const limitKeys = [
      ['each occurrence', ['each occurrence', `${keys[0]} each occurrence`]],
      ['damage to rented premises', ['damage to rented premises']],
      ['med exp', ['med exp']],
      ['personal adv injury', ['personal adv injury']],
      ['general aggregate', ['general aggregate']],
      ['products comp/op agg', ['products comp op agg', 'products completed operations aggregate']],
      ['combined single limit', ['combined single limit', `${keys[0]} combined single limit`]],
      ['bodily injury', ['bodily injury']],
      ['property damage', ['property damage']],
      ['each accident', ['each accident']],
      ['disease ea employee', ['disease ea employee']],
      ['disease policy limit', ['disease policy limit']],
    ] as const
    for (const [outLabel, needles] of limitKeys) {
      let amount: string | undefined
      for (const needle of needles) {
        amount = pick(kv, needle)
        if (amount) break
      }
      if (amount && /^\$?[\d,]+(?:\.\d\d)?$/.test(amount.trim())) limits.push({ label: outLabel, amount: amount.trim() })
    }
    if (pNum || eff || exp || limits.length) {
      policies.push({ type: label, policyNumber: pNum, effectiveDate: eff, expirationDate: exp, limits: limits.slice(0, 8) })
    }
  }
  const hasData = producerName || insuredName || insurers.length || policies.length
  return {
    producer: producerName || producerPhone || producerEmail || producerAddress
      ? { name: producerName, address: producerAddress, phone: producerPhone, email: producerEmail } : undefined,
    insured: insuredName || insuredAddress ? { name: insuredName, address: insuredAddress } : undefined,
    insurers: insurers.length ? insurers : undefined,
    policies: policies.length ? policies.slice(0, 10) : undefined,
    source: hasData ? 'ocr' : 'manual',
  }
}
export async function analyzeCoiDocument(buffer: Buffer): Promise<{ fields: CoiFieldDocument; rawKvCount: number }> {
  const textract = getClient()
  const res = await textract.send(new AnalyzeDocumentCommand({
    Document: { Bytes: buffer },
    FeatureTypes: ['FORMS', 'TABLES'],
  }))
  return { fields: mapAnalysisToFields(res), rawKvCount: (res.Blocks || []).filter(b => b.BlockType === 'KEY_VALUE_SET').length }
}
export async function tryAnalyzeCoiDocument(buffer: Buffer): Promise<CoiFieldDocument | null> {
  if (!isTextractConfigured) return null
  try {
    const { fields } = await analyzeCoiDocument(buffer)
    const empty = !fields.producer && !fields.insured && !fields.insurers && !fields.policies
    return empty ? null : fields
  } catch (err) {
    console.error('Textract failed, falling back:', err)
    return null
  }
}
