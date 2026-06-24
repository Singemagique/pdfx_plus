import type { BrowserWindow } from 'electron'
import { join } from 'path'

const isMac = process.platform === 'darwin'

export const FALLBACK_BG = { dark: '#1c1c1e', light: '#f7f7f5' }

export const GLASS_CONFIG = isMac
  ? {
      titleBarStyle: 'hidden' as const,
      trafficLightPosition: { x: 20, y: 19 },
      transparent: true,
      backgroundColor: '#00000000',
      roundedCorners: true
    }
  : {}

interface GlassAddon {
  applyGlass(handle: Buffer): void
  isGlassSupported(): boolean
}

function loadAddon(): GlassAddon | null {
  if (!isMac) return null
  try {
    return require(join(__dirname, '../../native/build/Release/glass.node'))
  } catch (error) {
    console.warn('[glass] native addon unavailable:', error)
    return null
  }
}

export function applyNativeGlass(win: BrowserWindow): void {
  if (!isMac) return

  const addon = loadAddon()
  if (!addon) return

  win.webContents.once('did-finish-load', () => {
    try {
      addon.applyGlass(win.getNativeWindowHandle())
    } catch {}
  })
}
