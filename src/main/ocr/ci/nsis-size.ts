// The NSIS size gate (DESIGN.md §3.9.3 1c, §3.9.4): the Windows installer may grow by at most 15 MB
// (15,000,000 bytes) over the v1.1.3 installer, 103,070,739 bytes. PR0b measured +7,938,494 B with
// the four bundled languages. scripts/ocr-nsis-size.mjs lists dist/ and prints this verdict.
//
// Pure (no fs) and erasable TypeScript only, so Node 24 runs it directly.

export const V113_INSTALLER_BYTES = 103_070_739
export const MAX_GROWTH_BYTES = 15_000_000

export interface SizeVerdict {
  ok: boolean
  /** The markdown line for the log and $GITHUB_STEP_SUMMARY. */
  line: string
  growth: number | null
}

const mb = (b: number): string => (b / 1e6).toFixed(2)
const signed = (n: string, neg: boolean): string => (neg ? n : `+${n}`)

/** `installers`: every dist/*-setup.exe with its size. Exactly one must exist, within the gate. */
export function sizeVerdict(installers: { name: string; bytes: number }[]): SizeVerdict {
  if (installers.length !== 1)
    return {
      ok: false,
      growth: null,
      line:
        `- **NSIS size gate**: FAIL: expected exactly one dist/*-setup.exe, found ` +
        JSON.stringify(installers.map((i) => i.name))
    }
  const { name, bytes } = installers[0]
  const growth = bytes - V113_INSTALLER_BYTES
  const ok = Number.isFinite(bytes) && growth <= MAX_GROWTH_BYTES
  const neg = growth < 0
  return {
    ok,
    growth,
    line:
      `- **NSIS size gate**: ${ok ? 'pass' : 'FAIL'}: ${name} is ${bytes.toLocaleString('en-US')} B, ` +
      `${signed(growth.toLocaleString('en-US'), neg)} B (${signed(mb(growth), neg)} MB) ` +
      `over v1.1.3's ${V113_INSTALLER_BYTES.toLocaleString('en-US')} B; the gate is +${mb(MAX_GROWTH_BYTES)} MB`
  }
}
