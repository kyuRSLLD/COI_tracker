import { useEffect, useState } from 'react'
import { getToken } from '../api'

type Draft = { id: string; certificate_name: string; ocr_status: string }
type Permission = { id: string; project_id: string; project_name: string | null; gc_user_id: string; gc_name: string | null; draft_id: string; consented_at: string; revoked_at: string | null; active: number }
type SharedDraft = { permission_id: string; draft_id: string; sub_name: string; certificate_name: string; ocr_status: string }
type Criterion = { key: string; status: string; required: number | boolean; observed: number | boolean | null; reason: string }
type Review = { permission_id: string; certificate_name: string; ocr_status: string; proposal: null | { fields: Record<string, { status: string; value: string | number | null; reason: string | null }> }; requirements_version: number | null; evaluation: { status: string; criteria: Criterion[]; disclaimer: string }; disclaimer: string }
const base = '/api/draft-review'
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const auth = getToken()
  const response = await fetch(base + path, { ...options, cache: 'no-store', headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}) } })
  if (!response.ok) {
    let error = 'Request failed.'
    try { error = (await response.json()).error || error } catch { /* generic */ }
    throw new Error(error)
  }
  return response.json()
}
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })
const encode = encodeURIComponent

// Integration: mount once with role="gc" and the owned project ID, or role="sub".
// No legacy project association or client share link is used by this component.
export function DraftReviewPanel(props: { role: 'gc'; projectId: string } | { role: 'sub' }) {
  const projectId = props.role === 'gc' ? props.projectId : ''
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [capability, setCapability] = useState('')
  const [input, setInput] = useState('')
  const [preview, setPreview] = useState<{ project_id: string; project_name: string; gc_user_id: string; gc_name: string; expires_at: string } | null>(null)
  const [draftId, setDraftId] = useState('')
  const [checked, setChecked] = useState(false)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [invitations, setInvitations] = useState<Array<{ id: string; expires_at: string; consented_at: string | null; revoked_at: string | null }>>([])
  const [shared, setShared] = useState<SharedDraft[]>([])
  const [review, setReview] = useState<Review | null>(null)
  const [hours, setHours] = useState(24)
  const projectPath = `/projects/${encode(projectId)}`
  const load = async () => {
    if (props.role === 'sub') {
      const [d, p] = await Promise.all([api<{ drafts: Draft[] }>('/my/drafts'), api<{ permissions: Permission[] }>('/my/permissions')])
      setDrafts(d.drafts); setPermissions(p.permissions)
    } else {
      const [d, i] = await Promise.all([api<{ drafts: SharedDraft[] }>(`${projectPath}/drafts`), api<{ invitations: typeof invitations }>(`${projectPath}/invitations`)])
      setShared(d.drafts); setInvitations(i.invitations)
    }
  }
  useEffect(() => {
    setCapability(''); setInput(''); setPreview(null); setDraftId(''); setChecked(false); setReview(null); setShared([]); setPermissions([]); setError(''); setNotice('')
    void load().catch(e => setError(e instanceof Error ? e.message : 'Could not load draft review.'))
  }, [props.role, projectId])
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : 'Request failed.') }
    finally { setBusy(false) }
  }
  async function download(permissionId: string) {
    const link = await api<{ path: string; capability: string; expires_in_seconds: number }>(`${projectPath}/drafts/${encode(permissionId)}/document-link`, post({}))
    // Only use the exact same-origin application path expected for this project and permission.
    const expected = `${base}${projectPath}/drafts/${encode(permissionId)}/document`
    if (link.path !== expected) throw new Error('Invalid private document path.')
    const auth = getToken()
    const response = await fetch(link.path, { headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), 'X-Draft-Document-Capability': link.capability }, cache: 'no-store' })
    if (!response.ok) throw new Error('Private document is unavailable or permission has expired or been revoked.')
    const objectUrl = URL.createObjectURL(await response.blob())
    const a = document.createElement('a'); a.href = objectUrl; a.download = 'certificate'; document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000)
  }
  return <section className="rounded-2xl border border-slate-200 p-4 space-y-4 text-sm" aria-label="Draft review permissions">
    <h3 className="font-bold text-slate-800">Private draft review</h3>
    <p className="text-xs text-amber-800">Drafts and OCR proposals are unverified. This comparison is not approval or proof of coverage. Review the original, policy dates, terms and endorsements.</p>
    {error && <p role="alert" className="text-rose-700">{error}</p>}{notice && <p role="status" className="text-emerald-700">{notice}</p>}
    {props.role === 'gc' ? <>
      <div className="space-y-2 border-t pt-3">
        <h4 className="font-semibold">Invite a subcontractor to this project</h4>
        <p className="text-xs text-slate-600">Send the one-time invitation code privately to the intended subcontractor. Anyone holding it can use it once; no draft is shared until its owner explicitly consents.</p>
        <label className="block text-xs">Expires in hours (1–168) <input className="border rounded px-2 py-1" type="number" min="1" max="168" step="1" value={hours} onChange={e => setHours(Number(e.target.value))} /></label>
        <button disabled={busy || !Number.isInteger(hours) || hours < 1 || hours > 168} className="border rounded px-3 py-1 disabled:opacity-50" onClick={() => void run(async () => { const result = await api<{ invitation: { token: string } }>(`${projectPath}/invitations`, post({ expires_in_hours: hours })); setCapability(result.invitation.token); setNotice('Invitation created. Copy it now; it cannot be recovered later.'); await load() })}>Create invitation</button>
        {capability && <div><label className="text-xs">One-time invitation code <input readOnly value={capability} className="block w-full border rounded p-2 font-mono" /></label><button className="underline text-xs" onClick={() => { void navigator.clipboard.writeText(capability).then(() => setNotice('Copied. Transfer privately.'), () => setError('Copy failed; select and copy the code manually.')) }}>Copy code</button><button className="underline text-xs ml-3" onClick={() => setCapability('')}>Clear code</button></div>}
        {invitations.map(i => <div key={i.id} className="text-xs">Invitation {i.id.slice(0, 8)} · {i.revoked_at ? 'revoked' : i.consented_at ? 'accepted' : `expires ${i.expires_at}`} {!i.revoked_at && <button disabled={busy} className="underline ml-2" onClick={() => void run(async () => { await api(`/permissions/${encode(i.id)}/revoke`, post({})); setReview(null); await load() })}>Revoke</button>}</div>)}
      </div>
      <div className="space-y-2 border-t pt-3"><h4 className="font-semibold">Consented drafts</h4>
        {!shared.length && <p className="text-xs">No drafts have been shared with this project.</p>}
        {shared.map(d => <div key={d.permission_id} className="text-xs border rounded p-2">{d.sub_name} · {d.certificate_name} · OCR {d.ocr_status}<div className="space-x-3 mt-1"><button className="underline" disabled={busy} onClick={() => void run(async () => { setReview((await api<{ review: Review }>(`${projectPath}/drafts/${encode(d.permission_id)}`)).review) })}>Review proposal</button><button className="underline" disabled={busy} onClick={() => void run(() => download(d.permission_id))}>Download private document</button></div></div>)}
        {review && <div className="space-y-2 bg-slate-50 rounded p-3"><strong>{review.certificate_name}</strong><p>{review.disclaimer}</p><p>Requirements version: {review.requirements_version ?? 'not saved'} · Comparison: {review.evaluation.status.replace(/_/g, ' ')}</p>
          {review.evaluation.criteria.length === 0 && <p>No requirements configured; no passing result.</p>}
          {review.evaluation.criteria.map(c => <p key={c.key}>{c.key.replace(/_/g, ' ')}: {c.status.replace(/_/g, ' ')} · Required {String(c.required)}{c.observed !== null ? ` · Proposed ${String(c.observed)}` : ''} · {c.reason}</p>)}
          <p className="font-semibold">OCR proposals (unverified; OCR status: {review.ocr_status})</p>
          {!review.proposal && <p>No completed proposal is available.</p>}
          {review.proposal && Object.entries(review.proposal.fields).map(([key, f]) => <p key={key}>{key}: {f.value === null ? 'unknown' : String(f.value)} ({f.status}{f.reason ? `: ${f.reason}` : ''})</p>)}
          <p>{review.evaluation.disclaimer}</p></div>}
      </div>
    </> : <>
      <div className="space-y-2 border-t pt-3"><h4 className="font-semibold">Choose whether to share one draft</h4>
        <label className="text-xs block">Invitation code from the project owner <input value={input} autoComplete="off" className="block w-full border rounded p-2 font-mono" onChange={e => { setInput(e.target.value); setPreview(null); setChecked(false) }} /></label>
        <button disabled={busy} className="border rounded px-3 py-1" onClick={() => void run(async () => { const r = await api<{ invitation: NonNullable<typeof preview> }>('/invitations/preview', post({ token: input.trim() })); setPreview(r.invitation); setChecked(false) })}>Inspect invitation</button>
        {preview && <div className="bg-slate-50 rounded p-3 space-y-2"><p>Project: <strong>{preview.project_name}</strong> ({preview.project_id}) · GC owner: <strong>{preview.gc_name}</strong> ({preview.gc_user_id}) · Expires: {preview.expires_at}</p>
          <label className="block">Draft <select className="border rounded p-1" value={draftId} onChange={e => { setDraftId(e.target.value); setChecked(false) }}><option value="">Choose a draft</option>{drafts.map(d => <option key={d.id} value={d.id}>{d.certificate_name} ({d.id})</option>)}</select></label>
          <label className="flex gap-2"><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} />I consent to sharing this selected draft and its OCR proposals with this named project owner for this project.</label>
          <button disabled={busy || !checked || !draftId} className="border rounded px-3 py-1 disabled:opacity-50" onClick={() => void run(async () => { await api('/permissions', post({ token: input.trim(), project_id: preview.project_id, draft_id: draftId, consent: true })); setInput(''); setPreview(null); setChecked(false); setDraftId(''); setNotice('Permission granted. You can revoke it below.'); await load() })}>Share selected draft</button>
        </div>}
      </div>
      <div className="space-y-2 border-t pt-3"><h4 className="font-semibold">Your permissions</h4>{!permissions.length && <p className="text-xs">No permissions granted.</p>}{permissions.map(p => <div key={p.id} className="text-xs border rounded p-2">{p.project_name || 'Unavailable project'} ({p.project_id}) · {p.gc_name || 'Unavailable owner'} ({p.gc_user_id}) · draft {p.draft_id} · {p.revoked_at ? 'revoked' : p.active ? 'active' : 'inactive'} {!p.revoked_at && <button disabled={busy} className="underline ml-2" onClick={() => void run(async () => { await api(`/permissions/${encode(p.id)}/revoke`, post({})); await load() })}>Revoke</button>}</div>)}</div>
    </>}
  </section>
}
