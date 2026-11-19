import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Clock, Copy, Download, Edit3, ExternalLink, Printer, RefreshCw, Save, ShieldCheck, XCircle } from 'lucide-react'
import type { COI } from '../types'
import { coiExpiryAllExpired, isPartiallyExpired } from '../lib/coiExpiry'
import { formatDisplayDate, daysFromNow, isExpiredDate } from '../lib/date'
import { apiCoiFields, getToken, getStoredUser } from '../api'
import type { CoiFields } from '../lib/coiFields'
interface Producer { name?: string; address?: string; phone?: string; email?: string }
interface Insured { name?: string; address?: string; phone?: string; email?: string }
interface Insurer { letter?: string; name?: string; naic?: string }
interface Limit { label?: string; amount?: string }
interface Policy {
  type?: string
  insurerLetter?: string
  policyNumber?: string
  effectiveDate?: string
  expirationDate?: string
  limits?: Limit[]
  [k: string]: unknown
}
export interface ExtractedDetails {
  producer?: Producer
  insured?: Insured
  insurers?: Insurer[]
  policies?: Policy[]
  [k: string]: unknown
}
interface ReviewDetailsPayload {
  editable: boolean
  sourceTag: string
  reviewRevision: string
  details?: ExtractedDetails | null
  certificateUrl?: string | null
}
interface Props {
  coi: COI
  extracted?: ExtractedDetails | null
  onOpenOriginal?: () => void
  onOpenFile?: () => void
  onOpenEditModal?: () => void
  onEdit?: () => void
  onCheckAgain?: () => void
  onSaved?: () => void
  fileUrl?: string | null
  docProxyUrl?: string | null
  fileBadge?: string
  checkAgainBusy?: boolean
  hideBanner?: boolean
  hasFile?: boolean
  dense?: boolean
}

type Slot = 'gl' | 'auto' | 'umb' | 'wc' | 'other'
function slotForPolicy(t?: string): Slot {
  const s = (t || '').toLowerCase()
  if (s.includes('general')) return 'gl'
  if (s.includes('auto')) return 'auto'
  if (s.includes('umbrella') || s.includes('excess')) return 'umb'
  if (s.includes('workers') || s.includes('employer')) return 'wc'
  return 'other'
}
function todayDisplay(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mm}/${dd}/${d.getFullYear()}`
}
function detectWording(notes?: string | null) {
  const n = (notes || '').toLowerCase()
  return {
    additionalInsured: n.includes('additional insured'),
    waiverOfSubrogation: n.includes('waiver of subrogation'),
    primaryNonContributory: n.includes('primary and non-contributory') || n.includes('primary & non-contributory'),
  }
}
function normalizeInputDate(v: string): string {
  const digits = v.replace(/\D/g, '').slice(0, 8)
  if (digits.length >= 5) return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`
  if (digits.length >= 3) return `${digits.slice(0, 2)}/${digits.slice(2)}`
  return digits
}

const INSURER_ROWS = ['A', 'B', 'C', 'D', 'E', 'F']

export function AcordCertificateForm({
  coi,
  extracted: extractedProp,
  onOpenOriginal,
  onOpenFile,
  onOpenEditModal,
  onEdit,
  onCheckAgain,
  onSaved,
  fileUrl,
  docProxyUrl,
  fileBadge = 'PDF',
  checkAgainBusy,
  hideBanner = false,
  dense = false,
}: Props) {
  const [extracted, setExtracted] = useState<ExtractedDetails | null>(extractedProp ?? null)
  const [reviewPayload, setReviewPayload] = useState<ReviewDetailsPayload | null>(null)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveOk, setSaveOk] = useState(false)
  const [edit, setEdit] = useState<{
    date: string
    certificateNumber: string
    revisionNumber: string
    producerName: string
    producerAddress: string
    producerContact: string
    producerPhone: string
    producerFax: string
    producerEmail: string
    insuredName: string
    insuredAddress: string
    insuredPhone: string
    insuredEmail: string
    insurers: Insurer[]
    policies: Policy[]
    holderName: string
    holderAddress: string
    operations: string
  }>({
    date: todayDisplay(),
    certificateNumber: '',
    revisionNumber: '',
    producerName: '',
    producerAddress: '',
    producerContact: '',
    producerPhone: '',
    producerFax: '',
    producerEmail: '',
    insuredName: '',
    insuredAddress: '',
    insuredPhone: '',
    insuredEmail: '',
    insurers: [],
    policies: [],
    holderName: '',
    holderAddress: '',
    operations: '',
  })

  // Load backend details for save/edit capability
  useEffect(() => {
    let alive = true
    const token = getToken() || ''
    apiCoiFields
      .get(coi.id, token)
      .then(p => {
        if (!alive) return
        setReviewPayload(p as ReviewDetailsPayload)
        if (p?.details) setExtracted(p.details as ExtractedDetails)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [coi.id])

  // Sync prop changes
  useEffect(() => {
    if (extractedProp !== undefined) setExtracted(extractedProp ?? null)
  }, [extractedProp])

  const producer = extracted?.producer
  const insured = extracted?.insured
  const insurers = extracted?.insurers || []
  const policies = extracted?.policies || []

  // Initialize edit form from current data
  useEffect(() => {
    if (editing) return
    setEdit({
      date: todayDisplay(),
      certificateNumber: '',
      revisionNumber: '',
      producerName: producer?.name || '',
      producerAddress: producer?.address || '',
      producerContact: (producer as any)?.contact_person || '',
      producerPhone: producer?.phone || '',
      producerFax: (producer as any)?.fax || '',
      producerEmail: producer?.email || '',
      insuredName: insured?.name || (coi as any).sub_company_name || coi.company_name || '',
      insuredAddress: insured?.address || '',
      insuredPhone: insured?.phone || '',
      insuredEmail: insured?.email || '',
      insurers: insurers.slice(0, 6),
      policies: policies.map(p => ({
        ...p,
        limits: (p.limits || []).slice(0, 10),
      })),
      holderName: (coi as any).gc_company_name || (coi as any).gc_company || 'Your Company, Inc.',
      holderAddress: '',
      operations: (coi.reviewer_notes || '').trim(),
    })
  }, [extracted, coi, producer, insured, editing])

  const slots = useMemo(() => {
    const list = editing ? edit.policies : policies
    const map = new Map<Slot, Policy[]>()
    for (const p of list) {
      const k = slotForPolicy(p.type)
      const cur = map.get(k) || []
      cur.push(p)
      map.set(k, cur)
    }
    return map
  }, [policies, editing, edit.policies])

  const allExpired = coiExpiryAllExpired(coi.expiration_date, policies)
  const partiallyExpired = isPartiallyExpired(coi.expiration_date, policies)
  const days = daysFromNow(coi.expiration_date)
  const { additionalInsured, waiverOfSubrogation, primaryNonContributory } = detectWording(coi.reviewer_notes)
  const downloadHref = docProxyUrl ? `${docProxyUrl}&download=1` : fileUrl || coi.certificate_url || null
  const hasDownload = Boolean(downloadHref)
  const hasOpenOriginal = Boolean(docProxyUrl || fileUrl || coi.certificate_url)

  // PDF access gate:
  // - GCs and Admin may get PDF copies even for unverified certificates of their subs
  // - A sub viewing their OWN certificate can get a PDF copy only once it is verified (status = compliant)
  // - A GC viewing their OWN (company) COI also cannot get a PDF until verified
  const currentUser = getStoredUser()
  const role = currentUser?.role
  const isVerified = coi.status === 'compliant'
  const isGc = role === 'gc' || role === 'pro_gc'
  const isSub = role === 'sub'
  const isOwnCoi =
    (isSub && (coi.owner_sub_user_id === currentUser?.id || coi.owner_gc_user_id == null)) ||
    (isGc && (coi.owner_gc_user_id === currentUser?.id || Boolean((coi as any).is_company_coi)))
  const canDownloadPdf = isOwnCoi ? isVerified : isVerified || isGc || role === 'admin' || role === 'staff'

  const statusMeta = useMemo(() => {
    if (coi.status === 'compliant') return { label: 'Compliant', icon: ShieldCheck, cls: 'bg-emerald-50 text-emerald-800 border-emerald-300' }
    if (allExpired) return { label: 'All policies expired', icon: XCircle, cls: 'bg-rose-50 text-rose-800 border-rose-300' }
    if (partiallyExpired) return { label: 'Partially expired', icon: AlertTriangle, cls: 'bg-amber-50 text-amber-900 border-amber-300' }
    if (coi.status === 'rejected') return { label: 'Rejected', icon: XCircle, cls: 'bg-rose-50 text-rose-800 border-rose-300' }
    if (coi.status === 'needs_revision') return { label: 'Needs revision', icon: AlertTriangle, cls: 'bg-amber-50 text-amber-900 border-amber-300' }
    return { label: 'Pending review', icon: Clock, cls: 'bg-indigo-50 text-indigo-900 border-indigo-300' }
  }, [coi.status, allExpired, partiallyExpired])

  const copyFormText = () => {
    const srcIns = editing ? edit.insurers : insurers
    const srcPol = editing ? edit.policies : policies
    const lines = [
      'CERTIFICATE OF LIABILITY INSURANCE (ACORD 25 2016/03)',
      `Date (MM/DD/YYYY): ${todayDisplay()}`,
      `Status: ${statusMeta.label}`,
      `Named Insured: ${insured?.name || (coi as any).sub_company_name || coi.company_name || '—'}`,
      `Producer: ${producer?.name || '—'}`,
      `Insurers: ${srcIns.map((i: any) => `${i.letter || 'A'}: ${i.name || '—'}${i.naic ? ` (NAIC ${i.naic})` : ''}`).join(' | ')}`,
      '',
      'POLICIES:',
      ...srcPol.map(
        (p: any) =>
          `${p.insurerLetter || 'A'} | ${(p.type || 'Coverage').toUpperCase()} | #${p.policyNumber || 'n/a'} | ${p.effectiveDate || '—'} → ${p.expirationDate || '—'}${isExpiredDate(p.expirationDate || p.expiration_date) ? ' [EXPIRED]' : ''} | ${(p.limits || []).map((l: any) => `${l.label}: ${l.amount}`).join('; ') || 'limits n/a'}`
      ),
      '',
      `Endorsements: ${[additionalInsured && 'Additional Insured', waiverOfSubrogation && 'Waiver of Subrogation', primaryNonContributory && 'Primary & Non-Contributory'].filter(Boolean).join(', ') || 'none noted'}`,
      `Certificate Holder: ${(coi as any).gc_company_name || (coi as any).gc_company || '—'}`,
    ]
    navigator.clipboard?.writeText(lines.join('\n')).catch(() => {})
  }

  const saveEdits = async () => {
    if (!reviewPayload?.sourceTag || !reviewPayload?.reviewRevision) {
      setSaveError('Edit data is not loaded yet. Reopen and try again.')
      return
    }
    setSaving(true)
    setSaveError(null)
    setSaveOk(false)
    try {
      const details = {
        producer: {
          name: edit.producerName || undefined,
          address: edit.producerAddress || undefined,
          phone: edit.producerPhone || undefined,
          email: edit.producerEmail || undefined,
        },
        insured: {
          name: edit.insuredName || undefined,
          address: edit.insuredAddress || undefined,
          phone: edit.insuredPhone || undefined,
          email: edit.insuredEmail || undefined,
        },
        insurers: edit.insurers
          .filter(i => (i.name || '').trim())
          .map(i => ({ letter: i.letter, name: (i.name || '').trim(), naic: (i.naic || '').trim() || undefined })),
        policies: edit.policies
          .filter(p => (p.type || '').trim())
          .map(p => ({
            type: (p.type || '').trim(),
            insurerLetter: (p.insurerLetter || '').trim() || undefined,
            policyNumber: (p.policyNumber || '').trim() || undefined,
            effectiveDate: (p.effectiveDate || '').trim() || undefined,
            expirationDate: (p.expirationDate || '').trim() || undefined,
            limits: (p.limits || [])
              .filter(l => (l.label || '').trim())
              .map(l => ({ label: (l.label || '').trim(), amount: (l.amount || '').trim() || undefined })),
          })),
        source: 'mixed' as const,
      }
      const token = getToken() || ''
      await apiCoiFields.save(coi.id, {
        sourceTag: reviewPayload.sourceTag,
        reviewRevision: reviewPayload.reviewRevision,
        details: details as unknown as CoiFields,
      }, token)
      const fresh = await apiCoiFields.get(coi.id, token)
      setReviewPayload(fresh as ReviewDetailsPayload)
      if (fresh?.details) setExtracted(fresh.details as ExtractedDetails)
      setSaveOk(true)
      setEditing(false)
      onSaved?.()
      setTimeout(() => setSaveOk(false), 3000)
    } catch (e: any) {
      setSaveError(e?.message || 'Could not save — someone may have updated this certificate. Reopen and try again.')
    } finally {
      setSaving(false)
    }
  }

  const addPolicy = () => {
    setEdit(e => ({
      ...e,
      policies: [
        ...e.policies,
        {
          type: 'Commercial General Liability',
          insurerLetter: 'A',
          policyNumber: '',
          effectiveDate: '',
          expirationDate: '',
          limits: [
            { label: 'EACH OCCURRENCE', amount: '' },
            { label: 'GENERAL AGGREGATE', amount: '' },
          ],
        },
      ],
    }))
  }

  const handleOpenOriginal = onOpenOriginal || onOpenFile
  const handleEditModal = onOpenEditModal || onEdit

  return (
    <div className="space-y-3 print:space-y-0">
      {/* Action ribbon */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs print:hidden">
        <div className="flex flex-wrap items-center gap-1.5">
          {handleOpenOriginal && (
            <button
              type="button"
              onClick={handleOpenOriginal}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white font-medium text-slate-700 hover:bg-slate-50 shadow-sm"
              title="View original uploaded file"
            >
              Original file <span className="text-[10px] uppercase font-bold text-slate-400">({fileBadge})</span>
            </button>
          )}
          {hasDownload && (
            canDownloadPdf ? (
              <a
                href={downloadHref!}
                download
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white font-medium text-slate-700 hover:bg-slate-50 shadow-sm"
              >
                <Download className="w-3.5 h-3.5" /> Download PDF
              </a>
            ) : (
              <span
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 bg-slate-100 font-medium text-slate-400 cursor-not-allowed shadow-sm"
                title="PDF copy is available once this certificate is verified"
              >
                <Download className="w-3.5 h-3.5" /> PDF on verification
              </span>
            )
          )}
          {hasOpenOriginal && canDownloadPdf && (
            <a
              href={(docProxyUrl || fileUrl || coi.certificate_url)!}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white font-medium text-slate-700 hover:bg-slate-50 shadow-sm"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Open file in new tab
            </a>
          )}
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white font-medium text-slate-700 hover:bg-slate-50 shadow-sm"
          >
            <Printer className="w-3.5 h-3.5" /> Print
          </button>
          <button
            type="button"
            onClick={copyFormText}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white font-medium text-slate-700 hover:bg-slate-50 shadow-sm"
          >
            <Copy className="w-3.5 h-3.5" /> Copy text
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {onCheckAgain && (
            <button
              type="button"
              onClick={onCheckAgain}
              disabled={checkAgainBusy}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white font-medium text-slate-700 hover:bg-slate-50 shadow-sm disabled:opacity-50"
              title="Re-run AI extraction against the original file"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${checkAgainBusy ? 'animate-spin' : ''}`} />
              {checkAgainBusy ? 'Checking…' : 'Check again'}
            </button>
          )}
          {handleEditModal && (
            <button
              type="button"
              onClick={handleEditModal}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white font-medium text-slate-700 hover:bg-slate-50 shadow-sm"
              title="Open full field editor"
            >
              <Edit3 className="w-3.5 h-3.5" /> Edit data
            </button>
          )}
          {editing ? (
            <>
              <button
                type="button"
                onClick={saveEdits}
                disabled={saving}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg font-medium text-white shadow-sm disabled:opacity-50"
                style={{ backgroundColor: 'var(--navy)' }}
              >
                <Save className="w-3.5 h-3.5" />
                {saving ? 'Saving…' : 'Save changes'}
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white font-medium text-slate-700 hover:bg-slate-50 shadow-sm"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                setSaveOk(false)
                setSaveError(null)
                setEditing(true)
              }}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg font-medium text-white shadow-sm"
              style={{ backgroundColor: 'var(--navy)' }}
              title="Edit fields directly on the form to correct wrong dates or numbers"
            >
              <Edit3 className="w-3.5 h-3.5" /> Edit form
            </button>
          )}
        </div>
      </div>

      {saveError && (
        <div className="rounded-lg border border-rose-300 bg-rose-50 text-rose-800 text-xs px-3 py-2 print:hidden">
          {saveError}
        </div>
      )}
      {saveOk && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 text-xs px-3 py-2 print:hidden">
          Changes saved. Compliance statuses updated.
        </div>
      )}

      {/* PDF availability notice for own unverified COIs */}
      {!canDownloadPdf && isOwnCoi && (
        <div className="rounded-lg border border-indigo-300 bg-indigo-50 text-indigo-900 text-xs p-3 flex items-start gap-2 print:hidden">
          <Clock className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">PDF copy is available once this certificate has been verified.</p>
            <p className="text-[11px] text-indigo-800 mt-0.5">
              You can review all extracted fields in the form below and correct any wrong dates or numbers with{' '}
              <strong className="underline cursor-pointer" onClick={() => setEditing(true)}>Edit form</strong>. A PDF copy is provided after verification is complete.
            </p>
          </div>
        </div>
      )}

      {/* Compliance banner */}
      {!hideBanner && (
        <div className={`rounded-lg border p-3 flex flex-wrap items-center justify-between gap-2 text-xs ${statusMeta.cls} print:hidden`}>
          <div className="flex items-center gap-2">
            <statusMeta.icon className="w-4 h-4 shrink-0" />
            <span className="font-bold">{statusMeta.label}</span>
            <span>·</span>
            <span>{policies.length} policy {policies.length === 1 ? 'line' : 'lines'}</span>
            <span>·</span>
            <span>
              {days == null
                ? 'no dates'
                : days >= 0
                ? `${days}d until overall expiration`
                : `${Math.abs(days)}d overall expired`}
            </span>
          </div>
          <span className="text-[10px] opacity-75">
            {editing ? 'Editing mode — type directly into form cells' : 'Rendered from extracted certificate data'}
          </span>
        </div>
      )}

      {/* ================================================================ */}
      {/* AUTHENTIC ACORD 25 (2016/03) — boxed form, 1:1 structure         */}
      {/* ================================================================ */}
      <div
        className="acord-form bg-white text-slate-900 border-2 border-slate-900 text-[10px] leading-tight select-text"
        style={{ fontFamily: 'Georgia, Times New Roman, serif' }}
      >
        {/* Row 1: ACORD wordmark + title + date */}
        <div className="grid grid-cols-12 border-b-2 border-slate-900">
          <div className="col-span-3 border-r-2 border-slate-900 p-2 flex flex-col justify-between bg-slate-900 text-white">
            <div className="font-black text-2xl tracking-widest leading-none" style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
              ACORD
            </div>
            <div className="text-[9px] tracking-wider text-slate-300 font-bold" style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
              25 (2016/03)
            </div>
          </div>
          <div className="col-span-6 p-2 text-center flex flex-col justify-center">
            <div className="text-[11px] font-bold tracking-wider uppercase text-slate-700" style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
              CERTIFICATE OF LIABILITY INSURANCE
            </div>
            <div className="text-[8px] text-slate-500 mt-0.5">ACORD 25 &middot; CERTIFICATE OF LIABILITY INSURANCE</div>
          </div>
          <div className="col-span-3 border-l-2 border-slate-900 p-1 flex flex-col justify-between">
            <div className="text-[8px] font-bold uppercase text-slate-600" style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
              DATE (MM/DD/YYYY)
            </div>
            {editing ? (
              <input
                value={edit.date}
                onChange={e => setEdit({ ...edit, date: normalizeInputDate(e.target.value) })}
                className="w-full text-center font-mono font-bold text-xs border border-slate-400 p-0.5"
                placeholder="MM/DD/YYYY"
              />
            ) : (
              <div className="text-center font-mono font-bold text-xs">{edit.date || todayDisplay()}</div>
            )}
            <div className="text-[7px] text-slate-400 text-right">DATE ISSUED</div>
          </div>
        </div>

        {/* Disclaimer row */}
        <div className="border-b border-slate-900 p-2 bg-slate-50 text-[8.5px] leading-snug text-slate-700 text-justify">
          <p className="font-bold">
            THIS CERTIFICATE IS ISSUED AS A MATTER OF INFORMATION ONLY AND CONFERS NO RIGHTS UPON THE CERTIFICATE HOLDER.
            THIS CERTIFICATE DOES NOT AFFIRMATIVELY OR NEGATIVELY AMEND, EXTEND OR ALTER THE COVERAGE AFFORDED BY THE
            POLICIES BELOW.
          </p>
          <p className="mt-1 text-[8px] text-slate-600">
            <strong>IMPORTANT:</strong> If the certificate holder is an ADDITIONAL INSURED, the policy(ies) must have
            ADDITIONAL INSURED provisions or be endorsed. If SUBROGATION IS WAIVED, subject to the terms and conditions
            of the policy, certain policies may require an endorsement. A statement on this certificate does not confer
            rights to the certificate holder in lieu of such endorsement(s).
          </p>
        </div>

        {/* PRODUCER / INSURED row — classic two-column box */}
        <div className="grid grid-cols-12 border-b border-slate-900 divide-x border-slate-900">
          {/* PRODUCER (left) */}
          <div className="col-span-6 p-2 flex flex-col justify-between">
            <div>
              <div className="text-[9px] font-bold uppercase tracking-wider text-slate-600" style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
                PRODUCER
              </div>
              {editing ? (
                <div className="space-y-1 mt-1">
                  <input
                    value={edit.producerName}
                    onChange={e => setEdit({ ...edit, producerName: e.target.value })}
                    className="w-full font-bold border border-slate-400 p-0.5 text-[10px]"
                    placeholder="Agency name"
                  />
                  <textarea
                    value={edit.producerAddress}
                    onChange={e => setEdit({ ...edit, producerAddress: e.target.value })}
                    className="w-full border border-slate-400 p-0.5 text-[9px] h-10 resize-none"
                    placeholder="Agency street, city, ST ZIP"
                  />
                </div>
              ) : (
                <div className="mt-1">
                  <div className="font-bold text-[11px]">{producer?.name || <em className="text-slate-400">Agency not on file</em>}</div>
                  <div className="text-[9.5px] text-slate-700 whitespace-pre-line mt-0.5">
                    {producer?.address || <em className="text-slate-400">Address not on file</em>}
                  </div>
                </div>
              )}
            </div>
            {/* CONTACT sub-boxes */}
            <div className="border border-slate-900 mt-2 text-[8px]" style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
              <div className="grid grid-cols-12 border-b border-slate-900">
                <div className="col-span-3 p-0.5 bg-slate-100 font-bold uppercase">CONTACT NAME</div>
                <div className="col-span-9 p-0.5">
                  {editing ? (
                    <input
                      value={edit.producerContact}
                      onChange={e => setEdit({ ...edit, producerContact: e.target.value })}
                      className="w-full text-[8px] border border-slate-400 p-0"
                    />
                  ) : (
                    <span>{(producer as any)?.contact_person || '—'}</span>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-12 border-b border-slate-900">
                <div className="col-span-3 p-0.5 bg-slate-100 font-bold uppercase">PHONE (A/C, No, Ext)</div>
                <div className="col-span-3 p-0.5">
                  {editing ? (
                    <input
                      value={edit.producerPhone}
                      onChange={e => setEdit({ ...edit, producerPhone: e.target.value })}
                      className="w-full text-[8px] border border-slate-400 p-0"
                    />
                  ) : (
                    producer?.phone || '—'
                  )}
                </div>
                <div className="col-span-3 p-0.5 bg-slate-100 font-bold uppercase border-l border-slate-900">FAX (A/C, No)</div>
                <div className="col-span-3 p-0.5">{editing ? <input value={edit.producerFax} onChange={e => setEdit({ ...edit, producerFax: e.target.value })} className="w-full text-[8px] border border-slate-400 p-0" /> : (producer as any)?.fax || '—'}</div>
              </div>
              <div className="grid grid-cols-12">
                <div className="col-span-3 p-0.5 bg-slate-100 font-bold uppercase">E-MAIL ADDRESS</div>
                <div className="col-span-9 p-0.5">{editing ? <input value={edit.producerEmail} onChange={e => setEdit({ ...edit, producerEmail: e.target.value })} className="w-full text-[8px] border border-slate-400 p-0" /> : producer?.email || '—'}</div>
              </div>
            </div>
          </div>

          {/* INSURED (right) */}
          <div className="col-span-6 p-2 flex flex-col justify-between">
            <div>
              <div className="text-[9px] font-bold uppercase tracking-wider text-slate-600" style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
                INSURED
              </div>
              {editing ? (
                <div className="space-y-1 mt-1">
                  <input
                    value={edit.insuredName}
                    onChange={e => setEdit({ ...edit, insuredName: e.target.value })}
                    className="w-full font-bold border border-slate-400 p-0.5 text-[10px]"
                    placeholder="Named insured"
                  />
                  <textarea
                    value={edit.insuredAddress}
                    onChange={e => setEdit({ ...edit, insuredAddress: e.target.value })}
                    className="w-full border border-slate-400 p-0.5 text-[9px] h-10 resize-none"
                    placeholder="Street, city, ST ZIP"
                  />
                </div>
              ) : (
                <div className="mt-1">
                  <div className="font-bold text-[11px]">
                    {insured?.name || (coi as any).sub_company_name || coi.company_name || (
                      <em className="text-slate-400">Named insured not on file</em>
                    )}
                  </div>
                  <div className="text-[9.5px] text-slate-700 whitespace-pre-line mt-0.5">
                    {insured?.address || <em className="text-slate-400">Address not on file</em>}
                  </div>
                  <div className="text-[8px] italic text-slate-500 mt-1">
                    This should match the subcontractor hired for your job.
                  </div>
                </div>
              )}
            </div>

            {/* INSURER(S) AFFORDING COVERAGE */}
            <div className="border border-slate-900 mt-2 text-[8px]" style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
              <div className="bg-slate-100 p-0.5 font-bold uppercase text-[8px] border-b border-slate-900">
                INSURER(S) AFFORDING COVERAGE
              </div>
              {INSURER_ROWS.map((letter, idx) => {
                const ins = (editing ? edit.insurers : insurers)[idx]
                return (
                  <div key={letter} className={`grid grid-cols-12 ${idx < 5 ? 'border-b border-slate-900' : ''}`}>
                    <div className="col-span-2 p-0.5 font-bold bg-slate-50 text-center">INSURER {letter} :</div>
                    <div className="col-span-7 p-0.5 font-bold truncate">
                      {editing ? (
                        <input
                          value={ins?.name || ''}
                          onChange={e => {
                            const next = [...edit.insurers]
                            next[idx] = { letter, name: e.target.value, naic: next[idx]?.naic || '' }
                            setEdit({ ...edit, insurers: next })
                          }}
                          className="w-full text-[8px] border border-slate-400 p-0"
                          placeholder="Insurer legal name"
                        />
                      ) : (
                        ins?.name || <span className="text-slate-300">—</span>
                      )}
                    </div>
                    <div className="col-span-1 p-0.5 bg-slate-50 text-[7px] font-bold text-center border-l border-slate-900">
                      NAIC #
                    </div>
                    <div className="col-span-2 p-0.5 font-mono text-[8px] text-center">
                      {editing ? (
                        <input
                          value={ins?.naic || ''}
                          onChange={e => {
                            const next = [...edit.insurers]
                            next[idx] = { letter, name: next[idx]?.name || '', naic: e.target.value }
                            setEdit({ ...edit, insurers: next })
                          }}
                          className="w-full text-[8px] border border-slate-400 p-0 font-mono text-center"
                          placeholder="#####"
                        />
                      ) : (
                        ins?.naic || <span className="text-slate-300">—</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* COVERAGES bar */}
        <div className="border-b border-slate-900 bg-slate-100 p-1 flex items-center justify-between text-[9px] font-bold uppercase" style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
          <span>COVERAGES</span>
          <span className="font-normal normal-case text-[8px] text-slate-600">
            CERTIFICATE NUMBER: {editing ? <input value={edit.certificateNumber} onChange={e => setEdit({ ...edit, certificateNumber: e.target.value })} className="border border-slate-400 w-24 p-0 text-[8px]" /> : <span className="font-mono">{edit.certificateNumber || '—'}</span>}
            &nbsp;|&nbsp; REVISION NUMBER: {editing ? <input value={edit.revisionNumber} onChange={e => setEdit({ ...edit, revisionNumber: e.target.value })} className="border border-slate-400 w-12 p-0 text-[8px]" /> : <span className="font-mono">{edit.revisionNumber || '—'}</span>}
          </span>
        </div>

        {/* ============================================================= */}
        {/* POLICIES TABLE — exact ACORD column set                        */}
        {/* ============================================================= */}
        <div className="border-b-2 border-slate-900 overflow-x-auto">
          <table className="w-full border-collapse text-[8.5px]">
            <thead>
              <tr className="bg-slate-900 text-white font-bold uppercase text-[7.5px] tracking-wider text-center" style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
                <th className="border border-slate-700 p-0.5 w-6">INSR<br />LTR</th>
                <th className="border border-slate-700 p-0.5 w-10">ADDL<br />INSD</th>
                <th className="border border-slate-700 p-0.5 w-10">SUBR<br />WVD</th>
                <th className="border border-slate-700 p-0.5 text-left w-64">TYPE OF INSURANCE</th>
                <th className="border border-slate-700 p-0.5">POLICY NUMBER</th>
                <th className="border border-slate-700 p-0.5 w-20">POLICY EFF<br />(MM/DD/YYYY)</th>
                <th className="border border-slate-700 p-0.5 w-20">POLICY EXP<br />(MM/DD/YYYY)</th>
                <th className="border border-slate-700 p-0.5 text-right w-60">LIMITS</th>
              </tr>
            </thead>
            <tbody>
              {/* Row 1: COMMERCIAL GENERAL LIABILITY */}
              <CoverageRow
                slotKey="gl"
                slotName="COMMERCIAL GENERAL LIABILITY"
                options="CLAIMS-MADE &middot; OCCUR &middot; GEN'L AGGREGATE LIMIT APPLIES PER: POLICY &middot; PRO-JECT &middot; LOC"
                rowSpanSlot={true}
                policies={slots.get('gl') || []}
                editing={editing}
                allPolicies={edit.policies}
                onUpdate={next => setEdit({ ...edit, policies: next })}
              />
              {/* Row 2: AUTOMOBILE LIABILITY */}
              <CoverageRow
                slotKey="auto"
                slotName="AUTOMOBILE LIABILITY"
                options="ANY AUTO &middot; ALL OWNED AUTOS &middot; SCHEDULED AUTOS &middot; HIRED AUTOS &middot; NON-OWNED AUTOS"
                rowSpanSlot={true}
                policies={slots.get('auto') || []}
                editing={editing}
                allPolicies={edit.policies}
                onUpdate={next => setEdit({ ...edit, policies: next })}
              />
              {/* Row 3: UMBRELLA / EXCESS */}
              <CoverageRow
                slotKey="umb"
                slotName="UMBRELLA LIAB / EXCESS LIAB"
                options="OCCUR &middot; CLAIMS-MADE &middot; DED &middot; RETENTION"
                rowSpanSlot={true}
                policies={slots.get('umb') || []}
                editing={editing}
                allPolicies={edit.policies}
                onUpdate={next => setEdit({ ...edit, policies: next })}
              />
              {/* Row 4: WORKERS COMPENSATION */}
              <CoverageRow
                slotKey="wc"
                slotName="WORKERS COMPENSATION AND EMPLOYERS' LIABILITY"
                options="ANY PROPRIETOR/PARTNER/EXECUTIVE OFFICER/MEMBER EXCLUDED? (Y/N) &middot; E.L. EACH ACCIDENT &middot; E.L. DISEASE-EA EMPLOYEE &middot; E.L. DISEASE-POLICY LIMIT"
                rowSpanSlot={true}
                policies={slots.get('wc') || []}
                editing={editing}
                allPolicies={edit.policies}
                onUpdate={next => setEdit({ ...edit, policies: next })}
              />
              {/* OTHER COVERAGES */}
              {(slots.get('other') || []).map((p, i) => (
                <OtherRow
                  key={`other-${i}`}
                  policy={p}
                  editing={editing}
                  idx={(edit.policies).indexOf(p)}
                  allPolicies={edit.policies}
                  onUpdate={next => setEdit({ ...edit, policies: next })}
                />
              ))}
            </tbody>
          </table>
        </div>

        {editing && (
          <div className="p-1 border-b border-slate-900 bg-slate-50 text-right print:hidden">
            <button
              type="button"
              onClick={addPolicy}
              className="text-[9px] font-bold text-indigo-700 underline"
            >
              + Add another coverage line
            </button>
          </div>
        )}

        {/* DESCRIPTION OF OPERATIONS */}
        <div className="border-b border-slate-900 p-2">
          <div className="text-[9px] font-bold uppercase tracking-wider text-slate-600 mb-1" style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
            DESCRIPTION OF OPERATIONS / LOCATIONS / VEHICLES (ACORD 101, Additional Remarks Schedule, may be attached if more space is required)
          </div>
          {editing ? (
            <textarea
              value={edit.operations}
              onChange={e => setEdit({ ...edit, operations: e.target.value })}
              className="w-full border border-slate-400 p-1 text-[9px] h-16 resize-none font-sans"
              placeholder="Certificate holder is named as additional insured... waiver of subrogation applies..."
            />
          ) : (
            <>
              <p className="text-[9px] text-slate-700 whitespace-pre-wrap min-h-[42px]">
                {edit.operations || <em className="text-slate-400">None stated.</em>}
              </p>
              {/* Endorsement chips */}
              <div className="mt-1 flex flex-wrap gap-1 text-[8px] font-bold" style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
                {additionalInsured && (
                  <span className="px-1.5 py-0.5 bg-emerald-100 text-emerald-900 border border-emerald-400">
                    &#10003; ADDITIONAL INSURED WORDING ON FILE
                  </span>
                )}
                {waiverOfSubrogation && (
                  <span className="px-1.5 py-0.5 bg-emerald-100 text-emerald-900 border border-emerald-400">
                    &#10003; WAIVER OF SUBROGATION WORDING ON FILE
                  </span>
                )}
                {primaryNonContributory && (
                  <span className="px-1.5 py-0.5 bg-emerald-100 text-emerald-900 border border-emerald-400">
                    &#10003; PRIMARY &amp; NON-CONTRIBUTORY WORDING ON FILE
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        {/* CERTIFICATE HOLDER / CANCELLATION */}
        <div className="grid grid-cols-12 border-b-2 border-slate-900 divide-x border-slate-900">
          <div className="col-span-6 p-2 flex flex-col justify-between">
            <div>
              <div className="text-[9px] font-bold uppercase tracking-wider text-slate-600" style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
                CERTIFICATE HOLDER
              </div>
              {editing ? (
                <div className="space-y-1 mt-1">
                  <input
                    value={edit.holderName}
                    onChange={e => setEdit({ ...edit, holderName: e.target.value })}
                    className="w-full font-bold border border-slate-400 p-0.5 text-[10px]"
                    placeholder="General contractor name"
                  />
                  <textarea
                    value={edit.holderAddress}
                    onChange={e => setEdit({ ...edit, holderAddress: e.target.value })}
                    className="w-full border border-slate-400 p-0.5 text-[9px] h-10 resize-none"
                    placeholder="Street, city, ST ZIP"
                  />
                </div>
              ) : (
                <div className="mt-1">
                  <div className="font-bold text-[11px]">{edit.holderName || <em className="text-slate-400">Your Company, Inc.</em>}</div>
                  <div className="text-[9.5px] text-slate-700 whitespace-pre-line mt-0.5">
                    {edit.holderAddress || (
                      <em className="text-slate-400 text-[8px]">
                        The hiring general contractor should be named here as certificate holder, and additionally
                        insured on general liability and waiver of subrogation.
                      </em>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="col-span-6 p-2 flex flex-col justify-between">
            <div>
              <div className="text-[9px] font-bold uppercase tracking-wider text-slate-600 mb-0.5" style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
                CANCELLATION
              </div>
              <p className="text-[8px] leading-tight text-slate-600 text-justify">
                SHOULD ANY OF THE ABOVE DESCRIBED POLICIES BE CANCELLED BEFORE THE EXPIRATION DATE THEREOF,
                NOTICE WILL BE DELIVERED IN ACCORDANCE WITH THE POLICY PROVISIONS.
              </p>
            </div>
            <div className="pt-2 mt-2 border-t border-slate-400 flex items-center justify-between text-[8px]" style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
              <span className="font-bold uppercase text-slate-700">AUTHORIZED REPRESENTATIVE</span>
              <span className="font-mono text-slate-500">/s/ (agency electronic)</span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-between text-[8px] text-slate-500 p-1 bg-slate-50 border-t border-slate-400" style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
          <span className="font-bold">ACORD 25 (2016/03)</span>
          <span>&copy; 1988-2015 ACORD CORPORATION. All rights reserved. &middot; Layout for information display only</span>
          <span>The ACORD name and logo are registered marks of ACORD</span>
        </div>
      </div>
    </div>
  )
}

function CoverageRow({
  slotName,
  options,
  policies,
  editing,
  allPolicies,
  onUpdate,
}: {
  slotKey: Slot
  slotName: string
  options: string
  rowSpanSlot: boolean
  policies: Policy[]
  editing: boolean
  allPolicies: Policy[]
  onUpdate: (next: Policy[]) => void
}) {
  const list = policies.length ? policies : [{}]
  return (
    <>
      {list.map((p, idx) => {
        const globalIdx = allPolicies.indexOf(p)
        const expired = isExpiredDate(p.expirationDate || (p as any).expiration_date)
        const eff = p.effectiveDate ? formatDisplayDate(p.effectiveDate) : ''
        const exp = p.expirationDate ? formatDisplayDate(p.expirationDate) : ''
        return (
          <tr key={idx} className="align-top hover:bg-slate-50/50">
            {/* INSR LTR */}
            <td className="border border-slate-400 p-0.5 text-center font-bold w-6">
              {editing ? (
                <input
                  value={p.insurerLetter || 'A'}
                  onChange={e => {
                    const next = [...allPolicies]
                    next[globalIdx] = { ...p, insurerLetter: e.target.value.toUpperCase().slice(0, 2) }
                    onUpdate(next)
                  }}
                  className="w-5 text-center font-bold text-[8.5px] border border-slate-400 p-0"
                />
              ) : (
                p.insurerLetter || (list[0] === p ? <span className="text-slate-300">A</span> : '')
              )}
            </td>
            {/* ADDL INSD */}
            <td className="border border-slate-400 p-0.5 text-center w-10 font-mono text-[7px]">
              {editing ? (
                <input
                  type="checkbox"
                  checked={Boolean((p as any).addlInsd)}
                  onChange={e => {
                    const next = [...allPolicies]
                    next[globalIdx] = { ...p, addlInsd: e.target.checked }
                    onUpdate(next)
                  }}
                />
              ) : (p as any).addlInsd ? 'Y' : '—'}
            </td>
            {/* SUBR WVD */}
            <td className="border border-slate-400 p-0.5 text-center w-10 font-mono text-[7px]">
              {editing ? (
                <input
                  type="checkbox"
                  checked={Boolean((p as any).subrWvd)}
                  onChange={e => {
                    const next = [...allPolicies]
                    next[globalIdx] = { ...p, subrWvd: e.target.checked }
                    onUpdate(next)
                  }}
                />
              ) : (p as any).subrWvd ? 'Y' : '—'}
            </td>
            {/* TYPE */}
            <td className="border border-slate-400 p-1 text-left w-64">
              <div className="font-bold uppercase text-[8.5px]" style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
                {idx === 0 && slotName}
              </div>
              {idx === 0 && (
                <div className="text-[6.5px] text-slate-500 tracking-wide mt-0.5">{options}</div>
              )}
            </td>
            {/* POLICY # */}
            <td className="border border-slate-400 p-0.5 font-mono text-[8.5px]">
              {editing ? (
                <input
                  value={p.policyNumber || ''}
                  onChange={e => {
                    const next = [...allPolicies]
                    next[globalIdx] = { ...p, policyNumber: e.target.value }
                    onUpdate(next)
                  }}
                  className="w-full font-mono text-[8px] border border-slate-400 p-0"
                  placeholder="Policy #"
                />
              ) : (
                p.policyNumber || <em className="text-slate-300">not listed</em>
              )}
            </td>
            {/* EFF */}
            <td className="border border-slate-400 p-0.5 font-mono text-center w-20">
              {editing ? (
                <input
                  value={p.effectiveDate || ''}
                  onChange={e => {
                    const next = [...allPolicies]
                    next[globalIdx] = { ...p, effectiveDate: normalizeInputDate(e.target.value) }
                    onUpdate(next)
                  }}
                  className="w-full font-mono text-[8px] text-center border border-slate-400 p-0"
                  placeholder="MM/DD/YYYY"
                />
              ) : (
                eff || <span className="text-slate-300">—</span>
              )}
            </td>
            {/* EXP */}
            <td className="border border-slate-400 p-0.5 font-mono text-center w-20">
              {editing ? (
                <input
                  value={p.expirationDate || ''}
                  onChange={e => {
                    const next = [...allPolicies]
                    next[globalIdx] = { ...p, expirationDate: normalizeInputDate(e.target.value) }
                    onUpdate(next)
                  }}
                  className="w-full font-mono text-[8px] text-center border border-slate-400 p-0"
                  placeholder="MM/DD/YYYY"
                />
              ) : (
                <>
                  <div>{exp || <span className="text-slate-300">—</span>}</div>
                  {expired && exp && (
                    <span className="inline-block mt-0.5 px-1 py-0 rounded text-[7px] font-bold bg-rose-600 text-white">
                      EXPIRED
                    </span>
                  )}
                </>
              )}
            </td>
            {/* LIMITS */}
            <td className="border border-slate-400 p-0.5 text-right w-60">
              {editing ? (
                <div className="space-y-0.5 text-[7px]">
                  {(p.limits || []).map((l, li) => (
                    <div key={li} className="flex gap-1 justify-end items-center">
                      <input
                        value={l.label || ''}
                        onChange={e => {
                          const next = [...allPolicies]
                          const limits = [...(p.limits || [])]
                          limits[li] = { ...l, label: e.target.value }
                          next[globalIdx] = { ...p, limits }
                          onUpdate(next)
                        }}
                        className="w-40 text-[7px] border border-slate-400 p-0"
                        placeholder="Limit label"
                      />
                      <input
                        value={l.amount || ''}
                        onChange={e => {
                          const next = [...allPolicies]
                          const limits = [...(p.limits || [])]
                          limits[li] = { ...l, amount: e.target.value }
                          next[globalIdx] = { ...p, limits }
                          onUpdate(next)
                        }}
                        className="w-20 font-mono text-[7px] text-right border border-slate-400 p-0"
                        placeholder="$"
                      />
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      const next = [...allPolicies]
                      next[globalIdx] = { ...p, limits: [...(p.limits || []), { label: '', amount: '' }] }
                      onUpdate(next)
                    }}
                    className="text-[7px] text-indigo-700 underline font-bold"
                  >
                    + limit line
                  </button>
                </div>
              ) : (
                <div className="text-[7.5px] space-y-0.2">
                  {(p.limits || []).length ? (
                    (p.limits || []).map((l, li) => (
                      <div key={li} className="flex justify-between gap-1 text-[7.5px]">
                        <span className="uppercase text-slate-600 truncate">{l.label}</span>
                        <span className="font-mono font-bold">{l.amount}</span>
                      </div>
                    ))
                  ) : (
                    <em className="text-slate-300">not listed</em>
                  )}
                </div>
              )}
            </td>
          </tr>
        )
      })}
    </>
  )
}

function OtherRow({
  policy,
  editing,
  idx,
  allPolicies,
  onUpdate,
}: {
  policy: Policy
  editing: boolean
  idx: number
  allPolicies: Policy[]
  onUpdate: (next: Policy[]) => void
}) {
  const p = policy
  const expired = isExpiredDate(p.expirationDate || (p as any).expiration_date)
  const eff = p.effectiveDate ? formatDisplayDate(p.effectiveDate) : ''
  const exp = p.expirationDate ? formatDisplayDate(p.expirationDate) : ''
  return (
    <tr className="align-top hover:bg-slate-50/50">
      <td className="border border-slate-400 p-0.5 text-center font-bold w-6">{p.insurerLetter || 'A'}</td>
      <td className="border border-slate-400 p-0.5 text-center w-10 font-mono text-[7px]">—</td>
      <td className="border border-slate-400 p-0.5 text-center w-10 font-mono text-[7px]">—</td>
      <td className="border border-slate-400 p-1 text-left w-64">
        {editing ? (
          <input
            value={p.type || ''}
            onChange={e => {
              const next = [...allPolicies]
              next[idx] = { ...p, type: e.target.value }
              onUpdate(next)
            }}
            className="w-full font-bold uppercase text-[8px] border border-slate-400 p-0"
          />
        ) : (
          <div className="font-bold uppercase text-[8.5px]" style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
            {p.type || 'Other Coverage'}
          </div>
        )}
      </td>
      <td className="border border-slate-400 p-0.5 font-mono text-[8.5px]">{p.policyNumber || <em className="text-slate-300">not listed</em>}</td>
      <td className="border border-slate-400 p-0.5 font-mono text-center w-20">{eff || '—'}</td>
      <td className="border border-slate-400 p-0.5 font-mono text-center w-20">
        <div>{exp || '—'}</div>
        {expired && exp && (
          <span className="inline-block mt-0.5 px-1 py-0 rounded text-[7px] font-bold bg-rose-600 text-white">EXPIRED</span>
        )}
      </td>
      <td className="border border-slate-400 p-0.5 text-right w-60">
        <div className="text-[7.5px]">
          {(p.limits || []).map((l, li) => (
            <div key={li} className="flex justify-between gap-1 text-[7.5px]">
              <span className="uppercase text-slate-600 truncate">{l.label}</span>
              <span className="font-mono font-bold">{l.amount}</span>
            </div>
          ))}
        </div>
      </td>
    </tr>
  )
}

export default AcordCertificateForm
