import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calcBooking, nightsBetween, suggestGstPct, staysOverlap, monthRange, toCSV,
} from "../js/calc.js";

test("nights between dates, across month and year ends", () => {
  assert.equal(nightsBetween("2026-10-10", "2026-10-12"), 2);
  assert.equal(nightsBetween("2026-10-30", "2026-11-02"), 3);
  assert.equal(nightsBetween("2026-12-31", "2027-01-01"), 1);
  assert.equal(nightsBetween("2026-10-12", "2026-10-12"), 0);
  assert.equal(nightsBetween("2026-10-12", "2026-10-10"), 0);
  assert.equal(nightsBetween("", "2026-10-10"), 0);
});

test("OTA booking fully paid, extras by UPI is balanced", () => {
  const c = calcBooking({
    check_in: "2026-10-10", check_out: "2026-10-12", tariff: 9000, gst_pct: 5,
    food_bill: 1200, firewood: 300, advance_ota: 9450, paid_upi: 1500,
  });
  assert.equal(c.nights, 2);
  assert.equal(c.gstAmount, 450);
  assert.equal(c.totalTariff, 9450);
  assert.equal(c.grossTotal, 10950);
  assert.equal(c.totalBalance, 1500);
  assert.equal(c.totalBalanced, true);
});

test("short payment is not balanced and reports the gap", () => {
  const c = calcBooking({
    check_in: "2026-10-13", check_out: "2026-10-16", tariff: 12000, gst_pct: 5,
    extra_bed: 1500, gas: 400, advance_ota: 5000, paid_cash: 4000,
    cash_received: 4500, tips: 500, paid_upi: 5000,
  });
  assert.equal(c.grossTotal, 14500);
  assert.equal(c.totalBalance, 9500);
  assert.equal(c.difference, -500);
  assert.equal(c.totalBalanced, false);
  assert.equal(c.changeToReturn, 0);
});

test("blank fields count as zero and paise round to 2 places", () => {
  const c = calcBooking({ check_in: "2026-01-01", check_out: "2026-01-02", tariff: "2999", gst_pct: "5", paid_cash: "3148.95" });
  assert.equal(c.gstAmount, 149.95);
  assert.equal(c.totalBalance, 3148.95);
  assert.equal(c.totalBalanced, true);
});

test("GST suggestion by per-night rate", () => {
  assert.equal(suggestGstPct(1800, 2), 0);
  assert.equal(suggestGstPct(15000, 2), 5);
  assert.equal(suggestGstPct(16000, 2), 18);
  assert.equal(suggestGstPct(0, 2), null);
  assert.equal(suggestGstPct(5000, 0), null);
});

test("check-out day can be the next guest's check-in day", () => {
  assert.equal(staysOverlap("2026-10-10", "2026-10-12", "2026-10-12", "2026-10-14"), false);
  assert.equal(staysOverlap("2026-10-10", "2026-10-13", "2026-10-12", "2026-10-14"), true);
});

test("month range handles February and 31-day months", () => {
  assert.deepEqual(monthRange("2026-02"), ["2026-02-01", "2026-02-28"]);
  assert.deepEqual(monthRange("2028-02"), ["2028-02-01", "2028-02-29"]);
  assert.deepEqual(monthRange("2026-10"), ["2026-10-01", "2026-10-31"]);
});

test("CSV escapes commas and quotes in notes", () => {
  const csv = toCSV([{ serial: 1, house_id: 1, guest_name: 'A "B", C', check_in: "2026-10-10", check_out: "2026-10-11", notes: "UPI 500, cash 200" }], () => "Apt 1");
  const line = csv.split("\r\n")[1];
  assert.match(line, /"A ""B"", C"/);
  assert.match(line, /"UPI 500, cash 200"$/);
});
