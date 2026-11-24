-- Migration 012: the guest's company and GSTIN on the bill, so a business guest can claim the GST.
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to re-run.

alter table public.bookings
  add column if not exists guest_company text not null default '',   -- legal name as on the guest's GST registration
  add column if not exists guest_gstin   text not null default '';   -- 15 characters, checked by the app

-- Check: should say 2.
select count(*) as new_columns from information_schema.columns
where table_name = 'bookings' and column_name in ('guest_company', 'guest_gstin');
