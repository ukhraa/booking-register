// Expenses: pure helpers for the monthly sheet. Daily entries roll up into
// their line on the month they were spent.
import { num, r2 } from "./calc.js";

/**
 * The monthly sheet for `ym` (YYYY-MM).
 * categories: [{id, name, monthly, daily, sort_order, active}]
 * monthly:    [{category_id, ym, amount, note}]
 * daily:      [{category_id, spent_on, amount}]
 * Returns rows in sheet order with { monthly, daily, total, entries } and the grand totals.
 */
export function monthSheet(categories, monthly, daily, ym) {
  const m = new Map(monthly.filter((r) => r.ym === ym).map((r) => [r.category_id, r]));
  const d = new Map();
  for (const r of daily) {
    if (String(r.spent_on).slice(0, 7) !== ym) continue;
    const x = d.get(r.category_id) || { sum: 0, entries: 0 };
    x.sum += num(r.amount); x.entries++;
    d.set(r.category_id, x);
  }
  const rows = [...categories]
    .filter((c) => c.active !== false || m.has(c.id) || d.has(c.id)) // a retired line still shows if it has money
    .sort((a, b) => (a.sort_order ?? 100) - (b.sort_order ?? 100) || String(a.name).localeCompare(b.name))
    .map((c) => {
      const mon = num(m.get(c.id)?.amount);
      const day = r2(d.get(c.id)?.sum || 0);
      return { category: c, monthly: mon, note: m.get(c.id)?.note || "", daily: day, entries: d.get(c.id)?.entries || 0, total: r2(mon + day), editable: !!c.monthly };
    });
  const totals = {
    monthly: r2(rows.reduce((s, r) => s + r.monthly, 0)),
    daily: r2(rows.reduce((s, r) => s + r.daily, 0)),
  };
  totals.total = r2(totals.monthly + totals.daily);
  return { rows, totals };
}

/** Total spent per day in a list of daily entries: { "YYYY-MM-DD": amount }. */
export function dayTotals(daily) {
  const out = {};
  for (const r of daily) out[r.spent_on] = r2((out[r.spent_on] || 0) + num(r.amount));
  return out;
}

/** Profit for a month: revenue (rooms + extras, before GST) minus expenses. */
export function monthProfit(revenue, expenses, nightsSold) {
  const profit = r2(num(revenue) - num(expenses));
  return {
    revenue: r2(num(revenue)), expenses: r2(num(expenses)), profit,
    margin: num(revenue) ? (profit / num(revenue)) * 100 : 0,
    costPerNight: nightsSold ? r2(num(expenses) / nightsSold) : 0,
  };
}

export function expensesCSV(sheet, ymLabel) {
  const q = (v) => { const s = String(v ?? ""); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [["Expense", "Monthly amount", "Daily entries", "Total", "Note"].join(",")];
  for (const r of sheet.rows) if (r.total || r.note) lines.push([r.category.name, r.monthly, r.daily, r.total, r.note].map(q).join(","));
  lines.push(["Total", sheet.totals.monthly, sheet.totals.daily, sheet.totals.total, ""].map(q).join(","));
  return `﻿${q(`Expenses ${ymLabel}`)}\r\n${lines.join("\r\n")}`;
}
