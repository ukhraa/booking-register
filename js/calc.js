// Booking calculations. These mirror the generated columns in supabase/schema.sql,
// so the form preview always matches what the database stores.

export const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
export const num = (v) => {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : 0;
};

/** Days between two YYYY-MM-DD strings, timezone-safe. */
export function dayNumber(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return NaN;
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

export function nightsBetween(checkIn, checkOut) {
  const a = dayNumber(checkIn);
  const b = dayNumber(checkOut);
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? b - a : 0;
}

/**
 * All derived figures for one booking.
 * Tariff is the room charge for the whole stay, before GST.
 */
export function calcBooking(b) {
  const nights = nightsBetween(b.check_in, b.check_out);
  const tariff = num(b.tariff);
  const gstAmount = r2((tariff * num(b.gst_pct)) / 100);
  const totalTariff = r2(tariff + gstAmount);
  const grossTotal = r2(
    totalTariff + num(b.food_bill) + num(b.extra_bed) + num(b.firewood) + num(b.gas)
  );
  const totalBalance = r2(grossTotal - num(b.advance_ota));
  const collected = r2(num(b.paid_cash) + num(b.paid_upi));
  const difference = r2(collected - totalBalance); // + means over-collected
  const totalBalanced = Math.abs(difference) < 0.5;
  const changeToReturn = r2(num(b.cash_received) - num(b.paid_cash) - num(b.tips));
  return {
    nights,
    gstAmount,
    totalTariff,
    grossTotal,
    totalBalance,
    collected,
    difference,
    totalBalanced,
    changeToReturn,
  };
}

/**
 * Suggested GST % for a room, by per-night tariff (Indian hotel accommodation
 * slabs after the September 2025 rate change). Staff can always override it.
 */
/** Charge for a per-day extra (Extra Bed, Firewood, Gas): rate per day × days. */
export function extraAmount(ratePerDay, days) {
  const d = Math.max(0, Math.floor(num(days)));
  return r2(num(ratePerDay) * d);
}

/** Rate per day of a saved extra; old bookings without days count as 1 day. */
export function extraRate(amount, days) {
  const d = Math.floor(num(days));
  return d > 0 ? r2(num(amount) / d) : r2(num(amount));
}

export function suggestGstPct(tariff, nights) {
  const t = num(tariff);
  if (!t || !nights) return null;
  const perNight = t / nights;
  if (perNight <= 1000) return 0;
  if (perNight <= 7500) return 5;
  return 18;
}

/** GST on accommodation is always intra-state (place of supply is the property), so split it equally into CGST and SGST. */
export function splitGst(gstAmount) {
  const cgst = r2(num(gstAmount) / 2);
  return { cgst, sgst: r2(num(gstAmount) - cgst) };
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
const below100 = (n) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : ""));
const join = (a, b) => (b ? `${a} ${b}` : a);
function intWords(n) {
  if (n >= 1e7) return join(`${intWords(Math.floor(n / 1e7))} Crore`, intWords(n % 1e7));
  if (n >= 1e5) return join(`${below100(Math.floor(n / 1e5))} Lakh`, intWords(n % 1e5));
  if (n >= 1000) return join(`${below100(Math.floor(n / 1000))} Thousand`, intWords(n % 1000));
  if (n >= 100) return join(`${ONES[Math.floor(n / 100)]} Hundred`, below100(n % 100));
  return below100(n);
}

/** 3148.95 -> "Rupees Three Thousand One Hundred Forty-Eight and Ninety-Five Paise Only" (Indian lakh/crore system). */
export function amountInWords(amount) {
  const paiseTotal = Math.round(Math.abs(r2(amount)) * 100);
  const rupees = Math.floor(paiseTotal / 100);
  const paise = paiseTotal % 100;
  return `Rupees ${intWords(rupees) || "Zero"}${paise ? ` and ${below100(paise)} Paise` : ""} Only`;
}

/** True when [aIn, aOut) and [bIn, bOut) share at least one night. */
export function staysOverlap(aIn, aOut, bIn, bOut) {
  return dayNumber(aIn) < dayNumber(bOut) && dayNumber(aOut) > dayNumber(bIn);
}

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
export const formatINR = (n) => inr.format(r2(n));

/** YYYY-MM-DD -> DD-MM-YYYY */
export const formatDate = (s) => (s ? s.split("-").reverse().join("-") : "");

/** Today's date as YYYY-MM-DD in the device's own timezone. */
export function todayISO(d = new Date()) {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

/** First and last day of a YYYY-MM month. */
export function monthRange(ym) {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${ym}-01`, `${ym}-${String(last).padStart(2, "0")}`];
}

/** Indian financial year (1 April – 31 March) containing a YYYY-MM-DD date. */
export function financialYear(iso) {
  const [y, m] = iso.split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  return { start: `${start}-04-01`, end: `${start + 1}-03-31`, label: `FY ${start}-${String(start + 1).slice(2)}` };
}

/** The four reporting periods for a given day, by check-in date. */
export function reportPeriods(today) {
  const fy = financialYear(today);
  const [mStart, mEnd] = monthRange(today.slice(0, 7));
  return [
    { key: "day", start: today, end: today },
    { key: "month", start: mStart, end: mEnd },
    { key: "year", start: fy.start, end: fy.end, label: fy.label },
    { key: "ytd", start: fy.start, end: today },
  ];
}

export const TOTAL_FIELDS = ["bookings", "nights", "gross", "gst", "advance", "afterOta", "cash", "upi"];

/** Totals of saved bookings whose check-in falls in [start, end]. */
export function periodTotals(bookings, start, end) {
  const t = Object.fromEntries(TOTAL_FIELDS.map((k) => [k, 0]));
  for (const b of bookings) {
    if (!b.check_in || b.check_in < start || b.check_in > end) continue;
    t.bookings += 1;
    t.nights += num(b.nights);
    t.gross += num(b.gross_total);
    t.gst += num(b.gst_amount);
    t.advance += num(b.advance_ota);
    t.cash += num(b.paid_cash);
    t.upi += num(b.paid_upi);
  }
  t.afterOta = t.gross - t.advance;
  for (const k of TOTAL_FIELDS) t[k] = r2(t[k]);
  return t;
}

/** YYYY-MM-DD plus n days. */
export function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Availability grid for one month: for each day, which booking (if any) has
 * each apartment on that night. A stay occupies check-in up to, not including,
 * check-out. More than one stay on a night is a double booking.
 * Returns [{ date, cells: { [houseId]: { stays, first } } }] where `first` is
 * true on the first night shown for that stay (its check-in, or the 1st of the month).
 */
export function availabilityGrid(ym, houseIds, stays) {
  const [start, end] = monthRange(ym);
  const days = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return days.map((date) => {
    const cells = {};
    for (const id of houseIds) {
      const here = stays.filter((s) => s.house_id === id && s.check_in <= date && s.check_out > date);
      cells[id] = { stays: here, first: here.some((s) => s.check_in === date || date === start) };
    }
    return { date, cells };
  });
}

/** Booked nights per apartment in a grid, for the occupancy row. */
export function occupancy(grid, houseIds) {
  const out = {};
  for (const id of houseIds) {
    const nights = grid.filter((r) => r.cells[id].stays.length > 0).length;
    out[id] = { nights, pct: grid.length ? Math.round((nights / grid.length) * 100) : 0 };
  }
  return out;
}

export const CSV_HEADERS = [
  "Serial No.", "House Name", "Booking Type", "Guest Name", "Check-in Date",
  "Check-out Date", "No. of Nights", "Tariff", "GST %", "GST Amount", "Total Tariff",
  "Bill No.", "Food Bill", "Extra Bed", "Firewood", "Gas", "Gross Total",
  "Advance/Paid to OTA", "Total Balance", "Paid by Cash", "Cash Received", "Tips",
  "Paid by UPI", "Total Balanced?", "UPI/Cash Amount - Notes",
];

export function toCSV(bookings, houseName) {
  const q = (v) => {
    const s = String(v ?? "");
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = bookings.map((b) => {
    const c = calcBooking(b);
    return [
      b.serial, houseName(b.house_id), b.booking_type, b.guest_name,
      formatDate(b.check_in), formatDate(b.check_out), c.nights, num(b.tariff),
      num(b.gst_pct), c.gstAmount, c.totalTariff, b.bill_no, num(b.food_bill),
      num(b.extra_bed), num(b.firewood), num(b.gas), c.grossTotal, num(b.advance_ota),
      c.totalBalance, num(b.paid_cash), num(b.cash_received), num(b.tips),
      num(b.paid_upi), c.totalBalanced ? "Yes" : "No", b.notes,
    ].map(q).join(",");
  });
  // BOM so Excel opens ₹ and Indian names correctly
  return "﻿" + [CSV_HEADERS.join(","), ...rows].join("\r\n");
}
