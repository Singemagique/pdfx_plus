// PKCS#11 binding for smart-card / HSM signing, via koffi (prebuilt FFI — no native build step).
// Talks to any vendor's PKCS#11 module (.dll/.so/.dylib): OpenSC, the card's own middleware, SoftHSM,
// etc. The private key never leaves the token; we only ask it to produce an RSASSA-PKCS1-v1_5
// (SHA-256) signature over the CMS signed attributes. Runs in the MAIN process so the PIN and the
// raw signing stay out of the renderer.
//
// Cross-platform ABI notes baked in here: CK_ULONG is C `unsigned long` (4 bytes on Win64/LLP64,
// 8 on LP64) — koffi's `unsigned long` matches. PKCS#11 structs are #pragma pack(1) on Windows but
// naturally aligned elsewhere, so CK_ATTRIBUTE/CK_MECHANISM use koffi.pack on win32, koffi.struct
// otherwise. Validated end-to-end against SoftHSM2 (x64).
import * as koffi from 'koffi'
import type { RawSigner } from './sign-pkcs11'

const ULONG = 'unsigned long'
const ULONG_SIZE = koffi.sizeof(ULONG)
const isWin = process.platform === 'win32'
const mkStruct = isWin ? koffi.pack : koffi.struct

// CK_ATTRIBUTE { CK_ATTRIBUTE_TYPE type; void *pValue; CK_ULONG ulValueLen }
const CK_ATTRIBUTE = mkStruct('CK_ATTRIBUTE', { type: ULONG, pValue: 'void *', ulValueLen: ULONG })
// CK_MECHANISM { CK_MECHANISM_TYPE mechanism; void *pParameter; CK_ULONG ulParameterLen }
const CK_MECHANISM = mkStruct('CK_MECHANISM', {
  mechanism: ULONG,
  pParameter: 'void *',
  ulParameterLen: ULONG
})
// The structs are registered with koffi by name (above) and referenced by name inside the
// prototype strings below; the bindings themselves are otherwise unused.
void CK_ATTRIBUTE
void CK_MECHANISM

// Selected PKCS#11 constants (v2.40).
const CKU_USER = 1
const CKF_SERIAL_SESSION = 0x00000004
const CKR_OK = 0
const CKR_CRYPTOKI_ALREADY_INITIALIZED = 0x00000191
const CKA_CLASS = 0x00000000
const CKA_LABEL = 0x00000003
const CKA_VALUE = 0x00000011
const CKA_CERTIFICATE_TYPE = 0x00000080
const CKA_ID = 0x00000102
const CKO_CERTIFICATE = 0x00000001
const CKO_PRIVATE_KEY = 0x00000003
const CKC_X_509 = 0x00000000
const CKM_SHA256_RSA_PKCS = 0x00000040

interface Funcs {
  C_Initialize: (a: unknown) => number
  C_Finalize: (a: unknown) => number
  C_GetSlotList: (present: number, list: unknown, count: number[]) => number
  C_GetTokenInfo: (slot: number, info: Buffer) => number
  C_OpenSession: (slot: number, flags: number, a: unknown, b: unknown, out: number[]) => number
  C_CloseSession: (session: number) => number
  C_Login: (session: number, userType: number, pin: Buffer, pinLen: number) => number
  C_Logout: (session: number) => number
  C_FindObjectsInit: (session: number, tmpl: unknown[], count: number) => number
  C_FindObjects: (session: number, out: Buffer, max: number, count: number[]) => number
  C_FindObjectsFinal: (session: number) => number
  C_GetAttributeValue: (session: number, obj: number, tmpl: unknown[], count: number) => number
  C_SignInit: (session: number, mech: unknown[], key: number) => number
  C_Sign: (
    session: number,
    data: Buffer,
    dataLen: number,
    sig: Buffer | null,
    sigLen: number[]
  ) => number
}

// koffi.load + func definitions are cached per module path (re-defining funcs on every sign leaks).
const moduleCache = new Map<string, Funcs>()

function load(modulePath: string): Funcs {
  const cached = moduleCache.get(modulePath)
  if (cached) return cached
  let lib: ReturnType<typeof koffi.load>
  try {
    lib = koffi.load(modulePath)
  } catch (e) {
    throw new Error(`Could not load PKCS#11 module "${modulePath}": ${(e as Error).message}`)
  }
  // Most modules export the C_* functions directly (the spec only mandates C_GetFunctionList, but
  // OpenSC, SoftHSM and the common vendor middlewares all export the rest too).
  const f = lib.func.bind(lib)
  let funcs: Funcs
  try {
    funcs = {
      C_Initialize: f('unsigned long C_Initialize(void *)') as Funcs['C_Initialize'],
      C_Finalize: f('unsigned long C_Finalize(void *)') as Funcs['C_Finalize'],
      C_GetSlotList: f(
        'unsigned long C_GetSlotList(uint8, _Inout_ void *, _Inout_ unsigned long *)'
      ) as Funcs['C_GetSlotList'],
      C_GetTokenInfo: f(
        'unsigned long C_GetTokenInfo(unsigned long, _Out_ void *)'
      ) as Funcs['C_GetTokenInfo'],
      C_OpenSession: f(
        'unsigned long C_OpenSession(unsigned long, unsigned long, void *, void *, _Out_ unsigned long *)'
      ) as Funcs['C_OpenSession'],
      C_CloseSession: f('unsigned long C_CloseSession(unsigned long)') as Funcs['C_CloseSession'],
      C_Login: f(
        'unsigned long C_Login(unsigned long, unsigned long, void *, unsigned long)'
      ) as Funcs['C_Login'],
      C_Logout: f('unsigned long C_Logout(unsigned long)') as Funcs['C_Logout'],
      C_FindObjectsInit: f(
        'unsigned long C_FindObjectsInit(unsigned long, CK_ATTRIBUTE *, unsigned long)'
      ) as Funcs['C_FindObjectsInit'],
      C_FindObjects: f(
        'unsigned long C_FindObjects(unsigned long, _Out_ void *, unsigned long, _Out_ unsigned long *)'
      ) as Funcs['C_FindObjects'],
      C_FindObjectsFinal: f(
        'unsigned long C_FindObjectsFinal(unsigned long)'
      ) as Funcs['C_FindObjectsFinal'],
      C_GetAttributeValue: f(
        'unsigned long C_GetAttributeValue(unsigned long, unsigned long, _Inout_ CK_ATTRIBUTE *, unsigned long)'
      ) as Funcs['C_GetAttributeValue'],
      C_SignInit: f(
        'unsigned long C_SignInit(unsigned long, CK_MECHANISM *, unsigned long)'
      ) as Funcs['C_SignInit'],
      C_Sign: f(
        // pSignature is a plain void* (not _Out_) so it accepts NULL for the length-probe call and a
        // caller-allocated Buffer for the real call (koffi passes Buffers zero-copy, by reference).
        'unsigned long C_Sign(unsigned long, void *, unsigned long, void *, _Inout_ unsigned long *)'
      ) as Funcs['C_Sign']
    }
  } catch (e) {
    throw new Error(
      `PKCS#11 module "${modulePath}" is missing required functions (does it export the C_* API directly?): ${(e as Error).message}`
    )
  }
  moduleCache.set(modulePath, funcs)
  return funcs
}

function ck(name: string, rv: number): void {
  if (rv !== CKR_OK) throw new Error(`${name} failed (CKR 0x${(rv >>> 0).toString(16)})`)
}

function readUlong(buf: Buffer, off: number): number {
  return ULONG_SIZE === 8 ? Number(buf.readBigUInt64LE(off)) : buf.readUInt32LE(off)
}

function ulongValue(v: number): Buffer {
  const b = Buffer.alloc(ULONG_SIZE)
  if (ULONG_SIZE === 8) b.writeBigUInt64LE(BigInt(v))
  else b.writeUInt32LE(v >>> 0)
  return b
}

function fixedString(buf: Buffer, off: number, len: number): string {
  return buf
    .slice(off, off + len)
    .toString('utf8')
    .replace(/\0+$/, '')
    .trimEnd()
}

export interface Pkcs11Options {
  /** Absolute path to the PKCS#11 module (.dll/.so/.dylib). */
  modulePath: string
  /** User PIN. */
  pin: string
  /** Slot id to use; omit to auto-pick (matching tokenLabel if given, else the first token). */
  slot?: number
  /** Token label to match when no slot is given. */
  tokenLabel?: string
  /** Certificate label (CKA_LABEL) to disambiguate when a token holds several certificates. */
  certLabel?: string
}

export interface TokenInfo {
  slot: number
  label: string
  manufacturer: string
  model: string
  serial: string
}

function getSlotsWithToken(f: Funcs): number[] {
  const countRef = [0]
  ck('C_GetSlotList', f.C_GetSlotList(1, null, countRef))
  const n = countRef[0]
  if (!n) return []
  const buf = Buffer.alloc(n * ULONG_SIZE)
  ck('C_GetSlotList', f.C_GetSlotList(1, buf, [n]))
  const slots: number[] = []
  for (let i = 0; i < n; i++) slots.push(readUlong(buf, i * ULONG_SIZE))
  return slots
}

function tokenInfo(f: Funcs, slot: number): TokenInfo {
  // CK_TOKEN_INFO: label[32] manufacturerID[32] model[16] serialNumber[16] ... (read the labels).
  const buf = Buffer.alloc(512)
  ck('C_GetTokenInfo', f.C_GetTokenInfo(slot, buf))
  return {
    slot,
    label: fixedString(buf, 0, 32),
    manufacturer: fixedString(buf, 32, 32),
    model: fixedString(buf, 64, 16),
    serial: fixedString(buf, 80, 16)
  }
}

// C_Initialize/C_Finalize are per-MODULE, not per-session — calling C_Finalize tears down Cryptoki
// for every open session of that module. Operations can interleave (the renderer may "detect cards"
// while a sign is mid-flight, since signing awaits between openCard and close), so we reference-count
// per module path: only the first init really initializes, and only the last finalize really
// finalizes — keeping a card's session alive until its own close() runs.
const initCount = new Map<string, number>()

function initialize(modulePath: string, f: Funcs): void {
  const n = initCount.get(modulePath) ?? 0
  if (n === 0) {
    const rv = f.C_Initialize(null)
    if (rv !== CKR_OK && rv !== CKR_CRYPTOKI_ALREADY_INITIALIZED) ck('C_Initialize', rv)
  }
  initCount.set(modulePath, n + 1)
}

function finalize(modulePath: string, f: Funcs): void {
  const n = initCount.get(modulePath) ?? 0
  if (n <= 1) {
    initCount.delete(modulePath)
    f.C_Finalize(null)
  } else {
    initCount.set(modulePath, n - 1)
  }
}

/** Enumerate tokens (cards) currently present, across all slots of `modulePath`. */
export function listTokens(modulePath: string): TokenInfo[] {
  const f = load(modulePath)
  initialize(modulePath, f)
  try {
    return getSlotsWithToken(f).map((s) => tokenInfo(f, s))
  } finally {
    finalize(modulePath, f)
  }
}

function findObjects(
  f: Funcs,
  session: number,
  template: Array<{ type: number; value: Buffer }>
): number[] {
  const tmpl = template.map((a) => ({ type: a.type, pValue: a.value, ulValueLen: a.value.length }))
  ck('C_FindObjectsInit', f.C_FindObjectsInit(session, tmpl, tmpl.length))
  const handles: number[] = []
  try {
    // Pull handles in batches until the token reports none left.
    for (;;) {
      const batch = Buffer.alloc(16 * ULONG_SIZE)
      const got = [0]
      ck('C_FindObjects', f.C_FindObjects(session, batch, 16, got))
      if (!got[0]) break
      for (let i = 0; i < got[0]; i++) handles.push(readUlong(batch, i * ULONG_SIZE))
      if (got[0] < 16) break
    }
  } finally {
    f.C_FindObjectsFinal(session)
  }
  return handles
}

/** Read a single attribute as raw bytes (the two-call length-probe then fetch pattern). */
function getAttribute(f: Funcs, session: number, obj: number, type: number): Buffer {
  const probe = [{ type, pValue: null as Buffer | null, ulValueLen: 0 }]
  ck('C_GetAttributeValue', f.C_GetAttributeValue(session, obj, probe, 1))
  const len = probe[0].ulValueLen
  // CK_UNAVAILABLE_INFORMATION is (CK_ULONG)-1 — width-dependent. Guard with a safe-integer check so
  // a -1 sentinel on LP64 (huge via readBigUInt64) doesn't trigger an absurd allocation.
  if (len === 0 || len === 0xffffffff || !Number.isSafeInteger(len) || len > 0xffffffff) {
    return Buffer.alloc(0)
  }
  const out = Buffer.alloc(len)
  ck(
    'C_GetAttributeValue',
    f.C_GetAttributeValue(session, obj, [{ type, pValue: out, ulValueLen: len }], 1)
  )
  return out
}

export interface CardCredential {
  /** The signer's X.509 certificate (DER), read from the token. */
  certDer: ArrayBuffer
  /** Sign the given bytes on the card with RSASSA-PKCS1-v1_5 (SHA-256). */
  rawSign: RawSigner
  /** Log out, close the session and finalize. Always call this when done. */
  close: () => void
}

/**
 * Open a session on the token, log in with the PIN, locate the signing certificate and its matching
 * private key, and return a credential whose `rawSign` delegates to the card. The session stays open
 * until `close()` is called (so the CMS signed attributes can be signed in-session).
 */
export function openCard(opts: Pkcs11Options): CardCredential {
  const f = load(opts.modulePath)
  initialize(opts.modulePath, f)
  let session: number | null = null
  try {
    const slots = getSlotsWithToken(f)
    if (!slots.length) throw new Error('No smart card / token is present')
    let slot = opts.slot
    if (slot == null) {
      slot =
        opts.tokenLabel != null
          ? slots.find((s) => tokenInfo(f, s).label === opts.tokenLabel)
          : slots[0]
      if (slot == null) throw new Error(`No token found with label "${opts.tokenLabel}"`)
    }

    const sessRef = [0]
    ck('C_OpenSession', f.C_OpenSession(slot, CKF_SERIAL_SESSION, null, null, sessRef))
    session = sessRef[0]
    // Stable handle for the closures below (`session` is nulled on ownership transfer).
    const sessionHandle = session

    const pin = Buffer.from(opts.pin, 'utf8')
    try {
      ck('C_Login', f.C_Login(sessionHandle, CKU_USER, pin, pin.length))
    } catch (e) {
      throw new Error(`Card login failed — check the PIN. (${(e as Error).message})`)
    } finally {
      pin.fill(0)
    }

    // Find the signing certificate (prefer one matching certLabel), then its key by shared CKA_ID.
    const certs = findObjects(f, sessionHandle, [
      { type: CKA_CLASS, value: ulongValue(CKO_CERTIFICATE) },
      { type: CKA_CERTIFICATE_TYPE, value: ulongValue(CKC_X_509) }
    ])
    if (!certs.length) throw new Error('No X.509 certificate found on the token')
    let certHandle = certs[0]
    if (opts.certLabel != null) {
      const match = certs.find(
        (h) => getAttribute(f, sessionHandle, h, CKA_LABEL).toString('utf8') === opts.certLabel
      )
      if (match == null) throw new Error(`No certificate found with label "${opts.certLabel}"`)
      certHandle = match
    }
    const certBytes = getAttribute(f, sessionHandle, certHandle, CKA_VALUE)
    if (!certBytes.length) throw new Error('Certificate object has no value')
    const certId = getAttribute(f, sessionHandle, certHandle, CKA_ID)

    // Match the private key to the cert by CKA_ID; fall back to the sole private key if unmatched.
    const keyTemplate: Array<{ type: number; value: Buffer }> = [
      { type: CKA_CLASS, value: ulongValue(CKO_PRIVATE_KEY) }
    ]
    if (certId.length) keyTemplate.push({ type: CKA_ID, value: certId })
    let keys = findObjects(f, sessionHandle, keyTemplate)
    if (!keys.length && certId.length) {
      keys = findObjects(f, sessionHandle, [
        { type: CKA_CLASS, value: ulongValue(CKO_PRIVATE_KEY) }
      ])
    }
    if (!keys.length) throw new Error('No private key found on the token')
    const keyHandle = keys[0]

    const rawSign: RawSigner = async (data) => {
      const input = Buffer.from(data)
      ck(
        'C_SignInit',
        f.C_SignInit(
          sessionHandle,
          [{ mechanism: CKM_SHA256_RSA_PKCS, pParameter: null, ulParameterLen: 0 }],
          keyHandle
        )
      )
      // Two-call pattern: probe the signature length (NULL output), then sign into a right-sized
      // buffer — so any RSA key size works without a magic upper bound.
      const lenRef = [0]
      ck('C_Sign(len)', f.C_Sign(sessionHandle, input, input.length, null, lenRef))
      const sigBuf = Buffer.alloc(lenRef[0])
      const sigLen = [sigBuf.length]
      ck('C_Sign', f.C_Sign(sessionHandle, input, input.length, sigBuf, sigLen))
      const sig = sigBuf.slice(0, sigLen[0])
      return sig.buffer.slice(sig.byteOffset, sig.byteOffset + sig.byteLength)
    }

    const certDer = new Uint8Array(certBytes).buffer.slice(0)
    session = null // ownership transfers to the returned credential
    return {
      certDer,
      rawSign,
      close: () => {
        try {
          f.C_Logout(sessionHandle)
        } catch {
          /* ignore */
        }
        try {
          f.C_CloseSession(sessionHandle)
        } catch {
          /* ignore */
        }
        finalize(opts.modulePath, f)
      }
    }
  } catch (e) {
    if (session != null) {
      try {
        f.C_CloseSession(session)
      } catch {
        /* ignore */
      }
    }
    finalize(opts.modulePath, f)
    throw e
  }
}
