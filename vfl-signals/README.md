# ⚡ VFL SIGNALS — REAL SportyBet Virtual England League predictions

**Zero simulation.** Every pick, team name and odds value on this site comes
straight from SportyBet's live API. If SportyBet can't be reached, the site
shows OFFLINE — it never invents data.

## Live site

**https://vfl-signals.onrender.com** — complete app (frontend + socket),
hosted on Render.

## How the data flows

```
SportyBet factsCenter API (public, same API their web app uses)
   GET /api/ng/factsCenter/pcUpcomingEvents
       ?sportId=sr:sport:202120001   ← vFootball
       &marketId=1,18,10,29          ← 1X2 + O/U ladder + Double Chance + GG/NG
   └─ polled every 20s by server.js
   └─ England league only (sv:category:202120001)
   └─ each round = 10 real matches sharing one real kickoff time
   └─ pick = top 3 by Over-1.5 implied probability (SportyBet's own odds)
   └─ broadcast via Socket.IO (no login) → browser
```

Phase is driven by real kickoff times: `predicting` (countdown to kickoff,
bets open) → `thinking` (round in play, bets closed) → next round.

### Real results (history log)

SportyBet's public API only exposes upcoming events; finished scores are not
served by it. The result log therefore fills with REAL results when they are
pushed to the backend:

```bash
# from a machine in a SportyBet market (e.g. Lagos) — results tab scraping
curl -X POST https://vfl-signals.onrender.com/ingest \
  -H "Content-Type: application/json" \
  -d '{"site":"sportybet","token":"<INGEST_TOKEN>","results":[{"match":["ARS vs CHE"],"result":[3],"time":"08:52 - week * 34","odds":[["1.18"],["1.57"],["5.20"],["2.47"]]}]}'
```

Until then the history shows "No finished rounds recorded yet" — honestly
empty, never fake.

## Events broadcast (Socket.IO, no auth)

| Event | Payload |
|---|---|
| `sportybet-prediction` | `{betting_site, league:"ENGLAND", week, round, PID, kickoff, predictions:[{Game, Team:"ARS vs CHE", allOdds:[O1.5,O2.5,U1.5,U2.5]}]}` |
| `sportybet-result` | real completed results (from /ingest), newest first |
| `sportybet-phase` | `{phase:"predicting"|"thinking"|"offline", until, kickoff, ...}` |
| `sportybet-source` | `{source:"live"|"offline", ageSec, fixtures, rounds, error}` |

## Run it locally

```bash
npm install
npm start            # http://localhost:3000  (polls SportyBet every 20s)
```

Env: `PORT`, `POLL_SECONDS` (default 20), `INGEST_TOKEN`.

## Hosting

- **Render**: whole app in one service (`render.yaml` blueprint). Netlify was
  used for the frontend initially, but the account hit its deploy-credit
  limit — the Render URL serves both frontend and backend.
- **Netlify frontend** (optional): `npx netlify-cli deploy --dir=public --prod`
  with `public/config.js` → `window.VFL_SOCKET_URL = "https://vfl-signals.onrender.com"`.

## Honest note

SportyBet's own implied probabilities are the selection criterion; the site
is a real-data dashboard, not a guaranteed-profit system — virtual football
outcomes are RNG, and no odds display can beat the bookmaker's margin over
time. Bet responsibly. 18+.
