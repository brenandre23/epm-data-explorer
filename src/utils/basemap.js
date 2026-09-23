/**
 * Interaction geometry and the layers pages draw from it.
 *
 * The basemap itself -- land, water, political boundaries, names -- is the
 * approved World Bank vector style (see src/utils/wbStyle.js). What the app
 * draws from its own geometry is only what the basemap cannot know: which
 * countries belong to the region on screen and which one is hovered. That
 * geometry is the World Bank Official Boundaries extract tools/prepare_boundaries.py
 * writes into public/data.
 *
 * Features carrying STATUS 'non-determined' are the areas the Bank does not
 * attribute to any country (Western Sahara, Abyei, Arunachal Pradesh, the
 * Kashmir area north of the line of control, the Kuril Islands, the UN buffer
 * zone in Cyprus). They never carry a country code, which is what keeps every
 * ISO_A3-keyed layer and click handler from picking them up. Their outlines,
 * like every border, come from the basemap.
 */

import { raiseWbReference, fillAnchor } from './wbStyle';
import { dataPath } from './paths';

/** Country features only: everything the Bank attributes to a country. */
export const COUNTRY_ONLY = ['!=', ['get', 'STATUS'], 'non-determined'];
/** The unattributed areas. */
export const NON_DETERMINED_ONLY = ['==', ['get', 'STATUS'], 'non-determined'];

// countries_10m.geojson is 8.7 MB, and a map is rebuilt on every theme change, run
// change and page move. Each file is therefore fetched once per session and shared:
// the source data is handed to maplibre, which copies it to its worker, so nothing
// downstream depends on getting its own object. A rejected fetch is dropped from the
// cache, or one bad moment on the network would hold for the whole session.
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

/** The 10m files are the detailed ones. On a connection that cannot bring 8.7 MB back,
 *  a coarser border is worth more than no border at all. */
async function atBestResolution(resolution, load) {
  try {
    return await load(resolution);
  } catch (err) {
    if (resolution === '110m') throw err;
    console.warn(`basemap ${resolution} unavailable, falling back to 110m`, err);
    return load('110m');
  }
}

/**
 * Load a boundary layer. Feature ids are assigned here because MapLibre needs
 * them for setFeatureState and the source is loaded with generateId: false.
 *
 * @param {'10m'|'110m'} resolution
 */
export async function fetchCountries(resolution = '10m') {
  const fc = await atBestResolution(resolution, r => fetchJson(dataPath(`countries_${r}.geojson`)));
  fc.features.forEach((f, i) => { f.id = i; });
  return fc;
}

/**
 * @param {import('maplibre-gl').Map} map
 * @param {object} countries  a FeatureCollection from fetchCountries()
 */
export function addCountriesSource(map, countries) {
  map.addSource('countries', { type: 'geojson', data: countries, generateId: false });
}

/**
 * Load the Bank's boundary lines for a resolution. The basemap draws every
 * border; these lines are only used to outline a region's non-determined
 * areas, see addRegionCoast().
 *
 * @param {'10m'|'110m'} resolution
 */
export async function fetchBoundaries(resolution = '10m') {
  return atBestResolution(resolution, r => fetchJson(dataPath(`boundaries_${r}.geojson`)));
}

/**
 * @param {import('maplibre-gl').Map} map
 * @param {object} boundaries  a FeatureCollection from fetchBoundaries()
 */
export function addBoundariesSource(map, boundaries) {
  map.addSource('boundaries', { type: 'geojson', data: boundaries });
}

/**
 * Match a region's own countries plus the unattributed areas assigned to it.
 *
 * The Bank attributes such an area to no country, so it carries no code and no
 * ISO_A3 filter can reach it -- but it still lies inside the region a map is
 * about, and leaving it blank in the middle of a coloured region reads as a
 * hole. It takes the region fill like any member country; only its outline
 * stays broken. Areas come from the `non_determined` list in regions.json and
 * are matched on WB_NAME, the only name they carry.
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

/**
 * Draw the coastline of a region's unattributed areas at the region's own
 * border weight.
 *
 * A region highlight outlines its member countries by ISO_A3, and an
 * unattributed area carries no ISO_A3 -- by construction, that is what makes it
 * unattributed. Its shore is therefore left with only the basemap's thin
 * coastline under it and reads about half as thick as the shore of the country next
 * door. This lays the region's own border weight back over it. The filter takes
 * STYLE '' only, so the broken land boundaries are untouched: an area gains the
 * coastline of a member country and keeps the outline the Bank prescribes.
 *
 * Call it straight after the region-border layer, with that layer's paint.
 *
 * @param {import('maplibre-gl').Map} map
 * @param {object} opts
 * @param {string[]} opts.areas  WB_NAME of each unattributed area in the region
 * @param {string|unknown[]} opts.color  line-color, keyed on NAME if data-driven
 * @param {number} opts.width
 * @param {number} opts.opacity
 */
export function addRegionCoast(map, { areas, color, width, opacity }) {
  if (!areas?.length) return;
  map.addLayer({
    id: 'region-coast', type: 'line', source: 'boundaries',
    filter: ['all', ['==', ['get', 'STYLE'], ''],
      ['in', ['get', 'NAME'], ['literal', areas]]],
    paint: { 'line-color': color, 'line-width': width, 'line-opacity': opacity },
  });
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
