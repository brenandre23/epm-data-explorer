/**
 * Small colour helpers for deriving map paint from the theme palette in
 * src/constants.js, which mixes #hex and rgba() strings.
 */

/** '#rgb', '#rrggbb', 'rgb(r,g,b)' or 'rgba(r,g,b,a)' → [r, g, b, a]. */
export function parseColor(str) {
  const s = String(str).trim();
  if (s[0] === '#') {
    const hex = s.length === 4 ? s.slice(1).split('').map(c => c + c).join('') : s.slice(1);
    const n = parseInt(hex, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return [128, 128, 128, 1];
  const [r, g, b, a = 1] = m[1].split(',').map(Number);
  return [r, g, b, a];
}

export function rgba([r, g, b, a]) {
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${+a.toFixed(3)})`;
}

/** Linear blend of two colours: t = 0 is `a`, t = 1 is `b`. Alpha blends too. */
export function mix(a, b, t) {
  const ca = parseColor(a), cb = parseColor(b);
  return rgba(ca.map((v, i) => v + (cb[i] - v) * t));
}
