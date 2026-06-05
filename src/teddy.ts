import { dist, type Vec2 } from './math';
import { isSelfIntersecting } from './stroke';
import {
  buildInflatedMesh,
  buildTeddyPipelineFromStroke,
} from './teddyPipeline';
import type { Mesh3D } from './teddyPipeline';

export type {
  Mesh3D,
  SpineElevationDebugStep,
  TeddyPipelineMeshes,
  TeddyPipelineResult,
  TerminalPruneDebugStep,
  TriangleType,
} from './teddyPipeline';
export { FAN_TERMINAL_COLOR } from './teddyPipeline';
export {
  buildFlatCdtMesh,
  buildInflatedMesh,
  buildSpineMesh,
  buildTeddyPipeline,
  buildTeddyPipelineFromStroke,
} from './teddyPipeline';

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

  const mesh = buildInflatedMesh(polygon);
  return { mesh, error: null, polygon: closed };
}

export function buildTeddyMesh(rawStroke: Vec2[]): {
  mesh: Mesh3D | null;
  error: string | null;
  polygon: Vec2[];
} {
  const { meshes, error, polygon } = buildTeddyPipelineFromStroke(rawStroke);
  return { mesh: meshes?.inflated ?? null, error, polygon };
}
