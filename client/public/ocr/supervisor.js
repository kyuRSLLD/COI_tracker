/* Dedicated supervisor: terminating it also terminates its nested Tesseract worker. */
self.onmessage = async ({ data }) => {
  let worker
  let bitmap
  try {
    const base = new URL('.', self.location.href)
    importScripts(new URL('tesseract.min.js', base).href)
    // Decode only after the caller has checked compressed size and encoded dimensions.
    bitmap = await createImageBitmap(data.file)
    const { width, height } = bitmap
    if (!width || !height || width > 6000 || height > 6000 || width * height > 20000000 ||
        !((width === data.width && height === data.height) || (width === data.height && height === data.width))) {
      throw new Error('Unsafe or inconsistent image dimensions')
    }
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('Canvas unavailable')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, width, height)
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    bitmap = undefined
    const flattened = await canvas.convertToBlob({ type: 'image/png' })
    worker = await self.Tesseract.createWorker('eng', 1, {
      workerPath: new URL('worker.min.js', base).href,
      corePath: new URL('core', base).href,
      langPath: new URL('lang', base).href,
      workerBlobURL: false,
      gzip: false,
      cacheMethod: 'none',
      logger: ({ status, progress }) => {
        if (status === 'recognizing text' && Number.isFinite(progress)) {
          self.postMessage({ kind: 'progress', progress })
        }
      },
      // Do not print OCR results or errors; generic failure is returned to the caller.
      errorHandler: () => self.postMessage({ kind: 'error' }),
    })
    await worker.setParameters({ tessedit_pageseg_mode: '11' })
    // TSV preserves word positions; do not send image data or OCR output to a server.
    const result = await worker.recognize(flattened, {}, { text: true, tsv: true })
    const tsv = result.data.tsv || ''
    self.postMessage({ kind: 'result', text: result.data.text, tsv: tsv.length <= 2_000_000 ? tsv : '', tsvTruncated: tsv.length > 2_000_000, width, height })
  } catch (_) {
    self.postMessage({ kind: 'error' })
  } finally {
    if (bitmap) bitmap.close()
    if (worker) await worker.terminate()
  }
}
