# ⚡ VFL SIGNALS — RealNaps-style prediction broadcaster (no paywall, no login)

A working clone of the workflow observed on **realnaps.com** — but every
visitor sees the predictions immediately. No premium tier, no login, no
padlocks. Now with a **REAL SPORTYBET DATA MODE**.

## Real SportyBet data — how it works

SportyBet's virtual endpoints are geo-gated to their African markets, so the
data pipeline has two hops:

```
Your PC in Nigeria (scripts/sportybet-fetcher.js)
   │  fetches real virtual fixtures + odds from sportybet.com
   │  POST /ingest (token-protected) every run
   ▼
Render backend (broadcasts LIVE picks; simulates only if feed goes stale)
   ▼
Netlify frontend (badge shows: LIVE SPORTYBET · N games · Xs ago  vs  SIMULATED)
```

### Run the fetcher on your machine in Lagos

```bash
node scripts/sportybet-fetcher.js --backend https://vfl-signals.onrender.com --token <INGEST_TOKEN>
# or first, discover which endpoint works on SportyBet's current build:
node scripts/sportybet-fetcher.js --dump
```

`INGEST_TOKEN` is set on the Render service (`INGEST_TOKEN.txt` in this
folder). Run it on a loop (e.g. Windows Task Scheduler / cron every 30s),
which also keeps the free Render service warm.

## How it maps to the real RealNaps backend

| RealNaps (observed) | This project |
|---|---|
| Node.js Socket.IO broadcaster on port 3000, no authentication | same — `server.js`, port 3000 |
| Broadcasts every ~3 s | same |
| `<site>-prediction` → `{betting_site, league:"ENGLAND", week, PID, predictions:[{Game, Team, allOdds:[O1.5,O2.5,U1.5,U2.5]}]}` | byte-compatible shape (`engine.js`) |
| `<site>-result` → 1,000-entry log, newest first | same, capped at 1,000 |
| "Thinking" gap while matches play, picks live before close | same state machine |
| Client engine (`realnapsAI.js`) analytics | ported 1:1 into `public/app.js` |
| Scraped virtual fixtures + odds | `scripts/sportybet-fetcher.js` → `/ingest` (real data) with simulated fallback |
| `<site>-source` | extra event: `{source:"live"|"sim", fixtures, ageSec}` |

## Run it locally

```bash
npm install
npm start            # http://localhost:3000
```

Config via env: `PORT`, `PREDICT_SECONDS` (default **25**), `THINK_SECONDS`
(default **12**), `FEED_TTL_SECONDS` (default 120), `INGEST_TOKEN`.

Verify the broadcast without a browser:

```bash
node scripts/probe.js
```

## Hosting (Netlify frontend + websocket backend)

Netlify serves static files only — it **cannot** run the Socket.IO server
(no long-lived websockets). So deploy in two parts:

### 1) Backend (the live feed) — pick one host

- **Render (recommended, free):** push this folder to GitHub, then on
  render.com do *New → Blueprint* and select the repo — `render.yaml` is
  already in this folder. You get `https://vfl-signals.onrender.com`.
  *(Free tier sleeps after ~15 min of no traffic; first visitor wakes it.)*
- **Glitch (free):** create a project, upload `server.js`, `engine.js`,
  `package.json` + `public/`, then use the app URL.
- **Your own VPS:** `npm install && npm start` behind any reverse proxy.

### 2) Frontend on Netlify

```bash
# point the frontend at your backend URL
# edit public/config.js:  window.VFL_SOCKET_URL = "https://vfl-signals.onrender.com"

# then deploy
npx netlify-cli deploy --dir=public --prod
```

> **Tip:** a zero-account alternative is **Netlify Drop** — drag the
> `public/` folder onto https://app.netlify.com/drop in your browser.

### Or skip the split entirely

Render's blueprint also serves the frontend (the Node server hosts
`public/`), so the whole site can live on the single Render URL.

## Structure

```
server.js         HTTP + Socket.IO broadcaster (no auth)
engine.js         fixture generation, pick selection, odds, round state machine
public/index.html dashboard UI
public/app.js     client engine (port of realnapsAI.js analytics logic)
public/style.css  dark theme
scripts/probe.js  smoke test for the socket
```

## Going live with real data

Replace the simulated fixture source in `engine.js` → `buildRound()` with a
real feed (the same way RealNaps scrapes the bookmaker's virtual schedule).
Everything downstream (selection, odds, broadcast, log) stays the same.

## Important honesty note

Virtual football outcomes are produced by random number generators. The
statistics in this demo mirror what RealNaps' own result log shows: hit rates
that track the bookmaker odds minus margin — i.e. **no mathematical edge**,
and Martingale only concentrates losses. If you run a public site like this:
- keep the "no guaranteed winnings" disclaimer (included in the footer),
- check local gambling-advertising rules in your target country,
- respect bookmakers' terms of service before scraping anything.
