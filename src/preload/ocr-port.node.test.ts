// The preload's OCR port handling (DESIGN.md §3.3.1): posts queue while a connect is in flight, the
// port that arrives gets them, and a second connect() while a port is live never lets a post go to
// the port the coordinator is about to void.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  OCR_CONNECT_CHANNEL,
  OCR_DISCONNECTED_CHANNEL,
  OCR_PORT_CHANNEL
} from '../shared/ocr/protocol'
import type { PdfxApi } from './index'

const ipc = vi.hoisted(() => ({
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
  sent: [] as string[],
  exposed: null as unknown
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: unknown) => {
      ipc.exposed = api
    }
  },
  ipcRenderer: {
    on: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) =>
      ipc.listeners.set(channel, fn),
    send: (channel: string) => ipc.sent.push(channel),
    invoke: vi.fn(),
    removeListener: vi.fn()
  },
  webUtils: { getPathForFile: () => '' }
}))

class FakePort {
  readonly posted: unknown[] = []
  closed = false
  started = false
  onmessage: ((e: { data: unknown }) => void) | null = null
  private readonly closeListeners: Array<() => void> = []

  postMessage(m: unknown): void {
    if (this.closed) throw new Error('posted on a closed port')
    this.posted.push(m)
  }

  start(): void {
    this.started = true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const l of this.closeListeners) l()
  }

  addEventListener(type: string, l: () => void): void {
    if (type === 'close') this.closeListeners.push(l)
  }
}

let ocr: PdfxApi['ocr']
const events: unknown[] = []

function deliverPort(): FakePort {
  const port = new FakePort()
  ipc.listeners.get(OCR_PORT_CHANNEL)!({ ports: [port] })
  return port
}

beforeAll(async () => {
  ;(process as unknown as { contextIsolated: boolean }).contextIsolated = true
  await import('./index')
  ocr = (ipc.exposed as PdfxApi).ocr
  ocr.onMessage((m) => events.push(m))
})

beforeEach(() => {
  // Start every case disconnected.
  ipc.listeners.get(OCR_DISCONNECTED_CHANNEL)!({}, { reason: 'closed' })
  events.length = 0
  ipc.sent.length = 0
})

const open = { open: { src: 's1', bytes: new Uint8Array([1]) } }
const focus = { focus: { src: 's1', index: 0 } }

describe('ocr port in the preload', () => {
  it('refuses posts with no port and no connect in flight', () => {
    expect(ocr.post(open)).toBe(false)
  })

  it('queues posts until the port arrives, then sends them in order', () => {
    ocr.connect()
    expect(ipc.sent).toEqual([OCR_CONNECT_CHANNEL])
    expect(ocr.post(open)).toBe(true)
    expect(ocr.post(focus)).toBe(true)
    const port = deliverPort()
    expect(port.started).toBe(true)
    expect(port.posted).toEqual([open, focus])
    expect(events).toEqual([{ link: { state: 'connected' } }])
  })

  it('a second connect while connected: posts in between wait for the NEW port', () => {
    ocr.connect()
    const first = deliverPort()
    ocr.connect()
    // The old port is closed at once (the coordinator voids its session anyway)...
    expect(first.closed).toBe(true)
    // ...so this open queues instead of going to the port about to be voided.
    expect(ocr.post(open)).toBe(true)
    expect(first.posted).toEqual([])
    const second = deliverPort()
    expect(second.posted).toEqual([open])
    // Closing the old port is not a disconnect: the link went straight to the new port.
    expect(events).toEqual([{ link: { state: 'connected' } }, { link: { state: 'connected' } }])
  })

  it('a port that closes on its own drops the link and its queue', () => {
    ocr.connect()
    const port = deliverPort()
    port.close()
    expect(events.at(-1)).toEqual({ link: { state: 'disconnected', reason: 'closed' } })
    expect(ocr.post(open)).toBe(false)
  })
})
