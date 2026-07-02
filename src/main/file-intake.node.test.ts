import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { IMPORTABLE, collectFileArgs, expandDropPaths, importable } from './file-intake'

describe('IMPORTABLE', () => {
  it('matches supported extensions case-insensitively', () => {
    for (const f of ['a.pdf', 'a.PDFX', 'a.png', 'a.jpeg', 'a.jpg', 'a.webp', 'a.txt', 'a.HTML']) {
      expect(IMPORTABLE.test(f)).toBe(true)
    }
  })

  it('rejects unsupported extensions', () => {
    for (const f of ['a.docx', 'a.exe', 'a', 'a.pdfx.bak']) {
      expect(IMPORTABLE.test(f)).toBe(false)
    }
  })
})

describe('importable', () => {
  it('accepts supported files but rejects dotfiles', () => {
    expect(importable('/x/report.pdf')).toBe(true)
    expect(importable('/x/.hidden.pdf')).toBe(false)
    expect(importable('/x/notes.docx')).toBe(false)
  })
})

describe('collectFileArgs', () => {
  let dir: string
  let pdfPath: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pdfx-intake-'))
    pdfPath = join(dir, 'real.pdf')
    writeFileSync(pdfPath, '%PDF-1.7\n')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps only existing .pdf/.pdfx argv entries', () => {
    const missing = join(dir, 'missing.pdf')
    const png = join(dir, 'real.png')
    writeFileSync(png, 'x')
    expect(collectFileArgs(['--flag', pdfPath, missing, png])).toEqual([pdfPath])
  })
})

describe('expandDropPaths', () => {
  it('rejects UNC roots (no outbound SMB) while still expanding a real local file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdfx-drop-'))
    const pdf = join(dir, 'doc.pdf')
    writeFileSync(pdf, '%PDF-1.7\n')
    const out = await expandDropPaths(['\\\\attacker\\share', '//attacker/share', '', pdf])
    expect(out).toEqual([pdf]) // UNC + empty dropped, local file kept
    rmSync(dir, { recursive: true, force: true })
  })
})
