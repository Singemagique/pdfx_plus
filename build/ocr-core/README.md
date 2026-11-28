# PDFx Tesseract core

PDFx's OCR engine is upstream [Tesseract](https://github.com/tesseract-ocr/tesseract) 5.5.5 and
[Leptonica](https://github.com/DanBloomberg/leptonica) 1.87.0, compiled to WebAssembly here with
Emscripten. The result is committed under `vendor/tesseract-core/5.5.5/`
(`tesseract-core-simd-lstm.js` + `.wasm`), shipped as `resources/ocr/` by electron-builder and
checked byte for byte by the OCR utility process against `src/main/ocr/process/engine-manifest.ts`.

The configuration follows tesseract.js-core v7.0.0's `simd-lstm` build (the core PDFx 1.1.4
shipped), on upstream code and with every image codec removed. No code from tesseract.js or
tesseract.js-core is used; the JavaScript bindings (`glue/`) are PDFx's own.

## Rebuild

Needs Docker (Linux, macOS, or Docker Desktop on Windows with Git Bash), `curl`, `git`, `gzip` and
`sha256sum`:

```sh
bash build/ocr-core/build.sh --out /tmp/core                                    # build
bash build/ocr-core/build.sh --out /tmp/core --verify vendor/tesseract-core/5.5.5  # build and compare
```

`--verify` exits non-zero unless the output equals `EXPECTED.sha256` and the vendored files. CI does
exactly this (`.github/workflows/ocr-core-build.yml`) whenever anything here or under
`vendor/tesseract-core/` changes. A build takes about a minute.

## What is pinned (`versions.env`)

| Input                     | Pin                                                                            |
| ------------------------- | ------------------------------------------------------------------------------ |
| Build image               | `emscripten/emsdk` 4.0.15 by digest (linux/amd64)                              |
| Tesseract 5.5.5           | commit `4292f689…` (checked via `git get-tar-commit-id`) + source-tree SHA-256 |
| Leptonica 1.87.0          | the release asset's SHA-256 + source-tree SHA-256                              |
| Patches, glue, build flag | this directory; any change bumps `PDFX_CORE_REVISION` (part of the engine id)  |
| Output                    | `EXPECTED.sha256`, and the sizes and hashes in `engine-manifest.ts`            |

GitHub generates `/archive/<commit>.tar.gz` on the fly and does not promise stable bytes, so the
Tesseract archive hash only warns; the source-tree hash (SHA-256 of the sorted `sha256sum` list of
every extracted file, computed inside the container) is what must match.

## Determinism

Two builds give the same bytes, including from another host path and with one job. What makes that
hold:

- Everything compiles inside the digest-pinned image, with `--network none`, at fixed paths
  (`/work`), plus `-ffile-prefix-map`; `LC_ALL=C`, `TZ=UTC`, `umask 022`.
- `SOURCE_DATE_EPOCH` is the Tesseract 5.5.5 commit time. Nothing in the output embeds a date.
- No `-march=native`, no FMA, no relaxed SIMD: all floating-point choices are made at compile time
  by the pinned compiler, so the engine's output does not depend on the CPU that runs it.

## Configuration, and why

- **Tesseract**: LSTM only (`DISABLED_LEGACY_ENGINE`), `-O3`, SSE4.1 kernels on `-msimd128`, no
  AVX/FMA, OpenMP, TIFF, libarchive, curl, training tools or graphics. `TESSERACT_IMAGEDATA_AS_PIX`
  and `TESSERACT_DISABLE_DEBUG_FONTS` (upstream switches) keep line images as Pix and skip the debug
  fonts, so Leptonica never encodes or decodes an image format during recognition.
- **Leptonica**: `-O3 -DMINIMUM_SEVERITY=4` and **no image libraries** (zlib, libpng, libjpeg,
  libtiff, giflib, libwebp, openjpeg all off). PDFx only ever feeds the engine a binary P5 PGM it
  wrote itself, which Leptonica's built-in PNM reader handles, so every other parser is attack
  surface and size (about 1.2 MB of WebAssembly) for nothing. Leptonica keeps stub functions for the
  missing formats that only return errors.
- **Link**: the 7.0.0 flags (see `inner.sh`): `-O3 --closure 1`, `MODULARIZE`, Node-only,
  memory growth up to 2 GiB, `FORCE_FILESYSTEM`, `FS` exported. The loader passes its own compiled
  module through `instantiateWasm`, so the glue never fetches or reads the `.wasm` itself.
- **Bindings** (`glue/pdfx.idl`, `glue/wrapper.cpp`, through Emscripten's `webidl_binder`): exactly
  what `src/shared/ocr/engine/tess-core.ts` calls: `TessBaseAPI`, `SetVariable`, `Init`,
  `SetImageFile` (PGM only; returns false for anything else), `Recognize`, `GetHOCRText`, `End`,
  and `FS`.

## Patches (`patches/`, applied to Tesseract in order)

1. `0001-simddetect-emscripten.patch`: WebAssembly has no CPUID; enable the kernels the build was
   compiled for.
2. `0002-wasm-simd128-int8-kernel.patch`: a native SIMD128 int8 matrix kernel in place of the SSE4.1
   one, which runs slowly through Emscripten's SSE emulation (it is about half of recognition
   time). Integer sums are exact and the float expression is the SSE kernel's, so the hOCR is
   byte-identical to the unpatched build; recognition is about 6% faster than tesseract.js-core
   7.0.0 instead of about 20% slower.

Both are PDFx modifications of Apache-2.0 Tesseract, listed as such in `THIRD_PARTY_NOTICES.md`.

## Bumping Tesseract or Leptonica (e.g. a security release)

1. Edit `versions.env` (tag, commit, URL, archive SHA-256), bump `PDFX_CORE_REVISION` if the
   Tesseract tag stays the same, and set the tree hashes to anything: the first build prints the
   real ones. Rebase the patches if they no longer apply.
2. `bash build/ocr-core/build.sh --out /tmp/core`, copy the two files into
   `vendor/tesseract-core/<tag>/`, and write their hashes into `EXPECTED.sha256`.
3. Update `ENGINE_ID` (`tess-core.ts`), `ENGINE_CORE` (`engine-manifest.ts`), the electron-builder
   `extraResources` paths, and the licence files under `build/licenses/` if what is linked changed.
4. Re-record and recalibrate: `yarn ocr:record --baseline`,
   `yarn ocr:calibrate --seeds 1,2,3,4,5 --threads 4`, then the `--check` run, and explain any gate
   change in the commit message.
