-- ═══════════════════════════════════════════════════
-- STOCKRAPTOR — Supabase Database Setup
-- Run this in Supabase → SQL Editor → New Query
-- ═══════════════════════════════════════════════════

-- 1. PROFILES TABLE (extends Supabase auth.users)
create table public.profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  email text,
  plan text default 'free' check (plan in ('free', 'pro', 'elite')),
  stripe_customer_id text,
  stripe_subscription_id text,
  plan_expires_at timestamptz,
  scans_today int default 0,
  last_scan_date date,
  created_at timestamptz default now()
);

-- 2. ROW LEVEL SECURITY
alter table public.profiles enable row level security;

create policy "Users can read own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- 3. AUTO-CREATE PROFILE ON SIGNUP
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, plan)
  values (new.id, new.email, 'free');
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 4. PLAN LIMITS VIEW (optional helper)
-- free:  40 companies, manual scan only
-- pro:   200 companies, daily email digest, AI summaries
-- elite: 200+ companies, 2x daily, AI chat


-- ══════════════════════════════════════════════════════════════
-- SCAN CACHE — resultados del análisis diario automático
-- ══════════════════════════════════════════════════════════════
create table if not exists public.scan_cache (
  id           text primary key default 'daily',
  scan_date    date not null,
  scanned_at   timestamptz not null default now(),
  results      jsonb not null default '[]',
  total_count  int  not null default 0,
  errors       int  not null default 0
);

-- Solo lectura pública (los usuarios pueden ver el caché)
alter table public.scan_cache enable row level security;

create policy "Anyone can read scan_cache"
  on public.scan_cache for select
  using (true);

-- Solo el service role puede escribir (el worker de GitHub Actions)
create policy "Service role can upsert scan_cache"
  on public.scan_cache for all
  using (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════
-- PICKS CACHE — picks semanales generados por el scan
-- ══════════════════════════════════════════════════════════════
create table if not exists public.picks_cache (
  id            text primary key default 'weekly',
  week_of       date,
  scan_date     date,
  generated_at  timestamptz not null default now(),
  picks         jsonb not null default '[]',
  total_count   int not null default 0
);

alter table public.picks_cache enable row level security;

create policy "Anyone can read picks_cache"
  on public.picks_cache for select using (true);

create policy "Service role can upsert picks_cache"
  on public.picks_cache for all using (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════
-- PICKS HISTORY — historial de picks con performance tracking
-- ══════════════════════════════════════════════════════════════
create table if not exists public.picks_history (
  id              bigint generated always as identity primary key,
  scan_date       date not null,
  sym             text not null,
  company_name    text,
  sector          text,
  pick_type       text,
  score           int,
  entry_price     numeric(12,4),
  ai_summary      text,
  -- Performance tracking
  perf_1d         numeric(8,2),
  perf_5d         numeric(8,2),
  perf_1w         numeric(8,2),
  perf_30d        numeric(8,2),
  perf_60d        numeric(8,2),
  perf_90d        numeric(8,2),
  -- Russell 2000 benchmark
  russell_30d     numeric(8,2),
  russell_60d     numeric(8,2),
  russell_90d     numeric(8,2),
  beat_30d        boolean,
  beat_60d        boolean,
  beat_90d        boolean,
  -- Signal breakdown for ML feedback
  score_fund      numeric(6,2),
  score_sent      numeric(6,2),
  score_analyst   numeric(6,2),
  score_momentum  numeric(6,2),
  score_earnings  numeric(6,2),
  score_volume    numeric(6,2),
  score_insider   numeric(6,2),
  flags_fired     text[],
  confluence      int,
  rel_strength    numeric(6,2),
  vol_ratio       numeric(6,2),
  fresh_insider   boolean,
  earnings_days   int,
  created_at      timestamptz default now(),
  unique(scan_date, sym)
);

alter table public.picks_history enable row level security;

create policy "Anyone can read picks_history"
  on public.picks_history for select using (true);

create policy "Service role can manage picks_history"
  on public.picks_history for all using (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════
-- SCAN HISTORY — rankings diarios para calcular deltas
-- ══════════════════════════════════════════════════════════════
create table if not exists public.scan_history (
  scan_date     date primary key,
  scanned_at    timestamptz not null default now(),
  rankings      text[] not null default '{}',
  total_count   int not null default 0
);

alter table public.scan_history enable row level security;

create policy "Anyone can read scan_history"
  on public.scan_history for select using (true);

create policy "Service role can manage scan_history"
  on public.scan_history for all using (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════
-- SCORING WEIGHTS — pesos dinámicos del scoring (ML optimizer)
-- ══════════════════════════════════════════════════════════════
create table if not exists public.scoring_weights (
  id            text primary key default 'active',
  w_fund        numeric(6,2) not null default 32,
  w_sent        numeric(6,2) not null default 8,
  w_analyst     numeric(6,2) not null default 15,
  w_momentum    numeric(6,2) not null default 17,
  w_earnings    numeric(6,2) not null default 15,
  w_volume      numeric(6,2) not null default 11,
  w_insider     numeric(6,2) not null default 8,
  version       int not null default 1,
  trained_on    int,
  win_rate_30d  numeric(5,2),
  win_rate_60d  numeric(5,2),
  notes         text,
  updated_at    timestamptz default now()
);

alter table public.scoring_weights enable row level security;

create policy "Anyone can read scoring_weights"
  on public.scoring_weights for select using (true);

create policy "Service role can manage scoring_weights"
  on public.scoring_weights for all using (auth.role() = 'service_role');

-- Insert default active row
insert into public.scoring_weights (id) values ('active') on conflict do nothing;


-- ══════════════════════════════════════════════════════════════
-- FEEDBACK LOG — propuestas de pesos del ML optimizer
-- ══════════════════════════════════════════════════════════════
create table if not exists public.feedback_log (
  id            bigint generated always as identity primary key,
  picks_count   int,
  win_rate_30d  numeric(5,2),
  win_rate_60d  numeric(5,2),
  old_weights   jsonb,
  new_weights   jsonb,
  top_signals   jsonb,
  notes         text,
  approved      boolean default false,
  created_at    timestamptz default now()
);

alter table public.feedback_log enable row level security;

create policy "Service role can manage feedback_log"
  on public.feedback_log for all using (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════
-- INSIDER CACHE — datos de insider trading del SEC EDGAR
-- ══════════════════════════════════════════════════════════════
create table if not exists public.insider_cache (
  symbol            text primary key,
  updated_at        timestamptz not null default now(),
  buys              int default 0,
  sells             int default 0,
  net_change        int default 0,
  total_buy_value   numeric(14,2) default 0,
  total_sell_value  numeric(14,2) default 0,
  transactions      jsonb default '[]',
  insiders          text[] default '{}'
);

alter table public.insider_cache enable row level security;

create policy "Anyone can read insider_cache"
  on public.insider_cache for select using (true);

create policy "Service role can manage insider_cache"
  on public.insider_cache for all using (auth.role() = 'service_role');
