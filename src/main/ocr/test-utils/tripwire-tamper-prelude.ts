// Test-only: imported BEFORE the tripwire by tripwire-tamper-probe.ts. It gives globalThis an
// EventSource that is a non-configurable accessor (the shape a runtime could have), so the tripwire
// cannot lock that slot and has to fall back to assignment: exactly the slot `tripwireIntact()`
// exists to watch.

let current: unknown = undefined
Object.defineProperty(globalThis, 'EventSource', {
  get: () => current,
  set: (v: unknown) => {
    current = v
  },
  configurable: false,
  enumerable: false
})
