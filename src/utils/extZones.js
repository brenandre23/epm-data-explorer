// The external neighbours: zones the model trades with but does not solve.
//
// They are drawn in grey, and the grey is the point. Everything the model decided —
// which plants ran, what the price came out at — is in colour; an external zone has
// none of that, only a border capacity someone typed in. Colouring it like an internal
// zone would claim a result that does not exist.
//
// zones_ext.geojson gives them as Points or as Polygons/MultiPolygons. Either way each
// one resolves to a single anchor (see utils/centroids), which is where its node sits
// and where the corridors from the internal zones terminate.
import maplibregl from 'maplibre-gl';
import { featureCentroid } from './centroids';
import { weightedAvgPrice } from './epmFetch';
import { layer, source } from './mapSource';
import { priceDotEl } from './priceDot';
import { MAP_LABEL_FONT } from './wbStyle';

// All layer ids the toggle controls: the country body, the corridors crossing it, then
// the node. Not a drawing order — the bodies are slipped under the map's internal
// corridors (see lowestCorridorLayer) while the rest goes on top.
// setExtZonesVisible skips ids a given map never created, so a page is free to build
// only part of this list.
export const EXT_LAYER_IDS = [
  'ext-zones-fill', 'ext-zones-hover', 'ext-zones-border',
  'ext-ntc-lines-layer', 'ext-ntc-labels',
  'ext-flow-bg', 'ext-flow-arrows', 'ext-flow-hit',
  'ext-nodes-circles',
];

// The same ramp the internal corridors use, so a saturated external line and a
// saturated internal one are the same red.
const UTIL_COLOR = ['interpolate', ['linear'], ['get', 'util'], 0, '#FFD700', 0.5, '#FF8C00', 1, '#E53935'];

// An inputs map draws its internal corridors in one amber, at one width ramp, with one
// label style. External corridors take exactly the same, because they are the same kind
// of statement: a transfer limit someone declared. Drawing them grey and thinner made
// them read as decoration sitting under the map rather than as part of it.
const NTC_AMBER = '#f0b030';
const NTC_LABEL = '#b07800';
const NTC_WIDTH = ['interpolate', ['linear'], ['get', 'ntc_mw'], 0, 1, 500, 2, 2000, 3.5, 8000, 6];
// Same, for a results map: the flow ramp and widths ntc-bg uses, solid. The dash this
// layer used to carry is what made a lightly-loaded external corridor -- pale gold, 1px,
// broken -- disappear into the basemap while its internal neighbour stayed legible.
const FLOW_WIDTH = ['interpolate', ['linear'], ['get', 'vol'], 0, 1, 500, 2.5, 5000, 5];

// The lowest internal corridor layer on this map, whatever the page called it. The grey
// bodies of the neighbours go *under* it: added last they veil every corridor that
// crosses a neighbour's territory, which is the other half of "the lines look like they
// are beneath the map". undefined = no corridors yet, and addLayer appends as before.
const INTERNAL_CORRIDOR_LAYERS = ['ntc-bg', 'ntc-lines-bg', 'ntc-lines-layer'];
function lowestCorridorLayer(map) {
  for (const id of INTERNAL_CORRIDOR_LAYERS) if (layer(map, id)) return id;
  return undefined;
}

/** The one grey palette, so the fill, the border and the node cannot drift apart
 *  across the five maps that draw them. */
export function extGrey(isDark) {
  return isDark
    ? { fill: '#3b3b3b', hover: '#6f6f6f', line: '#8a8a8a',
      node: 'rgba(40,40,40,0.85)' }
    : { fill: '#d6d6d6', hover: '#9a9a9a', line: '#8a8a8a',
      node: 'rgba(255,255,255,0.85)' };
}

/** The year to read a corridor's capacity at: the one asked for when the table has it,
 *  otherwise the last year before it — a capacity is a step function of the year a line
 *  is commissioned, so the previous entry is the value still in force, not a guess. */
function pickYear(years, want) {
  if (!years.length) return null;
  if (!want) return years[0];
  const w = String(want);
  if (years.includes(w)) return w;
  const before = years.filter(y => y <= w);
  return before.length ? before[before.length - 1] : years[0];
}

/** zext → [lon, lat], the point every corridor to that neighbour terminates on. */
export function extNodeCoordMap(zonesExtGJ) {
  const out = {};
  for (const f of zonesExtGJ?.features || []) {
    const z = f.properties?.z;
    if (!z || !f.geometry) continue;
    const c = featureCentroid(f);
    if (c) out[z] = c;
  }
  return out;
}

const fmtMw = (v) => Math.round(v).toLocaleString('en-US');

/** The rises pExtTransferLimit already holds after `year`, as planned line features in
 *  the shape of the inputs map's new lines (kind, mw, offset, label). EPM never builds
 *  an external corridor: a later, higher limit is a commitment written in the data,
 *  which is what a planned line is. `mw` is the rise over the capacity in force in
 *  `year`; the popup lists the steps. */
function extPlannedFeatures(extNtc, zoneCentroids, extNodeCoords, year) {
  const out = [];
  for (const r of extNtc || []) {
    const from = zoneCentroids[r.z], to = extNodeCoords[r.zext];
    if (!from || !to) continue;
    const now = r.years[year] || 0;
    const steps = [];
    let prev = now;
    for (const y of Object.keys(r.years).sort()) {
      if (y <= year || !(r.years[y] > prev)) continue;
      steps.push({ y, mw: r.years[y] });
      prev = r.years[y];
    }
    if (!steps.length) continue;
    const rise = prev - now;
    out.push({
      type: 'Feature',
      properties: { kind: 'planned', ext: true, z: r.z, z2: r.zext, mw: rise, now, yr: year,
        entry: steps[0].y, steps: JSON.stringify(steps),
        // Beside the solid line when there is one, as for the internal corridors.
        offset: now > 0 ? 3.5 : 0,
        label: `+${fmtMw(rise)} MW · ${steps[0].y}` },
      geometry: { type: 'LineString', coordinates: [from, to] },
    });
  }
  return out;
}

// Node coords, polygon features, corridor lines and node features, from the raw
// zones_ext geojson and the processed pExtTransferLimit rows. `off` (external exchange
// switched off in pSettings) keeps the neighbours but draws none of their corridors.
export function buildExtZoneData(zonesExtGJ, extNtc, zoneCentroids, year = null, { off = false } = {}) {
  const extNodeCoords = extNodeCoordMap(zonesExtGJ);
  const polyGeom = {};
  for (const f of zonesExtGJ?.features || []) {
    const z = f.properties?.z;
    if (!z || !f.geometry) continue;
    if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') polyGeom[z] = f.geometry;
  }

  const yrs = extNtc?.length ? Object.keys(extNtc[0].years).sort() : [];
  const extNtcYr = pickYear(yrs, year) || '2024';

  // Every corridor that lands on a zone, carried on the zone's own feature. A popup that
  // reads its rows out of the feature cannot go stale against the selected year the way
  // one closing over the data at layer-creation time did.
  const linksBy = {};
  for (const r of extNtc || []) (linksBy[r.zext] ||= []).push({ z: r.z, mw: r.years[extNtcYr] || 0 });
  const links = z => JSON.stringify(linksBy[z] || []);

  const extPolyFeatures = Object.entries(polyGeom).map(([z, geometry]) => ({
    type: 'Feature', properties: { z, links: links(z) }, geometry,
  }));
  // A corridor with no capacity in the selected year is not drawn, as the internal ones
  // are not: a line reading 0 MW is noise on the map. The node popup still lists it.
  const extLineFeatures = (off ? [] : extNtc || [])
    .filter(r => (r.years[extNtcYr] || 0) > 0 && zoneCentroids[r.z] && extNodeCoords[r.zext])
    .map(r => ({
      type: 'Feature',
      properties: { z: r.z, zext: r.zext, ntc_mw: r.years[extNtcYr] || 0, yr: extNtcYr },
      geometry: { type: 'LineString', coordinates: [zoneCentroids[r.z], extNodeCoords[r.zext]] },
    }));
  const extNodeFeatures = Object.entries(extNodeCoords).map(([z, coords]) => ({
    type: 'Feature', properties: { z, links: links(z) }, geometry: { type: 'Point', coordinates: coords },
  }));
  const plannedFeatures = off ? [] : extPlannedFeatures(extNtc, zoneCentroids, extNodeCoords, extNtcYr);
  return { extNodeCoords, extPolyFeatures, extLineFeatures, extNodeFeatures, extNtcYr, extPlannedFeatures: plannedFeatures };
}

// Add every external-zone source and layer to a loaded map. `visible` is applied at
// creation rather than after it: the layers are on by default, and creating them hidden
// only to reveal them a tick later flashes a map without its neighbours every time it
// is rebuilt — on a theme change, on a region change.
//
// `mode` decides what is drawn on the corridors. An inputs map shows the capacity that
// was declared for them; a results map shows what actually crossed, in the colours the
// internal corridors already use, and so has no room for the capacity line underneath —
// the flow layer carries the capacity in its popup and still draws corridors that ended
// up carrying nothing, exactly as the internal ones do.
export function addExtZoneLayers(map, tv, data, { visible = true, mode = 'inputs', arrowImage = null } = {}) {
  const { extPolyFeatures, extLineFeatures, extNodeFeatures } = data;
  const g = extGrey(tv.isDark);
  const vis = visible ? 'visible' : 'none';

  const under = lowestCorridorLayer(map);
  map.addSource('ext-zones', { type: 'geojson', data: { type: 'FeatureCollection', features: extPolyFeatures } });
  map.addLayer({ id: 'ext-zones-fill', type: 'fill', source: 'ext-zones',
    layout: { visibility: vis },
    paint: { 'fill-color': g.fill, 'fill-opacity': 0.22 } }, under);
  map.addLayer({ id: 'ext-zones-hover', type: 'fill', source: 'ext-zones',
    layout: { visibility: vis }, filter: ['==', ['get', 'z'], ''],
    paint: { 'fill-color': g.hover, 'fill-opacity': 0.4 } }, under);
  map.addLayer({ id: 'ext-zones-border', type: 'line', source: 'ext-zones',
    layout: { visibility: vis },
    paint: { 'line-color': g.line, 'line-width': 1, 'line-dasharray': [2, 1.5], 'line-opacity': 0.65 } }, under);

  if (mode === 'results') addExtFlowLayers(map, vis, arrowImage);
  else {
    map.addSource('ext-ntc-lines', { type: 'geojson', data: { type: 'FeatureCollection', features: extLineFeatures } });
    map.addLayer({ id: 'ext-ntc-lines-layer', type: 'line', source: 'ext-ntc-lines',
      layout: { visibility: vis, 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': NTC_AMBER, 'line-width': NTC_WIDTH, 'line-opacity': 0.9 } });
  }

  map.addSource('ext-nodes', { type: 'geojson', data: { type: 'FeatureCollection', features: extNodeFeatures } });
  map.addLayer({ id: 'ext-nodes-circles', type: 'circle', source: 'ext-nodes',
    layout: { visibility: vis },
    paint: { 'circle-radius': 4, 'circle-color': g.node,
      'circle-stroke-width': 1.5, 'circle-stroke-color': g.line } });
  // No name under the node. Writing one only on the external side made the neighbours the
  // labelled half of the picture, the opposite of the point. Names come with the opt-in
  // zone names of the results maps, which name both sides together (utils/zoneLabels.js);
  // otherwise which zone it is stays one hover away.
  if (mode !== 'results') {
    map.addLayer({ id: 'ext-ntc-labels', type: 'symbol', source: 'ext-ntc-lines',
      layout: { visibility: vis, 'text-font': MAP_LABEL_FONT, 'text-field': ['concat', ['to-string', ['round', ['get', 'ntc_mw']]], ' MW'],
        'text-size': 8, 'symbol-placement': 'line-center', 'text-allow-overlap': false },
      paint: { 'text-color': NTC_LABEL, 'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.5 } });
  }
}

// The external half of a results map's corridors: same ramp, same widths and the same
// travelling arrows as ntc-results, dashed so it stays clear which end of the line the
// model did not solve. `arrowImage` is the SDF arrow the page registered — each results
// page has its own id, and without one the arrows are simply left off.
function addExtFlowLayers(map, vis, arrowImage) {
  map.addSource('ext-flows', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'ext-flow-bg', type: 'line', source: 'ext-flows',
    layout: { visibility: vis, 'line-join': 'round' },
    paint: { 'line-color': UTIL_COLOR, 'line-width': FLOW_WIDTH, 'line-opacity': 0.88 } });
  if (arrowImage) {
    map.addLayer({ id: 'ext-flow-arrows', type: 'symbol', source: 'ext-flows',
      filter: ['>', ['get', 'vol'], 0],
      layout: { visibility: vis, 'icon-image': arrowImage, 'icon-allow-overlap': false,
        'symbol-placement': 'line', 'symbol-spacing': 55, 'icon-rotation-alignment': 'map', 'icon-size': 0.9 },
      paint: { 'icon-color': UTIL_COLOR } });
  }
  map.addLayer({ id: 'ext-flow-hit', type: 'line', source: 'ext-flows',
    layout: { visibility: vis },
    paint: { 'line-color': '#000000', 'line-width': 20, 'line-opacity': 0 } });
}

// Push a rebuilt data set into layers that already exist — what a year change needs.
// Rebuilding the layers instead would drop the toggle state and re-bind the handlers.
export function updateExtZoneData(map, data) {
  if (!map || !data) return;
  const fc = features => ({ type: 'FeatureCollection', features });
  source(map, 'ext-zones')?.setData(fc(data.extPolyFeatures));
  source(map, 'ext-ntc-lines')?.setData(fc(data.extLineFeatures));
  source(map, 'ext-nodes')?.setData(fc(data.extNodeFeatures));
}

// Hover popups for corridor lines, nodes and country bodies. Everything shown is read
// off the hovered feature, so these bind once and stay right as the year changes.
export function bindExtZoneHandlers(map, popup) {
  const clear = () => {
    map.getCanvas().style.cursor = '';
    if (layer(map, 'ext-zones-hover')) map.setFilter('ext-zones-hover', ['==', ['get', 'z'], '']);
    popup.remove();
  };

  map.on('mousemove', 'ext-ntc-lines-layer', e => {
    map.getCanvas().style.cursor = 'pointer';
    const p = e.features[0].properties;
    popup.setLngLat(e.lngLat)
      .setHTML(`<b>${p.z} ↔ ${p.zext}</b><br><span style="opacity:.75">NTC ${p.yr}: ${Math.round(p.ntc_mw).toLocaleString()} MW</span>`)
      .addTo(map);
  });
  map.on('mouseleave', 'ext-ntc-lines-layer', clear);

  const zoneInfo = (e, highlight) => {
    map.getCanvas().style.cursor = 'pointer';
    const p = e.features[0].properties;
    if (highlight && layer(map, 'ext-zones-hover')) map.setFilter('ext-zones-hover', ['==', ['get', 'z'], p.z]);
    let rows;
    try { rows = JSON.parse(p.links || '[]'); } catch { rows = []; }
    const html = rows.map(r =>
      '<div style="display:flex;justify-content:space-between;gap:12px">'
      + `<span style="opacity:.75">${r.z}</span>`
      + `<span style="font-weight:600">${Math.round(r.mw).toLocaleString()} MW</span></div>`
    ).join('');
    popup.setLngLat(e.lngLat)
      .setHTML(`<b>${p.z}</b> <span style="opacity:.55">· external</span><br>`
        + (html || '<span style="opacity:.6">No NTC data</span>'))
      .addTo(map);
  };
  map.on('mousemove', 'ext-nodes-circles', e => zoneInfo(e, false));
  map.on('mouseleave', 'ext-nodes-circles', clear);
  map.on('mousemove', 'ext-zones-fill', e => zoneInfo(e, true));
  map.on('mouseleave', 'ext-zones-fill', clear);
}

const HOURS_PER_YEAR = 8760;
const at = (tx, a, b, attr, y) => tx?.[a]?.[b]?.[attr]?.[y];

/** What crossed each external corridor in `year`, as line features for `ext-flows`.
 *
 *  EPM publishes exchange three ways and they are not equally good.
 *  pInterchangeExternalImports / …Exports are the real thing for a genuine neighbour:
 *  two directions, GWh, one row per corridor. pInterchange is the same thing for a
 *  corridor the model solved internally, which is what a promoted zone's is (see
 *  utils/zoneClass) — also two directions, also GWh. pNetImport carries a single net
 *  figure and is the only one that currently reaches output_csv for real neighbours, so
 *  it is the fallback — and a lossy one, since a corridor that imports and exports in
 *  different seasons collapses to one number.
 *
 *  The two directional sources are summed rather than chosen between. A real neighbour
 *  has no pInterchange and a promoted zone has no external symbols, so on either alone
 *  the sum is that one source; where a promoted corridor has been folded onto a real
 *  border with `as`, both are present and both crossed those wires. A feature says
 *  whether it came from a directional source at all, and the popup says so too.
 *
 *  `zones` restricts the internal end, for the country and single-zone maps. */
export function buildExtFlowFeatures({ tx, extNtc, zoneCentroids, extNodeCoords, year, zones = null }) {
  if (!year) return [];
  const y = String(year);

  const capYrs = extNtc?.length ? Object.keys(extNtc[0].years).sort() : [];
  const capYr = pickYear(capYrs, y);
  // Per direction, because the limits are: Trakia takes 334 MW from Bulgaria and sends
  // 200 MW back, so one denominator cannot serve both legs. `any` is the max of the two,
  // kept for the "does this corridor exist at all" test below.
  const capBy = {};
  for (const r of extNtc || []) {
    const k = `${r.z}||${r.zext}`;
    const c = (capBy[k] ||= { any: 0, in: 0, out: 0 });
    const any = r.years?.[capYr] || 0;
    c.any = Math.max(c.any, any);
    c.in  = Math.max(c.in,  r.capIn?.[capYr]  ?? any);
    c.out = Math.max(c.out, r.capOut?.[capYr] ?? any);
  }

  // Every corridor that has either a declared capacity or a published flow: a line that
  // carried nothing is a fact about the year, not a reason to leave it off the map.
  const pairs = new Map();
  for (const r of extNtc || []) pairs.set(`${r.z}||${r.zext}`, { z: r.z, zext: r.zext });
  for (const [a, bmap] of Object.entries(tx || {})) {
    for (const b of Object.keys(bmap || {})) {
      if (extNodeCoords[b] && zoneCentroids[a]) pairs.set(`${a}||${b}`, { z: a, zext: b });
      else if (extNodeCoords[a] && zoneCentroids[b]) pairs.set(`${b}||${a}`, { z: b, zext: a });
    }
  }

  const features = [];
  for (const { z, zext } of pairs.values()) {
    if (zones && !zones.has(z)) continue;
    const from = zoneCentroids[z], to = extNodeCoords[zext];
    if (!from || !to) continue;

    // Imports are what reached z, exports what left it, whichever symbol carries them.
    // pInterchange(a, b) is the flow from a to b, so the import leg is the zext -> z row.
    // The two external orientations are alternatives — GAMS writes the symbol one way
    // round and output_treatment normalises it, so only one of them ever answers — and
    // are read with ?? rather than added. The pInterchange leg is a different symbol
    // describing different wires, so it adds.
    const impExt = at(tx, zext, z, 'InterchangeExternalImports', y) ?? at(tx, z, zext, 'InterchangeExternalImports', y);
    const expExt = at(tx, z, zext, 'InterchangeExternalExports', y) ?? at(tx, zext, z, 'InterchangeExternalExports', y);
    const impInt = at(tx, zext, z, 'Interchange', y);
    const expInt = at(tx, z, zext, 'Interchange', y);
    const directional = [impExt, expExt, impInt, expInt].some(v => v != null);
    const imp = (impExt || 0) + (impInt || 0);
    const exp = (expExt || 0) + (expInt || 0);

    let net, vol;
    if (directional) { net = imp - exp; vol = Math.abs(imp) + Math.abs(exp); }
    else {
      const fwd = at(tx, z, zext, 'NetImport', y);
      const rev = at(tx, zext, z, 'NetImport', y);
      net = fwd != null ? fwd : (rev != null ? -rev : 0);
      vol = Math.abs(net);
    }

    const caps = capBy[`${z}||${zext}`] || { any: 0, in: 0, out: 0 };
    const { in: capIn, out: capOut } = caps;
    if (!vol && !caps.any) continue;

    // Each leg against its own limit, the way EPM's own pInterconUtilizationExternal*
    // are built. Summing both legs over a single limit — what this used to do — mixed a
    // two-direction numerator with a one-direction denominator and read a saturated
    // export corridor as half loaded.
    const lf = (gwh, mw) => (mw > 0 ? Math.min(1, (Math.abs(gwh) * 1e3) / (mw * HOURS_PER_YEAR)) : 0);
    const utilImp = lf(directional ? imp : Math.max(net, 0), capIn);
    const utilExp = lf(directional ? exp : Math.max(-net, 0), capOut);

    // The arrow follows the net: coordinates run from the zone out to the neighbour,
    // reversed when the zone is a net importer. The colour follows the arrow, so what the
    // line shows and what its shade means are the same direction. With no net either way,
    // the busier leg wins rather than silently picking one.
    const importing = net > 0;
    const util = net === 0 ? Math.max(utilImp, utilExp) : (importing ? utilImp : utilExp);
    const cap = net === 0 ? caps.any : (importing ? capIn : capOut);

    features.push({
      type: 'Feature',
      properties: { z, zext, imp, exp, net, vol, cap, capIn, capOut, util, utilImp, utilExp,
                    utilDir: net === 0 ? '' : (importing ? 'import' : 'export'), yr: y, capYr, directional },
      geometry: { type: 'LineString', coordinates: importing ? [to, from] : [from, to] },
    });
  }
  return features;
}

/** Push a rebuilt flow set into `ext-flows`, if this map has one. */
export function updateExtFlows(map, features) {
  source(map, 'ext-flows')?.setData({ type: 'FeatureCollection', features });
}

const gwh = v => `${Math.round(v).toLocaleString()} GWh`;

// Hover popup for the external corridors of a results map.
export function bindExtFlowHandlers(map, popup) {
  map.on('mousemove', 'ext-flow-hit', e => {
    map.getCanvas().style.cursor = 'pointer';
    const p = e.features[0].properties;
    const row = (k, v) => '<div style="display:flex;justify-content:space-between;gap:14px">'
      + `<span style="opacity:.75">${k}</span><span style="font-weight:600">${v}</span></div>`;
    let body;
    if (p.directional === true || p.directional === 'true') {
      body = row('Import', gwh(p.imp)) + row('Export', gwh(p.exp));
    } else {
      const dir = p.net > 0 ? 'net import' : p.net < 0 ? 'net export' : 'no exchange';
      body = row('Net exchange', `${gwh(Math.abs(p.net))} <span style="opacity:.6;font-weight:400">${dir}</span>`);
    }
    const mw = v => `${Math.round(v).toLocaleString()} MW`;
    if (p.cap > 0) {
      // Both limits when they differ, so the utilisation below is checkable from the popup.
      body += row('Capacity', p.capIn !== p.capOut && p.capIn > 0 && p.capOut > 0
        ? `${mw(p.capIn)} in · ${mw(p.capOut)} out` : mw(p.cap));
      // The shown figure is the leg the arrow points along, which is the one the colour
      // reads. The other leg follows in the muted style when it is not negligible, so a
      // corridor busy both ways cannot be mistaken for a quiet one.
      const pct = v => `${(v * 100).toFixed(0)}%`;
      const other = p.utilDir === 'import' ? p.utilExp : p.utilImp;
      const otherDir = p.utilDir === 'import' ? 'export' : 'import';
      const tail = p.utilDir && other >= 0.05
        ? ` <span style="opacity:.55;font-weight:400">· ${pct(other)} ${otherDir}</span>` : '';
      const dir = p.utilDir ? ` <span style="opacity:.6;font-weight:400">${p.utilDir}</span>` : '';
      body += row('Utilisation', `${pct(p.util)}${dir}${tail}`);
    }
    popup.setLngLat(e.lngLat)
      .setHTML(`<b>${p.z} ↔ ${p.zext}</b> <span style="opacity:.55">· external, ${p.yr}</span><br>${body}`)
      .addTo(map);
  });
  map.on('mouseleave', 'ext-flow-hit', () => { map.getCanvas().style.cursor = ''; popup.remove(); });
}

/** The border-price dots, dropped into the same marker list as the zone prices.
 *
 *  They are put on the internal scale but clamped to it rather than allowed to stretch
 *  it: a border price is an assumption, and one expensive neighbour must not wash out
 *  the colours of everything the model actually solved. What sets them apart visually
 *  is the dashed ring — utils/priceDot draws both, same box and same diameter, so a
 *  border price is never the heavier mark — and the tooltip says it is an input.
 *
 *  `colorFor` is the page's own ramp, so a border price and a zone price at the same
 *  level come out the same colour. */
export function addExtPriceDots(map, markers, opts) {
  const { zonesExtGJ, tradePrice, tradePriceExp, hoursData, year, min, rng, colorFor } = opts;
  if (!map || !year) return;
  for (const [zext, coord] of Object.entries(extNodeCoordMap(zonesExtGJ))) {
    const impP = weightedAvgPrice(tradePrice?.[zext]?.[year], hoursData);
    const expP = weightedAvgPrice(tradePriceExp?.[zext]?.[year], hoursData);
    if (impP == null && expP == null) continue;
    const t_ = Math.min(1, Math.max(0, ((impP ?? expP) - min) / (rng || 1)));
    const title = `${zext} — border price (input, ${year})`
      + (impP != null ? `\nImport ${impP.toFixed(1)} $/MWh` : '')
      + (expP != null ? `\nExport ${expP.toFixed(1)} $/MWh` : '');
    markers.push(new maplibregl.Marker({ element: priceDotEl(colorFor(t_), title, { external: true }), anchor: 'center' })
      .setLngLat(coord).addTo(map));
  }
}

// Show / hide all external-zone layers (toggle).
export function setExtZonesVisible(map, visible) {
  if (!map) return;
  const vis = visible ? 'visible' : 'none';
  for (const id of EXT_LAYER_IDS) if (layer(map, id)) map.setLayoutProperty(id, 'visibility', vis);
}
