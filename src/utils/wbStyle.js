import { useEffect, useState } from 'react';
import { WB_BASEMAP_STYLE_URL } from '../constants';
import { mix } from './color';

/**
 * The approved World Bank vector basemap, adapted to this app.
 *
 * The style at WB_BASEMAP_STYLE_URL (ArcGIS item dcc1c1c0f97f4e458199888b0fc63896)
 * is authored for one look: Esri's near-white World_Basemap_v2 canvas with the
 * Bank's political boundaries and names on top. Handing MapLibre that URL gave
 * up two things the app had: its six themes, three of them dark, stopped
 * reaching the map at all; and the boundary treatment, which relies on a
 * near-white "cutout" line to make dashes, only reads on that one canvas.
 *
 * So the style JSON is fetched once and transformed here before it reaches the
 * map. The transform keeps every World Bank layer -- its data, filters, zoom
 * ranges, fonts, dash rhythm -- and only re-derives colours and widths from the
 * theme, so the cartography stays the Bank's. It also
 *   - tags every layer with a group (layer.metadata['epm:group']) so the Esri
 *     canvas, its labels, the Bank's boundaries, names, admin levels and
 *     capitals can each be switched independently, and
 *   - lifts the declared minzoom of the capitals source, which the published
 *     style sets to 14 while the capitals layer stops at 11: as published,
 *     capitals can never draw.
 *
 * Nothing here adds geometry. Region and country fills, hover and click are
 * drawn by the pages from the app's own boundary extract (src/utils/basemap.js).
 */

// ── Groups ──────────────────────────────────────────────────────────────────
// canvas       Esri land, water and background: always shown, always themed
// canvasDetail Esri urban areas, parks, roads, buildings, patterns
// esriLabels   Esri place names and POI symbols
// boundaries   WB GAD ADM0 political boundaries (solid, dashed, dotted)
// admin1       WB GAD ADM1 boundaries
// admin2       WB GAD ADM2 boundaries
// countryNames WB GAD ADM0 labels -- the WB_GAD_Labels_012 country names
// adminLabels  WB GAD ADM1 and ADM2 labels
// capitals     WB GAD capitals
export const WB_GROUPS = ['canvas', 'canvasDetail', 'esriLabels', 'boundaries', 'admin1', 'admin2',
  'countryNames', 'adminLabels', 'capitals'];

/** Everything the basemap block of the layer panel controls. */
export const DEFAULT_WB_VIEW = {
  canvas: 'clean',        // 'clean' | 'detailed' | 'satellite'
  esriLabels: false,      // Esri place names (cities, seas, POIs)
  boundaries: true,       // WB ADM0 political boundaries
  countryNames: true,     // WB country names
  admin1: false,          // WB ADM1 boundaries + labels
  capitals: false,        // WB capitals
};

/**
 * Zone maps (a region's or country's EPM zones, and the results maps) carry
 * their own zone and corridor labels; the Bank's country names on top of them
 * only compete. Every other reference layer stays as on the world map.
 */
export const ZONE_MAP_VIEW = { ...DEFAULT_WB_VIEW, countryNames: false };

/**
 * The font the app's own map labels are set in. A style has one glyph
 * endpoint, and the Bank's (Esri's World_Basemap_v2 fonts) serves the Ubuntu
 * family only, so page labels use it too; any other name makes MapLibre fall
 * back to rendering every glyph locally.
 */
export const MAP_LABEL_FONT = ['Ubuntu Regular'];

const GROUP_KEY = 'epm:group';
const SATELLITE_LAYER = 'satellite-imagery';
const SATELLITE_SOURCE = 'satellite-imagery-src';

const WATER_RE = /^(Marine area|Water area|Water line|Special area of interest\/Water)/;

function groupOf(layer) {
  const src = layer.source;
  if (src === 'wbg_borders') {
    if (layer['source-layer'] === 'ADM1_Boundaries') return 'admin1';
    if (layer['source-layer'] === 'ADM2_Boundaries') return 'admin2';
    return 'boundaries';
  }
  if (src === 'wbg_admin_labels') return layer['source-layer'] === 'ADM0' ? 'countryNames' : 'adminLabels';
  if (src === 'wbg_places') return 'capitals';
  if (layer.type === 'background' || layer.id === 'Land') return 'canvas';
  if (layer.type === 'symbol') return 'esriLabels';
  if (WATER_RE.test(layer.id)) return 'canvas';
  return 'canvasDetail';
}

// ── Theming ─────────────────────────────────────────────────────────────────

/** Colours every canvas-derived paint is built from. */
function palette(t) {
  return {
    bg: t.bg,
    land: t.land,
    water: t.bg,
    waterLine: mix(t.bg, t.text, 0.18),
    detailFill: mix(t.land, t.text, 0.05),
    detailLine: mix(t.land, t.text, 0.16),
    boundary: t.worldBdr,
    // The subordinate levels fade toward the land colour.
    admin1: mix(t.worldBdr, t.land, 0.35),
    admin2: mix(t.worldBdr, t.land, 0.55),
    name: t.lblMuted,
    capital: t.lbl,
    halo: t.land,
  };
}

// The published "Solid" boundary is a 9.3 px pale band at z14 -- a design that
// only works in a colour barely off the canvas. Drawn in a theme colour it
// needs the weight of the Bank's dotted line instead.
const SOLID_WIDTH = { stops: [[1, 0.65], [7, 1.1], [10, 1.4], [14, 2.0], [17, 2.6]] };

// The Bank makes a dashed boundary by laying a near-white dashed line over a
// solid one ("Dashed Cutout", dasharray [7, 5]), so the solid shows through in
// 5-unit dashes with 7-unit gaps. That trick breaks on any tinted or dark land,
// so the dashed line gets a real dasharray with the same rhythm and the cutout
// is dropped.
const DASHED_ARRAY = [5, 7];

function themeWbLayer(layer, group, p) {
  const paint = { ...layer.paint };
  const layout = { ...layer.layout };
  if (group === 'boundaries') {
    if (layer.id.endsWith('/Dashed Cutout')) {
      layout.visibility = 'none';
    } else {
      paint['line-color'] = p.boundary;
      if (layer.id.endsWith('/Dashed Solid Line')) paint['line-dasharray'] = DASHED_ARRAY;
      if (layer.id.endsWith('/Solid')) paint['line-width'] = SOLID_WIDTH;
    }
  } else if (group === 'admin1' || group === 'admin2') {
    paint['line-color'] = p[group];
  } else if (group === 'countryNames' || group === 'adminLabels') {
    paint['text-color'] = p.name;
    paint['text-halo-color'] = p.halo;
  } else if (group === 'capitals') {
    paint['text-color'] = p.capital;
    paint['text-halo-color'] = p.halo;
  }
  return { ...layer, paint, layout };
}

function themeEsriLayer(layer, group, p) {
  const paint = { ...layer.paint };
  const layout = { ...layer.layout };
  if (layer.type === 'background') {
    paint['background-color'] = p.bg;
  } else if (layer.id === 'Land') {
    paint['fill-color'] = p.land;
  } else if (group === 'canvas') {
    if (layer.type === 'fill') {
      if (paint['fill-pattern']) layout.visibility = 'none';   // light-canvas sprites
      else paint['fill-color'] = p.water;
      delete paint['fill-outline-color'];
    } else if (layer.type === 'line') {
      paint['line-color'] = p.waterLine;
    }
  } else if (group === 'canvasDetail') {
    if (layer.type === 'fill') {
      if (paint['fill-pattern']) layout.visibility = 'none';
      else paint['fill-color'] = p.detailFill;
      delete paint['fill-outline-color'];
    } else if (layer.type === 'line') {
      if (paint['line-pattern']) layout.visibility = 'none';
      else paint['line-color'] = p.detailLine;
    }
  } else if (group === 'esriLabels') {
    if ('text-color' in paint || layout['text-field']) {
      paint['text-color'] = p.name;
      paint['text-halo-color'] = p.halo;
    }
  }
  return { ...layer, paint, layout };
}

/**
 * Whether a group is shown under a view. Satellite hides the whole Esri canvas
 * (the background stays: imagery tiles are missing at the poles).
 */
function groupVisible(group, view) {
  switch (group) {
    case 'canvas':       return true;
    case 'canvasDetail': return view.canvas === 'detailed';
    case 'esriLabels':   return !!view.esriLabels;
    case 'boundaries':   return !!view.boundaries;
    case 'admin1':       return !!view.admin1;
    case 'admin2':       return false;                    // z6+ hairlines; noise under overlays
    case 'countryNames': return !!view.countryNames;
    case 'adminLabels':  return !!view.admin1;
    case 'capitals':     return !!view.capitals;
    default:             return true;
  }
}

function layerVisible(layer, group, view) {
  if (!groupVisible(group, view)) return false;
  if (view.canvas === 'satellite' && layer.source === 'esri' && group === 'canvas') return false;
  return true;
}

// ── Build ───────────────────────────────────────────────────────────────────

let stylePromise = null;
let styleBase = null;

/** The published style JSON, fetched once per session. */
export function fetchWbStyle() {
  if (!stylePromise) {
    stylePromise = fetch(WB_BASEMAP_STYLE_URL).then(r => {
      if (!r.ok) throw new Error(`WB basemap style: HTTP ${r.status}`);
      return r.json();
    }).then(json => { styleBase = json; return json; })
      .catch(err => { stylePromise = null; throw err; });
  }
  return stylePromise;
}

/**
 * The published style JSON for a page to build from, or null until it has
 * arrived. Pages gate map creation on it the way they gate on regions.json, so
 * the style can be built synchronously where the map is made.
 */
export function useWbStyleBase() {
  const [base, setBase] = useState(styleBase);
  useEffect(() => {
    if (base) return;
    let alive = true;
    fetchWbStyle().then(json => { if (alive) setBase(json); })
      .catch(err => console.error('World Bank basemap style', err));
    return () => { alive = false; };
  }, [base]);
  return base;
}

function satelliteLayer() {
  return { id: SATELLITE_LAYER, type: 'raster', source: SATELLITE_SOURCE, metadata: { [GROUP_KEY]: 'satellite' } };
}

const SATELLITE_SOURCE_DEF = {
  type: 'raster',
  tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
  tileSize: 256,
  attribution: 'Tiles © Esri — Source: Esri, Maxar, GeoEye, Earthstar Geographics',
};

/**
 * The World Bank style as a MapLibre style object for one theme and view.
 *
 * @param {object} base  the published style JSON, from useWbStyleBase()
 * @param {object} t     the active theme, see getT() in src/constants.js
 * @param {object} view  see DEFAULT_WB_VIEW
 */
export function buildWbStyle(base, t, view = DEFAULT_WB_VIEW) {
  const p = palette(t);
  const layers = [];
  for (const layer of base.layers) {
    const group = groupOf(layer);
    const themed = (layer.source === 'esri' || layer.type === 'background')
      ? themeEsriLayer(layer, group, p)
      : themeWbLayer(layer, group, p);
    if (!layerVisible(layer, group, view)) themed.layout.visibility = 'none';
    themed.metadata = { ...(layer.metadata || {}), [GROUP_KEY]: group };
    layers.push(themed);
    // Imagery is the canvas: straight above the background, under everything a
    // page draws and under the Bank's political stack.
    if (layer.type === 'background' && view.canvas === 'satellite') layers.push(satelliteLayer());
  }
  const sources = { ...base.sources };
  // Published with minzoom 14 for a layer that ends at z11 -- see header.
  if (sources.wbg_places) sources.wbg_places = { ...sources.wbg_places, minzoom: 0 };
  if (view.canvas === 'satellite') sources[SATELLITE_SOURCE] = SATELLITE_SOURCE_DEF;
  return { ...base, sources, layers };
}

// ── Runtime ─────────────────────────────────────────────────────────────────

function groupOfLayer(layer) {
  return layer.metadata?.[GROUP_KEY];
}

/** The layer just above the style's background, where imagery goes. */
function aboveBackground(map) {
  const layers = map.getStyle()?.layers || [];
  const i = layers.findIndex(l => l.type === 'background');
  return layers[i + 1]?.id;
}

/**
 * Apply a view to a live map built by buildWbStyle(): group visibility, and
 * the imagery layer added or removed just above the background.
 */
export function applyWbView(map, view) {
  if (!map?.isStyleLoaded?.()) return;
  const layers = map.getStyle()?.layers || [];
  for (const layer of layers) {
    const group = groupOfLayer(layer);
    if (!group || group === 'satellite') continue;
    const want = layerVisible(layer, group, view) && !isPermanentlyHidden(layer);
    try { map.setLayoutProperty(layer.id, 'visibility', want ? 'visible' : 'none'); } catch { /* style race */ }
  }
  const hasSat = !!map.getLayer(SATELLITE_LAYER);
  if (view.canvas === 'satellite' && !hasSat) {
    if (!map.getSource(SATELLITE_SOURCE)) map.addSource(SATELLITE_SOURCE, SATELLITE_SOURCE_DEF);
    map.addLayer(satelliteLayer(), aboveBackground(map));
  } else if (view.canvas !== 'satellite' && hasSat) {
    map.removeLayer(SATELLITE_LAYER);
  }
}

// Pattern fills and the dashed cutout are hidden by the transform regardless
// of view, so a view change must not switch them back on.
function isPermanentlyHidden(layer) {
  return layer.id.endsWith('/Dashed Cutout')
    || !!layer.paint?.['fill-pattern'] || !!layer.paint?.['line-pattern'];
}

/**
 * Where a page inserts its area fills: just above Esri's land, below its water
 * and detail. Water then paints over any fill that spills across the Esri
 * shoreline -- our GAD polygons and Esri's coastline are different products
 * and never coincide exactly -- so a fill can only ever show on land.
 */
export function fillAnchor(map) {
  const layers = map.getStyle()?.layers || [];
  const i = layers.findIndex(l => l.id === 'Land');
  return i >= 0 && layers[i + 1] ? layers[i + 1].id : undefined;
}

/**
 * Lift the Bank's political boundaries and names back above everything a page
 * added after the style loaded, keeping their own order. Operational overlays
 * must never obscure them.
 */
export function raiseWbReference(map) {
  const layers = map.getStyle()?.layers || [];
  for (const layer of layers) {
    const group = groupOfLayer(layer);
    if (!group || group === 'canvas' || group === 'canvasDetail' || group === 'satellite') continue;
    try { map.moveLayer(layer.id); } catch { /* style race during teardown */ }
  }
}
