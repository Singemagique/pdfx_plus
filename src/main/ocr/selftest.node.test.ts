// The --ocr-selftest session logic with scripted threads: a broken render and a tripped wire fail it.
// The run against the real threads and engine (and the recording of its expected result) is tier 1:
// selftest.ocr.test.ts.

import { describe, expect, it } from 'vitest'

import type { Heartbeat } from '../../shared/ocr/protocol'
import { Coordinator } from './process/coordinator'
import {
  RECOGNIZE_ACCELERATOR,
  REQUIRED_CHILD_CHECKS,
  childTripwireFailures,
  hasRecognizeMenuItem,
  selftestSession,
  shortcutVerdict,
  type MenuItemLike
} from './selftest'
import type { FromRaster } from './process/thread-messages'
import { FakeParent, INIT, harness, settle, triaged } from './test-utils/fake-threads'
import { portPair } from './test-utils/port-pair'

function heartbeatVia(parent: FakeParent): () => Promise<Heartbeat> {
  return async () => {
    const n = parent.sent.length
    parent.send({ heartbeat: {} })
    await settle()
    const hb = parent.sent.slice(n).find((m) => 'heartbeat' in (m as object)) as {
      heartbeat: Heartbeat
    }
    return hb.heartbeat
  }
}

describe('selftestSession', () => {
  it('fails on a page that never rendered and on a tripped wire', async () => {
    const h = harness({
      pageCount: () => 1,
      tripwire: () => 2,
      raster: (m, t) => ({ type: 'heap-exhausted', taskId: m.taskId, heap: t.heap, tripwire: 0 })
    })
    const c = new Coordinator(h.deps)
    h.parent.send(INIT)
    const [coordinatorEnd, mainEnd] = portPair()
    h.parent.send({ port: {} }, [coordinatorEnd])
    const report = await selftestSession(mainEnd, heartbeatVia(h.parent))
    c.dispose()
    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toMatch(/page status too-large/)
    expect(report.failures.join('\n')).toMatch(/network tripwire fired/)
    // Triage ran first (the scripted thread says `scanned`).
    expect(report.triage).toMatchObject({ pageClass: 'scanned', renderDpi: 300 })
  })

  it('fails when triage does not class the page `scanned`', async () => {
    const h = harness({
      pageCount: () => 1,
      rasterTriage: (m, t) => {
        const out = triaged(m, t) as Extract<FromRaster, { type: 'triaged' }>
        out.pages = out.pages.map((p) => ({ ...p, pageClass: 'text' as const }))
        return out
      }
    })
    const c = new Coordinator(h.deps)
    h.parent.send(INIT)
    const [coordinatorEnd, mainEnd] = portPair()
    h.parent.send({ port: {} }, [coordinatorEnd])
    const report = await selftestSession(mainEnd, heartbeatVia(h.parent))
    c.dispose()
    expect(report.ok).toBe(false)
    expect(report.failures).toContain('triage class text, expected scanned')
    // The recognised page carries the class triage gave it.
    expect(report.page?.pageClass).toBe('text')
  })
})

describe('selftestSession when OCR goes away', () => {
  // Nothing answers on the other end, so without the abort each step would wait STEP_TIMEOUT_MS
  // (60 s) and report only "timed out waiting for opened" (PR5 review).
  const noHeartbeat = async (): Promise<Heartbeat> => {
    throw new Error('no heartbeat')
  }

  it('ends at once with the reason when the supervisor goes fatal', async () => {
    const [, mainEnd] = portPair()
    let fail!: (e: Error) => void
    const abort = new Promise<never>((_, reject) => {
      fail = reject
    })
    const why = 'OCR became unavailable: fatal init error: traineddata fra: SHA-256 mismatch'
    setTimeout(() => fail(new Error(why)), 10)
    const t0 = Date.now()
    const report = await selftestSession(mainEnd, noHeartbeat, undefined, abort)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(report.ok).toBe(false)
    expect(report.failures).toEqual([why])
    expect(report.opened).toBeNull()
  })

  it('ends at once when the utility process closes the port', async () => {
    const [coordinatorEnd, mainEnd] = portPair()
    setTimeout(() => coordinatorEnd.close(), 10)
    const t0 = Date.now()
    const report = await selftestSession(mainEnd, noHeartbeat)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(report.failures).toEqual(['the utility process closed the port'])
  })
})

describe('childTripwireFailures (what the packaged self-test asks of the child realm)', () => {
  const net = ['fetch', 'request', 'resolveHost', 'isOnline']
  const all = { checked: [...REQUIRED_CHILD_CHECKS], failed: [] }

  it('passes a child whose self-check tripped everything it must', () => {
    expect(childTripwireFailures(net, all)).toEqual([])
  })

  it('fails on a hatch that did not trip, a check that was skipped, or no check at all', () => {
    const text = (f: string[]): string => f.join(' | ')
    expect(
      text(childTripwireFailures(net, { ...all, failed: ['process._linkedBinding'] }))
    ).toMatch(/self-check failed .*process\._linkedBinding/)
    const skipped = all.checked.filter((c) => c !== 'process._linkedBinding')
    expect(text(childTripwireFailures(net, { checked: skipped, failed: [] }))).toMatch(
      /skipped: process\._linkedBinding/
    )
    expect(childTripwireFailures(net, null)).toEqual([
      'no tripwire self-check from the utility process'
    ])
    expect(text(childTripwireFailures(['fetch'], all))).toMatch(/electron\.net stubs/)
  })
})

describe('shortcutVerdict (Ctrl/Cmd+Shift+R on a hidden window, §3.8)', () => {
  const seen = { menuItem: true, sends: 1, wrongModifierSends: null, keyDowns: 1, loaded: true }

  it('passes on exactly one recognize-text per press', () => {
    expect(shortcutVerdict(seen).status).toBe('pass')
    expect(shortcutVerdict({ ...seen, wrongModifierSends: 0, keyDowns: 2 }).status).toBe('pass')
  })

  it('is required: no handler and no menu item fails, it is never skipped', () => {
    const v = shortcutVerdict({ ...seen, menuItem: false, sends: 0 })
    expect(v.status).toBe('fail')
    expect(v.message).toMatch(/no Recognize Text… item/)
    expect(shortcutVerdict({ ...seen, menuItem: false }).status).toBe('fail')
  })

  it('fails when the press is lost, doubled or fires on the wrong chord', () => {
    expect(shortcutVerdict({ ...seen, sends: 0 }).message).toMatch(/0 time\(s\) for one press/)
    expect(shortcutVerdict({ ...seen, sends: 2 }).status).toBe('fail')
    expect(shortcutVerdict({ ...seen, keyDowns: 0 }).message).toMatch(/never reached/)
    expect(shortcutVerdict({ ...seen, loaded: false }).status).toBe('fail')
    expect(shortcutVerdict({ ...seen, wrongModifierSends: 1 }).message).toMatch(/darwin/)
    expect(shortcutVerdict({ ...seen, menuItem: false, sends: 2 }).status).toBe('fail')
  })

  it('says what it proved: main sent the action to the renderer once', () => {
    expect(shortcutVerdict(seen).message).toMatch(
      /made main send 'recognize-text' to the renderer once/
    )
  })
})

describe('hasRecognizeMenuItem (the menu half of the shortcut check)', () => {
  const item = {
    id: 'recognize-text',
    label: 'Recognize Text…',
    accelerator: RECOGNIZE_ACCELERATOR,
    registerAccelerator: false
  }
  const menu = (i: object): MenuItemLike[] => [
    { label: 'File', submenu: { items: [] } },
    { label: 'Document', submenu: { items: [{ id: 'other', label: 'Other' }, i] } }
  ]

  it('finds the Document item showing Ctrl/Cmd+Shift+R, unregistered, in a submenu', () => {
    expect(hasRecognizeMenuItem(menu(item))).toBe(true)
  })

  it('rejects a missing or different accelerator, a registered one, or another label', () => {
    expect(hasRecognizeMenuItem(menu({ ...item, accelerator: undefined }))).toBe(false)
    expect(hasRecognizeMenuItem(menu({ ...item, accelerator: 'CommandOrControl+R' }))).toBe(false)
    expect(hasRecognizeMenuItem(menu({ ...item, registerAccelerator: true }))).toBe(false)
    expect(hasRecognizeMenuItem(menu({ ...item, label: 'Recognize Text' }))).toBe(false)
    expect(hasRecognizeMenuItem(menu({ ...item, id: 'recognize-all-scanned' }))).toBe(false)
    expect(hasRecognizeMenuItem(undefined)).toBe(false)
  })
})
