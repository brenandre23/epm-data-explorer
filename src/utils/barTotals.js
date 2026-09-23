// The total of a stacked bar, written at its end and repeated in the tooltip.
//
// A stacked capacity mix answers "what is this zone made of" and, until 2026-08-31,
// nothing at all answered "how much does this zone have". The tooltip named one techfuel,
// the one under the cursor, and the axis was shared by bars spanning a factor of 170
// (Nakhchivan 206 MW against WestAna 35 555 MW in the 2030 baseline), so the small zones
// were slivers with no readable size. The whole region total existed as a card above the
// chart; nothing gave it per bar.
//
// Chart.js has no built-in value label, and pulling chartjs-plugin-datalabels in for one
// number would add a dependency to every page that draws a chart. This is the small local
// plugin instead, written once so the region, country and zone pages cannot drift apart.
//
// What the total counts: the datasets the chart actually holds. The pages filter their
// datasets on the clickable legend before handing them over, so a hidden techfuel is gone
// by the time the plugin runs and the number matches the bar that is drawn rather than a
// mix the reader cannot see. `filtered` lets the tooltip say so.
//
// Since 2026-09-15 the same plugin labels the vertical snapshot and evolution charts, where
// three things the horizontal overview never met had to be settled:
//
//   Stacks. One index carries one bar per scenario, each its own `stack`. Each gets its
//   own total, and a line drawn over the bars (a trade net, say) is not part of any.
//
//   Extras. The generation stack also carries the energy traded and the demand left
//   unserved, and the capacity stack the line capacity behind it (annualExtras.js, flagged
//   `_extra`). They are drawn so the bar reaches the demand, but they are not plants: the
//   label gives the plants alone and sits past the whole bar, extras included, and the
//   tooltip says "(plants)". Adding an import to the local fleet would count it twice.
//
//   Signs. A Δ chart stacks gains upward and losses downward. The label gives the net,
//   signed, past the end of the side the net falls on.
//
// Nothing is clipped instead of written: a label wider than its bar's slot is written short
// (12.3k), then turned a quarter, then dropped. The value axis is stretched so the label
// stays inside the chart (`headroom`, on by default for vertical bars).
//
// Only a stacked chart should get the plugin: on bars drawn side by side the sum of the
// datasets at an index is not the height of anything.

/** A number as the labels write it: whole above 100, three figures below. */
export const DEFAULT_FMT = v => {
  const a = Math.abs(v);
  if (a >= 100) return Math.round(v).toLocaleString('en-US');
  if (a >= 10) return String(+v.toFixed(1));
  return String(+v.toPrecision(2));
};

/** The short form of a number, for a label the full one does not fit: 12.3k, 4M. */
export function compactNumber(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return `${+(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${+(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return DEFAULT_FMT(v);
}

/** The stack Chart.js draws a dataset in: its `stack`, else one shared by its type. */
export const stackOf = (ds, chartType = 'bar') => ds?.stack ?? (ds?.type || chartType);

const isBar = (ds, chartType) => (ds?.type || chartType) === 'bar';
const num = v => (typeof v === 'number' ? v : Number(v) || 0);

/**
 * The stacks at one index, in the order the chart first meets them.
 *
 * Each carries `plants` (the signed sum of its datasets that are not `_extra`), `pos` and
 * `neg` (the two ends of the drawn bar, extras included: Chart.js stacks gains and losses
 * apart), `n` (how many plant datasets), `nonzero` (whether any plant segment is drawn),
 * `hasExtra`, and `first`, the index of its first dataset, whose element gives the position.
 * Line datasets belong to no stack here.
 */
export function stackTotals(datasets, index, { chartType = 'bar', isVisible = () => true } = {}) {
  const out = new Map();
  (datasets || []).forEach((ds, i) => {
    if (!isBar(ds, chartType) || !isVisible(i)) return;
    const key = stackOf(ds, chartType);
    let g = out.get(key);
    if (!g) out.set(key, g = { key, first: i, plants: 0, pos: 0, neg: 0, n: 0, nonzero: false, hasExtra: false });
    const v = num(ds.data?.[index]);
    if (v > 0) g.pos += v; else g.neg += v;
    if (ds._extra) { g.hasExtra = true; return; }
    g.plants += v;
    g.n++;
    if (v) g.nonzero = true;
  });
  return [...out.values()];
}

const chartType = chart => chart?.config?.type || 'bar';
const visibility = chart => i => !chart.isDatasetVisible || chart.isDatasetVisible(i);
const chartStacks = (chart, index) =>
  stackTotals(chart?.data?.datasets, index, { chartType: chartType(chart), isVisible: visibility(chart) });

/** How many bars share one index: one per stack holding a visible bar dataset. */
function stackCount(chart) {
  const type = chartType(chart);
  const seen = visibility(chart);
  const keys = new Set();
  (chart?.data?.datasets || []).forEach((ds, i) => { if (isBar(ds, type) && seen(i)) keys.add(stackOf(ds, type)); });
  return Math.max(1, keys.size);
}

/** Sum of the visible datasets at one index, which is the length of that stacked bar. */
export function visibleStackTotal(chart, dataIndex) {
  let total = 0;
  const ds = chart?.data?.datasets || [];
  for (let i = 0; i < ds.length; i++) {
    if (chart.isDatasetVisible && !chart.isDatasetVisible(i)) continue;
    total += Number(ds[i].data?.[dataIndex]) || 0;
  }
  return total;
}

/**
 * A chart.js plugin that writes each stacked bar's total just past its end.
 *
 * @param axis     the value axis, 'x' for a horizontal bar chart (indexAxis 'y'), else 'y'
 * @param color    the text colour, normally the theme's muted colour, the one of the axis
 *                 ticks: the label colour is near black and shouts over a light ground
 * @param fmt      how to render the number, unit excluded
 * @param unit     appended after the number, e.g. 'MW'; best left out where the axis says it
 * @param delta    a Δ chart: the total is a net and a gain is written with its '+'
 * @param headroom stretch the value axis so the labels fit, by default on vertical bars
 *
 * A horizontal chart needs room on the value side from layout.padding instead: its labels
 * are as wide as their text and the axis has no say in the width of the canvas.
 */
export function barTotalPlugin({ axis = 'x', color = '#888', fmt = DEFAULT_FMT, unit = '', size, pad = 4,
  delta = false, headroom } = {}) {
  const px = size ?? (axis === 'x' ? 10 : 9);
  const font = `500 ${px}px "Open Sans", system-ui, sans-serif`;
  const stretch = headroom ?? axis === 'y';
  const indexAxis = axis === 'x' ? 'y' : 'x';
  const sign = v => (delta && v > 0 ? '+' : '');
  const tail = unit ? ` ${unit}` : '';

  // Every label the chart carries and how it is written: flat when it fits the slot its bar
  // has on the index axis, short when only that fits, turned a quarter when neither does,
  // else not at all. Horizontal bars write theirs along the bar, where width is no issue.
  function labels(chart, slot) {
    const ctx = chart.ctx;
    const n = chart.data?.labels?.length || 0;
    const out = [];
    if (!ctx) return out;
    ctx.save();
    ctx.font = font;
    for (let idx = 0; idx < n; idx++) {
      for (const g of chartStacks(chart, idx)) {
        if (!g.nonzero) continue;
        const v = g.plants;
        let txt = `${sign(v)}${fmt(v)}${tail}`;
        let w = ctx.measureText(txt).width;
        let rot = false;
        if (axis === 'y' && w > slot - 2) {
          txt = `${sign(v)}${compactNumber(v)}${tail}`;
          w = ctx.measureText(txt).width;
          if (w > slot - 2) {
            if (slot < px + 1) continue;
            rot = true;
          }
        }
        out.push({ idx, g, v, txt, w, rot });
      }
    }
    ctx.restore();
    return out;
  }

  const slotOf = (chart, width) => width / Math.max(1, chart.data?.labels?.length || 0) / stackCount(chart);
  // How far past the bar's end a label reaches, along the value axis.
  const reach = L => pad + (axis === 'x' || L.rot ? L.w : px);

  return {
    id: 'barTotals',

    // The labels have to fit inside the plot: raise the top of the value axis (and lower
    // its bottom, for losses) until the longest reach clears it. The plot's height is the
    // one from the last layout, or a fair share of the canvas on the first.
    afterDataLimits(chart, args) {
      const scale = args?.scale;
      if (!stretch || !scale || scale.id !== axis) return;
      const { min, max } = scale;
      if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return;
      const along = axis === 'y'
        ? (chart.chartArea?.height || (chart.height || 0) * 0.75)
        : (chart.chartArea?.width || (chart.width || 0) * 0.75);
      const across = axis === 'y'
        ? (chart.chartArea?.width || (chart.width || 0) * 0.85)
        : (chart.chartArea?.height || (chart.height || 0) * 0.75);
      if (!(along > 0)) return;
      const ls = labels(chart, slotOf(chart, across));
      const k = L => Math.min(0.4, reach(L) / along);
      let top = max;
      for (const L of ls) if (L.v >= 0) top = Math.max(top, (L.g.pos - k(L) * min) / (1 - k(L)));
      let bottom = min;
      for (const L of ls) if (L.v < 0) bottom = Math.min(bottom, (L.g.neg - k(L) * top) / (1 - k(L)));
      scale.max = top;
      scale.min = bottom;
    },

    afterDatasetsDraw(chart) {
      const scale = chart.scales?.[axis];
      if (!scale) return;
      const width = chart.scales?.[indexAxis]?.[axis === 'y' ? 'width' : 'height'] || 0;
      const ctx = chart.ctx;
      ctx.save();
      ctx.fillStyle = color;
      ctx.font = font;
      for (const L of labels(chart, slotOf(chart, width))) {
        const el = chart.getDatasetMeta(L.g.first)?.data?.[L.idx];
        if (!el) continue;
        const up = L.v >= 0;
        const p = scale.getPixelForValue(up ? L.g.pos : L.g.neg);
        if (axis === 'x') {
          ctx.textBaseline = 'middle';
          ctx.textAlign = up ? 'left' : 'right';
          ctx.fillText(L.txt, p + (up ? pad : -pad), el.y);
        } else if (L.rot) {
          ctx.save();
          ctx.translate(el.x, p + (up ? -pad : pad));
          ctx.rotate(-Math.PI / 2);
          ctx.textBaseline = 'middle';
          ctx.textAlign = up ? 'left' : 'right';
          ctx.fillText(L.txt, 0, 0);
          ctx.restore();
        } else {
          ctx.textAlign = 'center';
          ctx.textBaseline = up ? 'bottom' : 'top';
          ctx.fillText(L.txt, el.x, p + (up ? -pad : pad));
        }
      }
      ctx.restore();
    },
  };
}

/**
 * A tooltip footer giving the bar's total and the hovered segment's share of it.
 *
 * One line per stack the tooltip covers, named after the stack when there are several: an
 * index tooltip on a two scenario chart used to add both bars into one number. A stack of a
 * single plant dataset gets no line, its total being the line above. The share is given only
 * for a single hovered plant segment, and never on a Δ chart, where it means nothing.
 *
 * `filtered` says whether the legend is currently hiding series, so the reader knows the
 * total describes what is on screen and not the whole mix.
 */
export function barTotalFooter({ axis = 'x', unit = '', fmt = DEFAULT_FMT, filtered = false, delta = false } = {}) {
  const value = v => `${delta && v > 0 ? '+' : ''}${fmt(v)}${unit ? ' ' + unit : ''}`;
  const head = g => `${delta ? 'Net' : 'Total'}${filtered ? ' shown' : ''}${g.hasExtra ? ' (plants)' : ''}`;
  return items => {
    const it = items?.[0];
    if (!it?.chart) return '';
    const type = chartType(it.chart);
    const hovered = new Set(items.map(x => stackOf(x.dataset, type)));
    const groups = chartStacks(it.chart, it.dataIndex)
      .filter(g => hovered.has(g.key) && g.nonzero && (g.n > 1 || g.hasExtra));
    if (!groups.length) return '';
    if (groups.length > 1) return groups.map(g => `${g.key} ${head(g).toLowerCase()}: ${value(g.plants)}`);
    const g = groups[0];
    let line = `${head(g)}: ${value(g.plants)}`;
    if (items.length === 1 && !delta && !it.dataset?._extra && g.plants > 0) {
      const share = ((Number(it.parsed?.[axis]) || 0) / g.plants) * 100;
      line += `  (${share.toFixed(share < 10 ? 1 : 0)}%)`;
    }
    return line;
  };
}
