'use strict';

/**
 * Tests for the Electron main process (main.js).
 * Run with: npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { loadMain, makeRepoFixture, APP_DIR } = require('./helpers');

/* ================================================================== *
 *  Configuration
 * ================================================================== */

test('readConfig() rejects a blank repoPath with an actionable message', () => {
  const { main, config } = loadMain();
  config.repoPath = '';
  assert.throws(() => main.readConfig(), /repoPath is not set/);
});

test('readConfig() resolves the configured path to an absolute path', () => {
  const { main, config } = loadMain();
  config.repoPath = './some/relative/folder';
  const cfg = main.readConfig();
  assert.equal(path.isAbsolute(cfg.repoPath), true);
  assert.equal(cfg.remote, 'origin');
  assert.equal(cfg.branch, 'main');
});

test('readConfig() rejects a missing remote or branch', () => {
  const { main, config } = loadMain();
  config.repoPath = 'C:\\HPOS';
  config.branch = '  ';
  assert.throws(() => main.readConfig(), /remote and branch must be set/);
});

/* ================================================================== *
 *  The git command itself
 * ================================================================== */

test('buildGitInvocation() runs the pull through Windows CMD on win32', () => {
  const { main } = loadMain();
  const original = process.platform;
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const invocation = main.buildGitInvocation({ remote: 'origin', branch: 'main' });
    assert.equal(invocation.command, 'cmd.exe');
    assert.deepEqual(invocation.args, ['/d', '/s', '/c', 'git', 'pull', 'origin', 'main']);
    assert.equal(invocation.label, 'git pull origin main');
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
});

test('buildGitInvocation() honours the remote/branch from config.js', () => {
  const { main } = loadMain();
  const original = process.platform;
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const invocation = main.buildGitInvocation({ remote: 'upstream', branch: 'release' });
    assert.deepEqual(invocation.args, ['/d', '/s', '/c', 'git', 'pull', 'upstream', 'release']);
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
});

test('buildGitInvocation() calls git directly off Windows (so CI can run it)', () => {
  const { main } = loadMain();
  const invocation = main.buildGitInvocation({ remote: 'origin', branch: 'main' });
  assert.notEqual(process.platform, 'win32');
  assert.equal(invocation.command, 'git');
  assert.deepEqual(invocation.args, ['pull', 'origin', 'main']);
});

/* ================================================================== *
 *  Running a real pull
 * ================================================================== */

test('runGitPull() fast-forwards a real repository and reports success', async () => {
  const { main, config } = loadMain();
  const fixture = makeRepoFixture();
  config.repoPath = fixture.local;

  assert.equal(fs.existsSync(path.join(fixture.local, 'pulled.txt')), false, 'precondition: commit not present yet');

  const result = await main.runGitPull();

  assert.equal(result.ok, true, `expected success, got: ${result.stderr}`);
  assert.equal(result.exitCode, 0);
  assert.equal(result.message, 'Latest code downloaded successfully.');
  assert.equal(result.repoPath, fixture.local);
  assert.equal(result.command, 'git pull origin main');
  assert.ok(result.stdout.length > 0, 'stdout should be captured');
  assert.equal(fs.existsSync(path.join(fixture.local, 'pulled.txt')), true, 'the pulled commit must land on disk');
});

test('runGitPull() streams live stdout events as the command runs', async () => {
  const { main, config } = loadMain();
  const fixture = makeRepoFixture();
  config.repoPath = fixture.local;

  const events = [];
  await main.runGitPull({ onEvent: (e) => events.push(e) });

  const kinds = events.map((e) => e.type);
  assert.ok(kinds.includes('state'), 'a state event announces the command');
  assert.ok(kinds.includes('stdout'), 'stdout lines are streamed');
  assert.equal(kinds[kinds.length - 1], 'done', 'the stream always ends with done');
  assert.ok(
    events.some((e) => e.type === 'state' && e.text.includes(fixture.local)),
    'the state event names the repository being updated'
  );
});

test('runGitPull() reports failure with stderr when the remote is unreachable', async () => {
  const { main, config } = loadMain();
  const fixture = makeRepoFixture();
  // Point the clone at a remote that does not exist.
  require('./helpers').git(['remote', 'set-url', 'origin', path.join(fixture.root, 'nope.git')], fixture.local);
  config.repoPath = fixture.local;

  const result = await main.runGitPull();

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'git-failed');
  assert.notEqual(result.exitCode, 0);
  assert.ok(result.stderr.length > 0, 'stderr must be surfaced to the UI');
  assert.match(result.message, /Pull failed \(exit code \d+\)/);
});

test('runGitPull() fails cleanly when the configured folder does not exist', async () => {
  const { main, config } = loadMain();
  const missing = path.join(require('node:os').tmpdir(), 'ghupdater-does-not-exist-xyz');
  config.repoPath = missing;

  const result = await main.runGitPull();

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-folder');
  assert.ok(result.message.includes(missing), 'the message names the missing folder');
  assert.match(result.stderr, /config\.js/);
});

test('runGitPull() fails cleanly when the folder is not a git repository', async () => {
  const { main, config } = loadMain();
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghupdater-norepo-'));
  config.repoPath = dir;

  const result = await main.runGitPull();

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-a-repo');
  assert.match(result.stderr, /no \.git directory/);
});

test('runGitPull() fails cleanly when config.js has no repoPath', async () => {
  const { main, config } = loadMain();
  config.repoPath = '';

  const result = await main.runGitPull();

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'config');
  assert.match(result.stderr, /repoPath is not set/);
});

test('runGitPull() refuses to start a second pull while one is running', async () => {
  const { main, config } = loadMain();
  const fixture = makeRepoFixture();
  config.repoPath = fixture.local;

  const first = main.runGitPull(); // sets the in-flight flag synchronously
  const second = await main.runGitPull();

  assert.equal(second.ok, false);
  assert.equal(second.reason, 'busy');
  assert.match(second.message, /already running/);

  const firstResult = await first;
  assert.equal(firstResult.ok, true);

  // The flag is released, so the next pull runs again.
  const third = await main.runGitPull();
  assert.equal(third.ok, true);
  assert.match(third.stdout, /Already up to date/);
});

test('runGitPull() aborts a hung pull after the configured timeout', async () => {
  const { main, config } = loadMain();
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghupdater-hang-'));
  // A real repo so the validation passes, but make `git` hang on a lock.
  const fixture = makeRepoFixture();
  config.repoPath = fixture.local;
  config.timeoutMs = 400;

  // Freeze the index so `git pull` blocks waiting for index.lock.
  fs.writeFileSync(path.join(fixture.local, '.git', 'index.lock'), 'locked');

  const result = await main.runGitPull();

  assert.equal(result.ok, false, 'a hung pull must not be reported as success');
  assert.ok(['timeout', 'git-failed'].includes(result.reason), `unexpected reason: ${result.reason}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ================================================================== *
 *  pipeLines
 * ================================================================== */

test('pipeLines() emits complete lines and flushes the trailing partial line', () => {
  const { main } = loadMain();
  const { Readable } = require('node:stream');
  const lines = [];

  return new Promise((resolve) => {
    const stream = Readable.from(['Hel', 'lo\r\nwor', 'ld\npartial']);
    stream.on('end', () => {
      // give the 'end' handler a tick to flush
      setImmediate(() => {
        assert.deepEqual(lines, ['Hello', 'world', 'partial']);
        resolve();
      });
    });
    main.pipeLines(stream, (line) => lines.push(line));
  });
});

/* ================================================================== *
 *  IPC surface
 * ================================================================== */

test('registerIpc() exposes exactly the channels preload.js expects', () => {
  const { main, electron } = loadMain();
  main.registerIpc();

  const channels = [...electron.__handlers.keys()].sort();
  assert.deepEqual(channels, ['app-info', 'git-pull', 'restart-app']);
});

test('the git-pull IPC handler pushes live output to the renderer', async () => {
  const { main, config, electron } = loadMain();
  const fixture = makeRepoFixture();
  config.repoPath = fixture.local;

  main.registerIpc();
  const window = await main.createWindow();
  const handler = electron.__handlers.get('git-pull');

  const result = await handler({ senderId: 1, sender: window.webContents });

  assert.equal(result.ok, true, result.stderr);
  const output = window.webContents.sent.filter((m) => m.channel === 'git-pull:output');
  assert.ok(output.length > 0, 'the renderer should receive git output');
  assert.ok(output.some((m) => m.payload.type === 'stdout'), 'stdout is forwarded');
  assert.ok(output.some((m) => m.payload.type === 'done'), 'the stream is closed with done');
});

test('the restart-app IPC handler relaunches and quits the app', async () => {
  const { main, electron } = loadMain();
  main.registerIpc();
  const handler = electron.__handlers.get('restart-app');

  const reply = handler({ senderId: 7 });

  assert.equal(reply.ok, true);
  assert.equal(reply.relaunching, true);
  assert.equal(electron.__calls.relaunch, 0, 'relaunch is deferred so the reply flushes first');

  await new Promise((r) => setTimeout(r, 400));

  assert.equal(electron.__calls.relaunch, 1, 'app.relaunch() must be called');
  assert.equal(electron.__calls.quit, 1, 'app.quit() must be called');
});

test('the app-info IPC handler reports the configured repository', async () => {
  const { main, config, electron } = loadMain();
  config.repoPath = 'C:\\HPOS';
  main.registerIpc();

  const info = await electron.__handlers.get('app-info')({});

  assert.equal(info.repoPath, path.resolve('C:\\HPOS'));
  assert.equal(info.remote, 'origin');
  assert.equal(info.branch, 'main');
  assert.equal(typeof info.version, 'string');
  assert.ok(info.version.length > 0);
});

/* ================================================================== *
 *  Window
 * ================================================================== */

test('createWindow() builds the 520x420 fixed-size centred window', async () => {
  const { main } = loadMain();
  const window = await main.createWindow();
  const o = window.options;

  assert.equal(o.width, 520);
  assert.equal(o.height, 420);
  assert.equal(o.resizable, false);
  assert.equal(o.center, true);
  assert.equal(o.backgroundColor, '#0F172A');
  assert.equal(o.title, 'BYD');
  assert.equal(window.menuBarVisible, false, 'menu bar hidden');
  assert.equal(window.menuRemoved, true, 'menu removed');
  assert.ok(o.webPreferences.preload.endsWith('preload.js'));
  assert.equal(o.webPreferences.contextIsolation, true);
  assert.equal(o.webPreferences.nodeIntegration, false);
  assert.equal(o.webPreferences.sandbox, true);
  assert.ok(window.centered >= 1, 'window is centred');
  assert.ok(window.loaded.endsWith(path.join('renderer', 'index.html')), 'loads the renderer entry point');
});

/* ================================================================== *
 *  Optional project launch
 * ================================================================== */

test('launchProject() is a no-op unless config.projectLaunch is set', () => {
  const { main, config } = loadMain();
  config.projectLaunch = null;
  assert.deepEqual(main.launchProject(), { launched: false });

  config.projectLaunch = { command: process.execPath, args: ['-e', 'process.exit(0)'] };
  const events = [];
  assert.deepEqual(main.launchProject((e) => events.push(e)), { launched: true });
  assert.ok(events.some((e) => e.type === 'state'));
});

/* ================================================================== *
 *  Guardrail: paths live in config.js only
 * ================================================================== */

test('no filesystem path is hardcoded outside config.js', () => {
  const sources = [
    'main.js',
    'preload.js',
    path.join('renderer', 'renderer.js'),
    path.join('renderer', 'index.html'),
    path.join('renderer', 'style.css')
  ];

  // Matches "C:\..." or "C:/..." style absolute Windows paths.
  const drivePath = /[A-Za-z]:[\\/]{1,2}[A-Za-z0-9_.-]/;
  const offenders = [];

  for (const rel of sources) {
    const text = fs.readFileSync(path.join(APP_DIR, rel), 'utf8');
    const match = text.match(drivePath);
    if (match) offenders.push(`${rel}: ${match[0]}`);
  }

  assert.deepEqual(offenders, [], `paths must come from config.js, found: ${offenders.join(', ')}`);
});
