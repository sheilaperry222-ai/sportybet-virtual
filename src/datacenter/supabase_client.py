"""
Supabase Client for Data Center - Replaces SQLite for cloud deployment
Works with both local and Netlify
"""
import os
from dotenv import load_dotenv
load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")  # anon key or service_role key

class SupabaseDB:
    def __init__(self, url=None, key=None):
        self.url = url or SUPABASE_URL
        self.key = key or SUPABASE_KEY
        self.enabled = bool(self.url and self.key)
        if not self.enabled:
            print("[Supabase] No URL/KEY - fallback to SQLite")
            self.client = None
            return
        try:
            from supabase import create_client
            self.client = create_client(self.url, self.key)
            print(f"[Supabase] Connected to {self.url}")
        except Exception as e:
            print(f"[Supabase] Failed to init: {e}")
            self.client = None
            self.enabled = False

    def is_enabled(self):
        return self.enabled and self.client is not None

    def insert_match(self, home_team, away_team, home_score, away_score, season=1, matchday=1, league_name="Virtual Premier League", source="sportybet_instant", raw_json=None):
        if not self.is_enabled():
            return False
        try:
            # Compute fields
            if home_score > away_score:
                result_1x2 = "1"
            elif home_score == away_score:
                result_1x2 = "X"
            else:
                result_1x2 = "2"
            
            data = {
                "home_team": home_team,
                "away_team": away_team,
                "home_score": home_score,
                "away_score": away_score,
                "season": season,
                "matchday": matchday,
                "league_name": league_name,
                "source": source,
                "result_1x2": result_1x2,
                "raw_json": raw_json,
                "match_id": f"{home_team}_{away_team}_{home_score}{away_score}_{season}{matchday}_{int(__import__('time').time())}"
            }
            # Remove None raw_json for cleaner
            if raw_json is None:
                data.pop("raw_json", None)

            resp = self.client.table("matches").insert(data).execute()
            print(f"[Supabase] Inserted {home_team} {home_score}-{away_score} {away_team}")
            return True
        except Exception as e:
            print(f"[Supabase] Insert error: {e}")
            return False

    def get_all_matches(self, limit=1000):
        if not self.is_enabled():
            return None
        try:
            resp = self.client.table("matches").select("*").order("timestamp", desc=True).limit(limit).execute()
            return resp.data
        except Exception as e:
            print(f"[Supabase] Fetch error: {e}")
            return []

    def get_stats(self):
        if not self.is_enabled():
            return None
        try:
            # Use views or count
            matches = self.client.table("matches").select("*", count="exact").execute()
            total = matches.count or len(matches.data)
            
            # Compute rates locally for now (could use view over_under_rates)
            data = matches.data
            if not data:
                return {"total":0}
            
            total_goals = [d['home_score'] + d['away_score'] for d in data]
            over25 = sum(1 for g in total_goals if g > 2)
            under15 = sum(1 for g in total_goals if g <= 1)
            
            return {
                "total_matches": total,
                "over_25_rate": over25/total if total else 0,
                "under_15_rate": under15/total if total else 0,
                "avg_goals": sum(total_goals)/len(total_goals) if total_goals else 0,
                "recent": data[:20]
            }
        except Exception as e:
            print(f"[Supabase] Stats error: {e}")
            return None

    def get_score_frequency(self, limit=10):
        if not self.is_enabled():
            return []
        try:
            # Use view score_frequency if exists
            resp = self.client.table("score_frequency").select("*").order("count", desc=True).limit(limit).execute()
            return resp.data
        except:
            # Fallback: compute from matches
            try:
                matches = self.client.table("matches").select("correct_score").execute()
                from collections import Counter
                counter = Counter([m['correct_score'] for m in matches.data if m.get('correct_score')])
                total = sum(counter.values()) or 1
                return [{"correct_score": k, "count": v, "frequency": v/total} for k,v in counter.most_common(limit)]
            except Exception as e:
                print(f"[Supabase] Frequency error: {e}")
                return []

# Adapter that tries Supabase first, then SQLite fallback
class HybridDB:
    def __init__(self):
        from src.datacenter.database import VirtualSportsDB
        self.sqlite = VirtualSportsDB()
        self.supabase = SupabaseDB()
        self.use_supabase = self.supabase.is_enabled()
        print(f"[HybridDB] Using {'Supabase + SQLite' if self.use_supabase else 'SQLite only'}")

    def insert_match(self, *args, **kwargs):
        # Insert to both for redundancy
        sqlite_ok = self.sqlite.insert_match(*args, **kwargs)
        supabase_ok = False
        if self.use_supabase:
            # Map args
            if len(args) >= 4:
                supabase_ok = self.supabase.insert_match(
                    home_team=args[0], away_team=args[1], 
                    home_score=args[2], away_score=args[3],
                    season=kwargs.get('season',1),
                    matchday=kwargs.get('matchday',1),
                    league_name=kwargs.get('league_name',"Virtual Premier League"),
                    source=kwargs.get('source',"sportybet_instant"),
                    raw_json=kwargs.get('raw_json')
                )
            else:
                supabase_ok = self.supabase.insert_match(**kwargs)
        return sqlite_ok or supabase_ok

    def get_all_matches(self, limit=1000):
        if self.use_supabase:
            data = self.supabase.get_all_matches(limit)
            if data:
                # Convert to DataFrame-like? Return list
                return data
        # Fallback to SQLite DataFrame
        df = self.sqlite.get_all_matches(limit)
        return df.to_dict(orient="records") if hasattr(df, 'to_dict') else df

if __name__ == "__main__":
    db = SupabaseDB()
    if db.is_enabled():
        print(db.get_stats())
    else:
        print("Set SUPABASE_URL and SUPABASE_KEY in .env to enable")
