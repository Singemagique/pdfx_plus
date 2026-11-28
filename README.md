<div align="center">

# PDFx

**One file. Many documents. Still a PDF.**

<br>

<a href="https://pub-2f99e567a5f04aefb5e8cb75acb90ef7.r2.dev/PDFx.zip">
  <img src="https://img.shields.io/badge/Download-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download" height="44">
</a>

<br>
<br>

[![License: MIT](https://img.shields.io/badge/License-MIT-2e7d32?style=flat-square)](LICENSE)
&nbsp;
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-555?style=flat-square)](#)
&nbsp;
[![Format spec](https://img.shields.io/badge/format-spec-e08a00?style=flat-square)](SPEC.md)

<br>

<img src="assets/pdfx.png" alt="PDFx editor" width="820">

</div>

<br>

## What it is

PDFx is an open, backwards compatible extension of PDF that bundles many documents into a single file, plus a lightweight desktop editor for macOS, Windows, and Linux.

A `.pdfx` file is a fully valid PDF: open it anywhere and every page shows in sequence. Open it in PDFx and it splits back into the original documents. Plain single PDFs work as they are.

Drag and drop `.pdf` or `.pdfx` files anywhere in the window. Each document renders as a card of pages that wrap into rows to fit the window, and documents stack vertically; newly added documents are zoomed to fit and scrolled into view. Reorder or remove them, then **Export .pdfx** to save the whole collection as one file.

Beyond bundling, PDFx is a full editor: page transforms (rotate/crop), PNG stamps, annotations (text, ink, highlight, shapes), AcroForm form filling, **true** content redaction, and digital signatures — visual/ink plus cryptographic **PAdES** (baseline B-B through long-term **B-LT/B-LTA**) from a `.p12`/PFX file, a PKCS#11 smart card, or the Windows certificate store. Edits flatten into the PDF so any viewer sees them, and are mirrored in a backward-compatible manifest so a `.pdfx` reopens fully editable.

See [SPEC.md](SPEC.md) for the format. It is short: the entire trick is one embedded JSON manifest.

## Text recognition (OCR)

<!--
  FINAL CHECK before the 1.1.4 release: the menu, toolbar, dialog and language-picker wording below
  follows DESIGN §3.8 (the approved copy). PR8 (UI) and PR9 (language downloads) were built in
  parallel with this section; confirm every quoted label against the shipped UI, and drop the
  language-download sentences if PR9 ships as Install-from-file only.
-->

PDFx can recognize the text in scanned pages and photos, so you can find words in them with Find
(Ctrl/Cmd+F), copy their text, and export PDFs that other apps can search too.

- **Runs on this computer. Nothing is uploaded.** Recognition uses the Tesseract engine, compiled to
  WebAssembly and bundled with the app, in a separate background process whose network functions
  are disabled (CI also runs it with no network at all). Your pages never leave your machine.
- **Your pages are not changed.** The page images are never re-encoded; an invisible text layer is
  added when you export. **Include Recognized Text When Exporting** (Document menu, on by default)
  turns that off. When signing, **Include recognized text (machine-generated, not reviewed)** is
  unticked by default, because the signature would also cover that text.
- **Searchable, not "accessible".** The text layer makes a scanned PDF searchable and its text
  copyable. It does not add the structure (tags, reading order, alternative text) that accessible
  PDFs need, so PDFx never calls its output an accessible PDF.
- **What it is for.** Recognizes printed text. Handwriting, curved book pages and photos with heavy
  perspective may give poor results.
- **When it runs.** Photos and scans you import as images are recognized automatically. For scanned
  PDFs you choose: **Document ▸ Recognize Text…** (Ctrl/Cmd+Shift+R), the **Recognize Text**
  toolbar button, or the prompt in Find and on the page. Pages that already have searchable text,
  including text another OCR tool added, are skipped and say so.
- **Keeping it.** Recognition is kept while the file is open. Export or save as .pdfx to keep it.
- **Redaction.** Redacting removes the covered pixels and any recognized words under them. Where a
  scan image cannot be cut in place (an unusual image format or placement), the whole image and its
  recognized text are removed instead.
- **Languages.** English, German, French and Spanish are included. Other languages can be added from
  the language picker: PDFx downloads the language data from github.com only when you add one, and
  checks it against a hash list built into the app before using it. **Install from file…** adds a
  language without a download.
- **Licences.** The engine, the libraries linked into it and the language data have their own
  licences. Their texts ship with the app in `resources/licenses/` (Windows:
  `<install folder>\resources\licenses\`; macOS: `PDFx.app/Contents/Resources/licenses/`; Linux:
  `/opt/PDFx/resources/licenses/`), with
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) listing each component.

## How to run

Built with Electron, Vite, TypeScript, and React. PDF rendering by [pdf.js](https://mozilla.github.io/pdf.js/), assembly by [pdf-lib](https://pdf-lib.js.org/).

```bash
yarn              # install
yarn dev          # run in development
yarn build:mac    # package for macOS
yarn build:win    # package for Windows
yarn build:linux  # package for Linux (AppImage, deb, rpm)
yarn test:run     # all tests
yarn test:ocr     # the OCR tests that run the real engine (see CONTRIBUTING.md)
```

## License

MIT
