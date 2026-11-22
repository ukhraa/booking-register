# Google helper: booking emails, calendar check and weekly backup

A small script that runs free in the hotel's Google account (the Gmail that receives the AxisRooms booking emails, twoseasresidence@gmail.com). It:

1. **Every 10 minutes** copies new AxisRooms booking emails into the app. The app adds each new booking by itself. A clash, an apartment it can't recognise, a change or a cancellation waits on the Summary screen under **Needs a look**.
2. **Every hour** reads the Airbnb and Booking.com calendar links saved in the app. The app then warns when a calendar still shows a night free that is booked in the app, or when Airbnb has a booking the app doesn't.
3. **Every Monday at 3 am** saves a backup of everything in the app to Google Drive, in a folder called **Two Seas backups**. It keeps the last 12 weeks: a full backup (`.json`) and the bookings as a spreadsheet (`.csv`).

Setup takes about 10 minutes, once.

## Before you start

- Run `supabase/migrations/011_bill_guests_helper.sql` in Supabase (SQL Editor), if you haven't yet.
- In the app: **Settings → Booking emails, calendars and backups → Make a helper key**. Copy the key it shows.

## Steps

1. On a computer, sign in to Google as **twoseasresidence@gmail.com** and open **https://script.google.com**.
2. Click **New project**. Name it `Two Seas helper` (click "Untitled project" at the top).
3. Delete everything in the editor, then paste the whole of [`google-helper/TwoSeasHelper.gs`](google-helper/TwoSeasHelper.gs).
4. Find the line `const HELPER_KEY = "PASTE-THE-HELPER-KEY-HERE";` and paste your key between the quotes.
5. Click **Save** (the disk icon).
6. In the function menu at the top (next to **Debug**), choose **setup**, then click **Run**.
7. Google asks for permission: click **Review permissions**, choose the hotel account, then **Advanced → Go to Two Seas helper (unsafe) → Allow**. ("Unsafe" only means Google hasn't reviewed a script you wrote yourself.) The script asks to read Gmail, fetch web pages and save files to Drive: those are its three jobs.
8. Wait for "All set" in the log at the bottom.

Done. Booking emails from the last 60 days go to the app straight away; open the app and check **Needs a look** on Summary.

## Calendar links

In the app: **Settings → Calendar links**, paste each apartment's export link, then tap **Save calendar links**.

- **Airbnb**: Listings → choose the apartment → Availability → **Connect calendars** (or Calendar sync) → **Export calendar** → copy the link.
- **Booking.com** extranet: Rates & availability → **Sync calendars** → choose the room → **Export calendar** → copy the link.

The helper reads them within the hour.

## If something stops working

- **"Wrong helper key"** in the script's log: someone made a new key in the app. Paste the new key into the script and save.
- **Can't read a calendar** (shown in the app): copy the link again from Airbnb or Booking.com; the old one may have been reset.
- See what the script has done: script.google.com → Two Seas helper → **Executions** (on the left).
- To stop it: script.google.com → Two Seas helper → **Triggers** (the clock icon) → delete the three triggers.

## Restoring a backup

Each backup is a complete copy of the app's tables. If you ever need one restored, open the **Two Seas backups** folder in Google Drive and share the `.json` file with whoever is helping you (or ask Claude Code to write the restore SQL from it).
