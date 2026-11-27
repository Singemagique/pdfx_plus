import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(__dirname, 'styles.css'), 'utf8')

/** The declarations of the first top-level rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css)
  if (!m) throw new Error(`no rule for ${selector}`)
  // Drop comments so a mention of a value in prose can't satisfy (or fail) the check.
  return m[1].replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('styles.css crop window', () => {
  it('clips .full-page without making it a scroll container', () => {
    // A cropped page's `.full-page` is the crop window over the larger `.page-frame`. With
    // `overflow: hidden` focusing a form field outside the crop scrolled the window off the crop.
    const decl = rule('.full-page')
    expect(decl).toMatch(/overflow:\s*clip\s*;/)
    expect(decl).not.toMatch(/overflow:\s*hidden/)
  })
})
