// Windows certificate-store signing. On Windows a smart card (CAC/PIV) registers its certificates +
// keys in the user's "My" store via the card's minidriver/CSP — the same mechanism Adobe, Office and
// browsers use. Signing through it needs NO PKCS#11 module and no module-path/architecture hunting,
// and Windows itself shows the card PIN prompt. We enumerate + sign by shelling out to PowerShell
// (.NET RSACng), then feed the signature into the same detached-CMS pipeline as the other signers.
// Runs in the MAIN process. Windows-only.
import { spawn } from 'node:child_process'
import type { RawSigner } from './sign-pkcs11'

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']

/** Run a PowerShell script (optionally feeding `stdin`), returning stdout. Console window hidden;
 *  the card PIN dialog is a separate OS dialog and still appears. */
function runPowerShell(script: string, stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [...PS_ARGS, script], { windowsHide: true })
    let out = ''
    let err = ''
    ps.stdout.on('data', (d) => (out += d))
    ps.stderr.on('data', (d) => (err += d))
    ps.on('error', reject)
    ps.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err.trim() || `PowerShell exited with ${code}`))
    )
    if (stdin != null) ps.stdin.write(stdin)
    ps.stdin.end()
  })
}

export interface WindowsCert {
  thumbprint: string
  subject: string
  issuer: string
  notAfter: string
  /** Comma-joined X.509 key-usage flags (from the public cert; no private-key access). */
  keyUsage: string
}

// Enumerate valid certificates that have a private key — METADATA ONLY. We deliberately never touch
// the private key here: accessing a smart-card key can block or pop a PIN prompt, and listing must
// do neither.
const LIST_SCRIPT = `
$ErrorActionPreference='Stop'
$now = Get-Date
$list = Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.HasPrivateKey -and $_.NotAfter -gt $now -and $_.NotBefore -lt $now } | ForEach-Object {
  $ku = ''
  try { $e = $_.Extensions['2.5.29.15']; if ($e) { $ku = $e.KeyUsages.ToString() } } catch {}
  [pscustomobject]@{ thumbprint=$_.Thumbprint; subject=$_.Subject; issuer=$_.Issuer; notAfter=$_.NotAfter.ToString('o'); keyUsage=$ku }
}
ConvertTo-Json @($list) -Compress
`

/** List signing-capable certificates in the user's Windows store (CAC/PIV certs appear here when the
 *  card is inserted). Signing certs (key usage includes Digital Signature) are returned first. */
export async function listWindowsCerts(): Promise<WindowsCert[]> {
  const out = (await runPowerShell(LIST_SCRIPT)).trim()
  if (!out) return []
  const parsed = JSON.parse(out) as WindowsCert | WindowsCert[]
  const all = Array.isArray(parsed) ? parsed : [parsed]
  // Prefer signing certs, but keep the rest (a card may label usage differently).
  const canSign = (c: WindowsCert): boolean => /DigitalSignature|NonRepudiation/i.test(c.keyUsage)
  return [...all.filter(canSign), ...all.filter((c) => !canSign(c))]
}

const THUMB_RE = /^[0-9A-Fa-f]{40}$/

/**
 * Build the certificate chain above a Windows-store cert and return every element (leaf first) as
 * DER, for embedding in an LTV DSS. Crucially this does NOT gate on X509Chain.Build()'s result:
 * DoD roots are usually not in a civilian Windows trust store, so Build() returns false (untrusted
 * root) even though it fully discovers the chain — and for a DSS we only need the certs, not a trust
 * verdict. Revocation checking is disabled (we fetch OCSP/CRL ourselves) and unknown CAs are allowed
 * so discovery isn't blocked. Returns [] if nothing can be read (LTV then falls back to leaf-only).
 */
export async function windowsCertChain(thumbprint: string): Promise<ArrayBuffer[]> {
  if (!THUMB_RE.test(thumbprint)) throw new Error('Invalid certificate thumbprint')
  const script = `
$ErrorActionPreference='Stop'
$c = Get-Item "Cert:\\CurrentUser\\My\\${thumbprint}"
$ch = New-Object System.Security.Cryptography.X509Certificates.X509Chain
$ch.ChainPolicy.RevocationMode = 'NoCheck'
$ch.ChainPolicy.VerificationFlags = 'AllowUnknownCertificateAuthority'
[void]$ch.Build($c)
$ch.ChainElements | ForEach-Object { [Convert]::ToBase64String($_.Certificate.RawData) }
`
  const out = (await runPowerShell(script)).trim()
  if (!out) return []
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((b64) => {
      const b = Buffer.from(b64, 'base64')
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
    })
}

/** A credential backed by a Windows-store certificate (its key may live on a smart card). */
export async function windowsCertCredential(
  thumbprint: string
): Promise<{ certDer: ArrayBuffer; rawSign: RawSigner }> {
  if (!THUMB_RE.test(thumbprint)) throw new Error('Invalid certificate thumbprint')
  const certB64 = (
    await runPowerShell(
      `$c = Get-Item "Cert:\\CurrentUser\\My\\${thumbprint}"; [Convert]::ToBase64String($c.RawData)`
    )
  ).trim()
  if (!certB64) throw new Error('Certificate not found in the Windows store')
  const certBytes = Buffer.from(certB64, 'base64')

  const rawSign: RawSigner = async (data) => {
    // Sign over `data` with the cert's RSA key (RSASSA-PKCS1-v1_5, SHA-256). For a smart card this
    // is the step that prompts for the PIN. Data is piped via stdin (binary-safe, no arg limits).
    const b64in = Buffer.from(data).toString('base64')
    const script = `
$ErrorActionPreference='Stop'
$c = Get-Item "Cert:\\CurrentUser\\My\\${thumbprint}"
$rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($c)
if (-not $rsa) { throw 'This certificate is not an RSA key (only RSA is supported)' }
$data = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$sig = $rsa.SignData($data, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
[Convert]::ToBase64String($sig)
`
    const sigB64 = (await runPowerShell(script, b64in)).trim()
    if (!sigB64) throw new Error('Signing produced no signature (cancelled or wrong PIN?)')
    const sig = Buffer.from(sigB64, 'base64')
    return sig.buffer.slice(sig.byteOffset, sig.byteOffset + sig.byteLength)
  }

  return { certDer: certBytes.buffer.slice(certBytes.byteOffset, certBytes.byteOffset + certBytes.byteLength), rawSign } // prettier-ignore
}
