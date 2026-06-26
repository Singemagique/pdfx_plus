# PDFx Product Requirements Document (PRD)

## 1. Overview

PDFx (`pdfx_plus`) is a lightweight, fast Electron desktop application for working with multi-document PDF collections. Its native format — a `.pdfx` file — is a fully-valid PDF whose pages are every member document concatenated in order, plus one embedded PDF file-attachment named exactly `pdfx-manifest.json` describing the document boundaries (each document: `name` + `pages`). Any PDF viewer shows all pages; a PDFX-aware app re-splits them, and a plain PDF is a valid single-document PDFX file.

This PRD specifies the evolution of PDFx from a **structural-only** editor (reorder / insert / delete / rename / copy-paste / drag-drop of pages and documents, with export to `.pdfx` / `.pdf` / `.zip`) into a **lightweight but full PDF editor** — adding page transforms, PNG stamping, annotations, true content redaction, AcroForm filling, visual and cryptographic (PAdES) signatures, and an undo/redo foundation — while remaining at all times a valid PDF that any viewer can open. Edits are persisted with a hybrid strategy: flattened into the PDF content so every viewer sees them, and mirrored in an additive, backward-compatible **PDFX v1.1** manifest extension for round-trip re-editing. The app stays MIT-licensed and minimal; new capabilities are added as orthogonal layers that do not disturb the existing structural model.

This document is grounded in the real codebase at `I:/Claude/pdfx_plus`. Key existing modules: `src/main/{index,file-intake,markup,clipboard,menu,register-ipc,window}.ts`; `src/main/native/glass.ts`; `src/preload/index.ts`; `src/renderer/src/pdfx/{build,format,images,markup,...}.ts`; `src/renderer/src/app/doc-ops/{docs,move,pages}.ts` and hooks; `src/renderer/src/components/Toolbar.tsx`. External factual claims about third-party libraries below are cited; anything unverified is flagged explicitly.

---

## 2. Goals / Non-goals

### Goals

- Keep PDFx a **valid PDF at every step** — backward compatible with v1.0 PDFX readers and with plain PDF viewers.
- Deliver a **lightweight full editor**: page transforms, PNG overlay/stamp, annotations (text, ink, highlight), AcroForm form filling, **true** redaction (genuine content removal), and signatures (visual + cryptographic PAdES).
- Provide **undo/redo** as a foundational capability spanning structural and content edits.
- Persist edits **hybrid**: flatten into content AND mirror in an editable manifest (PDFX v1.1) for re-editing.
- Achieve **cross-platform parity** across macOS, Windows, and Linux, with CI and the repo's first automated tests.
- Keep the whole app **MIT-licensed** — no GPL/AGPL copyleft in shipped artifacts.

### Non-goals

- Not a full Acrobat/InDesign replacement; no reflow/typesetting, no rich WYSIWYG content authoring beyond the listed annotation/overlay types.
- No collaborative/real-time multi-user editing, no cloud sync, no telemetry.
- Not bundling any AGPL engine (MuPDF, Ghostscript, cpdf) into the shipped app.
- PAdES B-LT/LTV (long-term validation), OCR, full-text search, watermarking, Bates numbering, and encryption are explicitly **deferred** to an optional later phase (see roadmap), not part of the core editor scope.

---

## 3. Product Decisions (D1–D6)

- **D1 — Lightweight full editor.** Evolve PDFx into a minimal/fast full editor, not just a viewer. Keep it minimal and fast.
- **D2 — Editing scope.** Page transforms (rotate, crop, split, merge, insert-blank, duplicate), annotations (text boxes, freehand ink, highlight), **true redaction** (genuine content removal — not a black rectangle over still-present text), and AcroForm form filling. Plus undo/redo as a foundation.
- **D3 — PNG handling.** Overlay/stamp a PNG anywhere ON an existing page with transparency, in addition to the existing image→whole-page import.
- **D4 — Signatures.** Both visual/ink signatures AND cryptographic digital signatures (PAdES), supporting many credential sources: smart cards / hardware tokens (PKCS#11), OS certificate stores (Windows CNG/CryptoAPI, macOS Keychain), and `.p12`/PFX files.
- **D5 — Persistence (hybrid).** Flatten edits into the PDF content so any viewer sees them, AND store an editable mirror of the edits in an extended manifest (PDFX v1.1) for round-trip re-editing — additive and backward-compatible with v1.0 readers.
- **D6 — Engineering process.** GitHub PRs with **squash-merge only**, CI across macOS + Windows + Linux, and applicable automated tests (the repo's first). Repo: `Singemagique/pdfx_plus` (fork), default branch `main`.

---

## 4. Architecture

The design keeps the existing structural model untouched and adds an **orthogonal edit layer**. PDFx today is an immutable React state tree (`useCollection` → `DocEntry[]` → `PageEntry[]`) assembled and exported through pdf-lib (`src/renderer/src/pdfx/build.ts`), with the v1.0 manifest carried as an embedded PDF file-attachment named `pdfx-manifest.json`. Content editing is added without breaking that.

### 4.1 Typed edit / overlay model

A separate, serializable edit model (new `src/renderer/src/edit/model.ts`): a flat array of typed overlay objects keyed by **durable page identity**, each with page-relative geometry (PDF user-space points, origin bottom-left to match pdf-lib) plus per-type data.

**Page identity (critical detail).** Overlays must NOT key on the ephemeral `PageEntry.id` — verified in `src/renderer/src/pdfx/source.ts` (lines 31/47/59) and `useClipboard.ts` (line 29), `PageEntry.id` is a fresh `crypto.randomUUID()` regenerated per import and reassigned on paste. The export path in `src/renderer/src/pdfx/build.ts` (lines 6–37) keys pages on `ExportPage.sourceKey` + `pageIndex`. Therefore overlays bind to the value that becomes `ExportPage.sourceKey` plus `pageIndex`. Because copy/duplicate of a page sharing the same source+index would otherwise share edits, the model adds an explicit **per-logical-page id with copy-on-duplicate remap** so duplicated pages get independent edits.

Discriminated union (illustrative):

```ts
interface BaseOverlay {
  id: string
  pageKey: string
  geom: Geom
  z: number
  createdAt: number
}
interface Geom {
  x: number
  y: number
  w: number
  h: number
  rotation: number
  opacity: number
} // PDF points, origin bottom-left
type Overlay =
  | (BaseOverlay & { type: 'image'; attachmentId: string; mime: 'image/png' | 'image/jpeg' }) // PNG stamp incl. alpha (D3)
  | (BaseOverlay & {
      type: 'ink'
      paths: number[][]
      strokeWidth: number
      color: RGB
      signature?: boolean
    })
  | (BaseOverlay & {
      type: 'text'
      text: string
      fontSize: number
      color: RGB
      font: 'Helvetica' | 'Times' | 'Courier'
      align: 'left' | 'center' | 'right'
    })
  | (BaseOverlay & { type: 'highlight'; color: RGB })
  | (BaseOverlay & { type: 'redaction'; fill: RGB }) // marks region for TRUE removal
  | (BaseOverlay & { type: 'form-value'; field: string; value: string | boolean })
  | (BaseOverlay & {
      type: 'signature-visual'
      attachmentId?: string
      paths?: number[][]
      label?: string
    })
interface RGB {
  r: number
  g: number
  b: number
}
```

Large binary payloads (stamped PNGs, signature images) are **not inlined** in JSON; they live in an attachments registry referenced by `attachmentId` and are embedded as PDF file streams on export. Small overlays (ink/text/highlight/form-value) serialize inline.

### 4.2 Undo/redo

`src/renderer/src/edit/history.ts`: wrap the edit-store reducer with **Immer** `produceWithPatches`. Immer is MIT (latest ~11.1.8) ([npm](https://www.npmjs.com/package/immer)); `enablePatches()` must be called once at startup or patches silently no-op, `produceWithPatches` returns `[nextState, patches, inversePatches]`, and `applyPatches` replays forward (redo) or inverse (undo) — documented stable APIs ([Immer patches docs](https://immerjs.github.io/immer/patches/)). Each mutating action pushes `{patches, inversePatches}` onto a bounded `past[]` stack (cap ~100) and clears `future[]`. This is ~40 LOC, stores diffs not snapshots, and matches the existing immutable spread-reducer style of `doc-ops/*`. Structural ops (reorder/delete page/doc) can be routed through the same patch stream for **unified undo** across structural + content edits. Continuous gestures (drag, freehand ink) must coalesce into a single history entry. Immer is the only new runtime dependency for undo/redo.

### 4.3 Live overlay rendering + hit-testing

Editing happens in the existing single-page full view (`FullView` → `FullViewPages` → `FullViewPage`), which already centers/scales one page and exposes a view transform (`geometry.ts`). Add an `OverlayLayer` absolutely positioned over the pdf.js `<canvas>`, sized to the rendered page rect. A single helper converts PDF points ↔ CSS px using the page fit scale and natural height (flipping Y, since PDF origin is bottom-left). Vector overlays (ink/text/highlight/redaction outlines/selection handles) render in one `<svg>`; image/signature stamps render as `<img>`/`<canvas>`. A small reducer-driven tool state (`select|text|ink|highlight|redact|stamp|sign`) drives pointer interaction; drag/resize update the selected overlay's `Geom` through the same Immer action so every gesture is undoable. Hit-testing is point-in-rect against transformed geoms, z-ordered top-first. Thumbnails and the collection canvas stay overlay-free for speed; only the focused full-view page renders the live edit layer.

### 4.4 Flatten-on-export pipeline

Extend `src/renderer/src/pdfx/build.ts`; add `src/renderer/src/pdfx/flatten.ts`. After pdf-lib copies a page into the output, look up overlays for that page key and bake them in z-order. pdf-lib (MIT, 1.17.1 already in repo) provides the needed draw operations — confirmed against the API ([PDFPage](https://pdf-lib.js.org/docs/api/classes/pdfpage), [npm](https://www.npmjs.com/package/pdf-lib)):

- **image / signature-visual** → `embedPng`/`embedJpg` then `page.drawImage(img, { x, y, width, height, opacity, rotate })`. `embedPng` preserves PNG alpha.
- **ink** → `page.drawSvgPath(pathFromPoints(paths), { borderColor, borderWidth, borderOpacity })` (preferred for smooth strokes) or `drawLine` segments.
- **text** → `page.drawText(text, { x, y, size, font, color, opacity })` with `embedFont(StandardFonts.*)`.
- **highlight** → `page.drawRectangle({ x, y, width, height, color, opacity })`. pdf-lib has **no true multiply/blend mode**, so highlight is an opacity approximation (~0.4 yellow); it may slightly darken overlapping text. Acceptable for a lightweight editor; flagged for design review.
- **form-value** → `getForm().getTextField/getCheckBox(...).setText/check(...)`, then `form.flatten()` once at the end. `PDFForm.flatten()` bakes each widget's appearance into the page content stream and removes the form fields/annotations so all viewers show the values — confirmed ([PDFForm.flatten](https://pdf-lib.js.org/docs/api/classes/pdfform)).
- **redaction** → handed off to the external engine (see §4.5).

> **Maturity note:** pdf-lib 1.17.1 is the current AND final release (last published ~5 years ago) and is effectively unmaintained. It is already a repo dependency, so this is not a blocker, but if new bake features hit bugs, evaluate a maintained fork (e.g. `@cantoo/pdf-lib`).

### 4.5 True-redaction hand-off

pdf-lib **cannot** rewrite content streams to delete glyphs/image data — its page API is draw-only (verified: no content-stream rewrite/removal API in `src/`; pdf-lib maintainer documents page-content text removal as not implemented). A rectangle drawn over text leaves the original glyphs selectable/extractable. Therefore redaction runs as a **pre-pass** by the external engine (§5.6). Per-page order:

1. External engine removes content under each redaction rect → redacted page bytes.
2. pdf-lib loads the redacted bytes and copies the page.
3. pdf-lib bakes remaining overlays (image/ink/text/highlight) on top.
4. `form.flatten()`.

The redacted bytes **replace** that page's source bytes before pdf-lib re-assembly, keeping pdf-lib as the final assembler while delegating only genuine content removal to the engine.

### 4.6 PDFX v1.1 manifest extension (additive, backward-compatible)

Keep `MANIFEST_NAME = 'pdfx-manifest.json'` and the same embedded-attachment mechanism. Bump the version field to `1.1` but keep `documents[]` **exactly** as v1.0 (`name` + `pages`). Verified in `src/renderer/src/pdfx/format.ts`: `readManifest()` (lines ~53–60) `JSON.parse`s the whole object and validates **only** `Array.isArray(documents)` and each `documents[].name` (string) + `pages` (positive integer), ignoring all other keys; `partitionPages()` reads only `documents[]`. So additive top-level keys are genuinely ignored by v1.0 readers, and plain PDF viewers always see the flattened content.

Add optional top-level keys: `edits` (serialized overlays grouped by document index + page), `attachments` (overlay images stored as embedded PDF file streams, referenced by name), and `integrity` (a hash for tamper detection).

**Concrete example:**

```json
{
  "pdfx": "1.1",
  "title": "Contract",
  "documents": [
    { "name": "NDA", "pages": 2 },
    { "name": "Invoice", "pages": 1 }
  ],
  "integrity": { "flattenedSha256": "9f2c…e1" },
  "attachments": {
    "stamp-7af3": { "embeddedName": "pdfx-edit-stamp-7af3.png", "mime": "image/png" }
  },
  "edits": [
    {
      "doc": 0,
      "page": 0,
      "overlays": [
        {
          "id": "o1",
          "type": "highlight",
          "geom": { "x": 72, "y": 680, "w": 180, "h": 14, "rotation": 0, "opacity": 0.4 },
          "z": 0,
          "color": { "r": 1, "g": 0.9, "b": 0.2 }
        },
        {
          "id": "o2",
          "type": "text",
          "geom": { "x": 72, "y": 120, "w": 300, "h": 20, "rotation": 0, "opacity": 1 },
          "z": 1,
          "text": "DRAFT",
          "fontSize": 14,
          "color": { "r": 0.8, "g": 0, "b": 0 },
          "font": "Helvetica",
          "align": "left"
        },
        {
          "id": "o3",
          "type": "redaction",
          "geom": { "x": 90, "y": 400, "w": 220, "h": 16, "rotation": 0, "opacity": 1 },
          "z": 2,
          "fill": { "r": 0, "g": 0, "b": 0 }
        },
        {
          "id": "o4",
          "type": "image",
          "geom": { "x": 400, "y": 60, "w": 120, "h": 48, "rotation": 0, "opacity": 1 },
          "z": 3,
          "attachmentId": "stamp-7af3",
          "mime": "image/png"
        }
      ]
    },
    {
      "doc": 1,
      "page": 0,
      "overlays": [
        {
          "id": "o5",
          "type": "form-value",
          "geom": { "x": 0, "y": 0, "w": 0, "h": 0, "rotation": 0, "opacity": 1 },
          "z": 0,
          "field": "total",
          "value": "$4,200"
        },
        {
          "id": "o6",
          "type": "signature-visual",
          "geom": { "x": 380, "y": 80, "w": 160, "h": 50, "rotation": 0, "opacity": 1 },
          "z": 1,
          "paths": [[380, 90, 420, 110, 460, 85]],
          "label": "A. Jara"
        }
      ]
    }
  ]
}
```

**Source-of-truth / tamper-hash rule.** On open, a PDFX-aware reader recomputes the flattened-layer hash and compares it to `integrity.flattenedSha256`:

- **Match** → trust the editable mirror (`edits`/`attachments`), reconstruct editable overlays for round-trip re-editing, re-flatten on next export.
- **Mismatch** (the flattened PDF was altered by another tool) → treat the **flattened content as authoritative**, surface an "edited externally" warning, and discard/quarantine the now-stale mirror so outdated edits are never silently re-baked.

> **Honest caveat:** pdf-lib re-save is **not byte-deterministic**, so the hash must cover **normalized flattened page content**, not raw file bytes — and a robust canonicalization (object ordering, xref, IDs) does not yet exist in this proposal. For v1, the tamper hash should be treated as **advisory** (drive the warning, not a hard gate) until a defined canonicalization is implemented and tested. The structural anchor that is reliable regardless of compression is the **presence of the embedded file named `pdfx-manifest.json`** plus the embedded overlay attachments by name.

**Backward-compat summary.** v1.0 readers parse `documents[]` and ignore `edits`/`attachments`/`integrity`; plain viewers see fully flattened content (including baked overlays, flattened form values, and visual signature); a plain PDF remains a valid single-document PDFX.

### 4.7 Pipeline ordering (signing is last)

A cryptographic signature byte-locks the file, so the full pipeline order is:

```
external redaction pre-pass
  → pdf-lib assemble + bake overlays + form.flatten()
  → embed v1.1 manifest attachment + integrity hash
  → THEN cryptographic PAdES sign (main process)
```

Signing must cover the final bytes (flattened content + embedded manifest mirror). See §5.9 and §6.

---

## 5. Feature Requirements

### 5.1 Cross-platform parity

**Requirements**

- Add a `linux:` block to `electron-builder.yml` producing **AppImage + deb + rpm** (none exists today), with `category` (Office/Utility), `maintainer`, `synopsis`, and `icon: build/icon.png`.
- Generate `build/icon.ico` (multi-size 16–256) so the existing NSIS/Windows config has its required icon (none exists today).
- Choose **one** MIME string and use it consistently across `mimeTypes`, the desktop `MimeType`, and `fileAssociations.mimeType` (the research used both `application/pdfx` and `application/x-pdfx` inconsistently — pick one; it is a custom, non-IANA type).
- Audit the macOS-only native glass addon to confirm clean no-op on Windows/Linux: `scripts/build-native.mjs` exits 0 when `process.platform !== 'darwin'`, `electron-builder.yml` sets `npmRebuild:false`, and `src/main/native/glass.ts` no-ops off-mac.
- Linux packaging on the runner: `apt-get install rpm` (rpmbuild is required by electron-builder's bundled fpm and is not preinstalled — confirmed) and handle AppImage FUSE: either install `libfuse2t64` (Ubuntu 24.04 renamed `libfuse2` → `libfuse2t64`, confirmed) **or** adopt electron-builder 26.x's static AppImage runtime, which is **opt-in** via `toolsets: { appimage: "1.0.3" }` (a version bump alone does NOT remove the FUSE dependency — corrected from research; only default in v27).

**Acceptance criteria**

- CI produces installable AppImage, `.deb`, and `.rpm` on Linux; `.exe`/NSIS on Windows; `.dmg`/zip on macOS — all from their respective matrix OS.
- Windows build no longer warns about a missing icon; `.ico` is present.
- Double-clicking a `.pdfx` opens PDFx on all three OSes via registered file association.
- A non-mac build completes with the glass addon skipped and no native-rebuild error.

### 5.2 Page transforms (D2)

**Requirements**

- Rotate (90° steps), crop (per-page rect), split (one document into two at a boundary), merge (combine adjacent documents), insert-blank (new empty page of a chosen size), duplicate (page copy-on-duplicate with edit remap per §4.1).
- All transforms route through the unified Immer history (§4.2) for undo/redo.

**Acceptance criteria**

- Each transform is undoable/redoable as a single history entry.
- Rotate/crop persist into flattened export and round-trip via the v1.1 mirror.
- Duplicate produces an independent logical page; editing the duplicate does not affect the original.

### 5.3 PNG overlay / stamp (D3)

**Requirements**

- Place a PNG anywhere on an existing page with transparency, movable/resizable/rotatable, in addition to the existing image→whole-page import.
- Baked via `embedPng` + `drawImage` (alpha preserved); the PNG bytes are stored in the v1.1 `attachments` registry (embedded file stream), referenced by `attachmentId`.

**Acceptance criteria**

- A stamped PNG with alpha exports with correct transparency in any PDF viewer.
- The stamp round-trips (re-editable position/size/rotation) when reopened in PDFx.

### 5.4 Annotations (D2)

**Requirements**

- Text boxes (standard fonts), freehand ink (smooth strokes), highlight.
- Live rendering in the overlay layer; baked on export (text → `drawText`, ink → `drawSvgPath`, highlight → opacity rectangle).

**Acceptance criteria**

- Annotations appear identically (within the opacity-highlight limitation, §4.4) in PDFx and external viewers after export.
- Each annotation is independently editable/undoable and round-trips via the mirror.

### 5.5 Form filling (D2)

**Requirements**

- Detect AcroForm fields; fill text fields and toggle checkboxes; `form.flatten()` on export so values become page content visible in all viewers.

**Acceptance criteria**

- Filled values are visible in plain viewers after export (post-flatten).
- Field values round-trip as `form-value` overlays in the v1.1 mirror for re-editing.

### 5.6 True redaction (D2)

**Chosen engine: PDFium via EmbedPDF** — `@embedpdf/pdfium` (PDFium-wasm, **MIT**, v2.14.4, ~7.5 MB unpacked) plus `@embedpdf/plugin-redaction` (**MIT**, v2.14.4). PDFium itself is **BSD-3-Clause** (dual-noticed Apache-2.0) — permissive and MIT-app-safe ([PDFium LICENSE](https://pdfium.googlesource.com/pdfium/+/main/LICENSE); [@embedpdf/pdfium](https://registry.npmjs.org/@embedpdf/pdfium/latest); [plugin docs](https://www.embedpdf.com/docs/react/headless/plugins/plugin-redaction)).

**Why this engine and not the alternatives:**

- **MuPDF / `mupdf.js`** is the technically ideal redaction engine but is **AGPL-3.0-or-later** ([npm](https://registry.npmjs.org/mupdf/latest)) — it would force AGPL on the whole app absent a paid Artifex license. **Disqualified** on the decisive MIT constraint.
- **cpdf** (`-blacktext`) is AGPL **and** only cosmetic; **Ghostscript** is AGPL. Both rejected.
- **qpdf** is Apache-2.0 but does **not** do rendering/extraction/content redaction ([qpdf license](https://qpdf.readthedocs.io/en/stable/license.html)) — useful only as a structural pre/post step.
- **pdf-lib** cannot do true redaction (draw-only API).

**Mechanism.** EmbedPDF's redaction plugin performs a "mark then commit" workflow that, per its docs, is "a destructive process that alters the underlying PDF content, making it unrecoverable" and "irreversible"; the black box (`drawBlackBoxes`, default true) is an **optional cosmetic overlay** applied after the destructive removal — exactly the D2 semantics ([plugin docs](https://www.embedpdf.com/docs/react/headless/plugins/plugin-redaction)).

**Honest tradeoffs / hard gates.**

- The plugin's "unrecoverable" guarantee is a **documentation claim, not a byte-level audit**; the docs are silent on **vector graphics** and **partially-overlapping glyphs**. PDFx **MUST** add an automated **post-commit verification test** that re-extracts text/objects under the redaction rect **from the saved bytes** (not in-memory state) — one of the repo's first tests (aligns with D6).
- PDFium's `FPDFPage_RemoveObject` changes have been reported lost on save when `FPDFPage_GenerateContent` only re-serializes objects it manages ([pdfium-bugs 1051](https://groups.google.com/g/pdfium-bugs/c/RBwhmdbejRk); thread visibly ends 2018, current status unconfirmed) — this is precisely why a higher-level plugin that owns the stream rewriting is preferred over hand-rolled `RemoveObject`+`GenerateContent`.
- **Guaranteed-safe fallback:** for partial-overlap or vector cases that fail verification, **rasterize only the redacted page** at high DPI and drop its text layer, then reassemble. This sacrifices that single page's selectable text/searchability/accessibility — an acceptable, defensible, security-scoped tradeoff that **must be surfaced to the user** and limited to pages where clean object removal cannot be verified.

**Acceptance criteria**

- After redaction + export, text/objects under the rect are **not recoverable** by copy/paste or extraction from the saved bytes (verified by the automated post-commit test).
- The verification test fails the build if any glyph survives under a redaction rect.
- When the rasterize fallback is used, the user is warned that the affected page loses selectable text.

### 5.7 Visual / ink signatures (D4)

**Requirements**

- Draw an ink signature or place a signature image (`signature-visual` overlay); baked on export like other overlays; round-trips via the mirror.
- A visual signature may be the appearance tied to a cryptographic signature (baked during flatten so it is part of the signed content).

**Acceptance criteria**

- A drawn/placed signature exports as page content visible in any viewer.
- When attached to a crypto signature, the visual appearance is within the signed byte range.

### 5.8 Cryptographic PAdES signatures (D4)

**Architecture.** One signing pipeline in the **Electron main process** (Node-only) with a `CredentialSource` abstraction feeding a single `@signpdf` flow. Place the signature field + `/Sig` dictionary with a placeholder `/Contents` and `/ByteRange` (via `@signpdf/placeholder-pdf-lib`, SubFilter `ETSI.CAdES.detached` for PAdES — the constant lives in `@signpdf/utils`), hash the ByteRange, call a pluggable `Signer` returning detached CMS, splice it in. All libraries verified MIT at v3.3.0 ([@signpdf/signpdf](https://registry.npmjs.org/@signpdf/signpdf/latest), [signer-p12](https://registry.npmjs.org/@signpdf/signer-p12/latest), [placeholder-pdf-lib](https://registry.npmjs.org/@signpdf/placeholder-pdf-lib/latest)). Only the final private-key RSA/ECDSA operation needs the credential — the clean delegation seam for any source ([node-signpdf README](https://github.com/vbuch/node-signpdf/blob/develop/README.md)).

**Credential sources (main-process abstraction).**

- **(a) `.p12`/PFX** — `@signpdf/signer-p12` (wraps node-forge). **Ship first (v1).** Note: signer-p12 declares `node-forge ^1.3.3`, which permits the vulnerable 1.3.x line; add an explicit top-level pin/override to **`node-forge >= 1.4.0`** — v1.4.0 fixed RSA-PKCS signature **forgery** via ASN.1 manipulation, Ed25519 malleability, and a cert-chain (basicConstraints) weakness (the load-bearing reason; CVE-2025-12816 alone was fixed earlier in 1.3.2) ([forge CHANGELOG](https://github.com/digitalbazaar/forge/blob/main/CHANGELOG.md)). node-forge is `(BSD-3-Clause OR GPL-2.0)`; elect BSD-3-Clause in compliance docs.
- **(b) PKCS#11 smart card / token / HSM** — custom `Signer` using `node-webcrypto-p11` (MIT v2.8.0, over `graphene-pk11` MIT v2.3.6 / `pkcs11js` MIT v2.1.6), with CMS assembled by `@peculiar/x509` + PKI.js, pointed at OpenSC or a vendor PKCS#11 module. The private key never leaves the device. **Gated behind a v2/experimental flag** — `node-webcrypto-p11`'s own README states it "should be considered suitable for research and experimentation, further code and security review is needed before utilization in a production application" ([README](https://github.com/PeculiarVentures/node-webcrypto-p11)). Native addons require an Electron-38/Node-24 NAPI rebuild matrix.
- **(c) OS certificate stores** — Windows CNG (`NCryptSignHash`) / macOS Keychain (`security cms` / `SecKeyCreateSignature`). **No mature cross-platform npm library exists** — requires per-OS native/CLI glue and a CI build matrix. Highest-effort source; **v2**.

**PAdES levels.** Ship **B-B** and **B-T** (RFC3161 TSA timestamp via configurable TSA URL, assembled as a CMS unsigned attribute through PKI.js/TSP — not turnkey in `@signpdf`, verify integration) in v1's crypto milestone. Defer **B-LT/LTV** (DSS dictionary + OCSP/CRL) to a later phase (PKI.js OCSP/TSP, unproven in this stack).

**Acceptance criteria**

- A `.p12`-signed `.pdfx` validates as a PAdES signature (SubFilter `ETSI.CAdES.detached`) in a standard validator (e.g. Adobe).
- Signing runs entirely in main; the renderer only selects a source, supplies a PIN/password over IPC (new `window.api.signPdf` channel via `register-ipc.ts`/preload), and shows status.
- `node-forge` resolves to `>= 1.4.0` in the lockfile.
- The signature ByteRange covers the flattened content + embedded v1.1 manifest.

---

## 6. Signed-immutability product RULE (resolving D3 interaction with signing)

**Rule.** Cryptographic signing is the **terminal export step** on a fully-assembled `.pdfx`. A signed `.pdfx` is treated as **finalized / immutable** in the editor: it opens **read-only / verify-only**. Any attempt to re-edit a signed file produces a **new, unsigned derivative** (signatures dropped, mirror unfrozen, re-flatten on next export) rather than silently invalidating the existing signature.

**Rationale.** A signature byte-locks the file; the `.pdfx` must be fully assembled — manifest attachment + flattened edits + v1.1 editable mirror all in place — **before** signing. Any subsequent structural edit or manifest rewrite that is **not** an incremental update invalidates the signature and breaks the byte-locked manifest+mirror. Signing-last conflicts with later re-editing by definition; forking a new unsigned document is the correct PAdES semantics and the only honest UX.

**Multi-signer incremental-update nuance.** Additional **approval** signatures are allowed **only as appended incremental updates**: a second signature's ByteRange covers only the earlier bytes, so prior signatures remain cryptographically intact ([incremental update](https://developer.mescius.com/document-solutions/dot-net-pdf-api/docs/online/Features/IncrementalUpdate)). This enables multi-party signing without re-saving. **Critical caveat:** this is a **validator-dependent** security property — append-only updates keep earlier signatures verifiable, but known PDF attacks (incremental-update abuse / "Shadow Attacks") can fool naive validators ([PDFA advisory](https://pdfa.org/recently-identified-pdf-digital-signature-vulnerabilities/)). PDFx's own verification UI must **diff and surface any post-signature incremental changes**, never report "hash matches = valid" alone.

---

## 7. Security considerations

- **Redaction true-removal (highest-sensitivity).** Treat "the content is gone" as a **tested gate**, not a trust claim: an automated post-commit test re-extracts text/objects under each redaction rect from the **saved bytes**. Where verification cannot confirm removal (partial glyphs, vector art), fall back to rasterizing only that page and warn the user. Never ship a redaction path that has only been validated against in-memory page state.
- **Certificate / private-key handling.** All crypto and native modules run in the **main process** only; the renderer never touches keys. For `.p12`, the password arrives over IPC and is used transiently; for PKCS#11, the private key never leaves the device. Pin `node-forge >= 1.4.0` (signature-forgery and cert-chain fixes).
- **Smart-card PIN handling.** PINs are entered in the renderer, passed to main over IPC, and forwarded to the PKCS#11 module without persistence; never log PINs; clear from memory promptly. Treat `node-webcrypto-p11` as experimental and security-review it against target tokens before production.
- **Decompression-bomb guards (already present).** The existing image intake caps (`isImageBytes` / pngSize-driven limits in `src/renderer/src/pdfx/images.ts`) are an established guard; extend the same defensive posture to any new wasm/native engine inputs (cap page/object sizes fed to PDFium).
- **Hardened render session as a model.** The existing offscreen hardened `BrowserWindow` → `printToPDF` markup pipeline (`src/main/markup.ts`) is the model for any future untrusted-content rendering: isolated session, no network, no node integration.
- **Signature verification UI.** Per §6, diff post-signature incremental updates and surface them; do not equate hash-match with validity.

---

## 8. Risks & mitigations

| #   | Risk                                                                       | Likelihood | Impact             | Mitigation                                                                                       |
| --- | -------------------------------------------------------------------------- | ---------- | ------------------ | ------------------------------------------------------------------------------------------------ |
| R1  | Redaction leaves recoverable content under partial-glyph/vector cases      | Medium     | Critical           | Automated post-commit byte-level verification test; rasterize-page fallback with user warning    |
| R2  | PDFium `RemoveObject`/`GenerateContent` removal lost on save (bug 1051)    | Low–Med    | High               | Prefer EmbedPDF plugin (owns stream rewrite) over hand-rolled removal; verify saved bytes        |
| R3  | Accidentally bundling an AGPL engine (MuPDF/Ghostscript/cpdf)              | Low        | Critical (license) | Hard rule: only MIT/BSD/Apache deps in shipped artifacts; license-check in CI                    |
| R4  | `node-forge` resolves to vulnerable 1.3.x via signer-p12 peer range        | Medium     | High               | Explicit top-level pin/override `node-forge >= 1.4.0`; lockfile assertion                        |
| R5  | PKCS#11/OS-store native addons fail Electron-38/Node-24 NAPI rebuild in CI | Medium     | Med                | Spike early; gate hardware-token/OS-store signers as v2/experimental                             |
| R6  | Tamper hash unreliable (pdf-lib save not byte-deterministic)               | High       | Med                | Advisory-only for v1; anchor on embedded-name presence; define canonicalization before hard gate |
| R7  | Editing a signed file silently invalidates signature                       | Medium     | High               | Immutability rule (§6): signed file is read-only; re-edit forks a new unsigned derivative        |
| R8  | electron-builder v26 AppImage bump assumed to drop FUSE but doesn't        | Medium     | Low                | Keep `libfuse2t64` install OR add `toolsets:{appimage:"1.0.3"}` explicitly                       |
| R9  | Highlight opacity approximation darkens overlapping text                   | High       | Low                | Accept for lightweight editor; design review on default opacity                                  |
| R10 | Duplicated pages share edits via shared source+index key                   | Medium     | Med                | Per-logical-page id with copy-on-duplicate remap (§4.1)                                          |
| R11 | Immer patches over full tree slow on large collections / continuous ink    | Low–Med    | Med                | Coalesce drag/ink gestures into single history entries; bounded stack                            |
| R12 | Branch-protection check name drifts, silently disabling the gate           | Low        | Med                | Gate on job id `check`, confirm recorded name after first run                                    |
| R13 | `--publish never` may not pass cleanly through electron-vite build scripts | Low        | Low                | Fall back to `electron-vite build` then `electron-builder --<os> --publish never`                |
| R14 | macOS runner is arm64; universal lipo slice may fail if x64 SDK dropped    | Low        | Med                | Assert universal slice builds in CI; script already falls back to host arch                      |

---

## 9. Phased roadmap

**Phase 0 — Cross-platform + CI + first tests (foundation).**

- `electron-builder.yml` `linux:` block (AppImage+deb+rpm), `build/icon.ico`, consistent custom MIME, native-glass no-op audit.
- `.github/workflows/ci.yml`: `check` job (Ubuntu — install, `yarn typecheck`, `prettier --check`, `yarn test`) + `build` matrix (macOS/Windows/Ubuntu, `fail-fast:false`), Linux `apt-get install rpm libfuse2t64`, `CSC_IDENTITY_AUTO_DISCOVERY:false`, Electron cache, artifact upload.
- First tests: Vitest 4.1.9 (MIT), `@vitest/coverage-v8` 4.1.9, jsdom 29.1.1 (MIT), single `vitest.config.mts` with `test.projects` (node + jsdom). Seed tests: `buildPdfx` round-trip (assert page count, embedded `pdfx-manifest.json` presence via EmbeddedFiles name tree — robust to Flate compression, manifest boundary round-trip), `names.ts`/doc-ops reducers, `file-intake.ts` predicates. Defer `readManifest` (needs pdfjs proxy) and canvas paths to phase-2.
- Repo config: squash-merge only, delete-branch-on-merge, branch protection gating on CI.

**Phase 1 — Edit backbone.** Typed edit model + durable page key + copy-on-duplicate remap; Immer undo/redo (unified with structural ops); live overlay layer + hit-testing; flatten-on-export for image/ink/text; PNG overlay/stamp (D3); visual/ink signatures (D4 visual half); page transforms.

**Phase 2 — Annotations + form fill.** Highlight + text-box polish; AcroForm detection + fill + `form.flatten()`; v1.1 manifest mirror read/write with advisory integrity hash; round-trip re-editing.

**Phase 3 — True redaction + crypto signing + verification UI.** Integrate `@embedpdf/pdfium` + redaction plugin with mandatory post-commit verification test + rasterize fallback; `@signpdf` `.p12` PAdES B-B/B-T pipeline in main; signed-immutability rule + verification UI (diff incremental updates). PKCS#11 and OS-store signers as experimental sub-tracks.

**Phase 4 (optional).** OCR / full-text search, watermark, Bates numbering, encryption; PAdES B-LT/LTV; maintained-pdf-lib-fork evaluation.

---

## 10. Engineering process

- **PRs with squash-merge only.** Configure via REST: `allow_squash_merge=true`, `allow_merge_commit=false`, `allow_rebase_merge=false`, `delete_branch_on_merge=true`, with `squash_merge_commit_title=PR_TITLE` / `squash_merge_commit_message=PR_BODY` (enums confirmed, [GitHub REST](https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28#update-a-repository)). Booleans via `gh api -F`, strings via `-f`. Branch protection PUT on `main` requires repo admin; gate on the job **id** `check` (not display name) to avoid silent drift.
- **CI matrix.** Two-tier `ci.yml`: fast Ubuntu `check` (lint/typecheck/test) + `build` matrix across macOS/Windows/Ubuntu (`needs: check`, `fail-fast:false`). Yarn Classic v1 confirmed (`yarn.lock` `lockfile v1`, no `packageManager`), so `actions/setup-node@v4` `cache: yarn` + `yarn install --frozen-lockfile` works **without** corepack. Node 24.
- **Test strategy.** Vitest two-project (node + jsdom) per §9 Phase 0. Pure, headless-testable logic first: `build.ts`/`buildPdfx`, `format.ts` (`partitionPages`/`stripExtension`), `names.ts`, doc-ops reducers, `file-intake.ts` predicates — all verified importable in plain node (no module-scope Electron/DOM imports; `format.ts`'s `PDFDocumentProxy` is a type-only import erased at runtime). **The redaction post-commit verification test is a mandatory release gate.** Optional Playwright `_electron` smoke launch is phase-2+ (re-verify its Apache-2.0 license before adding; dev-only, not bundled). Pin Node `>= 20` in CI (`crypto.randomUUID` dependency).

---

## 11. Open questions

1. **Custom MIME string** — finalize `application/pdfx` vs `application/x-pdfx` and apply consistently (neither is IANA-registered).
2. **Tamper-hash canonicalization** — define a reproducible normalized-content hash (object ordering/xref/IDs) before promoting `integrity.flattenedSha256` from advisory to a hard gate; or keep advisory permanently.
3. **EmbedPDF redaction in a headless/non-React context** — the plugin is viewer-oriented; confirm it drives cleanly from PDFx's pipeline (renderer or utility process) and confirm vector/partial-glyph coverage empirically before trusting it for sensitive redaction.
4. **PDFium bug 1051 current status** — the cited thread ends 2018; confirm 2026 behavior of `RemoveObject`/`GenerateContent` persistence, or rely solely on the plugin + saved-byte verification.
5. **B-T timestamp integration** — RFC3161 TSA embedding is not turnkey in `@signpdf`; prototype the PKI.js/TSP unsigned-attribute path before promising B-T in v1.
6. **PKCS#11 / OS-store native build matrix** — validate Electron-38/Node-24 NAPI rebuilds for `pkcs11js`/`graphene-pk11` across all three OSes; security-review `node-webcrypto-p11` against target tokens.
7. **Branch-protection permissions** — confirm the repo owner's plan/permissions allow the protection PUT; confirm the recorded CI check name after the first run.
8. **electron-builder version** — decide between keeping 25.1.8 + `libfuse2t64` vs bumping to 26.x + explicit `toolsets:{appimage:"1.0.3"}` (both MIT; bump alone is insufficient).
9. **macОS universal slice** — assert the arm64 runner still builds the x86_64 lipo slice; plan for the announced Intel-macOS retirement.
