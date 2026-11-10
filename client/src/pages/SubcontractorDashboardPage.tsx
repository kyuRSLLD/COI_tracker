import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  ShieldCheck, Upload, LogIn, CheckCircle2, Clock, FileText, AlertTriangle,
  Copy, Check, ExternalLink, RefreshCw, Sparkles, Building2, Phone, Mail, Award, Send,
} from 'lucide-react'
import { apiSub, apiLogout, apiSendCOIEmail, apiSubSentEmails } from '../api'
import type { SubcontractorDashboardData, COI } from '../types'
import { QRCodeSVG } from 'qrcode.react'

const CARRIERS = ['Travelers', 'The Hartford', 'Liberty Mutual', 'Nationwide', 'CNA Financial', 'Progressive', 'Zurich']

export function SubcontractorDashboardPage() {
  const [data, setData] = useState<SubcontractorDashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // quick upload state
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [carrier, setCarrier] = useState('')
  const [policyNum, setPolicyNum] = useState('')
  const [expDate, setExpDate] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadSuccess, setUploadSuccess] = useState(false)

  // carrier connect state
  const [selectedCarrier, setSelectedCarrier] = useState(CARRIERS[0])
  const [carrierPolicy, setCarrierPolicy] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [connectSuccess, setConnectSuccess] = useState<string | null>(null)

  // share
  const [copied, setCopied] = useState(false)
  const [showQr, setShowQr] = useState(false)
  // email-a-contractor
  const [emailOpen, setEmailOpen] = useState(false)
  const [emailTo, setEmailTo] = useState('')
  const [emailGcName, setEmailGcName] = useState('')
  const [emailMsg, setEmailMsg] = useState('')
  const [sendingEmail, setSendingEmail] = useState(false)
  const [sentOk, setSentOk] = useState<string | null>(null)
  const [sentError, setSentError] = useState<string | null>(null)
  const [sentList, setSentList] = useState<{ id: string; to_email: string; subject: string; status: string; sent_at: string }[]>([])
  const [emailPreviewOpen, setEmailPreviewOpen] = useState(true)

  const load = async () => {
    try {
      setError(null)
      const res = await apiSub.my()
      setData(res)
      apiSubSentEmails().then((r) => setSentList(r.emails || [])).catch(() => {})
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])
  const handleSendEmail = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!emailTo) return
    setSendingEmail(true)
    setSentOk(null)
    setSentError(null)
    try {
      await apiSendCOIEmail({
        to_email: emailTo.trim(),
        gc_company_name: emailGcName.trim() || undefined,
        message: emailMsg.trim() || undefined,
      })
      setSentOk(`COI emailed to ${emailTo.trim()} — they'll receive your verified coverage summary and a link to view the full document, plus an invite to join COI Shield free.`)
      setEmailTo('')
      setEmailGcName('')
      setEmailMsg('')
      apiSubSentEmails().then((r) => setSentList(r.emails || [])).catch(() => {})
    } catch (err: any) {
      setSentError(err.message || 'Failed to send email')
    } finally {
      setSendingEmail(false)
    }
  }

  const handleQuickUpload = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!file) return
    setUploading(true)
    try {
      const form = new FormData()
      form.append('certificate', file)
      if (carrier) form.append('carrier', carrier)
      if (policyNum) form.append('policy_number', policyNum)
      if (expDate) form.append('expiration_date', expDate)
      await apiSub.quickUpload(form)
      setFile(null)
      setCarrier('')
      setPolicyNum('')
      setExpDate('')
      setUploadSuccess(true)
      setTimeout(() => setUploadSuccess(false), 5000)
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  }

  const handleCarrierConnect = async () => {
    setConnecting(true)
    try {
      const res = await apiSub.carrierConnect(selectedCarrier, carrierPolicy || undefined)
      setConnectSuccess(`Connected to ${res.carrier} · policy ${res.policy_number} verified`)
      setTimeout(() => setConnectSuccess(null), 6000)
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setConnecting(false)
    }
  }

  const publicUrl = data ? `${window.location.origin}${data.public_share_url}` : ''
  const copyLink = () => {
    if (!publicUrl) return
    navigator.clipboard?.writeText(publicUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const daysUntil = (d: string) => Math.ceil((new Date(d).getTime() - Date.now()) / 86400000)

  if (loading) {
    return <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-500">Loading your insurance portal…</div>
  }

  const sub = data?.subcontractor
  const cois = data?.cois || []

  return (
    <div className="min-h-screen bg-slate-50">
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900">{sub?.company_name}</h1>
            <p className="text-xs text-slate-500">Subcontractor insurance portal · {sub?.trade}</p>
          </div>
          <span className="text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
            {cois.length === 0 ? 'No COI on file' : `${cois.length} certificate on file`}
          </span>
        </div>

        {/* Free first month banner */}
        <div className="rounded-2xl bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-200 p-4 flex items-start gap-3 text-xs text-emerald-900">
          <Sparkles className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
          <p>
            <span className="font-semibold">Free for your first month.</span> Submit or connect your insurance paper once — after 30 days it's just a $2 one-time fee to keep your certificate hosted for every contractor who asks.
          </p>
        </div>

        {error && (
          <div className="rounded-xl bg-rose-50 border border-rose-200 p-3 text-xs text-rose-800">{error}</div>
        )}

        {/* Two main actions */}
        <div className="grid md:grid-cols-2 gap-5">
          {/* Action 1: Upload insurance paper */}
          <div className="rounded-2xl bg-white border border-slate-200 p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-1">
              <Upload className="w-4 h-4 text-slate-700" />
              <h2 className="text-sm font-semibold text-slate-900">Upload your insurance paper</h2>
            </div>
            <p className="text-xs text-slate-500 mb-4">
              Drop your ACORD certificate (PDF or photo) — you can fill the rest later or let your broker handle it.
            </p>

            <form onSubmit={handleQuickUpload} className="space-y-3">
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,image/png,image/jpeg"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="hidden"
              />
              <div
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition ${
                  file ? 'border-emerald-400 bg-emerald-50/40' : 'border-slate-300 hover:border-slate-400 bg-slate-50'
                }`}
              >
                <FileText className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                {file ? (
                  <p className="text-xs font-semibold text-slate-800">{file.name} ({(file.size / 1024).toFixed(0)} KB)</p>
                ) : (
                  <>
                    <p className="text-xs font-semibold text-slate-700">Click to choose a file, or drag it here</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">ACORD 25 certificate · PDF, PNG, JPG up to 25 MB</p>
                  </>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">Carrier (optional)</label>
                  <input
                    value={carrier}
                    onChange={(e) => setCarrier(e.target.value)}
                    placeholder="e.g. Liberty Mutual"
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">Policy # (optional)</label>
                  <input
                    value={policyNum}
                    onChange={(e) => setPolicyNum(e.target.value)}
                    placeholder="e.g. LM-GL-2026-00123"
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Expiration date (optional)</label>
                <input
                  type="date"
                  value={expDate}
                  onChange={(e) => setExpDate(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs"
                />
              </div>

              <button
                type="submit"
                disabled={!file || uploading}
                className="w-full text-xs font-semibold py-2 rounded-xl bg-slate-900 text-white disabled:opacity-40 hover:bg-slate-800 transition"
              >
                {uploading ? 'Uploading…' : file ? 'Upload certificate' : 'Choose a file first'}
              </button>
            </form>

            {uploadSuccess && (
              <div className="mt-3 text-xs text-emerald-700 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" /> Certificate submitted — it will appear below under review.
              </div>
            )}
          </div>

          {/* Action 2: Carrier connect */}
          <div className="rounded-2xl bg-white border border-slate-200 p-6 shadow-sm flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <LogIn className="w-4 h-4 text-indigo-600" />
                <h2 className="text-sm font-semibold text-slate-900">Or log into your insurance company</h2>
              </div>
              <p className="text-xs text-slate-500 mb-4">
                Pick your carrier and we pull your active policy automatically — instant, verified coverage.
              </p>

              <div className="space-y-3">
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">Insurance company</label>
                  <select
                    value={selectedCarrier}
                    onChange={(e) => setSelectedCarrier(e.target.value)}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs bg-white"
                  >
                    {CARRIERS.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">Policy number (optional)</label>
                  <input
                    value={carrierPolicy}
                    onChange={(e) => setCarrierPolicy(e.target.value)}
                    placeholder="Leave blank for an auto-generated verified demo policy"
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs"
                  />
                </div>
              </div>
            </div>

            <div className="mt-4">
              <button
                type="button"
                onClick={handleCarrierConnect}
                disabled={connecting}
                className="w-full text-xs font-semibold py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 transition flex items-center justify-center gap-1.5"
              >
                {connecting ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <LogIn className="w-3.5 h-3.5" />}
                {connecting ? 'Connecting to ' + selectedCarrier + '…' : 'Sign in with ' + selectedCarrier}
              </button>
              <p className="text-[11px] text-slate-400 mt-2 text-center">
                Simulated carrier login — creates a real verified COI in your account for the demo.
              </p>
              {connectSuccess && (
                <div className="mt-3 text-xs text-emerald-700 flex items-center gap-1.5 justify-center">
                  <CheckCircle2 className="w-3.5 h-3.5" /> {connectSuccess}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* My certificates */}
        <section className="rounded-2xl bg-white border border-slate-200 p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">My certificates on file</h3>
              <p className="text-xs text-slate-500">Every COI you've uploaded or connected, newest first.</p>
            </div>
            <span className="text-xs text-slate-400">{cois.length} on file</span>
          </div>

          {cois.length === 0 ? (
            <div className="border border-dashed border-slate-200 rounded-xl p-8 text-center text-xs text-slate-400">
              No certificates on file yet — use the cards above to upload or connect one in a minute.
            </div>
          ) : (
            <div className="space-y-3">
              {cois.map((coi: COI) => {
                const days = daysUntil(coi.expiration_date)
                const expired = days < 0
                const expiring = days >= 0 && days <= 30
                const badge = expired
                  ? { label: 'Expired', cls: 'bg-rose-50 text-rose-700 border-rose-200' }
                  : expiring
                  ? { label: `Expires in ${days}d`, cls: 'bg-amber-50 text-amber-700 border-amber-200' }
                  : { label: `${days}d left`, cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
                return (
                  <div key={coi.id} className="border border-slate-200 rounded-xl p-4 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Award className="w-4 h-4 text-slate-500" />
                        <span className="font-semibold text-slate-900">{coi.carrier}</span>
                        {coi.am_best_rating && (
                          <span className="text-[11px] text-slate-400">AM Best: {coi.am_best_rating}</span>
                        )}
                        <span className={`px-2 py-0.5 rounded-full border text-[11px] font-medium ${badge.cls}`}>
                          {badge.label}
                        </span>
                        <span className="px-2 py-0.5 rounded-full border text-[11px] font-medium capitalize text-slate-600 bg-slate-50 border-slate-200">
                          {coi.status.replace('_', ' ')}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-slate-400 text-[11px]">
                        <span>Pol. {coi.policy_number || '—'}</span>
                        <span>·</span>
                        <span>{coi.effective_date} → {coi.expiration_date}</span>
                      </div>
                    </div>

                    {coi.reviewer_notes && (
                      <p className="text-[11px] text-slate-500 mt-2 italic">{coi.reviewer_notes}</p>
                    )}

                    {cois && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {(coi.coverages || []).map((cv) => (
                          <span
                            key={cv.id}
                            className="text-[11px] px-2 py-0.5 rounded bg-slate-100 text-slate-700"
                            title={`${cv.type} · per ${cv.per_occurrence_limit} · agg ${cv.aggregate_limit}`}
                          >
                            {cv.type}: {cv.per_occurrence_limit}
                          </span>
                        ))}
                      </div>
                    )}

                    {coi.certificate_url && (
                      <div className="mt-3 text-[11px]">
                        <a
                          href={coi.certificate_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-indigo-600 hover:underline"
                        >
                          View uploaded paper ({coi.certificate_name || 'document'}) <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* Requests from contractors */}
        {data && data.requests.length > 0 && (
          <section className="rounded-2xl bg-white border border-slate-200 p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-1">
              <Building2 className="w-4 h-4 text-slate-700" />
              <h3 className="text-sm font-semibold text-slate-900">Requests from contractors</h3>
            </div>
            <p className="text-xs text-slate-500 mb-3">
              GCs who asked for your COI. Upload once and both sides are covered.
            </p>
            <div className="space-y-2">
              {data.requests.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 border border-slate-200 rounded-xl p-3 text-xs">
                  <div>
                    <span className="font-semibold text-slate-900">{r.gc_company_name || r.requested_by_email || 'General contractor'}</span>
                    <span className="text-slate-400 text-[11px] ml-2">requested {new Date(r.created_at).toLocaleDateString()}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (cois.length > 0) {
                        alert('Your newest certificate is already on file and visible to this GC.')
                      } else {
                        fileInputRef.current?.click()
                      }
                    }}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-900 text-white hover:bg-slate-800"
                  >
                    {cois.length > 0 ? 'COI already on file ✓' : 'Upload for this GC'}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Share your COI */}
        <section className="rounded-2xl bg-white border border-slate-200 p-6 shadow-sm text-xs space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Share your COI with any contractor</h3>
              <p className="text-slate-500">A public verification page showing your company, trade, and latest verified COI.</p>
            </div>
            <button
              type="button"
              onClick={() => setShowQr((v) => !v)}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50"
            >
              {showQr ? 'Hide QR' : 'Show QR'}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              readOnly
              value={publicUrl}
              className="flex-1 min-w-[260px] px-2.5 py-1.5 rounded-lg border border-slate-200 font-mono text-[11px] bg-slate-50 text-slate-700"
            />
            <button
              type="button"
              onClick={copyLink}
              className="px-3 py-1.5 rounded-lg bg-slate-900 text-white font-semibold flex items-center gap-1 hover:bg-slate-800"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <a
              href={data?.public_share_url}
              target="_blank"
              rel="noreferrer"
              className="px-3 py-1.5 rounded-lg border border-slate-200 font-semibold hover:bg-slate-50 flex items-center gap-1"
            >
              Open <ExternalLink className="w-3 h-3" />
            </a>
            <button
              type="button"
              onClick={() => { setEmailOpen(true); setSentOk(null); setSentError(null) }}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-semibold hover:bg-emerald-700 flex items-center gap-1.5 shadow-sm"
              title="Email your COI directly to a GC — even if they don't have an account"
            >
              <Mail className="w-3.5 h-3.5" /> Email a contractor
            </button>
          </div>

          {showQr && publicUrl && (
            <div className="pt-2 flex flex-col items-center text-center">
              <div className="p-3 bg-white border border-slate-200 rounded-xl shadow-xs">
                <QRCodeSVG value={publicUrl} size={180} level="M" />
              </div>
              <p className="text-[11px] text-slate-400 mt-2">
                Scan to open your public COI verification card on a phone.
              </p>
            </div>
          )}
          {sentOk && (
            <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-3 text-emerald-900 text-xs">
              {sentOk}
            </div>
          )}
        </section>
        {/* Email a contractor modal */}
        {emailOpen && (
          <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full border border-slate-200 overflow-hidden">
              <div className="p-5 border-b border-slate-200 flex items-start justify-between">
                <div>
                  <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <Mail className="w-4 h-4 text-emerald-600" /> Email your COI to a contractor
                  </h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Great when the GC doesn't have a COI Shield account yet — they'll receive your verified COI summary, a link to view/download the full document, and an invite to create a free contractor account.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setEmailOpen(false)}
                  className="text-slate-400 hover:text-slate-600 text-lg leading-none px-1"
                >
                  ×
                </button>
              </div>
              <form onSubmit={handleSendEmail} className="p-5 space-y-3.5 text-xs">
                {sentError && (
                  <div className="rounded-xl bg-rose-50 border border-rose-200 p-3 text-rose-800">{sentError}</div>
                )}
                {cois.length === 0 ? (
                  <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-amber-900">
                    Upload or connect a certificate first before emailing it to a contractor.
                  </div>
                ) : (
                  <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 text-[11px] text-slate-600">
                    <span className="font-semibold text-slate-800">Sending your latest verified COI:</span>{' '}
                    {cois[0].carrier || 'Carrier on file'} · {cois[0].policy_number ? `Pol. ${cois[0].policy_number} · ` : ''}expires {cois[0].expiration_date}
                  </div>
                )}
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Contractor email *</label>
                  <input
                    type="email"
                    required
                    value={emailTo}
                    onChange={(e) => setEmailTo(e.target.value)}
                    placeholder="pm@acmecontracting.com"
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 text-xs focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Contractor company name (optional)</label>
                  <input
                    type="text"
                    value={emailGcName}
                    onChange={(e) => setEmailGcName(e.target.value)}
                    placeholder="Acme Contracting"
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 text-xs focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Personal note (optional)</label>
                  <textarea
                    rows={3}
                    value={emailMsg}
                    onChange={(e) => setEmailMsg(e.target.value)}
                    placeholder="e.g. Here is our updated insurance certificate for the Meridian job site."
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 text-xs focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-[11px] space-y-2">
                  <div className="flex items-center justify-between text-slate-500">
                    <span className="font-semibold text-slate-700 flex items-center gap-1.5">
                      <Mail className="w-3.5 h-3.5 text-emerald-600" /> Email preview (what the contractor will receive)
                    </span>
                    <button
                      type="button"
                      onClick={() => setEmailPreviewOpen((v) => !v)}
                      className="text-emerald-700 hover:underline font-semibold"
                    >
                      {emailPreviewOpen ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  {emailPreviewOpen && (
                    <div className="bg-white rounded-lg border border-slate-200 p-3 space-y-2 text-slate-700">
                      <div className="text-[10px] text-slate-400 font-mono pb-2 border-b border-slate-100 flex flex-wrap gap-x-3 gap-y-0.5">
                        <span><strong>FROM:</strong> {sub?.company_name || 'Your company'} &lt;noreply@safecoi.com&gt;</span>
                        <span><strong>TO:</strong> {emailTo || '(enter email above)'}</span>
                      </div>
                      <div className="font-bold text-slate-900 text-xs">
                        Subject: Certificate of Insurance from {sub?.company_name || 'your subcontractor'} — verified via COI Shield
                      </div>
                      <p className="text-slate-600">
                        Hi {emailGcName ? `${emailGcName} team` : 'team'},
                      </p>
                      <p className="text-slate-600">
                        <strong>{sub?.company_name || 'Your company'}</strong>{sub?.trade ? ` (${sub.trade})` : ''} has shared their verified Certificate of Insurance with you.
                      </p>
                      {emailMsg && (
                        <blockquote className="border-l-2 border-emerald-500 pl-2.5 text-slate-700 italic">
                          "{emailMsg}"
                        </blockquote>
                      )}
                      {cois.length > 0 && (
                        <div className="rounded-md bg-slate-50 border border-slate-200 p-2 text-[10px] space-y-1">
                          <div className="font-semibold text-slate-800">POLICY SUMMARY</div>
                          <div>Carrier: <span className="font-mono">{cois[0].carrier || 'on file'}</span></div>
                          {cois[0].policy_number && <div>Policy #: <span className="font-mono">{cois[0].policy_number}</span></div>}
                          <div>Expires: <span className="font-mono font-semibold text-slate-900">{cois[0].expiration_date}</span></div>
                          {cois[0].coverages && cois[0].coverages.length > 0 && (
                            <div>
                              Coverages: {cois[0].coverages.map((cv: any) => `${cv.type}${cv.per_occurrence_limit ? ` · ${cv.per_occurrence_limit}` : ''}`).join(', ')}
                            </div>
                          )}
                        </div>
                      )}
                      <div className="pt-1 flex flex-wrap gap-2 text-[10px]">
                        <span className="px-2.5 py-1 rounded-md bg-emerald-600 text-white font-semibold inline-flex items-center gap-1">
                          View &amp; download full COI ↗
                        </span>
                        <span className="px-2.5 py-1 rounded-md border border-slate-300 font-semibold text-slate-700">
                          Create free contractor account
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-500 pt-1">
                        Manage all your subcontractors' insurance in one place — expiration reminders, client-safe compliance reports, and one-click COI requests.
                      </p>
                      <div className="text-[9px] text-slate-400 pt-1 border-t border-slate-100">
                        This message was sent by {sub?.company_name || 'your subcontractor'} via COI Shield · safecoi.com
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setEmailOpen(false)}
                    className="px-3.5 py-1.5 rounded-lg border border-slate-200 font-semibold hover:bg-slate-50 text-slate-700"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={sendingEmail || cois.length === 0}
                    className="px-4 py-1.5 rounded-lg bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1.5 shadow-sm"
                  >
                    <Send className="w-3.5 h-3.5" />
                    {sendingEmail ? 'Sending…' : 'Send COI via email'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
        {/* Emails sent log */}
        {sentList.length > 0 && (
          <section className="rounded-2xl bg-white border border-slate-200 p-6 shadow-sm text-xs space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Emails you've sent to contractors</h3>
                <p className="text-slate-500">Every COI you emailed is logged for your records.</p>
              </div>
              <span className="text-[11px] font-semibold text-slate-400">{sentList.length} sent</span>
            </div>
            <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden">
              {sentList.map((em) => (
                <div key={em.id} className="p-3 flex flex-wrap items-center justify-between gap-2 hover:bg-slate-50/60">
                  <div>
                    <span className="font-semibold text-slate-900">{em.to_email}</span>
                    <p className="text-slate-500 text-[11px] mt-0.5">{em.subject}</p>
                  </div>
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">{em.status}</span>
                    <span className="text-slate-400">{new Date(em.sent_at).toLocaleString()}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Footer info */}
        <div className="text-center text-[11px] text-slate-400 py-4">
          Subcontractor portal · need help? Contact your requesting general contractor or sign in with another account.
        </div>
      </main>
    </div>
  )
}
