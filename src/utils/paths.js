const BASE_URL = import.meta.env.BASE_URL || '/';

/** Build a URL for a file copied from Vite's public/ directory. */
export function appPath(path = '') {
  const cleanPath = String(path).replace(/^\/+/, '');
  return `${BASE_URL}${cleanPath}`;
}

/** Build a URL for a file under public/data/. */
export function dataPath(path = '') {
  return appPath(`data/${String(path).replace(/^\/+/, '')}`);
}
