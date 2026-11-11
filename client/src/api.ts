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

const TOKEN_KEY = 'coi_token'
const USER_KEY = 'coi_user'

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

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((options.headers as Record<string, string>) || {}),
  }
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }
  const res = await fetch(path, { ...options, headers })
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try {
      const data = await res.json()
      message = data.error || data.message || message
    } catch {}
    throw new Error(message)
  }
  return res.json()
}

// Auth
export async function apiLogin(email: string, password: string): Promise<{ token: string; user: User }> {
  const data = await request<{ token: string; user: User }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
  setToken(data.token)
  setStoredUser(data.user)
  return data
}

export async function apiRegister(body: { email: string; password: string; name?: string; first_name?: string; last_name?: string; phone?: string; company_name?: string; role?: 'gc' | 'sub' }): Promise<{ token: string; user: User }> {
  const data = await request<{ token: string; user: User }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  setToken(data.token)
  setStoredUser(data.user)
  return data
}

export async function apiMe(): Promise<{ user: User }> {
  const data = await request<{ user: User }>('/api/auth/me')
  setStoredUser(data.user)
  return data
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
  get: (token: string) => request<ClientSharePayload>(`/api/client/share/${token}`),
}

// Sub upload portal (public)
export const apiUploadPortal = {
  validate: (token: string) => request<UploadValidationPayload>(`/api/upload/validate/${token}`),
  submit: (token: string, formData: FormData) =>
    request<{ success: boolean; coi: COI }>(`/api/upload/submit/${token}`, { method: 'POST', body: formData }),
  myCOIs: (token: string) => request<{ cois: COI[] }>(`/api/upload/my/${token}`),
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
  my: () => request<import('./types').SubcontractorDashboardData>('/api/sub/my'),
  quickUpload: (form: FormData) =>
    request<import('./types').COI>('/api/sub/quick-upload', { method: 'POST', body: form }),
  updateProfile: (body: Partial<import('./types').Subcontractor>) =>
    request<import('./types').Subcontractor>('/api/sub/profile', { method: 'POST', body: JSON.stringify(body) }),
  publicView: (subId: string) =>
    request<{ subcontractor: import('./types').Subcontractor; coi?: import('./types').COI }>(`/api/sub/public/${subId}`),
  joinInfo: (inviteCode: string) => request<import('./types').JoinInfo>(`/api/sub/join-info/${inviteCode}`),
  join: (inviteCode: string, body?: { email?: string; password?: string; name?: string; company_name?: string; trade?: string; contact_person?: string; phone?: string }) =>
    request<{ token?: string; user?: import('./types').User; linked: boolean; mode?: string; gc_company_name?: string; subcontractor?: import('./types').Subcontractor }>(`/api/sub/join/${inviteCode}`, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    }),
}

// QR onboarding info for GCs
export async function apiQrInvite(): Promise<import('./types').QrInviteInfo> {
  return request<import('./types').QrInviteInfo>('/api/settings/qr-invite')
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
