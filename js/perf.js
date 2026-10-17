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
  "Unknown": 0, // diary stays with no source written: no commission estimated, and not counted as direct
};
export const UNKNOWN_TYPE = "Unknown";
export const DEFAULT_TARGETS = { occupancy: 65, adr: 0, direct: 40, alos: 2, margin: 30 }; // adr 0 = "use your 12-month average"; margin = profit % of revenue

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
 * part-way gets a pro-rata share of it. opts.foodIncome [{ym, amount}] adds the
 * diaries' kitchen income to extras for history months.
 * Channel, commission, weekend/weekday and length of stay come from the bookings
 * in the app for every month, history months included (the old diaries were
 * imported as bookings with from_diary = true). Diary stays have no extras or
 * payment details, so extras per stay and unpaid balances leave them out.
 * Direct share leaves out stays with no source ("Unknown").
 */
export function computeMetrics(bookings, houses, start, end, opts = {}) {
  const days = daysBetweenIncl(start, end);
  const H = houses.length || 1;
  const hist = opts.history || [];
  const histMonths = new Set(hist.map((h) => h.ym));
  const histRow = new Map(hist.map((h) => [`${h.house_id}|${h.ym}`, h]));
  const food = new Map((opts.foodIncome || []).map((f) => [f.ym, num(f.amount)]));

  const perHouse = Object.fromEntries(houses.map((h) => [h.id, { sold: 0, roomRev: 0, avail: 0 }]));
  let available = 0, appAvailable = 0, histAvailable = 0;
  let sold = 0, roomRev = 0, extrasRev = 0, weekendSold = 0, weekdaySold = 0, commission = 0;
  let weekendDays = 0, weekdayDays = 0; // apartment-nights open on weekends / weekdays

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
        const openShare = num(r.nights_available) / daysBetweenIncl(ms, me); // part-open months count in part
        for (let d = from; d <= to; d = addDays(d, 1)) if (isWeekendNight(d)) weekendDays += openShare; else weekdayDays += openShare;
      }
      extrasRev += (food.get(ym) || 0) * frac;
    } else {
      available += H * nd; appAvailable += H * nd;
      for (const h of houses) perHouse[h.id].avail += nd;
      for (let d = from; d <= to; d = addDays(d, 1)) if (isWeekendNight(d)) weekendDays += H; else weekdayDays += H;
    }
  }

  const channels = {};
  let chRev = 0, unknownRev = 0; // room revenue of every booking counted in channels, and of those with no source
  for (const b of bookings) {
    const nights = Math.max(0, Math.round(num(b.nights)));
    if (!nights || !b.check_in) continue;
    const roomPerNight = num(b.tariff) / nights;
    const extrasPerNight = (num(b.food_bill) + num(b.extra_bed) + num(b.firewood) + num(b.gas)) / nights;
    const rate = commissionFor(b.booking_type, opts.commission) / 100;
    const type = b.booking_type || "Other";
    for (let i = 0; i < nights; i++) {
      const night = addDays(b.check_in, i);
      if (night < start || night > end) continue;
      // History months: nights and revenue come from history; bookings still give the channel mix.
      if (!histMonths.has(night.slice(0, 7))) {
        sold++;
        roomRev += roomPerNight;
        extrasRev += extrasPerNight;
        if (perHouse[b.house_id]) { perHouse[b.house_id].sold++; perHouse[b.house_id].roomRev += roomPerNight; }
      }
      chRev += roomPerNight;
      if (type === UNKNOWN_TYPE) unknownRev += roomPerNight;
      commission += roomPerNight * rate;
      if (isWeekendNight(night)) weekendSold++; else weekdaySold++;
      const ch = (channels[type] ||= { nights: 0, roomRev: 0, commission: 0, rate: rate * 100 });
      ch.nights++; ch.roomRev += roomPerNight; ch.commission += roomPerNight * rate;
    }
  }

  // Per stay (app bookings that check in during the period)
  const stays = bookings.filter((b) => b.check_in >= start && b.check_in <= end && num(b.nights) > 0);
  const stayNights = stays.reduce((s, b) => s + num(b.nights), 0);
  const appStays = stays.filter((b) => !b.from_diary); // diary stays have no extras or payments recorded
  const extras = { food: 0, bed: 0, firewood: 0, gas: 0 };
  for (const b of appStays) { extras.food += num(b.food_bill); extras.bed += num(b.extra_bed); extras.firewood += num(b.firewood); extras.gas += num(b.gas); }
  const n = appStays.length || 1;

  // Money still owed on stays that have already checked out
  const today = opts.today || end;
  const unpaid = appStays
    .filter((b) => b.check_out <= today)
    .map((b) => ({ b, due: r2(num(b.total_balance) - num(b.paid_cash) - num(b.paid_upi)) }))
    .filter((x) => x.due >= 0.5)
    .sort((a, b) => b.due - a.due);

  const directRev = Object.entries(channels).filter(([t, c]) => c.rate === 0 && t !== UNKNOWN_TYPE).reduce((s, [, c]) => s + c.roomRev, 0);
  const knownRev = chRev - unknownRev;

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
    // Channel figures come from bookings (diary + app), so their shares are of booking room revenue.
    appSold: weekendSold + weekdaySold,
    channels: Object.entries(channels).map(([type, c]) => ({ type, ...c, roomRev: r2(c.roomRev), commission: r2(c.commission), share: chRev ? (c.roomRev / chRev) * 100 : 0, unknown: type === UNKNOWN_TYPE }))
      .sort((a, b) => b.roomRev - a.roomRev),
    directShare: knownRev ? (directRev / knownRev) * 100 : 0, // of revenue whose source is known
    unknownShare: chRev ? (unknownRev / chRev) * 100 : 0,
    commission: r2(commission),
    commissionPct: chRev ? (commission / chRev) * 100 : 0,
    netRoomRev: r2(chRev - commission),
    stays: stays.length,
    alos: stays.length ? stayNights / stays.length : 0,
    appStays: appStays.length,
    extrasPerStay: appStays.length ? r2((extras.food + extras.bed + extras.firewood + extras.gas) / n) : 0,
    extrasBreakdown: { food: r2(extras.food / n), bed: r2(extras.bed / n), firewood: r2(extras.firewood / n), gas: r2(extras.gas / n) },
    houses: houseRows,
    weekendOcc: weekendDays ? Math.min(100, (weekendSold / weekendDays) * 100) : 0,
    weekdayOcc: weekdayDays ? Math.min(100, (weekdaySold / weekdayDays) * 100) : 0,
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

/**
 * Profit for nights from `start` to `end`, counting ONLY months that have
 * expenses entered (so months from before you tracked costs don't show as
 * 100% profit). Monthly amounts are pro-rated when the period covers part of
 * a month; daily entries count on the day they were spent.
 * opts.expenses = { cats: [{id, name}], monthly: [{category_id, ym, amount}], daily: [{category_id, spent_on, amount}] }
 */
export function profitMetrics(bookings, houses, start, end, opts = {}) {
  const ex = opts.expenses || { cats: [], monthly: [], daily: [] };
  const name = new Map(ex.cats.map((c) => [c.id, c.name]));
  const monthsWithData = new Set([...ex.monthly.filter((r) => num(r.amount) > 0).map((r) => r.ym), ...ex.daily.map((r) => String(r.spent_on).slice(0, 7))]);
  let revenue = 0, expenses = 0, sold = 0, available = 0, monthsTotal = 0, monthsCovered = 0;
  const byCat = new Map();
  const addCat = (id, v) => { const k = name.get(id) || "Other"; byCat.set(k, (byCat.get(k) || 0) + v); };
  for (let mStart = `${start.slice(0, 7)}-01`; mStart <= end; mStart = addDays(monthRange(mStart.slice(0, 7))[1], 1)) {
    const ym = mStart.slice(0, 7);
    const [ms, me] = monthRange(ym);
    const from = start > ms ? start : ms, to = end < me ? end : me;
    monthsTotal++;
    if (!monthsWithData.has(ym)) continue;
    monthsCovered++;
    const frac = daysBetweenIncl(from, to) / daysBetweenIncl(ms, me);
    const m = computeMetrics(bookings, houses, from, to, opts);
    revenue += m.roomRev + m.extrasRev; sold += m.sold; available += m.available;
    for (const r of ex.monthly) if (r.ym === ym) { const v = num(r.amount) * frac; expenses += v; addCat(r.category_id, v); }
    for (const r of ex.daily) { const d = String(r.spent_on); if (d >= from && d <= to) { const v = num(r.amount); expenses += v; addCat(r.category_id, v); } }
  }
  const profit = revenue - expenses;
  return {
    revenue: r2(revenue), expenses: r2(expenses), profit: r2(profit),
    margin: revenue ? (profit / revenue) * 100 : 0,
    sold, available,
    goppar: available ? r2(profit / available) : 0,   // profit per available apartment-night
    cpor: sold ? r2(expenses / sold) : 0,             // cost per night sold
    monthsTotal, monthsCovered, hasData: monthsCovered > 0,
    byCategory: [...byCat.entries()].map(([k, v]) => ({ name: k, amount: r2(v) })).filter((x) => x.amount > 0).sort((a, b) => b.amount - a.amount),
  };
}

export function monthlyProfitSeries(bookings, houses, endYm, opts = {}, count = 12) {
  return lastMonths(endYm, count).map((ym) => {
    const [s, e0] = monthRange(ym);
    const e = opts.today && e0 > opts.today ? opts.today : e0;
    return { ym, partial: e !== e0, ...profitMetrics(bookings, houses, s, e, opts) };
  });
}
