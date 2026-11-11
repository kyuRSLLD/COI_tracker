import { TextractClient, StartDocumentAnalysisCommand, GetDocumentAnalysisCommand } from '@aws-sdk/client-textract'
import { dbGet, dbRun } from '../db/db.ts'
import { isS3Configured, s3Bucket, s3Region } from './storage.ts'
import { collectOcr, startAnalysisInput } from './coiOcrExtract.ts'

export type OcrStatus = 'not_configured' | 'processing' | 'completed' | 'failed'
// A separate draft table avoids inventing values for the legacy cois table's NOT NULL dates.
export async function ensureDraftTable(): Promise<void> {
  await dbRun(`CREATE TABLE IF NOT EXISTS sub_coi_drafts (
    id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, subcontractor_id TEXT NOT NULL,
    storage_backend TEXT NOT NULL, storage_key TEXT NOT NULL, certificate_name TEXT NOT NULL,
    certificate_size INTEGER NOT NULL, certificate_mime TEXT NOT NULL, status TEXT NOT NULL,
    ocr_status TEXT NOT NULL, ocr_job_id TEXT, ocr_result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`)
}
const configured = () => process.env.AWS_TEXTRACT_ENABLED === 'true' && isS3Configured && !process.env.AWS_S3_ENDPOINT
let client: TextractClient | undefined
function textract() { return client ||= new TextractClient({ region: s3Region, maxAttempts: 2 }) }

// Bound concurrent SDK calls within this process and cap the waiting queue. Calls
// still have their own timeout and the SDK retries transient throttles at most once.
const MAX_IN_FLIGHT = 4, MAX_WAITING = 32
let inFlight = 0
const waiting: Array<() => void> = []
async function bounded<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) {
    if (waiting.length >= MAX_WAITING) throw new Error('Textract queue full')
    await new Promise<void>(resolve => waiting.push(resolve))
  } else inFlight++
  try { return await fn() }
  finally {
    const next = waiting.shift()
    if (next) next() // hand the slot to the oldest waiter
    else inFlight--
  }
}

// Start is deliberately request-driven: no background worker or automatic review is implied.
export async function startDraftOcr(id: string, key: string, backend: string): Promise<OcrStatus> {
  if (!configured() || backend !== 's3') return 'not_configured'
  try {
    const r = await bounded(() => textract().send(new StartDocumentAnalysisCommand(startAnalysisInput(id, s3Bucket, key)), { abortSignal: AbortSignal.timeout(8000) }))
    if (!r.JobId) throw new Error('Missing job identifier')
    await dbRun('UPDATE sub_coi_drafts SET ocr_status = ?, ocr_job_id = ?, updated_at = ? WHERE id = ?', ['processing', r.JobId, new Date().toISOString(), id])
    return 'processing'
  } catch {
    await dbRun('UPDATE sub_coi_drafts SET ocr_status = ?, updated_at = ? WHERE id = ?', ['failed', new Date().toISOString(), id])
    return 'failed'
  }
}

export async function refreshDraftOcr(id: string, ownerId: string): Promise<any | undefined> {
  const row = await dbGet('SELECT * FROM sub_coi_drafts WHERE id = ? AND owner_user_id = ?', [id, ownerId])
  if (!row) return undefined
  if (row.ocr_status !== 'processing') return row
  // Keep the persisted job ID/state intact so polling can resume if config is restored.
  if (!configured()) return { ...row, ocr_status: 'not_configured' }
  if (!row.ocr_job_id) return { ...row, ocr_status: 'failed' }
  let outcome
  try {
    outcome = await collectOcr(token => bounded(() => textract().send(new GetDocumentAnalysisCommand({ JobId: row.ocr_job_id, NextToken: token, MaxResults: 1000 }), { abortSignal: AbortSignal.timeout(8000) })))
  } catch {
    // Polls are retryable (including throttling, queue saturation, and timeouts).
    // Do not permanently discard a still-valid job after a transient service error.
    return row
  }
  if (outcome.status === 'processing') return row
  if (outcome.status === 'failed') {
    await dbRun('UPDATE sub_coi_drafts SET ocr_status = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?', ['failed', new Date().toISOString(), id, ownerId])
    return { ...row, ocr_status: 'failed' }
  }
  const result = JSON.stringify(outcome.result)
  await dbRun('UPDATE sub_coi_drafts SET ocr_status = ?, ocr_result = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?', ['completed', result, new Date().toISOString(), id, ownerId])
  return { ...row, ocr_status: 'completed', ocr_result: result }
}
