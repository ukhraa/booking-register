-- Migration 005: Extra Bed, Firewood and Gas are charged per day
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to re-run.
-- Adds a "days" number for each extra. The amount columns stay as they are
-- (amount = rate per day × days, worked out by the app when the booking is saved).

alter table public.bookings
  add column if not exists extra_bed_days smallint not null default 0 check (extra_bed_days between 0 and 365),
  add column if not exists firewood_days  smallint not null default 0 check (firewood_days  between 0 and 365),
  add column if not exists gas_days       smallint not null default 0 check (gas_days       between 0 and 365);

-- Bookings saved before this change were charged once per stay: count them as 1 day.
update public.bookings set extra_bed_days = 1 where extra_bed > 0 and extra_bed_days = 0;
update public.bookings set firewood_days  = 1 where firewood  > 0 and firewood_days  = 0;
update public.bookings set gas_days       = 1 where gas       > 0 and gas_days       = 0;
