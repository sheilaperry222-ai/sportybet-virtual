
// SPORTYBET INSTANT VIRTUAL REAL-TIME CONNECTOR v2
// Paste this in DevTools Console on https://www.sportybet.com/ng/virtual/
// It will auto-capture every result and POST to your data center API

(function() {
  console.log("🎯 SportyBet Instant Virtual Connector Loaded - Waiting for results...");
  const API_URL = "http://localhost:8000/collect"; // Change to your Render/Netlify API if hosted
  
  // Intercept fetch/XHR
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);
    const url = args[0]?.toString() || "";
    if (url.includes("virtual") && (url.includes("result") || url.includes("history") || url.includes("event") || url.includes("outcome"))) {
      try {
        const clone = response.clone();
        const text = await clone.text();
        console.log("🎯 [VIRTUAL API CAPTURED]", url, text.slice(0,500));
        // Try parse
        try {
          const data = JSON.parse(text);
          // Send to collector
          handleVirtualData(data, url);
        } catch(e) {}
      } catch(e) { console.error(e); }
    }
    return response;
  };

  // Also intercept XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) { this._url = url; return origOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function() {
    this.addEventListener('load', function() {
      if (this._url && this._url.includes("virtual") && (this._url.includes("result") || this._url.includes("history") || this._url.includes("search"))) {
        console.log("🎯 [XHR VIRTUAL]", this._url, this.responseText.slice(0,500));
        try { handleVirtualData(JSON.parse(this.responseText), this._url); } catch(e) {}
      }
    });
    return origSend.apply(this, arguments);
  };

  function handleVirtualData(data, url) {
    // SportyBet instant virtual format is often:
    // { data: { events: [{homeTeamName, awayTeamName, homeScore, awayScore, ...}] } }
    // Or { results: [ {home:"Man Utd", away:"Arsenal", score:"2:1"} ] }
    // We try multiple parsers
    let matches = [];
    
    // Parser 1: Kiron style
    if (data.data && data.data.events) matches = data.data.events;
    else if (data.events) matches = data.events;
    else if (data.results) matches = data.results;
    else if (Array.isArray(data)) matches = data;
    else if (data.data && Array.isArray(data.data)) matches = data.data;
    
    matches.forEach(m => {
      let home = m.homeTeamName || m.homeTeam || m.home || m.team1Name || m.hostName || "Unknown";
      let away = m.awayTeamName || m.awayTeam || m.away || m.team2Name || m.guestName || "Unknown";
      let hs = m.homeScore ?? m.home_score ?? m.score?.split?.(":")?.[0] ?? m.ftScore?.split?.(":")?.[0] ?? null;
      let as = m.awayScore ?? m.away_score ?? m.score?.split?.(":")?.[1] ?? m.ftScore?.split?.(":")?.[1] ?? null;
      
      // Try extract from market results
      if (hs===null && m.outcomes) {
        // Look for correct score outcome
        let scoreOutcome = m.outcomes.find(o=> o.score);
        if (scoreOutcome) { let s = scoreOutcome.score.split(":"); hs = parseInt(s[0]); as = parseInt(s[1]); }
      }
      
      if (hs!==null && as!==null) {
        hs = parseInt(hs); as = parseInt(as);
        console.log(`✅ CAPTURED: ${home} ${hs}-${as} ${away}`);
        // POST to your data center
        fetch(API_URL, {
          method: "POST",
          headers: {"Content-Type":"application/json"},
          body: JSON.stringify({home_team: home, away_team: away, home_score: hs, away_score: as, season: 1, matchday: 1})
        }).then(r=>r.json()).then(d=>console.log("Saved to DB:", d)).catch(e=>console.error("Save failed - is API running? ", e));
      }
    });
  }

  console.log("✅ Injector active. Now wait for next virtual round (~2-3 mins). Results will auto-save.");
  console.log("If API_URL fails (CORS), change to your hosted API URL and allow CORS.");
})();
