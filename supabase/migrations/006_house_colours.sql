-- Migration 006: a colour for each apartment (Availability grid)
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to re-run.
-- The owner can change colours later in Settings → Apartments.

alter table public.houses
  add column if not exists color text not null default ''
  check (color in ('', 'red', 'green', 'blue', 'grey', 'orange', 'purple', 'teal', 'pink', 'yellow'));

-- Starting colours, matched by apartment name. Only fills apartments that have none yet.
update public.houses set color = case
    when name ilike '%amazon%'   then 'green'
    when name ilike '%bhoomi%'   then 'red'
    when name ilike '%vismay%'   then 'orange'
    when name ilike '%himalaya%' then 'grey'
    when name ilike '%nilgiri%'  then 'blue'
    when name ilike '%venus%'    then 'purple'
    else color
  end
where color = '';
