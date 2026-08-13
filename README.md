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

### Data status

Headline figures are transcribed from the Aug 11, 2026 Semrush pull. The per-day and
per-month series behind the area charts and the position-change columns are reconstructed
to the observed shape, because the source dashboard exposes endpoints rather than daily
values. Phase 2 replaces every series with a live Semrush API read.

### Viewing it

Open `dashboard/index.html` in a browser — nothing to install.
