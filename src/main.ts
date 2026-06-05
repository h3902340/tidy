import './style.css';
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
const statusEl = document.querySelector<HTMLElement>('#status')!;
const stepEl = document.querySelector<HTMLElement>('#inflation-step')!;
const btnClear = document.querySelector<HTMLButtonElement>('#btn-clear')!;
const btnCircle = document.querySelector<HTMLButtonElement>('#btn-circle')!;
const btnSquare = document.querySelector<HTMLButtonElement>('#btn-square')!;
const btnNext = document.querySelector<HTMLButtonElement>('#btn-next-step')!;
const displayModeEl = document.querySelector<HTMLSelectElement>('#display-mode')!;
const paintModeEl = document.querySelector<HTMLInputElement>('#paint-mode')!;
const cutModeEl = document.querySelector<HTMLInputElement>('#cut-mode')!;
const extrudeModeEl = document.querySelector<HTMLInputElement>('#extrude-mode')!;
const sketchModeEl = document.querySelector<HTMLInputElement>('#sketch-mode')!;
const paintPaletteEl = document.querySelector<HTMLDivElement>('#paint-palette')!;
const paintColorEl = document.querySelector<HTMLInputElement>('#paint-color')!;
const swatchEls = Array.from(paintPaletteEl.querySelectorAll<HTMLButtonElement>('.swatch'));
const paintBrushEl = document.querySelector<HTMLInputElement>('#paint-brush')!;
const paintBrushValueEl = document.querySelector<HTMLSpanElement>('#paint-brush-value')!;
const btnApplyCut = document.querySelector<HTMLButtonElement>('#btn-apply-cut')!;
const btnFillCut = document.querySelector<HTMLButtonElement>('#btn-fill-cut')!;
const btnDiscardCut = document.querySelector<HTMLButtonElement>('#btn-discard-cut')!;
const btnConfirmExtrude =
  document.querySelector<HTMLButtonElement>('#btn-confirm-extrude')!;

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

const sceneView = new SceneView(sceneEl);
sceneView.setInteractionMode('silhouette');

function setStatus(message: string, type: 'ok' | 'error' | '' = ''): void {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

function setStepLabel(step: InflationStep): void {
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

function setInteractionMode(mode: InteractionMode): void {
  sceneView.setInteractionMode(mode);
  paintModeEl.checked = mode === 'paint';
  cutModeEl.checked = mode === 'cut';
  extrudeModeEl.checked = mode === 'extrude';
  paintPaletteEl.hidden = mode !== 'paint';
  if (mode !== 'extrude') btnConfirmExtrude.disabled = true;
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
  if (inflationStep === 'classified') {
    hintEl.textContent =
      'Yellow T = terminal, white S = sleeve, pink J = junction (paper fig. b) — continue';
    return;
  }
  if (inflationStep === 'fan') {
    hintEl.textContent =
      'Green = terminal fan triangles (fig. d) on T/S/J CDT — continue to spine';
    return;
  }
  if (inflationStep === 'spine') {
    hintEl.textContent =
      'Fig. 13f fan mesh — black spine should lie on the surface; green = terminal fans';
    return;
  }
  if (inflationStep === 'elevated') {
    hintEl.textContent =
      'Elevated fan mesh — spine dots sit on raised surface vertices; labels show height (z)';
    return;
  }
  if (!polygonReady) {
    hintEl.textContent = 'Draw one closed loop on the 3D plane';
    return;
  }
  if (paintModeEl.checked) {
    hintEl.textContent = 'Paint on surface (red)';
    return;
  }
  if (cutModeEl.checked) {
    hintEl.textContent =
      'Cut: open stroke across the object = cut through; closed loop on the surface = loop cut.';
    return;
  }
  if (extrudeModeEl.checked) {
    hintEl.textContent =
      'Closed loop on surface → rotate → Confirm orientation → stroke across the loop.';
    return;
  }
  hintEl.textContent = 'Drag to rotate · scroll to zoom · right-drag to pan';
}

function enablePostInflationControls(enabled: boolean): void {
  displayModeEl.disabled = !enabled;
  paintModeEl.disabled = !enabled;
  cutModeEl.disabled = !enabled;
  extrudeModeEl.disabled = !enabled;
  sketchModeEl.disabled = !enabled;
  if (!enabled) {
    btnConfirmExtrude.disabled = true;
    updateCutActionButtons();
  }
}

function isLoopCutActive(): boolean {
  return sceneView.getLoopCutPhase() !== 'idle';
}

function updateCutActionButtons(): void {
  if (isLoopCutActive()) {
    // Loop cut reuses the same buttons across its three stages.
    const phase = sceneView.getLoopCutPhase();
    btnApplyCut.disabled = phase !== 'projected';
    btnFillCut.disabled = phase !== 'cut';
    btnDiscardCut.disabled = phase === 'idle';
    return;
  }
  const pending = sceneView.hasPendingCut();
  const staged = stagedCutResult !== null;
  btnApplyCut.disabled = !pending || staged;
  btnFillCut.disabled = !staged;
  btnDiscardCut.disabled = !pending && !staged;
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
    `Step 1 — ${pipelineMeshes.classified.faces.length} CDT triangles: ${counts.T} terminal (T), ${counts.S} sleeve (S), ${counts.J} junction (J).`,
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
    `Step 2 — ${pipelineMeshes.terminalFans.faces.length} terminal fan triangles (green) on ${pipelineMeshes.classified.faces.length} CDT triangles.`,
    'ok'
  );
  updateHint();
}

function showSpineStep(): void {
  if (!pipelineMeshes) return;
  inflationStep = 'spine';
  // Fig. 13f fan mesh — spine vertices share this mesh at z = 0.
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
    `Step 3 — fig. 13f fan mesh with spine overlaid (${pipelineMeshes.spineSegments.length} segments). Black dots should sit on the surface.`,
    'ok'
  );
  updateHint();
}

function showElevatedStep(): void {
  if (!pipelineMeshes) return;
  inflationStep = 'elevated';
  sceneView.clearSecondaryMesh();
  // Same fan topology with spine heights applied to spine nodes (paper §5.1).
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
  setStatus(
    `Step 4 — elevated fan mesh (${elevatedFan.faces.length} triangles) with spine on the surface. Height labels show spine z; orbit to inspect fit.`,
    'ok'
  );
  updateHint();
}

function showInflatedStep(): void {
  if (!pipelineMeshes) return;
  inflationStep = 'done';
  polygonReady = true;
  sceneView.clearSpineOverlay();
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
    `Step 5 — ${pipelineMeshes.inflated.faces.length} triangles with quarter-oval spokes, rim, and corrected normals.`,
    'ok'
  );
  updateHint();
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
  setStatus('Building pipeline…');
  const { meshes, error } = buildTeddyPipelineFromStroke(ring);

  if (error || !meshes) {
    setStatus(error ?? 'Could not build mesh.', 'error');
    sceneView.setInteractionMode('silhouette');
    return;
  }

  pipelineMeshes = meshes;
  showClassifiedStep();
}

sceneView.setOnSilhouetteComplete((closed) => {
  startPipeline(closed);
});

btnNext.addEventListener('click', () => {
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

sceneView.setOnExtrudeStatus((message, type) => {
  setStatus(message, type);
});

sceneView.setOnExtrudeLoopReady(() => {
  btnConfirmExtrude.disabled = false;
});

sceneView.setOnExtrudeComplete((mesh) => {
  sceneView.setMesh(mesh, { color: INFLATED_COLOR, flatShading: true });
  polygonReady = true;
  inflationStep = 'done';
  pipelineMeshes = null;
  btnNext.disabled = true;
  btnConfirmExtrude.disabled = true;
  setStepLabel('done');
  enablePostInflationControls(true);
  setInteractionMode('orbit');
  setStatus(
    `Extrusion complete — swept mesh now has ${mesh.faces.length} triangles. Drag to rotate.`,
    'ok'
  );
  updateHint();
});

sceneView.setOnLoopCutStatus((message, type) => {
  setStatus(message, type);
});

sceneView.setOnLoopCutPhaseChange(() => {
  updateCutActionButtons();
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
  updateHint();
});

sceneView.setOnCutRejected((message) => {
  setStatus(message, 'error');
});

sceneView.setOnCutPendingChange(() => {
  updateCutActionButtons();
});

sceneView.setOnCutPreview((payload) => {
  updateCutActionButtons();
  setStatus(
    `Cut projected — cyan = front (${payload.frontPath.length} pts), magenta = back (${payload.backPath.length} pts). Orbit to inspect, then Remove triangles.`,
    'ok'
  );
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
    `Step 1 — removed ${totalFaces - kept} of ${totalFaces} triangles (open cut). Inspect, then Fill hole.`,
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

  const { capped, polygon } = stagedCutResult;
  clearStagedCut();
  setStatus(
    `Step 2 — hole filled (${capped.faces.length} triangles, ${capped.vertices.length} vertices). Top outline has ${polygon.length} points.`,
    'ok'
  );
}

btnApplyCut.addEventListener('click', () => {
  if (isLoopCutActive()) {
    sceneView.applyLoopCut();
    return;
  }
  applyPendingCutRemoval();
});

btnFillCut.addEventListener('click', () => {
  if (isLoopCutActive()) {
    sceneView.fillLoopCut();
    return;
  }
  applyFillCutHole();
});

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

function anyEditModeActive(): boolean {
  return paintModeEl.checked || cutModeEl.checked || extrudeModeEl.checked;
}

paintModeEl.addEventListener('change', () => {
  if (!polygonReady) return;
  if (paintModeEl.checked) {
    cutModeEl.checked = false;
    extrudeModeEl.checked = false;
    setInteractionMode('paint');
    setStatus('Paint mode: pick a color, then draw on the surface to bake it in.');
  } else if (!anyEditModeActive()) {
    setInteractionMode('orbit');
    setStatus('Drag to rotate · scroll to zoom · right-drag to pan.');
  }
  updateHint();
});

cutModeEl.addEventListener('change', () => {
  if (!polygonReady) return;
  if (cutModeEl.checked) {
    paintModeEl.checked = false;
    extrudeModeEl.checked = false;
    setInteractionMode('cut');
    updateCutActionButtons();
    setStatus(
      'Cut: draw an open stroke across the object to cut through, or a closed loop on the surface to remove it.',
    );
  } else if (!anyEditModeActive()) {
    setInteractionMode('orbit');
    setStatus('Drag to rotate · scroll to zoom · right-drag to pan.');
  }
  updateCutActionButtons();
  updateHint();
});

extrudeModeEl.addEventListener('change', () => {
  if (!polygonReady) return;
  if (extrudeModeEl.checked) {
    paintModeEl.checked = false;
    cutModeEl.checked = false;
    btnConfirmExtrude.disabled = true;
    setInteractionMode('extrude');
  } else if (!anyEditModeActive()) {
    setInteractionMode('orbit');
    setStatus('Drag to rotate · scroll to zoom · right-drag to pan.');
  }
  updateHint();
});

sketchModeEl.addEventListener('change', () => {
  sceneView.setSketchMode(sketchModeEl.checked);
});

btnConfirmExtrude.addEventListener('click', () => {
  if (sceneView.confirmExtrudeOrientation()) {
    btnConfirmExtrude.disabled = true;
  }
});

/** World-space radius for preset shapes on z = 0 (independent of camera projection). */
const PRESET_RADIUS = 100;

function createPresetStroke(worldRing: Vec2[]): void {
  if (polygonReady || inflationStep !== 'idle') {
    setStatus('Clear first to create a new shape.', 'error');
    return;
  }
  startPipeline(worldRing);
}

btnCircle.addEventListener('click', () => {
  const segments = 64;
  const ring: Vec2[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    ring.push({
      x: Math.cos(t) * PRESET_RADIUS,
      y: Math.sin(t) * PRESET_RADIUS,
    });
  }
  createPresetStroke(ring);
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

btnClear.addEventListener('click', () => {
  resetInflationFlow();
  clearStagedCut();
  sceneView.clear();
  paintModeEl.checked = false;
  cutModeEl.checked = false;
  extrudeModeEl.checked = false;
  sketchModeEl.checked = false;
  sceneView.setSketchMode(false);
  paintPaletteEl.hidden = true;
  btnConfirmExtrude.disabled = true;
  setStatus('Cleared. Draw a new closed loop on the 3D plane.');
  updateHint();
});

resetInflationFlow();
setStatus(
  'Draw a closed loop, then use Next to step through T/S/J → fans → spine → elevated → full inflation.'
);
updateHint();
