import { useMemo, useState } from 'react'
import type { COI } from '../types'
import type { FieldsDetails } from '../lib/coiEditorDetails'
import { formatDisplayDate, daysFromNow, isExpiredDate } from '../lib/date'
import { coiExpiryAllExpired, isPartiallyExpired } from '../lib/coiExpiry'
import { Printer, Download, Copy, Check, Edit3, FileText, ExternalLink, ShieldCheck, AlertTriangle, XCircle, Clock } from 'lucide-react'

export interface AcordFormProps {
  coi: COI
  extracted?: FieldsDetails | null
  onEdit?: () => void
  onOpenFile?: () => void
  hasFile?: boolean
  fileUrl?: string | null
  docProxyUrl?: string | null
  className?: string
  showActions?: boolean
  dense?: boolean
}

interface CoverageSlot {
  key: string
  label: string
  subtypeHint?: string
  limitLabels: string[]
}

const COVERAGE_SLOTS: CoverageSlot[] = [
  { key: 'gl', label: 'COMMERCIAL GENERAL LIABILITY', subtypeHint: 'CLAIMS-MADE · OCCUR', limitLabels: ['EACH OCCURRENCE', 'DAMAGE TO RENTED PREMISES (Ea occurrence)', 'MED EXP (Any one person)', 'PERSONAL & ADV INJURY', 'GENERAL AGGREGATE', 'PRODUCTS - COMP/OP AGG'] },
  { key: 'auto', label: 'AUTOMOBILE LIABILITY', subtypeHint: 'ANY AUTO · OWNED AUTOS · SCHEDULED · HIRED · NON-OWNED', limitLabels: ['COMBINED SINGLE LIMIT (Ea accident)', 'BODILY INJURY (Per person)', 'BODILY INJURY (Per accident)', 'PROPERTY DAMAGE (Per accident)'] },
  { key: 'umbrella', label: 'UMBRELLA/EXCESS LIABILITY', subtypeHint: 'OCCUR · CLAIMS-MADE · DEDUCTIBLE / RETENTION', limitLabels: ['EACH OCCURRENCE', 'AGGREGATE'] },
  { key: 'wc', label: 'WORKERS COMPENSATION AND EMPLOYERS’ LIABILITY', subtypeHint: 'WC STATUTORY LIMITS · OTHER', limitLabels: ['E.L. EACH ACCIDENT', 'E.L. DISEASE - EA EMPLOYEE', 'E.L. DISEASE - POLICY LIMIT'] },
  { key: 'other', label: 'OTHER COVERAGES (Pollution, Inland Marine, etc.)', limitLabels: ['LIMIT'] },
]

function slotForPolicy(type?: string): string {
  const t = (type || '').toLowerCase()
  if (t.includes('general') || t === 'gl') return 'gl'
  if (t.includes('auto') || t.includes('vehicle')) return 'auto'
  if (t.includes('umbrella') || t.includes('excess')) return 'umbrella'
  if (t.includes('workers') || t === 'wc' || t.includes('comp') || t.includes('employers')) return 'wc'
  return 'other'
}

function detectWording(notes?: string | null): { additionalInsured: boolean; waiverOfSubrogation: boolean; primaryNonContributory: boolean; endorsementWording: string[] } {
  const s = (notes || '').toLowerCase()
  const wording: string[] = []
  const additionalInsured = s.includes('additional insured') || /cg\s*20\s*10|cg\s*20\s*37/.test(s)
  const waiverOfSubrogation = s.includes('waiver of subrogation') || s.includes('waiver')
  const primaryNonContributory = s.includes('primary') && (s.includes('non-contributory') || s.includes('non contributory'))
  if (/cg\s*20\s*10/.test(s)) wording.push('CG 20 10 (ongoing operations)')
  if (/cg\s*20\s*37/.test(s)) wording.push('CG 20 37 (completed operations)')
  if (additionalInsured && !wording.length) wording.push('Additional insured wording on file')
  if (waiverOfSubrogation) wording.push('Waiver of subrogation wording on file')
  if (primaryNonContributory) wording.push('Primary & non-contributory wording on file')
  return { additionalInsured, waiverOfSubrogation, primaryNonContributory, endorsementWording: wording }
}

function todayDisplay(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mm}/${dd}/${d.getFullYear()}`
}

export function AcordCertificateForm({
  coi,
  extracted,
  onEdit,
  onOpenFile,
  hasFile,
  fileUrl,
  docProxyUrl,
  className = '',
  showActions = true,
  dense = false,
}: AcordFormProps) {
  const [copied, setCopied] = useState(false)

  // Merge: extracted (live editor/prop) > coi.review_details (persisted) > legacy COI fields
  const details: FieldsDetails | null = useMemo(() => {
    if (extracted) return extracted
    const rd = coi.review_details
    if (rd && typeof rd === 'object') return rd as FieldsDetails
    return null
  }, [extracted, coi.review_details])

  const producer = details?.producer
  const insured = details?.insured
  const insurers = (details?.insurers && details.insurers.length) ? details.insurers : (coi.carrier ? [{ letter: 'A', name: coi.carrier }] : [])
  const policies = (details?.policies && details.policies.length) ? details.policies : (coi.policy_number || coi.expiration_date ? [{
    type: coi.trade || 'General Liability',
    policyNumber: coi.policy_number || undefined,
    effectiveDate: coi.effective_date || undefined,
    expirationDate: coi.expiration_date || undefined,
    insurerLetter: 'A',
  }] : [])

  const policiesBySlot = useMemo(() => {
    const map = new Map<string, typeof policies>()
    for (const p of policies) {
      const k = slotForPolicy(p.type)
      const list = map.get(k) || []
      list.push(p)
      map.set(k, list)
    }
    return map
  }, [policies])

  const allExpired = coiExpiryAllExpired(coi.expiration_date, policies)
  const partiallyExpired = isPartiallyExpired(coi.expiration_date, policies)
  const days = daysFromNow(coi.expiration_date)
  const hasExtractedData = Boolean(producer || insured || (policies && policies.length) || (insurers && insurers.length))
  const { additionalInsured, waiverOfSubrogation, primaryNonContributory, endorsementWording } = detectWording(coi.reviewer_notes)

  const downloadHref = docProxyUrl ? `${docProxyUrl}&download=1` : (fileUrl || coi.certificate_url || null)
  const hasDownload = Boolean(downloadHref)
  const hasOpenOriginal = Boolean(docProxyUrl || fileUrl || coi.certificate_url)

  const statusMeta = useMemo(() => {
    if (coi.status === 'compliant') return { label: 'Compliant', color: 'bg-emerald-600', text: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-200', icon: ShieldCheck }
    if (allExpired) return { label: 'All policies expired', color: 'bg-rose-600', text: 'text-rose-700', bg: 'bg-rose-50', border: 'border-rose-200', icon: XCircle }
    if (partiallyExpired) return { label: 'Partially expired', color: 'bg-amber-500', text: 'text-amber-800', bg: 'bg-amber-50', border: 'border-amber-200', icon: AlertTriangle }
    if (coi.status === 'rejected') return { label: 'Rejected', color: 'bg-rose-600', text: 'text-rose-700', bg: 'bg-rose-50', border: 'border-rose-200', icon: XCircle }
    if (coi.status === 'needs_revision') return { label: 'Needs revision', color: 'bg-amber-500', text: 'text-amber-800', bg: 'bg-amber-50', border: 'border-amber-200', icon: AlertTriangle }
    return { label: 'Pending review', color: 'bg-indigo-600', text: 'text-indigo-700', bg: 'bg-indigo-50', border: 'border-indigo-200', icon: Clock }
  }, [coi.status, allExpired, partiallyExpired])

  const copyFormText = () => {
    const lines = [
      'CERTIFICATE OF LIABILITY INSURANCE (ACORD 25)',
      `Status: ${statusMeta.label}`,
      `Named Insured: ${insured?.name || (coi as any).sub_company_name || coi.company_name || '—'}`,
      `Producer: ${producer?.name || '—'} (${producer?.phone || 'no phone'} / ${producer?.email || 'no email'})`,
      `Insurers: ${insurers.map((i: any) => `${i.letter || 'A'}: ${i.name || '—'}${i.naic ? ` (NAIC ${i.naic})` : ''}`).join(' | ')}`,
      '',
      'POLICIES:',
      ...policies.map((p: any) => `${p.insurerLetter || 'A'} | ${(p.type || 'Coverage').toUpperCase()} | #${p.policyNumber || 'n/a'} | ${p.effectiveDate || '—'} → ${p.expirationDate || '—'} ${isExpiredDate(p.expirationDate || p.expiration_date) ? '[EXPIRED]' : ''} | ${(p.limits || []).map((l: any) => `${l.label}: ${l.amount}`).join('; ') || 'limits n/a'}`),
      '',
      `Endorsements: ${endorsementWording.join(', ') || 'none noted'}`,
      `Notes: ${coi.reviewer_notes || '—'}`,
    ]
    navigator.clipboard.writeText(lines.join('\n')).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
  }

  const StatusIcon = statusMeta.icon

  return (
    <div className={`acord-sheet bg-white text-slate-900 border border-slate-300 shadow-sm print:border-0 print:shadow-none ${className}`} style={{ fontFamily: 'Georgia, Times New Roman, serif' }}>
      {/* ── Status ribbon ── */}
      <div className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs border-b ${statusMeta.border} ${statusMeta.bg} print:hidden`} style={{ fontFamily: 'system-ui, sans-serif' }}>
        <div className="flex flex-wrap items-center gap-2">
          <StatusIcon className="w-4 h-4 shrink-0" />
          <span className="font-bold">{statusMeta.label}</span>
          <span className="text-slate-500">·</span>
          <span>{policies.length} policy line{policies.length === 1 ? '' : 's'}</span>
          {days !== null && days >= 0 && <span className="text-slate-600">· {days}d until overall expiration</span>}
          {days !== null && days < 0 && <span className="text-rose-700 font-bold font-mono">· {Math.abs(days)}d expired</span>}
          {partiallyExpired && <span className="text-amber-900 font-semibold">(1+ policy expired; remaining policies active)</span>}
        </div>
        <div className="text-[11px] text-slate-500">
          {hasExtractedData ? 'Rendered from extracted certificate data' : 'Basic record view — fields not yet extracted'}
        </div>
      </div>

      {/* ── Action bar ── */}
      {showActions && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-slate-200 bg-slate-50 text-xs print:hidden" style={{ fontFamily: 'system-ui, sans-serif' }}>
          <div className="flex flex-wrap items-center gap-1.5">
            {hasOpenOriginal && (
              <button
                type="button"
                onClick={onOpenFile}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 bg-white font-medium hover:bg-slate-100"
                title="Switch to original PDF/image file view"
              >
                <FileText className="w-3.5 h-3.5 text-slate-500" /> Original file
              </button>
            )}
            {hasDownload && (
              <a
                href={downloadHref!}
                download
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 bg-white font-medium hover:bg-slate-100 text-slate-700"
              >
                <Download className="w-3.5 h-3.5 text-slate-500" /> Download PDF
              </a>
            )}
            {docProxyUrl && (
              <a
                href={docProxyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 bg-white font-medium hover:bg-slate-100 text-slate-700"
              >
                Open in new tab <ExternalLink className="w-3 h-3 text-slate-400" />
              </a>
            )}
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 bg-white font-medium hover:bg-slate-100"
            >
              <Printer className="w-3.5 h-3.5 text-slate-500" /> Print
            </button>
            <button
              type="button"
              onClick={copyFormText}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 bg-white font-medium hover:bg-slate-100"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5 text-slate-500" />}
              {copied ? 'Copied' : 'Copy text'}
            </button>
          </div>
          {onEdit && (
            <button
              type="button"
              onClick={onEdit}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-indigo-600 text-white font-semibold hover:bg-indigo-700"
            >
              <Edit3 className="w-3.5 h-3.5" /> Edit data
            </button>
          )}
        </div>
      )}

      {/* ── ACORD form body ── */}
      <div className={`p-3 sm:p-5 print:p-0 space-y-2 acord-print-area ${dense ? 'text-[11px]' : 'text-xs'}`}>
        {/* Header */}
        <div className="border-2 border-slate-900 p-2 text-center relative">
          <div className="flex items-center justify-between text-[10px] text-slate-500 mb-1" style={{ fontFamily: 'system-ui, sans-serif' }}>
            <span className="font-bold tracking-wider">ACORD 25 (2016/03) STYLE CERTIFICATE</span>
            <span>DATE (MM/DD/YYYY): <strong className="font-mono text-slate-900">{todayDisplay()}</strong></span>
          </div>
          <h1 className="text-base sm:text-lg font-bold tracking-wider uppercase text-slate-900">
            Certificate of Liability Insurance
          </h1>
          <p className="mt-1 text-[9px] sm:text-[10px] leading-tight text-slate-600 text-justify">
            THIS CERTIFICATE IS ISSUED AS A MATTER OF INFORMATION ONLY AND CONFERS NO RIGHTS UPON THE CERTIFICATE HOLDER.
            THIS CERTIFICATE DOES NOT AFFIRMATIVELY OR NEGATIVELY AMEND, EXTEND OR ALTER THE COVERAGE AFFORDED BY THE POLICIES BELOW.
          </p>
        </div>

        {/* PRODUCER / INSURED / INSURERS boxes */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <div className="border border-slate-900 p-2 space-y-1">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-700" style={{ fontFamily: 'system-ui, sans-serif' }}>
              Producer
            </div>
            <div className="font-bold text-sm text-slate-900">{producer?.name || <span className="italic text-slate-400 font-normal">Agency name not on file</span>}</div>
            {(producer as any)?.contact_person && <div className="text-[11px]">Contact: {(producer as any).contact_person}</div>}
            <div className="text-[11px] text-slate-600 whitespace-pre-line">{producer?.address || <span className="italic text-slate-400">Agency address not on file</span>}</div>
            <div className="text-[11px] text-slate-600">
              Phone: {producer?.phone || <span className="italic text-slate-400">—</span>} · Email: {producer?.email || <span className="italic text-slate-400">—</span>}
            </div>
          </div>
          <div className="border border-slate-900 p-2 space-y-1">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-700" style={{ fontFamily: 'system-ui, sans-serif' }}>
              Insured
            </div>
            <div className="font-bold text-sm text-slate-900">
              {insured?.name || (coi as any).sub_company_name || coi.company_name || <span className="italic text-slate-400 font-normal">Named insured not on file</span>}
            </div>
            <div className="text-[11px] text-slate-600 whitespace-pre-line">{insured?.address || <span className="italic text-slate-400">Insured address not on file</span>}</div>
            <div className="text-[10px] text-slate-500 italic mt-1">This should match the subcontractor hired for your job.</div>
          </div>
        </div>

        {/* INSURERS AFFORDING COVERAGE */}
        <div className="border border-slate-900 p-2">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-700 mb-1" style={{ fontFamily: 'system-ui, sans-serif' }}>
            Insurers Affording Coverage
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
            {['A', 'B', 'C', 'D'].map((letter) => {
              const ins = insurers.find((i: any) => (i.letter || 'A').toUpperCase() === letter)
              return (
                <div key={letter} className="flex items-baseline justify-between py-0.5 border-b border-dotted border-slate-300">
                  <span><strong>INSURER {letter}:</strong> {ins?.name || <span className="italic text-slate-400">—</span>}</span>
                  <span className="font-mono text-[10px] text-slate-500 ml-2">NAIC # {(ins as any)?.naic || '—'}</span>
                </div>
              )
            })}
          </div>
        </div>

        {/* COVERAGES table */}
        <div className="border-2 border-slate-900 overflow-x-auto">
          <table className="w-full text-left border-collapse text-[11px]">
            <thead>
              <tr className="bg-slate-900 text-white text-[9px] uppercase tracking-wider" style={{ fontFamily: 'system-ui, sans-serif' }}>
                <th className="p-1.5 border border-slate-700 text-center w-10">INSR LTR</th>
                <th className="p-1.5 border border-slate-700 w-2/5">Type of insurance</th>
                <th className="p-1.5 border border-slate-700 text-center w-14">ADDL INSD</th>
                <th className="p-1.5 border border-slate-700 text-center w-14">SUBR WVD</th>
                <th className="p-1.5 border border-slate-700">Policy number</th>
                <th className="p-1.5 border border-slate-700 text-center">Policy EFF</th>
                <th className="p-1.5 border border-slate-700 text-center">Policy EXP</th>
                <th className="p-1.5 border border-slate-700 w-1/4">Limits</th>
              </tr>
            </thead>
            <tbody>
              {COVERAGE_SLOTS.map((slot) => {
                const list = policiesBySlot.get(slot.key) || []
                return (
                  <tr key={slot.key} className="align-top hover:bg-slate-50">
                    <td className="p-1.5 border border-slate-400 text-center font-bold">
                      {list.map((p: any, i: number) => <div key={i}>{p.insurerLetter || 'A'}</div>)}
                      {list.length === 0 && <span className="text-slate-300">—</span>}
                    </td>
                    <td className="p-1.5 border border-slate-400">
                      <div className="font-bold text-[10px] uppercase text-slate-900" style={{ fontFamily: 'system-ui, sans-serif' }}>{slot.label}</div>
                      {slot.subtypeHint && <div className="text-[9px] text-slate-500 tracking-tight">{slot.subtypeHint}</div>}
                      {list.length === 0 && <div className="text-[10px] italic text-slate-400 mt-1">Not listed on this certificate</div>}
                    </td>
                    <td className="p-1.5 border border-slate-400 text-center font-mono text-[10px]">
                      {list.map((_: any, i: number) => <div key={i}>{additionalInsured ? 'Y' : '—'}</div>)}
                      {list.length === 0 && <span className="text-slate-300">—</span>}
                    </td>
                    <td className="p-1.5 border border-slate-400 text-center font-mono text-[10px]">
                      {list.map((_: any, i: number) => <div key={i}>{waiverOfSubrogation ? 'Y' : '—'}</div>)}
                      {list.length === 0 && <span className="text-slate-300">—</span>}
                    </td>
                    <td className="p-1.5 border border-slate-400 font-mono text-[10px] whitespace-nowrap">
                      {list.map((p: any, i: number) => <div key={i}>{p.policyNumber || <span className="italic text-slate-400">n/a</span>}</div>)}
                      {list.length === 0 && <span className="text-slate-300">—</span>}
                    </td>
                    <td className="p-1.5 border border-slate-400 font-mono text-[10px] text-center whitespace-nowrap">
                      {list.map((p: any, i: number) => <div key={i}>{formatDisplayDate(p.effectiveDate) || '—'}</div>)}
                      {list.length === 0 && <span className="text-slate-300">—</span>}
                    </td>
                    <td className="p-1.5 border border-slate-400 font-mono text-[10px] text-center whitespace-nowrap">
                      {list.map((p: any, i: number) => {
                        const exp = p.expirationDate || p.expiration_date
                        const expired = isExpiredDate(exp)
                        return (
                          <div key={i} className="flex items-center justify-center gap-1">
                            <span className={expired ? 'line-through text-rose-700' : ''}>{formatDisplayDate(exp) || '—'}</span>
                            {expired && <span className="text-[8px] font-bold px-1 rounded bg-rose-600 text-white font-sans">EXPIRED</span>}
                          </div>
                        )
                      })}
                      {list.length === 0 && <span className="text-slate-300">—</span>}
                    </td>
                    <td className="p-1.5 border border-slate-400 text-[10px]">
                      {list.map((p: any, i: number) => (
                        <div key={i} className="space-y-0.5">
                          {(p.limits && p.limits.length) ? (
                            p.limits.map((l: any, j: number) => (
                              <div key={j} className="flex justify-between gap-1 text-[10px]">
                                <span className="text-slate-600 truncate">{l.label}</span>
                                <span className="font-mono font-bold whitespace-nowrap">{l.amount}</span>
                              </div>
                            ))
                          ) : (
                            <span className="italic text-slate-400">Limits not stated</span>
                          )}
                        </div>
                      ))}
                      {list.length === 0 && <span className="text-slate-300">—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* DESCRIPTION OF OPERATIONS */}
        <div className="border border-slate-900 p-2 space-y-1">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-700" style={{ fontFamily: 'system-ui, sans-serif' }}>
            Description of Operations / Locations / Vehicles (ACORD 101, Additional Remarks Schedule, may be attached if more space is required)
          </div>
          <div className="text-[11px] text-slate-800 whitespace-pre-wrap">
            {coi.reviewer_notes ? coi.reviewer_notes : <span className="italic text-slate-400">No endorsement or operation remarks extracted from this certificate.</span>}
          </div>
          {endorsementWording.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1 text-[10px]" style={{ fontFamily: 'system-ui, sans-serif' }}>
              {endorsementWording.map((w, i) => (
                <span key={i} className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-300 font-medium">✓ {w}</span>
              ))}
            </div>
          )}
          {primaryNonContributory && (
            <div className="text-[10px] text-emerald-800 font-medium">✓ Primary & non-contributory wording on file</div>
          )}
        </div>

        {/* CERTIFICATE HOLDER / CANCELLATION / SIGNATURE */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <div className="border border-slate-900 p-2 space-y-1">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-700" style={{ fontFamily: 'system-ui, sans-serif' }}>
              Certificate Holder
            </div>
            <div className="font-bold text-sm text-slate-900">
              {(coi as any).gc_company_name || (coi as any).gc_company || 'Your Company, Inc.'}
            </div>
            <div className="text-[10px] text-slate-600">The general contractor hiring the subcontractor should be named here as certificate holder, and additionally insured on the general liability (CG 20 10 / CG 20 37 or equivalent) and waiver of subrogation.</div>
          </div>
          <div className="border border-slate-900 p-2 space-y-2 flex flex-col justify-between">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-700 mb-1" style={{ fontFamily: 'system-ui, sans-serif' }}>
                Cancellation
              </div>
              <p className="text-[9px] leading-tight text-slate-600 text-justify">
                SHOULD ANY OF THE ABOVE DESCRIBED POLICIES BE CANCELLED BEFORE THE EXPIRATION DATE THEREOF,
                NOTICE WILL BE DELIVERED IN ACCORDANCE WITH THE POLICY PROVISIONS.
              </p>
            </div>
            <div className="pt-2 border-t border-slate-400 flex items-center justify-between text-[10px]">
              <span className="italic text-slate-400">Authorized representative</span>
              <span className="font-mono text-slate-600">/s/ (agency electronic)</span>
            </div>
          </div>
        </div>

        {/* Footer caption */}
        <div className="flex flex-wrap items-center justify-between text-[9px] text-slate-500 pt-1 border-t border-dotted border-slate-400" style={{ fontFamily: 'system-ui, sans-serif' }}>
          <span>ACORD 25 (2016/03) style · Generated from SafeCOI extracted document data</span>
          <span>© 1988-2015 ACORD CORPORATION. All rights reserved. Layout used for information display only.</span>
        </div>
      </div>
    </div>
  )
}
export default AcordCertificateForm
