# BYD — GitHub Updater (Ubuntu 24.04 LTS)

A standalone **Ubuntu Electron** utility (app name **BYD**), built on its own — separate from
the main project. It pulls the latest code for a local repository straight from GitHub and
then relaunches the application so the freshly pulled code loads. The app icon is the BYD
logo (`assets/logo.png` → `assets/icon.png`, a 512×512 PNG).

**Ubuntu 24.04 LTS is the only supported platform.** There is no Windows support: no `.exe`,
no NSIS installer, no `.ico` — the build produces an **AppImage** (primary) and a **.deb**
(optional), both for `x64`.

```
┌───────────────────────────────────────────────┐
│                     BYD                       │
│        Update local project directly          │
│              from GitHub                      │
│   ┌───────────────────────────────────────┐   │
│   │        [ Pull from GitHub ]           │
│   │        [      Update      ]           │
│   └───────────────────────────────────────┘   │
│      ● Latest code downloaded successfully.   │
│   ┌───────────────────────────────────────┐   │
│   │ Updating 1a2b3c4..5d6e7f8             │   │
│   │ Fast-forward                          │   │
│   └───────────────────────────────────────┘   │
│            Repository: the selected BYD repository folder                │
└───────────────────────────────────────────────┘
```

Opens maximised · resizable · native GNOME/GTK window chrome · minimal dark `#0F1115` UI with red accents · modest rounded cards · no menu bar.

---

## Install once, then only "Pull from GitHub"

The installed `BYD-1.0.0.AppImage` (or `.deb`) is a **stable bootstrap**. The interface it
shows is **not** taken from the packaged `app.asar` once a repository has been selected — it
is taken from the local clone itself:

```
<selected repository>/GitHub-Updater/renderer/   (index.html, renderer.js, style.css)
```

So the end-user workflow for every UI/code change merged on GitHub is simply:

1. Open the installed **BYD**.
2. (First time only) **Choose BYD repository folder** → select the local clone.
3. Click **Pull from GitHub** → `git pull origin main` runs.
4. As soon as the pull finishes, the window **reloads into the freshly pulled UI files**.
   No `npm`, no rebuild, no reinstall.

How it works (see `main.js`, "Repository-provided UI"):

* On start-up and after every successful pull, `GitHub-Updater/renderer` in the repository is
  validated (all three files present, `index.html` complete) and hashed.
* The files are copied into an **immutable snapshot** — `~/.config/BYD/ui-cache/<hash>/renderer`
  (`app.getPath('userData')` on Ubuntu) — written to a temp folder first and then renamed into
  place, so the window never loads a half-updated working tree. Git has already finished (the
  pull promise has resolved) before staging starts, and the hash is re-checked after copying.
* If the snapshot differs from what is on screen, the window is reloaded into it with
  `?pulled=1`, so the new page comes up already showing *Latest code downloaded successfully.*
  with **Update** enabled. If nothing changed, no reload happens.
* If the repository UI is missing or broken, the **packaged renderer** is used instead and the
  reason is printed in the console, so the app can never come up blank.
* The footer shows which interface is in use: `Interface: from repository (<hash>)` or
  `Interface: built-in v1.0.0`.

`npm install` / `npm run build` are therefore **developer-only** steps, needed only when
releasing a new bootstrap (changes to `main.js`, `preload.js` or `config.js`).

---

## Project structure

```
GitHub-Updater/
│
├── package.json          app manifest + electron-builder (Linux-only) configuration
├── main.js               Electron main process: window, git pull, relaunch
├── preload.js            contextBridge -> window.api
├── config.js             git defaults (remote/branch/expected origin) — no paths
│
├── renderer/
│   ├── index.html        two buttons in one centred card + status area
│   ├── style.css         #0F172A / #1E293B / blue / green design system
│   └── renderer.js       button logic, live status, output console
│
├── assets/
│   ├── logo.png          BYD brand wordmark (icon source)
│   └── icon.png          512×512 Linux app icon (AppImage + .deb + window icon)
│
├── build/                electron-builder buildResources (see build/README.md)
├── tools/
│   ├── make-icon.js      regenerates assets/icon.png from logo.png (ImageMagick), glyph fallback
│   └── verify-package.js asserts the payload that ships inside the AppImage/deb
└── test/                 78 automated tests (node:test + jsdom)
```

---

## Quick start (Ubuntu 24.04 LTS)

**Prerequisites (one time):**

```bash
sudo apt update
sudo apt install -y git build-essential            # git is a hard requirement of the app
# Node.js: Ubuntu 24.04 ships Node 18.19 in "universe", which works.
# Prefer an LTS from NodeSource if you want Node 22:
sudo apt install -y nodejs npm                     # or use nvm / NodeSource
node -v && npm -v && git --version
```

**Build:**

```bash
cd GitHub-Updater
npm install
npm start              # run from source (pick a repository folder first)
npm run build          # -> dist/BYD-1.0.0.AppImage  +  dist/byd-updater_1.0.0_amd64.deb
```

`npm run build` produces these artifacts in `dist/`:

| Artifact | What it is |
| --- | --- |
| `BYD-1.0.0.AppImage` | **Primary**: single self-contained executable (AppImage, x64) |
| `byd-updater_1.0.0_amd64.deb` | Optional Debian package: `/opt/BYD/byd`, menu entry, icon, `git` pulled in as a dependency |

Other commands:

```bash
npm test               # 78 tests: main process, preload bridge, renderer UI, Linux packaging
npm run verify:package # build app.asar and assert exactly what ships inside the AppImage/deb
npm run icon           # regenerate assets/icon.png from assets/logo.png (needs imagemagick)
npm run pack           # unpacked build only (dist/linux-unpacked), no AppImage/deb
npm run build:appimage # AppImage only
npm run build:deb      # .deb only
```

---

## Install & run on Ubuntu 24.04 (step by step)

### Option A — AppImage (no installation)

```bash
chmod +x BYD-1.0.0.AppImage

# AppImages use the FUSE2 runtime, which Ubuntu 24.04 does not ship by default:
sudo apt install -y libfuse2t64

./BYD-1.0.0.AppImage
```

No FUSE at all (e.g. restricted containers)? Run it extracted instead:

```bash
./BYD-1.0.0.AppImage --appimage-extract-and-run
```

Keep it tidy: put it in `~/Applications/` (create the folder if needed) and, if you want a
launcher entry, use the `.deb` instead — it registers the menu item, icon and MIME bits for you.

### Option B — Debian package (recommended for desktop integration)

```bash
sudo apt install ./byd-updater_1.0.0_amd64.deb    # also installs git + the Electron runtime libs
byd                                              # or: press Super and type "BYD"
```

Removal: `sudo apt remove byd-updater`. The installed tree is `/opt/BYD/`, the launcher is
`/usr/share/applications/byd.desktop` and the icon lands in `/usr/share/icons/hicolor/*/apps/byd.png`.

### Use it

1. Open the app → **Choose BYD repository folder** (first time only; remembered in
   `~/.config/BYD/settings.json`). The chooser is the native GTK directory picker and opens in
   your home folder — or in the already-configured repository when there is one.
2. Click **Pull from GitHub** (live git output appears; button locks while running).
3. On success the window reloads into the pulled `GitHub-Updater/renderer` files, shows the
   green `Latest code downloaded successfully.` and **Update** unlocks.
4. Click **Update** → the app relaunches (and starts `projectLaunch`, if configured). Inside an
   AppImage the relaunch re-executes the `.AppImage` file itself (`$APPIMAGE`), because the
   squashfs mount the binary lives in disappears on quit.

**Notes**

* The AppImage and .deb are unsigned. Ubuntu may refuse to run an AppImage downloaded from the
  internet until you `chmod +x` it; if Nautilus marks it untrusted, right-click → *Properties* →
  *Allow executing file as program*, or run the `chmod` above.
* If `git pull` needs a private-repo login, run `git pull` once in a normal terminal first so the
  credential is cached (`git config --global credential.helper cache`), then the updater can pull
  without prompts. The updater never shows a password prompt: `GIT_TERMINAL_PROMPT=0` and
  `SSH_ASKPASS_REQUIRE=never` make missing credentials fail fast with a visible error.
* Run as your normal user, not root: Electron/Chromium refuses its sandbox for root.

---

## Configuration — `config.js`

Git defaults only — the repository folder is **not** hardcoded anywhere. It is chosen by the
user with **Choose BYD repository folder** and saved per user in
`~/.config/BYD/settings.json` (`app.getPath('userData')`). Tests
(`no filesystem path is hardcoded outside config.js`,
`every per-user path is resolved through Electron's app.getPath()`) fail the build if a path
literal or a hand-rolled `$HOME` lookup ever appears in the sources.

```js
module.exports = {
  remote: 'origin',       // -> git pull origin main
  branch: 'main',
  expectedRepository: 'https://github.com/hp635738-pro/BYD.git', // origin must match this repo
  timeoutMs: 120000,      // abort a hung pull after 2 minutes
  gitPath: 'git',         // git binary from PATH; set an absolute path only if it lives elsewhere
  projectLaunch: null     // see "Standalone vs. self-update" below
};
```

**Packaged builds:** `config.js` lives inside `app.asar` (part of the bootstrap), so changing
it requires a new developer build. Normal UI/code changes do **not** — see
"Install once, then only Pull from GitHub" above.

---

## What the buttons do

### 1 · Pull from GitHub

Spawns the system git binary directly through `child_process.spawn` — **no shell** — in the
configured folder:

```
git pull origin main
```

* `cwd` is set to `repoPath`, so the command runs inside the repository.
* **stdout and stderr are both captured** and split into lines, streamed to the UI as they
  arrive (`git-pull:output`) — you see `Updating …`, `Fast-forward`, `remote: …` live.
* The button is **disabled while pulling** (with a spinner); a second click is ignored, and the
  main process refuses a concurrent pull as well.
* `GIT_TERMINAL_PROMPT=0` / `SSH_ASKPASS_REQUIRE=never` are set so a private repo with no cached
  credential fails fast with a visible error instead of hanging behind an invisible prompt.
* **Success** (exit code 0) → green status: `Latest code downloaded successfully.` and the
  **Update** button is enabled.
* **Failure** → red status with git's own message, and the raw stderr in the console below.
  Missing folder, non-repository folder, missing `git` (`sudo apt install git`), blank
  `repoPath` and timeouts each produce their own specific message rather than a generic failure.

### 2 · Update

Disabled until a pull succeeds. On click it calls the main process, which runs:

```js
app.relaunch();   // AppImage-aware: re-executes $APPIMAGE instead of the squashfs mount
app.quit();
```

The app exits and immediately starts again, so the newly pulled code is what loads.

#### Standalone vs. self-update

`app.relaunch()` restarts **this** updater — which is exactly what you want when the updater
is the app being updated (e.g. it lives inside the project folder it pulls).

If the updater is a standalone AppImage that updates a *different* project, set `projectLaunch`
so the updated app is started just before the updater restarts:

```js
projectLaunch: { command: '/opt/HPOS/hpos', args: [] }
// or: { command: 'npm', args: ['start'] }   (cwd defaults to the configured repository)
```

Leave it `null` for the plain relaunch behaviour.

---

## IPC map

| Layer | Name | Direction | Payload |
| --- | --- | --- | --- |
| `main.js` | `ipcMain.handle('git-pull')` | renderer → main | `PullResult` |
| `main.js` | `ipcMain.handle('restart-app')` | renderer → main | `{ ok, relaunching }` |
| `main.js` | `ipcMain.handle('app-info')` | renderer → main | version / repoPath / remote / branch / `ui: { source, hash }` |
| `main.js` | `ipcMain.handle('choose-repository')` | renderer → main | `{ ok, repoPath, reloading }` |
| `main.js` | `webContents.send('git-pull:output')` | main → renderer | `{ type: 'stdout'\|'stderr'\|'done', text }` |
| `main.js` | `webContents.send('git-pull:state')` | main → renderer | `{ type: 'state', text }` |
| `preload.js` | `window.api.pull()` / `.restart()` / `.getInfo()` / `.chooseRepository()` | — | Promise |
| `preload.js` | `window.api.onOutput(cb)` / `.onState(cb)` | — | returns `unsubscribe()` |

Hardening: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, a strict CSP
(`default-src 'none'; script-src 'self'; style-src 'self'`), all navigation and
`window.open` denied, no menu, single-instance lock.

---

## Build notes

* **Ubuntu-only pipeline** — `npm run build` is `electron-builder --linux`, targeting
  `AppImage` (x64) and `deb` (x64). There is no `win`/`nsis`/`portable` section left in
  `package.json`, no `.ico` in the repository, and no Windows code path in `main.js`.
* **Artifact names** — `appImage.artifactName` is `${productName}-${version}.${ext}`, i.e.
  `dist/BYD-1.0.0.AppImage`. The `.deb` keeps Debian's conventional
  `<name>_<version>_<arch>.deb` naming (`byd-updater_1.0.0_amd64.deb`).
* **Icons** — one PNG (`assets/icon.png`, 512×512, RGBA). electron-builder derives every hicolor
  size (16…512) from it for both the AppImage and the `.deb`, and uses it as the window icon.
  `npm run icon` regenerates it from `assets/logo.png` with ImageMagick
  (`sudo apt install imagemagick`); without ImageMagick the committed icon is left untouched.
* **Desktop integration** — `desktopName: "byd.desktop"` + `linux.syncDesktopName: true` +
  `linux.executableName: "byd"` make the `.desktop` file, `StartupWMClass` and Electron's
  `app_id`/WM_CLASS agree, so GNOME's dock groups the running window with the launcher icon.
* **deb dependencies** — the `.deb` declares `git` plus the standard Electron runtime libraries
  (`libgtk-3-0`, `libnss3`, …), so `sudo apt install ./byd-updater_*.deb` pulls everything in.
* **AppImage on 24.04** — AppImages link against FUSE2; Ubuntu 24.04 ships FUSE3 only, hence the
  one-time `sudo apt install libfuse2t64` (or use `--appimage-extract-and-run`).
* **No wine, no signing tools** — Linux packaging needs nothing beyond what `npm install`
  brings; `fpm`, `mksquashfs` and the AppImage runtime are fetched by electron-builder itself.
* The app has **zero runtime dependencies** — `dependencies` is empty; everything else is a
  devDependency, so `app.asar` stays ~82 KB (app code + BYD logo icon).

### Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `dlopen(): error loading libfuse.so.2` when starting the AppImage | Ubuntu 24.04 lacks FUSE2: `sudo apt install libfuse2t64` (or run with `--appimage-extract-and-run`) |
| `Folder not found: the selected BYD repository folder` | no repository has been selected yet; choose the local BYD clone |
| `Not a Git repository: …` | the folder exists but has no `.git` |
| `Git was not found.` | `sudo apt install git`, ensure `git` is on `PATH` |
| `Authentication failed` | run `git pull` once in a terminal so the credential helper caches a token |
| `fatal: couldn't find remote ref main` | the branch name in `config.js` does not exist on the remote |
| AppImage will not start as root | run it as a normal user (Chromium sandbox refuses root) |
| Window not grouped under the dock icon | launch via `byd.desktop` / the installed binary `byd`, so WM_CLASS matches `StartupWMClass` |

---

## Verification status

What was actually executed against this code (`npm test`, 78 tests, all passing):

* **Real `git pull` against a real repository on Linux.** A throwaway bare remote + local clone
  is created, a commit is pushed to `origin/main`, then `main.js`'s `runGitPull()` is called.
  The test asserts exit code 0, the success message, captured stdout, streamed live events —
  and that the pulled file actually appears on disk.
* **The git command itself.** `buildGitInvocation()` is asserted to spawn `git` directly with
  `['pull', 'origin', 'main']` — no shell, no `cmd.exe`; `buildSpawnOptions()` is asserted to
  run it with `cwd` = the repository and no Windows-only spawn flags; the configured binary is
  executed for real (`git --version`).
* Failure paths exercised for real: unreachable remote (non-zero exit + stderr), missing
  folder, non-repository folder, blank `repoPath`, concurrent pull, and a hung pull aborted
  by the timeout.
* **The repository picker, end to end:** a stubbed GTK directory chooser (same
  `dialog.showOpenDialog` contract Electron uses on Ubuntu) returns a real fixture clone; the
  test asserts the chooser is directory-only, opens in `$HOME` (or in the saved repository once
  configured), and that the selection is persisted through `app.getPath('userData')` and used
  by the next pull. Cancelling, non-repo folders and wrong-remote clones are all rejected.
* **AppImage-aware relaunch:** with `$APPIMAGE` set, `Update` relaunches the `.AppImage` file;
  without it, the plain `app.relaunch()` path is used.
* The **real `preload.js`** is loaded against a stubbed `electron`: the exact channels it
  invokes are compared with the channel names `main.js` registers.
* The **real `renderer.js`** is evaluated in a jsdom DOM built from the real `index.html`:
  button enable/disable rules, the exact success string, green/red status classes, live
  output rendering, double-click guarding, restart locking.
* `createWindow()` is asserted to produce a resizable, maximizable, centred, `#0F1115`,
  menu-less, context-isolated window with the PNG icon.
* **Repository-provided UI, end to end:** a renderer with one `style.css` is pushed to the
  fixture remote, the app pulls it, and the test asserts the window was reloaded into a
  `ui-cache/<hash>/renderer/index.html` snapshot with `?pulled=1`. Then a *different*
  `style.css` is pushed, "Pull from GitHub" is invoked again, and the test asserts the new CSS
  is what the window now loads, the old snapshot is pruned, and no temp folders are left.
  A pull with no changes triggers no reload; a broken repository UI falls back to the packaged
  renderer.
* **Packaging:** `npm run verify:package` packs the `build.files` set into an `app.asar` with
  the same `@electron/asar` library electron-builder uses and confirms every runtime file is
  inside and dev-only material (including any `.ico`) is not.
* **The Linux build config is validated by electron-builder itself:** the test suite compiles
  `package.json → build` against electron-builder's own JSON schema (`app-builder-lib/scheme.json`
  via `ajv`), and asserts the target list is exactly `AppImage` + `deb` (x64), the icon is an
  RGBA PNG ≥ 256×256 (512×512 shipped), `appImage.artifactName` expands to
  `BYD-<version>.AppImage`, and no `win`/`nsis`/`portable` key survives. Running
  `npx electron-builder --linux AppImage` loads the same config without a single warning and
  proceeds into `packaging platform=linux arch=x64`.

**Not verified here:** the final `BYD-1.0.0.AppImage` / `.deb` were **not** produced. The build
got through config loading, dependency rebuild and into packaging, then failed downloading the
Electron runtime from `https://github.com/electron/electron/releases/...` — the GitHub release
CDN (`release-assets.githubusercontent.com`) is not reachable from this sandbox, and neither is
any Electron mirror. Producing the two artifacts therefore needs one run on a machine with
normal internet access (any Ubuntu 24.04 x64 box):

```bash
sudo apt install -y git
npm install
npm run build      # -> dist/BYD-1.0.0.AppImage + dist/byd-updater_1.0.0_amd64.deb
```
