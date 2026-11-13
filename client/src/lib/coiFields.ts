export type CoiFields = {
  producer: { name: string; address: string; phone: string; email: string }
  insured: { name: string; address: string }
  insurers: Array<{ letter: string; name: string; naic: string }>
  policies: Array<{
    type: string
    insurerLetter: string
    policyNumber: string
    effectiveDate: string
    expirationDate: string
    limits: Array<{ label: string; amount: string }>
  }>
  source: 'ocr' | 'manual' | 'mixed'
}

/** Create a fresh editable manual record; do not infer verification from this source. */
export function emptyCoiFields(): CoiFields {
  return {
    producer: { name: '', address: '', phone: '', email: '' },
    insured: { name: '', address: '' },
    insurers: [],
    policies: [],
    source: 'manual',
  }
}
