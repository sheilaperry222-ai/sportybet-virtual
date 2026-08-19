const { io } = require('socket.io-client');
const s = io('http://localhost:3000', { transports: ['websocket'] });
let lastPhase = null, firstTime = null, sawThinking = false, sawNewRound = false;
s.on('sportybet-phase', d => { if (d.phase !== lastPhase) { console.log(`phase -> ${d.phase} (week ${d.week}, round ${d.round})`); lastPhase = d.phase; if (d.phase === 'thinking') sawThinking = true; } });
s.on('sportybet-result', d => {
  const t = d[0] && d[0].time;
  if (!firstTime) { firstTime = t; console.log('first newest entry:', t); }
  else if (t !== firstTime) { console.log('NEW RESULT LOGGED:', t); sawNewRound = true; process.exit(0); }
});
s.on('connect', () => console.log('connected, watching cycle…'));
setTimeout(() => { console.log('timeout: thinking=', sawThinking, 'newRound=', sawNewRound); process.exit(0); }, 240000);
