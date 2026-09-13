'use strict';

/**
 * ============================================================================
 *  tools/verify-package.js — checks the payload that ships inside the .exe
 * ============================================================================
 *  Rebuilds the exact file set described by package.json → build.files,
 *  packs it into an app.asar with the same @electron/asar library
 *  electron-builder uses, then asserts:
 *
 *    - every runtime file is present inside the archive
 *    - dev-only material (test/, tools/, node_modules) is NOT present
 *    - the packed main.js is byte-identical to the source
 *    - the packed package.json points at main.js
 *
 *  This is the part of `npm run build` that can be validated without
 *  downloading the Electron Windows runtime.
 *
 *      npm run verify:package
 * ============================================================================
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const asar = require('@electron/asar');

const APP_DIR = path.join(__dirname, '..');
const pkg = require(path.join(APP_DIR, 'package.json'));

/** Expand the simple glob patterns electron-builder's `files` accepts. */
function expand(patterns) {
  const files = new Set();

  const walk = (dir, base) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else files.add(rel);
    }
  };

  for (const pattern of patterns) {
    if (pattern.endsWith('/**/*')) {
      const dir = path.join(APP_DIR, pattern.slice(0, -'/**/*'.length));
      if (fs.existsSync(dir)) walk(dir, pattern.slice(0, -'/**/*'.length));
    } else if (fs.existsSync(path.join(APP_DIR, pattern))) {
      files.add(pattern.replace(/\\/g, '/'));
    }
  }

  return [...files].sort();
}

async function main() {
  const files = expand(pkg.build.files);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ghupdater-pkg-'));

  for (const rel of files) {
    const dest = path.join(stage, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(APP_DIR, rel), dest);
  }

  const archive = path.join(stage, 'app.asar');
  await asar.createPackage(stage, archive);

  const listed = asar.listPackage(archive).map((p) => p.replace(/\\/g, '/').replace(/^\//, ''));
  console.log('Packed into app.asar:');
  for (const entry of listed) console.log(`  ${entry}`);

  const failures = [];
  const mustHave = [
    'main.js',
    'preload.js',
    'config.js',
    'package.json',
    'renderer/index.html',
    'renderer/style.css',
    'renderer/renderer.js',
    'assets/icon.ico'
  ];
  for (const entry of mustHave) {
    if (!listed.includes(entry)) failures.push(`missing from the package: ${entry}`);
  }

  const mustNotHave = ['test', 'tools', 'node_modules', 'dist', '.gitignore'];
  for (const entry of mustNotHave) {
    if (listed.some((p) => p === entry || p.startsWith(`${entry}/`))) {
      failures.push(`dev-only material shipped: ${entry}`);
    }
  }

  const packedMain = asar.extractFile(archive, 'main.js');
  if (!packedMain.equals(fs.readFileSync(path.join(APP_DIR, 'main.js')))) {
    failures.push('packed main.js differs from the source file');
  }

  const packedPkg = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  if (packedPkg.main !== 'main.js') failures.push('packed package.json main is not main.js');
  if (packedPkg.name !== 'github-updater') failures.push('packed package.json name is wrong');

  const size = fs.statSync(archive).size;
  console.log(`\napp.asar size: ${size} bytes`);

  fs.rmSync(stage, { recursive: true, force: true });

  if (failures.length) {
    console.error('\nFAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('OK: the packaged payload is complete and clean.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
