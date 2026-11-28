#!/usr/bin/env bash
# Rebuild PDFx's Tesseract WebAssembly core from pinned upstream sources (see README.md here).
#
#   bash build/ocr-core/build.sh [--out DIR] [--verify DIR]
#
# 1. Downloads the Tesseract and Leptonica source archives named in versions.env into a fresh
#    directory; the Leptonica release asset must match its SHA-256, the Tesseract archive must carry
#    the pinned commit id (its SHA-256 is advisory: GitHub generates it on the fly).
# 2. Runs inner.sh in the emscripten/emsdk image pinned BY DIGEST, with --network none and the
#    archives and this directory mounted read-only. inner.sh refuses either source tree unless its
#    content hash equals the pin.
# 3. Prints the SHA-256 of tesseract-core-simd-lstm.{js,wasm}; with --verify DIR, exits 1 unless
#    they equal EXPECTED.sha256 and DIR's copies (CI: DIR = vendor/tesseract-core/5.5.5).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=versions.env
source "$HERE/versions.env"
OUT="" VERIFY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT=$2; shift 2 ;;
    --verify) VERIFY=$2; shift 2 ;;
    *) echo "usage: $0 [--out DIR] [--verify DIR]" >&2; exit 2 ;;
  esac
done
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
OUT=${OUT:-$WORK/out}
mkdir -p "$WORK/in" "$OUT"

sha() { sha256sum "$1" | cut -d' ' -f1; }
curl -fsSL --retry 3 -o "$WORK/in/tesseract.tar.gz" "$TESSERACT_URL"
[ "$(gzip -dc "$WORK/in/tesseract.tar.gz" | git get-tar-commit-id)" = "$TESSERACT_COMMIT" ] ||
  { echo "tesseract: the archive is not commit $TESSERACT_COMMIT" >&2; exit 1; }
if [ "$(sha "$WORK/in/tesseract.tar.gz")" != "$TESSERACT_SHA256" ]; then
  # Diagnosable rather than silent: the tree hash inside the container still decides.
  echo "::warning::tesseract: archive SHA-256 $(sha "$WORK/in/tesseract.tar.gz") differs from the pin" \
    "(GitHub recompressed it?); the content hash is checked next" >&2
fi
curl -fsSL --retry 3 -o "$WORK/in/leptonica.tar.gz" "$LEPTONICA_URL"
[ "$(sha "$WORK/in/leptonica.tar.gz")" = "$LEPTONICA_SHA256" ] ||
  { echo "leptonica: SHA-256 mismatch" >&2; exit 1; }

# Docker Desktop on Windows (Git Bash) needs Windows paths and no MSYS path mangling.
p() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else echo "$1"; fi; }
# The container runs as root (the image's Emscripten cache is root's); on Linux it hands the output
# back to the calling user so the cleanup above (and the CI checkout) can remove it.
OWNER=""
[ "$(uname -s)" = Linux ] && OWNER="$(id -u):$(id -g)"
MSYS_NO_PATHCONV=1 docker run --rm --network none --platform linux/amd64 \
  -e SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" -e OWNER="$OWNER" \
  -e TESSERACT_TREE_SHA256="$TESSERACT_TREE_SHA256" -e LEPTONICA_TREE_SHA256="$LEPTONICA_TREE_SHA256" \
  -v "$(p "$WORK/in"):/in:ro" -v "$(p "$HERE"):/pdfx:ro" -v "$(p "$OUT"):/out" \
  "$EMSDK_IMAGE" bash /pdfx/inner.sh

if [ -n "$VERIFY" ]; then
  (cd "$OUT" && sha256sum -c "$HERE/EXPECTED.sha256")
  for f in tesseract-core-simd-lstm.js tesseract-core-simd-lstm.wasm; do
    cmp "$OUT/$f" "$VERIFY/$f" || { echo "$f differs from $VERIFY/$f" >&2; exit 1; }
  done
  echo "reproduced: the vendored core is exactly what these pinned sources build"
fi
