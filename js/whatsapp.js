// Sending a guest bill on WhatsApp. Pure helpers (tested in tests/whatsapp.test.mjs):
// the phone number in the form wa.me wants, the message text, and a one-page
// PDF made from a JPEG picture of the bill (no PDF library needed).
import { calcBooking, formatINR, formatDate, num } from "./calc.js";

/**
 * A phone number as WhatsApp wants it: country code + number, digits only.
 * 10-digit Indian mobile numbers get 91 in front; "+44 7700 900123" and
 * "0044…" keep their own country code. Returns "" when it isn't a usable number.
 */
export function waPhone(raw) {
  const s = String(raw ?? "").trim();
  let d = s.replace(/\D/g, "");
  if (!s.startsWith("+")) {
    if (d.startsWith("00")) d = d.slice(2);                        // 00 = international prefix
    else if (d.length === 11 && d.startsWith("0")) d = d.slice(1); // 0 98765 43210
    if (d.length === 10 && /^[6-9]/.test(d)) d = `91${d}`;         // Indian mobile
  }
  return d.length >= 11 && d.length <= 15 ? d : "";
}

/** "+91 98765 43210" for showing a wa.me number to people. */
export function prettyPhone(wa) {
  if (!wa) return "";
  if (wa.startsWith("91") && wa.length === 12) return `+91 ${wa.slice(2, 7)} ${wa.slice(7)}`;
  return `+${wa}`;
}

/** The WhatsApp message that goes with the bill. */
export function billMessage(b, businessName, apartment) {
  const c = calcBooking(b);
  const first = String(b.guest_name || "").trim().split(/\s+/)[0];
  const paid = num(b.advance_ota) + num(b.paid_cash) + num(b.paid_upi);
  const due = c.grossTotal - paid;
  const lines = [
    `Hello${first && first !== "(no" ? ` ${first}` : ""},`,
    `Thank you for staying with us at ${businessName}.`,
    "",
    `Bill ${b.bill_no || ""} · ${apartment}`.trim(),
    `${formatDate(b.check_in)} to ${formatDate(b.check_out)} · ${c.nights} night${c.nights === 1 ? "" : "s"}`,
    `Total: ${formatINR(c.grossTotal)}`,
  ];
  if (paid > 0) lines.push(`Paid: ${formatINR(paid)}`);
  lines.push(due > 0.5 ? `Balance due: ${formatINR(due)}` : "Paid in full. Thank you!");
  lines.push("", "Your bill is attached as a PDF.");
  return lines.join("\n");
}

export function waLink(phone, text) {
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

/** A file name for the bill PDF: "Bill TSR-26-27-0001.pdf". */
export function billFileName(b) {
  const no = String(b.bill_no || `booking ${b.serial || ""}`).replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "");
  return `Bill ${no}.pdf`;
}

/**
 * A one-page A4 PDF showing a JPEG image, fitted inside 10 mm margins.
 * @param jpeg   Uint8Array of a baseline JPEG file
 * @param width  image width in pixels
 * @param height image height in pixels
 * @returns Uint8Array (the PDF file)
 */
export function jpegToPdf(jpeg, width, height) {
  const PW = 595.28, PH = 841.89, M = 28.35; // A4 in points, 10 mm margin
  const scale = Math.min((PW - 2 * M) / width, (PH - 2 * M) / height);
  const w = +(width * scale).toFixed(2), h = +(height * scale).toFixed(2);
  const x = +((PW - w) / 2).toFixed(2), y = +(PH - M - h).toFixed(2); // top of the page
  const content = `q ${w} 0 0 ${h} ${x} ${y} cm /Im0 Do Q`;
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let length = 0;
  const push = (chunk) => { const bytes = typeof chunk === "string" ? enc.encode(chunk) : chunk; parts.push(bytes); length += bytes.length; };
  const obj = (n, body) => { offsets[n] = length; push(`${n} 0 obj\n`); body(); push("\nendobj\n"); };

  push("%PDF-1.4\n");
  obj(1, () => push("<< /Type /Catalog /Pages 2 0 R >>"));
  obj(2, () => push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"));
  obj(3, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`));
  obj(4, () => {
    push(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
    push(jpeg);
    push("\nendstream");
  });
  obj(5, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  const xref = length;
  push(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => `${String(offsets[n]).padStart(10, "0")} 00000 n \n`).join("")}`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
