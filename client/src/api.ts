import type {
  User,
  Subcontractor,
  COI,
  Project,
  Stats,
  EmailLog,
  GCSettings,
  ClientSharePayload,
  UploadValidationPayload,
} from './types'
import type { CoiFields } from './lib/coiFields'

const TOKEN_KEY = 'coi_token'
const USER_KEY = 'coi_user'

// This is per-tab, and is set only when the corresponding identity is displayed.
let verifiedToken: string | null = null
export const SESSION_CHANGED_EVENT = 'coi-session-changed'
export const SESSION_EXPIRED_EVENT = 'coi-session-expired'

export function setVerifiedToken(token: string | null): void {
  verifiedToken = token
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

export function getStoredUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function setStoredUser(user: User | null): void {
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user))
  else localStorage.removeItem(USER_KEY)
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function request<T>(path: string, options: RequestInit = {}, authenticated = true, expectedToken?: string, verification = false): Promise<T> {
  const storedToken = getToken()
  const token = authenticated ? (verification ? expectedToken : verifiedToken) : null
  if (authenticated && (!token || token !== storedToken || (expectedToken !== undefined && expectedToken !== token))) {
    if (storedToken !== verifiedToken) window.dispatchEvent(new Event(SESSION_CHANGED_EVENT))
    throw new Error('Your session changed. Please wait for verification and try again.')
  }
  const headers: Record<string, string> = {
    ...((options.headers as Record<string, string>) || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }
  const res = await fetch(path, { ...options, headers })
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    let code: string | undefined
    try {
      const data = await res.json()
      message = data.error || data.message || message
      code = typeof data.code === 'string' ? data.code : undefined
    } catch {}
    // Changing a password can also reject the current password with a 401.
    // Only the middleware's unambiguous errors mean its bearer token failed.
    const passwordCredentialError = path === '/api/auth/change-password' &&
      message !== 'Authentication required' && message !== 'Invalid or expired token'
    const joinReauthentication = (path.startsWith('/api/sub/join-intent/') || path.startsWith('/api/sub/join/')) &&
      code === 'JOIN_SESSION_REAUTH_REQUIRED'
    if (authenticated && !verification && token && res.status === 401 && !passwordCredentialError && !joinReauthentication && getToken() === token) {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: token }))
    }
    throw new ApiError(message, res.status, code)
  }
  return res.json()
}

// Auth
export async function apiLogin(email: string, password: string): Promise<{ token: string; user: User }> {
  const data = await request<{ token: string; user: User }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  }, false)
  return data
}

export async function apiRegister(body: { email: string; password: string; name?: string; first_name?: string; last_name?: string; phone?: string; company_name?: string; trade?: string; role?: 'gc' | 'sub' }): Promise<{ token: string; user: User }> {
  const data = await request<{ token: string; user: User }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(body),
  }, false)
  return data
}

export async function apiMe(verificationToken?: string): Promise<{ user: User }> {
  return request<{ user: User }>('/api/auth/me', {}, true, verificationToken, verificationToken !== undefined)
}

export function apiLogout(): void {
  setToken(null)
  setStoredUser(null)
}
export async function apiChangePassword(current_password: string, new_password: string): Promise<{ success: boolean; message: string }> {
  return request<{ success: boolean; message: string }>('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ current_password, new_password }),
  })
}

// Subcontractors
export const apiSubcontractors = {
  list: (params?: { trade?: string; status?: string; search?: string; expiring_days?: number }) => {
    const q = new URLSearchParams()
    if (params?.trade) q.set('trade', params.trade)
    if (params?.status) q.set('status', params.status)
    if (params?.search) q.set('search', params.search)
    if (params?.expiring_days) q.set('expiring_days', String(params.expiring_days))
    return request<{ subcontractors: Subcontractor[] }>(`/api/subcontractors?${q.toString()}`)
  },
  get: (id: string) => request<{ subcontractor: Subcontractor }>(`/api/subcontractors/${id}`),
  create: (body: Partial<Subcontractor>) =>
    request<{ subcontractor: Subcontractor }>('/api/subcontractors', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<Subcontractor>) =>
    request<{ subcontractor: Subcontractor }>(`/api/subcontractors/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  delete: (id: string) => request<{ success: boolean }>(`/api/subcontractors/${id}`, { method: 'DELETE' }),
}

// COIs
export const apiCOIs = {
  list: (params?: { sub_id?: string; status?: string }) => {
    const q = new URLSearchParams()
    if (params?.sub_id) q.set('sub_id', params.sub_id)
    if (params?.status) q.set('status', params.status)
    return request<{ cois: COI[] }>(`/api/cois?${q.toString()}`)
  },
  get: (id: string) => request<{ coi: COI }>(`/api/cois/${id}`),
  create: (formData: FormData) =>
    request<{ coi: COI }>('/api/cois', { method: 'POST', body: formData }),
  update: (id: string, formData: FormData) =>
    request<{ coi: COI }>(`/api/cois/${id}`, { method: 'PUT', body: formData }),
  review: (id: string, body: { status: string; reviewer_notes?: string }) =>
    request<{ coi: COI }>(`/api/cois/${id}/review`, { method: 'PUT', body: JSON.stringify(body) }),
  delete: (id: string) => request<{ success: boolean }>(`/api/cois/${id}`, { method: 'DELETE' }),
  expiring: (days = 30) => request<{ alerts: any[]; window_days: number }>(`/api/cois/alerts/expiring?days=${days}`),
}

export interface CoiFieldsResponse {
  details: CoiFields | null
  sourceTag: string
  reviewRevision: string
  certificateUrl: string | null
  editable: boolean
}

// Bind requests to the identity whose dashboard is currently displayed.
export const apiCoiFields = {
  get: async (id: string, expectedToken: string, signal?: AbortSignal) => {
    const result = await request<CoiFieldsResponse>(`/api/coi-fields/${encodeURIComponent(id)}`, { signal, cache: 'no-store' }, true, expectedToken)
    if (!result || typeof result.sourceTag !== 'string' || !result.sourceTag || typeof result.reviewRevision !== 'string' || !result.reviewRevision ||
        !(result.certificateUrl === null || typeof result.certificateUrl === 'string') || typeof result.editable !== 'boolean' || result.details === undefined) {
      throw new Error('The review could not be safely loaded. Please reload and try again.')
    }
    return result
  },
  save: (id: string, body: { sourceTag: string; reviewRevision: string; details: CoiFields }, expectedToken: string, signal?: AbortSignal) =>
    request<CoiFieldsResponse>(`/api/coi-fields/${encodeURIComponent(id)}`, {
      method: 'PUT', body: JSON.stringify(body), signal,
    }, true, expectedToken),
  extract: (id: string, expectedToken: string) =>
    request<{ details?: CoiFields | null; sourceTag?: string; reviewRevision?: string }>(`/api/coi-fields/${encodeURIComponent(id)}/extract`, {
      method: 'POST',
    }, true, expectedToken),
}

// Projects
export const apiProjects = {
  list: () => request<{ projects: Project[] }>('/api/projects'),
  get: (id: string) => request<{ project: Project }>(`/api/projects/${id}`),
  create: (body: Partial<Project>) =>
    request<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<Project>) =>
    request<{ project: Project }>(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  delete: (id: string) => request<{ success: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),
  assignSub: (id: string, subcontractor_id: string) =>
    request<{ success?: boolean; already?: boolean }>(`/api/projects/${id}/subcontractors`, {
      method: 'POST',
      body: JSON.stringify({ subcontractor_id }),
    }),
  unassignSub: (id: string, subId: string) =>
    request<{ success: boolean }>(`/api/projects/${id}/subcontractors/${subId}`, { method: 'DELETE' }),
  createShare: (id: string, body: { expires_in_days?: number; note?: string }) =>
    request<{ share: any; url: string }>(`/api/projects/${id}/share`, { method: 'POST', body: JSON.stringify(body) }),
  shares: (id: string) => request<{ shares: any[] }>(`/api/projects/${id}/shares`),
  deleteShare: (id: string) => request<{ success: boolean }>(`/api/projects/shares/${id}`, { method: 'DELETE' }),
}

// Client public view
export const apiClientView = {
  get: (token: string) => request<ClientSharePayload>(`/api/client/share/${token}`, {}, false),
}

// Sub upload portal (public)
export const apiUploadPortal = {
  validate: (token: string) => request<UploadValidationPayload>(`/api/upload/validate/${token}`, {}, false),
  submit: (token: string, formData: FormData) =>
    request<{ success: boolean; coi: COI }>(`/api/upload/submit/${token}`, { method: 'POST', body: formData }, false),
  myCOIs: (token: string) => request<{ cois: COI[] }>(`/api/upload/my/${token}`, {}, false),
}

// Stats & emails & settings
export const apiStats = { get: () => request<Stats>('/api/stats') }
export const apiEmails = {
  logs: () => request<{ logs: EmailLog[] }>('/api/emails'),
  sendRequest: (body: { subcontractor_id: string; custom_message?: string; expires_in_days?: number }) =>
    request<{ success: boolean; token: string; portalUrl: string }>('/api/emails/send-request', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  sendReminder: (coi_id: string, custom_message?: string) =>
    request<{ success: boolean }>('/api/emails/send-reminder', {
      method: 'POST',
      body: JSON.stringify({ coi_id, custom_message }),
    }),
  batchReminders: () => request<{ success: boolean; sent: number }>('/api/emails/batch-reminders', { method: 'POST' }),
}
export const apiSettings = {
  get: () => request<{ settings: GCSettings }>('/api/settings'),
  update: (body: Partial<GCSettings>) =>
    request<{ settings: GCSettings }>('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
}

// Admin dashboard (role='admin' only)
export const apiAdmin = {
  overview: () => request<import('./types').AdminOverview>('/api/admin/overview'),
  companies: () => request<{ companies: import('./types').AdminCompany[] }>('/api/admin/companies'),
  updatePlan: (id: string, plan: string) =>
    request<{ company: import('./types').AdminCompany }>(`/api/admin/companies/${id}/plan`, {
      method: 'PUT',
      body: JSON.stringify({ plan }),
    }),
  users: () => request<{ users: import('./types').AdminUser[] }>('/api/admin/users'),
  updateRole: (id: string, role: string) =>
    request<{ user: import('./types').AdminUser }>(`/api/admin/users/${id}/role`, {
      method: 'PUT',
      body: JSON.stringify({ role }),
    }),
  deleteCompany: (id: string) => request<{ success: boolean }>(`/api/admin/companies/${id}`, { method: 'DELETE' }),
  deleteUser: (id: string) => request<{ success: boolean }>(`/api/admin/users/${id}`, { method: 'DELETE' }),
  resetDemoData: () => request<{ success: boolean; message: string }>('/api/admin/danger/reset', { method: 'POST' }),
  makeMeAdmin: () => request<{ user: import('./types').User; message: string }>('/api/admin/make-me-admin', { method: 'POST' }),
}

// Subcontractor portal
export const apiSub = {
  my: (expectedToken?: string) => request<import('./types').SubcontractorDashboardData>('/api/sub/my', {}, true, expectedToken),
  quickUpload: (form: FormData, expectedToken?: string) =>
    request<import('./types').COI & { fields_source_tag?: string | null }>('/api/sub/quick-upload', { method: 'POST', body: form }, true, expectedToken),
  updateProfile: (body: Partial<import('./types').Subcontractor>) =>
    request<import('./types').Subcontractor>('/api/sub/profile', { method: 'POST', body: JSON.stringify(body) }),
  publicView: (subId: string) =>
    request<{ subcontractor: import('./types').Subcontractor; coi?: import('./types').COI }>(`/api/sub/public/${subId}`, {}, false),
  joinInfo: (inviteCode: string) => request<import('./types').JoinInfo>(`/api/sub/join-info/${inviteCode}`, {}, false),
  joinIntent: (inviteCode: string, expectedToken: string) =>
    request<{ intent: string }>(`/api/sub/join-intent/${inviteCode}`, { method: 'POST' }, true, expectedToken),
  join: (inviteCode: string, intent: string, expectedToken: string) =>
    request<{ linked: boolean; mode?: string; gc_company_name?: string; subcontractor?: import('./types').Subcontractor }>(`/api/sub/join/${inviteCode}`, {
      method: 'POST', body: JSON.stringify({ intent, consent: true }),
    }, true, expectedToken),
}

// QR connection tokens are private and are sent only to this application's API.
export const apiConnectionQr = {
  create: (consent: true, expectedToken?: string) =>
    request<{ token: string; expiresAt: string }>('/api/connection-qr', {
      method: 'POST', body: JSON.stringify({ consent }),
    }, true, expectedToken),
  redeem: (token: string, expectedToken?: string) =>
    request<{ success: boolean; subcontractor: { id: string; company_name: string } }>('/api/connection-qr/redeem', {
      method: 'POST', body: JSON.stringify({ token }),
    }, true, expectedToken),
  revoke: (token: string, expectedToken?: string) =>
    request<{ success: boolean }>('/api/connection-qr/revoke', {
      method: 'POST', body: JSON.stringify({ token }),
    }, true, expectedToken),
}

// QR onboarding info for GCs
export async function apiQrInvite(expectedToken?: string): Promise<import('./types').QrInviteInfo> {
  return request<import('./types').QrInviteInfo>('/api/settings/qr-invite', {}, true, expectedToken)
}
export async function apiRegenerateQrInvite(): Promise<import('./types').QrInviteInfo> {
  return request<import('./types').QrInviteInfo>('/api/settings/qr-invite/regenerate', { method: 'POST' })
}
// Subcontractor emailing COI to contractors (even those without an account)
export async function apiSendCOIEmail(body: { to_email: string; gc_company_name?: string; message?: string; coi_id?: string }) {
  return request<{ ok: boolean; email_log_id: string; sent_to: string; subject: string; verify_url: string }>('/api/sub/send-coi-email', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
export async function apiSubSentEmails() {
  return request<{ emails: { id: string; to_email: string; subject: string; status: string; sent_at: string }[] }>('/api/sub/sent-emails')
}

// Multi-phone numbers per user (email remains the unique identifier)
export const apiPhones = {
  list: () => request<{ phones: import('./types').UserPhone[] }>('/api/auth/phones'),
  add: (body: { phone: string; label?: string; is_primary?: boolean }) =>
    request<{ phones: import('./types').UserPhone[] }>('/api/auth/phones', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  remove: (id: string) =>
    request<{ phones: import('./types').UserPhone[] }>(`/api/auth/phones/${id}`, { method: 'DELETE' }),
  makePrimary: (id: string) =>
    request<{ phones: import('./types').UserPhone[] }>(`/api/auth/phones/${id}/primary`, { method: 'PATCH' }),
}
