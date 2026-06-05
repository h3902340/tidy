import './style.css';
import { EditHistory, cloneImageData, cloneMesh, type EditSnapshot } from './editHistory';
import { computeTeddyCut, countBoundaryEdges } from './meshCut';
import { SceneView, type DisplayMode, type InteractionMode } from './sceneView';
import { buildTeddyPipelineFromStroke } from './teddy';
import {
  FAN_TERMINAL_COLOR,
  type Mesh3D,
  type TeddyPipelineMeshes,
  type TriangleType,
} from './teddy';
import type { Vec2 } from './math';

const sceneEl = document.querySelector<HTMLElement>('#scene-view')!;
const statusEl = document.querySelector<HTMLElement>('#status')!;
const editToolsEl = document.querySelector<HTMLElement>('#edit-tools')!;
const debugPanelEl = document.querySelector<HTMLElement>('#debug-panel')!;
const debugModeEl = document.querySelector<HTMLInputElement>('#debug-mode')!;
const btnClear = document.querySelector<HTMLButtonElement>('#btn-clear')!;
const btnCircle = document.querySelector<HTMLButtonElement>('#btn-circle')!;
const btnOval = document.querySelector<HTMLButtonElement>('#btn-oval')!;
const btnSquare = document.querySelector<HTMLButtonElement>('#btn-square')!;
const btnTriangle = document.querySelector<HTMLButtonElement>('#btn-triangle')!;
const btnStar = document.querySelector<HTMLButtonElement>('#btn-star')!;
const btnNext = document.querySelector<HTMLButtonElement>('#btn-next-step')!;
const displayModeEl = document.querySelector<HTMLSelectElement>('#display-mode')!;
const sketchModeEl = document.querySelector<HTMLInputElement>('#sketch-mode')!;
const paintPaletteEl = document.querySelector<HTMLDivElement>('#paint-palette')!;
const paintColorEl = document.querySelector<HTMLInputElement>('#paint-color')!;
const swatchEls = Array.from(paintPaletteEl.querySelectorAll<HTMLButtonElement>('.swatch'));
const paintBrushEl = document.querySelector<HTMLInputElement>('#paint-brush')!;
const paintBrushValueEl = document.querySelector<HTMLSpanElement>('#paint-brush-value')!;
const btnDiscardCut = document.querySelector<HTMLButtonElement>('#btn-discard-cut')!;
const btnUndo = document.querySelector<HTMLButtonElement>('#btn-undo')!;
const btnRedo = document.querySelector<HTMLButtonElement>('#btn-redo')!;
const btnTopView = document.querySelector<HTMLButtonElement>('#btn-top-view')!;
const btnConfirmExtrude =
  document.querySelector<HTMLButtonElement>('#btn-confirm-extrude')!;
const toolTabEls = Array.from(
  document.querySelectorAll<HTMLButtonElement>('.tool-tab[data-mode]')
);


type InflationStep =
  | 'idle'
  | 'classified'
  | 'fan'
  | 'spine'
  | 'elevated'
  | 'done';

const TRIANGLE_TYPE_COLORS: Record<TriangleType, number> = {
  T: 0xf5c842,
  S: 0xf5f5f0,
  J: 0xe8a0bc,
};

let polygonReady = false;
let inflationStep: InflationStep = 'idle';
let pipelineMeshes: TeddyPipelineMeshes | null = null;

const INFLATED_COLOR = 0xffffff;

const editHistory = new EditHistory();
let restoringHistory = false;

const sceneView = new SceneView(sceneEl);
sceneView.setInteractionMode('silhouette');

function isDebugMode(): boolean {
  return debugModeEl.checked;
}

function setStatus(message: string, type: 'error' | '' = ''): void {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  statusEl.hidden = message === '';
}

function syncToolTabs(mode: InteractionMode): void {
  const mapped =
    mode === 'paint'
      ? 'paint'
      : mode === 'cut'
        ? 'cut'
        : mode === 'extrude'
          ? 'extrude'
          : 'orbit';
  for (const tab of toolTabEls) {
    tab.classList.toggle('is-active', tab.dataset.mode === mapped);
  }
}

function setInteractionMode(mode: InteractionMode): void {
  sceneView.setInteractionMode(mode);
  syncToolTabs(mode);
  paintPaletteEl.hidden = mode !== 'paint';
  updateExtrudeConfirmButton();
  updateDebugActions();
}

function updateExtrudeConfirmButton(): void {
  const show =
    sceneView.getInteractionMode() === 'extrude' &&
    sceneView.getExtrudePhase() === 'orient';
  btnConfirmExtrude.hidden = !show;
}

function updateDebugPanelVisibility(): void {
  debugPanelEl.hidden = !isDebugMode();
  updateDebugActions();
}

function captureEditSnapshot(): EditSnapshot | null {
  const mesh = sceneView.getCurrentMesh();
  if (!mesh) return null;
  const paint = sceneView.capturePaintTexture();
  return {
    mesh: cloneMesh(mesh),
    paint: paint ? cloneImageData(paint) : undefined,
  };
}

function updateHistoryButtons(): void {
  btnUndo.disabled = !editHistory.canUndo();
  btnRedo.disabled = !editHistory.canRedo();
}

function restoreEmptyCanvas(): void {
  inflationStep = 'idle';
  pipelineMeshes = null;
  polygonReady = false;
  enablePostInflationControls(false);
  sceneView.clear();
  sketchModeEl.checked = false;
  sceneView.setSketchMode(false);
  paintPaletteEl.hidden = true;
  syncToolTabs('silhouette');
  setStatus('');
  updateExtrudeConfirmButton();
  updateDebugActions();
}

function finalizeAfterHistoryRestore(snapshot: EditSnapshot): void {
  if (!snapshot.mesh) {
    restoreEmptyCanvas();
    updateHistoryButtons();
    return;
  }

  polygonReady = true;
  inflationStep = 'done';
  pipelineMeshes = null;
  enablePostInflationControls(true);
  setInteractionMode('orbit');
  updateExtrudeConfirmButton();
  updateHistoryButtons();
}

function commitEditHistory(): void {
  if (restoringHistory) return;
  const snapshot = captureEditSnapshot();
  if (!snapshot) return;
  editHistory.push(snapshot);
  updateHistoryButtons();
}

function performUndo(): void {
  if (!editHistory.canUndo()) return;
  const snapshot = editHistory.undo();
  if (!snapshot) return;
  restoringHistory = true;
  if (snapshot.mesh) {
    sceneView.applyEditSnapshot(snapshot.mesh, snapshot.paint);
  }
  restoringHistory = false;
  finalizeAfterHistoryRestore(snapshot);
}

function performRedo(): void {
  if (!editHistory.canRedo()) return;
  const snapshot = editHistory.redo();
  if (!snapshot) return;
  restoringHistory = true;
  if (snapshot.mesh) {
    sceneView.applyEditSnapshot(snapshot.mesh, snapshot.paint);
  }
  restoringHistory = false;
  finalizeAfterHistoryRestore(snapshot);
}

function applyPaintColor(hex: string): void {
  sceneView.setPaintColor(parseInt(hex.replace('#', ''), 16));
  paintColorEl.value = hex;
  for (const sw of swatchEls) {
    sw.classList.toggle('is-active', sw.dataset.color?.toLowerCase() === hex.toLowerCase());
  }
}

for (const sw of swatchEls) {
  sw.addEventListener('click', () => {
    const c = sw.dataset.color;
    if (c) applyPaintColor(c);
  });
}
paintColorEl.addEventListener('input', () => applyPaintColor(paintColorEl.value));
applyPaintColor('#d1495b');

function applyBrushSize(px: number): void {
  sceneView.setBrushSize(px);
  paintBrushValueEl.textContent = String(px);
}
paintBrushEl.addEventListener('input', () => applyBrushSize(Number(paintBrushEl.value)));
applyBrushSize(Number(paintBrushEl.value));

function classifiedFaceColors(types: TriangleType[]): number[] {
  return types.map((t) => TRIANGLE_TYPE_COLORS[t]);
}

function enablePostInflationControls(enabled: boolean): void {
  editToolsEl.hidden = !enabled;
  displayModeEl.disabled = !enabled;
  sketchModeEl.disabled = !enabled;
  btnUndo.disabled = !enabled || !editHistory.canUndo();
  btnRedo.disabled = !enabled || !editHistory.canRedo();
  btnTopView.disabled = !enabled;
  if (!enabled) {
    updateExtrudeConfirmButton();
    updateDebugActions();
  }
}

function isLoopCutActive(): boolean {
  return sceneView.getLoopCutPhase() !== 'idle';
}

function inflationPipelineActive(): boolean {
  return inflationStep !== 'idle' && inflationStep !== 'done';
}

function isCutDebugActive(): boolean {
  return isLoopCutActive() || sceneView.hasPendingCut();
}

function updateDebugActions(): void {
  const inCutMode = sceneView.getInteractionMode() === 'cut';
  const hasCutStroke =
    inCutMode && (sceneView.hasPendingCut() || isLoopCutActive());
  btnDiscardCut.hidden = !isDebugMode() || !hasCutStroke;

  if (!isDebugMode()) {
    btnNext.hidden = true;
    btnDiscardCut.disabled = true;
    return;
  }

  if (inflationPipelineActive()) {
    btnDiscardCut.disabled = true;
    const labels: Record<InflationStep, string> = {
      idle: 'Next step',
      classified: 'Next: fan triangles',
      fan: 'Next: show spine',
      spine: 'Next: elevate spine',
      elevated: 'Next: full inflation',
      done: 'Done',
    };
    btnNext.hidden = false;
    btnNext.disabled = false;
    btnNext.textContent = labels[inflationStep];
    return;
  }

  if (!inCutMode) {
    btnDiscardCut.disabled = true;
    btnNext.hidden = true;
    return;
  }

  if (isLoopCutActive()) {
    const phase = sceneView.getLoopCutPhase();
    btnDiscardCut.disabled = false;
    if (phase === 'projected') {
      btnNext.hidden = false;
      btnNext.disabled = false;
      btnNext.textContent = 'Next: Remove triangles';
    } else if (phase === 'cut') {
      btnNext.hidden = false;
      btnNext.disabled = false;
      btnNext.textContent = 'Next: Fill hole';
    } else {
      btnNext.hidden = true;
    }
    return;
  }

  const pending = sceneView.hasPendingCut();
  btnDiscardCut.disabled = false;
  if (pending) {
    btnNext.hidden = false;
    btnNext.disabled = false;
    btnNext.textContent = 'Next: Apply cut';
  } else {
    btnNext.hidden = true;
  }
}

function advanceCutDebugStep(): void {
  if (isLoopCutActive()) {
    const phase = sceneView.getLoopCutPhase();
    if (phase === 'projected') {
      sceneView.applyLoopCut();
    } else if (phase === 'cut') {
      sceneView.fillLoopCut();
    }
    return;
  }
  if (sceneView.hasPendingCut()) {
    applyThroughCut();
  }
}

function resetInflationFlow(): void {
  inflationStep = 'idle';
  pipelineMeshes = null;
  polygonReady = false;
  enablePostInflationControls(false);
  editHistory.seedEmpty();
  updateDebugActions();
  updateHistoryButtons();
}

function showClassifiedStep(): void {
  if (!pipelineMeshes) return;
  inflationStep = 'classified';
  sceneView.clearSpineOverlay();
  sceneView.clearSecondaryMesh();
  sceneView.setMesh(pipelineMeshes.classified, {
    faceColors: classifiedFaceColors(pipelineMeshes.classifiedFaceTypes),
    wireColor: 0x4a4a48,
  });
  setInteractionMode('orbit');
  setStatus('');
  updateDebugActions();
}

function showFanStep(): void {
  if (!pipelineMeshes) return;
  inflationStep = 'fan';
  sceneView.clearSpineOverlay();
  sceneView.setMesh(pipelineMeshes.classified, {
    faceColors: classifiedFaceColors(pipelineMeshes.classifiedFaceTypes),
    wireColor: 0x4a4a48,
  });
  sceneView.setSecondaryMesh(pipelineMeshes.terminalFans, {
    color: FAN_TERMINAL_COLOR,
    wireColor: 0x2d5c2d,
    opacity: 0.92,
  });
  setStatus('');
  updateDebugActions();
}

function showSpineStep(): void {
  if (!pipelineMeshes) return;
  inflationStep = 'spine';
  sceneView.setMesh(pipelineMeshes.fan, {
    color: 0xe8e8e8,
    wireColor: 0x4a4a48,
  });
  sceneView.setSecondaryMesh(pipelineMeshes.terminalFans, {
    color: FAN_TERMINAL_COLOR,
    wireColor: 0x2d5c2d,
    opacity: 0.92,
  });
  sceneView.setSpineOverlay(
    pipelineMeshes.fan.vertices,
    pipelineMeshes.spineSegments,
    { onSurface: true }
  );
  setStatus('');
  updateDebugActions();
}

function showElevatedStep(): void {
  if (!pipelineMeshes) return;
  inflationStep = 'elevated';
  sceneView.clearSecondaryMesh();
  const elevatedFan: Mesh3D = {
    vertices: pipelineMeshes.elevatedSpineVertices,
    faces: pipelineMeshes.fan.faces,
  };
  sceneView.setMesh(elevatedFan, {
    color: 0xe8e8e8,
    wireColor: 0x4a4a48,
  });
  sceneView.setSpineOverlay(
    pipelineMeshes.elevatedSpineVertices,
    pipelineMeshes.spineSegments,
    { showHeights: true, onSurface: true }
  );
  setStatus('');
  updateDebugActions();
}

function showInflatedStep(): void {
  if (!pipelineMeshes) return;
  inflationStep = 'done';
  polygonReady = true;
  sceneView.clearSpineOverlay();
  sceneView.clearSecondaryMesh();
  sceneView.setMesh(pipelineMeshes.inflated, {
    color: INFLATED_COLOR,
    flatShading: true,
  });
  enablePostInflationControls(true);
  setInteractionMode('orbit');
  setStatus('');
  updateDebugActions();
  commitEditHistory();
}

function startPipeline(ring: Vec2[]): void {
  resetInflationFlow();
  setStatus('');
  const { meshes, error } = buildTeddyPipelineFromStroke(ring);

  if (error || !meshes) {
    setStatus(error ?? 'Could not build mesh.', 'error');
    sceneView.setInteractionMode('silhouette');
    return;
  }

  pipelineMeshes = meshes;
  if (isDebugMode()) {
    showClassifiedStep();
  } else {
    showInflatedStep();
  }
}

function autoCompleteLoopCut(): void {
  const phase = sceneView.getLoopCutPhase();
  if (phase === 'projected') {
    sceneView.applyLoopCut();
    if (sceneView.getLoopCutPhase() === 'cut') {
      sceneView.fillLoopCut();
    }
  } else if (phase === 'cut') {
    sceneView.fillLoopCut();
  }
}

sceneView.setOnSilhouetteComplete((closed) => {
  startPipeline(closed);
});

btnNext.addEventListener('click', () => {
  if (isDebugMode() && !inflationPipelineActive() && isCutDebugActive()) {
    advanceCutDebugStep();
    return;
  }
  if (!pipelineMeshes) return;
  switch (inflationStep) {
    case 'classified':
      showFanStep();
      break;
    case 'fan':
      showSpineStep();
      break;
    case 'spine':
      showElevatedStep();
      break;
    case 'elevated':
      showInflatedStep();
      break;
    default:
      break;
  }
});

sceneView.setOnPaintComplete(() => {
  commitEditHistory();
});

sceneView.setOnExtrudeStatus((message, type) => {
  if (type === 'error') setStatus(message, 'error');
  else setStatus('');
});

sceneView.setOnExtrudeLoopReady(() => {
  updateExtrudeConfirmButton();
});

sceneView.setOnExtrudeComplete((mesh) => {
  sceneView.setMesh(mesh, { color: INFLATED_COLOR, flatShading: true });
  polygonReady = true;
  inflationStep = 'done';
  pipelineMeshes = null;
  updateExtrudeConfirmButton();
  enablePostInflationControls(true);
  setInteractionMode('orbit');
  setStatus('');
  commitEditHistory();
});

sceneView.setOnLoopCutStatus((message, type) => {
  if (type === 'error') setStatus(message, 'error');
  else setStatus('');
});

sceneView.setOnLoopCutPhaseChange(() => {
  if (isDebugMode()) {
    updateDebugActions();
  } else {
    autoCompleteLoopCut();
  }
});

sceneView.setOnLoopCutComplete((mesh) => {
  sceneView.setMesh(mesh, { color: INFLATED_COLOR, flatShading: true });
  polygonReady = true;
  inflationStep = 'done';
  pipelineMeshes = null;
  enablePostInflationControls(true);
  setInteractionMode('orbit');
  setStatus('');
  commitEditHistory();
});

sceneView.setOnCutRejected((message) => {
  setStatus(message, 'error');
});

sceneView.setOnCutPendingChange(() => {
  updateDebugActions();
});

sceneView.setOnCutPreview(() => {
  if (isDebugMode()) {
    updateDebugActions();
    setStatus('');
    return;
  }
  applyThroughCut();
});

function applyThroughCut(): void {
  const pending = sceneView.getPendingCut();
  if (!pending) return;

  const mesh = sceneView.getCurrentMesh();
  if (!mesh || mesh.vertices.length === 0) {
    setStatus('No 3D object to cut.', 'error');
    return;
  }

  const result = computeTeddyCut(
    mesh,
    pending.screenStroke,
    pending.camera,
    sceneView.getProjectionElement(),
    pending.validated,
    sceneView.getMeshObject() ?? undefined,
    {
      frontPath: pending.frontPath,
      backPath: pending.backPath,
    }
  );

  sceneView.clearPendingCut();
  sceneView.clearCutProjectionPreview();

  if ('error' in result) {
    setStatus(result.error, 'error');
    return;
  }

  const capAdded = result.capped.faces.length - result.trimmed.faces.length;
  const openTrimmed = countBoundaryEdges(result.trimmed);
  const openCapped = countBoundaryEdges(result.capped);
  if (capAdded === 0 || openCapped >= openTrimmed) {
    setStatus(
      'Cut applied but the hole could not be filled — try the top-down view button and redraw.',
      'error'
    );
    sceneView.setMesh(result.trimmed, { color: INFLATED_COLOR, flatShading: true });
    return;
  }

  sceneView.setMesh(result.capped, {
    color: INFLATED_COLOR,
    flatShading: true,
  });
  polygonReady = true;
  inflationStep = 'done';
  pipelineMeshes = null;
  enablePostInflationControls(true);
  setInteractionMode('orbit');
  setStatus('');
  commitEditHistory();
}

btnDiscardCut.addEventListener('click', () => {
  if (isLoopCutActive()) {
    sceneView.cancelLoopCut();
    return;
  }
  sceneView.clearPendingCut();
  sceneView.clearCutProjectionPreview();
  updateDebugActions();
  setStatus('');
});

displayModeEl.addEventListener('change', () => {
  sceneView.setDisplayMode(displayModeEl.value as DisplayMode);
});
sceneView.setDisplayMode(displayModeEl.value as DisplayMode);

for (const tab of toolTabEls) {
  tab.addEventListener('click', () => {
    if (!polygonReady) return;
    const mode = tab.dataset.mode as 'orbit' | 'paint' | 'cut' | 'extrude';
    setInteractionMode(mode);
    setStatus('');
    updateExtrudeConfirmButton();
  });
}

sketchModeEl.addEventListener('change', () => {
  sceneView.setSketchMode(sketchModeEl.checked);
});

btnConfirmExtrude.addEventListener('click', () => {
  if (sceneView.confirmExtrudeOrientation()) {
    updateExtrudeConfirmButton();
  }
});

btnUndo.addEventListener('click', () => {
  performUndo();
});

btnRedo.addEventListener('click', () => {
  performRedo();
});

btnTopView.addEventListener('click', () => {
  sceneView.resetViewTopDown();
});

window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  const target = e.target;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return;
  }
  if (e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    performUndo();
  } else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
    e.preventDefault();
    performRedo();
  }
});

debugModeEl.addEventListener('change', () => {
  updateDebugPanelVisibility();
  updateDebugActions();
});

/** World-space radius for preset shapes on z = 0 (independent of camera projection). */
const PRESET_RADIUS = 100;
const PRESET_OVAL_RX = 100;
const PRESET_OVAL_RY = 60;
const PRESET_STAR_OUTER = 100;
const PRESET_STAR_INNER = 40;

function buildCircleRing(radius: number, segments = 64): Vec2[] {
  const ring: Vec2[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    ring.push({ x: Math.cos(t) * radius, y: Math.sin(t) * radius });
  }
  return ring;
}

function buildEllipseRing(rx: number, ry: number, segments = 64): Vec2[] {
  const ring: Vec2[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    ring.push({ x: Math.cos(t) * rx, y: Math.sin(t) * ry });
  }
  return ring;
}

function buildStarRing(outerR: number, innerR: number, points = 5): Vec2[] {
  const ring: Vec2[] = [];
  const total = points * 2;
  for (let i = 0; i <= total; i++) {
    const t = (i / total) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? outerR : innerR;
    ring.push({ x: Math.cos(t) * r, y: Math.sin(t) * r });
  }
  return ring;
}

function buildTriangleRing(radius: number): Vec2[] {
  const ring: Vec2[] = [];
  for (let i = 0; i <= 3; i++) {
    const t = -Math.PI / 2 + (i / 3) * Math.PI * 2;
    ring.push({ x: Math.cos(t) * radius, y: Math.sin(t) * radius });
  }
  return ring;
}

function createPresetStroke(worldRing: Vec2[]): void {
  if (polygonReady || inflationStep !== 'idle') {
    setStatus('Clear first to create a new shape.', 'error');
    return;
  }
  startPipeline(worldRing);
}

btnCircle.addEventListener('click', () => {
  createPresetStroke(buildCircleRing(PRESET_RADIUS));
});

btnOval.addEventListener('click', () => {
  createPresetStroke(buildEllipseRing(PRESET_OVAL_RX, PRESET_OVAL_RY));
});

btnSquare.addEventListener('click', () => {
  const r = PRESET_RADIUS;
  createPresetStroke([
    { x: -r, y: -r },
    { x: r, y: -r },
    { x: r, y: r },
    { x: -r, y: r },
    { x: -r, y: -r },
  ]);
});

btnTriangle.addEventListener('click', () => {
  createPresetStroke(buildTriangleRing(PRESET_RADIUS));
});

btnStar.addEventListener('click', () => {
  createPresetStroke(buildStarRing(PRESET_STAR_OUTER, PRESET_STAR_INNER));
});

btnClear.addEventListener('click', () => {
  resetInflationFlow();
  restoreEmptyCanvas();
});

resetInflationFlow();
updateDebugPanelVisibility();
updateExtrudeConfirmButton();
updateHistoryButtons();
