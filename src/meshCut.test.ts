import { describe, expect, it } from 'vitest';
import { keepFacesOnLargerVertexSide } from './meshCut';

describe('keepFacesOnLargerVertexSide', () => {
  it('keeps the side with more unique vertices', () => {
    const leftFaces: [number, number, number][] = [
      [0, 1, 2],
      [2, 3, 4],
    ];
    const rightFaces: [number, number, number][] = [[10, 11, 12]];

    const kept = keepFacesOnLargerVertexSide(leftFaces, rightFaces);
    expect(kept).toBe(leftFaces);
  });

  it('removes the side with fewer vertices even when it is screen-left', () => {
    const leftFaces: [number, number, number][] = [[0, 1, 2]];
    const rightFaces: [number, number, number][] = [
      [10, 11, 12],
      [12, 13, 14],
      [14, 15, 16],
    ];

    const kept = keepFacesOnLargerVertexSide(leftFaces, rightFaces);
    expect(kept).toBe(rightFaces);
  });
});
