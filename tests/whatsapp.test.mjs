import { test } from "node:test";
import assert from "node:assert/strict";
import { waPhone, prettyPhone, billMessage, waLink, billFileName, jpegToPdf } from "../js/whatsapp.js";

test("phone numbers for WhatsApp", () => {
  assert.equal(waPhone("98765 43210"), "919876543210");
  assert.equal(waPhone("+91 98765-43210"), "919876543210");
  assert.equal(waPhone("09876543210"), "919876543210");
  assert.equal(waPhone("919876543210"), "919876543210");
  assert.equal(waPhone("+44 7700 900123"), "447700900123");
  assert.equal(waPhone("0044 7700 900123"), "447700900123");
  assert.equal(waPhone("12345"), "");
  assert.equal(waPhone(""), "");
  assert.equal(prettyPhone("919876543210"), "+91 98765 43210");
});

test("bill message: total, paid and balance", () => {
  const b = { guest_name: "Ravi Kumar", bill_no: "TSR/26-27/0007", check_in: "2026-10-10", check_out: "2026-10-12",
    tariff: 10000, gst_pct: 5, food_bill: 500, advance_ota: 3000, paid_cash: 0, paid_upi: 5000 };
  const m = billMessage(b, "Two Seas Residence", "Bhoomi (3 Bed)");
  assert.match(m, /^Hello Ravi,/);
  assert.match(m, /Bill TSR\/26-27\/0007 · Bhoomi \(3 Bed\)/);
  assert.match(m, /2 nights/);
  assert.match(m, /Total: ₹11,000/);
  assert.match(m, /Paid: ₹8,000/);
  assert.match(m, /Balance due: ₹3,000/);
  const paid = billMessage({ ...b, paid_upi: 8000 }, "Two Seas Residence", "Bhoomi");
  assert.match(paid, /Paid in full/);
  assert.equal(waLink("919876543210", "Hi & bye"), "https://wa.me/919876543210?text=Hi%20%26%20bye");
  assert.equal(billFileName(b), "Bill TSR-26-27-0007.pdf");
});

test("PDF from a JPEG: valid structure and offsets", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const pdf = jpegToPdf(jpeg, 800, 1000);
  const text = Buffer.from(pdf).toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4"));
  assert.ok(text.trimEnd().endsWith("%%EOF"));
  const startxref = Number(text.match(/startxref\n(\d+)/)[1]);
  assert.equal(text.slice(startxref, startxref + 4), "xref");
  const offs = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  offs.forEach((o, i) => assert.equal(text.slice(o, o + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
  assert.match(text, /\/Width 800 \/Height 1000/);
  assert.match(text, /\/Length 4 >>/);
});
