'use strict';

/**
 * BYD renderer — vanilla JS.
 * Talks to the main process exclusively through window.api.
 *
 * Button contract
 *  - "Pull from GitHub"  disabled while a pull is running
 *  - "Update"            disabled until a pull succeeds, then enabled once
 *  Both live only in .actions, directly below Danger zone.
 */

const SUCCESS_MESSAGE = 'Latest code downloaded successfully.';
const MAX_OUTPUT_LINES = 400;
const PREFS_KEY = 'byd.prefs';

const el = {
  select: document.getElementById('btn-select'),
  pull: document.getElementById('btn-pull'),
  update: document.getElementById('btn-update'),
  statusLine: document.getElementById('status-line'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  output: document.getElementById('output'),
  repoPath: document.getElementById('repo-path'),
  uiSource: document.getElementById('ui-source'),
  app: document.getElementById('app'),
  pageTitle: document.getElementById('page-title'),
  advanced: document.getElementById('advanced'),
  palette: document.getElementById('palette'),
  paletteInput: document.getElementById('palette-input'),
  paletteResults: document.getElementById('palette-results'),
  toast: document.getElementById('toast'),
  chatList: document.getElementById('chat-list'),
  chatInput: document.getElementById('chat-input'),
  chatForm: document.getElementById('chat-form'),
  historyBtn: document.getElementById('btn-history'),
  chatHistory: document.getElementById('chat-history')
};

/** 'idle' | 'pulling' | 'success' | 'error' | 'restarting' */
let phase = 'idle';
let unsubscribeOutput = null;
let unsubscribeState = null;
let paletteOn = true;
let deepThink = false;

const TITLES = {
  overview: 'Overview',
  schedule: 'Analyzing',
  cards: 'Topics',
  reports: 'Board',
  aiagents: 'AI chats',
  codearena: 'Code Arena',
  messages: 'Chats',
  assistant: 'Assistant',
  star: 'Favourites',
  settings: 'Settings',
  files: 'Files'
};

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
  } catch {
    return {};
  }
}

function savePrefs(p) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage may be unavailable in tests */
  }
}

function applyPrefs(p) {
  const root = document.documentElement;
  if (p.theme === 'light') {
    root.style.setProperty('--bg', '#f5f5f7');
    root.style.setProperty('--text', '#1d1d1f');
    root.style.setProperty('--muted', '#6e6e73');
    root.style.setProperty('--surface', '#ffffff');
    root.style.setProperty('--panel', '#ffffff');
    root.style.setProperty('--rail', '#f0f0f2');
  } else {
    root.style.setProperty('--bg', '#0B0C0F');
    root.style.setProperty('--text', '#F5F5F5');
    root.style.setProperty('--muted', '#9CA3AF');
    root.style.setProperty('--surface', '#12141A');
    root.style.setProperty('--panel', '#12141A');
    root.style.setProperty('--rail', '#101217');
  }
  if (p.accent) {
    root.style.setProperty('--accent', p.accent);
    if (p.accent === '#E60012') root.style.setProperty('--red', '#E60012');
  }
  if (typeof p.radius === 'number') {
    root.style.setProperty('--radius', `${p.radius}px`);
    const hint = document.getElementById('radius-hint');
    if (hint) hint.textContent = `${p.radius}px`;
  }
  if (p.fontScale) root.style.setProperty('--font-scale', String(p.fontScale));
  if (p.sidebar && el.app) el.app.setAttribute('data-sidebar', p.sidebar);
}

function setView(id) {
  const panels = document.querySelectorAll('[data-view-panel]');
  panels.forEach((p) => {
    p.hidden = p.getAttribute('data-view-panel') !== id;
  });
  if (el.app) el.app.setAttribute('data-view', id);
  if (el.pageTitle) el.pageTitle.textContent = TITLES[id] || 'BYD';
  document.querySelectorAll('.rail-item[data-nav]').forEach((b) => {
    b.classList.toggle('on', b.getAttribute('data-nav') === id);
  });
  if (el.historyBtn) el.historyBtn.hidden = id !== 'aiagents';
}

function toast(msg) {
  if (!el.toast) return;
  el.toast.hidden = false;
  el.toast.textContent = msg;
  setTimeout(() => { el.toast.hidden = true; }, 1800);
}

function setStatus(text, kind) {
  el.statusText.textContent = text;
  el.statusLine.classList.remove('is-busy', 'is-success', 'is-error');
  if (kind) el.statusLine.classList.add(`is-${kind}`);
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.classList.toggle('is-busy', busy);
}

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

  if (result && result.ok && result.uiReloading) {
    phase = 'restarting';
    el.pull.disabled = true;
    el.update.disabled = true;
    setStatus('Latest code downloaded — loading the updated interface…', 'busy');
    return;
  }

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
    phase = 'success';
    setStatus(`Restart failed: ${err && err.message ? err.message : String(err)}`, 'error');
    refreshUpdateButton();
  }
}

function wireChrome() {
  document.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.getAttribute('data-nav')));
  });

  const collapse = document.getElementById('btn-collapse');
  if (collapse) {
    collapse.addEventListener('click', () => {
      const p = loadPrefs();
      p.sidebar = (el.app.getAttribute('data-sidebar') === 'icons') ? 'expanded' : 'icons';
      savePrefs(p);
      applyPrefs(p);
    });
  }

  document.getElementById('btn-theme')?.addEventListener('click', () => {
    const p = loadPrefs();
    p.theme = p.theme === 'light' ? 'dark' : 'light';
    savePrefs(p);
    applyPrefs(p);
    document.querySelectorAll('#theme-seg button').forEach((b) => {
      b.classList.toggle('on', b.getAttribute('data-theme') === p.theme);
    });
  });

  document.querySelectorAll('#theme-seg button').forEach((b) => {
    b.addEventListener('click', () => {
      const p = loadPrefs();
      p.theme = b.getAttribute('data-theme');
      savePrefs(p);
      applyPrefs(p);
      document.querySelectorAll('#theme-seg button').forEach((x) => x.classList.toggle('on', x === b));
    });
  });

  document.querySelectorAll('#density-seg button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#density-seg button').forEach((x) => x.classList.toggle('on', x === b));
      const p = loadPrefs();
      p.density = b.getAttribute('data-density');
      savePrefs(p);
    });
  });

  document.querySelectorAll('#accent-swatches .swatch').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#accent-swatches .swatch').forEach((x) => x.classList.toggle('on', x === b));
      const p = loadPrefs();
      p.accent = b.getAttribute('data-accent');
      savePrefs(p);
      applyPrefs(p);
    });
  });

  document.getElementById('radius-slider')?.addEventListener('input', (e) => {
    const p = loadPrefs();
    p.radius = Number(e.target.value);
    savePrefs(p);
    applyPrefs(p);
  });

  document.getElementById('btn-advanced')?.addEventListener('click', () => {
    if (el.advanced) el.advanced.hidden = false;
  });
  const closeAdv = () => { if (el.advanced) el.advanced.hidden = true; };
  document.getElementById('adv-back')?.addEventListener('click', closeAdv);
  document.getElementById('adv-cancel')?.addEventListener('click', closeAdv);
  document.getElementById('adv-save')?.addEventListener('click', () => { toast('Saved'); closeAdv(); });

  document.querySelectorAll('.adv-nav-item').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.getAttribute('data-adv');
      document.querySelectorAll('.adv-nav-item').forEach((x) => x.classList.toggle('on', x === b));
      document.querySelectorAll('[data-adv-panel]').forEach((p) => {
        p.hidden = p.getAttribute('data-adv-panel') !== id;
      });
    });
  });

  document.getElementById('font-scale')?.addEventListener('input', (e) => {
    const p = loadPrefs();
    p.fontScale = Number(e.target.value);
    savePrefs(p);
    applyPrefs(p);
  });

  document.getElementById('btn-export')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ app: 'BYD', format: 1, prefs: loadPrefs() }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'byd-settings.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Settings exported');
  });

  document.getElementById('btn-reset')?.addEventListener('click', () => {
    localStorage.removeItem(PREFS_KEY);
    applyPrefs({ theme: 'dark', accent: '#E60012', radius: 12, sidebar: 'expanded' });
    toast('Defaults restored');
  });

  document.getElementById('ws-save')?.addEventListener('click', () => {
    const p = loadPrefs();
    p.workspaces = p.workspaces || [];
    p.workspaces.push({ name: `Look ${p.workspaces.length + 1}`, prefs: { ...p } });
    savePrefs(p);
    toast('Workspace saved');
  });

  document.getElementById('palette-on')?.addEventListener('change', (e) => {
    paletteOn = e.target.checked;
  });

  document.getElementById('deepthink')?.addEventListener('click', (e) => {
    deepThink = !deepThink;
    e.currentTarget.classList.toggle('on', deepThink);
    e.currentTarget.setAttribute('aria-checked', deepThink ? 'true' : 'false');
    e.currentTarget.textContent = deepThink ? 'DeepThink On' : 'DeepThink Off';
  });

  el.chatForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = (el.chatInput.value || '').trim();
    if (!text || !el.chatList) return;
    const empty = el.chatList.parentElement?.querySelector('.chat-empty');
    if (empty) empty.hidden = true;
    const user = document.createElement('div');
    user.className = 'bubble user';
    user.textContent = text;
    el.chatList.appendChild(user);
    const bot = document.createElement('div');
    bot.className = 'bubble assistant';
    bot.textContent = 'Local preview only — BYD does not send this to a model.';
    el.chatList.appendChild(bot);
    el.chatInput.value = '';
  });

  document.getElementById('new-chat')?.addEventListener('click', () => {
    if (el.chatList) el.chatList.textContent = '';
  });

  el.historyBtn?.addEventListener('click', () => {
    if (el.chatHistory) el.chatHistory.hidden = !el.chatHistory.hidden;
  });

  window.addEventListener('keydown', (e) => {
    if (!paletteOn) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (!el.palette) return;
      el.palette.hidden = !el.palette.hidden;
      if (!el.palette.hidden) el.paletteInput?.focus();
    }
    if (e.key === 'Escape' && el.palette && !el.palette.hidden) el.palette.hidden = true;
  });

  const commands = [
    { name: 'Settings', run: () => setView('settings') },
    { name: 'AI chats', run: () => setView('aiagents') },
    { name: 'Code Arena', run: () => setView('codearena') },
    { name: 'Files', run: () => setView('files') },
    { name: 'Dark theme', run: () => { const p = loadPrefs(); p.theme = 'dark'; savePrefs(p); applyPrefs(p); } },
    { name: 'Light theme', run: () => { const p = loadPrefs(); p.theme = 'light'; savePrefs(p); applyPrefs(p); } },
    { name: 'Advanced settings', run: () => { if (el.advanced) el.advanced.hidden = false; } }
  ];

  el.paletteInput?.addEventListener('input', () => {
    const q = el.paletteInput.value.toLowerCase();
    while (el.paletteResults.firstChild) el.paletteResults.removeChild(el.paletteResults.firstChild);
    commands.filter((c) => !q || c.name.toLowerCase().includes(q)).forEach((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'palette-item';
      b.textContent = c.name;
      b.addEventListener('click', () => { el.palette.hidden = true; c.run(); });
      el.paletteResults.appendChild(b);
    });
  });
}

function init() {
  applyPrefs(Object.assign({ theme: 'dark', accent: '#E60012', radius: 12, sidebar: 'expanded' }, loadPrefs()));
  setView('settings');
  wireChrome();

  el.select.addEventListener('click', async () => {
    const result = await window.api.chooseRepository();
    if (result && result.ok) {
      el.repoPath.textContent = `Repository: ${result.repoPath}`;
      setStatus(result.reloading ? 'Repository configured — loading its interface…' : 'Repository configured.', result.reloading ? 'busy' : 'success');
    } else if (result && !result.canceled) setStatus(result.message || 'Could not configure repository.', 'error');
  });
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
        if (el.uiSource && info.ui) {
          el.uiSource.textContent = info.ui.source === 'repository'
            ? `Interface: from repository (${info.ui.hash})`
            : `Interface: built-in v${info.version || ''}`.trim();
        }
      })
      .catch(() => {});
  }

  const params = new URLSearchParams(window.location.search);
  if (params.get('pulled') === '1') {
    phase = 'success';
    refreshUpdateButton();
    setStatus(SUCCESS_MESSAGE, 'success');
    return;
  }

  phase = 'idle';
  refreshUpdateButton();
  setStatus(params.get('repoSelected') === '1' ? 'Repository configured.' : 'Ready.', params.get('repoSelected') === '1' ? 'success' : null);
}

init();

if (typeof module !== 'undefined' && module.exports !== undefined) {
  module.exports = { handlePull, handleUpdate, init, setStatus, appendOutput };
}
