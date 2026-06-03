import './style.css';
import { computeTeddyCut, type TeddyCutResult } from './meshCut';
import { SceneView, type DisplayMode, type InteractionMode } from './sceneView';
import { buildTeddyPipelineFromStroke } from './teddy';
import {
  FAN_TERMINAL_COLOR,
  type TeddyPipelineMeshes,
  type TriangleType,
} from './teddy';
import type { Vec2 } from './math';

const sceneEl = document.querySelector<HTMLElement>('#scene-view')!;
const hintEl = document.querySelector<HTMLElement>('#canvas-hint')!;
const statusEl = document.querySelector<HTMLElement>('#status')!;
const stepEl = document.querySelector<HTMLElement>('#inflation-step')!;
const btnClear = document.querySelector<HTMLButtonElement>('#btn-clear')!;
const btnSquare = document.querySelector<HTMLButtonElement>('#btn-square')!;
const btnNext = document.querySelector<HTMLButtonElement>('#btn-next-step')!;
const displayModeEl = document.querySelector<HTMLSelectElement>('#display-mode')!;
const paintModeEl = document.querySelector<HTMLInputElement>('#paint-mode')!;
const cutModeEl = document.querySelector<HTMLInputElement>('#cut-mode')!;
const btnApplyCut = document.querySelector<HTMLButtonElement>('#btn-apply-cut')!;
const btnFillCut = document.querySelector<HTMLButtonElement>('#btn-fill-cut')!;
const btnDiscardCut = document.querySelector<HTMLButtonElement>('#btn-discard-cut')!;

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

const ELEVATED_COLOR = 0x7eb8da;
const INFLATED_COLOR = 0x6b9bd1;
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
}

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
      'Dark green = terminal fans; black spine branches should stop at fan tips (not pass through)';
    return;
  }
  if (inflationStep === 'elevated') {
    hintEl.textContent =
      'Spine vertices raised; top + mirrored bottom, no quarter-oval strips yet';
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
      'Stroke → review projection → Remove triangles → inspect open cut → Fill hole.';
    return;
  }
  hintEl.textContent = 'Drag to rotate · scroll to zoom · right-drag to pan';
}

function enablePostInflationControls(enabled: boolean): void {
  displayModeEl.disabled = !enabled;
  paintModeEl.disabled = !enabled;
  cutModeEl.disabled = !enabled;
  if (!enabled) {
    updateCutActionButtons();
  }
}

function updateCutActionButtons(): void {
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
  sceneView.setMesh(pipelineMeshes.classified, {
    faceColors: classifiedFaceColors(pipelineMeshes.classifiedFaceTypes),
    wireColor: 0x4a4a48,
  });
  sceneView.setSecondaryMesh(pipelineMeshes.terminalFans, {
    color: FAN_TERMINAL_COLOR,
    wireColor: 0x2d5c2d,
    opacity: 0.92,
  });
  sceneView.setSpineOverlay(
    pipelineMeshes.fan.vertices,
    pipelineMeshes.spineSegments
  );
  btnNext.textContent = 'Next: elevate spine';
  setStepLabel('spine');
  setStatus(
    `Step 3 — terminal fans (green) + spine (${pipelineMeshes.spineSegments.length} segments). Each black branch should stop at a fan tip, not cross through it.`,
    'ok'
  );
  updateHint();
}

function showElevatedStep(): void {
  if (!pipelineMeshes) return;
  inflationStep = 'elevated';
  sceneView.clearSecondaryMesh();
  sceneView.clearSpineOverlay();
  sceneView.setMesh(pipelineMeshes.elevated, {
    color: ELEVATED_COLOR,
    wireColor: 0x3d6b80,
  });
  btnNext.textContent = 'Next: full inflation';
  setStepLabel('elevated');
  setStatus(
    `Step 4 — ${pipelineMeshes.elevated.faces.length} triangles (top + bottom). Spine height only — no quarter-oval subdivision.`,
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
  applyPendingCutRemoval();
});

btnFillCut.addEventListener('click', () => {
  applyFillCutHole();
});

btnDiscardCut.addEventListener('click', () => {
  sceneView.clearPendingCut();
  sceneView.clearCutProjectionPreview();
  clearStagedCut();
  updateCutActionButtons();
  setStatus('Cut discarded. Draw a new stroke across the silhouette.');
});

displayModeEl.addEventListener('change', () => {
  sceneView.setDisplayMode(displayModeEl.value as DisplayMode);
});
sceneView.setDisplayMode(displayModeEl.value as DisplayMode);

paintModeEl.addEventListener('change', () => {
  if (!polygonReady) return;
  if (paintModeEl.checked) {
    cutModeEl.checked = false;
    setInteractionMode('paint');
    setStatus('Paint mode: draw on the polygon (red).');
  } else if (!cutModeEl.checked) {
    setInteractionMode('orbit');
    setStatus('Drag to rotate · scroll to zoom · right-drag to pan.');
  }
  updateHint();
});

cutModeEl.addEventListener('change', () => {
  if (!polygonReady) return;
  if (cutModeEl.checked) {
    paintModeEl.checked = false;
    setInteractionMode('cut');
    updateCutActionButtons();
    setStatus(
      'Cut: stroke → review projection → Remove triangles → Fill hole.',
    );
  } else if (!paintModeEl.checked) {
    setInteractionMode('orbit');
    setStatus('Drag to rotate · scroll to zoom · right-drag to pan.');
  }
  updateCutActionButtons();
  updateHint();
});

btnSquare.addEventListener('click', () => {
  if (polygonReady || inflationStep !== 'idle') {
    setStatus('Clear first to create a new shape.', 'error');
    return;
  }
  const rect = sceneEl.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const size = Math.min(rect.width, rect.height) * 0.35;
  const half = size / 2;
  const screenSquare = [
    { x: cx - half, y: cy - half },
    { x: cx + half, y: cy - half },
    { x: cx + half, y: cy + half },
    { x: cx - half, y: cy + half },
    { x: cx - half, y: cy - half },
  ];
  startPipeline(sceneView.projectScreenToMeshPlane(screenSquare));
});

btnClear.addEventListener('click', () => {
  resetInflationFlow();
  clearStagedCut();
  sceneView.clear();
  paintModeEl.checked = false;
  cutModeEl.checked = false;
  setStatus('Cleared. Draw a new closed loop on the 3D plane.');
  updateHint();
});

resetInflationFlow();
setStatus(
  'Draw a closed loop, then use Next to step through T/S/J → fans → spine → elevated → full inflation.'
);
updateHint();
