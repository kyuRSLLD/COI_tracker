import { getToken } from '../../api'

export const relationshipPrototypeEnabled = import.meta.env.DEV && import.meta.env.VITE_RELATIONSHIP_PROTOTYPE_ENABLED === 'true'

export type PrototypeCoverage = {
  id: string
  type: string | null
  per_occurrence_limit: string | null
  aggregate_limit: string | null
  additional_insured: number | boolean | null
  waiver_of_subrogation: number | boolean | null
  notes: string | null
}
export type PrototypeCoi = {
  id: string
  carrier: string | null
  am_best_rating: string | null
  policy_number: string | null
  effective_date: string | null
  expiration_date: string | null
  status: string | null
  reviewer_notes: string | null
  review_date: string | null
  certificate_name: string | null
  certificate_size: number | null
  certificate_mime: string | null
  created_at: string | null
  updated_at: string | null
  coverages: PrototypeCoverage[]
}
export type PrototypeConnection = {
  sub_user_id: string
  company_name: string
  trade: string | null
  connected_at: string
  cois: PrototypeCoi[]
}
type Capability = { id: string; token: string; expires_at: string }
type SubPreview = { company_name: string; trade: string | null; expires_at: string }

// Deliberately separate from the legacy/staged API. Capabilities are POSTed only
// in JSON bodies. Do not log requests, responses, capability values, or errors.
async function request<T>(path: string, method: 'GET' | 'POST' | 'DELETE', body?: object): Promise<T> {
  if (!relationshipPrototypeEnabled) throw new Error('Prototype unavailable')
  const auth = getToken()
  if (!auth) throw new Error('Sign in required')
  const response = await fetch(`/api/relationship-prototype${path}`, {
    method,
    headers: { Authorization: `Bearer ${auth}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  })
  if (!response.ok) throw new Error('Prototype request failed')
  return response.json() as Promise<T>
}

export const gcPrototypeApi = {
  connections: () => request<{ connections: PrototypeConnection[] }>('/gc/connections', 'GET'),
  preview: (token: string) => request<SubPreview>('/sub-qr/preview', 'POST', { token }),
  accept: (token: string) => request<{ status: string }>('/sub-qr/accept', 'POST', { token }),
  createInvite: () => request<Capability>('/gc-invitations', 'POST'),
  revokeInvite: (id: string) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid capability ID')
    return request<{ revoked: boolean }>(`/capabilities/${id}`, 'DELETE')
  },
}
