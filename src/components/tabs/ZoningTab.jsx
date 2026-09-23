import { useState, useEffect, useMemo } from 'react';
import { FUEL_COLORS, FUEL_LABELS, getT } from '../../constants';
import { dataPath } from '../../utils/paths';

const ZONE_COLORS = ['#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f','#edc948','#b07aa1','#ff9da7','#9c755f','#bab0ac'];

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
  if (g.type === 'Polygon') return g.coordinates.some(ring => pointInRing(pt, ring));
  if (g.type === 'MultiPolygon') return g.coordinates.some(poly => poly.some(ring => pointInRing(pt, ring)));
  return false;
}

function fmtMw(mw) {
  if (mw >= 1000) return `${(mw / 1000).toFixed(1)} GW`;
  return `${Math.round(mw)} MW`;
}

function FuelBar({ fuels, totalMw }) {
  if (!totalMw) return (
    <div style={{ height: 6, borderRadius: 3, backgroundColor: 'rgba(128,160,192,0.15)', marginBottom: 4 }} />
  );
  const sorted = Object.entries(fuels)
    .filter(([, mw]) => mw > 0)
    .sort(([, a], [, b]) => b - a);

  return (
    <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', marginBottom: 4 }}>
      {sorted.map(([fuel, mw]) => (
        <div key={fuel} title={`${FUEL_LABELS[fuel] || fuel}: ${fmtMw(mw)}`}
          style={{
            width: `${(mw / totalMw) * 100}%`,
            backgroundColor: FUEL_COLORS[fuel] || '#888',
            minWidth: mw / totalMw > 0.04 ? 3 : 0,
          }} />
      ))}
    </div>
  );
}

export default function ZoningTab({ iso, theme, regionId }) {
  const t = getT(theme);
  const [index,    setIndex]    = useState(null);
  const [nZones,   setNZones]   = useState(null);
  const [zonesGJ,  setZonesGJ]  = useState(null);
  const [topo,     setTopo]     = useState([]);
  const [plants,   setPlants]   = useState(null);
  const [subs,     setSubs]     = useState(null);
  const [lines,    setLines]    = useState(null);
  const [loading,  setLoading]  = useState(false);

  // Load zones index
  useEffect(() => {
    fetch(dataPath('zones/index.json')).then(r => r.json())
      .then(d => {
        setIndex(d);
        if (d[iso]?.length) setNZones(d[iso][0]);
      })
      .catch(() => setIndex({}));
  }, [iso]);

  // Load region plants + substations once
  useEffect(() => {
    if (!regionId) return;
    fetch(dataPath(`cache/region_plants_${regionId}.geojson`)).then(r => r.json()).then(setPlants).catch(() => setPlants(null));
    fetch(dataPath(`cache/region_substations_${regionId}.geojson`)).then(r => r.json()).then(setSubs).catch(() => setSubs(null));
    fetch(dataPath(`cache/region_lines_${regionId}.geojson`)).then(r => r.json()).then(setLines).catch(() => setLines(null));
  }, [regionId]);

  // Load zone GeoJSON + topo when config changes
  useEffect(() => {
    if (!nZones || !iso) return;
    setLoading(true);
    const label = `${iso}_${nZones}z`;
    Promise.all([
      fetch(dataPath(`zones/${label}_zones.geojson`)).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(dataPath(`zones/${label}_topo.json`)).then(r => r.ok ? r.json() : []).catch(() => []),
    ]).then(([gj, tp]) => {
      setZonesGJ(gj);
      setTopo(tp || []);
      setLoading(false);
    });
  }, [iso, nZones]);

  // Compute per-zone stats (PIP)
  const zoneStats = useMemo(() => {
    if (!zonesGJ || !plants || !subs || !lines) return null;
    const stats = {};
    zonesGJ.features.forEach(zf => {
      stats[zf.properties.zone_name] = { fuels: {}, totalMw: 0, plantCount: 0, subCount: 0, lineCount: 0 };
    });

    // Filter plants to current country
    const countryPlants = plants.features.filter(f => {
      const iso3 = f.properties.country || f.properties.ISO_A3 || '';
      return !iso3 || iso3 === iso;
    });

    for (const pf of countryPlants) {
      const coords = pf.geometry.coordinates;
      for (const zf of zonesGJ.features) {
        if (pointInFeature(coords, zf)) {
          const name = zf.properties.zone_name;
          const fuel = pf.properties.fuel;
          const mw   = pf.properties.mw || 0;
          if (fuel) stats[name].fuels[fuel] = (stats[name].fuels[fuel] || 0) + mw;
          stats[name].totalMw  += mw;
          stats[name].plantCount++;
          break;
        }
      }
    }

    // Substations PIP (bbox pre-filter for speed)
    const zoneBBoxes = zonesGJ.features.map(zf => {
      const coords = zf.geometry.type === 'Polygon'
        ? zf.geometry.coordinates.flat()
        : zf.geometry.coordinates.flat(2);
      const xs = coords.map(p => p[0]), ys = coords.map(p => p[1]);
      return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    });

    for (const sf of subs.features) {
      const [sx, sy] = sf.geometry.coordinates;
      for (let i = 0; i < zonesGJ.features.length; i++) {
        const bb = zoneBBoxes[i];
        if (sx < bb.minX || sx > bb.maxX || sy < bb.minY || sy > bb.maxY) continue;
        if (pointInFeature([sx, sy], zonesGJ.features[i])) {
          stats[zonesGJ.features[i].properties.zone_name].subCount++;
          break;
        }
      }
    }

    // Lines PIP — use midpoint of each line segment
    for (const lf of lines.features) {
      const coords = lf.geometry.coordinates;
      if (!coords?.length) continue;
      const mid = coords[Math.floor(coords.length / 2)];
      const [lx, ly] = mid;
      for (let i = 0; i < zonesGJ.features.length; i++) {
        const bb = zoneBBoxes[i];
        if (lx < bb.minX || lx > bb.maxX || ly < bb.minY || ly > bb.maxY) continue;
        if (pointInFeature([lx, ly], zonesGJ.features[i])) {
          stats[zonesGJ.features[i].properties.zone_name].lineCount++;
          break;
        }
      }
    }

    return stats;
  }, [zonesGJ, plants, subs, lines, iso]);

  const available = index?.[iso] || [];

  const sec = {
    fontSize: '0.45rem', letterSpacing: '2px', fontWeight: 700,
    color: t.lblMuted, textTransform: 'uppercase', display: 'block', marginBottom: 5,
  };

  if (!index) return <div style={{ fontSize: '0.6rem', color: t.muted }}>Loading…</div>;

  if (!available.length) return (
    <div style={{ padding: '12px 0' }}>
      <p style={{ fontSize: '0.6rem', color: t.muted, lineHeight: 1.6, margin: 0 }}>
        No clustering data for {iso}.
      </p>
      <p style={{ fontSize: '0.52rem', color: t.lblMuted, fontStyle: 'italic', marginTop: 6 }}>
        Run <code style={{ backgroundColor: 'rgba(128,160,192,0.1)', padding: '1px 4px', borderRadius: 2 }}>
          run_zoning_study.py
        </code> then <code style={{ backgroundColor: 'rgba(128,160,192,0.1)', padding: '1px 4px', borderRadius: 2 }}>
          export_zones_to_explorer.py
        </code>
      </p>
    </div>
  );

  return (
    <div>
      {/* n_zones selector */}
      <div style={{ marginBottom: 10 }}>
        <span style={sec}>Clusters</span>
        <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
          {available.map(n => {
            const active = nZones === n;
            return (
              <button key={n} onClick={() => setNZones(n)} style={{
                fontSize: '0.5rem', padding: '2px 8px', borderRadius: 3,
                cursor: 'pointer', fontFamily: 'inherit',
                border: `1px solid ${active ? 'rgba(74,143,204,0.65)' : t.panelBorder}`,
                backgroundColor: active ? 'rgba(74,143,204,0.13)' : 'transparent',
                color: active ? t.lbl : t.lblMuted,
              }}>
                {n}z
              </button>
            );
          })}
        </div>
      </div>

      {/* Zone cards */}
      {loading && <div style={{ fontSize: '0.6rem', color: t.muted }}>Loading…</div>}

      {!loading && zonesGJ && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {zonesGJ.features.map((zf, i) => {
            const name  = zf.properties.zone_name;
            const color = ZONE_COLORS[i % ZONE_COLORS.length];
            const st    = zoneStats?.[name];
            const conns = topo.filter(l => l.z === name || l.zz === name)
              .map(l => l.z === name ? l.zz : l.z);

            return (
              <div key={name} style={{
                border: `1px solid ${t.panelBorder}`,
                borderLeft: `3px solid ${color}`,
                borderRadius: 4, padding: '7px 9px',
                backgroundColor: 'rgba(128,160,192,0.04)',
              }}>
                {/* Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                  <span style={{ fontSize: '0.68rem', fontWeight: 700, color: t.lbl }}>
                    {name}
                  </span>
                  <span style={{ fontSize: '0.52rem', color: t.lblMuted }}>
                    {st ? fmtMw(st.totalMw) : '—'}
                  </span>
                </div>

                {/* Fuel bar */}
                {st && <FuelBar fuels={st.fuels} totalMw={st.totalMw} />}

                {/* Fuel legend (top 3) */}
                {st && st.totalMw > 0 && (
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 5 }}>
                    {Object.entries(st.fuels)
                      .sort(([, a], [, b]) => b - a)
                      .slice(0, 3)
                      .map(([fuel, mw]) => (
                        <span key={fuel} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                          <span style={{
                            display: 'inline-block', width: 6, height: 6,
                            borderRadius: '50%', backgroundColor: FUEL_COLORS[fuel] || '#888',
                          }} />
                          <span style={{ fontSize: '0.48rem', color: t.muted }}>
                            {FUEL_LABELS[fuel] || fuel}
                          </span>
                        </span>
                      ))}
                  </div>
                )}

                {/* Footer: grid metrics + connections */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 4 }}>
                  <div style={{ display: 'flex', gap: 6, fontSize: '0.48rem', color: t.lblMuted, flexShrink: 0 }}>
                    {st?.subCount > 0 && <span title="Substations">{st.subCount.toLocaleString()} subs</span>}
                    {st?.lineCount > 0 && <span title="Transmission lines">{st.lineCount} lines</span>}
                  </div>
                  {conns.length > 0 && (
                    <div style={{ fontSize: '0.48rem', color: t.lblMuted, textAlign: 'right' }}>
                      ↔ {conns.join(', ')}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Methodology note */}
      {zonesGJ && (
        <p style={{
          fontSize: '0.5rem', color: t.lblMuted, lineHeight: 1.6,
          margin: '10px 0 0', fontStyle: 'italic',
        }}>
          k-means clustering of OSM substations weighted by voltage and nearby population.
          Zone boundaries are Voronoi polygons clipped to the country border.
          Transfer limits are rough proxies from OSM line voltage — validate against TSO data.
        </p>
      )}
    </div>
  );
}
