"""
Correct Score Predictor - Ensemble of Poisson + RandomForest + XGBoost
Predicts most likely correct scores for Virtual Football
"""
import os
import json
import joblib
import pandas as pd
import numpy as np
from collections import Counter
from math import factorial, exp
import sys
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

MODEL_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "models", "correct_score_model.pkl")
STATE_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "models", "feature_state.json")

class PoissonModel:
    @staticmethod
    def poisson_prob(lmbda, k):
        """P(k) = lambda^k * e^-lambda / k!"""
        return (lmbda**k * exp(-lmbda)) / factorial(k)

    @staticmethod
    def score_matrix(lambda_home, lambda_away, max_goals=5):
        matrix = np.zeros((max_goals+1, max_goals+1))
        for i in range(max_goals+1):
            for j in range(max_goals+1):
                matrix[i,j] = PoissonModel.poisson_prob(lambda_home, i) * PoissonModel.poisson_prob(lambda_away, j)
        return matrix

    @staticmethod
    def top_scores(lambda_home, lambda_away, max_goals=5, top_n=5):
        mat = PoissonModel.score_matrix(lambda_home, lambda_away, max_goals)
        scores = []
        for i in range(max_goals+1):
            for j in range(max_goals+1):
                scores.append(((f"{i}-{j}", mat[i,j])))
        scores.sort(key=lambda x: x[1], reverse=True)
        return scores[:top_n]


class CorrectScorePredictor:
    def __init__(self, model_path=MODEL_PATH):
        self.model_path = model_path
        self.builder = FeatureBuilder()
        self.model = None
        self.label_encoder = None
        self.label_counts = None
        self.trained = False
        self.feature_columns = None

        # Load saved state if exists
        if os.path.exists(STATE_PATH):
            try:
                with open(STATE_PATH, 'r') as f:
                    state = json.load(f)
                    self.builder.load_state(state)
            except Exception as e:
                print(f"[Predictor] Could not load state: {e}")

        if os.path.exists(model_path):
            try:
                data = joblib.load(model_path)
                self.model = data['model']
                self.label_encoder = data.get('label_encoder')
                self.builder.load_state(data.get('state'))
                self.feature_columns = data.get('columns')
                self.label_counts = data.get('label_counts')
                self.trained = True
                print(f"[Predictor] Loaded model from {model_path}")
            except Exception as e:
                print(f"[Predictor] Failed to load model: {e}")

    def train(self, df_matches):
        """
        df_matches: from database, at least 200 rows recommended
        """
        print(f"[Trainer] Training on {len(df_matches)} matches...")
        if len(df_matches) < 50:
            print("[Trainer] Not enough data! Need at least 50 matches")
            return False

        X, y = self.builder.build_features_from_history(df_matches)

        # Limit to most frequent scores to reduce classes? Keep all but cap max 0-5
        # Filter out extreme scores >5
        def filter_score(s):
            try:
                h,a = map(int, s.split('-'))
                return h<=5 and a<=5
            except:
                return False

        mask = y.apply(filter_score)
        X = X[mask]
        y = y[mask]

        if len(X) < 30:
            print("[Trainer] Too few valid scores after filtering")
            return False

        self.feature_columns = X.columns.tolist()
        self.label_counts = Counter(y)

        print(f"[Trainer] Classes: {len(self.label_counts)} unique scores, top: {self.label_counts.most_common(5)}")
        print(f"[Trainer] Features: {self.feature_columns}")

        # Encode labels for XGBoost compatibility
        from sklearn.preprocessing import LabelEncoder
        self.label_encoder = LabelEncoder()
        y_encoded = self.label_encoder.fit_transform(y)

        # Train/test split
        X_train, X_test, y_train_enc, y_test_enc = train_test_split(X, y_encoded, test_size=0.2, random_state=42, stratify=None)
        # Keep original string labels for test reporting
        _, X_test_dummy, y_train_orig, y_test_orig = train_test_split(X, y, test_size=0.2, random_state=42, stratify=None)

        if HAS_XGB and len(self.label_counts) > 5:
            print("[Trainer] Using XGBoost")
            self.model = XGB.XGBClassifier(
                n_estimators=300,
                max_depth=8,
                learning_rate=0.05,
                subsample=0.8,
                colsample_bytree=0.8,
                random_state=42,
                eval_metric='mlogloss'
            )
        else:
            print("[Trainer] Using RandomForest")
            self.model = RandomForestClassifier(
                n_estimators=300,
                max_depth=15,
                min_samples_split=5,
                random_state=42,
                n_jobs=-1
            )

        self.model.fit(X_train, y_train_enc)

        y_pred_enc = self.model.predict(X_test)
        y_pred = self.label_encoder.inverse_transform(y_pred_enc)
        acc = accuracy_score(y_test_orig, y_pred)
        print(f"[Trainer] Test Accuracy: {acc:.3f}")

        # Save
        os.makedirs(os.path.dirname(self.model_path), exist_ok=True)
        joblib.dump({
            'model': self.model,
            'label_encoder': self.label_encoder,
            'columns': self.feature_columns,
            'label_counts': self.label_counts,
            'state': self.builder.get_state(),
            'accuracy': acc
        }, self.model_path)

        with open(STATE_PATH, 'w') as f:
            json.dump(self.builder.get_state(), f)

        self.trained = True
        print(f"[Trainer] Model saved to {self.model_path}")
        return True

    def predict(self, home_team, away_team, top_n=5):
        """
        Return top N correct score predictions with probabilities
        Combines ML model + Poisson prior
        """
        feat_dict = self.builder.build_features_for_prediction(home_team, away_team)
        
        # Poisson baseline
        lambda_home = feat_dict['lambda_home']
        lambda_away = feat_dict['lambda_away']
        poisson_top = PoissonModel.top_scores(lambda_home, lambda_away, max_goals=5, top_n=top_n)

        if not self.trained or self.model is None:
            print("[Predictor] Using Poisson only (model not trained)")
            return {
                'home_team': home_team,
                'away_team': away_team,
                'lambda_home': lambda_home,
                'lambda_away': lambda_away,
                'predictions': [{'score': s, 'prob': float(p), 'method': 'poisson'} for s,p in poisson_top],
                'expected_total_goals': lambda_home + lambda_away,
                'features': feat_dict
            }

        # ML model prediction
        X = pd.DataFrame([feat_dict])
        # Ensure column order
        if self.feature_columns:
            X = X[self.feature_columns]

        try:
            probs = self.model.predict_proba(X)[0]
            if self.label_encoder is not None:
                classes = self.label_encoder.inverse_transform(np.arange(len(probs)))
            else:
                classes = self.model.classes_
            ml_scores = list(zip(classes, probs))
            ml_scores.sort(key=lambda x: x[1], reverse=True)
            ml_top = ml_scores[:top_n*2]  # Get more then combine
        except Exception as e:
            print(f"[Predictor] ML predict error: {e}")
            ml_top = []

        # Ensemble: weighted average of Poisson and ML
        combined = {}
        for score, prob in poisson_top:
            combined[score] = prob * 0.4

        for score, prob in ml_top:
            if score in combined:
                combined[score] += prob * 0.6
            else:
                combined[score] = prob * 0.6

        # Also add prior from historical frequency if available
        if self.label_counts:
            total = sum(self.label_counts.values())
            for score, cnt in self.label_counts.most_common(10):
                prior = cnt / total
                if score in combined:
                    combined[score] = combined[score] * 0.85 + prior * 0.15
                else:
                    # small boost
                    combined[score] = combined.get(score, 0) + prior * 0.1

        sorted_combined = sorted(combined.items(), key=lambda x: x[1], reverse=True)[:top_n]

        # Normalize to probabilities
        total_prob = sum(p for _, p in sorted_combined)
        if total_prob == 0:
            total_prob = 1

        predictions = []
        for score, prob in sorted_combined:
            predictions.append({
                'score': score,
                'prob': float(prob / total_prob),
                'raw_weight': float(prob),
                'method': 'ensemble'
            })

        return {
            'home_team': home_team,
            'away_team': away_team,
            'lambda_home': float(lambda_home),
            'lambda_away': float(lambda_away),
            'expected_total_goals': float(lambda_home + lambda_away),
            'predictions': predictions,
            'poisson_baseline': [{'score': s, 'prob': float(p)} for s,p in poisson_top],
            'ml_top': [{'score': s, 'prob': float(p)} for s,p in ml_top[:top_n]] if ml_top else [],
            'features': feat_dict,
            'elo_diff': feat_dict['elo_diff']
        }

    def predict_matchday(self, fixtures):
        """
        fixtures: list of tuples (home, away)
        Returns list of predictions
        """
        results = []
        for home, away in fixtures:
            results.append(self.predict(home, away, top_n=5))
        return results


if __name__ == "__main__":
    # Test with fake data
    from src.datacenter.database import VirtualSportsDB
    db = VirtualSportsDB()
    df = db.get_matches_for_training()
    if len(df) == 0:
        print("No data - generate fake first: python -m src.collector.sportybet_collector --mode fake")
    else:
        predictor = CorrectScorePredictor()
        predictor.train(df)
        print(predictor.predict("Man City", "Arsenal"))
