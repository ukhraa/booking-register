import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarIssues, staleLinks, parseICal, runs } from "../js/ota-calendar.js";

test("runs of nights", () => {
  assert.deepEqual(runs(["2026-12-03", "2026-12-01", "2026-12-02", "2026-12-05"]),
    [{ start: "2026-12-01", end: "2026-12-04" }, { start: "2026-12-05", end: "2026-12-06" }]);
});

test("calendar issues: open on the OTA, Airbnb reservation missing from the app, recent changes skipped", () => {
  const links = [
    { house_id: 3, source: "Airbnb", last_fetched: "2026-11-22T10:00:00Z", last_error: "" },
    { house_id: 1, source: "Booking.com", last_fetched: "2026-11-22T10:00:00Z", last_error: "" },
    { house_id: 2, source: "Airbnb", last_fetched: null, last_error: "" },
  ];
  const bookings = [
    { house_id: 3, check_in: "2026-11-25", check_out: "2026-11-27", updated_at: "2026-11-10T00:00:00Z" },  // Airbnb has it
    { house_id: 1, check_in: "2026-12-01", check_out: "2026-12-04", updated_at: "2026-11-10T00:00:00Z" },  // Booking.com open 2–3 Dec
    { house_id: 1, check_in: "2026-12-10", check_out: "2026-12-12", updated_at: "2026-11-22T09:30:00Z" },  // just made: skipped
    { house_id: 2, check_in: "2026-12-01", check_out: "2026-12-02", updated_at: "2026-11-01T00:00:00Z" },  // no calendar yet
  ];
  const events = [
    { house_id: 3, source: "Airbnb", start_date: "2026-11-25", end_date: "2026-11-27", summary: "Reserved" },
    { house_id: 3, source: "Airbnb", start_date: "2026-12-20", end_date: "2026-12-23", summary: "Reserved" },  // not in app
    { house_id: 3, source: "Airbnb", start_date: "2026-12-24", end_date: "2026-12-26", summary: "Airbnb (Not available)" },
    { house_id: 1, source: "Booking.com", start_date: "2026-12-01", end_date: "2026-12-02", summary: "CLOSED - Not available" },
  ];
  const got = calendarIssues({ bookings, events, links, today: "2026-11-22" });
  assert.deepEqual(got, [
    { type: "open", house_id: 1, source: "Booking.com", start: "2026-12-02", end: "2026-12-04" },
    { type: "missing", house_id: 3, source: "Airbnb", start: "2026-12-20", end: "2026-12-23" },
  ]);
  assert.equal(staleLinks(links, new Date("2026-11-22T12:00:00Z")).length, 1);
});

test("iCal parsing: dates, folded lines, escaped commas", () => {
  const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261225\r\nDTEND;VALUE=DATE:20261228\r\nSUMMARY:Reserved\r\nEND:VEVENT\r\n" +
    "BEGIN:VEVENT\r\nDTSTART:20270101\r\nDTEND:20270102\r\nSUMMARY:CLOSED - Not\r\n  available\\, sorry\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  assert.deepEqual(parseICal(ics), [
    { start: "2026-12-25", end: "2026-12-28", summary: "Reserved" },
    { start: "2027-01-01", end: "2027-01-02", summary: "CLOSED - Not available, sorry" },
  ]);
});
