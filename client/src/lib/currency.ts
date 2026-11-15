export function formatAmount(s?: string | null): string {
  if (!s) return '—'
  const raw = String(s).replace(/[$,]/g, '').trim()
  if (!raw) return '—'
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return String(s).trim()
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
