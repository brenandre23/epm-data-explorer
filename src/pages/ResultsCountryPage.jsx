import { useEffect, useRef, useState, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import { track } from '../analytics';
import { useTheme } from '../App';
import { getT, mapStyle } from '../constants';
import {
  fetchEpmCSV, fetchZonesGeoJSON, fetchLinestringGeoJSON, fetchZonesExtGeoJSON, fetchZonesOffgridGeoJSON, fetchGitHubDir, fetchResultCSV, resolveOutputDir, fetchRunList, fetchInputScenarios, fetchDispatchYear, fetchRunRootCSV,
  processTechFuel, processYearlyZone, processDispatchResults, processHourlyPrice,
  processHours, processTimeSlices, processTransmissionResults, processPlants, processCosts, processExtNTC, processEnergyBalance,
  processTradePrice,
  resultYears,
} from '../utils/epmFetch';
import { techColor, hexA, cssFillFor, legendItem } from '../utils/chartColors';
import { extraSeries, extraDelta, extraDataset, extraKind, orderStack, seriesLegendItem } from '../utils/annualExtras';
import { buildDispatchSeries, buildDispatchDeltaSeries, deltaTooltip } from '../utils/dispatchSeries';
import {
  buildExtZoneData, addExtZoneLayers, bindExtZoneHandlers, updateExtZoneData, setExtZonesVisible,
  extNodeCoordMap, buildExtFlowFeatures, updateExtFlows, bindExtFlowHandlers, addExtPriceDots,
} from '../utils/extZones';
import { addOffgridLayers } from '../utils/offgridZones';
import { fetchCountries, fetchBoundaries, addCountriesSource, addBaseLayers, raiseBoundaries } from '../utils/basemap';
import { baseFirst, baseScenario, defaultScenarios } from '../utils/scenarioOrder';
import { physicalStats } from '../utils/summaryStats';
import { yzAgg } from '../utils/zoneAgg';
import { rankPlants, plantDisplay, plantFmt } from '../utils/plantRank';
import { netImportGWh } from '../utils/netImport';
import ScenarioPicker, { ScenarioKey } from '../components/ScenarioPicker';
import { source, markStyleReady, styleReady } from '../utils/mapSource';
import { zoneCentroidMap } from '../utils/centroids';
import { priceDotEl } from '../utils/priceDot';
import { fetchScenarioConfig, resolveFile, overridesFor } from '../utils/epmScenarios';
import { externalZoneSet } from '../utils/zoneClass';
import { usePromotedZones } from '../utils/usePromotedZones';
import {
  processNpvInput, processNpvSystem, buildNpv, aggregateNpv, npvDelta, visibleComps, npvCheckNotes,
  withSummaryCapex, withNetInternalTrade, NET_TRADE_LINE,
} from '../utils/npv';
import CJChart from '../components/CJChart';
import MapDownload from '../components/MapDownload';
import PanelZoomControl, { usePanelZoom, unzoom } from '../components/PanelZoom';
import { ttl, scenList } from '../utils/chartTitle';
import { barTotalPlugin, barTotalFooter } from '../utils/barTotals';
import { useZoneLabels, useZoneLabelMarkers } from '../utils/zoneLabels';
import { dataPath } from '../utils/paths';

// ── Constants / helpers (shared with RegionPage) ──────────────────────────────

const MAP_PALETTE = ['#1B6CA8','#36B5B5','#E8C547','#4DA6FF','#4169E1','#85C1E9','#2E9EC8','#5EBCBA','#1A5276','#7EC8E3','#14A094','#4CAFE8','#EDD770','#AED6F1','#1F618D','#0A6B70'];
const SCEN_COLORS=['#3B82F6','#10B981','#F59E0B','#8B5CF6','#EF4444','#6B7280'];
function buildNetDotPlugin(netData){return{id:'netDot',afterDatasetsDraw(chart){if(!netData.length)return;const ctx=chart.ctx;const yScale=chart.scales.y;netData.forEach(({si,data,color})=>{const di=chart.data.datasets.findIndex(d=>d._si===si);if(di<0)return;const meta=chart.getDatasetMeta(di);data.forEach((val,i)=>{const bar=meta.data[i];if(!bar)return;const y=yScale.getPixelForValue(val);ctx.save();ctx.beginPath();ctx.arc(bar.x,y,3.5,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();ctx.restore();});});}};}
function getTradeValsC(resultsData,scen,zones,y){const tx=resultsData[scen]?.transmission||{};const res={};for(const z of zones){let imp=0,exp=0;for(const[z2,attrs]of Object.entries(tx[z]||{}))exp+=(attrs.Interchange?.[y]||0);for(const[z2,zm]of Object.entries(tx))if(z2!==z)imp+=(zm[z]?.Interchange?.[y]||0);res[z]={imp,exp,net:imp-exp};}return res;}
function getTradePartners(resultsData,scen,visZones,y){const tx=resultsData[scen]?.transmission||{};const visSet=new Set(visZones);const partners={};for(const z of visZones){for(const[z2,attrs]of Object.entries(tx[z]||{})){if(visSet.has(z2))continue;const v=attrs.Interchange?.[y]||0;if(!partners[z2])partners[z2]={imp:0,exp:0};partners[z2].exp+=v;}for(const[z2,zm]of Object.entries(tx)){if(visSet.has(z2))continue;const v=zm[z]?.Interchange?.[y]||0;if(v){if(!partners[z2])partners[z2]={imp:0,exp:0};partners[z2].imp+=v;}}}return partners;}
function getTradeByZonePartner(resultsData,scen,zones,y){const tx=resultsData[scen]?.transmission||{};const zSet=new Set(zones);const res={};for(const z of zones){res[z]={};for(const[z2,attrs]of Object.entries(tx[z]||{})){if(zSet.has(z2))continue;const v=attrs.Interchange?.[y]||0;if(v){res[z][z2]=res[z][z2]||{imp:0,exp:0};res[z][z2].exp+=v;}}for(const[z2,zm]of Object.entries(tx)){if(zSet.has(z2))continue;const v=zm[z]?.Interchange?.[y]||0;if(v){res[z][z2]=res[z][z2]||{imp:0,exp:0};res[z][z2].imp+=v;}}}return res;}
function fmt(n,d=0){if(n==null||isNaN(n))return'—';return n.toLocaleString('en-US',{maximumFractionDigits:d});}
function fmtBig(n){if(!n)return'—';const a=Math.abs(n);if(a>=1e3)return`${(n/1e3).toFixed(1)}k`;return n.toFixed(1);}
function cjDefaults(t){return{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{backgroundColor:t.panel,borderColor:t.panelBorder,borderWidth:1,titleColor:t.lbl,bodyColor:t.muted,titleFont:{size:11},bodyFont:{size:11},padding:6}},scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:11}}},y:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:11}}}}};}
function priceColor(t_){return`rgb(${Math.round(255-t_*(255-27))},${Math.round(255-t_*(255-108))},${Math.round(255-t_*(255-168))})`}
function priceBarColor(t_){return`rgb(${Math.round(46+t_*(232-46))},${Math.round(158+t_*(197-158))},${Math.round(200+t_*(71-200))})`}

const COST_COLORS={'Fuel costs: $m':'#E8C547','Fixed O&M: $m':'#4DA6FF','Variable O&M: $m':'#36B5B5','Investment costs: $m':'#8B5CF6','Carbon costs: $m':'#EF4444','VRE curtailment: $m':'#F59E0B','Transmission costs: $m':'#1B6CA8',
  'Import costs with external zones: $m':'#C0392B','Export revenues with external zones: $m':'#27AE60',
  'Spinning reserve costs: $m':'#8A97A8','Unmet country spinning reserve costs: $m':'#B0BAC6',
  [NET_TRADE_LINE]:'#B9C2CC'};
const COST_LABELS={'Fuel costs: $m':'Fuel','Fixed O&M: $m':'Fixed O&M','Variable O&M: $m':'Var O&M','Investment costs: $m':'CAPEX','Carbon costs: $m':'Carbon','VRE curtailment: $m':'Curtailment','Transmission costs: $m':'Transmission',
  'Import costs with external zones: $m':'External imports','Export revenues with external zones: $m':'External exports',
  'Spinning reserve costs: $m':'Spinning reserve','Unmet country spinning reserve costs: $m':'Unmet reserve',
  [NET_TRADE_LINE]:'Internal trade, net'};
// Every cost line the model writes, the three internal trade ones folded into the single
// net line withNetInternalTrade puts in the data. A region can drop them, since they
// cancel across it; a country cannot, and the net is what stays meaningful whether the
// selection is one zone or a whole country. The sum ties with 'Costs total'.
const MAIN_COST_CATS=['Fuel costs: $m','Fixed O&M: $m','Variable O&M: $m','Investment costs: $m',
  'Carbon costs: $m','VRE curtailment: $m','Transmission costs: $m',
  'Import costs with external zones: $m','Export revenues with external zones: $m',
  'Spinning reserve costs: $m','Unmet country spinning reserve costs: $m',
  NET_TRADE_LINE];
function costColor(cat){return COST_COLORS[cat]||'#888888';}
function makeScenPlugin(activeSc,color){if(!activeSc||activeSc.length<2)return null;return{id:'scenLabels',afterDraw(chart){const{ctx,chartArea:ca}=chart;if(!ca)return;ctx.save();ctx.font='8px "Open Sans", system-ui, sans-serif';ctx.textAlign='center';ctx.textBaseline='top';ctx.fillStyle=color||'rgba(128,128,128,0.7)';activeSc.forEach((scen,si)=>{const dsIdx=chart.data.datasets.findIndex(d=>d.stack===scen);if(dsIdx<0)return;const meta=chart.getDatasetMeta(dsIdx);const nX=chart.data.labels.length;for(let xi=0;xi<nX;xi++){const bar=meta.data[xi];if(!bar)continue;ctx.fillText(`S${si+1}`,bar.x,ca.bottom+12);}});ctx.restore();}};}

const INDICATORS=[
  {key:'CapacityTechFuel',label:'Capacity (MW)',source:'techFuel',unit:'MW'},
  {key:'EnergyTechFuelComplete',label:'Energy (GWh)',source:'techFuel',unit:'GWh'},
  {key:'NewCapacityTechFuel',label:'New Capacity (MW)',source:'techFuel',unit:'MW'},
  {key:'NewCapacityTechFuelCumulated',label:'Cum. New Cap (MW)',source:'techFuel',unit:'MW'},
  {key:'ReserveSpinningTechFuel',label:'Spinning Reserve (GWh)',source:'techFuel',unit:'GWh'},
  {key:'CostsBreakdown',label:'Costs breakdown (m USD)',source:'costs',unit:'m USD'},
  {key:'Costs',label:'Costs total (m USD)',source:'yearlyZone',unit:'m USD'},
  {key:'CapexInvestmentComponent',label:'CAPEX (m USD)',source:'yearlyZone',unit:'m USD'},
  {key:'GenCostsPerMWh',label:'Gen Cost (USD/MWh)',source:'yearlyZone',unit:'USD/MWh'},
  {key:'DemandEnergyZone',label:'Demand (GWh)',source:'yearlyZone',unit:'GWh'},
  // See ResultsRegionPage for why EmissionsIntensityZone is not exposed alongside this one.
  {key:'EmissionsZone',label:'Emissions (Mt CO2)',source:'yearlyZone',unit:'Mt CO2'},
  {key:'Trade',label:'Trade (GWh)',source:'trade',unit:'GWh'},
];

function SectionTitle({t,children,right}){return<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}><div style={{fontSize:'0.47rem',letterSpacing:'2px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase'}}>{children}</div>{right}</div>;}
function Pill({active,onClick,children}){return<button onClick={onClick} style={{fontSize:'0.44rem',fontFamily:'inherit',padding:'2px 7px',borderRadius:3,cursor:'pointer',border:`1px solid ${active?'rgba(74,143,204,0.65)':'rgba(128,160,192,0.2)'}`,backgroundColor:active?'rgba(74,143,204,0.12)':'transparent',color:active?'rgba(74,143,204,1)':'rgba(128,160,192,0.7)',fontWeight:active?600:400}}>{children}</button>;}

// ── Main component ────────────────────────────────────────────────────────────

export default function ResultsCountryPage() {
  const { regionId, countryName } = useParams();
  const countryDecoded = decodeURIComponent(countryName);
  const { theme } = useTheme(); const t = getT(theme); const navigate = useNavigate();

  const containerRef = useRef(null); const mapRef = useRef(null); const dotMarkersRef = useRef([]);
  const resultsDataRef = useRef({}); const refYearRef = useRef(null);
  const ovScenarioRef = useRef(null); const hoursDataRef = useRef({});

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
  const [evIndicator,  setEvIndicator]  = useState('CapacityTechFuel');
  const [evScenarios,  setEvScenarios]  = useState(new Set());
  const [dispScenario, setDispScenario] = useState(null);
  const [dispMode,     setDispMode]     = useState('full');
  const [dispSeason,   setDispSeason]   = useState('Q1');
  const [dispDay,      setDispDay]      = useState('all');
  const [trScenario,   setTrScenario]   = useState(null);
  const [trEvMetric,   setTrEvMetric]   = useState('volume');
  const [plScenario,   setPlScenario]   = useState(null);
  const [plIndicator,  setPlIndicator]  = useState('CapacityPlant');
  const [plTopN,       setPlTopN]       = useState(15);
  const [mapLoadedCount, setMapLoadedCount] = useState(0);
  const [hiddenMap,    setHiddenMap]    = useState({});
  const [panelWidth,   setPanelWidth]   = useState(640);
  const { zoom, inc, dec, reset } = usePanelZoom();
  const [snapIndicator,setSnapIndicator]= useState('CapacityTechFuel');
  const [snapScenarios,setSnapScenarios]= useState(new Set());
  const [cmpRef,       setCmpRef]       = useState(null);
  const [cmpScenarios, setCmpScenarios] = useState(new Set());
  const [trScenarios,  setTrScenarios]  = useState(new Set());
  const [plZone,       setPlZone]       = useState('all');
  const [selZone,      setSelZone]      = useState('all');
  const [summaryRef,   setSummaryRef]   = useState(null);
  const [summaryScen,  setSummaryScen]  = useState(new Set());
  const [npvSplit,     setNpvSplit]     = useState('scenario'); // 'scenario' | 'zone'
  const [summaryRows,  setSummaryRows]  = useState(null);   // run-root summary.csv
  const [extNpvRows,   setExtNpvRows]   = useState(null);   // run-root npv_external.csv

  // pCostsMerged lost its 'Investment costs: $m' line to a bug in output_treatment.py, so
  // for a run treated before the fix withSummaryCapex puts it back from summary.csv.
  // Everything below reads the repaired object; a run that never lost it is untouched.
  // withNetInternalTrade then folds the three internal trade lines into the single net one
  // MAIN_COST_CATS draws, so the call sites see it as an ordinary cost line.
  const resultsData = useMemo(
    () => withNetInternalTrade(withSummaryCapex(resultsDataPromoted, summaryRows)),
    [resultsDataPromoted, summaryRows]);
  const [pieDispMode,  setPieDispMode]  = useState('none');
  const pieMarkersRef = useRef([]);

  const isDrRef = useRef(false); const drStartX = useRef(0); const drStartW = useRef(0);
  const toggleHidden=(id,label)=>setHiddenMap(p=>{const s=new Set(p[id]||[]);s.has(label)?s.delete(label):s.add(label);return{...p,[id]:s};});
  const isHidden=(id,label)=>hiddenMap[id]?.has(label)||false;
  const anyHidden=id=>(hiddenMap[id]?.size||0)>0;

  useEffect(()=>{resultsDataRef.current=resultsData;},[resultsData]);
  useEffect(()=>{refYearRef.current=refYear;},[refYear]);
  useEffect(()=>{ovScenarioRef.current=ovScenario;},[ovScenario]);
  useEffect(()=>{hoursDataRef.current=hoursData;},[hoursData]);

  useEffect(()=>{track('results_view',{type:'country',region:regionId,country:countryDecoded});fetch(dataPath('regions.json')).then(r=>r.json()).then(d=>{const r=(d.regions||[]).find(r=>r.id===regionId);setRegion(r||null);});},[regionId,countryDecoded]);

  // The inputs a results map still needs: the zoning, the hour weights, and the two
  // things that describe the border — how much can cross it and what it costs there.
  // config.csv is asked where each of those lives, because the border prices are
  // scenario variants: the folder holds pTradePrice_eu_central.csv and five siblings,
  // and pTradePrice.csv, the name a guess would pick, is a stale leftover.
  // scenarios.csv is asked which of them the selected scenario swaps, because the
  // capacities are variants too: LC_BSSC is the only run where the Georgia-Romania
  // cable has any MW at all, and reading the base file drew it against a zero limit.
  useEffect(()=>{
    if(!region?.epm)return;
    const{branch,dataFolder,scenariosFile,configFile}=region.epm;
    let stale=false;
    (async()=>{
      const cfg=await fetchScenarioConfig(branch,dataFolder,{scenariosFile,configFile}).catch(()=>null);
      const rf=(p,fallback)=>resolveFile(cfg,overridesFor(cfg,ovScenario),p,fallback);
      const[zc,hr,zExt,extRaw,offGJ,tpIn,tpOut]=await Promise.all([
        fetchEpmCSV(branch,dataFolder,rf('zcmap','zcmap.csv')),
        fetchEpmCSV(branch,dataFolder,rf('pHours','pHours.csv')),
        fetchZonesExtGeoJSON(branch,dataFolder),
        fetchEpmCSV(branch,dataFolder,rf('pExtTransferLimit','trade/pExtTransferLimit.csv')),
        fetchZonesOffgridGeoJSON(branch,dataFolder),
        fetchEpmCSV(branch,dataFolder,rf('pTradePrice','trade/pTradePrice.csv')),
        fetchEpmCSV(branch,dataFolder,rf('pTradePriceExport','trade/pTradePriceExport.csv')),
      ]);
      if(stale)return;
      setZcmapRows(zc||[]);if(hr){setHoursData(processHours(hr));setSlices(processTimeSlices(hr));}
      setZonesExtGJ(zExt||null);setExtNtc(extRaw?processExtNTC(extRaw):[]);setOffgridGJ(offGJ||null);
      setTradePrice(tpIn?processTradePrice(tpIn):{});
      setTradePriceExp(tpOut?processTradePrice(tpOut):{});
    })();
    return()=>{stale=true;};
  },[region,ovScenario]);

  // The zone layers belong to the run, not to the branch: a run publishes the
  // zoning it solved. Wait for the run list to settle so the right one is asked
  // for; with no run resolved this reads the input folder, as it always did.
  useEffect(()=>{
    if(!region?.epm||!runsResolved)return;
    const{branch,dataFolder}=region.epm;
    const run=simRun?{outputDir,simRun}:null;
    Promise.all([fetchZonesGeoJSON(branch,dataFolder,null,run),fetchLinestringGeoJSON(branch,dataFolder,null,run)])
      .then(([zGJ,lGJ])=>{setZonesGJ(zGJ);setLinestringGJ(lGJ);});
  },[region,outputDir,simRun,runsResolved]);

  useEffect(()=>{if(!region?.epm)return;setLoadingRuns(true);setRunsResolved(false);const b=region.epm.branch;resolveOutputDir(b).then(dir=>{setOutputDir(dir);return fetchRunList(b,dir);}).then(names=>{setRunsUnreachable(names===null);const runs=(names||[]).slice().sort().reverse();setRunList(runs);if(runs.length)setSimRun(runs[0]);}).finally(()=>{setLoadingRuns(false);setRunsResolved(true);});},[region]);
  useEffect(()=>{if(!region?.epm||!simRun)return;const{branch}=region.epm;fetchGitHubDir(branch,`${outputDir}/${simRun}`).then(async items=>{let s=(items||[]).filter(i=>i.type==='dir').map(i=>i.name).sort();if(!s.length){const fromCsv=await fetchInputScenarios(branch,outputDir,simRun);s=(fromCsv||[]).sort();}setScenarioList(s);if(s.length){const base=baseScenario(s);setOvScenario(base);setDispScenario(base);setTrScenario(base);setPlScenario(base);setEvScenarios(defaultScenarios(s));setCmpRef(base);setCmpScenarios(defaultScenarios(s.filter(x=>x!==base)));setTrScenarios(defaultScenarios(s));setSnapScenarios(defaultScenarios(s));setSummaryRef(null);setSummaryScen(defaultScenarios(s.filter(x=>x!==base)));}});},[region,simRun,outputDir]);

  useEffect(()=>{
    if(!region?.epm||!simRun||!scenarioList.length)return;
    setLoadingData(true);const{branch}=region.epm;
    // A run change fires this once with the old scenario list: that batch is stale.
    let stale=false;
    // Dispatch (pDispatchComplete) is huge -> loaded lazily per year (see effect below)
    Promise.all(scenarioList.map(async scen=>{
      const[tf,yz,pr,tx,pl,co,eb,np]=await Promise.all([fetchResultCSV(branch,simRun,scen,'pTechFuelMerged.csv',outputDir),fetchResultCSV(branch,simRun,scen,'pYearlyZoneMerged.csv',outputDir),fetchResultCSV(branch,simRun,scen,'pHourlyPrice.csv',outputDir),fetchResultCSV(branch,simRun,scen,'pTransmissionMerged.csv',outputDir),fetchResultCSV(branch,simRun,scen,'pPlantMerged.csv',outputDir),fetchResultCSV(branch,simRun,scen,'pCostsMerged.csv',outputDir),fetchResultCSV(branch,simRun,scen,'pEnergyBalance.csv',outputDir),fetchResultCSV(branch,simRun,scen,'pNetPresentCostSystemMerged.csv',outputDir)]);
      return{scen,techFuel:tf?processTechFuel(tf):{},yearlyZone:yz?processYearlyZone(yz):{},dispatch:{},price:pr?processHourlyPrice(pr):{},transmission:tx?processTransmissionResults(tx):{},plants:pl?processPlants(pl):[],costs:co?processCosts(co):{},energyBalance:eb?processEnergyBalance(eb):{},npvRaw:co?processNpvInput(co):null,npvSystem:np?processNpvSystem(np):null};
    })).then(res=>{if(stale)return;const rd=Object.fromEntries(res.map(r=>[r.scen,r]));setResultsData(rd);dispLoadedRef.current=new Set();const yrs=resultYears(res[0]?.techFuel||{});if(yrs.length)setRefYear(yrs[0]);}).finally(()=>{if(!stale)setLoadingData(false);});
    return()=>{stale=true;};
  },[region,simRun,scenarioList]); // eslint-disable-line

  // The two files a run writes at its root rather than per scenario, both optional:
  // summary.csv, which holds the generation capex annuities the NPV cannot be assembled
  // without, and npv_external.csv, the costs a study prices outside the model.
  useEffect(()=>{
    if(!region?.epm||!simRun){setSummaryRows(null);setExtNpvRows(null);return;}
    const{branch}=region.epm;let stale=false;
    Promise.all([
      fetchRunRootCSV(branch,outputDir,simRun,'summary.csv'),
      fetchRunRootCSV(branch,outputDir,simRun,'npv_external.csv'),
    ]).then(([sm,ext])=>{if(stale)return;setSummaryRows(sm);setExtNpvRows(ext);});
    return()=>{stale=true;};
  },[region,simRun,outputDir]);

  // Lazy-load dispatch for the year/scenarios actually shown (big file, split per year).
  useEffect(()=>{
    if(activeTab!=='dispatch'||!region?.epm||!simRun||!refYear)return;
    const{branch}=region.epm;
    const wanted=[dispScenario,(cmpRef&&cmpRef!==dispScenario)?cmpRef:null].filter(s=>s&&resultsData[s]);
    wanted.forEach(async scen=>{
      const key=`${scen}|${refYear}`;
      if(dispLoadedRef.current.has(key))return;
      dispLoadedRef.current.add(key); setLoadingDisp(true);
      try{
        const rows=await fetchDispatchYear(branch,simRun,scen,refYear,outputDir);
        const parsed=rows?processDispatchResults(rows):{};
        const years=new Set(); for(const ym of Object.values(parsed))for(const y of Object.keys(ym))years.add(y);
        years.forEach(y=>dispLoadedRef.current.add(`${scen}|${y}`));
        setResultsData(prev=>{const sd=prev[scen];if(!sd)return prev;const dispatch={...sd.dispatch};for(const[z,ym]of Object.entries(parsed))dispatch[z]={...(dispatch[z]||{}),...ym};return{...prev,[scen]:{...sd,dispatch}};});
      }finally{setLoadingDisp(false);}
    });
  },[activeTab,dispScenario,cmpRef,refYear,simRun,region,outputDir,resultsData]); // eslint-disable-line

  // Derived
  const zoneToCountry = useMemo(()=>Object.fromEntries(zcmapRows.map(r=>[r.z,r.c])),[zcmapRows]);
  const countryZoneIds = useMemo(()=>zcmapRows.filter(r=>r.c===countryDecoded).map(r=>r.z),[zcmapRows,countryDecoded]);
  const countryIsos = useMemo(()=>zonesGJ?[...new Set(zonesGJ.features.filter(f=>countryZoneIds.includes(f.properties.z)).map(f=>f.properties.ISO_A3))]:[]  ,[zonesGJ,countryZoneIds]);
  const allZones = countryZoneIds;
  const visZones = selZone==='all'?allZones:allZones.filter(z=>z===selZone);
  const hasData = Object.keys(resultsData).length>0;
  const allYears = useMemo(()=>{const f=Object.values(resultsData)[0];return f?resultYears(f.techFuel):[];},[resultsData]);
  const activeInd = useMemo(()=>INDICATORS.find(i=>i.key===evIndicator)||INDICATORS[0],[evIndicator]);
  // ── NPV ────────────────────────────────────────────────────────────────────
  /** npv_external.csv -> { scenario: { zone: $m } }. Header: scenario,zone,value. */
  const extNpv = useMemo(()=>{
    if(!extNpvRows?.length)return null;
    const out={};
    for(const r of extNpvRows){
      const sc=(r.scenario||'').trim(),z=(r.zone||'').trim();const v=parseFloat(r.value);
      if(!sc||!z||!Number.isFinite(v))continue;
      (out[sc]||={})[z]=(out[sc][z]||0)+v;
    }
    return out;
  },[extNpvRows]);

  // Grouped by ZONE, not by country: this page already IS one country and splits it by
  // zone. Scenario totals and the residual cover the whole system whatever the grouping,
  // so the reconciliation check stays the model-wide one even though the tables below
  // show one country's slice of it.
  const npvSystemData = useMemo(()=>buildNpv({
    scenarios:scenarioList.filter(s=>resultsData[s]),
    resultsData,summaryRows,extNpv,zoneToCountry:z=>z,
  }),[scenarioList,resultsData,summaryRows,extNpv]);

  /** The country's slice, over the zones on screen. Internal trade is left unmerged here:
   *  the three lines cancel across a whole region, never inside one country. */
  const npvCountry = useMemo(()=>{
    const out={};
    for(const[sc,n]of Object.entries(npvSystemData.byScen)){
      const{comps,total}=aggregateNpv(n.byCountry,visZones);
      out[sc]={comps,total,byZone:n.byCountry,residual:n.residual,reconciled:n.reconciled,modelTotal:n.modelTotal,
               hasCapex:n.hasCapex,hasExternal:n.hasExternal};
    }
    return out;
  },[npvSystemData,visZones]);

  const allTechfuels = useMemo(()=>{const tfs=new Set();for(const d of Object.values(resultsData))for(const z of allZones)for(const a of Object.values(d.techFuel[z]||{}))for(const y of Object.values(a))for(const tf of Object.keys(y))tfs.add(tf);return[...tfs].filter(t=>t!=='Demand').sort();},[resultsData,allZones]);

  const firstDisp=resultsData[dispScenario]?.dispatch||Object.values(resultsData)[0]?.dispatch||{};
  const dispAvailS=useMemo(()=>{const qs=new Set();for(const z of allZones){for(const yr of Object.values(firstDisp[z]||{}))for(const q of Object.keys(yr))qs.add(q);}return[...qs].sort();},[firstDisp,allZones]);
  const dispAvailD=useMemo(()=>{const ds=new Set();for(const z of allZones)for(const yr of Object.values(firstDisp[z]||{}))for(const q of Object.values(yr))for(const d of Object.keys(q))ds.add(d);return[...ds].sort();},[firstDisp,allZones]);
  const totalDays=useMemo(()=>Object.values(hoursData).reduce((s,dts)=>s+Object.values(dts||{}).reduce((a,b)=>a+b,0),0)||365,[hoursData]);
  // One zone selection for the whole page: the selector at the top of the panel and a
  // click on the map write it, and Dispatch reads it like every other tab. 'all' means
  // the country, which for an hourly stack is its zones summed.
  const activeDispZone=selZone==='all'?'__all__':selZone;
    const getZoneDisp=(sd,zone,year)=>{if(zone!=='__all__')return sd.dispatch[zone]?.[year]||{};const agg={};for(const z of allZones)for(const[q,days]of Object.entries(sd.dispatch[z]?.[year]||{}))for(const[d,hours]of Object.entries(days))for(const[tt,tfs]of Object.entries(hours))for(const[tf,val]of Object.entries(tfs)){if(!agg[q])agg[q]={};if(!agg[q][d])agg[q][d]={};if(!agg[q][d][tt])agg[q][d][tt]={};agg[q][d][tt][tf]=(agg[q][d][tt][tf]||0)+val;}return agg;};

  const zoneAvgPrices=useMemo(()=>{
    const sd=resultsData[ovScenario]||Object.values(resultsData)[0];if(!sd||!refYear)return{};
    const res={};
    for(const z of allZones){const qmap=sd.price[z]?.[refYear]||{};let tw=0,tp=0;for(const[q,days]of Object.entries(qmap))for(const[d,hrs]of Object.entries(days)){const w=hoursData[q]?.[d]||0;for(const p of Object.values(hrs)){tp+=p*w;tw+=w;}}if(tw>0)res[z]=tp/tw;}
    return res;
  },[resultsData,ovScenario,refYear,allZones,hoursData]);
  const zonePriceRange=useMemo(()=>{
    const sd=resultsData[ovScenario]||Object.values(resultsData)[0];if(!sd||!refYear)return{};
    const res={};
    for(const z of allZones){const qmap=sd.price[z]?.[refYear]||{};let pmin=Infinity,pmax=-Infinity;for(const[,days]of Object.entries(qmap))for(const[,hrs]of Object.entries(days))for(const p of Object.values(hrs))if(p>0){if(p<pmin)pmin=p;if(p>pmax)pmax=p;}if(isFinite(pmin))res[z]={min:pmin,max:pmax};}
    return res;
  },[resultsData,ovScenario,refYear,allZones]);
  const priceVals=Object.values(zoneAvgPrices);
  const minP=priceVals.length?Math.min(...priceVals):0,maxP=priceVals.length?Math.max(...priceVals):100,rngP=maxP-minP||1;

  // ── Map ───────────────────────────────────────────────────────────────────────
  useEffect(()=>{
    if(!containerRef.current||!region||!zonesGJ)return;
    const regionCountries=[...new Set(zcmapRows.map(r=>r.c))].sort();
    const colorMap={};regionCountries.forEach((c,i)=>{colorMap[c]=MAP_PALETTE[i%MAP_PALETTE.length];});
    const zoneCentroids = zoneCentroidMap(zonesGJ, linestringGJ);
    const cCoords=countryZoneIds.flatMap(z=>zoneCentroids[z]?[zoneCentroids[z]]:[]);
    const lons=cCoords.map(c=>c[0]),lats=cCoords.map(c=>c[1]);
    const bounds=lons.length?[[Math.min(...lons)-1.5,Math.min(...lats)-1.5],[Math.max(...lons)+1.5,Math.max(...lats)+1.5]]:null;
    const map=new maplibregl.Map({container:containerRef.current,style:mapStyle(theme),center:[lons.length?lons.reduce((a,b)=>a+b,0)/lons.length:20,lats.length?lats.reduce((a,b)=>a+b,0)/lats.length:0],zoom:4,minZoom:1,maxZoom:14,canvasContextAttributes: { preserveDrawingBuffer: true }, attributionControl:false});
    mapRef.current=map;
    const popup=new maplibregl.Popup({closeButton:false,closeOnClick:false,offset:10,className:`popup-${theme}`});
    const ntcClickPopup=new maplibregl.Popup({closeButton:true,closeOnClick:true,offset:10,className:`popup-${theme}`});
    map.on('load',async()=>{
      const tv=getT(theme);
      if(bounds)map.fitBounds(bounds,{padding:60,duration:0,maxZoom:7});
      const countries=await fetchCountries('10m');
      const boundaries=await fetchBoundaries('10m');
      addCountriesSource(map,countries);
      addBaseLayers(map,tv,boundaries);
      const isoToC={};for(const f of zonesGJ.features)isoToC[f.properties.ISO_A3]=f.properties.c;
      const uIsos=[...new Set(zonesGJ.features.map(f=>f.properties.ISO_A3))];
      const fillExpr=['match',['get','ISO_A3'],...uIsos.flatMap(iso=>[iso,colorMap[isoToC[iso]]||'#888']),'transparent'];
      map.addSource('zones',{type:'geojson',data:zonesGJ,generateId:true});
      map.addLayer({id:'zone-fill-dim',type:'fill',source:'zones',filter:['!',['in',['get','ISO_A3'],['literal',countryIsos]]],paint:{'fill-color':fillExpr,'fill-opacity':0.08}});
      map.addLayer({id:'zone-fill',type:'fill',source:'zones',filter:['in',['get','ISO_A3'],['literal',countryIsos]],paint:{'fill-color':fillExpr,'fill-opacity':0.32}});
      map.addLayer({id:'zone-hover',type:'fill',source:'zones',filter:['==',['get','z'],''],paint:{'fill-color':fillExpr,'fill-opacity':0.60}});
      map.addLayer({id:'zone-selected',type:'fill',source:'zones',filter:['==',['get','z'],'__none__'],paint:{'fill-color':fillExpr,'fill-opacity':0.45}});
      map.addLayer({id:'zone-selected-border',type:'line',source:'zones',filter:['==',['get','z'],'__none__'],paint:{'line-color':'rgba(255,255,255,0.9)','line-width':2.5}});
      map.addLayer({id:'zone-border',type:'line',source:'zones',filter:['in',['get','ISO_A3'],['literal',countryIsos]],paint:{'line-color':fillExpr,'line-width':1.5,'line-opacity':0.9}});
      // NTC lines source (updated separately)
      const aW=14,aH=12;const aData=new Uint8Array(aW*aH*4).fill(0);
      for(let y=0;y<aH;y++){const h=aH/2;const xMax=Math.round(y<=h?(y/h)*aW*0.85:((aH-y)/h)*aW*0.85);for(let x=0;x<xMax;x++){const i=(y*aW+x)*4;aData[i]=255;aData[i+1]=255;aData[i+2]=255;aData[i+3]=255;}}
      if(!map.hasImage('ntc-arrow-c'))map.addImage('ntc-arrow-c',{width:aW,height:aH,data:aData},{sdf:true});
      map.addSource('ntc-results',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
      map.addLayer({id:'ntc-bg',type:'line',source:'ntc-results',paint:{'line-color':['interpolate',['linear'],['get','util'],0,'#FFD700',0.5,'#FF8C00',1,'#E53935'],'line-width':['interpolate',['linear'],['get','vol'],0,1,500,2.5,5000,5],'line-opacity':0.88}});
      map.addLayer({id:'ntc-arrows',type:'symbol',source:'ntc-results',layout:{'icon-image':'ntc-arrow-c','icon-allow-overlap':false,'symbol-placement':'line','symbol-spacing':55,'icon-rotation-alignment':'map','icon-size':0.9},paint:{'icon-color':['interpolate',['linear'],['get','util'],0,'#FFD700',0.5,'#FF8C00',1,'#E53935']}});
      map.on('mouseenter','ntc-bg',e=>{map.getCanvas().style.cursor='pointer';const p=e.features[0].properties;popup.setLngLat(e.lngLat).setHTML(`<b>${p.z} ↔ ${p.z2}</b><br><span style="opacity:.8;font-size:0.8em">Interchange ${p.yr}: ${fmtBig(parseFloat(p.fwd))} GWh / ${fmtBig(parseFloat(p.rev))} GWh<br>Utilization: ${p.util!=null?(parseFloat(p.util)*100).toFixed(0)+'%':'—'} · Capacity: ${fmtBig(parseFloat(p.cap)||0)} MW</span>`).addTo(map);});
      map.on('mouseleave','ntc-bg',()=>{map.getCanvas().style.cursor='';popup.remove();});
      map.on('click','ntc-bg',e=>{e.preventDefault();const p=e.features[0].properties;const fwd=parseFloat(p.fwd)||0,rev=parseFloat(p.rev)||0,net=fwd-rev;const util=p.util!=null?(parseFloat(p.util)*100).toFixed(0)+'%':'—';const cap=parseFloat(p.cap)||0;ntcClickPopup.setLngLat(e.lngLat).setHTML(`<b>${p.z} ↔ ${p.z2}</b> <span style="opacity:.5;font-size:0.8em">${p.yr}</span><br><span style="font-size:0.82em">${p.z} → ${p.z2}: <b>${fmtBig(fwd)}</b> GWh<br>${p.z2} → ${p.z}: <b>${fmtBig(rev)}</b> GWh<br>Net: <b>${net>=0?'+':''}${fmtBig(net)}</b> GWh<br><span style="opacity:.7">Util: ${util} &nbsp;·&nbsp; Cap: ${fmtBig(cap)} MW</span></span>`).addTo(map);});
      let hovZ=null;
      map.on('mousemove','zone-fill',e=>{
        map.getCanvas().style.cursor='pointer';const z=e.features[0].properties.z||'';
        if(z!==hovZ){hovZ=z;map.setFilter('zone-hover',['==',['get','z'],z]);}
        const rd=resultsDataRef.current;const yr=refYearRef.current;const sd=rd[ovScenarioRef.current]||Object.values(rd)[0];
        let statsHtml='';
        if(sd&&yr&&z){const cap=Object.values(sd.techFuel[z]?.CapacityTechFuel?.[yr]||{}).reduce((a,b)=>a+b,0)/1000;const dem=(sd.yearlyZone[z]?.DemandEnergyZone?.[yr]||0)/1000;const peak=(sd.yearlyZone[z]?.DemandPeakZone?.[yr]||0)/1000;const netImp=netImportGWh(sd.transmission,[z],yr)/1000;const hd=hoursDataRef.current;const zP=sd.price[z]?.[yr]||{};let tw=0,tp=0;for(const[q,days]of Object.entries(zP))for(const[d,hrs]of Object.entries(days)){const w=hd[q]?.[d]||0;for(const p of Object.values(hrs)){tp+=p*w;tw+=w;}}const avgP=tw>0?tp/tw:null;statsHtml=`<br><span style="opacity:.8;font-size:0.78em">Installed: ${cap.toFixed(1)} GW · Peak: ${peak.toFixed(1)} GW<br>Demand: ${dem.toFixed(0)} TWh · Net import: ${netImp>=0?'+':''}${netImp.toFixed(1)} TWh${avgP!=null?`<br>Price: ${avgP.toFixed(1)} $/MWh`:''}</span>`;}
        popup.setLngLat(e.lngLat).setHTML(`<b>${z}</b>${statsHtml}`).addTo(map);
      });
      map.on('mouseleave','zone-fill',()=>{map.getCanvas().style.cursor='';hovZ=null;map.setFilter('zone-hover',['==',['get','z'],'']),popup.remove();});
      map.on('click','zone-fill',e=>{const z=e.features[0].properties.z||'';if(countryZoneIds.includes(z)){setSelZone(prev=>prev===z?'all':z);}else{navigate(`/region/${regionId}/results/zone/${encodeURIComponent(z)}`);} });
      markStyleReady(map);
      setMapLoadedCount(c=>c+1);
      raiseBoundaries(map);
    });
    return()=>{popup.remove();dotMarkersRef.current.forEach(m=>m.remove());dotMarkersRef.current=[];pieMarkersRef.current.forEach(m=>m.remove());pieMarkersRef.current=[];mapRef.current?.remove();};
  },[region,theme,zonesGJ,zcmapRows,countryZoneIds,countryIsos]); // eslint-disable-line

  // External zone layers (added once map + ext data ready)
  useEffect(()=>{
    const map=mapRef.current;
    if(!styleReady(map)||!zonesGJ)return;
    if(!zonesExtGJ&&!extNtc.length)return;
    const zoneCentroids = zoneCentroidMap(zonesGJ, linestringGJ);
    const extData=buildExtZoneData(zonesExtGJ,extNtc,zoneCentroids,refYear);
    if(source(map, 'ext-zones')){updateExtZoneData(map,extData);return;}
    addExtZoneLayers(map,t,extData,{visible:showExtRef.current,mode:'results',arrowImage:'ntc-arrow-c'});
    const extPopup=new maplibregl.Popup({closeButton:false,closeOnClick:false,offset:10,className:`popup-${theme}`});
    bindExtZoneHandlers(map,extPopup);
    bindExtFlowHandlers(map,extPopup);
  },[mapLoadedCount,zonesGJ,linestringGJ,zonesExtGJ,extNtc,refYear,theme]); // eslint-disable-line

  // What crossed the external corridors, kept to the country's own zones the way the
  // ntc-results effect keeps the internal ones — same run, same year, so both halves
  // of a corridor map move together.
  useEffect(()=>{
    const map=mapRef.current;
    if(!map||!source(map, 'ext-flows'))return;
    const sd=resultsData[ovScenario]||Object.values(resultsData)[0];
    updateExtFlows(map,buildExtFlowFeatures({
      tx:sd?.transmission,extNtc,year:refYear,zones:new Set(countryZoneIds),
      zoneCentroids:zoneCentroidMap(zonesGJ,linestringGJ),
      extNodeCoords:extNodeCoordMap(zonesExtGJ),
    }));
  },[resultsData,ovScenario,refYear,zonesGJ,linestringGJ,zonesExtGJ,extNtc,countryZoneIds,mapLoadedCount]);
  useEffect(()=>{showExtRef.current=showExtZones;setExtZonesVisible(mapRef.current,showExtZones);},[showExtZones]);

  // Off-grid areas (no toggle): painted like the rest of the country so the map has
  // no hole. Independent of the ext layers above, which return early without them.
  useEffect(()=>{
    const map=mapRef.current;
    if(!styleReady(map)||!offgridGJ||source(map, 'offgrid-zones'))return;
    addOffgridLayers(map,t,offgridGJ);
  },[mapLoadedCount,offgridGJ,theme]); // eslint-disable-line

  // Update selected zone highlight
  useEffect(()=>{
    const map=mapRef.current;if(!map)return;
    const f=selZone==='all'?'__none__':selZone;
    try{map.setFilter('zone-selected',['==',['get','z'],f]);map.setFilter('zone-selected-border',['==',['get','z'],f]);}catch(e){}
  },[selZone,mapLoadedCount]);

  // Update NTC
  useEffect(()=>{
    const map=mapRef.current;if(!map||!source(map, 'ntc-results')||!refYear)return;
    const sd=resultsData[ovScenario]||Object.values(resultsData)[0];if(!sd)return;
    const tx=sd.transmission;const zoneCentroids = zoneCentroidMap(zonesGJ, linestringGJ);
    const seen=new Set();const features=[];
    for(const[z,z2map]of Object.entries(tx)){for(const[z2,attrs]of Object.entries(z2map)){const key=[z,z2].sort().join('||');if(seen.has(key))continue;seen.add(key);
      if(!countryZoneIds.includes(z)&&!countryZoneIds.includes(z2))continue;
      const fwd=attrs.Interchange?.[refYear]||0;const rev=tx[z2]?.[z]?.Interchange?.[refYear]||0;const util=Math.min(1,Math.max(0,attrs.InterconUtilization?.[refYear]||tx[z2]?.[z]?.InterconUtilization?.[refYear]||0));const cap=attrs.TransmissionCapacity?.[refYear]||0;const vol=Math.abs(fwd)+Math.abs(rev);if(vol===0&&cap===0)continue;
      const lf=linestringGJ?.features?.find(f=>(f.properties.z===z&&(f.properties.z_other||f.properties.z2)===z2)||(f.properties.z===z2&&(f.properties.z_other||f.properties.z2)===z));
      const lfFwd=!lf||lf.properties.z===z;
      let coords=lf?lf.geometry.coordinates:(zoneCentroids[z]&&zoneCentroids[z2]?[zoneCentroids[z],zoneCentroids[z2]]:null);if(!coords)continue;
      features.push({type:'Feature',properties:{z,z2,fwd,rev,util,vol,cap,yr:refYear},geometry:{type:'LineString',coordinates:(lfFwd===(fwd>=rev))?coords:[...coords].reverse()}});
    }}
    source(map, 'ntc-results').setData({type:'FeatureCollection',features});
  },[resultsData,refYear,ovScenario,zonesGJ,linestringGJ,countryZoneIds,mapLoadedCount]); // eslint-disable-line

  // Price dots
  useEffect(()=>{
    const map=mapRef.current;if(!map||!refYear||!zonesGJ)return;
    dotMarkersRef.current.forEach(m=>m.remove());dotMarkersRef.current=[];
    const sd=resultsData[ovScenario]||Object.values(resultsData)[0];if(!sd)return;
    const tv=getT(theme);const zoneCentroids = zoneCentroidMap(zonesGJ, linestringGJ);
    const prices={};for(const z of allZones){const qmap=sd.price[z]?.[refYear]||{};let tw=0,tp=0;for(const[q,days]of Object.entries(qmap))for(const[d,hrs]of Object.entries(days)){const w=hoursData[q]?.[d]||0;for(const p of Object.values(hrs)){tp+=p*w;tw+=w;}}if(tw>0)prices[z]=tp/tw;}
    const vals=Object.values(prices);if(!vals.length)return;
    const minV=Math.min(...vals),maxV=Math.max(...vals),rng=maxV-minV||1;
    for(const[z,price]of Object.entries(prices)){const coord=zoneCentroids[z];if(!coord)continue;const el=priceDotEl(priceColor((price-minV)/rng),`${z}: ${price.toFixed(1)} $/MWh`);dotMarkersRef.current.push(new maplibregl.Marker({element:el,anchor:'center'}).setLngLat(coord).addTo(map));}
    if(showExtZones)addExtPriceDots(map,dotMarkersRef.current,
      {zonesExtGJ,tradePrice,tradePriceExp,hoursData,year:refYear,min:minV,rng,colorFor:priceColor});
  },[resultsData,refYear,ovScenario,zonesGJ,allZones,hoursData,theme,mapLoadedCount,showExtZones,zonesExtGJ,tradePrice,tradePriceExp]); // eslint-disable-line

  // ── Zone mix pie markers ──────────────────────────────────────────────────
  useEffect(()=>{
    pieMarkersRef.current.forEach(m=>m.remove());pieMarkersRef.current=[];
    const map=mapRef.current;
    if(!map||pieDispMode==='none'||!zonesGJ||!refYear)return;
    const sd=resultsData[ovScenario]||Object.values(resultsData)[0];if(!sd)return;
    const attr=pieDispMode==='capacity'?'CapacityTechFuel':'EnergyTechFuelComplete';
    const unitDiv=1000;const unitLbl=pieDispMode==='capacity'?'GW':'TWh';
    const isDk=t.isDark;
    const zcC = zoneCentroidMap(zonesGJ, linestringGJ);
    const zPrices={};for(const z of allZones){const qmap=sd.price[z]?.[refYear]||{};let tw=0,tp=0;for(const[q,days]of Object.entries(qmap))for(const[d,hrs]of Object.entries(days)){const w=hoursData[q]?.[d]||0;for(const p of Object.values(hrs)){tp+=p*w;tw+=w;}}if(tw>0)zPrices[z]=tp/tw;}
    const pVals=Object.values(zPrices);const pMin=pVals.length?Math.min(...pVals):0;const pRng=pVals.length?Math.max(...pVals)-pMin||1:1;
    const SZ=44,dpr=window.devicePixelRatio||1,cx=SZ/2,cy=SZ/2,oR=SZ/2-1.5,iR=oR*0.50;
    for(const z of allZones){
      const coord=zcC[z];if(!coord)continue;
      const data=sd.techFuel[z]?.[attr]?.[refYear];if(!data)continue;
      const entries=Object.entries(data).filter(([,v])=>v>0);if(!entries.length)continue;
      const total=entries.reduce((s,[,v])=>s+v,0);if(total<=0)continue;
      const canvas=document.createElement('canvas');
      canvas.width=Math.round(SZ*dpr);canvas.height=Math.round(SZ*dpr);
      canvas.style.width=SZ+'px';canvas.style.height=SZ+'px';
      const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
      ctx.shadowColor='rgba(0,0,0,0.35)';ctx.shadowBlur=3;ctx.shadowOffsetY=1;
      let ang=-Math.PI/2;
      for(const[tf,val]of entries){const sw=(val/total)*2*Math.PI;ctx.beginPath();ctx.moveTo(cx+iR*Math.cos(ang),cy+iR*Math.sin(ang));ctx.arc(cx,cy,oR,ang,ang+sw);ctx.arc(cx,cy,iR,ang+sw,ang,true);ctx.closePath();ctx.fillStyle=techColor(tf);ctx.fill();ang+=sw;}
      ctx.shadowColor='transparent';
      const t_=zPrices[z]!=null?(zPrices[z]-pMin)/pRng:null;
      const centerBg=t_!=null?priceColor(t_).replace('rgb(','rgba(').replace(')',',0.92)'):(isDk?'rgba(15,20,30,0.88)':'rgba(245,248,252,0.92)');
      const lightBg=t_==null||t_<0.5;
      const textC=lightBg?'rgba(15,30,60,0.9)':'rgba(255,255,255,0.95)';
      const mutedC=lightBg?'rgba(60,80,120,0.65)':'rgba(255,255,255,0.55)';
      ctx.beginPath();ctx.arc(cx,cy,iR-0.5,0,2*Math.PI);ctx.fillStyle=centerBg;ctx.fill();
      const val=total/unitDiv;const valStr=val>=10?val.toFixed(0):val.toFixed(1);
      ctx.fillStyle=textC;ctx.font='bold 8px "Open Sans", system-ui, sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.fillText(valStr,cx,cy-2.5);ctx.fillStyle=mutedC;ctx.font='6px "Open Sans", system-ui, sans-serif';ctx.fillText(unitLbl,cx,cy+6);
      canvas.title=`${z}: ${(total/unitDiv).toFixed(1)} ${unitLbl}`;
      pieMarkersRef.current.push(new maplibregl.Marker({element:canvas,anchor:'center'}).setLngLat(coord).addTo(map));
    }
  },[pieDispMode,resultsData,ovScenario,refYear,zonesGJ,allZones,hoursData,mapLoadedCount,theme]); // eslint-disable-line

  // Zone names (opt-in), under the donut when one is drawn, else under the price dot.
  useZoneLabelMarkers(mapRef,{on:zoneLabels,zones:allZones,zonesGJ,linestringGJ,
    zonesExtGJ:showExtZones?zonesExtGJ:null,zoneOffset:pieDispMode==='none'?8:23,extOffset:8,tv:t,ready:mapLoadedCount});

  // External trade with neighbouring (external) zones — $m aggregates from pCosts.
  const extTradeData = useMemo(()=>{
    const scen=resultsData[trScenario]?trScenario:Object.keys(resultsData)[0];
    const co=resultsData[scen]?.costs;if(!co||!allYears.length)return null;
    const IMP='Import costs with external zones: $m',EXP='Export revenues with external zones: $m',SHB='Trade shared benefits: $m';
    const sum=(cat,y)=>allZones.reduce((s,z)=>s+(co[z]?.[cat]?.[y]||0),0);
    const imp=allYears.map(y=>+sum(IMP,y).toFixed(1));
    const exp=allYears.map(y=>+sum(EXP,y).toFixed(1));
    const shb=allYears.map(y=>+sum(SHB,y).toFixed(1));
    const net=allYears.map((_,i)=>+(exp[i]-imp[i]).toFixed(1));
    return (imp.some(v=>v)||exp.some(v=>v)||shb.some(v=>v))?{scen,imp,exp,shb,net}:null;
  },[resultsData,trScenario,allYears,allZones]);

  if(!region)return<div style={{padding:40,color:t.text}}>Loading…</div>;
  const pickCmpRef=v=>{setCmpRef(v);setCmpScenarios(defaultScenarios(scenarioList.filter(s=>s!==v)));};
  const selectStyle={fontSize:'0.5rem',fontFamily:'inherit',padding:'2px 6px',borderRadius:3,border:`1px solid ${t.panelBorder}`,backgroundColor:t.panel,color:t.muted,cursor:'pointer'};
  const TABS=['overview','snapshot','evolution','dispatch','trade','plants','summary'];

  // ── Helpers ───────────────────────────────────────────────────────────────────
  const findBase=scens=>scens.find(s=>/^base/i.test(s))||scens[0];

  // ── Builders ──────────────────────────────────────────────────────────────────
  // Zones this region wants read as neighbours rather than members — see
  // utils/zoneClass. Empty for every region that has not asked. Not memoised: it is
  // read inside extrasOf and never lands in a dependency array, so its identity does
  // not matter, and a useMemo down here would sit after the page's early returns.
  const extZones = externalZoneSet(region);

  /** Trade, unmet demand and line capacity for one scenario — see utils/annualExtras.
   *  at: x => { zones, year }, the rest of the context being the scenario's own data. */
  const extrasOf=(scen,indKey,xs,at)=>extraSeries({indKey,xs,allYears,extZones,
    at:x=>{const c=at(x);return{tx:resultsData[scen]?.transmission||{},eb:resultsData[scen]?.energyBalance||{},zones:c.zones,year:c.year};}});
  const pushExtras=(datasets,series,scen,multi)=>{for(const e of series)if(e.data.some(v=>v!==0))datasets.push(extraDataset(e,scen,multi));orderStack(datasets);};

  const buildSnapshot=()=>{
    const activeSc=baseFirst(scenarioList.filter(s=>snapScenarios.has(s)&&resultsData[s]));
    if(!activeSc.length||!refYear)return null;
    const ind=INDICATORS.find(i=>i.key===snapIndicator)||INDICATORS[0];
    const groups=visZones; const multi=activeSc.length>1;
    const getTf=(scen,z,tf)=>resultsData[scen]?.techFuel[z]?.[ind.key]?.[refYear]?.[tf]||0;
    const getTotal=(scen,z)=>{if(ind.source==='techFuel')return Object.values(resultsData[scen]?.techFuel[z]?.[ind.key]?.[refYear]||{}).reduce((a,b)=>a+b,0);if(ind.source==='yearlyZone')return yzAgg(resultsData[scen]?.yearlyZone,ind.key,[z],refYear);if(ind.source==='costs')return MAIN_COST_CATS.reduce((s,cat)=>s+(resultsData[scen]?.costs[z]?.[cat]?.[refYear]||0),0);return 0;};
    if(ind.source==='techFuel'){const tfs=allTechfuels.filter(tf=>activeSc.some(s=>groups.some(z=>getTf(s,z,tf)>0)));const datasets=[];for(const scen of activeSc)for(const tf of tfs){const data=groups.map(z=>Math.round(getTf(scen,z,tf)));if(data.some(v=>v>0))datasets.push({label:multi?`${scen} — ${tf}`:tf,data,backgroundColor:hexA(techColor(tf),multi?0.5:0.82),borderColor:techColor(tf),borderWidth:multi?1:0,stack:scen});}if(extraKind(ind.key))for(const scen of activeSc)pushExtras(datasets,extrasOf(scen,ind.key,groups,z=>({zones:[z],year:refYear})),scen,multi);return{labels:groups,datasets,ind};}
    if(ind.source==='trade'){const datasets=[];const netPluginData=[];const partnerSet=new Set();const zpCache={};for(const scen of activeSc){zpCache[scen]=getTradeByZonePartner(resultsData,scen,groups,refYear);for(const z of groups)Object.keys(zpCache[scen][z]||{}).forEach(p=>partnerSet.add(p));}const allPartners=[...partnerSet].sort();const pColor=Object.fromEntries(allPartners.map((p,i)=>[p,MAP_PALETTE[i%MAP_PALETTE.length]]));for(let i=0;i<activeSc.length;i++){const scen=activeSc[i];const col=SCEN_COLORS[i%SCEN_COLORS.length];for(const p of allPartners){const pc=pColor[p];const impData=groups.map(z=>+((zpCache[scen][z]?.[p]?.imp)||0).toFixed(0));const expData=groups.map(z=>+(-(zpCache[scen][z]?.[p]?.exp||0)).toFixed(0));if(impData.some(v=>v!==0))datasets.push({label:multi?`${scen} — ${p} Imp.`:`${p} Imp.`,type:'bar',data:impData,backgroundColor:hexA(pc,0.82),borderWidth:0,stack:scen,_partner:p});if(expData.some(v=>v!==0))datasets.push({label:multi?`${scen} — ${p} Exp.`:`${p} Exp.`,type:'bar',data:expData,backgroundColor:hexA(pc,0.42),borderWidth:0,stack:scen,_partner:p});}netPluginData.push({si:i,data:groups.map(z=>+Object.values(zpCache[scen][z]||{}).reduce((s,v)=>s+(v.imp-v.exp),0).toFixed(0)),color:col});}return{labels:groups,datasets,ind,netPlugin:buildNetDotPlugin(netPluginData)};}
    return{labels:groups,datasets:activeSc.map((scen,i)=>({label:scen,data:groups.map(z=>+getTotal(scen,z).toFixed(2)),backgroundColor:hexA(SCEN_COLORS[i%SCEN_COLORS.length],0.78),borderWidth:0,stack:scen})).filter(d=>d.data.some(v=>v>0)),ind};
  };
  const buildSnapshotDelta=()=>{
    if(!cmpRef||!refYear)return null;
    const compareScs=baseFirst(scenarioList.filter(s=>cmpScenarios.has(s)&&s!==cmpRef&&resultsData[s]));
    if(!compareScs.length)return null;
    const ind=INDICATORS.find(i=>i.key===snapIndicator)||INDICATORS[0];
    const groups=visZones; const multi=compareScs.length>1;
    const getTf=(scen,z,tf)=>resultsData[scen]?.techFuel[z]?.[ind.key]?.[refYear]?.[tf]||0;
    const getTotal=(scen,z)=>{if(ind.source==='techFuel')return Object.values(resultsData[scen]?.techFuel[z]?.[ind.key]?.[refYear]||{}).reduce((a,b)=>a+b,0);if(ind.source==='yearlyZone')return yzAgg(resultsData[scen]?.yearlyZone,ind.key,[z],refYear);if(ind.source==='costs')return MAIN_COST_CATS.reduce((s,cat)=>s+(resultsData[scen]?.costs[z]?.[cat]?.[refYear]||0),0);return 0;};
    if(ind.source==='techFuel'){const tfs=allTechfuels.filter(tf=>[...compareScs,cmpRef].some(s=>groups.some(z=>getTf(s,z,tf)>0)));const datasets=[];for(const scen of compareScs)for(const tf of tfs){const data=groups.map(z=>+(getTf(scen,z,tf)-getTf(cmpRef,z,tf)).toFixed(0));if(data.some(v=>v!==0))datasets.push({label:multi?`${scen} — ${tf}`:tf,data,backgroundColor:hexA(techColor(tf),multi?0.5:0.82),borderColor:techColor(tf),borderWidth:multi?1:0,stack:scen});}if(extraKind(ind.key))for(const scen of compareScs){const at=z=>({zones:[z],year:refYear});pushExtras(datasets,extraDelta(extrasOf(scen,ind.key,groups,at),extrasOf(cmpRef,ind.key,groups,at)),scen,multi);}return{labels:groups,datasets,ind};}
    if(ind.source==='trade'){const datasets=[];const netPluginData=[];const partnerSet=new Set();const zpS={},zpRef=getTradeByZonePartner(resultsData,cmpRef,groups,refYear);for(const scen of compareScs){zpS[scen]=getTradeByZonePartner(resultsData,scen,groups,refYear);for(const z of groups){Object.keys(zpS[scen][z]||{}).forEach(p=>partnerSet.add(p));Object.keys(zpRef[z]||{}).forEach(p=>partnerSet.add(p));}}const allPartners=[...partnerSet].sort();const pColor=Object.fromEntries(allPartners.map((p,i)=>[p,MAP_PALETTE[i%MAP_PALETTE.length]]));for(let i=0;i<compareScs.length;i++){const scen=compareScs[i];const col=SCEN_COLORS[(i+1)%SCEN_COLORS.length];for(const p of allPartners){const pc=pColor[p];const dImp=groups.map(z=>+((zpS[scen][z]?.[p]?.imp||0)-(zpRef[z]?.[p]?.imp||0)).toFixed(0));const dExp=groups.map(z=>+((zpRef[z]?.[p]?.exp||0)-(zpS[scen][z]?.[p]?.exp||0)).toFixed(0));if(dImp.some(v=>v!==0))datasets.push({label:multi?`Δ ${scen} ${p} Imp.`:`Δ ${p} Imp.`,type:'bar',data:dImp,backgroundColor:hexA(pc,0.82),borderWidth:0,stack:scen,_partner:p});if(dExp.some(v=>v!==0))datasets.push({label:multi?`Δ ${scen} ${p} Exp.`:`Δ ${p} Exp.`,type:'bar',data:dExp,backgroundColor:hexA(pc,0.42),borderWidth:0,stack:scen,_partner:p});}const dNet=groups.map(z=>+(Object.values(zpS[scen][z]||{}).reduce((s,v)=>s+(v.imp-v.exp),0)-Object.values(zpRef[z]||{}).reduce((s,v)=>s+(v.imp-v.exp),0)).toFixed(0));if(dNet.some(v=>v!==0))netPluginData.push({si:i,data:dNet,color:col});}return{labels:groups,datasets,ind,netPlugin:buildNetDotPlugin(netPluginData)};}
    const DCOLS=['#3887C4','#4A9E6A','#D4A820','#B83838'];
    return{labels:groups,datasets:compareScs.map((scen,i)=>({label:`Δ ${scen}`,data:groups.map(z=>+((getTotal(scen,z)-getTotal(cmpRef,z)).toFixed(2))),backgroundColor:hexA(DCOLS[i%4],0.72),borderColor:DCOLS[i%4],borderWidth:0,stack:scen})).filter(d=>d.data.some(v=>v!==0)),ind};
  };
  const buildCmpEvolution=()=>{
    if(!cmpRef||!refYear)return null;
    const compareScs=baseFirst(scenarioList.filter(s=>cmpScenarios.has(s)&&s!==cmpRef&&resultsData[s]));
    if(!compareScs.length)return null;
    const ind=activeInd; const multi=compareScs.length>1;
    if(ind.source==='techFuel'){const tfs=allTechfuels;const datasets=[];for(const scen of compareScs)for(const tf of tfs){const data=allYears.map(y=>Math.round(visZones.reduce((s,z)=>s+(resultsData[scen]?.techFuel[z]?.[ind.key]?.[y]?.[tf]||0),0)-(visZones.reduce((s,z)=>s+(resultsData[cmpRef]?.techFuel[z]?.[ind.key]?.[y]?.[tf]||0),0))));if(data.some(v=>v!==0))datasets.push({label:multi?`${scen} — ${tf}`:tf,data,backgroundColor:hexA(techColor(tf),multi?0.5:0.82),borderColor:techColor(tf),borderWidth:multi?1:0,stack:scen});}if(extraKind(ind.key))for(const scen of compareScs){const at=y=>({zones:visZones,year:y});pushExtras(datasets,extraDelta(extrasOf(scen,ind.key,allYears,at),extrasOf(cmpRef,ind.key,allYears,at)),scen,multi);}return{labels:allYears,datasets};}
    if(ind.source==='yearlyZone'){return{labels:allYears,datasets:compareScs.map((scen,i)=>({label:scen,data:allYears.map(y=>+(yzAgg(resultsData[scen]?.yearlyZone,ind.key,visZones,y)-yzAgg(resultsData[cmpRef]?.yearlyZone,ind.key,visZones,y)).toFixed(2)),backgroundColor:hexA(SCEN_COLORS[(i+1)%SCEN_COLORS.length],0.75),borderColor:SCEN_COLORS[(i+1)%SCEN_COLORS.length],borderWidth:1,fill:false,tension:0.3,type:'line'})).filter(d=>d.data.some(v=>v!==0))};}
    if(ind.source==='costs'){const datasets=[];for(const scen of compareScs)for(const cat of MAIN_COST_CATS){const data=allYears.map(y=>Math.round((visZones.reduce((s,z)=>s+(resultsData[scen]?.costs[z]?.[cat]?.[y]||0),0)-visZones.reduce((s,z)=>s+(resultsData[cmpRef]?.costs[z]?.[cat]?.[y]||0),0))*10)/10);if(data.some(v=>v!==0))datasets.push({label:multi?`${scen} — ${COST_LABELS[cat]||cat}`:(COST_LABELS[cat]||cat),data,backgroundColor:hexA(costColor(cat),multi?0.5:0.82),borderColor:costColor(cat),borderWidth:multi?1:0,stack:scen});}return{labels:allYears,datasets};}
    if(ind.source==='trade'){const datasets=[];const partnerSet=new Set();const pdS={},pdR={};for(const scen of compareScs){pdS[scen]={};pdR[scen]={};for(const y of allYears){const s=getTradePartners(resultsData,scen,visZones,y);const r=getTradePartners(resultsData,cmpRef,visZones,y);pdS[scen][y]=s;pdR[scen][y]=r;Object.keys(s).forEach(p=>partnerSet.add(p));Object.keys(r).forEach(p=>partnerSet.add(p));}}const allPartners=[...partnerSet].sort();const pColor=Object.fromEntries(allPartners.map((p,i)=>[p,MAP_PALETTE[i%MAP_PALETTE.length]]));for(let i=0;i<compareScs.length;i++){const scen=compareScs[i];const col=SCEN_COLORS[(i+1)%SCEN_COLORS.length];for(const p of allPartners){const pc=pColor[p];const dImp=allYears.map(y=>+((pdS[scen][y][p]?.imp||0)-(pdR[scen][y][p]?.imp||0)).toFixed(0));const dExp=allYears.map(y=>+((pdR[scen][y][p]?.exp||0)-(pdS[scen][y][p]?.exp||0)).toFixed(0));if(dImp.some(v=>v!==0))datasets.push({label:multi?`Δ ${scen} ${p} Imp.`:`Δ ${p} Imp.`,type:'bar',data:dImp,backgroundColor:hexA(pc,0.82),borderWidth:0,stack:scen,_partner:p});if(dExp.some(v=>v!==0))datasets.push({label:multi?`Δ ${scen} ${p} Exp.`:`Δ ${p} Exp.`,type:'bar',data:dExp,backgroundColor:hexA(pc,0.42),borderWidth:0,stack:scen,_partner:p});}const dNet=allYears.map(y=>{const s=pdS[scen][y],r=pdR[scen][y];const netS=Object.values(s).reduce((acc,v)=>acc+(v.imp-v.exp),0);const netR=Object.values(r).reduce((acc,v)=>acc+(v.imp-v.exp),0);return+(netS-netR).toFixed(0);});if(dNet.some(v=>v!==0))datasets.push({label:multi?`Δ ${scen} Net`:'Δ Net',type:'line',data:dNet,borderColor:col,borderWidth:1.5,pointRadius:0,tension:0.3,fill:false,stack:`__dnet_${i}__`});}return{labels:allYears,datasets};}
    return null;
  };
  const buildDispatchDelta=()=>{
    if(!cmpRef||cmpRef===dispScenario||!refYear||!activeDispZone||!resultsData[cmpRef])return{chartData:{labels:[],datasets:[]},plugin:null};
    const sdA=resultsData[dispScenario],sdB=resultsData[cmpRef];if(!sdA||!sdB)return{chartData:{labels:[],datasets:[]},plugin:null};
    const zk=activeDispZone==='__all__'?allZones[0]:activeDispZone;
    return buildDispatchDeltaSeries({
      slices, zA:getZoneDisp(sdA,activeDispZone,refYear), zB:getZoneDisp(sdB,activeDispZone,refYear),
      priceA:sdA.price[zk]?.[refYear], priceB:sdB.price[zk]?.[refYear],
      seasons:dispMode==='full'?dispAvailS:[dispSeason], days:dispAvailD,
      daySel:dispMode==='full'?'all':dispDay,
      isDark:t.isDark, mcColor:t.isDark?'rgba(255,255,255,0.88)':'#1E3A8A', hoursData, totalDays,
    });
  };
  const buildTradeCmpDelta=()=>{
    if(!cmpRef||!allYears.length)return null;
    const compareScs=baseFirst(scenarioList.filter(s=>cmpScenarios.has(s)&&s!==cmpRef&&resultsData[s]));
    if(!compareScs.length)return null;
    const attr=trEvMetric==='capacity'?'TransmissionCapacity':trEvMetric==='utilization'?'InterconUtilization':'Interchange';
    const unit=trEvMetric==='volume'?'GWh':trEvMetric==='capacity'?'MW':'%';
    const tx0=resultsData[baseFirst([...trScenarios].filter(s=>resultsData[s]))[0]||cmpRef]?.transmission||{};
    const seen=new Set();const allCorridors=[];
    for(const[z,zm]of Object.entries(tx0))for(const z2 of Object.keys(zm)){if(!allZones.includes(z)&&!allZones.includes(z2))continue;const k=[z,z2].sort().join('||');if(!seen.has(k)){seen.add(k);allCorridors.push({z,z2,key:k});}}
    const corridors=allCorridors.slice(0,10).filter(c=>!isHidden('trev-c',`${c.z}↔${c.z2}`));
    if(!corridors.length)return null;
    const getVal=(scen,c,y)=>{const tx=resultsData[scen]?.transmission||{};if(trEvMetric==='utilization')return(((tx[c.z]?.[c.z2]?.[attr]?.[y]||0)+(tx[c.z2]?.[c.z]?.[attr]?.[y]||0))/2)*100;return Math.abs(tx[c.z]?.[c.z2]?.[attr]?.[y]||0)+Math.abs(tx[c.z2]?.[c.z]?.[attr]?.[y]||0);};
    const isUtil=trEvMetric==='utilization';
    return{labels:allYears,unit,datasets:compareScs.flatMap((scen,si)=>corridors.map((c)=>{const ci2=allCorridors.findIndex(a=>a.key===c.key);const col=MAP_PALETTE[ci2%MAP_PALETTE.length];const data=allYears.map(y=>+(getVal(scen,c,y)-getVal(cmpRef,c,y)).toFixed(isUtil?1:0));if(isUtil)return{label:`${compareScs.length>1?scen+' — ':''}${c.z}↔${c.z2}`,data,type:'line',borderColor:col,backgroundColor:hexA(col,0.1),borderWidth:2,fill:false,tension:0.3,pointRadius:0};return{label:`${compareScs.length>1?scen+' — ':''}${c.z}↔${c.z2}`,data,backgroundColor:hexA(col,0.72),borderColor:col,borderWidth:0,stack:scen};})).filter(d=>d.data.some(v=>v!==0))};
  };

  const buildMix=()=>{const sd=resultsData[ovScenario];if(!sd||!refYear)return null;const zones=visZones.filter(z=>sd.techFuel[z]?.CapacityTechFuel?.[refYear]);if(!zones.length)return null;const tfs=allTechfuels.filter(tf=>zones.some(z=>(sd.techFuel[z]?.CapacityTechFuel?.[refYear]?.[tf]||0)>0));return{labels:zones,datasets:tfs.filter(tf=>!isHidden('mix-c',tf)).map(tf=>({label:tf,data:zones.map(z=>Math.round(sd.techFuel[z]?.CapacityTechFuel?.[refYear]?.[tf]||0)),backgroundColor:techColor(tf),borderWidth:0,barThickness:14,stack:'a'}))};};

  const buildEvolution=()=>{
    const activeSc=baseFirst(scenarioList.filter(s=>evScenarios.has(s)));if(!activeSc.length||!allYears.length)return null;
    const ind=activeInd;
    if(ind.source==='yearlyZone')return{labels:allYears,datasets:activeSc.map((s,i)=>({label:s,data:allYears.map(y=>+yzAgg(resultsData[s]?.yearlyZone,ind.key,visZones,y).toFixed(2)),backgroundColor:hexA(SCEN_COLORS[i%SCEN_COLORS.length],0.75),borderColor:SCEN_COLORS[i%SCEN_COLORS.length],borderWidth:2,fill:false,tension:0.3,type:'line'}))};
    if(ind.source==='costs'){const cats=MAIN_COST_CATS.filter(cat=>activeSc.some(s=>visZones.some(z=>resultsData[s]?.costs[z]?.[cat])));const datasets=[];for(const scen of activeSc)for(const cat of cats){const data=allYears.map(y=>Math.round(visZones.reduce((s,z)=>s+(resultsData[scen]?.costs[z]?.[cat]?.[y]||0),0)*10)/10);if(data.some(v=>v!==0))datasets.push({label:`${activeSc.length>1?scen+' — ':''}${COST_LABELS[cat]||cat}`,data,backgroundColor:hexA(costColor(cat),activeSc.length>1?0.5:0.82),borderColor:costColor(cat),borderWidth:activeSc.length>1?1:0,stack:scen});}return{labels:allYears,datasets};}
    if(ind.source==='trade'){const multi=activeSc.length>1;const datasets=[];const partnerSet=new Set();const pdCache={};for(const scen of activeSc){pdCache[scen]={};for(const y of allYears){const d=getTradePartners(resultsData,scen,visZones,y);pdCache[scen][y]=d;Object.keys(d).forEach(p=>partnerSet.add(p));}}const allPartners=[...partnerSet].sort();const pColor=Object.fromEntries(allPartners.map((p,i)=>[p,MAP_PALETTE[i%MAP_PALETTE.length]]));for(let i=0;i<activeSc.length;i++){const scen=activeSc[i];const col=SCEN_COLORS[i%SCEN_COLORS.length];for(const p of allPartners){const pc=pColor[p];const impData=allYears.map(y=>+((pdCache[scen][y][p]?.imp)||0).toFixed(0));const expData=allYears.map(y=>+(-(pdCache[scen][y][p]?.exp||0)).toFixed(0));if(impData.some(v=>v!==0))datasets.push({label:multi?`${scen} — ${p} Imp.`:`${p} Imp.`,type:'bar',data:impData,backgroundColor:hexA(pc,0.82),borderWidth:0,stack:scen,_partner:p});if(expData.some(v=>v!==0))datasets.push({label:multi?`${scen} — ${p} Exp.`:`${p} Exp.`,type:'bar',data:expData,backgroundColor:hexA(pc,0.42),borderWidth:0,stack:scen,_partner:p});}datasets.push({label:multi?`${scen} — Net`:'Net',type:'line',data:allYears.map(y=>+Object.values(pdCache[scen][y]).reduce((s,v)=>s+(v.imp-v.exp),0).toFixed(0)),borderColor:col,borderWidth:1.5,pointRadius:0,tension:0.3,fill:false,stack:`__net_${i}__`});}return{labels:allYears,datasets};}
    const tfs=allTechfuels.filter(tf=>!isHidden('ev-c',tf));const datasets=[];for(const scen of activeSc)for(const tf of tfs){datasets.push({label:`${scen} — ${tf}`,data:allYears.map(y=>Math.round(visZones.reduce((s,z)=>s+(resultsData[scen]?.techFuel[z]?.[ind.key]?.[y]?.[tf]||0),0))),backgroundColor:hexA(techColor(tf),activeSc.length>1?0.5:0.85),borderColor:techColor(tf),borderWidth:activeSc.length>1?1:0,stack:scen});}if(extraKind(ind.key))for(const scen of activeSc)pushExtras(datasets,extrasOf(scen,ind.key,allYears,y=>({zones:visZones,year:y})),scen,activeSc.length>1);return{labels:allYears,datasets};
  };

  const buildDispatch=()=>{
    const sd=resultsData[dispScenario];if(!sd||!activeDispZone||!refYear)return{chartData:{labels:[],datasets:[]},plugin:null};
    // An aggregate has no single marginal price: show the first zone's as a stand-in.
    const zk=activeDispZone==='__all__'?allZones[0]:activeDispZone;
    return buildDispatchSeries({
      slices, zDisp:getZoneDisp(sd,activeDispZone,refYear), price:sd.price[zk]?.[refYear],
      seasons:dispMode==='full'?dispAvailS:[dispSeason], days:dispAvailD,
      daySel:dispMode==='full'?'all':dispDay,
      isDark:t.isDark, mcColor:t.isDark?'rgba(255,255,255,0.88)':'#1E3A8A', hoursData, totalDays,
    });
  };

  const buildTrade=()=>{const tx=resultsData[trScenario]?.transmission||{};if(!refYear)return null;const imp={},exp={};for(const z of visZones){imp[z]=0;exp[z]=0;for(const[z2,attrs]of Object.entries(tx[z]||{}))exp[z]+=(attrs.Interchange?.[refYear]||0);for(const[z2,zm]of Object.entries(tx))if(z2!==z)imp[z]+=(zm[z]?.Interchange?.[refYear]||0);}const zones=allZones.filter(z=>imp[z]+exp[z]>0.5).sort((a,b)=>(imp[b]-exp[b])-(imp[a]-exp[a]));if(!zones.length)return null;const net=Object.fromEntries(zones.map(z=>[z,+(imp[z]-exp[z]).toFixed(1)]));return{labels:zones,datasets:[!isHidden('trade-c','Imports')&&{label:'Imports',data:zones.map(z=>+imp[z].toFixed(1)),backgroundColor:hexA('#2E9EC8',0.78),borderWidth:0,barThickness:12,stack:'t'},!isHidden('trade-c','Exports')&&{label:'Exports',data:zones.map(z=>+(-exp[z]).toFixed(1)),backgroundColor:hexA('#E8C547',0.78),borderWidth:0,barThickness:12,stack:'t'},{label:'Net',data:zones.map(z=>net[z]),backgroundColor:t.isDark?'rgba(255,255,255,0.92)':'#1E3A8A',borderWidth:0,barThickness:3,order:0}].filter(Boolean),_imp:imp,_exp:exp,_net:net};};

  const buildTradeEv=()=>{
    const activeSc=baseFirst(scenarioList.filter(s=>trScenarios.has(s)&&resultsData[s]));
    if(!activeSc.length||!allYears.length)return null;
    const tx0=resultsData[activeSc[0]]?.transmission||{};
    const corridors=[];const seen=new Set();
    for(const[z,zm]of Object.entries(tx0))for(const z2 of Object.keys(zm)){if(!allZones.includes(z)&&!allZones.includes(z2))continue;if(selZone!=='all'&&z!==selZone&&z2!==selZone)continue;const k=[z,z2].sort().join('||');if(!seen.has(k)){seen.add(k);corridors.push({z,z2,key:k});}}
    if(!corridors.length)return null;
    const attr=trEvMetric==='volume'?'Interchange':trEvMetric==='capacity'?'TransmissionCapacity':'InterconUtilization';
    const unit=trEvMetric==='volume'?'GWh':trEvMetric==='capacity'?'MW':'%';
    const PSTYLES=['circle','rectRot','triangle','crossRot'];const isUtil=trEvMetric==='utilization';const multi=activeSc.length>1;
    const datasets=activeSc.flatMap((scen,si)=>corridors.slice(0,10).map((c,ci)=>{
      const col=MAP_PALETTE[ci%MAP_PALETTE.length];
      const data=allYears.map(y=>{const tx=resultsData[scen]?.transmission||{};const fwd=tx[c.z]?.[c.z2]?.[attr]?.[y]||0;const rev=tx[c.z2]?.[c.z]?.[attr]?.[y]||0;return isUtil?+(((fwd+rev)/2)*100).toFixed(1):+(Math.abs(fwd)+Math.abs(rev)).toFixed(1);});
      const label=multi?`${scen} — ${c.z}↔${c.z2}`:`${c.z}↔${c.z2}`;
      if(isUtil)return{label,data,type:'line',borderColor:col,backgroundColor:hexA(col,0.1),borderWidth:1.5,fill:false,tension:0.3,pointStyle:PSTYLES[si%PSTYLES.length],pointRadius:3};
      return{label,data,backgroundColor:hexA(col,0.82),borderColor:col,borderWidth:0,stack:scen,type:'bar'};
    }));
    return{labels:allYears,corridors,unit,datasets};
  };

  const buildSummary=()=>{
    const allSc=baseFirst(scenarioList.filter(s=>resultsData[s]));
    if(!allSc.length||!allYears.length)return null;
    const ref=summaryRef||allSc[0];
    const lastY=allYears[allYears.length-1];
    const compute=scen=>physicalStats(resultsData[scen],visZones,allYears,lastY,MAIN_COST_CATS);
    const data=Object.fromEntries(allSc.map(s=>[s,compute(s)]));
    return{allSc,ref,nonRef:allSc.filter(s=>s!==ref),data,lastY};
  };
  const buildPlants=()=>rankPlants(resultsData[plScenario]?.plants,{attribute:plIndicator,year:refYear,topN:plTopN,keep:p=>allZones.includes(p.z)&&(plZone==='all'||p.z===plZone)});
  const buildLCOE=()=>{const pl=resultsData[plScenario]?.plants||[];if(!refYear)return null;const byG={};for(const p of pl.filter(pp=>pp.y===refYear&&allZones.includes(pp.z)&&(plZone==='all'||pp.z===plZone))){if(!byG[p.g])byG[p.g]={techfuel:p.techfuel,z:p.z};byG[p.g][p.attribute]=p.value;}const points=Object.entries(byG).map(([g,d])=>({g,techfuel:d.techfuel||'',lcoe:d.PlantAnnualLCOE||0,util:(d.UtilizationPlant||0)*100,cap:d.CapacityPlant||0})).filter(p=>p.lcoe>0&&p.util>0&&p.cap>0);const tfs=[...new Set(points.map(p=>p.techfuel))].sort();return{datasets:tfs.map(tf=>({label:tf,data:points.filter(p=>p.techfuel===tf).map(p=>({x:+p.util.toFixed(1),y:+p.lcoe.toFixed(1),r:Math.min(Math.max(Math.sqrt(p.cap)*0.6,3),20),_plant:p.g,_cap:p.cap})),backgroundColor:hexA(techColor(tf),0.65),borderColor:techColor(tf),borderWidth:1})).filter(d=>d.data.length>0)};};

  const snapData=buildSnapshot(),snapDeltaData=buildSnapshotDelta();
  const cmpEvData=buildCmpEvolution();
  const dispDeltaResult=(cmpRef&&cmpRef!==dispScenario&&resultsData[cmpRef])?buildDispatchDelta():{chartData:{labels:[],datasets:[]},plugin:null};
  const tradeCmpDeltaData=buildTradeCmpDelta();
  const mixData=buildMix(),evData=buildEvolution(),dispResult=buildDispatch(),tradeData=buildTrade(),tradeEvData=buildTradeEv(),plantsData=buildPlants(),lcoeData=buildLCOE(),summaryData=buildSummary();
  const plUnit=plantDisplay(plIndicator).unit;
  const dispTechs=dispResult.chartData.datasets.filter(d=>d.label!=='Marginal cost'&&d.label!=='Demand').map(d=>d.label);

  // ── Legend helpers ────────────────────────────────────────────────────────────
  const tfLabel=d=>d.label.includes(' — ')?d.label.split(' — ')[1]:d.label;
  const makeLegend=(id,items,clickable=true)=>{
    const hidden=hiddenMap[id]||new Set();
    return <div style={{width:90,flexShrink:0,display:'flex',flexDirection:'column',gap:2,paddingTop:4,maxHeight:220,overflowY:'auto'}}>
      {items.map(({label,color,shape,fill})=><div key={label} onClick={clickable?()=>toggleHidden(id,label):undefined} style={{display:'flex',alignItems:'center',gap:3,cursor:clickable?'pointer':'default',opacity:hidden.has(label)?0.25:1}}>
        {shape==='line'?<div style={{width:12,height:2,backgroundColor:color,borderRadius:1,flexShrink:0}}/>:<div style={{width:8,height:8,borderRadius:shape==='circle'?'50%':2,background:fill||color,flexShrink:0}}/>}
        <span style={{fontSize:'0.4rem',color:t.muted,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{label}</span>
      </div>)}
      {clickable&&<div style={{fontSize:'0.38rem',color:t.lblMuted,marginTop:4,display:'flex',gap:6}}>
        <span onClick={()=>setHiddenMap(p=>({...p,[id]:new Set(items.map(i=>i.label))}))} style={{cursor:'pointer',textDecoration:'underline'}}>None</span>
        <span onClick={()=>setHiddenMap(p=>({...p,[id]:new Set()}))} style={{cursor:'pointer',textDecoration:'underline'}}>All</span>
      </div>}
    </div>;
  };

  // ── JSX ───────────────────────────────────────────────────────────────────────
  return (
    <div style={{display:'flex',height:'calc(100vh - 46px)'}}
      onMouseMove={e=>{if(!isDrRef.current)return;setPanelWidth(w=>Math.max(380,drStartW.current+(drStartX.current-e.clientX)));}}
      onMouseUp={()=>{isDrRef.current=false;}} onMouseLeave={()=>{isDrRef.current=false;}}
    >
      <div style={{position:'relative',flex:1}}>
        <div ref={containerRef} style={{width:'100%',height:'100%',backgroundColor:t.bg}}/>
        <MapDownload mapRef={mapRef} t={t} name={()=>ttl(`${countryDecoded} map`,refYear)}/>
        <div style={{position:'absolute',top:10,left:10,zIndex:10,display:'flex',gap:4,alignItems:'center',fontSize:'0.52rem',color:t.text,backgroundColor:t.panel,border:`1px solid ${t.panelBorder}`,borderRadius:5,padding:'4px 10px',boxShadow:'0 1px 4px rgba(0,0,0,.18)'}}>
          <Link to="/" style={{color:t.lblMuted,textDecoration:'none'}}>World</Link><span style={{color:t.lblMuted}}>›</span>
          <Link to={`/region/${regionId}/results`} style={{color:t.lblMuted,textDecoration:'none'}}>{region.name} · Results</Link>
          <span style={{color:t.lblMuted}}>›</span><span style={{color:t.lbl,fontWeight:600}}>{countryDecoded}</span>
        </div>
        {allYears.length>0&&(
          <div style={{position:'absolute',top:10,right:10,zIndex:10,display:'flex',gap:5,alignItems:'center',fontSize:'0.52rem',color:t.text,backgroundColor:t.panel,border:`1px solid ${t.panelBorder}`,borderRadius:5,padding:'4px 8px',boxShadow:'0 1px 4px rgba(0,0,0,.18)'}}>
            <span style={{color:t.lblMuted,fontSize:'0.44rem',textTransform:'uppercase',letterSpacing:'0.04em'}}>Year</span>
            <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>{allYears.map(y=><option key={y} value={y}>{y}</option>)}</select>
          </div>
        )}
        {hasData&&(
          <div style={{position:'absolute',bottom:14,left:10,zIndex:10,backgroundColor:hexA(t.panel,0.92),border:`1px solid ${t.panelBorder}`,borderRadius:6,padding:'8px 10px',fontSize:'0.43rem',color:t.muted,minWidth:110}}>
            <div style={{marginBottom:5}}>
              <div style={{fontSize:'0.38rem',color:t.lblMuted,marginBottom:2}}>Interco utilization</div>
              <div style={{background:'linear-gradient(to right, #FFD700, #FF8C00, #E53935)',height:5,borderRadius:3,marginBottom:2}}/>
              <div style={{display:'flex',justifyContent:'space-between'}}><span>0%</span><span>100%</span></div>
            </div>
            {Object.keys(zoneAvgPrices).length>0&&<div>
              <div style={{fontSize:'0.38rem',color:t.lblMuted,marginBottom:2}}>Zonal price (marginal cost)</div>
              <div style={{background:'linear-gradient(to right, #FFFFFF, #1B6CA8)',height:5,borderRadius:3,marginBottom:2}}/>
              <div style={{display:'flex',justifyContent:'space-between'}}><span>{minP.toFixed(0)}</span><span>{maxP.toFixed(0)} $/MWh</span></div>
            </div>}
            <div style={{marginTop:8,paddingTop:8,borderTop:`1px solid ${hexA(t.panelBorder,0.5)}`}}>
              <div style={{fontSize:'0.38rem',color:t.lblMuted,marginBottom:4}}>Zone mix</div>
              <div style={{display:'flex',gap:4}}>
                <Pill active={pieDispMode==='none'} onClick={()=>setPieDispMode('none')}>—</Pill>
                <Pill active={pieDispMode==='capacity'} onClick={()=>setPieDispMode('capacity')}>Cap.</Pill>
                <Pill active={pieDispMode==='energy'} onClick={()=>setPieDispMode('energy')}>Gen.</Pill>
              </div>
            </div>
            {(zonesExtGJ||extNtc.length>0)&&(
              <div style={{marginTop:8,paddingTop:8,borderTop:`1px solid ${hexA(t.panelBorder,0.5)}`}}>
                <div style={{fontSize:'0.38rem',color:t.lblMuted,marginBottom:4}}>External neighbours</div>
                <Pill active={showExtZones} onClick={()=>setShowExtZones(v=>!v)}>Ext. zones</Pill>
              </div>
            )}
            <div style={{marginTop:8,paddingTop:8,borderTop:`1px solid ${hexA(t.panelBorder,0.5)}`}}>
              <div style={{fontSize:'0.38rem',color:t.lblMuted,marginBottom:4}}>Labels</div>
              <Pill active={zoneLabels} onClick={()=>setZoneLabels(v=>!v)}>Zone names</Pill>
            </div>
          </div>
        )}
      </div>

      <div style={{width:5,flexShrink:0,cursor:'col-resize'}} onMouseDown={e=>{isDrRef.current=true;drStartX.current=e.clientX;drStartW.current=panelWidth;e.preventDefault();}}/>

      <div style={{zoom,width:unzoom(panelWidth,zoom),flexShrink:0,height:unzoom('100%',zoom),overflowY:'auto',padding:'18px 16px',backgroundColor:t.panel,borderLeft:`1px solid ${t.panelBorder}`}}>
        <PanelZoomControl t={t} zoom={zoom} inc={inc} dec={dec} reset={reset}/>
        <div style={{marginBottom:12}}>
          <div style={{fontSize:'0.52rem',color:t.lblMuted,marginBottom:2}}><Link to={`/region/${regionId}/results`} style={{color:t.lblMuted,textDecoration:'none'}}>← {region.name} · Results</Link></div>
          <div style={{fontSize:'1rem',fontWeight:700,color:t.lbl}}>{countryDecoded} — Results</div>
        </div>
        {/* Run selector */}
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12,padding:'7px 10px',border:`1px solid ${t.panelBorder}`,borderRadius:6,backgroundColor:hexA(t.panelBorder,0.12)}}>
          <span style={{fontSize:'0.5rem',color:t.lblMuted,flexShrink:0}}>Run</span>
          {loadingRuns?<span style={{fontSize:'0.5rem',color:t.lblMuted}}>Loading…</span>:runList.length>0?<select value={simRun||''} onChange={e=>setSimRun(e.target.value)} style={{...selectStyle,flex:1}}>{runList.map(r=><option key={r} value={r}>{r}</option>)}</select>:<span style={{fontSize:'0.5rem',color:t.lblMuted}} title={runsUnreachable?'The results are published; this network or browser is blocking the data host':undefined}>{runsUnreachable?'Data host unreachable':'No results'}</span>}
        </div>
        {/* Tabs */}
        <div style={{display:'flex',gap:0,marginBottom:16,borderBottom:`1px solid ${t.panelBorder}`}}>
          {TABS.map(tab=><button key={tab} onClick={()=>setActiveTab(tab)} style={{fontSize:'0.5rem',fontFamily:'inherit',padding:'6px 11px',border:'none',borderBottom:activeTab===tab?`2px solid ${t.lbl}`:'2px solid transparent',backgroundColor:'transparent',color:activeTab===tab?t.lbl:t.lblMuted,cursor:'pointer',fontWeight:activeTab===tab?600:400,textTransform:'capitalize'}}>{tab}</button>)}
        </div>
        {loadingData&&<div style={{padding:'24px 0',textAlign:'center',color:t.lblMuted,fontSize:'0.6rem'}}>Loading…</div>}
        {hasData&&allZones.length>1&&(
          <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:10,fontSize:'0.44rem',color:t.muted}}>
            <span style={{color:t.lblMuted}}>Zone:</span>
            <select value={selZone} onChange={e=>setSelZone(e.target.value)} style={selectStyle}>
              <option value="all">All zones</option>
              {allZones.map(z=><option key={z} value={z}>{z}</option>)}
            </select>
            {selZone!=='all'&&<span onClick={()=>setSelZone('all')} style={{cursor:'pointer',color:t.lblMuted,padding:'1px 5px',border:`1px solid ${t.panelBorder}`,borderRadius:3,fontSize:'0.42rem'}}>✕ all</span>}
            <span style={{color:t.lblMuted,fontSize:'0.4rem',marginLeft:2}}>or click zone on map</span>
          </div>
        )}

        {/* ── OVERVIEW ── */}
        {hasData&&activeTab==='overview'&&(
          <div style={{display:'flex',flexDirection:'column',gap:14}}>
            <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
              <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>{allYears.map(y=><option key={y} value={y}>{y}</option>)}</select>
              <select value={ovScenario||''} onChange={e=>setOvScenario(e.target.value)} style={selectStyle}>{scenarioList.map(s=><option key={s} value={s}>{s}</option>)}</select>
            </div>
            {(()=>{const sd=resultsData[ovScenario];if(!sd||!refYear)return null;const totGW=allZones.reduce((s,z)=>s+Object.values(sd.techFuel[z]?.CapacityTechFuel?.[refYear]||{}).reduce((a,b)=>a+b,0),0)/1000;const demTWh=allZones.reduce((s,z)=>s+(sd.yearlyZone[z]?.DemandEnergyZone?.[refYear]||0),0)/1000;const avgP=priceVals.length?priceVals.reduce((a,b)=>a+b,0)/priceVals.length:null;return<div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>{[{l:`Installed ${refYear}`,v:`${totGW.toFixed(1)} GW`},{l:`Demand ${refYear}`,v:`${demTWh.toFixed(0)} TWh`},{l:'Avg price',v:avgP!=null?`${avgP.toFixed(1)} $/MWh`:'—'}].map(({l,v})=><div key={l} style={{border:`1px solid ${t.panelBorder}`,borderRadius:6,padding:'8px 10px'}}><div style={{fontSize:'0.41rem',color:t.lblMuted,marginBottom:2}}>{l}</div><div style={{fontSize:'0.78rem',fontWeight:700,color:t.lbl}}>{v}</div></div>)}</div>;})()}
            {mixData&&<div>
              <SectionTitle t={t}>Capacity mix by zone (MW)</SectionTitle>
              <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                <div style={{flex:1,minWidth:0}}>
                  <CJChart name={ttl('Capacity mix (MW)',selZone==='all'?countryDecoded:selZone,ovScenario,refYear)} type="bar" height={Math.min(mixData.labels.length*22+24,260)} cacheKey={`mix-c|${ovScenario}|${refYear}|${theme}|${[...hiddenMap['mix-c']||[]].join(',')}`} data={mixData} plugins={[barTotalPlugin({axis:'x',color:t.muted,unit:'MW',fmt:v=>fmt(v)})]} options={{...cjDefaults(t),indexAxis:'y',layout:{padding:{right:62}},scales:{x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},y:{stacked:true,grid:{display:false},ticks:{color:t.muted,font:{size:9}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,footerColor:t.lbl,footerFont:{size:10},callbacks:{label:ctx=>`${ctx.dataset.label}: ${fmt(ctx.parsed.x)} MW`,footer:barTotalFooter({axis:'x',unit:'MW',fmt:v=>fmt(v),filtered:(hiddenMap['mix-c']?.size||0)>0})}}}}}/>
                </div>
                {makeLegend('mix-c',allTechfuels.filter(tf=>mixData.datasets.some(d=>d.label===tf)).map(tf=>({label:tf,color:techColor(tf)})))}
              </div>
            </div>}
            {Object.keys(zoneAvgPrices).length>0&&<div>
              <SectionTitle t={t}>Avg marginal price by zone ($/MWh)</SectionTitle>
              <CJChart name={ttl('Average marginal price by zone ($/MWh)',selZone==='all'?countryDecoded:selZone,ovScenario,refYear)} type="bar" height={Math.min(allZones.filter(z=>zoneAvgPrices[z]).length*22+24,200)} cacheKey={`pz-c|${ovScenario}|${refYear}|${theme}`}
                data={{labels:allZones.filter(z=>zoneAvgPrices[z]),datasets:[
                  {label:'Range',data:allZones.filter(z=>zoneAvgPrices[z]).map(z=>{const r=zonePriceRange[z];return r?[+r.min.toFixed(1),+r.max.toFixed(1)]:[+zoneAvgPrices[z].toFixed(1),+zoneAvgPrices[z].toFixed(1)];}),backgroundColor:allZones.filter(z=>zoneAvgPrices[z]).map(z=>priceBarColor((zoneAvgPrices[z]-minP)/rngP).replace('rgb(','rgba(').replace(')',',0.18)')),borderWidth:0,barThickness:10},
                  {type:'scatter',label:'Avg',data:allZones.filter(z=>zoneAvgPrices[z]).map(z=>({x:+zoneAvgPrices[z].toFixed(1),y:z})),pointStyle:'line',rotation:90,radius:6,borderWidth:2.5,borderColor:allZones.filter(z=>zoneAvgPrices[z]).map(z=>priceBarColor((zoneAvgPrices[z]-minP)/rngP))},
                ]}}
                options={{...cjDefaults(t),indexAxis:'y',scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9}}},y:{grid:{display:false},ticks:{color:t.muted,font:{size:9}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>{const zones=allZones.filter(z=>zoneAvgPrices[z]);const z=zones[ctx.dataIndex];if(ctx.datasetIndex===0){const r=zonePriceRange[z];return r&&r.min!==r.max?`${r.min.toFixed(1)}–${r.max.toFixed(1)} $/MWh`:'';} return`Avg: ${zoneAvgPrices[z]?.toFixed(1)} $/MWh`;},title:ctx=>ctx[0]?.label||''}}}}}
              />
              {priceVals.length>0&&<div style={{display:'flex',gap:12,marginTop:4,fontSize:'0.44rem',color:t.muted}}><span>Avg: <b style={{color:t.lbl}}>{(priceVals.reduce((a,b)=>a+b,0)/priceVals.length).toFixed(1)} $/MWh</b></span><span>Min: <b style={{color:t.lbl}}>{minP.toFixed(1)}</b></span><span>Max: <b style={{color:t.lbl}}>{maxP.toFixed(1)}</b></span></div>}
            </div>}
          </div>
        )}

        {/* ── SNAPSHOT ── */}
        {hasData&&activeTab==='snapshot'&&(
          <div style={{display:'flex',flexDirection:'column',gap:14}}>
            <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
              <select value={snapIndicator} onChange={e=>setSnapIndicator(e.target.value)} style={selectStyle}>{INDICATORS.map(ind=><option key={ind.key} value={ind.key}>{ind.label}</option>)}</select>
              <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>{allYears.map(y=><option key={y} value={y}>{y}</option>)}</select>
              <div style={{width:1,height:14,backgroundColor:t.panelBorder}}/>
              <ScenarioPicker t={t} all={scenarioList} selected={snapScenarios} onChange={setSnapScenarios}/>
            </div>
            {snapData&&snapData.datasets.length>0?
              <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                <ScenarioKey t={t} scenarios={baseFirst(scenarioList.filter(s=>snapScenarios.has(s)&&resultsData[s]))}/>
                <div style={{flex:1,minWidth:0}}>
                  <CJChart name={ttl(snapData.ind?.label||'Snapshot',selZone==='all'?countryDecoded:selZone,refYear,scenList(snapScenarios))} type="bar" height={220}
                    cacheKey={`snap-c|${snapIndicator}|${refYear}|${theme}|${[...snapScenarios].sort().join(',')}|${[...hiddenMap['snap-c-tf']||[]].join(',')}`}
                    plugins={(()=>{const aSc=baseFirst(scenarioList.filter(s=>snapScenarios.has(s)&&resultsData[s]));const sp=makeScenPlugin(aSc,t.muted);return[snapData.netPlugin,sp,snapData.ind?.source==='techFuel'&&barTotalPlugin({axis:'y',color:t.muted})].filter(Boolean);})()}
                    data={{labels:snapData.labels,datasets:snapData.datasets.filter(d=>{if(snapData.ind?.source==='trade')return!isHidden('snap-c-trade-p',d._partner||'');const lbl=d.label.includes(' — ')?d.label.split(' — ')[1]:d.label;return!isHidden('snap-c-tf',lbl);})}}
                    options={{...cjDefaults(t),datasets:{bar:{barPercentage:0.72}},scales:{x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},maxRotation:45,autoSkip:true,maxTicksLimit:20,padding:16}},y:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:(snapData.ind||{}).unit||'',color:t.muted,font:{size:8}}}},plugins:{...cjDefaults(t).plugins,legend:{display:false},tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false,footerColor:t.lbl,footerFont:{size:10},callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw?.toLocaleString?.()??ctx.raw}`,footer:snapData.ind?.source==='techFuel'?barTotalFooter({axis:'y',unit:(snapData.ind||{}).unit,filtered:anyHidden('snap-c-tf')}):undefined}}}}}
                  />
                </div>
                {snapData.ind?.source!=='trade'&&makeLegend('snap-c-tf',[...new Set(snapData.datasets.map(tfLabel))].map(seriesLegendItem))}
                {snapData.ind?.source==='trade'&&(()=>{const ps=[...new Set(snapData.datasets.filter(d=>d._partner).map(d=>d._partner))].sort();return makeLegend('snap-c-trade-p',ps.map((p,i)=>({label:p,color:MAP_PALETTE[i%MAP_PALETTE.length]})));})()}
              </div>
            :<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>Select at least one scenario.</div>}
            {scenarioList.length>1&&(
              <div style={{borderTop:`1px solid ${hexA(t.panelBorder,0.4)}`,paddingTop:10,marginTop:2,display:'flex',flexDirection:'column',gap:8}}>
                <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
                  <span style={{fontSize:'0.47rem',letterSpacing:'2px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase'}}>Δ vs ref:</span>
                  <select value={cmpRef||''} onChange={e=>pickCmpRef(e.target.value)} style={selectStyle}>{scenarioList.map(s=><option key={s} value={s}>{s}</option>)}</select>
                  <ScenarioPicker t={t} label="Compare" all={scenarioList} exclude={[cmpRef]} selected={cmpScenarios} onChange={setCmpScenarios}/>
                </div>
                {snapDeltaData&&snapDeltaData.datasets.length>0?
                  <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                    <div style={{flex:1,minWidth:0}}>
                      <CJChart name={ttl(`Δ ${snapDeltaData.ind?.label||'Snapshot'} vs ${cmpRef}`,selZone==='all'?countryDecoded:selZone,refYear,scenList(cmpScenarios))} type="bar" height={180}
                        cacheKey={`snap-c-d|${snapIndicator}|${refYear}|${theme}|${cmpRef}|${[...cmpScenarios].sort().join(',')}|${[...hiddenMap['snap-c-tf']||[]].join(',')}`}
                        plugins={[snapDeltaData.netPlugin,snapDeltaData.ind?.source==='techFuel'&&barTotalPlugin({axis:'y',color:t.muted,delta:true})].filter(Boolean)}
                        data={{labels:snapDeltaData.labels,datasets:snapDeltaData.datasets.filter(d=>{if(snapDeltaData.ind?.source==='trade')return!isHidden('snap-c-trade-p',d._partner||'');const lbl=d.label.includes(' — ')?d.label.split(' — ')[1]:d.label;return!isHidden('snap-c-tf',lbl);})}}
                        options={{...cjDefaults(t),scales:{x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},maxRotation:45,autoSkip:true,maxTicksLimit:20}},y:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:(snapDeltaData.ind||{}).unit||'',color:t.muted,font:{size:8}}}},plugins:{...cjDefaults(t).plugins,legend:{display:false},tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false,footerColor:t.lbl,footerFont:{size:10},callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw>0?'+':''}${ctx.raw?.toLocaleString?.()??ctx.raw}`,footer:barTotalFooter({axis:'y',delta:true,unit:(snapDeltaData.ind||{}).unit,filtered:anyHidden(snapDeltaData.ind?.source==='trade'?'snap-c-trade-p':'snap-c-tf')})}}}}}
                      />
                      {[...cmpScenarios].filter(s=>resultsData[s]&&s!==cmpRef).length>0&&(
                        <div style={{fontSize:'0.42rem',color:t.lblMuted,marginTop:3}}>Δ vs <b style={{color:t.muted}}>{cmpRef}</b>: {baseFirst([...cmpScenarios].filter(s=>resultsData[s]&&s!==cmpRef)).join(' · ')}</div>
                      )}
                    </div>
                    {snapDeltaData.ind?.source!=='trade'&&makeLegend('snap-c-tf',[...new Set(snapDeltaData.datasets.map(tfLabel))].map(seriesLegendItem))}
                    {snapDeltaData.ind?.source==='trade'&&(()=>{const ps=[...new Set(snapDeltaData.datasets.filter(d=>d._partner).map(d=>d._partner))].sort();return makeLegend('snap-c-trade-p',ps.map((p,i)=>({label:p,color:MAP_PALETTE[i%MAP_PALETTE.length]})));})()}
                  </div>
                :<div style={{fontSize:'0.55rem',color:t.lblMuted}}>{[...cmpScenarios].filter(s=>s!==cmpRef&&resultsData[s]).length>0?'No differences found.':'Select at least one scenario to compare.'}</div>}
              </div>
            )}
          </div>
        )}

        {/* ── EVOLUTION ── */}
        {hasData&&activeTab==='evolution'&&(
          <div style={{display:'flex',flexDirection:'column',gap:14}}>
            <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
              <select value={evIndicator} onChange={e=>setEvIndicator(e.target.value)} style={selectStyle}>{INDICATORS.map(ind=><option key={ind.key} value={ind.key}>{ind.label}</option>)}</select>
              <div style={{width:1,height:14,backgroundColor:t.panelBorder}}/>
              <ScenarioPicker t={t} all={scenarioList} selected={evScenarios} onChange={setEvScenarios}/>
            </div>
            {evData?
              <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                <ScenarioKey t={t} scenarios={baseFirst(scenarioList.filter(s=>evScenarios.has(s)&&resultsData[s]))}/>
                <div style={{flex:1,minWidth:0}}>
                  <CJChart name={ttl(activeInd.label,selZone==='all'?countryDecoded:selZone,scenList(evScenarios))} type={activeInd.source==='yearlyZone'?'line':'bar'} height={200} cacheKey={`ev-c|${evIndicator}|${theme}|${[...evScenarios].sort().join(',')}|${[...hiddenMap['ev-c']||[]].join(',')}`}
                    data={{...evData,datasets:evData.datasets.filter(d=>{if(activeInd.source==='techFuel')return!isHidden('ev-c',tfLabel(d));if(activeInd.source==='costs')return!isHidden('ev-cost',tfLabel(d));if(activeInd.source==='trade')return d.type==='line'||!isHidden('ev-trade-p',d._partner||'');return true;})}}
                    plugins={(()=>{const aSc=baseFirst(scenarioList.filter(s=>evScenarios.has(s)&&resultsData[s]));const sp=makeScenPlugin(aSc,t.muted);return[sp,(activeInd.source==='techFuel'||activeInd.source==='costs')&&barTotalPlugin({axis:'y',color:t.muted})].filter(Boolean);})()}
                    options={{...cjDefaults(t),datasets:{bar:{barPercentage:0.72}},scales:{x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},maxTicksLimit:10,padding:16}},y:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:activeInd.unit,color:t.muted,font:{size:8}}}},plugins:{...cjDefaults(t).plugins,legend:activeInd.source==='yearlyZone'&&evScenarios.size>1?{display:true,labels:{color:t.muted,font:{size:9},boxWidth:8,boxHeight:6}}:{display:false},tooltip:{...cjDefaults(t).plugins.tooltip,footerColor:t.lbl,footerFont:{size:10},callbacks:{label:ctx=>`${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`,footer:activeInd.source==='techFuel'||activeInd.source==='costs'?barTotalFooter({axis:'y',unit:activeInd.unit,filtered:anyHidden(activeInd.source==='costs'?'ev-cost':'ev-c')}):undefined}}}}}/>
                </div>
                {activeInd.source==='techFuel'&&makeLegend('ev-c',[...new Set(evData.datasets.map(tfLabel))].map(seriesLegendItem))}
                {activeInd.source==='costs'&&makeLegend('ev-cost',MAIN_COST_CATS.filter(cat=>evData.datasets.some(d=>tfLabel(d)===(COST_LABELS[cat]||cat))).map(cat=>({label:COST_LABELS[cat]||cat,color:costColor(cat)})))}
                {activeInd.source==='trade'&&(()=>{const ps=[...new Set(evData.datasets.filter(d=>d._partner).map(d=>d._partner))].sort();const aSc=baseFirst(scenarioList.filter(s=>evScenarios.has(s)&&resultsData[s]));return <div style={{flexShrink:0,display:'flex',flexDirection:'column',gap:6}}>{makeLegend('ev-trade-p',ps.map((p,i)=>({label:p,color:MAP_PALETTE[i%MAP_PALETTE.length]})))}{aSc.length>1&&makeLegend('__ev_scen__',aSc.map((s,i)=>({label:s,color:SCEN_COLORS[i%SCEN_COLORS.length],shape:'line'})),false)}</div>;})()}
              </div>
            :<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>Select at least one scenario.</div>}
            {scenarioList.length>1&&(
              <div style={{borderTop:`1px solid ${hexA(t.panelBorder,0.4)}`,paddingTop:10,marginTop:2,display:'flex',flexDirection:'column',gap:8}}>
                <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
                  <span style={{fontSize:'0.47rem',letterSpacing:'2px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase'}}>Δ vs ref:</span>
                  <select value={cmpRef||''} onChange={e=>pickCmpRef(e.target.value)} style={selectStyle}>{scenarioList.map(s=><option key={s} value={s}>{s}</option>)}</select>
                  <ScenarioPicker t={t} label="Compare" all={scenarioList} exclude={[cmpRef]} selected={cmpScenarios} onChange={setCmpScenarios}/>
                </div>
                {cmpEvData&&cmpEvData.datasets.length>0?
                  <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                    <div style={{flex:1,minWidth:0}}>
                      <CJChart name={ttl(`Δ ${activeInd.label} vs ${cmpRef}`,selZone==='all'?countryDecoded:selZone,scenList(cmpScenarios))} type="bar" height={190}
                        cacheKey={`cmp-ev-c|${evIndicator}|${theme}|${cmpRef}|${[...cmpScenarios].sort().join(',')}|${[...hiddenMap['ev-c']||[]].join(',')}|${[...hiddenMap['ev-cost']||[]].join(',')}`}
                        data={{...cmpEvData,datasets:cmpEvData.datasets.filter(d=>{if(activeInd.source==='techFuel')return!isHidden('ev-c',tfLabel(d));if(activeInd.source==='costs')return!isHidden('ev-cost',tfLabel(d));if(activeInd.source==='trade')return d.type==='line'||!isHidden('ev-trade-p',d._partner||'');return true;})}}
                        plugins={activeInd.source==='techFuel'||activeInd.source==='costs'?[barTotalPlugin({axis:'y',color:t.muted,delta:true})]:[]}
                        options={{...cjDefaults(t),scales:{x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},maxTicksLimit:10}},y:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:activeInd.unit,color:t.muted,font:{size:8}}}},plugins:{...cjDefaults(t).plugins,legend:activeInd.source==='yearlyZone'?{display:true,labels:{color:t.muted,font:{size:9},boxWidth:8,boxHeight:6}}:{display:false},tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false,footerColor:t.lbl,footerFont:{size:10},callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw>0?'+':''}${ctx.raw?.toLocaleString?.()??ctx.raw}`,footer:barTotalFooter({axis:'y',delta:true,unit:activeInd.unit,filtered:anyHidden(activeInd.source==='techFuel'?'ev-c':activeInd.source==='costs'?'ev-cost':activeInd.source==='trade'?'ev-trade-p':'')})}}}}}
                      />
                      {activeInd.source!=='yearlyZone'&&[...cmpScenarios].filter(s=>resultsData[s]&&s!==cmpRef).length>0&&(
                        <div style={{fontSize:'0.42rem',color:t.lblMuted,marginTop:3}}>Δ vs <b style={{color:t.muted}}>{cmpRef}</b>: {baseFirst([...cmpScenarios].filter(s=>resultsData[s]&&s!==cmpRef)).join(' · ')}</div>
                      )}
                    </div>
                    {activeInd.source==='techFuel'&&makeLegend('ev-c',[...new Set(cmpEvData.datasets.map(tfLabel))].map(seriesLegendItem))}
                    {activeInd.source==='costs'&&makeLegend('ev-cost',[...new Set(cmpEvData.datasets.map(tfLabel))].map(tf=>({label:tf,color:costColor(tf)})))}
                    {activeInd.source==='trade'&&(()=>{const ps=[...new Set(cmpEvData.datasets.filter(d=>d._partner).map(d=>d._partner))].sort();const compareScs=baseFirst(scenarioList.filter(s=>cmpScenarios.has(s)&&s!==cmpRef&&resultsData[s]));return <div style={{flexShrink:0,display:'flex',flexDirection:'column',gap:6}}>{makeLegend('ev-trade-p',ps.map((p,i)=>({label:p,color:MAP_PALETTE[i%MAP_PALETTE.length]})))}{compareScs.length>1&&makeLegend('__cmp_scen__',compareScs.map((s,i)=>({label:s,color:SCEN_COLORS[(i+1)%SCEN_COLORS.length],shape:'line'})),false)}</div>;})()}
                  </div>
                :<div style={{fontSize:'0.55rem',color:t.lblMuted}}>{[...cmpScenarios].filter(s=>s!==cmpRef&&resultsData[s]).length>0?'No differences found.':'Select at least one scenario to compare.'}</div>}
              </div>
            )}
          </div>
        )}

        {/* ── DISPATCH ── */}
        {hasData&&activeTab==='dispatch'&&(
          <div style={{display:'flex',flexDirection:'column',gap:10}}>
            <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
              <select value={dispScenario||''} onChange={e=>setDispScenario(e.target.value)} style={selectStyle}>{scenarioList.map(s=><option key={s} value={s}>{s}</option>)}</select>
              <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>{allYears.map(y=><option key={y} value={y}>{y}</option>)}</select>
            </div>
            <div style={{display:'flex',flexWrap:'wrap',gap:3,alignItems:'center'}}>
              <Pill active={dispMode==='full'} onClick={()=>setDispMode('full')}>Full Year</Pill>
              {dispAvailS.map(s=><Pill key={s} active={dispMode==='season'&&dispSeason===s} onClick={()=>{setDispMode('season');setDispSeason(s);}}>{s}</Pill>)}
              {dispMode==='season'&&dispAvailD.length>0&&<><div style={{width:1,height:14,backgroundColor:t.panelBorder}}/><select value={dispDay} onChange={e=>setDispDay(e.target.value)} style={selectStyle}><option value="all">All days</option><option value="avg">Avg</option>{dispAvailD.map(d=><option key={d} value={d}>{d}</option>)}</select></>}
            </div>
            {dispResult.chartData.datasets.length>0?
              <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                <div style={{flex:1,minWidth:0}}>
                  <CJChart name={ttl('Hourly generation (MW)',activeDispZone==='__all__'?`${countryDecoded} (all zones)`:activeDispZone,dispScenario,refYear,dispMode==='full'?'Full year':ttl(dispSeason,dispDay!=='all'?`day ${dispDay}`:null))} type="bar" height={dispResult.grouped?210:165}
                    data={{...dispResult.chartData,datasets:dispResult.chartData.datasets.filter(d=>!isHidden('disp-c-tf',d.label))}}
                    plugins={dispResult.plugin?[dispResult.plugin]:[]}
                    cacheKey={`disp-c|${dispScenario}|${activeDispZone}|${refYear}|${dispMode}|${dispSeason}|${dispDay}|${theme}|${[...hiddenMap['disp-c-tf']||[]].join(',')}`}
                    options={{...cjDefaults(t),layout:{padding:{top:dispResult.grouped?18:4,bottom:dispResult.grouped?62:4}},scales:{x:{stacked:true,grid:{color:hexA(t.panelBorder,0.35),drawTicks:false},ticks:{display:!dispResult.grouped,color:t.muted,font:{size:8},maxTicksLimit:12,...(dispResult.xTicks||{})}},y:{stacked:true,grid:{color:hexA(t.panelBorder,0.35)},ticks:{color:t.muted,font:{size:9}},title:{display:true,text:'MW',color:t.muted,font:{size:8}}},yR:{type:'linear',position:'right',display:dispResult.chartData.datasets.some(d=>d.label==='Marginal cost'&&!isHidden('disp-c-tf','Marginal cost')),grid:{drawOnChartArea:false},ticks:{color:t.muted,font:{size:9}},title:{display:true,text:'$/MWh',color:t.muted,font:{size:8}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false}}}}/>
                </div>
                {makeLegend('disp-c-tf',[...dispTechs.map(legendItem),{label:'Demand',color:'#8B0000',shape:'line'},{label:'Marginal cost',color:t.isDark?'rgba(255,255,255,0.88)':'#1E3A8A',shape:'line'}])}
              </div>
            :<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>{loadingDisp?'Loading dispatch…':'No dispatch data.'}</div>}
            {scenarioList.length>1&&(
              <div style={{borderTop:`1px solid ${hexA(t.panelBorder,0.4)}`,paddingTop:10,marginTop:6,display:'flex',flexDirection:'column',gap:8}}>
                <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
                  <span style={{fontSize:'0.47rem',letterSpacing:'2px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase'}}>Δ vs ref:</span>
                  <select value={cmpRef||''} onChange={e=>pickCmpRef(e.target.value)} style={selectStyle}>{scenarioList.map(s=><option key={s} value={s}>{s}</option>)}</select>
                </div>
                {cmpRef&&cmpRef!==dispScenario&&dispDeltaResult.chartData.datasets.length>0?<>
                  <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                    <div style={{flex:1,minWidth:0}}>
                      <CJChart name={ttl('Δ hourly generation (MW)',`${dispScenario} vs ${cmpRef}`,activeDispZone==='__all__'?`${countryDecoded} (all zones)`:activeDispZone,refYear,dispMode==='full'?'Full year':ttl(dispSeason,dispDay!=='all'?`day ${dispDay}`:null))} type="bar" height={dispDeltaResult.grouped?180:130}
                        data={{...dispDeltaResult.chartData,datasets:dispDeltaResult.chartData.datasets.filter(d=>!isHidden('disp-c-tf',d.label))}}
                        plugins={dispDeltaResult.plugin?[dispDeltaResult.plugin]:[]}
                        cacheKey={`disp-c-d|${dispScenario}|${cmpRef}|${activeDispZone}|${refYear}|${dispMode}|${dispSeason}|${dispDay}|${theme}|${[...hiddenMap['disp-c-tf']||[]].join(',')}`}
                        options={{...cjDefaults(t),layout:{padding:{top:dispDeltaResult.grouped?18:4,bottom:dispDeltaResult.grouped?62:4}},scales:{x:{stacked:true,grid:{color:hexA(t.panelBorder,0.35),drawTicks:false},ticks:{display:!dispDeltaResult.grouped,color:t.muted,font:{size:8},maxTicksLimit:12,...(dispDeltaResult.xTicks||{})}},y:{stacked:true,grid:{color:hexA(t.panelBorder,0.35)},ticks:{color:t.muted,font:{size:9}},title:{display:true,text:'ΔMW',color:t.muted,font:{size:8}}},yR:{type:'linear',position:'right',display:dispDeltaResult.chartData.datasets.some(d=>d.label==='Marginal cost'&&!isHidden('disp-c-tf','Marginal cost')),grid:{drawOnChartArea:false},ticks:{color:t.muted,font:{size:9}},title:{display:true,text:'Δ$/MWh',color:t.muted,font:{size:8}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false,...deltaTooltip}}}}
                      />
                    </div>
                    {makeLegend('disp-c-tf',[...dispTechs.map(legendItem),{label:'Demand',color:'#8B0000',shape:'line'},{label:'Marginal cost',color:t.isDark?'rgba(255,255,255,0.88)':'#1E3A8A',shape:'line'}])}
                  </div>
                </>:cmpRef&&cmpRef===dispScenario?<div style={{fontSize:'0.55rem',color:t.lblMuted}}>Select a different reference scenario.</div>:<div style={{fontSize:'0.55rem',color:t.lblMuted}}>No differences found.</div>}
              </div>
            )}
          </div>
        )}

        {/* ── TRADE ── */}
        {hasData&&activeTab==='trade'&&(
          <div style={{display:'flex',flexDirection:'column',gap:14}}>
            <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
              <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>{allYears.map(y=><option key={y} value={y}>{y}</option>)}</select>
              <select value={trScenario||''} onChange={e=>setTrScenario(e.target.value)} style={selectStyle}>{scenarioList.map(s=><option key={s} value={s}>{s}</option>)}</select>
              <div style={{width:1,height:14,backgroundColor:t.panelBorder}}/>
              <ScenarioPicker t={t} all={scenarioList} selected={trScenarios} onChange={setTrScenarios}/>
            </div>
            {tradeEvData&&(()=>{const allCorridors=tradeEvData.corridors||[];const unit=tradeEvData.unit||'GWh';return<>
              <div style={{display:'flex',gap:4,alignItems:'center',flexWrap:'wrap',marginTop:4}}>
                <SectionTitle t={t}>Trade evolution by corridor</SectionTitle>
                <div style={{display:'flex',gap:3,marginLeft:'auto'}}>
                  <Pill active={trEvMetric==='volume'} onClick={()=>setTrEvMetric('volume')}>GWh</Pill>
                  <Pill active={trEvMetric==='capacity'} onClick={()=>setTrEvMetric('capacity')}>MW</Pill>
                  <Pill active={trEvMetric==='utilization'} onClick={()=>setTrEvMetric('utilization')}>Util %</Pill>
                </div>
              </div>
              <div style={{display:'flex',gap:8}}>
                <div style={{flex:1}}>
                  <CJChart name={ttl(`Trade by corridor (${tradeEvData?.unit||'GWh'})`,countryDecoded,scenList(trScenarios))} type="bar" height={180} cacheKey={`trev-c|${[...trScenarios].sort().join(',')}|${trEvMetric}|${theme}|${[...hiddenMap['trev-c']||[]].join(',')}`} data={{labels:tradeEvData.labels,datasets:tradeEvData.datasets.filter(d=>!isHidden('trev-c',d.label.includes(' — ')?d.label.split(' — ')[1]:d.label))}}
                    options={{...cjDefaults(t),scales:{x:{stacked:trEvMetric!=='utilization',grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},maxTicksLimit:10}},y:{stacked:trEvMetric!=='utilization',grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:unit,color:t.muted,font:{size:8}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>`${ctx.dataset.label}: ${fmt(ctx.parsed.y)} ${unit}`}}}}}/>
                </div>
                <div style={{width:80,flexShrink:0,display:'flex',flexDirection:'column',gap:2,paddingTop:4,maxHeight:180,overflowY:'auto'}}>
                  {allCorridors.slice(0,10).map((c,i)=>{const label=`${c.z}↔${c.z2}`;return<div key={label} onClick={()=>toggleHidden('trev-c',label)} style={{display:'flex',alignItems:'center',gap:3,cursor:'pointer',opacity:isHidden('trev-c',label)?0.25:1}}><div style={{width:9,height:9,borderRadius:2,backgroundColor:hexA(MAP_PALETTE[i%MAP_PALETTE.length],0.82),flexShrink:0}}/><span style={{fontSize:'0.4rem',color:t.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{label}</span></div>;})}
                  <div style={{fontSize:'0.38rem',color:t.lblMuted,marginTop:4,display:'flex',gap:6}}>
                    <span onClick={()=>setHiddenMap(p=>({...p,'trev-c':new Set(allCorridors.slice(0,10).map(c=>`${c.z}↔${c.z2}`))}))} style={{cursor:'pointer',textDecoration:'underline'}}>None</span>
                    <span onClick={()=>setHiddenMap(p=>({...p,'trev-c':new Set()}))} style={{cursor:'pointer',textDecoration:'underline'}}>All</span>
                  </div>
                </div>
              </div>
            </>})()}
            {scenarioList.length>1&&(
              <div style={{borderTop:`1px solid ${hexA(t.panelBorder,0.4)}`,paddingTop:10,marginTop:2,display:'flex',flexDirection:'column',gap:8}}>
                <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
                  <span style={{fontSize:'0.47rem',letterSpacing:'2px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase'}}>Δ vs ref:</span>
                  <select value={cmpRef||''} onChange={e=>pickCmpRef(e.target.value)} style={selectStyle}>{scenarioList.map(s=><option key={s} value={s}>{s}</option>)}</select>
                  <ScenarioPicker t={t} label="Compare" all={scenarioList} exclude={[cmpRef]} selected={cmpScenarios} onChange={setCmpScenarios}/>
                </div>
                {tradeCmpDeltaData&&tradeCmpDeltaData.datasets.length>0?
                  <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                    <div style={{flex:1,minWidth:0}}>
                      <CJChart name={ttl(`Δ trade by corridor (${tradeEvData?.unit||'GWh'}) vs ${cmpRef}`,countryDecoded,scenList(cmpScenarios))} type="bar" height={200}
                        cacheKey={`trev-c-d|${[...trScenarios].sort().join(',')}|${cmpRef}|${[...cmpScenarios].sort().join(',')}|${trEvMetric}|${theme}|${[...hiddenMap['trev-c']||[]].join(',')}`}
                        data={{labels:tradeCmpDeltaData.labels,datasets:tradeCmpDeltaData.datasets}}
                        options={{...cjDefaults(t),scales:{x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},maxTicksLimit:10}},y:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:`Δ${tradeCmpDeltaData.unit||'GWh'}`,color:t.muted,font:{size:8}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false,callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw>0?'+':''}${ctx.raw?.toLocaleString?.()}`}}}}}
                      />
                    </div>
                    {(()=>{const allCorridors=tradeEvData?.corridors||[];return makeLegend('trev-c',allCorridors.slice(0,10).map((c,i)=>({label:`${c.z}↔${c.z2}`,color:hexA(MAP_PALETTE[i%MAP_PALETTE.length],0.82)})));})()}
                  </div>
                :<div style={{fontSize:'0.55rem',color:t.lblMuted}}>{[...cmpScenarios].filter(s=>s!==cmpRef&&resultsData[s]).length>0?'No corridor differences found.':'Select at least one scenario to compare.'}</div>}
              </div>
            )}
            {/* External trade ($m) with non-modelled neighbours */}
            {extTradeData&&(
              <div style={{borderTop:`1px solid ${hexA(t.panelBorder,0.4)}`,paddingTop:10,marginTop:2,display:'flex',flexDirection:'column',gap:6}}>
                <SectionTitle t={t}>External trade with neighbours — {extTradeData.scen}</SectionTitle>
                <div style={{fontSize:'0.42rem',color:t.lblMuted,marginTop:-2}}>Aggregate value of exchanges with external (non-modelled) zones. EPM reports totals, not per-neighbour flows.</div>
                <CJChart name={ttl('External trade with neighbours',countryDecoded,extTradeData.scen)} type="bar" height={190}
                  cacheKey={`exttr-c|${extTradeData.scen}|${theme}`}
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
          </div>
        )}

        {/* ── PLANTS ── */}
        {hasData&&activeTab==='plants'&&(
          <div style={{display:'flex',flexDirection:'column',gap:14}}>
            <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
              <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>{allYears.map(y=><option key={y} value={y}>{y}</option>)}</select>
              <select value={plScenario||''} onChange={e=>setPlScenario(e.target.value)} style={selectStyle}>{scenarioList.map(s=><option key={s} value={s}>{s}</option>)}</select>
              <select value={plIndicator} onChange={e=>setPlIndicator(e.target.value)} style={selectStyle}>{['CapacityPlant','EnergyPlant','CostsPlant','PlantAnnualLCOE','UtilizationPlant'].map(k=><option key={k} value={k}>{k.replace('Plant','').replace(/([A-Z])/g,' $1').trim()}</option>)}</select>
              <select value={plTopN} onChange={e=>setPlTopN(+e.target.value)} style={selectStyle}>{[10,15,20,30].map(n=><option key={n} value={n}>Top {n}</option>)}</select>
              {allZones.length>1&&<select value={plZone} onChange={e=>setPlZone(e.target.value)} style={selectStyle}><option value="all">All zones</option>{allZones.map(z=><option key={z} value={z}>{z}</option>)}</select>}
            </div>
            {plantsData.length>0?<><SectionTitle t={t}>Top {plTopN} plants ({plUnit})</SectionTitle><CJChart name={ttl(`Top ${plTopN} plants`,plIndicator.replace('Plant','').replace(/([A-Z])/g,' $1').trim(),plZone!=='all'?plZone:countryDecoded,plScenario,refYear)} type="bar" height={Math.min(plantsData.length*18+24,250)} cacheKey={`pl-c|${plScenario}|${refYear}|${plIndicator}|${plTopN}|${theme}`} data={{labels:plantsData.map(p=>p.g),datasets:[{data:plantsData.map(p=>+p.value.toFixed(2)),backgroundColor:plantsData.map(p=>hexA(techColor(p.techfuel),0.8)),borderWidth:0,barThickness:12}]}} options={{...cjDefaults(t),indexAxis:'y',scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:plUnit,color:t.muted,font:{size:8}}},y:{grid:{display:false},ticks:{color:t.muted,font:{size:8}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>{const e=plantsData[ctx.dataIndex],head=`${plantFmt(ctx.parsed.x)} ${plUnit}`;return e&&e.parts.length>1?[head,...e.parts.map(q=>`  ${q.cat}: ${plantFmt(q.value)}`)]:head;}}}}}}/></>:<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>No plant data.</div>}
            {lcoeData&&lcoeData.datasets.length>0&&<>
              <SectionTitle t={t}>Annual LCOE vs Utilization — bubble size = capacity</SectionTitle>
              <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                <div style={{flex:1,minWidth:0}}>
                  <CJChart name={ttl('Annual LCOE vs utilization',plZone!=='all'?plZone:countryDecoded,plScenario,refYear)} type="bubble" height={230} cacheKey={`lcoe-c|${plScenario}|${refYear}|${theme}|${[...hiddenMap['lcoe-c']||[]].join(',')}`}
                    data={{...lcoeData,datasets:lcoeData.datasets.filter(ds=>!isHidden('lcoe-c',ds.label))}}
                    options={{...cjDefaults(t),plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>{const d=ctx.raw;return[`${d._plant||ctx.dataset.label}`,`LCOE: ${d.y} $/MWh · Util: ${d.x.toFixed(0)}%`,d._cap?`Cap: ${fmt(d._cap)} MW`:''].filter(Boolean);}}}},scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9}},title:{display:true,text:'Utilization (%)',color:t.muted,font:{size:9}},min:0,suggestedMax:105},y:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9}},title:{display:true,text:'LCOE (USD/MWh)',color:t.muted,font:{size:9}},min:0}}}}/>
                </div>
                {makeLegend('lcoe-c',lcoeData.datasets.map(ds=>({label:ds.label,color:ds.backgroundColor,shape:'circle'})))}
              </div>
            </>}
          </div>
        )}
        {hasData&&activeTab==='summary'&&summaryData&&(()=>{
          const{allSc,ref,nonRef,data,lastY}=summaryData;
          const hasGen=allSc.some(s=>visZones.some(z=>Object.keys(resultsData[s]?.techFuel[z]?.GenerationTechFuel?.[lastY]||{}).length>0));

          // ── The country's share of the objective, discounted on the model's own year
          // factors (utils/npv). The check is necessarily system-wide -- the model writes
          // one NPV for the whole system, not one per country -- so a gap in it (a missing
          // capex column, typically, or internal trade a pre-fix report did not net) cannot
          // be placed in any one country. Every scenario is drawn, and npvCheckNotes says
          // under the tables which ones carry such a gap.
          const npvOk  = s=>!!npvCountry[s];
          const nRef   = npvOk(ref)?npvCountry[ref]:null;
          const hasNpv = !!nRef;
          const nCols  = hasNpv?baseFirst(allSc.filter(s=>s!==ref&&summaryScen.has(s)&&npvOk(s))):[];
          const byZ    = npvSplit==='zone'&&visZones.length>1;
          const dScen  = Object.fromEntries(nCols.map(s=>[s,npvDelta(nRef.comps,npvCountry[s].comps)]));
          const dZone  = Object.fromEntries(nCols.map(s=>[s,Object.fromEntries(visZones.map(z=>[z,npvDelta(nRef.byZone[z],npvCountry[s].byZone[z])]))]));
          const netOf  = s=>nRef.total-npvCountry[s].total;
          // Two lists: the levels table shows what the scenarios cost this country, the
          // chart and the Δ table show what moved, and a component can be large in one
          // and flat in the other.
          const compsL = hasNpv?visibleComps([nRef.comps,...nCols.map(s=>npvCountry[s].comps)]):[];
          const comps  = hasNpv&&nCols.length?visibleComps(byZ?nCols.flatMap(s=>visZones.map(z=>dZone[s][z])):nCols.map(s=>dScen[s])):[];
          const bn     = v=>v==null||!Number.isFinite(v)?'—':`${v>0?'+':v<0?'-':''}${(Math.abs(v)/1000).toFixed(2)}`;
          const npvChart = !comps.length?null:byZ?{
            labels:visZones,
            datasets:nCols.flatMap((s,si)=>comps.map(c=>({
              label:nCols.length>1?`${s} — ${c.label}`:c.label,
              data:visZones.map(z=>+((dZone[s][z][c.key]||0)/1000).toFixed(3)),
              backgroundColor:hexA(c.color,nCols.length>1?0.62:0.85),borderColor:c.color,borderWidth:nCols.length>1?1:0,
              stack:s,_si:si,
            })).filter(d=>d.data.some(v=>v!==0))),
            net:nCols.map((s,si)=>({si,data:visZones.map(z=>+(Object.values(dZone[s][z]).reduce((a,b)=>a+b,0)/1000).toFixed(3)),color:t.lbl})),
          }:{
            labels:nCols,
            datasets:comps.map(c=>({label:c.label,data:nCols.map(s=>+((dScen[s][c.key]||0)/1000).toFixed(3)),backgroundColor:hexA(c.color,0.85),borderWidth:0,stack:'d',_si:0})),
            net:[{si:0,data:nCols.map(s=>+(netOf(s)/1000).toFixed(3)),color:t.lbl}],
          };
          const npvNotes = [
            hasNpv&&nCols.length
              ? `Every component is a discounted cost, so a difference is ${ref} minus the scenario: positive means the scenario spends less on that line, which is a benefit.`
              : null,
            hasNpv
              ? `Discounted on the model's own year factors. The totals are ${countryDecoded}'s share of the system NPV. The model never reports that share on its own, so each scenario's whole decomposition is checked against the model's NPV.`
              : null,
            ...(hasNpv?npvCheckNotes(npvSystemData.byScen,[ref,...nCols]):[]),
            hasNpv&&[ref,...nCols].some(s=>!npvCountry[s].hasCapex)
              ? 'Generation capex is missing for at least one scenario shown, so its bar and total are incomplete.' : null,
            hasNpv&&[ref,...nCols].every(s=>!npvCountry[s].hasExternal)
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
            :(key==='__total'?npvCountry[scen].total:(npvCountry[scen].comps[key]||0));
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
                  <td style={{...ls,fontWeight:700,color:t.lbl}}>{delta?'Net benefit (avoided cost)':`Net present cost · ${countryDecoded}`}</td>
                  {cols.map(s=>{const v=npvVal(s,'__total',delta);
                    return<td key={s} style={{...cs,fontWeight:700,color:t.lbl,backgroundColor:delta?dBg(v,true):'transparent'}}>{fmt(v,0)}</td>;})}
                  <td/>
                </tr>
                {!delta&&<tr>
                  <td style={{...ls,fontSize:'0.44rem',color:t.lblMuted}}>System NPV (whole model)</td>
                  {cols.map(s=><td key={s} style={{...cs,fontSize:'0.44rem',color:t.lblMuted}}>{fmt(npvCountry[s].modelTotal,0)}</td>)}
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
                  {visZones.length>1&&<>
                    <div style={{width:1,height:14,backgroundColor:t.panelBorder}}/>
                    <Pill active={!byZ} onClick={()=>setNpvSplit('scenario')}>By scenario</Pill>
                    <Pill active={byZ}  onClick={()=>setNpvSplit('zone')}>By zone</Pill>
                  </>}
                </>}
                <span style={{fontSize:'0.4rem',color:t.lblMuted,marginLeft:8}}>Period: {allYears[0]}–{lastY} · {allYears.length} yrs · {visZones.length} zone{visZones.length>1?'s':''}</span>
              </div>

              {hasNpv?<>
                {/* The headline: what the scenario saves this country against the reference. */}
                {nCols.length>0&&<div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                  {nCols.map(s=>{
                    const n=npvCountry[s],d=netOf(s),good=d>0;
                    const col=good?'#34C759':'#FF3B30';
                    return<div key={s} style={{flex:'1 1 132px',minWidth:132,padding:'7px 9px',borderRadius:4,border:`1px solid ${t.panelBorder}`,backgroundColor:hexA(col,0.06)}}>
                      <div style={{fontSize:'0.44rem',letterSpacing:'1px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{s}</div>
                      <div style={{fontSize:'0.78rem',fontWeight:700,color:col,lineHeight:1.25}}>{bn(d)}
                        <span style={{fontSize:'0.42rem',fontWeight:400,color:t.muted,marginLeft:3}}>bn$ benefit</span></div>
                      <div style={{fontSize:'0.4rem',color:t.lblMuted}}>cost NPV {fmt(nRef.total,0)} − {fmt(n.total,0)}</div>
                      {!n.hasCapex&&<div style={{fontSize:'0.4rem',color:'#FF9500',marginTop:2}}>⚠ capex missing</div>}
                    </div>;
                  })}
                </div>}

                <div>
                  <SectionTitle t={t}>{`Benefit for ${countryDecoded} vs ${ref}  ·  avoided cost NPV = ${ref} − scenario  ·  bn$`}</SectionTitle>
                  {npvChart&&npvChart.datasets.length?
                    <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                      {byZ&&nCols.length>1&&<ScenarioKey t={t} scenarios={nCols}/>}
                      <div style={{flex:1,minWidth:0}}>
                        <CJChart name={ttl(`Benefit vs ${ref} (bn$)`,countryDecoded,byZ?'by zone':'by scenario',scenList(nCols))} type="bar" height={240}
                          cacheKey={`npv-c|${ref}|${npvSplit}|${theme}|${nCols.join(',')}|${visZones.join(',')}|${[...hiddenMap['npv-comp-c']||[]].join(',')}`}
                          plugins={[buildNetDotPlugin(npvChart.net),byZ?makeScenPlugin(nCols,t.muted):null].filter(Boolean)}
                          data={{labels:npvChart.labels,datasets:npvChart.datasets.filter(d=>!isHidden('npv-comp-c',tfLabel(d)))}}
                          options={{...cjDefaults(t),datasets:{bar:{barPercentage:0.72}},scales:{
                            x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},maxRotation:30,padding:byZ&&nCols.length>1?16:2}},
                            y:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:9}},title:{display:true,text:'bn$ (discounted)',color:t.muted,font:{size:8}}},
                          },plugins:{...cjDefaults(t).plugins,legend:{display:false},tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false,callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw>0?'+':''}${ctx.raw} bn$`}}}}}
                        />
                        <div style={{fontSize:'0.4rem',color:t.lblMuted,marginTop:3,display:'flex',alignItems:'center',gap:4}}>
                          <span style={{display:'inline-block',width:7,height:7,borderRadius:'50%',backgroundColor:t.lbl}}/>net benefit
                        </div>
                      </div>
                      {makeLegend('npv-comp-c',comps.map(c=>({label:c.label,color:c.color})))}
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
            </div>
          );
        })()}
      </div>
    </div>
  );
}
