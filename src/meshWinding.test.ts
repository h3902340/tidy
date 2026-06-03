import { describe, expect, it } from 'vitest';
import {
  assertBoundaryCapsOutward,
  enforceConsistentOutwardWinding,
  findInwardFaces,
  flipTriangle,
  isFaceNormalOutward,
  teddyInteriorReference,
  type Triangle,
} from './meshWinding';
import { vec3 } from './math';
import { buildMeshFromPolygon, buildTeddyMesh } from './teddy';

function assertMeshWinding(
  mesh: NonNullable<ReturnType<typeof buildMeshFromPolygon>['mesh']>,
  label: string,
  boundaryPolygon: { x: number; y: number }[]
): void {
  const boundaryCount = boundaryPolygon.length;
  const topVertexCount = mesh.vertices.length / 2;

  const interior = teddyInteriorReference(boundaryPolygon, mesh.vertices);
  const { indices } = findInwardFaces(mesh.vertices, mesh.faces, interior, {
    skipBoundaryFaces: true,
    boundaryVertexCount: boundaryCount,
    topVertexCount,
  });
  if (indices.length > 0) {
    throw new Error(
      `${label}: ${indices.length} inward-facing triangle(s) (non-boundary)`
    );
  }

  assertBoundaryCapsOutward(
    mesh.vertices,
    mesh.faces,
    boundaryCount,
    topVertexCount,
    label
  );
}

function squareRing(): { x: number; y: number }[] {
  return [
    { x: -50, y: -50 },
    { x: 50, y: -50 },
    { x: 50, y: 50 },
    { x: -50, y: 50 },
  ];
}

function blobRing(segments = 32): { x: number; y: number }[] {
  const ring: { x: number; y: number }[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    ring.push({ x: Math.cos(t) * 60, y: Math.sin(t) * 45 });
  }
  return ring;
}

describe('mesh winding analysis', () => {
  it('propagates cross-product outward orientation on a closed tetrahedron-like solid', () => {
    const vertices = [
      vec3(0, 0, 1),
      vec3(1, 0, 0),
      vec3(0, 1, 0),
      vec3(0, 0, -1),
    ];
    const faces: Triangle[] = [
      [0, 1, 2],
      flipTriangle([0, 1, 3]),
      [1, 2, 3],
      flipTriangle([0, 2, 3]),
    ];
    const interior = vec3(0.25, 0.25, 0.25);
    enforceConsistentOutwardWinding(vertices, faces, interior);
    for (const face of faces) {
      expect(isFaceNormalOutward(vertices, face, interior)).toBe(true);
    }
  });

  it('detects a deliberately flipped triangle', () => {
    const vertices = [
      vec3(0, 0, 0),
      vec3(1, 0, 0),
      vec3(0, 1, 0),
    ];
    // CCW in XY => +Z normal; interior reference below the cap.
    const interior = vec3(0.33, 0.33, -1);
    const outward: Triangle = [0, 1, 2];
    const inward: Triangle = flipTriangle(outward);

    expect(isFaceNormalOutward(vertices, outward, interior)).toBe(true);
    expect(isFaceNormalOutward(vertices, inward, interior)).toBe(false);

    const report = findInwardFaces(vertices, [outward, inward], interior);
    expect(report.indices).toEqual([1]);
    expect(report.alignments).toHaveLength(1);
    expect(report.alignments[0]).toBeLessThan(0);
  });
});

describe('Teddy inflated mesh — all normals outward', () => {
  it('axis-aligned square', () => {
    const { mesh, error } = buildMeshFromPolygon(squareRing());
    expect(error).toBeNull();
    expect(mesh).not.toBeNull();
    assertMeshWinding(mesh!, 'square', squareRing());
  });

  it('resampled blob (normalized stroke)', () => {
    const { mesh, error, polygon } = buildTeddyMesh(blobRing());
    expect(error).toBeNull();
    expect(mesh).not.toBeNull();
    assertMeshWinding(mesh!, 'blob', polygon.slice(0, -1));
  });

  it('star-like concave outline (boundary caps only)', () => {
    const star: { x: number; y: number }[] = [];
    for (let i = 0; i < 10; i++) {
      const t = (i / 10) * Math.PI * 2;
      const r = i % 2 === 0 ? 55 : 25;
      star.push({ x: Math.cos(t) * r, y: Math.sin(t) * r });
    }
    const { mesh, error } = buildTeddyMesh(star);
    expect(error).toBeNull();
    expect(mesh).not.toBeNull();
    const topVertexCount = mesh!.vertices.length / 2;
    assertBoundaryCapsOutward(
      mesh!.vertices,
      mesh!.faces,
      star.length,
      topVertexCount,
      'star'
    );
  });
});
