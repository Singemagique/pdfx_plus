import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const send = vi.fn()
  return {
    template: null as Electron.MenuItemConstructorOptions[] | null,
    send,
    webContents: { send },
    ipc: new Map<string, (event: unknown, ...args: unknown[]) => void>()
  }
})

/** Every item of the template, submenus included. */
const allItems = (
  items: Electron.MenuItemConstructorOptions[]
): Electron.MenuItemConstructorOptions[] =>
  items.flatMap((i) => [i, ...allItems((i.submenu as Electron.MenuItemConstructorOptions[]) ?? [])])

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: Electron.MenuItemConstructorOptions[]) => {
      h.template = template
      return template
    },
    setApplicationMenu: () => {},
    getApplicationMenu: () =>
      h.template && {
        getMenuItemById: (id: string) => allItems(h.template!).find((i) => i.id === id) ?? null
      }
  },
  ipcMain: {
    on: (channel: string, handler: (event: unknown, ...args: unknown[]) => void) =>
      h.ipc.set(channel, handler)
  }
}))
vi.mock('./window', () => ({
  getMainWindow: () => ({ webContents: h.webContents }),
  toggleDevTools: () => {}
}))

import { buildMenu, registerMenuStateIpc, setMenuChecked } from './menu'

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

function documentMenu(): Electron.MenuItemConstructorOptions[] {
  const doc = h.template!.find((m) => m.label === 'Document')
  expect(doc).toBeDefined()
  return doc!.submenu as Electron.MenuItemConstructorOptions[]
}

describe('Document menu (DESIGN.md §3.8)', () => {
  it('is a top-level menu after Edit with the OCR commands in order', () => {
    setPlatform('win32')
    buildMenu()
    const top = h.template!.map((m) => m.label ?? m.role)
    expect(top.indexOf('Document')).toBe(top.indexOf('Edit') + 1)
    expect(documentMenu().map((i) => (i.type === 'separator' ? 'separator' : i.label))).toEqual([
      'Recognize Text…',
      'Recognize Text on All Scanned Pages',
      'separator',
      'Replace Recognized Text…',
      'Remove Recognized Text',
      'separator',
      'Show Recognized Text',
      'Include Recognized Text When Exporting',
      'separator',
      'Copy Page Text'
    ])
  })

  it('shows Ctrl/Cmd+Shift+R on Recognize Text… without registering it (window.ts delivers it)', () => {
    buildMenu()
    const item = documentMenu().find((i) => i.id === 'recognize-text')!
    expect(item.accelerator).toBe('CommandOrControl+Shift+R')
    expect(item.registerAccelerator).toBe(false)
    // No other Document item has an accelerator that could double-fire.
    expect(documentMenu().filter((i) => i.accelerator)).toHaveLength(1)
  })

  it.each([
    ['recognize-text', 'recognize-text'],
    ['recognize-all-scanned', 'recognize-all-scanned'],
    ['replace-recognized-text', 'replace-recognized-text'],
    ['remove-recognized-text', 'remove-recognized-text'],
    ['show-recognized-text', 'show-recognized-text'],
    ['include-recognized-text', 'include-recognized-text'],
    ['copy-page-text', 'copy-page-text']
  ])('%s sends pdfx:menu %s', (id, action) => {
    buildMenu()
    const item = documentMenu().find((i) => i.id === id)!
    ;(item.click as () => void)()
    expect(h.send).toHaveBeenCalledWith('pdfx:menu', action)
  })

  it('has the two checkboxes: Show off and Include on by default (D7)', () => {
    buildMenu()
    const show = documentMenu().find((i) => i.id === 'show-recognized-text')!
    const include = documentMenu().find((i) => i.id === 'include-recognized-text')!
    expect([show.type, show.checked]).toEqual(['checkbox', false])
    expect([include.type, include.checked]).toEqual(['checkbox', true])
  })

  it('mirrors checkbox state from the main window only, for known ids and booleans', () => {
    buildMenu()
    registerMenuStateIpc()
    const handler = h.ipc.get('pdfx:menu-checked')!
    const include = (): boolean | undefined =>
      documentMenu().find((i) => i.id === 'include-recognized-text')!.checked
    handler({ sender: h.webContents }, 'include-recognized-text', false)
    expect(include()).toBe(false)
    handler({ sender: {} }, 'include-recognized-text', true) // another webContents
    handler({ sender: h.webContents }, 'include-recognized-text', 'yes')
    handler({ sender: h.webContents }, 'copy-page-text', true)
    expect(include()).toBe(false)
    // A rebuilt menu keeps the state last mirrored.
    setMenuChecked('show-recognized-text', true)
    buildMenu()
    expect(documentMenu().find((i) => i.id === 'show-recognized-text')!.checked).toBe(true)
    expect(include()).toBe(false)
    setMenuChecked('show-recognized-text', false)
    setMenuChecked('include-recognized-text', true)
  })
})
