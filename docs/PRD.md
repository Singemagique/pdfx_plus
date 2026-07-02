# PDFx Product Requirements Document (PRD)

## 1. Overview

PDFx (`pdfx_plus`) is a lightweight, fast Electron desktop application for working with multi-document PDF collections. Its native format — a `.pdfx` file — is a fully-valid PDF whose pages are every member document concatenated in order, plus one embedded PDF file-attachment named exactly `pdfx-manifest.json` describing the document boundaries (each document: `name` + `pages`). Any PDF viewer shows all pages; a PDFX-aware app re-splits them, and a plain PDF is a valid single-document PDFX file.

This PRD specifies the evolution of PDFx from a **structural-only** editor (reorder / insert / delete / rename / copy-paste / drag-drop of pages and documents, with export to `.pdfx` / `.pdf` / `.zip`) into a **lightweight but full PDF editor** — adding page transforms, PNG stamping, annotations, true content redaction, AcroForm filling, visual and cryptographic (PAdES) signatures, and an undo/redo foundation — while remaining at all times a valid PDF that any viewer can open. Edits are persisted with a hybrid strategy: flattened into the PDF content so every viewer sees them, and mirrored in an additive, backward-compatible **PDFX v1.1** manifest extension for round-trip re-editing. The app stays MIT-licensed and minimal; new capabilities are added as orthogonal layers that do not disturb the existing structural model.

This document is grounded in the real codebase at `I:/Claude/pdfx_plus`. Key existing modules: `src/main/{index,file-intake,markup,clipboard,menu,register-ipc,window}.ts`; `src/main/native/glass.ts`; `src/preload/index.ts`; `src/renderer/src/pdfx/{build,format,images,markup,...}.ts`; `src/renderer/src/app/doc-ops/{docs,move,pages}.ts` and hooks; `src/renderer/src/components/Toolbar.tsx`. External factual claims about third-party libraries below are cited; anything unverified is flagged explicitly.

> **Implementation status (as of v1.0.0).** This PRD is the forward-looking design; the shipped app went further than several "v1 / later-phase / experimental" markers below. Where they differ, the shipped state is authoritative:
>
> - **Integrity hash is a HARD GATE, not advisory.** The determinism suite (T1–T4) passed and the `pdfx-canon/1` gate now quarantines the mirror on a definite mismatch (`compareIntegrity`/`checkIntegrity`). Passages that say it "ships advisory first" describe the original rollout plan only.
> - **PAdES B-LTA shipped** (document timestamp over the DSS, `/Type /DocTimeStamp /SubFilter /ETSI.RFC3161`) — no longer out of scope. Setting an LTV toggle plus a TSA URL produces B-LTA automatically.
> - **PKCS#11 smart-card signing shipped** (via `koffi` FFI, not `node-webcrypto-p11`) and the **Windows certificate store** path shipped (CNG via PowerShell) — both are production features, not v2/experimental sub-tracks.
> - **Not implemented:** the §6 signed-file verification UI (diffing post-signature incremental updates) is not built; PDFx performs a post-sign DSS readout but no shadow-attack diff.

---

## 2. Goals / Non-goals

### Goals

- Keep PDFx a **valid PDF at every step** — backward compatible with v1.0 PDFX readers and with plain PDF viewers.
- Deliver a **lightweight full editor**: page transforms, PNG overlay/stamp, annotations (text, ink, highlight), AcroForm form filling, **true** redaction (genuine content removal), and signatures (visual + cryptographic PAdES).
- Provide **undo/redo** as a foundational capability spanning structural and content edits.
- Persist edits **hybrid**: flatten into content AND mirror in an editable manifest (PDFX v1.1) for re-editing, with a **hard-gated tamper hash** (§4.6) protecting the editable mirror against silent re-baking of stale edits.
- Reach **PAdES B-LT / LTV (long-term validation)** as the cryptographic-signing end state — signatures that remain verifiable after signer certificates expire or revocation services go offline — phased honestly via B-B → B-T → B-LT (§5.8).
- Achieve **cross-platform parity** across macOS, Windows, and Linux, with CI and the repo's first automated tests.
- Keep the whole app **MIT-licensed** — no GPL/AGPL copyleft in shipped artifacts.

### Non-goals

- Not a full Acrobat/InDesign replacement; no reflow/typesetting, no rich WYSIWYG content authoring beyond the listed annotation/overlay types.
- No collaborative/real-time multi-user editing, no cloud sync, no telemetry.
- Not bundling any AGPL engine (MuPDF, Ghostscript, cpdf) into the shipped app.
- OCR, full-text search, watermarking, Bates numbering, and document encryption remain **deferred** to an optional later phase (see roadmap), not part of the core editor scope.
- **PAdES B-LTA** (archival timestamps that re-protect the signature beyond the cryptographic lifetime of the initial timestamp) is **out of scope for v1**; the v1 end state is **B-LT**. B-LTA is a candidate for the optional later phase. (B-LT/LTV itself is now an in-scope goal, no longer deferred — corrected from the prior PRD revision.)

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

Add optional top-level keys: `edits` (serialized overlays grouped by document index + page), `attachments` (overlay images stored as embedded PDF file streams, referenced by name), and `integrity` (a tamper-detection record — see the canonicalization rule below).

**Concrete example:**

```json
{
  "pdfx": "1.1",
  "title": "Contract",
  "documents": [
    { "name": "NDA", "pages": 2 },
    { "name": "Invoice", "pages": 1 }
  ],
  "integrity": {
    "canonAlg": "pdfx-canon/1",
    "flattenedSha256": "9f2c…e1",
    "pageHashes": ["a1…", "b2…", "c3…"],
    "computedOverRevision": 0
  },
  "attachments": {
    "stamp-7af3": { "embeddedName": "pdfx-edit-stamp-7af3.png", "mime": "image/png" }
  },
  "edits": [
    /* … overlays grouped by doc + page … */
  ]
}
```

**Integrity = HARD GATE (decision N3).** `integrity.flattenedSha256` is a tamper gate, not advisory. On open, a PDFX-aware reader recomputes the hash over the flattened page content and hard-compares:

- **Match** → trust the editable mirror (`edits`/`attachments`), reconstruct editable overlays for round-trip re-editing, re-flatten on next export.
- **Mismatch** (the flattened PDF was altered by another tool) → **quarantine** the mirror: do **not** load `edits`/`attachments` into the editable model, treat the **flattened content as authoritative**, surface an "edited externally" warning naming the changed page(s) via `pageHashes[]`, and re-flatten from authoritative content only on next export. Stale edits are never silently re-baked.

**Why a hard gate needs a defined canonicalization.** pdf-lib's `save()` is **not byte-deterministic** — verified by source reading of the vendored 1.17.1 copy: random subset/key suffixes via `addRandomSuffix → Math.random()` (`utils/strings.js:28`, `CustomFontEmbedder.js:89`), `/ModDate` + `/CreationDate` rewritten via `new Date()` when `updateMetadata` defaults true (`PDFDocument.js`), object streams on by default, and a source-carried `/ID`. So the gate **must not hash file bytes**. Instead it hashes a **semantic canonical form** (`canonAlg = "pdfx-canon/1"`) of the **decoded, flattened page content**, which is immune by construction to every one of those non-determinism sources (all of which are removed by decoding before hashing).

**`pdfx-canon/1` (the canonicalization scheme).** Per page, in final flattened order, build and SHA-256 a byte buffer with a fixed structure:

1. Domain-separation prefix + page index.
2. **Geometry** — `MediaBox`, effective `CropBox` (falls back to `MediaBox`), and normalized `Rotate`, all via **canonical number formatting** (round to 1e-4, fixed-then-trimmed decimals, `-0`→`0`) so engine float-print drift does not change the hash; never the source's literal text.
3. **Content tokens** — all of the page's content streams, Flate/LZW-**decoded** and re-tokenized into PDF operators/operands; numbers via canonical formatting, names as `/Name`, strings hashed (`sha256(rawBytes)`), operators verbatim, inter-token whitespace collapsed. This stream is invariant to compression, object numbering, and whitespace.
4. **Resources** referenced by the content (fonts/images/XObjects/ExtGState…), enumerated in a fixed order keyed by `(subtype, name-as-used-in-content)`, each hashed by its **decoded** content: images by decoded sample bytes + dimensions/colorspace + soft-mask digest; form XObjects recursively; **fonts by the decoded embedded font program with the 6-char subset prefix stripped from `/BaseFont`** (this is the load-bearing trick that neutralizes pdf-lib's random subset names) plus a ToUnicode digest.

`pageHashes[i] = SHA-256(PAGE_i)`; `flattenedSha256 = SHA-256(domain-prefix + pageCount + concat(PAGE_i hashes))`. The v1.1 manifest itself (`edits`/`attachments`/`integrity`) is **excluded** from the hash — it covers only flattened visible content, so writing the manifest after computing the hash does not perturb it.

**Engine for the canonicalizer (corrected from research).** A permissive byte-deterministic _serializer_ (e.g. qpdf) is **not required** for correctness, because the scheme decodes before hashing. But pdf-lib has **no public content-stream tokenizer/decoder**, so a read-side decoder is needed. Capability check **refuted** the assumption that `@embedpdf/pdfium`'s _published_ API exposes the needed low-level page-object/operator-token primitives — its documented surface is render + text-extraction + document/page lifecycle ([@embedpdf/pdfium docs](https://www.embedpdf.com/docs/pdfium/getting-started)), and even the full PDFium C API yields already-parsed high-level objects, not the raw `cm/Do/re/f` token sequence this scheme hashes. The **primary** canonicalizer is therefore an **in-house Flate/LZW decode (pako is already a transitive dependency) + a small PDF content-stream tokenizer** operating on pdf-lib's decoded stream bytes and core `PDFDict`/`PDFRawStream` objects. PDFium/`FPDFText` is reserved for the redaction post-commit verification (§5.6) where text extraction is exactly what it exposes. **qpdf-wasm** (MIT wrapper over Apache-2.0 qpdf; `@neslinesli93/qpdf-wasm` ~v0.3.0, ~Dec 2025 — [npm](https://www.npmjs.com/package/@neslinesli93/qpdf-wasm)) stays an **optional** structural-normalization pre-pass (`--qdf --object-streams=disable --normalize-content=yes --deterministic-id`) only if a future feature needs to gate on file _structure_; `mutool clean` (MuPDF) is AGPL and remains disqualified.

**Advisory → hard rollout (honest).** The immunity-by-construction argument is sound from source analysis but **empirically unproven** end-to-end, and float-print boundaries plus edge cases (Type3 fonts, tiling patterns, optional-content/OCG, inline images, transparency groups) each need an explicit rule + fixture. So `pdfx-canon/1` **ships advisory first** (drives the warning only) and is **promoted to a hard gate only after determinism tests T1–T4 pass in CI** (save→reopen→rehash stable across N≥20 cycles; object-streams on/off identical; external-edit detected + localized; benign qpdf re-normalization leaves the hash unchanged). The `canonAlg` version tag gives a clean upgrade path: an **unknown `canonAlg` is treated as advisory, never silently accepted**.

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
- Use the custom MIME type **`application/x-pdfx`** consistently everywhere it appears (decision N1): electron-builder `mimeTypes`, the Linux desktop-entry `MimeType`, and `fileAssociations.mimeType`. This is a custom, non-IANA `x-` type; the earlier inconsistency between `application/pdfx` and `application/x-pdfx` is resolved in favor of `application/x-pdfx` and must not be reintroduced.
- Audit the macOS-only native glass addon to confirm clean no-op on Windows/Linux: `scripts/build-native.mjs` exits 0 when `process.platform !== 'darwin'`, `electron-builder.yml` sets `npmRebuild:false`, and `src/main/native/glass.ts` no-ops off-mac.
- Linux packaging on the runner: `apt-get install rpm` (rpmbuild is required by electron-builder's bundled fpm and is not preinstalled — confirmed) and handle AppImage FUSE: either install `libfuse2t64` (Ubuntu 24.04 renamed `libfuse2` → `libfuse2t64`, confirmed) **or** adopt electron-builder 26.x's static AppImage runtime, which is **opt-in** via `toolsets: { appimage: "1.0.3" }` (a version bump alone does NOT remove the FUSE dependency — only default in v27).

**Acceptance criteria**

- CI produces installable AppImage, `.deb`, and `.rpm` on Linux; `.exe`/NSIS on Windows; `.dmg`/zip on macOS — all from their respective matrix OS.
- Windows build no longer warns about a missing icon; `.ico` is present.
- Double-clicking a `.pdfx` opens PDFx on all three OSes via registered file association, and the registered MIME type is **`application/x-pdfx`** in every location it appears (grep for any stray `application/pdfx` returns nothing).
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

**Architecture.** One signing pipeline in the **Electron main process** (Node-only) with a `CredentialSource` abstraction feeding a single `@signpdf` flow. Place the signature field + `/Sig` dictionary with a placeholder `/Contents` and `/ByteRange` (via `@signpdf/placeholder-pdf-lib`, SubFilter `ETSI.CAdES.detached` for PAdES — the constant lives in `@signpdf/utils`), hash the ByteRange, call a pluggable `Signer` returning detached CMS, splice it in. All libraries verified MIT; `@signpdf/signpdf` latest is **v3.3.0** (Dec 2025) ([@signpdf/signpdf](https://registry.npmjs.org/@signpdf/signpdf/latest), [signer-p12](https://registry.npmjs.org/@signpdf/signer-p12/latest), [placeholder-pdf-lib](https://registry.npmjs.org/@signpdf/placeholder-pdf-lib/latest)). Only the final private-key RSA/ECDSA operation needs the credential — the clean delegation seam for any source ([node-signpdf README](https://github.com/vbuch/node-signpdf)).

**Credential sources (main-process abstraction).**

- **(a) `.p12`/PFX** — `@signpdf/signer-p12` (wraps node-forge). **Ship first (v1).** Note: signer-p12 declares `node-forge ^1.3.3`, which permits the vulnerable 1.3.x line; add an explicit top-level pin/override to **`node-forge >= 1.4.0`** — v1.4.0 fixed RSA-PKCS signature **forgery** via ASN.1 manipulation, Ed25519 malleability, and a cert-chain (basicConstraints) weakness (the load-bearing reason) ([forge CHANGELOG](https://github.com/digitalbazaar/forge/blob/main/CHANGELOG.md)). node-forge is `(BSD-3-Clause OR GPL-2.0)`; elect BSD-3-Clause in compliance docs.
- **(b) PKCS#11 smart card / token / HSM** — custom `Signer` using `node-webcrypto-p11` (MIT v2.8.0, over `graphene-pk11` MIT / `pkcs11js` MIT), with CMS assembled by `@peculiar/x509` + PKI.js, pointed at OpenSC or a vendor PKCS#11 module. The private key never leaves the device. **Gated behind a v2/experimental flag** — its own README states it "should be considered suitable for research and experimentation … before utilization in a production application" ([README](https://github.com/PeculiarVentures/node-webcrypto-p11)). Native addons require an Electron-38/Node-24 NAPI rebuild matrix.
- **(c) OS certificate stores** — Windows CNG (`NCryptSignHash`) / macOS Keychain (`security cms` / `SecKeyCreateSignature`). **No mature cross-platform npm library exists** — requires per-OS native/CLI glue and a CI build matrix. Highest-effort source; **v2**.

**PAdES levels — end state B-LT / LTV (decision N2).** The cryptographic-signing end state must reach **B-LT (long-term validation)**, so a signed `.pdfx` stays verifiable after the signer's certificate expires and after revocation services (OCSP/CRL) go offline. Honest phasing, because `@signpdf` is a baseline-only library — its README and v3.3.0 surface cover the `ETSI.CAdES.detached` SubFilter for baseline signing and make **no mention of DSS, LTV, OCSP/CRL, or document timestamps** ([node-signpdf README](https://github.com/vbuch/node-signpdf)); everything above B-T must be assembled by us. The ETSI EN 319 142-1 baseline-profile ladder is B-B → B-T → B-LT → B-LTA ([ETSI EN 319 142-1 v1.2.1, 2024-01](https://www.etsi.org/deliver/etsi_en/319100_319199/31914201/01.02.01_60/en_31914201v010201p.pdf); [PAdES levels explained](https://idura.eu/blog/pades-signature-levels-explained)):

- **B-B** (baseline) and **B-T** (RFC 3161 TSA timestamp via a configurable TSA URL, assembled as a CMS unsigned attribute through PKI.js/TSP — not turnkey in `@signpdf`, prototype first) ship in **v1's crypto milestone**.
- **B-LT** is the **required end state**. It conforms to B-T and additionally embeds a **Document Security Store (DSS) dictionary** carrying the full validation material: the signing-certificate chain, the timestamp-token certificate chain, and the **revocation data (OCSP responses and/or CRLs)** that validate them, optionally indexed per-signature via a **VRI (Validation Related Information)** sub-dictionary ([B-LT/DSS requirements](https://www.cryptomathic.com/blog/pades-and-long-term-archival-lta); [DSS/VRI how-to](https://www.eideasy.com/blog/how-to-create-pades-ltv-with-dss-vri)). Concretely PDFx must, at or after signing: (1) build the cert chain; (2) fetch a fresh OCSP response (or CRL) for each cert in the signer and TSA chains; (3) write the certs and revocation responses into `/DSS` (`/Certs`, `/OCSPs`, `/CRLs`, and a `/VRI` keyed by the hex-upper SHA-1 of each signature's `/Contents`); (4) append the DSS as an **incremental update** so the original signed revision's bytes are untouched (§6). `@signpdf` does not do steps 2–4 — they are implemented over PKI.js OCSP/TSP + `@peculiar/x509`, which is **unproven in this stack** and must be spiked.
- **B-LTA** (an additional **document timestamp** over the DSS, re-protecting the signature for archival beyond the first timestamp's cryptographic lifetime, plus VRI for the document-timestamp certificate) is **out of scope for v1** (§2 non-goals); it is a clean later increment on top of B-LT.

**Network dependency note.** Reaching B-LT requires live network access (OCSP/CRL endpoints, and the TSA for B-T) **at signing/upgrade time**. Signing must surface this dependency and fail gracefully — falling back to a successfully-produced B-T signature with a clear "LTV not embedded (revocation data unavailable)" status rather than emitting a malformed DSS — and should support a later **offline-tolerant LTV upgrade** pass that adds the DSS as an incremental update when connectivity returns (still consistent with §6, since it only appends).

**Acceptance criteria**

- A `.p12`-signed `.pdfx` validates as a PAdES signature (SubFilter `ETSI.CAdES.detached`) at **B-T** in a standard validator (e.g. Adobe), with a verified RFC 3161 timestamp.
- For B-LT: after the DSS pass, the same validator reports the signature as **LTV-enabled** with embedded revocation data, and the signature still validates **with system clock advanced past the signer cert's notAfter** and **with OCSP/CRL endpoints unreachable** (proves long-term validation does not depend on live services).
- The DSS and any LTV material are added strictly as **append-only incremental updates** that leave every prior signed revision byte-identical (§6).
- Signing runs entirely in main; the renderer only selects a source, supplies a PIN/password over IPC (new `window.api.signPdf` channel), and shows status (including a distinct B-T vs B-LT outcome).
- `node-forge` resolves to `>= 1.4.0` in the lockfile.
- The initial signature ByteRange covers the flattened content + embedded v1.1 manifest; subsequent DSS/timestamp revisions are appended after it.

---

## 6. Signed-immutability product RULE (resolving D3 interaction with signing)

**Rule.** Cryptographic signing is the **terminal export step** on a fully-assembled `.pdfx`. A signed `.pdfx` is treated as **finalized / immutable** in the editor: it opens **read-only / verify-only**. Any attempt to re-edit a signed file produces a **new, unsigned derivative** (signatures dropped, mirror unfrozen, re-flatten on next export) rather than silently invalidating the existing signature.

**Rationale.** A signature byte-locks the file; the `.pdfx` must be fully assembled — manifest attachment + flattened edits + v1.1 editable mirror + the `integrity` hash all in place — **before** signing. Any subsequent structural edit or manifest rewrite that is **not** an incremental update invalidates the signature and breaks the byte-locked manifest+mirror. Signing-last conflicts with later re-editing by definition; forking a new unsigned document is the correct PAdES semantics and the only honest UX.

**LTV / DSS material is append-only and consistent with immutability.** Reaching B-LT (§5.8) adds a **DSS dictionary** (and, in a future B-LTA increment, a document timestamp) **as incremental updates appended after** the signed revision. An incremental update leaves the original signed bytes intact and verifiable ([incremental update](https://developer.mescius.com/document-solutions/dot-net-pdf-api/docs/online/Features/IncrementalUpdate)), so adding LTV validation data is **not** a re-edit and does **not** drop the signature — it strengthens it. This is the one class of post-signature mutation PDFx performs on a signed file, and it is permitted precisely because it is append-only. The `integrity` hash (§4.6) is computed over pre-signing flattened page content and remains recomputable and equal after signing and after the LTV upgrade, because neither touches revision 0's page bytes (`integrity.computedOverRevision = 0` records this); a signed file's manifest/integrity bytes sit inside the signed ByteRange, so the app must **never** attempt a non-incremental manifest rewrite on a signed file.

**Multi-signer incremental-update nuance.** Additional **approval** signatures are allowed **only as appended incremental updates**: a second signature's ByteRange covers only the earlier bytes, so prior signatures remain cryptographically intact. This enables multi-party signing without re-saving, and the pre-signing `integrity` hash continues to verify because each new signature only appends. **Critical caveat:** this is a **validator-dependent** security property — append-only updates keep earlier signatures verifiable, but known PDF attacks (incremental-update abuse / "Shadow Attacks") can fool naive validators ([PDFA advisory](https://pdfa.org/recently-identified-pdf-digital-signature-vulnerabilities/)). PDFx's own verification UI must **diff and surface any post-signature incremental changes** — distinguishing benign appended DSS/timestamp/approval-signature revisions from page-content changes — and never report "hash matches = valid" alone.

---

## 7. Security considerations

- **Redaction true-removal (highest-sensitivity).** Treat "the content is gone" as a **tested gate**, not a trust claim: an automated post-commit test re-extracts text/objects under each redaction rect from the **saved bytes**. Where verification cannot confirm removal (partial glyphs, vector art), fall back to rasterizing only that page and warn the user. Never ship a redaction path that has only been validated against in-memory page state.
- **Integrity hard gate + canonicalization (decision N3).** The `integrity.flattenedSha256` hard gate (§4.6) is a tamper-evidence control: on mismatch the editable mirror is **quarantined** and flattened content is treated as authoritative, so an attacker cannot smuggle malicious or stale `edits`/`attachments` past a recipient by altering the visible PDF. Its security value depends entirely on the canonicalization being correct and deterministic — a false-negative (collision) hides a real edit, a false-positive quarantines a benign file — so the gate is **promoted from advisory to hard only after the determinism test suite (T1–T4) passes in CI**, and an **unknown `canonAlg` degrades to advisory** rather than being trusted. The canonicalizer is in-house decode + tokenize (pako already present) with PDFium reserved for redaction verification; no AGPL serializer is introduced (qpdf is Apache-2.0 and optional; MuPDF/`mutool` stays disqualified).
- **Certificate / private-key handling.** All crypto and native modules run in the **main process** only; the renderer never touches keys. For `.p12`, the password arrives over IPC and is used transiently; for PKCS#11, the private key never leaves the device. Pin `node-forge >= 1.4.0` (signature-forgery and cert-chain fixes).
- **Smart-card PIN handling.** PINs are entered in the renderer, passed to main over IPC, and forwarded to the PKCS#11 module without persistence; never log PINs; clear from memory promptly. Treat `node-webcrypto-p11` as experimental and security-review it against target tokens before production.
- **Revocation-data fetching for LTV (network-facing).** Reaching B-LT (§5.8) requires fetching OCSP/CRL responses and contacting a TSA at signing time. These network calls run in the **main process**, must use HTTPS/RFC-3161 endpoints with response validation (verify the OCSP response signature and that it covers the queried cert; bound response sizes to resist a malicious endpoint), must not block the UI indefinitely (timeouts), and must **fail closed to a valid B-T signature** rather than embedding unverified or attacker-supplied revocation data into the DSS. Cache nothing security-relevant beyond the produced document.
- **Decompression-bomb guards (already present).** The existing image intake caps (`isImageBytes` / pngSize-driven limits in `src/renderer/src/pdfx/images.ts`) are an established guard; extend the same defensive posture to any new wasm/native engine inputs (cap page/object/stream sizes fed to PDFium and to the in-house canonicalizer's decode step).
- **Hardened render session as a model.** The existing offscreen hardened `BrowserWindow` → `printToPDF` markup pipeline (`src/main/markup.ts`) is the model for any future untrusted-content rendering: isolated session, no network, no node integration.
- **Signature verification UI.** Per §6, diff post-signature incremental updates — classifying appended DSS/timestamp/approval revisions as benign vs flagging page-content changes — and surface them; do not equate hash-match with validity.

---

## 8. Risks & mitigations

| #   | Risk                                                                                                                                                                                                                 | Likelihood | Impact             | Mitigation                                                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Redaction leaves recoverable content under partial-glyph/vector cases                                                                                                                                                | Medium     | Critical           | Automated post-commit byte-level verification test; rasterize-page fallback with user warning                                                                                                                                                                                                               |
| R2  | PDFium `RemoveObject`/`GenerateContent` removal lost on save (bug 1051)                                                                                                                                              | Low–Med    | High               | Prefer EmbedPDF plugin (owns stream rewrite) over hand-rolled removal; verify saved bytes                                                                                                                                                                                                                   |
| R3  | Accidentally bundling an AGPL engine (MuPDF/Ghostscript/cpdf)                                                                                                                                                        | Low        | Critical (license) | Hard rule: only MIT/BSD/Apache deps in shipped artifacts; license-check in CI                                                                                                                                                                                                                               |
| R4  | `node-forge` resolves to vulnerable 1.3.x via signer-p12 peer range                                                                                                                                                  | Medium     | High               | Explicit top-level pin/override `node-forge >= 1.4.0`; lockfile assertion                                                                                                                                                                                                                                   |
| R5  | PKCS#11/OS-store native addons fail Electron-38/Node-24 NAPI rebuild in CI                                                                                                                                           | Medium     | Med                | Spike early; gate hardware-token/OS-store signers as v2/experimental                                                                                                                                                                                                                                        |
| R6  | `pdfx-canon/1` canonicalization implemented incorrectly — hard gate false-positive-quarantines benign re-encodings (float-print boundaries, Type3/tiling/OCG/inline-image edge cases) or false-negatives a real edit | Medium     | High               | Ship advisory first; promote to hard gate only after determinism tests T1–T4 pass in CI (N≥20 stability, object-streams on/off identical, external-edit localized, benign qpdf re-normalization unchanged); explicit rule + fixture per edge case; `canonAlg` version tag degrades unknown algs to advisory |
| R6b | No turnkey decoded-token engine: `@embedpdf/pdfium`'s published API lacks the low-level page-object/operator-token primitives the canonicalizer needs                                                                | Medium     | Med                | Primary path is in-house Flate/LZW decode (pako already a dep) + small PDF tokenizer over pdf-lib's decoded streams; PDFium reserved for redaction text-extraction verification only; qpdf-wasm optional structural pre-pass                                                                                |
| R7  | Editing a signed file silently invalidates signature                                                                                                                                                                 | Medium     | High               | Immutability rule (§6): signed file is read-only; re-edit forks a new unsigned derivative                                                                                                                                                                                                                   |
| R8  | electron-builder v26 AppImage bump assumed to drop FUSE but doesn't                                                                                                                                                  | Medium     | Low                | Keep `libfuse2t64` install OR add `toolsets:{appimage:"1.0.3"}` explicitly                                                                                                                                                                                                                                  |
| R9  | Highlight opacity approximation darkens overlapping text                                                                                                                                                             | High       | Low                | Accept for lightweight editor; design review on default opacity                                                                                                                                                                                                                                             |
| R10 | Duplicated pages share edits via shared source+index key                                                                                                                                                             | Medium     | Med                | Per-logical-page id with copy-on-duplicate remap (§4.1)                                                                                                                                                                                                                                                     |
| R11 | Immer patches over full tree slow on large collections / continuous ink                                                                                                                                              | Low–Med    | Med                | Coalesce drag/ink gestures into single history entries; bounded stack                                                                                                                                                                                                                                       |
| R12 | Branch-protection check name drifts, silently disabling the gate                                                                                                                                                     | Low        | Med                | Gate on job id `check`, confirm recorded name after first run                                                                                                                                                                                                                                               |
| R13 | `--publish never` may not pass cleanly through electron-vite build scripts                                                                                                                                           | Low        | Low                | Fall back to `electron-vite build` then `electron-builder --<os> --publish never`                                                                                                                                                                                                                           |
| R14 | macOS runner is arm64; universal lipo slice may fail if x64 SDK dropped                                                                                                                                              | Low        | Med                | Assert universal slice builds in CI; script already falls back to host arch                                                                                                                                                                                                                                 |
| R15 | B-LT/LTV not turnkey in `@signpdf` (no native DSS/OCSP/CRL/timestamp); PKI.js OCSP/TSP path unproven in this stack; revocation/TSA endpoints may be unreachable at signing time                                      | Medium     | High               | Phase B-B → B-T → B-LT; spike PKI.js DSS/OCSP path early; fail closed to a valid B-T signature when revocation data is unavailable; offline-tolerant LTV-upgrade pass via append-only incremental update; verify LTV holds with clock past cert expiry and endpoints offline                                |

---

## 9. Phased roadmap

**Phase 0 — Cross-platform + CI + first tests (foundation).**

- `electron-builder.yml` `linux:` block (AppImage+deb+rpm), `build/icon.ico`, custom MIME **`application/x-pdfx`** applied consistently (N1), native-glass no-op audit.
- `.github/workflows/ci.yml`: `check` job (Ubuntu — install, `yarn typecheck`, `prettier --check`, `yarn test`) + `build` matrix (macOS/Windows/Ubuntu, `fail-fast:false`), Linux `apt-get install rpm libfuse2t64`, `CSC_IDENTITY_AUTO_DISCOVERY:false`, Electron cache, artifact upload.
- First tests: Vitest 4.1.9 (MIT), `@vitest/coverage-v8` 4.1.9, jsdom 29.1.1 (MIT), single `vitest.config.mts` with `test.projects` (node + jsdom). Seed tests: `buildPdfx` round-trip (assert page count, embedded `pdfx-manifest.json` presence via EmbeddedFiles name tree), `names.ts`/doc-ops reducers, `file-intake.ts` predicates. Defer `readManifest` (needs pdfjs proxy) and canvas paths to phase-2.
- Repo config: squash-merge only, delete-branch-on-merge, branch protection gating on CI.

**Phase 1 — Edit backbone.** Typed edit model + durable page key + copy-on-duplicate remap; Immer undo/redo (unified with structural ops); live overlay layer + hit-testing; flatten-on-export for image/ink/text; PNG overlay/stamp (D3); visual/ink signatures (D4 visual half); page transforms.

**Phase 2 — Annotations + form fill + canonicalization.** Highlight + text-box polish; AcroForm detection + fill + `form.flatten()`; v1.1 manifest mirror read/write; round-trip re-editing. **Implement the `pdfx-canon/1` canonicalizer** (in-house Flate/LZW decode + content-stream tokenizer + decoded-resource digests + per-page `pageHashes[]`) and its **determinism test suite (T1–T4)**. Ship the `integrity` hash **advisory** in this phase; **promote it to the §4.6 hard gate once T1–T4 are green in CI**.

**Phase 3 — True redaction + crypto signing (B-B/B-T) + verification UI.** Integrate `@embedpdf/pdfium` + redaction plugin with mandatory post-commit verification test + rasterize fallback (T6); `@signpdf` `.p12` PAdES **B-B then B-T** pipeline in main (prototype the PKI.js/TSP RFC-3161 timestamp path); signed-immutability rule + verification UI (diff incremental updates, classify benign appended revisions); post-sign integrity re-verification test (T5). PKCS#11 and OS-store signers as experimental sub-tracks.

**Phase 4 — PAdES B-LT / LTV (required end state, N2).** Build the cert chain + fetch OCSP/CRL revocation data via PKI.js OCSP/TSP, assemble and append a **DSS dictionary** (`/Certs`, `/OCSPs`, `/CRLs`, `/VRI`) as an append-only incremental update; verify the signature stays valid with the clock advanced past cert expiry and with revocation endpoints offline; offline-tolerant LTV-upgrade pass. Fail closed to B-T when revocation data is unavailable.

**Phase 5 (optional).** PAdES **B-LTA** (archival document timestamps over the DSS); OCR / full-text search, watermark, Bates numbering, encryption; optional qpdf-wasm structural pre-pass; maintained-pdf-lib-fork evaluation.

---

## 10. Engineering process

- **PRs with squash-merge only.** Configure via REST: `allow_squash_merge=true`, `allow_merge_commit=false`, `allow_rebase_merge=false`, `delete_branch_on_merge=true`, with `squash_merge_commit_title=PR_TITLE` / `squash_merge_commit_message=PR_BODY` (enums confirmed, [GitHub REST](https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28#update-a-repository)). Booleans via `gh api -F`, strings via `-f`. Branch protection PUT on `main` requires repo admin; gate on the job **id** `check` (not display name) to avoid silent drift.
- **CI matrix.** Two-tier `ci.yml`: fast Ubuntu `check` (lint/typecheck/test) + `build` matrix across macOS/Windows/Ubuntu (`needs: check`, `fail-fast:false`). Yarn Classic v1 confirmed (`yarn.lock` `lockfile v1`, no `packageManager`), so `actions/setup-node@v4` `cache: yarn` + `yarn install --frozen-lockfile` works **without** corepack. Node 24.
- **Test strategy.** Vitest two-project (node + jsdom) per §9 Phase 0. Pure, headless-testable logic first: `build.ts`/`buildPdfx`, `format.ts` (`partitionPages`/`stripExtension`), `names.ts`, doc-ops reducers, `file-intake.ts` predicates — all verified importable in plain node (no module-scope Electron/DOM imports; `format.ts`'s `PDFDocumentProxy` is a type-only import erased at runtime). **The redaction post-commit verification test is a mandatory release gate.** Optional Playwright `_electron` smoke launch is phase-2+ (re-verify its Apache-2.0 license before adding; dev-only, not bundled). Pin Node `>= 20` in CI (`crypto.randomUUID` dependency).

---

## 11. Open questions

1. **EmbedPDF redaction in a headless/non-React context** — the plugin is viewer-oriented; confirm it drives cleanly from PDFx's pipeline (renderer or utility process) and confirm vector/partial-glyph coverage empirically before trusting it for sensitive redaction.
2. **PDFium bug 1051 current status** — the cited thread ends 2018; confirm 2026 behavior of `RemoveObject`/`GenerateContent` persistence, or rely solely on the plugin + saved-byte verification.
3. **`pdfx-canon/1` empirical proof** — run T1–T4 to confirm decode+normalize fully neutralizes pdf-lib non-determinism across the real overlay/font/stamp pipeline before flipping the integrity gate from advisory to hard; pin the number-rounding tolerance (1e-4) and confirm it lands identically across the in-house tokenizer and any qpdf re-normalization; write explicit canonicalization rules + fixtures for Type3 fonts, tiling patterns, optional-content (OCG), inline images, and transparency groups.
4. **Canonicalizer engine surface** — verify whether the _installed_ `@embedpdf/pdfium` WASM exports the undocumented `FPDFPage_*`/`FPDFPageObj_*` symbols (vs only the documented text/render API); if not (current expectation), confirm the in-house pako-decode + tokenizer is the committed primary path and PDFium is used only for redaction verification.
5. **TSA provider for B-T** — choose a default RFC-3161 timestamp authority (free/public vs paid/qualified), make it configurable, and prototype the PKI.js/TSP unsigned-attribute embedding before promising B-T in v1; decide behavior when the TSA is unreachable.
6. **B-LT revocation strategy** — OCSP vs CRL preference and fallback order; how fresh OCSP responses must be; whether to embed a stapled OCSP at signing or only at the DSS pass; and the exact `/DSS`+`/VRI` layout a target validator (Adobe / DSS / EU eIDAS validators) accepts.
7. **LTV network dependency at signing** — define UX and policy when revocation/TSA endpoints are unreachable at sign time: fail closed to B-T with a clear status, plus a deferred offline-tolerant LTV-upgrade pass (append-only) when connectivity returns — and confirm that upgrade path validates.
8. **B-LTA scope** — confirm B-LTA (archival document timestamps re-protecting the signature) stays out of v1 and is a Phase 5 increment; capture the trigger (timestamp-algorithm aging) that would make it required.
9. **PKCS#11 / OS-store native build matrix** — validate Electron-38/Node-24 NAPI rebuilds for `pkcs11js`/`graphene-pk11` across all three OSes; security-review `node-webcrypto-p11` against target tokens.
10. **Branch-protection permissions** — confirm the repo owner's plan/permissions allow the protection PUT; confirm the recorded CI check name after the first run.
11. **electron-builder version** — decide between keeping 25.1.8 + `libfuse2t64` vs bumping to 26.x + explicit `toolsets:{appimage:"1.0.3"}` (both MIT; bump alone is insufficient).
12. **macOS universal slice** — assert the arm64 runner still builds the x86_64 lipo slice; plan for the announced Intel-macOS retirement.
