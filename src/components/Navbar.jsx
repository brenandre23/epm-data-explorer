import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTheme } from '../App';
import { getT, THEME_LIST, THEMES } from '../constants';
import { useEffect, useState, useMemo } from 'react';
import { track } from '../analytics';
import { dataPath } from '../utils/paths';

const REGIONAL_EXPLORER_URL = 'https://designstudio.worldbank.org/regional-power-explorer/';

function useBreadcrumb() {
  const location = useLocation();
  const [label, setLabel] = useState('');

  useEffect(() => {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length === 0) { setLabel(''); return; }
    if (parts[0] === 'region' && parts[1]) {
      fetch(dataPath('regions.json'))
        .then(r => r.json())
        .then(d => {
          const r = (d.regions || []).find(r => r.id === parts[1]);
          setLabel(r ? r.name : parts[1]);
        })
        .catch(() => setLabel(parts[1]));
    } else if (parts[0] === 'country' && parts[1]) {
      fetch(dataPath('regions.json'))
        .then(r => r.json())
        .then(d => {
          for (const r of (d.regions || [])) {
            const c = r.countries.find(c => c.iso === parts[1]);
            if (c) { setLabel(`${r.name} / ${c.name}`); return; }
          }
          setLabel(parts[1]);
        })
        .catch(() => setLabel(parts[1]));
    }
  }, [location.pathname]);

  return label;
}

export default function Navbar() {
  const { theme, setTheme } = useTheme();
  const t = getT(theme);
  const crumb = useBreadcrumb();
  const location = useLocation();
  const navigate = useNavigate();
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const [countryIso, setCountryIso] = useState(null);

  // Resolve country ISO from name in URL for cross-app linking
  useEffect(() => {
    const p = location.pathname.split('/').filter(Boolean);
    const nameInUrl = (p[0] === 'region' && p[2] === 'country' && p[3])
      ? decodeURIComponent(p[3])
      : (p[0] === 'region' && p[2] === 'results' && p[3] === 'country' && p[4])
        ? decodeURIComponent(p[4])
        : null;
    if (!nameInUrl) { setCountryIso(null); return; }
    fetch(dataPath('regions.json'))
      .then(r => r.json())
      .then(d => {
        for (const r of (d.regions || [])) {
          const c = (r.countries || []).find(c => c.name === nameInUrl);
          if (c) { setCountryIso(c.iso); return; }
        }
        setCountryIso(null);
      })
      .catch(() => setCountryIso(null));
  }, [location.pathname]);

  // Detect region context and current mode (inputs vs results)
  const parts = location.pathname.split('/').filter(Boolean);
  const regionId = parts[0] === 'region' ? parts[1] : null;
  const isResults = parts[2] === 'results';
  const isRegionCtx = !!regionId;

  // Context-aware toggle: preserve country/zone sub-route across modes
  const handleToggle = (mode) => {
    if (!regionId) return;
    sessionStorage.setItem('epmViewMode', mode);
    if (mode === 'results') {
      // Inputs → Results: preserve country/zone context
      if (!isResults && parts[2] === 'country' && parts[3])
        navigate(`/region/${regionId}/results/country/${parts[3]}`);
      else if (!isResults && parts[2] === 'zone' && parts[3])
        navigate(`/region/${regionId}/results/zone/${parts[3]}`);
      else
        navigate(`/region/${regionId}/results`);
    } else {
      // Results → Inputs: preserve country/zone context
      if (isResults && parts[3] === 'country' && parts[4])
        navigate(`/region/${regionId}/country/${parts[4]}`);
      else if (isResults && parts[3] === 'zone' && parts[4])
        navigate(`/region/${regionId}/zone/${parts[4]}`);
      else
        navigate(`/region/${regionId}`);
    }
  };

  const dashboardUrl = useMemo(() => {
    const parts = location.pathname.split('/').filter(Boolean);
    // The explorer uses hash routes and reads ?theme= from before the hash.
    const at = route => `${REGIONAL_EXPLORER_URL}?theme=${theme}#${route}`;
    if (parts[0] === 'country' && parts[1]) return at(`/country/${parts[1]}`);
    if (parts[0] === 'region' && parts[1]) {
      if (countryIso) return at(`/country/${countryIso}`);
      return at(`/region/${parts[1]}`);
    }
    return at('/');
  }, [location.pathname, theme, countryIso]);

  const navBtn = (active = false) => ({
    background: 'none',
    border: `1px solid ${active ? 'rgba(128,160,192,0.5)' : t.panelBorder}`,
    borderRadius: 5, padding: '3px 10px',
    cursor: 'pointer',
    color: active ? t.lbl : t.lblMuted,
    fontSize: '0.68rem', letterSpacing: '1px',
    textTransform: 'uppercase', fontFamily: 'inherit',
    textDecoration: 'none',
    display: 'inline-flex', alignItems: 'center',
    transition: 'border-color 0.2s, color 0.2s',
  });

  return (
    <div style={{
      height: 46, display: 'flex', alignItems: 'center',
      padding: '0 18px', backgroundColor: t.navBg,
      borderBottom: `1px solid ${t.panelBorder}`,
      justifyContent: 'space-between', flexShrink: 0,
      zIndex: 200,
    }}>

      {/* Left: logo + breadcrumb */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, minWidth: 0 }}>
        <Link to="/" style={{
          fontSize: '0.7rem', fontWeight: 700, letterSpacing: '2px',
          color: t.muted, textTransform: 'uppercase',
          display: 'flex', alignItems: 'center', gap: 8,
          fontFamily: "'Open Sans', system-ui, sans-serif",
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <circle cx="12" cy="12" r="10"/>
            <ellipse cx="12" cy="12" rx="4.5" ry="10"/>
            <line x1="2.5" y1="9" x2="21.5" y2="9"/>
            <line x1="2.5" y1="15" x2="21.5" y2="15"/>
          </svg>
          EPM <span style={{ fontWeight: 400 }}>Data Explorer</span>
        </Link>
        <span style={{
          fontSize: '0.48rem', fontWeight: 700, letterSpacing: '1.5px',
          color: 'rgba(74,143,204,0.7)', textTransform: 'uppercase',
          border: '1px solid rgba(74,143,204,0.3)', borderRadius: 3,
          padding: '1px 5px', lineHeight: 1,
        }}>
          Beta
        </span>
        {crumb && (
          <>
            <span style={{ color: t.panelBorder, fontSize: '0.75rem', flexShrink: 0 }}>›</span>
            {/* Bounded, so a deep breadcrumb truncates instead of eating the hint's room
                or pushing the controls past the edge of the bar. */}
            <span title={crumb} style={{
              fontSize: '0.75rem', color: t.lbl, maxWidth: '26vw',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>{crumb}</span>
          </>
        )}
      </div>

      {/* Center: hint. Truncation rules live in index.css (.nav-hint), because they
          need media queries: the second clause goes before the first, and both go
          before the bar is allowed to wrap. */}
      <div className="nav-hint">
        <span style={{
          fontStyle: 'italic', fontSize: '0.6rem', letterSpacing: '0.25px',
          color: t.navHint,
        }}>
          Click a region or country to explore
          <span className="nav-hint-more">&nbsp;·&nbsp; use Inputs / Results to switch views</span>
        </span>
      </div>

      {/* Right: theme toggle | EPM Suite | Data Sources | Contact */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>

        {/* Inputs / Results toggle */}
        {isRegionCtx && (
          <div style={{ display:'flex', gap:0, border:`1px solid ${t.panelBorder}`, borderRadius:5, overflow:'hidden', marginRight:4 }}>
            {[['inputs','Inputs'],['results','Results']].map(([mode, label]) => (
              <button key={mode} onClick={() => { handleToggle(mode); track('mode_toggle', { mode, region: regionId }); }} style={{
                fontSize:'0.58rem', fontFamily:'inherit', padding:'3px 11px',
                border:'none', cursor:'pointer', letterSpacing:'0.5px',
                backgroundColor: (mode==='results'?isResults:!isResults) ? 'rgba(74,143,204,0.2)' : 'transparent',
                color: (mode==='results'?isResults:!isResults) ? t.lbl : t.lblMuted,
                fontWeight: (mode==='results'?isResults:!isResults) ? 700 : 400,
                transition:'background 0.15s',
              }}>{label}</button>
            ))}
          </div>
        )}

        {/* Theme swatches */}
        <div style={{ display: 'flex', gap: 5, alignItems: 'center', marginRight: 2 }}>
          {THEME_LIST.map(id => {
            const th = THEMES[id];
            const active = theme === id;
            return (
              <button key={id} title={th.label} onClick={() => setTheme(id)} style={{
                width: 15, height: 15, borderRadius: '50%', padding: 0, cursor: 'pointer',
                backgroundColor: th.swatch,
                border: active ? `2px solid ${t.lbl}` : `1px solid ${t.panelBorder}`,
                boxShadow: active ? '0 0 0 1px rgba(128,160,192,0.35)' : 'none',
                transform: active ? 'scale(1.25)' : 'scale(1)',
                transition: 'transform 0.15s, box-shadow 0.15s',
                flexShrink: 0,
              }} />
            );
          })}
        </div>

        {/* Geo Data */}
        <div style={{ position: 'relative' }}>
          <a
            href={dashboardUrl}
            onMouseEnter={() => setTooltipVisible(true)}
            onMouseLeave={() => setTooltipVisible(false)}
            style={{
              ...navBtn(),
              color: 'rgba(74,143,204,0.9)',
              border: `1px solid rgba(74,143,204,0.45)`,
              gap: 6,
            }}
            onClick={() => track('open_data_click', { from: location.pathname })}
            onMouseOver={e => e.currentTarget.style.background = 'rgba(74,143,204,0.07)'}
            onMouseOut={e => { e.currentTarget.style.background = 'none'; setTooltipVisible(false); }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="10"/>
              <ellipse cx="12" cy="12" rx="4.5" ry="10"/>
              <line x1="2.5" y1="9" x2="21.5" y2="9"/>
              <line x1="2.5" y1="15" x2="21.5" y2="15"/>
            </svg>
            Open Data
          </a>

          {tooltipVisible && (
            <div style={{
              position: 'absolute', top: 36, right: 0, zIndex: 300,
              backgroundColor: t.panel, border: `1px solid ${t.panelBorder}`,
              borderRadius: 6, padding: '10px 14px', width: 240,
              fontSize: '0.68rem', color: t.muted,
              boxShadow: '0 4px 16px rgba(0,0,0,0.18)', lineHeight: 1.6,
              pointerEvents: 'none',
            }}>
              <span style={{ color: t.lbl, fontWeight: 600, display: 'block', marginBottom: 4 }}>
                Regional Power Explorer
              </span>
              Power plants, transmission lines, RE resources and country profiles — interactive geo data layer.
            </div>
          )}
        </div>

        {/* Data Sources */}
        <Link to="/about" style={navBtn(location.pathname === '/about')}>
          Data Sources
        </Link>

        {/* About */}
        <Link to="/contact" style={navBtn(location.pathname === '/contact')}>
          About
        </Link>

      </div>
    </div>
  );
}
