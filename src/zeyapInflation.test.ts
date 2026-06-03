import { describe, expect, it } from 'vitest';
import { constrainedDelaunay } from './cdt';
import {
  cdtToZeyapTriangles,
  pruneToWedges,
  wedgesToFanFacesFiltered,
} from './zeyapInflation';
import { buildTeddyPipeline } from './teddyPipeline';
import { normalizePolygon } from './stroke';
import { vec3 } from './math';

const unitSquare = [
  { x: -50, y: -50 },
  { x: 50, y: -50 },
  { x: 50, y: 50 },
  { x: -50, y: 50 },
];

/** Boundary vertex closest to a target corner. */
function cornerVertexIndex(
  polygon: { x: number; y: number }[],
  corner: { x: number; y: number }
): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const d = Math.hypot(polygon[i].x - corner.x, polygon[i].y - corner.y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function fanTouchesCorner(
  fan: [number, number, number],
  cornerVid: number
): boolean {
  return fan[0] === cornerVid || fan[1] === cornerVid || fan[2] === cornerVid;
}

describe('terminal fan pruning', () => {
  it('axis-aligned square: four boundary fan wedges from two T triangles', () => {
    const { triangles } = constrainedDelaunay(unitSquare);
    const tCount = triangles.filter((t) => t.type === 'T').length;
    expect(tCount).toBe(2);

    const zeyap = cdtToZeyapTriangles(triangles);
    const verts = unitSquare.map((p) => vec3(p.x, p.y, 0));
    const { wedges } = pruneToWedges(zeyap, [...verts]);
    const terminalFans = wedgesToFanFacesFiltered(
      wedges,
      (w) => w.fromTerminalPrune
    );

    expect(terminalFans.length).toBe(4);

    const { axisSegments } = pruneToWedges(zeyap, [...verts]);
    const boundaryCount = unitSquare.length;
    const tips = new Set<number>();
    for (const f of terminalFans) {
      for (const v of f) {
        if (v >= boundaryCount) tips.add(v);
      }
    }
    const axisAdj = new Map<number, number[]>();
    for (const [a, b] of axisSegments) {
      if (!axisAdj.has(a)) axisAdj.set(a, []);
      if (!axisAdj.has(b)) axisAdj.set(b, []);
      axisAdj.get(a)!.push(b);
      axisAdj.get(b)!.push(a);
    }
    for (const tip of tips) {
      expect((axisAdj.get(tip)?.length ?? 0) > 0).toBe(true);
    }
    // Four corner boundary verts each touch a terminal fan.
    for (let i = 0; i < 4; i++) {
      expect(terminalFans.some((f) => fanTouchesCorner(f, i))).toBe(true);
    }
  });

  it('resampled square: fan wedge at every corner (incl. top-left)', () => {
    const polygon = normalizePolygon(unitSquare);
    const { triangles } = constrainedDelaunay(polygon);
    const tCount = triangles.filter((t) => t.type === 'T').length;
    expect(tCount).toBeGreaterThanOrEqual(4);

    const zeyap = cdtToZeyapTriangles(triangles);
    const verts = polygon.map((p) => vec3(p.x, p.y, 0));
    const { wedges, axisSegments } = pruneToWedges(zeyap, [...verts]);
    const terminalFans = wedgesToFanFacesFiltered(
      wedges,
      (w) => w.fromTerminalPrune
    );

    const topLeftVid = cornerVertexIndex(polygon, { x: -50, y: 50 });
    const corners = [
      { x: -50, y: 50 },
      { x: 50, y: 50 },
      { x: 50, y: -50 },
      { x: -50, y: -50 },
    ];

    for (const corner of corners) {
      const vid = cornerVertexIndex(polygon, corner);
      const hasFan = terminalFans.some((f) => fanTouchesCorner(f, vid));
      expect(hasFan, `missing terminal fan at corner (${corner.x}, ${corner.y})`).toBe(
        true
      );
    }

    // Each corner boundary vertex should appear on a terminal fan and spine axis.
    const boundaryCount = polygon.length;
    const fanSpineTips = new Set<number>();
    for (const f of terminalFans) {
      for (const v of f) {
        if (v >= boundaryCount) fanSpineTips.add(v);
      }
    }

    const axisAdj = new Map<number, number[]>();
    const addEdge = (a: number, b: number) => {
      if (!axisAdj.has(a)) axisAdj.set(a, []);
      if (!axisAdj.has(b)) axisAdj.set(b, []);
      axisAdj.get(a)!.push(b);
      axisAdj.get(b)!.push(a);
    };
    for (const [a, b] of axisSegments) addEdge(a, b);

    for (const corner of corners) {
      const vid = cornerVertexIndex(polygon, corner);
      const hasFan = terminalFans.some((f) => fanTouchesCorner(f, vid));
      expect(hasFan).toBe(true);

      const spineForCorner = terminalFans.find((f) => fanTouchesCorner(f, vid));
      expect(spineForCorner).toBeDefined();
      const tip = spineForCorner!.find((v) => v >= boundaryCount)!;
      expect(fanSpineTips.has(tip)).toBe(true);
      // Black spine display includes fan spoke (tip → corner) or chordal link.
      const hasSpokeToCorner = axisSegments.some(
        ([a, b]) =>
          (a === vid && b === tip) ||
          (b === vid && a === tip) ||
          (a === tip && b >= boundaryCount) ||
          (b === tip && a >= boundaryCount)
      );
      expect(
        hasSpokeToCorner || (axisAdj.get(tip)?.length ?? 0) > 0,
        `no spine at corner (${corner.x}, ${corner.y})`
      ).toBe(true);
    }

    expect(terminalFans.length).toBeGreaterThanOrEqual(tCount);
    void topLeftVid;
  });

  it('buildTeddyPipeline resampled square: terminal fans cover all T triangles', () => {
    const result = buildTeddyPipeline(normalizePolygon(unitSquare));
    expect(result.error).toBeNull();
    expect(result.meshes).not.toBeNull();

    const types = result.meshes!.classifiedFaceTypes;
    const tCount = types.filter((t) => t === 'T').length;
    const fanCount = result.meshes!.terminalFans.faces.length;

    expect(tCount).toBeGreaterThanOrEqual(4);
    expect(fanCount).toBeGreaterThanOrEqual(tCount);
  });
});
