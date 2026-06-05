/**
 * Texture painting that bakes onto the surface of an arbitrary (procedurally generated) mesh.
 *
 * The inflated Teddy mesh has no UV unwrap and is sparsely/unevenly tessellated, so neither vertex
 * colours (too blocky) nor a planar UV map (front/back bleed, extrusion smear) work well. Instead
 * we build a per-triangle texture atlas (a "ptex"-like layout): the geometry is rebuilt non-indexed
 * and every triangle gets its own square cell in one big texture.
 *
 * The crucial detail is that each cell's size is proportional to the triangle's *world area*, so the
 * texel density is roughly uniform across the surface — a huge interior triangle gets a big cell and
 * a tiny rim triangle gets a small one. This keeps paint high-resolution everywhere and stops the
 * "stair-stepped / cut at triangle edges" look you get when every triangle shares one tiny cell.
 *
 * Painting rasterises a round 3D brush into the atlas by testing each candidate texel's *world
 * position* against the brush, so a stroke flows continuously across triangle/seam boundaries even
 * though neighbouring triangles live in unrelated atlas cells. A one-texel guard ring around each
 * triangle is filled with the nearest edge colour to avoid bilinear bleed at the cell border.
 *
 * Positions/normals are stored in raw mesh space (the renderer applies the (1, -1, 1) scale), while
 * brush queries are in render/world space (x, -y, z) to match camera raycasts.
 */
import * as THREE from 'three';
import type { Mesh3D } from './teddyPipeline';

const MAX_ATLAS_PX = 2048; // keep getImageData()/putImageData() per stroke affordable
const MIN_CELL_PX = 4;
const MAX_CELL_PX = 256;
const GUARD_PX = 1; // border texels around each triangle (filled with edge colour)
const PACK_FILL = 0.6; // leave headroom for shelf-packing waste

export class SurfacePainter {
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.MeshPhongMaterial;
  /** A sensible default brush radius in world units, scaled to the mesh size. */
  readonly defaultRadius: number;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  private readonly atlasPx: number;
  private readonly faceCount: number;
  /** Per face: 9 floats = 3 render-world vertex positions (x, -y, z). */
  private readonly faceW: Float32Array;
  /** Per face: 3 floats = render-world centroid. */
  private readonly faceCentroid: Float32Array;
  /** Per face: bounding radius around the centroid. */
  private readonly faceRadius: Float32Array;
  /** Per face: cell origin x, origin y, size (texels). */
  private readonly cellOx: Int32Array;
  private readonly cellOy: Int32Array;
  private readonly cellSize: Int32Array;

  constructor(mesh: Mesh3D, baseColorHex: number) {
    const T = mesh.faces.length;
    this.faceCount = T;

    // Smooth per-vertex normals from an indexed copy, so the textured (non-indexed) mesh keeps the
    // same smooth shading as the original geometry rather than turning faceted.
    const tmp = new THREE.BufferGeometry();
    const posFlat = new Float32Array(mesh.vertices.length * 3);
    for (let i = 0; i < mesh.vertices.length; i++) {
      posFlat[i * 3] = mesh.vertices[i].x;
      posFlat[i * 3 + 1] = mesh.vertices[i].y;
      posFlat[i * 3 + 2] = mesh.vertices[i].z;
    }
    tmp.setAttribute('position', new THREE.BufferAttribute(posFlat, 3));
    tmp.setIndex(mesh.faces.flat());
    tmp.computeVertexNormals();
    const vnorm = tmp.attributes.normal as THREE.BufferAttribute;

    const positions = new Float32Array(T * 9);
    const normals = new Float32Array(T * 9);
    this.faceW = new Float32Array(T * 9);
    this.faceCentroid = new Float32Array(T * 3);
    this.faceRadius = new Float32Array(T);
    const areas = new Float64Array(T);

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let sumArea = 0;

    for (let f = 0; f < T; f++) {
      const [a, b, c] = mesh.faces[f];
      const ids = [a, b, c];
      let ccx = 0;
      let ccy = 0;
      let ccz = 0;
      for (let k = 0; k < 3; k++) {
        const v = mesh.vertices[ids[k]];
        positions[f * 9 + k * 3] = v.x;
        positions[f * 9 + k * 3 + 1] = v.y;
        positions[f * 9 + k * 3 + 2] = v.z;
        normals[f * 9 + k * 3] = vnorm.getX(ids[k]);
        normals[f * 9 + k * 3 + 1] = vnorm.getY(ids[k]);
        normals[f * 9 + k * 3 + 2] = vnorm.getZ(ids[k]);
        const wx = v.x;
        const wy = -v.y;
        const wz = v.z;
        this.faceW[f * 9 + k * 3] = wx;
        this.faceW[f * 9 + k * 3 + 1] = wy;
        this.faceW[f * 9 + k * 3 + 2] = wz;
        ccx += wx;
        ccy += wy;
        ccz += wz;
        minX = Math.min(minX, wx);
        minY = Math.min(minY, wy);
        minZ = Math.min(minZ, wz);
        maxX = Math.max(maxX, wx);
        maxY = Math.max(maxY, wy);
        maxZ = Math.max(maxZ, wz);
      }
      ccx /= 3;
      ccy /= 3;
      ccz /= 3;
      this.faceCentroid[f * 3] = ccx;
      this.faceCentroid[f * 3 + 1] = ccy;
      this.faceCentroid[f * 3 + 2] = ccz;
      let r = 0;
      for (let k = 0; k < 3; k++) {
        const dx = this.faceW[f * 9 + k * 3] - ccx;
        const dy = this.faceW[f * 9 + k * 3 + 1] - ccy;
        const dz = this.faceW[f * 9 + k * 3 + 2] - ccz;
        r = Math.max(r, Math.hypot(dx, dy, dz));
      }
      this.faceRadius[f] = r;

      // World area via cross product of two edges.
      const e1x = this.faceW[f * 9 + 3] - this.faceW[f * 9];
      const e1y = this.faceW[f * 9 + 4] - this.faceW[f * 9 + 1];
      const e1z = this.faceW[f * 9 + 5] - this.faceW[f * 9 + 2];
      const e2x = this.faceW[f * 9 + 6] - this.faceW[f * 9];
      const e2y = this.faceW[f * 9 + 7] - this.faceW[f * 9 + 1];
      const e2z = this.faceW[f * 9 + 8] - this.faceW[f * 9 + 2];
      const cxp = e1y * e2z - e1z * e2y;
      const cyp = e1z * e2x - e1x * e2z;
      const czp = e1x * e2y - e1y * e2x;
      const area = 0.5 * Math.hypot(cxp, cyp, czp);
      areas[f] = area;
      sumArea += area;
    }
    tmp.dispose();

    // Choose cell sizes ∝ sqrt(area) so the per-world-area texel density is uniform, scaling the
    // whole budget to fit the atlas, then pack the cells. Shrink and repack if it overflows.
    this.cellOx = new Int32Array(T);
    this.cellOy = new Int32Array(T);
    this.cellSize = new Int32Array(T);
    let density =
      sumArea > 0 ? Math.sqrt((PACK_FILL * MAX_ATLAS_PX * MAX_ATLAS_PX) / sumArea) : 1;
    let atlasPx = MAX_ATLAS_PX;
    for (let attempt = 0; attempt < 8; attempt++) {
      for (let f = 0; f < T; f++) {
        const s = Math.round(Math.sqrt(areas[f]) * density);
        this.cellSize[f] = clamp(s, MIN_CELL_PX, MAX_CELL_PX);
      }
      const packed = packShelves(this.cellSize, MAX_ATLAS_PX, this.cellOx, this.cellOy);
      if (packed > 0) {
        atlasPx = packed;
        break;
      }
      density *= 0.8; // overflowed the max atlas — use a smaller budget and retry
    }
    this.atlasPx = atlasPx;

    // Per-face UVs: a right triangle inset by the guard ring inside its cell.
    const uvs = new Float32Array(T * 6);
    for (let f = 0; f < T; f++) {
      const ox = this.cellOx[f];
      const oy = this.cellOy[f];
      const s = this.cellSize[f];
      const g = Math.min(GUARD_PX, Math.floor((s - 1) / 2));
      const u0 = (ox + g) / atlasPx;
      const v0 = (oy + g) / atlasPx;
      const u1 = (ox + s - g) / atlasPx;
      const v1 = (oy + s - g) / atlasPx;
      uvs[f * 6] = u0;
      uvs[f * 6 + 1] = v0;
      uvs[f * 6 + 2] = u1;
      uvs[f * 6 + 3] = v0;
      uvs[f * 6 + 4] = u0;
      uvs[f * 6 + 5] = v1;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.geometry = geom;

    const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
    this.defaultRadius = Math.max(1, diag * 0.02);

    this.canvas = document.createElement('canvas');
    this.canvas.width = atlasPx;
    this.canvas.height = atlasPx;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('SurfacePainter: 2D context unavailable');
    this.ctx = ctx;
    const br = (baseColorHex >> 16) & 255;
    const bg = (baseColorHex >> 8) & 255;
    const bb = baseColorHex & 255;
    ctx.fillStyle = `rgb(${br},${bg},${bb})`;
    ctx.fillRect(0, 0, atlasPx, atlasPx);

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.flipY = false;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;

    this.material = new THREE.MeshPhongMaterial({
      map: this.texture,
      color: 0xffffff,
      side: THREE.DoubleSide,
      shininess: 30,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
  }

  /**
   * Paint a stroke (render-world points) into the atlas with a round, soft-edged brush. `radii`
   * gives the per-point world radius (so the painted band keeps a constant on-screen thickness).
   */
  paintStroke(points: THREE.Vector3[], radii: number[], colorHex: number): void {
    if (points.length === 0) return;
    // The atlas canvas holds sRGB bytes (the texture decodes sRGB on sampling), so write the hex's
    // sRGB components directly. Going via THREE.Color would convert to linear and darken the paint.
    const cr = (colorHex >> 16) & 255;
    const cg = (colorHex >> 8) & 255;
    const cb = colorHex & 255;

    const img = this.ctx.getImageData(0, 0, this.atlasPx, this.atlasPx);
    const data = img.data;

    let prev: THREE.Vector3 | null = null;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const radius = radii[i];
      // Skip overlapping dabs (keep them ~1/3 radius apart) for a continuous, cheap stroke.
      if (prev && i < points.length - 1) {
        const sx = p.x - prev.x;
        const sy = p.y - prev.y;
        const sz = p.z - prev.z;
        const minSpacing = radius * 0.33;
        if (sx * sx + sy * sy + sz * sz < minSpacing * minSpacing) continue;
      }
      prev = p;
      this.paintDab(data, p, radius, cr, cg, cb);
    }

    this.ctx.putImageData(img, 0, 0);
    this.texture.needsUpdate = true;
  }

  private paintDab(
    data: Uint8ClampedArray,
    p: THREE.Vector3,
    radius: number,
    cr: number,
    cg: number,
    cb: number
  ): void {
    const r2 = radius * radius;
    const edge0 = radius * 0.65;
    const A = this.atlasPx;

    for (let f = 0; f < this.faceCount; f++) {
      const dcx = this.faceCentroid[f * 3] - p.x;
      const dcy = this.faceCentroid[f * 3 + 1] - p.y;
      const dcz = this.faceCentroid[f * 3 + 2] - p.z;
      const reach = radius + this.faceRadius[f];
      if (dcx * dcx + dcy * dcy + dcz * dcz > reach * reach) continue;

      const w0x = this.faceW[f * 9];
      const w0y = this.faceW[f * 9 + 1];
      const w0z = this.faceW[f * 9 + 2];
      const e1x = this.faceW[f * 9 + 3] - w0x;
      const e1y = this.faceW[f * 9 + 4] - w0y;
      const e1z = this.faceW[f * 9 + 5] - w0z;
      const e2x = this.faceW[f * 9 + 6] - w0x;
      const e2y = this.faceW[f * 9 + 7] - w0y;
      const e2z = this.faceW[f * 9 + 8] - w0z;

      const ox = this.cellOx[f];
      const oy = this.cellOy[f];
      const s = this.cellSize[f];
      const g = Math.min(GUARD_PX, Math.floor((s - 1) / 2));
      const leg = Math.max(1, s - 2 * g);

      // Restrict the texel scan to the brush's bounding box in this cell: solve for the brush
      // centre's barycentric coords and expand by the brush radius (converted to barycentric).
      let txMin = 0;
      let tyMin = 0;
      let txMax = s;
      let tyMax = s;
      const d11 = e1x * e1x + e1y * e1y + e1z * e1z;
      const d12 = e1x * e2x + e1y * e2y + e1z * e2z;
      const d22 = e2x * e2x + e2y * e2y + e2z * e2z;
      const det = d11 * d22 - d12 * d12;
      if (det > 1e-9) {
        const qx = p.x - w0x;
        const qy = p.y - w0y;
        const qz = p.z - w0z;
        const b1 = qx * e1x + qy * e1y + qz * e1z;
        const b2 = qx * e2x + qy * e2y + qz * e2z;
        const ac = (b1 * d22 - b2 * d12) / det;
        const bc = (d11 * b2 - d12 * b1) / det;
        const ma = radius / Math.sqrt(d11) + 1 / leg;
        const mb = radius / Math.sqrt(d22) + 1 / leg;
        txMin = clampInt(Math.floor((ac - ma) * leg + g), 0, s);
        txMax = clampInt(Math.ceil((ac + ma) * leg + g), 0, s);
        tyMin = clampInt(Math.floor((bc - mb) * leg + g), 0, s);
        tyMax = clampInt(Math.ceil((bc + mb) * leg + g), 0, s);
      }

      for (let ty = tyMin; ty < tyMax; ty++) {
        for (let tx = txMin; tx < txMax; tx++) {
          // Barycentric (a -> vertex1, b -> vertex2) of this texel within the inset triangle.
          let a = (tx + 0.5 - g) / leg;
          let b = (ty + 0.5 - g) / leg;
          if (a < 0) a = 0;
          if (b < 0) b = 0;
          if (a + b > 1) {
            const sum = a + b;
            a /= sum;
            b /= sum;
          }
          const wx = w0x + a * e1x + b * e2x;
          const wy = w0y + a * e1y + b * e2y;
          const wz = w0z + a * e1z + b * e2z;
          const dx = wx - p.x;
          const dy = wy - p.y;
          const dz = wz - p.z;
          const dd = dx * dx + dy * dy + dz * dz;
          if (dd > r2) continue;

          const d = Math.sqrt(dd);
          let alpha = 1;
          if (d > edge0) alpha = 1 - (d - edge0) / (radius - edge0);
          if (alpha <= 0) continue;

          const idx = ((oy + ty) * A + (ox + tx)) * 4;
          const inv = 1 - alpha;
          data[idx] = Math.round(cr * alpha + data[idx] * inv);
          data[idx + 1] = Math.round(cg * alpha + data[idx + 1] * inv);
          data[idx + 2] = Math.round(cb * alpha + data[idx + 2] * inv);
          data[idx + 3] = 255;
        }
      }
    }
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
    this.geometry.dispose();
  }
}

/**
 * Shelf bin-packing: place squares (largest first) into rows of a fixed-width atlas. Returns the
 * smallest power-of-two atlas size that fits everything, or 0 if it overflows `maxWidth`.
 */
function packShelves(
  sizes: Int32Array,
  maxWidth: number,
  outOx: Int32Array,
  outOy: Int32Array
): number {
  const order = Array.from({ length: sizes.length }, (_, i) => i).sort(
    (a, b) => sizes[b] - sizes[a]
  );
  let shelfX = 0;
  let shelfY = 0;
  let shelfH = 0;
  let usedW = 0;
  for (const f of order) {
    const s = sizes[f];
    if (shelfX + s > maxWidth) {
      shelfY += shelfH;
      shelfX = 0;
      shelfH = 0;
    }
    if (shelfY + s > maxWidth) return 0;
    outOx[f] = shelfX;
    outOy[f] = shelfY;
    shelfX += s;
    shelfH = Math.max(shelfH, s);
    usedW = Math.max(usedW, shelfX);
  }
  const needed = Math.max(usedW, shelfY + shelfH);
  let size = 16;
  while (size < needed) size *= 2;
  return Math.min(size, maxWidth);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
