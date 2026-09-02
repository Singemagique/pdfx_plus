import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Spy on the real fs/promises (call-through) so tests can assert the UNC guard returns BEFORE any
// filesystem call — a UNC path that merely fails a stat() has already triggered outbound SMB.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    stat: vi.fn(actual.stat),
    readdir: vi.fn(actual.readdir),
    readFile: vi.fn(actual.readFile)
  }
})

import { readFile, readdir, stat } from 'fs/promises'

import {
  IMPORTABLE,
  collectFileArgs,
  expandDropPaths,
  importable,
  readFiles,
  readFilesReport,
  skippedNotice
} from './file-intake'
import { _resetOpenedPaths, isOpenedPath } from './opened-paths'

beforeEach(() => {
  vi.mocked(stat).mockClear()
  vi.mocked(readdir).mockClear()
  vi.mocked(readFile).mockClear()
})

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
    // The guard must short-circuit before the filesystem is touched: stat()ing a UNC path already
    // sends the SMB request the guard exists to prevent, so "it returned []" alone proves nothing.
    for (const call of vi.mocked(stat).mock.calls) {
      expect(String(call[0])).toBe(pdf)
    }
    expect(vi.mocked(readdir)).not.toHaveBeenCalled()
    rmSync(dir, { recursive: true, force: true })
  })

  it('never touches the filesystem for a UNC-only drop', async () => {
    expect(
      await expandDropPaths(['\\\\attacker\\share\\doc.pdf', '//attacker/share/doc.pdf'])
    ).toEqual([])
    expect(vi.mocked(stat)).not.toHaveBeenCalled()
    expect(vi.mocked(readdir)).not.toHaveBeenCalled()
    expect(vi.mocked(readFile)).not.toHaveBeenCalled()
  })
})

describe('skippedNotice', () => {
  it('names the files, singular or plural, without their directories', () => {
    expect(skippedNotice(['/x/y/a.pdf'])).toBe('Could not read 1 file: a.pdf')
    expect(skippedNotice(['/x/a.pdf', '/y/b.pdf'])).toBe('Could not read 2 files: a.pdf, b.pdf')
  })

  it('collapses a long list so a 300-file drop cannot produce a 300-name toast', () => {
    const many = Array.from({ length: 8 }, (_, i) => `/x/f${i}.pdf`)
    expect(skippedNotice(many)).toBe(
      'Could not read 8 files: f0.pdf, f1.pdf, f2.pdf, f3.pdf, f4.pdf +3 more'
    )
  })
})

describe('readFiles', () => {
  let dir: string
  let good: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pdfx-read-'))
    good = join(dir, 'good.pdf')
    writeFileSync(good, '%PDF-1.7\n')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('skips unreadable paths instead of failing the whole batch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const missing = join(dir, 'gone.pdf')
    const out = await readFiles([good, missing, dir]) // missing file + a directory
    expect(out.map((f) => f.path)).toEqual([good])
    expect(out[0].name).toBe('good.pdf')
    expect(new TextDecoder().decode(out[0].data)).toBe('%PDF-1.7\n')
    // Each failure is reported with the offending path, not swallowed.
    expect(warn).toHaveBeenCalledTimes(2)
    expect(String(warn.mock.calls[0][0])).toContain(missing)
    warn.mockRestore()
  })

  it('reads every readable path', async () => {
    const second = join(dir, 'second.pdf')
    writeFileSync(second, '%PDF-1.7\n2\n')
    const out = await readFiles([good, second])
    expect(out.map((f) => f.path)).toEqual([good, second])
  })

  // The silent-skip complaint: readFiles alone gives the caller no way to distinguish "you dropped
  // three files" from "you dropped five and two were unreadable", so the UI could not say anything.
  describe('readFilesReport', () => {
    it('reports the unreadable paths alongside the files it read', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const missing = join(dir, 'report-gone.pdf')
      const report = await readFilesReport([good, missing, dir])
      expect(report.files.map((f) => f.path)).toEqual([good])
      expect(report.skipped).toEqual([missing, dir])
      warn.mockRestore()
    })

    it('reports nothing skipped when every path reads', async () => {
      expect((await readFilesReport([good])).skipped).toEqual([])
    })

    it('still returns only the files through the readFiles wrapper', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect((await readFiles([good, join(dir, 'nope.pdf')])).map((f) => f.path)).toEqual([good])
      warn.mockRestore()
    })
  })

  // The opened-paths set gates read-resource (a compromised renderer that can get an arbitrary
  // path remembered turns read-resource into an arbitrary-file-read / outbound-SMB primitive).
  // readFiles takes renderer-supplied clipboard/drop paths, so it must remember ONLY what it read.
  describe('opened-paths bookkeeping', () => {
    beforeEach(() => {
      _resetOpenedPaths()
    })

    it('does not remember a path it could not read', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const missing = join(dir, 'never-existed.pdf')
      expect(await readFiles([missing])).toEqual([])
      expect(isOpenedPath(missing)).toBe(false)
      warn.mockRestore()
    })

    it('remembers only the readable paths of a partially failing batch', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const missing = join(dir, 'also-never-existed.pdf')
      const out = await readFiles([good, missing])
      expect(out.map((f) => f.path)).toEqual([good])
      expect(isOpenedPath(good)).toBe(true)
      expect(isOpenedPath(missing)).toBe(false)
      warn.mockRestore()
    })
  })
})
