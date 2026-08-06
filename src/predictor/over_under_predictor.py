"""
Over/Under Predictor - Over 2.5, Under 1.5 + all lines (0.5,1.5,2.5,3.5)
Uses Poisson + ML ensemble
"""
import os, sys, joblib, json
import numpy as np
import pandas as pd
from math import factorial, exp
from collections import Counter
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../..'))
from src.predictor.feature_engineering import FeatureBuilder
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score

try:
    import xgboost as XGB
    HAS_XGB = True
except:
    HAS_XGB = False

MODEL_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "models", "over_under_model.pkl")

class PoissonOverUnder:
    @staticmethod
    def poisson_prob(lmbda, k):
        return (lmbda**k * exp(-lmbda)) / factorial(k) if lmbda>=0 and k>=0 else 0

    @staticmethod
    def prob_total_goals(lambda_total, max_goals=10):
        """Return dict total->prob up to max"""
        probs = {}
        for k in range(max_goals+1):
            probs[k] = PoissonOverUnder.poisson_prob(lambda_total, k)
        # tail beyond max
        probs[max_goals] += 1 - sum(probs.values())
        return probs

    @staticmethod
    def over_prob(lambda_total, line):
        """Probability total > line, line like 2.5, 1.5"""
        threshold = int(np.floor(line))  # 2.5 -> 2, so over means >=3 => 1 - CDF(2)
        prob_over = 0
        # compute CDF up to threshold
        cdf = sum(PoissonOverUnder.poisson_prob(lambda_total, k) for k in range(threshold+1))
        return 1 - cdf

    @staticmethod
    def under_prob(lambda_total, line):
        # under 1.5 => total <=1
        threshold = int(np.floor(line))
        cdf = sum(PoissonOverUnder.poisson_prob(lambda_total, k) for k in range(threshold+1))
        return cdf

class OverUnderPredictor:
    def __init__(self, model_path=MODEL_PATH):
        self.model_path = model_path
        self.builder = FeatureBuilder()
        self.model_over25 = None
        self.model_under15 = None
        self.model_regressor = None
        self.trained = False
        self.feature_columns = None

        # Load
        if os.path.exists(model_path):
            try:
                data = joblib.load(model_path)
                self.model_over25 = data.get('over25')
                self.model_under15 = data.get('under15')
                self.model_regressor = data.get('regressor')
                self.feature_columns = data.get('columns')
                self.builder.load_state(data.get('state'))
                self.trained = True
                print(f"[OU] Loaded from {model_path}")
            except Exception as e:
                print(f"[OU] Load failed: {e}")

    def train(self, df_matches):
        print(f"[OU Trainer] Training on {len(df_matches)} matches")
        if len(df_matches) < 50:
            print("[OU] Need 50+ matches")
            return False

        X, y_scores = self.builder.build_features_from_history(df_matches)
        # Need total_goals from df sorted same as builder does
        df_sorted = df_matches.sort_values('timestamp').copy()
        # filter valid
        df_sorted = df_sorted.iloc[:len(X)] if len(df_sorted)>=len(X) else df_sorted
        # Align
        if len(df_sorted) != len(X):
            # rebuild using internal matching - simpler: recompute from y_scores? y_scores not have total
            # Use df_matches directly - builder iterates sorted, so X length == filtered valid scores <=5
            # For OU we need all, not filter by max 5, so we need to build again without filtering score
            # Let's rebuild features using all matches
            from src.predictor.feature_engineering import FeatureBuilder
            fb = FeatureBuilder()
            X_all, y_all = fb.build_features_from_history(df_matches.sort_values('timestamp'))
            # But y_all is score string, we need totals from original
            totals = df_matches.sort_values('timestamp')['home_score'] + df_matches.sort_values('timestamp')['away_score']
            totals = totals.iloc[:len(X_all)]  # align
            X = X_all
            total_goals = totals.values
            self.builder = fb  # use this builder for future
        else:
            total_goals = (df_sorted['home_score'] + df_sorted['away_score']).values

        self.feature_columns = X.columns.tolist()

        # Labels
        y_over25 = (total_goals > 2).astype(int)  # 1 if over 2.5
        y_under15 = (total_goals < 2).astype(int)  # Under 1.5 means 0 or 1 goal -> total <=1
        # Actually under 1.5: total <=1
        y_under15 = (total_goals <= 1).astype(int)
        y_over15 = (total_goals > 1).astype(int)
        y_under25 = (total_goals <= 2).astype(int)

        print(f"[OU] Distribution: Over2.5 {y_over25.mean()*100:.1f}% | Under1.5 {y_under15.mean()*100:.1f}% | Avg goals {total_goals.mean():.2f}")

        X_train, X_test, yo_train, yo_test = train_test_split(X, y_over25, test_size=0.2, random_state=42)
        _, _, yu_train, yu_test = train_test_split(X, y_under15, test_size=0.2, random_state=42)
        _, _, yt_train, yt_test = train_test_split(X, total_goals, test_size=0.2, random_state=42)

        # Models
        def make_classifier():
            if HAS_XGB:
                return XGB.XGBClassifier(n_estimators=200, max_depth=6, learning_rate=0.08, random_state=42, eval_metric='logloss')
            else:
                return RandomForestClassifier(n_estimators=200, max_depth=12, random_state=42, n_jobs=-1)

        def make_regressor():
            if HAS_XGB:
                return XGB.XGBRegressor(n_estimators=200, max_depth=6, learning_rate=0.08, random_state=42)
            else:
                return RandomForestRegressor(n_estimators=200, max_depth=12, random_state=42, n_jobs=-1)

        self.model_over25 = make_classifier()
        self.model_under15 = make_classifier()
        self.model_regressor = make_regressor()

        self.model_over25.fit(X_train, yo_train)
        self.model_under15.fit(X_train, yu_train)
        self.model_regressor.fit(X_train, yt_train)

        # Evaluate
        acc_over = accuracy_score(yo_test, self.model_over25.predict(X_test))
        acc_under = accuracy_score(yu_test, self.model_under15.predict(X_test))
        print(f"[OU] Acc Over2.5: {acc_over:.3f} | Acc Under1.5: {acc_under:.3f}")

        # Save
        os.makedirs(os.path.dirname(self.model_path), exist_ok=True)
        joblib.dump({
            'over25': self.model_over25,
            'under15': self.model_under15,
            'regressor': self.model_regressor,
            'columns': self.feature_columns,
            'state': self.builder.get_state(),
            'acc_over': acc_over,
            'acc_under': acc_under
        }, self.model_path)
        self.trained = True
        return True

    def predict(self, home_team, away_team):
        feat = self.builder.build_features_for_prediction(home_team, away_team)
        lambda_home = feat['lambda_home']
        lambda_away = feat['lambda_away']
        lambda_total = lambda_home + lambda_away

        # Poisson probs
        poisson_over25 = PoissonOverUnder.over_prob(lambda_total, 2.5)
        poisson_under25 = PoissonOverUnder.under_prob(lambda_total, 2.5)
        poisson_over15 = PoissonOverUnder.over_prob(lambda_total, 1.5)
        poisson_under15 = PoissonOverUnder.under_prob(lambda_total, 1.5)
        poisson_over05 = PoissonOverUnder.over_prob(lambda_total, 0.5)
        poisson_under05 = PoissonOverUnder.under_prob(lambda_total, 0.5)
        poisson_over35 = PoissonOverUnder.over_prob(lambda_total, 3.5)
        poisson_under35 = PoissonOverUnder.under_prob(lambda_total, 3.5)

        result = {
            'home_team': home_team,
            'away_team': away_team,
            'lambda_home': float(lambda_home),
            'lambda_away': float(lambda_away),
            'lambda_total': float(lambda_total),
            'expected_total': float(lambda_total),
            'poisson': {
                'over_0.5': float(poisson_over05),
                'under_0.5': float(poisson_under05),
                'over_1.5': float(poisson_over15),
                'under_1.5': float(poisson_under15),
                'over_2.5': float(poisson_over25),
                'under_2.5': float(poisson_under25),
                'over_3.5': float(poisson_over35),
                'under_3.5': float(poisson_under35),
            },
            'features': feat
        }

        if not self.trained:
            # Poisson only
            result['ml'] = None
            result['ensemble'] = {
                'over_2.5': {'prob': float(poisson_over25), 'confidence': 'poisson_only'},
                'under_1.5': {'prob': float(poisson_under15), 'confidence': 'poisson_only'},
                'over_0.5': float(poisson_over05),
                'over_1.5': float(poisson_over15),
                'under_2.5': float(poisson_under25),
            }
            return result

        # ML predictions
        X = pd.DataFrame([feat])
        if self.feature_columns:
            X = X[self.feature_columns]

        try:
            prob_over25_ml = float(self.model_over25.predict_proba(X)[0][1])
            prob_under15_ml = float(self.model_under15.predict_proba(X)[0][1])
            pred_total_ml = float(self.model_regressor.predict(X)[0])
        except Exception as e:
            print(f"[OU] ML error {e}")
            prob_over25_ml = poisson_over25
            prob_under15_ml = poisson_under15
            pred_total_ml = lambda_total

        # Ensemble: weighted average Poisson 40% + ML 60%
        ensemble_over25 = poisson_over25*0.4 + prob_over25_ml*0.6
        ensemble_under15 = poisson_under15*0.4 + prob_under15_ml*0.6
        
        # For other lines, use regressor's lambda? Use Poisson from ML predicted total
        poisson_over25_from_ml = PoissonOverUnder.over_prob(max(0.1, pred_total_ml), 2.5)
        poisson_under15_from_ml = PoissonOverUnder.under_prob(max(0.1, pred_total_ml), 1.5)

        result['ml'] = {
            'over_2.5': float(prob_over25_ml),
            'under_1.5': float(prob_under15_ml),
            'predicted_total_goals': float(pred_total_ml),
            'over_2.5_from_total': float(poisson_over25_from_ml),
            'under_1.5_from_total': float(poisson_under15_from_ml),
        }

        result['ensemble'] = {
            'over_2.5': float(ensemble_over25),
            'under_2.5': float(1 - ensemble_over25),
            'over_1.5': float(poisson_over15*0.4 + PoissonOverUnder.over_prob(max(0.1, pred_total_ml), 1.5)*0.6),
            'under_1.5': float(ensemble_under15),
            'over_0.5': float(poisson_over05*0.4 + PoissonOverUnder.over_prob(max(0.1, pred_total_ml), 0.5)*0.6),
            'under_0.5': float(1 - (poisson_over05*0.4 + PoissonOverUnder.over_prob(max(0.1, pred_total_ml), 0.5)*0.6)),
            'over_3.5': float(poisson_over35*0.4 + PoissonOverUnder.over_prob(max(0.1, pred_total_ml), 3.5)*0.6),
            'under_3.5': float(1 - (poisson_over35*0.4 + PoissonOverUnder.over_prob(max(0.1, pred_total_ml), 3.5)*0.6)),
            'predicted_total': float(pred_total_ml*0.6 + lambda_total*0.4)
        }

        # Recommendations
        def recommendation(prob, threshold=0.65):
            if prob >= threshold:
                return "STRONG"
            elif prob >= 0.58:
                return "MODERATE"
            elif prob >= 0.52:
                return "WEAK"
            else:
                return "NO BET"

        result['recommendation'] = {
            'over_2.5': recommendation(ensemble_over25),
            'under_1.5': recommendation(ensemble_under15),
            'best_bet': 'OVER 2.5' if ensemble_over25 >= ensemble_under15 and ensemble_over25 >= 0.55 else ('UNDER 1.5' if ensemble_under15 >=0.55 else 'NO CLEAR EDGE')
        }

        return result

if __name__ == "__main__":
    from src.datacenter.database import VirtualSportsDB
    db = VirtualSportsDB()
    df = db.get_matches_for_training()
    if len(df) < 50:
        print("Need data")
    else:
        p = OverUnderPredictor()
        p.train(df)
        print(p.predict("Man City", "Arsenal"))
