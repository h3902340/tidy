import type { Vec2, Vec3 } from './math';
import { vec3 } from './math';

export type Triangle = [number, number, number];

function sub3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/** CCW (a,b,c) face normal via cross(edge1, edge2), unnormalized. */
export function faceNormal(vertices: Vec3[], [a, b, c]: Triangle): Vec3 {
  const ba = sub3(vertices[b], vertices[a]);
  const ca = sub3(vertices[c], vertices[a]);
  return cross3(ba, ca);
}

function edgeKey(u: number, v: number): string {
  return u < v ? `${u}_${v}` : `${v}_${u}`;
}

type DirectedEdgeOnFace = { face: number; from: number; to: number };

function buildFaceEdgeAdjacency(faces: Triangle[]): Map<string, DirectedEdgeOnFace[]> {
  const map = new Map<string, DirectedEdgeOnFace[]>();
  const add = (from: number, to: number, face: number) => {
    const key = edgeKey(from, to);
    const list = map.get(key);
    if (list) list.push({ face, from, to });
    else map.set(key, [{ face, from, to }]);
  };

  for (let fi = 0; fi < faces.length; fi++) {
    const [a, b, c] = faces[fi];
    add(a, b, fi);
    add(b, c, fi);
    add(c, a, fi);
  }
  return map;
}

/**
 * Flip a single triangle when cross-product normal points toward interiorPoint.
 * Outward for a genus-0 solid: dot(normal, centroid - interior) > 0.
 */
export function orientFaceOutward(
  vertices: Vec3[],
  face: Triangle,
  interiorPoint: Vec3
): Triangle {
  return outwardAlignment(vertices, face, interiorPoint) < -WINDING_EPS
    ? flipTriangle(face)
    : face;
}

export function flipTriangle(face: Triangle): Triangle {
  return [face[0], face[2], face[1]];
}

export function meshCentroid(vertices: Vec3[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const v of vertices) {
    x += v.x;
    y += v.y;
    z += v.z;
  }
  const n = vertices.length || 1;
  return { x: x / n, y: y / n, z: z / n };
}

export function faceCentroid(vertices: Vec3[], [a, b, c]: Triangle): Vec3 {
  const va = vertices[a];
  const vb = vertices[b];
  const vc = vertices[c];
  return {
    x: (va.x + vb.x + vc.x) / 3,
    y: (va.y + vb.y + vc.y) / 3,
    z: (va.z + vb.z + vc.z) / 3,
  };
}

const WINDING_EPS = 1e-9;
const CAP_Z_EPS = 1e-5;

/**
 * Dot(normal, faceCentroid - referencePoint). Positive => normal points outward
 * relative to referencePoint (typically mesh centroid).
 */
export function outwardAlignment(
  vertices: Vec3[],
  face: Triangle,
  referencePoint: Vec3 = meshCentroid(vertices)
): number {
  const fc = faceCentroid(vertices, face);
  const n = faceNormal(vertices, face);
  const vx = fc.x - referencePoint.x;
  const vy = fc.y - referencePoint.y;
  const vz = fc.z - referencePoint.z;
  return n.x * vx + n.y * vy + n.z * vz;
}

export function isFaceNormalOutward(
  vertices: Vec3[],
  face: Triangle,
  referencePoint?: Vec3
): boolean {
  return outwardAlignment(vertices, face, referencePoint) >= -WINDING_EPS;
}

export interface InwardFaceReport {
  /** Triangle indices whose normals point inward (toward reference). */
  indices: number[];
  /** Per-index alignment dot (negative). */
  alignments: number[];
}

/** Lists every face that fails the outward-normal test. */
export function findInwardFaces(
  vertices: Vec3[],
  faces: Triangle[],
  referencePoint?: Vec3,
  options?: { skipBoundaryFaces?: boolean; boundaryVertexCount?: number; topVertexCount?: number }
): InwardFaceReport {
  const ref = referencePoint ?? meshCentroid(vertices);
  const skipBoundary = options?.skipBoundaryFaces ?? false;
  const boundaryVertexCount = options?.boundaryVertexCount ?? 0;
  const topVertexCount = options?.topVertexCount ?? vertices.length;

  const indices: number[] = [];
  const alignments: number[] = [];

  for (let i = 0; i < faces.length; i++) {
    const face = faces[i];
    if (
      skipBoundary &&
      touchesBoundaryVertex(face, boundaryVertexCount, topVertexCount)
    ) {
      continue;
    }

    const dot = outwardAlignment(vertices, face, ref);
    if (dot < -WINDING_EPS) {
      indices.push(i);
      alignments.push(dot);
    }
  }

  return { indices, alignments };
}

/** Throws with face indices if any normal points inward (toward mesh centroid). */
export function assertAllNormalsOutward(
  vertices: Vec3[],
  faces: Triangle[],
  label = 'mesh'
): void {
  const { indices, alignments } = findInwardFaces(vertices, faces);
  if (indices.length === 0) return;

  const sample = indices.slice(0, 5).map((fi, j) => {
    const f = faces[fi];
    return `#${fi} [${f.join(',')}] alignment=${alignments[j].toExponential(2)}`;
  });

  throw new Error(
    `${label}: ${indices.length} inward-facing triangle(s). Examples: ${sample.join('; ')}`
  );
}

/**
 * Teddy createNormalsAndEnforceCCW: flip triangles whose normal
 * points away from viewDir (camera look direction in mesh space).
 */
export function enforceWindingTowardView(
  vertices: Vec3[],
  faces: Triangle[],
  viewDir: Vec3
): void {
  for (let i = 0; i < faces.length; i++) {
    const face = faces[i];
    const n = faceNormal(vertices, face);
    const dot = n.x * viewDir.x + n.y * viewDir.y + n.z * viewDir.z;
    if (dot < 0) {
      faces[i] = flipTriangle(face);
    }
  }
}

/**
 * Like enforceWindingTowardView but skips steep side walls (quarter-oval strips).
 * Flipping those toward +Z inverts their normals on the closed solid.
 */
export function enforceWindingTowardViewSelective(
  vertices: Vec3[],
  faces: Triangle[],
  viewDir: Vec3,
  minAbsNormalZ = 0.35
): void {
  for (let i = 0; i < faces.length; i++) {
    const face = faces[i];
    const n = faceNormal(vertices, face);
    const len = Math.hypot(n.x, n.y, n.z);
    if (len < 1e-12) continue;
    if (Math.abs(n.z) / len < minAbsNormalZ) continue;
    const dot = n.x * viewDir.x + n.y * viewDir.y + n.z * viewDir.z;
    if (dot < 0) {
      faces[i] = flipTriangle(face);
    }
  }
}

/**
 * Orient each triangle so its normal points away from the mesh centroid (closed solid).
 */
/** Point inside the inflated dome (polygon XY center, Z from elevated spine). */
export function teddyInteriorReference(
  boundaryPolygon: Vec2[],
  vertices: Vec3[]
): Vec3 {
  let cx = 0;
  let cy = 0;
  for (const p of boundaryPolygon) {
    cx += p.x;
    cy += p.y;
  }
  const bn = boundaryPolygon.length || 1;
  cx /= bn;
  cy /= bn;

  const boundaryCount = boundaryPolygon.length;
  let maxZ = 0;
  for (let i = boundaryCount; i < vertices.length; i++) {
    if (vertices[i].z > maxZ) maxZ = vertices[i].z;
  }
  if (maxZ < 1e-6) {
    for (const v of vertices) {
      if (v.z > maxZ) maxZ = v.z;
    }
  }

  return vec3(cx, cy, maxZ * 0.4);
}

export interface ConsistentWindingOptions {
  boundaryVertexCount?: number;
  topVertexCount?: number;
}

/**
 * Orient one face for a closed Teddy solid. Silhouette caps use ±Z; walls use
 * cross(normal, centroid − interior).
 */
export function orientFaceForSolid(
  vertices: Vec3[],
  face: Triangle,
  interiorPoint: Vec3,
  options?: ConsistentWindingOptions
): Triangle {
  const bc = options?.boundaryVertexCount ?? 0;
  const top = options?.topVertexCount ?? vertices.length;
  if (bc === 0 || !touchesBoundaryVertex(face, bc, top)) {
    return orientFaceOutward(vertices, face, interiorPoint);
  }

  const zs = face.map((v) => vertices[v].z);
  const maxZ = Math.max(...zs);
  const minZ = Math.min(...zs);
  const n = faceNormal(vertices, face);

  if (maxZ > CAP_Z_EPS && minZ < -CAP_Z_EPS) {
    return orientFaceOutward(vertices, face, interiorPoint);
  }
  if (maxZ > CAP_Z_EPS) {
    return n.z < -WINDING_EPS ? flipTriangle(face) : face;
  }
  if (minZ < -CAP_Z_EPS) {
    return n.z > WINDING_EPS ? flipTriangle(face) : face;
  }
  return orientFaceOutward(vertices, face, interiorPoint);
}

function pickPropagationSeed(
  vertices: Vec3[],
  faces: Triangle[],
  interiorPoint: Vec3,
  options?: ConsistentWindingOptions
): number {
  const bc = options?.boundaryVertexCount ?? 0;
  const top = options?.topVertexCount ?? vertices.length;

  let seed = 0;
  let best = -Infinity;
  for (let i = 0; i < faces.length; i++) {
    if (bc > 0 && touchesBoundaryVertex(faces[i], bc, top)) continue;
    const fc = faceCentroid(vertices, faces[i]);
    const score =
      outwardAlignment(vertices, faces[i], interiorPoint) + fc.z * 1e-6;
    if (score > best) {
      best = score;
      seed = i;
    }
  }

  if (best === -Infinity) {
    for (let i = 0; i < faces.length; i++) {
      const score = outwardAlignment(vertices, faces[i], interiorPoint);
      if (score > best) {
        best = score;
        seed = i;
      }
    }
  }
  return seed;
}

function propagateFromSeed(
  faces: Triangle[],
  adj: Map<string, DirectedEdgeOnFace[]>,
  oriented: Uint8Array,
  seed: number
): void {
  const queue: number[] = [seed];
  let head = 0;

  while (head < queue.length) {
    const fi = queue[head++];
    const [a, b, c] = faces[fi];
    const directed: [number, number][] = [
      [a, b],
      [b, c],
      [c, a],
    ];

    for (const [u, v] of directed) {
      const key = edgeKey(u, v);
      for (const { face: gj, from, to } of adj.get(key) ?? []) {
        if (oriented[gj]) continue;
        if (from === u && to === v) {
          faces[gj] = flipTriangle(faces[gj]);
        }
        oriented[gj] = 1;
        queue.push(gj);
      }
    }
  }
}

export function enforceOutwardSolidWinding(
  vertices: Vec3[],
  faces: Triangle[],
  referencePoint?: Vec3,
  options?: { skipBoundaryFaces?: boolean; boundaryVertexCount?: number; topVertexCount?: number }
): void {
  const center = referencePoint ?? meshCentroid(vertices);
  const skipBoundary = options?.skipBoundaryFaces ?? false;
  const boundaryVertexCount = options?.boundaryVertexCount ?? 0;
  const topVertexCount = options?.topVertexCount ?? vertices.length;

  for (let i = 0; i < faces.length; i++) {
    const face = faces[i];
    if (
      skipBoundary &&
      touchesBoundaryVertex(face, boundaryVertexCount, topVertexCount)
    ) {
      continue;
    }
    faces[i] = orientFaceOutward(vertices, face, center);
  }
}

/**
 * Propagate a consistent outward orientation across a closed (sphere-like) mesh.
 * Seed face uses cross-product normal vs an interior reference; neighbors flip so
 * shared edges run in opposite directions (manifold consistency).
 */
export function enforceConsistentOutwardWinding(
  vertices: Vec3[],
  faces: Triangle[],
  interiorPoint: Vec3,
  options?: ConsistentWindingOptions
): void {
  if (faces.length === 0) return;

  const adj = buildFaceEdgeAdjacency(faces);
  const oriented = new Uint8Array(faces.length);

  while (true) {
    let seed = -1;
    for (let i = 0; i < faces.length; i++) {
      if (!oriented[i]) {
        seed = i;
        break;
      }
    }
    if (seed < 0) break;

    if (oriented.every((v) => v === 0)) {
      seed = pickPropagationSeed(vertices, faces, interiorPoint, options);
    }

    faces[seed] = orientFaceForSolid(vertices, faces[seed], interiorPoint, options);
    oriented[seed] = 1;
    propagateFromSeed(faces, adj, oriented, seed);
  }
}

function touchesBoundaryVertex(
  face: Triangle,
  boundaryVertexCount: number,
  topVertexCount: number
): boolean {
  for (const v of face) {
    if (v < boundaryVertexCount) return true;
    // Legacy layout: mirrored silhouette ring lived at topVertexCount + i.
    const legacyBack = v - topVertexCount;
    if (
      legacyBack >= 0 &&
      legacyBack < boundaryVertexCount &&
      v >= topVertexCount + boundaryVertexCount
    ) {
      return true;
    }
  }
  return false;
}

/** Top vertex count after drawBackface with a shared silhouette ring. */
export function inflatedTopVertexCount(
  totalVertexCount: number,
  boundaryVertexCount: number
): number {
  return (totalVertexCount + boundaryVertexCount) / 2;
}

/**
 * Faces on the silhouette ring often pass centroid tests but still point into the
 * solid (nz < 0 on the top cap). Force top/bottom caps to face +Z / −Z there.
 */
export function enforceBoundaryCapWinding(
  vertices: Vec3[],
  faces: Triangle[],
  boundaryVertexCount: number,
  topVertexCount: number
): void {
  for (let i = 0; i < faces.length; i++) {
    const face = faces[i];
    if (!touchesBoundaryVertex(face, boundaryVertexCount, topVertexCount)) {
      continue;
    }

    const zs = face.map((v) => vertices[v].z);
    const maxZ = Math.max(...zs);
    const minZ = Math.min(...zs);
    const n = faceNormal(vertices, face);

    if (maxZ > CAP_Z_EPS && n.z < 0) {
      faces[i] = flipTriangle(face);
    } else if (minZ < -CAP_Z_EPS && n.z > 0) {
      faces[i] = flipTriangle(face);
    }
  }
}

/** Top-cap faces on the silhouette with nz < 0 (centroid test misses these). */
export function findBoundaryCapInward(
  vertices: Vec3[],
  faces: Triangle[],
  boundaryVertexCount: number,
  topVertexCount: number
): InwardFaceReport {
  const indices: number[] = [];
  const alignments: number[] = [];

  for (let i = 0; i < faces.length; i++) {
    const face = faces[i];
    if (!touchesBoundaryVertex(face, boundaryVertexCount, topVertexCount)) {
      continue;
    }
    const zs = face.map((v) => vertices[v].z);
    const maxZ = Math.max(...zs);
    const minZ = Math.min(...zs);
    const n = faceNormal(vertices, face);

    const badTop = maxZ > CAP_Z_EPS && n.z < 0;
    const badBottom = minZ < -CAP_Z_EPS && n.z > 0;
    if (badTop || badBottom) {
      indices.push(i);
      alignments.push(n.z);
    }
  }

  return { indices, alignments };
}

/** Flip inward faces one-by-one (run enforceSolidMeshWinding after to restore consistency). */
export function fixInwardFaces(
  vertices: Vec3[],
  faces: Triangle[],
  options?: {
    skipBoundaryFaces?: boolean;
    boundaryVertexCount?: number;
    topVertexCount?: number;
    referencePoint?: Vec3;
    maxPasses?: number;
  }
): void {
  const maxPasses = options?.maxPasses ?? 8;

  for (let pass = 0; pass < maxPasses; pass++) {
    const { indices } = findInwardFaces(
      vertices,
      faces,
      options?.referencePoint,
      options
    );
    if (indices.length === 0) break;
    for (const i of indices) {
      faces[i] = flipTriangle(faces[i]);
    }
  }
}

/**
 * Full solid orientation: manifold propagation + cap-aware seed.
 * Prefer this over per-face flips (they break edge consistency).
 */
export function enforceSolidMeshWinding(
  vertices: Vec3[],
  faces: Triangle[],
  boundaryPolygon: Vec2[],
  topVertexCount: number
): void {
  const interior = teddyInteriorReference(boundaryPolygon, vertices);
  enforceConsistentOutwardWinding(vertices, faces, interior, {
    boundaryVertexCount: boundaryPolygon.length,
    topVertexCount,
  });
}

export function assertBoundaryCapsOutward(
  vertices: Vec3[],
  faces: Triangle[],
  boundaryVertexCount: number,
  topVertexCount: number,
  label = 'mesh'
): void {
  const { indices, alignments } = findBoundaryCapInward(
    vertices,
    faces,
    boundaryVertexCount,
    topVertexCount
  );
  if (indices.length === 0) return;

  const sample = indices.slice(0, 5).map((fi, j) => {
    const f = faces[fi];
    return `#${fi} [${f.join(',')}] nz=${alignments[j].toFixed(4)}`;
  });

  throw new Error(
    `${label}: ${indices.length} boundary cap triangle(s) face inward. Examples: ${sample.join('; ')}`
  );
}
