-- Migration 010: guest phone number on bookings (for sending the bill on WhatsApp)
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to re-run.

alter table public.bookings
  add column if not exists guest_phone text not null default '';

-- Stays copied from the old diaries kept the phone number in the notes as
-- "Phone 9876543210": copy it into the new field where the field is empty.
update public.bookings
set guest_phone = substring(notes from 'Phone ([6-9][0-9]{9})')
where guest_phone = '' and notes ~ 'Phone [6-9][0-9]{9}';

-- Check: how many bookings now have a phone number.
select count(*) filter (where guest_phone <> '') as with_phone, count(*) as bookings from public.bookings;
