import { execFileSync } from 'node:child_process'
import { copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

if (process.platform !== 'darwin') {
  console.log('[build-native] Skipping native glass addon (macOS only).')
  process.exit(0)
}

const nativeDir = fileURLToPath(new URL('../native/', import.meta.url))
const outAbs = join(nativeDir, 'build/Release/glass.node')

const gyp = (...args) => execFileSync('node-gyp', args, { cwd: nativeDir, stdio: 'inherit' })

try {
  const slices = ['arm64', 'x64'].map((arch) => {
    gyp('rebuild', `--arch=${arch}`)
    const slice = join(tmpdir(), `pdfx-glass-${arch}.node`)
    copyFileSync(outAbs, slice)
    return slice
  })
  execFileSync('lipo', ['-create', ...slices, '-output', outAbs], { stdio: 'inherit' })
  console.log('[build-native] Built universal glass addon (arm64 + x86_64).')
} catch (error) {
  console.warn(
    `[build-native] Universal build failed (${error.message}); falling back to host arch.`
  )
  gyp('rebuild')
}
