import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TextractClient, StartDocumentAnalysisCommand, GetDocumentAnalysisCommand } from '@aws-sdk/client-textract'
import type { Block } from '@aws-sdk/client-textract'
import { collectOcr, extractOcrResult, OCR_QUERIES, startAnalysisInput } from '../src/services/coiOcrExtract.ts'

// A throwaway local database and an SDK stub: no actual credentials, network, or user data.
const temp = await mkdtemp(path.join(tmpdir(), 'coi-ocr-test-'))
process.env.SQLITE_PATH = path.join(temp, 'test.sqlite')
process.env.DATABASE_URL = ''
process.env.AWS_S3_BUCKET = 'test-bucket'
process.env.AWS_S3_ENDPOINT = ''
process.env.AWS_TEXTRACT_ENABLED = 'true'
process.env.NODE_ENV = 'test'
for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_WEB_IDENTITY_TOKEN_FILE']) delete process.env[key]
const calls: Array<any> = []
let responses: Array<any> = []
const originalSend = TextractClient.prototype.send
TextractClient.prototype.send = (async (command: any) => {
  calls.push(command)
  const response = responses.shift()
  if (response instanceof Error) throw response
  if (!response) throw new Error('Unexpected SDK call')
  if (typeof response === 'function') return response()
  return response
}) as any
const { dbRun, dbGet } = await import('../src/db/db.ts')
const { ensureDraftTable, startDraftOcr, refreshDraftOcr } = await import('../src/services/coiOcr.ts')
await ensureDraftTable()
after(async () => { TextractClient.prototype.send = originalSend; await rm(temp, { recursive: true, force: true }) })

const geom = { BoundingBox: { Left: .1, Top: .2, Width: .3, Height: .1 }, Polygon: [{ X: .1, Y: .2 }] }
function pair(alias: string, text: string, score: number | undefined = 99, suffix = '', page = 1): Block[] {
  return [
    { BlockType: 'QUERY', Id: `q-${alias}-${suffix}`, Page: page, Query: { Alias: alias, Text: 'question' }, Relationships: [{ Type: 'ANSWER', Ids: [`a-${alias}-${suffix}`] }] },
    { BlockType: 'QUERY_RESULT', Id: `a-${alias}-${suffix}`, Page: page, Text: text, Confidence: score, Geometry: geom },
  ]
}
function extract(blocks: Block[]) { return extractOcrResult(blocks, { jobStatus: 'SUCCEEDED' }) }

async function insert(id: string, status = 'processing', job = 'job-1') {
  await dbRun(`INSERT INTO sub_coi_drafts (id, owner_user_id, subcontractor_id, storage_backend, storage_key, certificate_name, certificate_size, certificate_mime, status, ocr_status, ocr_job_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, 'test-owner', 'test-sub', 's3', 'test-key', 'test.pdf', 4, 'application/pdf', 'draft', status, job, '2026-01-01', '2026-01-01'])
}

test('starts bounded all-page queries with specific per-coverage fields', () => {
  const request = startAnalysisInput('id', 'bucket', 'key')
  assert.deepEqual(request.FeatureTypes, ['FORMS', 'TABLES', 'QUERIES'])
  assert.ok(OCR_QUERIES.length <= 30)
  assert.equal(new Set(OCR_QUERIES.map(q => q.Alias)).size, OCR_QUERIES.length)
  assert.ok(OCR_QUERIES.every(q => q.Pages?.length === 1 && q.Pages[0] === '*'))
  assert.equal(request.ClientRequestToken, 'q1-id')
  for (const field of ['generalLiabilityEachOccurrence', 'generalLiabilityAggregate', 'autoCombinedSingleLimit', 'umbrellaEachOccurrence', 'umbrellaAggregate', 'insuredName', 'autoInsurer', 'autoPolicyNumber', 'autoEffectiveDate', 'autoExpirationDate']) {
    assert.ok(OCR_QUERIES.some(q => q.Alias === field), field)
  }
})

test('collects split answer links across result pages and records document-page provenance', async () => {
  const [q, a] = pair('generalLiabilityEachOccurrence', '$1,000,000', 97, '', 2)
  const tokens: Array<string | undefined> = []
  const r = await collectOcr(async token => {
    tokens.push(token)
    if (!token) return { JobStatus: 'SUCCEEDED', Blocks: [{ BlockType: 'PAGE', Page: 2, Id: 'page-2' }, q], NextToken: 'next' }
    return { JobStatus: 'SUCCEEDED', Blocks: [a, { BlockType: 'LINE', Page: 2, Text: 'example line', Confidence: 99 }] }
  })
  assert.deepEqual(tokens, [undefined, 'next'])
  assert.equal(r.status, 'completed')
  if (r.status !== 'completed') return
  const field = r.result.proposal.fields.generalLiabilityEachOccurrence
  assert.equal(r.result.proposal.status, 'unverified')
  assert.equal(field.status, 'proposed')
  assert.equal(field.value, 1000000)
  assert.deepEqual(field.evidence[0], { queryAlias: 'generalLiabilityEachOccurrence', queryId: q.Id, resultId: a.Id, page: 2, pageId: 'page-2', confidence: 97, sourceText: '$1,000,000', geometry: geom })
  assert.deepEqual(r.result.lines[0], { page: 2, pageId: 'page-2', text: 'example line', confidence: 99 })
  assert.equal(r.result.proposal.fields.autoCombinedSingleLimit.status, 'unknown')
  assert.equal(r.result.proposal.fields.autoCombinedSingleLimit.value, null)
  assert.match(r.result.note, /unverified/)
})

test('independently proposes supported answers without adding assumed coverages', () => {
  const fields = extract([
    ...pair('insuredName', 'Example Construction LLC'),
    ...pair('generalLiabilityAggregate', '$2,000,000.00'),
    ...pair('autoCombinedSingleLimit', '1000000'),
    ...pair('umbrellaEachOccurrence', '$3,000,000'),
    ...pair('generalLiabilityInsurer', 'Example Insurance Company'),
    ...pair('generalLiabilityPolicyNumber', 'GL-12345'),
    ...pair('generalLiabilityEffectiveDate', '2026-01-01'),
    ...pair('generalLiabilityExpirationDate', '12/31/2026'),
  ]).proposal.fields
  assert.equal(fields.insuredName.value, 'Example Construction LLC')
  assert.equal(fields.generalLiabilityAggregate.value, 2000000)
  assert.equal(fields.autoCombinedSingleLimit.value, 1000000)
  assert.equal(fields.umbrellaEachOccurrence.value, 3000000)
  assert.equal(fields.generalLiabilityInsurer.value, 'Example Insurance Company')
  assert.equal(fields.generalLiabilityPolicyNumber.value, 'GL-12345')
  assert.equal(fields.generalLiabilityEffectiveDate.value, '2026-01-01')
  assert.equal(fields.generalLiabilityExpirationDate.value, '2026-12-31')
  assert.deepEqual(fields.umbrellaAggregate, { status: 'unknown', value: null, reason: 'not_found', evidence: [] })
})

test('low, absent and invalid confidence, conflicts, missing provenance and bad links stay unknown', () => {
  const low = pair('generalLiabilityAggregate', '$2,000,000', 89)
  const missingConfidence = pair('autoCombinedSingleLimit', '$1,000,000')
  delete missingConfidence[1].Confidence
  const noPage = pair('umbrellaAggregate', '$2,000,000')
  delete noPage[0].Page; delete noPage[1].Page
  const missingLink: Block = { BlockType: 'QUERY', Id: 'q-missing', Page: 1, Query: { Alias: 'autoPolicyNumber', Text: 'question' }, Relationships: [{ Type: 'ANSWER', Ids: ['not-present'] }] }
  const fields = extract([...low, ...missingConfidence, ...noPage, missingLink,
    ...pair('generalLiabilityEachOccurrence', '$1,000,000', 99, 'a'),
    ...pair('generalLiabilityEachOccurrence', '$2,000,000', 99, 'b')]).proposal.fields
  assert.equal(fields.generalLiabilityAggregate.reason, 'low_confidence')
  assert.equal(fields.autoCombinedSingleLimit.reason, 'low_confidence')
  assert.equal(fields.umbrellaAggregate.reason, 'missing_provenance')
  assert.equal(fields.autoPolicyNumber.reason, 'incomplete_analysis')
  assert.equal(fields.generalLiabilityEachOccurrence.reason, 'conflicting_answers')
  for (const key of ['generalLiabilityAggregate', 'autoCombinedSingleLimit', 'umbrellaAggregate', 'autoPolicyNumber', 'generalLiabilityEachOccurrence'] as const) assert.equal(fields[key].value, null)
  assert.equal(fields.generalLiabilityAggregate.evidence[0].sourceText, '$2,000,000')
})

test('ambiguous amounts, codes, placeholders, multiple policies and uncertain or invalid dates are unknown', () => {
  for (const text of ['$1M', '1,00,000', '$1,000 / $2,000', 'N/A', 'EUR 100000', '$1,000.50', '100O000']) {
    const field = extract(pair('generalLiabilityEachOccurrence', text)).proposal.fields.generalLiabilityEachOccurrence
    assert.equal(field.status, 'unknown', text)
  }
  for (const [key, text] of [
    ['generalLiabilityInsurer', 'A'], ['insuredName', 'N/A'], ['autoPolicyNumber', 'POL-123 / POL-456'],
    ['autoEffectiveDate', '02/03/2026'], ['autoEffectiveDate', '02/29/2025'], ['autoEffectiveDate', '12/31/26'],
  ]) {
    const field = extract(pair(key, text)).proposal.fields[key as keyof ReturnType<typeof extract>['proposal']['fields']]
    assert.equal(field.status, 'unknown', `${key}: ${text}`)
  }
  const dates = extract([...pair('autoEffectiveDate', '2027-01-01'), ...pair('autoExpirationDate', '2026-01-01')]).proposal.fields
  assert.equal(dates.autoEffectiveDate.reason, 'invalid_date_range')
  assert.equal(dates.autoExpirationDate.reason, 'invalid_date_range')
})

test('truncation, partial success, warnings and repeated tokens suppress proposals', async () => {
  const blocks = pair('autoCombinedSingleLimit', '$1,000,000')
  let count = 0
  const capped = await collectOcr(async () => ({ JobStatus: 'SUCCEEDED', Blocks: count++ ? [] : blocks, NextToken: `token-${count}` }))
  assert.equal(count, 10)
  assert.equal(capped.status, 'completed')
  if (capped.status !== 'completed') return
  assert.equal(capped.result.analysis.paginationTruncated, true)
  assert.equal(capped.result.proposal.fields.autoCombinedSingleLimit.reason, 'incomplete_analysis')
  let loopCount = 0
  const repeated = await collectOcr(async () => { loopCount++; return { JobStatus: 'SUCCEEDED', Blocks: blocks, NextToken: 'same' } })
  assert.equal(loopCount, 2)
  assert.equal(repeated.status, 'completed')
  if (repeated.status === 'completed') assert.equal(repeated.result.truncated, true)
  for (const response of [
    { JobStatus: 'PARTIAL_SUCCESS' as const, Blocks: blocks },
    { JobStatus: 'SUCCEEDED' as const, Blocks: blocks, Warnings: [{ ErrorCode: 'INVALID_REQUEST_PARAMETERS', Pages: [1] }] },
  ]) {
    const r = await collectOcr(async () => response)
    if (r.status !== 'completed') assert.fail('expected completed')
    assert.equal(r.result.proposal.fields.autoCombinedSingleLimit.value, null)
    assert.equal(r.result.proposal.fields.autoCombinedSingleLimit.reason, 'incomplete_analysis')
  }
})

test('line output truncation does not prevent collecting subsequent query evidence', async () => {
  const lines: Block[] = Array.from({ length: 5001 }, (_, i) => ({ BlockType: 'LINE', Page: 1, Text: `line ${i}` }))
  const result = extract([...lines, ...pair('autoCombinedSingleLimit', '$1,000,000')])
  assert.equal(result.lines.length, 5000)
  assert.equal(result.analysis.linesTruncated, true)
  assert.equal(result.proposal.fields.autoCombinedSingleLimit.value, 1000000)
})

test('draft flow stores linked proposals, retains access checks, and retries transient polls', async () => {
  calls.length = 0; responses = [{ JobId: 'mock-job' }]
  await insert('draft-1', 'not_configured', '')
  assert.equal(await startDraftOcr('draft-1', 'test-key', 's3'), 'processing')
  assert.ok(calls[0] instanceof StartDocumentAnalysisCommand)
  assert.deepEqual(calls[0].input.FeatureTypes, ['FORMS', 'TABLES', 'QUERIES'])
  assert.equal((await dbGet('SELECT * FROM sub_coi_drafts WHERE id = ?', ['draft-1'])).ocr_job_id, 'mock-job')
  assert.equal(await refreshDraftOcr('draft-1', 'other-owner'), undefined)
  responses = [new Error('simulated throttle')]
  assert.equal((await refreshDraftOcr('draft-1', 'test-owner')).ocr_status, 'processing')
  assert.equal((await dbGet('SELECT * FROM sub_coi_drafts WHERE id = ?', ['draft-1'])).ocr_status, 'processing')
  const [q, a] = pair('autoCombinedSingleLimit', '$1,000,000')
  responses = [
    { JobStatus: 'SUCCEEDED', Blocks: [{ BlockType: 'PAGE', Page: 1, Id: 'pg1' }, q], NextToken: 'more' },
    { JobStatus: 'SUCCEEDED', Blocks: [a] },
  ]
  const row = await refreshDraftOcr('draft-1', 'test-owner')
  assert.equal(row.ocr_status, 'completed')
  const stored = await dbGet('SELECT * FROM sub_coi_drafts WHERE id = ?', ['draft-1'])
  assert.equal(stored.ocr_status, 'completed')
  assert.deepEqual(JSON.parse(row.ocr_result), JSON.parse(stored.ocr_result))
  assert.equal(JSON.parse(stored.ocr_result).proposal.fields.autoCombinedSingleLimit.value, 1000000)
  assert.equal(JSON.parse(stored.ocr_result).proposal.fields.autoCombinedSingleLimit.evidence[0].pageId, 'pg1')
  const gets = calls.filter(c => c instanceof GetDocumentAnalysisCommand)
  assert.equal(gets.at(-1).input.NextToken, 'more')
  assert.ok(gets.every(c => c.input.MaxResults === 1000))
})

test('in-progress and explicit Textract failure follow existing draft status behavior', async () => {
  await insert('draft-in-progress'); await insert('draft-failed')
  responses = [{ JobStatus: 'IN_PROGRESS' }, { JobStatus: 'FAILED' }]
  assert.equal((await refreshDraftOcr('draft-in-progress', 'test-owner')).ocr_status, 'processing')
  assert.equal((await refreshDraftOcr('draft-failed', 'test-owner')).ocr_status, 'failed')
})

test('concurrent draft polling bounds in-flight SDK calls', async () => {
  const ids = Array.from({ length: 12 }, (_, n) => `concurrent-${n}`)
  for (const id of ids) await insert(id)
  let active = 0, maximum = 0
  responses = ids.map(() => async () => {
    active++; maximum = Math.max(maximum, active)
    await new Promise(resolve => setTimeout(resolve, 10))
    active--
    return { JobStatus: 'SUCCEEDED', Blocks: [] }
  })
  const rows = await Promise.all(ids.map(id => refreshDraftOcr(id, 'test-owner')))
  assert.ok(rows.every(row => row.ocr_status === 'completed'))
  assert.equal(maximum, 4)
})
