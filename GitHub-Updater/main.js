'use strict';

/**
 * ============================================================================
 *  BYD — main (Electron) process
 * ============================================================================
 *  Responsibilities:
 *    - createWindow()                  -> the single 520x420 dark window
 *    - ipcMain.handle('git-pull')      -> runs `git pull <remote> <branch>`
 *                                         through Windows CMD (cmd.exe) and
 *                                         streams live output to the renderer
 *    - ipcMain.handle('restart-app')   -> app.relaunch() + app.quit()
 *    - repository-provided UI          -> after "Pull from GitHub" the window
 *                                         reloads <repo>/GitHub-Updater/renderer
 *                                         (via an atomic snapshot), so UI/code
 *                                         updates merged on GitHub appear
 *                                         without rebuilding or reinstalling
 *                                         the installed BYD.exe
 *
 *  All paths come from ./config.js — nothing is hardcoded here.
 * ============================================================================
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');

const config = require('./config');
const pkg = require('./package.json');

/* ------------------------------------------------------------------ *
 *  Window / UI constants (spec: 520x420, non-resizable, centred)
 * ------------------------------------------------------------------ */
const WINDOW_WIDTH = 520;
const WINDOW_HEIGHT = 420;
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
 * Resolve + validate the repository path from config.js.
 * Throws a human readable Error when it is missing or unusable.
 *
 * @returns {{repoPath: string, remote: string, branch: string, timeoutMs: number}}
 */
function readConfig() {
  let raw = '';
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
    raw = typeof saved.repoPath === 'string' ? saved.repoPath.trim() : '';
  } catch { /* first run or invalid settings */ }
  if (!raw) throw new Error('No repository is configured. Choose the BYD repository folder first.');

  const remote = (config.remote || '').trim();
  const branch = (config.branch || '').trim();
  if (!remote || !branch) {
    throw new Error('remote and branch must be set in config.js (e.g. "origin" / "main").');
  }

  const timeoutMs = Number.isFinite(config.timeoutMs) ? Math.max(0, config.timeoutMs) : 0;

  return { repoPath: path.resolve(raw), remote, branch, timeoutMs };
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

function remoteMatches(repoPath, remote) {
  try {
    const { execFileSync } = require('child_process');
    const url = execFileSync('git', ['-C', repoPath, 'config', '--get', `remote.${remote}.url`], { encoding: 'utf8' }).trim().toLowerCase();
    return /github\.com[/:]hp635738-pro\/byd(?:\.git)?$/.test(url);
  } catch { return false; }
}

function saveRepoPath(repoPath) {
  const file = path.join(app.getPath('userData'), 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ repoPath }, null, 2), 'utf8');
}

/**
 * Build the exact command that performs the pull.
 *
 * On Windows this goes through CMD, as required:
 *   cmd.exe /d /s /c git pull origin main
 *
 * On other platforms `git` is invoked directly. This keeps the Windows
 * behaviour exactly as specified while letting the same code path be
 * exercised (and unit-tested) on Linux/macOS build machines and CI.
 */
function buildGitInvocation(cfg) {
  const gitArgs = ['pull', cfg.remote, cfg.branch];

  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      // /d = skip AutoRun, /s = keep quoting rules, /c = run then terminate.
      // Arguments are passed as an array so Node quotes them safely.
      args: ['/d', '/s', '/c', 'git', ...gitArgs],
      label: `git ${gitArgs.join(' ')}`
    };
  }

  return { command: 'git', args: gitArgs, label: `git ${gitArgs.join(' ')}` };
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

  if (!remoteMatches(cfg.repoPath, cfg.remote)) {
    const message = `The Git remote must point to hp635738-pro/BYD (using ${cfg.remote}).`;
    onEvent({ type: 'state', text: message }); onEvent({ type: 'done', text: '' });
    return Promise.resolve({ ok: false, reason: 'wrong-remote', exitCode: null, stdout: '', stderr: message, message, command: '', repoPath: cfg.repoPath });
  }

  const invocation = buildGitInvocation(cfg);
  onEvent({ type: 'state', text: `Running ${invocation.label} in ${cfg.repoPath}` });

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: cfg.repoPath,
        env: {
          ...process.env,
          // Never block the UI waiting for a password we cannot type.
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never'
        },
        windowsHide: true
      });
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
          ? 'Git was not found. Install Git for Windows and make sure it is on the PATH.'
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
      cwd: (spec.cwd && spec.cwd.trim()) || (config.repoPath || process.cwd()),
      detached: true,
      stdio: 'ignore',
      windowsHide: false
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
 *  The installed BYD.exe is only a stable bootstrap. The UI it shows
 *  (index.html / renderer.js / style.css) is taken from the selected
 *  repository — `<repo>/GitHub-Updater/renderer` — so a `git pull` is
 *  enough to update the application; no rebuild or reinstall needed.
 *
 *  Files are never loaded straight from the working tree. After a pull
 *  finishes (and on start-up) the renderer folder is validated, hashed
 *  and copied into `<userData>/ui-cache/<hash>/renderer` — into a temp
 *  folder first, then renamed into place — so the window can only ever
 *  load a complete, consistent snapshot. If anything about the
 *  repository UI is unusable, the packaged renderer is used instead.
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
    icon: path.join(__dirname, 'assets', 'icon.ico'),
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

function registerIpc() {
  ipcMain.handle('choose-repository', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: 'Select the BYD Git repository' });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    const selected = path.resolve(result.filePaths[0]);
    const info = inspectRepo(selected);
    if (!info.isGitRepo) return { ok: false, message: 'Selected folder is not a Git repository.' };
    if (!remoteMatches(selected, config.remote)) return { ok: false, message: 'Selected repository remote must point to hp635738-pro/BYD.' };
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
      app.relaunch();
      app.quit();
    }, RELAUNCH_DELAY_MS);

    return { ok: true, relaunching: true, requestId: event && event.senderId };
  });
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

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
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
  runGitPull,
  readConfig,
  inspectRepo,
  buildGitInvocation,
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
