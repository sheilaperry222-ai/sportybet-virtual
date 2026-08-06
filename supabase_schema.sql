-- Supabase Schema for SportyBet Virtual Data Center
-- Run this in Supabase SQL Editor

-- Enable extensions
create extension if not exists "uuid-ossp";

-- Matches table (real SportyBet instant virtual results)
create table if not exists matches (
    id bigserial primary key,
    match_id text unique,
    season int default 1,
    matchday int default 1,
    timestamp timestamptz default now(),
    home_team text not null,
    away_team text not null,
    home_score int not null,
    away_score int not null,
    correct_score text generated always as (home_score || '-' || away_score) stored,
    result_1x2 text, -- 1, X, 2
    total_goals int generated always as (home_score + away_score) stored,
    over_25 boolean generated always as ((home_score + away_score) > 2) stored,
    under_15 boolean generated always as ((home_score + away_score) <= 1) stored,
    league_name text default 'Virtual Premier League',
    source text default 'sportybet_instant',
    raw_json jsonb,
    created_at timestamptz default now()
);

-- Team stats (materialized view logic, updated via trigger)
create table if not exists team_stats (
    team_name text primary key,
    matches_played int default 0,
    wins int default 0,
    draws int default 0,
    losses int default 0,
    goals_scored int default 0,
    goals_conceded int default 0,
    avg_scored float default 0,
    avg_conceded float default 0,
    elo_rating float default 1500,
    updated_at timestamptz default now()
);

-- Predictions log (for backtesting)
create table if not exists predictions (
    id bigserial primary key,
    timestamp timestamptz default now(),
    home_team text not null,
    away_team text not null,
    predicted_scores_json jsonb,
    top_prediction text,
    over_25_prob float,
    under_15_prob float,
    predicted_total float,
    confidence float,
    actual_score text,
    hit boolean,
    model_version text default 'v2',
    source text default 'netlify',
    created_at timestamptz default now()
);

-- Enable RLS
alter table matches enable row level security;
alter table team_stats enable row level security;
alter table predictions enable row level security;

-- Policies: allow all for anon (for demo) - restrict in production!
create policy "Allow all for anon matches" on matches for all using (true) with check (true);
create policy "Allow all for anon team_stats" on team_stats for all using (true) with check (true);
create policy "Allow all for anon predictions" on predictions for all using (true) with check (true);

-- Indexes for fast queries
create index if not exists idx_matches_timestamp on matches (timestamp desc);
create index if not exists idx_matches_home_team on matches (home_team);
create index if not exists idx_matches_away_team on matches (away_team);
create index if not exists idx_matches_total_goals on matches (total_goals);

-- Function to auto-update team stats on insert
create or replace function update_team_stats()
returns trigger as $$
begin
    -- Insert teams if not exist
    insert into team_stats (team_name) values (NEW.home_team) on conflict (team_name) do nothing;
    insert into team_stats (team_name) values (NEW.away_team) on conflict (team_name) do nothing;

    -- Update home team
    update team_stats set
        matches_played = matches_played + 1,
        wins = wins + case when NEW.home_score > NEW.away_score then 1 else 0 end,
        draws = draws + case when NEW.home_score = NEW.away_score then 1 else 0 end,
        losses = losses + case when NEW.home_score < NEW.away_score then 1 else 0 end,
        goals_scored = goals_scored + NEW.home_score,
        goals_conceded = goals_conceded + NEW.away_score,
        updated_at = now()
    where team_name = NEW.home_team;

    -- Update away team
    update team_stats set
        matches_played = matches_played + 1,
        wins = wins + case when NEW.away_score > NEW.home_score then 1 else 0 end,
        draws = draws + case when NEW.away_score = NEW.home_score then 1 else 0 end,
        losses = losses + case when NEW.away_score < NEW.home_score then 1 else 0 end,
        goals_scored = goals_scored + NEW.away_score,
        goals_conceded = goals_conceded + NEW.home_score,
        updated_at = now()
    where team_name = NEW.away_team;

    -- Update averages
    update team_stats set
        avg_scored = goals_scored::float / nullif(matches_played,0),
        avg_conceded = goals_conceded::float / nullif(matches_played,0)
    where team_name in (NEW.home_team, NEW.away_team);

    return NEW;
end;
$$ language plpgsql;

-- Trigger
drop trigger if exists trg_update_team_stats on matches;
create trigger trg_update_team_stats after insert on matches for each row execute function update_team_stats();

-- View for score frequency
create or replace view score_frequency as
select 
    correct_score,
    count(*) as count,
    count(*)::float / (select count(*) from matches) as frequency,
    max(timestamp) as last_seen
from matches
group by correct_score
order by count desc;

-- View for over/under rates
create or replace view over_under_rates as
select
    count(*) as total,
    avg(total_goals) as avg_goals,
    sum(case when total_goals > 2 then 1 else 0 end)::float / count(*) as over_25_rate,
    sum(case when total_goals <= 1 then 1 else 0 end)::float / count(*) as under_15_rate
from matches;
