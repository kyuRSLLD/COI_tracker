import { useCallback, useEffect, useRef, useState } from 'react'
import { getStoredUser } from '../../api'
import { SubcontractorQrScanner } from '../SubcontractorQrScanner'
import { GcPrototypeInvite } from './GcPrototypeInvite'
import { gcPrototypeApi, relationshipPrototypeEnabled } from './gcPrototypeApi'
import type { PrototypeCoi, PrototypeConnection } from './gcPrototypeApi'

const field = (value: string | number | null | undefined) => value === null || value === undefined || value === '' ? 'Not provided' : String(value)
const yesNo = (value: number | boolean | null | undefined) => value === true || value === 1 ? 'Yes' : value === false || value === 0 ? 'No' : 'Not provided'

function Detail({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs font-semibold text-slate-500">{label}</dt><dd className="break-words text-sm text-slate-800">{value}</dd></div>
}
function CoiDetails({ coi }: { coi: PrototypeCoi }) {
  return <article className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
    <h5 className="font-semibold text-slate-900">COI: {field(coi.carrier)}</h5>
    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Detail label="Carrier" value={field(coi.carrier)} /><Detail label="AM Best rating" value={field(coi.am_best_rating)} />
      <Detail label="Policy number" value={field(coi.policy_number)} /><Detail label="Effective date" value={field(coi.effective_date)} />
      <Detail label="Expiration date" value={field(coi.expiration_date)} /><Detail label="Status" value={field(coi.status)} />
      <Detail label="Reviewer notes" value={field(coi.reviewer_notes)} /><Detail label="Review date" value={field(coi.review_date)} />
      <Detail label="Certificate name (metadata)" value={field(coi.certificate_name)} /><Detail label="Certificate size (bytes)" value={field(coi.certificate_size)} />
      <Detail label="Certificate MIME type" value={field(coi.certificate_mime)} /><Detail label="Created" value={field(coi.created_at)} />
      <Detail label="Updated" value={field(coi.updated_at)} />
    </dl>
    <div><h6 className="text-sm font-bold text-slate-800">Coverages</h6>
      {coi.coverages.length === 0 ? <p className="mt-2 text-sm text-slate-500">No coverage records.</p> : <div className="mt-2 space-y-3">{coi.coverages.map(coverage => <dl key={coverage.id} className="grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-2 lg:grid-cols-3">
        <Detail label="Coverage type" value={field(coverage.type)} /><Detail label="Per occurrence limit" value={field(coverage.per_occurrence_limit)} />
        <Detail label="Aggregate limit" value={field(coverage.aggregate_limit)} /><Detail label="Additional insured" value={yesNo(coverage.additional_insured)} />
        <Detail label="Waiver of subrogation" value={yesNo(coverage.waiver_of_subrogation)} /><Detail label="Notes" value={field(coverage.notes)} />
      </dl>)}</div>}
    </div>
  </article>
}

/** Mount only for the currently signed-in synthetic GC. Invitation creation is disabled. */
export function GcRelationshipPrototype() {
  if (!relationshipPrototypeEnabled || getStoredUser()?.role !== 'gc') return null
  return <GcRelationshipPrototypeContent />
}
function GcRelationshipPrototypeContent() {
  const [connections, setConnections] = useState<PrototypeConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [showScanner, setShowScanner] = useState(false)
  const [success, setSuccess] = useState('')
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    const request = ++generation.current
    setLoading(true); setListError(''); setConnections([])
    try {
      const result = await gcPrototypeApi.connections()
      if (!Array.isArray(result.connections)) throw new Error('Invalid response')
      if (request === generation.current) setConnections(result.connections)
    } catch {
      if (request === generation.current) setListError('Could not load test connections. Refresh to try again.')
    } finally { if (request === generation.current) setLoading(false) }
  }, [])
  useEffect(() => { void refresh(); return () => { generation.current += 1 } }, [refresh])

  return <section aria-labelledby="gc-relationship-prototype-title" className="space-y-5 rounded-2xl border border-amber-300 bg-amber-50 p-4 sm:p-6">
    <div>
      <p className="text-xs font-bold uppercase tracking-wider text-amber-800">Development only · synthetic test data</p>
      <h2 id="gc-relationship-prototype-title" className="mt-1 text-xl font-extrabold text-slate-900">GC relationship prototype</h2>
      <p className="mt-2 text-sm text-slate-700">This experiment creates test-only relationships and displays structured COI information from connected synthetic subcontractors. Certificate file download is unavailable. It does not create client-share access; other legacy application surfaces are not secured by this experiment. Do not use real accounts, people, or data.</p>
    </div>
    {!showScanner && <button type="button" onClick={() => { setSuccess(''); setShowScanner(true) }} className="min-h-11 rounded-xl bg-brand-600 px-4 py-2 text-sm font-bold text-white">Scan or paste a subcontractor QR</button>}
    {showScanner && <SubcontractorQrScanner
      allowRawPrototypeToken
      onValidToken={async token => {
        const result = await gcPrototypeApi.preview(token)
        if (typeof result.company_name !== 'string' || !result.company_name.trim()) throw new Error('Invalid preview')
        return { companyName: result.company_name, trade: result.trade }
      }}
      onConfirmToken={async token => {
        const result = await gcPrototypeApi.accept(token)
        if (result.status !== 'connected') throw new Error('Unexpected response')
      }}
      onConnected={() => { setShowScanner(false); setSuccess('Test connection confirmed. A list refresh was requested.'); void refresh() }}
      onClose={() => setShowScanner(false)}
      reviewDescription="This company and trade are self-reported, not independently verified. Confirm to connect in this development-only prototype and view its structured COI information. No certificate files are available."
      confirmLabel="Confirm test connection"
    />}
    {success && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900">{success}</p>}
    <section aria-label="Test connections" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold text-slate-900">Connected test subcontractors</h3><button type="button" disabled={loading} onClick={() => void refresh()} className="min-h-11 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold disabled:opacity-50">Refresh list</button></div>
      {loading && <p role="status" className="text-sm text-slate-600">Loading test connections…</p>}
      {listError && <p role="alert" className="text-sm text-rose-800">{listError}</p>}
      {!loading && !listError && connections.length === 0 && <p className="text-sm text-slate-600">No active test connections.</p>}
      {!loading && !listError && connections.map(connection => <article key={connection.sub_user_id} className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <div><h4 className="font-bold text-slate-900">{field(connection.company_name)}</h4><p className="text-sm text-slate-600">Trade: {field(connection.trade)} · Connected: {field(connection.connected_at)}</p></div>
        <p className="text-sm text-slate-600">Structured COI metadata only; certificate file download is unavailable. Link-like metadata may be omitted.</p>
        {connection.cois.length ? connection.cois.map(coi => <CoiDetails key={coi.id} coi={coi} />) : <p className="text-sm text-slate-600">No COIs on file in this test connection.</p>}
      </article>)}
    </section>
    <GcPrototypeInvite />
  </section>
}
