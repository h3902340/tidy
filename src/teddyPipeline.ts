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
  cdtToZeyapTriangles,
  drawBackface,
  pruneToWedges,
  pruneTrianglesAndElevateVertices,
  stitchSilhouetteRim,
  wedgesToElevatedFanFaces,
  wedgesToFanFaces,
  wedgesToFanFacesFiltered,
} from './zeyapInflation';

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
  /** Paper (f): full 2D mesh between spine and boundary (z = 0). */
  fan: Mesh3D;
  /** Paper (e): branched chordal-axis overlay (same vertices as fan). */
  spineSegments: [number, number][];
  /** Elevated fans, mirrored back; no quarter-ovals or rim. */
  elevated: Mesh3D;
  /** Full inflation: quarter-ovals, rim, winding fixes. */
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
  verts: Vec3[]
): Mesh3D {
  const elevatedVerts = verts.map((v) => vec3(v.x, v.y, v.z));
  const topFaces = wedgesToElevatedFanFaces(wedges, interiorVerts, elevatedVerts);
  enforceWindingTowardView(elevatedVerts, topFaces, vec3(0, 0, 1));
  const { vertices, faces } = drawBackface(topFaces, elevatedVerts);
  enforceSolidMeshWinding(vertices, faces, polygon, elevatedVerts.length);
  return { vertices, faces };
}

/** Step 5 — quarter-oval spokes, back face, rim, winding fixes. */
export function buildInflatedMesh(polygon: Vec2[]): Mesh3D {
  const { triangles } = constrainedDelaunay(polygon);
  const verts: Vec3[] = polygon.map((p) => vec3(p.x, p.y, 0));
  const zeyapTris = cdtToZeyapTriangles(triangles);
  const topFaces = pruneTrianglesAndElevateVertices(zeyapTris, verts);
  enforceWindingTowardViewSelective(verts, topFaces, vec3(0, 0, 1));

  const topVertexCount = verts.length;
  const { vertices, faces } = drawBackface(topFaces, verts);
  stitchSilhouetteRim(vertices, faces, polygon, topVertexCount);

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
  const zeyapTris = cdtToZeyapTriangles(triangles);
  const { wedges, interiorVerts, axisSegments } = pruneToWedges(zeyapTris, pruneVerts);

  const fanFaces = wedgesToFanFaces(wedges);
  enforceWindingTowardView(pruneVerts, fanFaces, vec3(0, 0, 1));
  const terminalFanFaces = wedgesToFanFacesFiltered(
    wedges,
    (w) => w.fromTerminalPrune
  );
  const terminalFans: Mesh3D = { vertices: pruneVerts, faces: terminalFanFaces };
  const fan: Mesh3D = { vertices: pruneVerts, faces: fanFaces };

  const elevated = buildElevatedFanSolid(polygon, wedges, interiorVerts, pruneVerts);
  const inflated = buildInflatedMesh(polygon);

  return {
    meshes: {
      classified,
      classifiedFaceTypes,
      terminalFans,
      fan,
      spineSegments: axisSegments,
      elevated,
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

/** @deprecated Use buildTeddyPipeline meshes.classified */
export function buildFlatCdtMesh(polygon: Vec2[]): Mesh3D {
  const { triangles } = constrainedDelaunay(polygon);
  return buildClassifiedFromTriangles(polygon, triangles).mesh;
}

/** @deprecated Use buildTeddyPipeline meshes.fan */
export function buildSpineMesh(polygon: Vec2[]): {
  mesh: Mesh3D;
  spineSegments: [number, number][];
} {
  const { meshes } = buildTeddyPipeline(polygon);
  if (!meshes) {
    return { mesh: { vertices: [], faces: [] }, spineSegments: [] };
  }
  return { mesh: meshes.fan, spineSegments: meshes.spineSegments };
}
