import * as THREE from 'three';
import type { Vec2, Vec3 } from './math';
import { windingNumber } from './math';
import {
  projectOntoTangentPlane,
  screenPixelsToWorldRadius,
  towardCameraDirection,
} from './surfaceProjection';
import { worldToScreen } from './screenSilhouette';

export type PaintedSurfaceLine = {
  points: Vec3[];
  /** Face normals in mesh space (one per point); optional for strokes saved before normals existed. */
  normals?: Vec3[];
  color: number;
  /** Stroke diameter in CSS pixels (matches the on-screen brush preview). */
  linewidth: number;
  /** Per-vertex ribbon clip (0–1) after carving under another stroke. */
  leftScale?: number[];
  rightScale?: number[];
};

export type PaintTool = 'draw' | 'erase';

const STROKE_SAMPLE_STEP = 4;

/** Teddy §5: the 2D stroke must stay inside the view silhouette and not cross it. */
export function validatePaintStrokeInsideSilhouette(
  stroke: Vec2[],
  silhouette: Vec2[]
): { ok: true } | { error: string } {
  if (silhouette.length < 3) {
    return { error: 'Could not compute object outline — try rotating the view slightly.' };
  }
  if (stroke.length < 2) {
    return { error: 'Stroke is too short.' };
  }

  for (const p of densifyPolyline(stroke, STROKE_SAMPLE_STEP)) {
    if (!windingNumber(p, silhouette)) {
      return { error: 'Keep the stroke inside the object outline.' };
    }
  }

  return { ok: true };
}

/** Erase by clipping ribbon cross-sections under a scribble (same angled cuts as draw-over). */
export function erasePaintedLinesByScribble(
  lines: PaintedSurfaceLine[],
  scribble: Vec2[],
  brushRadius: number,
  camera: THREE.Camera,
  rect: { width: number; height: number }
): PaintedSurfaceLine[] {
  if (scribble.length < 2 || brushRadius <= 0) return lines;

  const eraseScreen = densifyPolyline(densifyPolyline(scribble, STROKE_SAMPLE_STEP), 2);
  if (eraseScreen.length < 2) return lines;

  const out: PaintedSurfaceLine[] = [];
  for (const line of lines) {
    out.push(...clipLineRibbonUnderStroke(line, eraseScreen, brushRadius, camera, rect));
  }
  return out;
}

export function paintedLinesChanged(
  before: PaintedSurfaceLine[],
  after: PaintedSurfaceLine[]
): boolean {
  return paintedLinesFingerprint(before) !== paintedLinesFingerprint(after);
}

function paintedLinesFingerprint(lines: PaintedSurfaceLine[]): string {
  return lines
    .map((l) => {
      const scales =
        l.leftScale?.map((s, i) => `${s.toFixed(3)},${(l.rightScale?.[i] ?? 1).toFixed(3)}`).join(';') ??
        '';
      return `${l.points.length}:${scales}`;
    })
    .join('|');
}

/**
 * Punch holes in existing strokes wherever a new stroke passes over them (screen-space brush
 * corridor), so the new layer can sit on top without z-fighting.
 */
export function carvePaintedLinesUnderStroke(
  lines: PaintedSurfaceLine[],
  cutter: PaintedSurfaceLine,
  camera: THREE.Camera,
  rect: { width: number; height: number }
): PaintedSurfaceLine[] {
  const cutterScreen = densifyPolyline(projectLineToScreen(cutter.points, camera, rect), 4);
  if (cutterScreen.length < 2) return lines;

  const cutterHalf = Math.max(1, cutter.linewidth) * 0.5;
  const out: PaintedSurfaceLine[] = [];
  for (const line of lines) {
    out.push(...clipLineRibbonUnderStroke(line, cutterScreen, cutterHalf, camera, rect));
  }
  return out;
}

export function clonePaintedSurfaceLines(lines: PaintedSurfaceLine[]): PaintedSurfaceLine[] {
  return lines.map((line) => ({
    color: line.color,
    linewidth: line.linewidth,
    points: line.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
    normals: line.normals?.map((n) => ({ x: n.x, y: n.y, z: n.z })),
    leftScale: line.leftScale ? [...line.leftScale] : undefined,
    rightScale: line.rightScale ? [...line.rightScale] : undefined,
  }));
}

/** Stroke direction and ribbon lateral axis in the surface tangent plane at vertex `i`. */
function computeSurfaceStrokeFrame(
  worldPts: THREE.Vector3[],
  worldNorms: THREE.Vector3[],
  i: number,
  camera: THREE.Camera,
  tangent: THREE.Vector3,
  lateral: THREE.Vector3,
  towardCamera: THREE.Vector3
): void {
  const n = worldPts.length;
  if (i < n - 1) tangent.subVectors(worldPts[i + 1], worldPts[i]);
  else tangent.subVectors(worldPts[i], worldPts[i - 1]);

  projectOntoTangentPlane(tangent, worldNorms[i], tangent);
  if (tangent.lengthSq() < 1e-12) {
    towardCameraDirection(worldPts[i], camera, towardCamera);
    projectOntoTangentPlane(towardCamera, worldNorms[i], tangent);
  }
  if (tangent.lengthSq() < 1e-12) tangent.set(1, 0, 0);
  else tangent.normalize();

  lateral.crossVectors(worldNorms[i], tangent);
  if (lateral.lengthSq() < 1e-12) {
    towardCameraDirection(worldPts[i], camera, towardCamera);
    lateral.crossVectors(worldNorms[i], towardCamera);
    projectOntoTangentPlane(lateral, worldNorms[i], lateral);
  }
  if (lateral.lengthSq() < 1e-12) lateral.set(1, 0, 0);
  else lateral.normalize();
}

/** Map brush half-width in CSS pixels to world units along the ribbon lateral axis. */
function worldHalfWidthAlongLateral(
  base: THREE.Vector3,
  lateral: THREE.Vector3,
  halfBrushPx: number,
  camera: THREE.Camera,
  viewport: { width: number; height: number }
): number {
  const probe = screenPixelsToWorldRadius(1, base, camera, viewport.height);
  const a = worldToScreen(base, camera, viewport);
  const b = worldToScreen(base.clone().addScaledVector(lateral, probe), camera, viewport);
  if (!a || !b) return screenPixelsToWorldRadius(halfBrushPx, base, camera, viewport.height);
  const pxPerUnit = Math.hypot(b.x - a.x, b.y - a.y) / probe;
  if (pxPerUnit < 1e-6) return screenPixelsToWorldRadius(halfBrushPx, base, camera, viewport.height);
  return halfBrushPx / pxPerUnit;
}

/**
 * Wide ribbon on the surface tangent plane (brush width in-plane) with ~1px offset toward the
 * camera so the stroke reads as a thin layer of paint, not a volumetric tube.
 */
export function buildPaintRibbonGeometry(
  line: PaintedSurfaceLine,
  camera: THREE.Camera,
  viewport: { width: number; height: number }
): THREE.BufferGeometry | null {
  const n = line.points.length;
  if (n < 2) return null;

  const worldPts: THREE.Vector3[] = [];
  const worldNorms: THREE.Vector3[] = [];
  const towardCamera = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const lateral = new THREE.Vector3();

  for (let i = 0; i < n; i++) {
    const p = line.points[i];
    worldPts.push(new THREE.Vector3(p.x, -p.y, p.z));
    const stored = line.normals?.[i];
    if (stored) {
      worldNorms.push(new THREE.Vector3(stored.x, -stored.y, stored.z).normalize());
    } else {
      worldNorms.push(towardCameraDirection(worldPts[i], camera, towardCamera));
    }
  }

  const left: THREE.Vector3[] = [];
  const right: THREE.Vector3[] = [];
  const halfBrushPx = Math.max(1, line.linewidth) * 0.5;

  for (let i = 0; i < n; i++) {
    computeSurfaceStrokeFrame(worldPts, worldNorms, i, camera, tangent, lateral, towardCamera);

    const halfW = worldHalfWidthAlongLateral(
      worldPts[i],
      lateral,
      halfBrushPx,
      camera,
      viewport
    );
    const base = worldPts[i];
    const leftS = line.leftScale?.[i] ?? 1;
    const rightS = line.rightScale?.[i] ?? 1;

    left.push(base.clone().addScaledVector(lateral, -halfW * leftS));
    right.push(base.clone().addScaledVector(lateral, halfW * rightS));
  }

  const positions = new Float32Array(n * 2 * 3);
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    positions[i * 6] = left[i].x;
    positions[i * 6 + 1] = left[i].y;
    positions[i * 6 + 2] = left[i].z;
    positions[i * 6 + 3] = right[i].x;
    positions[i * 6 + 4] = right[i].y;
    positions[i * 6 + 5] = right[i].z;
  }
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, b, c, b, d, c);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function projectLineToScreen(
  points: Vec3[],
  camera: THREE.Camera,
  rect: { width: number; height: number }
): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const s = worldToScreen(new THREE.Vector3(p.x, -p.y, p.z), camera, rect);
    if (s) out.push(s);
  }
  return out;
}

/** Screen-space stroke tangent and lateral (carving is a 2D screen operation). */
function computeScreenStrokeFrame(
  screenPts: (Vec2 | null)[],
  i: number,
  screenTangent: Vec2,
  screenLat: Vec2
): boolean {
  const n = screenPts.length;
  let dx = 0;
  let dy = 0;
  if (i < n - 1 && screenPts[i] && screenPts[i + 1]) {
    dx = screenPts[i + 1]!.x - screenPts[i]!.x;
    dy = screenPts[i + 1]!.y - screenPts[i]!.y;
  } else if (i > 0 && screenPts[i] && screenPts[i - 1]) {
    dx = screenPts[i]!.x - screenPts[i - 1]!.x;
    dy = screenPts[i]!.y - screenPts[i - 1]!.y;
  } else {
    return false;
  }
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return false;
  screenTangent.x = dx / len;
  screenTangent.y = dy / len;
  screenLat.x = -screenTangent.y;
  screenLat.y = screenTangent.x;
  return true;
}

/**
 * Clip each cross-section of the old ribbon against the new brush so cut edges follow its angle.
 * Keeps every centerline vertex (even fully clipped ones) so the ribbon tapers through crossings
 * instead of splitting into wide flat-ended segments.
 */
function clipLineRibbonUnderStroke(
  line: PaintedSurfaceLine,
  cutterScreen: Vec2[],
  cutterHalf: number,
  camera: THREE.Camera,
  rect: { width: number; height: number }
): PaintedSurfaceLine[] {
  const n = line.points.length;
  if (n < 2) return [line];

  const halfW = Math.max(1, line.linewidth) * 0.5;
  const worldPts: THREE.Vector3[] = line.points.map(
    (p) => new THREE.Vector3(p.x, -p.y, p.z)
  );
  const screenPts = worldPts.map((wp) => worldToScreen(wp, camera, rect));

  const leftScale: number[] = [];
  const rightScale: number[] = [];
  const screenTangent: Vec2 = { x: 0, y: 0 };
  const screenLat: Vec2 = { x: 0, y: 0 };

  for (let i = 0; i < n; i++) {
    const screen = screenPts[i];
    const prevLeft = line.leftScale?.[i] ?? 1;
    const prevRight = line.rightScale?.[i] ?? 1;

    if (!screen || !computeScreenStrokeFrame(screenPts, i, screenTangent, screenLat)) {
      leftScale.push(prevLeft);
      rightScale.push(prevRight);
      continue;
    }

    const negLat = { x: -screenLat.x, y: -screenLat.y };
    const leftKeep = clipLateralSide(
      screen,
      negLat,
      halfW * prevLeft,
      cutterScreen,
      cutterHalf
    );
    const rightKeep = clipLateralSide(
      screen,
      screenLat,
      halfW * prevRight,
      cutterScreen,
      cutterHalf
    );
    leftScale.push(prevLeft * leftKeep);
    rightScale.push(prevRight * rightKeep);
  }

  const hasVisible = leftScale.some((s, i) => s > 0.02 || rightScale[i] > 0.02);
  if (!hasVisible) return [];

  return [
    {
      color: line.color,
      linewidth: line.linewidth,
      points: line.points,
      normals: line.normals,
      leftScale,
      rightScale,
    },
  ];
}

/** Fraction of [0, halfWidth] along lateralDir to keep outside the cutter corridor. */
function clipLateralSide(
  center: Vec2,
  lateralDir: Vec2,
  halfWidth: number,
  cutter: Vec2[],
  radius: number
): number {
  const tip = {
    x: center.x + lateralDir.x * halfWidth,
    y: center.y + lateralDir.y * halfWidth,
  };
  const tipInside = distToPolyline(tip, cutter) < radius;
  const centerInside = distToPolyline(center, cutter) < radius;

  if (centerInside && tipInside) return 0;
  if (!centerInside && !tipInside) return 1;

  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 24; k++) {
    const mid = (lo + hi) * 0.5;
    const p = {
      x: center.x + lateralDir.x * halfWidth * mid,
      y: center.y + lateralDir.y * halfWidth * mid,
    };
    if (distToPolyline(p, cutter) < radius) hi = mid;
    else lo = mid;
  }
  return lo;
}

function distToPolyline(p: Vec2, poly: Vec2[]): number {
  let best = Infinity;
  for (let j = 1; j < poly.length; j++) {
    best = Math.min(best, Math.sqrt(pointSegmentDist2(p, poly[j - 1], poly[j])));
  }
  return best;
}

function densifyPolyline(stroke: Vec2[], samplesPerSegment: number): Vec2[] {
  if (stroke.length === 0) return [];
  const out: Vec2[] = [stroke[0]];
  for (let i = 1; i < stroke.length; i++) {
    const a = stroke[i - 1];
    const b = stroke[i];
    for (let s = 1; s <= samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      out.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
      });
    }
  }
  return out;
}

function pointSegmentDist2(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-12) {
    const dx = p.x - a.x;
    const dy = p.y - a.y;
    return dx * dx + dy * dy;
  }
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = p.x - (a.x + abx * t);
  const dy = p.y - (a.y + aby * t);
  return dx * dx + dy * dy;
}
