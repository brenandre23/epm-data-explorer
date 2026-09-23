export const FUEL_COLORS = {
  solar:      '#FFD700',
  wind:       '#44DAEC',
  hydro:      '#1E9AF5',
  gas:        '#9A7040',
  coal:       '#808890',
  nuclear:    '#C8A8F0',
  oil:        '#7A7068',
  biomass:    '#52C860',
  geothermal: '#D4A820',
  diesel:     '#6A7888',
  waste:      '#8A9098',
  biogas:     '#72DC8A',
  wood:       '#7AC030',
};

export const FUEL_LABELS = {
  solar: 'Solar', wind: 'Wind', hydro: 'Hydro', gas: 'Gas',
  coal: 'Coal', nuclear: 'Nuclear', oil: 'Oil', biomass: 'Biomass',
  geothermal: 'Geothermal', diesel: 'Diesel', waste: 'Waste',
  biogas: 'Biogas', wood: 'Wood',
};

export const VOLTAGE_BRACKETS = [
  { min: 500_000, width: 2.2,  label: '500 kV+',    key: '500',
    colors: { fog: '#0B7A85', paper: '#1A35A0', slate: '#AAEEFF', ink: '#FFEE33', forest: '#EAFF70', dusk: '#70FFD0' } },
  { min: 330_000, width: 1.5,  label: '330–500 kV', key: '330',
    colors: { fog: '#0DA8B8', paper: '#2B52D8', slate: '#44D8F8', ink: '#FFD040', forest: '#C8E830', dusk: '#28E8A8' } },
  { min: 220_000, width: 1.0,  label: '220–330 kV', key: '220',
    colors: { fog: '#3CC8D8', paper: '#5578EE', slate: '#00B0D0', ink: '#C8A000', forest: '#98B800', dusk: '#00B878' } },
  { min: 0,       width: 0.65, label: '110–220 kV', key: '110',
    colors: { fog: '#80DDE8', paper: '#8FAAEE', slate: '#007090', ink: '#906C00', forest: '#608000', dusk: '#007850' } },
];

export const THEMES = {
  fog: {
    isDark: false, label: 'Fog', swatch: '#D8E2EC',
    bg: '#EEF3F7', land: '#D8E2EC',
    panel: '#FFFFFF', panelBorder: '#DEE5EE',
    text: '#2C3E52', muted: '#7A9AB0',
    hr: '#E8EDF2', cardBg: '#F5F7FA', cardBorder: '#DEE5EE',
    lbl: '#2C3E52', lblMuted: '#7A9AB0', lblRow: '#3A5A78',
    worldBdr: 'rgba(160,180,200,0.7)', worldBdrW: 0.4,
    rgnBdr: 'rgba(80,105,140,0.75)', rgnBdrW: 1.0, rgnOp: 0.28,
    navBg: '#F5F7FA', navHint: '#5A7A9A',
    highlight: { fill: 'rgba(95,130,170,1)', border: 'rgba(65,100,145,0.75)', borderW: 1.0 },
  },
  slate: {
    isDark: true, label: 'Slate', swatch: '#0E1B2E',
    bg: '#060B17', land: '#0E1B2E',
    panel: '#0A1828', panelBorder: '#1A3A54',
    text: '#C8DFF0', muted: '#5A8AAA',
    hr: '#1A3A54', cardBg: '#060B17', cardBorder: '#1A3A54',
    lbl: '#A8C8E0', lblMuted: '#4A7A9A', lblRow: '#8BBDD8',
    worldBdr: 'rgba(55,100,155,0.5)', worldBdrW: 0.5,
    rgnBdr: 'rgba(200,225,255,0.65)', rgnBdrW: 1.1, rgnOp: 0.30,
    navBg: '#070D1B', navHint: '#7AAAC8',
    highlight: { fill: 'rgba(55,110,185,1)', border: 'rgba(130,200,255,0.75)', borderW: 1.2 },
  },
  ink: {
    isDark: true, label: 'Ink', swatch: '#252830',
    bg: '#0D0E12', land: '#16181F',
    panel: '#111318', panelBorder: '#252830',
    text: '#E8EAF0', muted: '#6B6E82',
    hr: '#252830', cardBg: '#0D0E12', cardBorder: '#252830',
    lbl: '#C8CBD8', lblMuted: '#555870', lblRow: '#A8ABB8',
    worldBdr: 'rgba(80,85,110,0.5)', worldBdrW: 0.5,
    rgnBdr: 'rgba(180,185,210,0.60)', rgnBdrW: 1.1, rgnOp: 0.25,
    navBg: '#0A0B0F', navHint: '#9A9DB8',
    highlight: { fill: 'rgba(120,130,200,1)', border: 'rgba(200,200,200,0.72)', borderW: 1.2 },
  },
  paper: {
    isDark: false, label: 'Paper', swatch: '#E8E0CC',
    bg: '#F5F0E8', land: '#E8E0CC',
    panel: '#FBF8F2', panelBorder: '#DDD5C4',
    text: '#2A2218', muted: '#8A7A64',
    hr: '#DDD5C4', cardBg: '#F5F0E8', cardBorder: '#DDD5C4',
    lbl: '#2A2218', lblMuted: '#8A7A64', lblRow: '#4A3828',
    worldBdr: 'rgba(140,120,90,0.55)', worldBdrW: 0.4,
    rgnBdr: 'rgba(100,80,50,0.65)', rgnBdrW: 1.0, rgnOp: 0.25,
    navBg: '#F0E8D8', navHint: '#6A5A48',
    highlight: { fill: 'rgba(160,120,70,1)', border: 'rgba(120,85,40,0.75)', borderW: 1.0 },
  },
  forest: {
    isDark: true, label: 'Forest', swatch: '#0F2014',
    bg: '#08120A', land: '#0F2014',
    panel: '#0C1810', panelBorder: '#1C3824',
    text: '#C0DCC4', muted: '#508058',
    hr: '#1C3824', cardBg: '#08120A', cardBorder: '#1C3824',
    lbl: '#A0C8A8', lblMuted: '#407048', lblRow: '#80B090',
    worldBdr: 'rgba(40,100,55,0.55)', worldBdrW: 0.5,
    rgnBdr: 'rgba(150,220,165,0.60)', rgnBdrW: 1.1, rgnOp: 0.28,
    navBg: '#060E08', navHint: '#78B888',
    highlight: { fill: 'rgba(60,180,90,1)', border: 'rgba(100,220,130,0.75)', borderW: 1.2 },
  },
  dusk: {
    isDark: true, label: 'Dusk', swatch: '#1A1530',
    bg: '#0E0A1A', land: '#1A1530',
    panel: '#120E20', panelBorder: '#2A2448',
    text: '#D8D4F0', muted: '#7870A0',
    hr: '#2A2448', cardBg: '#0E0A1A', cardBorder: '#2A2448',
    lbl: '#B8B4E0', lblMuted: '#605890', lblRow: '#9890C8',
    worldBdr: 'rgba(80,70,130,0.55)', worldBdrW: 0.5,
    rgnBdr: 'rgba(180,170,240,0.60)', rgnBdrW: 1.1, rgnOp: 0.28,
    navBg: '#0A0814', navHint: '#9888C8',
    highlight: { fill: 'rgba(140,100,220,1)', border: 'rgba(180,150,255,0.75)', borderW: 1.2 },
  },
};

export const THEME_LIST = ['fog', 'paper', 'slate', 'ink', 'forest', 'dusk'];

export function getT(theme) {
  return THEMES[theme] || THEMES.fog;
}

export const WB_BASEMAP_STYLE_URL =
  'https://www.arcgis.com/sharing/rest/content/items/dcc1c1c0f97f4e458199888b0fc63896/resources/styles/root.json';

export const PLANT_STATUSES = ['operating', 'construction', 'planned'];

// Per-country colors for preferred-zoning overlays — blues, greens, yellows (no orange/violet)
export const COUNTRY_ZONE_COLORS = {
  // Black Sea
  TUR: '#3D9BD4', ROU: '#52B788', ARM: '#E9C46A', AZE: '#2A9D8F', BGR: '#4895EF', GEO: '#90BE6D',
  // SAPP
  ZAF: '#1E88E5', ZWE: '#43A047', ZMB: '#FFD54F', BWA: '#26C6DA', MOZ: '#66BB6A',
  MWI: '#FFF176', NAM: '#29B6F6', LSO: '#A5D6A7', SWZ: '#80DEEA', AGO: '#B5EAD7', MDG: '#FFFFB5',
  // EAPP
  EGY: '#FFD700', ETH: '#2E86AB', KEN: '#57CC99', UGA: '#48CAE4', TZA: '#C7F2A4',
  RWA: '#80ED99', BDI: '#CFEE9E', SDN: '#F4D35E', SSD: '#A8E6CF', DJI: '#56CFE1',
  COD: '#5E9CF4', SOM: '#B8F2E6',
};

export function zoneColorExpr() {
  return ['match', ['get', 'country'],
    ...Object.entries(COUNTRY_ZONE_COLORS).flatMap(([iso, c]) => [iso, c]),
    '#888888',
  ];
}

export function fuelColorExpr() {
  return ['match', ['get', 'fuel'],
    ...Object.entries(FUEL_COLORS).flatMap(([f, c]) => [f, c]),
    '#888888',
  ];
}

export function plantRadiusExpr(scale = 1) {
  return [
    'interpolate', ['linear'], ['get', 'mw'],
    0,    3.5 * scale,
    50,   4.5 * scale,
    200,  7   * scale,
    500,  10  * scale,
    1000, 13  * scale,
    5000, 18  * scale,
  ];
}

export function lcRadiusExpr(scale = 1) {
  return [
    'interpolate', ['linear'], ['get', 'pop'],
    100_000,    3   * scale,
    500_000,    5   * scale,
    1_000_000,  7   * scale,
    5_000_000,  11  * scale,
    15_000_000, 16  * scale,
  ];
}
