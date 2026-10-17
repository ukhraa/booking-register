# Two Seas Residence

The booking register for Two Seas Residence's 6 apartments. It runs in any browser and installs on Android and iPhone like an app.

Staff record each stay: house, guest, dates, tariff, GST, extras (food, extra bed, firewood, gas), OTA advance and cash/UPI payments. The app works out nights, GST, totals and the balance, and flags any booking whose payments don't add up.

- **Summary** (opens first): today's occupancy, arrivals and departures, and totals for Today, This month, the financial year (April–March) and year to date (1 January to today). The totals cover bookings, room nights, gross total, GST, advance/OTA, balance after OTA, cash and UPI, counted by check-in date.
- **Register**: the monthly booking list with filters, search and CSV export for Excel/accounts
- **New booking** (the + button) opens the booking form from any screen.
- **Availability**: a month grid with apartments across and days down. Each stay is shaded in its apartment's colour and free nights are white. Tap a stay to open it, or tap a free square to book that apartment from that night. The grid also shows free apartments per day, booked nights per apartment, and any double bookings.
- **Performance**: hotel performance metrics for a period you choose (this month, last month, last 3 months, year to date, this financial year, last 12 months), each compared with the period before. The metrics are occupancy, average daily rate (ADR), RevPAR, TRevPAR, direct-booking share, estimated OTA commission, average length of stay, a comparison of apartments, weekends vs weekdays, extras per stay and unpaid balances. Each box shows the figure, a trend line and whether you're on target. Tap a box for a chart, what the metric means, why it matters, how you compare with your target, and what to do. Targets and OTA commission rates are set in Settings. Months covered by the imported spreadsheet history (up to September 2026) use those figures; later months use bookings in the app. Occupancy, ADR and RevPAR also have a year-by-year chart.
- **Settings** is the gear icon at the top (owners only).
- **Expenses**: the **Daily** view is where anyone signed in logs kitchen, maintenance and other spending as it happens (amount, paid by, what for). The **Monthly** view (owners only) is a sheet with one amount per expense line (salaries, EB bill, rent, OTA commission and so on), with that month's daily entries added up into it automatically. It shows the month's revenue, expenses, profit and cost per night sold. You can copy last month's amounts, add new lines, and export to CSV.
- **Light and Dark mode**: Light (white and blue) is the default. Tap the moon at the top to switch to Dark (black and blue), and the sun to switch back. Each phone or computer remembers its own choice.
- Summary, Register, New booking, Availability, Performance and Expenses are in a tab bar (on phones Availability and Performance are labelled Calendar and Stats) at the bottom of the screen.
- **Apartments**: which apartments are occupied tonight and who's arriving next
- **Extra Bed, Firewood and Gas** are charged per day. Set one to Yes and the days fill in with the number of nights; change the days if the item was used for fewer (for example, firewood for 2 of 3 nights). The amount is the rate per day × days. Rates start at ₹500, ₹600 and ₹500 per day.
- **Guest bill**: open a saved booking and tap **Print bill** to print it or save it as a PDF to share on WhatsApp. With a GSTIN set it's a GST Tax Invoice with CGST and SGST shown separately. Bill numbers like `TSR/26-27/0001` are given automatically and start again each April.
- **Settings** (owner only): rename apartments and pick their colours, change the Extra Bed, Firewood and Gas charges, set the bill details (business name, address, GSTIN, bill number prefix), give or remove staff access
- Changes show up live on every phone
- Warns before double-booking an apartment

Hosting is free: GitHub Pages for the app and Supabase for the database.

---

## Setup (about 15 minutes, one time)

### 1. Create the database

1. Sign up at **https://supabase.com** and click **New project**.
   - Name it `booking-register`.
   - Pick a strong database password and save it somewhere safe.
   - Region: **Mumbai (ap-south-1)** is closest.
2. When the project is ready, open **SQL Editor → New query**.
3. Paste the whole of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**. You should see "Success. No rows returned".
4. Go to **Authentication → Sign In / Providers**:
   - Turn **off** "Allow new users to sign up". Only you should create logins.
   - Under **Email**, turn **off** "Confirm email".

### 2. Create your login (the owner)

1. Go to **Authentication → Users → Add user → Create new user**.
2. Enter your email and a password, and tick **Auto Confirm User**.

The first login you create automatically becomes the **Owner**.

### 3. Connect the app to the database

1. In Supabase, open **Project Settings → API** (also shown under **Connect**).
2. Copy the **Project URL** and the **anon / public** key.
3. In GitHub, open [`js/config.js`](js/config.js), click the ✏️ pencil, paste both values, and click **Commit changes**.
   - You can also change `BUSINESS_NAME` and the `BOOKING_TYPES` list here.

> The anon key is designed to be public. Your bookings are protected by the security rules in the database: only people you've given a login can see or change anything.

### 4. Put the app online (GitHub Pages)

1. In this GitHub repo, go to **Settings → Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
3. After a minute, the page shows your app's address, for example `https://ukhraa.github.io/booking-register/`.

### 5. Install it on phones

- **Android (Chrome):** open the address, tap **⋮ → Add to Home screen → Install**.
- **iPhone (Safari):** open the address, tap **Share → Add to Home Screen**.

It opens full-screen with its own icon, like a normal app.

### 6. Add staff

1. In Supabase, go to **Authentication → Users → Add user** and enter their email and a password (tick **Auto Confirm User**).
2. They show up in the app under **Settings → Staff** as *Staff*.
3. To stop someone signing in, untick **Can sign in**. Their past bookings stay.

| | Owner | Staff |
|---|---|---|
| See, add and edit bookings | ✅ | ✅ |
| Delete bookings | ✅ | — |
| Rename apartments, manage staff | ✅ | — |

---

## How the numbers are worked out

| Field | Calculation |
|---|---|
| No. of Nights | Check-out − Check-in |
| GST Amount | Tariff × GST % |
| Total Tariff | Tariff + GST Amount |
| Gross Total | Total Tariff + Food Bill + Extra Bed + Firewood + Gas |
| Total Balance | Gross Total − Advance/Paid to OTA |
| Total Balanced? | **Yes** when Paid by Cash + Paid by UPI = Total Balance (within ₹0.50) |
| Change to return | Cash Received − Paid by Cash − Tips (shown on the form) |

- **Tariff** is the room charge for the **whole stay, before GST**.
- **Tips** are recorded separately and don't count towards the balance.
- **GST %** is suggested from the per-night rate (₹1,000 or less: nil; up to ₹7,500: 5%; above ₹7,500: 18%), and staff can always change it. Check the current rates with your accountant.

The database stores these calculated values itself, so every phone and every export shows the same figures.

---

## Database updates

If you set up the database before a feature was added, run the matching file from [`supabase/migrations/`](supabase/migrations/) once in **Supabase → SQL Editor**. Each file is safe to run more than once.

| File | Adds |
|---|---|
| `002_extra_charges.sql` | Editable rates for Extra Bed, Firewood and Gas |
| `003_guest_bill.sql` | Printable guest bill: business details and automatic bill numbers |
| `004_bill_signature.sql` | Owner's signature on the guest bill |
| `005_extra_days.sql` | Days for Extra Bed, Firewood and Gas (charged per day) |
| `006_house_colours.sql` | A colour for each apartment on the Availability grid |
| `008_expenses.sql` | Expenses: expense lines, monthly amounts and daily entries |
| `007_monthly_history.sql` | Monthly nights and room revenue per apartment, January 2023 to September 2026 (from Occ_x_Rev_data.xlsx), for the Performance tab |

## Updating the app

- **Change files** by editing them on GitHub, or ask Claude Code to make changes in this repo.
- After changing app files, bump `VERSION` in [`sw.js`](sw.js) (for example `v1` → `v2`) so installed phones pick up the update. They update the next time the app is opened twice.
- **Back up** anytime by going to **Register → All months → Export CSV**. Supabase also has backups under **Database → Backups**.

## Files

```
index.html            app screens
css/app.css           look and feel (light and dark mode)
js/app.js             screens, saving, live updates
js/calc.js            all booking calculations (tested)
js/bill.js            printable guest bill
js/config.js          your Supabase details, business name, booking types
supabase/schema.sql   database tables, calculations and security rules
sw.js                 offline support / installable app
manifest.webmanifest  app name and icons for phones
tests/                calculation tests: run `node --test tests/*.test.mjs`
```
