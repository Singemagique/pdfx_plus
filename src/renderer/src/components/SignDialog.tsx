import { useRef, useState } from 'react'

interface SignDialogProps {
  busy: boolean
  onSign: (
    cert: Uint8Array,
    opts: { passphrase: string; reason?: string; name?: string; tsaUrl?: string }
  ) => Promise<boolean>
  onClose: () => void
}

/** Pick a PKCS#12 (.p12) credential + passphrase and cryptographically sign a flattened copy. */
export function SignDialog({ busy, onSign, onClose }: SignDialogProps): React.JSX.Element {
  const [cert, setCert] = useState<{ name: string; bytes: Uint8Array } | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [reason, setReason] = useState('')
  const [name, setName] = useState('')
  const [tsaUrl, setTsaUrl] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const onCertFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const f = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (f) setCert({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })
  }

  const submit = async (): Promise<void> => {
    if (!cert || busy) return
    const ok = await onSign(cert.bytes, {
      passphrase,
      reason: reason || undefined,
      name: name || undefined,
      tsaUrl: tsaUrl.trim() || undefined
    })
    if (ok) onClose()
  }

  return (
    <div className="sign-overlay" onPointerDown={onClose}>
      <div className="sign-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <h2>Sign PDF</h2>
        <p className="sign-hint">
          Flattens everything and cryptographically signs a copy (PAdES). The editable project stays
          unsigned.
        </p>
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
        <div className="sign-actions">
          {/* Always closable — `busy` is app-wide, so don't trap the user during a long sign. */}
          <button className="btn glass" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn glass primary"
            onClick={() => void submit()}
            disabled={!cert || busy}
          >
            {busy ? 'Signing…' : 'Sign & Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
