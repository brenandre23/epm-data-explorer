/**
 * Whether a [lon, lat] point lies inside a Polygon or MultiPolygon feature.
 *
 * A polygon's first ring is its outline and any further rings are holes: a
 * point in a hole is outside. South Africa's outline has Lesotho as a hole,
 * and testing every ring alike counted Lesotho's plants as South Africa's.
 * Points exactly on a ring are decided by the ray cast, as before.
 */
export function pointInFeature(pt, feature) {
  const g = feature.geometry;
  if (g.type === 'Polygon') return pointInPolygon(pt, g.coordinates);
  if (g.type === 'MultiPolygon') return g.coordinates.some(poly => pointInPolygon(pt, poly));
  return false;
}

function pointInPolygon(pt, [outline, ...holes]) {
  if (!outline || !pointInRing(pt, outline)) return false;
  return !holes.some(hole => pointInRing(pt, hole));
}

function pointInRing(pt, ring) {
  let inside = false;
  const [x, y] = pt;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}
