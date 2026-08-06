# STEPS TO MAKE IT WORK - Complete Guide (Lagos Local PC + Real SportyBet + Netlify)

You have 3 parts: Local Data Center, Real SportyBet Connection (stealth), Cloud Hosting (Netlify + Supabase)

Follow in order.

---

## PHASE 1: LOCAL DATA CENTER (Works offline, 10 mins)

### Step 1: Copy project to your PC
Download folder `/home/user/virtual-sports-predictor` (this entire project) to your PC, e.g., `C:\Users\YourName\virtual-sports-predictor` or `/home/user/virtual-sports-predictor`

### Step 2: Install Python & dependencies
- Install Python 3.10+ from python.org
- Open CMD/Terminal in project folder:

```bash
pip install -r requirements.txt
# Includes: fastapi, pandas, sklearn, selenium, undetected-chromedriver, selenium-stealth, supabase, etc
```

### Step 3: Generate fake data & train first model (to test)
```bash
# Create 1000 fake SportyBet virtual matches instantly
python -m src.collector.sportybet_collector --mode fake

# Train Correct Score + Over 2.5 + Under 1.5 models
python -m src.predictor.correct_score_predictor
python -m src.predictor.over_under_predictor
# Or via API later: curl -X POST http://localhost:8000/train_all
```

You now have SQLite DB at `data/virtual_sports.db` with 602+ matches.

### Step 4: Run local API + Dashboard
In Terminal 1:
```bash
python run.py
# Opens API at http://localhost:8000
# Dashboard at http://localhost:8000/dashboard
# API Docs at http://localhost:8000/docs
```

Open `http://localhost:8000/dashboard` in Chrome - you should see:
- Total Matches ~602, Over 2.5 17.7%, Under 1.5 56.4%, Avg Goals 1.41
- Predict button works: Man City vs Arsenal -> 0-0 69% + Over 2.5 9% + Under 1.5 69% STRONG

Keep this Terminal running.

---

## PHASE 2: REAL SPORTYBET INSTANT VIRTUAL CONNECTION (Bypass Bot Detection)

This is the critical part - SportyBet blocks normal bots via Cloudflare + DataDome.

We use **Tampermonkey** which runs inside YOUR real Chrome, so it's 100% undetectable (real fingerprint, real MTN IP, real session).

### Step 5: Install Tampermonkey
- Chrome -> Chrome Web Store -> Search "Tampermonkey" -> Add to Chrome -> Enable

### Step 6: Install stealth collector script
- In this project, open file `src/collector/browser_extension_connector.js`
- Copy ALL contents
- Chrome -> Puzzle icon -> Tampermonkey -> Dashboard -> Create a new script
- Delete default code, Paste our file, Edit CONFIG at top:
```js
const CONFIG = {
  COLLECT_URL: "http://localhost:8000/collect", // while testing local
  // COLLECT_URL: "https://your-site.netlify.app/.netlify/functions/collect", // later for cloud
  LOCAL_COLLECT_URL: "http://localhost:8000/collect",
  SUPABASE_URL: "", // leave empty for now
  SUPABASE_KEY: "",
  DEBUG: true,
};
```
- File -> Save (Ctrl+S)
- Make sure script is Enabled (switch ON)

### Step 7: Capture REAL SportyBet results
1. In same Chrome, go to https://www.sportybet.com/ng/virtual/ (or /ng/instant-virtuals/)
2. Login with your SportyBet account
3. Press F12 -> Console tab -> You should see: `🟢 [StealthCollector] Tampermonkey loaded - monitoring SportyBet virtual traffic`
4. Keep this tab open! Don't close. When next virtual round ends (every 30-90 sec for instant, every 3 mins for football league), you will see:
```
🎯 Fetch intercepted: .../virtual/results...
✅ REAL CAPTURE: Arsenal 2-1 Chelsea via https://...
Saved to backend: success
```
And a green toast at bottom-right: `🎯 Saved: Arsenal 2-1 Chelsea`

5. Check your dashboard `http://localhost:8000/dashboard` -> Recent Feed -> Should now show REAL SportyBet scores, not fake. Total Matches will increase.

**That's it! Your data center is now connected to REAL SportyBet Instant Virtual, bypassing bot detection because it runs inside your real browser.**

Alternative quick method (no Tampermonkey install):
- File `data/browser_connector.js` exists. Open it, copy all, paste in F12 Console on SportyBet virtual page, press Enter. Same effect but you must paste every time you refresh.

### Step 8: (Optional) Python stealth collector for 24/7 VPS
If you want collector running without keeping Chrome tab open:

```bash
pip install undetected-chromedriver selenium-stealth fake-useragent camoufox nodriver

# Method 1: Undetected Chromedriver (best)
python -m src.collector.stealth_bypass_collector --method uc

# Method 2: Firefox-based (if SportyBet blocks Chrome)
python -m src.collector.stealth_bypass_collector --method camoufox

# Method 3: Nodriver (bypasses Cloudflare Turnstile)
python -m src.collector.stealth_bypass_collector --method nodriver

# With residential proxy (if your IP gets banned)
python -m src.collector.stealth_bypass_collector --method uc --proxy http://user:pass@host:port
```

Login manually when browser opens, navigate to Instant Virtuals, bot auto-sniffs APIs and saves to DB.

For proxy: Buy Nigerian residential proxy from BrightData/SmartProxy (~$10/mo) - datacenter IPs from AWS get blocked. Add to `.env` as `PROXY_URL`.

---

## PHASE 3: CLOUD HOSTING - SUPABASE + NETLIFY (15 mins)

This makes dashboard accessible worldwide + data persists even when your PC off (NEPA outage).

### Step 9: Create Supabase (Free Postgres)

1. Go to https://supabase.com -> Sign up -> New Project
   - Name: `sportybet-virtual`
   - Password: set strong
   - Region: Europe or US (closest)
   - Free plan, wait 2 mins

2. In Supabase Dashboard -> SQL Editor -> New Query -> Copy ENTIRE contents of file `supabase_schema.sql` (in project root) -> Paste -> Run
   - Should create tables: `matches`, `team_stats`, `predictions` + triggers + views

3. Project Settings -> API -> Copy:
   - `Project URL`: e.g., `https://abcdefgh.supabase.co`
   - `anon public`: long JWT
   - `service_role`: secret (for backend)

4. Create `.env` file in project root (copy from `.env.example`):
```
SUPABASE_URL=https://abcdefgh.supabase.co
SUPABASE_KEY=your-anon-key
SUPABASE_SERVICE_KEY=your-service-role-key
```

5. Test locally:
```bash
python -m src.datacenter.supabase_client
# Should say Connected, or fallback to SQLite if env missing
python -c "from src.datacenter.supabase_client import HybridDB; db=HybridDB(); db.insert_match('Man City','Arsenal',2,1)"
```
Check Supabase -> Table Editor -> matches -> you see TestHome row.

Now your HybridDB writes to BOTH SQLite (local) and Supabase (cloud).

### Step 10: Host API on Render (Free, for Python heavy ML)

Netlify can't run Python training persistently, so host API separately:

1. Push your project to GitHub (create repo, push)
2. Go to https://render.com -> New -> Web Service -> Connect GitHub repo
3. Settings:
   - Build: `pip install -r requirements.txt`
   - Start: `uvicorn src.api.main:app --host 0.0.0.0 --port $PORT`
   - Environment: Add `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_SERVICE_KEY`
4. Deploy -> Copy URL: e.g., `https://your-api.onrender.com`
5. Test: `https://your-api.onrender.com/docs` should show FastAPI docs

### Step 11: Host Dashboard on Netlify (Free, Global CDN)

1. Go to https://app.netlify.com -> Add new site -> Import from GitHub -> Same repo
2. Build settings (already in `netlify.toml`):
   - Build command: (leave empty, taken from netlify.toml)
   - Publish directory: `netlify-deploy/public`
   - Functions directory: `netlify-deploy/functions`
3. Environment variables (Site Settings -> Environment):
   - `SUPABASE_URL` = same
   - `SUPABASE_KEY` = anon key
4. Deploy -> You get URL: `https://your-site.netlify.app`
5. Test functions:
   - `https://your-site.netlify.app/.netlify/functions/stats` -> should show Supabase stats (or demo if no creds)
   - `https://your-site.netlify.app/.netlify/functions/predict_all` POST -> predictions

### Step 12: Connect Everything (Tampermonkey -> Supabase -> Netlify)

Edit Tampermonkey script CONFIG (from Step 6) to cloud:

```js
const CONFIG = {
  COLLECT_URL: "https://your-site.netlify.app/.netlify/functions/collect",
  LOCAL_COLLECT_URL: "http://localhost:8000/collect",
  SUPABASE_URL: "https://abcdefgh.supabase.co",
  SUPABASE_KEY: "your-anon-key",
};
```
Save Tampermonkey script.

Also edit `netlify-deploy/public/index.html` (or `src/dashboard/index.html`):

Change line:
```js
const API = location.origin;
```
To:
```js
const API = "https://your-api.onrender.com"; // or Netlify functions URL
// Or use: const API = "https://your-site.netlify.app";
```

Push to GitHub -> Netlify auto-redeploys.

Now:
- Your Chrome Tampermonkey captures real SportyBet instant result -> POSTs to Netlify function `/collect` -> Saves to Supabase
- Your Netlify dashboard reads from Supabase via `/stats` function -> Shows REAL live data worldwide
- Predictions use real Supabase team_stats for accurate λ
- Even if your Local PC off, Supabase retains all, Netlify dashboard stays online

---

## PHASE 4: DAILY USAGE (Lagos Workflow)

**Morning (NEPA light on):**
1. Turn on PC, ensure Chrome with Tampermonkey still open on SportyBet virtual page (or reopen and paste `data/browser_connector.js` in console)
2. Run `python run.py` if using local API, or just rely on cloud (Netlify + Supabase)
3. Open your Netlify dashboard URL on phone: `https://your-site.netlify.app`

**During day:**
- Let it accumulate at least 500 real matches (takes ~1 day for instant virtual, ~3 days for football league 3-min cycle)
- Every evening, retrain: Click "Train ALL Models" in dashboard OR `curl -X POST https://your-api.onrender.com/train_all`

**Before betting on next round:**
1. Before round starts (30 sec window), your dashboard shows live feed of previous round
2. Enter upcoming fixtures in "Matchday Predictor" OR call API:
```bash
curl -X POST https://your-site.netlify.app/.netlify/functions/predict_all -H "Content-Type: application/json" -d '{"home_team":"Man City","away_team":"Arsenal"}'
```
Response:
```json
{
  "correct_score": {"predictions": [{"score":"1-0","prob":0.24}]},
  "over_under": {"ensemble": {"over_2.5":0.36,"under_1.5":0.36}, "recommendation": {"best_bet":"NO CLEAR EDGE"}}
}
```
3. Only bet if confidence >65% STRONG: e.g., Under 1.5 69.7% STRONG → bet Under 1.5

**Auto-start on boot (survive NEPA outage):**
- Windows: Task Scheduler -> Create Task -> Trigger At Startup -> Action: Start `pythonw.exe` with args `C:\...\run.py` and `C:\...\src\collector\stealth_bypass_collector.py --method uc`
- Or use laptop UPS

---

## TROUBLESHOOTING

**Getting SportyBet 40x / OOPS page?**
- Use Tampermonkey method, not Python - Tampermonkey never blocked (real browser)
- Don't use datacenter IP - use MTN/Glo IP or residential proxy
- Clear cookies, new Chrome profile, try camoufox: `python -m src.collector.stealth_bypass_collector --method camoufox`

**Supabase not saving?**
- Check SQL schema ran (tables exist)
- Check RLS policies in supabase_schema.sql created "Allow all for anon" - if not, run that part
- Check Netlify env vars SUPABASE_URL/KEY set
- Check Netlify Functions logs: Netlify -> Functions -> Logs

**Netlify dashboard shows fake 602 not real?**
- Means Supabase not connected - check env vars, redeploy with "Clear cache"
- Check Supabase Table Editor -> matches -> are real rows there? If not, Tampermonkey COLLECT_URL wrong

**Model accuracy low?**
- Need at least 500 real matches before training, not fake. Let collector run 1-2 days.
- Virtuals are RNG - expect Correct Score 8-12% hit, Over 2.5 ~60-75% since low scoring.

---

## QUICK COMMANDS CHEAT SHEET

```bash
# Local fake test
python -m src.collector.sportybet_collector --mode fake
python run.py # then open http://localhost:8000/dashboard

# Real capture - browser method (best bypass)
# 1. Generate JS
python -m src.collector.instant_virtual_real --mode js
# 2. Open sportybet.com/ng/virtual/, F12 Console, paste data/browser_connector.js

# Real capture - stealth Python (with bypass)
pip install undetected-chromedriver selenium-stealth fake-useragent camoufox nodriver
python -m src.collector.stealth_bypass_collector --method uc
python -m src.collector.stealth_bypass_collector --method camoufox --proxy http://user:pass@host:port

# Training
curl -X POST http://localhost:8000/train_all
# Or click Train ALL in dashboard

# Predictions
curl -X POST http://localhost:8000/predict_all -H "Content-Type: application/json" -d '{"home_team":"Man City","away_team":"Arsenal","top_n":3}'

# Supabase test
python -m src.datacenter.supabase_client

# Netlify local test (needs netlify-cli)
netlify dev
```

---

That's it. Follow PHASE 1 -> 2 -> 3 in order, you will have real SportyBet Instant Virtual data center bypassing bot detection, hosted on Netlify + Supabase, accessible worldwide from your phone in Lagos.
