import { ipcMain, Menu } from 'electron'
import { getMainWindow, toggleDevTools } from './window'

/** The Document menu's checkboxes whose state the renderer owns (it pushes it: `pdfx:menu-checked`). */
export const MENU_CHECKBOXES = ['show-recognized-text', 'include-recognized-text'] as const
export type MenuCheckbox = (typeof MENU_CHECKBOXES)[number]

/** The checkbox states last pushed by the renderer (used when the menu is (re)built). */
const checkedState: Record<MenuCheckbox, boolean> = {
  'show-recognized-text': false,
  'include-recognized-text': true
}

/** Set a Document-menu checkbox (the renderer is the source of truth; Electron flips it on click). */
export function setMenuChecked(id: MenuCheckbox, checked: boolean): void {
  checkedState[id] = checked
  const item = Menu.getApplicationMenu()?.getMenuItemById(id)
  if (item) item.checked = checked
}

/**
 * `pdfx:menu-checked` (renderer → main): the Document menu's checkbox states. Only the main window
 * may set them, only the known ids, only booleans.
 */
export function registerMenuStateIpc(): void {
  ipcMain.on('pdfx:menu-checked', (event, id: unknown, checked: unknown) => {
    if (event.sender !== getMainWindow()?.webContents) return
    if (!(MENU_CHECKBOXES as readonly unknown[]).includes(id) || typeof checked !== 'boolean')
      return
    setMenuChecked(id as MenuCheckbox, checked)
  })
}

/**
 * The Document menu (DESIGN.md §3.8). Recognize Text… shows Ctrl/Cmd+Shift+R but does NOT register
 * it: window.ts's before-input-event handler delivers that key (the toolkit's watchWindowShortcuts
 * preventDefaults every Ctrl/Cmd+R in packaged builds, which also blocks a menu accelerator), and a
 * registered accelerator would fire a second time in dev builds.
 */
export function documentItems(
  sendMenu: (action: string) => () => void
): Electron.MenuItemConstructorOptions[] {
  return [
    {
      id: 'recognize-text',
      label: 'Recognize Text…',
      accelerator: 'CommandOrControl+Shift+R',
      registerAccelerator: false,
      click: sendMenu('recognize-text')
    },
    {
      id: 'recognize-all-scanned',
      label: 'Recognize Text on All Scanned Pages',
      click: sendMenu('recognize-all-scanned')
    },
    { type: 'separator' },
    {
      id: 'replace-recognized-text',
      label: 'Replace Recognized Text…',
      click: sendMenu('replace-recognized-text')
    },
    {
      id: 'remove-recognized-text',
      label: 'Remove Recognized Text',
      click: sendMenu('remove-recognized-text')
    },
    { type: 'separator' },
    {
      id: 'show-recognized-text',
      label: 'Show Recognized Text',
      type: 'checkbox',
      checked: checkedState['show-recognized-text'],
      click: sendMenu('show-recognized-text')
    },
    {
      id: 'include-recognized-text',
      label: 'Include Recognized Text When Exporting',
      type: 'checkbox',
      checked: checkedState['include-recognized-text'],
      click: sendMenu('include-recognized-text')
    },
    { type: 'separator' },
    { id: 'copy-page-text', label: 'Copy Page Text', click: sendMenu('copy-page-text') }
  ]
}

/**
 * What `role: 'editMenu'` expands to on each platform, spelled out so Find… can join it. Keep it
 * in step with Electron's: these roles are what make undo, clipboard and select-all work in text
 * fields (and the macOS speech submenu).
 */
export function editItems(isMac: boolean): Electron.MenuItemConstructorOptions[] {
  if (isMac) {
    return [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'pasteAndMatchStyle' },
      { role: 'delete' },
      { role: 'selectAll' },
      { type: 'separator' },
      { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] }
    ]
  }
  return [
    { role: 'undo' },
    { role: 'redo' },
    { type: 'separator' },
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    { role: 'delete' },
    { type: 'separator' },
    { role: 'selectAll' }
  ]
}

// Find Next / Find Previous are deliberately NOT menu items: if both a menu accelerator and the
// renderer's own key handling fired, a step would advance twice. Opening is idempotent.
export function buildMenu(): void {
  const sendZoom = (action: 'in' | 'out' | 'reset') => (): void => {
    getMainWindow()?.webContents.send('pdfx:zoom', action)
  }
  const sendMenu = (action: string) => (): void => {
    getMainWindow()?.webContents.send('pdfx:menu', action)
  }
  const isMac = process.platform === 'darwin'
  const findItem: Electron.MenuItemConstructorOptions = {
    id: 'find',
    label: 'Find…',
    accelerator: 'CommandOrControl+F',
    click: sendMenu('find')
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? ([{ role: 'appMenu' }] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        { id: 'open', label: 'Open…', accelerator: 'CommandOrControl+O', click: sendMenu('open') },
        { type: 'separator' },
        {
          id: 'export-pdfx',
          label: 'Export .pdfx…',
          accelerator: 'CommandOrControl+E',
          click: sendMenu('export-pdfx')
        },
        { id: 'export-pdf', label: 'Export Single PDF…', click: sendMenu('export-pdf') },
        { id: 'export-zip', label: 'Export All as ZIP…', click: sendMenu('export-zip') },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' as const } : { role: 'quit' as const }
      ]
    },
    {
      label: 'Edit',
      submenu: [...editItems(isMac), { type: 'separator' }, findItem]
    },
    { label: 'Document', submenu: documentItems(sendMenu) },
    {
      label: 'View',
      submenu: [
        {
          id: 'zoom-in',
          label: 'Zoom In',
          accelerator: 'CommandOrControl+=',
          click: sendZoom('in')
        },
        {
          id: 'zoom-out',
          label: 'Zoom Out',
          accelerator: 'CommandOrControl+-',
          click: sendZoom('out')
        },
        {
          id: 'zoom-reset',
          label: 'Actual Size',
          accelerator: 'CommandOrControl+0',
          click: sendZoom('reset')
        },
        { type: 'separator' },
        {
          label: 'Toggle Developer Tools',
          accelerator: process.platform === 'darwin' ? 'Alt+Command+I' : 'Ctrl+Shift+I',
          click: () => toggleDevTools()
        }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
