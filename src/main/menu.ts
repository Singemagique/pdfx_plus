import { Menu } from 'electron'
import { getMainWindow, toggleDevTools } from './window'

export function buildMenu(): void {
  const sendZoom = (action: 'in' | 'out' | 'reset') => (): void => {
    getMainWindow()?.webContents.send('pdfx:zoom', action)
  }
  const sendMenu = (action: string) => (): void => {
    getMainWindow()?.webContents.send('pdfx:menu', action)
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
    { role: 'editMenu' },
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
