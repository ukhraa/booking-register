// Booking emails from AxisRooms (the channel manager) → bookings. Pure, tested in
// tests/ota-email.test.mjs. The Google helper copies each email's subject and
// plain text into ota_inbox; the app reads them with these functions.
import { num } from "./calc.js";

const LABELS = ["Booking Confirmation Number", "Hotel Name", "City", "Address", "Channel Name", "Booking Time", "Number Of Rooms",
  "Adults", "Children", "Booker Name", "Guest Name", "Room Name", "Check In", "Check Out", "Number Of Nights", "Number of Persons",
  "Meal Plan", "Smoking", "Policy", "Extra Info", "Daily Price Details", "Pricing Details", "Supplier Amount", "Total Tax",
  "Variable Tax", "Commission Amount", "Total Amount", "Payment Status", "Total Discount", "Hotel Details", "Booking Details",
  "Booker Details", "Special Request", "Remarks", "Email", "Phone", "Mobile", "Guest Email", "Guest Phone", "Booker Email", "Booker Phone"];
const isLabel = (s) => LABELS.some((l) => l.toLowerCase() === s.toLowerCase()) || /^Room \d+$/i.test(s) || /^Child \d+$/i.test(s);

/** dd/mm/yyyy → yyyy-mm-dd ("" if it isn't a date). */
export function dmy(s) {
  const m = String(s ?? "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : "";
}
const money = (s) => { const m = String(s ?? "").replace(/,/g, "").match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : 0; };

/** AxisRooms channel names → the app's booking types. */
export function channelType(name) {
  const n = String(name ?? "").toLowerCase();
  if (/airbnb/.test(n)) return "Airbnb";
  if (/booking\.?com/.test(n)) return "Booking.com";
  if (/makemytrip|mmt/.test(n)) return "MakeMyTrip";
  if (/goibibo/.test(n)) return "Goibibo";
  if (/agoda/.test(n)) return "Agoda";
  return "Other OTA";
}

/** booking, modification, cancellation or other, from the subject ("BOOKING on Booking.com [6972261224]"). */
export function emailKind(subject) {
  const s = String(subject ?? "");
  if (/cancel/i.test(s)) return "cancellation";
  if (/modif|amend|change/i.test(s)) return "modification";
  if (/booking|reservation/i.test(s)) return "booking";
  return "other";
}

/**
 * Read an AxisRooms booking email. Returns null when it isn't one.
 * Labels sit on their own line with the value on a following line; where a label
 * appears twice (Adults/Children: booking and room level) the last one wins.
 */
export function parseAxisRoomsEmail(subject, body) {
  const kind = emailKind(subject);
  const lines = String(body ?? "").replace(/ /g, " ").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const f = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const inline = line.match(/^Booking Confirmation Number\s*:\s*(\S+)/i);
    if (inline) { f["booking confirmation number"] = inline[1]; continue; }
    if (!isLabel(line)) continue;
    let j = i + 1;
    while (j < lines.length && /^NONE$/i.test(lines[j])) j++;          // "Guest Name / NONE / Name"
    if (j < lines.length && !isLabel(lines[j])) f[line.toLowerCase()] = lines[j];
  }
  const ref = f["booking confirmation number"] || (String(subject).match(/\[([^\]]+)\]/) || [])[1] || "";
  const checkIn = dmy(f["check in"]), checkOut = dmy(f["check out"]);
  if (!ref || (kind !== "cancellation" && (!checkIn || !checkOut))) return null;
  const guest = String(f["booker name"] || f["guest name"] || "").replace(/\s+Genius\s*$/i, "").replace(/\s+/g, " ").trim();
  return {
    kind, ref,
    channel: channelType(f["channel name"] || (String(subject).match(/ on (.+?) \[/) || [])[1]),
    channelName: f["channel name"] || "",
    bookedAt: f["booking time"] || "",
    guest, roomName: f["room name"] || "",
    checkIn, checkOut, nights: num(f["number of nights"]),
    adults: num(f["adults"]), children: num(f["children"]),
    supplier: money(f["supplier amount"]), tax: money(f["total tax"]), commission: money(f["commission amount"]),
    total: money(f["total amount"]), payment: f["payment status"] || "",
    phone: f["guest phone"] || f["booker phone"] || f["phone"] || f["mobile"] || "",
  };
}

/** Which apartment an OTA room name means: the apartment whose first word appears in it. */
export function matchHouse(roomName, houses) {
  const r = String(roomName ?? "").toLowerCase();
  const hits = houses.filter((h) => {
    const word = String(h.name).toLowerCase().split(/[\s(\-–]+/)[0];
    return word.length >= 3 && new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(r);
  });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Money for the booking row. The room tariff is before GST:
 *  • a "Total Tax" line: tariff = total − tax (Booking.com);
 *  • otherwise, when total is more than payout + commission, the difference is GST (Airbnb);
 *  • otherwise the total is taken as the tariff and GST is left at 0 for staff to check.
 * "OTA collect" (the guest paid the OTA) goes in Advance / Paid to OTA, so nothing is due at the desk.
 */
export function otaMoney(p) {
  const r2 = (n) => Math.round(n * 100) / 100;
  let tariff = p.total, gst = 0, gstKnown = true;
  if (p.tax > 0 && p.total > p.tax) { tariff = r2(p.total - p.tax); gst = Math.round((p.tax / tariff) * 100); }
  else if (p.supplier > 0 && p.commission > 0 && p.total > p.supplier + p.commission + 1) {
    tariff = r2(p.supplier + p.commission); gst = Math.round(((p.total - tariff) / tariff) * 100);
  } else gstKnown = false;
  if (![0, 5, 12, 18, 28].includes(gst)) gstKnown = false; // odd rate: let staff check
  const otaCollect = /ota\s*collect|prepaid|paid online|channel collect/i.test(p.payment);
  return { tariff, gst_pct: gstKnown ? gst : 0, gstKnown, advance_ota: otaCollect ? p.total : 0, ota_commission: p.commission, otaCollect };
}

/** The bookings row for a parsed email, or the reason it needs a person to look at it. */
export function otaBookingRow(p, houses) {
  const house = matchHouse(p.roomName, houses);
  const m = otaMoney(p);
  const fmt = (n) => `₹${Math.round(n).toLocaleString("en-IN")}`;
  const notes = [
    `From the ${p.channelName || p.channel} booking email (${p.ref})${p.bookedAt ? `, booked ${p.bookedAt}` : ""}.`,
    p.payment && `Payment: ${p.payment}.`,
    p.commission && `Commission ${fmt(p.commission)}${p.supplier ? `, payout ${fmt(p.supplier)}` : ""}.`,
    !m.gstKnown && "Check the GST % (not clear from the email).",
  ].filter(Boolean).join(" ");
  const row = {
    house_id: house?.id ?? null, booking_type: p.channel, guest_name: p.guest || "(no name)", guest_phone: p.phone || "",
    check_in: p.checkIn, check_out: p.checkOut, tariff: m.tariff, gst_pct: m.gst_pct, advance_ota: m.advance_ota,
    ota_commission: m.ota_commission, ota_ref: p.ref, adults: p.adults, children: p.children, notes,
  };
  return { row, problem: house ? "" : `Couldn't tell which apartment "${p.roomName}" is.` };
}
