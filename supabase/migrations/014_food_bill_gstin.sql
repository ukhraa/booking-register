-- Migration 014: the guest's company and GSTIN on food bills too, so a business guest can claim the GST.
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to re-run. Needs migration 013 first.

alter table public.food_bills
  add column if not exists guest_company text not null default '',
  add column if not exists guest_gstin   text not null default '';

-- Check: should say 2.
select count(*) as new_columns from information_schema.columns
where table_name = 'food_bills' and column_name in ('guest_company', 'guest_gstin');
