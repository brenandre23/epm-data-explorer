/**
 * Interaction geometry and the layers pages draw from it.
 *
 * The basemap itself -- land, water, political boundaries, names -- is the
 * approved World Bank vector style (see src/utils/wbStyle.js). What the app
 * draws from its own geometry is only what the basemap cannot know: which
 * countries belong to the region on screen and which one is hovered. That
 * geometry is the World Bank GAD extract tools/prepare_gad.py writes into
 * public/data/geo -- the same product the basemap's boundary tiles are built
 * from, so a fill or highlight outline lands on the basemap's own border.
 *
 * Features carrying STATUS 'non-determined' are the areas the Bank does not
 * attribute to any country (Western Sahara, Abyei, Arunachal Pradesh, the
 * Kashmir area north of the line of control, the Kuril Islands, the UN buffer
 * zone in Cyprus). They carry STATUS 'non-determined' and never a country code, which is what keeps every
 * ISO_A3-keyed layer and click handler from picking them up. Their outlines,
 * like every border, come from the basemap.
 */

import { raiseWbReference, fillAnchor } from './wbStyle';
import { dataPath } from './paths';

/** The unattributed areas. */
export const NON_DETERMINED_ONLY = ['==', ['get', 'STATUS'], 'non-determined'];

// A map is rebuilt on every theme change, run change and page move. Each file is
// therefore fetched once per session and shared: the source data is handed to
// maplibre, which copies it to its worker, so nothing downstream depends on getting
// its own object. A rejected fetch is dropped from the cache, or one bad moment on
// the network would hold for the whole session.
const files = new Map();

function fetchJson(path) {
  if (!files.has(path)) {
    files.set(path, fetch(path).then(r => {
      // Without this a 404 reaches r.json() and fails as a parse error on the HTML the
      // server sent instead, which says nothing about what actually happened.
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r.json();
    }).catch(err => { files.delete(path); throw err; }));
  }
  return files.get(path);
}

/**
 * The FeatureCollection in one of the extract's TopoJSON files. It reads only
 * what tools/prepare_gad.py topology() writes -- quantized, delta-encoded, one
 * arc per ring, MultiPolygons -- not TopoJSON at large. Feature ids are
 * assigned here because MapLibre needs them for setFeatureState and the
 * source is loaded with generateId: false.
 */
function fromTopology(topo) {
  const { scale: [sx, sy], translate: [tx, ty] } = topo.transform;
  const rings = topo.arcs.map(arc => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => [(x += dx) * sx + tx, (y += dy) * sy + ty]);
  });
  return {
    type: 'FeatureCollection',
    features: topo.objects.features.geometries.map((g, i) => ({
      type: 'Feature',
      id: i,
      properties: g.properties,
      geometry: { type: 'MultiPolygon', coordinates: g.arcs.map(poly => poly.map(([a]) => rings[a])) },
    })),
  };
}

/**
 * Load one of the extract's files. Feature ids are assigned here because
 * MapLibre needs them for setFeatureState and the source is loaded with
 * generateId: false.
 *
 * @param {'world'|'region'|'country'} kind  world: every country, coarse;
 *   region: a region's members and its areas; country: one country and the
 *   areas it is a party to -- both in detail
 * @param {string} [id]  region id or ISO_A3; none for 'world'
 */
export async function fetchGeo(kind, id) {
  const topo = await fetchJson(dataPath(kind === 'world' ? 'geo/world.topo.json' : `geo/${kind}/${id}.topo.json`));
  return fromTopology(topo);
}

let bboxesPromise = null;
/** Extents of every country and region, keyed by ISO_A3 / region id. */
export function fetchBboxes() {
  if (!bboxesPromise) {
    bboxesPromise = fetchJson(dataPath('geo/bboxes.json'))
      .catch(err => { bboxesPromise = null; throw err; });
  }
  return bboxesPromise;
}

/**
 * MapLibre bounds for a country or region, padded in degrees, or null when
 * the extract has no such feature.
 *
 * @param {object} bboxes  from fetchBboxes()
 * @param {'countries'|'regions'} kind
 */
export function boundsFor(bboxes, kind, id, pad = 0.5) {
  const b = bboxes?.[kind]?.[id];
  if (!b) return null;
  return [[b[0] - pad, b[1] - pad], [b[2] + pad, b[3] + pad]];
}

/**
 * @param {import('maplibre-gl').Map} map
 * @param {object} fc  a FeatureCollection from fetchGeo()
 */
export function addCountriesSource(map, fc) {
  map.addSource('countries', { type: 'geojson', data: fc, generateId: false });
}

/**
 * Match a region's own countries plus the unattributed areas assigned to it.
 *
 * The Bank attributes such an area to no country, so it carries no code and no
 * ISO_A3 filter can reach it -- but it still lies inside the region a map is
 * about, and leaving it blank in the middle of a coloured region reads as a
 * hole. It takes the region fill like any member country; its outline, dashed
 * or dotted, is the basemap's. Areas come from the `non_determined` list in
 * regions.json (kept in step with the extract by tools/prepare_gad.py) and are
 * matched on WB_NAME, the only name they carry.
 *
 * @param {string[]} isos
 * @param {string[]} [areas]  WB_NAME of each unattributed area in the region
 */
export function regionFilter(isos, areas = []) {
  const byIso = ['in', ['get', 'ISO_A3'], ['literal', isos]];
  if (!areas.length) return byIso;
  return ['any', byIso,
    ['all', NON_DETERMINED_ONLY, ['in', ['get', 'WB_NAME'], ['literal', areas]]]];
}

// The two contested territories the app names. Bank style sets their names in
// italics wherever they appear; the map's own labels follow the same rule (see
// ITALIC_ADM0_LABELS in wbStyle.js).
const ITALIC_NAMES = new Set(['West Bank and Gaza', 'Western Sahara']);

/** True for a name Bank style sets in italics. */
export function isItalicName(name) {
  return ITALIC_NAMES.has(name);
}

/** A name for popup HTML, italicised where Bank style asks. */
export function nameHtml(name) {
  return isItalicName(name) ? `<i>${name}</i>` : name;
}

/**
 * Whether the app may name a feature, from its properties. Countries yes; of
 * the non-determined areas only the contested territories above -- the rest
 * stay unnamed, on the map and in popups alike.
 */
export function isNamed(props) {
  return props.STATUS !== 'non-determined' || isItalicName(props.WB_NAME);
}

/**
 * Put a page's layers in cartographic order once it has added them:
 *   - country fills go just above the basemap's land, below its water, so a
 *     fill never spills past the Bank's coastline (the extract's coast and the
 *     basemap's are different products and never coincide exactly);
 *   - the Bank's boundaries and names go back on top, above every overlay.
 *
 * @param {import('maplibre-gl').Map} map
 */
export function raiseBoundaries(map) {
  const anchor = fillAnchor(map);
  if (anchor) {
    for (const l of map.getStyle()?.layers || []) {
      if (l.type === 'fill' && l.source === 'countries') {
        try { map.moveLayer(l.id, anchor); } catch { /* style race during teardown */ }
      }
    }
  }
  raiseWbReference(map);
}
