/**
 * SportyBet Instant Virtual LIVE PREDICTOR v4
 * Auto-detects CURRENT matches on SportyBet instant virtual site and predicts them
 * Bypasses bot detection because runs inside YOUR real browser as Tampermonkey
 * 
 * Install:
 * 1. Tampermonkey addon -> New script -> Paste this ENTIRE file -> Save
 * 2. Edit CONFIG below with your Netlify URL and Supabase keys
 * 3. Go to https://www.sportybet.com/ng/virtual/ (or /instant-virtuals/)
 * 4. Login - It will auto-detect current round fixtures and show predictions OVERLAID on SportyBet page
 */

// ==UserScript==
// @name         SportyBet Instant Virtual LIVE Auto-Predictor
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Auto-detects current SportyBet instant virtual fixtures and predicts Correct Score + Over 2.5 + Under 1.5 live on page - bypasses bot detection
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

    const CONFIG = {
        // Your live APIs (from previous deploys)
        NETLIFY_PREDICT_URL: "https://sportybet-virtual-hjxbftocxaalmqewmlxe.netlify.app/.netlify/functions/predict_all",
        RENDER_PREDICT_URL: "https://sportybet-virtual-api.onrender.com/predict_all", // Fallback, heavy ML
        COLLECT_URL: "https://sportybet-virtual-hjxbftocxaalmqewmlxe.netlify.app/.netlify/functions/collect",
        SUPABASE_URL: "https://hjxbftocxaalmqewmlxe.supabase.co",
        SUPABASE_KEY: "sb_publishable_RfPO3hS4jVyc164y8zPZAw_MB5ThsyY",
        DEBUG: true,
        AUTO_PREDICT: true, // Auto predict as soon as fixtures appear
    };

    const seenFixtures = new Set();
    const seenResults = new Set();
    let currentFixturesCache = [];

    console.log("🟢 [LivePredictor v4] Loaded - Will auto-detect CURRENT SportyBet Instant Virtual matches and predict");

    // Create floating prediction panel on SportyBet page
    function createPanel() {
        if (document.getElementById('sportybet-predictor-panel')) return document.getElementById('sportybet-predictor-panel');
        
        const panel = document.createElement('div');
        panel.id = 'sportybet-predictor-panel';
        panel.style.cssText = `
            position: fixed; bottom: 20px; right: 20px; width: 380px; max-height: 80vh; overflow-y: auto;
            background: linear-gradient(135deg, #0f172a, #1e293b); border: 2px solid #2563eb; border-radius: 16px;
            padding: 14px; z-index: 9999999; box-shadow: 0 20px 60px rgba(0,0,0,0.7);
            font-family: 'Segoe UI', system-ui; color: #e2e8f0; font-size: 12px;
        `;
        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                <div style="font-weight:800;font-size:14px;">⚽ LIVE PREDICTOR <span style="background:#facc15;color:#000;padding:2px 8px;border-radius:10px;font-size:10px;margin-left:6px;">V4 BYPASS</span></div>
                <button id="sbp-close" style="background:#1e293b;border:0;color:#94a3b8;padding:4px 10px;border-radius:8px;cursor:pointer;">✕</button>
            </div>
            <div style="font-size:11px;color:#94a3b8;margin-bottom:10px;">Auto-detects current Instant Virtual round (10 matches) → Predicts CS + Over 2.5 + Under 1.5</div>
            <div id="sbp-status" style="background:#0f172a;border-radius:8px;padding:8px;margin-bottom:10px;font-size:11px;color:#facc15;">⏳ Waiting for current fixtures... Keep this tab open on SportyBet Virtual page</div>
            <div id="sbp-fixtures" style="display:grid;gap:8px;"></div>
            <div style="margin-top:10px;display:flex;gap:6px;">
                <button id="sbp-refresh" style="flex:1;background:#2563eb;color:white;border:0;padding:8px;border-radius:8px;cursor:pointer;font-weight:600;font-size:11px;">🔄 Force Predict Current</button>
                <button id="sbp-clear" style="background:#1e293b;color:#94a3b8;border:0;padding:8px;border-radius:8px;cursor:pointer;font-size:11px;">Clear</button>
            </div>
            <div style="margin-top:8px;font-size:10px;color:#64748b;text-align:center;">Powered by Supabase 107 matches + XGBoost • Bypasses bot detection (runs in YOUR browser)</div>
        `;
        document.body.appendChild(panel);
        
        document.getElementById('sbp-close').onclick = () => panel.style.display = 'none';
        document.getElementById('sbp-clear').onclick = () => {
            document.getElementById('sbp-fixtures').innerHTML = '';
            seenFixtures.clear();
            currentFixturesCache = [];
            document.getElementById('sbp-status').textContent = 'Cleared. Waiting for next round...';
        };
        document.getElementById('sbp-refresh').onclick = () => {
            if (currentFixturesCache.length > 0) {
                predictCurrentRound(currentFixturesCache);
            } else {
                // Try DOM scan for fixtures
                scanDOMForFixtures();
            }
        };

        // Make draggable
        let isDragging = false, startX, startY, origX, origY;
        panel.querySelector('div').addEventListener('mousedown', (e) => {
            isDragging = true; startX = e.clientX; startY = e.clientY;
            origX = panel.offsetLeft; origY = panel.offsetTop;
            panel.style.right = 'auto'; panel.style.bottom = 'auto';
            panel.style.left = origX + 'px'; panel.style.top = origY + 'px';
        });
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            panel.style.left = (origX + e.clientX - startX) + 'px';
            panel.style.top = (origY + e.clientY - startY) + 'px';
        });
        document.addEventListener('mouseup', () => isDragging = false);

        return panel;
    }

    function log(...args) { if (CONFIG.DEBUG) console.log("🎯 [LivePredictor]", ...args); }

    function setStatus(text, color="#facc15") {
        const el = document.getElementById('sbp-status');
        if (el) { el.textContent = text; el.style.color = color; }
    }

    // Hook fetch to capture UPCOMING fixtures (not just results)
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
        const response = await origFetch.apply(this, args);
        const url = args[0]?.toString() || "";
        // Capture both upcoming fixtures AND results
        if (url.toLowerCase().includes("virtual") || url.includes("factsCenter") || url.includes("searchEvents") || url.includes("scheduled")) {
            try {
                const clone = response.clone();
                clone.text().then(text => {
                    try {
                        const data = JSON.parse(text);
                        if (text.includes("homeTeam") || text.includes("event") || text.includes("team")) {
                            log("Fetch captured:", url, text.slice(0,400));
                            handlePossibleFixtures(data, url);
                            handlePossibleResults(data, url);
                        }
                    } catch(e) {}
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
            if (this._url && (this._url.toLowerCase().includes("virtual") || this._url.includes("factsCenter") || this._url.includes("searchEvents"))) {
                try {
                    const data = JSON.parse(this.responseText);
                    log("XHR captured:", this._url, this.responseText.slice(0,400));
                    handlePossibleFixtures(data, this._url);
                    handlePossibleResults(data, this._url);
                } catch(e) {}
            }
        });
        return origSend.apply(this, args);
    };

    function handlePossibleFixtures(data, url) {
        let events = [];
        try {
            // Multiple possible structures for upcoming fixtures
            if (data.data) {
                if (Array.isArray(data.data)) events = data.data;
                else if (data.data.events) events = data.data.events;
                else if (data.data.fixtures) events = data.data.fixtures;
                else if (data.data.matches) events = data.data.matches;
            } else if (data.events) events = data.events;
            else if (data.fixtures) events = data.fixtures;
            else if (data.matches) events = data.matches;
            else if (Array.isArray(data)) events = data;
            else if (data.payload && data.payload.events) events = data.payload.events;

            // Filter to only upcoming (not finished) - usually has no score or status = upcoming/scheduled
            const upcoming = events.filter(e => {
                const hasScore = (e.homeScore != null || e.awayScore != null || e.score || e.ftScore);
                const status = (e.status || e.matchStatus || e.eventStatus || "").toLowerCase();
                // If has no score and status is upcoming/scheduled/notstarted, it's a current fixture
                return !hasScore || status.includes("upcoming") || status.includes("scheduled") || status.includes("notstarted") || status.includes("before");
            });

            if (upcoming.length >= 2) { // At least 2 fixtures = likely a round
                log(`Found ${upcoming.length} upcoming fixtures from ${url}`);
                const fixtures = upcoming.slice(0,10).map(e => {
                    let home = e.homeTeamName || e.homeTeam || e.home || e.team1Name || e.hostName || e.team1;
                    let away = e.awayTeamName || e.awayTeam || e.away || e.team2Name || e.guestName || e.team2;
                    return { home, away, raw: e };
                }).filter(f => f.home && f.away);

                if (fixtures.length >= 2) {
                    // Deduplicate by round
                    const key = fixtures.map(f=>`${f.home} vs ${f.away}`).sort().join('|');
                    if (seenFixtures.has(key)) return;
                    seenFixtures.add(key);
                    currentFixturesCache = fixtures;
                    log("NEW CURRENT ROUND DETECTED:", fixtures);
                    setStatus(`🎯 Current round detected: ${fixtures.length} matches - Predicting...`, "#22c55e");
                    
                    if (CONFIG.AUTO_PREDICT) {
                        predictCurrentRound(fixtures);
                    }
                }
            }
        } catch(e) { log("Fixture parse error", e); }
    }

    function handlePossibleResults(data, url) {
        // Same as before - capture results to save to Supabase
        let matches = [];
        try {
            if (data.data) {
                if (Array.isArray(data.data)) matches = data.data;
                else if (data.data.events) matches = data.data.events;
                else if (data.data.results) matches = data.data.results;
            } else if (data.events) matches = data.events;
            else if (data.results) matches = data.results;
            else if (Array.isArray(data)) matches = data;
        } catch(e) {}

        matches.forEach(m => {
            try {
                let home = m.homeTeamName || m.homeTeam || m.home || m.team1Name;
                let away = m.awayTeamName || m.awayTeam || m.away || m.team2Name;
                let hs = m.homeScore ?? m.home_score;
                let as_ = m.awayScore ?? m.away_score;
                if (hs == null) {
                    let s = m.score || m.ftScore || "";
                    if (typeof s === 'string' && s.includes(':')) {
                        let parts = s.split(':'); hs = parseInt(parts[0]); as_ = parseInt(parts[1]);
                    }
                }
                if (home && away && hs != null && !isNaN(hs)) {
                    let key = `${home}-${away}-${hs}-${as_}`;
                    if (seenResults.has(key)) return;
                    seenResults.add(key);
                    log(`✅ RESULT CAPTURED: ${home} ${hs}-${as_} ${away}`);
                    // Save to Supabase via Netlify function
                    fetch(CONFIG.COLLECT_URL, {
                        method: "POST",
                        headers: {"Content-Type":"application/json"},
                        body: JSON.stringify({home_team: home, away_team: away, home_score: parseInt(hs), away_score: parseInt(as_), league_name: "Instant Virtual", source: "tampermonkey_live_v4"})
                    }).then(r=>r.json()).then(d=>log("Saved to Supabase:", d)).catch(e=>log("Save failed", e));
                    showToast(`Saved: ${home} ${hs}-${as_} ${away}`);
                }
            } catch(e) {}
        });
    }

    function showToast(text) {
        let toast = document.createElement("div");
        toast.textContent = "🎯 " + text;
        toast.style.cssText = "position:fixed;bottom:20px;left:20px;background:#16a34a;color:white;padding:10px 16px;border-radius:10px;z-index:9999999;font-family:sans-serif;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,0.5);";
        document.body.appendChild(toast);
        setTimeout(()=>toast.remove(), 4000);
    }

    async function predictCurrentRound(fixtures) {
        const panel = createPanel();
        const container = document.getElementById('sbp-fixtures');
        container.innerHTML = '';
        setStatus(`Predicting ${fixtures.length} current matches...`, "#facc15");

        for (let i = 0; i < fixtures.length; i++) {
            const f = fixtures[i];
            const home = f.home, away = f.away;
            
            // Create placeholder card
            const card = document.createElement('div');
            card.style.cssText = "background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:10px;";
            card.innerHTML = `
                <div style="font-weight:700;font-size:12px;margin-bottom:6px;">${home} vs ${away}</div>
                <div style="color:#94a3b8;font-size:11px;">⏳ Predicting...</div>
            `;
            container.appendChild(card);

            try {
                // Call Netlify predict_all function
                const res = await fetch(CONFIG.NETLIFY_PREDICT_URL, {
                    method: "POST",
                    headers: {"Content-Type":"application/json"},
                    body: JSON.stringify({home_team: home, away_team: away, top_n: 3})
                });
                const data = await res.json();
                
                const topCS = data.correct_score?.predictions?.[0] || data.summary?.top_correct_score;
                const over25 = data.over_under?.ensemble?.over_2_5 || data.over_under?.ensemble?.["over_2.5"] || 0;
                const under15 = data.over_under?.ensemble?.under_1_5 || data.over_under?.ensemble?.["under_1.5"] || 0;
                const predTotal = data.over_under?.ensemble?.predicted_total || data.summary?.predicted_total_goals || 0;
                const bestBet = data.over_under?.recommendation?.best_bet || data.summary?.recommendation?.best_bet || "";

                const overRec = data.over_under?.recommendation?.over_2_5 || "";
                const underRec = data.over_under?.recommendation?.under_1_5 || "";

                card.innerHTML = `
                    <div style="font-weight:700;font-size:12px;margin-bottom:6px;display:flex;justify-content:space-between;">
                        <span>${home.slice(0,15)} vs ${away.slice(0,15)}</span>
                        <span style="color:#facc15;font-size:10px;">λ ${predTotal.toFixed(2)}</span>
                    </div>
                    <div style="display:flex;gap:6px;margin-bottom:6px;">
                        <span style="background:#1e293b;padding:3px 8px;border-radius:12px;font-size:11px;font-weight:700;">${topCS ? topCS.score : 'N/A'} <span style="color:#facc15;">${topCS ? (topCS.prob*100).toFixed(1)+'%' : ''}</span></span>
                        <span style="background:${over25>0.6?'#052e16':'#1e293b'};color:${over25>0.6?'#22c55e':'#94a3b8'};padding:3px 8px;border-radius:12px;font-size:10px;">O2.5 ${(over25*100).toFixed(0)}% ${overRec?`(${overRec})`:''}</span>
                        <span style="background:${under15>0.6?'#431407':'#1e293b'};color:${under15>0.6?'#f97316':'#94a3b8'};padding:3px 8px;border-radius:12px;font-size:10px;">U1.5 ${(under15*100).toFixed(0)}% ${underRec?`(${underRec})`:''}</span>
                    </div>
                    <div style="font-size:10px;color:#facc15;">Best: ${bestBet} | CS: ${(data.correct_score?.predictions||[]).slice(0,3).map(p=>p.score+' '+ (p.prob*100).toFixed(0)+'%').join(' ')}</div>
                `;

                // Also inject prediction directly onto SportyBet's own fixture row if found
                injectPredictionIntoSportyBetDOM(home, away, data);

            } catch (err) {
                log("Predict error for", home, away, err);
                card.innerHTML = `
                    <div style="font-weight:700;font-size:12px;">${home} vs ${away}</div>
                    <div style="color:#ef4444;font-size:11px;">Error: ${err.message}</div>
                `;
            }

            // Small delay to avoid rate limiting
            await new Promise(r => setTimeout(r, 300));
        }

        setStatus(`✅ Predicted ${fixtures.length} current matches - Best bets highlighted!`, "#22c55e");
    }

    function injectPredictionIntoSportyBetDOM(home, away, prediction) {
        // Try to find SportyBet's fixture DOM element and inject prediction badge
        // SportyBet structure varies, we try multiple selectors
        const selectors = [
            `div:has-text("${home}")`,
            `[data-test*="${home}"]`,
            `.match-item`,
            `.event-item`,
            `.virtual-event`
        ];
        // Simple approach: find all divs containing both team names
        document.querySelectorAll('div').forEach(div => {
            const txt = div.innerText || '';
            if (txt.includes(home.slice(0,6)) && txt.includes(away.slice(0,6)) && txt.length < 200) {
                if (div.querySelector('.sbp-injected')) return; // Already injected
                try {
                    const badge = document.createElement('div');
                    badge.className = 'sbp-injected';
                    const topCS = prediction.correct_score?.predictions?.[0];
                    const bestBet = prediction.over_under?.recommendation?.best_bet || "";
                    badge.style.cssText = "background:linear-gradient(90deg,#2563eb,#facc15);color:#000;padding:2px 6px;border-radius:10px;font-size:10px;font-weight:800;margin-left:8px;display:inline-block;";
                    badge.textContent = `🎯 ${topCS ? topCS.score : ''} ${bestBet}`;
                    div.appendChild(badge);
                } catch(e) {}
            }
        });
    }

    function scanDOMForFixtures() {
        // Fallback: scan DOM for current fixtures if API interception missed
        log("DOM scan for fixtures...");
        const fixtures = [];
        document.querySelectorAll('div, li, tr').forEach(el => {
            const txt = el.innerText || '';
            // Look for "TeamA vs TeamB" pattern
            let m = txt.match(/(.+?)\s+vs\s+(.+)/i);
            if (m && txt.length < 80 && txt.length > 5) {
                let home = m[1].trim().split('\n')[0].trim();
                let away = m[2].trim().split('\n')[0].trim();
                if (home.length > 2 && away.length > 2 && home.length < 25 && away.length < 25) {
                    // Filter out non-team texts
                    if (!home.includes("Odds") && !away.includes("Odds") && !home.includes("Sporty") && !txt.includes("Login")) {
                        // Avoid duplicates
                        if (!fixtures.some(f=>f.home===home && f.away===away)) {
                            fixtures.push({home, away});
                        }
                    }
                }
            }
        });
        log(`DOM scan found ${fixtures.length} fixtures:`, fixtures.slice(0,5));
        if (fixtures.length >= 2) {
            currentFixturesCache = fixtures.slice(0,10);
            predictCurrentRound(currentFixturesCache);
        } else {
            setStatus("No fixtures found in DOM - wait for next round or refresh page", "#ef4444");
        }
    }

    // Init panel after page load
    window.addEventListener('load', () => {
        setTimeout(() => {
            createPanel();
            setStatus("Waiting for current Instant Virtual round... (auto-detects every 3 mins)", "#facc15");
            // Try DOM scan after 5 sec as fallback
            setTimeout(scanDOMForFixtures, 5000);
        }, 2000);
    });

    // Also create on DOM ready if load already fired
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(() => {
            createPanel();
        }, 1000);
    }

    log("✅ LivePredictor v4 active - Will auto-predict current SportyBet Instant Virtual matches");
})();
