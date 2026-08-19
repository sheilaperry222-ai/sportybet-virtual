'use strict';
/*
 * server.js — REAL SportyBet data only. No simulation. No fake odds.
 *
 * Data source: SportyBet's public factsCenter API (the same one their web
 * app uses). We poll the Virtual England League every POLL_MS:
 *
 *   GET /api/ng/factsCenter/pcUpcomingEvents
 *       ?sportId=sr:sport:202120001   (vFootball)
 *       &marketId=1,18,10,29          (1X2 + O/U ladder + DC + GG/NG)
 *       &pageSize=100
 *
 * A "round" = the group of real matches sharing the same real kickoff time
 * (10 matches). The pick = the 3 matches with the highest Over-1.5 implied
 * probability in the next round (a transparent, odds-based selection).
 *
 * Phase is driven by real kickoff times:
 *   predicting — next round's bets are open (countdown to real kickoff)
 *   thinking    — the round is in play (bets closed)
 *
 * If the API is unreachable the site shows OFFLINE — we never invent data.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const POLL_MS = Number(process.env.POLL_SECONDS || 20) * 1000;
const BROADCAST_MS = 3000;
const PLAY_WINDOW_MS = 4 * 60 * 1000;      // virtual matches play ~4 min
const MAX_RESULTS = 1000;
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';

const SB_API = 'https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents' +
  '?sportId=sr%3Asport%3A202120001&marketId=1%2C18%2C10%2C29&pageSize=100&pageNum=';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-NG,en;q=0.9',
  'Origin': 'https://www.sportybet.com',
  'Referer': 'https://www.sportybet.com/ng/',
};

// ---------- real-data state ---------------------------------------------------
const state = {
  online: false,
  lastFetch: 0,
  lastError: null,
  events: [],          // normalized upcoming events (England league)
  rounds: [],          // groups by kickoff time
  pick: null,          // current 3-match pick {predictions, roundInfo}
  phase: 'offline',    // predicting | thinking | offline
  phaseUntil: 0,
  results: [],         // REAL completed results (from feeds / future score capture)
  tracked: new Map(),  // eventId -> {teams, start, odds} while awaiting scores
};

// ---------- SportyBet parsing --------------------------------------------------
function extractOddsLadder(markets) {
  // O/U market id=18 comes as several ladder entries; grab the 1.5 / 2.5 lines
  const out = { o15: '', o25: '', u15: '', u25: '', p15: 0 };
  for (const m of markets || []) {
    if (String(m.id) !== '18') continue;
    const over = (m.outcomes || []).find((o) => o.desc === 'Over 1.5');
    if (over) { out.o15 = over.odds; out.p15 = parseFloat(over.probability || 0); }
    const over25 = (m.outcomes || []).find((o) => o.desc === 'Over 2.5');
    if (over25) out.o25 = over25.odds;
    const under15 = (m.outcomes || []).find((o) => o.desc === 'Under 1.5');
    if (under15) out.u15 = under15.odds;
    const under25 = (m.outcomes || []).find((o) => o.desc === 'Under 2.5');
    if (under25) out.u25 = under25.odds;
  }
  return out;
}

function normalizeEvents(json) {
  const data = json && json.data;
  if (!data || !Array.isArray(data.tournaments)) return [];
  const events = [];
  for (const t of data.tournaments) {
    if (t.categoryId !== 'sv:category:202120001') continue; // England league only
    for (const e of t.events || []) {
      const odds = extractOddsLadder(e.markets);
      if (!odds.o15 && !odds.o25) continue;
      events.push({
        eventId: e.eventId,
        gameId: e.gameId,
        home: e.homeTeamName,
        away: e.awayTeamName,
        start: e.estimateStartTime,
        matchStatus: e.matchStatus,
        productStatus: e.productStatus,
        odds,
      });
    }
  }
  return events;
}

function groupRounds(events) {
  const byStart = new Map();
  for (const e of events) {
    if (!byStart.has(e.start)) byStart.set(e.start, []);
    byStart.get(e.start).push(e);
  }
  return [...byStart.entries()]
    .map(([start, evs]) => ({
      start,
      events: evs.sort((a, b) => (b.odds.p15 || 0) - (a.odds.p15 || 0)), // best O1.5 first
    }))
    .sort((a, b) => a.start - b.start);
}

function isoWeek(ms) {
  const d = new Date(ms);
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function buildPick(round) {
  const top3 = round.events.slice(0, 3);
  return {
    betting_site: 'sportybet',
    league: 'ENGLAND',
    week: String(isoWeek(round.start)),
    round: String(top3[0] ? top3[0].gameId : ''),
    PID: `SPORTYBET::${fmtTime(round.start)} ${new Date(round.start).toLocaleDateString('en-GB')}`,
    kickoff: round.start,
    predictions: top3.map((e) => ({
      Game: e.gameId,
      Team: `${e.home} vs ${e.away}`,
      allOdds: [e.odds.o15, e.odds.o25, e.odds.u15, e.odds.u25],
    })),
  };
}

// ---------- poll loop (the whole backend) ---------------------------------------
async function fetchEventsPage(pageNum) {
  const res = await fetch(SB_API + pageNum, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function pollSportyBet() {
  try {
    // fetch the full England schedule (up to 5 pages of 100)
    const events = [];
    const seen = new Set();
    for (let p = 1; p <= 5; p++) {
      const json = await fetchEventsPage(p);
      const pageEvents = normalizeEvents(json);
      if (!pageEvents.length) break;
      for (const e of pageEvents) {
        if (!seen.has(e.eventId)) { seen.add(e.eventId); events.push(e); }
      }
    }
    if (!events.length) throw new Error('no England-league events in response');

    state.online = true;
    state.lastFetch = Date.now();
    state.lastError = null;
    state.events = events;
    state.rounds = groupRounds(events);

    // track picked events for later score capture
    for (const e of events) {
      if (!state.tracked.has(e.eventId)) {
        state.tracked.set(e.eventId, {
          teams: `${e.home} vs ${e.away}`,
          start: e.start,
          odds: [e.odds.o15, e.odds.o25, e.odds.u15, e.odds.u25],
        });
      }
    }
    harvestScores(events);
    updatePhase();
  } catch (err) {
    state.online = false;
    state.lastError = String(err.message || err);
    state.phase = 'offline';
    state.pick = null;
    console.log(`[sportybet] fetch failed: ${state.lastError}`);
  }
}

function updatePhase() {
  const now = Date.now();
  // a round currently in play?
  const playing = state.rounds.find((r) => r.start <= now && now <= r.start + PLAY_WINDOW_MS);
  if (playing) {
    state.phase = 'thinking';
    state.phaseUntil = playing.start + PLAY_WINDOW_MS;
    state.pick = null;
    return;
  }
  const next = state.rounds.find((r) => r.start > now);
  if (!next) {
    state.phase = 'offline'; // no upcoming round visible right now
    state.pick = null;
    state.phaseUntil = 0;
    return;
  }
  state.phase = 'predicting';
  state.phaseUntil = next.start;
  state.pick = buildPick(next);
}

function mergeRealResult(site, entry) {
  const sig = (entry.match || []).join('|').toLowerCase();
  const exists = state.results.some((e) => (e.match || []).join('|').toLowerCase() === sig);
  if (exists) return;
  state.results.unshift(entry);
  if (state.results.length > MAX_RESULTS) state.results.length = MAX_RESULTS;
}

// Harvest REAL finished scores from the API when productStatus carries them
// (e.g. "1#2" = home 1, away 2) or matchStatus leaves "Not start".
function harvestScores(events) {
  for (const e of events) {
    const m = /^(\d+)#(\d+)$/.exec(String(e.productStatus || ''));
    const finished = m && (parseInt(m[1], 10) + parseInt(m[2], 10)) > 0;
    const hasScore = finished || /finish|ended|closed|full time/i.test(String(e.matchStatus || ''));
    if (!hasScore) continue;
    const t = state.tracked.get(e.eventId);
    if (!t) continue;
    const goals = finished ? [parseInt(m[1], 10) + parseInt(m[2], 10)] : [];
    const entry = {
      match: [t.teams],
      time: `${fmtTime(t.start)} - week * ${isoWeek(t.start)}`,
      result: goals.length ? goals : t.odds.map(() => 0),
      odds: [t.odds.slice(0, 1), t.odds.slice(1, 2), t.odds.slice(2, 3), t.odds.slice(3, 4)],
    };
    mergeRealResult('sportybet', entry);
  }
}

// ---------- web server ------------------------------------------------------------
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  // POST /ingest — push REAL results/odds (e.g. from a Lagos-based fetcher)
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
        let added = 0;
        for (const r of (payload.results || [])) {
          if (!r || !Array.isArray(r.match) || !Array.isArray(r.result)) continue;
          const entry = {
            match: r.match,
            time: r.time || '',
            result: r.result.map((g) => parseInt(g, 10)).filter((g) => !isNaN(g)),
            odds: Array.isArray(r.odds) && r.odds.length === 4 ? r.odds : [[], [], [], []],
          };
          const before = state.results.length;
          mergeRealResult(payload.site || 'sportybet', entry);
          if (state.results.length > before) added++;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, addedResults: added }));
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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const io = new Server(server, { cors: { origin: '*' } });

function phaseEvent() {
  return {
    phase: state.phase,
    until: state.phaseUntil,
    week: state.pick ? state.pick.week : '',
    round: state.pick ? state.pick.round : '',
    pid: state.pick ? state.pick.PID : null,
    kickoff: state.pick ? state.pick.kickoff : null,
  };
}

function sourceEvent() {
  return {
    source: state.online ? 'live' : 'offline',
    ageSec: state.lastFetch ? Math.round((Date.now() - state.lastFetch) / 1000) : null,
    fixtures: state.events.length,
    rounds: state.rounds.length,
    error: state.lastError,
  };
}

io.on('connection', (socket) => {
  socket.emit('sportybet-prediction', state.phase === 'predicting' ? state.pick : { betting_site: 'sportybet', league: 'ENGLAND', predictions: [] });
  socket.emit('sportybet-result', state.results);
  socket.emit('sportybet-phase', phaseEvent());
  socket.emit('sportybet-source', sourceEvent());
});

setInterval(() => {
  io.emit('sportybet-prediction', state.phase === 'predicting' ? state.pick : { betting_site: 'sportybet', league: 'ENGLAND', predictions: [] });
  io.emit('sportybet-result', state.results);
  io.emit('sportybet-phase', phaseEvent());
  io.emit('sportybet-source', sourceEvent());
}, BROADCAST_MS);

// boot
pollSportyBet();
setInterval(pollSportyBet, POLL_MS);

server.listen(PORT, HOST, () => {
  console.log(`[server] http://${HOST}:${PORT}`);
  console.log(`[server] data: REAL SportyBet Virtual England League (factsCenter API), poll every ${POLL_MS / 1000}s`);
  console.log(`[server] no simulation — if SportyBet is unreachable the site shows OFFLINE`);
  console.log(`[server] ingest token: ${INGEST_TOKEN ? 'SET' : 'NOT SET (any token accepted)'}`);
});
