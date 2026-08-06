"""
Data Center Database - SQLite based storage for virtual football results
Designed for SportyBet Virtual Football League
"""
import sqlite3
import os
from datetime import datetime
import pandas as pd
import json

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "data", "virtual_sports.db")

class VirtualSportsDB:
    def __init__(self, db_path=DB_PATH):
        self.db_path = db_path
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self.init_db()

    def get_conn(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def init_db(self):
        conn = self.get_conn()
        cur = conn.cursor()
        
        # Main match results table
        cur.execute("""
        CREATE TABLE IF NOT EXISTS matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            match_id TEXT UNIQUE,
            season INTEGER,
            matchday INTEGER,
            timestamp DATETIME,
            home_team TEXT NOT NULL,
            away_team TEXT NOT NULL,
            home_score INTEGER,
            away_score INTEGER,
            correct_score TEXT,
            result_1x2 TEXT,
            total_goals INTEGER,
            over_25 INTEGER,
            league_name TEXT DEFAULT 'Virtual Premier League',
            source TEXT DEFAULT 'sportybet',
            raw_json TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        """)

        # Teams stats table (materialized view updated on insert)
        cur.execute("""
        CREATE TABLE IF NOT EXISTS team_stats (
            team_name TEXT PRIMARY KEY,
            matches_played INTEGER DEFAULT 0,
            wins INTEGER DEFAULT 0,
            draws INTEGER DEFAULT 0,
            losses INTEGER DEFAULT 0,
            goals_scored INTEGER DEFAULT 0,
            goals_conceded INTEGER DEFAULT 0,
            avg_scored REAL DEFAULT 0,
            avg_conceded REAL DEFAULT 0,
            elo_rating REAL DEFAULT 1500,
            last_5_form TEXT DEFAULT '[]',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        """)

        # Predictions log
        cur.execute("""
        CREATE TABLE IF NOT EXISTS predictions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME,
            home_team TEXT,
            away_team TEXT,
            predicted_scores_json TEXT,
            top_prediction TEXT,
            confidence REAL,
            actual_score TEXT,
            hit INTEGER DEFAULT NULL,
            model_version TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        """)

        # Score frequency (for prior probabilities)
        cur.execute("""
        CREATE TABLE IF NOT EXISTS score_frequency (
            correct_score TEXT PRIMARY KEY,
            count INTEGER,
            frequency REAL,
            last_seen DATETIME
        )
        """)

        conn.commit()
        conn.close()
        print(f"[DB] Initialized at {self.db_path}")

    def insert_match(self, home_team, away_team, home_score, away_score, 
                     season=1, matchday=1, timestamp=None, match_id=None, league_name="Virtual Premier League", source="sportybet", raw_json=None):
        if timestamp is None:
            timestamp = datetime.now()
        if match_id is None:
            match_id = f"{home_team}_{away_team}_{int(datetime.now().timestamp())}"
        
        correct_score = f"{home_score}-{away_score}"
        if home_score > away_score:
            result_1x2 = "1"
        elif home_score == away_score:
            result_1x2 = "X"
        else:
            result_1x2 = "2"
        
        total_goals = home_score + away_score
        over_25 = 1 if total_goals > 2 else 0

        conn = self.get_conn()
        cur = conn.cursor()
        try:
            cur.execute("""
                INSERT OR IGNORE INTO matches 
                (match_id, season, matchday, timestamp, home_team, away_team, home_score, away_score, correct_score, result_1x2, total_goals, over_25, league_name, source, raw_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (match_id, season, matchday, timestamp, home_team, away_team, home_score, away_score, correct_score, result_1x2, total_goals, over_25, league_name, source, json.dumps(raw_json) if raw_json else None))
            conn.commit()
            if cur.rowcount > 0:
                self._update_team_stats(cur, home_team, away_team, home_score, away_score)
                self._update_score_frequency(cur, correct_score)
                conn.commit()
                print(f"[DB] Inserted: {home_team} {home_score}-{away_score} {away_team}")
                return True
            return False
        except Exception as e:
            print(f"[DB] Error inserting: {e}")
            return False
        finally:
            conn.close()

    def _update_team_stats(self, cur, home_team, away_team, home_score, away_score):
        for team in [home_team, away_team]:
            cur.execute("INSERT OR IGNORE INTO team_stats (team_name) VALUES (?)", (team,))
        
        # Update home team
        cur.execute("SELECT * FROM team_stats WHERE team_name=?", (home_team,))
        # Simple increment logic - fetch and update via SQL
        cur.execute("""
            UPDATE team_stats SET
            matches_played = matches_played + 1,
            wins = wins + ?,
            draws = draws + ?,
            losses = losses + ?,
            goals_scored = goals_scored + ?,
            goals_conceded = goals_conceded + ?,
            updated_at = CURRENT_TIMESTAMP
            WHERE team_name = ?
        """, (1 if home_score>away_score else 0, 1 if home_score==away_score else 0, 1 if home_score<away_score else 0, home_score, away_score, home_team))

        cur.execute("""
            UPDATE team_stats SET
            matches_played = matches_played + 1,
            wins = wins + ?,
            draws = draws + ?,
            losses = losses + ?,
            goals_scored = goals_scored + ?,
            goals_conceded = goals_conceded + ?,
            updated_at = CURRENT_TIMESTAMP
            WHERE team_name = ?
        """, (1 if away_score>home_score else 0, 1 if away_score==home_score else 0, 1 if away_score<home_score else 0, away_score, home_score, away_team))

        # Update averages
        for team in [home_team, away_team]:
            cur.execute("""
                UPDATE team_stats SET
                avg_scored = CAST(goals_scored AS REAL) / MAX(matches_played,1),
                avg_conceded = CAST(goals_conceded AS REAL) / MAX(matches_played,1)
                WHERE team_name=?
            """, (team,))

    def _update_score_frequency(self, cur, correct_score):
        cur.execute("INSERT OR IGNORE INTO score_frequency (correct_score, count, frequency) VALUES (?,0,0)", (correct_score,))
        cur.execute("UPDATE score_frequency SET count = count+1, last_seen=CURRENT_TIMESTAMP WHERE correct_score=?", (correct_score,))
        cur.execute("SELECT SUM(count) as total FROM score_frequency")
        total = cur.fetchone()["total"] or 1
        cur.execute("UPDATE score_frequency SET frequency = CAST(count AS REAL) / ?", (total,))

    def get_all_matches(self, limit=10000):
        conn = self.get_conn()
        df = pd.read_sql_query("SELECT * FROM matches ORDER BY timestamp DESC LIMIT ?", conn, params=(limit,))
        conn.close()
        return df

    def get_team_stats(self):
        conn = self.get_conn()
        df = pd.read_sql_query("SELECT * FROM team_stats ORDER BY elo_rating DESC", conn)
        conn.close()
        return df

    def get_score_distribution(self):
        conn = self.get_conn()
        df = pd.read_sql_query("SELECT * FROM score_frequency ORDER BY count DESC", conn)
        conn.close()
        return df

    def get_matches_for_training(self):
        """Return DataFrame ready for ML"""
        conn = self.get_conn()
        df = pd.read_sql_query("SELECT * FROM matches ORDER BY timestamp ASC", conn)
        conn.close()
        return df

    def wipe(self):
        conn = self.get_conn()
        cur = conn.cursor()
        cur.execute("DELETE FROM matches")
        cur.execute("DELETE FROM team_stats")
        cur.execute("DELETE FROM score_frequency")
        cur.execute("DELETE FROM predictions")
        conn.commit()
        conn.close()
        print("[DB] Wiped all data")

if __name__ == "__main__":
    db = VirtualSportsDB()
    print(db.get_team_stats())
