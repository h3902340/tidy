import { dist, type Vec2, vec2 } from './math';

export const CLOSE_TOLERANCE = 40;
export const RESAMPLE_STEP = 8;

/** Close an open stroke if start/end are within tolerance; always returns a closed ring. */
export function closeStroke(points: Vec2[], tolerance = CLOSE_TOLERANCE): Vec2[] {
  if (points.length < 3) return [...points];

  const first = points[0];
  const last = points[points.length - 1];
  const gap = dist(first, last);

  if (gap <= tolerance) {
    const closed = points.slice(0, -1);
    closed.push({ ...first });
    return closed;
  }

  return [...points, { ...first }];
}

/** Resample closed polygon to uniform edge length (Teddy paper §5). */
export function resamplePolygon(points: Vec2[], step = RESAMPLE_STEP): Vec2[] {
  const ring =
    points.length > 1 && dist(points[0], points[points.length - 1]) < 1e-3
      ? points.slice(0, -1)
      : points;

  if (ring.length < 3) return [...points];

  const segLens: number[] = [];
  let perimeter = 0;
  for (let i = 0; i < ring.length; i++) {
    const len = dist(ring[i], ring[(i + 1) % ring.length]);
    segLens.push(len);
    perimeter += len;
  }

  const count = Math.max(8, Math.round(perimeter / step));
  const out: Vec2[] = [];

  for (let k = 0; k < count; k++) {
    const target = (k / count) * perimeter;
    let acc = 0;
    for (let i = 0; i < ring.length; i++) {
      const len = segLens[i];
      if (acc + len >= target - 1e-6) {
        const t = len > 1e-6 ? (target - acc) / len : 0;
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        out.push(vec2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
        break;
      }
      acc += len;
    }
  }

  if (out.length < 3) return [...points];
  out.push({ ...out[0] });
  return out;
}

function segmentsIntersect(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): boolean {
  const d1 = crossSign(a1, a2, b1);
  const d2 = crossSign(a1, a2, b2);
  const d3 = crossSign(b1, b2, a1);
  const d4 = crossSign(b1, b2, a2);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

function crossSign(o: Vec2, a: Vec2, b: Vec2): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Detect self-intersection of a closed polygon (excluding adjacent edges). */
export function isSelfIntersecting(polygon: Vec2[]): boolean {
  const n = polygon.length;
  if (n < 4) return false;

  const verts =
    dist(polygon[0], polygon[n - 1]) < 1e-3 ? polygon.slice(0, -1) : polygon;

  const m = verts.length;
  for (let i = 0; i < m; i++) {
    const a1 = verts[i];
    const a2 = verts[(i + 1) % m];
    for (let j = i + 2; j < m; j++) {
      if (i === 0 && j === m - 1) continue;
      const b1 = verts[j];
      const b2 = verts[(j + 1) % m];
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

export function normalizePolygon(polygon: Vec2[]): Vec2[] {
  const closed = closeStroke(polygon);
  const resampled = resamplePolygon(closed);
  const ring =
    resampled.length > 1 && dist(resampled[0], resampled[resampled.length - 1]) < 1e-3
      ? resampled.slice(0, -1)
      : resampled;
  return ring;
}
