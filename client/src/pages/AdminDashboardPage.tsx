import { Button } from '../components/Button'
import { StaffSidebar } from '../components/StaffSidebar'
import { AgentControlPanel } from '../components/AgentControlPanel'
import { useEffect, useState, useMemo, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { apiAdmin, apiAdminArticles, apiAdminEmail, apiMe, signOut, apiCoiFields, getToken, ApiError } from '../api'
import type { AdminOverview, AdminCompany, AdminUser, User, AdminCoiValidationItem, AdminCoiCounts, Article, SafeEmailSettings, EmailDeliveryStatus, EmailProvider } from '../types'
import { RefreshCw, Search, Trash2, RotateCcw, CheckCircle2, Sparkles, ExternalLink, ChevronDown, ChevronUp, AlertCircle, FileText, MoreHorizontal, Download, KeyRound, Eye, EyeOff, Check, Copy, BookOpen, Plus, Edit3, Globe, FileEdit, Send, Mail, AlertTriangle } from 'lucide-react'
import { formatDisplayDate, isExpiredDate } from '../lib/date'
import { formatAmount } from '../lib/currency'
import { coiExpiryAllExpired, isPartiallyExpired } from '../lib/coiExpiry'
import { CoiFieldsReview } from '../components/CoiFieldsReview'
import { editorDetails, type FieldsDetails } from '../lib/coiEditorDetails'

type GrowthRange = '7d' | '30d' | '90d' | '12m'

const GC_PLANS: Array<{ plan: string; price: number }> = [
  { plan: 'Free Demo', price: 0 },
  { plan: 'General Contractor', price: 10 },
  { plan: 'Pro GC', price: 29 },
]

function queueResult(item: AdminCoiValidationItem): { label: string; chip: string } {
  if (item.status === 'compliant') return { label: 'Compliant', chip: 'badge-pass' }
  if (item.status === 'rejected') return { label: 'Rejected', chip: 'badge-fail' }
  if (item.status === 'needs_revision') return { label: 'Needs revision', chip: 'badge-warn' }
  if ((item.days_left ?? 0) < 0) return { label: 'Expired', chip: 'badge-fail' }
  return { label: 'Pending', chip: 'badge-info' }
}
function shortPolicyLabel(p: string): string {
  if (!p) return ''
  const t = p.toLowerCase()
  if (t.includes('general')) return 'GL'
  if (t.includes('workers')) return 'WC'
  if (t.includes('auto')) return 'Auto'
  if (t.includes('umbrella') || t.includes('excess')) return 'Umbrella'
  if (t.includes('pollution')) return 'Pollution'
  return p.slice(0, 10)
}
function policyResults(item: AdminCoiValidationItem): Array<{ policy: string; label: string; chip: string }> {
  const policies: any[] = Array.isArray(item.review_details?.policies) ? item.review_details.policies : []
  if (policies.length === 0) {
    const r = queueResult(item)
    return [{ policy: '', label: r.label, chip: r.chip }]
  }
  return policies.map((p, i) => {
    const name = (p.type || p.policyType || `Policy ${i + 1}`).trim()
    const expDate = p.expirationDate || p.expiration_date
    const isPolicyExpired = isExpiredDate(expDate)
    if (isPolicyExpired) return { policy: name, label: 'Expired', chip: 'badge-fail' }
    if (item.status === 'compliant') return { policy: name, label: 'Compliant', chip: 'badge-pass' }
    if (item.status === 'rejected') return { policy: name, label: 'Rejected', chip: 'badge-fail' }
    if (item.status === 'needs_revision') return { policy: name, label: 'Needs revision', chip: 'badge-warn' }
    return { policy: name, label: 'Pending', chip: 'badge-info' }
  })
}
type FieldsReviewModalState = {
  coiId: string
  coiCompany: string
  hasFile: boolean
  loading: boolean
  details: FieldsDetails | null
  wasEmpty: boolean
  sourceTag: string
  reviewRevision: string | null
  editable: boolean
  saving: boolean
  extracting: boolean
  conflicted: boolean
  error: string | null
}

export function AdminDashboardPage() {
  const navigate = useNavigate()
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [companies, setCompanies] = useState<AdminCompany[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [me, setMe] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [companySearch, setCompanySearch] = useState('')
  const [userSearch, setUserSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<'all' | 'admin' | 'gc' | 'pro_gc' | 'sub'>('all')
  const [savingPlanId, setSavingPlanId] = useState<string | null>(null)
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null)
  const [planModal, setPlanModal] = useState<{ open: boolean; company: AdminCompany | null; newPlan: string; reason: string }>({
    open: false,
    company: null,
    newPlan: 'General Contractor',
    reason: '',
  })
  const [roleModal, setRoleModal] = useState<{ open: boolean; user: AdminUser | null; newRole: 'admin' | 'gc' | 'pro_gc' | 'sub' }>({
    open: false,
    user: null,
    newRole: 'gc',
  })
  const [resetModalOpen, setResetModalOpen] = useState(false)
  const [pwResetModal, setPwResetModal] = useState<{ open: boolean; user: AdminUser | null }>({ open: false, user: null })
  const [pwResetValue, setPwResetValue] = useState('')
  const [pwResetShow, setPwResetShow] = useState(false)
  const [pwResetSaving, setPwResetSaving] = useState(false)
  const [pwResetMsg, setPwResetMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [copied, setCopied] = useState(false)
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const [excludeTest, setExcludeTest] = useState(false)
  const [testFlagLoading, setTestFlagLoading] = useState<string | null>(null)
  const [growthRange, setGrowthRange] = useState<GrowthRange>('30d')
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date())

  const [coiQueue, setCoiQueue] = useState<AdminCoiValidationItem[]>([])
  const [coiCounts, setCoiCounts] = useState<AdminCoiCounts | null>(null)
  const [coiLoading, setCoiLoading] = useState(false)
  const [coiError, setCoiError] = useState<string | null>(null)
  const [coiFilter, setCoiFilter] = useState<'pending' | 'ai_pending' | 'compliant' | 'needs_revision' | 'rejected' | 'all'>('pending')
  const [coiSearch, setCoiSearch] = useState('')
  const [selectedCoiIds, setSelectedCoiIds] = useState<Set<string>>(new Set())
  const [coiBusy, setCoiBusy] = useState<Record<string, string>>({})
  const [expandedCoiId, setExpandedCoiId] = useState<string | null>(null)
  const [articles, setArticles] = useState<Article[]>([])
  const [articlesLoading, setArticlesLoading] = useState(false)
  const [fieldsReview, setFieldsReview] = useState<FieldsReviewModalState | null>(null)
  const [articleFilter, setArticleFilter] = useState<'all' | 'published' | 'draft'>('all')
  const [articleSearch, setArticleSearch] = useState('')
  const [articleModal, setArticleModal] = useState<{ open: boolean; mode: 'create' | 'edit'; id?: string }>({ open: false, mode: 'create' })
  const [artTitle, setArtTitle] = useState('')
  const [artSlug, setArtSlug] = useState('')
  const [artTag, setArtTag] = useState('')
  const [artReadingTime, setArtReadingTime] = useState(6)
  const [artStatus, setArtStatus] = useState<'published' | 'draft'>('published')
  const [artPosition, setArtPosition] = useState(0)
  const [artOgImage, setArtOgImage] = useState('')
  const [artDescription, setArtDescription] = useState('')
  const [artBodyHtml, setArtBodyHtml] = useState('')
  const [artPreview, setArtPreview] = useState(false)
  const [slugTouched, setSlugTouched] = useState(false)
  const [articleSaving, setArticleSaving] = useState(false)
  const [articleError, setArticleError] = useState<string | null>(null)
  const [articleNotice, setArticleNotice] = useState<string | null>(null)
  const [articleDeleteModal, setArticleDeleteModal] = useState<{ open: boolean; article: Article | null }>({ open: false, article: null })
  const [articleDeleting, setArticleDeleting] = useState(false)
  const [emailSettings, setEmailSettings] = useState<SafeEmailSettings | null>(null)
  const [emailStatus, setEmailStatus] = useState<EmailDeliveryStatus | null>(null)
  const [emailLoading, setEmailLoading] = useState(false)
  const [emailLoadError, setEmailLoadError] = useState<string | null>(null)
  const [emailFromEmail, setEmailFromEmail] = useState('backoffice@capitalcrestoration.com')
  const [emailFromName, setEmailFromName] = useState('Capital Restoration')
  const [emailReplyTo, setEmailReplyTo] = useState('')
  const [emailProvider, setEmailProvider] = useState<EmailProvider>('gmail')
  const [emailSmtpHost, setEmailSmtpHost] = useState('smtp.gmail.com')
  const [emailSmtpPort, setEmailSmtpPort] = useState(587)
  const [emailSmtpSecure, setEmailSmtpSecure] = useState(false)
  const [emailSmtpUser, setEmailSmtpUser] = useState('')
  const [emailSmtpPass, setEmailSmtpPass] = useState('')
  const [emailSendingEnabled, setEmailSendingEnabled] = useState(false)
  const [emailSaving, setEmailSaving] = useState(false)
  const [emailSaveMsg, setEmailSaveMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [testTo, setTestTo] = useState('')
  const [testBusy, setTestBusy] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; status: string; error?: string } | null>(null)
  const [guideOpen, setGuideOpen] = useState(false)

  const notify = (msg: string) => {
    setStatusMsg(msg)
    setTimeout(() => setStatusMsg(null), 3500)
  }

  const load = async (excludeTestOverride?: boolean, rangeOverride?: GrowthRange) => {
    try {
      setLoading(true)
      setError(null)
      const xt = excludeTestOverride ?? excludeTest
      const rg = rangeOverride ?? growthRange
      const [ov, comps, usrs, arts, meData, emailData] = await Promise.all([
        apiAdmin.overview({ exclude_test: xt, range: rg }),
        apiAdmin.companies(),
        apiAdmin.users(),
        apiAdminArticles.list().then((r) => r.articles).catch(() => [] as Article[]),
        apiMe().catch(() => null),
        apiAdminEmail.get().catch(() => null),
      ])
      setOverview(ov)
      setCompanies(comps.companies)
      setUsers(usrs.users)
      setArticles(arts)
      if (meData?.user) setMe(meData.user)
      if (emailData) {
        setEmailSettings(emailData.settings)
        setEmailStatus(emailData.status)
        setEmailFromEmail(emailData.settings.from_email || '')
        setEmailFromName(emailData.settings.from_name || '')
        setEmailReplyTo(emailData.settings.reply_to || '')
        setEmailProvider(emailData.settings.provider)
        setEmailSmtpHost(emailData.settings.smtp_host || 'smtp.gmail.com')
        setEmailSmtpPort(emailData.settings.smtp_port ?? 587)
        setEmailSmtpSecure(emailData.settings.smtp_secure === 1)
        setEmailSmtpUser(emailData.settings.smtp_user || '')
        setEmailSendingEnabled(emailData.settings.sending_enabled === 1)
      }
      setLastRefreshed(new Date())
    } catch (err: any) {
      setError(err?.message || 'Failed to load dashboard')
    } finally {
      setLoading(false)
    }
  }

  const loadCoiQueue = useCallback(async (filter = coiFilter, search = coiSearch) => {
    try {
      setCoiLoading(true)
      setCoiError(null)
      const res = await apiAdmin.coiQueue({ status: filter, search, limit: 100 })
      setCoiQueue(res.items)
      setCoiCounts(res.counts)
    } catch (err: any) {
      setCoiError(err?.message || 'Failed to load validation queue')
    } finally {
      setCoiLoading(false)
    }
  }, [coiFilter, coiSearch])

  const loadArticles = async () => {
    try {
      setArticlesLoading(true)
      const res = await apiAdminArticles.list()
      setArticles(res.articles || [])
    } catch (err: any) {
      notify(err?.message || 'Failed to load articles')
    } finally {
      setArticlesLoading(false)
    }
  }

  const openArticleCreate = () => {
    const nextPos = articles.length ? Math.max(...articles.map((a) => a.position)) + 1 : 0
    setArticleModal({ open: true, mode: 'create' })
    setArtTitle('')
    setArtSlug('')
    setArtTag('')
    setArtReadingTime(6)
    setArtStatus('published')
    setArtPosition(nextPos)
    setArtOgImage('')
    setArtDescription('')
    setArtBodyHtml('')
    setArtPreview(false)
    setSlugTouched(false)
    setArticleError(null)
  }

  const openArticleEdit = async (a: Article) => {
    setArticleModal({ open: true, mode: 'edit', id: a.id })
    setArtTitle(a.title)
    setArtSlug(a.slug)
    setArtTag(a.tag)
    setArtReadingTime(a.reading_time_min)
    setArtStatus(a.status)
    setArtPosition(a.position)
    setArtOgImage(a.og_image_url || '')
    setArtDescription(a.description)
    setArtBodyHtml(a.body_html || '')
    setArtPreview(false)
    setSlugTouched(true)
    setArticleError(null)
    try {
      const full = await apiAdminArticles.get(a.id)
      if (full.article) {
        setArtBodyHtml(full.article.body_html || '')
        setArtDescription(full.article.description || a.description)
        setArtOgImage(full.article.og_image_url || '')
      }
    } catch {
      /* fallback to row data */
    }
  }

  const saveArticle = async () => {
    setArticleError(null)
    const slugClean = artSlug.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    if (!artTitle.trim()) return setArticleError('Title is required')
    if (!slugClean) return setArticleError('Valid slug is required (kebab-case)')
    if (!artDescription.trim()) return setArticleError('Description is required')
    if (!artTag.trim()) return setArticleError('Category / tag is required')
    if (!artBodyHtml.trim()) return setArticleError('Body HTML is required')
    try {
      setArticleSaving(true)
      const payload = {
        title: artTitle.trim(),
        slug: slugClean,
        description: artDescription.trim(),
        tag: artTag.trim(),
        reading_time_min: Math.max(1, Math.min(60, artReadingTime)),
        body_html: artBodyHtml,
        og_image_url: artOgImage.trim() || null,
        status: artStatus,
        position: artPosition,
      }
      if (articleModal.mode === 'create') {
        await apiAdminArticles.create(payload)
        setArticleNotice('Article created and published!')
      } else if (articleModal.id) {
        await apiAdminArticles.update(articleModal.id, payload)
        setArticleNotice('Article updated')
      }
      await loadArticles()
      setArticleModal({ open: false, mode: 'create' })
      setTimeout(() => setArticleNotice(null), 4000)
    } catch (err: any) {
      setArticleError(err?.message || 'Save failed')
    } finally {
      setArticleSaving(false)
    }
  }

  const deleteArticle = async () => {
    const a = articleDeleteModal.article
    if (!a) return
    try {
      setArticleDeleting(true)
      await apiAdminArticles.remove(a.id)
      setArticleDeleteModal({ open: false, article: null })
      notify(`Deleted "${a.title}"`)
      await loadArticles()
    } catch (err: any) {
      notify(err?.message || 'Delete failed')
    } finally {
      setArticleDeleting(false)
    }
  }

  const loadEmailSettings = useCallback(async () => {
    try {
      setEmailLoading(true)
      setEmailLoadError(null)
      const res = await apiAdminEmail.get()
      setEmailSettings(res.settings)
      setEmailStatus(res.status)
      setEmailFromEmail(res.settings.from_email || '')
      setEmailFromName(res.settings.from_name || '')
      setEmailReplyTo(res.settings.reply_to || '')
      setEmailProvider(res.settings.provider)
      setEmailSmtpHost(res.settings.smtp_host || 'smtp.gmail.com')
      setEmailSmtpPort(res.settings.smtp_port ?? 587)
      setEmailSmtpSecure(res.settings.smtp_secure === 1)
      setEmailSmtpUser(res.settings.smtp_user || '')
      setEmailSendingEnabled(res.settings.sending_enabled === 1)
    } catch (err: any) {
      setEmailLoadError(err?.message || 'Failed to load email settings')
    } finally {
      setEmailLoading(false)
    }
  }, [])

  const saveEmailSettingsForm = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      setEmailSaving(true)
      setEmailSaveMsg(null)
      const res = await apiAdminEmail.update({
        provider: emailProvider,
        from_name: emailFromName.trim() || null,
        from_email: emailFromEmail.trim() || null,
        reply_to: emailReplyTo.trim() || null,
        smtp_host: emailProvider === 'gmail' ? 'smtp.gmail.com' : emailSmtpHost.trim() || null,
        smtp_port: emailProvider === 'gmail' ? 587 : emailSmtpPort,
        smtp_secure: emailSmtpSecure ? 1 : 0,
        smtp_user: (emailProvider === 'gmail' ? emailFromEmail.trim() : emailSmtpUser.trim()) || null,
        ...(emailSmtpPass ? { smtp_pass: emailSmtpPass } : {}),
        sending_enabled: emailSendingEnabled ? 1 : 0,
      })
      setEmailSettings(res.settings)
      setEmailStatus(res.status)
      setEmailSmtpPass('')
      setEmailSaveMsg({ text: 'Email delivery settings saved', ok: true })
      setTimeout(() => setEmailSaveMsg(null), 4000)
    } catch (err: any) {
      setEmailSaveMsg({ text: err?.message || 'Save failed', ok: false })
    } finally {
      setEmailSaving(false)
    }
  }

  const sendEmailTest = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!testTo.trim()) return
    try {
      setTestBusy(true)
      setTestResult(null)
      const res = await apiAdminEmail.test(testTo.trim())
      setTestResult({ ok: res.ok, status: res.status, error: res.error })
      await loadEmailSettings()
    } catch (err: any) {
      setTestResult({ ok: false, status: 'failed', error: err?.message || 'Test send failed' })
    } finally {
      setTestBusy(false)
    }
  }

  const filteredArticles = useMemo(() => {
    const q = articleSearch.trim().toLowerCase()
    return articles.filter((a) => {
      const matchStatus = articleFilter === 'all' ? true : a.status === articleFilter
      if (!matchStatus) return false
      if (!q) return true
      return a.title?.toLowerCase().includes(q) || a.slug?.toLowerCase().includes(q) || a.tag?.toLowerCase().includes(q)
    })
  }, [articles, articleSearch, articleFilter])

  const tagSuggestions = ["Workers' Comp & Audits", 'ACORD 25 & COI Review', 'Endorsements & Coverage', 'Waivers & Risk Transfer']

  useEffect(() => { load() }, [])

  useEffect(() => {
    const t = setTimeout(() => { loadCoiQueue(coiFilter, coiSearch) }, 300)
    return () => clearTimeout(t)
  }, [coiSearch, coiFilter, loadCoiQueue])

  const setBusy = (id: string, action: string | null) =>
    setCoiBusy((prev) => (action ? { ...prev, [id]: action } : (({ [id]: _, ...rest }) => rest)(prev)))

  const handleValidate = async (id: string) => {
    try {
      setBusy(id, 'validating')
      await apiAdmin.validateCoi(id)
      notify('COI validated — marked compliant')
      setSelectedCoiIds((prev) => { const s = new Set(prev); s.delete(id); return s })
      await Promise.all([loadCoiQueue(coiFilter, coiSearch), load()])
    } catch (err: any) {
      notify(err?.message || 'Validation failed')
    } finally {
      setBusy(id, null)
    }
  }

  const handleExtract = async (id: string) => {
    try {
      setBusy(id, 'extracting')
      await apiAdmin.extractCoi(id)
      notify('AI validation completed — fields auto-filled (pending verification)')
      await Promise.all([loadCoiQueue(coiFilter, coiSearch), load()])
    } catch (err: any) {
      notify(err?.message || 'AI validation failed')
    } finally {
      setBusy(id, null)
    }
  }

  const openFieldsReviewForCoi = async (item: AdminCoiValidationItem) => {
    const token = getToken()
    if (!token) return
    setFieldsReview({
      coiId: item.id, coiCompany: item.sub_company_name || 'Certificate', hasFile: item.has_file,
      loading: true, details: null, wasEmpty: false, sourceTag: '', reviewRevision: null,
      editable: true, saving: false, extracting: false, conflicted: false, error: null,
    })
    try {
      const result = await apiCoiFields.get(item.id, token)
      setFieldsReview((c) => c && c.coiId === item.id ? {
        ...c, loading: false,
        details: editorDetails(result.details || null),
        wasEmpty: result.details === null,
        sourceTag: result.sourceTag,
        reviewRevision: result.reviewRevision,
        editable: result.editable !== false,
      } : c)
    } catch (err: unknown) {
      setFieldsReview((c) => c && c.coiId === item.id ? {
        ...c, loading: false, details: editorDetails(null), wasEmpty: true,
        error: err instanceof Error ? err.message : 'Unable to load field review.',
      } : c)
    }
  }
  const closeFieldsReview = () => setFieldsReview(null)
  const saveFieldsReview = async () => {
    const r = fieldsReview
    const token = getToken()
    if (!r || !r.details || !token || r.saving || !r.sourceTag || !r.reviewRevision) return
    setFieldsReview((c) => c && { ...c, saving: true, error: null })
    try {
      await apiCoiFields.save(r.coiId, { sourceTag: r.sourceTag, reviewRevision: r.reviewRevision, details: r.details }, token)
      notify('Document fields saved — review updated')
      setFieldsReview(null)
      await Promise.all([loadCoiQueue(coiFilter, coiSearch), load()])
    } catch (err: unknown) {
      const msg = err instanceof ApiError && err.status === 409
        ? 'This review was modified elsewhere. Close and reopen to reload.'
        : err instanceof Error ? err.message : 'Unable to save field review.'
      setFieldsReview((c) => c && { ...c, saving: false, error: msg })
    }
  }
  const runExtractInReview = async () => {
    const r = fieldsReview
    if (!r || r.extracting || r.saving) return
    setFieldsReview((c) => c && { ...c, extracting: true, error: null })
    try {
      const res = await apiAdmin.extractCoi(r.coiId)
      const refreshed = getToken() ? await apiCoiFields.get(r.coiId, getToken()!).catch(() => null) : null
      setFieldsReview((c) => c && {
        ...c, extracting: false,
        details: editorDetails((refreshed?.details || (res?.fields as any) || null)),
        wasEmpty: false,
        sourceTag: refreshed?.sourceTag || c.sourceTag,
        reviewRevision: refreshed?.reviewRevision || c.reviewRevision,
      })
      notify('AI validation completed — fields auto-filled (pending verification)')
      void Promise.all([loadCoiQueue(coiFilter, coiSearch), load()])
    } catch (err: any) {
      setFieldsReview((c) => c && { ...c, extracting: false, error: err?.message || 'AI validation failed' })
    }
  }

  const handleSetStatus = async (id: string, status: string) => {
    try {
      setBusy(id, 'saving')
      await apiAdmin.setCoiStatus(id, status)
      notify(`Status updated to ${status}`)
      await Promise.all([loadCoiQueue(coiFilter, coiSearch), load()])
    } catch (err: any) {
      notify(err?.message || 'Update failed')
    } finally {
      setBusy(id, null)
    }
  }

  const handleViewCert = async (id: string) => {
    try {
      const { url } = await apiAdmin.coiCertificateUrl(id)
      if (url) window.open(url, '_blank')
    } catch (err: any) {
      notify(err?.message || 'Could not open certificate')
    }
  }

  const handleDeleteCoi = async (id: string, label?: string | null) => {
    const name = label ? `certificate for ${label}` : 'this certificate'
    if (!window.confirm(`Delete ${name}? This cannot be undone.`)) return
    try {
      setBusy(id, 'deleting')
      await apiAdmin.deleteCoi(id)
      notify('Certificate deleted')
      setSelectedCoiIds((prev) => { const s = new Set(prev); s.delete(id); return s })
      await Promise.all([loadCoiQueue(coiFilter, coiSearch), load()])
    } catch (err: any) {
      notify(err?.message || 'Delete failed')
    } finally {
      setBusy(id, null)
    }
  }

  const handleBatchValidate = async () => {
    const ids = Array.from(selectedCoiIds)
    if (!ids.length) return
    try {
      setCoiLoading(true)
      const res = await apiAdmin.batchValidateCois(ids)
      notify(`${res.validated} COIs validated and marked compliant`)
      setSelectedCoiIds(new Set())
      await Promise.all([loadCoiQueue(coiFilter, coiSearch), load()])
    } catch (err: any) {
      notify(err?.message || 'Batch validation failed')
    } finally {
      setCoiLoading(false)
    }
  }

  const handleBatchExtract = async () => {
    const ids = Array.from(selectedCoiIds)
    if (!ids.length) return
    try {
      setCoiLoading(true)
      const res = await apiAdmin.batchExtractCois(ids)
      const ok = res.results.filter((r) => r.ok).length
      notify(`AI validation finished: ${ok}/${res.results.length} succeeded`)
      setSelectedCoiIds(new Set())
      await Promise.all([loadCoiQueue(coiFilter, coiSearch), load()])
    } catch (err: any) {
      notify(err?.message || 'Batch AI validation failed')
    } finally {
      setCoiLoading(false)
    }
  }

  const openPlanModal = (c: AdminCompany) => {
    setPlanModal({ open: true, company: c, newPlan: c.plan || 'General Contractor', reason: '' })
  }

  const confirmPlanChange = async () => {
    if (!planModal.company) return
    try {
      setSavingPlanId(planModal.company.id)
      await apiAdmin.updatePlan(planModal.company.id, planModal.newPlan, planModal.reason)
      notify('Plan updated — change logged')
      setPlanModal({ open: false, company: null, newPlan: '', reason: '' })
      await load()
    } catch (err: any) {
      notify(err?.message || 'Plan update failed')
    } finally {
      setSavingPlanId(null)
    }
  }

  const handleToggleTest = async (c: AdminCompany) => {
    try {
      setTestFlagLoading(c.id)
      await apiAdmin.toggleTestFlag(c.id, !c.is_test)
      notify(c.is_test ? 'Unmarked as test' : 'Marked as test/demo')
      await load()
    } catch (err: any) {
      notify(err?.message || 'Update failed')
    } finally {
      setTestFlagLoading(null)
    }
  }

  const handleRoleChange = async (id: string, role: string) => {
    try {
      setSavingRoleId(id)
      await apiAdmin.updateRole(id, role)
      notify('Role updated')
      await load()
    } catch (err: any) {
      notify(err?.message || 'Role update failed')
    } finally {
      setSavingRoleId(null)
    }
  }

  const genTempPassword = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#'
    let out = ''
    const arr = new Uint8Array(12)
    crypto.getRandomValues(arr)
    for (const b of arr) out += chars[b % chars.length]
    setPwResetValue(out)
  }
  const openPwReset = (u: AdminUser) => {
    setPwResetModal({ open: true, user: u })
    setPwResetShow(true)
    setPwResetMsg(null)
    setCopied(false)
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
    let out = ''
    const arr = new Uint8Array(12)
    crypto.getRandomValues(arr)
    for (const b of arr) out += chars[b % chars.length]
    setPwResetValue(out)
  }
  const copyTempPw = async () => {
    try { await navigator.clipboard?.writeText(pwResetValue) } catch {}
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  const confirmPwReset = async () => {
    if (!pwResetModal.user) return
    setPwResetMsg(null)
    if (!pwResetValue || pwResetValue.length < 8) return setPwResetMsg({ text: 'Password must be at least 8 characters', ok: false })
    try {
      setPwResetSaving(true)
      const res = await apiAdmin.resetUserPassword(pwResetModal.user.id, pwResetValue)
      setPwResetMsg({ text: res.message || 'Password updated', ok: true })
      setTimeout(() => { setPwResetModal({ open: false, user: null }) }, 1500)
    } catch (err: any) {
      setPwResetMsg({ text: err.message || 'Update failed', ok: false })
    } finally {
      setPwResetSaving(false)
    }
  }
  const confirmRoleChange = async () => {
    if (!roleModal.user) return
    await handleRoleChange(roleModal.user.id, roleModal.newRole)
    setRoleModal({ open: false, user: null, newRole: 'gc' })
  }

  const handleDeleteCompany = async (c: AdminCompany) => {
    if (!confirm(`Delete "${c.name}"? This removes the company and its record.`)) return
    try {
      await apiAdmin.deleteCompany(c.id)
      notify(`Deleted ${c.name}`)
      await load()
    } catch (err: any) {
      notify(err?.message || 'Delete failed')
    }
  }

  const handleDeleteUser = async (u: AdminUser) => {
    if (me && u.id === me.id) {
      notify('You cannot delete your own account')
      return
    }
    if (!confirm(`Delete user "${u.name || u.email}"?`)) return
    try {
      await apiAdmin.deleteUser(u.id)
      notify(`Deleted ${u.email}`)
      await load()
    } catch (err: any) {
      notify(err?.message || 'Delete failed')
    }
  }

  const handleResetData = async () => {
    try {
      await apiAdmin.resetDemoData()
      notify('Reset to fresh demo data')
      setResetModalOpen(false)
      await load()
    } catch (err: any) {
      notify(err?.message || 'Reset failed')
    }
  }

  const handleSignOut = () => signOut('/login')

  const filteredCompanies = useMemo(() => {
    const q = companySearch.trim().toLowerCase()
    if (!q) return companies
    return companies.filter(
      (c) =>
        c.name?.toLowerCase().includes(q) ||
        c.plan?.toLowerCase().includes(q) ||
        c.owner_name?.toLowerCase().includes(q) ||
        c.owner_email?.toLowerCase().includes(q)
    )
  }, [companies, companySearch])

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase()
    return users.filter((u) => {
      const matchRole = roleFilter === 'all' ? true : u.role === roleFilter
      if (!matchRole) return false
      if (!q) return true
      return (
        u.email?.toLowerCase().includes(q) ||
        u.name?.toLowerCase().includes(q) ||
        u.company_name?.toLowerCase().includes(q)
      )
    })
  }, [users, userSearch, roleFilter])

  const plans = useMemo(() => {
    const list = [...(overview?.revenue.plan_breakdown || [])]
    if (!list.some((pl) => pl.plan === 'Enterprise')) list.push({ plan: 'Enterprise', count: 0, mrr: 0 })
    return list
  }, [overview])

  const totalSignups = overview?.users.total ?? 0
  const paidSubs = overview?.revenue.paying_subscribers ?? 0
  const paidPct = totalSignups ? Math.round((paidSubs / totalSignups) * 100) : 0
  const nonTestCompanies = companies.filter((c) => !excludeTest || !c.is_test)
  const totalComp = nonTestCompanies.length || 1
  const withSubs = nonTestCompanies.filter((c) => c.subcontractor_count > 0).length
  const withSubsPct = totalComp ? Math.round((withSubs / totalComp) * 100) : 0
  const withCompliant = overview?.platform.verified_cois ?? 0
  const withCompliantPct = totalComp ? Math.round((Math.min(withCompliant, totalComp) / totalComp) * 100) : 0

  const growthEntries = overview?.growth || []
  const maxGrowth = Math.max(1, ...growthEntries.map((g) => g.new_users))

  const reviewNext = () => {
    const first = coiQueue.find((c) => c.status === 'pending_review' || c.ai_pending) || coiQueue[0]
    if (first) navigate(`/staff/coi/${first.id}`)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t as any).isContentEditable)) return
      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault()
        const ids = coiQueue.map((c) => c.id)
        if (!ids.length) return
        const idx = ids.indexOf(expandedCoiId || '')
        const next = ids[Math.min(idx + 1, ids.length - 1)]
        setExpandedCoiId(next)
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault()
        const ids = coiQueue.map((c) => c.id)
        if (!ids.length) return
        const idx = ids.indexOf(expandedCoiId || '')
        const prev = ids[Math.max(idx - 1, 0)]
        setExpandedCoiId(prev)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [coiQueue, expandedCoiId])

  const statusBadge = (s?: string) =>
    s === 'compliant' ? 'badge-pass' : s === 'rejected' ? 'badge-fail' : 'badge-warn'

  const roleLabel = (r?: string) =>
    r === 'admin' ? 'Admin' : r === 'pro_gc' ? 'Pro GC' : r === 'sub' ? 'Sub C' : 'GC'


  const exportCompaniesCsv = () => {
    const header = ['Company', 'Owner', 'Owner Email', 'Plan', 'MRR', 'Connected Subs', 'Connected COIs', 'Projects', 'Joined', 'Test'].join(',')
    const rows = filteredCompanies.map((c) => {
      return [c.name, c.owner_name || '', c.owner_email || '', c.plan, c.mrr || 0, c.connected_subcontractors ?? c.subcontractor_count ?? 0, c.connected_cois ?? 0, c.project_count ?? 0, (c.created_at || '').slice(0, 10), c.is_test ? 'yes' : 'no']
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    })
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `companies-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
  }

  return (
    <StaffSidebar user={me} onSignOut={handleSignOut} pendingQueueCount={coiCounts?.pending}>
      <div className="max-w-7xl mx-auto space-y-5">
        {/* Header greeting & action menu */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-[#CFDAF3]">
          <div>
            <h1 className="text-2xl font-bold tracking-tight" style={{ color: 'var(--text)' }}>
              Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">
              {overview?.platform.companies ?? 0} companies · {coiCounts?.pending ?? overview?.platform.pending_reviews ?? 0} certificates waiting
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-slate-400 font-mono text-[11px] hidden sm:inline">
              updated {lastRefreshed.toLocaleTimeString()}
            </span>
            <button
              type="button"
              onClick={() => { const next = !excludeTest; setExcludeTest(next); void load(next) }}
              className={`min-h-[40px] px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 transition ${
                excludeTest ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
            >
              <span>{excludeTest ? '✓' : ''}</span> Exclude test accounts
            </button>
            <div className="relative">
              <button
                type="button"
                onClick={() => setActionMenuOpen((v) => !v)}
                aria-label="Staff actions"
                className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 text-xs font-bold inline-flex items-center gap-1"
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>
              {actionMenuOpen && (
                <div
                  className="absolute right-0 mt-1 w-52 bg-white rounded-lg shadow-lg border border-slate-200 py-1 text-xs z-30"
                  onClick={() => setActionMenuOpen(false)}
                >
                  <button
                    type="button"
                    onClick={() => { void load(); void loadCoiQueue() }}
                    disabled={loading}
                    className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center gap-2"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh now
                  </button>
                  <button
                    type="button"
                    onClick={() => setResetModalOpen(true)}
                    className="w-full text-left px-3 py-2 hover:bg-rose-50 text-rose-700 flex items-center gap-2"
                  >
                    <RotateCcw className="w-3.5 h-3.5" /> Reset demo data…
                  </button>
                  <div className="my-1 border-t border-slate-100" />
                  <Link to="/dashboard" className="px-3 py-2 hover:bg-slate-50 flex items-center gap-2 text-slate-600">
                    <ExternalLink className="w-3.5 h-3.5" /> Contractor view
                  </Link>
                </div>
              )}
            </div>
          </div>
        </div>

        {statusMsg && (
          <div className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            {statusMsg}
          </div>
        )}

        {overview?.email?.simulated !== false ? (
          <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-center justify-between gap-2 flex-wrap">
            <span>Email: simulated mode — no real provider configured. Outgoing mail is recorded in the log but not delivered.</span>
            <span className="text-[10px] text-amber-700">staff only</span>
          </div>
        ) : (
          <div className="text-xs text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 flex items-center justify-between gap-2 flex-wrap">
            <span>Email: live delivery enabled ({overview?.email?.mode?.toUpperCase()}) — outgoing mail is really delivered.</span>
            <span className="text-[10px] text-emerald-700">staff only</span>
          </div>
        )}

        {error && (
          <div className="text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        {/* KPI row */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="kpi-card p-4">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">MRR</div>
            <div className="text-[34px] font-extrabold leading-tight text-slate-900 mt-1 font-mono">
              ${overview ? overview.revenue.mrr.toLocaleString() : '0'}
            </div>
            <div className="text-xs text-slate-500 mt-1">${overview ? overview.revenue.arr.toLocaleString() : '0'} ARR</div>
          </div>
          <div className="kpi-card p-4">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Paying</div>
            <div className="text-[34px] font-extrabold leading-tight text-slate-900 mt-1 font-mono">
              {overview?.revenue.paying_subscribers ?? 0} <span className="text-lg font-bold text-slate-400">/ {overview?.platform.companies ?? 0}</span>
            </div>
            <div className="h-1 bg-slate-100 rounded overflow-hidden mt-2">
              <div
                className="h-full rounded"
                style={{
                  background: 'var(--pass)',
                  width: `${overview && overview.platform.companies ? Math.min(100, Math.round((overview.revenue.paying_subscribers / overview.platform.companies) * 100)) : 0}%`,
                }}
              />
            </div>
            <div className="text-xs text-slate-500 mt-1">
              {overview && overview.platform.companies ? Math.round((overview.revenue.paying_subscribers / overview.platform.companies) * 100) : 0}% of companies
            </div>
          </div>
          <div className="kpi-card p-4">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">ARPU</div>
            <div className="text-[34px] font-extrabold leading-tight text-slate-900 mt-1 font-mono">
              ${overview ? overview.revenue.arpu : '—'}
            </div>
            <div className="text-xs text-slate-500 mt-1">per paying company</div>
          </div>
          <div className="kpi-card p-4">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">New sign-ups</div>
            <div className="text-[34px] font-extrabold leading-tight text-slate-900 mt-1 font-mono">
              {overview?.users.new_this_month ?? 0}
            </div>
            <div className="text-xs font-semibold mt-1" style={{ color: 'var(--info)' }}>this month</div>
          </div>
          <button
            type="button"
            onClick={() => { setCoiFilter('pending'); document.getElementById('validation-queue')?.scrollIntoView({ behavior: 'smooth' }) }}
            className="kpi-card p-4 text-left hover:border-rose-300 transition cursor-pointer"
          >
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Needs validation</div>
            <div className="text-[34px] font-extrabold leading-tight mt-1 font-mono" style={{ color: 'var(--fail)' }}>
              {coiCounts?.pending ?? overview?.platform.pending_reviews ?? 0}
            </div>
            <div className="text-xs text-slate-500 mt-1">of {coiCounts?.all ?? overview?.platform.cois ?? 0} COIs on file →</div>
          </button>
          <div className="kpi-card p-4">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Subs tracked</div>
            <div className="text-[34px] font-extrabold leading-tight text-slate-900 mt-1 font-mono">
              {overview ? overview.platform.subcontractors : '—'}
            </div>
            <div className="text-xs text-slate-500 mt-1">{overview?.platform.client_share_links ?? 0} share link</div>
          </div>
        </div>

        {/* Revenue & growth */}
        <div id="revenue" className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {/* Sign-ups per day - true column chart matching the mock */}
          <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between pb-2 border-b border-slate-100 flex-wrap gap-2">
                <div>
                  <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700">Sign-ups per day</h2>
                  <p className="text-[11px] text-slate-400 font-mono mt-0.5">
                    {growthEntries[0]?.label || growthEntries[0]?.period || '—'} – {growthEntries[growthEntries.length - 1]?.label || growthEntries[growthEntries.length - 1]?.period || '—'}
                  </p>
                </div>
                <div className="flex items-center gap-4 text-[11px]">
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: 'var(--chart-1)' }} /> Sign-ups</span>
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: 'var(--chart-2)' }} /> Became paying</span>
                </div>
              </div>
              <div className="pt-4">
                {growthEntries.length > 0 ? (
                  <div>
                    <div className="h-52 flex items-end gap-1.5 sm:gap-2 justify-between">
                      {growthEntries.map((g) => {
                        const h = maxGrowth ? Math.round((g.new_users / maxGrowth) * 100) : 0
                        return (
                          <div key={g.period || g.month || g.label} className="flex-1 flex flex-col items-center justify-end h-full group" title={`${g.label || g.period}: +${g.new_users}`}>
                            <span className="text-[10px] font-bold font-mono text-slate-700 mb-1 leading-none">{g.new_users || ''}</span>
                            <div className="w-full rounded-t" style={{ height: `${g.new_users ? Math.max(8, h) : 3}%`, background: g.new_users ? 'var(--chart-1)' : '#e2e8f0' }} />
                          </div>
                        )
                      })}
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-slate-400 font-mono mt-2 pt-1 border-t border-slate-100">
                      <span>{growthEntries[0]?.label || growthEntries[0]?.period}</span>
                      {growthEntries.length > 2 && <span>{growthEntries[Math.floor(growthEntries.length / 2)]?.label || growthEntries[Math.floor(growthEntries.length / 2)]?.period}</span>}
                      <span>{growthEntries[growthEntries.length - 1]?.label || growthEntries[growthEntries.length - 1]?.period}</span>
                    </div>
                  </div>
                ) : (
                  <div className="text-center text-slate-400 text-xs py-10">no data</div>
                )}
              </div>
            </div>
            <p className="text-[11px] text-slate-400 mt-4 border-t border-slate-100 pt-2">
              The paying-conversion series fills in once plan-change dates are recorded. Today only the current plan is stored.
            </p>
          </div>

          {/* Revenue by plan + Activation funnel */}
          <div className="space-y-3">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700">Revenue by plan</h2>
                <div className="text-xs font-bold font-mono text-slate-900">${overview?.revenue.mrr ?? 0} <span className="text-[10px] text-slate-400 font-normal">/mo</span></div>
              </div>
              <div className="mt-3 flex h-3 rounded overflow-hidden bg-slate-100">
                {plans.map((p) => {
                  const mrr = overview?.revenue.mrr || 1
                  const w = Math.round((p.mrr / mrr) * 100)
                  const color = p.plan === 'Pro GC' ? '#0f766e' : p.plan === 'General Contractor' ? '#0d9488' : p.plan === 'Enterprise' ? '#94a3b8' : '#cbd5e1'
                  return <div key={p.plan} style={{ width: `${w}%`, background: color }} title={`${p.plan}: $${p.mrr}`} />
                })}
              </div>
              <div className="divide-y divide-slate-100 text-xs mt-3">
                {plans.map((p) => {
                  const price = overview?.revenue.available_plans.find((ap) => ap.plan === p.plan)?.price ?? (p.plan === 'Enterprise' ? 59 : 0)
                  const icon = p.plan === 'Pro GC' ? '■' : p.plan === 'General Contractor' ? '■' : p.plan === 'Enterprise' ? '⬚' : '■'
                  const color = p.plan === 'Pro GC' ? '#0f766e' : p.plan === 'General Contractor' ? '#0d9488' : p.plan === 'Enterprise' ? '#94a3b8' : '#94a3b8'
                  return (
                    <div key={p.plan} className="py-1.5 flex items-center justify-between">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span style={{ color }} className="text-sm leading-none">{icon}</span>
                        <span className="font-medium text-slate-800 truncate">{p.plan}</span>
                        <span className="text-[11px] text-slate-400 font-mono">${price} × {p.count}</span>
                      </div>
                      <span className="font-bold font-mono text-slate-900">${p.mrr.toLocaleString()}</span>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2.5">
              <div className="flex items-center justify-between pb-1 border-b border-slate-100">
                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700">Activation funnel</h2>
              </div>
              {[
                { label: 'Signed up', value: totalSignups, color: 'var(--chart-1)' },
                { label: 'On a paid plan', value: paidSubs, color: 'var(--chart-1)' },
                { label: 'Added a sub', value: withSubs, color: 'var(--chart-2)' },
              ].map((s) => (
                <div key={s.label} className="text-xs flex items-center gap-2">
                  <span className="w-24 text-[11px] text-slate-600 truncate">{s.label}</span>
                  <div className="flex-1 bg-slate-100 rounded h-2.5 overflow-hidden">
                    <div className="h-full rounded" style={{ width: `${totalSignups ? Math.max(6, Math.round((s.value / totalSignups) * 100)) : 0}%`, background: s.color }} />
                  </div>
                  <span className="font-bold font-mono text-slate-900 w-6 text-right text-[11px]">{s.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Validation queue */}
        <div id="validation-queue" className="bg-white border border-slate-200 rounded-xl p-4 scroll-mt-6">
          <div className="flex flex-col gap-3 pb-3 border-b border-slate-100 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700">COIs needing validation</h2>
              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-rose-100 text-rose-800">
                {coiCounts?.pending ?? 0} waiting
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                className="text-xs"
                onClick={() => { void loadCoiQueue(coiFilter, coiSearch); void load() }}
              >
                <RefreshCw className={`w-3.5 h-3.5 ${coiLoading ? 'animate-spin' : ''}`} /> Refresh queue
              </Button>
              <Button
                className="text-xs btn-marker"
                onClick={reviewNext}
                disabled={coiQueue.length === 0}
                title="Open the next pending certificate for review (or press J)"
              >
                Review next →
              </Button>
            </div>
          </div>
          {/* Filter chips */}
          <div className="mt-3 flex flex-nowrap items-center gap-1.5 overflow-x-auto pb-1 scrollbar-hide text-xs">
            {[
              { key: 'pending', label: 'Pending', count: coiCounts?.pending, chip: 'bg-slate-900 text-white' },
              { key: 'ai_checked', label: 'AI checked', count: coiCounts?.ai_checked, chip: 'badge-info' },
              { key: 'ai_pending', label: 'Waiting on agent', count: coiCounts?.ai_pending, chip: 'badge-warn' },
              { key: 'no_file', label: 'No file', count: coiCounts?.no_file, chip: 'bg-slate-200 text-slate-800' },
              { key: 'compliant', label: 'Compliant', count: coiCounts?.compliant, chip: 'badge-pass' },
              { key: 'needs_revision', label: 'Needs revision', count: coiCounts?.needs_revision, chip: 'badge-warn' },
              { key: 'rejected', label: 'Rejected', count: coiCounts?.rejected, chip: 'badge-fail' },
              { key: 'all', label: 'All', count: coiCounts?.all, chip: 'bg-slate-100 text-slate-800' },
            ].map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setCoiFilter(f.key as typeof coiFilter)}
                className={`rounded-full px-3 py-1 font-semibold transition min-h-[36px] shrink-0 flex items-center gap-1.5 ${f.chip} ${
                  coiFilter === f.key ? 'ring-2 ring-slate-800 ring-offset-1 font-bold' : 'opacity-80 hover:opacity-100'
                }`}
              >
                {f.label}
                {f.count !== undefined && <span className="font-bold font-mono">{f.count}</span>}
              </button>
            ))}
          </div>
          {/* Search & batch bar */}
          <div className="mt-3 flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
              <input
                type="text"
                placeholder="Search by company, carrier, policy #, NAIC…"
                value={coiSearch}
                onChange={(e) => setCoiSearch(e.target.value)}
                className="w-full text-xs border border-slate-300 rounded-lg pl-8 pr-2 py-1.5 bg-white focus:outline-none focus:border-slate-500"
              />
            </div>
            {selectedCoiIds.size > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <button type="button" onClick={handleBatchValidate} disabled={coiLoading} className="h-8 px-3 rounded-md text-xs font-medium inline-flex items-center gap-1.5 border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Validate selected
                </button>
                <button type="button" onClick={handleBatchExtract} disabled={coiLoading} className="h-8 px-3 rounded-md text-xs font-medium inline-flex items-center gap-1.5 border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  <Sparkles className="w-3.5 h-3.5" /> Run AI
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedCoiIds(new Set())}
                  className="text-xs text-slate-500 hover:underline px-1"
                >
                  Clear
                </button>
              </div>
            )}
          </div>
          {coiError && (
            <div className="mt-3 p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800">
              {coiError}
            </div>
          )}
          {/* Desktop table */}
          <div className="mt-3 overflow-x-auto hidden md:block">
            <table className="w-full text-left text-xs min-w-[1240px]">
              <thead>
                <tr className="text-[10px] uppercase text-slate-400 border-b border-slate-100 font-bold tracking-wider">
                  <th className="py-2 pr-2 w-8">
                    <input
                      type="checkbox"
                      checked={coiQueue.length > 0 && selectedCoiIds.size === coiQueue.length}
                      onChange={(e) =>
                        setSelectedCoiIds(e.target.checked ? new Set(coiQueue.map((c) => c.id)) : new Set())
                      }
                      aria-label="Select all"
                    />
                  </th>
                  <th className="py-2 pr-3 min-w-[170px]">Subcontractor</th>
                  <th className="py-2 pr-3 min-w-[70px]">General contractor</th>
                  <th className="py-2 pr-3 min-w-[170px]">Insurer · NAIC</th>
                  <th className="py-2 pr-3 min-w-[110px]">Expires</th>
                  <th className="py-2 pr-3 min-w-[190px]">Automated checks</th>
                  <th className="py-2 px-3 text-left w-[140px] min-w-[140px]">Result</th>
                  <th className="py-2 pl-4 text-right w-[440px] min-w-[440px]">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {coiQueue.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center text-slate-400 py-8">
                      {coiLoading ? 'Loading queue…' : 'No COIs match this filter'}
                    </td>
                  </tr>
                ) : (
                  coiQueue.map((item) => {
                    const isExp = coiExpiryAllExpired(item.expiration_date, item.review_details?.policies)
                    const partiallyExpired = isPartiallyExpired(item.expiration_date, item.review_details?.policies)
                    const hasExtracted = Boolean(item.review_source || item.review_insured || item.review_producer)
                    const results = policyResults(item)
                    const busy = coiBusy[item.id]
                    const result = queueResult(item)
                    return (
                      <tr key={item.id} className="hover:bg-slate-50 align-top">
                        <td className="py-2.5 pr-2 pt-3">
                          <input
                            type="checkbox"
                            checked={selectedCoiIds.has(item.id)}
                            onChange={(e) =>
                              setSelectedCoiIds((prev) => {
                                const s = new Set(prev)
                                e.target.checked ? s.add(item.id) : s.delete(item.id)
                                return s
                              })
                            }
                            aria-label={`Select ${item.sub_company_name || 'COI'}`}
                          />
                        </td>
                        <td className="py-2.5 pr-3">
                          <Link to={`/staff/coi/${item.id}`} className="font-bold text-slate-900 hover:underline">
                            {item.sub_company_name || '—'}
                          </Link>
                          <div className="text-[11px] text-slate-500">
                            {item.trade || '—'} {item.sub_email ? `· ${item.sub_email}` : ''}
                          </div>
                        </td>
                        <td className="py-2.5 pr-3 text-slate-700">
                          <div className="font-medium">{item.gc_company_name || '[GC]'}</div>
                        </td>
                        <td className="py-2.5 pr-3">
                          <div className="font-bold text-slate-800">{item.carrier || 'Not provided'}</div>
                          <div className="text-[11px] text-slate-500 font-mono">
                            {item.policy_number || 'No policy #'}
                            {!item.insurer_naic && item.carrier ? (
                              <span className="ml-1.5 text-[10px] font-bold text-rose-600 font-mono">· NAIC not found</span>
                            ) : null}
                          </div>
                        </td>
                        <td className="py-2.5 pr-3 font-mono">
                          <div>{formatDisplayDate(item.expiration_date)}</div>
                          <div className="text-[11px]">
                            <span className={`font-bold ${isExp ? 'text-rose-700' : (item.days_left ?? 999) <= 30 ? 'text-amber-700' : 'text-slate-500'}`}>
                              {item.days_left !== null ? (isExp ? `${Math.abs(item.days_left)}d expired` : `${item.days_left}d left`) : '—'}
                            </span>
                          </div>
                        </td>
                        <td className="py-2.5 pr-3">
                          <div className="flex flex-wrap gap-1 text-[11px]">
                            {item.status === 'compliant' && <span className="badge-pass px-1.5 py-0.5 rounded font-bold">All 10 ✓</span>}
                            {item.insurer_naic ? <span className="badge-pass px-1.5 py-0.5 rounded font-bold">NAIC ✓</span> : item.carrier ? <span className="badge-fail px-1.5 py-0.5 rounded font-bold">NAIC ×</span> : null}
                            {item.insured_match === false && <span className="badge-fail px-1.5 py-0.5 rounded font-bold">Insured ≠ sub</span>}
                            {item.insurer_is_parent && <span className="badge-warn px-1.5 py-0.5 rounded font-semibold">Parent co., not insurer</span>}
                            {item.effective_date && item.expiration_date && <span className="badge-pass px-1.5 py-0.5 rounded font-bold">Dates ✓</span>}
                            {partiallyExpired && <span className="badge-warn px-1.5 py-0.5 rounded font-semibold">1+ policy expired</span>}
                            {item.has_file && <span className="badge-info px-1.5 py-0.5 rounded">file</span>}
                          </div>
                        </td>
                        <td className="py-2.5 px-3 w-[150px] min-w-[150px]">
                          <div className="flex flex-col gap-1 items-start">
                            {results.map((r, i) => (
                              <span key={i} className={`h-7 px-2 rounded-md text-xs font-semibold inline-flex items-center gap-1 shrink-0 ${r.chip}`} title={r.policy ? `${r.policy}: ${r.label}` : r.label}>
                                {r.policy ? <span className="text-[10px] opacity-75 font-mono">{shortPolicyLabel(r.policy)} ·</span> : null}
                                {r.label}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="py-2.5 pl-4 text-right w-[440px] min-w-[440px]">
                          <div className="flex flex-col items-end gap-1">
                          <div className="flex items-center justify-end gap-1.5 flex-nowrap">
                            <Link
                              to={`/staff/coi/${item.id}`}
                              className="btn-marker h-8 px-3 rounded-md text-xs font-semibold inline-flex items-center gap-1 shrink-0 shadow-sm"
                            >
                              Review
                            </Link>
                            {item.has_file && (
                              <button
                                type="button"
                                onClick={() => handleExtract(item.id)}
                                disabled={busy === 'extracting'}
                                title={hasExtracted ? 'Re-run AI extraction on this certificate to refresh dates, carrier, and policy details' : 'Run AI extraction now'}
                                className="h-8 px-3 rounded-md text-xs font-medium inline-flex items-center gap-1.5 border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50 shrink-0"
                              >
                                <Sparkles className={`w-3.5 h-3.5 ${busy === 'extracting' ? 'animate-spin' : ''}`} />
                                {busy === 'extracting' ? 'Extracting…' : hasExtracted ? 'Check again' : 'Extract with AI'}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => void openFieldsReviewForCoi(item)}
                              title="View and correct extracted fields (dates, amounts, carrier, policies)"
                              className="h-8 px-2.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 shrink-0"
                            >
                              <FileEdit className="w-3.5 h-3.5" /> Edit data
                            </button>
                            {!isExp && (
                              <button
                                type="button"
                                onClick={() => handleValidate(item.id)}
                                disabled={busy === 'validating'}
                                className="h-8 px-3 rounded-md text-xs font-medium inline-flex items-center gap-1.5 border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50 shrink-0"
                              >
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                {busy === 'validating' ? 'Saving…' : 'Validate'}
                              </button>
                            )}
                            {item.has_file && (
                              <button
                                type="button"
                                onClick={() => handleViewCert(item.id)}
                                title="Open certificate file"
                                className="h-8 w-8 rounded-md text-xs inline-flex items-center justify-center border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 shrink-0"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleDeleteCoi(item.id, item.sub_company_name)}
                              title="Delete certificate (no validation needed for test records)"
                              disabled={busy === 'deleting'}
                              className="h-8 w-8 rounded-md text-xs inline-flex items-center justify-center border border-rose-300 bg-white text-rose-700 hover:bg-rose-50 hover:border-rose-400 disabled:opacity-50 shrink-0"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                            <select
                              value={item.status}
                              onChange={(e) => handleSetStatus(item.id, e.target.value)}
                              disabled={busy === 'saving'}
                              className="h-8 text-xs font-medium border border-slate-300 rounded-md px-2 bg-white text-slate-800 focus:outline-none focus:ring-1 focus:ring-brand-500 shrink-0"
                              title="Set status"
                            >
                              <option value="pending_review">Pending</option>
                              <option value="compliant">Compliant</option>
                              <option value="needs_revision">Needs revision</option>
                              <option value="rejected">Rejected</option>
                            </select>
                          </div>
                          {isExp && <span className="text-[10px] text-slate-400 italic">Expired — no validation needed</span>}
                          </div>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
          {/* Mobile cards */}
          <div className="mt-3 divide-y divide-slate-100 md:hidden text-xs">
            {coiQueue.map((item) => {
              const isExp = coiExpiryAllExpired(item.expiration_date, item.review_details?.policies)
              const hasExtracted = Boolean(item.review_source || item.review_insured || item.review_producer)
              const results = policyResults(item)
              const busy = coiBusy[item.id]
              return (
                <div key={item.id} className="py-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 min-w-0">
                      <input
                        type="checkbox"
                        checked={selectedCoiIds.has(item.id)}
                        onChange={(e) =>
                          setSelectedCoiIds((prev) => {
                            const s = new Set(prev)
                            e.target.checked ? s.add(item.id) : s.delete(item.id)
                            return s
                          })
                        }
                        className="mt-0.5"
                        aria-label={`Select ${item.sub_company_name || 'COI'}`}
                      />
                      <div className="min-w-0">
                        <Link to={`/staff/coi/${item.id}`} className="font-bold text-slate-900 truncate hover:underline block">
                          {item.sub_company_name || '—'}
                        </Link>
                        <div className="text-[11px] text-slate-500 truncate">
                          {item.carrier || '—'} · {item.trade || '—'}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-col gap-1 items-end shrink-0">
                      {results.map((r, i) => (
                        <span key={i} className={`h-7 px-2 rounded-md text-xs font-bold inline-flex items-center gap-1 ${r.chip}`} title={r.policy ? `${r.policy}: ${r.label}` : r.label}>
                          {r.policy ? <span className="text-[10px] opacity-75 font-mono">{shortPolicyLabel(r.policy)} ·</span> : null}
                          {r.label}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1 text-[11px]">
                    {item.insured_match === false && <span className="badge-fail px-1.5 py-0.5 rounded font-bold">Insured ≠ sub</span>}
                    {item.insurer_is_parent && <span className="badge-warn px-1.5 py-0.5 rounded font-semibold">Parent co., not insurer</span>}
                    {item.insurer_naic ? <span className="badge-pass px-1.5 py-0.5 rounded font-bold">NAIC ✓</span> : item.carrier ? <span className="badge-fail px-1.5 py-0.5 rounded font-bold">NAIC ×</span> : null}
                  </div>
                  <div className="flex items-center justify-between text-[11px] font-mono">
                    <span className="text-slate-500">Exp {formatDisplayDate(item.expiration_date)}</span>
                    <span className={`font-bold ${isExp ? 'text-rose-700' : (item.days_left ?? 999) <= 30 ? 'text-amber-700' : 'text-slate-500'}`}>
                      {item.days_left !== null ? (isExp ? `${Math.abs(item.days_left)}d expired` : `${item.days_left}d left`) : ''}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-1.5 pt-1">
                    <Link to={`/staff/coi/${item.id}`} className="btn-marker h-8 px-3 rounded-md text-xs font-semibold inline-flex items-center gap-1 shrink-0 shadow-sm">Review</Link>
                    {item.has_file && (
                      <button
                        type="button"
                        onClick={() => handleExtract(item.id)}
                        disabled={busy === 'extracting'}
                        title={hasExtracted ? 'Re-run AI extraction on this certificate to refresh dates, carrier, and policy details' : 'Run AI extraction now'}
                        className="h-8 px-3 rounded-md text-xs font-medium inline-flex items-center gap-1.5 border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50 shrink-0"
                      >
                        <Sparkles className={`w-3.5 h-3.5 ${busy === 'extracting' ? 'animate-spin' : ''}`} />
                        {busy === 'extracting' ? 'Extracting…' : hasExtracted ? 'Check again' : 'Extract with AI'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void openFieldsReviewForCoi(item)}
                      title="View and correct extracted fields (dates, amounts, carrier, policies)"
                      className="h-8 px-2.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 shrink-0"
                    >
                      <FileEdit className="w-3.5 h-3.5" /> Edit data
                    </button>
                    <select
                      value={item.status}
                      onChange={(e) => handleSetStatus(item.id, e.target.value)}
                      disabled={busy === 'saving'}
                      className="h-8 text-xs font-medium border border-slate-300 rounded-md px-2 bg-white text-slate-800 focus:outline-none focus:ring-1 focus:ring-brand-500 shrink-0"
                    >
                      <option value="pending_review">Pending</option>
                      <option value="compliant">Compliant</option>
                      <option value="needs_revision">Needs revision</option>
                      <option value="rejected">Rejected</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => handleDeleteCoi(item.id, item.sub_company_name)}
                      title="Delete certificate"
                      disabled={busy === 'deleting'}
                      className="h-8 w-8 rounded-md text-xs inline-flex items-center justify-center border border-rose-300 bg-white text-rose-700 hover:bg-rose-50 disabled:opacity-50 shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Companies */}
        <div id="companies" className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-100">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700">
              Companies ({filteredCompanies.length})
            </h2>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                <input
                  type="text"
                  placeholder="Search companies…"
                  value={companySearch}
                  onChange={(e) => setCompanySearch(e.target.value)}
                  className="text-xs border border-slate-300 rounded-lg pl-8 pr-2 py-1.5 bg-white focus:outline-none focus:border-slate-500 w-56"
                />
              </div>
              <Button variant="secondary" className="text-xs" onClick={exportCompaniesCsv} title="Export CSV">
                <Download className="w-3.5 h-3.5" /> CSV
              </Button>
            </div>
          </div>
          <div className="sm:hidden divide-y divide-slate-100 text-xs">
            {filteredCompanies.map((c) => {
              return (
                <div key={c.id} className={`py-3 space-y-2 rounded-lg px-2 -mx-2 ${c.is_test ? 'bg-amber-50/60' : ''}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-slate-900 truncate">{c.name}</span>
                        {c.is_test && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-200 text-amber-900 font-mono">
                            TEST
                          </span>
                        )}
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full font-mono bg-slate-100 text-slate-800">
                          {c.connected_subcontractors ?? c.subcontractor_count ?? 0} { (c.connected_subcontractors ?? c.subcontractor_count ?? 0) === 1 ? 'sub' : 'subs' } · {c.connected_cois ?? 0} { (c.connected_cois ?? 0) === 1 ? 'COI' : 'COIs' }
                        </span>
                      </div>
                      <div className="text-slate-500 truncate">{c.owner_name || '—'}</div>
                      <div className="text-[10px] text-slate-400 truncate">{c.owner_email || '—'}</div>
                    </div>
                    <button
                      onClick={() => handleDeleteCompany(c)}
                      title="Delete company"
                      className="w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-slate-100 text-slate-800 font-mono">
                      {c.plan || 'Free Demo'} · ${(c.mrr || 0).toLocaleString()}/mo
                    </span>
                    <button
                      type="button"
                      onClick={() => openPlanModal(c)}
                      className="text-[11px] text-brand-700 hover:text-brand-900 underline"
                    >
                      Change plan…
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleToggleTest(c)}
                      disabled={testFlagLoading === c.id}
                      className="text-[11px] text-slate-400 hover:text-slate-700 underline font-mono"
                      title="Toggle whether this company is counted in MRR/metrics"
                    >
                      {c.is_test ? 'unmark test' : 'mark as test'}
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-slate-600 pt-1 font-mono">
                    <span>MRR <strong className="text-slate-900">${(c.mrr || 0).toLocaleString()}</strong></span>
                    <span>Subs {c.subcontractor_count}</span>
                    <span>Projects {c.project_count}</span>
                    <span className="text-slate-400">Joined {(c.created_at || '').slice(0, 10) || '—'}</span>
                  </div>
                </div>
              )
            })}
          </div>
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-slate-400 border-b border-slate-100 font-bold">
                  <th className="py-2 pr-3">Company</th>
                  <th className="py-2 pr-3">Owner</th>
                  <th className="py-2 pr-3">Plan</th>
                  <th className="py-2 pr-3">Connected</th>
                  <th className="py-2 pr-3 text-right">MRR</th>
                  <th className="py-2 pr-3 text-right">Subs</th>
                  <th className="py-2 pr-3 text-right">Projects</th>
                  <th className="py-2 pr-3">Joined</th>
                  <th className="py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredCompanies.map((c) => {
                  return (
                    <tr key={c.id} className={c.is_test ? 'bg-amber-50/50 hover:bg-amber-100/50' : 'hover:bg-slate-50'}>
                      <td className="py-2.5 pr-3 font-semibold text-slate-900">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span>{c.name}</span>
                          {c.is_test && (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-200 text-amber-900 font-mono">
                              TEST
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => void handleToggleTest(c)}
                            disabled={testFlagLoading === c.id}
                            className="text-[10px] text-slate-400 hover:text-slate-700 underline font-mono"
                            title="Toggle whether this company is counted in MRR/metrics"
                          >
                            {c.is_test ? 'unmark' : 'mark test'}
                          </button>
                        </div>
                      </td>
                      <td className="py-2.5 pr-3 text-slate-600">
                        <div>{c.owner_name || '—'}</div>
                        <div className="text-[10px] text-slate-400">{c.owner_email || '—'}</div>
                      </td>
                      <td className="py-2.5 pr-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-800">
                            {c.plan || 'Free Demo'}
                          </span>
                          <button
                            type="button"
                            onClick={() => openPlanModal(c)}
                            className="text-[10px] text-brand-700 hover:text-brand-900 underline"
                          >
                            Change plan…
                          </button>
                        </div>
                      </td>
                      <td className="py-2.5 pr-3">
                        <span className="inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-800 font-mono">
                          {c.connected_subcontractors ?? c.subcontractor_count ?? 0} { (c.connected_subcontractors ?? c.subcontractor_count ?? 0) === 1 ? 'sub' : 'subs' } · {c.connected_cois ?? 0} { (c.connected_cois ?? 0) === 1 ? 'COI' : 'COIs' }
                        </span>
                      </td>
                      <td className="py-2.5 pr-3 text-right font-bold text-slate-900 font-mono">
                        ${(c.mrr || 0).toLocaleString()}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono">{c.subcontractor_count}</td>
                      <td className="py-2.5 pr-3 text-right font-mono">{c.project_count}</td>
                      <td className="py-2.5 pr-3 text-slate-500 font-mono">{(c.created_at || '').slice(0, 10) || '—'}</td>
                      <td className="py-2.5 text-right">
                        <button
                          onClick={() => handleDeleteCompany(c)}
                          title="Delete company"
                          className="w-11 h-11 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Users */}
        <div id="users" className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-100">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700">
              Users ({filteredUsers.length})
            </h2>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
              <div className="flex flex-wrap gap-1 w-full sm:w-auto text-xs">
                {(['all', 'admin', 'gc', 'pro_gc', 'sub'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRoleFilter(r)}
                    className={`min-h-[36px] px-2.5 py-1 rounded-full font-semibold transition ${
                      roleFilter === r ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {r === 'admin' ? 'Admins' : r === 'gc' ? 'GCs' : r === 'pro_gc' ? 'Pro GCs' : r === 'sub' ? 'Sub Cs' : 'All'}
                  </button>
                ))}
              </div>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                <input
                  type="text"
                  placeholder="Search users…"
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  className="text-xs border border-slate-300 rounded-lg pl-8 pr-2 py-1.5 bg-white focus:outline-none focus:border-slate-500 w-full sm:w-56"
                />
              </div>
            </div>
          </div>
          <div className="sm:hidden divide-y divide-slate-100 text-xs">
            {filteredUsers.map((u) => (
              <div key={u.id} className="py-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-900">{u.name || '—'}</div>
                    <div className="text-[10px] text-slate-400 truncate">{u.email}</div>
                  </div>
                  <button
                    onClick={() => handleDeleteUser(u)}
                    disabled={me ? u.id === me.id : false}
                    title={me && u.id === me.id ? 'Cannot delete your own account' : 'Delete user'}
                    className="w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-400"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => openPwReset(u)}
                    title="Reset user password…"
                    className="w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-brand-primary hover:bg-slate-100 transition"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="text-slate-600">{u.company_name || '—'}</div>
                <div className="flex items-center gap-1.5">
                  <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-bold ${u.role === 'admin' ? 'badge-info' : u.role === 'pro_gc' ? 'badge-pass' : u.role === 'sub' ? 'badge-warn' : 'badge-info'}`}>
                    {roleLabel(u.role)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setRoleModal({ open: true, user: u, newRole: (u.role as any) || 'gc' })}
                    className="text-[11px] font-bold text-slate-500 hover:text-slate-900 px-1 py-0.5 rounded hover:bg-slate-100 font-mono"
                    title="Change role…"
                  >
                    •••
                  </button>
                </div>
                <div className="text-[11px] text-slate-400 pt-1 font-mono">
                  Joined {(u.created_at || '').slice(0, 10) || '—'}
                </div>
              </div>
            ))}
          </div>
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-slate-400 border-b border-slate-100 font-bold">
                  <th className="py-2 pr-3">User</th>
                  <th className="py-2 pr-3">Company</th>
                  <th className="py-2 pr-3">Role</th>
                  <th className="py-2 pr-3">Joined</th>
                  <th className="py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredUsers.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-50">
                    <td className="py-2.5 pr-3">
                      <div className="font-semibold text-slate-900">{u.name || '—'}</div>
                      <div className="text-[10px] text-slate-400">{u.email}</div>
                    </td>
                    <td className="py-2.5 pr-3 text-slate-600">{u.company_name || '—'}</td>
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-1.5">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-bold ${u.role === 'admin' ? 'badge-info' : u.role === 'pro_gc' ? 'badge-pass' : u.role === 'sub' ? 'badge-warn' : 'badge-info'}`}>
                          {roleLabel(u.role)}
                        </span>
                        <button
                          type="button"
                          onClick={() => setRoleModal({ open: true, user: u, newRole: (u.role as any) || 'gc' })}
                          className="text-[11px] font-bold text-slate-500 hover:text-slate-900 px-1 py-0.5 rounded hover:bg-slate-100 font-mono"
                          title="Change role…"
                        >
                          •••
                        </button>
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 text-slate-500 font-mono">{(u.created_at || '').slice(0, 10) || '—'}</td>
                    <td className="py-2.5 text-right">
                      <div className="inline-flex items-center">
                        <button
                          type="button"
                          onClick={() => openPwReset(u)}
                          title="Reset user password…"
                          className="w-11 h-11 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-brand-primary hover:bg-slate-100 transition"
                        >
                          <KeyRound className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDeleteUser(u)}
                          disabled={me ? u.id === me.id : false}
                          title={me && u.id === me.id ? 'Cannot delete your own account' : 'Delete user'}
                          className="w-11 h-11 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-400"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Articles */}
        <div id="articles" className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-100">
            <div>
              <div className="flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-brand-primary" />
                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                  Articles ({articles.length})
                </h2>
              </div>
              <p className="text-[11px] text-slate-400 mt-0.5">
                SEO field guides live at <a href="/articles/" target="_blank" rel="noopener" className="underline hover:text-slate-700">safecoi.com/articles</a>
              </p>
            </div>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
              <div className="flex flex-wrap gap-1 text-xs">
                {(['all', 'published', 'draft'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setArticleFilter(r)}
                    className={`min-h-[36px] px-2.5 py-1 rounded-full font-semibold transition ${
                      articleFilter === r ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {r === 'published' ? 'Published' : r === 'draft' ? 'Drafts' : 'All'}
                  </button>
                ))}
              </div>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                <input
                  type="text"
                  placeholder="Search articles…"
                  value={articleSearch}
                  onChange={(e) => setArticleSearch(e.target.value)}
                  className="text-xs border border-slate-300 rounded-lg pl-8 pr-2 py-1.5 bg-white focus:outline-none focus:border-slate-500 w-full sm:w-56"
                />
              </div>
              <Button className="text-xs shrink-0 flex items-center gap-1" onClick={openArticleCreate}>
                <Plus className="w-3.5 h-3.5" /> New article
              </Button>
            </div>
          </div>
          {articleNotice && (
            <div className="mt-3 p-2 rounded-lg text-xs bg-emerald-50 text-emerald-800 flex items-center gap-2">
              <Check className="w-4 h-4 shrink-0" /> {articleNotice}
            </div>
          )}
          <div className="overflow-x-auto mt-3">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="text-slate-400 uppercase text-[10px] tracking-wider border-b border-slate-100">
                  <th className="py-2 pr-3 w-8">#</th>
                  <th className="py-2 pr-3">Title</th>
                  <th className="py-2 pr-3">Category</th>
                  <th className="py-2 pr-3">Reading</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Updated</th>
                  <th className="py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredArticles.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-6 text-center text-slate-400">
                      {articlesLoading ? 'Loading articles…' : 'No articles match this filter'}
                    </td>
                  </tr>
                ) : (
                  filteredArticles.map((a) => (
                    <tr key={a.id} className="hover:bg-slate-50">
                      <td className="py-2.5 pr-3 font-mono text-slate-400">{a.position}</td>
                      <td className="py-2.5 pr-3 max-w-md">
                        <div className="font-semibold text-slate-900 line-clamp-1">{a.title}</div>
                        <div className="text-[10px] text-slate-400 font-mono flex items-center gap-2 flex-wrap">
                          <span>/articles/{a.slug}/</span>
                          {a.status === 'published' && (
                            <a
                              href={`/articles/${a.slug}/`}
                              target="_blank"
                              rel="noopener"
                              className="inline-flex items-center gap-0.5 text-brand-primary hover:underline font-sans"
                            >
                              view <ExternalLink className="w-2.5 h-2.5" />
                            </a>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 pr-3 text-slate-600">{a.tag}</td>
                      <td className="py-2.5 pr-3 text-slate-500">{a.reading_time_min} min</td>
                      <td className="py-2.5 pr-3">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-bold ${
                            a.status === 'published' ? 'badge-pass' : 'badge-warn'
                          }`}
                        >
                          {a.status}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3 text-slate-500 font-mono">{(a.updated_at || '').slice(0, 10)}</td>
                      <td className="py-2.5 text-right">
                        <div className="inline-flex items-center">
                          <button
                            type="button"
                            onClick={() => openArticleEdit(a)}
                            title="Edit article"
                            className="w-11 h-11 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-brand-primary hover:bg-slate-100 transition"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setArticleDeleteModal({ open: true, article: a })}
                            title="Delete article"
                            className="w-11 h-11 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
        <AgentControlPanel onRefreshMain={() => { loadCoiQueue(coiFilter, coiSearch); load() }} />

        {/* Email delivery settings */}
        <section id="email-settings" className="bg-white border border-slate-200 rounded-xl p-4 scroll-mt-6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-100 pb-3">
            <div>
              <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Send className="w-4 h-4 text-brand-primary" /> Email delivery (Google / Gmail)
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Configure the sender address and connection used for COI requests, reminders, and confirmations. Outgoing mail is paused until you explicitly enable it.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                  emailSettings?.sending_enabled
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-amber-100 text-amber-800'
                }`}
              >
                {emailSettings?.sending_enabled ? 'Operational sending ON' : 'Operational sending PAUSED'}
              </span>
              <button
                type="button"
                onClick={loadEmailSettings}
                disabled={emailLoading}
                className="btn-outline text-xs px-2.5 py-1 flex items-center gap-1.5"
              >
                <RefreshCw className={`w-3 h-3 ${emailLoading ? 'animate-spin' : ''}`} /> Refresh
              </button>
            </div>
          </div>

          {!emailSettings?.sending_enabled && (
            <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-xs flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Master sending switch is OFF</p>
                <p className="text-[11px] text-amber-800 mt-0.5">
                  Real outgoing emails are paused — COI request emails, expiration reminders, and confirmation outreach will be simulated (logged only). Test emails below still send for verification. Turn the switch on only after a successful test.
                </p>
              </div>
            </div>
          )}

          {emailSaveMsg && (
            <div
              className={`p-2.5 rounded-lg text-xs flex items-center gap-2 ${
                emailSaveMsg.ok ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-rose-50 text-rose-800 border border-rose-200'
              }`}
            >
              {emailSaveMsg.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
              {emailSaveMsg.text}
            </div>
          )}

          <form onSubmit={saveEmailSettingsForm} className="space-y-3 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">Sender name</label>
                <input
                  type="text"
                  value={emailFromName}
                  onChange={(e) => setEmailFromName(e.target.value)}
                  placeholder="Capital Restoration"
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                  Sender email (editable)
                </label>
                <input
                  type="email"
                  value={emailFromEmail}
                  onChange={(e) => setEmailFromEmail(e.target.value)}
                  placeholder="backoffice@capitalcrestoration.com"
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-xs font-mono text-[11px]"
                />
                <p className="text-[10px] text-slate-400 mt-1">
                  Must be an address you can send from with Google (the account or a verified send-as alias).
                </p>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">Reply-to (optional)</label>
                <input
                  type="email"
                  value={emailReplyTo}
                  onChange={(e) => setEmailReplyTo(e.target.value)}
                  placeholder="support@capitalcrestoration.com"
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-xs font-mono text-[11px]"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-1">
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">Mailing provider</label>
                <select
                  value={emailProvider}
                  onChange={(e) => setEmailProvider(e.target.value as any)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-xs bg-white"
                >
                  <option value="gmail">Google / Gmail SMTP</option>
                  <option value="smtp">Custom SMTP</option>
                  <option value="postmark">Postmark</option>
                  <option value="sendgrid">SendGrid</option>
                  <option value="simulated">Simulated (no real mail)</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">SMTP host</label>
                <input
                  type="text"
                  value={emailProvider === 'gmail' ? 'smtp.gmail.com' : emailSmtpHost}
                  onChange={(e) => setEmailSmtpHost(e.target.value)}
                  disabled={emailProvider === 'gmail'}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-xs font-mono text-[11px] disabled:bg-slate-100"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">SMTP port</label>
                <input
                  type="number"
                  value={emailProvider === 'gmail' ? 587 : emailSmtpPort}
                  onChange={(e) => setEmailSmtpPort(Number(e.target.value))}
                  disabled={emailProvider === 'gmail'}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-xs disabled:bg-slate-100"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">SMTP username</label>
                <input
                  type="text"
                  value={emailProvider === 'gmail' ? emailFromEmail : emailSmtpUser}
                  onChange={(e) => setEmailSmtpUser(e.target.value)}
                  disabled={emailProvider === 'gmail'}
                  placeholder={emailProvider === 'gmail' ? emailFromEmail : 'username'}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-xs font-mono text-[11px] disabled:bg-slate-100"
                />
              </div>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-2 border-t border-slate-100">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={emailSendingEnabled}
                  onChange={(e) => setEmailSendingEnabled(e.target.checked)}
                  className="rounded border-slate-300 text-brand-primary"
                />
                <span className="text-[11px] font-semibold text-slate-700">
                  Enable operational COI emails (starts real sending of requests, reminders, and confirmations)
                </span>
              </label>
              <div className="flex items-center gap-2 self-end sm:self-auto">
                <button
                  type="submit"
                  disabled={emailSaving}
                  className="btn-primary text-xs px-3 py-1.5 disabled:opacity-60"
                >
                  {emailSaving ? 'Saving…' : 'Save settings'}
                </button>
              </div>
            </div>
          </form>

          {/* Test email panel */}
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                <Mail className="w-3.5 h-3.5 text-brand-primary" /> Send a test email
              </p>
              <span className="text-[10px] text-slate-500">Always attempts real delivery, ignoring the pause switch</span>
            </div>
            <form onSubmit={sendEmailTest} className="flex flex-col sm:flex-row gap-2">
              <input
                type="email"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder="test-recipient@yourcompany.com"
                className="flex-1 px-3 py-2 rounded-lg border border-slate-200 text-xs font-mono text-[11px] bg-white"
              />
              <button
                type="submit"
                disabled={testBusy || !testTo.trim()}
                className="btn-primary text-xs px-3 py-2 disabled:opacity-60 whitespace-nowrap"
              >
                {testBusy ? 'Sending test…' : 'Send test email'}
              </button>
            </form>
            {testResult && (
              <div
                className={`p-2 rounded text-xs flex items-start gap-2 ${
                  testResult.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'
                }`}
              >
                {testResult.ok ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />}
                <div>
                  <p className="font-semibold">{testResult.ok ? 'Test email accepted for delivery' : 'Test send failed'}</p>
                  {testResult.error && <p className="text-[11px] mt-0.5 font-mono break-all">{testResult.error}</p>}
                </div>
              </div>
            )}
            <div className="text-[10px] text-slate-500 flex flex-wrap gap-3 pt-1">
              <span>Last test: {emailSettings?.last_test_at ? new Date(emailSettings.last_test_at).toLocaleString() : 'never'}</span>
              <span>Recipient: {emailSettings?.last_test_to || '—'}</span>
              <span>
                Result:{' '}
                <strong
                  className={
                    emailSettings?.last_test_status === 'sent'
                      ? 'text-emerald-700'
                      : emailSettings?.last_test_status === 'failed'
                      ? 'text-rose-700'
                      : ''
                  }
                >
                  {emailSettings?.last_test_status || '—'}
                </strong>
              </span>
            </div>
            {emailSettings?.last_test_error && (
              <p className="text-[10px] text-rose-700 font-mono break-all">
                Last error: {emailSettings.last_test_error}
              </p>
            )}
          </div>

          {/* Setup guide */}
          <div className="rounded-lg border border-slate-200 text-xs overflow-hidden">
            <button
              type="button"
              onClick={() => setGuideOpen(!guideOpen)}
              className="w-full flex items-center justify-between p-3 bg-slate-50 hover:bg-slate-100 text-left font-semibold text-slate-800"
            >
              <span>How to connect Google / Gmail (App Password + Railway variable)</span>
              {guideOpen ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
            </button>
            {guideOpen && (
              <div className="p-3 space-y-2 bg-white text-[11px] text-slate-600">
                <ol className="list-decimal list-inside space-y-1">
                  <li>In the Google account for <strong>{emailFromEmail || 'backoffice@capitalcrestoration.com'}</strong>, make sure <strong>2-Step Verification</strong> is turned on (Google Account → Security).</li>
                  <li>Create a new <strong>App Password</strong> (Security → 2-Step Verification → App passwords). Name it e.g. <em>SafeCOI</em>. Google gives you a 16-character code — copy it now; you can’t view it again.</li>
                  <li>In <strong>Railway → your service → Variables</strong>, add <code>SMTP_PASS</code> with the app password as its value (spaces optional).</li>
                  <li>Optional: keep host <code>smtp.gmail.com</code> and port <code>587</code> above (already defaulted).</li>
                  <li>Come back here, click <strong>Send test email</strong> with your own address. Once you receive the test email, check <em>Enable operational COI emails</em> and click <strong>Save settings</strong>.</li>
                </ol>
                <div className="pt-2 border-t border-slate-100 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-500">Railway credential status:</span>
                    <span
                      className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                        emailSettings?.smtp_pass_configured
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-rose-100 text-rose-800'
                      }`}
                    >
                      {emailSettings?.smtp_pass_configured
                        ? `App password configured (${emailSettings?.smtp_pass_source})`
                        : 'No app password detected'}
                    </span>
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-600 mb-1">
                      Or save the app password here (stored server-side, never shown again):
                    </label>
                    <input
                      type="password"
                      value={emailSmtpPass}
                      onChange={(e) => setEmailSmtpPass(e.target.value)}
                      placeholder={emailSettings?.smtp_pass_configured ? '••••••••  (unchanged)' : '16-character app password'}
                      className="w-full sm:w-80 px-3 py-1.5 rounded-lg border border-slate-200 font-mono text-[11px] bg-white"
                    />
                    <p className="text-[10px] text-slate-400 mt-1">
                      Leave blank to keep the existing value. Railway Variables are preferred for production.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Change plan modal */}
      {planModal.open && planModal.company && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setPlanModal({ open: false, company: null, newPlan: '', reason: '' })}>
          <div className="bg-white rounded-2xl max-w-md w-full p-5 space-y-4 shadow-xl border border-slate-200" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Change company plan</h3>
                <p className="text-xs text-slate-500 mt-0.5">{planModal.company.name}</p>
              </div>
              <button onClick={() => setPlanModal({ open: false, company: null, newPlan: '', reason: '' })} className="text-slate-400 hover:text-slate-700">×</button>
            </div>
            <div className="text-xs bg-slate-50 rounded-lg p-3 text-slate-600">
              Current: <strong>{planModal.company.plan || 'Free Demo'}</strong> · MRR <strong>${(planModal.company.mrr || 0).toLocaleString()}/mo</strong>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">New plan</label>
              <select
                value={planModal.newPlan}
                onChange={(e) => setPlanModal((m) => ({ ...m, newPlan: e.target.value }))}
                className="w-full text-xs border border-slate-300 rounded-lg px-2.5 py-2 bg-white focus:outline-none focus:border-slate-500"
              >
                {GC_PLANS.map((gp) => (
                  <option key={gp.plan} value={gp.plan}>{gp.plan} · ${gp.price}/mo</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Reason (required)</label>
              <input
                type="text"
                placeholder="e.g. upgraded to Pro after demo call; invoiced annually"
                value={planModal.reason}
                onChange={(e) => setPlanModal((m) => ({ ...m, reason: e.target.value }))}
                className="w-full text-xs border border-slate-300 rounded-lg px-2.5 py-2 bg-white focus:outline-none focus:border-slate-500"
              />
              <p className="text-[11px] text-slate-400 mt-1">Logged to the plan change audit trail</p>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" className="text-xs" onClick={() => setPlanModal({ open: false, company: null, newPlan: '', reason: '' })}>
                Cancel
              </Button>
              <Button className="text-xs" onClick={confirmPlanChange} disabled={!planModal.reason.trim() || savingPlanId === planModal.company.id}>
                {savingPlanId === planModal.company.id ? 'Saving…' : 'Confirm & save'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Change role modal */}
      {roleModal.open && roleModal.user && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setRoleModal({ open: false, user: null, newRole: 'gc' })}>
          <div className="bg-white rounded-2xl max-w-sm w-full p-5 space-y-4 shadow-xl border border-slate-200" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Change role</h3>
                <p className="text-xs text-slate-500 mt-0.5">{roleModal.user.name || roleModal.user.email}</p>
              </div>
              <button onClick={() => setRoleModal({ open: false, user: null, newRole: 'gc' })} className="text-slate-400 hover:text-slate-700">×</button>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">New role</label>
              <select
                value={roleModal.newRole}
                onChange={(e) => setRoleModal((m) => ({ ...m, newRole: e.target.value as any }))}
                className="w-full text-xs border border-slate-300 rounded-lg px-2.5 py-2 bg-white focus:outline-none focus:border-slate-500"
              >
                <option value="admin">Admin</option>
                <option value="gc">GC</option>
                <option value="pro_gc">Pro GC</option>
                <option value="sub">Sub C</option>
              </select>
              <p className="text-[11px] text-slate-400 mt-1">
                {roleModal.newRole === 'admin' ? 'Admins have full platform access.' : roleModal.newRole === 'pro_gc' ? 'Pro GC users automatically get the Pro GC plan.' : ''}
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" className="text-xs" onClick={() => setRoleModal({ open: false, user: null, newRole: 'gc' })}>
                Cancel
              </Button>
              <Button className="text-xs" onClick={confirmRoleChange}>
                Confirm role
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Reset demo data modal */}
      {resetModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setResetModalOpen(false)}>
          <div className="bg-white rounded-2xl max-w-md w-full p-5 space-y-4 shadow-xl border border-slate-200" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-bold text-slate-900">Reset all demo data?</h3>
            <p className="text-xs text-slate-600">
              This restores the full seeded dataset — companies, users, subcontractors, and COIs. Real staff accounts are unaffected. Use for a fresh demo environment.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" className="text-xs" onClick={() => setResetModalOpen(false)}>
                Cancel
              </Button>
              <Button variant="danger" className="text-xs" onClick={handleResetData}>
                Reset data
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Admin user password reset modal */}
      {pwResetModal.open && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setPwResetModal({ open: false, user: null })}>
          <div className="bg-white rounded-2xl max-w-sm w-full p-5 space-y-4 shadow-xl border border-slate-200" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-brand-primary" /> Reset user password
              </h3>
              <button type="button" onClick={() => setPwResetModal({ open: false, user: null })} className="text-slate-400 hover:text-slate-600 text-xs font-semibold">✕</button>
            </div>
            <p className="text-xs text-slate-500 truncate">
              Setting a new password for <span className="font-semibold text-slate-800">{pwResetModal.user?.email}</span>
            </p>
            <div className="space-y-2 text-xs">
              <div className="relative">
                <input
                  type={pwResetShow ? 'text' : 'password'}
                  value={pwResetValue}
                  onChange={(e) => setPwResetValue(e.target.value)}
                  placeholder="New password (min 8 characters)"
                  className="w-full px-3 py-2 pr-9 rounded-xl border border-slate-200 font-mono text-xs"
                />
                <button type="button" onClick={() => setPwResetShow(!pwResetShow)} className="absolute right-2 top-2 text-slate-400">{pwResetShow ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}</button>
              </div>
              <div className="flex items-center justify-between text-[11px] text-slate-500">
                <button type="button" onClick={genTempPassword} className="font-semibold text-brand-primary hover:underline">🎲 Generate temporary</button>
                <button type="button" onClick={copyTempPw} className="font-semibold text-slate-600 hover:underline">{copied ? '✓ Copied' : 'Copy'}</button>
              </div>
            </div>
            {pwResetMsg && (
              <div className={`p-2 rounded-lg text-xs flex items-center gap-2 ${pwResetMsg.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'}`}>
                {pwResetMsg.ok ? <Check className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />} {pwResetMsg.text}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" className="text-xs" onClick={() => setPwResetModal({ open: false, user: null })}>Cancel</Button>
              <Button className="text-xs" disabled={pwResetSaving} onClick={confirmPwReset}>{pwResetSaving ? 'Saving…' : 'Set password'}</Button>
            </div>
          </div>
        </div>
      )}

      {/* Article edit / create modal */}
      {articleModal.open && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto"
          onClick={() => setArticleModal({ open: false, mode: 'create' })}
        >
          <div
            className="bg-white rounded-2xl max-w-4xl w-full p-6 space-y-4 shadow-xl border border-slate-200 my-8 text-xs text-slate-700"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between pb-3 border-b border-slate-100">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  {articleModal.mode === 'create' ? 'New article' : 'Edit article'}
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Changes appear live at safecoi.com/articles after saving
                </p>
              </div>
              <button
                onClick={() => setArticleModal({ open: false, mode: 'create' })}
                className="text-slate-400 hover:text-slate-700 text-lg px-1"
              >
                ×
              </button>
            </div>

            {articleError && (
              <div className="p-2 rounded-lg text-xs bg-rose-50 text-rose-800 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" /> {articleError}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="md:col-span-2">
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Title *</label>
                <input
                  type="text"
                  value={artTitle}
                  onChange={(e) => {
                    const v = e.target.value
                    setArtTitle(v)
                    if (!slugTouched && articleModal.mode === 'create') {
                      setArtSlug(v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
                    }
                  }}
                  placeholder="e.g. How General Contractors Pass a Workers' Comp Audit"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-xs font-semibold focus:outline-none focus:border-slate-500"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  Slug * (kebab-case, part of the URL)
                </label>
                <div className="flex items-center">
                  <span className="text-[11px] text-slate-400 font-mono px-2 py-2 bg-slate-100 border border-r-0 border-slate-300 rounded-l-lg select-none">
                    /articles/
                  </span>
                  <input
                    type="text"
                    value={artSlug}
                    onChange={(e) => {
                      setSlugTouched(true)
                      setArtSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                    }}
                    placeholder="my-article-title"
                    className="flex-1 font-mono border border-slate-300 rounded-r-lg px-3 py-2 text-xs focus:outline-none focus:border-slate-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Category / tag *</label>
                <input
                  type="text"
                  value={artTag}
                  onChange={(e) => setArtTag(e.target.value)}
                  placeholder="e.g. Endorsements & Coverage"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-slate-500"
                />
                <div className="flex flex-wrap gap-1 mt-1">
                  {tagSuggestions.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setArtTag(t)}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-600 font-medium"
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Reading time (minutes)</label>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={artReadingTime}
                  onChange={(e) => setArtReadingTime(parseInt(e.target.value || '6', 10))}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-slate-500"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Status</label>
                <select
                  value={artStatus}
                  onChange={(e) => setArtStatus(e.target.value as 'published' | 'draft')}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-xs bg-white focus:outline-none focus:border-slate-500"
                >
                  <option value="published">Published</option>
                  <option value="draft">Draft (hidden from hub & search)</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  Order position (0 = top of hub)
                </label>
                <input
                  type="number"
                  min={0}
                  value={artPosition}
                  onChange={(e) => setArtPosition(parseInt(e.target.value || '0', 10))}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-slate-500"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">OG image URL (optional)</label>
                <input
                  type="url"
                  value={artOgImage}
                  onChange={(e) => setArtOgImage(e.target.value)}
                  placeholder="https://…/image.png (leave blank for default)"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:border-slate-500"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  Short description * (hub card snippet + meta description)
                </label>
                <textarea
                  rows={2}
                  value={artDescription}
                  onChange={(e) => setArtDescription(e.target.value)}
                  placeholder="1–2 practical sentences summarizing the article"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-slate-500"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-bold text-slate-700">Body HTML *</label>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-400">
                    {artBodyHtml.replace(/<[^>]+>/g, '').trim().split(/\s+/).filter(Boolean).length} words ·{' '}
                    {artBodyHtml.length} chars
                  </span>
                  <div className="flex rounded-md border border-slate-200 overflow-hidden text-[11px]">
                    <button
                      type="button"
                      onClick={() => setArtPreview(false)}
                      className={`px-2.5 py-1 font-semibold ${
                        !artPreview ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      Write HTML
                    </button>
                    <button
                      type="button"
                      onClick={() => setArtPreview(true)}
                      className={`px-2.5 py-1 font-semibold ${
                        artPreview ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      Preview
                    </button>
                  </div>
                </div>
              </div>
              <p className="text-[11px] text-slate-400 mb-2">
                Write raw HTML. Supports &lt;h2&gt;, &lt;p&gt;, &lt;ul&gt;, &lt;ol&gt;, &lt;strong&gt;, &lt;em&gt;,
                &lt;div class=&quot;table-wrap&quot;&gt;&lt;table&gt;, &lt;div class=&quot;callout&quot;&gt;.
              </p>
              {!artPreview ? (
                <textarea
                  rows={18}
                  value={artBodyHtml}
                  onChange={(e) => setArtBodyHtml(e.target.value)}
                  placeholder="<h2>Section heading</h2>&#10;<p>Paragraph text…</p>"
                  className="w-full border border-slate-300 rounded-lg p-3 font-mono text-[11px] leading-relaxed focus:outline-none focus:border-slate-500 bg-slate-50"
                  spellCheck={false}
                />
              ) : (
                <div className="border border-slate-300 rounded-lg p-5 bg-white max-h-[500px] overflow-y-auto">
                  <div className="text-[11px] uppercase tracking-wider font-bold text-slate-400 mb-1">{artTag}</div>
                  <h1 className="text-xl font-bold font-serif text-slate-900 mb-2">{artTitle || 'Untitled'}</h1>
                  <p className="text-[11px] text-slate-400 mb-4 font-mono">{artReadingTime} min read</p>
                  <div
                    className="text-xs text-slate-800 leading-relaxed space-y-3 font-serif [&_h2]:text-base [&_h2]:font-bold [&_h2]:text-slate-900 [&_h2]:mt-5 [&_h2]:mb-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_.table-wrap]:overflow-x-auto [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-slate-300 [&_th]:p-1.5 [&_th]:bg-slate-50 [&_td]:border [&_td]:border-slate-300 [&_td]:p-1.5 [&_.callout]:border-l-4 [&_.callout]:border-brand-primary [&_.callout]:bg-slate-50 [&_.callout]:p-3 [&_.callout]:rounded-r-md"
                    dangerouslySetInnerHTML={{ __html: artBodyHtml || '<p class="text-slate-400 italic">No content yet</p>' }}
                  />
                </div>
              )}
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 pt-2 border-t border-slate-100">
              <div>
                {articleModal.mode === 'edit' && (
                  <button
                    type="button"
                    onClick={() => {
                      const full = articles.find((a) => a.id === articleModal.id)
                      if (full) setArticleDeleteModal({ open: true, article: full })
                    }}
                    className="text-xs text-rose-600 hover:underline font-semibold"
                  >
                    Delete this article…
                  </button>
                )}
              </div>
              <div className="flex items-center justify-end gap-2">
                {articleModal.mode === 'edit' && artStatus === 'published' && artSlug && (
                  <a
                    href={`/articles/${artSlug}/`}
                    target="_blank"
                    rel="noopener"
                    className="text-xs text-brand-primary hover:underline font-semibold inline-flex items-center gap-1 mr-2"
                  >
                    View live <ExternalLink className="w-3 h-3" />
                  </a>
                )}
                <Button
                  variant="secondary"
                  className="text-xs"
                  onClick={() => setArticleModal({ open: false, mode: 'create' })}
                >
                  Cancel
                </Button>
                <Button className="text-xs" disabled={articleSaving} onClick={saveArticle}>
                  {articleSaving ? 'Saving…' : articleModal.mode === 'create' ? 'Create article' : 'Save article'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Article delete confirmation modal */}
      {articleDeleteModal.open && articleDeleteModal.article && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
          onClick={() => setArticleDeleteModal({ open: false, article: null })}
        >
          <div
            className="bg-white rounded-2xl max-w-sm w-full p-5 space-y-3 shadow-xl border border-slate-200 text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-full bg-rose-100 flex items-center justify-center shrink-0">
                <Trash2 className="w-4 h-4 text-rose-600" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-slate-900">Delete article?</h3>
                <p className="text-slate-500 mt-1">
                  <strong>{articleDeleteModal.article.title}</strong>
                </p>
                <p className="text-[11px] font-mono text-slate-400 mt-0.5">
                  /articles/{articleDeleteModal.article.slug}/
                </p>
              </div>
            </div>
            <p className="text-slate-600">
              This permanently removes the article from the database. Its URL will return a 404 page and it will
              disappear from the articles hub and the sitemap. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="secondary"
                className="text-xs"
                onClick={() => setArticleDeleteModal({ open: false, article: null })}
              >
                Cancel
              </Button>
              <button
                type="button"
                disabled={articleDeleting}
                onClick={deleteArticle}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-600 hover:bg-rose-700 text-white disabled:opacity-50"
              >
                {articleDeleting ? 'Deleting…' : 'Delete article'}
              </button>
            </div>
          </div>
        </div>
      )}
      {fieldsReview !== null && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4">
          <div className="my-8 w-full max-w-4xl rounded-2xl bg-white p-6 shadow-2xl">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Review document data</h2>
                <p className="text-xs text-slate-500">{fieldsReview.coiCompany} · edit extracted dates, amounts, carrier and policies, then Save</p>
              </div>
              <div className="flex items-center gap-2">
                {fieldsReview.hasFile && (
                  <button
                    type="button"
                    onClick={() => void handleViewCert(fieldsReview.coiId)}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    View certificate file <ExternalLink className="h-4 w-4" />
                  </button>
                )}
                {fieldsReview.hasFile && (
                  <button
                    type="button"
                    disabled={fieldsReview.saving || fieldsReview.extracting}
                    onClick={() => void runExtractInReview()}
                    className="inline-flex items-center gap-1 rounded-lg bg-brand-700 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-50"
                  >
                    <Sparkles className={`w-4 h-4 ${fieldsReview.extracting ? 'animate-spin' : ''}`} />
                    {fieldsReview.extracting ? 'Extracting…' : 'Re-extract with AI'}
                  </button>
                )}
              </div>
            </div>
            {fieldsReview.loading ? (
              <div className="flex items-center justify-between gap-4 py-8">
                <p role="status" className="text-sm text-slate-600">Loading document fields…</p>
                <button type="button" onClick={closeFieldsReview} className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100">Close</button>
              </div>
            ) : fieldsReview.details ? (
              <CoiFieldsReview
                details={fieldsReview.details}
                onChange={(details) => setFieldsReview((c) => c && !c.saving ? { ...c, details } : c)}
                onSave={() => void saveFieldsReview()}
                onClose={closeFieldsReview}
                saving={fieldsReview.saving}
                editable={fieldsReview.editable}
                error={fieldsReview.error}
              />
            ) : (
              <div className="space-y-4 py-6 text-center">
                <p role="status" className="text-sm text-slate-600">No structured fields have been saved yet for this certificate.</p>
                <div className="flex justify-center gap-2">
                  <button type="button" onClick={() => void runExtractInReview()} className="rounded-lg bg-brand-700 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-800">
                    Extract with AI
                  </button>
                  <button type="button" onClick={closeFieldsReview} className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100">Close</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </StaffSidebar>
  )
}
