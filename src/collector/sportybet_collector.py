"""
SportyBet Virtual Football Collector
2 modes:
1) AUTO SELENIUM MODE - Runs 24/7, captures results as they appear
2) API SNIFF MODE - If you find the hidden API (see README), use requests

How SportyBet Virtuals work:
- New season starts every ~3 minutes? Actually Virtual Premier = 3-4 mins per matchday
- 10 matches per matchday, 38 matchdays per season
- Results appear for ~30 seconds then disappear
- We need to capture HTML table with scores

Usage:
python -m src.collector.sportybet_collector --mode selenium
"""

import time
import re
import json
import requests
from datetime import datetime
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.chrome import ChromeDriverManager
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../..'))
from src.datacenter.database import VirtualSportsDB

SPORTYBET_VIRTUAL_URL = "https://www.sportybet.com/ng/m/virtuals?productId=virtualFootball&tab=results"

# Fallback teams used in SportyBet Virtual Premier League (often English-like)
VIRTUAL_TEAMS = [
    "Man Utd", "Man City", "Liverpool", "Chelsea", "Arsenal",
    "Tottenham", "Everton", "Leicester", "West Ham", "Aston Villa",
    "Newcastle", "Leeds", "Wolves", "Crystal Palace", "Southampton",
    "Brighton", "Burnley", "Fulham", "West Brom", "Sheff Utd"
]

class SportyBetCollector:
    def __init__(self, headless=True, db_path=None):
        self.db = VirtualSportsDB(db_path) if db_path else VirtualSportsDB()
        self.headless = headless
        self.driver = None
        self.seen_matches = set()

    def init_driver(self):
        options = Options()
        if self.headless:
            options.add_argument("--headless=new")
        options.add_argument("--no-sandbox")
        options.add_argument("--disable-dev-shm-usage")
        options.add_argument("--window-size=1920,1080")
        options.add_argument("--disable-blink-features=AutomationControlled")
        options.add_argument("user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        # Enable performance logs to sniff API
        options.set_capability('goog:loggingPrefs', {'performance': 'ALL'})
        
        service = Service(ChromeDriverManager().install())
        self.driver = webdriver.Chrome(service=service, options=options)
        print("[Collector] Chrome driver started")

    def sniff_api_logs(self):
        """Try to extract API responses from performance logs"""
        try:
            logs = self.driver.get_log('performance')
            for log in logs:
                msg = json.loads(log['message'])['message']
                if 'Network.responseReceived' in msg['method']:
                    try:
                        url = msg['params']['response']['url']
                        if 'virtual' in url.lower() and ('result' in url.lower() or 'history' in url.lower() or 'match' in url.lower()):
                            print(f"[Sniff] Potential API found: {url}")
                            # You can then request body via Runtime
                    except:
                        pass
        except Exception as e:
            pass

    def parse_score_text(self, text):
        """
        Parse texts like:
        "Arsenal 2 - 1 Chelsea"
        "Man Utd 0:0 Liverpool"
        "1 - 0"
        """
        # Regex for score
        patterns = [
            r'(.+?)\s+(\d+)\s*[-:]\s*(\d+)\s+(.+)',  # Team A 2 - 1 Team B
            r'(\d+)\s*[-:]\s*(\d+)',  # Just 2 - 1
        ]
        for pat in patterns:
            m = re.search(pat, text)
            if m:
                if len(m.groups()) == 4:
                    return m.group(1).strip(), m.group(4).strip(), int(m.group(2)), int(m.group(3))
                elif len(m.groups()) == 2:
                    return None, None, int(m.group(1)), int(m.group(2))
        return None, None, None, None

    def collect_from_page(self):
        """Scrape current results page - customize selectors after inspecting SportyBet"""
        try:
            # Wait for any table or result container
            # NOTE: Selectors change often - you MUST inspect SportyBet with DevTools
            # Below is a generic attempt with multiple fallback selectors
            possible_selectors = [
                ".virtual-match-result",
                ".m-result-item",
                ".result-table tr",
                ".virtual-result",
                "div[class*='result']",
                "table tbody tr",
                ".match-history-item"
            ]
            
            found_items = []
            for sel in possible_selectors:
                try:
                    elems = self.driver.find_elements(By.CSS_SELECTOR, sel)
                    if elems and len(elems) > 2:
                        print(f"[Collector] Found {len(elems)} items via selector: {sel}")
                        found_items = elems
                        break
                except:
                    continue
            
            if not found_items:
                print("[Collector] No results found with generic selectors - page source dump needed. Need manual selector update.")
                # Save page source for debugging
                with open("data/last_page_source.html", "w", encoding="utf-8") as f:
                    f.write(self.driver.page_source)
                return 0

            count = 0
            for el in found_items[:20]:  # 10 matches per matchday
                text = el.text.strip()
                if not text or '-' not in text and ':' not in text:
                    continue
                
                home, away, hs, as_ = self.parse_score_text(text)
                if hs is None:
                    continue
                
                # If teams not parsed, try to get from child elements
                if not home:
                    try:
                        # Attempt to extract team names from page structure
                        # This is placeholder - you need to map actual structure
                        home = "HomeTeam"
                        away = "AwayTeam"
                    except:
                        continue
                
                match_key = f"{home}_{away}_{hs}_{as_}_{int(time.time()//180)}"
                if match_key in self.seen_matches:
                    continue
                
                self.db.insert_match(
                    home_team=home,
                    away_team=away,
                    home_score=hs,
                    away_score=as_,
                    match_id=match_key,
                    timestamp=datetime.now(),
                    source="sportybet_selenium"
                )
                self.seen_matches.add(match_key)
                count += 1
            
            return count
        except Exception as e:
            print(f"[Collector] Error in collect_from_page: {e}")
            return 0

    def run_forever(self, interval=180):
        """Main 24/7 loop"""
        self.init_driver()
        self.driver.get(SPORTYBET_VIRTUAL_URL)
        print(f"[Collector] Opened {SPORTYBET_VIRTUAL_URL}")
        print("[Collector] IMPORTANT: Manually login if required, navigate to Virtuals > Results. You have 30 seconds...")
        time.sleep(30)

        while True:
            try:
                print(f"\n[{datetime.now()}] Scanning for new results...")
                count = self.collect_from_page()
                self.sniff_api_logs()
                print(f"[{datetime.now()}] Inserted {count} new matches. Total seen: {len(self.seen_matches)}")
                
                # Also attempt direct API sniff - you can fill this after reverse engineering
                self.try_direct_api()

                print(f"[Collector] Sleeping {interval}s until next round...")
                time.sleep(interval)
            except KeyboardInterrupt:
                print("[Collector] Stopped by user")
                break
            except Exception as e:
                print(f"[Collector] Loop error: {e}")
                time.sleep(10)

    def try_direct_api(self):
        """
        If you discover SportyBet's internal API via DevTools:
        Example: it might be like https://www.sportybet.com/api/ng/virtual/football/results?lastN=50
        Then replace this method.
        """
        # Placeholder for discovered API - example structure:
        # Use your logged-in cookies
        # headers = { "Cookie": "...", "User-Agent": "..." }
        # resp = requests.get("https://.../results", headers=headers)
        # parse JSON and insert
        pass

    def manual_insert(self, home_team, away_team, home_score, away_score):
        self.db.insert_match(home_team, away_team, home_score, away_score)

# Manual entry CLI
if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["selenium", "manual", "fake"], default="selenium")
    parser.add_argument("--headless", action="store_true")
    args = parser.parse_args()

    collector = SportyBetCollector(headless=args.headless)

    if args.mode == "manual":
        print("Manual entry mode. Type: HomeTeam AwayTeam HomeScore AwayScore OR 'exit'")
        while True:
            inp = input("> ").strip()
            if inp.lower() == "exit":
                break
            try:
                parts = inp.split()
                if len(parts) < 4:
                    print("Use: Arsenal Chelsea 2 1")
                    continue
                home, away, hs, as_ = parts[0], parts[1], int(parts[2]), int(parts[3])
                collector.manual_insert(home, away, hs, as_)
            except Exception as e:
                print(f"Error: {e}")

    elif args.mode == "fake":
        # Generate fake data for testing predictor
        from src.datacenter.database import VirtualSportsDB
        import random
        db = VirtualSportsDB()
        print("[Fake] Generating 1000 fake virtual matches...")
        for i in range(1000):
            ht = random.choice(VIRTUAL_TEAMS)
            at = random.choice([t for t in VIRTUAL_TEAMS if t != ht])
            # Virtual leagues have lower scoring: 70% under 2.5
            # Use Poissonish distribution
            hs = max(0, int(random.gauss(1.1, 1.2)))
            as_ = max(0, int(random.gauss(0.9, 1.1)))
            hs = min(hs, 5)
            as_ = min(as_, 5)
            db.insert_match(ht, at, hs, as_, season=random.randint(1,20), matchday=random.randint(1,38), timestamp=datetime.now())
        print("[Fake] Done")

    else:
        collector.run_forever()
