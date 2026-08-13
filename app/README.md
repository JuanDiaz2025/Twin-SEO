# Running Twin SEO as an app

The dashboard can run three ways. Only the app gets you **live** Google data.

| How | Live GSC / GA4 | Needs |
|---|---|---|
| Published artifact | no — the sandbox blocks all external requests | nothing; use the CSV import |
| Static file on your own host | yes, browser-side OAuth | an OAuth client, an https origin |
| **App (`npm start`)** | **yes, server-side OAuth** | **Node 18+, an OAuth client** |

The app is the one to use. The token exchange and every API call happen on the
server, so no token ever reaches the browser, there is no CORS to fight, and
the connection keeps working after you close the tab — the server holds a
refresh token and renews access on its own.

## Start it

```bash
npm start          # or: node app/server.js
```

Then open <http://localhost:8080>. No `npm install` — the server has zero
dependencies and uses only what ships with Node 18.

## Connect Google, once

1. In [Google Cloud](https://console.cloud.google.com/apis/credentials), enable
   the **Google Search Console API** and the **Google Analytics Data API**.
2. Create an OAuth client → **Web application**.
3. Add `http://localhost:8080/auth/callback` as an **Authorized redirect URI**.
   The Connections screen prints the exact string to paste, whatever port or
   host you are on.
4. Open the app → **Connections & API keys** → paste the client ID and secret →
   **Connect with Google**.
5. Fill in the Search Console property (the picker lists them once connected)
   and the numeric GA4 property ID, then **Save**.

Open the Search Console or Analytics screen, untick **Show sample data**, and
press **Fetch from API**.

## Configuration

Settings are written to `.data/config.json`, tokens to `.data/tokens.json`, both
mode `600` and both git-ignored. Environment variables take precedence, so a
deployment can inject secrets instead:

```bash
GOOGLE_CLIENT_ID=…apps.googleusercontent.com \
GOOGLE_CLIENT_SECRET=GOCSPX-… \
GSC_SITE=https://www.twinhomebuyer.com/ \
GA4_PROPERTY_ID=123456789 \
PORT=8080 HOST=127.0.0.1 \
npm start
```

`HOST` defaults to `127.0.0.1`, so the app is reachable only from the machine
running it. Binding to `0.0.0.0` exposes an app with **no authentication of its
own** — put it behind a proxy that handles login first, and update the redirect
URI to match the public address.

## Routes

| Route | Purpose |
|---|---|
| `GET /` | the dashboard |
| `GET /api/status` | what is configured and whether Google is connected |
| `POST /api/settings` | save client ID/secret and the two property IDs |
| `GET /auth/google` → `/auth/callback` | the OAuth round trip |
| `POST /api/disconnect` | delete the stored token |
| `GET /api/gsc/sites` | Search Console properties on the account |
| `GET /api/gsc?days=28&dim=query` | clicks, impressions, CTR, position |
| `GET /api/ga4?days=28&dim=channel` | sessions, users, engagement, key events |

`dim` accepts `query`, `page`, `country`, `device` for Search Console, and
`channel`, `landing`, `device`, `country` for GA4.

## No terminal handy?

Use the **Import an export** panel on either screen. Search Console →
Performance → Export → CSV, or GA4 → Share this report → Download file. Drop the
files in and the dashboard fills with real numbers — no OAuth, no server. That
path works everywhere, including the published artifact.
