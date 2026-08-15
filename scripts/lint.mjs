#!/usr/bin/env node
/**
 * Lints the server code and the dashboard's inline script.
 *
 * The dashboard is a single HTML file with its JavaScript inline, so it is
 * invisible to any linter until the script is written out on its own. This
 * extracts it to build/ (git-ignored) and runs ESLint over that plus app/.
 *
 *   npm run lint
 *
 * ESLint is not a dependency of this project — it needs nothing installed to
 * run — so if it is missing this says so and exits without failing a build.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'dashboard.inline.js');

const html = fs.readFileSync(path.join(ROOT, 'dashboard', 'index.html'), 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!blocks.length) {
  console.error('  No inline <script> found in dashboard/index.html — has the file changed shape?');
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, blocks.join('\n;\n'));
console.log(`  Extracted ${blocks.length} inline script block(s) from the dashboard.`);

const targets = ['app', path.relative(ROOT, OUT)];
const run = spawnSync('npx', ['--no-install', 'eslint', ...targets], { cwd: ROOT, stdio: 'inherit' });

if (run.error || run.status === null) {
  console.log('\n  ESLint is not installed, so nothing was checked.');
  console.log('  Install it once with:  npm i -D eslint\n');
  process.exit(0);
}
if (run.status === 0) console.log('\n  Clean — no undefined references.\n');
process.exit(run.status);
