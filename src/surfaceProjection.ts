import * as THREE from 'three';
import type { Vec2 } from './math';

const SEGMENT_SAMPLES = 8;
const SURFACE_LIFT = 0.4;
/** Paint sits on the surface as a ~1px-thick layer toward the camera. */
const PAINT_SURFACE_LIFT_PX = 1;

const meshPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const planeHit = new THREE.Vector3();

export function projectScreenStrokeToPlane(
  stroke: Vec2[],
  camera: THREE.Camera,
  domElement: HTMLElement
): THREE.Vector3[] {
  if (stroke.length < 2) return [];

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const rect = domElement.getBoundingClientRect();
  const hits: THREE.Vector3[] = [];

  for (const p of densifyStroke(stroke, SEGMENT_SAMPLES)) {
    ndc.x = (p.x / rect.width) * 2 - 1;
    ndc.y = -(p.y / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const intersection = raycaster.ray.intersectPlane(meshPlane, planeHit);
    if (intersection) hits.push(planeHit.clone());
  }

  return mergeNearbyHits(hits, 0.5);
}

/**
 * Teddy §5.4 paired projection: front and back samples stay aligned per stroke sample so each
 * segment forms a planar quadrilateral (f0, f1, b1, b0).
 */
export function projectScreenStrokeFrontBackPaired(
  stroke: Vec2[],
  camera: THREE.Camera,
  mesh: THREE.Object3D,
  domElement: HTMLElement
): { front: THREE.Vector3[]; back: THREE.Vector3[] } {
  if (stroke.length < 2) return { front: [], back: [] };

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const rect = domElement.getBoundingClientRect();
  const front: THREE.Vector3[] = [];
  const back: THREE.Vector3[] = [];
  const towardCamera = new THREE.Vector3();

  for (const p of densifyStroke(stroke, SEGMENT_SAMPLES)) {
    ndc.x = (p.x / rect.width) * 2 - 1;
    ndc.y = -(p.y / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const intersections = raycaster
      .intersectObject(mesh, false)
      .sort((a, b) => a.distance - b.distance);
    if (intersections.length === 0) continue;

    towardCamera.copy(raycaster.ray.direction).normalize();
    const liftBy = (hit: THREE.Intersection, sign: number) =>
      hit.point.clone().addScaledVector(towardCamera, sign * SURFACE_LIFT);

    front.push(liftBy(intersections[0], -1));
    back.push(liftBy(intersections[intersections.length - 1], 1));
  }

  return dedupePairedHits(front, back, 0.5);
}

/**
 * Lenient on-surface check for the *loop cut* (bump removal). Unlike the extrusion base ring, a
 * loop drawn around a protruding corner or the narrow bottom of the object legitimately bulges
 * past the silhouette into empty space, so we must NOT require every sample to hit the mesh. We
 * only require that the loop is meaningfully over the object (a good fraction of samples hit it).
 */
export function validateClosedLoopOnSurface(
  loop: Vec2[],
  camera: THREE.Camera,
  mesh: THREE.Object3D,
  domElement: HTMLElement,
  minHitFraction = 0.4
): { ok: true } | { error: string } {
  if (loop.length < 3) return { error: 'Loop is too short — draw a closed loop on the surface.' };

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const rect = domElement.getBoundingClientRect();
  let hits = 0;
  let total = 0;

  for (const p of densifyStroke(loop, SEGMENT_SAMPLES)) {
    ndc.x = (p.x / rect.width) * 2 - 1;
    ndc.y = -(p.y / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    total++;
    if (raycaster.intersectObject(mesh, false).length > 0) hits++;
  }

  if (hits < 3 || hits / Math.max(1, total) < minHitFraction) {
    return {
      error: 'Draw the loop over the object — most of it must lie on the surface.',
    };
  }
  return { ok: true };
}

/** Build a raycast target from mesh data (world y-flip matches SceneView). */
export function mesh3DToRaycastObject(mesh: {
  vertices: { x: number; y: number; z: number }[];
  faces: [number, number, number][];
}): THREE.Mesh {
  const positions: number[] = [];
  for (const v of mesh.vertices) {
    positions.push(v.x, -v.y, v.z);
  }
  const indices: number[] = [];
  for (const [a, b, c] of mesh.faces) {
    indices.push(a, b, c);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const obj = new THREE.Mesh(geometry, material);
  obj.scale.set(1, -1, 1);
  obj.updateMatrixWorld(true);
  return obj;
}

/** World hit → stored mesh coordinates. */
export function worldHitToMeshVertex(p: THREE.Vector3): { x: number; y: number; z: number } {
  return { x: p.x, y: -p.y, z: p.z };
}

/** World normal → stored mesh coordinates (inverse of mesh y-flip). */
export function worldNormalToMesh(n: THREE.Vector3): { x: number; y: number; z: number } {
  return { x: n.x, y: -n.y, z: n.z };
}

export type SurfaceStrokeSample = {
  point: THREE.Vector3;
  normal: THREE.Vector3;
};

/** Direction from `worldPoint` toward the camera (unit vector). */
export function towardCameraDirection(
  worldPoint: THREE.Vector3,
  camera: THREE.Camera,
  out = new THREE.Vector3()
): THREE.Vector3 {
  out.copy(camera.position).sub(worldPoint);
  if (out.lengthSq() < 1e-12) out.set(0, 0, 1);
  else out.normalize();
  return out;
}

/** Remove the component of `v` along `normal` (keeps vectors in the surface tangent plane). */
export function projectOntoTangentPlane(
  v: THREE.Vector3,
  normal: THREE.Vector3,
  out = new THREE.Vector3()
): THREE.Vector3 {
  const n = normal.dot(normal) > 1e-12 ? normal : new THREE.Vector3(0, 0, 1);
  return out.copy(v).addScaledVector(n, -v.dot(n));
}

/** Tiny offset along the face normal (camera-facing) so paint sits on the surface, not on a view ray. */
export function liftAlongSurfaceNormal(
  surfacePoint: THREE.Vector3,
  normal: THREE.Vector3,
  camera: THREE.Camera,
  liftPx: number,
  viewportHeightCss: number
): THREE.Vector3 {
  const n = normal.clone();
  if (n.lengthSq() < 1e-12) towardCameraDirection(surfacePoint, camera, n);
  else n.normalize();
  const towardCam = towardCameraDirection(surfacePoint, camera);
  if (n.dot(towardCam) < 0) n.negate();
  const lift = screenPixelsToWorldRadius(liftPx, surfacePoint, camera, viewportHeightCss);
  return surfacePoint.clone().addScaledVector(n, lift);
}

/** Convert a CSS-pixel size at `worldPoint` to world units (matches brush preview scaling). */
export function screenPixelsToWorldRadius(
  pixels: number,
  worldPoint: THREE.Vector3,
  camera: THREE.Camera,
  viewportHeightCss: number
): number {
  const vFov =
    (camera instanceof THREE.PerspectiveCamera ? camera.fov : 45) * (Math.PI / 180);
  const dist = camera.position.distanceTo(worldPoint);
  const k = (2 * Math.tan(vFov / 2)) / Math.max(1, viewportHeightCss);
  return Math.max(1e-6, pixels * k * dist);
}

/**
 * Project a paint stroke onto the front surface, capturing face normals so the stroke can be
 * drawn as a thin ribbon on the tangent plane (wide in-plane, ~1px toward the camera).
 */
export function projectScreenStrokeWithNormals(
  stroke: Vec2[],
  camera: THREE.Camera,
  mesh: THREE.Object3D,
  domElement: HTMLElement
): SurfaceStrokeSample[] {
  if (stroke.length < 2) return [];

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const rect = domElement.getBoundingClientRect();
  const samples: SurfaceStrokeSample[] = [];
  const towardCamera = new THREE.Vector3();
  const liftScratch = new THREE.Vector3();

  for (const p of densifyStroke(stroke, SEGMENT_SAMPLES)) {
    ndc.x = (p.x / rect.width) * 2 - 1;
    ndc.y = -(p.y / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const intersections = raycaster
      .intersectObject(mesh, false)
      .sort((a, b) => a.distance - b.distance);
    if (intersections.length === 0) continue;

    const hit = intersections[0];
    towardCamera.copy(raycaster.ray.direction).normalize();

    const normal = liftScratch.copy(hit.normal ?? towardCamera);
    if (normal.lengthSq() < 1e-12) normal.copy(towardCamera);
    else normal.normalize();
    if (normal.dot(towardCamera) < 0) normal.negate();

    const point = liftAlongSurfaceNormal(
      hit.point,
      normal,
      camera,
      PAINT_SURFACE_LIFT_PX,
      rect.height
    );

    samples.push({ point, normal: normal.clone() });
  }

  return mergeSurfaceSamples(samples, 0.5);
}

function densifyStroke(stroke: Vec2[], samplesPerSegment: number): Vec2[] {
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

function mergeSurfaceSamples(
  samples: SurfaceStrokeSample[],
  epsilon: number
): SurfaceStrokeSample[] {
  if (samples.length === 0) return [];
  const out: SurfaceStrokeSample[] = [samples[0]];
  for (let i = 1; i < samples.length; i++) {
    if (out[out.length - 1].point.distanceTo(samples[i].point) > epsilon) {
      out.push(samples[i]);
    }
  }
  return out;
}

function mergeNearbyHits(points: THREE.Vector3[], epsilon: number): THREE.Vector3[] {
  if (points.length === 0) return [];
  const out: THREE.Vector3[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (out[out.length - 1].distanceTo(points[i]) > epsilon) {
      out.push(points[i]);
    }
  }
  return out;
}

/** Drop paired samples only when both front and back barely moved (keeps segment alignment). */
function dedupePairedHits(
  front: THREE.Vector3[],
  back: THREE.Vector3[],
  epsilon: number
): { front: THREE.Vector3[]; back: THREE.Vector3[] } {
  const outF: THREE.Vector3[] = [];
  const outB: THREE.Vector3[] = [];
  for (let i = 0; i < front.length; i++) {
    if (outF.length === 0) {
      outF.push(front[i]);
      outB.push(back[i]);
      continue;
    }
    const df = outF[outF.length - 1].distanceTo(front[i]);
    const db = outB[outB.length - 1].distanceTo(back[i]);
    if (df > epsilon || db > epsilon) {
      outF.push(front[i]);
      outB.push(back[i]);
    }
  }
  return { front: outF, back: outB };
}
