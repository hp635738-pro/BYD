# build/

This is electron-builder's `buildResources` directory (see `directories.buildResources`
in `package.json`).

## Entitlements — not required for the Windows target

`entitlements.plist` / `entitlements.mac.plist` are **macOS-only** artifacts used for
code signing and the hardened runtime. The GitHub Updater ships as a Windows `.exe`,
so no entitlements file is needed and none is referenced by the build config.

If the app is ever built for macOS, add them here and wire them up like this:

```jsonc
// package.json → build.mac
{
  "mac": {
    "entitlements": "build/entitlements.mac.plist",
    "entitlementsInherit": "build/entitlements.mac.plist",
    "hardenedRuntime": true,
    "gatekeeperAssess": false
  }
}
```

## What electron-builder does look for here

- `icon.ico` / `icon.png` — optional; `build.win.icon` already points at `assets/icon.ico`.
- `installer.nsh` — optional NSIS include for a custom installer header/footer.
- `installerIcon.ico`, `uninstallerIcon.ico` — optional installer chrome.

Everything in this folder is build-time only; it is **not** shipped inside the app
(`package.json → build.files` lists exactly what gets packaged).
