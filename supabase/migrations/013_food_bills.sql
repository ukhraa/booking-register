-- Migration 013: quick food bills (breakfast, meals, tea) with their own bill numbers.
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to re-run.

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

do $$
begin
  begin alter publication supabase_realtime add table public.food_bills; exception when duplicate_object then null; end;
end $$;

-- Check: should say 1.
select count(*) as food_bills_table from information_schema.tables where table_name = 'food_bills';
