"""
GG Predictor - Both Teams To Score (Goal Goal / BTTS)
Predicts if both teams will score in instant virtual matches
"""
import os, sys, joblib, json
import numpy as np
import pandas as pd
from math import exp, factorial
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../..'))
from src.predictor.feature_engineering import FeatureBuilder
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score

try:
    import xgboost as XGB
    HAS_XGB = True
except:
    HAS_XGB = False

MODEL_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "models", "gg_model.pkl")

class PoissonGG:
    @staticmethod
    def poisson_prob(lmbda, k):
        return (lmbda**k * exp(-lmbda)) / factorial(k) if lmbda>=0 else 0

    @staticmethod
    def gg_prob(lambda_home, lambda_away):
        # P(GG) = P(home>0) * P(away>0) = (1 - P(0)) * (1 - P(0))
        # P(0) = e^-lambda
        p_home_0 = exp(-lambda_home)
        p_away_0 = exp(-lambda_away)
        p_home_score = 1 - p_home_0
        p_away_score = 1 - p_away_0
        return p_home_score * p_away_score

    @staticmethod
    def no_gg_prob(lambda_home, lambda_away):
        return 1 - PoissonGG.gg_prob(lambda_home, lambda_away)

class GGPredictor:
    def __init__(self, model_path=MODEL_PATH):
        self.model_path = model_path
        self.builder = FeatureBuilder()
        self.model = None
        self.trained = False
        self.feature_columns = None

        if os.path.exists(model_path):
            try:
                data = joblib.load(model_path)
                self.model = data.get('model')
                self.builder.load_state(data.get('state'))
                self.feature_columns = data.get('columns')
                self.trained = True
                print(f"[GG] Loaded from {model_path}")
            except Exception as e:
                print(f"[GG] Load failed: {e}")

    def train(self, df_matches):
        print(f"[GG Trainer] Training on {len(df_matches)} matches")
        if len(df_matches) < 50:
            print("[GG] Need 50+ matches")
            return False

        # Build features
        from src.predictor.feature_engineering import FeatureBuilder
        fb = FeatureBuilder()
        X_all, y_all = fb.build_features_from_history(df_matches.sort_values('timestamp'))
        totals = df_matches.sort_values('timestamp')['home_score'] + df_matches.sort_values('timestamp')['away_score']
        # Align
        if len(X_all) != len(df_matches.sort_values('timestamp')):
            # X_all length may be less due to filtering? Actually builder returns all
            totals = totals.iloc[:len(X_all)]
        
        # GG label: both teams score >0
        df_sorted = df_matches.sort_values('timestamp').iloc[:len(X_all)]
        y_gg = ((df_sorted['home_score'] > 0) & (df_sorted['away_score'] > 0)).astype(int).values

        print(f"[GG] Distribution: GG Yes {y_gg.mean()*100:.1f}% | GG No {(1-y_gg.mean())*100:.1f}%")

        self.builder = fb
        self.feature_columns = X_all.columns.tolist()

        X_train, X_test, y_train, y_test = train_test_split(X_all, y_gg, test_size=0.2, random_state=42)

        if HAS_XGB:
            self.model = XGB.XGBClassifier(n_estimators=200, max_depth=6, learning_rate=0.08, random_state=42, eval_metric='logloss')
        else:
            self.model = RandomForestClassifier(n_estimators=200, max_depth=12, random_state=42, n_jobs=-1)

        self.model.fit(X_train, y_train)
        acc = accuracy_score(y_test, self.model.predict(X_test))
        print(f"[GG] Acc: {acc:.3f}")

        os.makedirs(os.path.dirname(self.model_path), exist_ok=True)
        joblib.dump({
            'model': self.model,
            'columns': self.feature_columns,
            'state': self.builder.get_state(),
            'acc': acc
        }, self.model_path)
        self.trained = True
        return True

    def predict(self, home_team, away_team):
        feat = self.builder.build_features_for_prediction(home_team, away_team)
        lambda_home = feat['lambda_home']
        lambda_away = feat['lambda_away']

        poisson_gg = PoissonGG.gg_prob(lambda_home, lambda_away)
        poisson_no_gg = PoissonGG.no_gg_prob(lambda_home, lambda_away)

        result = {
            'home_team': home_team,
            'away_team': away_team,
            'lambda_home': float(lambda_home),
            'lambda_away': float(lambda_away),
            'poisson': {
                'gg_yes': float(poisson_gg),
                'gg_no': float(poisson_no_gg)
            },
            'features': feat
        }

        if not self.trained:
            result['ml'] = None
            result['ensemble'] = {
                'gg_yes': float(poisson_gg),
                'gg_no': float(poisson_no_gg),
                'confidence': 'poisson_only'
            }
            result['recommendation'] = {
                'gg': 'STRONG' if poisson_gg>=0.65 else 'MODERATE' if poisson_gg>=0.58 else 'WEAK' if poisson_gg>=0.52 else 'NO BET',
                'best_bet': 'GG YES' if poisson_gg>=0.55 else 'GG NO' if poisson_no_gg>=0.55 else 'NO CLEAR'
            }
            return result

        X = pd.DataFrame([feat])
        if self.feature_columns:
            X = X[self.feature_columns]

        try:
            prob_gg_ml = float(self.model.predict_proba(X)[0][1])
        except:
            prob_gg_ml = poisson_gg

        ensemble_gg = poisson_gg*0.4 + prob_gg_ml*0.6

        def reco(p):
            if p>=0.65: return "STRONG"
            if p>=0.58: return "MODERATE"
            if p>=0.52: return "WEAK"
            return "NO BET"

        result['ml'] = {
            'gg_yes': float(prob_gg_ml),
            'gg_no': float(1-prob_gg_ml)
        }
        result['ensemble'] = {
            'gg_yes': float(ensemble_gg),
            'gg_no': float(1-ensemble_gg),
            'predicted_gg': 'YES' if ensemble_gg>=0.5 else 'NO'
        }
        result['recommendation'] = {
            'gg': reco(ensemble_gg),
            'best_bet': 'GG YES' if ensemble_gg>=0.55 else 'GG NO' if (1-ensemble_gg)>=0.55 else 'NO CLEAR',
            'gg_yes_prob': float(ensemble_gg)
        }
        return result

if __name__ == "__main__":
    from src.datacenter.database import VirtualSportsDB
    db = VirtualSportsDB()
    df = db.get_matches_for_training()
    if len(df) >= 50:
        p = GGPredictor()
        p.train(df)
        print(p.predict("Man City", "Barcelona"))
