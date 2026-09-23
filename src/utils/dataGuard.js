import files from 'virtual:data-manifest';
import { dataPath } from './paths';

/**
 * Answer requests for data files the build doesn't contain with a local 404
 * instead of sending them to the server.
 *
 * Pages probe for optional files (zones, trade, load centres) that exist for
 * some regions and countries only. The Design Studio gateway doesn't return a
 * plain 404 for those: it redirects to an error page on another domain, which
 * the browser blocks as a CORS violation -- a wasted round trip and a red
 * console error per probe. `files` is every path under public/data at build
 * time (see vite.config.js), so anything outside it can't exist.
 */
export function installDataGuard() {
  const prefix = new URL(dataPath(''), window.location.origin).href;
  const known = new Set(files);
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, window.location.href).href;
    if (url.startsWith(prefix) && !known.has(decodeURIComponent(url.slice(prefix.length).split(/[?#]/)[0]))) {
      return Promise.resolve(new Response(null, { status: 404, statusText: 'Not in build' }));
    }
    return realFetch(input, init);
  };
}
