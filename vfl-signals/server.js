'use strict';
/*
 * server.js — web + Socket.IO prediction broadcaster (no auth, like realnaps).
 *
 * Architecture mirrors what was observed on realnaps.com:
 *   - Socket.IO server on port 3000, CORS wide open (Access-Control-Allow-Origin: *)
 *   - broadcasts every ~3 seconds:
 *       <site>-prediction  { betting_site, league, week, PID, predictions[] }
 *       <site>-result      [ 1,000 entries max, newest first ]
 *       <site>-phase       { phase, until, week, round, pid }   (extra, for UI)
 *   - no login, no paywall: every client that connects gets the picks.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const { createBookie, tick } = require('./engine');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PREDICT_MS = Number(process.env.PREDICT_SECONDS || 100) * 1000; // picks live ~2 min before "bet closes" (like realnaps)
const THINK_MS = Number(process.env.THINK_SECONDS || 50) * 1000;     // matches playing / "Thinking"
const BROADCAST_MS = 3000; // realnaps re-broadcasts ~every 3s

const bookies = [
  createBookie({ site: 'sportybet', label: 'SportyBet', seed: 101, week: 7,  roundInWeek: 20, lambda: [2.8, 3.3], pidPrefix: 'SPORTYBET', predictMs: PREDICT_MS }),
  createBookie({ site: 'betpawa',  label: 'BetPawa',  seed: 202, week: 30, roundInWeek: 12, lambda: [3.2, 3.7], pidPrefix: 'BETPAWA',  predictMs: PREDICT_MS }),
  createBookie({ site: 'betking',  label: 'BetKing',  seed: 303, week: 4,  roundInWeek: 8,  lambda: [2.7, 3.4], pidPrefix: 'BETKING',  predictMs: PREDICT_MS }),
];

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

const io = new Server(server, { cors: { origin: '*' } }); // same CORS posture as the real feed

function snapshotEvents(b) {
  return {
    prediction: b.phase === 'predicting' ? b.prediction : { ...b.prediction, predictions: [] },
    results: b.results,
    phase: { phase: b.phase, until: b.phaseUntil, week: b.week, round: b.roundInWeek, pid: b.prediction.PID },
  };
}

// Instant snapshot on connect so a fresh page paints immediately.
io.on('connection', (socket) => {
  for (const b of bookies) {
    const snap = snapshotEvents(b);
    socket.emit(`${b.site}-prediction`, snap.prediction);
    socket.emit(`${b.site}-result`, snap.results);
    socket.emit(`${b.site}-phase`, snap.phase);
  }
});

// The main broadcast loop (the heart of the workflow).
setInterval(() => {
  const now = Date.now();
  for (const b of bookies) tick(b, now, PREDICT_MS, THINK_MS);
  for (const b of bookies) {
    const snap = snapshotEvents(b);
    io.emit(`${b.site}-prediction`, snap.prediction);
    io.emit(`${b.site}-result`, snap.results);
    io.emit(`${b.site}-phase`, snap.phase);
  }
}, BROADCAST_MS);

server.listen(PORT, HOST, () => {
  console.log(`[server] http://${HOST}:${PORT}`);
  console.log(`[server] bookies: ${bookies.map((b) => b.site).join(', ')}`);
  console.log(`[server] round cycle: ${PREDICT_MS / 1000}s predicting + ${THINK_MS / 1000}s thinking`);
  console.log(`[server] result log: ${bookies[0].results.length} seeded rounds per bookie, cap 1000`);
  console.log(`[server] broadcasting every ${BROADCAST_MS / 1000}s to all clients (no auth)`);
});
