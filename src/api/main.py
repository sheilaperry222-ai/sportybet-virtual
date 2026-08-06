"""
FastAPI - Data Center API
Exposes /collect, /train, /predict, /stats, /history
"""
import os
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../..'))

from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
import pandas as pd

from src.datacenter.database import VirtualSportsDB
from src.datacenter.supabase_client import HybridDB, SupabaseDB
from src.predictor.correct_score_predictor import CorrectScorePredictor
from src.predictor.over_under_predictor import OverUnderPredictor

app = FastAPI(
    title="SportyBet Virtual Football Data Center",
    version="2.0.0",
    description="Data center that collects previous virtual results and predicts correct scores + Over 2.5 + Under 1.5 - Supabase + Stealth Bypass Ready"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Use Hybrid DB: SQLite locally + Supabase cloud (your project hjxbftocxaalmqewmlxe)
try:
    db = HybridDB()
    print(f"[API] Using HybridDB - Supabase enabled: {db.use_supabase}")
except:
    db = VirtualSportsDB()
    print("[API] Using SQLite fallback")

# Supabase direct for stats
supa = SupabaseDB()

predictor = CorrectScorePredictor()
ou_predictor = OverUnderPredictor()

# Pydantic models
class MatchIn(BaseModel):
    home_team: str
    away_team: str
    home_score: int
    away_score: int
    season: Optional[int] = 1
    matchday: Optional[int] = 1

class PredictIn(BaseModel):
    home_team: str
    away_team: str
    top_n: Optional[int] = 5

class MatchdayPredictIn(BaseModel):
    fixtures: List[List[str]]  # [[home, away], [home, away]]
    top_n: Optional[int] = 3

@app.get("/")
async def root():
    return {
        "name": "SportyBet Virtual Data Center",
        "version": "2.0 - Now with Over 2.5 and Under 1.5",
        "status": "running",
        "endpoints": ["/stats", "/history", "/predict", "/predict_over_under", "/predict_all", "/train", "/train_all", "/collect", "/dashboard"],
        "note": "Virtual sports are RNG-based. Predictions are probability estimates, not guarantees."
    }

@app.get("/stats")
async def stats():
    try:
        # Try Supabase first for real stats
        if supa.is_enabled():
            try:
                supa_stats = supa.get_stats()
                score_freq = supa.get_score_frequency(limit=10)
                recent = supa.get_all_matches(limit=20)
                if supa_stats and supa_stats.get('total',0) > 0:
                    return {
                        "total_matches": supa_stats.get('total_matches', supa_stats.get('total',0)),
                        "unique_teams": 20,
                        "unique_scores": len(score_freq),
                        "over_25_rate": supa_stats.get('over_25_rate',0),
                        "under_15_rate": supa_stats.get('under_15_rate',0),
                        "avg_goals": supa_stats.get('avg_goals',0),
                        "most_common_scores": score_freq,
                        "team_stats": [],  # Will be fetched via Supabase team_stats view in frontend
                        "recent_matches": recent[:20] if isinstance(recent, list) else recent,
                        "model_trained": predictor.trained,
                        "ou_model_trained": ou_predictor.trained,
                        "source": "supabase_hjxbftocxaalmqewmlxe",
                        "supabase_connected": True
                    }
            except Exception as se:
                print(f"[Stats] Supabase failed, fallback to SQLite: {se}")

        # Fallback SQLite
        matches_df = db.sqlite.get_all_matches(limit=10000) if hasattr(db, 'sqlite') else db.get_all_matches(limit=10000)
        team_stats = db.sqlite.get_team_stats() if hasattr(db, 'sqlite') else db.get_team_stats()
        score_dist = db.sqlite.get_score_distribution() if hasattr(db, 'sqlite') else db.get_score_distribution()

        over25_count = 0
        under15_count = 0
        avg_goals = 0
        if hasattr(matches_df, 'empty'):
            if not matches_df.empty:
                over25_count = (matches_df['total_goals'] > 2).sum()
                under15_count = (matches_df['total_goals'] <= 1).sum()
                avg_goals = matches_df['total_goals'].mean()
        else:
            # list from supabase hybrid
            if matches_df:
                over25_count = sum(1 for m in matches_df if (m.get('total_goals',0) or m['home_score']+m['away_score']) > 2)
                under15_count = sum(1 for m in matches_df if (m.get('total_goals',0) or m['home_score']+m['away_score']) <= 1)
                avg_goals = sum(m.get('total_goals',0) or m['home_score']+m['away_score'] for m in matches_df) / len(matches_df)

        if hasattr(matches_df, 'to_dict'):
            recent_dict = matches_df.head(20).to_dict(orient="records")
            total = len(matches_df)
        else:
            recent_dict = matches_df[:20] if isinstance(matches_df, list) else []
            total = len(matches_df) if isinstance(matches_df, list) else 0

        return {
            "total_matches": total,
            "unique_teams": team_stats.shape[0] if hasattr(team_stats, 'shape') else len(team_stats) if team_stats else 0,
            "unique_scores": score_dist.shape[0] if hasattr(score_dist, 'shape') else len(score_dist),
            "over_25_rate": float(over25_count / total) if total>0 else 0,
            "under_15_rate": float(under15_count / total) if total>0 else 0,
            "avg_goals": float(avg_goals),
            "most_common_scores": score_dist.head(10).to_dict(orient="records") if hasattr(score_dist, 'head') else score_dist,
            "team_stats": team_stats.head(20).to_dict(orient="records") if hasattr(team_stats, 'head') else team_stats,
            "recent_matches": recent_dict,
            "model_trained": predictor.trained,
            "ou_model_trained": ou_predictor.trained,
            "source": "sqlite_fallback"
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(500, str(e))

@app.get("/history")
async def history(limit: int = 100, team: Optional[str] = None):
    try:
        df = db.get_all_matches(limit=limit*2)
        if team:
            df = df[(df['home_team']==team) | (df['away_team']==team)]
        df = df.head(limit)
        return df.to_dict(orient="records")
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/collect")
async def collect_match(match: MatchIn):
    try:
        success = db.insert_match(
            home_team=match.home_team,
            away_team=match.away_team,
            home_score=match.home_score,
            away_score=match.away_score,
            season=match.season,
            matchday=match.matchday
        )
        return {"success": success, "match": match.dict()}
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/predict")
async def predict_score(data: PredictIn):
    try:
        result = predictor.predict(data.home_team, data.away_team, top_n=data.top_n)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/predict_over_under")
async def predict_over_under(data: PredictIn):
    try:
        result = ou_predictor.predict(data.home_team, data.away_team)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/predict_all")
async def predict_all(data: PredictIn):
    """Combined endpoint: Correct Score + Over 2.5 + Under 1.5 in one call"""
    try:
        cs = predictor.predict(data.home_team, data.away_team, top_n=data.top_n)
        ou = ou_predictor.predict(data.home_team, data.away_team)
        return {
            "home_team": data.home_team,
            "away_team": data.away_team,
            "correct_score": cs,
            "over_under": ou,
            "summary": {
                "top_correct_score": cs['predictions'][0] if cs.get('predictions') else None,
                "over_2_5_prob": ou['ensemble']['over_2.5'],
                "under_1_5_prob": ou['ensemble']['under_1.5'],
                "predicted_total_goals": ou['ensemble']['predicted_total'],
                "recommendation": ou['recommendation']
            }
        }
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/predict_matchday")
async def predict_matchday(data: MatchdayPredictIn):
    try:
        fixtures = [(f[0], f[1]) for f in data.fixtures if len(f)>=2]
        results = predictor.predict_matchday(fixtures)
        # Enrich with OU
        enriched = []
        for r in results:
            r['predictions'] = r['predictions'][:data.top_n]
            try:
                ou = ou_predictor.predict(r['home_team'], r['away_team'])
                r['over_under'] = ou['ensemble']
                r['ou_recommendation'] = ou['recommendation']
            except:
                r['over_under'] = None
            enriched.append(r)
        return {"fixtures": enriched, "count": len(enriched)}
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/train")
async def train_model():
    try:
        df = db.get_matches_for_training()
        if len(df) < 50:
            return JSONResponse(status_code=400, content={"error": f"Not enough data: {len(df)} matches, need at least 50. Collect more via collector or /collect endpoint"})
        
        success = predictor.train(df)
        if success:
            return {"success": True, "matches_used": len(df), "model_trained": predictor.trained}
        else:
            return JSONResponse(status_code=500, content={"error": "Training failed"})
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/train_all")
async def train_all():
    """Train both Correct Score and Over/Under models"""
    try:
        df = db.get_matches_for_training()
        if len(df) < 50:
            return JSONResponse(status_code=400, content={"error": f"Not enough data: {len(df)}"})
        
        cs_ok = predictor.train(df)
        ou_ok = ou_predictor.train(df)

        return {
            "success": cs_ok and ou_ok,
            "matches_used": len(df),
            "correct_score_trained": predictor.trained,
            "over_under_trained": ou_predictor.trained
        }
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/train_over_under")
async def train_over_under():
    try:
        df = db.get_matches_for_training()
        if len(df) < 50:
            return JSONResponse(status_code=400, content={"error": f"Not enough data: {len(df)}"})
        ok = ou_predictor.train(df)
        return {"success": ok, "matches_used": len(df), "trained": ou_predictor.trained}
    except Exception as e:
        raise HTTPException(500, str(e))

@app.delete("/wipe")
async def wipe_data(confirm: str = ""):
    if confirm != "YES":
        return {"error": "Send ?confirm=YES to wipe"}
    db.wipe()
    return {"success": True, "message": "All data wiped"}

# Serve dashboard
dashboard_path = os.path.join(os.path.dirname(__file__), '..', 'dashboard')
if os.path.exists(dashboard_path):
    app.mount("/dashboard_static", StaticFiles(directory=dashboard_path), name="dashboard_static")

@app.get("/dashboard")
async def dashboard():
    html_path = os.path.join(os.path.dirname(__file__), '..', 'dashboard', 'index.html')
    if os.path.exists(html_path):
        return FileResponse(html_path)
    return {"error": "Dashboard not found", "path": html_path}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
