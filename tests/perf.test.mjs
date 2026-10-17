import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMetrics, monthlySeries, lastMonths, perfPeriod, rate, commissionFor, commissionKey } from "../js/perf.js";

const houses = [{ id: 1, name: "Bhoomi" }, { id: 2, name: "Amazon" }];
const B = (o) => ({ food_bill: 0, extra_bed: 0, firewood: 0, gas: 0, paid_cash: 0, paid_upi: 0, ...o });

test("occupancy, ADR, RevPAR count nights stayed, split across months", () => {
  const rows = [
    // 30 Sep → 3 Oct: 1 night in September, 2 in October; ₹9,000 room = ₹3,000/night
    B({ house_id: 1, booking_type: "Direct", check_in: "2026-09-30", check_out: "2026-10-03", nights: 3, tariff: 9000, total_balance: 9450 }),
    // 10 → 12 Oct on Airbnb (15%): ₹10,000 = ₹5,000/night, plus ₹1,000 firewood
    B({ house_id: 2, booking_type: "Airbnb", check_in: "2026-10-10", check_out: "2026-10-12", nights: 2, tariff: 10000, firewood: 1000, total_balance: 11500 }),
  ];
  const m = computeMetrics(rows, houses, "2026-10-01", "2026-10-31", { today: "2026-10-31" });
  assert.equal(m.available, 62);
  assert.equal(m.sold, 4);
  assert.equal(Math.round(m.occupancy * 10) / 10, 6.5);
  assert.equal(m.roomRev, 16000);         // 2 × 3,000 + 2 × 5,000
  assert.equal(m.adr, 4000);
  assert.equal(m.revpar, Math.round((16000 / 62) * 100) / 100);
  assert.equal(m.extrasRev, 1000);
  assert.equal(m.trevpar, Math.round((17000 / 62) * 100) / 100);
  assert.equal(m.commission, 1500);       // 15% of Airbnb's 10,000
  assert.equal(Math.round(m.directShare), 38); // 6,000 of 16,000
  assert.equal(m.stays, 1);               // only the Airbnb stay checks in during October
  assert.equal(m.alos, 2);
  assert.equal(m.extrasPerStay, 1000);
  assert.equal(m.unpaid.length, 1);       // Airbnb stay fully unpaid in this test
  assert.equal(m.unpaidTotal, 11500);
  assert.equal(m.houses[0].sold, 2);
  assert.equal(m.houses[1].adr, 5000);
  const sep = computeMetrics(rows, houses, "2026-09-01", "2026-09-30");
  assert.equal(sep.sold, 1);
  assert.equal(sep.roomRev, 3000);
});

test("weekend means Friday and Saturday nights", () => {
  // 16 Oct 2026 is a Friday: Fri + Sat nights
  const rows = [B({ house_id: 1, booking_type: "Direct", check_in: "2026-10-16", check_out: "2026-10-18", nights: 2, tariff: 4000, total_balance: 4200, paid_upi: 4200 })];
  const m = computeMetrics(rows, houses, "2026-10-12", "2026-10-18"); // Mon–Sun: 2 weekend, 5 weekday nights
  assert.equal(m.weekendOcc, 50);   // 2 of 4
  assert.equal(m.weekdayOcc, 0);
  assert.equal(m.unpaid.length, 0);
});

test("monthly series and period choices", () => {
  assert.deepEqual(lastMonths("2026-02", 3), ["2025-12", "2026-01", "2026-02"]);
  const s = monthlySeries([], houses, "2026-10");
  assert.equal(s.length, 12);
  assert.equal(s[11].ym, "2026-10");
  assert.equal(s[11].available, 62);
  const t = "2026-10-16";
  const P = (k, d = t) => perfPeriod(k, d);
  assert.deepEqual([P("month").start, P("month").end], ["2026-10-01", "2026-10-16"]);          // so far
  assert.deepEqual([P("month").prev.start, P("month").prev.end], ["2026-09-01", "2026-09-16"]); // same days
  assert.equal(P("month", "2026-03-31").prev.end, "2026-02-28");
  assert.deepEqual([P("last_month").start, P("last_month").end], ["2026-09-01", "2026-09-30"]);
  assert.deepEqual([P("last_3").start, P("last_3").end], ["2026-07-01", "2026-09-30"]);
  assert.deepEqual([P("ytd").start, P("ytd").prev.end], ["2026-01-01", "2025-10-16"]);
  assert.deepEqual([P("fy").start, P("fy").end, P("fy").prev.start, P("fy").prev.end], ["2026-04-01", "2026-10-16", "2025-04-01", "2025-10-16"]);
  assert.equal(P("fy", "2027-02-01").start, "2026-04-01");
  assert.deepEqual([P("last_12").start, P("last_12").end], ["2025-11-01", "2026-10-16"]);
  assert.equal(P("ytd", "2028-02-29").prev.end, "2027-02-28");
  assert.equal(P("month", "2026-01-10").prev.start, "2025-12-01");
  // The current month in a trend counts only up to today
  const cur = monthlySeries([], houses, "2026-10", { today: t }).at(-1);
  assert.equal(cur.available, 32);  // 2 apartments × 16 days
  assert.equal(cur.partial, true);
});

test("status against a target", () => {
  assert.equal(rate(70, 65, 10), "good");
  assert.equal(rate(58, 65, 10), "warn");
  assert.equal(rate(40, 65, 10), "bad");
  assert.equal(rate(12, 10, 5, false), "warn");
  assert.equal(rate(5, 0, 5), "none");
});

test("commission rates: defaults, owner overrides, unknown types", () => {
  assert.equal(commissionKey("Booking.com"), "commission_booking_com");
  assert.equal(commissionFor("Booking.com"), 18);
  assert.equal(commissionFor("Booking.com", { commission_booking_com: 15 }), 15);
  assert.equal(commissionFor("Direct"), 0);
  assert.equal(commissionFor("Some new OTA"), 15);
});

test("monthly history fills months before the app, app bookings take over after", async () => {
  const { computeMetrics, yearlySeries } = await import("../js/perf.js");
  const houses = [{ id: 1, name: "Bhoomi" }, { id: 6, name: "Venus" }];
  const history = [
    // January 2025 from the spreadsheet
    { house_id: 1, ym: "2025-01", nights_booked: 23, nights_available: 31, room_revenue: 150000 },
    { house_id: 6, ym: "2025-01", nights_booked: 18, nights_available: 31, room_revenue: 60000 },
    // June 2026: Venus closed (0 available)
    { house_id: 1, ym: "2026-06", nights_booked: 18, nights_available: 30, room_revenue: 150000 },
    { house_id: 6, ym: "2026-06", nights_booked: 0, nights_available: 0, room_revenue: 0 },
    // February 2023: Venus not open yet (no row)
    { house_id: 1, ym: "2023-02", nights_booked: 13, nights_available: 21, room_revenue: 70000 },
  ];
  const bookings = [
    // An app booking inside a history month is ignored (history is the record)
    { house_id: 1, booking_type: "Direct", check_in: "2025-01-10", check_out: "2025-01-12", nights: 2, tariff: 99999 },
    // An app booking after history: counted normally
    { house_id: 6, booking_type: "Airbnb", check_in: "2026-10-10", check_out: "2026-10-12", nights: 2, tariff: 8000 },
  ];
  const jan = computeMetrics(bookings, houses, "2025-01-01", "2025-01-31", { history });
  assert.equal(jan.available, 62);
  assert.equal(jan.sold, 41);
  assert.equal(jan.roomRev, 210000);
  assert.equal(Math.round(jan.adr), Math.round(210000 / 41));
  assert.equal(jan.historyShare, 1);
  // Bookings in a history month still give the channel mix (nights/revenue stay from history)
  assert.equal(jan.channels.length, 1);
  assert.equal(jan.channels[0].type, "Direct");
  assert.equal(jan.appSold, 2);

  const jun = computeMetrics(bookings, houses, "2026-06-01", "2026-06-30", { history });
  assert.equal(jun.available, 30);        // Venus closed: not counted as empty
  assert.equal(jun.occupancy, 60);
  assert.equal(jun.houses.find((h) => h.id === 6).closed, true);

  const feb23 = computeMetrics(bookings, houses, "2023-02-01", "2023-02-28", { history });
  assert.equal(feb23.available, 21);      // Venus had no row: not open

  const oct = computeMetrics(bookings, houses, "2026-10-01", "2026-10-31", { history });
  assert.equal(oct.available, 62);        // after history: apartments × days
  assert.equal(oct.sold, 2);
  assert.equal(oct.historyShare, 0);

  // Half of January 2025 gets half of the month's history
  const half = computeMetrics([], houses, "2025-01-01", "2025-01-16", { history });
  assert.equal(Math.round(half.available), 32);
  assert.equal(Math.round(half.roomRev), Math.round(210000 * 16 / 31));

  const years = yearlySeries(bookings, houses, 2025, "2026-10-16", { history });
  assert.deepEqual(years.map((y) => [y.year, y.partial]), [[2025, false], [2026, true]]);
});

test("profit only counts months with expenses entered, pro-rates monthly costs", async () => {
  const { profitMetrics, monthlyProfitSeries } = await import("../js/perf.js");
  const houses = [{ id: 1, name: "Bhoomi" }];
  const history = [
    { house_id: 1, ym: "2026-08", nights_booked: 20, nights_available: 31, room_revenue: 140000 },
    { house_id: 1, ym: "2026-09", nights_booked: 18, nights_available: 30, room_revenue: 120000 },
  ];
  const expenses = {
    cats: [{ id: 1, name: "Salaries" }, { id: 2, name: "Kitchen" }],
    monthly: [{ category_id: 1, ym: "2026-09", amount: 60000 }],          // August has no expenses entered
    daily: [{ category_id: 2, spent_on: "2026-09-10", amount: 3000 }, { category_id: 2, spent_on: "2026-09-25", amount: 2000 }],
  };
  const opts = { history, expenses };
  const both = profitMetrics([], houses, "2026-08-01", "2026-09-30", opts);
  assert.equal(both.monthsTotal, 2);
  assert.equal(both.monthsCovered, 1);          // August skipped: no expenses
  assert.equal(both.revenue, 120000);           // September only
  assert.equal(both.expenses, 65000);
  assert.equal(both.profit, 55000);
  assert.equal(Math.round(both.margin), 46);
  assert.equal(both.cpor, Math.round((65000 / 18) * 100) / 100);
  assert.deepEqual(both.byCategory.map((c) => c.name), ["Salaries", "Kitchen"]);

  // First half of September: half the salary, the one daily entry before the 15th, half the revenue
  const half = profitMetrics([], houses, "2026-09-01", "2026-09-15", opts);
  assert.equal(half.expenses, 30000 + 3000);
  assert.equal(half.revenue, 60000);

  const none = profitMetrics([], houses, "2026-08-01", "2026-08-31", opts);
  assert.equal(none.hasData, false);

  const series = monthlyProfitSeries([], houses, "2026-09", opts, 2);
  assert.deepEqual(series.map((m) => [m.ym, m.hasData, m.profit]), [["2026-08", false, 0], ["2026-09", true, 55000]]);
});

test("diary bookings: channel mix in history months, Unknown left out of direct share, no extras or unpaid", async () => {
  const { computeMetrics } = await import("../js/perf.js");
  const houses = [{ id: 1, name: "Bhoomi" }, { id: 2, name: "Amazon" }];
  const history = [
    { house_id: 1, ym: "2025-03", nights_booked: 20, nights_available: 31, room_revenue: 120000 },
    { house_id: 2, ym: "2025-03", nights_booked: 0, nights_available: 0, room_revenue: 0 }, // closed
  ];
  const foodIncome = [{ ym: "2025-03", amount: 31000 }];
  const bookings = [
    { house_id: 1, booking_type: "Direct", check_in: "2025-03-07", check_out: "2025-03-09", nights: 2, tariff: 12000, from_diary: true, total_balance: 12000 },
    { house_id: 1, booking_type: "Booking.com", check_in: "2025-03-10", check_out: "2025-03-11", nights: 1, tariff: 6000, from_diary: true, total_balance: 6000 },
    { house_id: 1, booking_type: "Unknown", check_in: "2025-03-12", check_out: "2025-03-13", nights: 1, tariff: 6000, from_diary: true, total_balance: 6000 },
  ];
  const m = computeMetrics(bookings, houses, "2025-03-01", "2025-03-31", { history, foodIncome, today: "2025-04-30" });
  assert.equal(m.sold, 20);                       // nights from history
  assert.equal(m.roomRev, 120000);
  assert.equal(m.extrasRev, 31000);               // kitchen income from the diaries
  assert.equal(Math.round(m.directShare), 67);    // 12000 of 18000 known-source revenue
  assert.equal(Math.round(m.unknownShare), 25);   // 6000 of 24000
  assert.equal(m.channels.find((c) => c.type === "Unknown").unknown, true);
  assert.equal(m.commission, 1080);               // 18% of Booking.com only
  assert.equal(m.stays, 3);
  assert.equal(m.alos, 4 / 3);
  assert.equal(m.appStays, 0);                    // diary stays: no extras or payments recorded
  assert.equal(m.unpaid.length, 0);
  // Weekend nights: Fri 7 + Sat 8 Mar sold; Amazon closed, so only Bhoomi's 9 Fri/Sat nights are open
  assert.equal(Math.round(m.weekendOcc), 22);
});
