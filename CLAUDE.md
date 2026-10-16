# Booking Register — notes for Claude Code

Installable web app (PWA) for a 6-apartment homestay's booking register. Plain HTML/CSS/ES modules, **no build step**, hosted on GitHub Pages; data in Supabase.

## Structure
- `js/calc.js` — pure calculation functions. **Single source of truth for the form preview**; must stay in step with the generated columns in `supabase/schema.sql`.
- `js/app.js` — UI, Supabase queries, realtime. Loads `@supabase/supabase-js` pinned from jsDelivr (`+esm`).
- `js/config.js` — Supabase URL/anon key, business name, booking types.
- `supabase/schema.sql` — idempotent schema: `profiles` (owner/staff), `houses`, `bookings` with generated money columns, RLS, serial/audit triggers.
- `sw.js` — app-shell cache. Bump `VERSION` on every change to app files.

## Rules
- Money columns: input columns are `tariff, gst_pct, food_bill, extra_bed, firewood, gas, advance_ota, paid_cash, cash_received, tips, paid_upi` (plus `extra_bed_days, firewood_days, gas_days`). Calculated (never written by the app): `nights, gst_amount, total_tariff, gross_total, total_balance, total_balanced`.
- If you change a formula, change it in **both** `js/calc.js` and `supabase/schema.sql` (provide an `ALTER TABLE` migration in `supabase/migrations/`), and update `tests/calc.test.mjs`.
- Tariff = whole-stay room charge before GST. Tips are excluded from the balance check.
- Extra Bed, Firewood and Gas are charged **per day** (`EXTRAS` in app.js): Yes/No + Days on the form. Yes locks in the current rate per day from the `settings` table (`<name>_rate` keys) and fills Days with the nights (follows date changes until staff type a number). Saved as `<name>` = rate × days (`extraAmount` in calc.js) plus `<name>_days`; the rate is recovered as amount ÷ days (`extraRate`), so a later rate change never alters past bookings. Amount above 0 shows as Yes; old rows with amount but 0 days count as 1 day. Bill shows "N days × ₹rate".
- Guest bill: `js/bill.js` builds it from the **saved** booking (Print bill asks to save unsaved edits first). Business details come from the single-row `business_profile` table (owner edits in Settings). `assign_bill_no(uuid)` RPC fills an empty `bill_no` with `<prefix>/<FY>/<0001>`, FY by check-out date; a manually typed bill no. is kept. The signature is a PNG data URL in `business_profile.signature` (never commit it: the repo is public); Settings crops it and removes the paper background on upload. Only `#billView` prints (`@media print` in app.css).
- Navigation is a fixed bottom tab bar (`.bottomnav`): Summary (default) · Register · + New booking (`#newBtn`, opens the form sheet, no section change) · Availability (`tab-houses`) · Settings (owner). Keep fixed elements (toast etc.) above `--nav-h`.
- Summary tab = Today cards (`renderToday`: occupied tonight, arriving, leaving, from `state.upcoming`, which includes today's check-outs) + the Totals table.
- Totals table (Summary tab): Today / month / financial year (Apr–Mar) / year to date (**calendar year: 1 Jan to today**), by **check-in date**, all apartments (`reportPeriods`, `periodTotals`, `periodsSpan` in calc.js; `loadTotals` fetches from the earliest period start to the latest end). On phones (<600px) one column shows at a time via the `#totalsSeg` switcher.
- Availability grid (`renderCalendar`): apartments across, days of `state.calMonth` down; built by `availabilityGrid`/`occupancy` in calc.js (a stay occupies check-in up to, not including, check-out; 2+ stays on a night = double booked, striped). Colours: `houses.color` key (migration 006; owner picks in Settings), styled by `.c-<colour>` tokens (light + dark) in app.css; `houseColour()` falls back to the apartment name, then the id. Free cell → `openSheet(null, {house_id, check_in, check_out})`. Don't reuse the class `today` on table rows (`.today` is the Summary section, a flex box); the row class is `is-today`.
- Themes: Light (white + blue `#1f5fd1`) is the default; Dark (black + blue `#5b9bff`) via `<html data-theme="dark">`, toggled by `.theme-toggle` and kept in `localStorage.theme` (an inline script in index.html applies it before first paint). Do **not** use `prefers-color-scheme`: the device setting must not switch the app to dark. Dark overrides go under `:root[data-theme="dark"]`. The guest bill keeps its own fixed light colours.
- Business name is "Two Seas Residence" (`BUSINESS_NAME` in config.js, plus index.html title and manifest).
- Escape all user text with `esc()` before inserting into HTML.
- Keep relative paths (the site is served from `/booking-register/` on GitHub Pages).

## Commands
- Tests: `node --test tests/*.test.mjs`
- Local preview: `python3 -m http.server 8000`, then open http://localhost:8000
