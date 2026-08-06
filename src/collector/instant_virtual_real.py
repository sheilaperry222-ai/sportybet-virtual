"""
Real SportyBet Instant Virtual Connector
Connects to REAL SportyBet instant virtual games for prediction

SportyBet Instant Virtual = simulated football every few minutes, 10 matches per round
Provider: Kiron / Inspired Gaming (renders via canvas, data comes via API)

HOW TO FIND THE REAL API (you must do this once, because SportyBet changes endpoint):
1. Login sportybet.com/ng on Chrome
2. Go to https://www.sportybet.com/ng/virtual/ OR https://www.sportybet.com/ng/sport/virtuals
3. Press F12 > Network tab > Filter: Fetch/XHR
4. Wait for next round (watch timer - usually 00:30 to next round)
5. When round ends, you'll see requests like:
   - /api/ng/virtual/searchEvents?productId=virtualFootball
   - /api/ng/virtual/live? /api/ng/factsCenter/results?marketId=...
   - Or https://dvo2.sportybet.com/ ... or https://virtuals.kironinteractive.com/ ...
6. Right-click > Copy > Copy as cURL
7. Paste cURL here and extract headers/cookies

This collector has 3 modes to guarantee connection:

MODE 1: BROWSER INJECTION (most reliable) - JS script you paste in console
MODE 2: PYTHON SELENIUM with request interception
MODE 3: DIRECT API with your cookies

"""

import os, sys, time, json, re
from datetime import datetime
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../..'))
from src.datacenter.database import VirtualSportsDB

# ============ MODE 1: BROWSER CONSOLE SCRIPT ============
# Copy this JS and paste into SportyBet virtual page console (F12)
BROWSER_JS_CONNECTOR = """
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
"""

class InstantVirtualRealConnector:
    def __init__(self, db_path=None, api_url="https://www.sportybet.com"):
        self.db = VirtualSportsDB(db_path) if db_path else VirtualSportsDB()
        self.api_url = api_url
        self.session_cookies = {}
        print(f"[InstantReal] Initialized - DB at {self.db.db_path}")

    def save_js_helper(self):
        """Save browser JS file for easy copy"""
        path = os.path.join(os.path.dirname(__file__), "../../data/browser_connector.js")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(BROWSER_JS_CONNECTOR)
        print(f"[InstantReal] Browser connector saved to {path}")
        print("Open SportyBet virtual, F12 console, paste contents, hit Enter")
        return path

    def direct_api_attempt(self, cookie_string=None):
        """
        After you copy cURL from DevTools, paste cookie and headers here
        Example cURL:
        curl 'https://www.sportybet.com/api/ng/factsCenter/...' \
          -H 'cookie: session=xxx; token=yyy' \
          -H 'user-agent: ...'
        """
        import requests
        
        # TODO: Replace with YOUR captured endpoint
        # You must fill these after sniffing
        candidate_endpoints = [
            "https://www.sportybet.com/api/ng/virtual/searchEvents",
            "https://www.sportybet.com/api/ng/factsCenter/live",
            "https://www.sportybet.com/api/ng/factsCenter/results",
            "https://www.sportybet.com/api/ng/virtual/scheduledEvents",
            "https://dvo2.sportybet.com/api/virtual/results",
        ]

        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json",
            "Referer": "https://www.sportybet.com/ng/virtual/",
            "Origin": "https://www.sportybet.com",
        }
        
        if cookie_string:
            headers["Cookie"] = cookie_string

        for endpoint in candidate_endpoints:
            try:
                print(f"[DirectAPI] Trying {endpoint}...")
                resp = requests.get(endpoint, headers=headers, timeout=10)
                print(f"Status {resp.status_code} len {len(resp.text)}")
                if resp.status_code == 200 and len(resp.text) > 50:
                    print(f"✅ Potential hit! Sample: {resp.text[:500]}")
                    # Try parse
                    try:
                        data = resp.json()
                        print(json.dumps(data, indent=2)[:2000])
                    except:
                        pass
            except Exception as e:
                print(f"Error {endpoint}: {e}")

        print("\nIf none worked, you MUST manually capture via browser F12. See save_js_helper()")

    def run_selenium_intercept(self, headless=False):
        """
        Selenium that logs all network requests to find virtual API
        """
        from selenium import webdriver
        from selenium.webdriver.chrome.service import Service
        from selenium.webdriver.chrome.options import Options
        from webdriver_manager.chrome import ChromeDriverManager
        import json as jsjson

        options = Options()
        if headless:
            options.add_argument("--headless=new")
        options.add_argument("--no-sandbox")
        options.add_argument("--disable-dev-shm-usage")
        options.add_argument("--window-size=1920,1080")
        options.set_capability('goog:loggingPrefs', {'performance': 'ALL'})

        service = Service(ChromeDriverManager().install())
        driver = webdriver.Chrome(service=service, options=options)

        print("[SeleniumIntercept] Open sportybet virtual page, login manually...")
        driver.get("https://www.sportybet.com/ng/virtual/")
        time.sleep(5)
        print("You have 60 seconds to login and navigate to Instant Virtual...")
        time.sleep(60)

        print("[SeleniumIntercept] Starting capture loop - every 10s dump logs")
        while True:
            try:
                logs = driver.get_log('performance')
                for log in logs:
                    try:
                        message = jsjson.loads(log['message'])['message']
                        if 'Network.responseReceived' in message['method']:
                            url = message['params']['response']['url']
                            if 'virtual' in url.lower():
                                print(f"\n🎯 VIRTUAL REQUEST FOUND: {url}")
                                print(f"Status: {message['params']['response']['status']}")
                                # Try get body
                                request_id = message['params']['requestId']
                                try:
                                    body = driver.execute_cdp_cmd('Network.getResponseBody', {'requestId': request_id})
                                    print(f"Body: {body['body'][:1000]}")
                                    # Try parse and save
                                    data = jsjson.loads(body['body'])
                                    # Call handler
                                    self._handle_api_data(data)
                                except Exception as e:
                                    print(f"Could not get body: {e}")
                        if 'virtual' in str(log).lower() and 'websocket' in str(log).lower():
                            print(f"WebSocket virtual: {log}")
                    except:
                        continue
                time.sleep(10)
                print(f"[{datetime.now()}] Waiting... {len(logs)} logs scanned")
            except KeyboardInterrupt:
                break
            except Exception as e:
                print(f"Loop error: {e}")
                time.sleep(5)

    def _handle_api_data(self, data):
        """Parse SportyBet virtual API JSON and save to DB"""
        matches = []
        # Multiple format support
        try:
            if isinstance(data, dict):
                if 'data' in data:
                    if isinstance(data['data'], dict) and 'events' in data['data']:
                        matches = data['data']['events']
                    elif isinstance(data['data'], list):
                        matches = data['data']
                elif 'events' in data:
                    matches = data['events']
                elif 'results' in data:
                    matches = data['results']
                elif 'matches' in data:
                    matches = data['matches']
            elif isinstance(data, list):
                matches = data
        except Exception as e:
            print(f"Parse error: {e}")

        for m in matches:
            try:
                home = m.get('homeTeamName') or m.get('homeTeam') or m.get('home') or m.get('team1Name') or m.get('hostName')
                away = m.get('awayTeamName') or m.get('awayTeam') or m.get('away') or m.get('team2Name') or m.get('guestName')
                
                # Score fields vary
                hs = m.get('homeScore')
                as_ = m.get('awayScore')
                if hs is None:
                    # Try score string "2:1"
                    score_str = m.get('score') or m.get('ftScore') or m.get('finalScore') or ""
                    if ':' in str(score_str):
                        parts = str(score_str).split(':')
                        hs, as_ = int(parts[0]), int(parts[1])
                
                if home and away and hs is not None and as_ is not None:
                    print(f"✅ REAL RESULT: {home} {hs}-{as_} {away}")
                    self.db.insert_match(home, away, int(hs), int(as_), source="sportybet_instant_real")
            except Exception as e:
                print(f"Skipping match parse: {e} data: {m}")

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Real SportyBet Instant Virtual Connector")
    parser.add_argument("--mode", choices=["js","selenium","api"], default="js", help="js=save browser JS, selenium=intercept, api=try direct API")
    parser.add_argument("--cookies", default=None, help="Paste cookie string for api mode")
    args = parser.parse_args()

    conn = InstantVirtualRealConnector()
    
    if args.mode == "js":
        path = conn.save_js_helper()
        print(f"\n=== INSTRUCTIONS ===")
        print(f"1. Open Chrome -> https://www.sportybet.com/ng/virtual/")
        print(f"2. Login")
        print(f"3. Press F12 -> Console tab")
        print(f"4. Open file {path} and copy ALL, paste in console, press Enter")
        print(f"5. Keep tab open - every result will auto-save to http://localhost:8000/collect")
        print(f"6. Make sure API is running: python run.py")
        print(f"\nBrowser JS also saved to data/browser_connector.js")
    
    elif args.mode == "selenium":
        conn.run_selenium_intercept(headless=False)
    
    elif args.mode == "api":
        conn.direct_api_attempt(cookie_string=args.cookies)
