/**
 * Two Seas Residence — Google helper for the booking register app.
 *
 * Runs inside the hotel's Gmail account (script.google.com). It does three jobs:
 *   1. every 10 minutes: copies AxisRooms booking emails into the app (the app adds the bookings);
 *   2. every hour: reads the Airbnb / Booking.com calendar links saved in the app's Settings,
 *      so the app can warn when a calendar and the register disagree;
 *   3. every Monday early morning: saves a backup of everything in the app to Google Drive
 *      (folder "Two Seas backups", the last 12 kept).
 *
 * Setup: see GOOGLE_HELPER.md. Paste the helper key from the app (Settings → Make a helper key)
 * below, save, then run "setup" once and allow access when Google asks.
 */

// From js/config.js. The publishable key is meant to be public; it can't read anything by itself.
const SUPABASE_URL = "https://embkujshqombiawjcuqz.supabase.co";
const SUPABASE_KEY = "sb_publishable_NUwkz3MVvkPdOhW1SjmZgA_u-qmMPp_";

// From the app: Settings → Booking emails, calendars and backups → Make a helper key.
const HELPER_KEY = "PASTE-THE-HELPER-KEY-HERE";

const FROM = "bookings@axisrooms.com";      // who sends the booking emails
const BACKUP_FOLDER = "Two Seas backups";
const KEEP_BACKUPS = 12;

/** Run once: makes the three timers and runs each job once to check it works. */
function setup() {
  if (HELPER_KEY.indexOf("PASTE") === 0) throw new Error("Paste the helper key from the app first (line with HELPER_KEY).");
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("importEmails").timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger("checkCalendars").timeBased().everyHours(1).create();
  ScriptApp.newTrigger("weeklyBackup").timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(3).create();
  importEmails(60);   // first time: the last 60 days of booking emails
  checkCalendars();
  weeklyBackup();
  Logger.log("All set. Booking emails, calendars and backups are running.");
}

function rpc_(fn, args) {
  const res = UrlFetchApp.fetch(SUPABASE_URL + "/rest/v1/rpc/" + fn, {
    method: "post",
    contentType: "application/json",
    headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY },
    payload: JSON.stringify(Object.assign({ p_key: HELPER_KEY }, args || {})),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode(), text = res.getContentText();
  if (code >= 300) throw new Error(fn + " failed (" + code + "): " + text.slice(0, 300));
  return text ? JSON.parse(text) : null;
}

/** 1. Booking emails → app. Safe to repeat: the app ignores emails it already has. */
function importEmails(days) {
  const threads = GmailApp.search("from:" + FROM + " newer_than:" + (days || 3) + "d", 0, 100);
  let sent = 0;
  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (m) {
      if (m.getFrom().toLowerCase().indexOf(FROM) === -1) return;
      const added = rpc_("helper_add_email", {
        p_message_id: m.getId(),
        p_subject: m.getSubject(),
        p_body: m.getPlainBody(),
        p_received_at: m.getDate().toISOString(),
      });
      if (added) sent++;
    });
  });
  if (sent) Logger.log(sent + " new booking email(s) sent to the app");
}

/** 2. Airbnb / Booking.com calendars → app. */
function checkCalendars() {
  const links = rpc_("helper_ical_links") || [];
  links.forEach(function (l) {
    try {
      const res = UrlFetchApp.fetch(l.url, { muteHttpExceptions: true, followRedirects: true });
      if (res.getResponseCode() !== 200) throw new Error("The calendar link answered " + res.getResponseCode() + ". Copy the link again from " + l.source + ".");
      const events = parseICal_(res.getContentText());
      rpc_("helper_save_calendar", { p_house_id: l.house_id, p_source: l.source, p_events: events, p_error: "" });
    } catch (e) {
      rpc_("helper_save_calendar", { p_house_id: l.house_id, p_source: l.source, p_events: [], p_error: String(e.message || e) });
    }
  });
}

// Same as parseICal in js/ota-calendar.js: keep the two in step.
function parseICal_(text) {
  const unfolded = String(text || "").replace(/\r?\n[ \t]/g, "");
  const out = [];
  unfolded.split("BEGIN:VEVENT").slice(1).forEach(function (block) {
    const get = function (k) { const m = block.match(new RegExp("^" + k + "(?:;[^:\\r\\n]*)?:(.*)$", "m")); return m ? m[1].trim() : ""; };
    const d = function (v) { return /^\d{8}/.test(v) ? v.slice(0, 4) + "-" + v.slice(4, 6) + "-" + v.slice(6, 8) : ""; };
    const start = d(get("DTSTART"));
    let end = d(get("DTEND"));
    if (!end && start) { const t = new Date(start + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + 1); end = t.toISOString().slice(0, 10); }
    if (start && end > start) out.push({ start: start, end: end, summary: get("SUMMARY").replace(/\\,/g, ",").replace(/\\n/gi, " ").slice(0, 200) });
  });
  return out;
}

/** 3. Weekly backup → Google Drive. */
function weeklyBackup() {
  const data = rpc_("helper_backup");
  const folders = DriveApp.getFoldersByName(BACKUP_FOLDER);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(BACKUP_FOLDER);
  const day = Utilities.formatDate(new Date(), "Asia/Kolkata", "yyyy-MM-dd");
  folder.createFile("two-seas-backup-" + day + ".json", JSON.stringify(data), "application/json");
  folder.createFile("two-seas-bookings-" + day + ".csv", toCsv_(data.bookings || []), "text/csv");
  // Keep the newest KEEP_BACKUPS of each kind.
  ["two-seas-backup-", "two-seas-bookings-"].forEach(function (prefix) {
    const files = [];
    const it = folder.getFiles();
    while (it.hasNext()) { const f = it.next(); if (f.getName().indexOf(prefix) === 0) files.push(f); }
    files.sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; });
    files.slice(KEEP_BACKUPS).forEach(function (f) { f.setTrashed(true); });
  });
  Logger.log("Backup saved to Google Drive → " + BACKUP_FOLDER);
}

function toCsv_(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const q = function (v) { const s = v === null || v === undefined ? "" : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [cols.join(",")].concat(rows.map(function (r) { return cols.map(function (c) { return q(r[c]); }).join(","); })).join("\r\n");
}
