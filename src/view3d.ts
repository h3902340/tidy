import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Mesh3D } from './teddy';
import { projectScreenStroke, projectScreenStrokeToPlane } from './surfaceProjection';
import type { Vec2 } from './math';

export type DisplayMode = 'solid' | 'wireframe' | 'both';
export type InteractionMode = 'orbit' | 'paint' | 'cut';

const PAINT_LINE_COLOR = 0xc0392b;
const CUT_LINE_COLOR = 0xd35400;

/** Return true if the cut was applied (line is drawn only on success). */
export type CutCompleteHandler = (cutPolyline: Vec2[]) => boolean;

export class View3D {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private meshObject: THREE.Mesh | null = null;
  private wireframe: THREE.LineSegments | null = null;
  private displayMode: DisplayMode = 'wireframe';
  private interactionMode: InteractionMode = 'orbit';
  private surfaceLinesGroup: THREE.Group;
  private overlayCanvas: HTMLCanvasElement;
  private overlayCtx: CanvasRenderingContext2D;
  private painting = false;
  private paintStroke: Vec2[] = [];
  /** Fixed origin for mesh placement so cuts do not shift the model on screen. */
  private displayAnchor: { x: number; y: number; z: number } | null = null;
  private meshCenter = { x: 0, y: 0, z: 0 };
  private onCutComplete: CutCompleteHandler | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    container.classList.add('view3d-wrap');

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf0eeea);
    this.surfaceLinesGroup = new THREE.Group();
    this.scene.add(this.surfaceLinesGroup);

    const aspect = container.clientWidth / Math.max(container.clientHeight, 1);
    this.camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 2000);
    this.camera.position.set(0, -180, 220);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);

    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.className = 'paint-overlay';
    container.appendChild(this.overlayCanvas);
    const ctx = this.overlayCanvas.getContext('2d');
    if (!ctx) throw new Error('Overlay 2D context unavailable');
    this.overlayCtx = ctx;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 50;
    this.controls.maxDistance = 800;

    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    const dir = new THREE.DirectionalLight(0xffffff, 0.85);
    dir.position.set(120, 200, 180);
    this.scene.add(ambient, dir);

    const grid = new THREE.GridHelper(400, 20, 0xccc8c0, 0xe8e4dc);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -0.5;
    this.scene.add(grid);

    this.bindOverlayEvents();
    window.addEventListener('resize', () => this.onResize());
    this.resizeOverlay();
    this.animate();
  }

  setOnCutComplete(handler: CutCompleteHandler | null): void {
    this.onCutComplete = handler;
  }

  setInteractionMode(mode: InteractionMode): void {
    this.interactionMode = mode;
    const overlayActive = mode === 'paint' || mode === 'cut';
    this.overlayCanvas.style.pointerEvents = overlayActive ? 'auto' : 'none';
    this.overlayCanvas.style.cursor = overlayActive ? 'crosshair' : 'default';
    this.controls.enabled = mode === 'orbit';
    if (!overlayActive) {
      this.painting = false;
      this.paintStroke = [];
      this.clearOverlay();
    }
  }

  /** @deprecated Use setInteractionMode */
  setPaintMode(enabled: boolean): void {
    this.setInteractionMode(enabled ? 'paint' : 'orbit');
  }

  getMeshPolygon(): Vec2[] {
    if (!this.meshObject) return [];
    const pos = this.meshObject.geometry.getAttribute('position');
    const out: Vec2[] = [];
    for (let i = 0; i < pos.count; i++) {
      out.push({
        x: pos.getX(i) + this.meshCenter.x,
        y: -pos.getY(i) + this.meshCenter.y,
      });
    }
    return out;
  }

  clearSurfaceLines(): void {
    while (this.surfaceLinesGroup.children.length > 0) {
      const child = this.surfaceLinesGroup.children[0];
      this.surfaceLinesGroup.remove(child);
      if (child instanceof THREE.Line) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
  }

  private bindOverlayEvents(): void {
    const getLocalPos = (e: PointerEvent): Vec2 => {
      const rect = this.overlayCanvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    this.overlayCanvas.addEventListener('pointerdown', (e) => {
      if (this.interactionMode === 'orbit' || !this.meshObject) return;
      e.preventDefault();
      this.overlayCanvas.setPointerCapture(e.pointerId);
      this.painting = true;
      this.paintStroke = [getLocalPos(e)];
      this.drawOverlayPreview();
    });

    this.overlayCanvas.addEventListener('pointermove', (e) => {
      if (!this.painting) return;
      const p = getLocalPos(e);
      const last = this.paintStroke[this.paintStroke.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) > 2) {
        this.paintStroke.push(p);
        this.drawOverlayPreview();
      }
    });

    const finish = (e: PointerEvent) => {
      if (!this.painting) return;
      this.painting = false;
      this.overlayCanvas.releasePointerCapture(e.pointerId);
      if (this.interactionMode === 'paint') {
        this.finishPaintStroke();
      } else if (this.interactionMode === 'cut') {
        this.finishCutStroke();
      }
    };

    this.overlayCanvas.addEventListener('pointerup', finish);
    this.overlayCanvas.addEventListener('pointercancel', finish);
  }

  private threeToMesh(p: THREE.Vector3): Vec2 {
    return { x: p.x + this.meshCenter.x, y: -p.y + this.meshCenter.y };
  }

  private finishPaintStroke(): void {
    this.clearOverlay();
    if (!this.meshObject || this.paintStroke.length < 2) {
      this.paintStroke = [];
      return;
    }

    const projected = projectScreenStroke(
      this.paintStroke,
      this.camera,
      this.meshObject,
      this.renderer.domElement
    );
    this.paintStroke = [];
    if (projected.length < 2) return;

    this.addSurfaceLine(projected, PAINT_LINE_COLOR);
  }

  private finishCutStroke(): void {
    this.clearOverlay();
    if (!this.meshObject || this.paintStroke.length < 2) {
      this.paintStroke = [];
      return;
    }

    const projected = projectScreenStrokeToPlane(
      this.paintStroke,
      this.camera,
      this.overlayCanvas
    );
    this.paintStroke = [];

    if (projected.length < 2) return;

    const cutMesh = projected.map((p) => this.threeToMesh(p));
    const applied = this.onCutComplete?.(cutMesh) ?? false;
    if (applied) {
      this.addSurfaceLine(projected, CUT_LINE_COLOR);
    }
  }

  private addSurfaceLine(points: THREE.Vector3[], color: number): void {
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({ color, depthTest: true, depthWrite: true })
    );
    line.renderOrder = 10;
    this.surfaceLinesGroup.add(line);
  }

  private drawOverlayPreview(): void {
    const w = this.overlayCanvas.clientWidth;
    const h = this.overlayCanvas.clientHeight;
    this.overlayCtx.clearRect(0, 0, w, h);
    if (this.paintStroke.length < 2) return;

    const isCut = this.interactionMode === 'cut';
    this.overlayCtx.lineCap = 'round';
    this.overlayCtx.lineJoin = 'round';
    this.overlayCtx.strokeStyle = isCut ? 'rgba(211, 84, 0, 0.6)' : 'rgba(192, 57, 43, 0.55)';
    this.overlayCtx.lineWidth = 2.5;
    this.overlayCtx.beginPath();
    this.overlayCtx.moveTo(this.paintStroke[0].x, this.paintStroke[0].y);
    for (let i = 1; i < this.paintStroke.length; i++) {
      this.overlayCtx.lineTo(this.paintStroke[i].x, this.paintStroke[i].y);
    }
    this.overlayCtx.stroke();
  }

  private clearOverlay(): void {
    const w = this.overlayCanvas.clientWidth;
    const h = this.overlayCanvas.clientHeight;
    this.overlayCtx.clearRect(0, 0, w, h);
  }

  private resizeOverlay(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    this.overlayCanvas.width = w * dpr;
    this.overlayCanvas.height = h * dpr;
    this.overlayCanvas.style.width = `${w}px`;
    this.overlayCanvas.style.height = `${h}px`;
    this.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setDisplayMode(mode: DisplayMode): void {
    this.displayMode = mode;
    this.applyDisplayMode();
  }

  private applyDisplayMode(): void {
    const showSolid = this.displayMode === 'solid' || this.displayMode === 'both';
    const showWire = this.displayMode === 'wireframe' || this.displayMode === 'both';
    if (this.meshObject) this.meshObject.visible = showSolid;
    if (this.wireframe) this.wireframe.visible = showWire;
  }

  private onResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.resizeOverlay();
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  setMesh(mesh: Mesh3D | null, options?: { preserveView?: boolean }): void {
    this.clearSurfaceLines();

    if (this.meshObject) {
      this.scene.remove(this.meshObject);
      this.meshObject.geometry.dispose();
      (this.meshObject.material as THREE.Material).dispose();
      this.meshObject = null;
    }
    if (this.wireframe) {
      this.scene.remove(this.wireframe);
      this.wireframe.geometry.dispose();
      (this.wireframe.material as THREE.Material).dispose();
      this.wireframe = null;
    }

    if (!mesh || mesh.vertices.length === 0) {
      if (!options?.preserveView) {
        this.displayAnchor = null;
      }
      return;
    }

    const preserveView = options?.preserveView === true && this.displayAnchor !== null;

    if (!preserveView) {
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (const v of mesh.vertices) {
        cx += v.x;
        cy += v.y;
        cz += v.z;
      }
      const inv = 1 / mesh.vertices.length;
      this.displayAnchor = { x: cx * inv, y: cy * inv, z: cz * inv };
    }

    this.meshCenter = this.displayAnchor!;

    const anchor = this.displayAnchor!;
    const positions: number[] = [];
    for (const v of mesh.vertices) {
      positions.push(
        v.x - anchor.x,
        -(v.y - anchor.y),
        v.z - anchor.z
      );
    }

    const indices: number[] = [];
    for (const [a, b, c] of mesh.faces) {
      indices.push(a, c, b);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const material = new THREE.MeshPhongMaterial({
      color: 0x6b9bd1,
      side: THREE.FrontSide,
      flatShading: false,
      shininess: 30,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });

    this.meshObject = new THREE.Mesh(geometry, material);
    this.scene.add(this.meshObject);

    const wireGeom = new THREE.WireframeGeometry(geometry);
    this.wireframe = new THREE.LineSegments(
      wireGeom,
      new THREE.LineBasicMaterial({ color: 0x2d4a63 })
    );
    this.scene.add(this.wireframe);

    this.applyDisplayMode();

    if (!preserveView) {
      geometry.computeBoundingSphere();
      const r = geometry.boundingSphere?.radius ?? 100;
      this.controls.target.set(0, 0, 0);
      this.camera.position.set(0, 0, r * 2.2);
      this.controls.update();
    }
  }

  clear(): void {
    this.displayAnchor = null;
    this.setMesh(null);
    this.clearSurfaceLines();
    this.clearOverlay();
    this.meshCenter = { x: 0, y: 0, z: 0 };
  }
}
