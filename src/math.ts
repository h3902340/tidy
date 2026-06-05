export type Vec2 = { x: number; y: number };
export type Vec3 = { x: number; y: number; z: number };

export function vec2(x: number, y: number): Vec2 {
  return { x, y };
}

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function dist(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

export function dist3(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.hypot(dx, dy, dz);
}

export function midpoint(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function midpoint3(a: Vec3, b: Vec3): Vec3 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

export function edgeKey(i: number, j: number): string {
  return i < j ? `${i}_${j}` : `${j}_${i}`;
}

export function parseEdgeKey(key: string): [number, number] {
  const [a, b] = key.split('_').map(Number);
  return [a, b];
}

export function cross2(o: Vec2, a: Vec2, b: Vec2): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

export function lerp2(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

export function pointInSemicircle(
  p: Vec2,
  edgeA: Vec2,
  edgeB: Vec2,
  interiorSide: Vec2
): boolean {
  const center = midpoint(edgeA, edgeB);
  const radius = dist(edgeA, edgeB) / 2;
  if (dist(p, center) > radius + 1e-6) return false;
  const side = cross2(edgeA, edgeB, interiorSide);
  return cross2(edgeA, edgeB, p) * side >= -1e-6;
}

/** Polyline along the interior semicircle arc (fig. 14b–c), diameter from edgeA to edgeB. */
export function semicircleArcPolyline(
  edgeA: Vec2,
  edgeB: Vec2,
  interiorRef: Vec2,
  segments = 28
): Vec2[] {
  const center = midpoint(edgeA, edgeB);
  const ax = edgeB.x - edgeA.x;
  const ay = edgeB.y - edgeA.y;
  const edgeLen = Math.hypot(ax, ay) || 1e-12;
  const ux = ax / edgeLen;
  const uy = ay / edgeLen;
  let vx = -uy;
  let vy = ux;
  const toRef = cross2(edgeA, edgeB, interiorRef);
  if (cross2(edgeA, edgeB, { x: center.x + vx, y: center.y + vy }) * toRef < 0) {
    vx = uy;
    vy = -ux;
  }
  const r = edgeLen / 2;
  const points: Vec2[] = [];
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI;
    const cu = -Math.cos(theta) * r;
    const sv = Math.sin(theta) * r;
    points.push({
      x: center.x + ux * cu + vx * sv,
      y: center.y + uy * cu + vy * sv,
    });
  }
  return points;
}

export function windingNumber(point: Vec2, polygon: Vec2[]): boolean {
  let wn = 0;
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const p1 = polygon[i];
    const p2 = polygon[(i + 1) % n];
    if (p1.y <= point.y) {
      if (p2.y > point.y && cross2(p1, p2, point) > 0) wn++;
    } else if (p2.y <= point.y && cross2(p1, p2, point) < 0) {
      wn--;
    }
  }
  return wn !== 0;
}
