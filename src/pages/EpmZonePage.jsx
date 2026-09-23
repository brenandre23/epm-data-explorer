import { useEffect, useRef, useState, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import { track } from '../analytics';
import { useTheme } from '../App';
import { getT, mapStyle } from '../constants';
import {
  fetchEpmCSV, fetchLinestringGeoJSON, fetchZonesGeoJSON, fetchZonesOffgridGeoJSON, fetchZcmapList, fetchDataFolderList,
  fetchRunList, fetchGitHubDir, fetchResultCSV, resolveOutputDir,
  processGenData, processDemand, processDemandData, processNTC, processTransmissionResults,
  processDemandProfileFull, processVREProfile, processAvailability, processFuelPrice, processHours, processTimeSlices,
  availableYears, EPM_FUEL_COLORS, normalizeFuel,
} from '../utils/epmFetch';
import { buildTimeAxis, buildSeasonAxis, blockLabels, axisTicks, bandingPlugin, dayWeights } from '../utils/timeAxis';
import { addOffgridLayers } from '../utils/offgridZones';
import { fetchScenarioConfig, resolveFile } from '../utils/epmScenarios';
import { zoneCentroidMap } from '../utils/centroids';
import VariantPicker from '../components/VariantPicker';
import ScenarioTab from '../components/ScenarioTab';
import { fetchCountries, fetchBoundaries, addCountriesSource, addBaseLayers, raiseBoundaries } from '../utils/basemap';
import { source, layer } from '../utils/mapSource';
import { usePromotedEpmData } from '../utils/usePromotedZones';
import CJChart from '../components/CJChart';
import MapDownload from '../components/MapDownload';
import { ttl } from '../utils/chartTitle';
import PanelZoomControl, { usePanelZoom, unzoom } from '../components/PanelZoom';
import { dataPath } from '../utils/paths';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAP_PALETTE   = ['#1B6CA8','#36B5B5','#E8C547','#4DA6FF','#0D7680','#85C1E9','#2E9EC8','#5EBCBA','#1A5276','#7EC8E3','#14A094','#4CAFE8','#EDD770','#AED6F1','#1F618D','#0A6B70'];
const CHART_PALETTE = ['#3B82F6','#10B981','#F59E0B','#8B5CF6','#06B6D4','#EC4899','#84CC16','#F97316','#6366F1','#14B8A6','#A855F7','#EAB308','#22D3EE','#FB7185','#2DD4BF','#818CF8'];
const ZONE_PALETTE  = CHART_PALETTE;
const VRE_DISPLAY  = { pv:'Solar PV', solar:'Solar PV', onshorewind:'Onshore Wind', wind:'Wind', offshorewind:'Offshore Wind', ror:'Run-of-River', rof:'Run-of-River' };
const VRE_COLOR    = { pv:'#FFD700', solar:'#FFD700', onshorewind:'#44DAEC', wind:'#44DAEC', offshorewind:'#7CC8FA', ror:'#1E9AF5', rof:'#1E9AF5' };
const STATUS_COLOR  = { 1: '#52C860', 2: '#FFD700', 3: '#9A9EF5' };
const STATUS_LABEL  = { 1: 'Existing', 2: 'Committed', 3: 'Candidate' };
const RE_FUELS      = new Set(['hydro','solar','wind','biomass','geothermal','biogas','waste']);
const SEASON_LABEL  = { Q1: 'Winter', Q2: 'Spring', Q3: 'Summer', Q4: 'Autumn' };
const VRE_TECH_LABEL = { solar: 'Solar', wind: 'Wind', ror: 'Run-of-River' };

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
function avgProfile(profiles) {
  if (!profiles.length) return null;
  return Array.from({ length: profiles[0]?.length || 24 }, (_, i) => profiles.reduce((s, p) => s + (p[i] || 0), 0) / profiles.length);
}

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
function buildZoneNtcFeatures(epmData, zoneCentroids, linestringGJ, outputNtc = [], year = null) {
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
        properties: { z: r.z, z_other: r.z2, ntc_mw: r.years[ntcYr] || 0 },
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
        return { ...f, properties: { ...f.properties, ntc_mw: entry?.years[ntcYr] || 0 } }; });
  }
  return [];
}

export default function EpmZonePage() {
  const { regionId, zoneId } = useParams();
  const zoneIdDecoded = decodeURIComponent(zoneId);
  const { theme } = useTheme();
  const t = getT(theme);
  const navigate = useNavigate();

  const containerRef = useRef(null);
  const mapRef       = useRef(null);
  const markerRef    = useRef(null);

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

  // ── Scenario / variant state ──────────────────────────────────────────────────
  const [scnMeta,      setScnMeta]      = useState(undefined);
  const [varOverrides, setVarOverrides] = useState({});
  const setVariant = (param, file) => setVarOverrides(o => {
    const next = { ...o };
    if (file) next[param] = file; else delete next[param];
    return next;
  });

  // ── Supply state ────────────────────────────────────────────────────────────
  const [statusFilter,  setStatusFilter]  = useState(new Set([1]));
  const [hiddenFuels,   setHiddenFuels]   = useState(new Set());
  const [supplySort,    setSupplySort]    = useState({ col: 'capacity', dir: 'desc' });
  const [selectedPlant, setSelectedPlant] = useState(null);

  // ── Demand state ────────────────────────────────────────────────────────────
  const [demandProfileMode, setDemandProfileMode] = useState('full');
  const [demandSeason,      setDemandSeason]      = useState('Q1');
  const [demandDay,         setDemandDay]         = useState('avg');

  // ── Resources state ─────────────────────────────────────────────────────────
  const [resSection,    setResSection]    = useState('vre');
  const [vreTech,       setVreTech]       = useState('');
  const [vreProfileMode, setVreProfileMode] = useState('full');
  const [vreSeason,     setVreSeason]     = useState('Q1');
  const [vreDay,        setVreDay]        = useState('avg');
  const [fpCountries,   setFpCountries]   = useState(null);

  // ── Load region ─────────────────────────────────────────────────────────────
  useEffect(() => {
    track('zone_view', { region: regionId, zone: zoneIdDecoded });
  }, [regionId, zoneIdDecoded]);

  // Region (+ its EPM data) only depends on the region, NOT the zone — so switching
  // zone within a region doesn't reload everything / rebuild the map (no black flash).
  useEffect(() => {
    fetch(dataPath('regions.json')).then(r => r.json()).then(d => {
      const r = (d.regions || []).find(r => r.id === regionId);
      setRegion(r || null);
    });
  }, [regionId]);

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
      fetchEpmCSV(branch, activeFolder, 'pHours.csv'),
      fetchEpmCSV(branch, activeFolder, rf('pDemandData', 'load/pDemandData.csv')),
      fetchZonesOffgridGeoJSON(branch, activeFolder),
    ]).then(([genRaw, demandRaw, ntcRaw, zcmapRaw, linestringGJ, profileRaw, zonesGJ, vreRaw, availRaw, fpRaw, hoursRaw, demandDataRaw, offgridGJ]) => {
      setEpmData(prev => ({
        gen:               genRaw    ? processGenData(genRaw)              : [],
        // Folders with a full load table instead of a forecast (v7.9 style) fall back to pDemandData
        demand:            demandRaw?.length ? processDemand(demandRaw)
                                             : processDemandData(demandDataRaw, hoursRaw),
        ntc:               ntcRaw    ? processNTC(ntcRaw)                  : [],
        zcmap:             zcmapRaw  || [],
        demandProfileFull: profileRaw ? processDemandProfileFull(profileRaw) : {},
        vreProfile:        vreRaw    ? processVREProfile(vreRaw)           : {},
        availability:      availRaw  ? processAvailability(availRaw)       : {},
        fuelPrice:         fpRaw     ? processFuelPrice(fpRaw)             : {},
        hours:             hoursRaw  ? processHours(hoursRaw)              : {},
        // 24 for a chronological model, 6-7 for a load-block one (see processTimeSlices)
        timeSlices:        hoursRaw  ? processTimeSlices(hoursRaw)         : {nT:24,isHourly:true,hours:{}},
        // Preserve geojson on variant-only change (no region/folder/zcmap change).
        linestringGJ: (regionOrFolderChanged || zcmapChanged || !prev) ? linestringGJ : prev.linestringGJ,
        zonesGJ:      (regionOrFolderChanged || zcmapChanged || !prev) ? zonesGJ      : prev.zonesGJ,
        offgridGJ:    (regionOrFolderChanged || zcmapChanged || !prev) ? offgridGJ    : prev.offgridGJ,
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

  // ── Map ──────────────────────────────────────────────────────────────────────
  // Zone centroids — shared by the map build + the lightweight zone-switch effect.
  const zoneCentroids = useMemo(() => {
    return zoneCentroidMap(epmData?.zonesGJ, epmData?.linestringGJ);
  }, [epmData]);

  // Build the map ONCE per region / data / theme — NOT per zone.
  useEffect(() => {
    if (!containerRef.current || !region || !epmData) return;
    const { linestringGJ, zonesGJ } = epmData;
    if (!linestringGJ && !zonesGJ) return;

    const zcmapRows     = epmData.zcmap;
    const zoneToCountry = Object.fromEntries(zcmapRows.map(r => [r.z, r.c]));

    const center = zoneCentroids[zoneIdDecoded] || [35, 39];

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: mapStyle(theme),
      center, zoom: 5, minZoom: 1, maxZoom: 14, canvasContextAttributes: { preserveDrawingBuffer: true }, attributionControl: false,
    });
    mapRef.current = map;
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10,
      className: `popup-${theme}` });

    map.on('load', async () => {
      const tv = getT(theme);

      const countries = await fetchCountries('10m');
      const boundaries = await fetchBoundaries('10m');
      addCountriesSource(map, countries);
      addBaseLayers(map, tv, boundaries);

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
          filter: ['!=', ['get', 'z'], zoneIdDecoded],
          paint: { 'fill-color': fillExpr, 'fill-opacity': 0.07 } });
        map.addLayer({ id: 'zone-border-dim', type: 'line', source: 'zones',
          filter: ['!=', ['get', 'z'], zoneIdDecoded],
          paint: { 'line-color': fillExpr, 'line-width': 0.6, 'line-opacity': 0.2 } });
        map.addLayer({ id: 'zone-fill-active', type: 'fill', source: 'zones',
          filter: ['==', ['get', 'z'], zoneIdDecoded],
          paint: { 'fill-color': fillExpr, 'fill-opacity': 0.45 } });
        map.addLayer({ id: 'zone-border-active', type: 'line', source: 'zones',
          filter: ['==', ['get', 'z'], zoneIdDecoded],
          paint: { 'line-color': fillExpr, 'line-width': 2.5, 'line-opacity': 1 } });
        map.addLayer({ id: 'zone-hover', type: 'fill', source: 'zones',
          filter: ['==', ['get', 'z'], ''], paint: { 'fill-color': fillExpr, 'fill-opacity': 0.35 } });

        let hovZ = null;
        map.on('mousemove', 'zone-fill-dim', e => {
          map.getCanvas().style.cursor = 'pointer';
          const z = e.features[0].properties.z;
          if (z !== hovZ) { hovZ = z; map.setFilter('zone-hover', ['==', ['get', 'z'], z]); }
          const c = zoneToCountry[z] || '';
          popup.setLngLat(e.lngLat)
            .setHTML(`<b>${z}</b>${c ? `<br><span style="opacity:.65;font-size:0.7em">${c}</span>` : ''}`)
            .addTo(map);
        });
        map.on('mouseleave', 'zone-fill-dim', () => {
          map.getCanvas().style.cursor = ''; hovZ = null;
          map.setFilter('zone-hover', ['==', ['get', 'z'], '']); popup.remove();
        });
        map.on('click', 'zone-fill-dim', e =>
          navigate(`/region/${regionId}/zone/${encodeURIComponent(e.features[0].properties.z)}`));
      }

      // ── Areas of the modelled countries that belong to no zone ─────────────
      addOffgridLayers(map, tv, epmData.offgridGJ);

      // NTC lines
      {
        const ntcFeatures = buildZoneNtcFeatures(epmData, zoneCentroids, linestringGJ, outputNtc);
        if (ntcFeatures.length > 0) {
          map.addSource('ntc-lines', { type:'geojson', data:{type:'FeatureCollection',features:ntcFeatures} });
          map.addLayer({ id:'ntc-lines-bg',     type:'line', source:'ntc-lines', paint:{'line-color':'#f0b030','line-width':0.8,'line-opacity':0.2} });
          const zoneNtcFilter = ['any',['==',['get','z'],zoneIdDecoded],['==',['get','z_other'],zoneIdDecoded]];
          map.addLayer({ id:'ntc-lines-active', type:'line', source:'ntc-lines', filter:zoneNtcFilter, layout:{'line-cap':'round'},
            paint:{'line-color':'#f0b030','line-width':['interpolate',['linear'],['get','ntc_mw'],0,1,500,2,2000,3.5,8000,6],'line-opacity':0.95} });
          map.addLayer({ id:'ntc-labels', type:'symbol', source:'ntc-lines', filter:zoneNtcFilter,
            layout:{'text-field':['concat',['to-string',['round',['get','ntc_mw']]],' MW'],'text-size':8,'symbol-placement':'line-center','text-allow-overlap':false},
            paint:{'text-color':'#b07800','text-halo-color':'rgba(255,255,255,0.9)','text-halo-width':1.5} });
        }
      }

      if (zoneCentroids[zoneIdDecoded]) {
        const el = document.createElement('div');
        el.style.cssText = `font-size:0.55rem;font-weight:700;font-family:"Open Sans", system-ui, sans-serif;color:${tv.lbl};background:${tv.panel};border:1.5px solid ${tv.panelBorder};border-radius:4px;padding:2px 7px;white-space:nowrap;pointer-events:none;box-shadow:0 1px 4px rgba(0,0,0,.22);`;
        el.textContent = zoneIdDecoded;
        markerRef.current = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -4] })
          .setLngLat(zoneCentroids[zoneIdDecoded]).addTo(map);
      }
      raiseBoundaries(map);
    });

    return () => {
      popup.remove();
      markerRef.current?.remove();
      markerRef.current = null;
      mapRef.current?.remove();
    };
  }, [region, theme, epmData?.linestringGJ, epmData?.zonesGJ]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Zone switch: update highlight + marker + recenter WITHOUT rebuilding the map ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded() || !layer(map, 'zone-fill-active')) return;
    map.setFilter('zone-fill-dim',     ['!=', ['get', 'z'], zoneIdDecoded]);
    map.setFilter('zone-border-dim',   ['!=', ['get', 'z'], zoneIdDecoded]);
    map.setFilter('zone-fill-active',  ['==', ['get', 'z'], zoneIdDecoded]);
    map.setFilter('zone-border-active',['==', ['get', 'z'], zoneIdDecoded]);
    const zoneNtcFilter = ['any', ['==', ['get', 'z'], zoneIdDecoded], ['==', ['get', 'z_other'], zoneIdDecoded]];
    if (layer(map, 'ntc-lines-active')) map.setFilter('ntc-lines-active', zoneNtcFilter);
    if (layer(map, 'ntc-labels'))       map.setFilter('ntc-labels', zoneNtcFilter);

    const center = zoneCentroids[zoneIdDecoded];
    markerRef.current?.remove();
    if (center) {
      const tv = getT(theme);
      const el = document.createElement('div');
      el.style.cssText = `font-size:0.55rem;font-weight:700;font-family:"Open Sans", system-ui, sans-serif;color:${tv.lbl};background:${tv.panel};border:1.5px solid ${tv.panelBorder};border-radius:4px;padding:2px 7px;white-space:nowrap;pointer-events:none;box-shadow:0 1px 4px rgba(0,0,0,.22);`;
      el.textContent = zoneIdDecoded;
      markerRef.current = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -4] })
        .setLngLat(center).addTo(map);
      map.easeTo({ center, duration: 600 });
    }
  }, [zoneIdDecoded, zoneCentroids, theme]);

  // NTC lines — update MW in place when trade data changes (no map rebuild → no flash).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !epmData || !map.isStyleLoaded() || !source(map, 'ntc-lines')) return;
    const features = buildZoneNtcFeatures(epmData, zoneCentroids, epmData.linestringGJ, outputNtc, epmYear);
    source(map, 'ntc-lines').setData({ type: 'FeatureCollection', features });
  }, [epmData, zoneCentroids, outputNtc, epmYear]);

  // ── Computed values ───────────────────────────────────────────────────────────

  const zcmapRows   = epmData?.zcmap || [];
  const countryName = zcmapRows.find(r => r.z === zoneIdDecoded)?.c || '';
  const allCountries = useMemo(() => [...new Set(zcmapRows.map(r => r.c))].sort(), [zcmapRows]);

  const zoneGen      = useMemo(() => (epmData?.gen||[]).filter(r=>r.zone===zoneIdDecoded), [epmData, zoneIdDecoded]);
  const existingGen  = useMemo(() => zoneGen.filter(r=>r.status===1), [zoneGen]);
  const committedGen = useMemo(() => zoneGen.filter(r=>r.status===2), [zoneGen]);
  const candidateGen = useMemo(() => zoneGen.filter(r=>r.status===3), [zoneGen]);

  const totalMW  = existingGen.reduce((s,r)=>s+r.capacity,0);
  const reMW     = existingGen.filter(r=>RE_FUELS.has(r.fuel)).reduce((s,r)=>s+r.capacity,0);
  const reShare  = totalMW > 0 ? Math.round(reMW/totalMW*100) : 0;

  const allYears   = availableYears(epmData?.demand||[]);
  const refYr      = allYears.find(y=>y==='2024')||allYears[0];
  const zoneDemand = useMemo(()=>(epmData?.demand||[]).filter(r=>r.zone===zoneIdDecoded),[epmData,zoneIdDecoded]);
  const peakMW     = zoneDemand.filter(r=>r.type==='peak').reduce((s,r)=>s+(r.years[refYr]||0),0);
  const energyGWh  = zoneDemand.filter(r=>r.type==='energy').reduce((s,r)=>s+(r.years[refYr]||0),0);

  const fuelAgg  = useMemo(()=>{ const o={}; for(const r of existingGen) o[r.fuel]=(o[r.fuel]||0)+r.capacity; return o; },[existingGen]);
  const fuelData = Object.entries(fuelAgg).map(([fuel,mw])=>({fuel,mw:Math.round(mw)})).sort((a,b)=>b.mw-a.mw);

  const ntcRows = epmData?.ntc || [];
  const ntcYrs  = availableYears(ntcRows);
  const ntcRefYr = ntcYrs.find(y=>y==='2024')||ntcYrs[0];

  // Deduplicated connections from this zone
  const connections = useMemo(()=>{
    const seen = new Set();
    return ntcRows.filter(r=>{
      if(r.z!==zoneIdDecoded && r.z2!==zoneIdDecoded) return false;
      const neighbor = r.z===zoneIdDecoded ? r.z2 : r.z;
      if(seen.has(neighbor)) return false; seen.add(neighbor); return true;
    }).map(r=>({
      neighbor: r.z===zoneIdDecoded?r.z2:r.z,
      neighborCountry: zcmapRows.find(z=>z.z===(r.z===zoneIdDecoded?r.z2:r.z))?.c||'',
      mw: r.years[ntcRefYr]||0,
    })).sort((a,b)=>b.mw-a.mw);
  },[ntcRows,zoneIdDecoded,zcmapRows,ntcRefYr]); // eslint-disable-line react-hooks/exhaustive-deps

  // Supply filtered + sorted
  const filteredPlants = useMemo(()=>zoneGen.filter(r=>statusFilter.has(r.status)&&!hiddenFuels.has(r.fuel)),[zoneGen,statusFilter,hiddenFuels]);
  const sortedPlants   = useMemo(()=>{
    const {col,dir}=supplySort;
    return [...filteredPlants].sort((a,b)=>{
      let va=a[col],vb=b[col];
      if(typeof va==='string'){va=va.toLowerCase();vb=vb.toLowerCase();}
      const cmp=va<vb?-1:va>vb?1:0;
      return dir==='asc'?cmp:-cmp;
    });
  },[filteredPlants,supplySort]);

  const hasData = !!(epmData && !loading);
  const [panelWidth, setPanelWidth] = useState(600);
  const { zoom, inc, dec, reset } = usePanelZoom();
  const isDrRef = useRef(false); const drStartX = useRef(0); const drStartW = useRef(0);

  if (!region) return <div style={{ padding: 40, color: t.text }}>Loading…</div>;

  // ── Helpers ──────────────────────────────────────────────────────────────────

  const Pill = ({ active, onClick, children, color }) => (
    <button onClick={onClick} style={{
      fontSize:'0.44rem', fontFamily:'inherit', padding:'3px 8px',
      border:`1px solid ${active?(color||'rgba(74,143,204,0.65)'):t.panelBorder}`,
      borderRadius:3, cursor:'pointer',
      backgroundColor: active?(color?hexA(color,0.15):'rgba(74,143,204,0.12)'):'transparent',
      color: active?(color||t.lbl):t.lblMuted, fontWeight: active?600:400,
    }}>{children}</button>
  );

  const handleSort = col => setSupplySort(s=>({ col, dir:s.col===col&&s.dir==='desc'?'asc':'desc' }));
  const SortBtn = ({ col, label }) => (
    <button onClick={()=>handleSort(col)} style={{ background:'none',border:'none',cursor:'pointer',padding:0,
      fontSize:'0.42rem',color:supplySort.col===col?t.lbl:t.lblMuted,fontWeight:supplySort.col===col?700:400 }}>
      {label}{supplySort.col===col?(supplySort.dir==='desc'?' ↓':' ↑'):''}
    </button>
  );

  const toggleStatus = s => { setStatusFilter(f=>{const n=new Set(f);n.has(s)?n.delete(s):n.add(s);return n;}); setSelectedPlant(null); };

  const getProfile = (profileData, zone, season, day) => {
    const sp = profileData[zone]?.[season];
    if (!sp) return null;
    if (day==='avg') { const days=Object.keys(sp); return days.length?avgProfile(days.map(d=>sp[d])):null; }
    return sp[day]||null;
  };

  // Fuel price builder
  const buildFuelPriceData = () => {
    const fp = epmData?.fuelPrice||{};
    const clist = (fpCountries||allCountries).filter(c=>fp[c]);
    if(!clist.length) return {labels:[],datasets:[]};
    const allFuels=[...new Set(clist.flatMap(c=>Object.keys(fp[c]||{})))];
    const yearCols=Object.keys(Object.values(fp[clist[0]]||{})[0]||{}).filter(k=>/^\d{4}$/.test(k)).sort().filter(y=>y<='2050');
    return { labels:yearCols, datasets:allFuels.map((fuel,i)=>({
      label:fuel,
      data:yearCols.map(y=>{const vals=clist.map(c=>fp[c]?.[fuel]?.[y]).filter(v=>v!=null&&v>0);return vals.length?+(vals.reduce((s,v)=>s+v,0)/vals.length).toFixed(2):null;}),
      borderColor:EPM_FUEL_COLORS[normalizeFuel(fuel)]||ZONE_PALETTE[i%ZONE_PALETTE.length],
      borderWidth:2,pointRadius:0,tension:0.2,fill:false,spanGaps:true,
    }))};
  };

  // ── Tab config ────────────────────────────────────────────────────────────────
  const TABS = ['overview','demand','supply','resources','connections','scenario','about'];
  const TAB_LABELS = { overview:'Overview', demand:'Demand', supply:'Supply', resources:'Resources', connections:'Trade', scenario:'Scenarios', about:'About' };

  // ── JSX ───────────────────────────────────────────────────────────────────────
  return (
    <div style={{ display:'flex', height:'calc(100vh - 46px)' }}
      onMouseMove={e=>{ if(!isDrRef.current)return; setPanelWidth(w=>Math.max(380,drStartW.current+(drStartX.current-e.clientX))); }}
      onMouseUp={()=>{isDrRef.current=false;}} onMouseLeave={()=>{isDrRef.current=false;}}
    >

      {/* Map */}
      <div style={{ position:'relative', flex:1 }}>
        <div ref={containerRef} style={{ width:'100%', height:'100%', backgroundColor:t.bg }} />
        <MapDownload mapRef={mapRef} t={t} name={()=>ttl(`${zoneIdDecoded} map`,epmYear)}/>
        <div style={{ position:'absolute', top:10, left:10, zIndex:10, display:'flex', gap:4, alignItems:'center',
          fontSize:'0.52rem', color:t.text, backgroundColor:t.panel, border:`1px solid ${t.panelBorder}`,
          borderRadius:5, padding:'4px 10px', boxShadow:'0 1px 4px rgba(0,0,0,.18)' }}>
          <Link to="/" style={{ color:t.lblMuted, textDecoration:'none' }}>World</Link>
          <span style={{ color:t.lblMuted }}>›</span>
          <Link to={`/region/${regionId}`} style={{ color:t.lblMuted, textDecoration:'none' }}>{region.name}</Link>
          <span style={{ color:t.lblMuted }}>›</span>
          {countryName && (
            <><Link to={`/region/${regionId}/country/${encodeURIComponent(countryName)}`}
              style={{ color:t.lblMuted, textDecoration:'none' }}>{countryName}</Link>
            <span style={{ color:t.lblMuted }}>›</span></>
          )}
          <span style={{ color:t.lbl, fontWeight:600 }}>{zoneIdDecoded}</span>
        </div>
        {zcmapList.length > 1 && (
          <div style={{ position:'absolute', bottom:10, left:10, zIndex:10, display:'flex', gap:4, alignItems:'center',
            fontSize:'0.5rem', backgroundColor:t.panel, border:`1px solid ${t.panelBorder}`,
            borderRadius:5, padding:'4px 8px', boxShadow:'0 1px 4px rgba(0,0,0,.18)' }}>
            <span style={{ color:t.lblMuted }}>Zone map:</span>
            {zcmapList.map(zc => (
              <button key={zc} onClick={()=>setActiveZcmap(zc)} style={{
                fontFamily:'inherit', fontSize:'0.5rem', padding:'2px 8px', borderRadius:3,
                border:`1px solid ${activeZcmap===zc ? t.lbl : t.panelBorder}`,
                backgroundColor: activeZcmap===zc ? t.lbl : 'transparent',
                color: activeZcmap===zc ? t.panel : t.lblMuted,
                cursor:'pointer',
              }}>{zc}</button>
            ))}
          </div>
        )}
      </div>

      <div style={{width:5,flexShrink:0,cursor:'col-resize'}} onMouseDown={e=>{isDrRef.current=true;drStartX.current=e.clientX;drStartW.current=panelWidth;e.preventDefault();}}/>
      {/* Right panel */}
      <div style={{ zoom, width:unzoom(panelWidth,zoom), flexShrink:0, height:unzoom('100%',zoom), overflowY:'auto', padding:'18px 16px',
        backgroundColor:t.panel, borderLeft:`1px solid ${t.panelBorder}` }}>
        <PanelZoomControl t={t} zoom={zoom} inc={inc} dec={dec} reset={reset}/>

        {/* Header */}
        <div style={{ marginBottom:12 }}>
          {countryName && (
            <div style={{ fontSize:'0.52rem', color:t.lblMuted, marginBottom:2 }}>
              <Link to={`/region/${regionId}/country/${encodeURIComponent(countryName)}`}
                style={{ color:t.lblMuted, textDecoration:'none' }}>← {countryName}</Link>
            </div>
          )}
          <div style={{ fontSize:'1rem', fontWeight:700, color:t.lbl }}>{zoneIdDecoded}</div>
          <div style={{ fontSize:'0.55rem', color:t.lblMuted, marginTop:1 }}>EPM zone · {region.name}</div>
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
          {TABS.map(tab=>(
            <button key={tab} onClick={()=>setActiveTab(tab)} style={{
              fontSize:'0.5rem', fontFamily:'inherit', padding:'6px 10px', border:'none',
              borderBottom: activeTab===tab?`2px solid ${t.lbl}`:'2px solid transparent',
              backgroundColor:'transparent', color: activeTab===tab?t.lbl:t.lblMuted,
              cursor:'pointer', fontWeight: activeTab===tab?600:400,
            }}>{TAB_LABELS[tab]}</button>
          ))}
        </div>

        {loading && <div style={{ padding:'24px 0', textAlign:'center', color:t.lblMuted, fontSize:'0.6rem' }}>Loading EPM data…</div>}

        {/* ════════ OVERVIEW ════════════════════════════════════════════════════ */}
        {hasData && activeTab === 'overview' && (
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
            {/* KPIs + donut */}
            <div style={{ display:'flex', gap:12, alignItems:'flex-start' }}>
              <div style={{ flexShrink:0, width:100, textAlign:'center' }}>
                <CJChart name={ttl('Capacity mix by fuel (MW)',zoneIdDecoded,epmYear)} type="doughnut" height={100}
                  data={{ labels:Object.keys(fuelAgg), datasets:[{
                    data:Object.values(fuelAgg).map(v=>Math.round(v)),
                    backgroundColor:Object.keys(fuelAgg).map(f=>EPM_FUEL_COLORS[f]||'#aaa'),
                    borderWidth:1.5, borderColor:t.panel, hoverOffset:3,
                  }]}}
                  options={{ cutout:'60%', responsive:true, maintainAspectRatio:false, layout:{padding:3},
                    plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>` ${c.label}: ${fmt(c.parsed)} MW`}}} }}
                />
                <div style={{ fontSize:'0.4rem', color:t.lblMuted, marginTop:2 }}>Existing mix</div>
              </div>
              <div style={{ flex:1, display:'flex', flexDirection:'column', gap:5 }}>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:5 }}>
                  {[
                    { l:'Installed', v:totalMW>=1000?`${(totalMW/1000).toFixed(1)} GW`:`${fmt(totalMW)} MW` },
                    { l:`Peak ${refYr||''}`, v:peakMW>=1000?`${(peakMW/1000).toFixed(1)} GW`:`${fmt(peakMW)} MW` },
                    { l:`Energy ${refYr||''}`, v:energyGWh>=1000?`${(energyGWh/1000).toFixed(1)} TWh`:`${fmt(energyGWh)} GWh` },
                  ].map(({l,v})=>(
                    <div key={l} style={{ border:`1px solid ${t.panelBorder}`, borderRadius:5, padding:'6px 8px' }}>
                      <div style={{ fontSize:'0.4rem', color:t.lblMuted, marginBottom:2 }}>{l}</div>
                      <div style={{ fontSize:'0.68rem', fontWeight:700, color:t.lbl }}>{v||'—'}</div>
                    </div>
                  ))}
                </div>
                {/* Status breakdown */}
                <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:5 }}>
                  {[
                    { label:'Existing',  rows:existingGen,  color:STATUS_COLOR[1] },
                    { label:'Committed', rows:committedGen, color:STATUS_COLOR[2] },
                    { label:'Candidate', rows:candidateGen, color:STATUS_COLOR[3] },
                  ].map(({label,rows,color})=>{
                    const mw=rows.reduce((s,r)=>s+r.capacity,0);
                    return (
                      <div key={label} style={{ border:`1px solid ${t.panelBorder}`, borderRadius:5, padding:'6px 8px' }}>
                        <div style={{ display:'flex', alignItems:'center', gap:3, marginBottom:2 }}>
                          <div style={{ width:6, height:6, borderRadius:'50%', backgroundColor:color }}/>
                          <div style={{ fontSize:'0.39rem', color:t.lblMuted }}>{label}</div>
                        </div>
                        <div style={{ fontSize:'0.65rem', fontWeight:700, color:t.lbl }}>
                          {mw>=1000?`${(mw/1000).toFixed(1)} GW`:`${fmt(mw)} MW`}
                        </div>
                        <div style={{ fontSize:'0.38rem', color:t.lblMuted }}>{rows.length} units</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Fuel chart */}
            {fuelData.length > 0 && (
              <div>
                <SectionTitle t={t}>Existing capacity by fuel (MW)</SectionTitle>
                <div style={{ display:'flex', gap:6, alignItems:'flex-start' }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <CJChart name={ttl('Existing capacity by fuel (MW)',zoneIdDecoded)} type="bar" height={Math.min(fuelData.length*22+24,200)}
                      data={{ labels:fuelData.map(d=>d.fuel), datasets:[{
                        data:fuelData.map(d=>d.mw), backgroundColor:fuelData.map(d=>EPM_FUEL_COLORS[d.fuel]||'#aaa'),
                        borderWidth:0, barThickness:12 }] }}
                      options={{ ...cjDefaults(t), indexAxis:'y',
                        scales:{
                          x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},
                          y:{grid:{display:false},ticks:{color:t.muted,font:{size:9}}},
                        }}}
                    />
                  </div>
                  <div style={{ width:90, flexShrink:0, display:'flex', flexDirection:'column', gap:2, paddingTop:4, maxHeight:200, overflowY:'auto' }}>
                    {fuelData.map(d=>(
                      <div key={d.fuel} style={{ display:'flex', alignItems:'center', gap:3 }}>
                        <div style={{ width:8, height:8, borderRadius:2, backgroundColor:EPM_FUEL_COLORS[d.fuel]||'#aaa', flexShrink:0 }}/>
                        <span style={{ fontSize:'0.4rem', color:t.muted, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{d.fuel}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ════════ DEMAND ══════════════════════════════════════════════════════ */}
        {hasData && activeTab === 'demand' && (
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
            <div>
              <VariantPicker t={t} scnMeta={scnMeta} param="pDemandForecast" value={varOverrides.pDemandForecast} onChange={setVariant} />
              <VariantPicker t={t} scnMeta={scnMeta} param="pDemandProfile" value={varOverrides.pDemandProfile} onChange={setVariant} />
            </div>
            {/* Forecast */}
            <div>
              <SectionTitle t={t}>Demand forecast</SectionTitle>
              {zoneDemand.length > 0 ? (() => {
                const eby={}, pby={};
                for (const r of zoneDemand) for (const y of allYears) {
                  if(r.type==='energy') eby[y]=(eby[y]||0)+(r.years[y]||0);
                  if(r.type==='peak')   pby[y]=(pby[y]||0)+(r.years[y]||0);
                }
                return (
                  <div style={{ display:'flex', gap:6, alignItems:'flex-start' }}>
                    <div style={{ flex:1, minWidth:0 }}>
                      <CJChart name={ttl('Demand forecast',zoneIdDecoded)} type="bar" height={175}
                        data={{ labels:allYears, datasets:[
                          { type:'bar', label:'Energy (GWh)', yAxisID:'yL',
                            data:allYears.map(y=>Math.round(eby[y]||0)),
                            backgroundColor:hexA('#1a5fa8',0.72), borderWidth:0 },
                          { type:'line', label:'Peak (GW)', yAxisID:'yR',
                            data:allYears.map(y=>+((pby[y]||0)/1000).toFixed(2)),
                            borderColor:'#FF6B6B', borderWidth:2.5, pointRadius:2, tension:0.3, fill:false },
                        ]}}
                        options={{ ...cjDefaults(t),
                          scales:{
                            x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},maxTicksLimit:7}},
                            yL:{type:'linear',position:'left',title:{display:true,text:'GWh',color:t.muted,font:{size:8}},
                              grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9}}},
                            yR:{type:'linear',position:'right',title:{display:true,text:'GW',color:t.muted,font:{size:8}},
                              grid:{drawOnChartArea:false},ticks:{color:t.muted,font:{size:9}}},
                          }}}
                        onClickYear={setEpmYear}
                      />
                    </div>
                    <div style={{ width:90, flexShrink:0, display:'flex', flexDirection:'column', gap:3, paddingTop:4 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:3 }}>
                        <div style={{ width:12, height:8, borderRadius:1, backgroundColor:hexA('#1a5fa8',0.72), flexShrink:0 }}/>
                        <span style={{ fontSize:'0.4rem', color:t.muted }}>Energy (GWh)</span>
                      </div>
                      <div style={{ display:'flex', alignItems:'center', gap:3 }}>
                        <div style={{ width:12, height:2, borderRadius:1, backgroundColor:'#FF6B6B', flexShrink:0 }}/>
                        <span style={{ fontSize:'0.4rem', color:t.muted }}>Peak (GW)</span>
                      </div>
                    </div>
                  </div>
                );
              })() : <div style={{ color:t.lblMuted, fontSize:'0.58rem' }}>No demand data.</div>}
            </div>

            {/* Profile */}
            {(() => {
              const pf = epmData?.demandProfileFull||{};
              const hoursData = epmData?.hours||{};
              const timeSlices = epmData?.timeSlices||{nT:24,isHourly:true,hours:{}};
              const firstZ = pf[zoneIdDecoded];
              const availS = firstZ ? Object.keys(firstZ).sort() : [];
              const availD = firstZ && availS[0] ? Object.keys(firstZ[availS[0]]||{}).sort() : [];
              const totalD = Object.values(hoursData).reduce((s,dts)=>s+Object.values(dts||{}).reduce((a,b)=>a+b,0),0)||365;
              const isDark = t.isDark;

              const buildZoneProfile = () => {
                if (demandProfileMode === 'full') {
                  if (!firstZ || !availD.length) return { chartData:{labels:[],datasets:[]}, plugin:null };
                  // x layout: one slot per hour on a chronological model, width proportional to duration on a load-block one
                  const ax=buildTimeAxis(timeSlices,availS,availD);
                  const nPts=ax.slots.length;
                  const data=ax.slots.map(sl=>pf[zoneIdDecoded]?.[sl.q]?.[sl.d]?.[sl.i]??null);
                  const ds={label:zoneIdDecoded,data,borderColor:'#1a5fa8',borderWidth:2.5,pointRadius:0,tension:0.3,fill:true,backgroundColor:hexA('#1a5fa8',0.08),spanGaps:true};
                  const sepPlugin=bandingPlugin({ id:'zpSep', ax, seasons:availS, daytypes:availD,
                    hoursData, totalDays:totalD, isDark });
                  return { chartData:{labels:new Array(nPts).fill(''),datasets:[ds]}, plugin:sepPlugin, banded:true };
                }
                // 'All days' lays the season's day types side by side under the same banding as
                // the full year; the other choices are one curve, so they keep the hour labels.
                const sp=pf[zoneIdDecoded]?.[demandSeason];if(!sp)return null;
                const days=demandDay==='all'?availD:[demandDay==='avg'?availD[0]:demandDay];
                const banded=demandDay==='all'&&availD.length>1;
                const ax=buildSeasonAxis(timeSlices,demandSeason,days);
                const wts=dayWeights(hoursData,demandSeason,availD);
                const src=(demandDay==='avg'||demandDay==='all')?null:sp[demandDay];
                if(demandDay!=='avg'&&demandDay!=='all'&&!src)return null;
                const p=ax.slots.map(sl=>src?(src[sl.i]??null)
                  :demandDay==='all'?(sp[sl.d]?.[sl.i]??null)
                  :availD.reduce((a,d,k)=>a+(sp[d]?.[sl.i]||0)*wts[k],0));
                return { chartData:{labels:banded?new Array(ax.slots.length).fill(''):blockLabels(ax,timeSlices,demandSeason,days[0]),datasets:[{label:zoneIdDecoded,data:p,borderColor:'#1a5fa8',borderWidth:2.5,pointRadius:0,tension:0.35,fill:true,backgroundColor:hexA('#1a5fa8',0.08)}]},
                  plugin:banded?bandingPlugin({ id:'zpSepSeason', ax, seasons:[demandSeason], daytypes:days, hoursData, totalDays:totalD, isDark }):null,
                  banded, xTicks:banded?null:axisTicks(ax) };
              };
              const pd = buildZoneProfile();
              return (
                <div>
                  <SectionTitle t={t}>Load profile</SectionTitle>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:3, marginBottom:6, alignItems:'center' }}>
                    <Pill active={demandProfileMode==='full'} onClick={()=>setDemandProfileMode('full')}>Full Year</Pill>
                    {availS.map(s=>(
                      <Pill key={s} active={demandProfileMode==='season'&&demandSeason===s} onClick={()=>{setDemandProfileMode('season');setDemandSeason(s);}}>{s}</Pill>
                    ))}
                    {demandProfileMode==='season' && availD.length>0 && (
                      <>
                        <div style={{ width:1, backgroundColor:t.panelBorder, height:14 }}/>
                        <select value={demandDay} onChange={e=>setDemandDay(e.target.value)} style={{ fontSize:'0.44rem', fontFamily:'inherit', padding:'2px 5px', borderRadius:3, border:`1px solid ${t.panelBorder}`, backgroundColor:t.panel, color:t.muted, cursor:'pointer' }}>
                          <option value="avg">Avg</option>
                          <option value="all">All days</option>
                          {availD.map(d=><option key={d} value={d}>{d}</option>)}
                        </select>
                      </>
                    )}
                  </div>
                  {pd && pd.chartData.datasets.length > 0 ? (
                    <CJChart name={ttl('Load profile (MW)',zoneIdDecoded,demandProfileMode==='full'?'Full year':ttl(demandSeason,demandDay==='avg'?'average day':demandDay==='all'?'all day types':demandDay))} type="line"
                      height={pd.banded?200:150}
                      data={pd.chartData}
                      plugins={pd.plugin?[pd.plugin]:[]}
                      cacheKey={`${demandProfileMode}|${demandSeason}|${demandDay}`}
                      options={{ ...cjDefaults(t),
                        layout:{padding:{top:pd.banded?18:4,bottom:pd.banded?62:4}},
                        scales:{
                          x:{grid:{color:t.panelBorder,drawTicks:false},ticks:{display:!pd.banded,color:t.muted,font:{size:8},maxTicksLimit:12,...(pd.xTicks||{})}},
                          y:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9}},min:0,title:{display:true,text:'Load factor',color:t.muted,font:{size:8}}},
                        }}}
                    />
                  ) : <div style={{ color:t.lblMuted, fontSize:'0.55rem' }}>No profile data.</div>}
                </div>
              );
            })()}
          </div>
        )}

        {/* ════════ SUPPLY ══════════════════════════════════════════════════════ */}
        {hasData && activeTab === 'supply' && (
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            <VariantPicker t={t} scnMeta={scnMeta} param="pGenDataInput" value={varOverrides.pGenDataInput} onChange={setVariant} />
            {/* Capacity chart */}
            {(() => {
              const chartPlants = zoneGen.filter(r => statusFilter.has(r.status));
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
                      <CJChart name={ttl('Capacity by fuel (MW)',zoneIdDecoded)} type="bar" height={Math.min(fd.length*22+24,200)}
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
              const allGenFuels = [...new Set(zoneGen.map(r=>r.fuel))].sort();
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

            {/* Status filters */}
            <div style={{ display:'flex', gap:4, alignItems:'center', flexWrap:'wrap' }}>
              {[1,2,3].map(s=>(
                <Pill key={s} active={statusFilter.has(s)} onClick={()=>toggleStatus(s)} color={STATUS_COLOR[s]}>
                  <span style={{ display:'inline-block', width:6, height:6, borderRadius:'50%',
                    backgroundColor:STATUS_COLOR[s], marginRight:3 }}/>
                  {STATUS_LABEL[s]}
                </Pill>
              ))}
              <span style={{ fontSize:'0.42rem', color:t.lblMuted, marginLeft:2 }}>
                {sortedPlants.length} unit{sortedPlants.length!==1?'s':''}
              </span>
            </div>

            {/* Table */}
            <div style={{ border:`1px solid ${t.panelBorder}`, borderRadius:6, overflow:'hidden' }}>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 60px 52px 56px',
                padding:'4px 8px', backgroundColor:hexA(t.panelBorder,0.4),
                borderBottom:`1px solid ${t.panelBorder}` }}>
                <SortBtn col="g"        label="Name"/>
                <SortBtn col="fuel"     label="Fuel"/>
                <SortBtn col="status"   label="Status"/>
                <span style={{ textAlign:'right' }}><SortBtn col="capacity" label="MW"/></span>
              </div>
              <div style={{ maxHeight:360, overflowY:'auto' }}>
                {sortedPlants.length===0 ? (
                  <div style={{ padding:'12px 10px', color:t.lblMuted, fontSize:'0.55rem' }}>No units match filters.</div>
                ) : sortedPlants.map(r=>{
                  const plantKey=`${r.g}|${r.status}`;
                  const isSel=selectedPlant&&`${selectedPlant.g}|${selectedPlant.status}`===plantKey;
                  return (
                    <div key={plantKey}>
                      <div onClick={()=>setSelectedPlant(isSel?null:r)}
                        style={{ display:'grid', gridTemplateColumns:'1fr 60px 52px 56px',
                          padding:'5px 8px', borderBottom:`1px solid ${t.panelBorder}`,
                          fontSize:'0.5rem', alignItems:'center', cursor:'pointer',
                          backgroundColor:isSel?hexA('#1a5fa8',0.08):'transparent' }}
                        onMouseEnter={e=>{if(!isSel)e.currentTarget.style.backgroundColor=hexA('#1a5fa8',0.04);}}
                        onMouseLeave={e=>{if(!isSel)e.currentTarget.style.backgroundColor='transparent';}}>
                        <span style={{ color:t.lbl, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.g||'—'}</span>
                        <span style={{ display:'flex', alignItems:'center', gap:3 }}>
                          <span style={{ display:'inline-block', width:7, height:7, borderRadius:1, backgroundColor:EPM_FUEL_COLORS[r.fuel]||'#aaa' }}/>
                          <span style={{ color:t.muted, fontSize:'0.43rem' }}>{r.fuel}</span>
                        </span>
                        <span><span style={{ display:'inline-block', width:7, height:7, borderRadius:'50%', backgroundColor:STATUS_COLOR[r.status]||'#aaa' }}/></span>
                        <span style={{ color:t.lbl, textAlign:'right', fontWeight:600 }}>{fmt(r.capacity)}</span>
                      </div>
                      {isSel && (
                        <div style={{ padding:'8px 12px', backgroundColor:hexA('#1a5fa8',0.05),
                          borderBottom:`1px solid ${t.panelBorder}`, fontSize:'0.5rem' }}>
                          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:'6px 10px' }}>
                            {[
                              {l:'Technology',v:r.tech||'—'},{l:'Status',v:STATUS_LABEL[r.status]||'—'},
                              {l:'Start year',v:r.stYr||'—'},{l:'Retire year',v:r.retrYr||'—'},
                              {l:'Capex ($/kW)',v:r.capex!=null?fmt(r.capex,0):'—'},{l:'FOM ($/MW/yr)',v:r.fom!=null?fmt(r.fom,0):'—'},
                              {l:'VOM ($/MWh)',v:r.vom!=null?fmt(r.vom,2):'—'},{l:'Heat rate',v:r.heatRate!=null?fmt(r.heatRate,2):'—'},
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
            <div style={{ display:'flex', gap:4 }}>
              <Pill active={resSection==='vre'}   onClick={()=>setResSection('vre')}>VRE Profiles</Pill>
              <Pill active={resSection==='avail'} onClick={()=>setResSection('avail')}>Availability</Pill>
              <Pill active={resSection==='fuel'}  onClick={()=>setResSection('fuel')}>Fuel Prices</Pill>
            </div>

            {resSection==='vre'   && <VariantPicker t={t} scnMeta={scnMeta} param="pVREProfile"          value={varOverrides.pVREProfile}          onChange={setVariant} />}
            {resSection==='avail' && <VariantPicker t={t} scnMeta={scnMeta} param="pAvailabilityDefault" value={varOverrides.pAvailabilityDefault} onChange={setVariant} />}
            {resSection==='fuel'  && <VariantPicker t={t} scnMeta={scnMeta} param="pFuelPrice"           value={varOverrides.pFuelPrice}           onChange={setVariant} />}

            {resSection === 'vre' && (() => {
              const vp = epmData?.vreProfile||{};
              const hoursData = epmData?.hours||{};
              const timeSlices = epmData?.timeSlices||{nT:24,isHourly:true,hours:{}};
              const allTechs = Object.keys(vp[zoneIdDecoded]||{}).sort();
              const activeTech = allTechs.includes(vreTech)?vreTech:(allTechs[0]||'');
              const firstZ = vp[zoneIdDecoded]?.[activeTech];
              const vreAvailS = firstZ ? Object.keys(firstZ).sort() : [];
              const vreAvailD = firstZ && vreAvailS[0] ? Object.keys(firstZ[vreAvailS[0]]||{}).sort() : [];
              const totalD = Object.values(hoursData).reduce((s,dts)=>s+Object.values(dts||{}).reduce((a,b)=>a+b,0),0)||365;
              const isDark = t.isDark;
              const techColor = VRE_COLOR[activeTech]||'#1E9AF5';

              const buildZoneVRE = () => {
                if (vreProfileMode === 'full') {
                  if (!firstZ || !vreAvailD.length) return { chartData:{labels:[],datasets:[]}, plugin:null };
                  // x layout: one slot per hour on a chronological model, width proportional to duration on a load-block one
                  const ax=buildTimeAxis(timeSlices,vreAvailS,vreAvailD);
                  const nPts=ax.slots.length;
                  const data=ax.slots.map(sl=>firstZ[sl.q]?.[sl.d]?.[sl.i]??null);
                  const ds={label:activeTech,data,borderColor:techColor,borderWidth:2.5,pointRadius:0,tension:0.3,fill:true,backgroundColor:hexA(techColor,0.08),spanGaps:true};
                  const sepPlugin=bandingPlugin({ id:'zvSep', ax, seasons:vreAvailS, daytypes:vreAvailD,
                    hoursData, totalDays:totalD, isDark, dayFont:9 });
                  return { chartData:{labels:new Array(nPts).fill(''),datasets:[ds]}, plugin:sepPlugin, banded:true };
                }
                // See the load profile above for what 'All days' draws.
                const sp=firstZ?.[vreSeason];if(!sp)return null;
                const days=vreDay==='all'?vreAvailD:[vreDay==='avg'?vreAvailD[0]:vreDay];
                const banded=vreDay==='all'&&vreAvailD.length>1;
                const ax=buildSeasonAxis(timeSlices,vreSeason,days);
                const wts=dayWeights(hoursData,vreSeason,vreAvailD);
                const src=(vreDay==='avg'||vreDay==='all')?null:sp[vreDay];
                if(vreDay!=='avg'&&vreDay!=='all'&&!src)return null;
                const p=ax.slots.map(sl=>src?(src[sl.i]??null)
                  :vreDay==='all'?(sp[sl.d]?.[sl.i]??null)
                  :vreAvailD.reduce((a,d,k)=>a+(sp[d]?.[sl.i]||0)*wts[k],0));
                return { chartData:{labels:banded?new Array(ax.slots.length).fill(''):blockLabels(ax,timeSlices,vreSeason,days[0]),datasets:[{label:activeTech,data:p,borderColor:techColor,borderWidth:2.5,pointRadius:0,tension:0.35,fill:true,backgroundColor:hexA(techColor,0.08)}]},
                  plugin:banded?bandingPlugin({ id:'zvSepSeason', ax, seasons:[vreSeason], daytypes:days, hoursData, totalDays:totalD, isDark, dayFont:9 }):null,
                  banded, xTicks:banded?null:axisTicks(ax) };
              };
              const vd = buildZoneVRE();
              return (
                <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                  {allTechs.length === 0 ? (
                    <div style={{ color:t.lblMuted, fontSize:'0.55rem' }}>No VRE profile data for this zone.</div>
                  ) : (
                    <>
                      <div style={{ display:'flex', flexWrap:'wrap', gap:3, alignItems:'center' }}>
                        {allTechs.map(tc=>(
                          <Pill key={tc} active={activeTech===tc} onClick={()=>setVreTech(tc)}>{VRE_DISPLAY[tc]||tc}</Pill>
                        ))}
                        <div style={{ width:1, backgroundColor:t.panelBorder, height:14, margin:'0 2px' }}/>
                        <Pill active={vreProfileMode==='full'} onClick={()=>setVreProfileMode('full')}>Full Year</Pill>
                        {vreAvailS.map(s=>(
                          <Pill key={s} active={vreProfileMode==='season'&&vreSeason===s} onClick={()=>{setVreProfileMode('season');setVreSeason(s);}}>{s}</Pill>
                        ))}
                        {vreProfileMode==='season' && vreAvailD.length>0 && (
                          <>
                            <div style={{ width:1, backgroundColor:t.panelBorder, height:14 }}/>
                            <select value={vreDay} onChange={e=>setVreDay(e.target.value)} style={{ fontSize:'0.44rem', fontFamily:'inherit', padding:'2px 5px', borderRadius:3, border:`1px solid ${t.panelBorder}`, backgroundColor:t.panel, color:t.muted, cursor:'pointer' }}>
                              <option value="avg">Avg</option>
                              <option value="all">All days</option>
                              {vreAvailD.map(d=><option key={d} value={d}>{d}</option>)}
                            </select>
                          </>
                        )}
                      </div>
                      {vd && vd.chartData.datasets.length > 0 ? (
                        <CJChart name={ttl('VRE profile',vreTech,zoneIdDecoded,vreProfileMode==='full'?'Full year':ttl(vreSeason,vreDay==='avg'?'average day':vreDay==='all'?'all day types':vreDay))} type="line"
                          height={vd.banded?200:150}
                          data={vd.chartData}
                          plugins={vd.plugin?[vd.plugin]:[]}
                          cacheKey={`${vreProfileMode}|${activeTech}|${vreSeason}|${vreDay}`}
                          options={{ ...cjDefaults(t),
                            layout:{padding:{top:vd.banded?18:4,bottom:vd.banded?80:4}},
                            scales:{
                              x:{grid:{color:t.panelBorder,drawTicks:false},ticks:{display:!vd.banded,color:t.muted,font:{size:8},maxTicksLimit:12,...(vd.xTicks||{})}},
                              y:{min:0,max:1,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9}},title:{display:true,text:'Availability (0-1)',color:t.muted,font:{size:8}}},
                            }}}
                        />
                      ) : <div style={{ color:t.lblMuted, fontSize:'0.55rem' }}>No {VRE_DISPLAY[activeTech]||activeTech} data available.</div>}
                    </>
                  )}
                </div>
              );
            })()}

            {resSection === 'avail' && (
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {(() => {
                  const av = epmData?.availability||{};
                  const zoneAv = av[zoneIdDecoded]||{};
                  const keys = Object.keys(zoneAv);
                  if (!keys.length) return <div style={{ color:t.lblMuted, fontSize:'0.55rem' }}>No availability data for this zone.</div>;
                  const qCols = Object.keys(zoneAv[keys[0]]||{}).filter(k=>/^Q\d+$/.test(k)).sort();
                  return (
                    <>
                      <div style={{ display:'flex', gap:6, alignItems:'flex-start' }}>
                        <div style={{ flex:1, minWidth:0 }}>
                          <CJChart name={ttl('Seasonal availability (%)',zoneIdDecoded)} type="bar" height={160}
                            data={{ labels:qCols,
                              datasets:keys.map((k,i)=>({
                                label: zoneAv[k].fuel&&zoneAv[k].fuel!==''?zoneAv[k].fuel:zoneAv[k].tech||k,
                                data:qCols.map(q=>+(zoneAv[k][q]||0).toFixed(3)),
                                backgroundColor:hexA(EPM_FUEL_COLORS[normalizeFuel(zoneAv[k].fuel||zoneAv[k].tech||'')]||ZONE_PALETTE[i%ZONE_PALETTE.length],0.75),
                                borderWidth:0, barThickness:10,
                              }))}}
                            options={{ ...cjDefaults(t),
                              scales:{
                                x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9}}},
                                y:{min:0,max:1,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9}},
                                  title:{display:true,text:'Availability factor',color:t.muted,font:{size:8}}},
                              }}}
                          />
                        </div>
                        <div style={{ width:90, flexShrink:0, display:'flex', flexDirection:'column', gap:2, paddingTop:4, maxHeight:160, overflowY:'auto' }}>
                          {keys.map((k,i)=>{ const entry=zoneAv[k]; const label=entry.fuel&&entry.fuel!==''?entry.fuel:entry.tech||k; return (
                            <div key={k} style={{ display:'flex', alignItems:'center', gap:3 }}>
                              <div style={{ width:8, height:8, borderRadius:2, backgroundColor:hexA(EPM_FUEL_COLORS[normalizeFuel(entry.fuel||entry.tech||'')]||ZONE_PALETTE[i%ZONE_PALETTE.length],0.75), flexShrink:0 }}/>
                              <span style={{ fontSize:'0.4rem', color:t.muted, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{label}</span>
                            </div>
                          );})}
                        </div>
                      </div>
                    </>
                  );
                })()}
              </div>
            )}

            {resSection === 'fuel' && (
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                <div>
                  <div style={{ fontSize:'0.44rem', color:t.lblMuted, marginBottom:4 }}>Countries:</div>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:3 }}>
                    <Pill active={fpCountries===null} onClick={()=>setFpCountries(null)}>All</Pill>
                    {allCountries.filter(c=>(epmData?.fuelPrice||{})[c]).map(c=>(
                      <Pill key={c} active={fpCountries?.includes(c)??false}
                        onClick={()=>setFpCountries(prev=>{
                          if(prev===null)return[c];
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
                  return fd.datasets.length>0 ? (
                    <>
                      <div style={{ display:'flex', gap:6, alignItems:'flex-start' }}>
                        <div style={{ flex:1, minWidth:0 }}>
                          <CJChart name={ttl('Fuel prices',fpCountries?fpCountries.join(', '):zoneIdDecoded)} type="line" height={160} data={fd}
                            options={{ ...cjDefaults(t),
                              scales:{
                                x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},maxTicksLimit:8}},
                                y:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9}},
                                  title:{display:true,text:'USD/MBtu',color:t.muted,font:{size:8}}},
                              }}}
                          />
                        </div>
                        <div style={{ width:90, flexShrink:0, display:'flex', flexDirection:'column', gap:2, paddingTop:4, maxHeight:160, overflowY:'auto' }}>
                          {fd.datasets.map((ds,i)=>(
                            <div key={ds.label} style={{ display:'flex', alignItems:'center', gap:3 }}>
                              <div style={{ width:12, height:2, borderRadius:1, backgroundColor:typeof ds.borderColor==='string'?ds.borderColor:ZONE_PALETTE[i%ZONE_PALETTE.length], flexShrink:0 }}/>
                              <span style={{ fontSize:'0.4rem', color:t.muted, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{ds.label}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  ) : <div style={{ color:t.lblMuted, fontSize:'0.55rem' }}>No fuel price data.</div>;
                })()}
              </div>
            )}
          </div>
        )}

        {/* ════════ CONNECTIONS (Trade) ═════════════════════════════════════════ */}
        {hasData && activeTab === 'connections' && (
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <VariantPicker t={t} scnMeta={scnMeta} param="pTransferLimit" value={varOverrides.pTransferLimit} onChange={setVariant} />
            <SectionTitle t={t}>NTC connections ({ntcRefYr||'—'})</SectionTitle>
            {connections.length > 0 ? (
              <>
                <div style={{ border:`1px solid ${t.panelBorder}`, borderRadius:6, overflow:'hidden' }}>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 90px 80px',
                    padding:'4px 10px', backgroundColor:hexA(t.panelBorder,0.4),
                    fontSize:'0.42rem', color:t.lblMuted, fontWeight:600, letterSpacing:'0.5px',
                    borderBottom:`1px solid ${t.panelBorder}` }}>
                    <span>Neighbor zone</span><span>Country</span><span style={{textAlign:'right'}}>MW</span>
                  </div>
                  {connections.map(c=>(
                    <div key={c.neighbor}
                      onClick={()=>navigate(`/region/${regionId}/zone/${encodeURIComponent(c.neighbor)}`)}
                      style={{ display:'grid', gridTemplateColumns:'1fr 90px 80px',
                        padding:'6px 10px', borderTop:`1px solid ${t.panelBorder}`,
                        fontSize:'0.52rem', alignItems:'center', cursor:'pointer' }}
                      onMouseEnter={e=>e.currentTarget.style.backgroundColor=hexA('#1a5fa8',0.06)}
                      onMouseLeave={e=>e.currentTarget.style.backgroundColor='transparent'}>
                      <span style={{ color:t.lbl, fontWeight:500 }}>{c.neighbor}</span>
                      <span style={{ color:t.muted, fontSize:'0.46rem' }}>{c.neighborCountry}</span>
                      <div style={{ textAlign:'right' }}>
                        <span style={{ color:t.lbl, fontWeight:600 }}>{fmt(c.mw)}</span>
                        <span style={{ color:t.lblMuted, fontSize:'0.44rem', marginLeft:2 }}>MW</span>
                      </div>
                    </div>
                  ))}
                </div>
                <CJChart name={ttl('Corridor capacity (MW)',zoneIdDecoded,epmYear)} type="bar" height={Math.min(connections.length*22+30,200)}
                  data={{ labels:connections.map(c=>c.neighbor),
                    datasets:[{ data:connections.map(c=>c.mw),
                      backgroundColor:hexA('#f0b030',0.75), borderWidth:0, barThickness:12 }] }}
                  options={{ ...cjDefaults(t), indexAxis:'y',
                    scales:{
                      x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},
                      y:{grid:{display:false},ticks:{color:t.muted,font:{size:8}}},
                    }}}
                />
              </>
            ) : <div style={{ color:t.lblMuted, fontSize:'0.58rem' }}>No NTC data for this zone.</div>}
          </div>
        )}

        {/* ════════ SCENARIOS ═══════════════════════════════════════════════════ */}
        {activeTab === 'scenario' && (
          <ScenarioTab t={t} scnMeta={scnMeta} />
        )}

        {/* ════════ ABOUT ═══════════════════════════════════════════════════════ */}
        {activeTab === 'about' && (
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            <div style={{ border:`1px solid ${t.panelBorder}`, borderRadius:8, padding:'12px 14px',
              fontSize:'0.58rem', color:t.muted, lineHeight:1.6 }}>
              <div style={{ fontSize:'0.6rem', fontWeight:700, color:t.lbl, marginBottom:6 }}>
                {zoneIdDecoded} — EPM Zone
              </div>
              <div>Country: <b style={{color:t.lbl}}>{countryName}</b></div>
              <div style={{ marginTop:4 }}>Part of <b style={{color:t.lbl}}>{region.name}</b></div>
              {region.epm && (
                <>
                  <div style={{ marginTop:4 }}>
                    <b style={{color:t.lbl}}>Branch:</b>{' '}
                    <code style={{fontSize:'0.52rem'}}>{region.epm.branch}</code>
                  </div>
                  <div>
                    <b style={{color:t.lbl}}>Data folder:</b>{' '}
                    <code style={{fontSize:'0.52rem'}}>{activeFolder ?? region.epm.dataFolder}</code>
                  </div>
                </>
              )}
            </div>
            {region.epm && (
              <a href={`https://htmlpreview.github.io/?https://raw.githubusercontent.com/ESMAP-World-Bank-Group/EPM/${region.epm.branch}/epm/input/${activeFolder ?? region.epm.dataFolder}/DATA_SOURCES.html`}
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

        {/* Footer */}
        <div style={{ marginTop:24, paddingTop:12, borderTop:`1px solid ${t.panelBorder}`,
          fontSize:'0.48rem', color:t.lblMuted }}>
          Zone <b style={{color:t.lbl}}>{zoneIdDecoded}</b> · {countryName} · {region.name}
        </div>
      </div>
    </div>
  );
}
