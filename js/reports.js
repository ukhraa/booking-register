// Monthly reports (pure, tested in tests/reports.test.mjs):
//  • GST report for the accountant: bills by invoice date (check-out), GST by rate.
//  • Guest register: who stayed, with ID details, for police / Form C records.
import { calcBooking, splitGst, formatDate, num, monthRange } from "./calc.js";
import { foodTotals } from "./food.js";

const r2 = (n) => Math.round(n * 100) / 100;
const csvCell = (v) => { const s = String(v ?? ""); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csvRow = (cells) => cells.map(csvCell).join(",");

/**
 * GST report for one month. A bill belongs to the month of its check-out date
 * (the invoice date). Stays copied from the old diaries are left out.
 * GST in the app is charged on the room tariff; food and extras have no GST line.
 */
export function gstReport(bookings, ym, today = null, foodBills = []) {
  const [start, end] = monthRange(ym);
  // Stays that haven't checked out yet have no bill yet: counted separately, not in the totals.
  const notYet = bookings.filter((b) => !b.from_diary && today && b.check_out > today && b.check_out >= start && b.check_out <= end);
  const inMonth = bookings.filter((b) => !b.from_diary && b.check_out >= start && b.check_out <= end && !notYet.includes(b))
    .sort((a, b) => (a.check_out + (a.bill_no || "")).localeCompare(b.check_out + (b.bill_no || "")));
  const byRate = new Map();
  const lines = inMonth.map((b) => {
    const c = calcBooking(b);
    const { cgst, sgst } = splitGst(c.gstAmount);
    const rate = num(b.gst_pct);
    const other = r2(c.grossTotal - c.totalTariff); // food + extras
    const line = { id: b.id, bill_no: b.bill_no || "", date: b.check_out, guest: b.guest_name, house_id: b.house_id,
      booking_type: b.booking_type, nights: c.nights, rate, taxable: num(b.tariff), cgst, sgst, gst: c.gstAmount, other, total: c.grossTotal,
      gstin: cleanGstin(b.guest_gstin), company: String(b.guest_company || "").trim() };
    const g = byRate.get(rate) || { rate, bills: 0, taxable: 0, cgst: 0, sgst: 0, gst: 0, other: 0, total: 0 };
    g.bills++; g.taxable += line.taxable; g.cgst += cgst; g.sgst += sgst; g.gst += c.gstAmount; g.other += other; g.total += c.grossTotal;
    byRate.set(rate, g);
    return line;
  });
  // Food bills: their own invoices, by bill date. GST (when set) is included in their prices.
  for (const f of foodBills.filter((x) => x.bill_date >= start && x.bill_date <= end)) {
    const t = foodTotals(f.items, f.gst_pct);
    const line = { id: f.id, food: true, bill_no: f.bill_no || "", date: f.bill_date, guest: f.guest_name || "", house_id: f.house_id,
      booking_type: "Food bill", nights: 0, rate: t.gstPct, taxable: t.taxable, cgst: t.cgst, sgst: t.sgst, gst: t.gst, other: 0, total: t.total,
      gstin: cleanGstin(f.guest_gstin), company: String(f.guest_company || "").trim() };
    lines.push(line);
    const g = byRate.get(line.rate) || { rate: line.rate, bills: 0, taxable: 0, cgst: 0, sgst: 0, gst: 0, other: 0, total: 0 };
    g.bills++; g.taxable += line.taxable; g.cgst += line.cgst; g.sgst += line.sgst; g.gst += line.gst; g.total += line.total;
    byRate.set(line.rate, g);
  }
  lines.sort((a, b) => (a.date + a.bill_no).localeCompare(b.date + b.bill_no));
  const rates = [...byRate.values()].sort((a, b) => a.rate - b.rate)
    .map((g) => ({ ...g, taxable: r2(g.taxable), cgst: r2(g.cgst), sgst: r2(g.sgst), gst: r2(g.gst), other: r2(g.other), total: r2(g.total) }));
  const sum = (k) => r2(rates.reduce((s, g) => s + g[k], 0));
  const part = (ls) => ({ bills: ls.length, taxable: r2(ls.reduce((s, l) => s + l.taxable, 0)), gst: r2(ls.reduce((s, l) => s + l.gst, 0)), total: r2(ls.reduce((s, l) => s + l.total, 0)) });
  const b2b = lines.filter((l) => l.gstin);
  return {
    ym, start, end, lines, rates,
    totals: { bills: lines.length, taxable: sum("taxable"), cgst: sum("cgst"), sgst: sum("sgst"), gst: sum("gst"), other: sum("other"), total: sum("total") },
    missingBillNo: lines.filter((l) => !l.bill_no),
    b2b, b2bTotals: part(b2b), b2cTotals: part(lines.filter((l) => !l.gstin)),
    notCheckedOut: notYet.length,
  };
}

export function gstCSV(rep, houseName, business = {}) {
  const out = [
    csvRow([`GST report ${rep.ym}`, business.trade_name || business.legal_name || "", business.gstin ? `GSTIN ${business.gstin}` : ""]),
    "",
    csvRow(["Summary by GST rate"]),
    csvRow(["GST rate %", "Bills", "Taxable value", "CGST", "SGST", "Total GST", "Food & extras on room bills (no GST)", "Invoice value"]),
    ...rep.rates.map((g) => csvRow([g.rate, g.bills, g.taxable, g.cgst, g.sgst, g.gst, g.other, g.total])),
    csvRow(["Total", rep.totals.bills, rep.totals.taxable, rep.totals.cgst, rep.totals.sgst, rep.totals.gst, rep.totals.other, rep.totals.total]),
    "",
    csvRow(["B2B (guest has a GSTIN)", rep.b2bTotals.bills, "bills", "taxable", rep.b2bTotals.taxable, "GST", rep.b2bTotals.gst]),
    csvRow(["B2C (no GSTIN)", rep.b2cTotals.bills, "bills", "taxable", rep.b2cTotals.taxable, "GST", rep.b2cTotals.gst]),
    "",
    csvRow(["Bills"]),
    csvRow(["Bill no.", "Date", "Guest", "Company", "Guest GSTIN", "Apartment", "Booking type", "Nights", "GST rate %", "Taxable value", "CGST", "SGST", "Food & extras", "Invoice value"]),
    ...rep.lines.map((l) => csvRow([l.bill_no || "(no bill no.)", formatDate(l.date), l.guest, l.company, l.gstin, houseName(l.house_id), l.booking_type, l.nights, l.rate, l.taxable, l.cgst, l.sgst, l.other, l.total])),
  ];
  return out.join("\r\n");
}

export const ID_TYPES = ["Aadhaar", "Passport", "Driving licence", "Voter ID", "Other"];

/** Indian guests: nationality left empty or "India(n)". */
export const isForeign = (b) => !!b.nationality && !/^india(n)?$/i.test(b.nationality.trim());

/** Guests staying at any time in the month (check-in on or before month end, check-out after month start). */
export function guestRegister(bookings, ym) {
  const [start, end] = monthRange(ym);
  return bookings
    .filter((b) => b.check_in <= end && b.check_out > start)
    .sort((a, b) => (a.check_in + a.house_id).localeCompare(b.check_in + b.house_id))
    .map((b) => ({
      id: b.id, check_in: b.check_in, check_out: b.check_out, house_id: b.house_id, guest: b.guest_name,
      phone: b.guest_phone || "", address: b.guest_address || "", adults: num(b.adults), children: num(b.children),
      nationality: b.nationality || "Indian", foreign: isForeign(b),
      id_type: b.id_type || "", id_number: b.id_number || "",
      visa_no: b.visa_no || "", visa_expiry: b.visa_expiry || "", arrived_india: b.arrived_india || "",
      missing: [!b.id_number && "ID", !b.guest_address && "address", !(num(b.adults) + num(b.children)) && "guests",
                isForeign(b) && !b.visa_no && "visa"].filter(Boolean),
      from_diary: !!b.from_diary,
    }));
}

export function guestRegisterCSV(rows, houseName) {
  return [
    csvRow(["Check-in", "Check-out", "Apartment", "Guest", "Phone", "Address", "Adults", "Children", "Nationality", "ID type", "ID number", "Visa no.", "Visa valid until", "Arrived in India"]),
    ...rows.map((r) => csvRow([formatDate(r.check_in), formatDate(r.check_out), houseName(r.house_id), r.guest, r.phone, r.address,
      r.adults, r.children, r.nationality, r.id_type, r.id_number, r.visa_no, r.visa_expiry ? formatDate(r.visa_expiry) : "", r.arrived_india ? formatDate(r.arrived_india) : ""])),
  ].join("\r\n");
}

/**
 * Past stays of the same guest, for the "returning guest" hint on the booking form.
 * Matches on the phone number's last 10 digits, or on the full name (case and spacing ignored).
 */
export function pastStays(bookings, { phone = "", name = "", excludeId = null, before = null } = {}) {
  const ph = String(phone).replace(/\D/g, "").slice(-10);
  const nm = String(name).trim().toLowerCase().replace(/\s+/g, " ");
  if (ph.length < 10 && nm.length < 4) return [];
  return bookings
    .filter((b) => b.id !== excludeId && (!before || b.check_in < before))
    .filter((b) => (ph.length === 10 && String(b.guest_phone || "").replace(/\D/g, "").slice(-10) === ph)
      || (nm.length >= 4 && String(b.guest_name || "").trim().toLowerCase().replace(/\s+/g, " ") === nm))
    .sort((a, b) => b.check_in.localeCompare(a.check_in));
}

/**
 * Check a GSTIN: 2-digit state code, PAN, entity number, "Z", check character.
 * Returns "" when it's fine, or a short reason. Spaces are ignored; letters may be lower case.
 */
export function gstinProblem(raw) {
  const g = String(raw ?? "").replace(/\s+/g, "").toUpperCase();
  if (!g) return "";
  if (g.length !== 15) return "A GSTIN has 15 characters.";
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return "That doesn't look like a GSTIN (e.g. 33ABCDE1234F1Z5).";
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = chars.indexOf(g[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(p / 36) + (p % 36);
  }
  if (chars[(36 - (sum % 36)) % 36] !== g[14]) return "That GSTIN has a typo (its last character doesn't match). Check it with the guest.";
  return "";
}
export const cleanGstin = (raw) => String(raw ?? "").replace(/\s+/g, "").toUpperCase();
