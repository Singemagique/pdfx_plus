const SKIP = new Set([
  'fonttbl',
  'colortbl',
  'stylesheet',
  'info',
  'pict',
  'object',
  'header',
  'footer',
  'themedata',
  'colorschememapping',
  'datastore',
  'latentstyles',
  'listtable',
  'listoverridetable',
  'generator',
  'rsidtbl',
  'xmlnstbl'
])

export const rtfToText = (data: Uint8Array): string => {
  const s = new TextDecoder('latin1').decode(data)
  const stack = [{ skip: false, uc: 1 }]
  const top = (): { skip: boolean; uc: number } => stack[stack.length - 1]
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '{') {
      stack.push({ skip: top().skip, uc: top().uc })
      i++
    } else if (c === '}') {
      if (stack.length > 1) stack.pop()
      i++
    } else if (c === '\\') {
      const n = s[i + 1]
      if (n === '\\' || n === '{' || n === '}') {
        if (!top().skip) out += n
        i += 2
      } else if (n === "'") {
        const code = parseInt(s.substr(i + 2, 2), 16)
        if (!top().skip && !Number.isNaN(code)) out += String.fromCharCode(code)
        i += 4
      } else if (n === '*') {
        top().skip = true
        i += 2
      } else {
        const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(s.slice(i))
        if (!m) {
          i++
          continue
        }
        const word = m[1]
        const num = m[2] ? parseInt(m[2], 10) : undefined
        i += m[0].length
        if (word === 'par' || word === 'line' || word === 'sect' || word === 'row') {
          if (!top().skip) out += '\n'
        } else if (word === 'tab') {
          if (!top().skip) out += '\t'
        } else if (word === 'uc') {
          top().uc = num ?? 1
        } else if (word === 'u') {
          if (!top().skip && num != null) out += String.fromCharCode(num < 0 ? num + 0x10000 : num)
          let skip = top().uc
          while (skip-- > 0 && i < s.length) i += s[i] === '\\' ? 2 : 1
        } else if (SKIP.has(word)) {
          top().skip = true
        }
      }
    } else if (c === '\r' || c === '\n') {
      i++
    } else {
      if (!top().skip) out += c
      i++
    }
  }
  return out.replace(/\n{3,}/g, '\n\n').trim()
}
