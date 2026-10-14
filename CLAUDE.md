# Booking Register — notes for Claude Code

Installable web app (PWA) for a 6-apartment homestay's booking register. Plain HTML/CSS/ES modules, **no build step**, hosted on GitHub Pages; data in Supabase.

## Structure
- `js/calc.js` — pure calculation functions. **Single source of truth for the form preview**; must stay in step with the generated columns in `supabase/schema.sql`.
- `js/app.js` — UI, Supabase queries, realtime. Loads `@supabase/supabase-js` pinned from jsDelivr (`+esm`).
- `js/config.js` — Supabase URL/anon key, business name, booking types.
- `supabase/schema.sql` — idempotent schema: `profiles` (owner/staff), `houses`, `bookings` with generated money columns, RLS, serial/audit triggers.
- `sw.js` — app-shell cache. Bump `VERSION` on every change to app files.

## Rules
- Money columns: input columns are `tariff, gst_pct, food_bill, extra_bed, firewood, gas, advance_ota, paid_cash, cash_received, tips, paid_upi`. Calculated (never written by the app): `nights, gst_amount, total_tariff, gross_total, total_balance, total_balanced`.
- If you change a formula, change it in **both** `js/calc.js` and `supabase/schema.sql` (provide an `ALTER TABLE` migration in `supabase/migrations/`), and update `tests/calc.test.mjs`.
- Tariff = whole-stay room charge before GST. Tips are excluded from the balance check.
- Extra Bed, Firewood and Gas are Yes/No dropdowns on the form (`EXTRAS` in app.js). Yes copies the current rate from the `settings` table (`<name>_rate` keys) into the booking's amount column, so a later rate change never alters past bookings. A booking with an amount above 0 shows as Yes.
- Business name is "Two Seas Residence" (`BUSINESS_NAME` in config.js, plus index.html title and manifest).
- Escape all user text with `esc()` before inserting into HTML.
- Keep relative paths (the site is served from `/booking-register/` on GitHub Pages).

## Commands
- Tests: `node --test tests/*.test.mjs`
- Local preview: `python3 -m http.server 8000`, then open http://localhost:8000
