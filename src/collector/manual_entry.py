"""
Quick manual entry when watching virtuals live
Just run: python -m src.collector.manual_entry
Type: HomeTeam AwayTeam HomeScore AwayScore
Example: Man City Arsenal 2 1
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../..'))
from src.datacenter.database import VirtualSportsDB
db = VirtualSportsDB()

TEAMS = ["Man Utd","Man City","Liverpool","Chelsea","Arsenal","Tottenham","Everton","Leicester","West Ham","Aston Villa","Newcastle","Leeds","Wolves","Crystal Palace","Southampton","Brighton","Burnley","Fulham","West Brom","Sheff Utd"]
print("Teams:", ", ".join(TEAMS))
print("Format: HomeTeam AwayTeam HomeScore AwayScore  (use quotes for spaced names)")
print("Example: \"Man City\" \"Man Utd\" 2 1")
print("Type 'list' to see recent, 'stats' for distribution, 'exit' to quit")

while True:
    inp = input("> ").strip()
    if not inp:
        continue
    if inp.lower() == 'exit':
        break
    if inp.lower() == 'list':
        df = db.get_all_matches(limit=20)
        print(df[['timestamp','home_team','away_team','correct_score']].to_string(index=False))
        continue
    if inp.lower() == 'stats':
        print(db.get_score_distribution().head(10))
        continue
    try:
        # support quoted team names
        import shlex
        parts = shlex.split(inp)
        if len(parts) < 4:
            print("Need 4 args")
            continue
        home, away, hs, as_ = parts[0], parts[1], int(parts[2]), int(parts[3])
        ok = db.insert_match(home, away, hs, as_)
        print("Added" if ok else "Duplicate or error")
    except Exception as e:
        print(f"Error: {e}")
