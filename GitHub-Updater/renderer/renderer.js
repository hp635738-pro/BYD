'use strict';

/**
 * ============================================================================
 *  GitHub Updater — renderer
 * ============================================================================
 *  Vanilla JS only. Talks to the main process exclusively through the
 *  `window.api` bridge exposed by preload.js.
 *
 *  Button contract
 *  ---------------
 *   - "Pull from GitHub"  disabled while a pull is running
 *   - "Update"            disabled until a pull succeeds, then enabled once
 * ============================================================================
 */

const SUCCESS_MESSAGE = 'Latest code downloaded successfully.';
const MAX_OUTPUT_LINES = 400;

const el = {
  pull: document.getElementById('btn-pull'),
  update: document.getElementById('btn-update'),
  statusLine: document.getElementById('status-line'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  output: document.getElementById('output'),
  repoPath: document.getElementById('repo-path')
};

/** 'idle' | 'pulling' | 'success' | 'error' | 'restarting' */
let phase = 'idle';
let unsubscribeOutput = null;
let unsubscribeState = null;

/* ------------------------------------------------------------------ *
 *  Small helpers
 * ------------------------------------------------------------------ */

function setStatus(text, kind) {
  el.statusText.textContent = text;
  el.statusLine.classList.remove('is-busy', 'is-success', 'is-error');
  if (kind) el.statusLine.classList.add(`is-${kind}`);
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.classList.toggle('is-busy', busy);
}

/** Update is only ever enabled after a successful pull. */
function refreshUpdateButton() {
  const allowed = phase === 'success';
  el.update.disabled = !allowed;
}

function clearOutput() {
  el.output.textContent = '';
  el.output.hidden = true;
}

function appendOutput(text, type) {
  if (!text) return;

  el.output.hidden = false;

  const line = document.createElement('span');
  line.className = type === 'stderr' ? 'line-err' : 'line-out';
  line.textContent = text;

  if (el.output.childNodes.length > 0) el.output.appendChild(document.createTextNode('\n'));
  el.output.appendChild(line);

  while (el.output.childNodes.length > MAX_OUTPUT_LINES * 2) {
    el.output.removeChild(el.output.firstChild);
    if (el.output.firstChild && el.output.firstChild.nodeName === '#text') {
      el.output.removeChild(el.output.firstChild);
    }
  }

  el.output.scrollTop = el.output.scrollHeight;
}

/* ------------------------------------------------------------------ *
 *  Actions
 * ------------------------------------------------------------------ */

async function handlePull() {
  if (phase === 'pulling' || phase === 'restarting') return;

  phase = 'pulling';
  setBusy(el.pull, true);
  el.update.disabled = true;
  clearOutput();
  setStatus('Pulling latest code from GitHub…', 'busy');

  let result;
  try {
    result = await window.api.pull();
  } catch (err) {
    result = {
      ok: false,
      message: `Updater error: ${err && err.message ? err.message : String(err)}`,
      stderr: ''
    };
  }

  setBusy(el.pull, false);

  if (result && result.ok) {
    phase = 'success';
    setStatus(SUCCESS_MESSAGE, 'success');
  } else {
    phase = 'error';
    const message = (result && result.message) || 'Pull failed.';
    setStatus(message, 'error');
    appendOutput((result && result.stderr) || message, 'stderr');
  }

  refreshUpdateButton();
}

async function handleUpdate() {
  if (phase !== 'success' || phase === 'restarting') return;

  phase = 'restarting';
  el.pull.disabled = true;
  el.update.disabled = true;
  setStatus('Restarting application…', 'busy');

  try {
    await window.api.restart();
  } catch (err) {
    // If the restart did not happen, hand control back to the user.
    phase = 'success';
    setStatus(`Restart failed: ${err && err.message ? err.message : String(err)}`, 'error');
    refreshUpdateButton();
  }
}

/* ------------------------------------------------------------------ *
 *  Wiring
 * ------------------------------------------------------------------ */

function init() {
  el.pull.addEventListener('click', handlePull);
  el.update.addEventListener('click', handleUpdate);

  if (!window.api || typeof window.api.pull !== 'function') {
    phase = 'error';
    setBusy(el.pull, false);
    el.pull.disabled = true;
    refreshUpdateButton();
    setStatus('Updater bridge is unavailable. Reinstall the application.', 'error');
    return;
  }

  unsubscribeOutput = window.api.onOutput((event) => {
    if (!event) return;
    if (event.type === 'done') return;
    appendOutput(event.text, event.type);
  });

  unsubscribeState = window.api.onState((event) => {
    if (!event || typeof event.text !== 'string') return;
    // Only surface progress while a pull is actually running.
    if (phase === 'pulling') setStatus(event.text, 'busy');
  });

  if (typeof window.api.getInfo === 'function') {
    window.api
      .getInfo()
      .then((info) => {
        if (!info) return;
        if (info.repoPath) {
          el.repoPath.textContent = `Repository: ${info.repoPath}`;
          el.repoPath.title = `git pull ${info.remote} ${info.branch} — ${info.repoPath}`;
        }
      })
      .catch(() => {
        /* metadata is decorative; ignore failures */
      });
  }

  phase = 'idle';
  refreshUpdateButton();
  setStatus('Ready.', null);
}

init();

/* Exposed for the automated UI test-suite (test/renderer.test.js). */
if (typeof module !== 'undefined' && module.exports !== undefined) {
  module.exports = { handlePull, handleUpdate, init, setStatus, appendOutput };
}
