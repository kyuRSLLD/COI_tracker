import { formatDisplayDate } from './date'
import { formatAmount } from './currency'
import type { ComponentProps } from 'react'
import type { CoiFieldsReview } from '../components/CoiFieldsReview'

export type FieldsDetails = ComponentProps<typeof CoiFieldsReview>['details']

export function editorDetails(details: FieldsDetails | null): FieldsDetails {
  return {
    producer: {
      name: details?.producer?.name ?? '', address: details?.producer?.address ?? '',
      phone: details?.producer?.phone ?? '', email: details?.producer?.email ?? '',
    },
    insured: { name: details?.insured?.name ?? '', address: details?.insured?.address ?? '' },
    insurers: (details?.insurers ?? []).map((item) => ({ letter: item.letter ?? '', name: item.name ?? '', naic: item.naic ?? '' })),
    policies: (details?.policies ?? []).map((policy) => ({
      type: policy.type ?? '', insurerLetter: policy.insurerLetter ?? '', policyNumber: policy.policyNumber ?? '',
      effectiveDate: policy.effectiveDate ? formatDisplayDate(policy.effectiveDate) : '', expirationDate: policy.expirationDate ? formatDisplayDate(policy.expirationDate) : '',
      limits: (policy.limits ?? []).map((limit) => ({ label: limit.label ?? '', amount: limit?.amount ? formatAmount(limit.amount) : '' })),
    })),
    source: details?.source ?? 'manual',
  }
}
