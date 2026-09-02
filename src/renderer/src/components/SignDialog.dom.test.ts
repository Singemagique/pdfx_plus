import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SignDialog } from './SignDialog'

// React needs to know it's inside act() or it warns on every state update.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const winCert = {
  thumbprint: 'AA11BB22',
  subject: 'CN=Test Signer, O=Example',
  issuer: 'CN=Example CA',
  notAfter: '2030-01-01T00:00:00Z',
  keyUsage: 'DigitalSignature, NonRepudiation'
}

/** A sign call that never settles, so the dialog stays in its in-flight state for assertions. */
const neverSettles = (): Promise<boolean> => new Promise<boolean>(() => {})

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    busy: false,
    onSign: vi.fn(neverSettles),
    onSignCard: vi.fn(neverSettles),
    listTokens: vi.fn(async () => []),
    findModules: vi.fn(async () => []),
    listWindowsCerts: vi.fn(async () => [winCert]),
    onSignWindowsCert: vi.fn(neverSettles),
    platform: 'win32',
    pathForFile: vi.fn(() => ''),
    placementLabel: null,
    onClearPlacement: vi.fn(),
    onPlaceRequest: vi.fn(),
    hasSavedSignature: false,
    onDrawSignature: vi.fn(),
    onClose: vi.fn(),
    ...overrides
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function mount(props: ReturnType<typeof makeProps>): Promise<void> {
  // Two acts: the second lets the Windows-cert load effect resolve and select a certificate.
  await act(async () => {
    root.render(createElement(SignDialog, props as never))
  })
  await act(async () => {})
}

const byText = (re: RegExp): HTMLButtonElement => {
  const found = Array.from(container.querySelectorAll('button')).find((b) =>
    re.test(b.textContent ?? '')
  )
  if (!found) throw new Error(`no button matching ${re}`)
  return found
}

const submitButton = (): HTMLButtonElement => byText(/Sign & Save|Signing/)

/**
 * Submit via Enter on the TSA field. Unlike the button that input is never disabled, so the event
 * really reaches `submit()` — only the latch can stop it. That keeps the latch tests honest once
 * the pending state disables the button.
 */
async function submitViaEnter(times = 1): Promise<void> {
  const tsa = container.querySelector<HTMLInputElement>('input[placeholder^="Timestamp authority"]')
  expect(tsa).not.toBeNull()
  await act(async () => {
    for (let i = 0; i < times; i++) {
      tsa!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
  })
}

describe('SignDialog submit latch', () => {
  it('runs a single sign for two rapid submits (P2-3)', async () => {
    const props = makeProps()
    await mount(props)
    expect(props.listWindowsCerts).toHaveBeenCalled()

    await submitViaEnter(2)

    expect(props.onSignWindowsCert).toHaveBeenCalledTimes(1)
    expect(props.onSignWindowsCert).toHaveBeenCalledWith(
      winCert.thumbprint,
      expect.objectContaining({ signer: { subject: winCert.subject, issuer: winCert.issuer } })
    )
  })

  it('shows the submit button as pending immediately, before app-wide busy engages', async () => {
    const props = makeProps()
    await mount(props)

    const button = submitButton()
    expect(button.disabled).toBe(false)
    expect(button.textContent).toContain('Sign & Save')

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // The dialog was never re-rendered with `busy: true` — the export/signing IPC has not started —
    // yet the button must already read as working, or the dropped second submit looks like a dead
    // button. Only the local pending state can be producing this.
    expect(submitButton().disabled).toBe(true)
    expect(submitButton().textContent).toContain('Signing…')

    // And a submit that bypasses the disabled button entirely (Enter on the never-disabled TSA
    // field) is still swallowed while the first sign promise is pending.
    await submitViaEnter()
    expect(props.onSignWindowsCert).toHaveBeenCalledTimes(1)
    expect(submitButton().disabled).toBe(true)
  })
})

describe('SignDialog hidden mode', () => {
  it('keeps the dialog rendered but display:none while a placement is in progress', async () => {
    const props = makeProps({ hidden: true })
    await mount(props)

    const overlay = container.querySelector('.sign-overlay')
    expect(overlay).not.toBeNull()
    expect(overlay!.classList.contains('hidden')).toBe(true)
    // Still mounted: the fields the user filled in are all there to come back to.
    expect(container.querySelector('input[placeholder^="Signer name"]')).not.toBeNull()
  })

  it('is visible again without the hidden class', async () => {
    await mount(makeProps())
    expect(container.querySelector('.sign-overlay')!.classList.contains('hidden')).toBe(false)
  })
})
