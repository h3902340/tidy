import * as THREE from 'three';
import type { Mesh3D } from './teddyPipeline';
import type { Vec2, Vec3 } from './math';
import { cross2, lerp3 } from './math';
import type { CutBoundaryHit } from './cutPolygon';
import { meshVertexToScreen } from './screenSilhouette';
import {
  mesh3DToRaycastObject,
  projectScreenStrokeFrontBack,
  worldHitToMeshVertex,
} from './surfaceProjection';

type Triangle = [number, number, number];

export type TeddyCutResult = {
  /** Mesh with the smaller cut side removed (open cut, no cap). */
  trimmed: Mesh3D;
  /** Trimmed mesh plus hole cap between front/back surface paths. */
  capped: Mesh3D;
  polygon: Vec2[];
  frontPath: Vec3[];
  backPath: Vec3[];
};

/**
 * Teddy §5.4 cut in two phases: (1) remove the side with fewer vertices, (2) cap the hole.
 */
export function computeTeddyCut(
  mesh: Mesh3D,
  screenStroke: Vec2[],
  camera: THREE.Camera,
  domElement: HTMLElement,
  _validated: {
    silhouette: Vec2[];
    hits: [CutBoundaryHit, CutBoundaryHit];
  },
  worldRoot?: THREE.Object3D,
  projectedPaths?: { frontPath: Vec3[]; backPath: Vec3[] }
): TeddyCutResult | { error: string } {
  const rect = domElement.getBoundingClientRect();

  let frontPath: Vec3[];
  let backPath: Vec3[];

  if (projectedPaths) {
    frontPath = projectedPaths.frontPath;
    backPath = projectedPaths.backPath;
  } else {
    const raycastMesh = mesh3DToRaycastObject(mesh);
    const { front: frontWorld, back: backWorld } = projectScreenStrokeFrontBack(
      screenStroke,
      camera,
      raycastMesh,
      domElement
    );
    raycastMesh.geometry.dispose();
    (raycastMesh.material as THREE.Material).dispose();

    if (frontWorld.length < 2 || backWorld.length < 2) {
      return { error: 'Could not project cut onto the object surface (front and back).' };
    }

    frontPath = frontWorld.map(worldHitToMeshVertex);
    backPath = backWorld.map(worldHitToMeshVertex);
  }

  if (frontPath.length < 2 || backPath.length < 2) {
    return { error: 'Could not project cut onto the object surface (front and back).' };
  }

  const split = splitMeshAlongScreenStroke(mesh, camera, rect, screenStroke, worldRoot);
  const keptFaces = keepFacesOnLargerVertexSide(split.leftFaces, split.rightFaces);

  if (keptFaces.length === 0) {
    return { error: 'Cut removed the entire object — try a smaller cut.' };
  }

  const trimmed: Mesh3D = {
    vertices: split.vertices,
    faces: keptFaces,
  };

  // Cap the hole from the trimmed mesh's *actual* open boundary (the crossing vertices
  // created by the split) so the cap welds onto the new cut triangles and follows the cut
  // exactly, rather than floating on a separately-projected path over the old triangles.
  const capFaces = buildCapFromBoundary(
    split.vertices,
    keptFaces,
    camera,
    rect,
    screenStroke,
    worldRoot
  );
  const capped: Mesh3D = {
    vertices: split.vertices,
    faces: [...keptFaces, ...capFaces],
  };

  const polygon = extractTopBoundaryPolygon(capped.vertices, capped.faces);

  return {
    trimmed,
    capped,
    polygon,
    frontPath,
    backPath,
  };
}

/** @deprecated Use computeTeddyCut */
export function applyTeddyCut(
  mesh: Mesh3D,
  screenStroke: Vec2[],
  camera: THREE.Camera,
  domElement: HTMLElement,
  validated: {
    silhouette: Vec2[];
    hits: [CutBoundaryHit, CutBoundaryHit];
  },
  worldRoot?: THREE.Object3D,
  projectedPaths?: { frontPath: Vec3[]; backPath: Vec3[] }
): { mesh: Mesh3D; polygon: Vec2[]; frontPath: Vec3[]; backPath: Vec3[] } | { error: string } {
  const result = computeTeddyCut(
    mesh,
    screenStroke,
    camera,
    domElement,
    validated,
    worldRoot,
    projectedPaths
  );
  if ('error' in result) return result;
  return {
    mesh: result.capped,
    polygon: result.polygon,
    frontPath: result.frontPath,
    backPath: result.backPath,
  };
}

type SplitResult = {
  /** Original vertices plus new vertices created where edges cross the cut. */
  vertices: Vec3[];
  leftFaces: Triangle[];
  rightFaces: Triangle[];
  /** Edges (pairs of crossing-vertex ids) lying exactly on the cut, forming the hole rim. */
  cutSegments: [number, number][];
};

/**
 * Phase 1: slice every triangle that the screen-space cut *stroke* passes through, so the
 * boundary follows the drawn stroke exactly instead of a straight chord or original triangle
 * edges. Triangles are partitioned into the two sides of the stroke polyline; crossed
 * triangles are split into sub-triangles at the precise crossing points.
 */
function splitMeshAlongScreenStroke(
  mesh: Mesh3D,
  camera: THREE.Camera,
  rect: { width: number; height: number },
  screenStroke: Vec2[],
  worldRoot?: THREE.Object3D
): SplitResult {
  const vertices = mesh.vertices.slice();
  // Extend the stroke past both ends so triangles near the silhouette still flip sign.
  const cutPath = extendPolyline(screenStroke, 1e5);
  const signedDist = (s: Vec2): number => signedDistanceToPolyline(s, cutPath);

  const screenCache = new Map<number, Vec2 | null>();
  const sideOf = (id: number): number => {
    if (!screenCache.has(id)) {
      screenCache.set(id, meshVertexToScreen(vertices[id], camera, rect, worldRoot));
    }
    const s = screenCache.get(id) ?? null;
    if (!s) return 0;
    const d = signedDist(s);
    if (d > 1e-6) return 1;
    if (d < -1e-6) return -1;
    return 0;
  };

  const crossingCache = new Map<string, number>();
  const crossingVertex = (idA: number, idB: number): number => {
    const lo = Math.min(idA, idB);
    const hi = Math.max(idA, idB);
    const key = `${lo}_${hi}`;
    const cached = crossingCache.get(key);
    if (cached !== undefined) return cached;

    const a = mesh.vertices[lo];
    const b = mesh.vertices[hi];
    const f = (t: number): number => {
      const s = meshVertexToScreen(lerp3(a, b, t), camera, rect, worldRoot);
      return s ? signedDist(s) : 0;
    };

    // Perspective makes f non-linear in t, so bisect for the zero crossing.
    let loT = 0;
    let hiT = 1;
    let fLo = f(0);
    for (let i = 0; i < 32; i++) {
      const mid = (loT + hiT) / 2;
      const fMid = f(mid);
      if ((fLo <= 0 && fMid <= 0) || (fLo >= 0 && fMid >= 0)) {
        loT = mid;
        fLo = fMid;
      } else {
        hiT = mid;
      }
    }
    const t = (loT + hiT) / 2;
    const id = vertices.length;
    vertices.push(lerp3(a, b, t));
    crossingCache.set(key, id);
    return id;
  };

  const leftFaces: Triangle[] = [];
  const rightFaces: Triangle[] = [];
  const cutSegments: [number, number][] = [];

  for (const tri of mesh.faces) {
    const signs: number[] = [sideOf(tri[0]), sideOf(tri[1]), sideOf(tri[2])];
    // Snap on-line vertices onto a neighbor's side to avoid degenerate zero-area slivers.
    for (let i = 0; i < 3; i++) {
      if (signs[i] === 0) {
        signs[i] = signs[(i + 1) % 3] || signs[(i + 2) % 3] || 1;
      }
    }

    const hasPos = signs.some((s) => s > 0);
    const hasNeg = signs.some((s) => s < 0);

    if (!hasNeg) {
      leftFaces.push(tri);
      continue;
    }
    if (!hasPos) {
      rightFaces.push(tri);
      continue;
    }

    const posPoly: number[] = [];
    const negPoly: number[] = [];
    const crossings: number[] = [];
    for (let i = 0; i < 3; i++) {
      const cur = tri[i];
      const nxt = tri[(i + 1) % 3];
      const sCur = signs[i];
      const sNxt = signs[(i + 1) % 3];
      if (sCur > 0) posPoly.push(cur);
      else negPoly.push(cur);
      if ((sCur > 0 && sNxt < 0) || (sCur < 0 && sNxt > 0)) {
        const x = crossingVertex(cur, nxt);
        posPoly.push(x);
        negPoly.push(x);
        crossings.push(x);
      }
    }

    fanTriangulate(posPoly, leftFaces);
    fanTriangulate(negPoly, rightFaces);
    if (crossings.length === 2) {
      cutSegments.push([crossings[0], crossings[1]]);
    }
  }

  return { vertices, leftFaces, rightFaces, cutSegments };
}

function fanTriangulate(poly: number[], out: Triangle[]): void {
  for (let i = 1; i < poly.length - 1; i++) {
    out.push([poly[0], poly[i], poly[i + 1]]);
  }
}

/** Extend a polyline outward at both ends along its end tangents by `amount` pixels. */
function extendPolyline(path: Vec2[], amount: number): Vec2[] {
  const pts = path.filter(
    (p, i) => i === 0 || Math.hypot(p.x - path[i - 1].x, p.y - path[i - 1].y) > 1e-6
  );
  if (pts.length < 2) return pts.length === 1 ? [pts[0], pts[0]] : pts;

  const head = pts[0];
  const headDir = pts[1];
  const tail = pts[pts.length - 1];
  const tailDir = pts[pts.length - 2];

  const extend = (from: Vec2, toward: Vec2): Vec2 => {
    const dx = from.x - toward.x;
    const dy = from.y - toward.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: from.x + (dx / len) * amount, y: from.y + (dy / len) * amount };
  };

  return [extend(head, headDir), ...pts, extend(tail, tailDir)];
}

/**
 * Signed distance from a screen point to a polyline. Magnitude is distance to the nearest
 * segment; sign tells which side of that segment the point lies on (zero set = the polyline).
 */
function signedDistanceToPolyline(p: Vec2, path: Vec2[]): number {
  let bestDist2 = Infinity;
  let bestSign = 1;

  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const apx = p.x - a.x;
    const apy = p.y - a.y;
    const len2 = abx * abx + aby * aby || 1e-12;
    let t = (apx * abx + apy * aby) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + abx * t;
    const cy = a.y + aby * t;
    const dx = p.x - cx;
    const dy = p.y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist2) {
      bestDist2 = d2;
      bestSign = cross2(a, b, p) >= 0 ? 1 : -1;
    }
  }

  return bestSign * Math.sqrt(bestDist2);
}

/**
 * Phase 2: cap the hole left by the removed side. The trimmed mesh's only open boundary is
 * the cut rim — the crossing vertices the split inserted exactly along the stroke. We stitch
 * a ribbon across that rim reusing those same vertex indices, so the cap welds directly onto
 * the new cut triangles and follows the drawn stroke instead of a separately-projected path.
 */
function buildCapFromBoundary(
  vertices: Vec3[],
  keptFaces: Triangle[],
  camera: THREE.Camera,
  rect: { width: number; height: number },
  screenStroke: Vec2[],
  worldRoot?: THREE.Object3D
): Triangle[] {
  const edgeUse = new Map<string, number>();
  for (const [a, b, c] of keptFaces) {
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ] as [number, number][]) {
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  }

  const boundaryEdges: [number, number][] = [];
  for (const [key, count] of edgeUse) {
    if (count !== 1) continue;
    const [a, b] = key.split('_').map(Number);
    boundaryEdges.push([a, b]);
  }

  const loops = collectLoops(boundaryEdges);
  const stroke = screenStroke.filter(
    (p, i) => i === 0 || Math.hypot(p.x - screenStroke[i - 1].x, p.y - screenStroke[i - 1].y) > 1e-6
  );

  const out: Triangle[] = [];
  for (const loop of loops) {
    capBoundaryLoop(loop, vertices, camera, rect, stroke, worldRoot, out);
  }
  return out;
}

/**
 * Cap a single rim loop. The loop wraps the removed region: walking it traverses the front
 * surface from one silhouette end to the other and back along the back surface. We split it
 * at the two stroke-extreme vertices into a front arc and a back arc, then stitch a ribbon
 * between them by marching along the shared stroke parameter.
 */
function capBoundaryLoop(
  loop: number[],
  vertices: Vec3[],
  camera: THREE.Camera,
  rect: { width: number; height: number },
  stroke: Vec2[],
  worldRoot: THREE.Object3D | undefined,
  out: Triangle[]
): void {
  if (loop.length < 3) return;

  const params = loop.map((vid) => {
    const s = meshVertexToScreen(vertices[vid], camera, rect, worldRoot);
    return s ? paramAlongPolyline(s, stroke) : 0;
  });

  let minI = 0;
  let maxI = 0;
  for (let k = 0; k < loop.length; k++) {
    if (params[k] < params[minI]) minI = k;
    if (params[k] > params[maxI]) maxI = k;
  }
  if (minI === maxI) {
    fanTriangulate(loop, out);
    return;
  }

  const arcA: number[] = [];
  const pA: number[] = [];
  for (let k = minI; ; k = (k + 1) % loop.length) {
    arcA.push(loop[k]);
    pA.push(params[k]);
    if (k === maxI) break;
  }

  const arcB: number[] = [];
  const pB: number[] = [];
  for (let k = minI; ; k = (k - 1 + loop.length) % loop.length) {
    arcB.push(loop[k]);
    pB.push(params[k]);
    if (k === maxI) break;
  }

  ribbonStitch(arcA, pA, arcB, pB, out);
}

/** Stitch a triangle strip between two arcs that share endpoints, marching by parameter. */
function ribbonStitch(
  arcA: number[],
  pA: number[],
  arcB: number[],
  pB: number[],
  out: Triangle[]
): void {
  let i = 0;
  let j = 0;
  while (i < arcA.length - 1 || j < arcB.length - 1) {
    const canA = i < arcA.length - 1;
    const canB = j < arcB.length - 1;
    const advanceA = canA && (!canB || pA[i + 1] <= pB[j + 1]);
    if (advanceA) {
      if (arcA[i] !== arcB[j] && arcA[i + 1] !== arcB[j] && arcA[i] !== arcA[i + 1]) {
        out.push([arcA[i], arcA[i + 1], arcB[j]]);
      }
      i++;
    } else {
      if (arcA[i] !== arcB[j] && arcA[i] !== arcB[j + 1] && arcB[j] !== arcB[j + 1]) {
        out.push([arcA[i], arcB[j + 1], arcB[j]]);
      }
      j++;
    }
  }
}

/** Fractional arc-length position (0..1) of the polyline point nearest `p`. */
function paramAlongPolyline(p: Vec2, path: Vec2[]): number {
  if (path.length < 2) return 0;

  const segLen: number[] = [];
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const len = Math.hypot(path[i + 1].x - path[i].x, path[i + 1].y - path[i].y);
    segLen.push(len);
    total += len;
  }
  if (total < 1e-9) return 0;

  let bestD2 = Infinity;
  let bestParam = 0;
  let run = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby || 1e-12;
    let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + abx * t;
    const cy = a.y + aby * t;
    const d2 = (p.x - cx) ** 2 + (p.y - cy) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestParam = (run + t * segLen[i]) / total;
    }
    run += segLen[i];
  }
  return bestParam;
}

/** Exported for tests. */
export function keepFacesOnLargerVertexSide(
  leftFaces: Triangle[],
  rightFaces: Triangle[]
): Triangle[] {
  const vertexCount = (faces: Triangle[]) => {
    const ids = new Set<number>();
    for (const [a, b, c] of faces) {
      ids.add(a);
      ids.add(b);
      ids.add(c);
    }
    return ids.size;
  };

  const leftVerts = vertexCount(leftFaces);
  const rightVerts = vertexCount(rightFaces);

  if (leftVerts < rightVerts) return rightFaces;
  if (rightVerts < leftVerts) return leftFaces;
  return leftFaces.length <= rightFaces.length ? rightFaces : leftFaces;
}

function extractTopBoundaryPolygon(vertices: Vec3[], faces: Triangle[]): Vec2[] {
  const edgeUse = new Map<string, number>();
  const addEdge = (a: number, b: number) => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
  };

  for (const [a, b, c] of faces) {
    addEdge(a, b);
    addEdge(b, c);
    addEdge(c, a);
  }

  const boundaryEdges: [number, number][] = [];
  for (const [key, count] of edgeUse) {
    if (count !== 1) continue;
    const [a, b] = key.split('_').map(Number);
    boundaryEdges.push([a, b]);
  }

  const loops = collectLoops(boundaryEdges);
  let best: Vec2[] = [];
  let bestScore = -Infinity;

  for (const loop of loops) {
    const avgZ =
      loop.reduce((s, vid) => s + vertices[vid].z, 0) / Math.max(1, loop.length);
    if (avgZ < -1e-4) continue;

    const poly = loop.map((vid) => ({ x: vertices[vid].x, y: vertices[vid].y }));
    const score = polygonArea(poly) + avgZ * 1e-3;
    if (score > bestScore) {
      bestScore = score;
      best = poly;
    }
  }

  if (best.length >= 3) return cleanRing2(best);

  const topVerts = vertices
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => v.z >= -1e-4)
    .map(({ v }) => ({ x: v.x, y: v.y }));
  return convexHull2(topVerts);
}

function collectLoops(edges: [number, number][]): number[][] {
  const adj = new Map<number, number[]>();
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }

  const used = new Set<string>();
  const loops: number[][] = [];

  for (const [a, b] of edges) {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (used.has(key)) continue;

    const path = [a, b];
    used.add(key);
    let prev = a;
    let cur = b;

    for (let guard = 0; guard < 10000; guard++) {
      const neighbors = adj.get(cur) ?? [];
      let next = -1;
      for (const n of neighbors) {
        if (n === prev) continue;
        const nk = cur < n ? `${cur}_${n}` : `${n}_${cur}`;
        if (!used.has(nk)) {
          next = n;
          break;
        }
      }
      if (next < 0) break;
      const nk = cur < next ? `${cur}_${next}` : `${next}_${cur}`;
      used.add(nk);
      if (next === path[0]) break;
      path.push(next);
      prev = cur;
      cur = next;
    }

    if (path.length >= 3) loops.push(path);
  }

  return loops;
}

function polygonArea(poly: Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    sum += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return Math.abs(sum) / 2;
}

function cleanRing2(points: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    if (out.length === 0 || Math.hypot(out[out.length - 1].x - p.x, out[out.length - 1].y - p.y) > 1.5) {
      out.push(p);
    }
  }
  if (out.length > 2 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < 1.5) {
    out.pop();
  }
  return out;
}

function convexHull2(points: Vec2[]): Vec2[] {
  if (points.length < 3) return points;
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Vec2, a: Vec2, b: Vec2) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  const upper: Vec2[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}
