import { useEffect, useRef, useState, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import { track } from '../analytics';
import { useTheme } from '../App';
import { getT } from '../constants';
import {
  fetchEpmCSV, fetchLinestringGeoJSON, fetchZonesGeoJSON, fetchZonesExtGeoJSON, fetchZonesOffgridGeoJSON, fetchZcmapList, fetchDataFolderList,
  fetchRunList, fetchGitHubDir, fetchResultCSV, resolveOutputDir,
  processGenData, processDemand, processDemandData, processNTC, processExtNTC, processTransmissionResults,
  processDemandProfileFull, processVREProfile, processAvailability, processFuelPrice, processHours, processTimeSlices,
  availableYears, EPM_FUEL_COLORS, normalizeFuel,
} from '../utils/epmFetch';
import { buildTimeAxis, buildSeasonAxis, blockLabels, axisTicks, bandingPlugin, dayWeights } from '../utils/timeAxis';
import { buildExtZoneData, addExtZoneLayers, bindExtZoneHandlers, updateExtZoneData, setExtZonesVisible } from '../utils/extZones';
import { addOffgridLayers } from '../utils/offgridZones';
import { fetchScenarioConfig, resolveFile, baseName } from '../utils/epmScenarios';
import { zoneCentroidMap } from '../utils/centroids';
import VariantPicker from '../components/VariantPicker';
import { fetchCountries, fetchBoundaries, addCountriesSource, addBoundariesSource, raiseBoundaries } from '../utils/basemap';
import { buildWbStyle, useWbStyleBase, ZONE_MAP_VIEW, MAP_LABEL_FONT } from '../utils/wbStyle';
import { source } from '../utils/mapSource';
import { usePromotedEpmData } from '../utils/usePromotedZones';
import CJChart from '../components/CJChart';
import MapDownload from '../components/MapDownload';
import { ttl } from '../utils/chartTitle';
import PanelZoomControl, { usePanelZoom, unzoom } from '../components/PanelZoom';
import { dataPath } from '../utils/paths';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAP_PALETTE = [
  '#1B6CA8','#36B5B5','#E8C547','#4DA6FF',
  '#0D7680','#85C1E9','#2E9EC8','#5EBCBA',
  '#1A5276','#7EC8E3','#14A094','#4CAFE8',
  '#EDD770','#AED6F1','#1F618D','#0A6B70',
];
const CHART_PALETTE = [
  '#3B82F6','#10B981','#F59E0B','#8B5CF6',
  '#06B6D4','#EC4899','#84CC16','#F97316',
  '#6366F1','#14B8A6','#A855F7','#EAB308',
  '#22D3EE','#FB7185','#2DD4BF','#818CF8',
];
const ZONE_PALETTE = CHART_PALETTE;
const STATUS_COLOR  = { 1: '#52C860', 2: '#FFD700', 3: '#9A9EF5' };
const STATUS_LABEL  = { 1: 'Existing', 2: 'Committed', 3: 'Candidate' };
const RE_FUELS      = new Set(['hydro','solar','wind','biomass','geothermal','biogas','waste']);
const VRE_DISPLAY  = { pv:'Solar PV', solar:'Solar PV', onshorewind:'Onshore Wind', wind:'Wind', offshorewind:'Offshore Wind', ror:'Run-of-River', rof:'Run-of-River' };
const VRE_COLOR    = { pv:'#FFD700', solar:'#FFD700', onshorewind:'#44DAEC', wind:'#44DAEC', offshorewind:'#7CC8FA', ror:'#1E9AF5', rof:'#1E9AF5' };

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n, d = 0) {
  if (n == null || isNaN(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: d });
}
function hexA(hex, a) {
  if (!hex || hex.length < 7) return `rgba(128,128,128,${a})`;
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}
function cjDefaults(t) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { backgroundColor: t.panel, borderColor: t.panelBorder, borderWidth: 1,
        titleColor: t.lbl, bodyColor: t.muted, titleFont: { size: 9 }, bodyFont: { size: 9 }, padding: 6 },
    },
    scales: {
      x: { grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 9 } } },
      y: { grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 9 } } },
    },
  };
}
function sumObj(obj) { return Object.values(obj || {}).reduce((s, v) => s + v, 0); }
function avgProfile(profiles) {
  if (!profiles.length) return null;
  return Array.from({ length: profiles[0]?.length || 24 }, (_, i) => profiles.reduce((s, p) => s + (p[i] || 0), 0) / profiles.length);
}
function makeDonutSVG(fuelMix, tv, size = 48) {
  const cx = size / 2, cy = size / 2, r = size / 2 - 9, sw = 7;
  const entries = Object.entries(fuelMix).filter(([, v]) => v > 0);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (total === 0) return '';
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
  const totalGW = total / 1000;
  const label = totalGW >= 1 ? totalGW.toFixed(1) : total.toFixed(0);
  const unit  = totalGW >= 1 ? 'GW' : 'MW';
  const bg = tv.isDark ? 'rgba(20,20,20,0.82)' : 'rgba(255,255,255,0.88)';
  const tc = tv.isDark ? '#fff' : '#111';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <circle cx="${cx}" cy="${cy}" r="${r + sw/2 + 1}" fill="${bg}" stroke="rgba(0,0,0,0.18)" stroke-width="0.5"/>
    ${arcs.join('')}
    <text x="${cx}" y="${cy - 1}" text-anchor="middle" font-size="8" font-weight="700" fill="${tc}" font-family="'Open Sans', system-ui, sans-serif">${label}</text>
    <text x="${cx}" y="${cy + 8}" text-anchor="middle" font-size="6.5" fill="${tc}" font-family="'Open Sans', system-ui, sans-serif" opacity="0.65">${unit}</text>
  </svg>`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionTitle({ t, children, right }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
      <div style={{ fontSize: '0.47rem', letterSpacing: '2px', fontWeight: 700,
        color: t.lblMuted, textTransform: 'uppercase' }}>{children}</div>
      {right}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

// NTC line features (shared by the map build + the in-place data-update effect).
function buildNtcFeatures(epmData, zoneCentroids, countryZones, linestringGJ, outputNtc = [], year = null) {
  const inputKeys = new Set(epmData.ntc.map(r => [r.z, r.z2].sort().join('||')));
  const allNtc = [...epmData.ntc, ...outputNtc.filter(r => !inputKeys.has([r.z, r.z2].sort().join('||')))];
  const ntcYrs = availableYears(allNtc);
  const ntcYr  = year || ntcYrs[0] || '2024';
  const seen = new Set();
  if (Object.keys(zoneCentroids).length > 0) {
    return allNtc
      .filter(r => { const key = [r.z, r.z2].sort().join('||'); if (seen.has(key)) return false; seen.add(key);
        return (r.years[ntcYr] || 0) > 0 && zoneCentroids[r.z] && zoneCentroids[r.z2]; })
      .map(r => ({ type: 'Feature',
        properties: { z: r.z, z_other: r.z2, ntc_mw: r.years[ntcYr] || 0, isCountry: countryZones.includes(r.z) || countryZones.includes(r.z2) },
        geometry: { type: 'LineString', coordinates: [zoneCentroids[r.z], zoneCentroids[r.z2]] } }));
  }
  if (linestringGJ) {
    return linestringGJ.features
      .filter(f => { const { z, z_other } = f.properties; if (!z || !z_other) return false;
        const key = [z, z_other].sort().join('||'); if (seen.has(key)) return false; seen.add(key);
        const entry = allNtc.find(r => (r.z === z && r.z2 === z_other) || (r.z === z_other && r.z2 === z));
        return (entry?.years[ntcYr] || 0) > 0; })
      .map(f => { const { z, z_other } = f.properties;
        const entry = allNtc.find(r => (r.z === z && r.z2 === z_other) || (r.z === z_other && r.z2 === z));
        return { ...f, properties: { ...f.properties, ntc_mw: entry?.years[ntcYr] || 0,
          isCountry: countryZones.includes(z) || countryZones.includes(z_other) } }; });
  }
  return [];
}

export default function EpmCountryPage() {
  const { regionId, countryName } = useParams();
  const countryNameDecoded = decodeURIComponent(countryName);
  const { theme } = useTheme();
  const wbBase = useWbStyleBase();
  const t = getT(theme);
  const navigate = useNavigate();

  const containerRef    = useRef(null);
  const mapRef          = useRef(null);
  const donutMarkersRef = useRef([]);
  const zoneCentroidsRef = useRef({});
  const countryZonesRef  = useRef([]);

  // ── Core state ──────────────────────────────────────────────────────────────
  const [region,       setRegion]       = useState(null);
  const [epmDataRaw,      setEpmData]      = useState(null);

  // Zones this region asked to be shown as external, moved across the line before any
  // of the code below sees them (utils/zoneClass). For every other region this hands
  // the raw object straight back.
  const epmData = usePromotedEpmData(region, epmDataRaw);

  const [loading,      setLoading]      = useState(false);
  const [activeTab,    setActiveTab]    = useState('overview');
  const [activeFolder, setActiveFolder] = useState(null);
  const [activeZcmap,  setActiveZcmap]  = useState(null);
  const [autoFolders,  setAutoFolders]  = useState(null);
  const [outputNtc,    setOutputNtc]    = useState([]);
  const [epmYear,      setEpmYear]      = useState(null);

  // ── Scenario / variant state ─────────────────────────────────────────────────
  const [scnMeta,      setScnMeta]      = useState(undefined);   // parsed config.csv + scenarios.csv
  const [varOverrides, setVarOverrides] = useState({});     // { paramName: variantFile }
  const [scnFilter,    setScnFilter]    = useState('');     // scenario-tab search box
  const setVariant = (param, file) => setVarOverrides(o => {
    const next = { ...o };
    if (file) next[param] = file; else delete next[param];
    return next;
  });

  // ── Overview state ──────────────────────────────────────────────────────────
  const [mixView, setMixView] = useState('zone'); // 'zone' | 'country'

  // ── Demand state ────────────────────────────────────────────────────────────
  const [demandSeg,         setDemandSeg]         = useState('aggregate');
  const [demandProfileMode, setDemandProfileMode] = useState('full');
  const [demandSeason,      setDemandSeason]      = useState('Q1');
  const [demandDay,         setDemandDay]         = useState('avg');
  const [demandHidden,      setDemandHidden]      = useState(new Set());

  // ── Supply state ────────────────────────────────────────────────────────────
  const [statusFilter,  setStatusFilter]  = useState(new Set([1]));
  const [hiddenFuels,   setHiddenFuels]   = useState(new Set());
  const [supplySort,    setSupplySort]    = useState({ col: 'capacity', dir: 'desc' });
  const [selectedPlant, setSelectedPlant] = useState(null);

  // ── Resources state ─────────────────────────────────────────────────────────
  const [resSection,    setResSection]    = useState('vre');
  const [vreTech,       setVreTech]       = useState('');
  const [vreProfileMode, setVreProfileMode] = useState('full');
  const [vreSeason,     setVreSeason]     = useState('Q1');
  const [vreDay,        setVreDay]        = useState('avg');
  const [vreHidden,     setVreHidden]     = useState(new Set());
  const [fpCountries,   setFpCountries]   = useState(null); // null = all
  const [availZone,     setAvailZone]     = useState('all');
  const [selZone,       setSelZone]       = useState('all');
  const [mapLoadedCount,setMapLoadedCount]= useState(0);
  const [showDonuts,    setShowDonuts]    = useState(true);
  const [showExtZones,  setShowExtZones]  = useState(true);
  const showExtRef = useRef(true);

  // ── Load region ─────────────────────────────────────────────────────────────
  useEffect(() => {
    track('country_view', { region: regionId, country: countryNameDecoded });
    fetch(dataPath('regions.json')).then(r => r.json()).then(d => {
      const r = (d.regions || []).find(r => r.id === regionId);
      setRegion(r || null);
    });
  }, [regionId, countryNameDecoded]);

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

  // ── Load scenario definitions (config.csv + scenarios.csv) ────────────────────
  // scnMeta is tri-state: undefined while loading, null when no config is
  // reachable, object once parsed. The data effect below waits for it, so no
  // fetch fires against the fallback paths and then again against the real ones.
  useEffect(() => {
    setScnMeta(undefined);
    setVarOverrides({});
    setScnFilter('');
    if (!region?.epm || !activeFolder) return;
    const { branch, scenariosFile, configFile } = region.epm;
    fetchScenarioConfig(branch, activeFolder, { scenariosFile, configFile })
      .then(m => setScnMeta(m || null))
      .catch(() => setScnMeta(null));
  }, [region, activeFolder]);

  // ── Load EPM data ────────────────────────────────────────────────────────────
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
    // Blank + loading ONLY on region/folder change. Variant/zcmap changes swap in-place.
    if (regionOrFolderChanged) { setEpmData(null); setLoading(true); }
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
    ]).then(([genRaw, demandRaw, ntcRaw, zcmapRaw, linestringGJ, profileRaw, zonesGJ, vreRaw, availRaw, fpRaw, hoursRaw, zonesExtGJ, extNtcRaw, demandDataRaw, offgridGJ]) => {
      setEpmData(prev => ({
        gen:              genRaw     ? processGenData(genRaw)              : [],
        // Folders with a full load table instead of a forecast (v7.9 style) fall back to pDemandData
        demand:           demandRaw?.length ? processDemand(demandRaw)
                                            : processDemandData(demandDataRaw, hoursRaw),
        ntc:              ntcRaw     ? processNTC(ntcRaw)                  : [],
        zcmap:            zcmapRaw   || [],
        demandProfileFull: profileRaw ? processDemandProfileFull(profileRaw) : {},
        vreProfile:        vreRaw    ? processVREProfile(vreRaw)           : {},
        availability:      availRaw  ? processAvailability(availRaw)       : {},
        fuelPrice:         fpRaw     ? processFuelPrice(fpRaw)             : {},
        hours:             hoursRaw  ? processHours(hoursRaw)              : {},
        // 24 for a chronological model, 6-7 for a load-block one (see processTimeSlices)
        timeSlices:        hoursRaw  ? processTimeSlices(hoursRaw)         : {nT:24,isHourly:true,hours:{}},
        extNtc:            extNtcRaw ? processExtNTC(extNtcRaw)            : [],
        // Preserve geojson on variant-only change (no region/folder/zcmap change).
        linestringGJ: (regionOrFolderChanged || zcmapChanged || !prev) ? linestringGJ : prev.linestringGJ,
        zonesGJ:      (regionOrFolderChanged || zcmapChanged || !prev) ? zonesGJ      : prev.zonesGJ,
        zonesExtGJ:   (regionOrFolderChanged || zcmapChanged || !prev) ? zonesExtGJ   : prev.zonesExtGJ,
        offgridGJ:    (regionOrFolderChanged || zcmapChanged || !prev) ? offgridGJ    : prev.offgridGJ,
        branch,
      }));
    }).finally(() => setLoading(false));
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

  // NTC year update — runs when user clicks a year on a chart
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !epmData || !source(map, 'ntc-lines')) return;
    const features = buildNtcFeatures(epmData, zoneCentroidsRef.current, countryZonesRef.current, epmData.linestringGJ, outputNtc, epmYear);
    source(map, 'ntc-lines').setData({ type: 'FeatureCollection', features });
  }, [epmYear, epmData, outputNtc]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Map ──────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || !region || !epmData || !wbBase) return;
    const { linestringGJ, zonesGJ } = epmData;
    if (!linestringGJ && !zonesGJ) return;

    const zcmapRows     = epmData.zcmap;
    const zoneToCountry = Object.fromEntries(zcmapRows.map(r => [r.z, r.c]));
    const countryZones  = zcmapRows.filter(r => r.c === countryNameDecoded).map(r => r.z);
    const countryIsos   = zonesGJ
      ? [...new Set(zonesGJ.features
          .filter(f => countryZones.includes(f.properties.z))
          .map(f => f.properties.ISO_A3))]
      : [];

    const zoneCentroids = zoneCentroidMap(zonesGJ, linestringGJ);
    // Expose for the in-place donut / NTC update effects (no map rebuild needed).
    zoneCentroidsRef.current = zoneCentroids;
    countryZonesRef.current  = countryZones;

    const countryCoords = countryZones.flatMap(z => zoneCentroids[z] ? [zoneCentroids[z]] : []);
    const lons = countryCoords.map(c => c[0]);
    const lats = countryCoords.map(c => c[1]);
    const bounds = lons.length
      ? [[Math.min(...lons) - 2, Math.min(...lats) - 2], [Math.max(...lons) + 2, Math.max(...lats) + 2]]
      : null;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildWbStyle(wbBase, getT(theme), ZONE_MAP_VIEW),
      center: [lons.length ? lons.reduce((a,b)=>a+b,0)/lons.length : 20,
               lats.length ? lats.reduce((a,b)=>a+b,0)/lats.length : 0],
      zoom: 4, minZoom: 1, maxZoom: 14, canvasContextAttributes: { preserveDrawingBuffer: true }, attributionControl: false,
    });
    mapRef.current = map;
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10,
      className: `popup-${theme}` });

    map.on('load', async () => {
      const tv = getT(theme);
      if (bounds) map.fitBounds(bounds, { padding: 60, duration: 0, maxZoom: 8 });

      const countries = await fetchCountries('10m');
      const boundaries = await fetchBoundaries('10m');
      addCountriesSource(map, countries);
      addBoundariesSource(map, boundaries);

      if (zonesGJ) {
        const regionCountries = [...new Set(zcmapRows.map(r => r.c))].sort();
        const countryColorMap = {};
        regionCountries.forEach((c, i) => { countryColorMap[c] = MAP_PALETTE[i % MAP_PALETTE.length]; });
        const isoToCountry = {};
        for (const f of zonesGJ.features) isoToCountry[f.properties.ISO_A3] = f.properties.c;
        const regionIsos = [...new Set(zonesGJ.features.map(f => f.properties.ISO_A3))];
        const fillExpr = ['match', ['get', 'ISO_A3'],
          ...regionIsos.flatMap(iso => [iso, countryColorMap[isoToCountry[iso]] || '#888']), 'transparent'];

        map.addSource('zones', { type: 'geojson', data: zonesGJ, generateId: true });
        map.addLayer({ id: 'zone-fill-dim', type: 'fill', source: 'zones',
          filter: ['!', ['in', ['get', 'ISO_A3'], ['literal', countryIsos]]],
          paint: { 'fill-color': fillExpr, 'fill-opacity': 0.08 } });
        map.addLayer({ id: 'zone-border-dim', type: 'line', source: 'zones',
          filter: ['!', ['in', ['get', 'ISO_A3'], ['literal', countryIsos]]],
          paint: { 'line-color': fillExpr, 'line-width': 0.6, 'line-opacity': 0.25 } });
        map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zones',
          filter: ['in', ['get', 'ISO_A3'], ['literal', countryIsos]],
          paint: { 'fill-color': fillExpr, 'fill-opacity': 0.35 } });
        map.addLayer({ id: 'zone-hover', type: 'fill', source: 'zones',
          filter: ['==', ['get', 'z'], ''], paint: { 'fill-color': fillExpr, 'fill-opacity': 0.60 } });
        map.addLayer({ id: 'zone-selected', type: 'fill', source: 'zones',
          filter: ['==', ['get', 'z'], '__none__'], paint: { 'fill-color': fillExpr, 'fill-opacity': 0.45 } });
        map.addLayer({ id: 'zone-selected-border', type: 'line', source: 'zones',
          filter: ['==', ['get', 'z'], '__none__'], paint: { 'line-color': 'rgba(255,255,255,0.9)', 'line-width': 2.5 } });
        map.addLayer({ id: 'zone-border', type: 'line', source: 'zones',
          filter: ['in', ['get', 'ISO_A3'], ['literal', countryIsos]],
          paint: { 'line-color': fillExpr, 'line-width': 1.5, 'line-opacity': 0.9 } });

        let hovZ = null;
        map.on('mousemove', 'zone-fill', e => {
          map.getCanvas().style.cursor = 'pointer';
          const z = e.features[0].properties.z;
          if (z !== hovZ) { hovZ = z; map.setFilter('zone-hover', ['==', ['get', 'z'], z]); }
          popup.setLngLat(e.lngLat)
            .setHTML(`<b>${z}</b><br><span style="opacity:.65;font-size:0.7em">click to select / deselect</span>`)
            .addTo(map);
        });
        map.on('mouseleave', 'zone-fill', () => {
          map.getCanvas().style.cursor = '';
          hovZ = null; map.setFilter('zone-hover', ['==', ['get', 'z'], '']); popup.remove();
        });
        map.on('click', 'zone-fill', e => {
          const z = e.features[0].properties.z || '';
          setSelZone(prev => {
            const next = prev === z ? 'all' : z;
            const f = next === 'all' ? '__none__' : next;
            try { map.setFilter('zone-selected', ['==', ['get', 'z'], f]); map.setFilter('zone-selected-border', ['==', ['get', 'z'], f]); } catch(err) {}
            return next;
          });
          setSelectedPlant(null);
        });
      }

      {
        const ntcFeatures = buildNtcFeatures(epmData, zoneCentroids, countryZones, linestringGJ, outputNtc);
        if (ntcFeatures.length > 0) {
          map.addSource('ntc-lines', { type:'geojson', data:{type:'FeatureCollection',features:ntcFeatures} });
          map.addLayer({ id:'ntc-lines-bg', type:'line', source:'ntc-lines',
            paint:{'line-color':'#f0b030','line-width':0.8,'line-opacity':0.25} });
          map.addLayer({ id:'ntc-lines-active', type:'line', source:'ntc-lines',
            filter:['==',['get','isCountry'],true], layout:{'line-cap':'round'},
            paint:{'line-color':'#f0b030',
              'line-width':['interpolate',['linear'],['get','ntc_mw'],0,1,500,2,2000,3.5,8000,6],'line-opacity':0.9} });
          map.addLayer({ id:'ntc-labels', type:'symbol', source:'ntc-lines',
            filter:['==',['get','isCountry'],true],
            layout:{'text-font':MAP_LABEL_FONT,'text-field':['concat',['to-string',['round',['get','ntc_mw']]],' MW'],
              'text-size':8,'symbol-placement':'line-center','text-allow-overlap':false},
            paint:{'text-color':'#b07800','text-halo-color':'rgba(255,255,255,0.9)','text-halo-width':1.5} });
        }
      }

      // ── Ext NTC zones (polygon- or point-based neighbours) ─────────────────
      {
        const extData = buildExtZoneData(epmData.zonesExtGJ, epmData.extNtc || [], zoneCentroids, epmYear);
        addExtZoneLayers(map, tv, extData, { visible: showExtRef.current });
        bindExtZoneHandlers(map, popup);
      }

      // ── Areas of the modelled countries that belong to no zone ─────────────
      addOffgridLayers(map, tv, epmData.offgridGJ);

      // Donuts + NTC data are drawn / updated in place by the effects below.
      setMapLoadedCount(c => c + 1);
      raiseBoundaries(map);
    });

    return () => {
      popup.remove();
      donutMarkersRef.current.forEach(m => m.remove());
      donutMarkersRef.current = [];
      mapRef.current?.remove();
    };
  }, [region, theme, epmData?.linestringGJ, epmData?.zonesGJ, countryNameDecoded, wbBase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync selZone → map highlight (covers dropdown changes + map reloads)
  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    const f = selZone === 'all' ? '__none__' : selZone;
    try { map.setFilter('zone-selected', ['==', ['get', 'z'], f]); map.setFilter('zone-selected-border', ['==', ['get', 'z'], f]); } catch(e) {}
  }, [selZone, mapLoadedCount]);


  // Donut markers visibility toggle (no map rebuild).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !epmData || mapLoadedCount === 0) return;
    const tv = getT(theme);
    const countryZones = countryZonesRef.current, centroids = zoneCentroidsRef.current;
    donutMarkersRef.current.forEach(m => m.remove());
    donutMarkersRef.current = [];
    if (!showDonuts) return;
    const zoneGen = {};
    for (const r of epmData.gen.filter(g => g.status === 1 && countryZones.includes(g.zone))) {
      if (!zoneGen[r.zone]) zoneGen[r.zone] = {};
      zoneGen[r.zone][r.fuel] = (zoneGen[r.zone][r.fuel] || 0) + r.capacity;
    }
    for (const z of countryZones) {
      const fuelMix = zoneGen[z], coord = centroids[z];
      if (!fuelMix || !coord) continue;
      const el = document.createElement('div');
      el.style.cursor = 'pointer';
      el.innerHTML = makeDonutSVG(fuelMix, tv);
      el.addEventListener('click', () => navigate(`/region/${regionId}/zone/${encodeURIComponent(z)}`));
      donutMarkersRef.current.push(new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(coord).addTo(map));
    }
  }, [mapLoadedCount, epmData, theme, showDonuts]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ext zones visibility toggle. The ref is what the map-load handler reads, so a
  // rebuilt map comes back at the visibility the user left it at.
  useEffect(() => {
    showExtRef.current = showExtZones;
    setExtZonesVisible(mapRef.current, showExtZones);
  }, [showExtZones, mapLoadedCount]);

  // Ext corridors carry a capacity per year, like the internal ones, so they follow the
  // year selector instead of staying frozen at the first year of the table.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !epmData || mapLoadedCount === 0 || !source(map, 'ext-ntc-lines')) return;
    updateExtZoneData(map, buildExtZoneData(epmData.zonesExtGJ, epmData.extNtc || [],
      zoneCentroidsRef.current, epmYear));
  }, [mapLoadedCount, epmData, epmYear]);

  // NTC lines — update MW in place when trade data changes (no map rebuild → no flash).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !epmData || mapLoadedCount === 0 || !source(map, 'ntc-lines')) return;
    const features = buildNtcFeatures(epmData, zoneCentroidsRef.current, countryZonesRef.current, epmData.linestringGJ);
    source(map, 'ntc-lines').setData({ type: 'FeatureCollection', features });
  }, [mapLoadedCount, epmData]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Computed values ───────────────────────────────────────────────────────────

  const zcmapRows      = epmData?.zcmap || [];
  const zoneToCountry  = useMemo(() => Object.fromEntries(zcmapRows.map(r => [r.z, r.c])), [zcmapRows]);
  const countryZoneIds = useMemo(() => zcmapRows.filter(r => r.c === countryNameDecoded).map(r => r.z), [zcmapRows, countryNameDecoded]);
  const visZoneIds     = useMemo(() => selZone==='all' ? countryZoneIds : countryZoneIds.filter(z=>z===selZone), [selZone, countryZoneIds]);
  const allCountries   = useMemo(() => [...new Set(zcmapRows.map(r => r.c))].sort(), [zcmapRows]);

  const allGen        = epmData?.gen || [];
  const countryGen    = useMemo(() => allGen.filter(r => visZoneIds.includes(r.zone)), [allGen, visZoneIds]);
  const existingGen   = useMemo(() => countryGen.filter(r => r.status === 1), [countryGen]);
  const allExisting   = useMemo(() => allGen.filter(r => r.status === 1), [allGen]);

  const totalGW   = existingGen.reduce((s,r)=>s+r.capacity,0) / 1000;
  const reMW      = existingGen.filter(r=>RE_FUELS.has(r.fuel)).reduce((s,r)=>s+r.capacity,0);
  const reShare   = totalGW > 0 ? Math.round(reMW / (totalGW * 1000) * 100) : 0;

  const allYears  = availableYears(epmData?.demand || []);
  const refYr     = allYears.find(y => y === '2024') || allYears[0];

  const countryDemand = useMemo(() => (epmData?.demand||[]).filter(r=>visZoneIds.includes(r.zone)), [epmData, visZoneIds]);
  const peakGW        = countryDemand.filter(r=>r.type==='peak').reduce((s,r)=>s+(r.years[refYr]||0),0)/1000;
  const energyTWh     = countryDemand.filter(r=>r.type==='energy').reduce((s,r)=>s+(r.years[refYr]||0),0)/1000;

  const ntcAll = epmData?.ntc || [];
  const { txGW, nCorridors, uniqueNTC } = useMemo(() => {
    const seen = new Set(); const result = [];
    for (const r of ntcAll) {
      const key = [r.z,r.z2].sort().join('||');
      if (!seen.has(key)) { seen.add(key); result.push(r); }
    }
    const countryCorr = result.filter(r=>countryZoneIds.includes(r.z)||countryZoneIds.includes(r.z2));
    const tx = countryCorr.reduce((s,r)=>s+(r.years[refYr]||0),0)/1000;
    return { txGW: tx, nCorridors: countryCorr.length, uniqueNTC: result };
  }, [ntcAll, countryZoneIds, refYr]);

  // Mix chart data
  const { genByZoneFuel, genByCountryFuel } = useMemo(() => {
    const byZone = {}, byCountry = {};
    for (const r of allExisting) {
      if (!byZone[r.zone]) byZone[r.zone] = {};
      byZone[r.zone][r.fuel] = (byZone[r.zone][r.fuel]||0) + r.capacity;
      const c = zoneToCountry[r.zone] || 'Other';
      if (!byCountry[c]) byCountry[c] = {};
      byCountry[c][r.fuel] = (byCountry[c][r.fuel]||0) + r.capacity;
    }
    return { genByZoneFuel: byZone, genByCountryFuel: byCountry };
  }, [allExisting, zoneToCountry]);

  const FUEL_ORDER = ['hydro','solar','wind','nuclear','gas','coal','oil','biomass','geothermal','diesel','waste','biogas','other'];
  const sortedFuels = useMemo(() => {
    const fuels = new Set([...Object.values(genByZoneFuel).flatMap(Object.keys), ...Object.values(genByCountryFuel).flatMap(Object.keys)]);
    return [...fuels].sort((a,b)=>FUEL_ORDER.indexOf(a)-FUEL_ORDER.indexOf(b));
  }, [genByZoneFuel, genByCountryFuel]); // eslint-disable-line react-hooks/exhaustive-deps

  const fuelAgg = useMemo(() => genByCountryFuel[countryNameDecoded] || {}, [genByCountryFuel, countryNameDecoded]);

  // Supply filtered + sorted
  const demandZones = useMemo(() => [...new Set(countryDemand.map(r=>r.zone))].sort(), [countryDemand]);
  const zoneColors  = useMemo(() => Object.fromEntries(demandZones.map((z,i)=>[z,ZONE_PALETTE[i%ZONE_PALETTE.length]])), [demandZones]);

  const demandCAGR  = useMemo(() => {
    if (allYears.length < 2) return null;
    const firstYr = allYears[0], lastYr = allYears[allYears.length - 1];
    const nYrs = parseInt(lastYr) - parseInt(firstYr);
    if (nYrs <= 0) return null;
    const visRows = r => demandSeg === 'zone' ? !demandHidden.has(r.zone) : true;
    const sum = (type, yr) => countryDemand.filter(r => r.type === type && visRows(r))
      .reduce((s, r) => s + (r.years[yr] || 0), 0);
    const calcCAGR = (type) => {
      const s = sum(type, firstYr), e = sum(type, lastYr);
      return (s > 0 && e > 0) ? (Math.pow(e / s, 1 / nYrs) - 1) * 100 : null;
    };
    return { peak: calcCAGR('peak'), energy: calcCAGR('energy'), firstYr, lastYr };
  }, [countryDemand, allYears, demandSeg, demandHidden]);

  const filteredPlants = useMemo(() => countryGen.filter(r=>statusFilter.has(r.status) && !hiddenFuels.has(r.fuel) && (selZone==='all'||r.zone===selZone)), [countryGen, statusFilter, hiddenFuels, selZone]);
  const sortedPlants   = useMemo(() => {
    const { col, dir } = supplySort;
    return [...filteredPlants].sort((a,b) => {
      let va = a[col], vb = b[col];
      if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return dir === 'asc' ? cmp : -cmp;
    });
  }, [filteredPlants, supplySort]);

  // Trade corridors — deduplicated, must stay before early return
  const tradeCorridors = useMemo(() => {
    const seen = new Set();
    return ntcAll.reduce((acc, r) => {
      const key = [r.z,r.z2].sort().join('||');
      if (seen.has(key)) return acc; seen.add(key);
      const rev = ntcAll.find(x=>x.z===r.z2&&x.z2===r.z);
      acc.push({
        key, z:r.z, z2:r.z2,
        c: zoneToCountry[r.z]||r.z, c2: zoneToCountry[r.z2]||r.z2,
        mwFwd: r.years[refYr]||0, mwRev: rev ? (rev.years[refYr]||0) : 0,
        isCountry: countryZoneIds.includes(r.z)||countryZoneIds.includes(r.z2),
      });
      return acc;
    }, []).sort((a,b)=>b.mwFwd-a.mwFwd);
  }, [ntcAll, zoneToCountry, countryZoneIds, refYr]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasData = !!(epmData && !loading);
  const [panelWidth, setPanelWidth] = useState(680);
  const { zoom, inc, dec, reset } = usePanelZoom();
  const isDrRef = useRef(false); const drStartX = useRef(0); const drStartW = useRef(0);
  if (!region) return <div style={{ padding: 40, color: t.text }}>Loading…</div>;

  // ── Helpers ──────────────────────────────────────────────────────────────────

  const Pill = ({ active, onClick, children, color }) => (
    <button onClick={onClick} style={{
      fontSize: '0.44rem', fontFamily: 'inherit', padding: '3px 8px',
      border: `1px solid ${active ? (color||'rgba(74,143,204,0.65)') : t.panelBorder}`,
      borderRadius: 3, cursor: 'pointer',
      backgroundColor: active ? (color ? hexA(color,0.15) : 'rgba(74,143,204,0.12)') : 'transparent',
      color: active ? (color||t.lbl) : t.lblMuted, fontWeight: active ? 600 : 400,
    }}>{children}</button>
  );

  const handleSort = col => setSupplySort(s => ({
    col, dir: s.col === col && s.dir === 'desc' ? 'asc' : 'desc'
  }));

  const SortBtn = ({ col, label, align }) => (
    <button onClick={() => handleSort(col)} style={{ background:'none', border:'none', cursor:'pointer', padding:0, textAlign: align||'left',
      fontSize:'0.42rem', color: supplySort.col===col ? t.lbl : t.lblMuted, fontWeight: supplySort.col===col ? 700 : 400 }}>
      {label}{supplySort.col===col ? (supplySort.dir==='desc' ? ' ↓' : ' ↑') : ''}
    </button>
  );

  const toggleDemandHidden = z => setDemandHidden(s => { const n=new Set(s); n.has(z)?n.delete(z):n.add(z); return n; });
  const toggleVreHidden    = z => setVreHidden(s => { const n=new Set(s); n.has(z)?n.delete(z):n.add(z); return n; });
  const toggleStatus       = s => { setStatusFilter(f=>{ const n=new Set(f); n.has(s)?n.delete(s):n.add(s); return n; }); setSelectedPlant(null); };

  // ── Profile helper ────────────────────────────────────────────────────────────
  const getProfile = (profileData, zone, season, day) => {
    const sp = profileData[zone]?.[season];
    if (!sp) return null;
    if (day === 'avg') {
      const days = Object.keys(sp);
      return days.length ? avgProfile(days.map(d => sp[d])) : null;
    }
    return sp[day] || null;
  };

  // ── Mix chart builder ─────────────────────────────────────────────────────────
  const buildMixChart = (labels, dataByGroup) => {
    const presentFuels = sortedFuels.filter(f => labels.some(l => (dataByGroup[l]?.[f]||0)>0));
    return {
      labels,
      datasets: presentFuels.map(fuel => ({
        label: fuel,
        data: labels.map(l => Math.round(dataByGroup[l]?.[fuel]||0)),
        backgroundColor: EPM_FUEL_COLORS[fuel] || '#aaa',
        stack: 'total',
      })),
    };
  };

  // ── Computed profile metadata ─────────────────────────────────────────────────
  const pf           = epmData?.demandProfileFull || {};
  const hoursData    = epmData?.hours || {};
  const timeSlices   = epmData?.timeSlices || {nT:24,isHourly:true,hours:{}};
  const vp           = epmData?.vreProfile || {};
  const firstZoneWithPf  = countryZoneIds.find(z => pf[z]);
  const availSeasons     = firstZoneWithPf ? Object.keys(pf[firstZoneWithPf]).sort() : [];
  const availDaytypes    = firstZoneWithPf && availSeasons[0] ? Object.keys(pf[firstZoneWithPf][availSeasons[0]]||{}).sort() : [];
  const totalDaysPf      = Object.values(hoursData).reduce((s,dts)=>s+Object.values(dts||{}).reduce((a,b)=>a+b,0),0) || 365;
  const allVreTechs      = [...new Set(visZoneIds.flatMap(z=>Object.keys(vp[z]||{})))].sort();
  const activeVreTech    = allVreTechs.includes(vreTech) ? vreTech : (allVreTechs[0]||'');
  const firstZoneWithVre = countryZoneIds.find(z=>vp[z]?.[activeVreTech]);
  const vreAvailSeasons  = firstZoneWithVre ? Object.keys(vp[firstZoneWithVre][activeVreTech]).sort() : [];
  const vreAvailDaytypes = firstZoneWithVre && vreAvailSeasons[0] ? Object.keys(vp[firstZoneWithVre][activeVreTech][vreAvailSeasons[0]]||{}).sort() : [];

  // ── Demand forecast builder ───────────────────────────────────────────────────
  const buildForecastData = () => {
    if (demandSeg === 'aggregate') {
      const eby = {}, pby = {};
      for (const r of countryDemand) for (const y of allYears) {
        if (r.type==='energy') eby[y]=(eby[y]||0)+(r.years[y]||0);
        if (r.type==='peak')   pby[y]=(pby[y]||0)+(r.years[y]||0);
      }
      return { labels: allYears, datasets: [
        { type:'bar',  label:'Energy (GWh)', yAxisID:'yL',
          data: allYears.map(y=>Math.round(eby[y]||0)),
          backgroundColor: hexA('#1a5fa8',0.72), borderWidth:0 },
        { type:'line', label:'Peak (GW)', yAxisID:'yR',
          data: allYears.map(y=>+((pby[y]||0)/1000).toFixed(2)),
          borderColor:'#9B59B6', borderWidth:2.5, pointRadius:2, tension:0.3, fill:false },
      ]};
    }
    const ebyZone = {}, pby = {};
    for (const r of countryDemand) for (const y of allYears) {
      if (r.type==='energy') { if(!ebyZone[r.zone]) ebyZone[r.zone]={}; ebyZone[r.zone][y]=(ebyZone[r.zone][y]||0)+(r.years[y]||0); }
      if (r.type==='peak') pby[y]=(pby[y]||0)+(r.years[y]||0);
    }
    // Stable colors: use demandZones index, skip hidden
    return { labels: allYears, datasets: [
      ...demandZones.flatMap((z,i) => {
        if (demandHidden.has(z)) return [];
        return [{ type:'bar', label:z, yAxisID:'yL',
          data: allYears.map(y=>Math.round(ebyZone[z]?.[y]||0)),
          backgroundColor: ZONE_PALETTE[i%ZONE_PALETTE.length], borderWidth:0, stack:'energy' }];
      }),
      { type:'line', label:'Peak (GW)', yAxisID:'yR',
        data: allYears.map(y=>+((pby[y]||0)/1000).toFixed(2)),
        borderColor:'#9B59B6', borderWidth:2.5, pointRadius:2, tension:0.3, fill:false },
    ]};
  };

  // ── Profile builder (Full Year + single season) ───────────────────────────────
  const buildProfileData = () => {
    const isDark   = t.isDark;
    const showAvg  = !demandHidden.has('__avg__');

    if (demandProfileMode === 'full') {
      if (!firstZoneWithPf || !availDaytypes.length) return { chartData:{ labels:[], datasets:[] }, plugin:null };
      // x layout: one slot per hour on a chronological model, width proportional to duration on a load-block one
      const ax = buildTimeAxis(timeSlices, availSeasons, availDaytypes);
      const nPts = ax.slots.length;
      const zoneDs = visZoneIds.flatMap((z,i) => {
        if (demandHidden.has(z)) return [];
        const data = ax.slots.map(sl => pf[z]?.[sl.q]?.[sl.d]?.[sl.i] ?? null);
        if (!data.some(v=>v!==null)) return [];
        return [{ label:z, data, borderColor:ZONE_PALETTE[i%ZONE_PALETTE.length], borderWidth:1.5, pointRadius:0, tension:0.3, fill:false, spanGaps:true }];
      });
      const avgData = ax.slots.map(sl => {
        const profs = visZoneIds.map(z=>pf[z]?.[sl.q]?.[sl.d]).filter(Boolean);
        return profs.length?profs.reduce((sum,p)=>sum+(p[sl.i]||0),0)/profs.length:null;
      });
      const avgDs = showAvg ? { label:'avg', data:avgData, borderColor:'#1a5fa8', borderWidth:2.5, pointRadius:0, tension:0.3, fill:false, spanGaps:true } : null;
      const separatorPlugin = bandingPlugin({ id:'profSepC', ax, seasons:availSeasons,
        daytypes:availDaytypes, hoursData, totalDays:totalDaysPf, isDark, dayFont:9 });
      return { chartData:{ labels:new Array(nPts).fill(''), datasets:[...zoneDs,...(avgDs?[avgDs]:[])] }, plugin:separatorPlugin, banded:true };
    }

    // Single season. 'All days' lays the season's day types side by side under the same
    // banding as the full year; the other choices are one curve, so they keep the hour labels.
    const days = demandDay==='all'?availDaytypes:[demandDay==='avg'?availDaytypes[0]:demandDay];
    const banded = demandDay==='all' && availDaytypes.length>1;
    const ax = buildSeasonAxis(timeSlices, demandSeason, days);
    const wts = dayWeights(hoursData, demandSeason, availDaytypes);
    const getP = (zone) => {
      const sp=pf[zone]?.[demandSeason]; if(!sp) return null;
      if(demandDay==='all') return ax.slots.map(sl=>sp[sl.d]?.[sl.i]??null);
      if(demandDay==='avg') return availDaytypes.some(d=>sp[d])
        ? ax.slots.map(sl=>availDaytypes.reduce((a,d,k)=>a+(sp[d]?.[sl.i]||0)*wts[k],0)) : null;
      return sp[demandDay]?ax.slots.map(sl=>sp[demandDay][sl.i]??null):null;
    };
    const zoneLines = visZoneIds.flatMap((z,i)=>{if(demandHidden.has(z))return[];const p=getP(z);return p?[{label:z,data:p,borderColor:ZONE_PALETTE[i%ZONE_PALETTE.length],borderWidth:1.8,pointRadius:0,tension:0.35,fill:false}]:[];});
    const allProf = visZoneIds.map(z=>getP(z)).filter(Boolean);
    const avgLine = (showAvg&&allProf.length)?{label:'avg',data:ax.slots.map((_,k)=>allProf.reduce((s,p)=>s+(p[k]||0),0)/allProf.length),borderColor:'#1a5fa8',borderWidth:2.5,pointRadius:0,tension:0.35,fill:false}:null;
    return { chartData:{ labels: banded?new Array(ax.slots.length).fill(''):blockLabels(ax,timeSlices,demandSeason,days[0]),
      datasets:[...zoneLines,...(avgLine?[avgLine]:[])] },
      plugin: banded?bandingPlugin({ id:'profSepCSeason', ax, seasons:[demandSeason], daytypes:days, hoursData, totalDays:totalDaysPf, isDark, dayFont:9 }):null,
      banded, xTicks: banded?null:axisTicks(ax) };
  };

  // ── VRE profile builder ───────────────────────────────────────────────────────
  const buildVREData = () => {
    const isDark = t.isDark;
    const showAvgV = !vreHidden.has('__avg__');
    const tech = activeVreTech;

    if (vreProfileMode === 'full') {
      if (!firstZoneWithVre || !vreAvailDaytypes.length) return { chartData:{ labels:[], datasets:[] }, plugin:null };
      // x layout: one slot per hour on a chronological model, width proportional to duration on a load-block one
      const ax=buildTimeAxis(timeSlices,vreAvailSeasons,vreAvailDaytypes);
      const nPts=ax.slots.length;
      const zoneDs = visZoneIds.flatMap((z,i)=>{
        if(vreHidden.has(z)) return [];
        const data=ax.slots.map(sl=>vp[z]?.[tech]?.[sl.q]?.[sl.d]?.[sl.i]??null);
        if(!data.some(v=>v!==null)) return [];
        return [{label:z,data,borderColor:ZONE_PALETTE[i%ZONE_PALETTE.length],borderWidth:1.5,pointRadius:0,tension:0.3,fill:false,spanGaps:true}];
      });
      const avgData=ax.slots.map(sl=>{
        const profs=visZoneIds.map(z=>vp[z]?.[tech]?.[sl.q]?.[sl.d]).filter(Boolean);
        return profs.length?profs.reduce((sum,p)=>sum+(p[sl.i]||0),0)/profs.length:null;
      });
      const techColor=VRE_COLOR[tech]||'#1E9AF5';
      const avgDs=showAvgV?{label:`${VRE_DISPLAY[tech]||tech} avg`,data:avgData,borderColor:techColor,borderWidth:2.5,pointRadius:0,tension:0.3,fill:false,spanGaps:true}:null;
      const separatorPlugin = bandingPlugin({ id:'vreSepC', ax, seasons:vreAvailSeasons,
        daytypes:vreAvailDaytypes, hoursData, totalDays:totalDaysPf, isDark, dayFont:9 });
      return { chartData:{ labels:new Array(nPts).fill(''), datasets:[...zoneDs,...(avgDs?[avgDs]:[])] }, plugin:separatorPlugin, banded:true };
    }

    // Single season. See the load profile above for what 'All days' draws.
    const days=vreDay==='all'?vreAvailDaytypes:[vreDay==='avg'?vreAvailDaytypes[0]:vreDay];
    const banded=vreDay==='all' && vreAvailDaytypes.length>1;
    const ax=buildSeasonAxis(timeSlices,vreSeason,days);
    const wts=dayWeights(hoursData,vreSeason,vreAvailDaytypes);
    const getP=(zone)=>{
      const sp=vp[zone]?.[tech]?.[vreSeason];if(!sp)return null;
      if(vreDay==='all') return ax.slots.map(sl=>sp[sl.d]?.[sl.i]??null);
      if(vreDay==='avg') return vreAvailDaytypes.some(d=>sp[d])
        ? ax.slots.map(sl=>vreAvailDaytypes.reduce((a,d,k)=>a+(sp[d]?.[sl.i]||0)*wts[k],0)) : null;
      return sp[vreDay]?ax.slots.map(sl=>sp[vreDay][sl.i]??null):null;
    };
    const zoneLines=visZoneIds.flatMap((z,i)=>{if(vreHidden.has(z))return[];const p=getP(z);return p?[{label:z,data:p,borderColor:ZONE_PALETTE[i%ZONE_PALETTE.length],borderWidth:1.8,pointRadius:0,tension:0.35,fill:false}]:[];});
    const allProf=visZoneIds.map(z=>getP(z)).filter(Boolean);
    const techColor=VRE_COLOR[tech]||'#1E9AF5';
    const avgLine=(showAvgV&&allProf.length)?{label:`${VRE_DISPLAY[tech]||tech} avg`,data:ax.slots.map((_,k)=>allProf.reduce((s,p)=>s+(p[k]||0),0)/allProf.length),borderColor:techColor,borderWidth:2.5,pointRadius:0,tension:0.35,fill:false}:null;
    return { chartData:{ labels: banded?new Array(ax.slots.length).fill(''):blockLabels(ax,timeSlices,vreSeason,days[0]),
      datasets:[...zoneLines,...(avgLine?[avgLine]:[])] },
      plugin: banded?bandingPlugin({ id:'vreSepCSeason', ax, seasons:[vreSeason], daytypes:days, hoursData, totalDays:totalDaysPf, isDark, dayFont:9 }):null,
      banded, xTicks: banded?null:axisTicks(ax) };
  };

  // ── Availability builder ──────────────────────────────────────────────────────
  const buildAvailData = () => {
    const av = epmData?.availability || {};
    const zones = availZone === 'all' ? countryZoneIds : [availZone];
    const techKeys = new Set();
    for (const z of zones) for (const k of Object.keys(av[z]||{})) techKeys.add(k);
    const keys = [...techKeys].slice(0, 12);
    const firstZoneData = av[zones[0]] || {};
    const qCols = keys.length ? Object.keys(firstZoneData[keys[0]]||{}).filter(k=>/^Q\d+$/.test(k)).sort() : ['Q1','Q2','Q3','Q4'];
    return {
      labels: qCols,
      datasets: keys.map((k, i) => {
        const entry = firstZoneData[k] || {};
        const displayLabel = entry.fuel && entry.fuel !== '' ? entry.fuel : entry.tech || k;
        return {
          label: displayLabel,
          data: qCols.map(q => {
            const vals = zones.map(z=>av[z]?.[k]?.[q]).filter(v=>v!=null);
            return vals.length ? +(vals.reduce((s,v)=>s+v,0)/vals.length).toFixed(3) : 0;
          }),
          backgroundColor: hexA(EPM_FUEL_COLORS[normalizeFuel(entry.fuel||entry.tech||'')] || ZONE_PALETTE[i%ZONE_PALETTE.length], 0.75),
          borderWidth: 0, barThickness: 10,
        };
      }),
    };
  };

  // ── Fuel price builder ────────────────────────────────────────────────────────
  const buildFuelPriceData = () => {
    const fp = epmData?.fuelPrice || {};
    const countries = (fpCountries || allCountries).filter(c=>fp[c]);
    if (!countries.length) return { labels:[], datasets:[] };
    const allFuels = [...new Set(countries.flatMap(c=>Object.keys(fp[c]||{})))];
    const yearCols = Object.keys(Object.values(fp[countries[0]]||{})[0]||{}).filter(k=>/^\d{4}$/.test(k)).sort().filter(y=>y<='2050');
    return {
      labels: yearCols,
      datasets: allFuels.map((fuel, i) => ({
        label: fuel,
        data: yearCols.map(y => {
          const vals = countries.map(c=>fp[c]?.[fuel]?.[y]).filter(v=>v!=null&&v>0);
          return vals.length ? +(vals.reduce((s,v)=>s+v,0)/vals.length).toFixed(2) : null;
        }),
        borderColor: EPM_FUEL_COLORS[normalizeFuel(fuel)] || ZONE_PALETTE[i%ZONE_PALETTE.length],
        borderWidth: 2, pointRadius: 0, tension: 0.2, fill: false, spanGaps: true,
      })),
    };
  };

  // ── Mix chart config ──────────────────────────────────────────────────────────
  // Mix chart: zone view only (we're already in a country)
  const mixLabels = countryZoneIds.filter(z=>Object.keys(genByZoneFuel[z]||{}).length>0);
  const mixData = buildMixChart(mixLabels, genByZoneFuel);
  const mixHeight = Math.max(mixLabels.length * 20 + 24, 60);
  const presentFuelsInMix = sortedFuels.filter(f=>mixLabels.some(l=>(genByZoneFuel[l]?.[f]||0)>0));

  // ── Tab colors ────────────────────────────────────────────────────────────────
  const TABS = ['overview','demand','supply','resources','trade','scenario','about'];
  const TAB_LABELS = { overview:'Overview', demand:'Demand', supply:'Supply', resources:'Resources', trade:'Trade', scenario:'Scenarios', about:'About' };

  // ── JSX ───────────────────────────────────────────────────────────────────────
  return (
    <div style={{ display:'flex', height:'calc(100vh - 46px)' }}
      onMouseMove={e=>{ if(!isDrRef.current)return; setPanelWidth(w=>Math.max(380,drStartW.current+(drStartX.current-e.clientX))); }}
      onMouseUp={()=>{isDrRef.current=false;}} onMouseLeave={()=>{isDrRef.current=false;}}
    >

      {/* Map */}
      <div style={{ position:'relative', flex:1 }}>
        <div ref={containerRef} style={{ width:'100%', height:'100%', backgroundColor:t.bg }} />
        <MapDownload mapRef={mapRef} t={t} name={()=>ttl(`${countryNameDecoded} map`,epmYear)}/>
        <div style={{ position:'absolute', top:10, left:10, zIndex:10, display:'flex', gap:4, alignItems:'center',
          fontSize:'0.52rem', color:t.text, backgroundColor:t.panel, border:`1px solid ${t.panelBorder}`,
          borderRadius:5, padding:'4px 10px', boxShadow:'0 1px 4px rgba(0,0,0,.18)' }}>
          <Link to="/" style={{ color:t.lblMuted, textDecoration:'none' }}>World</Link>
          <span style={{ color:t.lblMuted }}>›</span>
          <Link to={`/region/${regionId}`} style={{ color:t.lblMuted, textDecoration:'none' }}>{region.name}</Link>
          <span style={{ color:t.lblMuted }}>›</span>
          <span style={{ color:t.lbl, fontWeight:600 }}>{countryNameDecoded}</span>
        </div>
        <div style={{ position:'absolute', bottom:10, left:10, zIndex:10, display:'flex', gap:6, alignItems:'center',
          flexWrap:'wrap' }}>
          {zcmapList.length > 1 && (
            <div style={{ display:'flex', gap:4, alignItems:'center', fontSize:'0.5rem',
              backgroundColor:t.panel, border:`1px solid ${t.panelBorder}`,
              borderRadius:5, padding:'4px 8px', boxShadow:'0 1px 4px rgba(0,0,0,.18)' }}>
              <span style={{ color:t.lblMuted }}>Zone map:</span>
              {zcmapList.map(zc => (
                <button key={zc} onClick={()=>setActiveZcmap(zc)} style={{
                  fontFamily:'inherit', fontSize:'0.5rem', padding:'2px 8px', borderRadius:3,
                  border:`1px solid ${activeZcmap===zc ? t.lbl : t.panelBorder}`,
                  backgroundColor: activeZcmap===zc ? t.lbl : 'transparent',
                  color: activeZcmap===zc ? t.panel : t.lblMuted, cursor:'pointer',
                }}>{zc}</button>
              ))}
            </div>
          )}
          <div style={{ display:'flex', gap:4, alignItems:'center', fontSize:'0.5rem',
            backgroundColor:t.panel, border:`1px solid ${t.panelBorder}`,
            borderRadius:5, padding:'4px 8px', boxShadow:'0 1px 4px rgba(0,0,0,.18)' }}>
            <button onClick={()=>setShowDonuts(v=>!v)} style={{
              fontFamily:'inherit', fontSize:'0.46rem', cursor:'pointer', padding:'2px 7px', borderRadius:3, border:'none',
              backgroundColor: showDonuts ? 'rgba(74,143,204,0.2)' : 'transparent',
              color: showDonuts ? t.lbl : t.lblMuted, fontWeight: showDonuts ? 700 : 400,
            }}>Donuts</button>
            {epmData?.extNtc?.length > 0 && epmData?.zonesExtGJ && (
              <button onClick={()=>setShowExtZones(v=>!v)} style={{
                fontFamily:'inherit', fontSize:'0.46rem', cursor:'pointer', padding:'2px 7px', borderRadius:3, border:'none',
                backgroundColor: showExtZones ? 'rgba(136,136,136,0.2)' : 'transparent',
                color: showExtZones ? t.lbl : t.lblMuted, fontWeight: showExtZones ? 700 : 400,
              }}>Ext. zones</button>
            )}
          </div>
        </div>
      </div>

      <div style={{width:5,flexShrink:0,cursor:'col-resize'}} onMouseDown={e=>{isDrRef.current=true;drStartX.current=e.clientX;drStartW.current=panelWidth;e.preventDefault();}}/>
      {/* Right panel */}
      <div style={{ zoom, width:unzoom(panelWidth,zoom), flexShrink:0, height:unzoom('100%',zoom), overflowY:'auto', padding:'18px 16px',
        backgroundColor:t.panel, borderLeft:`1px solid ${t.panelBorder}`, position:'relative' }}>
        <PanelZoomControl t={t} zoom={zoom} inc={inc} dec={dec} reset={reset}/>

        {/* Header */}
        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:'0.52rem', color:t.lblMuted, marginBottom:2 }}>
            <Link to={`/region/${regionId}`} style={{ color:t.lblMuted, textDecoration:'none' }}>← {region.name}</Link>
          </div>
          <div style={{ fontSize:'1rem', fontWeight:700, color:t.lbl }}>{countryNameDecoded}</div>
          <div style={{ fontSize:'0.55rem', color:t.lblMuted, marginTop:1 }}>
            {countryZoneIds.length} zone{countryZoneIds.length!==1?'s':''} · EPM study
          </div>
        </div>

        {/* Data folder selector */}
        {autoFolders?.length > 1 && (
          <div style={{ marginBottom:10, display:'flex', alignItems:'center', gap:6, fontSize:'0.5rem', color:t.lblMuted }}>
            <span>Data folder:</span>
            <select value={activeFolder ?? ''} onChange={e=>handleFolderChange(e.target.value)}
              style={{ fontSize:'0.5rem', fontFamily:'inherit', padding:'2px 6px', borderRadius:3,
                border:`1px solid ${t.panelBorder}`, backgroundColor:t.panel, color:t.lbl, cursor:'pointer' }}>
              {autoFolders.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </div>
        )}

        {/* Tabs */}
        <div style={{ display:'flex', gap:0, marginBottom:16, borderBottom:`1px solid ${t.panelBorder}` }}>
          {TABS.map(tab => (
            <button key={tab} onClick={()=>setActiveTab(tab)} style={{
              fontSize:'0.5rem', fontFamily:'inherit', padding:'6px 10px', border:'none',
              borderBottom: activeTab===tab ? `2px solid ${t.lbl}` : '2px solid transparent',
              backgroundColor:'transparent', color: activeTab===tab ? t.lbl : t.lblMuted,
              cursor:'pointer', fontWeight: activeTab===tab ? 600 : 400,
            }}>{TAB_LABELS[tab]}</button>
          ))}
        </div>

        {loading && <div style={{ padding:'24px 0', textAlign:'center', color:t.lblMuted, fontSize:'0.6rem' }}>Loading EPM data…</div>}

        {/* Zone selector badge */}
        {hasData && countryZoneIds.length > 1 && (
          <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:10, fontSize:'0.44rem', color:t.muted }}>
            <span style={{ color:t.lblMuted }}>Zone:</span>
            <select value={selZone} onChange={e=>setSelZone(e.target.value)}
              style={{ fontSize:'0.44rem', fontFamily:'inherit', padding:'2px 5px', borderRadius:3,
                border:`1px solid ${t.panelBorder}`, backgroundColor:t.panel, color:t.muted, cursor:'pointer' }}>
              <option value="all">All zones</option>
              {countryZoneIds.map(z=><option key={z} value={z}>{z}</option>)}
            </select>
            {selZone!=='all'&&<span onClick={()=>setSelZone('all')} style={{ cursor:'pointer', color:t.lblMuted, padding:'1px 5px', border:`1px solid ${t.panelBorder}`, borderRadius:3, fontSize:'0.42rem' }}>✕ all</span>}
            <span style={{ color:t.lblMuted, fontSize:'0.4rem', marginLeft:2 }}>or click zone on map</span>
          </div>
        )}

        {/* ════════ OVERVIEW ════════════════════════════════════════════════════ */}
        {hasData && activeTab === 'overview' && (
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>

            {/* KPIs + donut */}
            <div style={{ display:'flex', gap:12, alignItems:'flex-start' }}>
              {/* Donut */}
              <div style={{ flexShrink:0, width:108, textAlign:'center' }}>
                <CJChart name={ttl('Capacity mix by fuel (MW)',selZone==='all'?countryNameDecoded:selZone,epmYear)} type="doughnut" height={108}
                  data={{ labels: Object.keys(fuelAgg), datasets:[{
                    data: Object.values(fuelAgg).map(v=>Math.round(v)),
                    backgroundColor: Object.keys(fuelAgg).map(f=>EPM_FUEL_COLORS[f]||'#aaa'),
                    borderWidth:1.5, borderColor:t.panel, hoverOffset:3,
                  }]}}
                  options={{ cutout:'60%', responsive:true, maintainAspectRatio:false, layout:{padding:4},
                    plugins:{ legend:{display:false}, tooltip:{callbacks:{label:c=>` ${c.label}: ${fmt(c.parsed)} MW`}}} }}
                />
                <div style={{ fontSize:'0.4rem', color:t.lblMuted, marginTop:2 }}>Existing mix</div>
              </div>
              {/* KPI rows */}
              <div style={{ flex:1, display:'flex', flexDirection:'column', gap:5 }}>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:5 }}>
                  {[
                    { l:`Peak ${refYr||''}`, v:`${peakGW.toFixed(1)} GW` },
                    { l:`Energy ${refYr||''}`, v:`${energyTWh.toFixed(0)} TWh` },
                    { l:'Installed', v:`${totalGW.toFixed(1)} GW` },
                    { l:'RE Share', v:`${reShare}%` },
                  ].map(({l,v})=>(
                    <div key={l} style={{ border:`1px solid ${t.panelBorder}`, borderRadius:5, padding:'6px 8px' }}>
                      <div style={{ fontSize:'0.4rem', color:t.lblMuted, marginBottom:2 }}>{l}</div>
                      <div style={{ fontSize:'0.72rem', fontWeight:700, color:t.lbl }}>{v}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:5 }}>
                  {[
                    { l:'Countries', v:allCountries.length },
                    { l:'Zones', v:countryZoneIds.length },
                    { l:'TX Capacity', v:`${txGW.toFixed(1)} GW` },
                    { l:'Corridors', v:nCorridors },
                  ].map(({l,v})=>(
                    <div key={l} style={{ border:`1px solid ${t.panelBorder}`, borderRadius:5, padding:'5px 8px' }}>
                      <div style={{ fontSize:'0.39rem', color:t.lblMuted, marginBottom:1 }}>{l}</div>
                      <div style={{ fontSize:'0.6rem', fontWeight:700, color:t.lbl }}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Mix chart */}
            <div>
              <SectionTitle t={t}>Capacity mix by zone (MW)</SectionTitle>
              {mixLabels.length > 0 ? (
                <>
                  <div style={{ display:'flex', gap:6, alignItems:'flex-start' }}>
                    <div style={{ flex:1, minWidth:0 }}>
                      <CJChart name={ttl('Capacity mix (MW)',mixView==='country'?'by country':'by zone',selZone==='all'?countryNameDecoded:selZone,epmYear)} type="bar" height={Math.min(mixHeight, 260)}
                        data={mixData}
                        options={{ ...cjDefaults(t), indexAxis:'y',
                          scales: {
                            x: { stacked:true, grid:{color:t.panelBorder}, ticks:{color:t.muted,font:{size:9},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v} },
                            y: { stacked:true, grid:{display:false}, ticks:{color:t.muted,font:{size:9}} },
                          }, plugins:{...cjDefaults(t).plugins, tooltip:{...cjDefaults(t).plugins.tooltip,
                            callbacks:{label:c=>` ${c.dataset.label}: ${fmt(c.parsed.x)} MW`}}} }}
                      />
                    </div>
                    <div style={{ width:90, flexShrink:0, display:'flex', flexDirection:'column', gap:2, paddingTop:4, maxHeight:260, overflowY:'auto' }}>
                      {presentFuelsInMix.map(f=>(
                        <div key={f} style={{ display:'flex', alignItems:'center', gap:3 }}>
                          <div style={{ width:8, height:8, borderRadius:2, backgroundColor:EPM_FUEL_COLORS[f]||'#aaa', flexShrink:0 }}/>
                          <span style={{ fontSize:'0.4rem', color:t.muted, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{f}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              ) : <div style={{ color:t.lblMuted, fontSize:'0.58rem' }}>No generation data.</div>}
            </div>

            {/* Zones quick list */}
            {countryZoneIds.length > 0 && (
              <div>
                <SectionTitle t={t}>Zones ({countryZoneIds.length})</SectionTitle>
                <div style={{ border:`1px solid ${t.panelBorder}`, borderRadius:6, overflow:'hidden' }}>
                  {countryZoneIds.map((z,i)=>(
                    <div key={z} onClick={()=>navigate(`/region/${regionId}/zone/${encodeURIComponent(z)}`)}
                      style={{ display:'flex', justifyContent:'space-between', alignItems:'center',
                        padding:'5px 10px', borderBottom:i<countryZoneIds.length-1?`1px solid ${t.panelBorder}`:'none',
                        cursor:'pointer', fontSize:'0.52rem' }}
                      onMouseEnter={e=>e.currentTarget.style.backgroundColor=hexA('#1a5fa8',0.06)}
                      onMouseLeave={e=>e.currentTarget.style.backgroundColor='transparent'}>
                      <span style={{ color:t.lbl, fontWeight:500 }}>{z}</span>
                      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                        <span style={{ color:t.muted }}>{fmt((genByZoneFuel[z]?Object.values(genByZoneFuel[z]).reduce((s,v)=>s+v,0):0))} MW</span>
                        <span style={{ color:t.lblMuted, fontSize:'0.44rem' }}>›</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ════════ DEMAND ══════════════════════════════════════════════════════ */}
        {hasData && activeTab === 'demand' && (
          <div style={{ display:'flex', flexDirection:'column', gap:18 }}>

            <div>
              <VariantPicker t={t} scnMeta={scnMeta} param="pDemandForecast" value={varOverrides.pDemandForecast} onChange={setVariant} />
              <VariantPicker t={t} scnMeta={scnMeta} param="pDemandProfile" value={varOverrides.pDemandProfile} onChange={setVariant} />
            </div>

            {/* Forecast */}
            <div>
              <SectionTitle t={t} right={
                <div style={{ display:'flex', gap:3 }}>
                  <Pill active={demandSeg==='aggregate'} onClick={()=>{ setDemandSeg('aggregate'); setDemandHidden(new Set()); }}>Aggregate</Pill>
                  <Pill active={demandSeg==='zone'}      onClick={()=>{ setDemandSeg('zone'); setDemandHidden(new Set()); }}>By Zone</Pill>
                </div>
              }>Demand forecast</SectionTitle>
              {demandCAGR && (
                <div style={{ display:'flex', gap:6, marginBottom:7, flexWrap:'wrap' }}>
                  {[
                    { label:'Peak CAGR', val:demandCAGR.peak, unit:'GW' },
                    { label:'Energy CAGR', val:demandCAGR.energy, unit:'GWh' },
                  ].map(({ label, val, unit }) => {
                    if (val === null) return null;
                    const pos = val >= 0;
                    const color = pos ? '#22a861' : '#e05252';
                    return (
                      <div key={label} style={{
                        display:'inline-flex', alignItems:'center', gap:5,
                        padding:'3px 8px', borderRadius:5,
                        border:`1px solid ${color}44`,
                        backgroundColor:`${color}12`,
                        fontSize:'0.48rem',
                      }}>
                        <span style={{ color:t.lblMuted }}>{label}</span>
                        <span style={{ fontWeight:700, color }}>
                          {pos ? '+' : ''}{val.toFixed(1)}%/yr
                        </span>
                        <span style={{ color:t.lblMuted, fontSize:'0.4rem' }}>
                          ({demandCAGR.firstYr}–{demandCAGR.lastYr})
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              {countryDemand.length > 0 ? (
                <div style={{ display:'flex', gap:8 }}>
                  <div style={{ flex:1 }}>
                    <CJChart name={ttl('Demand forecast (GWh)',demandSeg==='zone'?'by zone':demandSeg==='country'?'by country':'aggregate',selZone==='all'?countryNameDecoded:selZone)} type="bar" height={170} data={buildForecastData()}
                      cacheKey={`forecast|${demandSeg}|${[...demandHidden].sort().join(',')}`}
                      options={{ ...cjDefaults(t),
                        scales: {
                          x:  { stacked:true, grid:{color:t.panelBorder}, ticks:{color:t.muted,font:{size:9},maxTicksLimit:7} },
                          yL: { type:'linear', position:'left', stacked:true, title:{display:true,text:'GWh',color:t.muted,font:{size:8}},
                            grid:{color:t.panelBorder}, ticks:{color:t.muted,font:{size:9}} },
                          yR: { type:'linear', position:'right', title:{display:true,text:'GW',color:t.muted,font:{size:8}},
                            grid:{drawOnChartArea:false}, ticks:{color:t.muted,font:{size:9}} },
                        } }}
                      onClickYear={setEpmYear}
                    />
                  </div>
                  {demandSeg==='zone' && demandZones.length>0 && (
                    <div style={{ width:90, flexShrink:0, display:'flex', flexDirection:'column', gap:2, paddingTop:4, maxHeight:175, overflowY:'auto' }}>
                      {demandZones.map((z,i)=>(
                        <div key={z} onClick={()=>toggleDemandHidden(z)}
                          style={{ display:'flex', alignItems:'center', gap:3, cursor:'pointer', opacity:demandHidden.has(z)?0.25:1 }}>
                          <div style={{ width:8, height:8, borderRadius:2, flexShrink:0, backgroundColor:ZONE_PALETTE[i%ZONE_PALETTE.length] }}/>
                          <span style={{ fontSize:'0.4rem', color:t.muted, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{z}</span>
                        </div>
                      ))}
                      <div style={{ fontSize:'0.38rem', color:t.lblMuted, marginTop:4, display:'flex', gap:6 }}>
                        <span onClick={()=>setDemandHidden(new Set(demandZones))} style={{cursor:'pointer',textDecoration:'underline'}}>None</span>
                        <span onClick={()=>setDemandHidden(new Set())} style={{cursor:'pointer',textDecoration:'underline'}}>All</span>
                      </div>
                    </div>
                  )}
                </div>
              ) : <div style={{ color:t.lblMuted, fontSize:'0.58rem' }}>No demand data.</div>}
            </div>

            {/* Profile */}
            <div>
              <SectionTitle t={t}>Load profile</SectionTitle>
              <div style={{ display:'flex', flexWrap:'wrap', gap:3, marginBottom:6, alignItems:'center' }}>
                <Pill active={demandProfileMode==='full'} onClick={()=>setDemandProfileMode('full')}>Full Year</Pill>
                {availSeasons.map(s=>(
                  <Pill key={s} active={demandProfileMode==='season'&&demandSeason===s}
                    onClick={()=>{setDemandProfileMode('season');setDemandSeason(s);}}>
                    {s}
                  </Pill>
                ))}
                {demandProfileMode==='season' && availDaytypes.length>0 && (
                  <>
                    <div style={{ width:1, backgroundColor:t.panelBorder, height:14 }}/>
                    <select value={demandDay} onChange={e=>setDemandDay(e.target.value)} style={{
                      fontSize:'0.44rem', fontFamily:'inherit', padding:'2px 5px', borderRadius:3,
                      border:`1px solid ${t.panelBorder}`, backgroundColor:t.panel, color:t.muted, cursor:'pointer' }}>
                      <option value="avg">Avg</option>
                      <option value="all">All days</option>
                      {availDaytypes.map(d=><option key={d} value={d}>{d}</option>)}
                    </select>
                  </>
                )}
              </div>
              {(() => {
                const pd = buildProfileData();
                return pd.chartData.datasets.length > 0 ? (
                  <div style={{ display:'flex', gap:8 }}>
                    <div style={{ flex:1 }}>
                      <CJChart name={ttl('Load profile (MW)',selZone==='all'?countryNameDecoded:selZone,demandProfileMode==='full'?'Full year':ttl(demandSeason,demandDay==='avg'?'average day':demandDay==='all'?'all day types':demandDay))} type="line"
                        height={pd.banded?205:160}
                        data={pd.chartData}
                        plugins={pd.plugin?[pd.plugin]:[]}
                        cacheKey={`${demandProfileMode}|${demandSeason}|${demandDay}|${[...demandHidden].sort().join(',')}`}
                        options={{ ...cjDefaults(t),
                          layout:{padding:{top:pd.banded?18:4,bottom:pd.banded?80:4}},
                          scales:{
                            x:{grid:{color:t.panelBorder,drawTicks:false},ticks:{display:!pd.banded,color:t.muted,font:{size:8},maxTicksLimit:12,...(pd.xTicks||{})}},
                            y:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9}},min:0,title:{display:true,text:'Load factor',color:t.muted,font:{size:8}}},
                          }}}
                      />
                    </div>
                    <div style={{ width:90, flexShrink:0, display:'flex', flexDirection:'column', gap:2, paddingTop:4, maxHeight:pd.banded?205:160, overflowY:'auto' }}>
                      <div onClick={()=>toggleDemandHidden('__avg__')} style={{ display:'flex', alignItems:'center', gap:3, cursor:'pointer', opacity:demandHidden.has('__avg__')?0.25:1 }}>
                        <div style={{ width:12, height:2, backgroundColor:'#1a5fa8', borderRadius:1, flexShrink:0 }}/>
                        <span style={{ fontSize:'0.4rem', color:t.muted, fontWeight:600 }}>avg</span>
                      </div>
                      {countryZoneIds.map((z,i)=>(
                        <div key={z} onClick={()=>toggleDemandHidden(z)} style={{ display:'flex', alignItems:'center', gap:3, cursor:'pointer', opacity:demandHidden.has(z)?0.25:1 }}>
                          <div style={{ width:12, height:2, backgroundColor:ZONE_PALETTE[i%ZONE_PALETTE.length], borderRadius:1, flexShrink:0 }}/>
                          <span style={{ fontSize:'0.4rem', color:t.muted, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{z}</span>
                        </div>
                      ))}
                      <div style={{ fontSize:'0.38rem', color:t.lblMuted, marginTop:4, display:'flex', gap:6 }}>
                        <span onClick={()=>setDemandHidden(new Set(['__avg__',...countryZoneIds]))} style={{cursor:'pointer',textDecoration:'underline'}}>None</span>
                        <span onClick={()=>setDemandHidden(new Set())} style={{cursor:'pointer',textDecoration:'underline'}}>All</span>
                      </div>
                    </div>
                  </div>
                ) : <div style={{ color:t.lblMuted, fontSize:'0.55rem' }}>No profile data.</div>;
              })()}
            </div>
          </div>
        )}

        {/* ════════ SUPPLY ══════════════════════════════════════════════════════ */}
        {hasData && activeTab === 'supply' && (
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>

            <VariantPicker t={t} scnMeta={scnMeta} param="pGenDataInput" value={varOverrides.pGenDataInput} onChange={setVariant} />

            {/* Capacity chart */}
            {(() => {
              const chartPlants = countryGen.filter(r => statusFilter.has(r.status));
              const fuels = [...new Set(chartPlants.map(r => r.fuel))];
              const byFS = {};
              for (const r of chartPlants) { if(!byFS[r.fuel]) byFS[r.fuel]={1:0,2:0,3:0}; byFS[r.fuel][r.status]=(byFS[r.fuel][r.status]||0)+r.capacity; }
              const fd = fuels.filter(f=>byFS[f]).map(f=>({ fuel:f, ex:Math.round(byFS[f]?.[1]||0), co:Math.round(byFS[f]?.[2]||0), ca:Math.round(byFS[f]?.[3]||0) })).filter(d=>d.ex+d.co+d.ca>0).sort((a,b)=>(b.ex+b.co+b.ca)-(a.ex+a.co+a.ca));
              if (!fd.length) return null;
              return (
                <div>
                  <SectionTitle t={t}>Capacity by fuel (MW)</SectionTitle>
                  <div style={{ display:'flex', gap:6, alignItems:'flex-start' }}>
                    <div style={{ flex:1, minWidth:0 }}>
                      <CJChart name={ttl('Capacity by fuel (MW)',selZone==='all'?countryNameDecoded:selZone)} type="bar" height={Math.min(fd.length*22+24,200)}
                        data={{ labels:fd.map(d=>d.fuel), datasets:[
                          { label:'Existing', data:fd.map(d=>d.ex), backgroundColor:fd.map(d=>EPM_FUEL_COLORS[d.fuel]||'#aaa'), borderWidth:0, barThickness:12, stack:'a' },
                          { label:'Committed', data:fd.map(d=>d.co), backgroundColor:fd.map(d=>hexA(EPM_FUEL_COLORS[d.fuel]||'#aaa',0.55)), borderWidth:0, barThickness:12, stack:'a' },
                          { label:'Candidate', data:fd.map(d=>d.ca), backgroundColor:fd.map(d=>hexA(EPM_FUEL_COLORS[d.fuel]||'#aaa',0.22)), borderWidth:0, barThickness:12, stack:'a' },
                        ]}}
                        options={{ ...cjDefaults(t), indexAxis:'y',
                          scales:{
                            x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},
                            y:{stacked:true,grid:{display:false},ticks:{color:t.muted,font:{size:9}}},
                          }}}
                      />
                    </div>
                    <div style={{ width:90, flexShrink:0, display:'flex', flexDirection:'column', gap:3, paddingTop:4 }}>
                      {[['Existing',1.0],['Committed',0.55],['Candidate',0.22]].map(([lbl,op])=>(
                        <div key={lbl} style={{ display:'flex', alignItems:'center', gap:3 }}>
                          <div style={{ width:8, height:8, borderRadius:2, backgroundColor:`rgba(100,140,200,${op})`, flexShrink:0 }}/>
                          <span style={{ fontSize:'0.4rem', color:t.muted }}>{lbl}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Fuel legend filter */}
            {(() => {
              const allGenFuels = [...new Set(countryGen.map(r=>r.fuel))].sort();
              return allGenFuels.length > 1 && (
                <div style={{ display:'flex', gap:7, flexWrap:'wrap', alignItems:'center' }}>
                  {allGenFuels.map(fuel => {
                    const hidden = hiddenFuels.has(fuel);
                    const fc = EPM_FUEL_COLORS[fuel]||'#aaa';
                    return (
                      <div key={fuel} onClick={()=>setHiddenFuels(s=>{const n=new Set(s);n.has(fuel)?n.delete(fuel):n.add(fuel);return n;})}
                        style={{ display:'flex', alignItems:'center', gap:3, cursor:'pointer', opacity:hidden?0.3:1, userSelect:'none' }}>
                        <div style={{ width:8, height:8, borderRadius:1, backgroundColor:fc, flexShrink:0 }}/>
                        <span style={{ fontSize:'0.42rem', color:t.muted }}>{fuel}</span>
                      </div>
                    );
                  })}
                  <div style={{ width:1, backgroundColor:t.panelBorder, height:10, margin:'0 2px' }}/>
                  <span onClick={()=>setHiddenFuels(new Set())} style={{ fontSize:'0.42rem', color:t.lblMuted, cursor:'pointer', userSelect:'none' }}>All</span>
                  <span onClick={()=>setHiddenFuels(new Set(allGenFuels))} style={{ fontSize:'0.42rem', color:t.lblMuted, cursor:'pointer', userSelect:'none' }}>None</span>
                </div>
              );
            })()}

            {/* Filters */}
            <div style={{ display:'flex', flexWrap:'wrap', gap:4, alignItems:'center' }}>
              {[1,2,3].map(s=>(
                <Pill key={s} active={statusFilter.has(s)} onClick={()=>toggleStatus(s)} color={STATUS_COLOR[s]}>
                  <span style={{ display:'inline-block', width:6, height:6, borderRadius:'50%',
                    backgroundColor:STATUS_COLOR[s], marginRight:3 }}/>
                  {STATUS_LABEL[s]}
                </Pill>
              ))}
              <div style={{ height:14, width:1, backgroundColor:t.panelBorder, margin:'0 2px' }}/>
              <select value={selZone} onChange={e=>{setSelZone(e.target.value);setSelectedPlant(null);}} style={{
                fontSize:'0.44rem', fontFamily:'inherit', padding:'3px 6px', borderRadius:3,
                border:`1px solid ${t.panelBorder}`, backgroundColor:t.panel, color:t.muted, cursor:'pointer' }}>
                <option value="all">All zones</option>
                {countryZoneIds.map(z=><option key={z} value={z}>{z}</option>)}
              </select>
              <span style={{ fontSize:'0.42rem', color:t.lblMuted, marginLeft:2 }}>
                {sortedPlants.length} unit{sortedPlants.length!==1?'s':''}
              </span>
            </div>

            {/* Table */}
            <div style={{ border:`1px solid ${t.panelBorder}`, borderRadius:6, overflow:'hidden' }}>
              {/* Header */}
              <div style={{ display:'grid', gridTemplateColumns:'1fr 70px 56px 52px 56px',
                padding:'4px 8px', backgroundColor:hexA(t.panelBorder,0.4),
                borderBottom:`1px solid ${t.panelBorder}` }}>
                <SortBtn col="g"        label="Name"/>
                <SortBtn col="zone"     label="Zone"/>
                <SortBtn col="fuel"     label="Fuel"/>
                <SortBtn col="status"   label="Status"/>
                <span><SortBtn col="capacity" label="MW" align="right"/></span>
              </div>
              {/* Rows */}
              <div style={{ maxHeight:360, overflowY:'auto' }}>
                {sortedPlants.length === 0 ? (
                  <div style={{ padding:'12px 10px', color:t.lblMuted, fontSize:'0.55rem' }}>No units match filters.</div>
                ) : sortedPlants.map((r) => {
                  const plantKey = `${r.g}|${r.zone}|${r.status}`;
                  const isSelected = selectedPlant && `${selectedPlant.g}|${selectedPlant.zone}|${selectedPlant.status}` === plantKey;
                  return (
                    <div key={plantKey}>
                      <div onClick={()=>setSelectedPlant(isSelected ? null : r)}
                        style={{ display:'grid', gridTemplateColumns:'1fr 70px 56px 52px 56px',
                          padding:'5px 8px', borderBottom:`1px solid ${t.panelBorder}`,
                          fontSize:'0.5rem', alignItems:'center', cursor:'pointer',
                          backgroundColor: isSelected ? hexA('#1a5fa8',0.08) : 'transparent' }}
                        onMouseEnter={e=>{ if(!isSelected) e.currentTarget.style.backgroundColor=hexA('#1a5fa8',0.04); }}
                        onMouseLeave={e=>{ if(!isSelected) e.currentTarget.style.backgroundColor='transparent'; }}>
                        <span style={{ color:t.lbl, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.g||'—'}</span>
                        <span style={{ color:t.muted, fontSize:'0.44rem' }}>{r.zone}</span>
                        <span style={{ display:'flex', alignItems:'center', gap:3 }}>
                          <span style={{ display:'inline-block', width:7, height:7, borderRadius:1, backgroundColor:EPM_FUEL_COLORS[r.fuel]||'#aaa' }}/>
                          <span style={{ color:t.muted, fontSize:'0.43rem' }}>{r.fuel}</span>
                        </span>
                        <span>
                          <span style={{ display:'inline-block', width:7, height:7, borderRadius:'50%',
                            backgroundColor:STATUS_COLOR[r.status]||'#aaa' }}/>
                        </span>
                        <span style={{ color:t.lbl, textAlign:'right', fontWeight:600 }}>{fmt(r.capacity)}</span>
                      </div>
                      {/* Inline detail expansion */}
                      {isSelected && (
                        <div style={{ padding:'8px 12px', backgroundColor:hexA('#1a5fa8',0.05),
                          borderBottom:`1px solid ${t.panelBorder}`, fontSize:'0.5rem' }}>
                          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:'6px 10px' }}>
                            {[
                              { l:'Technology', v:r.tech||'—' },
                              { l:'Status', v:STATUS_LABEL[r.status]||'—' },
                              { l:'Start year', v:r.stYr||'—' },
                              { l:'Retire year', v:r.retrYr||'—' },
                              { l:'Capex ($/kW)', v:r.capex!=null?fmt(r.capex,0):'—' },
                              { l:'FOM ($/MW/yr)', v:r.fom!=null?fmt(r.fom,0):'—' },
                              { l:'VOM ($/MWh)', v:r.vom!=null?fmt(r.vom,2):'—' },
                              { l:'Heat rate', v:r.heatRate!=null?fmt(r.heatRate,2):'—' },
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
          </div>
        )}

        {/* ════════ RESOURCES ═══════════════════════════════════════════════════ */}
        {hasData && activeTab === 'resources' && (
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>

            {/* Sub-section pills */}
            <div style={{ display:'flex', gap:4 }}>
              <Pill active={resSection==='vre'}   onClick={()=>setResSection('vre')}>VRE Profiles</Pill>
              <Pill active={resSection==='avail'} onClick={()=>setResSection('avail')}>Availability</Pill>
              <Pill active={resSection==='fuel'}  onClick={()=>setResSection('fuel')}>Fuel Prices</Pill>
            </div>

            {resSection==='vre'   && <VariantPicker t={t} scnMeta={scnMeta} param="pVREProfile"        value={varOverrides.pVREProfile}        onChange={setVariant} />}
            {resSection==='avail' && <VariantPicker t={t} scnMeta={scnMeta} param="pAvailabilityDefault" value={varOverrides.pAvailabilityDefault} onChange={setVariant} />}
            {resSection==='fuel'  && <VariantPicker t={t} scnMeta={scnMeta} param="pFuelPrice"         value={varOverrides.pFuelPrice}         onChange={setVariant} />}

            {/* VRE Profiles */}
            {resSection === 'vre' && (
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {allVreTechs.length === 0 ? (
                  <div style={{ color:t.lblMuted, fontSize:'0.55rem' }}>No VRE profile data for this country.</div>
                ) : (
                  <>
                    <div style={{ display:'flex', flexWrap:'wrap', gap:3, alignItems:'center' }}>
                      {allVreTechs.map(tc=>(
                        <Pill key={tc} active={activeVreTech===tc} onClick={()=>setVreTech(tc)}>
                          {VRE_DISPLAY[tc]||tc}
                        </Pill>
                      ))}
                      <div style={{ width:1, backgroundColor:t.panelBorder, height:14, margin:'0 2px' }}/>
                      <Pill active={vreProfileMode==='full'} onClick={()=>setVreProfileMode('full')}>Full Year</Pill>
                      {vreAvailSeasons.map(s=>(
                        <Pill key={s} active={vreProfileMode==='season'&&vreSeason===s}
                          onClick={()=>{setVreProfileMode('season');setVreSeason(s);}}>
                          {s}
                        </Pill>
                      ))}
                      {vreProfileMode==='season' && vreAvailDaytypes.length>0 && (
                        <>
                          <div style={{ width:1, backgroundColor:t.panelBorder, height:14 }}/>
                          <select value={vreDay} onChange={e=>setVreDay(e.target.value)} style={{
                            fontSize:'0.44rem', fontFamily:'inherit', padding:'2px 5px', borderRadius:3,
                            border:`1px solid ${t.panelBorder}`, backgroundColor:t.panel, color:t.muted, cursor:'pointer' }}>
                            <option value="avg">Avg</option>
                            <option value="all">All days</option>
                            {vreAvailDaytypes.map(d=><option key={d} value={d}>{d}</option>)}
                          </select>
                        </>
                      )}
                    </div>
                    {(() => {
                      const vd = buildVREData();
                      return vd.chartData.datasets.length > 0 ? (
                        <div style={{ display:'flex', gap:8 }}>
                          <div style={{ flex:1 }}>
                            <CJChart name={ttl('VRE profile',vreTech,selZone==='all'?countryNameDecoded:selZone,vreProfileMode==='full'?'Full year':ttl(vreSeason,vreDay==='avg'?'average day':vreDay==='all'?'all day types':vreDay))} type="line"
                              height={vd.banded?205:160}
                              data={vd.chartData}
                              plugins={vd.plugin?[vd.plugin]:[]}
                              cacheKey={`${vreProfileMode}|${activeVreTech}|${vreSeason}|${vreDay}|${[...vreHidden].sort().join(',')}`}
                              options={{ ...cjDefaults(t),
                                layout:{padding:{top:vd.banded?18:4,bottom:vd.banded?80:4}},
                                scales:{
                                  x:{grid:{color:t.panelBorder,drawTicks:false},ticks:{display:!vd.banded,color:t.muted,font:{size:8},maxTicksLimit:12,...(vd.xTicks||{})}},
                                  y:{min:0,max:1,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9}},title:{display:true,text:'Availability (0-1)',color:t.muted,font:{size:8}}},
                                }}}
                            />
                          </div>
                          <div style={{ width:90, flexShrink:0, display:'flex', flexDirection:'column', gap:2, paddingTop:4, maxHeight:vd.banded?205:160, overflowY:'auto' }}>
                            <div onClick={()=>setVreHidden(s=>{const n=new Set(s);n.has('__avg__')?n.delete('__avg__'):n.add('__avg__');return n;})}
                              style={{ display:'flex', alignItems:'center', gap:3, cursor:'pointer', opacity:vreHidden.has('__avg__')?0.25:1 }}>
                              <div style={{ width:12, height:2, backgroundColor:VRE_COLOR[activeVreTech]||'#1E9AF5', borderRadius:1, flexShrink:0 }}/>
                              <span style={{ fontSize:'0.4rem', color:t.muted, fontWeight:600 }}>avg</span>
                            </div>
                            {countryZoneIds.map((z,i)=>{
                              if(!vp[z]?.[activeVreTech]) return null;
                              return (
                                <div key={z} onClick={()=>toggleVreHidden(z)} style={{ display:'flex', alignItems:'center', gap:3, cursor:'pointer', opacity:vreHidden.has(z)?0.25:1 }}>
                                  <div style={{ width:12, height:2, backgroundColor:ZONE_PALETTE[i%ZONE_PALETTE.length], borderRadius:1, flexShrink:0 }}/>
                                  <span style={{ fontSize:'0.4rem', color:t.muted, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{z}</span>
                                </div>
                              );
                            })}
                            <div style={{ fontSize:'0.38rem', color:t.lblMuted, marginTop:4, display:'flex', gap:6 }}>
                              <span onClick={()=>setVreHidden(new Set(['__avg__',...countryZoneIds]))} style={{cursor:'pointer',textDecoration:'underline'}}>None</span>
                              <span onClick={()=>setVreHidden(new Set())} style={{cursor:'pointer',textDecoration:'underline'}}>All</span>
                            </div>
                          </div>
                        </div>
                      ) : <div style={{ color:t.lblMuted, fontSize:'0.55rem' }}>No {VRE_DISPLAY[activeVreTech]||activeVreTech} data available.</div>;
                    })()}
                  </>
                )}
              </div>
            )}

            {/* Availability */}
            {resSection === 'avail' && (
              <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                <div style={{ display:'flex', gap:4, alignItems:'center' }}>
                  <span style={{ fontSize:'0.44rem', color:t.lblMuted }}>Zone:</span>
                  <select value={availZone} onChange={e=>setAvailZone(e.target.value)} style={{
                    fontSize:'0.44rem', fontFamily:'inherit', padding:'3px 6px', borderRadius:3,
                    border:`1px solid ${t.panelBorder}`, backgroundColor:t.panel, color:t.muted }}>
                    <option value="all">All zones (avg)</option>
                    {countryZoneIds.map(z=><option key={z} value={z}>{z}</option>)}
                  </select>
                </div>
                {(() => {
                  const ad = buildAvailData();
                  return ad.datasets.length > 0 ? (
                    <>
                      <CJChart name={ttl('Seasonal availability (%)',availZone==='all'?`${countryNameDecoded} (all zones)`:availZone)} type="bar" height={160} data={ad}
                        options={{ ...cjDefaults(t),
                          scales: {
                            x: { grid:{color:t.panelBorder}, ticks:{color:t.muted,font:{size:9}} },
                            y: { min:0, max:1, grid:{color:t.panelBorder}, ticks:{color:t.muted,font:{size:9}},
                              title:{display:true,text:'Availability factor',color:t.muted,font:{size:8}} },
                          } }}
                      />
                      <div style={{ display:'flex', flexWrap:'wrap', gap:'3px 10px', marginTop:2 }}>
                        {ad.datasets.map((ds,i)=>(
                          <div key={ds.label} style={{ display:'flex', alignItems:'center', gap:3, fontSize:'0.43rem', color:t.muted }}>
                            <div style={{ width:8, height:8, borderRadius:2, backgroundColor:ad.datasets[i].backgroundColor }}/>
                            {ds.label}
                          </div>
                        ))}
                      </div>
                    </>
                  ) : <div style={{ color:t.lblMuted, fontSize:'0.55rem' }}>No availability data for this country.</div>;
                })()}
              </div>
            )}

            {/* Fuel Prices */}
            {resSection === 'fuel' && (
              <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                {/* Country filter */}
                <div>
                  <div style={{ fontSize:'0.44rem', color:t.lblMuted, marginBottom:4 }}>
                    Countries — click to filter:
                  </div>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:3 }}>
                    <Pill active={fpCountries===null} onClick={()=>setFpCountries(null)}>All</Pill>
                    {allCountries.filter(c=>(epmData?.fuelPrice||{})[c]).map(c=>(
                      <Pill key={c} active={fpCountries?.includes(c)??false}
                        onClick={()=>setFpCountries(prev=>{
                          if (prev===null) return [c];
                          const n=prev.includes(c)?prev.filter(x=>x!==c):[...prev,c];
                          return n.length===0?null:n;
                        })}>
                        {c}
                      </Pill>
                    ))}
                  </div>
                </div>
                {(() => {
                  const fd = buildFuelPriceData();
                  return fd.datasets.length > 0 ? (
                    <>
                      <div style={{ display:'flex', gap:6, alignItems:'flex-start' }}>
                        <div style={{ flex:1, minWidth:0 }}>
                          <CJChart name={ttl('Fuel prices',fpCountries?fpCountries.join(', '):countryNameDecoded)} type="line" height={170} data={fd}
                            options={{ ...cjDefaults(t),
                              scales: {
                                x: { grid:{color:t.panelBorder}, ticks:{color:t.muted,font:{size:8},maxTicksLimit:8} },
                                y: { grid:{color:t.panelBorder}, ticks:{color:t.muted,font:{size:9}},
                                  title:{display:true,text:'USD/MBtu',color:t.muted,font:{size:8}} },
                              } }}
                          />
                        </div>
                        <div style={{ width:90, flexShrink:0, display:'flex', flexDirection:'column', gap:2, paddingTop:4, maxHeight:170, overflowY:'auto' }}>
                          {fd.datasets.map((ds,i)=>(
                            <div key={ds.label} style={{ display:'flex', alignItems:'center', gap:3 }}>
                              <div style={{ width:12, height:2, borderRadius:1, backgroundColor:typeof ds.borderColor==='string'?ds.borderColor:ZONE_PALETTE[i%ZONE_PALETTE.length], flexShrink:0 }}/>
                              <span style={{ fontSize:'0.4rem', color:t.muted, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{ds.label}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  ) : <div style={{ color:t.lblMuted, fontSize:'0.55rem' }}>No fuel price data available.</div>;
                })()}
              </div>
            )}
          </div>
        )}

        {/* ════════ TRADE ═══════════════════════════════════════════════════════ */}
        {hasData && activeTab === 'trade' && (
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            <VariantPicker t={t} scnMeta={scnMeta} param="pTransferLimit" value={varOverrides.pTransferLimit} onChange={setVariant} />
            <SectionTitle t={t}>NTC corridors ({refYr||'—'})</SectionTitle>
            {tradeCorridors.length > 0 ? (
              <div style={{ border:`1px solid ${t.panelBorder}`, borderRadius:6, overflow:'hidden' }}>
                {/* Header */}
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 90px 90px',
                  padding:'4px 10px', backgroundColor:hexA(t.panelBorder,0.4),
                  fontSize:'0.42rem', color:t.lblMuted, fontWeight:600, letterSpacing:'0.5px',
                  borderBottom:`1px solid ${t.panelBorder}` }}>
                  <span>Zone A</span><span>Zone B</span><span style={{textAlign:'center'}}>→ MW</span><span style={{textAlign:'center'}}>← MW</span>
                </div>
                {tradeCorridors.map(cor=>(
                  <div key={cor.key} style={{ display:'grid', gridTemplateColumns:'1fr 1fr 90px 90px',
                    padding:'6px 10px', borderTop:`1px solid ${t.panelBorder}`,
                    fontSize:'0.5rem', alignItems:'center',
                    backgroundColor: cor.isCountry ? hexA('#f0b030',0.06) : 'transparent' }}>
                    <div>
                      <div style={{ color:t.lbl, fontWeight: cor.isCountry?600:400, cursor:'pointer' }}
                        onClick={()=>navigate(`/region/${regionId}/zone/${encodeURIComponent(cor.z)}`)}>
                        {cor.z}
                      </div>
                      <div style={{ fontSize:'0.41rem', color:t.lblMuted }}>{cor.c}</div>
                    </div>
                    <div>
                      <div style={{ color:t.lbl, fontWeight: cor.isCountry?600:400, cursor:'pointer' }}
                        onClick={()=>navigate(`/region/${regionId}/zone/${encodeURIComponent(cor.z2)}`)}>
                        {cor.z2}
                      </div>
                      <div style={{ fontSize:'0.41rem', color:t.lblMuted }}>{cor.c2}</div>
                    </div>
                    <div style={{ textAlign:'center' }}>
                      <span style={{ color:cor.mwFwd>0?t.lbl:t.lblMuted, fontWeight:600 }}>{cor.mwFwd>0?fmt(cor.mwFwd):'—'}</span>
                    </div>
                    <div style={{ textAlign:'center' }}>
                      <span style={{ color:cor.mwRev>0?t.lbl:t.lblMuted, fontWeight:600 }}>{cor.mwRev>0?fmt(cor.mwRev):'—'}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : <div style={{ color:t.lblMuted, fontSize:'0.58rem' }}>No NTC data available.</div>}

            {/* Corridor bar chart for this country */}
            {(() => {
              const countryCorrData = tradeCorridors.filter(c=>c.isCountry);
              if (!countryCorrData.length) return null;
              return (
                <div style={{ marginTop:4 }}>
                  <SectionTitle t={t}>This country's corridors (MW)</SectionTitle>
                  <CJChart name={ttl('Corridor capacity (MW)',countryNameDecoded,epmYear)} type="bar" height={Math.min(countryCorrData.length*22+30, 200)}
                    data={{ labels: countryCorrData.map(c=>`${c.z}↔${c.z2}`),
                      datasets:[{ data:countryCorrData.map(c=>Math.max(c.mwFwd,c.mwRev)),
                        backgroundColor:hexA('#f0b030',0.75), borderWidth:0, barThickness:12 }] }}
                    options={{ ...cjDefaults(t), indexAxis:'y',
                      scales: {
                        x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},
                        y:{grid:{display:false},ticks:{color:t.muted,font:{size:8}}},
                      }}}
                  />
                </div>
              );
            })()}
          </div>
        )}

        {/* ════════ SCENARIOS ═══════════════════════════════════════════════════ */}
        {activeTab === 'scenario' && (
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            {!scnMeta?.scenarios?.length ? (
              <div style={{ color:t.lblMuted, fontSize:'0.55rem', lineHeight:1.6 }}>
                No scenario matrix (<code>scenarios.csv</code>) found for this study.
                <div style={{ marginTop:6, fontSize:'0.5rem' }}>
                  EPM drives inputs from <b>config.csv</b> (base case) and <b>scenarios.csv</b>
                  {' '}(per–data-type variant overrides). Only the base case was reachable
                  {' '}for this branch, so every input below is the config.csv default.
                </div>
              </div>
            ) : (() => {
              const list = scnMeta.scenarios
                .filter(s => s.toLowerCase().includes(scnFilter.toLowerCase()));
              return (
                <>
                  <div style={{ fontSize:'0.5rem', color:t.muted, lineHeight:1.6 }}>
                    <b>{scnMeta.scenarios.length}</b> scenario{scnMeta.scenarios.length!==1?'s':''} in
                    {' '}<code>{scnMeta.scenariosFile}</code>. Each row below shows the inputs a scenario
                    {' '}<b>changes from the base case</b> (a △ variant file); everything else uses the default.
                  </div>
                  <input value={scnFilter} onChange={e=>setScnFilter(e.target.value)}
                    placeholder="Filter scenarios…"
                    style={{ fontSize:'0.5rem', fontFamily:'inherit', padding:'4px 8px', borderRadius:4,
                      border:`1px solid ${t.panelBorder}`, backgroundColor:t.panel, color:t.muted, width:'100%' }} />
                  {list.length===0 && <div style={{ color:t.lblMuted, fontSize:'0.5rem' }}>No scenario matches “{scnFilter}”.</div>}
                  {list.map(s => {
                    const diff = scnMeta.diffByScenario[s] || [];
                    return (
                      <div key={s} style={{ border:`1px solid ${t.panelBorder}`, borderRadius:6, overflow:'hidden' }}>
                        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center',
                          padding:'6px 10px', backgroundColor:hexA(t.panelBorder,0.35) }}>
                          <span style={{ fontSize:'0.55rem', fontWeight:700, color:t.lbl }}>{s}</span>
                          <span style={{ fontSize:'0.42rem', color:t.lblMuted }}>
                            {diff.length ? `${diff.length} variant${diff.length!==1?'s':''}` : 'base only'}
                          </span>
                        </div>
                        {diff.length===0 ? (
                          <div style={{ padding:'6px 10px', fontSize:'0.46rem', color:t.lblMuted, fontStyle:'italic' }}>
                            Identical to the base case.
                          </div>
                        ) : (
                          <div style={{ padding:'4px 0' }}>
                            {diff.map(d => (
                              <div key={d.paramName} style={{ display:'grid', gridTemplateColumns:'70px 1fr',
                                gap:8, padding:'3px 10px', fontSize:'0.44rem', alignItems:'baseline' }}>
                                <span style={{ color:t.lblMuted }}>{d.section || '—'}</span>
                                <span>
                                  <span style={{ color:t.lbl, fontWeight:600 }}>{d.paramName}</span>
                                  <span style={{ color:'#E8A33D', marginLeft:5 }}>△ {baseName(d.file)}</span>
                                  {d.defaultFile && <span style={{ color:t.lblMuted, marginLeft:5 }}>(default: {baseName(d.defaultFile)})</span>}
                                  {d.label && <div style={{ color:t.lblMuted, fontSize:'0.4rem', marginTop:1 }}>{d.label}</div>}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              );
            })()}
          </div>
        )}

        {/* ════════ ABOUT ═══════════════════════════════════════════════════════ */}
        {activeTab === 'about' && (
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            <div style={{ border:`1px solid ${t.panelBorder}`, borderRadius:8, padding:'12px 14px',
              fontSize:'0.58rem', color:t.muted, lineHeight:1.6 }}>
              <div style={{ fontSize:'0.6rem', fontWeight:700, color:t.lbl, marginBottom:6 }}>
                {countryNameDecoded} — EPM Study
              </div>
              <div>Zones: {countryZoneIds.join(', ')||'—'}</div>
              <div style={{ marginTop:4 }}>Part of <b style={{color:t.lbl}}>{region.name}</b></div>
              {region.epm && (
                <>
                  <div style={{ marginTop:4 }}>
                    <b style={{color:t.lbl}}>Branch:</b>{' '}
                    <code style={{fontSize:'0.52rem'}}>{region.epm.branch}</code>
                  </div>
                  <div>
                    <b style={{color:t.lbl}}>Data folder:</b>{' '}
                    <code style={{fontSize:'0.52rem'}}>{region.epm.dataFolder}</code>
                  </div>
                </>
              )}
            </div>
            {region.epm && (
              <a href={`https://htmlpreview.github.io/?https://raw.githubusercontent.com/ESMAP-World-Bank-Group/EPM/${region.epm.branch}/epm/input/${region.epm.dataFolder}/DATA_SOURCES.html`}
                target="_blank" rel="noreferrer"
                style={{ textDecoration:'none' }}>
                <div style={{ border:`1px solid ${t.panelBorder}`, borderRadius:8, padding:'10px 14px',
                  display:'flex', alignItems:'center', justifyContent:'space-between',
                  cursor:'pointer', backgroundColor:t.panel }}
                  onMouseEnter={e=>e.currentTarget.style.backgroundColor=t.isDark?'rgba(255,255,255,0.05)':'rgba(0,0,0,0.03)'}
                  onMouseLeave={e=>e.currentTarget.style.backgroundColor=t.panel}>
                  <div>
                    <div style={{ fontSize:'0.6rem', fontWeight:700, color:t.lbl, marginBottom:2 }}>Data Sources</div>
                    <div style={{ fontSize:'0.52rem', color:t.muted }}>Detailed methodology and source references for all input data</div>
                  </div>
                  <span style={{ fontSize:'0.85rem', color:t.lblMuted, marginLeft:10 }}>↗</span>
                </div>
              </a>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
