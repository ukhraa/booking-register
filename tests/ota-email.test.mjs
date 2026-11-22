import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseAxisRoomsEmail, otaBookingRow, otaMoney, matchHouse, emailKind, channelType, dmy } from "../js/ota-email.js";

// Real AxisRooms emails with the guest names and booking numbers changed.
const airbnb = readFileSync(new URL("./fixtures/airbnb-booking.txt", import.meta.url), "utf8");
const bcom = readFileSync(new URL("./fixtures/bookingcom-booking.txt", import.meta.url), "utf8");
const houses = ["Bhoomi (3 Bed)", "Amazon (3 Bed)", "Nilgiri (2 Bed)", "Himalaya (2 Bed)", "Vismay (2 Bed)", "Venus - Suite"].map((name, i) => ({ id: i + 1, name }));

test("Booking.com email: pay at hotel, GST from the tax line", () => {
  const p = parseAxisRoomsEmail("BOOKING on Booking.com [1234567890]", bcom);
  assert.equal(p.kind, "booking");
  assert.equal(p.ref, "1234567890");
  assert.equal(p.channel, "Booking.com");
  assert.equal(p.guest, "Test Guest");
  assert.deepEqual([p.checkIn, p.checkOut, p.nights], ["2027-01-04", "2027-01-07", 3]);
  assert.deepEqual([p.adults, p.children], [2, 1]);
  assert.deepEqual([p.supplier, p.tax, p.commission, p.total], [12528, 720, 2592, 15120]);
  const { row, problem } = otaBookingRow(p, houses);
  assert.equal(problem, "");
  assert.equal(row.house_id, 6);                       // "Honeymoon Suite [Venus Suite …]"
  assert.deepEqual([row.tariff, row.gst_pct, row.advance_ota, row.ota_commission], [14400, 5, 0, 2592]);
  assert.match(row.notes, /Pay At Hotel/);
});

test("Airbnb email: OTA collect, GST worked out from payout + commission", () => {
  const p = parseAxisRoomsEmail("BOOKING on AirbnbNew [HMTEST0001]", airbnb);
  assert.equal(p.channel, "Airbnb");
  assert.equal(p.guest, "Asha Menon");
  assert.deepEqual([p.checkIn, p.checkOut, p.adults, p.children], ["2026-11-25", "2026-11-27", 4, 0]);
  const { row } = otaBookingRow(p, houses);
  assert.equal(row.house_id, 3);                       // Nilgiri
  assert.deepEqual([row.tariff, row.gst_pct, row.advance_ota], [12200, 5, 12810]);
});

test("helpers", () => {
  assert.equal(emailKind("CANCELLATION on Booking.com [1]"), "cancellation");
  assert.equal(emailKind("MODIFICATION on AirbnbNew [X]"), "modification");
  assert.equal(emailKind("Your invoice"), "other");
  assert.equal(channelType("MMT"), "MakeMyTrip");
  assert.equal(dmy("4/1/2027"), "2027-01-04");
  assert.equal(matchHouse("Deluxe room", houses), null);
  assert.equal(matchHouse("Three Bedroom - Amazon", houses).id, 2);
  const m = otaMoney({ total: 9000, tax: 0, supplier: 0, commission: 0, payment: "Pay At Hotel" });
  assert.deepEqual([m.tariff, m.gst_pct, m.gstKnown], [9000, 0, false]);
  assert.equal(parseAxisRoomsEmail("BOOKING on X [1]", "nothing useful"), null);
  // A cancellation needs only the booking number.
  assert.equal(parseAxisRoomsEmail("CANCELLATION on Booking.com [55]", "Booking Confirmation Number : 55").ref, "55");
});
