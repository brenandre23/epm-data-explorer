/**
 * The map of an EPM page in two parts, so the map is up before the model data:
 *
 * - useBaseMap() builds the map from what the page knows at once -- the basemap
 *   and a frame from bboxes.json -- and hands it back when its style has loaded.
 * - drawLayers() draws a page's model layers on it when the data arrives, and
 *   returns what takes them off again, so a change of data swaps the layers
 *   without rebuilding the map and losing the user's view.
 */
import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { getT } from '../constants';
import { buildWbStyle } from './wbStyle';
import { fetchBboxes, boundsFor } from './basemap';

// What each map was last framed on by its page's own data; the bboxes frame
// stands down once a map is in here.
const framed = new WeakMap();

/**
 * Frame a map from its data, once per subject: the first draw of a page's layers
 * frames the map, and later ones (another folder, zone map or year) leave the
 * user's view alone -- unless the page moved to another country or zone on the
 * same map, which is framed afresh.
 *
 * @param {import('maplibre-gl').Map} map
 * @param {string} subject  what the page is about, e.g. the country or zone
 * @param {(map: import('maplibre-gl').Map) => void} frame
 */
export function frameOnce(map, subject, frame) {
  if (framed.get(map) === subject) return;
  framed.set(map, subject);
  frame(map);
}

/**
 * Build a page's map and return it once its style has loaded (null until then,
 * and again while it is rebuilt). The map is rebuilt when the theme, basemap view
 * or scope changes; anything else a page draws goes through drawLayers(). Moving
 * to another country or zone in the same scope keeps the map: the page frames it
 * from its data (frameOnce).
 *
 * @param {{ current: HTMLElement|null }} containerRef
 * @param {{ current: object|null }} mapRef  set to the map as it is built
 * @param {object} opts
 * @param {object|null} opts.wbBase  the published basemap style (useWbStyleBase)
 * @param {string} opts.theme
 * @param {object} opts.view  basemap view for buildWbStyle
 * @param {string|null} opts.scope  what the map is about -- the region; the map
 *   is rebuilt when it changes, and not built while it is null
 * @param {{ kind: 'countries'|'regions', id: string }|null} opts.frame  where a
 *   new map opens, from bboxes.json, until the page frames it from its data
 */
export function useBaseMap(containerRef, mapRef, { wbBase, theme, view, scope, frame }) {
  const [baseMap, setBaseMap] = useState(null);
  const frameRef = useRef(frame);
  frameRef.current = frame;
  useEffect(() => {
    const frame = frameRef.current;
    if (!containerRef.current || !wbBase || !scope || !frame) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildWbStyle(wbBase, getT(theme), view),
      center: [20, 0], zoom: 2, minZoom: 1, maxZoom: 14,
      canvasContextAttributes: { preserveDrawingBuffer: true }, attributionControl: false,
    });
    mapRef.current = map;
    let live = true;
    // The bboxes file is small and usually cached by the world page already.
    fetchBboxes().then(bboxes => {
      const bounds = boundsFor(bboxes, frame.kind, frame.id, 0.5);
      if (live && bounds && !framed.has(map)) map.fitBounds(bounds, { padding: 40, duration: 0 });
    }).catch(err => console.error('bboxes', err));
    map.once('style.load', () => { if (live) setBaseMap(map); });
    return () => {
      live = false;
      setBaseMap(null);
      map.remove();
      if (mapRef.current === map) mapRef.current = null;
    };
  }, [wbBase, theme, view, scope]); // eslint-disable-line react-hooks/exhaustive-deps
  return baseMap;
}

/**
 * Run `draw`, which adds sources, layers and images to the map and binds
 * handlers to its layers, and return a function that takes all of it off again.
 * A layer handler outlives its layer, and an image name can be added only once:
 * without this, drawing again would fire the old handlers too, or throw.
 * Only top-level `map.on` calls are recorded; map.on calls itself for a layer's
 * delegates.
 *
 * @param {import('maplibre-gl').Map} map
 * @param {() => void} draw
 * @returns {() => void}
 */
export function drawLayers(map, draw) {
  const before = map.getStyle();
  const layersBefore = new Set(before.layers.map(l => l.id));
  const sourcesBefore = new Set(Object.keys(before.sources));
  const imagesBefore = new Set(map.listImages());

  const bound = [];
  const on = map.on;
  let depth = 0;
  map.on = (...args) => {
    if (depth === 0) bound.push(args);
    depth++;
    try { return on.apply(map, args); } finally { depth--; }
  };
  try { draw(); } finally { delete map.on; }

  const after = map.getStyle();
  const layers = after.layers.map(l => l.id).filter(id => !layersBefore.has(id));
  const sources = Object.keys(after.sources).filter(id => !sourcesBefore.has(id));
  const images = map.listImages().filter(id => !imagesBefore.has(id));
  return () => {
    for (const args of bound) map.off(...args);
    for (const id of [...layers].reverse()) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of sources) if (map.getSource(id)) map.removeSource(id);
    for (const id of images) if (map.hasImage(id)) map.removeImage(id);
  };
}

/**
 * The ISO code of a region member from the name a model gives it, which need not
 * be the Bank's ("Burkina" for Burkina Faso), or null when no name matches; the
 * page then frames the region until its zones are in.
 *
 * @param {object} region  an entry of regions.json
 * @param {string} name
 */
export function memberIso(region, name) {
  const norm = s => (s || '').toLowerCase().replace(/[^a-z]/g, '');
  const n = norm(name);
  if (!n) return null;
  const hit = region.countries.find(c => norm(c.name) === n)
    || region.countries.find(c => norm(c.name).startsWith(n) || n.startsWith(norm(c.name)));
  return hit?.iso || null;
}
