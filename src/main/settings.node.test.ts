// settings.json (DESIGN.md §3.5.2): defaults from the UI locale, strict validation of what the
// renderer sends, lenient reading of what is on disk, atomic serialised writes.

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  SettingsStore,
  defaultLanguages,
  defaultSettings,
  parseSettingsPatch,
  sanitizeSettings
} from './settings'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pdfx-settings-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('defaults', () => {
  it('maps the UI locale to a bundled language, plus English', () => {
    expect(defaultLanguages('de-DE')).toEqual(['deu', 'eng'])
    expect(defaultLanguages('fr')).toEqual(['fra', 'eng'])
    expect(defaultLanguages('es-419')).toEqual(['spa', 'eng'])
    expect(defaultLanguages('en-US')).toEqual(['eng'])
    expect(defaultLanguages('ja')).toEqual(['eng'])
    expect(defaultLanguages('')).toEqual(['eng'])
  })

  it('has the §3.5.2 OCR keys and values', () => {
    expect(defaultSettings('en-US')).toEqual({
      'ocr.languages': ['eng'],
      'ocr.autoRecognizeImports': true,
      'ocr.autoRecognizeOpened': false,
      'ocr.fixOrientation': true,
      'ocr.includeInExports': true
    })
  })
})

describe('parseSettingsPatch (what the renderer may send)', () => {
  it('accepts valid partial patches', () => {
    expect(parseSettingsPatch({ 'ocr.includeInExports': false })).toEqual({
      'ocr.includeInExports': false
    })
    expect(parseSettingsPatch({ 'ocr.languages': ['eng', 'deu', 'chi_sim'] })).toEqual({
      'ocr.languages': ['eng', 'deu', 'chi_sim']
    })
    expect(parseSettingsPatch({})).toEqual({})
  })

  it('rejects unknown keys, bad values and non-objects', () => {
    const bad: unknown[] = [
      null,
      [],
      'x',
      { 'ocr.tessdataPath': '/tmp' },
      { __proto__: { x: 1 }, 'ocr.fixOrientation': true },
      { 'ocr.fixOrientation': 'yes' },
      { 'ocr.languages': [] },
      { 'ocr.languages': ['eng', 'deu', 'fra', 'spa'] },
      { 'ocr.languages': ['eng', 'eng'] },
      { 'ocr.languages': ['../../etc'] },
      { 'ocr.languages': 'eng' }
    ]
    for (const b of bad)
      expect(() => parseSettingsPatch(b), JSON.stringify(b)).toThrow(/invalid settings/)
  })
})

describe('sanitizeSettings (what is on disk)', () => {
  it('keeps valid known keys and defaults the rest', () => {
    const d = defaultSettings('en')
    expect(
      sanitizeSettings({ 'ocr.fixOrientation': false, 'ocr.languages': 'nope', 'future.key': 1 }, d)
    ).toEqual({ ...d, 'ocr.fixOrientation': false })
    expect(sanitizeSettings('garbage', d)).toEqual(d)
  })
})

describe('SettingsStore', () => {
  it('reads defaults when there is no file and persists a patch atomically', async () => {
    const s = new SettingsStore(dir, 'de-DE')
    expect((await s.get())['ocr.languages']).toEqual(['deu', 'eng'])
    const next = await s.set({ 'ocr.autoRecognizeOpened': true })
    expect(next['ocr.autoRecognizeOpened']).toBe(true)
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    expect(onDisk).toEqual(next)
    // No temp file left behind.
    expect(readdirSync(dir)).toEqual(['settings.json'])
    // A fresh store (next launch) reads it back.
    expect(await new SettingsStore(dir, 'en').get()).toEqual(next)
  })

  it('survives a corrupt file and rewrites it whole on the next set', async () => {
    writeFileSync(join(dir, 'settings.json'), '{ "ocr.fixOrientation": fal')
    const s = new SettingsStore(dir, 'en')
    expect(await s.get()).toEqual(defaultSettings('en'))
    await s.set({ 'ocr.fixOrientation': false })
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))['ocr.fixOrientation']).toBe(
      false
    )
  })

  it('serialises concurrent writes (last one wins, none lost)', async () => {
    const s = new SettingsStore(dir, 'en')
    await Promise.all([
      s.set({ 'ocr.fixOrientation': false }),
      s.set({ 'ocr.includeInExports': false }),
      s.set({ 'ocr.languages': ['fra'] })
    ])
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    expect(onDisk).toMatchObject({
      'ocr.fixOrientation': false,
      'ocr.includeInExports': false,
      'ocr.languages': ['fra']
    })
  })

  it('rejects a bad patch without touching the file', async () => {
    const s = new SettingsStore(dir, 'en')
    expect(() => s.set({ 'ocr.languages': ['x'] })).toThrow(/invalid settings/)
    expect(readdirSync(dir)).toEqual([])
  })

  it('hands out copies, so a caller cannot mutate the cache', async () => {
    const s = new SettingsStore(dir, 'en')
    const a = await s.get()
    a['ocr.languages'].push('deu')
    expect((await s.get())['ocr.languages']).toEqual(['eng'])
  })

  it('creates a missing userData directory', async () => {
    const nested = join(dir, 'a', 'b')
    await new SettingsStore(nested, 'en').set({ 'ocr.fixOrientation': false })
    expect(readdirSync(nested)).toEqual(['settings.json'])
  })
})
