-- Migration 003: printable guest bill (GST invoice)
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to re-run.
-- Adds the business details printed on the bill (owner edits them in Settings)
-- and automatic bill numbers like TSR/26-27/0001, counted per financial year.

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

-- Give a booking the next bill number for its financial year (April–March, by
-- check-out date), unless it already has one. Runs with the caller's rights,
-- so only active staff and owners can use it.
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

do $$
begin
  begin alter publication supabase_realtime add table public.business_profile; exception when duplicate_object then null; end;
end $$;
