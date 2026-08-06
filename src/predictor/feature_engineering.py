"""
Feature Engineering for Virtual Football Correct Score Prediction
"""
import pandas as pd
import numpy as np
from collections import defaultdict, deque

class FeatureBuilder:
    def __init__(self, max_goals=5):
        self.max_goals = max_goals
        self.team_elo = defaultdict(lambda: 1500)
        self.team_form = defaultdict(lambda: deque(maxlen=5))
        self.team_goals_scored = defaultdict(list)
        self.team_goals_conceded = defaultdict(list)

    def calculate_elo(self, home_team, away_team, home_score, away_score, k=32):
        """Update Elo ratings after each match"""
        home_elo = self.team_elo[home_team]
        away_elo = self.team_elo[away_team]
        
        expected_home = 1 / (1 + 10 ** ((away_elo - home_elo) / 400))
        expected_away = 1 - expected_home
        
        if home_score > away_score:
            actual_home, actual_away = 1, 0
        elif home_score == away_score:
            actual_home, actual_away = 0.5, 0.5
        else:
            actual_home, actual_away = 0, 1
        
        self.team_elo[home_team] = home_elo + k * (actual_home - expected_home)
        self.team_elo[away_team] = away_elo + k * (actual_away - expected_away)

    def build_features_from_history(self, df_matches):
        """
        df_matches must have: timestamp, home_team, away_team, home_score, away_score
        Returns feature DataFrame and target (correct_score)
        """
        df = df_matches.sort_values('timestamp').copy()
        features = []
        targets = []

        for idx, row in df.iterrows():
            home = row['home_team']
            away = row['away_team']
            
            # Features BEFORE this match (using history)
            home_avg_scored = np.mean(self.team_goals_scored[home]) if self.team_goals_scored[home] else 1.2
            home_avg_conceded = np.mean(self.team_goals_conceded[home]) if self.team_goals_conceded[home] else 1.2
            away_avg_scored = np.mean(self.team_goals_scored[away]) if self.team_goals_scored[away] else 1.0
            away_avg_conceded = np.mean(self.team_goals_conceded[away]) if self.team_goals_conceded[away] else 1.0

            home_elo = self.team_elo[home]
            away_elo = self.team_elo[away]
            elo_diff = home_elo - away_elo

            # Form: last 5 results converted to points (W=3 D=1 L=0) avg
            def form_points(form_deque):
                if not form_deque:
                    return 1.0
                return np.mean(form_deque)

            home_form = form_points(self.team_form[home])
            away_form = form_points(self.team_form[away])

            # Poisson lambdas
            home_attack = home_avg_scored
            away_defense = away_avg_conceded
            away_attack = away_avg_scored
            home_defense = home_avg_conceded

            lambda_home = ((home_attack + away_defense) / 2) * 1.1  # home advantage
            lambda_away = (away_attack + home_defense) / 2

            # League avg (simple running)
            league_avg_home = 1.3
            league_avg_away = 1.0

            feat = {
                'home_avg_scored': home_avg_scored,
                'home_avg_conceded': home_avg_conceded,
                'away_avg_scored': away_avg_scored,
                'away_avg_conceded': away_avg_conceded,
                'elo_diff': elo_diff,
                'home_elo': home_elo,
                'away_elo': away_elo,
                'home_form': home_form,
                'away_form': away_form,
                'lambda_home': lambda_home,
                'lambda_away': lambda_away,
                'home_advantage': 0.3,
                'league_avg_home': league_avg_home,
                'league_avg_away': league_avg_away,
                'expected_total_goals': lambda_home + lambda_away,
            }
            features.append(feat)
            targets.append(f"{row['home_score']}-{row['away_score']}")

            # Now update history with this result
            self.team_goals_scored[home].append(row['home_score'])
            self.team_goals_conceded[home].append(row['away_score'])
            self.team_goals_scored[away].append(row['away_score'])
            self.team_goals_conceded[away].append(row['home_score'])

            # Form update
            if row['home_score'] > row['away_score']:
                self.team_form[home].append(3)
                self.team_form[away].append(0)
            elif row['home_score'] == row['away_score']:
                self.team_form[home].append(1)
                self.team_form[away].append(1)
            else:
                self.team_form[home].append(0)
                self.team_form[away].append(3)

            self.calculate_elo(home, away, row['home_score'], row['away_score'])

        return pd.DataFrame(features), pd.Series(targets)

    def build_features_for_prediction(self, home_team, away_team):
        """Build feature vector for an upcoming match"""
        home_avg_scored = np.mean(self.team_goals_scored[home_team]) if self.team_goals_scored[home_team] else 1.2
        home_avg_conceded = np.mean(self.team_goals_conceded[home_team]) if self.team_goals_conceded[home_team] else 1.2
        away_avg_scored = np.mean(self.team_goals_scored[away_team]) if self.team_goals_scored[away_team] else 1.0
        away_avg_conceded = np.mean(self.team_goals_conceded[away_team]) if self.team_goals_conceded[away_team] else 1.0

        home_elo = self.team_elo[home_team]
        away_elo = self.team_elo[away_team]

        def form_points(form_deque):
            if not form_deque:
                return 1.0
            return np.mean(form_deque)

        home_form = form_points(self.team_form[home_team])
        away_form = form_points(self.team_form[away_team])

        lambda_home = ((home_avg_scored + away_avg_conceded) / 2) * 1.1
        lambda_away = (away_avg_scored + home_avg_conceded) / 2

        return {
            'home_avg_scored': home_avg_scored,
            'home_avg_conceded': home_avg_conceded,
            'away_avg_scored': away_avg_scored,
            'away_avg_conceded': away_avg_conceded,
            'elo_diff': home_elo - away_elo,
            'home_elo': home_elo,
            'away_elo': away_elo,
            'home_form': home_form,
            'away_form': away_form,
            'lambda_home': lambda_home,
            'lambda_away': lambda_away,
            'home_advantage': 0.3,
            'league_avg_home': 1.3,
            'league_avg_away': 1.0,
            'expected_total_goals': lambda_home + lambda_away,
        }

    def get_state(self):
        return {
            'elo': dict(self.team_elo),
            'scored': {k: list(v)[-50:] for k, v in self.team_goals_scored.items()},
            'conceded': {k: list(v)[-50:] for k, v in self.team_goals_conceded.items()},
            'form': {k: list(v) for k, v in self.team_form.items()},
        }

    def load_state(self, state):
        if not state:
            return
        self.team_elo.update(state.get('elo', {}))
        for k, v in state.get('scored', {}).items():
            self.team_goals_scored[k] = v
        for k, v in state.get('conceded', {}).items():
            self.team_goals_conceded[k] = v
        for k, v in state.get('form', {}).items():
            self.team_form[k] = deque(v, maxlen=5)
