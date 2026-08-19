'use strict';
/*
 * app.js — client for the VFL SIGNALS dashboard.
 *
 * The analytics logic below is a faithful port of the functions inside
 * RealNaps' own client engine (realnapsAI.js): trackSeason(), getOdd(),
 * getReturn(), winLose(), processAnalytic(), and the Martingale stake
 * suggestion. Same math, same thresholds (round return 0 -> red,
 * 1..3000 -> amber, 3000+ -> green).
 */

const SITES = {
  sportybet: { label: 'SportyBet', accent: '#079034' },
  betpawa:  { label: 'BetPawa',  accent: '#f0a500' },
  betking:  { label: 'BetKing',  accent: '#c0392b' },
};

const MK = {
  O15: { label: 'Over 1.5',  idx: 0, test: (g) => g >= 2 },
  O25: { label: 'Over 2.5',  idx: 1, test: (g) => g >= 3 },
  U15: { label: 'Under 1.5', idx: 2, test: (g) => g < 2 },
  U25: { label: 'Under 2.5', idx: 3, test: (g) => g < 3 },
};

const settings = {
  market: 'O15',
  pickCount: 1,
  style: 'singles',     // singles | acc
  strategy: 'flat',     // flat | martingale1_5 | martingale2 | martingale3 | martingale4
  base: 1000,
  season: 'ALL',        // ALL | C | P1 | L2
  view: 'table',
};

let active = 'sportybet';
let chart = null;

const cache = {};
for (const site in SITES) {
  cache[site] = { prediction: null, results: [], phase: 'thinking', phaseUntil: 0, pid: null, mult: 1, lastSig: null };
}

const socket = io((typeof window !== 'undefined' && window.VFL_SOCKET_URL) ? window.VFL_SOCKET_URL : undefined);

socket.on('connect', () => {
  document.getElementById('liveText').textContent = 'LIVE';
  document.getElementById('liveDot').style.background = '';
});
socket.on('disconnect', () => {
  document.getElementById('liveText').textContent = 'OFFLINE';
  document.getElementById('liveDot').style.background = '#f85149';
});

// ---------- socket wiring ---------------------------------------------------
for (const site in SITES) {
  socket.on(`${site}-prediction`, (d) => {
    const c = cache[site];
    c.prediction = d; c.pid = d && d.PID;
    if (site === active) renderPrediction();
  });
  socket.on(`${site}-result`, (d) => {
    const c = cache[site];
    c.results = Array.isArray(d) ? d : [];
    updateMartingale(c);
    if (site === active) renderAll();
  });
  socket.on(`${site}-phase`, (d) => {
    const c = cache[site];
    if (d) { c.phase = d.phase; c.phaseUntil = d.until || 0; }
    if (site === active) renderPhase();
  });
  socket.on(`${site}-source`, (d) => {
    const c = cache[site];
    c.sourceInfo = d || { source: 'sim' };
    if (site === active) renderSource();
  });
}

function renderSource() {
  const el = document.getElementById('sourceVal');
  const c = cache[active];
  const info = c.sourceInfo || {};
  if (info.source === 'live') {
    el.textContent = `LIVE SPORTYBET · ${info.fixtures ?? '?'} matches · ${info.ageSec != null ? info.ageSec + 's ago' : ''}`.trim();
    el.className = 'src-live';
  } else {
    el.textContent = 'OFFLINE — waiting for SportyBet';
    el.className = 'src-sim';
  }
}

// ---------- helpers (ports of realnapsAI.js) --------------------------------
const numberWithCommas = (x) => x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function weekOf(entry) {
  const t = (entry.time || '').split('week *')[1];
  const n = parseInt(t, 10);
  return isNaN(n) ? 0 : n;
}

// Split results (newest first) into seasons: [current, last, last-2, ...]
function seasonsOf(results) {
  const out = [];
  let cur = [];
  for (const r of results) {
    if (weekOf(r) === 1 && cur.length) { out.push(cur); cur = []; }
    cur.push(r);
  }
  if (cur.length) out.push(cur);
  return out;
}

function trackSeason(mode, results) {
  if (mode === 'ALL') return results;
  const S = seasonsOf(results);
  if (mode === 'C')  return S[0] || [];
  if (mode === 'P1') return S[1] || [];
  if (mode === 'L2') return (S[0] || []).concat(S[1] || []);
  return results;
}

function getOdd(entry, pickIndex) { // odds for the selected market
  const idx = MK[settings.market].idx;
  return parseFloat((entry.odds[idx] || [])[pickIndex] || 0);
}

// Same limits as realnaps: O1.5 needs >=2 goals, O2.5 >=3, U1.5 <2, U2.5 <3
function getReturn(odd, goals) {
  return MK[settings.market].test(goals) ? settings.base * odd : 0;
}

function strategyMultiplier() {
  const m = {
    flat: 1, martingale1_5: 1.5, martingale2: 2, martingale3: 3, martingale4: 4,
  }[settings.strategy];
  return m || 1;
}

// Round return under current market/style/pickCount, using base stake.
function roundReturn(entry) {
  const n = Math.min(settings.pickCount, 3);
  const odds = [], goals = entry.result;
  for (let i = 0; i < n; i++) odds.push(getOdd(entry, i));
  const wins = [];
  for (let i = 0; i < n; i++) wins.push(MK[settings.market].test(goals[i]));
  if (settings.style === 'acc') {
    const all = wins.every(Boolean);
    return all ? settings.base * odds.reduce((a, b) => a * b, 1) : 0;
  }
  let sum = 0;
  for (let i = 0; i < n; i++) if (wins[i]) sum += settings.base * odds[i];
  return sum;
}

// 0 -> red, 1 -> amber, 100 -> green (same thresholds as winLose())
function winLose(ret) {
  if (ret <= 0) return 0;
  if (ret < 3000) return 1;
  return 100;
}

function roundStake() {
  return settings.style === 'acc' ? settings.base : settings.base * Math.min(settings.pickCount, 3);
}

function processAnalytic(data) {
  const returns = data.map(roundReturn);
  const winnings = returns.filter((r) => r > 0).length;
  const sum = returns.reduce((a, b) => a + b, 0);
  const count = returns.length;
  const bets = count * roundStake();
  const acc = count ? Math.floor((winnings / count) * 100) : 0;
  return { winnings, sum, count, bets, acc };
}

// Martingale: on a losing round multiply by the strategy factor, cap x16.
function updateMartingale(c) {
  const first = c.results[0];
  if (!first) return;
  const sig = first.time + first.match.join('');
  if (sig === c.lastSig) return;
  c.lastSig = sig;
  const ret = roundReturn(first);
  const strat = strategyMultiplier();
  c.mult = ret > 0 ? 1 : Math.min(c.mult * strat, 16);
  renderNextStake();
}

function filtered() {
  return trackSeason(settings.season, cache[active].results);
}

// ---------- rendering --------------------------------------------------------
function renderPrediction() {
  const c = cache[active];
  const pred = c.prediction;
  const title = `SPORTYBET WINNER PREDICTIONS`;
  document.getElementById('heroTitle').textContent = title;
  document.getElementById('seasonVal').textContent = 'VIRTUAL ENGLAND';
  document.getElementById('weekVal').textContent = pred && pred.round ? `#${pred.round}` : '—';
  document.getElementById('pidVal').textContent = pred && pred.PID ? pred.PID : '—';

  const row = document.getElementById('picksRow');
  const inPlay = c.phase === 'thinking' || !pred || !pred.predictions || !pred.predictions.length;
  const offline = c.sourceInfo && c.sourceInfo.source === 'offline' || c.phase === 'offline';

  if (offline) {
    row.innerHTML = `
      <div class="thinking-panel">
        <div class="spinner" style="border-top-color:#f85149"></div>
        <div class="thinking-txt">OFFLINE</div>
        <div class="thinking-sub">Waiting for SportyBet data — this site shows real matches only, never simulated picks.</div>
      </div>`;
    return;
  }

  if (inPlay) {
    row.innerHTML = `
      <div class="thinking-panel">
        <div class="spinner"></div>
        <div class="thinking-txt">Thinking</div>
        <div class="thinking-sub">bets closed — matches in play, next real round soon…</div>
      </div>`;
    return;
  }

  const idx = MK[settings.market].idx;
  row.innerHTML = pred.predictions.map((p) => {
    const oddsHtml = MK && [['O15', 0], ['O25', 1], ['U15', 2], ['U25', 3]].map(([mkt, i]) => `
      <button class="odd-chip ${mkt === settings.market ? 'on' : ''}" data-mkt="${mkt}">
        <span class="mkt">${mkt === 'O15' ? 'Over 1.5' : mkt === 'O25' ? 'Over 2.5' : mkt === 'U15' ? 'Under 1.5' : 'Under 2.5'}</span>
        <b>${p.allOdds[i]}</b>
      </button>`).join('');
    const [home, away] = p.Team.split(' vs ');
    return `
      <div class="pick-card">
        <div class="game-no">GAME ${p.Game}</div>
        <div class="teams"><span class="home">${home}</span><span class="vs">vs</span><span class="away">${away}</span></div>
        <div class="odds">${oddsHtml}</div>
      </div>`;
  }).join('');

  row.querySelectorAll('.odd-chip').forEach((el) => {
    el.addEventListener('click', () => {
      settings.market = el.dataset.mkt;
      document.getElementById('pick').value = settings.market;
      renderAll();
    });
  });
}

function renderPhase() {
  const c = cache[active];
  const badge = document.getElementById('phaseBadge');
  const inPlay = c.phase === 'thinking';
  const offline = c.phase === 'offline';
  badge.textContent = offline ? 'OFFLINE' : (inPlay ? 'Thinking' : 'PREDICTING');
  badge.className = `badge ${offline ? 'thinking' : inPlay ? 'thinking' : 'predicting'}`;
  renderPrediction();
}

function renderNextStake() {
  const c = cache[active];
  const next = Math.floor(settings.base * c.mult);
  document.getElementById('nextStake').textContent = `Next ₦${numberWithCommas(next)}`;
}

function renderAnalytics() {
  const a = processAnalytic(filtered());
  document.getElementById('analyticAcc').textContent = a.count ? `${a.acc}%` : '—%';
  document.getElementById('analyticLogs').textContent = `${a.winnings} / ${a.count}`;
  document.getElementById('analyticWon').textContent = `₦${numberWithCommas(a.sum)}`;
  document.getElementById('analyticBet').textContent = `₦${numberWithCommas(a.bets)}`;
  renderNextStake();
}

function renderPrev() {
  const holder = document.getElementById('prevHolder');
  const data = filtered().slice(0, 150); // cap for performance

  if (settings.view === 'graph') {
    holder.innerHTML = '';
    renderChart(data);
    return;
  }
  document.getElementById('chartWrap').classList.add('hidden');

  if (!data.length) { holder.innerHTML = '<p class="empty">No finished rounds recorded yet. Real results appear here once SportyBet matches finish — this site never shows simulated history.</p>'; return; }

  let html = '';
  for (const entry of data) {
    const n = Math.min(settings.pickCount, 3);
    const ret = roundReturn(entry);
    const cls = { 0: 'bg-danger', 1: 'bg-warning', 100: 'bg-success' }[winLose(ret)];
    const timeStamp = entry.time.split('-')[0].trim();
    const week = entry.time.split('-')[1] ? entry.time.split('-')[1].trim() : '';
    let rows = '';
    for (let ri = 0; ri < 3; ri++) {
      const shown = ri < n;
      const odd = getOdd(entry, ri);
      const r = MK[settings.market].test(entry.result[ri]) ? settings.base * odd : 0;
      const stakeText = settings.style === 'acc' ? (shown ? numberWithCommas(settings.base) : 'x') : (shown ? numberWithCommas(settings.base) : 'x');
      rows += `<tr>
        <td>${entry.match[ri]}</td>
        <td>${week}</td>
        <td>${odd ? odd.toFixed(2) : '—'}</td>
        <td>₦${stakeText}</td>
        <td class="${r > 0 ? 'green' : 'red'}">${shown ? `₦${numberWithCommas(Math.floor(r))}` : 'x'}</td>
      </tr>`;
    }
    const totalRet = settings.style === 'acc' ? ret : Math.floor(ret);
    html += `
      <table class="rtable">
        <thead class="${cls}"><tr><th>MATCH</th><th>TIME | ${timeStamp}</th><th>ODDS</th><th>STAKE</th><th>RETURN</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="3">Total</td><td>₦${numberWithCommas(roundStake())}</td><td class="${ret > 0 ? 'green' : 'red'}">₦${numberWithCommas(totalRet)}</td></tr></tfoot>
      </table>`;
  }
  holder.innerHTML = html;
}

function renderChart(data) {
  document.getElementById('chartWrap').classList.remove('hidden');
  const weeks = new Map(); // label -> {ret, stake}
  const ordered = [];
  for (let i = data.length - 1; i >= 0; i--) { // oldest -> newest
    const e = data[i];
    const w = `wk ${weekOf(e)}`;
    if (!weeks.has(w)) { weeks.set(w, { ret: 0, stake: 0 }); ordered.push(w); }
    const s = weeks.get(w);
    s.ret += roundReturn(e);
    s.stake += roundStake();
  }
  const net = ordered.map((w) => weeks.get(w).ret - weeks.get(w).stake);
  const total = net.reduce((a, b) => a + b, 0);
  const color = total > 0 ? '#28a745' : '#8B0000';
  const ctx = document.getElementById('myChart').getContext('2d');
  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: ordered,
      datasets: [{ label: 'Weekly net return (₦)', data: net, borderColor: color, backgroundColor: color + '55', fill: true, tension: 0.3, pointRadius: 2 }],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: '#c9d1d9' } } },
      scales: {
        x: { ticks: { color: '#8b949e', maxTicksLimit: 18 } },
        y: { ticks: { color: '#8b949e' } },
      },
    },
  });
}

function renderAll() {
  renderAnalytics();
  renderPrev();
}

// ---------- UI events ---------------------------------------------------------
document.getElementById('bookieTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.bookie-tab');
  if (!btn) return;
  active = btn.dataset.site;
  document.querySelectorAll('.bookie-tab').forEach((b) => b.classList.toggle('active', b === btn));
  document.body.style.setProperty('--accent', SITES[active].accent);
  renderPrediction();
  renderPhase();
  renderAll();
});

document.getElementById('pick').addEventListener('change', (e) => {
  settings.market = e.target.value;
  renderAll();
});

document.querySelectorAll('.pick-count-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pick-count-btn').forEach((b) => b.classList.toggle('active', b === btn));
    settings.pickCount = parseInt(btn.dataset.pickCount, 10);
    renderAll();
  });
});

document.getElementById('bettingStyle').addEventListener('change', (e) => {
  settings.style = e.target.value;
  renderAll();
});

document.getElementById('strategy').addEventListener('change', (e) => {
  settings.strategy = e.target.value;
  const c = cache[active];
  c.mult = 1;
  renderAll();
});

document.getElementById('season').addEventListener('change', (e) => {
  settings.season = e.target.value;
  renderAll();
});

document.getElementById('view').addEventListener('change', (e) => {
  settings.view = e.target.value;
  renderPrev();
});

document.getElementById('updateBaseStake').addEventListener('click', () => {
  let v = parseFloat(document.getElementById('baseStake').value);
  if (isNaN(v) || v <= 0) v = 1000;
  settings.base = v;
  localStorage.setItem(`vflBaseStake:${active}`, String(v));
  const c = cache[active];
  c.mult = 1;
  renderAll();
});

document.getElementById('prevP').addEventListener('click', () => {
  document.getElementById('prevHolder').classList.toggle('hidden');
});

// countdown + live dot
setInterval(() => {
  const c = cache[active];
  const dot = document.getElementById('liveDot');
  dot.classList.add('blink');
  const remain = Math.max(0, Math.floor((c.phaseUntil - Date.now()) / 1000));
  const cd = document.getElementById('countdown');
  if (c.phase === 'offline' || (c.sourceInfo && c.sourceInfo.source === 'offline')) {
    cd.textContent = 'waiting for SportyBet data…';
  } else if (c.phase === 'thinking') {
    cd.textContent = 'matches in play…';
  } else if (remain > 0) {
    const m = String(Math.floor(remain / 60)).padStart(2, '0');
    const s = String(remain % 60).padStart(2, '0');
    cd.textContent = `kickoff in ${m}:${s}`;
  } else {
    cd.textContent = 'waiting for next round…';
  }
}, 1000);

// restore saved stake
try {
  const saved = parseFloat(localStorage.getItem(`vflBaseStake:${active}`));
  if (!isNaN(saved) && saved > 0) {
    settings.base = saved;
    document.getElementById('baseStake').value = String(saved);
  }
} catch (e) { /* ignore */ }

renderPrediction();
renderAll();
