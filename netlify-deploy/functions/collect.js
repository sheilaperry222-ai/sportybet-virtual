/**
 * Netlify Function: Collect real SportyBet results -> Supabase
 * Receives from Tampermonkey stealth collector (bypasses bot detection)
 * Now wired to Supabase!
 */

const { createClient } = require('@supabase/supabase-js');

exports.handler = async function(event, context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_KEY");
    // Still return success for demo if not configured, but warn
    // In production, set env vars in Netlify dashboard -> Site settings -> Environment variables
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { home_team, away_team, home_score, away_score, league_name, source, raw_json } = body;
    
    if (!home_team || !away_team || home_score === undefined || away_score === undefined) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing fields: home_team, away_team, home_score, away_score" }) };
    }

    // Determine 1X2 and over/under
    let result_1x2 = "X";
    if (home_score > away_score) result_1x2 = "1";
    else if (home_score < away_score) result_1x2 = "2";

    const matchData = {
      home_team: String(home_team).trim(),
      away_team: String(away_team).trim(),
      home_score: parseInt(home_score),
      away_score: parseInt(away_score),
      result_1x2,
      league_name: league_name || "Instant Virtual",
      source: source || "sportybet_stealth_netlify",
      raw_json: raw_json || body,
      match_id: `${home_team}_${away_team}_${home_score}${away_score}_${Date.now()}`,
    };

    // Save to Supabase if configured
    if (supabaseUrl && supabaseKey) {
      const supabase = createClient(supabaseUrl, supabaseKey);
      const { data, error } = await supabase.from('matches').insert([matchData]).select();
      if (error) {
        console.error("Supabase insert error:", error);
        // Check duplicate
        if (error.code === '23505') {
          return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: "Duplicate", match: body }) };
        }
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message, match: body }) };
      }
      console.log(`[COLLECT] Saved to Supabase: ${home_team} ${home_score}-${away_score} ${away_team}`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          match: body,
          saved_to: "supabase",
          supabase_id: data?.[0]?.id,
          bypass: "stealth via Tampermonkey - undetectable by SportyBet"
        })
      };
    } else {
      // No Supabase configured - log only (fallback for local testing)
      console.log(`[COLLECT] (No Supabase) ${home_team} ${home_score}-${away_score} ${away_team}`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          match: body,
          saved_to: "log-only (set SUPABASE_URL and SUPABASE_KEY in Netlify to enable persistence)",
          bypass: "stealth collector active, but no DB configured",
        })
      };
    }

  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, stack: err.stack }) };
  }
};
