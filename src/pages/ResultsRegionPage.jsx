import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import { track } from '../analytics';
import { useTheme } from '../App';
import { getT } from '../constants';
import {
  fetchEpmCSV, fetchLinestringGeoJSON, fetchZonesGeoJSON, fetchZonesExtGeoJSON, fetchZonesOffgridGeoJSON, fetchGitHubDir, fetchResultCSV, fetchRunRootCSV, resolveOutputDir, fetchRunList, fetchInputScenarios, fetchDispatchYear, resultCsvUrl,
  processTechFuel, processYearlyZone, processDispatchResults, processHourlyPrice,
  processHours, processTimeSlices, processTransmissionResults, processPlants, processCosts, processExtNTC, processEnergyBalance,
  processTradePrice,
  resultYears,
} from '../utils/epmFetch';
import {
  processNpvInput, processNpvSystem, buildNpv, npvDelta, visibleComps, withSummaryCapex, npvCheckNotes,
} from '../utils/npv';
import { annotateCsv, resultLines } from '../utils/csvMeta';
import { yzAgg } from '../utils/zoneAgg';
import { rankPlants, plantDisplay, plantFmt } from '../utils/plantRank';
import { netImportGWh } from '../utils/netImport';
import { techColor, hexA, cssFillFor, legendItem } from '../utils/chartColors';
import { extraSeries, extraDelta, extraDataset, extraKind, orderStack, seriesLegendItem } from '../utils/annualExtras';
import { buildDispatchSeries, buildDispatchDeltaSeries, deltaTooltip } from '../utils/dispatchSeries';
import {
  buildExtZoneData, addExtZoneLayers, bindExtZoneHandlers, updateExtZoneData, setExtZonesVisible,
  extNodeCoordMap, buildExtFlowFeatures, bindExtFlowHandlers, addExtPriceDots,
} from '../utils/extZones';
import { addOffgridLayers } from '../utils/offgridZones';
import { fetchCountries, fetchBoundaries, addCountriesSource, addBoundariesSource, raiseBoundaries } from '../utils/basemap';
import { buildWbStyle, useWbStyleBase, ZONE_MAP_VIEW } from '../utils/wbStyle';
import { baseFirst, baseScenario, defaultScenarios } from '../utils/scenarioOrder';
import { physicalStats } from '../utils/summaryStats';
import ScenarioPicker, { ScenarioKey } from '../components/ScenarioPicker';
import { alive, source, markStyleReady, styleReady } from '../utils/mapSource';
import { zoneCentroidMap } from '../utils/centroids';
import { priceDotEl } from '../utils/priceDot';
import { fetchScenarioConfig, resolveFile, overridesFor } from '../utils/epmScenarios';
import { fetchScenarioDocs, scenarioDocIndex } from '../utils/scenarioDocs';
import ScenarioTab from '../components/ScenarioTab';
import RawOutputsTab from '../components/RawOutputsTab';
import { externalZoneSet } from '../utils/zoneClass';
import { usePromotedZones } from '../utils/usePromotedZones';
import CJChart from '../components/CJChart';
import MapDownload from '../components/MapDownload';
import PanelZoomControl, { usePanelZoom, unzoom } from '../components/PanelZoom';
import { ttl, scenList } from '../utils/chartTitle';
import { barTotalPlugin, barTotalFooter } from '../utils/barTotals';
import { useZoneLabels, useZoneLabelMarkers } from '../utils/zoneLabels';
import { dataPath } from '../utils/paths';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAP_PALETTE = ['#1B6CA8','#36B5B5','#E8C547','#4DA6FF','#4169E1','#85C1E9','#2E9EC8','#5EBCBA','#1A5276','#7EC8E3','#14A094','#4CAFE8','#EDD770','#AED6F1','#1F618D','#0A6B70'];


const COST_COLORS = {
  'Fuel costs: $m':'#9A7040', 'Fixed O&M: $m':'#1E9AF5', 'Variable O&M: $m':'#44DAEC',
  'Investment costs: $m':'#C8A8F0', 'Carbon costs: $m':'#808890', 'Transmission costs: $m':'#E8C547',
  'VRE curtailment: $m':'#FFD700', 'Variable Cost: $m':'#5DADE2',
  'Import costs with internal zones: $m':'#E53935', 'Import costs with external zones: $m':'#C0392B',
  'Export revenues with internal zones: $m':'#52C860', 'Export revenues with external zones: $m':'#27AE60',
  'Spinning reserve costs: $m':'#8A97A8', 'Unmet country spinning reserve costs: $m':'#B0BAC6',
};
const COST_LABELS = {
  'Fuel costs: $m':'Fuel', 'Fixed O&M: $m':'Fixed O&M', 'Variable O&M: $m':'Variable O&M',
  'Investment costs: $m':'Investment', 'Carbon costs: $m':'Carbon', 'Transmission costs: $m':'Transmission',
  'VRE curtailment: $m':'VRE curtailment', 'Variable Cost: $m':'Variable cost',
  'Import costs with internal zones: $m':'Internal imports', 'Import costs with external zones: $m':'External imports',
  'Export revenues with internal zones: $m':'Internal exports', 'Export revenues with external zones: $m':'External exports',
  'Spinning reserve costs: $m':'Spinning reserve', 'Unmet country spinning reserve costs: $m':'Unmet reserve',
};
// The cost lines the breakdown draws. Everything the model writes is here except the
// three internal trade lines, which are a transfer between zones of the same region and
// cancel to zero across it: left in they would draw as two large annihilating bars. The
// sum of what is left therefore ties with the 'Costs total' indicator exactly. A country
// view cannot make the same cut, and does not: see NET_TRADE_LINE in ResultsCountryPage.
const MAIN_COST_CATS = ['Fuel costs: $m','Fixed O&M: $m','Variable O&M: $m','Investment costs: $m',
  'Carbon costs: $m','VRE curtailment: $m','Transmission costs: $m',
  'Import costs with external zones: $m','Export revenues with external zones: $m',
  'Spinning reserve costs: $m','Unmet country spinning reserve costs: $m'];
function costColor(cat) { return COST_COLORS[cat] || '#888888'; }
function makeScenPlugin(activeSc,color){if(!activeSc||activeSc.length<2)return null;return{id:'scenLabels',afterDraw(chart){const{ctx,chartArea:ca}=chart;if(!ca)return;ctx.save();ctx.font='8px "Open Sans", system-ui, sans-serif';ctx.textAlign='center';ctx.textBaseline='top';ctx.fillStyle=color||'rgba(128,128,128,0.7)';activeSc.forEach((scen,si)=>{const dsIdx=chart.data.datasets.findIndex(d=>d.stack===scen);if(dsIdx<0)return;const meta=chart.getDatasetMeta(dsIdx);const nX=chart.data.labels.length;for(let xi=0;xi<nX;xi++){const bar=meta.data[xi];if(!bar)continue;ctx.fillText(`S${si+1}`,bar.x,ca.bottom+12);}});ctx.restore();}};}

// The country selector's third regime: draw the countries side by side instead of
// summing them. Only the yearlyZone indicators can take it, they are the ones drawn as
// curves; a stack of techfuels or of cost lines would have to be restacked by country,
// which is a different chart and not this one.
const EACH_COUNTRY = '__each__';
// One dash pattern per scenario, so colour is free to carry the country. Solid first,
// which is the base scenario wherever baseFirst put it.
const SCEN_DASH = [[], [6,3], [2,3], [9,3,2,3], [1,3]];

const INDICATORS = [
  { key:'CapacityTechFuel',             label:'Capacity (MW)',             source:'techFuel',   unit:'MW' },
  { key:'EnergyTechFuelComplete',       label:'Energy (GWh)',              source:'techFuel',   unit:'GWh' },
  { key:'NewCapacityTechFuel',          label:'New Capacity (MW)',         source:'techFuel',   unit:'MW' },
  { key:'NewCapacityTechFuelCumulated', label:'Cum. New Capacity (MW)',    source:'techFuel',   unit:'MW' },
  { key:'ReserveSpinningTechFuel',      label:'Spinning Reserve (GWh)',    source:'techFuel',   unit:'GWh' },
  { key:'CostsBreakdown',               label:'Costs breakdown (m USD)',   source:'costs',      unit:'m USD' },
  { key:'Costs',                        label:'Costs total (m USD)',       source:'yearlyZone', unit:'m USD' },
  { key:'CapexInvestmentComponent',     label:'CAPEX (m USD)',             source:'yearlyZone', unit:'m USD' },
  { key:'GenCostsPerMWh',               label:'Gen Cost (USD/MWh)',        source:'yearlyZone', unit:'USD/MWh' },
  // EmissionsIntensityZone sits next to this one in pYearlyZoneMerged and is deliberately
  // left out: the model writes values around 1e-7 where the zone's own emissions and demand
  // give ~96 tCO2/GWh, and the treated CSV rounds them to zero. An intensity would have to
  // be derived from EmissionsZone and DemandEnergyZone rather than read.
  { key:'EmissionsZone',                label:'Emissions (Mt CO2)',        source:'yearlyZone', unit:'Mt CO2' },
  { key:'Trade',                         label:'Trade (GWh)',               source:'trade',      unit:'GWh' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n, d = 0) { if (n == null || isNaN(n)) return '—'; return n.toLocaleString('en-US', { maximumFractionDigits: d }); }
function fmtBig(n) { if (!n) return '—'; const a=Math.abs(n); if(a>=1e9)return`${(n/1e9).toFixed(1)}B`; if(a>=1e6)return`${(n/1e6).toFixed(1)}M`; if(a>=1e3)return`${(n/1e3).toFixed(1)}k`; return n.toFixed(1); }
function cjDefaults(t) { return { responsive:true,maintainAspectRatio:false, plugins:{legend:{display:false},tooltip:{backgroundColor:t.panel,borderColor:t.panelBorder,borderWidth:1,titleColor:t.lbl,bodyColor:t.muted,titleFont:{size:11},bodyFont:{size:11},padding:6}}, scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:11}}},y:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:11}}}}}; }

function priceColor(t_) {
  // t_ = 0-1: white → #1B6CA8 (medium blue)
  return `rgb(${Math.round(255-t_*(255-27))},${Math.round(255-t_*(255-108))},${Math.round(255-t_*(255-168))})`;
}
function priceBarColor(t_) {
  // #2E9EC8 (trade blue, low) → #E8C547 (trade gold, high)
  return `rgb(${Math.round(46+t_*(232-46))},${Math.round(158+t_*(197-158))},${Math.round(200+t_*(71-200))})`;
}

function buildNetDotPlugin(netData){
  return{id:'netDot',afterDatasetsDraw(chart){
    if(!netData.length)return;
    const ctx=chart.ctx;const yScale=chart.scales.y;
    netData.forEach(({si,data,color})=>{
      const di=chart.data.datasets.findIndex(d=>d._si===si);
      if(di<0)return;
      const meta=chart.getDatasetMeta(di);
      data.forEach((val,i)=>{
        const bar=meta.data[i];if(!bar)return;
        const y=yScale.getPixelForValue(val);
        ctx.save();ctx.beginPath();ctx.arc(bar.x,y,3.5,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();ctx.restore();
      });
    });
  }};
}
function SectionTitle({ t, children, right }) {
  return <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
    <div style={{fontSize:'0.47rem',letterSpacing:'2px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase'}}>{children}</div>{right}
  </div>;
}
function Pill({ active, onClick, children }) {
  return <button onClick={onClick} style={{fontSize:'0.44rem',fontFamily:'inherit',padding:'2px 7px',borderRadius:3,cursor:'pointer',border:`1px solid ${active?'rgba(74,143,204,0.65)':'rgba(128,160,192,0.2)'}`,backgroundColor:active?'rgba(74,143,204,0.12)':'transparent',color:active?'rgba(74,143,204,1)':'rgba(128,160,192,0.7)',fontWeight:active?600:400}}>{children}</button>;
}
function DownloadBtn({ url, filename, lines, t }) {
  const [busy, setBusy] = useState(false);
  const handle = async () => {
    setBusy(true);
    try {
      const res = await fetch(url);
      // Without this the error page (GitHub answers 404 with a "404: Not Found"
      // body) would be saved under the CSV's name instead of the data.
      if (!res.ok) { alert(`Download failed (${res.status}): ${filename}`); return; }
      const text = annotateCsv(await res.text(), { filename, lines });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text],{type:'text/csv'}));
      a.download = filename; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),100);
    } catch { window.open(url,'_blank'); } finally { setBusy(false); }
  };
  return <button onClick={handle} disabled={busy} title={filename} style={{display:'flex',alignItems:'center',gap:3,fontSize:'0.42rem',fontFamily:'inherit',padding:'3px 8px',borderRadius:3,cursor:'pointer',border:`1px solid ${t.panelBorder}`,backgroundColor:'transparent',color:t.muted,opacity:busy?0.5:1}}>
    <span style={{fontSize:'0.6rem'}}>{busy?'…':'↓'}</span><span>{filename.replace('.csv','')}</span>
  </button>;
}

function OverviewPie({ tfs, data, total, unitDiv, unitLbl, t }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const SZ = 76, cx = SZ/2, cy = SZ/2, oR = SZ/2 - 2, iR = oR * 0.52;
    canvas.width = Math.round(SZ*dpr); canvas.height = Math.round(SZ*dpr);
    canvas.style.width = SZ+'px'; canvas.style.height = SZ+'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const tot = data.reduce((a,b) => a+b, 0);
    let ang = -Math.PI/2;
    tfs.forEach((tf, i) => {
      const sw = (data[i]/tot)*2*Math.PI;
      ctx.beginPath(); ctx.moveTo(cx+iR*Math.cos(ang), cy+iR*Math.sin(ang));
      ctx.arc(cx, cy, oR, ang, ang+sw); ctx.arc(cx, cy, iR, ang+sw, ang, true);
      ctx.closePath(); ctx.fillStyle = techColor(tf); ctx.fill();
      ang += sw;
    });
    ctx.beginPath(); ctx.arc(cx, cy, iR-0.5, 0, 2*Math.PI);
    ctx.fillStyle = t.isDark ? 'rgba(15,20,30,0.88)' : 'rgba(245,248,252,0.92)'; ctx.fill();
    const v = (total/unitDiv); const vs = v>=10 ? v.toFixed(0) : v.toFixed(1);
    ctx.fillStyle = t.isDark ? 'rgba(255,255,255,0.95)' : 'rgba(15,30,60,0.9)';
    ctx.font = 'bold 10px "Open Sans", system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(vs, cx, cy-4);
    ctx.fillStyle = t.isDark ? 'rgba(255,255,255,0.5)' : 'rgba(60,80,120,0.6)';
    ctx.font = '7.5px "Open Sans", system-ui, sans-serif'; ctx.fillText(unitLbl, cx, cy+7);
  }, [tfs, data, total, unitDiv, unitLbl, t]); // eslint-disable-line
  return <canvas ref={ref} style={{ display:'block', flexShrink:0 }} />;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ResultsRegionPage() {
  const { regionId } = useParams();
  const { theme }    = useTheme();
  const wbBase = useWbStyleBase();
  const t            = getT(theme);
  const navigate     = useNavigate();

  const containerRef  = useRef(null); const mapRef = useRef(null);
  const dotMarkersRef = useRef([]);
  const pieMarkersRef = useRef([]);
  // Refs for map popup closures (avoid stale state)
  const resultsDataRef  = useRef({});
  const refYearRef      = useRef(null);
  const ovScenarioRef   = useRef(null);
  const hoursDataRef    = useRef({});

  // ── State ──────────────────────────────────────────────────────────────────
  const [region,       setRegion]       = useState(null);
  const [zcmapRowsRaw, setZcmapRows]    = useState([]);
  const [zonesGJRaw,   setZonesGJ]      = useState(null);
  const [linestringGJ, setLinestringGJ] = useState(null);
  const [zonesExtGJRaw,setZonesExtGJ]   = useState(null);
  const [offgridGJ,    setOffgridGJ]    = useState(null);
  const [extNtcRaw,    setExtNtc]       = useState([]);
  const [tradePrice,   setTradePrice]   = useState({});   // border price paid on imports
  const [tradePriceExp,setTradePriceExp]= useState({});   // border price received on exports
  const [showExtZones, setShowExtZones] = useState(true);
  const [zoneLabels,   setZoneLabels]   = useZoneLabels();
  const showExtRef     = useRef(true);
  const [hoursData,    setHoursData]    = useState({});
  // Slice count comes from pHours: 24 for a chronological model, 6-7 for a load-block one.
  const [slices,       setSlices]       = useState({nT:24,isHourly:true,hours:{}});
  const [runList,      setRunList]      = useState([]);
  const [outputDir,    setOutputDir]    = useState('epm/output');
  const [simRun,       setSimRun]       = useState(null);
  const [scenarioList, setScenarioList] = useState([]);
  const [resultsDataRaw, setResultsData] = useState({});
  const [loadingRuns,  setLoadingRuns]  = useState(false);
  const [runsUnreachable, setRunsUnreachable] = useState(false);
  // Set once the run list has settled, so the map knows which run to draw.
  const [runsResolved, setRunsResolved] = useState(false);
  const [loadingData,  setLoadingData]  = useState(false);
  const [loadingDisp,  setLoadingDisp]  = useState(false);
  const dispLoadedRef  = useRef(new Set());

  // Zones this region asked to be shown as external, moved across the line before any
  // of the code below sees them (utils/zoneClass). For every other region this hands
  // the raw state straight back.
  const { zcmapRows, zonesGJ, zonesExtGJ, extNtc, resultsData: resultsDataPromoted } =
    usePromotedZones(region, { zcmapRows: zcmapRowsRaw, zonesGJ: zonesGJRaw,
      zonesExtGJ: zonesExtGJRaw, extNtc: extNtcRaw, resultsData: resultsDataRaw });

  const [activeTab,    setActiveTab]    = useState('overview');
  const [refYear,      setRefYear]      = useState(null);
  const [ovScenario,   setOvScenario]   = useState(null);
  const [ovMixMode,    setOvMixMode]    = useState('zone');
  const [evIndicator,  setEvIndicator]  = useState('CapacityTechFuel');
  const [evScenarios,  setEvScenarios]  = useState(new Set());
  const [evCountry,    setEvCountry]    = useState('all');
  const [dispScenario, setDispScenario] = useState(null);
  const [dispZone,     setDispZone]     = useState(null);
  const [dispMode,     setDispMode]     = useState('full');
  const [dispSeason,   setDispSeason]   = useState('Q1');
  const [dispDay,      setDispDay]      = useState('all');
  const [trScenario,   setTrScenario]   = useState(null);
  const [trViewMode,   setTrViewMode]   = useState('netbar');   // 'netbar' | 'evolution'
  const [trEvMetric,   setTrEvMetric]   = useState('volume');   // 'volume' | 'capacity'
  const [trEvSplit,    setTrEvSplit]     = useState(false);
  const [plScenario,   setPlScenario]   = useState(null);
  const [plIndicator,  setPlIndicator]  = useState('CapacityPlant');
  const [plTopN,       setPlTopN]       = useState(20);
  const [plShowBubble,   setPlShowBubble]   = useState(false);
  const [panelWidth,     setPanelWidth]     = useState(680);
  const { zoom, inc, dec, reset } = usePanelZoom();
  const [mapLoadedCount, setMapLoadedCount] = useState(0);
  const [hiddenMap,      setHiddenMap]      = useState({}); // { chartId: Set<label> }
  const [pieDispMode,    setPieDispMode]    = useState('none'); // 'none'|'capacity'|'energy'
  const [cmpRef,         setCmpRef]         = useState(null);
  const [cmpScenarios,   setCmpScenarios]   = useState(new Set());
  const [cmpMode,        setCmpMode]        = useState('values');
  const [trScenarios,    setTrScenarios]    = useState(new Set());
  const [snapIndicator,  setSnapIndicator]  = useState('CapacityTechFuel');
  const [snapView,       setSnapView]       = useState('zone');
  const [snapCountry,    setSnapCountry]    = useState('all');
  const [snapScenarios,  setSnapScenarios]  = useState(new Set());
  const [plZone,         setPlZone]         = useState('all');
  const [summaryRef,     setSummaryRef]     = useState(null);
  const [summaryScen,    setSummaryScen]    = useState(new Set());
  const [npvSplit,       setNpvSplit]       = useState('scenario'); // 'scenario' | 'country'
  const [summaryRows,    setSummaryRows]    = useState(null);   // run-root summary.csv
  const [extNpvRows,     setExtNpvRows]     = useState(null);   // run-root npv_external.csv
  const [scnMeta,        setScnMeta]        = useState(null);   // scenarios.csv variant matrix
  const [scnDocs,        setScnDocs]        = useState(null);   // written scenario descriptions

  // pCostsMerged lost its 'Investment costs: $m' line to a bug in output_treatment.py, so
  // for a run treated before the fix withSummaryCapex puts it back from summary.csv.
  // Everything below reads the repaired object; a run that never lost it is untouched.
  const resultsData = useMemo(() => withSummaryCapex(resultsDataPromoted, summaryRows),
    [resultsDataPromoted, summaryRows]);
  const isDraggingRef = useRef(false);
  const dragStartX    = useRef(0);
  const dragStartW    = useRef(0);

  const toggleHidden = (chartId, label) => setHiddenMap(prev => {
    const s = new Set(prev[chartId] || []);
    s.has(label) ? s.delete(label) : s.add(label);
    return { ...prev, [chartId]: s };
  });
  const isHidden = (chartId, label) => hiddenMap[chartId]?.has(label) || false;
  const anyHidden = (chartId) => (hiddenMap[chartId]?.size || 0) > 0;

  // ── Sync refs ──────────────────────────────────────────────────────────────
  useEffect(() => { resultsDataRef.current = resultsData; }, [resultsData]);
  useEffect(() => { refYearRef.current = refYear; }, [refYear]);
  useEffect(() => { ovScenarioRef.current = ovScenario; }, [ovScenario]);
  useEffect(() => { hoursDataRef.current = hoursData; }, [hoursData]);

  // ── Load region + geo ──────────────────────────────────────────────────────
  useEffect(() => {
    track('results_view', { type: 'region', region: regionId });
    fetch(dataPath('regions.json')).then(r=>r.json()).then(d => {
      const r=(d.regions||[]).find(r=>r.id===regionId); setRegion(r||null);
    });
    // Written scenario descriptions, when the study has any (utils/scenarioDocs).
    fetchScenarioDocs(regionId).then(setScnDocs);
  }, [regionId]);

  // The inputs a results map still needs: the zoning, the hour weights, and the two
  // things that describe the border — how much can cross it and what it costs there.
  // config.csv is asked where each of those lives, because the border prices are
  // scenario variants: the folder holds pTradePrice_eu_central.csv and five siblings,
  // and pTradePrice.csv, the name a guess would pick, is a stale leftover.
  // scenarios.csv is asked which of them the selected scenario swaps, because the
  // capacities are variants too: LC_BSSC is the only run where the Georgia-Romania
  // cable has any MW at all, and reading the base file drew it against a zero limit.
  useEffect(() => {
    if (!region?.epm) return;
    const { branch, dataFolder, scenariosFile, configFile } = region.epm;
    let stale = false;
    (async () => {
      const cfg = await fetchScenarioConfig(branch, dataFolder, { scenariosFile, configFile }).catch(() => null);
      if (!stale) setScnMeta(cfg);   // the Scenarios tab shows the same matrix the inputs pages do
      const rf = (p, fallback) => resolveFile(cfg, overridesFor(cfg, ovScenario), p, fallback);
      const [zc, hr, zExt, extRaw, offGJ, tpIn, tpOut] = await Promise.all([
        fetchEpmCSV(branch, dataFolder, rf('zcmap', 'zcmap.csv')),
        fetchEpmCSV(branch, dataFolder, rf('pHours', 'pHours.csv')),
        fetchZonesExtGeoJSON(branch, dataFolder),
        fetchEpmCSV(branch, dataFolder, rf('pExtTransferLimit', 'trade/pExtTransferLimit.csv')),
        fetchZonesOffgridGeoJSON(branch, dataFolder),
        fetchEpmCSV(branch, dataFolder, rf('pTradePrice', 'trade/pTradePrice.csv')),
        fetchEpmCSV(branch, dataFolder, rf('pTradePriceExport', 'trade/pTradePriceExport.csv')),
      ]);
      if (stale) return;
      setZcmapRows(zc||[]);
      if (hr) { setHoursData(processHours(hr)); setSlices(processTimeSlices(hr)); }
      setZonesExtGJ(zExt||null); setExtNtc(extRaw ? processExtNTC(extRaw) : []); setOffgridGJ(offGJ||null);
      setTradePrice(tpIn ? processTradePrice(tpIn) : {});
      setTradePriceExp(tpOut ? processTradePrice(tpOut) : {});
    })();
    return () => { stale = true; };
  }, [region, ovScenario]);

  // The zone layers belong to the run, not to the branch: a run publishes the
  // zoning it solved. Wait for the run list to settle so the right one is asked
  // for; with no run resolved this reads the input folder, as it always did.
  useEffect(() => {
    if (!region?.epm || !runsResolved) return;
    const { branch, dataFolder } = region.epm;
    const run = simRun ? { outputDir, simRun } : null;
    Promise.all([
      fetchZonesGeoJSON(branch, dataFolder, null, run),
      fetchLinestringGeoJSON(branch, dataFolder, null, run),
    ]).then(([zGJ, lGJ]) => { setZonesGJ(zGJ); setLinestringGJ(lGJ); });
  }, [region, outputDir, simRun, runsResolved]);

  // ── Load runs / scenarios / data ───────────────────────────────────────────
  useEffect(() => {
    if (!region?.epm) return;
    setLoadingRuns(true); setRunsResolved(false);
    const { branch, outputDir: fixedDir, simRuns: fixedRuns } = region.epm;
    if (fixedDir) {
      // regions.json overrides outputDir (e.g. R2 branches that skip GitHub API)
      setOutputDir(fixedDir);
      const runs = (fixedRuns || []).slice().sort().reverse();
      setRunList(runs); if (runs.length) setSimRun(runs[0]);
      setLoadingRuns(false); setRunsResolved(true);
    } else {
      resolveOutputDir(branch).then(dir => { setOutputDir(dir); return fetchRunList(branch, dir); }).then(names => {
        setRunsUnreachable(names === null);
        const runs = (names||[]).slice().sort().reverse();
        setRunList(runs); if (runs.length) setSimRun(runs[0]);
      }).finally(()=>{setLoadingRuns(false);setRunsResolved(true);});
    }
  }, [region]);

  useEffect(() => {
    if (!region?.epm || !simRun) return;
    const { branch } = region.epm;
    // Try GitHub dir listing first; fall back to input_scenarios.csv (for R2 branches)
    fetchGitHubDir(branch, `${outputDir}/${simRun}`).then(async items => {
      let scens = (items||[]).filter(i=>i.type==='dir').map(i=>i.name).sort();
      if (!scens.length) {
        const fromCsv = await fetchInputScenarios(branch, outputDir, simRun);
        scens = (fromCsv || []).sort();
      }
      setScenarioList(scens); setEvScenarios(defaultScenarios(scens));
      const base = baseScenario(scens);
      if (scens.length) {
        setOvScenario(base); setDispScenario(base); setTrScenario(base); setPlScenario(base); setCmpRef(base);
      }
      setCmpScenarios(defaultScenarios(scens.filter(s=>s!==base)));
      setCmpMode('values');
      setTrScenarios(defaultScenarios(scens));
      setSnapScenarios(defaultScenarios(scens));
      setSummaryRef(null);
      // The summary compares against a reference, so the reference itself is not one of
      // the columns: pick the first few of the rest.
      setSummaryScen(defaultScenarios(scens.filter(s=>s!==base)));
    });
  }, [region, simRun, outputDir]);

  useEffect(() => {
    if (!region?.epm || !simRun || !scenarioList.length) return;
    setLoadingData(true);
    const { branch } = region.epm;
    // When the run changes, this effect fires once with the new run and the old scenario
    // list, then again with the new list: the first batch is stale and must not land.
    let stale = false;
    Promise.all(scenarioList.map(async scen => {
      // Dispatch (pDispatchComplete) is huge -> loaded lazily per year (see effect below)
      const [tfR, yzR, prR, txR, plR, coR, ebR, npR] = await Promise.all([
        fetchResultCSV(branch, simRun, scen, 'pTechFuelMerged.csv', outputDir),
        fetchResultCSV(branch, simRun, scen, 'pYearlyZoneMerged.csv', outputDir),
        fetchResultCSV(branch, simRun, scen, 'pHourlyPrice.csv', outputDir),
        fetchResultCSV(branch, simRun, scen, 'pTransmissionMerged.csv', outputDir),
        fetchResultCSV(branch, simRun, scen, 'pPlantMerged.csv', outputDir),
        fetchResultCSV(branch, simRun, scen, 'pCostsMerged.csv', outputDir),
        fetchResultCSV(branch, simRun, scen, 'pEnergyBalance.csv', outputDir),
        // 47 rows: the model's own NPV of system cost, which the summary tab checks its
        // decomposition against rather than trusting it.
        fetchResultCSV(branch, simRun, scen, 'pNetPresentCostSystemMerged.csv', outputDir),
      ]);
      return { scen,
        techFuel:     tfR  ? processTechFuel(tfR)              : {},
        yearlyZone:   yzR  ? processYearlyZone(yzR)            : {},
        dispatch:     {},
        price:        prR  ? processHourlyPrice(prR)           : {},
        transmission: txR  ? processTransmissionResults(txR)   : {},
        plants:       plR  ? processPlants(plR)                : [],
        costs:        coR  ? processCosts(coR)                 : {},
        energyBalance: ebR ? processEnergyBalance(ebR)         : {},
        npvRaw:       coR  ? processNpvInput(coR)              : null,
        npvSystem:    npR  ? processNpvSystem(npR)             : null,
      };
    })).then(results => {
      if (stale) return;
      const rd = Object.fromEntries(results.map(r=>[r.scen, r]));
      setResultsData(rd);
      dispLoadedRef.current = new Set(); // dispatch cache is per-run
      const yrs = resultYears(results[0]?.techFuel||{});
      if (yrs.length) setRefYear(yrs[0]);
    }).finally(()=>{ if (!stale) setLoadingData(false); });
    return () => { stale = true; };
  }, [region, simRun, scenarioList]); // eslint-disable-line

  // The two files a run writes at its root rather than per scenario, both read once for
  // the whole run and both optional (see fetchRunRootCSV): summary.csv, which holds the
  // generation capex annuities the NPV cannot be assembled without, and npv_external.csv,
  // the costs a study prices outside the model.
  useEffect(() => {
    if (!region?.epm || !simRun) { setSummaryRows(null); setExtNpvRows(null); return; }
    const { branch } = region.epm;
    let stale = false;
    Promise.all([
      fetchRunRootCSV(branch, outputDir, simRun, 'summary.csv'),
      fetchRunRootCSV(branch, outputDir, simRun, 'npv_external.csv'),
    ]).then(([sm, ext]) => {
      if (stale) return;
      setSummaryRows(sm);
      setExtNpvRows(ext);
    });
    return () => { stale = true; };
  }, [region, simRun, outputDir]);

  // Lazy-load dispatch for the year/scenarios actually shown (big file, split per year).
  useEffect(() => {
    if (activeTab !== 'dispatch' || !region?.epm || !simRun || !refYear) return;
    const { branch } = region.epm;
    const wanted = [dispScenario, (cmpRef && cmpRef !== dispScenario) ? cmpRef : null]
      .filter(s => s && resultsData[s]);
    wanted.forEach(async scen => {
      const key = `${scen}|${refYear}`;
      if (dispLoadedRef.current.has(key)) return;
      dispLoadedRef.current.add(key);
      setLoadingDisp(true);
      try {
        const rows = await fetchDispatchYear(branch, simRun, scen, refYear, outputDir);
        const parsed = rows ? processDispatchResults(rows) : {};
        // Legacy unsplit file returns every year -> mark them all cached
        const years = new Set(); for (const ym of Object.values(parsed)) for (const y of Object.keys(ym)) years.add(y);
        years.forEach(y => dispLoadedRef.current.add(`${scen}|${y}`));
        setResultsData(prev => {
          const sd = prev[scen]; if (!sd) return prev;
          const dispatch = { ...sd.dispatch };
          for (const [z, ym] of Object.entries(parsed)) dispatch[z] = { ...(dispatch[z]||{}), ...ym };
          return { ...prev, [scen]: { ...sd, dispatch } };
        });
      } finally { setLoadingDisp(false); }
    });
  }, [activeTab, dispScenario, cmpRef, refYear, simRun, region, outputDir, resultsData]); // eslint-disable-line

  // ── Corridor overlays: compute once, apply whenever the map can take them ───
  //
  // `ntc-results` and `ext-flows` are created empty and filled by the effects further
  // down, so the data and the map can arrive in either order, and a map can be rebuilt
  // under an effect that has already run. Both keep their last computed features here
  // and push them through applyCorridors(), which sets them if the source exists and
  // otherwise leaves them for the next readiness signal. Nothing ever pushes an empty
  // collection over drawn corridors: no data loaded means keep what is on screen.
  const ntcRef = useRef({ feats: null, applied: null });
  const extFlowRef = useRef({ feats: null, applied: null });

  const applyCorridors = useCallback(() => {
    const map = mapRef.current;
    if (!alive(map)) return;
    for (const [ref, id] of [[ntcRef, 'ntc-results'], [extFlowRef, 'ext-flows']]) {
      const st = ref.current;
      if (!st.feats || st.feats === st.applied) continue;
      const src = source(map, id);
      if (!src) continue;
      src.setData({ type: 'FeatureCollection', features: st.feats });
      st.applied = st.feats;
    }
  }, []);

  // ── Map ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || !region || !zonesGJ || !wbBase) return;

    const zcMap = Object.fromEntries(zcmapRows.map(r=>[r.z, r.c]));
    const regionCountries = [...new Set(zcmapRows.map(r=>r.c))].sort();
    const colorMap = {};
    regionCountries.forEach((c,i) => { colorMap[c] = MAP_PALETTE[i%MAP_PALETTE.length]; });
    const zoneCentroids = zoneCentroidMap(zonesGJ, linestringGJ);
    const lons=Object.values(zoneCentroids).map(c=>c[0]);
    const lats=Object.values(zoneCentroids).map(c=>c[1]);
    const bounds=lons.length?[[Math.min(...lons)-2,Math.min(...lats)-2],[Math.max(...lons)+2,Math.max(...lats)+2]]:null;

    // A fresh map means fresh empty sources, so whatever was applied to the previous
    // one has to be pushed again.
    ntcRef.current.applied = null; extFlowRef.current.applied = null;

    const map = new maplibregl.Map({
      container:containerRef.current, style:buildWbStyle(wbBase, getT(theme), ZONE_MAP_VIEW),
      center:[lons.length?lons.reduce((a,b)=>a+b,0)/lons.length:20, lats.length?lats.reduce((a,b)=>a+b,0)/lats.length:0],
      zoom:4, minZoom:1, maxZoom:14, canvasContextAttributes: { preserveDrawingBuffer: true }, attributionControl:false,
    });
    mapRef.current = map;
    const popup = new maplibregl.Popup({ closeButton:false, closeOnClick:false, offset:10, className:`popup-${theme}` });

    map.on('load', async () => {
      const tv = getT(theme);
      if (bounds) map.fitBounds(bounds, { padding:60, duration:0, maxZoom:8 });

      // SDF arrow image (white triangle = inside, supports icon-color)
      const aW=14, aH=12;
      const aData = new Uint8Array(aW*aH*4).fill(0);
      for (let y=0;y<aH;y++) {
        const h=aH/2; const xMax=Math.round(y<=h?(y/h)*aW*0.85:((aH-y)/h)*aW*0.85);
        for (let x=0;x<xMax;x++) { const i=(y*aW+x)*4; aData[i]=255;aData[i+1]=255;aData[i+2]=255;aData[i+3]=255; }
      }
      if (!map.hasImage('ntc-arrow')) map.addImage('ntc-arrow', { width:aW, height:aH, data:aData }, { sdf:true });

      // The basemap is the backdrop. Everything that matters is added after it, so a
      // file that fails to arrive, or a map removed while these were in flight, must
      // not take the zone and corridor layers down with it.
      let countries = null, boundaries = null;
      try {
        countries = await fetchCountries('10m');
        boundaries = await fetchBoundaries('10m');
      } catch (err) {
        console.warn('basemap unavailable, drawing zones only', err);
      }
      if (!alive(map)) return;
      if (countries) {
        addCountriesSource(map, countries);
        addBoundariesSource(map, boundaries || { type:'FeatureCollection', features:[] });
      }

      const isoToCountry = {};
      for (const f of zonesGJ.features) isoToCountry[f.properties.ISO_A3]=f.properties.c;
      const uniqueIsos = [...new Set(zonesGJ.features.map(f=>f.properties.ISO_A3))];
      const fillExpr = ['match',['get','ISO_A3'],...uniqueIsos.flatMap(iso=>[iso,colorMap[isoToCountry[iso]]||'#888']),'transparent'];

      map.addSource('zones', { type:'geojson', data:zonesGJ, generateId:true });
      map.addLayer({ id:'zone-fill',   type:'fill', source:'zones', paint:{'fill-color':fillExpr,'fill-opacity':0.22} });
      map.addLayer({ id:'zone-hover',  type:'fill', source:'zones', filter:['==',['get','z'],''], paint:{'fill-color':fillExpr,'fill-opacity':0.55} });
      map.addLayer({ id:'zone-border', type:'line', source:'zones', paint:{'line-color':fillExpr,'line-width':1.2,'line-opacity':0.75} });

      // NTC lines — empty source, updated separately
      map.addSource('ntc-results', { type:'geojson', data:{type:'FeatureCollection',features:[]} });
      map.addLayer({ id:'ntc-bg', type:'line', source:'ntc-results',
        paint:{ 'line-color':['interpolate',['linear'],['get','util'],0,'#FFD700',0.5,'#FF8C00',1,'#E53935'],
          'line-width':['interpolate',['linear'],['get','vol'],0,1,500,2.5,5000,5], 'line-opacity':0.88 } });
      map.addLayer({ id:'ntc-arrows', type:'symbol', source:'ntc-results',
        layout:{ 'icon-image':'ntc-arrow', 'icon-allow-overlap':false, 'symbol-placement':'line', 'symbol-spacing':55, 'icon-rotation-alignment':'map', 'icon-pitch-alignment':'viewport', 'icon-size':0.9 },
        paint:{ 'icon-color':['interpolate',['linear'],['get','util'],0,'#FFD700',0.5,'#FF8C00',1,'#E53935'] } });
      // Wide invisible hit layer on top — makes lines easy to click/hover
      map.addLayer({ id:'ntc-hit', type:'line', source:'ntc-results',
        paint:{ 'line-color':'rgba(0,0,0,0)', 'line-width':20 } });

      // Click / hover on NTC hit layer
      const ntcPopup = new maplibregl.Popup({ closeButton:true, closeOnClick:true, offset:10, className:`popup-${theme}` });
      map.on('mouseenter','ntc-hit',()=>{ map.getCanvas().style.cursor='pointer'; });
      map.on('mouseleave','ntc-hit',()=>{ map.getCanvas().style.cursor=''; });
      map.on('click','ntc-hit',e=>{
        e.preventDefault();
        const p=e.features[0].properties;
        const fwd=parseFloat(p.fwd)||0, rev=parseFloat(p.rev)||0, net=fwd-rev;
        const util=p.util!=null?(parseFloat(p.util)*100).toFixed(0)+'%':'—';
        const cap=parseFloat(p.cap)||0;
        ntcPopup.setLngLat(e.lngLat).setHTML(
          `<b>${p.z} ↔ ${p.z2}</b> <span style="opacity:.5;font-size:0.8em">${p.yr}</span><br>` +
          `<span style="font-size:0.82em">` +
          `${p.z} → ${p.z2}: <b>${fmtBig(fwd)}</b> GWh<br>` +
          `${p.z2} → ${p.z}: <b>${fmtBig(rev)}</b> GWh<br>` +
          `Net: <b>${net>=0?'+':''}${fmtBig(net)}</b> GWh<br>` +
          `<span style="opacity:.7">Util: ${util} &nbsp;·&nbsp; Cap: ${fmtBig(cap)} MW</span>` +
          `</span>`
        ).addTo(map);
      });

      // NTC hit hover hint
      map.on('mousemove','ntc-hit',e=>{
        map.getCanvas().style.cursor='pointer';
        const p=e.features[0].properties;
        popup.setLngLat(e.lngLat).setHTML(`<b>${p.z} ↔ ${p.z2}</b><br><span style="opacity:.6;font-size:0.8em">click to see flow data</span>`).addTo(map);
      });
      map.on('mouseleave','ntc-hit',()=>{ map.getCanvas().style.cursor=''; popup.remove(); });

      // Zone hover — per-zone stats
      let hovZ=null;
      map.on('mousemove','zone-fill',e=>{
        if(map.queryRenderedFeatures(e.point,{layers:['ntc-hit']}).length){ popup.remove(); return; }
        map.getCanvas().style.cursor='pointer';
        const z=e.features[0].properties.z||''; const c=isoToCountry[e.features[0].properties.ISO_A3]||'';
        if (z!==hovZ) { hovZ=z; map.setFilter('zone-hover',['==',['get','z'],z]); }
        const rd=resultsDataRef.current; const yr=refYearRef.current;
        const scen=ovScenarioRef.current; const sd=rd[scen]||Object.values(rd)[0];
        let statsHtml='';
        if (sd && yr && z) {
          const cap = Object.values(sd.techFuel[z]?.CapacityTechFuel?.[yr]||{}).reduce((a,b)=>a+b,0)/1000;
          const dem = (sd.yearlyZone[z]?.DemandEnergyZone?.[yr]||0)/1000;
          const peak = (sd.yearlyZone[z]?.DemandPeakZone?.[yr]||0)/1000;
          const netImp = netImportGWh(sd.transmission,[z],yr)/1000;
          const hd=hoursDataRef.current;
          const zP=sd.price[z]?.[yr]||{}; let tw=0,tp=0;
          for(const[q,days]of Object.entries(zP))for(const[d,hrs]of Object.entries(days)){const w=hd[q]?.[d]||0;for(const p of Object.values(hrs)){tp+=p*w;tw+=w;}}
          const avgP=tw>0?tp/tw:null;
          statsHtml=`<br><span style="opacity:.8;font-size:0.78em">` +
            `${c?`Country: ${c}<br>`:''}` +
            `Installed: ${cap.toFixed(1)} GW &nbsp; Peak: ${peak.toFixed(1)} GW<br>` +
            `Demand: ${dem.toFixed(0)} TWh &nbsp; Net import: ${netImp>=0?'+':''}${netImp.toFixed(1)} TWh` +
            `${avgP!=null?` &nbsp; Avg price: ${avgP.toFixed(1)} $/MWh`:''}</span>`;
        }
        popup.setLngLat(e.lngLat).setHTML(`<b>${z||c}</b>${statsHtml}<br><span style="opacity:.5;font-size:0.7em">click to explore country</span>`).addTo(map);
      });
      map.on('mouseleave','zone-fill',()=>{ map.getCanvas().style.cursor=''; hovZ=null; map.setFilter('zone-hover',['==',['get','z'],'']),popup.remove(); });
      map.on('click','zone-fill',e=>{ if(map.queryRenderedFeatures(e.point,{layers:['ntc-hit']}).length) return; const c=isoToCountry[e.features[0].properties.ISO_A3]||''; navigate(`/region/${regionId}/results/country/${encodeURIComponent(c)}`); });
      // Fire AFTER all sources/layers are added so NTC update effect can find the source
      markStyleReady(map);
      setMapLoadedCount(c => c + 1);
      raiseBoundaries(map);
      // Corridors computed before the map was ready, plus any source added after this
      // handler by another effect. applyCorridors() is a no-op once its features are
      // on the map, so the style chatter of a hover filter costs nothing.
      applyCorridors();
      map.on('styledata', applyCorridors);
    });

    return () => { popup.remove(); dotMarkersRef.current.forEach(m=>m.remove()); dotMarkersRef.current=[]; pieMarkersRef.current.forEach(m=>m.remove()); pieMarkersRef.current=[]; mapRef.current?.remove(); };
  }, [region, theme, zonesGJ, zcmapRows, wbBase]); // eslint-disable-line

  // ── External zone layers (added once map + ext data ready) ──────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!styleReady(map) || !zonesGJ) return;
    if (!zonesExtGJ && !extNtc.length) return;
    const zoneCentroids = zoneCentroidMap(zonesGJ, linestringGJ);
    const extData = buildExtZoneData(zonesExtGJ, extNtc, zoneCentroids, refYear);
    if (source(map, 'ext-zones')) { updateExtZoneData(map, extData); return; }
    addExtZoneLayers(map, t, extData, { visible: showExtRef.current, mode: 'results', arrowImage: 'ntc-arrow' });
    const extPopup = new maplibregl.Popup({ closeButton:false, closeOnClick:false, offset:10, className:`popup-${theme}` });
    bindExtZoneHandlers(map, extPopup);
    bindExtFlowHandlers(map, extPopup);
    applyCorridors(); // ext-flows exists only now, and its features may already be in
  }, [mapLoadedCount, zonesGJ, linestringGJ, zonesExtGJ, extNtc, refYear, theme]); // eslint-disable-line

  // ── What crossed the external corridors ─────────────────────────────────────
  // The same job the ntc-results effect does for the internal ones, off the same run
  // and the same year, so both halves of a corridor map move together.
  useEffect(() => {
    const sd = resultsData[ovScenario] || Object.values(resultsData)[0];
    const tx = sd?.transmission;
    if (!tx || !Object.keys(tx).length) return; // run not loaded yet: keep what is drawn
    extFlowRef.current.feats = buildExtFlowFeatures({
      tx, extNtc, year: refYear,
      zoneCentroids: zoneCentroidMap(zonesGJ, linestringGJ),
      extNodeCoords: extNodeCoordMap(zonesExtGJ),
    });
    applyCorridors();
  }, [resultsData, ovScenario, refYear, zonesGJ, linestringGJ, zonesExtGJ, extNtc, mapLoadedCount, applyCorridors]);

  useEffect(() => { showExtRef.current = showExtZones; setExtZonesVisible(mapRef.current, showExtZones); }, [showExtZones]);

  // Off-grid areas (no toggle): painted like the rest of the country so the map has
  // no hole. Independent of the ext layers above, which return early without them.
  useEffect(() => {
    const map = mapRef.current;
    if (!styleReady(map) || !offgridGJ || source(map, 'offgrid-zones')) return;
    addOffgridLayers(map, t, offgridGJ);
  }, [mapLoadedCount, offgridGJ, theme]); // eslint-disable-line

  // ── Update NTC + price dots when data changes ────────────────────────────────
  useEffect(() => {
    if (!refYear) return;
    const sd = resultsData[ovScenario] || Object.values(resultsData)[0];
    const tx = sd?.transmission;
    if (!tx || !Object.keys(tx).length) return; // run not loaded yet: keep what is drawn
    const zcCentroids = zoneCentroidMap(zonesGJ, linestringGJ);

    const seen = new Set(); const features = [];
    for (const [z, z2map] of Object.entries(tx)) {
      for (const [z2, attrs] of Object.entries(z2map)) {
        const key=[z,z2].sort().join('||'); if(seen.has(key))continue; seen.add(key);
        const fwd = attrs.Interchange?.[refYear]||0;
        const rev = tx[z2]?.[z]?.Interchange?.[refYear]||0;
        const util = attrs.InterconUtilization?.[refYear]||tx[z2]?.[z]?.InterconUtilization?.[refYear]||0;
        const cap  = attrs.TransmissionCapacity?.[refYear]||tx[z2]?.[z]?.TransmissionCapacity?.[refYear]||0;
        const vol  = Math.abs(fwd)+Math.abs(rev);
        if (vol===0 && cap===0) continue;
        const lf = linestringGJ?.features?.find(f=>(f.properties.z===z&&(f.properties.z_other||f.properties.z2)===z2)||(f.properties.z===z2&&(f.properties.z_other||f.properties.z2)===z));
        const lfFwd = !lf || lf.properties.z === z;
        let coords = null;
        if (lf) coords=lf.geometry.coordinates;
        else if (zcCentroids[z]&&zcCentroids[z2]) coords=[zcCentroids[z],zcCentroids[z2]];
        if (!coords) continue;
        const finalCoords = (lfFwd === (fwd >= rev)) ? coords : [...coords].reverse();
        features.push({ type:'Feature', properties:{ z, z2, fwd, rev, util:Math.min(1,Math.max(0,util)), vol, cap, yr:refYear }, geometry:{ type:'LineString', coordinates:finalCoords } });
      }
    }
    ntcRef.current.feats = features;
    applyCorridors();
  }, [resultsData, refYear, ovScenario, zonesGJ, linestringGJ, mapLoadedCount, applyCorridors]); // eslint-disable-line

  // ── Update price dots ────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    dotMarkersRef.current.forEach(m=>m.remove()); dotMarkersRef.current=[];
    const sd = resultsData[ovScenario]||Object.values(resultsData)[0];
    if (!sd || !refYear || !zonesGJ) return;
    const tv = getT(theme);
    const zcCentroids = zoneCentroidMap(zonesGJ, linestringGJ);
    // Compute avg price per zone
    const prices = {};
    for (const [z, yearmap] of Object.entries(sd.price)) {
      const qmap=yearmap[refYear]||{};
      let tw=0,tp=0;
      for(const[q,days]of Object.entries(qmap))for(const[d,hrs]of Object.entries(days)){const w=hoursData[q]?.[d]||0;for(const p of Object.values(hrs)){tp+=p*w;tw+=w;}}
      if(tw>0) prices[z]=tp/tw;
    }
    const vals=Object.values(prices); if(!vals.length)return;
    const minP=Math.min(...vals), maxP=Math.max(...vals), rng=maxP-minP||1;
    for (const [z, price] of Object.entries(prices)) {
      const coord=zcCentroids[z]; if(!coord)continue;
      const t_=(price-minP)/rng;
      const el=priceDotEl(priceColor(t_),`${z}: ${price.toFixed(1)} USD/MWh`);
      dotMarkersRef.current.push(new maplibregl.Marker({element:el,anchor:'center'}).setLngLat(coord).addTo(map));
    }
    if (showExtZones) addExtPriceDots(map, dotMarkersRef.current,
      { zonesExtGJ, tradePrice, tradePriceExp, hoursData, year: refYear,
        min: minP, rng, colorFor: priceColor });
  }, [resultsData, refYear, ovScenario, zonesGJ, hoursData, theme, mapLoadedCount, showExtZones, zonesExtGJ, tradePrice, tradePriceExp]); // eslint-disable-line

  // ── Zone mix pie markers ──────────────────────────────────────────────────
  useEffect(() => {
    pieMarkersRef.current.forEach(m=>m.remove()); pieMarkersRef.current=[];
    const map=mapRef.current;
    if(!map||pieDispMode==='none'||!zonesGJ||!refYear)return;
    const sd=resultsData[ovScenario]||Object.values(resultsData)[0]; if(!sd)return;
    const attr=pieDispMode==='capacity'?'CapacityTechFuel':'EnergyTechFuelComplete';
    const unitDiv=1000; const unitLbl=pieDispMode==='capacity'?'GW':'TWh';
    const isDk=t.isDark;
    const allZonesList=zcmapRows.map(r=>r.z);
    const zcC = zoneCentroidMap(zonesGJ, linestringGJ);
    // Pre-compute zone avg prices for center color
    const zPrices={};
    for(const z of allZonesList){const qmap=sd.price[z]?.[refYear]||{};let tw=0,tp=0;for(const[q,days]of Object.entries(qmap))for(const[d,hrs]of Object.entries(days)){const w=hoursData[q]?.[d]||0;for(const p of Object.values(hrs)){tp+=p*w;tw+=w;}}if(tw>0)zPrices[z]=tp/tw;}
    const pVals=Object.values(zPrices); const pMin=pVals.length?Math.min(...pVals):0; const pRng=pVals.length?Math.max(...pVals)-pMin||1:1;
    const SZ=44,dpr=window.devicePixelRatio||1,cx=SZ/2,cy=SZ/2,oR=SZ/2-1.5,iR=oR*0.50;
    for(const z of allZonesList){
      const coord=zcC[z]; if(!coord)continue;
      const data=sd.techFuel[z]?.[attr]?.[refYear]; if(!data)continue;
      const entries=Object.entries(data).filter(([,v])=>v>0);
      if(!entries.length)continue;
      const total=entries.reduce((s,[,v])=>s+v,0); if(total<=0)continue;
      const canvas=document.createElement('canvas');
      canvas.width=Math.round(SZ*dpr); canvas.height=Math.round(SZ*dpr);
      canvas.style.width=SZ+'px'; canvas.style.height=SZ+'px';
      const ctx=canvas.getContext('2d');
      ctx.scale(dpr,dpr);
      ctx.shadowColor='rgba(0,0,0,0.35)'; ctx.shadowBlur=3; ctx.shadowOffsetY=1;
      let ang=-Math.PI/2;
      for(const[tf,val]of entries){const sw=(val/total)*2*Math.PI;ctx.beginPath();ctx.moveTo(cx+iR*Math.cos(ang),cy+iR*Math.sin(ang));ctx.arc(cx,cy,oR,ang,ang+sw);ctx.arc(cx,cy,iR,ang+sw,ang,true);ctx.closePath();ctx.fillStyle=techColor(tf);ctx.fill();ang+=sw;}
      ctx.shadowColor='transparent';
      // Center: price color (same gradient as price dots)
      const t_=zPrices[z]!=null?(zPrices[z]-pMin)/pRng:null;
      const centerBg=t_!=null?priceColor(t_).replace('rgb(','rgba(').replace(')',',0.92)'):(isDk?'rgba(15,20,30,0.88)':'rgba(245,248,252,0.92)');
      const lightBg=t_==null||t_<0.5;
      const textC=lightBg?'rgba(15,30,60,0.9)':'rgba(255,255,255,0.95)';
      const mutedC=lightBg?'rgba(60,80,120,0.65)':'rgba(255,255,255,0.55)';
      ctx.beginPath();ctx.arc(cx,cy,iR-0.5,0,2*Math.PI);ctx.fillStyle=centerBg;ctx.fill();
      const val=total/unitDiv; const valStr=val>=10?val.toFixed(0):val.toFixed(1);
      ctx.fillStyle=textC; ctx.font='bold 8px "Open Sans", system-ui, sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(valStr,cx,cy-2.5);
      ctx.fillStyle=mutedC; ctx.font='6px "Open Sans", system-ui, sans-serif'; ctx.fillText(unitLbl,cx,cy+6);
      canvas.title=`${z}: ${(total/unitDiv).toFixed(1)} ${unitLbl}`;
      pieMarkersRef.current.push(new maplibregl.Marker({element:canvas,anchor:'center'}).setLngLat(coord).addTo(map));
    }
  }, [pieDispMode, resultsData, ovScenario, refYear, zonesGJ, zcmapRows, hoursData, mapLoadedCount, theme]); // eslint-disable-line

  // ── Zone names (opt-in), under the donut when one is drawn, else under the price dot ──
  useZoneLabelMarkers(mapRef, {
    on: zoneLabels, zones: zcmapRows.map(r => r.z), zonesGJ, linestringGJ,
    zonesExtGJ: showExtZones ? zonesExtGJ : null,
    zoneOffset: pieDispMode === 'none' ? 8 : 23, extOffset: 8, tv: t, ready: mapLoadedCount,
  });

  // ── Computed ───────────────────────────────────────────────────────────────
  const zoneToCountry = useMemo(()=>Object.fromEntries(zcmapRows.map(r=>[r.z,r.c])),[zcmapRows]);
  const allZones      = useMemo(()=>zcmapRows.map(r=>r.z),[zcmapRows]);
  const allCountries  = useMemo(()=>[...new Set(zcmapRows.map(r=>r.c))].sort(),[zcmapRows]);
  const hasData       = Object.keys(resultsData).length>0;
  const allYears      = useMemo(()=>{ const f=Object.values(resultsData)[0]; return f?resultYears(f.techFuel):[]; },[resultsData]);
  const activeInd     = useMemo(()=>INDICATORS.find(i=>i.key===evIndicator)||INDICATORS[0],[evIndicator]);
  // In the per-country regime every zone is in play, so anything that still wants one
  // flat list  the extras, the totals, a stacked indicator  reads the whole region.
  const evZones       = useMemo(()=>evCountry==='all'||evCountry===EACH_COUNTRY?allZones:allZones.filter(z=>zoneToCountry[z]===evCountry),[evCountry,allZones,zoneToCountry]);
  const evGroups      = useMemo(()=>allCountries.map(c=>({name:c,zones:allZones.filter(z=>zoneToCountry[z]===c)})).filter(g=>g.zones.length),[allCountries,allZones,zoneToCountry]);
  const evEach        = evCountry===EACH_COUNTRY&&activeInd.source==='yearlyZone';
  const evGroupColor  = i => MAP_PALETTE[i%MAP_PALETTE.length];
  // Switching to a stacked indicator leaves the regime with nothing to draw, so hand the
  // selector back to 'all' rather than let it show a choice the chart is ignoring.
  useEffect(()=>{ if(evCountry===EACH_COUNTRY&&activeInd.source!=='yearlyZone') setEvCountry('all'); },[evCountry,activeInd.source]);
  const allTechfuels  = useMemo(()=>{ const tfs=new Set(); for(const d of Object.values(resultsData)) for(const z of Object.values(d.techFuel)) for(const a of Object.values(z)) for(const y of Object.values(a)) for(const tf of Object.keys(y)) tfs.add(tf); return[...tfs].filter(t=>t!=='Demand').sort();},[resultsData]);

  // ── NPV ────────────────────────────────────────────────────────────────────
  // A zone promoted to external (utils/zoneClass) is off the map and out of zcmap, but it
  // is still a zone of the model and its costs are still inside the objective, so the NPV
  // has to keep it or it stops reconciling. It gets the name the region gave it instead of
  // the bare zone id.
  const npvZoneCountry = useMemo(() => {
    const m = { ...zoneToCountry };
    for (const e of region?.epm?.externalZones || []) if (e?.zone) m[e.zone] = e.as || e.label || e.zone;
    return m;
  }, [zoneToCountry, region]);

  /** npv_external.csv -> { scenario: { zone: $m } }. Header: scenario,zone,value. */
  const extNpv = useMemo(() => {
    if (!extNpvRows?.length) return null;
    const out = {};
    for (const r of extNpvRows) {
      const s = (r.scenario || '').trim(), z = (r.zone || '').trim();
      const v = parseFloat(r.value);
      if (!s || !z || !Number.isFinite(v)) continue;
      (out[s] ||= {})[z] = (out[s][z] || 0) + v;
    }
    return out;
  }, [extNpvRows]);

  const npvData = useMemo(() => buildNpv({
    scenarios: scenarioList.filter(s => resultsData[s]),
    resultsData, summaryRows, extNpv, zoneToCountry: npvZoneCountry,
  }), [scenarioList, resultsData, summaryRows, extNpv, npvZoneCountry]);

  // ── Scenario descriptions ──────────────────────────────────────────────────
  const docIndex = useMemo(() => scenarioDocIndex(scnDocs, scenarioList), [scnDocs, scenarioList]);

  /** Net NPV benefit of a scenario against its OWN counterfactual — the crisis run is
   *  read against the crisis baseline, not the central one, or the price path would show
   *  up as if the project had caused it. null when either side has no NPV. The totals
   *  always land on the model's own NPV (utils/npv), so a gap does not rule one out. */
  const benefitOf = useMemo(() => scen => {
    const refName = docIndex.counterfactualOf(scen);
    const a = npvData.byScen[refName], b = npvData.byScen[scen];
    if (!refName || !a || !b) return null;
    return { net: a.total - b.total, ref: refName };
  }, [docIndex, npvData]);

  const firstDisp      = resultsData[dispScenario]?.dispatch||Object.values(resultsData)[0]?.dispatch||{};
  const dispAvailS     = useMemo(()=>{ const qs=new Set(); for(const z of Object.values(firstDisp)) for(const yr of Object.values(z)) for(const q of Object.keys(yr)) qs.add(q); return[...qs].sort();},[firstDisp]);
  const dispAvailD     = useMemo(()=>{ const ds=new Set(); for(const z of Object.values(firstDisp)) for(const yr of Object.values(z)) for(const q of Object.values(yr)) for(const d of Object.keys(q)) ds.add(d); return[...ds].sort();},[firstDisp]);
  const totalDays      = useMemo(()=>Object.values(hoursData).reduce((s,dts)=>s+Object.values(dts||{}).reduce((a,b)=>a+b,0),0)||365,[hoursData]);
  const activeDispZone = dispZone||'__all__';


  // Aggregate dispatch generation (excl. Demand) across zones when '__all__' selected
  const getZoneDisp = (sd, zone, year) => {
    if (zone !== '__all__') return sd.dispatch[zone]?.[year] || {};
    const agg = {};
    for (const z of allZones) {
      for (const [q, days] of Object.entries(sd.dispatch[z]?.[year]||{}))
        for (const [d, hours] of Object.entries(days))
          for (const [tt, tfs] of Object.entries(hours))
            for (const [tf, val] of Object.entries(tfs)) {
              if (!agg[q]) agg[q]={};if(!agg[q][d])agg[q][d]={};if(!agg[q][d][tt])agg[q][d][tt]={};
              agg[q][d][tt][tf]=(agg[q][d][tt][tf]||0)+val;
            }
    }
    return agg;
  };

  // Zone avg prices
  const zoneAvgPrices = useMemo(()=>{
    const sd=resultsData[ovScenario]||Object.values(resultsData)[0]; if(!sd||!refYear)return{};
    const res={};
    for(const[z,yearmap] of Object.entries(sd.price)){const qmap=yearmap[refYear]||{};let tw=0,tp=0; for(const[q,days]of Object.entries(qmap))for(const[d,hrs]of Object.entries(days)){const w=hoursData[q]?.[d]||0;for(const p of Object.values(hrs)){tp+=p*w;tw+=w;}} if(tw>0)res[z]=tp/tw;}
    return res;
  },[resultsData,ovScenario,refYear,hoursData]);

  const zonePriceRange = useMemo(()=>{
    const sd=resultsData[ovScenario]||Object.values(resultsData)[0]; if(!sd||!refYear)return{};
    const res={};
    for(const[z,yearmap] of Object.entries(sd.price)){
      const qmap=yearmap[refYear]||{}; let pmin=Infinity,pmax=-Infinity;
      for(const[,days]of Object.entries(qmap))for(const[,hrs]of Object.entries(days))for(const p of Object.values(hrs))if(p>0){if(p<pmin)pmin=p;if(p>pmax)pmax=p;}
      if(isFinite(pmin))res[z]={min:pmin,max:pmax};
    }
    return res;
  },[resultsData,ovScenario,refYear]);

  const priceVals = Object.values(zoneAvgPrices);
  const minPrice = priceVals.length?Math.min(...priceVals):0;
  const maxPrice = priceVals.length?Math.max(...priceVals):100;

  // Total trade
  const totalTradeGWh = useMemo(()=>{
    const tx=resultsData[ovScenario]?.transmission||{}; if(!refYear)return 0;
    const seen=new Set(); let total=0;
    for(const[z,z2map] of Object.entries(tx)) for(const[z2,attrs] of Object.entries(z2map)){const k=[z,z2].sort().join('||');if(seen.has(k))continue;seen.add(k);total+=Math.abs(attrs.Interchange?.[refYear]||0);}
    return total;
  },[resultsData,ovScenario,refYear]);

  // External trade with neighbouring (external) zones — $m aggregates from pCosts.
  const extTradeData = useMemo(()=>{
    const scen = resultsData[trScenario] ? trScenario : Object.keys(resultsData)[0];
    const co = resultsData[scen]?.costs; if(!co||!allYears.length) return null;
    const IMP='Import costs with external zones: $m', EXP='Export revenues with external zones: $m', SHB='Trade shared benefits: $m';
    const sum=(cat,y)=>allZones.reduce((s,z)=>s+(co[z]?.[cat]?.[y]||0),0);
    const imp=allYears.map(y=>+sum(IMP,y).toFixed(1));
    const exp=allYears.map(y=>+sum(EXP,y).toFixed(1));
    const shb=allYears.map(y=>+sum(SHB,y).toFixed(1));
    const net=allYears.map((_,i)=>+(exp[i]-imp[i]).toFixed(1));
    return (imp.some(v=>v)||exp.some(v=>v)||shb.some(v=>v)) ? {scen,imp,exp,shb,net} : null;
  },[resultsData,trScenario,allYears,allZones]);

  if (!region) return <div style={{ padding:40, color:t.text }}>Loading…</div>;

  const pickCmpRef = v => { setCmpRef(v); setCmpScenarios(defaultScenarios(scenarioList.filter(s=>s!==v))); };
  const selectStyle = { fontSize:'0.5rem',fontFamily:'inherit',padding:'2px 6px',borderRadius:3,border:`1px solid ${t.panelBorder}`,backgroundColor:t.panel,color:t.muted,cursor:'pointer' };
  const csvUrl = (scen, file) => resultCsvUrl(region.epm?.branch, simRun, scen, file, outputDir);
  const dlLines = (scen, file) => resultLines({ filename:file, regionName:region.name, branch:region.epm?.branch, simRun, scenario:scen, url:csvUrl(scen,file) });
  const DlRow = ({files}) => simRun&&files[0][0]?<div style={{marginTop:14,paddingTop:10,borderTop:`1px solid ${hexA(t.panelBorder,0.4)}`,display:'flex',gap:5,flexWrap:'wrap',alignItems:'center'}}><span style={{fontSize:'0.38rem',color:t.lblMuted}}>↓</span>{files.map(([sc,f])=><DownloadBtn key={f} url={csvUrl(sc,f)} filename={f} lines={dlLines(sc,f)} t={t}/>)}</div>:null;
  const TABS = ['overview','snapshot','evolution','dispatch','trade','plants','summary','scenarios','raw'];
  const TAB_LABELS = { overview:'Overview', snapshot:'Snapshot', evolution:'Evolution', dispatch:'Dispatch', trade:'Trade', plants:'Plants', summary:'Summary', scenarios:'Scenarios', raw:'Raw data' };

  // ── Overview mix ────────────────────────────────────────────────────────────
  const buildOverviewMix = () => {
    const sd=resultsData[ovScenario]; if(!sd||!refYear)return null;
    const grp=ovMixMode==='zone'
      ?allZones.filter(z=>sd.techFuel[z]?.CapacityTechFuel?.[refYear])
      :allCountries.filter(c=>allZones.some(z=>zoneToCountry[z]===c&&sd.techFuel[z]?.CapacityTechFuel?.[refYear]));
    if(!grp.length)return null;
    const tfs=allTechfuels.filter(tf=>grp.some(g=>((ovMixMode==='zone'?sd.techFuel[g]?.CapacityTechFuel?.[refYear]?.[tf]:allZones.filter(z=>zoneToCountry[z]===g).reduce((s,z)=>s+(sd.techFuel[z]?.CapacityTechFuel?.[refYear]?.[tf]||0),0))||0)>0));
    return { labels:grp, datasets:tfs.map(tf=>({ label:tf, data:grp.map(g=>ovMixMode==='zone'?Math.round(sd.techFuel[g]?.CapacityTechFuel?.[refYear]?.[tf]||0):Math.round(allZones.filter(z=>zoneToCountry[z]===g).reduce((s,z)=>s+(sd.techFuel[z]?.CapacityTechFuel?.[refYear]?.[tf]||0),0))), backgroundColor:techColor(tf), borderWidth:0, barThickness:14, stack:'a' })) };
  };

  // ── Evolution ───────────────────────────────────────────────────────────────
  // Zones this region wants read as neighbours rather than members — see
  // utils/zoneClass. Empty for every region that has not asked. Not memoised: it is
  // read inside extrasOf and never lands in a dependency array, so its identity does
  // not matter, and a useMemo down here would sit after the page's early returns.
  const extZones = externalZoneSet(region);

  /** Trade, unmet demand and line capacity for one scenario — see utils/annualExtras.
   *  at: x => { zones, year }, the rest of the context being the scenario's own data. */
  const extrasOf = (scen, indKey, xs, at) => extraSeries({ indKey, xs, allYears, extZones,
    at: x => { const c = at(x); return { tx: resultsData[scen]?.transmission || {},
      eb: resultsData[scen]?.energyBalance || {}, zones: c.zones, year: c.year }; } });
  const pushExtras = (datasets, series, scen, multi) => {
    for (const e of series) if (e.data.some(v => v !== 0)) datasets.push(extraDataset(e, scen, multi));
    orderStack(datasets);
  };

  const buildEvolution = () => {
    const activeSc=baseFirst(scenarioList.filter(s=>evScenarios.has(s))); if(!activeSc.length||!allYears.length)return null;
    const ind=activeInd;
    if (ind.source==='costs') {
      const cats=MAIN_COST_CATS.filter(cat=>activeSc.some(s=>evZones.some(z=>(resultsData[s]?.costs[z]?.[cat])||false)));
      const datasets=[]; for(const scen of activeSc) for(const cat of cats) {
        datasets.push({ label:`${scen} — ${COST_LABELS[cat]||cat}`, data:allYears.map(y=>Math.round(evZones.reduce((s,z)=>s+(resultsData[scen]?.costs[z]?.[cat]?.[y]||0),0)*10)/10), backgroundColor:hexA(costColor(cat),activeSc.length>1?0.5:0.82), borderColor:costColor(cat), borderWidth:activeSc.length>1?1:0, stack:scen });
      }
      return { labels:allYears, datasets };
    }
    if (ind.source==='yearlyZone') {
      if (evEach) {
        const multi=activeSc.length>1;
        return { labels:allYears, datasets:activeSc.flatMap((scen,si)=>evGroups.map((g,gi)=>({
          label:multi?`${scen} — ${g.name}`:g.name,
          data:allYears.map(y=>+getEvVal(scen,y,ind,g.zones).toFixed(2)),
          borderColor:evGroupColor(gi), backgroundColor:hexA(evGroupColor(gi),0.75),
          borderDash:SCEN_DASH[si%SCEN_DASH.length], borderWidth:2, pointRadius:0,
          fill:false, tension:0.3, type:'line', _country:g.name,
        }))) };
      }
      return { labels:allYears, datasets:activeSc.map((scen,i)=>({ label:scen, data:allYears.map(y=>+getEvVal(scen,y,ind).toFixed(2)), backgroundColor:hexA(SCEN_COLORS[i%SCEN_COLORS.length],0.75), borderColor:SCEN_COLORS[i%SCEN_COLORS.length], borderWidth:2, fill:false, tension:0.3, type:'line' })) };
    }
    if(ind.source==='trade'){
      const multi=activeSc.length>1;const datasets=[];const partnerSet=new Set();const pdCache={};
      for(const scen of activeSc){pdCache[scen]={};for(const y of allYears){const d=getTradePartners(scen,evZones,y);pdCache[scen][y]=d;Object.keys(d).forEach(p=>partnerSet.add(p));}}
      const allPartners=[...partnerSet].sort();const pColor=Object.fromEntries(allPartners.map((p,i)=>[p,MAP_PALETTE[i%MAP_PALETTE.length]]));
      for(let i=0;i<activeSc.length;i++){const scen=activeSc[i];const col=SCEN_COLORS[i%SCEN_COLORS.length];
        for(const p of allPartners){const pc=pColor[p];const impData=allYears.map(y=>+((pdCache[scen][y][p]?.imp)||0).toFixed(0));const expData=allYears.map(y=>+(-(pdCache[scen][y][p]?.exp||0)).toFixed(0));if(impData.some(v=>v!==0))datasets.push({label:multi?`${scen} — ${p} Imp.`:`${p} Imp.`,type:'bar',data:impData,backgroundColor:hexA(pc,0.82),borderWidth:0,stack:scen,_partner:p});if(expData.some(v=>v!==0))datasets.push({label:multi?`${scen} — ${p} Exp.`:`${p} Exp.`,type:'bar',data:expData,backgroundColor:hexA(pc,0.42),borderWidth:0,stack:scen,_partner:p});}
        datasets.push({label:multi?`${scen} — Net`:'Net',type:'line',data:allYears.map(y=>+Object.values(pdCache[scen][y]).reduce((s,v)=>s+(v.imp-v.exp),0).toFixed(0)),borderColor:col,borderWidth:1.5,pointRadius:0,tension:0.3,fill:false,stack:`__net_${i}__`});
      }
      return{labels:allYears,datasets};
    }
    const tfs=allTechfuels.filter(tf=>activeSc.some(s=>evZones.some(z=>(resultsData[s]?.techFuel[z]?.[ind.key]?.[allYears[0]]?.[tf]||0)>0)));
    const datasets=[]; for(const scen of activeSc) for(const tf of tfs) { datasets.push({ label:`${scen} — ${tf}`, data:allYears.map(y=>Math.round(evZones.reduce((s,z)=>s+(resultsData[scen]?.techFuel[z]?.[ind.key]?.[y]?.[tf]||0),0))), backgroundColor:hexA(techColor(tf),activeSc.length>1?0.5:0.85), borderColor:techColor(tf), borderWidth:activeSc.length>1?1:0, stack:scen }); }
    // Generation is only part of the balance: add the traded energy and the demand
    // that went unserved, or in MW the line capacity behind the stack.
    if(extraKind(ind.key)) for(const scen of activeSc)
      pushExtras(datasets, extrasOf(scen,ind.key,allYears,y=>({zones:evZones,year:y})), scen, activeSc.length>1);
    return { labels:allYears, datasets };
  };

  // ── Dispatch ────────────────────────────────────────────────────────────────
  const buildDispatch = () => {
    const sd=resultsData[dispScenario]; if(!sd||!activeDispZone||!refYear)return{chartData:{labels:[],datasets:[]},plugin:null};
    // An aggregate has no single marginal price: show the first zone's as a stand-in.
    const priceZone=activeDispZone==='__all__'?allZones[0]:activeDispZone;
    return buildDispatchSeries({
      slices, zDisp:getZoneDisp(sd,activeDispZone,refYear), price:sd.price[priceZone]?.[refYear],
      seasons:dispMode==='full'?dispAvailS:[dispSeason], days:dispAvailD,
      daySel:dispMode==='full'?'all':dispDay,
      isDark:t.isDark, mcColor:t.isDark?'rgba(255,255,255,0.88)':'#1E3A8A', hoursData, totalDays,
    });
  };

  // ── Trade ───────────────────────────────────────────────────────────────────
  const buildTradeBar = () => {
    const tx=resultsData[trScenario]?.transmission||{}; if(!refYear)return null;
    const imp={},exp={};
    for(const z of allZones){
      imp[z]=0;exp[z]=0;
      for(const[z2,attrs]of Object.entries(tx[z]||{}))exp[z]+=(attrs.Interchange?.[refYear]||0);
      for(const[z2,zm]of Object.entries(tx))if(z2!==z)imp[z]+=(zm[z]?.Interchange?.[refYear]||0);
    }
    const zones=allZones.filter(z=>imp[z]+exp[z]>0.5).sort((a,b)=>(imp[b]-exp[b])-(imp[a]-exp[a]));
    if(!zones.length)return null;
    const net=Object.fromEntries(zones.map(z=>[z,+(imp[z]-exp[z]).toFixed(1)]));
    const visImp = !isHidden('trade-bar','Imports');
    const visExp = !isHidden('trade-bar','Exports');
    return {
      labels:zones,
      datasets:[
        visImp&&{ label:'Imports', data:zones.map(z=>+imp[z].toFixed(1)), backgroundColor:hexA('#2E9EC8',0.78), borderWidth:0, barThickness:12, stack:'trade' },
        visExp&&{ label:'Exports', data:zones.map(z=>+(-exp[z]).toFixed(1)), backgroundColor:hexA('#E8C547',0.78), borderWidth:0, barThickness:12, stack:'trade' },
        // Net dot: thin bar at net position, independent of stack
        { label:'Net', data:zones.map(z=>net[z]), backgroundColor:t.isDark?'rgba(255,255,255,0.92)':'#1E3A8A', borderWidth:0, barThickness:3, order:0 },
      ].filter(Boolean),
      _imp:imp, _exp:exp, _net:net,
    };
  };

  const buildTradeEvolution = () => {
    const activeSc=baseFirst(scenarioList.filter(s=>trScenarios.has(s)&&resultsData[s]));
    if(!activeSc.length||!allYears.length)return null;
    const tx0=resultsData[activeSc[0]]?.transmission||{}; if(!Object.keys(tx0).length)return null;
    const corridors=[]; const seen=new Set();
    for(const[z,zm] of Object.entries(tx0))for(const z2 of Object.keys(zm)){const k=[z,z2].sort().join('||');if(!seen.has(k)){seen.add(k);corridors.push({z,z2,key:k});}}
    let attr,unit;
    if(trEvMetric==='volume')       { attr='Interchange';          unit='GWh'; }
    else if(trEvMetric==='capacity'){ attr='TransmissionCapacity'; unit='MW'; }
    else                            { attr='InterconUtilization';  unit='%'; }
    const PSTYLES=['circle','rectRot','triangle','crossRot','star','rect'];
    const isUtil=trEvMetric==='utilization'; const multi=activeSc.length>1;
    const datasets=activeSc.flatMap((scen,si)=>corridors.slice(0,12).map((c,ci)=>{
      const col=MAP_PALETTE[ci%MAP_PALETTE.length];
      const data=allYears.map(y=>{
        const tx=resultsData[scen]?.transmission||{};
        const fwd=tx[c.z]?.[c.z2]?.[attr]?.[y]||0; const rev=tx[c.z2]?.[c.z]?.[attr]?.[y]||0;
        return isUtil ? +(((fwd+rev)/2)*100).toFixed(1) : +(Math.abs(fwd)+Math.abs(rev)).toFixed(1);
      });
      const label=multi?`${scen} — ${c.z}↔${c.z2}`:`${c.z}↔${c.z2}`;
      if(isUtil) return{label,data,type:'line',borderColor:col,backgroundColor:hexA(col,0.1),borderWidth:1.5,fill:false,tension:0.3,pointStyle:PSTYLES[si%PSTYLES.length],pointRadius:3,pointHoverRadius:5};
      return{label,data,backgroundColor:hexA(col,0.82),borderColor:col,borderWidth:0,stack:scen,type:'bar'};
    }));
    return{labels:allYears,corridors,unit,datasets};
  };

  // ── Summary ─────────────────────────────────────────────────────────────────
  const buildSummary=()=>{
    const allSc=baseFirst(scenarioList.filter(s=>resultsData[s]));
    if(!allSc.length||!allYears.length)return null;
    const ref=summaryRef||allSc[0];
    const lastY=allYears[allYears.length-1];
    const compute=scen=>physicalStats(resultsData[scen],allZones,allYears,lastY,MAIN_COST_CATS);
    const data=Object.fromEntries(allSc.map(s=>[s,compute(s)]));
    return{allSc,ref,nonRef:allSc.filter(s=>s!==ref),data,lastY};
  };

  // ── Plants ──────────────────────────────────────────────────────────────────
  const buildPlantsList = () => rankPlants(resultsData[plScenario]?.plants, {
    attribute:plIndicator, year:refYear, topN:plTopN,
    keep:p=>plZone==='all'||p.z===plZone,
  });

  const buildLCOEBubble = () => {
    const pl=resultsData[plScenario]?.plants||[]; if(!refYear)return null;
    const lookup={};
    for(const p of pl){ if(!lookup[p.g])lookup[p.g]={techfuel:p.techfuel,z:p.z}; lookup[p.g][p.attribute]=p.attribute===p.attribute?p.value:lookup[p.g][p.attribute]; if(!lookup[p.g][p.attribute]||p.y===refYear)lookup[p.g][p.attribute]=p.y===refYear?p.value:lookup[p.g][p.attribute]; }
    // Build per refYear
    const byG={};
    for(const p of pl.filter(pp=>pp.y===refYear)){ if(!byG[p.g])byG[p.g]={techfuel:p.techfuel,z:p.z}; byG[p.g][p.attribute]=p.value; }
    const points=Object.entries(byG).map(([g,d])=>({g,techfuel:d.techfuel||'',zone:d.z||'',lcoe:d.PlantAnnualLCOE||0,util:(d.UtilizationPlant||0)*100,cap:d.CapacityPlant||0})).filter(p=>p.lcoe>0&&p.util>0&&p.cap>0&&(plZone==='all'||p.zone===plZone));
    const tfs=[...new Set(points.map(p=>p.techfuel))].sort();
    return { datasets:tfs.map(tf=>({ label:tf, data:points.filter(p=>p.techfuel===tf).map(p=>({ x:+p.util.toFixed(1), y:+p.lcoe.toFixed(1), r:Math.min(Math.max(Math.sqrt(p.cap)*0.6,3),20), _plant:p.g, _cap:p.cap })), backgroundColor:hexA(techColor(tf),0.65), borderColor:techColor(tf), borderWidth:1 })).filter(d=>d.data.length>0) };
  };

  // ── Scenario comparison (shared across tabs) ──────────────────────────────
  const findBase = scens => scens.find(s=>/^base/i.test(s))||scens[0];
  const SCEN_COLORS = ['#1B6CA8','#36B5B5','#4169E1','#D4A820','#B83838','#7048A8','#4A9E6A','#2E9EC8'];
  /** The indicator's value for one scenario and one year, over `zs`  the whole Evolution
   *  selection by default, one country's zones when the per-country regime asks. */
  const getEvVal = (scen, y, ind, zs = evZones) => {
    if(ind.source==='techFuel') return zs.reduce((s,z)=>s+Object.values(resultsData[scen]?.techFuel[z]?.[ind.key]?.[y]||{}).reduce((a,b)=>a+b,0),0);
    if(ind.source==='yearlyZone') return yzAgg(resultsData[scen]?.yearlyZone, ind.key, zs, y);
    if(ind.source==='costs') return MAIN_COST_CATS.reduce((s,cat)=>s+zs.reduce((s2,z)=>s2+(resultsData[scen]?.costs[z]?.[cat]?.[y]||0),0),0);
    return 0;
  };
  // Trade helper: {imp, exp, net} per zone for a given year
  const getTradePartners = (scen, zones, y) => {
    const tx=resultsData[scen]?.transmission||{};const zSet=new Set(zones);const partners={};
    for(const z of zones){
      for(const[z2,attrs]of Object.entries(tx[z]||{})){if(zSet.has(z2))continue;const v=attrs.Interchange?.[y]||0;if(v){if(!partners[z2])partners[z2]={imp:0,exp:0};partners[z2].exp+=v;}}
      for(const[z2,zm]of Object.entries(tx)){if(zSet.has(z2))continue;const v=zm[z]?.Interchange?.[y]||0;if(v){if(!partners[z2])partners[z2]={imp:0,exp:0};partners[z2].imp+=v;}}
    }
    return partners;
  };
  const getTradeVals = (scen, zones, y) => {
    const tx=resultsData[scen]?.transmission||{};
    return Object.fromEntries(zones.map(z=>{
      const imp=Object.values(tx).reduce((s,zm)=>s+(zm[z]?.Interchange?.[y]||0),0);
      const exp=Object.values(tx[z]||{}).reduce((s,attrs)=>s+(attrs.Interchange?.[y]||0),0);
      return[z,{imp:+imp.toFixed(1),exp:+exp.toFixed(1),net:+(imp-exp).toFixed(1)}];
    }));
  };
  const buildCmpEvolution = () => {
    if(!cmpRef||!allYears.length)return null;
    const compareScs=baseFirst([...cmpScenarios].filter(s=>resultsData[s]&&s!==cmpRef));
    if(!compareScs.length)return null;
    const ind=activeInd;
    const multi=compareScs.length>1;

    if(ind.source==='techFuel'){
      // Stacked signed bars by techfuel, grouped by scenario (same visual as main chart but showing Δ)
      const tfs=allTechfuels.filter(tf=>
        [...compareScs,cmpRef].some(scen=>evZones.some(z=>
          allYears.some(y=>(resultsData[scen]?.techFuel[z]?.[ind.key]?.[y]?.[tf]||0)>0)
        ))
      );
      const datasets=[];
      for(const scen of compareScs){
        for(const tf of tfs){
          const data=allYears.map(y=>{
            const ref=evZones.reduce((s,z)=>s+(resultsData[cmpRef]?.techFuel[z]?.[ind.key]?.[y]?.[tf]||0),0);
            const cmp=evZones.reduce((s,z)=>s+(resultsData[scen]?.techFuel[z]?.[ind.key]?.[y]?.[tf]||0),0);
            return Math.round(cmp-ref);
          });
          if(data.some(v=>v!==0))datasets.push({
            label:multi?`${scen} — ${tf}`:tf,
            data,
            backgroundColor:hexA(techColor(tf),multi?0.5:0.82),
            borderColor:techColor(tf),
            borderWidth:multi?1:0,
            stack:scen,
          });
        }
        if(extraKind(ind.key)){
          const at=y=>({zones:evZones,year:y});
          pushExtras(datasets, extraDelta(extrasOf(scen,ind.key,allYears,at), extrasOf(cmpRef,ind.key,allYears,at)), scen, multi);
        }
      }
      return{labels:allYears,datasets};
    }

    if(ind.source==='trade'){
      const datasets=[];const partnerSet=new Set();const pdS={},pdR={};
      for(const scen of compareScs){pdS[scen]={};pdR[scen]={};for(const y of allYears){const s=getTradePartners(scen,evZones,y);const r=getTradePartners(cmpRef,evZones,y);pdS[scen][y]=s;pdR[scen][y]=r;Object.keys(s).forEach(p=>partnerSet.add(p));Object.keys(r).forEach(p=>partnerSet.add(p));}}
      const allPartners=[...partnerSet].sort();const pColor=Object.fromEntries(allPartners.map((p,i)=>[p,MAP_PALETTE[i%MAP_PALETTE.length]]));
      for(let i=0;i<compareScs.length;i++){const scen=compareScs[i];const col=SCEN_COLORS[(i+1)%SCEN_COLORS.length];
        for(const p of allPartners){const pc=pColor[p];const dImp=allYears.map(y=>+((pdS[scen][y][p]?.imp||0)-(pdR[scen][y][p]?.imp||0)).toFixed(0));const dExp=allYears.map(y=>+((pdR[scen][y][p]?.exp||0)-(pdS[scen][y][p]?.exp||0)).toFixed(0));if(dImp.some(v=>v!==0))datasets.push({label:multi?`Δ ${scen} ${p} Imp.`:`Δ ${p} Imp.`,type:'bar',data:dImp,backgroundColor:hexA(pc,0.82),borderWidth:0,stack:scen,_partner:p});if(dExp.some(v=>v!==0))datasets.push({label:multi?`Δ ${scen} ${p} Exp.`:`Δ ${p} Exp.`,type:'bar',data:dExp,backgroundColor:hexA(pc,0.42),borderWidth:0,stack:scen,_partner:p});}
        const dNet=allYears.map(y=>+(Object.values(pdS[scen][y]).reduce((acc,v)=>acc+(v.imp-v.exp),0)-Object.values(pdR[scen][y]).reduce((acc,v)=>acc+(v.imp-v.exp),0)).toFixed(0));
        if(dNet.some(v=>v!==0))datasets.push({label:multi?`Δ ${scen} Net`:'Δ Net',type:'line',data:dNet,borderColor:col,borderWidth:1.5,pointRadius:0,tension:0.3,fill:false,stack:`__dnet_${i}__`});
      }
      return{labels:allYears,datasets};
    }
    // Per country: the same signed bar, cut by country. The cuts add up to the single bar
    // the aggregate regime draws, so the height of the stack is unchanged.
    if(evEach) return{labels:allYears,datasets:compareScs.flatMap((scen)=>evGroups.map((g,gi)=>{
      const data=allYears.map(y=>+(getEvVal(scen,y,ind,g.zones)-getEvVal(cmpRef,y,ind,g.zones)).toFixed(1));
      return data.some(v=>v!==0)?{label:multi?`Δ ${scen} ${g.name}`:`Δ ${g.name}`,data,
        backgroundColor:hexA(evGroupColor(gi),0.78),borderColor:evGroupColor(gi),borderWidth:0,
        stack:scen,_country:g.name}:null;
    }).filter(Boolean))};
    // yearlyZone / costs: single signed bar per scenario (no techfuel breakdown available)
    return{labels:allYears,datasets:compareScs.map((scen,i)=>({
      label:`Δ ${scen}`,
      data:allYears.map(y=>+(getEvVal(scen,y,ind)-getEvVal(cmpRef,y,ind)).toFixed(1)),
      backgroundColor:hexA(SCEN_COLORS[(i+1)%SCEN_COLORS.length],0.75),
      borderColor:SCEN_COLORS[(i+1)%SCEN_COLORS.length],
      borderWidth:0, stack:scen,
    }))};
  };

  // ── Snapshot ──────────────────────────────────────────────────────────────
  const buildSnapshot = () => {
    if(!refYear||!snapScenarios.size)return null;
    const activeSc=baseFirst(scenarioList.filter(s=>snapScenarios.has(s)&&resultsData[s]));
    if(!activeSc.length)return null;
    const ind=INDICATORS.find(i=>i.key===snapIndicator)||INDICATORS[0];
    const groups=snapView==='zone'?(snapCountry!=='all'?allZones.filter(z=>zoneToCountry[z]===snapCountry):allZones):allCountries;
    const multi=activeSc.length>1;
    const getZones=grp=>snapView==='zone'?[grp]:allZones.filter(z=>zoneToCountry[z]===grp);
    const getTf=(scen,grp,tf)=>getZones(grp).reduce((s,z)=>s+(resultsData[scen]?.techFuel[z]?.[ind.key]?.[refYear]?.[tf]||0),0);
    const getTotal=(scen,grp)=>{
      const zs=getZones(grp);
      if(ind.source==='techFuel') return zs.reduce((s,z)=>s+Object.values(resultsData[scen]?.techFuel[z]?.[ind.key]?.[refYear]||{}).reduce((a,b)=>a+b,0),0);
      if(ind.source==='yearlyZone') return yzAgg(resultsData[scen]?.yearlyZone, ind.key, zs, refYear);
      if(ind.source==='costs') return MAIN_COST_CATS.reduce((s,cat)=>s+zs.reduce((s2,z)=>s2+(resultsData[scen]?.costs[z]?.[cat]?.[refYear]||0),0),0);
      return 0;
    };
    if(ind.source==='techFuel'){
      const tfs=allTechfuels.filter(tf=>activeSc.some(scen=>groups.some(g=>getTf(scen,g,tf)>0)));
      const datasets=[];
      for(const scen of activeSc) for(const tf of tfs){
        const data=groups.map(g=>Math.round(getTf(scen,g,tf)));
        if(data.some(v=>v>0)) datasets.push({label:multi?`${scen} — ${tf}`:tf,data,backgroundColor:hexA(techColor(tf),multi?0.5:0.82),borderColor:techColor(tf),borderWidth:multi?1:0,stack:scen});
      }
      if(extraKind(ind.key)) for(const scen of activeSc)
        pushExtras(datasets, extrasOf(scen,ind.key,groups,g=>({zones:getZones(g),year:refYear})), scen, multi);
      return{labels:groups,datasets,ind};
    }
    if(ind.source==='trade'){
      const datasets=[];const netPluginData=[];const partnerSet=new Set();const gpCache={};
      const zToG={};for(const g of groups)for(const z of getZones(g))zToG[z]=g;
      const buildGpMap=(scen)=>{const tx=resultsData[scen]?.transmission||{};const r={};for(const g of groups){r[g]={};for(const z of getZones(g)){for(const[z2,attrs]of Object.entries(tx[z]||{})){const pg=zToG[z2];if(!pg||pg===g)continue;const v=attrs.Interchange?.[refYear]||0;if(v){r[g][pg]=r[g][pg]||{imp:0,exp:0};r[g][pg].exp+=v;}}for(const[z2,zm]of Object.entries(tx)){const pg=zToG[z2];if(!pg||pg===g)continue;const v=zm[z]?.Interchange?.[refYear]||0;if(v){r[g][pg]=r[g][pg]||{imp:0,exp:0};r[g][pg].imp+=v;}}}}return r;};
      for(const scen of activeSc){gpCache[scen]=buildGpMap(scen);for(const g of groups)Object.keys(gpCache[scen][g]||{}).forEach(p=>partnerSet.add(p));}
      const allPartners=[...partnerSet].sort();const pColor=Object.fromEntries(allPartners.map((p,i)=>[p,MAP_PALETTE[i%MAP_PALETTE.length]]));
      for(let i=0;i<activeSc.length;i++){const scen=activeSc[i];const col=SCEN_COLORS[i%SCEN_COLORS.length];
        for(const p of allPartners){const pc=pColor[p];const impData=groups.map(g=>+((gpCache[scen][g]?.[p]?.imp)||0).toFixed(0));const expData=groups.map(g=>+(-(gpCache[scen][g]?.[p]?.exp||0)).toFixed(0));if(impData.some(v=>v!==0))datasets.push({label:multi?`${scen} — ${p} Imp.`:`${p} Imp.`,type:'bar',data:impData,backgroundColor:hexA(pc,0.82),borderWidth:0,stack:scen,_partner:p});if(expData.some(v=>v!==0))datasets.push({label:multi?`${scen} — ${p} Exp.`:`${p} Exp.`,type:'bar',data:expData,backgroundColor:hexA(pc,0.42),borderWidth:0,stack:scen,_partner:p});}
        netPluginData.push({si:i,data:groups.map(g=>+Object.values(gpCache[scen][g]||{}).reduce((s,v)=>s+(v.imp-v.exp),0).toFixed(0)),color:col});
      }
      return{labels:groups,datasets,ind,netPlugin:buildNetDotPlugin(netPluginData)};
    }
    return{labels:groups,datasets:activeSc.map((scen,i)=>({label:scen,data:groups.map(g=>+(getTotal(scen,g)).toFixed(2)),backgroundColor:hexA(SCEN_COLORS[i%SCEN_COLORS.length],0.78),borderWidth:0,stack:scen})).filter(d=>d.data.some(v=>v>0)),ind};
  };

  const buildSnapshotDelta = () => {
    if(!cmpRef||!refYear)return null;
    const compareScs=baseFirst([...cmpScenarios].filter(s=>resultsData[s]&&s!==cmpRef));
    if(!compareScs.length)return null;
    const ind=INDICATORS.find(i=>i.key===snapIndicator)||INDICATORS[0];
    const groups=snapView==='zone'?(snapCountry!=='all'?allZones.filter(z=>zoneToCountry[z]===snapCountry):allZones):allCountries;
    const multi=compareScs.length>1;
    const getZones=grp=>snapView==='zone'?[grp]:allZones.filter(z=>zoneToCountry[z]===grp);
    const getTf=(scen,grp,tf)=>getZones(grp).reduce((s,z)=>s+(resultsData[scen]?.techFuel[z]?.[ind.key]?.[refYear]?.[tf]||0),0);
    const getTotal=(scen,grp)=>{
      const zs=getZones(grp);
      if(ind.source==='techFuel') return zs.reduce((s,z)=>s+Object.values(resultsData[scen]?.techFuel[z]?.[ind.key]?.[refYear]||{}).reduce((a,b)=>a+b,0),0);
      if(ind.source==='yearlyZone') return yzAgg(resultsData[scen]?.yearlyZone, ind.key, zs, refYear);
      return 0;
    };
    if(ind.source==='techFuel'){
      const tfs=allTechfuels.filter(tf=>[...compareScs,cmpRef].some(scen=>groups.some(g=>getTf(scen,g,tf)>0)));
      const datasets=[];
      for(const scen of compareScs) for(const tf of tfs){
        const data=groups.map(g=>+(getTf(scen,g,tf)-getTf(cmpRef,g,tf)).toFixed(0));
        if(data.some(v=>v!==0)) datasets.push({label:multi?`${scen} — ${tf}`:tf,data,backgroundColor:hexA(techColor(tf),multi?0.5:0.82),borderColor:techColor(tf),borderWidth:multi?1:0,stack:scen});
      }
      if(extraKind(ind.key)) for(const scen of compareScs){
        const at=g=>({zones:getZones(g),year:refYear});
        pushExtras(datasets, extraDelta(extrasOf(scen,ind.key,groups,at), extrasOf(cmpRef,ind.key,groups,at)), scen, multi);
      }
      return{labels:groups,datasets,ind};
    }
    if(ind.source==='trade'){
      const datasets=[];const netPluginData=[];const partnerSet=new Set();const gpS={};
      const zToG={};for(const g of groups)for(const z of getZones(g))zToG[z]=g;
      const buildGpMap2=(scen)=>{const tx=resultsData[scen]?.transmission||{};const r={};for(const g of groups){r[g]={};for(const z of getZones(g)){for(const[z2,attrs]of Object.entries(tx[z]||{})){const pg=zToG[z2];if(!pg||pg===g)continue;const v=attrs.Interchange?.[refYear]||0;if(v){r[g][pg]=r[g][pg]||{imp:0,exp:0};r[g][pg].exp+=v;}}for(const[z2,zm]of Object.entries(tx)){const pg=zToG[z2];if(!pg||pg===g)continue;const v=zm[z]?.Interchange?.[refYear]||0;if(v){r[g][pg]=r[g][pg]||{imp:0,exp:0};r[g][pg].imp+=v;}}}}return r;};
      const gpRef=buildGpMap2(cmpRef);
      for(const scen of compareScs){gpS[scen]=buildGpMap2(scen);for(const g of groups){Object.keys(gpS[scen][g]||{}).forEach(p=>partnerSet.add(p));Object.keys(gpRef[g]||{}).forEach(p=>partnerSet.add(p));}}
      const allPartners=[...partnerSet].sort();const pColor=Object.fromEntries(allPartners.map((p,i)=>[p,MAP_PALETTE[i%MAP_PALETTE.length]]));
      for(let i=0;i<compareScs.length;i++){const scen=compareScs[i];const col=SCEN_COLORS[(i+1)%SCEN_COLORS.length];
        for(const p of allPartners){const pc=pColor[p];const dImp=groups.map(g=>+((gpS[scen][g]?.[p]?.imp||0)-(gpRef[g]?.[p]?.imp||0)).toFixed(0));const dExp=groups.map(g=>+((gpRef[g]?.[p]?.exp||0)-(gpS[scen][g]?.[p]?.exp||0)).toFixed(0));if(dImp.some(v=>v!==0))datasets.push({label:multi?`Δ ${scen} ${p} Imp.`:`Δ ${p} Imp.`,type:'bar',data:dImp,backgroundColor:hexA(pc,0.82),borderWidth:0,stack:scen,_partner:p});if(dExp.some(v=>v!==0))datasets.push({label:multi?`Δ ${scen} ${p} Exp.`:`Δ ${p} Exp.`,type:'bar',data:dExp,backgroundColor:hexA(pc,0.42),borderWidth:0,stack:scen,_partner:p});}
        const dNet=groups.map(g=>+(Object.values(gpS[scen][g]||{}).reduce((s,v)=>s+(v.imp-v.exp),0)-Object.values(gpRef[g]||{}).reduce((s,v)=>s+(v.imp-v.exp),0)).toFixed(0));
        if(dNet.some(v=>v!==0))netPluginData.push({si:i,data:dNet,color:col});
      }
      return{labels:groups,datasets,ind,netPlugin:buildNetDotPlugin(netPluginData)};
    }
    const DCOLS=['#3887C4','#4A9E6A','#D4A820','#B83838'];
    return{labels:groups,datasets:compareScs.map((scen,i)=>({label:`Δ ${scen}`,data:groups.map(g=>+(getTotal(scen,g)-getTotal(cmpRef,g)).toFixed(2)),backgroundColor:hexA(DCOLS[i%4],0.72),borderColor:DCOLS[i%4],borderWidth:0,stack:scen})).filter(d=>d.data.some(v=>v!==0)),ind};
  };

  // ── Dispatch Δ ────────────────────────────────────────────────────────────
  const buildDispatchDelta = () => {
    const cmpScen=cmpRef;
    if(!cmpScen||cmpScen===dispScenario||!refYear||!activeDispZone||!resultsData[cmpScen])return{chartData:{labels:[],datasets:[]},plugin:null};
    const sdA=resultsData[dispScenario],sdB=resultsData[cmpScen];
    if(!sdA||!sdB)return{chartData:{labels:[],datasets:[]},plugin:null};
    const priceZone=activeDispZone==='__all__'?allZones[0]:activeDispZone;
    return buildDispatchDeltaSeries({
      slices, zA:getZoneDisp(sdA,activeDispZone,refYear), zB:getZoneDisp(sdB,activeDispZone,refYear),
      priceA:sdA.price[priceZone]?.[refYear], priceB:sdB.price[priceZone]?.[refYear],
      seasons:dispMode==='full'?dispAvailS:[dispSeason], days:dispAvailD,
      daySel:dispMode==='full'?'all':dispDay,
      isDark:t.isDark, mcColor:t.isDark?'rgba(255,255,255,0.88)':'#1E3A8A', hoursData, totalDays,
    });
  };

  // ── Plants compare ────────────────────────────────────────────────────────
  const buildPlantsCompare = () => {
    const cmpScen=cmpRef;
    if(!cmpScen||cmpScen===plScenario||!refYear)return null;
    const pl2=resultsData[cmpScen]?.plants||[];
    return Object.fromEntries(pl2.filter(p=>p.attribute===plIndicator&&p.y===refYear&&p.value>0).map(p=>[p.g,p.value]));
  };

  // ── Trade multi-scenario ──────────────────────────────────────────────────
  const buildTradeBarMulti = () => {
    const activeSc=baseFirst(scenarioList.filter(s=>trScenarios.has(s)&&resultsData[s]));
    if(!activeSc.length||!refYear)return null;
    const getData=(scen)=>{const tx=resultsData[scen]?.transmission||{};const imp={},exp={};for(const z of allZones){imp[z]=0;exp[z]=0;for(const[,attrs]of Object.entries(tx[z]||{}))exp[z]+=(attrs.Interchange?.[refYear]||0);for(const[z2,zm]of Object.entries(tx))if(z2!==z)imp[z]+=(zm[z]?.Interchange?.[refYear]||0);}return{imp,exp};};
    const trData=Object.fromEntries(activeSc.map(s=>[s,getData(s)]));
    const zones=allZones.filter(z=>activeSc.some(s=>(trData[s].imp[z]+trData[s].exp[z])>0.5)).sort((a,b)=>(trData[activeSc[0]].imp[b]-trData[activeSc[0]].exp[b])-(trData[activeSc[0]].imp[a]-trData[activeSc[0]].exp[a]));
    if(!zones.length)return null;
    const IMP_COLORS=['#2E9EC8','#1B6CA8','#36B5B5','#4169E1'];
    const EXP_COLORS=['#E8C547','#D4A820','#EDD770','#4CAFE8'];
    const datasets=[];
    for(let i=0;i<activeSc.length;i++){
      const scen=activeSc[i];
      if(!isHidden('trade-ms',`${scen}_imp`))datasets.push({label:`${scen} — Imp.`,data:zones.map(z=>+(trData[scen].imp[z]||0).toFixed(0)),backgroundColor:hexA(IMP_COLORS[i%4],0.78),borderWidth:0,barThickness:Math.max(4,12/activeSc.length),stack:scen});
      if(!isHidden('trade-ms',`${scen}_exp`))datasets.push({label:`${scen} — Exp.`,data:zones.map(z=>+(-trData[scen].exp[z]||0).toFixed(0)),backgroundColor:hexA(EXP_COLORS[i%4],0.78),borderWidth:0,barThickness:Math.max(4,12/activeSc.length),stack:scen});
    }
    // Comparison Δ datasets when cmpMode=delta and cmpRef in trScenarios
    if(cmpMode==='delta'&&cmpRef&&trScenarios.has(cmpRef)&&activeSc.filter(s=>s!==cmpRef).length){
      const ref=getData(cmpRef);
      for(const scen of activeSc.filter(s=>s!==cmpRef)){
        datasets.push({label:`Δ ${scen} Imp.`,data:zones.map(z=>+((trData[scen].imp[z]||0)-(ref.imp[z]||0)).toFixed(0)),backgroundColor:hexA(IMP_COLORS[activeSc.indexOf(scen)%4],0.5),borderWidth:1,borderColor:IMP_COLORS[activeSc.indexOf(scen)%4],barThickness:4,stack:`delta_${scen}`});
        datasets.push({label:`Δ ${scen} Exp.`,data:zones.map(z=>+((trData[scen].exp[z]||0)-(ref.exp[z]||0)).toFixed(0)),backgroundColor:hexA(EXP_COLORS[activeSc.indexOf(scen)%4],0.5),borderWidth:1,borderColor:EXP_COLORS[activeSc.indexOf(scen)%4],barThickness:4,stack:`delta_${scen}`});
      }
    }
    return{labels:zones,datasets,_activeSc:activeSc};
  };

  const overviewMix=buildOverviewMix(), evolutionData=buildEvolution();
  const cmpEvData=buildCmpEvolution();
  const snapData=buildSnapshot();
  const snapDeltaData=buildSnapshotDelta();
  // ── Trade corridor Δ ─────────────────────────────────────────────────────
  const buildTradeCmpDelta = () => {
    if(!cmpRef||!allYears.length||!resultsData[cmpRef])return null;
    const compareScs=baseFirst([...cmpScenarios].filter(s=>resultsData[s]&&s!==cmpRef));
    if(!compareScs.length)return null;
    // Sync metric with upper chart
    const attr=trEvMetric==='capacity'?'TransmissionCapacity':trEvMetric==='utilization'?'InterconUtilization':'Interchange';
    const unit=trEvMetric==='volume'?'GWh':trEvMetric==='capacity'?'MW':'%';
    const firstActive=baseFirst([...trScenarios].filter(s=>resultsData[s]))[0]||cmpRef||scenarioList[0];
    const tx0=resultsData[firstActive]?.transmission||{};
    const seen=new Set(); const allCorridors=[];
    for(const[z,zm] of Object.entries(tx0)) for(const z2 of Object.keys(zm)){const k=[z,z2].sort().join('||');if(!seen.has(k)){seen.add(k);allCorridors.push({z,z2,key:k});}}
    // Sync hidden corridors with upper chart
    const corridors=allCorridors.slice(0,12).filter(c=>!isHidden('trade-ev',`${c.z}↔${c.z2}`));
    if(!corridors.length)return null;
    const getVal=(scen,c,y)=>{const tx=resultsData[scen]?.transmission||{};
      if(trEvMetric==='utilization') return (((tx[c.z]?.[c.z2]?.[attr]?.[y]||0)+(tx[c.z2]?.[c.z]?.[attr]?.[y]||0))/2)*100;
      return Math.abs(tx[c.z]?.[c.z2]?.[attr]?.[y]||0)+Math.abs(tx[c.z2]?.[c.z]?.[attr]?.[y]||0);
    };
    const isUtil=trEvMetric==='utilization';
    return{labels:allYears,unit,datasets:compareScs.flatMap((scen,i)=>corridors.map((c,ci)=>{
      const ci2=allCorridors.findIndex(a=>a.key===c.key);
      const col=MAP_PALETTE[ci2%MAP_PALETTE.length];
      const data=allYears.map(y=>+(getVal(scen,c,y)-getVal(cmpRef,c,y)).toFixed(isUtil?1:0));
      if(isUtil) return{label:`${compareScs.length>1?scen+' — ':''}${c.z}↔${c.z2}`,data,type:'line',borderColor:col,backgroundColor:hexA(col,0.1),borderWidth:2,fill:false,tension:0.3,pointRadius:0};
      return{label:`${compareScs.length>1?scen+' — ':''}${c.z}↔${c.z2}`,data,backgroundColor:hexA(col,0.72),borderColor:col,borderWidth:0,stack:scen};
    })).filter(d=>d.data.some(v=>v!==0))};
  };

  const dispResult=buildDispatch();
  const dispDeltaResult=(cmpRef&&cmpRef!==dispScenario&&resultsData[cmpRef])?buildDispatchDelta():{chartData:{labels:[],datasets:[]}};
  const plantsCompareMap=buildPlantsCompare();
  const tradeCmpDeltaData=buildTradeCmpDelta();
  const tradeEvData=buildTradeEvolution();
  const plantsData=buildPlantsList(), lcoeData=buildLCOEBubble(), summaryData=buildSummary();
  const plUnit=plantDisplay(plIndicator).unit;
  const dispTechfuels=dispResult.chartData.datasets.filter(d=>d.label!=='Marginal cost'&&d.label!=='Demand').map(d=>d.label);

  // ── Legend helpers ──────────────────────────────────────────────────────────
  const tfLabel=d=>d.label.includes(' — ')?d.label.split(' — ')[1]:d.label;
  // Evolution bars cut into segments, whose total the bar labels give (utils/barTotals).
  const evStacked=activeInd.source==='techFuel'||activeInd.source==='costs';
  // Cut by country, a Δ adds up to the region's only for a quantity: not for a price.
  const evAdditive=!String(activeInd.unit||'').includes('/');
  const makeLegend=(id,items,clickable=true)=>{
    const hidden=hiddenMap[id]||new Set();
    return <div style={{width:90,flexShrink:0,display:'flex',flexDirection:'column',gap:2,paddingTop:4,maxHeight:220,overflowY:'auto'}}>
      {items.map(({label,color,shape,fill,dash})=><div key={label} onClick={clickable?()=>toggleHidden(id,label):undefined} style={{display:'flex',alignItems:'center',gap:3,cursor:clickable?'pointer':'default',opacity:hidden.has(label)?0.25:1}}>
        {shape==='line'?<div style={{width:12,height:2,borderRadius:1,flexShrink:0,...(dash&&dash.length?{backgroundImage:`repeating-linear-gradient(90deg,${color} 0 ${dash[0]}px,transparent 0 ${dash[0]+dash[1]}px)`}:{backgroundColor:color})}}/>:<div style={{width:8,height:8,borderRadius:shape==='circle'?'50%':2,background:fill||color,flexShrink:0}}/>}
        <span style={{fontSize:'0.4rem',color:t.muted,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{label}</span>
      </div>)}
      {clickable&&<div style={{fontSize:'0.38rem',color:t.lblMuted,marginTop:4,display:'flex',gap:6}}>
        <span onClick={()=>setHiddenMap(p=>({...p,[id]:new Set(items.map(i=>i.label))}))} style={{cursor:'pointer',textDecoration:'underline'}}>None</span>
        <span onClick={()=>setHiddenMap(p=>({...p,[id]:new Set()}))} style={{cursor:'pointer',textDecoration:'underline'}}>All</span>
      </div>}
    </div>;
  };

  // ── JSX ─────────────────────────────────────────────────────────────────────
  return (
    <div style={{ display:'flex', height:'calc(100vh - 46px)' }}
      onMouseMove={e=>{ if(!isDraggingRef.current)return; const dx=dragStartX.current-e.clientX; setPanelWidth(Math.max(380,dragStartW.current+dx)); }}
      onMouseUp={()=>{ isDraggingRef.current=false; }}
      onMouseLeave={()=>{ isDraggingRef.current=false; }}
    >

      {/* Map */}
      <div style={{ position:'relative', flex:1 }}>
        <div ref={containerRef} style={{ width:'100%', height:'100%', backgroundColor:t.bg }} />
        <MapDownload mapRef={mapRef} t={t} name={()=>ttl(`${region.name} map`,refYear)}/>
        {/* Breadcrumb */}
        <div style={{ position:'absolute', top:10, left:10, zIndex:10, display:'flex', gap:4, alignItems:'center', fontSize:'0.52rem', color:t.text, backgroundColor:t.panel, border:`1px solid ${t.panelBorder}`, borderRadius:5, padding:'4px 10px', boxShadow:'0 1px 4px rgba(0,0,0,.18)' }}>
          <Link to="/" style={{ color:t.lblMuted, textDecoration:'none' }}>World</Link>
          <span style={{ color:t.lblMuted }}>›</span>
          <Link to={`/region/${regionId}`} style={{ color:t.lblMuted, textDecoration:'none' }}>{region.name}</Link>
          <span style={{ color:t.lblMuted }}>›</span>
          <span style={{ color:t.lbl, fontWeight:600 }}>Results</span>
        </div>
        {/* Year selector (map overlay) */}
        {allYears.length>0 && (
          <div style={{ position:'absolute', top:10, right:10, zIndex:10, display:'flex', gap:5, alignItems:'center', fontSize:'0.52rem', color:t.text, backgroundColor:t.panel, border:`1px solid ${t.panelBorder}`, borderRadius:5, padding:'4px 8px', boxShadow:'0 1px 4px rgba(0,0,0,.18)' }}>
            <span style={{ color:t.lblMuted, fontSize:'0.44rem', textTransform:'uppercase', letterSpacing:'0.04em' }}>Year</span>
            <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>{allYears.map(y=><option key={y} value={y}>{y}</option>)}</select>
          </div>
        )}
        {/* Map legend */}
        {hasData && (
          <div style={{ position:'absolute', bottom:14, left:10, zIndex:10, backgroundColor:hexA(t.panel,0.92), border:`1px solid ${t.panelBorder}`, borderRadius:6, padding:'8px 10px', fontSize:'0.43rem', color:t.muted, minWidth:120 }}>
            <div style={{ marginBottom:5 }}>
              <div style={{ fontSize:'0.38rem', color:t.lblMuted, marginBottom:2 }}>Interco utilization</div>
              <div style={{ background:'linear-gradient(to right, #FFD700, #FF8C00, #E53935)', height:5, borderRadius:3, marginBottom:2 }}/>
              <div style={{ display:'flex', justifyContent:'space-between' }}>
                <span>0%</span><span>100%</span>
              </div>
            </div>
            {Object.keys(zoneAvgPrices).length>0 && (
              <div>
                <div style={{ fontSize:'0.38rem', color:t.lblMuted, marginBottom:2 }}>Zonal price (marginal cost)</div>
                <div style={{ background:'linear-gradient(to right, #FFFFFF, #1B6CA8)', height:5, borderRadius:3, marginBottom:2 }}/>
                <div style={{ display:'flex', justifyContent:'space-between' }}>
                  <span>{minPrice.toFixed(0)}</span><span>{maxPrice.toFixed(0)} $/MWh</span>
                </div>
              </div>
            )}
            <div style={{ marginTop:8, paddingTop:8, borderTop:`1px solid ${hexA(t.panelBorder,0.5)}` }}>
              <div style={{ fontSize:'0.38rem', color:t.lblMuted, marginBottom:4 }}>Zone mix</div>
              <div style={{ display:'flex', gap:4 }}>
                <Pill active={pieDispMode==='none'} onClick={()=>setPieDispMode('none')}>—</Pill>
                <Pill active={pieDispMode==='capacity'} onClick={()=>setPieDispMode('capacity')}>Cap.</Pill>
                <Pill active={pieDispMode==='energy'} onClick={()=>setPieDispMode('energy')}>Gen.</Pill>
              </div>
            </div>
            {(zonesExtGJ||extNtc.length>0) && (
              <div style={{ marginTop:8, paddingTop:8, borderTop:`1px solid ${hexA(t.panelBorder,0.5)}` }}>
                <div style={{ fontSize:'0.38rem', color:t.lblMuted, marginBottom:4 }}>External neighbours</div>
                <Pill active={showExtZones} onClick={()=>setShowExtZones(v=>!v)}>Ext. zones</Pill>
              </div>
            )}
            <div style={{ marginTop:8, paddingTop:8, borderTop:`1px solid ${hexA(t.panelBorder,0.5)}` }}>
              <div style={{ fontSize:'0.38rem', color:t.lblMuted, marginBottom:4 }}>Labels</div>
              <Pill active={zoneLabels} onClick={()=>setZoneLabels(v=>!v)}>Zone names</Pill>
            </div>
          </div>
        )}
      </div>

      {/* Drag handle */}
      <div
        style={{ width:5, flexShrink:0, cursor:'col-resize', backgroundColor:'transparent', zIndex:10 }}
        onMouseDown={e=>{ isDraggingRef.current=true; dragStartX.current=e.clientX; dragStartW.current=panelWidth; e.preventDefault(); }}
      />

      {/* Right panel — resizable */}
      <div style={{ zoom, width:unzoom(panelWidth,zoom), flexShrink:0, height:unzoom('100%',zoom), overflowY:'auto', padding:'18px 16px', backgroundColor:t.panel, borderLeft:`1px solid ${t.panelBorder}` }}>
        <PanelZoomControl t={t} zoom={zoom} inc={inc} dec={dec} reset={reset}/>

        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:'0.52rem', color:t.lblMuted, marginBottom:2 }}>
            <Link to={`/region/${regionId}`} style={{ color:t.lblMuted, textDecoration:'none' }}>← {region.name} · Inputs</Link>
          </div>
          <div style={{ fontSize:'1rem', fontWeight:700, color:t.lbl }}>{region.name} — Results</div>
        </div>

        {/* Run selector */}
        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:14, padding:'8px 10px', border:`1px solid ${t.panelBorder}`, borderRadius:6, backgroundColor:hexA(t.panelBorder,0.12) }}>
          <span style={{ fontSize:'0.5rem', color:t.lblMuted, flexShrink:0 }}>Run</span>
          {loadingRuns ? <span style={{ fontSize:'0.5rem', color:t.lblMuted }}>Loading…</span>
            : runList.length>0 ? <select value={simRun||''} onChange={e=>setSimRun(e.target.value)} style={{ ...selectStyle, flex:1 }}>{runList.map(r=><option key={r} value={r}>{r}</option>)}</select>
            : <span style={{ fontSize:'0.5rem', color:t.lblMuted }}>{runsUnreachable
                ? 'Data host unreachable — the results are published; this network or browser is blocking them'
                : 'No results — push output CSVs to epm/output/'}</span>}
        </div>

        {/* Tabs */}
        <div style={{ display:'flex', gap:0, marginBottom:16, borderBottom:`1px solid ${t.panelBorder}` }}>
          {TABS.map(tab=>(
            <button key={tab} onClick={()=>setActiveTab(tab)} style={{ fontSize:'0.5rem', fontFamily:'inherit', padding:'6px 12px', border:'none', borderBottom:activeTab===tab?`2px solid ${t.lbl}`:'2px solid transparent', backgroundColor:'transparent', color:activeTab===tab?t.lbl:t.lblMuted, cursor:'pointer', fontWeight:activeTab===tab?600:400 }}>{TAB_LABELS[tab]}</button>
          ))}
        </div>

        {loadingData && <div style={{ padding:'24px 0', textAlign:'center', color:t.lblMuted, fontSize:'0.6rem' }}>Loading results…</div>}
        {/* The raw tab reads the files itself, so it still has something to show when the chart pipeline found nothing. */}
        {!loadingData&&!hasData&&simRun&&activeTab!=='raw'&&activeTab!=='scenarios'&&<div style={{ padding:'24px 0', textAlign:'center', color:t.lblMuted, fontSize:'0.6rem' }}>No data for this run.</div>}

        {/* ════ OVERVIEW ════ */}
        {hasData&&activeTab==='overview'&&(
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
            <div style={{ display:'flex', gap:6, alignItems:'center', flexWrap:'wrap' }}>
              <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>{allYears.map(y=><option key={y} value={y}>{y}</option>)}</select>
              <select value={ovScenario||''} onChange={e=>setOvScenario(e.target.value)} style={selectStyle}>{scenarioList.map(s=><option key={s} value={s}>{s}</option>)}</select>
            </div>
            {/* KPIs + overview pie */}
            {(()=>{ const sd=resultsData[ovScenario]; if(!sd||!refYear)return null;
              const totGW=allZones.reduce((s,z)=>s+Object.values(sd.techFuel[z]?.CapacityTechFuel?.[refYear]||{}).reduce((a,b)=>a+b,0),0)/1000;
              const demTWh=allZones.reduce((s,z)=>s+(sd.yearlyZone[z]?.DemandEnergyZone?.[refYear]||0),0)/1000;
              const avgRegPrice=priceVals.length?priceVals.reduce((a,b)=>a+b,0)/priceVals.length:null;
              // Aggregated pie data
              const pieTfMap={}; for(const z of allZones){for(const[tf,v] of Object.entries(sd.techFuel[z]?.CapacityTechFuel?.[refYear]||{}))if(v>0)pieTfMap[tf]=(pieTfMap[tf]||0)+v;}
              const pieTfs=Object.keys(pieTfMap).filter(tf=>pieTfMap[tf]>0).sort();
              return <div style={{ display:'flex', gap:10, alignItems:'center' }}>
                {pieTfs.length>0&&<OverviewPie tfs={pieTfs} data={pieTfs.map(tf=>pieTfMap[tf])} total={pieTfs.reduce((s,tf)=>s+pieTfMap[tf],0)} unitDiv={1000} unitLbl="GW" t={t}/>}
                <div style={{ flex:1, display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:6 }}>
                  {[
                    {l:`Installed ${refYear}`,v:`${totGW.toFixed(1)} GW`},
                    {l:`Demand ${refYear}`,v:`${demTWh.toFixed(0)} TWh`},
                    {l:`Trade volume`,v:totalTradeGWh>0?`${fmtBig(totalTradeGWh)} GWh`:'—'},
                    {l:'Avg price',v:avgRegPrice!=null?`${avgRegPrice.toFixed(1)} $/MWh`:'—'},
                  ].map(({l,v})=>(
                    <div key={l} style={{ border:`1px solid ${t.panelBorder}`, borderRadius:6, padding:'7px 8px' }}>
                      <div style={{ fontSize:'0.4rem', color:t.lblMuted, marginBottom:2 }}>{l}</div>
                      <div style={{ fontSize:'0.7rem', fontWeight:700, color:t.lbl }}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>;
            })()}
            {/* Mix chart */}
            {overviewMix&&<div>
              <SectionTitle t={t} right={<div style={{display:'flex',gap:3}}><Pill active={ovMixMode==='zone'} onClick={()=>setOvMixMode('zone')}>Zone</Pill><Pill active={ovMixMode==='country'} onClick={()=>setOvMixMode('country')}>Country</Pill></div>}>Capacity mix (MW)</SectionTitle>
              <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                <div style={{flex:1,minWidth:0}}>
                  <CJChart name={ttl('Capacity mix (MW)',ovMixMode==='zone'?'by zone':'by country',ovScenario,refYear)} type="bar" height={Math.min(overviewMix.labels.length*22+24,300)} cacheKey={`ov|${ovScenario}|${refYear}|${ovMixMode}|${theme}|${[...hiddenMap['ov-mix']||[]].join(',')}`} data={{...overviewMix,datasets:overviewMix.datasets.filter(d=>!isHidden('ov-mix',d.label))}}
                    plugins={[barTotalPlugin({axis:'x',color:t.muted,unit:'MW',fmt:v=>fmt(v)})]}
                    options={{...cjDefaults(t),indexAxis:'y',layout:{padding:{right:62}},scales:{x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},y:{stacked:true,grid:{display:false},ticks:{color:t.muted,font:{size:9}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,footerColor:t.lbl,footerFont:{size:10},callbacks:{label:ctx=>`${ctx.dataset.label}: ${fmt(ctx.parsed.x)} MW`,footer:barTotalFooter({axis:'x',unit:'MW',fmt:v=>fmt(v),filtered:(hiddenMap['ov-mix']?.size||0)>0})}}}}}
                  />
                </div>
                {makeLegend('ov-mix',allTechfuels.filter(tf=>overviewMix.datasets.some(d=>d.label===tf)).map(tf=>({label:tf,color:techColor(tf)})))}
              </div>
            </div>}
            {/* Prices by zone */}
            {Object.keys(zoneAvgPrices).length>0&&(()=>{
              const zones=Object.keys(zoneAvgPrices).sort((a,b)=>zoneAvgPrices[b]-zoneAvgPrices[a]);
              const rng=maxPrice-minPrice||1;
              return <div>
                <SectionTitle t={t}>Average marginal price by zone (USD/MWh)</SectionTitle>
                <CJChart name={ttl('Average marginal price by zone ($/MWh)',ovScenario,refYear)} type="bar" height={Math.min(zones.length*22+24,220)} cacheKey={`pz|${ovScenario}|${refYear}|${theme}`}
                  data={{labels:zones,datasets:[
                    {label:'Range',data:zones.map(z=>{const r=zonePriceRange[z];return r?[+r.min.toFixed(1),+r.max.toFixed(1)]:[+zoneAvgPrices[z].toFixed(1),+zoneAvgPrices[z].toFixed(1)];}),backgroundColor:zones.map(z=>priceBarColor((zoneAvgPrices[z]-minPrice)/rng).replace('rgb(','rgba(').replace(')',',0.18)')),borderWidth:0,barThickness:10},
                    {type:'scatter',label:'Avg',data:zones.map(z=>({x:+zoneAvgPrices[z].toFixed(1),y:z})),pointStyle:'line',rotation:90,radius:6,borderWidth:2.5,borderColor:zones.map(z=>priceBarColor((zoneAvgPrices[z]-minPrice)/rng))},
                  ]}}
                  options={{...cjDefaults(t),indexAxis:'y',scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9}}},y:{grid:{display:false},ticks:{color:t.muted,font:{size:9}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>{const z=zones[ctx.dataIndex];if(ctx.datasetIndex===0){const r=zonePriceRange[z];return r&&r.min!==r.max?`${r.min.toFixed(1)}–${r.max.toFixed(1)} $/MWh`:'';} return`Avg: ${zoneAvgPrices[z]?.toFixed(1)} $/MWh`;},title:ctx=>ctx[0]?.label||''}}}}}
                />
                <div style={{display:'flex',gap:12,marginTop:4,fontSize:'0.44rem',color:t.muted}}>
                  <span>Avg: <b style={{color:t.lbl}}>{(priceVals.reduce((a,b)=>a+b,0)/priceVals.length).toFixed(1)} $/MWh</b></span>
                  <span>Min: <b style={{color:t.lbl}}>{minPrice.toFixed(1)}</b></span>
                  <span>Max: <b style={{color:t.lbl}}>{maxPrice.toFixed(1)}</b></span>
                </div>
              </div>;
            })()}
            <DlRow files={[[ovScenario,'pTechFuelMerged.csv'],[ovScenario,'pYearlyZoneMerged.csv'],[ovScenario,'pHourlyPrice.csv']]}/>
          </div>
        )}

        {/* ════ SNAPSHOT ════ */}
        {hasData&&activeTab==='snapshot'&&(
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            {/* Controls */}
            <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
              <select value={snapIndicator} onChange={e=>setSnapIndicator(e.target.value)} style={selectStyle}>{INDICATORS.map(ind=><option key={ind.key} value={ind.key}>{ind.label}</option>)}</select>
              <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>{allYears.map(y=><option key={y} value={y}>{y}</option>)}</select>
              <div style={{width:1,height:14,backgroundColor:t.panelBorder}}/>
              <select value={snapCountry} onChange={e=>setSnapCountry(e.target.value)} style={selectStyle}><option value="all">All countries</option>{allCountries.map(c=><option key={c} value={c}>{c}</option>)}</select>
              <Pill active={snapView==='zone'} onClick={()=>setSnapView('zone')}>Zone</Pill>
              <Pill active={snapView==='country'} onClick={()=>setSnapView('country')}>Country</Pill>
              <div style={{width:1,height:14,backgroundColor:t.panelBorder}}/>
              <ScenarioPicker t={t} all={scenarioList} selected={snapScenarios} onChange={setSnapScenarios}/>
            </div>
            {/* Absolute chart */}
            {snapData&&snapData.datasets.length>0?
              <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                <ScenarioKey t={t} scenarios={baseFirst(scenarioList.filter(s=>snapScenarios.has(s)&&resultsData[s]))}/>
                <div style={{flex:1,minWidth:0}}>
                  <CJChart name={ttl(snapData.ind?.label||'Snapshot',refYear,snapView==='country'?'by country':'by zone',snapCountry!=='all'?snapCountry:null,scenList(snapScenarios))} type="bar" height={220}
                    cacheKey={`snap|${snapIndicator}|${refYear}|${snapView}|${theme}|${[...snapScenarios].sort().join(',')}|${[...hiddenMap['snap-tf']||[]].join(',')}`}
                    plugins={(()=>{const aSc=baseFirst(scenarioList.filter(s=>snapScenarios.has(s)&&resultsData[s]));const sp=makeScenPlugin(aSc,t.muted);return[snapData.netPlugin,sp,snapData.ind?.source==='techFuel'&&barTotalPlugin({axis:'y',color:t.muted})].filter(Boolean);})()}
                    data={{labels:snapData.labels,datasets:snapData.datasets.filter(d=>{if(snapData.ind?.source==='trade')return!isHidden('snap-trade-p',d._partner||'');return!isHidden('snap-tf',tfLabel(d));})}}
                    options={{...cjDefaults(t),datasets:{bar:{barPercentage:0.72}},scales:{
                      x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},maxRotation:45,autoSkip:true,maxTicksLimit:20,padding:16}},
                      y:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:(snapData.ind||{}).unit||'',color:t.muted,font:{size:8}}},
                    },plugins:{...cjDefaults(t).plugins,legend:{display:false},tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false,footerColor:t.lbl,footerFont:{size:10},callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw?.toLocaleString?.()??ctx.raw}`,footer:snapData.ind?.source==='techFuel'?barTotalFooter({axis:'y',unit:(snapData.ind||{}).unit,filtered:anyHidden('snap-tf')}):undefined}}}}}
                  />
                  {[...snapScenarios].filter(s=>resultsData[s]).length>1&&(snapData.ind?.source==='yearlyZone'?
                    <div style={{display:'flex',gap:6,flexWrap:'wrap',marginTop:3,fontSize:'0.42rem',color:t.muted}}>
                      {baseFirst(scenarioList.filter(s=>snapScenarios.has(s)&&resultsData[s])).map((s,i)=><span key={s} style={{display:'flex',alignItems:'center',gap:3}}><span style={{display:'inline-block',width:7,height:7,borderRadius:1,backgroundColor:SCEN_COLORS[i%SCEN_COLORS.length]}}/>{s}</span>)}
                    </div>:
                    <div style={{display:'none'}}></div>
                  )}
                </div>
                {snapData.ind?.source!=='trade'&&makeLegend('snap-tf',[...new Set(snapData.datasets.map(tfLabel))].map(seriesLegendItem))}
                {snapData.ind?.source==='trade'&&(()=>{const ps=[...new Set(snapData.datasets.filter(d=>d._partner).map(d=>d._partner))].sort();return makeLegend('snap-trade-p',ps.map((p,i)=>({label:p,color:MAP_PALETTE[i%MAP_PALETTE.length]})));})()}
              </div>
            :<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>Select at least one scenario.</div>}
            {/* Δ vs ref section */}
            {scenarioList.length>1&&(
              <div style={{borderTop:`1px solid ${hexA(t.panelBorder,0.4)}`,paddingTop:10,marginTop:2,display:'flex',flexDirection:'column',gap:8}}>
                <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
                  <span style={{fontSize:'0.47rem',letterSpacing:'2px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase'}}>Δ vs ref:</span>
                  <select value={cmpRef||''} onChange={e=>pickCmpRef(e.target.value)} style={selectStyle}>
                    {scenarioList.map(s=><option key={s} value={s}>{s}</option>)}
                  </select>
                  <ScenarioPicker t={t} label="Compare" all={scenarioList} exclude={[cmpRef]} selected={cmpScenarios} onChange={setCmpScenarios}/>
                </div>
                {snapDeltaData&&snapDeltaData.datasets.length>0?
                  <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                    <div style={{flex:1,minWidth:0}}>
                      <CJChart name={ttl(`Δ ${snapDeltaData.ind?.label||'Snapshot'} vs ${cmpRef}`,refYear,snapView==='country'?'by country':'by zone',snapCountry!=='all'?snapCountry:null,scenList(cmpScenarios))} type="bar" height={180}
                        cacheKey={`snap-d|${snapIndicator}|${refYear}|${snapView}|${theme}|${cmpRef}|${[...cmpScenarios].sort().join(',')}|${[...hiddenMap['snap-tf']||[]].join(',')}`}
                        plugins={[snapDeltaData.netPlugin,snapDeltaData.ind?.source==='techFuel'&&barTotalPlugin({axis:'y',color:t.muted,delta:true})].filter(Boolean)}
                        data={{labels:snapDeltaData.labels,datasets:snapDeltaData.datasets.filter(d=>{if(snapDeltaData.ind?.source==='trade')return!isHidden('snap-trade-p',d._partner||'');return!isHidden('snap-tf',tfLabel(d));})}}
                        options={{...cjDefaults(t),scales:{
                          x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},maxRotation:45,autoSkip:true,maxTicksLimit:20}},
                          y:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:(snapDeltaData.ind||{}).unit||'',color:t.muted,font:{size:8}}},
                        },plugins:{...cjDefaults(t).plugins,legend:{display:false},tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false,footerColor:t.lbl,footerFont:{size:10},callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw>0?'+':''}${ctx.raw?.toLocaleString?.()??ctx.raw}`,footer:barTotalFooter({axis:'y',delta:true,unit:(snapDeltaData.ind||{}).unit,filtered:anyHidden(snapDeltaData.ind?.source==='trade'?'snap-trade-p':'snap-tf')})}}}}}
                      />
                      {[...cmpScenarios].filter(s=>resultsData[s]&&s!==cmpRef).length>0&&(
                        <div style={{fontSize:'0.42rem',color:t.lblMuted,marginTop:3}}>Δ vs <b style={{color:t.muted}}>{cmpRef}</b>: {baseFirst([...cmpScenarios].filter(s=>resultsData[s]&&s!==cmpRef)).join(' · ')}</div>
                      )}
                    </div>
                    {snapDeltaData.ind?.source!=='trade'&&makeLegend('snap-tf',[...new Set(snapDeltaData.datasets.map(tfLabel))].map(seriesLegendItem))}
                    {snapDeltaData.ind?.source==='trade'&&(()=>{const ps=[...new Set(snapDeltaData.datasets.filter(d=>d._partner).map(d=>d._partner))].sort();return makeLegend('snap-trade-p',ps.map((p,i)=>({label:p,color:MAP_PALETTE[i%MAP_PALETTE.length]})));})()}
                  </div>
                :<div style={{fontSize:'0.55rem',color:t.lblMuted}}>{[...cmpScenarios].filter(s=>s!==cmpRef&&resultsData[s]).length>0?'No differences found.':'Select at least one scenario to compare.'}</div>}
              </div>
            )}
          </div>
        )}

        {/* ════ EVOLUTION ════ */}
        {hasData&&activeTab==='evolution'&&(
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
              <select value={evIndicator} onChange={e=>setEvIndicator(e.target.value)} style={selectStyle}>{INDICATORS.map(ind=><option key={ind.key} value={ind.key}>{ind.label}</option>)}</select>
              <select value={evCountry} onChange={e=>setEvCountry(e.target.value)} style={selectStyle}><option value="all">All countries</option>{activeInd.source==='yearlyZone'&&allCountries.length>1&&<option value={EACH_COUNTRY}>Each country</option>}{allCountries.map(c=><option key={c} value={c}>{c}</option>)}</select>
              <div style={{width:1,height:14,backgroundColor:t.panelBorder}}/>
              <ScenarioPicker t={t} all={scenarioList} selected={evScenarios} onChange={setEvScenarios}/>
            </div>
            {evolutionData?
              <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                {/* S1/S2 keys the bar labels; the per-country regime draws lines and names
                    the scenarios by dash pattern in its own legend instead. */}
                {!evEach&&<ScenarioKey t={t} scenarios={baseFirst(scenarioList.filter(s=>evScenarios.has(s)&&resultsData[s]))}/>}
                <div style={{flex:1,minWidth:0}}>
                  <CJChart name={ttl(activeInd.label,evEach?'By country':evCountry!=='all'?evCountry:'All countries',scenList(evScenarios))} type={activeInd.source==='yearlyZone'?'line':'bar'} height={220}
                    cacheKey={`ev|${evIndicator}|${[...evScenarios].sort().join(',')}|${evCountry}|${theme}|${[...hiddenMap['ev-tf']||[]].join(',')}|${[...hiddenMap['ev-cost']||[]].join(',')}|${[...hiddenMap['ev-country']||[]].join(',')}`}
                    data={{...evolutionData,datasets:evolutionData.datasets.filter(d=>{
                      if(evEach) return !isHidden('ev-country',d._country||'');
                      if(activeInd.source==='techFuel') return !isHidden('ev-tf',tfLabel(d));
                      if(activeInd.source==='costs') return !isHidden('ev-cost',tfLabel(d));
                      if(activeInd.source==='trade') return d.type==='line'||!isHidden('ev-trade-p',d._partner||'');
                      return true;
                    })}}
                    plugins={(()=>{const aSc=baseFirst(scenarioList.filter(s=>evScenarios.has(s)&&resultsData[s]));const sp=makeScenPlugin(aSc,t.muted);return[sp,evStacked&&barTotalPlugin({axis:'y',color:t.muted})].filter(Boolean);})()}
                    options={{...cjDefaults(t),datasets:{bar:{barPercentage:0.72}},scales:{x:{stacked:activeInd.source!=='yearlyZone',grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},maxTicksLimit:10,padding:16}},y:{stacked:activeInd.source!=='yearlyZone',grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:activeInd.unit,color:t.muted,font:{size:8}}}},plugins:{...cjDefaults(t).plugins,legend:activeInd.source==='yearlyZone'&&!evEach&&evScenarios.size>1?{display:true,labels:{color:t.muted,font:{size:9},boxWidth:8,boxHeight:6}}:{display:false},tooltip:{...cjDefaults(t).plugins.tooltip,footerColor:t.lbl,footerFont:{size:10},callbacks:{label:ctx=>`${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`,footer:evStacked?barTotalFooter({axis:'y',unit:activeInd.unit,filtered:anyHidden(activeInd.source==='costs'?'ev-cost':'ev-tf')}):undefined}}}}}
                  />
                </div>
                {evEach&&(()=>{const aSc=baseFirst(scenarioList.filter(s=>evScenarios.has(s)&&resultsData[s]));return <div style={{flexShrink:0,display:'flex',flexDirection:'column',gap:6}}>{makeLegend('ev-country',evGroups.map((g,i)=>({label:g.name,color:evGroupColor(i)})))}{aSc.length>1&&makeLegend('__ev_dash__',aSc.map((sc,i)=>({label:sc,color:t.muted,shape:'line',dash:SCEN_DASH[i%SCEN_DASH.length]})),false)}</div>;})()}
                {!evEach&&activeInd.source==='techFuel'&&makeLegend('ev-tf',[...new Set(evolutionData.datasets.map(tfLabel))].map(seriesLegendItem))}
                {activeInd.source==='costs'&&makeLegend('ev-cost',MAIN_COST_CATS.filter(cat=>evolutionData.datasets.some(d=>tfLabel(d)===(COST_LABELS[cat]||cat))).map(cat=>({label:COST_LABELS[cat]||cat,color:costColor(cat)})))}
                {activeInd.source==='trade'&&(()=>{const ps=[...new Set(evolutionData.datasets.filter(d=>d._partner).map(d=>d._partner))].sort();const aSc=baseFirst(scenarioList.filter(s=>evScenarios.has(s)&&resultsData[s]));return <div style={{flexShrink:0,display:'flex',flexDirection:'column',gap:6}}>{makeLegend('ev-trade-p',ps.map((p,i)=>({label:p,color:MAP_PALETTE[i%MAP_PALETTE.length]})))}{aSc.length>1&&makeLegend('__ev_scen__',aSc.map((s,i)=>({label:s,color:SCEN_COLORS[i%SCEN_COLORS.length],shape:'line'})),false)}</div>;})()}
              </div>
            :<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>Select at least one scenario.</div>}
            {/* ── Compare scenarios (Δ vs ref, stacked by techfuel) ── */}
            {scenarioList.length>1&&(
              <div style={{borderTop:`1px solid ${hexA(t.panelBorder,0.4)}`,paddingTop:10,marginTop:6,display:'flex',flexDirection:'column',gap:8}}>
                <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
                  <span style={{fontSize:'0.47rem',letterSpacing:'2px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase'}}>Δ vs ref:</span>
                  <select value={cmpRef||''} onChange={e=>pickCmpRef(e.target.value)} style={selectStyle}>
                    {scenarioList.map(s=><option key={s} value={s}>{s}</option>)}
                  </select>
                  <ScenarioPicker t={t} label="Compare" all={scenarioList} exclude={[cmpRef]} selected={cmpScenarios} onChange={setCmpScenarios}/>
                </div>
                {(()=>{const hasSc=[...cmpScenarios].filter(s=>s!==cmpRef&&resultsData[s]).length>0;
                return cmpEvData&&cmpEvData.datasets.length>0?
                  <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                    <div style={{flex:1,minWidth:0}}>
                      <CJChart name={ttl(`Δ ${activeInd.label} vs ${cmpRef}`,evEach?'By country':evCountry!=='all'?evCountry:'All countries',scenList(cmpScenarios))} type="bar" height={190}
                        cacheKey={`cmp-ev|${evIndicator}|${cmpRef}|${[...cmpScenarios].sort().join(',')}|${evCountry}|${theme}|${[...hiddenMap['ev-tf']||[]].join(',')}|${[...hiddenMap['ev-cost']||[]].join(',')}|${[...hiddenMap['ev-country']||[]].join(',')}`}
                        data={{...cmpEvData,datasets:cmpEvData.datasets.filter(d=>{
                          if(evEach) return !isHidden('ev-country',d._country||'');
                          if(activeInd.source==='techFuel') return !isHidden('ev-tf',tfLabel(d));
                          if(activeInd.source==='costs') return !isHidden('ev-cost',tfLabel(d));
                          if(activeInd.source==='trade') return d.type==='line'||!isHidden('ev-trade-p',d._partner||'');
                          return true;
                        })}}
                        plugins={activeInd.source==='techFuel'||(evEach&&evAdditive)?[barTotalPlugin({axis:'y',color:t.muted,delta:true})]:[]}
                        options={{...cjDefaults(t),scales:{
                          x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},maxTicksLimit:10}},
                          y:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:activeInd.unit,color:t.muted,font:{size:8}}},
                        },plugins:{...cjDefaults(t).plugins,legend:activeInd.source==='yearlyZone'&&!evEach?{display:true,labels:{color:t.muted,font:{size:9},boxWidth:8,boxHeight:6}}:{display:false},tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false,footerColor:t.lbl,footerFont:{size:10},callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw>0?'+':''}${ctx.raw?.toLocaleString?.()??ctx.raw}`,footer:evEach&&!evAdditive?undefined:barTotalFooter({axis:'y',delta:true,unit:activeInd.unit,filtered:anyHidden(evEach?'ev-country':activeInd.source==='techFuel'?'ev-tf':activeInd.source==='costs'?'ev-cost':activeInd.source==='trade'?'ev-trade-p':'')})}}}}}
                      />
                      {(activeInd.source!=='yearlyZone'||evEach)&&[...cmpScenarios].filter(s=>resultsData[s]&&s!==cmpRef).length>0&&(
                        <div style={{fontSize:'0.42rem',color:t.lblMuted,marginTop:3}}>Δ vs <b style={{color:t.muted}}>{cmpRef}</b>: {baseFirst([...cmpScenarios].filter(s=>resultsData[s]&&s!==cmpRef)).join(' · ')}</div>
                      )}
                    </div>
                    {evEach&&makeLegend('ev-country',evGroups.map((g,i)=>({label:g.name,color:evGroupColor(i)})))}
                    {!evEach&&activeInd.source==='techFuel'&&makeLegend('ev-tf',[...new Set(cmpEvData.datasets.map(tfLabel))].map(seriesLegendItem))}
                    {activeInd.source==='costs'&&makeLegend('ev-cost',[...new Set(cmpEvData.datasets.map(tfLabel))].map(tf=>({label:tf,color:costColor(tf)})))}
                    {activeInd.source==='trade'&&(()=>{const ps=[...new Set(cmpEvData.datasets.filter(d=>d._partner).map(d=>d._partner))].sort();const compareScsL=baseFirst([...cmpScenarios].filter(s=>resultsData[s]&&s!==cmpRef));return <div style={{flexShrink:0,display:'flex',flexDirection:'column',gap:6}}>{makeLegend('ev-trade-p',ps.map((p,i)=>({label:p,color:MAP_PALETTE[i%MAP_PALETTE.length]})))}{compareScsL.length>1&&makeLegend('__cmp_scen__',compareScsL.map((s,i)=>({label:s,color:SCEN_COLORS[(i+1)%SCEN_COLORS.length],shape:'line'})),false)}</div>;})()}
                  </div>
                :<div style={{fontSize:'0.55rem',color:t.lblMuted}}>{hasSc?'No differences found for this indicator between selected scenarios.':'Select at least one scenario to compare.'}</div>;})()}
              </div>
            )}
            <DlRow files={scenarioList.map(s=>[s,'pTechFuelMerged.csv']).slice(0,1).concat(scenarioList.map(s=>[s,'pYearlyZoneMerged.csv']).slice(0,1))}/>
          </div>
        )}

        {/* ════ DISPATCH ════ */}
        {hasData&&activeTab==='dispatch'&&(
          <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
            <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
              <select value={activeDispZone||''} onChange={e=>setDispZone(e.target.value)} style={selectStyle}>
                <option value="__all__">All zones (aggregated)</option>
                {allZones.map(z=><option key={z} value={z}>{z}</option>)}
              </select>
              <select value={dispScenario||''} onChange={e=>setDispScenario(e.target.value)} style={selectStyle}>{scenarioList.map(s=><option key={s} value={s}>{s}</option>)}</select>
              <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>{allYears.map(y=><option key={y} value={y}>{y}</option>)}</select>
            </div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:3, alignItems:'center' }}>
              <Pill active={dispMode==='full'} onClick={()=>setDispMode('full')}>Full Year</Pill>
              {dispAvailS.map(s=><Pill key={s} active={dispMode==='season'&&dispSeason===s} onClick={()=>{setDispMode('season');setDispSeason(s);}}>{s}</Pill>)}
              {dispMode==='season'&&dispAvailD.length>0&&<><div style={{width:1,height:14,backgroundColor:t.panelBorder}}/><select value={dispDay} onChange={e=>setDispDay(e.target.value)} style={selectStyle}><option value="all">All days</option><option value="avg">Avg</option>{dispAvailD.map(d=><option key={d} value={d}>{d}</option>)}</select></>}
            </div>
            {dispResult.chartData.datasets.length>0?
              <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                <div style={{flex:1,minWidth:0}}>
                  <CJChart name={ttl('Hourly generation (MW)',activeDispZone==='__all__'?'All zones':activeDispZone,dispScenario,refYear,dispMode==='full'?'Full year':ttl(dispSeason,dispDay!=='all'?`day ${dispDay}`:null))} type="bar" height={dispResult.grouped?255:195}
                    data={{...dispResult.chartData,datasets:dispResult.chartData.datasets.filter(d=>!isHidden('disp-tf',d.label))}}
                    plugins={dispResult.plugin?[dispResult.plugin]:[]}
                    cacheKey={`disp|${dispScenario}|${activeDispZone}|${refYear}|${dispMode}|${dispSeason}|${dispDay}|${theme}|${[...hiddenMap['disp-tf']||[]].join(',')}`}
                    options={{...cjDefaults(t),layout:{padding:{top:dispResult.grouped?18:4,bottom:dispResult.grouped?70:4}},scales:{x:{stacked:true,grid:{color:hexA(t.panelBorder,0.35),drawTicks:false},ticks:{display:!dispResult.grouped,color:t.muted,font:{size:8},maxTicksLimit:12,...(dispResult.xTicks||{})}},y:{stacked:true,grid:{color:hexA(t.panelBorder,0.35)},ticks:{color:t.muted,font:{size:9}},title:{display:true,text:'MW',color:t.muted,font:{size:8}}},yR:{type:'linear',position:'right',display:dispResult.chartData.datasets.some(d=>d.label==='Marginal cost'&&!isHidden('disp-tf','Marginal cost')),grid:{drawOnChartArea:false},ticks:{color:t.muted,font:{size:9}},title:{display:true,text:'USD/MWh',color:t.muted,font:{size:8}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false}}}}
                  />
                </div>
                {makeLegend('disp-tf',[
                  ...dispTechfuels.map(legendItem),
                  {label:'Demand',color:'#8B0000',shape:'line'},
                  {label:'Marginal cost',color:t.isDark?'rgba(255,255,255,0.88)':'#1E3A8A',shape:'line'},
                ])}
              </div>
            :<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>{loadingDisp?'Loading dispatch…':'No dispatch data.'}</div>}
            {/* ── Dispatch Δ section ── */}
            {scenarioList.length>1&&(
              <div style={{borderTop:`1px solid ${hexA(t.panelBorder,0.4)}`,paddingTop:10,marginTop:6,display:'flex',flexDirection:'column',gap:8}}>
                <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
                  <span style={{fontSize:'0.47rem',letterSpacing:'2px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase'}}>Δ vs ref:</span>
                  <select value={cmpRef||''} onChange={e=>pickCmpRef(e.target.value)} style={selectStyle}>
                    {scenarioList.map(s=><option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                {cmpRef&&cmpRef!==dispScenario&&dispDeltaResult.chartData.datasets.length>0?<>
                  <SectionTitle t={t}>Δ {dispScenario} − {cmpRef} (MW)</SectionTitle>
                  <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                    <div style={{flex:1,minWidth:0}}>
                      <CJChart name={ttl('Δ hourly generation (MW)',`${dispScenario} vs ${cmpRef}`,activeDispZone==='__all__'?'All zones':activeDispZone,refYear,dispMode==='full'?'Full year':ttl(dispSeason,dispDay!=='all'?`day ${dispDay}`:null))} type="bar" height={dispDeltaResult.grouped?215:155}
                        data={{...dispDeltaResult.chartData,datasets:dispDeltaResult.chartData.datasets.filter(d=>!isHidden('disp-tf',d.label))}}
                        plugins={dispDeltaResult.plugin?[dispDeltaResult.plugin]:[]}
                        cacheKey={`disp-d|${dispScenario}|${cmpRef}|${activeDispZone}|${refYear}|${dispMode}|${dispSeason}|${dispDay}|${theme}|${[...hiddenMap['disp-tf']||[]].join(',')}`}
                        options={{...cjDefaults(t),layout:{padding:{top:dispDeltaResult.grouped?18:4,bottom:dispDeltaResult.grouped?70:4}},
                          scales:{
                            x:{stacked:true,grid:{color:hexA(t.panelBorder,0.35),drawTicks:false},ticks:{display:!dispDeltaResult.grouped,color:t.muted,font:{size:8},maxTicksLimit:12,...(dispDeltaResult.xTicks||{})}},
                            y:{stacked:true,grid:{color:hexA(t.panelBorder,0.35)},ticks:{color:t.muted,font:{size:9}},title:{display:true,text:'ΔMW',color:t.muted,font:{size:8}}},
                            yR:{type:'linear',position:'right',display:dispDeltaResult.chartData.datasets.some(d=>d.label==='Marginal cost'&&!isHidden('disp-tf','Marginal cost')),grid:{drawOnChartArea:false},ticks:{color:t.muted,font:{size:9}},title:{display:true,text:'Δ$/MWh',color:t.muted,font:{size:8}}},
                          },
                          plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false,...deltaTooltip}}}}
                      />
                    </div>
                    {makeLegend('disp-tf',[...dispTechfuels.map(legendItem),{label:'Demand',color:'#8B0000',shape:'line'},{label:'Marginal cost',color:t.isDark?'rgba(255,255,255,0.88)':'#1E3A8A',shape:'line'}])}
                  </div>
                </>:cmpRef&&cmpRef===dispScenario?
                  <div style={{fontSize:'0.55rem',color:t.lblMuted}}>Select a different reference scenario.</div>:
                  <div style={{fontSize:'0.55rem',color:t.lblMuted}}>No differences found.</div>}
              </div>
            )}
            <DlRow files={[[dispScenario,'pDispatchComplete.csv'],[dispScenario,'pHourlyPrice.csv']]}/>
          </div>
        )}

        {/* ════ TRADE ════ */}
        {hasData&&activeTab==='trade'&&(
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
              <ScenarioPicker t={t} all={scenarioList} selected={trScenarios} onChange={setTrScenarios}/>
            </div>

            {/* Evolution stacked by corridor — right legend */}
            {tradeEvData&&(()=>{
              const allCorridors=tradeEvData.corridors||[];
              const unit=tradeEvData.unit||'GWh';
              return <>
                <div style={{ display:'flex', gap:4, alignItems:'center', flexWrap:'wrap', marginTop:4 }}>
                  <SectionTitle t={t}>Trade evolution by corridor</SectionTitle>
                  <div style={{display:'flex',gap:3,marginLeft:'auto'}}>
                    <Pill active={trEvMetric==='volume'}      onClick={()=>setTrEvMetric('volume')}>GWh</Pill>
                    <Pill active={trEvMetric==='capacity'}    onClick={()=>setTrEvMetric('capacity')}>MW</Pill>
                    <Pill active={trEvMetric==='utilization'} onClick={()=>setTrEvMetric('utilization')}>Util %</Pill>
                  </div>
                </div>
                <div style={{ display:'flex', gap:8 }}>
                  <div style={{ flex:1 }}>
                    <CJChart name={ttl(`Trade by corridor (${tradeEvData.unit||'GWh'})`,scenList(trScenarios))} type="bar" height={200}
                      cacheKey={`trev|${[...trScenarios].sort().join(',')}|${trEvMetric}|${theme}|${[...hiddenMap['trade-ev']||[]].join(',')}`}
                      data={{ labels:tradeEvData.labels, datasets:tradeEvData.datasets.filter(d=>!isHidden('trade-ev',tfLabel(d))) }}
                      options={{...cjDefaults(t),scales:{
                        x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},maxTicksLimit:10}},
                        y:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:unit,color:t.muted,font:{size:8}}},
                      },plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>`${ctx.dataset.label}: ${fmt(ctx.parsed.y)} ${unit}`}}}}}
                    />
                  </div>
                  {/* Right legend — clickable */}
                  <div style={{ width:80,flexShrink:0,display:'flex',flexDirection:'column',gap:2,paddingTop:4,maxHeight:200,overflowY:'auto' }}>
                    {allCorridors.slice(0,12).map((c,i)=>{
                      const label=`${c.z}↔${c.z2}`;
                      return <div key={label} onClick={()=>toggleHidden('trade-ev',label)} style={{ display:'flex',alignItems:'center',gap:3,cursor:'pointer',opacity:isHidden('trade-ev',label)?0.25:1 }}>
                        <div style={{ width:9,height:9,borderRadius:2,backgroundColor:hexA(MAP_PALETTE[i%MAP_PALETTE.length],0.82),flexShrink:0 }}/>
                        <span style={{ fontSize:'0.4rem',color:t.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{label}</span>
                      </div>;
                    })}
                    <div style={{ fontSize:'0.38rem',color:t.lblMuted,marginTop:4,display:'flex',gap:6 }}>
                      <span style={{cursor:'pointer',textDecoration:'underline'}} onClick={()=>setHiddenMap(prev=>({...prev,'trade-ev':new Set(allCorridors.slice(0,12).map(c=>`${c.z}↔${c.z2}`))}))}>None</span>
                      <span style={{cursor:'pointer',textDecoration:'underline'}} onClick={()=>setHiddenMap(prev=>({...prev,'trade-ev':new Set()}))}>All</span>
                    </div>
                  </div>
                </div>
              </>;
            })()}
            {/* Δ corridor section */}
            {scenarioList.length>1&&(
              <div style={{borderTop:`1px solid ${hexA(t.panelBorder,0.4)}`,paddingTop:10,marginTop:2,display:'flex',flexDirection:'column',gap:8}}>
                <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
                  <span style={{fontSize:'0.47rem',letterSpacing:'2px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase'}}>Δ vs ref:</span>
                  <select value={cmpRef||''} onChange={e=>pickCmpRef(e.target.value)} style={selectStyle}>
                    {scenarioList.map(s=><option key={s} value={s}>{s}</option>)}
                  </select>
                  <ScenarioPicker t={t} label="Compare" all={scenarioList} exclude={[cmpRef]} selected={cmpScenarios} onChange={setCmpScenarios}/>
                </div>
                {tradeCmpDeltaData&&tradeCmpDeltaData.datasets.length>0?
                  <CJChart name={ttl(`Δ trade by corridor (${tradeEvData.unit||'GWh'}) vs ${cmpRef}`,scenList(cmpScenarios))} type="bar" height={200}
                    cacheKey={`trev-d|${[...trScenarios].sort().join(',')}|${cmpRef}|${[...cmpScenarios].sort().join(',')}|${trEvMetric}|${theme}|${[...hiddenMap['trade-ev']||[]].join(',')}`}
                    data={{labels:tradeCmpDeltaData.labels,datasets:tradeCmpDeltaData.datasets}}
                    options={{...cjDefaults(t),scales:{
                      x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},maxTicksLimit:10}},
                      y:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:`Δ${tradeCmpDeltaData.unit||'GWh'}`,color:t.muted,font:{size:8}}},
                    },plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false,callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw>0?'+':''}${ctx.raw?.toLocaleString?.()}`}}}}}
                  />
                :<div style={{fontSize:'0.55rem',color:t.lblMuted}}>{[...cmpScenarios].filter(s=>s!==cmpRef&&resultsData[s]).length>0?'No corridor differences found.':'Select at least one scenario to compare.'}</div>}
              </div>
            )}
            {/* External trade ($m) with non-modelled neighbours */}
            {extTradeData&&(
              <div style={{borderTop:`1px solid ${hexA(t.panelBorder,0.4)}`,paddingTop:10,marginTop:2,display:'flex',flexDirection:'column',gap:6}}>
                <SectionTitle t={t}>External trade with neighbours — {extTradeData.scen}</SectionTitle>
                <div style={{fontSize:'0.42rem',color:t.lblMuted,marginTop:-2}}>Aggregate value of exchanges with external (non-modelled) zones. EPM reports totals, not per-neighbour flows.</div>
                <CJChart name={ttl('External trade with neighbours',extTradeData.scen,`${allYears[0]}–${allYears[allYears.length-1]}`)} type="bar" height={190}
                  cacheKey={`exttr|${extTradeData.scen}|${theme}`}
                  data={{labels:allYears,datasets:[
                    {label:'Import costs: $m',data:extTradeData.imp,backgroundColor:hexA('#E05252',0.8),borderWidth:0,order:3},
                    {label:'Export revenues: $m',data:extTradeData.exp,backgroundColor:hexA('#3FA45B',0.8),borderWidth:0,order:3},
                    {label:'Net (rev − cost): $m',data:extTradeData.net,type:'line',borderColor:'#1E88E5',borderWidth:1.6,pointRadius:0,tension:0.3,fill:false,order:1},
                    {label:'Trade shared benefits: $m',data:extTradeData.shb,type:'line',borderColor:'#C8A8F0',borderWidth:1.4,borderDash:[4,3],pointRadius:0,tension:0.3,fill:false,order:2},
                  ]}}
                  options={{...cjDefaults(t),scales:{
                    x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},maxTicksLimit:10}},
                    y:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},callback:v=>v>=1000||v<=-1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:'$m',color:t.muted,font:{size:8}}},
                  },plugins:{...cjDefaults(t).plugins,legend:{display:true,labels:{color:t.muted,font:{size:9},boxWidth:8,boxHeight:6}},tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false,callbacks:{label:ctx=>`${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`}}}}}
                />
              </div>
            )}
            <DlRow files={[[baseFirst([...trScenarios].filter(s=>resultsData[s]))[0]||scenarioList[0],'pTransmissionMerged.csv']]}/>
          </div>
        )}

        {/* ════ PLANTS ════ */}
        {hasData&&activeTab==='plants'&&(
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
              <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>{allYears.map(y=><option key={y} value={y}>{y}</option>)}</select>
              <select value={plScenario||''} onChange={e=>setPlScenario(e.target.value)} style={selectStyle}>{scenarioList.map(s=><option key={s} value={s}>{s}</option>)}</select>
              <select value={plIndicator} onChange={e=>setPlIndicator(e.target.value)} style={selectStyle}>
                {['CapacityPlant','EnergyPlant','CostsPlant','PlantAnnualLCOE','UtilizationPlant'].map(k=><option key={k} value={k}>{k.replace('Plant','').replace(/([A-Z])/g,' $1').trim()}</option>)}
              </select>
              <select value={plTopN} onChange={e=>setPlTopN(+e.target.value)} style={selectStyle}>{[10,20,30,50].map(n=><option key={n} value={n}>Top {n}</option>)}</select>
              <select value={plZone} onChange={e=>setPlZone(e.target.value)} style={selectStyle}><option value="all">All zones</option>{allZones.map(z=><option key={z} value={z}>{z}</option>)}</select>
            </div>
            {/* Ranking */}
            {plantsData.length>0?<>
              <SectionTitle t={t}>Top {plTopN} — {plIndicator.replace('Plant','').replace(/([A-Z])/g,' $1').trim()} ({plUnit})</SectionTitle>
              <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                <div style={{flex:1,minWidth:0}}>
                  {(()=>{const pd=plantsData.filter(p=>!isHidden('plants-tf',p.techfuel));return(
                    <CJChart name={ttl(`Top ${plTopN} plants`,plIndicator.replace('Plant','').replace(/([A-Z])/g,' $1').trim(),plScenario,refYear,plZone!=='all'?plZone:null)} type="bar" height={Math.min(pd.length*18+24,260)} cacheKey={`pl|${plScenario}|${refYear}|${plIndicator}|${plTopN}|${theme}|${[...hiddenMap['plants-tf']||[]].join(',')}`}
                      data={{labels:pd.map(p=>p.g),datasets:[{label:plScenario,data:pd.map(p=>+p.value.toFixed(2)),backgroundColor:pd.map(p=>hexA(techColor(p.techfuel),0.85)),borderWidth:0,barThickness:12}]}}
                      options={{...cjDefaults(t),indexAxis:'y',scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:plUnit,color:t.muted,font:{size:8}}},y:{grid:{display:false},ticks:{color:t.muted,font:{size:8}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>{const e=pd[ctx.dataIndex],head=`${plantFmt(ctx.parsed.x)} ${plUnit}`;return e&&e.parts.length>1?[head,...e.parts.map(q=>`  ${q.cat}: ${plantFmt(q.value)}`)]:head;}}}}}}
                    />
                  );})()}
                </div>
                {makeLegend('plants-tf',[...new Set(plantsData.map(p=>p.techfuel))].map(tf=>({label:tf,color:techColor(tf)})))}
              </div>
            </>:<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>No plant data for this run/scenario.</div>}
            {/* LCOE bubble — always below */}
            {lcoeData&&lcoeData.datasets.length>0&&<>
              <SectionTitle t={t}>Annual LCOE vs Utilization — bubble size = capacity</SectionTitle>
              <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                <div style={{flex:1,minWidth:0}}>
                  <CJChart name={ttl('Annual LCOE vs utilization',plScenario,refYear,plZone!=='all'?plZone:null)} type="bubble" height={250} cacheKey={`lcoe|${plScenario}|${refYear}|${theme}|${[...hiddenMap['lcoe-tf']||[]].join(',')}`}
                    data={{...lcoeData,datasets:lcoeData.datasets.filter(ds=>!isHidden('lcoe-tf',ds.label))}}
                    options={{...cjDefaults(t),plugins:{...cjDefaults(t).plugins,
                      tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>{const d=ctx.raw;return[`${d._plant||ctx.dataset.label}`,`LCOE: ${d.y} $/MWh  ·  Util: ${d.x.toFixed(0)}%`,d._cap?`Cap: ${fmt(d._cap)} MW`:''].filter(Boolean);}}}},
                      scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9}},title:{display:true,text:'Utilization (%)',color:t.muted,font:{size:9}},min:0,suggestedMax:105},y:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9}},title:{display:true,text:'LCOE (USD/MWh)',color:t.muted,font:{size:9}},min:0}}}}
                  />
                </div>
                {makeLegend('lcoe-tf',lcoeData.datasets.map(ds=>({label:ds.label,color:ds.backgroundColor,shape:'circle'})))}
              </div>
            </>}
            <DlRow files={[[plScenario,'pPlantMerged.csv'],[plScenario,'pCostsMerged.csv']]}/>
          </div>
        )}
        {hasData&&activeTab==='summary'&&summaryData&&(()=>{
          const{allSc,ref,nonRef,data,lastY}=summaryData;
          const hasGen=allSc.some(s=>allZones.some(z=>Object.keys(resultsData[s]?.techFuel[z]?.GenerationTechFuel?.[lastY]||{}).length>0));

          // ── The NPV of the objective, and where a scenario's difference comes from.
          // utils/npv does the arithmetic; everything here is the shape of it. Costs are
          // discounted on the model's own year factors, so this is the number the study's
          // deck prints — not the undiscounted sum the physical table below carries.
          // Every scenario with a discounted cost block compares. A gap to the model's own
          // NPV (a run that published no capex column, typically) is drawn as its own
          // Unexplained component, so the totals stay the model's, and npvCheckNotes names
          // it under the tables.
          const npvOk  = s=>!!npvData.byScen[s];
          const nRef   = npvOk(ref)?npvData.byScen[ref]:null;
          const hasNpv = !!nRef;
          const nCols  = hasNpv?baseFirst(allSc.filter(s=>s!==ref&&summaryScen.has(s)&&npvOk(s))):[];
          const byCty  = npvSplit==='country';
          const cties  = npvData.countries;
          const dScen  = Object.fromEntries(nCols.map(s=>[s,npvDelta(nRef.comps,npvData.byScen[s].comps)]));
          const dCty   = Object.fromEntries(nCols.map(s=>[s,Object.fromEntries(cties.map(c=>[c,npvDelta(nRef.byCountry[c],npvData.byScen[s].byCountry[c])]))]));
          const netOf  = s=>nRef.total-npvData.byScen[s].total;
          // Two lists: the levels table shows what the scenarios cost, the chart and the Δ
          // table show what moved, and a component can be large in one and flat in the other.
          const compsL = hasNpv?visibleComps([nRef.comps,...nCols.map(s=>npvData.byScen[s].comps)]):[];
          const comps  = hasNpv&&nCols.length?visibleComps(byCty?nCols.flatMap(s=>cties.map(c=>dCty[s][c])):nCols.map(s=>dScen[s])):[];
          const bn     = v=>v==null||!Number.isFinite(v)?'—':`${v>0?'+':v<0?'-':''}${(Math.abs(v)/1000).toFixed(2)}`;
          const npvChart = !comps.length?null:byCty?{
            labels:cties,
            datasets:nCols.flatMap((s,si)=>comps.map(c=>({
              label:nCols.length>1?`${s} — ${c.label}`:c.label,
              data:cties.map(ct=>+((dCty[s][ct][c.key]||0)/1000).toFixed(3)),
              backgroundColor:hexA(c.color,nCols.length>1?0.62:0.85),borderColor:c.color,borderWidth:nCols.length>1?1:0,
              stack:s,_si:si,
            })).filter(d=>d.data.some(v=>v!==0))),
            net:nCols.map((s,si)=>({si,data:cties.map(ct=>+(Object.values(dCty[s][ct]).reduce((a,b)=>a+b,0)/1000).toFixed(3)),color:t.lbl})),
          }:{
            labels:nCols,
            datasets:comps.map(c=>({label:c.label,data:nCols.map(s=>+((dScen[s][c.key]||0)/1000).toFixed(3)),backgroundColor:hexA(c.color,0.85),borderWidth:0,stack:'d',_si:0})),
            net:[{si:0,data:nCols.map(s=>+(netOf(s)/1000).toFixed(3)),color:t.lbl}],
          };
          const npvNotes = [
            hasNpv&&nCols.length
              ? `Every component is a discounted cost, so a difference is ${ref} minus the scenario: positive means the scenario spends less on that line, which is a benefit.`
              : null,
            ...(hasNpv?npvCheckNotes(npvData.byScen,[ref,...nCols]):[]),
            hasNpv&&[ref,...nCols].some(s=>!npvData.byScen[s].hasCapex)
              ? 'Generation capex is missing for at least one scenario shown, so its bar and total are incomplete.' : null,
            hasNpv&&[ref,...nCols].every(s=>!npvData.byScen[s].hasExternal)
              ? 'Capex of the external interconnectors is outside the model objective. Publish npv_external.csv (scenario,zone,value) beside summary.csv to have it counted.' : null,
          ].filter(Boolean);

          const ROWS=[
            {sec:`DEMAND  ·  ${allYears[0]}–${lastY}`},
            {k:'demCumul',l:'Cumulative demand',u:'TWh',d:1},
            {k:'demLast',l:`Last year (${lastY})`,u:'TWh/yr',d:1},
            {k:'peak',l:`Peak demand (${lastY})`,u:'GW',d:1},
            {sec:`CAPACITY  ·  ${lastY}`},
            {k:'cT',l:'Total installed',u:'GW',d:1},
            {k:'cR',l:'Renewables',u:'GW',d:1,ind:true},
            {k:'cRsh',l:'RE capacity share',u:'%',d:1,pct:true,ind:true,gP:true},
            ...(hasGen?[{k:'gRsh',l:'RE generation share',u:'%',d:1,pct:true,ind:true,gP:true}]:[]),
            {k:'resMargin',l:'Reserve margin over peak',u:'%',d:0,pct:true,ind:true},
            {sec:`TRADE  ·  ${allYears[0]}–${lastY}`},
            {k:'niCumul',l:'Net import (cumul.)',u:'TWh',d:1,sgn:true},
            {k:'niLast',l:`Net import (${lastY})`,u:'TWh/yr',d:1,sgn:true},
            {sec:`EMISSIONS  ·  ${allYears[0]}–${lastY}`},
            {k:'co2Cumul',l:'CO₂ (cumulative)',u:'Mt',d:0,raw:true,gP:false},
            {k:'co2Last',l:`CO₂ (${lastY})`,u:'Mt/yr',d:1,ind:true,gP:false},
            {k:'co2Int',l:`Intensity (${lastY})`,u:'kg/MWh',d:0,ind:true,gP:false},
            {sec:`RELIABILITY  ·  ${allYears[0]}–${lastY}`},
            {k:'unmet',l:'Unserved energy',u:'GWh',d:0,raw:true,gP:false},
            {k:'surplus',l:'Surplus generation',u:'GWh',d:0,raw:true,gP:false},
            {sec:'AVERAGE COST OF SUPPLY  ·  undiscounted'},
            {k:'costPerMWh',l:'Cost per MWh served',u:'$/MWh',d:1,gP:false},
            // Costs belong to the NPV tables above whenever the run carries the discounted
            // block. Without one, this undiscounted sum is all the page can say about cost.
            ...(hasNpv?[]:[
              {sec:'SYSTEM COST  ·  cumulative, undiscounted  (M$)'},
              {k:'costTotal',l:'Total',u:'M$',d:0,gP:false},
              ...MAIN_COST_CATS.map(cat=>({k:cat,l:COST_LABELS[cat]||cat,u:'M$',d:0,gP:false,ind:true})),
            ]),
          ];
          const fmtS=(v,r,force)=>{
            if(v==null||isNaN(v))return'—';
            const s=force||r.sgn;const a=Math.abs(v);
            const p=s?(v>=0?'+':'-'):(v<0?'-':'');
            // `raw` keeps the digits that matter: 2,398 vs 2,449 Mt says something, "2.4k" twice does not.
            const str=r.pct?`${a.toFixed(r.d)}%`
              :r.raw?a.toLocaleString(undefined,{minimumFractionDigits:r.d,maximumFractionDigits:r.d})
              :a>=10000?`${Math.round(a/1000).toLocaleString()}k`:a>=1000?`${(a/1000).toFixed(1)}k`:a.toFixed(r.d);
            return p+str;
          };
          const dBg=(dv,gP)=>{if(dv==null||gP==null||dv===0)return'transparent';const good=gP===true?dv>0:dv<0;return good?'rgba(52,199,89,0.15)':'rgba(255,59,48,0.13)';};
          const cs={fontSize:'0.52rem',textAlign:'right',padding:'3px 10px',borderBottom:`1px solid ${t.panelBorder}`,whiteSpace:'nowrap'};
          const hs={fontSize:'0.46rem',color:t.lblMuted,textAlign:'right',padding:'4px 10px',borderBottom:`1px solid ${t.panelBorder}`,fontWeight:600,whiteSpace:'nowrap'};
          const ls={fontSize:'0.52rem',color:t.muted,textAlign:'left',padding:'3px 10px',borderBottom:`1px solid ${t.panelBorder}`,whiteSpace:'nowrap'};
          const ss={fontSize:'0.44rem',color:t.lblMuted,letterSpacing:'1px',textTransform:'uppercase',textAlign:'left',padding:'6px 10px 3px',borderBottom:`1px solid ${t.panelBorder}`,backgroundColor:t.isDark?'rgba(255,255,255,0.04)':'rgba(0,0,0,0.03)',fontWeight:700};
          const mkTbl=(cols,delta)=>(
            <table style={{borderCollapse:'collapse',width:'100%'}}>
              <thead><tr>
                <th style={{...hs,textAlign:'left',minWidth:130}}/>
                {cols.map(s=><th key={s} style={hs}>{delta?`Δ ${s} vs ${ref}`:s}</th>)}
                <th style={{...hs,width:34}}/>
              </tr></thead>
              <tbody>{ROWS.map((r,i)=>r.sec
                ?<tr key={i}><td colSpan={cols.length+2} style={ss}>{r.sec}</td></tr>
                :<tr key={i}>
                  <td style={{...ls,paddingLeft:r.ind?20:8}}>{r.l}</td>
                  {cols.map(scen=>{
                    const v=delta?(data[scen]?.[r.k]!=null&&data[ref]?.[r.k]!=null?data[scen][r.k]-data[ref][r.k]:null):data[scen]?.[r.k];
                    return<td key={scen} style={{...cs,color:t.lbl,backgroundColor:delta?dBg(v,r.gP):'transparent'}}>{fmtS(v,r,delta)}</td>;
                  })}
                  <td style={{...cs,color:t.lblMuted,fontSize:'0.44rem'}}>{r.u}</td>
                </tr>
              )}</tbody>
            </table>
          );
          // Levels ($m NPV) or differences against the reference, same shape either way.
          const npvVal=(scen,key,delta)=>delta
            ?(key==='__total'?netOf(scen):(dScen[scen]?.[key]||0))
            :(key==='__total'?npvData.byScen[scen].total:(npvData.byScen[scen].comps[key]||0));
          const mkNpvTbl=(cols,delta)=>(
            <table style={{borderCollapse:'collapse',width:'100%'}}>
              <thead><tr>
                <th style={{...hs,textAlign:'left',minWidth:130}}/>
                {cols.map(s=><th key={s} style={hs}>{delta?`${ref} − ${s}`:s}</th>)}
                <th style={{...hs,width:34}}>M$</th>
              </tr></thead>
              <tbody>
                {(delta?comps:compsL).map(c=><tr key={c.key}>
                  <td style={{...ls,paddingLeft:8}}>
                    <span style={{display:'inline-block',width:7,height:7,borderRadius:2,backgroundColor:c.color,marginRight:5}}/>{c.label}
                  </td>
                  {cols.map(s=>{const v=npvVal(s,c.key,delta);
                    return<td key={s} style={{...cs,color:t.lbl,backgroundColor:delta?dBg(v,true):'transparent'}}>{fmt(v,0)}</td>;})}
                  <td/>
                </tr>)}
                <tr>
                  <td style={{...ls,fontWeight:700,color:t.lbl}}>{delta?'Net benefit (avoided cost)':'Total system cost NPV'}</td>
                  {cols.map(s=>{const v=npvVal(s,'__total',delta);
                    return<td key={s} style={{...cs,fontWeight:700,color:t.lbl,backgroundColor:delta?dBg(v,true):'transparent'}}>{fmt(v,0)}</td>;})}
                  <td/>
                </tr>
                {!delta&&<tr>
                  <td style={{...ls,fontSize:'0.44rem',color:t.lblMuted}}>Model NPV (check)</td>
                  {cols.map(s=><td key={s} style={{...cs,fontSize:'0.44rem',color:npvData.byScen[s].reconciled?t.lblMuted:'#FF3B30'}}>{fmt(npvData.byScen[s].modelTotal,0)}</td>)}
                  <td/>
                </tr>}
              </tbody>
            </table>
          );
          return(
            <div style={{display:'flex',flexDirection:'column',gap:14}}>
              <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                <span style={{fontSize:'0.45rem',letterSpacing:'1.5px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase'}}>Reference:</span>
                <select value={ref} onChange={e=>setSummaryRef(e.target.value)} style={selectStyle}>{allSc.map(s=><option key={s} value={s}>{s}</option>)}</select>
                {hasNpv&&<>
                  <ScenarioPicker t={t} label="Compare" all={allSc} exclude={[ref]} selected={summaryScen} onChange={setSummaryScen}/>
                  <div style={{width:1,height:14,backgroundColor:t.panelBorder}}/>
                  <Pill active={!byCty} onClick={()=>setNpvSplit('scenario')}>By scenario</Pill>
                  <Pill active={byCty}  onClick={()=>setNpvSplit('country')}>By country</Pill>
                </>}
                <span style={{fontSize:'0.4rem',color:t.lblMuted,marginLeft:8}}>Period: {allYears[0]}–{lastY} · {allYears.length} yrs · {allZones.length} zones</span>
              </div>

              {hasNpv?<>
                {/* The headline: what the scenario saves against its counterfactual. */}
                {nCols.length>0&&<div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                  {nCols.map(s=>{
                    const n=npvData.byScen[s],d=netOf(s),good=d>0;
                    const col=good?'#34C759':'#FF3B30';
                    return<div key={s} style={{flex:'1 1 132px',minWidth:132,padding:'7px 9px',borderRadius:4,border:`1px solid ${t.panelBorder}`,backgroundColor:hexA(col,0.06)}}>
                      <div style={{fontSize:'0.44rem',letterSpacing:'1px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{s}</div>
                      <div style={{fontSize:'0.78rem',fontWeight:700,color:col,lineHeight:1.25}}>{bn(d)}
                        <span style={{fontSize:'0.42rem',fontWeight:400,color:t.muted,marginLeft:3}}>bn$ benefit</span></div>
                      <div style={{fontSize:'0.4rem',color:t.lblMuted}}>cost NPV {fmt(nRef.total,0)} − {fmt(n.total,0)}</div>
                      {(!n.hasCapex||!n.reconciled)&&<div style={{fontSize:'0.4rem',color:'#FF9500',marginTop:2}}>⚠ {!n.hasCapex?'capex missing':'part unexplained'}</div>}
                    </div>;
                  })}
                </div>}

                <div>
                  <SectionTitle t={t}>{`Benefit vs ${ref}  ·  avoided cost NPV = ${ref} − scenario  ·  bn$`}</SectionTitle>
                  {npvChart&&npvChart.datasets.length?
                    <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                      {byCty&&nCols.length>1&&<ScenarioKey t={t} scenarios={nCols}/>}
                      <div style={{flex:1,minWidth:0}}>
                        <CJChart name={ttl(`Benefit vs ${ref} (bn$)`,byCty?'by country':'by scenario',scenList(nCols))} type="bar" height={240}
                          cacheKey={`npv|${ref}|${npvSplit}|${theme}|${nCols.join(',')}|${[...hiddenMap['npv-comp']||[]].join(',')}`}
                          plugins={[buildNetDotPlugin(npvChart.net),byCty?makeScenPlugin(nCols,t.muted):null].filter(Boolean)}
                          data={{labels:npvChart.labels,datasets:npvChart.datasets.filter(d=>!isHidden('npv-comp',tfLabel(d)))}}
                          options={{...cjDefaults(t),datasets:{bar:{barPercentage:0.72}},scales:{
                            x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},maxRotation:30,padding:byCty&&nCols.length>1?16:2}},
                            y:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9}},title:{display:true,text:'bn$ (discounted)',color:t.muted,font:{size:8}}},
                          },plugins:{...cjDefaults(t).plugins,legend:{display:false},tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false,callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw>0?'+':''}${ctx.raw} bn$`}}}}}
                        />
                        <div style={{fontSize:'0.4rem',color:t.lblMuted,marginTop:3,display:'flex',alignItems:'center',gap:4}}>
                          <span style={{display:'inline-block',width:7,height:7,borderRadius:'50%',backgroundColor:t.lbl}}/>net benefit
                        </div>
                      </div>
                      {makeLegend('npv-comp',comps.map(c=>({label:c.label,color:c.color})))}
                    </div>
                  :<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>Pick at least one scenario to compare against {ref}.</div>}
                </div>

                {nCols.length>0&&<>
                  <SectionTitle t={t}>{`Benefit by component  ·  ${ref} − scenario  ·  positive = the scenario costs less`}</SectionTitle>
                  {mkNpvTbl(nCols,true)}
                </>}
                <SectionTitle t={t}>Net present cost by component  ·  levels, not benefits</SectionTitle>
                {mkNpvTbl([ref,...nCols],false)}
              </>:<div style={{fontSize:'0.5rem',color:t.lblMuted,lineHeight:1.6}}>
                {`${ref} carries no discounted cost block (DiscountedWeightedCostsCumulated in pCostsMerged.csv), so its NPV cannot be decomposed. The undiscounted totals below are all the page can say about cost.`}
              </div>}
              {npvNotes.length>0&&<div style={{fontSize:'0.42rem',color:t.lblMuted,lineHeight:1.6}}>
                {npvNotes.map((n,i)=><div key={i}>· {n}</div>)}
              </div>}

              <div style={{height:1,backgroundColor:t.panelBorder,margin:'4px 0'}}/>
              <SectionTitle t={t}>Physical indicators</SectionTitle>
              {mkTbl(allSc,false)}
              {nonRef.length>0&&<>
                <SectionTitle t={t}>{`Δ vs ${ref}  ·  scenario − ${ref}`}</SectionTitle>
                {mkTbl(nonRef,true)}
              </>}
              <DlRow files={[[ref,'pCostsMerged.csv'],[ref,'pNetPresentCostSystemMerged.csv']]}/>
            </div>
          );
        })()}

        {activeTab==='scenarios'&&(
          <ScenarioTab t={t} scnMeta={scnMeta} docs={docIndex} order={baseFirst(scenarioList)} benefitOf={benefitOf}/>
        )}

        {activeTab==='raw'&&(
          <RawOutputsTab t={t} regionName={region.name} branch={region.epm?.branch}
            outputDir={outputDir} simRun={simRun} scenarioList={scenarioList} />
        )}

      </div>
    </div>
  );
}
