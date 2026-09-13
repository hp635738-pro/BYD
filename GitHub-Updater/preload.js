'use strict';

/**
 * ============================================================================
 *  BYD — preload
 * ============================================================================
 *  Runs in an isolated context with `contextIsolation: true` and
 *  `nodeIntegration: false`, so the renderer only ever sees the tiny,
 *  explicit API exposed below. No Node.js primitives leak into the page.
 *
 *      window.api.pull()             -> Promise<PullResult>
 *      window.api.restart()          -> Promise<{ok:boolean}>
 *      window.api.onOutput(cb)       -> unsubscribe()   live git output
 *      window.api.onState(cb)        -> unsubscribe()   status line changes
 *      window.api.getInfo()          -> Promise<AppInfo>
 * ============================================================================
 */

const { contextBridge, ipcRenderer } = require('electron');

/** Channel names must match main.js. */
const CHANNELS = {
  pull: 'git-pull',
  restart: 'restart-app',
  info: 'app-info',
  output: 'git-pull:output',
  state: 'git-pull:state'
};

/**
 * Subscribe to a push channel. Returns an unsubscribe function and never
 * hands the raw IpcRendererEvent to the page.
 */
function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};

  const listener = (_event, payload) => {
    try {
      callback(payload);
    } catch {
      /* a broken renderer callback must not kill the IPC bridge */
    }
  };

  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  /** Run `git pull <remote> <branch>` in the configured repository. */
  pull: () => ipcRenderer.invoke(CHANNELS.pull),

  /** Relaunch the app (app.relaunch + app.quit in the main process). */
  restart: () => ipcRenderer.invoke(CHANNELS.restart),

  /** App metadata: version, configured repo path, remote, branch. */
  getInfo: () => ipcRenderer.invoke(CHANNELS.info),

  /** Live git stdout/stderr lines: ({ type: 'stdout'|'stderr', text }). */
  onOutput: (callback) => subscribe(CHANNELS.output, callback),

  /** Status line updates: ({ type: 'state', text }). */
  onState: (callback) => subscribe(CHANNELS.state, callback)
});
