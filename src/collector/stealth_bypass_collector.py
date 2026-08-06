"""
SportyBet Stealth Collector - Bypasses Bot Detection
Combines multiple anti-detection techniques:

1. undetected-chromedriver (uc) - patches chromedriver binary, removes cdc_ flags
2. selenium-stealth - patches JS fingerprint (webdriver false, plugins, languages, chrome object)
3. Human-like behavior: random mouse moves, scrolls, delays, typing speed
4. Residential proxy support
5. Cloudflare Turnstile auto-solver via timing + nodriver fallback
6. Camoufox fallback - Firefox based, completely different fingerprint

SportyBet uses:
- Cloudflare + DataDome + custom JS checks for navigator.webdriver, window.chrome, permissions, plugins
- We bypass all.

Usage:
python -m src.collector.stealth_bypass_collector --method uc
python -m src.collector.stealth_bypass_collector --method nodriver
python -m src.collector.stealth_bypass_collector --method camoufox
python -m src.collector.stealth_bypass_collector --method all --proxy http://user:pass@host:port
"""

import os, sys, time, random, json
from datetime import datetime
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../..'))

from src.datacenter.database import VirtualSportsDB
from src.datacenter.supabase_client import HybridDB

# Try imports
try:
    import undetected_chromedriver as uc
    HAS_UC = True
except:
    HAS_UC = False

try:
    from selenium_stealth import stealth
    HAS_STEALTH = True
except:
    HAS_STEALTH = False

try:
    import nodriver as nd
    HAS_NODRIVER = True
except:
    HAS_NODRIVER = False

try:
    from camoufox import Camoufox
    HAS_CAMOUFOX = True
except:
    HAS_CAMOUFOX = False

try:
    from fake_useragent import UserAgent
    HAS_FAKE_UA = True
except:
    HAS_FAKE_UA = False

SPORTYBET_VIRTUAL_URL = "https://www.sportybet.com/ng/virtual/"
SPORTYBET_INSTANT_URL = "https://www.sportybet.com/ng/instant-virtuals/"

def random_delay(a=1, b=4):
    time.sleep(random.uniform(a,b))

def human_scroll(driver):
    try:
        driver.execute_script(f"window.scrollBy(0, {random.randint(200,600)});")
        random_delay(0.5,1.5)
        driver.execute_script(f"window.scrollBy(0, -{random.randint(50,200)});")
    except:
        pass

def human_mouse_move(driver):
    try:
        from selenium.webdriver.common.action_chains import ActionChains
        action = ActionChains(driver)
        x = random.randint(100, 800)
        y = random.randint(100, 600)
        action.move_by_offset(x, y).perform()
        random_delay(0.2,0.8)
    except:
        pass

class StealthCollector:
    def __init__(self, method="uc", proxy=None, headless=False):
        self.method = method
        self.proxy = proxy
        self.headless = headless
        self.db = HybridDB()
        print(f"[StealthCollector] Method={method} Proxy={proxy} DB Hybrid")

    def get_random_user_agent(self):
        if HAS_FAKE_UA:
            try:
                ua = UserAgent()
                return ua.chrome
            except:
                pass
        # Fallback list of real Chrome UA 2024-2025
        uas = [
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        ]
        return random.choice(uas)

    def create_uc_driver(self):
        if not HAS_UC:
            raise Exception("undetected-chromedriver not installed: pip install undetected-chromedriver")
        options = uc.ChromeOptions()
        options.add_argument(f"--user-agent={self.get_random_user_agent()}")
        options.add_argument("--disable-blink-features=AutomationControlled")
        options.add_argument("--no-sandbox")
        options.add_argument("--disable-dev-shm-usage")
        options.add_argument("--disable-infobars")
        options.add_argument("--disable-extensions")
        options.add_argument("--start-maximized")
        options.add_argument("--window-size=1920,1080")
        # Proxy
        if self.proxy:
            options.add_argument(f"--proxy-server={self.proxy}")
        # Stealth - remove headless for better bypass on SportyBet (they detect headless)
        if self.headless:
            # Use new headless mode which is less detectable
            options.add_argument("--headless=new")
        # Performance logs for API sniffing
        options.set_capability('goog:loggingPrefs', {'performance': 'ALL'})

        # Use undetected driver
        driver = uc.Chrome(options=options, version_main=None, headless=self.headless)
        
        # Apply selenium-stealth on top if available
        if HAS_STEALTH:
            stealth(driver,
                languages=["en-US", "en"],
                vendor="Google Inc.",
                platform="Win32",
                webgl_vendor="Intel Inc.",
                renderer="Intel Iris OpenGL Engine",
                fix_hairline=True,
            )
        # Extra JS patches
        driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        return driver

    def create_camoufox_driver(self):
        if not HAS_CAMOUFOX:
            raise Exception("camoufox not installed: pip install camoufox")
        # Camoufox is Firefox-based, excellent for bypassing Chrome detection
        # It spoofs entire fingerprint from real user data
        options = {
            "geoip": True,  # spoof location to match IP
            "os": "windows",
            "humanize": True,  # human-like mouse
        }
        if self.proxy:
            options["proxy"] = self.proxy
        
        driver = Camoufox(os="windows", geoip=True, humanize=True).webdriver
        return driver

    async def create_nodriver_session(self):
        if not HAS_NODRIVER:
            raise Exception("nodriver not installed: pip install nodriver")
        # Nodriver is the most advanced - it bypasses Cloudflare Turnstile automatically
        browser = await nd.start(
            headless=self.headless,
            user_agent=self.get_random_user_agent(),
            browser_args=[f"--proxy-server={self.proxy}"] if self.proxy else None
        )
        return browser

    def bypass_challenge_wait(self, driver, timeout=30):
        """Wait for Cloudflare challenge to complete"""
        print(f"[Bypass] Waiting {timeout}s for Cloudflare/DataDome to clear...")
        start = time.time()
        while time.time() - start < timeout:
            try:
                title = driver.title.lower()
                content = driver.page_source.lower()
                if "just a moment" in title or "checking if the site" in title or "turnstile" in content or "cloudflare" in content and "checking" in content:
                    print("[Bypass] Challenge detected, waiting...")
                    random_delay(3,6)
                    continue
                if "sportybet" in title or len(content) > 5000:
                    print(f"[Bypass] Page loaded: {driver.title}")
                    # Check if we got 403/400
                    if "40x" in content or "oops" in content and "doesn't exist" in content:
                        print("[Bypass] Got 40x/OOPS - may need to navigate differently")
                        # Try direct virtual path
                        random_delay(2,4)
                        return True
                    return True
            except:
                pass
            random_delay(1,2)
        return False

    def run_uc_mode(self):
        driver = self.create_uc_driver()
        try:
            print(f"[UC Mode] Opening {SPORTYBET_VIRTUAL_URL}")
            driver.get(SPORTYBET_VIRTUAL_URL)
            self.bypass_challenge_wait(driver, 40)
            human_scroll(driver)
            human_mouse_move(driver)

            print("[UC Mode] You have 90 seconds to login manually if needed...")
            print("Navigate to Instant Virtuals > Results, login, then bot will start sniffing")
            time.sleep(90)

            # Start capture loop
            seen = set()
            while True:
                try:
                    logs = driver.get_log('performance')
                    for log in logs:
                        try:
                            msg = json.loads(log['message'])['message']
                            if 'Network.responseReceived' in msg['method']:
                                url = msg['params']['response']['url']
                                if 'virtual' in url.lower() and any(k in url.lower() for k in ['result','history','event','facts','search','outcome','draw']):
                                    print(f"\n🎯 REAL VIRTUAL API: {url} Status {msg['params']['response']['status']}")
                                    try:
                                        req_id = msg['params']['requestId']
                                        body = driver.execute_cdp_cmd('Network.getResponseBody', {'requestId': req_id})
                                        data = json.loads(body['body'])
                                        self._parse_and_save(data)
                                    except Exception as e:
                                        print(f"Could not extract body: {e}")
                        except:
                            continue
                    
                    # Also try scrape visible results (fallback)
                    self._try_scrape_visible(driver, seen)
                    
                    print(f"[{datetime.now()}] Scanning... found {len(seen)} unique")
                    time.sleep(10)
                    # Random human behavior to avoid detection
                    if random.random() < 0.3:
                        human_scroll(driver)
                        human_mouse_move(driver)
                        
                except KeyboardInterrupt:
                    break
                except Exception as e:
                    print(f"Loop error: {e}")
                    time.sleep(5)
        finally:
            driver.quit()

    def _try_scrape_visible(self, driver, seen_set):
        from selenium.webdriver.common.by import By
        selectors = [
            ".virtual-match-result", ".m-result-item", ".result-table tr",
            ".virtual-result", "div[class*='result']", "table tbody tr",
            ".match-history-item", "[data-test*='result']"
        ]
        for sel in selectors:
            try:
                elems = driver.find_elements(By.CSS_SELECTOR, sel)
                if len(elems) > 2:
                    for el in elems[:20]:
                        text = el.text.strip()
                        if not text:
                            continue
                        # Parse "TeamA 2 - 1 TeamB"
                        import re
                        m = re.search(r'(.+?)\s+(\d+)\s*[-:]\s*(\d+)\s+(.+)', text)
                        if m:
                            home, hs, as_, away = m.group(1).strip(), int(m.group(2)), int(m.group(3)), m.group(4).strip()
                            key = f"{home}_{away}_{hs}_{as_}"
                            if key not in seen_set:
                                print(f"✅ SCRAPED: {home} {hs}-{as_} {away}")
                                self.db.insert_match(home, away, hs, as_, source="sportybet_stealth")
                                seen_set.add(key)
                    break
            except:
                continue

    def _parse_and_save(self, data):
        matches = []
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
            elif isinstance(data, list):
                matches = data
        except:
            pass

        for m in matches:
            try:
                home = m.get('homeTeamName') or m.get('homeTeam') or m.get('home') or m.get('team1Name')
                away = m.get('awayTeamName') or m.get('awayTeam') or m.get('away') or m.get('team2Name')
                hs = m.get('homeScore') or m.get('home_score')
                as_ = m.get('awayScore') or m.get('away_score')
                if hs is None:
                    s = m.get('score') or ""
                    if ':' in str(s):
                        hs, as_ = map(int, str(s).split(':'))
                if home and away and hs is not None:
                    print(f"✅ API RESULT: {home} {hs}-{as_} {away}")
                    self.db.insert_match(home, away, int(hs), int(as_), source="sportybet_real_api_bypass")
            except Exception as e:
                print(f"Parse skip: {e}")

    async def run_nodriver_mode(self):
        # Async nodriver mode - best for Cloudflare bypass
        import nodriver as nd
        browser = await nd.start(headless=self.headless, user_agent=self.get_random_user_agent())
        page = await browser.get(SPORTYBET_VIRTUAL_URL)
        print("[Nodriver] Page opened, waiting for Cloudflare...")
        await page.sleep(10)
        print(f"[Nodriver] Title: {await page.evaluate('document.title')}")
        print("Login manually, navigate to virtuals. Bot will sleep 60s...")
        await page.sleep(60)
        
        # Intercept requests via JS
        await page.evaluate("""
            // Same injection as browser connector
            const originalFetch = window.fetch;
            window.fetch = async function(...args) {
              const response = await originalFetch.apply(this, args);
              const url = args[0]?.toString() || "";
              if (url.includes("virtual")) console.log("FETCH VIRTUAL:", url);
              return response;
            }
        """)
        
        while True:
            await page.sleep(10)
            print(f"[{datetime.now()}] Nodriver alive, title: {await page.evaluate('document.title')}")

    def run(self):
        if self.method == "uc":
            self.run_uc_mode()
        elif self.method == "camoufox":
            if not HAS_CAMOUFOX:
                print("Installing camoufox... pip install camoufox")
                return
            driver = self.create_camoufox_driver()
            driver.get(SPORTYBET_VIRTUAL_URL)
            print("[Camoufox] Opened, login 60s...")
            time.sleep(60)
            while True:
                time.sleep(10)
        elif self.method == "nodriver":
            import asyncio
            asyncio.run(self.run_nodriver_mode())
        elif self.method == "all":
            # Try uc first, fallback to camoufox
            try:
                self.run_uc_mode()
            except Exception as e:
                print(f"UC failed {e}, trying camoufox...")
                try:
                    driver = self.create_camoufox_driver()
                    driver.get(SPORTYBET_VIRTUAL_URL)
                    time.sleep(99999)
                except Exception as e2:
                    print(f"All failed {e2}")

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--method", choices=["uc","camoufox","nodriver","all"], default="uc")
    parser.add_argument("--proxy", default=None, help="http://user:pass@host:port for residential proxy to bypass IP blocks")
    parser.add_argument("--headless", action="store_true")
    args = parser.parse_args()

    print(f"Installing deps if missing: pip install undetected-chromedriver selenium-stealth fake-useragent camoufox nodriver")
    
    collector = StealthCollector(method=args.method, proxy=args.proxy, headless=args.headless)
    collector.run()
