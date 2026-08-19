# ⚡ VFL SIGNALS — RealNaps-style prediction broadcaster (no paywall, no login)

A working clone of the workflow observed on **realnaps.com** — but every
visitor sees the predictions immediately. No premium tier, no login, no
padlocks.

## How it maps to the real RealNaps backend

| RealNaps (observed) | This project |
|---|---|
| Node.js Socket.IO broadcaster on port 3000 | same — `server.js`, port 3000 |
| Broadcasts every ~3 s, no authentication | same |
| `<site>-prediction` → `{betting_site, league:"ENGLAND", week, PID, predictions:[{Game, Team, allOdds:[O1.5,O2.5,U1.5,U2.5]}]}` | byte-compatible shape (`engine.js`) |
| `<site>-result` → 1,000-entry log, newest first (`match`, `time:"HH:MM - week * N"`, `result:[total goals ×3]`, `odds:[4 markets × 3]`) | same, capped at 1,000 |
| "Thinking" gap while matches play, picks live ~2 min before close | same state machine (`predicting` → `thinking` → results) |
| Client engine (`realnapsAI.js`) = season filters, Flat/Martingale ×1.5–×4, win-rate %, weekly chart, "Next ₦X" suggestion | ported 1:1 into `public/app.js` (same math & thresholds) |
| Data source = scraped virtual-fixture schedule + bookmaker odds | simulated in `engine.js` (Poisson-based odds + empirical goal distribution measured from their own 3,000-match log) |

## Run it locally

```bash
npm install
npm start            # http://localhost:3000
```

Config via env: `PORT`, `PREDICT_SECONDS` (default 100), `THINK_SECONDS`
(default 50).

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

The first run will ask you to log in to Netlify (or pass
`--auth <personal-access-token>` from Netlify → User settings →
Applications). After deploy you get `https://<site>.netlify.app`.

> **Tip:** a zero-account alternative is **Netlify Drop** — drag the
> `public/` folder onto https://app.netlify.com/drop in your browser.

### Or skip the split entirely

Render's blueprint also serves the frontend (the Node server hosts
`public/`), so the whole site can live on the single Render URL — Netlify
is only needed if you specifically want the frontend there.

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
