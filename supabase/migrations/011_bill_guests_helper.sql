-- Migration 011: new bill details, guest register details, OTA booking emails,
-- Airbnb / Booking.com calendar check, and the Google helper (emails, calendars, backups).
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to re-run.

-- ── Bill: logo, bank and UPI details (owner edits them in Settings) ──
alter table public.business_profile
  add column if not exists trade_name        text not null default '',  -- shown large, e.g. "Two Seas Residence"
  add column if not exists logo              text not null default '',  -- PNG/JPEG data URL, kept small by Settings
  add column if not exists bank_account_name text not null default '',
  add column if not exists bank_account_no   text not null default '',
  add column if not exists bank_ifsc         text not null default '',
  add column if not exists bank_name         text not null default '',
  add column if not exists upi_id            text not null default '';

-- ── Guest register details on each booking ──
alter table public.bookings
  add column if not exists adults         smallint not null default 0 check (adults >= 0),
  add column if not exists children       smallint not null default 0 check (children >= 0),
  add column if not exists guest_address  text not null default '',
  add column if not exists nationality    text not null default '',   -- empty = Indian
  add column if not exists id_type        text not null default '',   -- Aadhaar, Passport, Driving licence, Voter ID, Other
  add column if not exists id_number      text not null default '',
  add column if not exists visa_no        text not null default '',   -- foreign guests (Form C)
  add column if not exists visa_expiry    date,
  add column if not exists arrived_india  date,
  add column if not exists ota_ref        text,                        -- OTA booking number from the booking email
  add column if not exists ota_commission numeric(12,2) not null default 0 check (ota_commission >= 0);
create unique index if not exists bookings_ota_ref_key on public.bookings (ota_ref) where ota_ref is not null and ota_ref <> '';
create index if not exists bookings_guest_phone_idx on public.bookings (guest_phone) where guest_phone <> '';

-- ── Helper key: the Google helper script proves itself with this ──
create table if not exists public.helper_key (
  id         smallint primary key default 1 check (id = 1),
  key        text not null check (length(key) >= 24),
  created_at timestamptz not null default now()
);
alter table public.helper_key enable row level security;
drop policy if exists "owner manages helper key" on public.helper_key;
create policy "owner manages helper key" on public.helper_key
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

create or replace function public.helper_ok(p_key text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.helper_key where id = 1 and key = p_key and length(coalesce(p_key, '')) >= 24);
$$;
revoke execute on function public.helper_ok(text) from public, anon, authenticated;

-- ── OTA booking emails (from AxisRooms), waiting to be read by the app ──
create table if not exists public.ota_inbox (
  id          uuid primary key default gen_random_uuid(),
  message_id  text not null unique,
  subject     text not null default '',
  body        text not null default '',
  received_at timestamptz not null default now(),
  status      text not null default 'new' check (status in ('new', 'done', 'review', 'ignored')),
  kind        text not null default '',         -- booking, modification, cancellation, other
  ota_ref     text not null default '',
  booking_id  uuid references public.bookings (id) on delete set null,
  note        text not null default '',
  handled_at  timestamptz,
  handled_by  uuid references auth.users (id) on delete set null
);
create index if not exists ota_inbox_status_idx on public.ota_inbox (status, received_at);
alter table public.ota_inbox enable row level security;
drop policy if exists "members read ota inbox" on public.ota_inbox;
create policy "members read ota inbox" on public.ota_inbox
  for select to authenticated using (public.is_active_member());
drop policy if exists "members update ota inbox" on public.ota_inbox;
create policy "members update ota inbox" on public.ota_inbox
  for update to authenticated using (public.is_active_member()) with check (public.is_active_member());

create or replace function public.helper_add_email(p_key text, p_message_id text, p_subject text, p_body text, p_received_at timestamptz)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.helper_ok(p_key) then raise exception 'Wrong helper key'; end if;
  insert into public.ota_inbox (message_id, subject, body, received_at)
  values (left(p_message_id, 300), left(coalesce(p_subject, ''), 500), left(coalesce(p_body, ''), 100000), coalesce(p_received_at, now()))
  on conflict (message_id) do nothing;
  return found;
end;
$$;

-- ── Airbnb / Booking.com calendars (iCal links per apartment) ──
create table if not exists public.ical_links (
  house_id     smallint not null references public.houses (id) on delete cascade,
  source       text not null check (source in ('Airbnb', 'Booking.com', 'Other')),
  url          text not null check (url ~ '^https://'),
  last_fetched timestamptz,
  last_error   text not null default '',
  primary key (house_id, source)
);
alter table public.ical_links enable row level security;
drop policy if exists "members read ical links" on public.ical_links;
create policy "members read ical links" on public.ical_links
  for select to authenticated using (public.is_active_member());
drop policy if exists "owner edits ical links" on public.ical_links;
create policy "owner edits ical links" on public.ical_links
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

create table if not exists public.ota_calendar (
  house_id   smallint not null references public.houses (id) on delete cascade,
  source     text not null,
  start_date date not null,
  end_date   date not null,          -- first free night, like check-out
  summary    text not null default '',
  primary key (house_id, source, start_date, end_date)
);
alter table public.ota_calendar enable row level security;
drop policy if exists "members read ota calendar" on public.ota_calendar;
create policy "members read ota calendar" on public.ota_calendar
  for select to authenticated using (public.is_active_member());

create or replace function public.helper_ical_links(p_key text)
returns table (house_id smallint, source text, url text) language plpgsql security definer set search_path = public as $$
begin
  if not public.helper_ok(p_key) then raise exception 'Wrong helper key'; end if;
  return query select l.house_id, l.source, l.url from public.ical_links l order by 1, 2;
end;
$$;

-- p_events: [{"start":"2026-12-01","end":"2026-12-03","summary":"Reserved"}, ...]; p_error set when fetching failed.
create or replace function public.helper_save_calendar(p_key text, p_house_id smallint, p_source text, p_events jsonb, p_error text default '')
returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0;
begin
  if not public.helper_ok(p_key) then raise exception 'Wrong helper key'; end if;
  if coalesce(p_error, '') <> '' then
    update public.ical_links set last_error = left(p_error, 300), last_fetched = now() where house_id = p_house_id and source = p_source;
    return 0;
  end if;
  delete from public.ota_calendar where house_id = p_house_id and source = p_source;
  insert into public.ota_calendar (house_id, source, start_date, end_date, summary)
  select p_house_id, p_source, (e->>'start')::date, (e->>'end')::date, left(coalesce(e->>'summary', ''), 200)
    from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) e
   where (e->>'end')::date > (e->>'start')::date
  on conflict do nothing;
  get diagnostics n = row_count;
  update public.ical_links set last_error = '', last_fetched = now() where house_id = p_house_id and source = p_source;
  return n;
end;
$$;

-- ── Weekly backup: everything the app keeps, as one JSON document ──
create or replace function public.helper_backup(p_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  result jsonb := jsonb_build_object('made_at', now());
  part   jsonb;
  t      text;
begin
  if not public.helper_ok(p_key) then raise exception 'Wrong helper key'; end if;
  foreach t in array array['houses', 'bookings', 'settings', 'business_profile', 'profiles', 'monthly_history',
                           'monthly_food_income', 'expense_categories', 'monthly_expenses', 'daily_expenses',
                           'closed_dates', 'ical_links', 'ota_inbox']
  loop
    if to_regclass('public.' || t) is not null then
      execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from public.%I x', t) into part;
      result := result || jsonb_build_object(t, part);
    end if;
  end loop;
  return result;
end;
$$;

-- The helper signs in with nothing but its key: these four are all it can call.
revoke execute on function public.helper_add_email(text, text, text, text, timestamptz) from public;
revoke execute on function public.helper_ical_links(text) from public;
revoke execute on function public.helper_save_calendar(text, smallint, text, jsonb, text) from public;
revoke execute on function public.helper_backup(text) from public;
grant execute on function public.helper_add_email(text, text, text, text, timestamptz) to anon, authenticated;
grant execute on function public.helper_ical_links(text) to anon, authenticated;
grant execute on function public.helper_save_calendar(text, smallint, text, jsonb, text) to anon, authenticated;
grant execute on function public.helper_backup(text) to anon, authenticated;

do $$
begin
  begin alter publication supabase_realtime add table public.ota_inbox;    exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.ota_calendar; exception when duplicate_object then null; end;
end $$;

-- Check: should say 4.
select count(*) as helper_functions from pg_proc where proname in ('helper_add_email', 'helper_ical_links', 'helper_save_calendar', 'helper_backup');
