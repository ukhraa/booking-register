import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY, BUSINESS_NAME, BOOKING_TYPES } from "./config.js";
import {
  calcBooking, suggestGstPct, formatINR, formatDate, todayISO, monthRange, toCSV, num, dayNumber,
  extraAmount, extraRate, nightsBetween, financialYear, reportPeriods, periodTotals, periodsSpan,
  addDays, availabilityGrid, occupancy, closureOn, closureClash,
} from "./calc.js";
import { billHTML } from "./bill.js";
import { computeMetrics, monthlySeries, yearlySeries, perfPeriod, DEFAULT_TARGETS, commissionKey, commissionFor, profitMetrics, monthlyProfitSeries, UNKNOWN_TYPE } from "./perf.js";
import { buildMetrics, cardsHTML, detailHTML } from "./performance.js";
import { monthSheet, dayTotals, monthProfit, expensesCSV } from "./expenses-calc.js";
import { waPhone, prettyPhone, billMessage, waLink, billFileName, jpegToPdf } from "./whatsapp.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const show = (el, on = true) => { (typeof el === "string" ? $(el) : el).hidden = !on; };

// ── service worker (makes the app installable and load offline) ──
if ("serviceWorker" in navigator) {
  // updateViaCache "none": always check GitHub for a new sw.js.
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {}));
  // When a new version takes over, reload once so it shows straight away.
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloaded) return;
    if (!document.getElementById("sheet")?.hidden) return; // don't lose a booking being typed
    reloaded = true;
    location.reload();
  });
}

// ── Light / Dark (Light is the default; the choice is kept on this device) ──
function applyTheme(theme) {
  const dark = theme === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const meta = document.getElementById("themeColor");
  if (meta) meta.content = dark ? "#000000" : "#ffffff";
  document.querySelectorAll(".theme-toggle").forEach((b) => {
    b.setAttribute("aria-pressed", String(dark));
    const label = dark ? "Light mode" : "Dark mode";
    b.title = label;
    if (b.classList.contains("icon-btn")) b.setAttribute("aria-label", label);
    const t = b.querySelector(".theme-label");
    if (t) t.textContent = label;
  });
}
applyTheme(document.documentElement.dataset.theme);
document.querySelectorAll(".theme-toggle").forEach((b) => b.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  try { localStorage.setItem("theme", next); } catch {}
}));

document.title = BUSINESS_NAME;
document.querySelectorAll(".biz-name").forEach((el) => (el.textContent = BUSINESS_NAME));

// Accept the URL however it was pasted: trim spaces, drop "/rest/v1" and trailing slashes.
const PROJECT_URL = SUPABASE_URL.trim().replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");
const API_KEY = SUPABASE_ANON_KEY.trim();
const configured = !PROJECT_URL.includes("YOUR-PROJECT") && !API_KEY.startsWith("YOUR-");
const secretKey = API_KEY.startsWith("sb_secret_") || /service_role/.test(atobSafe(API_KEY.split(".")[1]));
function atobSafe(s) { try { return s ? atob(s.replace(/-/g, "+").replace(/_/g, "/")) : ""; } catch { return ""; } }
if (!configured || secretKey) {
  if (secretKey) $("setupView").querySelector("p").textContent =
    "js/config.js contains a secret (service_role) key. Replace it with the publishable or anon key from Supabase, and reset the secret key in Supabase because it is now public.";
  show("setupView");
  throw new Error("Supabase is not configured correctly in js/config.js");
}

const sb = createClient(PROJECT_URL, API_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// ── state ──
const state = {
  profile: null,
  houses: [],
  bookings: [],      // bookings for the selected period
  upcoming: [],      // stays from today onwards, for the Apartments tab
  fyRows: [],        // this financial year's bookings, for the Totals table
  calMonth: todayISO().slice(0, 7), // month shown on the Availability grid
  calStays: [],      // bookings touching that month
  perfRows: [],      // bookings for the Performance tab (about two years)
  perfExpenses: null, // owners only: { cats, monthly, daily } for Profit
  history: [],       // monthly figures from before the app (monthly_history)
  foodIncome: [],    // kitchen income per month from the old diaries (monthly_food_income)
  closures: [],      // closed dates (closed_dates)
  exp: { ready: false, cats: [], daily: {}, monthly: {}, view: "daily", day: todayISO(), ym: todayISO().slice(0, 7), dirty: false, discardArmed: false },
  settingsMap: {},   // every row of the settings table, key → number
  targets: { ...DEFAULT_TARGETS },
  perfMetrics: [],
  editing: null,     // booking being edited, or null for a new one
  gstTouched: false,
  overlapAck: false,
  channel: null,
  // Yes/No extras: current rates from Settings, and the amounts on the open form
  rates: { extra_bed: 500, firewood: 600, gas: 500 },
  ratesLoaded: false,
  // Per-day extras on the open form. rate = ₹ per day locked in when set to Yes
  // (or the saved rate when editing); auto = days follow the number of nights.
  extras: {
    extra_bed: { on: false, rate: 0, auto: true },
    firewood: { on: false, rate: 0, auto: true },
    gas: { on: false, rate: 0, auto: true },
  },
  // Business details printed on the guest bill (business_profile table)
  business: { legal_name: "", address: "", phone: "", email: "", gstin: "", state: "", invoice_prefix: "TSR", footer_note: "", signature: "" },
  businessLoaded: false,
  sigDraft: null,    // signature picked in Settings but not saved yet ("" = removed)
};
const BIZ_FIELDS = ["legal_name", "address", "phone", "email", "gstin", "state", "invoice_prefix", "footer_note"];
const EXTRAS = ["extra_bed", "firewood", "gas"];
const EXTRA_LABEL = { extra_bed: "Extra Bed", firewood: "Firewood", gas: "Gas" };
const isOwner = () => state.profile?.role === "owner";
const houseName = (id) => state.houses.find((h) => h.id === id)?.name ?? `Apartment ${id}`;

// ── toast ──
let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  show(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => show(t, false), 2600);
}

// ── online / offline ──
const updateOnline = () => show("offline", !navigator.onLine);
window.addEventListener("online", () => { updateOnline(); if (state.profile) reloadAll(); });
window.addEventListener("offline", updateOnline);
updateOnline();

// ════════════════════════════ Auth ════════════════════════════
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;
  const err = $("loginErr");
  show(err, false);
  if (!email || !password) { err.textContent = "Enter your email and password."; show(err); return; }
  $("loginBtn").disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email, password });
  $("loginBtn").disabled = false;
  if (error) {
    err.textContent = /invalid/i.test(error.message)
      ? "That email and password don't match. Check them and try again."
      : navigator.onLine ? error.message : "You're offline. Connect to the internet to sign in.";
    show(err);
  }
});

$("signOutBtn").addEventListener("click", async () => { await sb.auth.signOut(); });

sb.auth.onAuthStateChange((_event, session) => {
  // Defer so Supabase finishes its own work before we query.
  setTimeout(() => (session ? enterApp(session) : leaveApp()), 0);
});

async function enterApp(session) {
  if (state.profile?.id === session.user.id) return;
  const { data: profile, error } = await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
  if (error || !profile || !profile.active) {
    await sb.auth.signOut();
    $("loginErr").textContent = error
      ? "Couldn't load your account. Check your connection and try again."
      : "This login has been switched off. Ask the owner to turn it back on.";
    show("loginErr");
    return;
  }
  state.profile = profile;
  $("whoName").textContent = `${profile.full_name || profile.email} · ${profile.role === "owner" ? "Owner" : "Staff"}`;
  show("settingsBtn", isOwner());
  show("loginView", false);
  show("appView");
  buildStaticSelects();
  await reloadAll();
  subscribeLive();
}

function leaveApp() {
  state.profile = null;
  state.bookings = [];
  if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }
  closeBill();
  closeSheet();
  show("appView", false);
  show("loginView");
  $("loginPassword").value = "";
}

// ════════════════════════════ Data ════════════════════════════
async function loadHouses() {
  const { data, error } = await sb.from("houses").select("*").eq("active", true).order("sort_order");
  if (!error) state.houses = data;
}

async function loadRates() {
  const { data, error } = await sb.from("settings").select("key,value");
  if (error) { state.ratesLoaded = false; return; } // table missing: keep defaults
  state.ratesLoaded = true;
  state.settingsMap = {};
  for (const row of data) {
    state.settingsMap[row.key] = num(row.value);
    const k = row.key.replace(/_rate$/, "");
    if (EXTRAS.includes(k)) state.rates[k] = num(row.value);
  }
  const t = { ...DEFAULT_TARGETS };
  for (const k of Object.keys(t)) if (`target_${k}` in state.settingsMap) t[k] = state.settingsMap[`target_${k}`];
  state.targets = t;
}

async function loadBusiness() {
  const { data, error } = await sb.from("business_profile").select("*").eq("id", 1).maybeSingle();
  state.businessLoaded = !error && !!data;
  if (state.businessLoaded) [...BIZ_FIELDS, "signature"].forEach((k) => (state.business[k] = data[k] ?? ""));
}

async function loadBookings() {
  const month = $("fMonth").value;
  show("loading");
  const pageSize = 1000;
  let rows = [];
  for (let from = 0; ; from += pageSize) {
    let q = sb.from("bookings").select("*").order("check_in", { ascending: false }).order("serial", { ascending: false }).range(from, from + pageSize - 1);
    if (month && month !== "all") {
      const [start, end] = monthRange(month);
      q = q.gte("check_in", start).lte("check_in", end);
    }
    const { data, error } = await q;
    if (error) { show("loading", false); toast("Couldn't load bookings. Check your connection."); return; }
    rows = rows.concat(data);
    if (data.length < pageSize) break;
  }
  state.bookings = rows;
  show("loading", false);
}

async function loadUpcoming() {
  const { data, error } = await sb.from("bookings")
    .select("id,serial,house_id,guest_name,check_in,check_out,booking_type")
    .gte("check_out", todayISO()).order("check_in").limit(300); // includes today's check-outs
  if (!error) state.upcoming = data;
}

// Every booking the Totals table needs: this financial year plus 1 Jan onwards (YTD).
async function loadTotals() {
  const span = periodsSpan(reportPeriods(todayISO()));
  const cols = "check_in,nights,gross_total,gst_amount,advance_ota,paid_cash,paid_upi,from_diary";
  const pageSize = 1000;
  let rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await sb.from("bookings").select(cols)
      .gte("check_in", span.start).lte("check_in", span.end).order("check_in").range(from, from + pageSize - 1);
    if (error) return;
    rows = rows.concat(data);
    if (data.length < pageSize) break;
  }
  state.fyRows = rows;
}

function renderTotals() {
  const today = todayISO();
  const short = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  const periods = reportPeriods(today);
  const heads = {
    day: ["Today", short(today)],
    month: [new Date(`${today}T00:00:00`).toLocaleDateString("en-IN", { month: "long" }), `${short(periods[1].start)} – ${short(today)}`],
    year: [periods[2].label, `${short(periods[2].start)} – ${short(today)}`],
    ytd: ["Year to date", `${short(periods[3].start)} – ${short(today)}`],
    upcoming: ["Upcoming", `from ${short(periods[4].start)}`],
  };
  const totals = periods.map((p) => periodTotals(state.fyRows || [], p.start, p.end));
  const ROWS = [
    ["Bookings", "bookings", false], ["Room nights", "nights", false], ["Gross total", "gross", true],
    ["GST", "gst", true], ["Advance / OTA", "advance", true], ["Balance after OTA", "afterOta", true],
    ["Cash", "cash", true], ["UPI", "upi", true],
  ];
  const diary = Math.max(...totals.map((t) => t.diary || 0));
  $("totalsNote").textContent = diary
    ? "Stays from the old booking diaries count in bookings, room nights and gross total (room revenue before GST). The diaries have no GST or payment details, so those stays are left out of Balance after OTA, Cash and UPI."
    : "";
  show("totalsNote", !!diary);
  $("totalsTable").innerHTML =
    `<thead><tr><th scope="col"><span class="sr">Figure</span></th>${periods.map((p, i) => `<th scope="col" data-col="${i}">${esc(heads[p.key][0])}<small>${esc(heads[p.key][1])}</small></th>`).join("")}</tr></thead>` +
    `<tbody>${ROWS.map(([label, k, money]) => `<tr class="${k === "gross" ? "key" : ""}"><th scope="row">${label}</th>${totals.map((t, i) => `<td data-col="${i}">${money ? formatINR(t[k]) : t[k]}</td>`).join("")}</tr>`).join("")}</tbody>`;
}

// Phone switcher: show one period column at a time (remembered on this device).
function pickTotalsCol(i) {
  $("totalsTable").className = `totals-table show-${i}`;
  document.querySelectorAll("#totalsSeg button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.col === String(i))));
  try { localStorage.setItem("totalsCol", String(i)); } catch {}
}
$("totalsSeg").addEventListener("click", (e) => { const b = e.target.closest("[data-col]"); if (b) pickTotalsCol(b.dataset.col); });
try { const saved = localStorage.getItem("totalsCol"); if (/^[0-4]$/.test(saved || "")) pickTotalsCol(saved); } catch {}

async function reloadAll() {
  await Promise.all([loadHouses(), loadRates(), loadBusiness()]);
  buildHouseSelects();
  await Promise.all([loadBookings(), loadUpcoming(), loadTotals(), loadCalendar(), loadClosures(), loadPerf(), loadExpenses()]);
  renderTotals();
  renderPerf();
  renderExpenses();
  renderToday();
  renderRegister();
  renderCalendar();
  if (isOwner()) renderSettings();
}

let reloadTimer;
function subscribeLive() {
  if (state.channel) return;
  const later = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(reloadAll, 400); };
  state.channel = sb.channel("register")
    .on("postgres_changes", { event: "*", schema: "public", table: "bookings" }, later)
    .on("postgres_changes", { event: "*", schema: "public", table: "houses" }, later)
    .on("postgres_changes", { event: "*", schema: "public", table: "settings" }, later)
    .on("postgres_changes", { event: "*", schema: "public", table: "daily_expenses" }, later)
    .on("postgres_changes", { event: "*", schema: "public", table: "monthly_expenses" }, later)
    .on("postgres_changes", { event: "*", schema: "public", table: "business_profile" }, later)
    .on("postgres_changes", { event: "*", schema: "public", table: "closed_dates" }, later)
    .subscribe();
  // Catch up when the phone wakes the app again.
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.profile) later(); });
}

// ════════════════════════════ Filters ════════════════════════════
function buildStaticSelects() {
  // Months: 6 ahead, back to January 2023 (the first month in the old diaries)
  const now = new Date();
  const opts = [];
  const back = (now.getFullYear() - 2023) * 12 + now.getMonth();
  for (let i = 6; i >= -back; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    opts.push(`<option value="${ym}">${d.toLocaleDateString("en-IN", { month: "long", year: "numeric" })}</option>`);
  }
  $("fMonth").innerHTML = opts.join("") + `<option value="all">All months</option>`;
  $("fMonth").value = todayISO().slice(0, 7);
  $("fType").innerHTML = `<option value="">All booking types</option>` + [...BOOKING_TYPES, UNKNOWN_TYPE].map((t) => `<option>${esc(t)}</option>`).join("");
  $("booking_type").innerHTML = BOOKING_TYPES.map((t) => `<option>${esc(t)}</option>`).join("");
}

function buildHouseSelects() {
  const keep = $("fHouse").value;
  $("fHouse").innerHTML = `<option value="">All apartments</option>` + state.houses.map((h) => `<option value="${h.id}">${esc(h.name)}</option>`).join("");
  $("fHouse").value = keep;
  $("house_id").innerHTML = state.houses.map((h) => `<option value="${h.id}">${esc(h.name)}</option>`).join("");
}

$("fMonth").addEventListener("change", async () => { await loadBookings(); renderRegister(); });
["fHouse", "fType", "fBal"].forEach((id) => $(id).addEventListener("change", renderRegister));
$("fSearch").addEventListener("input", renderRegister);

function visibleBookings() {
  const h = $("fHouse").value, t = $("fType").value, bal = $("fBal").value;
  const q = $("fSearch").value.trim().toLowerCase();
  return state.bookings.filter((b) => {
    if (h && String(b.house_id) !== h) return false;
    if (t && b.booking_type !== t) return false;
    if (bal && (b.from_diary || (bal === "yes") !== b.total_balanced)) return false; // diary stays have no payments
    if (q && !`${b.guest_name} ${b.guest_phone || ""} ${b.bill_no} ${b.notes} ${houseName(b.house_id)} ${b.serial}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

// ════════════════════════════ Register ════════════════════════════
const COLS = [
  ["Sl. No.", "serial", ""], ["House Name", "house", ""], ["Booking Type", "booking_type", ""],
  ["Guest Name", "guest_name", ""], ["Check-in", "check_in", ""], ["Check-out", "check_out", ""],
  ["Nights", "nights", "r"], ["Tariff", "tariff", "r"], ["GST %", "gst_pct", "r"],
  ["GST Amt", "gst_amount", "r"], ["Total Tariff", "total_tariff", "r"], ["Bill No.", "bill_no", ""],
  ["Food Bill", "food_bill", "r"], ["Extra Bed", "extra_bed", "r"], ["Firewood", "firewood", "r"],
  ["Gas", "gas", "r"], ["Gross Total", "gross_total", "r"], ["Advance / OTA", "advance_ota", "r"],
  ["Total Balance", "total_balance", "r"], ["Paid by Cash", "paid_cash", "r"],
  ["Cash Received", "cash_received", "r"], ["Tips", "tips", "r"], ["Paid by UPI", "paid_upi", "r"],
  ["Balanced?", "total_balanced", ""], ["Notes", "notes", ""],
];
const SUM = new Set(["nights", "tariff", "gst_amount", "total_tariff", "food_bill", "extra_bed", "firewood", "gas", "gross_total", "advance_ota", "total_balance", "paid_cash", "cash_received", "tips", "paid_upi"]);
const ALWAYS_SHOW = new Set(["tariff", "total_tariff", "gross_total", "total_balance", "gst_amount"]);
$("thead").innerHTML = COLS.map(([l, , c], i) => `<th class="${c} ${i === 0 ? "sticky1" : ""}">${l}</th>`).join("");

function balancePill(b) {
  if (b.from_diary) return `<span class="pill diary" title="From the old booking diary: room revenue only, no payment details">Diary</span>`;
  if (b.total_balanced) return `<span class="pill yes">Yes</span>`;
  const diff = num(b.paid_cash) + num(b.paid_upi) - num(b.total_balance);
  return `<span class="pill no">${diff < 0 ? "Due " + formatINR(-diff) : "Over " + formatINR(diff)}</span>`;
}

function cell(b, k) {
  switch (k) {
    case "house": return esc(houseName(b.house_id));
    case "check_in": case "check_out": return formatDate(b[k]);
    case "nights": case "serial": return b[k];
    case "gst_pct": return `${num(b.gst_pct)}%`;
    case "total_balanced": return balancePill(b);
    case "booking_type": case "guest_name": case "bill_no": case "notes": return esc(b[k]);
    default: return num(b[k]) || ALWAYS_SHOW.has(k) ? formatINR(b[k]) : "";
  }
}

function renderRegister() {
  const rows = visibleBookings();
  const month = $("fMonth").value;
  $("periodTitle").textContent = month === "all" ? "All bookings" : `Bookings · ${$("fMonth").selectedOptions[0]?.textContent ?? ""}`;

  $("tbody").innerHTML = rows.map((b) =>
    `<tr data-id="${b.id}" tabindex="0">` +
    COLS.map(([, k, c], i) => `<td class="${c} ${i === 0 ? "sticky1" : ""} ${k === "notes" ? "notes" : ""}"${k === "notes" ? ` title="${esc(b.notes)}"` : ""}>${cell(b, k)}</td>`).join("") +
    `</tr>`).join("");

  const tot = {};
  rows.forEach((b) => SUM.forEach((k) => (tot[k] = (tot[k] || 0) + num(b[k]))));
  $("tfoot").innerHTML = rows.length
    ? `<tr>${COLS.map(([, k, c], i) => `<td class="${c} ${i === 0 ? "sticky1" : ""}">${i === 0 ? "Total" : SUM.has(k) ? (k === "nights" ? tot[k] : formatINR(tot[k])) : ""}</td>`).join("")}</tr>`
    : "";

  $("cards").innerHTML = rows.map((b) => `
    <button class="bcard" data-id="${b.id}" type="button">
      <span class="g">#${b.serial} · ${esc(b.guest_name)}</span><span class="amt">${formatINR(b.gross_total)}</span>
      <span class="sub">${esc(houseName(b.house_id))} · ${formatDate(b.check_in)} → ${formatDate(b.check_out)} · ${b.nights}N · ${esc(b.booking_type)}</span>
      <span>${balancePill(b)}</span>
    </button>`).join("");

  const empty = $("empty");
  show(empty, rows.length === 0 && $("loading").hidden);
  empty.textContent = state.bookings.length ? "No bookings match these filters." : "No bookings for this period yet. Tap New booking to add one.";
}

const openFromRow = (e) => {
  const el = e.target.closest("[data-id]");
  if (el) openSheet(state.bookings.find((b) => b.id === el.dataset.id));
};
$("tbody").addEventListener("click", openFromRow);
$("tbody").addEventListener("keydown", (e) => { if (e.key === "Enter") openFromRow(e); });
$("cards").addEventListener("click", openFromRow);

$("exportBtn").addEventListener("click", () => {
  const rows = visibleBookings().slice().sort((a, b) => a.serial - b.serial);
  if (!rows.length) { toast("Nothing to export for these filters"); return; }
  const blob = new Blob([toCSV(rows, houseName)], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  const m = $("fMonth").value;
  a.href = URL.createObjectURL(blob);
  a.download = `bookings-${m === "all" ? "all" : m}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
});

// ════════════════════════════ Apartments ════════════════════════════
// Summary: who is arriving, staying and leaving today.
function renderToday() {
  const today = todayISO();
  const t = dayNumber(today);
  $("todayDate").textContent = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });
  const stays = state.upcoming;
  const arriving = stays.filter((b) => b.check_in === today);
  const leaving = stays.filter((b) => b.check_out === today);
  const staying = stays.filter((b) => dayNumber(b.check_in) <= t && dayNumber(b.check_out) > t);
  const occupied = new Set(staying.map((b) => b.house_id)).size;
  const list = (rows, line) => rows.length
    ? `<ul>${rows.map((b) => `<li><b>${esc(b.guest_name)}</b><span>${esc(houseName(b.house_id))}${line(b)}</span></li>`).join("")}</ul>`
    : `<p class="muted small">None</p>`;
  const card = (title, count, body, cls = "") =>
    `<div class="today-card ${cls}"><div class="today-head"><span>${title}</span><b>${count}</b></div>${body}</div>`;
  $("todayGrid").innerHTML = [
    card("Occupied tonight", `${occupied} of ${state.houses.length}`,
      `<div class="meter" role="img" aria-label="${occupied} of ${state.houses.length} apartments occupied"><i style="width:${state.houses.length ? (occupied / state.houses.length) * 100 : 0}%"></i></div>`, "occ"),
    card("Arriving today", arriving.length, list(arriving, (b) => ` · until ${formatDate(b.check_out)}`)),
    card("Leaving today", leaving.length, list(leaving, (b) => ` · since ${formatDate(b.check_in)}`)),
  ].join("");
}

// ════════════════════════════ Availability grid ════════════════════════════
// Apartments across, days of the month down. Each apartment has a colour
// (Settings); a booked night is shaded in it, a free night is white.
const COLOURS = ["green", "red", "orange", "grey", "blue", "purple", "teal", "pink", "yellow"];
const COLOUR_NAMES = { red: "Red", green: "Green", blue: "Blue", grey: "Grey", orange: "Orange", purple: "Purple", teal: "Teal", pink: "Pink", yellow: "Yellow" };
const NAME_COLOURS = [["amazon", "green"], ["bhoomi", "red"], ["vismay", "orange"], ["himalaya", "grey"], ["nilgiri", "blue"], ["venus", "purple"]];
/** First word of a name, without "(3 Bed)" etc.: "Bhoomi (3 Bed)" → "Bhoomi". */
function shortName(name) {
  return String(name || "").trim().split(/[\s(\-–,]+/)[0] || String(name || "");
}
function houseColour(h) {
  if (h?.color && COLOURS.includes(h.color)) return h.color;
  const n = String(h?.name || "").toLowerCase();
  const byName = NAME_COLOURS.find(([k]) => n.includes(k));
  return byName ? byName[1] : COLOURS[((h?.id || 1) - 1) % COLOURS.length];
}

// Closed dates (migration 009; missing table = none). Small, so all of them are kept.
async function loadClosures() {
  const { data, error } = await sb.from("closed_dates").select("*").order("start_date").limit(2000);
  state.closures = error ? [] : data;
}
const closureLabel = (c) => (c.direct_only ? "Closed for direct bookings" : "Closed");
const closureWho = (c) => (c.house_id == null ? "all apartments" : houseName(c.house_id));

async function loadCalendar() {
  const [start, end] = monthRange(state.calMonth);
  show("calLoading");
  const { data, error } = await sb.from("bookings").select("*")
    .lte("check_in", end).gt("check_out", start).order("check_in").limit(1000);
  show("calLoading", false);
  if (!error) state.calStays = data;
}

function renderCalendar() {
  const ym = state.calMonth;
  const houses = state.houses;
  const ids = houses.map((h) => h.id);
  const grid = availabilityGrid(ym, ids, state.calStays || []);
  const occ = occupancy(grid, ids);
  const today = todayISO();
  const monthName = new Date(`${ym}-01T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  $("calTitle").textContent = `Availability · ${monthName}`;
  $("calToday").disabled = ym === today.slice(0, 7);

  // Every label has a full and a short form; narrow screens show the short one
  // so all apartments fit across without sideways scrolling.
  const both = (full, short) => `<span class="lf">${esc(full)}</span><span class="ls" aria-hidden="true">${esc(short)}</span>`;
  const head = `<thead><tr><th class="corner" scope="col">${both("Date", "")}</th>${houses.map((h) =>
    `<th scope="col" class="c-${houseColour(h)}" title="${esc(h.name)}">${both(h.name, shortName(h.name))}</th>`).join("")}<th scope="col" class="freecol" title="Free apartments">${both("Free", "Free")}</th></tr></thead>`;

  const body = grid.map(({ date, cells }) => {
    const d = new Date(`${date}T00:00:00`);
    const dow = d.toLocaleDateString("en-IN", { weekday: "short" });
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    let free = 0;
    const tds = houses.map((h) => {
      const c = cells[h.id];
      const colour = houseColour(h);
      if (!c.stays.length) {
        const shut = closureOn(state.closures, h.id, date);
        if (!shut || shut.direct_only) free++; // closed to direct only: OTAs can still sell it
        if (shut) {
          const first = shut.start_date === date || date.endsWith("-01");
          const label = first ? (shut.direct_only ? both("OTA only", "OTA") : both("Closed", "Shut")) : "";
          const tip = `${closureLabel(shut)}: ${formatDate(shut.start_date)} → ${formatDate(shut.end_date)}${shut.note ? ` · ${shut.note}` : ""}`;
          return `<td class="free ${shut.direct_only ? "nodirect" : "shut"}" title="${esc(tip)}"><button type="button" data-free="${h.id}" data-date="${date}" aria-label="${esc(h.name)}, ${formatDate(date)}: ${esc(tip)}. Book from this night">${label}</button></td>`;
        }
        return `<td class="free"><button type="button" data-free="${h.id}" data-date="${date}" aria-label="Free: ${esc(h.name)}, ${formatDate(date)}. Book from this night"></button></td>`;
      }
      if (c.stays.length > 1) {
        return `<td class="clash" data-id="${c.stays[0].id}" title="Double booked: ${c.stays.map((s) => esc(s.guest_name)).join(", ")}"><b>${both("Double booked", `${c.stays.length}×`)}</b><span class="lf">${c.stays.map((s) => esc(s.guest_name)).join(" · ")}</span></td>`;
      }
      const s = c.stays[0];
      const last = s.check_out === addDays(date, 1);
      const cls = ["booked", `c-${colour}`, c.first ? "start" : "", last ? "end" : ""].join(" ");
      const label = c.first
        ? `<b>${both(s.guest_name, shortName(s.guest_name))}</b><span class="lf">${esc(s.booking_type)} · ${s.nights}N</span>`
        : "";
      return `<td class="${cls}" data-id="${s.id}" title="${esc(s.guest_name)} · ${formatDate(s.check_in)} → ${formatDate(s.check_out)}">${label}</td>`;
    }).join("");
    return `<tr class="${date === today ? "is-today" : ""} ${weekend ? "wknd" : ""}"><th scope="row"><b>${Number(date.slice(8))}</b><small>${dow}</small></th>${tds}<td class="freecol ${free === 0 ? "full" : ""}">${free}</td></tr>`;
  }).join("");

  const foot = `<tfoot><tr><th scope="row">${both("Booked", "%")}</th>${houses.map((h) =>
    `<td><span class="lf">${occ[h.id].nights}/${grid.length}</span><small>${occ[h.id].pct}%</small></td>`).join("")}<td class="freecol"></td></tr></tfoot>`;

  $("calTable").style.setProperty("--cols", houses.length);
  $("calTable").innerHTML = `<colgroup><col class="date">${houses.map(() => "<col>").join("")}<col class="freecol"></colgroup>` + head + `<tbody>${body}</tbody>` + foot;
}

// Show today's row (with a couple of days above it) when the grid opens.
function scrollCalToToday() {
  requestAnimationFrame(() => {
    const row = $("calTable").querySelector("tr.is-today");
    const box = $("calBox");
    if (!row) { box.scrollTop = 0; return; }
    const head = $("calTable").tHead?.getBoundingClientRect().height || 0;
    const rowH = row.cells[0]?.getBoundingClientRect().height || 40;
    const offset = row.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTop = Math.max(0, offset - head - 2 * rowH);
  });
}

$("calTable").addEventListener("click", (e) => {
  const freeBtn = e.target.closest("[data-free]");
  if (freeBtn) {
    const date = freeBtn.dataset.date;
    openSheet(null, { house_id: Number(freeBtn.dataset.free), check_in: date, check_out: addDays(date, 1) });
    return;
  }
  const cell = e.target.closest("[data-id]");
  if (cell) {
    const b = (state.calStays || []).find((x) => x.id === cell.dataset.id);
    if (b) openSheet(b);
  }
});
const shiftMonth = async (n) => {
  const [y, m] = state.calMonth.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  state.calMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  await loadCalendar();
  renderCalendar();
  scrollCalToToday();
};
$("calPrev").addEventListener("click", () => shiftMonth(-1));
$("calNext").addEventListener("click", () => shiftMonth(1));
$("calToday").addEventListener("click", () => { state.calMonth = todayISO().slice(0, 7); shiftMonth(0); });

// ════════════════════════════ Performance ════════════════════════════
const monthName = (ym) => (ym ? new Date(`${ym}-01T00:00:00`).toLocaleDateString("en-IN", { month: "short", year: "numeric" }) : "");
// About two years of bookings: enough for "last FY" and "same dates last year".
async function loadPerf() {
  const today = todayISO();
  const [y, m] = today.split("-").map(Number);
  const from = new Date(Date.UTC(y - 2, m - 1, 1)).toISOString().slice(0, 10);
  const to = perfPeriod("fy", today).end;
  const pageSize = 1000;
  let rows = [];
  for (let start = 0; ; start += pageSize) {
    const { data, error } = await sb.from("bookings").select("*")
      .gt("check_out", from).lte("check_in", to).order("check_in").range(start, start + pageSize - 1);
    if (error) return;
    rows = rows.concat(data);
    if (data.length < pageSize) break;
  }
  state.perfRows = rows;
  // Monthly figures from before the app (table added by migration 007; missing = none).
  const { data: hist, error: hErr } = await sb.from("monthly_history").select("house_id,ym,nights_booked,nights_available,room_revenue").limit(5000);
  state.history = hErr ? [] : hist;
  // Kitchen income from the old diaries (migration 009; missing = none).
  const { data: food, error: fErr } = await sb.from("monthly_food_income").select("ym,amount").limit(1000);
  state.foodIncome = fErr ? [] : food;
  // Owners: expenses for Profit and Cost per night sold (salaries are owner-only).
  state.perfExpenses = null;
  if (isOwner()) {
    const [{ data: cats, error: cErr }, { data: mon, error: mErr }] = await Promise.all([
      sb.from("expense_categories").select("id,name"),
      sb.from("monthly_expenses").select("category_id,ym,amount").gte("ym", from.slice(0, 7)).limit(5000),
    ]);
    if (!cErr && !mErr) {
      let daily = [];
      for (let start = 0; ; start += pageSize) {
        const { data, error } = await sb.from("daily_expenses").select("category_id,spent_on,amount")
          .gte("spent_on", from).order("spent_on").range(start, start + pageSize - 1);
        if (error) break;
        daily = daily.concat(data);
        if (data.length < pageSize) break;
      }
      state.perfExpenses = { cats, monthly: mon, daily };
    }
  }
}

function renderPerf() {
  const today = todayISO();
  const period = perfPeriod($("perfPeriod").value, today);
  const opts = { commission: state.settingsMap, today, history: state.history, foodIncome: state.foodIncome };
  const cur = computeMetrics(state.perfRows, state.houses, period.start, period.end, opts);
  const prev = computeMetrics(state.perfRows, state.houses, period.prev.start, period.prev.end, opts);
  // Trend charts: the 12 months ending with the period (FY shows its own April–March).
  const endYm = (period.end > today ? today : period.end).slice(0, 7);
  const series = monthlySeries(state.perfRows, state.houses, endYm, opts);
  const firstYear = Math.min(Number(today.slice(0, 4)), ...state.history.map((h) => Number(h.ym.slice(0, 4))), ...state.perfRows.slice(0, 1).map((b) => Number(b.check_in.slice(0, 4))));
  const years = yearlySeries(state.perfRows, state.houses, firstYear, today, opts);
  let profit = null;
  if (state.perfExpenses) {
    const po = { ...opts, expenses: state.perfExpenses };
    profit = {
      cur: profitMetrics(state.perfRows, state.houses, period.start, period.end, po),
      prev: profitMetrics(state.perfRows, state.houses, period.prev.start, period.prev.end, po),
      series: monthlyProfitSeries(state.perfRows, state.houses, endYm, po),
    };
  }
  state.perfMetrics = buildMetrics({ cur, prev, series, years, period, targets: state.targets, houses: state.houses, houseColour, profit });
  $("perfNote").textContent = `${formatDate(period.start)} to ${formatDate(period.end)} · compared with ${period.prev.label}${state.history.length ? " · months up to " + monthName(state.history.reduce((m, h) => (h.ym > m ? h.ym : m), "")) + " use your spreadsheet history" : ""}`;
  $("perfCards").innerHTML = cardsHTML(state.perfMetrics);
  if (!$("perfSheet").hidden && state.perfOpen) openPerf(state.perfOpen); // keep an open detail up to date
}
$("perfPeriod").addEventListener("change", () => {
  try { localStorage.setItem("perfPeriod", $("perfPeriod").value); } catch {}
  renderPerf();
});
try { const p = localStorage.getItem("perfPeriod"); if (p && [...$("perfPeriod").options].some((o) => o.value === p)) $("perfPeriod").value = p; } catch {}

function openPerf(key) {
  const m = state.perfMetrics.find((x) => x.key === key);
  if (!m) return;
  state.perfOpen = key;
  $("perfTitle").textContent = m.label;
  $("perfBody").innerHTML = detailHTML(m, isOwner());
  show("perfSheet");
}
function closePerf() { show("perfSheet", false); state.perfOpen = null; hideTip(); }
$("perfCards").addEventListener("click", (e) => { const c = e.target.closest("[data-metric]"); if (c) openPerf(c.dataset.metric); });
document.querySelectorAll("[data-pclose]").forEach((el) => el.addEventListener("click", closePerf));
$("perfBody").addEventListener("click", (e) => {
  const open = e.target.closest("[data-open]");
  if (open) {
    const b = state.perfRows.find((x) => x.id === open.dataset.open);
    if (b) { closePerf(); openSheet(b); }
    return;
  }
  if (e.target.closest("[data-goto]")) { closePerf(); showTab("settings"); $("targetsForm").scrollIntoView({ block: "start" }); }
});

// Shared chart tooltip: any element with data-tip, on hover or keyboard focus.
const tip = $("chartTip");
function showTipFor(el, x, y) {
  tip.textContent = el.getAttribute("data-tip");
  show(tip);
  const r = tip.getBoundingClientRect();
  const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width / 2));
  const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
function hideTip() { show(tip, false); }
document.addEventListener("pointerover", (e) => {
  const el = e.target.closest?.("[data-tip]");
  if (el) showTipFor(el, e.clientX, e.clientY); else hideTip();
});
document.addEventListener("pointermove", (e) => {
  const el = e.target.closest?.("[data-tip]");
  if (el && !tip.hidden) showTipFor(el, e.clientX, e.clientY);
});
document.addEventListener("focusin", (e) => {
  const el = e.target.closest?.("[data-tip]");
  if (!el) return hideTip();
  const r = el.getBoundingClientRect();
  showTipFor(el, r.left + r.width / 2, r.top);
});
document.addEventListener("scroll", hideTip, true);

// ════════════════════════════ Expenses ════════════════════════════
// Daily: anyone signed in adds what they spent today. Monthly (owners): one
// amount per expense line, with that month's daily entries added up into it.
const PAID = { cash: "Cash", upi: "UPI", bank: "Bank", card: "Card" };
const ymOf = (iso) => iso.slice(0, 7);
const shiftYm = (ym, n) => { const [y, m] = ym.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const ymLong = (ym) => new Date(`${ym}-01T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });

async function loadDaily(ym) {
  const [s, e] = monthRange(ym);
  const { data, error } = await sb.from("daily_expenses").select("*").gte("spent_on", s).lte("spent_on", e).order("created_at");
  if (!error) state.exp.daily[ym] = data;
}
async function loadMonthly(ym) {
  if (!isOwner()) return;
  const { data, error } = await sb.from("monthly_expenses").select("*").in("ym", [ym, shiftYm(ym, -1)]);
  if (!error) for (const k of [ym, shiftYm(ym, -1)]) state.exp.monthly[k] = data.filter((r) => r.ym === k);
}
async function loadExpenses() {
  const { data, error } = await sb.from("expense_categories").select("*").order("sort_order");
  state.exp.ready = !error;
  if (error) return;
  state.exp.cats = data;
  state.exp.daily = {};
  const months = new Set([ymOf(state.exp.day), state.exp.ym]);
  await Promise.all([...months].map(loadDaily).concat(loadMonthly(state.exp.ym)));
}

function renderExpenses() {
  const x = state.exp;
  show("expSetup", !x.ready);
  show("expMonthlyTab", isOwner());
  if (!isOwner()) x.view = "daily";
  document.querySelectorAll("#expSeg [data-view]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === x.view)));
  show("expDaily", x.ready && x.view === "daily");
  show("expMonthly", x.ready && x.view === "monthly");
  if (!x.ready) return;
  renderDaily();
  if (isOwner() && !x.dirty) renderMonthly();
  else if (isOwner()) renderMonthCards();
}

function renderDaily() {
  const x = state.exp;
  const dailyCats = x.cats.filter((c) => c.daily && c.active !== false);
  const keep = $("dCat").value;
  $("dCat").innerHTML = dailyCats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  if (keep && dailyCats.some((c) => String(c.id) === keep)) $("dCat").value = keep;
  $("dDate").value = x.day;
  $("dNext").disabled = x.day >= todayISO();
  const monthRows = x.daily[ymOf(x.day)] || [];
  const rows = monthRows.filter((r) => r.spent_on === x.day);
  const total = rows.reduce((s, r) => s + num(r.amount), 0);
  $("dTotal").innerHTML = rows.length ? `Day total <b>${formatINR(total)}</b>` : "";
  const catName = (id) => x.cats.find((c) => c.id === id)?.name || "Expense";
  const canEdit = (r) => isOwner() || r.created_by === state.profile?.id;
  $("dList").innerHTML = rows.length
    ? rows.map((r) => `<li>
        <span class="exp-cat">${esc(catName(r.category_id))}</span>
        <span class="exp-what">${esc(r.note || "")}<small>${PAID[r.paid_by] || ""}</small></span>
        <b class="exp-amt">${formatINR(r.amount)}</b>
        ${canEdit(r) ? `<button type="button" class="btn ghost small exp-del" data-del="${esc(r.id)}" aria-label="Delete this expense">Delete</button>` : ""}
      </li>`).join("")
    : `<li class="exp-empty">Nothing entered for ${formatDate(x.day)} yet.</li>`;
  // This month so far, by line
  const byCat = {};
  for (const r of monthRows) byCat[r.category_id] = (byCat[r.category_id] || 0) + num(r.amount);
  const parts = Object.entries(byCat).map(([id, v]) => `${catName(Number(id))} ${formatINR(v)}`);
  $("dMonthSum").textContent = parts.length
    ? `${ymLong(ymOf(x.day))} so far: ${parts.join(" · ")} · Total ${formatINR(monthRows.reduce((s, r) => s + num(r.amount), 0))}`
    : "";
}

function monthRevenue(ym) {
  const [s, e0] = monthRange(ym);
  const today = todayISO();
  if (s > today) return { revenue: 0, sold: 0 };
  const e = e0 > today ? today : e0;
  const m = computeMetrics(state.perfRows, state.houses, s, e, { history: state.history, foodIncome: state.foodIncome, today, commission: state.settingsMap });
  return { revenue: m.roomRev + m.extrasRev, sold: m.sold, fromHistory: m.historyShare > 0 };
}

function currentSheet() {
  const x = state.exp;
  return monthSheet(x.cats, x.monthly[x.ym] || [], x.daily[x.ym] || [], x.ym);
}

function renderMonthCards() {
  const x = state.exp;
  // Use what's typed in the boxes, so the cards follow edits before saving.
  const sheet = currentSheet();
  let typed = 0;
  for (const r of sheet.rows) {
    const inp = document.querySelector(`#mTable [data-cat="${r.category.id}"]`);
    typed += (inp ? num(inp.value) : r.monthly) + r.daily;
  }
  const rev = monthRevenue(x.ym);
  const p = monthProfit(rev.revenue, typed, rev.sold);
  const card = (label, value, sub, cls = "") => `<div class="exp-card ${cls}"><span>${label}</span><b>${value}</b><small>${sub}</small></div>`;
  $("mCards").innerHTML = [
    card("Revenue", formatINR(Math.round(p.revenue)), rev.sold ? `${rev.sold} nights sold${rev.fromHistory ? " · from your history" : ""}` : "No nights yet"),
    card("Expenses", formatINR(Math.round(p.expenses)), `${formatINR(Math.round(sheet.totals.daily))} from daily entries`),
    card("Profit", formatINR(Math.round(p.profit)), p.revenue ? `${Math.round(p.margin)}% of revenue` : "–", p.profit < 0 ? "loss" : "gain"),
    card("Cost per night sold", rev.sold ? formatINR(Math.round(p.costPerNight)) : "–", "Expenses ÷ nights sold"),
  ].join("");
}

function renderMonthly() {
  const x = state.exp;
  $("mLabel").textContent = ymLong(x.ym);
  const sheet = currentSheet();
  const prev = new Map((x.monthly[shiftYm(x.ym, -1)] || []).map((r) => [r.category_id, num(r.amount)]));
  $("mTable").innerHTML = `<thead><tr><th>Expense</th><th class="r">Monthly</th><th class="r">From daily</th><th class="r">Total</th></tr></thead>
    <tbody>${sheet.rows.map((r) => `<tr>
      <th scope="row">${esc(r.category.name)}${prev.get(r.category.id) ? `<small>Last month ${formatINR(prev.get(r.category.id))}</small>` : ""}</th>
      <td class="r">${r.editable ? `<input type="number" min="0" step="any" inputmode="decimal" data-cat="${r.category.id}" value="${r.monthly || ""}" placeholder="0" aria-label="${esc(r.category.name)} for ${esc(ymLong(x.ym))}">` : `<span class="muted">daily only</span>`}</td>
      <td class="r">${r.daily ? `${formatINR(r.daily)}<small>${r.entries} entr${r.entries === 1 ? "y" : "ies"}</small>` : `<span class="muted">–</span>`}</td>
      <td class="r tot" data-tot="${r.category.id}">${r.total ? formatINR(r.total) : "–"}</td>
    </tr>`).join("")}</tbody>
    <tfoot><tr><th scope="row">Total</th><td class="r" id="mTotMonthly">${formatINR(sheet.totals.monthly)}</td><td class="r">${formatINR(sheet.totals.daily)}</td><td class="r" id="mTotAll">${formatINR(sheet.totals.total)}</td></tr></tfoot>`;
  x.dirty = false;
  x.discardArmed = false;
  $("mDirty").textContent = "";
  show("mErr", false);
  renderMonthCards();
}

// Live totals while typing
$("mTable").addEventListener("input", (e) => {
  const inp = e.target.closest("[data-cat]");
  if (!inp) return;
  const x = state.exp;
  x.dirty = true;
  x.discardArmed = false;
  $("mDirty").textContent = "Unsaved changes";
  const sheet = currentSheet();
  let monthlySum = 0;
  for (const r of sheet.rows) {
    const box = document.querySelector(`#mTable [data-cat="${r.category.id}"]`);
    const mon = box ? num(box.value) : r.monthly;
    monthlySum += mon;
    const cell = document.querySelector(`#mTable [data-tot="${r.category.id}"]`);
    if (cell) cell.textContent = mon + r.daily ? formatINR(mon + r.daily) : "–";
  }
  $("mTotMonthly").textContent = formatINR(monthlySum);
  $("mTotAll").textContent = formatINR(monthlySum + sheet.totals.daily);
  renderMonthCards();
});

$("mForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const x = state.exp;
  show("mErr", false);
  const saved = new Map((x.monthly[x.ym] || []).map((r) => [r.category_id, num(r.amount)]));
  const upserts = [], deletes = [];
  for (const inp of document.querySelectorAll("#mTable [data-cat]")) {
    const id = Number(inp.dataset.cat);
    const v = inp.value.trim() === "" ? 0 : Number(inp.value);
    if (!(v >= 0)) { $("mErr").textContent = "Amounts can't be negative."; show("mErr"); inp.focus(); return; }
    if (v === (saved.get(id) || 0)) continue;
    if (v === 0) deletes.push(id); else upserts.push({ category_id: id, ym: x.ym, amount: v, updated_at: new Date().toISOString() });
  }
  if (!upserts.length && !deletes.length) { toast("Nothing to save"); return; }
  $("mSave").disabled = true;
  try {
    if (upserts.length) { const { error } = await sb.from("monthly_expenses").upsert(upserts); if (error) throw error; }
    if (deletes.length) { const { error } = await sb.from("monthly_expenses").delete().eq("ym", x.ym).in("category_id", deletes); if (error) throw error; }
    x.dirty = false;
    await loadMonthly(x.ym);
    renderMonthly();
    toast(`${ymLong(x.ym)} saved`);
    loadPerf().then(renderPerf); // Profit on the Performance tab
  } catch {
    $("mErr").textContent = navigator.onLine ? "Couldn't save the month. Try again." : "You're offline, so nothing was saved. Try again when you're connected.";
    show("mErr");
  } finally {
    $("mSave").disabled = false;
  }
});

$("mCopy").addEventListener("click", () => {
  const prev = new Map((state.exp.monthly[shiftYm(state.exp.ym, -1)] || []).map((r) => [r.category_id, num(r.amount)]));
  if (!prev.size) { toast("Nothing saved for last month"); return; }
  let n = 0;
  for (const inp of document.querySelectorAll("#mTable [data-cat]")) {
    const v = prev.get(Number(inp.dataset.cat));
    if (v && inp.value.trim() === "") { inp.value = v; n++; }
  }
  if (n) { document.querySelector("#mTable [data-cat]").dispatchEvent(new Event("input", { bubbles: true })); toast(`Copied ${n} line${n === 1 ? "" : "s"} from last month. Check them, then Save month.`); }
  else toast("Every line already has an amount");
});

$("mAddLine").addEventListener("click", async () => {
  const name = $("mNewLine").value.trim();
  show("mErr", false);
  if (!name) { $("mNewLine").focus(); return; }
  if (state.exp.cats.some((c) => c.name.toLowerCase() === name.toLowerCase())) { $("mErr").textContent = `There's already a line called ${name}.`; show("mErr"); return; }
  if (state.exp.dirty) { $("mErr").textContent = "Save month first, then add the new line."; show("mErr"); return; }
  const order = Math.max(0, ...state.exp.cats.filter((c) => c.monthly).map((c) => c.sort_order || 0)) + 1;
  const { error } = await sb.from("expense_categories").insert({ name, monthly: true, daily: false, sort_order: Math.min(order, 49) });
  if (error) { $("mErr").textContent = "Couldn't add the line. Try again."; show("mErr"); return; }
  $("mNewLine").value = "";
  toast(`Added ${name}`);
  await loadExpenses();
  renderExpenses();
});

$("mExport").addEventListener("click", () => {
  const sheet = currentSheet();
  const blob = new Blob([expensesCSV(sheet, ymLong(state.exp.ym))], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `expenses-${state.exp.ym}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
});

async function goMonth(n) {
  const x = state.exp;
  if (x.dirty && !x.discardArmed) {
    x.discardArmed = true;
    $("mDirty").textContent = "Unsaved changes. Save month, or tap the arrow again to discard them.";
    return;
  }
  x.dirty = false;
  x.ym = shiftYm(x.ym, n);
  await Promise.all([loadDaily(x.ym), loadMonthly(x.ym)]);
  renderMonthly();
}
$("mPrev").addEventListener("click", () => goMonth(-1));
$("mNext").addEventListener("click", () => goMonth(1));

async function goDay(iso) {
  const x = state.exp;
  if (!iso) return;
  x.day = iso > todayISO() ? todayISO() : iso;
  if (!x.daily[ymOf(x.day)]) await loadDaily(ymOf(x.day));
  renderDaily();
}
$("dPrev").addEventListener("click", () => goDay(addDays(state.exp.day, -1)));
$("dNext").addEventListener("click", () => goDay(addDays(state.exp.day, 1)));
$("dDate").addEventListener("change", () => goDay($("dDate").value));

$("dForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  show("dErr", false);
  const amount = Number($("dAmt").value);
  const err = (m) => { $("dErr").textContent = m; show("dErr"); };
  if (!$("dCat").value) return err("Choose what the expense was for.");
  if (!(amount > 0)) { $("dAmt").focus(); return err("Enter the amount spent."); }
  $("dAdd").disabled = true;
  const row = { spent_on: state.exp.day, category_id: Number($("dCat").value), amount, paid_by: $("dPaid").value, note: $("dNote").value.trim() };
  const { error } = await sb.from("daily_expenses").insert(row);
  $("dAdd").disabled = false;
  if (error) return err(navigator.onLine ? "Couldn't save. Try again." : "You're offline, so it wasn't saved. Try again when you're connected.");
  $("dAmt").value = ""; $("dNote").value = "";
  toast(`${formatINR(amount)} added`);
  if (isOwner()) loadPerf().then(renderPerf);
  await loadDaily(ymOf(state.exp.day));
  if (state.exp.ym === ymOf(state.exp.day) && !state.exp.dirty && isOwner()) renderMonthly();
  renderDaily();
  $("dAmt").focus();
});

$("dList").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-del]");
  if (!btn) return;
  if (!btn.classList.contains("armed")) {
    btn.classList.add("armed", "danger"); btn.textContent = "Tap to delete";
    setTimeout(() => { btn.classList.remove("armed", "danger"); btn.textContent = "Delete"; }, 4000);
    return;
  }
  const { error } = await sb.from("daily_expenses").delete().eq("id", btn.dataset.del);
  if (error) { toast("Couldn't delete it"); return; }
  toast("Deleted");
  await loadDaily(ymOf(state.exp.day));
  renderDaily();
  if (state.exp.ym === ymOf(state.exp.day) && !state.exp.dirty && isOwner()) renderMonthly();
});

$("expSeg").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-view]");
  if (!b) return;
  state.exp.view = b.dataset.view;
  if (state.exp.view === "monthly" && !state.exp.daily[state.exp.ym]) await loadDaily(state.exp.ym);
  renderExpenses();
});

// ════════════════════════════ Tabs ════════════════════════════
// New booking is also in the bar, but it opens the form instead of switching section.
function showTab(name) {
  document.querySelectorAll(".tab[data-tab]").forEach((b) => {
    if (b.dataset.tab === name) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  $("settingsBtn").setAttribute("aria-pressed", String(name === "settings"));
  ["summary", "register", "houses", "perf", "exp", "settings"].forEach((t) => show(`tab-${t}`, t === name));
  if (name === "houses") scrollCalToToday();
  window.scrollTo({ top: 0 });
}
document.querySelectorAll(".tab[data-tab]").forEach((btn) => btn.addEventListener("click", () => showTab(btn.dataset.tab)));
$("settingsBtn").addEventListener("click", () => showTab("settings"));

// ════════════════════════════ Booking form ════════════════════════════
// Typed money fields. Extra Bed, Firewood and Gas (see EXTRAS) are Yes/No + Days;
// their amount is the rate per day from Settings × days.
const MONEY = ["tariff", "gst_pct", "food_bill", "advance_ota", "paid_cash", "cash_received", "tips", "paid_upi"];
const TEXT = ["booking_type", "guest_name", "guest_phone", "check_in", "check_out", "bill_no", "notes"];
const FIELDS = ["serial", "house_id", ...TEXT, ...MONEY];

function readForm() {
  const o = {};
  MONEY.forEach((f) => (o[f] = $(f).value === "" ? 0 : Number($(f).value)));
  EXTRAS.forEach((k) => {
    const x = state.extras[k];
    const days = x.on ? Math.max(0, Math.floor(num($(`${k}_days`).value))) : 0;
    o[`${k}_days`] = days;
    o[k] = x.on ? extraAmount(x.rate, days) : 0;
  });
  TEXT.forEach((f) => (o[f] = $(f).value.trim()));
  o.house_id = Number($("house_id").value);
  o.serial = $("serial").value === "" ? null : Number($("serial").value);
  return o;
}

function updatePreview() {
  const b = readForm();
  const c0 = calcBooking(b);
  if (!state.gstTouched) {
    const s = suggestGstPct(b.tariff, c0.nights);
    if (s !== null) { $("gst_pct").value = s; b.gst_pct = s; }
  }
  const c = calcBooking(b);
  EXTRAS.forEach((k) => {
    const x = state.extras[k], days = b[`${k}_days`];
    $(`o_${k}`).textContent = formatINR(b[k]);
    $(`l_${k}`).textContent = x.on ? `${formatINR(x.rate)} × ${days} day${days === 1 ? "" : "s"}` : "Amount";
  });
  const notes = [];
  const older = EXTRAS.filter((k) => state.extras[k].on && state.extras[k].rate !== state.rates[k]);
  if (older.length) notes.push(`Saved with an older rate: ${older.map((k) => `${EXTRA_LABEL[k]} ${formatINR(state.extras[k].rate)}/day`).join(", ")}. Set it to No and back to Yes to use today's rate.`);
  const tooMany = EXTRAS.filter((k) => c0.nights && b[`${k}_days`] > c0.nights + 1);
  if (tooMany.length) notes.push(`${tooMany.map((k) => EXTRA_LABEL[k]).join(" and ")}: more days than the ${c0.nights}-night stay. Check the number.`);
  $("extrasHint").textContent = notes.join(" ");
  $("extrasHint").className = `hint wide ${tooMany.length ? "warn" : ""}`;
  $("o_nights").textContent = c.nights;
  $("o_gst").textContent = formatINR(c.gstAmount);
  $("o_total_tariff").textContent = formatINR(c.totalTariff);
  $("o_gross").textContent = formatINR(c.grossTotal);
  $("o_balance").textContent = formatINR(c.totalBalance);
  $("o_balanced").innerHTML = c.totalBalanced ? `<span class="pill yes">Yes</span>` : `<span class="pill no">No</span>`;

  $("gstHint").textContent = c.nights && b.tariff
    ? `${formatINR(b.tariff / c.nights)} per night. Suggested GST ${suggestGstPct(b.tariff, c.nights)}% (₹1,000 or less: nil · up to ₹7,500: 5% · above: 18%). You can change it.`
    : "Enter the dates and tariff to see the per-night rate and suggested GST.";

  const parts = [`Collected ${formatINR(c.collected)} of ${formatINR(c.totalBalance)} due.`];
  if (!c.totalBalanced) parts.push(c.difference < 0 ? `Short by ${formatINR(-c.difference)}.` : `Over by ${formatINR(c.difference)}. Record the extra as Tips?`);
  if (b.cash_received && c.changeToReturn > 0) parts.push(`Change to return: ${formatINR(c.changeToReturn)}.`);
  if (b.cash_received && c.changeToReturn < 0) parts.push(`Cash received is ${formatINR(-c.changeToReturn)} less than cash paid + tips.`);
  $("balHint").textContent = parts.join(" ");
  $("balHint").className = `hint wide ${c.totalBalanced ? "" : "bad"}`;

  const sh = $("stayHint");
  if (b.check_in && b.check_out && c.nights === 0) { sh.textContent = "Check-out must be after check-in."; sh.className = "hint wide bad"; }
  else if (sh.dataset.overlap) { sh.textContent = sh.dataset.overlap; sh.className = "hint wide warn"; }
  else { sh.textContent = ""; sh.className = "hint wide"; }
}

FIELDS.forEach((f) => $(f).addEventListener("input", () => {
  if (["house_id", "check_in", "check_out", "booking_type"].includes(f)) { state.overlapAck = false; $("stayHint").dataset.overlap = ""; $("saveBtn").textContent = "Save booking"; }
  if (f === "check_in" || f === "check_out") followNights();
  updatePreview();
}));

// Days for an extra start at the number of nights and follow date changes
// until staff type their own number.
const stayNights = () => nightsBetween($("check_in").value, $("check_out").value);
function followNights() {
  const n = stayNights();
  if (!n) return;
  EXTRAS.forEach((k) => { if (state.extras[k].on && state.extras[k].auto) $(`${k}_days`).value = n; });
}
$("gst_pct").addEventListener("input", () => (state.gstTouched = true));

// Yes locks in today's rate per day and fills Days with the nights; No clears it.
function setExtraOn(k, on, days, rate) {
  const x = state.extras[k];
  x.on = on;
  x.rate = on ? rate : 0;
  $(`${k}_yn`).value = on ? "yes" : "no";
  $(`${k}_days`).disabled = !on;
  $(`${k}_days`).value = on ? days : "";
}
EXTRAS.forEach((k) => {
  $(`${k}_yn`).addEventListener("change", (e) => {
    state.extras[k].auto = true;
    setExtraOn(k, e.target.value === "yes", stayNights() || 1, state.rates[k]);
    updatePreview();
  });
  $(`${k}_days`).addEventListener("input", () => { state.extras[k].auto = false; updatePreview(); });
});
function setExtrasFrom(b) {
  EXTRAS.forEach((k) => {
    const amount = b ? num(b[k]) : 0;
    const days = b ? Math.floor(num(b[`${k}_days`])) || (amount > 0 ? 1 : 0) : 0;
    state.extras[k].auto = !b || days === b.nights;
    setExtraOn(k, amount > 0, days, extraRate(amount, days));
  });
}

async function suggestSerial() {
  const { data } = await sb.from("bookings").select("serial").order("serial", { ascending: false }).limit(1);
  return (data?.[0]?.serial ?? 0) + 1;
}

// prefill (new bookings only): { house_id, check_in, check_out } from the Availability grid
async function openSheet(b = null, prefill = null) {
  state.editing = b;
  state.overlapAck = false;
  show("formErr", false);
  $("stayHint").dataset.overlap = "";
  $("sheetTitle").textContent = b ? `Booking #${b.serial}` : "New booking";
  $("saveBtn").textContent = "Save booking";
  FIELDS.forEach((f) => ($(f).value = b ? b[f] ?? "" : ""));
  setExtrasFrom(b);
  if (b) {
    MONEY.forEach((f) => { if (f !== "gst_pct" && !num(b[f])) $(f).value = ""; });
    if (b.booking_type && !BOOKING_TYPES.includes(b.booking_type)) {
      $("booking_type").insertAdjacentHTML("beforeend", `<option>${esc(b.booking_type)}</option>`);
      $("booking_type").value = b.booking_type;
    }
  } else {
    $("house_id").value = prefill?.house_id || $("fHouse").value || state.houses[0]?.id || 1;
    $("booking_type").value = BOOKING_TYPES[0];
    $("check_in").value = prefill?.check_in || todayISO();
    if (prefill?.check_out) $("check_out").value = prefill.check_out;
  }
  state.gstTouched = !!b;
  show("billBtn", !!b);
  const del = $("deleteBtn");
  show(del, !!b && isOwner());
  del.classList.remove("armed");
  del.textContent = "Delete booking";
  $("metaLine").textContent = b ? `Last changed ${new Date(b.updated_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}` : "";
  updatePreview();
  show("sheet");
  if (!b) $("serial").value = await suggestSerial();
  $("guest_name").focus();
}

function closeSheet() { show("sheet", false); state.editing = null; }
$("newBtn").addEventListener("click", () => openSheet(null));
document.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", closeSheet));
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("billView").hidden) closeBill();
  else if (!$("sheet").hidden) closeSheet();
  else if (!$("perfSheet").hidden) closePerf();
});

function formError(msg) { const e = $("formErr"); e.textContent = msg; show(e); e.scrollIntoView({ block: "nearest" }); }

async function findOverlap(b) {
  let q = sb.from("bookings").select("serial,guest_name,check_in,check_out")
    .eq("house_id", b.house_id).lt("check_in", b.check_out).gt("check_out", b.check_in).limit(1);
  if (state.editing) q = q.neq("id", state.editing.id);
  const { data } = await q;
  return data?.[0] ?? null;
}

$("saveBtn").addEventListener("click", async () => {
  show("formErr", false);
  const b = readForm();
  const c = calcBooking(b);
  if (!b.guest_name) return formError("Enter the guest name.");
  if (!b.check_in || !b.check_out) return formError("Enter both check-in and check-out dates.");
  if (c.nights < 1) return formError("Check-out must be at least one day after check-in.");
  if (state.editing && b.serial === null) return formError("Enter the Serial No.");
  if (b.serial !== null && (!Number.isInteger(b.serial) || b.serial < 1)) return formError("Serial No. must be a whole number like 1, 2, 3.");
  if (MONEY.some((f) => b[f] < 0)) return formError("Amounts can't be negative.");
  const noDays = EXTRAS.find((k) => state.extras[k].on && b[`${k}_days`] < 1);
  if (noDays) return formError(`Enter how many days ${EXTRA_LABEL[noDays]} was used, or set it to No.`);
  if (b.gst_pct > 28) return formError("GST % can't be more than 28.");

  const btn = $("saveBtn");
  btn.disabled = true;
  try {
    if (!state.overlapAck) {
      const clash = await findOverlap(b);
      const shut = closureClash(state.closures, b);
      if (clash || shut) {
        const msgs = [];
        if (clash) msgs.push(`${houseName(b.house_id)} is already booked for #${clash.serial} ${clash.guest_name} (${formatDate(clash.check_in)} → ${formatDate(clash.check_out)}).`);
        if (shut) msgs.push(`${closureLabel(shut)}: ${closureWho(shut)}, ${formatDate(shut.start_date)} → ${formatDate(shut.end_date)}${shut.note ? ` (${shut.note})` : ""}.`);
        const msg = `${msgs.join(" ")} Tap "Save anyway" if this is correct.`;
        $("stayHint").dataset.overlap = msg;
        state.overlapAck = true;
        btn.textContent = "Save anyway";
        updatePreview();
        $("stayHint").scrollIntoView({ block: "center" });
        return;
      }
    }
    const { error } = state.editing
      ? await sb.from("bookings").update(b).eq("id", state.editing.id)
      : await sb.from("bookings").insert(b);
    if (error) {
      if (error.code === "23505") return formError(`Serial No. ${b.serial} is already used. Use ${await suggestSerial()} instead.`);
      if (error.code === "42501") return formError("Your login isn't allowed to make this change. Ask the owner.");
      if (/guest_phone/.test(error.message)) return formError("The database needs a small update for guest phone numbers. Ask the owner to run supabase/migrations/010_guest_phone.sql in Supabase (SQL Editor).");
      if (/_days/.test(error.message)) return formError("The database needs a small update for per-day extras. Ask the owner to run supabase/migrations/005_extra_days.sql in Supabase (SQL Editor).");
      return formError(navigator.onLine ? `Couldn't save: ${error.message}` : "You're offline, so the booking wasn't saved. Try again when you're connected.");
    }
    const wasEdit = !!state.editing;
    closeSheet();
    toast(wasEdit ? "Booking updated" : "Booking saved");
    reloadAll();
  } finally {
    btn.disabled = false;
  }
});

// ════════════════════════════ Guest bill ════════════════════════════
// The bill is built from the saved booking, so unsaved edits must be saved first.
function formMatchesSaved() {
  const f = readForm(), s = state.editing;
  return [...MONEY, ...EXTRAS, ...EXTRAS.map((k) => `${k}_days`)].every((k) => num(f[k]) === num(s[k]))
    && TEXT.every((k) => f[k] === String(s[k] ?? "").trim())
    && f.house_id === s.house_id && f.serial === s.serial;
}

$("billBtn").addEventListener("click", async () => {
  show("formErr", false);
  if (!formMatchesSaved()) return formError("Save your changes first, then print the bill.");
  const btn = $("billBtn");
  btn.disabled = true;
  try {
    let b = state.editing;
    if (!b.bill_no) {
      const { data, error } = await sb.rpc("assign_bill_no", { p_booking: b.id });
      if (error) {
        return formError(/assign_bill_no|function|schema cache/i.test(error.message)
          ? "Bills aren't set up yet. The owner needs to run supabase/migrations/003_guest_bill.sql in Supabase (SQL Editor)."
          : navigator.onLine ? `Couldn't give this bill a number: ${error.message}` : "You're offline. Connect to the internet to print a bill.");
      }
      b = state.editing = { ...b, bill_no: data };
      $("bill_no").value = data;
    }
    openBill(b);
  } finally {
    btn.disabled = false;
  }
});

let titleBeforeBill = document.title;
const billBiz = () => ({ ...state.business, legal_name: state.business.legal_name || BUSINESS_NAME });
function openBill(b) {
  const biz = billBiz();
  $("billDoc").innerHTML = billHTML(b, biz, houseName(b.house_id));
  state.billBooking = b;
  state.billPdf = null;
  // Becomes the suggested file name when saving as PDF.
  titleBeforeBill = document.title;
  document.title = `Bill ${b.bill_no.replace(/\//g, "-")} ${b.guest_name}`;
  show("billView");
  $("billPrintBtn").focus();
}
function closeBill() {
  show("billView", false);
  show("waPanel", false);
  $("billWaBtn").setAttribute("aria-expanded", "false");
  state.billPdf = null;
  document.title = titleBeforeBill;
}
$("billCloseBtn").addEventListener("click", closeBill);
$("billPrintBtn").addEventListener("click", () => window.print());

// ── Send the bill on WhatsApp ──
// Step 1 opens the guest's chat (wa.me) with a short message; step 2 shares the
// bill as a PDF (phones: share sheet → WhatsApp; computers: the PDF downloads).
// WhatsApp can't attach a file through a link, hence the two steps.
const HTML_TO_IMAGE = "https://cdn.jsdelivr.net/npm/html-to-image@1.11.13/dist/html-to-image.js";
let htmlToImageReady = null;
function loadHtmlToImage() {
  return (htmlToImageReady ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = HTML_TO_IMAGE; s.crossOrigin = "anonymous";
    s.onload = () => (window.htmlToImage ? resolve(window.htmlToImage) : reject(new Error("not loaded")));
    s.onerror = () => { htmlToImageReady = null; reject(new Error("not loaded")); };
    document.head.appendChild(s);
  }));
}
// Photograph a full-width copy of the bill and wrap it in a one-page A4 PDF.
async function makeBillPdf(b) {
  const lib = await loadHtmlToImage();
  const host = document.createElement("div");
  host.className = "bill-capture";
  host.setAttribute("aria-hidden", "true");
  host.innerHTML = billHTML(b, billBiz(), houseName(b.house_id));
  document.body.appendChild(host);
  try {
    const doc = host.firstElementChild;
    await Promise.all([...doc.querySelectorAll("img")].map((im) => (im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; }))));
    const opts = { pixelRatio: 2, backgroundColor: "#ffffff", skipFonts: true, quality: 0.92 };
    await lib.toJpeg(doc, opts); // Safari sometimes leaves images out of the first picture
    const dataUrl = await lib.toJpeg(doc, opts);
    const bytes = Uint8Array.from(atob(dataUrl.split(",")[1]), (ch) => ch.charCodeAt(0));
    const w = Math.round(doc.offsetWidth * 2), h = Math.round(doc.offsetHeight * 2);
    return new File([jpegToPdf(bytes, w, h)], billFileName(b), { type: "application/pdf" });
  } finally {
    host.remove();
  }
}
const canShareFiles = () => {
  try { return !!navigator.canShare?.({ files: [new File(["x"], "x.pdf", { type: "application/pdf" })] }); } catch { return false; }
};
$("billWaBtn").addEventListener("click", () => {
  const open = $("waPanel").hidden;
  show("waPanel", open);
  $("billWaBtn").setAttribute("aria-expanded", String(open));
  if (!open) return;
  const b = state.billBooking;
  $("waPhone").value = b.guest_phone || "";
  $("waPdfLabel").textContent = canShareFiles() ? "Send the bill PDF" : "Download the bill PDF";
  $("waHint").textContent = canShareFiles()
    ? "Step 1 opens the guest's chat with a short message about the bill. Then come back and tap step 2, and choose the same chat in WhatsApp to attach the PDF."
    : "Step 1 opens the guest's chat in WhatsApp with a short message about the bill. Step 2 downloads the PDF: drag it into that chat to send it.";
  // Make the PDF now, so step 2 can share it straight away (phones only allow sharing right after a tap).
  state.billPdf ||= makeBillPdf(b).catch((e) => { state.billPdf = null; throw e; });
  state.billPdf.catch(() => {});
  if (!b.guest_phone) $("waPhone").focus();
});
$("waChatBtn").addEventListener("click", async () => {
  const b = state.billBooking;
  const raw = $("waPhone").value.trim();
  const phone = waPhone(raw);
  if (!phone) { toast("Enter the guest's mobile number, e.g. 98765 43210"); $("waPhone").focus(); return; }
  window.open(waLink(phone, billMessage(b, billBiz().legal_name, houseName(b.house_id))), "_blank", "noopener");
  // Remember a new or corrected number on the booking (quietly; the chat opens either way).
  if (raw !== (b.guest_phone || "")) {
    const { error } = await sb.from("bookings").update({ guest_phone: raw }).eq("id", b.id);
    if (!error) { b.guest_phone = raw; if (state.editing?.id === b.id) { state.editing.guest_phone = raw; $("guest_phone").value = raw; } }
  }
});
$("waPdfBtn").addEventListener("click", async () => {
  const btn = $("waPdfBtn");
  btn.disabled = true;
  try {
    let file;
    try { file = await (state.billPdf ||= makeBillPdf(state.billBooking)); }
    catch { state.billPdf = null; toast(navigator.onLine ? "Couldn't make the PDF. Use Print / Save PDF instead." : "You're offline. Connect once to make PDFs, or use Print / Save PDF."); return; }
    if (canShareFiles()) {
      try { await navigator.share({ files: [file], title: file.name }); }
      catch (e) { if (e?.name !== "AbortError") toast("Couldn't open sharing. Try again, or use Print / Save PDF."); }
    } else {
      const url = URL.createObjectURL(file);
      const a = Object.assign(document.createElement("a"), { href: url, download: file.name });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast(`${file.name} downloaded. Drag it into the WhatsApp chat.`);
    }
  } finally {
    btn.disabled = false;
  }
});

$("deleteBtn").addEventListener("click", async () => {
  const btn = $("deleteBtn");
  if (!btn.classList.contains("armed")) {
    btn.classList.add("armed");
    btn.textContent = "Tap again to delete";
    setTimeout(() => { btn.classList.remove("armed"); btn.textContent = "Delete booking"; }, 4000);
    return;
  }
  const { error } = await sb.from("bookings").delete().eq("id", state.editing.id);
  if (error) return formError("Couldn't delete this booking. Only the owner can delete.");
  closeSheet();
  toast("Booking deleted");
  reloadAll();
});

// ════════════════════════════ Settings (owner) ════════════════════════════
async function renderSettings() {
  // Keep what the owner is typing if a live update arrives mid-edit.
  if (!$("housesForm").contains(document.activeElement)) {
    $("houseInputs").innerHTML = state.houses.map((h) => {
      const col = houseColour(h);
      return `<div class="house-edit">
        <div class="f"><label for="hn${h.id}">Apartment ${h.id}</label><input id="hn${h.id}" data-house="${h.id}" type="text" maxlength="40" value="${esc(h.name)}"></div>
        <div class="f"><label for="hc${h.id}">Colour</label>
          <div class="colour-pick"><span class="swatch c-${col}" id="hs${h.id}"></span>
          <select id="hc${h.id}" data-colour="${h.id}">${COLOURS.map((c) => `<option value="${c}" ${c === col ? "selected" : ""}>${COLOUR_NAMES[c]}</option>`).join("")}</select></div>
        </div>
      </div>`;
    }).join("");
  }

  // Don't overwrite a rate the owner is in the middle of typing.
  EXTRAS.forEach((k) => { if (document.activeElement !== $(`rate_${k}`)) $(`rate_${k}`).value = state.rates[k]; });
  if (!state.ratesLoaded) {
    $("ratesErr").textContent = "The charges table isn't set up yet. Run supabase/migrations/002_extra_charges.sql in Supabase (SQL Editor) to save your own rates. Until then the app uses ₹500 for Extra Bed, ₹600 for Firewood and ₹500 for Gas.";
    show("ratesErr");
  } else show("ratesErr", false);

  // Performance targets and commission rates
  if (!$("targetsForm").contains(document.activeElement)) {
    Object.keys(DEFAULT_TARGETS).forEach((k) => ($(`t_${k}`).value = state.targets[k]));
    $("commissionInputs").innerHTML = BOOKING_TYPES.map((t, i) =>
      `<div class="f"><label for="cm${i}">${esc(t)}</label><input id="cm${i}" data-ctype="${esc(t)}" type="number" min="0" max="50" step="0.5" inputmode="decimal" value="${commissionFor(t, state.settingsMap)}"></div>`).join("");
  }

  renderClosedDates();

  if (!$("bizForm").contains(document.activeElement)) BIZ_FIELDS.forEach((k) => ($(`biz_${k}`).value = state.business[k]));
  if (!state.businessLoaded) {
    $("bizErr").textContent = "Bill details aren't set up yet. Run supabase/migrations/003_guest_bill.sql in Supabase (SQL Editor), then reopen the app.";
    show("bizErr");
  } else show("bizErr", false);
  updateBizHint();
  showSignature();

  const { data: people, error } = await sb.from("profiles").select("*").order("created_at");
  if (error) return;
  $("staffList").innerHTML = people.map((p) => `
    <div class="staff-row" data-user="${p.id}">
      <div class="nm">${esc(p.full_name || p.email)}<small>${esc(p.email)}${p.id === state.profile.id ? " · you" : ""}</small></div>
      <select data-role aria-label="Role for ${esc(p.email)}">
        <option value="staff" ${p.role === "staff" ? "selected" : ""}>Staff</option>
        <option value="owner" ${p.role === "owner" ? "selected" : ""}>Owner</option>
      </select>
      <label><input type="checkbox" data-active ${p.active ? "checked" : ""}> Can sign in</label>
    </div>`).join("");
}

// ── Closed dates (Settings) ──
function renderClosedDates() {
  if (!$("closedForm").contains(document.activeElement)) {
    const keep = $("cl_house").value;
    $("cl_house").innerHTML = `<option value="">All apartments</option>` + state.houses.map((h) => `<option value="${h.id}">${esc(h.name)}</option>`).join("");
    $("cl_house").value = keep;
  }
  const today = todayISO();
  const list = (state.closures || []).filter((c) => c.end_date > today);
  $("closedList").innerHTML = list.length
    ? list.map((c) => `<div class="staff-row"><div class="nm"><b>${esc(closureWho(c))}: ${formatDate(c.start_date)} → ${formatDate(c.end_date)}</b><small>${esc(closureLabel(c))}${c.note ? ` · ${esc(c.note)}` : ""}</small></div><button class="btn ghost small" type="button" data-unclose="${esc(c.id)}">Remove</button></div>`).join("")
    : `<p class="muted small">No closed dates coming up.</p>`;
}
$("closedList").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-unclose]");
  if (!btn) return;
  const c = (state.closures || []).find((x) => x.id === btn.dataset.unclose);
  if (!c || !confirm(`Remove ${closureLabel(c).toLowerCase()} for ${closureWho(c)}, ${formatDate(c.start_date)} → ${formatDate(c.end_date)}?`)) return;
  const { error } = await sb.from("closed_dates").delete().eq("id", c.id);
  if (error) { toast("Couldn't remove it. Check your connection."); return; }
  await loadClosures(); renderClosedDates(); renderCalendar();
  toast("Closed dates removed");
});
$("closedForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  show("closedErr", false);
  const err = (m) => { $("closedErr").textContent = m; show("closedErr"); };
  const start = $("cl_start").value, end = $("cl_end").value;
  if (!start || !end) return err("Enter the first night closed and the date it opens again.");
  if (end <= start) return err("The open-again date must be after the first night closed.");
  const row = { house_id: $("cl_house").value ? Number($("cl_house").value) : null, start_date: start, end_date: end, direct_only: $("cl_direct").checked, note: $("cl_note").value.trim() };
  const { error } = await sb.from("closed_dates").insert(row);
  if (error) return err(/closed_dates/.test(error.message) ? "Closed dates aren't set up yet. Run supabase/migrations/009_diary_import.sql in Supabase (SQL Editor)." : "Couldn't save. Check your connection.");
  ["cl_start", "cl_end", "cl_note"].forEach((id) => ($(id).value = ""));
  $("cl_direct").checked = false;
  await loadClosures(); renderClosedDates(); renderCalendar();
  toast("Closed dates added");
});

$("housesForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  show("housesErr", false);
  const inputs = [...document.querySelectorAll("[data-house]")];
  let colourMissing = false;
  for (const inp of inputs) {
    const id = Number(inp.dataset.house);
    const h = state.houses.find((x) => x.id === id);
    const name = inp.value.trim() || `Apartment ${id}`;
    const color = $(`hc${id}`).value;
    const patch = {};
    if (name !== h?.name) patch.name = name;
    if (color !== (h?.color || "")) patch.color = color;
    if (!Object.keys(patch).length) continue;
    let { error } = await sb.from("houses").update(patch).eq("id", id);
    if (error && /color/.test(error.message)) {
      // Colour column not added yet: save the name anyway.
      colourMissing = true;
      delete patch.color;
      error = Object.keys(patch).length ? (await sb.from("houses").update(patch).eq("id", id)).error : null;
    }
    if (error) { $("housesErr").textContent = "Couldn't save the apartments. Check your connection and try again."; show("housesErr"); return; }
  }
  if (colourMissing) {
    $("housesErr").textContent = "Names saved. To save colours, run supabase/migrations/006_house_colours.sql in Supabase (SQL Editor) once.";
    show("housesErr");
  } else toast("Apartments saved");
  document.activeElement?.blur();
  reloadAll();
});
$("houseInputs").addEventListener("change", (e) => {
  const sel = e.target.closest("[data-colour]");
  if (sel) $(`hs${sel.dataset.colour}`).className = `swatch c-${sel.value}`;
});

$("targetsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  show("targetsErr", false);
  const err = (m) => { $("targetsErr").textContent = m; show("targetsErr"); };
  const v = (id) => Number($(id).value);
  const t = { occupancy: v("t_occupancy"), adr: v("t_adr"), direct: v("t_direct"), alos: v("t_alos"), margin: v("t_margin") };
  if (!(t.occupancy >= 1 && t.occupancy <= 100)) return err("Enter an occupancy target between 1 and 100%.");
  if (!(t.adr >= 0)) return err("Enter a room rate target of 0 or more (0 = compare with your 12-month average).");
  if (!(t.direct >= 0 && t.direct <= 100)) return err("Enter a direct bookings target between 0 and 100%.");
  if (!(t.alos >= 1 && t.alos <= 30)) return err("Enter an average stay target between 1 and 30 nights.");
  if (!(t.margin >= 0 && t.margin <= 100)) return err("Enter a profit margin target between 0 and 100%.");
  const now = new Date().toISOString();
  const rows = Object.entries(t).map(([k, value]) => ({ key: `target_${k}`, value, updated_at: now }));
  for (const inp of document.querySelectorAll("[data-ctype]")) {
    const value = Number(inp.value);
    if (inp.value === "" || !(value >= 0 && value <= 50)) return err(`Enter a commission between 0 and 50% for ${inp.dataset.ctype}.`);
    rows.push({ key: commissionKey(inp.dataset.ctype), value, updated_at: now });
  }
  const { error } = await sb.from("settings").upsert(rows);
  if (error) return err(/settings|relation|schema cache/i.test(error.message)
    ? "The settings table isn't set up yet. Run supabase/migrations/002_extra_charges.sql in Supabase (SQL Editor), then try again."
    : "Couldn't save the targets. Check your connection and try again.");
  document.activeElement?.blur();
  toast("Targets saved");
  reloadAll();
});

$("ratesForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  show("ratesErr", false);
  const rows = [];
  for (const k of EXTRAS) {
    const v = $(`rate_${k}`).value.trim();
    if (v === "" || !(Number(v) >= 0)) {
      $("ratesErr").textContent = `Enter an amount of 0 or more for ${EXTRA_LABEL[k]}.`;
      show("ratesErr");
      return;
    }
    rows.push({ key: `${k}_rate`, value: Number(v), updated_at: new Date().toISOString() });
  }
  const { error } = await sb.from("settings").upsert(rows);
  if (error) {
    $("ratesErr").textContent = /settings|relation|schema cache/i.test(error.message)
      ? "The charges table isn't set up yet. Run supabase/migrations/002_extra_charges.sql in Supabase (SQL Editor), then try again."
      : "Couldn't save the charges. Check your connection and try again.";
    show("ratesErr");
    return;
  }
  toast("Charges saved");
  reloadAll();
});

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function updateBizHint() {
  const p = $("biz_invoice_prefix").value.trim().toUpperCase();
  const d = new Date();
  const fy = d.getFullYear() - (d.getMonth() < 3 ? 1 : 0);
  const n = `${p ? p + "/" : ""}${String(fy % 100).padStart(2, "0")}-${String((fy + 1) % 100).padStart(2, "0")}/`;
  $("bizHint").textContent = `Bills are numbered ${n}0001, ${n}0002 and so on, starting again each April.`;
}
$("biz_invoice_prefix").addEventListener("input", updateBizHint);

// ── signature ──
function showSignature() {
  const sig = state.sigDraft ?? state.business.signature;
  $("sigPreview").src = sig || "";
  show("sigPreview", !!sig);
  show("sigNone", !sig);
  show("sigRemove", !!sig);
}

/** Crop a signature photo to its ink, make the paper transparent and keep it small. Resolves to a PNG data URL. */
function prepareSignature(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error("That file isn't a picture this phone can open. Try a JPG or PNG.")); };
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      const scale = Math.min(1, 1600 / img.width);
      const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      const px = ctx.getImageData(0, 0, w, h), d = px.data;
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let i = 0; i < d.length; i += 4) {
        // Light paper fades out, ink stays; in between is the pen's soft edge.
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const a = Math.round(Math.max(0, Math.min(1, (200 - lum) / 90)) * (d[i + 3] / 255) * 255);
        d[i + 3] = a;
        if (a > 60) {
          const p = i / 4, x = p % w, y = (p - x) / w;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      if (x1 < 0) return reject(new Error("Couldn't find a signature in that picture. Use dark ink on white paper."));
      ctx.putImageData(px, 0, 0);
      const pad = 6;
      x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
      x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
      const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
      const k = Math.min(1, 600 / cw, 200 / ch);
      const out = document.createElement("canvas");
      out.width = Math.round(cw * k); out.height = Math.round(ch * k);
      out.getContext("2d").drawImage(c, x0, y0, cw, ch, 0, 0, out.width, out.height);
      resolve(out.toDataURL("image/png"));
    };
    img.src = URL.createObjectURL(file);
  });
}

$("sigFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  show("bizErr", false);
  try {
    state.sigDraft = await prepareSignature(file);
    showSignature();
  } catch (err) {
    $("bizErr").textContent = err.message;
    show("bizErr");
  }
});
$("sigRemove").addEventListener("click", () => { state.sigDraft = ""; showSignature(); });

$("bizForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  show("bizErr", false);
  const row = { id: 1, updated_at: new Date().toISOString() };
  BIZ_FIELDS.forEach((k) => (row[k] = $(`biz_${k}`).value.trim()));
  // Only send the signature when it changed, so the rest still saves before migration 004 is run.
  if (state.sigDraft !== null) row.signature = state.sigDraft;
  row.gstin = row.gstin.toUpperCase().replace(/\s/g, "");
  row.invoice_prefix = row.invoice_prefix.toUpperCase();
  const fail = (msg) => { $("bizErr").textContent = msg; show("bizErr"); };
  if (row.gstin && !GSTIN_RE.test(row.gstin)) return fail("That GSTIN doesn't look right. It has 15 characters, like 32ABCDE1234F1Z5.");
  if (!/^[A-Z0-9]{0,5}$/.test(row.invoice_prefix)) return fail("Use up to 5 letters or numbers for the bill number prefix.");
  const { error } = await sb.from("business_profile").upsert(row);
  if (error) {
    return fail(/signature/i.test(error.message)
      ? "Signatures aren't set up yet. Run supabase/migrations/004_bill_signature.sql in Supabase (SQL Editor), then try again."
      : /business_profile|relation|schema cache/i.test(error.message)
      ? "Bill details aren't set up yet. Run supabase/migrations/003_guest_bill.sql in Supabase (SQL Editor), then try again."
      : "Couldn't save the bill details. Check your connection and try again.");
  }
  state.sigDraft = null;
  document.activeElement?.blur();
  toast("Bill details saved");
  reloadAll();
});

$("staffList").addEventListener("change", async (e) => {
  const row = e.target.closest("[data-user]");
  if (!row) return;
  show("staffErr", false);
  const patch = e.target.matches("[data-role]") ? { role: e.target.value } : { active: e.target.checked };
  const { error } = await sb.from("profiles").update(patch).eq("id", row.dataset.user);
  if (error) {
    $("staffErr").textContent = /owner/i.test(error.message) ? "There must always be at least one owner who can sign in." : "Couldn't update this person. Try again.";
    show("staffErr");
  } else toast("Staff updated");
  renderSettings();
});

// ── start ──
const { data: { session } } = await sb.auth.getSession();
if (!session) show("loginView");
