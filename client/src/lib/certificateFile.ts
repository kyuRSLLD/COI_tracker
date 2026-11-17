import { apiCOIs } from '../api'

async function resolveUrl(coiId: string, currentUrl?: string | null): Promise<string | null> {
  if (currentUrl) return currentUrl
  try {
    const res = await apiCOIs.get(coiId)
    return res.coi.certificate_url || null
  } catch {
    return null
  }
}

export async function viewCertificate(coi: { id: string; certificate_url?: string | null }): Promise<void> {
  const url = await resolveUrl(coi.id, coi.certificate_url)
  if (!url) {
    window.alert('The certificate file is currently unavailable. Please try again.')
    return
  }
  window.open(url, '_blank', 'noopener')
}

export async function downloadCertificate(
  coi: { id: string; certificate_url?: string | null; certificate_name?: string | null },
  fallbackName = 'certificate',
): Promise<void> {
  const url = await resolveUrl(coi.id, coi.certificate_url)
  if (!url) {
    window.alert('The certificate file is currently unavailable. Please try again.')
    return
  }
  const name = coi.certificate_name || `${fallbackName}.pdf`
  try {
    const res = await fetch(url)
    const blob = await res.blob()
    const blobUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = name
    a.click()
    URL.revokeObjectURL(blobUrl)
  } catch {
    window.open(url, '_blank', 'noopener')
  }
}
