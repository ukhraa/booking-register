// Printable guest bill. Pure: builds the bill's HTML from a saved booking and
// the business details, so the figures always match the register.
// Layout: a coloured band with the total, then the invoice card (seller, bill
// meta, bill-to box, item table with GST columns, totals, payments, bank/UPI
// details and signature). Tested in tests/bill.test.mjs.
import { calcBooking, splitGst, amountInWords, formatINR, formatDate, num, extraRate } from "./calc.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => num(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// SAC 996311: room accommodation services.
const SAC_ROOM = "996311";

/** "Tax Invoice" when GST is charged, "Bill of Supply" for a nil-GST stay, plain "Bill" when no GSTIN is set. */
export function billTitle(biz, gstAmount) {
  if (!biz.gstin) return "Bill";
  return num(gstAmount) > 0 ? "Tax Invoice" : "Bill of Supply";
}

/** "98XXXXXX10": a guest's number on a bill that may be forwarded, like most hotel invoices. */
export function maskPhone(raw) {
  const d = String(raw ?? "").replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
  if (d.length < 6) return "";
  return `${d.slice(0, 2)}${"X".repeat(d.length - 4)}${d.slice(-2)}`;
}

/** The bill's item lines: [{ item, detail, sac, qty, unit, rate, gstPct, taxable, amount }]. */
export function billLines(b, apartment) {
  const c = calcBooking(b);
  const lines = [{
    item: `Room charges · ${apartment}`,
    detail: `${formatDate(b.check_in)} to ${formatDate(b.check_out)}`,
    sac: SAC_ROOM, qty: c.nights, unit: c.nights === 1 ? "night" : "nights",
    rate: c.nights ? num(b.tariff) / c.nights : 0,
    gstPct: num(b.gst_pct), taxable: num(b.tariff), amount: num(b.tariff) + c.gstAmount,
  }];
  [["Extra bed", "extra_bed"], ["Firewood", "firewood"], ["Gas", "gas"]].forEach(([label, k]) => {
    const amount = num(b[k]);
    if (amount <= 0) return;
    const days = Math.max(1, Math.floor(num(b[`${k}_days`])));
    lines.push({ item: label, detail: "", sac: "", qty: days, unit: days === 1 ? "day" : "days", rate: extraRate(amount, days), gstPct: null, taxable: amount, amount });
  });
  if (num(b.food_bill) > 0) lines.push({ item: "Food", detail: "", sac: "", qty: null, unit: "", rate: null, gstPct: null, taxable: num(b.food_bill), amount: num(b.food_bill) });
  return lines;
}

/**
 * @param b    saved booking row (needs bill_no)
 * @param biz  business_profile row: trade_name, legal_name, address, phone, email, gstin, state,
 *             footer_note, signature, logo, bank_account_name, bank_account_no, bank_ifsc, bank_name, upi_id
 * @param apartment  apartment name
 */
export function billHTML(b, biz, apartment) {
  const c = calcBooking(b);
  const { cgst, sgst } = splitGst(c.gstAmount);
  const halfPct = num(b.gst_pct) / 2;
  const lines = billLines(b, apartment);
  const taxable = lines.reduce((s, l) => s + l.taxable, 0);
  const withSac = !!biz.gstin;
  const title = billTitle(biz, c.gstAmount);

  const advance = num(b.advance_ota);
  const due = c.totalBalance - c.collected;
  const paidNote = due > 0.5 ? `Balance due ${formatINR(due)}` : "Paid in full";
  const pay = [];
  if (advance > 0) pay.push([/^(Direct|Walk-in|Phone)/.test(b.booking_type || "") ? "Advance received" : `Paid to ${b.booking_type || "OTA"}`, money(advance)]);
  if (num(b.paid_cash) > 0) pay.push(["Received in cash", money(b.paid_cash)]);
  if (num(b.paid_upi) > 0) pay.push(["Received by UPI", money(b.paid_upi)]);

  const trade = esc(biz.trade_name || biz.legal_name);
  const legal = biz.legal_name && biz.legal_name !== biz.trade_name && biz.trade_name ? esc(biz.legal_name) : "";
  const placeOfSupply = biz.state ? `${esc(biz.state)}${biz.gstin ? ` (${esc(biz.gstin.slice(0, 2))})` : ""}` : "";
  const contact = [biz.phone && esc(biz.phone), biz.email && esc(biz.email)].filter(Boolean).join("&nbsp;&nbsp; ");
  const logo = /^data:image\/(png|jpeg);base64,/.test(biz.logo ?? "") ? `<img class="bill-logo" src="${esc(biz.logo)}" alt="">` : "";
  const sig = /^data:image\/png;base64,/.test(biz.signature ?? "") ? `<img src="${esc(biz.signature)}" alt="Signature">` : "";
  const guests = [num(b.adults) && `${num(b.adults)} adult${num(b.adults) === 1 ? "" : "s"}`, num(b.children) && `${num(b.children)} child${num(b.children) === 1 ? "" : "ren"}`].filter(Boolean).join(", ");
  const phone = maskPhone(b.guest_phone);
  const gstin = String(b.guest_gstin ?? "").replace(/\s+/g, "").toUpperCase();
  const company = String(b.guest_company ?? "").trim();
  const bank = biz.bank_account_no && biz.bank_ifsc
    ? [["Account name", biz.bank_account_name], ["Account no.", biz.bank_account_no], ["IFSC", biz.bank_ifsc], ["Bank", biz.bank_name]].filter(([, v]) => v)
    : [];
  const showPay = due > 0.5 && (bank.length || biz.upi_id);

  const row = (l, i) => `<tr>
      <td class="n">${i + 1}</td>
      <td><b>${esc(l.item)}</b>${l.detail || (withSac && l.sac) ? `<small>${[withSac && l.sac ? `SAC ${l.sac}` : "", esc(l.detail)].filter(Boolean).join(", ")}</small>` : ""}</td>
      <td class="r">${l.qty == null ? "" : `${l.qty} <small class="u">${l.unit}</small>`}</td>
      <td class="r">${l.rate == null ? "" : money(l.rate)}</td>
      <td class="r">${l.gstPct == null ? "–" : `${l.gstPct}%`}</td>
      <td class="r">${money(l.taxable)}</td>
      <td class="r">${money(l.amount)}</td>
    </tr>`;

  return `
  <article class="bill-doc">
    <header class="bill-band">
      <p class="bb-name">${trade}</p>
      <p class="bb-sub">${esc(title)} ${esc(b.bill_no)}, ${formatDate(b.check_out)}</p>
      <p class="bb-total">${formatINR(c.grossTotal)}</p>
      <p class="bb-status ${due > 0.5 ? "due" : "paid"}">${paidNote}</p>
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
            <dt>${title === "Bill" ? "Bill" : "Invoice"} No.</dt><dd><b>${esc(b.bill_no)}</b></dd>
            <dt>Date</dt><dd>${formatDate(b.check_out)}</dd>
            ${placeOfSupply ? `<dt>Place of supply</dt><dd>${placeOfSupply}</dd>` : ""}
            ${biz.gstin ? `<dt>Reverse charge</dt><dd>No</dd>` : ""}
            <dt>Booking</dt><dd>${esc(b.booking_type)}${b.ota_ref ? ` ${esc(b.ota_ref)}` : ""}</dd>
          </dl>
        </div>
      </section>

      <section class="bill-to">
        <div>
          <span class="k">Bill to</span>
          <b>${esc(company || b.guest_name)}</b>
          ${gstin ? `<span>GSTIN: <b class="gstin">${esc(gstin)}</b>${gstin.slice(0, 2) ? ` · State code ${esc(gstin.slice(0, 2))}` : ""}</span>` : ""}
          ${company ? `<span>Guest: ${esc(b.guest_name)}</span>` : ""}
          ${b.guest_address ? `<span>${esc(b.guest_address)}</span>` : ""}
          ${phone ? `<span>${phone}</span>` : ""}
        </div>
        <div>
          <span class="k">Stay</span>
          <b>${esc(apartment)}</b>
          <span>${formatDate(b.check_in)} to ${formatDate(b.check_out)} · ${c.nights} night${c.nights === 1 ? "" : "s"}</span>
          ${guests ? `<span>${guests}</span>` : ""}
        </div>
      </section>

      <table class="bill-lines">
        <thead><tr><th class="n">#</th><th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">GST</th><th class="r">Taxable value</th><th class="r">Amount</th></tr></thead>
        <tbody>${lines.map(row).join("")}</tbody>
      </table>

      <section class="bill-sums">
        <div class="bill-words">
          <span class="k">Amount in words</span>
          <p>${amountInWords(c.grossTotal)}</p>
          ${pay.length ? `<span class="k">Payments</span><table class="bill-pay"><tbody>${pay.map(([l, v]) => `<tr><td>${esc(l)}</td><td class="r">${v}</td></tr>`).join("")}</tbody></table>` : ""}
        </div>
        <table class="bill-totals"><tbody>
          <tr><td>Taxable value</td><td class="r">${money(taxable)}</td></tr>
          ${c.gstAmount > 0 ? `<tr><td>CGST @ ${halfPct}%</td><td class="r">${money(cgst)}</td></tr><tr><td>SGST @ ${halfPct}%</td><td class="r">${money(sgst)}</td></tr>` : ""}
          <tr class="grand"><td>Total (Rs.)</td><td class="r">${money(c.grossTotal)}</td></tr>
          ${due > 0.5 ? `<tr class="due"><td>Balance due</td><td class="r">${money(due)}</td></tr>` : ""}
        </tbody></table>
      </section>

      ${showPay ? `<section class="bill-bank">
        <span class="k">Pay by ${bank.length ? "bank transfer" : ""}${bank.length && biz.upi_id ? " or " : ""}${biz.upi_id ? "UPI" : ""}</span>
        <dl>${bank.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}${biz.upi_id ? `<dt>UPI ID</dt><dd>${esc(biz.upi_id)}</dd>` : ""}</dl>
        <p><b>Please write ${esc(b.bill_no)} in the payment remark.</b></p>
      </section>` : ""}

      <footer class="bill-foot">
        <div class="sign">For ${trade}${sig}<span>Authorised signatory</span></div>
        <p>${esc(biz.footer_note || "Thank you for staying with us.")}</p>
        <p class="small">${c.gstAmount > 0 ? "GST is charged on the room tariff. " : ""}This is a computer-generated ${title === "Bill" ? "bill" : "invoice"}. E &amp; O.E.</p>
      </footer>
    </div>
  </article>`;
}
