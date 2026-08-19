'use strict';
/*
 * engine.js — data source + round state machine.
 *
 * Mirrors the RealNaps workflow observed on realnaps.com:3000:
 *
 *   1. A virtual-football fixture schedule is generated (RealNaps scrapes the
 *      bookmaker's schedule; here it is simulated — swap buildRound()'s
 *      fixture source with your own scraper/API to go live).
 *   2. 3 games are "analysed" and selected (their old /logik/ backend did a
 *      head-to-head compare; here a simple odds-based heuristic stands in).
 *   3. The pick + odds are broadcast as a <site>-prediction object; every
 *      round's outcome (total goals) is appended to a 1,000-entry
 *      <site>-result log, newest first.
 *   4. Between rounds there is a "thinking" phase while matches play.
 *
 * Payload shapes are byte-compatible with the ones captured from the real
 * RealNaps socket (see realnaps-data/ in the parent folder).
 */

// ---- deterministic RNG (so the demo data is reproducible) -----------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 3-letter team codes in the style of their logs (FOR vs CRY, HLL vs AST, ...)
const TEAMS = [
  'ARS','AST','AVL','BHA','BLK','BOU','BRN','BRE','BUR','CHE','COV','CRY','DER',
  'EVE','FOR','FUL','HLL','HUD','IPS','LEE','LEI','LUT','MCI','MID','MUN','NEW',
  'NOR','NOT','PRE','QPR','RDG','SHF','SUN','SWA','TOT','WAT','WBA','WHU','WOL','STK',
];

// Empirical total-goals distribution measured from RealNaps' own 3,000-match
// result log: 0 goals 177, 1: 450, 2: 715, 3: 689, 4: 534, 5: 282, 6: 153.
const GOAL_WEIGHTS = [177, 450, 715, 689, 534, 282, 153];
const GOAL_TOTAL = GOAL_WEIGHTS.reduce((a, b) => a + b, 0);

const ROUNDS_PER_WEEK = 26;     // their log showed 25–28 rounds per week
const HISTORY_ROUNDS = 1000;    // pre-seed a full history like the real feed
const MAX_RESULTS = 1000;       // the real feed is capped at 1,000 entries
const FIXTURES_PER_ROUND = 8;   // full schedule per round (we pick 3 of 8)
const PICKS_PER_ROUND = 3;      // RealNaps always picks 3

// ---- odds model ------------------------------------------------------------
// Bookmaker-style odds with ~8% margin, derived from an expected-goals lambda.
// Ranges match what the real feed showed:
//   SportyBet O1.5 ~1.15–1.30 · BetPawa O1.5 ~1.06–1.10 · U1.5 ~3.6–5.2
function poissonCdf(lambda) {
  const e = Math.exp(-lambda);
  return [e, e * lambda, (e * lambda * lambda) / 2]; // P(0), P(1), P(2)
}
function fmtOdds(p) { return (1 / (p * 1.08)).toFixed(2); }
function oddsFor(lambda) {
  const [p0, p1, p2] = poissonCdf(lambda);
  const pO15 = 1 - (p0 + p1);
  const pO25 = 1 - (p0 + p1 + p2);
  return {
    o15: fmtOdds(pO15), o25: fmtOdds(pO25),
    u15: fmtOdds(1 - pO15), u25: fmtOdds(1 - pO25),
  };
}

function pickGoals(rng) { // weighted sample from the empirical distribution
  let r = rng() * GOAL_TOTAL, acc = 0;
  for (let g = 0; g < GOAL_WEIGHTS.length; g++) {
    acc += GOAL_WEIGHTS[g];
    if (r < acc) return g;
  }
  return GOAL_WEIGHTS.length - 1;
}

// ---- helpers ---------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const fmtTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtPidDate = (d) =>
  `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

// Build a prediction from a REAL feed (pushed by the local SportyBet fetcher).
// feed = { fixtures: [{home, away, slot, odds:{o15,o25,u15,u25}}...], meta }
function buildRoundFromFeed(rng, bookie, week, roundInWeek, t, feed) {
  const fixtures = (feed.fixtures || []).map((f, i) => ({
    slot: f.slot || i + 1,
    home: String(f.home || '').toUpperCase(),
    away: String(f.away || '').toUpperCase(),
    odds: f.odds || null,
  })).filter((f) => f.home && f.away);

  // "analysis": pick the 3 most goal-likely games from the real schedule
  // (stand-in for RealNaps' server-side selection)
  const scored = fixtures.map((f) => {
    const o = f.odds || {};
    const o15 = parseFloat(o.o15) || 0, o25 = parseFloat(o.o25) || 0;
    const score = (o15 ? 1 / o15 : 0) + (o25 ? 1 / o25 : 0) + rng() * 0.05;
    return { ...f, score };
  });
  scored.sort((x, y) => y.score - x.score);
  const picked = scored.slice(0, 3);

  // odds may come from the feed; fill gaps with the model so all 4 markets exist
  const predictions = picked.map((p) => {
    const lambda = 2.9; // fallback
    const m = oddsFor(lambda);
    const o = p.odds || {};
    const allOdds = [o.o15 || m.o15, o.o25 || m.o25, o.u15 || m.u15, o.u25 || m.u25];
    return { Game: p.slot, Team: `${p.home} vs ${p.away}`, allOdds };
  });

  const pick = {
    betting_site: bookie.site,
    league: (feed.meta && feed.meta.league) || 'ENGLAND',
    week: String(week),
    PID: `${bookie.pidPrefix}::${fmtPidDate(t)}`,
    predictions,
  };

  // provisional result entry (real goals arrive later via results ingest)
  const goals = picked.map(() => pickGoals(rng));
  const oddsMatrix = [0, 1, 2, 3].map((mIdx) => predictions.map((p) => p.allOdds[mIdx]));
  const resultEntry = {
    match: picked.map((p) => `${p.home} vs ${p.away}`),
    time: `${fmtTime(t)} - week * ${week}`,
    result: goals,
    odds: oddsMatrix,
  };
  return { pick, resultEntry };
}

// Walk +/- N rounds through (week, roundInWeek), wrapping weeks 1..38.
function weekAt(week, roundInWeek, deltaRounds) {
  const perSeason = 38 * ROUNDS_PER_WEEK;
  let t = (week - 1) * ROUNDS_PER_WEEK + roundInWeek + deltaRounds;
  t = ((t - 1) % perSeason + perSeason) % perSeason + 1;
  return [Math.floor((t - 1) / ROUNDS_PER_WEEK) + 1, ((t - 1) % ROUNDS_PER_WEEK) + 1];
}

// ---- round builder ----------------------------------------------------------
function buildRound(rng, bookie, week, roundInWeek, t, roundIndex) {
  // 1) fixture schedule (simulated — replace with real scraping here)
  const teamPool = TEAMS.slice();
  for (let i = teamPool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [teamPool[i], teamPool[j]] = [teamPool[j], teamPool[i]];
  }
  const fixtures = [];
  for (let i = 0; i < FIXTURES_PER_ROUND; i++) {
    fixtures.push({
      slot: i + 1,
      home: teamPool[i * 2],
      away: teamPool[i * 2 + 1],
      lambda: bookie.lambdaMin + rng() * (bookie.lambdaMax - bookie.lambdaMin),
    });
  }

  // 2) "analysis" → pick the 3 best (stand-in for RealNaps' server logic)
  const scored = fixtures.map((f) => ({
    ...f,
    score: -Math.abs(f.lambda - 3.05) + rng() * 0.35,
  }));
  scored.sort((x, y) => y.score - x.score);
  const picked = scored.slice(0, PICKS_PER_ROUND);

  // 3) prediction object — same shape as the real <site>-prediction event
  const predictions = picked.map((p) => {
    const o = oddsFor(p.lambda);
    return { Game: p.slot, Team: `${p.home} vs ${p.away}`, allOdds: [o.o15, o.o25, o.u15, o.u25] };
  });
  const pick = {
    betting_site: bookie.site,
    league: 'ENGLAND',
    week: String(week),
    PID: `${bookie.pidPrefix}::${fmtPidDate(t)}`,
    predictions,
  };

  // 4) result entry — same shape as the real <site>-result log entries
  const goals = picked.map(() => pickGoals(rng));
  const oddsMatrix = [0, 1, 2, 3].map((m) =>
    picked.map((p) => oddsFor(p.lambda)[['o15', 'o25', 'u15', 'u25'][m]])
  );
  const resultEntry = {
    match: picked.map((p) => `${p.home} vs ${p.away}`),
    time: `${fmtTime(t)} - week * ${week}`,
    result: goals,
    odds: oddsMatrix,
  };

  return { pick, resultEntry };
}

// ---- bookie state machine ----------------------------------------------------
function createBookie(o) {
  const PREDICT_MS = o.predictMs || 100000;

  const b = {
    site: o.site,
    label: o.label,
    seed: o.seed,
    pidPrefix: o.pidPrefix,
    week: o.week,
    roundInWeek: o.roundInWeek || 1,
    roundIndex: 0,
    lambdaMin: o.lambda[0],
    lambdaMax: o.lambda[1],
    phase: 'predicting', // 'predicting' -> 'thinking' -> results -> 'predicting'
    prediction: null,
    results: [], // newest first
    phaseUntil: Date.now(),
  };

  // Pre-seed 1,000 rounds of history (oldest -> newest), like the real feed.
  const hist = [];
  const now = Date.now();
  for (let i = 0; i < HISTORY_ROUNDS; i++) {
    const stepsBack = HISTORY_ROUNDS - i; // i=0 is oldest
    const [hw, hriw] = weekAt(b.week, b.roundInWeek, -stepsBack);
    const t = new Date(now - stepsBack * 180000); // rounds ~3 min apart, like their log
    const rng = mulberry32(((b.seed * 2654435761 + i * 97) >>> 0));
    hist.push(buildRound(rng, b, hw, hriw, t, i).resultEntry);
  }
  hist.reverse();
  b.results = hist;

  // Current in-flight round (immediately "predicting").
  const rng = mulberry32(((b.seed * 2654435761 + HISTORY_ROUNDS * 97) >>> 0));
  b.prediction = buildRound(rng, b, b.week, b.roundInWeek, new Date(), HISTORY_ROUNDS).pick;
  b.phaseUntil = Date.now() + PREDICT_MS;
  return b;
}

// Advance a bookie's state machine. Returns true if something changed.
function tick(b, now, PREDICT_MS, THINK_MS) {
  if (now < b.phaseUntil) return false;

  if (b.phase === 'predicting') {
    // bets closed -> matches now playing
    b.phase = 'thinking';
    b.phaseUntil = now + THINK_MS;
    return true;
  }

  // 'thinking' ended -> settle the round, log the result, start the next one
  const t = new Date(now);
  const rng = mulberry32(((b.seed * 2654435761 + b.roundIndex * 97) >>> 0));
  const goals = b.prediction.predictions.map(() => pickGoals(rng));
  const oddsMatrix = [0, 1, 2, 3].map((m) => b.prediction.predictions.map((p) => p.allOdds[m]));
  b.results.unshift({
    match: b.prediction.predictions.map((p) => p.Team),
    time: `${fmtTime(t)} - week * ${b.week}`,
    result: goals,
    odds: oddsMatrix,
  });
  if (b.results.length > MAX_RESULTS) b.results.length = MAX_RESULTS;

  b.roundIndex++;
  b.roundInWeek++;
  if (b.roundInWeek > ROUNDS_PER_WEEK) {
    b.roundInWeek = 1;
    b.week = b.week >= 38 ? 1 : b.week + 1;
  }

  b.prediction = buildRound(rng, b, b.week, b.roundInWeek, t, b.roundIndex).pick;
  b.phase = 'predicting';
  b.phaseUntil = now + PREDICT_MS;
  return true;
}

module.exports = { createBookie, tick, buildRoundFromFeed, TEAMS };
