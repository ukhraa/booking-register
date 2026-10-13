-- Booking Register — Supabase schema
-- Run this once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Safe to re-run: it only creates what is missing.

-- ─────────────────────────────────────────────────────────────
-- Staff profiles (one per login). The first account created becomes the owner.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  full_name  text not null default '',
  role       text not null default 'staff' check (role in ('owner', 'staff')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    case when exists (select 1 from public.profiles) then 'staff' else 'owner' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Role helpers used by the security rules below
create or replace function public.is_active_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active);
$$;

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role = 'owner');
$$;

-- ─────────────────────────────────────────────────────────────
-- Apartments (6). Rename them from the app's Settings screen.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.houses (
  id         smallint primary key check (id between 1 and 50),
  name       text not null,
  sort_order smallint not null default 0,
  active     boolean not null default true
);

insert into public.houses (id, name, sort_order) values
  (1, 'Apartment 1', 1), (2, 'Apartment 2', 2), (3, 'Apartment 3', 3),
  (4, 'Apartment 4', 4), (5, 'Apartment 5', 5), (6, 'Apartment 6', 6)
on conflict (id) do nothing;

-- ─────────────────────────────────────────────────────────────
-- Bookings. Figures marked "calculated" are worked out by the database
-- so every phone and every export shows the same numbers.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.bookings (
  id             uuid primary key default gen_random_uuid(),
  serial         integer not null unique,
  house_id       smallint not null references public.houses (id),
  booking_type   text not null default 'Direct',
  guest_name     text not null check (length(trim(guest_name)) > 0),
  check_in       date not null,
  check_out      date not null,
  nights         integer generated always as (check_out - check_in) stored,           -- calculated

  tariff         numeric(12,2) not null default 0 check (tariff >= 0),                -- whole stay, before GST
  gst_pct        numeric(5,2)  not null default 0 check (gst_pct between 0 and 28),
  gst_amount     numeric(12,2) generated always as (round(tariff * gst_pct / 100, 2)) stored,          -- calculated
  total_tariff   numeric(12,2) generated always as (tariff + round(tariff * gst_pct / 100, 2)) stored, -- calculated
  bill_no        text not null default '',

  food_bill      numeric(12,2) not null default 0 check (food_bill >= 0),
  extra_bed      numeric(12,2) not null default 0 check (extra_bed >= 0),
  firewood       numeric(12,2) not null default 0 check (firewood >= 0),
  gas            numeric(12,2) not null default 0 check (gas >= 0),
  gross_total    numeric(12,2) generated always as (
                   tariff + round(tariff * gst_pct / 100, 2) + food_bill + extra_bed + firewood + gas
                 ) stored,                                                                              -- calculated

  advance_ota    numeric(12,2) not null default 0 check (advance_ota >= 0),
  total_balance  numeric(12,2) generated always as (
                   tariff + round(tariff * gst_pct / 100, 2) + food_bill + extra_bed + firewood + gas - advance_ota
                 ) stored,                                                                              -- calculated
  paid_cash      numeric(12,2) not null default 0 check (paid_cash >= 0),
  cash_received  numeric(12,2) not null default 0 check (cash_received >= 0),
  tips           numeric(12,2) not null default 0 check (tips >= 0),
  paid_upi       numeric(12,2) not null default 0 check (paid_upi >= 0),
  total_balanced boolean generated always as (
                   abs((paid_cash + paid_upi)
                       - (tariff + round(tariff * gst_pct / 100, 2) + food_bill + extra_bed + firewood + gas - advance_ota)) < 0.5
                 ) stored,                                                                              -- calculated
  notes          text not null default '',

  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid() references public.profiles (id),
  updated_at     timestamptz not null default now(),
  updated_by     uuid default auth.uid() references public.profiles (id),

  constraint check_out_after_check_in check (check_out > check_in)
);

create index if not exists bookings_check_in_idx on public.bookings (check_in);
create index if not exists bookings_house_dates_idx on public.bookings (house_id, check_in, check_out);

-- Fill in the next serial number when none is given, and stamp who changed what.
create or replace function public.bookings_before_write()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and new.serial is null then
    perform pg_advisory_xact_lock(hashtext('bookings_serial'));
    select coalesce(max(serial), 0) + 1 into new.serial from public.bookings;
  end if;
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists bookings_before_write on public.bookings;
create trigger bookings_before_write
  before insert or update on public.bookings
  for each row execute function public.bookings_before_write();

-- ─────────────────────────────────────────────────────────────
-- Security rules
--   Owner: everything, including deleting bookings, renaming apartments, managing staff.
--   Staff: view, add and edit bookings.
--   Anyone not signed in, or switched off by the owner: nothing.
-- ─────────────────────────────────────────────────────────────
alter table public.profiles enable row level security;
alter table public.houses   enable row level security;
alter table public.bookings enable row level security;

drop policy if exists "read own or owner reads all" on public.profiles;
create policy "read own or owner reads all" on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_owner());

drop policy if exists "owner manages staff" on public.profiles;
create policy "owner manages staff" on public.profiles
  for update to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists "members read houses" on public.houses;
create policy "members read houses" on public.houses
  for select to authenticated using (public.is_active_member());

drop policy if exists "owner edits houses" on public.houses;
create policy "owner edits houses" on public.houses
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists "members read bookings" on public.bookings;
create policy "members read bookings" on public.bookings
  for select to authenticated using (public.is_active_member());

drop policy if exists "members add bookings" on public.bookings;
create policy "members add bookings" on public.bookings
  for insert to authenticated with check (public.is_active_member());

drop policy if exists "members edit bookings" on public.bookings;
create policy "members edit bookings" on public.bookings
  for update to authenticated using (public.is_active_member()) with check (public.is_active_member());

drop policy if exists "owner deletes bookings" on public.bookings;
create policy "owner deletes bookings" on public.bookings
  for delete to authenticated using (public.is_owner());

-- Stop an owner from accidentally removing the last owner
create or replace function public.keep_one_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (old.role = 'owner' and old.active)
     and (new.role <> 'owner' or not new.active)
     and not exists (select 1 from public.profiles where role = 'owner' and active and id <> old.id) then
    raise exception 'There must be at least one active owner.';
  end if;
  return new;
end;
$$;

drop trigger if exists keep_one_owner on public.profiles;
create trigger keep_one_owner
  before update on public.profiles
  for each row execute function public.keep_one_owner();

-- ─────────────────────────────────────────────────────────────
-- Live updates: phones see each other's changes without refreshing.
-- ─────────────────────────────────────────────────────────────
do $$
begin
  begin alter publication supabase_realtime add table public.bookings; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.houses;   exception when duplicate_object then null; end;
end $$;
