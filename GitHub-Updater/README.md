# BYD — GitHub Updater

A standalone **Windows Electron** utility (app name **BYD**), built on its own — separate from
the main project. It pulls the latest code for a local repository straight from GitHub and
then relaunches the application so the freshly pulled code loads. The app icon is the BYD
logo (`assets/logo.png` → `assets/icon.ico`).

```
┌───────────────────────────────────────────────┐
│                     BYD                       │
│        Update local project directly          │
│              from GitHub                      │
│   ┌───────────────────────────────────────┐   │
│   │        [ Pull from GitHub ]           │   │
│   │        [      Update      ]           │   │
│   └───────────────────────────────────────┘   │
│      ● Latest code downloaded successfully.   │
│   ┌───────────────────────────────────────┐   │
│   │ Updating 1a2b3c4..5d6e7f8             │   │
│   │ Fast-forward                          │   │
│   └───────────────────────────────────────┘   │
│            Repository: the selected BYD repository folder                │
└───────────────────────────────────────────────┘
```

Opens maximised · resizable · normal Windows controls · minimal dark `#0F1115` UI with red accents · modest rounded cards · no menu bar.

---

## Install once, then only "Pull from GitHub"

The installed `BYD.exe` is a **stable bootstrap**. The interface it shows is **not** taken from
the packaged `app.asar` once a repository has been selected — it is taken from the local
clone itself:

```
<selected repository>\GitHub-Updater\renderer\   (index.html, renderer.js, style.css)
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
* The files are copied into an **immutable snapshot** — `%APPDATA%\BYD\ui-cache\<hash>\renderer`
  — written to a temp folder first and then renamed into place, so the window never loads a
  half-updated working tree. Git has already finished (the pull promise has resolved) before
  staging starts, and the hash is re-checked after copying.
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
├── package.json          app manifest + electron-builder configuration
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
│   ├── icon.ico          multi-size (16-256 px) Windows icon built from logo.png
│   └── icon.png          256 px reference render
│
├── build/                electron-builder buildResources (see build/README.md)
├── tools/
│   ├── make-icon.js      regenerates assets/icon.ico from logo.png (ImageMagick), glyph fallback
│   └── verify-package.js asserts the payload that ships inside the .exe
└── test/                 65 automated tests (node:test + jsdom)
```

---

## Quick start (Windows)

```bash
cd GitHub-Updater
npm install
npm start          # run from source (needs the repoPath below to exist)
npm run build      # -> dist\BYD-1.0.0-Setup.exe  (+ BYD-1.0.0-Portable.exe)
```

`npm run build` produces two artifacts in `dist/`:

| Artifact | What it is |
| --- | --- |
| `BYD-1.0.0-Setup.exe` | NSIS installer (desktop + start-menu shortcuts, choose install dir) |
| `BYD-1.0.0-Portable.exe` | **single self-contained .exe** — run it from anywhere, nothing installed |

Both embed the app in `app.asar` and carry the BYD `assets/icon.ico` as the executable icon.

Other commands:

```bash
npm test               # 65 tests: main process, preload bridge, renderer UI, packaging
npm run verify:package # build app.asar and assert exactly what ships inside the .exe
npm run icon           # regenerate assets/icon.ico from assets/logo.png (ImageMagick)
npm run pack           # unpacked build only (dist/win-unpacked), no installer
```

---

## How to set up the .exe (step by step)

**Prerequisites (one time):** install [Node.js LTS](https://nodejs.org) (18+) and
[Git for Windows](https://git-scm.com/download/win). Verify with `node -v`, `npm -v`, `git --version`.

**A. Build the .exe**

1. Open a terminal in the `GitHub-Updater` folder.
2. `npm install`
3. Use “Choose BYD repository folder” to select the local clone
   (e.g. `C:\\HPOS`). **Do this before building** — the selection is saved per Windows user.
4. `npm run build`
5. Find the outputs in `dist\`:
   `BYD-1.0.0-Setup.exe` (installer) and `BYD-1.0.0-Portable.exe` (single file).

**B. Install / run it**

*Option 1 — Portable (simplest):* copy `BYD-1.0.0-Portable.exe` anywhere (desktop, USB) and
double-click. Nothing is installed; it just runs.

*Option 2 — Installer:* double-click `BYD-1.0.0-Setup.exe`, choose the install folder, finish.
It creates a desktop + start-menu shortcut named **BYD**. Launch from the shortcut.

**C. Use it**

1. Open the app → **Choose BYD repository folder** (first time only; it is remembered).
2. Click **Pull from GitHub** (live git output appears; button locks while running).
3. On success the window reloads into the pulled `GitHub-Updater/renderer` files, shows the
   green `Latest code downloaded successfully.` and **Update** unlocks.
4. Click **Update** → the app relaunches (and starts `projectLaunch`, if configured).

**Notes**

* The .exe is unsigned, so Windows SmartScreen may say "Unknown publisher".
  Click **More info → Run anyway**. (Sign it later by adding `win.certificateFile` in package.json.)
* If `git pull` needs a private-repo login, run `git pull` once in a normal terminal first so the
  credential is cached, then the updater can pull without prompts.

---

## Configuration — `config.js`

Git defaults only — the repository folder is **not** hardcoded anywhere. It is chosen by the
user with **Choose BYD repository folder** and saved per Windows user in
`%APPDATA%\BYD\settings.json`. A test (`no filesystem path is hardcoded outside config.js`)
fails the build if a path literal ever appears in the sources.

```js
module.exports = {
  remote: 'origin',       // -> git pull origin main
  branch: 'main',
  expectedRepository: 'https://github.com/hp635738-pro/BYD.git', // origin must match this repo
  timeoutMs: 120000,      // abort a hung pull after 2 minutes
  projectLaunch: null     // see "Standalone vs. self-update" below
};
```

**Packaged builds:** `config.js` lives inside `app.asar` (part of the bootstrap), so changing
it requires a new developer build. Normal UI/code changes do **not** — see
"Install once, then only Pull from GitHub" above.

---

## What the buttons do

### 1 · Pull from GitHub

Runs the pull through **Windows CMD** via `child_process.spawn`, in the configured folder:

```
cmd.exe /d /s /c git pull origin main
```

* `cwd` is set to `repoPath`, so the command runs inside the repository.
* **stdout and stderr are both captured** and split into lines, streamed to the UI as they
  arrive (`git-pull:output`) — you see `Updating …`, `Fast-forward`, `remote: …` live.
* The button is **disabled while pulling** (with a spinner); a second click is ignored, and
  the main process refuses a concurrent pull as well.
* `GIT_TERMINAL_PROMPT=0` / `GCM_INTERACTIVE=never` are set so a private repo with no cached
  credential fails fast with a visible error instead of hanging behind an invisible prompt.
* **Success** (exit code 0) → green status: `Latest code downloaded successfully.` and the
  **Update** button is enabled.
* **Failure** → red status with git's own message, and the raw stderr in the console below.
  Missing folder, non-repository folder, missing `git`, blank `repoPath` and timeouts each
  produce their own specific message rather than a generic failure.

### 2 · Update

Disabled until a pull succeeds. On click it calls the main process, which runs:

```js
app.relaunch();
app.quit();
```

The app exits and immediately starts again, so the newly pulled code is what loads.

#### Standalone vs. self-update

`app.relaunch()` restarts **this** updater — which is exactly what you want when the updater
is the app being updated (e.g. it lives inside the project folder it pulls).

If the updater is a standalone `.exe` that updates a *different* project, set `projectLaunch`
so the updated app is started just before the updater restarts:

```js
projectLaunch: { command: 'C:\\HPOS\\HPOS.exe', args: [] }
// or: { command: 'cmd.exe', args: ['/c', 'start', 'npm', 'start'] }
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

* **Building on Windows** — nothing extra is needed. `npm install && npm run build`.
* **Building on Linux/macOS** — the `nsis` target extracts an uninstaller by executing the
  generated installer, which needs **wine** on a non-Windows host
  (`app-builder-lib/out/vm/WineVm.js` falls back to `exec()` directly when
  `process.platform === 'win32'`). The `portable` target and `npm run pack` work without it.
* Electron-builder 26 stamps the icon and version info with the pure-JS `resedit` package,
  so **no wine is needed for the icon/metadata step**.
* The app has **zero runtime dependencies** — `dependencies` is empty; everything else is a
  devDependency, so `app.asar` stays ~77 KB (app code + BYD logo icon).

### Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Folder not found: the selected BYD repository folder` | no repository has been selected yet; choose the local BYD clone |
| `Not a Git repository: …` | the folder exists but has no `.git` |
| `Git was not found.` | install Git for Windows, ensure `git` is on `PATH` |
| `Authentication failed` | run `git pull` once in a terminal so the credential helper caches a token |
| `fatal: couldn't find remote ref main` | the branch name in `config.js` does not exist on the remote |

---

## Verification status

What was actually executed against this code (`npm test`, 65 tests, all passing):

* **Real `git pull` against a real repository.** A throwaway bare remote + local clone is
  created, a commit is pushed to `origin/main`, then `main.js`'s `runGitPull()` is called.
  The test asserts exit code 0, the success message, captured stdout, streamed live events —
  and that the pulled file actually appears on disk.
* Failure paths exercised for real: unreachable remote (non-zero exit + stderr), missing
  folder, non-repository folder, blank `repoPath`, concurrent pull, and a hung pull aborted
  by the timeout.
* `cmd.exe /d /s /c git pull origin main` is asserted by running `buildGitInvocation()` with
  `process.platform` forced to `win32`. Off Windows the same function invokes `git` directly,
  which is what lets the identical code path run in CI.
* The **real `preload.js`** is loaded against a stubbed `electron`: the exact channels it
  invokes are compared with the channel names `main.js` registers.
* The **real `renderer.js`** is evaluated in a jsdom DOM built from the real `index.html`:
  button enable/disable rules, the exact success string, green/red status classes, live
  output rendering, double-click guarding, restart locking.
* `createWindow()` is asserted to produce a resizable, maximizable, centred, `#0F1115`,
  menu-less, context-isolated window.
* **Repository-provided UI, end to end:** a renderer with one `style.css` is pushed to the
  fixture remote, the app pulls it, and the test asserts the window was reloaded into a
  `ui-cache/<hash>/renderer/index.html` snapshot with `?pulled=1`. Then a *different*
  `style.css` is pushed, "Pull from GitHub" is invoked again, and the test asserts the new CSS
  is what the window now loads, the old snapshot is pruned, and no temp folders are left.
  A pull with no changes triggers no reload; a broken repository UI falls back to the packaged
  renderer.
* Packaging: `npm run verify:package` packs the `build.files` set into an `app.asar` with the
  same `@electron/asar` library electron-builder uses and confirms every runtime file is
  inside, dev-only material is not, and `main.js` is byte-identical. The `.ico` is parsed by
  `resedit` — the same library electron-builder 26 uses to stamp the icon into the `.exe`.

**Not verified here:** the final `.exe` was **not** produced. `npm run build` was run and got
through config loading, dependency rebuild and into packaging, then failed downloading
`https://github.com/electron/electron/releases/download/v38.8.6/electron-v38.8.6-win32-x64.zip`
— that URL redirects to `objects.githubusercontent.com`, which is not reachable from this
sandbox (nor is any Electron mirror). The Windows runtime download, NSIS packaging and the
resulting installer therefore still need one run on a machine with normal internet access:

```bash
npm install
npm run build
```
