/**
 * Imprint a closed screen-space loop onto a mesh, then remove the surface inside it.
 *
 * This mirrors the cut tool's `splitMeshAlongScreenStroke`: every front-facing triangle the loop
 * passes through is split along the loop and only the pieces inside the loop are dropped. Where
 * the cut tool classifies vertices by the *signed distance* to an open stroke, we classify them
 * by *inside/outside the closed loop* (screen winding number). The result is an opening whose
 * boundary traces the drawn loop (its vertices lie exactly where the loop crosses mesh edges),
 * and the mesh stays watertight up to that boundary because adjacent triangles share the same
 * crossing vertices.
 *
 * Geometry is computed in mesh space; inside/outside tests use the screen projection (the same
 * (x, -y, z) world flip the renderer applies). Edge crossings are found by bisection along the
 * original edge (perspective makes the screen position non-linear in the edge parameter).
 */
import * as THREE from 'three';
import { edgeKey, lerp3, parseEdgeKey, windingNumber, type Vec2, type Vec3 } from './math';
import { meshCentroid, orientFaceOutward, type Triangle } from './meshWinding';
import { meshVertexToScreen } from './screenSilhouette';
import { mesh3DToRaycastObject } from './surfaceProjection';
import type { Mesh3D } from './teddyPipeline';

/** Result of imprinting the loop and removing the enclosed front surface. */
export interface ExtrusionBase {
  /** Vertices = original mesh vertices plus the crossing vertices inserted by the cut. */
  vertices: Vec3[];
  /** Faces that survive the cut (front surface inside the loop removed, crossed faces split). */
  keptFaces: Triangle[];
  /** Ordered vertex indices around the primary opening (largest imprinted loop). */
  holeBoundary: number[];
  /** Every opening boundary after the cut (a fragmented cut can produce several). */
  holeBoundaries: number[][];
  /** World-space positions of `holeBoundary` (the base ring for filling/sweeping). */
  ringWorld: THREE.Vector3[];
  /** Number of original front faces removed (fully inside) or split by the loop. */
  removedCount: number;
  /** Diagnostic string. */
  debug?: string;
}

export function imprintLoop(
  mesh: Mesh3D,
  loopScreen: Vec2[],
  camera: THREE.Camera,
  domElement: HTMLElement
): ExtrusionBase | { error: string } {
  const rect = domElement.getBoundingClientRect();

  const poly = loopScreen.slice();
  if (
    poly.length > 1 &&
    Math.hypot(poly[0].x - poly[poly.length - 1].x, poly[0].y - poly[poly.length - 1].y) < 1e-6
  ) {
    poly.pop();
  }
  if (poly.length < 3) return { error: 'Loop is too small to enclose any surface.' };

  const camWorld = camera.getWorldPosition(new THREE.Vector3());

  const origCount = mesh.vertices.length;
  const vertices: Vec3[] = mesh.vertices.map((v) => ({ x: v.x, y: v.y, z: v.z }));

  // Inside/outside the loop, per original vertex (cached; null projection => outside).
  const insideScreen = (v: Vec3): boolean => {
    const s = meshVertexToScreen(v, camera, rect);
    return s ? windingNumber(s, poly) : false;
  };
  const insideCache = new Array<number>(origCount).fill(-1); // -1 unknown, 0 out, 1 in
  const insideVertex = (id: number): boolean => {
    if (insideCache[id] === -1) insideCache[id] = insideScreen(mesh.vertices[id]) ? 1 : 0;
    return insideCache[id] === 1;
  };

  // Near/far test (occlusion, not normal direction): a face inside the loop is removed only if it
  // is on the *visible near surface* along the view ray through its centroid — not the surface
  // occluded behind it. This unifies bump removal (cut the near bump, keep the occluded far side)
  // and edge-on rim cuts (both near sheets are visible → both cut; their far halves are kept).
  //
  // For each ray we compare the centroid's depth against the midpoint between the nearest and
  // farthest mesh hits. The near sheet sits at ~nearest (≤ midpoint → cut); the far sheet sits at
  // ~farthest (> midpoint → kept). Using the midpoint auto-scales to the local solid thickness, so
  // no absolute distance tolerance is needed.
  const raycastObj = mesh3DToRaycastObject(mesh);
  const raycaster = new THREE.Raycaster();
  const _wp = new THREE.Vector3();
  const _ndc = new THREE.Vector2();
  const isNearSurface = (cx: number, cy: number, cz: number): boolean => {
    _wp.set(cx, -cy, cz);
    const centroidDist = camWorld.distanceTo(_wp);
    _wp.project(camera);
    if (_wp.x < -1.05 || _wp.x > 1.05 || _wp.y < -1.05 || _wp.y > 1.05) return false;
    _ndc.set(_wp.x, _wp.y);
    raycaster.setFromCamera(_ndc, camera);
    const hits = raycaster.intersectObject(raycastObj, false);
    if (hits.length === 0) return false;
    const nearest = hits[0].distance;
    const farthest = hits[hits.length - 1].distance;
    const midpoint = (nearest + farthest) / 2;
    return centroidDist <= midpoint;
  };

  // Crossing vertex where edge (idA,idB) crosses the loop boundary. Keyed by the original edge
  // so both adjacent triangles reference the same inserted vertex (watertight).
  const crossingCache = new Map<string, number>();
  const crossingVertex = (idA: number, idB: number): number => {
    const lo = Math.min(idA, idB);
    const hi = Math.max(idA, idB);
    const key = `${lo}_${hi}`;
    const cached = crossingCache.get(key);
    if (cached !== undefined) return cached;

    const a = mesh.vertices[lo];
    const b = mesh.vertices[hi];
    const insideLo = insideVertex(lo);
    // Bisect for the loop crossing; the screen winding flips somewhere along the edge.
    let loT = 0;
    let hiT = 1;
    for (let i = 0; i < 32; i++) {
      const mid = (loT + hiT) / 2;
      const inMid = insideScreen(lerp3(a, b, mid));
      if (inMid === insideLo) loT = mid;
      else hiT = mid;
    }
    const t = (loT + hiT) / 2;
    const id = vertices.length;
    vertices.push(lerp3(a, b, t));
    crossingCache.set(key, id);
    return id;
  };

  const keptFaces: Triangle[] = [];
  let removedCount = 0;
  let wholeRemoved = 0;
  let crossed = 0;
  let farKept = 0;

  try {
    for (const face of mesh.faces) {
      const [a, b, c] = face;
      const inA = insideVertex(a);
      const inB = insideVertex(b);
      const inC = insideVertex(c);
      const inCount = (inA ? 1 : 0) + (inB ? 1 : 0) + (inC ? 1 : 0);

      if (inCount === 0) {
        keptFaces.push([a, b, c]); // fully outside the loop
        continue;
      }

      // The face projects (at least partly) inside the loop. Cut it only if it is the visible near
      // surface there — otherwise it is the occluded far surface and must be kept.
      const va = mesh.vertices[a];
      const vb = mesh.vertices[b];
      const vc = mesh.vertices[c];
      const cx = (va.x + vb.x + vc.x) / 3;
      const cy = (va.y + vb.y + vc.y) / 3;
      const cz = (va.z + vb.z + vc.z) / 3;
      if (!isNearSurface(cx, cy, cz)) {
        farKept++;
        keptFaces.push([a, b, c]);
        continue;
      }

      if (inCount === 3) {
        wholeRemoved++; // fully inside the loop → removed
        removedCount++;
        continue;
      }

      // Mixed: split the triangle along the loop. Vertices outside the loop (plus the two edge
      // crossings) form the kept polygon; the inside polygon is dropped.
      crossed++;
      removedCount++;
      const inFlags = [inA, inB, inC];
      const outPoly: number[] = [];
      for (let i = 0; i < 3; i++) {
        const cur = face[i];
        const nxt = face[(i + 1) % 3];
        if (!inFlags[i]) outPoly.push(cur);
        if (inFlags[i] !== inFlags[(i + 1) % 3]) {
          outPoly.push(crossingVertex(cur, nxt));
        }
      }
      fanTriangulate(outPoly, keptFaces);
    }
  } finally {
    raycastObj.geometry.dispose();
    (raycastObj.material as THREE.Material).dispose();
  }

  if (removedCount === 0) {
    return { error: 'Loop does not enclose any front surface — draw the loop over the object.' };
  }

  // Orient every face outward (originals are already correct; re-orienting them is a no-op).
  const ref = meshCentroid(mesh.vertices);
  for (let i = 0; i < keptFaces.length; i++) {
    keptFaces[i] = orientFaceOutward(vertices, keptFaces[i], ref);
  }

  const holeBoundaries = extractAllOpeningBoundaries(keptFaces, origCount);
  if (holeBoundaries.length === 0) {
    return { error: 'Could not form a clean opening from the loop — redraw it on the surface.' };
  }
  const boundary = holeBoundaries[0];

  const ringWorld = boundary.map(
    (i) => new THREE.Vector3(vertices[i].x, -vertices[i].y, vertices[i].z)
  );

  const debug =
    `loopPts=${poly.length}, crossed=${crossed}, wholeRemoved=${wholeRemoved}, ` +
    `farKept=${farKept}, holes=${holeBoundaries.length}, ` +
    `insertedVerts=${vertices.length - origCount}, boundary=${boundary.length}`;

  return {
    vertices,
    keptFaces,
    holeBoundary: boundary,
    holeBoundaries,
    ringWorld,
    removedCount,
    debug,
  };
}

function fanTriangulate(poly: number[], out: Triangle[]): void {
  for (let i = 1; i < poly.length - 1; i++) {
    out.push([poly[0], poly[i], poly[i + 1]]);
  }
}

/**
 * Every opening boundary (edges used by exactly one face), ordered best-first. The "best" loop
 * is the one made mostly of inserted cut vertices (the imprinted opening); ties break by length.
 */
export function extractAllOpeningBoundaries(faces: Triangle[], origCount: number): number[][] {
  const count = new Map<string, number>();
  for (const [a, b, c] of faces) {
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ] as [number, number][]) {
      const k = edgeKey(u, v);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }

  const boundaryEdges: [number, number][] = [];
  for (const [k, c] of count) {
    if (c === 1) boundaryEdges.push(parseEdgeKey(k));
  }
  if (boundaryEdges.length === 0) return [];

  const score = (loop: number[]): number => {
    const inserted = loop.reduce((acc, v) => acc + (v >= origCount ? 1 : 0), 0);
    return inserted * 100000 + loop.length;
  };

  return collectLoops(boundaryEdges)
    .filter((loop) => loop.length >= 3)
    .sort((a, b) => score(b) - score(a));
}

/** Chain undirected edges into ordered vertex loops. */
function collectLoops(edges: [number, number][]): number[][] {
  const adj = new Map<number, number[]>();
  const push = (a: number, b: number) => {
    const list = adj.get(a);
    if (list) list.push(b);
    else adj.set(a, [b]);
  };
  for (const [a, b] of edges) {
    push(a, b);
    push(b, a);
  }

  const used = new Set<string>();
  const loops: number[][] = [];

  for (const [a0, b0] of edges) {
    if (used.has(edgeKey(a0, b0))) continue;
    const path = [a0, b0];
    used.add(edgeKey(a0, b0));
    let prev = a0;
    let cur = b0;

    for (let guard = 0; guard < 1000000; guard++) {
      const neighbors = adj.get(cur) ?? [];
      let next = -1;
      for (const nb of neighbors) {
        if (nb === prev) continue;
        if (!used.has(edgeKey(cur, nb))) {
          next = nb;
          break;
        }
      }
      if (next < 0) break;
      used.add(edgeKey(cur, next));
      if (next === path[0]) break;
      path.push(next);
      prev = cur;
      cur = next;
    }

    if (path.length >= 3) loops.push(path);
  }

  return loops;
}
