-- Migration 002: rates for Extra Bed, Firewood and Gas (Yes/No on the booking form)
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to re-run.
-- Bookings themselves don't change: the amount is copied into the booking
-- when it's saved, so changing a rate later never changes past bookings.

create table if not exists public.settings (
  key        text primary key,
  value      numeric(12,2) not null check (value >= 0),
  updated_at timestamptz not null default now()
);

insert into public.settings (key, value) values
  ('extra_bed_rate', 500),
  ('firewood_rate', 600),
  ('gas_rate', 500)
on conflict (key) do nothing;

alter table public.settings enable row level security;

drop policy if exists "members read settings" on public.settings;
create policy "members read settings" on public.settings
  for select to authenticated using (public.is_active_member());

drop policy if exists "owner edits settings" on public.settings;
create policy "owner edits settings" on public.settings
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

do $$
begin
  begin alter publication supabase_realtime add table public.settings; exception when duplicate_object then null; end;
end $$;
