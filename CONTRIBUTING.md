# Contributing to PDFx

Thanks for contributing! PDFx is a lightweight Electron desktop app for viewing and
editing backwards-compatible multi-document PDFX files. This guide covers the local
workflow and the repository's PR rules.

## Prerequisites

- **Node 24** (the version CI runs). Use `nvm`/`fnm`/`volta` to match it.
- **Yarn Classic (v1)** — this repo uses a `yarn.lock` v1 lockfile. Do **not** run
  `corepack enable` or migrate to Yarn Berry without a separate, deliberate change.
- Platform build toolchains are only needed if you intend to package installers
  (`electron-builder`). On macOS the native vibrancy addon is compiled; on Windows
  and Linux it cleanly no-ops, so a plain `yarn install` works everywhere. Linux
  packaging prerequisites and the `.deb`/`.rpm` sandbox-helper setup are in
  [docs/LINUX_SETUP.md](docs/LINUX_SETUP.md).
- Electron and electron-builder binaries download from their default upstream. Do not
  commit an `.npmrc` mirror override; set `ELECTRON_MIRROR` in your own environment if
  you need one.

## Install

```sh
yarn install --frozen-lockfile
```

## Day-to-day commands

| Task                       | Command                                        |
| -------------------------- | ---------------------------------------------- |
| Run the app (watch mode)   | `yarn dev`                                     |
| Typecheck (node + web)     | `yarn typecheck`                               |
| Format code                | `yarn format`                                  |
| Check formatting (CI gate) | `yarn format:check`                            |
| Run tests (watch)          | `yarn test`                                    |
| Run tests once (CI gate)   | `yarn test:run`                                |
| Run tests with coverage    | `yarn test:coverage`                           |
| Build app bundle           | `yarn build`                                   |
| Package for current OS     | `yarn build:mac` / `build:win` / `build:linux` |

## Tests

Tests use [Vitest](https://vitest.dev). The suite is split into three projects in
`vitest.config.mts`:

- a **node** project for pure logic (PDFX manifest build, format partitioning,
  doc-ops reducers, name de-duplication, main-process file intake) — files named
  `*.node.test.ts`;
- a **jsdom** project for DOM/browser-dependent code — files named `*.dom.test.ts`;
- an **ocr** project that runs the real OCR engine (the same Tesseract WebAssembly core and
  language data the app ships) on synthetic scans — files named `*.ocr.test.ts`. Run it alone
  with `yarn test:ocr`. Every live recognition must match its recorded replay entry
  (`src/shared/ocr/test-utils/ocr-cache/`); `PDFX_OCR_CACHE_STRICT=1` (what CI sets) fails on any
  mismatch, and `yarn ocr:record` re-records after a deliberate engine or pipeline change.

The OCR engine itself (Tesseract and Leptonica compiled to WebAssembly) is built by PDFx from
pinned upstream sources: see [`build/ocr-core/README.md`](build/ocr-core/README.md) for how to
rebuild it reproducibly, what is pinned, and how to bump it for a Tesseract security release. CI's
`OCR core build` workflow fails unless the vendored `vendor/tesseract-core/` files are exactly
what those sources build.

OCR maintenance scripts (none of them runs in the app):

- `yarn ocr:record` rewrites the replay cache and the packaged self-test's expected result.
- `yarn ocr:calibrate` refits the confidence calibration
  (`src/shared/ocr/calibration/tess-simd.json`) from the synthetic sweep.
- `yarn ocr:lang-catalogue` regenerates `src/main/ocr/lang-manifest.json`, the compiled catalogue
  of downloadable languages: for each one it checks the npm tarball of `@tesseract.js-data/<code>`
  against the registry's integrity hash, records the size and SHA-256 of the `.traineddata.gz`
  and of the unpacked `.traineddata`, and checks that cdn.jsdelivr.net serves the same bytes.
  `--check` fails if the committed file differs. The app never fetches the catalogue; every hash
  it trusts for a downloaded or installed language file comes from this reviewed, committed file.
  Right-to-left languages are left out on purpose until the text layer supports them.

Place a test next to the code it covers (e.g. `src/renderer/src/pdfx/build.node.test.ts`).
The `@renderer` alias resolves the same way it does in the app, so you can import
renderer modules with either a relative path or `@renderer/...`.

Run the full suite once with `yarn test:run` — this is exactly what CI runs.

## Branching

Branch off the latest `main`. Name branches `type/short-description`, using the same
types as Conventional Commits:

```
feat/png-stamp-overlay
fix/manifest-page-count
chore/ci-matrix
docs/contributing-guide
test/file-intake-guards
refactor/edit-model
```

## Commits and PR titles

Individual commits can be informal — they will be squashed. What matters is the
**PR title**, which becomes the final commit subject. Write it as a
[Conventional Commit](https://www.conventionalcommits.org/):

```
feat(redaction): add PDFium-backed true redaction pipeline
fix(format): clamp partition page counts to total pages
```

Fill out the PR template, keep PRs focused, and call out anything that needs a
follow-up.

## Merge policy: squash only

This repository is configured for **squash merge only** — merge commits and rebase
merges are disabled, and the source branch is deleted automatically on merge. CI
must be green before merging. Each PR therefore lands as exactly one commit on
`main`, named from your PR title and body.

## CI

Every push to `main` and every PR runs `.github/workflows/ci.yml`:

1. **Lint, typecheck, test** on Ubuntu — `yarn typecheck`, `yarn format:check`, the node and
   jsdom projects (`yarn test:run --project node --project jsdom`), then the ocr project
   (`yarn test:ocr`), both with `PDFX_OCR_CACHE_STRICT=1`. Locally, `yarn test:run` runs all
   three projects.
2. **Build** matrix on macOS, Windows, and Ubuntu — packages the app with
   code-signing disabled so forks build without secrets, then:
   - runs the packaged app's OCR self-test (`pdfx --ocr-selftest out.json`, via
     `scripts/ocr-selftest-run.mjs`): a scanned page recognized exactly as recorded, every
     network tripwire at 0, nothing printed by the engine, a crashed OCR process detected and
     restarted, and the Recognize Text shortcut pressed on a hidden app window, which must make
     the main process send the Recognize Text action to the renderer exactly once (Cmd+Shift+R on
     macOS, Ctrl+Shift+R on Windows and Linux; required on all three, never skipped; the send is
     counted, not delivered, so nothing starts recognizing), with the Document menu's **Recognize
     Text…** item showing that shortcut. On Ubuntu it runs twice, the second time with no network
     at all (`unshare --net`);
   - on Windows, checks the installer grew by at most 15 MB over v1.1.3 (`scripts/ocr-nsis-size.mjs`);
   - runs the `ocr` project again and uploads what it recognized.
3. **OCR cross-OS diff** — compares the three OSes' recognized text, word boxes, engine output and
   input pixels, and fails on any difference, or if an OS produced fewer records than
   `--min-cases` in `ci.yml` (`scripts/ocr-xos-diff.mjs`). Lower that number only in a change
   that removes tier-1 cases.

The build job depends on the check job, so lint/typecheck/test failures stop the
matrix early.

Which checks block a merge is set by `main`'s branch protection, which matches checks by job
name. It requires **Lint, typecheck, test**. Until a maintainer also adds **Build (macos-latest)**,
**Build (windows-latest)**, **Build (ubuntu-latest)** and **OCR cross-OS diff** there, GitHub
shows a PR as mergeable without them, so check them by hand: a red packaged self-test, size gate
or cross-OS diff blocks the merge all the same. (`OCR cross-OS diff` runs even when a build
failed, because GitHub counts a skipped required check as passing.)

`.github/workflows/ocr-bench.yml` runs the slower OCR bench nightly, on demand, and on pull
requests labelled `ocr`: the seeds × presets × fonts sweep, the calibration check, per-page timing
on all three OSes (on Windows it fails if a full Letter page of 10 pt text takes more than 6 s, or
one filled with 6 pt text more than 16 s), and the 1,000-page and 1.5 GiB scale tests. It never
blocks a merge. Scheduled runs start only from the default branch.
