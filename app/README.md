# Running Twin SEO as an app

## Just start it

**Windows** — double-click **`Twin SEO.bat`**
**Mac** — double-click **`Twin SEO.command`**

Either one starts the app and opens your browser. If Node.js is missing it sends
you to the download page; install the LTS build once and double-click again.
Leave the black window open while you work — closing it stops the app.

From a terminal, `npm start` does the same thing.

## Or build a true standalone executable

If you would rather have one file that needs nothing installed at all:

```bash
node app/build-exe.mjs                    # for this machine
node app/build-exe.mjs --target win-x64   # a Windows .exe
```

Out comes `build/twin-seo` (or `twin-seo.exe`) — about 119 MB, because the
Node runtime is baked in. Copy it anywhere and run it; it keeps its settings in
a `.data` folder next to itself. Built files are git-ignored, since a binary
that size does not belong in a repository.

Mac binaries have to be code-signed, and `codesign` only exists on macOS — so
build those on a Mac. A darwin build made anywhere else gets blocked by
Gatekeeper.

## The three ways to run it

Only the app gets you **live** Google data.

| How | Live GSC / GA4 | Needs |
|---|---|---|
| Published artifact | no — the sandbox blocks all external requests | nothing; use the CSV import |
| Static file on your own host | yes, browser-side OAuth | an OAuth client, an https origin |
| **App (launcher, `npm start`, or the executable)** | **yes, server-side OAuth** | **an OAuth client** |

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
