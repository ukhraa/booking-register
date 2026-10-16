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
 * @param opts      { commission: settings map, today: YYYY-MM-DD,
 *                    history: [{house_id, ym, nights_booked, nights_available, room_revenue}] }
 *
 * History (monthly figures from before the app) takes over whole months: for a
 * month that has any history rows, nights, availability and room revenue come
 * from history (an apartment with no row that month counts as not open), and
 * app bookings on those nights are ignored. A period that cuts a history month
 * part-way gets a pro-rata share of it. Channel, commission, weekend/weekday,
 * extras and per-stay figures exist only for app bookings.
 */
export function computeMetrics(bookings, houses, start, end, opts = {}) {
  const days = daysBetweenIncl(start, end);
  const H = houses.length || 1;
  const hist = opts.history || [];
  const histMonths = new Set(hist.map((h) => h.ym));
  const histRow = new Map(hist.map((h) => [`${h.house_id}|${h.ym}`, h]));

  const perHouse = Object.fromEntries(houses.map((h) => [h.id, { sold: 0, roomRev: 0, avail: 0 }]));
  let available = 0, appAvailable = 0, histAvailable = 0;
  let sold = 0, roomRev = 0, appRoomRev = 0, extrasRev = 0, weekendSold = 0, weekdaySold = 0, commission = 0;
  let weekendDays = 0, weekdayDays = 0;

  // Walk the period month by month.
  for (let mStart = `${start.slice(0, 7)}-01`; mStart <= end; mStart = addDays(monthRange(mStart.slice(0, 7))[1], 1)) {
    const ym = mStart.slice(0, 7);
    const [ms, me] = monthRange(ym);
    const from = start > ms ? start : ms, to = end < me ? end : me;
    const nd = daysBetweenIncl(from, to);
    if (histMonths.has(ym)) {
      const frac = nd / daysBetweenIncl(ms, me);
      for (const h of houses) {
        const r = histRow.get(`${h.id}|${ym}`);
        if (!r) continue; // not open that month
        const a = num(r.nights_available) * frac, b = num(r.nights_booked) * frac, rv = num(r.room_revenue) * frac;
        available += a; histAvailable += a; sold += b; roomRev += rv;
        perHouse[h.id].avail += a; perHouse[h.id].sold += b; perHouse[h.id].roomRev += rv;
      }
    } else {
      available += H * nd; appAvailable += H * nd;
      for (const h of houses) perHouse[h.id].avail += nd;
      for (let d = from; d <= to; d = addDays(d, 1)) if (isWeekendNight(d)) weekendDays++; else weekdayDays++;
    }
  }

  const channels = {};
  for (const b of bookings) {
    const nights = Math.max(0, Math.round(num(b.nights)));
    if (!nights || !b.check_in) continue;
    const roomPerNight = num(b.tariff) / nights;
    const extrasPerNight = (num(b.food_bill) + num(b.extra_bed) + num(b.firewood) + num(b.gas)) / nights;
    const rate = commissionFor(b.booking_type, opts.commission) / 100;
    for (let i = 0; i < nights; i++) {
      const night = addDays(b.check_in, i);
      if (night < start || night > end || histMonths.has(night.slice(0, 7))) continue;
      sold++;
      roomRev += roomPerNight;
      appRoomRev += roomPerNight;
      extrasRev += extrasPerNight;
      commission += roomPerNight * rate;
      if (isWeekendNight(night)) weekendSold++; else weekdaySold++;
      if (perHouse[b.house_id]) { perHouse[b.house_id].sold++; perHouse[b.house_id].roomRev += roomPerNight; }
      const ch = (channels[b.booking_type || "Other"] ||= { nights: 0, roomRev: 0, commission: 0, rate: rate * 100 });
      ch.nights++; ch.roomRev += roomPerNight; ch.commission += roomPerNight * rate;
    }
  }

  // Per stay (app bookings that check in during the period)
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
    return {
      id: h.id, name: h.name, sold: Math.round(p.sold), avail: Math.round(p.avail), closed: p.avail === 0,
      occ: p.avail ? (p.sold / p.avail) * 100 : 0, adr: p.sold ? p.roomRev / p.sold : 0, revpar: p.avail ? p.roomRev / p.avail : 0,
    };
  });

  return {
    start, end, days, available: Math.round(available), sold: Math.round(sold),
    historyShare: available ? histAvailable / available : 0, // 0 = all from app bookings, 1 = all from history
    appAvailable,
    occupancy: available ? (sold / available) * 100 : 0,
    roomRev: r2(roomRev), extrasRev: r2(extrasRev), totalRev: r2(roomRev + extrasRev),
    adr: sold ? r2(roomRev / sold) : 0,
    revpar: available ? r2(roomRev / available) : 0,
    trevpar: available ? r2((roomRev + extrasRev) / available) : 0,
    extrasShare: roomRev + extrasRev ? (extrasRev / (roomRev + extrasRev)) * 100 : 0,
    // Channel figures only exist for app bookings, so their shares are of app room revenue.
    appSold: weekendSold + weekdaySold,
    channels: Object.entries(channels).map(([type, c]) => ({ type, ...c, roomRev: r2(c.roomRev), commission: r2(c.commission), share: appRoomRev ? (c.roomRev / appRoomRev) * 100 : 0 }))
      .sort((a, b) => b.roomRev - a.roomRev),
    directShare: appRoomRev ? (directRev / appRoomRev) * 100 : 0,
    commission: r2(commission),
    commissionPct: appRoomRev ? (commission / appRoomRev) * 100 : 0,
    netRoomRev: r2(appRoomRev - commission),
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

/** One row per calendar year: occupancy, ADR, RevPAR. The current year runs to `today`. */
export function yearlySeries(bookings, houses, firstYear, today, opts = {}) {
  const out = [];
  for (let y = firstYear; y <= Number(today.slice(0, 4)); y++) {
    const end = y === Number(today.slice(0, 4)) ? today : `${y}-12-31`;
    out.push({ year: y, partial: end !== `${y}-12-31`, ...computeMetrics(bookings, houses, `${y}-01-01`, end, opts) });
  }
  return out;
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
    const [s, e0] = monthRange(ym);
    const e = opts.today && e0 > opts.today ? opts.today : e0; // the current month counts up to today
    return { ym, partial: e !== e0, ...computeMetrics(bookings, houses, s, e, opts) };
  });
}

/**
 * Period choices for the Performance tab, with the period each is compared with.
 * Periods never run past today ("so far"), and are compared with the same span
 * of days in the comparison period, so a half-finished month or year is fair.
 */
export function perfPeriod(key, today) {
  const ym = today.slice(0, 7);
  const [y, m, d] = today.split("-").map(Number);
  const iso = (yy, mm, dd) => new Date(Date.UTC(yy, mm - 1, dd)).toISOString().slice(0, 10);
  const monthStart = (yy, mm) => iso(yy, mm, 1);
  const monthEnd = (yy, mm) => iso(yy, mm + 1, 0);
  // Same day of another month, clamped to that month's length (31 Mar → 28 Feb)
  const sameDay = (yy, mm) => { const e = monthEnd(yy, mm); return Number(e.slice(8)) < d ? e : iso(yy, mm, d); };
  const lastYear = (s) => { const [a, b, c] = s.split("-").map(Number); const e = iso(a - 1, b + 1, 0); return Number(e.slice(8)) < c ? e : iso(a - 1, b, c); };
  const fyStartYear = m >= 4 ? y : y - 1;
  switch (key) {
    case "last_month":
      return { key, label: "Last month", start: monthStart(y, m - 1), end: monthEnd(y, m - 1), prev: { start: monthStart(y, m - 2), end: monthEnd(y, m - 2), label: "the month before" } };
    case "last_3":
      return { key, label: "Last 3 months", start: monthStart(y, m - 3), end: monthEnd(y, m - 1), prev: { start: monthStart(y, m - 6), end: monthEnd(y, m - 4), label: "the 3 months before" } };
    case "ytd": {
      const s = `${y}-01-01`;
      return { key, label: "Year to date", start: s, end: today, prev: { start: lastYear(s), end: lastYear(today), label: "same dates last year" } };
    }
    case "fy": {
      const s = `${fyStartYear}-04-01`;
      return { key, label: `FY ${fyStartYear}-${String(fyStartYear + 1).slice(2)} so far`, start: s, end: today, prev: { start: lastYear(s), end: lastYear(today), label: "same dates last FY" } };
    }
    case "last_12": {
      const s = monthStart(y, m - 11);
      return { key, label: "Last 12 months", start: s, end: today, prev: { start: lastYear(s), end: lastYear(today), label: "the 12 months before" } };
    }
    default:
      return { key: "month", label: "This month so far", start: monthStart(y, m), end: today, prev: { start: monthStart(y, m - 1), end: sameDay(y, m - 1), label: "same days last month" } };
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
