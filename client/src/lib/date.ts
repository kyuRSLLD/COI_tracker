export function formatDisplayDate(s?: string | null): string {
  if (!s) return '—'
  const t = s.trim()
  if (!t) return '—'
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(t)) return t
  const m1 = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
  if (m1) return `${m1[2].padStart(2, '0')}/${m1[3].padStart(2, '0')}/${m1[1]}`
  const m2 = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/)
  if (m2) {
    const y = m2[3].length === 2 ? `20${m2[3]}` : m2[3]
    return `${m2[1].padStart(2, '0')}/${m2[2].padStart(2, '0')}/${y}`
  }
  return t
}

export function parseDateSafe(s?: string | null): Date | null {
  if (!s) return null
  const t = s.trim()
  if (!t) return null
  const m1 = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
  if (m1) {
    const d = new Date(Number(m1[1]), Number(m1[2]) - 1, Number(m1[3]))
    return Number.isNaN(d.getTime()) ? null : d
  }
  const m2 = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/)
  if (m2) {
    const y = m2[3].length === 2 ? Number(`20${m2[3]}`) : Number(m2[3])
    const d = new Date(y, Number(m2[1]) - 1, Number(m2[2]))
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

export function daysFromNow(s?: string | null): number | null {
  const d = parseDateSafe(s)
  if (!d) return null
  return Math.ceil((d.getTime() - Date.now()) / 86400000)
}

export function isExpiredDate(s?: string | null): boolean {
  const n = daysFromNow(s)
  return n !== null && n < 0
}
