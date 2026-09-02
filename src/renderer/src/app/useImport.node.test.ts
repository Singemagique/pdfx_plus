import { describe, expect, it, vi } from 'vitest'

import { tamperGate } from './useImport'
import type { ImportedMirror } from '../pdfx/mirror'

// useImport pulls in the pdf.js-backed loaders through ./external-drop; the gate itself needs none
// of them, so stub the modules out and keep this a pure unit test.
vi.mock('../pdfx/source', () => ({
  importIntoDocs: vi.fn(),
  loadIncomingPages: vi.fn()
}))
vi.mock('../pdfx/convert', () => ({ findConverter: vi.fn(() => null) }))

const mirror = (): ImportedMirror => ({
  overlays: [],
  rotations: [['k', 90]],
  crops: [],
  attachments: []
})
const clean = { tampered: false, changedPages: [] }
const tampered = (changedPages: number[] = [3]) => ({ tampered: true, changedPages })

describe('tamperGate', () => {
  it('skips the edits without prompting when there is no mirror', async () => {
    const confirm = vi.fn(async (_detail: string) => 0)
    expect(await tamperGate(null, tampered(), confirm)).toBe('skip')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('loads the edits without prompting when the integrity check is clean', async () => {
    const confirm = vi.fn(async (_detail: string) => 0)
    expect(await tamperGate(mirror(), clean, confirm)).toBe('load')
    expect(confirm).not.toHaveBeenCalled()
  })

  // The dialog's button order lives in the main process, so pin the index → decision contract here.
  it('maps button 0 to skipping the edits', async () => {
    const confirm = vi.fn(async (_detail: string) => 0)
    expect(await tamperGate(mirror(), tampered(), confirm)).toBe('skip')
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('maps button 1 to loading the edits anyway', async () => {
    expect(
      await tamperGate(
        mirror(),
        tampered(),
        vi.fn(async (_d: string) => 1)
      )
    ).toBe('load')
  })

  it('maps button 2 to cancelling the open', async () => {
    expect(
      await tamperGate(
        mirror(),
        tampered(),
        vi.fn(async (_d: string) => 2)
      )
    ).toBe('cancel')
  })

  it('describes which pages changed, and summarizes when there are many', async () => {
    const detail = async (changedPages: number[]): Promise<string> => {
      const confirm = vi.fn(async (_detail: string) => 0)
      await tamperGate(mirror(), tampered(changedPages), confirm)
      return confirm.mock.calls[0][0]
    }

    expect(await detail([])).toBe('The document content changed since these edits were saved.')
    expect(await detail([4])).toBe('Page 4 changed since these edits were saved.')
    expect(await detail([1, 2])).toBe('Pages 1, 2 changed since these edits were saved.')
    expect(await detail(Array.from({ length: 11 }, (_, i) => i + 1))).toBe(
      '11 pages changed since these edits were saved.'
    )
  })
})
