# Third-party notices

PDFx is MIT-licensed (see `LICENSE`). The packaged app also ships the third-party components
below. Each licence text is installed next to this file, in `resources/licenses/`.

## Fonts and PDF rendering

| Component                     | Licence       | File                       |
| ----------------------------- | ------------- | -------------------------- |
| DejaVu fonts (Bitstream Vera) | DejaVu / Vera | `DejaVu-Fonts-LICENSE.txt` |
| pdf.js (`pdfjs-dist`)         | Apache-2.0    | `pdfjs-dist-LICENSE.txt`   |

## Text recognition (OCR)

Text recognition runs the Tesseract OCR engine compiled to WebAssembly by
[tesseract.js-core](https://github.com/naptha/tesseract.js-core) 7.0.0. PDFx ships only
`tesseract-core-simd-lstm.js` and `tesseract-core-simd-lstm.wasm` (in `resources/ocr/`), loaded by
PDFx's own loader.

[tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0) is not a dependency and none
of its code ships, but PDFx's loader follows the API usage of its worker script, and we gratefully
credit it as the reference.

The libraries below are statically linked into `tesseract-core-simd-lstm.wasm`. The list comes from
the tesseract.js-core `v7.0.0` build scripts (`build.sh`, `build-scripts/*.sh`, and the WebAssembly
link line in the Tesseract fork's `CMakeLists.txt`); each licence text was taken from the upstream
repository at the exact submodule commit that tag pins.

| Component                              | Licence                            | Source (commit)                                | File                                         |
| -------------------------------------- | ---------------------------------- | ---------------------------------------------- | -------------------------------------------- |
| tesseract.js-core                      | Apache-2.0                         | npm `tesseract.js-core@7.0.0`                  | `tesseract.js-core-LICENSE.txt`              |
| Tesseract OCR (Balearica fork)         | Apache-2.0                         | github.com/Balearica/tesseract `2a9c1c49`      | `Tesseract-LICENSE.txt`                      |
| Leptonica                              | BSD-2-Clause (Leptonica licence)   | github.com/DanBloomberg/leptonica `4af068b5`   | `Leptonica-LICENSE.txt`                      |
| libjpeg (IJG)                          | IJG licence (in the README)        | github.com/LuaDist/libjpeg `6c0fcb8d`          | `libjpeg-LICENSE.txt`                        |
| libpng                                 | libpng licence                     | github.com/glennrp/libpng `a37d4836`           | `libpng-LICENSE.txt`                         |
| libtiff (and libtiffxx)                | libtiff licence                    | gitlab.com/libtiff/libtiff `b51bb157`          | `libtiff-LICENSE.txt`                        |
| libwebp (with libwebpdecoder/demux)    | BSD-3-Clause, plus a patent grant  | github.com/webmproject/libwebp `20ef03ee`      | `libwebp-LICENSE.txt`, `libwebp-PATENTS.txt` |
| giflib                                 | MIT                                | github.com/mirrorer/giflib `fa376720`          | `giflib-LICENSE.txt`                         |
| zlib                                   | zlib licence (in the README)       | github.com/madler/zlib `21767c65`              | `zlib-LICENSE.txt`                           |
| openlibm                               | MIT / BSD / ISC (see file)         | github.com/JuliaMath/openlibm `ae2d9169`       | `openlibm-LICENSE.txt`                       |
| Emscripten runtime and libraries       | MIT or University of Illinois/NCSA | github.com/emscripten-core/emscripten `4.0.15` | `Emscripten-LICENSE.txt`                     |
| musl libc (as bundled by Emscripten)   | MIT                                | emscripten `4.0.15` `system/lib/libc/musl`     | `musl-LICENSE.txt`                           |
| libc++ (as bundled by Emscripten)      | Apache-2.0 WITH LLVM-exception     | emscripten `4.0.15` `system/lib/libcxx`        | `libcxx-LICENSE.txt`                         |
| libc++abi (as bundled by Emscripten)   | Apache-2.0 WITH LLVM-exception     | emscripten `4.0.15` `system/lib/libcxxabi`     | `libcxxabi-LICENSE.txt`                      |
| compiler-rt (as bundled by Emscripten) | Apache-2.0 WITH LLVM-exception     | emscripten `4.0.15` `system/lib/compiler-rt`   | `compiler-rt-LICENSE.txt`                    |

The Emscripten version is the one `build-with-docker.sh` pins at that tag (`EM_VERSION=4.0.15`).
Emscripten's default allocator (dlmalloc) is public domain. The build also embeds Tesseract's own
`pdf.ttf` (part of Tesseract, Apache-2.0).

### Language data

The bundled English, German, French and Spanish models (`resources/ocr/tessdata/`) are the
`4.0.0_best_int` files of the npm packages `@tesseract.js-data/{eng,deu,fra,spa}@1.0.0`,
integer-converted from [tessdata_best](https://github.com/tesseract-ocr/tessdata_best).

| Component                        | Licence    | File                            |
| -------------------------------- | ---------- | ------------------------------- |
| tessdata_best (the trained data) | Apache-2.0 | `tessdata-LICENSE.txt`          |
| tesseract.js-data (packaging)    | see file   | `tesseract.js-data-LICENSE.txt` |
