// Performance metrics for the Performance tab. Pure functions: bookings in, numbers out.
//
// Conventions (hotel industry standard):
//  - Nights are counted on the night they are stayed, not by check-in date.
//  - Room revenue = tariff before GST, spread evenly over the stay's nights.
//  - Extras = food, extra bed, firewood and gas, also spread over the nights.
//  - "Available" = apartments × nights in the period.
//  - Weekend nights are Friday and Saturday nights.
import { num, r2, addDays, monthRange } from "./calc.js";

/** Estimated OTA commission % by booking type (owner can change these in Settings). */
export const DEFAULT_COMMISSION = {
  "Direct": 0, "Walk-in": 0, "Phone / WhatsApp": 0,
  "Airbnb": 15, "Booking.com": 18, "MakeMyTrip": 20, "Goibibo": 20, "Agoda": 18, "Other OTA": 18,
};
export const DEFAULT_TARGETS = { occupancy: 65, adr: 0, direct: 40, alos: 2 }; // adr 0 = "use your 12-month average"

export const commissionKey = (type) => `commission_${String(type).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
export function commissionFor(type, rates) {
  const k = commissionKey(type);
  if (rates && k in rates) return num(rates[k]);
  return type in DEFAULT_COMMISSION ? DEFAULT_COMMISSION[type] : 15;
}

const daysBetweenIncl = (start, end) => {
  let n = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) n++;
  return n;
};
const isWeekendNight = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 5 || dow === 6; // Friday, Saturday nights
};

/**
 * All metrics for nights from `start` to `end` (inclusive, YYYY-MM-DD).
 * @param bookings  saved booking rows
 * @param houses    [{id, name}]
 * @param opts      { commission: settings map, today: YYYY-MM-DD }
 */
export function computeMetrics(bookings, houses, start, end, opts = {}) {
  const days = daysBetweenIncl(start, end);
  const H = houses.length || 1;
  const available = H * days;
  let weekendDays = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) if (isWeekendNight(d)) weekendDays++;
  const weekdayDays = days - weekendDays;

  const perHouse = Object.fromEntries(houses.map((h) => [h.id, { sold: 0, roomRev: 0 }]));
  const channels = {};
  let sold = 0, roomRev = 0, extrasRev = 0, weekendSold = 0, weekdaySold = 0, commission = 0;

  for (const b of bookings) {
    const nights = Math.max(0, Math.round(num(b.nights)));
    if (!nights || !b.check_in) continue;
    const roomPerNight = num(b.tariff) / nights;
    const extrasPerNight = (num(b.food_bill) + num(b.extra_bed) + num(b.firewood) + num(b.gas)) / nights;
    const rate = commissionFor(b.booking_type, opts.commission) / 100;
    for (let i = 0; i < nights; i++) {
      const night = addDays(b.check_in, i);
      if (night < start || night > end) continue;
      sold++;
      roomRev += roomPerNight;
      extrasRev += extrasPerNight;
      commission += roomPerNight * rate;
      if (isWeekendNight(night)) weekendSold++; else weekdaySold++;
      if (perHouse[b.house_id]) { perHouse[b.house_id].sold++; perHouse[b.house_id].roomRev += roomPerNight; }
      const ch = (channels[b.booking_type || "Other"] ||= { nights: 0, roomRev: 0, commission: 0, rate: rate * 100 });
      ch.nights++; ch.roomRev += roomPerNight; ch.commission += roomPerNight * rate;
    }
  }

  // Per stay (bookings that check in during the period)
  const stays = bookings.filter((b) => b.check_in >= start && b.check_in <= end && num(b.nights) > 0);
  const stayNights = stays.reduce((s, b) => s + num(b.nights), 0);
  const extras = { food: 0, bed: 0, firewood: 0, gas: 0 };
  for (const b of stays) { extras.food += num(b.food_bill); extras.bed += num(b.extra_bed); extras.firewood += num(b.firewood); extras.gas += num(b.gas); }
  const n = stays.length || 1;

  // Money still owed on stays that have already checked out
  const today = opts.today || end;
  const unpaid = stays
    .filter((b) => b.check_out <= today)
    .map((b) => ({ b, due: r2(num(b.total_balance) - num(b.paid_cash) - num(b.paid_upi)) }))
    .filter((x) => x.due >= 0.5)
    .sort((a, b) => b.due - a.due);

  const directRev = Object.values(channels).filter((c) => c.rate === 0).reduce((s, c) => s + c.roomRev, 0);

  const houseRows = houses.map((h) => {
    const p = perHouse[h.id];
    return { id: h.id, name: h.name, sold: p.sold, occ: days ? (p.sold / days) * 100 : 0, adr: p.sold ? p.roomRev / p.sold : 0, revpar: days ? p.roomRev / days : 0 };
  });

  return {
    start, end, days, available, sold,
    occupancy: available ? (sold / available) * 100 : 0,
    roomRev: r2(roomRev), extrasRev: r2(extrasRev), totalRev: r2(roomRev + extrasRev),
    adr: sold ? r2(roomRev / sold) : 0,
    revpar: available ? r2(roomRev / available) : 0,
    trevpar: available ? r2((roomRev + extrasRev) / available) : 0,
    extrasShare: roomRev + extrasRev ? (extrasRev / (roomRev + extrasRev)) * 100 : 0,
    channels: Object.entries(channels).map(([type, c]) => ({ type, ...c, roomRev: r2(c.roomRev), commission: r2(c.commission), share: roomRev ? (c.roomRev / roomRev) * 100 : 0 }))
      .sort((a, b) => b.roomRev - a.roomRev),
    directShare: roomRev ? (directRev / roomRev) * 100 : 0,
    commission: r2(commission),
    commissionPct: roomRev ? (commission / roomRev) * 100 : 0,
    netRoomRev: r2(roomRev - commission),
    stays: stays.length,
    alos: stays.length ? stayNights / stays.length : 0,
    extrasPerStay: stays.length ? r2((extras.food + extras.bed + extras.firewood + extras.gas) / n) : 0,
    extrasBreakdown: { food: r2(extras.food / n), bed: r2(extras.bed / n), firewood: r2(extras.firewood / n), gas: r2(extras.gas / n) },
    houses: houseRows,
    weekendOcc: weekendDays ? (weekendSold / (H * weekendDays)) * 100 : 0,
    weekdayOcc: weekdayDays ? (weekdaySold / (H * weekdayDays)) * 100 : 0,
    unpaid, unpaidTotal: r2(unpaid.reduce((s, x) => s + x.due, 0)),
  };
}

/** The 12 calendar months ending with `ym` (YYYY-MM), oldest first. */
export function lastMonths(ym, count = 12) {
  const [y, m] = ym.split("-").map(Number);
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

export function monthlySeries(bookings, houses, endYm, opts = {}, count = 12) {
  return lastMonths(endYm, count).map((ym) => {
    const [s, e] = monthRange(ym);
    return { ym, ...computeMetrics(bookings, houses, s, e, opts) };
  });
}

/** Period choices for the Performance tab, with the period each is compared with. */
export function perfPeriod(key, today) {
  const ym = today.slice(0, 7);
  const [y, m] = ym.split("-").map(Number);
  const monthStart = (yy, mm) => { const d = new Date(Date.UTC(yy, mm - 1, 1)); return d.toISOString().slice(0, 10); };
  const monthEnd = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);
  const lastYear = (iso) => `${Number(iso.slice(0, 4)) - 1}${iso.slice(4)}`.replace("-02-29", "-02-28");
  const fyStartYear = m >= 4 ? y : y - 1;
  switch (key) {
    case "last_month": {
      const s = monthStart(y, m - 1), e = monthEnd(y, m - 1);
      return { key, label: "Last month", start: s, end: e, prev: { start: monthStart(y, m - 2), end: monthEnd(y, m - 2), label: "the month before" } };
    }
    case "last_3": {
      const s = monthStart(y, m - 3), e = monthEnd(y, m - 1);
      return { key, label: "Last 3 months", start: s, end: e, prev: { start: monthStart(y, m - 6), end: monthEnd(y, m - 4), label: "the 3 months before" } };
    }
    case "ytd": {
      const s = `${y}-01-01`;
      return { key, label: "Year to date", start: s, end: today, prev: { start: lastYear(s), end: lastYear(today), label: "same dates last year" } };
    }
    case "fy": {
      const s = `${fyStartYear}-04-01`, e = `${fyStartYear + 1}-03-31`;
      return { key, label: `FY ${fyStartYear}-${String(fyStartYear + 1).slice(2)}`, start: s, end: e, prev: { start: lastYear(s), end: lastYear(e), label: "last FY" } };
    }
    case "last_12": {
      const s = monthStart(y, m - 11), e = monthEnd(y, m);
      return { key, label: "Last 12 months", start: s, end: e, prev: { start: lastYear(s), end: lastYear(e), label: "the 12 months before" } };
    }
    default: {
      const s = monthStart(y, m), e = monthEnd(y, m);
      return { key: "month", label: "This month", start: s, end: e, prev: { start: monthStart(y, m - 1), end: monthEnd(y, m - 1), label: "last month" } };
    }
  }
}

/** good | warn | bad | none, against a target. `higherIsBetter` false flips it. */
export function rate(value, target, warnBand, higherIsBetter = true) {
  if (value == null || !Number.isFinite(value) || !target) return "none";
  const diff = higherIsBetter ? value - target : target - value;
  if (diff >= 0) return "good";
  if (diff >= -warnBand) return "warn";
  return "bad";
}
