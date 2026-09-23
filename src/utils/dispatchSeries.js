// Dispatch chart series for the results pages.
//
// Every dispatch view is the same window seen at a different width: a set of seasons
// crossed with a set of day types. "Full Year" is all of both, clicking a season
// narrows it to one, and the day selector narrows it further to a single day type —
// or folds the day types together into one average day. The region, country and zone
// pages each carried a copy of this with a separate branch for the full-year and the
// single-season case, which is how they came to disagree on what a season chart draws.
//
// Both charts of the dispatch tab are built here, and both are stacked bars. A
// dispatch stack is not all one sign: EPM writes Exports and Storage Charge as
// negative, and a difference is negative wherever the scenario generates less. An
// area stack cannot hold that — the Filler plugin fills between one dataset and the
// one below it in the stack, which stops meaning anything once the series cross zero
// — whereas bars split cleanly around it, gains piling up above and losses below.

import { buildTimeAxis, blockLabels, axisTicks, TARGET_FULL, TARGET_SEASON } from './timeAxis';
import { fillFor, seriesRank } from './chartColors';

const DEMAND_COLOR = '#8B0000';
const DEMAND_OVERLAY = '#CC0000';

const EMPTY = { chartData: { labels: [], datasets: [] }, plugin: null, xTicks: null, grouped: false };

/** Bar options shared by both charts: full width in both directions so the bars sit
 *  edge to edge and the stack reads as a filled profile rather than a bar chart.
 *
 *  barThickness 'flex' is what makes that actually true at full-year width. A year here
 *  is seasons x day types x 24 hours -- 480 slots on a Black Sea run -- and at a chart
 *  width of about 900px each bar is under two pixels. Sized from a percentage, those
 *  bars land on fractional pixel boundaries and the canvas antialiases every edge, so
 *  the stack stops reading as a profile and turns into a vertical blur. 'flex' sizes
 *  each bar from its neighbours' boundaries instead, which puts the edges back on whole
 *  pixels and leaves no seam between one hour and the next. */
const BAR = { type: 'bar', borderWidth: 0, barPercentage: 1, categoryPercentage: 1,
  barThickness: 'flex', stack: 'gen' };

/** The slice of the year a view shows, and how to read a value inside it.
 *  sources: the dispatch objects the chart draws, {season: {day: {t: {techfuel: MW}}}}.
 *  daySel:  'all' (every day type), 'avg' (all of them folded into one), or a day id. */
function viewWindow({ slices, sources, seasons, days, daySel }) {
  // Only the day types the data actually holds: a (season, day type) the model never
  // filled would otherwise take its share of the axis and draw an empty block.
  const present = days.filter(d => seasons.some(q => sources.some(s => s?.[q]?.[d])));
  const dayList = present.length ? present : days;
  const folded = daySel === 'avg' ? dayList : null;
  const shown = folded ? dayList.slice(0, 1)
    : daySel === 'all' ? dayList
    : dayList.includes(daySel) ? [daySel] : dayList.slice(0, 1);

  const ax = buildTimeAxis(slices, seasons, shown, seasons.length > 1 ? TARGET_FULL : TARGET_SEASON);
  // More than one block on the axis: the chart takes the season / day-type overlay and
  // drops the hour ticks, the way the full-year view always has.
  const grouped = seasons.length > 1 || shown.length > 1;

  /** Stacked value: absent reads as zero, so the stack keeps its shape. */
  const gen = (src, tf) => ax.slots.map(s => (folded
    ? folded.reduce((a, d) => a + (src?.[s.q]?.[d]?.[s.t]?.[tf] || 0), 0) / folded.length
    : (src?.[s.q]?.[s.d]?.[s.t]?.[tf] || 0)));

  /** Overlay line value: absent — or zero, which is what EPM writes for "not set" on
   *  these series — is a gap, averaged over the day types an 'avg' view folds. */
  const line = (src, tf) => ax.slots.map(s => {
    const at = (d) => { const cell = src?.[s.q]?.[d]?.[s.t]; return (tf ? cell?.[tf] : cell) || null; };
    const vals = (folded || [s.d]).map(at).filter(v => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  });

  const techfuels = [...new Set(seasons.flatMap(q => (folded || shown).flatMap(d =>
    sources.flatMap(src => Object.values(src?.[q]?.[d] || {}).flatMap(cell => Object.keys(cell || {}))))))]
    .filter(k => k !== 'Demand')
    // Fuels alphabetically, then what was traded, then what went unserved — so the
    // stack reads as generation with the rest piled on top of it, instead of putting
    // Exports between Diesel and Gas because that is where the alphabet left it.
    .sort((a, b) => seriesRank(a) - seriesRank(b) || a.localeCompare(b));

  return {
    ax, shown, grouped, gen, line, techfuels,
    labels: grouped ? new Array(ax.slots.length).fill('') : blockLabels(ax, slices, seasons[0], shown[0]),
    xTicks: grouped ? null : axisTicks(ax),
  };
}

/** Draws what Chart.js cannot: the demand and price lines crisply on top of the stack
 *  (they carry order:1, so they are painted before it and end up underneath), and on a
 *  grouped axis the season and day-type separators with each block's share of the year. */
/** Whether the dataset an overlay line doubles is still on the chart. The pages drop
 *  a hidden series from `data.datasets` outright, and Chart.js can hide one in place. */
function lineVisible(chart, label) {
  if (!label) return true;
  return chart.data.datasets.some((d, i) => d.label === label && chart.isDatasetVisible(i));
}

function overlay({ ax, seasons, days, grouped, isDark, hoursData, totalDays, lines }) {
  const drawn = lines.filter(([data]) => data && data.some(v => v != null));
  if (!drawn.length && !grouped) return null;
  return {
    id: 'dispOverlay',
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea) return;
      // Chart.js clips its own datasets to the plot. This hand-drawn pass has to clip
      // itself, or a point outside the current range is painted over the axes and on
      // into the panel around them.
      ctx.save();
      ctx.beginPath();
      ctx.rect(chartArea.left, chartArea.top,
        chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
      ctx.clip();
      for (const [data, yKey, color, width, label] of drawn) {
        // A series taken off the legend leaves the scale with it, so what is left of
        // that scale no longer describes these points. Hidden means not drawn.
        if (!scales[yKey] || !lineVisible(chart, label)) continue;
        ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash([]);
        let moved = false;
        data.forEach((v, i) => {
          if (v == null) { moved = false; return; }
          const x = scales.x.getPixelForValue(i), y = scales[yKey].getPixelForValue(v);
          if (moved) ctx.lineTo(x, y); else ctx.moveTo(x, y);
          moved = true;
        });
        ctx.stroke();
      }
      ctx.restore();
    },
    afterDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!grouped || !chartArea || !scales.x) return;
      const { top, bottom } = chartArea, xS = scales.x;
      const dayC = isDark ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.12)';
      const seasonC = isDark ? 'rgba(255,255,255,0.36)' : 'rgba(0,0,0,0.30)';
      const textC = isDark ? 'rgba(255,255,255,0.46)' : 'rgba(0,0,0,0.40)';
      const titleC = isDark ? 'rgba(255,255,255,0.70)' : 'rgba(0,0,0,0.58)';
      const off = (q, d) => ax.offsets[`${q}|${d}`] || 0;
      const spn = (q, d) => ax.spans[`${q}|${d}`] || 0;
      for (const q of seasons) {
        const width = days.reduce((a, d) => a + spn(q, d), 0);
        ctx.save();
        ctx.font = '700 9px "Open Sans", system-ui, sans-serif'; ctx.fillStyle = titleC;
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(q, xS.getPixelForValue(off(q, days[0]) + width / 2), top - 2);
        ctx.restore();
        days.forEach((d, di) => {
          const start = off(q, d);
          if (start > 0) {
            const x = xS.getPixelForValue(start), isSeason = di === 0;
            ctx.save();
            ctx.strokeStyle = isSeason ? seasonC : dayC; ctx.lineWidth = isSeason ? 1.2 : 0.7;
            if (!isSeason) ctx.setLineDash([3, 3]);
            ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
            ctx.restore();
          }
          const w = hoursData?.[q]?.[d] || 0;
          const pct = w > 0 && totalDays > 0 ? ` (${((w / totalDays) * 100).toFixed(0)}%)` : '';
          ctx.save();
          ctx.translate(xS.getPixelForValue(start + spn(q, d) / 2), bottom + 3);
          ctx.rotate(-Math.PI / 2);
          ctx.font = '8px "Open Sans", system-ui, sans-serif'; ctx.fillStyle = textC;
          ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
          ctx.fillText(`${d}${pct}`, 0, 0);
          ctx.restore();
        });
      }
    },
  };
}

/** Stacked generation, with the demand and marginal-cost lines over it.
 *  zDisp: {season: {day: {t: {techfuel: MW}}}} — 'Demand' is one of the techfuel keys.
 *  price: {season: {day: {t: USD/MWh}}}, or null when the view has no single zone. */
export function buildDispatchSeries({ slices, zDisp, price, seasons, days, daySel,
                                     isDark, mcColor, hoursData, totalDays }) {
  if (!seasons?.length || !days?.length || !zDisp) return EMPTY;
  const w = viewWindow({ slices, sources: [zDisp], seasons, days, daySel });

  const datasets = w.techfuels.map(tf => ({
    ...BAR, label: tf, data: w.gen(zDisp, tf), backgroundColor: fillFor(tf, 0.8),
  }));
  const priceLine = w.line(price, null);
  const demandLine = w.line(zDisp, 'Demand');
  if (priceLine.some(v => v != null)) {
    datasets.push({ label: 'Marginal cost', type: 'line', data: priceLine, yAxisID: 'yR',
      borderColor: mcColor, borderWidth: 1, pointRadius: 0, tension: 0, fill: false, spanGaps: true, order: 1 });
  }
  if (demandLine.some(v => v != null)) {
    datasets.push({ label: 'Demand', type: 'line', data: demandLine, borderColor: DEMAND_COLOR,
      borderWidth: 1, pointRadius: 0, tension: 0, fill: false, spanGaps: true, stack: 'demand', order: 1 });
  }

  return {
    chartData: { labels: w.labels, datasets }, xTicks: w.xTicks, grouped: w.grouped,
    plugin: overlay({ ax: w.ax, seasons, days: w.shown, grouped: w.grouped, isDark, hoursData, totalDays,
      lines: [[demandLine, 'y', DEMAND_OVERLAY, 1.5, 'Demand'],
              [priceLine, 'yR', mcColor, 1, 'Marginal cost']] }),
  };
}

/** The same window, as the difference between two scenarios: A minus B per techfuel,
 *  stacked bars so gains pile up above zero and losses below it. */
export function buildDispatchDeltaSeries({ slices, zA, zB, priceA, priceB, seasons, days, daySel,
                                          isDark, mcColor, hoursData, totalDays }) {
  if (!seasons?.length || !days?.length || !zA || !zB) return EMPTY;
  const w = viewWindow({ slices, sources: [zA, zB], seasons, days, daySel });

  const datasets = w.techfuels.map(tf => {
    const a = w.gen(zA, tf), b = w.gen(zB, tf);
    return {
      ...BAR, label: tf, data: a.map((v, i) => +(v - b[i]).toFixed(1)),
      backgroundColor: fillFor(tf, 0.8),
    };
  }).filter(d => d.data.some(v => v !== 0));

  const pA = w.line(priceA, null), pB = w.line(priceB, null);
  const dPrice = pA.map((v, i) => ((v != null && pB[i] != null) ? +(v - pB[i]).toFixed(2) : null));
  if (dPrice.some(v => v != null)) {
    datasets.push({ label: 'Marginal cost', type: 'line', data: dPrice, yAxisID: 'yR',
      borderColor: mcColor, borderWidth: 1, pointRadius: 0, tension: 0, fill: false, spanGaps: true, order: 1 });
  }

  return {
    chartData: { labels: w.labels, datasets }, xTicks: w.xTicks, grouped: w.grouped,
    plugin: overlay({ ax: w.ax, seasons, days: w.shown, grouped: w.grouped, isDark, hoursData, totalDays,
      lines: [[dPrice, 'yR', mcColor, 1, 'Marginal cost']] }),
  };
}

/** Tooltip options the delta charts share: a fuel that did not move is not news. */
export const deltaTooltip = {
  filter: (ctx) => ctx.raw !== 0 && ctx.raw != null,
  callbacks: {
    label: (ctx) => `${ctx.dataset.label}: ${ctx.raw > 0 ? '+' : ''}${Math.round(ctx.raw).toLocaleString()}`,
  },
};
