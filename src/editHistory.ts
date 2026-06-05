import type { Mesh3D } from './teddy';

export type EditSnapshot = {
  /** `null` = empty canvas (before any shape was created). */
  mesh: Mesh3D | null;
  paint?: ImageData;
};

export function cloneMesh(mesh: Mesh3D): Mesh3D {
  return {
    vertices: mesh.vertices.map((v) => ({ x: v.x, y: v.y, z: v.z })),
    faces: mesh.faces.map((f) => [f[0], f[1], f[2]] as [number, number, number]),
  };
}

export function cloneImageData(data: ImageData): ImageData {
  return new ImageData(new Uint8ClampedArray(data.data), data.width, data.height);
}

export class EditHistory {
  private entries: EditSnapshot[] = [];
  private index = -1;

  push(entry: EditSnapshot): void {
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push({
      mesh: entry.mesh ? cloneMesh(entry.mesh) : null,
      paint: entry.paint ? cloneImageData(entry.paint) : undefined,
    });
    this.index = this.entries.length - 1;
  }

  /** Baseline before the first inflated shape; undo targets this entry. */
  seedEmpty(): void {
    this.clear();
    this.push({ mesh: null });
  }

  canUndo(): boolean {
    return this.index > 0;
  }

  canRedo(): boolean {
    return this.index >= 0 && this.index < this.entries.length - 1;
  }

  undo(): EditSnapshot | null {
    if (!this.canUndo()) return null;
    this.index--;
    return this.current();
  }

  redo(): EditSnapshot | null {
    if (!this.canRedo()) return null;
    this.index++;
    return this.current();
  }

  current(): EditSnapshot | null {
    if (this.index < 0) return null;
    const entry = this.entries[this.index];
    return {
      mesh: entry.mesh ? cloneMesh(entry.mesh) : null,
      paint: entry.paint ? cloneImageData(entry.paint) : undefined,
    };
  }

  clear(): void {
    this.entries = [];
    this.index = -1;
  }
}
