'use strict';
/*
 * scripts/sportybet-fetcher.js — RESULT SCRAPER. Run this on a machine in a
 * SportyBet market (e.g. Lagos, Nigeria). It grabs the FINISHED virtual
 * football results (the data the site needs for its win-rate and history
 * log) and posts them to the backend's /ingest endpoint.
 *
 * Why from Lagos: SportyBet's scheduled-virtual results APIs reject foreign
 * IPs (error 19997). Picks/odds are fetched server-side from anywhere —
 * only the results need this script.
 *
 * Usage:
 *   node scripts/sportybet-fetcher.js --backend https://vfl-signals.onrender.com --token <TOKEN>
 *   node scripts/sportybet-fetcher.js --dump    # inspect raw responses, no push
 *
 * Loop it (Windows: Task Scheduler; Linux/macOS: cron or while true):
 *   while true; do node scripts/sportybet-fetcher.js --backend ... --token ...; sleep 60; done
 */

const DEFAULT_BACKEND = process.env.VFL_BACKEND || 'https://vfl-signals.onrender.com';
const TOKEN = process.env.VFL_INGEST_TOKEN || '';

// Candidate results endpoints (priority order). The exact working path
// depends on SportyBet's current build — the script reports which one(s)
// answer from your IP. Run with --dump to inspect.
const RESULT_ENDPOINTS = [
  { name: 'scheduledVirtual.list',    url: 'https://www.sportybet.com/api/ng/scheduledVirtual/list' },
  { name: 'scheduledVirtual.result',  url: 'https://www.sportybet.com/api/ng/scheduledVirtual/result' },
  { name: 'scheduledVirtual.results', url: 'https://www.sportybet.com/api/ng/scheduledVirtual/results' },
  { name: 'scheduledVirtual.history', url: 'https://www.sportybet.com/api/ng/scheduledVirtual/history' },
  { name: 'virtual.results',          url: 'https://www.sportybet.com/api/ng/virtual/results' },
  { name: 'virtual.resultList',       url: 'https://www.sportybet.com/api/ng/virtual/resultList' },
  { name: 'virtual.football.results', url: 'https://www.sportybet.com/api/ng/virtual/football/results' },
  { name: 'virtual.history',          url: 'https://www.sportybet.com/api/ng/virtual/history' },
  { name: 'virtual.football.history', url: 'https://www.sportybet.com/api/ng/virtual/football/history' },
  { name: 'virtual.sportList',        url: 'https://www.sportybet.com/api/ng/virtual/sportList' },
  { name: 'virtual.football.leagues', url: 'https://www.sportybet.com/api/ng/virtual/football/leagues' },
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-NG,en;q=0.9',
  'Origin': 'https://www.sportybet.com',
  'Referer': 'https://www.sportybet.com/ng/sporty-scheduled-virtual',
};

// ---------- normalization (tolerant across response shapes) -------------------
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
function teamNames(obj) {
  const home = pick(obj, ['homeName', 'homeTeamName', 'home', 'teamA', 'homeCompetitorName', 'competitor1Name', 'homeTeam']);
  const away = pick(obj, ['awayName', 'awayTeamName', 'away', 'teamB', 'awayCompetitorName', 'competitor2Name', 'awayTeam']);
  if (!home || !away) return null;
  return [String(home).trim().toUpperCase(), String(away).trim().toUpperCase()];
}

function normalizeResults(json) {
  const results = [];
  const seen = new Set();
  for (const arr of walkArrays(json)) {
    for (const obj of arr) {
      const names = teamNames(obj);
      if (!names) continue;
      const hs = asNum(pick(obj, ['homeScore', 'homeGoals', 'homeResult', 'homeGoal']));
      const as = asNum(pick(obj, ['awayScore', 'awayGoals', 'awayResult', 'awayGoal']));
      const sig = `${names[0]}|${names[1]}`;
      if (hs === undefined || as === undefined || seen.has(sig)) continue;
      seen.add(sig);
      results.push({
        match: [`${names[0]} vs ${names[1]}`],
        result: [hs + as],
        time: String(pick(obj, ['startTime', 'kickoffTime', 'time', 'matchTime', 'beginTime']) || ''),
      });
    }
  }
  return results;
}

// ---------- http ---------------------------------------------------------------
async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const text = await res.text();
  try { return { json: JSON.parse(text) }; } catch { return { error: `non-JSON (${text.slice(0, 100)})` }; }
}

async function main() {
  const args = process.argv.slice(2);
  const dumpOnly = args.includes('--dump');
  const backend = (args[args.indexOf('--backend') + 1] || DEFAULT_BACKEND).replace(/\/$/, '');
  const token = args[args.indexOf('--token') + 1] || TOKEN;

  console.log(`[fetcher] mode: ${dumpOnly ? 'DUMP (no push)' : 'FETCH+PUSH'}`);
  console.log(`[fetcher] backend: ${backend} | token: ${token ? 'SET' : 'MISSING'}`);
  console.log(`[fetcher] ts: ${new Date().toISOString()}`);

  let allResults = [];
  for (const ep of RESULT_ENDPOINTS) {
    const r = await fetchJson(ep.url);
    if (r.error) { console.log(`[fetcher] ${ep.name}: ${r.error}`); continue; }
    if (dumpOnly) {
      const fs = require('fs');
      fs.writeFileSync(`dump-${ep.name}.json`, JSON.stringify(r.json, null, 1));
    }
    const rs = normalizeResults(r.json);
    console.log(`[fetcher] ${ep.name}: ${rs.length} finished matches found`);
    for (const x of rs) allResults.push(x);
  }

  if (dumpOnly) {
    console.log('[fetcher] dump done — inspect dump-*.json and adjust RESULT_ENDPOINTS/normalizeResults if needed.');
    return;
  }
  if (!allResults.length) {
    console.log('[fetcher] ⚠ no results normalized. Run --dump to see raw responses from your IP.');
    return;
  }

  const payload = { site: 'sportybet', token, results: allResults };
  try {
    const res = await fetch(`${backend}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({}));
    console.log(`[fetcher] ingest: HTTP ${res.status} -> ${JSON.stringify(body)}`);
    console.log(`[fetcher] sample: ${JSON.stringify(allResults.slice(0, 3))}`);
  } catch (e) {
    console.log(`[fetcher] ingest failed: ${e.message}`);
  }
}

main().catch((e) => { console.error('[fetcher] fatal:', e.message); process.exit(1); });
