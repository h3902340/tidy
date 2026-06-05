/**
 * Imprint a closed screen-space loop onto a mesh, then remove the surface inside it.
 *
 * The opening must trace the *drawn loop*, not the mesh tessellation, so each triangle the loop
 * touches is clipped against the loop polygon: we build a small constrained triangulation of the
 * triangle whose constraints are (a) its boundary, subdivided where the loop crosses each edge, and
 * (b) the loop polyline itself, clipped to the triangle interior. The loop's own points are lifted
 * onto the triangle's plane (camera ray ∩ plane), and edge crossings are placed on the shared edge
 * (bisected to match the screen crossing). Sub-triangles inside the loop on the near sheet are
 * dropped; everything else is kept. Because the loop's points become real vertices, the opening
 * follows the stroke exactly — even when a whole loop sits inside one large triangle.
 *
 * Which enclosed sheet is removed (near vs. occluded far) is decided by a connected flood-fill over
 * the view-ray depth fraction, so bump removal and side-circling keep working.
 *
 * Geometry is computed in mesh space; inside/outside tests use the screen projection (the same
 * (x, -y, z) world flip the renderer applies).
 */
import * as THREE from 'three';
import cdt2d from 'cdt2d';
import {
  cross2,
  edgeKey,
  lerp2,
  lerp3,
  parseEdgeKey,
  windingNumber,
  type Vec2,
  type Vec3,
} from './math';
import { meshCentroid, orientFaceOutward, type Triangle } from './meshWinding';
import { meshVertexToScreen, prepareCameraForScreenProjection } from './screenSilhouette';
import { mesh3DToRaycastObject } from './surfaceProjection';
import type { Mesh3D } from './teddyPipeline';

/** A point where a mesh edge crosses the loop (shared between both adjacent faces → watertight). */
interface EdgeCrossing {
  /** Parameter along the edge from its low-id endpoint to its high-id endpoint, in screen space. */
  ts: number;
  /** Parameter along the loop segment that produced this crossing (for ordering within a triangle). */
  u: number;
  /** Index of the loop segment (poly[k] → poly[k+1]) that produced this crossing. */
  loopSeg: number;
  /** Screen position of the crossing. */
  p2d: Vec2;
  /** Global vertex id of the inserted 3D crossing point. */
  vid: number;
}

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
  const nLoop = poly.length;

  prepareCameraForScreenProjection(camera);
  const camWorld = camera.getWorldPosition(new THREE.Vector3());

  const origCount = mesh.vertices.length;
  const vertices: Vec3[] = mesh.vertices.map((v) => ({ x: v.x, y: v.y, z: v.z }));
  const faceCount = mesh.faces.length;

  // Screen + world (renderer's x,-y,z flip) positions of every original vertex.
  const screenOf: (Vec2 | null)[] = mesh.vertices.map((v) => meshVertexToScreen(v, camera, rect));
  const worldOf = (id: number): Vec3 => ({
    x: mesh.vertices[id].x,
    y: -mesh.vertices[id].y,
    z: mesh.vertices[id].z,
  });

  const vertInsideCache = new Int8Array(origCount).fill(-1);
  const vertexInside = (id: number): boolean => {
    if (vertInsideCache[id] === -1) {
      const s = screenOf[id];
      vertInsideCache[id] = s && windingNumber(s, poly) ? 1 : 0;
    }
    return vertInsideCache[id] === 1;
  };

  // Lift a screen point onto a triangle's plane via camera ray ∩ plane (perspective-correct), so the
  // lifted 3D point projects back exactly to that screen point. wa/wb/wc are world coords.
  const _r0 = new THREE.Vector3();
  const _r1 = new THREE.Vector3();
  const liftToPlane = (px: number, py: number, wa: Vec3, wb: Vec3, wc: Vec3): Vec3 | null => {
    const ndcX = (px / rect.width) * 2 - 1;
    const ndcY = 1 - (py / rect.height) * 2;
    _r0.set(ndcX, ndcY, -1).unproject(camera);
    _r1.set(ndcX, ndcY, 1).unproject(camera);
    const ox = _r0.x;
    const oy = _r0.y;
    const oz = _r0.z;
    const dx = _r1.x - ox;
    const dy = _r1.y - oy;
    const dz = _r1.z - oz;
    const e1x = wb.x - wa.x;
    const e1y = wb.y - wa.y;
    const e1z = wb.z - wa.z;
    const e2x = wc.x - wa.x;
    const e2y = wc.y - wa.y;
    const e2z = wc.z - wa.z;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const denom = dx * nx + dy * ny + dz * nz;
    if (Math.abs(denom) < 1e-12) return null;
    const t = ((wa.x - ox) * nx + (wa.y - oy) * ny + (wa.z - oz) * nz) / denom;
    return { x: ox + dx * t, y: -(oy + dy * t), z: oz + dz * t };
  };

  // Place an edge crossing in 3D: the point on segment (lo,hi) whose screen projection sits at
  // screen-parameter `ts` along the projected edge. Bisection handles the perspective non-linearity.
  const liftEdge = (lo: number, hi: number, ts: number): Vec3 => {
    const a = mesh.vertices[lo];
    const b = mesh.vertices[hi];
    const sLo = screenOf[lo]!;
    const sHi = screenOf[hi]!;
    const dirx = sHi.x - sLo.x;
    const diry = sHi.y - sLo.y;
    const dd = dirx * dirx + diry * diry || 1e-9;
    let loT = 0;
    let hiT = 1;
    for (let i = 0; i < 26; i++) {
      const mid = (loT + hiT) / 2;
      const s = meshVertexToScreen(lerp3(a, b, mid), camera, rect);
      const pm = s ? ((s.x - sLo.x) * dirx + (s.y - sLo.y) * diry) / dd : mid;
      if (pm < ts) loT = mid;
      else hiT = mid;
    }
    return lerp3(a, b, (loT + hiT) / 2);
  };

  // All loop crossings on each mesh edge, keyed by edge so both adjacent faces share the same
  // inserted vertices (watertight). Built once over the unique edge set.
  const edgeCross = new Map<string, EdgeCrossing[]>();
  const seenEdge = new Set<string>();
  for (const face of mesh.faces) {
    for (const [u0, v0] of [
      [face[0], face[1]],
      [face[1], face[2]],
      [face[2], face[0]],
    ] as [number, number][]) {
      const lo = Math.min(u0, v0);
      const hi = Math.max(u0, v0);
      const key = `${lo}_${hi}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      const sLo = screenOf[lo];
      const sHi = screenOf[hi];
      if (!sLo || !sHi) continue;
      const raw: { ts: number; u: number; loopSeg: number }[] = [];
      for (let k = 0; k < nLoop; k++) {
        const r = segSegIntersect(sLo, sHi, poly[k], poly[(k + 1) % nLoop]);
        if (r) raw.push({ ts: r.t, u: r.u, loopSeg: k });
      }
      if (raw.length === 0) continue;
      raw.sort((p, q) => p.ts - q.ts);
      const out: EdgeCrossing[] = [];
      for (const c of raw) {
        if (out.length && Math.abs(out[out.length - 1].ts - c.ts) < 1e-6) continue;
        const vid = vertices.length;
        vertices.push(liftEdge(lo, hi, c.ts));
        out.push({ ts: c.ts, u: c.u, loopSeg: c.loopSeg, p2d: lerp2(sLo, sHi, c.ts), vid });
      }
      edgeCross.set(key, out);
    }
  }

  // Occlusion depth signal (not normal direction): where does a face's centroid sit between the
  // nearest and farthest surface the view ray pierces? 0 = on the visible near sheet, 1 = on the
  // occluded far sheet. We flood-fill the *connected* near sheet so borderline triangles near the
  // loop edge / silhouette are resolved by connectivity, while the occluded far sheet still blocks
  // the fill (bump removal / side-circling keep working).
  const raycastObj = mesh3DToRaycastObject(mesh);
  const raycaster = new THREE.Raycaster();
  const _wp = new THREE.Vector3();
  const _ndc = new THREE.Vector2();
  const depthFracAt = (cx: number, cy: number, cz: number): number => {
    _wp.set(cx, -cy, cz);
    const centroidDist = camWorld.distanceTo(_wp);
    _wp.project(camera);
    if (_wp.x < -1.05 || _wp.x > 1.05 || _wp.y < -1.05 || _wp.y > 1.05) return Infinity;
    _ndc.set(_wp.x, _wp.y);
    raycaster.setFromCamera(_ndc, camera);
    const hits = raycaster.intersectObject(raycastObj, false);
    if (hits.length === 0) return Infinity;
    const nearest = hits[0].distance;
    const farthest = hits[hits.length - 1].distance;
    const span = farthest - nearest;
    if (span < 1e-6) return 0;
    return (centroidDist - nearest) / span;
  };
  const SEED_FRAC = 0.4;
  const ABSORB_FRAC = 0.75;

  const keptFaces: Triangle[] = [];
  let removedCount = 0;
  let wholeRemoved = 0;
  let crossed = 0;
  let farKept = 0;
  let clipFail = 0;

  // Re-triangulate one face by clipping it against the loop. Drops the loop-interior sub-triangles
  // when `removeNear` (near sheet); keeps the rest. Returns the number of dropped sub-triangles.
  const clipFace = (f: number, removeNear: boolean, interior: number[] | undefined): number => {
    const [ia, ib, ic] = mesh.faces[f];
    const sa = screenOf[ia];
    const sb = screenOf[ib];
    const sc = screenOf[ic];
    if (!sa || !sb || !sc) throw new Error('no-screen');
    const wa = worldOf(ia);
    const wb = worldOf(ib);
    const wc = worldOf(ic);

    const pts: [number, number][] = [];
    const vids: number[] = [];
    const add = (p: Vec2, vid: number): number => {
      pts.push([p.x, p.y]);
      vids.push(vid);
      return pts.length - 1;
    };
    const cornerLocal = [add(sa, ia), add(sb, ib), add(sc, ic)];
    const edges: [number, number][] = [];
    const crossingLocal = new Map<number, number>(); // crossing vid → local index
    const triEdges: [number, number][] = [
      [ia, ib],
      [ib, ic],
      [ic, ia],
    ];

    for (let e = 0; e < 3; e++) {
      const u = triEdges[e][0];
      const v = triEdges[e][1];
      const lo = Math.min(u, v);
      const hi = Math.max(u, v);
      const list = edgeCross.get(`${lo}_${hi}`) ?? [];
      const ordered = u === lo ? list : list.slice().reverse();
      const chain = [cornerLocal[e]];
      for (const cr of ordered) {
        let li = crossingLocal.get(cr.vid);
        if (li === undefined) {
          li = add(cr.p2d, cr.vid);
          crossingLocal.set(cr.vid, li);
        }
        chain.push(li);
      }
      chain.push(cornerLocal[(e + 1) % 3]);
      for (let i = 0; i < chain.length - 1; i++) edges.push([chain[i], chain[i + 1]]);
    }

    // Loop vertices strictly inside the triangle become new vertices on its plane.
    const interiorLocal = new Map<number, number>(); // loop index → local index
    for (const k of interior ?? []) {
      const lifted = liftToPlane(poly[k].x, poly[k].y, wa, wb, wc) ?? baryLift(poly[k], sa, sb, sc, mesh.vertices[ia], mesh.vertices[ib], mesh.vertices[ic]);
      const vid = vertices.length;
      vertices.push(lifted);
      interiorLocal.set(k, add(poly[k], vid));
    }

    // Loop segments, clipped to the triangle interior, become interior constraint edges.
    for (let k = 0; k < nLoop; k++) {
      const segC: { u: number; local: number }[] = [];
      for (let e = 0; e < 3; e++) {
        const u = triEdges[e][0];
        const v = triEdges[e][1];
        const lo = Math.min(u, v);
        const hi = Math.max(u, v);
        for (const cr of edgeCross.get(`${lo}_${hi}`) ?? []) {
          if (cr.loopSeg !== k) continue;
          const li = crossingLocal.get(cr.vid);
          if (li !== undefined) segC.push({ u: cr.u, local: li });
        }
      }
      segC.sort((p, q) => p.u - q.u);
      const seq: number[] = [];
      const startLocal = interiorLocal.get(k);
      if (startLocal !== undefined) seq.push(startLocal);
      for (const s of segC) seq.push(s.local);
      const endLocal = interiorLocal.get((k + 1) % nLoop);
      if (endLocal !== undefined) seq.push(endLocal);
      for (let i = 0; i < seq.length - 1; i++) {
        if (seq[i] !== seq[i + 1]) edges.push([seq[i], seq[i + 1]]);
      }
    }

    const cells = cdt2d(pts, edges, { interior: true, exterior: false, delaunay: true });
    let dropped = 0;
    for (const cell of cells) {
      const [i, j, k] = cell;
      const cxp = (pts[i][0] + pts[j][0] + pts[k][0]) / 3;
      const cyp = (pts[i][1] + pts[j][1] + pts[k][1]) / 3;
      if (removeNear && windingNumber({ x: cxp, y: cyp }, poly)) {
        dropped++;
        continue;
      }
      keptFaces.push([vids[i], vids[j], vids[k]]);
    }
    return dropped;
  };

  try {
    // Classify faces: candidate = touches the loop (a corner inside, an edge crossing, or a loop
    // vertex inside it). needsClip = its boundary is cut by the loop and must be re-triangulated.
    const candidate = new Uint8Array(faceCount);
    const needsClip = new Uint8Array(faceCount);
    const depthFrac = new Float64Array(faceCount).fill(Infinity);
    const interiorLoop = new Array<number[] | undefined>(faceCount);

    for (let f = 0; f < faceCount; f++) {
      const [a, b, c] = mesh.faces[f];
      const sa = screenOf[a];
      const sb = screenOf[b];
      const sc = screenOf[c];
      const inCount =
        (vertexInside(a) ? 1 : 0) + (vertexInside(b) ? 1 : 0) + (vertexInside(c) ? 1 : 0);
      const hasCross =
        edgeCross.has(edgeKey(a, b)) ||
        edgeCross.has(edgeKey(b, c)) ||
        edgeCross.has(edgeKey(c, a));

      let interior: number[] | undefined;
      if (sa && sb && sc) {
        const minx = Math.min(sa.x, sb.x, sc.x);
        const maxx = Math.max(sa.x, sb.x, sc.x);
        const miny = Math.min(sa.y, sb.y, sc.y);
        const maxy = Math.max(sa.y, sb.y, sc.y);
        for (let k = 0; k < nLoop; k++) {
          const p = poly[k];
          if (p.x < minx || p.x > maxx || p.y < miny || p.y > maxy) continue;
          if (strictlyInTri(p, sa, sb, sc)) (interior ??= []).push(k);
        }
      }
      interiorLoop[f] = interior;

      const hasInterior = !!interior && interior.length > 0;
      if (inCount === 0 && !hasCross && !hasInterior) continue;
      candidate[f] = 1;
      needsClip[f] = hasCross || hasInterior || (inCount > 0 && inCount < 3) ? 1 : 0;
      const va = mesh.vertices[a];
      const vb = mesh.vertices[b];
      const vc = mesh.vertices[c];
      depthFrac[f] = depthFracAt(
        (va.x + vb.x + vc.x) / 3,
        (va.y + vb.y + vc.y) / 3,
        (va.z + vb.z + vc.z) / 3
      );
    }

    // Adjacency among candidate faces via shared original mesh edges.
    const edgeToFaces = new Map<string, number[]>();
    for (let f = 0; f < faceCount; f++) {
      if (!candidate[f]) continue;
      const [a, b, c] = mesh.faces[f];
      for (const [u, v] of [
        [a, b],
        [b, c],
        [c, a],
      ] as [number, number][]) {
        const k = edgeKey(u, v);
        const list = edgeToFaces.get(k);
        if (list) list.push(f);
        else edgeToFaces.set(k, [f]);
      }
    }
    const neighborsOf = (f: number): number[] => {
      const [a, b, c] = mesh.faces[f];
      const out: number[] = [];
      for (const [u, v] of [
        [a, b],
        [b, c],
        [c, a],
      ] as [number, number][]) {
        for (const g of edgeToFaces.get(edgeKey(u, v)) ?? []) {
          if (g !== f) out.push(g);
        }
      }
      return out;
    };

    // Flood-fill the connected near sheet (seed confident near faces, absorb up to ABSORB_FRAC).
    const remove = new Uint8Array(faceCount);
    const queue: number[] = [];
    for (let f = 0; f < faceCount; f++) {
      if (candidate[f] && depthFrac[f] < SEED_FRAC) {
        remove[f] = 1;
        queue.push(f);
      }
    }
    if (queue.length === 0) {
      let best = -1;
      let bestFrac = Infinity;
      for (let f = 0; f < faceCount; f++) {
        if (candidate[f] && depthFrac[f] < bestFrac) {
          bestFrac = depthFrac[f];
          best = f;
        }
      }
      if (best >= 0 && bestFrac < ABSORB_FRAC) {
        remove[best] = 1;
        queue.push(best);
      }
    }
    while (queue.length > 0) {
      const f = queue.pop()!;
      for (const g of neighborsOf(f)) {
        if (remove[g] || !candidate[g]) continue;
        if (depthFrac[g] >= ABSORB_FRAC) continue;
        remove[g] = 1;
        queue.push(g);
      }
    }

    for (let f = 0; f < faceCount; f++) {
      const face = mesh.faces[f];
      if (!candidate[f]) {
        keptFaces.push([face[0], face[1], face[2]]);
        continue;
      }
      if (!needsClip[f]) {
        // Fully inside the loop (all corners inside, no crossing): drop if near, else keep whole.
        if (remove[f]) {
          wholeRemoved++;
          removedCount++;
        } else {
          farKept++;
          keptFaces.push([face[0], face[1], face[2]]);
        }
        continue;
      }
      try {
        const dropped = clipFace(f, remove[f] === 1, interiorLoop[f]);
        if (dropped > 0) {
          crossed++;
          removedCount++;
        } else if (!remove[f]) {
          farKept++;
        }
      } catch {
        // Degenerate clip: fall back to a whole-face decision (keeps the mesh sane).
        clipFail++;
        if (remove[f]) {
          wholeRemoved++;
          removedCount++;
        } else {
          keptFaces.push([face[0], face[1], face[2]]);
        }
      }
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
    `farKept=${farKept}, clipFail=${clipFail}, holes=${holeBoundaries.length}, ` +
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

/** Intersect segment (a→b) with segment (c→d); returns params (t along a→b, u along c→d) or null. */
function segSegIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { t: number; u: number } | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null; // parallel / degenerate
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const t = (acx * sy - acy * sx) / denom;
  const u = (acx * ry - acy * rx) / denom;
  const EPS = 1e-7;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return { t: Math.min(1, Math.max(0, t)), u: Math.min(1, Math.max(0, u)) };
}

/** True if `p` is strictly inside triangle (a,b,c), regardless of winding. */
function strictlyInTri(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const EPS = 1e-3;
  const d1 = cross2(a, b, p);
  const d2 = cross2(b, c, p);
  const d3 = cross2(c, a, p);
  return (d1 > EPS && d2 > EPS && d3 > EPS) || (d1 < -EPS && d2 < -EPS && d3 < -EPS);
}

/** Fallback lift when the camera ray is parallel to the triangle: screen-barycentric → mesh space. */
function baryLift(p: Vec2, sa: Vec2, sb: Vec2, sc: Vec2, ma: Vec3, mb: Vec3, mc: Vec3): Vec3 {
  const det = (sb.y - sc.y) * (sa.x - sc.x) + (sc.x - sb.x) * (sa.y - sc.y);
  if (Math.abs(det) < 1e-9) return { x: ma.x, y: ma.y, z: ma.z };
  const l1 = ((sb.y - sc.y) * (p.x - sc.x) + (sc.x - sb.x) * (p.y - sc.y)) / det;
  const l2 = ((sc.y - sa.y) * (p.x - sc.x) + (sa.x - sc.x) * (p.y - sc.y)) / det;
  const l3 = 1 - l1 - l2;
  return {
    x: l1 * ma.x + l2 * mb.x + l3 * mc.x,
    y: l1 * ma.y + l2 * mb.y + l3 * mc.y,
    z: l1 * ma.z + l2 * mb.z + l3 * mc.z,
  };
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
