'use strict';

/**
 * Test helpers: load the REAL main.js against a stubbed `electron` module.
 *
 * main.js is required exactly as Electron would require it; only the
 * `electron` package and `./config` are replaced, so every assertion below
 * runs the shipped git/IPC/restart logic rather than a re-implementation.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const APP_DIR = path.join(__dirname, '..');

/** Minimal stand-in for the Electron main-process API surface main.js uses. */
function makeElectronStub() {
  const handlers = new Map();
  const appListeners = new Map();
  const calls = { quit: 0, relaunch: 0, relaunchArgs: null, menu: null, name: null };

  class FakeWebContents {
    constructor() {
      this.sent = [];
    }
    send(channel, payload) {
      this.sent.push({ channel, payload });
    }
    isDestroyed() {
      return false;
    }
  }

  class FakeBrowserWindow {
    constructor(options) {
      this.options = options;
      this.webContents = new FakeWebContents();
      this.destroyed = false;
      this.menuBarVisible = true;
      this.loaded = null;
      FakeBrowserWindow.instances.push(this);
    }
    setMenuBarVisibility(value) {
      this.menuBarVisible = value;
    }
    removeMenu() {
      this.menuRemoved = true;
    }
    center() {
      this.centered = (this.centered || 0) + 1;
    }
    once() {}
    on() {}
    show() {
      this.shown = true;
    }
    focus() {}
    restore() {}
    isMinimized() {
      return false;
    }
    isDestroyed() {
      return this.destroyed;
    }
    loadFile(file) {
      this.loaded = file;
      return Promise.resolve();
    }
    static getAllWindows() {
      return FakeBrowserWindow.instances;
    }
  }
  FakeBrowserWindow.instances = [];

  const app = {
    isPackaged: false,
    whenReady: () => new Promise(() => {}), // never resolves: tests drive things directly
    requestSingleInstanceLock: () => true,
    on: (event, fn) => {
      if (!appListeners.has(event)) appListeners.set(event, []);
      appListeners.get(event).push(fn);
    },
    once: () => {},
    setName: (name) => {
      calls.name = name;
    },
    getName: () => 'BYD',
    relaunch: (args) => {
      calls.relaunch += 1;
      calls.relaunchArgs = args;
    },
    quit: () => {
      calls.quit += 1;
    }
  };

  const stub = {
    app,
    BrowserWindow: FakeBrowserWindow,
    Menu: {
      setApplicationMenu: (menu) => {
        calls.menu = menu === null ? null : 'menu';
      }
    },
    ipcMain: {
      handle: (channel, fn) => handlers.set(channel, fn),
      on: () => {},
      removeHandler: (channel) => handlers.delete(channel)
    },
    contextBridge: { exposeInMainWorld: () => {} },
    ipcRenderer: { invoke: async () => {}, on: () => {}, removeListener: () => {} },
    __handlers: handlers,
    __calls: calls,
    __appListeners: appListeners
  };

  return stub;
}

/**
 * Prime require.cache for `electron` and `./config`, then load main.js.
 * Returns { main, config, electron }.
 */
function loadMain() {
  const electronPath = require.resolve('electron');
  const configPath = path.join(APP_DIR, 'config.js');
  const electron = makeElectronStub();
  const config = {
    repoPath: '',
    remote: 'origin',
    branch: 'main',
    timeoutMs: 0,
    projectLaunch: null
  };

  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: electron,
    children: [],
    paths: []
  };
  require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: config,
    children: [],
    paths: []
  };

  const mainPath = path.join(APP_DIR, 'main.js');
  delete require.cache[mainPath];
  const main = require(mainPath);
  main.__resetForTests();

  return { main, config, electron };
}

/* ------------------------- real git fixtures ---------------------------- */

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.name=Updater Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: os.devnull, GIT_CONFIG_SYSTEM: os.devnull, HOME: os.tmpdir() }
  }).trim();
}

/**
 * Builds a throwaway "remote" repo plus a local clone that is one commit
 * behind — the exact situation "Pull from GitHub" has to handle.
 */
function makeRepoFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghupdater-'));
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const local = path.join(root, 'local');

  fs.mkdirSync(remote);
  fs.mkdirSync(seed);
  git(['init', '--bare', '-b', 'main', remote], root);

  git(['init', '-b', 'main', seed], root);
  fs.writeFileSync(path.join(seed, 'base.txt'), 'base\n');
  git(['add', '.'], seed);
  git(['commit', '-m', 'base'], seed);
  git(['remote', 'add', 'origin', remote], seed);
  git(['push', 'origin', 'main'], seed);

  git(['clone', remote, local], root);

  // New commit on the remote that the local clone does not have yet.
  fs.writeFileSync(path.join(seed, 'pulled.txt'), 'fresh from origin/main\n');
  git(['add', '.'], seed);
  git(['commit', '-m', 'feature: the commit the updater must fetch'], seed);
  git(['push', 'origin', 'main'], seed);

  return { root, remote, seed, local };
}

module.exports = { loadMain, makeElectronStub, makeRepoFixture, git, APP_DIR };
