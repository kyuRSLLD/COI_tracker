// Formats a raw phone string into the (xxx) xxx-xxxx mask as the user types.
export function formatPhone(raw: string): string {
  const d = (raw || '').replace(/\D/g, '').slice(0, 10)
  if (!d) return ''
  if (d.length <= 3) return `(${d}`
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

export function isValidUsPhone(v: string): boolean {
  return /^\(\d{3}\) \d{3}-\d{4}$/.test((v || '').trim())
}
