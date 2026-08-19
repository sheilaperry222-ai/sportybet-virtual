'use strict';
/*
 * server.js — web + Socket.IO prediction broadcaster (no auth, like realnaps).
 *
 * Two data modes per bookie:
 *   LIVE (real SportyBet data) — a local fetcher running in a SportyBet
 *     market (e.g. Nigeria) POSTs real fixtures/odds/results to /ingest.
 *     The broadcaster builds predictions from that feed.
 *   SIMULATED — if no live feed for FEED_TTL, it falls back to the built-in
 *     generator so the site never looks broken. The UI shows which mode
 *     is active via the <site>-source event.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const { createBookie, buildRoundFromFeed, TEAMS } = require('./engine');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PREDICT_MS = Number(process.env.PREDICT_SECONDS || 25) * 1000; // picks live ~25s before "bet closes"
const THINK_MS = Number(process.env.THINK_SECONDS || 12) * 1000;     // matches playing / "Thinking"
const BROADCAST_MS = 3000; // realnaps re-broadcasts ~every 3s
const FEED_TTL = Number(process.env.FEED_TTL_SECONDS || 120) * 1000; // live feed freshness window
const INGEST_TOKEN = process.env.INGEST_TOKEN || ''; // shared secret for POST /ingest

const bookies = [
  createBookie({ site: 'sportybet', label: 'SportyBet', seed: 101, week: 7,  roundInWeek: 20, lambda: [2.8, 3.3], pidPrefix: 'SPORTYBET', predictMs: PREDICT_MS }),
  createBookie({ site: 'betpawa',  label: 'BetPawa',  seed: 202, week: 30, roundInWeek: 12, lambda: [3.2, 3.7], pidPrefix: 'BETPAWA',  predictMs: PREDICT_MS }),
  createBookie({ site: 'betking',  label: 'BetKing',  seed: 303, week: 4,  roundInWeek: 8,  lambda: [2.7, 3.4], pidPrefix: 'BETKING',  predictMs: PREDICT_MS }),
];
const bySite = Object.fromEntries(bookies.map((b) => [b.site, b]));

// live feed state
const feeds = Object.fromEntries(bookies.map((b) => [b.site, { fixtures: null, results: [], ts: 0 }]));
const source = Object.fromEntries(bookies.map((b) => [b.site, 'sim']));
let pendingLiveRound = null; // { site, teams:[], oddsMatrix, pid, time }

const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  // POST /ingest — receive real fixtures/odds/results from the local fetcher
  if (req.method === 'POST' && req.url.startsWith('/ingest')) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        if (INGEST_TOKEN && payload.token !== INGEST_TOKEN) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad token' }));
          return;
        }
        const site = String(payload.site || 'sportybet').toLowerCase();
        const b = bySite[site];
        if (!b) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'unknown site' }));
          return;
        }
        if (Array.isArray(payload.fixtures) && payload.fixtures.length) {
          feeds[site].fixtures = payload.fixtures;
          feeds[site].ts = Date.now();
          source[site] = 'live';
        }
        if (Array.isArray(payload.results) && payload.results.length) {
          feeds[site].results = payload.results;
          mergeResults(site, payload.results);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mode: source[site], fixtures: (feeds[site].fixtures || []).length }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad json' }));
      }
    });
    return;
  }

  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/') url = '/index.html';
  const file = path.normalize(path.join(PUBLIC, url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

const io = new Server(server, { cors: { origin: '*' } });

// Merge real results from the fetcher into the bookie's history log.
function mergeResults(site, results) {
  const b = bySite[site];
  for (const r of results) {
    if (!r || !Array.isArray(r.match) || !Array.isArray(r.result)) continue;
    const sig = (r.match || []).join('|').toLowerCase();
    const exists = b.results.some((e) => (e.match || []).join('|').toLowerCase() === sig);
    if (exists) continue;
    const goals = r.result.map((g) => parseInt(g, 10)).filter((g) => !isNaN(g));
    const odds = Array.isArray(r.odds) && r.odds.length === 4 ? r.odds : fillOdds(goals);
    b.results.unshift({
      match: r.match,
      time: r.time || `${new Date().toTimeString().slice(0, 5)} - week * ${b.week}`,
      result: goals,
      odds,
    });
  }
  if (b.results.length > 1000) b.results.length = 1000;
}

function fillOdds(goals) {
  // model odds for the real goals if the fetcher didn't provide odds
  const m = [0, 1, 2, 3].map(() => goals.map(() => '1.20'));
  return m;
}

// Fresh feed? Build the next round from REAL fixtures, otherwise simulate.
function nextRound(b, t) {
  const feed = feeds[b.site];
  const fresh = source[b.site] === 'live' && feed.fixtures && (Date.now() - feed.ts) < FEED_TTL;
  const rng = (() => { let s = b.seed * 2654435761 + b.roundIndex * 97; return () => { s = (s + 0x6D2B79F5) | 0; let x = Math.imul(s ^ (s >>> 15), 1 | s); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; })();
  if (fresh) {
    const r = buildRoundFromFeed(rng, b, b.week, b.roundInWeek, t, { fixtures: feed.fixtures, meta: feed.meta });
    pendingLiveRound = { site: b.site, teams: r.pick.predictions.map((p) => p.Team), pid: r.pick.PID, time: r.resultEntry.time };
    return r;
  }
  source[b.site] = 'sim';
  const teams = TEAMS.slice();
  for (let i = teams.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [teams[i], teams[j]] = [teams[j], teams[i]]; }
  const fixtures = [];
  for (let i = 0; i < 8; i++) fixtures.push({ slot: i + 1, home: teams[i * 2], away: teams[i * 2 + 1] });
  return buildRoundFromFeed(rng, b, b.week, b.roundInWeek, t, { fixtures });
}

// Instant snapshot on connect so a fresh page paints immediately.
io.on('connection', (socket) => {
  for (const b of bookies) {
    socket.emit(`${b.site}-prediction`, b.phase === 'predicting' ? b.prediction : { ...b.prediction, predictions: [] });
    socket.emit(`${b.site}-result`, b.results);
    socket.emit(`${b.site}-phase`, { phase: b.phase, until: b.phaseUntil, week: b.week, round: b.roundInWeek, pid: b.prediction.PID });
    socket.emit(`${b.site}-source`, sourceInfo(b.site));
  }
});

function sourceInfo(site) {
  const f = feeds[site];
  return {
    source: source[site],
    fixtures: (f.fixtures || []).length,
    lastFeedAt: f.ts || null,
    ageSec: f.ts ? Math.round((Date.now() - f.ts) / 1000) : null,
  };
}

// The main broadcast loop (the heart of the workflow).
setInterval(() => {
  const now = Date.now();
  for (const b of bookies) {
    // custom tick: when the thinking phase ends, build from live feed if fresh
    if (b.phase === 'predicting' && now >= b.phaseUntil) {
      b.phase = 'thinking';
      b.phaseUntil = now + THINK_MS;
    } else if (b.phase === 'thinking' && now >= b.phaseUntil) {
      const t = new Date(now);
      const r = nextRound(b, t);

      // settle the finished round
      if (pendingLiveRound && pendingLiveRound.site === b.site) {
        // look for a real result that matches the finished round
        const res = feeds[b.site].results || [];
        const sigOf = (t) => (t || []).join('|').toLowerCase();
        const match = res.find((rr) => rr.match && sigOf(rr.match) === sigOf(pendingLiveRound.teams));
        const already = b.results.some((e) => sigOf(e.match) === sigOf(pendingLiveRound.teams));
        if (match && !already) {
          const goals = match.result.map((g) => parseInt(g, 10)).filter((g) => !isNaN(g));
          const odds = Array.isArray(match.odds) && match.odds.length === 4 ? match.odds : fillOdds(goals);
          b.results.unshift({ match: pendingLiveRound.teams, time: pendingLiveRound.time, result: goals, odds });
          if (b.results.length > 1000) b.results.length = 1000;
        } else if (!already) {
          // no real result yet — append the provisional entry (flagged pending)
          b.results.unshift({ ...r.resultEntry, pending: true });
          if (b.results.length > 1000) b.results.length = 1000;
        }
        pendingLiveRound = null;
      } else {
        b.results.unshift(r.resultEntry);
        if (b.results.length > 1000) b.results.length = 1000;
      }

      b.roundIndex++;
      b.roundInWeek++;
      if (b.roundInWeek > 26) { b.roundInWeek = 1; b.week = b.week >= 38 ? 1 : b.week + 1; }
      b.prediction = r.pick;
      b.phase = 'predicting';
      b.phaseUntil = now + PREDICT_MS;
    }
  }
  for (const b of bookies) {
    io.emit(`${b.site}-prediction`, b.phase === 'predicting' ? b.prediction : { ...b.prediction, predictions: [] });
    io.emit(`${b.site}-result`, b.results);
    io.emit(`${b.site}-phase`, { phase: b.phase, until: b.phaseUntil, week: b.week, round: b.roundInWeek, pid: b.prediction.PID });
    io.emit(`${b.site}-source`, sourceInfo(b.site));
  }
}, BROADCAST_MS);

server.listen(PORT, HOST, () => {
  console.log(`[server] http://${HOST}:${PORT}`);
  console.log(`[server] bookies: ${bookies.map((b) => b.site).join(', ')}`);
  console.log(`[server] round cycle: ${PREDICT_MS / 1000}s predicting + ${THINK_MS / 1000}s thinking`);
  console.log(`[server] live-feed TTL: ${FEED_TTL / 1000}s | ingest token: ${INGEST_TOKEN ? 'SET' : 'NOT SET (any token accepted)'}`);
  console.log(`[server] broadcasting every ${BROADCAST_MS / 1000}s to all clients (no auth)`);
});
