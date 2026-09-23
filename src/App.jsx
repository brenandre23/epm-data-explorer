import { createContext, useContext, useState, Component } from 'react';
import { THEME_LIST } from './constants';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { Analytics } from '@vercel/analytics/react';
import Navbar from './components/Navbar';
import WorldPage from './pages/WorldPage';
import RegionPage from './pages/RegionPage';
import CountryPage from './pages/CountryPage';
import EpmCountryPage from './pages/EpmCountryPage';
import EpmZonePage from './pages/EpmZonePage';
import ResultsRegionPage from './pages/ResultsRegionPage';
import ResultsCountryPage from './pages/ResultsCountryPage';
import ResultsZonePage from './pages/ResultsZonePage';
import AboutPage from './pages/AboutPage';
import ContactPage from './pages/ContactPage';
import { getT } from './constants';

export const ThemeCtx = createContext({ theme: 'paper', setTheme: () => {} });
export const useTheme = () => useContext(ThemeCtx);

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, fontFamily: 'monospace', fontSize: 13, color: '#c00',
          position: 'fixed', inset: 0, backgroundColor: '#fff', overflow: 'auto', zIndex: 9999 }}>
          <b>Runtime error — open browser DevTools (F12) for full stack trace.</b>
          <pre style={{ marginTop: 12, whiteSpace: 'pre-wrap', color: '#333' }}>
            {this.state.error?.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [theme, setTheme] = useState(() => {
    // ?theme= may sit before the hash (…/?theme=x#/region/y) or inside it (…/#/region/y?theme=x).
    const p = new URLSearchParams(window.location.search).get('theme')
      ?? new URLSearchParams(window.location.hash.split('?')[1] || '').get('theme');
    return (p && THEME_LIST.includes(p)) ? p : 'paper';
  });
  const t = getT(theme);

  return (
    <ErrorBoundary>
      <ThemeCtx.Provider value={{ theme, setTheme }}>
        {/* Hash routes: the Design Studio gateway redirects any path that has no file,
            so page paths live after the #. */}
        <HashRouter>
          <div style={{
            display: 'flex', flexDirection: 'column', height: '100vh',
            overflow: 'hidden', backgroundColor: t.bg,
          }}>
            <Navbar />
            <div style={{ flex: 1, overflow: 'hidden', height: 'calc(100vh - 46px)' }}>
              <Routes>
                <Route path="/"                    element={<WorldPage />} />
                <Route path="/region/:regionId"                                          element={<RegionPage />} />
                <Route path="/region/:regionId/country/:countryName"              element={<EpmCountryPage />} />
                <Route path="/region/:regionId/zone/:zoneId"                      element={<EpmZonePage />} />
                <Route path="/region/:regionId/results"                           element={<ResultsRegionPage />} />
                <Route path="/region/:regionId/results/country/:countryName"      element={<ResultsCountryPage />} />
                <Route path="/region/:regionId/results/zone/:zoneId"              element={<ResultsZonePage />} />
                <Route path="/country/:iso"                           element={<CountryPage />} />
                <Route path="/about"               element={<AboutPage />} />
                <Route path="/contact"             element={<ContactPage />} />
              </Routes>
            </div>
          </div>
          <Analytics />
        </HashRouter>
      </ThemeCtx.Provider>
    </ErrorBoundary>
  );
}
