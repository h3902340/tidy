import * as THREE from 'three';
import type { Vec2 } from './math';

const FOREGROUND_THRESHOLD = 40;
const SIMPLIFY_EPS = 1.25;
const MAX_POINTS = 600;

const NEIGHBOR8: ReadonlyArray<{ dx: number; dy: number }> = [
  { dx: 1, dy: 0 },
  { dx: 1, dy: 1 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 1 },
  { dx: -1, dy: 0 },
  { dx: -1, dy: -1 },
  { dx: 0, dy: -1 },
  { dx: 1, dy: -1 },
];

/**
 * Visible screen silhouette by rendering the mesh from the current camera
 * and tracing the outer contour of the rasterized shape (matches on-screen view).
 */
export function computeScreenSilhouetteFromRender(
  renderer: THREE.WebGLRenderer,
  sourceMesh: THREE.Mesh,
  camera: THREE.Camera,
  width: number,
  height: number
): Vec2[] {
  const w = Math.max(4, Math.floor(width));
  const h = Math.max(4, Math.floor(height));
  if (w < 4 || h < 4) return [];

  const mask = dilateMask(rasterizeMeshSilhouette(renderer, sourceMesh, camera, w, h), w, h);
  const contours = traceAllOuterContours(mask, w, h);
  if (contours.length === 0) return [];

  let best = contours[0];
  let bestArea = Math.abs(polygonArea2(best));
  for (let i = 1; i < contours.length; i++) {
    const area = Math.abs(polygonArea2(contours[i]));
    if (area > bestArea) {
      bestArea = area;
      best = contours[i];
    }
  }

  const simplified = simplifyPolyline(best, SIMPLIFY_EPS);
  return decimatePolyline(simplified, MAX_POINTS);
}

function rasterizeMeshSilhouette(
  renderer: THREE.WebGLRenderer,
  sourceMesh: THREE.Mesh,
  camera: THREE.Camera,
  width: number,
  height: number
): Uint8Array {
  const rt = new THREE.WebGLRenderTarget(width, height, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
    stencilBuffer: false,
  });

  const silScene = new THREE.Scene();
  silScene.background = new THREE.Color(0x000000);

  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: true,
  });

  const silMesh = new THREE.Mesh(sourceMesh.geometry, material);
  sourceMesh.updateMatrixWorld(true);
  silMesh.position.copy(sourceMesh.position);
  silMesh.quaternion.copy(sourceMesh.quaternion);
  silMesh.scale.copy(sourceMesh.scale);
  silMesh.updateMatrixWorld(true);
  silScene.add(silMesh);

  camera.updateMatrixWorld(true);
  if (camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera) {
    camera.updateProjectionMatrix();
  }

  const prevTarget = renderer.getRenderTarget();
  const prevClearColor = new THREE.Color();
  const prevClearAlpha = renderer.getClearAlpha();
  renderer.getClearColor(prevClearColor);

  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 1);
  renderer.clear(true, true, true);
  renderer.render(silScene, camera);

  const pixels = new Uint8Array(width * height * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, width, height, pixels);

  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClearColor, prevClearAlpha);

  material.dispose();
  rt.dispose();

  const mask = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    const glRow = height - 1 - row;
    for (let col = 0; col < width; col++) {
      const idx = (glRow * width + col) * 4;
      const lum = pixels[idx];
      mask[row * width + col] = lum >= FOREGROUND_THRESHOLD ? 1 : 0;
    }
  }

  return mask;
}

function maskAt(mask: Uint8Array, w: number, h: number, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  return mask[y * w + x] === 1;
}

/** One-pixel dilation so the traced outline hugs the visible fill (counteracts AA shrink). */
function dilateMask(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!maskAt(mask, w, h, x, y)) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h) out[ny * w + nx] = 1;
        }
      }
    }
  }
  return out;
}

function traceAllOuterContours(mask: Uint8Array, w: number, h: number): Vec2[][] {
  const visited = new Uint8Array(mask.length);
  const contours: Vec2[][] = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isBoundaryPixel(mask, w, h, x, y)) continue;
      if (visited[y * w + x]) continue;

      const contour = traceOuterContourFrom(mask, w, h, x, y, visited);
      if (contour.length >= 3) contours.push(contour);
    }
  }

  return contours;
}

function isBoundaryPixel(mask: Uint8Array, w: number, h: number, x: number, y: number): boolean {
  if (!maskAt(mask, w, h, x, y)) return false;
  return (
    !maskAt(mask, w, h, x - 1, y) ||
    !maskAt(mask, w, h, x + 1, y) ||
    !maskAt(mask, w, h, x, y - 1) ||
    !maskAt(mask, w, h, x, y + 1)
  );
}

function traceOuterContourFrom(
  mask: Uint8Array,
  w: number,
  h: number,
  startX: number,
  startY: number,
  visited: Uint8Array
): Vec2[] {
  const points: Vec2[] = [];
  let px = startX;
  let py = startY;
  let dir = 0;
  const maxSteps = w * h * 8;

  for (let step = 0; step < maxSteps; step++) {
    visited[py * w + px] = 1;
    points.push({ x: px + 0.5, y: py + 0.5 });

    let found = false;
    for (let i = 0; i < 8; i++) {
      const nd = (dir + i) % 8;
      const nx = px + NEIGHBOR8[nd].dx;
      const ny = py + NEIGHBOR8[nd].dy;
      if (maskAt(mask, w, h, nx, ny)) {
        px = nx;
        py = ny;
        dir = (nd + 6) % 8;
        found = true;
        break;
      }
    }

    if (!found) break;
    if (px === startX && py === startY && points.length > 4) break;
  }

  return points;
}

function polygonArea2(poly: Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    sum += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return sum / 2;
}

function simplifyPolyline(points: Vec2[], epsilon: number): Vec2[] {
  if (points.length < 3) return points;
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  rdpMark(points, 0, points.length - 1, epsilon, keep);
  return points.filter((_, i) => keep[i]);
}

function rdpMark(points: Vec2[], start: number, end: number, eps: number, keep: boolean[]): void {
  if (end <= start + 1) return;

  let maxDist = 0;
  let maxIdx = start;
  const a = points[start];
  const b = points[end];

  for (let i = start + 1; i < end; i++) {
    const d = perpendicularDist(points[i], a, b);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > eps) {
    keep[maxIdx] = true;
    rdpMark(points, start, maxIdx, eps, keep);
    rdpMark(points, maxIdx, end, eps, keep);
  }
}

function perpendicularDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

function decimatePolyline(points: Vec2[], maxPoints: number): Vec2[] {
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  const out: Vec2[] = [];
  for (let i = 0; i < points.length; i += step) {
    out.push(points[i]);
  }
  return out;
}
