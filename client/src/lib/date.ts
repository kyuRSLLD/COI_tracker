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
