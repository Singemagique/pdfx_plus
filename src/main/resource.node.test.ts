import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Spy on the real fs/promises (call-through) so tests can assert the UNC guard returns BEFORE any
// filesystem call — realpath()ing a UNC path already triggers the outbound SMB resolution (and the
// NTLM-hash leak) the guard exists to prevent, even when it ultimately fails and yields null.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    realpath: vi.fn(actual.realpath),
    stat: vi.fn(actual.stat),
    readFile: vi.fn(actual.readFile)
  }
})

import { mkdtemp, writeFile, rm, realpath, stat, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { readResource } from './resource'
import { rememberOpened, _resetOpenedPaths } from './opened-paths'

let dir: string
let htmlPath: string
let secretPath: string

beforeEach(async () => {
  _resetOpenedPaths()
  dir = await mkdtemp(join(tmpdir(), 'pdfx-res-'))
  htmlPath = join(dir, 'page.html')
  secretPath = join(dir, 'secret.key')
  await writeFile(htmlPath, '<html></html>')
  await writeFile(join(dir, 'style.css'), 'body{color:red}')
  await writeFile(secretPath, 'TOP SECRET')
  vi.mocked(realpath).mockClear()
  vi.mocked(stat).mockClear()
  vi.mocked(readFile).mockClear()
})

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
})

describe('readResource opened-path gate (P1-3)', () => {
  it('reads a sibling resource once the HTML file is a remembered opened path', async () => {
    rememberOpened([htmlPath])
    const res = await readResource(htmlPath, 'style.css')
    expect(res).not.toBeNull()
    expect(res!.mime).toBe('text/css')
    expect(new TextDecoder().decode(res!.data)).toBe('body{color:red}')
  })

  it('refuses a base directory the user never opened (arbitrary-read block)', async () => {
    // Renderer supplies an arbitrary base to read a sibling file; base was never opened.
    expect(await readResource(secretPath, 'secret.key')).toBeNull()
    // Even the .ssh-style attack: point the base at an arbitrary dir, ref a sibling.
    expect(await readResource(join(dir, 'anything.html'), 'secret.key')).toBeNull()
  })

  it('still blocks path traversal out of an opened base', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'pdfx-out-'))
    await writeFile(join(outside, 'x.key'), 'nope')
    rememberOpened([htmlPath])
    // A remembered base does not let ref escape it.
    expect(await readResource(htmlPath, '../x.key')).toBeNull()
    expect(await readResource(htmlPath, join(outside, 'x.key'))).toBeNull()
    await rm(outside, { recursive: true, force: true }).catch(() => {})
  })

  it('rejects UNC bases and non-string / null-byte input', async () => {
    // Remember the UNC bases first: without that, the opened-path gate would reject them anyway and
    // the assertions below would pass with the UNC guard deleted.
    rememberOpened(['\\\\server\\share\\page.html', '//server/share/page.html'])
    expect(await readResource('\\\\server\\share\\page.html', 'style.css')).toBeNull()
    expect(await readResource('//server/share/page.html', 'style.css')).toBeNull()
    expect(await readResource(htmlPath + '\0', 'style.css')).toBeNull()
    expect(await readResource(htmlPath, '')).toBeNull()
    // @ts-expect-error exercising the non-string guard
    expect(await readResource(123, 'style.css')).toBeNull()
    // Returning null is not enough: every one of these must be refused with NO filesystem access at
    // all, so a UNC base never reaches realpath() and never sends an SMB request.
    expect(vi.mocked(realpath)).not.toHaveBeenCalled()
    expect(vi.mocked(stat)).not.toHaveBeenCalled()
    expect(vi.mocked(readFile)).not.toHaveBeenCalled()
  })
})
