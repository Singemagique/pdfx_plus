// The packaged self-test's embedded page (`pdfx --ocr-selftest`): a hand-built one-page PDF so main
// needs no PDF library. US Letter, the top tenth solid black, one line of Helvetica. PR11 swaps in
// the `clean300` preset for the exact replay comparison (§3.9.3 tier 1c).

export const SELFTEST_PAGE = { width: 612, height: 792 } as const
/** The fraction of the page the black band covers (the text adds a little more ink). */
export const SELFTEST_BAND_FRACTION = 0.1

export function selftestPdf(): Uint8Array {
  const band = SELFTEST_PAGE.height * SELFTEST_BAND_FRACTION
  const content =
    `0 g 0 ${SELFTEST_PAGE.height - band} ${SELFTEST_PAGE.width} ${band} re f\n` +
    'BT /F1 36 Tf 72 600 Td (PDFx OCR self-test) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${SELFTEST_PAGE.width} ${SELFTEST_PAGE.height}] ` +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  ]
  let pdf = '%PDF-1.7\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = pdf.length
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  // ASCII only, so string offsets are byte offsets.
  return new TextEncoder().encode(pdf)
}
