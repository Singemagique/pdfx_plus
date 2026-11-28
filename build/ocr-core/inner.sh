#!/bin/bash
# Runs INSIDE the pinned emscripten/emsdk image (see build.sh), with no network.
# /in: the downloaded source archives (read-only); /pdfx: this directory (read-only); /out: results.
set -euo pipefail
export SOURCE_DATE_EPOCH LC_ALL=C TZ=UTC
umask 022
JOBS=$(nproc)
W=/work
rm -rf "$W" && mkdir -p "$W/dep"
cd "$W"

# A content hash of an extracted tree: SHA-256 over the sorted `sha256sum` listing of every file.
# Independent of how the archive was compressed, so it pins what is built, not the tarball bytes.
treehash() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 sha256sum) | sha256sum | cut -d' ' -f1; }
unpack() { # name archive pin
  mkdir "$W/$1.x"
  tar xzf "$2" -C "$W/$1.x"
  mv "$W/$1.x"/* "$W/$1" && rmdir "$W/$1.x"
  local got
  got=$(treehash "$W/$1")
  [ "$got" = "$3" ] || { echo "$1: source tree hash $got differs from the pin $3" >&2; exit 1; }
}
unpack tesseract /in/tesseract.tar.gz "$TESSERACT_TREE_SHA256"
unpack leptonica /in/leptonica.tar.gz "$LEPTONICA_TREE_SHA256"
for p in /pdfx/patches/*.patch; do patch -d tesseract -p1 --no-backup-if-mismatch < "$p"; done

# Same optimisation as tesseract.js-core 7.0.0 (-O3; closure at link). Paths are fixed (/work), and
# -ffile-prefix-map strips them from __FILE__ strings anyway.
COMMON="-O3 -ffile-prefix-map=$W/="
# Recognition-only Tesseract: keep line images as Pix (no PNG/PNM encode + decode per text line)
# and no debug bitmap fonts (bmfCreate decodes Leptonica's built-in TIFF font strings). Both are
# upstream switches; without them this codec-less build prints errors on every page.
TESSDEFS="-DTESSERACT_IMAGEDATA_AS_PIX -DTESSERACT_DISABLE_DEBUG_FONTS"

# Leptonica: core image ops + its built-in PNM reader only. No zlib/PNG/JPEG/TIFF/GIF/WebP/JP2K:
# PDFx only ever hands the engine a P5 PGM it wrote itself.
emcmake cmake -S leptonica -B leptonica/build -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="$COMMON -DMINIMUM_SEVERITY=4" -DCMAKE_INSTALL_PREFIX=$W/dep \
  -DBUILD_SHARED_LIBS=OFF -DBUILD_PROG=OFF -DSW_BUILD=OFF \
  -DENABLE_ZLIB=OFF -DENABLE_PNG=OFF -DENABLE_GIF=OFF -DENABLE_JPEG=OFF -DENABLE_TIFF=OFF \
  -DENABLE_WEBP=OFF -DENABLE_OPENJPEG=OFF
cmake --build leptonica/build -j"$JOBS"
cmake --install leptonica/build

# Tesseract: LSTM only (DISABLED_LEGACY_ENGINE, as the 7.0.0 "-lstm" cores), the SSE4.1 kernel
# family on WebAssembly SIMD128 (the "simd" core; patch 0002 replaces its int8 matrix kernel with a
# native SIMD128 one), no AVX/FMA paths, no OpenMP/TIFF/libarchive/curl/training tools.
emcmake cmake -S tesseract -B tesseract/build -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_FLAGS="$COMMON $TESSDEFS -msimd128" -DCMAKE_PREFIX_PATH=$W/dep \
  -DLeptonica_DIR=$W/dep/lib/cmake/leptonica \
  -DBUILD_SHARED_LIBS=OFF -DBUILD_TRAINING_TOOLS=OFF -DBUILD_TESTS=OFF -DGRAPHICS_DISABLED=ON \
  -DOPENMP_BUILD=OFF -DDISABLED_LEGACY_ENGINE=ON -DDISABLE_TIFF=ON -DDISABLE_ARCHIVE=ON \
  -DDISABLE_CURL=ON -DINSTALL_CONFIGS=OFF -DENABLE_LTO=OFF -DENABLE_NATIVE=OFF \
  -DENABLE_PRECOMPILED_HEADERS=OFF -DENABLE_CCACHE=OFF -DENABLE_UNITY_BUILD=OFF \
  -DHAVE_SSE4_1=ON -DHAVE_AVX=OFF -DHAVE_AVX2=OFF -DHAVE_AVX512F=OFF -DHAVE_FMA=OFF
cmake --build tesseract/build --target libtesseract -j"$JOBS"

# The JavaScript surface: glue/pdfx.idl only.
mkdir -p "$W/glue" && cd "$W/glue"
cp /pdfx/glue/pdfx.idl /pdfx/glue/wrapper.cpp .
python3 /emsdk/upstream/emscripten/tools/webidl_binder.py pdfx.idl glue
em++ $COMMON $TESSDEFS -msimd128 -std=c++17 -I"$W/dep/include/leptonica" -I"$W/dep/include" \
  -I"$W/tesseract/include" -I"$W/tesseract/build/include" -I"$W/glue" -c wrapper.cpp -o wrapper.o
em++ -O3 --closure 1 -msimd128 wrapper.o "$W/tesseract/build/libtesseract.a" \
  "$W/dep/lib/libleptonica.a" \
  -sMODULARIZE=1 -sEXPORT_NAME=TesseractCore -sENVIRONMENT=node \
  -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2147483648 \
  -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS -sEXPORTED_FUNCTIONS=_malloc,_free \
  --post-js glue.js -o tesseract-core-simd-lstm.js
mkdir -p /out
cp tesseract-core-simd-lstm.js tesseract-core-simd-lstm.wasm /out/
cd /out && sha256sum tesseract-core-simd-lstm.js tesseract-core-simd-lstm.wasm | tee SHA256SUMS.out
[ -z "${OWNER:-}" ] || chown "$OWNER" /out/tesseract-core-simd-lstm.js /out/tesseract-core-simd-lstm.wasm /out/SHA256SUMS.out
