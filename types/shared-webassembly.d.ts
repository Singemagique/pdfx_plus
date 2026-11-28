// The WebAssembly globals for `typecheck:shared` only (tsconfig.shared.json). That project checks
// src/shared/** with `lib: ["ESNext"]` and Node's types, so neither DOM nor WebWorker globals exist
// there; but WebAssembly is a JavaScript global in every realm src/shared runs in (Node, Electron's
// utility process and its worker_threads, the renderer), and the OCR loader (engine/tess-core.ts)
// uses it. The node and web projects get the full declarations from TypeScript's default libs, so
// this file is deliberately NOT under src/ (they would see two declarations). Only what src/shared
// uses is declared, with the same shapes as lib.dom.d.ts.

declare namespace WebAssembly {
  interface Module {}
  var Module: {
    prototype: Module
    new (bytes: ArrayBufferView | ArrayBuffer): Module
  }

  interface Instance {
    readonly exports: Exports
  }
  var Instance: {
    prototype: Instance
    new (module: Module, importObject?: Imports): Instance
  }

  interface Memory {
    readonly buffer: ArrayBuffer
  }
  var Memory: {
    prototype: Memory
    new (descriptor: { initial: number; maximum?: number; shared?: boolean }): Memory
  }

  interface RuntimeError extends Error {}
  var RuntimeError: {
    prototype: RuntimeError
    new (message?: string): RuntimeError
    (message?: string): RuntimeError
  }

  type ExportValue = unknown
  type Exports = Record<string, ExportValue>
  type ImportValue = unknown
  type ModuleImports = Record<string, ImportValue>
  type Imports = Record<string, ModuleImports>

  function compile(bytes: ArrayBufferView | ArrayBuffer): Promise<Module>
  function instantiate(moduleObject: Module, importObject?: Imports): Promise<Instance>
}
