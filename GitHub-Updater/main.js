'use strict';

/**
 * ============================================================================
 *  BYD — main (Electron) process — Ubuntu 24.04 LTS
 * ============================================================================
 *  Responsibilities:
 *    - createWindow()                  -> the single 520x420 dark window
 *    - ipcMain.handle('git-pull')      -> runs `git pull <remote> <branch>`
 *                                         with the system `git` binary and
 *                                         streams live output to the renderer
 *    - ipcMain.handle('restart-app')   -> app.relaunch() + app.quit()
 *                                         (AppImage-aware, see relaunchApp())
 *    - repository-provided UI          -> after "Pull from GitHub" the window
 *                                         reloads <repo>/GitHub-Updater/renderer
 *                                         (via an atomic snapshot), so UI/code
 *                                         updates merged on GitHub appear
 *                                         without rebuilding or reinstalling
 *                                         the installed BYD AppImage
 *
 *  All paths come from ./config.js or from Electron's app.getPath() — nothing
 *  is hardcoded, and every path is built with `path.join()`/`path.resolve()`
 *  so it is a plain POSIX path on Ubuntu (XDG: ~/.config/BYD, ~/.cache/BYD).
 * ============================================================================
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');

const config = require('./config');
const pkg = require('./package.json');

/* ------------------------------------------------------------------ *
 *  Window / UI constants (spec: 520x420, non-resizable, centred)
 * ------------------------------------------------------------------ */
const WINDOW_WIDTH = 1100;
const WINDOW_HEIGHT = 760;
const BACKGROUND_COLOR = '#0B0C0F';
const APP_TITLE = 'BYD';
const RELAUNCH_DELAY_MS = 150; // let the IPC reply reach the renderer first

/** IPC channel names — preload.js mirrors these. */
const IPC = Object.freeze({
  pull: 'git-pull',
  restart: 'restart-app',
  info: 'app-info',
  pullOutput: 'git-pull:output',
  pullState: 'git-pull:state'
});

let mainWindow = null;
let activePull = null; // guards against two pulls running at once

/* ================================================================== *
 *  Configuration helpers
 * ================================================================== */

/**
 * Per-user settings file, resolved through Electron's app.getPath() so it
 * lands in the XDG config directory on Ubuntu:
 *
 *   ~/.config/BYD/settings.json
 *
 * This is the ONLY place the settings location is computed — nothing in the
 * app ever builds a path from a hardcoded prefix or an environment variable.
 */
function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

/** Read the saved repository path ('' when none is stored yet). */
function readSavedRepoPath() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return typeof saved.repoPath === 'string' ? saved.repoPath.trim() : '';
  } catch {
    return ''; // first run or invalid settings
  }
}

/**
 * Resolve + validate the repository path from config.js.
 * Throws a human readable Error when it is missing or unusable.
 *
 * @returns {{repoPath: string, remote: string, branch: string, timeoutMs: number, gitPath: string}}
 */
function readConfig() {
  const raw = readSavedRepoPath();
  if (!raw) throw new Error('No repository is configured. Choose the BYD repository folder first.');

  const remote = (config.remote || '').trim();
  const branch = (config.branch || '').trim();
  if (!remote || !branch) {
    throw new Error('remote and branch must be set in config.js (e.g. "origin" / "main").');
  }

  const timeoutMs = Number.isFinite(config.timeoutMs) ? Math.max(0, config.timeoutMs) : 0;
  // Optional override for the git binary (default: resolved from PATH).
  const gitPath = typeof config.gitPath === 'string' ? config.gitPath.trim() : '';

  return { repoPath: path.resolve(raw), remote, branch, timeoutMs, gitPath };
}

/**
 * Inspect the configured folder so we can fail with a helpful message
 * instead of a raw git error.
 */
function inspectRepo(repoPath) {
  let stats = null;
  try {
    stats = fs.statSync(repoPath);
  } catch {
    return { exists: false, isDirectory: false, isGitRepo: false };
  }
  const isDirectory = stats.isDirectory();
  const isGitRepo = isDirectory && fs.existsSync(path.join(repoPath, '.git'));
  return { exists: true, isDirectory, isGitRepo };
}

/**
 * Check that `<remote>` in `repoPath` points at hp635738-pro/BYD, using the
 * same git binary the pull will use (config.gitPath, default `git` from PATH).
 */
function remoteMatches(repoPath, remote, gitPath) {
  try {
    const url = execFileSync(gitPath || 'git', ['-C', repoPath, 'config', '--get', `remote.${remote}.url`], { encoding: 'utf8' }).trim().toLowerCase();
    return /github\.com[/:]hp635738-pro\/byd(?:\.git)?$/.test(url);
  } catch { return false; }
}

function saveRepoPath(repoPath) {
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ repoPath }, null, 2), 'utf8');
}

/**
 * Build the exact command that performs the pull.
 *
 * On Ubuntu the system `git` binary is invoked directly (no shell):
 *
 *   git pull origin main
 *
 * Spawning `git` without a shell means arguments are never re-parsed by
 * sh/bash, so a repository path or branch containing spaces or shell
 * metacharacters stays safe.
 */
function buildGitInvocation(cfg) {
  const gitArgs = ['pull', cfg.remote, cfg.branch];
  const command = (cfg && typeof cfg.gitPath === 'string' && cfg.gitPath.trim()) || 'git';
  return { command, args: gitArgs, label: `${command} ${gitArgs.join(' ')}` };
}

/**
 * Build the spawn options used for the git child process.
 *
 * `cwd` is the resolved repository path (already an absolute POSIX path from
 * app.getPath()-backed settings), and the environment disables every prompt
 * git could raise on a desktop session so a missing credential fails fast
 * with a visible error instead of hanging behind an invisible dialog.
 */
function buildSpawnOptions(cfg) {
  return {
    cwd: cfg.repoPath,
    env: {
      ...process.env,
      // Never block the UI waiting for a password we cannot type.
      GIT_TERMINAL_PROMPT: '0',
      // No SSH_ASKPASS GUI prompt either (e.g. a passphrase-less agent miss).
      SSH_ASKPASS_REQUIRE: 'never'
    }
  };
}

/* ================================================================== *
 *  Git pull
 * ================================================================== */

/**
 * Split a raw byte stream into lines, emitting each one as it arrives so the
 * UI can show live output. Calls `onLine(text)` for every complete line and
 * once for any trailing partial line when the stream ends.
 */
function pipeLines(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');

  stream.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      onLine(buffer.slice(0, newline).replace(/\r$/, ''));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  });

  stream.on('end', () => {
    if (buffer.length > 0) {
      onLine(buffer.replace(/\r$/, ''));
      buffer = '';
    }
  });
}

/**
 * Run `git pull <remote> <branch>` inside the configured repository.
 *
 * @param {object}   [options]
 * @param {Function} [options.onEvent]  ({ type, text }) live progress events.
 *                                      type is one of: state|stdout|stderr|done
 * @returns {Promise<{ok: boolean, exitCode: number|null, stdout: string,
 *                    stderr: string, message: string, command: string,
 *                    repoPath: string, reason?: string}>}
 */
function runGitPull(options = {}) {
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};

  if (activePull) {
    return Promise.resolve({
      ok: false,
      reason: 'busy',
      exitCode: null,
      stdout: '',
      stderr: '',
      message: 'A pull is already running.',
      command: activePull.label,
      repoPath: activePull.repoPath
    });
  }

  let cfg;
  try {
    cfg = readConfig();
  } catch (err) {
    const message = err.message;
    onEvent({ type: 'state', text: message });
    onEvent({ type: 'done', text: '' });
    return Promise.resolve({
      ok: false,
      reason: 'config',
      exitCode: null,
      stdout: '',
      stderr: message,
      message,
      command: '',
      repoPath: ''
    });
  }

  const repoInfo = inspectRepo(cfg.repoPath);
  if (!repoInfo.exists) {
    const message = `Folder not found: ${cfg.repoPath}`;
    onEvent({ type: 'state', text: message });
    onEvent({ type: 'done', text: '' });
    return Promise.resolve({
      ok: false,
      reason: 'missing-folder',
      exitCode: null,
      stdout: '',
      stderr: `${message}\nCheck "repoPath" in config.js.`,
      message,
      command: '',
      repoPath: cfg.repoPath
    });
  }
  if (!repoInfo.isDirectory || !repoInfo.isGitRepo) {
    const message = `Not a Git repository: ${cfg.repoPath}`;
    onEvent({ type: 'state', text: message });
    onEvent({ type: 'done', text: '' });
    return Promise.resolve({
      ok: false,
      reason: 'not-a-repo',
      exitCode: null,
      stdout: '',
      stderr: `${message}\nThe folder exists but contains no .git directory.`,
      message,
      command: '',
      repoPath: cfg.repoPath
    });
  }

  if (!remoteMatches(cfg.repoPath, cfg.remote, cfg.gitPath)) {
    const message = `The Git remote must point to hp635738-pro/BYD (using ${cfg.remote}).`;
    onEvent({ type: 'state', text: message }); onEvent({ type: 'done', text: '' });
    return Promise.resolve({ ok: false, reason: 'wrong-remote', exitCode: null, stdout: '', stderr: message, message, command: '', repoPath: cfg.repoPath });
  }

  const invocation = buildGitInvocation(cfg);
  onEvent({ type: 'state', text: `Running ${invocation.label} in ${cfg.repoPath}` });

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(invocation.command, invocation.args, buildSpawnOptions(cfg));
    } catch (err) {
      const message = `Could not start the command: ${err.message}`;
      onEvent({ type: 'stderr', text: message });
      onEvent({ type: 'done', text: '' });
      return resolve(finish({
        ok: false,
        reason: 'spawn-failed',
        exitCode: null,
        stdout: '',
        stderr: message,
        message
      }));
    }

    activePull = { label: invocation.label, repoPath: cfg.repoPath };

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = cfg.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }, cfg.timeoutMs)
      : null;

    function finish(result) {
      if (settled) return result;
      settled = true;
      activePull = null;
      if (timer) clearTimeout(timer);
      const payload = {
        command: invocation.label,
        repoPath: cfg.repoPath,
        ...result
      };
      onEvent({ type: 'done', text: '' });
      resolve(payload);
      return payload;
    }

    pipeLines(child.stdout, (line) => {
      stdout += `${line}\n`;
      onEvent({ type: 'stdout', text: line });
    });

    pipeLines(child.stderr, (line) => {
      stderr += `${line}\n`;
      onEvent({ type: 'stderr', text: line });
    });

    child.on('error', (err) => {
      const message =
        err && err.code === 'ENOENT'
          ? 'Git was not found. Install it with "sudo apt install git" and make sure it is on the PATH.'
          : `Command failed to start: ${err.message}`;
      onEvent({ type: 'stderr', text: message });
      finish({
        ok: false,
        reason: err && err.code === 'ENOENT' ? 'git-missing' : 'spawn-failed',
        exitCode: null,
        stdout: stdout.trim(),
        stderr: message,
        message
      });
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        const message = `git pull timed out after ${Math.round(cfg.timeoutMs / 1000)}s.`;
        onEvent({ type: 'stderr', text: message });
        return finish({
          ok: false,
          reason: 'timeout',
          exitCode: code,
          stdout: stdout.trim(),
          stderr: `${stderr.trim()}\n${message}`.trim(),
          message
        });
      }

      if (code === 0) {
        return finish({
          ok: true,
          exitCode: 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          message: 'Latest code downloaded successfully.'
        });
      }

      const detail = stderr.trim() || stdout.trim() || `git exited with code ${code}${signal ? ` (signal ${signal})` : ''}.`;
      return finish({
        ok: false,
        reason: 'git-failed',
        exitCode: code,
        stdout: stdout.trim(),
        stderr: detail,
        message: `Pull failed (exit code ${code}).`
      });
    });
  });
}

/* ================================================================== *
 *  Optional project launch (see config.projectLaunch)
 * ================================================================== */

/**
 * Working directory for the optional project launch: the repository the user
 * picked (an absolute POSIX path persisted next to app.getPath('userData')),
 * falling back to the current working directory. Never a hardcoded path.
 */
function projectLaunchCwd() {
  const saved = readSavedRepoPath();
  return saved ? path.resolve(saved) : process.cwd();
}

/**
 * If config.js defines `projectLaunch`, start the updated project so its
 * freshly pulled code loads. Failures are reported but never block the
 * updater restart.
 */
function launchProject(onEvent = () => {}) {
  const spec = config && config.projectLaunch;
  if (!spec || typeof spec.command !== 'string' || !spec.command.trim()) {
    return { launched: false };
  }

  try {
    const child = spawn(spec.command, Array.isArray(spec.args) ? spec.args : [], {
      cwd: (spec.cwd && spec.cwd.trim()) || projectLaunchCwd(),
      detached: true,
      stdio: 'ignore'
    });
    child.on('error', (err) => {
      onEvent({ type: 'stderr', text: `Could not start the project: ${err.message}` });
    });
    child.unref();
    onEvent({ type: 'state', text: `Starting ${spec.command}` });
    return { launched: true };
  } catch (err) {
    onEvent({ type: 'stderr', text: `Could not start the project: ${err.message}` });
    return { launched: false };
  }
}

/* ================================================================== *
 *  Repository-provided UI (the "install once" mechanism)
 * ================================================================== *
 *  The installed BYD AppImage (or .deb) is only a stable bootstrap. The UI
 *  it shows (index.html / renderer.js / style.css) is taken from the
 *  selected repository — `<repo>/GitHub-Updater/renderer` — so a `git pull`
 *  is enough to update the application; no rebuild or reinstall needed.
 *
 *  Files are never loaded straight from the working tree. After a pull
 *  finishes (and on start-up) the renderer folder is validated, hashed
 *  and copied into `app.getPath('userData')/ui-cache/<hash>/renderer`
 *  (~/.config/BYD/ui-cache/… on Ubuntu) — into a temp folder first, then
 *  renamed into place — so the window can only ever load a complete,
 *  consistent snapshot. If anything about the repository UI is unusable,
 *  the packaged renderer is used instead.
 */

/** Files a usable renderer must provide. */
const UI_REQUIRED_FILES = Object.freeze(['index.html', 'renderer.js', 'style.css']);
const UI_REPO_SUBDIR = path.join('GitHub-Updater', 'renderer');
const UI_CACHE_DIRNAME = 'ui-cache';
const UI_RELOAD_DELAY_MS = 600; // let the renderer paint the final status first

/** What the window is currently showing. */
let currentUi = { source: 'packaged', dir: path.join(__dirname, 'renderer'), hash: '' };

function packagedUi() {
  return { source: 'packaged', dir: path.join(__dirname, 'renderer'), hash: '' };
}

function uiCacheRoot() {
  return path.join(app.getPath('userData'), UI_CACHE_DIRNAME);
}

/** Recursively list files under `dir` (relative, posix separators, sorted). */
function listFiles(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/**
 * Validate `<repoPath>/GitHub-Updater/renderer` and compute a content hash.
 * Returns `{ ok, dir, hash, files, reason }`; never throws.
 */
function inspectRepoUi(repoPath) {
  const dir = path.join(repoPath, UI_REPO_SUBDIR);
  try {
    if (!fs.statSync(dir).isDirectory()) return { ok: false, dir, reason: 'not-a-directory' };
  } catch {
    return { ok: false, dir, reason: 'missing' };
  }

  const missing = UI_REQUIRED_FILES.filter((f) => !fs.existsSync(path.join(dir, f)));
  if (missing.length) return { ok: false, dir, reason: `missing ${missing.join(', ')}` };

  let files;
  try {
    files = listFiles(dir);
  } catch (err) {
    return { ok: false, dir, reason: err.message };
  }

  const hash = crypto.createHash('sha256');
  try {
    for (const rel of files) {
      const data = fs.readFileSync(path.join(dir, rel));
      hash.update(rel).update('\0').update(data).update('\0');
      if (rel === 'index.html') {
        const html = data.toString('utf8');
        if (!/<html[\s>]/i.test(html) || !/renderer\.js/.test(html)) {
          return { ok: false, dir, reason: 'index.html is incomplete' };
        }
      }
    }
  } catch (err) {
    return { ok: false, dir, reason: err.message };
  }

  return { ok: true, dir, files, hash: hash.digest('hex').slice(0, 16) };
}

/**
 * Copy the repository renderer into an immutable snapshot folder named by
 * its content hash. Reuses an existing snapshot with the same hash.
 *
 * @returns {{source: 'repository', dir: string, hash: string} | null}
 */
function snapshotRepoUi(repoPath, log = () => {}) {
  const info = inspectRepoUi(repoPath);
  if (!info.ok) {
    log(`Repository UI not used (${info.reason}) — using the built-in UI.`);
    return null;
  }

  const root = uiCacheRoot();
  const finalDir = path.join(root, info.hash);
  const rendererDir = path.join(finalDir, 'renderer');

  if (!fs.existsSync(path.join(rendererDir, 'index.html'))) {
    const tmp = path.join(root, `.tmp-${process.pid}-${Date.now()}`);
    try {
      fs.mkdirSync(path.join(tmp, 'renderer'), { recursive: true });
      for (const rel of info.files) {
        const dest = path.join(tmp, 'renderer', rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(info.dir, rel), dest);
      }
      // Re-check: if the source changed while we copied, do not publish it.
      const again = inspectRepoUi(repoPath);
      if (!again.ok || again.hash !== info.hash) {
        fs.rmSync(tmp, { recursive: true, force: true });
        log('Repository UI changed while it was being staged — keeping the current UI.');
        return null;
      }
      try {
        fs.renameSync(tmp, finalDir);
      } catch (err) {
        // Another instance may have published the same hash first.
        fs.rmSync(tmp, { recursive: true, force: true });
        if (!fs.existsSync(path.join(rendererDir, 'index.html'))) throw err;
      }
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      log(`Could not stage the repository UI (${err.message}) — using the built-in UI.`);
      return null;
    }
  }

  return { source: 'repository', dir: rendererDir, hash: info.hash };
}

/** Delete old snapshots, keeping the hashes listed in `keep`. */
function pruneUiCache(keep) {
  const root = uiCacheRoot();
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || keep.includes(entry.name)) continue;
    if (entry.name.startsWith('.tmp-') && entry.name.includes(`-${process.pid}-`)) continue;
    fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
  }
}

/**
 * Decide which UI to show: the repository snapshot when a valid repository
 * is configured and its renderer is usable, otherwise the packaged one.
 */
function resolveUi(log = () => {}) {
  let repoPath = '';
  try {
    repoPath = readConfig().repoPath;
  } catch {
    return packagedUi();
  }
  const info = inspectRepo(repoPath);
  if (!info.isGitRepo) return packagedUi();
  return snapshotRepoUi(repoPath, log) || packagedUi();
}

/**
 * Load `ui` into the window. `query` is forwarded to index.html so the
 * freshly loaded renderer can restore state (e.g. `?pulled=1`).
 */
function loadUi(win, ui, query) {
  if (!win || win.isDestroyed()) return Promise.resolve();
  currentUi = ui;
  const entry = path.join(ui.dir, 'index.html');
  const options = query ? { query } : undefined;
  return win.loadFile(entry, options).then(() => {
    // The new page is up; older snapshots are no longer referenced.
    pruneUiCache([ui.hash]);
  }).catch((err) => {
    console.error(`BYD: failed to load the ${ui.source} UI —`, err);
    if (ui.source !== 'packaged') {
      const fallback = packagedUi();
      currentUi = fallback;
      return win.loadFile(path.join(fallback.dir, 'index.html'), options);
    }
  });
}

/**
 * After a pull / repository change: re-stage the repository UI and, when
 * it differs from what is on screen, reload the window into it.
 * Returns true when a reload was scheduled.
 */
function refreshUiAfterChange(query) {
  const ui = resolveUi((text) => emitToRenderer(IPC.pullOutput, { type: 'stderr', text }));
  if (ui.source === currentUi.source && ui.hash === currentUi.hash) return false;

  emitToRenderer(IPC.pullState, { type: 'state', text: 'Loading the updated interface…' });
  setTimeout(() => {
    loadUi(mainWindow, ui, query);
  }, UI_RELOAD_DELAY_MS);
  return true;
}

/* ================================================================== *
 *  Window
 * ================================================================== */

function createWindow() {
  mainWindow = new BrowserWindow({
    title: APP_TITLE,
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: WINDOW_WIDTH,
    minHeight: WINDOW_HEIGHT,
    resizable: true,
    maximizable: true,
    fullscreenable: false,
    center: true,
    show: false,
    backgroundColor: BACKGROUND_COLOR,
    autoHideMenuBar: true,
    // Linux window/taskbar icon: a PNG (the .ico used on Windows is gone).
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged
    }
  });

  // No menu bar.
  mainWindow.setMenuBarVisibility(false);
  mainWindow.removeMenu();
  mainWindow.center();

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.center();
      mainWindow.show();
      mainWindow.maximize();
      mainWindow.focus();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  loadUi(mainWindow, resolveUi());

  return mainWindow;
}

function focusWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

/* ================================================================== *
 *  IPC
 * ================================================================== */

/** Send a pull event to the renderer (no-op if the window is gone). */
function emitToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/**
 * Where the Ubuntu directory chooser should open: the repository that is
 * already configured when it still exists, otherwise the user's home folder.
 * Both come from Electron (app.getPath) / the saved settings — never a
 * hardcoded prefix, and the GTK directory picker gets an absolute POSIX path
 * it can actually start in.
 */
function pickerDefaultPath() {
  const saved = readSavedRepoPath();
  const resolved = saved ? path.resolve(saved) : '';
  if (resolved && fs.existsSync(resolved)) return resolved;
  return app.getPath('home');
}

function registerIpc() {
  ipcMain.handle('choose-repository', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select the BYD Git repository',
      buttonLabel: 'Select repository',
      // Directory-only picker: on Ubuntu this opens the GTK/xdg-desktop-portal
      // folder chooser, which cannot create or select files.
      properties: ['openDirectory'],
      defaultPath: pickerDefaultPath()
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    const selected = path.resolve(result.filePaths[0]);
    const info = inspectRepo(selected);
    if (!info.isGitRepo) return { ok: false, message: 'Selected folder is not a Git repository.' };
    if (!remoteMatches(selected, config.remote, config.gitPath)) return { ok: false, message: 'Selected repository remote must point to hp635738-pro/BYD.' };
    saveRepoPath(selected);
    const reloading = refreshUiAfterChange({ repoSelected: '1' });
    return { ok: true, repoPath: selected, reloading };
  });

  ipcMain.handle(IPC.info, () => {
    let repoPath = '';
    try {
      repoPath = readConfig().repoPath;
    } catch {
      repoPath = '';
    }
    return {
      version: pkg.version,
      appTitle: APP_TITLE,
      repoPath,
      remote: config.remote || '',
      expectedRepository: config.expectedRepository || '',
      branch: config.branch || '',
      platform: process.platform,
      ui: { source: currentUi.source, hash: currentUi.hash }
    };
  });

  ipcMain.handle(IPC.pull, async () => {
    const result = await runGitPull({
      onEvent: (event) => {
        if (event.type === 'state') emitToRenderer(IPC.pullState, event);
        else emitToRenderer(IPC.pullOutput, event);
      }
    });
    if (result.ok) {
      // The pull is complete (git has released the working tree), so the
      // repository UI can now be snapshotted and shown.
      result.uiReloading = refreshUiAfterChange({ pulled: '1' });
    }
    return result;
  });

  ipcMain.handle(IPC.restart, (event) => {
    emitToRenderer(IPC.pullState, { type: 'state', text: 'Restarting…' });
    launchProject((evt) => emitToRenderer(IPC.pullOutput, evt));

    // Give the renderer a moment to render "Restarting…" and resolve its
    // await before the process goes away.
    setTimeout(() => {
      relaunchApp();
      app.quit();
    }, RELAUNCH_DELAY_MS);

    return { ok: true, relaunching: true, requestId: event && event.senderId };
  });
}

/**
 * Restart the application (the "Update" button).
 *
 * Inside an AppImage `process.execPath` points at the binary in the
 * throw-away squashfs mount (/tmp/.mount_BYD-xxxxxx/byd), which is unmounted
 * as soon as the process exits — relaunching it would fail. The AppImage
 * runtime exports the real file path as $APPIMAGE, so relaunch that instead.
 * A .deb install (/opt/BYD/byd) has a stable execPath and needs no override.
 */
function relaunchApp() {
  const appImage = process.env.APPIMAGE;
  if (appImage && fs.existsSync(appImage)) {
    app.relaunch({ execPath: appImage, args: process.argv.slice(1) });
    return true;
  }
  app.relaunch();
  return false;
}

/* ================================================================== *
 *  App lifecycle
 * ================================================================== */

function bootstrap() {
  const gotTheLock = app.requestSingleInstanceLock();

  if (!gotTheLock) {
    app.quit();
    return;
  }

  app.on('second-instance', () => focusWindow());

  Menu.setApplicationMenu(null);
  app.setName(APP_TITLE);

  app.on('web-contents-created', (_event, contents) => {
    // The updater never navigates away and never opens new windows.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
  });

  app.whenReady().then(() => {
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else focusWindow();
    });
  });

  // Ubuntu only: closing the window always quits (no macOS-style dock idle).
  app.on('window-all-closed', () => {
    app.quit();
  });
}

/* ------------------------------------------------------------------ *
 *  Exports — used by the test-suite (test/main.test.js) and safe to
 *  leave in the packaged app.
 * ------------------------------------------------------------------ */
module.exports = {
  IPC,
  WINDOW_WIDTH,
  WINDOW_HEIGHT,
  BACKGROUND_COLOR,
  APP_TITLE,
  bootstrap,
  createWindow,
  focusWindow,
  registerIpc,
  relaunchApp,
  runGitPull,
  readConfig,
  settingsFile,
  readSavedRepoPath,
  saveRepoPath,
  inspectRepo,
  remoteMatches,
  pickerDefaultPath,
  buildGitInvocation,
  buildSpawnOptions,
  projectLaunchCwd,
  launchProject,
  pipeLines,
  UI_REQUIRED_FILES,
  UI_REPO_SUBDIR,
  inspectRepoUi,
  snapshotRepoUi,
  resolveUi,
  loadUi,
  refreshUiAfterChange,
  getCurrentUi: () => currentUi,
  /** Test hook: forget the in-flight pull flag. */
  __resetForTests() {
    activePull = null;
    mainWindow = null;
    currentUi = packagedUi();
  }
};

if (require.main === module) {
  bootstrap();
}
