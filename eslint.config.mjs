/**
 * One rule matters here: no-undef.
 *
 * A reference to a variable that was never declared is not a syntax error, so
 * `node --check` passes and the file loads fine. It only blows up when that
 * exact line runs — which, for a check that fires on one page in a thousand,
 * can mean shipping it. That is precisely how "path is not defined" reached a
 * live scan. This catches the whole class before it leaves the machine.
 *
 * Run it with `npm run lint`, which also lints the dashboard's inline script.
 */

const NODE_GLOBALS = {
  require: 'readonly', module: 'writable', exports: 'writable',
  process: 'readonly', console: 'readonly', Buffer: 'readonly',
  __dirname: 'readonly', __filename: 'readonly',
  fetch: 'readonly', AbortController: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', TextDecoder: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly'
};

const BROWSER_GLOBALS = {
  window: 'readonly', document: 'readonly', navigator: 'readonly',
  location: 'readonly', localStorage: 'readonly', console: 'readonly',
  fetch: 'readonly', AbortController: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly',
  Event: 'readonly', CustomEvent: 'readonly', Blob: 'readonly',
  FileReader: 'readonly', crypto: 'readonly', performance: 'readonly',
  history: 'readonly', screen: 'readonly', alert: 'readonly',
  matchMedia: 'readonly', getComputedStyle: 'readonly',
  requestAnimationFrame: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly'
};

export default [
  {
    files: ['app/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: NODE_GLOBALS },
    rules: { 'no-undef': 'error' }
  },
  {
    files: ['app/**/*.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: NODE_GLOBALS },
    rules: { 'no-undef': 'error' }
  },
  {
    // Written out of dashboard/index.html by scripts/lint.mjs.
    files: ['build/dashboard.inline.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: BROWSER_GLOBALS },
    rules: { 'no-undef': 'error' }
  }
];
