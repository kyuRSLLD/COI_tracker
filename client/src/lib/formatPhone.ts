// JSX string attributes do not process JavaScript escapes. Use one JS string for
// every HTML pattern so the browser receives exactly one backslash per paren.
export const US_PHONE_PATTERN = String.raw`\([0-9]{3}\) [0-9]{3}-[0-9]{4}`

// Format as the user types or pastes. Keep excess digits visible so they fail
// validation rather than silently saving a different number. Accept a US +1 prefix.
export function formatPhone(raw: string): string {
  let d = (raw || '').replace(/\D/g, '')
  if (d.length === 11 && d[0] === '1') d = d.slice(1)
  if (!d) return ''
  if (d.length <= 3) return `(${d}`
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

export function isValidUsPhone(v: string): boolean {
  return /^\([0-9]{3}\) [0-9]{3}-[0-9]{4}$/.test(v || '')
}
