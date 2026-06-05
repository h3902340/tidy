import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { CutBoundaryHit } from './cutPolygon';
import { computeTeddyCut, countBoundaryEdges, keepFacesOnLargerVertexSide } from './meshCut';
import { buildTeddyPipelineFromStroke } from './teddy';
import type { Vec2 } from './math';

function circleRing(radius: number, segments = 48): Vec2[] {
  const ring: Vec2[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    ring.push({ x: Math.cos(t) * radius, y: Math.sin(t) * radius });
  }
  return ring;
}

function dummyHits(): [CutBoundaryHit, CutBoundaryHit] {
  const hit = (cutParam: number): CutBoundaryHit => ({
    point: { x: 0, y: 0 },
    cutParam,
    cutSeg: 0,
    polyEdge: 0,
    polyT: 0,
  });
  return [hit(0), hit(1)];
}

describe('keepFacesOnLargerVertexSide', () => {
  it('keeps the side with more unique vertices', () => {
    const leftFaces: [number, number, number][] = [
      [0, 1, 2],
      [2, 3, 4],
    ];
    const rightFaces: [number, number, number][] = [[10, 11, 12]];

    const kept = keepFacesOnLargerVertexSide(leftFaces, rightFaces);
    expect(kept).toBe(leftFaces);
  });

  it('removes the side with fewer vertices even when it is screen-left', () => {
    const leftFaces: [number, number, number][] = [[0, 1, 2]];
    const rightFaces: [number, number, number][] = [
      [10, 11, 12],
      [12, 13, 14],
      [14, 15, 16],
    ];

    const kept = keepFacesOnLargerVertexSide(leftFaces, rightFaces);
    expect(kept).toBe(rightFaces);
  });
});

describe('computeTeddyCut hole cap', () => {
  it('closes the hole when cutting through the middle of an inflated circle', () => {
    const { meshes, error } = buildTeddyPipelineFromStroke(circleRing(50));
    expect(error).toBeNull();
    expect(meshes).not.toBeNull();

    const mesh = meshes!.inflated;
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
    camera.position.set(0, 0, 284);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    const rect = { width: 400, height: 400 };
    const domElement = {
      clientWidth: rect.width,
      clientHeight: rect.height,
      getBoundingClientRect: () => ({
        width: rect.width,
        height: rect.height,
        left: 0,
        top: 0,
        right: rect.width,
        bottom: rect.height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    } as HTMLElement;
    const stroke: Vec2[] = [
      { x: 40, y: 200 },
      { x: 360, y: 200 },
    ];

    const result = computeTeddyCut(mesh, stroke, camera, domElement, {
      silhouette: [],
      hits: dummyHits(),
    });

    expect('error' in result).toBe(false);
    if ('error' in result) return;

    const openOriginal = countBoundaryEdges(mesh);
    const openTrimmed = countBoundaryEdges(result.trimmed);
    const openCapped = countBoundaryEdges(result.capped);
    const capFacesAdded = result.capped.faces.length - result.trimmed.faces.length;

    expect(openTrimmed).toBeGreaterThan(openOriginal);
    expect(capFacesAdded).toBeGreaterThan(0);
    expect(openCapped).toBeLessThan(openTrimmed);
    expect(openCapped).toBeLessThanOrEqual(openOriginal + 1);
  });

  it('closes the hole with a y-flipped mesh object (runtime display transform)', () => {
    const { meshes, error } = buildTeddyPipelineFromStroke(circleRing(100));
    expect(error).toBeNull();
    expect(meshes).not.toBeNull();

    const mesh = meshes!.inflated;
    const worldRoot = new THREE.Object3D();
    worldRoot.scale.set(1, -1, 1);
    worldRoot.updateMatrixWorld(true);

    const camera = new THREE.PerspectiveCamera(45, 800 / 500, 0.1, 2000);
    camera.position.set(0, 0, 284);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    const domElement = {
      clientWidth: 800,
      clientHeight: 500,
      getBoundingClientRect: () => ({
        width: 800,
        height: 500,
        left: 0,
        top: 0,
        right: 800,
        bottom: 500,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    } as HTMLElement;

    const stroke: Vec2[] = [
      { x: 80, y: 250 },
      { x: 720, y: 250 },
    ];

    const result = computeTeddyCut(mesh, stroke, camera, domElement, {
      silhouette: [],
      hits: dummyHits(),
    }, worldRoot);

    expect('error' in result).toBe(false);
    if ('error' in result) return;

    const capFacesAdded = result.capped.faces.length - result.trimmed.faces.length;
    expect(capFacesAdded).toBeGreaterThan(0);
    expect(countBoundaryEdges(result.capped)).toBeLessThan(countBoundaryEdges(result.trimmed));
  });
});
