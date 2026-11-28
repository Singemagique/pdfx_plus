// PR4a only: the "engine" module the recognize-thread skeleton receives. An empty, valid WebAssembly
// module (magic + version): enough to exercise compile-once-in-the-coordinator, the structured-clone
// post of a WebAssembly.Module to every thread, and instantiation there. PR5 replaces it with the
// SHA-checked `tesseract-core-simd-lstm.wasm` from resources/ocr (§3.2.1).

export const STUB_ENGINE_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
