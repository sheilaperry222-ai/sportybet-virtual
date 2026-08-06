# Render.com Backend Deploy - Manual Steps (2 minutes)

Your Netlify + Supabase are LIVE:
- Netlify: https://sportybet-virtual-hjxbftocxaalmqewmlxe.netlify.app
- Supabase: https://hjxbftocxaalmqewmlxe.supabase.co (7 matches, triggers working)
- API (this sandbox): Port 8000 running with HybridDB

Now deploy Python FastAPI backend (heavy ML training - XGBoost) to Render.com free.

### Why Render needed?
- Netlify Functions = JS only, lightweight Poisson predictions, no XGBoost training
- Render Python API = Full ML training (RandomForest + XGBoost 300 trees), SQLite + Supabase Hybrid, `/train_all` endpoint
- You need both: Netlify = global dashboard CDN, Render = heavy brain

### Files already prepared:
- `render.yaml` → Blueprint with service `sportybet-virtual-api`, env vars for Supabase, region Frankfurt (closest to Lagos), free plan, health check `/`
- `Dockerfile` → For Docker deploy option
- `requirements.txt` → includes supabase, xgboost, sklearn, undetected-chromedriver, etc

### Step 1: Push to GitHub (1 minute)

On your PC, in project folder:

```bash
# Already git init done, just add remote (create repo first on github.com)
# Go to github.com -> New repository -> Name: sportybet-virtual -> Public -> Create (don't init with README)

git remote add origin https://github.com/YOUR_USERNAME/sportybet-virtual.git
git branch -M main
git add .
git commit -m "SportyBet virtual data center v2 + Supabase + Netlify + Render"
git push -u origin main
```

If you have GitHub CLI:
```bash
gh repo create sportybet-virtual --public --source=. --remote=origin --push
```

### Step 2: Deploy to Render via Blueprint (1 minute, one-click)

1. Go to https://dashboard.render.com → **New → Blueprint**
2. Click **Connect** GitHub → Select repo `sportybet-virtual`
3. Render auto-detects `render.yaml` → Shows 2 services:
   - `sportybet-virtual-api` (web) - FastAPI
   - `sportybet-retrain-daily` (cron) - daily retrain at 2 AM
4. Click **Apply**

Render will:
- Build: `pip install -r requirements.txt`
- Start: `uvicorn src.api.main:app --host 0.0.0.0 --port $PORT`
- Inject env vars from render.yaml:
  - `SUPABASE_URL=https://hjxbftocxaalmqewmlxe.supabase.co` (already set)
  - `SUPABASE_KEY=sb_publishable_RfPO3hS4...` (already set)

5. Go to Render dashboard → Service `sportybet-virtual-api` → **Environment** → Add:
   - `SUPABASE_SERVICE_KEY` = your `sb_secret_...` (from Supabase Dashboard > API Keys > Secret key)
   - Optional: `PROXY_URL` = `http://user:pass@host:port` (residential proxy for stealth collector)

6. Wait 3-5 mins build → You get URL like `https://sportybet-virtual-api.onrender.com`

Test:
- `https://your-api.onrender.com/` → should show API docs
- `https://your-api.onrender.com/stats` → should show 604 local + 7 Supabase = Hybrid
- `https://your-api.onrender.com/docs` → FastAPI Swagger

### Step 3: Connect Netlify Dashboard to Render API

In your Netlify site https://sportybet-virtual-hjxbftocxaalmqewmlxe.netlify.app, you want dashboard to call Render API, not just Netlify Functions.

Edit file `src/dashboard/index.html` (or `netlify-deploy/public/index.html`) line:
```js
const API = location.origin; // Change to Render
```
To:
```js
const API = "https://sportybet-virtual-api.onrender.com"; // Your Render URL
// Or keep Netlify functions for fast Poisson: const API = "https://sportybet-virtual-hjxbftocxaalmqewmlxe.netlify.app";
```

Best hybrid: Dashboard calls Render for training, Netlify functions for quick predictions:
- Train button → calls Render `/train_all`
- Predict → calls Netlify Functions (faster, no cold start) + Render for ML fallback

Push change to GitHub → Netlify auto-redeploys + Render auto-redeploys.

### Step 4: Stealth Collector -> Render + Supabase

Update Tampermonkey script `src/collector/browser_extension_connector.js` CONFIG:

```js
const CONFIG = {
  COLLECT_URL: "https://sportybet-virtual-api.onrender.com/collect", // Render Python API
  // Backup: "https://sportybet-virtual-hjxbftocxaalmqewmlxe.netlify.app/.netlify/functions/collect",
  SUPABASE_URL: "https://hjxbftocxaalmqewmlxe.supabase.co",
  SUPABASE_KEY: "sb_publishable_RfPO3hS4jVyc164y8zPZAw_MB5ThsyY",
};
```

Now: Chrome Tampermonkey → captures real SportyBet instant virtual → POSTs to Render API → Render saves to BOTH SQLite + Supabase → Netlify dashboard reads Supabase → Live everywhere.

### Step 5: Daily Heavy ML Retrain

Render cron `sportybet-retrain-daily` runs daily 2 AM Lagos:
- Fetches 5000 matches from Supabase
- Retrains XGBoost models
- Saves to `models/` (or you can upload to Supabase Storage)

Or manually trigger:
```bash
curl -X POST https://sportybet-virtual-api.onrender.com/train_all
```

### One-Click Deploy Button (for README)

Add to your GitHub README:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://dashboard.render.com/blueprint/new?repo=https://github.com/YOUR_USERNAME/sportybet-virtual)

### Troubleshooting Render

**Build fails OOM?** Free plan 512MB RAM may be tight for XGBoost. In `requirements.txt` you can comment out `xgboost` to use RandomForest only (lighter), or upgrade to Starter $7/mo.

**Cold start slow?** Render free sleeps after 15 mins inactivity. First request after sleep takes 30 sec. Keep alive via cron pinging `/` every 10 mins.

**Supabase not connecting?** Check env vars set in Render dashboard. Our HybridDB falls back to SQLite if Supabase fails, so API still runs.

**Bot detection blocked on Render?** Render IPs are datacenter, SportyBet will block them. That's why Tampermonkey in YOUR real Chrome (MTN IP) is mandatory for real results. Render collector with proxy `PROXY_URL` = Nigerian residential proxy (BrightData) can work.

### Done!

- Netlify: https://sportybet-virtual-hjxbftocxaalmqewmlxe.netlify.app ✅ LIVE
- Supabase: 7 matches, triggers working ✅ LIVE
- Render: After you push GitHub + Blueprint Apply → `https://sportybet-virtual-api.onrender.com` ✅ (manual step)
- Bypass: Tampermonkey stealth collector (undetectable) ✅ Ready

Your local PC can now be off, data persists in Supabase, dashboard global via Netlify, heavy training via Render.
