import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calcBooking, nightsBetween, suggestGstPct, staysOverlap, monthRange, toCSV, splitGst, amountInWords,
  extraAmount, extraRate, financialYear, reportPeriods, periodTotals, periodsSpan,
  addDays, availabilityGrid, occupancy,
} from "../js/calc.js";

test("addDays crosses months and years", () => {
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("availability grid: nights, carry-over and double bookings", () => {
  const stays = [
    { id: "a", house_id: 1, check_in: "2026-09-29", check_out: "2026-10-03" }, // from last month
    { id: "b", house_id: 1, check_in: "2026-10-03", check_out: "2026-10-05" }, // same-day turnover
    { id: "c", house_id: 2, check_in: "2026-10-30", check_out: "2026-11-02" }, // runs into next month
    { id: "d", house_id: 2, check_in: "2026-10-30", check_out: "2026-10-31" }, // clash with c
  ];
  const g = availabilityGrid("2026-10", [1, 2], stays);
  assert.equal(g.length, 31);
  const day = (n) => g[n - 1].cells;
  assert.deepEqual(day(1)[1].stays.map((s) => s.id), ["a"]);
  assert.equal(day(1)[1].first, true);           // carried in: label on the 1st
  assert.equal(day(2)[1].first, false);
  assert.deepEqual(day(3)[1].stays.map((s) => s.id), ["b"]); // a checked out, b checked in
  assert.equal(day(3)[1].first, true);
  assert.equal(day(5)[1].stays.length, 0);       // b checked out on the 5th
  assert.equal(day(30)[2].stays.length, 2);      // double booking
  assert.deepEqual(day(31)[2].stays.map((s) => s.id), ["c"]);
  const occ = occupancy(g, [1, 2]);
  assert.deepEqual(occ[1], { nights: 4, pct: 13 });
  assert.deepEqual(occ[2], { nights: 2, pct: 6 });
});

test("financial year runs April to March", () => {
  assert.deepEqual(financialYear("2026-10-16"), { start: "2026-04-01", end: "2027-03-31", label: "FY 2026-27" });
  assert.deepEqual(financialYear("2027-03-31"), { start: "2026-04-01", end: "2027-03-31", label: "FY 2026-27" });
  assert.equal(financialYear("2027-04-01").label, "FY 2027-28");
  assert.equal(financialYear("2026-01-05").start, "2025-04-01");
});

test("totals for today, month, FY and year to date (1 Jan to today)", () => {
  const rows = [
    { check_in: "2026-10-16", nights: 2, gross_total: 10000, gst_amount: 450, advance_ota: 9450, paid_cash: 0, paid_upi: 550 },
    { check_in: "2026-10-03", nights: 3, gross_total: 14500, gst_amount: 600, advance_ota: 5000, paid_cash: 4000, paid_upi: 5500 },
    { check_in: "2026-06-10", nights: 1, gross_total: 3000, gst_amount: 0, advance_ota: 0, paid_cash: 3000, paid_upi: 0 },
    { check_in: "2026-12-20", nights: 4, gross_total: 20000, gst_amount: 900, advance_ota: 20000, paid_cash: 0, paid_upi: 0 }, // future, same FY
    { check_in: "2026-03-30", nights: 2, gross_total: 7000, gst_amount: 0, advance_ota: 0, paid_cash: 7000, paid_upi: 0 },  // last FY, this calendar year
    { check_in: "2025-12-30", nights: 1, gross_total: 5000, gst_amount: 0, advance_ota: 0, paid_cash: 5000, paid_upi: 0 },  // last calendar year
  ];
  const periods = reportPeriods("2026-10-16");
  assert.deepEqual(periods[3], { key: "ytd", start: "2026-01-01", end: "2026-10-16" });
  assert.deepEqual(periodsSpan(periods), { start: "2026-01-01", end: "2027-03-31" });
  const [day, month, year, ytd] = periods.map((p) => periodTotals(rows, p.start, p.end));
  assert.equal(day.bookings, 1);
  assert.equal(day.afterOta, 550);
  assert.equal(month.bookings, 2);
  assert.equal(month.nights, 5);
  assert.equal(month.gross, 24500);
  assert.equal(year.bookings, 4);                 // FY Apr 2026 - Mar 2027
  assert.equal(year.gst, 1950);
  assert.equal(ytd.bookings, 4);                  // 1 Jan - 16 Oct 2026
  assert.equal(ytd.gross, 10000 + 14500 + 3000 + 7000);
  assert.equal(ytd.afterOta, 34500 - 14450);
  // In February the year to date still starts on 1 January
  assert.equal(reportPeriods("2027-02-10")[3].start, "2027-01-01");
});

test("per-day extras: rate × days", () => {
  assert.equal(extraAmount(500, 3), 1500);   // extra bed × 3 days
  assert.equal(extraAmount(600, 2), 1200);   // firewood × 2 days
  assert.equal(extraAmount(500, 0), 0);
  assert.equal(extraAmount(500, ""), 0);
  assert.equal(extraAmount(500, -2), 0);
  assert.equal(extraAmount(450.5, 2), 901);
  assert.equal(extraRate(1500, 3), 500);
  assert.equal(extraRate(600, 0), 600);      // saved before per-day: one day
});

test("per-day extras flow into gross total and balance", () => {
  const c = calcBooking({
    check_in: "2026-10-14", check_out: "2026-10-17", tariff: 10500, gst_pct: 5,
    extra_bed: extraAmount(500, 3), firewood: extraAmount(600, 2), gas: 0, paid_upi: 13725,
  });
  assert.equal(c.grossTotal, 11025 + 1500 + 1200);
  assert.equal(c.totalBalanced, true);
});

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

test("GST splits into CGST + SGST that add back to the total", () => {
  assert.deepEqual(splitGst(450), { cgst: 225, sgst: 225 });
  const s = splitGst(149.95);
  assert.equal(Math.round((s.cgst + s.sgst) * 100), 14995);
  assert.deepEqual(splitGst(0), { cgst: 0, sgst: 0 });
});

test("amount in words uses lakh and crore", () => {
  assert.equal(amountInWords(0), "Rupees Zero Only");
  assert.equal(amountInWords(10950), "Rupees Ten Thousand Nine Hundred Fifty Only");
  assert.equal(amountInWords(3148.95), "Rupees Three Thousand One Hundred Forty-Eight and Ninety-Five Paise Only");
  assert.equal(amountInWords(100000), "Rupees One Lakh Only");
  assert.equal(amountInWords(1001), "Rupees One Thousand One Only");
  assert.equal(amountInWords(12345678), "Rupees One Crore Twenty-Three Lakh Forty-Five Thousand Six Hundred Seventy-Eight Only");
  assert.equal(amountInWords(0.5), "Rupees Zero and Fifty Paise Only");
});

test("CSV escapes commas and quotes in notes", () => {
  const csv = toCSV([{ serial: 1, house_id: 1, guest_name: 'A "B", C', check_in: "2026-10-10", check_out: "2026-10-11", notes: "UPI 500, cash 200" }], () => "Apt 1");
  const line = csv.split("\r\n")[1];
  assert.match(line, /"A ""B"", C"/);
  assert.match(line, /"UPI 500, cash 200"$/);
});

test("period totals: diary stays count in bookings and gross, not in the balance", async () => {
  const { periodTotals } = await import("../js/calc.js");
  const rows = [
    { check_in: "2026-05-02", nights: 2, gross_total: 10000, gst_amount: 0, advance_ota: 0, paid_cash: 0, paid_upi: 0, from_diary: true },
    { check_in: "2026-05-03", nights: 1, gross_total: 5250, gst_amount: 250, advance_ota: 1000, paid_cash: 0, paid_upi: 4250 },
  ];
  const t = periodTotals(rows, "2026-05-01", "2026-05-31");
  assert.equal(t.bookings, 2);
  assert.equal(t.nights, 3);
  assert.equal(t.gross, 15250);
  assert.equal(t.afterOta, 4250);
  assert.equal(t.diary, 1);
});

test("closed dates: whole property or one apartment, direct-only applies to direct types", async () => {
  const { closureOn, closureClash } = await import("../js/calc.js");
  const closures = [
    { house_id: null, start_date: "2026-11-06", end_date: "2026-11-09", direct_only: true, note: "No direct" },
    { house_id: 2, start_date: "2026-12-01", end_date: "2026-12-03", direct_only: false, note: "Painting" },
  ];
  assert.equal(closureOn(closures, 4, "2026-11-08").note, "No direct");
  assert.equal(closureOn(closures, 4, "2026-11-09"), null);        // end date is open again
  assert.equal(closureOn(closures, 1, "2026-12-01"), null);        // other apartment
  assert.equal(closureOn(closures, 2, "2026-12-02").note, "Painting");
  const b = (type, house, ci, co) => ({ booking_type: type, house_id: house, check_in: ci, check_out: co });
  assert.equal(closureClash(closures, b("Direct", 1, "2026-11-05", "2026-11-07")).note, "No direct");
  assert.equal(closureClash(closures, b("Booking.com", 1, "2026-11-05", "2026-11-07")), null);
  assert.equal(closureClash(closures, b("Direct", 1, "2026-11-04", "2026-11-06")), null); // leaves the day it starts
  assert.equal(closureClash(closures, b("Airbnb", 2, "2026-12-02", "2026-12-04")).note, "Painting");
});
