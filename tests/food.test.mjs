import { test } from "node:test";
import assert from "node:assert/strict";
import { foodTotals, knownItems, foodBillHTML, foodFileName } from "../js/food.js";

const items = [{ item: "Egg dosai", qty: 4, rate: 60 }, { item: "Pongal", qty: 1, rate: 200 }, { item: "Tea", qty: 3, rate: 25 }, { item: "", qty: 1, rate: 99 }, { item: "Coffee", qty: 0, rate: 30 }];

test("food totals: lines, total, GST included in prices", () => {
  const t = foodTotals(items);
  assert.equal(t.lines.length, 3);
  assert.equal(t.total, 515);
  assert.equal(t.gst, 0);
  const g = foodTotals(items, 5);
  assert.equal(g.total, 515);
  assert.equal(g.taxable, 490.48);
  assert.equal(g.gst, 24.52);
  assert.equal(r(g.cgst + g.sgst), 24.52);
});
const r = (n) => Math.round(n * 100) / 100;

test("known items: newest rate first", () => {
  const k = knownItems([
    { created_at: "2026-11-01", items: [{ item: "Tea", qty: 1, rate: 20 }] },
    { created_at: "2026-11-20", items: [{ item: "tea ", qty: 2, rate: 25 }, { item: "Pongal", qty: 1, rate: 200 }] },
  ]);
  assert.deepEqual(k, [{ item: "tea", rate: 25 }, { item: "Pongal", rate: 200 }]);
});

test("food bill HTML", () => {
  const fb = { bill_no: "TSR/F/26-27/0001", bill_date: "2026-11-24", guest_name: "Himalaya <B/F>", items, gst_pct: 0, paid_by: "cash" };
  const h = foodBillHTML(fb, { trade_name: "Two Seas Residence", gstin: "" }, "Himalaya (2 Bed)");
  assert.match(h, /Food bill TSR\/F\/26-27\/0001, 24-11-2026/);
  assert.match(h, /₹515/);
  assert.match(h, /Paid by Cash/);
  assert.match(h, /Himalaya &lt;B\/F&gt;/);
  assert.match(h, /Rupees Five Hundred Fifteen Only/);
  assert.doesNotMatch(h, /CGST/);
  const g = foodBillHTML({ ...fb, gst_pct: 5, paid_by: "room" }, { trade_name: "Two Seas", gstin: "33AAPFU0939F1ZV" }, "");
  assert.match(g, /Tax Invoice/);
  assert.match(g, /CGST @ 2.5%<\/td><td class="r">12.26/);
  assert.match(g, /Added to room bill/);
  assert.equal(foodFileName(fb), "Food bill TSR-F-26-27-0001.pdf");
});

test("food bill to a business: company and GSTIN", () => {
  const fb = { bill_no: "F1", bill_date: "2026-11-24", guest_name: "Ravi", guest_company: "Acme Pvt Ltd", guest_gstin: "27aapfu0939f1zv", items, gst_pct: 5, paid_by: "cash" };
  const h = foodBillHTML(fb, { trade_name: "Two Seas", gstin: "33AAPFU0939F1ZV" }, "Bhoomi");
  assert.match(h, /<b>Acme Pvt Ltd<\/b><span>GSTIN: <b class="gstin">27AAPFU0939F1ZV<\/b> · State code 27<\/span><span>Guest: Ravi<\/span>/);
});
