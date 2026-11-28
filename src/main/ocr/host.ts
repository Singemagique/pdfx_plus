// Electron wiring for the OCR supervisor: the real utilityProcess, MessageChannelMain, power
// blocker, progress bar, window hooks and power limits (DESIGN.md §3.3.1–§3.3.2). Everything with
// logic lives in supervisor.ts, which has no Electron import.

import {
  app,
  BrowserWindow,
  ipcMain,
  MessageChannelMain,
  powerMonitor,
  powerSaveBlocker,
  utilityProcess,
  type WebContents
} from 'electron'
import { writeFileSync } from 'node:fs'
import { constants, setPriority } from 'node:os'
import { resolve } from 'node:path'
import ocrProcessPath from './process/index?modulePath'
import { OCR_CONNECT_CHANNEL, type ThermalState } from '../../shared/ocr/protocol'
import { getMainWindow } from '../window'
import {
  OcrSupervisor,
  type ChildLike,
  type ProcessGoneDetails,
  type WebContentsLike
} from './supervisor'
import { selftestSession, type SelftestPort, type SelftestReport } from './selftest'

let supervisor: OcrSupervisor | null = null
let speedLimit = 100

/** pdfium.wasm inside the asar (packaged) or node_modules (dev). Main resolves; the child reads. */
function pdfiumWasmPath(): string {
  return require.resolve('@embedpdf/pdfium/pdfium.wasm')
}

function hostLimits(): { onBattery: boolean; thermal: ThermalState; speedLimit: number } {
  let thermal: ThermalState = 'unknown'
  try {
    // macOS only; 'unknown' elsewhere.
    thermal = powerMonitor.getCurrentThermalState() as ThermalState
  } catch {
    thermal = 'unknown'
  }
  return { onBattery: powerMonitor.isOnBatteryPower(), thermal, speedLimit }
}

export function getOcrSupervisor(): OcrSupervisor {
  supervisor ??= new OcrSupervisor({
    fork: (modulePath, args, options) =>
      utilityProcess.fork(modulePath, args, options) as unknown as ChildLike,
    modulePath: ocrProcessPath,
    onChildProcessGone: (listener) =>
      app.on('child-process-gone', (_event, details) => listener(details as ProcessGoneDetails)),
    createChannel: () => new MessageChannelMain(),
    powerSaveBlocker,
    setPriority: (pid) => setPriority(pid, constants.priority.PRIORITY_BELOW_NORMAL),
    setProgress: (wc, frac) => {
      const win = BrowserWindow.fromWebContents(wc as unknown as WebContents)
      if (win && !win.isDestroyed()) win.setProgressBar(frac)
    },
    onWindowClosed: (wc, listener) => {
      const win = BrowserWindow.fromWebContents(wc as unknown as WebContents)
      if (!win) return () => {}
      win.once('closed', listener)
      return () => {
        win.removeListener('closed', listener)
      }
    },
    init: () => ({
      limits: { ...hostLimits(), divisor: 1 },
      paths: { pdfiumWasm: pdfiumWasmPath() }
    }),
    platform: process.platform,
    env: process.env,
    isPackaged: app.isPackaged,
    log: (line) => console.warn(line)
  })
  return supervisor
}

/** The `ocr.connect()` IPC, power-limit forwarding and quit handling. Call once, after ready. */
export function registerOcr(): void {
  ipcMain.on(OCR_CONNECT_CHANNEL, (event) => {
    // Only the app window's top frame may start OCR: not a subframe, not a helper window.
    const main = getMainWindow()
    if (!main || event.sender !== main.webContents) return
    if (event.senderFrame !== event.sender.mainFrame) return
    getOcrSupervisor().connect(event.sender as unknown as WebContentsLike)
  })
  const update = (): void => supervisor?.setLimits(hostLimits())
  powerMonitor.on('on-battery', update)
  powerMonitor.on('on-ac', update)
  powerMonitor.on('thermal-state-change', update)
  powerMonitor.on('speed-limit-change', (details: { limit: number }) => {
    speedLimit = details.limit
    update()
  })
  app.on('before-quit', () => supervisor?.dispose())
}

/**
 * `pdfx --ocr-selftest <out.json>`: fork the utility process from this (packaged) app, run the
 * self-test session over a real port, write the JSON report and resolve with the exit code (0 =
 * pass). Never writes document content: the report holds statuses, sizes, counters and timings.
 */
export async function runOcrSelftest(outArg: string | undefined): Promise<number> {
  const started = performance.now()
  const out = resolve(outArg && !outArg.startsWith('--') ? outArg : 'ocr-selftest.json')
  const sup = getOcrSupervisor()
  let report: SelftestReport | null = null
  let error: string | null = null
  try {
    const port = (await Promise.race([
      sup.connectLocal(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('the utility process did not become ready')), 30_000)
      )
    ])) as unknown as SelftestPort
    report = await selftestSession(port, () => sup.requestHeartbeat())
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  const output = sup.output
  const lastExit = sup.lastExit
  const spawnCount = sup.spawnCount
  const electronNet = sup.childElectronNet
  sup.teardown('selftest-done')
  const failures = [...(report?.failures ?? []), ...(error ? [error] : [])]
  if (lastExit) failures.push(`the utility process exited unexpectedly (${lastExit.reason})`)
  // In a utility process require('electron').net exists (PR0): the tripwire must have stubbed all
  // four members, or a network path is open that needs no import.
  if ((electronNet ?? []).length !== 4)
    failures.push(`electron.net stubs: ${JSON.stringify(electronNet)}, expected 4`)
  const ok = !!report?.ok && failures.length === 0
  const result = {
    ok,
    error,
    ...report,
    failures,
    app: {
      isPackaged: app.isPackaged,
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      utilityEntryInAsar: /app\.asar[\\/]/.test(ocrProcessPath),
      pdfiumWasmInAsar: /app\.asar[\\/]/.test(pdfiumWasmPath())
    },
    child: { spawnCount, unexpectedExit: lastExit, stdio: output, electronNetStubbed: electronNet },
    totalMs: Math.round(performance.now() - started)
  }
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n')
  return ok ? 0 : 1
}
