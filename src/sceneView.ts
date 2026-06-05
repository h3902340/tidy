import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Mesh3D } from './teddy';
import { validateCutCrossesBoundary, type CutBoundaryHit } from './cutPolygon';
import { computeScreenSilhouetteFromRender } from './renderSilhouette';
import {
  validateClosedLoopOnSurface,
  projectScreenStrokeFrontBack,
  projectScreenStrokeToPlane,
  projectScreenStrokeOntoSurface,
  worldHitToMeshVertex,
} from './surfaceProjection';
import {
  computeExtrusion,
  fillLoopHole,
  imprintLoop,
  type ExtrusionBase,
} from './extrude';
import { CLOSE_TOLERANCE, closeStroke } from './stroke';
import { createSketchMaterials, PAPER_COLOR, type SketchMaterials } from './sketchShader';
import { SurfacePainter } from './surfacePaint';
import type { Vec2, Vec3 } from './math';

export type DisplayMode = 'solid' | 'wireframe' | 'both';
export type InteractionMode =
  | 'silhouette'
  | 'orbit'
  | 'paint'
  | 'cut'
  | 'extrude';

/** Sub-phases of the two-stroke extrusion gesture (Teddy §4.4 / §5.3). */
export type ExtrudePhase = 'idle' | 'loop' | 'orient' | 'curve';

/**
 * Loop cut runs in three inspectable stages so each can be verified independently:
 *   1. `idle`      — draw the loop; it is projected onto the front surface and shown as a ring.
 *   2. `projected` — loop ring is on the surface; press "Remove triangles" to imprint + cut.
 *   3. `cut`       — enclosed surface removed (open hole shown); press "Fill hole" to close it.
 */
export type LoopCutPhase = 'idle' | 'projected' | 'cut';

export type SilhouetteCompleteHandler = (closed: Vec2[]) => void;
export type ExtrudeStatusHandler = (message: string, type: 'ok' | 'error') => void;
export type ExtrudeMeshHandler = (mesh: Mesh3D) => void;
export type SurfaceEditStatusHandler = (message: string, type: 'ok' | 'error') => void;
export type SurfaceEditMeshHandler = (mesh: Mesh3D) => void;

const CUT_LINE_COLOR = 0xd35400;
/** Base ring highlight while in extrusion mode (paper turns the surface line red). */
const EXTRUDE_RING_COLOR = 0xe03030;
/** Loop-cut projected loop + opening boundary highlight (green, distinct from extrude red). */
const LOOPCUT_RING_COLOR = 0x27c93f;
/** Mesh tint while the loop-cut hole is open (before filling). */
const LOOPCUT_OPEN_COLOR = 0x8fa8c4;
const EXTRUDE_LOOP_PREVIEW = 'rgba(224, 48, 48, 0.8)';
const EXTRUDE_CURVE_PREVIEW = 'rgba(211, 84, 0, 0.85)';
/** Preview: front surface (Teddy §5.4) along view rays. */
const CUT_PREVIEW_FRONT_COLOR = 0x1abc9c;
/** Preview: back surface along view rays. */
const CUT_PREVIEW_BACK_COLOR = 0x9b59b6;

export type CutValidated = {
  silhouette: Vec2[];
  hits: [CutBoundaryHit, CutBoundaryHit];
};

export type CutPreviewPayload = {
  screenStroke: Vec2[];
  validated: CutValidated;
  frontPath: Vec3[];
  backPath: Vec3[];
  /** Camera state captured when the stroke was drawn, so a later orbit doesn't change the cut. */
  camera: THREE.Camera;
};

/** Called after stroke validates and surface projection is shown for review. */
export type CutPreviewHandler = (payload: CutPreviewPayload) => void;

export type CutRejectedHandler = (message: string) => void;

export interface MeshDisplayOptions {
  color?: number;
  wireColor?: number;
  /** One hex color per face (enables flat per-triangle shading). */
  faceColors?: number[];
  opacity?: number;
  /** Per-triangle normals (avoids bad vertex averaging on inflated meshes). */
  flatShading?: boolean;
}

const DEFAULT_MESH_COLOR = 0xffffff;
const DEFAULT_WIRE_COLOR = 0x2d4a63;
/** Render both sides so occasional inverted inflation triangles stay visible. */
const MESH_MATERIAL_SIDE = THREE.DoubleSide;
const SPINE_LINE_COLOR = 0x000000;
/** World-space radius for spine tube meshes. Thin, so midpoint dots stay legible. */
const SPINE_TUBE_RADIUS = 0.4;
/** Colour and radius for the internal-edge midpoint dots drawn on the spine step. */
const SPINE_DOT_COLOR = 0x000000;
const SPINE_DOT_RADIUS = 1.0;
/** Recompute cut silhouette only after the camera has been idle this long (ms). */
const SILHOUETTE_IDLE_MS = 3000;
const DEFAULT_CAMERA_POSITION = new THREE.Vector3(0, -180, 220);
const DEFAULT_ORBIT_TARGET = new THREE.Vector3(0, 0, 0);
/**
 * Creation/drawing view: looking straight down the drawing plane's normal (+z), so the outline
 * stroke is captured perfectly orthogonal to the ground and is not foreshortened by perspective.
 */
const DRAW_CAMERA_POSITION = new THREE.Vector3(0, 0, 284);

/** OrbitControls keeps damped rotation/pan deltas; clear them when snapping the camera. */
function clearOrbitControlsInertia(controls: OrbitControls): void {
  const c = controls as OrbitControls & {
    _sphericalDelta: { theta: number; phi: number; radius: number };
    _panOffset: THREE.Vector3;
    _scale: number;
  };
  c._sphericalDelta.theta = 0;
  c._sphericalDelta.phi = 0;
  c._sphericalDelta.radius = 0;
  c._panOffset.set(0, 0, 0);
  c._scale = 1;
}

export class SceneView {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private meshObject: THREE.Mesh | null = null;
  private wireframe: THREE.LineSegments | null = null;
  private secondaryMeshObject: THREE.Mesh | null = null;
  private secondaryWireframe: THREE.LineSegments | null = null;
  private displayMode: DisplayMode = 'both';
  private interactionMode: InteractionMode = 'silhouette';
  private surfaceLinesGroup: THREE.Group;
  private cutPreviewGroup: THREE.Group;
  private spineLinesGroup: THREE.Group;
  private spineTubeMaterial: THREE.MeshBasicMaterial | null = null;
  private spineDotMaterial: THREE.MeshBasicMaterial | null = null;
  private spineLabelGroup: THREE.Group;
  private overlayCanvas: HTMLCanvasElement;
  private overlayCtx: CanvasRenderingContext2D;
  private painting = false;
  private paintStroke: Vec2[] = [];
  private onCutPreview: CutPreviewHandler | null = null;
  private onCutRejected: CutRejectedHandler | null = null;
  private onCutPendingChange: (() => void) | null = null;
  private pendingCut: CutPreviewPayload | null = null;
  private currentMeshData: Mesh3D | null = null;
  private cutSilhouette: Vec2[] = [];
  private silhouetteIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private onSilhouetteComplete: SilhouetteCompleteHandler | null = null;
  private extrudePhase: ExtrudePhase = 'idle';
  private extrudeBase: ExtrusionBase | null = null;
  private extrudeRingGroup: THREE.Group;
  private onExtrudeStatus: ExtrudeStatusHandler | null = null;
  private onExtrudeLoopReady: (() => void) | null = null;
  private onExtrudeComplete: ExtrudeMeshHandler | null = null;
  private onLoopCutStatus: SurfaceEditStatusHandler | null = null;
  private onLoopCutComplete: SurfaceEditMeshHandler | null = null;
  private onLoopCutPhaseChange: (() => void) | null = null;
  private loopCutPhase: LoopCutPhase = 'idle';
  private loopCutBase: ExtrusionBase | null = null;
  private loopCutMeshBeforeCut: Mesh3D | null = null;
  private sketchMode = false;
  private sketchMaterials: SketchMaterials | null = null;
  private outlineMesh: THREE.Mesh | null = null;
  /** Texture painter for the current main mesh (built for paint-capable, non-preview meshes). */
  private painter: SurfacePainter | null = null;
  private paintColor = 0xd1495b;
  /** Brush thickness as a stroke diameter in screen pixels. */
  private brushPixels = 16;
  /** The mesh's normal (Phong) material, kept aside while the sketch fill is shown so it can be restored. */
  private suspendedFillMaterial: THREE.Material | null = null;
  private grid: THREE.GridHelper | null = null;
  private readonly defaultBackground = new THREE.Color(0xcccccc);

  constructor(container: HTMLElement) {
    this.container = container;
    container.classList.add('scene-view');

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xcccccc);
    this.surfaceLinesGroup = new THREE.Group();
    this.scene.add(this.surfaceLinesGroup);
    this.cutPreviewGroup = new THREE.Group();
    this.scene.add(this.cutPreviewGroup);
    this.spineLinesGroup = new THREE.Group();
    this.spineLinesGroup.scale.set(1, -1, 1);
    this.scene.add(this.spineLinesGroup);
    // Height labels are billboard sprites; they must NOT inherit the y-flip (it would mirror text).
    this.spineLabelGroup = new THREE.Group();
    this.scene.add(this.spineLabelGroup);
    // Base ring lives in world space so it stays put while the camera orbits around it.
    this.extrudeRingGroup = new THREE.Group();
    this.scene.add(this.extrudeRingGroup);

    const aspect = container.clientWidth / Math.max(container.clientHeight, 1);
    this.camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 2000);
    // Start in the creation view: top-down, orthogonal to the drawing plane.
    this.camera.up.set(0, 1, 0);
    this.camera.position.copy(DRAW_CAMERA_POSITION);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.domElement.classList.add('webgl-layer');
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
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 50;
    this.controls.maxDistance = 800;
    this.controls.target.copy(DEFAULT_ORBIT_TARGET);
    this.controls.addEventListener('change', () => {
      if (this.interactionMode === 'cut') {
        this.scheduleCutSilhouetteRefreshOnCameraIdle();
      }
    });

    // Bright, fairly even lighting so a white surface actually reads white (with gentle form
    // shading) and painted colours stay close to the picked colour.
    const ambient = new THREE.AmbientLight(0xffffff, 0.85);
    const dir = new THREE.DirectionalLight(0xffffff, 0.45);
    dir.position.set(120, 200, 180);
    this.scene.add(ambient, dir);

    const grid = new THREE.GridHelper(400, 20, 0xccc8c0, 0xe8e4dc);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -0.5;
    this.scene.add(grid);
    this.grid = grid;

    // Dashed X (red) and Y (green) axes on the drawing plane (z = 0).
    const axisHalf = 200;
    const makeDashedAxis = (a: THREE.Vector3, b: THREE.Vector3, color: number) => {
      const geometry = new THREE.BufferGeometry().setFromPoints([a, b]);
      const line = new THREE.Line(
        geometry,
        new THREE.LineDashedMaterial({
          color,
          dashSize: 8,
          gapSize: 6,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
        })
      );
      line.computeLineDistances();
      return line;
    };
    const axes = new THREE.Group();
    axes.position.z = -0.4;
    axes.add(
      makeDashedAxis(
        new THREE.Vector3(-axisHalf, 0, 0),
        new THREE.Vector3(axisHalf, 0, 0),
        0xffffff
      )
    );
    axes.add(
      makeDashedAxis(
        new THREE.Vector3(0, -axisHalf, 0),
        new THREE.Vector3(0, axisHalf, 0),
        0xffffff
      )
    );
    this.scene.add(axes);

    this.bindOverlayEvents();
    this.bindPaintEvents();
    window.addEventListener('resize', () => this.onResize());
    this.resizeOverlay();
    this.animate();
  }

  setVisible(visible: boolean): void {
    this.container.classList.toggle('hidden', !visible);
    if (visible) this.onResize();
  }

  setOnCutPreview(handler: CutPreviewHandler | null): void {
    this.onCutPreview = handler;
  }

  setOnCutPendingChange(handler: (() => void) | null): void {
    this.onCutPendingChange = handler;
  }

  hasPendingCut(): boolean {
    return this.pendingCut !== null;
  }

  getPendingCut(): CutPreviewPayload | null {
    return this.pendingCut;
  }

  clearPendingCut(): void {
    this.discardPendingCut();
  }

  setOnCutRejected(handler: CutRejectedHandler | null): void {
    this.onCutRejected = handler;
  }

  getCutSilhouette(): Vec2[] {
    return this.cutSilhouette;
  }

  setOnSilhouetteComplete(handler: SilhouetteCompleteHandler | null): void {
    this.onSilhouetteComplete = handler;
  }

  setOnExtrudeStatus(handler: ExtrudeStatusHandler | null): void {
    this.onExtrudeStatus = handler;
  }

  setOnExtrudeLoopReady(handler: (() => void) | null): void {
    this.onExtrudeLoopReady = handler;
  }

  setOnExtrudeComplete(handler: ExtrudeMeshHandler | null): void {
    this.onExtrudeComplete = handler;
  }

  setOnLoopCutStatus(handler: SurfaceEditStatusHandler | null): void {
    this.onLoopCutStatus = handler;
  }

  setOnLoopCutComplete(handler: SurfaceEditMeshHandler | null): void {
    this.onLoopCutComplete = handler;
  }

  setOnLoopCutPhaseChange(handler: (() => void) | null): void {
    this.onLoopCutPhaseChange = handler;
  }

  getLoopCutPhase(): LoopCutPhase {
    return this.loopCutPhase;
  }

  getExtrudePhase(): ExtrudePhase {
    return this.extrudePhase;
  }

  /** Project screen-space points onto the z = 0 drawing plane (world coords). */
  projectScreenToMeshPlane(screenPoints: Vec2[]): Vec2[] {
    const hits = projectScreenStrokeToPlane(
      screenPoints,
      this.camera,
      this.overlayCanvas
    );
    return hits.map((p) => ({ x: p.x, y: -p.y }));
  }

  setInteractionMode(mode: InteractionMode): void {
    this.interactionMode = mode;
    if (mode !== 'extrude') this.resetExtrudeState();
    if (mode !== 'cut') this.resetLoopCutState();
    const overlayActive =
      mode === 'silhouette' ||
      mode === 'paint' ||
      mode === 'cut' ||
      mode === 'extrude';
    if (!overlayActive) {
      this.painting = false;
      this.paintStroke = [];
      this.cutSilhouette = [];
      this.cancelSilhouetteIdleRefresh();
      this.discardPendingCut();
      this.clearOverlay();
    } else if (mode === 'cut') {
      // Unified cut: a closed loop on the surface does a loop cut; an open stroke crossing the
      // silhouette does a cut-through. The kind is detected when the stroke finishes.
      this.painting = false;
      this.paintStroke = [];
      this.discardPendingCut();
      this.resetLoopCutState();
      this.scheduleCutSilhouetteRefreshImmediate();
    } else if (mode === 'extrude') {
      this.painting = false;
      this.paintStroke = [];
      this.discardPendingCut();
      this.clearOverlay();
      this.startExtrude();
    }
    this.syncPointerAndOrbitState();
  }

  /** Overlay captures strokes; orbit uses the canvas during a cut review or extrusion re-orient. */
  private syncPointerAndOrbitState(): void {
    const cutMode = this.interactionMode === 'cut';
    const cutReviewing = cutMode && this.pendingCut !== null;
    const loopCutReviewing = cutMode && this.loopCutPhase !== 'idle';
    // Drawing sub-state of cut mode: nothing staged yet, so the overlay captures the stroke.
    const cutDrawing = cutMode && this.pendingCut === null && this.loopCutPhase === 'idle';
    const extrudeDrawing =
      this.interactionMode === 'extrude' &&
      (this.extrudePhase === 'loop' || this.extrudePhase === 'curve');
    const extrudeOrbit =
      this.interactionMode === 'extrude' && this.extrudePhase === 'orient';
    // Paint mode is excluded: painting happens on the WebGL canvas (left button) while the camera
    // controls handle the other buttons, so the overlay must stay click-through.
    const overlayActive =
      this.interactionMode === 'silhouette' || cutDrawing || extrudeDrawing;

    this.overlayCanvas.classList.toggle('overlay-interactive', overlayActive);

    const paintMode = this.interactionMode === 'paint';
    this.renderer.domElement.classList.toggle('paint-cursor', paintMode);
    if (paintMode) {
      // Left is reserved for painting; orbit/pan move to the right/middle buttons (wheel = zoom).
      this.controls.mouseButtons = {
        LEFT: null as unknown as THREE.MOUSE,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: THREE.MOUSE.ROTATE,
      };
    } else {
      this.controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN,
      };
    }
    this.controls.enabled =
      this.interactionMode === 'orbit' ||
      paintMode ||
      cutReviewing ||
      loopCutReviewing ||
      extrudeOrbit;
  }

  private cancelSilhouetteIdleRefresh(): void {
    if (this.silhouetteIdleTimer !== null) {
      clearTimeout(this.silhouetteIdleTimer);
      this.silhouetteIdleTimer = null;
    }
  }

  /** Hide stale silhouette while the camera moves; recompute after idle. */
  private clearCutSilhouetteOverlay(): void {
    if (this.cutSilhouette.length === 0) return;
    this.cutSilhouette = [];
    this.drawCutOverlay();
  }

  /** Debounced: used while orbiting in cut mode (render pass is expensive). */
  private scheduleCutSilhouetteRefreshOnCameraIdle(): void {
    this.clearCutSilhouetteOverlay();
    this.cancelSilhouetteIdleRefresh();
    this.silhouetteIdleTimer = setTimeout(() => {
      this.silhouetteIdleTimer = null;
      this.scheduleCutSilhouetteRefreshImmediate();
    }, SILHOUETTE_IDLE_MS);
  }

  /** Immediate: entering cut mode, resize, mesh update, stroke validation. */
  private scheduleCutSilhouetteRefreshImmediate(): void {
    requestAnimationFrame(() => {
      this.refreshCutSilhouette();
      requestAnimationFrame(() => this.refreshCutSilhouette());
    });
  }

  getMeshPolygon(): Vec2[] {
    if (!this.meshObject) return [];
    const pos = this.meshObject.geometry.getAttribute('position');
    const out: Vec2[] = [];
    for (let i = 0; i < pos.count; i++) {
      out.push({ x: pos.getX(i), y: pos.getY(i) });
    }
    return out;
  }

  getCurrentMesh(): Mesh3D | null {
    return this.currentMeshData;
  }

  /** Rendered mesh (world transform includes y-flip). */
  getMeshObject(): THREE.Mesh | null {
    return this.meshObject;
  }

  getCamera(): THREE.Camera {
    return this.camera;
  }

  /** Frozen copy of the live camera so a cut uses the view from when its stroke was drawn. */
  private snapshotCamera(): THREE.Camera {
    const snapshot = this.camera.clone() as THREE.Camera;
    snapshot.position.copy(this.camera.position);
    snapshot.quaternion.copy(this.camera.quaternion);
    snapshot.scale.copy(this.camera.scale);
    snapshot.updateMatrixWorld(true);
    if (
      snapshot instanceof THREE.PerspectiveCamera ||
      snapshot instanceof THREE.OrthographicCamera
    ) {
      snapshot.updateProjectionMatrix();
    }
    return snapshot;
  }

  getOverlayElement(): HTMLElement {
    return this.overlayCanvas;
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
      if (this.interactionMode === 'orbit') return;
      if (this.interactionMode !== 'silhouette' && !this.meshObject) return;
      if (
        this.interactionMode === 'extrude' &&
        this.extrudePhase !== 'loop' &&
        this.extrudePhase !== 'curve'
      ) {
        return;
      }
      if (this.interactionMode === 'cut') {
        this.discardPendingCut();
      }
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
      if (this.interactionMode === 'silhouette') {
        this.finishSilhouetteStroke();
      } else if (this.interactionMode === 'paint') {
        this.finishPaintStroke();
      } else if (this.interactionMode === 'cut') {
        this.finishCutOrLoopStroke();
      } else if (this.interactionMode === 'extrude') {
        this.finishExtrudeStroke();
      }
    };

    this.overlayCanvas.addEventListener('pointerup', finish);
    this.overlayCanvas.addEventListener('pointercancel', finish);
  }

  /**
   * Paint mode shares the canvas with the camera: the left button paints (handled here on the
   * WebGL canvas), while the right/middle buttons and wheel drive OrbitControls (rotate/pan/zoom).
   * The overlay stays non-interactive in paint mode so these events reach the canvas + controls.
   */
  private bindPaintEvents(): void {
    const el = this.renderer.domElement;
    const getPos = (e: PointerEvent): Vec2 => {
      const rect = el.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    el.addEventListener('pointerdown', (e) => {
      if (this.interactionMode !== 'paint') return;
      if (e.button !== 0) return; // left = paint; other buttons orbit/pan via controls
      if (!this.meshObject || !this.painter) return;
      // OrbitControls captures the pointer on the canvas, so move events keep flowing to us; we
      // deliberately don't capture/release here to avoid clashing with the controls.
      this.painting = true;
      this.paintStroke = [getPos(e)];
      this.drawOverlayPreview();
    });

    el.addEventListener('pointermove', (e) => {
      if (this.interactionMode !== 'paint' || !this.painting) return;
      const p = getPos(e);
      const last = this.paintStroke[this.paintStroke.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) > 2) {
        this.paintStroke.push(p);
        this.drawOverlayPreview();
      }
    });

    const finishPaint = () => {
      if (this.interactionMode !== 'paint' || !this.painting) return;
      this.painting = false;
      this.finishPaintStroke();
    };
    el.addEventListener('pointerup', finishPaint);
    el.addEventListener('pointercancel', finishPaint);
  }

  private finishSilhouetteStroke(): void {
    this.clearOverlay();
    if (this.paintStroke.length < 3) {
      this.paintStroke = [];
      return;
    }

    const projected = this.projectScreenToMeshPlane(this.paintStroke);
    this.paintStroke = [];

    if (projected.length < 3) return;

    const closed = closeStroke(projected, CLOSE_TOLERANCE);
    this.onSilhouetteComplete?.(closed);
  }

  /** Set the brush colour for surface painting (hex, e.g. 0xd1495b). */
  setPaintColor(hex: number): void {
    this.paintColor = hex;
  }

  /** Set the brush thickness, as a stroke diameter in screen pixels. */
  setBrushSize(pixels: number): void {
    this.brushPixels = Math.max(1, pixels);
  }

  private finishPaintStroke(): void {
    this.clearOverlay();
    if (!this.meshObject || !this.painter || this.paintStroke.length < 2) {
      this.paintStroke = [];
      return;
    }

    const projected = projectScreenStrokeOntoSurface(
      this.paintStroke,
      this.camera,
      this.meshObject,
      this.renderer.domElement
    );
    this.paintStroke = [];
    if (projected.length < 1) return;

    // Convert the screen brush thickness to a world radius *per point* (using that point's depth),
    // so the painted band keeps a constant on-screen thickness regardless of zoom/perspective and
    // matches what the user drew. Bake it into the surface texture.
    const vFov =
      (this.camera instanceof THREE.PerspectiveCamera ? this.camera.fov : 45) * (Math.PI / 180);
    const heightPx = Math.max(1, this.renderer.domElement.clientHeight);
    const k = (2 * Math.tan(vFov / 2)) / heightPx;
    const radii = projected.map((p) => {
      const dist = this.camera.position.distanceTo(p);
      return Math.max(0.5, this.brushPixels * 0.5 * k * dist);
    });
    this.painter.paintStroke(projected, radii, this.paintColor);
  }

  /**
   * Unified cut: route the finished stroke to a loop cut (closed loop drawn on the surface) or a
   * cut-through (open stroke crossing the silhouette), based on the stroke's shape.
   */
  private finishCutOrLoopStroke(): void {
    // Only the drawing sub-state should produce a new cut; ignore strokes while one is staged.
    if (this.pendingCut !== null || this.loopCutPhase !== 'idle') {
      this.paintStroke = [];
      this.clearOverlay();
      return;
    }
    if (strokeIsClosedLoop(this.paintStroke)) {
      this.finishLoopCutStroke();
    } else {
      this.finishCutStroke();
    }
  }

  /**
   * Loop cut — stage 1 of 3: project the drawn loop onto the front surface and show it as a
   * ring. The actual cut (stage 2) and fill (stage 3) are triggered from the action buttons so
   * each stage can be inspected on its own.
   */
  private finishLoopCutStroke(): void {
    this.clearOverlay();
    const stroke = [...this.paintStroke];
    this.paintStroke = [];

    if (this.loopCutPhase !== 'idle') return;
    if (!this.meshObject || !this.currentMeshData) return;
    if (stroke.length < 3) {
      this.onLoopCutStatus?.('Loop is too short — draw a closed loop on the surface.', 'error');
      return;
    }

    const closed = closeStroke(stroke, CLOSE_TOLERANCE);
    // Bump removal: the loop may bulge past the silhouette (around a corner / the narrow bottom),
    // so only require that most of it lies over the object — not the whole loop.
    const validated = validateClosedLoopOnSurface(
      closed,
      this.camera,
      this.meshObject,
      this.overlayCanvas
    );
    if ('error' in validated) {
      this.onLoopCutStatus?.(validated.error, 'error');
      return;
    }

    // Imprint immediately with the *draw-time* camera, so a later orbit can't desync the
    // screen-space loop from the mesh. The cut is only revealed in stage 2.
    const before = this.currentMeshData;
    const base = imprintLoop(before, closed, this.camera, this.overlayCanvas);
    if ('error' in base) {
      this.onLoopCutStatus?.(base.error, 'error');
      return;
    }
    const removed = base.removedCount;

    this.loopCutBase = base;
    this.loopCutMeshBeforeCut = before;
    this.loopCutPhase = 'projected';
    // Show the exact opening boundary that will be cut (green = the imprinted loop).
    this.showExtrudeRing(base.ringWorld, LOOPCUT_RING_COLOR);
    this.syncPointerAndOrbitState();
    this.onLoopCutPhaseChange?.();
    this.onLoopCutStatus?.(
      `Loop cut (step 1/3): loop imprinted — will remove ${removed} triangle(s); boundary has ` +
        `${base.holeBoundary.length} vertices (green). [${base.debug ?? ''}] ` +
        `Orbit to inspect, then press "Remove triangles".`,
      'ok'
    );
  }

  /** Loop cut — stage 2 of 3: reveal the cut by removing the enclosed front surface. */
  applyLoopCut(): void {
    if (this.interactionMode !== 'cut' || this.loopCutPhase !== 'projected') return;
    if (!this.loopCutBase || !this.loopCutMeshBeforeCut) return;

    const base = this.loopCutBase;
    const removed = base.removedCount;
    this.loopCutPhase = 'cut';

    // Show the open cut (kept faces only — the hole is visible) and the exact opening boundary.
    this.setMesh(
      { vertices: base.vertices, faces: base.keptFaces },
      { color: LOOPCUT_OPEN_COLOR, wireColor: 0x2d4a63, flatShading: true }
    );
    this.showExtrudeRing(base.ringWorld, LOOPCUT_RING_COLOR);
    this.syncPointerAndOrbitState();
    this.onLoopCutPhaseChange?.();
    this.onLoopCutStatus?.(
      `Loop cut (step 2/3): removed ${removed} triangle(s); opening boundary has ` +
        `${base.holeBoundary.length} vertices (green). Orbit to inspect the hole, then press "Fill hole".`,
      'ok'
    );
  }

  /** Loop cut — stage 3 of 3: fill the opening left by the cut. */
  fillLoopCut(): void {
    if (this.interactionMode !== 'cut' || this.loopCutPhase !== 'cut') return;
    if (!this.loopCutBase || !this.loopCutMeshBeforeCut) return;

    const filled = fillLoopHole(this.loopCutMeshBeforeCut, this.loopCutBase);
    if ('error' in filled) {
      this.onLoopCutStatus?.(filled.error, 'error');
      return;
    }

    const capFaces = filled.mesh.faces.length - this.loopCutBase.keptFaces.length;
    this.clearExtrudeRing();
    this.resetLoopCutState();
    this.onLoopCutComplete?.(filled.mesh);
    this.onLoopCutPhaseChange?.();
    this.onLoopCutStatus?.(
      `Loop cut (step 3/3): filled the opening with ${capFaces} triangle(s). ` +
        `Mesh now has ${filled.mesh.faces.length} triangles.`,
      'ok'
    );
  }

  /** Discard an in-progress loop cut and restore the mesh as it was before the cut. */
  cancelLoopCut(): void {
    if (this.interactionMode !== 'cut') return;
    const restore = this.loopCutMeshBeforeCut;
    this.clearExtrudeRing();
    this.resetLoopCutState();
    if (restore) {
      this.setMesh(restore, { color: DEFAULT_MESH_COLOR, flatShading: true });
    }
    this.syncPointerAndOrbitState();
    this.onLoopCutPhaseChange?.();
    this.onLoopCutStatus?.(
      'Loop cut discarded. Draw a new closed loop on the surface.',
      'ok'
    );
  }

  private resetLoopCutState(): void {
    this.loopCutPhase = 'idle';
    this.loopCutBase = null;
    this.loopCutMeshBeforeCut = null;
    this.clearExtrudeRing();
  }

  /** Begin the extrusion gesture: await the closed base loop on the surface. */
  private startExtrude(): void {
    this.resetExtrudeState();
    this.extrudePhase = 'loop';
    this.onExtrudeStatus?.(
      'Extrude: draw a closed loop on the object surface (front face).',
      'ok'
    );
  }

  private resetExtrudeState(): void {
    this.extrudePhase = 'idle';
    this.extrudeBase = null;
    this.painting = false;
    this.paintStroke = [];
    this.clearExtrudeRing();
  }

  /** Step from the orient phase to the second (extruding) stroke. Returns false if not ready. */
  confirmExtrudeOrientation(): boolean {
    if (
      this.interactionMode !== 'extrude' ||
      this.extrudePhase !== 'orient' ||
      !this.extrudeBase
    ) {
      return false;
    }
    this.extrudePhase = 'curve';
    this.syncPointerAndOrbitState();
    this.onExtrudeStatus?.(
      'Now draw the extruding stroke: start on one side of the red loop and end on the other.',
      'ok'
    );
    return true;
  }

  cancelExtrude(): void {
    this.resetExtrudeState();
    this.clearOverlay();
    this.syncPointerAndOrbitState();
  }

  private finishExtrudeStroke(): void {
    this.clearOverlay();
    const stroke = [...this.paintStroke];
    this.paintStroke = [];

    if (!this.meshObject || !this.currentMeshData) return;

    if (this.extrudePhase === 'loop') {
      if (stroke.length < 3) {
        this.onExtrudeStatus?.(
          'Loop is too short — draw a closed loop on the surface.',
          'error'
        );
        return;
      }
      const closed = closeStroke(stroke, CLOSE_TOLERANCE);
      // Same base as loop cut: the loop may bulge past the silhouette (around a corner / edge),
      // so only require that most of it lies over the object.
      const validated = validateClosedLoopOnSurface(
        closed,
        this.camera,
        this.meshObject,
        this.overlayCanvas
      );
      if ('error' in validated) {
        this.onExtrudeStatus?.(validated.error, 'error');
        return;
      }
      // Imprint the loop into the mesh (occlusion-based, like loop cut): the enclosed near surface
      // is removed and the resulting opening boundary becomes the extrusion base ring.
      const base = imprintLoop(this.currentMeshData, closed, this.camera, this.overlayCanvas);
      if ('error' in base) {
        this.onExtrudeStatus?.(base.error, 'error');
        return;
      }
      this.extrudeBase = base;
      this.showExtrudeRing(base.ringWorld);
      this.extrudePhase = 'orient';
      this.syncPointerAndOrbitState();
      this.onExtrudeLoopReady?.();
      this.onExtrudeStatus?.(
        'Loop locked on the surface (red). Rotate the view, then Confirm orientation.',
        'ok'
      );
      return;
    }

    if (this.extrudePhase === 'curve') {
      if (!this.extrudeBase) return;
      if (stroke.length < 2) {
        this.onExtrudeStatus?.('Extruding stroke is too short.', 'error');
        return;
      }
      const result = computeExtrusion(
        this.extrudeBase,
        stroke,
        this.camera,
        this.overlayCanvas
      );
      if ('error' in result) {
        this.onExtrudeStatus?.(result.error, 'error');
        return;
      }
      this.resetExtrudeState();
      this.onExtrudeComplete?.(result.mesh);
    }
  }

  private showExtrudeRing(ring: THREE.Vector3[], color = EXTRUDE_RING_COLOR): void {
    this.clearExtrudeRing();
    if (ring.length < 2) return;
    const points = ring.map((p) => p.clone());
    points.push(points[0].clone());
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({
        color,
        depthTest: false,
        depthWrite: false,
      })
    );
    line.renderOrder = 20;
    this.extrudeRingGroup.add(line);
  }

  private clearExtrudeRing(): void {
    while (this.extrudeRingGroup.children.length > 0) {
      const child = this.extrudeRingGroup.children[0];
      this.extrudeRingGroup.remove(child);
      if (child instanceof THREE.Line) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
  }

  private finishCutStroke(): void {
    const stroke = [...this.paintStroke];
    this.paintStroke = [];

    if (!this.meshObject || !this.currentMeshData) {
      this.drawCutOverlay();
      return;
    }

    if (stroke.length < 2) {
      this.onCutRejected?.('Cut stroke is too short.');
      this.drawCutOverlay();
      return;
    }

    this.refreshCutSilhouette();
    if (this.cutSilhouette.length < 3) {
      this.onCutRejected?.('Could not compute object silhouette from the current view.');
      this.drawCutOverlay();
      return;
    }

    const validated = validateCutCrossesBoundary(this.cutSilhouette, stroke);
    if ('error' in validated) {
      this.onCutRejected?.(validated.error);
      this.drawCutOverlay(stroke);
      return;
    }

    const { front, back } = projectScreenStrokeFrontBack(
      stroke,
      this.camera,
      this.meshObject,
      this.overlayCanvas
    );

    if (front.length < 2 || back.length < 2) {
      this.onCutRejected?.(
        'Could not project cut onto the surface. Adjust the view or redraw the stroke.'
      );
      this.drawCutOverlay(stroke);
      return;
    }

    const frontPath = front.map(worldHitToMeshVertex);
    const backPath = back.map(worldHitToMeshVertex);

    this.pendingCut = {
      screenStroke: stroke,
      validated: {
        silhouette: validated.silhouette,
        hits: validated.hits,
      },
      frontPath,
      backPath,
      camera: this.snapshotCamera(),
    };

    this.showCutProjectionPreview(front, back);
    this.syncPointerAndOrbitState();
    this.onCutPreview?.(this.pendingCut);
    this.drawCutOverlay();
  }

  /** Recompute screen silhouette for cut mode (call after camera / mesh changes). */
  refreshCutSilhouette(): void {
    // Only show the silhouette guide while actively drawing a cut stroke (nothing staged yet).
    const drawing =
      this.interactionMode === 'cut' &&
      this.pendingCut === null &&
      this.loopCutPhase === 'idle';
    if (!drawing || !this.currentMeshData) {
      this.cutSilhouette = [];
      if (this.interactionMode === 'cut') this.drawCutOverlay();
      return;
    }

    const rect = this.overlayCanvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      this.scheduleCutSilhouetteRefreshImmediate();
      return;
    }

    this.controls.update();
    this.camera.updateMatrixWorld(true);
    this.camera.updateProjectionMatrix();

    if (!this.meshObject) {
      this.cutSilhouette = [];
    } else {
      this.cutSilhouette = computeScreenSilhouetteFromRender(
        this.renderer,
        this.meshObject,
        this.camera,
        rect.width,
        rect.height
      );
    }

    if (this.cutSilhouette.length < 3) {
      this.onCutRejected?.(
        'Could not compute projected silhouette — try rotating the view slightly.'
      );
    }
    this.drawCutOverlay();
  }

  private clearOverlayBuffer(): void {
    this.overlayCtx.save();
    this.overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    this.overlayCtx.restore();
  }

  private drawCutOverlay(stroke: Vec2[] = this.paintStroke): void {
    if (this.overlayCanvas.clientWidth < 2) return;

    this.clearOverlayBuffer();

    if (this.cutSilhouette.length >= 3) {
      this.overlayCtx.save();
      this.overlayCtx.fillStyle = 'rgba(45, 90, 142, 0.12)';
      this.overlayCtx.strokeStyle = '#1a4d8c';
      this.overlayCtx.lineWidth = 3;
      this.overlayCtx.setLineDash([10, 6]);
      this.overlayCtx.lineJoin = 'round';
      this.overlayCtx.lineCap = 'round';
      this.overlayCtx.beginPath();
      this.overlayCtx.moveTo(this.cutSilhouette[0].x, this.cutSilhouette[0].y);
      for (let i = 1; i < this.cutSilhouette.length; i++) {
        this.overlayCtx.lineTo(this.cutSilhouette[i].x, this.cutSilhouette[i].y);
      }
      this.overlayCtx.closePath();
      this.overlayCtx.fill();
      this.overlayCtx.stroke();
      this.overlayCtx.setLineDash([]);
      this.overlayCtx.restore();
    }

    if (stroke.length >= 2) {
      this.overlayCtx.lineCap = 'round';
      this.overlayCtx.lineJoin = 'round';
      this.overlayCtx.setLineDash([]);
      this.overlayCtx.strokeStyle = 'rgba(211, 84, 0, 0.75)';
      this.overlayCtx.lineWidth = 2.5;
      this.overlayCtx.beginPath();
      this.overlayCtx.moveTo(stroke[0].x, stroke[0].y);
      for (let i = 1; i < stroke.length; i++) {
        this.overlayCtx.lineTo(stroke[i].x, stroke[i].y);
      }
      this.overlayCtx.stroke();
    }
  }

  private discardPendingCut(): void {
    const hadPending = this.pendingCut !== null;
    this.pendingCut = null;
    this.clearCutProjectionPreview();
    this.syncPointerAndOrbitState();
    if (hadPending) this.onCutPendingChange?.();
  }

  clearCutProjectionPreview(): void {
    while (this.cutPreviewGroup.children.length > 0) {
      const child = this.cutPreviewGroup.children[0];
      this.cutPreviewGroup.remove(child);
      if (child instanceof THREE.Line) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
  }

  private showCutProjectionPreview(front: THREE.Vector3[], back: THREE.Vector3[]): void {
    this.clearCutProjectionPreview();
    this.addCutPreviewLine(front, CUT_PREVIEW_FRONT_COLOR);
    this.addCutPreviewLine(back, CUT_PREVIEW_BACK_COLOR);
  }

  private addCutPreviewLine(points: THREE.Vector3[], color: number): void {
    if (points.length < 2) return;
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({
        color,
        depthTest: true,
        depthWrite: true,
      })
    );
    line.renderOrder = 11;
    this.cutPreviewGroup.add(line);
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
    if (this.interactionMode === 'cut') {
      this.drawCutOverlay();
      return;
    }

    const w = this.overlayCanvas.clientWidth;
    const h = this.overlayCanvas.clientHeight;
    this.overlayCtx.clearRect(0, 0, w, h);
    if (this.paintStroke.length < 2) return;

    this.overlayCtx.lineCap = 'round';
    this.overlayCtx.lineJoin = 'round';
    this.overlayCtx.strokeStyle = this.overlayStrokeStyle();
    // In paint mode preview the actual brush thickness so the on-screen stroke matches the paint.
    this.overlayCtx.lineWidth = this.interactionMode === 'paint' ? this.brushPixels : 2.5;
    this.overlayCtx.beginPath();
    this.overlayCtx.moveTo(this.paintStroke[0].x, this.paintStroke[0].y);
    for (let i = 1; i < this.paintStroke.length; i++) {
      this.overlayCtx.lineTo(this.paintStroke[i].x, this.paintStroke[i].y);
    }
    this.overlayCtx.stroke();
  }

  private overlayStrokeStyle(): string {
    if (this.interactionMode === 'silhouette') return 'rgba(45, 90, 142, 0.75)';
    if (this.interactionMode === 'extrude') {
      return this.extrudePhase === 'curve'
        ? EXTRUDE_CURVE_PREVIEW
        : EXTRUDE_LOOP_PREVIEW;
    }
    if (this.interactionMode === 'paint') {
      const r = (this.paintColor >> 16) & 255;
      const g = (this.paintColor >> 8) & 255;
      const b = this.paintColor & 255;
      return `rgba(${r}, ${g}, ${b}, 0.65)`;
    }
    return 'rgba(192, 57, 43, 0.55)';
  }

  private clearOverlay(): void {
    this.clearOverlayBuffer();
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
    // Wireframe is suppressed in sketch mode so the pencil look stays clean.
    const showWire =
      !this.sketchMode &&
      (this.displayMode === 'wireframe' || this.displayMode === 'both');
    if (this.meshObject) this.meshObject.visible = this.sketchMode || showSolid;
    if (this.wireframe) this.wireframe.visible = showWire;
    if (this.secondaryMeshObject) this.secondaryMeshObject.visible = showSolid;
    if (this.secondaryWireframe) this.secondaryWireframe.visible = showWire;
  }

  private onResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.resizeOverlay();
    if (this.interactionMode === 'cut') {
      this.scheduleCutSilhouetteRefreshImmediate();
    }
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    if (!this.container.classList.contains('hidden')) {
      this.controls.update();
      if (this.sketchMode && this.sketchMaterials) {
        this.sketchMaterials.update(this.camera, this.renderer);
      }
      this.renderer.render(this.scene, this.camera);
      if (this.interactionMode === 'cut' && this.currentMeshData) {
        this.drawCutOverlay();
      }
    }
  };

  clearSpineOverlay(): void {
    while (this.spineLinesGroup.children.length > 0) {
      const child = this.spineLinesGroup.children[0];
      this.spineLinesGroup.remove(child);
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
      }
    }
    this.spineTubeMaterial?.dispose();
    this.spineTubeMaterial = null;
    this.spineDotMaterial?.dispose();
    this.spineDotMaterial = null;
    while (this.spineLabelGroup.children.length > 0) {
      const child = this.spineLabelGroup.children[0];
      this.spineLabelGroup.remove(child);
      if (child instanceof THREE.Sprite) {
        child.material.map?.dispose();
        child.material.dispose();
      }
    }
  }

  /** Billboard text sprite (always faces the camera) for spine height labels. */
  private makeTextSprite(text: string): THREE.Sprite {
    const pad = 8;
    const fontPx = 48;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.font = `bold ${fontPx}px sans-serif`;
    const textWidth = ctx.measureText(text).width;
    canvas.width = Math.ceil(textWidth + pad * 2);
    canvas.height = fontPx + pad * 2;

    ctx.font = `bold ${fontPx}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
    ctx.fillStyle = '#111111';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({
      map: texture,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    const sprite = new THREE.Sprite(material);
    const worldHeight = 9;
    sprite.scale.set((worldHeight * canvas.width) / canvas.height, worldHeight, 1);
    return sprite;
  }

  /**
   * Draw the chordal-axis spine as thin black tubes, with a dot at every spine node (the
   * midpoints of the remaining internal edges plus junction/fan tips) so the connectivity can be
   * checked at a glance. Pruned edges absorbed into terminal fans are not spine nodes, so they
   * are intentionally not dotted.
   *
   * When `onSurface` is true, depth testing is enabled so the spine is drawn on the mesh rather
   * than floating above it — use during creation steps to verify alignment.
   */
  setSpineOverlay(
    vertices: { x: number; y: number; z: number }[],
    segments: [number, number][],
    options: { showHeights?: boolean; onSurface?: boolean } = {}
  ): void {
    const { showHeights = false, onSurface = false } = options;
    this.clearSpineOverlay();
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3();
    this.spineTubeMaterial?.dispose();
    this.spineTubeMaterial = new THREE.MeshBasicMaterial({
      color: SPINE_LINE_COLOR,
      depthTest: onSurface,
      depthWrite: false,
    });
    const material = this.spineTubeMaterial;
    const overlayOrder = onSurface ? 2 : 1000;

    for (const [a, b] of segments) {
      const va = vertices[a];
      const vb = vertices[b];
      const dx = vb.x - va.x;
      const dy = vb.y - va.y;
      const dz = vb.z - va.z;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-6) continue;

      const geometry = new THREE.CylinderGeometry(
        SPINE_TUBE_RADIUS,
        SPINE_TUBE_RADIUS,
        len,
        8,
        1,
        false
      );
      const tube = new THREE.Mesh(geometry, material);
      tube.position.set(
        (va.x + vb.x) / 2,
        (va.y + vb.y) / 2,
        (va.z + vb.z) / 2
      );
      dir.set(dx / len, dy / len, dz / len);
      tube.quaternion.setFromUnitVectors(up, dir);
      tube.renderOrder = overlayOrder;
      this.spineLinesGroup.add(tube);
    }

    const nodeIds = new Set<number>();
    for (const [a, b] of segments) {
      nodeIds.add(a);
      nodeIds.add(b);
    }
    if (nodeIds.size > 0) {
      this.spineDotMaterial?.dispose();
      this.spineDotMaterial = new THREE.MeshBasicMaterial({
        color: SPINE_DOT_COLOR,
        depthTest: onSurface,
        depthWrite: false,
      });
      const dotGeometry = new THREE.SphereGeometry(SPINE_DOT_RADIUS, 10, 8);
      for (const id of nodeIds) {
        const v = vertices[id];
        if (!v) continue;
        const dot = new THREE.Mesh(dotGeometry.clone(), this.spineDotMaterial);
        dot.position.set(v.x, v.y, v.z);
        dot.renderOrder = overlayOrder + 1;
        this.spineLinesGroup.add(dot);

        if (showHeights) {
          const label = this.makeTextSprite(v.z.toFixed(1));
          // The label group is not y-flipped, so mirror the y to match the dot, then float it up.
          label.position.set(v.x, -v.y + 8, v.z);
          label.renderOrder = onSurface ? 4 : 1002;
          this.spineLabelGroup.add(label);
        }
      }
      dotGeometry.dispose();
    }
  }

  clearSecondaryMesh(): void {
    if (this.secondaryMeshObject) {
      this.scene.remove(this.secondaryMeshObject);
      this.secondaryMeshObject.geometry.dispose();
      (this.secondaryMeshObject.material as THREE.Material).dispose();
      this.secondaryMeshObject = null;
    }
    if (this.secondaryWireframe) {
      this.scene.remove(this.secondaryWireframe);
      this.secondaryWireframe.geometry.dispose();
      (this.secondaryWireframe.material as THREE.Material).dispose();
      this.secondaryWireframe = null;
    }
  }

  /** Overlay mesh (e.g. green terminal fans on top of classified CDT). */
  setSecondaryMesh(mesh: Mesh3D | null, options: MeshDisplayOptions = {}): void {
    this.clearSecondaryMesh();
    if (!mesh || mesh.vertices.length === 0) return;

    const built = this.buildMeshGeometry(mesh, options);
    const opacity = options.opacity ?? 1;

    const material = new THREE.MeshPhongMaterial({
      color: built.useFaceColors ? 0xffffff : (options.color ?? DEFAULT_MESH_COLOR),
      vertexColors: built.useFaceColors,
      side: MESH_MATERIAL_SIDE,
      flatShading: built.useFaceColors,
      transparent: opacity < 1,
      opacity,
      depthWrite: opacity >= 1,
      shininess: 30,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    this.secondaryMeshObject = new THREE.Mesh(built.geometry, material);
    this.secondaryMeshObject.scale.set(1, -1, 1);
    this.secondaryMeshObject.renderOrder = 1;
    this.scene.add(this.secondaryMeshObject);

    const wireGeom = new THREE.WireframeGeometry(built.geometry);
    this.secondaryWireframe = new THREE.LineSegments(
      wireGeom,
      new THREE.LineBasicMaterial({
        color: options.wireColor ?? DEFAULT_WIRE_COLOR,
        transparent: opacity < 1,
        opacity: Math.min(1, opacity + 0.25),
      })
    );
    this.secondaryWireframe.scale.set(1, -1, 1);
    this.secondaryWireframe.renderOrder = 2;
    this.scene.add(this.secondaryWireframe);

    this.applyDisplayMode();
  }

  private buildMeshGeometry(
    mesh: Mesh3D,
    options: MeshDisplayOptions
  ): { geometry: THREE.BufferGeometry; useFaceColors: boolean } {
    const useFaceColors =
      options.faceColors !== undefined &&
      options.faceColors.length === mesh.faces.length;

    const geometry = new THREE.BufferGeometry();

    if (useFaceColors) {
      const positions: number[] = [];
      const colors: number[] = [];
      const color = new THREE.Color();

      for (let fi = 0; fi < mesh.faces.length; fi++) {
        color.setHex(options.faceColors![fi]);
        const [a, b, c] = mesh.faces[fi];
        for (const idx of [a, b, c]) {
          const v = mesh.vertices[idx];
          positions.push(v.x, v.y, v.z);
          colors.push(color.r, color.g, color.b);
        }
      }

      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geometry.computeVertexNormals();
    } else {
      const positions: number[] = [];
      for (const v of mesh.vertices) {
        positions.push(v.x, v.y, v.z);
      }

      const indices: number[] = [];
      for (const [a, b, c] of mesh.faces) {
        indices.push(a, b, c);
      }

      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
    }

    return { geometry, useFaceColors };
  }

  setMesh(mesh: Mesh3D | null, options: MeshDisplayOptions = {}): void {
    this.clearSurfaceLines();
    this.clearOutlineMesh(); // shares geometry with meshObject; drop before disposing it

    if (this.meshObject) {
      this.scene.remove(this.meshObject);
      this.meshObject.geometry.dispose();
      const mat = this.meshObject.material as THREE.Material;
      // The sketch fill material is shared/reused, so only dispose per-mesh (Phong) materials.
      if (mat !== this.sketchMaterials?.fill) mat.dispose();
      this.meshObject = null;
    }
    // Dispose any Phong material hidden behind the sketch fill from the previous mesh.
    if (this.suspendedFillMaterial) {
      this.suspendedFillMaterial.dispose();
      this.suspendedFillMaterial = null;
    }
    if (this.painter) {
      this.painter.dispose(); // also frees the atlas texture
      this.painter = null;
    }
    if (this.wireframe) {
      this.scene.remove(this.wireframe);
      this.wireframe.geometry.dispose();
      (this.wireframe.material as THREE.Material).dispose();
      this.wireframe = null;
    }

    if (!mesh || mesh.vertices.length === 0) {
      this.currentMeshData = null;
      return;
    }

    this.currentMeshData = mesh;
    if (this.interactionMode === 'cut') {
      this.scheduleCutSilhouetteRefreshImmediate();
    }

    // Solid meshes (no per-face preview colours) become paint-capable: their geometry carries a
    // per-triangle texture atlas so strokes can be baked onto the surface. Preview meshes that use
    // flat face colours keep the plain material.
    let geometry: THREE.BufferGeometry;
    let material: THREE.Material;
    const useFaceColors =
      options.faceColors !== undefined && options.faceColors.length === mesh.faces.length;

    if (useFaceColors) {
      const built = this.buildMeshGeometry(mesh, options);
      geometry = built.geometry;
      material = new THREE.MeshPhongMaterial({
        color: 0xffffff,
        vertexColors: true,
        side: MESH_MATERIAL_SIDE,
        flatShading: true,
        shininess: 30,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
    } else {
      const painter = new SurfacePainter(mesh, options.color ?? DEFAULT_MESH_COLOR);
      this.painter = painter;
      geometry = painter.geometry;
      material = painter.material;
    }

    this.meshObject = new THREE.Mesh(geometry, material);
    this.meshObject.scale.set(1, -1, 1);
    this.scene.add(this.meshObject);

    const wireGeom = new THREE.WireframeGeometry(geometry);
    this.wireframe = new THREE.LineSegments(
      wireGeom,
      new THREE.LineBasicMaterial({ color: options.wireColor ?? DEFAULT_WIRE_COLOR })
    );
    this.wireframe.scale.set(1, -1, 1);
    this.scene.add(this.wireframe);

    this.refreshSketchAppearance();
    this.applyDisplayMode();
  }

  /** Toggle the hand-drawn "pencil sketch" rendering (stipple shading + silhouette outline). */
  setSketchMode(enabled: boolean): void {
    if (this.sketchMode === enabled) return;
    this.sketchMode = enabled;
    this.scene.background = enabled
      ? new THREE.Color(PAPER_COLOR)
      : this.defaultBackground;
    if (this.grid) this.grid.visible = !enabled;
    this.refreshSketchAppearance();
    this.applyDisplayMode();
  }

  /** Apply or remove the sketch material/outline on the current mesh to match `sketchMode`. */
  private refreshSketchAppearance(): void {
    this.clearOutlineMesh();

    if (!this.meshObject) return;

    if (!this.sketchMode) {
      // Restore the normal material if the sketch fill is currently shown.
      if (
        this.suspendedFillMaterial &&
        this.meshObject.material === this.sketchMaterials?.fill
      ) {
        this.meshObject.material = this.suspendedFillMaterial;
        this.suspendedFillMaterial = null;
      }
      return;
    }

    if (!this.sketchMaterials) {
      this.sketchMaterials = createSketchMaterials();
    }
    // Plain white paper by default; where the surface is painted, sample that colour so the sketch
    // shows its greyscale value under the stipple shading.
    const fillU = this.sketchMaterials.fill.uniforms;
    (fillU.uPaper.value as THREE.Color).setHex(0xffffff);
    const surfaceTex = this.painter?.material.map ?? null;
    if (surfaceTex) {
      fillU.uColorMap.value = surfaceTex;
      fillU.uHasColorMap.value = 1;
    } else {
      fillU.uHasColorMap.value = 0;
    }

    // Swap in the sketch fill, keeping the Phong material aside so toggling off can restore it.
    if (this.meshObject.material !== this.sketchMaterials.fill) {
      this.suspendedFillMaterial = this.meshObject.material as THREE.Material;
      this.meshObject.material = this.sketchMaterials.fill;
    }

    // Inverted-hull silhouette outline: a slightly inflated back-face shell behind the mesh.
    const outline = new THREE.Mesh(this.meshObject.geometry, this.sketchMaterials.outline);
    outline.scale.copy(this.meshObject.scale);
    outline.renderOrder = -1;
    this.outlineMesh = outline;
    this.scene.add(outline);
  }

  private clearOutlineMesh(): void {
    if (this.outlineMesh) {
      this.scene.remove(this.outlineMesh);
      this.outlineMesh = null; // geometry is shared with meshObject; material is reused
    }
  }

  addCutSurfaceLines(front: Vec3[], back: Vec3[]): void {
    const toWorld = (v: Vec3) => new THREE.Vector3(v.x, -v.y, v.z);
    this.addSurfaceLine(front.map(toWorld), CUT_LINE_COLOR);
    this.addSurfaceLine(back.map(toWorld), CUT_LINE_COLOR);
  }

  /** Restore default orbit distance/angle so a previous zoom-in does not block the next object. */
  resetOrbitCamera(): void {
    this.camera.up.set(0, 1, 0);
    this.camera.position.copy(DEFAULT_CAMERA_POSITION);
    this.controls.target.copy(DEFAULT_ORBIT_TARGET);
    clearOrbitControlsInertia(this.controls);
    this.controls.update();
  }

  /**
   * Top-down view orthogonal to the drawing plane (z = 0), used while drawing the creation
   * outline so the stroke is captured without perspective foreshortening.
   */
  frameDrawingView(): void {
    this.camera.up.set(0, 1, 0);
    this.camera.position.copy(DRAW_CAMERA_POSITION);
    this.controls.target.copy(DEFAULT_ORBIT_TARGET);
    clearOrbitControlsInertia(this.controls);
    this.controls.update();
  }

  clear(): void {
    this.cancelSilhouetteIdleRefresh();
    this.resetExtrudeState();
    this.resetLoopCutState();
    this.setMesh(null);
    this.clearSecondaryMesh();
    this.clearSpineOverlay();
    this.clearSurfaceLines();
    this.discardPendingCut();
    this.clearOverlay();
    this.frameDrawingView();
    this.setInteractionMode('silhouette');
  }
}

/**
 * Decide whether a screen-space stroke is a closed loop (→ loop cut) rather than an open stroke
 * (→ cut-through). A loop has its endpoints close together *and* encloses a meaningful area, which
 * cleanly separates it from a line drawn across the object.
 */
function strokeIsClosedLoop(stroke: Vec2[]): boolean {
  if (stroke.length < 8) return false;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let area2 = 0;
  for (let i = 0; i < stroke.length; i++) {
    const a = stroke[i];
    const b = stroke[(i + 1) % stroke.length];
    area2 += a.x * b.y - b.x * a.y;
    minX = Math.min(minX, a.x);
    minY = Math.min(minY, a.y);
    maxX = Math.max(maxX, a.x);
    maxY = Math.max(maxY, a.y);
  }
  const diag = Math.hypot(maxX - minX, maxY - minY);
  if (diag < 20) return false;

  const first = stroke[0];
  const last = stroke[stroke.length - 1];
  const gap = Math.hypot(last.x - first.x, last.y - first.y);
  const enclosed = Math.abs(area2) / 2;

  // Endpoints near each other, and the enclosed area is a real region (not a thin sliver).
  return gap <= 0.35 * diag && enclosed >= 0.06 * diag * diag;
}
