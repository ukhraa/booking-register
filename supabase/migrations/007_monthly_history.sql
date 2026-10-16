-- Migration 007: monthly history from before the app (Occ_x_Rev_data.xlsx)
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to re-run.
-- This creates the table only. The figures themselves (January 2023 to September
-- 2026) are loaded from a private file sent to the owner, so they aren't public.
--
-- One row per apartment per month: nights booked, nights the apartment was
-- open, and room revenue before GST. The Performance tab uses these figures for
-- any month listed here, and app bookings for every other month.
-- An apartment with 0 nights available that month was closed.

create table if not exists public.monthly_history (
  house_id         smallint not null references public.houses (id) on delete cascade,
  ym               text not null check (ym ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  nights_booked    integer not null check (nights_booked >= 0),
  nights_available integer not null check (nights_available >= 0),
  room_revenue     numeric(12,2) not null default 0 check (room_revenue >= 0),
  primary key (house_id, ym),
  check (nights_booked <= nights_available or nights_available = 0)
);

alter table public.monthly_history enable row level security;

drop policy if exists "members read history" on public.monthly_history;
create policy "members read history" on public.monthly_history
  for select to authenticated using (public.is_active_member());

drop policy if exists "owner edits history" on public.monthly_history;
create policy "owner edits history" on public.monthly_history
  for all to authenticated using (public.is_owner()) with check (public.is_owner());
