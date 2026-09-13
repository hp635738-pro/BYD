'use strict';

/**
 * Packaging / configuration tests (Ubuntu 24.04 LTS).
 *
 * These validate package.json, the electron-builder Linux build config, the
 * shipped project structure and the generated PNG icon — everything
 * `npm run build` depends on, checked without needing the Electron binary.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const APP_DIR = path.join(__dirname, '..');
const pkg = require(path.join(APP_DIR, 'package.json'));

const exists = (rel) => fs.existsSync(path.join(APP_DIR, rel));
const read = (rel) => fs.readFileSync(path.join(APP_DIR, rel), 'utf8');

/* ----------------------------- PNG parsing ------------------------------ */

/** Minimal but strict PNG header/structure reader (IHDR + chunk walk). */
function parsePng(buffer) {
  assert.equal(buffer.readUInt32BE(0), 0x89504e47, 'PNG signature (first half)');
  assert.equal(buffer.readUInt32BE(4), 0x0d0a1a0a, 'PNG signature (second half)');

  const chunks = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    chunks.push({ type, length });
    offset += 12 + length;
  }

  const ihdr = buffer.subarray(16, 16 + 13);
  return {
    chunks,
    width: ihdr.readUInt32BE(0),
    height: ihdr.readUInt32BE(4),
    bitDepth: ihdr[8],
    colorType: ihdr[9]
  };
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
    path.join('assets', 'icon.png'),
    'build'
  ];

  const missing = required.filter((rel) => !exists(rel));
  assert.deepEqual(missing, [], `missing: ${missing.join(', ')}`);
});

test('no Windows packaging artifacts remain anywhere in the project', () => {
  // No .ico icons, no installer scripts, no Windows executables.
  for (const dir of ['assets', 'build', 'renderer', 'tools']) {
    const offenders = fs
      .readdirSync(path.join(APP_DIR, dir), { withFileTypes: true })
      .filter((e) => /\.(ico|exe|nsh|dll)$/i.test(e.name))
      .map((e) => path.join(dir, e.name));
    assert.deepEqual(offenders, [], `${dir} still holds Windows artifacts`);
  }

  const manifest = read('package.json');
  assert.doesNotMatch(manifest, /nsis|portable|\.ico|"win"/i, 'package.json carries no Windows packaging');
  assert.doesNotMatch(manifest, /--win\b/, 'no script builds for Windows');

  const main = read('main.js');
  assert.doesNotMatch(main, /win32/, 'main.js has no Windows code path');
  assert.doesNotMatch(main, /cmd\.exe|ComSpec/, 'the pull never goes through CMD');
  assert.doesNotMatch(main, /windowsHide/, 'no Windows-only spawn flags');
  assert.doesNotMatch(main, /%APPDATA%/, 'no Windows environment paths');
});

test('package.json is a valid Electron app manifest for Linux', () => {
  assert.equal(pkg.main, 'main.js');
  assert.equal(pkg.name, 'byd-updater');
  assert.equal(pkg.productName, 'BYD');
  assert.ok(exists(pkg.main));
  assert.equal(pkg.scripts.start, 'electron .');
  assert.equal(pkg.scripts.build, 'electron-builder --linux');
  assert.equal(pkg.scripts['build:appimage'], 'electron-builder --linux AppImage');
  assert.equal(pkg.scripts['build:deb'], 'electron-builder --linux deb');
  assert.equal(pkg.scripts.pack, 'electron-builder --linux --dir');
  assert.ok(pkg.devDependencies.electron, 'electron is a dev dependency');
  assert.ok(pkg.devDependencies['electron-builder'], 'electron-builder is a dev dependency');
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'the app has no runtime dependencies');
});

test('the electron-builder config is Linux-only and packages every runtime file', () => {
  const build = pkg.build;
  assert.equal(build.appId, 'com.byd.updater');
  assert.equal(build.productName, 'BYD');
  assert.equal(build.asar, true);

  // Windows support is gone.
  assert.equal('win' in build, false, 'no Windows platform config');
  assert.equal('nsis' in build, false, 'no NSIS installer config');
  assert.equal('portable' in build, false, 'no portable .exe config');
  assert.equal('mac' in build, false, 'Ubuntu only — no macOS config');

  const linux = build.linux;
  assert.ok(linux, 'a linux build section exists');
  const targets = linux.target.map((t) => t.target);
  assert.deepEqual(targets, ['AppImage', 'deb'], 'AppImage is primary, deb optional');
  assert.deepEqual(linux.target.flatMap((t) => t.arch), ['x64', 'x64']);

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

test('the AppImage artifact is dist/BYD-<version>.AppImage', () => {
  const linux = pkg.build.linux;
  const pattern = pkg.build.appImage.artifactName;
  assert.equal(pattern, '${productName}-${version}.${ext}');
  assert.equal(linux.icon, 'assets/icon.png', 'the Linux icon is a .png');

  // Expand the pattern exactly like electron-builder's macroExpander does:
  // ${productName} = sanitizedProductName, ${version} = pkg.version.
  const expanded = pattern
    .replace('${productName}', pkg.build.productName)
    .replace('${version}', pkg.version)
    .replace('${ext}', 'AppImage');
  assert.equal(expanded, `BYD-${pkg.version}.AppImage`);

  // The deb keeps debian's conventional naming (<name>_<version>_<arch>.deb),
  // i.e. no artifactName override that would rename it.
  assert.equal(pkg.build.deb.artifactName, undefined, 'deb uses electron-builder default naming');
});

test('the Linux desktop integration is wired for Ubuntu/GNOME', () => {
  const linux = pkg.build.linux;
  assert.equal(linux.executableName, 'byd', 'lower-case binary, /opt/BYD/byd in the .deb');
  assert.equal(linux.category, 'Utility');
  assert.ok(linux.maintainer, 'deb packaging needs a maintainer');
  assert.match(linux.maintainer, /.+ <.+@.+>/, 'maintainer must carry an e-mail address');
  assert.equal(linux.syncDesktopName, true, 'the .desktop file is named after desktopName');
  assert.equal(pkg.desktopName, 'byd.desktop', 'Electron derives app_id/WM_CLASS from it');
  assert.ok(linux.depends || pkg.build.deb.depends.includes('git'), 'the deb declares git');
});

test('the Linux icon is a real RGBA PNG of at least 256x256', () => {
  const iconPath = path.join(APP_DIR, pkg.build.linux.icon);
  const png = parsePng(fs.readFileSync(iconPath));

  assert.equal(png.bitDepth, 8);
  assert.equal(png.colorType, 6, 'truecolour with alpha (RGBA)');
  assert.ok(png.width >= 256, `electron-builder needs >= 256x256, got ${png.width}`);
  assert.equal(png.width, png.height, 'the icon is square');
  assert.equal(png.width, 512, 'the master icon is a crisp 512x512');
  assert.ok(png.chunks.some((c) => c.type === 'IHDR'));
  assert.ok(png.chunks.some((c) => c.type === 'IDAT'));
  assert.equal(png.chunks[png.chunks.length - 1].type, 'IEND', 'the PNG terminates correctly');
});

test('the build config validates against electron-builder\'s own schema', (t) => {
  let Ajv;
  let scheme;
  try {
    Ajv = require('ajv');
    scheme = require('app-builder-lib/scheme.json');
  } catch {
    return t.skip('electron-builder internals (ajv / scheme.json) not installed');
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(scheme);
  const ok = validate(pkg.build);
  assert.equal(ok, true, `electron-builder rejects the config: ${JSON.stringify(validate.errors)}`);
});

test('config.js holds the git defaults and no repository path is hardcoded anywhere', () => {
  const config = require(path.join(APP_DIR, 'config.js'));
  assert.equal('repoPath' in config, false, 'the repository is chosen by the user, not hardcoded');
  assert.equal(typeof config.remote, 'string');
  assert.equal(typeof config.branch, 'string');
  assert.ok(config.remote && config.branch, 'remote and branch must be set');
  assert.equal(config.gitPath, 'git', 'git comes from PATH on Ubuntu');

  // main.js must not contain its own path — it reads config.js.
  const main = read('main.js');
  assert.match(main, /require\('\.\/config'\)/, 'main.js loads config.js');
  assert.doesNotMatch(main, /repoPath:\s*['"][^'"]+['"]/, 'main.js must not define a repoPath literal');
  assert.doesNotMatch(main, /['"][A-Za-z]:[\\/]/, 'main.js must not contain an absolute Windows path literal');
  assert.doesNotMatch(read('preload.js'), /['"][A-Za-z]:[\\/]/, 'preload.js must not contain an absolute Windows path literal');
});

test('every per-user path is resolved through Electron\'s app.getPath()', () => {
  const main = read('main.js');
  // Settings, ui-cache and the picker default all come from app.getPath().
  assert.match(main, /app\.getPath\('userData'\)/, 'settings.json + ui-cache under XDG config');
  assert.match(main, /app\.getPath\('home'\)/, 'the directory chooser starts at $HOME');
  assert.doesNotMatch(main, /\/home\/[a-z]|\/root\/|\/Users\//, 'no absolute POSIX prefix in the sources');
  assert.doesNotMatch(main, /process\.env\.HOME/, 'no hand-rolled env lookups');
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
  assert.doesNotMatch(ignore, /\.exe/, 'the ignore file documents Linux outputs');
});
