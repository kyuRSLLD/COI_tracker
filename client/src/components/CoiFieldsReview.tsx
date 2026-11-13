import { AlertCircle, ArrowUpRight, FileText, Info, Plus, Trash2 } from 'lucide-react'
import { useId, useState, type ClipboardEvent } from 'react'
import type { CoiFields } from '../lib/coiFields'

export interface CoiFieldsReviewProps {
  details: CoiFields
  onChange: (next: CoiFields) => void
  onSave: () => void
  onClose: () => void
  saving: boolean
  editable: boolean
  error?: string | null
  ocrText?: string
  ocrWarnings?: string[]
  originalUrl?: string
}

type FieldProps = {
  label: string
  value: string | null | undefined
  onChange: (value: string) => void
  readOnly: boolean
  placeholder?: string
  multiline?: boolean
  type?: 'text' | 'email' | 'tel'
  maxLength: number
}

const inputClass = 'block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 read-only:bg-slate-50 read-only:text-slate-700'
const smallButtonClass = 'inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-50'
const removeButtonClass = 'inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 py-2 text-sm font-medium text-slate-500 hover:bg-rose-50 hover:text-rose-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-50'

function Field({ label, value, onChange, readOnly, placeholder, multiline, type = 'text', maxLength }: FieldProps) {
  const fieldId = useId()
  const hintId = `${fieldId}-hint`
  const [pasteRejected, setPasteRejected] = useState(false)
  const overLimit = (value?.length ?? 0) > maxLength
  const handlePaste = (event: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (readOnly) return
    const input = event.currentTarget
    // Email inputs may not expose their selection. Assume none so the browser
    // cannot silently clip a paste.
    const selected = input.selectionStart !== null && input.selectionEnd !== null
      ? input.selectionEnd - input.selectionStart : 0
    if (input.value.length - selected + event.clipboardData.getData('text').length > maxLength) {
      event.preventDefault()
      setPasteRejected(true)
    }
  }
  return (
    <div className="block min-w-0">
      <label htmlFor={fieldId} className="mb-1.5 block text-sm font-semibold text-slate-700">{label}</label>
      {multiline ? (
        <textarea
          id={fieldId}
          className={`${inputClass} min-h-[84px] resize-y`}
          value={value ?? ''}
          maxLength={maxLength}
          aria-describedby={hintId}
          aria-invalid={overLimit || undefined}
          onChange={(event) => { setPasteRejected(false); onChange(event.target.value) }}
          onPaste={handlePaste}
          readOnly={readOnly}
          placeholder={readOnly ? undefined : placeholder}
          rows={3}
        />
      ) : (
        <input
          id={fieldId}
          className={inputClass}
          type={type}
          value={value ?? ''}
          maxLength={maxLength}
          aria-describedby={hintId}
          aria-invalid={overLimit || undefined}
          onChange={(event) => { setPasteRejected(false); onChange(event.target.value) }}
          onPaste={handlePaste}
          readOnly={readOnly}
          placeholder={readOnly ? undefined : placeholder}
        />
      )}
      <span id={hintId} aria-live="polite" className={`mt-1 block text-xs ${overLimit ? 'font-semibold text-rose-700' : 'text-slate-500'}`}>
        {overLimit ? `${value?.length} characters — shorten to ${maxLength} or fewer to save. Nothing was removed automatically.` : `Maximum ${maxLength} characters.`} {pasteRejected && 'Paste was not applied because it would exceed the limit. Shorten the text or remove existing text first.'}
      </span>
    </div>
  )
}

function SectionHeading({ number, title, description }: { number: string; title: string; description: string }) {
  return (
    <div className="flex items-start gap-3">
      <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-xs font-bold text-brand-700">{number}</span>
      <div>
        <h2 className="text-base font-bold text-slate-900">{title}</h2>
        <p className="mt-0.5 text-sm leading-5 text-slate-500">{description}</p>
      </div>
    </div>
  )
}

// Do not expose the page URL as a referrer to a signed document link, and never
// allow an executable URL scheme. The caller remains responsible for access control.
function safeOriginalUrl(url?: string): string | undefined {
  if (!url || !url.trim() || url.trim().startsWith('#')) return undefined
  try {
    const parsed = new URL(url, typeof window === 'undefined' ? 'https://example.invalid' : window.location.href)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : undefined
  } catch {
    return undefined
  }
}

const MAX_INSURERS = 10
const MAX_POLICIES = 20
const MAX_LIMITS = 20 // per policy

// Values may already be over the server limits (for example, from OCR). Never
// truncate them: explain what needs correction and keep the full value visible.
function validationIssues(details: CoiFields): string[] {
  const issues: string[] = []
  const check = (label: string, value: string | null | undefined, max: number) => {
    if ((value?.length ?? 0) > max) issues.push(`${label}: shorten to ${max} characters or fewer`)
  }
  check('Producer name', details.producer.name, 256)
  check('Producer address', details.producer.address, 2000)
  check('Producer phone', details.producer.phone, 128)
  check('Producer email', details.producer.email, 254)
  check('Insured name', details.insured.name, 256)
  check('Insured address', details.insured.address, 2000)
  if (details.insurers.length > MAX_INSURERS) issues.push(`Remove insurers until there are ${MAX_INSURERS} or fewer`)
  if (details.policies.length > MAX_POLICIES) issues.push(`Remove policies until there are ${MAX_POLICIES} or fewer`)
  details.insurers.forEach((insurer, index) => {
    check(`Insurer ${index + 1} letter`, insurer.letter, 32)
    check(`Insurer ${index + 1} name`, insurer.name, 256)
    check(`Insurer ${index + 1} NAIC #`, insurer.naic, 64)
  })
  details.policies.forEach((policy, index) => {
    const name = `Policy ${index + 1}`
    check(`${name} type`, policy.type, 256)
    check(`${name} insurer letter`, policy.insurerLetter, 32)
    check(`${name} number`, policy.policyNumber, 256)
    check(`${name} effective date`, policy.effectiveDate, 64)
    check(`${name} expiration date`, policy.expirationDate, 64)
    if (policy.limits.length > MAX_LIMITS) issues.push(`${name}: remove limits until there are ${MAX_LIMITS} or fewer`)
    policy.limits.forEach((limit, limitIndex) => {
      check(`${name}, limit ${limitIndex + 1} label`, limit.label, 256)
      check(`${name}, limit ${limitIndex + 1} amount`, limit.amount, 128)
    })
  })
  return issues
}

function hasFieldValues(details: CoiFields): boolean {
  return Object.values(details.producer).some(Boolean) || Object.values(details.insured).some(Boolean) ||
    details.insurers.some(insurer => Object.values(insurer).some(Boolean)) ||
    details.policies.some(policy => [policy.type, policy.insurerLetter, policy.policyNumber, policy.effectiveDate, policy.expirationDate].some(Boolean) ||
      policy.limits.some(limit => Object.values(limit).some(Boolean)))
}

export function CoiFieldsReview({ details, onChange, onSave, onClose, saving, editable, error, ocrText, ocrWarnings, originalUrl }: CoiFieldsReviewProps) {
  const id = useId()
  const readOnly = !editable || saving
  const documentUrl = safeOriginalUrl(originalUrl)
  const issues = validationIssues(details)
  const noFieldValues = !hasFieldValues(details)
  const noMappedFields = details.source === 'ocr' && noFieldValues
  const sourceLabel = details.source === 'ocr' ? (noMappedFields ? 'OCR processed — no fields mapped' : 'OCR field candidates') : details.source === 'mixed' ? 'OCR processed and manually edited' : 'Manually entered'
  // Both review callers pass the backend error message rather than its status.
  const displayError = error && /^(Invalid field review|Request failed \(400\))$/i.test(error.trim())
    ? 'The server could not accept this review. Check the field character limits and the maximum numbers of insurers, policies, and limits below, then try again. Your edits are still here. If the problem continues, contact support.'
    : error

  const update = (next: CoiFields) => {
    if (readOnly) return
    onChange({ ...next, source: details.source === 'ocr' || details.source === 'mixed' ? 'mixed' : 'manual' })
  }
  const updateProducer = (field: keyof CoiFields['producer'], value: string) => {
    update({ ...details, producer: { ...details.producer, [field]: value } })
  }
  const updateInsured = (field: keyof CoiFields['insured'], value: string) => {
    update({ ...details, insured: { ...details.insured, [field]: value } })
  }
  const updateInsurer = (index: number, field: 'letter' | 'name' | 'naic', value: string) => {
    update({ ...details, insurers: details.insurers.map((item, i) => i === index ? { ...item, [field]: value } : item) })
  }
  const updatePolicy = (index: number, field: 'type' | 'insurerLetter' | 'policyNumber' | 'effectiveDate' | 'expirationDate', value: string) => {
    update({ ...details, policies: details.policies.map((item, i) => i === index ? { ...item, [field]: value } : item) })
  }
  const updateLimit = (policyIndex: number, limitIndex: number, field: 'label' | 'amount', value: string) => {
    update({ ...details, policies: details.policies.map((policy, i) => i === policyIndex
      ? { ...policy, limits: policy.limits.map((limit, j) => j === limitIndex ? { ...limit, [field]: value } : limit) }
      : policy) })
  }

  return (
    <form
      className="mx-auto w-full max-w-5xl text-slate-900"
      onSubmit={(event) => { event.preventDefault(); if (editable && !saving && issues.length === 0) onSave() }}
      noValidate
    >
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-2xl">
          <p className="text-xs font-bold uppercase tracking-wider text-brand-700">Certificate of insurance</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Review document data</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">Compare these details with the original certificate and correct any errors. Leave unknown information blank.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">{sourceLabel}</span>
            {!editable && <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">Read only</span>}
          </div>
        </div>
        {documentUrl && (
          <a href={documentUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className={`${smallButtonClass} shrink-0`}>
            <FileText aria-hidden="true" className="h-4 w-4" /> View original document <ArrowUpRight aria-hidden="true" className="h-4 w-4" />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
      </header>

      <div className="mb-5 flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-5 text-amber-950">
        <Info aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
        <div>
          <p className="font-bold">Document data only — not independently confirmed or insurance verification</p>
          <p className="mt-1 text-amber-900">All fields and OCR-recognized text may be inaccurate or incomplete and are not independently verified. Dates and limits are not proof of coverage. Compare everything with the original certificate. Treat this document and its contents as confidential; share only with authorized people.</p>
        </div>
      </div>

      {displayError && <div role="alert" className="mb-5 flex gap-2 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"><AlertCircle aria-hidden="true" className="h-5 w-5 shrink-0" /><span>{displayError}</span></div>}
      {noMappedFields && (
        <p role="status" className="mb-5 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">No fields were automatically mapped from OCR. Check the original certificate and enter the details manually.</p>
      )}
      {!!ocrText?.trim() && noFieldValues && !noMappedFields && (
        <p role="status" className="mb-5 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">No field values are currently shown; no automatically mapped fields remain here. Check the original certificate and enter the details manually.</p>
      )}
      {issues.length > 0 && (
        <div role="alert" className="mb-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          <p className="font-semibold">{editable ? 'Correct these items before saving.' : 'These items exceed the allowed limits.'} Existing values have not been changed.</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">{issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>
        </div>
      )}
      {!!ocrWarnings?.length && (
        <div className="mb-5 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
          <p className="font-semibold">Extraction notes</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">{ocrWarnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>
        </div>
      )}

      <div className="space-y-4">
        <section aria-label="Producer" className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <SectionHeading number="01" title="Producer" description="The agency or broker listed on the certificate." />
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <Field label="Producer name" value={details.producer.name} maxLength={256} onChange={(v) => updateProducer('name', v)} readOnly={readOnly} />
            <Field label="Phone" value={details.producer.phone} maxLength={128} onChange={(v) => updateProducer('phone', v)} readOnly={readOnly} type="tel" />
            <Field label="Address" value={details.producer.address} maxLength={2000} onChange={(v) => updateProducer('address', v)} readOnly={readOnly} multiline />
            <Field label="Email" value={details.producer.email} maxLength={254} onChange={(v) => updateProducer('email', v)} readOnly={readOnly} type="email" />
          </div>
        </section>

        <section aria-label="Insured" className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <SectionHeading number="02" title="Insured" description="The person or organization named as insured." />
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <Field label="Insured name" value={details.insured.name} maxLength={256} onChange={(v) => updateInsured('name', v)} readOnly={readOnly} />
            <Field label="Address" value={details.insured.address} maxLength={2000} onChange={(v) => updateInsured('address', v)} readOnly={readOnly} multiline />
          </div>
        </section>

        <section aria-label="Insurers affording coverage" className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <SectionHeading number="03" title="Insurers affording coverage" description="Enter each insurer and its letter as shown on the certificate." />
            {editable && <div>
              <button type="button" className={smallButtonClass} disabled={saving || details.insurers.length >= MAX_INSURERS} aria-describedby={details.insurers.length >= MAX_INSURERS ? `${id}-insurer-cap` : undefined} onClick={() => { if (details.insurers.length < MAX_INSURERS) update({ ...details, insurers: [...details.insurers, { letter: '', name: '', naic: '' }] }) }}><Plus aria-hidden="true" className="h-4 w-4" /> Add insurer</button>
              {details.insurers.length >= MAX_INSURERS && <p id={`${id}-insurer-cap`} className="mt-1 text-xs text-slate-600">Maximum 10 insurers. To add one, reduce the total below 10.</p>}
            </div>}
          </div>
          {details.insurers.length === 0 ? (
            <p className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-500">No insurers entered{editable ? '. Add an insurer if one is listed on the certificate.' : '.'}</p>
          ) : (
            <div className="mt-5 space-y-3">
              {details.insurers.map((insurer, index) => (
                <div key={index} className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <h3 className="text-sm font-bold text-slate-800">Insurer {index + 1}</h3>
                    {editable && <button type="button" className={removeButtonClass} disabled={saving} aria-label={`Remove insurer ${index + 1}`} onClick={() => update({ ...details, insurers: details.insurers.filter((_, i) => i !== index) })}><Trash2 aria-hidden="true" className="h-4 w-4" /> Remove</button>}
                  </div>
                  <div className="grid gap-4 sm:grid-cols-6">
                    <div className="sm:col-span-1"><Field label="Letter" value={insurer.letter} maxLength={32} onChange={(v) => updateInsurer(index, 'letter', v)} readOnly={readOnly} /></div>
                    <div className="sm:col-span-3"><Field label="Insurer name" value={insurer.name} maxLength={256} onChange={(v) => updateInsurer(index, 'name', v)} readOnly={readOnly} /></div>
                    <div className="sm:col-span-2"><Field label="NAIC #" value={insurer.naic} maxLength={64} onChange={(v) => updateInsurer(index, 'naic', v)} readOnly={readOnly} /></div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section aria-label="Insurance policies" className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <SectionHeading number="04" title="Insurance policies" description="Record the policy details and named limits exactly as shown." />
            {editable && <div>
              <button type="button" className={smallButtonClass} disabled={saving || details.policies.length >= MAX_POLICIES} aria-describedby={details.policies.length >= MAX_POLICIES ? `${id}-policy-cap` : undefined} onClick={() => { if (details.policies.length < MAX_POLICIES) update({ ...details, policies: [...details.policies, { type: '', insurerLetter: '', policyNumber: '', effectiveDate: '', expirationDate: '', limits: [] }] }) }}><Plus aria-hidden="true" className="h-4 w-4" /> Add policy</button>
              {details.policies.length >= MAX_POLICIES && <p id={`${id}-policy-cap`} className="mt-1 text-xs text-slate-600">Maximum 20 policies. To add one, reduce the total below 20.</p>}
            </div>}
          </div>
          {details.policies.length === 0 ? (
            <p className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-500">No policies entered{editable ? '. Add a policy if one is listed on the certificate.' : '.'}</p>
          ) : (
            <div className="mt-5 space-y-4">
              {details.policies.map((policy, index) => (
                <div key={index} className="rounded-xl border border-slate-200 bg-slate-50/50 p-4 sm:p-5">
                  <div className="mb-4 flex items-center justify-between gap-2">
                    <h3 className="text-sm font-bold text-slate-900">Policy {index + 1}</h3>
                    {editable && <button type="button" className={removeButtonClass} disabled={saving} aria-label={`Remove policy ${index + 1}`} onClick={() => update({ ...details, policies: details.policies.filter((_, i) => i !== index) })}><Trash2 aria-hidden="true" className="h-4 w-4" /> Remove policy</button>}
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
                    <div className="lg:col-span-3"><Field label="Type of insurance" value={policy.type} maxLength={256} onChange={(v) => updatePolicy(index, 'type', v)} readOnly={readOnly} /></div>
                    <div className="lg:col-span-3"><Field label="Insurer letter" value={policy.insurerLetter} maxLength={32} onChange={(v) => updatePolicy(index, 'insurerLetter', v)} readOnly={readOnly} /></div>
                    <div className="lg:col-span-2"><Field label="Policy number" value={policy.policyNumber} maxLength={256} onChange={(v) => updatePolicy(index, 'policyNumber', v)} readOnly={readOnly} /></div>
                    <div className="lg:col-span-2"><Field label="Effective date" value={policy.effectiveDate} maxLength={64} onChange={(v) => updatePolicy(index, 'effectiveDate', v)} readOnly={readOnly} placeholder="As shown on document" /></div>
                    <div className="lg:col-span-2"><Field label="Expiration date" value={policy.expirationDate} maxLength={64} onChange={(v) => updatePolicy(index, 'expirationDate', v)} readOnly={readOnly} placeholder="As shown on document" /></div>
                  </div>
                  <div className="mt-5 border-t border-slate-200 pt-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div><h4 className="text-sm font-bold text-slate-800">Named limits</h4><p className="mt-0.5 text-xs text-slate-500">Use the labels and amounts on the document.</p></div>
                      {editable && <div>
                        <button type="button" className={smallButtonClass} disabled={saving || policy.limits.length >= MAX_LIMITS} aria-label={`Add limit to policy ${index + 1}`} aria-describedby={policy.limits.length >= MAX_LIMITS ? `${id}-limit-cap-${index}` : undefined} onClick={() => { if (policy.limits.length < MAX_LIMITS) update({ ...details, policies: details.policies.map((p, i) => i === index ? { ...p, limits: [...p.limits, { label: '', amount: '' }] } : p) }) }}><Plus aria-hidden="true" className="h-4 w-4" /> Add limit</button>
                        {policy.limits.length >= MAX_LIMITS && <p id={`${id}-limit-cap-${index}`} className="mt-1 text-xs text-slate-600">Maximum 20 limits per policy. To add one, reduce the total below 20.</p>}
                      </div>}
                    </div>
                    {policy.limits.length === 0 ? <p className="mt-3 text-sm text-slate-500">No limits entered.</p> : (
                      <div className="mt-3 space-y-3">
                        {policy.limits.map((limit, limitIndex) => (
                          <div key={limitIndex} className="grid gap-3 rounded-lg border border-slate-200 bg-white p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
                            <Field label={`Limit ${limitIndex + 1} label`} value={limit.label} maxLength={256} onChange={(v) => updateLimit(index, limitIndex, 'label', v)} readOnly={readOnly} />
                            <Field label={`Limit ${limitIndex + 1} amount`} value={limit.amount} maxLength={128} onChange={(v) => updateLimit(index, limitIndex, 'amount', v)} readOnly={readOnly} />
                            {editable && <button type="button" className={removeButtonClass} disabled={saving} aria-label={`Remove limit ${limitIndex + 1} from policy ${index + 1}`} onClick={() => update({ ...details, policies: details.policies.map((p, i) => i === index ? { ...p, limits: p.limits.filter((_, j) => j !== limitIndex) } : p) })}><Trash2 aria-hidden="true" className="h-4 w-4" /> Remove</button>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {ocrText && (
          <details className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
            <summary className="cursor-pointer text-sm font-bold text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600">View OCR-recognized text</summary>
            <p className="mt-2 text-xs leading-5 text-slate-500">This is raw text recognized by OCR, not a list of extracted fields. It may contain errors or confidential information; compare it and every field with the original certificate.</p>
            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-4 font-mono text-xs leading-5 text-slate-700">{ocrText}</pre>
          </details>
        )}
      </div>

      <footer className="mt-6 flex flex-col-reverse gap-2 border-t border-slate-200 pt-5 sm:flex-row sm:justify-end">
        <button type="button" onClick={onClose} disabled={saving} className={smallButtonClass}>{editable ? 'Cancel' : 'Close'}</button>
        {editable && <button type="submit" disabled={saving || issues.length > 0} className="inline-flex min-h-10 items-center justify-center rounded-lg bg-brand-700 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700 disabled:cursor-not-allowed disabled:opacity-50">{saving ? 'Saving…' : 'Save changes'}</button>}
      </footer>
    </form>
  )
}
