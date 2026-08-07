-- Current Fixtures table for Auto-Updating Live Matches
-- Run this in Supabase SQL Editor: https://supabase.com/dashboard/project/hjxbftocxaalmqewmlxe/editor

create table if not exists current_fixtures (
    id bigserial primary key,
    home_team text not null,
    away_team text not null,
    league_name text default 'Instant Virtual',
    status text default 'upcoming', -- upcoming, live, finished
    timestamp timestamptz default now(),
    predictions_json jsonb, -- stores over 1.5 and over 2.5 predictions
    over_15_prob float,
    over_25_prob float,
    predicted_total float,
    best_bet text,
    source text default 'tampermonkey_live',
    created_at timestamptz default now(),
    expires_at timestamptz default now() + interval '10 minutes' -- auto expire after 10 mins
);

alter table current_fixtures enable row level security;
create policy "Allow all for anon current_fixtures" on current_fixtures for all using (true) with check (true);

create index if not exists idx_current_fixtures_timestamp on current_fixtures (timestamp desc);
create index if not exists idx_current_fixtures_expires on current_fixtures (expires_at);

-- Auto-delete expired fixtures (older than 10 mins)
create or replace function delete_expired_fixtures()
returns void as $$
begin
    delete from current_fixtures where expires_at < now() or timestamp < now() - interval '15 minutes';
end;
$$ language plpgsql;

-- View for live current matches (not expired)
create or replace view live_current_fixtures as
select * from current_fixtures
where expires_at > now() and timestamp > now() - interval '15 minutes'
order by timestamp desc, created_at desc;

-- Function to update team-stats not needed for current_fixtures
