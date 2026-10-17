// Small SVG/HTML chart builders for the Performance tab. They return HTML strings.
// Colours come from CSS tokens (--s1, --s1-muted, --s2, --line, --muted) so both themes work.
// Every bar/point carries data-tip (shown by the shared tooltip in app.js) and
// every chart has a "Show the numbers" table next to it in the detail view.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Compact Indian axis ticks: 950, 5K, 1.2L */
export function compact(n, money = false) {
  const p = (n < 0 ? "−" : "") + (money ? "₹" : "");
  const a = Math.abs(n);
  if (a >= 100000) return `${p}${+(a / 100000).toFixed(a >= 1000000 ? 0 : 1)}L`;
  if (a >= 1000) return `${p}${+(a / 1000).toFixed(a >= 10000 ? 0 : 1)}K`;
  return `${p}${+a.toFixed(a % 1 ? 1 : 0)}`;
}

/** A "nice" axis max and 3 tick values. */
function niceScale(max) {
  if (!(max > 0)) return { max: 1, ticks: [0] };
  const raw = max / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw);
  const top = step * Math.ceil(max / step);
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(+v.toFixed(6));
  return { max: top, ticks };
}

const W = 360, PADL = 38, PADR = 10, PADT = 14, PADB = 22;

/**
 * Columns over time. points: [{label, value, tip, current}]
 * opts: { height, target, targetLabel, money, pct, stack: [{key,label,color}] }
 * With `stack`, each point has point.parts[key]; a legend is drawn.
 */
export function columns(points, opts = {}) {
  const H = opts.height || 170;
  const plotW = W - PADL - PADR, plotH = H - PADT - PADB;
  const totals = points.map((p) => (opts.stack ? opts.stack.reduce((s, k) => s + (p.parts?.[k.key] || 0), 0) : p.value));
  // Below-zero values (a loss-making month) get their own share of the axis.
  const lowest = Math.min(0, ...totals);
  const up = niceScale(Math.max(...totals, opts.target || 0, opts.pct ? 10 : 0, lowest < 0 ? 1 : 0));
  const down = lowest < 0 ? niceScale(-lowest) : { max: 0, ticks: [] };
  const max = up.max, min = -down.max;
  const ticks = [...down.ticks.filter((t) => t > 0).map((t) => -t).reverse(), ...up.ticks];
  const y = (v) => PADT + plotH - ((v - min) / (max - min)) * plotH;
  const band = plotW / points.length;
  const bw = Math.min(22, band * 0.62);
  const fmt = (v) => (opts.pct ? `${Math.round(v)}%` : compact(v, opts.money));

  let svg = ticks.map((t) => `<line class="grid" x1="${PADL}" x2="${W - PADR}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${PADL - 6}" y="${y(t) + 3.5}" text-anchor="end">${fmt(t)}</text>`).join("");
  points.forEach((p, i) => {
    const x = PADL + band * i + (band - bw) / 2;
    if (opts.stack) {
      let base = 0;
      const segs = opts.stack.filter((k) => (p.parts?.[k.key] || 0) > 0);
      segs.forEach((k, j) => {
        const v = p.parts[k.key];
        const top = j === segs.length - 1;
        const y0 = y(base), y1 = y(base + v);
        const h = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0)); // 2px surface gap between segments
        svg += barPath(x, y1, bw, h, top, `fill:var(${p.current ? k.color : k.muted})`);
        base += v;
      });
      svg += `<rect class="hit" x="${PADL + band * i}" y="${PADT}" width="${band}" height="${plotH}" data-tip="${esc(p.tip)}" tabindex="0"/>`;
    } else {
      if (p.value < 0) {
        // A loss: drawn downward from zero in the "critical" colour, rounded at its bottom end
        const h = y(p.value) - y(0);
        svg += barPathDown(x, y(0), bw, h, `fill:var(${p.current ? "--bad" : "--bad-soft"})`);
        if (p.current) svg += `<text class="val" x="${x + bw / 2}" y="${y(0) + h + 12}" text-anchor="middle">${esc(p.valueLabel ?? fmt(p.value))}</text>`;
      } else {
        const h = Math.max(p.value > 0 ? 1.5 : 0, y(0) - y(p.value));
        svg += barPath(x, y(0) - h, bw, h, true, `fill:var(${p.current ? "--s1" : "--s1-muted"})`);
        if (p.current && p.value > 0) svg += `<text class="val" x="${x + bw / 2}" y="${y(0) - h - 4}" text-anchor="middle">${esc(p.valueLabel ?? fmt(p.value))}</text>`;
      }
      svg += `<rect class="hit" x="${PADL + band * i}" y="${PADT}" width="${band}" height="${plotH}" data-tip="${esc(p.tip)}" tabindex="0"/>`;
    }
    svg += `<text class="tick ${p.current ? "cur" : ""}" x="${PADL + band * i + band / 2}" y="${H - 6}" text-anchor="middle">${esc(p.label)}</text>`;
  });
  if (opts.target) {
    svg += `<line class="target" x1="${PADL}" x2="${W - PADR}" y1="${y(opts.target)}" y2="${y(opts.target)}"/><text class="tlabel" x="${PADL + 4}" y="${y(opts.target) - 4}" text-anchor="start">${esc(opts.targetLabel || "Target")}</text>`;
  }
  svg += `<line class="axis" x1="${PADL}" x2="${W - PADR}" y1="${y(0)}" y2="${y(0)}"/>`;
  const legend = opts.stack ? `<div class="legend">${opts.stack.map((k) => `<span><i style="background:var(${k.color})"></i>${esc(k.label)}</span>`).join("")}</div>` : "";
  return `${legend}<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.aria || "Chart")}">${svg}</svg>`;
}

/** Column hanging down from the zero line (negative value), rounded at the bottom. */
function barPathDown(x, yTop, w, h, style) {
  if (h <= 0) return "";
  const r = Math.min(4, w / 2, h);
  return `<path style="${style}" d="M${x},${yTop} V${yTop + h - r} Q${x},${yTop + h} ${x + r},${yTop + h} H${x + w - r} Q${x + w},${yTop + h} ${x + w},${yTop + h - r} V${yTop} Z"/>`;
}

/** Column with a 4px rounded data-end and a square base. */
function barPath(x, yTop, w, h, roundTop, style) {
  if (h <= 0) return "";
  const r = roundTop ? Math.min(4, w / 2, h) : 0;
  return `<path style="${style}" d="M${x},${yTop + h} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + w - r} Q${x + w},${yTop} ${x + w},${yTop + r} V${yTop + h} Z"/>`;
}

/** A line over time with an end dot. points: [{label, value, tip, current}] */
export function line(points, opts = {}) {
  const H = opts.height || 170;
  const plotW = W - PADL - PADR, plotH = H - PADT - PADB;
  const vals = points.map((p) => p.value).filter((v) => v > 0);
  const { max, ticks } = niceScale(Math.max(...vals, opts.target || 0));
  const y = (v) => PADT + plotH - (v / max) * plotH;
  const band = plotW / points.length;
  const x = (i) => PADL + band * i + band / 2;
  const fmt = (v) => compact(v, opts.money);
  let svg = ticks.map((t) => `<line class="grid" x1="${PADL}" x2="${W - PADR}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${PADL - 6}" y="${y(t) + 3.5}" text-anchor="end">${fmt(t)}</text>`).join("");
  if (opts.target) svg += `<line class="target" x1="${PADL}" x2="${W - PADR}" y1="${y(opts.target)}" y2="${y(opts.target)}"/><text class="tlabel" x="${PADL + 4}" y="${y(opts.target) - 4}" text-anchor="start">${esc(opts.targetLabel || "Target")}</text>`;
  // Only connect months that have data, so empty months don't drag the line to zero.
  let d = "", open = false;
  points.forEach((p, i) => {
    if (p.value > 0) { d += `${open ? "L" : "M"}${x(i)},${y(p.value)} `; open = true; } else open = false;
  });
  svg += `<path class="ln" d="${d}"/>`;
  points.forEach((p, i) => {
    if (p.value > 0 && p.current) {
      svg += `<circle class="dot" cx="${x(i)}" cy="${y(p.value)}" r="4.5"/>`;
      svg += `<text class="val" x="${x(i)}" y="${y(p.value) - 9}" text-anchor="${i > points.length - 3 ? "end" : "middle"}">${esc(p.valueLabel ?? fmt(p.value))}</text>`;
    }
    svg += `<rect class="hit" x="${PADL + band * i}" y="${PADT}" width="${band}" height="${plotH}" data-tip="${esc(p.tip)}" tabindex="0"/>`;
    svg += `<text class="tick ${p.current ? "cur" : ""}" x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(p.label)}</text>`;
  });
  svg += `<line class="axis" x1="${PADL}" x2="${W - PADR}" y1="${y(0)}" y2="${y(0)}"/>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.aria || "Chart")}">${svg}</svg>`;
}

/**
 * Horizontal bars (HTML, so long labels wrap nicely).
 * rows: [{label, value, display, color, tip, sub}]; opts: { max, target, targetLabel, legend:[{label,color}] }
 */
export function hbars(rows, opts = {}) {
  const max = opts.max || Math.max(1, ...rows.map((r) => r.value));
  const legend = opts.legend ? `<div class="legend">${opts.legend.map((k) => `<span><i style="background:var(${k.color})"></i>${esc(k.label)}</span>`).join("")}</div>` : "";
  const target = opts.target ? `<div class="hb-target" style="left:${Math.min(100, (opts.target / max) * 100)}%" title="${esc(opts.targetLabel || "Target")}"><span>${esc(opts.targetLabel || "Target")}</span></div>` : "";
  return `${legend}<div class="hbars">${rows.map((r) => `
    <div class="hb" data-tip="${esc(r.tip || `${r.label}: ${r.display}`)}" tabindex="0">
      <div class="hb-label">${esc(r.label)}${r.sub ? `<small>${esc(r.sub)}</small>` : ""}</div>
      <div class="hb-track"><div class="hb-lane">${target}<div class="hb-bar" style="width:${Math.max(r.value > 0 ? 1 : 0, Math.min(100, (r.value / max) * 100))}%;background:var(${r.color || "--s1"})"></div></div><span class="hb-val">${esc(r.display)}</span></div>
    </div>`).join("")}</div>`;
}

/** Tiny trend line for a metric card: muted line, current point in the accent. */
export function spark(values, opts = {}) {
  const w = 120, h = 30, pad = 3;
  const vals = values.map((v) => (Number.isFinite(v) ? v : 0));
  // Scaled to the metric's own range (not from zero) so month-to-month change is visible.
  const lo0 = Math.min(...vals, opts.target ?? Infinity), hi0 = Math.max(...vals, opts.target ?? -Infinity);
  const span = hi0 - lo0 || Math.abs(hi0) || 1;
  const lo = lo0 - span * 0.15, hi = hi0 + span * 0.15;
  const x = (i) => pad + (i * (w - 2 * pad)) / Math.max(1, vals.length - 1);
  const y = (v) => h - pad - ((v - lo) / (hi - lo)) * (h - 2 * pad);
  const d = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = vals.length - 1;
  const tgt = opts.target != null ? `<line class="sp-target" x1="${pad}" x2="${w - pad}" y1="${y(opts.target)}" y2="${y(opts.target)}"/>` : "";
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true">${tgt}<path d="${d}"/><circle cx="${x(last)}" cy="${y(vals[last])}" r="3"/></svg>`;
}
