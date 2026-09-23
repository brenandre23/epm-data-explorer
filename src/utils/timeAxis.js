// Lays a model's time slices out along a chart x axis.
//
// A chronological model is already uniform: 24 slices, one hour each, one slot each
// — the layout every chart here used before this file existed, and what it still
// returns for those models.
//
// A load-block model is not. CASA 2020 runs on blocks of 14 h to 918 h, and drawing
// them at equal width makes the 130-hour peak season as wide as the 3652-hour
// summer, which is the opposite of what the numbers say. Each block instead gets a
// number of slots proportional to the hours it stands for, so the width of a season
// is its share of the year and the area under a stacked curve is energy.
//
// The result is a flat list of slots. A chart maps over it for its data and reads
// `offsets` / `spans` to place the season and day-type separators, instead of
// assuming a fixed number of slices per representative day.

// Slots per chart. Enough that the narrowest block still gets one, small enough to
// keep the point count reasonable — the year ends up a few hundred points wide.
const TARGET_FULL = 480;
const TARGET_SEASON = 96;

import { sliceLabel } from './epmFetch';

const key = (q, d) => `${q}|${d}`;

/** slices: from processTimeSlices. seasons / daytypes: those actually plotted.
 *  Returns { slots: [{q,d,t,i}], offsets: {`q|d`: firstSlot}, spans: {`q|d`: nSlots}, nT,
 *            proportional: true when a slice can be more than one slot wide } */
export function buildTimeAxis(slices, seasons, daytypes, target = TARGET_FULL) {
  const nT = slices?.nT || 24;
  const out = { slots: [], offsets: {}, spans: {}, nT, proportional: false };
  if (!seasons?.length || !daytypes?.length) return out;

  const hoursOf = (q, d, i) => slices?.hours?.[q]?.[d]?.[`t${i + 1}`] || 0;

  // One slot per slice unless the slices are blocks of known, unequal length.
  let width = () => 1;
  if (slices?.isHourly === false) {
    let total = 0;
    for (const q of seasons) for (const d of daytypes)
      for (let i = 0; i < nT; i++) total += hoursOf(q, d, i);
    if (total > 0) {
      const unit = total / target;
      out.proportional = true;
      width = (q, d, i) => {
        const h = hoursOf(q, d, i);
        return h > 0 ? Math.max(1, Math.round(h / unit)) : 0;
      };
    }
  }

  for (const q of seasons) for (const d of daytypes) {
    const start = out.slots.length;
    for (let i = 0; i < nT; i++) {
      const t = `t${i + 1}`;
      for (let k = 0; k < width(q, d, i); k++) out.slots.push({ q, d, t, i });
    }
    // A group pHours says nothing about still has to be drawn: give it plain slices.
    if (out.slots.length === start)
      for (let i = 0; i < nT; i++) out.slots.push({ q, d, t: `t${i + 1}`, i });
    out.offsets[key(q, d)] = start;
    out.spans[key(q, d)] = out.slots.length - start;
  }
  return out;
}

/** Same, for the single-season charts: one season, one day type (or the average). */
export function buildSeasonAxis(slices, season, daytypes) {
  return buildTimeAxis(slices, season ? [season] : [], daytypes, TARGET_SEASON);
}

/** Axis labels for a single-season chart: each slice named once, on its middle slot,
 *  so a block that spans 30 slots is labelled at its centre instead of 30 times over.
 *  Every slice is one slot wide on a chronological model, so this is the plain hour list. */
export function blockLabels(ax, slices, q, d) {
  const named = new Map();
  for (let i = 0; i < ax.slots.length;) {
    let j = i;
    while (j < ax.slots.length && ax.slots[j].t === ax.slots[i].t
           && ax.slots[j].q === ax.slots[i].q && ax.slots[j].d === ax.slots[i].d) j++;
    named.set(i + ((j - i - 1) >> 1), ax.slots[i].i);
    i = j;
  }
  return ax.slots.map((s, k) => (named.has(k) ? sliceLabel(slices, named.get(k), q, d) : ''));
}

/**
 * The banding the profile charts draw over a block axis: a solid rule at each season
 * boundary, a dashed one between day types, the season named above the plot and each day
 * type named below it with the share of the year it stands for.
 *
 * Six charts across three pages drew their own copy of this and had drifted in font size
 * and in the colours of the rules, so this is their union. `dayFont` is the one difference
 * worth keeping: the single-zone charts are narrower and take the smaller label.
 */
export function bandingPlugin({ id, ax, seasons, daytypes, hoursData, totalDays, isDark, dayFont = 7 }) {
  return {
    id,
    afterDraw: (chart) => {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !scales.x) return;
      const { top, bottom } = chartArea;
      const xS = scales.x;
      const dashC  = isDark ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.12)';
      const solidC = isDark ? 'rgba(255,255,255,0.36)' : 'rgba(0,0,0,0.30)';
      const textC  = isDark ? 'rgba(255,255,255,0.46)' : 'rgba(0,0,0,0.40)';
      const seasC  = isDark ? 'rgba(255,255,255,0.70)' : 'rgba(0,0,0,0.58)';
      const off = (a, b) => ax.offsets[key(seasons[a], daytypes[b])] || 0;
      const spn = (a, b) => ax.spans[key(seasons[a], daytypes[b])] || 0;

      for (let si = 0; si < seasons.length; si++) {
        const start = off(si, 0);
        const width = daytypes.reduce((a, _, di) => a + spn(si, di), 0);
        ctx.save();
        ctx.font = '700 9px "Open Sans", system-ui, sans-serif';
        ctx.fillStyle = seasC; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(seasons[si], xS.getPixelForValue(start + width / 2), top - 2);
        ctx.restore();

        for (let di = 0; di < daytypes.length; di++) {
          const dts = off(si, di);
          if (dts > 0) {
            const isSeasBorder = di === 0;
            const lx = xS.getPixelForValue(dts);
            ctx.save();
            ctx.strokeStyle = isSeasBorder ? solidC : dashC;
            ctx.lineWidth   = isSeasBorder ? 1.2 : 0.7;
            if (!isSeasBorder) ctx.setLineDash([3, 3]);
            ctx.beginPath(); ctx.moveTo(lx, top); ctx.lineTo(lx, bottom); ctx.stroke();
            ctx.restore();
          }
          // Day type name, rotated a quarter turn, under the x axis.
          const w   = hoursData?.[seasons[si]]?.[daytypes[di]] || 0;
          const pct = w > 0 ? ` (${((w / totalDays) * 100).toFixed(0)}%)` : '';
          ctx.save();
          ctx.translate(xS.getPixelForValue(dts + spn(si, di) / 2), bottom + 3);
          ctx.rotate(-Math.PI / 2);
          ctx.font = `${dayFont}px "Open Sans", system-ui, sans-serif`;
          ctx.fillStyle = textC; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
          ctx.fillText(`${daytypes[di]}${pct}`, 0, 0);
          ctx.restore();
        }
      }
    },
  };
}

/** Share of a season each of its day types stands for, from pHours.
 *  A day type worth 5 days of the year and one worth 90 are not the same observation, so an
 *  average over them has to be weighted; with no hours to go on they fall back to equal. */
export function dayWeights(hoursData, season, daytypes) {
  const h = daytypes.map(d => hoursData?.[season]?.[d] || 0);
  const tot = h.reduce((a, b) => a + b, 0);
  return tot > 0 ? h.map(x => x / tot) : daytypes.map(() => 1 / (daytypes.length || 1));
}

/** Tick options a proportional axis needs: the labels are already spaced out, so let
 *  them all through instead of letting autoskip drop the named slots and keep blanks. */
export const axisTicks = (ax) => (ax?.proportional ? { autoSkip: false, maxRotation: 0 } : null);

export { TARGET_FULL, TARGET_SEASON };
