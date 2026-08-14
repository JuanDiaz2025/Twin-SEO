'use strict';

/**
 * Site Audit — crawls a site and reports what is wrong with it.
 *
 * Real requests against real pages, so it is deliberately polite: same-origin
 * only, a capped page count, a small concurrency window, and it honours
 * robots.txt Disallow rules for its own user agent.
 */

const { URL } = require('url');

const UA = 'TwinSEO-SiteAudit/1.0 (+site health checker)';

/* ── Issue catalogue ────────────────────────────────────────────
   severity drives both the grouping and the health score.
   ─────────────────────────────────────────────────────────────── */
const CHECKS = {
  status5xx:        { severity: 'error',   weight: 12, title: '5xx server errors' },
  status4xx:        { severity: 'error',   weight: 10, title: '4xx pages returned' },
  brokenInternal:   { severity: 'error',   weight: 8,  title: 'Broken internal links' },
  noTitle:          { severity: 'error',   weight: 7,  title: 'Missing title tag' },
  duplicateTitle:   { severity: 'error',   weight: 6,  title: 'Duplicate title tags' },
  noH1:             { severity: 'warning', weight: 4,  title: 'Missing H1' },
  multipleH1:       { severity: 'warning', weight: 2,  title: 'More than one H1' },
  noDescription:    { severity: 'warning', weight: 4,  title: 'Missing meta description' },
  duplicateDesc:    { severity: 'warning', weight: 3,  title: 'Duplicate meta descriptions' },
  titleLength:      { severity: 'warning', weight: 2,  title: 'Title too long or too short' },
  descLength:       { severity: 'warning', weight: 2,  title: 'Meta description length off' },
  imgNoAlt:         { severity: 'warning', weight: 3,  title: 'Images without alt text' },
  slowPage:         { severity: 'warning', weight: 3,  title: 'Slow response' },
  redirectChain:    { severity: 'warning', weight: 2,  title: 'Redirected pages' },
  noCanonical:      { severity: 'notice',  weight: 1,  title: 'No canonical tag' },
  noViewport:       { severity: 'notice',  weight: 2,  title: 'No mobile viewport' },
  noLang:           { severity: 'notice',  weight: 1,  title: 'No lang attribute' },
  notHttps:         { severity: 'error',   weight: 8,  title: 'Page served over HTTP' },
  noindex:          { severity: 'notice',  weight: 2,  title: 'Blocked from indexing' },
  thinContent:      { severity: 'notice',  weight: 1,  title: 'Very little text' },
  largePage:        { severity: 'notice',  weight: 1,  title: 'Large page weight' },
  brokenExternal:   { severity: 'error',   weight: 6,  title: 'Broken links to other sites' },
  mixedContent:     { severity: 'error',   weight: 7,  title: 'Insecure content on a secure page' },
  multipleCanonical:{ severity: 'error',   weight: 6,  title: 'More than one canonical tag' },
  orphanPage:       { severity: 'warning', weight: 5,  title: 'Pages nothing links to' },
  deepPage:         { severity: 'warning', weight: 3,  title: 'Buried too many clicks deep' },
  canonicalElsewhere:{ severity: 'warning', weight: 4, title: 'Canonical points at another page' },
  noOpenGraph:      { severity: 'notice',  weight: 2,  title: 'No social preview tags' },
  h1EqualsTitle:    { severity: 'notice',  weight: 1,  title: 'H1 identical to the title' },
  nonCanonicalLink: { severity: 'warning', weight: 3,  title: 'Internal links use the wrong hostname' },
  flakyUnderLoad:   { severity: 'warning', weight: 3,  title: 'Pages failed under crawl load, then recovered' }
};

// Why it matters, and what to actually do about it. `snippet` is markup that
// can be pasted as-is; `{url}` is filled in per page.
const GUIDE = {
  status5xx: {
    why: 'The server failed outright. Neither visitors nor Google can reach the page, and repeated 5xx responses get pages dropped from the index.',
    how: 'Check the server error log for the moment of the crawl. If the page is gone for good, return 410; if it moved, 301 it to the new URL.'
  },
  status4xx: {
    why: 'The URL is linked but does not exist, so visitors hit a dead end and the link equity pointing at it is wasted.',
    how: 'If the page moved, add a 301 redirect from this URL to its replacement. If it should never have existed, fix the link on the page that points here.'
  },
  brokenInternal: {
    why: 'Your own pages link to URLs that do not resolve — the easiest kind of broken link to fix, because you control both ends.',
    how: 'Edit the linking page and point the href at a working URL, or restore the missing page.'
  },
  noTitle: {
    why: 'The title is the clickable headline in search results. Without one Google invents its own, usually from stray page text.',
    how: 'Add a <title> in the <head>: the page topic first, brand last, under 60 characters.',
    snippet: '<title>Page topic here | Twin Home Buyer</title>'
  },
  duplicateTitle: {
    why: 'Pages with the same title compete against each other and look identical in results, so Google picks one and buries the rest.',
    how: 'Give each page a title naming its own specific topic — the city, the service, or the question it answers.'
  },
  noH1: {
    why: 'The H1 is the on-page headline. Without one, both readers and Google have to infer what the page is for.',
    how: 'Add a single <h1> at the top of the content, stating the page topic in plain words.'
  },
  multipleH1: {
    why: 'Several H1s split the signal about what the page is about.',
    how: 'Keep the one that names the page topic and change the others to <h2>.'
  },
  noDescription: {
    why: 'Without a description Google writes the search snippet itself, pulling whatever text it finds first — often a menu or a cookie notice.',
    how: 'Add a meta description of 120–155 characters that says what the page offers and gives a reason to click.',
    snippet: '<meta name="description" content="Your 120-155 character summary here.">'
  },
  duplicateDesc: {
    why: 'The same description on several pages wastes the one piece of copy you control in the search result.',
    how: 'Write a distinct description per page, matching that page\'s specific subject.'
  },
  titleLength: {
    why: 'Google truncates titles past roughly 60 characters, and very short ones leave ranking terms unused.',
    how: 'Aim for 30–60 characters. Lead with the topic and keep the brand suffix short.'
  },
  descLength: {
    why: 'Descriptions past ~160 characters get cut mid-sentence; very short ones waste the space.',
    how: 'Aim for 120–155 characters, ending on a complete thought.'
  },
  imgNoAlt: {
    why: 'Alt text is what screen readers announce and what Google Images indexes. Missing alt is both an accessibility gap and lost image traffic.',
    how: 'Describe what each image shows in a few words. For purely decorative images use alt="" so screen readers skip them.',
    snippet: '<img src="…" alt="Short description of what the image shows">'
  },
  slowPage: {
    why: 'Slow responses cost rankings and visitors — most people leave before a three-second page finishes loading.',
    how: 'Check time-to-first-byte first: it is usually server or plugin time, not page weight. Then enable caching, and compress images.'
  },
  redirectChain: {
    why: 'Every redirect adds a round trip before anything renders, and passes link equity through an extra hop.',
    how: 'Update the internal links so they point straight at the final URL.'
  },
  noCanonical: {
    why: 'Without a canonical, the same content reachable at several URLs (with and without a trailing slash, with tracking parameters) can be treated as duplicates.',
    how: 'Add a self-referencing canonical in the <head>.',
    snippet: '<link rel="canonical" href="{url}">'
  },
  noViewport: {
    why: 'Phones render the desktop layout zoomed out, which Google treats as not mobile-friendly — and most of your traffic is mobile.',
    how: 'Add the viewport meta to the <head>.',
    snippet: '<meta name="viewport" content="width=device-width, initial-scale=1">'
  },
  noLang: {
    why: 'The lang attribute tells screen readers which pronunciation to use and helps Google target the right region.',
    how: 'Add a lang attribute to the opening html tag.',
    snippet: '<html lang="en">'
  },
  notHttps: {
    why: 'Browsers mark HTTP pages "Not secure", and HTTPS is a confirmed ranking signal.',
    how: 'Redirect all HTTP traffic to HTTPS with a 301 and update internal links to the https:// form.'
  },
  noindex: {
    why: 'This page explicitly tells search engines to stay out, so it can never rank — deliberate for thank-you pages, fatal for anything else.',
    how: 'If the page should rank, remove the noindex from the robots meta tag.'
  },
  thinContent: {
    why: 'Short pages rarely satisfy a search well enough to outrank a fuller answer.',
    how: 'Aim for 600+ words on pages meant to rank. Add the detail buyers ask for: process, timeline, costs, local specifics, FAQs.'
  },
  largePage: {
    why: 'Heavy pages are slow on phones and on mobile data, which is where most local searches happen.',
    how: 'Move inline CSS and JavaScript into cached files, and strip unused page-builder markup.'
  },
  brokenExternal: {
    why: 'A link out to a page that no longer exists is a dead end for the reader and a small signal that the page is not maintained.',
    how: 'Point the link at the current address, find a replacement source, or remove the link.'
  },
  mixedContent: {
    why: 'A secure page loading images or scripts over plain http gets flagged by browsers, and the insecure parts may be blocked outright.',
    how: 'Change every http:// reference in the page source to https://.'
  },
  multipleCanonical: {
    why: 'Two canonical tags contradict each other, so Google ignores both and decides for itself which URL is the real one.',
    how: 'Keep exactly one canonical per page. A second one usually comes from a plugin duplicating what the theme already adds.'
  },
  orphanPage: {
    why: 'A page in your sitemap that nothing links to is reachable only by a crawler that reads the sitemap. Visitors cannot find it, and it inherits no authority from the rest of the site.',
    how: 'Link to it from a relevant page — a service page, the blog index, or the footer if nowhere else fits.'
  },
  deepPage: {
    why: 'Pages four or more clicks from the homepage get crawled less often and are treated as less important.',
    how: 'Add a link from a page nearer the top: a hub page, a category listing, or the main navigation.'
  },
  canonicalElsewhere: {
    why: 'This page tells Google the real version is a different URL, so it will not rank on its own. Deliberate for duplicates, quietly fatal when it is a mistake.',
    how: 'If this page should rank, point its canonical at itself.'
  },
  noOpenGraph: {
    why: 'Without og:title and og:image, links shared to Facebook, LinkedIn or a text message render as a bare URL, which almost nobody clicks.',
    how: 'Add og:title, og:description and og:image to the page head.',
    snippet: '<meta property="og:title" content="Page title">\n<meta property="og:description" content="One-line summary">\n<meta property="og:image" content="https://example.com/share-image.jpg">'
  },
  flakyUnderLoad: {
    why: 'These pages errored while being crawled but answered normally a moment later, so they are not broken — the server is shedding requests when several arrive close together. Googlebot crawls faster than this audit did, so it will be seeing the same failures.',
    how: 'Look at hosting limits, PHP worker count and any rate limiting or bot protection in front of the site. Caching pages so repeat requests never reach PHP is usually the cheapest fix.'
  },
  flakyUnderLoad: {
    why: 'These pages errored while being crawled but answered normally a moment later, so they are not broken — the server is shedding requests when several arrive close together. Googlebot crawls faster than this audit did, so it is seeing the same failures.',
    how: 'Look at hosting limits, PHP worker count, and any rate limiting or bot protection in front of the site. Caching pages so repeat requests never reach PHP is usually the cheapest fix.'
  },
  nonCanonicalLink: {
    why: 'These links point at the other version of your own domain (the www twin, or http://), so every click costs a redirect before the page starts loading, and the link equity passes through an extra hop.',
    how: 'Edit the href so it matches the hostname the site actually serves. In WordPress this is usually a stale Site Address setting or hard-coded links in the theme.'
  },
  h1EqualsTitle: {
    why: 'Reusing the title verbatim as the H1 wastes a second chance to match how people phrase the search.',
    how: 'Keep the title keyword-led for the search result, and make the H1 read naturally for the visitor.'
  }
};

// Trim to a whole word at or under a limit.
// Record a linking page against a target URL. Capped: a site-wide dead link
// would otherwise collect thousands of identical entries, and nobody needs
// more than a couple of dozen examples to find the template at fault.
const MAX_SOURCES = 25;
function noteSource(map, target, from) {
  let list = map.get(target);
  if (!list) { list = []; map.set(target, list); }
  if (list.length < MAX_SOURCES && list.indexOf(from) === -1) list.push(from);
}

function trimTo(text, limit) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return (space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[\s\-|,:;]+$/, '');
}

// Titles are usually "Topic | Sub | Brand", so shed whole segments before
// resorting to a mid-phrase cut.
function shortenTitle(title, limit) {
  if (title.length <= limit) return title;
  const sep = /\s*[|\u2013\u2014\u00b7]\s*/;
  if (sep.test(title)) {
    const parts = title.split(sep).filter(Boolean);
    while (parts.length > 1 && parts.join(' | ').length > limit) parts.pop();
    const joined = parts.join(' | ');
    if (joined.length <= limit && parts.length > 1) return joined;
  }
  return trimTo(title, limit);
}

function firstSentence(text, limit) {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  const stop = clean.search(/[.!?]\s/);
  const sentence = stop > 40 ? clean.slice(0, stop + 1) : clean;
  return trimTo(sentence, limit);
}

/* ── Tiny HTML readers ──────────────────────────────────────────
   A parser dependency is not worth it for a handful of tags; these
   are deliberately narrow and only used on text/html responses.
   ─────────────────────────────────────────────────────────────── */
function firstMatch(html, re) {
  const m = html.match(re);
  return m ? m[1].trim() : null;
}

function metaContent(html, name) {
  const re = new RegExp(
    '<meta[^>]+(?:name|property)\\s*=\\s*["\']' + name + '["\'][^>]*>', 'i');
  const tag = html.match(re);
  if (!tag) return null;
  return firstMatch(tag[0], /content\s*=\s*["']([^"']*)["']/i);
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLinks(html, base) {
  const out = new Set();
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw || raw.startsWith('#') || /^(mailto:|tel:|javascript:|data:)/i.test(raw)) continue;
    try {
      const u = new URL(raw, base);
      u.hash = '';
      out.add(u.toString());
    } catch (e) { /* unparseable href */ }
  }
  return [...out];
}

/* ── robots.txt ─────────────────────────────────────────────────── */
async function fetchRobots(origin) {
  const rules = { disallow: [], sitemaps: [], found: false, crawlDelayMs: 0 };
  try {
    const res = await fetch(`${origin}/robots.txt`, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!res.ok) return rules;
    rules.found = true;
    const text = await res.text();
    let applies = false;
    for (const line of text.split('\n')) {
      const clean = line.split('#')[0].trim();
      if (!clean) continue;
      const [rawKey, ...rest] = clean.split(':');
      const key = rawKey.trim().toLowerCase();
      const value = rest.join(':').trim();
      if (key === 'user-agent') applies = value === '*' || /twinseo/i.test(value);
      else if (key === 'disallow' && applies && value) rules.disallow.push(value);
      else if (key === 'crawl-delay' && applies) {
        const secs = parseFloat(value);
        if (isFinite(secs) && secs > 0) rules.crawlDelayMs = Math.min(10000, secs * 1000);
      }
      else if (key === 'sitemap') rules.sitemaps.push(value);
    }
  } catch (e) { /* no robots.txt is not an error */ }
  return rules;
}

// Pages reachable only from a sitemap would otherwise be invisible to a
// link-following crawl, which matters once the page budget is in the hundreds.
async function fetchSitemapUrls(origin, sitemaps, limit) {
  const found = [];
  const queue = sitemaps.length ? sitemaps.slice(0, 5) : [`${origin}/sitemap.xml`];
  const seenSitemaps = new Set();

  while (queue.length && found.length < limit) {
    const url = queue.shift();
    if (seenSitemaps.has(url) || seenSitemaps.size > 25) continue;
    seenSitemaps.add(url);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      if (!res.ok) continue;
      const xml = await res.text();
      const isIndex = /<sitemapindex/i.test(xml);
      const locs = xml.match(/<loc>\s*([^<]+?)\s*<\/loc>/gi) || [];
      for (const loc of locs) {
        const value = loc.replace(/<\/?loc>/gi, '').trim();
        if (isIndex) { queue.push(value); continue; }
        try {
          const u = new URL(value);
          if (u.origin !== origin) continue;
          u.hash = '';
          found.push(u.toString());
          if (found.length >= limit) break;
        } catch (e) { /* skip malformed entries */ }
      }
    } catch (e) { /* a missing sitemap is not an error */ }
  }
  return found;
}

function blockedByRobots(pathname, rules) {
  return rules.disallow.some(rule => rule !== '/' && pathname.startsWith(rule));
}

/* ── The crawl ──────────────────────────────────────────────────── */
const sleep = ms => new Promise(r => setTimeout(r, ms));

// www.example.com and example.com are one site to every human looking at the
// audit, whichever one was typed into the box. The port stays part of the
// identity: two services on one host are two different sites.
const bareHost = url => {
  const u = typeof url === 'string' ? { hostname: url, port: '' } : url;
  return u.hostname.replace(/^www\./i, '').toLowerCase() + (u.port ? ':' + u.port : '');
};

// Where does the entry URL actually end up? Only a redirect that stays on the
// same site is followed: a link shortener or a hijacked domain landing
// somewhere else must not silently redirect the audit onto another site.
async function resolveEntry(url, timeoutMs) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs || 20000, 15000));
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: controller.signal });
    } finally { clearTimeout(timer); }
    if (!res.url || res.url === url) return null;
    const from = new URL(url);
    const to = new URL(res.url);
    if (bareHost(to) !== bareHost(from)) return null;
    return to.origin + '/';
  } catch (e) {
    return null;   // unreachable entry is the crawl's problem to report, not this helper's
  }
}

async function crawl(startUrl, options, onProgress, shouldStop, shouldPause) {
  const opts = Object.assign({
    maxPages: 40,
    concurrency: 2,
    delayMs: 400,      // spacing between requests, not per worker
    timeoutMs: 20000,
    retries: 2
  }, options);
  let start = new URL(startUrl);
  // Most sites 301 between the apex and www. Keeping the typed origin after
  // such a redirect makes every internal link look like it points at another
  // site: the crawl stops after one page and the whole site gets reported as
  // broken outbound links. Follow the entry redirect and adopt where it lands.
  const landed = await resolveEntry(start.toString(), opts.timeoutMs);
  if (landed) start = new URL(landed);
  const origin = start.origin;
  const siteHost = bareHost(start);

  const robots = await fetchRobots(origin);
  // A site asking for a slower crawl gets one.
  const delayMs = Math.max(opts.delayMs, robots.crawlDelayMs || 0);

  const queue = [{ url: start.toString(), depth: 0 }];
  const seen = new Set([start.toString()]);
  const pages = [];
  // Every page that links to a URL, not just the first one found: a dead link
  // in a footer or nav sits on every page, and reporting a single location
  // gets one instance fixed while the rest stay broken.
  const linkSources = new Map();   // url → [pages that link to it]
  const inboundLinks = new Map();  // url → how many pages link to it
  const externalLinks = new Map(); // external url → [pages linking out]
  const nonCanonicalLinks = new Map(); // canonical url → [pages linking to its www/http twin]
  const sitemapUrls = new Set();
  const depths = new Map([[start.toString(), 0]]);

  // Seed from the sitemap so orphaned pages are not missed.
  if (opts.maxPages > 25) {
    const fromSitemap = await fetchSitemapUrls(origin, robots.sitemaps, opts.maxPages);
    for (const url of fromSitemap) {
      sitemapUrls.add(url);
      if (seen.size >= opts.maxPages) continue;
      if (seen.has(url)) continue;
      try {
        if (blockedByRobots(new URL(url).pathname, robots)) continue;
      } catch (e) { continue; }
      seen.add(url);
      depths.set(url, 1);
      queue.push({ url, depth: 1 });
    }
  }

  // One shared clock, so the request rate holds whatever the concurrency is.
  let nextSlot = 0;
  let currentDelay = delayMs;
  let throttleHits = 0;
  async function throttle() {
    // Hold here while paused: the queue keeps its place and nothing in flight
    // is thrown away, so resuming continues rather than restarting.
    while (shouldPause && shouldPause() && !(shouldStop && shouldStop())) {
      await sleep(250);
    }
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + currentDelay;
    if (wait > 0) await sleep(wait);
  }

  // Being told to slow down is information: honour it for the rest of the run
  // rather than repeatedly provoking the same failure.
  function backOff() {
    throttleHits++;
    currentDelay = Math.min(5000, Math.max(currentDelay * 2, 1000));
  }

  async function fetchOnce(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      return await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
        redirect: 'follow',
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function visit(url, depth) {
    const page = { url, depth: depth || 0, status: 0, ms: 0, redirectedTo: null, bytes: 0, issues: [] };
    let began = 0;
    try {
      let res = null;
      // Retry transient failures before calling a page broken — one dropped
      // connection should not be reported as a dead page.
      for (let attempt = 0; attempt <= opts.retries; attempt++) {
        await throttle();
        began = Date.now();
        try {
          res = await fetchOnce(url);
        } catch (err) {
          if (attempt === opts.retries) throw err;
          await sleep(1000 * (attempt + 1));
          continue;
        }
        if (res.status === 429 || res.status === 503) {
          backOff();
          if (attempt < opts.retries) {
            const retryAfter = parseFloat(res.headers.get('retry-after'));
            await sleep(isFinite(retryAfter) ? Math.min(30000, retryAfter * 1000) : 2000 * (attempt + 1));
            continue;
          }
        }
        break;
      }

      page.status = res.status;
      page.ms = Date.now() - began;
      if (res.url && res.url !== url) page.redirectedTo = res.url;

      const type = res.headers.get('content-type') || '';
      if (!/text\/html/i.test(type)) {
        page.contentType = type;
        return page;
      }

      const html = await res.text();
      page.bytes = Buffer.byteLength(html);
      page.title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
      page.description = metaContent(html, 'description');
      page.canonical = (() => {
        const tag = html.match(/<link[^>]+rel\s*=\s*["']canonical["'][^>]*>/i);
        return tag ? firstMatch(tag[0], /href\s*=\s*["']([^"']+)["']/i) : null;
      })();
      page.robotsMeta = metaContent(html, 'robots') || '';
      page.canonicalCount = (html.match(/<link[^>]+rel\s*=\s*["']canonical["']/gi) || []).length;
      page.openGraph = Boolean(metaContent(html, 'og:title') && metaContent(html, 'og:image'));
      // An https page pulling scripts, styles or images over http is mixed content.
      page.mixedContent = [];
      if (/^https:/i.test(url)) {
        const insecure = [];
        // src on img/script/iframe/video is always a load.
        (html.match(/<(?:img|script|iframe|video|audio|source|embed)\b[^>]*\ssrc\s*=\s*["']http:\/\/[^"']+/gi) || [])
          .forEach(m => insecure.push(m.slice(m.indexOf('http://'))));
        // href on <link> is a load only for stylesheets, icons and preloads —
        // an ordinary <a href="http://..."> is a link, not mixed content.
        (html.match(/<link\b[^>]*>/gi) || []).forEach(tag => {
          if (!/href\s*=\s*["']http:\/\//i.test(tag)) return;
          if (!/rel\s*=\s*["'][^"']*(stylesheet|icon|preload|prefetch)/i.test(tag)) return;
          const m = tag.match(/href\s*=\s*["'](http:\/\/[^"']+)/i);
          if (m) insecure.push(m[1]);
        });
        page.mixedContent = insecure
          .filter(u => !/^http:\/\/(schema\.org|www\.w3\.org|purl\.org|ogp\.me)/i.test(u))
          .slice(0, 5);
      }
      page.viewport = Boolean(metaContent(html, 'viewport'));
      page.lang = Boolean(html.match(/<html[^>]+lang\s*=/i));
      const h1s = html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi) || [];
      page.h1Count = h1s.length;
      page.h1 = h1s.length ? stripTags(h1s[0]).slice(0, 120) : null;
      page.h1s = h1s.slice(0, 4).map(h => stripTags(h).slice(0, 80));

      const imgs = html.match(/<img\b[^>]*>/gi) || [];
      page.images = imgs.length;
      const noAlt = imgs.filter(t => !/\balt\s*=/i.test(t));
      page.imagesNoAlt = noAlt.length;
      page.imagesNoAltSrc = noAlt.slice(0, 6).map(t => {
        const m = t.match(/src\s*=\s*["']([^"']+)["']/i);
        return m ? m[1].split('/').pop().split('?')[0] : '(no src)';
      });

      // Body text minus the chrome. Cut at <body> rather than matching
      // </head> — plenty of real pages (WordPress among them) never close the
      // head, and without this the <title> leads every extract. Comments go
      // too: the "you are using an outdated browser" banner lives inside a
      // conditional comment and would otherwise read as the opening sentence.
      const bodyStart = html.search(/<body\b/i);
      const body = (bodyStart > -1 ? html.slice(bodyStart) : html)
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<(header|nav|footer|aside)[\s\S]*?<\/\1>/gi, ' ');
      const bodyText = stripTags(body);
      page.words = stripTags(html).split(' ').filter(Boolean).length;
      page.firstText = bodyText.slice(0, 400);

      // What follows the H1 — the page's actual opening. Page builders wrap
      // their sticky bars and offer banners in plain divs, so "the first text
      // in the body" is usually chrome; the first text after the headline is
      // the passage a reader (or an assistant) treats as the answer.
      const afterH1 = body.split(/<\/h1\s*>/i)[1];
      page.afterH1 = afterH1 ? stripTags(afterH1).slice(0, 400) : '';

      // Figures an assistant can quote — money, percentages, and counted
      // things like "7 days" or "3 offers". Bare years and phone numbers are
      // not facts about the offer, so they do not count.
      page.figures = (bodyText.match(/(\$\s?[\d,]+(?:\.\d+)?|\b\d+(?:\.\d+)?\s?%|\b\d{1,3}\s?(?:day|days|week|weeks|month|months|hour|hours|year|years|home|homes|house|houses|client|clients|offer|offers)\b)/gi) || []).length;

      // ── Signals that decide whether an AI assistant can quote this page ──
      page.schemaTypes = [];
      page.schemaBroken = 0;
      page.schemaProps = [];
      page.sameAs = [];
      page.dateModified = '';
      const blocks = html.match(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
      for (const block of blocks) {
        const raw = block.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '').trim();
        try {
          const parsed = JSON.parse(raw);
          const nodes = [].concat(parsed['@graph'] || parsed);
          for (const node of nodes) {
            if (!node || typeof node !== 'object') continue;
            [].concat(node['@type'] || []).forEach(t => { if (t) page.schemaTypes.push(String(t)); });
            if (node.sameAs) page.sameAs = page.sameAs.concat([].concat(node.sameAs));
            if (node.dateModified && !page.dateModified) page.dateModified = String(node.dateModified);
            // Which properties the markup actually carries. An Organization node
            // with no telephone and no author is a very different thing from one
            // that has both, and only the property names say which.
            Object.keys(node).forEach(k => {
              if (k[0] !== '@' && node[k] != null && node[k] !== '' && page.schemaProps.indexOf(k) === -1) {
                page.schemaProps.push(k);
              }
            });
          }
        } catch (e) { page.schemaBroken++; }
      }

      const headingTags = html.match(/<h([23])\b[^>]*>([\s\S]*?)<\/h\1>/gi) || [];
      page.headings = headingTags.slice(0, 60).map(h => stripTags(h).slice(0, 120)).filter(Boolean);
      page.questionHeadings = page.headings.filter(h =>
        /\?\s*$/.test(h) || /^(how|what|why|when|where|who|which|can|do|does|is|are|should|will)\b/i.test(h));

      page.lists = (html.match(/<(ul|ol)\b/gi) || []).length;
      page.tables = (html.match(/<table\b/gi) || []).length;
      if (!page.dateModified) {
        const timeTag = html.match(/<time[^>]+datetime\s*=\s*["']([^"']+)["']/i);
        if (timeTag) page.dateModified = timeTag[1];
      }

      const links = extractLinks(html, url);
      page.internalLinks = 0;
      page.outboundLinks = 0;
      for (const link of links) {
        let u;
        try { u = new URL(link); } catch (e) { continue; }
        if (!/^https?:$/.test(u.protocol)) continue;
        if (bareHost(u) !== siteHost) {
          page.outboundLinks++;
          noteSource(externalLinks, link, url);
          continue;
        }
        // Same site reached by its other hostname (the www twin) or over
        // http:// — one redirect hop for every visitor who clicks it. Fold it
        // onto the canonical origin so the page is crawled once and its
        // findings land against one URL instead of two.
        let target = link;
        if (u.origin !== origin) {
          target = origin + u.pathname + u.search;
          try { u = new URL(target); } catch (e) { continue; }
          noteSource(nonCanonicalLinks, target, url);
        }
        page.internalLinks++;
        inboundLinks.set(target, (inboundLinks.get(target) || 0) + 1);
        noteSource(linkSources, target, url);
        if (seen.size >= opts.maxPages || seen.has(target)) continue;
        if (blockedByRobots(u.pathname, robots)) continue;
        if (/\.(pdf|jpg|jpeg|png|gif|webp|svg|zip|mp4|css|js|xml|ico)$/i.test(u.pathname)) continue;
        seen.add(target);
        const childDepth = (page.depth || 0) + 1;
        if (!depths.has(target)) depths.set(target, childDepth);
        queue.push({ url: target, depth: childDepth });
      }
    } catch (err) {
      page.status = 0;
      page.ms = Date.now() - began;
      page.error = err.name === 'AbortError' ? 'Timed out' : (err.message || 'Request failed');
    }
    return page;
  }

  // A small sliding window of workers keeps the crawl brisk without hammering.
  let active = 0;
  let stopped = false;
  await new Promise(resolve => {
    const pump = () => {
      if (shouldStop && shouldStop()) stopped = true;
      if (stopped && active === 0) return resolve();
      if (!stopped && !queue.length && active === 0) return resolve();
      while (!stopped && active < opts.concurrency && queue.length && pages.length + active < opts.maxPages) {
        const job = queue.shift();
        active++;
        visit(job.url, job.depth).then(page => {
          pages.push(page);
          if (onProgress) {
            onProgress(pages.length, Math.min(opts.maxPages, pages.length + active + queue.length));
          }
        }).catch(() => {}).then(() => { active--; pump(); });
      }
      if (pages.length + active >= opts.maxPages && active === 0) resolve();
    };
    pump();
  });

  // Second look at everything that failed with a server error or no response.
  // Shared hosting sheds requests under a crawl, and a page that 503s while
  // being crawled but answers fine a moment later is not broken — reporting it
  // as broken sends someone hunting a bug that does not exist. Sequential,
  // unhurried, and only over the handful of URLs that actually failed.
  const flaky = [];
  const suspects = pages.filter(p => p.status === 0 || p.status >= 500).slice(0, 25);
  if (suspects.length && !(shouldStop && shouldStop())) {
    await sleep(3000);
    for (const p of suspects) {
      if (shouldStop && shouldStop()) break;
      await sleep(1200);
      // visit() again rather than a bare fetch: a page that only answers on
      // the second look still needs its title, headings and schema read, and
      // this is the one code path that extracts all of them.
      const retry = await visit(p.url, p.depth);
      if (retry.status === 0 || retry.status >= 400) continue;
      flaky.push({ url: p.url, failedAs: p.status === 0 ? (p.error || 'no response') : String(p.status) });
      retry.recheckedOk = true;
      pages[pages.indexOf(p)] = retry;
    }
  }

  // Outbound links, sampled and checked at the same polite rate. A dead link
  // out of the site is still a dead end for the reader.
  const external = [];
  if (opts.checkExternal !== false && externalLinks.size) {
    const sample = [...externalLinks.entries()].slice(0, opts.maxExternal || 40);
    for (const [link, froms] of sample) {
      const from = froms[0];
      if (shouldStop && shouldStop()) break;
      await throttle();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        let res;
        try {
          res = await fetch(link, { method: 'HEAD', headers: { 'User-Agent': UA }, redirect: 'follow', signal: controller.signal });
          // Plenty of servers refuse HEAD; fall back before calling it broken.
          if (res.status === 405 || res.status === 501) {
            res = await fetch(link, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: controller.signal });
          }
        } finally { clearTimeout(timer); }
        external.push({ url: link, from, sources: froms, status: res.status });
      } catch (err) {
        external.push({ url: link, from, sources: froms, status: 0, error: err.name === 'AbortError' ? 'Timed out' : (err.message || 'unreachable') });
      }
    }
  }

  return {
    pages, robots, origin, linkSources, inboundLinks, nonCanonicalLinks, sitemapUrls, external, flaky,
    externalTotal: externalLinks.size,
    delayMs, finalDelayMs: currentDelay, throttleHits,
    sitemapSeeded: seen.size - 1
  };
}

/* ── Turning pages into findings ────────────────────────────────── */
function analyse({ pages, robots, origin, linkSources, inboundLinks = new Map(), nonCanonicalLinks = new Map(), sitemapUrls = new Set(), external = [], externalTotal = 0, throttleHits = 0, flaky = [] }) {
  const found = {};
  const add = (key, url, detail, fix, current) => {
    if (!found[key]) found[key] = [];
    found[key].push({ url, detail, fix: fix || '', current: current || '' });
  };
  const brand = 'Twin Home Buyer';

  const titles = new Map();
  const descs = new Map();

  for (const p of pages) {
    if (p.status === 0) {
      add('status5xx', p.url, p.error || 'No response',
        `The request failed outright (${p.error || 'no response'}). Check the site is up and that this URL is reachable from outside your network.`);
      continue;
    }
    if (p.status >= 500) {
      add('status5xx', p.url, `HTTP ${p.status}`,
        `Returns ${p.status}. Check the server error log for the time of this crawl — a 5xx on a linked page loses both visitors and indexing.`);
      continue;
    }
    if (p.status >= 400) {
      const sources = linkSources.get(p.url) || [];
      const from = sources[0];
      const fromPath = from ? from.replace(/^https?:\/\/[^/]+/, '') || '/' : '';
      const alsoOn = sources.length > 1 ? ` (and ${sources.length - 1} other page${sources.length > 2 ? 's' : ''})` : '';
      add('status4xx', p.url, `HTTP ${p.status}`,
        from
          ? `Returns ${p.status} and is linked from ${fromPath}${alsoOn}. If the page moved, 301 this URL to its replacement; ` +
            `if it should not exist, remove or correct the link${sources.length > 1 ? 's' : ''}.`
          : `Returns ${p.status}. If the page moved, 301 this URL to its replacement; otherwise return 410 so Google drops it.`);
      if (from) {
        add('brokenInternal', p.url, `linked from ${fromPath}${alsoOn}`,
          `${sources.length > 1 ? sources.length + ' pages link' : fromPath + ' links'} here and get${sources.length > 1 ? '' : 's'} a ${p.status}. ` +
          `Edit ${sources.length > 1 ? 'those links' : 'that link'} to point somewhere real, or restore this page.`);
      }
      continue;
    }
    if (p.contentType) continue;   // non-HTML, nothing more to check

    if (new URL(p.url).protocol === 'http:') {
      add('notHttps', p.url, 'served over HTTP', 'Serve this URL over https:// and 301 the http:// version to it.');
    }
    if (p.redirectedTo) {
      add('redirectChain', p.url, `→ ${p.redirectedTo}`,
        `Point internal links straight at ${p.redirectedTo} instead of this URL.`);
    }
    if (p.ms > 1500) {
      add('slowPage', p.url, `${(p.ms / 1000).toFixed(1)}s`,
        `Took ${(p.ms / 1000).toFixed(1)}s for ${Math.round((p.bytes || 0) / 1024)} KB of HTML. ` +
        (p.bytes > 300 * 1024
          ? 'The page is heavy as well as slow, so trim the markup and compress images.'
          : 'The HTML is small, so the delay is server time — look at hosting, plugins or database queries rather than the page itself.'));
    }
    if (p.bytes > 2 * 1024 * 1024) {
      add('largePage', p.url, `${(p.bytes / 1048576).toFixed(1)} MB`,
        `${(p.bytes / 1048576).toFixed(1)} MB of HTML before images. Move inline CSS and scripts into cached files.`);
    }

    if (!p.title) {
      const suggestion = shortenTitle((p.h1 || 'Page topic') + ' | ' + brand, 60);
      add('noTitle', p.url, 'no <title>',
        `Add a title. Based on this page's H1, something like: "${suggestion}"`);
    } else {
      const key = p.title.toLowerCase();
      const entry = titles.get(key) || { original: p.title, urls: [] };
      entry.urls.push(p.url);
      titles.set(key, entry);
      if (p.title.length > 60) {
        add('titleLength', p.url, `${p.title.length} chars — too long`,
          `Google will cut this at about 60. Dropping the tail gives "${shortenTitle(p.title, 60)}", which still reads whole.`,
          p.title);
      } else if (p.title.length < 30) {
        add('titleLength', p.url, `${p.title.length} chars — very short`,
          `Only ${p.title.length} characters, so there is room for the search term and the location — ` +
          `for example "${trimTo(p.title + ' in the Bay Area | ' + brand, 60)}".`,
          p.title);
      }
    }

    if (!p.description) {
      const opener = firstSentence(p.firstText, 150);
      add('noDescription', p.url, 'no meta description',
        opener ? `Add one. The page opens with: "${opener}" — rewrite that into 120–155 characters ending with a reason to click.`
               : 'Add a 120–155 character description of what this page offers.');
    } else {
      const key = p.description.toLowerCase();
      const dEntry = descs.get(key) || { original: p.description, urls: [] };
      dEntry.urls.push(p.url);
      descs.set(key, dEntry);
      if (p.description.length > 160) {
        add('descLength', p.url, `${p.description.length} chars — will be truncated`,
          `Cut to about 155. "${trimTo(p.description, 155)}" keeps the meaning and survives the trim.`,
          p.description);
      } else if (p.description.length < 70) {
        add('descLength', p.url, `${p.description.length} chars — very short`,
          `There is room for another ${155 - p.description.length} characters — add the benefit or the service area.`,
          p.description);
      }
    }

    if (!p.h1Count) {
      add('noH1', p.url, 'no H1',
        `Add one H1 naming the page topic${p.title ? `, e.g. "${trimTo(p.title.split('|')[0].trim(), 70)}"` : ''}.`);
    } else if (p.h1Count > 1) {
      add('multipleH1', p.url, `${p.h1Count} H1 tags`,
        `Keep "${p.h1s[0]}" as the H1 and change the ${p.h1Count - 1} other${p.h1Count > 2 ? 's' : ''} ` +
        `(${p.h1s.slice(1).map(h => `"${h}"`).join(', ')}) to <h2>.`);
    }

    if (p.imagesNoAlt) {
      add('imgNoAlt', p.url, `${p.imagesNoAlt} of ${p.images} images`,
        `Add alt text to: ${p.imagesNoAltSrc.join(', ')}${p.imagesNoAlt > p.imagesNoAltSrc.length ? ` and ${p.imagesNoAlt - p.imagesNoAltSrc.length} more` : ''}. ` +
        'Describe what each shows; use alt="" for decorative ones.');
    }
    if (!p.canonical) {
      add('noCanonical', p.url, 'no canonical tag',
        `Add to the <head>:  <link rel="canonical" href="${p.url}">`);
    }
    if (!p.viewport) add('noViewport', p.url, 'no viewport meta', 'Paste the viewport meta above into the <head>.');
    if (!p.lang) add('noLang', p.url, 'no lang attribute', 'Change <html> to <html lang="en">.');
    if (/noindex/i.test(p.robotsMeta)) {
      add('noindex', p.url, p.robotsMeta,
        `This page carries robots="${p.robotsMeta}". If it is meant to rank, remove noindex from that tag.`,
        p.robotsMeta);
    }
    if (p.canonicalCount > 1) {
      add('multipleCanonical', p.url, `${p.canonicalCount} canonical tags`,
        `${p.canonicalCount} canonical tags on one page contradict each other, so Google ignores both. Usually a plugin duplicating the theme's tag — keep one.`);
    }
    if (p.canonical) {
      const canonical = String(p.canonical).replace(/\/$/, '');
      const self = p.url.replace(/\/$/, '');
      if (canonical && canonical !== self && /^https?:/i.test(canonical)) {
        add('canonicalElsewhere', p.url, `canonical → ${canonical}`,
          `This page's canonical points at ${canonical}, so it will not rank on its own. If that is intended it is fine; if not, point the canonical at this URL.`,
          canonical);
      }
    }
    if (p.mixedContent && p.mixedContent.length) {
      add('mixedContent', p.url, `${p.mixedContent.length} insecure reference${p.mixedContent.length > 1 ? 's' : ''}`,
        `Loads over plain http: ${p.mixedContent.slice(0, 3).join(', ')}. Change each to https:// — browsers flag or block these.`);
    }
    if (p.openGraph === false) {
      add('noOpenGraph', p.url, 'no og:title or og:image',
        'Shared to Facebook, LinkedIn or a text message this renders as a bare URL. Add og:title, og:description and og:image.');
    }
    if (p.h1 && p.title && p.h1.trim().toLowerCase() === p.title.trim().toLowerCase()) {
      add('h1EqualsTitle', p.url, 'H1 repeats the title exactly',
        `Both read "${p.h1.slice(0, 60)}". Keep the title keyword-led for search results and rewrite the H1 to read naturally for the visitor.`,
        p.h1.slice(0, 90));
    }
    if ((p.depth || 0) >= 4) {
      add('deepPage', p.url, `${p.depth} clicks from the homepage`,
        `${path} sits ${p.depth} clicks deep. Link to it from a hub page or the navigation so it is no more than three from the homepage.`);
    }

    if (p.words < 200) {
      add('thinContent', p.url, `${p.words} words`,
        `${p.words} words. Aim for 600+ if this page is meant to rank — add process, timelines, costs and FAQs.`);
    }
  }

  for (const f of flaky) {
    add('flakyUnderLoad', f.url, `returned ${f.failedAs} during the crawl, 200 on re-check`,
      `This page is not broken — it failed once under crawl load and answered normally when asked again a few seconds later. ` +
      `The server is dropping requests when they arrive close together.`);
  }

  // Links written against the other hostname of the same domain. Reported per
  // target rather than per link, so a nav repeated site-wide reads as one
  // thing to fix in one template.
  for (const [target, sources] of nonCanonicalLinks) {
    const where = sources.length > 1
      ? `${sources.length} pages link here by the wrong hostname`
      : `${sources[0].replace(/^https?:\/\/[^/]+/, '') || '/'} links here by the wrong hostname`;
    add('nonCanonicalLink', target, where,
      `The link points at the other version of your domain, so the visitor is redirected before this page loads. ` +
      `Rewrite ${sources.length > 1 ? 'those hrefs' : 'that href'} to ${target}.`);
  }

  // A sitemap URL that nothing links to is reachable only by crawlers.
  const crawledOk = new Set(pages.filter(p => p.status >= 200 && p.status < 400).map(p => p.url));
  for (const url of sitemapUrls) {
    if (!crawledOk.has(url)) continue;
    if ((inboundLinks.get(url) || 0) > 0) continue;
    if (url.replace(/\/$/, '') === origin) continue;   // the homepage is not an orphan
    const path = url.replace(/^https?:\/\/[^/]+/, '') || '/';
    add('orphanPage', url, 'in the sitemap, no internal links',
      `Nothing on the site links to ${path}, so visitors cannot reach it by browsing and it inherits no authority. Link to it from a related page.`);
  }

  for (const link of external) {
    // A 401, 403 or 429 from a responding server is almost always bot
    // protection refusing this crawler, not a link that is actually dead.
    // Reporting those as broken sends people to fix working links.
    if ([401, 403, 405, 429].indexOf(link.status) > -1) continue;
    if (link.status === 0 || link.status >= 400) {
      const fromPath = link.from.replace(/^https?:\/\/[^/]+/, '') || '/';
      add('brokenExternal', link.url,
        link.error || `HTTP ${link.status}`,
        `${fromPath} links out to this address, which ${link.error ? 'could not be reached (' + link.error + ')' : 'returns ' + link.status}. ` +
        'Update the link, find a live replacement, or remove it.');
    }
  }

  for (const entry of titles.values()) {
    if (entry.urls.length > 1) entry.urls.forEach(u => add('duplicateTitle', u,
      `shared by ${entry.urls.length} pages`,
      `${entry.urls.length} pages use this exact title. Give this one a title naming its own subject — ` +
      'the city, the service, or the question it answers.',
      entry.original.slice(0, 110)));
  }
  for (const entry of descs.values()) {
    if (entry.urls.length > 1) entry.urls.forEach(u => add('duplicateDesc', u,
      `shared by ${entry.urls.length} pages`,
      `${entry.urls.length} pages share this description. Write one specific to this page.`,
      entry.original.slice(0, 110)));
  }

  const issues = Object.keys(found).map(key => {
    const guide = GUIDE[key] || {};
    return {
      key,
      title: CHECKS[key].title,
      severity: CHECKS[key].severity,
      why: guide.why || '',
      how: guide.how || '',
      snippet: guide.snippet ? guide.snippet.replace('{url}', found[key][0].url) : '',
      count: found[key].length,
      // Weight × reach, so the list is ordered by what is worth doing first.
      priority: Math.round(CHECKS[key].weight * Math.min(found[key].length, 10)),
      pages: found[key].slice(0, 50)
    };
  }).sort((a, b) => {
    const rank = { error: 0, warning: 1, notice: 2 };
    return rank[a.severity] - rank[b.severity] || b.priority - a.priority;
  });

  // Health: start at 100 and deduct by weight, scaled by how much of the site
  // each issue touches, so one bad page on a large site is not catastrophic.
  const htmlPages = pages.filter(p => !p.contentType && p.status >= 200 && p.status < 400).length || 1;
  let deductions = 0;
  for (const issue of issues) {
    const share = Math.min(1, issue.count / htmlPages);
    deductions += CHECKS[issue.key].weight * share;
  }
  const health = Math.max(0, Math.min(100, Math.round(100 - deductions)));

  const counts = { error: 0, warning: 0, notice: 0 };
  issues.forEach(i => { counts[i.severity] += i.count; });

  return {
    health,
    counts,
    issues,
    linkReport: buildLinkReport({ pages, external, linkSources, origin }),
    throttled: throttleHits > 0,
    throttleHits,
    crawled: pages.length,
    htmlPages,
    externalChecked: external.length,
    externalTotal,
    origin,
    robots: { found: robots.found, sitemaps: robots.sitemaps, disallowed: robots.disallow.length },
    pages: pages.map(p => ({
      url: p.url, status: p.status, ms: p.ms, words: p.words || 0,
      title: p.title || '', bytes: p.bytes || 0, error: p.error || ''
    })).sort((a, b) => b.status - a.status || a.url.localeCompare(b.url))
  };
}

/* ── Broken-link report ─────────────────────────────────────────
   The audit's issue list groups findings by check. This is the other
   cut of the same data: every dead URL in one place, with the status
   code, every page that links to it, and the specific repair. It is
   what someone actually works from when clearing broken links.
   ─────────────────────────────────────────────────────────────── */

// The fix depends far more on *which* failure it is than on the fact that
// something failed, so each status family gets its own instruction.
// A template placeholder that never got substituted — ${var}, {{var}}, %7Bvar%7D
// or a bare :param. The URL is malformed at the source, so whatever the far end
// returns is beside the point: the link was never built correctly.
const PLACEHOLDER = /(\$\{[^}]*\}|\{\{[^}]*\}\}|%24%7B|%7B%7B|\{[a-z_][a-z0-9_]*\})/i;

function repairFor(status, error, kind, sourceCount, url) {
  const links = sourceCount > 1 ? `all ${sourceCount} links` : 'the link';
  const pages = sourceCount > 1 ? `${sourceCount} pages` : 'the linking page';
  if (url && PLACEHOLDER.test(url)) {
    const bit = (url.match(PLACEHOLDER) || [])[0];
    return `This link contains "${bit}" — a template placeholder that was never filled in, so the URL is broken before it leaves your page. ` +
      `Find where ${pages === 'the linking page' ? 'that page' : 'those pages'} build this link and make sure the variable is substituted; ` +
      `in a theme or plugin this is usually a template string written with the wrong quotes.`;
  }
  if (kind === 'external') {
    if (status === 0) return `No response from the other site — it may be gone, or the domain may have lapsed. Open it in a browser to confirm, then update or remove ${links}.`;
    if (status === 404 || status === 410) return `The other site removed this page. Find its replacement on that site, or drop ${links}.`;
    if (status >= 500) return `The other site is erroring. Re-check in a day or two; if it stays broken, replace ${links}.`;
    return `Returns ${status}. Confirm in a browser, then update ${links} if it really is dead.`;
  }
  if (status === 0) return `The request failed outright${error ? ` (${error})` : ''}. Check the site is up and this URL is reachable from outside your network — if it only fails for the crawler, look at your firewall or bot protection.`;
  if (status === 404) return `Nothing at this URL. If the page moved, add a 301 from here to its replacement — that keeps the ranking. If it was never meant to exist, correct the href on ${pages}.`;
  if (status === 410) return `Deliberately gone. Only fix this if ${links} should not be there — remove ${sourceCount > 1 ? 'them' : 'it'}.`;
  if (status === 403 || status === 401) return `The server refuses this request. Usually bot protection rather than a dead page — open it in a browser. If it loads fine, allow the crawler; if not, it needs restoring or the link needs removing.`;
  if (status === 429) return 'Rate limited during the crawl, not necessarily broken. Re-run the audit at a gentler speed to confirm.';
  if (status >= 500) return `Your server errors on this URL. Check the error log for the time of this crawl — a linked page returning ${status} loses both visitors and indexing.`;
  return `Returns ${status}. Point ${links} at a URL that resolves, or fix the response for this one.`;
}

function buildLinkReport({ pages, external, linkSources, origin }) {
  const short = u => (u || '').replace(/^https?:\/\/[^/]+/, '') || '/';
  const items = [];
  const totals = {
    notFound: 0, gone: 0, forbidden: 0, otherClient: 0,
    serverError: 0, noResponse: 0, externalBroken: 0
  };

  for (const p of pages) {
    if (p.status !== 0 && p.status < 400) continue;
    const sources = linkSources.get(p.url) || [];
    if (p.status === 0) totals.noResponse++;
    else if (p.status === 404) totals.notFound++;
    else if (p.status === 410) totals.gone++;
    else if (p.status === 401 || p.status === 403) totals.forbidden++;
    else if (p.status >= 500) totals.serverError++;
    else totals.otherClient++;
    items.push({
      url: p.url,
      path: short(p.url),
      kind: 'internal',
      status: p.status,
      label: p.status === 0 ? (p.error || 'No response') : 'HTTP ' + p.status,
      sources: sources.map(short),
      sourceCount: sources.length,
      linked: sources.length > 0,
      fix: repairFor(p.status, p.error, 'internal', sources.length, p.url)
    });
  }

  for (const link of external) {
    // Same rule as the issue list: a 401/403/405/429 from a responding server
    // is bot protection, not a dead link. Listing those wastes the reader's
    // time chasing links that work perfectly well for a human.
    if ([401, 403, 405, 429].indexOf(link.status) > -1) continue;
    if (link.status !== 0 && link.status < 400) continue;
    const sources = link.sources || (link.from ? [link.from] : []);
    totals.externalBroken++;
    items.push({
      url: link.url,
      path: link.url.replace(/^https?:\/\//, '').slice(0, 80),
      kind: 'external',
      status: link.status,
      label: link.error || 'HTTP ' + link.status,
      sources: sources.map(short),
      sourceCount: sources.length,
      linked: sources.length > 0,
      fix: repairFor(link.status, link.error, 'external', sources.length, link.url)
    });
  }

  // Worst first, and within a severity the ones linked from the most pages —
  // fixing those clears the most dead ends per edit.
  const rank = s => (s === 0 ? 0 : s >= 500 ? 1 : s === 404 || s === 410 ? 2 : 3);
  items.sort((a, b) =>
    (a.kind === b.kind ? 0 : a.kind === 'internal' ? -1 : 1) ||
    rank(a.status) - rank(b.status) ||
    b.sourceCount - a.sourceCount ||
    a.path.localeCompare(b.path));

  totals.internalBroken = items.filter(i => i.kind === 'internal').length;
  totals.broken = items.length;
  // Dead ends a visitor can actually hit by clicking, which is the number
  // that matters: an unlinked 404 found via the sitemap harms nobody today.
  totals.reachable = items.filter(i => i.linked).length;
  totals.linkInstances = items.reduce((n, i) => n + i.sourceCount, 0);

  return { totals, items };
}

async function runAudit(startUrl, options, onProgress, shouldStop, shouldPause) {
  const crawled = await crawl(startUrl, options, onProgress, shouldStop, shouldPause);
  const result = analyse(crawled);
  result.stopped = Boolean(shouldStop && shouldStop());
  result.settings = {
    maxPages: options && options.maxPages,
    delayMs: crawled.delayMs,
    concurrency: (options && options.concurrency) || 2,
    fromSitemap: crawled.sitemapSeeded
  };
  return result;
}

module.exports = { runAudit, CHECKS, crawl, stripTags };
