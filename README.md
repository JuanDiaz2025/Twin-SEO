# Twin-SEO

SEO reporting console for **twinhomebuyer.com**, rebuilt as an in-house dashboard.

## Phase 1 — dashboard shell (this commit)

`dashboard/index.html` — a single self-contained page (no build step, no external
requests) carrying the full workspace shell:

- **Menu** — 11-workspace icon rail plus the complete SEO tool menu (Site Performance,
  Competitive Analysis, Keyword Research, Content Ideas, Link Building, Extras, Other).
  Collapsible, filterable from the topbar search, and menu items with a dot jump to their
  widget on the dashboard.
- **Widgets** — AI Search, SEO Overview, Listing Management, On Page SEO Checker,
  Backlink Audit, Organic Rankings, Backlinks, Organic Traffic Insights, Link Building
  Tool, Traffic Analytics, Top Pageviews, Search Console, plus the Hidden Widgets tray
  (close a widget and it parks there; restore puts it back in its slot).
- **Charts** — organic-traffic and referring-domain area charts with crosshair tooltips,
  a diverging keyword-position column chart, the ideas ring, a toxicity bar and the
  authority-score distribution. Palette validated for colour-vision separation and
  contrast in both light and dark themes.

## Phase 2 — Google Search Console & GA4

Three more screens in the same page, reachable from the **Google Data** group in the menu:

- **Google Search Console** — clicks, impressions, CTR and average position as clickable KPI
  tiles that drive the chart, plus a breakdown table across Queries / Pages / Countries / Devices.
- **Google Analytics 4** — sessions, active users, engaged sessions and engagement rate, with
  breakdowns by Channel / Landing page / Device / Country.
- **Connections & API keys** — where credentials go in.

### Putting credentials in

The connections screen takes an OAuth client ID and runs the browser token flow — no client
secret, read-only scopes (`webmasters.readonly`, `analytics.readonly`). For a five-second test,
paste an access token from the OAuth 2.0 Playground instead. The Search Console property picker
fills itself from `/webmasters/v3/sites` once a token exists; GA4 needs the numeric property ID.
A service-account JSON field exists for the future backend, with the obvious warning attached.

Everything is stored in `localStorage` under `twinseo.google.v1` and is sent only to Google.

Both report screens ship a **sample data** toggle so the layout is reviewable before any
credentials exist. Sample queries and URLs are the site's real ranking set from the Semrush
export; the click and session values are modelled, which is why those screens carry a Sample flag.

### Live calls need a real origin

Google rejects `file://` redirects, and the shared artifact preview blocks external requests by
policy. Serve the file to make live calls work:

```
cd dashboard && python3 -m http.server 8080
```

Then add `http://localhost:8080/index.html` as both an authorized JavaScript origin and a
redirect URI on the OAuth client.

### Data status

Headline figures are transcribed from the Aug 11, 2026 Semrush pull. The per-day and
per-month series behind the area charts and the position-change columns are reconstructed
to the observed shape, because the source dashboard exposes endpoints rather than daily
values. Phase 2 replaces every series with a live Semrush API read.

### Viewing it

Open `dashboard/index.html` in a browser — nothing to install.
