import { lazy } from 'react';

// Every page but the world map loads in its own chunk, so a first visit only
// downloads what the world map needs. prefetchPages() fetches the region pages
// once the world map has drawn, so a click on a region does not wait for them.
const loadRegion        = () => import('./RegionPage');
const loadResultsRegion = () => import('./ResultsRegionPage');

export const RegionPage         = lazy(loadRegion);
export const ResultsRegionPage  = lazy(loadResultsRegion);
export const EpmCountryPage     = lazy(() => import('./EpmCountryPage'));
export const EpmZonePage        = lazy(() => import('./EpmZonePage'));
export const ResultsCountryPage = lazy(() => import('./ResultsCountryPage'));
export const ResultsZonePage    = lazy(() => import('./ResultsZonePage'));
export const CountryPage        = lazy(() => import('./CountryPage'));
export const AboutPage          = lazy(() => import('./AboutPage'));
export const ContactPage        = lazy(() => import('./ContactPage'));

export function prefetchPages() {
  loadRegion().catch(() => {});
  loadResultsRegion().catch(() => {});
}
