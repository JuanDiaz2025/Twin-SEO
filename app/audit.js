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
  }
};

// Trim to a whole word at or under a limit.
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

async function crawl(startUrl, options, onProgress, shouldStop) {
  const opts = Object.assign({
    maxPages: 40,
    concurrency: 2,
    delayMs: 400,      // spacing between requests, not per worker
    timeoutMs: 20000,
    retries: 2
  }, options);
  const start = new URL(startUrl);
  const origin = start.origin;

  const robots = await fetchRobots(origin);
  // A site asking for a slower crawl gets one.
  const delayMs = Math.max(opts.delayMs, robots.crawlDelayMs || 0);

  const queue = [start.toString()];
  const seen = new Set(queue);
  const pages = [];
  const linkSources = new Map();   // url → the page that linked to it

  // Seed from the sitemap so orphaned pages are not missed.
  if (opts.maxPages > 25) {
    const fromSitemap = await fetchSitemapUrls(origin, robots.sitemaps, opts.maxPages);
    for (const url of fromSitemap) {
      if (seen.size >= opts.maxPages) break;
      if (seen.has(url)) continue;
      try {
        if (blockedByRobots(new URL(url).pathname, robots)) continue;
      } catch (e) { continue; }
      seen.add(url);
      queue.push(url);
    }
  }

  // One shared clock, so the request rate holds whatever the concurrency is.
  let nextSlot = 0;
  let currentDelay = delayMs;
  let throttleHits = 0;
  async function throttle() {
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

  async function visit(url) {
    const page = { url, status: 0, ms: 0, redirectedTo: null, bytes: 0, issues: [] };
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

      // Body text minus the chrome, for suggesting a description.
      const body = html.replace(/<(header|nav|footer|aside)[\s\S]*?<\/\1>/gi, ' ');
      page.words = stripTags(html).split(' ').filter(Boolean).length;
      page.firstText = stripTags(body).slice(0, 400);

      // ── Signals that decide whether an AI assistant can quote this page ──
      page.schemaTypes = [];
      page.schemaBroken = 0;
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
  let stopped = false;
  await new Promise(resolve => {
    const pump = () => {
      if (shouldStop && shouldStop()) stopped = true;
      if (stopped && active === 0) return resolve();
      if (!stopped && !queue.length && active === 0) return resolve();
      while (!stopped && active < opts.concurrency && queue.length && pages.length + active < opts.maxPages) {
        const url = queue.shift();
        active++;
        visit(url).then(page => {
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

  return {
    pages, robots, origin, linkSources,
    delayMs, finalDelayMs: currentDelay, throttleHits,
    sitemapSeeded: seen.size - 1
  };
}

/* ── Turning pages into findings ────────────────────────────────── */
function analyse({ pages, robots, origin, linkSources, throttleHits = 0 }) {
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
      const from = linkSources.get(p.url);
      const fromPath = from ? from.replace(/^https?:\/\/[^/]+/, '') || '/' : '';
      add('status4xx', p.url, `HTTP ${p.status}`,
        from
          ? `Returns ${p.status} and is linked from ${fromPath}. If the page moved, 301 this URL to its replacement; ` +
            `if it should not exist, remove or correct the link on ${fromPath}.`
          : `Returns ${p.status}. If the page moved, 301 this URL to its replacement; otherwise return 410 so Google drops it.`);
      if (from) {
        add('brokenInternal', p.url, `linked from ${fromPath}`,
          `${fromPath} links here and gets a ${p.status}. Edit that link to point somewhere real, or restore this page.`);
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
    if (p.words < 200) {
      add('thinContent', p.url, `${p.words} words`,
        `${p.words} words. Aim for 600+ if this page is meant to rank — add process, timelines, costs and FAQs.`);
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
    throttled: throttleHits > 0,
    throttleHits,
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

async function runAudit(startUrl, options, onProgress, shouldStop) {
  const crawled = await crawl(startUrl, options, onProgress, shouldStop);
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
