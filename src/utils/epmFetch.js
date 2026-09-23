// --- Data source ---
// Model inputs and results come from the public EPM repo on GitHub, one branch per
// published region.
const GITHUB_RAW  = 'https://raw.githubusercontent.com/ESMAP-World-Bank-Group/EPM';
function rawBase() { return GITHUB_RAW; }

/** Public URL of a repo file.
 *  `path` is relative to the repo root, e.g. 'epm/input/data_x/supply/pGenDataInput.csv'.
 *  Use this for download links too, so every link follows the one data source. */
export function rawFileUrl(branch, path) {
  return `${rawBase(branch)}/${branch}/${path}`;
}

/** Public URL of a result CSV: {outputDir}/{simRun}/{scenario}/output_csv/{filename} */
export function resultCsvUrl(branch, simRun, scenario, filename, outputDir = 'epm/output') {
  return rawFileUrl(branch, `${outputDir}/${simRun}/${scenario}/output_csv/${filename}`);
}

const API_BASE = 'https://api.github.com/repos/ESMAP-World-Bank-Group/EPM';

// ── Results: GitHub Contents API ──────────────────────────────────────────────

/** List files/dirs at path in branch. Returns [{ name, type }] or null. */
export async function fetchGitHubDir(branch, path) {
  const url = `${API_BASE}/contents/${path}?ref=${branch}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/vnd.github.v3+json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** List all data_* input folders in a branch (excluding data_test).
 *  Label = folder name with 'data_' prefix stripped.
 *  The defaultFolder is always first. Falls back to [{id:defaultFolder, label}] on error. */
export async function fetchDataFolderList(branch, defaultFolder) {
  const strip = n => n.replace(/^data_/, '');
  const items = await fetchGitHubDir(branch, 'epm/input');
  if (!items) return [{ id: defaultFolder, label: strip(defaultFolder) }];
  const folders = items
    .filter(i => i.type === 'dir' && /^data_/.test(i.name) && i.name !== 'data_test')
    .map(i => ({ id: i.name, label: strip(i.name) }))
    .sort((a, b) => (a.id === defaultFolder ? -1 : b.id === defaultFolder ? 1 : a.id.localeCompare(b.id)));
  return folders.length ? folders : [{ id: defaultFolder, label: strip(defaultFolder) }];
}

/** List zcmap*.csv stems in a data folder (e.g. ['zcmap', 'zcmap_alt']).
 *  Falls back to ['zcmap'] if the directory is unreachable. */
export async function fetchZcmapList(branch, dataFolder) {
  const items = await fetchGitHubDir(branch, `epm/input/${dataFolder}`);
  const names = (items || [])
    .filter(f => f.type === 'file' && /^zcmap.*\.csv$/i.test(f.name))
    .map(f => f.name.slice(0, -4));
  names.sort((a, b) => a === 'zcmap' ? -1 : b === 'zcmap' ? 1 : a.localeCompare(b));
  return names.length ? names : ['zcmap'];
}

/** Results live under epm/output_view (curated) if present, else epm/output (legacy).
 *  Resolved once per page load from the branch's GitHub tree, then threaded through. */
export async function resolveOutputDir(branch) {
  const items = await fetchGitHubDir(branch, 'epm/output_view');
  const hasRuns = (items || []).some(i => i.type === 'dir');
  return hasRuns ? 'epm/output_view' : 'epm/output';
}

/** List result run folder names in a branch. Returns string[] (unsorted), or null
 *  when the listing could not be read at all.
 *
 *  Lists the output dir via the GitHub Contents API. The null is the point: a host
 *  a network refuses to reach and a branch with nothing published look identical
 *  from here, and telling a user to publish results that are already published sends
 *  them the wrong way. Callers distinguish the two in what they put on screen. */
export async function fetchRunList(branch, outputDir) {
  const items = await fetchGitHubDir(branch, outputDir);
  if (!items) return null;
  return items.filter(i => i.type === 'dir').map(i => i.name);
}

/** The result CSVs a merged publish writes. This is a last resort, not a listing:
 *  a run is free to write more (older runs write ~55 files) or fewer, so every
 *  name here is probed before it is offered. */
const MERGED_RESULT_FILES = [
  'pCapexInvestmentMerged.csv', 'pCostsMerged.csv', 'pDispatchComplete.csv',
  'pEnergyBalance.csv', 'pHourlyPrice.csv', 'pNetPresentCostSystemMerged.csv', 'pPlantMerged.csv',
  'pSettings.csv', 'pSummary.csv', 'pTechFuelMerged.csv',
  'pTransmissionMerged.csv', 'pYearlyZoneMerged.csv',
];

/** Which of the fallback names this run actually wrote. A HEAD that the host
 *  refuses to answer is not evidence of a missing file, so it keeps the name --
 *  better a picker entry that turns out empty than a file silently hidden. */
async function probeResultFiles(branch, outputDir, simRun, scenario) {
  const hits = await Promise.all(MERGED_RESULT_FILES.map(async (name) => {
    try {
      const res = await fetch(resultCsvUrl(branch, simRun, scenario, name, outputDir), { method: 'HEAD' });
      return res.ok ? name : null;
    } catch { return name; }
  }));
  return hits.filter(Boolean).sort();
}

/** The result CSVs one run/scenario holds: the GitHub Contents API listing, or,
 *  when that can't be read, a probe of the merged catalogue.
 *
 *  Returns [] only when the run genuinely exposes nothing.
 */
export async function fetchOutputFileList(branch, outputDir, simRun, scenario) {
  if (!branch || !outputDir || !simRun || !scenario) return [];
  const items = await fetchGitHubDir(branch, `${outputDir}/${simRun}/${scenario}/output_csv`);
  if (items) {
    return items.filter(i => i.type === 'file' && /\.csv$/i.test(i.name)).map(i => i.name).sort();
  }
  return probeResultFiles(branch, outputDir, simRun, scenario);
}

/** Byte size the host reports for a URL, or null when it will not say.
 *  Used to keep a 121 MB dispatch file from being opened by accident. */
export async function fetchFileSize(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    if (!res.ok) return null;
    const n = parseInt(res.headers.get('content-length') || '', 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

/** Fetch a result CSV: {outputDir}/{simRun}/{scenario}/output_csv/{filename} */
export async function fetchResultCSV(branch, simRun, scenario, filename, outputDir = 'epm/output') {
  const url = resultCsvUrl(branch, simRun, scenario, filename, outputDir);
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return parseCSV(await res.text());
  } catch { return null; }
}

/** Fetch dispatch rows for ONE year. pDispatchComplete is split per year at
 *  publish (pDispatchComplete/y{year}.csv) to stay small & fluid in the browser;
 *  falls back to the full unsplit CSV for runs published before the split. */
export async function fetchDispatchYear(branch, simRun, scenario, year, outputDir = 'epm/output') {
  const split = await fetchResultCSV(branch, simRun, scenario, `pDispatchComplete/y${year}.csv`, outputDir);
  if (split) return split;
  return fetchResultCSV(branch, simRun, scenario, 'pDispatchComplete.csv', outputDir);
}

// ── Result processors ─────────────────────────────────────────────────────────

/** pTechFuelMerged → { zone: { attribute: { year: { techfuel: val } } } } */
export function processTechFuel(rows) {
  if (!rows?.length) return {};
  const out = {};
  for (const r of rows) {
    const z = r.z || r.zone || ''; const attr = r.attribute || '';
    const y = String(r.y || '').trim(); const tf = r.techfuel || r.tech || '';
    const val = parseFloat(r.value) || 0;
    if (!z || !attr || !y || !tf) continue;
    if (!out[z]) out[z] = {};
    if (!out[z][attr]) out[z][attr] = {};
    if (!out[z][attr][y]) out[z][attr][y] = {};
    out[z][attr][y][tf] = (out[z][attr][y][tf] || 0) + val;
  }
  return out;
}

/** pYearlyZoneMerged → { zone: { attribute: { year: val } } } */
export function processYearlyZone(rows) {
  if (!rows?.length) return {};
  const out = {};
  for (const r of rows) {
    const z = r.z || r.zone || ''; const attr = r.attribute || '';
    const y = String(r.y || '').trim(); const val = parseFloat(r.value) || 0;
    if (!z || !attr || !y) continue;
    if (!out[z]) out[z] = {};
    if (!out[z][attr]) out[z][attr] = {};
    out[z][attr][y] = (out[z][attr][y] || 0) + val;
  }
  return out;
}

/** pEnergyBalance → { zone: { item: { year: val } } }, item being the `uni` column
 *  ('Unmet demand: GWh', 'Imports exchange: GWh', …). This is the only annual file
 *  that carries unmet demand — pYearlyZoneMerged has no attribute for it. */
export function processEnergyBalance(rows) {
  if (!rows?.length) return {};
  const out = {};
  for (const r of rows) {
    const z = r.z || r.zone || ''; const item = r.uni || '';
    const y = String(r.y || '').replace('.0', '').trim();
    const val = parseFloat(r.value) || 0;
    if (!z || !item || !y) continue;
    if (!out[z]) out[z] = {};
    if (!out[z][item]) out[z][item] = {};
    out[z][item][y] = (out[z][item][y] || 0) + val;
  }
  return out;
}

/** pDispatchComplete → { zone: { year: { q: { d: { t: { techfuel: val } } } } } } */
export function processDispatchResults(rows) {
  if (!rows?.length) return {};
  const out = {};
  for (const r of rows) {
    const z = r.z || r.zone || ''; const y = String(r.y || '').trim();
    const q = r.q || ''; const d = r.d || '';
    const tt = (r.t||'').replace(/^(t)0+(\d)/,'$1$2'); const tf = r.uni || r.techfuel || r.tech || '';
    const val = parseFloat(r.value) || 0;
    if (!z || !y || !q || !d || !tt || !tf) continue;
    if (!out[z]) out[z] = {};
    if (!out[z][y]) out[z][y] = {};
    if (!out[z][y][q]) out[z][y][q] = {};
    if (!out[z][y][q][d]) out[z][y][q][d] = {};
    if (!out[z][y][q][d][tt]) out[z][y][q][d][tt] = {};
    out[z][y][q][d][tt][tf] = (out[z][y][q][d][tt][tf] || 0) + val;
  }
  return out;
}

/** pHourlyPrice → { zone: { year: { q: { d: { t: val } } } } } */
export function processHourlyPrice(rows) {
  if (!rows?.length) return {};
  const out = {};
  for (const r of rows) {
    const z = r.z || r.zone || ''; const y = String(r.y || '').trim();
    const q = r.q || ''; const d = r.d || '';
    const tt = (r.t||'').replace(/^(t)0+(\d)/,'$1$2'); const val = parseFloat(r.value) || 0;
    if (!z || !y || !q || !d || !tt) continue;
    if (!out[z]) out[z] = {};
    if (!out[z][y]) out[z][y] = {};
    if (!out[z][y][q]) out[z][y][q] = {};
    if (!out[z][y][q][d]) out[z][y][q][d] = {};
    out[z][y][q][d][tt] = val;
  }
  return out;
}

/** pTransmissionMerged → { z: { z2: { attribute: { year: val } } } } */
export function processTransmissionResults(rows) {
  if (!rows?.length) return {};
  const out = {};
  for (const r of rows) {
    const z    = r.z || '';
    const z2   = r.z2 || r.uni || '';
    const attr = r.attribute || '';
    const y    = String(r.y || '').trim();
    const val  = parseFloat(r.value) || 0;
    if (!z || !z2 || !attr || !y) continue;
    if (!out[z])       out[z]       = {};
    if (!out[z][z2])   out[z][z2]   = {};
    if (!out[z][z2][attr]) out[z][z2][attr] = {};
    out[z][z2][attr][y] = (out[z][z2][attr][y] || 0) + val;
  }
  return out;
}

/** pCostsMerged → { zone: { category: { year: val } } } (attribute='Costs', uni=category) */
export function processCosts(rows) {
  if (!rows?.length) return {};
  const out = {};
  for (const r of rows) {
    const z   = r.z || '';
    const cat = r.uni || '';
    const y   = String(r.y || '').replace('.0','').trim();
    const val = parseFloat(r.value) || 0;
    if (!z || !cat || !y || r.attribute !== 'Costs') continue;
    if (!out[z]) out[z] = {};
    if (!out[z][cat]) out[z][cat] = {};
    out[z][cat][y] = (out[z][cat][y] || 0) + val;
  }
  return out;
}

/** pPlantMerged → [{ g, z, c, techfuel, attribute, cat, year, value }]
 *
 *  `cat` is the cost category CostsPlant is broken down by, read off the `uni`
 *  column and stripped of the unit it carries after the colon ('Fixed O&M: $m'
 *  becomes 'Fixed O&M'). It is empty for every other attribute, which the model
 *  writes once per plant and year. Without it a plant's cost is four unlabelled
 *  rows that no consumer can add back together. */
export function processPlants(rows) {
  if (!rows?.length) return [];
  return rows.map(r => ({
    g:         r.g || '',
    z:         r.z || '',
    c:         r.c || '',
    techfuel:  r.techfuel || r.tech || '',
    attribute: r.attribute || '',
    cat:       String(r.uni || '').replace(/\s*:\s*[^:]*$/, '').trim(),
    y:         String(r.y || ''),
    value:     parseFloat(r.value) || 0,
  })).filter(r => r.g && r.attribute && r.y);
}

/** Extract sorted unique years from processTechFuel or processYearlyZone output */
export function resultYears(data) {
  const ys = new Set();
  for (const attrs of Object.values(data))
    for (const yrs of Object.values(attrs))
      if (typeof yrs === 'object' && !Array.isArray(yrs))
        for (const y of Object.keys(yrs)) ys.add(y);
  return [...ys].sort();
}

/** Collect all techfuel names from dispatch or techFuel data */
export function collectTechfuels(data) {
  const tfs = new Set();
  for (const z of Object.values(data))
    for (const a of Object.values(z))
      for (const y of Object.values(a))
        if (typeof y === 'object') for (const tf of Object.keys(y)) tfs.add(tf);
  return [...tfs].filter(t => t !== 'Demand').sort();
}

function stripBOM(s) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

function parseCSV(text) {
  const lines = stripBOM(text).trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = line.split(',');
    return Object.fromEntries(headers.map((h, i) => [h, (vals[i] ?? '').trim()]));
  });
}

async function fetchJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** Fetch a map layer, run folder first.
 *  A run writes the zones it actually solved next to its input_scenarios.csv, so
 *  that pair describes the map the results belong to. Runs published before EPM
 *  did that -- and models that can no longer be re-run -- have only the pair
 *  committed in the input folder, which is why the fallback stays.
 *  `run` is { outputDir, simRun }; omit it on the input pages, which have no run. */
async function fetchMapLayer(branch, dataFolder, name, run) {
  const base = `${rawBase(branch)}/${branch}`;
  if (run?.outputDir && run?.simRun) {
    const fromRun = await fetchJSON(`${base}/${run.outputDir}/${run.simRun}/${name}`);
    if (fromRun) return fromRun;
  }
  return fetchJSON(`${base}/epm/input/${dataFolder}/${name}`);
}

export async function fetchLinestringGeoJSON(branch, dataFolder, stem = null, run = null) {
  const name = stem ? `linestring_${stem}.geojson` : 'linestring_countries.geojson';
  const gj = await fetchMapLayer(branch, dataFolder, name, run);
  if (gj) return gj;
  return stem ? fetchLinestringGeoJSON(branch, dataFolder, null, run) : null;
}

export async function fetchZonesGeoJSON(branch, dataFolder, stem = null, run = null) {
  const name = stem ? `zones_${stem}.geojson` : 'zones.geojson';
  const gj = await fetchMapLayer(branch, dataFolder, name, run);
  if (gj) return gj;
  return stem ? fetchZonesGeoJSON(branch, dataFolder, null, run) : null;
}

/** Fetch scenario names from {outputDir}/{simRun}/input_scenarios.csv (first row, cols after paramNames). */
export async function fetchInputScenarios(branch, outputDir, simRun) {
  const url = `${rawBase(branch)}/${branch}/${outputDir}/${simRun}/input_scenarios.csv`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const text = await res.text();
    const firstLine = text.split('\n')[0] || '';
    const cols = firstLine.split(',').map(c => c.trim()).filter(Boolean);
    return cols.slice(1); // drop 'paramNames' header
  } catch { return null; }
}

/** Fetch a CSV written at the ROOT of a run, beside input_scenarios.csv, rather than in
 *  one scenario's output_csv. Two of those matter: summary.csv, which is the only place
 *  the generation capex annuities are reported (all scenarios in columns), and the
 *  optional npv_external.csv a study publishes for costs the model never priced.
 *  Returns null when the run does not carry the file -- both are optional. */
export async function fetchRunRootCSV(branch, outputDir, simRun, filename) {
  if (!branch || !outputDir || !simRun) return null;
  const url = `${rawBase(branch)}/${branch}/${outputDir}/${simRun}/${filename}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return parseCSV(await res.text());
  } catch { return null; }
}

export async function fetchZonesExtGeoJSON(branch, dataFolder) {
  const url = `${rawBase(branch)}/${branch}/epm/input/${dataFolder}/zones_ext.geojson`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** Areas inside the modelled countries that belong to no zone (see utils/offgridZones).
 *  Optional: models without the file get null, and no layer is drawn. */
export async function fetchZonesOffgridGeoJSON(branch, dataFolder) {
  const url = `${rawBase(branch)}/${branch}/epm/input/${dataFolder}/zones_offgrid.geojson`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export async function fetchEpmCSV(branch, dataFolder, relPath) {
  const url = `${rawBase(branch)}/${branch}/epm/input/${dataFolder}/${relPath}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return parseCSV(await res.text());
  } catch {
    return null;
  }
}

/** Fetch a raw input file as text (for config.csv / scenarios.csv parsing). */
export async function fetchEpmText(branch, dataFolder, relPath) {
  const url = `${rawBase(branch)}/${branch}/epm/input/${dataFolder}/${relPath}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// Map EPM fuel names → canonical key matching FUEL_COLORS in constants.js
const FUEL_MAP = {
  water: 'hydro', ror: 'hydro', reservoirhydro: 'hydro', pumpedhydro: 'hydro',
  solar: 'solar', pv: 'solar', rpv: 'solar', csp: 'solar', cspplant: 'solar',
  wind: 'wind', windonshore: 'wind', windoffshore: 'wind', onshorewind: 'wind', offshorewind: 'wind',
  gas: 'gas', naturalgas: 'gas', lng: 'gas', ocgt: 'gas', ccgt: 'gas', ocgtccs: 'gas', ccgtccs: 'gas', methane: 'gas',
  coal: 'coal', domesticcoal: 'coal', importedcoal: 'coal',
  nuclear: 'nuclear', uranium: 'nuclear',
  oil: 'oil', hfo: 'oil', fueloil: 'oil', lightfueloil: 'oil',
  biomass: 'biomass', biomasswaste: 'biomass', biomassplant: 'biomass',
  geothermal: 'geothermal',
  ice: 'diesel', diesel: 'diesel',
  waste: 'waste',
  biogas: 'biogas',
};

export function normalizeFuel(raw) {
  const k = (raw || '').toLowerCase().replace(/[^a-z]/g, '');
  return FUEL_MAP[k] || k || 'other';
}

export const EPM_FUEL_COLORS = {
  hydro:      '#1E9AF5',
  solar:      '#FFD700',
  wind:       '#44DAEC',
  gas:        '#9A7040',
  coal:       '#808890',
  nuclear:    '#C8A8F0',
  oil:        '#7A7068',
  biomass:    '#52C860',
  geothermal: '#D4A820',
  diesel:     '#6A7888',
  waste:      '#8A9098',
  biogas:     '#72DC8A',
  other:      '#AAAAAA',
};

export const STATUS_LABEL = { 1: 'Existing', 2: 'Committed', 3: 'Candidate' };

// ── Column-name helpers (EPM models use inconsistent headers) ─────────────────

/** Read zone ID — tolerates z, zone, Zone */
function rZone(r)    { return r.z    || r.zone  || r.Zone  || ''; }
/** Read season — tolerates season, q, Q, m */
function rSeason(r)  { return r.season || r.q   || r.Q    || r.m  || ''; }
/** Read daytype — tolerates daytype, d, D */
function rDaytype(r) { return r.daytype || r.d  || r.D    || ''; }
/** Read hourly value at index i (1-based) — tolerates t01 and t1 */
function rT(r, i) {
  return parseFloat(r[`t${String(i).padStart(2,'0')}`] || r[`t${i}`] || 0) || 0;
}

// ── Processors ───────────────────────────────────────────────────────────────

export function processGenData(rows) {
  return rows.map(r => {
    const status   = parseInt(r.Status || r.status || '0');
    const capacity = parseFloat(r.Capacity || r.capacity || '0') || 0;
    if (capacity <= 0 || status < 1 || status > 3) return null;
    return {
      g:        r.g || '',
      zone:     rZone(r),
      tech:     r.tech || '',
      fuel:     normalizeFuel(r.fuel || r.f || r.tech || ''),
      fuelRaw:  r.fuel || r.f || '',
      status,
      capacity,
      stYr:     parseInt(r.StYr || r.stYr || '0') || null,
      retrYr:   parseInt(r.RetrYr || r.retrYr || '0') || null,
      heatRate: parseFloat(r.HeatRate || r.heatRate || '0') || null,
      capex:    parseFloat(r.Capex || r.capex || '0') || null,
      fom:      parseFloat(r.FOMperMW || r.fomPerMW || '0') || null,
      vom:      parseFloat(r.VOM || r.vom || '0') || null,
    };
  }).filter(Boolean);
}

/** Average hourly demand profile per zone: { zone: [h1avg..h24avg] } (values 0-1) */
export function processDemandProfile(rows) {
  if (!rows?.length) return {};
  const byZone = {};
  for (const r of rows) {
    const z = r.z;
    if (!byZone[z]) byZone[z] = { sum: new Array(24).fill(0), count: 0 };
    for (let h = 1; h <= 24; h++) byZone[z].sum[h - 1] += parseFloat(r[`t${h}`]) || 0;
    byZone[z].count++;
  }
  const result = {};
  for (const [z, d] of Object.entries(byZone))
    result[z] = d.sum.map(v => v / d.count);
  return result;
}

/** Returns { zone, type ('peak'|'energy'), years: { '2024': val, ... } }[] */
export function processDemand(rows) {
  if (!rows?.length) return [];
  const yearCols = Object.keys(rows[0]).filter(k => /^\d{4}$/.test(k));
  return rows.map(r => ({
    zone: rZone(r),
    type: (r.type || '').toLowerCase(),
    years: Object.fromEntries(yearCols.map(y => [y, parseFloat(r[y]) || 0])),
  }));
}

/** Hours per block: { season: { daytype: [h1, h2, ...] } }.
 *  processHours() assumes every block of a row carries the same weight; older
 *  folders (EPM v7.9 style, e.g. data_casa_2020) give one duration per block. */
export function processHoursBlocks(rows) {
  if (!rows?.length) return {};
  const tCols = Object.keys(rows[0]).filter(k => /^t\d+$/.test(k))
    .sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
  const out = {};
  for (const r of rows) {
    const q = rSeason(r), d = rDaytype(r);
    if (!q || !d) continue;
    if (!out[q]) out[q] = {};
    out[q][d] = tCols.map(c => parseFloat(r[c]) || 0);
  }
  return out;
}

/** Demand given as a full load table instead of a forecast — pDemandData
 *  (z, q, d, y, t1..tN, MW per block) folded into the shape processDemand()
 *  returns, so the Demand tab works unchanged:
 *    peak   = highest block MW of the year
 *    energy = Σ block MW × block hours / 1000  (GWh)
 *  Used as a fallback when load/pDemandForecast.csv is missing or header-only. */
export function processDemandData(rows, hoursRows) {
  if (!rows?.length) return [];
  const hours = processHoursBlocks(hoursRows);
  const tCols = Object.keys(rows[0]).filter(k => /^t\d+$/.test(k))
    .sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
  const agg = {};   // zone -> { peak: {y: MW}, energy: {y: GWh} }
  for (const r of rows) {
    const z = rZone(r), y = (r.y || r.year || '').trim();
    if (!z || !/^\d{4}$/.test(y)) continue;
    const hRow = hours[rSeason(r)]?.[rDaytype(r)] || [];
    if (!agg[z]) agg[z] = { peak: {}, energy: {} };
    tCols.forEach((c, i) => {
      const mw = parseFloat(r[c]) || 0;
      if (mw <= 0) return;
      agg[z].peak[y]   = Math.max(agg[z].peak[y] || 0, mw);
      agg[z].energy[y] = (agg[z].energy[y] || 0) + mw * (hRow[i] || 0) / 1000;
    });
  }
  return Object.entries(agg).flatMap(([zone, d]) => [
    { zone, type: 'peak',   years: d.peak },
    { zone, type: 'energy', years: d.energy },
  ]);
}

const EXT_DIR_RE = /^\s*(import|export)\s*$/i;

/** Which direction a pExtTransferLimit row states, or null if the file has no such column.
 *  The column is unnamed in the CSV EPM writes (`z,zext,q,,2024,…`), so it is found by its
 *  contents rather than by a header: no zone or quarter is ever called Import or Export. */
function extRowDir(r) {
  for (const v of Object.values(r)) {
    if (EXT_DIR_RE.test(v || '')) return v.trim().toLowerCase() === 'import' ? 'in' : 'out';
  }
  return null;
}

/** Returns { z, zext, years, capIn, capOut }[], each a { '2024': MW, … } map, maxed over
 *  quarters. The limits are directional in EPM — Trakia takes 334 MW from Bulgaria and
 *  sends 200 MW back — so keeping only their max, as `years` does, understates how loaded
 *  the smaller direction is. `years` stays the max for the input map, which draws one line
 *  per corridor; capIn / capOut are what a utilisation must be measured against.
 *  A file with no direction column puts its single limit on both. */
export function processExtNTC(rows) {
  if (!rows?.length) return [];
  const yearCols = Object.keys(rows[0]).filter(k => /^\d{4}$/.test(k));
  const pairs = {};
  for (const r of rows) {
    const z    = r.z    || '';
    const zext = r.zext || '';
    if (!z || !zext) continue;
    const key = `${z}||${zext}`;
    if (!pairs[key]) pairs[key] = { z, zext, years: {}, capIn: {}, capOut: {} };
    const p = pairs[key];
    const dir = extRowDir(r);
    for (const y of yearCols) {
      const v = parseFloat(r[y]) || 0;
      p.years[y] = Math.max(p.years[y] || 0, v);
      if (dir !== 'out') p.capIn[y]  = Math.max(p.capIn[y]  || 0, v);
      if (dir !== 'in')  p.capOut[y] = Math.max(p.capOut[y] || 0, v);
    }
  }
  return Object.values(pairs);
}

/** pTradePrice / pTradePriceExport (zext,q,d,year,t01…tNN) → the same nested shape as
 *  processHourlyPrice, { zext: { year: { q: { d: { t: USD/MWh } } } } }, so a border
 *  price and an internal marginal can be averaged by the very same code.
 *
 *  They are not the same kind of number, though: a border price is an assumption the
 *  study wrote down, an internal price is what the model settled on. Whatever draws
 *  them has to keep them apart. */
export function processTradePrice(rows) {
  if (!rows?.length) return {};
  const cols = sliceCols(rows[0]);
  const out = {};
  for (const r of rows) {
    const z = r.zext || r.z || r.zone || '';
    const y = String(r.year || r.y || '').trim();
    const q = r.q || '', d = r.d || '';
    if (!z || !y || !q || !d) continue;
    const day = (((out[z] ||= {})[y] ||= {})[q] ||= {})[d] ||= {};
    for (const c of cols) {
      const v = parseFloat(r[c]);
      if (Number.isFinite(v)) day[c.replace(/^(t)0+(\d)/i, '$1$2')] = v;
    }
  }
  return out;
}

/** The hours-weighted mean of one zone-year of prices — { q: { d: { t: price } } }
 *  against the pHours weights. Returns null when the year has no prices at all,
 *  which is not the same as a price of zero. */
export function weightedAvgPrice(qmap, hoursData) {
  let tw = 0, tp = 0;
  for (const [q, days] of Object.entries(qmap || {}))
    for (const [d, hrs] of Object.entries(days || {})) {
      const w = hoursData?.[q]?.[d] || 0;
      for (const p of Object.values(hrs)) { tp += p * w; tw += w; }
    }
  return tw > 0 ? tp / tw : null;
}

/** Returns { z, z2, years: { '2024': avgMW, ... } }[] — averaged over quarters */
export function processNTC(rows) {
  if (!rows?.length) return [];
  const yearCols = Object.keys(rows[0]).filter(k => /^\d{4}$/.test(k));
  const pairs = {};
  for (const r of rows) {
    // Tolerates: z/z2 (Black Sea) and From/To (SAPP)
    const z  = r.z  || r.from || r.From || '';
    const z2 = r.z2 || r.to   || r.To   || '';
    if (!z || !z2) continue;
    const key = `${z}||${z2}`;
    if (!pairs[key]) pairs[key] = { z, z2, years: {}, count: 0 };
    pairs[key].count += 1;
    for (const y of yearCols)
      pairs[key].years[y] = (pairs[key].years[y] || 0) + (parseFloat(r[y]) || 0);
  }
  for (const p of Object.values(pairs))
    for (const y of yearCols)
      p.years[y] = Math.round(p.years[y] / p.count);
  return Object.values(pairs);
}

/**
 * pNewTransmission as one row per corridor the model may add.
 *
 * EPM reads it as (z, z2, header): studies write the pair as z/z2 or From/To, in
 * any case, and not every study carries a Status column. The model's rules, from
 * main.gms: Status 2 is committed, built in full from EarliestEntry; Status 3 is a
 * candidate, built only if the optimisation wants it. A row with no status is
 * never forced, so it reads as a candidate. A row with no line to build
 * (MaximumNumOfLines or CapacityPerLine at 0) can add nothing and is dropped.
 */
export function processNewTransmission(rows) {
  if (!rows?.length) return [];
  const pick = (r, ...names) => {
    for (const [k, v] of Object.entries(r)) {
      if (names.includes(k.trim().toLowerCase()) && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  };
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const z  = pick(r, 'z', 'from');
    const z2 = pick(r, 'z2', 'to');
    if (!z || !z2 || z === z2) continue;
    const lines = num(pick(r, 'maximumnumoflines'));
    const perLine = num(pick(r, 'capacityperline'));
    if (lines <= 0 || perLine <= 0) continue;
    const st = pick(r, 'status').toLowerCase();
    const kind = st === '2' || st === 'committed' ? 'planned' : 'candidate';
    // GAMS takes the larger of the two directions; one row per pair and kind is
    // what can be drawn.
    const key = [z, z2].sort().join('||') + '||' + kind;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      z, z2, kind, lines, perLine, capacity: lines * perLine,
      entry: pick(r, 'earliestentry'),
      cost: num(pick(r, 'costperline')),
      life: num(pick(r, 'life')),
    });
  }
  return out;
}

/** A switch from pSettings, by its abbreviation, or null when the file does not
 *  name it. Studies lay the file out differently (label, abbreviation, value, or
 *  just abbreviation, value), so the value is the last filled cell after the name. */
export function settingValue(rows, abbrev) {
  const want = abbrev.toLowerCase();
  for (const r of rows || []) {
    const cells = Object.values(r).map(v => String(v).trim());
    const i = cells.findIndex(c => c.toLowerCase() === want);
    if (i === -1) continue;
    const v = cells.slice(i + 1).filter(Boolean).at(-1);
    return v === undefined ? null : parseFloat(v);
  }
  return null;
}

/** Aggregate gen data by fuel for a given status (or all statuses) */
export function genByFuel(genRows, statuses = [1, 2, 3]) {
  const out = {};
  for (const r of genRows) {
    if (!statuses.includes(r.status)) continue;
    out[r.fuel] = (out[r.fuel] || 0) + r.capacity;
  }
  return out;
}

/** Aggregate demand across all zones for a given type and year */
export function totalDemand(demandRows, type, year) {
  return demandRows
    .filter(r => r.type === type && r.years[year] != null)
    .reduce((s, r) => s + r.years[r.years[year] !== undefined ? year : 0], 0);
}

/** First year column that appears in demand or NTC rows */
export function availableYears(rows) {
  if (!rows?.length) return [];
  return Object.keys(rows[0]?.years || {}).filter(k => /^\d{4}$/.test(k)).sort();
}

/** Full demand profile with season/daytype granularity.
 *  Returns { zone: { season: { daytype: number[24] } } } */
export function processDemandProfileFull(rows) {
  if (!rows?.length) return {};
  const nT = sliceCols(rows[0]).length || 24;   // 24 hours, or a handful of load blocks
  const out = {};
  for (const r of rows) {
    const z = rZone(r);
    const s = rSeason(r);
    const d = rDaytype(r);
    if (!z || !s || !d) continue;
    if (!out[z])       out[z]       = {};
    if (!out[z][s])    out[z][s]    = {};
    out[z][s][d] = Array.from({ length: nT }, (_, i) => rT(r, i + 1));
  }
  return out;
}

/** VRE + ROR generation profiles.
 *  Returns { zone: { tech: { season: { daytype: number[] } } } }, one value per
 *  time slice of the model — 24 for a chronological one, fewer for load blocks. */
export function processVREProfile(rows) {
  if (!rows?.length) return {};
  const nT = sliceCols(rows[0]).length || 24;
  const out = {};
  for (const r of rows) {
    const z    = rZone(r);
    const tech = (r.tech || '').toLowerCase();
    const s    = rSeason(r);
    const d    = rDaytype(r);
    if (!z || !tech || !s || !d) continue;
    if (!out[z])          out[z]          = {};
    if (!out[z][tech])    out[z][tech]    = {};
    if (!out[z][tech][s]) out[z][tech][s] = {};
    out[z][tech][s][d] = Array.from({ length: nT }, (_, i) => rT(r, i + 1));
  }
  return out;
}

/** Seasonal availability factors.
 *  Returns { zone: { 'tech|fuel': { Q1, Q2, Q3, Q4, tech, fuel } } } */
export function processAvailability(rows) {
  if (!rows?.length) return {};
  const qCols = Object.keys(rows[0] || {}).filter(k => /^Q\d+$/.test(k)).sort();
  const out = {};
  for (const r of rows) {
    const z    = r.zone || r.z;
    const tech = r.tech || '';
    if (!z || !tech) continue;
    if (!out[z]) out[z] = {};
    const key   = `${tech}|${r.fuel || ''}`;
    const entry = { tech, fuel: r.fuel || '' };
    for (const q of qCols) entry[q] = parseFloat(r[q]) ?? 1;
    out[z][key] = entry;
  }
  return out;
}

/** t1, t2, … column names of a pHours-like row, in slice order (t01 and t1 both occur). */
function sliceCols(row) {
  return Object.keys(row || {}).filter(k => /^t\d+$/i.test(k))
    .sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
}

/** Weight of each representative (season, daytype) from pHours.csv.
 *  Returns { season: { daytype: number } }, the number being the hours the group
 *  stands for over the year. Only ever used as a share of the total, so the unit
 *  does not matter — what matters is summing the row instead of reading one cell,
 *  because in a load-block model the cells hold different durations. */
export function processHours(rows) {
  if (!rows?.length) return {};
  const cols = sliceCols(rows[0]);
  const out = {};
  for (const r of rows) {
    const q = r.q || r.Q || r.season || '';
    const d = r.d || r.D || r.daytype || '';
    if (!q || !d) continue;
    const w = cols.reduce((s, c) => s + (parseFloat(r[c]) || 0), 0);
    if (!out[q]) out[q] = {};
    out[q][d] = w;
  }
  return out;
}

/** Time-slice structure from pHours.csv.
 *  Two kinds of EPM model share this file: chronological ones, with 24 one-hour
 *  slices per representative day, and load-block ones, with as few as 6 slices of
 *  very unequal length (CASA 2020: 540 h, 445 h, 270 h, …, plus a 7th used only by
 *  the 130-hour peak season). Charts must take their slice count from here rather
 *  than assume 24, or the slices a model does not have appear as a flat zero tail.
 *  Returns { nT, isHourly, hours: { season: { daytype: { t1: hours, … } } } } */
export function processTimeSlices(rows) {
  const out = { nT: 24, isHourly: true, hours: {} };
  if (!rows?.length) return out;
  const cols = sliceCols(rows[0]);
  if (!cols.length) return out;

  let nT = 0;
  for (const r of rows) {
    const q = r.q || r.Q || r.season || '';
    const d = r.d || r.D || r.daytype || '';
    if (!q || !d) continue;
    const per = {};
    cols.forEach((c, i) => {
      const v = parseFloat(r[c]);
      if (!isFinite(v) || v <= 0) return;   // blank cell: the season skips this slice
      per[`t${i + 1}`] = v;
      nT = Math.max(nT, i + 1);
    });
    if (!out.hours[q]) out.hours[q] = {};
    out.hours[q][d] = per;
  }
  out.nT = nT || 24;
  out.isHourly = out.nT === 24;
  return out;
}

/** X-axis label of slice i (0-based). Hours keep reading as hours; blocks say t3
 *  and, when the season is known, how many hours that block stands for — "3h" on a
 *  270-hour block would be a lie. */
export function sliceLabel(slices, i, q, d) {
  if (slices?.isHourly !== false) return `${i + 1}h`;
  const h = q && d ? slices.hours?.[q]?.[d]?.[`t${i + 1}`] : null;
  return h ? `t${i + 1} · ${Math.round(h)} h` : `t${i + 1}`;
}

/** Fuel price trajectories.
 *  Returns { country: { fuel: { year: number } } } */
export function processFuelPrice(rows) {
  if (!rows?.length) return {};
  const yearCols = Object.keys(rows[0] || {}).filter(k => /^\d{4}$/.test(k));
  const out = {};
  for (const r of rows) {
    const c = r.country || r.c || '';
    const f = r.fuel    || '';
    if (!c || !f) continue;
    if (!out[c]) out[c] = {};
    out[c][f] = Object.fromEntries(yearCols.map(y => [y, parseFloat(r[y]) || 0]));
  }
  return out;
}
