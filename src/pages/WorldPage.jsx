import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import MapDownload from '../components/MapDownload';
import { ttl } from '../utils/chartTitle';
import { useTheme } from '../App';
import { getT } from '../constants';
import { fetchCountries, fetchBoundaries, addCountriesSource, addBoundariesSource, regionFilter, addRegionCoast, raiseBoundaries } from '../utils/basemap';
import { buildWbStyle, useWbStyleBase, DEFAULT_WB_VIEW } from '../utils/wbStyle';
import { dataPath } from '../utils/paths';

export default function WorldPage() {
  const { theme } = useTheme();
  const wbBase = useWbStyleBase();
  const t = getT(theme);
  const navigate = useNavigate();
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const [regions, setRegions] = useState(null);
  const [disambig, setDisambig] = useState(null); // {x, y, iso, regions[]}

  useEffect(() => {
    fetch(dataPath('regions.json')).then(r => r.json()).then(d => setRegions(d.regions));
  }, []);

  useEffect(() => {
    if (!containerRef.current || !regions || !wbBase) return;

    // Clickable = regions with EPM data; others are shown dimly but not interactive
    const isoToRegions = {};
    // Areas the Bank attributes to no country carry no code, so they are keyed
    // on WB_NAME instead. See regionFilter() in src/utils/basemap.js.
    const areaToRegions = {};
    const clickable = regions.filter(r => r.epm);
    const dimmed = regions.filter(r => r.status === 'available' && !r.epm);
    for (const r of clickable) {
      for (const c of r.countries) {
        if (!isoToRegions[c.iso]) isoToRegions[c.iso] = [];
        isoToRegions[c.iso].push({ id: r.id, name: r.name, color: r.color, countryName: c.name });
      }
      for (const area of r.non_determined || []) {
        if (!areaToRegions[area]) areaToRegions[area] = [];
        areaToRegions[area].push({ id: r.id, name: r.name, color: r.color, countryName: area });
      }
    }
    const clickableIsos = Object.keys(isoToRegions);
    const clickableAreas = Object.keys(areaToRegions);
    const regionsFor = p =>
      (p.STATUS === 'non-determined' ? areaToRegions[p.WB_NAME] : isoToRegions[p.ISO_A3]) || [];
    const dimmedIsos = [...new Set(
      dimmed.flatMap(r => r.countries.map(c => c.iso)).filter(iso => !clickableIsos.includes(iso))
    )];

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildWbStyle(wbBase, getT(theme), DEFAULT_WB_VIEW),
      center: [20, 15],
      zoom: 2.2,
      minZoom: 1.5,
      maxZoom: 9,
      canvasContextAttributes: { preserveDrawingBuffer: true }, attributionControl: false,
    });
    mapRef.current = map;

    // Close popover on map move
    map.on('movestart', () => setDisambig(null));

    map.on('load', async () => {
      const countries = await fetchCountries('110m');
      const boundaries = await fetchBoundaries('110m');

      addCountriesSource(map, countries);
      addBoundariesSource(map, boundaries);

      // Non-EPM regions: no highlight, blend into background

      // Clickable layer — regions with EPM data
      if (clickableIsos.length) {
        const byIso = ['match', ['get', 'ISO_A3'],
          ...clickableIsos.flatMap(iso => [iso, isoToRegions[iso][0].color]),
          'transparent',
        ];
        const colorExpr = clickableAreas.length
          ? ['case', ['==', ['get', 'STATUS'], 'non-determined'],
              ['match', ['get', 'WB_NAME'],
                ...clickableAreas.flatMap(a => [a, areaToRegions[a][0].color]),
                'transparent'],
              byIso]
          : byIso;

        map.addLayer({
          id: 'region-fill',
          type: 'fill',
          source: 'countries',
          filter: regionFilter(clickableIsos, clickableAreas),
          paint: {
            'fill-color': colorExpr,
            'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.55, 0.28],
          },
        });

        map.addLayer({
          id: 'region-border',
          type: 'line',
          source: 'countries',
          filter: ['in', ['get', 'ISO_A3'], ['literal', clickableIsos]],
          paint: { 'line-color': colorExpr, 'line-width': 0.9, 'line-opacity': 0.7 },
        });

        // The areas take the same outline, keyed on the only name they carry.
        addRegionCoast(map, {
          areas: clickableAreas,
          color: ['match', ['get', 'NAME'],
            ...clickableAreas.flatMap(a => [a, areaToRegions[a][0].color]),
            'transparent'],
          width: 0.9, opacity: 0.7,
        });
      }

      let hoveredId = null;
      const popup = new maplibregl.Popup({
        closeButton: false, closeOnClick: false, offset: 8,
        className: `popup-${theme}`,
      });

      map.on('mousemove', 'region-fill', e => {
        map.getCanvas().style.cursor = 'pointer';
        if (hoveredId !== null)
          map.setFeatureState({ source: 'countries', id: hoveredId }, { hover: false });
        hoveredId = e.features[0].id;
        map.setFeatureState({ source: 'countries', id: hoveredId }, { hover: true });

        const props = e.features[0].properties;
        const rs = regionsFor(props);
        const countryName = rs[0]?.countryName || props.WB_NAME || props.ISO_A3;
        const subtitle = rs.length > 1
          ? rs.map(r => r.name).join(' · ') + ' · click to choose'
          : (rs[0]?.name || '') + ' · click to explore';
        popup.setLngLat(e.lngLat)
          .setHTML(`<b>${countryName}</b><br><span style="opacity:0.65">${subtitle}</span>`)
          .addTo(map);
      });

      map.on('mouseleave', 'region-fill', () => {
        map.getCanvas().style.cursor = '';
        if (hoveredId !== null)
          map.setFeatureState({ source: 'countries', id: hoveredId }, { hover: false });
        hoveredId = null;
        popup.remove();
      });

      map.on('click', 'region-fill', e => {
        const props = e.features[0].properties;
        const iso = props.ISO_A3 || props.WB_NAME;
        const rs = regionsFor(props);
        if (rs.length === 0) return;
        // Preserve last Inputs/Results mode
        const lastMode = sessionStorage.getItem('epmViewMode') || 'inputs';
        const suffix = lastMode === 'results' ? '/results' : '';
        if (rs.length === 1) {
          navigate(`/region/${rs[0].id}${suffix}`);
        } else {
          const pixel = map.project(e.lngLat);
          setDisambig({ x: pixel.x, y: pixel.y, iso, regions: rs, suffix });
        }
      });

      raiseBoundaries(map);
    });

    return () => { mapRef.current?.remove(); setDisambig(null); };
  }, [regions, theme, wbBase]);

  return (
    <div style={{ height: 'calc(100vh - 46px)', position: 'relative', backgroundColor: t.bg }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <MapDownload mapRef={mapRef} t={t} name={()=>ttl('World map')}/>

      {/* Disambiguation popover */}
      {disambig && (
        <>
          {/* Invisible backdrop to close on outside click */}
          <div
            onClick={() => setDisambig(null)}
            style={{ position: 'absolute', inset: 0, zIndex: 9 }}
          />
          <div style={{
            position: 'absolute',
            left: disambig.x,
            top: disambig.y,
            transform: 'translate(-50%, -110%)',
            zIndex: 10,
            backgroundColor: t.panel,
            border: `1px solid ${t.panelBorder}`,
            borderRadius: 8,
            padding: '10px 12px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
            minWidth: 160,
          }}>
            <div style={{ fontSize: '0.5rem', letterSpacing: '2px', fontWeight: 700,
              color: t.lblMuted, textTransform: 'uppercase', marginBottom: 8 }}>
              {disambig.regions[0]?.countryName || disambig.iso} · Choose region
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {disambig.regions.map(r => (
                <button
                  key={r.id}
                  onClick={e => { e.stopPropagation(); setDisambig(null); navigate(`/region/${r.id}${disambig.suffix||''}`); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    background: 'none', border: `1px solid ${r.color}44`,
                    borderRadius: 5, padding: '6px 10px', cursor: 'pointer',
                    color: t.text, fontSize: '0.72rem', fontWeight: 600,
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = `${r.color}22`}
                  onMouseLeave={e => e.currentTarget.style.background = 'none'}
                >
                  <span style={{ width: 8, height: 8, borderRadius: 2,
                    backgroundColor: r.color, flexShrink: 0 }} />
                  {r.name}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Region legend */}
      {regions && (
        <div style={{
          position: 'absolute', bottom: 70, left: 24,
          backgroundColor: t.panel, border: `1px solid ${t.panelBorder}`,
          borderRadius: 8, padding: '12px 14px',
          display: 'flex', flexDirection: 'column', gap: 7,
        }}>
          <div style={{ fontSize: '0.52rem', letterSpacing: '2px', fontWeight: 700,
            color: t.lblMuted, textTransform: 'uppercase', marginBottom: 2 }}>
            Power Pools
          </div>
          {regions.filter(r => r.epm).map(r => (
            <div
              key={r.id}
              onClick={() => navigate(`/region/${r.id}`)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
            >
              <span style={{ width: 9, height: 9, borderRadius: 2,
                backgroundColor: r.color, flexShrink: 0 }} />
              <span style={{ fontSize: '0.75rem', color: t.text }}>{r.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
