// The app settings schema (DESIGN.md §3.5.2): the keys, their defaults and the validators. Shared
// so the preload's types and main's store agree; the store itself (userData/settings.json) is
// src/main/settings.ts. DOM-free and Electron-free.

import { LANG_RE, OCR_LIMITS } from './ocr/protocol'

export interface Settings {
  /** Recognition languages, Tesseract codes, 1..3 (§3.2.5). */
  'ocr.languages': string[]
  /** Recognize pages PDFx created from imported images automatically (D4). */
  'ocr.autoRecognizeImports': boolean
  /** Recognize opened PDFs automatically. */
  'ocr.autoRecognizeOpened': boolean
  /** Correct page orientation for recognition (the OCR copy only). */
  'ocr.fixOrientation': boolean
  /** Include recognized text when exporting PDF, ZIP and .pdfx (D7; Sign has its own checkbox). */
  'ocr.includeInExports': boolean
}

/** The languages bundled with the app (D1). */
export const BUNDLED_LANGUAGES = ['eng', 'deu', 'fra', 'spa'] as const

const LOCALE_TO_TESSERACT: Record<string, string> = { en: 'eng', de: 'deu', fr: 'fra', es: 'spa' }

/** The UI locale's language if it is bundled, plus English (§3.2.5). */
export function defaultLanguages(locale: string): string[] {
  const code = LOCALE_TO_TESSERACT[locale.toLowerCase().split(/[-_]/)[0]]
  return code && code !== 'eng' ? [code, 'eng'] : ['eng']
}

export function defaultSettings(locale: string): Settings {
  return {
    'ocr.languages': defaultLanguages(locale),
    'ocr.autoRecognizeImports': true,
    'ocr.autoRecognizeOpened': false,
    'ocr.fixOrientation': true,
    'ocr.includeInExports': true
  }
}

type Validator = (v: unknown) => boolean

const isBool: Validator = (v) => typeof v === 'boolean'
const isLanguages: Validator = (v) =>
  Array.isArray(v) &&
  v.length >= 1 &&
  v.length <= OCR_LIMITS.maxLangs &&
  v.every((l) => typeof l === 'string' && LANG_RE.test(l)) &&
  new Set(v).size === v.length

const SCHEMA: Record<keyof Settings, Validator> = {
  'ocr.languages': isLanguages,
  'ocr.autoRecognizeImports': isBool,
  'ocr.autoRecognizeOpened': isBool,
  'ocr.fixOrientation': isBool,
  'ocr.includeInExports': isBool
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false
  const proto = Object.getPrototypeOf(x)
  return proto === Object.prototype || proto === null
}

/** Validate a renderer-supplied patch. Throws on any unknown key or invalid value. */
export function parseSettingsPatch(patch: unknown): Partial<Settings> {
  if (!isPlainObject(patch)) throw new Error('invalid settings: expected an object')
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(SCHEMA, k))
      throw new Error(`invalid settings: unknown key ${JSON.stringify(k.slice(0, 64))}`)
    if (!SCHEMA[k as keyof Settings](v)) throw new Error(`invalid settings: bad value for ${k}`)
    out[k] = Array.isArray(v) ? [...v] : v
  }
  return out as Partial<Settings>
}

/** Lenient read of whatever is on disk: valid known keys win, everything else is the default. */
export function sanitizeSettings(raw: unknown, defaults: Settings): Settings {
  const out: Settings = { ...defaults, 'ocr.languages': [...defaults['ocr.languages']] }
  if (!isPlainObject(raw)) return out
  for (const k of Object.keys(SCHEMA) as Array<keyof Settings>) {
    if (Object.prototype.hasOwnProperty.call(raw, k) && SCHEMA[k](raw[k]))
      (out as unknown as Record<string, unknown>)[k] = Array.isArray(raw[k])
        ? [...(raw[k] as unknown[])]
        : raw[k]
  }
  return out
}
