// pdf.js 5.x calls Map.prototype.getOrInsertComputed / getOrInsert (TC39 "Map.getOrInsert"
// proposal methods) without polyfilling them, and the Electron/Chromium runtime does not yet
// implement them natively. They are used while parsing AcroForm annotations and some content,
// so without this PDFs with form fields fail to render and getAnnotations throws. This module is
// imported by BOTH the main thread (main.tsx) and the pdf.js worker (pdfjs-worker.ts), since the
// worker runs in a separate realm with its own Map.prototype.
const proto = Map.prototype as unknown as Record<string, unknown>

if (typeof proto.getOrInsertComputed !== 'function') {
  proto.getOrInsertComputed = function (
    this: Map<unknown, unknown>,
    key: unknown,
    compute: (key: unknown) => unknown
  ) {
    if (!this.has(key)) this.set(key, compute(key))
    return this.get(key)
  }
}

if (typeof proto.getOrInsert !== 'function') {
  proto.getOrInsert = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
    if (!this.has(key)) this.set(key, value)
    return this.get(key)
  }
}
