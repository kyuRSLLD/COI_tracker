import { request } from '../api'

// Bind this action to the session that loaded the displayed connection, rather
// than allowing a newly switched tab identity to remove the same GC's link.
export function removeSubConnection(gcId: string, expectedToken: string) {
  return request<{ success: boolean }>(`/api/sub/connections/${encodeURIComponent(gcId)}`, { method: 'DELETE' }, true, expectedToken)
}
