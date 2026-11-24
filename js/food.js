// Quick food bills (breakfast, meals, tea). Pure, tested in tests/food.test.mjs.
// GST, when set, is already included in the item prices (as on most restaurant bills).
import { num, formatINR, formatDate, splitGst, amountInWords } from "./calc.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => num(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r2 = (n) => Math.round(n * 100) / 100;

export const PAID_BY = { cash: "Cash", upi: "UPI", room: "Added to the room bill", credit: "To be paid" };

/** Clean item lines and work out the total and, if GST is included, its split. */
export function foodTotals(items, gstPct = 0) {
  const lines = (items || [])
    .map((l) => ({ item: String(l.item ?? "").trim(), qty: num(l.qty), rate: num(l.rate) }))
    .filter((l) => l.item && l.qty > 0)
    .map((l) => ({ ...l, amount: r2(l.qty * l.rate) }));
  const total = r2(lines.reduce((s, l) => s + l.amount, 0));
  const g = num(gstPct);
  const taxable = g > 0 ? r2(total / (1 + g / 100)) : total;
  const gst = r2(total - taxable);
  const { cgst, sgst } = splitGst(gst);
  return { lines, total, taxable, gst, cgst, sgst, gstPct: g };
}

/** Item names with their last rate, newest first, for suggestions on the form. */
export function knownItems(bills) {
  const seen = new Map();
  for (const b of [...(bills || [])].sort((a, c) => String(c.created_at || c.bill_date).localeCompare(String(a.created_at || a.bill_date)))) {
    for (const l of b.items || []) {
      const key = String(l.item || "").trim().toLowerCase();
      if (key && !seen.has(key)) seen.set(key, { item: String(l.item).trim(), rate: num(l.rate) });
    }
  }
  return [...seen.values()];
}

export function foodFileName(fb) {
  return `Food bill ${String(fb.bill_no || "").replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "") || "draft"}.pdf`;
}

/** The printable food bill, in the same style as the room bill. */
export function foodBillHTML(fb, biz, apartment) {
  const t = foodTotals(fb.items, fb.gst_pct);
  const withGst = t.gst > 0 && !!biz.gstin;
  const title = biz.gstin ? (withGst ? "Tax Invoice" : "Bill of Supply") : "Bill";
  const trade = esc(biz.trade_name || biz.legal_name);
  const legal = biz.legal_name && biz.trade_name && biz.legal_name !== biz.trade_name ? esc(biz.legal_name) : "";
  const logo = /^data:image\/(png|jpeg);base64,/.test(biz.logo ?? "") ? `<img class="bill-logo" src="${esc(biz.logo)}" alt="">` : "";
  const sig = /^data:image\/png;base64,/.test(biz.signature ?? "") ? `<img src="${esc(biz.signature)}" alt="Signature">` : "";
  const paid = fb.paid_by === "credit" ? `Balance due ${formatINR(t.total)}` : fb.paid_by === "room" ? "Added to room bill" : `Paid by ${PAID_BY[fb.paid_by] || "cash"}`;
  const due = fb.paid_by === "credit";
  const contact = [biz.phone && esc(biz.phone), biz.email && esc(biz.email)].filter(Boolean).join("&nbsp;&nbsp; ");
  return `
  <article class="bill-doc food-doc">
    <header class="bill-band">
      <p class="bb-name">${trade}</p>
      <p class="bb-sub">Food bill ${esc(fb.bill_no)}, ${formatDate(fb.bill_date)}</p>
      <p class="bb-total">${formatINR(t.total)}</p>
      <p class="bb-status ${due ? "due" : "paid"}">${paid}</p>
    </header>
    <div class="bill-card">
      <section class="bill-head">
        <div class="bill-from">
          ${logo}
          <h1>${trade}</h1>
          ${legal ? `<p><b>${legal}</b></p>` : ""}
          ${biz.address ? `<p>${esc(biz.address).replace(/\n/g, ", ")}</p>` : ""}
          ${biz.gstin ? `<p>GSTIN: <b>${esc(biz.gstin)}</b></p>` : ""}
          ${contact ? `<p>${contact}</p>` : ""}
        </div>
        <div class="bill-meta">
          <h2>${esc(title)}</h2>
          <dl>
            <dt>Bill No.</dt><dd><b>${esc(fb.bill_no)}</b></dd>
            <dt>Date</dt><dd>${formatDate(fb.bill_date)}</dd>
            ${apartment ? `<dt>Apartment</dt><dd>${esc(apartment)}</dd>` : ""}
          </dl>
        </div>
      </section>
      ${fb.guest_name ? `<section class="bill-to"><div><span class="k">Bill to</span><b>${esc(fb.guest_name)}</b>${apartment ? `<span>${esc(apartment)}</span>` : ""}</div></section>` : ""}
      <table class="bill-lines">
        <thead><tr><th class="n">#</th><th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead>
        <tbody>${t.lines.map((l, i) => `<tr><td class="n">${i + 1}</td><td><b>${esc(l.item)}</b></td><td class="r">${l.qty}</td><td class="r">${money(l.rate)}</td><td class="r">${money(l.amount)}</td></tr>`).join("")}</tbody>
      </table>
      <section class="bill-sums">
        <div class="bill-words"><span class="k">Amount in words</span><p>${amountInWords(t.total)}</p></div>
        <table class="bill-totals"><tbody>
          ${withGst ? `<tr><td>Taxable value</td><td class="r">${money(t.taxable)}</td></tr>
          <tr><td>CGST @ ${t.gstPct / 2}%</td><td class="r">${money(t.cgst)}</td></tr>
          <tr><td>SGST @ ${t.gstPct / 2}%</td><td class="r">${money(t.sgst)}</td></tr>` : ""}
          <tr class="grand"><td>Total (Rs.)</td><td class="r">${money(t.total)}</td></tr>
        </tbody></table>
      </section>
      <footer class="bill-foot">
        <div class="sign">For ${trade}${sig}<span>Authorised signatory</span></div>
        <p>${esc(biz.footer_note || "Thank you!")}</p>
        <p class="small">${withGst ? `Prices include GST (SAC 996331). ` : ""}This is a computer-generated bill. E &amp; O.E.</p>
      </footer>
    </div>
  </article>`;
}
