// What the network tripwire (no-network.ts) replaces, as plain data: no-network.ts installs on
// import, so tests that only need the lists import them from here instead.

export const GLOBALS = ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'Request'] as const

/** Stubbed on dns and dns.promises even if the runtime lacks them; any other match is stubbed too. */
export const DNS_FUNCTIONS = [
  'lookup',
  'lookupService',
  'reverse',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCaa',
  'resolveCname',
  'resolveMx',
  'resolveNaptr',
  'resolveNs',
  'resolvePtr',
  'resolveSoa',
  'resolveSrv',
  'resolveTlsa',
  'resolveTxt'
] as const
/** What counts as a DNS query function on dns / dns.promises / a Resolver prototype. */
export const DNS_FUNCTION_RE = /^(resolve|lookup|reverse)/

export const CHILD_PROCESS_FUNCTIONS = [
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork'
] as const

export const ELECTRON_NET = ['fetch', 'request', 'resolveHost', 'isOnline'] as const

/**
 * The Electron linked bindings the OCR process may still load (Electron's own lib loads some of
 * them lazily, asar reads among them). Everything else trips: electron_common_net (Chromium's
 * network service), electron_common_shell (openExternal), the crash reporter, and every browser or
 * renderer binding, which a utility process has no use for. An unknown name trips too, so a future
 * Electron that adds a binding fails loudly here instead of opening a path.
 */
export const LINKED_BINDINGS_ALLOWED: ReadonlySet<string> = new Set([
  'electron_common_asar',
  'electron_common_command_line',
  'electron_common_environment',
  'electron_common_features',
  'electron_common_native_image',
  'electron_common_v8_util',
  'electron_utility_parent_port'
])
