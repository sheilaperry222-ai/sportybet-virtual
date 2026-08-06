"""
Run the Data Center - API + Dashboard
Usage: python run.py
Then open http://localhost:8000/dashboard
Collector runs separately: python -m src.collector.sportybet_collector --mode selenium
"""
import os
import sys
import uvicorn

# Ensure project root in path
sys.path.insert(0, os.path.dirname(__file__))

if __name__ == "__main__":
    print("""
  _____                 _         ____        _          ____           _            
 / ____|               | |       |  _ \      | |        / __ \         | |           
| (___  _ __   ___  _ __| |_ _   _| |_) | ___| |_  __   _| |  | |_      _| |__  _   _ 
 \___ \| '_ \ / _ \| '__| __| | | |  _ < / _ \ __| \ \ / / |  | \ \ /\ / / '_ \| | | |
 ____) | |_) | (_) | |  | |_| |_| | |_) |  __/ |_   \ V /| |__| |\ V  V /| |_) | |_| |
|_____/| .__/ \___/|_|   \__|\__, |____/ \___|\__|   \_/  \____/  \_/\_/ |_.__/ \__, |
       | |                    __/ |                                              __/ |
       |_|                   |___/                                              |___/ 

 SportyBet Virtual Football Data Center
 - Correct Score Predictor
 - Local PC Mode
 - Dashboard: http://localhost:8000/dashboard
 - API Docs: http://localhost:8000/docs
    """)

    # Check data folder
    os.makedirs("data", exist_ok=True)
    os.makedirs("models", exist_ok=True)

    uvicorn.run("src.api.main:app", host="0.0.0.0", port=8000, reload=True)
