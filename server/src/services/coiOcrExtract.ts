import type { Block, Geometry, GetDocumentAnalysisCommandOutput, Query, StartDocumentAnalysisCommandInput } from '@aws-sdk/client-textract'

// Async Textract supports up to 30 queries per page. Explicitly use all pages:
// omitted Pages defaults to the first page, not the complete document.
// https://docs.aws.amazon.com/textract/latest/dg/limits-document.html
// https://docs.aws.amazon.com/textract/latest/APIReference/API_Query.html
const fieldDefinitions = {
  insuredName: ['What is the name of the insured?', 'name'],
  generalLiabilityEachOccurrence: ['What is the commercial general liability each occurrence limit?', 'money'],
  generalLiabilityAggregate: ['What is the commercial general liability general aggregate limit?', 'money'],
  autoCombinedSingleLimit: ['What is the automobile liability combined single limit each accident?', 'money'],
  umbrellaEachOccurrence: ['What is the umbrella liability each occurrence limit?', 'money'],
  umbrellaAggregate: ['What is the umbrella liability aggregate limit?', 'money'],
  generalLiabilityInsurer: ['What is the insurer name for the commercial general liability policy?', 'name'],
  generalLiabilityPolicyNumber: ['What is the commercial general liability policy number?', 'policy'],
  generalLiabilityEffectiveDate: ['What is the commercial general liability policy effective date?', 'date'],
  generalLiabilityExpirationDate: ['What is the commercial general liability policy expiration date?', 'date'],
  autoInsurer: ['What is the insurer name for the automobile liability policy?', 'name'],
  autoPolicyNumber: ['What is the automobile liability policy number?', 'policy'],
  autoEffectiveDate: ['What is the automobile liability policy effective date?', 'date'],
  autoExpirationDate: ['What is the automobile liability policy expiration date?', 'date'],
  umbrellaInsurer: ['What is the insurer name for the umbrella liability policy?', 'name'],
  umbrellaPolicyNumber: ['What is the umbrella liability policy number?', 'policy'],
  umbrellaEffectiveDate: ['What is the umbrella liability policy effective date?', 'date'],
  umbrellaExpirationDate: ['What is the umbrella liability policy expiration date?', 'date'],
} as const

type FieldKey = keyof typeof fieldDefinitions
type FieldKind = 'money' | 'date' | 'name' | 'policy'
export interface OcrEvidence {
  queryAlias: string
  queryId: string | null
  resultId: string | null
  page: number | null
  pageId: string | null
  confidence: number | null // Textract's 0-100 score; not a guarantee of correctness
  sourceText: string
  geometry: Geometry | null // normalized Textract geometry, when returned
}
export interface OcrFieldProposal {
  status: 'proposed' | 'unknown'
  value: string | number | null // money is whole units, currency unspecified; dates are YYYY-MM-DD
  reason: string | null
  evidence: OcrEvidence[]
}
export interface OcrResult {
  lines: Array<{ page: number | null; pageId: string | null; text: string; confidence: number | null }>
  truncated: boolean
  note: string
  proposal: { status: 'unverified'; fields: Record<FieldKey, OcrFieldProposal> }
  analysis: { jobStatus: 'SUCCEEDED' | 'PARTIAL_SUCCESS'; paginationTruncated: boolean; linesTruncated: boolean; warnings: Array<{ code: string | null; pages: number[] }> }
}

export const OCR_QUERIES: Query[] = Object.entries(fieldDefinitions).map(([Alias, [Text]]) => ({ Alias, Text, Pages: ['*'] }))
export function startAnalysisInput(id: string, bucket: string, key: string): StartDocumentAnalysisCommandInput {
  return {
    DocumentLocation: { S3Object: { Bucket: bucket, Name: key } },
    FeatureTypes: ['FORMS', 'TABLES', 'QUERIES'],
    QueriesConfig: { Queries: OCR_QUERIES },
    // Version the token because the old forms/tables-only request used the bare id.
    ClientRequestToken: `q1-${id}`,
  }
}

const MIN_CONFIDENCE = 90
const PLACEHOLDER = /^(?:n\s*\/?\s*a|none|unknown|not\s+(?:available|applicable|provided)|no\s+(?:coverage|policy)|tbd|nil|[-.]+)$/i
function parseValue(kind: FieldKind, original: string): string | number | null {
  const s = original.trim()
  if (!s || s.length > 200 || PLACEHOLDER.test(s)) return null
  if (kind === 'money') {
    // No ranges, shorthand, foreign currency, decimal cents, or OCR substitutions.
    if (!/^\$?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.00)?$/.test(s)) return null
    const n = Number(s.replace(/[$,\s]/g, ''))
    return Number.isSafeInteger(n) && n >= 0 ? n : null
  }
  if (kind === 'date') {
    let year: number, month: number, day: number
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
    const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s)
    if (iso) [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    else if (us) {
      month = Number(us[1]); day = Number(us[2]); year = Number(us[3])
      // 02/03/2026 could be either February 3 or March 2. Do not guess.
      if (month <= 12 && day <= 12 && month !== day) return null
    } else return null
    if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null
    const d = new Date(Date.UTC(year, month - 1, day))
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null
    return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
  }
  if (kind === 'policy') {
    // A single compact policy number only; do not combine separate policies.
    return /^(?=.*[0-9])[A-Za-z0-9][A-Za-z0-9.-]{2,59}$/.test(s) ? s : null
  }
  // Insurer letters such as A/B are codes, not insurer names. Do not infer names from them.
  if (!/^[\p{L}\p{N}][\p{L}\p{N} &'.,()\-]{1,149}$/u.test(s) || !/\p{L}{2}/u.test(s)) return null
  return s.replace(/\s+/g, ' ')
}
function knownPage(page: number | undefined): number | null {
  return Number.isInteger(page) && page! > 0 ? page! : null
}
function confidence(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null
}

// Resolve ANSWER IDs only after collecting every bounded response page. Query and
// QUERY_RESULT blocks may arrive in different GetDocumentAnalysis responses.
export function extractOcrResult(blocks: Block[], options: {
  jobStatus: 'SUCCEEDED' | 'PARTIAL_SUCCESS'
  paginationTruncated?: boolean
  warnings?: Array<{ code: string | null; pages: number[] }>
}): OcrResult {
  const byId = new Map<string, Block>()
  const pageIds = new Map<number, string>()
  for (const b of blocks) {
    if (b.Id) byId.set(b.Id, b)
    const p = knownPage(b.Page)
    if (b.BlockType === 'PAGE' && p !== null && b.Id) pageIds.set(p, b.Id)
  }
  const lines: OcrResult['lines'] = []
  let linesTruncated = false, textLength = 0
  const candidates = {} as Record<FieldKey, OcrEvidence[]>
  for (const key of Object.keys(fieldDefinitions) as FieldKey[]) candidates[key] = []
  const missingLinks = new Set<FieldKey>()
  for (const b of blocks) {
    if (b.BlockType === 'LINE' && b.Text) {
      if (lines.length >= 5000 || textLength + b.Text.length > 500000) { linesTruncated = true; continue }
      const page = knownPage(b.Page)
      lines.push({ page, pageId: page === null ? null : pageIds.get(page) ?? null, text: b.Text, confidence: confidence(b.Confidence) })
      textLength += b.Text.length
    }
    if (b.BlockType !== 'QUERY' || !b.Query?.Alias || !Object.hasOwn(fieldDefinitions, b.Query.Alias)) continue
    const alias = b.Query.Alias as FieldKey
    for (const relationship of b.Relationships || []) {
      if (relationship.Type !== 'ANSWER') continue
      for (const id of relationship.Ids || []) {
        const answer = byId.get(id)
        if (!answer || answer.BlockType !== 'QUERY_RESULT') { missingLinks.add(alias); continue }
        const answerPage = knownPage(answer.Page), queryPage = knownPage(b.Page)
        if (answerPage !== null && queryPage !== null && answerPage !== queryPage) missingLinks.add(alias)
        const page = answerPage ?? queryPage
        candidates[alias].push({ queryAlias: alias, queryId: b.Id ?? null, resultId: answer.Id ?? null, page,
          pageId: page === null ? null : pageIds.get(page) ?? null, confidence: confidence(answer.Confidence),
          sourceText: answer.Text ?? '', geometry: answer.Geometry ?? null })
      }
    }
  }
  const fields = {} as Record<FieldKey, OcrFieldProposal>
  const warnings = options.warnings ?? []
  const incomplete = Boolean(options.paginationTruncated || options.jobStatus !== 'SUCCEEDED' || warnings.length)
  for (const key of Object.keys(fieldDefinitions) as FieldKey[]) {
    const evidence = candidates[key]
    const nonempty = evidence.filter(item => item.sourceText.trim())
    let reason: string | null = null
    let value: string | number | null = null
    if (incomplete || missingLinks.has(key)) reason = 'incomplete_analysis'
    else if (!nonempty.length) reason = 'not_found'
    else if (nonempty.some(item => item.confidence === null || item.confidence < MIN_CONFIDENCE)) reason = 'low_confidence'
    else if (nonempty.some(item => item.page === null || !item.resultId || !item.queryId)) reason = 'missing_provenance'
    else {
      const values = nonempty.map(item => parseValue(fieldDefinitions[key][1], item.sourceText))
      if (values.some(item => item === null)) reason = 'unparseable_or_ambiguous'
      else if (new Set(values).size !== 1) reason = 'conflicting_answers'
      else value = values[0]
    }
    fields[key] = { status: reason ? 'unknown' : 'proposed', value, reason, evidence }
  }
  for (const [effective, expiration] of [
    ['generalLiabilityEffectiveDate', 'generalLiabilityExpirationDate'],
    ['autoEffectiveDate', 'autoExpirationDate'], ['umbrellaEffectiveDate', 'umbrellaExpirationDate'],
  ] as Array<[FieldKey, FieldKey]>) {
    if (typeof fields[effective].value === 'string' && typeof fields[expiration].value === 'string' && fields[effective].value >= fields[expiration].value) {
      for (const key of [effective, expiration]) Object.assign(fields[key], { status: 'unknown', value: null, reason: 'invalid_date_range' })
    }
  }
  return { lines, truncated: Boolean(options.paginationTruncated || linesTruncated),
    note: 'OCR text and proposed fields are unverified, may be incorrect, and require human review. They do not establish coverage or approval. Amounts are whole units; currency is not inferred.',
    proposal: { status: 'unverified', fields },
    analysis: { jobStatus: options.jobStatus, paginationTruncated: Boolean(options.paginationTruncated), linesTruncated, warnings } }
}

export type OcrGetResponse = Pick<GetDocumentAnalysisCommandOutput, 'JobStatus' | 'Blocks' | 'NextToken' | 'Warnings'>
export type OcrPollResult = { status: 'processing' } | { status: 'failed' } | { status: 'completed'; result: OcrResult }
export async function collectOcr(getPage: (token?: string) => Promise<OcrGetResponse>): Promise<OcrPollResult> {
  const blocks: Block[] = []
  const warnings: NonNullable<OcrResult['analysis']['warnings']> = []
  const seenTokens = new Set<string>()
  let token: string | undefined, jobStatus: 'SUCCEEDED' | 'PARTIAL_SUCCESS' = 'SUCCEEDED'
  let paginationTruncated = false
  // Each response is at most 1000 blocks; at most 10 sequential calls per poll.
  for (let n = 0; n < 10; n++) {
    const response = await getPage(token)
    if (response.JobStatus === 'IN_PROGRESS') return { status: 'processing' }
    if (response.JobStatus === 'FAILED') return { status: 'failed' }
    if (response.JobStatus !== 'SUCCEEDED' && response.JobStatus !== 'PARTIAL_SUCCESS') throw new Error('Unexpected Textract status')
    if (response.JobStatus === 'PARTIAL_SUCCESS') jobStatus = 'PARTIAL_SUCCESS'
    for (const w of response.Warnings || []) {
      const item = { code: w.ErrorCode ?? null, pages: w.Pages ?? [] }
      if (!warnings.some(x => x.code === item.code && JSON.stringify(x.pages) === JSON.stringify(item.pages))) warnings.push(item)
    }
    blocks.push(...(response.Blocks ?? []))
    token = response.NextToken
    if (!token) break
    if (seenTokens.has(token) || n === 9) { paginationTruncated = true; break }
    seenTokens.add(token)
  }
  return { status: 'completed', result: extractOcrResult(blocks, { jobStatus, paginationTruncated, warnings }) }
}
