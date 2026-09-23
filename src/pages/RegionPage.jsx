import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import { track } from '../analytics';
import { useTheme } from '../App';
import {
  getT, mapStyle, swapBasemap, toggleSatLabels, FUEL_COLORS, VOLTAGE_BRACKETS,
  plantRadiusExpr, lcRadiusExpr, fuelColorExpr, PLANT_STATUSES, zoneColorExpr,
} from '../constants';
import CapacityChart from '../components/CapacityChart';
import StatsPanel from '../components/StatsPanel';
import {
  fetchEpmCSV, fetchLinestringGeoJSON, fetchZonesGeoJSON, fetchZonesExtGeoJSON, fetchZonesOffgridGeoJSON, fetchZcmapList, fetchDataFolderList,
  fetchRunList, fetchGitHubDir, fetchResultCSV, resolveOutputDir,
  processGenData, processDemand, processDemandData, processTransmissionResults,
  processNTC, processExtNTC, processDemandProfileFull, processVREProfile, processAvailability, processFuelPrice, processHours, processTimeSlices,
  availableYears, EPM_FUEL_COLORS, STATUS_LABEL,
  normalizeFuel, rawFileUrl, processNewTransmission, settingValue,
} from '../utils/epmFetch';
import { buildTimeAxis, buildSeasonAxis, blockLabels, axisTicks, bandingPlugin, dayWeights } from '../utils/timeAxis';
import { buildExtZoneData, addExtZoneLayers, bindExtZoneHandlers, updateExtZoneData, setExtZonesVisible } from '../utils/extZones';
import { addOffgridLayers } from '../utils/offgridZones';
import { fetchScenarioConfig, resolveFile, baseName } from '../utils/epmScenarios';
import RawDataTable from '../components/RawDataTable';
import DownloadAllExcel from '../components/DownloadAllExcel';
import { exportName, inputUnitFrom, scenarioMatrixRows } from '../utils/xlsxExport';
import { fetchDataSources } from '../utils/dataSources';
import { annotateCsv, inputLines } from '../utils/csvMeta';
import { zoneCentroidMap } from '../utils/centroids';
import VariantPicker from '../components/VariantPicker';
import ScenarioTab from '../components/ScenarioTab';
import { fetchScenarioDocs, scenarioDocIndex } from '../utils/scenarioDocs';
import { fetchCountries, fetchBoundaries, addCountriesSource, addBaseLayers, regionFilter, addRegionCoast, raiseBoundaries } from '../utils/basemap';
import { source } from '../utils/mapSource';
import { usePromotedEpmData } from '../utils/usePromotedZones';
import CJChart from '../components/CJChart';
import MapDownload from '../components/MapDownload';
import { ttl } from '../utils/chartTitle';
import PanelZoomControl, { usePanelZoom, unzoom } from '../components/PanelZoom';
import { dataPath } from '../utils/paths';

// chart.js via CDN — no npm dep
// Map zone fills — blues/teals/gold only
const MAP_PALETTE = [
  '#1B6CA8','#36B5B5','#E8C547','#4DA6FF',
  '#0D7680','#85C1E9','#2E9EC8','#5EBCBA',
  '#1A5276','#7EC8E3','#14A094','#4CAFE8',
  '#EDD770','#AED6F1','#1F618D','#0A6B70',
];
// Chart colors — same tasteful palette as map (blues/teals/gold, no neon)
const CHART_PALETTE = [
  '#1B6CA8','#36B5B5','#E8C547','#4DA6FF',
  '#4169E1','#85C1E9','#2E9EC8','#5EBCBA',
  '#1A5276','#7EC8E3','#14A094','#4CAFE8',
  '#EDD770','#AED6F1','#1F618D','#0A6B70',
];
const ZONE_PALETTE = CHART_PALETTE; // legacy alias for chart code

// ── Helpers ───────────────────────────────────────────────────────────────────

function fitBounds(isos, countries) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const f of countries.features) {
    if (!isos.includes(f.properties.ISO_A3)) continue;
    const geom = f.geometry;
    const rings = geom.type === 'Polygon' ? geom.coordinates : geom.coordinates.flatMap(p => p);
    for (const ring of rings)
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
      }
  }
  if (!isFinite(minLon)) return null;
  return [[minLon - 0.5, minLat - 0.5], [maxLon + 0.5, maxLat + 0.5]];
}

function makeLayerFilter(status, fuelsOff, minMw) {
  const clauses = [['==', ['get', 'status'], status], ['>=', ['get', 'mw'], minMw]];
  if (fuelsOff.size > 0)
    clauses.push(['!', ['in', ['get', 'fuel'], ['literal', [...fuelsOff]]]]);
  return ['all', ...clauses];
}

function downloadBlob(content, filename, type = 'application/octet-stream') {
  const blob = new Blob([content], { type });
  const url  = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function genForYear(genRows, year) {
  if (!year) return genRows.filter(g => g.status === 1);
  const yr = parseInt(year);
  return genRows.filter(g => {
    if (g.status === 1) return !g.retrYr || g.retrYr > yr;
    if (g.status === 2) return g.stYr && g.stYr <= yr && (!g.retrYr || g.retrYr > yr);
    return false;
  });
}

function makeDonutSVG(fuelMix, tv, size = 54) {
  const cx = size / 2, cy = size / 2;
  const r  = size / 2 - 10;
  const sw = 8;
  const circum = 2 * Math.PI * r;
  const entries = Object.entries(fuelMix).filter(([, v]) => v > 0);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (total === 0 || r <= 0) return '';
  let cumDeg = -90;
  const arcs = entries.map(([fuel, mw]) => {
    const angle = (mw / total) * 360;
    const color = EPM_FUEL_COLORS[fuel] || '#AAAAAA';
    // A 100% slice ends exactly where it starts, and SVG draws nothing for an arc
    // whose endpoint equals its origin: a single-fuel zone would come out blank.
    if (angle >= 359.999) {
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}"/>`;
    }
    const start = (cumDeg * Math.PI) / 180;
    const end   = ((cumDeg + angle) * Math.PI) / 180;
    cumDeg += angle;
    const x1 = cx + r * Math.cos(start), y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end),   y2 = cy + r * Math.sin(end);
    const large = angle > 180 ? 1 : 0;
    return `<path d="M${x1} ${y1} A${r} ${r} 0 ${large} 1 ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="butt"/>`;
  });
  const totalGW   = total / 1000;
  const label = totalGW >= 1 ? totalGW.toFixed(1) : total.toFixed(0);
  const unit  = totalGW >= 1 ? 'GW' : 'MW';
  const bg    = tv.isDark ? 'rgba(20,20,20,0.82)' : 'rgba(255,255,255,0.88)';
  const tc    = tv.isDark ? '#fff' : '#111';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <circle cx="${cx}" cy="${cy}" r="${r + sw / 2 + 1}" fill="${bg}" stroke="rgba(0,0,0,0.18)" stroke-width="0.5"/>
    ${arcs.join('')}
    <text x="${cx}" y="${cy - 1}" text-anchor="middle" font-size="7" font-weight="700" fill="${tc}" font-family="'Open Sans', system-ui, sans-serif">${label}</text>
    <text x="${cx}" y="${cy + 7.5}" text-anchor="middle" font-size="5.5" fill="${tc}" font-family="'Open Sans', system-ui, sans-serif" opacity="0.65">${unit}</text>
  </svg>`;
}

// ── Shared mini utilities ─────────────────────────────────────────────────────

function NotAvailable({ t }) {
  return (
    <div style={{ border: `1px dashed ${t.panelBorder}`, borderRadius: 8,
      padding: '24px 16px', textAlign: 'center', color: t.lblMuted, fontSize: '0.58rem' }}>
      <div style={{ fontSize: '0.6rem', fontWeight: 700, color: t.lbl, marginBottom: 4 }}>Not available</div>
      No EPM input data configured for this region yet.
    </div>
  );
}
function SectionTitle({ t, children }) {
  return (
    <div style={{ fontSize: '0.47rem', letterSpacing: '2px', fontWeight: 700,
      color: t.lblMuted, textTransform: 'uppercase', marginBottom: 6 }}>
      {children}
    </div>
  );
}
function LoadingBox({ t }) {
  return (
    <div style={{ padding: '24px 0', textAlign: 'center', color: t.lblMuted, fontSize: '0.6rem' }}>
      Loading EPM data…
    </div>
  );
}
function fmt(n, digits = 0) {
  if (n == null || isNaN(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}
function cjDefaults(t) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: t.panel, borderColor: t.panelBorder, borderWidth: 1,
        titleColor: t.lbl, bodyColor: t.muted,
        titleFont: { size: 9 }, bodyFont: { size: 9 }, padding: 6,
      },
    },
    scales: {
      x: { grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 9 } } },
      y: { grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 9 } } },
    },
  };
}
function hexA(hex, a) {
  if (!hex || hex.length < 7) return `rgba(128,128,128,${a})`;
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}

// ── Overview tab ──────────────────────────────────────────────────────────────

const RE_FUELS_SET = new Set(['hydro','solar','wind','biomass','geothermal','biogas','waste']);

function EpmOverviewTab({ t, epmData, region, epmYear, setEpmYear }) {
  const [mixView, setMixView] = useState('country');
  const { gen, demand, ntc, zcmap } = epmData;
  const allYears = availableYears(demand);
  const refYr    = epmYear || allYears.find(y => y === '2024') || allYears[0];

  const existing   = genForYear(gen, epmYear);
  const totalGW    = existing.reduce((s, r) => s + r.capacity, 0) / 1000;
  const reMW       = existing.filter(r => RE_FUELS_SET.has(r.fuel)).reduce((s, r) => s + r.capacity, 0);
  const reShare    = totalGW > 0 ? Math.round(reMW / (totalGW * 1000) * 100) : 0;
  const peakGW     = demand.filter(r => r.type === 'peak').reduce((s, r) => s + (r.years[refYr] || 0), 0) / 1000;
  const energyTWh  = demand.filter(r => r.type === 'energy').reduce((s, r) => s + (r.years[refYr] || 0), 0) / 1000;

  // Deduplicated corridors
  const seenNTC = new Set();
  const uniqueNTC = ntc.filter(r => { const k = [r.z,r.z2].sort().join('||'); if (seenNTC.has(k)) return false; seenNTC.add(k); return true; });
  const txGW = uniqueNTC.reduce((s, r) => s + (r.years[refYr] || 0), 0) / 1000;

  const nZones     = zcmap.length;
  const nCountries = region.countries.length;

  // Fuel mix for donut
  const fuelAgg = {};
  for (const r of existing) fuelAgg[r.fuel] = (fuelAgg[r.fuel] || 0) + r.capacity;
  const fuelData = Object.entries(fuelAgg).map(([fuel, mw]) => ({ fuel, mw: Math.round(mw) })).sort((a, b) => b.mw - a.mw);

  // Mix by country / zone
  const zoneToCountry = Object.fromEntries(zcmap.map(r => [r.z, r.c]));
  const countryMix = {}, zoneMix = {};
  for (const r of existing) {
    const c = zoneToCountry[r.zone] || r.zone;
    if (!countryMix[c]) countryMix[c] = {};
    countryMix[c][r.fuel] = (countryMix[c][r.fuel] || 0) + r.capacity;
    if (!zoneMix[r.zone]) zoneMix[r.zone] = {};
    zoneMix[r.zone][r.fuel] = (zoneMix[r.zone][r.fuel] || 0) + r.capacity;
  }
  const mixData   = mixView === 'country' ? countryMix : zoneMix;
  const mixLabels = Object.entries(mixData)
    .sort((a, b) => Object.values(b[1]).reduce((s,v)=>s+v,0) - Object.values(a[1]).reduce((s,v)=>s+v,0))
    .map(([l]) => l);
  const allFuels = [...new Set(fuelData.map(d => d.fuel))];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Donut + KPI rows */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ flexShrink: 0, width: 100, textAlign: 'center' }}>
          <CJChart name={ttl('Capacity mix by fuel (MW)')} type="doughnut" height={100}
            data={{ labels: fuelData.map(d => d.fuel), datasets: [{ data: fuelData.map(d => d.mw),
              backgroundColor: fuelData.map(d => EPM_FUEL_COLORS[d.fuel] || '#aaa'),
              borderWidth: 1.5, borderColor: t.panel, hoverOffset: 3 }] }}
            options={{ cutout: '60%', responsive: true, maintainAspectRatio: false, layout: { padding: 3 },
              plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${c.label}: ${c.parsed.toLocaleString()} MW` } } } }}
          />
          <div style={{ fontSize: '0.4rem', color: t.lblMuted, marginTop: 2 }}>Existing mix</div>
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <span style={{ fontSize: '0.42rem', color: t.lblMuted, flexShrink: 0 }}>Year</span>
            <select value={epmYear || ''} onChange={e => setEpmYear(e.target.value || null)}
              style={{ fontSize: '0.48rem', padding: '2px 4px', borderRadius: 4,
                border: `1px solid ${t.panelBorder}`, background: t.panel, color: t.lbl, cursor: 'pointer' }}>
              {allYears.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 5 }}>
            {[
              { l: `Peak ${refYr||''}`, v: `${peakGW.toFixed(1)} GW` },
              { l: `Energy ${refYr||''}`, v: `${energyTWh.toFixed(0)} TWh` },
              { l: 'Installed', v: `${totalGW.toFixed(1)} GW` },
              { l: 'RE Share', v: `${reShare}%` },
            ].map(({ l, v }) => (
              <div key={l} style={{ border: `1px solid ${t.panelBorder}`, borderRadius: 5, padding: '6px 8px' }}>
                <div style={{ fontSize: '0.4rem', color: t.lblMuted, marginBottom: 2 }}>{l}</div>
                <div style={{ fontSize: '0.72rem', fontWeight: 700, color: t.lbl }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 5 }}>
            {[
              { l: 'Countries', v: nCountries },
              { l: 'Zones', v: nZones },
              { l: 'Gen. units', v: gen.length },
              { l: 'TX Cap.', v: `${txGW.toFixed(1)} GW` },
              { l: 'Corridors', v: uniqueNTC.length },
            ].map(({ l, v }) => (
              <div key={l} style={{ border: `1px solid ${t.panelBorder}`, borderRadius: 5, padding: '5px 8px' }}>
                <div style={{ fontSize: '0.39rem', color: t.lblMuted, marginBottom: 1 }}>{l}</div>
                <div style={{ fontSize: '0.6rem', fontWeight: 700, color: t.lbl }}>{v}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Mix chart — country/zone toggle — FIRST */}
      {mixLabels.length > 0 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <SectionTitle t={t}>Capacity mix (MW)</SectionTitle>
            <div style={{ display: 'flex', gap: 3 }}>
              {[['country','Countries'],['zone','Zones']].map(([v, l]) => (
                <button key={v} onClick={() => setMixView(v)} style={{
                  fontSize: '0.44rem', fontFamily: 'inherit', padding: '2px 7px', borderRadius: 3, cursor: 'pointer',
                  border: `1px solid ${mixView===v ? 'rgba(74,143,204,0.65)' : t.panelBorder}`,
                  backgroundColor: mixView===v ? 'rgba(74,143,204,0.12)' : 'transparent',
                  color: mixView===v ? t.lbl : t.lblMuted, fontWeight: mixView===v ? 600 : 400,
                }}>{l}</button>
              ))}
            </div>
          </div>
          <div style={{ display:'flex', gap:6, alignItems:'flex-start' }}>
            <div style={{ flex:1, minWidth:0 }}>
              <CJChart name={ttl('Capacity mix (MW)',mixView==='country'?'by country':'by zone')} type="bar" height={Math.min(mixLabels.length * 22 + 24, 280)}
                data={{
                  labels: mixLabels,
                  datasets: allFuels.map(fuel => ({
                    label: fuel,
                    data: mixLabels.map(l => Math.round(mixData[l]?.[fuel] || 0)),
                    backgroundColor: EPM_FUEL_COLORS[fuel] || EPM_FUEL_COLORS.other,
                    borderWidth: 0, barThickness: 14, stack: 'a',
                  })),
                }}
                options={{ ...cjDefaults(t), indexAxis: 'y',
                  scales: {
                    x: { stacked: true, grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 9 }, callback: v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v } },
                    y: { stacked: true, grid: { display: false }, ticks: { color: t.muted, font: { size: 9 } } },
                  },
                  plugins: { ...cjDefaults(t).plugins, legend: { display: false },
                    tooltip: { ...cjDefaults(t).plugins.tooltip, callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.raw.toLocaleString()} MW` } } },
                }}
              />
            </div>
            <div style={{ width:90, flexShrink:0, display:'flex', flexDirection:'column', gap:2, paddingTop:4, maxHeight:280, overflowY:'auto' }}>
              {allFuels.map(f => (
                <div key={f} style={{ display:'flex', alignItems:'center', gap:3 }}>
                  <div style={{ width:8, height:8, borderRadius:2, backgroundColor:EPM_FUEL_COLORS[f]||'#aaa', flexShrink:0 }}/>
                  <span style={{ fontSize:'0.4rem', color:t.muted, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{f}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {region.epm && (
        <a href={`https://github.com/ESMAP-World-Bank-Group/EPM/tree/${region.epm.branch}`}
          target="_blank" rel="noreferrer"
          style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.52rem', color: t.lblMuted, textDecoration: 'none', marginTop: 2 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
          View on GitHub · {region.epm.branch}
        </a>
      )}
    </div>
  );
}

// ── Supply tab ────────────────────────────────────────────────────────────────
function SupPill({ active, color, onClick, children }) {
  return (
    <button onClick={onClick} style={{ fontSize:'0.44rem', fontFamily:'inherit', padding:'2px 8px', borderRadius:3, cursor:'pointer',
      border:`1px solid ${active?(color||'rgba(74,143,204,0.65)'):'rgba(128,160,192,0.2)'}`,
      backgroundColor:active?hexA(color||'#4a8fcc',0.12):'transparent',
      color:active?(color||'rgba(74,143,204,1)'):'rgba(128,160,192,0.7)', fontWeight:active?600:400, display:'flex', alignItems:'center', gap:4 }}>
      {children}
    </button>
  );
}

function EpmSupplyTab({ t, epmData, region, scnMeta, varOverrides, setVariant }) {
  const { gen, zcmap } = epmData;
  const [visStatuses, setVisStatuses] = useState(new Set([1]));
  const [hiddenFuels, setHiddenFuels] = useState(new Set());
  const [selectedPlant, setSelectedPlant] = useState(null);
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState('capacity');
  const [selectedCountries, setSelectedCountries] = useState(new Set());

  const zoneToCountry = Object.fromEntries(zcmap.map(r => [r.z, r.c]));
  const filtered = gen.filter(r => visStatuses.has(r.status) && !hiddenFuels.has(r.fuel));
  const searched = search
    ? filtered.filter(r => r.g.toLowerCase().includes(search.toLowerCase()) ||
        r.zone.toLowerCase().includes(search.toLowerCase()) ||
        r.fuel.toLowerCase().includes(search.toLowerCase()) ||
        (r.tech||'').toLowerCase().includes(search.toLowerCase()))
    : filtered;
  const sorted = [...searched].sort((a, b) => {
    if (sortCol === 'capacity') return b.capacity - a.capacity;
    if (sortCol === 'name')     return a.g.localeCompare(b.g);
    if (sortCol === 'fuel')     return a.fuel.localeCompare(b.fuel);
    if (sortCol === 'tech')     return (a.tech||'').localeCompare(b.tech||'');
    if (sortCol === 'zone')     return a.zone.localeCompare(b.zone);
    if (sortCol === 'country')  return (zoneToCountry[a.zone]||'').localeCompare(zoneToCountry[b.zone]||'');
    if (sortCol === 'status')   return a.status - b.status;
    return 0;
  });

  // Chart by fuel
  const fuels = [...new Set(gen.map(r => r.fuel))].sort();
  const byFS = {};
  for (const r of filtered) {
    if (!byFS[r.fuel]) byFS[r.fuel] = { 1: 0, 2: 0, 3: 0 };
    byFS[r.fuel][r.status] = (byFS[r.fuel][r.status] || 0) + r.capacity;
  }
  const fuelChartData = fuels
    .filter(f => byFS[f])
    .map(f => ({ fuel: f, ex: Math.round(byFS[f]?.[1] || 0), co: Math.round(byFS[f]?.[2] || 0), ca: Math.round(byFS[f]?.[3] || 0) }))
    .sort((a, b) => (b.ex + b.co + b.ca) - (a.ex + a.co + a.ca));

  // Chart by country (split by status for opacity)
  const byCountryFuelStatus = {};
  for (const r of filtered) {
    const country = zoneToCountry[r.zone] || r.zone;
    if (!byCountryFuelStatus[country]) byCountryFuelStatus[country] = {};
    if (!byCountryFuelStatus[country][r.fuel]) byCountryFuelStatus[country][r.fuel] = {1:0,2:0,3:0};
    byCountryFuelStatus[country][r.fuel][r.status] = (byCountryFuelStatus[country][r.fuel][r.status]||0) + r.capacity;
  }
  const ctryData = Object.entries(byCountryFuelStatus)
    .map(([c, fuelMap]) => ({ c, total: Object.values(fuelMap).reduce((s,v)=>s+(v[1]||0)+(v[2]||0)+(v[3]||0),0), fuelMap }))
    .sort((a, b) => b.total - a.total);
  const allFuels = [...new Set(filtered.map(r => r.fuel))];

  const ytClickPlugin = {
    id: 'ytClick',
    afterEvent: (chart, args) => {
      const e = args.event;
      if (e.type !== 'mousemove') return;
      const ca = chart.chartArea;
      if (!ca) return;
      chart.canvas.style.cursor = (e.x < ca.left && e.x >= 0) ? 'pointer' : '';
    }
  };

  const toggleStatus = s => setVisStatuses(prev => {
    const next = new Set(prev);
    if (next.has(s)) { if (next.size > 1) next.delete(s); } else next.add(s);
    return next;
  });
  const toggleFuel = f => setHiddenFuels(prev => {
    const next = new Set(prev);
    if (next.has(f)) next.delete(f); else next.add(f);
    return next;
  });

  const statusConfig = [
    { s: 1, label: 'Existing',  color: '#1a5fa8' },
    { s: 2, label: 'Committed', color: '#e07b00' },
    { s: 3, label: 'Candidate', color: '#888' },
  ];

  const handleDownload = async () => {
    const { branch, dataFolder } = region.epm;
    // The chart follows the variant picked above, so the download has to as well
    // -- handing back the default while the page shows a variant is how you end
    // up comparing a file against a figure it did not produce.
    const relPath = resolveFile(scnMeta, varOverrides, 'pGenDataInput', 'supply/pGenDataInput.csv');
    const url = rawFileUrl(branch, `epm/input/${dataFolder}/${relPath}`);
    try {
      const res = await fetch(url);
      // An error body saved under the CSV's name looks like a corrupt file to the
      // user, so refuse the download instead of writing it out.
      if (!res.ok) { alert(`Download failed (${res.status})`); return; }
      const filename = relPath.split('/').pop();
      const text = annotateCsv(await res.text(), {
        filename,
        lines: inputLines({
          filename, param: 'pGenDataInput', meta: scnMeta?.paramMeta?.pGenDataInput,
          regionName: region.name, branch, dataFolder, url,
        }),
      });
      downloadBlob(text, `pGenDataInput_${region.id}.csv`, 'text/csv');
    } catch { alert('Download failed'); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <VariantPicker t={t} scnMeta={scnMeta} param="pGenDataInput" value={varOverrides?.pGenDataInput} onChange={setVariant} />
      {/* Status toggles */}
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        {statusConfig.map(({ s, label, color }) => (
          <SupPill key={s} active={visStatuses.has(s)} color={color} onClick={() => toggleStatus(s)}>
            <span style={{ display:'inline-block', width:6, height:6, borderRadius:'50%', backgroundColor:color }}/>
            {label}
          </SupPill>
        ))}
      </div>

      {/* Fuel legend filter */}
      <div style={{ display:'flex', gap:7, flexWrap:'wrap', alignItems:'center' }}>
        {fuels.map(fuel => {
          const hidden = hiddenFuels.has(fuel);
          const fc = EPM_FUEL_COLORS[fuel] || EPM_FUEL_COLORS.other;
          return (
            <div key={fuel} onClick={() => toggleFuel(fuel)}
              style={{ display:'flex', alignItems:'center', gap:3, cursor:'pointer', opacity:hidden?0.3:1, userSelect:'none' }}>
              <div style={{ width:8, height:8, borderRadius:1, backgroundColor:fc, flexShrink:0 }}/>
              <span style={{ fontSize:'0.42rem', color:t.muted }}>{fuel}</span>
            </div>
          );
        })}
        <div style={{ width:1, backgroundColor:t.panelBorder, height:10, margin:'0 2px' }}/>
        <span onClick={() => setHiddenFuels(new Set())} style={{ fontSize:'0.42rem', color:t.lblMuted, cursor:'pointer', userSelect:'none' }}>All</span>
        <span onClick={() => setHiddenFuels(new Set(fuels))} style={{ fontSize:'0.42rem', color:t.lblMuted, cursor:'pointer', userSelect:'none' }}>None</span>
      </div>

      {/* Chart by fuel */}
      <div>
        <SectionTitle t={t}>Capacity by fuel (MW)</SectionTitle>
        <div style={{ display:'flex', gap:6, alignItems:'flex-start' }}>
          <div style={{ flex:1, minWidth:0 }}>
            <CJChart name={ttl('Capacity by fuel (MW)')} type="bar" height={Math.min(fuelChartData.length * 22 + 24, 260)}
              cacheKey={`supply-fuel|${[...visStatuses].sort().join(',')}|${[...hiddenFuels].sort().join(',')}`}
              data={{ labels: fuelChartData.map(d => d.fuel), datasets: [
                { label:'Existing',  data:fuelChartData.map(d=>d.ex), backgroundColor:fuelChartData.map(d=>EPM_FUEL_COLORS[d.fuel]||EPM_FUEL_COLORS.other), borderWidth:0, barThickness:12, stack:'a' },
                { label:'Committed', data:fuelChartData.map(d=>d.co), backgroundColor:fuelChartData.map(d=>hexA(EPM_FUEL_COLORS[d.fuel]||EPM_FUEL_COLORS.other,0.5)), borderWidth:0, barThickness:12, stack:'a' },
                { label:'Candidate', data:fuelChartData.map(d=>d.ca), backgroundColor:fuelChartData.map(d=>hexA(EPM_FUEL_COLORS[d.fuel]||EPM_FUEL_COLORS.other,0.22)), borderWidth:0, barThickness:12, stack:'a' },
              ]}}
              options={{ ...cjDefaults(t), indexAxis:'y', scales: {
                x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},
                y:{stacked:true,grid:{display:false},ticks:{color:t.muted,font:{size:9}}},
              }}}
            />
          </div>
          <div style={{ width:90, flexShrink:0, display:'flex', flexDirection:'column', gap:3, paddingTop:4 }}>
            {[['Existing',1.0,'#1a5fa8'],['Committed',0.5,'#e07b00'],['Candidate',0.22,'#888']].map(([lbl,op,c])=>(
              <div key={lbl} style={{ display:'flex', alignItems:'center', gap:3 }}>
                <div style={{ width:8, height:8, borderRadius:2, backgroundColor:c, opacity:op, flexShrink:0 }}/>
                <span style={{ fontSize:'0.4rem', color:t.muted }}>{lbl}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Chart by country */}
      {ctryData.length > 0 && (
        <div>
          <SectionTitle t={t}>
            Capacity by country (MW)
            {selectedCountries.size > 0 && (
              <span onClick={() => setSelectedCountries(new Set())}
                style={{ marginLeft:6, fontSize:'0.38rem', color:t.lblMuted, cursor:'pointer', fontWeight:400, opacity:0.7 }}>
                × clear
              </span>
            )}
          </SectionTitle>
          <CJChart name={ttl('Capacity by country (MW)',selectedCountries.size?[...selectedCountries].join(', '):null)} type="bar" height={Math.min(ctryData.length * 24 + 24, 260)}
            cacheKey={`supply-country|${[...visStatuses].sort().join(',')}|${[...hiddenFuels].sort().join(',')}|${[...selectedCountries].sort().join(',')}`}
            plugins={[ytClickPlugin]}
            data={{
              labels: ctryData.map(d => d.c),
              datasets: allFuels.flatMap(fuel => {
                const fc = EPM_FUEL_COLORS[fuel] || EPM_FUEL_COLORS.other;
                const vis = d => selectedCountries.size === 0 || selectedCountries.has(d.c);
                return [
                  { label:fuel, data:ctryData.map(d=>vis(d)?Math.round(d.fuelMap[fuel]?.[1]||0):0),
                    backgroundColor:fc, borderWidth:0, barThickness:14, stack:'a' },
                  { label:fuel, data:ctryData.map(d=>vis(d)?Math.round(d.fuelMap[fuel]?.[2]||0):0),
                    backgroundColor:hexA(fc,0.5), borderWidth:0, barThickness:14, stack:'a' },
                  { label:fuel, data:ctryData.map(d=>vis(d)?Math.round(d.fuelMap[fuel]?.[3]||0):0),
                    backgroundColor:hexA(fc,0.22), borderWidth:0, barThickness:14, stack:'a' },
                ];
              }),
            }}
            options={{ ...cjDefaults(t), indexAxis: 'y',
              onClick: (event, _els, chart) => {
                const { chartArea, scales } = chart;
                if (!chartArea || !scales.y) return;
                if (event.x > chartArea.left) return;
                const yScale = scales.y;
                let closest = null, minDist = Infinity;
                yScale.ticks.forEach((tick, i) => {
                  const dist = Math.abs(yScale.getPixelForTick(i) - event.y);
                  if (dist < minDist) { minDist = dist; closest = tick.label; }
                });
                if (closest && minDist < 14) {
                  setSelectedCountries(prev => {
                    const next = new Set(prev);
                    if (next.has(closest)) next.delete(closest); else next.add(closest);
                    return next;
                  });
                }
              },
              scales: {
                x: { stacked: true, grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 9 },
                  callback: v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v } },
                y: { stacked: true, grid: { display: false },
                  ticks: {
                    color: ctryData.map(d => selectedCountries.size === 0 || selectedCountries.has(d.c) ? t.muted : 'rgba(128,128,128,0.15)'),
                    font: { size: 9 }
                  }
                },
              },
              plugins: { ...cjDefaults(t).plugins, legend: { display: false },
                tooltip: { ...cjDefaults(t).plugins.tooltip,
                  filter: item => item.raw > 0,
                  callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.raw.toLocaleString()} MW` } } },
            }}
          />
        </div>
      )}

      {/* Plant database */}
      <div>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
          <SectionTitle t={t}>Plant database ({sorted.length})</SectionTitle>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search…"
            style={{ fontSize:'0.44rem', fontFamily:'inherit', padding:'2px 6px', borderRadius:3,
              border:`1px solid ${t.panelBorder}`, backgroundColor:t.panel, color:t.lbl, width:90, outline:'none' }}/>
        </div>
        <div style={{ border:`1px solid ${t.panelBorder}`, borderRadius:6, overflow:'hidden' }}>
          {/* Header */}
          <div style={{ display:'grid', gridTemplateColumns:'2fr 72px 22px 54px 52px 52px',
            padding:'4px 8px', backgroundColor:hexA(t.panelBorder,0.4), borderBottom:`1px solid ${t.panelBorder}`, position:'sticky', top:0 }}>
            {[['name','Plant'],['country','Country / Zone'],['status','St'],['fuel','Fuel'],['tech','Tech'],['capacity','MW']].map(([col,lbl])=>(
              <span key={col} onClick={()=>setSortCol(col)} style={{ fontSize:'0.41rem', color:sortCol===col?t.lbl:t.lblMuted, fontWeight:sortCol===col?700:400, cursor:'pointer', textAlign:col==='capacity'?'right':'left', userSelect:'none' }}>
                {lbl}{sortCol===col?' ↓':''}
              </span>
            ))}
          </div>
          {/* Rows */}
          <div style={{ maxHeight:360, overflowY:'auto' }}>
            {sorted.slice(0,300).map(r=>{
              const key=`${r.g}-${r.zone}-${r.status}`;
              const isSel=selectedPlant?.g===r.g&&selectedPlant?.zone===r.zone;
              const sc=statusConfig.find(s=>s.s===r.status);
              return (
                <div key={key}>
                  <div onClick={()=>setSelectedPlant(isSel?null:r)}
                    onMouseEnter={e=>{if(!isSel)e.currentTarget.style.backgroundColor=hexA('#1a5fa8',0.04);}}
                    onMouseLeave={e=>{if(!isSel)e.currentTarget.style.backgroundColor='transparent';}}
                    style={{ display:'grid', gridTemplateColumns:'2fr 72px 22px 54px 52px 52px',
                      padding:'5px 8px', borderBottom:`1px solid ${t.panelBorder}`, cursor:'pointer',
                      fontSize:'0.5rem', alignItems:'center', backgroundColor:isSel?hexA('#1a5fa8',0.08):'transparent' }}>
                    <span style={{ color:t.lbl, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.g}</span>
                    <span style={{ display:'flex', flexDirection:'column', lineHeight:1.3, overflow:'hidden' }}>
                      <span style={{ color:t.muted, fontSize:'0.43rem', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{zoneToCountry[r.zone]||r.zone}</span>
                      <span style={{ color:t.lblMuted, fontSize:'0.38rem', opacity:0.7 }}>{r.zone}</span>
                    </span>
                    <span style={{ display:'flex', justifyContent:'center', alignItems:'center' }}>
                      <span style={{ display:'inline-block', width:7, height:7, borderRadius:'50%', backgroundColor:sc?.color||'#aaa' }}/>
                    </span>
                    <span style={{ display:'flex', alignItems:'center', gap:3 }}>
                      <span style={{ display:'inline-block', width:7, height:7, borderRadius:1, backgroundColor:EPM_FUEL_COLORS[r.fuel]||'#aaa' }}/>
                      <span style={{ color:t.muted, fontSize:'0.43rem' }}>{r.fuel}</span>
                    </span>
                    <span style={{ color:t.muted, fontSize:'0.43rem', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.tech||'—'}</span>
                    <span style={{ display:'flex', justifyContent:'flex-end', alignItems:'center' }}>
                      <span style={{ color:t.lbl, fontWeight:600 }}>{fmt(r.capacity)}</span>
                    </span>
                  </div>
                  {isSel&&(
                    <div style={{ padding:'8px 12px', backgroundColor:hexA('#1a5fa8',0.05), borderBottom:`1px solid ${t.panelBorder}`, fontSize:'0.5rem' }}>
                      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:'6px 10px' }}>
                        {[
                          {l:'Technology',v:r.tech||'—'},{l:'Status',v:sc?.label||'—'},
                          {l:'Start year',v:r.stYr||'—'},{l:'Retire year',v:r.retrYr||'—'},
                          {l:'Capex ($/kW)',v:r.capex>0?fmt(r.capex):'—'},{l:'FOM ($/MW/yr)',v:r.fom>0?fmt(r.fom):'—'},
                          {l:'VOM ($/MWh)',v:r.vom>0?r.vom.toFixed(2):'—'},{l:'Heat rate',v:r.heatRate?r.heatRate.toFixed(2):'—'},
                        ].map(({l,v})=>(
                          <div key={l}>
                            <div style={{ fontSize:'0.39rem', color:t.lblMuted, marginBottom:1 }}>{l}</div>
                            <div style={{ color:t.lbl, fontWeight:600 }}>{v}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {sorted.length > 300 && (
          <div style={{ fontSize:'0.44rem', color:t.lblMuted, marginTop:3 }}>
            Showing 300 of {sorted.length} — use search to filter
          </div>
        )}
      </div>

      {/* Export */}
      <button onClick={handleDownload} style={{
        fontSize: '0.52rem', fontFamily: 'inherit', padding: '5px 10px', borderRadius: 4,
        border: `1px solid ${t.panelBorder}`, backgroundColor: 'transparent', color: t.muted,
        cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, alignSelf: 'flex-start',
      }}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Download pGenDataInput.csv
      </button>
    </div>
  );
}

// ── Demand tab ────────────────────────────────────────────────────────────────

const SEASON_LABEL = { Q1: 'Winter', Q2: 'Spring', Q3: 'Summer', Q4: 'Autumn' };

function DemandTab({ t, epmData, epmLoading, hasEpm, region, scnMeta, varOverrides, setVariant, setEpmYear }) {
  const allYears = availableYears(epmData?.demand || []);
  const allZones = [...new Set((epmData?.demand || []).map(r => r.zone))].sort();
  const zcmap    = epmData?.zcmap || [];
  const zoneToCountry = Object.fromEntries(zcmap.map(r => [r.z, r.c]));
  const allCountries  = [...new Set(allZones.map(z => zoneToCountry[z] || z))].sort();

  const [segMode,     setSegMode]     = useState('zone');
  const [hidden,      setHidden]      = useState(new Set());
  const [profileMode, setProfileMode] = useState('full'); // 'full' | 'season'
  const [season,      setSeason]      = useState('Q1');
  const [daytype,     setDaytype]     = useState('avg');

  if (!hasEpm)                  return <NotAvailable t={t} />;
  if (epmLoading)               return <LoadingBox t={t} />;
  if (!epmData?.demand?.length) return <NotAvailable t={t} />;

  const peakRows   = epmData.demand.filter(r => r.type === 'peak');
  const energyRows = epmData.demand.filter(r => r.type === 'energy');

  const toggleHidden = key => setHidden(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  // Build forecast chart data
  const buildForecastData = () => {
    if (segMode === 'aggregate') {
      const eby = {}, pby = {};
      for (const r of epmData.demand) for (const y of allYears) {
        if (r.type==='energy') eby[y]=(eby[y]||0)+(r.years[y]||0);
        if (r.type==='peak')   pby[y]=(pby[y]||0)+(r.years[y]||0);
      }
      return { labels: allYears, datasets: [
        { type:'bar', label:'Energy (GWh)', yAxisID:'yL',
          data: allYears.map(y => Math.round(eby[y]||0)),
          backgroundColor: hexA('#1a5fa8',0.72), borderWidth:0 },
        { type:'line', label:'Peak (GW)', yAxisID:'yR',
          data: allYears.map(y => +((pby[y]||0)/1000).toFixed(2)),
          borderColor:'#7048A8', borderWidth:2.5, pointRadius:0, tension:0.3, fill:false },
      ]};
    }

    // Use full segments list for stable color assignment (not filtered list)
    const segments = segMode === 'zone' ? allZones : allCountries;
    const ebySegYear = {};
    const pby = {};

    if (segMode === 'zone') {
      for (const r of epmData.demand) for (const y of allYears) {
        if (r.type==='energy') { if(!ebySegYear[r.zone]) ebySegYear[r.zone]={}; ebySegYear[r.zone][y]=(ebySegYear[r.zone][y]||0)+(r.years[y]||0); }
        if (r.type==='peak' && !hidden.has(r.zone)) pby[y]=(pby[y]||0)+(r.years[y]||0);
      }
    } else {
      for (const r of epmData.demand) {
        const c = zoneToCountry[r.zone] || r.zone;
        for (const y of allYears) {
          if (r.type==='energy') { if(!ebySegYear[c]) ebySegYear[c]={}; ebySegYear[c][y]=(ebySegYear[c][y]||0)+(r.years[y]||0); }
          if (r.type==='peak' && !hidden.has(c)) pby[y]=(pby[y]||0)+(r.years[y]||0);
        }
      }
    }

    // Iterate all segments (not filtered), skip hidden — preserves color index
    return { labels: allYears, datasets: [
      ...segments.flatMap((seg, i) => {
        if (hidden.has(seg)) return [];
        return [{ type:'bar', label:seg, yAxisID:'yL',
          data: allYears.map(y => Math.round(ebySegYear[seg]?.[y]||0)),
          backgroundColor: ZONE_PALETTE[i % ZONE_PALETTE.length], borderWidth:0, stack:'energy' }];
      }),
      { type:'line', label:'Peak (GW)', yAxisID:'yR',
        data: allYears.map(y => +((pby[y]||0)/1000).toFixed(2)),
        borderColor:'#7048A8', borderWidth:2.5, pointRadius:0, tension:0.3, fill:false },
    ]};
  };

  // Detect available seasons/daytypes from profile data
  const pf          = epmData?.demandProfileFull || {};
  const hoursData   = epmData?.hours || {};
  const timeSlices  = epmData?.timeSlices || {nT:24,isHourly:true,hours:{}};
  const firstZoneWithPf = allZones.find(z => pf[z]);
  const availSeasons    = firstZoneWithPf ? Object.keys(pf[firstZoneWithPf]).sort() : ['Q1','Q2','Q3','Q4'];
  const availDaytypes   = firstZoneWithPf ? Object.keys(pf[firstZoneWithPf]?.[availSeasons[0]] || {}).sort() : [];
  const totalDays       = Object.values(hoursData).reduce((s, dts) => s + Object.values(dts||{}).reduce((a,b)=>a+b,0), 0) || 365;

  // Build profile chart (full year or single season)
  const buildProfileData = () => {
    const isDark = t.isDark;
    const showAvg = !hidden.has('__avg__');

    if (profileMode === 'full') {
      if (!firstZoneWithPf || !availDaytypes.length) return { chartData:{ labels:[], datasets:[] }, plugin:null };
      // x layout: one slot per hour on a chronological model, width proportional to duration on a load-block one
      const ax = buildTimeAxis(timeSlices, availSeasons, availDaytypes);
      const labels = new Array(ax.slots.length).fill('');

      // Zone lines — use allZones index for stable colors
      const zoneDs = allZones.flatMap((z, i) => {
        if (hidden.has(z)) return [];
        const data = ax.slots.map(sl => pf[z]?.[sl.q]?.[sl.d]?.[sl.i] ?? null);
        if (!data.some(v => v !== null)) return [];
        return [{ label:z, data, borderColor:ZONE_PALETTE[i%ZONE_PALETTE.length],
          borderWidth:1.5, pointRadius:0, tension:0.3, fill:false, spanGaps:true }];
      });

      // Region avg last (on top) — only if not hidden
      const avgData = ax.slots.map(sl => {
        const profs = allZones.map(z=>pf[z]?.[sl.q]?.[sl.d]).filter(Boolean);
        return profs.length ? profs.reduce((sum,p)=>sum+(p[sl.i]||0),0)/profs.length : null;
      });
      const avgDs = showAvg ? { label:'Region avg', data:avgData, borderColor:'#1a5fa8',
        borderWidth:2.5, pointRadius:0, tension:0.3, fill:false, spanGaps:true } : null;

      const separatorPlugin = bandingPlugin({ id:'profileSep', ax, seasons:availSeasons,
        daytypes:availDaytypes, hoursData, totalDays, isDark });
      return { chartData:{ labels, datasets:[...zoneDs, ...(avgDs?[avgDs]:[])] }, plugin:separatorPlugin, banded:true };
    }

    // Single season mode. 'All days' lays the season's day types side by side under the same
    // banding as the full year; the other choices are one curve, so they keep the hour labels.
    const days = daytype==='all' ? availDaytypes : [daytype==='avg' ? availDaytypes[0] : daytype];
    const banded = daytype==='all' && availDaytypes.length > 1;
    const ax = buildSeasonAxis(timeSlices, season, days);
    const wts = dayWeights(hoursData, season, availDaytypes);
    const getP = (zone) => {
      const sp = pf[zone]?.[season];
      if (!sp) return null;
      if (daytype === 'all') return ax.slots.map(sl=>sp[sl.d]?.[sl.i] ?? null);
      if (daytype === 'avg') return availDaytypes.some(d=>sp[d])
        ? ax.slots.map(sl=>availDaytypes.reduce((a,d,k)=>a+(sp[d]?.[sl.i]||0)*wts[k],0)) : null;
      return sp[daytype] ? ax.slots.map(sl=>sp[daytype][sl.i] ?? null) : null;
    };
    // Use allZones index for stable colors
    const zoneLines = allZones.flatMap((z, i) => {
      if (hidden.has(z)) return [];
      const p = getP(z);
      return p ? [{ label:z, data:p, borderColor:ZONE_PALETTE[i%ZONE_PALETTE.length], borderWidth:1.8, pointRadius:0, tension:0.35, fill:false }] : [];
    });
    const allProf = allZones.map(z=>getP(z)).filter(Boolean);
    const avgLine = (showAvg && allProf.length) ? { label:'Region avg', data:ax.slots.map((_,k)=>allProf.reduce((s,p)=>s+(p[k]||0),0)/allProf.length), borderColor:'#1a5fa8', borderWidth:2.5, pointRadius:0, tension:0.35, fill:false } : null;
    return { chartData:{ labels: banded ? new Array(ax.slots.length).fill('') : blockLabels(ax,timeSlices,season,days[0]),
      datasets:[...zoneLines,...(avgLine?[avgLine]:[])] },
      plugin: banded ? bandingPlugin({ id:'profileSepSeason', ax, seasons:[season], daytypes:days, hoursData, totalDays, isDark }) : null,
      banded, xTicks: banded ? null : axisTicks(ax) };
  };

  const segments = segMode === 'zone' ? allZones : segMode === 'country' ? allCountries : [];
  const forecastData  = buildForecastData();
  const profileResult = buildProfileData();

  const handleDownload = () => {
    const header = 'zone,type,' + allYears.join(',');
    const rows = epmData.demand.map(r => `${r.zone},${r.type},${allYears.map(y => r.years[y] ?? '').join(',')}`);
    const src = epmData.demandSource || {};
    const filename = `${src.param || 'pDemandForecast'}_${epmData.branch || ''}.csv`;
    // Peak and energy are two different units sharing one table, so the unit has
    // to go on the row: a header line reading 'GWh and MW' -- which is all
    // config.csv says -- leaves the reader to work out which is which.
    const text = annotateCsv([header, ...rows].join('\n') + '\n', {
      filename,
      lines: [
        `EPM View export -- ${filename}`,
        [region?.name && `region: ${region.name}`, epmData.branch && `branch: ${epmData.branch}`,
          epmData.dataFolder && `data folder: ${epmData.dataFolder}`].filter(Boolean).join(' | '),
        src.param && `parameter: ${src.param}`,
        scnMeta?.paramMeta?.[src.param]?.label && `description: ${scnMeta.paramMeta[src.param].label}`,
        src.derived
          ? 'derived: peak is the highest block MW of the year, energy the block MW weighted by pHours -- not a copy of the source file'
          : 'shape: the source file, one row per zone and demand type, years across the columns',
        `downloaded: ${new Date().toISOString()}`,
        src.file && epmData.dataFolder
          && `source: ${rawFileUrl(epmData.branch, `epm/input/${epmData.dataFolder}/${src.file}`)}`,
      ],
      unitFor: (fields) => ((fields[1] || '').trim().toLowerCase() === 'peak' ? 'MW' : 'GWh'),
    });
    downloadBlob(text, filename, 'text/csv');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <VariantPicker t={t} scnMeta={scnMeta} param="pDemandForecast" value={varOverrides?.pDemandForecast} onChange={setVariant} />
        <VariantPicker t={t} scnMeta={scnMeta} param="pDemandProfile" value={varOverrides?.pDemandProfile} onChange={setVariant} />
      </div>

      {/* Forecast chart */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <SectionTitle t={t}>Demand forecast</SectionTitle>
          <div style={{ display: 'flex', gap: 3 }}>
            {[['aggregate','Aggregate'],['zone','By Zone'],['country','By Country']].map(([v,l]) => (
              <button key={v} onClick={() => { setSegMode(v); setHidden(new Set()); }} style={{
                fontSize:'0.44rem', fontFamily:'inherit', padding:'2px 6px', borderRadius:3, cursor:'pointer',
                border:`1px solid ${segMode===v?'rgba(74,143,204,0.65)':t.panelBorder}`,
                backgroundColor:segMode===v?'rgba(74,143,204,0.12)':'transparent',
                color:segMode===v?t.lbl:t.lblMuted, fontWeight:segMode===v?600:400,
              }}>{l}</button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <CJChart name={ttl('Demand forecast (GWh)',segMode==='zone'?'by zone':segMode==='country'?'by country':'aggregate')} type="bar" height={180} data={forecastData}
              cacheKey={`forecast|${segMode}|${[...hidden].sort().join(',')}`}
              options={{ ...cjDefaults(t),
                scales: {
                  x: { stacked:true, grid:{color:t.panelBorder}, ticks:{color:t.muted,font:{size:9},maxTicksLimit:7} },
                  yL:{ type:'linear', position:'left', stacked:true, title:{display:true,text:'GWh',color:t.muted,font:{size:8}},
                    grid:{color:t.panelBorder}, ticks:{color:t.muted,font:{size:9}} },
                  yR:{ type:'linear', position:'right', title:{display:true,text:'GW',color:t.muted,font:{size:8}},
                    grid:{drawOnChartArea:false}, ticks:{color:t.muted,font:{size:9}} },
                },
              }}
              onClickYear={setEpmYear}
            />
          </div>
          {segments.length > 0 && (
            <div style={{ width:100, flexShrink:0, display:'flex', flexDirection:'column', gap:2, paddingTop:4, maxHeight:180, overflowY:'auto' }}>
              {segments.map((seg,i) => (
                <div key={seg} onClick={() => toggleHidden(seg)}
                  style={{ display:'flex', alignItems:'center', gap:4, cursor:'pointer', opacity:hidden.has(seg)?0.3:1 }}>
                  <div style={{ width:9, height:9, borderRadius:2, flexShrink:0, backgroundColor:ZONE_PALETTE[i%ZONE_PALETTE.length] }}/>
                  <span style={{ fontSize:'0.43rem', color:t.muted, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{seg}</span>
                </div>
              ))}
              <div style={{ display:'flex', gap:3, marginTop:5 }}>
                <button onClick={() => setHidden(new Set())} style={{ fontSize:'0.38rem', fontFamily:'inherit', padding:'1px 5px', borderRadius:3, cursor:'pointer', border:`1px solid rgba(128,160,192,0.25)`, backgroundColor:'transparent', color:t.lblMuted }}>All</button>
                <button onClick={() => setHidden(new Set(segments))} style={{ fontSize:'0.38rem', fontFamily:'inherit', padding:'1px 5px', borderRadius:3, cursor:'pointer', border:`1px solid rgba(128,160,192,0.25)`, backgroundColor:'transparent', color:t.lblMuted }}>None</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Profile chart */}
      <div>
        <SectionTitle t={t}>Load profile</SectionTitle>
        {/* Mode + season + daytype selectors */}
        <div style={{ display:'flex', flexWrap:'wrap', gap:3, marginBottom:6, alignItems:'center' }}>
          {/* Full Year */}
          <button onClick={() => setProfileMode('full')} style={{
            fontSize:'0.44rem', fontFamily:'inherit', padding:'2px 7px', borderRadius:3, cursor:'pointer',
            border:`1px solid ${profileMode==='full'?'rgba(74,143,204,0.65)':t.panelBorder}`,
            backgroundColor:profileMode==='full'?'rgba(74,143,204,0.12)':'transparent',
            color:profileMode==='full'?t.lbl:t.lblMuted, fontWeight:profileMode==='full'?600:400,
          }}>Full Year</button>
          {/* Season buttons */}
          {availSeasons.map(s => (
            <button key={s} onClick={() => { setProfileMode('season'); setSeason(s); }} style={{
              fontSize:'0.44rem', fontFamily:'inherit', padding:'2px 6px', borderRadius:3, cursor:'pointer',
              border:`1px solid ${profileMode==='season'&&season===s?'rgba(74,143,204,0.65)':t.panelBorder}`,
              backgroundColor:profileMode==='season'&&season===s?'rgba(74,143,204,0.12)':'transparent',
              color:profileMode==='season'&&season===s?t.lbl:t.lblMuted, fontWeight:profileMode==='season'&&season===s?600:400,
            }}>{s}</button>
          ))}
          {/* Day type dropdown — only in season mode */}
          {profileMode === 'season' && availDaytypes.length > 0 && (
            <>
              <div style={{ width:1, backgroundColor:t.panelBorder, height:14 }}/>
              <select value={daytype} onChange={e=>setDaytype(e.target.value)} style={{
                fontSize:'0.44rem', fontFamily:'inherit', padding:'2px 5px', borderRadius:3,
                border:`1px solid ${t.panelBorder}`, backgroundColor:t.panel, color:t.muted, cursor:'pointer',
              }}>
                <option value="avg">Avg</option>
                <option value="all">All days</option>
                {availDaytypes.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </>
          )}
        </div>

        {/* Chart + legend */}
        {profileResult.chartData.datasets.length > 0 ? (
          <div style={{ display:'flex', gap:8 }}>
            <div style={{ flex:1 }}>
              <CJChart name={ttl('Load profile (MW)',profileMode==='full'?'Full year':ttl(season,daytype==='avg'?'average day':daytype==='all'?'all day types':daytype))} type="line"
                height={profileResult.banded ? 205 : 160}
                data={profileResult.chartData}
                plugins={profileResult.plugin ? [profileResult.plugin] : []}
                cacheKey={`${profileMode}|${season}|${daytype}|${[...hidden].sort().join(',')}`}
                options={{ ...cjDefaults(t),
                  layout:{ padding:{ top: profileResult.banded?18:4, bottom: profileResult.banded?62:4 } },
                  scales:{
                    x:{ grid:{ color:t.panelBorder, drawTicks:false },
                      ticks:{ display: !profileResult.banded, color:t.muted, font:{size:8}, maxTicksLimit:12, ...(profileResult.xTicks||{}) } },
                    y:{ grid:{color:t.panelBorder}, ticks:{color:t.muted,font:{size:9}}, min:0,
                      title:{display:true,text:'Load factor',color:t.muted,font:{size:8}} },
                  },
                }}
              />
            </div>
            {/* Legend */}
            <div style={{ width:96, flexShrink:0, display:'flex', flexDirection:'column', gap:2, paddingTop:4,
              maxHeight: profileResult.banded?205:160, overflowY:'auto' }}>
              {/* Avg toggle */}
              <div onClick={() => toggleHidden('__avg__')}
                style={{ display:'flex', alignItems:'center', gap:4, cursor:'pointer', opacity:hidden.has('__avg__')?0.25:1 }}>
                <div style={{ width:12, height:2.5, backgroundColor:'#1a5fa8', borderRadius:1 }}/>
                <span style={{ fontSize:'0.43rem', color:t.muted, fontWeight:600 }}>avg</span>
              </div>
              {allZones.map((z,i) => (
                <div key={z} onClick={() => toggleHidden(z)}
                  style={{ display:'flex', alignItems:'center', gap:4, cursor:'pointer', opacity:hidden.has(z)?0.25:1 }}>
                  <div style={{ width:12, height:2.5, backgroundColor:ZONE_PALETTE[i%ZONE_PALETTE.length], borderRadius:1 }}/>
                  <span style={{ fontSize:'0.43rem', color:t.muted, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{z}</span>
                </div>
              ))}
              <div style={{ display:'flex', gap:3, marginTop:5 }}>
                <button onClick={() => setHidden(new Set())} style={{ fontSize:'0.38rem', fontFamily:'inherit', padding:'1px 5px', borderRadius:3, cursor:'pointer', border:`1px solid rgba(128,160,192,0.25)`, backgroundColor:'transparent', color:t.lblMuted }}>All</button>
                <button onClick={() => setHidden(new Set(allZones))} style={{ fontSize:'0.38rem', fontFamily:'inherit', padding:'1px 5px', borderRadius:3, cursor:'pointer', border:`1px solid rgba(128,160,192,0.25)`, backgroundColor:'transparent', color:t.lblMuted }}>None</button>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ fontSize:'0.55rem', color:t.lblMuted, padding:'20px 0' }}>
            No profile data available.
          </div>
        )}
      </div>

      <button onClick={handleDownload} style={{
        fontSize:'0.52rem', fontFamily:'inherit', padding:'5px 10px', borderRadius:4,
        border:`1px solid ${t.panelBorder}`, backgroundColor:'transparent', color:t.muted,
        cursor:'pointer', display:'flex', alignItems:'center', gap:4, alignSelf:'flex-start',
      }}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Download pDemandForecast.csv
      </button>
    </div>
  );
}

// ── Tech display helpers (VRE) ────────────────────────────────────────────────

const VRE_DISPLAY = {
  pv:'Solar PV', solar:'Solar PV',
  onshorewind:'Onshore Wind', wind:'Wind',
  offshorewind:'Offshore Wind',
  ror:'Run-of-River', rof:'Run-of-River',
};
const VRE_COLOR = {
  pv:'#FFD700', solar:'#FFD700',
  onshorewind:'#44DAEC', wind:'#44DAEC',
  offshorewind:'#7CC8FA',
  ror:'#1E9AF5', rof:'#1E9AF5',
};

// ── Resources tab ─────────────────────────────────────────────────────────────

function ResourcesTab({ t, epmData, epmLoading, hasEpm, scnMeta, varOverrides, setVariant, availZone, setAvailZone, section, setSection }) {
  const [vreProfileMode, setVreProfileMode] = useState('full');
  const [vreSeason,   setVreSeason]   = useState('Q1');
  const [vreDay,      setVreDay]      = useState('avg');
  const [vreHidden,   setVreHidden]   = useState(new Set());
  const [fpCountries, setFpCountries] = useState(null);

  // Auto-detect available VRE techs
  const vp         = epmData?.vreProfile || {};
  const allVreTechs = [...new Set(Object.values(vp).flatMap(Object.keys))].sort();
  const [vreTech, setVreTech] = useState(() => allVreTechs[0] || 'ror');

  if (!hasEpm)    return <NotAvailable t={t} />;
  if (epmLoading) return <LoadingBox t={t} />;
  if (!epmData)   return <NotAvailable t={t} />;

  const zcmap   = epmData.zcmap || [];
  const allZones = zcmap.map(r => r.z);
  const allCountries = [...new Set(zcmap.map(r => r.c))].sort();

  const toggleVreHidden = z => setVreHidden(s => { const n=new Set(s); n.has(z)?n.delete(z):n.add(z); return n; });

  // Detect season/daytype structure for selected VRE tech
  const firstZoneWithVre  = allZones.find(z => vp[z]?.[vreTech]);
  const vreAvailSeasons   = firstZoneWithVre ? Object.keys(vp[firstZoneWithVre][vreTech]).sort() : [];
  const vreAvailDaytypes  = firstZoneWithVre && vreAvailSeasons[0]
    ? Object.keys(vp[firstZoneWithVre][vreTech][vreAvailSeasons[0]] || {}).sort() : [];
  const hoursData  = epmData?.hours || {};
  const timeSlices = epmData?.timeSlices || {nT:24,isHourly:true,hours:{}};
  const totalDaysV = Object.values(hoursData).reduce((s,dts)=>s+Object.values(dts||{}).reduce((a,b)=>a+b,0),0) || 365;

  const buildVREData = () => {
    const isDark   = t.isDark;
    const showAvgV = !vreHidden.has('__avg__');

    if (vreProfileMode === 'full') {
      if (!firstZoneWithVre || !vreAvailDaytypes.length) return { chartData:{ labels:[], datasets:[] }, plugin:null };
      // x layout: one slot per hour on a chronological model, width proportional to duration on a load-block one
      const ax = buildTimeAxis(timeSlices, vreAvailSeasons, vreAvailDaytypes);
      const labels = new Array(ax.slots.length).fill('');

      // Zone lines — use allZones index for stable colors
      const zoneDs = allZones.flatMap((z, i) => {
        if (vreHidden.has(z)) return [];
        const data = ax.slots.map(sl => vp[z]?.[vreTech]?.[sl.q]?.[sl.d]?.[sl.i] ?? null);
        if (!data.some(v => v !== null)) return [];
        return [{ label:z, data, borderColor:ZONE_PALETTE[i%ZONE_PALETTE.length],
          borderWidth:1.5, pointRadius:0, tension:0.3, fill:false, spanGaps:true }];
      });

      // Avg last
      const avgData = ax.slots.map(sl => {
        const profs = allZones.map(z=>vp[z]?.[vreTech]?.[sl.q]?.[sl.d]).filter(Boolean);
        return profs.length?profs.reduce((sum,p)=>sum+(p[sl.i]||0),0)/profs.length:null;
      });
      const techColor = VRE_COLOR[vreTech] || '#1E9AF5';
      const avgDs = showAvgV ? { label:`${VRE_DISPLAY[vreTech]||vreTech} avg`, data:avgData,
        borderColor:techColor, borderWidth:2.5, pointRadius:0, tension:0.3, fill:false, spanGaps:true } : null;

      const separatorPlugin = bandingPlugin({ id:'vreSep', ax, seasons:vreAvailSeasons,
        daytypes:vreAvailDaytypes, hoursData, totalDays:totalDaysV, isDark, dayFont:7.5 });
      return { chartData:{ labels, datasets:[...zoneDs, ...(avgDs?[avgDs]:[])] }, plugin:separatorPlugin, banded:true };
    }

    // Single season mode. See the load profile above for what 'All days' draws.
    const days = vreDay==='all' ? vreAvailDaytypes : [vreDay==='avg' ? vreAvailDaytypes[0] : vreDay];
    const banded = vreDay==='all' && vreAvailDaytypes.length > 1;
    const ax = buildSeasonAxis(timeSlices, vreSeason, days);
    const wts = dayWeights(hoursData, vreSeason, vreAvailDaytypes);
    const getP = (zone) => {
      const sp = vp[zone]?.[vreTech]?.[vreSeason];
      if (!sp) return null;
      if (vreDay === 'all') return ax.slots.map(sl=>sp[sl.d]?.[sl.i] ?? null);
      if (vreDay === 'avg') return vreAvailDaytypes.some(d=>sp[d])
        ? ax.slots.map(sl=>vreAvailDaytypes.reduce((a,d,k)=>a+(sp[d]?.[sl.i]||0)*wts[k],0)) : null;
      return sp[vreDay] ? ax.slots.map(sl=>sp[vreDay][sl.i] ?? null) : null;
    };
    // Use allZones index for stable colors
    const zoneLines = allZones.flatMap((z, i) => {
      if (vreHidden.has(z)) return [];
      const p = getP(z);
      return p ? [{ label:z, data:p, borderColor:ZONE_PALETTE[i%ZONE_PALETTE.length], borderWidth:1.8, pointRadius:0, tension:0.35, fill:false }] : [];
    });
    const allProf = allZones.map(z=>getP(z)).filter(Boolean);
    const techColor = VRE_COLOR[vreTech]||'#1E9AF5';
    const avgLine = (showAvgV && allProf.length) ? { label:`${VRE_DISPLAY[vreTech]||vreTech} avg`, data:ax.slots.map((_,k)=>allProf.reduce((s,p)=>s+(p[k]||0),0)/allProf.length), borderColor:techColor, borderWidth:2.5, pointRadius:0, tension:0.35, fill:false } : null;
    const seasonLabel = `${vreSeason}${vreDay !== 'avg' && vreDay !== 'all' ? ` — ${vreDay}` : ''}`;
    return { chartData:{ labels: banded ? new Array(ax.slots.length).fill('') : blockLabels(ax,timeSlices,vreSeason,days[0]),
      datasets:[...zoneLines,...(avgLine?[avgLine]:[])] },
      plugin: banded ? bandingPlugin({ id:'vreSepSeason', ax, seasons:[vreSeason], daytypes:days, hoursData, totalDays:totalDaysV, isDark, dayFont:7.5 }) : null,
      banded, seasonLabel, xTicks: banded ? null : axisTicks(ax) };
  };

  const buildAvailData = () => {
    const av = epmData.availability || {};
    const zones = availZone==='all' ? allZones : [availZone];
    const techKeys = new Set();
    zones.forEach(z => Object.keys(av[z]||{}).forEach(k => techKeys.add(k)));
    const keys = [...techKeys].slice(0,12);
    const firstZ = av[zones[0]] || {};
    const qCols = keys.length ? Object.keys(firstZ[keys[0]]||{}).filter(k=>/^Q\d+$/.test(k)).sort() : ['Q1','Q2','Q3','Q4'];
    return {
      labels: qCols,
      datasets: keys.map((k,i) => {
        const e = firstZ[k]||{};
        return {
          label: e.fuel&&e.fuel!==''?e.fuel:e.tech||k,
          data: qCols.map(q => { const vals=zones.map(z=>av[z]?.[k]?.[q]).filter(v=>v!=null); return vals.length?+(vals.reduce((s,v)=>s+v,0)/vals.length).toFixed(3):0; }),
          backgroundColor: hexA(EPM_FUEL_COLORS[normalizeFuel(e.fuel||e.tech||'')]||ZONE_PALETTE[i%ZONE_PALETTE.length],0.75),
          borderWidth:0, barThickness:10,
        };
      }),
    };
  };

  const buildFPData = () => {
    const fp = epmData.fuelPrice || {};
    const clist = (fpCountries||allCountries).filter(c=>fp[c]);
    if (!clist.length) return {labels:[],datasets:[]};
    const fuels = [...new Set(clist.flatMap(c=>Object.keys(fp[c]||{})))];
    const years = Object.keys(Object.values(fp[clist[0]]||{})[0]||{}).filter(k=>/^\d{4}$/.test(k)).sort().filter(y=>y<='2050');
    return {
      labels: years,
      datasets: fuels.map((fuel,i) => ({
        label: fuel,
        data: years.map(y => { const vals=clist.map(c=>fp[c]?.[fuel]?.[y]).filter(v=>v!=null&&v>0); return vals.length?+(vals.reduce((s,v)=>s+v,0)/vals.length).toFixed(2):null; }),
        borderColor: EPM_FUEL_COLORS[normalizeFuel(fuel)]||ZONE_PALETTE[i%ZONE_PALETTE.length],
        borderWidth:2, pointRadius:0, tension:0.2, fill:false, spanGaps:true,
      })),
    };
  };

  const Pill = ({ v, active, onClick, children }) => (
    <button onClick={onClick} style={{ fontSize:'0.44rem',fontFamily:'inherit',padding:'2px 7px',borderRadius:3,cursor:'pointer',
      border:`1px solid ${active?'rgba(74,143,204,0.65)':t.panelBorder}`,
      backgroundColor:active?'rgba(74,143,204,0.12)':'transparent',
      color:active?t.lbl:t.lblMuted,fontWeight:active?600:400 }}>{children}</button>
  );

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      <div style={{ display:'flex', gap:4 }}>
        <Pill active={section==='vre'}   onClick={()=>setSection('vre')}>VRE Profiles</Pill>
        <Pill active={section==='avail'} onClick={()=>setSection('avail')}>Availability</Pill>
        <Pill active={section==='fuel'}  onClick={()=>setSection('fuel')}>Fuel Prices</Pill>
      </div>

      {section==='vre'   && <VariantPicker t={t} scnMeta={scnMeta} param="pVREProfile"          value={varOverrides?.pVREProfile}          onChange={setVariant} />}
      {section==='avail' && <VariantPicker t={t} scnMeta={scnMeta} param="pAvailabilityDefault" value={varOverrides?.pAvailabilityDefault} onChange={setVariant} />}
      {section==='fuel'  && <VariantPicker t={t} scnMeta={scnMeta} param="pFuelPrice"           value={varOverrides?.pFuelPrice}           onChange={setVariant} />}

      {section === 'vre' && (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {allVreTechs.length === 0 ? (
            <div style={{ color:t.lblMuted, fontSize:'0.55rem' }}>No VRE profile data for this region.</div>
          ) : (
            <>
              {/* Tech pills */}
              <div style={{ display:'flex', flexWrap:'wrap', gap:3, alignItems:'center' }}>
                {allVreTechs.map(tc => (
                  <Pill key={tc} active={vreTech===tc} onClick={()=>setVreTech(tc)}>
                    {VRE_DISPLAY[tc]||tc}
                  </Pill>
                ))}
                <div style={{ width:1, backgroundColor:t.panelBorder, height:14, margin:'0 2px' }}/>
                {/* Mode */}
                <Pill active={vreProfileMode==='full'} onClick={()=>setVreProfileMode('full')}>Full Year</Pill>
                {vreAvailSeasons.map(s => (
                  <Pill key={s} active={vreProfileMode==='season'&&vreSeason===s}
                    onClick={()=>{ setVreProfileMode('season'); setVreSeason(s); }}>{s}</Pill>
                ))}
                {/* Day type dropdown in season mode */}
                {vreProfileMode === 'season' && vreAvailDaytypes.length > 0 && (
                  <>
                    <div style={{ width:1, backgroundColor:t.panelBorder, height:14 }}/>
                    <select value={vreDay} onChange={e=>setVreDay(e.target.value)} style={{
                      fontSize:'0.44rem', fontFamily:'inherit', padding:'2px 5px', borderRadius:3,
                      border:`1px solid ${t.panelBorder}`, backgroundColor:t.panel, color:t.muted, cursor:'pointer',
                    }}>
                      <option value="avg">Avg</option>
                      <option value="all">All days</option>
                      {vreAvailDaytypes.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </>
                )}
              </div>
              {/* Chart */}
              {(() => {
                const vd = buildVREData();
                return vd.chartData.datasets.length > 0 ? (
                  <div style={{ display:'flex', gap:8 }}>
                    <div style={{ flex:1 }}>
                      <CJChart name={ttl('VRE profile',vreTech,vreProfileMode==='full'?'Full year':ttl(vreSeason,vreDay==='avg'?'average day':vreDay==='all'?'all day types':vreDay))} type="line"
                        height={vd.banded ? 205 : 160}
                        data={vd.chartData}
                        plugins={vd.plugin ? [vd.plugin] : []}
                        cacheKey={`${vreProfileMode}|${vreTech}|${vreSeason}|${vreDay}|${[...vreHidden].sort().join(',')}`}
                        options={{ ...cjDefaults(t),
                          layout:{ padding:{ top:vd.banded?18:4, bottom:vd.banded?80:4 } },
                          scales:{
                            x:{ grid:{color:t.panelBorder,drawTicks:false},
                              ticks:{ display:!vd.banded, color:t.muted,font:{size:8},maxTicksLimit:12, ...(vd.xTicks||{}) },
                              title:{ display:vreProfileMode==='season'&&!vd.banded&&!!vd.seasonLabel, text:vd.seasonLabel||'', color:t.muted, font:{size:9} } },
                            y:{ min:0, max:1, grid:{color:t.panelBorder}, ticks:{color:t.muted,font:{size:9}},
                              title:{display:true,text:'Availability (0-1)',color:t.muted,font:{size:8}} },
                          },
                        }}
                      />
                    </div>
                    {/* Legend */}
                    <div style={{ width:96, flexShrink:0, display:'flex', flexDirection:'column', gap:2, paddingTop:4,
                      maxHeight:vd.banded?205:160, overflowY:'auto' }}>
                      {/* Avg toggle */}
                      <div onClick={() => setVreHidden(s => { const n=new Set(s); n.has('__avg__')?n.delete('__avg__'):n.add('__avg__'); return n; })}
                        style={{ display:'flex', alignItems:'center', gap:4, cursor:'pointer', opacity:vreHidden.has('__avg__')?0.25:1 }}>
                        <div style={{ width:12, height:2.5, backgroundColor:VRE_COLOR[vreTech]||'#1E9AF5', borderRadius:1 }}/>
                        <span style={{ fontSize:'0.43rem', color:t.muted, fontWeight:600 }}>avg</span>
                      </div>
                      {allZones.map((z, allIdx) => {
                        if (!vp[z]?.[vreTech]) return null;
                        return (
                          <div key={z} onClick={()=>toggleVreHidden(z)}
                            style={{ display:'flex', alignItems:'center', gap:4, cursor:'pointer', opacity:vreHidden.has(z)?0.25:1 }}>
                            <div style={{ width:12, height:2.5, backgroundColor:ZONE_PALETTE[allIdx%ZONE_PALETTE.length], borderRadius:1 }}/>
                            <span style={{ fontSize:'0.43rem', color:t.muted, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{z}</span>
                          </div>
                        );
                      })}
                      <div style={{ display:'flex', gap:3, marginTop:5 }}>
                        <button onClick={() => setVreHidden(new Set())} style={{ fontSize:'0.38rem', fontFamily:'inherit', padding:'1px 5px', borderRadius:3, cursor:'pointer', border:`1px solid rgba(128,160,192,0.25)`, backgroundColor:'transparent', color:t.lblMuted }}>All</button>
                        <button onClick={() => setVreHidden(new Set(allZones))} style={{ fontSize:'0.38rem', fontFamily:'inherit', padding:'1px 5px', borderRadius:3, cursor:'pointer', border:`1px solid rgba(128,160,192,0.25)`, backgroundColor:'transparent', color:t.lblMuted }}>None</button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ color:t.lblMuted, fontSize:'0.55rem' }}>
                    No {VRE_DISPLAY[vreTech]||vreTech} data available.
                  </div>
                );
              })()}
            </>
          )}
        </div>
      )}

      {section === 'avail' && (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          <div style={{ display:'flex', gap:4, alignItems:'center' }}>
            <span style={{ fontSize:'0.44rem',color:t.lblMuted }}>Zone:</span>
            <select value={availZone} onChange={e=>setAvailZone(e.target.value)} style={{ fontSize:'0.44rem',fontFamily:'inherit',padding:'3px 6px',borderRadius:3,border:`1px solid ${t.panelBorder}`,backgroundColor:t.panel,color:t.muted }}>
              <option value="all">All (avg)</option>
              {allZones.map(z=><option key={z} value={z}>{z}</option>)}
            </select>
          </div>
          {(() => { const ad=buildAvailData(); return ad.datasets.length>0 ? (
            <>
              <CJChart name={ttl('Seasonal availability (%)',availZone==='all'?'All zones':availZone)} type="bar" height={160} data={ad}
                options={{ ...cjDefaults(t), scales:{
                  x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9}}},
                  y:{min:0,max:1,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9}},title:{display:true,text:'Availability factor',color:t.muted,font:{size:8}}},
                }}}
              />
              <div style={{ display:'flex',flexWrap:'wrap',gap:'3px 8px',marginTop:2 }}>
                {ad.datasets.map((ds,i)=>(
                  <div key={ds.label} style={{ display:'flex',alignItems:'center',gap:3,fontSize:'0.43rem',color:t.muted }}>
                    <div style={{ width:8,height:8,borderRadius:2,backgroundColor:ad.datasets[i].backgroundColor }}/>{ds.label}
                  </div>
                ))}
              </div>
            </>
          ) : <div style={{ color:t.lblMuted,fontSize:'0.55rem' }}>No availability data.</div>; })()}
        </div>
      )}

      {section === 'fuel' && (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          <div>
            <div style={{ fontSize:'0.44rem',color:t.lblMuted,marginBottom:4 }}>Countries:</div>
            <div style={{ display:'flex',flexWrap:'wrap',gap:3 }}>
              <Pill active={fpCountries===null} onClick={()=>setFpCountries(null)}>All</Pill>
              {allCountries.filter(c=>(epmData.fuelPrice||{})[c]).map(c=>(
                <Pill key={c} active={fpCountries?.includes(c)??false} onClick={()=>setFpCountries(prev=>{
                  if(prev===null)return[c];const n=prev.includes(c)?prev.filter(x=>x!==c):[...prev,c];return n.length===0?null:n;
                })}>{c}</Pill>
              ))}
            </div>
          </div>
          {(() => { const fd=buildFPData(); return fd.datasets.length>0 ? (
            <>
              <CJChart name={ttl('Fuel prices',fpCountries?fpCountries.join(', '):'All countries')} type="line" height={170} data={fd}
                options={{ ...cjDefaults(t), scales:{
                  x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},maxTicksLimit:8}},
                  y:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9}},title:{display:true,text:'USD/MBtu',color:t.muted,font:{size:8}}},
                }}}
              />
              <div style={{ display:'flex',flexWrap:'wrap',gap:'3px 10px',marginTop:2 }}>
                {fd.datasets.map((ds,i)=>(
                  <div key={ds.label} style={{ display:'flex',alignItems:'center',gap:3,fontSize:'0.43rem',color:t.muted }}>
                    <div style={{ width:12,height:2.5,borderRadius:1,backgroundColor:typeof ds.borderColor==='string'?ds.borderColor:ZONE_PALETTE[i%ZONE_PALETTE.length] }}/>{ds.label}
                  </div>
                ))}
              </div>
            </>
          ) : <div style={{ color:t.lblMuted,fontSize:'0.55rem' }}>No fuel price data.</div>; })()}
        </div>
      )}
    </div>
  );
}

// ── Trade / Transmission tab ──────────────────────────────────────────────────

function TradeTab({ t, epmData, epmLoading, hasEpm, region, scnMeta, varOverrides, setVariant, setEpmYear }) {
  const ntcYears = availableYears(epmData?.ntc || []);
  const [yr, setYr]       = useState(null);
  const [chartType, setChartType] = useState('bar'); // bar | line
  const [ntcHidden, setNtcHidden] = useState(new Set());

  if (!hasEpm)              return <NotAvailable t={t} />;
  if (epmLoading)           return <LoadingBox t={t} />;
  if (!epmData?.ntc?.length) return <NotAvailable t={t} />;

  const refYr = yr || ntcYears.find(y => y === '2024') || ntcYears[0];

  // Deduplicate: keep only one entry per corridor pair
  const seenC = new Set();
  const uniqueNtc = epmData.ntc.filter(r => {
    const key = [r.z,r.z2].sort().join('||');
    if (seenC.has(key)) return false; seenC.add(key); return true;
  });

  const corridors = uniqueNtc
    .map(r => ({ ...r, label: `${r.z} ↔ ${r.z2}`, mw: r.years[refYr] || 0 }))
    .filter(r => r.mw > 0)
    .sort((a, b) => b.mw - a.mw);

  // NTC evolution chart — top N corridors by max capacity (deduplicated)
  const topN = 10;
  const topCorridors = [...uniqueNtc]
    .sort((a, b) => {
      const maxA = Math.max(...Object.values(a.years));
      const maxB = Math.max(...Object.values(b.years));
      return maxB - maxA;
    })
    .slice(0, topN);

  const handleDownload = () => {
    const header = 'z,z2,' + ntcYears.join(',');
    const rows = epmData.ntc.map(r => `${r.z},${r.z2},${ntcYears.map(y => r.years[y] ?? '').join(',')}`);
    const filename = `pTransferLimit_${epmData.branch || ''}.csv`;
    // One parameter, one unit for every cell, so it belongs in the header. What
    // does need saying is that these are not the file's own numbers: processNTC
    // averages a corridor over the quarters, which is what the chart plots.
    const text = annotateCsv([header, ...rows].join('\n') + '\n', {
      filename,
      lines: [
        ...inputLines({
          filename, param: 'pTransferLimit', meta: scnMeta?.paramMeta?.pTransferLimit,
          regionName: region?.name, branch: epmData.branch, dataFolder: epmData.dataFolder,
          url: epmData.ntcFile && epmData.dataFolder
            ? rawFileUrl(epmData.branch, `epm/input/${epmData.dataFolder}/${epmData.ntcFile}`) : '',
        }),
        'derived: one row per corridor, capacity averaged over the quarters of each year',
      ],
    });
    downloadBlob(text, filename, 'text/csv');
  };

  const zcmap  = epmData?.zcmap || [];
  const countries = [...new Set(zcmap.map(r => r.c))].sort();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <VariantPicker t={t} scnMeta={scnMeta} param="pTransferLimit" value={varOverrides?.pTransferLimit} onChange={setVariant} />
      <VariantPicker t={t} scnMeta={scnMeta} param="pNewTransmission" value={varOverrides?.pNewTransmission} onChange={setVariant} />
      <VariantPicker t={t} scnMeta={scnMeta} param="pExtTransferLimit" value={varOverrides?.pExtTransferLimit} onChange={setVariant} />

      {/* NTC Evolution chart */}
      <div>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
          <SectionTitle t={t}>NTC evolution — top {topN} corridors (MW)</SectionTitle>
          <div style={{ display:'flex', gap:3 }}>
            {['bar','line'].map(type=>(
              <button key={type} onClick={()=>setChartType(type)} style={{
                fontSize:'0.44rem', fontFamily:'inherit', padding:'2px 5px', borderRadius:3,
                cursor:'pointer', border:`1px solid ${chartType===type?t.lbl:t.panelBorder}`,
                backgroundColor:chartType===type?hexA('#1a5fa8',0.1):'transparent',
                color:chartType===type?t.lbl:t.lblMuted,
              }}>{type}</button>
            ))}
          </div>
        </div>
        <div style={{ display:'flex', gap:6, alignItems:'flex-start' }}>
          <div style={{ flex:1, minWidth:0 }}>
            <CJChart name={ttl('NTC evolution (MW)',`top ${topN} corridors`)} type={chartType} height={200}
              cacheKey={`ntc-ev|${chartType}|${[...ntcHidden].sort().join(',')}`}
              data={{ labels:ntcYears, datasets:topCorridors
                .filter(r=>!ntcHidden.has(`${r.z} ↔ ${r.z2}`))
                .map(r=>{
                  const i=topCorridors.indexOf(r);
                  return{ label:`${r.z} ↔ ${r.z2}`, data:ntcYears.map(y=>r.years[y]||0),
                    backgroundColor:hexA(ZONE_PALETTE[i%ZONE_PALETTE.length],0.6),
                    borderColor:ZONE_PALETTE[i%ZONE_PALETTE.length],
                    borderWidth:2, pointRadius:0, tension:0.3, fill:false,
                    stack:chartType==='bar'?'a':undefined };
                })
              }}
              options={{ ...cjDefaults(t),
                scales:{
                  x:{stacked:chartType==='bar',grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},maxTicksLimit:7}},
                  y:{stacked:chartType==='bar',grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},
                },
                plugins:{...cjDefaults(t).plugins,legend:{display:false},
                  tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw.toLocaleString()} MW`}}},
              }}
              onClickYear={setEpmYear}
            />
          </div>
          <div style={{ width:90, flexShrink:0, display:'flex', flexDirection:'column', gap:2, paddingTop:4, maxHeight:200, overflowY:'auto' }}>
            {corridors.map((r,i)=>{
              const label=r.label;
              return (
                <div key={label} onClick={()=>setNtcHidden(prev=>{const n=new Set(prev);n.has(label)?n.delete(label):n.add(label);return n;})}
                  style={{ display:'flex', alignItems:'center', gap:3, cursor:'pointer', opacity:ntcHidden.has(label)?0.25:1 }}>
                  <div style={{ width:12, height:2, borderRadius:1, backgroundColor:ZONE_PALETTE[i%ZONE_PALETTE.length], flexShrink:0 }}/>
                  <span style={{ fontSize:'0.4rem', color:t.muted, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{label}</span>
                </div>
              );
            })}
            <div style={{ fontSize:'0.38rem', color:t.lblMuted, marginTop:4, display:'flex', gap:6 }}>
              <span onClick={()=>setNtcHidden(new Set(corridors.map(r=>r.label)))} style={{cursor:'pointer',textDecoration:'underline'}}>None</span>
              <span onClick={()=>setNtcHidden(new Set())} style={{cursor:'pointer',textDecoration:'underline'}}>All</span>
            </div>
          </div>
        </div>
      </div>

      {/* NTC by corridor — selected year */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <SectionTitle t={t}>Capacity by corridor (MW)</SectionTitle>
          <select value={refYr} onChange={e => setYr(e.target.value)} style={{
            fontSize: '0.52rem', fontFamily: 'inherit', padding: '2px 6px', borderRadius: 4,
            border: `1px solid ${t.panelBorder}`, backgroundColor: t.panel, color: t.lbl, cursor: 'pointer',
          }}>
            {ntcYears.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        {(()=>{const visCor=corridors.filter(r=>!ntcHidden.has(r.label));return(
          <CJChart name={ttl('NTC by corridor (MW)',refYr)} type="bar" height={Math.min(visCor.length*22+24,260)}
            cacheKey={`ntc-yr|${refYr}|${[...ntcHidden].sort().join(',')}`}
            data={{ labels:visCor.map(r=>r.label),
              datasets:[{data:visCor.map(r=>r.mw),
                backgroundColor:visCor.map(r=>ZONE_PALETTE[corridors.indexOf(r)%ZONE_PALETTE.length]),
                borderWidth:0, barThickness:12}] }}
            options={{ ...cjDefaults(t), indexAxis:'y',
              scales:{
                x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},
                y:{grid:{display:false},ticks:{color:t.muted,font:{size:9}}},
              },
              plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,
                callbacks:{label:ctx=>`${ctx.raw.toLocaleString()} MW`}}},
            }}
          />
        );})()}
      </div>

      {/* Zones + countries */}
      {zcmap.length > 0 && (
        <div>
          <SectionTitle t={t}>Zones ({zcmap.length})</SectionTitle>
          {countries.map(c => {
            const czones = zcmap.filter(r => r.c === c).map(r => r.z);
            return (
              <div key={c} style={{ display: 'flex', gap: 6, alignItems: 'baseline',
                fontSize: '0.52rem', padding: '3px 0', borderBottom: `1px solid ${t.panelBorder}` }}>
                <span style={{ color: t.lbl, minWidth: 80 }}>{c}</span>
                <span style={{ color: t.muted }}>{czones.join(', ')}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Download */}
      <button onClick={handleDownload} style={{
        fontSize: '0.52rem', fontFamily: 'inherit', padding: '5px 10px', borderRadius: 4,
        border: `1px solid ${t.panelBorder}`, backgroundColor: 'transparent', color: t.muted,
        cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, alignSelf: 'flex-start',
      }}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Download pTransferLimit.csv
      </button>
    </div>
  );
}

// --- Planned and candidate lines on the inputs map ---
//
// pNewTransmission says what the model may add on top of pTransferLimit: planned
// (committed) lines it must build, candidates it may. Existing lines are solid
// gold; planned ones share the gold, dashed; candidates are dotted blue.
// External corridors are never built by the model, so a rise pExtTransferLimit
// already holds for a later year is drawn as planned, and today's limit as existing.

const NEW_TX_STYLE = {
  planned:   { color: '#f0b030', text: '#b07800', dash: ['literal', [2.5, 1.5]], cap: 'butt' },
  candidate: { color: '#4a8fcc', text: '#2f6aa3', dash: ['literal', [0.2, 1.8]], cap: 'round' },
};

const LINE_KIND_LAYERS = {
  existing:  ['ntc-lines-layer', 'ntc-labels'],
  planned:   ['newtx-planned', 'newtx-planned-labels'],
  candidate: ['newtx-candidate', 'newtx-candidate-labels'],
};
// External corridors also answer to the external zones toggle.
const EXT_LINE_LAYERS = ['ext-ntc-lines-layer', 'ext-ntc-labels'];

/** Line visibility from the toggles. Called after setExtZonesVisible, which shows
 *  every external layer, so the existing toggle still holds on external lines. */
function applyLineVisibility(map, kinds, showExt) {
  if (!map) return;
  const set = (id, on) => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); };
  for (const [kind, ids] of Object.entries(LINE_KIND_LAYERS)) for (const id of ids) set(id, kinds[kind]);
  for (const id of EXT_LINE_LAYERS) set(id, showExt && kinds.existing);
}

/** Whether an external corridor's limit rises at some point of the table. */
const extRises = (r) => {
  const v = Object.keys(r.years || {}).sort().map(y => r.years[y] || 0);
  return v.some((x, i) => i > 0 && x > Math.max(...v.slice(0, i)));
};

const fmtMw = (v) => Math.round(v).toLocaleString('en-US');
const pairKey = (a, b) => [a, b].sort().join('||');
const hasCapacity = (r) => Object.values(r.years || {}).some(v => v > 0);

/** GeoJSON for the lines pNewTransmission declares, none when pSettings turns
 *  expansion off. A line on a corridor that already exists, or that is both planned
 *  and candidate, is set off to one side so the solid line does not hide it. */
function newTxFeatures(epmData, centroids) {
  const rows = epmData.txExpansionOff ? [] : epmData.newTx || [];
  const existing = new Set((epmData.ntc || []).filter(hasCapacity).map(r => pairKey(r.z, r.z2)));
  const kindsOn = {};
  for (const r of rows) (kindsOn[pairKey(r.z, r.z2)] ||= new Set()).add(r.kind);
  return rows
    .filter(r => centroids[r.z] && centroids[r.z2])
    .map(r => {
      const key = pairKey(r.z, r.z2);
      // Every pair is drawn in one direction, so an offset always lands on the same side.
      const [a, b] = [r.z, r.z2].sort();
      const shared = existing.has(key) || kindsOn[key].size > 1;
      const offset = !shared ? 0 : r.kind === 'planned' ? 3.5 : -3.5;
      const label = r.kind === 'planned'
        ? `+${fmtMw(r.capacity)} MW${r.entry ? ` · ${r.entry}` : ''}`
        : `up to ${fmtMw(r.capacity)} MW${r.entry ? ` · ${r.entry}+` : ''}`;
      return {
        type: 'Feature',
        properties: { kind: r.kind, z: r.z, z2: r.z2, mw: r.capacity, lines: r.lines,
          perLine: r.perLine, entry: r.entry, cost: r.cost, life: r.life, offset, label },
        geometry: { type: 'LineString', coordinates: [centroids[a], centroids[b]] },
      };
    });
}

function newTxPopup(p) {
  if (p.ext === true || p.ext === 'true') return extPlannedPopup(p);
  const head = p.kind === 'planned'
    ? 'Planned: built from its entry year'
    : 'Candidate: built only if the model chooses it';
  const rows = [
    ['Lines', `${p.lines} × ${fmtMw(p.perLine)} MW = ${fmtMw(p.mw)} MW`],
    p.entry ? ['Earliest entry', p.entry] : null,
    p.cost ? ['Cost per line', `${fmtMw(p.cost)} M$`] : null,
    p.life ? ['Life', `${p.life} years`] : null,
  ].filter(Boolean);
  return `<b>${p.z} ↔ ${p.z2}</b><br><span style="opacity:.75">${head}</span><br>`
    + rows.map(([k, v]) => `<span style="opacity:.65">${k}:</span> ${v}`).join('<br>');
}

function extPlannedPopup(p) {
  let steps;
  try { steps = JSON.parse(p.steps || '[]'); } catch { steps = []; }
  const rows = [[`Limit in ${p.yr}`, `${fmtMw(p.now)} MW`], ...steps.map(s => [s.y, `${fmtMw(s.mw)} MW`])];
  return `<b>${p.z} ↔ ${p.z2}</b> <span style="opacity:.55">· external</span><br>`
    + '<span style="opacity:.75">Planned: rise already set in pExtTransferLimit</span><br>'
    + rows.map(([k, v]) => `<span style="opacity:.65">${k}:</span> ${v}`).join('<br>');
}

/** A small line sample for a toggle, drawn as the map draws it. */
function LineSwatch({ kind }) {
  const color = kind === 'candidate' ? NEW_TX_STYLE.candidate.color : NEW_TX_STYLE.planned.color;
  const dash = kind === 'planned' ? '5 3' : kind === 'candidate' ? '0.5 3.5' : undefined;
  return (
    <svg width="18" height="6" style={{ flexShrink: 0 }}>
      <line x1="2" y1="3" x2="16" y2="3" stroke={color} strokeWidth="2.4"
        strokeDasharray={dash} strokeLinecap={kind === 'candidate' ? 'round' : 'butt'} />
    </svg>
  );
}

const LINE_KIND_INFO = {
  existing:  ['Existing', 'Transfer limits in the selected year, internal (pTransferLimit) and external (pExtTransferLimit)'],
  planned:   ['Planned', 'Committed lines in pNewTransmission (Status 2), built from their entry year, and later rises of the external limits in pExtTransferLimit'],
  candidate: ['Candidate', 'Candidate lines in pNewTransmission, built only if the model chooses them'],
};

/** Show or hide each kind of line; each button is also its legend entry. A kind
 *  the folder does not have gets no button. */
function LineKindToggles({ t, epmData, value, onToggle }) {
  const newTx = epmData.txExpansionOff ? [] : epmData.newTx || [];
  const ext = epmData.extExchangeOff || !epmData.zonesExtGJ ? [] : epmData.extNtc || [];
  const has = {
    existing: (epmData.ntc || []).some(hasCapacity) || ext.some(hasCapacity),
    planned: newTx.some(r => r.kind === 'planned') || ext.some(extRises),
    candidate: newTx.some(r => r.kind === 'candidate'),
  };
  const noNew = epmData.txExpansionOff && (epmData.newTx || []).length > 0;
  const noExt = epmData.extExchangeOff && (epmData.extNtc || []).some(hasCapacity);
  const kinds = Object.keys(LINE_KIND_INFO).filter(k => has[k]);
  if (!kinds.length && !noNew && !noExt) return null;
  return (
    <div style={{ display: 'flex', gap: 2, alignItems: 'center', backgroundColor: t.panel,
      border: `1px solid ${t.panelBorder}`, borderRadius: 4, padding: 2 }}>
      <span style={{ fontSize: '0.46rem', color: t.lblMuted, padding: '0 4px' }}>Lines</span>
      {kinds.map(k => (
        <button key={k} onClick={() => onToggle(k)} title={LINE_KIND_INFO[k][1]} style={{
          display: 'flex', alignItems: 'center', gap: 4,
          fontSize: '0.46rem', fontFamily: 'inherit', cursor: 'pointer',
          padding: '2px 7px', borderRadius: 3, border: 'none',
          backgroundColor: value[k] ? 'rgba(74,143,204,0.2)' : 'transparent',
          color: value[k] ? t.lbl : t.lblMuted,
          fontWeight: value[k] ? 700 : 400, opacity: value[k] ? 1 : 0.6,
        }}>
          <LineSwatch kind={k} />
          {LINE_KIND_INFO[k][0]}
        </button>
      ))}
      {noNew && (
        <span title="fAllowTransferExpansion is 0 in pSettings: the model adds no line, so none is drawn"
          style={{ fontSize: '0.44rem', color: t.lblMuted, padding: '0 5px', fontStyle: 'italic' }}>
          no new lines (pSettings)
        </span>
      )}
      {noExt && (
        <span title="fEnableExternalExchange is 0 in pSettings: no external corridor is used, so none is drawn"
          style={{ fontSize: '0.44rem', color: t.lblMuted, padding: '0 5px', fontStyle: 'italic' }}>
          no external exchange (pSettings)
        </span>
      )}
    </div>
  );
}

// ── About tab ─────────────────────────────────────────────────────────────────

// --- Raw data: the input files themselves, not a reading of them ---
//
// config.csv is already the index this tab needs: one row per parameter, in the
// order the model reads them, carrying a description, a unit and the file it
// points at, grouped under the section markers that mirror the folders on disk
// (LOAD, SUPPLY, TRADE...). So the sub-tabs, both dropdowns and every label here
// come out of the folder's own config -- nothing is hardcoded, and a folder that
// adds a parameter shows it without a change to this file.
//
// Only parameters are listed. config.csv also names the solver options file and
// the model type, which are settings rather than data, and a folder holds map
// layers and stray zcmap variants that no one reads as a table.
function RawInputsTab({ t, region, scnMeta, activeFolder, docs }) {
  const branch = region?.epm?.branch;

  const sections = useMemo(() => {
    const out = new Map();
    for (const [param, meta] of Object.entries(scnMeta?.paramMeta || {})) {
      // 'modeltype,RMIP' and 'cplexfile,cplex/....opt' live in config.csv too;
      // neither is a table, and RMIP is not even a path.
      if (!/\.csv$/i.test(meta.defaultFile || '')) continue;
      const sec = meta.section || 'GENERAL';
      if (!out.has(sec)) out.set(sec, []);
      out.get(sec).push({ param, ...meta });
    }
    return out;
  }, [scnMeta]);

  const sectionNames = [...sections.keys()];
  const [section, setSection] = useState('');
  const [param,   setParam]   = useState('');
  const [variant, setVariant] = useState('');
  const [expScen, setExpScen] = useState('');

  const activeSection = sections.has(section) ? section : sectionNames[0] || '';
  const params        = sections.get(activeSection) || [];
  const activeParam   = params.some(p => p.param === param) ? param : params[0]?.param || '';
  const meta          = params.find(p => p.param === activeParam);

  const variants   = scnMeta?.variantsForParam?.(activeParam) || [];
  const useVariant = variants.includes(variant) ? variant : '';
  const file       = useVariant || meta?.defaultFile || '';

  // Which scenarios reach for a given variant -- the reason it exists at all,
  // and the one thing the file name alone never says.
  const usedBy = (f) => Object.entries(scnMeta?.overridesByParam?.[activeParam] || {})
    .filter(([, v]) => v === f).map(([sc]) => sc);

  if (!scnMeta) return <div style={{ fontSize:'0.44rem', color:t.lblMuted, padding:'10px 2px' }}>
    No config.csv in this folder, so there is no parameter index to list.
  </div>;
  if (!file) return <div style={{ fontSize:'0.44rem', color:t.lblMuted, padding:'10px 2px' }}>
    config.csv declares no data files for this folder.
  </div>;

  const url      = rawFileUrl(branch, `epm/input/${activeFolder}/${file}`);
  const filename = file.split('/').pop();
  // Description without the '(Unit: ...)' tail -- the unit is shown on its own,
  // and repeating it inside the sentence just makes the dropdown wider.
  const plain = (label) => (label || '').replace(/\s*\(Unit:[^)]*\)\s*/gi, ' ').trim();

  // Every parameter config.csv declares, in the order it declares them. One
  // workbook is one input set: the base files, or every file one scenario reads,
  // its own variant where it swaps one and the base file where it does not. A
  // workbook mixing variants of different scenarios could not say which is which.
  const scenList = scnMeta?.scenarios || [];
  const exportScen = scenList.includes(expScen) ? expScen : '';
  const all = [...sections.values()].flat().map(p => {
    const swapped = exportScen ? scnMeta.overridesByParam?.[p.param]?.[exportScen] : '';
    const path = swapped || p.defaultFile || '';
    return {
      sheet: p.param,
      label: plain(p.label),
      unit: p.unit || '',
      unitFrom: inputUnitFrom(p.unit),
      file: path,
      ...(exportScen ? { variant: !!swapped, baseFile: p.defaultFile || '' } : {}),
      url: rawFileUrl(branch, `epm/input/${activeFolder}/${path}`),
    };
  });
  const scenTitle = (sc) => docs?.docFor?.(sc)?.title || '';
  const bookMeta = [
    ['EPM View', 'raw input export'],
    ['region', region?.name], ['branch', branch], ['data folder', activeFolder],
    ['scenario', exportScen
      ? `${exportScen}${scenTitle(exportScen) ? ` (${scenTitle(exportScen)})` : ''}`
      : 'none, the base files as config.csv declares them'],
    ['downloaded', new Date().toISOString()],
  ];
  const matrix = scenarioMatrixRows(scnMeta, docs?.docFor);
  const extraSheets = matrix ? [{ name: 'Scenarios', rows: matrix }] : [];
  const loadSources = () => fetchDataSources(branch, activeFolder);

  const sel = { fontSize:'0.44rem', fontFamily:'inherit', padding:'3px 6px', borderRadius:3,
    border:`1px solid ${t.panelBorder}`, backgroundColor:t.panel, color:t.muted, cursor:'pointer' };

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
      <div style={{ display:'flex', gap:2, flexWrap:'wrap' }}>
        {sectionNames.map(sec => {
          const active = sec === activeSection;
          return (
            <button key={sec} onClick={() => { setSection(sec); setParam(''); setVariant(''); }} style={{
              fontSize:'0.44rem', letterSpacing:'0.6px', fontFamily:'inherit', padding:'3px 8px',
              borderRadius:3, cursor:'pointer',
              border:`1px solid ${active ? t.lbl : t.panelBorder}`,
              backgroundColor: active ? 'rgba(128,160,192,0.12)' : 'transparent',
              color: active ? t.lbl : t.lblMuted, fontWeight: active ? 700 : 400,
            }}>{sec}</button>
          );
        })}
      </div>

      <div style={{ display:'flex', gap:10, flexWrap:'wrap', alignItems:'center', fontSize:'0.44rem' }}>
        <label style={{ display:'flex', gap:5, alignItems:'center', color:t.lblMuted }}>
          Parameter
          <select value={activeParam} onChange={e => { setParam(e.target.value); setVariant(''); }}
            style={{ ...sel, maxWidth:420 }}>
            {params.map(p => (
              <option key={p.param} value={p.param}>
                {plain(p.label) || p.param}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display:'flex', gap:5, alignItems:'center', color:t.lblMuted }}>
          Variant
          <select value={useVariant} onChange={e => setVariant(e.target.value)}
            disabled={!variants.length} style={{ ...sel, maxWidth:320,
              opacity: variants.length ? 1 : 0.6, cursor: variants.length ? 'pointer' : 'default' }}>
            <option value="">Base — {baseName(meta?.defaultFile)}</option>
            {variants.map(f => {
              const who = usedBy(f);
              return <option key={f} value={f}>
                {baseName(f)}{who.length ? ` — ${who.join(', ')}` : ''}
              </option>;
            })}
          </select>
        </label>

        <label style={{ display:'flex', gap:5, alignItems:'center', color:t.lblMuted, marginLeft:'auto' }}
          title="The input set the Excel download holds: the base files, or every file one scenario reads">
          Export
          <select value={exportScen} onChange={e => setExpScen(e.target.value)}
            disabled={!scenList.length} style={{ ...sel, maxWidth:260 }}>
            <option value="">Base files (config.csv)</option>
            {scenList.map(sc => {
              const n = scnMeta.diffByScenario?.[sc]?.length || 0;
              return <option key={sc} value={sc}>
                {sc}{scenTitle(sc) ? ` · ${scenTitle(sc)}` : ''} ({n} changed)
              </option>;
            })}
          </select>
        </label>

        <DownloadAllExcel t={t} items={all} meta={bookMeta} loadSources={loadSources}
          scenario={exportScen} extraSheets={extraSheets}
          filename={exportName([branch, activeFolder, exportScen], '_inputs.xlsx')} />
      </div>

      <RawDataTable
        key={url} t={t} url={url} filename={filename}
        title={plain(meta?.label) || activeParam}
        unit={meta?.unit || ''}
        missingMsg={`config.csv declares ${file}, but this folder does not ship it.`}
        lines={inputLines({ filename, param: activeParam, meta,
          regionName: region?.name, branch, dataFolder: activeFolder, url })}
      />
    </div>
  );
}

function AboutTab({ region, t, epmData, epmLoading, activeFolder }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ border: `1px solid ${t.panelBorder}`, borderRadius: 8, padding: '12px 14px',
        fontSize: '0.58rem', color: t.muted, lineHeight: 1.6 }}>
        <div style={{ fontSize: '0.6rem', fontWeight: 700, color: t.lbl, marginBottom: 6 }}>
          {region.name} — EPM Study
        </div>
        <div><b style={{ color: t.lbl }}>Countries:</b> {region.countries.map(c => c.name).join(', ')}</div>
        {region.epm && (
          <>
            <div style={{ marginTop: 4 }}>
              <b style={{ color: t.lbl }}>Branch:</b>{' '}
              <code style={{ fontSize: '0.52rem' }}>{region.epm.branch}</code>
            </div>
            <div>
              <b style={{ color: t.lbl }}>Data folder:</b>{' '}
              <code style={{ fontSize: '0.52rem' }}>{activeFolder ?? region.epm.dataFolder}</code>
            </div>
            {/* A folder is offered as soon as the directory exists, and a directory
                holding only its DATA_SOURCES page exists while its data still sits in
                the private store. Every fetch then returns nothing and the page has
                only empty panels to show, which reads as a broken site rather than as
                an unpublished folder. Say which it is. */}
            {!epmLoading && epmData && !epmData.zcmap.length && (
              <div style={{ marginTop: 6, padding: '6px 8px', borderRadius: 6,
                border: `1px solid ${t.panelBorder}`, color: t.lblMuted, fontSize: '0.55rem' }}>
                <b style={{ color: t.lbl }}>Not published.</b>{' '}
                No input data is readable for <code style={{ fontSize: '0.52rem' }}>{activeFolder}</code> on
                this branch — the folder is there but its tables are not. Pick another
                folder above, or see the data sources page below.
              </div>
            )}
            <div>
              <b style={{ color: t.lbl }}>Source:</b>{' '}
              <a href={`https://github.com/ESMAP-World-Bank-Group/EPM/tree/${region.epm.branch}`}
                target="_blank" rel="noreferrer"
                style={{ color: t.lbl, fontSize: '0.52rem' }}>
                ESMAP-World-Bank-Group/EPM
              </a>
            </div>
          </>
        )}
      </div>
      {region.epm && (
        <a href={`https://htmlpreview.github.io/?https://raw.githubusercontent.com/ESMAP-World-Bank-Group/EPM/${region.epm.branch}/epm/input/${activeFolder ?? region.epm.dataFolder}/DATA_SOURCES.html`}
          target="_blank" rel="noreferrer"
          style={{ textDecoration: 'none' }}>
          <div style={{ border: `1px solid ${t.panelBorder}`, borderRadius: 8, padding: '10px 14px',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            cursor: 'pointer', transition: 'background 0.15s',
            backgroundColor: t.panel }}
            onMouseEnter={e => e.currentTarget.style.backgroundColor = t.isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)'}
            onMouseLeave={e => e.currentTarget.style.backgroundColor = t.panel}>
            <div>
              <div style={{ fontSize: '0.6rem', fontWeight: 700, color: t.lbl, marginBottom: 2 }}>
                Data Sources
              </div>
              <div style={{ fontSize: '0.52rem', color: t.muted }}>
                Detailed methodology and source references for all input data
              </div>
            </div>
            <span style={{ fontSize: '0.85rem', color: t.lblMuted, marginLeft: 10 }}>↗</span>
          </div>
        </a>
      )}
      <div style={{ border: `1px solid ${t.panelBorder}`, borderRadius: 8, padding: '12px 14px',
        fontSize: '0.58rem', color: t.muted, lineHeight: 1.7 }}>
        <div style={{ fontSize: '0.6rem', fontWeight: 700, color: t.lbl, marginBottom: 6 }}>Data loaded</div>
        {epmData ? (
          <>
            <div>Generation units: <b style={{ color: t.lbl }}>{epmData.gen.length}</b></div>
            <div>Demand zones: <b style={{ color: t.lbl }}>{[...new Set(epmData.demand.map(r => r.zone))].length}</b></div>
            <div>NTC corridors: <b style={{ color: t.lbl }}>{(() => { const s=new Set(); epmData.ntc.forEach(r=>{const k=[r.z,r.z2].sort().join('||');s.add(k);}); return s.size; })()}</b></div>
            <div>Zones mapped: <b style={{ color: t.lbl }}>{epmData.zcmap.length}</b></div>
            <div>Demand profiles: <b style={{ color: t.lbl }}>{epmData.demandProfile ? Object.keys(epmData.demandProfile).length + ' zones' : 'n/a'}</b></div>
          </>
        ) : (
          <div style={{ color: t.lblMuted }}>No EPM data configured for this region.</div>
        )}
      </div>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function RegionPage() {
  const { regionId } = useParams();
  const { theme }    = useTheme();
  const t            = getT(theme);
  const navigate     = useNavigate();

  const containerRef       = useRef(null);
  const mapRef             = useRef(null);
  const donutMarkersRef    = useRef([]);
  const zoneCentroidsRef   = useRef({});
  const countryCentroidsRef = useRef({});

  const [region,        setRegion]        = useState(null);
  const [capacity,      setCapacity]      = useState(null);
  const [tariffs,       setTariffs]       = useState(null);
  const [access,        setAccess]        = useState(null);
  const [gppdAvailable, setGppdAvailable] = useState(null);
  const [gemAvailable,  setGemAvailable]  = useState(null);
  const [presentFuels,  setPresentFuels]  = useState(new Set());
  const [fuelsOff,      setFuelsOff]      = useState(new Set());
  const [statusOff,     setStatusOff]     = useState(new Set());
  const [kvsOff,        setKvsOff]        = useState(new Set());
  const [linesOn,       setLinesOn]       = useState(true);
  const [plantsOn,      setPlantsOn]      = useState(true);
  const [subsOn,          setSubsOn]          = useState(false);
  const [loadCentersOn,   setLoadCentersOn]   = useState(false);
  const [lcMinPop,        setLcMinPop]        = useState(300_000);
  const [lcCircleScale,   setLcCircleScale]   = useState(1.0);
  const [minMw,           setMinMw]           = useState(100);
  const [circleScale,     setCircleScale]     = useState(1.0);
  const [plantSource,     setPlantSource]     = useState('osm');
  const [activeTab,       setActiveTab]       = useState('overview');
  const [availZone,       setAvailZone]       = useState('all');
  const [resourceSection, setResourceSection] = useState('vre');
  const [basemap,         setBasemap]         = useState('minimal');
  const [satLabels,       setSatLabels]       = useState(false);
  const [epmDataRaw,         setEpmData]         = useState(null);

  // Zones this region asked to be shown as external, moved across the line before any
  // of the code below sees them (utils/zoneClass). For every other region this hands
  // the raw object straight back.
  const epmData = usePromotedEpmData(region, epmDataRaw);

  const [epmLoading,      setEpmLoading]      = useState(false);
  const [scnMeta,         setScnMeta]         = useState(undefined);
  const [scnDocs,         setScnDocs]         = useState(null);
  const [varOverrides,    setVarOverrides]    = useState({});
  const [activeFolder,    setActiveFolder]    = useState(null);
  const [activeZcmap,     setActiveZcmap]     = useState(null);
  const setVariant = (param, file) => setVarOverrides(o => {
    const next = { ...o };
    if (file) next[param] = file; else delete next[param];
    return next;
  });
  const [pieMode,         setPieMode]         = useState('zone');
  const [epmYear,         setEpmYear]         = useState(null);
  const [outputNtc,       setOutputNtc]       = useState([]);
  const [showExtZones,    setShowExtZones]    = useState(true);
  const showExtRef = useRef(true);
  const [lineKinds,       setLineKinds]       = useState({ existing: true, planned: true, candidate: true });
  const lineKindsRef = useRef({ existing: true, planned: true, candidate: true });
  const [mapLoaded,       setMapLoaded]       = useState(0);
  const [panelWidth,      setPanelWidth]      = useState(680);
  const { zoom, inc, dec, reset } = usePanelZoom();
  const [autoFolders,     setAutoFolders]     = useState(null);
  const isDrRef = useRef(false); const drStartX = useRef(0); const drStartW = useRef(0);

  // Static data
  useEffect(() => {
    fetch(dataPath('tariffs.json')).then(r => r.json()).then(setTariffs).catch(() => {});
    fetch(dataPath('access.json')).then(r => r.json()).then(setAccess).catch(() => {});
  }, []);

  // Region metadata
  useEffect(() => {
    track('region_view', { region: regionId });
    fetch(dataPath('regions.json')).then(r => r.json()).then(d => {
      const r = (d.regions || []).find(r => r.id === regionId);
      setRegion(r || null);
    });
    setCapacity(null);
    // Written scenario descriptions, when the study has any (utils/scenarioDocs).
    fetchScenarioDocs(regionId).then(setScnDocs);
    fetch(dataPath(`cache/region_capacity_${regionId}.json`)).then(r => r.json()).then(setCapacity).catch(() => {});
    setFuelsOff(new Set()); setStatusOff(new Set()); setKvsOff(new Set());
    setLinesOn(true); setPlantsOn(true); setSubsOn(false);
    setLoadCentersOn(false); setLcMinPop(300_000); setLcCircleScale(1.0);
    setMinMw(100); setCircleScale(1.0);
    setPlantSource('osm'); setActiveTab('overview');
    setGppdAvailable(null);
    fetch(dataPath(`cache/region_plants_${regionId}_gppd.geojson`), { method: 'HEAD' })
      .then(r => setGppdAvailable(r.ok)).catch(() => setGppdAvailable(false));
    setGemAvailable(null);
    fetch(dataPath(`cache/region_plants_${regionId}_gem.geojson`), { method: 'HEAD' })
      .then(r => setGemAvailable(r.ok)).catch(() => setGemAvailable(false));
  }, [regionId]);

  // Reset year when region changes
  useEffect(() => { setEpmYear(null); }, [region]);

  // ── Init active folder + auto-detect all data_* folders from GitHub ──────────
  useEffect(() => {
    if (!region?.epm) return;
    const { branch, dataFolder, dataFolders } = region.epm;
    setActiveFolder(dataFolders?.[0]?.id ?? dataFolder);
    setAutoFolders(null);
    fetchDataFolderList(branch, dataFolder).then(list => setAutoFolders(list));
  }, [region]);

  // ── Auto-detect zcmap list when folder changes ────────────────────────────────
  const [zcmapList, setZcmapList] = useState(['zcmap']);
  useEffect(() => {
    if (!region?.epm || !activeFolder) return;
    fetchZcmapList(region.epm.branch, activeFolder).then(list => {
      setZcmapList(list);
      setActiveZcmap(list[0]);
    });
  }, [region, activeFolder]);

  function handleFolderChange(folderId) {
    setActiveFolder(folderId);
    setVarOverrides({});
  }

  // Load scenario definitions (config.csv + scenarios.csv) for variant pickers
  // scnMeta is tri-state: undefined while loading, null when no config is
  // reachable, object once parsed. The data effect below waits for it, so no
  // fetch fires against the fallback paths and then again against the real ones.
  useEffect(() => {
    setScnMeta(undefined);
    setVarOverrides({});
    if (!region?.epm || !activeFolder) return;
    const { branch, scenariosFile, configFile } = region.epm;
    fetchScenarioConfig(branch, activeFolder, { scenariosFile, configFile })
      .then(m => setScnMeta(m || null))
      .catch(() => setScnMeta(null));
  }, [region, activeFolder]);

  // EPM data — also fetches linestring + demand profile
  const prevRegionRef = useRef(null);
  const prevFolderRef = useRef(null);
  const prevZcmapRef  = useRef(null);
  useEffect(() => {
    if (!region?.epm || !activeFolder || !activeZcmap || scnMeta === undefined) {
      if (!region?.epm) setEpmData(null);
      return;
    }
    const regionOrFolderChanged = prevRegionRef.current !== region || prevFolderRef.current !== activeFolder;
    const zcmapChanged = prevZcmapRef.current !== activeZcmap;
    prevRegionRef.current = region;
    prevFolderRef.current = activeFolder;
    prevZcmapRef.current  = activeZcmap;
    const { branch } = region.epm;
    // config.csv is authoritative for where a parameter reads from; the literal
    // below is only a last resort for a folder whose config we could not read.
    const rf = (param, fallback) => resolveFile(scnMeta, varOverrides, param, fallback);
    if (regionOrFolderChanged) { setEpmData(null); setEpmLoading(true); }
    Promise.all([
      fetchEpmCSV(branch, activeFolder, rf('pGenDataInput', 'supply/pGenDataInput.csv')),
      fetchEpmCSV(branch, activeFolder, rf('pDemandForecast', 'load/pDemandForecast.csv')),
      fetchEpmCSV(branch, activeFolder, rf('pTransferLimit', 'trade/pTransferLimit.csv')),
      fetchEpmCSV(branch, activeFolder, `${activeZcmap}.csv`),
      fetchLinestringGeoJSON(branch, activeFolder, activeZcmap),
      fetchEpmCSV(branch, activeFolder, rf('pDemandProfile', 'load/pDemandProfile.csv')),
      fetchZonesGeoJSON(branch, activeFolder, activeZcmap),
      fetchEpmCSV(branch, activeFolder, rf('pVREProfile', 'supply/pVREProfile.csv')),
      fetchEpmCSV(branch, activeFolder, rf('pAvailabilityDefault', 'supply/pAvailabilityDefault.csv')),
      fetchEpmCSV(branch, activeFolder, rf('pFuelPrice', 'supply/pFuelPrice.csv')),
      fetchEpmCSV(branch, activeFolder, rf('pHours', 'pHours.csv')),
      fetchZonesExtGeoJSON(branch, activeFolder),
      fetchEpmCSV(branch, activeFolder, rf('pExtTransferLimit', 'trade/pExtTransferLimit.csv')),
      fetchEpmCSV(branch, activeFolder, rf('pDemandData', 'load/pDemandData.csv')),
      fetchZonesOffgridGeoJSON(branch, activeFolder),
      fetchEpmCSV(branch, activeFolder, rf('pNewTransmission', 'trade/pNewTransmission.csv')),
      fetchEpmCSV(branch, activeFolder, rf('pSettings', 'pSettings.csv')),
    ]).then(([genRaw, demandRaw, ntcRaw, zcmapRaw, linestringGJ, profileRaw, zonesGJ, vreRaw, availRaw, fpRaw, hoursRaw, zonesExtGJ, extNtcRaw, demandDataRaw, offgridGJ, newTxRaw, settingsRaw]) => {
      // Folders that carry a full load table instead of a forecast (v7.9 style) fall back to pDemandData
      const demand = demandRaw?.length ? processDemand(demandRaw)
                                       : processDemandData(demandDataRaw, hoursRaw);
      // Which parameter the tab is really showing, and so which one its download
      // has to name: on a v7.9 folder the figures are not pDemandForecast at all.
      const demandSource = demandRaw?.length
        ? { param: 'pDemandForecast', file: rf('pDemandForecast', 'load/pDemandForecast.csv'), derived: false }
        : { param: 'pDemandData',     file: rf('pDemandData', 'load/pDemandData.csv'),         derived: true  };
      const demandYears = availableYears(demand);
      const defaultYr = demandYears.find(y => parseInt(y) >= 2023) || demandYears[0];
      if (regionOrFolderChanged && defaultYr) setEpmYear(defaultYr);
      setEpmData(prev => ({
        gen:               genRaw    ? processGenData(genRaw)               : [],
        demand,
        demandSource,
        ntc:               ntcRaw    ? processNTC(ntcRaw)                   : [],
        ntcFile:           rf('pTransferLimit', 'trade/pTransferLimit.csv'),
        zcmap:             zcmapRaw  || [],
        demandProfileFull: profileRaw ? processDemandProfileFull(profileRaw) : {},
        vreProfile:        vreRaw    ? processVREProfile(vreRaw)            : {},
        availability:      availRaw  ? processAvailability(availRaw)        : {},
        fuelPrice:         fpRaw     ? processFuelPrice(fpRaw)              : {},
        hours:             hoursRaw  ? processHours(hoursRaw)               : {},
        // 24 for a chronological model, 6-7 for a load-block one (see processTimeSlices)
        timeSlices:        hoursRaw  ? processTimeSlices(hoursRaw)         : {nT:24,isHourly:true,hours:{}},
        extNtc:            extNtcRaw ? processExtNTC(extNtcRaw)             : [],
        // Lines the model may add. With fAllowTransferExpansion at 0 it adds none,
        // whatever the file says; a pSettings that does not name the switch is
        // left to the file.
        newTx:             newTxRaw  ? processNewTransmission(newTxRaw)     : [],
        txExpansionOff:    settingValue(settingsRaw, 'fAllowTransferExpansion') === 0,
        extExchangeOff:    settingValue(settingsRaw, 'fEnableExternalExchange') === 0,
        linestringGJ: (regionOrFolderChanged || zcmapChanged || !prev) ? linestringGJ : prev.linestringGJ,
        zonesGJ:      (regionOrFolderChanged || zcmapChanged || !prev) ? zonesGJ      : prev.zonesGJ,
        zonesExtGJ:   (regionOrFolderChanged || !prev) ? zonesExtGJ   : prev.zonesExtGJ,
        offgridGJ:    (regionOrFolderChanged || !prev) ? offgridGJ    : prev.offgridGJ,
        branch,
        dataFolder: activeFolder,
      }));
    }).finally(() => setEpmLoading(false));
  }, [region, activeFolder, activeZcmap, varOverrides, scnMeta]);

  // Load output-only NTC corridors (lines present in scenario outputs but not in pTransferLimit input)
  useEffect(() => {
    if (!region?.epm) return;
    const { branch } = region.epm;
    let cancelled = false;
    (async () => {
      try {
        const outDir = await resolveOutputDir(branch);
        const runs = await fetchRunList(branch, outDir);
        if (!runs.length || cancelled) return;
        const simRun = [...runs].sort().at(-1);
        const items = await fetchGitHubDir(branch, `${outDir}/${simRun}`);
        const scens = (items || []).filter(i => i.type === 'dir').map(i => i.name);
        if (!scens.length || cancelled) return;
        const txArrays = await Promise.all(
          scens.map(s => fetchResultCSV(branch, simRun, s, 'pTransmissionMerged.csv', outDir).catch(() => null))
        );
        if (cancelled) return;
        const pairs = {};
        for (const rows of txArrays) {
          if (!rows) continue;
          const tx = processTransmissionResults(rows);
          for (const [z, zm] of Object.entries(tx)) {
            for (const [z2, attrs] of Object.entries(zm)) {
              const key = [z, z2].sort().join('||');
              if (!pairs[key]) pairs[key] = { z, z2, years: {} };
              for (const [y, mw] of Object.entries(attrs.TransmissionCapacity || {})) {
                pairs[key].years[y] = Math.max(pairs[key].years[y] || 0, mw);
              }
            }
          }
        }
        setOutputNtc(Object.values(pairs));
      } catch { /* non-blocking */ }
    })();
    return () => { cancelled = true; };
  }, [region]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fleet age — GPPD only
  useEffect(() => {
    if (plantSource !== 'gppd') return;
    fetch(dataPath(`cache/region_age_${regionId}_gppd.json`))
      .then(r => r.ok ? r.json() : null).catch(() => {});
  }, [plantSource, regionId]);

  // ── Map initialisation ────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || !region) return;
    // EPM region: wait for data; skip map if neither linestring nor zones available
    if (region.epm) {
      if (!epmData) return;
      if (!epmData.linestringGJ && !epmData.zonesGJ) return;
    }

    const isos = region.countries.map(c => c.iso);
    const isEpm = !!(region.epm && epmData && (epmData.linestringGJ || epmData.zonesGJ));

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: mapStyle(theme),
      center: [0, 20], zoom: 2, minZoom: 1, maxZoom: 14,
      canvasContextAttributes: { preserveDrawingBuffer: true }, attributionControl: false,
    });
    mapRef.current = map;

    const popup = new maplibregl.Popup({
      closeButton: false, closeOnClick: false, offset: 10,
      className: `popup-${theme}`,
    });

    map.on('load', async () => {
      const countries = await fetchCountries('10m');
      const boundaries = await fetchBoundaries('10m');

      const bounds = fitBounds(isos, countries);
      if (bounds) map.fitBounds(bounds, { padding: 40, duration: 0 });

      addCountriesSource(map, countries);
      const tv = getT(theme);
      addBaseLayers(map, tv, boundaries);

      if (isEpm) {
        // ── EPM map: zone polygons + NTC lines + country donut markers ───────
        const lsgj = epmData.linestringGJ;
        const zonesGJ = epmData.zonesGJ;
        const zcmapRows = epmData.zcmap;  // [{z, c}]
        const zoneToCountry = Object.fromEntries(zcmapRows.map(r => [r.z, r.c]));

        // Unique countries → colors
        const regionCountries = [...new Set(zcmapRows.map(r => r.c))].sort();
        const countryColorMap = {};
        regionCountries.forEach((c, i) => { countryColorMap[c] = MAP_PALETTE[i % MAP_PALETTE.length]; });

        // Zone centroids — linestring endpoints are canonical (match the drawn lines);
        // polygon centroids fill in zones that appear in zonesGJ but not in any linestring.
        const zoneCentroids = zoneCentroidMap(zonesGJ, lsgj);

        // Country centroids = average of zone centroids per country
        const countryCentroids = {};
        for (const { z, c } of zcmapRows) {
          const coord = zoneCentroids[z];
          if (!coord) continue;
          if (!countryCentroids[c]) countryCentroids[c] = { sum: [0, 0], n: 0 };
          countryCentroids[c].sum[0] += coord[0];
          countryCentroids[c].sum[1] += coord[1];
          countryCentroids[c].n++;
        }
        for (const c of Object.keys(countryCentroids)) {
          const d = countryCentroids[c];
          countryCentroids[c] = [d.sum[0] / d.n, d.sum[1] / d.n];
        }

        // Store centroids in refs for pieMode effect
        zoneCentroidsRef.current = zoneCentroids;
        countryCentroidsRef.current = countryCentroids;

        // Zone polygon fill layer using zones.geojson
        if (zonesGJ) {
          const isoToCountry = {};
          for (const f of zonesGJ.features) isoToCountry[f.properties.ISO_A3] = f.properties.c;
          const countryToFirstZone = {};
          for (const { z, c } of zcmapRows) { if (!countryToFirstZone[c]) countryToFirstZone[c] = z; }
          const uniqueIsos = [...new Set(zonesGJ.features.map(f => f.properties.ISO_A3))];
          const fillExpr = ['match', ['get', 'ISO_A3'],
            ...uniqueIsos.flatMap(iso => [iso, countryColorMap[isoToCountry[iso]] || '#888']),
            'transparent',
          ];
          map.addSource('zones', { type: 'geojson', data: zonesGJ, generateId: true });
          map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zones',
            paint: { 'fill-color': fillExpr, 'fill-opacity': 0.25 } });
          map.addLayer({ id: 'zone-hover', type: 'fill', source: 'zones',
            filter: ['==', ['get', 'ISO_A3'], ''],
            paint: { 'fill-color': fillExpr, 'fill-opacity': 0.55 } });
          map.addLayer({ id: 'zone-border', type: 'line', source: 'zones',
            paint: { 'line-color': fillExpr, 'line-width': 1.2, 'line-opacity': 0.75 } });

          let hovIso = null;
          map.on('mousemove', 'zone-fill', e => {
            map.getCanvas().style.cursor = 'pointer';
            const iso = e.features[0].properties.ISO_A3;
            const c = isoToCountry[iso] || iso;
            if (iso !== hovIso) { hovIso = iso; map.setFilter('zone-hover', ['==', ['get', 'ISO_A3'], iso]); }
            popup.setLngLat(e.lngLat).setHTML(`<b>${c}</b><br><span style="opacity:.65;font-size:0.7em">click for VRE profile</span>`).addTo(map);
          });
          map.on('mouseleave', 'zone-fill', () => {
            map.getCanvas().style.cursor = '';
            hovIso = null; map.setFilter('zone-hover', ['==', ['get', 'ISO_A3'], '']); popup.remove();
          });
          map.on('click', 'zone-fill', e => {
            const iso = e.features[0].properties.ISO_A3;
            const c = isoToCountry[iso] || iso;
            navigate(`/region/${regionId}/country/${encodeURIComponent(c)}`);
          });
        } else if (lsgj) {
          // Fallback: country fill from world source (no zones.geojson)
          const isoColorPairs = [];
          for (const { z, c } of zcmapRows) {
            const f = lsgj.features.find(ft => ft.properties.z === z);
            const iso = f?.properties.ISO_A3;
            if (iso && iso !== '-99') isoColorPairs.push([iso, countryColorMap[c] || '#888']);
          }
          const fbIsos = [...new Set(isoColorPairs.map(([iso]) => iso))];
          const fbExpr = ['match', ['get', 'ISO_A3'], ...isoColorPairs.flat(), 'transparent'];
          map.addLayer({ id: 'zone-fill', type: 'fill', source: 'countries',
            filter: ['in', ['get', 'ISO_A3'], ['literal', fbIsos]],
            paint: { 'fill-color': fbExpr, 'fill-opacity': 0.28 } });
          map.addLayer({ id: 'zone-border', type: 'line', source: 'countries',
            filter: ['in', ['get', 'ISO_A3'], ['literal', fbIsos]],
            paint: { 'line-color': fbExpr, 'line-width': 1.2, 'line-opacity': 0.75 } });
        }

        // NTC transmission lines
        {
          const ntcYrs = availableYears(epmData.ntc);
          const ntcYr  = ntcYrs.find(y => epmData.ntc.some(r => (r.years[y] || 0) > 0))
                         || ntcYrs[0] || '2024';
          const seenPairs = new Set();
          let ntcFeatures = [];

          if (Object.keys(zoneCentroids).length > 0) {
            // Build NTC lines from computed zone centroids + pTransferLimit data
            ntcFeatures = epmData.ntc
              .filter(r => {
                const key = [r.z, r.z2].sort().join('||');
                if (seenPairs.has(key)) return false;
                seenPairs.add(key);
                return (r.years[ntcYr] || 0) > 0 && zoneCentroids[r.z] && zoneCentroids[r.z2];
              })
              .map(r => ({
                type: 'Feature',
                properties: { z: r.z, z_other: r.z2, ntc_mw: r.years[ntcYr] || 0 },
                geometry: { type: 'LineString', coordinates: [zoneCentroids[r.z], zoneCentroids[r.z2]] },
              }));
          } else if (lsgj) {
            // Fallback: original linestring-based NTC (for regions without zonesGJ)
            ntcFeatures = lsgj.features
              .filter(f => {
                const { z, z_other } = f.properties;
                if (!z || !z_other) return false;
                const key = [z, z_other].sort().join('||');
                if (seenPairs.has(key)) return false;
                seenPairs.add(key);
                const entry = epmData.ntc.find(r =>
                  (r.z === z && r.z2 === z_other) || (r.z === z_other && r.z2 === z));
                return (entry?.years[ntcYr] || 0) > 0;
              })
              .map(f => {
                const { z, z_other } = f.properties;
                const entry = epmData.ntc.find(r =>
                  (r.z === z && r.z2 === z_other) || (r.z === z_other && r.z2 === z));
                return { ...f, properties: { ...f.properties, ntc_mw: entry?.years[ntcYr] || 0 } };
              });
          }

          {
            map.addSource('ntc-lines', { type: 'geojson',
              data: { type: 'FeatureCollection', features: ntcFeatures } });
            map.addLayer({ id: 'ntc-lines-layer', type: 'line', source: 'ntc-lines',
              layout: { 'line-cap': 'round', 'line-join': 'round',
                visibility: lineKindsRef.current.existing ? 'visible' : 'none' },
              paint: { 'line-color': '#f0b030',
                'line-width': ['interpolate', ['linear'], ['get', 'ntc_mw'], 0, 1, 500, 2, 2000, 3.5, 8000, 6],
                'line-opacity': 0.88 } });
            map.addLayer({ id: 'ntc-labels', type: 'symbol', source: 'ntc-lines',
              layout: { 'text-field': ['concat', ['to-string', ['round', ['get', 'ntc_mw']]], ' MW'],
                'text-size': 8, 'symbol-placement': 'line-center', 'text-allow-overlap': false,
                visibility: lineKindsRef.current.existing ? 'visible' : 'none' },
              paint: { 'text-color': '#b07800',
                'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.5 } });
          }

          // Planned and candidate lines from pNewTransmission, drawn above the
          // existing ones; the data comes in through an effect, which also follows
          // a change of variant without rebuilding the map.
          map.addSource('newtx-lines', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
          for (const kind of Object.keys(NEW_TX_STYLE)) {
            const st = NEW_TX_STYLE[kind];
            const visibility = lineKindsRef.current[kind] ? 'visible' : 'none';
            map.addLayer({ id: `newtx-${kind}`, type: 'line', source: 'newtx-lines',
              filter: ['==', ['get', 'kind'], kind],
              layout: { 'line-cap': st.cap, 'line-join': 'round', visibility },
              paint: { 'line-color': st.color, 'line-opacity': 0.95,
                'line-width': ['interpolate', ['linear'], ['get', 'mw'], 0, 1.5, 500, 2.2, 2000, 3.5, 8000, 5],
                'line-dasharray': st.dash, 'line-offset': ['get', 'offset'] } });
            map.addLayer({ id: `newtx-${kind}-labels`, type: 'symbol', source: 'newtx-lines',
              filter: ['==', ['get', 'kind'], kind],
              layout: { 'text-field': ['get', 'label'], 'text-size': 8, visibility,
                'symbol-placement': 'line-center', 'text-allow-overlap': false,
                'text-offset': [0, kind === 'planned' ? -0.9 : 0.9] },
              paint: { 'text-color': st.text,
                'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.5 } });
            map.on('mousemove', `newtx-${kind}`, e => {
              map.getCanvas().style.cursor = 'pointer';
              popup.setLngLat(e.lngLat).setHTML(newTxPopup(e.features[0].properties)).addTo(map);
            });
            map.on('mouseleave', `newtx-${kind}`, () => { map.getCanvas().style.cursor = ''; popup.remove(); });
          }
        }

        // ── External zone layers (toggle-controlled) ─────────────────────
        const extData = buildExtZoneData(epmData.zonesExtGJ, epmData.extNtc || [], zoneCentroids, epmYear,
          { off: epmData.extExchangeOff });
        addExtZoneLayers(map, tv, extData, { visible: showExtRef.current });
        bindExtZoneHandlers(map, popup);
        applyLineVisibility(map, lineKindsRef.current, showExtRef.current);

        // ── Areas of the modelled countries that belong to no zone ──────
        addOffgridLayers(map, tv, epmData.offgridGJ);

        // Trigger donut rendering via pieMode effect
        setMapLoaded(n => n + 1);

      } else {
        // ── OSM map ──────────────────────────────────────────────────────────
        const [plantsGJ, linesGJ, subsGJ, lcGJ] = await Promise.all([
          fetch(dataPath(`cache/region_plants_${regionId}.geojson`)).then(r => r.json()),
          fetch(dataPath(`cache/region_lines_${regionId}.geojson`)).then(r => r.json()),
          fetch(dataPath(`cache/region_substations_${regionId}.geojson`))
            .then(r => r.json()).catch(() => ({ type: 'FeatureCollection', features: [] })),
          fetch(dataPath(`region_load_centers_${regionId}.geojson`))
            .then(r => r.json()).catch(() => ({ type: 'FeatureCollection', features: [] })),
        ]);

        map.addSource('plants',       { type: 'geojson', data: plantsGJ });
        map.addSource('lines',        { type: 'geojson', data: linesGJ  });
        map.addSource('substations',  { type: 'geojson', data: subsGJ   });
        map.addSource('load-centers', { type: 'geojson', data: lcGJ     });

        const tv = getT(theme);
        const kvFilters = {
          '500': ['>=', ['get', 'v'], 500_000],
          '330': ['all', ['>=', ['get', 'v'], 330_000], ['<', ['get', 'v'], 500_000]],
          '220': ['all', ['>=', ['get', 'v'], 220_000], ['<', ['get', 'v'], 330_000]],
          '110': ['<', ['get', 'v'], 220_000],
        };
        for (const { colors, width, key } of VOLTAGE_BRACKETS) {
          map.addLayer({ id: `lines-${key}`, type: 'line', source: 'lines',
            filter: kvFilters[key],
            paint: { 'line-color': colors[theme] ?? colors.fog, 'line-width': width,
              'line-opacity': tv.isDark ? 0.92 : 0.65 } });
        }

        const hl = tv.highlight;
        map.addLayer({ id: 'region-fill', type: 'fill', source: 'countries',
          filter: regionFilter(isos, region.non_determined),
          paint: { 'fill-color': hl.fill,
            'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.18, 0.08] } });
        map.addLayer({ id: 'region-border', type: 'line', source: 'countries',
          filter: ['in', ['get', 'ISO_A3'], ['literal', isos]],
          paint: { 'line-color': hl.border, 'line-width': hl.borderW, 'line-opacity': 0.9 } });
        addRegionCoast(map, { areas: region.non_determined, color: hl.border,
          width: hl.borderW, opacity: 0.9 });

        const fuels = new Set();
        for (const f of plantsGJ.features) {
          const fuel = f.properties.fuel;
          if (fuel && FUEL_COLORS[fuel]) fuels.add(fuel);
        }
        setPresentFuels(fuels);
        const colorExpr = fuelColorExpr();

        map.addLayer({ id: 'plants-operating', type: 'circle', source: 'plants',
          filter: makeLayerFilter('operating', new Set(), 100),
          paint: { 'circle-radius': plantRadiusExpr(), 'circle-color': colorExpr,
            'circle-opacity': 0.88, 'circle-stroke-width': 0.6, 'circle-stroke-color': 'rgba(0,0,0,0.3)' } });
        map.addLayer({ id: 'plants-construction', type: 'circle', source: 'plants',
          filter: makeLayerFilter('construction', new Set(), 100),
          paint: { 'circle-radius': plantRadiusExpr(), 'circle-color': 'rgba(0,0,0,0)',
            'circle-opacity': 1, 'circle-stroke-width': 2, 'circle-stroke-color': colorExpr,
            'circle-stroke-opacity': 0.9 } });
        map.addLayer({ id: 'plants-planned', type: 'circle', source: 'plants',
          filter: makeLayerFilter('planned', new Set(), 100),
          paint: { 'circle-radius': plantRadiusExpr(), 'circle-color': colorExpr,
            'circle-opacity': 0.22, 'circle-stroke-width': 1, 'circle-stroke-color': colorExpr,
            'circle-stroke-opacity': 0.45 } });

        for (const status of PLANT_STATUSES) {
          map.on('mouseenter', `plants-${status}`, e => {
            map.getCanvas().style.cursor = 'pointer';
            const p = e.features[0].properties;
            const name   = p.name ? `<b>${p.name}</b><br>` : '';
            const mwText = p.mw   ? ` · ${p.mw} MW` : '';
            const badge  = status !== 'operating'
              ? ` <span style="opacity:.55;font-size:.85em">[${status}]</span>` : '';
            popup.setLngLat(e.features[0].geometry.coordinates)
              .setHTML(`${name}<span style="opacity:.75">${p.fuel}${mwText}${badge}</span>`)
              .addTo(map);
          });
          map.on('mouseleave', `plants-${status}`, () => {
            map.getCanvas().style.cursor = ''; popup.remove();
          });
        }

        const sqSz = 5;
        const sqData = new Uint8Array(sqSz * sqSz * 4);
        for (let i = 0; i < sqSz * sqSz; i++) {
          sqData[i*4] = 105; sqData[i*4+1] = 105; sqData[i*4+2] = 105;
          sqData[i*4+3] = tv.isDark ? 160 : 130;
        }
        map.addImage('sub-sq', { width: sqSz, height: sqSz, data: sqData });
        map.addLayer({ id: 'substations', type: 'symbol', source: 'substations',
          filter: ['in', ['get', 'iso'], ['literal', isos]],
          layout: { 'icon-image': 'sub-sq', 'icon-allow-overlap': true, 'icon-ignore-placement': true, visibility: 'none' },
          paint: { 'icon-opacity': 0.8 } });
        map.on('mouseenter', 'substations', e => {
          map.getCanvas().style.cursor = 'pointer';
          const p = e.features[0].properties;
          const kv = p.v ? `${Math.round(p.v / 1000)} kV` : '';
          popup.setLngLat(e.features[0].geometry.coordinates)
            .setHTML(`${p.name ? `<b>${p.name}</b><br>` : ''}<span style="opacity:.75">Substation${kv ? ' · ' + kv : ''}</span>`)
            .addTo(map);
        });
        map.on('mouseleave', 'substations', () => { map.getCanvas().style.cursor = ''; popup.remove(); });

        map.addLayer({ id: 'load-centers', type: 'circle', source: 'load-centers',
          filter: ['>=', ['get', 'pop'], 300_000], layout: { visibility: 'none' },
          paint: { 'circle-radius': lcRadiusExpr(), 'circle-color': '#1a237e', 'circle-opacity': 0.72,
            'circle-stroke-width': 1.2, 'circle-stroke-color': 'rgba(255,255,255,0.65)' } });
        map.addLayer({ id: 'load-centers-labels', type: 'symbol', source: 'load-centers',
          filter: ['>=', ['get', 'pop'], 300_000], layout: { visibility: 'none',
            'text-field': ['get', 'name'], 'text-size': 9, 'text-offset': [0, 1.3], 'text-anchor': 'top' },
          paint: { 'text-color': '#1a237e', 'text-halo-color': 'rgba(255,255,255,0.88)', 'text-halo-width': 1.5 } });

        let hoveredId = null;
        map.on('mousemove', 'region-fill', e => {
          map.getCanvas().style.cursor = 'pointer';
          if (hoveredId !== null)
            map.setFeatureState({ source: 'countries', id: hoveredId }, { hover: false });
          hoveredId = e.features[0].id;
          map.setFeatureState({ source: 'countries', id: hoveredId }, { hover: true });
        });
        map.on('mouseleave', 'region-fill', () => {
          map.getCanvas().style.cursor = '';
          if (hoveredId !== null)
            map.setFeatureState({ source: 'countries', id: hoveredId }, { hover: false });
          hoveredId = null;
        });
        map.on('click', 'region-fill', e => {
          const iso = e.features[0].properties.ISO_A3;
          if (isos.includes(iso)) navigate(`/country/${iso}`);
        });
      }

      raiseBoundaries(map);
    });

    return () => {
      popup.remove();
      donutMarkersRef.current.forEach(m => m.remove());
      donutMarkersRef.current = [];
      mapRef.current?.remove();
    };
  }, [region, theme, epmData?.linestringGJ, epmData?.zonesGJ]); // eslint-disable-line react-hooks/exhaustive-deps

  // External zones toggle. The ref is what the map-load handler reads, so a rebuilt
  // map comes back at the visibility the user left it at.
  // Line toggles live in the same effect, since showing the external zones shows
  // their corridors too and the existing toggle has to be applied after it.
  useEffect(() => {
    showExtRef.current = showExtZones;
    lineKindsRef.current = lineKinds;
    setExtZonesVisible(mapRef.current, showExtZones);
    applyLineVisibility(mapRef.current, lineKinds, showExtZones);
  }, [showExtZones, lineKinds, mapLoaded]);

  // Planned and candidate lines. The internal ones are year independent: the entry
  // year is on the label, and a planned line stays dashed after it, since
  // pTransferLimit never holds it. The external rises are counted from the selected
  // year, and leave with the external zones.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !epmData || mapLoaded === 0 || !source(map, 'newtx-lines')) return;
    const ext = showExtZones && epmData.zonesExtGJ
      ? buildExtZoneData(epmData.zonesExtGJ, epmData.extNtc || [], zoneCentroidsRef.current, epmYear,
        { off: epmData.extExchangeOff }).extPlannedFeatures
      : [];
    source(map, 'newtx-lines').setData({ type: 'FeatureCollection',
      features: [...newTxFeatures(epmData, zoneCentroidsRef.current), ...ext] });
  }, [mapLoaded, epmData, epmYear, showExtZones]);

  // Ext corridors carry a capacity per year, like the internal ones, so they follow the
  // year selector instead of staying frozen at the first year of the table.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !epmData || mapLoaded === 0 || !source(map, 'ext-ntc-lines')) return;
    updateExtZoneData(map, buildExtZoneData(epmData.zonesExtGJ, epmData.extNtc || [],
      zoneCentroidsRef.current, epmYear, { off: epmData.extExchangeOff }));
  }, [mapLoaded, epmData, epmYear]);

  // Basemap switcher
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    swapBasemap(map, basemap, theme);
    if (basemap !== 'satellite') toggleSatLabels(map, false, theme);
  }, [basemap, theme]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || basemap !== 'satellite') return;
    toggleSatLabels(map, satLabels, theme);
  }, [satLabels, basemap, theme]);

  // Pie donut markers — re-render on pieMode toggle or after map loads
  useEffect(() => {
    if (!mapRef.current || !epmData || mapLoaded === 0) return;
    const tv = getT(theme);
    const zcmapRows = epmData.zcmap;
    const zoneToCountry = Object.fromEntries(zcmapRows.map(r => [r.z, r.c]));

    donutMarkersRef.current.forEach(m => m.remove());
    donutMarkersRef.current = [];

    if (pieMode === 'none') return;

    const activeGen = genForYear(epmData.gen, epmYear);
    if (pieMode === 'zone') {
      for (const { z, c } of zcmapRows) {
        const coord = zoneCentroidsRef.current[z];
        if (!coord) continue;
        const fuelMix = {};
        for (const r of activeGen.filter(g => g.zone === z))
          fuelMix[r.fuel] = (fuelMix[r.fuel] || 0) + r.capacity;
        if (!Object.keys(fuelMix).length) continue;
        const el = document.createElement('div');
        el.style.cursor = 'pointer';
        el.innerHTML = makeDonutSVG(fuelMix, tv, 48);
        el.addEventListener('click', () => navigate(`/region/${regionId}/country/${encodeURIComponent(c)}`));
        const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat(coord).addTo(mapRef.current);
        donutMarkersRef.current.push(marker);
      }
    } else {
      const countryGen = {};
      for (const r of activeGen) {
        const c = zoneToCountry[r.zone] || r.zone;
        if (!countryGen[c]) countryGen[c] = {};
        countryGen[c][r.fuel] = (countryGen[c][r.fuel] || 0) + r.capacity;
      }
      for (const [c, fuelMix] of Object.entries(countryGen)) {
        const coord = countryCentroidsRef.current[c];
        if (!coord) continue;
        const el = document.createElement('div');
        el.style.cursor = 'pointer';
        el.innerHTML = makeDonutSVG(fuelMix, tv);
        el.addEventListener('click', () => navigate(`/region/${regionId}/country/${encodeURIComponent(c)}`));
        const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat(coord).addTo(mapRef.current);
        donutMarkersRef.current.push(marker);
      }
    }
  }, [pieMode, mapLoaded, theme, epmYear, epmData]); // eslint-disable-line react-hooks/exhaustive-deps

  // NTC map update when year changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !epmData || mapLoaded === 0) return;
    if (!source(map, 'ntc-lines')) return;
    const ntcYrs = availableYears(epmData.ntc);
    const yr = epmYear
      || ntcYrs.find(y => epmData.ntc.some(r => (r.years[y] || 0) > 0))
      || ntcYrs[0] || '2024';
    // Output-only corridors fill in lines a run built; a pair pNewTransmission
    // declares is drawn as planned or candidate instead, never twice.
    const inputKeys = new Set([...epmData.ntc, ...(epmData.newTx || [])].map(r => [r.z, r.z2].sort().join('||')));
    const allNtc = [...epmData.ntc, ...outputNtc.filter(r => !inputKeys.has([r.z, r.z2].sort().join('||')))];
    const seen = new Set();
    const features = allNtc
      .filter(r => {
        const key = [r.z, r.z2].sort().join('||');
        if (seen.has(key)) return false;
        seen.add(key);
        return (r.years[yr] || 0) > 0
          && zoneCentroidsRef.current[r.z] && zoneCentroidsRef.current[r.z2];
      })
      .map(r => ({
        type: 'Feature',
        properties: { z: r.z, z_other: r.z2, ntc_mw: r.years[yr] || 0 },
        geometry: { type: 'LineString', coordinates: [zoneCentroidsRef.current[r.z], zoneCentroidsRef.current[r.z2]] },
      }));
    source(map, 'ntc-lines').setData({ type: 'FeatureCollection', features });
  }, [epmYear, mapLoaded, epmData, outputNtc]); // eslint-disable-line react-hooks/exhaustive-deps

  // Plant source hot-swap (OSM mode only)
  useEffect(() => {
    const map = mapRef.current;
    if (!source(map, 'plants')) return;
    const suffix = plantSource === 'gppd' ? '_gppd' : plantSource === 'gem' ? '_gem' : '';
    const f  = `region_plants_${regionId}${suffix}.geojson`;
    const cf = `region_capacity_${regionId}${suffix}.json`;
    fetch(dataPath(`cache/${f}`))
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(data => {
        source(map, 'plants').setData(data);
        const fuels = new Set(data.features.map(f => f.properties.fuel).filter(f => FUEL_COLORS[f]));
        setPresentFuels(fuels);
        return fetch(dataPath(`cache/${cf}`)).then(r => r.json());
      })
      .then(setCapacity)
      .catch(() => {
        if (plantSource === 'gppd') { setGppdAvailable(false); setPlantSource('osm'); }
        if (plantSource === 'gem')  { setGemAvailable(false);  setPlantSource('osm'); }
      });
  }, [plantSource, regionId]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (!region) return <div style={{ padding: 40, color: t.text }}>Loading…</div>;

  const isEpmMode = !!(region.epm && epmData && (epmData.linestringGJ || epmData.zonesGJ));
  const showMap   = !region.epm || isEpmMode;

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 46px)' }}
      onMouseMove={e=>{ if(!isDrRef.current)return; setPanelWidth(w=>Math.max(380,drStartW.current+(drStartX.current-e.clientX))); }}
      onMouseUp={()=>{isDrRef.current=false;}} onMouseLeave={()=>{isDrRef.current=false;}}
    >

      {/* Map */}
      {showMap && (
        <div style={{ position: 'relative', flex: 1 }}>
          <div ref={containerRef}
            style={{ width: '100%', height: 'calc(100vh - 46px)', backgroundColor: t.bg }} />
            <MapDownload mapRef={mapRef} t={t} name={()=>ttl(`${region?.name||'Region'} map`,epmYear)}/>

          {/* Basemap controls */}
          <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 10, display: 'flex', gap: 4, alignItems: 'center' }}>
            {[{ id: 'minimal', label: 'Map' }, { id: 'labeled', label: 'Labels' }, { id: 'satellite', label: 'Sat' }]
              .map(({ id, label }) => {
                const active = (basemap || 'minimal') === id;
                return (
                  <button key={id} onClick={() => setBasemap(id)} style={{
                    fontSize: '0.52rem', letterSpacing: '0.5px', fontFamily: 'inherit',
                    padding: '4px 8px', borderRadius: 5, cursor: 'pointer',
                    border: `1px solid ${active ? 'rgba(74,143,204,0.6)' : t.panelBorder}`,
                    backgroundColor: active ? 'rgba(74,143,204,0.14)' : t.panel,
                    color: active ? t.lbl : t.lblMuted,
                    boxShadow: '0 1px 4px rgba(0,0,0,.18)', transition: 'all 0.15s',
                  }}>{label}</button>
                );
              })}
          </div>

          {/* EPM map badge + pie mode toggle */}
          {isEpmMode && (
            <div style={{ position: 'absolute', bottom: 10, left: 10, zIndex: 10, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ fontSize: '0.46rem', color: t.lblMuted, backgroundColor: t.panel,
                border: `1px solid ${t.panelBorder}`, borderRadius: 4, padding: '3px 7px',
                display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>EPM zones + NTC · {epmData.ntc.length} corridors</span>
                <a href={`https://htmlpreview.github.io/?https://raw.githubusercontent.com/ESMAP-World-Bank-Group/EPM/${region.epm.branch}/epm/input/${activeFolder ?? region.epm.dataFolder}/DATA_SOURCES.html`}
                  target="_blank" rel="noreferrer"
                  style={{ color: t.lbl, fontWeight: 600, textDecoration: 'none', opacity: 0.7,
                    borderLeft: `1px solid ${t.panelBorder}`, paddingLeft: 6 }}
                  title="View detailed data sources">
                  Sources ↗
                </a>
              </div>
              <div style={{ display: 'flex', gap: 2, backgroundColor: t.panel,
                border: `1px solid ${t.panelBorder}`, borderRadius: 4, padding: 2 }}>
                {['none', 'country', 'zone'].map(mode => (
                  <button key={mode} onClick={() => setPieMode(mode)} style={{
                    fontSize: '0.46rem', fontFamily: 'inherit', cursor: 'pointer',
                    padding: '2px 7px', borderRadius: 3, border: 'none',
                    backgroundColor: pieMode === mode ? 'rgba(74,143,204,0.2)' : 'transparent',
                    color: pieMode === mode ? t.lbl : t.lblMuted,
                    fontWeight: pieMode === mode ? 700 : 400,
                  }}>
                    {mode === 'none' ? 'Off' : mode === 'country' ? 'By country' : 'By zone'}
                  </button>
                ))}
              </div>
              <LineKindToggles t={t} epmData={epmData} value={lineKinds}
                onToggle={k => setLineKinds(v => ({ ...v, [k]: !v[k] }))} />
              {epmData.extNtc?.length > 0 && epmData.zonesExtGJ && (
                <button onClick={() => setShowExtZones(v => !v)} style={{
                  fontSize: '0.46rem', fontFamily: 'inherit', cursor: 'pointer',
                  padding: '3px 8px', borderRadius: 4,
                  border: `1px solid ${showExtZones ? 'rgba(136,136,136,0.6)' : t.panelBorder}`,
                  backgroundColor: showExtZones ? 'rgba(136,136,136,0.14)' : t.panel,
                  color: showExtZones ? t.lbl : t.lblMuted,
                  fontWeight: showExtZones ? 700 : 400,
                  transition: 'all 0.15s',
                }}>
                  Ext. zones
                </button>
              )}
              {zcmapList.length > 1 && (
                <div style={{ display:'flex', gap:3, alignItems:'center', backgroundColor:t.panel,
                  border:`1px solid ${t.panelBorder}`, borderRadius:4, padding:'3px 7px', fontSize:'0.46rem' }}>
                  <span style={{ color:t.lblMuted }}>Zone map:</span>
                  {zcmapList.map(zc => (
                    <button key={zc} onClick={()=>setActiveZcmap(zc)} style={{
                      fontFamily:'inherit', fontSize:'0.46rem', padding:'1px 6px', borderRadius:3,
                      border:`1px solid ${activeZcmap===zc ? t.lbl : t.panelBorder}`,
                      backgroundColor: activeZcmap===zc ? t.lbl : 'transparent',
                      color: activeZcmap===zc ? t.panel : t.lblMuted, cursor:'pointer',
                    }}>{zc}</button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Drag handle */}
      {showMap && <div style={{width:5,flexShrink:0,cursor:'col-resize'}} onMouseDown={e=>{isDrRef.current=true;drStartX.current=e.clientX;drStartW.current=panelWidth;e.preventDefault();}}/>}

      {/* Right panel */}
      <div style={{
        zoom,
        width: unzoom(showMap ? panelWidth : '100%', zoom),
        maxWidth: unzoom(showMap ? panelWidth : 800, zoom),
        margin: showMap ? 0 : '0 auto',
        height: unzoom('calc(100vh - 46px)', zoom), overflowY: 'auto',
        padding: '18px 16px',
        backgroundColor: t.panel, borderLeft: showMap ? `1px solid ${t.panelBorder}` : 'none',
        flexShrink: 0,
      }}>
        <PanelZoomControl t={t} zoom={zoom} inc={inc} dec={dec} reset={reset}/>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
          <Link to="/" style={{ fontSize: '0.75rem', color: t.muted }}>World</Link>
          <span style={{ color: t.panelBorder, fontSize: '0.75rem' }}>/</span>
          <span style={{ fontSize: '0.75rem', color: t.lbl, fontWeight: 600 }}>{region.name}</span>
        </div>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: t.text, marginBottom: 4 }}>
          {region.name}
        </h2>
        <p style={{ fontSize: '0.8rem', color: t.muted, marginBottom: 16 }}>
          {region.countries.length} countries
        </p>
        <div style={{ height: 3, borderRadius: 2, backgroundColor: region.color, width: 36, marginBottom: 20 }} />

        {/* Data folder selector */}
        {autoFolders?.length > 1 && (
          <div style={{ marginBottom:12, display:'flex', alignItems:'center', gap:6, fontSize:'0.5rem', color:t.lblMuted }}>
            <span>Data folder:</span>
            <select value={activeFolder ?? ''} onChange={e=>handleFolderChange(e.target.value)}
              style={{ fontSize:'0.5rem', fontFamily:'inherit', padding:'2px 6px', borderRadius:3,
                border:`1px solid ${t.panelBorder}`, backgroundColor:t.panel, color:t.lbl, cursor:'pointer' }}>
              {autoFolders.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </div>
        )}

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 2, marginBottom: 14, flexWrap: 'wrap' }}>
          {[['Overview','overview'], ['Demand','demand'], ['Supply','supply'], ['Resources','resources'],
            ['Trade','trade'], ['Scenarios','scenarios'], ['Raw data','raw'], ['About','about']].map(([tab, key]) => {
            const active = activeTab === key;
            return (
              <button key={tab} onClick={() => setActiveTab(key)} style={{
                flex: '1 1 auto', fontSize: '0.55rem', letterSpacing: '0.8px',
                textTransform: 'uppercase', fontFamily: 'inherit',
                padding: '4px 6px', borderRadius: 4, cursor: 'pointer',
                border: `1px solid ${active ? t.lbl : t.panelBorder}`,
                backgroundColor: active ? 'rgba(128,160,192,0.12)' : 'transparent',
                color: active ? t.lbl : t.lblMuted,
                fontWeight: active ? 700 : 400,
              }}>{tab}</button>
            );
          })}
        </div>

        {/* Tab content */}
        {activeTab === 'overview' && (
          !region.epm  ? <NotAvailable t={t} /> :
          epmLoading   ? <LoadingBox t={t} /> :
          epmData      ? <EpmOverviewTab t={t} epmData={epmData} region={region} epmYear={epmYear} setEpmYear={setEpmYear} /> :
                         <NotAvailable t={t} />
        )}
        {activeTab === 'supply' && (
          !region.epm  ? <NotAvailable t={t} /> :
          epmLoading   ? <LoadingBox t={t} /> :
          epmData      ? <EpmSupplyTab t={t} epmData={epmData} region={region}
                           scnMeta={scnMeta} varOverrides={varOverrides} setVariant={setVariant} /> :
                         <NotAvailable t={t} />
        )}
        {activeTab === 'demand' && (
          <DemandTab t={t} epmData={epmData} epmLoading={epmLoading} hasEpm={!!region.epm} region={region}
            scnMeta={scnMeta} varOverrides={varOverrides} setVariant={setVariant} setEpmYear={setEpmYear} />
        )}
        {activeTab === 'resources' && (
          <ResourcesTab t={t} epmData={epmData} epmLoading={epmLoading} hasEpm={!!region.epm}
            scnMeta={scnMeta} varOverrides={varOverrides} setVariant={setVariant}
            availZone={availZone} setAvailZone={setAvailZone}
            section={resourceSection} setSection={setResourceSection} />
        )}
        {activeTab === 'scenarios' && (
          <ScenarioTab t={t} scnMeta={scnMeta} docs={scenarioDocIndex(scnDocs, scnMeta?.scenarios || [])} />
        )}
        {activeTab === 'trade' && (
          <TradeTab t={t} epmData={epmData} epmLoading={epmLoading} hasEpm={!!region.epm} region={region}
            scnMeta={scnMeta} varOverrides={varOverrides} setVariant={setVariant} setEpmYear={setEpmYear} />
        )}
        {activeTab === 'raw' && (
          !region.epm ? <NotAvailable t={t} /> :
          scnMeta === undefined ? <LoadingBox t={t} /> :
          <RawInputsTab t={t} region={region} scnMeta={scnMeta} activeFolder={activeFolder}
            docs={scenarioDocIndex(scnDocs, scnMeta?.scenarios || [])} />
        )}
        {activeTab === 'about' && (
          <AboutTab region={region} t={t} epmData={epmData} epmLoading={epmLoading}
            activeFolder={activeFolder} />
        )}
      </div>
    </div>
  );
}
