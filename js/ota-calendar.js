// Calendar check: compares the app's bookings with the Airbnb / Booking.com calendars
// (iCal) that the Google helper copies into ota_calendar. Pure, tested in
// tests/ota-calendar.test.mjs.
//  • "open":    booked in the app, but the OTA still shows the night free → double-booking risk.
//  • "missing": Airbnb shows its own reservation ("Reserved") on a night the app has free.
// Booking.com's calendar marks every unavailable night "CLOSED - Not available", so only
// "open" can be checked for it.
import { addDays } from "./calc.js";

const nightsOf = (start, end, from, to) => {
  const out = [];
  for (let d = start < from ? from : start; d < end && d < to; d = addDays(d, 1)) out.push(d);
  return out;
};

/** Consecutive nights → [{ start, end }] where end is the first night after the run. */
export function runs(nights) {
  const sorted = [...new Set(nights)].sort();
  const out = [];
  for (const d of sorted) {
    const last = out[out.length - 1];
    if (last && last.end === d) last.end = addDays(d, 1);
    else out.push({ start: d, end: addDays(d, 1) });
  }
  return out;
}

/**
 * @param bookings  app bookings (house_id, check_in, check_out, updated_at)
 * @param events    ota_calendar rows (house_id, source, start_date, end_date, summary)
 * @param links     ical_links rows (house_id, source, last_fetched, last_error)
 * @param today     yyyy-mm-dd; nights from today to today + horizon days are checked
 * @param graceHours bookings changed this long before a calendar was fetched are skipped
 *                   (the channel manager and the OTA need time to catch up)
 */
export function calendarIssues({ bookings, events, links, today, horizon = 180, graceHours = 3 }) {
  const to = addDays(today, horizon);
  const issues = [];
  for (const link of links) {
    if (!link.last_fetched || link.last_error) continue;
    const cutoff = new Date(new Date(link.last_fetched).getTime() - graceHours * 3600e3).toISOString();
    const mine = bookings.filter((b) => b.house_id === link.house_id && b.check_out > today && b.check_in < to);
    const app = new Set(mine.flatMap((b) => nightsOf(b.check_in, b.check_out, today, to)));
    const settled = new Set(mine.filter((b) => !b.updated_at || b.updated_at < cutoff).flatMap((b) => nightsOf(b.check_in, b.check_out, today, to)));
    const ev = events.filter((e) => e.house_id === link.house_id && e.source === link.source);
    const busy = new Set(ev.flatMap((e) => nightsOf(e.start_date, e.end_date, today, to)));
    const reserved = new Set(ev.filter((e) => /reserved/i.test(e.summary || "")).flatMap((e) => nightsOf(e.start_date, e.end_date, today, to)));
    for (const r of runs([...settled].filter((d) => !busy.has(d)))) issues.push({ type: "open", house_id: link.house_id, source: link.source, ...r });
    for (const r of runs([...reserved].filter((d) => !app.has(d)))) issues.push({ type: "missing", house_id: link.house_id, source: link.source, ...r });
  }
  return issues.sort((a, b) => a.start.localeCompare(b.start) || a.house_id - b.house_id);
}

/** Links whose calendar couldn't be read, or hasn't been read for a while. */
export function staleLinks(links, now = new Date(), maxHours = 6) {
  return links.filter((l) => l.last_error || !l.last_fetched || now - new Date(l.last_fetched) > maxHours * 3600e3);
}

/** Read the events out of an iCal (.ics) file: [{ start, end, summary }]. Used by the Google helper too. */
export function parseICal(text) {
  const unfolded = String(text ?? "").replace(/\r?\n[ \t]/g, "");
  const out = [];
  for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const get = (k) => (block.match(new RegExp(`^${k}(?:;[^:\\r\\n]*)?:(.*)$`, "m")) || [])[1]?.trim() || "";
    const d = (v) => (v.match(/^(\d{4})(\d{2})(\d{2})/) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : "");
    const start = d(get("DTSTART")), end = d(get("DTEND")) || (start ? addDays(start, 1) : "");
    if (start && end > start) out.push({ start, end, summary: get("SUMMARY").replace(/\\,/g, ",").replace(/\\n/gi, " ").slice(0, 200) });
  }
  return out;
}
