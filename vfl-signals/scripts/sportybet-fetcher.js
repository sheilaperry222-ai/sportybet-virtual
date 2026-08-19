'use strict';
/*
 * scripts/sportybet-fetcher.js — run this ON YOUR OWN MACHINE IN NIGERIA
 * (SportyBet's virtual endpoints are geo-gated; they answer from Lagos).
 *
 * It:
 *   1. fetches SportyBet's scheduled virtual football fixtures + odds
 *      (candidate endpoints; prints which one works)
 *   2. normalizes them into the backend's fixture shape
 *   3. POSTs them to the Render backend /ingest endpoint
 *
 * Usage:
 *   node scripts/sportybet-fetcher.js --backend https://vfl-signals.onrender.com --token YOUR_TOKEN
 *   node scripts/sportybet-fetcher.js --dump          # just save raw responses for inspection
 *
 * No dependencies required (Node 18+, global fetch).
 */

const DEFAULT_BACKEND = process.env.VFL_BACKEND || 'https://vfl-signals.onrender.com';
const TOKEN = process.env.VFL_INGEST_TOKEN || '';

// Candidate endpoints (order = priority). The exact working paths depend on
// SportyBet's current build; the script tries them all and reports which one
// returns fixture data.
const ENDPOINTS = [
  {
    name: 'scheduledVirtual.list',
    url: 'https://www.sportybet.com/api/ng/scheduledVirtual/list',
  },
  {
    name: 'virtual.lobby',
    url: 'https://www.sportybet.com/api/ng/virtual/lobby',
  },
  {
    name: 'virtual.sportList',
    url: 'https://www.sportybet.com/api/ng/virtual/sportList',
  },
  {
    name: 'virtual.football.leagues',
    url: 'https://www.sportybet.com/api/ng/virtual/football/leagues',
  },
  {
    name: 'virtual.football.schedule',
    url: 'https://www.sportybet.com/api/ng/virtual/football/schedule',
  },
];

const RESULTS_ENDPOINTS = [
  {
    name: 'virtual.results',
    url: 'https://www.sportybet.com/api/ng/virtual/results',
  },
  {
    name: 'scheduledVirtual.results',
    url: 'https://www.sportybet.com/api/ng/scheduledVirtual/results',
  },
  {
    name: 'virtual.football.results',
    url: 'https://www.sportybet.com/api/ng/virtual/football/results',
  },
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-NG,en;q=0.9',
  'Origin': 'https://www.sportybet.com',
  'Referer': 'https://www.sportybet.com/ng/',
};

// ---------- normalization (best-effort across SportyBet response shapes) ------
const pick = (obj, keys) => {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
};

const asNum = (v) => {
  if (v === undefined || v === null) return undefined;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? undefined : n;
};

function walkArrays(node, out = []) {
  if (Array.isArray(node)) {
    if (node.length && node.every((x) => x && typeof x === 'object' && !Array.isArray(x))) out.push(node);
    node.forEach((x) => walkArrays(x, out));
  } else if (node && typeof node === 'object') {
    Object.values(node).forEach((v) => walkArrays(v, out));
  }
  return out;
}

function looksLikeFixture(obj) {
  const home = pick(obj, ['homeName', 'homeTeamName', 'home', 'teamA', 'homeCompetitorName', 'competitor1Name', 'homeTeam']);
  const away = pick(obj, ['awayName', 'awayTeamName', 'away', 'teamB', 'awayCompetitorName', 'competitor2Name', 'awayTeam']);
  return !!(home && away);
}

function extractOdds(obj) {
  // try known market keys, then nested odds objects
  const o15 = asNum(pick(obj, ['over1_5', 'over15', 'o15', 'overOnePointFive', 'totalOver1_5', 'over_1_5']));
  const o25 = asNum(pick(obj, ['over2_5', 'over25', 'o25', 'overTwoPointFive', 'totalOver2_5', 'over_2_5']));
  const u15 = asNum(pick(obj, ['under1_5', 'under15', 'u15', 'underOnePointFive', 'totalUnder1_5', 'under_1_5']));
  const u25 = asNum(pick(obj, ['under2_5', 'under25', 'u25', 'underTwoPointFive', 'totalUnder2_5', 'under_2_5']));
  if (o15 || o25 || u15 || u25) return { o15, o25, u15, u25 };
  // nested odds arrays like markets:[{name:"Over 1.5", odd:1.3}]
  const markets = pick(obj, ['markets', 'oddsList', 'marketList', 'outcomes', 'odds']);
  if (Array.isArray(markets)) {
    const out = {};
    for (const m of markets) {
      const name = String(pick(m, ['name', 'marketName', 'outcomeName', 'type']) || '').toLowerCase();
      const odd = asNum(pick(m, ['odd', 'odds', 'value', 'price', 'decimal']));
      if (odd === undefined) continue;
      if (name.includes('over 1.5') || name.includes('o1.5') || name.includes('o/u 1.5') && name.includes('over')) out.o15 = out.o15 || odd;
      else if (name.includes('over 2.5') || name.includes('o2.5') || name.includes('o/u 2.5') && name.includes('over')) out.o25 = out.o25 || odd;
      else if (name.includes('under 1.5') || name.includes('u1.5') || name.includes('o/u 1.5') && name.includes('under')) out.u15 = out.u15 || odd;
      else if (name.includes('under 2.5') || name.includes('u2.5') || name.includes('o/u 2.5') && name.includes('under')) out.u25 = out.u25 || odd;
    }
    if (Object.keys(out).length) return out;
  }
  return undefined;
}

function normalizeFixtures(json) {
  const arrays = walkArrays(json);
  const fixtures = [];
  const seen = new Set();
  for (const arr of arrays) {
    for (const obj of arr) {
      if (!looksLikeFixture(obj)) continue;
      const home = String(pick(obj, ['homeName', 'homeTeamName', 'home', 'teamA', 'homeCompetitorName', 'competitor1Name', 'homeTeam'])).trim();
      const away = String(pick(obj, ['awayName', 'awayTeamName', 'away', 'teamB', 'awayCompetitorName', 'competitor2Name', 'awayTeam'])).trim();
      if (!home || !away) continue;
      // skip finished matches when collecting upcoming fixtures
      const status = String(pick(obj, ['status', 'matchStatus', 'state']) || '').toLowerCase();
      const hasScore = pick(obj, ['homeScore', 'awayScore', 'score']) !== undefined;
      const sig = `${home}|${away}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      const odds = extractOdds(obj);
      const slot = asNum(pick(obj, ['round', 'gameNo', 'matchNo', 'id', 'eventId'])) || fixtures.length + 1;
      fixtures.push({
        slot,
        home: home.toUpperCase().replace(/\s+/g, ' '),
        away: away.toUpperCase().replace(/\s+/g, ' '),
        odds,
        finished: /(finished|ended|closed|resulted)/.test(status) || hasScore,
      });
    }
  }
  return fixtures;
}

function normalizeResults(json) {
  const arrays = walkArrays(json);
  const results = [];
  const seen = new Set();
  for (const arr of arrays) {
    for (const obj of arr) {
      if (!looksLikeFixture(obj)) continue;
      const home = String(pick(obj, ['homeName', 'homeTeamName', 'home', 'teamA'])).trim();
      const away = String(pick(obj, ['awayName', 'awayTeamName', 'away', 'teamB'])).trim();
      const hs = asNum(pick(obj, ['homeScore', 'homeGoals', 'homeResult']));
      const as = asNum(pick(obj, ['awayScore', 'awayGoals', 'awayResult']));
      if (hs === undefined || as === undefined) continue;
      const sig = `${home}|${away}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      results.push({ match: [`${home} vs ${away}`], result: [hs + as], time: String(pick(obj, ['startTime', 'time', 'kickoff']) || '') });
    }
  }
  return results;
}

// ---------- http helpers ------------------------------------------------------
async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const text = await res.text();
  try { return { json: JSON.parse(text) }; } catch { return { error: `non-JSON (${text.slice(0, 120)})` }; }
}

// ---------- main -----------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const dumpOnly = args.includes('--dump');
  const backend = (args[args.indexOf('--backend') + 1] || DEFAULT_BACKEND).replace(/\/$/, '');
  const token = args[args.indexOf('--token') + 1] || TOKEN;

  console.log(`[fetcher] mode: ${dumpOnly ? 'DUMP (no push)' : 'FETCH+PUSH'}`);
  console.log(`[fetcher] backend: ${backend} | token: ${token ? 'SET' : 'MISSING (pass --token)'}`);
  console.log(`[fetcher] ts: ${new Date().toISOString()}`);

  // 1) fixtures
  let fixtures = [];
  let usedEndpoint = null;
  for (const ep of ENDPOINTS) {
    const r = await fetchJson(ep.url);
    if (r.error) { console.log(`[fetcher] ${ep.name}: ${r.error}`); continue; }
    const fs = normalizeFixtures(r.json);
    if (dumpOnly) require('fs').writeFileSync(`dump-${ep.name}.json`, JSON.stringify(r.json, null, 1));
    console.log(`[fetcher] ${ep.name}: ${fs.length} fixtures found`);
    if (fs.length >= 3) { fixtures = fs.filter((f) => !f.finished); usedEndpoint = ep.name; break; }
  }

  // 2) results
  let results = [];
  for (const ep of RESULTS_ENDPOINTS) {
    const r = await fetchJson(ep.url);
    if (r.error) { console.log(`[fetcher] ${ep.name}: ${r.error}`); continue; }
    const rs = normalizeResults(r.json);
    console.log(`[fetcher] ${ep.name}: ${rs.length} results found`);
    if (rs.length) { results = rs; break; }
  }

  if (dumpOnly) {
    console.log('[fetcher] dump done. Inspect dump-*.json and tell the dev which endpoint has fixtures.');
    return;
  }
  if (!fixtures.length) {
    console.log('[fetcher] ⚠ no fixtures normalized. Run with --dump to inspect raw responses.');
    return;
  }

  // 3) push to backend
  const payload = { site: 'sportybet', token, fixtures, results, meta: { league: 'ENGLAND' } };
  try {
    const res = await fetch(`${backend}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({}));
    console.log(`[fetcher] ingest: HTTP ${res.status} -> ${JSON.stringify(body)}`);
    if (fixtures.length) console.log(`[fetcher] first fixture: ${fixtures[0].home} vs ${fixtures[0].away} odds=${JSON.stringify(fixtures[0].odds || {})}`);
  } catch (e) {
    console.log(`[fetcher] ingest failed: ${e.message}`);
  }
}

main().catch((e) => { console.error('[fetcher] fatal:', e.message); process.exit(1); });
