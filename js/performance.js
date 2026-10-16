// Performance tab: metric cards and the detail view for each metric.
// Numbers come from perf.js; drawing from charts.js. Copy is kept short on purpose.
import { formatINR, formatDate, r2 } from "./calc.js";
import { rate } from "./perf.js";
import { columns, line, hbars, spark } from "./charts.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (v) => `${Math.round(v)}%`;
const monthLabel = (ym) => new Date(`${ym}-01T00:00:00`).toLocaleDateString("en-IN", { month: "short" });
const monthLong = (ym) => new Date(`${ym}-01T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });

const STATUS_TEXT = { good: "On target", warn: "Close", bad: "Needs work", none: "No data yet", info: "For reference" };
const STATUS_ICON = { good: "✓", warn: "!", bad: "↓", none: "–", info: "i" };
export const statusPill = (s) => `<span class="st st-${s}"><b aria-hidden="true">${STATUS_ICON[s]}</b>${STATUS_TEXT[s]}</span>`;

/** Signed change vs the comparison period. kind: "pts" | "money" | "num". */
function delta(cur, prev, kind, upIsGood = true, prevLabel = "") {
  if (prev == null || !Number.isFinite(prev) || (kind !== "pts" && !prev)) return "";
  let d, txt;
  if (kind === "pts") { d = cur - prev; txt = `${Math.abs(Math.round(d))} pts`; }
  else if (kind === "num") { d = cur - prev; txt = Math.abs(d).toFixed(1); }
  else { d = ((cur - prev) / prev) * 100; txt = `${Math.abs(Math.round(d))}%`; }
  if (Math.abs(d) < 0.5 && kind !== "num") return `<span class="dl flat">no change vs ${esc(prevLabel)}</span>`;
  if (kind === "num" && Math.abs(d) < 0.05) return `<span class="dl flat">no change vs ${esc(prevLabel)}</span>`;
  const good = d > 0 === upIsGood;
  return `<span class="dl ${good ? "up" : "down"}"><b aria-hidden="true">${d > 0 ? "▲" : "▼"}</b>${txt} <span class="dl-vs">vs ${esc(prevLabel)}</span></span>`;
}

/**
 * Build every metric for the current view.
 * ctx: { cur, prev, series, period, targets, houses, houseColour }
 */
export function buildMetrics(ctx) {
  const { cur, prev, series, years = [], period, targets, houses, houseColour } = ctx;
  // Figures the spreadsheet history doesn't have: only from bookings entered in the app.
  const histUsed = cur.historyShare > 0;
  const appNote = histUsed ? (cur.appSold || cur.stays ? "From bookings entered in the app only" : "Starts once bookings are entered in the app") : null;
  const yearCols = (key, fmt, opts = {}) => years.length > 1 ? columns(years.map((y, i) => ({
    label: y.partial ? `${y.year}*` : String(y.year), value: y[key], current: i === years.length - 1,
    valueLabel: fmt(y[key]), tip: `${y.year}${y.partial ? " so far" : ""}: ${fmt(y[key])}`,
  })), { ...opts, aria: "Year by year" }) : "";
  const has = cur.sold > 0;
  const curYm = series.at(-1)?.ym;
  const months = series.map((s) => ({ ...s, label: monthLabel(s.ym), current: s.ym === curYm }));
  const soldAll = series.reduce((s, m) => s + m.sold, 0);
  const avgAdr = soldAll ? series.reduce((s, m) => s + m.roomRev, 0) / soldAll : 0;
  const adrTarget = targets.adr > 0 ? targets.adr : avgAdr;
  const adrTargetLabel = targets.adr > 0 ? `Target ${formatINR(targets.adr)}` : `Your 12-month average ${formatINR(r2(avgAdr))}`;
  const revparTarget = (targets.occupancy / 100) * adrTarget;
  const pl = period.prev.label;
  const ota = cur.channels.filter((c) => c.rate > 0);

  const occStatus = has ? rate(cur.occupancy, targets.occupancy, 10) : "none";
  const adrStatus = has ? rate(cur.adr, adrTarget, adrTarget * 0.1) : "none";
  const revparStatus = has ? rate(cur.revpar, revparTarget, revparTarget * 0.1) : "none";
  const directStatus = has ? rate(cur.directShare, targets.direct, 10) : "none";
  const commStatus = has ? (cur.commissionPct <= 10 ? "good" : cur.commissionPct <= 15 ? "warn" : "bad") : "none";
  const alosStatus = cur.stays ? rate(Math.round(cur.alos * 10) / 10, targets.alos, 0.3) : "none";
  const gap = cur.weekendOcc - cur.weekdayOcc;
  const wkStatus = has ? (gap <= 15 ? "good" : gap <= 30 ? "warn" : "bad") : "none";
  const openHouses = cur.houses.filter((h) => !h.closed);
  const houseAvg = openHouses.length ? openHouses.reduce((s, h) => s + h.occ, 0) / openHouses.length : 0;
  const weakest = [...openHouses].sort((a, b) => a.occ - b.occ)[0];
  const strongest = [...openHouses].sort((a, b) => b.occ - a.occ)[0];
  const aptStatus = !has ? "none" : weakest && weakest.occ < houseAvg * 0.5 ? "bad" : weakest && weakest.occ < houseAvg * 0.7 ? "warn" : "good";
  const extrasStatus = !cur.stays ? "none" : prev.stays ? (cur.extrasPerStay >= prev.extrasPerStay ? "good" : cur.extrasPerStay >= prev.extrasPerStay * 0.85 ? "warn" : "bad") : "info";
  const trevStatus = !has ? "none" : prev.sold ? (cur.trevpar >= prev.trevpar ? "good" : cur.trevpar >= prev.trevpar * 0.9 ? "warn" : "bad") : "info";
  const unpaidStatus = cur.stays ? (cur.unpaid.length ? "bad" : "good") : "none";

  const tipMonth = (m, txt) => `${monthLong(m.ym)}${m.partial ? " (so far)" : ""}: ${txt}`;

  const list = [
    {
      key: "occupancy", label: "Occupancy", value: has ? pct(cur.occupancy) : "–", status: occStatus,
      sub: `${cur.sold} of ${cur.available} apartment-nights sold`,
      delta: delta(cur.occupancy, prev.available ? prev.occupancy : null, "pts", true, pl),
      spark: spark(months.map((m) => m.occupancy), { target: targets.occupancy }),
      chart: () => columns(months.map((m) => ({ label: m.label, value: m.occupancy, current: m.current, tip: tipMonth(m, `${pct(m.occupancy)} (${m.sold} nights)`) })),
        { pct: true, target: targets.occupancy, targetLabel: `Target ${targets.occupancy}%`, aria: "Occupancy by month" }),
      table: () => monthTable(months, [["Occupancy", (m) => pct(m.occupancy)], ["Nights sold", (m) => m.sold]]),
      yearChart: () => yearCols("occupancy", pct, { pct: true, target: targets.occupancy, targetLabel: `Target ${targets.occupancy}%` }),
      yearTable: () => simpleTable(["Year", "Occupancy", "Nights sold", "Nights available"], years.map((y) => [`${y.year}${y.partial ? " (so far)" : ""}`, pct(y.occupancy), y.sold, y.available])),
      what: "The share of available apartment-nights that were sold.",
      why: "Shows how full you are. Empty nights earn nothing, but always being full usually means your rates are too low.",
      youVs: has ? `You: <b>${pct(cur.occupancy)}</b> · Target: <b>${targets.occupancy}%</b>` : "",
      tips: {
        good: ["You're above target. On nights that fill early, raise rates by 5–10%.", "Check that minimum-stay rules aren't turning away short stays you could fit in."],
        warn: ["Close to target. Make sure all apartments are open on every channel for the coming weeks.", "Fill weekday gaps with longer-stay or work-from-the-hills offers."],
        bad: ["Well below target. Check every apartment is live on all OTAs, with good photos and correct prices.", "Run a short offer for empty dates and message past guests.", "Look at the Availability grid for gaps you can sell as 1–2 night stays."],
        none: ["No nights sold in this period yet."],
      },
    },
    {
      key: "adr", label: "Average daily rate (ADR)", value: has ? formatINR(Math.round(cur.adr)) : "–", status: adrStatus,
      sub: "Room revenue per night sold, before GST",
      delta: delta(cur.adr, prev.sold ? prev.adr : null, "money", true, pl),
      spark: spark(months.map((m) => m.adr), { target: adrTarget }),
      chart: () => line(months.map((m) => ({ label: m.label, value: m.adr, current: m.current, valueLabel: formatINR(Math.round(m.adr)), tip: tipMonth(m, m.sold ? formatINR(Math.round(m.adr)) : "no nights") })),
        { money: true, target: adrTarget, targetLabel: targets.adr > 0 ? "Target" : "12-month avg", aria: "ADR by month" }),
      table: () => monthTable(months, [["ADR", (m) => (m.sold ? formatINR(Math.round(m.adr)) : "–")], ["Room revenue", (m) => formatINR(Math.round(m.roomRev))]]),
      yearChart: () => yearCols("adr", (v) => formatINR(Math.round(v)), { money: true }),
      yearTable: () => simpleTable(["Year", "ADR", "Room revenue"], years.map((y) => [`${y.year}${y.partial ? " (so far)" : ""}`, y.sold ? formatINR(Math.round(y.adr)) : "–", formatINR(Math.round(y.roomRev))])),
      what: "The average room rate you earn per night sold, before GST.",
      why: "Shows what a night is really earning after discounts and OTA pricing. ADR rising while occupancy stays steady means your pricing is working.",
      youVs: has ? `You: <b>${formatINR(Math.round(cur.adr))}</b> · ${adrTargetLabel}` : "",
      tips: {
        good: ["Your rate is holding up. Test small increases on weekends, long weekends and holidays."],
        warn: ["Slightly below where you want it. Check for OTA discounts stacking on top of each other.", "Reduce long-stay discounts in busy months."],
        bad: ["Well below target. Review OTA promotions and genius/member discounts.", "Set higher rates for weekends, holidays and peak season.", "Charge for extra guests and extra beds."],
        none: ["No nights sold in this period yet."],
      },
    },
    {
      key: "revpar", label: "RevPAR", value: has ? formatINR(Math.round(cur.revpar)) : "–", status: revparStatus,
      sub: "Room revenue per available apartment-night",
      delta: delta(cur.revpar, prev.available ? prev.revpar : null, "money", true, pl),
      spark: spark(months.map((m) => m.revpar), { target: revparTarget }),
      chart: () => columns(months.map((m) => ({ label: m.label, value: m.revpar, current: m.current, valueLabel: formatINR(Math.round(m.revpar)), tip: tipMonth(m, formatINR(Math.round(m.revpar))) })),
        { money: true, target: revparTarget, targetLabel: "Target", aria: "RevPAR by month" }),
      table: () => monthTable(months, [["RevPAR", (m) => formatINR(Math.round(m.revpar))], ["Occupancy", (m) => pct(m.occupancy)], ["ADR", (m) => (m.sold ? formatINR(Math.round(m.adr)) : "–")]]),
      yearChart: () => yearCols("revpar", (v) => formatINR(Math.round(v)), { money: true }),
      yearTable: () => simpleTable(["Year", "RevPAR", "Occupancy", "ADR"], years.map((y) => [`${y.year}${y.partial ? " (so far)" : ""}`, formatINR(Math.round(y.revpar)), pct(y.occupancy), y.sold ? formatINR(Math.round(y.adr)) : "–"])),
      what: "Room revenue divided by every apartment-night you could have sold (ADR × occupancy).",
      why: "The main hotel benchmark. It rewards filling apartments and charging well together, so it tells you whether a price change helped or hurt.",
      youVs: has ? `You: <b>${formatINR(Math.round(cur.revpar))}</b> · Target: <b>${formatINR(Math.round(revparTarget))}</b> <span class="muted">(${targets.occupancy}% × ${formatINR(Math.round(adrTarget))})</span>` : "",
      tips: {
        good: ["Strong. Keep watching it when you change prices: if RevPAR rises, the change worked."],
        warn: ["Slightly low. Look at Occupancy and ADR to see which one is pulling it down."],
        bad: ["Low. If occupancy is low, focus on filling nights. If ADR is low, focus on rates and discounts.", "Small rate rises on busy dates often lift RevPAR without losing guests."],
        none: ["No nights sold in this period yet."],
      },
    },
    {
      key: "trevpar", label: "Total revenue per available night (TRevPAR)", value: has ? formatINR(Math.round(cur.trevpar)) : "–", status: trevStatus,
      sub: `Extras are ${pct(cur.extrasShare)} of revenue`,
      delta: delta(cur.trevpar, prev.available ? prev.trevpar : null, "money", true, pl),
      spark: spark(months.map((m) => m.trevpar)),
      chart: () => columns(months.map((m) => ({ label: m.label, current: m.current, parts: { room: m.revpar, extras: m.available ? m.extrasRev / m.available : 0 }, tip: tipMonth(m, `${formatINR(Math.round(m.trevpar))} (rooms ${formatINR(Math.round(m.revpar))} + extras ${formatINR(Math.round(m.trevpar - m.revpar))})`) })),
        { money: true, aria: "TRevPAR by month", stack: [{ key: "room", label: "Rooms", color: "--s1", muted: "--s1-muted" }, { key: "extras", label: "Extras", color: "--s2", muted: "--s2-muted" }] }),
      table: () => monthTable(months, [["TRevPAR", (m) => formatINR(Math.round(m.trevpar))], ["Extras revenue", (m) => formatINR(Math.round(m.extrasRev))]]),
      what: "All revenue, rooms plus food, extra beds, firewood and gas, per available apartment-night.",
      why: "Shows each apartment's full earning power. Extras add income without needing more guests.",
      youVs: has ? `This period: <b>${formatINR(Math.round(cur.trevpar))}</b> · ${esc(pl)}: <b>${prev.available ? formatINR(Math.round(prev.trevpar)) : "–"}</b>` : "",
      tips: {
        good: ["Growing. Keep offering extras at check-in."], info: ["Offer meal plans, bonfire packages and early check-in when guests book."],
        warn: ["Slightly down. Remind staff to offer food and firewood at check-in."],
        bad: ["Down noticeably. Offer meal plans and bonfire packages when guests book, and put a simple menu in each apartment."],
        none: ["No nights sold in this period yet."],
      },
    },
    {
      key: "direct", appOnly: true, label: "Direct bookings", value: has ? pct(cur.directShare) : "–", status: directStatus,
      sub: "Share of room revenue with no OTA commission",
      delta: delta(cur.directShare, prev.appSold ? prev.directShare : null, "pts", true, pl),
      spark: spark(months.map((m) => m.directShare), { target: targets.direct }),
      chart: () => hbars(cur.channels.map((c) => ({ label: c.type, value: c.share, display: `${pct(c.share)} · ${formatINR(Math.round(c.roomRev))}`, color: c.rate > 0 ? "--s2" : "--s1", tip: `${c.type}: ${pct(c.share)} of room revenue, ${c.nights} nights` })),
        { max: 100, legend: [{ label: "Direct (no commission)", color: "--s1" }, { label: "OTA", color: "--s2" }] }),
      table: () => simpleTable(["Channel", "Nights", "Room revenue", "Share"], cur.channels.map((c) => [c.type, c.nights, formatINR(Math.round(c.roomRev)), pct(c.share)])),
      what: "The share of room revenue from bookings that came to you directly.",
      why: "Direct guests cost no commission and are easier to bring back. Every booking moved from an OTA to direct keeps 15–20% more.",
      youVs: has ? `You: <b>${pct(cur.directShare)}</b> · Target: <b>${targets.direct}%</b>` : "",
      tips: {
        good: ["Good direct share. Keep a returning-guest rate and thank-you message going."],
        warn: ["Nearly there. Give every OTA guest a card with your WhatsApp number and a returning-guest rate."],
        bad: ["Mostly OTA. Give OTA guests your direct contact and a small perk for booking direct next time (late checkout, free firewood).", "Keep your Google Business profile and Instagram up to date with a booking number."],
        none: ["No nights sold in this period yet."],
      },
    },
    {
      key: "commission", appOnly: true, label: "OTA commission (estimated)", value: has ? formatINR(Math.round(cur.commission)) : "–", status: commStatus,
      sub: has ? `${pct(cur.commissionPct)} of room revenue · you keep ${formatINR(Math.round(cur.netRoomRev))}` : "Using the rates in Settings",
      delta: delta(cur.commissionPct, prev.appSold ? prev.commissionPct : null, "pts", false, pl),
      spark: spark(months.map((m) => m.commissionPct)),
      chart: () => (ota.length ? hbars(ota.map((c) => ({ label: c.type, sub: `${c.rate}% commission`, value: c.commission, display: formatINR(Math.round(c.commission)), color: "--s2", tip: `${c.type}: about ${formatINR(Math.round(c.commission))} on ${formatINR(Math.round(c.roomRev))}` }))) : `<p class="muted">No OTA bookings in this period.</p>`),
      table: () => simpleTable(["Channel", "Rate", "Room revenue", "Commission"], ota.map((c) => [c.type, `${c.rate}%`, formatINR(Math.round(c.roomRev)), formatINR(Math.round(c.commission))])),
      what: "An estimate of what you pay OTAs, using the commission rates set in Settings.",
      why: "Commission is your biggest selling cost. Seeing it by channel shows which OTAs are worth what they charge.",
      youVs: has ? `Commission: <b>${pct(cur.commissionPct)}</b> of room revenue · Aim for under <b>10%</b>` : "",
      tips: {
        good: ["Low selling cost. Keep it that way by growing direct and repeat bookings."],
        warn: ["Moderate. Compare each OTA's commission with the nights it brings; drop promotions that add extra commission."],
        bad: ["High. Move repeat guests to direct booking, and check whether the most expensive OTA brings guests the others don't."],
        none: ["No nights sold in this period yet."],
      },
    },
    {
      key: "alos", appOnly: true, label: "Average length of stay", value: cur.stays ? `${cur.alos.toFixed(1)} nights` : "–", status: alosStatus,
      sub: `${cur.stays} booking${cur.stays === 1 ? "" : "s"} checked in`,
      delta: delta(cur.alos, prev.stays ? prev.alos : null, "num", true, pl),
      spark: spark(months.map((m) => m.alos), { target: targets.alos }),
      chart: () => columns(months.map((m) => ({ label: m.label, value: m.alos, current: m.current, valueLabel: m.alos.toFixed(1), tip: tipMonth(m, m.stays ? `${m.alos.toFixed(1)} nights over ${m.stays} bookings` : "no bookings") })),
        { target: targets.alos, targetLabel: `Target ${targets.alos}`, aria: "Average stay by month" }),
      table: () => monthTable(months, [["Avg nights", (m) => (m.stays ? m.alos.toFixed(1) : "–")], ["Bookings", (m) => m.stays]]),
      what: "Average nights per booking, for bookings that checked in during the period.",
      why: "Longer stays mean fewer check-ins, less cleaning and laundry per night, and steadier occupancy.",
      youVs: cur.stays ? `You: <b>${cur.alos.toFixed(1)} nights</b> · Target: <b>${targets.alos}</b>` : "",
      tips: {
        good: ["Guests are staying longer than your target. Good for costs."],
        warn: ["Close. A small weekday discount for a third night can tip it over."],
        bad: ["Mostly short stays. Set a 2-night minimum on weekends and offer a 3rd-night discount on weekdays."],
        none: ["No bookings checked in during this period."],
      },
    },
    {
      key: "apartments", label: "Apartments compared", value: has && strongest ? `${pct(strongest.occ)} – ${pct(weakest.occ)}` : "–", status: aptStatus,
      sub: has && weakest ? `Least booked: ${weakest.name}` : "Occupancy by apartment",
      delta: "",
      spark: `<div class="mini-bars">${cur.houses.map((h) => `<i class="c-${houseColour(h)}" style="height:${h.closed ? 0 : Math.max(6, h.occ)}%"></i>`).join("")}</div>`,
      chart: () => hbars(cur.houses.map((h) => ({ label: h.name, sub: h.closed ? "closed" : h.sold ? `ADR ${formatINR(Math.round(h.adr))}` : "no nights", value: h.occ, display: h.closed ? "closed" : `${pct(h.occ)} · ${h.sold}N`, color: `--house-${houseColour(h)}`, tip: `${h.name}: ${pct(h.occ)} occupied, ${h.sold} nights, ADR ${formatINR(Math.round(h.adr))}, RevPAR ${formatINR(Math.round(h.revpar))}` })),
        { max: 100, target: targets.occupancy, targetLabel: `Target ${targets.occupancy}%` }),
      table: () => simpleTable(["Apartment", "Nights", "Occupancy", "ADR", "RevPAR"], cur.houses.map((h) => [h.name, h.closed ? "closed" : h.sold, h.closed ? "–" : pct(h.occ), h.sold ? formatINR(Math.round(h.adr)) : "–", h.closed ? "–" : formatINR(Math.round(h.revpar))])),
      what: "Occupancy and average rate for each apartment.",
      why: "Shows which apartments are under-booked or under-priced compared with the rest, so you know where to act.",
      youVs: has && weakest ? `Average: <b>${pct(houseAvg)}</b> · Least booked: <b>${esc(weakest.name)} ${pct(weakest.occ)}</b>` : "",
      tips: {
        good: ["Bookings are spread evenly across apartments."],
        warn: [`${weakest?.name || "One apartment"} is behind the others. Check its photos, description and price on each OTA.`],
        bad: [`${weakest?.name || "One apartment"} is far behind. Check it's listed and open on every channel, then review its photos and price.`, "Offer it first when guests ask, or give it a small discount until it catches up."],
        none: ["No nights sold in this period yet."],
      },
    },
    {
      key: "weekend", appOnly: true, label: "Weekends vs weekdays", value: has ? `${pct(cur.weekendOcc)} / ${pct(cur.weekdayOcc)}` : "–", status: wkStatus,
      sub: "Fri–Sat nights / Sun–Thu nights",
      delta: "",
      spark: `<div class="mini-bars two"><i style="height:${Math.max(6, cur.weekendOcc)}%"></i><i class="b2" style="height:${Math.max(6, cur.weekdayOcc)}%"></i></div>`,
      chart: () => hbars([
        { label: "Weekend nights", sub: "Friday and Saturday", value: cur.weekendOcc, display: pct(cur.weekendOcc), color: "--s1" },
        { label: "Weekday nights", sub: "Sunday to Thursday", value: cur.weekdayOcc, display: pct(cur.weekdayOcc), color: "--s1" },
      ], { max: 100, target: targets.occupancy, targetLabel: `Target ${targets.occupancy}%` }),
      table: () => simpleTable(["Nights", "Occupancy"], [["Weekend (Fri–Sat)", pct(cur.weekendOcc)], ["Weekday (Sun–Thu)", pct(cur.weekdayOcc)]]),
      what: "Occupancy on Friday and Saturday nights compared with Sunday to Thursday nights.",
      why: "Leisure stays usually pack the weekends and leave weekdays quiet. The gap shows where to change prices.",
      youVs: has ? `Gap: <b>${Math.round(gap)} pts</b> · Aim for under <b>15 pts</b>` : "",
      tips: {
        good: ["Weekdays and weekends are balanced."],
        warn: [cur.weekendOcc >= 85 ? "Weekends are nearly full: raise weekend rates." : "Weekdays are quieter. Try a weekday rate or a 3-nights-for-2 offer."],
        bad: ["Weekdays are much emptier. Offer weekday deals, long-stay and work-from-the-hills rates.", cur.weekendOcc >= 85 ? "Weekends are full: raise weekend rates to balance demand." : "Promote weekday stays to families and retirees on your direct channels."],
        none: ["No nights sold in this period yet."],
      },
    },
    {
      key: "extras", appOnly: true, label: "Extras per stay", value: cur.stays ? formatINR(Math.round(cur.extrasPerStay)) : "–", status: extrasStatus,
      sub: "Food, extra bed, firewood and gas per booking",
      delta: delta(cur.extrasPerStay, prev.stays ? prev.extrasPerStay : null, "money", true, pl),
      spark: spark(months.map((m) => m.extrasPerStay)),
      chart: () => hbars([
        ["Food", cur.extrasBreakdown.food], ["Extra bed", cur.extrasBreakdown.bed], ["Firewood", cur.extrasBreakdown.firewood], ["Gas", cur.extrasBreakdown.gas],
      ].map(([l, v]) => ({ label: l, value: v, display: formatINR(Math.round(v)), color: "--s2" }))),
      table: () => simpleTable(["Extra", "Average per stay"], [["Food", formatINR(Math.round(cur.extrasBreakdown.food))], ["Extra bed", formatINR(Math.round(cur.extrasBreakdown.bed))], ["Firewood", formatINR(Math.round(cur.extrasBreakdown.firewood))], ["Gas", formatINR(Math.round(cur.extrasBreakdown.gas))]]),
      what: "Average spent on food, extra beds, firewood and gas per booking.",
      why: "Extras are income from guests you already have, and they make stays more memorable.",
      youVs: cur.stays ? `This period: <b>${formatINR(Math.round(cur.extrasPerStay))}</b> · ${esc(pl)}: <b>${prev.stays ? formatINR(Math.round(prev.extrasPerStay)) : "–"}</b>` : "",
      tips: {
        good: ["Guests are spending more on extras."], info: ["Offer a dinner or bonfire package when guests book."],
        warn: ["Slightly down. Offer dinner and firewood when guests arrive."],
        bad: ["Down. Put a simple menu and bonfire price card in each apartment and offer them at check-in."],
        none: ["No bookings checked in during this period."],
      },
    },
    {
      key: "unpaid", appOnly: true, label: "Unpaid balances", value: cur.stays ? formatINR(Math.round(cur.unpaidTotal)) : "–", status: unpaidStatus,
      sub: cur.unpaid.length ? `${cur.unpaid.length} stay${cur.unpaid.length === 1 ? "" : "s"} checked out with money due` : "Stays checked out and fully paid",
      delta: "",
      spark: "",
      chart: () => (cur.unpaid.length ? `<ul class="unpaid">${cur.unpaid.slice(0, 20).map((x) => `<li><button type="button" class="linkish" data-open="${esc(x.b.id)}"><b>#${esc(x.b.serial)} ${esc(x.b.guest_name)}</b><span>${formatDate(x.b.check_in)} → ${formatDate(x.b.check_out)}</span></button><b class="due">${formatINR(x.due)}</b></li>`).join("")}</ul>` : `<p class="muted">Nothing outstanding. Every stay that has checked out is fully paid.</p>`),
      table: () => "",
      what: "Money still owed on stays that have already checked out.",
      why: "This is revenue you've earned but not collected. The longer it's left, the harder it is to collect.",
      youVs: cur.stays ? `Owed: <b>${formatINR(Math.round(cur.unpaidTotal))}</b> · Should be <b>₹0</b>` : "",
      tips: {
        good: ["All collected."],
        bad: ["Tap a stay to open it, then record the payment or follow up with the guest.", "If it was paid but not recorded, add the cash or UPI amount so the books match."],
        none: ["No bookings checked in during this period."],
      },
    },
  ];
  if (appNote) for (const m of list) if (m.appOnly) {
    m.note = "The spreadsheet history only has nights and room revenue, so this uses bookings entered in the app.";
    if (!(cur.appSold || cur.stays)) { m.value = "–"; m.status = "none"; m.delta = ""; m.sub = appNote; }
    else m.sub = `${m.sub} · ${appNote.toLowerCase()}`;
  }
  const trev = list.find((m) => m.key === "trevpar");
  if (histUsed && trev) trev.note = "Extras (food, extra beds, firewood, gas) aren't in the spreadsheet history, so for those months this equals RevPAR.";
  return list;
}

function monthTable(months, cols) {
  return simpleTable(["Month", ...cols.map((c) => c[0])], months.map((m) => [monthLong(m.ym), ...cols.map((c) => c[1](m))]));
}
function simpleTable(head, rows) {
  if (!rows.length) return "";
  return `<details class="numbers"><summary>Show the numbers</summary><div class="tablewrap"><table><thead><tr>${head.map((h, i) => `<th class="${i ? "r" : ""}">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v, i) => `<td class="${i ? "r" : ""}">${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></details>`;
}

export function cardsHTML(metrics) {
  return metrics.map((m) => `
    <button type="button" class="pcard st-edge-${m.status}" data-metric="${m.key}" aria-label="${esc(m.label)}: ${esc(m.value)}, ${STATUS_TEXT[m.status]}. Tap for details">
      <span class="pc-head"><span class="pc-label">${esc(m.label)}</span>${statusPill(m.status)}</span>
      <span class="pc-value">${esc(m.value)}</span>
      <span class="pc-sub">${esc(m.sub)}</span>
      <span class="pc-foot">${m.delta || "<span></span>"}${m.spark || ""}</span>
    </button>`).join("");
}

export function detailHTML(m, isOwner) {
  const tips = m.tips[m.status] || m.tips.info || m.tips.good || [];
  return `
    <div class="pd-top">
      <div class="pd-value">${esc(m.value)}</div>
      ${statusPill(m.status)}
    </div>
    <p class="pd-sub">${esc(m.sub)}</p>
    ${m.delta ? `<p class="pd-delta">${m.delta}</p>` : ""}
    ${m.note ? `<p class="pd-note">${esc(m.note)}</p>` : ""}
    <div class="pd-chart">${m.chart()}</div>
    ${m.table()}
    ${m.yearChart && m.yearChart() ? `<h3 class="pd-h">Year by year</h3><div class="pd-chart">${m.yearChart()}</div><p class="muted small">* this year so far.</p>${m.yearTable()}` : ""}
    <section class="pd-block"><h3>What it is</h3><p>${esc(m.what)}</p></section>
    <section class="pd-block"><h3>Why it matters</h3><p>${esc(m.why)}</p></section>
    ${m.youVs ? `<section class="pd-block"><h3>You vs where you should be</h3><p>${m.youVs}</p></section>` : ""}
    <section class="pd-block"><h3>What to do</h3><ul>${tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></section>
    ${isOwner && ["occupancy", "adr", "revpar", "direct", "alos", "commission", "apartments", "weekend"].includes(m.key) ? `<p class="muted small">Targets and commission rates can be changed in <button type="button" class="linkish" data-goto="settings">Settings</button>.</p>` : ""}`;
}
