import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calcBooking, nightsBetween, suggestGstPct, staysOverlap, monthRange, toCSV, splitGst, amountInWords,
  extraAmount, extraRate, financialYear, reportPeriods, periodTotals,
} from "../js/calc.js";

test("financial year runs April to March", () => {
  assert.deepEqual(financialYear("2026-10-16"), { start: "2026-04-01", end: "2027-03-31", label: "FY 2026-27" });
  assert.deepEqual(financialYear("2027-03-31"), { start: "2026-04-01", end: "2027-03-31", label: "FY 2026-27" });
  assert.equal(financialYear("2027-04-01").label, "FY 2027-28");
  assert.equal(financialYear("2026-01-05").start, "2025-04-01");
});

test("totals for today, month, year and year to date", () => {
  const rows = [
    { check_in: "2026-10-16", nights: 2, gross_total: 10000, gst_amount: 450, advance_ota: 9450, paid_cash: 0, paid_upi: 550 },
    { check_in: "2026-10-03", nights: 3, gross_total: 14500, gst_amount: 600, advance_ota: 5000, paid_cash: 4000, paid_upi: 5500 },
    { check_in: "2026-06-10", nights: 1, gross_total: 3000, gst_amount: 0, advance_ota: 0, paid_cash: 3000, paid_upi: 0 },
    { check_in: "2026-12-20", nights: 4, gross_total: 20000, gst_amount: 900, advance_ota: 20000, paid_cash: 0, paid_upi: 0 }, // future, same FY
    { check_in: "2026-03-30", nights: 2, gross_total: 7000, gst_amount: 0, advance_ota: 0, paid_cash: 7000, paid_upi: 0 },  // last FY
  ];
  const [day, month, year, ytd] = reportPeriods("2026-10-16").map((p) => periodTotals(rows, p.start, p.end));
  assert.equal(day.bookings, 1);
  assert.equal(day.afterOta, 550);
  assert.equal(month.bookings, 2);
  assert.equal(month.nights, 5);
  assert.equal(month.gross, 24500);
  assert.equal(month.cash, 4000);
  assert.equal(year.bookings, 4);
  assert.equal(year.gst, 1950);
  assert.equal(ytd.bookings, 3);
  assert.equal(ytd.gross, 27500);
  assert.equal(ytd.afterOta, 27500 - 14450);
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
