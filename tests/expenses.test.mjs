import { test } from "node:test";
import assert from "node:assert/strict";
import { monthSheet, dayTotals, monthProfit, expensesCSV } from "../js/expenses-calc.js";

const cats = [
  { id: 1, name: "Salaries", monthly: true, daily: false, sort_order: 1 },
  { id: 15, name: "Maintenance", monthly: true, daily: true, sort_order: 15 },
  { id: 50, name: "Kitchen", monthly: false, daily: true, sort_order: 50 },
  { id: 60, name: "Old line", monthly: true, daily: false, sort_order: 60, active: false },
];

test("daily entries add up into the month, alongside monthly amounts", () => {
  const monthly = [
    { category_id: 1, ym: "2026-10", amount: 45000 },
    { category_id: 15, ym: "2026-10", amount: 2000, note: "Plumber AMC" },
    { category_id: 1, ym: "2026-09", amount: 44000 },   // other month: ignored
  ];
  const daily = [
    { category_id: 50, spent_on: "2026-10-01", amount: 1250 },
    { category_id: 50, spent_on: "2026-10-02", amount: 830.5 },
    { category_id: 15, spent_on: "2026-10-05", amount: 600 },
    { category_id: 50, spent_on: "2026-11-01", amount: 999 }, // next month: ignored
  ];
  const s = monthSheet(cats, monthly, daily, "2026-10");
  assert.deepEqual(s.rows.map((r) => r.category.name), ["Salaries", "Maintenance", "Kitchen"]); // retired line with no money hidden
  const maint = s.rows[1];
  assert.equal(maint.monthly, 2000);
  assert.equal(maint.daily, 600);
  assert.equal(maint.total, 2600);
  assert.equal(maint.note, "Plumber AMC");
  const kitchen = s.rows[2];
  assert.equal(kitchen.editable, false);
  assert.equal(kitchen.daily, 2080.5);
  assert.equal(kitchen.entries, 2);
  assert.deepEqual(s.totals, { monthly: 47000, daily: 2680.5, total: 49680.5 });
});

test("a retired line still shows when it has money that month", () => {
  const s = monthSheet(cats, [{ category_id: 60, ym: "2026-10", amount: 100 }], [], "2026-10");
  assert.ok(s.rows.some((r) => r.category.id === 60));
});

test("day totals and profit", () => {
  assert.deepEqual(dayTotals([{ spent_on: "2026-10-01", amount: 100 }, { spent_on: "2026-10-01", amount: 50.25 }, { spent_on: "2026-10-02", amount: 10 }]),
    { "2026-10-01": 150.25, "2026-10-02": 10 });
  const p = monthProfit(500000, 200000, 120);
  assert.equal(p.profit, 300000);
  assert.equal(p.margin, 60);
  assert.equal(Math.round(p.costPerNight), 1667);
  assert.equal(monthProfit(0, 1000, 0).margin, 0);
});

test("CSV lists lines with money and a total", () => {
  const s = monthSheet(cats, [{ category_id: 1, ym: "2026-10", amount: 45000 }], [{ category_id: 50, spent_on: "2026-10-01", amount: 1250 }], "2026-10");
  const csv = expensesCSV(s, "October 2026").split("\r\n");
  assert.match(csv[2], /^Salaries,45000,0,45000,$/);
  assert.match(csv[3], /^Kitchen,0,1250,1250,$/);
  assert.match(csv.at(-1), /^Total,45000,1250,46250,$/);
});
