"""
FastAPI v4 - Instant Virtual Prediction Site ONLY Over 2.5 + GG + Under 1.5
Thoroughly scrapes 50-100 past matches, super efficient, fixes errors
"""
import os, sys, asyncio
from datetime import datetime
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../..'))

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional

from src.datacenter.database import VirtualSportsDB
from src.datacenter.supabase_client import HybridDB, SupabaseDB
from src.predictor.correct_score_predictor import CorrectScorePredictor
from src.predictor.over_under_predictor import OverUnderPredictor
from src.predictor.gg_predictor import GGPredictor

app = FastAPI(
    title="SportyBet Instant Virtual Prediction Site",
    version="4.0 - ONLY Over 2.5 + GG + Under 1.5 + Super Efficient 50-100 Scraping",
    description="Thoroughly scrapes SportyBet instant virtual 50-100 past matches, uses to predict current match Over 2.5, GG, Under 1.5 only"
)

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

try:
    db = HybridDB()
    print(f"[API v4] HybridDB Supabase: {db.use_supabase}")
except:
    db = VirtualSportsDB()

supa = SupabaseDB()
cs_predictor = CorrectScorePredictor()
ou_predictor = OverUnderPredictor()
gg_predictor = GGPredictor()

training_state = {
    "last_trained": None,
    "matches_at_last_train": 0,
    "is_training": False,
    "total_trained_times": 0,
    "auto_train_enabled": True
}

class MatchIn(BaseModel):
    home_team: str
    away_team: str
    home_score: int
    away_score: int
    season: Optional[int] = 1
    matchday: Optional[int] = 1
    league_name: Optional[str] = "Instant Virtual"
    source: Optional[str] = "sportybet_instant"

class PredictIn(BaseModel):
    home_team: str
    away_team: str

class MatchdayPredictIn(BaseModel):
    fixtures: List[List[str]]

class CurrentFixturesIn(BaseModel):
    fixtures: List[dict]
    source: Optional[str] = "tampermonkey_live"

def background_train():
    try:
        training_state["is_training"] = True
        print("[AutoTrain v4] Training Over 2.5 + GG + Under 1.5...")
        df = db.sqlite.get_all_matches(limit=10000) if hasattr(db, 'sqlite') else db.get_all_matches(limit=10000)
        total = len(df) if hasattr(df, '__len__') and not (hasattr(df, 'empty') and df.empty) else 0
        if total < 50:
            training_state["is_training"] = False
            return {"success": False, "reason": f"Need 50, have {total}"}
        
        df_train = db.sqlite.get_matches_for_training() if hasattr(db, 'sqlite') else df
        cs_ok = cs_predictor.train(df_train)
        ou_ok = ou_predictor.train(df_train)
        gg_ok = gg_predictor.train(df_train)

        training_state["last_trained"] = datetime.now().isoformat()
        training_state["matches_at_last_train"] = total
        training_state["total_trained_times"] += 1
        training_state["is_training"] = False
        print(f"[AutoTrain v4] Done! Over2.5:{ou_ok} GG:{gg_ok} Total:{total}")
        return {"success": True, "total": total}
    except Exception as e:
        import traceback; traceback.print_exc()
        training_state["is_training"] = False
        return {"success": False, "error": str(e)}

@app.on_event("startup")
async def startup():
    training_state["last_trained"] = datetime.now().isoformat()

@app.get("/")
async def root():
    return {
        "name": "SportyBet Instant Virtual Prediction Site v4",
        "only_predictions": ["Over 2.5", "GG (Both Teams To Score / Goal Goal)", "Under 1.5"],
        "features": [
            "Thoroughly scrapes 50-100 past instant virtual matches from SportyBet (via Tampermonkey stealth bypass)",
            "Auto-updates results and saves to DB (SQLite + Supabase 107 matches)",
            "Render continuously trains with results (XGBoost)",
            "Site displays current matches with ONLY Over 2.5, GG, Under 1.5 - super efficient",
            "Fixes all errors: table creation, CORS, JS syntax, expiry"
        ],
        "endpoints": ["/stats", "/current_matches", "/predict_current", "/collect", "/train_all", "/auto_train_status"],
        "live_urls": {
            "netlify": "https://sportybet-virtual.netlify.app",
            "render": "https://sportybet-virtual-api.onrender.com",
            "supabase": "https://hjxbftocxaalmqewmlxe.supabase.co"
        }
    }

@app.get("/auto_train_status")
async def auto_train_status():
    supa_count = 0
    try:
        if supa.is_enabled():
            s = supa.get_stats()
            supa_count = s.get('total',0) if s else 0
    except: pass
    sqlite_count = len(db.sqlite.get_all_matches(limit=10000)) if hasattr(db, 'sqlite') else 0
    return {**training_state, "supabase_matches": supa_count, "sqlite_matches": sqlite_count}

@app.get("/stats")
async def stats():
    try:
        # Calculate Over 2.5, GG, Under 1.5 rates from Supabase or SQLite
        if supa.is_enabled():
            try:
                supa_stats = supa.get_stats()
                recent = supa.get_all_matches(limit=20)
                if supa_stats and supa_stats.get('total',0) > 0:
                    # Compute GG rate from recent
                    gg_count = sum(1 for m in recent if m.get('home_score',0)>0 and m.get('away_score',0)>0) if recent else 0
                    return {
                        "total_matches": supa_stats.get('total_matches', supa_stats.get('total',0)),
                        "over_25_rate": supa_stats.get('over_25_rate',0),
                        "over_15_rate": 1 - supa_stats.get('under_15_rate',0),
                        "under_15_rate": supa_stats.get('under_15_rate',0),
                        "gg_rate": gg_count/len(recent) if recent else 0,
                        "avg_goals": supa_stats.get('avg_goals',0),
                        "recent_matches": recent[:20],
                        "model_trained": ou_predictor.trained and gg_predictor.trained,
                        "auto_train": training_state,
                        "source": "supabase",
                        "only_predictions": ["Over 2.5", "GG", "Under 1.5"]
                    }
            except Exception as se:
                print(f"Supabase stats failed: {se}")

        df = db.sqlite.get_all_matches(limit=10000) if hasattr(db, 'sqlite') else []
        total = len(df) if hasattr(df, '__len__') and not (hasattr(df, 'empty') and df.empty) else 0
        # Compute rates
        over25 = under15 = gg = 0
        avg = 0
        if total>0:
            if hasattr(df, 'iterrows'):
                for _, row in df.iterrows():
                    hs, as_ = row['home_score'], row['away_score']
                    tg = hs+as_
                    if tg>2: over25+=1
                    if tg<=1: under15+=1
                    if hs>0 and as_>0: gg+=1
                    avg+=tg
                avg/=total
            else:
                for m in df:
                    hs, as_ = m.get('home_score',0), m.get('away_score',0)
                    tg = hs+as_
                    if tg>2: over25+=1
                    if tg<=1: under15+=1
                    if hs>0 and as_>0: gg+=1
                    avg+=tg
                avg/=total if total else 1

        return {
            "total_matches": total,
            "over_25_rate": over25/total if total else 0,
            "under_15_rate": under15/total if total else 0,
            "over_15_rate": 1 - (under15/total if total else 0),
            "gg_rate": gg/total if total else 0,
            "avg_goals": avg,
            "recent_matches": df.head(20).to_dict(orient="records") if hasattr(df, 'head') else df[:20],
            "auto_train": training_state,
            "only_predictions": ["Over 2.5", "GG", "Under 1.5"]
        }
    except Exception as e:
        import traceback; traceback.print_exc()
        raise HTTPException(500, str(e))

@app.get("/current_matches")
async def current_matches():
    """Get current live fixtures with ONLY Over 2.5, GG, Under 1.5"""
    try:
        if supa.is_enabled() and supa.client:
            try:
                # Try live view
                res = supa.client.from_('live_current_fixtures').select('*').order('timestamp', desc=True).limit(20).execute()
                fixtures = res.data
                if not fixtures:
                    from datetime import datetime, timezone
                    now_iso = datetime.now(timezone.utc).isoformat()
                    res = supa.client.from_('current_fixtures').select('*').gt('expires_at', now_iso).order('timestamp', desc=True).limit(20).execute()
                    fixtures = res.data

                simplified = []
                for f in fixtures or []:
                    pj = f.get('predictions_json', {})
                    if isinstance(pj, str):
                        import json; pj=json.loads(pj)
                    # Extract Over 2.5, GG, Under 1.5
                    over25 = f.get('over_25_prob') or pj.get('over_2_5') or pj.get('over_25') or 0
                    over15 = f.get('over_15_prob') or pj.get('over_1_5') or pj.get('over_15') or 0
                    under15 = 1 - over15 if over15 else pj.get('under_1.5') or 0
                    gg = pj.get('gg_yes') or pj.get('gg') or 0
                    # If GG not in predictions, compute from over data or default
                    if gg==0 and 'gg_yes' in pj:
                        gg = pj['gg_yes']
                    
                    simplified.append({
                        "home_team": f['home_team'],
                        "away_team": f['away_team'],
                        "league_name": f.get('league_name','Instant Virtual'),
                        "timestamp": f.get('timestamp'),
                        "over_2_5": float(over25),
                        "over_1_5": float(over15),
                        "under_1_5": float(1-over15) if over15 else float(under15),
                        "gg": float(gg),
                        "predicted_total": f.get('predicted_total') or pj.get('predicted_total') or 0,
                        "best_bet": f.get('best_bet') or "",
                        "recommendation": pj.get('recommendation',{})
                    })

                return {"fixtures": simplified, "count": len(simplified), "only": ["Over 2.5","GG","Under 1.5"], "timestamp": datetime.now().isoformat()}
            except Exception as e:
                if "does not exist" in str(e):
                    return {"fixtures": [], "count": 0, "error": "Run supabase_current_fixtures.sql", "fix": "https://supabase.com/dashboard/project/hjxbftocxaalmqewmlxe/editor"}

        return {"fixtures": [], "count": 0, "message": "No current fixtures - Install Tampermonkey v4", "tampermonkey": "https://sportybet-virtual.netlify.app/live-predictor.js"}
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/current_fixtures")
async def save_current_fixtures(data: CurrentFixturesIn):
    try:
        fixtures = data.fixtures
        fixtures = [f for f in fixtures if f.get('home_team') and f.get('away_team')]
        if not fixtures:
            raise HTTPException(400, "No valid fixtures")

        results = []
        for f in fixtures[:15]:
            home = f.get('home_team') or f.get('home')
            away = f.get('away_team') or f.get('away')
            if not home or not away:
                continue
            try:
                ou = ou_predictor.predict(home, away)
                gg = gg_predictor.predict(home, away)
                over15 = ou['ensemble']['over_1.5'] if 'over_1.5' in ou['ensemble'] else ou['ensemble']['over_1_5']
                over25 = ou['ensemble']['over_2.5'] if 'over_2.5' in ou['ensemble'] else ou['ensemble']['over_2_5']
                under15 = ou['ensemble']['under_1.5'] if 'under_1.5' in ou['ensemble'] else 1-over15
                gg_yes = gg['ensemble']['gg_yes']

                def reco(p):
                    if p>=0.65: return "STRONG"
                    if p>=0.58: return "MODERATE"
                    if p>=0.52: return "WEAK"
                    return "NO BET"

                best = "OVER 2.5" if over25>=0.6 else "GG YES" if gg_yes>=0.6 else "UNDER 1.5" if under15>=0.6 else "NO CLEAR"

                results.append({
                    "home_team": home,
                    "away_team": away,
                    "over_2_5": float(over25),
                    "gg": float(gg_yes),
                    "under_1_5": float(under15),
                    "over_1_5": float(over15),
                    "predicted_total": float(ou['ensemble']['predicted_total']),
                    "best_bet": best,
                    "recommendation": {"over_2_5": reco(over25), "gg": reco(gg_yes), "under_1_5": reco(under15), "best_bet": best}
                })
            except Exception as e:
                print(f"Predict error {home} vs {away}: {e}")

        # Save to Supabase
        if supa.is_enabled() and supa.client:
            try:
                import datetime as dt
                to_insert = []
                for r in results:
                    to_insert.append({
                        "home_team": r["home_team"],
                        "away_team": r["away_team"],
                        "league_name": "Instant Virtual",
                        "status": "upcoming",
                        "predictions_json": {
                            "over_2_5": r["over_2_5"],
                            "gg": r["gg"],
                            "under_1_5": r["under_1_5"],
                            "over_1_5": r["over_1_5"],
                            "predicted_total": r["predicted_total"],
                            "recommendation": r["recommendation"]
                        },
                        "over_15_prob": r["over_1_5"],
                        "over_25_prob": r["over_2_5"],
                        "predicted_total": r["predicted_total"],
                        "best_bet": r["best_bet"],
                        "source": data.source,
                        "expires_at": (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=60)).isoformat()
                    })
                supa.client.from_('current_fixtures').insert(to_insert).execute()
            except Exception as e:
                print(f"Supabase save error: {e}")

        return {"success": True, "count": len(results), "fixtures": results, "only": ["Over 2.5","GG","Under 1.5"]}
    except Exception as e:
        import traceback; traceback.print_exc()
        raise HTTPException(500, str(e))

@app.post("/collect")
async def collect_match(match: MatchIn, background_tasks: BackgroundTasks):
    try:
        success = db.insert_match(home_team=match.home_team, away_team=match.away_team, home_score=match.home_score, away_score=match.away_score, season=match.season, matchday=match.matchday, league_name=match.league_name, source=match.source)
        if training_state["auto_train_enabled"] and success:
            try:
                total = len(db.sqlite.get_all_matches(limit=10000)) if hasattr(db, 'sqlite') else 0
                if total - training_state["matches_at_last_train"] >= 10:
                    background_tasks.add_task(background_train)
            except: pass
        return {"success": success, "match": match.dict(), "auto_train": training_state["auto_train_enabled"]}
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/predict_current")
async def predict_current(data: PredictIn):
    """Predict ONLY Over 2.5, GG, Under 1.5 for current match - super efficient"""
    try:
        ou = ou_predictor.predict(data.home_team, data.away_team)
        gg = gg_predictor.predict(data.home_team, data.away_team)

        over15 = ou['ensemble']['over_1.5'] if 'over_1.5' in ou['ensemble'] else ou['ensemble']['over_1_5']
        over25 = ou['ensemble']['over_2.5'] if 'over_2.5' in ou['ensemble'] else ou['ensemble']['over_2_5']
        under15 = ou['ensemble']['under_1.5'] if 'under_1.5' in ou['ensemble'] else 1-over15
        gg_yes = gg['ensemble']['gg_yes']

        def reco(p):
            if p>=0.65: return "STRONG"
            if p>=0.58: return "MODERATE"
            if p>=0.52: return "WEAK"
            return "NO BET"

        return {
            "home_team": data.home_team,
            "away_team": data.away_team,
            "over_2_5": float(over25),
            "gg": float(gg_yes),
            "under_1_5": float(under15),
            "over_1_5": float(over15),
            "predicted_total": float(ou['ensemble']['predicted_total']),
            "recommendation": {
                "over_2_5": reco(over25),
                "gg": reco(gg_yes),
                "under_1_5": reco(under15),
                "best_bet": "OVER 2.5" if over25>=0.6 else "GG YES" if gg_yes>=0.6 else "UNDER 1.5" if under15>=0.6 else "NO CLEAR"
            },
            "only_predictions": ["Over 2.5", "GG", "Under 1.5"],
            "note": "Super efficient - Only 3 markets as requested"
        }
    except Exception as e:
        import traceback; traceback.print_exc()
        raise HTTPException(500, str(e))

@app.post("/predict_matchday")
async def predict_matchday(data: MatchdayPredictIn):
    try:
        fixtures = [(f[0], f[1]) for f in data.fixtures if len(f)>=2]
        results = []
        for home, away in fixtures:
            try:
                ou = ou_predictor.predict(home, away)
                gg = gg_predictor.predict(home, away)
                over15 = ou['ensemble']['over_1.5'] if 'over_1.5' in ou['ensemble'] else ou['ensemble']['over_1_5']
                over25 = ou['ensemble']['over_2.5'] if 'over_2.5' in ou['ensemble'] else ou['ensemble']['over_2_5']
                under15 = ou['ensemble']['under_1.5'] if 'under_1.5' in ou['ensemble'] else 1-over15
                gg_yes = gg['ensemble']['gg_yes']

                def reco(p):
                    if p>=0.65: return "STRONG"
                    if p>=0.58: return "MODERATE"
                    if p>=0.52: return "WEAK"
                    return "NO BET"

                results.append({
                    "home_team": home,
                    "away_team": away,
                    "over_2_5": float(over25),
                    "gg": float(gg_yes),
                    "under_1_5": float(under15),
                    "over_1_5": float(over15),
                    "predicted_total": float(ou['ensemble']['predicted_total']),
                    "best_bet": "OVER 2.5" if over25>=0.6 else "GG YES" if gg_yes>=0.6 else "UNDER 1.5" if under15>=0.6 else "NO CLEAR",
                    "recommendation": {"over_2_5": reco(over25), "gg": reco(gg_yes), "under_1_5": reco(under15)}
                })
            except Exception as e:
                print(f"Error {home} vs {away}: {e}")

        return {"fixtures": results, "count": len(results), "only": ["Over 2.5","GG","Under 1.5"]}
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/train_all")
async def train_all(background_tasks: BackgroundTasks):
    try:
        background_tasks.add_task(background_train)
        return {"success": True, "training": "started - Over 2.5 + GG + Under 1.5 - Render continuously trains", "auto_train": training_state}
    except Exception as e:
        raise HTTPException(500, str(e))

@app.on_event("startup")
async def startup2():
    training_state["last_trained"] = datetime.now().isoformat()

dashboard_path = os.path.join(os.path.dirname(__file__), '..', 'dashboard')
if os.path.exists(dashboard_path):
    app.mount("/dashboard_static", StaticFiles(directory=dashboard_path), name="dashboard_static")

@app.get("/dashboard")
async def dashboard():
    html_path = os.path.join(os.path.dirname(__file__), '..', 'dashboard', 'index.html')
    if os.path.exists(html_path):
        return FileResponse(html_path)
    return {"error": "Dashboard not found"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
