import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY, BUSINESS_NAME, BOOKING_TYPES } from "./config.js";
import {
  calcBooking, suggestGstPct, formatINR, formatDate, todayISO, monthRange, toCSV, num, dayNumber,
  extraAmount, extraRate, nightsBetween, financialYear, reportPeriods, periodTotals,
} from "./calc.js";
import { billHTML } from "./bill.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const show = (el, on = true) => { (typeof el === "string" ? $(el) : el).hidden = !on; };

// ── service worker (makes the app installable and load offline) ──
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

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
  show("settingsTab", isOwner());
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
  for (const row of data) {
    const k = row.key.replace(/_rate$/, "");
    if (EXTRAS.includes(k)) state.rates[k] = num(row.value);
  }
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
    let q = sb.from("bookings").select("*").order("serial", { ascending: false }).range(from, from + pageSize - 1);
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

// Every booking in the current financial year, for the Totals table.
async function loadTotals() {
  const fy = financialYear(todayISO());
  const cols = "check_in,nights,gross_total,gst_amount,advance_ota,paid_cash,paid_upi";
  const pageSize = 1000;
  let rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await sb.from("bookings").select(cols)
      .gte("check_in", fy.start).lte("check_in", fy.end).order("check_in").range(from, from + pageSize - 1);
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
    month: [new Date(`${today}T00:00:00`).toLocaleDateString("en-IN", { month: "long" }), today.slice(0, 4)],
    year: [periods[2].label, "Apr – Mar"],
    ytd: ["Year to date", `${short(periods[3].start)} – ${short(today)}`],
  };
  const totals = periods.map((p) => periodTotals(state.fyRows || [], p.start, p.end));
  const ROWS = [
    ["Bookings", "bookings", false], ["Room nights", "nights", false], ["Gross total", "gross", true],
    ["GST", "gst", true], ["Advance / OTA", "advance", true], ["Balance after OTA", "afterOta", true],
    ["Cash", "cash", true], ["UPI", "upi", true],
  ];
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
try { const saved = localStorage.getItem("totalsCol"); if (/^[0-3]$/.test(saved || "")) pickTotalsCol(saved); } catch {}

async function reloadAll() {
  await Promise.all([loadHouses(), loadRates(), loadBusiness()]);
  buildHouseSelects();
  await Promise.all([loadBookings(), loadUpcoming(), loadTotals()]);
  renderTotals();
  renderToday();
  renderRegister();
  renderHouses();
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
    .on("postgres_changes", { event: "*", schema: "public", table: "business_profile" }, later)
    .subscribe();
  // Catch up when the phone wakes the app again.
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.profile) later(); });
}

// ════════════════════════════ Filters ════════════════════════════
function buildStaticSelects() {
  // Months: 18 back, 6 ahead
  const now = new Date();
  const opts = [];
  for (let i = 6; i >= -18; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    opts.push(`<option value="${ym}">${d.toLocaleDateString("en-IN", { month: "long", year: "numeric" })}</option>`);
  }
  $("fMonth").innerHTML = opts.join("") + `<option value="all">All months</option>`;
  $("fMonth").value = todayISO().slice(0, 7);
  $("fType").innerHTML = `<option value="">All booking types</option>` + BOOKING_TYPES.map((t) => `<option>${esc(t)}</option>`).join("");
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
    if (bal && (bal === "yes") !== b.total_balanced) return false;
    if (q && !`${b.guest_name} ${b.bill_no} ${b.notes} ${houseName(b.house_id)} ${b.serial}`.toLowerCase().includes(q)) return false;
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

function renderHouses() {
  const today = todayISO();
  const t = dayNumber(today);
  $("todayLabel").textContent = `· ${new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}`;
  $("houses").innerHTML = state.houses.map((h) => {
    const stays = state.upcoming.filter((b) => b.house_id === h.id);
    const now = stays.find((b) => dayNumber(b.check_in) <= t && dayNumber(b.check_out) > t);
    const next = stays.filter((b) => dayNumber(b.check_in) > t).slice(0, 3);
    return `<div class="house">
      <h3>${esc(h.name)}</h3>
      <span class="chip ${now ? "in" : "free"}">${now ? "Occupied tonight" : "Free tonight"}</span>
      <ul>
        ${now ? `<li><b>${esc(now.guest_name)}</b> · checks out ${formatDate(now.check_out)}</li>` : ""}
        ${next.map((b) => `<li>Next: <b>${esc(b.guest_name)}</b> · ${formatDate(b.check_in)} → ${formatDate(b.check_out)}</li>`).join("")}
        ${!now && !next.length ? "<li>No upcoming bookings</li>" : ""}
      </ul>
    </div>`;
  }).join("");
}

// ════════════════════════════ Tabs ════════════════════════════
// New booking is also in the bar, but it opens the form instead of switching section.
document.querySelectorAll(".tab[data-tab]").forEach((btn) => btn.addEventListener("click", () => {
  document.querySelectorAll(".tab[data-tab]").forEach((b) => b.removeAttribute("aria-current"));
  btn.setAttribute("aria-current", "page");
  ["summary", "register", "houses", "settings"].forEach((t) => show(`tab-${t}`, t === btn.dataset.tab));
  window.scrollTo({ top: 0 });
}));

// ════════════════════════════ Booking form ════════════════════════════
// Typed money fields. Extra Bed, Firewood and Gas (see EXTRAS) are Yes/No + Days;
// their amount is the rate per day from Settings × days.
const MONEY = ["tariff", "gst_pct", "food_bill", "advance_ota", "paid_cash", "cash_received", "tips", "paid_upi"];
const TEXT = ["booking_type", "guest_name", "check_in", "check_out", "bill_no", "notes"];
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
  if (["house_id", "check_in", "check_out"].includes(f)) { state.overlapAck = false; $("stayHint").dataset.overlap = ""; $("saveBtn").textContent = "Save booking"; }
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

async function openSheet(b = null) {
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
    $("house_id").value = $("fHouse").value || state.houses[0]?.id || 1;
    $("booking_type").value = BOOKING_TYPES[0];
    $("check_in").value = todayISO();
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
$("newBtn").addEventListener("click", () => openSheet());
document.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", closeSheet));
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("billView").hidden) closeBill();
  else if (!$("sheet").hidden) closeSheet();
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
      if (clash) {
        const msg = `${houseName(b.house_id)} is already booked for #${clash.serial} ${clash.guest_name} (${formatDate(clash.check_in)} → ${formatDate(clash.check_out)}). Tap "Save anyway" if this is correct.`;
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
function openBill(b) {
  const biz = { ...state.business, legal_name: state.business.legal_name || BUSINESS_NAME };
  $("billDoc").innerHTML = billHTML(b, biz, houseName(b.house_id));
  // Becomes the suggested file name when saving as PDF.
  titleBeforeBill = document.title;
  document.title = `Bill ${b.bill_no.replace(/\//g, "-")} ${b.guest_name}`;
  show("billView");
  $("billPrintBtn").focus();
}
function closeBill() {
  show("billView", false);
  document.title = titleBeforeBill;
}
$("billCloseBtn").addEventListener("click", closeBill);
$("billPrintBtn").addEventListener("click", () => window.print());

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
  $("houseInputs").innerHTML = state.houses.map((h) =>
    `<div class="f"><label for="hn${h.id}">Apartment ${h.id}</label><input id="hn${h.id}" data-house="${h.id}" type="text" maxlength="40" value="${esc(h.name)}"></div>`).join("");

  // Don't overwrite a rate the owner is in the middle of typing.
  EXTRAS.forEach((k) => { if (document.activeElement !== $(`rate_${k}`)) $(`rate_${k}`).value = state.rates[k]; });
  if (!state.ratesLoaded) {
    $("ratesErr").textContent = "The charges table isn't set up yet. Run supabase/migrations/002_extra_charges.sql in Supabase (SQL Editor) to save your own rates. Until then the app uses ₹500 for Extra Bed, ₹600 for Firewood and ₹500 for Gas.";
    show("ratesErr");
  } else show("ratesErr", false);

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

$("housesForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  show("housesErr", false);
  const inputs = [...document.querySelectorAll("[data-house]")];
  for (const inp of inputs) {
    const id = Number(inp.dataset.house);
    const name = inp.value.trim() || `Apartment ${id}`;
    if (name === houseName(id)) continue;
    const { error } = await sb.from("houses").update({ name }).eq("id", id);
    if (error) { $("housesErr").textContent = "Couldn't save the names. Check your connection and try again."; show("housesErr"); return; }
  }
  toast("Apartment names saved");
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
