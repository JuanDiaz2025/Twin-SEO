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
// The last scan of each kind, kept on disk. Without this the dashboard forgets
// every scan the moment the app closes, and shows "not run" over results that
// were gathered five minutes earlier.
const SCANS_FILE = path.join(DATA_DIR, 'scans.json');
// The keyword list this app checks positions for. The bundled file is only a
// starting point; once edited in the app, the edited copy here wins.
const KEYWORDS_FILE = path.join(DATA_DIR, 'keywords.json');

// Overridable so the ranking logic can be exercised against a stand-in
// Search Console rather than the live property.
const GSC_API = process.env.GSC_API_BASE || 'https://searchconsole.googleapis.com';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';

const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
  // drive.file is the narrow one: it grants access only to files this app
  // itself creates, never to anything already in the Drive. It is what lets a
  // finished scan reach the shared dashboard page.
  'https://www.googleapis.com/auth/drive.file',
  'openid',
  'email'   // so the dashboard can show which account is connected
].join(' ');

// The files this app keeps in Drive. Fixed names, updated in place, so a scan a
// minute apart does not leave a trail of copies.
const DRIVE_FILE = 'twin-seo-live.json';    // the finished report
const STATUS_FILE_NAME = 'twin-seo-status.json'; // heartbeat and live progress

// The request channel. Its NAME is the message — see the remote-scan section.
const SIGNAL_PREFIX = 'twin-seo-scan';
const SIGNAL_IDLE = `${SIGNAL_PREFIX}.idle.json`;

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
    semrushKey: process.env.SEMRUSH_API_KEY || stored.semrushKey || defaults.semrushKey || '',
    ga4Measurement: stored.ga4Measurement || '',
    ga4Property: String(process.env.GA4_PROPERTY_ID || stored.ga4Property || '').replace(/^properties\//, ''),
    // Whether the shared page may ask this machine to start a scan. On unless
    // it has been turned off — off, the Scan now button there does nothing.
    remoteScans: stored.remoteScans !== false
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
  const endpoint = GSC_API + '/webmasters/v3/sites/' +
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

/* ── Rankings, measured rather than estimated ───────────────────
   Semrush estimates where a site ranks by sampling the SERP. Search
   Console reports where it actually ranked, for every query that drew
   an impression — so once GSC is connected the estimate is the weaker
   number. This builds the position distribution and the real movement
   between two consecutive windows.

   It is as live as the source allows, and no faster: Google publishes
   Search Console data on roughly a two-day delay, one row per day.
   Nothing gives a true up-to-the-second rank, including Semrush.
   ─────────────────────────────────────────────────────────────── */
const BUCKETS = [
  { key: 'top3',   label: 'Top 3',  test: p => p <= 3 },
  { key: 'p4_10',  label: '4–10',   test: p => p > 3 && p <= 10 },
  { key: 'p11_20', label: '11–20',  test: p => p > 10 && p <= 20 },
  { key: 'p21_50', label: '21–50',  test: p => p > 20 && p <= 50 },
  { key: 'p51',    label: '51–100', test: p => p > 50 }
];

/* ── Tracked keywords ───────────────────────────────────────────
   The distribution above answers "where do I rank for what Google
   already shows me for". It cannot answer "where do I stand on the
   terms that matter", because a keyword you rank nowhere for draws no
   impressions and so has no row in Search Console at all — it is
   invisible in exactly the data you would use to look for it.

   So the target list is kept here and matched against what Search
   Console returns. A term with no match is reported as not seen, which
   is the finding: nobody reached the site on it in this window.

   One limit stated plainly rather than papered over: absence means no
   impressions, not a measured position of 101. Google reports a
   position only where it served an impression. A true rank check for
   an unranked term needs a SERP scrape or a rank-tracker subscription,
   and this app does neither.
   ─────────────────────────────────────────────────────────────── */
const KEYWORDS_BUNDLED = path.join(__dirname, 'keywords.json');

function defaultKeywords() {
  return readBundledJson('keywords', KEYWORDS_BUNDLED,
    { version: 1, geoTemplates: [], cities: [], groups: [] });
}

function loadKeywords() {
  const saved = readJson(KEYWORDS_FILE, null);
  return saved && Array.isArray(saved.groups) ? saved : defaultKeywords();
}

// Search Console reports what people typed. Case, punctuation and doubled
// spaces all vary between a target term and a real query, and none of them is
// a different search.
function normaliseQuery(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Every target term, with the geo templates expanded across the city list.
function expandKeywords(list) {
  const out = [];
  const seen = new Set();
  const add = (term, group, label, city) => {
    const norm = normaliseQuery(term);
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    out.push({ term: String(term).trim(), norm, group, groupLabel: label, city: city || null });
  };
  (list.groups || []).forEach(g => {
    (g.terms || []).forEach(t => add(t, g.key, g.label));
  });
  const cities = list.cities || [];
  const templates = list.geoTemplates || [];
  cities.forEach(city => {
    templates.forEach(t => add(String(t).replace(/\{city\}/gi, city), 'geo', 'By city', city));
  });
  return out;
}

// A target term matches a query outright, or — failing that — any query that
// contains all of its words. "sell my house fast san jose" should not be
// called unranked because the impression landed on "sell my house fast in san
// jose ca". A contains-match is labelled as one rather than passed off as exact.
function matchTracked(list, rows, priorPos) {
  const targets = expandKeywords(list);
  const exact = new Map();
  rows.forEach(r => {
    const n = normaliseQuery(r.query);
    const prev = exact.get(n);
    if (!prev || r.impressions > prev.impressions) exact.set(n, r);
  });

  // Index by word so a contains-match does not rescan every query per target.
  const byWord = new Map();
  rows.forEach(r => {
    new Set(normaliseQuery(r.query).split(' ')).forEach(w => {
      if (!byWord.has(w)) byWord.set(w, []);
      byWord.get(w).push(r);
    });
  });

  const items = targets.map(t => {
    const hit = exact.get(t.norm);
    if (hit) {
      const was = priorPos.get(hit.query);
      return {
        term: t.term, group: t.group, groupLabel: t.groupLabel, city: t.city,
        match: 'exact', via: hit.query,
        position: hit.position, clicks: hit.clicks,
        impressions: hit.impressions, ctr: hit.ctr,
        was: was === undefined ? null : was,
        delta: was === undefined ? null : was - hit.position   // positive = climbed
      };
    }

    const words = t.norm.split(' ');
    const rarest = words
      .map(w => byWord.get(w) || [])
      .sort((a, b) => a.length - b.length)[0] || [];
    let best = null;
    rarest.forEach(r => {
      const n = normaliseQuery(r.query);
      const has = words.every(w => n === w || n.startsWith(w + ' ') ||
        n.endsWith(' ' + w) || n.indexOf(' ' + w + ' ') > -1);
      if (!has) return;
      if (!best || r.position < best.position ||
         (r.position === best.position && r.impressions > best.impressions)) best = r;
    });

    if (best) {
      const was = priorPos.get(best.query);
      return {
        term: t.term, group: t.group, groupLabel: t.groupLabel, city: t.city,
        match: 'variant', via: best.query,
        position: best.position, clicks: best.clicks,
        impressions: best.impressions, ctr: best.ctr,
        was: was === undefined ? null : was,
        delta: was === undefined ? null : was - best.position
      };
    }

    return {
      term: t.term, group: t.group, groupLabel: t.groupLabel, city: t.city,
      match: 'none', via: null, position: null, clicks: 0, impressions: 0, ctr: 0,
      was: null, delta: null
    };
  });

  const ranked = items.filter(i => i.position != null);
  const groups = {};
  items.forEach(i => {
    const g = groups[i.group] || (groups[i.group] = {
      key: i.group, label: i.groupLabel, total: 0, seen: 0, top10: 0, top3: 0, clicks: 0
    });
    g.total++;
    if (i.position != null) {
      g.seen++;
      if (i.position <= 10) g.top10++;
      if (i.position <= 3) g.top3++;
      g.clicks += i.clicks;
    }
  });

  // Per city, the best position across that city's templates — the local
  // scoreboard across a 97-city service area, which a flat list buries.
  const cityMap = {};
  items.filter(i => i.city).forEach(i => {
    const c = cityMap[i.city] || (cityMap[i.city] = {
      city: i.city, total: 0, seen: 0, best: null, clicks: 0, impressions: 0
    });
    c.total++;
    if (i.position != null) {
      c.seen++;
      c.clicks += i.clicks;
      c.impressions += i.impressions;
      if (c.best == null || i.position < c.best) c.best = i.position;
    }
  });

  return {
    total: items.length,
    seen: ranked.length,
    notSeen: items.length - ranked.length,
    top3: ranked.filter(i => i.position <= 3).length,
    top10: ranked.filter(i => i.position <= 10).length,
    exactMatches: items.filter(i => i.match === 'exact').length,
    variantMatches: items.filter(i => i.match === 'variant').length,
    groups: Object.keys(groups).map(k => groups[k]),
    cities: Object.keys(cityMap).map(k => cityMap[k])
      .sort((a, b) => (a.best == null) - (b.best == null) ||
        (a.best || 999) - (b.best || 999) || a.city.localeCompare(b.city)),
    items: items
  };
}

/* ── Before and after ───────────────────────────────────────────
   The rolling window answers "how are we doing lately". It cannot
   answer "did the work pay off", because the thing you want to
   compare against is a fixed date, not a sliding one — the month
   before the work stopped, against the weeks since it restarted.

   So this takes two explicit ranges and reports the change between
   them. Clicks and impressions are summed by Google itself rather
   than from the query rows, because Google withholds low-volume
   queries and the rows never add up to the true total.
   ─────────────────────────────────────────────────────────────── */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
}

// A percentage change needs a baseline. Going from nothing to something has
// no percentage, and reporting one as "+100%" or "+Infinity" would be worse
// than saying so.
function change(from, to) {
  const diff = to - from;
  return {
    from, to, diff,
    pct: from > 0 ? (diff / from) * 100 : null,
    fromZero: from === 0 && to > 0
  };
}

async function compareWindows(a, b) {
  const cfg = loadConfig();
  if (!cfg.gscSite) throw new Error('No Search Console property set.');
  const endpoint = GSC_API + '/webmasters/v3/sites/' +
    encodeURIComponent(cfg.gscSite) + '/searchAnalytics/query';

  const totals = range => google(endpoint, Object.assign({ type: 'web' }, range));
  const queries = range => google(endpoint,
    Object.assign({ dimensions: ['query'], rowLimit: 5000, type: 'web' }, range));

  const [ta, tb, qa, qb] = await Promise.all([totals(a), totals(b), queries(a), queries(b)]);

  const headline = t => {
    const r = (t.rows || [])[0] || {};
    return {
      clicks: r.clicks || 0,
      impressions: r.impressions || 0,
      ctr: (r.ctr || 0) * 100,
      position: r.position || 0
    };
  };

  const shape = (range, t, q) => {
    const rows = (q.rows || []).map(r => ({
      query: r.keys[0], clicks: r.clicks, impressions: r.impressions,
      ctr: (r.ctr || 0) * 100, position: r.position
    }));
    const imp = rows.reduce((n, r) => n + r.impressions, 0);
    const page1 = rows.filter(r => r.position <= 10).reduce((n, r) => n + r.impressions, 0);
    return Object.assign({
      startDate: range.startDate,
      endDate: range.endDate,
      days: daysBetween(range.startDate, range.endDate),
      queries: rows.length,
      top3: rows.filter(r => r.position <= 3).length,
      top10: rows.filter(r => r.position <= 10).length,
      page1Share: imp ? (page1 / imp) * 100 : 0,
      rows
    }, headline(t));
  };

  const before = shape(a, ta, qa);
  const after = shape(b, tb, qb);

  // Per-day, because two windows of different lengths cannot be compared on
  // totals alone — a longer window wins on clicks without ranking any better.
  const perDay = (v, d) => (d > 0 ? v / d : 0);

  const kpis = [
    { key: 'clicks', label: 'Clicks', better: 'up', fmt: 'int',
      v: change(before.clicks, after.clicks) },
    { key: 'clicksPerDay', label: 'Clicks per day', better: 'up', fmt: 'dec',
      v: change(perDay(before.clicks, before.days), perDay(after.clicks, after.days)) },
    { key: 'impressions', label: 'Impressions', better: 'up', fmt: 'int',
      v: change(before.impressions, after.impressions) },
    { key: 'impressionsPerDay', label: 'Impressions per day', better: 'up', fmt: 'dec',
      v: change(perDay(before.impressions, before.days), perDay(after.impressions, after.days)) },
    { key: 'ctr', label: 'Click-through rate', better: 'up', fmt: 'pct',
      v: change(before.ctr, after.ctr) },
    // The one KPI where down is the win, so it is flagged rather than left to
    // a reader to remember.
    { key: 'position', label: 'Average position', better: 'down', fmt: 'dec',
      v: change(before.position, after.position) },
    { key: 'queries', label: 'Keywords with impressions', better: 'up', fmt: 'int',
      v: change(before.queries, after.queries) },
    { key: 'top10', label: 'Keywords on page one', better: 'up', fmt: 'int',
      v: change(before.top10, after.top10) },
    { key: 'top3', label: 'Keywords in the top three', better: 'up', fmt: 'int',
      v: change(before.top3, after.top3) },
    { key: 'page1Share', label: 'Impressions on page one', better: 'up', fmt: 'pct',
      v: change(before.page1Share, after.page1Share) }
  ];

  // Query-level movement between the two windows.
  const bMap = new Map();
  before.rows.forEach(r => bMap.set(r.query, r));
  const aMap = new Map();
  after.rows.forEach(r => aMap.set(r.query, r));

  const moved = [];
  after.rows.forEach(r => {
    const was = bMap.get(r.query);
    if (!was) return;
    moved.push({
      query: r.query, from: was.position, to: r.position,
      delta: was.position - r.position,                      // positive = climbed
      clicks: r.clicks, clicksBefore: was.clicks, impressions: r.impressions
    });
  });
  moved.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || y.impressions - x.impressions);

  const gained = after.rows.filter(r => !bMap.has(r.query))
    .sort((x, y) => y.impressions - x.impressions)
    .map(r => ({ query: r.query, position: r.position, clicks: r.clicks, impressions: r.impressions }));
  const lost = before.rows.filter(r => !aMap.has(r.query))
    .sort((x, y) => y.impressions - x.impressions)
    .map(r => ({ query: r.query, position: r.position, clicks: r.clicks, impressions: r.impressions }));

  // The same comparison against the tracked list, which is the one that speaks
  // to intent rather than to whatever Google happened to show the site for.
  let tracked = null;
  try {
    const list = loadKeywords();
    const beforeT = matchTracked(list, before.rows, new Map());
    const afterT = matchTracked(list, after.rows, new Map());
    const seenBefore = new Set(beforeT.items.filter(i => i.position != null).map(i => i.term));
    const seenAfter = new Set(afterT.items.filter(i => i.position != null).map(i => i.term));
    tracked = {
      total: afterT.total,
      seen: change(beforeT.seen, afterT.seen),
      top10: change(beforeT.top10, afterT.top10),
      top3: change(beforeT.top3, afterT.top3),
      citiesSeen: change(
        beforeT.cities.filter(c => c.seen > 0).length,
        afterT.cities.filter(c => c.seen > 0).length),
      newlyRanking: afterT.items
        .filter(i => i.position != null && !seenBefore.has(i.term))
        .sort((x, y) => x.position - y.position)
        .map(i => ({ term: i.term, group: i.groupLabel, position: i.position, impressions: i.impressions })),
      stoppedRanking: beforeT.items
        .filter(i => i.position != null && !seenAfter.has(i.term))
        .sort((x, y) => x.position - y.position)
        .map(i => ({ term: i.term, group: i.groupLabel, position: i.position, impressions: i.impressions }))
    };
  } catch (e) { tracked = null; }

  return {
    property: cfg.gscSite,
    before: Object.assign({}, before, { rows: undefined }),
    after: Object.assign({}, after, { rows: undefined }),
    comparable: before.days === after.days,
    kpis,
    improved: moved.filter(m => m.delta >= 1).length,
    declined: moved.filter(m => m.delta <= -1).length,
    movers: moved.slice(0, 50),
    gained: gained.slice(0, 50),
    gainedCount: gained.length,
    lost: lost.slice(0, 50),
    lostCount: lost.length,
    tracked
  };
}

async function gscRankings(days) {
  const cfg = loadConfig();
  if (!cfg.gscSite) throw new Error('No Search Console property set.');
  const endpoint = GSC_API + '/webmasters/v3/sites/' +
    encodeURIComponent(cfg.gscSite) + '/searchAnalytics/query';

  // Two windows of the same length, back to back. Comparing them is what makes
  // "improved" and "declined" a measurement instead of a guess.
  const windows = {
    current:  { startDate: dayOffset(-(days + 2)),      endDate: dayOffset(-2) },
    previous: { startDate: dayOffset(-(days * 2 + 2)),  endDate: dayOffset(-(days + 3)) }
  };
  const ask = range => google(endpoint, Object.assign({
    dimensions: ['query'], rowLimit: 5000, type: 'web'
  }, range));

  const [now, before] = await Promise.all([ask(windows.current), ask(windows.previous)]);

  const rows = (now.rows || []).map(r => ({
    query: r.keys[0],
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: (r.ctr || 0) * 100,
    position: r.position
  }));

  const priorPos = new Map();
  (before.rows || []).forEach(r => priorPos.set(r.keys[0], r.position));

  const distribution = {};
  BUCKETS.forEach(b => { distribution[b.key] = 0; });
  rows.forEach(r => {
    const bucket = BUCKETS.find(b => b.test(r.position));
    if (bucket) distribution[bucket.key]++;
  });

  // Movement per query. A lower position number is a better rank, so an
  // improvement is a fall in the number — easy to invert by accident.
  let improved = 0, declined = 0, unchanged = 0;
  const movers = [];
  rows.forEach(r => {
    const was = priorPos.get(r.query);
    if (was === undefined) return;             // new this period, not a move
    const delta = was - r.position;            // positive = climbed
    if (delta >= 1) improved++;
    else if (delta <= -1) declined++;
    else unchanged++;
    if (Math.abs(delta) >= 1) {
      movers.push({ query: r.query, from: was, to: r.position, delta, clicks: r.clicks, impressions: r.impressions });
    }
  });
  movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.impressions - a.impressions);

  const newQueries = rows.filter(r => !priorPos.has(r.query)).length;
  const lost = (before.rows || []).filter(r => !rows.some(x => x.query === r.keys[0])).length;

  // Visibility: the share of impressions that landed on page one. Semrush's
  // own visibility index is a different formula, so this is labelled for what
  // it is rather than dressed up as the same number.
  const totalImp = rows.reduce((n, r) => n + r.impressions, 0);
  const page1Imp = rows.filter(r => r.position <= 10).reduce((n, r) => n + r.impressions, 0);

  // Built from the same two fetches rather than its own — a second pair of
  // Search Console calls for the same window would only be the same data.
  let tracked = null;
  try { tracked = matchTracked(loadKeywords(), rows, priorPos); }
  catch (e) { tracked = null; }

  return {
    property: cfg.gscSite,
    days,
    window: windows.current,
    keywords: rows.length,
    tracked,
    distribution,
    buckets: BUCKETS.map(b => ({ key: b.key, label: b.label, count: distribution[b.key] })),
    top10: distribution.top3 + distribution.p4_10,
    improved,
    declined,
    unchanged,
    newQueries,
    lost,
    movers: movers.slice(0, 25),
    page1Share: totalImp ? (page1Imp / totalImp) * 100 : 0,
    // The keywords actually earning clicks, each carrying where it sat last
    // period. A ranking table without movement says where you are but not
    // which way you are going, which is the half that decides what to do.
    topQueries: rows.slice()
      .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
      .slice(0, 25)
      .map(r => {
        const was = priorPos.get(r.query);
        return Object.assign({}, r, {
          was: was === undefined ? null : was,
          delta: was === undefined ? null : was - r.position   // positive = climbed
        });
      })
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
    rememberScan('siteAudit', summariseAudit(result, job));
    autoPublish('site audit');
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

/* ── Semrush Analytics API ──────────────────────────────────────
   Backlinks are the one thing Google will not give us. Search Console
   shows a Links report in its web interface but publishes no API for
   it, so the property already connected cannot supply them. Semrush
   can, and this is the client for it.

   The API answers in semicolon-separated CSV, not JSON, and reports
   failures as a plain-text "ERROR nn :: reason" body with HTTP 200 —
   so a naive read treats an error as a single malformed row.
   ─────────────────────────────────────────────────────────────── */
const SEMRUSH_API = process.env.SEMRUSH_API_BASE || 'https://api.semrush.com/analytics/v1/';

// The messages Semrush returns are terse and its codes are unmemorable, so the
// common ones are translated into something that says what to do next.
const SEMRUSH_ERRORS = {
  120: 'Semrush rejected the API key. Check it was copied whole from Subscription Info → API units.',
  121: 'That API key is not valid for this report.',
  130: 'The Semrush API key has expired. Renew it in your Semrush account.',
  131: 'This Semrush subscription has no API units left. Top them up, or wait for the monthly reset.',
  132: 'Semrush reports the API is temporarily unavailable. Try again shortly.',
  133: 'This Semrush plan does not include API access. API units are a separate add-on to the subscription.',
  134: 'This Semrush plan does not include API access. API units are a separate add-on to the subscription.',
  50: 'Semrush has no data for this domain yet.'
};

function parseSemrushCsv(text) {
  const body = (text || '').trim();
  if (!body) return [];
  // Errors arrive with HTTP 200 and no header row.
  const err = body.match(/^ERROR\s+(\d+)\s*::\s*(.*)$/i);
  if (err) {
    const e = new Error(SEMRUSH_ERRORS[Number(err[1])] || `Semrush: ${err[2]} (error ${err[1]})`);
    e.semrushCode = Number(err[1]);
    throw e;
  }
  const lines = body.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];             // header only: a valid empty result
  const cols = lines[0].split(';');
  return lines.slice(1).map(line => {
    const cells = line.split(';');
    const row = {};
    cols.forEach((c, i) => { row[c.trim()] = cells[i] === undefined ? '' : cells[i]; });
    return row;
  });
}

async function semrush(type, params) {
  const cfg = loadConfig();
  if (!cfg.semrushKey) {
    const e = new Error('No Semrush API key set. Add one on the Connections screen to see backlinks.');
    e.status = 400;
    throw e;
  }
  const url = new URL(SEMRUSH_API);
  url.searchParams.set('key', cfg.semrushKey);
  url.searchParams.set('type', type);
  Object.keys(params).forEach(k => url.searchParams.set(k, params[k]));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let text;
  try {
    const res = await fetch(url, { signal: controller.signal });
    text = await res.text();
    if (!res.ok && !/^ERROR/i.test(text.trim())) {
      throw new Error(`Semrush returned HTTP ${res.status}.`);
    }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Semrush did not respond within 30 seconds.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return parseSemrushCsv(text);
}

// The domain Semrush should be asked about, taken from the Search Console
// property so there is one place to set it. Semrush wants a bare host.
function semrushTarget() {
  const site = (loadConfig().gscSite || '').replace(/^sc-domain:/, '');
  if (!site) throw new Error('Set the Search Console property first — Semrush is asked about the same domain.');
  try {
    return new URL(/^https?:\/\//i.test(site) ? site : 'https://' + site).hostname.replace(/^www\./i, '');
  } catch (e) {
    return site.replace(/^www\./i, '').replace(/\/.*$/, '');
  }
}

const num = v => {
  const n = Number(String(v || '').trim());
  return Number.isFinite(n) ? n : 0;
};

async function semrushBacklinks() {
  const target = semrushTarget();
  const common = { target, target_type: 'root_domain' };

  // Three calls, because one report cannot answer all three questions. Run
  // together: each spends API units whether or not the others succeed.
  const [overview, refdomains, recent] = await Promise.all([
    semrush('backlinks_overview', Object.assign({
      export_columns: 'ascore,total,domains_num,urls_num,ips_num,follows_num,nofollows_num,texts_num,images_num'
    }, common)),
    semrush('backlinks_refdomains', Object.assign({
      export_columns: 'domain_ascore,domain,backlinks_num',
      display_limit: 25,
      display_sort: 'backlinks_num_desc'
    }, common)),
    semrush('backlinks', Object.assign({
      export_columns: 'source_url,source_title,target_url,anchor,nofollow,first_seen,last_seen',
      display_limit: 25,
      display_sort: 'last_seen_desc'
    }, common))
  ]);

  const o = overview[0] || {};
  const domains = refdomains.map(r => ({
    domain: r.domain,
    authority: num(r.domain_ascore),
    backlinks: num(r.backlinks_num)
  }));

  // Referring domains grouped the way the widget draws them, so the bar chart
  // is describing real authority rather than the shape of the mock-up.
  const bands = [
    { label: '61–100', min: 61, max: 100 },
    { label: '41–60',  min: 41, max: 60 },
    { label: '21–40',  min: 21, max: 40 },
    { label: '11–20',  min: 11, max: 20 },
    { label: '0–10',   min: 0,  max: 10 }
  ].map(b => ({
    label: b.label,
    count: domains.filter(d => d.authority >= b.min && d.authority <= b.max).length
  }));

  const follows = num(o.follows_num);
  const nofollows = num(o.nofollows_num);

  return {
    target,
    authority: num(o.ascore),
    backlinks: num(o.total),
    referringDomains: num(o.domains_num),
    referringIps: num(o.ips_num),
    referringPages: num(o.urls_num),
    follows,
    nofollows,
    followShare: follows + nofollows ? (follows / (follows + nofollows)) * 100 : 0,
    textLinks: num(o.texts_num),
    imageLinks: num(o.images_num),
    // Only the sampled domains are banded, so the widget can say so rather
    // than implying every referring domain was measured.
    bandsFrom: domains.length,
    bands,
    topDomains: domains.slice(0, 10),
    recent: recent.map(r => ({
      from: r.source_url,
      title: r.source_title,
      to: r.target_url,
      anchor: r.anchor,
      nofollow: String(r.nofollow).toLowerCase() === 'true',
      firstSeen: r.first_seen,
      lastSeen: r.last_seen
    })).slice(0, 10)
  };
}

module.exports = { shapePsi, parseSemrushCsv };

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
    rememberScan('aiSearch', summariseAi(result, job));
    autoPublish('AI readiness');
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

    attempt('rankings', async () => gscRankings(days)),

    attempt('backlinks', async () => semrushBacklinks()),

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

  // Scans this app ran itself. The in-memory run wins when there is one;
  // otherwise the last one saved to disk, so closing the app does not throw
  // away a scan that took twenty minutes.
  const remembered = readJson(SCANS_FILE, {});

  out.siteAudit = (audit.state === 'done' && audit.result)
    ? summariseAudit(audit.result, audit)
    : (remembered.siteAudit || null);
  out.sources.siteAudit = out.siteAudit ? 'live' : 'not run';

  out.aiSearch = (aiScan.state === 'done' && aiScan.result)
    ? summariseAi(aiScan.result, aiScan)
    : (remembered.aiSearch || null);
  out.sources.aiSearch = out.aiSearch ? 'live' : 'not run';

  return out;
}

/* ── Publishing a finished scan to Drive ────────────────────────
   A published artifact cannot crawl a website — no capability fetches
   arbitrary URLs — so the crawl has to happen here. This is how its
   result reaches a page other people can open: the app writes one JSON
   file to Drive with `drive.file`, a scope that reaches only files this
   app itself created, and the shared page reads it back.

   Fixed filename, updated in place, so a scan a minute apart does not
   leave a trail of copies.
   ─────────────────────────────────────────────────────────────── */
const DRIVE_API = process.env.DRIVE_API_BASE || 'https://www.googleapis.com';

async function driveRequest(url, opts) {
  const token = await accessToken();
  const headers = Object.assign({ Authorization: `Bearer ${token}` }, opts.headers || {});
  const res = await fetch(url, Object.assign({}, opts, { headers }));
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* keep the raw text for the message */ }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || text.slice(0, 200) || `HTTP ${res.status}`;
    const err = new Error(
      res.status === 403 && /insufficient|scope/i.test(msg)
        ? 'Google has not granted this app permission to write to Drive. Disconnect and connect again ' +
          'on the Connections screen — the sign-in now asks for one extra permission.'
        : msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

// With drive.file this lists only files this app created, so matching on the
// name cannot collide with anything already in the Drive.
async function findDriveFile(name) {
  const q = encodeURIComponent(`name = '${name || DRIVE_FILE}' and trashed = false`);
  const data = await driveRequest(
    `${DRIVE_API}/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&pageSize=10`, { method: 'GET' });
  const files = (data && data.files) || [];
  return files[0] || null;
}

// The signal file is found by prefix because its name is what changes.
async function findSignalFile() {
  const q = encodeURIComponent(`name contains '${SIGNAL_PREFIX}' and trashed = false`);
  const data = await driveRequest(
    `${DRIVE_API}/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&pageSize=10`, { method: 'GET' });
  const files = ((data && data.files) || []).filter(f => f.name.startsWith(SIGNAL_PREFIX + '.'));
  return files[0] || null;
}

// Content write, create-or-replace, for any of this app's files.
async function writeDriveFile(name, body, existing) {
  const found = existing !== undefined ? existing : await findDriveFile(name);
  if (found) {
    const updated = await driveRequest(
      `${DRIVE_API}/upload/drive/v3/files/${found.id}?uploadType=media&fields=id,name,modifiedTime`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
    return { id: updated.id, name: updated.name, modifiedTime: updated.modifiedTime, created: false };
  }
  // Multipart create: metadata part, then the content part.
  const boundary = 'twinseo' + Date.now();
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name, mimeType: 'application/json' }) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
    body + `\r\n--${boundary}--`;
  const created = await driveRequest(
    `${DRIVE_API}/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime`,
    { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart });
  return { id: created.id, name: created.name, modifiedTime: created.modifiedTime, created: true };
}

async function renameDriveFile(id, name) {
  return driveRequest(`${DRIVE_API}/drive/v3/files/${id}?fields=id,name`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
}

async function publishToDrive() {
  return writeDriveFile(DRIVE_FILE, JSON.stringify(buildLivePayload(), null, 2));
}

// What happened the last time the app pushed to Drive, so the screen can say.
let lastPublish = { at: 0, ok: false, error: '', fileId: '', enabled: true };

// A scan is still a good scan even if Drive is unreachable, so publishing never
// fails the scan — it records why and the screen shows it.
function autoPublish(what) {
  if (!lastPublish.enabled) return;
  publishToDrive().then(r => {
    lastPublish = { at: Date.now(), ok: true, error: '', fileId: r.id, enabled: true };
    console.log(`  Published ${what} to Drive (${r.created ? 'created' : 'updated'} ${DRIVE_FILE}).`);
  }).catch(err => {
    lastPublish = { at: Date.now(), ok: false, error: err.message || String(err), fileId: '', enabled: true };
    console.log(`  Could not publish ${what} to Drive: ${lastPublish.error}`);
  });
}

/* ── Remote scan requests ───────────────────────────────────────
   The shared page has a Scan now button. The crawl still has to
   happen here — a published page cannot fetch a website — so the
   button has to reach this machine, and Drive is the only channel
   both ends can touch.

   The obvious design does not work. This app holds `drive.file`,
   which sees only files this app itself created, so a request file
   written by the page would be invisible here. And the page's Drive
   connector can only change a file's TITLE, never its contents.

   So the request travels as the filename of a file this app owns.
   The app creates `twin-seo-scan.idle.json`; the page renames it to
   `twin-seo-scan.run-audit.<stamp>.json`; the app, polling its own
   file's name, sees the request, renames it to `.busy.` and starts
   crawling. Both halves stay inside what each end is allowed to do.

   Alongside it `twin-seo-status.json` is rewritten every few seconds
   with progress, so the page can show a crawl advancing rather than
   a spinner, and can tell "the app is off" from "the app is busy".
   ─────────────────────────────────────────────────────────────── */

const SIGNAL_TICK_MS = Number(process.env.SIGNAL_TICK_MS) || 15 * 1000;
// A request nobody was around to answer goes stale rather than firing a crawl
// the moment the laptop is opened the next morning.
const SIGNAL_MAX_AGE_MS = 15 * 60 * 1000;
const KINDS = { 'run-audit': 'siteAudit', 'run-ai': 'aiSearch' };

let remote = {
  on: false,          // the loop is running
  seenAt: 0,          // last successful Drive tick
  error: '',          // why the last tick failed
  signalName: '',     // what the request file is called right now
  acceptedAt: 0,      // when this app last took a request
  acceptedKind: '',
  statusAt: 0,        // last time the status file was written
  statusShape: ''     // what it said, so an unchanged status is not rewritten
};

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// `twin-seo-scan.run-audit.20260918T224000Z.json` → {kind, at}
function readSignal(name) {
  const m = /^twin-seo-scan\.(run-audit|run-ai)\.(\d{8}T\d{6}Z)\./.exec(name);
  if (!m) return null;
  const d = m[2];
  const at = Date.parse(
    `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`);
  return { kind: m[1], at: Number.isNaN(at) ? 0 : at };
}

function scanStatus(job) {
  return {
    state: job.state,
    crawled: job.crawled || 0,
    total: job.total || 0,
    phase: job.phase || '',
    paused: Boolean(job.paused),
    url: job.url || '',
    startedAt: job.startedAt || 0
  };
}

// Everything the page needs to describe this machine right now.
function buildStatusPayload() {
  const cfg = loadConfig();
  return {
    appSeenAt: new Date().toISOString(),
    site: (cfg.gscSite || '').replace(/^sc-domain:/, ''),
    acceptsRequests: cfg.remoteScans !== false,
    siteAudit: scanStatus(audit),
    aiSearch: scanStatus(aiScan),
    lastRequest: remote.acceptedAt
      ? { acceptedAt: new Date(remote.acceptedAt).toISOString(), kind: remote.acceptedKind }
      : null
  };
}

function busy() {
  return audit.state === 'running' || aiScan.state === 'running';
}

async function remoteTick() {
  const cfg = loadConfig();
  const file = await findSignalFile();

  // First run after connecting: put the mailbox there for the page to find.
  if (!file) {
    await writeDriveFile(SIGNAL_IDLE, JSON.stringify({
      what: 'Twin SEO scan request. The NAME of this file is the message — rename it to ' +
            'twin-seo-scan.run-audit.<stamp>.json to ask the app to crawl. Do not delete it.'
    }, null, 2), null);
    remote.signalName = SIGNAL_IDLE;
  } else {
    remote.signalName = file.name;
    const req = readSignal(file.name);

    if (req && cfg.remoteScans === false) {
      await renameDriveFile(file.id, SIGNAL_IDLE);   // declined, and it says so
      console.log('  Declined a scan request from the shared page (remote scans are off).');
    } else if (req && Date.now() - req.at > SIGNAL_MAX_AGE_MS) {
      await renameDriveFile(file.id, SIGNAL_IDLE);   // too old to act on
    } else if (req && busy()) {
      // Leave it alone; it gets picked up on the tick after the current scan.
    } else if (req) {
      const kind = KINDS[req.kind];
      const target = (cfg.gscSite || '').trim();
      let startUrl = '';
      try {
        startUrl = new URL(/^https?:\/\//i.test(target) ? target
          : 'https://' + target.replace(/^sc-domain:/, '')).toString();
      } catch (e) { startUrl = ''; }

      if (!startUrl) {
        await renameDriveFile(file.id, SIGNAL_IDLE);
        remote.error = 'A scan was requested but no site is configured on the Connections screen.';
        console.log('  ' + remote.error);
      } else {
        await renameDriveFile(file.id, `${SIGNAL_PREFIX}.busy.${req.kind}.${stamp()}.json`);
        remote.acceptedAt = Date.now();
        remote.acceptedKind = kind;
        if (kind === 'siteAudit') startAudit(startUrl, 200, 'normal');
        else startAiScan(startUrl, 60, 'normal');
        console.log(`  Shared page asked for a ${kind === 'siteAudit' ? 'site audit' : 'AI readiness'} scan — started.`);
      }
    } else if (/\.busy\./.test(file.name) && !busy()) {
      await renameDriveFile(file.id, SIGNAL_IDLE);   // the scan it marked has finished
    }
  }

  // Rewritten whenever anything the page would show has changed, and otherwise
  // on a slow heartbeat so "the app is still here" stays true. Without the
  // change check, flipping the toggle off would take a minute to reach the page.
  const payload = buildStatusPayload();
  const fingerprint = JSON.stringify(Object.assign({}, payload, { appSeenAt: '' }));
  const every = busy() ? SIGNAL_TICK_MS : SIGNAL_TICK_MS * 4;
  if (fingerprint !== remote.statusShape || Date.now() - remote.statusAt >= every) {
    await writeDriveFile(STATUS_FILE_NAME, JSON.stringify(payload, null, 2));
    remote.statusAt = Date.now();
    remote.statusShape = fingerprint;
  }
  remote.seenAt = Date.now();
  remote.error = '';
}

function startRemoteLoop() {
  if (remote.on) return;
  remote.on = true;
  const tick = () => {
    const tokens = readJson(TOKEN_FILE, {});
    if (!tokens.refresh_token) return;   // nothing to do until Google is connected
    remoteTick().catch(err => {
      remote.error = err.message || String(err);
      remote.seenAt = 0;
    });
  };
  const timer = setInterval(tick, SIGNAL_TICK_MS);
  if (timer.unref) timer.unref();        // never hold the process open on its own
  tick();
}

// Everything the shared page shows. Summaries and capped lists — a full crawl
// of a thousand pages is megabytes, and none of it would be rendered.
function buildLivePayload() {
  const cfg = loadConfig();
  const saved = readJson(SCANS_FILE, {});
  const out = {
    publishedAt: new Date().toISOString(),
    site: (cfg.gscSite || '').replace(/^sc-domain:/, '') || 'twinhomebuyer.com',
    siteAudit: null,
    aiSearch: null
  };

  const a = (audit.state === 'done' && audit.result) ? audit.result : null;
  if (a) {
    out.siteAudit = {
      health: a.health,
      counts: a.counts,
      crawled: a.crawled,
      url: audit.url,
      ranAt: audit.startedAt,
      tookMs: audit.tookMs || 0,
      issues: (a.issues || []).slice(0, 30).map(i => ({
        key: i.key, title: i.title, severity: i.severity, count: i.count, how: i.how
      })),
      linkReport: a.linkReport ? {
        totals: a.linkReport.totals,
        items: a.linkReport.items.slice(0, 40).map(i => ({
          path: i.path, url: i.url, label: i.label, kind: i.kind,
          sourceCount: i.sourceCount, sources: i.sources.slice(0, 6), fix: i.fix
        }))
      } : null
    };
  } else if (saved.siteAudit) {
    out.siteAudit = Object.assign({}, saved.siteAudit, { issues: [], linkReport: null });
  }

  const ai = (aiScan.state === 'done' && aiScan.result) ? aiScan.result : null;
  if (ai) {
    out.aiSearch = {
      score: ai.score,
      counts: ai.counts,
      pages: ai.pagesAnalysed,
      ranAt: aiScan.startedAt,
      bots: ai.access.bots.map(b => ({ engine: b.engine, ua: b.ua, blocked: b.state === 'blocked' })),
      questionShare: ai.entity.questionShare,
      withSchema: ai.entity.withSchema,
      issues: (ai.issues || []).slice(0, 30).map(i => ({
        key: i.key, title: i.title, severity: i.severity, count: i.count, how: i.how
      }))
    };
  } else if (saved.aiSearch) {
    out.aiSearch = Object.assign({}, saved.aiSearch, { issues: [] });
  }

  return out;
}

function summariseAudit(result, job) {
  return {
    health: result.health,
    counts: result.counts,
    crawled: result.crawled,
    url: job.url,
    broken: result.linkReport ? result.linkReport.totals.broken : 0,
    notFound: result.linkReport ? result.linkReport.totals.notFound : 0,
    serverError: result.linkReport ? result.linkReport.totals.serverError : 0,
    ranAt: job.startedAt
  };
}

function summariseAi(result, job) {
  const bots = result.access.bots;
  return {
    score: result.score,
    allowed: bots.filter(b => b.state !== 'blocked').length,
    total: bots.length,
    withSchema: result.entity.withSchema,
    pages: result.pagesAnalysed,
    questionShare: result.entity.questionShare,
    url: job.url,
    ranAt: job.startedAt
  };
}

// Written after each completed scan. Summaries only — a full crawl of a
// thousand pages is megabytes, and the dashboard needs the headline figures.
function rememberScan(kind, summary) {
  try {
    const all = readJson(SCANS_FILE, {});
    all[kind] = summary;
    writeJson(SCANS_FILE, all);
  } catch (e) { /* a scan is still valid even if it cannot be cached */ }
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
        hasSemrushKey: Boolean(cfg.semrushKey),
        psiKeyIsBundled: Boolean(!process.env.PAGESPEED_API_KEY && !readJson(CONFIG_FILE, {}).psiKey && loadDefaults().psiKey),
        redirectUri: redirectUri(req)
      });
    }

    if (route === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      const patch = {};
      ['clientId', 'clientSecret', 'gscSite', 'ga4Property', 'ga4Measurement', 'psiKey', 'semrushKey'].forEach(k => {
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
      startRemoteLoop();   // now that there is a token, the mailbox can be put up
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

    if (route === '/api/publish' && req.method === 'POST') {
      const r = await publishToDrive();
      lastPublish = { at: Date.now(), ok: true, error: '', fileId: r.id, enabled: true };
      return send(res, 200, Object.assign({ ok: true }, r));
    }

    if (route === '/api/compare') {
      const q = n => String(url.searchParams.get(n) || '').trim();
      const a = { startDate: q('beforeStart'), endDate: q('beforeEnd') };
      const b = { startDate: q('afterStart'), endDate: q('afterEnd') };
      const bad = [a.startDate, a.endDate, b.startDate, b.endDate].filter(s => !DATE_RE.test(s));
      if (bad.length) {
        return send(res, 400, { error: 'Give both ranges as YYYY-MM-DD dates.' });
      }
      if (a.startDate > a.endDate || b.startDate > b.endDate) {
        return send(res, 400, { error: 'Each range has to start before it ends.' });
      }
      return send(res, 200, await compareWindows(a, b));
    }

    if (route === '/api/keywords' && req.method === 'GET') {
      const list = loadKeywords();
      return send(res, 200, {
        list,
        edited: fs.existsSync(KEYWORDS_FILE),
        count: expandKeywords(list).length
      });
    }

    if (route === '/api/keywords' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.reset) {
        try { fs.unlinkSync(KEYWORDS_FILE); } catch (e) { /* already the default */ }
        const list = defaultKeywords();
        return send(res, 200, { ok: true, edited: false, count: expandKeywords(list).length, list });
      }
      const list = body.list;
      if (!list || !Array.isArray(list.groups)) {
        return send(res, 400, { error: 'Send a list with a groups array.' });
      }
      // Normalise rather than trust: a group with no terms, or a term that is
      // only whitespace, would otherwise show up as a keyword you can never rank for.
      const clean = {
        version: 1,
        geoTemplates: (list.geoTemplates || []).map(String).map(s => s.trim()).filter(Boolean),
        cities: (list.cities || []).map(String).map(s => s.trim()).filter(Boolean),
        groups: list.groups.map(g => ({
          key: String(g.key || '').trim() || 'custom',
          label: String(g.label || g.key || 'Custom').trim(),
          why: String(g.why || '').trim(),
          terms: (g.terms || []).map(String).map(s => s.trim()).filter(Boolean)
        })).filter(g => g.terms.length)
      };
      const count = expandKeywords(clean).length;
      if (!count) return send(res, 400, { error: 'That list has no keywords in it.' });
      writeJson(KEYWORDS_FILE, clean);
      return send(res, 200, { ok: true, edited: true, count, list: clean });
    }

    if (route === '/api/remote' && req.method === 'POST') {
      const body = await readBody(req);
      saveConfig({ remoteScans: Boolean(body.on) });
      if (body.on) startRemoteLoop();
      return send(res, 200, { ok: true, on: Boolean(body.on) });
    }

    if (route === '/api/publish/status') {
      const cfg = loadConfig();
      return send(res, 200, {
        file: DRIVE_FILE,
        lastAt: lastPublish.at,
        ok: lastPublish.ok,
        error: lastPublish.error,
        remoteOn: cfg.remoteScans !== false,
        remoteSeenAt: remote.seenAt,
        remoteError: remote.error,
        signal: remote.signalName
      });
    }

    if (route === '/api/semrush/test') {
      // Deliberately the cheapest report, so testing a key costs almost
      // nothing in API units.
      const rows = await semrush('backlinks_overview', {
        target: semrushTarget(), target_type: 'root_domain', export_columns: 'ascore,total,domains_num'
      });
      const o = rows[0] || {};
      return send(res, 200, {
        ok: true,
        target: semrushTarget(),
        authority: Number(o.ascore) || 0,
        backlinks: Number(o.total) || 0,
        referringDomains: Number(o.domains_num) || 0
      });
    }

    if (route === '/api/backlinks') {
      return send(res, 200, await semrushBacklinks());
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
      const data = await google(GSC_API + '/webmasters/v3/sites');
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
  console.log(`  PageSpeed key         ${cfg.psiKey ? 'set' : 'not set (Google will rate-limit)'}`);
  console.log(`  Shared-page requests  ${cfg.remoteScans !== false ? 'accepted' : 'off'}\n`);
  startRemoteLoop();
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
