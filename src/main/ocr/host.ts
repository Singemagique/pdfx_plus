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
import { dirname, join, resolve } from 'node:path'
import ocrProcessPath from './process/index?modulePath'
import { OCR_CONNECT_CHANNEL, type OcrPaths, type ThermalState } from '../../shared/ocr/protocol'
import {
  ENGINE_CORE,
  ENGINE_DATA,
  RESOURCES_OCR_DIR,
  RESOURCES_TESSDATA_DIR
} from './process/engine-manifest'
import { getMainWindow } from '../window'
import { langPacks, registerOcrLangs } from './lang-host'
import {
  OcrSupervisor,
  SERVICE_NAME,
  type ChildLike,
  type ProcessGoneDetails,
  type SupervisorDeps,
  type WebContentsLike
} from './supervisor'
import {
  childTripwireFailures,
  crashPhase,
  selftestSession,
  type CrashPhaseReport,
  type SelftestPort,
  type SelftestReport,
  type ShortcutReport
} from './selftest'
import { OCR_SELFTEST_CRASH_ARG } from './process/selftest-arg'
import { runShortcutCheck } from './selftest-shortcut'

let supervisor: OcrSupervisor | null = null
let speedLimit = 100

/** pdfium.wasm inside the asar (packaged) or node_modules (dev). Main resolves; the child reads. */
function pdfiumWasmPath(): string {
  return require.resolve('@embedpdf/pdfium/pdfium.wasm')
}

/**
 * The Tesseract core and the bundled languages. Packaged: `resources/ocr/` and
 * `resources/ocr/tessdata/`, copied there by electron-builder `extraResources` (never in the
 * asar). Dev and tests: the same files straight from node_modules. The utility process checks every
 * one against the compiled manifest before it uses it.
 */
export function ocrEnginePaths(): Omit<OcrPaths, 'pdfiumWasm'> {
  // Plus the downloaded / installed / admin-provisioned catalogue languages main has verified
  // (PR9); the bundled files win for their own codes.
  const installed = langPacks().paths()
  if (app.isPackaged) {
    const dir = join(process.resourcesPath, RESOURCES_OCR_DIR)
    const data = join(process.resourcesPath, RESOURCES_TESSDATA_DIR)
    return {
      ocrCore: dir,
      tessdata: {
        ...installed,
        ...Object.fromEntries(
          Object.entries(ENGINE_DATA).map(([lang, f]) => [lang, join(data, f.file)])
        )
      }
    }
  }
  const root = app.getAppPath()
  return {
    ocrCore: dirname(join(root, ENGINE_CORE.wasm.source)),
    tessdata: {
      ...installed,
      ...Object.fromEntries(
        Object.entries(ENGINE_DATA).map(([lang, f]) => [lang, join(root, f.source)])
      )
    }
  }
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
  supervisor ??= new OcrSupervisor(supervisorDeps())
  return supervisor
}

/** The real Electron surfaces, for the app's supervisor (and the self-test's crash-phase one). */
function supervisorDeps(over: Partial<SupervisorDeps> = {}): SupervisorDeps {
  return {
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
      paths: { pdfiumWasm: pdfiumWasmPath(), ...ocrEnginePaths() }
    }),
    platform: process.platform,
    env: process.env,
    isPackaged: app.isPackaged,
    log: (line) => console.warn(line),
    ...over
  }
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
  // Language packs (PR9): a newly verified language goes to a running utility process at once; a
  // child that starts later reads them in its init.
  registerOcrLangs((paths) => supervisor?.setLanguages(paths))
}

/**
 * `pdfx --ocr-selftest <out.json>`: fork the utility process from this (packaged) app, run the
 * self-test session over a real port, write the JSON report and resolve with the exit code (0 =
 * pass). Never writes document content: the report holds statuses, sizes, counters and timings.
 */
export async function runOcrSelftest(outArg: string | undefined): Promise<number> {
  const started = performance.now()
  const out = resolve(outArg && !outArg.startsWith('--') ? outArg : 'ocr-selftest.json')
  // Installed language packs are part of what the engine loads (and checks): find them first.
  await langPacks()
    .init()
    .catch(() => {})
  const sup = getOcrSupervisor()
  let report: SelftestReport | null = null
  let error: string | null = null
  // OCR going fatal (e.g. an engine file failing its manifest check: the child reports which one)
  // ends the session at once with that reason, instead of a step timing out a minute later.
  let stopFatalWatch = (): void => {}
  const fatal = new Promise<never>((_, reject) => {
    stopFatalWatch = sup.onFatal((f) =>
      reject(
        new Error(
          f
            ? `OCR became unavailable: fatal ${f.code} error: ${f.message}`
            : 'OCR became unavailable (fatal)'
        )
      )
    )
  })
  fatal.catch(() => {})
  let readyTimer: ReturnType<typeof setTimeout> | undefined
  try {
    const port = (await Promise.race([
      sup.connectLocal(),
      fatal,
      new Promise<never>((_, reject) => {
        readyTimer = setTimeout(
          () => reject(new Error('the utility process did not become ready')),
          30_000
        )
      })
    ])) as unknown as SelftestPort
    clearTimeout(readyTimer)
    report = await selftestSession(
      port,
      () => sup.requestHeartbeat(),
      () => performance.now(),
      fatal
    )
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  } finally {
    clearTimeout(readyTimer)
    stopFatalWatch()
  }
  const output = sup.output
  const lastExit = sup.lastExit
  const spawnCount = sup.spawnCount
  const electronNet = sup.childElectronNet
  const selfCheck = sup.childSelfCheck
  const supervisorState = sup.state
  const lastFatal = sup.lastFatal
  sup.teardown('selftest-done')

  // The shortcut on a hidden app window: required on every OS (window.ts's handler, menu.ts's item).
  let shortcut: ShortcutReport | { status: 'fail'; message: string }
  try {
    shortcut = await runShortcutCheck()
  } catch (e) {
    shortcut = { status: 'fail', message: e instanceof Error ? e.message : String(e) }
  }
  // A crashing child under a second supervisor: detected (exit, gone event or hang), respawned.
  let crash: CrashPhaseReport | null = null
  let crashError: string | null = null
  try {
    crash = await crashPhase(
      new OcrSupervisor(
        supervisorDeps({
          serviceName: `${SERVICE_NAME}-selftest-crash`,
          forkArgs: (n) => (n === 0 ? [OCR_SELFTEST_CRASH_ARG] : []),
          // A stand-in owner, not a window.
          setProgress: () => {},
          onWindowClosed: () => () => {},
          log: () => {}
        })
      )
    )
  } catch (e) {
    crashError = e instanceof Error ? e.message : String(e)
  }

  const failures = [...(report?.failures ?? []), ...(error ? [error] : [])]
  if (shortcut.status !== 'pass') failures.push(`shortcut: ${shortcut.message}`)
  if (crashError) failures.push(`crash phase: ${crashError}`)
  for (const f of crash?.failures ?? []) failures.push(`crash phase: ${f}`)
  if (supervisorState === 'fatal' && !failures.some((f) => f.startsWith('OCR became unavailable')))
    failures.push(
      lastFatal
        ? `OCR became unavailable: fatal ${lastFatal.code} error: ${lastFatal.message}`
        : 'OCR became unavailable (fatal)'
    )
  if (lastExit) failures.push(`the utility process exited unexpectedly (${lastExit.reason})`)
  // §3.9.4 R3: the engine and the threads print nothing on the child's real stdout/stderr.
  if (output.bytes > 0)
    failures.push(`the utility process wrote ${output.bytes} byte(s) to its stdout/stderr`)
  // electron.net fully stubbed, and the child's own self-check saw every escape hatch trip
  // (process._linkedBinding('electron_common_net') among them), inside the child.
  failures.push(...childTripwireFailures(electronNet, selfCheck))
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
      pdfiumWasmInAsar: /app\.asar[\\/]/.test(pdfiumWasmPath()),
      // The engine must come from resources/ocr (extraResources), never from inside the asar.
      ocrEngineInAsar: /app\.asar[\\/]/.test(ocrEnginePaths().ocrCore),
      ocrLanguages: Object.keys(ocrEnginePaths().tessdata)
    },
    child: {
      spawnCount,
      supervisorState,
      fatal: lastFatal,
      unexpectedExit: lastExit,
      stdio: output,
      electronNetStubbed: electronNet,
      tripwireSelfCheck: selfCheck
    },
    shortcut,
    crashPhase: crash,
    totalMs: Math.round(performance.now() - started)
  }
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n')
  return ok ? 0 : 1
}
