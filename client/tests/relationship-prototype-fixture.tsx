import React from 'react'
import { createRoot } from 'react-dom/client'
import jsQR from 'jsqr'
import { RelationshipPrototypeSub } from '../src/components/RelationshipPrototypeSub'

createRoot(document.getElementById('root')!).render(<RelationshipPrototypeSub authToken="synthetic-auth" />)

// Test-only decoding stays entirely in the browser; no image is uploaded.
;(window as unknown as { decodePrototypeQr: () => Promise<string | undefined> }).decodePrototypeQr = async () => {
  const svg = document.querySelector('svg[aria-label="One-use relationship QR containing the bearer token"]')
  if (!svg) throw new Error('QR missing')
  const image = new Image()
  const source = new XMLSerializer().serializeToString(svg)
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = 416; canvas.height = 416
  const context = canvas.getContext('2d')!
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  return jsQR(pixels.data, pixels.width, pixels.height)?.data
}
