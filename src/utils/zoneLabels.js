// Zone names on a results map: off unless asked for, and quiet when on.
//
// The results maps name nothing but the zone a zone page is about. That keeps the data in
// front, but a map shared in a deck or read next to a chart needs its zones named, and one
// hover at a time does not do it. So the names are a toggle, off by default.
//
// The map style carries no glyphs, so MapLibre cannot write text itself: each name is a DOM
// marker, like the donuts and the price dots it sits under, which also puts it in the PNG
// MapDownload takes. It is small, muted and haloed in the map's background colour, so it
// reads on any fill without competing with the data, and it never takes the pointer, so
// the hover and the click on the zone underneath still work.
//
// The external neighbours are named with the internal zones when both are on the map:
// naming one side only would make it the labelled half of the picture (see extZones.js).
//
// The choice is kept per browser: whoever turns it on for a screenshot wants it on the next
// page too.

import { useEffect, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { zoneCentroidMap } from './centroids';
import { extNodeCoordMap } from './extZones';

const KEY = 'epm.zoneLabels';

function readPref() {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

/** [on, setOn] for the zone names, remembered in this browser. */
export function useZoneLabels() {
  const [on, setOn] = useState(readPref);
  useEffect(() => {
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* storage blocked: the toggle still works */ }
  }, [on]);
  return [on, setOn];
}

/** The element one name is drawn with. `tv` is the theme (constants.getT). */
export function zoneLabelEl(text, tv) {
  const el = document.createElement('div');
  el.style.cssText = `font-size:0.45rem;font-weight:600;font-family:"Open Sans", system-ui, sans-serif;color:${tv.muted};`
    + `white-space:nowrap;pointer-events:none;`
    + `text-shadow:0 0 2px ${tv.bg},0 0 2px ${tv.bg},0 0 3px ${tv.bg};`;
  el.textContent = text;
  return el;
}

/**
 * Keeps one name under each zone of `mapRef`'s map while `on`.
 *
 * @param zones      the internal zones to name, placed on their centroids
 * @param zonesExtGJ the external zones to name too, on their nodes; null to name none
 * @param zoneOffset px between a centroid and the top of its name: whatever the page draws
 *                   on the centroid (a donut, a price dot) has to stay clear
 * @param extOffset  the same for the external nodes
 * @param ready      bumps when the map (re)loads, so the names follow a rebuilt map
 */
export function useZoneLabelMarkers(mapRef, { on, zones, zonesGJ, linestringGJ, zonesExtGJ,
  zoneOffset = 8, extOffset = 8, tv, ready }) {
  const zonesKey = (zones || []).join('|');
  useEffect(() => {
    const map = mapRef.current;
    if (!on || !map || !zonesGJ) return undefined;
    const markers = [];
    const add = (z, coord, dy) => markers.push(
      new maplibregl.Marker({ element: zoneLabelEl(z, tv), anchor: 'top', offset: [0, dy] }).setLngLat(coord).addTo(map));
    const centroids = zoneCentroidMap(zonesGJ, linestringGJ);
    for (const z of zones || []) if (centroids[z]) add(z, centroids[z], zoneOffset);
    for (const [z, coord] of Object.entries(extNodeCoordMap(zonesExtGJ))) add(z, coord, extOffset);
    return () => markers.forEach(m => m.remove());
  }, [on, zonesKey, zonesGJ, linestringGJ, zonesExtGJ, zoneOffset, extOffset, tv.muted, tv.bg, ready]); // eslint-disable-line
}
