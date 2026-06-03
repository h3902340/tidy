import { constrainedDelaunay, type Triangle2D } from './cdt';
import { dist, type Vec2, type Vec3, vec3 } from './math';
import { isSelfIntersecting, normalizePolygon } from './stroke';

export interface Mesh3D {
  vertices: Vec3[];
  faces: [number, number, number][];
}

/** Planar CDT mesh: boundary vertices at z = 0, interior filled with Delaunay triangles. */
function buildFlatCdtMesh(polygon: Vec2[], triangles: Triangle2D[]): Mesh3D {
  const vertices: Vec3[] = polygon.map((p) => vec3(p.x, p.y, 0));
  const faces: [number, number, number][] = triangles.map((t) => [
    t.indices[0],
    t.indices[1],
    t.indices[2],
  ]);

  return { vertices, faces };
}

export function buildMeshFromPolygon(ring: Vec2[]): {
  mesh: Mesh3D | null;
  error: string | null;
  polygon: Vec2[];
} {
  const polygon =
    ring.length > 1 && dist(ring[0], ring[ring.length - 1]) < 1e-3
      ? ring.slice(0, -1)
      : [...ring];

  if (polygon.length < 3) {
    return { mesh: null, error: 'Polygon needs at least 3 vertices.', polygon: ring };
  }

  const closed = [...polygon, polygon[0]];
  if (isSelfIntersecting(closed)) {
    return {
      mesh: null,
      error: 'Self-intersecting polygon — cut produced an invalid shape.',
      polygon: closed,
    };
  }

  const { triangles } = constrainedDelaunay(polygon);
  const mesh = buildFlatCdtMesh(polygon, triangles);
  return { mesh, error: null, polygon: closed };
}

export function buildTeddyMesh(rawStroke: Vec2[]): {
  mesh: Mesh3D | null;
  error: string | null;
  polygon: Vec2[];
} {
  const polygon = normalizePolygon(rawStroke);
  if (polygon.length < 3) {
    return { mesh: null, error: 'Draw a longer closed shape.', polygon };
  }
  return buildMeshFromPolygon(polygon);
}
