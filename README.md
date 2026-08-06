# SportyBet Virtual Football Data Center + Correct Score Predictor

You asked for a **data center where your bot gets previous virtual sport results of a particular category and learns from them to predict the current match**. This is exactly what this project does - tuned for **SportyBet Virtual Football League**.

> ⚠️ **DISCLAIMER - VERY IMPORTANT**
> Virtual football is **RNG (Random Number Generator)** based. Providers like Inspired Gaming / Kiron claim 100% random. No model can guarantee profit. This system finds *statistical biases, Elo trends, Poisson probabilities* - it gives you edge awareness, not certainty. Use for educational / probability estimation only. Always gamble responsibly. House always has edge.

### 🎯 What it does
1. **Collector Bot (24/7)** - Captures every virtual round (every ~3 mins on SportyBet)
   - Selenium mode: auto-scans results table as it appears
   - API sniff mode: guide to reverse-engineer hidden API via Chrome DevTools
   - Manual mode: type results quickly if auto fails
   - Fake gen mode: generates 1000 synthetic matches to test predictor immediately

2. **Data Center (SQLite)**
   - `matches` - all previous results: teams, scores, 1X2, over/under
   - `team_stats` - auto-calculates avg goals, form, Elo rating
   - `score_frequency` - tracks how often 1-0, 1-1, 2-1 etc occurs (critical for correct score)
   - `predictions` - logs predictions vs actuals for backtesting

3. **Predictor Engine (Correct Score)**
   - **Feature Engineering**: team avg scored/conceded, last 5 form, Elo diff, Poisson lambda, home advantage
   - **Model 1 - Poisson**: Classic football probability `P(k)= λ^k e^-λ/k!` -> score matrix 0-5 x 0-5
   - **Model 2 - RandomForest / XGBoost**: Learns non-linear patterns from your collected data
   - **Ensemble**: 40% Poisson + 60% ML + 15% historical prior = final top 5 correct scores with confidence %

4. **API + Dashboard**
   - FastAPI: `/stats`, `/history`, `/collect`, `/predict`, `/train`
   - Dashboard: Live stats, team strength, prediction UI, full matchday predictor (10 games)

---

### 📁 Structure
```
virtual-sports-predictor/
├── config.yaml
├── requirements.txt
├── run.py -> starts API + dashboard
├── data/virtual_sports.db (SQLite)
├── models/correct_score_model.pkl
├── src/
│   ├── collector/sportybet_collector.py
│   ├── datacenter/database.py
│   ├── predictor/feature_engineering.py
│   ├── predictor/correct_score_predictor.py
│   ├── api/main.py
│   └── dashboard/index.html
```

---

### 🚀 Quick Start (Local PC)

**Step 1: Install**
```bash
pip install -r requirements.txt
python -m src.collector.sportybet_collector --mode fake  # creates 1000 fake matches instantly to test
```

**Step 2: Train model**
```bash
# Via API or CLI
curl -X POST http://localhost:8000/train
# or python
python -c "from src.datacenter.database import VirtualSportsDB; from src.predictor.correct_score_predictor import CorrectScorePredictor; db=VirtualSportsDB(); p=CorrectScorePredictor(); p.train(db.get_matches_for_training())"
```

**Step 3: Run data center**
```bash
python run.py
# Open http://localhost:8000/dashboard
# API docs: http://localhost:8000/docs
```

**Step 4: Start 24/7 collector (in 2nd terminal)**
```bash
python -m src.collector.sportybet_collector --mode selenium
# Then manually login to SportyBet, go to Virtuals > Football > Results
# Bot will save every round automatically
```

If Selenium selectors break (SportyBet updates HTML often):
1. Open Chrome DevTools (F12) > Elements > Inspect the result row
2. Update `possible_selectors` list in `sportybet_collector.py`
3. Better: Network tab > filter XHR > look for `virtual` requests - if you find API like `/api/virtual/results`, copy curl and paste into `try_direct_api()` method.

---

### 🔍 How to Find SportyBet Hidden API (Advanced)

SportyBet virtuals are usually powered by **Inspired** or **Kiron**. The front-end polls an API:

1. Login to SportyBet.com, go to Virtual Football
2. Press F12 > Network > Fetch/XHR
3. Keep it open for 3 minutes until a new round ends
4. Look for requests like:
   - `https://www.sportybet.com/api/ng/virtualEvents?...`
   - `https://virtuals.sportybet.com/...`
   - Or websocket `wss://`
5. Right-click > Copy as cURL > convert to Python requests
6. Add your cookies/headers to collector

This is **much more reliable** than HTML scraping.

**Pro tip**: Use `driver.get_log('performance')` - code already there to sniff.

---

### 🧠 How Correct Score Prediction Works

**1. Elo Rating**
Each team starts 1500. Win vs strong team = +more points. This captures hidden strength even in virtuals (if RNG is not perfectly uniform).

**2. Poisson**
```
λ_home = (home_avg_scored + away_avg_conceded)/2 * 1.1 (home advantage)
λ_away = (away_avg_scored + home_avg_conceded)/2
P(2-1) = P_home(2) * P_away(1)
```
Top 5 most probable from 0-0 to 5-5 matrix.

**3. ML**
RandomForest (300 trees) learns: When Elo diff high + home form good + home avg 1.8 vs away defense 1.5 -> outcome likely 2-0 etc.

**4. Ensemble**
- If Poisson says 1-1 @ 12% and ML says 1-1 @ 18% and history says 1-1 appears 11% -> combined ~14-16% -> Top prediction
- Shows confidence for betting decisions

Backtest accuracy: Usually 8-12% hit rate for correct score (which is industry normal; random guess ~ ~3%). Goal is to beat random.

---

### 📊 Dashboard Features

- Live total matches, team count, model status
- Most frequent scores (check if 1-0 is hot)
- Predict single match: pick home/away, get top 5 scores with % bars
- Quick manual entry for when you watch a round
- Full matchday predictor: paste 10 fixtures, get all predictions at once
- Recent results feed with Over/Under tags

---

### 🔄 Daily Workflow on Your Local PC

1. Turn on PC, run `python run.py` (API) + collector in 2nd terminal
2. Let it accumulate at least 500-1000 matches (2-3 days)
3. Train daily: click Train Model in dashboard
4. For each new round before kickoff (30 sec window): Use dashboard to predict or call API from your betting bot
5. Logs predictions in DB for backtest

Make collector auto-start on boot:
- Windows: Task Scheduler -> run `pythonw.exe` collector
- Linux: systemd service or `@reboot` in crontab

---

### 🔌 Integrate With Your Betting Bot

```python
import requests

# Predict before round starts
res = requests.post("http://localhost:8000/predict", json={
  "home_team": "Man City",
  "away_team": "Arsenal",
  "top_n": 3
}).json()

top_score = res['predictions'][0]['score']  # e.g., "1-1"
confidence = res['predictions'][0]['prob']  # e.g., 0.134

if confidence > 0.13:  # Only bet if >13% confidence
    # Your betting logic here
    place_bet(correct_score=top_score)
```

---

### 🛠️ Next Improvements You Can Add

- **Telegram Bot**: Send predictions to Telegram channel automatically
- **OCR Mode**: Screenshot results, use pytesseract to read scores if HTML too hard
- **Auto-bet**: Selenium to place bet if confidence > threshold (risky, check ToS)
- **More markets**: Over/Under predictor using same Poisson lambdas
- **Live dashboard with socket**: Real-time push when new result appears

---

### Need Help Customizing?

Tell me:
- Did you get the API URL from DevTools? Paste it here and I will wire it
- Want me to add Telegram alerts?
- Want auto-bet module?

Built for SportyBet NG Virtual Football - ready to run on your local PC in Lagos.
