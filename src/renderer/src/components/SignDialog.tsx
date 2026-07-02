import { useEffect, useRef, useState } from 'react'

interface CardToken {
  slot: number
  label: string
  manufacturer: string
  model: string
}

interface WindowsCert {
  thumbprint: string
  subject: string
  issuer: string
  notAfter: string
  keyUsage: string
}

type SignMode = 'wincert' | 'card' | 'file'

interface SignAppearanceOpts {
  reason?: string
  name?: string
  tsaUrl?: string
  /** Embed a DSS (cert chain + OCSP/CRL) so the signature validates long-term (PAdES B-LT). */
  ltv?: boolean
  /** Draw the saved hand-drawn signature image inside the visible appearance. */
  includeImage?: boolean
  /** The signing certificate's identity, for the "digitally signed by …" block (Windows path). */
  signer?: { subject: string; issuer: string }
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
  /** Probe common install locations for PKCS#11 modules (OpenSC, ActivClient, …). */
  findModules: () => Promise<Array<{ path: string; label: string }>>
  /** List signing certificates from the Windows store (Windows only). */
  listWindowsCerts: () => Promise<WindowsCert[]>
  /** Sign with a Windows-store certificate (Windows handles the card PIN prompt). */
  onSignWindowsCert: (thumbprint: string, opts: SignAppearanceOpts) => Promise<boolean>
  /** 'win32' enables the Windows-certificate tab (and makes it the default). */
  platform: string
  /** Resolve a picked module file to an absolute path (Electron webUtils). */
  pathForFile: (file: File) => string
  /** Human-readable location of the visible-signature placement, or null = invisible. */
  placementLabel: string | null
  /** Clear the placement (sign invisibly). */
  onClearPlacement: () => void
  /** Close the dialog and switch to the Signature placement tool (reopens once a box is placed). */
  onPlaceRequest: () => void
  /** Whether the user has a saved hand-drawn signature to optionally include. */
  hasSavedSignature: boolean
  /** Open the pad to draw (or redraw) a hand-drawn signature to include in the appearance. */
  onDrawSignature: () => void
  onClose: () => void
}

/** Common Name out of an X.500 distinguished name, falling back to the whole string. */
const cn = (dn: string): string => /CN=([^,]+)/i.exec(dn)?.[1].trim() ?? dn
/** A readable one-line label for a Windows-store certificate. The key-usage hint helps tell a CAC's
 *  signing cert (Non-Repudiation) apart from its identical-named authentication cert. */
const certLabel = (c: WindowsCert): string => {
  const usage = /NonRepudiation/i.test(c.keyUsage)
    ? ' · signing'
    : /DigitalSignature/i.test(c.keyUsage)
      ? ' · auth'
      : ''
  const exp = c.notAfter ? ` · exp ${c.notAfter.slice(0, 10)}` : ''
  return `${cn(c.subject)} — ${cn(c.issuer)}${exp}${usage}`
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
  findModules,
  listWindowsCerts,
  onSignWindowsCert,
  platform,
  pathForFile,
  placementLabel,
  onClearPlacement,
  onPlaceRequest,
  hasSavedSignature,
  onDrawSignature,
  onClose
}: SignDialogProps): React.JSX.Element {
  const isWin = platform === 'win32'
  // On Windows the cert store (incl. an inserted CAC/PIV card) is the easiest path, so default to it.
  const [mode, setMode] = useState<SignMode>(isWin ? 'wincert' : 'file')
  const [cert, setCert] = useState<{ name: string; bytes: Uint8Array } | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [reason, setReason] = useState('')
  const [name, setName] = useState('')
  const [tsaUrl, setTsaUrl] = useState('')
  const [ltv, setLtv] = useState(false)
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

  // Windows certificate-store state.
  const [winCerts, setWinCerts] = useState<WindowsCert[] | null>(null)
  const [selectedThumb, setSelectedThumb] = useState<string>('')
  const [winError, setWinError] = useState('')

  const switchMode = (m: SignMode): void => {
    setMode(m)
    setCardError('') // don't carry a stale "no card" message between modes
  }

  // Load the Windows store certs when that tab is shown (refresh each open so an inserted/removed
  // card is reflected). Done once per dialog mount via the guard.
  const winLoaded = useRef(false)
  useEffect(() => {
    if (mode !== 'wincert' || winLoaded.current) return
    winLoaded.current = true
    void (async () => {
      try {
        const certs = await listWindowsCerts()
        setWinCerts(certs)
        setSelectedThumb(certs[0]?.thumbprint ?? '')
        if (certs.length === 0)
          setWinError('No signing certificates found. Insert your card, then reopen this dialog.')
      } catch (err) {
        setWinCerts([])
        setWinError(`Could not read the Windows certificate store: ${(err as Error).message}`)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

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

  const detect = async (path?: string): Promise<void> => {
    const mod = (path ?? modulePath).trim()
    if (!mod) return
    setDetecting(true)
    setCardError('')
    try {
      const found = await listTokens(mod)
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

  // When the smart-card tab first opens, probe common install locations for a PKCS#11 module and,
  // if one is present, auto-fill it and detect the card — so a typical CAC/PIV setup needs no manual
  // path hunting. Runs once; the user can still Browse to a different module.
  const autoProbed = useRef(false)
  useEffect(() => {
    if (mode !== 'card' || autoProbed.current) return
    autoProbed.current = true
    void (async () => {
      try {
        const mods = await findModules()
        if (mods.length && !modulePath.trim()) {
          setModulePath(mods[0].path)
          await detect(mods[0].path)
        }
      } catch {
        /* probing failed — the user can browse manually */
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  const shared: SignAppearanceOpts = {
    reason: reason || undefined,
    name: name || undefined,
    tsaUrl: tsaUrl.trim() || undefined,
    ltv: ltv || undefined,
    includeImage: !!placementLabel && hasSavedSignature && includeImage
  }

  // `busy` only engages once the export/signing IPC starts — on the card path that's after a
  // multi-second cert-info round-trip, so guarding on `busy` alone lets a second click start a whole
  // second sign flow (two PIN prompts). This ref latches synchronously on the first click. (P2-3)
  const submitting = useRef(false)
  const submit = async (): Promise<void> => {
    if (busy || submitting.current) return
    submitting.current = true
    try {
      let ok = false
      if (mode === 'wincert') {
        if (!selectedThumb) return
        const c = winCerts?.find((w) => w.thumbprint === selectedThumb)
        ok = await onSignWindowsCert(selectedThumb, {
          ...shared,
          signer: c ? { subject: c.subject, issuer: c.issuer } : undefined
        })
      } else if (mode === 'file') {
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
    } finally {
      submitting.current = false
    }
  }

  const canSign =
    mode === 'wincert' ? !!selectedThumb : mode === 'file' ? !!cert : !!modulePath.trim() && !!pin

  return (
    <div className="sign-overlay" onPointerDown={onClose}>
      <div className="sign-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <h2>Sign PDF</h2>
        <p className="sign-hint">
          Flattens everything and cryptographically signs a copy (PAdES). The editable project stays
          unsigned.
        </p>
        <div className="sign-modes" role="tablist">
          {isWin && (
            <button
              role="tab"
              aria-selected={mode === 'wincert'}
              className={`sign-mode ${mode === 'wincert' ? 'active' : ''}`}
              onClick={() => switchMode('wincert')}
            >
              Windows / CAC
            </button>
          )}
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
            Smart card (PKCS#11)
          </button>
        </div>

        {mode === 'wincert' ? (
          <>
            <p className="sign-module-hint">
              Signs with a certificate from your Windows store — including an inserted CAC/PIV card.
              Windows will prompt for your PIN. No extra software needed.
            </p>
            {winCerts && winCerts.length > 0 && (
              <select
                className="sign-input"
                value={selectedThumb}
                onChange={(e) => setSelectedThumb(e.target.value)}
              >
                {winCerts.map((c) => (
                  <option key={c.thumbprint} value={c.thumbprint}>
                    {certLabel(c)}
                  </option>
                ))}
              </select>
            )}
            {winCerts === null && <p className="sign-module-hint">Reading certificates…</p>}
            {winError && <p className="sign-card-error">{winError}</p>}
          </>
        ) : mode === 'file' ? (
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
        <label className="sign-check">
          <input type="checkbox" checked={ltv} onChange={(e) => setLtv(e.target.checked)} />
          Embed long-term validation data (LTV · cert chain + OCSP/CRL). Needs network at signing;
          add a timestamp above for the strongest result.
        </label>

        <div className="sign-appearance">
          {placementLabel ? (
            <>
              <div className="sign-appearance-row">
                <span>✍ Visible · {placementLabel}</span>
                <button type="button" className="sign-link" onClick={onClearPlacement}>
                  Make invisible
                </button>
              </div>
              {hasSavedSignature ? (
                <div className="sign-appearance-row">
                  <label className="sign-check">
                    <input
                      type="checkbox"
                      checked={includeImage}
                      onChange={(e) => setIncludeImage(e.target.checked)}
                    />
                    Include my drawn signature
                  </label>
                  <button type="button" className="sign-link" onClick={onDrawSignature}>
                    Redraw
                  </button>
                </div>
              ) : (
                <div className="sign-appearance-row">
                  <span className="sign-hint-muted">Cert identity will show. Add handwriting?</span>
                  <button type="button" className="sign-link" onClick={onDrawSignature}>
                    Draw signature…
                  </button>
                </div>
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
