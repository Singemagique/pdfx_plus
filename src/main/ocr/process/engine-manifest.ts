// The compiled engine manifest (DESIGN.md §3.2.1, §3.2.6): every Tesseract file PDFx ships, with
// its exact size and SHA-256. The coordinator checks the core and each traineddata against it
// before compiling or using them, and `engine-manifest.node.test.ts` checks that every
// electron-builder `extraResources` source still has these bytes, so a renamed or updated package
// fails CI rather than users. In 1.1.4 the engine never parses a model file not hashed here.
//
// Values [measured, PR0 `inventory.mjs`, re-measured for PR5 with node:crypto over node_modules]:
// tesseract.js-core 7.0.0 and @tesseract.js-data/{eng,deu,fra,spa} 1.0.0, `4.0.0_best_int` only.

export interface ManifestFile {
  /** Base name under resources/ocr (core) or resources/ocr/tessdata (data). */
  file: string
  /** The npm source electron-builder copies from (repo-relative). */
  source: string
  bytes: number
  sha256: string
}

export interface ManifestData extends ManifestFile {
  /** The gunzipped .traineddata. */
  rawBytes: number
  rawSha256: string
}

export const ENGINE_CORE = {
  js: {
    file: 'tesseract-core-simd-lstm.js',
    source: 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.js',
    bytes: 89_271,
    sha256: 'e48e2f02ddae3716c8dd24bf41cd290d4efa96892d689cdc4013c2545d63f469'
  },
  wasm: {
    file: 'tesseract-core-simd-lstm.wasm',
    source: 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm',
    bytes: 2_857_601,
    sha256: '34e8d50cac216427d86bf397d610fdd9f49492539bbcdfbfccc4eda20c810bea'
  }
} as const satisfies Record<'js' | 'wasm', ManifestFile>

const data = (lang: string, bytes: number, sha256: string, rawBytes: number, rawSha256: string) =>
  ({
    file: `${lang}.traineddata.gz`,
    source: `node_modules/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`,
    bytes,
    sha256,
    rawBytes,
    rawSha256
  }) satisfies ManifestData

/** The bundled languages (D1 b). */
export const ENGINE_DATA: Readonly<Record<string, ManifestData>> = {
  eng: data(
    'eng',
    2_952_873,
    '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91',
    5_199_098,
    '5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747'
  ),
  deu: data(
    'deu',
    1_333_102,
    '306c4280d0cbed46fbff727486bd43b92730181bae80f56941a091f363bdf28b',
    2_070_514,
    'a1b72cc25753eac167edfef5af4448a8dc34973503a2265c34c84520f896eb03'
  ),
  fra: data(
    'fra',
    707_406,
    'd611139672b3752c7097e671e4a1d9209dfd37f2aeb081ef6487fba3351e9255',
    1_248_107,
    'bf83833fa957ff0076f6aa93f69e3bdf7b014dea829ea0c0d6be6b48a3ceef6d'
  ),
  spa: data(
    'spa',
    2_100_190,
    '40be52f97b5d4eb7460073dc1f94cd546b27150333c0bf854ed7e7132db6bceb',
    3_379_457,
    '0062377729b81cc268b1822f09eb1c08c09f3f7f1c6b422540b51555a7eeea70'
  )
}

export const BUNDLED_LANGS = Object.keys(ENGINE_DATA)

/** Where electron-builder puts them, relative to `process.resourcesPath`. */
export const RESOURCES_OCR_DIR = 'ocr'
export const RESOURCES_TESSDATA_DIR = 'ocr/tessdata'
