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
import type { Mesh3D } from './teddyPipeline';

/** Result of imprinting the loop and removing the enclosed front surface. */
export interface ExtrusionBase {
  /** Vertices = original mesh vertices plus the crossing vertices inserted by the cut. */
  vertices: Vec3[];
  /** Faces that survive the cut (front surface inside the loop removed, crossed faces split). */
  keptFaces: Triangle[];
  /** Ordered vertex indices around the opening — these lie on the drawn loop. */
  holeBoundary: number[];
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
  // World↔mesh use the renderer's (x, -y, z) flip (an involution), so the camera in mesh space is:
  const camMesh: Vec3 = { x: camWorld.x, y: -camWorld.y, z: camWorld.z };
  const meshCtr = meshCentroid(mesh.vertices);

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

  // Front test: only the camera-facing sheet should be cut (the bump), not the back sheet that
  // happens to project into the same screen region. We derive each face's *outward* normal from
  // the mesh centroid (winding-independent), then check whether it points toward the camera.
  const facesCamera = (va: Vec3, vb: Vec3, vc: Vec3): boolean => {
    const fcx = (va.x + vb.x + vc.x) / 3;
    const fcy = (va.y + vb.y + vc.y) / 3;
    const fcz = (va.z + vb.z + vc.z) / 3;
    let nx = (vb.y - va.y) * (vc.z - va.z) - (vb.z - va.z) * (vc.y - va.y);
    let ny = (vb.z - va.z) * (vc.x - va.x) - (vb.x - va.x) * (vc.z - va.z);
    let nz = (vb.x - va.x) * (vc.y - va.y) - (vb.y - va.y) * (vc.x - va.x);
    // Flip to outward (pointing away from the mesh centroid).
    if (
      nx * (fcx - meshCtr.x) + ny * (fcy - meshCtr.y) + nz * (fcz - meshCtr.z) < 0
    ) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    return nx * (camMesh.x - fcx) + ny * (camMesh.y - fcy) + nz * (camMesh.z - fcz) > 0;
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
  let backKept = 0;

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

    // The face projects (at least partly) inside the loop. Only cut it if it is on the
    // camera-facing sheet — otherwise it is the back surface and must be kept.
    const va = mesh.vertices[a];
    const vb = mesh.vertices[b];
    const vc = mesh.vertices[c];
    if (!facesCamera(va, vb, vc)) {
      backKept++;
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

  if (removedCount === 0) {
    return { error: 'Loop does not enclose any front surface — draw the loop over the object.' };
  }

  // Orient every face outward (originals are already correct; re-orienting them is a no-op).
  const ref = meshCentroid(mesh.vertices);
  for (let i = 0; i < keptFaces.length; i++) {
    keptFaces[i] = orientFaceOutward(vertices, keptFaces[i], ref);
  }

  const boundary = extractOpeningBoundary(keptFaces, origCount);
  if (!boundary) {
    return { error: 'Could not form a clean opening from the loop — redraw it on the surface.' };
  }

  const ringWorld = boundary.map(
    (i) => new THREE.Vector3(vertices[i].x, -vertices[i].y, vertices[i].z)
  );

  const debug =
    `loopPts=${poly.length}, crossed=${crossed}, wholeRemoved=${wholeRemoved}, ` +
    `backKept=${backKept}, insertedVerts=${vertices.length - origCount}, ` +
    `boundary=${boundary.length}`;

  return { vertices, keptFaces, holeBoundary: boundary, ringWorld, removedCount, debug };
}

function fanTriangulate(poly: number[], out: Triangle[]): void {
  for (let i = 1; i < poly.length - 1; i++) {
    out.push([poly[0], poly[i], poly[i + 1]]);
  }
}

/** Boundary loop of an opening = edges used by exactly one face; prefer the loop on the cut. */
function extractOpeningBoundary(faces: Triangle[], origCount: number): number[] | null {
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
  if (boundaryEdges.length === 0) return null;

  const loops = collectLoops(boundaryEdges);
  if (loops.length === 0) return null;

  // Prefer the loop made of inserted (cut) vertices; break ties by length.
  let best: number[] | null = null;
  let bestScore = -1;
  for (const loop of loops) {
    if (loop.length < 3) continue;
    const inserted = loop.reduce((acc, v) => acc + (v >= origCount ? 1 : 0), 0);
    const score = inserted * 100000 + loop.length;
    if (score > bestScore) {
      bestScore = score;
      best = loop;
    }
  }
  return best;
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
