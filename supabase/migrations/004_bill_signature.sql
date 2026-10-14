-- Migration 004: signature on the guest bill
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to re-run.
-- The owner uploads it in Settings → Bill details. It's kept in the database
-- (not in the public GitHub repo), so only signed-in staff can see it.

alter table public.business_profile
  add column if not exists signature text not null default ''
  check (signature = '' or (signature like 'data:image/png;base64,%' and length(signature) < 300000));
