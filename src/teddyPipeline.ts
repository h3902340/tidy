import { constrainedDelaunay, type Triangle2D } from './cdt';
import { dist, type Vec2, type Vec3, vec3 } from './math';
import { isSelfIntersecting, normalizePolygon } from './stroke';
import {
  enforceBoundaryCapWinding,
  enforceOutwardSolidWinding,
  enforceSolidMeshWinding,
  enforceWindingTowardView,
  enforceWindingTowardViewSelective,
  fixInwardFaces,
  teddyInteriorReference,
} from './meshWinding';
import {
  applySpineElevation,
  buildFanElevationDebugSteps,
  buildInternalFlatElevationDebugSteps,
  buildInternalQuarterOvalDebugSteps,
  buildQuarterOvalDebugSteps,
  buildSpineElevationDebugSteps,
  buildTerminalPruneDebugSteps,
  cdtToInflationTriangles,
  drawBackface,
  elevateSubdivisionHubHeights,
  propagateSpineElevationAlongAxis,
  buildInflatedTopFaces,
  pruneToWedges,
  wedgesToElevatedFanFaces,
  wedgesToFanFaces,
  wedgesToFanFacesFiltered,
  type FanElevationDebugStep,
  type QuarterOvalDebugStep,
  type SpineElevationDebugStep,
  type TerminalPruneDebugStep,
  type InflationTriangle,
} from './teddyInflation';

export type {
  FanElevationDebugStep,
  QuarterOvalDebugStep,
  SpineElevationDebugStep,
  TerminalPruneDebugStep,
} from './teddyInflation';

export type TriangleType = 'T' | 'S' | 'J';

/** Terminal fan wedges (paper fig. d) — used in UI overlays. */
export const FAN_TERMINAL_COLOR = 0x7cb87c;

export interface Mesh3D {
  vertices: Vec3[];
  faces: [number, number, number][];
}

export interface TeddyPipelineMeshes {
  /** Paper (b): CDT with terminal / sleeve / junction classification. */
  classified: Mesh3D;
  classifiedFaceTypes: TriangleType[];
  /** Paper (d): terminal-prune fan triangles only (overlay on classified). */
  terminalFans: Mesh3D;
  /** Fig. 14: semicircle advance frames for debug stepping (classified → fan). */
  terminalPruneSteps: TerminalPruneDebugStep[];
  /** Paper (f): full 2D mesh between spine and boundary (z = 0). */
  fan: Mesh3D;
  /** Paper (e): branched chordal-axis overlay (same vertices as fan). */
  spineSegments: [number, number][];
  /** Paper §5.1: per-spine-vertex elevation frames for debug stepping. */
  spineElevationSteps: SpineElevationDebugStep[];
  /** Per-wedge flat fan elevation after spine heights are set (§5.1 → §5.2). */
  fanElevationSteps: FanElevationDebugStep[];
  /** Per-wedge quarter-oval subdivision for terminal fan wedges (paper §5.2). */
  quarterOvalSteps: QuarterOvalDebugStep[];
  /** Per-wedge flat elevation for internal chord wedges before quarter ovals. */
  internalFlatElevationSteps: FanElevationDebugStep[];
  /** Per-wedge quarter-oval subdivision for internal chord wedges (paper §5.2). */
  internalQuarterOvalSteps: QuarterOvalDebugStep[];
  /** Fan vertices with spine elevation applied — spine nodes lifted to their height (z > 0). */
  elevatedSpineVertices: Vec3[];
  /** Elevated fans, mirrored back; no quarter-ovals or rim. */
  elevated: Mesh3D;
  /** Top inflated surface — matches the last debug step before the solid cap. */
  inflatedTop: Mesh3D;
  /** Full inflation: top surface mirrored (paper §5.1 fig. 15) plus winding fixes. */
  inflated: Mesh3D;
}

export interface TeddyPipelineResult {
  polygon: Vec2[];
  meshes: TeddyPipelineMeshes;
}

function preparePolygon(ring: Vec2[]): {
  polygon: Vec2[];
  closed: Vec2[];
  error: string | null;
} {
  const polygon =
    ring.length > 1 && dist(ring[0], ring[ring.length - 1]) < 1e-3
      ? ring.slice(0, -1)
      : [...ring];

  if (polygon.length < 3) {
    return { polygon, closed: ring, error: 'Polygon needs at least 3 vertices.' };
  }

  const closed = [...polygon, polygon[0]];
  if (isSelfIntersecting(closed)) {
    return {
      polygon,
      closed,
      error: 'Self-intersecting polygon — outline must be simple.',
    };
  }

  return { polygon, closed, error: null };
}

function buildClassifiedFromTriangles(
  polygon: Vec2[],
  triangles: Triangle2D[]
): { mesh: Mesh3D; faceTypes: TriangleType[] } {
  const vertices = polygon.map((p) => vec3(p.x, p.y, 0));
  const faces = triangles.map((t) => [...t.indices] as [number, number, number]);
  const faceTypes = triangles.map((t) => t.type);
  enforceWindingTowardView(vertices, faces, vec3(0, 0, 1));
  return { mesh: { vertices, faces }, faceTypes };
}

function buildElevatedFanSolid(
  polygon: Vec2[],
  wedges: ReturnType<typeof pruneToWedges>['wedges'],
  interiorVerts: ReturnType<typeof pruneToWedges>['interiorVerts'],
  axisSegments: [number, number][],
  verts: Vec3[],
  inflationTris: InflationTriangle[],
  hubMeta: Pick<
    ReturnType<typeof pruneToWedges>,
    'subdivisionHubByTri' | 'junctionHubByTri' | 'interiorEdgeMid'
  >
): Mesh3D {
  const elevatedVerts = verts.map((v) => vec3(v.x, v.y, v.z));
  const topFaces = wedgesToElevatedFanFaces(
    wedges,
    interiorVerts,
    elevatedVerts,
    axisSegments,
    polygon.length,
    { ...hubMeta, triangles: inflationTris, axisSegments }
  );
  enforceWindingTowardView(elevatedVerts, topFaces, vec3(0, 0, 1));
  const { vertices, faces } = drawBackface(topFaces, elevatedVerts, polygon.length);
  enforceSolidMeshWinding(vertices, faces, polygon, elevatedVerts.length);
  return { vertices, faces };
}

function buildInflatedTopMesh(
  polygon: Vec2[],
  wedges: ReturnType<typeof pruneToWedges>['wedges'],
  interiorVerts: ReturnType<typeof pruneToWedges>['interiorVerts'],
  axisSegments: [number, number][],
  pruneVerts: Vec3[]
): Mesh3D {
  const verts = pruneVerts.map((v) => vec3(v.x, v.y, v.z));
  const faces = buildInflatedTopFaces(
    wedges,
    interiorVerts,
    verts,
    axisSegments,
    polygon.length
  );
  enforceWindingTowardViewSelective(verts, faces, vec3(0, 0, 1));
  return { vertices: verts, faces };
}

function sealInflatedSolid(polygon: Vec2[], top: Mesh3D): Mesh3D {
  const topVertexCount = top.vertices.length;
  const { vertices, faces } = drawBackface(top.faces, top.vertices, polygon.length);

  const interior = teddyInteriorReference(polygon, vertices);
  const windingOpts = {
    skipBoundaryFaces: true,
    boundaryVertexCount: polygon.length,
    topVertexCount,
    referencePoint: interior,
  };

  enforceOutwardSolidWinding(vertices, faces, interior);
  enforceBoundaryCapWinding(vertices, faces, polygon.length, topVertexCount);
  fixInwardFaces(vertices, faces, windingOpts);
  return { vertices, faces };
}

/** Step 5 — quarter-oval top cap mirrored to close the solid (paper §5.1), plus winding fixes. */
export function buildInflatedMesh(polygon: Vec2[]): Mesh3D {
  const result = buildTeddyPipeline(polygon);
  return result.meshes?.inflated ?? { vertices: [], faces: [] };
}

export function buildTeddyPipeline(ring: Vec2[]): {
  meshes: TeddyPipelineMeshes | null;
  error: string | null;
  polygon: Vec2[];
} {
  const prep = preparePolygon(ring);
  if (prep.error) {
    return { meshes: null, error: prep.error, polygon: prep.closed };
  }

  const { polygon } = prep;
  const { triangles } = constrainedDelaunay(polygon);
  const { mesh: classified, faceTypes: classifiedFaceTypes } =
    buildClassifiedFromTriangles(polygon, triangles);

  const pruneVerts = polygon.map((p) => vec3(p.x, p.y, 0));
  const inflationTris = cdtToInflationTriangles(triangles);
  const terminalPruneSteps = buildTerminalPruneDebugSteps(inflationTris, [
    ...pruneVerts,
  ]);
  const {
    wedges,
    interiorVerts,
    axisSegments,
    subdivisionHubByTri,
    junctionHubByTri,
    interiorEdgeMid,
  } = pruneToWedges(inflationTris, pruneVerts);

  const fanFaces = wedgesToFanFaces(wedges);
  enforceWindingTowardView(pruneVerts, fanFaces, vec3(0, 0, 1));
  const terminalFanFaces = wedgesToFanFacesFiltered(
    wedges,
    (w) => w.fromTerminalPrune
  );
  const terminalFans: Mesh3D = { vertices: pruneVerts, faces: terminalFanFaces };
  const fan: Mesh3D = { vertices: pruneVerts, faces: fanFaces };

  const spineElevationSteps = buildSpineElevationDebugSteps(
    interiorVerts,
    pruneVerts,
    axisSegments,
    polygon.length
  );

  const elevatedSpineVertices = pruneVerts.map((v) => vec3(v.x, v.y, v.z));
  applySpineElevation(interiorVerts, elevatedSpineVertices);
  propagateSpineElevationAlongAxis(
    elevatedSpineVertices,
    axisSegments,
    polygon.length
  );
  elevateSubdivisionHubHeights(
    elevatedSpineVertices,
    subdivisionHubByTri,
    junctionHubByTri,
    interiorEdgeMid,
    inflationTris,
    polygon.length,
    axisSegments
  );

  const fanElevationSteps = buildFanElevationDebugSteps(
    wedges,
    elevatedSpineVertices,
    axisSegments,
    polygon.length
  );
  const quarterOvalSteps = buildQuarterOvalDebugSteps(
    wedges,
    elevatedSpineVertices,
    interiorVerts,
    axisSegments,
    polygon.length
  );
  const internalFlatElevationSteps = buildInternalFlatElevationDebugSteps(
    wedges,
    elevatedSpineVertices,
    axisSegments,
    polygon.length
  );
  const internalQuarterOvalSteps = buildInternalQuarterOvalDebugSteps(
    wedges,
    elevatedSpineVertices,
    interiorVerts,
    axisSegments,
    polygon.length
  );

  const elevated = buildElevatedFanSolid(
    polygon,
    wedges,
    interiorVerts,
    axisSegments,
    pruneVerts,
    inflationTris,
    { subdivisionHubByTri, junctionHubByTri, interiorEdgeMid }
  );
  const inflatedTop = buildInflatedTopMesh(
    polygon,
    wedges,
    interiorVerts,
    axisSegments,
    pruneVerts
  );
  const inflated = sealInflatedSolid(polygon, inflatedTop);

  return {
    meshes: {
      classified,
      classifiedFaceTypes,
      terminalFans,
      terminalPruneSteps,
      fan,
      spineSegments: axisSegments,
      spineElevationSteps,
      fanElevationSteps,
      quarterOvalSteps,
      internalFlatElevationSteps,
      internalQuarterOvalSteps,
      elevatedSpineVertices,
      elevated,
      inflatedTop,
      inflated,
    },
    error: null,
    polygon: prep.closed,
  };
}

export function buildTeddyPipelineFromStroke(rawStroke: Vec2[]): {
  meshes: TeddyPipelineMeshes | null;
  error: string | null;
  polygon: Vec2[];
} {
  const polygon = normalizePolygon(rawStroke);
  if (polygon.length < 3) {
    return { meshes: null, error: 'Draw a longer closed shape.', polygon };
  }
  return buildTeddyPipeline(polygon);
}

