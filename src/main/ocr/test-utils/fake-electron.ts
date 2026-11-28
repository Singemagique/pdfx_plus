// Test-only stand-in for `require('electron')` inside a utility process, which PR0 measured as
// `{ net: { fetch, isOnline, request, resolveHost }, systemPreferences }` with writable, configurable
// members. Aliased in place of `electron` when the tripwire probe is bundled for a child process.

const unpatched = (): never => {
  throw new Error('fake electron.net reached: the tripwire did not patch it')
}

export const net = {
  fetch: unpatched,
  request: unpatched,
  resolveHost: unpatched,
  isOnline: unpatched
}

export const systemPreferences = {}
