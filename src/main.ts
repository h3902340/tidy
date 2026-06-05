import './style.css';
import { EditHistory, cloneImageData, cloneMesh, type EditSnapshot } from './editHistory';
import { computeTeddyCut, type TeddyCutResult } from './meshCut';
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
const hintEl = document.querySelector<HTMLElement>('#canvas-hint')!;
const navHelpEl = document.querySelector<HTMLElement>('#nav-help')!;
const statusEl = document.querySelector<HTMLElement>('#status')!;
const stepEl = document.querySelector<HTMLElement>('#inflation-step')!;
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

let stagedCutResult: TeddyCutResult | null = null;

type InflationStep =
  | 'idle'
  | 'classified'
  | 'fan'
  | 'spine'
  | 'elevated'
  | 'done';

const STEP_COUNT = 5;

const TRIANGLE_TYPE_COLORS: Record<TriangleType, number> = {
  T: 0xf5c842,
  S: 0xf5f5f0,
  J: 0xe8a0bc,
};

let polygonReady = false;
let inflationStep: InflationStep = 'idle';
let pipelineMeshes: TeddyPipelineMeshes | null = null;

const INFLATED_COLOR = 0xffffff;
const CUT_TRIM_COLOR = 0x8fa8c4;

const editHistory = new EditHistory();
let restoringHistory = false;

const sceneView = new SceneView(sceneEl);
sceneView.setInteractionMode('silhouette');

function isDebugMode(): boolean {
  return debugModeEl.checked;
}

function setStatus(message: string, type: 'ok' | 'error' | '' = ''): void {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

function setStepLabel(step: InflationStep): void {
  if (!isDebugMode()) {
    stepEl.textContent = '';
    return;
  }
  const labels: Record<InflationStep, string> = {
    idle: '',
    classified: `Step 1 of ${STEP_COUNT} — T / S / J triangles`,
    fan: `Step 2 of ${STEP_COUNT} — fan triangles`,
    spine: `Step 3 of ${STEP_COUNT} — chordal-axis spine`,
    elevated: `Step 4 of ${STEP_COUNT} — elevated (no quarter-ovals)`,
    done: `Step 5 of ${STEP_COUNT} — full inflation`,
  };
  stepEl.textContent = labels[step];
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
}

function navItem(action: string, control: string): string {
  return `<span class="nav-help-item"><kbd>${control}</kbd> ${action}</span>`;
}

function navSep(): string {
  return '<span class="nav-help-sep" aria-hidden="true">·</span>';
}

function updateNavHelp(): void {
  const mode = sceneView.getInteractionMode();

  if (mode === 'paint') {
    navHelpEl.innerHTML = [
      navItem('paint', 'Left-drag'),
      navSep(),
      navItem('rotate', 'Right-drag'),
      navSep(),
      navItem('zoom', 'Scroll'),
      navSep(),
      navItem('pan', 'Middle-drag'),
    ].join('');
    return;
  }

  if (mode === 'silhouette') {
    navHelpEl.innerHTML = navItem('draw shape', 'Left-drag');
    return;
  }

  if (mode === 'cut') {
    if (sceneView.hasPendingCut() || sceneView.getLoopCutPhase() !== 'idle') {
      navHelpEl.innerHTML = [
        navItem('rotate', 'Drag'),
        navSep(),
        navItem('zoom', 'Scroll'),
        navSep(),
        navItem('pan', 'Right-drag'),
      ].join('');
      return;
    }
    navHelpEl.innerHTML = [
      navItem('draw cut', 'Left-drag'),
      navSep(),
      navItem('rotate', 'Right-drag'),
      navSep(),
      navItem('zoom', 'Scroll'),
      navSep(),
      navItem('pan', 'Middle-drag'),
    ].join('');
    return;
  }

  if (mode === 'extrude') {
    if (sceneView.getExtrudePhase() === 'orient') {
      navHelpEl.innerHTML = [
        navItem('rotate', 'Drag'),
        navSep(),
        navItem('zoom', 'Scroll'),
        navSep(),
        navItem('pan', 'Right-drag'),
      ].join('');
      return;
    }
    navHelpEl.innerHTML = navItem('draw on surface', 'Left-drag');
    return;
  }

  navHelpEl.innerHTML = [
    navItem('rotate', 'Drag'),
    navSep(),
    navItem('zoom', 'Scroll'),
    navSep(),
    navItem('pan', 'Right-drag'),
  ].join('');
}

function updateExtrudeConfirmButton(): void {
  const show =
    sceneView.getInteractionMode() === 'extrude' &&
    sceneView.getExtrudePhase() === 'orient';
  btnConfirmExtrude.hidden = !show;
  updateNavHelp();
}

function updateDebugPanelVisibility(): void {
  debugPanelEl.hidden = !isDebugMode();
  setStepLabel(inflationStep);
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
  btnNext.disabled = true;
  btnNext.textContent = 'Next step';
  setStepLabel('idle');
  enablePostInflationControls(false);
  clearStagedCut();
  sceneView.clear();
  sketchModeEl.checked = false;
  sceneView.setSketchMode(false);
  paintPaletteEl.hidden = true;
  syncToolTabs('silhouette');
  setStatus('');
  updateExtrudeConfirmButton();
  updateCutActionButtons();
  updateNavHelp();
  updateHint();
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
  clearStagedCut();
  btnNext.disabled = true;
  setStepLabel('done');
  enablePostInflationControls(true);
  setInteractionMode('orbit');
  updateCutActionButtons();
  updateExtrudeConfirmButton();
  updateHistoryButtons();
  updateHint();
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

function updateHint(): void {
  if (isDebugMode()) {
    if (inflationStep === 'classified') {
      hintEl.textContent =
        'Debug — yellow T, white S, pink J. Press Next step to continue.';
      return;
    }
    if (inflationStep === 'fan') {
      hintEl.textContent = 'Debug — green terminal fans on the CDT mesh.';
      return;
    }
    if (inflationStep === 'spine') {
      hintEl.textContent = 'Debug — spine overlaid on the fan mesh.';
      return;
    }
    if (inflationStep === 'elevated') {
      hintEl.textContent = 'Debug — elevated spine with height labels.';
      return;
    }
  }

  if (!polygonReady && inflationStep === 'idle') {
    hintEl.textContent = 'Draw a closed loop on the plane, or pick a preset shape';
    return;
  }

  const mode = sceneView.getInteractionMode();
  if (mode === 'paint') {
    hintEl.textContent = 'Paint on the surface — pick a color and brush size (top left)';
    return;
  }
  if (mode === 'cut') {
    hintEl.textContent =
      'Draw across the shape to cut through, or draw a closed loop on the surface to remove a patch';
    return;
  }
  if (mode === 'extrude') {
    const phase = sceneView.getExtrudePhase();
    if (phase === 'orient') {
      hintEl.textContent =
        'Rotate to set the extrusion direction, then press Confirm orientation (top right)';
      return;
    }
    if (phase === 'curve') {
      hintEl.textContent = 'Draw the extruding stroke across the red loop';
      return;
    }
    hintEl.textContent = 'Draw a closed loop on the surface to define the extrusion base';
    return;
  }
  hintEl.textContent = 'Drag to rotate · scroll to zoom · right-drag to pan';
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
    updateCutActionButtons();
  }
}

function isLoopCutActive(): boolean {
  return sceneView.getLoopCutPhase() !== 'idle';
}

function inflationPipelineActive(): boolean {
  return inflationStep !== 'idle' && inflationStep !== 'done';
}

function isCutDebugActive(): boolean {
  return isLoopCutActive() || sceneView.hasPendingCut() || stagedCutResult !== null;
}

function updateCutActionButtons(): void {
  if (!isDebugMode()) {
    btnDiscardCut.disabled = true;
    if (inflationStep === 'done') {
      btnNext.disabled = true;
      btnNext.textContent = 'Done';
    }
    return;
  }

  if (inflationPipelineActive()) {
    btnDiscardCut.disabled = true;
    return;
  }

  if (isLoopCutActive()) {
    const phase = sceneView.getLoopCutPhase();
    btnDiscardCut.disabled = phase === 'idle';
    if (phase === 'projected') {
      btnNext.disabled = false;
      btnNext.textContent = 'Next: Remove triangles';
    } else if (phase === 'cut') {
      btnNext.disabled = false;
      btnNext.textContent = 'Next: Fill hole';
    } else {
      btnNext.disabled = true;
      btnNext.textContent = 'Done';
    }
    return;
  }

  const pending = sceneView.hasPendingCut();
  const staged = stagedCutResult !== null;
  btnDiscardCut.disabled = !pending && !staged;

  if (pending && !staged) {
    btnNext.disabled = false;
    btnNext.textContent = 'Next: Remove triangles';
  } else if (staged) {
    btnNext.disabled = false;
    btnNext.textContent = 'Next: Fill hole';
  } else {
    btnNext.disabled = true;
    btnNext.textContent = 'Done';
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
  if (stagedCutResult) {
    applyFillCutHole();
    return;
  }
  if (sceneView.hasPendingCut()) {
    applyPendingCutRemoval();
  }
}

function clearStagedCut(): void {
  stagedCutResult = null;
  updateCutActionButtons();
}

function resetInflationFlow(): void {
  inflationStep = 'idle';
  pipelineMeshes = null;
  polygonReady = false;
  btnNext.disabled = true;
  btnNext.textContent = 'Next step';
  setStepLabel('idle');
  enablePostInflationControls(false);
  editHistory.seedEmpty();
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
  btnNext.disabled = false;
  btnNext.textContent = 'Next: fan triangles';
  setStepLabel('classified');
  setInteractionMode('orbit');
  const counts = countTriangleTypes(pipelineMeshes.classifiedFaceTypes);
  setStatus(
    `Step 1 — ${pipelineMeshes.classified.faces.length} CDT triangles: ${counts.T} T, ${counts.S} S, ${counts.J} J.`,
    'ok'
  );
  updateHint();
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
  btnNext.textContent = 'Next: show spine';
  setStepLabel('fan');
  setStatus(
    `Step 2 — ${pipelineMeshes.terminalFans.faces.length} terminal fan triangles (green).`,
    'ok'
  );
  updateHint();
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
  btnNext.textContent = 'Next: elevate spine';
  setStepLabel('spine');
  setStatus(
    `Step 3 — fan mesh with spine (${pipelineMeshes.spineSegments.length} segments).`,
    'ok'
  );
  updateHint();
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
  btnNext.textContent = 'Next: full inflation';
  setStepLabel('elevated');
  setStatus(`Step 4 — elevated fan mesh with spine heights.`, 'ok');
  updateHint();
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
  btnNext.disabled = true;
  btnNext.textContent = 'Done';
  setStepLabel('done');
  enablePostInflationControls(true);
  setInteractionMode('orbit');
  setStatus(
    isDebugMode()
      ? `Step 5 — ${pipelineMeshes.inflated.faces.length} triangles inflated.`
      : 'Shape inflated. Drag to rotate, or pick a tool to edit.',
    'ok'
  );
  updateHint();
  commitEditHistory();
}

function countTriangleTypes(types: TriangleType[]): {
  T: number;
  S: number;
  J: number;
} {
  let T = 0;
  let S = 0;
  let J = 0;
  for (const t of types) {
    if (t === 'T') T++;
    else if (t === 'S') S++;
    else J++;
  }
  return { T, S, J };
}

function startPipeline(ring: Vec2[]): void {
  resetInflationFlow();
  setStatus('Building your shape…');
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
  setStatus(message, type);
});

sceneView.setOnExtrudeLoopReady(() => {
  updateExtrudeConfirmButton();
  updateHint();
});

sceneView.setOnExtrudeComplete((mesh) => {
  sceneView.setMesh(mesh, { color: INFLATED_COLOR, flatShading: true });
  polygonReady = true;
  inflationStep = 'done';
  pipelineMeshes = null;
  btnNext.disabled = true;
  updateExtrudeConfirmButton();
  setStepLabel('done');
  enablePostInflationControls(true);
  setInteractionMode('orbit');
  setStatus('Extrusion complete. Drag to rotate or pick another tool.', 'ok');
  updateHint();
  commitEditHistory();
});

sceneView.setOnLoopCutStatus((message, type) => {
  if (isDebugMode() || type === 'error') {
    setStatus(message, type);
  }
});

sceneView.setOnLoopCutPhaseChange(() => {
  if (isDebugMode()) {
    updateCutActionButtons();
  } else {
    autoCompleteLoopCut();
  }
  updateNavHelp();
});

sceneView.setOnLoopCutComplete((mesh) => {
  sceneView.setMesh(mesh, { color: INFLATED_COLOR, flatShading: true });
  polygonReady = true;
  inflationStep = 'done';
  pipelineMeshes = null;
  btnNext.disabled = true;
  setStepLabel('done');
  enablePostInflationControls(true);
  setInteractionMode('orbit');
  updateCutActionButtons();
  setStatus('Cut complete. Drag to rotate or pick another tool.', 'ok');
  updateHint();
  commitEditHistory();
});

sceneView.setOnCutRejected((message) => {
  setStatus(message, 'error');
});

sceneView.setOnCutPendingChange(() => {
  updateCutActionButtons();
  updateNavHelp();
});

sceneView.setOnCutPreview(() => {
  if (isDebugMode()) {
    updateCutActionButtons();
    const payload = sceneView.getPendingCut();
    setStatus(
      `Cut projected — cyan front (${payload?.frontPath.length ?? 0} pts), magenta back (${payload?.backPath.length ?? 0} pts). Press Next: Remove triangles when ready.`,
      'ok'
    );
    return;
  }
  applyCutImmediately();
});

function applyPendingCutRemoval(): void {
  const pending = sceneView.getPendingCut();
  if (!pending) return;

  const mesh = sceneView.getCurrentMesh();
  if (!mesh || mesh.vertices.length === 0) {
    setStatus('No 3D object to cut.', 'error');
    return;
  }

  const totalFaces = mesh.faces.length;
  const result = computeTeddyCut(
    mesh,
    pending.screenStroke,
    pending.camera,
    sceneView.getOverlayElement(),
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
    clearStagedCut();
    setStatus(result.error, 'error');
    return;
  }

  stagedCutResult = result;
  sceneView.setMesh(result.trimmed, {
    color: CUT_TRIM_COLOR,
    flatShading: true,
  });
  sceneView.addCutSurfaceLines(result.frontPath, result.backPath);
  updateCutActionButtons();

  const kept = result.trimmed.faces.length;
  setStatus(
    `Removed ${totalFaces - kept} of ${totalFaces} triangles. Press Next: Fill hole when ready.`,
    'ok'
  );
}

function applyFillCutHole(): void {
  if (!stagedCutResult) return;

  sceneView.setMesh(stagedCutResult.capped, {
    color: INFLATED_COLOR,
    flatShading: true,
  });
  polygonReady = true;
  inflationStep = 'done';
  pipelineMeshes = null;
  btnNext.disabled = true;
  setStepLabel('done');
  enablePostInflationControls(true);
  setInteractionMode('orbit');

  const { capped } = stagedCutResult;
  clearStagedCut();
  setStatus(
    isDebugMode()
      ? `Hole filled — ${capped.faces.length} triangles.`
      : 'Cut complete. Drag to rotate or pick another tool.',
    'ok'
  );
  updateHint();
  commitEditHistory();
}

function applyCutImmediately(): void {
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
    sceneView.getOverlayElement(),
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
    clearStagedCut();
    setStatus(result.error, 'error');
    return;
  }

  sceneView.setMesh(result.capped, {
    color: INFLATED_COLOR,
    flatShading: true,
  });
  polygonReady = true;
  inflationStep = 'done';
  pipelineMeshes = null;
  btnNext.disabled = true;
  setStepLabel('done');
  clearStagedCut();
  setStatus('Cut complete. Drag to rotate or pick another tool.', 'ok');
  updateHint();
  commitEditHistory();
}

btnDiscardCut.addEventListener('click', () => {
  if (isLoopCutActive()) {
    sceneView.cancelLoopCut();
    return;
  }
  sceneView.clearPendingCut();
  sceneView.clearCutProjectionPreview();
  clearStagedCut();
  updateCutActionButtons();
  setStatus('Cut discarded. Draw a new stroke.');
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

    if (mode === 'paint') {
      setStatus('Paint mode — pick a color and draw on the surface.');
    } else if (mode === 'cut') {
      updateCutActionButtons();
      setStatus('Cut mode — draw across the shape or a closed loop on the surface.');
    } else if (mode === 'orbit') {
      setStatus('');
    }
    updateExtrudeConfirmButton();
    updateHint();
  });
}

sketchModeEl.addEventListener('change', () => {
  sceneView.setSketchMode(sketchModeEl.checked);
});

btnConfirmExtrude.addEventListener('click', () => {
  if (sceneView.confirmExtrudeOrientation()) {
    updateExtrudeConfirmButton();
    updateHint();
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
  updateCutActionButtons();
  updateHint();
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
updateNavHelp();
updateHistoryButtons();
updateHint();
