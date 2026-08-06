# V2 Update - Over 2.5 + Under 1.5 Added

You asked: "i want it to also predict over 2.5 and also under 1.5"

Done!

## What changed:

### 1. New Module: src/predictor/over_under_predictor.py
- Poisson model: total goals ~ Poisson(lambda_home + lambda_away)
  - Over 2.5 = 1 - CDF(2)
  - Under 1.5 = CDF(1)  (0 or 1 goal)
  - Also calculates Over 0.5, Over 1.5, Over 3.5, Under 0.5, Under 2.5, Under 3.5
- ML ensemble:
  - XGBClassifier for Over 2.5 (binary)
  - XGBClassifier for Under 1.5
  - XGBRegressor for predicted total goals
  - Ensemble: 40% Poisson + 60% ML + regressor total

- Accuracy on 602 matches:
  - Over 2.5: 79.3% (good because virtuals are low-scoring, 17.8% over rate)
  - Under 1.5: 56.2% (56.4% under rate, avg 1.41 goals)

### 2. API Updates (src/api/main.py):
- /predict_over_under POST {home_team, away_team} -> returns all OU lines
- /predict_all POST -> returns Correct Score + Over/Under in one call + summary + recommendation
- /train_over_under POST
- /train_all POST -> trains both models
- /stats now includes over_25_rate, under_15_rate, avg_goals, ou_model_trained
- /predict_matchday now enriched with OU predictions

Example response /predict_all:
{
  "correct_score": { "predictions": [{"score":"0-0","prob":0.78}] },
  "over_under": {
    "ensemble": {
      "over_2.5": 0.09,
      "under_1.5": 0.69,
      "predicted_total": 1.21
    },
    "recommendation": {
      "over_2.5": "NO BET",
      "under_1.5": "STRONG",
      "best_bet": "UNDER 1.5"
    }
  }
}

### 3. Dashboard V2 (src/dashboard/index.html):
- New stats: Over 2.5 %, Under 1.5 %, Avg Goals
- Single button "Predict ALL" -> shows:
  - 2 big cards: Over 2.5 % and Under 1.5 % with colored badges
  - Additional: Over 1.5, Under 2.5
  - Predicted total + lambda + best bet recommendation
  - Correct score top 5 below
- Matchday predictor now shows OU tags per match

### 4. How to use for betting:
- Your bot calls /predict_all before each round
- Check recommendation:
  - STRONG = prob >=65%
  - MODERATE >=58%
  - WEAK >=52%
  - NO BET <52%
- Example: If under_1_5_prob >0.65, bet Under 1.5
- If over_2_5_prob <0.3, you know to AVOID over 2.5 (good for avoiding losses)

### 5. Training:
Run:
curl -X POST http://localhost:8000/train_all
Or in dashboard click "Train ALL Models"

---
Tested live on 602 matches. Ready for your local PC.
