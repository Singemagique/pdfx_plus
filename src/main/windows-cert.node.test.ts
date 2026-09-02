import { afterEach, describe, expect, it } from 'vitest'

import { listWindowsCerts, windowsCertChain, windowsCertCredential } from './windows-cert'

const realPlatform = process.platform
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

afterEach(() => setPlatform(realPlatform))

describe('windows-cert platform guard', () => {
  // The module shells out to powershell.exe; off Windows that is either missing (opaque ENOENT) or,
  // worse, some unrelated binary. Each entry point self-guards rather than trusting its caller.
  it('rejects every entry point with a clear error when not on Windows', async () => {
    setPlatform('darwin')
    const thumbprint = 'A'.repeat(40) // well-formed, so the platform check is what must fire
    const message = /Windows certificate store is only available on Windows/

    await expect(listWindowsCerts()).rejects.toThrow(message)
    await expect(windowsCertChain(thumbprint)).rejects.toThrow(message)
    await expect(windowsCertCredential(thumbprint)).rejects.toThrow(message)
  })

  it('checks the platform BEFORE validating the thumbprint', async () => {
    setPlatform('linux')
    await expect(windowsCertChain('not-a-thumbprint')).rejects.toThrow(/only available on Windows/)
  })
})
