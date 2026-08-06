"""
Auto-start collector for local PC
Run in background: python collector_service.py
"""
import time
from src.collector.sportybet_collector import SportyBetCollector

if __name__ == "__main__":
    print("Starting 24/7 SportyBet collector - will run forever")
    print("If SportyBet blocks headless, run with --no-headless in code")
    collector = SportyBetCollector(headless=True)
    collector.run_forever(interval=180)
