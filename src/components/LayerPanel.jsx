import { useState } from 'react';
import { FUEL_COLORS, FUEL_LABELS, VOLTAGE_BRACKETS, getT } from '../constants';

const STATUS_CONFIG = [
  {
    key: 'operating',
    label: 'Operating',
    symbol: ({ color }) => (
      <span style={{
        display: 'inline-block', width: 8, height: 8,
        borderRadius: '50%', backgroundColor: color, flexShrink: 0,
      }} />
    ),
  },
  {
    key: 'construction',
    label: 'Construction',
    symbol: ({ color }) => (
      <span style={{
        display: 'inline-block', width: 8, height: 8,
        borderRadius: '50%', border: `2px solid ${color}`,
        backgroundColor: 'transparent', flexShrink: 0,
      }} />
    ),
  },
  {
    key: 'planned',
    label: 'Planned',
    symbol: ({ color }) => (
      <span style={{
        display: 'inline-block', width: 8, height: 8,
        borderRadius: '50%', backgroundColor: color,
        opacity: 0.28, border: `1px solid ${color}`, flexShrink: 0,
      }} />
    ),
  },
];

function DownloadIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
  );
}

function DownloadDropdown({ onDownload, onClose, t }) {
  return (
    <div style={{
      position: 'absolute', right: 0, top: 18, zIndex: 200,
      backgroundColor: t.panel, border: `1px solid ${t.panelBorder}`,
      borderRadius: 5, padding: '3px 0', minWidth: 80,
      boxShadow: '0 4px 12px rgba(0,0,0,0.22)',
    }}>
      {[['GeoJSON', 'geojson'], ['CSV', 'csv']].map(([label, fmt]) => (
        <div key={fmt}
          onClick={() => { onDownload(fmt); onClose(); }}
          style={{
            fontSize: '0.58rem', color: t.lbl, padding: '4px 10px',
            cursor: 'pointer', letterSpacing: '0.5px',
          }}
          onMouseOver={e => e.currentTarget.style.backgroundColor = 'rgba(128,160,192,0.1)'}
          onMouseOut={e => e.currentTarget.style.backgroundColor = 'transparent'}
        >
          {label}
        </div>
      ))}
    </div>
  );
}

export default function LayerPanel({
  theme,
  fuelsOff, statusOff, kvsOff,
  linesOn, plantsOn, subsOn,
  loadCentersOn, lcMinPop, lcCircleScale,
  minMw, circleScale,
  plantSource, gppdAvailable, gemAvailable,
  presentFuels,
  wbView, onWbView,
  onToggleFuel, onToggleStatus,
  onToggleKv, onToggleLines, onTogglePlants, onToggleSubs,
  onToggleLoadCenters, onLcMinPopChange, onLcCircleScaleChange,
  onMinMwChange, onCircleScaleChange, onSourceChange,
  onDownloadPlants, onDownloadLines,
}) {
  const t = getT(theme);
  const [plantsDropOpen, setPlantsDropOpen] = useState(false);
  const [linesDropOpen,  setLinesDropOpen]  = useState(false);

  const sec = {
    fontSize: '0.52rem', letterSpacing: '2.5px',
    fontWeight: 700, color: t.lblMuted, textTransform: 'uppercase',
  };

  const inputStyle = {
    width: 52, fontSize: '0.68rem',
    backgroundColor: 'rgba(128,160,192,0.1)',
    border: `1px solid rgba(128,160,192,0.22)`,
    borderRadius: 4, padding: '2px 6px',
    color: t.lbl, outline: 'none', textAlign: 'right',
    fontFamily: 'inherit',
  };

  const sliderStyle = {
    width: '100%', margin: 0, cursor: 'pointer',
    accentColor: t.muted,
  };

  const dlIconBtn = {
    background: 'none', border: 'none', cursor: 'pointer',
    padding: '1px 3px', borderRadius: 3, color: t.lblMuted,
    display: 'inline-flex', alignItems: 'center', opacity: 0.7,
  };

  const SOURCES = [
    { id: 'osm',  label: 'OSM',      avail: true },
    { id: 'gppd', label: 'WRI GPPD', avail: gppdAvailable },
    { id: 'gem',  label: 'GEM',      avail: gemAvailable  },
  ];

  return (
    <div style={{
      width: 170, height: '100%', overflowY: 'auto',
      padding: '14px 12px',
      backgroundColor: t.panel,
      borderRight: `1px solid ${t.panelBorder}`,
      flexShrink: 0,
    }}>

      {/* ── BASEMAP ───────────────────────────────── */}
      {onWbView && (
        <div style={{ marginBottom: 14 }}>
          <span style={{ ...sec, display: 'block', marginBottom: 6 }}>Basemap</span>
          <div style={{ display: 'flex', gap: 4 }}>
            {[
              { id: 'clean',     label: 'Clean' },
              { id: 'detailed',  label: 'Detailed' },
              { id: 'satellite', label: 'Satellite' },
            ].map(({ id, label }) => {
              const active = wbView.canvas === id;
              return (
                <button key={id} onClick={() => onWbView({ ...wbView, canvas: id })} style={{
                  flex: 1, fontSize: '0.5rem', padding: '3px 0',
                  borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
                  letterSpacing: '0.5px', border: `1px solid ${active ? 'rgba(74,143,204,0.6)' : t.panelBorder}`,
                  backgroundColor: active ? 'rgba(74,143,204,0.12)' : 'transparent',
                  color: active ? t.lbl : t.lblMuted,
                  transition: 'all 0.15s',
                }}>
                  {label}
                </button>
              );
            })}
          </div>
          {/* World Bank reference layers, each on its own switch. Boundaries
              and names are the Bank's (GAD); place names are Esri's. */}
          {[
            { key: 'boundaries',   label: 'Boundaries' },
            { key: 'countryNames', label: 'Country names' },
            { key: 'admin1',       label: 'Admin 1' },
            { key: 'capitals',     label: 'Capitals' },
            { key: 'esriLabels',   label: 'Place names' },
          ].map(({ key, label }) => (
            <div key={key} className="layer-row"
              onClick={() => onWbView({ ...wbView, [key]: !wbView[key] })}
              style={{ marginTop: key === 'boundaries' ? 6 : 3, opacity: wbView[key] ? 1 : 0.35, cursor: 'pointer' }}>
              <span style={{
                display: 'inline-block', width: 5, height: 5, borderRadius: 1,
                backgroundColor: t.isDark ? 'rgba(200,220,240,0.55)' : 'rgba(40,50,60,0.45)',
                marginRight: 8, flexShrink: 0,
              }} />
              <span style={{ fontSize: '0.62rem', color: t.lblRow }}>{label}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── POWER PLANTS ──────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span className="layer-row" onClick={onTogglePlants}
          style={{ opacity: plantsOn ? 1 : 0.35, cursor: 'pointer' }}>
          <span style={sec}>Plants</span>
        </span>
        {onDownloadPlants && (
          <div style={{ position: 'relative' }}>
            <button style={dlIconBtn}
              onClick={e => { e.stopPropagation(); setPlantsDropOpen(v => !v); setLinesDropOpen(false); }}
              title="Download plants">
              <DownloadIcon />
            </button>
            {plantsDropOpen && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 199 }}
                  onClick={() => setPlantsDropOpen(false)} />
                <DownloadDropdown
                  onDownload={onDownloadPlants}
                  onClose={() => setPlantsDropOpen(false)}
                  t={t}
                />
              </>
            )}
          </div>
        )}
      </div>

      {/* Source toggle */}
      {onSourceChange && (
        <>
          <div style={{ display: 'flex', gap: 2, marginBottom: 4 }}>
            {SOURCES.map(({ id, label, avail }) => {
              const active   = plantSource === id;
              const unavail  = avail === false;
              const checking = avail === null && id !== 'osm';
              return (
                <button key={id} onClick={() => !unavail && onSourceChange(id)}
                  style={{
                    flex: 1, fontSize: '0.45rem', letterSpacing: '0.5px',
                    textTransform: 'uppercase', fontFamily: 'inherit',
                    padding: '2px 0', borderRadius: 3,
                    cursor: unavail ? 'default' : 'pointer',
                    border: `1px ${unavail ? 'dashed' : 'solid'} ${active ? 'rgba(128,160,192,0.6)' : 'rgba(128,160,192,0.18)'}`,
                    backgroundColor: active ? 'rgba(128,160,192,0.15)' : 'transparent',
                    color: active ? t.lbl : t.lblMuted,
                    opacity: unavail ? 0.4 : checking ? 0.6 : 1,
                  }}>
                  {label}
                </button>
              );
            })}
          </div>
          {gemAvailable === false && (
            <p style={{ fontSize: '0.44rem', color: '#B8860B', fontStyle: 'italic', marginBottom: 4 }}>
              GEM: run prepare_gem.py
            </p>
          )}
        </>
      )}

      {/* Status filter — only when handler provided (RegionPage) */}
      {onToggleStatus && <div style={{ marginBottom: 6 }}>
        <span style={{ ...sec, fontSize: '0.44rem', display: 'block', marginBottom: 4 }}>Status</span>
        {STATUS_CONFIG.map(({ key, label, symbol: Symbol }) => {
          const off = statusOff?.has(key);
          return (
            <div key={key} className="layer-row"
              onClick={() => onToggleStatus?.(key)}
              style={{ opacity: (!plantsOn || off) ? 0.22 : 1 }}>
              <Symbol color="#888" />
              <span style={{ fontSize: '0.6rem', color: t.lblRow, marginLeft: 6 }}>{label}</span>
            </div>
          );
        })}
      </div>}

      {/* Fuel rows */}
      <div style={{ marginBottom: 8 }}>
        {Object.entries(FUEL_COLORS).map(([fuel, color]) => {
          if (!presentFuels.has(fuel)) return null;
          const off = fuelsOff.has(fuel);
          return (
            <div key={fuel} className="layer-row"
              onClick={() => onToggleFuel(fuel)}
              style={{ opacity: off ? 0.25 : 1 }}>
              <span style={{
                display: 'inline-block', width: 7, height: 7,
                borderRadius: '50%', backgroundColor: color,
                marginRight: 6, flexShrink: 0,
              }} />
              <span style={{ fontSize: '0.62rem', color: t.lblRow }}>
                {FUEL_LABELS[fuel] || fuel}
              </span>
            </div>
          );
        })}
      </div>

      {/* Circle size */}
      <div style={{ marginBottom: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
          <span style={{ fontSize: '0.57rem', color: t.lblMuted }}>size</span>
          <span style={{ fontSize: '0.57rem', color: t.lblMuted }}>{circleScale.toFixed(1)}×</span>
        </div>
        <input type="range" min={0.4} max={2.5} step={0.1}
          value={circleScale} style={sliderStyle}
          onChange={e => onCircleScaleChange(parseFloat(e.target.value))} />
      </div>

      {/* Min MW */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
        <span style={{ fontSize: '0.57rem', color: t.lblMuted }}>min</span>
        <input type="number" value={minMw} min={0} step={50}
          style={inputStyle}
          onChange={e => onMinMwChange(Math.max(0, parseInt(e.target.value) || 0))} />
        <span style={{ fontSize: '0.57rem', color: t.lblMuted }}>MW</span>
      </div>

      <hr style={{ borderColor: 'rgba(128,160,192,0.18)', margin: '10px 0 8px' }} />

      {/* ── TRANSMISSION ──────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span className="layer-row" onClick={onToggleLines}
          style={{ opacity: linesOn ? 1 : 0.35, cursor: 'pointer' }}>
          <span style={sec}>Transmission</span>
          <span style={{ fontSize: '0.44rem', color: t.lblMuted, marginLeft: 5, fontWeight: 400, letterSpacing: 0, textTransform: 'none' }}>(OSM)</span>
        </span>
        {onDownloadLines && (
          <div style={{ position: 'relative' }}>
            <button style={dlIconBtn}
              onClick={e => { e.stopPropagation(); setLinesDropOpen(v => !v); setPlantsDropOpen(false); }}
              title="Download lines">
              <DownloadIcon />
            </button>
            {linesDropOpen && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 199 }}
                  onClick={() => setLinesDropOpen(false)} />
                <DownloadDropdown
                  onDownload={onDownloadLines}
                  onClose={() => setLinesDropOpen(false)}
                  t={t}
                />
              </>
            )}
          </div>
        )}
      </div>

      {VOLTAGE_BRACKETS.map(({ colors, label, key }) => {
        const off = kvsOff.has(key);
        const lineColor = colors[theme] ?? colors.fog;
        return (
          <div key={key} className="layer-row"
            onClick={() => onToggleKv(key)}
            style={{ opacity: (!linesOn || off) ? 0.22 : 1 }}>
            <span style={{
              display: 'inline-block', width: 16, height: 2,
              backgroundColor: lineColor, marginRight: 7,
              borderRadius: 1, flexShrink: 0,
            }} />
            <span style={{ fontSize: '0.62rem', color: t.lblRow }}>{label}</span>
          </div>
        );
      })}

      {/* Substations */}
      {onToggleSubs && (
        <div className="layer-row" onClick={onToggleSubs}
          style={{ marginTop: 6, opacity: subsOn ? 1 : 0.22 }}>
          <span style={{
            display: 'inline-block', width: 5, height: 5, borderRadius: 1,
            backgroundColor: t.isDark ? 'rgba(200,220,240,0.55)' : 'rgba(40,50,60,0.45)',
            marginRight: 8, flexShrink: 0,
          }} />
          <span style={{ fontSize: '0.62rem', color: t.lblRow }}>Substations</span>
        </div>
      )}

      {/* ── LOAD CENTERS ──────────────────────────── */}
      {onToggleLoadCenters && (
        <>
          <hr style={{ borderColor: 'rgba(128,160,192,0.18)', margin: '10px 0 6px' }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <span className="layer-row" onClick={onToggleLoadCenters}
              style={{ opacity: loadCentersOn ? 1 : 0.35, cursor: 'pointer' }}>
              <span style={{
                display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
                backgroundColor: '#1a237e', marginRight: 6, flexShrink: 0, opacity: 0.75,
              }} />
              <span style={sec}>Load Centers</span>
            </span>
          </div>
          <div style={{ display: 'flex', gap: 2, opacity: loadCentersOn ? 1 : 0.4 }}>
            {[[100_000, '100k+'], [300_000, '300k+'], [1_000_000, '1M+']].map(([v, label]) => {
              const active = lcMinPop === v;
              return (
                <button key={v} onClick={() => onLcMinPopChange(v)} style={{
                  flex: 1, fontSize: '0.44rem', letterSpacing: '0.5px',
                  fontFamily: 'inherit', padding: '2px 0', borderRadius: 3,
                  cursor: 'pointer',
                  border: `1px solid ${active ? 'rgba(26,35,126,0.5)' : 'rgba(128,160,192,0.18)'}`,
                  backgroundColor: active ? 'rgba(26,35,126,0.1)' : 'transparent',
                  color: active ? t.lbl : t.lblMuted,
                }}>
                  {label}
                </button>
              );
            })}
          </div>
          {onLcCircleScaleChange && lcCircleScale != null && (
            <div style={{ marginTop: 5, opacity: loadCentersOn ? 1 : 0.4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                <span style={{ fontSize: '0.57rem', color: t.lblMuted }}>size</span>
                <span style={{ fontSize: '0.57rem', color: t.lblMuted }}>{lcCircleScale.toFixed(1)}×</span>
              </div>
              <input type="range" min={0.4} max={2.5} step={0.1}
                value={lcCircleScale} style={sliderStyle}
                onChange={e => onLcCircleScaleChange(parseFloat(e.target.value))} />
            </div>
          )}
        </>
      )}

    </div>
  );
}
