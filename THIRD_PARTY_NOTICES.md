# Third-party notices

PDFx is MIT-licensed (see `LICENSE`). The packaged app also ships the third-party components
below. Each licence text is installed next to this file, in `resources/licenses/`.

## Fonts and PDF rendering

| Component                     | Licence       | File                       |
| ----------------------------- | ------------- | -------------------------- |
| DejaVu fonts (Bitstream Vera) | DejaVu / Vera | `DejaVu-Fonts-LICENSE.txt` |
| pdf.js (`pdfjs-dist`)         | Apache-2.0    | `pdfjs-dist-LICENSE.txt`   |

## Text recognition (OCR)

Text recognition runs the [Tesseract](https://github.com/tesseract-ocr/tesseract) OCR engine with
[Leptonica](https://github.com/DanBloomberg/leptonica), compiled to WebAssembly by PDFx itself from
the upstream sources (`build/ocr-core/` in the source repository: pinned versions, the build
script and the exact flags). PDFx ships only `tesseract-core-simd-lstm.js` and
`tesseract-core-simd-lstm.wasm` (in `resources/ocr/`), loaded by PDFx's own loader; the
JavaScript bindings are PDFx's own.

**Modified files (Apache-2.0 §4(b)):** PDFx's build applies two patches to Tesseract 5.5.5, both in
`build/ocr-core/patches/`: `src/arch/simddetect.cpp` (SIMD selection without CPUID under
WebAssembly) and `src/arch/intsimdmatrixsse.cpp` (a WebAssembly SIMD128 matrix kernel). No other
source file is changed.

[tesseract.js](https://github.com/naptha/tesseract.js) and
[tesseract.js-core](https://github.com/naptha/tesseract.js-core) (both Apache-2.0) are not
dependencies and none of their code ships, but PDFx's loader follows the API usage of tesseract.js's
worker script and its build follows tesseract.js-core 7.0.0's configuration, and we gratefully credit
them as the reference.

The libraries below are statically linked into `tesseract-core-simd-lstm.wasm` (the linker's own
list, `wasm-ld -v`). Leptonica is built without any image-format library (no zlib, libpng,
libjpeg, libtiff, giflib, libwebp or OpenJPEG), so none of those is part of the engine.

| Component                               | Licence                            | Source                                                  | File                      |
| --------------------------------------- | ---------------------------------- | ------------------------------------------------------- | ------------------------- |
| Tesseract OCR 5.5.5 (with PDFx patches) | Apache-2.0                         | github.com/tesseract-ocr/tesseract `5.5.5` (`4292f689`) | `Tesseract-LICENSE.txt`   |
| Leptonica 1.87.0                        | BSD-2-Clause (Leptonica licence)   | github.com/DanBloomberg/leptonica `1.87.0`              | `Leptonica-LICENSE.txt`   |
| Emscripten runtime and libraries        | MIT or University of Illinois/NCSA | github.com/emscripten-core/emscripten `4.0.15`          | `Emscripten-LICENSE.txt`  |
| musl libc (as bundled by Emscripten)    | MIT                                | emscripten `4.0.15` `system/lib/libc/musl`              | `musl-LICENSE.txt`        |
| libc++ (as bundled by Emscripten)       | Apache-2.0 WITH LLVM-exception     | emscripten `4.0.15` `system/lib/libcxx`                 | `libcxx-LICENSE.txt`      |
| libc++abi (as bundled by Emscripten)    | Apache-2.0 WITH LLVM-exception     | emscripten `4.0.15` `system/lib/libcxxabi`              | `libcxxabi-LICENSE.txt`   |
| compiler-rt (as bundled by Emscripten)  | Apache-2.0 WITH LLVM-exception     | emscripten `4.0.15` `system/lib/compiler-rt`            | `compiler-rt-LICENSE.txt` |

The Tesseract and Leptonica licence texts are the files in those exact source archives. The
Emscripten version is the one the build image is pinned to. Emscripten's default allocator
(dlmalloc) is public domain. Tesseract 5.5.5 ships no NOTICE file.

### Language data

The bundled English, German, French and Spanish models (`resources/ocr/tessdata/`) are the
`4.0.0_best_int` files of the npm packages `@tesseract.js-data/{eng,deu,fra,spa}@1.0.0`,
integer-converted from [tessdata_best](https://github.com/tesseract-ocr/tessdata_best).

| Component                        | Licence    | File                            |
| -------------------------------- | ---------- | ------------------------------- |
| tessdata_best (the trained data) | Apache-2.0 | `tessdata-LICENSE.txt`          |
| tesseract.js-data (packaging)    | see file   | `tesseract.js-data-LICENSE.txt` |
