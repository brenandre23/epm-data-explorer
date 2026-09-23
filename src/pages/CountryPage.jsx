import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import MapDownload from '../components/MapDownload';
import { ttl } from '../utils/chartTitle';
import { useTheme } from '../App';
import { getT, FUEL_COLORS, VOLTAGE_BRACKETS, plantRadiusExpr, lcRadiusExpr } from '../constants';
import LayerPanel from '../components/LayerPanel';
import CountryOverview from '../components/CountryOverview';
import REResourcesTab from '../components/tabs/REResourcesTab';
import LoadTab from '../components/tabs/LoadTab';
import ZoningTab from '../components/tabs/ZoningTab';
import { fetchCountries, fetchBoundaries, addCountriesSource, addBoundariesSource, raiseBoundaries } from '../utils/basemap';
import { buildWbStyle, applyWbView, useWbStyleBase, DEFAULT_WB_VIEW, MAP_LABEL_FONT } from '../utils/wbStyle';
import { source, layer } from '../utils/mapSource';
import { dataPath } from '../utils/paths';

function downloadBlob(content, filename, type = 'application/octet-stream') {
  const blob = new Blob([content], { type });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Ray-casting point-in-polygon (handles Polygon + MultiPolygon)
function pointInRing(pt, ring) {
  let inside = false;
  const [x, y] = pt;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}
function pointInFeature(pt, feature) {
  const g = feature.geometry;
  if (g.type === 'Polygon')
    return g.coordinates.some(ring => pointInRing(pt, ring));
  if (g.type === 'MultiPolygon')
    return g.coordinates.some(poly => poly.some(ring => pointInRing(pt, ring)));
  return false;
}

function fitBoundsCountry(iso, countries) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const f of countries.features) {
    if (f.properties.ISO_A3 !== iso) continue;
    const geom = f.geometry;
    const rings = geom.type === 'Polygon'
      ? geom.coordinates
      : geom.coordinates.flatMap(p => p);
    for (const ring of rings)
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
      }
  }
  if (!isFinite(minLon)) return null;
  return [[minLon - 0.8, minLat - 0.8], [maxLon + 0.8, maxLat + 0.8]];
}

export default function CountryPage() {
  const { iso }      = useParams();
  const { theme }    = useTheme();
  const wbBase = useWbStyleBase();
  const [wbView, setWbView] = useState(DEFAULT_WB_VIEW);
  const wbViewRef = useRef(wbView);   // what a rebuilt map (theme change) starts from
  const t            = getT(theme);

  const containerRef = useRef(null);
  const mapRef       = useRef(null);

  const [info,         setInfo]         = useState(null);  // { country, region }
  const [presentFuels, setPresentFuels] = useState(new Set());
  const [fuelsOff,     setFuelsOff]     = useState(new Set());
  const [kvsOff,       setKvsOff]       = useState(new Set());
  const [linesOn,      setLinesOn]      = useState(true);
  const [plantsOn,     setPlantsOn]     = useState(true);
  const [subsOn,       setSubsOn]       = useState(false);
  const [minMw,        setMinMw]        = useState(100);
  const [circleScale,  setCircleScale]  = useState(1.0);
  const [plantSource,        setPlantSource]        = useState('osm');
  const [gppdAvailable,      setGppdAvailable]      = useState(null);
  const [capacity,           setCapacity]           = useState(null);
  const [fleetAge,           setFleetAge]           = useState(null);
  const [tariffs,            setTariffs]            = useState(null);
  const [access,             setAccess]             = useState(null);
  const [filteredPlantsData, setFilteredPlantsData] = useState(null);
  const [filteredLinesData,  setFilteredLinesData]  = useState(null);
  const [countryCenter,      setCountryCenter]      = useState(null);
  const [activeTab,          setActiveTab]          = useState('overview');
  const [loadCentersOn,      setLoadCentersOn]      = useState(true);
  const [lcMinPop,           setLcMinPop]           = useState(300_000);
  const [lcCircleScale,      setLcCircleScale]      = useState(1.0);
  const [zoneMode,           setZoneMode]           = useState('plain');
  const [nZones,             setNZones]             = useState(null);
  const [zonesIndex,         setZonesIndex]         = useState(null);
  const [zoneLabelsOn,       setZoneLabelsOn]       = useState(true);
  const [zoneCorridorsOn,    setZoneCorridorsOn]    = useState(false);
  const mapReadyRef        = useRef(false);
  const countryFeatureRef  = useRef(null);

  // Static data — fetch once
  useEffect(() => {
    fetch(dataPath('tariffs.json')).then(r => r.json()).then(setTariffs).catch(() => {});
    fetch(dataPath('access.json')).then(r => r.json()).then(setAccess).catch(() => {});
    fetch(dataPath('zones/index.json')).then(r => r.json()).then(setZonesIndex).catch(() => setZonesIndex({}));
  }, []);

  useEffect(() => {
    fetch(dataPath('regions.json')).then(r => r.json()).then(d => {
      for (const region of (d.regions || [])) {
        const country = region.countries.find(c => c.iso === iso);
        if (country) {
          setInfo({ country, region });
          // Check GPPD availability for this region
          fetch(dataPath(`cache/region_plants_${region.id}_gppd.geojson`), { method: 'HEAD' })
            .then(r => setGppdAvailable(r.ok))
            .catch(() => setGppdAvailable(false));
          return;
        }
      }
    });
    setFuelsOff(new Set()); setKvsOff(new Set());
    setLinesOn(true); setPlantsOn(true); setSubsOn(false); setMinMw(100); setCircleScale(1.0);
    setLcCircleScale(1.0);
    setPlantSource('osm'); setGppdAvailable(null); setCountryCenter(null);
    setZoneMode('plain'); setNZones(null); setZoneLabelsOn(true);
    mapReadyRef.current = false;
    countryFeatureRef.current = null;
  }, [iso]);

  useEffect(() => {
    if (!containerRef.current || !info || !wbBase) return;
    const { region } = info;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildWbStyle(wbBase, getT(theme), wbViewRef.current),
      center: [0, 20], zoom: 2,
      minZoom: 1, maxZoom: 16,
      canvasContextAttributes: { preserveDrawingBuffer: true }, attributionControl: false,
    });
    mapRef.current = map;

    const popup = new maplibregl.Popup({
      closeButton: false, closeOnClick: false, offset: 10,
      className: `popup-${theme}`,
    });

    map.on('load', async () => {
      const [countries, boundaries, plantsGJ, linesGJ, subsGJ, lcGJ, admin1GJ] = await Promise.all([
        fetchCountries('10m'),
        fetchBoundaries('10m'),
        fetch(dataPath(`cache/region_plants_${region.id}.geojson`)).then(r => r.json()),
        fetch(dataPath(`cache/region_lines_${region.id}.geojson`)).then(r => r.json()),
        fetch(dataPath(`cache/region_substations_${region.id}.geojson`)).then(r => r.json()).catch(() => ({ type: 'FeatureCollection', features: [] })),
        fetch(dataPath(`region_load_centers_${region.id}.geojson`)).then(r => r.json()).catch(() => ({ type: 'FeatureCollection', features: [] })),
        fetch(dataPath(`cache/region_admin1_${region.id}.geojson`)).then(r => r.ok ? r.json() : { type: 'FeatureCollection', features: [] }).catch(() => ({ type: 'FeatureCollection', features: [] })),
      ]);


      const bounds = fitBoundsCountry(iso, countries);
      if (bounds) {
        map.fitBounds(bounds, { padding: 60, duration: 0, maxZoom: 9 });
        setCountryCenter({
          lon: (bounds[0][0] + bounds[1][0]) / 2,
          lat: (bounds[0][1] + bounds[1][1]) / 2,
        });
      }

      // Filter plants strictly inside the country polygon (point-in-polygon)
      // Lines filtered by bbox (segments cross borders by nature)
      const countryFeature = countries.features.find(f => f.properties.ISO_A3 === iso);
      countryFeatureRef.current = countryFeature || null;
      let filteredPlants = plantsGJ;
      let filteredLines  = linesGJ;
      let filteredSubs   = subsGJ;
      if (countryFeature) {
        filteredPlants = {
          ...plantsGJ,
          features: plantsGJ.features.filter(f =>
            pointInFeature(f.geometry.coordinates, countryFeature)
          ),
        };
        filteredLines = {
          ...linesGJ,
          features: linesGJ.features.filter(f =>
            f.geometry.coordinates.some(coord => pointInFeature(coord, countryFeature))
          ),
        };
        filteredSubs = {
          ...subsGJ,
          features: subsGJ.features.filter(f =>
            pointInFeature(f.geometry.coordinates, countryFeature)
          ),
        };
      }

      setFilteredPlantsData(filteredPlants);
      setFilteredLinesData(filteredLines);

      const filteredLc = {
        ...lcGJ,
        features: lcGJ.features.filter(f => f.properties.iso === iso),
      };

      addCountriesSource(map, countries);
      map.addSource('plants',       { type: 'geojson', data: filteredPlants });
      map.addSource('lines',        { type: 'geojson', data: filteredLines  });
      map.addSource('substations',  { type: 'geojson', data: filteredSubs   });
      map.addSource('load-centers', { type: 'geojson', data: filteredLc     });
      map.addSource('admin1',       { type: 'geojson', data: admin1GJ       });
      const hlFilter = ['==', ['get', 'ISO_A3'], iso];
      map.addSource('zone-fills',        { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('zone-inner',        { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('zone-lines',        { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('zone-corridors-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('zone-centroids-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

      const tv = getT(theme);

      addBoundariesSource(map, boundaries);

      // Transmission lines
      const kvFilters = {
        '500': ['>=', ['get', 'v'], 500_000],
        '330': ['all', ['>=', ['get', 'v'], 330_000], ['<', ['get', 'v'], 500_000]],
        '220': ['all', ['>=', ['get', 'v'], 220_000], ['<', ['get', 'v'], 330_000]],
        '110': ['<', ['get', 'v'], 220_000],
      };
      for (const { colors, width, key } of VOLTAGE_BRACKETS) {
        map.addLayer({
          id: `lines-${key}`,
          type: 'line',
          source: 'lines',
          filter: kvFilters[key],
          paint: {
            'line-color': colors[theme] ?? colors.fog, 'line-width': width,
            'line-opacity': tv.isDark ? 0.92 : 0.65,
          },
        });
      }

      // Country highlight fill (below zones)
      const hl = tv.highlight;
      map.addLayer({
        id: 'country-fill',
        type: 'fill',
        source: 'countries',
        filter: hlFilter,
        paint: { 'fill-color': hl.fill, 'fill-opacity': 0.08 },
      });

      // Admin-1 province/state boundaries (shown in 'admin' zone mode)
      map.addLayer({
        id: 'admin1-fills', type: 'fill', source: 'admin1',
        filter: ['==', ['get', 'ISO_A3'], iso],
        layout: { visibility: 'visible' },
        paint: { 'fill-color': '#7799bb', 'fill-opacity': 0.06 },
      });
      map.addLayer({
        id: 'admin1-borders', type: 'line', source: 'admin1',
        filter: ['==', ['get', 'ISO_A3'], iso],
        layout: { visibility: 'visible' },
        paint: { 'line-color': '#5577aa', 'line-width': 0.7, 'line-opacity': 0.35 },
      });

      // Plants
      const fuels = new Set();
      for (const f of plantsGJ.features) {
        const fuel = f.properties.fuel;
        if (fuel && FUEL_COLORS[fuel]) fuels.add(fuel);
      }
      setPresentFuels(fuels);

      for (const [fuel, color] of Object.entries(FUEL_COLORS)) {
        if (!fuels.has(fuel)) continue;
        map.addLayer({
          id: `plants-${fuel}`,
          type: 'circle',
          source: 'plants',
          filter: ['all',
            ['==',  ['get', 'fuel'], fuel],
            ['>=', ['get', 'mw'],   100],
          ],
          paint: {
            'circle-radius':  plantRadiusExpr(),
            'circle-color':   color,
            'circle-opacity': 0.90,
            'circle-stroke-width': 0.6,
            'circle-stroke-color': 'rgba(0,0,0,0.3)',
          },
        });

        map.on('mouseenter', `plants-${fuel}`, e => {
          map.getCanvas().style.cursor = 'pointer';
          const p = e.features[0].properties;
          const name = p.name ? `<b>${p.name}</b><br>` : '';
          popup
            .setLngLat(e.features[0].geometry.coordinates)
            .setHTML(`${name}<span style="opacity:.75">${fuel} · ${p.mw} MW</span>`)
            .addTo(map);
        });
        map.on('mouseleave', `plants-${fuel}`, () => {
          map.getCanvas().style.cursor = ''; popup.remove();
        });
      }

      // ── Substations (tiny dimgrey squares via custom image) ──────────────────
      const sqSz = 5;
      const sqData = new Uint8Array(sqSz * sqSz * 4);
      for (let i = 0; i < sqSz * sqSz; i++) {
        sqData[i * 4] = 105; sqData[i * 4 + 1] = 105; sqData[i * 4 + 2] = 105;
        sqData[i * 4 + 3] = tv.isDark ? 160 : 130;
      }
      map.addImage('sub-sq', { width: sqSz, height: sqSz, data: sqData });
      map.addLayer({
        id: 'substations', type: 'symbol', source: 'substations',
        layout: { 'icon-image': 'sub-sq', 'icon-allow-overlap': true, 'icon-ignore-placement': true, visibility: 'none' },
        paint: { 'icon-opacity': 0.8 },
      });
      map.on('mouseenter', 'substations', e => {
        map.getCanvas().style.cursor = 'pointer';
        const p = e.features[0].properties;
        const name = p.name ? `<b>${p.name}</b><br>` : '';
        const kv = p.v ? `${Math.round(p.v / 1000)} kV` : '';
        popup.setLngLat(e.features[0].geometry.coordinates).setHTML(`${name}<span style="opacity:.75">Substation${kv ? ' · ' + kv : ''}</span>`).addTo(map);
      });
      map.on('mouseleave', 'substations', () => { map.getCanvas().style.cursor = ''; popup.remove(); });

      // ── Zone overlay (fill + border + labels + interzone lines) ──────────────
      map.addLayer({
        id: 'zone-fills', type: 'fill', source: 'zone-fills',
        layout: { visibility: 'none' },
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.22 },
      });
      map.addLayer({
        id: 'zone-borders', type: 'line', source: 'zone-inner',
        layout: { visibility: 'none' },
        paint: { 'line-color': '#333', 'line-width': 1.8, 'line-opacity': 0.7 },
      });
      map.addLayer({
        id: 'zone-labels', type: 'symbol', source: 'zone-fills',
        layout: {
          visibility: 'none',
          'text-font': MAP_LABEL_FONT, 'text-field': ['get', 'zone_name'],
          'text-size': 11,
          'text-anchor': 'center',
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': '#111',
          'text-halo-color': 'rgba(255,255,255,0.9)',
          'text-halo-width': 2,
        },
      });
      map.addLayer({
        id: 'zone-links', type: 'line', source: 'zone-lines',
        layout: { visibility: 'none' },
        paint: { 'line-color': '#444', 'line-width': 2.5, 'line-opacity': 0.6, 'line-dasharray': [5, 4] },
      });

      // Corridor capacity lines (existing only — no planned)
      const mwWidthExpr = ['interpolate', ['linear'], ['get', 'mw'], 0, 1.5, 500, 3.0, 2000, 6.0];
      map.addLayer({
        id: 'zone-corridors-ex', type: 'line', source: 'zone-corridors-src',
        filter: ['!', ['in', ['get', 'status'], ['literal', ['planned', 'candidate', 'long_term']]]],
        layout: { visibility: 'none' },
        paint: { 'line-color': '#1a5fa8', 'line-width': mwWidthExpr, 'line-opacity': 0.85 },
      });
      map.addLayer({
        id: 'zone-corridors-labels', type: 'symbol', source: 'zone-corridors-src',
        filter: ['!', ['in', ['get', 'status'], ['literal', ['planned', 'candidate', 'long_term']]]],
        layout: {
          visibility: 'none',
          'text-font': MAP_LABEL_FONT, 'text-field': ['get', 'label'],
          'text-size': 9,
          'symbol-placement': 'line-center',
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#1a5fa8',
          'text-halo-color': 'rgba(255,255,255,0.9)',
          'text-halo-width': 1.5,
        },
      });
      map.addLayer({
        id: 'zone-corridors-dots', type: 'circle', source: 'zone-centroids-src',
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': 4, 'circle-color': '#696969',
          'circle-opacity': 0.75,
          'circle-stroke-width': 1.2, 'circle-stroke-color': 'rgba(255,255,255,0.7)',
        },
      });

      // Country border on top of zone layers so it always covers zone outer edges
      map.addLayer({
        id: 'country-border',
        type: 'line',
        source: 'countries',
        filter: hlFilter,
        paint: { 'line-color': hl.border, 'line-width': hl.borderW + 0.4, 'line-opacity': 0.95 },
      });

      // ── Load centers ─────────────────────────────────────────────────────────
      map.addLayer({
        id: 'load-centers', type: 'circle', source: 'load-centers',
        filter: ['>=', ['get', 'pop'], 300_000],
        paint: {
          'circle-radius': lcRadiusExpr(),
          'circle-color': '#1a237e',
          'circle-opacity': 0.72,
          'circle-stroke-width': 1.2,
          'circle-stroke-color': 'rgba(255,255,255,0.65)',
        },
      });
      map.addLayer({
        id: 'load-centers-labels', type: 'symbol', source: 'load-centers',
        filter: ['>=', ['get', 'pop'], 300_000],
        layout: {
          'text-font': MAP_LABEL_FONT, 'text-field': ['get', 'name'],
          'text-size': 9,
          'text-offset': [0, 1.3],
          'text-anchor': 'top',
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#1a237e',
          'text-halo-color': 'rgba(255,255,255,0.88)',
          'text-halo-width': 1.5,
        },
      });
      map.on('mouseenter', 'load-centers', e => {
        map.getCanvas().style.cursor = 'pointer';
        const p = e.features[0].properties;
        const pop = p.pop >= 1_000_000
          ? `${(p.pop / 1_000_000).toFixed(1)}M`
          : `${Math.round(p.pop / 1_000)}k`;
        popup.setLngLat(e.features[0].geometry.coordinates).setHTML(`<b>${p.name}</b><br><span style="opacity:.75">${pop} pop.</span>`).addTo(map);
      });
      map.on('mouseleave', 'load-centers', () => { map.getCanvas().style.cursor = ''; popup.remove(); });

      mapReadyRef.current = true;

      raiseBoundaries(map);
    });

    return () => { mapReadyRef.current = false; popup.remove(); mapRef.current?.remove(); };
  }, [info, theme, wbBase]);

  // ── Basemap switcher ─────────────────────────────────────────────────────
  useEffect(() => {
    wbViewRef.current = wbView;
    applyWbView(mapRef.current, wbView);
  }, [wbView]);

  // ── Layer toggle handlers ────────────────────────────────────────────────

  const toggleFuel = useCallback(fuel => {
    const map = mapRef.current;
    if (!map || !layer(map, `plants-${fuel}`)) return;
    setFuelsOff(prev => {
      const next = new Set(prev);
      if (next.has(fuel)) { next.delete(fuel); map.setLayoutProperty(`plants-${fuel}`, 'visibility', 'visible'); }
      else                { next.add(fuel);    map.setLayoutProperty(`plants-${fuel}`, 'visibility', 'none');    }
      return next;
    });
  }, []);

  const toggleKv = useCallback(key => {
    const map = mapRef.current;
    if (!map || !layer(map, `lines-${key}`)) return;
    setKvsOff(prev => {
      const next = new Set(prev);
      if (next.has(key)) { next.delete(key); map.setLayoutProperty(`lines-${key}`, 'visibility', 'visible'); }
      else               { next.add(key);    map.setLayoutProperty(`lines-${key}`, 'visibility', 'none');    }
      return next;
    });
  }, []);

  const toggleLines = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    setLinesOn(prev => {
      const next = !prev;
      for (const { key } of VOLTAGE_BRACKETS)
        if (!kvsOff.has(key) && layer(map, `lines-${key}`))
          map.setLayoutProperty(`lines-${key}`, 'visibility', next ? 'visible' : 'none');
      return next;
    });
  }, [kvsOff]);

  const togglePlants = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    setPlantsOn(prev => {
      const next = !prev;
      for (const fuel of presentFuels)
        if (!fuelsOff.has(fuel) && layer(map, `plants-${fuel}`))
          map.setLayoutProperty(`plants-${fuel}`, 'visibility', next ? 'visible' : 'none');
      return next;
    });
  }, [presentFuels, fuelsOff]);

  const toggleSubs = useCallback(() => {
    const map = mapRef.current;
    if (!map || !layer(map, 'substations')) return;
    setSubsOn(prev => {
      const next = !prev;
      map.setLayoutProperty('substations', 'visibility', next ? 'visible' : 'none');
      return next;
    });
  }, []);

  const toggleLoadCenters = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    setLoadCentersOn(prev => {
      const next = !prev;
      for (const id of ['load-centers', 'load-centers-labels']) {
        if (layer(map, id)) map.setLayoutProperty(id, 'visibility', next ? 'visible' : 'none');
      }
      return next;
    });
  }, []);

  const toggleZoneLabels = useCallback(() => {
    const map = mapRef.current;
    if (!map || !layer(map, 'zone-labels')) return;
    setZoneLabelsOn(prev => {
      const next = !prev;
      map.setLayoutProperty('zone-labels', 'visibility', next ? 'visible' : 'none');
      return next;
    });
  }, []);

  const toggleZoneCorridors = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    setZoneCorridorsOn(prev => {
      const next = !prev;
      for (const id of ['zone-corridors-ex', 'zone-corridors-labels', 'zone-corridors-dots']) {
        if (layer(map, id)) map.setLayoutProperty(id, 'visibility', next ? 'visible' : 'none');
      }
      return next;
    });
  }, []);

  const handleLcMinPop = useCallback(pop => {
    const map = mapRef.current;
    if (!map) return;
    setLcMinPop(pop);
    for (const id of ['load-centers', 'load-centers-labels']) {
      if (layer(map, id)) map.setFilter(id, ['>=', ['get', 'pop'], pop]);
    }
  }, []);

  const handleMinMw = useCallback(mw => {
    const map = mapRef.current;
    if (!map) return;
    setMinMw(mw);
    for (const fuel of Object.keys(FUEL_COLORS)) {
      if (!layer(map, `plants-${fuel}`)) continue;
      map.setFilter(`plants-${fuel}`, ['all',
        ['==',  ['get', 'fuel'], fuel],
        ['>=', ['get', 'mw'],   mw],
      ]);
    }
  }, []);

  const handleCircleScale = useCallback(scale => {
    const map = mapRef.current;
    if (!map) return;
    setCircleScale(scale);
    for (const fuel of Object.keys(FUEL_COLORS)) {
      if (!layer(map, `plants-${fuel}`)) continue;
      map.setPaintProperty(`plants-${fuel}`, 'circle-radius', plantRadiusExpr(scale));
    }
  }, []);

  const handleLcCircleScale = useCallback(scale => {
    const map = mapRef.current;
    if (!map) return;
    setLcCircleScale(scale);
    if (layer(map, 'load-centers')) {
      map.setPaintProperty('load-centers', 'circle-radius', lcRadiusExpr(scale));
    }
  }, []);

  // ── Zone overlay ─────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current || !source(map, 'zone-fills')) return;
    const ZONE_IDS  = ['zone-fills', 'zone-borders'];
    const ADMIN_IDS = ['admin1-fills', 'admin1-borders'];

    const showAdmin = zoneMode === 'admin';
    for (const id of ADMIN_IDS) {
      if (layer(map, id)) map.setLayoutProperty(id, 'visibility', showAdmin ? 'visible' : 'none');
    }

    if (zoneMode !== 'modeling' || !nZones) {
      for (const id of ZONE_IDS) {
        if (layer(map, id)) map.setLayoutProperty(id, 'visibility', 'none');
      }
      for (const id of ['zone-corridors-ex', 'zone-corridors-labels', 'zone-corridors-dots']) {
        if (layer(map, id)) map.setLayoutProperty(id, 'visibility', 'none');
      }
      return;
    }

    const COLORS = ['#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f','#edc948','#b07aa1','#ff9da7','#9c755f','#bab0ac'];
    const label = `${iso}_${nZones}z`;

    Promise.all([
      fetch(dataPath(`zones/${label}_zones.geojson`)).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(dataPath(`zones/${label}_topo.json`)).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(dataPath(`zones/${label}_inner.geojson`)).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(dataPath(`zones/${label}_corridors.geojson`)).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([zonesGJ, topo, innerGJ, corridorsGJ]) => {
      if (!zonesGJ || !source(map, 'zone-fills')) return;
      zonesGJ.features.forEach((f, i) => { f.properties.color = COLORS[i % COLORS.length]; });
      source(map, 'zone-fills').setData(zonesGJ);
      if (innerGJ && source(map, 'zone-inner')) source(map, 'zone-inner').setData(innerGJ);

      // Build interzone line geometries from centroids
      const centroids = {};
      for (const f of zonesGJ.features) {
        const name = f.properties.zone_name;
        const coords = f.geometry.type === 'Polygon'
          ? f.geometry.coordinates[0]
          : f.geometry.coordinates[0][0];
        centroids[name] = [
          coords.reduce((s, p) => s + p[0], 0) / coords.length,
          coords.reduce((s, p) => s + p[1], 0) / coords.length,
        ];
      }
      const lineFeatures = topo
        .filter(l => centroids[l.z] && centroids[l.zz])
        .map(l => ({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [centroids[l.z], centroids[l.zz]] },
          properties: l,
        }));
      source(map, 'zone-lines').setData({ type: 'FeatureCollection', features: lineFeatures });

      // Corridor capacity overlay — always update source (clear if no file for this zone count)
      const emptyGJ = { type: 'FeatureCollection', features: [] };
      if (source(map, 'zone-corridors-src'))
        source(map, 'zone-corridors-src').setData(corridorsGJ || emptyGJ);
      // Extract unique zone centroids from corridor endpoints
      const centroidMap = new Map();
      for (const f of (corridorsGJ?.features || [])) {
        const [s, e] = [f.geometry.coordinates[0], f.geometry.coordinates[f.geometry.coordinates.length - 1]];
        const ks = `${s[0]},${s[1]}`;
        const ke = `${e[0]},${e[1]}`;
        if (!centroidMap.has(ks)) centroidMap.set(ks, { type: 'Feature', geometry: { type: 'Point', coordinates: s }, properties: { zone: f.properties.zone_a } });
        if (!centroidMap.has(ke)) centroidMap.set(ke, { type: 'Feature', geometry: { type: 'Point', coordinates: e }, properties: { zone: f.properties.zone_b } });
      }
      if (source(map, 'zone-centroids-src'))
        source(map, 'zone-centroids-src').setData({ type: 'FeatureCollection', features: [...centroidMap.values()] });
      for (const id of ['zone-corridors-ex', 'zone-corridors-labels', 'zone-corridors-dots']) {
        if (layer(map, id))
          map.setLayoutProperty(id, 'visibility', zoneCorridorsOn ? 'visible' : 'none');
      }

      for (const id of ZONE_IDS) {
        if (layer(map, id)) map.setLayoutProperty(id, 'visibility', 'visible');
      }
      if (layer(map, 'zone-labels'))
        map.setLayoutProperty('zone-labels', 'visibility', zoneLabelsOn ? 'visible' : 'none');
    });
  }, [zoneMode, nZones, iso, zoneLabelsOn, zoneCorridorsOn]);

  // ── Plant source hot-swap ─────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!source(map, 'plants') || !info || !countryFeatureRef.current) return;
    const filename = plantSource === 'gppd'
      ? `region_plants_${info.region.id}_gppd.geojson`
      : `region_plants_${info.region.id}.geojson`;
    fetch(dataPath(`cache/${filename}`))
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(data => {
        const cf = countryFeatureRef.current;
        const filtered = {
          ...data,
          features: data.features.filter(f => pointInFeature(f.geometry.coordinates, cf)),
        };
        source(map, 'plants').setData(filtered);
        setFilteredPlantsData(filtered);
        const fuels = new Set(filtered.features.map(f => f.properties.fuel).filter(f => FUEL_COLORS[f]));
        setPresentFuels(fuels);
      })
      .catch(() => {
        if (plantSource !== 'osm') { setGppdAvailable(false); setPlantSource('osm'); }
      });
  }, [plantSource, info]);

  // Capacity summary for right panel
  useEffect(() => {
    if (!info) return;
    setCapacity(null);
    const cf = plantSource === 'gppd'
      ? dataPath(`cache/region_capacity_${info.region.id}_gppd.json`)
      : dataPath(`cache/region_capacity_${info.region.id}.json`);
    fetch(cf).then(r => r.json()).then(setCapacity).catch(() => {});
  }, [info, plantSource]);

  // Fleet age — GPPD only
  useEffect(() => {
    setFleetAge(null);
    if (!info || plantSource !== 'gppd') return;
    fetch(dataPath(`cache/region_age_${info.region.id}_gppd.json`))
      .then(r => r.ok ? r.json() : null)
      .then(setFleetAge)
      .catch(() => setFleetAge(null));
  }, [plantSource, info]);


  // ── Download handlers ────────────────────────────────────────────────────

  const handleDownloadPlants = useCallback((format = 'geojson') => {
    if (!filteredPlantsData) return;
    const suffix = plantSource === 'gppd' ? '_gppd' : plantSource === 'gem' ? '_gem' : '';
    if (format === 'csv') {
      const header = 'name,fuel,mw,country,status,lat,lon,source';
      const rows = filteredPlantsData.features.map(f => {
        const p = f.properties;
        const [lon, lat] = f.geometry.coordinates;
        return [
          `"${(p.name || '').replace(/"/g, '""')}"`,
          p.fuel || '', p.mw || '', p.country || '',
          p.status || 'operating', lat.toFixed(5), lon.toFixed(5),
          plantSource,
        ].join(',');
      });
      downloadBlob([header, ...rows].join('\n'), `plants_${iso}${suffix}.csv`, 'text/csv');
    } else {
      downloadBlob(JSON.stringify(filteredPlantsData), `plants_${iso}.geojson`, 'application/geo+json');
    }
  }, [filteredPlantsData, iso, plantSource]);

  const handleDownloadLines = useCallback((format = 'geojson') => {
    if (!filteredLinesData) return;
    if (format === 'csv') {
      const header = 'id,voltage_kv,geometry_wkt';
      const rows = filteredLinesData.features.map((f, i) => {
        const vkv = f.properties.v ? Math.round(f.properties.v / 1000) : '';
        const wkt = `LINESTRING(${f.geometry.coordinates.map(([x, y]) => `${x} ${y}`).join(', ')})`;
        return `${i},${vkv},"${wkt}"`;
      });
      downloadBlob([header, ...rows].join('\n'), `lines_${iso}.csv`, 'text/csv');
    } else {
      downloadBlob(JSON.stringify(filteredLinesData), `lines_${iso}.geojson`, 'application/geo+json');
    }
  }, [filteredLinesData, iso]);

  if (!info) return <div style={{ padding: 40, color: t.text }}>Loading…</div>;

  const { country, region } = info;

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 46px)' }}>
      <LayerPanel
        theme={theme}
        fuelsOff={fuelsOff} kvsOff={kvsOff}
        linesOn={linesOn} plantsOn={plantsOn} subsOn={subsOn}
        minMw={minMw} circleScale={circleScale}
        plantSource={plantSource} gppdAvailable={gppdAvailable}
        presentFuels={presentFuels}
        wbView={wbView} onWbView={setWbView}
        onToggleFuel={toggleFuel} onToggleKv={toggleKv}
        onToggleLines={toggleLines} onTogglePlants={togglePlants}
        onToggleSubs={toggleSubs}
        loadCentersOn={loadCentersOn} lcMinPop={lcMinPop} lcCircleScale={lcCircleScale}
        onToggleLoadCenters={toggleLoadCenters} onLcMinPopChange={handleLcMinPop}
        onLcCircleScaleChange={handleLcCircleScale}
        onMinMwChange={handleMinMw} onCircleScaleChange={handleCircleScale}
        onSourceChange={setPlantSource}
        onDownloadPlants={handleDownloadPlants}
        onDownloadLines={handleDownloadLines}
      />

      <div style={{ flex: 1, position: 'relative', height: 'calc(100vh - 46px)' }}>
        <div ref={containerRef} style={{ position: 'absolute', inset: 0, backgroundColor: t.bg }} />
        <MapDownload mapRef={mapRef} t={t} name={()=>ttl(`${info?.country?.name||iso} map`)}/>

        {/* ── Floating zone selector ── */}
        {zonesIndex !== null && (
          <div style={{
            position: 'absolute', top: 10, right: 10, zIndex: 10,
            backgroundColor: t.panel, border: `1px solid ${t.panelBorder}`,
            borderRadius: 6, padding: '8px 10px', minWidth: 130,
            boxShadow: '0 2px 10px rgba(0,0,0,0.18)',
          }}>
            <span style={{
              fontSize: '0.44rem', letterSpacing: '2px', fontWeight: 700,
              color: t.lblMuted, textTransform: 'uppercase', display: 'block', marginBottom: 6,
            }}>Zones</span>
            <div style={{ display: 'flex', gap: 3, marginBottom: 6 }}>
              {[['plain', 'Plain'], ['admin', 'Admin'], ['modeling', 'Clustering']].map(([mode, label]) => {
                const active = zoneMode === mode;
                const disabled = mode === 'modeling' && !(zonesIndex[iso]?.length);
                return (
                  <button key={mode} disabled={disabled}
                    onClick={() => {
                      setZoneMode(mode);
                      if (mode === 'modeling' && !nZones && zonesIndex[iso]?.length) {
                        setNZones(zonesIndex[iso][0]);
                      }
                    }}
                    style={{
                      flex: 1, fontSize: '0.5rem', padding: '3px 0',
                      borderRadius: 3, cursor: disabled ? 'default' : 'pointer',
                      fontFamily: 'inherit', letterSpacing: '0.5px',
                      border: `1px solid ${active ? 'rgba(74,143,204,0.65)' : t.panelBorder}`,
                      backgroundColor: active ? 'rgba(74,143,204,0.13)' : 'transparent',
                      color: active ? t.lbl : t.lblMuted,
                      opacity: disabled ? 0.4 : 1,
                    }}>
                    {label}
                  </button>
                );
              })}
            </div>

            {zoneMode === 'modeling' && zonesIndex[iso]?.length ? (
              <>
                <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                  {zonesIndex[iso].map(n => (
                    <button key={n} onClick={() => setNZones(n)} style={{
                      fontSize: '0.48rem', padding: '2px 6px',
                      borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit',
                      border: `1px solid ${nZones === n ? 'rgba(74,143,204,0.65)' : t.panelBorder}`,
                      backgroundColor: nZones === n ? 'rgba(74,143,204,0.13)' : 'transparent',
                      color: nZones === n ? t.lbl : t.lblMuted,
                    }}>
                      {n}z
                    </button>
                  ))}
                </div>
                <div style={{ marginTop: 5, borderTop: `1px solid ${t.panelBorder}`, paddingTop: 4, display: 'flex', gap: 3 }}>
                  <button onClick={toggleZoneLabels} style={{
                    fontSize: '0.48rem', padding: '2px 6px', borderRadius: 3, cursor: 'pointer',
                    fontFamily: 'inherit', flex: 1,
                    border: `1px solid ${zoneLabelsOn ? 'rgba(74,143,204,0.65)' : t.panelBorder}`,
                    backgroundColor: zoneLabelsOn ? 'rgba(74,143,204,0.13)' : 'transparent',
                    color: zoneLabelsOn ? t.lbl : t.lblMuted,
                  }}>
                    Labels
                  </button>
                  <button onClick={toggleZoneCorridors} style={{
                    fontSize: '0.48rem', padding: '2px 6px', borderRadius: 3, cursor: 'pointer',
                    fontFamily: 'inherit', flex: 1,
                    border: `1px solid ${zoneCorridorsOn ? 'rgba(74,143,204,0.65)' : t.panelBorder}`,
                    backgroundColor: zoneCorridorsOn ? 'rgba(74,143,204,0.13)' : 'transparent',
                    color: zoneCorridorsOn ? t.lbl : t.lblMuted,
                  }}>
                    Corridors
                  </button>
                </div>
              </>
            ) : zoneMode === 'modeling' ? (
              <p style={{ fontSize: '0.48rem', color: t.lblMuted, fontStyle: 'italic', margin: 0 }}>
                No zone data — run pipeline
              </p>
            ) : null}
          </div>
        )}
      </div>

      {/* Right panel */}
      <div style={{
        width: 268, height: 'calc(100vh - 46px)', overflowY: 'auto',
        backgroundColor: t.panel,
        borderLeft: `1px solid ${t.panelBorder}`,
        flexShrink: 0, display: 'flex', flexDirection: 'column',
      }}>
        {/* ── Fixed header ── */}
        <div style={{ padding: '14px 16px 0', flexShrink: 0 }}>
          {/* Breadcrumb */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 10, flexWrap: 'wrap' }}>
            <Link to="/" style={{ fontSize: '0.68rem', color: t.muted }}>World</Link>
            <span style={{ color: t.panelBorder, fontSize: '0.68rem' }}>/</span>
            <Link to={`/region/${region.id}`} style={{ fontSize: '0.68rem', color: t.muted }}>{region.name}</Link>
            <span style={{ color: t.panelBorder, fontSize: '0.68rem' }}>/</span>
            <span style={{ fontSize: '0.68rem', color: t.lbl, fontWeight: 600 }}>{country.name}</span>
          </div>

          <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: t.text, marginBottom: 6 }}>
            {country.name}
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span style={{
              fontSize: '0.68rem', fontWeight: 600, color: 'white',
              backgroundColor: region.color, borderRadius: 4,
              padding: '2px 8px', display: 'inline-block',
            }}>
              {iso}
            </span>
            <div style={{ height: 3, width: 24, borderRadius: 2, backgroundColor: region.color }} />
          </div>

          {/* ── Tab buttons ── */}
          <div style={{ display: 'flex', gap: 3, marginBottom: 0 }}>
            {[
              { id: 'overview', label: 'Overview' },
              { id: 'zoning',   label: 'Zones' },
              { id: 're',       label: 'RE' },
              { id: 'load',     label: 'Load' },
            ].map(({ id, label }) => {
              const active = activeTab === id;
              return (
                <button key={id} onClick={() => setActiveTab(id)} style={{
                  flex: 1, fontSize: '0.48rem', letterSpacing: '0.5px',
                  textTransform: 'uppercase', fontFamily: 'inherit',
                  padding: '4px 0', borderRadius: '3px 3px 0 0',
                  cursor: 'pointer',
                  border: `1px solid ${active ? t.panelBorder : 'rgba(128,160,192,0.18)'}`,
                  borderBottom: active ? `1px solid ${t.panel}` : `1px solid ${t.panelBorder}`,
                  backgroundColor: active ? t.panel : 'transparent',
                  color: active ? t.lbl : t.lblMuted,
                  fontWeight: active ? 700 : 400,
                  position: 'relative', zIndex: active ? 2 : 1,
                }}>
                  {label}
                </button>
              );
            })}
          </div>
          <div style={{ height: 1, backgroundColor: t.panelBorder, marginTop: -1, position: 'relative', zIndex: 0 }} />
        </div>

        {/* ── Scrollable tab content ── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px' }}>

          {activeTab === 'overview' && (
            <>
              <CountryOverview
                iso={iso}
                region={region}
                capacity={capacity}
                fleetAge={fleetAge}
                tariffs={tariffs}
                access={access}
                theme={theme}
                source={plantSource}
              />
              {/* Export */}
              <div style={{ marginTop: 16, borderTop: `1px solid ${t.panelBorder}`, paddingTop: 12 }}>
                <span style={{ fontSize: '0.47rem', letterSpacing: '2px', fontWeight: 700, color: t.lblMuted, textTransform: 'uppercase', display: 'block', marginBottom: 7 }}>
                  Export Data
                </span>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                  {[
                    { label: 'Plants GeoJSON', fn: () => handleDownloadPlants('geojson') },
                    { label: 'Plants CSV',     fn: () => handleDownloadPlants('csv') },
                    { label: 'Lines GeoJSON',  fn: () => handleDownloadLines('geojson') },
                    { label: 'Lines CSV',      fn: () => handleDownloadLines('csv') },
                  ].map(({ label, fn }) => (
                    <button key={label} onClick={fn} style={{
                      background: 'none', border: `1px solid ${t.panelBorder}`,
                      borderRadius: 3, padding: '4px 6px', cursor: 'pointer',
                      fontSize: '0.52rem', color: t.muted, fontFamily: 'inherit',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
                    }}>
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none"
                        stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                      </svg>
                      {label}
                    </button>
                  ))}
                </div>
                <p style={{ fontSize: '0.47rem', color: t.lblMuted, marginTop: 6, fontStyle: 'italic' }}>
                  Source: {plantSource.toUpperCase()} · {country.name} only
                </p>
              </div>
            </>
          )}

          {activeTab === 're' && (
            <REResourcesTab center={countryCenter} theme={theme} />
          )}

          {activeTab === 'load' && (
            <LoadTab iso={iso} theme={theme} />
          )}

          {activeTab === 'zoning' && (
            <ZoningTab iso={iso} theme={theme} regionId={region.id} />
          )}

          <div style={{ borderTop: `1px solid ${t.hr}`, paddingTop: 12, marginTop: 20 }}>
            <Link
              to={`/region/${region.id}`}
              style={{ fontSize: '0.72rem', color: region.color, display: 'flex', alignItems: 'center', gap: 5 }}
            >
              ← Back to {region.name}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
