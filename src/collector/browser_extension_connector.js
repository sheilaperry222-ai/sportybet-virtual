/**
 * SportyBet Stealth Browser Extension / Tampermonkey Script
 * Bypasses bot detection because it runs INSIDE your real browser as extension
 * SportyBet cannot distinguish from human - it's your real browser!
 * 
 * Install as:
 * Option 1: Tampermonkey addon -> Create new script -> paste this -> Save -> go to sportybet.com
 * Option 2: Save as extension manifest v3
 */

// ==UserScript==
// @name         SportyBet Instant Virtual Stealth Collector
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Auto captures SportyBet instant virtual results and sends to your Supabase/Netlify data center - bypasses all bot detection
// @author       Data Center
// @match        https://www.sportybet.com/*
// @match        https://*.sportybet.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // CONFIG - CHANGE THESE TO YOUR HOSTED ENDPOINTS
    const CONFIG = {
        // Your Supabase or Netlify collect endpoint
        COLLECT_URL: "https://your-site.netlify.app/.netlify/functions/collect",
        // Local fallback
        LOCAL_COLLECT_URL: "http://localhost:8000/collect",
        // Supabase direct (optional)
        SUPABASE_URL: "https://YOUR_PROJECT.supabase.co",
        SUPABASE_KEY: "YOUR_ANON_KEY",
        DEBUG: true,
    };

    console.log("🟢 [StealthCollector] Tampermonkey loaded - monitoring SportyBet virtual traffic");

    // Store to avoid duplicates
    const seen = new Set();
    let collectUrl = CONFIG.COLLECT_URL.includes("your-site") ? CONFIG.LOCAL_COLLECT_URL : CONFIG.COLLECT_URL;

    function log(...args) {
        if (CONFIG.DEBUG) console.log("🎯 [VirtualCollector]", ...args);
    }

    // Hook fetch
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
        const response = await origFetch.apply(this, args);
        const url = args[0]?.toString() || "";
        if (url.toLowerCase().includes("virtual") || url.includes("factsCenter") || url.includes("searchEvents")) {
            try {
                const clone = response.clone();
                clone.text().then(text => {
                    log("Fetch intercepted:", url, text.slice(0,300));
                    try { handleData(JSON.parse(text), url); } catch(e) {}
                });
            } catch(e) {}
        }
        return response;
    };

    // Hook XHR
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) { this._url = url; return origOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function(...args) {
        this.addEventListener('load', function() {
            if (this._url && (this._url.toLowerCase().includes("virtual") || this._url.includes("factsCenter"))) {
                log("XHR intercepted:", this._url, this.responseText.slice(0,300));
                try { handleData(JSON.parse(this.responseText), this._url); } catch(e) {}
            }
        });
        return origSend.apply(this, args);
    };

    // Hook WebSocket (SportyBet may use websocket for live virtual)
    const origWebSocket = window.WebSocket;
    window.WebSocket = function(url, protocols) {
        const ws = new origWebSocket(url, protocols);
        if (url.toLowerCase().includes("virtual") || url.includes("sporty")) {
            log("WebSocket opened:", url);
            ws.addEventListener('message', (event) => {
                log("WS message:", event.data.slice(0,300));
                try { 
                    const data = JSON.parse(event.data);
                    if (JSON.stringify(data).includes("score") || JSON.stringify(data).includes("virtual")) {
                        handleData(data, url);
                    }
                } catch(e) {}
            });
        }
        return ws;
    };
    window.WebSocket.prototype = origWebSocket.prototype;

    function handleData(data, url) {
        let matches = [];
        // Try multiple parsers for SportyBet formats
        try {
            if (Array.isArray(data)) matches = data;
            else if (data.data) {
                if (Array.isArray(data.data)) matches = data.data;
                else if (data.data.events) matches = data.data.events;
                else if (data.data.results) matches = data.data.results;
                else if (data.data.matches) matches = data.data.matches;
            } else if (data.events) matches = data.events;
            else if (data.results) matches = data.results;
            else if (data.payload && data.payload.events) matches = data.payload.events;
            else if (data.facts && data.facts.events) matches = data.facts.events;
        } catch(e) { log("Parser error", e); return; }

        // Also try deep scan for any object containing home/away/score
        if (matches.length === 0) {
            // Deep search
            const str = JSON.stringify(data);
            if (str.includes("homeTeam") && str.includes("awayTeam") && str.includes("Score")) {
                // Try to extract via regex if not structured
                log("Deep scan found potential matches", data);
                matches = [data]; // try single
            }
        }

        matches.forEach(m => {
            try {
                let home = m.homeTeamName || m.homeTeam || m.home || m.team1Name || m.hostName || m.team1 || m.event?.homeTeam;
                let away = m.awayTeamName || m.awayTeam || m.away || m.team2Name || m.guestName || m.team2 || m.event?.awayTeam;
                let hs = m.homeScore ?? m.home_score ?? m.hScore ?? m.team1Score;
                let as_ = m.awayScore ?? m.away_score ?? m.aScore ?? m.team2Score;

                if (hs == null) {
                    let scoreStr = m.score || m.ftScore || m.finalScore || m.result || "";
                    if (typeof scoreStr === 'string' && scoreStr.includes(":")) {
                        let parts = scoreStr.split(":");
                        hs = parseInt(parts[0]); as_ = parseInt(parts[1]);
                    } else if (typeof scoreStr === 'string' && scoreStr.includes("-")) {
                        let parts = scoreStr.split("-");
                        hs = parseInt(parts[0]); as_ = parseInt(parts[1]);
                    }
                }

                // Try outcomes array
                if (hs == null && m.outcomes) {
                    let correctScoreOutcome = m.outcomes.find(o => (o.description && o.description.includes(":")) || o.score);
                    if (correctScoreOutcome) {
                        let s = (correctScoreOutcome.description || correctScoreOutcome.score || "").split(":");
                        if (s.length === 2) { hs = parseInt(s[0]); as_ = parseInt(s[1]); }
                    }
                }

                if (home && away && hs != null && as_ != null && !isNaN(hs) && !isNaN(as_)) {
                    let key = `${home}-${away}-${hs}-${as_}-${Math.floor(Date.now()/10000)}`;
                    if (seen.has(key)) return;
                    seen.add(key);
                    log(`✅ REAL CAPTURE: ${home} ${hs}-${as_} ${away} via ${url}`);

                    // Send to your data center
                    const payload = {
                        home_team: String(home).trim(),
                        away_team: String(away).trim(),
                        home_score: parseInt(hs),
                        away_score: parseInt(as_),
                        league_name: "Instant Virtual",
                        source: "sportybet_tampermonkey_stealth",
                        raw_json: m
                    };

                    // Try Netlify/Supabase first, fallback to local
                    sendToBackend(payload);
                }
            } catch (e) { log("Match parse error", e, m); }
        });
    }

    function sendToBackend(payload) {
        // Try primary URL
        fetch(collectUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        }).then(r => r.json()).then(d => {
            log("Saved to backend:", d);
            // Show notification on page
            showNotification(`Saved: ${payload.home_team} ${payload.home_score}-${payload.away_score} ${payload.away_team}`);
        }).catch(err => {
            log("Primary backend failed, trying local", err);
            if (collectUrl !== CONFIG.LOCAL_COLLECT_URL) {
                // Fallback to local
                fetch(CONFIG.LOCAL_COLLECT_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                }).then(r=>r.json()).then(d=>log("Saved to local:", d)).catch(e=>log("Local also failed", e));
            }

            // Also try Supabase direct if configured
            if (CONFIG.SUPABASE_URL && !CONFIG.SUPABASE_URL.includes("YOUR_PROJECT")) {
                sendToSupabaseDirect(payload);
            }
        });
    }

    function sendToSupabaseDirect(payload) {
        fetch(`${CONFIG.SUPABASE_URL}/rest/v1/matches`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "apikey": CONFIG.SUPABASE_KEY,
                "Authorization": `Bearer ${CONFIG.SUPABASE_KEY}`,
                "Prefer": "return=minimal"
            },
            body: JSON.stringify({
                home_team: payload.home_team,
                away_team: payload.away_team,
                home_score: payload.home_score,
                away_score: payload.away_score,
                league_name: payload.league_name,
                source: payload.source,
                raw_json: payload.raw_json
            })
        }).then(()=>log("Saved directly to Supabase")).catch(e=>log("Supabase direct failed", e));
    }

    function showNotification(text) {
        // Create small toast on SportyBet page
        let toast = document.createElement("div");
        toast.textContent = "🎯 " + text;
        toast.style.cssText = "position:fixed;bottom:20px;right:20px;background:#16a34a;color:white;padding:10px 16px;border-radius:10px;z-index:999999;font-family:sans-serif;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,0.5);";
        document.body.appendChild(toast);
        setTimeout(()=>toast.remove(), 4000);
    }

    // Also periodically scan DOM for results table (fallback)
    setInterval(() => {
        document.querySelectorAll("div, tr, li").forEach(el => {
            let txt = el.innerText || "";
            // Look for pattern "Team 2 - 1 Team" in virtual results area
            if (txt.includes("-") && txt.length < 100) {
                let m = txt.match(/(.+?)\s+(\d+)\s*[-:]\s*(\d+)\s+(.+)/);
                if (m && !el.dataset.scanned) {
                    el.dataset.scanned = "1";
                    let home = m[1].trim(), hs = parseInt(m[2]), as_ = parseInt(m[3]), away = m[4].trim();
                    if (home.length > 2 && away.length > 2 && home.length < 30 && away.length < 30) {
                        // Filter out non-team texts
                        if (!home.includes("Odds") && !away.includes("Odds")) {
                            log(`DOM SCAN: ${home} ${hs}-${as_} ${away}`);
                            // Optionally send
                            // sendToBackend({home_team: home, away_team: away, home_score: hs, away_score: as_, source: "dom_scan"});
                        }
                    }
                }
            }
        });
    }, 5000);

    log("✅ Stealth collector active - bypasses bot detection because it runs inside your browser");
})();
