import jsQR from 'jsqr'

// Test-only: decode the actual SVG locally, never upload or log the capability.
export async function decodeRelationshipQr(): Promise<string | undefined> {
  const svg = document.querySelector('svg[aria-label="One-use relationship QR containing the bearer token"]')
  if (!svg) throw new Error('QR missing')
  const image = new Image()
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = 416; canvas.height = 416
  const context = canvas.getContext('2d')!
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  return jsQR(pixels.data, pixels.width, pixels.height)?.data
}
