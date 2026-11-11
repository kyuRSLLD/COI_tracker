export const stagedInvitesEnabled = import.meta.env.DEV && import.meta.env.VITE_STAGED_INVITES_ENABLED === 'true'
export const previewNotice = 'Development preview — requests are not yet connected to the live subcontractor dashboard or COIs'
export const pendingInviteKey = 'coi_staged_invite'

// The server owns token entropy. Restrict the alphabet to unencoded base64url/hex.
export function isInviteToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value)
}
export function previewLink(path: '/invite-sub' | '/connect-sub', token: unknown): string {
  if (!isInviteToken(token)) throw new Error('Invalid invitation')
  const { origin, protocol, hostname } = window.location
  if (protocol !== 'https:' && !(protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(hostname))) throw new Error('Secure origin required')
  return `${origin}${path}#${token}`
}
