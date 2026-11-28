// Test-only probe for no-network.node.test.ts: a slot the tripwire could only assign (see
// tripwire-tamper-prelude.ts) still trips, and putting something else back in it is what
// `tripwireIntact()` reports.

import './tripwire-tamper-prelude'
import { tripwireCount, tripwireIntact } from '../process/no-network'

const g = globalThis as unknown as Record<string, unknown>
const intactBefore = tripwireIntact()
let tripped = false
try {
  new (g.EventSource as new (u: string) => unknown)('http://127.0.0.1:9/')
} catch (e) {
  tripped = (e as { code?: string }).code === 'network'
}
g.EventSource = function Original(): void {}
process.stdout.write(
  JSON.stringify({ intactBefore, tripped, count: tripwireCount(), intactAfter: tripwireIntact() }) +
    '\n'
)
