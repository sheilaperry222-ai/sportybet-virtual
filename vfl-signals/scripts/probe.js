'use strict';
/* scripts/probe.js — verify the socket broadcast works (no browser needed). */
const { io } = require('socket.io-client');

const URL = process.env.URL || 'http://localhost:3000';
const s = io(URL, { transports: ['websocket'] });

let n = 0;
s.onAny((name, ...args) => {
  if (n++ >= 8) return;
  let p;
  try { p = JSON.stringify(args[0]); } catch (e) { p = String(args[0]); }
  if (p.length > 180) p = p.slice(0, 180) + `… [${p.length} chars]`;
  console.log(`${name} :: ${p}`);
});
s.on('connect', () => console.log(`connected to ${URL}`));
s.on('connect_error', (e) => { console.error('connect_error:', e.message); process.exit(1); });
setTimeout(() => process.exit(0), 12000);
