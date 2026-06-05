import { describe, expect, it } from 'vitest';
import { constrainedDelaunay } from './cdt';
import {
  applySpineElevation,
  buildSpineElevationDebugSteps,
  buildTerminalPruneDebugSteps,
  cdtToZeyapTriangles,
  propagateSpineElevationAlongAxis,
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

  it('open junction triangle: centroid splits into interior wedges', () => {
    const polygon = normalizePolygon(unitSquare);
    const { triangles } = constrainedDelaunay(polygon);
    const jCount = triangles.filter((t) => t.type === 'J').length;
    expect(jCount).toBeGreaterThan(0);

    const zeyap = cdtToZeyapTriangles(triangles);
    const verts = polygon.map((p) => vec3(p.x, p.y, 0));
    const { wedges } = pruneToWedges(zeyap, [...verts]);

    const jTriId = zeyap.findIndex((t) => t.type === 'J');
    const jVerts = new Set(zeyap[jTriId].vertIds);
    const centroidWedges = wedges.filter(
      (w) =>
        !w.fromTerminalPrune &&
        w.vertIds.filter((v) => jVerts.has(v)).length >= 2
    );

    expect(centroidWedges.length).toBeGreaterThanOrEqual(1);
  });

  it('terminal prune debug steps include semicircle advance and fan frames', () => {
    const polygon = normalizePolygon(unitSquare);
    const { triangles } = constrainedDelaunay(polygon);
    const zeyap = cdtToZeyapTriangles(triangles);
    const verts = polygon.map((p) => vec3(p.x, p.y, 0));
    const steps = buildTerminalPruneDebugSteps(zeyap, [...verts]);

    expect(steps.length).toBeGreaterThan(0);
    expect(steps.some((s) => s.kind === 'start')).toBe(true);
    expect(steps.some((s) => s.kind === 'advance')).toBe(true);
    expect(steps.some((s) => s.kind === 'stop')).toBe(true);
    expect(steps.some((s) => s.kind === 'fan')).toBe(true);
    expect(steps.filter((s) => s.kind === 'fan').length).toBeGreaterThanOrEqual(2);

    for (const step of steps) {
      if (step.kind !== 'fan') {
        expect(step.semicircle.radius).toBeGreaterThan(0);
      }
    }
  });

  it('wobbly circle: spine axis is one connected component', () => {
    const pts: { x: number; y: number }[] = [];
    const n = 120;
    const r = 100;
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      const wobble = 1 + 0.08 * Math.sin(t * 5);
      pts.push({ x: Math.cos(t) * r * wobble, y: Math.sin(t) * r * wobble });
    }
    const polygon = normalizePolygon(pts);
    const { triangles } = constrainedDelaunay(polygon);
    const zeyap = cdtToZeyapTriangles(triangles);
    const verts = polygon.map((p) => vec3(p.x, p.y, 0));
    const { axisSegments } = pruneToWedges(zeyap, [...verts]);

    const adj = new Map<number, number[]>();
    for (const [a, b] of axisSegments) {
      (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
      (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
    }
    const visited = new Set<number>();
    let components = 0;
    for (const start of adj.keys()) {
      if (visited.has(start)) continue;
      components++;
      const q = [start];
      visited.add(start);
      while (q.length) {
        const v = q.pop()!;
        for (const nb of adj.get(v) ?? []) {
          if (!visited.has(nb)) {
            visited.add(nb);
            q.push(nb);
          }
        }
      }
    }
    expect(components).toBe(1);
  });

  it('elevation neighbors only include chordal-axis spine nodes', () => {
    const { triangles } = constrainedDelaunay(unitSquare);
    const zeyap = cdtToZeyapTriangles(triangles);
    const verts = unitSquare.map((p) => vec3(p.x, p.y, 0));
    const { wedges, interiorVerts, axisSegments } = pruneToWedges(zeyap, verts);
    const boundaryCount = unitSquare.length;

    const spineNodes = new Set<number>();
    for (const [a, b] of axisSegments) {
      if (a >= boundaryCount) spineNodes.add(a);
      if (b >= boundaryCount) spineNodes.add(b);
    }

    for (const spineId of interiorVerts.keys()) {
      expect(spineNodes.has(spineId)).toBe(true);
    }

    for (const wedge of wedges) {
      if (wedge.fromTerminalPrune) continue;
      const hubId = wedge.vertIds[0];
      if (!spineNodes.has(hubId)) {
        expect(interiorVerts.has(hubId)).toBe(false);
      }
      for (const neighbor of interiorVerts.get(hubId)?.keys() ?? []) {
        expect(neighbor).toBeLessThan(boundaryCount);
      }
    }
  });

  it('buildSpineElevationDebugSteps matches applySpineElevation + propagate', () => {
    const { triangles } = constrainedDelaunay(unitSquare);
    const zeyap = cdtToZeyapTriangles(triangles);
    const verts = unitSquare.map((p) => vec3(p.x, p.y, 0));
    const { interiorVerts, axisSegments } = pruneToWedges(zeyap, verts);

    const steps = buildSpineElevationDebugSteps(
      interiorVerts,
      verts,
      axisSegments,
      unitSquare.length
    );
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.some((s) => s.kind === 'direct')).toBe(true);

    const last = steps[steps.length - 1]!;
    const expected = verts.map((v) => vec3(v.x, v.y, v.z));
    applySpineElevation(interiorVerts, expected);
    propagateSpineElevationAlongAxis(expected, axisSegments, unitSquare.length);

    for (const step of steps) {
      expect(step.verticesAfter[step.spineId].z).toBeCloseTo(step.elevation, 4);
    }
    for (let i = 0; i < expected.length; i++) {
      if (expected[i].z > 1e-6) {
        expect(last.verticesAfter[i].z).toBeCloseTo(expected[i].z, 4);
      }
    }
  });

  it('circle: junction fan tip connects to interior edge mids, not mid-to-mid chord', () => {
    const segments = 64;
    const r = 100;
    const ring: { x: number; y: number }[] = [];
    for (let i = 0; i <= segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      ring.push({ x: Math.cos(t) * r, y: Math.sin(t) * r });
    }
    const polygon = normalizePolygon(ring);
    const { meshes } = buildTeddyPipeline(polygon);
    expect(meshes).not.toBeNull();

    const segs = meshes!.spineSegments;
    const has = (a: number, b: number) =>
      segs.some(([u, v]) => (u === a && v === b) || (u === b && v === a));

    // v80 = fan tip at J triangle centroid; v156/v157 = interior-edge mids.
    expect(has(80, 156)).toBe(true);
    expect(has(80, 157)).toBe(true);
    expect(has(157, 156)).toBe(false);
  });

  it('buildTeddyPipeline spine elevation steps only use chordal-axis nodes', () => {
    const result = buildTeddyPipeline(normalizePolygon(unitSquare));
    expect(result.meshes).not.toBeNull();

    const spineNodes = new Set<number>();
    for (const [a, b] of result.meshes!.spineSegments) {
      spineNodes.add(a);
      spineNodes.add(b);
    }
    for (const step of result.meshes!.spineElevationSteps) {
      expect(spineNodes.has(step.spineId)).toBe(true);
    }
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
