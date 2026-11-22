import { test } from "node:test";
import assert from "node:assert/strict";
import { billHTML, billLines, maskPhone, billTitle } from "../js/bill.js";

const b = {
  serial: 7, bill_no: "TSR/26-27/0009", booking_type: "Direct", guest_name: "Ravi <Kumar>", guest_phone: "98765 43210",
  check_in: "2026-11-18", check_out: "2026-11-21", tariff: 15000, gst_pct: 5, food_bill: 900,
  extra_bed: 1000, extra_bed_days: 2, firewood: 0, gas: 0, advance_ota: 5000, paid_cash: 0, paid_upi: 6000, adults: 2, children: 1,
};
const biz = { trade_name: "Two Seas Residence", legal_name: "Two Seas Hospitality", gstin: "33ABCDE1234F1Z5", state: "Tamil Nadu",
  address: "300H, Arani House\\nOoty", bank_account_no: "123456789", bank_ifsc: "SBIN0000001", bank_account_name: "Two Seas", upi_id: "twoseas@sbi" };

test("phone numbers are masked on the bill", () => {
  assert.equal(maskPhone("98765 43210"), "98XXXXXX10");
  assert.equal(maskPhone("+91 98765 43210"), "98XXXXXX10");
  assert.equal(maskPhone(""), "");
});

test("bill lines: room with GST, extras per day, food", () => {
  const l = billLines(b, "Bhoomi");
  assert.equal(l.length, 3);
  assert.deepEqual([l[0].qty, l[0].rate, l[0].gstPct, l[0].taxable, l[0].amount], [3, 5000, 5, 15000, 15750]);
  assert.deepEqual([l[1].item, l[1].qty, l[1].rate, l[1].amount], ["Extra bed", 2, 500, 1000]);
  assert.equal(l[2].item, "Food");
});

test("bill HTML: totals, balance, bank details, escaping", () => {
  const h = billHTML(b, biz, "Bhoomi (3 Bed)");
  assert.match(h, /Tax Invoice TSR\/26-27\/0009, 21-11-2026/);
  assert.match(h, /₹17,650/);                          // 15,000 + 750 GST + 1,000 + 900
  assert.match(h, /Taxable value<\/td><td class="r">16,900.00/);
  assert.match(h, /CGST @ 2.5%<\/td><td class="r">375.00/);
  assert.match(h, /Balance due ₹6,650/);
  assert.match(h, /Advance received/);
  assert.match(h, /SBIN0000001/);
  assert.match(h, /Please write TSR\/26-27\/0009 in the payment remark/);
  assert.match(h, /Ravi &lt;Kumar&gt;/);
  assert.match(h, /98XXXXXX10/);
  assert.match(h, /2 adults, 1 child/);
  const paid = billHTML({ ...b, paid_upi: 12650 }, biz, "Bhoomi");
  assert.match(paid, /Paid in full/);
  assert.doesNotMatch(paid, /payment remark/);       // no bank details once paid
  assert.equal(billTitle({ gstin: "" }, 100), "Bill");
});
