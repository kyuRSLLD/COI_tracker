export type ComplianceStatus =
  | 'compliant'
  | 'expiring_soon'
  | 'expired'
  | 'missing'
  | 'pending_review'
  | 'needs_revision'
  | 'rejected'

export interface User {
  id: string
  email: string
  name: string
  first_name?: string | null
  last_name?: string | null
  phone?: string | null
  role: string
  company_name?: string | null
  subcontractor_id?: string | null
  phones?: UserPhone[]
}

export interface Subcontractor {
  id: string
  company_name: string
  trade: string
  contact_person?: string | null
  phone?: string | null
  email?: string | null
  address?: string | null
  notes?: string | null
  status?: string | null
  created_at?: string
  updated_at?: string
  computed_status?: ComplianceStatus
  best_coi?: COI | null
  days_left?: number | null
  coi_count?: number
  cois?: COI[]
  upload_requests?: UploadRequest[]
}

export interface COI {
  id: string
  subcontractor_id?: string
  carrier: string
  am_best_rating?: string | null
  policy_number?: string | null
  effective_date: string
  expiration_date: string
  status: string
  reviewer_notes?: string | null
  review_date?: string | null
  certificate_url?: string | null
  certificate_key?: string | null
  certificate_name?: string | null
  certificate_size?: number | null
  certificate_mime?: string | null
  created_at?: string
  updated_at?: string
  company_name?: string
  trade?: string
  contact_person?: string | null
  coverages?: COICoverage[]
}

export interface COICoverage {
  id?: string
  coi_id?: string
  type: string
  per_occurrence_limit?: string | null
  aggregate_limit?: string | null
  additional_insured: number | boolean
  waiver_of_subrogation: number | boolean
  notes?: string | null
}

export interface Project {
  id: string
  name: string
  code?: string | null
  address?: string | null
  client_name?: string | null
  client_email?: string | null
  start_date?: string | null
  end_date?: string | null
  notes?: string | null
  created_at?: string
  sub_count?: number
  share_count?: number
  scorecard?: Scorecard
  subcontractors?: Subcontractor[]
  shares?: ShareLink[]
}

export interface ShareLink {
  id: string
  project_id: string
  token: string
  expires_at?: string | null
  created_at: string
  access_count?: number
  last_accessed_at?: string | null
  note?: string | null
}

export interface Scorecard {
  score: number
  compliant: number
  expiring: number
  expired: number
  missing: number
  pending: number
  total: number
}

export interface Stats {
  totals: {
    total: number
    compliant: number
    expiring: number
    expired: number
    missing: number
    pending: number
    score: number
  }
  projects_count: number
  share_links_count: number
  trades: Array<{ trade: string; total: number; compliant: number }>
  upcoming: Array<{
    sub_id: string
    company_name: string
    trade: string
    carrier: string
    expiration_date: string
    days_left: number
    status: string
    coi_id: string
    phone?: string | null
    email?: string | null
  }>
}

export interface UploadRequest {
  id: string
  subcontractor_id: string
  token: string
  requested_by_email?: string | null
  message?: string | null
  expires_at?: string | null
  used?: number | boolean
  created_at: string
}

export interface EmailLog {
  id: string
  to_email: string
  subject: string
  body?: string | null
  type?: string | null
  status?: string
  sent_at: string
}

export interface GCSettings {
  id?: string
  company_name?: string | null
  subcontractor_id?: string | null
  license_number?: string | null
  address?: string | null
  phone?: string | null
  email?: string | null
  logo_url?: string | null
  additional_insured_wording?: string | null
  required_gl_limit?: string | null
  required_auto_limit?: string | null
  required_wc_limit?: string | null
  required_umbrella_limit?: string | null
  expiration_warning_days: number
}

export interface ClientSharePayload {
  project: {
    id: string
    name: string
    code?: string | null
    address?: string | null
    client_name?: string | null
    start_date?: string | null
    end_date?: string | null
  }
  contractor: {
    company_name: string
    license_number?: string | null
    phone?: string | null
    email?: string | null
    address?: string | null
    logo_url?: string | null
  }
  scorecard: Scorecard
  subcontractors: Array<Subcontractor & { cois: COI[] }>
  share: { token: string; expires_at?: string | null; created_at: string }
  generated_at: string
}

export interface UploadValidationPayload {
  subcontractor: {
    id: string
    company_name: string
    trade: string
    contact_person?: string | null
    phone?: string | null
    email?: string | null
    address?: string | null
  }
  gc: GCSettings
  request: { token: string; requested_by_email?: string | null; message?: string | null; used: boolean; created_at: string }
}

export interface AdminOverview {
  users: { total: number; new_this_month: number; admins: number; gcs: number }
  revenue: {
    mrr: number
    arr: number
    paying_subscribers: number
    arpu: number
    plan_breakdown: Array<{ plan: string; count: number; mrr: number }>
    available_plans: Array<{ plan: string; price: number }>
  }
  platform: {
    companies: number
    subcontractors: number
    cois: number
    client_share_links: number
    pending_reviews: number
    verified_cois: number
  }
  growth: Array<{ month: string; new_users: number }>
}

export interface AdminCompany {
  id: string
  name: string
  plan: string
  mrr: number
  status: string
  owner_user_id?: string | null
  owner_name?: string | null
  owner_email?: string | null
  subcontractor_count: number
  project_count: number
  share_count: number
  created_at: string
}

export interface AdminUser {
  id: string
  email: string
  name: string
  company_name?: string | null
  subcontractor_id?: string | null
  role: string
  created_at: string
  company_plan?: string | null
  company_mrr?: number | null
}

export interface SubcontractorDashboardData {
  subcontractor: Subcontractor
  cois: COI[]
  requests: Array<{
    id: string
    subcontractor_id: string
    token: string
    requested_by_email?: string | null
    message?: string | null
    gc_company_name?: string | null
    gc_phone?: string | null
    expires_at?: string | null
    used: number
    created_at: string
  }>
  connected_gcs: Array<{ company_name: string; email?: string | null; phone?: string | null }>
  public_share_url: string
}

export interface QrInviteInfo {
  invite_code: string
  invite_url: string
  company_name: string
}

export interface JoinInfo {
  valid: boolean
  invite_code: string
  gc: {
    company_name: string
    email?: string | null
    phone?: string | null
    logo_url?: string | null
  }
}

export interface TwoFactorState {
  enabled: boolean
  method?: 'authenticator' | 'sms'
  phone_masked?: string
}

export interface UserPhone {
  id: string
  phone: string
  label?: string | null
  is_primary?: number | boolean
  created_at: string
}
