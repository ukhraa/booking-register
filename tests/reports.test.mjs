import { test } from "node:test";
import assert from "node:assert/strict";
import { gstReport, gstCSV, guestRegister, guestRegisterCSV, pastStays, isForeign, gstinProblem } from "../js/reports.js";

const B = (o) => ({ id: Math.random().toString(36), food_bill: 0, extra_bed: 0, firewood: 0, gas: 0, advance_ota: 0, paid_cash: 0, paid_upi: 0, gst_pct: 0, ...o });
const rows = [
  B({ bill_no: "TSR/26-27/0002", house_id: 1, guest_name: "A", check_in: "2026-10-29", check_out: "2026-11-02", tariff: 20000, gst_pct: 5, food_bill: 1000 }),
  B({ bill_no: "TSR/26-27/0003", house_id: 2, guest_name: "B", check_in: "2026-11-05", check_out: "2026-11-06", tariff: 9000, gst_pct: 18, guest_company: "Acme Pvt Ltd", guest_gstin: "27aapfu0939f1zv" }),
  B({ bill_no: "", house_id: 3, guest_name: "C", check_in: "2026-11-10", check_out: "2026-11-12", tariff: 1800, gst_pct: 0 }),
  B({ bill_no: "", house_id: 3, guest_name: "Diary", check_in: "2026-11-01", check_out: "2026-11-03", tariff: 5000, from_diary: true }),
  B({ bill_no: "TSR/26-27/0009", house_id: 1, guest_name: "Dec", check_in: "2026-11-30", check_out: "2026-12-02", tariff: 5000, gst_pct: 5 }),
];

test("GST report: by check-out month, by rate, diary left out", () => {
  assert.equal(gstReport(rows, "2026-11", "2026-11-08").lines.length, 2);  // C checks out on the 12th
  assert.equal(gstReport(rows, "2026-11", "2026-11-08").notCheckedOut, 1);
  const r = gstReport(rows, "2026-11");
  assert.equal(r.lines.length, 3);
  assert.deepEqual(r.rates.map((g) => [g.rate, g.bills, g.taxable, g.gst]), [[0, 1, 1800, 0], [5, 1, 20000, 1000], [18, 1, 9000, 1620]]);
  assert.equal(r.rates[1].cgst, 500);
  assert.equal(r.rates[1].other, 1000);
  assert.deepEqual(r.totals, { bills: 3, taxable: 30800, cgst: 1310, sgst: 1310, gst: 2620, other: 1000, total: 34420 });
  assert.equal(r.missingBillNo.length, 1);
  assert.deepEqual(r.b2b.map((l) => [l.gstin, l.company]), [["27AAPFU0939F1ZV", "Acme Pvt Ltd"]]);
  assert.deepEqual(r.b2bTotals, { bills: 1, taxable: 9000, gst: 1620, total: 10620 });
  assert.equal(r.b2cTotals.bills, 2);
  const csv = gstCSV(r, (id) => `H${id}`, { trade_name: "Two Seas", gstin: "33X" });
  assert.match(csv, /^GST report 2026-11,Two Seas,GSTIN 33X/);
  assert.match(csv, /Total,3,30800,1310,1310,2620,1000,34420/);
  assert.match(csv, /\(no bill no\.\),12-11-2026/);
  assert.match(csv, /TSR\/26-27\/0003,06-11-2026,B,Acme Pvt Ltd,27AAPFU0939F1ZV,/);
});

test("guest register: stays in the month, missing details, foreigners", () => {
  const g = guestRegister([
    B({ house_id: 1, guest_name: "Asha", check_in: "2026-10-30", check_out: "2026-11-02", adults: 2, id_number: "1234", guest_address: "Chennai" }),
    B({ house_id: 2, guest_name: "Tom", check_in: "2026-11-20", check_out: "2026-11-22", nationality: "British", adults: 1 }),
    B({ house_id: 2, guest_name: "Out", check_in: "2026-10-28", check_out: "2026-10-31" }),
  ], "2026-11");
  assert.deepEqual(g.map((r) => r.guest), ["Asha", "Tom"]);
  assert.deepEqual(g[0].missing, []);
  assert.deepEqual(g[1].missing, ["ID", "address", "visa"]);
  assert.equal(g[1].foreign, true);
  assert.equal(isForeign({ nationality: "Indian" }), false);
  assert.match(guestRegisterCSV(g, () => "Bhoomi"), /30-10-2026,02-11-2026,Bhoomi,Asha/);
});

test("past stays: by phone (last 10 digits) or exact name", () => {
  const all = [
    B({ id: "1", guest_name: "Ravi Kumar", guest_phone: "+91 98765 43210", check_in: "2025-06-10" }),
    B({ id: "2", guest_name: "ravi  kumar", guest_phone: "", check_in: "2024-01-05" }),
    B({ id: "3", guest_name: "Someone", guest_phone: "9876543210", check_in: "2023-03-01" }),
    B({ id: "4", guest_name: "Ravi Kumar", check_in: "2026-12-01" }),
  ];
  assert.deepEqual(pastStays(all, { phone: "98765-43210", name: "Ravi Kumar", excludeId: "4" }).map((b) => b.id), ["1", "2", "3"]);
  assert.deepEqual(pastStays(all, { name: "Ravi Kumar", before: "2026-01-01" }).map((b) => b.id), ["1", "2"]);
  assert.deepEqual(pastStays(all, { name: "Ra" }), []);
});

test("GSTIN check", () => {
  assert.equal(gstinProblem(""), "");
  assert.equal(gstinProblem("27AAPFU0939F1ZV"), "");
  assert.equal(gstinProblem("27 aapfu 0939 f1zv"), "");
  assert.match(gstinProblem("27AAPFU0939F1ZX"), /typo/);
  assert.match(gstinProblem("27AAPFU0939F1"), /15 characters/);
  assert.match(gstinProblem("ABCDEFGHIJKLMNO"), /doesn't look like/);
});

test("GST report includes food bills (GST inside the price), B2B when they have a GSTIN", () => {
  const food = [
    { id: "f1", bill_no: "TSR/F/26-27/0001", bill_date: "2026-11-24", house_id: 4, guest_name: "Ravi", items: [{ item: "Thali", qty: 2, rate: 210 }], gst_pct: 5, guest_company: "Acme", guest_gstin: "27AAPFU0939F1ZV" },
    { id: "f2", bill_no: "TSR/F/26-27/0002", bill_date: "2026-11-25", items: [{ item: "Tea", qty: 3, rate: 25 }], gst_pct: 0 },
    { id: "f3", bill_no: "TSR/F/26-27/0003", bill_date: "2026-12-01", items: [{ item: "Tea", qty: 1, rate: 25 }], gst_pct: 0 },
  ];
  const r = gstReport([], "2026-11", null, food);
  assert.equal(r.lines.length, 2);
  assert.deepEqual(r.rates.map((g) => [g.rate, g.bills, g.taxable, g.gst, g.total]), [[0, 1, 75, 0, 75], [5, 1, 400, 20, 420]]);
  assert.equal(r.b2b.length, 1);
  assert.equal(r.b2b[0].food, true);
});
