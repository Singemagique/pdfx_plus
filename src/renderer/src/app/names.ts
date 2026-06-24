import type { DocEntry } from '../types'

export function uniqueDocName(desired: string, taken: Set<string>): string {
  if (!taken.has(desired)) return desired
  for (let n = 2; ; n++) {
    const candidate = `${desired} (${n})`
    if (!taken.has(candidate)) return candidate
  }
}

export function dedupeNames(existing: DocEntry[], incoming: DocEntry[]): DocEntry[] {
  const taken = new Set(existing.map((d) => d.name))
  return incoming.map((doc) => {
    const name = uniqueDocName(doc.name, taken)
    taken.add(name)
    return name === doc.name ? doc : { ...doc, name }
  })
}
