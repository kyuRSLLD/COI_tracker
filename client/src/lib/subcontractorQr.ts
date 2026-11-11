import { isInviteToken } from './stagedInvites'
/** Never navigate to a scanned value; only accept exact same-origin fragment links. */
export function parseSubcontractorQr(value: string, origin: string): string | null {
  if (value.length > 2048 || /[\s\\\x00-\x1f\x7f]/.test(value)) return null
  try {
    const base = new URL(origin)
    if (base.origin !== origin || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) return null
    const prefix = value.startsWith('/') && !value.startsWith('//') ? '' : origin
    if (!value.startsWith(`${prefix}/connect-sub#`)) return null
    const token = value.slice(`${prefix}/connect-sub#`.length)
    return isInviteToken(token) ? token : null
  } catch { return null }
}
