import { describe, expect, it } from 'vitest';
import { constrainedDelaunay } from './cdt';
import {
  applySpineElevation,
  buildFanElevationDebugSteps,
  buildInternalFlatElevationDebugSteps,
  buildInternalQuarterOvalDebugSteps,
  buildQuarterOvalDebugSteps,
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

    const boundaryCount = unitSquare.length;
    const tips = new Set<number>();
    for (const f of terminalFans) {
      for (const v of f) {
        if (v >= boundaryCount) tips.add(v);
      }
    }
    // Coincident fan tips at the square center merge to one spine vertex.
    expect(tips.size).toBe(1);
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

  it('open junction triangle: hub splits into interior wedges along each edge', () => {
    const polygon = normalizePolygon(unitSquare);
    const { triangles } = constrainedDelaunay(polygon);
    const jCount = triangles.filter((t) => t.type === 'J').length;
    expect(jCount).toBeGreaterThan(0);

    const zeyap = cdtToZeyapTriangles(triangles);
    const verts = polygon.map((p) => vec3(p.x, p.y, 0));
    const { wedges } = pruneToWedges(zeyap, [...verts]);

    const interiorWedges = wedges.filter((w) => !w.fromTerminalPrune);
    expect(interiorWedges.length).toBeGreaterThanOrEqual(1);
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
    for (const wedge of wedges) {
      if (!wedge.fromTerminalPrune) continue;
      const tip = wedge.vertIds.find((v) => v >= boundaryCount);
      if (tip !== undefined) spineNodes.add(tip);
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

  it('circle: no duplicate spine vertices at the same position', () => {
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

    const verts = meshes!.fan.vertices;
    const spineIds = new Set<number>();
    for (const [a, b] of meshes!.spineSegments) {
      spineIds.add(a);
      spineIds.add(b);
    }

    const byPos = new Map<string, number[]>();
    for (const id of spineIds) {
      if (id < polygon.length) continue;
      const v = verts[id];
      const key = `${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}`;
      if (!byPos.has(key)) byPos.set(key, []);
      byPos.get(key)!.push(id);
    }

    for (const ids of byPos.values()) {
      expect(ids.length).toBe(1);
    }
  });

  it('circle: every sleeve/junction CDT triangle has wedge coverage', () => {
    const segments = 64;
    const r = 100;
    const ring: { x: number; y: number }[] = [];
    for (let i = 0; i <= segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      ring.push({ x: Math.cos(t) * r, y: Math.sin(t) * r });
    }
    const polygon = normalizePolygon(ring);
    const { triangles } = constrainedDelaunay(polygon);
    const zeyap = cdtToZeyapTriangles(triangles);
    const verts = polygon.map((p) => vec3(p.x, p.y, 0));
    const { wedges } = pruneToWedges(zeyap, verts);

    for (let ti = 0; ti < zeyap.length; ti++) {
      const tri = zeyap[ti];
      if (tri.type !== 'S' && tri.type !== 'J') continue;
      const tv = new Set(tri.vertIds);
      const hit = wedges.some(
        (w) => w.vertIds.filter((v) => tv.has(v)).length >= 2
      );
      expect(hit, `missing wedges for ${tri.type} triangle ${ti}`).toBe(true);
    }
  });

  it('circle: chordal axis segments are edges in the sleeve wedge mesh', () => {
    const segments = 64;
    const r = 100;
    const ring: { x: number; y: number }[] = [];
    for (let i = 0; i <= segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      ring.push({ x: Math.cos(t) * r, y: Math.sin(t) * r });
    }
    const polygon = normalizePolygon(ring);
    const { triangles } = constrainedDelaunay(polygon);
    const zeyap = cdtToZeyapTriangles(triangles);
    const verts = polygon.map((p) => vec3(p.x, p.y, 0));
    const { wedges, axisSegments } = pruneToWedges(zeyap, verts);
    const bc = polygon.length;

    const meshEdge = (a: number, b: number) =>
      a < b ? `${a}_${b}` : `${b}_${a}`;
    const meshEdges = new Set<string>();
    for (const w of wedges) {
      const [a, b, c] = w.vertIds;
      meshEdges.add(meshEdge(a, b));
      meshEdges.add(meshEdge(b, c));
      meshEdges.add(meshEdge(a, c));
    }

    let covered = 0;
    for (const [a, b] of axisSegments) {
      if (a < bc || b < bc) continue;
      if (meshEdges.has(meshEdge(a, b))) covered++;
    }
    expect(covered).toBeGreaterThan(0);
    expect(covered / axisSegments.length).toBeGreaterThan(0.4);
  });

  it('circle: interior sleeve wedges inflate without flat troughs', () => {
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

    const verts = meshes!.elevatedSpineVertices;
    const faces = meshes!.fan.faces;
    let subdivElevated = 0;
    let subdivFlat = 0;
    for (const [a, b, c] of faces) {
      const maxZ = Math.max(verts[a].z, verts[b].z, verts[c].z);
      const allBoundary =
        a < polygon.length && b < polygon.length && c < polygon.length;
      if (allBoundary) continue;
      if (maxZ > 0.5) subdivElevated++;
      else subdivFlat++;
    }
    expect(subdivElevated).toBeGreaterThan(subdivFlat);

    const inf = meshes!.inflated;
    const topCount = inf.vertices.length / 2;
    let infElevated = 0;
    for (const [a, b, c] of inf.faces) {
      if (a >= topCount || b >= topCount || c >= topCount) continue;
      const maxZ = Math.max(
        inf.vertices[a].z,
        inf.vertices[b].z,
        inf.vertices[c].z
      );
      if (maxZ > 0.5) infElevated++;
    }
    expect(infElevated).toBeGreaterThan(meshes!.fan.faces.length);
  });

  it('circle: interior-edge mid on axis uses nearest boundary neighbors, not propagate', () => {
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

    const step = meshes!.spineElevationSteps.find(
      (s) =>
        s.kind === 'direct' &&
        s.exteriorIds.length === 2 &&
        s.exteriorIds.includes(3) &&
        s.exteriorIds.includes(71)
    );
    expect(step).toBeDefined();
    expect(step!.exteriorIds).toEqual([3, 71]);
    expect(step!.neighborSpineIds).toEqual([]);
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

    const bc = polygon.length;
    const segs = meshes!.spineSegments;
    const has = (a: number, b: number) =>
      segs.some(([u, v]) => (u === a && v === b) || (u === b && v === a));

    const tips = new Set<number>();
    for (const f of meshes!.terminalFans.faces) {
      for (const v of f) {
        if (v >= bc) tips.add(v);
      }
    }
    const adj = new Map<number, number[]>();
    for (const [a, b] of segs) {
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a)!.push(b);
      adj.get(b)!.push(a);
    }

    let junctionTip: number | null = null;
    let interiorNeighbors: number[] = [];
    for (const tip of tips) {
      const n = (adj.get(tip) ?? []).filter((x) => x >= bc);
      if (n.length >= 2) {
        junctionTip = tip;
        interiorNeighbors = n;
        break;
      }
    }
    expect(junctionTip).not.toBeNull();
    for (const n of interiorNeighbors) {
      expect(has(junctionTip!, n)).toBe(true);
    }
    for (let i = 0; i < interiorNeighbors.length; i++) {
      for (let j = i + 1; j < interiorNeighbors.length; j++) {
        expect(has(interiorNeighbors[i], interiorNeighbors[j])).toBe(false);
      }
    }
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

  it('buildTeddyPipeline exposes fan elevation and quarter-oval debug steps', () => {
    const result = buildTeddyPipeline(normalizePolygon(unitSquare));
    expect(result.meshes).not.toBeNull();

    const { fanElevationSteps, quarterOvalSteps, fan } = result.meshes!;
    expect(fanElevationSteps.length).toBeGreaterThan(0);
    expect(fanElevationSteps.length).toBeLessThanOrEqual(fan.faces.length);
    expect(quarterOvalSteps.length).toBe(fanElevationSteps.length);

    for (let i = 0; i < fanElevationSteps.length; i++) {
      expect(fanElevationSteps[i].faces.length).toBe(i + 1);
      expect(fanElevationSteps[i].activeFaceIndex).toBe(i);
    }

    for (let i = 0; i < quarterOvalSteps.length; i++) {
      expect(quarterOvalSteps[i].faces.length).toBeGreaterThanOrEqual(i + 1);
      expect(quarterOvalSteps[i].highlightFaceIndices.length).toBeGreaterThan(0);
    }

    const lastOval = quarterOvalSteps[quarterOvalSteps.length - 1];
    expect(lastOval.faces.length).toBeGreaterThan(fanElevationSteps.length);
  });

  it('circle: spine branch corners get adjacent chord wedges without diagonals', () => {
    const segments = 64;
    const r = 100;
    const ring: { x: number; y: number }[] = [];
    for (let i = 0; i <= segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      ring.push({ x: Math.cos(t) * r, y: Math.sin(t) * r });
    }
    const polygon = normalizePolygon(ring);
    const { triangles } = constrainedDelaunay(polygon);
    const zeyap = cdtToZeyapTriangles(triangles);
    const verts = polygon.map((p) => vec3(p.x, p.y, 0));
    const { wedges, axisSegments } = pruneToWedges(zeyap, verts);
    const bc = polygon.length;

    const hasChord = (a: number, b: number, corner: number) =>
      wedges.some((w) => {
        const sp = w.vertIds.filter((v) => v >= bc).sort((x, y) => x - y);
        const bd = w.vertIds.filter((v) => v < bc);
        return (
          !w.fromTerminalPrune &&
          sp.length === 2 &&
          bd.length === 1 &&
          sp[0] === Math.min(a, b) &&
          sp[1] === Math.max(a, b) &&
          bd[0] === corner
        );
      });

    const axisEdge = (a: number, b: number) =>
      axisSegments.some(([u, v]) => (u === a && v === b) || (u === b && v === a));

    expect(hasChord(91, 92, 71)).toBe(true);
    expect(hasChord(94, 95, 71)).toBe(true);
    expect(hasChord(91, 92, 8)).toBe(true);
    expect(hasChord(94, 95, 29)).toBe(true);
    expect(hasChord(93, 94, 29)).toBe(false);

    const chordWedges = wedges.filter((w) => {
      const sp = w.vertIds.filter((v) => v >= bc);
      const bd = w.vertIds.filter((v) => v < bc);
      return !w.fromTerminalPrune && sp.length === 2 && bd.length === 1;
    });
    expect(chordWedges.length).toBe(48);
    for (const w of chordWedges) {
      const [a, b] = w.vertIds.filter((v) => v >= bc);
      expect(axisEdge(a!, b!)).toBe(true);
    }
  });

  it('circle: inflation uses quarter ovals for terminal and internal chords', () => {
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

    const {
      fan,
      fanElevationSteps,
      quarterOvalSteps,
      internalFlatElevationSteps,
      internalQuarterOvalSteps,
      terminalFans,
    } = meshes!;
    expect(fanElevationSteps.length).toBe(terminalFans.faces.length);
    expect(quarterOvalSteps.length).toBe(terminalFans.faces.length);
    expect(internalFlatElevationSteps.length).toBe(48);
    expect(internalQuarterOvalSteps.length).toBe(48);
    expect(fanElevationSteps.length).toBeLessThan(fan.faces.length);
    for (const step of internalQuarterOvalSteps) {
      expect(step.highlightFaceIndices.length).toBeGreaterThan(0);
      expect(step.spokes.length).toBe(2);
    }
    const { inflatedTop, inflated } = meshes!;
    expect(inflatedTop.faces.length).toBeGreaterThan(fan.faces.length);
    expect(inflated.faces.length).toBeGreaterThan(inflatedTop.faces.length);
    expect(inflated.faces.length).toBe(inflatedTop.faces.length * 2);
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
