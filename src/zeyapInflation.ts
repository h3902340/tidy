/**
 * Teddy inflation pipeline ported from zeyap/teddy (SIGGRAPH 1999 implementation).
 * @see https://github.com/zeyap/teddy
 * @see https://www-ui.is.s.u-tokyo.ac.jp/~takeo/papers/siggraph99.pdf
 */

import type { Triangle2D } from './cdt';
import { faceNormal, flipTriangle, type Triangle } from './meshWinding';
import { dist3, edgeKey, type Vec2, type Vec3, vec3 } from './math';

export interface SemicirclePose {
  edgeA: Vec2;
  edgeB: Vec2;
  center: Vec2;
  interiorRef: Vec2;
  radius: number;
}

export type TerminalPruneStepKind = 'start' | 'advance' | 'stop' | 'fan';

/** Why a terminal prune chain ended before fanning (fig. 14). */
export type TerminalPruneStopReason =
  | 'outside'
  | 'junction'
  | 'exhausted'
  | null;

/** One frame of fig. 14 terminal pruning for debug stepping. */
export interface TerminalPruneDebugStep {
  terminalIndex: number;
  kind: TerminalPruneStepKind;
  semicircle: SemicirclePose;
  activeTriangleId: number;
  consumedTriangleIds: number[];
  /** Vertices collected so far at the stop semicircle (fig. 14c). */
  trackedVertexIds: number[];
  /** Subset of trackedVertexIds outside the stop semicircle (pink markers). */
  outsideVertexIds: number[];
  /** Set on stop frames only. */
  stopReason: TerminalPruneStopReason;
  fanMesh: { vertices: Vec3[]; faces: [number, number, number][] };
}

export interface ZeyapTriangle {
  vertIds: [number, number, number];
  type: 'T' | 'S' | 'J';
  interiorEdges: [number, number][];
  externalEdges: [number, number][];
  centroid?: Vec3;
}

export interface InflatedMesh {
  vertices: Vec3[];
  faces: [number, number, number][];
}

export const SPINE_ELEVATION_FACTOR = 0.5;
const ELEVATION_FACTOR = SPINE_ELEVATION_FACTOR;

function edgeCenter(v1: Vec3, v2: Vec3): Vec3 {
  return vec3((v1.x + v2.x) / 2, (v1.y + v2.y) / 2, (v1.z + v2.z) / 2);
}

function triangleCentroid(verts: Vec3[], ids: [number, number, number]): Vec3 {
  const [a, b, c] = ids;
  return vec3(
    (verts[a].x + verts[b].x + verts[c].x) / 3,
    (verts[a].y + verts[b].y + verts[c].y) / 3,
    (verts[a].z + verts[b].z + verts[c].z) / 3
  );
}

function removeDoublyDefinedEdges(edgeBuffer: [number, number][]): [number, number][] {
  edgeBuffer.sort((e1, e2) => {
    if (e1[0] !== e2[0]) return e1[0] - e2[0];
    return e1[1] - e2[1];
  });

  const out: [number, number][] = [];
  for (let j = 0; j < edgeBuffer.length; j++) {
    const curr = edgeBuffer[j];
    if (
      j > 0 &&
      edgeBuffer[j - 1][0] === curr[0] &&
      edgeBuffer[j - 1][1] === curr[1]
    ) {
      if (
        out.length > 0 &&
        out[out.length - 1][0] === curr[0] &&
        out[out.length - 1][1] === curr[1]
      ) {
        out.pop();
      }
    } else {
      out.push(curr);
    }
  }
  return out;
}

function buildEdgeToTriangleMap(triangles: ZeyapTriangle[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  const key = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);

  for (let ti = 0; ti < triangles.length; ti++) {
    const [a, b, c] = triangles[ti].vertIds;
    for (const [u, v] of [
      [a, b],
      [b, c],
      [a, c],
    ] as [number, number][]) {
      const k = key(u, v);
      const list = map.get(k) ?? [];
      list.push(ti);
      map.set(k, list);
    }
  }
  return map;
}

function sameUndirectedEdge(a: number, b: number, u: number, v: number): boolean {
  return edgeKey(a, b) === edgeKey(u, v);
}

function removeInteriorEdge(
  interiorEdges: [number, number][],
  p1: number,
  p2: number
): void {
  const i = interiorEdges.findIndex(([a, b]) => sameUndirectedEdge(a, b, p1, p2));
  if (i >= 0) interiorEdges.splice(i, 1);
}

export interface PrunedWedge {
  vertIds: [number, number, number];
  spineEdges: [[number, number], [number, number]];
  /** True for fig. 13d fans from terminal pruning; false for S/J subdivision wedges. */
  fromTerminalPrune: boolean;
}

function addSpineNeighbor(
  interiorVerts: Map<number, Map<number, number[]>>,
  spineId: number,
  exteriorId: number
): void {
  if (!interiorVerts.has(spineId)) {
    interiorVerts.set(spineId, new Map());
  }
  const row = interiorVerts.get(spineId)!;
  if (!row.has(exteriorId)) {
    row.set(exteriorId, []);
  }
}

/**
 * Fig. 13f / 15: triangulate an interior edge from an inbound spine vertex to its endpoints.
 * The inbound–mid edge becomes a spine edge in the wedge mesh for quarter-oval sewing.
 */
function addInteriorEdgeWedges(
  inboundSpine: number,
  e0: number,
  e1: number,
  resolveMid: (a: number, b: number) => number,
  prunedTriangles: PrunedWedge[],
  interiorVerts: Map<number, Map<number, number[]>>
): number {
  const midIdx = resolveMid(e0, e1);
  if (inboundSpine === midIdx) return midIdx;

  prunedTriangles.push({
    vertIds: [inboundSpine, midIdx, e0],
    spineEdges: [
      [inboundSpine, e0],
      [midIdx, e0],
    ],
    fromTerminalPrune: false,
  });
  addSpineNeighbor(interiorVerts, inboundSpine, e0);
  addSpineNeighbor(interiorVerts, midIdx, e0);

  prunedTriangles.push({
    vertIds: [inboundSpine, midIdx, e1],
    spineEdges: [
      [inboundSpine, e1],
      [midIdx, e1],
    ],
    fromTerminalPrune: false,
  });
  addSpineNeighbor(interiorVerts, inboundSpine, e1);
  addSpineNeighbor(interiorVerts, midIdx, e1);

  return midIdx;
}

/** J triangle: mid-to-mid chords along the spine perimeter become wedge edges. */
function addJunctionMidChordWedges(
  triangle: ZeyapTriangle,
  resolveMid: (a: number, b: number) => number,
  prunedTriangles: PrunedWedge[],
  interiorVerts: Map<number, Map<number, number[]>>,
  hasAxisEdgeFn: (a: number, b: number) => boolean
): void {
  const edges = triangle.interiorEdges;
  if (edges.length < 2) return;

  const mids = edges.map(([a, b]) => resolveMid(a, b));

  const pushChord = (m0: number, m1: number, shared: number): void => {
    if (m0 === m1 || !hasAxisEdgeFn(m0, m1)) return;
    prunedTriangles.push({
      vertIds: [m0, m1, shared],
      spineEdges: [
        [m0, shared],
        [m1, shared],
      ],
      fromTerminalPrune: false,
    });
    addSpineNeighbor(interiorVerts, m0, shared);
    addSpineNeighbor(interiorVerts, m1, shared);
  };

  if (edges.length === 2) {
    const [e0, e1] = edges;
    const shared = e0.find((v) => e1.includes(v));
    if (shared !== undefined) {
      pushChord(mids[0]!, mids[1]!, shared);
    }
    return;
  }

  for (let i = 0; i < edges.length; i++) {
    const edgeSet = new Set(edges[i]);
    const shared = triangle.vertIds.find((v) => !edgeSet.has(v));
    if (shared === undefined) continue;
    pushChord(mids[i]!, mids[(i + 1) % mids.length]!, shared);
  }
}

/** Sleeve triangle cap: fan from inbound spine across the sole external edge. */
function addSleeveCapWedge(
  inboundSpine: number,
  externalEdge: [number, number],
  prunedTriangles: PrunedWedge[],
  interiorVerts: Map<number, Map<number, number[]>>
): void {
  const [e0, e1] = externalEdge;
  prunedTriangles.push({
    vertIds: [inboundSpine, e0, e1],
    spineEdges: [
      [inboundSpine, e0],
      [inboundSpine, e1],
    ],
    fromTerminalPrune: false,
  });
  addSpineNeighbor(interiorVerts, inboundSpine, e0);
  addSpineNeighbor(interiorVerts, inboundSpine, e1);
}

function collectChordalAxisNodeIds(
  axisSegments: [number, number][],
  boundaryVertexCount: number
): Set<number> {
  const spineNodes = new Set<number>();
  for (const [a, b] of axisSegments) {
    if (a >= boundaryVertexCount) spineNodes.add(a);
    if (b >= boundaryVertexCount) spineNodes.add(b);
  }
  return spineNodes;
}

/** Chordal-axis nodes plus terminal-prune fan tips (targets for §5.2 quarter ovals). */
function collectInflationSpineNodeIds(
  wedges: PrunedWedge[],
  axisSegments: [number, number][],
  boundaryVertexCount: number
): Set<number> {
  const nodes = collectChordalAxisNodeIds(axisSegments, boundaryVertexCount);
  for (const wedge of wedges) {
    if (!wedge.fromTerminalPrune) continue;
    const tip = wedge.vertIds.find((v) => v >= boundaryVertexCount);
    if (tip !== undefined) nodes.add(tip);
  }
  return nodes;
}

/**
 * One interior vertex fanning across a boundary edge (two corners) — paper §5.2
 * quarter-oval topology.
 */
function isSingleSpineBoundaryWedge(
  wedge: PrunedWedge,
  boundaryVertexCount: number
): boolean {
  const boundaryVerts = wedge.vertIds.filter((v) => v < boundaryVertexCount);
  const spineVerts = wedge.vertIds.filter((v) => v >= boundaryVertexCount);
  if (boundaryVerts.length !== 2 || spineVerts.length !== 1) return false;
  const spine = spineVerts[0]!;
  return wedge.spineEdges.every(([s]) => s === spine);
}

/**
 * Fig. 13f centroid hub wedge (off-axis Steiner hub + two corners). Used only for
 * 2D fan triangulation — not inflated in §5.2.
 */
function isFig13fHubWedge(
  wedge: PrunedWedge,
  inflationSpineNodes: Set<number>,
  boundaryVertexCount: number
): boolean {
  if (wedge.fromTerminalPrune) return false;
  if (!isSingleSpineBoundaryWedge(wedge, boundaryVertexCount)) return false;
  const spine = wedge.vertIds.find((v) => v >= boundaryVertexCount)!;
  return !inflationSpineNodes.has(spine);
}

/**
 * Paper §5.2 quarter ovals — terminal fans and axis sleeve caps only.
 */
function isQuarterOvalInflationWedge(
  wedge: PrunedWedge,
  inflationSpineNodes: Set<number>,
  boundaryVertexCount: number
): boolean {
  if (wedge.fromTerminalPrune) return true;
  if (!isSingleSpineBoundaryWedge(wedge, boundaryVertexCount)) return false;
  const spine = wedge.vertIds.find((v) => v >= boundaryVertexCount)!;
  return inflationSpineNodes.has(spine);
}

/**
 * Sleeve/junction chord wedges (two axis-adjacent spine nodes + one boundary corner).
 * Long chords between non-adjacent spine mids are redundant with their neighbor chords.
 */
function isInternalFlatElevationWedge(
  wedge: PrunedWedge,
  inflationSpineNodes: Set<number>,
  boundaryVertexCount: number,
  axisSegments: [number, number][]
): boolean {
  if (isQuarterOvalInflationWedge(wedge, inflationSpineNodes, boundaryVertexCount)) {
    return false;
  }
  if (isFig13fHubWedge(wedge, inflationSpineNodes, boundaryVertexCount)) {
    return false;
  }
  const spineVerts = wedge.vertIds.filter((v) => v >= boundaryVertexCount);
  const boundaryVerts = wedge.vertIds.filter((v) => v < boundaryVertexCount);
  if (spineVerts.length !== 2 || boundaryVerts.length !== 1) return false;
  return hasAxisEdge(spineVerts[0]!, spineVerts[1]!, axisSegments);
}

/** Drop boundary chord wedges whose spine endpoints are not neighbors on the chordal axis. */
function pruneRedundantBoundaryChordWedges(
  wedges: PrunedWedge[],
  axisSegments: [number, number][],
  boundaryVertexCount: number
): void {
  let write = 0;
  for (let read = 0; read < wedges.length; read++) {
    const wedge = wedges[read];
    const spineVerts = wedge.vertIds.filter((v) => v >= boundaryVertexCount);
    const boundaryVerts = wedge.vertIds.filter((v) => v < boundaryVertexCount);
    if (
      !wedge.fromTerminalPrune &&
      spineVerts.length === 2 &&
      boundaryVerts.length === 1 &&
      !hasAxisEdge(spineVerts[0]!, spineVerts[1]!, axisSegments)
    ) {
      continue;
    }
    wedges[write++] = wedge;
  }
  wedges.length = write;
}

function boundaryChordKey(
  s0: number,
  s1: number,
  boundaryCorner: number
): string {
  const a = s0 < s1 ? s0 : s1;
  const b = s0 < s1 ? s1 : s0;
  return `${a}_${b}_${boundaryCorner}`;
}

function collectSpineBoundaryMeshEdges(
  wedges: PrunedWedge[],
  boundaryVertexCount: number
): Map<number, Set<number>> {
  const spineToBoundary = new Map<number, Set<number>>();
  const note = (spineId: number, boundaryId: number) => {
    if (boundaryId >= boundaryVertexCount || spineId < boundaryVertexCount) return;
    if (!spineToBoundary.has(spineId)) {
      spineToBoundary.set(spineId, new Set());
    }
    spineToBoundary.get(spineId)!.add(boundaryId);
  };

  for (const wedge of wedges) {
    const [a, b, c] = wedge.vertIds;
    note(a, b);
    note(a, c);
    note(b, a);
    note(b, c);
    note(c, a);
    note(c, b);
  }
  return spineToBoundary;
}

/**
 * At spine branch points, junction mid-chords only cover mids that share one triangle.
 * Fill axis-adjacent spine pairs that both spoke to the same boundary corner in the wedge
 * mesh but never received a chord wedge (the true source of interior gaps).
 */
function fillMissingAdjacentBoundaryChordWedges(
  wedges: PrunedWedge[],
  axisSegments: [number, number][],
  boundaryVertexCount: number
): void {
  const existing = new Set<string>();
  for (const wedge of wedges) {
    const spineVerts = wedge.vertIds.filter((v) => v >= boundaryVertexCount);
    const boundaryVerts = wedge.vertIds.filter((v) => v < boundaryVertexCount);
    if (spineVerts.length === 2 && boundaryVerts.length === 1) {
      existing.add(
        boundaryChordKey(spineVerts[0]!, spineVerts[1]!, boundaryVerts[0]!)
      );
    }
  }

  const spineToBoundary = collectSpineBoundaryMeshEdges(
    wedges,
    boundaryVertexCount
  );

  for (const [s0, s1] of axisSegments) {
    if (s0 < boundaryVertexCount || s1 < boundaryVertexCount) continue;
    const a = s0 < s1 ? s0 : s1;
    const b = s0 < s1 ? s1 : s0;
    const b0 = spineToBoundary.get(a);
    const b1 = spineToBoundary.get(b);
    if (!b0 || !b1) continue;

    for (const corner of b0) {
      if (!b1.has(corner)) continue;
      const key = boundaryChordKey(a, b, corner);
      if (existing.has(key)) continue;
      existing.add(key);
      wedges.push({
        vertIds: [a, b, corner],
        spineEdges: [
          [a, corner],
          [b, corner],
        ],
        fromTerminalPrune: false,
      });
    }
  }
}

/**
 * After fig. 13f subdivision, paper §5.1 elevates chordal-axis spine nodes using the average
 * distance to boundary vertices that share a mesh edge with the node.
 *
 * Wedge `spineEdges` pair subdivision hubs with interior mids as well as boundary verts;
 * those hubs are Steiner points in the fan mesh, not spine nodes, and must be excluded.
 *
 * Interior-edge midpoints on the chordal axis (fig. 13e/14) are not Steiner points in the
 * fig. 13f hub wedges. Use the boundary endpoints of the interior edge they bisect; if none
 * are boundary, fall back to boundary vertices wedge-connected to an adjacent axis node.
 */
export function buildElevationNeighborsFromWedges(
  wedges: PrunedWedge[],
  axisSegments: [number, number][],
  boundaryVertexCount: number,
  verts: Vec3[],
  interiorEdgeMid: Map<string, number>,
  extraSpineNodes: Iterable<number> = []
): Map<number, Map<number, number[]>> {
  const spineNodes = collectChordalAxisNodeIds(axisSegments, boundaryVertexCount);
  for (const id of extraSpineNodes) {
    if (id >= boundaryVertexCount) spineNodes.add(id);
  }
  const adj = new Map<number, Set<number>>();

  const link = (u: number, v: number): void => {
    if (u === v) return;
    if (!adj.has(u)) adj.set(u, new Set());
    if (!adj.has(v)) adj.set(v, new Set());
    adj.get(u)!.add(v);
    adj.get(v)!.add(u);
  };

  for (const wedge of wedges) {
    const [a, b, c] = wedge.vertIds;
    link(a, b);
    link(b, c);
    link(a, c);
  }

  const interiorVerts = new Map<number, Map<number, number[]>>();
  for (const spineId of spineNodes) {
    for (const neighbor of adj.get(spineId) ?? []) {
      if (neighbor >= boundaryVertexCount) continue;
      addSpineNeighbor(interiorVerts, spineId, neighbor);
    }
  }

  for (const [edgeKey, midId] of interiorEdgeMid) {
    if (!spineNodes.has(midId)) continue;
    if ((interiorVerts.get(midId)?.size ?? 0) > 0) continue;

    const sep = edgeKey.indexOf('_');
    const e0 = Number(edgeKey.slice(0, sep));
    const e1 = Number(edgeKey.slice(sep + 1));
    for (const endpoint of [e0, e1]) {
      if (endpoint < boundaryVertexCount) {
        addSpineNeighbor(interiorVerts, midId, endpoint);
      }
    }
  }

  if (axisSegments.length === 0) return interiorVerts;

  const axisAdj = new Map<number, number[]>();
  for (const [a, b] of axisSegments) {
    (axisAdj.get(a) ?? axisAdj.set(a, []).get(a)!).push(b);
    (axisAdj.get(b) ?? axisAdj.set(b, []).get(b)!).push(a);
  }

  for (const spineId of spineNodes) {
    if ((interiorVerts.get(spineId)?.size ?? 0) > 0) continue;

    const boundaryPool = new Set<number>();
    for (const axisNbr of axisAdj.get(spineId) ?? []) {
      for (const n of adj.get(axisNbr) ?? []) {
        if (n < boundaryVertexCount) boundaryPool.add(n);
      }
    }
    if (boundaryPool.size === 0) continue;

    const ranked = [...boundaryPool].sort(
      (a, b) =>
        dist3(verts[a], verts[spineId]) - dist3(verts[b], verts[spineId])
    );
    for (const exteriorId of ranked.slice(0, 2)) {
      addSpineNeighbor(interiorVerts, spineId, exteriorId);
    }
  }

  return interiorVerts;
}

/** Corner vertex where the two external edges of a terminal triangle meet. */
function terminalCornerVertex(tri: ZeyapTriangle): number | null {
  if (tri.externalEdges.length < 2) return null;
  const [e0, e1] = tri.externalEdges;
  for (const v of e0) {
    if (v === e1[0] || v === e1[1]) return v;
  }
  return null;
}

function terminalFanCoversCorner(
  wedges: PrunedWedge[],
  cornerVid: number
): boolean {
  return wedges.some(
    (w) =>
      w.fromTerminalPrune &&
      (w.vertIds[0] === cornerVid ||
        w.vertIds[1] === cornerVid ||
        w.vertIds[2] === cornerVid)
  );
}

function edgeInList(
  edges: [number, number][],
  a: number,
  b: number
): boolean {
  return edges.some(([u, v]) => sameUndirectedEdge(u, v, a, b));
}

/**
 * Fig. 13f: complete each sleeve/junction triangle from its centroid to edge vertices.
 * Runs after the sleeve walk so spine-edge wedges and hub wedges together fill the
 * mesh between the chordal axis and the boundary (paper fig. 13f).
 */
function subdivideInteriorTrianglesAtCenters(
  triangles: ZeyapTriangle[],
  verts: Vec3[],
  originalInteriorEdges: [number, number][][],
  prunedTriangles: PrunedWedge[],
  hubByTri: Map<number, number>,
  activeInteriorEdges: [number, number][][]
): void {
  const getHub = (triId: number, tri: ZeyapTriangle): number => {
    const cached = hubByTri.get(triId);
    if (cached !== undefined) return cached;
    const c = tri.centroid!;
    const hubIdx = verts.length;
    verts.push(vec3(c.x, c.y, c.z));
    hubByTri.set(triId, hubIdx);
    return hubIdx;
  };

  for (let triId = 0; triId < triangles.length; triId++) {
    const tri = triangles[triId];
    if (tri.type !== 'S' && tri.type !== 'J') continue;

    const [a, b, c] = tri.vertIds;
    const hub = getHub(triId, tri);
    const regions: [number, number][] = [
      [a, b],
      [b, c],
      [c, a],
    ];

    for (const [va, vb] of regions) {
      const wasInterior = edgeInList(originalInteriorEdges[triId], va, vb);
      const stillInterior = edgeInList(activeInteriorEdges[triId], va, vb);
      const isExternal = edgeInList(tri.externalEdges, va, vb);
      if (wasInterior && !stillInterior && !isExternal) continue;

      prunedTriangles.push({
        vertIds: [hub, va, vb],
        spineEdges: [
          [hub, va],
          [hub, vb],
        ],
        fromTerminalPrune: false,
      });
    }
  }
}

/**
 * Corner terminal (T) triangles consumed by a long prune chain may never get
 * fan wedges. Ensure each T corner has fig. 14d fans and a spine tip.
 */
function ensureTerminalFansAtCorners(
  triangles: ZeyapTriangle[],
  verts: Vec3[],
  prunedTriangles: PrunedWedge[],
  interiorVerts: Map<number, Map<number, number[]>>,
  spineEndpointsId: number[],
  spineEndpointsTriangleId: number[],
  spineVertexIds: Set<number>
): void {
  for (let i = 0; i < triangles.length; i++) {
    const tri = triangles[i];
    if (tri.type !== 'T') continue;

    const corner = terminalCornerVertex(tri);
    if (corner === null) continue;
    if (terminalFanCoversCorner(prunedTriangles, corner)) continue;

    const interiorEdge = tri.interiorEdges[0];
    const tipPos = edgeCenter(verts[interiorEdge[0]], verts[interiorEdge[1]]);
    let spineIdx = findCoincidentSpineVertex(verts, tipPos, spineVertexIds);
    const isNewTip = spineIdx === null;
    if (isNewTip) {
      spineIdx = verts.length;
      verts.push(tipPos);
      spineEndpointsId.push(spineIdx);
      spineEndpointsTriangleId.push(i);
      spineVertexIds.add(spineIdx);
    }

    for (const ext of tri.externalEdges) {
      prunedTriangles.push({
        vertIds: [ext[0], ext[1], spineIdx],
        spineEdges: [
          [spineIdx, ext[0]],
          [spineIdx, ext[1]],
        ],
        fromTerminalPrune: true,
      });
      addSpineNeighbor(interiorVerts, spineIdx, ext[0]);
      addSpineNeighbor(interiorVerts, spineIdx, ext[1]);
    }
  }
}

/** Bridge disconnected chordal-axis components (common when J hubs were isolated from sleeve walks). */
function connectAxisComponents(
  segments: [number, number][],
  verts: Vec3[],
  boundaryVertexCount: number
): void {
  const adj = new Map<number, number[]>();
  const segKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const hasSeg = new Set(segments.map(([a, b]) => segKey(a, b)));

  const link = (a: number, b: number) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  };
  for (const [a, b] of segments) link(a, b);

  const spineVerts = [...adj.keys()].filter((v) => v >= boundaryVertexCount);
  if (spineVerts.length < 2) return;

  const componentOf = new Map<number, number>();
  let compId = 0;
  for (const start of spineVerts) {
    if (componentOf.has(start)) continue;
    const q = [start];
    componentOf.set(start, compId);
    while (q.length) {
      const v = q.pop()!;
      for (const n of adj.get(v) ?? []) {
        if (n < boundaryVertexCount || componentOf.has(n)) continue;
        componentOf.set(n, compId);
        q.push(n);
      }
    }
    compId++;
  }
  if (compId <= 1) return;

  const byComp = new Map<number, number[]>();
  for (const v of spineVerts) {
    const c = componentOf.get(v)!;
    const row = byComp.get(c) ?? [];
    row.push(v);
    byComp.set(c, row);
  }

  const reps = [...byComp.values()];
  for (let i = 1; i < reps.length; i++) {
    let bestA = reps[0][0];
    let bestB = reps[i][0];
    let bestD = Infinity;
    for (const a of reps[0]) {
      for (const b of reps[i]) {
        const d = dist3(verts[a], verts[b]);
        if (d < bestD) {
          bestD = d;
          bestA = a;
          bestB = b;
        }
      }
    }
    const key = segKey(bestA, bestB);
    if (hasSeg.has(key)) continue;
    hasSeg.add(key);
    segments.push([bestA, bestB]);
    link(bestA, bestB);
    for (const b of reps[i]) reps[0].push(b);
  }
}

/** Connect terminal fan tips that have no chordal-axis edge yet. */
function linkOrphanFanTipsToAxis(
  segments: [number, number][],
  fanTips: Set<number>,
  verts: Vec3[],
  boundaryVertexCount: number
): void {
  const adj = new Map<number, number[]>();
  const segKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const hasSeg = new Set(segments.map(([a, b]) => segKey(a, b)));

  for (const [a, b] of segments) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }

  for (const tip of fanTips) {
    if ((adj.get(tip)?.length ?? 0) > 0) continue;

    let best = -1;
    let bestD = Infinity;
    for (const [a, b] of segments) {
      for (const v of [a, b]) {
        if (v === tip || v < boundaryVertexCount) continue;
        const d = dist3(verts[tip], verts[v]);
        if (d < bestD) {
          bestD = d;
          best = v;
        }
      }
    }
    if (best < 0) continue;

    const key = segKey(tip, best);
    if (hasSeg.has(key)) continue;
    hasSeg.add(key);
    segments.push([tip, best]);
    if (!adj.has(tip)) adj.set(tip, []);
    if (!adj.has(best)) adj.set(best, []);
    adj.get(tip)!.push(best);
    adj.get(best)!.push(tip);
  }
}

function semicirclePoseFromEdge(
  verts: Vec3[],
  inA: number,
  inB: number,
  interiorRef: Vec2
): SemicirclePose {
  const edgeA = { x: verts[inA].x, y: verts[inA].y };
  const edgeB = { x: verts[inB].x, y: verts[inB].y };
  const center = {
    x: (edgeA.x + edgeB.x) / 2,
    y: (edgeA.y + edgeB.y) / 2,
  };
  return {
    edgeA,
    edgeB,
    center,
    interiorRef,
    radius: dist3(verts[inA], verts[inB]) / 2,
  };
}

/** Third vertex of triangle — same side of the interior edge as triangle X (fig. 14). */
function oppositeVertexId(tri: ZeyapTriangle, inA: number, inB: number): number {
  return tri.vertIds[0] ^ tri.vertIds[1] ^ tri.vertIds[2] ^ inA ^ inB;
}

/**
 * Record fig. 14 terminal-prune frames: semicircle advance per T triangle, then fan wedges.
 * Does not mutate the input mesh — used for debug stepping only.
 */
export function buildTerminalPruneDebugSteps(
  triangles: ZeyapTriangle[],
  verts: Vec3[]
): TerminalPruneDebugStep[] {
  if (triangles.length < 2) return [];

  for (const tri of triangles) {
    if (!tri.centroid) {
      tri.centroid = triangleCentroid(verts, tri.vertIds);
    }
  }

  const triangleDeleted = triangles.map(() => false);
  const edgeToTriangle = buildEdgeToTriangleMap(triangles);
  const steps: TerminalPruneDebugStep[] = [];
  let terminalIndex = 0;

  const fanVertices: Vec3[] = verts.map((v) => vec3(v.x, v.y, v.z));
  const fanFaces: [number, number, number][] = [];

  const pushStep = (
    kind: TerminalPruneStepKind,
    activeTriangleId: number,
    semicircle: SemicirclePose,
    options: {
      trackedVertexIds?: number[];
      outsideVertexIds?: number[];
      stopReason?: TerminalPruneStopReason;
    } = {}
  ) => {
    steps.push({
      terminalIndex,
      kind,
      semicircle,
      activeTriangleId,
      consumedTriangleIds: triangles
        .map((_, i) => i)
        .filter((i) => triangleDeleted[i]),
      trackedVertexIds: options.trackedVertexIds ?? [],
      outsideVertexIds: options.outsideVertexIds ?? [],
      stopReason: options.stopReason ?? null,
      fanMesh: {
        vertices: fanVertices.map((v) => vec3(v.x, v.y, v.z)),
        faces: fanFaces.map((f) => [...f] as [number, number, number]),
      },
    });
  };

  const pushStopStep = (
    activeTriangleId: number,
    semicircle: SemicirclePose,
    trackedVertexIds: number[],
    outsideVertexIds: number[],
    stopReason: Exclude<TerminalPruneStopReason, null>
  ) => {
    const last = steps[steps.length - 1];
    if (last?.kind === 'stop' && last.terminalIndex === terminalIndex) return;
    pushStep('stop', activeTriangleId, semicircle, {
      trackedVertexIds: [...trackedVertexIds],
      outsideVertexIds: [...outsideVertexIds],
      stopReason,
    });
  };

  for (let i = 0; i < triangles.length; i++) {
    if (triangles[i].type !== 'T' || triangleDeleted[i]) continue;

    let triangle = triangles[i];
    let triangleId = i;
    const edgeBuffer: [number, number][] = [];
    const vertBuffer: number[] = [];
    let interiorEdge = triangle.interiorEdges[0];
    let semicircleCenter = edgeCenter(
      verts[interiorEdge[0]],
      verts[interiorEdge[1]]
    );
    const [startA, startB] = interiorEdge;
    const startOpposite = oppositeVertexId(triangle, startA, startB);
    // Fig. 14: semicircle stays on the boundary side of X — anchor to the starting T corner.
    const anchorInteriorRef = {
      x: verts[startOpposite].x,
      y: verts[startOpposite].y,
    };
    pushStep(
      'start',
      triangleId,
      semicirclePoseFromEdge(verts, startA, startB, anchorInteriorRef)
    );

    let lastPose = semicirclePoseFromEdge(verts, startA, startB, anchorInteriorRef);
    let stopReason: Exclude<TerminalPruneStopReason, null> = 'exhausted';

    while (true) {
      triangleDeleted[triangleId] = true;

      const [inA, inB] = interiorEdge;
      semicircleCenter = edgeCenter(verts[inA], verts[inB]);
      const oppositeId =
        triangle.vertIds[0] ^ triangle.vertIds[1] ^ triangle.vertIds[2] ^ inA ^ inB;
      vertBuffer.push(oppositeId);

      const pose = semicirclePoseFromEdge(verts, inA, inB, anchorInteriorRef);
      lastPose = pose;
      pushStep('advance', triangleId, pose, {
        trackedVertexIds: [...vertBuffer],
      });

      if (triangle.type === 'T') {
        for (const ext of triangle.externalEdges) edgeBuffer.push(ext);
      } else if (triangle.type === 'S') {
        for (const ext of triangle.externalEdges) edgeBuffer.push(ext);
      }

      const radius = dist3(semicircleCenter, verts[inA]);
      const outsideVertexIds: number[] = [];
      for (const vid of vertBuffer) {
        if (dist3(semicircleCenter, verts[vid]) > radius + 1e-6) {
          outsideVertexIds.push(vid);
        }
      }
      if (outsideVertexIds.length > 0) {
        pushStopStep(triangleId, pose, vertBuffer, outsideVertexIds, 'outside');
        stopReason = 'outside';
        break;
      }

      const adj =
        edgeToTriangle.get(inA < inB ? `${inA}_${inB}` : `${inB}_${inA}`) ?? [];
      const nextId = adj.find((id) => id !== triangleId);
      if (nextId === undefined || triangleDeleted[nextId]) {
        stopReason = 'exhausted';
        break;
      }

      const nextTri = triangles[nextId];

      triangleId = nextId;
      triangle = nextTri;

      if (triangle.type === 'J') {
        semicircleCenter = triangle.centroid!;
        removeInteriorEdge(triangle.interiorEdges, inA, inB);
        pushStopStep(
          triangleId,
          semicirclePoseFromEdge(verts, inA, inB, anchorInteriorRef),
          vertBuffer,
          [],
          'junction'
        );
        stopReason = 'junction';
        break;
      }

      interiorEdge = triangle.interiorEdges.find(
        ([a, b]) => !sameUndirectedEdge(a, b, inA, inB)
      )!;
      if (!interiorEdge) {
        stopReason = 'exhausted';
        break;
      }
    }

    if (stopReason !== 'outside' && stopReason !== 'junction') {
      pushStopStep(triangleId, lastPose, vertBuffer, [], stopReason);
    }

    const spineIdx = fanVertices.length;
    fanVertices.push(semicircleCenter);

    for (const [e0, e1] of removeDoublyDefinedEdges(edgeBuffer)) {
      fanFaces.push([e0, e1, spineIdx]);
    }

    pushStep('fan', triangleId, {
      ...lastPose,
      center: { x: semicircleCenter.x, y: semicircleCenter.y },
    });

    terminalIndex++;
  }

  return steps;
}

function axisEdgeKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

function hasAxisEdge(
  a: number,
  b: number,
  axisSegments: [number, number][]
): boolean {
  const key = axisEdgeKey(a, b);
  return axisSegments.some(([u, v]) => axisEdgeKey(u, v) === key);
}

const SPINE_VERTEX_COINCIDENT_EPS = 1e-3;

function sameVertexPosition(a: Vec3, b: Vec3, eps = SPINE_VERTEX_COINCIDENT_EPS): boolean {
  return (
    Math.abs(a.x - b.x) < eps &&
    Math.abs(a.y - b.y) < eps &&
    Math.abs(a.z - b.z) < eps
  );
}

/** First spine vertex index at `pos` (fan tips + interior-edge mids only). */
function findCoincidentSpineVertex(
  verts: Vec3[],
  pos: Vec3,
  spineVertexIds: Set<number>
): number | null {
  for (const id of spineVertexIds) {
    if (sameVertexPosition(verts[id], pos)) return id;
  }
  return null;
}

function resolveVertexRemap(id: number, remap: Map<number, number>): number {
  let current = id;
  const seen = new Set<number>();
  while (remap.has(current) && remap.get(current) !== current) {
    if (seen.has(current)) break;
    seen.add(current);
    current = remap.get(current)!;
  }
  return current;
}

function buildCoincidentSpineRemap(
  verts: Vec3[],
  spineVertexIds: Set<number>
): Map<number, number> {
  const ids = [...spineVertexIds].sort((a, b) => a - b);
  const remap = new Map<number, number>();
  for (const id of ids) remap.set(id, id);

  for (const id of ids) {
    const v = verts[id];
    for (const c of ids) {
      if (c >= id) break;
      if (sameVertexPosition(verts[c], v)) {
        remap.set(id, resolveVertexRemap(c, remap));
        break;
      }
    }
  }
  return remap;
}

function dedupeWedges(wedges: PrunedWedge[]): void {
  const seen = new Set<string>();
  const unique: PrunedWedge[] = [];
  for (const wedge of wedges) {
    const sorted = [...wedge.vertIds].sort((a, b) => a - b).join('_');
    const key = `${sorted}:${wedge.fromTerminalPrune ? 1 : 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(wedge);
  }
  wedges.length = 0;
  wedges.push(...unique);
}

/**
 * Multiple terminal fans can intrude the same triangle and create spine vertices at
 * the same location. Merge them to the earliest index and remap wedges + axis.
 */
function deduplicateCoincidentSpineVertices(
  verts: Vec3[],
  boundaryVertexCount: number,
  wedges: PrunedWedge[],
  axisSegments: [number, number][],
  spineEndpointsId: number[],
  spineVertexIds: Set<number>
): void {
  const remap = buildCoincidentSpineRemap(verts, spineVertexIds);
  const hasMerge = [...remap].some(([id, canonical]) => id !== canonical);
  if (!hasMerge) return;

  const resolve = (id: number) => {
    if (id < boundaryVertexCount) return id;
    return remap.has(id) ? resolveVertexRemap(id, remap) : id;
  };

  for (const wedge of wedges) {
    wedge.vertIds = wedge.vertIds.map(resolve) as [number, number, number];
    wedge.spineEdges = wedge.spineEdges.map(
      ([a, b]) => [resolve(a), resolve(b)] as [number, number]
    );
  }

  const segSeen = new Set<string>();
  const mergedSegs: [number, number][] = [];
  for (const [a, b] of axisSegments) {
    const ra = resolve(a);
    const rb = resolve(b);
    if (ra === rb) continue;
    const key = axisEdgeKey(ra, rb);
    if (segSeen.has(key)) continue;
    segSeen.add(key);
    mergedSegs.push([ra, rb]);
  }
  axisSegments.length = 0;
  axisSegments.push(...mergedSegs);

  const uniqueTips: number[] = [];
  const tipSeen = new Set<number>();
  for (const tip of spineEndpointsId) {
    const canonical = resolve(tip);
    if (tipSeen.has(canonical)) continue;
    tipSeen.add(canonical);
    uniqueTips.push(canonical);
  }
  spineEndpointsId.length = 0;
  spineEndpointsId.push(...uniqueTips);

  dedupeWedges(wedges);
}

function fanTipOnInteriorEdge(
  tip: number,
  e0: number,
  e1: number,
  verts: Vec3[]
): boolean {
  const c = edgeCenter(verts[e0], verts[e1]);
  const t = verts[tip];
  return dist3(c, t) < 1e-3;
}

/**
 * At a terminal-fan stop triangle, interior-edge midpoints must connect to the fan
 * tip (fig. 14d–f), not to each other. Sleeve mid-chords on the stop triangle are removed.
 */
function repairFanStopAxis(
  addAxis: (a: number, b: number) => void,
  removeAxis: (a: number, b: number) => void,
  triangles: ZeyapTriangle[],
  postPruneInteriorEdges: [number, number][][],
  originalInteriorEdges: [number, number][][],
  spineEndpointsId: number[],
  spineEndpointsTriangleId: number[],
  resolveMid: (a: number, b: number) => number,
  verts: Vec3[],
  prunedTriangles: PrunedWedge[],
  interiorVerts: Map<number, Map<number, number[]>>
): void {
  const hasMeshEdge = (a: number, b: number): boolean => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    for (const w of prunedTriangles) {
      const [u, v, x] = w.vertIds;
      const edges = [
        u < v ? `${u}_${v}` : `${v}_${u}`,
        v < x ? `${v}_${x}` : `${x}_${v}`,
        u < x ? `${u}_${x}` : `${x}_${u}`,
      ];
      if (edges.includes(key)) return true;
    }
    return false;
  };
  const seen = new Set<string>();

  for (let i = 0; i < spineEndpointsId.length; i++) {
    const tip = spineEndpointsId[i];
    const triId = spineEndpointsTriangleId[i];
    const pairKey = `${tip}_${triId}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);

    const tri = triangles[triId];
    if (!tri) continue;

    // Sleeve walks remove invaded interior edges; use post-prune edges at the fan stop.
    const stopEdges =
      postPruneInteriorEdges[triId]?.length > 0
        ? postPruneInteriorEdges[triId]
        : originalInteriorEdges[triId]?.length > 0
          ? originalInteriorEdges[triId]
          : tri.interiorEdges;

    const mids: number[] = [];
    for (const [a, b] of stopEdges) {
      mids.push(resolveMid(a, b));
    }

    if (tri.type === 'J') {
      for (let e = 0; e < stopEdges.length; e++) {
        const mid = mids[e]!;
        addAxis(tip, mid);
        if (!hasMeshEdge(tip, mid)) {
          const [a, b] = stopEdges[e]!;
          addInteriorEdgeWedges(
            tip,
            a,
            b,
            resolveMid,
            prunedTriangles,
            interiorVerts
          );
        }
      }
    } else if (tri.type === 'S' || tri.type === 'T') {
      for (let e = 0; e < stopEdges.length; e++) {
        const [a, b] = stopEdges[e];
        if (fanTipOnInteriorEdge(tip, a, b, verts)) continue;
        addAxis(tip, mids[e]);
      }
    } else {
      continue;
    }

    for (let j = 0; j < mids.length; j++) {
      for (let k = j + 1; k < mids.length; k++) {
        removeAxis(mids[j], mids[k]);
      }
    }
  }
}

/** Port of zeyap pruneTrianglesAndElevateVertices (Fig. 13–15). */
export function pruneToWedges(
  triangles: ZeyapTriangle[],
  verts: Vec3[]
): {
  wedges: PrunedWedge[];
  interiorVerts: Map<number, Map<number, number[]>>;
  axisSegments: [number, number][];
  subdivisionHubByTri: Map<number, number>;
  junctionHubByTri: Map<number, number>;
  interiorEdgeMid: Map<string, number>;
} {
  if (triangles.length < 2) {
    return {
      wedges: [],
      interiorVerts: new Map(),
      axisSegments: [],
      subdivisionHubByTri: new Map(),
      junctionHubByTri: new Map(),
      interiorEdgeMid: new Map(),
    };
  }

  for (const tri of triangles) {
    if (!tri.centroid) {
      tri.centroid = triangleCentroid(verts, tri.vertIds);
    }
  }

  const originalInteriorEdges = triangles.map((tri) =>
    tri.interiorEdges.map((e) => [...e] as [number, number])
  );

  const boundaryVertexCount = verts.length;
  const subdivisionHubByTri = new Map<number, number>();
  const triangleDeleted: boolean[] = triangles.map(() => false);
  const sleeveProcessed: boolean[] = triangles.map(() => false);
  const prunedTriangles: PrunedWedge[] = [];
  const interiorVerts = new Map<number, Map<number, number[]>>();
  const spineEndpointsId: number[] = [];
  const spineEndpointsTriangleId: number[] = [];
  const spineVertexIds = new Set<number>();
  const axisSegments: [number, number][] = [];
  const hasAxisEdgeLocal = (a: number, b: number) =>
    hasAxisEdge(a, b, axisSegments);
  const addAxis = (a: number, b: number) => {
    if (a === b) return;
    if (a < boundaryVertexCount || b < boundaryVertexCount) return;
    const key = axisEdgeKey(a, b);
    if (axisSegments.some(([u, v]) => axisEdgeKey(u, v) === key)) {
      return;
    }
    axisSegments.push([a, b]);
  };

  const removeAxis = (a: number, b: number) => {
    const key = axisEdgeKey(a, b);
    const idx = axisSegments.findIndex(([u, v]) => axisEdgeKey(u, v) === key);
    if (idx >= 0) axisSegments.splice(idx, 1);
  };

  const interiorEdgeMid = new Map<string, number>();
  const interiorEdgeKey = (a: number, b: number) =>
    a < b ? `${a}_${b}` : `${b}_${a}`;

  const getOrCreateInteriorEdgeMid = (e0: number, e1: number): number => {
    const k = interiorEdgeKey(e0, e1);
    const existing = interiorEdgeMid.get(k);
    if (existing !== undefined) return existing;
    const mid = edgeCenter(verts[e0], verts[e1]);
    const atPos = findCoincidentSpineVertex(verts, mid, spineVertexIds);
    if (atPos !== null) {
      interiorEdgeMid.set(k, atPos);
      return atPos;
    }
    const midIdx = verts.length;
    verts.push(mid);
    interiorEdgeMid.set(k, midIdx);
    spineVertexIds.add(midIdx);
    return midIdx;
  };

  /** Sleeve (S): link interior-edge midpoints on the axis and in the wedge mesh. */
  const connectSleeveAxisMids = (triangle: ZeyapTriangle) => {
    const edges = triangle.interiorEdges;
    const mids = edges.map(([a, b]) => getOrCreateInteriorEdgeMid(a, b));
    for (let j = 0; j < mids.length; j++) {
      addAxis(mids[j], mids[(j + 1) % mids.length]);
    }

    if (edges.length === 2) {
      const [e0, e1] = edges;
      const shared =
        e0[0] === e1[0] || e0[0] === e1[1]
          ? e0[0]
          : e0[1] === e1[0] || e0[1] === e1[1]
            ? e0[1]
            : null;
      if (
        shared !== null &&
        mids[0] !== mids[1] &&
        hasAxisEdgeLocal(mids[0]!, mids[1]!)
      ) {
        prunedTriangles.push({
          vertIds: [mids[0], mids[1], shared],
          spineEdges: [
            [mids[0], shared],
            [mids[1], shared],
          ],
          fromTerminalPrune: false,
        });
        addSpineNeighbor(interiorVerts, mids[0], shared);
        addSpineNeighbor(interiorVerts, mids[1], shared);
      }
    }
  };

  const junctionHubByTri = new Map<number, number>();

  const getJunctionHub = (
    triangleId: number,
    triangle: ZeyapTriangle,
    preferredTip?: number
  ): number => {
    if (preferredTip !== undefined) {
      for (let i = 0; i < spineEndpointsTriangleId.length; i++) {
        if (
          spineEndpointsTriangleId[i] === triangleId &&
          spineEndpointsId[i] === preferredTip
        ) {
          junctionHubByTri.set(triangleId, preferredTip);
          return preferredTip;
        }
      }
    }

    const cached = junctionHubByTri.get(triangleId);
    if (cached !== undefined) return cached;

    for (let i = 0; i < spineEndpointsTriangleId.length; i++) {
      if (spineEndpointsTriangleId[i] === triangleId) {
        const tip = spineEndpointsId[i];
        junctionHubByTri.set(triangleId, tip);
        return tip;
      }
    }

    const c = triangle.centroid!;
    const hubIdx = verts.length;
    verts.push(vec3(c.x, c.y, c.z));
    junctionHubByTri.set(triangleId, hubIdx);
    return hubIdx;
  };

  /**
   * Junction (J) chordal axis (fig. 13e):
   * - Open J: center to every interior-edge midpoint.
   * - Fan at center (fig. 14e–f): fan tip to midpoints of remaining (non-invaded) interior edges only.
   */
  const connectJunctionAxis = (
    triangleId: number,
    triangle: ZeyapTriangle,
    preferredTip?: number
  ) => {
    const hubIdx = getJunctionHub(triangleId, triangle, preferredTip);

    for (const [a, b] of triangle.interiorEdges) {
      const midIdx = getOrCreateInteriorEdgeMid(a, b);
      addAxis(hubIdx, midIdx);
    }
  };

  const edgeToTriangle = buildEdgeToTriangleMap(triangles);

  // --- Terminal pruning (Fig. 14) ---
  for (let i = 0; i < triangles.length; i++) {
    let triangle = triangles[i];
    let triangleId = i;
    if (triangle.type !== 'T' || triangleDeleted[i]) continue;

    const edgeBuffer: [number, number][] = [];
    const vertBuffer: number[] = [];
    let interiorEdge = triangle.interiorEdges[0];
    let semicircleCenter = edgeCenter(
      verts[interiorEdge[0]],
      verts[interiorEdge[1]]
    );
    while (true) {
      triangleDeleted[triangleId] = true;

      const [inA, inB] = interiorEdge;
      semicircleCenter = edgeCenter(verts[inA], verts[inB]);

      const oppositeId = triangle.vertIds[0] ^ triangle.vertIds[1] ^ triangle.vertIds[2] ^ inA ^ inB;
      vertBuffer.push(oppositeId);

      // Collect boundary edges for this triangle before the semicircle stop test (fig. 14d).
      if (triangle.type === 'T') {
        for (const ext of triangle.externalEdges) {
          edgeBuffer.push(ext);
        }
      } else if (triangle.type === 'S') {
        for (const ext of triangle.externalEdges) {
          edgeBuffer.push(ext);
        }
      }

      const radius = dist3(semicircleCenter, verts[inA]);
      let outside = false;
      for (const vid of vertBuffer) {
        if (dist3(semicircleCenter, verts[vid]) > radius + 1e-6) {
          outside = true;
          break;
        }
      }
      if (outside) break;

      const adj = edgeToTriangle.get(
        inA < inB ? `${inA}_${inB}` : `${inB}_${inA}`
      ) ?? [];
      const nextId = adj.find((id) => id !== triangleId);
      if (nextId === undefined || triangleDeleted[nextId]) break;

      const nextTri = triangles[nextId];

      triangleId = nextId;
      triangle = nextTri;

      if (triangle.type === 'J') {
        semicircleCenter = triangle.centroid!;
        removeInteriorEdge(triangle.interiorEdges, inA, inB);
        break;
      }

      interiorEdge = triangle.interiorEdges.find(
        ([a, b]) => !sameUndirectedEdge(a, b, inA, inB)
      )!;
      if (!interiorEdge) break;
    }

    let spineIdx = findCoincidentSpineVertex(
      verts,
      semicircleCenter,
      spineVertexIds
    );
    if (spineIdx === null) {
      spineIdx = verts.length;
      verts.push(semicircleCenter);
      spineVertexIds.add(spineIdx);
    }
    spineEndpointsId.push(spineIdx);
    spineEndpointsTriangleId.push(triangleId);

    for (const [e0, e1] of removeDoublyDefinedEdges(edgeBuffer)) {
      prunedTriangles.push({
        vertIds: [e0, e1, spineIdx],
        spineEdges: [
          [spineIdx, e0],
          [spineIdx, e1],
        ],
        fromTerminalPrune: true,
      });
      addSpineNeighbor(interiorVerts, spineIdx, e0);
      addSpineNeighbor(interiorVerts, spineIdx, e1);
    }
  }

  ensureTerminalFansAtCorners(
    triangles,
    verts,
    prunedTriangles,
    interiorVerts,
    spineEndpointsId,
    spineEndpointsTriangleId,
    spineVertexIds
  );

  const postPruneInteriorEdges = triangles.map((tri) =>
    tri.interiorEdges.map((e) => [...e] as [number, number])
  );

  // --- Sleeve / junction chordal axis (fig. 13e–f): grow from fan tips through S and J ---
  for (let i = 0; i < spineEndpointsId.length; i++) {
    const startTriId = spineEndpointsTriangleId[i];

    const queueTri: number[] = [startTriId];
    const queueVert: number[] = [spineEndpointsId[i]];

    while (queueTri.length > 0) {
      const triangleId = queueTri.shift()!;
      const startVertId = queueVert.shift()!;

      if (sleeveProcessed[triangleId] && triangleId !== startTriId) continue;

      const triangle = triangles[triangleId];
      if (
        !triangle ||
        (triangle.type !== 'S' &&
          triangle.type !== 'T' &&
          triangle.type !== 'J')
      ) {
        continue;
      }

      // Terminal prune marks consumed T (and walked S) deleted; sleeve still subdivides S/J.
      if (
        triangleId !== startTriId &&
        triangleDeleted[triangleId] &&
        triangle.type === 'T'
      ) {
        continue;
      }

      sleeveProcessed[triangleId] = true;
      triangleDeleted[triangleId] = true;

      const sleeveMids =
        triangle.type === 'S'
          ? triangle.interiorEdges.map(([a, b]) =>
              getOrCreateInteriorEdgeMid(a, b)
            )
          : [];
      let sleeveInboundAxis = false;

      for (const e of triangle.interiorEdges) {
        const midIdx = addInteriorEdgeWedges(
          startVertId,
          e[0],
          e[1],
          getOrCreateInteriorEdgeMid,
          prunedTriangles,
          interiorVerts
        );
        const shouldAddInboundAxis =
          startVertId !== midIdx &&
          (triangle.type === 'T' ||
            triangle.type === 'J' ||
            (!sleeveMids.includes(startVertId) && !sleeveInboundAxis));

        if (shouldAddInboundAxis) {
          addAxis(startVertId, midIdx);
          if (triangle.type === 'S') sleeveInboundAxis = true;
        }

        const ek = interiorEdgeKey(e[0], e[1]);
        const adj = edgeToTriangle.get(ek) ?? [];
        const nextId =
          adj.length < 2 ? undefined : adj[0] ^ adj[1] ^ triangleId;
        const next = nextId !== undefined ? triangles[nextId] : undefined;

        if (
          (next?.type === 'S' || next?.type === 'J') &&
          !sleeveProcessed[nextId!]
        ) {
          queueTri.push(nextId!);
          queueVert.push(
            next.type === 'J'
              ? getJunctionHub(nextId!, next)
              : midIdx
          );
          removeInteriorEdge(next.interiorEdges, e[0], e[1]);
        }
      }

      if (triangle.type === 'S') {
        connectSleeveAxisMids(triangle);
        if (triangle.externalEdges.length > 0) {
          addSleeveCapWedge(
            startVertId,
            triangle.externalEdges[0],
            prunedTriangles,
            interiorVerts
          );
        }
      } else if (triangle.type === 'J') {
        connectJunctionAxis(triangleId, triangle, startVertId);
        addJunctionMidChordWedges(
          triangle,
          getOrCreateInteriorEdgeMid,
          prunedTriangles,
          interiorVerts,
          hasAxisEdgeLocal
        );
      }
    }
  }

  repairFanStopAxis(
    addAxis,
    removeAxis,
    triangles,
    postPruneInteriorEdges,
    originalInteriorEdges,
    spineEndpointsId,
    spineEndpointsTriangleId,
    getOrCreateInteriorEdgeMid,
    verts,
    prunedTriangles,
    interiorVerts
  );

  // Open junctions never reached by a sleeve walk (interior J hubs).
  for (let i = 0; i < triangles.length; i++) {
    const triangle = triangles[i];
    if (triangle.type !== 'J' || sleeveProcessed[i]) continue;

    const hubIdx = getJunctionHub(i, triangle);
    connectJunctionAxis(i, triangle);
    for (const e of triangle.interiorEdges) {
      addInteriorEdgeWedges(
        hubIdx,
        e[0],
        e[1],
        getOrCreateInteriorEdgeMid,
        prunedTriangles,
        interiorVerts
      );
    }
    addJunctionMidChordWedges(
      triangle,
      getOrCreateInteriorEdgeMid,
      prunedTriangles,
      interiorVerts,
      hasAxisEdgeLocal
    );
    sleeveProcessed[i] = true;
    triangleDeleted[i] = true;
  }

  subdivideInteriorTrianglesAtCenters(
    triangles,
    verts,
    originalInteriorEdges,
    prunedTriangles,
    subdivisionHubByTri,
    postPruneInteriorEdges
  );

  dedupeWedges(prunedTriangles);

  const chordalGraph =
    axisSegments.length > 0
      ? axisSegments
      : collectChordalAxisSegments(prunedTriangles, boundaryVertexCount);

  const fanTips = new Set(spineEndpointsId);
  const junctionFanTips = new Set<number>();
  for (let i = 0; i < spineEndpointsId.length; i++) {
    const tri = triangles[spineEndpointsTriangleId[i]];
    if (tri?.type === 'J') {
      junctionFanTips.add(spineEndpointsId[i]);
    }
  }

  const trimmedAtFans = trimAxisAtFanTips(
    chordalGraph,
    fanTips,
    verts,
    boundaryVertexCount,
    junctionFanTips
  );

  linkOrphanFanTipsToAxis(
    trimmedAtFans,
    fanTips,
    verts,
    boundaryVertexCount
  );

  connectAxisComponents(trimmedAtFans, verts, boundaryVertexCount);

  // Fig. 13e: branched spine; each branch is a leaf at a terminal-fan tip.
  const branchedSpine = pruneAxisGraphToTrunk(trimmedAtFans, fanTips);

  const chordal =
    branchedSpine.length > 0 ? branchedSpine : trimmedAtFans;

  deduplicateCoincidentSpineVertices(
    verts,
    boundaryVertexCount,
    prunedTriangles,
    chordal,
    spineEndpointsId,
    spineVertexIds
  );

  pruneRedundantBoundaryChordWedges(prunedTriangles, chordal, boundaryVertexCount);
  fillMissingAdjacentBoundaryChordWedges(
    prunedTriangles,
    chordal,
    boundaryVertexCount
  );
  dedupeWedges(prunedTriangles);

  return {
    wedges: prunedTriangles,
    // Fig. 13f is complete — elevation neighbors come from the subdivided wedge mesh only.
    interiorVerts: buildElevationNeighborsFromWedges(
      prunedTriangles,
      chordal,
      boundaryVertexCount,
      verts,
      interiorEdgeMid,
      spineEndpointsId
    ),
    // Paper fig. 13e: the spine is the chordal tree whose leaves land exactly on
    // each terminal fan's apex. The fan's radial spokes (tip -> boundary) belong
    // to the fan drawing (fig. 13d), not the spine, so they are NOT included here.
    axisSegments: chordal,
    subdivisionHubByTri,
    junctionHubByTri,
    interiorEdgeMid,
  };
}

/**
 * Fig. 13f Steiner hubs subdivide sleeve/junction triangles but are not chordal-axis nodes.
 * Inherit elevation from elevated axis nodes in the same triangle so quarter-oval inflation
 * (fig. 15) lifts the interior mesh, not only terminal fans.
 */
export function elevateSubdivisionHubHeights(
  verts: Vec3[],
  subdivisionHubByTri: Map<number, number>,
  junctionHubByTri: Map<number, number>,
  interiorEdgeMid: Map<string, number>,
  triangles: ZeyapTriangle[],
  boundaryVertexCount: number,
  axisSegments: [number, number][]
): void {
  const triVerts = (tri: ZeyapTriangle) => new Set(tri.vertIds);

  for (let triId = 0; triId < triangles.length; triId++) {
    const tri = triangles[triId];
    if (tri.type !== 'S' && tri.type !== 'J') continue;

    const subdivHub = subdivisionHubByTri.get(triId);
    if (subdivHub === undefined) continue;

    const corners = triVerts(tri);
    const zs: number[] = [];
    const jHub = junctionHubByTri.get(triId);
    if (
      jHub !== undefined &&
      jHub >= boundaryVertexCount &&
      verts[jHub].z > 1e-6
    ) {
      zs.push(verts[jHub].z);
    }

    for (const [key, mid] of interiorEdgeMid) {
      const sep = key.indexOf('_');
      const e0 = Number(key.slice(0, sep));
      const e1 = Number(key.slice(sep + 1));
      if (!corners.has(e0) || !corners.has(e1)) continue;
      if (verts[mid].z > 1e-6) zs.push(verts[mid].z);
    }

    if (zs.length > 0) {
      verts[subdivHub].z = zs.reduce((sum, z) => sum + z, 0) / zs.length;
      continue;
    }

    let bestDist = Infinity;
    let bestZ = 0;
    const hubPos = verts[subdivHub];
    for (const [a, b] of axisSegments) {
      for (const id of [a, b]) {
        if (id < boundaryVertexCount || verts[id].z <= 1e-6) continue;
        const d = dist3(hubPos, verts[id]);
        if (d < bestDist) {
          bestDist = d;
          bestZ = verts[id].z;
        }
      }
    }
    if (bestZ > 0) verts[subdivHub].z = bestZ;
  }
}

function minDistToBoundary(
  v: number,
  verts: Vec3[],
  boundaryVertexCount: number
): number {
  let minD = Infinity;
  for (let i = 0; i < boundaryVertexCount; i++) {
    minD = Math.min(minD, dist3(verts[v], verts[i]));
  }
  return minD;
}

/**
 * Terminal-fan tips on T/S: keep a single inbound branch. Junction-fan tips on J
 * (fig. 14e–f): keep every spoke to non-invaded interior-edge midpoints.
 */
function trimAxisAtFanTips(
  segments: [number, number][],
  fanTips: Set<number>,
  verts: Vec3[],
  boundaryVertexCount: number,
  junctionFanTips: Set<number> = new Set()
): [number, number][] {
  if (segments.length === 0 || fanTips.size === 0) return segments;

  const adj = new Map<number, number[]>();
  for (const [a, b] of segments) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }

  const keepKeys = new Set<string>();

  for (const [a, b] of segments) {
    if (!fanTips.has(a) && !fanTips.has(b)) {
      keepKeys.add(axisEdgeKey(a, b));
    }
  }

  for (const tip of fanTips) {
    const neighbors = adj.get(tip) ?? [];
    if (neighbors.length === 0) continue;

    if (junctionFanTips.has(tip)) {
      for (const n of neighbors) {
        keepKeys.add(axisEdgeKey(tip, n));
      }
      continue;
    }

    if (neighbors.length === 1) {
      keepKeys.add(axisEdgeKey(tip, neighbors[0]));
      continue;
    }
    let best = neighbors[0];
    let bestDist = minDistToBoundary(best, verts, boundaryVertexCount);
    for (let i = 1; i < neighbors.length; i++) {
      const n = neighbors[i];
      const d = minDistToBoundary(n, verts, boundaryVertexCount);
      if (d > bestDist) {
        bestDist = d;
        best = n;
      }
    }
    keepKeys.add(axisEdgeKey(tip, best));
  }

  return segments.filter(([a, b]) => keepKeys.has(axisEdgeKey(a, b)));
}

function axisGraphLeaves(segments: [number, number][]): Set<number> {
  const degree = new Map<number, number>();
  for (const [a, b] of segments) {
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
  }
  const leaves = new Set<number>();
  for (const [v, d] of degree) {
    if (d === 1) leaves.add(v);
  }
  return leaves;
}

/**
 * Remove chordal-axis twigs (paper fig. e) while keeping the trunk. Only
 * degree-1 tips of the axis graph are fixed; interior forks are simplified.
 */
export function pruneAxisGraphToTrunk(
  segments: [number, number][],
  spineEndpoints: Set<number> = axisGraphLeaves(segments)
): [number, number][] {
  if (segments.length === 0) return [];
  if (spineEndpoints.size === 0) return segments;

  const adj = new Map<number, Set<number>>();

  const link = (a: number, b: number) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };

  for (const [a, b] of segments) {
    link(a, b);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [v, neighbors] of [...adj]) {
      if (spineEndpoints.has(v) || neighbors.size !== 1) continue;
      const [only] = neighbors;
      neighbors.delete(only);
      adj.get(only)!.delete(v);
      if (adj.get(only)!.size === 0) adj.delete(only);
      adj.delete(v);
      changed = true;
    }
  }

  const out: [number, number][] = [];
  const seen = new Set<string>();
  for (const [a, neighbors] of adj) {
    for (const b of neighbors) {
      if (a > b) continue;
      const key = `${a}_${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([a, b]);
    }
  }
  return out;
}

/** Longest path in the chordal-axis tree — paper fig. e spine for display. */
export function extractAxisTrunkPath(
  segments: [number, number][]
): [number, number][] {
  if (segments.length <= 1) return segments;

  const adj = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };
  for (const [a, b] of segments) {
    link(a, b);
  }

  const bfsFarthest = (start: number) => {
    const dist = new Map<number, number>();
    const parent = new Map<number, number>();
    const queue = [start];
    dist.set(start, 0);
    let farthest = start;

    while (queue.length > 0) {
      const v = queue.shift()!;
      for (const n of adj.get(v) ?? []) {
        if (dist.has(n)) continue;
        dist.set(n, dist.get(v)! + 1);
        parent.set(n, v);
        queue.push(n);
        if (dist.get(n)! > dist.get(farthest)!) farthest = n;
      }
    }
    return { farthest, parent };
  };

  const start = segments[0][0];
  const { farthest: endA } = bfsFarthest(start);
  const { farthest: endB, parent } = bfsFarthest(endA);

  const path: number[] = [endB];
  let cur = endB;
  while (parent.has(cur)) {
    cur = parent.get(cur)!;
    path.push(cur);
  }

  const trunk: [number, number][] = [];
  for (let i = 0; i < path.length - 1; i++) {
    trunk.push([path[i], path[i + 1]]);
  }
  return trunk;
}

export function pruneTrianglesAndElevateVertices(
  triangles: ZeyapTriangle[],
  verts: Vec3[]
): [number, number, number][] {
  if (triangles.length < 2) {
    return triangles.map((tri) => [...tri.vertIds] as [number, number, number]);
  }
  const boundaryVertexCount = verts.length;
  const { wedges, interiorVerts, axisSegments } = pruneToWedges(triangles, verts);
  return elevateVertices(
    wedges,
    interiorVerts,
    verts,
    axisSegments,
    boundaryVertexCount
  );
}

function pointToSegmentDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Shortest distance from a point to the polygon silhouette (local shape width). */
export function minDistToPolygonBoundary(p: Vec2, polygon: Vec2[]): number {
  const n = polygon.length;
  if (n < 3) return 0;
  let minD = Infinity;
  for (let i = 0; i < n; i++) {
    minD = Math.min(
      minD,
      pointToSegmentDist(p, polygon[i], polygon[(i + 1) % n])
    );
  }
  return minD;
}

/** One debug frame for paper §5.1 spine elevation (direct boundary spokes or axis propagation). */
export interface SpineElevationDebugStep {
  kind: 'direct' | 'propagate';
  stepIndex: number;
  spineId: number;
  /** Boundary vertices directly connected in the wedge mesh (direct steps only). */
  exteriorIds: number[];
  /** Distance from spine to each exterior vertex used in the average (direct steps only). */
  distances: number[];
  /** Mean of `distances` (direct steps only). */
  avgDistance: number | null;
  /** Neighbor spine nodes averaged for junction hubs (propagate steps only). */
  neighborSpineIds: number[];
  /** z of each neighbor at propagation time (propagate steps only). */
  neighborElevations: number[];
  /** z assigned to `spineId` after this step. */
  elevation: number;
  /** Vertices after applying this step (cumulative). */
  verticesAfter: Vec3[];
}

/**
 * Build per-vertex spine elevation frames for debug stepping (paper §5.1).
 * Direct steps: z = SPINE_ELEVATION_FACTOR × average distance to connected boundary verts.
 * Propagate steps: junction hubs with no boundary spokes inherit the mean z of axis neighbors.
 */
export function buildSpineElevationDebugSteps(
  interiorVerts: Map<number, Map<number, number[]>>,
  baseVerts: Vec3[],
  axisSegments: [number, number][],
  boundaryVertexCount: number
): SpineElevationDebugStep[] {
  const verts = baseVerts.map((v) => vec3(v.x, v.y, v.z));
  const steps: SpineElevationDebugStep[] = [];
  let stepIndex = 0;

  const spineIds = [...interiorVerts.keys()].sort((a, b) => a - b);
  for (const spineId of spineIds) {
    const neighbors = interiorVerts.get(spineId);
    if (!neighbors) continue;
    const exteriorIds = [...neighbors.keys()].sort((a, b) => a - b);
    if (exteriorIds.length === 0) continue;

    const distances = exteriorIds.map((eid) => dist3(verts[eid], verts[spineId]));
    const avgDistance = distances.reduce((s, d) => s + d, 0) / distances.length;
    const elevation = ELEVATION_FACTOR * avgDistance;
    verts[spineId].z = elevation;

    steps.push({
      kind: 'direct',
      stepIndex: stepIndex++,
      spineId,
      exteriorIds,
      distances,
      avgDistance,
      neighborSpineIds: [],
      neighborElevations: [],
      elevation,
      verticesAfter: verts.map((v) => vec3(v.x, v.y, v.z)),
    });
  }

  if (axisSegments.length === 0) return steps;

  const adj = new Map<number, number[]>();
  for (const [a, b] of axisSegments) {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, neighbors] of adj) {
      if (id < boundaryVertexCount || verts[id].z > 1e-6) continue;
      const lifted = neighbors.filter((n) => verts[n].z > 1e-6);
      if (lifted.length === 0) continue;

      const neighborElevations = lifted.map((n) => verts[n].z);
      const elevation =
        neighborElevations.reduce((s, z) => s + z, 0) / neighborElevations.length;
      verts[id].z = elevation;

      steps.push({
        kind: 'propagate',
        stepIndex: stepIndex++,
        spineId: id,
        exteriorIds: [],
        distances: [],
        avgDistance: null,
        neighborSpineIds: lifted,
        neighborElevations,
        elevation,
        verticesAfter: verts.map((v) => vec3(v.x, v.y, v.z)),
      });
      changed = true;
    }
  }

  return steps;
}

/**
 * Paper §5.1 (after fig. 13f): elevate spine vertices from the average distance to boundary
 * vertices directly connected in the subdivided wedge mesh.
 */
export function applySpineElevation(
  interiorVerts: Map<number, Map<number, number[]>>,
  verts: Vec3[]
): void {
  for (const [spineId, neighbors] of interiorVerts) {
    let avg = 0;
    let n = 0;
    for (const exteriorId of neighbors.keys()) {
      avg += dist3(verts[exteriorId], verts[spineId]);
      n++;
    }
    if (n > 0) {
      verts[spineId].z = ELEVATION_FACTOR * (avg / n);
    }
  }
}

/**
 * Junction hubs on the chordal axis may have no direct boundary spokes in the wedge mesh (only
 * links to other spine nodes). Propagate elevation from wedge-connected neighbors so axis joints
 * are not left at z = 0.
 */
export function propagateSpineElevationAlongAxis(
  verts: Vec3[],
  axisSegments: [number, number][],
  boundaryVertexCount: number
): void {
  if (axisSegments.length === 0) return;

  const adj = new Map<number, number[]>();
  for (const [a, b] of axisSegments) {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }

  for (let pass = 0; pass < adj.size; pass++) {
    let changed = false;
    for (const [id, neighbors] of adj) {
      if (id < boundaryVertexCount || verts[id].z > 1e-6) continue;
      const lifted = neighbors.filter((n) => verts[n].z > 1e-6);
      if (lifted.length === 0) continue;
      verts[id].z =
        lifted.reduce((sum, n) => sum + verts[n].z, 0) / lifted.length;
      changed = true;
    }
    if (!changed) break;
  }
}

export function wedgesToFanFaces(wedges: PrunedWedge[]): [number, number, number][] {
  return wedges.map((w) => [...w.vertIds] as [number, number, number]);
}

export function wedgesToFanFacesFiltered(
  wedges: PrunedWedge[],
  predicate: (w: PrunedWedge) => boolean
): [number, number, number][] {
  return wedges.filter(predicate).map((w) => [...w.vertIds] as [number, number, number]);
}

/** Elevated fan wedges only (spine height set); no quarter-oval subdivision. */
export function wedgesToElevatedFanFaces(
  wedges: PrunedWedge[],
  interiorVerts: Map<number, Map<number, number[]>>,
  verts: Vec3[],
  axisSegments: [number, number][],
  boundaryVertexCount: number,
  hubMeta?: {
    subdivisionHubByTri: Map<number, number>;
    junctionHubByTri: Map<number, number>;
    interiorEdgeMid: Map<string, number>;
    triangles: ZeyapTriangle[];
    axisSegments: [number, number][];
  }
): [number, number, number][] {
  applySpineElevation(interiorVerts, verts);
  propagateSpineElevationAlongAxis(verts, axisSegments, boundaryVertexCount);
  if (hubMeta) {
    elevateSubdivisionHubHeights(
      verts,
      hubMeta.subdivisionHubByTri,
      hubMeta.junctionHubByTri,
      hubMeta.interiorEdgeMid,
      hubMeta.triangles,
      boundaryVertexCount,
      hubMeta.axisSegments
    );
  }
  return wedgesToFanFaces(wedges);
}

/**
 * Chordal-axis / spine edges (paper fig. c,e): links between interior spine
 * vertices only — not radial spokes to the boundary.
 */
export function collectChordalAxisSegments(
  wedges: PrunedWedge[],
  boundaryVertexCount: number
): [number, number][] {
  const seen = new Set<string>();
  const segments: [number, number][] = [];

  const isSpineVertex = (v: number) => v >= boundaryVertexCount;

  const add = (a: number, b: number) => {
    if (!isSpineVertex(a) || !isSpineVertex(b)) return;
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    segments.push([a, b]);
  };

  for (const wedge of wedges) {
    const [a, b, c] = wedge.vertIds;
    add(a, b);
    add(b, c);
    add(a, c);
  }

  return segments;
}

/** @deprecated Use collectChordalAxisSegments — spineEdges are boundary spokes. */
export function collectSpineSegments(
  wedges: PrunedWedge[],
  boundaryVertexCount: number
): [number, number][] {
  return collectChordalAxisSegments(wedges, boundaryVertexCount);
}

/** Five vertex indices along one spine–boundary spoke (paper quarter oval). */
export type QuarterOvalSpoke = [number, number, number, number, number];

function cloneInteriorVerts(
  src: Map<number, Map<number, number[]>>
): Map<number, Map<number, number[]>> {
  const out = new Map<number, Map<number, number[]>>();
  for (const [spineId, row] of src) {
    const newRow = new Map<number, number[]>();
    for (const [extId, pts] of row) {
      newRow.set(extId, [...pts]);
    }
    out.set(spineId, newRow);
  }
  return out;
}

/**
 * Subdivide one fan wedge with quarter-oval spokes (paper §5.2) and stitch the
 * two arcs with eight triangles.
 */
function inflateWedgeQuarterOval(
  wedge: PrunedWedge,
  verts: Vec3[],
  interiorVerts: Map<number, Map<number, number[]>>
): {
  spokes: [QuarterOvalSpoke, QuarterOvalSpoke];
  triangles: [number, number, number][];
} {
  const p: [number, number, number, number, number][] = [
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
  ];

  for (let j = 0; j < 2; j++) {
    const [spineId, exteriorId] = wedge.spineEdges[j];
    const cache = interiorVerts.get(spineId)?.get(exteriorId);
    p[j][0] = spineId;
    p[j][4] = exteriorId;

    if (cache && cache.length > 0) {
      p[j][1] = cache[0];
      p[j][2] = cache[1];
      p[j][3] = cache[2];
    } else {
      const b = verts[spineId].z;

      const mid = edgeCenter(verts[p[j][0]], verts[p[j][4]]);
      mid.z = b * (Math.sqrt(3) / 2);
      verts.push(mid);
      p[j][2] = verts.length - 1;

      const nearSpine = edgeCenter(verts[p[j][0]], verts[p[j][2]]);
      nearSpine.z = b * (Math.sqrt(15) / 4);
      verts.push(nearSpine);
      p[j][1] = verts.length - 1;

      const nearExterior = edgeCenter(verts[p[j][2]], verts[p[j][4]]);
      nearExterior.z = b * (Math.sqrt(7) / 4);
      verts.push(nearExterior);
      p[j][3] = verts.length - 1;

      if (!interiorVerts.has(spineId)) {
        interiorVerts.set(spineId, new Map());
      }
      interiorVerts.get(spineId)!.set(exteriorId, [p[j][1], p[j][2], p[j][3]]);
    }
  }

  const triangles: [number, number, number][] = [];
  for (let j = 0; j < 4; j++) {
    if (p[0][j] !== p[1][j]) {
      triangles.push([p[0][j], p[1][j], p[1][j + 1]]);
    }
    if (p[0][j + 1] !== p[1][j + 1]) {
      triangles.push([p[0][j], p[1][j + 1], p[0][j + 1]]);
    }
  }

  return { spokes: [p[0], p[1]], triangles };
}

/** One debug frame: flat fan wedge with spine corners at their elevated z. */
export interface FanElevationDebugStep {
  stepIndex: number;
  wedgeIndex: number;
  vertIds: [number, number, number];
  spineEdges: [[number, number], [number, number]];
  /** z of each spine endpoint used by this wedge. */
  spineHeights: [number, number];
  vertices: Vec3[];
  /** Flat elevated triangles revealed through this step (one wedge per step). */
  faces: [number, number, number][];
  /** Index in `faces` of the triangle added this step. */
  activeFaceIndex: number;
}

/** One debug frame: quarter-oval spokes and stitched triangles for one fan wedge. */
export interface QuarterOvalDebugStep {
  stepIndex: number;
  wedgeIndex: number;
  vertIds: [number, number, number];
  spokes: [QuarterOvalSpoke, QuarterOvalSpoke];
  /** z at each spine endpoint before subdividing this wedge. */
  spineHeights: [number, number];
  vertices: Vec3[];
  /** Quarter-oval triangles revealed through this step. */
  faces: [number, number, number][];
  /** Face indices added when processing this wedge. */
  highlightFaceIndices: number[];
}

/**
 * Build per-wedge frames for elevating flat fan triangles (spine corners lifted,
 * boundary still at z = 0) before quarter-oval subdivision.
 */
export function buildFanElevationDebugSteps(
  wedges: PrunedWedge[],
  elevatedVerts: Vec3[],
  axisSegments: [number, number][],
  boundaryVertexCount: number
): FanElevationDebugStep[] {
  const vertices = elevatedVerts.map((v) => vec3(v.x, v.y, v.z));
  const inflationSpineNodes = collectInflationSpineNodeIds(
    wedges,
    axisSegments,
    boundaryVertexCount
  );
  const steps: FanElevationDebugStep[] = [];
  const accumulatedFaces: [number, number, number][] = [];

  let stepIndex = 0;
  for (let wedgeIndex = 0; wedgeIndex < wedges.length; wedgeIndex++) {
    const wedge = wedges[wedgeIndex];
    if (!isQuarterOvalInflationWedge(wedge, inflationSpineNodes, boundaryVertexCount)) {
      continue;
    }

    const [s0, s1] = wedge.spineEdges.map(([spineId]) => spineId) as [number, number];
    accumulatedFaces.push([...wedge.vertIds] as [number, number, number]);

    steps.push({
      stepIndex: stepIndex++,
      wedgeIndex,
      vertIds: [...wedge.vertIds] as [number, number, number],
      spineEdges: wedge.spineEdges,
      spineHeights: [vertices[s0].z, vertices[s1].z],
      vertices,
      faces: accumulatedFaces.map((f) => [...f] as [number, number, number]),
      activeFaceIndex: accumulatedFaces.length - 1,
    });
  }

  return steps;
}

/**
 * Build per-wedge frames for quarter-oval creation and stitching (paper §5.2).
 */
export function buildQuarterOvalDebugSteps(
  wedges: PrunedWedge[],
  elevatedVerts: Vec3[],
  interiorVerts: Map<number, Map<number, number[]>>,
  axisSegments: [number, number][],
  boundaryVertexCount: number
): QuarterOvalDebugStep[] {
  const verts = elevatedVerts.map((v) => vec3(v.x, v.y, v.z));
  const interiorCopy = cloneInteriorVerts(interiorVerts);
  const inflationSpineNodes = collectInflationSpineNodeIds(
    wedges,
    axisSegments,
    boundaryVertexCount
  );
  const steps: QuarterOvalDebugStep[] = [];
  const accumulatedFaces: [number, number, number][] = [];

  let stepIndex = 0;
  for (let wedgeIndex = 0; wedgeIndex < wedges.length; wedgeIndex++) {
    const wedge = wedges[wedgeIndex];
    if (!isQuarterOvalInflationWedge(wedge, inflationSpineNodes, boundaryVertexCount)) {
      continue;
    }

    const [s0, s1] = wedge.spineEdges.map(([spineId]) => spineId) as [number, number];
    const spineHeights: [number, number] = [verts[s0].z, verts[s1].z];

    const { spokes, triangles } = inflateWedgeQuarterOval(
      wedge,
      verts,
      interiorCopy
    );

    const highlightFaceIndices: number[] = [];
    for (const tri of triangles) {
      highlightFaceIndices.push(accumulatedFaces.length);
      accumulatedFaces.push(tri);
    }

    steps.push({
      stepIndex: stepIndex++,
      wedgeIndex,
      vertIds: [...wedge.vertIds] as [number, number, number],
      spokes,
      spineHeights,
      vertices: verts.map((v) => vec3(v.x, v.y, v.z)),
      faces: accumulatedFaces.map((f) => [...f] as [number, number, number]),
      highlightFaceIndices,
    });
  }

  return steps;
}

/**
 * Build per-wedge frames for quarter-oval subdivision of internal chord wedges
 * (two axis-adjacent spine nodes + one boundary corner), mirroring fan §5.2.
 */
export function buildInternalQuarterOvalDebugSteps(
  wedges: PrunedWedge[],
  elevatedVerts: Vec3[],
  interiorVerts: Map<number, Map<number, number[]>>,
  axisSegments: [number, number][],
  boundaryVertexCount: number
): QuarterOvalDebugStep[] {
  const verts = elevatedVerts.map((v) => vec3(v.x, v.y, v.z));
  const interiorCopy = cloneInteriorVerts(interiorVerts);
  const inflationSpineNodes = collectInflationSpineNodeIds(
    wedges,
    axisSegments,
    boundaryVertexCount
  );
  const steps: QuarterOvalDebugStep[] = [];
  const accumulatedFaces: [number, number, number][] = [];

  let stepIndex = 0;
  for (let wedgeIndex = 0; wedgeIndex < wedges.length; wedgeIndex++) {
    const wedge = wedges[wedgeIndex];
    if (
      !isInternalFlatElevationWedge(
        wedge,
        inflationSpineNodes,
        boundaryVertexCount,
        axisSegments
      )
    ) {
      continue;
    }

    const [s0, s1] = wedge.spineEdges.map(([spineId]) => spineId) as [number, number];
    const spineHeights: [number, number] = [verts[s0].z, verts[s1].z];

    const { spokes, triangles } = inflateWedgeQuarterOval(
      wedge,
      verts,
      interiorCopy
    );

    const highlightFaceIndices: number[] = [];
    for (const tri of triangles) {
      highlightFaceIndices.push(accumulatedFaces.length);
      accumulatedFaces.push(tri);
    }

    steps.push({
      stepIndex: stepIndex++,
      wedgeIndex,
      vertIds: [...wedge.vertIds] as [number, number, number],
      spokes,
      spineHeights,
      vertices: verts.map((v) => vec3(v.x, v.y, v.z)),
      faces: accumulatedFaces.map((f) => [...f] as [number, number, number]),
      highlightFaceIndices,
    });
  }

  return steps;
}

/**
 * Build per-wedge frames for flat elevation of internal chord wedges (two spine
 * nodes + one boundary corner) before quarter-oval subdivision.
 */
export function buildInternalFlatElevationDebugSteps(
  wedges: PrunedWedge[],
  elevatedVerts: Vec3[],
  axisSegments: [number, number][],
  boundaryVertexCount: number
): FanElevationDebugStep[] {
  const vertices = elevatedVerts.map((v) => vec3(v.x, v.y, v.z));
  const inflationSpineNodes = collectInflationSpineNodeIds(
    wedges,
    axisSegments,
    boundaryVertexCount
  );
  const steps: FanElevationDebugStep[] = [];
  const accumulatedFaces: [number, number, number][] = [];
  let stepIndex = 0;

  for (let wedgeIndex = 0; wedgeIndex < wedges.length; wedgeIndex++) {
    const wedge = wedges[wedgeIndex];
    if (
      !isInternalFlatElevationWedge(
        wedge,
        inflationSpineNodes,
        boundaryVertexCount,
        axisSegments
      )
    ) {
      continue;
    }

    const [s0, s1] = wedge.spineEdges.map(([spineId]) => spineId) as [number, number];
    accumulatedFaces.push([...wedge.vertIds] as [number, number, number]);

    steps.push({
      stepIndex: stepIndex++,
      wedgeIndex,
      vertIds: [...wedge.vertIds] as [number, number, number],
      spineEdges: wedge.spineEdges,
      spineHeights: [vertices[s0].z, vertices[s1].z],
      vertices,
      faces: accumulatedFaces.map((f) => [...f] as [number, number, number]),
      activeFaceIndex: accumulatedFaces.length - 1,
    });
  }

  return steps;
}

function elevateVertices(
  wedges: PrunedWedge[],
  interiorVerts: Map<number, Map<number, number[]>>,
  verts: Vec3[],
  axisSegments: [number, number][],
  boundaryVertexCount: number
): [number, number, number][] {
  applySpineElevation(interiorVerts, verts);
  propagateSpineElevationAlongAxis(verts, axisSegments, boundaryVertexCount);

  const inflationSpineNodes = collectInflationSpineNodeIds(
    wedges,
    axisSegments,
    boundaryVertexCount
  );
  const divTriangles: [number, number, number][] = [];

  for (const wedge of wedges) {
    if (isFig13fHubWedge(wedge, inflationSpineNodes, boundaryVertexCount)) {
      continue;
    }
    if (isQuarterOvalInflationWedge(wedge, inflationSpineNodes, boundaryVertexCount)) {
      const { triangles } = inflateWedgeQuarterOval(wedge, verts, interiorVerts);
      divTriangles.push(...triangles);
    } else if (
      isInternalFlatElevationWedge(
        wedge,
        inflationSpineNodes,
        boundaryVertexCount,
        axisSegments
      )
    ) {
      const { triangles } = inflateWedgeQuarterOval(wedge, verts, interiorVerts);
      divTriangles.push(...triangles);
    } else {
      divTriangles.push([...wedge.vertIds] as [number, number, number]);
    }
  }

  return divTriangles;
}

/** Top inflated surface (quarter ovals, paper §5.2) before mirroring the back face. */
export function buildInflatedTopFaces(
  wedges: PrunedWedge[],
  interiorVerts: Map<number, Map<number, number[]>>,
  verts: Vec3[],
  axisSegments: [number, number][],
  boundaryVertexCount: number
): [number, number, number][] {
  return elevateVertices(
    wedges,
    interiorVerts,
    verts,
    axisSegments,
    boundaryVertexCount
  );
}

/** Closed solid via mirrored back face (zeyap drawBackface). */
export function drawBackface(
  triangles: [number, number, number][],
  verts: Vec3[]
): InflatedMesh {
  const n = verts.length;
  const vertices: Vec3[] = [...verts];
  const faces: [number, number, number][] = [...triangles];

  for (let i = 0; i < n; i++) {
    vertices.push(vec3(verts[i].x, verts[i].y, -verts[i].z));
  }

  for (const [a, b, c] of triangles) {
    faces.push([c + n, b + n, a + n]);
  }

  return { vertices, faces };
}

/** Connect top and bottom along the original polygon ring (after drawBackface). */
export function stitchSilhouetteRim(
  vertices: Vec3[],
  faces: Triangle[],
  boundaryPolygon: Vec2[],
  topVertexCount: number
): void {
  const n = boundaryPolygon.length;

  for (let i = 0; i < n; i++) {
    const a = i;
    const b = (i + 1) % n;
    const pa = vertices[a];
    const pb = vertices[b];
    const outX = pb.y - pa.y;
    const outY = pa.x - pb.x;

    const aBack = a + topVertexCount;
    const bBack = b + topVertexCount;

    let tri1: Triangle = [a, b, bBack];
    let tri2: Triangle = [a, bBack, aBack];
    const n1 = faceNormal(vertices, tri1);
    if (n1.x * outX + n1.y * outY < 0) {
      tri1 = flipTriangle(tri1);
    }
    const n2 = faceNormal(vertices, tri2);
    if (n2.x * outX + n2.y * outY < 0) {
      tri2 = flipTriangle(tri2);
    }
    faces.push(tri1, tri2);
  }
}

export function cdtToZeyapTriangles(triangles: Triangle2D[]): ZeyapTriangle[] {
  return triangles.map((t) => ({
    vertIds: [...t.indices],
    type: t.type,
    interiorEdges: t.interiorEdges.map((e) => [...e] as [number, number]),
    externalEdges: t.externalEdges.map((e) => [...e] as [number, number]),
  }));
}
