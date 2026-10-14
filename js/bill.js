// Printable guest bill. Pure: builds the bill's HTML from a saved booking and
// the business details, so the figures always match the register.
import { calcBooking, splitGst, amountInWords, formatINR, formatDate, num } from "./calc.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// SAC 996311: room accommodation services.
const SAC_ROOM = "996311";

/** "Tax Invoice" when GST is charged, "Bill of Supply" for a nil-GST stay, plain "Bill" when no GSTIN is set. */
export function billTitle(biz, gstAmount) {
  if (!biz.gstin) return "Bill";
  return num(gstAmount) > 0 ? "Tax Invoice" : "Bill of Supply";
}

/**
 * @param b    saved booking row (needs bill_no)
 * @param biz  business_profile row: legal_name, address, phone, email, gstin, state, footer_note
 * @param apartment  apartment name
 */
export function billHTML(b, biz, apartment) {
  const c = calcBooking(b);
  const { cgst, sgst } = splitGst(c.gstAmount);
  const halfPct = num(b.gst_pct) / 2;
  const perNight = c.nights ? num(b.tariff) / c.nights : 0;
  const withSac = !!biz.gstin;

  const lines = [[
    `Room charges · ${esc(apartment)}<small>${c.nights} night${c.nights === 1 ? "" : "s"} × ${formatINR(perNight)}</small>`,
    SAC_ROOM, num(b.tariff),
  ]];
  if (c.gstAmount > 0) lines.push([`CGST @ ${halfPct}%`, "", cgst], [`SGST @ ${halfPct}%`, "", sgst]);
  [["Food", "food_bill"], ["Extra bed", "extra_bed"], ["Firewood", "firewood"], ["Gas", "gas"]]
    .forEach(([label, k]) => { if (num(b[k]) > 0) lines.push([label, "", num(b[k])]); });

  const advance = num(b.advance_ota);
  const due = c.totalBalance - c.collected;
  const pay = [];
  if (advance > 0) pay.push(["Less: advance / paid online", `− ${formatINR(advance)}`]);
  if (advance > 0) pay.push(["Payable at check-out", formatINR(c.totalBalance)]);
  if (num(b.paid_cash) > 0) pay.push(["Received in cash", formatINR(b.paid_cash)]);
  if (num(b.paid_upi) > 0) pay.push(["Received by UPI", formatINR(b.paid_upi)]);

  const name = esc(biz.legal_name);
  const placeOfSupply = biz.state ? `${esc(biz.state)}${biz.gstin ? ` (${esc(biz.gstin.slice(0, 2))})` : ""}` : "";
  const contact = [biz.phone && `Phone ${esc(biz.phone)}`, biz.email && esc(biz.email)].filter(Boolean).join(" · ");

  return `
  <article class="bill-doc">
    <header class="bill-head">
      <div class="bill-from">
        <h1>${name}</h1>
        ${biz.address ? `<p class="addr">${esc(biz.address)}</p>` : ""}
        ${contact ? `<p>${contact}</p>` : ""}
        ${biz.gstin ? `<p><b>GSTIN</b> ${esc(biz.gstin)}</p>` : ""}
      </div>
      <div class="bill-meta">
        <h2>${billTitle(biz, c.gstAmount)}</h2>
        <dl>
          <dt>Bill No.</dt><dd>${esc(b.bill_no)}</dd>
          <dt>Date</dt><dd>${formatDate(b.check_out)}</dd>
          ${placeOfSupply ? `<dt>Place of supply</dt><dd>${placeOfSupply}</dd>` : ""}
        </dl>
      </div>
    </header>

    <section class="bill-parties">
      <div><span class="k">Billed to</span><b>${esc(b.guest_name)}</b></div>
      <div><span class="k">Stay</span>${esc(apartment)}<br>${formatDate(b.check_in)} to ${formatDate(b.check_out)} · ${c.nights} night${c.nights === 1 ? "" : "s"}</div>
      <div><span class="k">Booking</span>${esc(b.booking_type)}<br>Ref. #${b.serial}</div>
    </section>

    <table class="bill-lines">
      <thead><tr><th>Description</th>${withSac ? "<th>SAC</th>" : ""}<th class="r">Amount</th></tr></thead>
      <tbody>${lines.map(([d, sac, amt]) => `<tr><td>${d}</td>${withSac ? `<td>${sac}</td>` : ""}<td class="r">${formatINR(amt)}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td${withSac ? ' colspan="2"' : ""}>Total</td><td class="r">${formatINR(c.grossTotal)}</td></tr></tfoot>
    </table>
    <p class="bill-words">${amountInWords(c.grossTotal)}</p>

    ${pay.length ? `<table class="bill-pay"><tbody>${pay.map(([l, v]) => `<tr><td>${l}</td><td class="r">${v}</td></tr>`).join("")}</tbody></table>` : ""}
    <p class="bill-status ${due > 0.5 ? "due" : "paid"}">${due > 0.5 ? `Balance due: ${formatINR(due)}` : "Paid in full"}</p>

    <footer class="bill-foot">
      ${biz.footer_note ? `<p>${esc(biz.footer_note)}</p>` : ""}
      <div class="sign">For ${name}<span>Authorised signatory</span></div>
      <p class="small">This is a computer-generated bill.</p>
    </footer>
  </article>`;
}
