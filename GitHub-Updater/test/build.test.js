'use strict';

/**
 * Packaging / configuration tests.
 *
 * These validate package.json, the electron-builder build config, the shipped
 * project structure and the generated icon — everything `npm run build`
 * depends on, checked without needing the Electron binary.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const APP_DIR = path.join(__dirname, '..');
const pkg = require(path.join(APP_DIR, 'package.json'));

const exists = (rel) => fs.existsSync(path.join(APP_DIR, rel));
const read = (rel) => fs.readFileSync(path.join(APP_DIR, rel), 'utf8');

/* ----------------------------- ICO parsing ------------------------------ */

function parseIco(buffer) {
  assert.equal(buffer.readUInt16LE(0), 0, 'ICO reserved field');
  assert.equal(buffer.readUInt16LE(2), 1, 'ICO type must be 1 (icon)');
  const count = buffer.readUInt16LE(4);
  const entries = [];

  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    const width = buffer[at] === 0 ? 256 : buffer[at];
    const height = buffer[at + 1] === 0 ? 256 : buffer[at + 1];
    const size = buffer.readUInt32LE(at + 8);
    const offset = buffer.readUInt32LE(at + 12);
    const png = buffer.readUInt32BE(offset) === 0x89504e47;
    let pngWidth = null;
    let pngHeight = null;
    if (png) {
      pngWidth = buffer.readUInt32BE(offset + 16);
      pngHeight = buffer.readUInt32BE(offset + 20);
    }
    entries.push({ width, height, size, offset, png, pngWidth, pngHeight });
  }

  return entries;
}

/* ================================ tests ================================= */

test('the project ships the required structure', () => {
  const required = [
    'package.json',
    'main.js',
    'preload.js',
    'config.js',
    path.join('renderer', 'index.html'),
    path.join('renderer', 'style.css'),
    path.join('renderer', 'renderer.js'),
    path.join('assets', 'icon.ico'),
    'build'
  ];

  const missing = required.filter((rel) => !exists(rel));
  assert.deepEqual(missing, [], `missing: ${missing.join(', ')}`);
});

test('package.json is a valid Electron app manifest', () => {
  assert.equal(pkg.main, 'main.js');
  assert.equal(pkg.name, 'byd-updater');
  assert.equal(pkg.productName, 'BYD');
  assert.ok(exists(pkg.main));
  assert.equal(pkg.scripts.start, 'electron .');
  assert.equal(pkg.scripts.build, 'electron-builder --win');
  assert.ok(pkg.devDependencies.electron, 'electron is a dev dependency');
  assert.ok(pkg.devDependencies['electron-builder'], 'electron-builder is a dev dependency');
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'the app has no runtime dependencies');
});

test('the electron-builder config targets Windows and packages every runtime file', () => {
  const build = pkg.build;
  assert.equal(build.appId, 'com.byd.updater');
  assert.equal(build.productName, 'BYD');
  assert.equal(build.asar, true);

  const targets = build.win.target.map((t) => t.target);
  assert.ok(targets.includes('nsis'), 'an installer .exe is produced');
  assert.ok(targets.includes('portable'), 'a single portable .exe is produced');
  assert.deepEqual(build.win.target.flatMap((t) => t.arch), ['x64', 'x64']);

  const runtimeFiles = [
    'main.js',
    'preload.js',
    'config.js',
    path.join('renderer', 'index.html'),
    path.join('renderer', 'style.css'),
    path.join('renderer', 'renderer.js')
  ];
  for (const file of runtimeFiles) {
    const covered = build.files.some((pattern) => file === pattern || file.startsWith(pattern.replace('/**/*', '/')));
    assert.ok(covered, `${file} must be packaged`);
  }

  // Dev-only material must not ship.
  for (const pattern of build.files) {
    assert.ok(!pattern.startsWith('test'), 'tests are not packaged');
    assert.ok(!pattern.startsWith('tools'), 'the icon generator is not packaged');
  }
});

test('the Windows icon is a real multi-size ICO of at least 256x256', () => {
  const iconPath = path.join(APP_DIR, 'assets', 'icon.ico');
  assert.equal(build_icon_path(pkg), iconPath, 'build.win.icon points at assets/icon.ico');

  const entries = parseIco(fs.readFileSync(iconPath));
  assert.ok(entries.length >= 4, `expected several sizes, got ${entries.length}`);

  const largest = Math.max(...entries.map((e) => e.width));
  assert.ok(largest >= 256, `electron-builder needs >= 256x256, largest is ${largest}`);

  for (const entry of entries) {
    assert.equal(entry.png, true, 'entries are PNG-compressed');
    assert.equal(entry.pngWidth, entry.width, 'PNG dimensions match the directory entry');
    assert.equal(entry.pngHeight, entry.height);
    assert.ok(entry.size > 0);
  }
});

function build_icon_path(manifest) {
  return path.join(APP_DIR, manifest.build.win.icon);
}

test('the icon is consumable by the PE resource editor electron-builder uses', (t) => {
  let resedit;
  try {
    resedit = require('resedit');
  } catch {
    return t.skip('resedit (transitive electron-builder dependency) not installed');
  }

  // This is the same call winPackager → editWindowsResources makes when it
  // stamps assets/icon.ico into the produced .exe.
  const iconFile = resedit.Data.IconFile.from(fs.readFileSync(path.join(APP_DIR, 'assets', 'icon.ico')));
  const sizes = iconFile.icons.map((icon) => (icon.width === 0 ? 256 : icon.width));

  assert.ok(iconFile.icons.length >= 7, `expected 7 entries, got ${iconFile.icons.length}`);
  assert.ok(sizes.includes(256), 'a 256x256 entry is required for the .exe icon');
  assert.ok(sizes.includes(16), 'a 16x16 entry is required for the title bar');
});

test('config.js holds the git defaults and no repository path is hardcoded anywhere', () => {
  const config = require(path.join(APP_DIR, 'config.js'));
  assert.equal('repoPath' in config, false, 'the repository is chosen by the user, not hardcoded');
  assert.equal(typeof config.remote, 'string');
  assert.equal(typeof config.branch, 'string');
  assert.ok(config.remote && config.branch, 'remote and branch must be set');

  // main.js must not contain its own path — it reads config.js.
  const main = read('main.js');
  assert.match(main, /require\('\.\/config'\)/, 'main.js loads config.js');
  assert.doesNotMatch(main, /repoPath:\s*['"][^'"]+['"]/, 'main.js must not define a repoPath literal');
  assert.doesNotMatch(main, /['"][A-Za-z]:[\\/]/, 'main.js must not contain an absolute Windows path literal');
  assert.doesNotMatch(read('preload.js'), /['"][A-Za-z]:[\\/]/, 'preload.js must not contain an absolute Windows path literal');
});

test('preload.js builds a context-isolated bridge (behaviour tested in preload.test.js)', () => {
  const preload = read('preload.js');
  assert.match(preload, /contextBridge\.exposeInMainWorld\('api'/, 'uses contextBridge, not a global assignment');
  assert.match(
    preload,
    /require\('electron'\)/,
    'the Electron bridge is the only module preload pulls in'
  );
  assert.equal(
    preload.match(/require\(/g).length,
    1,
    'preload requires exactly one module (electron)'
  );
  assert.equal(preload.includes('nodeIntegration ='), false, 'preload never re-enables nodeIntegration');
  assert.match(preload, /git-pull/, 'pull channel present');
  assert.match(preload, /restart-app/, 'restart channel present');
});

test('renderer only uses HTML/CSS/vanilla JS with a strict CSP', () => {
  const html = read(path.join('renderer', 'index.html'));
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src 'self'/);
  assert.equal(/https?:\/\//.test(html.replace(/http:\/\/www\.w3\.org[^"]*/g, '')), false, 'no external resources');
  assert.equal(/<script[^>]+src=["'](?!renderer\.js)/.test(html), false, 'only renderer.js is loaded');
  assert.equal(html.includes('require('), false, 'no Node.js in the renderer');

  const renderer = read(path.join('renderer', 'renderer.js'));
  assert.equal(renderer.includes("require('electron')"), false, 'renderer never touches Electron directly');
  assert.equal(renderer.includes('innerHTML ='), false, 'no innerHTML injection');
  assert.match(renderer, /window\.api\.pull\(\)/);
  assert.match(renderer, /window\.api\.restart\(\)/);
});

test('node_modules and dist stay out of git', () => {
  const ignore = read('.gitignore');
  assert.match(ignore, /node_modules\//);
  assert.match(ignore, /dist\//);
});
