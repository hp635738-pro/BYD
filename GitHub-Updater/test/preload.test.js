'use strict';

/**
 * Contract tests for preload.js — the real file is loaded against a stubbed
 * `electron`, so these assertions verify the actual channel names the bridge
 * uses and that nothing but the documented API reaches the page.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { APP_DIR, loadMain } = require('./helpers');

function loadPreload() {
  const electronPath = require.resolve('electron');
  const preloadPath = path.join(APP_DIR, 'preload.js');

  const invoked = [];
  const listeners = new Map();
  let exposed = null;

  const stub = {
    contextBridge: {
      exposeInMainWorld: (name, api) => {
        exposed = { name, api };
      }
    },
    ipcRenderer: {
      invoke: (channel, ...args) => {
        invoked.push({ channel, args });
        return Promise.resolve({ ok: true });
      },
      on: (channel, fn) => {
        if (!listeners.has(channel)) listeners.set(channel, []);
        listeners.get(channel).push(fn);
      },
      removeListener: (channel, fn) => {
        const arr = listeners.get(channel) || [];
        const index = arr.indexOf(fn);
        if (index >= 0) arr.splice(index, 1);
      }
    }
  };

  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: stub,
    children: [],
    paths: []
  };
  delete require.cache[preloadPath];
  require(preloadPath);

  const emit = (channel, payload) => (listeners.get(channel) || []).forEach((fn) => fn({ channel }, payload));

  return { exposed, invoked, listeners, emit };
}

test('preload exposes window.api and nothing else', () => {
  const { exposed } = loadPreload();
  assert.ok(exposed, 'contextBridge.exposeInMainWorld was called');
  assert.equal(exposed.name, 'api');
  assert.deepEqual(Object.keys(exposed.api).sort(), ['chooseRepository', 'getInfo', 'onOutput', 'onState', 'pull', 'restart']);
});

test('preload never leaks Node or Electron primitives into the page', () => {
  const { exposed } = loadPreload();
  const api = exposed.api;
  for (const forbidden of ['require', 'process', 'ipcRenderer', '__dirname', 'module', 'Buffer']) {
    assert.equal(forbidden in api, false, `${forbidden} must not be exposed`);
  }
});

test('window.api.pull() invokes the git-pull channel', async () => {
  const { exposed, invoked } = loadPreload();
  await exposed.api.pull();
  assert.equal(invoked.length, 1);
  assert.equal(invoked[0].channel, 'git-pull');
});

test('window.api.restart() invokes the restart-app channel', async () => {
  const { exposed, invoked } = loadPreload();
  await exposed.api.restart();
  assert.equal(invoked.length, 1);
  assert.equal(invoked[0].channel, 'restart-app');
});

test('window.api.getInfo() invokes the app-info channel', async () => {
  const { exposed, invoked } = loadPreload();
  await exposed.api.getInfo();
  assert.equal(invoked[0].channel, 'app-info');
});

test('the channel names in preload.js match the handlers in main.js', () => {
  const { main } = loadMain();
  const { exposed, invoked, listeners } = loadPreload();

  exposed.api.pull();
  assert.equal(invoked[0].channel, main.IPC.pull);

  invoked.length = 0;
  exposed.api.restart();
  assert.equal(invoked[0].channel, main.IPC.restart);

  invoked.length = 0;
  exposed.api.getInfo();
  assert.equal(invoked[0].channel, main.IPC.info);

  exposed.api.onOutput(() => {});
  assert.ok(listeners.has(main.IPC.pullOutput), 'subscribes to the main-process output channel');

  exposed.api.onState(() => {});
  assert.ok(listeners.has(main.IPC.pullState), 'subscribes to the main-process state channel');
});

test('onOutput forwards only the payload and can be unsubscribed', () => {
  const { exposed, listeners, emit } = loadPreload();
  const seen = [];

  const unsubscribe = exposed.api.onOutput((payload) => seen.push(payload));
  assert.equal(listeners.get('git-pull:output').length, 1);

  emit('git-pull:output', { type: 'stdout', text: 'Fast-forward' });
  assert.deepEqual(seen, [{ type: 'stdout', text: 'Fast-forward' }], 'the IpcRendererEvent is not exposed');

  unsubscribe();
  assert.equal(listeners.get('git-pull:output').length, 0);

  emit('git-pull:output', { type: 'stdout', text: 'after unsubscribe' });
  assert.equal(seen.length, 1, 'no events after unsubscribe');
});

test('a throwing renderer callback cannot break the IPC bridge', () => {
  const { exposed, emit } = loadPreload();
  exposed.api.onOutput(() => {
    throw new Error('renderer bug');
  });
  assert.doesNotThrow(() => emit('git-pull:output', { type: 'stdout', text: 'x' }));
});

test('onOutput ignores a non-function argument', () => {
  const { exposed, listeners } = loadPreload();
  const unsubscribe = exposed.api.onOutput(null);
  assert.equal(typeof unsubscribe, 'function');
  assert.equal(listeners.has('git-pull:output'), false);
  assert.doesNotThrow(unsubscribe);
});
