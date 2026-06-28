import { useRef, useState } from 'react'

interface CardToken {
  slot: number
  label: string
  manufacturer: string
  model: string
}

interface SignAppearanceOpts {
  reason?: string
  name?: string
  tsaUrl?: string
  /** Draw the saved hand-drawn signature image inside the visible appearance. */
  includeImage?: boolean
}

interface SignDialogProps {
  busy: boolean
  /** Sign with a PKCS#12 (.p12) file. */
  onSign: (cert: Uint8Array, opts: SignAppearanceOpts & { passphrase: string }) => Promise<boolean>
  /** Sign with a smart card / HSM via PKCS#11. */
  onSignCard: (
    card: { modulePath: string; pin: string; slot?: number; tokenLabel?: string },
    opts: SignAppearanceOpts
  ) => Promise<boolean>
  /** List the tokens (cards) present in a PKCS#11 module. */
  listTokens: (modulePath: string) => Promise<CardToken[]>
  /** Resolve a picked module file to an absolute path (Electron webUtils). */
  pathForFile: (file: File) => string
  /** Human-readable location of the visible-signature placement, or null = invisible. */
  placementLabel: string | null
  /** Clear the placement (sign invisibly). */
  onClearPlacement: () => void
  /** Close the dialog and switch to the Signature placement tool. */
  onPlaceRequest: () => void
  /** Whether the user has a saved hand-drawn signature to optionally include. */
  hasSavedSignature: boolean
  onClose: () => void
}

// A few common PKCS#11 module locations to point users at when they don't know their card's module.
const MODULE_HINT =
  'Path to your card’s PKCS#11 module (.dll/.so/.dylib). OpenSC works for many cards, e.g. ' +
  'Windows: C:\\Program Files\\OpenSC Project\\OpenSC\\pkcs11\\opensc-pkcs11.dll · ' +
  'macOS: /Library/OpenSC/lib/opensc-pkcs11.so · Linux: /usr/lib/opensc-pkcs11.so'

/** Pick a credential — a PKCS#12 file or a smart card (PKCS#11) — and sign a flattened copy (PAdES). */
export function SignDialog({
  busy,
  onSign,
  onSignCard,
  listTokens,
  pathForFile,
  placementLabel,
  onClearPlacement,
  onPlaceRequest,
  hasSavedSignature,
  onClose
}: SignDialogProps): React.JSX.Element {
  const [mode, setMode] = useState<'file' | 'card'>('file')
  const [cert, setCert] = useState<{ name: string; bytes: Uint8Array } | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [reason, setReason] = useState('')
  const [name, setName] = useState('')
  const [tsaUrl, setTsaUrl] = useState('')
  const [includeImage, setIncludeImage] = useState(true)
  const fileRef = useRef<HTMLInputElement>(null)

  // Smart-card state.
  const [modulePath, setModulePath] = useState('')
  const [pin, setPin] = useState('')
  const [tokens, setTokens] = useState<CardToken[] | null>(null)
  // Identify the chosen token by slot (unique) rather than label (cards can share a label).
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [cardError, setCardError] = useState('')
  const moduleRef = useRef<HTMLInputElement>(null)

  const switchMode = (m: 'file' | 'card'): void => {
    setMode(m)
    setCardError('') // don't carry a stale "no card" message between modes
  }

  const onCertFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const f = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (f) setCert({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })
  }

  const onModuleFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (f) {
      setModulePath(pathForFile(f))
      setTokens(null)
      setSelectedSlot(null)
      setCardError('')
    }
  }

  const detect = async (): Promise<void> => {
    if (!modulePath.trim()) return
    setDetecting(true)
    setCardError('')
    try {
      const found = await listTokens(modulePath.trim())
      setTokens(found)
      setSelectedSlot(found.length ? found[0].slot : null)
      if (!found.length) setCardError('No card detected — is it inserted?')
    } catch (err) {
      setTokens(null)
      setSelectedSlot(null)
      setCardError(`Could not read the module: ${(err as Error).message}`)
    } finally {
      setDetecting(false)
    }
  }

  const shared: SignAppearanceOpts = {
    reason: reason || undefined,
    name: name || undefined,
    tsaUrl: tsaUrl.trim() || undefined,
    includeImage: !!placementLabel && hasSavedSignature && includeImage
  }

  const submit = async (): Promise<void> => {
    if (busy) return
    let ok = false
    if (mode === 'file') {
      if (!cert) return
      ok = await onSign(cert.bytes, { passphrase, ...shared })
    } else {
      if (!modulePath.trim() || !pin) return
      ok = await onSignCard(
        { modulePath: modulePath.trim(), pin, slot: selectedSlot ?? undefined },
        shared
      )
    }
    if (ok) {
      onClearPlacement() // the placement is consumed; don't leave a stale marker behind
      onClose()
    }
  }

  const canSign = mode === 'file' ? !!cert : !!modulePath.trim() && !!pin

  return (
    <div className="sign-overlay" onPointerDown={onClose}>
      <div className="sign-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <h2>Sign PDF</h2>
        <p className="sign-hint">
          Flattens everything and cryptographically signs a copy (PAdES). The editable project stays
          unsigned.
        </p>
        <div className="sign-modes" role="tablist">
          <button
            role="tab"
            aria-selected={mode === 'file'}
            className={`sign-mode ${mode === 'file' ? 'active' : ''}`}
            onClick={() => switchMode('file')}
          >
            Certificate file
          </button>
          <button
            role="tab"
            aria-selected={mode === 'card'}
            className={`sign-mode ${mode === 'card' ? 'active' : ''}`}
            onClick={() => switchMode('card')}
          >
            Smart card
          </button>
        </div>

        {mode === 'file' ? (
          <>
            <button className="sign-cert-btn" onClick={() => fileRef.current?.click()}>
              {cert ? `🔑 ${cert.name}` : 'Choose certificate (.p12 / .pfx)…'}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".p12,.pfx,application/x-pkcs12"
              style={{ display: 'none' }}
              onChange={(e) => void onCertFile(e)}
            />
            <input
              className="sign-input"
              type="password"
              placeholder="Passphrase"
              value={passphrase}
              autoComplete="off"
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </>
        ) : (
          <>
            <div className="sign-module-row">
              <input
                className="sign-input"
                type="text"
                placeholder="PKCS#11 module path"
                value={modulePath}
                onChange={(e) => {
                  setModulePath(e.target.value)
                  setTokens(null)
                  setSelectedSlot(null)
                }}
              />
              <button className="btn glass" onClick={() => moduleRef.current?.click()}>
                Browse…
              </button>
            </div>
            <input
              ref={moduleRef}
              type="file"
              accept=".dll,.so,.dylib"
              style={{ display: 'none' }}
              onChange={onModuleFile}
            />
            <p className="sign-module-hint">{MODULE_HINT}</p>
            <div className="sign-module-row">
              <button
                className="btn glass"
                onClick={() => void detect()}
                disabled={!modulePath.trim() || detecting || busy}
              >
                {detecting ? 'Detecting…' : 'Detect cards'}
              </button>
              {tokens && tokens.length > 0 && (
                <select
                  className="sign-input"
                  value={selectedSlot != null ? String(selectedSlot) : ''}
                  onChange={(e) => setSelectedSlot(Number(e.target.value))}
                >
                  {tokens.map((t) => (
                    <option key={`${t.slot}`} value={String(t.slot)}>
                      {t.label || `(slot ${t.slot})`}
                      {t.manufacturer ? ` — ${t.manufacturer}` : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {cardError && <p className="sign-card-error">{cardError}</p>}
            <input
              className="sign-input"
              type="password"
              placeholder="Card PIN"
              value={pin}
              autoComplete="off"
              onChange={(e) => setPin(e.target.value)}
            />
          </>
        )}

        <input
          className="sign-input"
          type="text"
          placeholder="Signer name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="sign-input"
          type="text"
          placeholder="Reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <input
          className="sign-input"
          type="text"
          placeholder="Timestamp authority URL (optional, → B-T)"
          value={tsaUrl}
          onChange={(e) => setTsaUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />

        <div className="sign-appearance">
          {placementLabel ? (
            <>
              <div className="sign-appearance-row">
                <span>✍ Visible · {placementLabel}</span>
                <button type="button" className="sign-link" onClick={onClearPlacement}>
                  Make invisible
                </button>
              </div>
              {hasSavedSignature && (
                <label className="sign-check">
                  <input
                    type="checkbox"
                    checked={includeImage}
                    onChange={(e) => setIncludeImage(e.target.checked)}
                  />
                  Include my drawn signature image
                </label>
              )}
            </>
          ) : (
            <div className="sign-appearance-row">
              <span>Invisible signature (whole document)</span>
              <button type="button" className="sign-link" onClick={onPlaceRequest}>
                Place on page…
              </button>
            </div>
          )}
        </div>

        <div className="sign-actions">
          {/* Always closable — `busy` is app-wide, so don't trap the user during a long sign. */}
          <button className="btn glass" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn glass primary"
            onClick={() => void submit()}
            disabled={!canSign || busy}
          >
            {busy ? 'Signing…' : 'Sign & Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
