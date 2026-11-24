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

-- Colour on the Availability grid (migration 006)
alter table public.houses
  add column if not exists color text not null default ''
  check (color in ('', 'red', 'green', 'blue', 'grey', 'orange', 'purple', 'teal', 'pink', 'yellow'));

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
  -- Days each extra was used; amount above = rate per day × days (set by the app)
  extra_bed_days smallint not null default 0 check (extra_bed_days between 0 and 365),
  firewood_days  smallint not null default 0 check (firewood_days  between 0 and 365),
  gas_days       smallint not null default 0 check (gas_days       between 0 and 365),
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

-- Databases created before the per-day extras: add the day columns (migration 005).
alter table public.bookings
  add column if not exists extra_bed_days smallint not null default 0 check (extra_bed_days between 0 and 365),
  add column if not exists firewood_days  smallint not null default 0 check (firewood_days  between 0 and 365),
  add column if not exists gas_days       smallint not null default 0 check (gas_days       between 0 and 365);

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
-- Rates per day for the extras (Extra Bed, Firewood, Gas) on the booking form.
-- The owner edits them in Settings.
-- The amount is copied into the booking when saved, so changing a rate
-- never changes past bookings.
-- ─────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────
-- Guest bill: business details printed on the bill (owner edits them in
-- Settings) and automatic bill numbers like TSR/26-27/0001, counted per
-- financial year (April–March, by check-out date).
-- ─────────────────────────────────────────────────────────────
create table if not exists public.business_profile (
  id             smallint primary key default 1 check (id = 1),
  legal_name     text not null default '',
  address        text not null default '',
  phone          text not null default '',
  email          text not null default '',
  gstin          text not null default ''
                 check (gstin = '' or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  state          text not null default '',
  invoice_prefix text not null default 'TSR' check (invoice_prefix ~ '^[A-Za-z0-9]{0,5}$'),
  footer_note    text not null default 'Thank you for staying with us.',
  -- PNG data URL printed above "Authorised signatory"; kept here, not in the public repo
  signature      text not null default ''
                 check (signature = '' or (signature like 'data:image/png;base64,%' and length(signature) < 300000)),
  updated_at     timestamptz not null default now()
);

insert into public.business_profile (id, legal_name) values (1, 'Two Seas Residence')
on conflict (id) do nothing;

alter table public.business_profile enable row level security;

drop policy if exists "members read business profile" on public.business_profile;
create policy "members read business profile" on public.business_profile
  for select to authenticated using (public.is_active_member());

drop policy if exists "owner edits business profile" on public.business_profile;
create policy "owner edits business profile" on public.business_profile
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

-- Runs with the caller's rights, so only active staff and owners can use it.
create or replace function public.assign_bill_no(p_booking uuid)
returns text language plpgsql set search_path = public as $$
declare
  v_bill   text;
  v_out    date;
  v_prefix text;
  v_fy     int;
  v_next   int;
begin
  perform pg_advisory_xact_lock(hashtext('bookings_bill_no'));

  select bill_no, check_out into v_bill, v_out from public.bookings where id = p_booking;
  if not found then raise exception 'Booking not found'; end if;
  if v_bill <> '' then return v_bill; end if;

  v_fy := extract(year from v_out)::int - case when extract(month from v_out) < 4 then 1 else 0 end;
  select trim(invoice_prefix) into v_prefix from public.business_profile where id = 1;
  v_prefix := case when coalesce(v_prefix, '') = '' then '' else v_prefix || '/' end
              || lpad((v_fy % 100)::text, 2, '0') || '-' || lpad(((v_fy + 1) % 100)::text, 2, '0') || '/';

  select coalesce(max(substr(bill_no, length(v_prefix) + 1)::int), 0) + 1 into v_next
    from public.bookings
   where left(bill_no, length(v_prefix)) = v_prefix
     and substr(bill_no, length(v_prefix) + 1) ~ '^[0-9]{1,9}$';

  v_bill := v_prefix || lpad(v_next::text, 4, '0');
  update public.bookings set bill_no = v_bill where id = p_booking;
  return v_bill;
end;
$$;

revoke execute on function public.assign_bill_no(uuid) from public, anon;
grant execute on function public.assign_bill_no(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────
-- Monthly history from before the app (migration 007 also loads the data).
-- The Performance tab uses it for any month listed, app bookings otherwise.
-- ─────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────
-- Expenses (migration 008)
-- ─────────────────────────────────────────────────────────────
create table if not exists public.expense_categories (
  id         smallint generated by default as identity primary key,
  name       text not null unique check (length(trim(name)) > 0),
  monthly    boolean not null default true,
  daily      boolean not null default false,
  sort_order smallint not null default 100,
  active     boolean not null default true
);

create table if not exists public.monthly_expenses (
  category_id smallint not null references public.expense_categories (id) on delete cascade,
  ym          text not null check (ym ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  amount      numeric(12,2) not null default 0 check (amount >= 0),
  note        text not null default '',
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid() references public.profiles (id),
  primary key (category_id, ym)
);

create table if not exists public.daily_expenses (
  id          uuid primary key default gen_random_uuid(),
  spent_on    date not null,
  category_id smallint not null references public.expense_categories (id),
  amount      numeric(12,2) not null check (amount > 0),
  paid_by     text not null default 'cash' check (paid_by in ('cash', 'upi', 'bank', 'card')),
  note        text not null default '',
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid() references public.profiles (id)
);
create index if not exists daily_expenses_date_idx on public.daily_expenses (spent_on);

-- Starting expense lines, in your order. Other is daily only; Kitchen (migration 009) is both;
-- Maintenance is both (monthly amount + daily entries are added together).
insert into public.expense_categories (name, monthly, daily, sort_order) values
  ('Salaries', true, false, 1),
  ('Staff clothes', true, false, 2),
  ('Commercial Tax', true, false, 3),
  ('House Rent', true, false, 4),
  ('Laundry', true, false, 5),
  ('Pooja', true, false, 6),
  ('EB Bill', true, false, 7),
  ('Fire service', true, false, 8),
  ('Mobile Recharge', true, false, 9),
  ('Telephone bill', true, false, 10),
  ('Firewood', true, false, 11),
  ('News Paper', true, false, 12),
  ('Soap, Shampoo', true, false, 13),
  ('Coffee, Tea, Milk', true, false, 14),
  ('Maintenance', true, true, 15),
  ('Cleaning Chemicals', true, false, 16),
  ('Xerox', true, false, 17),
  ('Lorry water', true, false, 18),
  ('Police', true, false, 19),
  ('TV Cable', true, false, 20),
  ('Deepavali', true, false, 21),
  ('Miscellaneous', true, false, 22),
  ('UMC Health/Tax', true, false, 23),
  ('Property Tax', true, false, 24),
  ('Booking.com Commission', true, false, 25),
  ('AxisRooms', true, false, 26),
  ('Google', true, false, 27),
  ('Facebook/Instagram', true, false, 28),
  ('JustDial', true, false, 29),
  ('Homecentre / Cloths', true, false, 30),
  ('Website Hosting', true, false, 31),
  ('Tripadvisor', true, false, 32),
  ('Kitchen', true, true, 50),
  ('Other', false, true, 52)
on conflict (name) do nothing;

-- Security: everyone signed in sees the expense lines and daily entries and can
-- add daily entries; only owners see and change the monthly sheet (salaries etc.).
-- Staff can fix or delete their own daily entries; owners can change any.
alter table public.expense_categories enable row level security;
alter table public.monthly_expenses   enable row level security;
alter table public.daily_expenses     enable row level security;

drop policy if exists "members read categories" on public.expense_categories;
create policy "members read categories" on public.expense_categories
  for select to authenticated using (public.is_active_member());
drop policy if exists "owner edits categories" on public.expense_categories;
create policy "owner edits categories" on public.expense_categories
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists "owner monthly expenses" on public.monthly_expenses;
create policy "owner monthly expenses" on public.monthly_expenses
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists "members read daily" on public.daily_expenses;
create policy "members read daily" on public.daily_expenses
  for select to authenticated using (public.is_active_member());
drop policy if exists "members add daily" on public.daily_expenses;
create policy "members add daily" on public.daily_expenses
  for insert to authenticated with check (public.is_active_member());
drop policy if exists "own or owner edits daily" on public.daily_expenses;
create policy "own or owner edits daily" on public.daily_expenses
  for update to authenticated using (public.is_owner() or created_by = auth.uid()) with check (public.is_active_member());
drop policy if exists "own or owner deletes daily" on public.daily_expenses;
create policy "own or owner deletes daily" on public.daily_expenses
  for delete to authenticated using (public.is_owner() or created_by = auth.uid());

-- Booking diaries 2023–2026 (migration 009): diary stays, kitchen income, closed dates.
alter table public.bookings
  add column if not exists from_diary boolean not null default false;

-- Guest phone number, for sending the bill on WhatsApp (migration 010).
alter table public.bookings
  add column if not exists guest_phone text not null default '';

-- The guest's company and GSTIN on the bill (migration 012).
alter table public.bookings
  add column if not exists guest_company text not null default '',
  add column if not exists guest_gstin   text not null default '';

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

-- (Databases set up before migration 009) Kitchen gets a monthly amount too (the diaries kept one total per month);
-- daily kitchen entries still add to it. Tripadvisor was a line in the diaries.
update public.expense_categories set monthly = true where name = 'Kitchen';
insert into public.expense_categories (name, monthly, daily, sort_order) values ('Tripadvisor', true, false, 32)
on conflict (name) do nothing;

-- New bill details, guest register, booking emails, calendar check, Google helper (migration 011).
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

-- Quick food bills (migration 013).
create table if not exists public.food_bills (
  id            uuid primary key default gen_random_uuid(),
  bill_no       text not null default '',             -- filled in automatically: <prefix>/F/26-27/0001
  bill_date     date not null default current_date,
  house_id      smallint references public.houses (id) on delete set null,
  booking_id    uuid references public.bookings (id) on delete set null,
  guest_name    text not null default '',
  items         jsonb not null default '[]'::jsonb,   -- [{"item":"Egg dosai","qty":4,"rate":60}]
  gst_pct       numeric(5,2) not null default 0 check (gst_pct >= 0 and gst_pct <= 28), -- 0 = no GST; otherwise included in the prices
  total         numeric(12,2) not null default 0 check (total >= 0),
  paid_by       text not null default 'cash' check (paid_by in ('cash', 'upi', 'room', 'credit')),
  added_to_room boolean not null default false,       -- total added to the stay's Food Bill
  created_by    uuid default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists food_bills_date_idx on public.food_bills (bill_date);
create index if not exists food_bills_booking_idx on public.food_bills (booking_id);

alter table public.food_bills enable row level security;
drop policy if exists "members read food bills" on public.food_bills;
create policy "members read food bills" on public.food_bills
  for select to authenticated using (public.is_active_member());
drop policy if exists "members add food bills" on public.food_bills;
create policy "members add food bills" on public.food_bills
  for insert to authenticated with check (public.is_active_member());
drop policy if exists "creator or owner edits food bills" on public.food_bills;
create policy "creator or owner edits food bills" on public.food_bills
  for update to authenticated using (public.is_owner() or (public.is_active_member() and created_by = auth.uid()))
  with check (public.is_active_member());
drop policy if exists "owner deletes food bills" on public.food_bills;
create policy "owner deletes food bills" on public.food_bills
  for delete to authenticated using (public.is_owner());

-- Bill numbers: their own series per financial year (April–March, by bill date).
create or replace function public.food_bill_no()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_prefix text; v_fy int; v_next int;
begin
  if coalesce(new.bill_no, '') <> '' then return new; end if;
  perform pg_advisory_xact_lock(hashtext('food_bills_bill_no'));
  v_fy := extract(year from new.bill_date)::int - case when extract(month from new.bill_date) < 4 then 1 else 0 end;
  select trim(invoice_prefix) into v_prefix from public.business_profile where id = 1;
  v_prefix := case when coalesce(v_prefix, '') = '' then '' else v_prefix || '/' end
              || 'F/' || lpad((v_fy % 100)::text, 2, '0') || '-' || lpad(((v_fy + 1) % 100)::text, 2, '0') || '/';
  select coalesce(max(substr(bill_no, length(v_prefix) + 1)::int), 0) + 1 into v_next
    from public.food_bills
   where left(bill_no, length(v_prefix)) = v_prefix and substr(bill_no, length(v_prefix) + 1) ~ '^[0-9]{1,9}$';
  new.bill_no := v_prefix || lpad(v_next::text, 4, '0');
  return new;
end;
$$;
drop trigger if exists food_bills_bill_no on public.food_bills;
create trigger food_bills_bill_no before insert on public.food_bills
  for each row execute function public.food_bill_no();

-- "Add to room bill": adds the food bill's total to the stay's Food Bill, once.
create or replace function public.add_food_to_room(p_food_bill uuid)
returns numeric language plpgsql set search_path = public as $$
declare v public.food_bills; v_new numeric;
begin
  select * into v from public.food_bills where id = p_food_bill for update;
  if not found then raise exception 'Food bill not found'; end if;
  if v.booking_id is null then raise exception 'This food bill is not linked to a stay'; end if;
  if v.added_to_room then select food_bill into v_new from public.bookings where id = v.booking_id; return v_new; end if;
  update public.bookings set food_bill = food_bill + v.total where id = v.booking_id returning food_bill into v_new;
  if not found then raise exception 'Stay not found'; end if;
  update public.food_bills set added_to_room = true where id = p_food_bill;
  return v_new;
end;
$$;
revoke execute on function public.add_food_to_room(uuid) from public, anon;
grant execute on function public.add_food_to_room(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────
-- Live updates: phones see each other's changes without refreshing.
-- ─────────────────────────────────────────────────────────────
do $$
begin
  begin alter publication supabase_realtime add table public.bookings; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.houses;   exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.settings; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.daily_expenses;   exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.monthly_expenses; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.business_profile; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.closed_dates;     exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.ota_inbox;        exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.ota_calendar;     exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.food_bills;       exception when duplicate_object then null; end;
end $$;
