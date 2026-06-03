import { dist, type Vec2, windingNumber } from './math';

const EPS = 1e-6;
const MERGE_EPS = 1.5;

interface BoundaryHit {
  point: Vec2;
  polyEdge: number;
  cutSeg: number;
  cutParam: number;
  polyT: number;
}

export type CutBoundaryHit = BoundaryHit;

/** Validate that a stroke crosses a closed boundary exactly twice (screen silhouette). */
export function validateCutCrossesBoundary(
  boundary: Vec2[],
  cut: Vec2[]
):
  | { ok: true; hits: [CutBoundaryHit, CutBoundaryHit]; silhouette: Vec2[] }
  | { error: string } {
  if (boundary.length < 3) return { error: 'Invalid silhouette.' };
  if (cut.length < 2) return { error: 'Cut stroke is too short.' };

  const hits = findBoundaryHits(boundary, cut);
  const unique = dedupeHits(hits);

  if (unique.length < 2) {
    return {
      error:
        'Cut does not cross the object silhouette twice. Draw across the shape in the current view.',
    };
  }

  if (unique.length > 2) {
    return {
      error:
        'Cut crosses the silhouette more than twice. Use one stroke across the shape.',
    };
  }

  const hasInteriorPoint = cut.some((p) => windingNumber(p, boundary));
  if (!hasInteriorPoint) {
    return {
      error: 'Cut must pass through the interior of the object in this view.',
    };
  }

  return { ok: true, hits: [unique[0], unique[1]], silhouette: boundary };
}

export function cutPolygon(
  polygon: Vec2[],
  cut: Vec2[]
): { kept: Vec2[]; discarded: Vec2[] } | { error: string } {
  const validated = validateCutCrossesBoundary(polygon, cut);
  if ('error' in validated) return validated;

  const [h0, h1] = validated.hits;
  const parts = splitAtHits(polygon, cut, h0, h1);
  if (!parts) return { error: 'Could not split polygon along cut.' };

  const [partA, partB] = parts;
  const countA = partA.length;
  const countB = partB.length;

  if (countA > countB) return { kept: partA, discarded: partB };
  if (countB > countA) return { kept: partB, discarded: partA };

  const areaA = polygonArea(partA);
  const areaB = polygonArea(partB);
  return areaA >= areaB
    ? { kept: partA, discarded: partB }
    : { kept: partB, discarded: partA };
}

function findBoundaryHits(polygon: Vec2[], cut: Vec2[]): BoundaryHit[] {
  const hits: BoundaryHit[] = [];
  const n = polygon.length;
  let cutParam = 0;

  for (let s = 0; s < cut.length - 1; s++) {
    const c1 = cut[s];
    const c2 = cut[s + 1];
    const segLen = dist(c1, c2);

    for (let i = 0; i < n; i++) {
      const p1 = polygon[i];
      const p2 = polygon[(i + 1) % n];
      const hit = segmentIntersect(p1, p2, c1, c2);
      if (hit) {
        hits.push({
          point: hit.point,
          polyEdge: i,
          cutSeg: s,
          cutParam: cutParam + hit.tB * segLen,
          polyT: hit.tA,
        });
      }
    }

    cutParam += segLen;
  }

  return hits;
}

function segmentIntersect(
  p1: Vec2,
  p2: Vec2,
  q1: Vec2,
  q2: Vec2
): { point: Vec2; tA: number; tB: number } | null {
  const dpx = p2.x - p1.x;
  const dpy = p2.y - p1.y;
  const dqx = q2.x - q1.x;
  const dqy = q2.y - q1.y;
  const denom = dpx * dqy - dpy * dqx;
  if (Math.abs(denom) < EPS) return null;

  const tA = ((q1.x - p1.x) * dqy - (q1.y - p1.y) * dqx) / denom;
  const tB = ((q1.x - p1.x) * dpy - (q1.y - p1.y) * dpx) / denom;

  if (tA < -EPS || tA > 1 + EPS || tB < -EPS || tB > 1 + EPS) return null;

  return {
    point: { x: p1.x + tA * dpx, y: p1.y + tA * dpy },
    tA: Math.max(0, Math.min(1, tA)),
    tB: Math.max(0, Math.min(1, tB)),
  };
}

function dedupeHits(hits: BoundaryHit[]): BoundaryHit[] {
  const out: BoundaryHit[] = [];
  for (const h of hits) {
    if (!out.some((o) => dist(o.point, h.point) < MERGE_EPS)) {
      out.push(h);
    }
  }
  out.sort((a, b) => a.cutParam - b.cutParam);
  return out;
}

function splitAtHits(
  polygon: Vec2[],
  cut: Vec2[],
  h0: BoundaryHit,
  h1: BoundaryHit
): [Vec2[], Vec2[]] | null {
  const { vertices, index0, index1 } = insertTwoHits(polygon, h0, h1);
  if (index0 === index1) return null;

  const cutPath = extractCutPath(cut, h0.cutParam, h1.cutParam);
  const boundaryForward = walkBoundary(vertices, index0, index1);
  const boundaryBackward = walkBoundary(vertices, index1, index0);

  const partA = [...boundaryForward, ...cutPath.slice().reverse()];
  const partB = [...boundaryBackward, ...cutPath];

  const cleanA = cleanRing(partA);
  const cleanB = cleanRing(partB);
  if (cleanA.length < 3 || cleanB.length < 3) return null;

  return [cleanA, cleanB];
}

function insertTwoHits(
  polygon: Vec2[],
  h0: BoundaryHit,
  h1: BoundaryHit
): { vertices: Vec2[]; index0: number; index1: number } {
  const hits = [h0, h1].sort((a, b) =>
    a.polyEdge !== b.polyEdge ? b.polyEdge - a.polyEdge : b.polyT - a.polyT
  );

  let vertices = [...polygon];

  for (const h of hits) {
    const insertAt = h.polyEdge + 1;
    vertices.splice(insertAt, 0, { ...h.point });
  }

  const [origH0, origH1] = [h0, h1];
  let index0 = -1;
  let index1 = -1;
  for (let i = 0; i < vertices.length; i++) {
    if (dist(vertices[i], origH0.point) < MERGE_EPS) index0 = i;
    if (dist(vertices[i], origH1.point) < MERGE_EPS) index1 = i;
  }

  return { vertices, index0, index1 };
}

function walkBoundary(vertices: Vec2[], from: number, to: number): Vec2[] {
  const n = vertices.length;
  const path: Vec2[] = [];
  let i = from;
  while (i !== to) {
    path.push({ ...vertices[i] });
    i = (i + 1) % n;
    if (path.length > n + 1) break;
  }
  path.push({ ...vertices[to] });
  return path;
}

export function extractCutPath(cut: Vec2[], param0: number, param1: number): Vec2[] {
  const [start, end] = param0 < param1 ? [param0, param1] : [param1, param0];
  const path: Vec2[] = [];
  let acc = 0;

  for (let s = 0; s < cut.length - 1; s++) {
    const c1 = cut[s];
    const c2 = cut[s + 1];
    const len = dist(c1, c2);
    const segStart = acc;
    const segEnd = acc + len;

    if (segEnd < start - EPS) {
      acc += len;
      continue;
    }
    if (segStart > end + EPS) break;

    const t0 = len > EPS ? Math.max(0, (start - segStart) / len) : 0;
    const t1 = len > EPS ? Math.min(1, (end - segStart) / len) : 1;
    const p0 = { x: c1.x + (c2.x - c1.x) * t0, y: c1.y + (c2.y - c1.y) * t0 };
    const p1 = { x: c1.x + (c2.x - c1.x) * t1, y: c1.y + (c2.y - c1.y) * t1 };

    if (path.length === 0) path.push(p0);
    else if (dist(path[path.length - 1], p0) > MERGE_EPS) path.push(p0);

    if (dist(path[path.length - 1], p1) > MERGE_EPS) path.push(p1);

    acc += len;
  }

  if (path.length < 2 && cut.length >= 2) {
    return [{ ...cut[0] }, { ...cut[cut.length - 1] }];
  }
  return path;
}

function cleanRing(points: Vec2[]): Vec2[] {
  if (points.length === 0) return [];
  const out: Vec2[] = [{ ...points[0] }];
  for (let i = 1; i < points.length; i++) {
    if (dist(out[out.length - 1], points[i]) > MERGE_EPS) {
      out.push({ ...points[i] });
    }
  }
  if (out.length > 2 && dist(out[0], out[out.length - 1]) < MERGE_EPS) {
    out.pop();
  }
  return out;
}

function polygonArea(poly: Vec2[]): number {
  let sum = 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return Math.abs(sum) / 2;
}
