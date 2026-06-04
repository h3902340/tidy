import * as THREE from 'three';
import type { Vec2 } from './math';

const SEGMENT_SAMPLES = 8;
const SURFACE_LIFT = 0.4;

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

export function projectScreenStroke(
  stroke: Vec2[],
  camera: THREE.Camera,
  mesh: THREE.Object3D,
  domElement: HTMLElement
): THREE.Vector3[] {
  const { front } = projectScreenStrokeFrontBack(stroke, camera, mesh, domElement);
  return front;
}

/** Teddy §5.4: project stroke onto front and back of the solid along view rays. */
export function projectScreenStrokeFrontBack(
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

    // Lift along the view ray instead of the hit face normal: cap/filling triangles can be
    // wound inward, so a normal-based lift is unreliable. The nearest hit (front) lifts
    // toward the camera and the farthest hit (back) lifts away from it, so each line lands
    // just outside its own surface regardless of winding.
    towardCamera.copy(raycaster.ray.direction).normalize();
    const liftBy = (hit: THREE.Intersection, sign: number) =>
      hit.point.clone().addScaledVector(towardCamera, sign * SURFACE_LIFT);

    front.push(liftBy(intersections[0], -1));
    back.push(liftBy(intersections[intersections.length - 1], 1));
  }

  return {
    front: mergeNearbyHits(front, 0.5),
    back: mergeNearbyHits(back, 0.5),
  };
}

/**
 * Project a closed screen-space loop onto the *front* of the object only (nearest hit
 * along each view ray, never the back). Used to define the extrusion base ring
 * (Teddy §5.3). Fails if any part of the loop misses the surface, so the caller can ask
 * the user to redraw a loop that lies entirely over the object.
 */
export function projectClosedLoopToFrontSurface(
  loop: Vec2[],
  camera: THREE.Camera,
  mesh: THREE.Object3D,
  domElement: HTMLElement
): { ring: THREE.Vector3[] } | { error: string } {
  if (loop.length < 3) return { error: 'Loop is too short — draw a closed loop on the surface.' };

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const rect = domElement.getBoundingClientRect();
  const towardCamera = new THREE.Vector3();
  const hits: THREE.Vector3[] = [];
  let misses = 0;

  for (const p of densifyStroke(loop, SEGMENT_SAMPLES)) {
    ndc.x = (p.x / rect.width) * 2 - 1;
    ndc.y = -(p.y / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const intersections = raycaster
      .intersectObject(mesh, false)
      .sort((a, b) => a.distance - b.distance);
    if (intersections.length === 0) {
      misses++;
      continue;
    }
    // Nearest hit = front surface; lift slightly toward the camera so the ring sits just
    // outside its own face (same convention as the front cut path).
    towardCamera.copy(raycaster.ray.direction).normalize();
    hits.push(intersections[0].point.clone().addScaledVector(towardCamera, -SURFACE_LIFT));
  }

  if (misses > 0) {
    return {
      error:
        'Loop is not fully on the surface — keep the whole closed loop over the object and redraw.',
    };
  }

  const ring = mergeNearbyHits(hits, 0.5);
  if (ring.length < 3) {
    return { error: 'Loop did not project onto enough surface — redraw it over the object.' };
  }
  return { ring };
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
