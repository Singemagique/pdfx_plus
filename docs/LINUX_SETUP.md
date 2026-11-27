# Linux setup

PDFx runs on Linux with the same main/renderer code as Windows and macOS. The macOS
window backdrop is macOS-only; on Linux the window uses the solid fallback background
and everything else is identical.

## Building

```sh
yarn build:linux   # AppImage + .deb + .rpm into dist/
```

Prerequisites:

- **Node / Yarn**: as in [CONTRIBUTING.md](../CONTRIBUTING.md).
- **AppImage**: needs FUSE 2 at run time (`libfuse2t64` on Ubuntu 24.04+, `libfuse2` before).
- **.rpm**: `rpmbuild` on `PATH` (the `rpm` package on Debian/Ubuntu). electron-builder
  downloads its own `fpm`.

CI's Linux job installs exactly `rpm libfuse2t64` on `ubuntu-latest` before running
`yarn build:linux --publish never`.

Electron and the electron-builder helper binaries download from their default upstream
(GitHub releases). The repository deliberately has no `.npmrc` mirror override; if you
need a mirror locally, set `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` in your
own environment rather than committing one.

## Packaging notes

- **Chromium sandbox helper (`build/linux/after-install.tpl`)** — the `.deb`/`.rpm`
  post-install forces `/opt/PDFx/chrome-sandbox` to `root:root` mode `4755`.
  electron-builder's stock template only does this when the _install-time_ user (root,
  running `apt`/`dnf`) cannot create a user namespace. On hosts that restrict
  _unprivileged_ user namespaces (Ubuntu 24.04+ via AppArmor, and hardened kernels with
  `kernel.unprivileged_userns_clone=0`) that probe passes as root but fails for the
  ordinary user who later launches the app, so the helper is left at `0755` and Electron
  aborts at startup with "The SUID sandbox helper binary ... is not configured correctly":
  the package installs but no window ever appears. Setting `4755` unconditionally is the
  standard Chromium arrangement and is safe — Chromium prefers the user-namespace sandbox
  when it is available and only falls back to the setuid helper otherwise. `chown` runs
  before `chmod` because changing the owner clears the setuid bit. Apart from that block
  the template is identical to electron-builder 25's stock `after-install.tpl`, so
  re-diff it when upgrading electron-builder.

- **AppImage and the sandbox** — an AppImage is a read-only mount, so the setuid helper
  cannot be fixed up at install time. On hosts that restrict unprivileged user namespaces,
  install the `.deb`/`.rpm` instead (which handle the helper), or run the AppImage with
  `--no-sandbox` only if you accept running without Chromium's sandbox.

- **`.pdfx` file association** — `fileAssociations[].mimeType: application/x-pdfx` drives
  the generated `.desktop` `MimeType` and the shared-mime XML. It is inert on
  Windows/macOS.

- **`linux.description` is a single line** — electron-builder reuses it as the `.desktop`
  `Comment`, and a Desktop Entry value must not wrap.
