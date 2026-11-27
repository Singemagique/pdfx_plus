import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  template: null as Electron.MenuItemConstructorOptions[] | null,
  send: vi.fn()
}))

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: Electron.MenuItemConstructorOptions[]) => {
      h.template = template
      return template
    },
    setApplicationMenu: () => {}
  }
}))
vi.mock('./window', () => ({
  getMainWindow: () => ({ webContents: { send: h.send } }),
  toggleDevTools: () => {}
}))

import { buildMenu } from './menu'

const realPlatform = process.platform
const setPlatform = (p: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

afterEach(() => {
  setPlatform(realPlatform)
  h.send.mockClear()
})

function editMenu(): Electron.MenuItemConstructorOptions[] {
  const edit = h.template!.find((m) => m.label === 'Edit')
  expect(edit).toBeDefined()
  return edit!.submenu as Electron.MenuItemConstructorOptions[]
}

const roles = (items: Electron.MenuItemConstructorOptions[]): Array<string | undefined> =>
  items.map((i) => i.role ?? i.type ?? i.label)

describe('Edit menu', () => {
  it('reproduces the editMenu role on Windows/Linux and adds Find…', () => {
    setPlatform('win32')
    buildMenu()
    expect(roles(editMenu())).toEqual([
      'undo',
      'redo',
      'separator',
      'cut',
      'copy',
      'paste',
      'delete',
      'separator',
      'selectAll',
      'separator',
      'Find…'
    ])
  })

  it('keeps the macOS extras (paste and match style, speech)', () => {
    setPlatform('darwin')
    buildMenu()
    const items = editMenu()
    expect(roles(items)).toContain('pasteAndMatchStyle')
    const speech = items.find((i) => i.label === 'Speech')
    expect(roles(speech!.submenu as Electron.MenuItemConstructorOptions[])).toEqual([
      'startSpeaking',
      'stopSpeaking'
    ])
  })

  it('sends the find action to the renderer on CommandOrControl+F', () => {
    setPlatform('linux')
    buildMenu()
    const find = editMenu().find((i) => i.id === 'find')!
    expect(find.accelerator).toBe('CommandOrControl+F')
    ;(find.click as () => void)()
    expect(h.send).toHaveBeenCalledWith('pdfx:menu', 'find')
  })

  it('has no Find Next / Find Previous items (the renderer owns those keys)', () => {
    setPlatform('win32')
    buildMenu()
    const labels = h.template!.flatMap((m) =>
      ((m.submenu as Electron.MenuItemConstructorOptions[] | undefined) ?? []).map((i) => i.label)
    )
    expect(labels.filter((l) => l && /find/i.test(l))).toEqual(['Find…'])
  })
})
