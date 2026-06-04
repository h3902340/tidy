/**
 * Extrusion operation from Teddy §5.3 (Igarashi, Matsuoka, Tanaka, SIGGRAPH 1999).
 *
 * A two-stroke gesture:
 *   1. a closed base ring drawn on the front surface, and
 *   2. an extruding stroke depicting the silhouette of the swept surface.
 *
 * The loop is imprinted onto the mesh (`imprintLoop`): triangles the loop passes through are
 * split along it and the interior pieces are removed, so the opening boundary follows the drawn
 * loop exactly. That opening boundary *is* the base ring — no collar is needed, the sweep welds
 * directly onto it. The 2D extruding stroke is projected onto a plane through the ring's centre
 * of gravity that is parallel to the ring normal and faces the camera as much as possible (paper
 * fig. 17a). The base ring is then swept along the projected stroke: a layer of vertices is
 * emitted at each step (resized to fit the stroke via the two-pointer rule of fig. 18a),
 * consecutive layers are connected and triangulated into quads, and the far end is capped
 * (fig. 18b).
 *
 * @see https://www-ui.is.s.u-tokyo.ac.jp/~takeo/papers/siggraph99.pdf
 */
import * as THREE from 'three';
import type { Mesh3D } from './teddyPipeline';
import type { Vec2, Vec3 } from './math';
import { meshCentroid, orientFaceOutward, type Triangle } from './meshWinding';
import { constrainedDelaunay } from './cdt';
import { extractAllOpeningBoundaries, type ExtrusionBase } from './loopImprint';

export { imprintLoop } from './loopImprint';
export type { ExtrusionBase } from './loopImprint';

/** Number of swept layers between the base ring and the tip. */
const TARGET_LAYERS = 28;
const MIN_LAYERS = 8;
const MAX_LAYERS = 60;
/** View-ray densification for the extruding stroke before plane projection. */
const STROKE_SAMPLES = 6;

interface PlanePoint {
  /** Coordinate along the in-plane lateral axis W. */
  u: number;
  /** Coordinate along the ring normal N (extrusion height). */
  h: number;
}

export type ExtrudeResult = { mesh: Mesh3D; layerCount: number } | { error: string };

/**
 * Loop cut: imprint the loop, remove the enclosed front surface, and fan-fill the opening. The
 * opening boundary is exactly the drawn loop (imprinted), so the fill caps that loop directly.
 * Shares all geometry prep with extrusion, minus the sweep — a good way to validate the cut.
 */
export function fillLoopHole(mesh: Mesh3D, base: ExtrusionBase): { mesh: Mesh3D } | { error: string } {
  const loops =
    base.holeBoundaries.length > 0
      ? base.holeBoundaries
      : extractAllOpeningBoundaries(base.keptFaces, mesh.vertices.length);
  if (loops.length === 0) return { error: 'Opening is too small to fill.' };

  const vertices: Vec3[] = base.vertices.map((v) => ({ x: v.x, y: v.y, z: v.z }));
  const newFaces: Triangle[] = [];

  for (const boundary of loops) {
    if (boundary.length < 3) continue;
    capOpening(vertices, boundary, newFaces);
  }
  if (newFaces.length === 0) return { error: 'Opening is too small to fill.' };

  const ref = meshCentroid(mesh.vertices);
  for (let i = 0; i < newFaces.length; i++) {
    newFaces[i] = orientFaceOutward(vertices, newFaces[i], ref);
  }

  return { mesh: { vertices, faces: [...base.keptFaces, ...newFaces] } };
}

/**
 * Cap one opening loop with a flat patch. The boundary is projected into its own best-fit plane
 * and triangulated with a constrained Delaunay, so concave openings fill completely (a centroid
 * fan would overlap or leave slivers). Falls back to a centroid fan if the CDT is degenerate.
 */
function capOpening(vertices: Vec3[], boundary: number[], out: Triangle[]): void {
  const R = boundary.length;
  const pts3 = boundary.map((i) => vertices[i]);
  const { origin, u, v } = openingPlaneBasis(pts3);
  const poly2: Vec2[] = pts3.map((p) => {
    const dx = p.x - origin.x;
    const dy = p.y - origin.y;
    const dz = p.z - origin.z;
    return { x: dx * u.x + dy * u.y + dz * u.z, y: dx * v.x + dy * v.y + dz * v.z };
  });

  try {
    const cdt = constrainedDelaunay(poly2);
    if (cdt.triangles.length === 0) throw new Error('degenerate opening');
    for (const t of cdt.triangles) {
      out.push([boundary[t.indices[0]], boundary[t.indices[1]], boundary[t.indices[2]]]);
    }
    return;
  } catch {
    // Fallback: fan to the boundary centroid.
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const p of pts3) {
      cx += p.x;
      cy += p.y;
      cz += p.z;
    }
    const cIdx = vertices.length;
    vertices.push({ x: cx / R, y: cy / R, z: cz / R });
    for (let j = 0; j < R; j++) {
      out.push([cIdx, boundary[j], boundary[(j + 1) % R]]);
    }
  }
}

/** Best-fit plane of a 3D loop: area-weighted normal (Newell) + an orthonormal in-plane basis. */
function openingPlaneBasis(pts: Vec3[]): { origin: Vec3; u: Vec3; v: Vec3 } {
  const origin = { x: 0, y: 0, z: 0 };
  for (const p of pts) {
    origin.x += p.x;
    origin.y += p.y;
    origin.z += p.z;
  }
  const inv = 1 / Math.max(1, pts.length);
  origin.x *= inv;
  origin.y *= inv;
  origin.z *= inv;

  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  const nLen = Math.hypot(nx, ny, nz) || 1;
  const n = { x: nx / nLen, y: ny / nLen, z: nz / nLen };

  const ref = Math.abs(n.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const u = {
    x: ref.y * n.z - ref.z * n.y,
    y: ref.z * n.x - ref.x * n.z,
    z: ref.x * n.y - ref.y * n.x,
  };
  const uLen = Math.hypot(u.x, u.y, u.z) || 1;
  u.x /= uLen;
  u.y /= uLen;
  u.z /= uLen;
  const v = {
    x: n.y * u.z - n.z * u.y,
    y: n.z * u.x - n.x * u.z,
    z: n.x * u.y - n.y * u.x,
  };
  return { origin, u, v };
}

/**
 * Sweep the imprinted opening boundary along the projected extruding stroke. The boundary is
 * already part of the mesh (from `imprintLoop`), so the first layer of quads welds the swept
 * surface directly onto the opening.
 */
export function computeExtrusion(
  base: ExtrusionBase,
  strokeScreen: Vec2[],
  camera: THREE.Camera,
  domElement: HTMLElement
): ExtrudeResult {
  // Layer 0 = the imprinted opening boundary (exact loop shape) — the sweep welds onto it.
  const ring0 = base.ringWorld;
  const R = ring0.length;
  if (R < 3) return { error: 'Base loop is too small to extrude.' };

  const G = centroid(ring0);

  // Ring normal via the signed-area formula in the paper's footnote 2.
  let N = ringNormal(ring0);
  if (N.lengthSq() < 1e-9) return { error: 'Base loop has no well-defined normal.' };
  N.normalize();

  // Orient the normal toward the camera so the extrusion grows outward (front-facing).
  const camPos = camera.getWorldPosition(new THREE.Vector3());
  const viewDir = camPos.clone().sub(G).normalize();
  if (N.dot(viewDir) < 0) N.negate();

  // Projection plane: through G, containing N, facing the camera as much as possible.
  let P = viewDir.clone().addScaledVector(N, -viewDir.dot(N));
  if (P.lengthSq() < 1e-9) P = perpendicular(N);
  P.normalize();
  const W = new THREE.Vector3().crossVectors(N, P).normalize();

  // Base cross-section coordinates in the {W, P} frame (both perpendicular to N).
  const rw: number[] = [];
  const rq: number[] = [];
  for (const r of ring0) {
    const d = r.clone().sub(G);
    rw.push(d.dot(W));
    rq.push(d.dot(P));
  }

  // Project the extruding stroke onto the plane.
  const planePts = projectStrokeToPlane(strokeScreen, camera, domElement, G, P, W, N);
  if (planePts.length < 2) {
    return { error: 'Could not project the extruding stroke onto the extrusion plane.' };
  }

  // Two-pointer sweep (paper fig. 18a) → raw rib centres + widths from base to tip.
  const raw = sweepCenterline(planePts);
  if (raw.centers.length < 2 || !(raw.widths[0] > 1e-3)) {
    return {
      error:
        'Draw the second stroke across the loop — start on one side and end on the other.',
    };
  }

  // Resample the centreline to evenly-spaced, smoothed layers for a smooth sweep.
  const layers = resampleCenterline(raw.centers, raw.widths, layerCount(raw.centers));
  smoothCenterline(layers);
  const w0 = layers.widths[0] > 1e-6 ? layers.widths[0] : 1;
  const L = layers.centers.length;

  const X = layers.centers.map((c) =>
    G.clone().addScaledVector(W, c.u).addScaledVector(N, c.h)
  );
  const tangents: THREE.Vector3[] = X.map((_, i) => {
    const a = X[Math.max(i - 1, 0)];
    const b = X[Math.min(i + 1, L - 1)];
    const t = b.clone().sub(a);
    return t.lengthSq() > 1e-12 ? t.normalize() : N.clone();
  });

  // Vertices start as a copy of the cut mesh (original + imprinted boundary vertices).
  const vertices: Vec3[] = base.vertices.map((v) => ({ x: v.x, y: v.y, z: v.z }));
  const pushWorld = (p: THREE.Vector3): number => {
    vertices.push({ x: p.x, y: -p.y, z: p.z });
    return vertices.length - 1;
  };

  // Layer 0 = the imprinted opening boundary (already in the mesh). Layers 1..L-1 are swept.
  const layerIndices: number[][] = [base.holeBoundary.slice()];

  const Wc = W.clone();
  const Pc = P.clone();
  const dirPrev = N.clone();
  const q = new THREE.Quaternion();

  for (let i = 1; i < L; i++) {
    q.setFromUnitVectors(dirPrev, tangents[i]);
    Wc.applyQuaternion(q).normalize();
    Pc.applyQuaternion(q).normalize();
    dirPrev.copy(tangents[i]);

    const s = layers.widths[i] / w0;
    const idxRow: number[] = [];
    for (let j = 0; j < R; j++) {
      const world = X[i]
        .clone()
        .addScaledVector(Wc, s * rw[j])
        .addScaledVector(Pc, s * rq[j]);
      idxRow.push(pushWorld(world));
    }
    layerIndices.push(idxRow);
  }

  const newFaces: Triangle[] = [];

  // Sew consecutive layers into quads, then triangulate (paper fig. 18b). Layer 0 is the
  // imprinted opening boundary, so layer 0→1 quads weld the sweep onto the mesh directly.
  for (let i = 0; i < L - 1; i++) {
    const cur = layerIndices[i];
    const nxt = layerIndices[i + 1];
    for (let j = 0; j < R; j++) {
      const a = cur[j];
      const b = cur[(j + 1) % R];
      const c = nxt[(j + 1) % R];
      const d = nxt[j];
      newFaces.push([a, b, c]);
      newFaces.push([a, c, d]);
    }
  }

  // Cap the tip with a fan to the last layer's centroid.
  const lastRow = layerIndices[L - 1];
  const tip = new THREE.Vector3();
  for (const idx of lastRow) {
    const v = vertices[idx];
    tip.add(new THREE.Vector3(v.x, -v.y, v.z));
  }
  tip.multiplyScalar(1 / R);
  const tipIdx = pushWorld(tip);
  for (let j = 0; j < R; j++) {
    newFaces.push([tipIdx, lastRow[(j + 1) % R], lastRow[j]]);
  }

  // Orient the new faces outward, using the solid's centroid as an interior point.
  const ref = meshCentroid(base.vertices);
  for (let i = 0; i < newFaces.length; i++) {
    newFaces[i] = orientFaceOutward(vertices, newFaces[i], ref);
  }

  return {
    mesh: { vertices, faces: [...base.keptFaces, ...newFaces] },
    layerCount: L,
  };
}

/** Ring normal (footnote-2 signed-area formula) for a generic Vec3 loop. */
function ringNormalVec(ring: Vec3[]): Vec3 {
  let axy = 0;
  let ayz = 0;
  let azx = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    axy += a.x * b.y - b.x * a.y;
    ayz += a.y * b.z - b.y * a.z;
    azx += a.z * b.x - b.z * a.x;
  }
  return { x: ayz * 0.5, y: azx * 0.5, z: axy * 0.5 };
}

function ringNormal(ring: THREE.Vector3[]): THREE.Vector3 {
  const n = ringNormalVec(ring.map((p) => ({ x: p.x, y: p.y, z: p.z })));
  return new THREE.Vector3(n.x, n.y, n.z);
}

function centroid(points: THREE.Vector3[]): THREE.Vector3 {
  const c = new THREE.Vector3();
  for (const p of points) c.add(p);
  return c.multiplyScalar(1 / Math.max(1, points.length));
}

function perpendicular(n: THREE.Vector3): THREE.Vector3 {
  const ref = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3().crossVectors(n, ref);
}

/** Densify a 2D polyline so plane projection captures its curvature. */
function densify(stroke: Vec2[], samplesPerSegment: number): Vec2[] {
  if (stroke.length < 2) return stroke.slice();
  const out: Vec2[] = [stroke[0]];
  for (let i = 1; i < stroke.length; i++) {
    const a = stroke[i - 1];
    const b = stroke[i];
    for (let s = 1; s <= samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/** Cast view rays through the stroke and intersect the extrusion plane (paper fig. 17a). */
function projectStrokeToPlane(
  stroke: Vec2[],
  camera: THREE.Camera,
  domElement: HTMLElement,
  G: THREE.Vector3,
  P: THREE.Vector3,
  W: THREE.Vector3,
  N: THREE.Vector3
): PlanePoint[] {
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(P, G);
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const rect = domElement.getBoundingClientRect();
  const hit = new THREE.Vector3();
  const out: PlanePoint[] = [];

  for (const p of densify(stroke, STROKE_SAMPLES)) {
    ndc.x = (p.x / rect.width) * 2 - 1;
    ndc.y = -(p.y / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    if (raycaster.ray.intersectPlane(plane, hit)) {
      const d = hit.clone().sub(G);
      out.push({ u: d.dot(W), h: d.dot(N) });
    }
  }

  const cleaned: PlanePoint[] = [];
  for (const pt of out) {
    const prev = cleaned[cleaned.length - 1];
    if (!prev || Math.hypot(pt.u - prev.u, pt.h - prev.h) > 0.5) cleaned.push(pt);
  }
  return cleaned;
}

/**
 * Two-pointer sweep along the extruding stroke (paper fig. 18a). Left/right pointers walk
 * inward from both ends; each step advances whichever side keeps the connecting rib most
 * perpendicular to the local stroke direction. Returns rib centres (base → tip) and widths.
 */
function sweepCenterline(pts: PlanePoint[]): { centers: PlanePoint[]; widths: number[] } {
  const centers: PlanePoint[] = [];
  const widths: number[] = [];
  const record = (l: number, r: number) => {
    centers.push({ u: (pts[l].u + pts[r].u) / 2, h: (pts[l].h + pts[r].h) / 2 });
    widths.push(Math.hypot(pts[l].u - pts[r].u, pts[l].h - pts[r].h));
  };

  let L = 0;
  let R = pts.length - 1;
  record(L, R);

  while (R - L > 1) {
    const candidates: [number, number][] = [];
    if (L + 1 < R) candidates.push([L + 1, R]);
    if (L < R - 1) candidates.push([L, R - 1]);
    if (L + 1 < R - 1) candidates.push([L + 1, R - 1]);
    if (candidates.length === 0) break;

    let best = candidates[0];
    let bestScore = -Infinity;
    for (const cand of candidates) {
      const score = ribScore(pts, cand[0], cand[1]);
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    [L, R] = best;
    record(L, R);
  }

  return { centers, widths };
}

/** Goodness of a rib (paper fig. 18a): higher when the rib is ~perpendicular to the stroke. */
function ribScore(pts: PlanePoint[], l: number, r: number): number {
  const rux = pts[r].u - pts[l].u;
  const ruh = pts[r].h - pts[l].h;
  const rlen = Math.hypot(rux, ruh) || 1;
  const rib = { u: rux / rlen, h: ruh / rlen };
  const tl = strokeTangent(pts, l);
  const tr = strokeTangent(pts, r);
  const dotL = Math.abs(rib.u * tl.u + rib.h * tl.h);
  const dotR = Math.abs(rib.u * tr.u + rib.h * tr.h);
  return -(dotL + dotR);
}

function strokeTangent(pts: PlanePoint[], i: number): PlanePoint {
  const a = pts[Math.max(i - 1, 0)];
  const b = pts[Math.min(i + 1, pts.length - 1)];
  const du = b.u - a.u;
  const dh = b.h - a.h;
  const len = Math.hypot(du, dh) || 1;
  return { u: du / len, h: dh / len };
}

function layerCount(centers: PlanePoint[]): number {
  return Math.max(MIN_LAYERS, Math.min(MAX_LAYERS, Math.max(TARGET_LAYERS, centers.length)));
}

/** Resample the rib centreline to `count` evenly arc-length-spaced layers (centres + widths). */
function resampleCenterline(
  centers: PlanePoint[],
  widths: number[],
  count: number
): { centers: PlanePoint[]; widths: number[] } {
  const n = centers.length;
  if (n < 2) return { centers: centers.slice(), widths: widths.slice() };

  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < n - 1; i++) {
    const l = Math.hypot(centers[i + 1].u - centers[i].u, centers[i + 1].h - centers[i].h);
    seg.push(l);
    total += l;
  }
  if (total < 1e-9) return { centers: [centers[0]], widths: [widths[0]] };

  const outC: PlanePoint[] = [];
  const outW: number[] = [];
  for (let k = 0; k < count; k++) {
    const target = (k / (count - 1)) * total;
    let acc = 0;
    let placed = false;
    for (let i = 0; i < n - 1; i++) {
      if (acc + seg[i] >= target - 1e-9) {
        const t = seg[i] > 1e-9 ? (target - acc) / seg[i] : 0;
        outC.push({
          u: centers[i].u + (centers[i + 1].u - centers[i].u) * t,
          h: centers[i].h + (centers[i + 1].h - centers[i].h) * t,
        });
        outW.push(widths[i] + (widths[i + 1] - widths[i]) * t);
        placed = true;
        break;
      }
      acc += seg[i];
    }
    if (!placed) {
      outC.push({ ...centers[n - 1] });
      outW.push(widths[n - 1]);
    }
  }
  return { centers: outC, widths: outW };
}

/** Light moving-average smoothing of layer centres + widths (keeps the base/tip fixed). */
function smoothCenterline(layers: { centers: PlanePoint[]; widths: number[] }): void {
  const n = layers.centers.length;
  if (n < 3) return;
  for (let pass = 0; pass < 2; pass++) {
    const c = layers.centers.map((p) => ({ ...p }));
    const w = layers.widths.slice();
    for (let i = 1; i < n - 1; i++) {
      layers.centers[i] = {
        u: (c[i - 1].u + 2 * c[i].u + c[i + 1].u) / 4,
        h: (c[i - 1].h + 2 * c[i].h + c[i + 1].h) / 4,
      };
      layers.widths[i] = (w[i - 1] + 2 * w[i] + w[i + 1]) / 4;
    }
  }
}
