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
  largePage:        { severity: 'notice',  weight: 1,  title: 'Large page weight' }
};

const HINTS = {
  status5xx: 'The server failed on these URLs. Until they respond, neither users nor crawlers can reach them.',
  status4xx: 'These URLs are linked but do not exist. Fix the link or restore the page.',
  brokenInternal: 'Links on your site point at URLs that do not resolve.',
  noTitle: 'The title is the headline in search results. Without one Google writes its own.',
  duplicateTitle: 'Pages sharing a title compete with each other and look identical in results.',
  noH1: 'Each page wants one H1 stating what it is about.',
  multipleH1: 'Several H1s blur what the page is about. Keep one, demote the rest to H2.',
  noDescription: 'Without a description Google picks a snippet from the page, often badly.',
  duplicateDesc: 'The same description across pages wastes the snippet.',
  titleLength: 'Aim for roughly 30–60 characters; longer gets truncated in results.',
  descLength: 'Aim for roughly 70–160 characters.',
  imgNoAlt: 'Alt text is what screen readers announce and what image search reads.',
  slowPage: 'Responses over 1.5s hurt both ranking and the visitor.',
  redirectChain: 'Links pointing at the final URL save a round trip.',
  noCanonical: 'A canonical tag tells Google which URL is the real one.',
  noViewport: 'Without a viewport meta, phones render the desktop layout zoomed out.',
  noLang: 'The lang attribute helps search engines and screen readers.',
  notHttps: 'HTTP pages are marked "not secure" and rank below their HTTPS equivalents.',
  noindex: 'These pages tell search engines to stay away. Intentional for some, fatal for others.',
  thinContent: 'Under 200 words rarely competes for anything.',
  largePage: 'Pages over 2 MB are slow on phones and mobile data.'
};

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
  const rules = { disallow: [], sitemaps: [], found: false };
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
      else if (key === 'sitemap') rules.sitemaps.push(value);
    }
  } catch (e) { /* no robots.txt is not an error */ }
  return rules;
}

function blockedByRobots(pathname, rules) {
  return rules.disallow.some(rule => rule !== '/' && pathname.startsWith(rule));
}

/* ── The crawl ──────────────────────────────────────────────────── */
async function crawl(startUrl, options, onProgress) {
  const opts = Object.assign({ maxPages: 40, concurrency: 4, timeoutMs: 15000 }, options);
  const start = new URL(startUrl);
  const origin = start.origin;

  const robots = await fetchRobots(origin);
  const queue = [start.toString()];
  const seen = new Set(queue);
  const pages = [];
  const linkSources = new Map();   // url → the page that linked to it

  async function visit(url) {
    const began = Date.now();
    const page = { url, status: 0, ms: 0, redirectedTo: null, bytes: 0, issues: [] };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
        redirect: 'follow',
        signal: controller.signal
      });
      clearTimeout(timer);

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
      page.viewport = Boolean(metaContent(html, 'viewport'));
      page.lang = Boolean(html.match(/<html[^>]+lang\s*=/i));
      const h1s = html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi) || [];
      page.h1Count = h1s.length;
      page.h1 = h1s.length ? stripTags(h1s[0]).slice(0, 120) : null;

      const imgs = html.match(/<img\b[^>]*>/gi) || [];
      page.images = imgs.length;
      page.imagesNoAlt = imgs.filter(t => !/\balt\s*=/i.test(t)).length;

      page.words = stripTags(html).split(' ').filter(Boolean).length;

      const links = extractLinks(html, url);
      page.internalLinks = 0;
      for (const link of links) {
        let u;
        try { u = new URL(link); } catch (e) { continue; }
        if (u.origin !== origin) continue;
        page.internalLinks++;
        if (!linkSources.has(link)) linkSources.set(link, url);
        if (seen.size >= opts.maxPages || seen.has(link)) continue;
        if (blockedByRobots(u.pathname, robots)) continue;
        if (/\.(pdf|jpg|jpeg|png|gif|webp|svg|zip|mp4|css|js|xml|ico)$/i.test(u.pathname)) continue;
        seen.add(link);
        queue.push(link);
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
  await new Promise(resolve => {
    const pump = () => {
      if (!queue.length && active === 0) return resolve();
      while (active < opts.concurrency && queue.length && pages.length < opts.maxPages) {
        const url = queue.shift();
        active++;
        visit(url).then(page => {
          pages.push(page);
          if (onProgress) onProgress(pages.length, pages.length + queue.length);
        }).catch(() => {}).then(() => { active--; pump(); });
      }
      if (pages.length >= opts.maxPages && active === 0) resolve();
    };
    pump();
  });

  return { pages, robots, origin, linkSources };
}

/* ── Turning pages into findings ────────────────────────────────── */
function analyse({ pages, robots, origin, linkSources }) {
  const found = {};
  const add = (key, url, detail) => {
    if (!found[key]) found[key] = [];
    found[key].push({ url, detail });
  };

  const titles = new Map();
  const descs = new Map();

  for (const p of pages) {
    if (p.status === 0) { add('status5xx', p.url, p.error || 'No response'); continue; }
    if (p.status >= 500) { add('status5xx', p.url, `HTTP ${p.status}`); continue; }
    if (p.status >= 400) {
      const from = linkSources.get(p.url);
      add('status4xx', p.url, `HTTP ${p.status}`);
      if (from) add('brokenInternal', p.url, `linked from ${from}`);
      continue;
    }
    if (p.contentType) continue;   // non-HTML, nothing more to check

    if (new URL(p.url).protocol === 'http:') add('notHttps', p.url, 'served over HTTP');
    if (p.redirectedTo) add('redirectChain', p.url, `→ ${p.redirectedTo}`);
    if (p.ms > 1500) add('slowPage', p.url, `${(p.ms / 1000).toFixed(1)}s`);
    if (p.bytes > 2 * 1024 * 1024) add('largePage', p.url, `${(p.bytes / 1048576).toFixed(1)} MB`);

    if (!p.title) add('noTitle', p.url, 'no <title>');
    else {
      const key = p.title.toLowerCase();
      titles.set(key, (titles.get(key) || []).concat(p.url));
      if (p.title.length > 60) add('titleLength', p.url, `${p.title.length} chars — too long`);
      else if (p.title.length < 30) add('titleLength', p.url, `${p.title.length} chars — very short`);
    }

    if (!p.description) add('noDescription', p.url, 'no meta description');
    else {
      const key = p.description.toLowerCase();
      descs.set(key, (descs.get(key) || []).concat(p.url));
      if (p.description.length > 160) add('descLength', p.url, `${p.description.length} chars — will be truncated`);
      else if (p.description.length < 70) add('descLength', p.url, `${p.description.length} chars — very short`);
    }

    if (!p.h1Count) add('noH1', p.url, 'no H1');
    else if (p.h1Count > 1) add('multipleH1', p.url, `${p.h1Count} H1 tags`);

    if (p.imagesNoAlt) add('imgNoAlt', p.url, `${p.imagesNoAlt} of ${p.images} images`);
    if (!p.canonical) add('noCanonical', p.url, 'no canonical tag');
    if (!p.viewport) add('noViewport', p.url, 'no viewport meta');
    if (!p.lang) add('noLang', p.url, 'no lang attribute');
    if (/noindex/i.test(p.robotsMeta)) add('noindex', p.url, p.robotsMeta);
    if (p.words < 200) add('thinContent', p.url, `${p.words} words`);
  }

  for (const [title, urls] of titles) {
    if (urls.length > 1) urls.forEach(u => add('duplicateTitle', u, `shared by ${urls.length} pages: "${title.slice(0, 60)}"`));
  }
  for (const [desc, urls] of descs) {
    if (urls.length > 1) urls.forEach(u => add('duplicateDesc', u, `shared by ${urls.length} pages`));
  }

  const issues = Object.keys(found).map(key => ({
    key,
    title: CHECKS[key].title,
    severity: CHECKS[key].severity,
    hint: HINTS[key] || '',
    count: found[key].length,
    pages: found[key].slice(0, 50)
  })).sort((a, b) => {
    const rank = { error: 0, warning: 1, notice: 2 };
    return rank[a.severity] - rank[b.severity] || b.count - a.count;
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
    crawled: pages.length,
    htmlPages,
    origin,
    robots: { found: robots.found, sitemaps: robots.sitemaps, disallowed: robots.disallow.length },
    pages: pages.map(p => ({
      url: p.url, status: p.status, ms: p.ms, words: p.words || 0,
      title: p.title || '', bytes: p.bytes || 0, error: p.error || ''
    })).sort((a, b) => b.status - a.status || a.url.localeCompare(b.url))
  };
}

async function runAudit(startUrl, options, onProgress) {
  const crawled = await crawl(startUrl, options, onProgress);
  return analyse(crawled);
}

module.exports = { runAudit, CHECKS };
