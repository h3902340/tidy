import * as THREE from 'three';
import type { Mesh3D } from './teddyPipeline';
import type { Vec2, Vec3 } from './math';
import { cross2 } from './math';
import { validateCutCrossesBoundary } from './cutPolygon';

const _world = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _centroid = new THREE.Vector3();
const _viewDir = new THREE.Vector3();

/** Mesh vertex → world (uses mesh object transform when provided). */
export function meshVertexToWorld(v: Vec3, worldRoot?: THREE.Object3D): THREE.Vector3 {
  _world.set(v.x, v.y, v.z);
  if (worldRoot) {
    worldRoot.localToWorld(_world);
    return _world.clone();
  }
  return new THREE.Vector3(v.x, -v.y, v.z);
}

export function prepareCameraForScreenProjection(camera: THREE.Camera): void {
  camera.updateMatrixWorld(true);
  if (camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera) {
    camera.updateProjectionMatrix();
  }
}

/** Project world point to overlay pixel coords (same NDC mapping as raycast strokes). */
export function worldToScreen(
  world: THREE.Vector3,
  camera: THREE.Camera,
  rect: { width: number; height: number }
): Vec2 | null {
  const clip = world.clone().project(camera);
  if (clip.z < -1.02 || clip.z > 1.02) return null;
  const x = ((clip.x + 1) / 2) * rect.width;
  const y = ((-clip.y + 1) / 2) * rect.height;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

export function meshVertexToScreen(
  v: Vec3,
  camera: THREE.Camera,
  rect: { width: number; height: number },
  worldRoot?: THREE.Object3D
): Vec2 | null {
  return worldToScreen(meshVertexToWorld(v, worldRoot), camera, rect);
}

/**
 * View-dependent silhouette in screen space (concave outline from current camera).
 */
export function computeScreenSilhouette(
  mesh: Mesh3D,
  camera: THREE.Camera,
  rect: { width: number; height: number },
  worldRoot?: THREE.Object3D
): Vec2[] {
  prepareCameraForScreenProjection(camera);
  if (worldRoot) {
    worldRoot.updateMatrixWorld(true);
  }

  const edges = collectViewSilhouetteEdges(mesh, camera, worldRoot);
  if (edges.length === 0) return [];

  const screenCache = buildScreenCache(mesh.vertices, camera, rect, worldRoot);
  const loops = traceAllSilhouetteLoops(edges, screenCache);

  let best: Vec2[] = [];
  let bestArea = 0;
  for (const loop of loops) {
    const screen = vertexLoopToScreen(loop, screenCache);
    if (screen.length < 3) continue;
    const area = Math.abs(polygonArea2(screen));
    if (area > bestArea) {
      bestArea = area;
      best = screen;
    }
  }

  if (best.length >= 3) return best;

  // Last resort: hull of silhouette edge endpoints only (not all mesh vertices).
  const pts: Vec2[] = [];
  for (const [a, b] of edges) {
    const sa = screenCache.get(a);
    const sb = screenCache.get(b);
    if (sa) pts.push(sa);
    if (sb) pts.push(sb);
  }
  return convexHull2D(pts);
}

/** Edges where front-facing and back-facing triangles meet (plus open boundary). */
function collectViewSilhouetteEdges(
  mesh: Mesh3D,
  camera: THREE.Camera,
  worldRoot?: THREE.Object3D
): [number, number][] {
  const { vertices, faces } = mesh;
  const camPos = camera.getWorldPosition(new THREE.Vector3());
  const edgeFacing = new Map<string, boolean[]>();

  const addEdge = (i: number, j: number, front: boolean) => {
    const key = edgeKey(i, j);
    const list = edgeFacing.get(key);
    if (list) list.push(front);
    else edgeFacing.set(key, [front]);
  };

  for (const face of faces) {
    const va = meshVertexToWorld(vertices[face[0]], worldRoot);
    const vb = meshVertexToWorld(vertices[face[1]], worldRoot);
    const vc = meshVertexToWorld(vertices[face[2]], worldRoot);

    _normal.copy(vb).sub(va).cross(_centroid.copy(vc).sub(va));
    if (_normal.lengthSq() < 1e-14) continue;
    _normal.normalize();

    _centroid.copy(va).add(vb).add(vc).multiplyScalar(1 / 3);
    _viewDir.copy(camPos).sub(_centroid).normalize();
    const front = _normal.dot(_viewDir) > 1e-5;

    addEdge(face[0], face[1], front);
    addEdge(face[1], face[2], front);
    addEdge(face[2], face[0], front);
  }

  const out: [number, number][] = [];
  for (const [key, sides] of edgeFacing) {
    const [i, j] = key.split('_').map(Number);
    const isSilhouette =
      sides.length === 1 ||
      (sides.length >= 2 && sides.some((s) => s) && sides.some((s) => !s));
    if (isSilhouette) out.push([i, j]);
  }
  return out;
}

function buildScreenCache(
  vertices: Vec3[],
  camera: THREE.Camera,
  rect: { width: number; height: number },
  worldRoot?: THREE.Object3D
): Map<number, Vec2 | null> {
  const cache = new Map<number, Vec2 | null>();
  for (let i = 0; i < vertices.length; i++) {
    cache.set(i, meshVertexToScreen(vertices[i], camera, rect, worldRoot));
  }
  return cache;
}

function vertexLoopToScreen(loop: number[], screenCache: Map<number, Vec2 | null>): Vec2[] {
  const out: Vec2[] = [];
  for (const vid of loop) {
    const p = screenCache.get(vid);
    if (p) out.push(p);
  }
  return out;
}

/** Trace every closed loop in the silhouette edge graph. */
function traceAllSilhouetteLoops(
  edges: [number, number][],
  screenCache: Map<number, Vec2 | null>
): number[][] {
  const adj = new Map<number, number[]>();
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }

  const usedEdges = new Set<string>();
  const loops: number[][] = [];
  const loopKeys = new Set<string>();

  for (const [a, b] of edges) {
    const startKey = edgeKey(a, b);
    if (usedEdges.has(startKey)) continue;

    const path = traceLoopFromEdge(a, b, adj, screenCache, usedEdges);
    if (path.length < 3) continue;

    const first = path[0];
    const last = path[path.length - 1];
    if (first !== last && adj.get(first)?.includes(last)) {
      path.push(first);
    }
    if (path[0] !== path[path.length - 1]) continue;

    const core = path.slice(0, -1);
    const key = canonicalLoopKey(core);
    if (loopKeys.has(key)) continue;
    loopKeys.add(key);
    loops.push(core);
  }

  return loops;
}

function traceLoopFromEdge(
  start: number,
  next: number,
  adj: Map<number, number[]>,
  screenCache: Map<number, Vec2 | null>,
  usedEdges: Set<string>
): number[] {
  const path = [start, next];
  usedEdges.add(edgeKey(start, next));

  let prev = start;
  let cur = next;

  for (let guard = 0; guard < 50000; guard++) {
    const neighbors = adj.get(cur) ?? [];
    const candidates = neighbors.filter(
      (n) => n !== prev && !usedEdges.has(edgeKey(cur, n))
    );

    if (candidates.length === 0) break;

    const nxt =
      candidates.length === 1
        ? candidates[0]
        : pickNextSilhouetteVertex(prev, cur, candidates, screenCache);

    if (nxt === start && path.length >= 2) {
      usedEdges.add(edgeKey(cur, nxt));
      path.push(nxt);
      break;
    }

    usedEdges.add(edgeKey(cur, nxt));
    path.push(nxt);
    prev = cur;
    cur = nxt;
  }

  return path;
}

/**
 * At a junction, follow the exterior contour in screen space (clockwise in y-down coords).
 */
function pickNextSilhouetteVertex(
  prev: number,
  cur: number,
  candidates: number[],
  screenCache: Map<number, Vec2 | null>
): number {
  const c = screenCache.get(cur);
  if (!c) return candidates[0];

  let inAngle = -Math.PI / 2;
  if (prev >= 0) {
    const p = screenCache.get(prev);
    if (p) {
      inAngle = Math.atan2(-(p.y - c.y), p.x - c.x);
    }
  }

  let best = candidates[0];
  let bestDelta = Infinity;

  for (const n of candidates) {
    const t = screenCache.get(n);
    if (!t) continue;
    const outAngle = Math.atan2(-(t.y - c.y), t.x - c.x);
    let delta = outAngle - inAngle;
    while (delta <= 1e-9) delta += Math.PI * 2;
    if (delta < bestDelta) {
      bestDelta = delta;
      best = n;
    }
  }

  return best;
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

function canonicalLoopKey(loop: number[]): string {
  if (loop.length === 0) return '';
  let minIdx = 0;
  for (let i = 1; i < loop.length; i++) {
    if (loop[i] < loop[minIdx]) minIdx = i;
  }
  const rotated = [...loop.slice(minIdx), ...loop.slice(0, minIdx)];
  const rev = [...rotated].reverse();
  const fwd = rotated.join(',');
  const bwd = rev.join(',');
  return fwd < bwd ? fwd : bwd;
}

function convexHull2D(points: Vec2[]): Vec2[] {
  if (points.length < 3) return points;

  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const lower: Vec2[] = [];
  const upper: Vec2[] = [];

  for (const p of sorted) {
    while (lower.length >= 2 && cross2(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross2(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function polygonArea2(poly: Vec2[]): number {
  let sum = 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return sum / 2;
}

export function validateScreenCut(
  mesh: Mesh3D,
  screenStroke: Vec2[],
  camera: THREE.Camera,
  domElement: HTMLElement,
  worldRoot?: THREE.Object3D
) {
  const rect = domElement.getBoundingClientRect();
  const silhouette = computeScreenSilhouette(mesh, camera, rect, worldRoot);
  if (silhouette.length < 3) {
    return { error: 'Could not compute object silhouette from the current view.' };
  }
  const result = validateCutCrossesBoundary(silhouette, screenStroke);
  if ('error' in result) return result;
  return { ok: true as const, silhouette: result.silhouette, hits: result.hits };
}

/** Screen-space left of directed cut chord (Teddy removes this side). */
export function isScreenLeftOfCut(
  point: Vec2,
  entry: Vec2,
  exit: Vec2
): boolean {
  return cross2(entry, exit, point) > 1e-6;
}
