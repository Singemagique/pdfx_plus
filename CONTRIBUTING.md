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
  and Linux it cleanly no-ops, so a plain `yarn install` works everywhere.

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

Tests use [Vitest](https://vitest.dev). The suite is split into two projects in
`vitest.config.mts`:

- a **node** project for pure logic (PDFX manifest build, format partitioning,
  doc-ops reducers, name de-duplication, main-process file intake) — files named
  `*.node.test.ts`;
- a **jsdom** project for DOM/browser-dependent code — files named `*.dom.test.ts`.

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

1. **Lint, typecheck, test** on Ubuntu — `yarn typecheck`, `yarn format:check`,
   `yarn test:run`.
2. **Build** matrix on macOS, Windows, and Ubuntu — packages the app with
   code-signing disabled so forks build without secrets.

The build job depends on the check job, so lint/typecheck/test failures stop the
matrix early.
