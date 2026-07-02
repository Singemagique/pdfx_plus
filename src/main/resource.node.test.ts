import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, rm } from 'fs/promises'
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
    rememberOpened(['\\\\server\\share\\page.html', '//server/share/page.html'])
    expect(await readResource('\\\\server\\share\\page.html', 'style.css')).toBeNull()
    expect(await readResource('//server/share/page.html', 'style.css')).toBeNull()
    expect(await readResource(htmlPath + '\0', 'style.css')).toBeNull()
    expect(await readResource(htmlPath, '')).toBeNull()
    // @ts-expect-error exercising the non-string guard
    expect(await readResource(123, 'style.css')).toBeNull()
  })
})
