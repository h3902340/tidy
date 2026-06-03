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
  if (stroke.length < 2) return [];

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const rect = domElement.getBoundingClientRect();
  const hits: THREE.Vector3[] = [];
  const normal = new THREE.Vector3();

  for (const p of densifyStroke(stroke, SEGMENT_SAMPLES)) {
    ndc.x = (p.x / rect.width) * 2 - 1;
    ndc.y = -(p.y / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const intersections = raycaster.intersectObject(mesh, false);
    if (intersections.length === 0) continue;

    const hit = intersections[0];
    const point = hit.point.clone();

    if (hit.face) {
      normal.copy(hit.face.normal);
      if (hit.object instanceof THREE.Mesh) {
        normal.transformDirection(hit.object.matrixWorld);
      }
      point.addScaledVector(normal, SURFACE_LIFT);
    }

    hits.push(point);
  }

  return mergeNearbyHits(hits, 0.5);
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
