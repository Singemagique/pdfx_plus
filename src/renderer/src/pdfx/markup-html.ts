import { PageSize, widthPx, pageCss, FONT } from './markup-units'

export type ReadResource = (ref: string) => Promise<{ data: Uint8Array; mime: string } | null>

const isLocalRef = (url: string): boolean => !!url && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(url)

const toBase64 = (data: Uint8Array): string => {
  let s = ''
  for (const b of data) s += String.fromCharCode(b)
  return btoa(s)
}

const inlineResources = async (doc: Document, read: ReadResource): Promise<void> => {
  for (const link of Array.from(doc.querySelectorAll('link[rel~="stylesheet"]'))) {
    const href = link.getAttribute('href') ?? ''
    if (!isLocalRef(href)) continue
    const res = await read(href)
    if (!res) continue
    const style = doc.createElement('style')
    style.textContent = new TextDecoder('utf-8').decode(res.data)
    link.replaceWith(style)
  }
  for (const img of Array.from(doc.querySelectorAll('img, image'))) {
    const attr = img.hasAttribute('src') ? 'src' : 'href'
    const ref = img.getAttribute(attr) ?? ''
    if (!isLocalRef(ref)) continue
    const res = await read(ref)
    if (!res) continue
    img.setAttribute(attr, `data:${res.mime};base64,${toBase64(res.data)}`)
  }
}

export const buildHtmlDoc = async (
  markup: string,
  page: PageSize,
  read?: ReadResource
): Promise<string> => {
  const doc = new DOMParser().parseFromString(markup, 'text/html')
  doc.querySelectorAll('script,iframe,object,embed,base').forEach((n) => n.remove())
  doc.querySelectorAll('link[rel="import"],meta[http-equiv]').forEach((n) => n.remove())
  doc.querySelectorAll('*').forEach((n) =>
    Array.from(n.attributes).forEach((a) => {
      const an = a.name.toLowerCase()
      if (an.startsWith('on')) n.removeAttribute(a.name)
      else if (/^(href|src|xlink:href)$/.test(an) && /^\s*javascript:/i.test(a.value)) {
        n.removeAttribute(a.name)
      }
    })
  )
  if (read) await inlineResources(doc, read)
  const style = doc.createElement('style')
  style.textContent = `${pageCss(page)}body{width:${widthPx(page)}px;font:15px/1.55 ${FONT};color:#16161a}`
  doc.head.appendChild(style)
  return '<!doctype html>' + doc.documentElement.outerHTML
}
