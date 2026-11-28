// Test-only: two cross-wired in-memory ports (main's end and the coordinator's), for running the
// self-test session against a coordinator in vitest.

import { EventEmitter } from 'node:events'

import type { PortLike } from '../process/coordinator'
import type { SelftestPort } from '../selftest'

/** Two cross-wired in-memory ports; messages are structured-cloned, as a real port does. */
export function portPair(): [PortLike & SelftestPort, PortLike & SelftestPort] {
  class P extends EventEmitter {
    peer!: P
    closed = false
    postMessage(msg: unknown): void {
      if (this.closed || this.peer.closed) return
      queueMicrotask(() => this.peer.emit('message', { data: structuredClone(msg) }))
    }
    start(): void {}
    close(): void {
      if (this.closed) return
      this.closed = true
      queueMicrotask(() => this.peer.emit('close'))
    }
  }
  const a = new P()
  const b = new P()
  a.peer = b
  b.peer = a
  return [a, b]
}
