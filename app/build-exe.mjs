#!/usr/bin/env node
/**
 * Builds Twin SEO into a single executable that needs no Node.js installed.
 *
 *   node app/build-exe.mjs                    # for this machine
 *   node app/build-exe.mjs --target win-x64   # a Windows .exe
 *
 * Targets: win-x64, win-arm64, darwin-x64, darwin-arm64, linux-x64, linux-arm64
 *
 * Uses Node's built-in single-executable support, so the only thing fetched
 * from npm is postject, the tool that injects the bundle into the runtime.
 *
 * One caveat worth knowing before you build for a Mac: macOS binaries must be
 * code-signed, and `codesign` only exists on macOS. A darwin build produced on
 * Linux or Windows will be refused by Gatekeeper. Build Mac binaries on a Mac.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BUILD = path.join(ROOT, 'build');

const NODE_VERSION = process.version;                 // build against the running runtime
const HOST_TARGET = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;

function readTarget(argv) {
  const eq = argv.find(a => a.startsWith('--target='));
  if (eq) return eq.slice('--target='.length);
  const i = argv.indexOf('--target');
  if (i > -1 && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1];
  return HOST_TARGET;
}
const TARGET = readTarget(process.argv.slice(2));
const [osName, arch] = TARGET.split('-');
const isWindows = osName === 'win';
const OUT = path.join(BUILD, isWindows ? 'twin-seo.exe' : 'twin-seo');

const step = msg => console.log(`  ${msg}`);

fs.mkdirSync(BUILD, { recursive: true });

/* 1. Describe the bundle. The dashboard rides along as an asset. */
const seaConfig = {
  main: path.join('app', 'server.js'),
  output: path.join('build', 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,   // the cache is rejected once the blob is relocated anyway
  assets: { dashboard: path.join('dashboard', 'index.html') }
};
const configPath = path.join(BUILD, 'sea-config.json');
fs.writeFileSync(configPath, JSON.stringify(seaConfig, null, 2));

step(`Building for ${TARGET} against Node ${NODE_VERSION}`);
step('Preparing the bundle…');
execFileSync(process.execPath, ['--experimental-sea-config', configPath], { cwd: ROOT, stdio: 'inherit' });

/* 2. Get a Node runtime for the target platform. */
async function runtimeFor(target) {
  if (target === HOST_TARGET) return process.execPath;

  const cache = path.join(BUILD, 'runtimes');
  fs.mkdirSync(cache, { recursive: true });
  const cached = path.join(cache, `node-${NODE_VERSION}-${target}${isWindows ? '.exe' : ''}`);
  if (fs.existsSync(cached)) { step(`Using cached runtime for ${target}`); return cached; }

  const base = `https://nodejs.org/dist/${NODE_VERSION}`;
  if (isWindows) {
    // Windows ships a bare node.exe — nothing to unpack.
    const url = `${base}/${target}/node.exe`;
    step(`Downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not download the ${target} runtime (HTTP ${res.status}).`);
    fs.writeFileSync(cached, Buffer.from(await res.arrayBuffer()));
    return cached;
  }

  const ext = 'tar.gz';
  const name = `node-${NODE_VERSION}-${osName === 'darwin' ? 'darwin' : 'linux'}-${arch}`;
  const url = `${base}/${name}.${ext}`;
  step(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the ${target} runtime (HTTP ${res.status}).`);
  const archive = path.join(cache, `${name}.${ext}`);
  fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  step('Unpacking…');
  execFileSync('tar', ['-xzf', archive, '-C', cache, `${name}/bin/node`], { stdio: 'inherit' });
  fs.copyFileSync(path.join(cache, name, 'bin', 'node'), cached);
  fs.chmodSync(cached, 0o755);
  return cached;
}

const runtime = await runtimeFor(TARGET);

/* 3. Copy the runtime and inject the bundle into it. */
step('Copying the runtime…');
fs.copyFileSync(runtime, OUT);
fs.chmodSync(OUT, 0o755);

// A signed runtime must have its signature stripped before injection.
if (osName === 'darwin' && process.platform === 'darwin') {
  spawnSync('codesign', ['--remove-signature', OUT], { stdio: 'ignore' });
}

step('Injecting the bundle (this is the slow part)…');
const postject = ['postject', OUT, 'NODE_SEA_BLOB', path.join(BUILD, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (osName === 'darwin') postject.push('--macho-segment-name', 'NODE_SEA');
execFileSync('npx', ['--yes', ...postject], { cwd: ROOT, stdio: 'inherit' });

if (osName === 'darwin' && process.platform === 'darwin') {
  step('Re-signing…');
  spawnSync('codesign', ['--sign', '-', OUT], { stdio: 'ignore' });
}

const size = (fs.statSync(OUT).size / 1024 / 1024).toFixed(0);
console.log(`\n  Built ${path.relative(ROOT, OUT)}  (${size} MB)\n`);

if (osName === 'darwin' && process.platform !== 'darwin') {
  console.log('  Heads up: this Mac binary is unsigned because codesign only runs on macOS.');
  console.log('  Gatekeeper will block it. Re-run this script on a Mac to get a usable build.\n');
} else if (TARGET === HOST_TARGET) {
  console.log(`  Try it:  ${path.relative(ROOT, OUT)}\n`);
} else {
  console.log(`  Copy it to a ${osName} machine and run it. Settings are written to a\n` +
              '  .data folder created next to the executable.\n');
}
