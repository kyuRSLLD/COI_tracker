// Development-only experiment. Never send capabilities in a URL, storage, or logs.
export const relationshipPrototypeEnabled = import.meta.env.DEV && import.meta.env.VITE_RELATIONSHIP_PROTOTYPE_ENABLED === 'true'

export type RelationshipDisclosure = { version: string; scope: string; qr: string; invitation: string }
export type RelationshipCapability = { id: string; token: string; expires_at: string }
export type RelationshipInvitePreview = { gc_user_id: string; gc_company_name: string; expires_at: string; disclosure: RelationshipDisclosure }
export type RelationshipSubConnection = { gc_user_id: string; gc_company_name: string | null; connected_at: string; source: string }
export type RelationshipGcConnection = { sub_user_id: string; company_name: string; trade: string | null; connected_at: string; cois: Array<Record<string, unknown>> }
export type RelationshipQrPreview = { company_name: string; trade: string | null; expires_at: string }

const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const idPattern = /^[A-Za-z0-9_-]{1,128}$/
export const validRelationshipToken = (token: string) => tokenPattern.test(token)
function idPath(id: string) {
  if (!idPattern.test(id)) throw new Error('Invalid identifier')
  return encodeURIComponent(id)
}
function disclosureValid(value: RelationshipDisclosure) {
  return !!value && ['version', 'scope', 'qr', 'invitation'].every(key => typeof value[key as keyof RelationshipDisclosure] === 'string' && value[key as keyof RelationshipDisclosure].trim().length > 0)
}
export function matchingDisclosures(a: RelationshipDisclosure, b: RelationshipDisclosure) {
  return disclosureValid(a) && disclosureValid(b) && a.version === b.version && a.scope === b.scope && a.qr === b.qr && a.invitation === b.invitation
}

export function relationshipPrototypeApi(authToken: string) {
  async function request<T>(path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown): Promise<T> {
    if (!relationshipPrototypeEnabled || !authToken) throw new Error('Prototype unavailable')
    const response = await fetch(`/api/relationship-prototype${path}`, {
      method, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Authorization: `Bearer ${authToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    // Do not surface server messages: they could echo secrets.
    if (!response.ok) throw new Error('Prototype request failed')
    return response.json() as Promise<T>
  }
  return {
    disclosure: async () => {
      const d = await request<RelationshipDisclosure>('/disclosure', 'GET')
      if (!disclosureValid(d)) throw new Error('Invalid disclosure')
      return d
    },
    issueQr: (version: string) => request<RelationshipCapability>('/sub-qr', 'POST', { consent: true, consent_version: version }),
    revokeCapability: (id: string) => request<{ revoked: boolean }>(`/capabilities/${idPath(id)}`, 'DELETE'),
    previewInvitation: (token: string) => request<RelationshipInvitePreview>('/gc-invitations/preview', 'POST', { token }),
    acceptInvitation: (token: string, p: RelationshipInvitePreview, version: string) => request<{ status: string }>('/gc-invitations/accept', 'POST', { token, gc_user_id: p.gc_user_id, gc_company_name: p.gc_company_name, consent: true, consent_version: version }),
    subConnections: () => request<{ connections: RelationshipSubConnection[] }>('/sub/connections', 'GET'),
    revokeConnection: (gcId: string) => request<{ revoked: boolean }>(`/sub/connections/${idPath(gcId)}`, 'DELETE'),
    issueInvitation: () => request<RelationshipCapability>('/gc-invitations', 'POST', {}),
    previewQr: (token: string) => request<RelationshipQrPreview>('/sub-qr/preview', 'POST', { token }),
    acceptQr: (token: string) => request<{ status: string }>('/sub-qr/accept', 'POST', { token }),
    gcConnections: () => request<{ connections: RelationshipGcConnection[] }>('/gc/connections', 'GET'),
  }
}
