#!/usr/bin/env node
/**
 * Twin SEO — application server.
 *
 * Runs the dashboard as a real app instead of a sandboxed page, which is what
 * makes live Google data possible: the OAuth exchange and every API call happen
 * here, server side. The browser never sees a token, and none of the sandbox's
 * network restrictions apply.
 *
 * Zero dependencies. Node 18 or newer (it uses the built-in fetch).
 *
 *   node app/server.js
 *   → http://localhost:8080
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// When packaged as a single executable the dashboard travels inside the binary
// and settings live beside it, rather than in a source checkout.
let seaAsset = null;
try {
  const sea = require('node:sea');
  if (sea.isSea()) seaAsset = sea.getAsset;
} catch (e) { /* plain node run */ }

const IS_PACKAGED = Boolean(seaAsset);
const ROOT = path.join(__dirname, '..');
const BASE = IS_PACKAGED ? path.dirname(process.execPath) : ROOT;
const DASHBOARD = path.join(ROOT, 'dashboard', 'index.html');
const DATA_DIR = path.join(BASE, '.data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const TOKEN_FILE = path.join(DATA_DIR, 'tokens.json');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';

const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
  'openid',
  'email'   // so the dashboard can show which account is connected
].join(' ');

/* ── tiny JSON store ────────────────────────────────────────── */

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function loadConfig() {
  const stored = readJson(CONFIG_FILE, {});
  return {
    // Environment wins, so a deployment can inject secrets without a writable disk.
    clientId: process.env.GOOGLE_CLIENT_ID || stored.clientId || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || stored.clientSecret || '',
    gscSite: process.env.GSC_SITE || stored.gscSite || '',
    ga4Measurement: stored.ga4Measurement || '',
    ga4Property: String(process.env.GA4_PROPERTY_ID || stored.ga4Property || '').replace(/^properties\//, '')
  };
}

function saveConfig(patch) {
  const stored = readJson(CONFIG_FILE, {});
  writeJson(CONFIG_FILE, Object.assign(stored, patch));
}

/* ── OAuth ──────────────────────────────────────────────────── */

function redirectUri(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `${HOST}:${PORT}`;
  return `${proto}://${host}/auth/callback`;
}

async function exchangeCode(code, redirect) {
  const cfg = loadConfig();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirect,
      grant_type: 'authorization_code'
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error_description || body.error || `token exchange failed (${res.status})`);
  const tokens = readJson(TOKEN_FILE, {});
  tokens.access_token = body.access_token;
  tokens.expires_at = Date.now() + (body.expires_in || 3600) * 1000;
  // Google only returns a refresh token on the first consent; keep the old one.
  if (body.refresh_token) tokens.refresh_token = body.refresh_token;

  // The id_token carries the signed-in address; read it for display only.
  if (body.id_token) {
    try {
      const payload = JSON.parse(Buffer.from(body.id_token.split('.')[1], 'base64url').toString('utf8'));
      if (payload.email) tokens.email = payload.email;
    } catch (e) { /* display nicety; never worth failing a sign-in over */ }
  }
  writeJson(TOKEN_FILE, tokens);
  return tokens;
}

async function accessToken() {
  const tokens = readJson(TOKEN_FILE, {});
  if (tokens.access_token && tokens.expires_at && tokens.expires_at - 60000 > Date.now()) {
    return tokens.access_token;
  }
  if (!tokens.refresh_token) {
    const err = new Error('Not connected to Google yet. Open the Connections screen and sign in.');
    err.status = 401;
    throw err;
  }
  const cfg = loadConfig();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token'
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error_description || body.error || 'Could not refresh the Google token. Sign in again.');
    err.status = 401;
    throw err;
  }
  tokens.access_token = body.access_token;
  tokens.expires_at = Date.now() + (body.expires_in || 3600) * 1000;
  writeJson(TOKEN_FILE, tokens);
  return tokens.access_token;
}

async function google(url, body) {
  const token = await accessToken();
  const opts = { headers: { Authorization: `Bearer ${token}` } };
  if (body) {
    opts.method = 'POST';
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* keep the raw text for the message */ }
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || text.slice(0, 300) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ── Report queries ─────────────────────────────────────────── */

function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

const GSC_DIMS = { query: 'query', page: 'page', country: 'country', device: 'device' };
const GA4_DIMS = {
  channel: 'sessionDefaultChannelGroup',
  landing: 'landingPage',
  device: 'deviceCategory',
  country: 'country'
};

async function gscReport(days, dim) {
  const cfg = loadConfig();
  if (!cfg.gscSite) {
    const err = new Error('No Search Console property configured.');
    err.status = 400;
    throw err;
  }
  const endpoint = 'https://searchconsole.googleapis.com/webmasters/v3/sites/' +
    encodeURIComponent(cfg.gscSite) + '/searchAnalytics/query';
  // Search Console lags roughly two days.
  const range = { startDate: dayOffset(-(days + 2)), endDate: dayOffset(-2) };

  const [byDate, byDim] = await Promise.all([
    google(endpoint, Object.assign({ dimensions: ['date'], rowLimit: 500 }, range)),
    google(endpoint, Object.assign({ dimensions: [GSC_DIMS[dim] || 'query'], rowLimit: 25 }, range))
  ]);

  const dates = (byDate.rows || []).slice().sort((a, b) => (a.keys[0] < b.keys[0] ? -1 : 1));
  const totals = dates.reduce((acc, r) => {
    acc.clicks += r.clicks;
    acc.impressions += r.impressions;
    acc.posWeighted += (r.position || 0) * (r.impressions || 0);
    return acc;
  }, { clicks: 0, impressions: 0, posWeighted: 0 });

  return {
    source: 'api',
    labels: dates.map(r => r.keys[0]),
    series: {
      clicks: dates.map(r => r.clicks),
      impressions: dates.map(r => r.impressions)
    },
    totals: {
      clicks: totals.clicks,
      impressions: totals.impressions,
      ctr: totals.impressions ? (totals.clicks / totals.impressions) * 100 : 0,
      position: totals.impressions ? totals.posWeighted / totals.impressions : 0
    },
    dim,
    rows: (byDim.rows || []).map(r => ({
      key: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: (r.ctr || 0) * 100,
      position: r.position
    }))
  };
}

async function ga4Report(days, dim) {
  const cfg = loadConfig();
  if (!cfg.ga4Property) {
    const err = new Error('No GA4 property ID configured.');
    err.status = 400;
    throw err;
  }
  const endpoint = `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(cfg.ga4Property)}:runReport`;
  const dateRanges = [{ startDate: `${days}daysAgo`, endDate: 'yesterday' }];

  const [byDate, byDim] = await Promise.all([
    google(endpoint, {
      dateRanges,
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'engagedSessions' }],
      limit: 500
    }),
    google(endpoint, {
      dateRanges,
      dimensions: [{ name: GA4_DIMS[dim] || GA4_DIMS.channel }],
      metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'engagementRate' }, { name: 'keyEvents' }],
      orderBys: [{ desc: true, metric: { metricName: 'sessions' } }],
      limit: 25
    })
  ]);

  const val = (row, i) => parseFloat(row.metricValues[i].value) || 0;
  const dates = (byDate.rows || []).slice()
    .sort((a, b) => (a.dimensionValues[0].value < b.dimensionValues[0].value ? -1 : 1));
  const sum = arr => arr.reduce((a, b) => a + b, 0);
  const series = {
    sessions: dates.map(r => val(r, 0)),
    users: dates.map(r => val(r, 1)),
    engaged: dates.map(r => val(r, 2))
  };

  return {
    source: 'api',
    labels: dates.map(r => {
      const v = r.dimensionValues[0].value; // YYYYMMDD
      return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
    }),
    series,
    totals: {
      sessions: sum(series.sessions),
      users: sum(series.users),
      engaged: sum(series.engaged),
      rate: sum(series.sessions) ? (sum(series.engaged) / sum(series.sessions)) * 100 : 0
    },
    dim,
    rows: (byDim.rows || []).map(r => ({
      key: r.dimensionValues[0].value,
      sessions: val(r, 0),
      users: val(r, 1),
      engagement: val(r, 2) * 100,
      conversions: val(r, 3)
    }))
  };
}

/* ── HTTP plumbing ──────────────────────────────────────────── */

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) { reject(new Error('Request body too large.')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid JSON body.')); }
    });
    req.on('error', reject);
  });
}

// The dashboard is authored as a fragment so it can also publish as an artifact;
// the server supplies the document shell and flags that an API is available.
function readDashboard() {
  if (seaAsset) return seaAsset('dashboard', 'utf8');
  return fs.readFileSync(DASHBOARD, 'utf8');
}

function renderPage() {
  const fragment = readDashboard();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>window.TWIN_SEO_SERVER = true;</script>
</head>
<body>
${fragment}
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch (e) { return send(res, 400, { error: 'Bad request URL.' }); }
  const route = url.pathname;

  try {
    if (route === '/' || route === '/index.html') {
      return send(res, 200, renderPage(), 'text/html; charset=utf-8');
    }

    if (route === '/api/status') {
      const cfg = loadConfig();
      const tokens = readJson(TOKEN_FILE, {});
      return send(res, 200, {
        server: true,
        hasCredentials: Boolean(cfg.clientId && cfg.clientSecret),
        connected: Boolean(tokens.refresh_token),
        account: tokens.email || '',
        clientId: cfg.clientId,
        gscSite: cfg.gscSite,
        ga4Property: cfg.ga4Property,
        ga4Measurement: cfg.ga4Measurement,
        redirectUri: redirectUri(req)
      });
    }

    if (route === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      const patch = {};
      ['clientId', 'clientSecret', 'gscSite', 'ga4Property', 'ga4Measurement'].forEach(k => {
        if (typeof body[k] === 'string') patch[k] = body[k].trim();
      });
      if (patch.ga4Property) patch.ga4Property = patch.ga4Property.replace(/^properties\//, '');
      saveConfig(patch);
      return send(res, 200, { ok: true });
    }

    if (route === '/auth/google') {
      const cfg = loadConfig();
      if (!cfg.clientId || !cfg.clientSecret) {
        return send(res, 400, { error: 'Add the OAuth client ID and secret before connecting.' });
      }
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.searchParams.set('client_id', cfg.clientId);
      auth.searchParams.set('redirect_uri', redirectUri(req));
      auth.searchParams.set('response_type', 'code');
      auth.searchParams.set('scope', SCOPES);
      auth.searchParams.set('access_type', 'offline');   // we want a refresh token
      auth.searchParams.set('prompt', 'consent');
      res.writeHead(302, { Location: auth.toString() });
      return res.end();
    }

    if (route === '/auth/callback') {
      const error = url.searchParams.get('error');
      if (error) {
        return send(res, 400, `<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:40px">
          <h1 style="font-size:18px">Google declined the sign-in</h1><p><code>${escapeHtml(error)}</code></p>
          <p><a href="/">Back to the dashboard</a></p></body>`, 'text/html; charset=utf-8');
      }
      const code = url.searchParams.get('code');
      if (!code) return send(res, 400, { error: 'No authorization code returned.' });
      await exchangeCode(code, redirectUri(req));
      res.writeHead(302, { Location: '/?connected=1' });
      return res.end();
    }

    if (route === '/api/disconnect' && req.method === 'POST') {
      try { fs.unlinkSync(TOKEN_FILE); } catch (e) { /* already gone */ }
      return send(res, 200, { ok: true });
    }

    if (route === '/api/gsc/sites') {
      const data = await google('https://searchconsole.googleapis.com/webmasters/v3/sites');
      return send(res, 200, { sites: (data.siteEntry || []).map(s => s.siteUrl) });
    }

    if (route === '/api/gsc') {
      const days = Math.min(400, Math.max(1, Number(url.searchParams.get('days')) || 28));
      return send(res, 200, await gscReport(days, url.searchParams.get('dim') || 'query'));
    }

    if (route === '/api/ga4') {
      const days = Math.min(400, Math.max(1, Number(url.searchParams.get('days')) || 28));
      return send(res, 200, await ga4Report(days, url.searchParams.get('dim') || 'channel'));
    }

    return send(res, 404, { error: 'No such route.' });
  } catch (err) {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    return send(res, status, { error: err.message || 'Something went wrong.' });
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function openBrowser(url) {
  const { spawn } = require('child_process');
  const cmd = process.platform === 'win32' ? 'cmd'
            : process.platform === 'darwin' ? 'open'
            : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    // spawn reports a missing opener through an async 'error' event, not a
    // throw — without this handler that event is fatal to the whole process.
    child.on('error', () => {});
    child.unref();
  } catch (e) { /* no browser to open; the URL is printed above regardless */ }
}

server.listen(PORT, HOST, () => {
  const cfg = loadConfig();
  const tokens = readJson(TOKEN_FILE, {});
  console.log(`\n  Twin SEO running at  http://${HOST}:${PORT}`);
  console.log(`  Redirect URI          http://${HOST}:${PORT}/auth/callback`);
  console.log(`  OAuth credentials     ${cfg.clientId && cfg.clientSecret ? 'set' : 'NOT SET — add them on the Connections screen'}`);
  console.log(`  Google account        ${tokens.refresh_token ? (tokens.email || 'connected') : 'not connected'}`);
  console.log(`  Search Console        ${cfg.gscSite || '—'}`);
  console.log(`  GA4 property          ${cfg.ga4Property || '—'}\n`);
  if (process.argv.includes('--open') || IS_PACKAGED) {
    openBrowser(`http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — Twin SEO may already be running.`);
    console.error(`  Open http://${HOST}:${PORT}, or start on another port:  PORT=8081 npm start\n`);
  } else {
    console.error('\n  Could not start the server:', err.message, '\n');
  }
  process.exit(1);
});
