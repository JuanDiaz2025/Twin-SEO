'use strict';

/**
 * AI Search readiness — what decides whether ChatGPT, Google's AI Overviews,
 * Gemini and Perplexity can quote this site.
 *
 * Three things have to be true, in order:
 *   1. The assistants' crawlers are allowed in at all.
 *   2. They can tell what the business is — structured data and confirmed
 *      identity links.
 *   3. The pages contain passages worth lifting: a question, then a short,
 *      self-contained answer.
 *
 * Everything here is measured from the site itself, so the findings are
 * specific rather than generic advice.
 */

const { crawl } = require('./audit');

/* ── The crawlers that matter, and what they feed ───────────────── */
const AI_BOTS = [
  { ua: 'GPTBot',            engine: 'ChatGPT',        role: 'Trains and grounds ChatGPT answers' },
  { ua: 'OAI-SearchBot',     engine: 'ChatGPT Search', role: 'Builds ChatGPT\'s search index' },
  { ua: 'ChatGPT-User',      engine: 'ChatGPT',        role: 'Fetches a page when a user asks about it' },
  { ua: 'ClaudeBot',         engine: 'Claude',         role: 'Indexes pages for Claude' },
  { ua: 'PerplexityBot',     engine: 'Perplexity',     role: 'Perplexity\'s index — heavy citer of sources' },
  { ua: 'Google-Extended',   engine: 'Gemini & AI Overviews', role: 'Controls use in Gemini and AI Overviews' },
  { ua: 'Applebot-Extended', engine: 'Apple Intelligence', role: 'Apple\'s AI features' },
  { ua: 'CCBot',             engine: 'Common Crawl',   role: 'Feeds many models\' training sets' },
  { ua: 'meta-externalagent', engine: 'Meta AI',       role: 'Meta\'s assistant' }
];

const CHECKS = {
  botBlocked:      { severity: 'error',   weight: 14, title: 'AI crawlers blocked in robots.txt' },
  noOrgSchema:     { severity: 'error',   weight: 12, title: 'No Organization or LocalBusiness schema' },
  noSameAs:        { severity: 'error',   weight: 10, title: 'No sameAs identity links' },
  faqNoSchema:     { severity: 'error',   weight: 10, title: 'FAQ content without FAQPage schema' },
  brokenSchema:    { severity: 'error',   weight: 8,  title: 'Structured data that fails to parse' },
  noSchema:        { severity: 'warning', weight: 6,  title: 'Pages with no structured data' },
  fewQuestions:    { severity: 'warning', weight: 6,  title: 'Content not shaped as questions and answers' },
  noLlmsTxt:       { severity: 'warning', weight: 4,  title: 'No llms.txt' },
  noFreshness:     { severity: 'warning', weight: 4,  title: 'No last-updated date' },
  noExtractable:   { severity: 'warning', weight: 4,  title: 'Nothing an assistant can lift cleanly' },
  thinForAi:       { severity: 'notice',  weight: 3,  title: 'Too short to answer a question fully' },
  noServiceArea:   { severity: 'notice',  weight: 3,  title: 'Service area not declared in schema' },
  noSpeakable:     { severity: 'notice',  weight: 2,  title: 'No speakable markup' },
  noDirectAnswer:  { severity: 'error',   weight: 10, title: 'Page does not answer its own headline' },
  duplicateOpening:{ severity: 'error',   weight: 9,  title: 'Pages open with the same words' },
  noContactPoint:  { severity: 'error',   weight: 9,  title: 'No phone or contact point in schema' },
  noFigures:       { severity: 'warning', weight: 6,  title: 'No concrete figures to quote' },
  noAuthorship:    { severity: 'warning', weight: 5,  title: 'Nothing says who stands behind the page' },
  noBreadcrumbs:   { severity: 'notice',  weight: 3,  title: 'No BreadcrumbList markup' },
  processNoHowTo:  { severity: 'warning', weight: 5,  title: 'Step-by-step content without HowTo schema' }
};

const GUIDE = {
  botBlocked: {
    why: 'A blocked crawler cannot read the site, so its assistant can never cite you. This is the one setting that makes everything else pointless.',
    how: 'Allow the assistants you want to be visible in. Blocking is a legitimate choice for training crawlers, but blocking the search-facing ones costs you citations.'
  },
  noOrgSchema: {
    why: 'Assistants answer about entities, not pages. Without Organization or LocalBusiness markup, nothing states what this business is, where it operates, or how to contact it — so you are a web page rather than a company they can recommend.',
    how: 'Add LocalBusiness JSON-LD to the homepage with the legal name, address, phone, hours and service area.'
  },
  noSameAs: {
    why: 'sameAs links are how a model confirms that this site and the business it sees elsewhere are the same entity. Without them your profiles are separate, unconnected mentions.',
    how: 'List every profile you control in the schema: Google Business Profile, BBB, Yelp, Nextdoor, Facebook, LinkedIn.'
  },
  faqNoSchema: {
    why: 'Question-and-answer pairs are the single most quoted format in AI answers, and FAQPage markup is what tells an assistant a passage is exactly that. You have the content; it is just not labelled.',
    how: 'Wrap the existing questions and answers in FAQPage JSON-LD. No copy needs rewriting.'
  },
  brokenSchema: {
    why: 'Structured data that fails to parse is ignored completely, so the effort already spent is producing nothing.',
    how: 'Run the page through validator.schema.org and fix the JSON error.'
  },
  noSchema: {
    why: 'A page with no structured data is read as prose. Assistants can still quote it, but they have to infer everything.',
    how: 'Add the type that matches the page: Service, FAQPage, HowTo, Article, or at minimum WebPage.'
  },
  fewQuestions: {
    why: 'Assistants retrieve passages, not pages. A heading phrased as the question someone actually asks, followed by a two-or-three-sentence answer, is the shape that gets lifted verbatim.',
    how: 'Rewrite section headings as the questions your sellers ask, and answer each in the first 40 words below it.'
  },
  noLlmsTxt: {
    why: 'llms.txt is an emerging convention that points assistants at the pages you most want used, in plain markdown.',
    how: 'Publish /llms.txt listing your key pages with a line of context each.'
  },
  noFreshness: {
    why: 'For anything about prices, timelines or regulations, assistants prefer sources that show when they were last updated.',
    how: 'Add dateModified to the page schema and show the date on the page.'
  },
  noExtractable: {
    why: 'Walls of prose are hard to quote. Lists, tables and step sequences give an assistant a clean block to lift with its structure intact.',
    how: 'Turn processes into numbered steps and comparisons into tables.'
  },
  thinForAi: {
    why: 'A short page rarely answers a question completely enough to be chosen as the source.',
    how: 'Cover the whole question: what it costs, how long it takes, what happens at each stage, and what the alternatives are.'
  },
  noServiceArea: {
    why: 'Most searches that matter to you are local. Without a declared service area, an assistant cannot confidently recommend you for a city.',
    how: 'Add areaServed to the LocalBusiness schema, naming each city and county you buy in.'
  },
  noSpeakable: {
    why: 'speakable marks the sentences best suited to being read aloud, which voice assistants use when choosing what to say.',
    how: 'Add a speakable property pointing at your summary paragraphs.'
  },
  noDirectAnswer: {
    why: 'An assistant reads the top of the page and takes the first passage that answers the question. Pages that open with a slogan or a call to action give it nothing to lift, so it moves on to a competitor who answered in their first sentence.',
    how: 'Open every page with one plain sentence that answers its own headline, then sell underneath. "We buy houses in San Carlos for cash and can close in seven days" beats "Sell your home the easy way!" every time.'
  },
  duplicateOpening: {
    why: 'When many pages start with the same paragraph, an assistant treats them as one source and keeps a single page — usually not the one you want. This is what quietly limits city and situation pages built from a template.',
    how: 'Give each page its own opening two sentences, naming the specific city or situation and something true only of it — a local timeline, a neighbourhood, a typical price.'
  },
  noContactPoint: {
    why: 'An assistant recommending a business is asked "how do I reach them?" next. If the phone number lives only in a header image or plain text, it cannot pass it on with any confidence.',
    how: 'Add telephone, email and a ContactPoint node to the LocalBusiness schema so the details are machine-readable.'
  },
  noFigures: {
    why: 'Assistants quote specifics. "Closes in as little as 7 days, no fees, no repairs" is quotable; "fast, easy and hassle-free" is not, and gets paraphrased away to nothing.',
    how: 'Put real numbers on the page — days to close, percentage of market value, typical fees avoided, houses bought — and keep them current.'
  },
  noAuthorship: {
    why: 'Assistants weigh who is behind a claim. A page with no named author or publisher is a weaker source than the same page attributed to a real business with a real person.',
    how: 'Add author and publisher to the page schema, and put a short "written by" line with a role on the page.'
  },
  noBreadcrumbs: {
    why: 'BreadcrumbList tells an assistant where a page sits — that a city page belongs under service areas rather than floating alone — which helps it pick the right page to cite.',
    how: 'Add BreadcrumbList JSON-LD reflecting the path a visitor took to reach the page.'
  },
  processNoHowTo: {
    why: 'Numbered processes are the exact shape assistants use to answer "how does it work?", but only HowTo markup tells them these steps belong together in order.',
    how: 'Wrap the existing numbered steps in HowTo JSON-LD, with a name and one HowToStep per step. The copy does not change.'
  }
};

/* ── robots.txt, read per bot ────────────────────────────────────── */
async function botAccess(origin) {
  const out = { fetched: false, bots: [], llmsTxt: false };
  let text = '';
  try {
    const res = await fetch(`${origin}/robots.txt`, { headers: { 'User-Agent': 'TwinSEO-AISearch/1.0' } });
    if (res.ok) { text = await res.text(); out.fetched = true; }
  } catch (e) { /* treated as no robots.txt, which means allowed */ }

  try {
    const res = await fetch(`${origin}/llms.txt`, { headers: { 'User-Agent': 'TwinSEO-AISearch/1.0' } });
    out.llmsTxt = res.ok;
  } catch (e) { /* absent */ }

  // Group the file into user-agent blocks so each bot can be judged on the
  // rules that actually apply to it, plus the wildcard block.
  const groups = new Map();
  let current = [];
  for (const line of text.split('\n')) {
    const clean = line.split('#')[0].trim();
    if (!clean) continue;
    const idx = clean.indexOf(':');
    if (idx < 0) continue;
    const key = clean.slice(0, idx).trim().toLowerCase();
    const value = clean.slice(idx + 1).trim();
    if (key === 'user-agent') {
      const name = value.toLowerCase();
      if (!groups.has(name)) groups.set(name, []);
      current = groups.get(name);
    } else if (key === 'disallow' || key === 'allow') {
      current.push({ rule: key, path: value });
    }
  }

  // "Disallow:" with an empty value is the canonical allow-everything rule —
  // the opposite of "Disallow: /". Conflating the two reports a wide-open site
  // as fully blocked, which is the worst possible way to be wrong here.
  const blocksRoot = rules => rules.some(r => r.rule === 'disallow' && r.path === '/')
    && !rules.some(r => r.rule === 'allow' && r.path === '/');

  for (const bot of AI_BOTS) {
    const own = groups.get(bot.ua.toLowerCase());
    const wildcard = groups.get('*') || [];
    let state, source;
    if (own) {
      state = blocksRoot(own) ? 'blocked' : 'allowed';
      source = 'named in robots.txt';
    } else if (wildcard.length && blocksRoot(wildcard)) {
      state = 'blocked';
      source = 'blocked by the * rule';
    } else {
      state = 'allowed';
      source = out.fetched ? 'not restricted' : 'no robots.txt';
    }
    out.bots.push(Object.assign({ state, source }, bot));
  }
  return out;
}

/* ── Ready-to-paste markup, built from the site's own data ───────── */
function buildLocalBusiness(profile, sameAs) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    '@id': profile.origin + '/#business',
    name: profile.name,
    url: profile.origin + '/',
    telephone: profile.phone || '+1-000-000-0000',
    address: {
      '@type': 'PostalAddress',
      streetAddress: profile.street,
      addressLocality: profile.city,
      addressRegion: profile.region,
      postalCode: profile.postalCode,
      addressCountry: 'US'
    },
    areaServed: profile.areaServed.map(a => ({ '@type': 'City', name: a })),
    sameAs: sameAs
  }, null, 2);
}

function buildFaqPage(questions, url) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    '@id': url + '#faq',
    mainEntity: questions.slice(0, 5).map(q => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: 'Paste the answer already on the page here.' }
    }))
  }, null, 2);
}

/* ── Analysis ────────────────────────────────────────────────────── */
// Words that carry no topic, so echoing them back proves nothing about
// whether an opening sentence actually answered the headline.
const STOPWORDS = ['your', 'with', 'that', 'this', 'from', 'have', 'will', 'more', 'when',
  'what', 'which', 'their', 'there', 'about', 'into', 'been', 'they', 'them', 'than',
  'then', 'here', 'just', 'like', 'over', 'also', 'best', 'take', 'make', 'need', 'want',
  'fast', 'easy', 'today', 'help', 'free', 'home', 'house', 'houses', 'homes'];

function analyse({ pages, origin }, access, profile) {
  const found = {};
  const add = (key, url, detail, fix, current) => {
    if (!found[key]) found[key] = [];
    found[key].push({ url, detail, fix: fix || '', current: current || '' });
  };

  const html = pages.filter(p => !p.contentType && p.status >= 200 && p.status < 400 && p.schemaTypes);
  const snippets = {};

  // 1. Access — nothing else matters if the door is shut.
  const blocked = access.bots.filter(b => b.state === 'blocked');
  blocked.forEach(b => add('botBlocked', origin + '/robots.txt',
    b.ua + ' — ' + b.engine,
    `${b.ua} is ${b.source}, so ${b.engine} cannot read this site. ${b.role}. ` +
    `To allow it, add a "User-agent: ${b.ua}" block with "Disallow:" (empty) to robots.txt.`));

  if (!access.llmsTxt) {
    add('noLlmsTxt', origin + '/llms.txt', 'not published',
      'Publish /llms.txt as a plain markdown list of your most useful pages — the cash-offer process, service areas, FAQs — with a line of context each.');
  }

  // 2. Identity — can a model tell what this business is?
  const allTypes = new Set();
  html.forEach(p => p.schemaTypes.forEach(t => allTypes.add(t)));
  const hasOrg = allTypes.has('Organization') || allTypes.has('LocalBusiness') || allTypes.has('RealEstateAgent');
  const everySameAs = [].concat.apply([], html.map(p => p.sameAs || []));

  const suggestedSameAs = profile.sameAs;
  if (!hasOrg) {
    add('noOrgSchema', origin + '/', 'no Organization or LocalBusiness anywhere',
      'Add LocalBusiness JSON-LD to the homepage. The block below is built from your own details — check the phone number and add any missing cities.');
    snippets.noOrgSchema = buildLocalBusiness(profile, suggestedSameAs);
  } else if (!everySameAs.length) {
    add('noSameAs', origin + '/', 'schema present, sameAs empty',
      'Your Organization schema has no sameAs array, so nothing connects this site to your profiles elsewhere. ' +
      'Add the block below inside the existing LocalBusiness node and include every profile you control.',
      'sameAs: (none)');
    snippets.noSameAs = JSON.stringify({ sameAs: suggestedSameAs }, null, 2);
  }

  const hasAreaServed = html.some(p => p.schemaTypes.length && /RealEstateAgent|LocalBusiness/.test(p.schemaTypes.join(',')));
  if (hasAreaServed && !everySameAs.length) {
    add('noServiceArea', origin + '/', 'areaServed not detected',
      'Add areaServed to the LocalBusiness node naming each city you buy in — San Carlos, San Mateo, Concord, San Jose, Union City, Dixon, San Francisco.');
  }

  // 3. Passage quality, page by page.
  let questionTotal = 0, headingTotal = 0;
  for (const p of html) {
    const path = p.url.replace(/^https?:\/\/[^/]+/, '') || '/';
    questionTotal += p.questionHeadings.length;
    headingTotal += p.headings.length;

    if (p.schemaBroken) {
      add('brokenSchema', p.url, `${p.schemaBroken} block${p.schemaBroken > 1 ? 's' : ''} failed to parse`,
        'A JSON-LD block on this page is malformed, so search engines and assistants discard it entirely. Validate it at validator.schema.org.');
    }

    if (!p.schemaTypes.length) {
      add('noSchema', p.url, 'no structured data',
        `Nothing on ${path} declares what it is. Add the matching type — Service for a service page, HowTo for a process, Article for a post.`);
    }

    // FAQ content that is not labelled as FAQ is the biggest easy win.
    const looksFaq = /faq|frequently-asked|questions/i.test(p.url) || p.questionHeadings.length >= 3;
    if (looksFaq && !p.schemaTypes.includes('FAQPage')) {
      add('faqNoSchema', p.url,
        `${p.questionHeadings.length || p.headings.length} questions, no FAQPage markup`,
        `${path} reads as a Q&A page but carries no FAQPage schema, so assistants have to guess that these are questions. ` +
        'Wrap the existing pairs in the block below — the copy does not change.',
        p.schemaTypes.join(', ') || 'no schema');
      if (!snippets.faqNoSchema) {
        snippets.faqNoSchema = buildFaqPage(
          p.questionHeadings.length ? p.questionHeadings : p.headings, p.url);
      }
    }

    if (!p.dateModified) {
      add('noFreshness', p.url, 'no dateModified',
        `Add dateModified to ${path}'s schema and show "Last updated" on the page. Costs and timelines date quickly, and assistants prefer sources that prove they are current.`);
    }

    if (!p.lists && !p.tables && p.words > 300) {
      add('noExtractable', p.url, `${p.words} words, no lists or tables`,
        `${path} is unbroken prose. Turn the process into numbered steps and any comparison into a table so an assistant has a clean block to quote.`);
    }

    if (p.words < 400) {
      add('thinForAi', p.url, `${p.words} words`,
        `${p.words} words is rarely enough to answer a question completely. Add costs, timelines, the step sequence, and how it compares to listing with an agent.`);
    }
  }

  // 3b. Does the page answer its own headline in its first breath?
  //     An assistant lifts the first passage that answers the question; a page
  //     opening on a slogan hands it nothing.
  for (const p of html) {
    const path = p.url.replace(/^https?:\/\/[^/]+/, '') || '/';
    // The text under the headline, not the top of the document: page builders
    // put sticky bars and phone banners before the content.
    const opening = ((p.afterH1 || p.firstText) || '').trim();
    if (!opening || p.words < 120) continue;   // too little text to judge fairly
    const firstSentence = opening.split(/(?<=[.!?])\s/)[0] || opening.slice(0, 160);
    // Content words from the headline that a real answer would echo back.
    const topic = (p.h1 || p.title || '')
      .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter(w => w.length > 3 && STOPWORDS.indexOf(w) === -1);
    if (!topic.length) continue;
    const lead = firstSentence.toLowerCase();
    const echoed = topic.filter(w => lead.indexOf(w) > -1).length;
    // A sentence that repeats none of the headline's own words, or that is a
    // bare call to action, is not an answer to anything.
    const isCta = /^(get|call|contact|request|fill|click|start|sell|need|want|looking|tired|ready)\b/i.test(firstSentence) &&
      firstSentence.length < 120;
    // A long opening with no literal overlap is usually still an answer, just
    // phrased differently — only a short slogan or a call to action is not.
    if (isCta || (echoed === 0 && firstSentence.length < 90)) {
      add('noDirectAnswer', p.url,
        isCta ? 'opens with a call to action' : 'opens with a slogan, not an answer',
        `${path} is headed "${(p.h1 || p.title || '').slice(0, 70)}" but opens with "${firstSentence.slice(0, 90)}". ` +
        'Lead with one sentence that answers that headline plainly, then sell underneath.',
        firstSentence.slice(0, 110));
    }

    if (!p.figures) {
      add('noFigures', p.url, 'no numbers in the copy',
        `${path} makes its case in adjectives. Add the figures a seller wants — days to close, ` +
        'percentage of market value, fees avoided — so there is something specific to quote.');
    }

    const props = p.schemaProps || [];
    if (p.schemaTypes.length && props.indexOf('author') === -1 && props.indexOf('publisher') === -1) {
      add('noAuthorship', p.url, 'no author or publisher in the schema',
        `${path} has structured data but nothing saying who stands behind it. Add author and publisher to the schema.`);
    }

    // Numbered steps in the copy, but nothing marking them as a procedure.
    const looksProcess = /how-(it-)?works|process|steps|guide|selling|sell-your/i.test(p.url) ||
      p.headings.some(h => /^\s*(step\s*\d|\d[.)]\s)/i.test(h));
    if (looksProcess && p.lists && !p.schemaTypes.includes('HowTo')) {
      add('processNoHowTo', p.url, `${p.lists} list${p.lists > 1 ? 's' : ''}, no HowTo markup`,
        `${path} lays out a process but nothing marks it as one. Wrap the existing steps in HowTo schema — the copy does not change.`,
        p.schemaTypes.join(', ') || 'no schema');
    }
  }

  // Site-wide identity gaps, judged once rather than per page.
  const allProps = new Set();
  html.forEach(p => (p.schemaProps || []).forEach(k => allProps.add(k)));
  if (hasOrg && !allProps.has('telephone') && !allProps.has('contactPoint')) {
    add('noContactPoint', origin + '/', 'schema carries no telephone or contactPoint',
      'Your business schema has no machine-readable way to reach you. Add telephone, email and a ContactPoint node ' +
      'to the LocalBusiness block so an assistant can pass the number on.');
  }
  if (html.length > 3 && !html.some(p => p.schemaTypes.includes('BreadcrumbList'))) {
    add('noBreadcrumbs', origin + '/', 'not present on any page checked',
      'No page declares where it sits in the site. Add BreadcrumbList schema so an assistant can tell a city page ' +
      'from a service page and cite the right one.');
  }

  // Template-built pages that open identically read as one source, and the
  // assistant keeps only one of them.
  const openings = new Map();
  for (const p of html) {
    // Compare what follows the headline, never the top of the document: every
    // page shares the same sticky bar and phone banner by design, and matching
    // on those would report the entire site as duplicate content.
    if (!p.afterH1) continue;
    const key = p.afterH1.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);
    if (key.length < 40) continue;   // too short to be a meaningful match
    if (!openings.has(key)) openings.set(key, []);
    openings.get(key).push(p);
  }
  for (const [, group] of openings) {
    if (group.length < 2) continue;
    const others = group.length - 1;
    const plural = group.length > 2 ? 's' : '';
    // A shared opening that is a lead form is a different problem with a
    // different fix: the copy is not duplicated, it is missing.
    const isForm = /name\s*\*|phone\s*\*|full address|email\s*\*|submit/i.test(group[0].afterH1);
    group.slice(0, 20).forEach(p => {
      const path = p.url.replace(/^https?:\/\/[^/]+/, '') || '/';
      add('duplicateOpening', p.url,
        isForm ? `opens with the same form as ${others} other page${plural}` : `same opening as ${others} other page${plural}`,
        isForm
          ? `The first thing under the headline on ${path} is your lead form — identical on ${group.length} pages. ` +
            'An assistant asked about this situation finds a form where the answer should be. Put two or three sentences ' +
            'above the form that answer this page\'s own question, then keep the form exactly where it is.'
          : `${path} starts with the same words as ${others} other page${plural}, so an assistant treats them as one source and keeps just one. ` +
            'Rewrite the first two sentences to name this page\'s own city or situation and something true only of it.',
        p.afterH1.slice(0, 110));
    });
  }

  // Question shape is a whole-site property, so judge it once.
  const questionShare = headingTotal ? questionTotal / headingTotal : 0;
  if (headingTotal && questionShare < 0.25) {
    const worst = html.filter(p => p.headings.length >= 4 && !p.questionHeadings.length).slice(0, 12);
    (worst.length ? worst : html.slice(0, 6)).forEach(p => {
      const path = p.url.replace(/^https?:\/\/[^/]+/, '') || '/';
      add('fewQuestions', p.url,
        `${p.questionHeadings.length} of ${p.headings.length} headings are questions`,
        `Headings on ${path} are labels rather than questions. Rewrite them as what a seller would type — ` +
        `"How fast can you close?", "What if the house needs repairs?" — and answer each in the first 40 words underneath.`,
        p.headings.slice(0, 3).join(' · '));
    });
  }

  if (!html.some(p => (p.schemaTypes || []).includes('WebPage') && /speakable/i.test(p.schemaTypes.join(',')))) {
    add('noSpeakable', origin + '/', 'not present',
      'Add a speakable property to your key pages pointing at the summary paragraph, so voice assistants know which sentences to read out.');
  }

  const issues = Object.keys(found).map(key => {
    const guide = GUIDE[key] || {};
    return {
      key,
      title: CHECKS[key].title,
      severity: CHECKS[key].severity,
      why: guide.why || '',
      how: guide.how || '',
      snippet: snippets[key] || '',
      count: found[key].length,
      priority: Math.round(CHECKS[key].weight * Math.min(found[key].length, 8)),
      pages: found[key].slice(0, 40)
    };
  }).sort((a, b) => {
    const rank = { error: 0, warning: 1, notice: 2 };
    return rank[a.severity] - rank[b.severity] || b.priority - a.priority;
  });

  const pageCount = html.length || 1;
  let deductions = 0;
  for (const issue of issues) {
    // Findings reported once for the whole site, not per page — their weight
    // must not be scaled down by a page count they were never counted against.
    const siteWide = ['botBlocked', 'noOrgSchema', 'noSameAs', 'noLlmsTxt', 'noSpeakable',
      'noServiceArea', 'noContactPoint', 'noBreadcrumbs'];
    const share = siteWide.indexOf(issue.key) > -1 ? 1 : Math.min(1, issue.count / pageCount);
    deductions += CHECKS[issue.key].weight * share;
  }
  const score = Math.max(0, Math.min(100, Math.round(100 - deductions)));

  const counts = { error: 0, warning: 0, notice: 0 };
  issues.forEach(i => { counts[i.severity] += i.count; });

  return {
    score,
    counts,
    issues,
    crawled: pages.length,
    pagesAnalysed: html.length,
    access,
    entity: {
      hasOrg,
      types: [...allTypes].sort(),
      sameAsFound: [...new Set(everySameAs)],
      questionShare: Math.round(questionShare * 100),
      questionHeadings: questionTotal,
      headings: headingTotal,
      withSchema: html.filter(p => p.schemaTypes.length).length,
      withFaq: html.filter(p => p.schemaTypes.includes('FAQPage')).length
    }
  };
}

async function runAiScan(startUrl, options, onProgress, shouldStop, shouldPause) {
  const origin = new URL(startUrl).origin;
  const [crawled, access] = await Promise.all([
    crawl(startUrl, options, onProgress, shouldStop, shouldPause),
    botAccess(origin)
  ]);

  const profile = Object.assign({
    origin,
    name: 'Twin Home Buyer',
    street: '170 Glenn Way, Suite 5',
    city: 'San Carlos',
    region: 'CA',
    postalCode: '94070',
    phone: '',
    areaServed: ['San Carlos', 'San Mateo', 'San Francisco', 'San Jose', 'Concord', 'Union City', 'Dixon'],
    sameAs: [
      'https://www.bbb.org/us/ca/san-carlos/profile/real-estate-investing/twin-home-buyer-llc-1116-928659',
      'https://nextdoor.com/pages/twin-home-buyer-san-carlos-ca/',
      'https://www.google.com/maps/place/?q=place_id:YOUR_PLACE_ID',
      'https://www.facebook.com/YOUR_PAGE',
      'https://www.linkedin.com/company/YOUR_COMPANY'
    ]
  }, options && options.profile);

  return analyse(crawled, access, profile);
}

module.exports = { runAiScan, AI_BOTS, CHECKS };
