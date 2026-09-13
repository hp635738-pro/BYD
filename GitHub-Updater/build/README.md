# build/

This is electron-builder's `buildResources` directory (see `directories.buildResources`
in `package.json`). The app ships for **Ubuntu 24.04 LTS only**, so everything here is
Linux-oriented.

## Icons

The Linux icon is configured explicitly:

```jsonc
// package.json → build.linux
{
  "icon": "assets/icon.png",   // 512x512 RGBA PNG, the BYD wordmark on a dark card
  "executableName": "byd",
  "syncDesktopName": true
}
```

electron-builder derives the full hicolor set (16/24/32/48/64/128/256/512) from that single
PNG for both the `.deb` (`/usr/share/icons/hicolor/<size>/apps/byd.png`) and the AppImage, and
uses it as the window icon. A directory of pre-sized PNGs (`build/icons/`) is *not* needed —
but if it ever exists here it would act as the fallback source, so keep it absent on purpose.

There is **no `.ico` anywhere**: the Windows icon, NSIS installer chrome
(`installerIcon.ico`, `installer.nsh`, …) and macOS entitlements
(`entitlements.mac.plist`) are all gone with the Windows/macOS targets.

## What electron-builder looks for here on Linux

- `icon.png` / `icon.icns` / `icons/*.png` — fallback icon sources (we point at
  `assets/icon.png` explicitly instead).
- `license.txt` / `eula.txt` — optional; would be packed into the AppImage (`appImage.license`).
- `afterInstall` / `afterRemove` scripts — optional maintainer scripts for the `.deb`
  (referenced from `deb.afterInstall` / `deb.afterRemove`); none are needed today because
  apt handles the dependencies and the desktop/icon registration.

Everything in this folder is build-time only; it is **not** shipped inside the app
(`package.json → build.files` lists exactly what gets packaged).

## Regenerating the icon

```bash
sudo apt install -y imagemagick   # only to rebuild from the brand logo
npm run icon                      # assets/logo.png -> assets/icon.png (512x512)
```

Without ImageMagick `tools/make-icon.js` refuses to touch the committed brand icon and
instead only rebuilds it from its built-in glyph when `assets/logo.png` is absent.
