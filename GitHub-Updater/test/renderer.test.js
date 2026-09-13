'use strict';

/**
 * Tests for the renderer UI (renderer/index.html + renderer.js) driven by jsdom.
 * The real renderer.js source is evaluated inside a real DOM.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const APP_DIR = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(APP_DIR, 'renderer', 'index.html'), 'utf8');
const RENDERER = fs.readFileSync(path.join(APP_DIR, 'renderer', 'renderer.js'), 'utf8');
const CSS = fs.readFileSync(path.join(APP_DIR, 'renderer', 'style.css'), 'utf8');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeRenderer({ info = { version: '1.0.0', repoPath: 'C:\\HPOS', remote: 'origin', branch: 'main' } } = {}) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'http://localhost/' });
  const win = dom.window;

  const calls = { pull: 0, restart: 0 };
  let resolvePull = null;
  const outputSubs = [];
  const stateSubs = [];

  win.api = {
    pull: () => {
      calls.pull += 1;
      return new Promise((resolve) => {
        resolvePull = resolve;
      });
    },
    restart: () => {
      calls.restart += 1;
      return Promise.resolve({ ok: true, relaunching: true });
    },
    getInfo: () => Promise.resolve(info),
    onOutput: (cb) => {
      outputSubs.push(cb);
      return () => {};
    },
    onState: (cb) => {
      stateSubs.push(cb);
      return () => {};
    }
  };

  win.eval(RENDERER);

  return {
    dom,
    win,
    calls,
    doc: win.document,
    pull: win.document.getElementById('btn-pull'),
    update: win.document.getElementById('btn-update'),
    statusLine: win.document.getElementById('status-line'),
    statusText: win.document.getElementById('status-text'),
    output: win.document.getElementById('output'),
    repoPath: win.document.getElementById('repo-path'),
    finishPull: async (result) => {
      resolvePull(result);
      await flush();
      await flush();
    },
    emitOutput: (payload) => outputSubs.forEach((cb) => cb(payload)),
    emitState: (payload) => stateSubs.forEach((cb) => cb(payload))
  };
}

/* ================================================================== *
 *  Layout / spec conformance
 * ================================================================== */

test('the heading matches the required copy', async () => {
  const ui = makeRenderer();
  assert.equal(ui.doc.querySelector('.title').textContent, 'BYD');
  assert.equal(ui.doc.querySelector('.subtitle').textContent, 'Update local project directly from GitHub');
});

test('one card holds the folder picker, then Pull from GitHub above Update', () => {
  const ui = makeRenderer();
  const cards = ui.doc.querySelectorAll('.card');
  assert.equal(cards.length, 1, 'exactly one card');

  const buttons = [...ui.doc.querySelectorAll('button')];
  assert.equal(buttons.length, 3, 'exactly three buttons in the document');
  assert.equal(buttons.filter((b) => b.closest('.card')).length, 3, 'all buttons live in the card');

  assert.equal(buttons[0].textContent.trim(), 'Choose BYD repository folder');
  assert.equal(buttons[1].textContent.trim(), 'Pull from GitHub');
  assert.equal(buttons[2].textContent.trim(), 'Update');
  assert.equal(
    buttons[1].compareDocumentPosition(buttons[2]) & ui.win.Node.DOCUMENT_POSITION_FOLLOWING,
    ui.win.Node.DOCUMENT_POSITION_FOLLOWING,
    'Update must come directly after Pull from GitHub'
  );
});

test('both buttons share the same full-card width', () => {
  const ui = makeRenderer();
  const buttons = [...ui.doc.querySelectorAll('button')];
  assert.deepEqual(
    buttons.map((b) => [...b.classList].filter((c) => c.startsWith('btn-')).sort()),
    [['btn-secondary'], ['btn-primary'], ['btn-success']],
    'secondary picker, primary red pull button and green update button'
  );
  assert.ok(buttons.every((b) => b.classList.contains('btn')), 'both use the shared .btn class');
  assert.match(CSS, /\.btn\s*\{[^}]*width:\s*100%/s, '.btn is full width, so both buttons are equal width');
});

test('the palette matches the dark black/red design spec', () => {
  assert.match(CSS, /--bg:\s*#0b0d10/i, 'background #0B0D10');
  assert.match(CSS, /--card:\s*#15181d/i, 'card #15181D');
  assert.match(CSS, /--red:\s*#e60012/i, 'primary button red');
  assert.match(CSS, /--green:\s*#16a34a/i, 'update button green');
  assert.match(CSS, /\.card\s*\{[^}]*border-radius:\s*var\(--radius\)/s, 'rounded card');
  assert.match(CSS, /transition:[^;]*transform/s, 'smooth hover animation');
  assert.match(CSS, /\.btn:hover:not\(:disabled\)\s*\{[^}]*transform:\s*translateY\(-1px\)/s, 'hover lift');
});

/* ================================================================== *
 *  Initial state
 * ================================================================== */

test('Update is disabled until a pull succeeds', async () => {
  const ui = makeRenderer();
  await flush();

  assert.equal(ui.pull.disabled, false, 'pull starts enabled');
  assert.equal(ui.update.disabled, true, 'update starts disabled');
  assert.equal(ui.statusText.textContent, 'Ready.');
  assert.equal(ui.output.hidden, true, 'output console starts hidden');
});

test('the configured repository is shown from window.api.getInfo()', async () => {
  const ui = makeRenderer();
  await flush();
  await flush();
  assert.equal(ui.repoPath.textContent, 'Repository: C:\\HPOS');
});

/* ================================================================== *
 *  Pull from GitHub
 * ================================================================== */

test('clicking Pull disables both buttons and shows live status', async () => {
  const ui = makeRenderer();
  await flush();

  ui.pull.click();

  assert.equal(ui.calls.pull, 1, 'window.api.pull() invoked');
  assert.equal(ui.pull.disabled, true, 'pull disabled while running');
  assert.equal(ui.update.disabled, true, 'update stays disabled');
  assert.equal(ui.statusText.textContent, 'Pulling latest code from GitHub…');
  assert.ok(ui.statusLine.classList.contains('is-busy'));
  assert.ok(ui.pull.classList.contains('is-busy'), 'spinner shown on the button');

  ui.emitOutput({ type: 'stdout', text: 'Updating 1a2b3c4..5d6e7f8' });
  ui.emitOutput({ type: 'stdout', text: 'Fast-forward' });
  ui.emitOutput({ type: 'stderr', text: 'remote: Counting objects: 12' });

  assert.equal(ui.output.hidden, false, 'live output console is revealed');
  assert.match(ui.output.textContent, /Updating 1a2b3c4\.\.5d6e7f8/);
  assert.match(ui.output.textContent, /Fast-forward/);
  assert.ok(ui.output.querySelector('.line-err'), 'stderr lines are highlighted');
  assert.equal(ui.output.querySelectorAll('.line-err').length, 1);
  assert.equal(ui.output.querySelectorAll('.line-out').length, 2);
});

test('a successful pull shows the green success message and enables Update', async () => {
  const ui = makeRenderer();
  await flush();
  ui.pull.click();

  await ui.finishPull({ ok: true, exitCode: 0, stdout: 'Already up to date.', stderr: '', message: 'Latest code downloaded successfully.' });

  assert.equal(ui.statusText.textContent, 'Latest code downloaded successfully.');
  assert.ok(ui.statusLine.classList.contains('is-success'), 'green status');
  assert.equal(ui.statusLine.classList.contains('is-error'), false);
  assert.equal(ui.update.disabled, false, 'Update is enabled after a successful pull');
  assert.equal(ui.pull.disabled, false, 'Pull is usable again');
  assert.equal(ui.pull.classList.contains('is-busy'), false, 'spinner cleared');
});

test('a failed pull shows the red error and keeps Update disabled', async () => {
  const ui = makeRenderer();
  await flush();
  ui.pull.click();

  await ui.finishPull({
    ok: false,
    reason: 'git-failed',
    exitCode: 128,
    stdout: '',
    stderr: "fatal: couldn't find remote ref main",
    message: 'Pull failed (exit code 128).'
  });

  assert.equal(ui.statusText.textContent, 'Pull failed (exit code 128).');
  assert.ok(ui.statusLine.classList.contains('is-error'), 'red status');
  assert.match(ui.output.textContent, /couldn't find remote ref main/, 'git stderr is displayed');
  assert.equal(ui.update.disabled, true, 'Update must stay disabled after a failure');
  assert.equal(ui.pull.disabled, false);
});

test('a throwing bridge is reported as an error instead of hanging', async () => {
  const ui = makeRenderer();
  await flush();
  ui.win.api.pull = () => {
    ui.calls.pull += 1;
    return Promise.reject(new Error('Channel closed'));
  };

  ui.pull.click();
  await flush();
  await flush();

  assert.equal(ui.statusText.textContent, 'Updater error: Channel closed');
  assert.ok(ui.statusLine.classList.contains('is-error'));
  assert.equal(ui.update.disabled, true);
  assert.equal(ui.pull.disabled, false);
});

test('double-clicking Pull only starts one pull', async () => {
  const ui = makeRenderer();
  await flush();

  ui.pull.click();
  ui.pull.click();
  ui.pull.click();

  assert.equal(ui.calls.pull, 1, 'guarded against concurrent pulls');
});

test('a new pull after a success resets Update until it succeeds again', async () => {
  const ui = makeRenderer();
  await flush();

  ui.pull.click();
  await ui.finishPull({ ok: true, message: 'Latest code downloaded successfully.' });
  assert.equal(ui.update.disabled, false);

  ui.pull.click();
  assert.equal(ui.update.disabled, true, 'Update is disabled again while pulling');
  assert.equal(ui.output.hidden, true, 'previous output is cleared');

  await ui.finishPull({ ok: false, exitCode: 1, stderr: 'fatal: offline', message: 'Pull failed (exit code 1).' });
  assert.equal(ui.update.disabled, true);
});

/* ================================================================== *
 *  Update
 * ================================================================== */

test('Update does nothing until a pull has succeeded', async () => {
  const ui = makeRenderer();
  await flush();

  ui.update.disabled = false; // force it, the handler must still refuse
  ui.update.click();
  await flush();

  assert.equal(ui.calls.restart, 0, 'no relaunch without a successful pull');
});

test('clicking Update relaunches the app and locks the UI', async () => {
  const ui = makeRenderer();
  await flush();

  ui.pull.click();
  await ui.finishPull({ ok: true, message: 'Latest code downloaded successfully.' });

  ui.update.click();
  await flush();

  assert.equal(ui.calls.restart, 1, 'window.api.restart() invoked');
  assert.equal(ui.statusText.textContent, 'Restarting application…');
  assert.equal(ui.pull.disabled, true);
  assert.equal(ui.update.disabled, true);
});

/* ================================================================== *
 *  Resilience
 * ================================================================== */

test('without the preload bridge the UI says so instead of crashing', async () => {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'http://localhost/' });
  delete dom.window.api;
  dom.window.eval(RENDERER);
  await flush();

  const text = dom.window.document.getElementById('status-text').textContent;
  assert.match(text, /bridge is unavailable/i);
  assert.equal(dom.window.document.getElementById('btn-pull').disabled, true);
  assert.equal(dom.window.document.getElementById('btn-update').disabled, true);
});

/* ================================================================== *
 *  Repository-provided UI reload (install once, pull forever)
 * ================================================================== */

test('when the pull reply announces a UI reload the page stays locked until the new UI takes over', async () => {
  const ui = makeRenderer();
  await flush();

  ui.pull.click();
  await ui.finishPull({ ok: true, uiReloading: true, message: 'Latest code downloaded successfully.' });

  assert.equal(ui.pull.disabled, true, 'no second pull while the window is being reloaded');
  assert.equal(ui.update.disabled, true, 'Update waits for the new page');
  assert.match(ui.statusText.textContent, /loading the updated interface/i);
  assert.ok(ui.statusLine.classList.contains('is-busy'));
});

test('a freshly reloaded page (?pulled=1) restores the post-pull state so Update is available', async () => {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'http://localhost/index.html?pulled=1' });
  const win = dom.window;
  win.api = {
    pull: () => new Promise(() => {}),
    restart: () => Promise.resolve({ ok: true }),
    getInfo: () => Promise.resolve({ version: '1.0.0', repoPath: 'C:\\BYD', remote: 'origin', branch: 'main', ui: { source: 'repository', hash: 'abc123' } }),
    onOutput: () => () => {},
    onState: () => () => {},
    chooseRepository: () => Promise.resolve({ ok: false, canceled: true })
  };
  win.eval(RENDERER);
  await flush();

  const doc = win.document;
  assert.equal(doc.getElementById('status-text').textContent, 'Latest code downloaded successfully.');
  assert.ok(doc.getElementById('status-line').classList.contains('is-success'));
  assert.equal(doc.getElementById('btn-update').disabled, false, 'Update is enabled after the reload');
  assert.equal(doc.getElementById('btn-pull').disabled, false, 'another pull is allowed');
  assert.match(doc.getElementById('ui-source').textContent, /from repository \(abc123\)/);
});

test('the footer says when the built-in interface is in use', async () => {
  const ui = makeRenderer({ info: { version: '1.0.0', repoPath: '', remote: 'origin', branch: 'main', ui: { source: 'packaged', hash: '' } } });
  await flush();
  assert.match(ui.doc.getElementById('ui-source').textContent, /built-in v1\.0\.0/);
});
