import { describe, expect, it } from 'vitest'

import { bcp47FromTesseract } from './lang'
import { needsSpaceBetween, spaceClass } from './spacing'
import { cleanOcrText, isWideCodePoint } from './text'

const cp = (s: string): number => s.codePointAt(0)!

describe('needsSpaceBetween', () => {
  it('keeps the space between non-CJK words', () => {
    expect(needsSpaceBetween('Hello', 'world')).toBe(true)
    expect(needsSpaceBetween('2026-11-27', '09:14')).toBe(true)
    expect(needsSpaceBetween('Привет', 'мир')).toBe(true)
    expect(needsSpaceBetween({ t: 'a' }, { t: 'b' })).toBe(true)
  })

  it('drops it between Han, kana, CJK punctuation and fullwidth forms', () => {
    expect(needsSpaceBetween('東京都', 'の')).toBe(false)
    expect(needsSpaceBetween('天気', '予報')).toBe(false)
    expect(needsSpaceBetween('テキスト', 'データ')).toBe(false)
    expect(needsSpaceBetween('ラーメン', '屋')).toBe(false) // ー is script Common
    expect(needsSpaceBetween('中文', '。')).toBe(false)
    expect(needsSpaceBetween('「引用', '」')).toBe(false)
    expect(needsSpaceBetween('ＡＢＣ', '漢字')).toBe(false) // fullwidth Latin
    expect(needsSpaceBetween('ｶﾀｶﾅ', 'ﾃｽﾄ')).toBe(false) // halfwidth katakana
    expect(needsSpaceBetween('𠀋', '字')).toBe(false) // CJK Extension B (non-BMP)
  })

  it('keeps Korean word spacing but joins Hangul to Han', () => {
    expect(needsSpaceBetween('한국어', '텍스트')).toBe(true)
    expect(needsSpaceBetween('大韓', '민국')).toBe(false)
    expect(needsSpaceBetween('민국', '大韓')).toBe(false)
  })

  it('keeps the space at every CJK / non-CJK boundary', () => {
    expect(needsSpaceBetween('PDF', '文書')).toBe(true)
    expect(needsSpaceBetween('文書', 'PDF')).toBe(true)
    expect(needsSpaceBetween('第3', '章')).toBe(true) // the last char of "第3" is a digit
    expect(needsSpaceBetween('', '字')).toBe(true)
  })

  it('classifies single code points', () => {
    expect(spaceClass(cp('a'))).toBe('other')
    expect(spaceClass(cp('字'))).toBe('cjk')
    expect(spaceClass(cp('、'))).toBe('cjk')
    expect(spaceClass(cp('한'))).toBe('hangul')
    expect(spaceClass(0xffa1)).toBe('hangul') // halfwidth Hangul, inside the fullwidth block
  })
})

describe('cleanOcrText', () => {
  it('expands the Latin ligatures and normalises to NFC', () => {
    expect(cleanOcrText('ﬁnd ﬂow oﬀice ﬃ ﬄ ﬅ ﬆ')).toBe('find flow office ffi ffl st st')
    expect(cleanOcrText('é')).toBe('é')
  })

  it('drops what a ToUnicode CMap must not carry', () => {
    expect(cleanOcrText('a\u0000b﻿c￾d')).toBe('abcd')
    expect(cleanOcrText('soft­hyphen zero​width')).toBe('softhyphen zerowidth')
    expect(cleanOcrText('lone\ud800 \udc00half')).toBe('lone half')
    expect(cleanOcrText('emoji 😀 kept')).toBe('emoji 😀 kept')
  })

  it('collapses whitespace runs and trims', () => {
    expect(cleanOcrText('  two\t\n words ​ ')).toBe('two words')
    expect(cleanOcrText(' ​ ')).toBe('')
  })
})

describe('isWideCodePoint', () => {
  it('is true for East Asian Wide and Fullwidth code points', () => {
    for (const ch of ['字', 'の', 'ア', '한', '、', 'Ａ', '￥', '😀', '𠀋'])
      expect(isWideCodePoint(cp(ch)), ch).toBe(true)
  })

  it('is false for narrow, halfwidth and ambiguous ones', () => {
    for (const ch of ['a', 'é', 'Ж', 'ｱ', '·', '€', '́', ' '])
      expect(isWideCodePoint(cp(ch)), ch).toBe(false)
  })
})

describe('bcp47FromTesseract', () => {
  it('maps Tesseract codes to BCP 47 and falls back to und', () => {
    expect(bcp47FromTesseract('eng')).toBe('en')
    expect(bcp47FromTesseract('deu')).toBe('de')
    expect(bcp47FromTesseract('chi_sim')).toBe('zh-Hans')
    expect(bcp47FromTesseract('jpn')).toBe('ja')
    expect(bcp47FromTesseract('osd')).toBe('und')
    expect(bcp47FromTesseract(undefined)).toBe('und')
    expect(bcp47FromTesseract('toString')).toBe('und')
  })
})
