import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { decode as jpegDecode, encode as jpegEncode } from 'jpeg-js'
import { describe, expect, it } from 'vitest'

import { scanMath } from '../../test-utils/source-scan'
import {
  applyAffine,
  background,
  binarize,
  composeAffine,
  createRng,
  crop,
  expNeg,
  gaussianBlur,
  gaussianKernel,
  gaussianNoise,
  invertAffine,
  jpegRoundTrip,
  lightingGradient,
  makeImage,
  meanLevel,
  resample,
  rotate,
  rotateQuarter,
  saltAndPepper,
  sfc32,
  sinCosDeg,
  type GreyImage
} from './degrade'

const img = (width: number, height: number, values: number[]): GreyImage => ({
  width,
  height,
  data: Uint8Array.from(values)
})

/** A reproducible pseudo-random test image (not from the code under test's streams). */
function randomImage(w: number, h: number, seed: number): GreyImage {
  const r = sfc32(seed, 0x1234, 0x5678, 0x9abc)
  const im = makeImage(w, h)
  for (let i = 0; i < im.data.length; i++) im.data[i] = r() & 0xff
  return im
}

const same = (a: GreyImage, b: GreyImage): boolean =>
  a.width === b.width && a.height === b.height && Buffer.from(a.data).equals(Buffer.from(b.data))

function stats(im: GreyImage): { mean: number; sd: number } {
  const mean = meanLevel(im)
  let v = 0
  for (const x of im.data) v += (x - mean) * (x - mean)
  return { mean, sd: Math.sqrt(v / im.data.length) }
}

describe('determinism rules', () => {
  const read = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

  it.each(['./degrade.ts', './synth.ts', './pdfium-raster.ts'])(
    '%s calls no transcendental or random Math function',
    (file) => {
      expect(scanMath(read(file), file)).toEqual([])
    }
  )

  // The check the design asked for: does jpeg-js 0.4.4 use Math transcendentals? (It does not, so
  // jpeg35 would be hash-safe as far as maths goes; it is still left out of the hash guards so a
  // codec bump can't masquerade as a determinism bug.)
  it.each(['encoder.js', 'decoder.js'])('jpeg-js lib/%s uses no transcendental Math', (f) => {
    const rel = `../../../../node_modules/jpeg-js/lib/${f}`
    expect(scanMath(read(rel), f)).toEqual([])
  })

  it('scanMath itself: reports real uses, ignores comments and strings', () => {
    const src = [
      '// Math.sin(x) in a comment',
      'const s = "Math.exp(1)"',
      'const a = Math.floor(1.5) + Math.sqrt(2)',
      'const b = Math.cos(x)',
      "const c = Math['log'](2)",
      'const { pow, abs } = Math',
      'const d = x ** 2',
      'const e = Math.random()'
    ].join('\n')
    expect(scanMath(src).map((f) => f.name)).toEqual([
      'Math.cos',
      'Math[log]',
      'Math.pow',
      '**',
      'Math.random'
    ])
  })
})

describe('sfc32 / createRng', () => {
  it('is seeded and stream-separated', () => {
    const take = (seed: number, stream: string): number[] => {
      const r = createRng(seed, stream)
      return Array.from({ length: 4 }, () => r())
    }
    expect(take(1, 'a')).toEqual(take(1, 'a'))
    expect(take(1, 'a')).not.toEqual(take(2, 'a'))
    expect(take(1, 'a')).not.toEqual(take(1, 'b'))
    for (const v of take(99, 'x')) expect(Number.isInteger(v) && v >= 0 && v < 2 ** 32).toBe(true)
  })

  it('pins the first outputs (any change here re-seeds every corpus raster)', () => {
    const r = sfc32(1, 2, 3, 4)
    expect(Array.from({ length: 4 }, () => r())).toEqual(SFC32_1234)
    const g = createRng(1, 'noise')
    expect(Array.from({ length: 3 }, () => g())).toEqual(CREATE_RNG_1_NOISE)
  })

  it('is roughly uniform', () => {
    const r = createRng(5, 'uniform')
    let sum = 0
    const n = 100000
    for (let i = 0; i < n; i++) sum += r() / 2 ** 32
    expect(Math.abs(sum / n - 0.5)).toBeLessThan(0.005)
  })
})

describe('deterministic real helpers', () => {
  it('expNeg matches e^−x to ~1 ulp', () => {
    for (const x of [0, 0.125, 0.5, 1, 2.5, 4.5, 10, 30])
      expect(Math.abs(expNeg(x) / Math.exp(-x) - 1)).toBeLessThan(1e-14)
    expect(expNeg(0)).toBe(1)
    expect(() => expNeg(-1)).toThrow()
  })

  it('sinCosDeg matches sin/cos and is exact at quarter turns', () => {
    for (const d of [-200, -91, -45, -3, 0, 2, 3, 30, 44.9, 45, 60, 89, 135, 359.5]) {
      const { sin, cos } = sinCosDeg(d)
      expect(sin).toBeCloseTo(Math.sin((d * Math.PI) / 180), 14)
      expect(cos).toBeCloseTo(Math.cos((d * Math.PI) / 180), 14)
    }
    expect(sinCosDeg(0)).toEqual({ sin: 0, cos: 1 })
    expect(sinCosDeg(90).sin).toBe(1)
    expect(sinCosDeg(180).cos).toBe(-1)
    expect(sinCosDeg(-90).sin).toBe(-1)
  })
})

describe('gaussianBlur', () => {
  it('uses a symmetric integer kernel summing to 2^14', () => {
    // σ = 1, radius 3: g = e^(−x²/2) = 0.011109, 0.135335, 0.606531, 1; Σ (7 taps) = 2.505950.
    // g/Σ·16384 = 72.63, 884.83, 3965.52 → 73, 885, 3966; the centre takes 16384 − 2·4924 = 6536.
    expect(Array.from(gaussianKernel(1))).toEqual([73, 885, 3966, 6536, 3966, 885, 73])
    for (const s of [0.5, 0.7, 1.3, 2]) {
      const k = gaussianKernel(s)
      expect(k.reduce((a, b) => a + b, 0)).toBe(16384)
      expect(Array.from(k)).toEqual(Array.from(k).reverse())
    }
  })

  it('leaves a flat image unchanged', () => {
    const flat = makeImage(17, 9, 77)
    expect(same(gaussianBlur(flat, 1.5), flat)).toBe(true)
  })

  it('preserves the mean (mirrored edges, ±0.5 level rounding)', () => {
    const r = randomImage(64, 48, 3)
    expect(Math.abs(meanLevel(gaussianBlur(r, 1)) - meanLevel(r))).toBeLessThan(0.5)
    // An interior impulse keeps its mass: 255 spread over the 7×7 footprint, ±1 per pass rounding.
    const dot = makeImage(21, 21, 0)
    dot.data[10 * 21 + 10] = 255
    const blurred = gaussianBlur(dot, 1)
    const total = blurred.data.reduce((a, b) => a + b, 0)
    expect(Math.abs(total - 255)).toBeLessThanOrEqual(24)
    expect(blurred.data[10 * 21 + 10]).toBeLessThan(255)
  })

  it('reduces variance', () => {
    const r = randomImage(64, 48, 4)
    expect(stats(gaussianBlur(r, 1)).sd).toBeLessThan(stats(r).sd / 2)
  })
})

describe('rotateQuarter', () => {
  const m = img(3, 2, [1, 2, 3, 4, 5, 6]) // rows: 1 2 3 / 4 5 6

  it('maps pixels exactly', () => {
    expect(rotateQuarter(m, 1).image).toEqual(img(2, 3, [3, 6, 2, 5, 1, 4])) // 90° CCW
    expect(rotateQuarter(m, 2).image).toEqual(img(3, 2, [6, 5, 4, 3, 2, 1]))
    expect(rotateQuarter(m, 3).image).toEqual(img(2, 3, [4, 1, 5, 2, 6, 3])) // 90° CW
    expect(rotateQuarter(m, -1).image).toEqual(rotateQuarter(m, 3).image)
    let r = m
    for (let k = 0; k < 4; k++) r = rotateQuarter(r, 1).image
    expect(r).toEqual(m)
  })

  it('its transform carries pixel centres to the pixel they land on', () => {
    for (const turns of [1, 2, 3]) {
      const { image, transform } = rotateQuarter(m, turns)
      for (let y = 0; y < m.height; y++)
        for (let x = 0; x < m.width; x++) {
          const [ox, oy] = applyAffine(transform, x + 0.5, y + 0.5)
          expect(image.data[Math.floor(oy) * image.width + Math.floor(ox)]).toBe(
            m.data[y * m.width + x]
          )
        }
    }
  })
})

describe('rotate (fixed-point bilinear)', () => {
  it('rotation by 0 (and 360) is the identity', () => {
    const r = randomImage(31, 17, 9)
    expect(same(rotate(r, 0).image, r)).toBe(true)
    expect(same(rotate(r, 360).image, r)).toBe(true)
    expect(rotate(r, 0).transform).toEqual([1, 0, 0, 1, 0, 0])
  })

  it('±90° on a square image and 180° on any image equal the exact quarter turns', () => {
    const sq = randomImage(16, 16, 10)
    expect(same(rotate(sq, 90).image, rotateQuarter(sq, 1).image)).toBe(true)
    expect(same(rotate(sq, -90).image, rotateQuarter(sq, 3).image)).toBe(true)
    const rect = randomImage(15, 8, 11)
    expect(same(rotate(rect, 180).image, rotateQuarter(rect, 2).image)).toBe(true)
  })

  it('fills uncovered corners with white', () => {
    const black = makeImage(40, 20, 0)
    const out = rotate(black, 30).image
    expect(out.data[0]).toBe(255)
    expect(out.data[10 * 40 + 20]).toBe(0)
  })

  it('moves content where its transform says (positive = counter-clockwise on screen)', () => {
    const w = 200
    const h = 120
    const src = makeImage(w, h)
    // A 5×5 black square centred at (150.5, 30.5) (continuous coords: pixels 148..152, 28..32).
    for (let y = 28; y <= 32; y++) for (let x = 148; x <= 152; x++) src.data[y * w + x] = 0
    const { image, transform } = rotate(src, 7)
    let sx = 0
    let sy = 0
    let mass = 0
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const d = 255 - image.data[y * w + x]
        sx += d * (x + 0.5)
        sy += d * (y + 0.5)
        mass += d
      }
    const [ex, ey] = applyAffine(transform, 150.5, 30.5)
    expect(Math.abs(sx / mass - ex)).toBeLessThan(0.1)
    expect(Math.abs(sy / mass - ey)).toBeLessThan(0.1)
    // CCW on screen with y down: a point right of and above the centre moves further up.
    expect(ey).toBeLessThan(30.5)
  })
})

describe('resample (box filter)', () => {
  it('2:1 averages blocks, rounding half up', () => {
    const r = resample(img(4, 2, [10, 20, 0, 255, 30, 41, 1, 0]), 2, 1)
    // (10+20+30+41)/4 = 25.25 → 25; (0+255+1+0)/4 = 64
    expect(r.image).toEqual(img(2, 1, [25, 64]))
    expect(r.transform).toEqual([0.5, 0, 0, 0.5, 0, 0])
  })

  it('3:2 weights partial pixels', () => {
    // out0 = (2·30 + 60)/3 = 40, out1 = (60 + 2·90)/3 = 80
    expect(resample(img(3, 1, [30, 60, 90]), 2, 1).image).toEqual(img(2, 1, [40, 80]))
  })

  it('1:2 upscale replicates', () => {
    expect(resample(img(2, 1, [7, 200]), 4, 2).image).toEqual(
      img(4, 2, [7, 7, 200, 200, 7, 7, 200, 200])
    )
  })

  it('preserves a flat level and the mean of an exact 2:1 reduction', () => {
    expect(same(resample(makeImage(9, 6, 99), 3, 2).image, makeImage(3, 2, 99))).toBe(true)
    const r = randomImage(60, 40, 12)
    expect(Math.abs(meanLevel(resample(r, 30, 20).image) - meanLevel(r))).toBeLessThan(0.5)
  })
})

describe('noise', () => {
  it('Gaussian noise is seeded and has the requested σ', () => {
    const grey = makeImage(200, 200, 128)
    const a = gaussianNoise(grey, 12, createRng(1, 'n'))
    const b = gaussianNoise(grey, 12, createRng(1, 'n'))
    const c = gaussianNoise(grey, 12, createRng(2, 'n'))
    expect(same(a, b)).toBe(true)
    expect(same(a, c)).toBe(false)
    const { mean, sd } = stats(a)
    expect(Math.abs(mean - 128)).toBeLessThan(0.2)
    expect(Math.abs(sd - 12)).toBeLessThan(0.3)
    expect(Math.max(...a.data) - 128).toBeLessThanOrEqual(72) // Irwin–Hall is bounded at 6σ
  })

  it('σ = 0 adds nothing', () => {
    const r = randomImage(10, 10, 1)
    expect(same(gaussianNoise(r, 0, createRng(1)), r)).toBe(true)
  })

  it('salt-and-pepper hits ~p of the pixels, half each way', () => {
    const grey = makeImage(200, 200, 128)
    const out = saltAndPepper(grey, 0.005, createRng(3, 'sp'))
    let salt = 0
    let pepper = 0
    for (const v of out.data)
      if (v === 255) salt++
      else if (v === 0) pepper++
    // Expected 200 of 40,000 (binomial sd ≈ 14).
    expect(salt + pepper).toBeGreaterThan(150)
    expect(salt + pepper).toBeLessThan(250)
    expect(Math.abs(salt - pepper)).toBeLessThan(60)
    expect(same(out, saltAndPepper(grey, 0.005, createRng(3, 'sp')))).toBe(true)
  })
})

describe('photometric ops', () => {
  it('binarize', () => {
    expect(binarize(img(4, 1, [0, 127, 128, 255])).data).toEqual(Uint8Array.from([0, 0, 255, 255]))
    expect(binarize(img(2, 1, [99, 100]), 100).data).toEqual(Uint8Array.from([0, 255]))
  })

  it('background multiplies: white → level, black stays black', () => {
    expect(background(img(3, 1, [255, 0, 128]), 200).data).toEqual(
      Uint8Array.from([200, 0, 100]) // 128·200/255 = 100.39 → 100
    )
  })

  it('lighting ramps the gain corner to corner', () => {
    const out = lightingGradient(makeImage(11, 11, 200), 256, 128)
    expect(out.data[0]).toBe(200) // gain 1
    expect(out.data[120]).toBe(100) // gain 0.5 at the far corner
    expect(out.data[5 * 11 + 5]).toBe(150) // halfway: gain 192/256
  })

  it('crop', () => {
    expect(crop(img(3, 2, [1, 2, 3, 4, 5, 6]), 1, 0, 2, 2)).toEqual(img(2, 2, [2, 3, 5, 6]))
    expect(() => crop(makeImage(2, 2), 1, 1, 2, 2)).toThrow()
  })
})

describe('jpegRoundTrip (jpeg-js 0.4.4)', () => {
  const codec = {
    encode: (i: { width: number; height: number; data: Uint8Array }, q: number) => jpegEncode(i, q),
    decode: (b: Uint8Array, o: { useTArray: true; formatAsRGBA: boolean }) => jpegDecode(b, o)
  }

  it('round-trips a grey image with bounded loss, deterministically', () => {
    const src = makeImage(64, 32)
    for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) src.data[y * 64 + x] = x * 4
    const a = jpegRoundTrip(src, 35, codec)
    const b = jpegRoundTrip(src, 35, codec)
    expect(a.jpeg[0]).toBe(0xff)
    expect(a.jpeg[1]).toBe(0xd8)
    expect(same(a.image, b.image)).toBe(true)
    expect(Buffer.from(a.jpeg).equals(Buffer.from(b.jpeg))).toBe(true)
    let err = 0
    for (let i = 0; i < src.data.length; i++) err += Math.abs(a.image.data[i] - src.data[i])
    expect(err / src.data.length).toBeLessThan(4)
    expect(err).toBeGreaterThan(0) // q35 is lossy
  })
})

describe('affine helpers', () => {
  it('compose and invert', () => {
    const a: [number, number, number, number, number, number] = [2, 0, 0, 3, 5, 7]
    const b: [number, number, number, number, number, number] = [0, -1, 1, 0, 0, 10]
    const ab = composeAffine(a, b)
    const [x1, y1] = applyAffine(b, ...applyAffine(a, 1, 2))
    expect(applyAffine(ab, 1, 2)).toEqual([x1, y1])
    const [x2, y2] = applyAffine(invertAffine(ab), x1, y1)
    expect(x2).toBeCloseTo(1, 12)
    expect(y2).toBeCloseTo(2, 12)
    expect(Object.is(composeAffine([1, 0, 0, 1, 0, 0], [-1, -0, 0, -1, 0, 0])[1], 0)).toBe(true)
  })
})

// sfc32(1, 2, 3, 4) by hand: t = a + b + d = 7; then a = 2, b = 3 + 3·8 = 27, d = 5,
// c = rotl(3, 21) + 7 = 6291463; next t = 2 + 27 + 5 = 34; next t = 27 + 9·6291463 + 6 = 56623200.
// The 4th output and createRng's are recorded from this implementation.
const SFC32_1234 = [7, 34, 56623200, 188882296]
const CREATE_RNG_1_NOISE = [227365881, 3964428617, 1710424679]
