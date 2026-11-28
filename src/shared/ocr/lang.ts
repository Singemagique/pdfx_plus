// Tesseract language codes → BCP 47 tags, for the text layer's marked-content /Lang (DESIGN.md
// §3.7.5) and, later, the catalog /Lang rule. Covers the languages the catalogue can ship plus the
// common Tesseract codes; anything else maps to 'und' (undetermined), which is valid BCP 47.

const TESS_TO_BCP47: Readonly<Record<string, string>> = {
  afr: 'af',
  ara: 'ar',
  aze: 'az',
  bel: 'be',
  ben: 'bn',
  bul: 'bg',
  cat: 'ca',
  ces: 'cs',
  chi_sim: 'zh-Hans',
  chi_tra: 'zh-Hant',
  dan: 'da',
  deu: 'de',
  ell: 'el',
  eng: 'en',
  est: 'et',
  eus: 'eu',
  fas: 'fa',
  fin: 'fi',
  fra: 'fr',
  gle: 'ga',
  glg: 'gl',
  heb: 'he',
  hin: 'hi',
  hrv: 'hr',
  hun: 'hu',
  ind: 'id',
  isl: 'is',
  ita: 'it',
  jpn: 'ja',
  kor: 'ko',
  lat: 'la',
  lav: 'lv',
  lit: 'lt',
  mkd: 'mk',
  msa: 'ms',
  nld: 'nl',
  nor: 'no',
  pol: 'pl',
  por: 'pt',
  ron: 'ro',
  rus: 'ru',
  slk: 'sk',
  slv: 'sl',
  spa: 'es',
  sqi: 'sq',
  srp: 'sr',
  swe: 'sv',
  tha: 'th',
  tur: 'tr',
  ukr: 'uk',
  vie: 'vi'
}

/** The BCP 47 tag for a Tesseract language code ('und' when unknown). */
export function bcp47FromTesseract(code: string | undefined): string {
  if (!code) return 'und'
  return Object.hasOwn(TESS_TO_BCP47, code) ? TESS_TO_BCP47[code] : 'und'
}
