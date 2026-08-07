/**
 * Netlify Function: Current Fixtures - Auto-Updating Live Matches
 * Stores current SportyBet Instant Virtual fixtures detected by Tampermonkey
 * and returns them with Over 2.5 + Over 1.5 predictions
 */

const { createClient } = require('@supabase/supabase-js');

exports.handler = async function(event, context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing SUPABASE_URL/KEY" }) };
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // GET - Return live current fixtures (not expired)
  if (event.httpMethod === "GET") {
    try {
      // Try view live_current_fixtures first, fallback to table
      let data, error;
      try {
        const res = await supabase.from('live_current_fixtures').select('*').order('timestamp', { ascending: false }).limit(20);
        data = res.data; error = res.error;
        if (error) throw error;
      } catch {
        // Fallback to table with manual expiry filter
        const res = await supabase.from('current_fixtures').select('*').gt('expires_at', new Date().toISOString()).order('timestamp', { ascending: false }).limit(20);
        data = res.data; error = res.error;
      }

      if (error) {
        // If table doesn't exist, return empty with message
        if (error.message.includes("does not exist") || error.code === 'PGRST205') {
          return {
            statusCode: 200, headers,
            body: JSON.stringify({
              fixtures: [],
              count: 0,
              message: "current_fixtures table not created yet - Run supabase_current_fixtures.sql in Supabase SQL Editor",
              supabase_url: "https://supabase.com/dashboard/project/hjxbftocxaalmqewmlxe/editor - paste supabase_current_fixtures.sql"
            })
          };
        }
        throw error;
      }

      // Delete expired in background (don't wait)
      supabase.from('current_fixtures').delete().lt('expires_at', new Date().toISOString()).then(()=>{}).catch(()=>{});

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          fixtures: data || [],
          count: data?.length || 0,
          source: "supabase_current_fixtures",
          timestamp: new Date().toISOString()
        })
      };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, stack: err.stack }) };
    }
  }

  // POST - Save current fixtures detected by Tampermonkey
  if (event.httpMethod === "POST") {
    try {
      const body = JSON.parse(event.body || "{}");
      let fixtures = body.fixtures || body.matches || [body];

      if (!Array.isArray(fixtures)) fixtures = [fixtures];

      // Filter valid
      fixtures = fixtures.filter(f => f.home_team && f.away_team);

      if (fixtures.length === 0) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "No valid fixtures: need home_team and away_team" }) };
      }

      // Delete old fixtures from same source (cleanup)
      try {
        await supabase.from('current_fixtures').delete().eq('source', body.source || 'tampermonkey_live').lt('timestamp', new Date(Date.now() - 5*60*1000).toISOString());
      } catch {}

      // For each fixture, get prediction from our own predict function logic (Poisson from team stats)
      // We'll compute Over 1.5 and Over 2.5 using team stats from Supabase team_stats if available
      const teamStatsMap = {};
      try {
        const { data: teams } = await supabase.from('team_stats').select('*');
        if (teams) teams.forEach(t => { teamStatsMap[t.team_name] = t; });
      } catch {}

      function poissonProb(lambda, k) {
        let fact = 1; for (let i=2;i<=k;i++) fact*=i;
        return (Math.pow(lambda,k) * Math.exp(-lambda))/fact;
      }
      function overProb(lambdaTotal, line) {
        const thr = Math.floor(line); let cdf=0; for(let k=0;k<=thr;k++) cdf+=poissonProb(lambdaTotal,k); return 1-cdf;
      }
      function ggProb(lh, la) { return (1-Math.exp(-lh))*(1-Math.exp(-la)); }

      const toInsert = fixtures.slice(0,15).map(f => {
        const homeTeam = f.home_team || f.home;
        const awayTeam = f.away_team || f.away;
        const homeStat = teamStatsMap[homeTeam] || { avg_scored: 1.0, avg_conceded: 1.0 };
        const awayStat = teamStatsMap[awayTeam] || { avg_scored: 1.0, avg_conceded: 1.0 };
        const lambdaHome = ((homeStat.avg_scored + awayStat.avg_conceded)/2)*1.1;
        const lambdaAway = (awayStat.avg_scored + homeStat.avg_conceded)/2;
        const lambdaTotal = lambdaHome + lambdaAway;
        const over15 = overProb(lambdaTotal, 1.5);
        const over25 = overProb(lambdaTotal, 2.5);
        const under15 = 1 - over15;
        const gg = ggProb(lambdaHome, lambdaAway);
        
        function reco(p){ if(p>=0.65) return "STRONG"; if(p>=0.58) return "MODERATE"; if(p>=0.52) return "WEAK"; return "NO BET"; }

        return {
          home_team: homeTeam,
          away_team: awayTeam,
          league_name: f.league_name || "Instant Virtual",
          status: f.status || "upcoming",
          timestamp: f.timestamp || new Date().toISOString(),
          predictions_json: {
            home_team: homeTeam,
            away_team: awayTeam,
            lambda_home: lambdaHome,
            lambda_away: lambdaAway,
            lambda_total: lambdaTotal,
            over_1_5: over15,
            over_2_5: over25,
            under_1_5: under15,
            gg: gg,
            gg_yes: gg,
            predicted_total: lambdaTotal,
            recommendation: { over_1_5: reco(over15), over_2_5: reco(over25), under_1_5: reco(under15), gg: reco(gg), best_bet: over25>=0.6 ? "OVER 2.5" : gg>=0.6 ? "GG YES" : under15>=0.6 ? "UNDER 1.5" : "NO CLEAR" }
          },
          over_15_prob: over15,
          over_25_prob: over25,
          under_15_prob: under15,
          gg_prob: gg,
          predicted_total: lambdaTotal,
          best_bet: over25>=0.6 ? "OVER 2.5" : gg>=0.6 ? "GG YES" : under15>=0.6 ? "UNDER 1.5" : "NO CLEAR",
          source: body.source || f.source || "tampermonkey_live",
          expires_at: new Date(Date.now() + 24*60*60*1000).toISOString() // 60 mins expiry - increased from 10 for demo persistence
        };
      });

      const { data, error } = await supabase.from('current_fixtures').insert(toInsert).select();

      if (error) {
        // If table doesn't exist, return helpful message
        if (error.message.includes("does not exist") || error.code === 'PGRST205') {
          return {
            statusCode: 200, headers,
            body: JSON.stringify({
              success: false,
              message: "current_fixtures table not exists - Run supabase_current_fixtures.sql in Supabase SQL Editor: https://supabase.com/dashboard/project/hjxbftocxaalmqewmlxe/editor",
              fixtures_received: fixtures.length,
              predictions: toInsert,
              fix_sql: "CREATE TABLE current_fixtures ... (see supabase_current_fixtures.sql file)"
            })
          };
        }
        throw error;
      }

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          success: true,
          count: data.length,
          fixtures: data,
          message: `Saved ${data.length} current fixtures - Auto-expires in 10 mins, site will display ONLY Over 2.5 and Over 1.5`
        })
      };

    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, stack: err.stack }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
};
