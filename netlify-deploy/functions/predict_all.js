/**
 * Netlify Function: Predict ALL markets (Correct Score + Over 2.5 + Under 1.5)
 * Pure JavaScript Poisson model - no Python needed, runs fully on Netlify
 * Uses team stats from local DB simulation (can be replaced with Supabase fetch)
 */

// Poisson helpers
function poissonProb(lambda, k) {
  if (lambda < 0) return 0;
  let factorial = 1;
  for (let i = 2; i <= k; i++) factorial *= i;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial;
}

function overProb(lambdaTotal, line) {
  const threshold = Math.floor(line);
  let cdf = 0;
  for (let k = 0; k <= threshold; k++) cdf += poissonProb(lambdaTotal, k);
  return 1 - cdf;
}
function underProb(lambdaTotal, line) {
  const threshold = Math.floor(line);
  let cdf = 0;
  for (let k = 0; k <= threshold; k++) cdf += poissonProb(lambdaTotal, k);
  return cdf;
}
function ggProb(lambdaHome, lambdaAway) {
  // GG = Both teams score >0: P(home>0)*P(away>0) = (1 - e^-lh)*(1 - e^-la)
  const pHome0 = Math.exp(-lambdaHome);
  const pAway0 = Math.exp(-lambdaAway);
  return (1 - pHome0) * (1 - pAway0);
}

// Fetch team stats from Supabase if available, else fallback
async function getTeamStatsFromSupabase(homeTeam, awayTeam) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) return null;
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, supabaseKey);
    const { data: teams } = await supabase.from('team_stats').select('*').in('team_name', [homeTeam, awayTeam]);
    if (teams && teams.length) {
      const map = {};
      teams.forEach(t => { map[t.team_name] = { avg_scored: t.avg_scored || 1.0, avg_conceded: t.avg_conceded || 1.0, elo: t.elo_rating || 1500 }; });
      return map;
    }
  } catch(e) { console.error("Supabase team fetch failed", e); }
  return null;
}

// Simplified team database fallback (replace with Supabase fetch for real data center)
const TEAM_STATS = {
  "Man Utd": { avg_scored: 0.9, avg_conceded: 1.1, elo: 1520 },
  "Man City": { avg_scored: 1.4, avg_conceded: 0.7, elo: 1650 },
  "Liverpool": { avg_scored: 1.3, avg_conceded: 0.9, elo: 1600 },
  "Chelsea": { avg_scored: 1.0, avg_conceded: 1.0, elo: 1500 },
  "Arsenal": { avg_scored: 1.2, avg_conceded: 0.8, elo: 1580 },
  "Tottenham": { avg_scored: 1.1, avg_conceded: 1.0, elo: 1480 },
  "Everton": { avg_scored: 0.7, avg_conceded: 1.2, elo: 1350 },
  "Leicester": { avg_scored: 0.9, avg_conceded: 1.0, elo: 1400 },
  "West Ham": { avg_scored: 0.8, avg_conceded: 1.1, elo: 1380 },
  "Aston Villa": { avg_scored: 1.0, avg_conceded: 1.0, elo: 1420 },
  "Newcastle": { avg_scored: 0.8, avg_conceded: 0.9, elo: 1450 },
  "Leeds": { avg_scored: 0.9, avg_conceded: 1.2, elo: 1360 },
  "Wolves": { avg_scored: 0.8, avg_conceded: 1.0, elo: 1400 },
  "Crystal Palace": { avg_scored: 0.7, avg_conceded: 1.1, elo: 1340 },
  "Southampton": { avg_scored: 0.6, avg_conceded: 1.3, elo: 1300 },
  "Brighton": { avg_scored: 0.9, avg_conceded: 1.0, elo: 1410 },
  "Burnley": { avg_scored: 0.6, avg_conceded: 1.2, elo: 1320 },
  "Fulham": { avg_scored: 0.8, avg_conceded: 1.1, elo: 1370 },
  "West Brom": { avg_scored: 0.5, avg_conceded: 1.4, elo: 1280 },
  "Sheff Utd": { avg_scored: 0.5, avg_conceded: 1.3, elo: 1270 },
};

function getTeamStat(team) {
  return TEAM_STATS[team] || { avg_scored: 1.0, avg_conceded: 1.0, elo: 1500 };
}

function predictCorrectScore(lambdaHome, lambdaAway, maxGoals = 5) {
  const scores = [];
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const prob = poissonProb(lambdaHome, h) * poissonProb(lambdaAway, a);
      scores.push({ score: `${h}-${a}`, prob });
    }
  }
  scores.sort((a,b) => b.prob - a.prob);
  return scores.slice(0,5);
}

exports.handler = async function(event, context) {
  // CORS
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  try {
    let body = {};
    if (event.body) {
      try { body = JSON.parse(event.body); } catch(e) { body = {}; }
    }

    // NEW: Support matchday predictions - fixtures array - ONLY Over 2.5, GG, Under 1.5
    if (body.fixtures && Array.isArray(body.fixtures) && body.fixtures.length > 0) {
      const fixtures = body.fixtures.slice(0,15); // Max 15
      const results = [];
      for (const f of fixtures) {
        let homeTeam, awayTeam;
        if (Array.isArray(f)) { homeTeam = f[0]; awayTeam = f[1]; }
        else { homeTeam = f.home_team || f.home; awayTeam = f.away_team || f.away; }
        if (!homeTeam || !awayTeam) continue;

        let homeStat = getTeamStat(homeTeam);
        let awayStat = getTeamStat(awayTeam);
        try {
          const supaMap = await getTeamStatsFromSupabase(homeTeam, awayTeam);
          if (supaMap) {
            homeStat = supaMap[homeTeam] || homeStat;
            awayStat = supaMap[awayTeam] || awayStat;
          }
        } catch {}

        const lambdaHome = ((homeStat.avg_scored + awayStat.avg_conceded) / 2) * 1.1;
        const lambdaAway = (awayStat.avg_scored + homeStat.avg_conceded) / 2;
        const lambdaTotal = lambdaHome + lambdaAway;

        const over15 = overProb(lambdaTotal, 1.5);
        const over25 = overProb(lambdaTotal, 2.5);
        const under15 = underProb(lambdaTotal, 1.5);
        const gg = ggProb(lambdaHome, lambdaAway);
        function reco(p){ if(p>=0.65) return "STRONG"; if(p>=0.58) return "MODERATE"; if(p>=0.52) return "WEAK"; return "NO BET"; }
        const bestBet = over25>=0.6 ? "OVER 2.5" : gg>=0.6 ? "GG YES" : under15>=0.6 ? "UNDER 1.5" : over15>=0.6 ? "OVER 1.5" : "NO CLEAR";

        results.push({
          home_team: homeTeam,
          away_team: awayTeam,
          lambda_home: lambdaHome,
          lambda_away: lambdaAway,
          over_1_5: over15,
          over_2_5: over25,
          under_1_5: under15,
          gg: gg,
          gg_yes: gg,
          predicted_total: lambdaTotal,
          best_bet: bestBet,
          over_15: over15,
          over_25: over25,
          recommendation: { over_1_5: reco(over15), over_2_5: reco(over25), under_1_5: reco(under15), gg: reco(gg), best_bet: bestBet },
          over_under: { over_1_5: over15, over_2_5: over25, under_1_5: under15, gg: gg, predicted_total: lambdaTotal },
          ou_recommendation: { over_1_5: reco(over15), over_2_5: reco(over25), under_1_5: reco(under15), gg: reco(gg), best_bet: bestBet }
        });
      }
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          fixtures: results,
          count: results.length,
          display_only: "Over 2.5, GG, Under 1.5 - Instant Virtual Prediction Site",
          source: "netlify-function-matchday-v4"
        })
      };
    }

    // Support both query and body for single match
    const homeTeam = body.home_team || event.queryStringParameters?.home || "Man City";
    const awayTeam = body.away_team || event.queryStringParameters?.away || "Arsenal";
    const topN = body.top_n || 5;

    // Try Supabase first for real team stats
    let homeStat, awayStat;
    const supabaseMap = await getTeamStatsFromSupabase(homeTeam, awayTeam);
    if (supabaseMap) {
      homeStat = supabaseMap[homeTeam] || getTeamStat(homeTeam);
      awayStat = supabaseMap[awayTeam] || getTeamStat(awayTeam);
    } else {
      homeStat = getTeamStat(homeTeam);
      awayStat = getTeamStat(awayTeam);
    }

    const lambdaHome = ((homeStat.avg_scored + awayStat.avg_conceded) / 2) * 1.1; // home advantage
    const lambdaAway = (awayStat.avg_scored + homeStat.avg_conceded) / 2;
    const lambdaTotal = lambdaHome + lambdaAway;

    const correctScores = predictCorrectScore(lambdaHome, lambdaAway, 5);
    const totalProb = correctScores.reduce((s,c)=>s+c.prob,0) || 1;
    const normScores = correctScores.map(s=> ({ ...s, prob: s.prob / totalProb })).slice(0, topN);

    const ggProbVal = ggProb(lambdaHome, lambdaAway);

    const overUnder = {
      lambda_home: lambdaHome,
      lambda_away: lambdaAway,
      lambda_total: lambdaTotal,
      expected_total: lambdaTotal,
      ensemble: {
        over_0_5: overProb(lambdaTotal, 0.5),
        under_0_5: underProb(lambdaTotal, 0.5),
        over_1_5: overProb(lambdaTotal, 1.5),
        under_1_5: underProb(lambdaTotal, 1.5),
        over_2_5: overProb(lambdaTotal, 2.5),
        under_2_5: underProb(lambdaTotal, 2.5),
        over_3_5: overProb(lambdaTotal, 3.5),
        under_3_5: underProb(lambdaTotal, 3.5),
        gg_yes: ggProbVal,
        gg_no: 1 - ggProbVal,
        gg: ggProbVal,
        predicted_total: lambdaTotal,
        // compat keys
        "over_2.5": overProb(lambdaTotal, 2.5),
        "under_2.5": underProb(lambdaTotal, 2.5),
        "over_1.5": overProb(lambdaTotal, 1.5),
        "under_1.5": underProb(lambdaTotal, 1.5),
      },
      poisson: {
        over_0_5: overProb(lambdaTotal, 0.5),
        under_0_5: underProb(lambdaTotal, 0.5),
        over_1_5: overProb(lambdaTotal, 1.5),
        under_1_5: underProb(lambdaTotal, 1.5),
        over_2_5: overProb(lambdaTotal, 2.5),
        under_2_5: underProb(lambdaTotal, 2.5),
        over_3_5: overProb(lambdaTotal, 3.5),
        under_3_5: underProb(lambdaTotal, 3.5),
        gg_yes: ggProbVal,
        gg_no: 1 - ggProbVal,
      }
    };

    const over25 = overUnder.ensemble["over_2.5"];
    const over15 = overUnder.ensemble["over_1.5"];
    const under15 = overUnder.ensemble["under_1.5"];
    const ggYes = ggProbVal;
    
    function reco(prob) {
      if (prob >= 0.65) return "STRONG";
      if (prob >= 0.58) return "MODERATE";
      if (prob >= 0.52) return "WEAK";
      return "NO BET";
    }

    const recommendation = {
      over_2_5: reco(over25),
      over_1_5: reco(over15),
      under_1_5: reco(under15),
      gg: reco(ggYes),
      gg_yes: reco(ggYes),
      best_bet: over25 >= 0.6 ? "OVER 2.5" : ggYes >= 0.6 ? "GG YES" : under15 >= 0.6 ? "UNDER 1.5" : over15 >= 0.6 ? "OVER 1.5" : "NO CLEAR EDGE"
    };

    const response = {
      home_team: homeTeam,
      away_team: awayTeam,
      correct_score: {
        home_team: homeTeam,
        away_team: awayTeam,
        lambda_home: lambdaHome,
        lambda_away: lambdaAway,
        expected_total_goals: lambdaTotal,
        predictions: normScores.map(p=> ({ score: p.score, prob: p.prob, method: "poisson + netlify" })),
        poisson_baseline: normScores.map(p=> ({ score: p.score, prob: p.prob })),
        elo_diff: homeStat.elo - awayStat.elo
      },
      over_under: {
        ...overUnder,
        recommendation,
        ml: null,
        ensemble: {
          ...overUnder.ensemble,
          predicted_total: lambdaTotal,
          over_2_5: over25,
          over_1_5: over15,
          under_1_5: under15,
          gg_yes: ggYes,
          gg: ggYes,
        }
      },
      // New v4 ONLY Over 2.5, GG, Under 1.5
      over_2_5: over25,
      gg: ggYes,
      gg_yes: ggYes,
      under_1_5: under15,
      over_1_5: over15,
      predicted_total: lambdaTotal,
      best_bet: recommendation.best_bet,
      summary: {
        top_correct_score: normScores[0],
        over_2_5_prob: over25,
        over_1_5_prob: over15,
        under_1_5_prob: under15,
        gg_prob: ggYes,
        gg_yes_prob: ggYes,
        predicted_total_goals: lambdaTotal,
        recommendation,
        only: ["Over 2.5", "GG", "Under 1.5"]
      },
      source: "netlify-function-poisson-v4-Over2.5-GG-Under1.5",
      hosted_on: "netlify"
    };

    return { statusCode: 200, headers, body: JSON.stringify(response) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, stack: err.stack }) };
  }
};
