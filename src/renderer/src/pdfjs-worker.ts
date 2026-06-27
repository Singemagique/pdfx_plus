// Custom pdf.js worker entry: install the Map polyfills (see ./pdfjs-polyfill) in the worker
// realm, then load the stock pdf.js worker. Vite bundles this via the `?worker` import in
// main.tsx, and pdf.js runs it through GlobalWorkerOptions.workerPort. Import order matters —
// the polyfill module must evaluate before the worker body uses the methods.
import './pdfjs-polyfill'
import 'pdfjs-dist/build/pdf.worker.min.mjs'
