-- Migration 009: room for the 2023–2026 booking diaries
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to re-run.
-- Then run the two private import files (bookings, expenses) you were sent.
-- The data itself is not in this repo: it has guest names, phone numbers and salaries.
--
--  bookings.from_diary   stays copied from the old diaries: room revenue before GST
--                        only (no GST, extras or payment split). They count in
--                        bookings, nights and revenue, but not in balances or "unpaid".
--  monthly_food_income   kitchen income per month from the diaries, so profit for
--                        those months counts food as well as rooms.
--  closed_dates          dates an apartment (or all of them) is closed, or closed to
--                        direct bookings only. Shown on the Availability grid; the
--                        booking form warns when a booking falls on them.

alter table public.bookings
  add column if not exists from_diary boolean not null default false;

create table if not exists public.monthly_food_income (
  ym     text primary key check (ym ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  amount numeric(12,2) not null default 0 check (amount >= 0)
);
alter table public.monthly_food_income enable row level security;
drop policy if exists "members read food income" on public.monthly_food_income;
create policy "members read food income" on public.monthly_food_income
  for select to authenticated using (public.is_active_member());
drop policy if exists "owner edits food income" on public.monthly_food_income;
create policy "owner edits food income" on public.monthly_food_income
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

create table if not exists public.closed_dates (
  id          uuid primary key default gen_random_uuid(),
  house_id    smallint references public.houses (id) on delete cascade, -- empty = all apartments
  start_date  date not null,
  end_date    date not null,           -- like check-out: the first night it is open again
  direct_only boolean not null default false, -- true = closed to direct bookings only (OTAs still sell)
  note        text not null default '',
  created_at  timestamptz not null default now(),
  constraint closed_dates_order check (end_date > start_date)
);
create index if not exists closed_dates_dates_idx on public.closed_dates (start_date, end_date);
alter table public.closed_dates enable row level security;
drop policy if exists "members read closed dates" on public.closed_dates;
create policy "members read closed dates" on public.closed_dates
  for select to authenticated using (public.is_active_member());
drop policy if exists "owner edits closed dates" on public.closed_dates;
create policy "owner edits closed dates" on public.closed_dates
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

-- Kitchen gets a monthly amount too (the diaries kept one total per month);
-- daily kitchen entries still add to it. Tripadvisor was a line in the diaries.
update public.expense_categories set monthly = true where name = 'Kitchen';
insert into public.expense_categories (name, monthly, daily, sort_order) values ('Tripadvisor', true, false, 32)
on conflict (name) do nothing;

do $$
begin
  begin alter publication supabase_realtime add table public.closed_dates; exception when duplicate_object then null; end;
end $$;

-- Check: should say true, 2 and 1.
select
  exists (select 1 from information_schema.columns where table_name = 'bookings' and column_name = 'from_diary') as diary_column,
  (select count(*) from information_schema.tables where table_name in ('monthly_food_income', 'closed_dates')) as new_tables,
  (select count(*) from public.expense_categories where name = 'Tripadvisor') as tripadvisor;
