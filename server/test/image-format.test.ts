import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { normalizeImage, isTextractCompatible } from '../src/services/imageFormat.ts'

test('normalizeImage identifies PDF and PNG', async () => {
  const pdf = await normalizeImage(Buffer.from('%PDF-1.4...'), 'x.pdf')
  assert.equal(pdf!.mime, 'application/pdf')
  const png = await normalizeImage(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]), 'x.png')
  assert.equal(png!.mime, 'image/png')
})
test('normalizeImage converts HEIC to JPEG', async () => {
  const heic = await fs.readFile('/home/ubuntu/upload/IMG_1619.HEIC')
  const res = await normalizeImage(heic, 'IMG_1619.HEIC')
  assert.ok(res)
  assert.equal(res!.mime, 'image/jpeg')
  assert.equal(res!.buffer[0], 0xff)
  assert.equal(res!.buffer[1], 0xd8)
})
test('isTextractCompatible', () => {
  assert.equal(isTextractCompatible('image/jpeg'), true)
  assert.equal(isTextractCompatible('image/heic'), false)
})
