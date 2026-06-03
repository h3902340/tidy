declare module 'cdt2d' {
  export interface Cdt2dOptions {
    delaunay?: boolean;
    interior?: boolean;
    exterior?: boolean;
    infinity?: boolean;
  }

  export default function cdt2d(
    points: [number, number][],
    edges?: [number, number][],
    options?: Cdt2dOptions
  ): [number, number, number][];
}
