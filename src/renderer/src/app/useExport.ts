import { useCallback } from 'react'
import { zipSync } from 'fflate'
import { buildPdf, buildPdfx, stripExtension } from '../pdfx/format'
import type { EditLayer } from '../pdfx/build'
import { toExportPage } from '../pdfx/source'
import { applyRedactedBytes, buildRedactedSources } from '../pdfx/redact-export'
import type { DocEntry } from '../types'

const PDFX_FILTER = { name: 'PDFX', extensions: ['pdfx'] }
const PDF_FILTER = { name: 'PDF', extensions: ['pdf'] }
const ZIP_FILTER = { name: 'ZIP', extensions: ['zip'] }
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|]/g

export function useExport(
  docs: DocEntry[],
  editLayer: EditLayer,
  setBusy: (busy: boolean) => void,
  flash: (message: string) => void
) {
  const exportCollection = useCallback(
    async (kind: 'pdfx' | 'pdf') => {
      if (docs.length === 0) {
        flash('Nothing to export')
        return
      }
      const path = await window.api.chooseSavePath(
        `untitled.${kind}`,
        kind === 'pdfx' ? PDFX_FILTER : PDF_FILTER
      )
      if (!path) return
      setBusy(true)
      try {
        const filename = path.split(/[\\/]/).pop() ?? `untitled.${kind}`
        // Redactions are applied destructively to the source bytes first (both export kinds).
        const redacted = await buildRedactedSources(editLayer, docs)
        // .pdfx embeds the manifest that lets PDFx re-split the collection; a plain
        // .pdf is a flat, manifest-free PDF that any tool reads as one document.
        const bytes =
          kind === 'pdfx'
            ? await buildPdfx(
                docs.map((doc) => ({
                  name: doc.name,
                  pages: applyRedactedBytes(doc.pages.map(toExportPage), redacted)
                })),
                stripExtension(filename).replace(/\.pdf$/i, ''),
                editLayer
              )
            : await buildPdf(
                applyRedactedBytes(
                  docs.flatMap((doc) => doc.pages.map(toExportPage)),
                  redacted
                ),
                editLayer
              )
        const saved = await window.api.writeFile(path, bytes)
        flash(`Saved ${saved}`)
      } catch (error) {
        console.error('Export failed', error)
        flash('Export failed')
      } finally {
        setBusy(false)
      }
    },
    [docs, editLayer, flash, setBusy]
  )

  // Flatten everything (incl. redaction) into a plain PDF, ask `sign` (in the main process) to
  // cryptographically sign it, and save the signed copy. The editable project is untouched. `sign`
  // differs only by credential source (.p12 file vs. smart card); flattening + save are shared.
  const flattenAndSign = useCallback(
    async (sign: (flat: Uint8Array) => Promise<Uint8Array>, failHint: string): Promise<boolean> => {
      if (docs.length === 0) {
        flash('Nothing to sign')
        return false
      }
      const path = await window.api.chooseSavePath('signed.pdf', PDF_FILTER)
      if (!path) return false
      setBusy(true)
      try {
        const redacted = await buildRedactedSources(editLayer, docs)
        const flat = await buildPdf(
          applyRedactedBytes(
            docs.flatMap((doc) => doc.pages.map(toExportPage)),
            redacted
          ),
          editLayer
        )
        const signed = await sign(flat)
        const saved = await window.api.writeFile(path, signed)
        flash(`Signed ${saved}`)
        return true
      } catch (error) {
        console.error('Signing failed', error)
        flash(failHint)
        return false
      } finally {
        setBusy(false)
      }
    },
    [docs, editLayer, flash, setBusy]
  )

  // Sign with a PKCS#12 (.p12) credential file.
  const signAndExport = useCallback(
    (
      certBytes: Uint8Array,
      opts: { passphrase: string; reason?: string; name?: string; tsaUrl?: string }
    ): Promise<boolean> =>
      flattenAndSign(
        (flat) => window.api.signPdf(flat, certBytes, opts),
        'Signing failed — check the certificate and passphrase'
      ),
    [flattenAndSign]
  )

  // Sign with a smart card / HSM via PKCS#11 (the key never leaves the token).
  const signWithCardAndExport = useCallback(
    (
      card: {
        modulePath: string
        pin: string
        slot?: number
        tokenLabel?: string
        certLabel?: string
      },
      opts: { reason?: string; name?: string; tsaUrl?: string }
    ): Promise<boolean> =>
      flattenAndSign(
        (flat) => window.api.signPdfWithCard(flat, card, opts),
        'Card signing failed — check the module path, PIN and that the card is inserted'
      ),
    [flattenAndSign]
  )

  const exportZip = useCallback(async () => {
    if (docs.length === 0) {
      flash('Nothing to export')
      return
    }
    const path = await window.api.chooseSavePath('untitled.zip', ZIP_FILTER)
    if (!path) return
    setBusy(true)
    try {
      const redacted = await buildRedactedSources(editLayer, docs)
      const entries: Record<string, Uint8Array> = {}
      const used = new Set<string>()
      for (const doc of docs) {
        const safeName = doc.name.replace(ILLEGAL_FILENAME_CHARS, '-').trim() || 'Untitled'
        let filename = `${safeName}.pdf`
        for (let n = 2; used.has(filename); n++) filename = `${safeName} (${n}).pdf`
        used.add(filename)
        entries[filename] = await buildPdf(
          applyRedactedBytes(doc.pages.map(toExportPage), redacted),
          editLayer
        )
      }
      const saved = await window.api.writeFile(path, zipSync(entries))
      flash(`Saved ${saved}`)
    } catch (error) {
      console.error('Export failed', error)
      flash('Export failed')
    } finally {
      setBusy(false)
    }
  }, [docs, editLayer, flash, setBusy])

  return { exportCollection, exportZip, signAndExport, signWithCardAndExport }
}
