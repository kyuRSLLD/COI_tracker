import { useEffect, useState } from 'react'
import { getToken } from '../api'

type RequirementsInput = {
  gl_per_occurrence_min: number | null
  gl_aggregate_min: number | null
  auto_limit_min: number | null
  umbrella_limit_min: number | null
  workers_comp_required: boolean
  additional_insured_required: boolean
}
type Requirements = RequirementsInput & { project_id: string; version: number; updated_at: string }
type Criterion = { key: string; status: 'meet' | 'does_not_meet' | 'unknown'; required: number | boolean; observed: number | boolean | null; reason: string }
type Evaluation = { status: 'meet' | 'does_not_meet' | 'needs_review'; criteria: Criterion[]; disclaimer: string }
type Certificate = { id: string; carrier: string; effective_date: string; expiration_date: string; status: string; simulated_carrier_connect?: boolean; evaluation: Evaluation }
type EvidenceResult = { requirements_version: number | null; disclaimer: string; subcontractors: Array<{ id: string; company_name: string; certificates: Certificate[] }> }
type AmountKey = 'gl_per_occurrence_min' | 'gl_aggregate_min' | 'auto_limit_min' | 'umbrella_limit_min'
type FormState = Record<AmountKey, string> & Pick<RequirementsInput, 'workers_comp_required' | 'additional_insured_required'>

const fields: Array<{ key: AmountKey; label: string }> = [
  { key: 'gl_per_occurrence_min', label: 'General liability per occurrence' },
  { key: 'gl_aggregate_min', label: 'General liability aggregate' },
  { key: 'auto_limit_min', label: 'Auto combined single limit' },
  { key: 'umbrella_limit_min', label: 'Umbrella per occurrence' },
]
const empty: FormState = { gl_per_occurrence_min: '', gl_aggregate_min: '', auto_limit_min: '', umbrella_limit_min: '', workers_comp_required: false, additional_insured_required: false }
const labels: Record<string, string> = { gl_per_occurrence: 'GL per occurrence', gl_aggregate: 'GL aggregate', auto_limit: 'Auto limit', umbrella_limit: 'Umbrella limit', workers_comp_present: 'Workers compensation', additional_insured_proof: 'Additional insured endorsement' }

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const token = getToken()
  const response = await fetch(url, { ...options, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}) } })
  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try { message = (await response.json()).error || message } catch { /* use status */ }
    throw new Error(message)
  }
  return response.json()
}

export function ProjectRequirementsPanel({ projectId }: { projectId: string }) {
  const [form, setForm] = useState<FormState>(empty)
  const [version, setVersion] = useState(0)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [evidence, setEvidence] = useState<EvidenceResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const base = `/api/verification/projects/${encodeURIComponent(projectId)}`

  const load = async () => {
    setLoading(true); setError(''); setMessage('')
    try {
      const [reqs, data] = await Promise.all([
        request<{ requirements: Requirements | null }>(`${base}/requirements`),
        request<EvidenceResult>(`${base}/evidence`),
      ])
      const r = reqs.requirements
      setVersion(r?.version ?? 0)
      setUpdatedAt(r?.updated_at ?? null)
      setForm(r ? { gl_per_occurrence_min: r.gl_per_occurrence_min?.toString() ?? '', gl_aggregate_min: r.gl_aggregate_min?.toString() ?? '', auto_limit_min: r.auto_limit_min?.toString() ?? '', umbrella_limit_min: r.umbrella_limit_min?.toString() ?? '', workers_comp_required: r.workers_comp_required, additional_insured_required: r.additional_insured_required } : empty)
      setEvidence(data)
      setLoaded(true)
    } catch (e) { setLoaded(false); setError(e instanceof Error ? e.message : 'Could not load requirements') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [projectId])

  const save = async () => {
    setError(''); setMessage('')
    const amounts: Partial<Record<AmountKey, number | null>> = {}
    for (const field of fields) {
      const raw = form[field.key].trim()
      if (raw && (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 2147483647)) {
        setError(`${field.label} must be a whole-dollar amount from 0 to 2,147,483,647, or blank.`); return
      }
      amounts[field.key] = raw ? Number(raw) : null
    }
    setSaving(true)
    try {
      const body = { expected_version: version, requirements: { ...amounts, workers_comp_required: form.workers_comp_required, additional_insured_required: form.additional_insured_required } }
      const result = await request<{ requirements: Requirements }>(`${base}/requirements`, { method: 'PUT', body: JSON.stringify(body) })
      setVersion(result.requirements.version); setUpdatedAt(result.requirements.updated_at)
      setMessage('Requirements saved. Evidence must still be reviewed.')
      try { setEvidence(await request<EvidenceResult>(`${base}/evidence`)) }
      catch { setEvidence(null); setError('Requirements were saved, but evidence could not be refreshed. Reload to review evidence.') }
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save requirements') }
    finally { setSaving(false) }
  }

  if (loading) return <div className="text-xs text-slate-500">Loading project requirements…</div>
  if (!loaded) return <div role="alert" className="text-xs text-rose-700">Could not load project requirements: {error}. Only the project owner can access this panel; legacy unowned projects cannot be used. <button className="underline" onClick={() => void load()}>Retry</button></div>
  return <section className="rounded-2xl border border-slate-200 p-4 space-y-4 text-sm" aria-label="Project requirements and evidence">
    <div>
      <h3 className="font-bold text-slate-800">Project requirements &amp; evidence</h3>
      <p className="text-xs text-slate-600 mt-1">These checks are separate from the existing project score. A certificate is not a guarantee of insurance; review policy terms, dates and endorsements.</p>
      <p className="text-xs text-slate-500 mt-1">{version ? `Version ${version} · updated ${updatedAt}` : 'No requirements saved yet.'} Leave a limit blank to leave it unconfigured.</p>
    </div>
    {error && <div role="alert" className="text-xs text-rose-700 bg-rose-50 rounded-lg p-3">{error} <button className="underline ml-1" onClick={() => void load()}>Reload</button></div>}
    {message && <p role="status" className="text-xs text-emerald-700">{message}</p>}
    <div className="grid sm:grid-cols-2 gap-3">
      {fields.map(field => <label key={field.key} className="text-xs font-semibold text-slate-700">{field.label} (USD)
        <input type="number" min="0" max="2147483647" step="1" value={form[field.key]} onChange={e => setForm({ ...form, [field.key]: e.target.value })} placeholder="Not configured" className="block mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
      </label>)}
    </div>
    <div className="space-y-2 text-xs text-slate-700">
      <label className="flex gap-2"><input type="checkbox" checked={form.workers_comp_required} onChange={e => setForm({ ...form, workers_comp_required: e.target.checked })} /> Workers compensation required (presence only; statutory terms not checked)</label>
      <label className="flex gap-2"><input type="checkbox" checked={form.additional_insured_required} onChange={e => setForm({ ...form, additional_insured_required: e.target.checked })} /> Additional insured endorsement proof required (manual review)</label>
    </div>
    <button onClick={() => void save()} disabled={saving} className="px-4 py-2 rounded-xl text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-50">{saving ? 'Saving…' : 'Save requirements'}</button>
    <div className="border-t border-slate-200 pt-4 space-y-3">
      <h4 className="font-bold text-slate-800">Recorded certificate evidence</h4>
      <p className="text-xs text-amber-800">{evidence?.disclaimer || 'Existing evidence is unverified and requires review.'}</p>
      {evidence && evidence.requirements_version !== version && <p className="text-xs text-amber-800">Evidence uses another requirements version. Reload to refresh.</p>}
      {evidence?.subcontractors.length === 0 && <p className="text-xs text-slate-500">No subcontractors assigned to this project.</p>}
      {evidence?.subcontractors.map(sub => <div key={sub.id} className="rounded-xl bg-slate-50 p-3 space-y-2">
        <div className="font-semibold text-slate-800">{sub.company_name}</div>
        {sub.certificates.length === 0 && <p className="text-xs text-slate-500">No certificate record. Evidence needs review.</p>}
        {sub.certificates.map(cert => <div key={cert.id} className="bg-white border border-slate-200 rounded-lg p-3 space-y-2">
          <div className="text-xs font-semibold">{cert.carrier} · {cert.effective_date} to {cert.expiration_date} · record: {cert.status}</div>
          {cert.simulated_carrier_connect && <p className="text-xs font-semibold text-amber-800">Simulated — not verified. The generated coverage is not used as evidence.</p>}
          <div className="text-xs font-bold text-amber-800">Comparison: {cert.evaluation.status.replace(/_/g, ' ')}</div>
          {cert.evaluation.criteria.length === 0 && <p className="text-xs text-slate-500">No requirements configured; no passing result.</p>}
          {cert.evaluation.criteria.map(c => <div key={c.key} className="text-xs text-slate-700"><strong>{labels[c.key] || c.key}:</strong> {c.status.replace(/_/g, ' ')} · {c.reason}{c.observed !== null && <> Recorded value: {typeof c.observed === 'number' ? `$${c.observed.toLocaleString()}` : String(c.observed)}.</>}</div>)}
          <p className="text-xs text-slate-500">{cert.evaluation.disclaimer}</p>
        </div>)}
      </div>)}
    </div>
  </section>
}
