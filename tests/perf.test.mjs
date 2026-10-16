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
  assert.deepEqual([perfPeriod("month", t).start, perfPeriod("month", t).end], ["2026-10-01", "2026-10-31"]);
  assert.deepEqual([perfPeriod("month", t).prev.start, perfPeriod("month", t).prev.end], ["2026-09-01", "2026-09-30"]);
  assert.deepEqual([perfPeriod("last_3", t).start, perfPeriod("last_3", t).end], ["2026-07-01", "2026-09-30"]);
  assert.deepEqual([perfPeriod("ytd", t).start, perfPeriod("ytd", t).prev.end], ["2026-01-01", "2025-10-16"]);
  assert.deepEqual([perfPeriod("fy", t).start, perfPeriod("fy", t).end], ["2026-04-01", "2027-03-31"]);
  assert.equal(perfPeriod("fy", "2027-02-01").start, "2026-04-01");
  assert.deepEqual([perfPeriod("last_12", t).start, perfPeriod("last_12", t).end], ["2025-11-01", "2026-10-31"]);
  assert.equal(perfPeriod("month", "2026-01-10").prev.start, "2025-12-01");
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
