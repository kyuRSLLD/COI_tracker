Local browser OCR assets

Tesseract.js 6.0.1: tesseract.min.js and worker.min.js copied from the pinned npm package.
Tesseract.js-core 6.1.2: LSTM SIMD and non-SIMD .wasm.js files copied from the npm dependency resolved in package-lock.json. These bundles embed the WASM; no separate WASM download is needed. The supervisor requests only LSTM mode, so legacy builds are intentionally omitted.

English model: official tesseract-ocr/tessdata_fast release 4.1.0, commit 65727574dfcd264acbb0c3e07860e4e9e9b22185.
https://github.com/tesseract-ocr/tessdata_fast/blob/65727574dfcd264acbb0c3e07860e4e9e9b22185/eng.traineddata
Git blob SHA-1 (independently checked against GitHub's API): bbef4675053b5b468cdb477053e28b1c698ba08e
SHA-256: 7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2
The fast LSTM-only model is selected to limit download size and recognition time. OCR is error-prone; human review is required. The model is Apache-2.0 licensed, as are the Tesseract.js and Tesseract.js-core packages; see bundled licenses.

These paths must be served together from the same origin beneath Vite's BASE_URL. The OCR code explicitly configures local paths, disables IndexedDB language caching, and does not fall back to a CDN. Deployments using CSP must permit same-origin worker/script/connect requests and WebAssembly execution.
