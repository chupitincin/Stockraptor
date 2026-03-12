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
