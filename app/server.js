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
const { runAudit } = require('./audit');
const { runAiScan } = require('./aisearch');

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

// Files that ship *with* the app rather than being written by it. In a packaged
// binary there is no source tree to read them from, so they travel inside the
// executable as assets; from a checkout they are ordinary files.
function readBundledJson(assetName, file, fallback) {
  if (seaAsset) {
    try { return JSON.parse(seaAsset(assetName, 'utf8')); }
    catch (e) { return fallback; }
  }
  return readJson(file, fallback);
}

function writeJson(file, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

// Optional defaults that travel *beside* the app, never inside it. Deliberately
// not baked into the executable and not committed: the repository is public and
// this file may hold an API key. Packaged, it is read from the folder holding
// the exe; from a checkout, from app/.
const DEFAULTS_FILE = IS_PACKAGED
  ? path.join(BASE, 'defaults.json')
  : path.join(__dirname, 'defaults.json');
let bundledDefaults = null;
function loadDefaults() {
  if (bundledDefaults === null) bundledDefaults = readJson(DEFAULTS_FILE, {});
  return bundledDefaults;
}

function loadConfig() {
  const stored = readJson(CONFIG_FILE, {});
  const defaults = loadDefaults();
  return {
    // Environment wins, so a deployment can inject secrets without a writable disk.
    clientId: process.env.GOOGLE_CLIENT_ID || stored.clientId || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || stored.clientSecret || '',
    gscSite: process.env.GSC_SITE || stored.gscSite || '',
    psiKey: process.env.PAGESPEED_API_KEY || stored.psiKey || defaults.psiKey || '',
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

/* ── Site audit ─────────────────────────────────────────────── */

let audit = { state: 'idle', crawled: 0, total: 0, result: null, error: '', url: '', startedAt: 0, stop: false };

// Gentle by default: a crawl that hammers a site also measures its own
// contention as page slowness, so pacing improves accuracy as well as manners.
const PACE = {
  gentle: { concurrency: 1, delayMs: 1000 },
  normal: { concurrency: 2, delayMs: 400 },
  brisk:  { concurrency: 4, delayMs: 150 }
};

function startAudit(startUrl, maxPages, pace) {
  const tuning = PACE[pace] || PACE.normal;
  // A replaced crawl keeps running for a while — requests are already in
  // flight — so tell the outgoing one to stop, and bind every callback below
  // to *this* job. Writing to the shared `audit` instead would let the old
  // crawl report its progress, and finally its result, as if it were the new
  // one: the status flaps between two scans and the wrong report wins.
  if (audit && audit.state === 'running') audit.stop = true;

  const job = {
    state: 'running', crawled: 0, total: 1, result: null, error: '',
    url: startUrl, startedAt: Date.now(), lastBeat: Date.now(), stop: false, paused: false,
    phase: 'crawling', phaseAt: 0, phaseOf: 0,
    maxPages, pace: pace || 'normal'
  };
  audit = job;

  const current = () => audit === job;

  runAudit(startUrl, Object.assign({ maxPages }, tuning), (done, total, phase, at, of) => {
    if (!current()) return;
    job.crawled = done;
    job.total = total;
    job.phase = phase || 'crawling';
    job.phaseAt = at || 0;
    job.phaseOf = of || 0;
    job.lastBeat = Date.now();   // proof of life for the watchdog
  }, () => job.stop, () => job.paused).then(result => {
    if (!current()) return;
    job.result = result;
    job.state = 'done';
    job.tookMs = Date.now() - job.startedAt;
  }).catch(err => {
    if (!current()) return;
    job.error = err.message || 'The crawl failed.';
    job.state = 'error';
  });
}

/* ── PageSpeed Insights ─────────────────────────────────────────
   The same Lighthouse run that powers pagespeed.web.dev, plus the
   field data Chrome collects from real visitors when there is
   enough traffic to report it.
   ─────────────────────────────────────────────────────────────── */

const CWV = {
  LARGEST_CONTENTFUL_PAINT_MS: { label: 'Largest Contentful Paint', good: 2500, poor: 4000, unit: 'ms' },
  INTERACTION_TO_NEXT_PAINT:   { label: 'Interaction to Next Paint', good: 200,  poor: 500,  unit: 'ms' },
  CUMULATIVE_LAYOUT_SHIFT_SCORE: { label: 'Cumulative Layout Shift', good: 0.1, poor: 0.25, unit: 'score' },
  FIRST_CONTENTFUL_PAINT_MS:   { label: 'First Contentful Paint', good: 1800, poor: 3000, unit: 'ms' },
  EXPERIMENTAL_TIME_TO_FIRST_BYTE: { label: 'Time to First Byte', good: 800, poor: 1800, unit: 'ms' }
};

function rate(metric, value) {
  const spec = CWV[metric];
  if (!spec) return 'unknown';
  return value <= spec.good ? 'good' : value <= spec.poor ? 'needs-improvement' : 'poor';
}

async function pageSpeed(url, strategy) {
  const cfg = loadConfig();
  const api = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  api.searchParams.set('url', url);
  api.searchParams.set('strategy', strategy === 'desktop' ? 'desktop' : 'mobile');
  ['performance', 'accessibility', 'best-practices', 'seo'].forEach(c => api.searchParams.append('category', c));
  // A key is optional; without one Google rate-limits by IP.
  if (cfg.psiKey) api.searchParams.set('key', cfg.psiKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100000);
  let res;
  try {
    res = await fetch(api.toString(), { headers: { Accept: 'application/json' }, signal: controller.signal });
  } catch (err) {
    const failure = new Error(err.name === 'AbortError'
      ? 'PageSpeed did not answer in time. Google is sometimes slow on the first run for a URL — try again.'
      : 'Could not reach the PageSpeed service: ' + (err.message || 'network error'));
    failure.status = 504;
    throw failure;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* fall through to the raw text */ }
  if (!res.ok) {
    const message = (data && data.error && data.error.message) || text.slice(0, 300) || `HTTP ${res.status}`;
    // "blocked" means the key exists but the API is not enabled for its project,
    // or the key's API restrictions exclude PageSpeed — both fixable in a minute.
    if (/are blocked|has not been used in project|is disabled/i.test(message)) {
      const blocked = new Error(
        'Your PageSpeed key was accepted, but Google is blocking the call: ' + message +
        ' Two things to check, both on the key\'s Google Cloud project. First, enable the API at ' +
        'https://console.cloud.google.com/apis/library/pagespeedonline.googleapis.com — this is the usual cause. ' +
        'Second, open the key under APIs & Services → Credentials: if "API restrictions" is set to "Restrict key", ' +
        'PageSpeed Insights API must be in the allowed list.');
      blocked.status = res.status;
      throw blocked;
    }
    const err = new Error(res.status === 429
      ? 'Google is rate-limiting PageSpeed requests from this network. A free API key removes the limit — ' +
        'create one at https://console.cloud.google.com/apis/credentials (Create credentials → API key), enable the ' +
        'PageSpeed Insights API for the project, then paste the key into Connections & API keys. ' +
        'Without a key, waiting a minute between checks usually works.'
      : message);
    err.status = res.status;
    throw err;
  }

  return shapePsi(data, strategy, url);
}

function shapePsi(data, strategy, url) {
  const lh = data.lighthouseResult || {};
  const cats = lh.categories || {};
  const audits = lh.audits || {};
  const score = key => (cats[key] && cats[key].score != null ? Math.round(cats[key].score * 100) : null);
  const lab = key => (audits[key] && audits[key].numericValue != null
    ? { value: audits[key].numericValue, display: audits[key].displayValue || '' } : null);

  // Field data — what real visitors experienced, where Chrome has enough of it.
  const field = [];
  const loading = data.loadingExperience && data.loadingExperience.metrics;
  if (loading) {
    Object.keys(loading).forEach(key => {
      if (!CWV[key]) return;
      const m = loading[key];
      field.push({
        key,
        label: CWV[key].label,
        unit: CWV[key].unit,
        value: m.percentile,
        rating: (m.category || rate(key, m.percentile)).toLowerCase().replace('_', '-')
      });
    });
  }

  // The changes with the largest measured saving, in the order worth doing.
  const opportunities = Object.keys(audits)
    .map(k => audits[k])
    .filter(a => a && a.details && a.details.type === 'opportunity' &&
                 a.details.overallSavingsMs > 100 && a.score !== 1)
    .sort((a, b) => b.details.overallSavingsMs - a.details.overallSavingsMs)
    .slice(0, 8)
    .map(a => ({
      title: a.title,
      description: (a.description || '').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)'),
      savingsMs: Math.round(a.details.overallSavingsMs)
    }));

  return {
    url: (lh.finalUrl || url),
    strategy: strategy === 'desktop' ? 'desktop' : 'mobile',
    fetchedAt: lh.fetchTime || '',
    scores: {
      performance: score('performance'),
      accessibility: score('accessibility'),
      bestPractices: score('best-practices'),
      seo: score('seo')
    },
    lab: {
      lcp: lab('largest-contentful-paint'),
      cls: lab('cumulative-layout-shift'),
      tbt: lab('total-blocking-time'),
      fcp: lab('first-contentful-paint'),
      si: lab('speed-index'),
      ttfb: lab('server-response-time')
    },
    field,
    hasFieldData: field.length > 0,
    opportunities
  };
}

module.exports = { shapePsi };

/* ── AI Search readiness ────────────────────────────────────── */

let aiScan = { state: 'idle', crawled: 0, total: 0, result: null, error: '', url: '', startedAt: 0, stop: false };

function startAiScan(startUrl, maxPages, pace) {
  const tuning = PACE[pace] || PACE.normal;
  // Same reasoning as startAudit: the outgoing scan is still winding down, so
  // stop it and keep its callbacks pointed at its own job rather than at
  // whatever is current by the time they fire.
  if (aiScan && aiScan.state === 'running') aiScan.stop = true;

  const job = {
    state: 'running', crawled: 0, total: 1, result: null, error: '',
    url: startUrl, startedAt: Date.now(), lastBeat: Date.now(), stop: false, paused: false,
    phase: 'crawling', phaseAt: 0, phaseOf: 0
  };
  aiScan = job;

  const current = () => aiScan === job;

  runAiScan(startUrl, Object.assign({ maxPages }, tuning), (done, total, phase, at, of) => {
    if (!current()) return;
    job.crawled = done;
    job.total = total;
    job.phase = phase || 'crawling';
    job.phaseAt = at || 0;
    job.phaseOf = of || 0;
    job.lastBeat = Date.now();
  }, () => job.stop, () => job.paused).then(result => {
    if (!current()) return;
    job.result = result;
    job.state = 'done';
    job.tookMs = Date.now() - job.startedAt;
  }).catch(err => {
    if (!current()) return;
    job.error = err.message || 'The scan failed.';
    job.state = 'error';
  });
}

/* ── Dashboard feed ─────────────────────────────────────────────
   Assembles every number the dashboard can show for real, from the
   sources already connected. Each block is independent: one source
   being unavailable must not blank the rest.
   ─────────────────────────────────────────────────────────────── */

// Real Semrush figures, exported from the Drive folder. Live sources override
// these wherever one is connected; they are never invented.
const SEMRUSH_FILE = path.join(__dirname, 'semrush-snapshot.json');

async function dashboardData(days) {
  const cfg = loadConfig();
  const out = { fetchedAt: new Date().toISOString(), sources: {}, notes: [] };

  const semrush = readBundledJson('semrush', SEMRUSH_FILE, null);
  if (semrush) {
    out.semrush = semrush;
    out.sources.semrush = 'export';
  } else {
    out.semrush = null;
    out.sources.semrush = 'unavailable';
  }

  const attempt = async (name, fn) => {
    try {
      out[name] = await fn();
      out.sources[name] = 'live';
    } catch (err) {
      out[name] = null;
      out.sources[name] = 'unavailable';
      out.notes.push({ source: name, reason: err.message || String(err) });
    }
  };

  await Promise.all([
    attempt('searchConsole', async () => {
      if (!cfg.gscSite) throw new Error('No Search Console property set.');
      const r = await gscReport(days, 'query');
      return {
        property: cfg.gscSite,
        clicks: r.totals.clicks,
        impressions: r.totals.impressions,
        ctr: r.totals.ctr,
        position: r.totals.position,
        days: r.labels.length,
        labels: r.labels,
        series: r.series,
        rankingQueries: r.rows.length,
        topQueries: r.rows.slice(0, 5)
      };
    }),

    attempt('analytics', async () => {
      if (!cfg.ga4Property) throw new Error('No GA4 property set.');
      const r = await ga4Report(days, 'landing');
      return {
        property: cfg.ga4Property,
        sessions: r.totals.sessions,
        users: r.totals.users,
        engaged: r.totals.engaged,
        engagementRate: r.totals.rate,
        labels: r.labels,
        series: r.series,
        topPages: r.rows.slice(0, 5)
      };
    })
  ]);

  // These come from scans this app ran itself, so they are already local.
  if (audit.state === 'done' && audit.result) {
    out.siteAudit = {
      health: audit.result.health,
      counts: audit.result.counts,
      crawled: audit.result.crawled,
      ranAt: audit.startedAt
    };
    out.sources.siteAudit = 'live';
  } else {
    out.siteAudit = null;
    out.sources.siteAudit = 'not run';
  }

  if (aiScan.state === 'done' && aiScan.result) {
    const bots = aiScan.result.access.bots;
    out.aiSearch = {
      score: aiScan.result.score,
      allowed: bots.filter(b => b.state !== 'blocked').length,
      total: bots.length,
      withSchema: aiScan.result.entity.withSchema,
      pages: aiScan.result.pagesAnalysed,
      questionShare: aiScan.result.entity.questionShare,
      ranAt: aiScan.startedAt
    };
    out.sources.aiSearch = 'live';
  } else {
    out.aiSearch = null;
    out.sources.aiSearch = 'not run';
  }

  return out;
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
        hasPsiKey: Boolean(cfg.psiKey),
        psiKeyIsBundled: Boolean(!process.env.PAGESPEED_API_KEY && !readJson(CONFIG_FILE, {}).psiKey && loadDefaults().psiKey),
        redirectUri: redirectUri(req)
      });
    }

    if (route === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      const patch = {};
      ['clientId', 'clientSecret', 'gscSite', 'ga4Property', 'ga4Measurement', 'psiKey'].forEach(k => {
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

    if (route === '/api/audit/start' && req.method === 'POST') {
      const body = await readBody(req);
      const raw = String(body.url || loadConfig().gscSite || '').trim();
      if (!raw) return send(res, 400, { error: 'Give me a URL to scan.' });
      let target;
      try {
        target = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw.replace(/^sc-domain:/, ''));
      } catch (e) {
        return send(res, 400, { error: `"${raw}" is not a URL I can crawl.` });
      }
      if (audit.state === 'running') {
        const stale = audit.lastBeat && Date.now() - audit.lastBeat > 5 * 60 * 1000;
        if (!stale && !body.force) {
          return send(res, 409, { error: 'An audit is already running.', url: audit.url });
        }
        audit.stop = true;   // let the old one wind down; this one takes over
      }
      const maxPages = Math.min(1000, Math.max(1, Number(body.maxPages) || 40));
      const pace = ['gentle', 'normal', 'brisk'].indexOf(body.pace) > -1 ? body.pace : 'normal';
      startAudit(target.toString(), maxPages, pace);
      return send(res, 200, { started: true, url: target.toString(), maxPages, pace });
    }

    if (route === '/api/pagespeed') {
      const target = url.searchParams.get('url') || loadConfig().gscSite;
      if (!target) return send(res, 400, { error: 'No URL to test.' });
      const strategy = url.searchParams.get('strategy') || 'mobile';
      return send(res, 200, await pageSpeed(target, strategy));
    }

    if (route === '/api/dashboard') {
      const days = Math.min(400, Math.max(1, Number(url.searchParams.get('days')) || 28));
      return send(res, 200, await dashboardData(days));
    }

    if (route === '/api/aisearch/start' && req.method === 'POST') {
      const body = await readBody(req);
      const raw = String(body.url || loadConfig().gscSite || '').trim();
      if (!raw) return send(res, 400, { error: 'Give me a URL to scan.' });
      let target;
      try {
        target = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw.replace(/^sc-domain:/, ''));
      } catch (e) {
        return send(res, 400, { error: `"${raw}" is not a URL I can scan.` });
      }
      if (aiScan.state === 'running') {
        const stale = aiScan.lastBeat && Date.now() - aiScan.lastBeat > 5 * 60 * 1000;
        if (!stale && !body.force) return send(res, 409, { error: 'An audit is already running.', url: aiScan.url });
        aiScan.stop = true;
      }
      startAiScan(target.toString(), Math.min(1000, Math.max(1, Number(body.maxPages) || 25)), body.pace);
      return send(res, 200, { started: true, url: target.toString() });
    }

    if (route === '/api/aisearch/pause' && req.method === 'POST') {
      const body = await readBody(req);
      const want = body.paused !== false;
      if (aiScan.state === 'running') {
        aiScan.paused = want;
        if (!want) aiScan.lastBeat = Date.now();
      }
      return send(res, 200, { paused: aiScan.paused });
    }

    if (route === '/api/aisearch/stop' && req.method === 'POST') {
      if (aiScan.state === 'running') { aiScan.stop = true; aiScan.paused = false; }
      return send(res, 200, { stopping: aiScan.state === 'running' });
    }

    if (route === '/api/aisearch/status') {
      if (aiScan.state === 'running' && !aiScan.paused && aiScan.lastBeat && Date.now() - aiScan.lastBeat > 5 * 60 * 1000) {
        aiScan.state = 'error';
        aiScan.error = 'The scan stopped responding and was abandoned. Run it again.';
      }
      return send(res, 200, {
        state: aiScan.state, crawled: aiScan.crawled, total: aiScan.total, url: aiScan.url,
        error: aiScan.error, elapsedMs: aiScan.startedAt ? Date.now() - aiScan.startedAt : 0,
        stopping: Boolean(aiScan.stop && aiScan.state === 'running'),
        paused: Boolean(aiScan.paused && aiScan.state === 'running'),
        phase: aiScan.phase || 'crawling',
        phaseAt: aiScan.phaseAt || 0,
        phaseOf: aiScan.phaseOf || 0,
        tookMs: aiScan.tookMs || 0,
        result: aiScan.state === 'done' ? aiScan.result : null
      });
    }

    if (route === '/api/audit/pause' && req.method === 'POST') {
      const body = await readBody(req);
      const want = body.paused !== false;
      if (audit.state === 'running') {
        audit.paused = want;
        // A paused crawl makes no progress, so exempt it from the watchdog.
        if (!want) audit.lastBeat = Date.now();
      }
      return send(res, 200, { paused: audit.paused });
    }

    if (route === '/api/audit/stop' && req.method === 'POST') {
      if (audit.state === 'running') { audit.stop = true; audit.paused = false; }
      return send(res, 200, { stopping: audit.state === 'running' });
    }

    if (route === '/api/audit/status') {
      // Nothing should stay "running" forever: if a crawl has made no progress
      // for five minutes it is gone, and a new one must be allowed to start.
      if (audit.state === 'running' && !audit.paused && audit.lastBeat && Date.now() - audit.lastBeat > 5 * 60 * 1000) {
        audit.state = 'error';
        audit.error = 'The crawl stopped responding and was abandoned. Run it again.';
      }
      return send(res, 200, {
        state: audit.state,
        crawled: audit.crawled,
        total: audit.total,
        url: audit.url,
        error: audit.error,
        elapsedMs: audit.startedAt ? Date.now() - audit.startedAt : 0,
        stopping: Boolean(audit.stop && audit.state === 'running'),
        paused: Boolean(audit.paused && audit.state === 'running'),
        phase: audit.phase || 'crawling',
        phaseAt: audit.phaseAt || 0,
        phaseOf: audit.phaseOf || 0,
        tookMs: audit.tookMs || 0,
        result: audit.state === 'done' ? audit.result : null
      });
    }

    if (route === '/api/ga4/properties') {
      const data = await google('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200');
      const properties = [];
      (data.accountSummaries || []).forEach(acct => {
        (acct.propertySummaries || []).forEach(prop => {
          properties.push({
            id: String(prop.property || '').replace(/^properties\//, ''),
            name: prop.displayName || '',
            account: acct.displayName || ''
          });
        });
      });
      return send(res, 200, { properties });
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

if (require.main !== module) {
  // Imported for its helpers (tests), not run as the app.
  module.exports.pageSpeed = pageSpeed;
  module.exports.runAuditRoutes = server;
} else {
server.listen(PORT, HOST, () => {
  const cfg = loadConfig();
  const tokens = readJson(TOKEN_FILE, {});
  console.log(`\n  Twin SEO running at  http://${HOST}:${PORT}`);
  console.log(`  Redirect URI          http://${HOST}:${PORT}/auth/callback`);
  console.log(`  OAuth credentials     ${cfg.clientId && cfg.clientSecret ? 'set' : 'NOT SET — add them on the Connections screen'}`);
  console.log(`  Google account        ${tokens.refresh_token ? (tokens.email || 'connected') : 'not connected'}`);
  console.log(`  Search Console        ${cfg.gscSite || '—'}`);
  console.log(`  GA4 property          ${cfg.ga4Property || '—'}`);
  console.log(`  PageSpeed key         ${cfg.psiKey ? 'set' : 'not set (Google will rate-limit)'}\n`);
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
}
