import { useCallback, useLayoutEffect, useRef } from 'react'
import { zipSync } from 'fflate'
import { buildPdf, buildPdfx, stripExtension } from '../pdfx/format'
import type { EditLayer } from '../pdfx/build'
import { toExportPage, type ExportPageRef } from '../pdfx/source'
import { applyRedactedBytes, buildRedactedSources } from '../pdfx/redact-export'
import { countRedactedOverlays } from '../pdfx/mirror'
import { withSignatureAppearance, type AppearanceOptions } from '../pdfx/signature-appearance'
import { summarizeDss, dssNote } from '../pdfx/dss-info'
import { withOcrLayer } from '../pdfx/ocr-export'
import { noOcrExportSource, type OcrExportSource } from '../ocr/export-source'
import { makePageKey, type SignaturePlacement } from '../edit/model'
import type { DocEntry } from '../types'

const PDFX_FILTER = { name: 'PDFX', extensions: ['pdfx'] }
const PDF_FILTER = { name: 'PDF', extensions: ['pdf'] }
const ZIP_FILTER = { name: 'ZIP', extensions: ['zip'] }
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|]/g

type SaveFilter = { name: string; extensions: string[] }
/** sourceKey -> redacted bytes, as buildRedactedSources returns them. */
type RedactedSources = Map<string, Uint8Array>

/** Every page of every document, in order, with redacted source bytes swapped in. */
const flatExportPages = (docs: DocEntry[], redacted: RedactedSources): ExportPageRef[] =>
  applyRedactedBytes(
    docs.flatMap((doc) => doc.pages.map(toExportPage)),
    redacted
  )

/** Page keys of every page still in the collection — the only pages a save/export visits. */
const livePageKeys = (docs: DocEntry[]): Set<string> =>
  new Set(docs.flatMap((doc) => doc.pages.map((p) => makePageKey(p.source.id, p.pageIndex))))

/**
 * Every save path drops the overlays a redaction covers (mirror.ts's stripRedactedOverlays) — the
 * .pdfx mirror, the flattened PDF, and the zip alike (the signing path drops them the same way but
 * reports the DSS note instead). That is deliberate, but silently losing a highlight that merely
 * clipped a black box is not: say how many went, appended to "Saved …".
 */
const redactedNote = (n: number): string =>
  n > 0
    ? ` · ${n} annotation${n === 1 ? '' : 's'} under a redaction ${n === 1 ? 'was' : 'were'} removed`
    : ''

export function useExport(
  docs: DocEntry[],
  editLayer: EditLayer,
  setBusy: (busy: boolean) => void,
  flash: (message: string) => void,
  signaturePlacement: SignaturePlacement | null,
  savedSignature: Uint8Array | null,
  /** Recognised text for the invisible OCR layer (DESIGN.md §3.7.1): the OCR store (PR7b). */
  ocr: OcrExportSource = noOcrExportSource
) {
  // The collection and edit layer as of the LATEST render. The mid-job prompt (flushOrConfirm) is
  // non-modal: while "Wait and export" waits, the user keeps editing, so a redaction drawn during
  // the wait must reach the redaction pass, the OCR snapshot and the build. Every path therefore
  // reads these after its last await before the work, never the values captured at the click.
  const latest = useRef({ docs, editLayer })
  useLayoutEffect(() => {
    latest.current = { docs, editLayer }
  }, [docs, editLayer])

  /**
   * The shell every "save the collection somewhere" path shares: empty guard, OCR flush-or-confirm,
   * save dialog, busy flag, redaction pre-pass, OCR snapshot, write, flash. Only the target
   * name/filter and the byte-building step differ, so keeping them in one place is what makes the
   * three paths provably consistent — the busy flag in particular must stay balanced (App drives its
   * overlay off it), which the `finally` here guarantees for all of them at once. `build` receives
   * the redacted sources, the chosen file's basename (the .pdfx path derives the collection name
   * from it) and the edit LAYER to bake: `editLayer` plus the recognised text when exports include
   * it. Builds never capture `editLayer` themselves, so no path can bake a layer without the OCR,
   * and receive the collection (`docs`) as of the moment the work starts (see `latest`).
   */
  const saveWith = useCallback(
    async (
      defaultName: string,
      filter: SaveFilter,
      build: (
        redacted: RedactedSources,
        filename: string,
        layer: EditLayer,
        docs: DocEntry[]
      ) => Promise<Uint8Array>
    ) => {
      if (latest.current.docs.length === 0) {
        flash('Nothing to export')
        return
      }
      // D7: the persistent "Include Recognized Text When Exporting" setting, read once per export.
      const includeOcr = ocr.includeInExports()
      // BEFORE the save dialog and before busy: a mid-job prompt is answered first, and waiting
      // shows the OCR pill, never the App busy overlay. Cancel leaves everything untouched.
      if (includeOcr && !(await ocr.flushOrConfirm(latest.current.docs))) return
      const path = await window.api.chooseSavePath(defaultName, filter)
      if (!path) return
      setBusy(true)
      try {
        // What the collection is NOW, after every wait above (edits made meanwhile included).
        const { docs, editLayer } = latest.current
        if (docs.length === 0) {
          flash('Nothing to export')
          return
        }
        const filename = path.split(/[\\/]/).pop() ?? defaultName
        // Redactions are applied destructively to the source bytes first (every export kind).
        const redacted = await buildRedactedSources(editLayer, docs)
        // A COPY of the edit layer with the recognised text; pages with a redaction get none (the
        // removed-object report that allows finer filtering arrives with PR3b). With the setting
        // off, layers the sources already carry are dropped too (ocrPassthrough).
        const layer = withOcrLayer(
          editLayer,
          includeOcr ? ocr.snapshotFor(docs, editLayer) : undefined,
          { include: includeOcr }
        )
        const bytes = await build(redacted, filename, layer, docs)
        const saved = await window.api.writeFile(path, bytes)
        // Overlays a redaction covered are gone from the saved file — tell the user how many. Only
        // live pages count: a deleted page's overlays linger for undo but were never saved.
        const removed = countRedactedOverlays(editLayer.overlays, livePageKeys(docs))
        flash(`Saved ${saved}${redactedNote(removed)}`)
      } catch (error) {
        console.error('Export failed', error)
        flash(`Export failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        setBusy(false)
      }
    },
    [flash, setBusy, ocr]
  )

  // .pdfx embeds the manifest that lets PDFx re-split the collection; a plain .pdf is a flat,
  // manifest-free PDF that any tool reads as one document.
  const exportCollection = useCallback(
    (kind: 'pdfx' | 'pdf') =>
      saveWith(
        `untitled.${kind}`,
        kind === 'pdfx' ? PDFX_FILTER : PDF_FILTER,
        (redacted, filename, layer, docs) =>
          kind === 'pdfx'
            ? buildPdfx(
                docs.map((doc) => ({
                  name: doc.name,
                  pages: applyRedactedBytes(doc.pages.map(toExportPage), redacted)
                })),
                stripExtension(filename).replace(/\.pdf$/i, ''),
                layer
              )
            : buildPdf(flatExportPages(docs, redacted), layer)
      ),
    [saveWith]
  )

  // Flatten everything (incl. redaction) into a plain PDF, ask `sign` (in the main process) to
  // cryptographically sign it, and save the signed copy. The editable project is untouched. `sign`
  // differs only by credential source (.p12 file vs. smart card); flattening + save are shared.
  // `includeRecognizedText` is the Sign dialog's own "Include recognized text (machine-generated,
  // not reviewed)" box (D7): off by default, and independent of the export setting, because the
  // signature would cover machine text the signer never saw.
  const flattenAndSign = useCallback(
    async (
      sign: (flat: Uint8Array) => Promise<Uint8Array>,
      failHint: string,
      appearance: AppearanceOptions | null,
      includeRecognizedText = false
    ): Promise<boolean> => {
      if (latest.current.docs.length === 0) {
        flash('Nothing to sign')
        return false
      }
      // Only when the box is ticked: the same mid-job prompt as export, before the save dialog.
      if (includeRecognizedText && !(await ocr.flushOrConfirm(latest.current.docs))) return false
      const path = await window.api.chooseSavePath('signed.pdf', PDF_FILTER)
      if (!path) return false
      setBusy(true)
      try {
        // What the collection is NOW, after the waits above (see `latest`).
        const { docs, editLayer } = latest.current
        if (docs.length === 0) {
          flash('Nothing to sign')
          return false
        }
        // When a placement is set, splice the visible appearance into a copy of the edit layer so
        // the cryptographic signature (applied next, to the flattened bytes) covers it.
        const signedLayer =
          signaturePlacement && appearance
            ? await withSignatureAppearance(editLayer, signaturePlacement, appearance)
            : editLayer
        const redacted = await buildRedactedSources(signedLayer, docs)
        // Baked inside buildPdf, before sign(), so the signature covers the text when included.
        // Unticked, a layer a reopened source already carries is dropped as well (ocrPassthrough).
        const layer = withOcrLayer(
          signedLayer,
          includeRecognizedText ? ocr.snapshotFor(docs, editLayer) : undefined,
          { include: includeRecognizedText }
        )
        const flat = await buildPdf(
          flatExportPages(docs, redacted),
          layer,
          // Strip any existing (empty) signature fields so the signed output carries only our
          // signature, not a leftover field a viewer would offer to sign.
          { stripSignatureFields: true }
        )
        const signed = await sign(flat)
        const saved = await window.api.writeFile(path, signed)
        // If LTV was embedded, report what's in the DSS — the only local confirmation when the
        // verifier doesn't trust the signer's PKI (so no "LTV enabled" badge shows).
        flash(`Signed ${saved}${dssNote(await summarizeDss(signed))}`)
        return true
      } catch (error) {
        console.error('Signing failed', error)
        flash(failHint)
        return false
      } finally {
        setBusy(false)
      }
    },
    [flash, setBusy, signaturePlacement, ocr]
  )

  // Build the visible-appearance options from the dialog opts (null when signing invisibly).
  const appearanceOf = useCallback(
    (opts: {
      name?: string
      reason?: string
      includeImage?: boolean
      signer?: { subject: string; issuer: string }
    }): AppearanceOptions | null =>
      signaturePlacement
        ? {
            name: opts.name,
            reason: opts.reason,
            date: new Date(),
            image: opts.includeImage ? savedSignature : null,
            signer: opts.signer
          }
        : null,
    [signaturePlacement, savedSignature]
  )

  // Sign with a PKCS#12 (.p12) credential file.
  const signAndExport = useCallback(
    async (
      certBytes: Uint8Array,
      opts: {
        passphrase: string
        reason?: string
        name?: string
        tsaUrl?: string
        includeImage?: boolean
        ltv?: boolean
        /** The Sign dialog's "Include recognized text" box (D7, default off). */
        includeRecognizedText?: boolean
      }
    ): Promise<boolean> => {
      const { includeImage: _omit, includeRecognizedText = false, ...sign } = opts
      // When a visible appearance will be drawn, read the cert's identity (subject/issuer) so it can
      // show the standard "digitally signed by …" block. Best-effort — null falls back to generic.
      const signer = signaturePlacement
        ? ((await window.api.p12CertInfo(certBytes, opts.passphrase)) ?? undefined)
        : undefined
      return flattenAndSign(
        (flat) => window.api.signPdf(flat, certBytes, sign),
        'Signing failed — check the certificate and passphrase',
        appearanceOf({ ...opts, signer }),
        includeRecognizedText
      )
    },
    [flattenAndSign, appearanceOf, signaturePlacement]
  )

  // Sign with a smart card / HSM via PKCS#11 (the key never leaves the token).
  const signWithCardAndExport = useCallback(
    async (
      card: {
        modulePath: string
        pin: string
        slot?: number
        tokenLabel?: string
        certLabel?: string
      },
      opts: {
        reason?: string
        name?: string
        tsaUrl?: string
        includeImage?: boolean
        ltv?: boolean
        /** The Sign dialog's "Include recognized text" box (D7, default off). */
        includeRecognizedText?: boolean
      }
    ): Promise<boolean> => {
      const { includeImage: _omit, includeRecognizedText = false, ...sign } = opts
      // Read the card cert's identity for the appearance WITHOUT the PIN (cert objects are public), so
      // it doesn't trigger a second prompt. The pin is dropped before this call.
      const { pin: _pin, ...cardId } = card
      const signer = signaturePlacement
        ? ((await window.api.cardCertInfo(cardId)) ?? undefined)
        : undefined
      return flattenAndSign(
        (flat) => window.api.signPdfWithCard(flat, card, sign),
        'Card signing failed — check the module path, PIN and that the card is inserted',
        appearanceOf({ ...opts, signer }),
        includeRecognizedText
      )
    },
    [flattenAndSign, appearanceOf, signaturePlacement]
  )

  // Sign with a certificate from the Windows store (the key may be on a smart card; Windows prompts
  // for the PIN). No PKCS#11 module needed.
  const signWithWindowsCertAndExport = useCallback(
    (
      thumbprint: string,
      opts: {
        reason?: string
        name?: string
        tsaUrl?: string
        includeImage?: boolean
        ltv?: boolean
        /** The Sign dialog's "Include recognized text" box (D7, default off). */
        includeRecognizedText?: boolean
        signer?: { subject: string; issuer: string }
      }
    ): Promise<boolean> => {
      const { includeImage: _omit, signer: _sig, includeRecognizedText = false, ...sign } = opts
      return flattenAndSign(
        (flat) => window.api.signPdfWithWindowsCert(flat, thumbprint, sign),
        'Signing failed — the card may have been removed or the PIN cancelled',
        appearanceOf(opts),
        includeRecognizedText
      )
    },
    [flattenAndSign, appearanceOf]
  )

  // One flat PDF per document, zipped: same shell, different bytes.
  const exportZip = useCallback(
    () =>
      saveWith('untitled.zip', ZIP_FILTER, async (redacted, _filename, layer, docs) => {
        const entries: Record<string, Uint8Array> = {}
        const used = new Set<string>()
        for (const doc of docs) {
          const safeName = doc.name.replace(ILLEGAL_FILENAME_CHARS, '-').trim() || 'Untitled'
          let filename = `${safeName}.pdf`
          for (let n = 2; used.has(filename); n++) filename = `${safeName} (${n}).pdf`
          used.add(filename)
          entries[filename] = await buildPdf(
            applyRedactedBytes(doc.pages.map(toExportPage), redacted),
            layer
          )
        }
        return zipSync(entries)
      }),
    [saveWith]
  )

  return {
    exportCollection,
    exportZip,
    signAndExport,
    signWithCardAndExport,
    signWithWindowsCertAndExport
  }
}
