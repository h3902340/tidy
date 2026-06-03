import cdt2d from 'cdt2d';
import { edgeKey, type Vec2 } from './math';

export interface Triangle2D {
  indices: [number, number, number];
  externalCount: number;
  type: 'T' | 'S' | 'J';
  interiorEdges: [number, number][];
  externalEdges: [number, number][];
}

export function constrainedDelaunay(polygon: Vec2[]): {
  points: Vec2[];
  triangles: Triangle2D[];
  boundaryEdges: Set<string>;
} {
  const points: [number, number][] = polygon.map((p) => [p.x, p.y]);
  const n = points.length;
  const edges: [number, number][] = [];
  const boundaryEdges = new Set<string>();

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    edges.push([i, j]);
    boundaryEdges.add(edgeKey(i, j));
  }

  const cells: [number, number, number][] = cdt2d(points, edges, {
    delaunay: true,
    interior: true,
    exterior: false,
  });

  const triangles: Triangle2D[] = cells.map((cell) => {
    const tri: [number, number, number] = [cell[0], cell[1], cell[2]];
    const triEdges: [number, number][] = [
      [tri[0], tri[1]],
      [tri[1], tri[2]],
      [tri[2], tri[0]],
    ];

    const externalEdges: [number, number][] = [];
    const interiorEdges: [number, number][] = [];

    for (const [a, b] of triEdges) {
      if (boundaryEdges.has(edgeKey(a, b))) {
        externalEdges.push([a, b]);
      } else {
        interiorEdges.push([a, b]);
      }
    }

    const externalCount = externalEdges.length;
    let type: 'T' | 'S' | 'J';
    if (externalCount === 2) type = 'T';
    else if (externalCount === 1) type = 'S';
    else type = 'J';

    return {
      indices: tri,
      externalCount,
      type,
      interiorEdges,
      externalEdges,
    };
  });

  return {
    points: polygon.map((p) => ({ x: p.x, y: p.y })),
    triangles,
    boundaryEdges,
  };
}
