import './style.css';
import { cutPolygon } from './cutPolygon';
import { DrawCanvas } from './drawCanvas';
import { buildMeshFromPolygon, buildTeddyMesh } from './teddy';
import { View3D, type DisplayMode, type InteractionMode } from './view3d';
import type { Vec2 } from './math';

let lastStroke: Vec2[] = [];
let lastClosed: Vec2[] = [];

const drawCanvasEl = document.querySelector<HTMLCanvasElement>('#draw-canvas')!;
const view3dEl = document.querySelector<HTMLElement>('#view3d')!;
const statusEl = document.querySelector<HTMLElement>('#status')!;
const btnGenerate = document.querySelector<HTMLButtonElement>('#btn-generate')!;
const btnClear = document.querySelector<HTMLButtonElement>('#btn-clear')!;
const btnSquare = document.querySelector<HTMLButtonElement>('#btn-square')!;

const displayModeEl = document.querySelector<HTMLSelectElement>('#display-mode')!;
const paintModeEl = document.querySelector<HTMLInputElement>('#paint-mode')!;
const cutModeEl = document.querySelector<HTMLInputElement>('#cut-mode')!;
const view3d = new View3D(view3dEl);

displayModeEl.addEventListener('change', () => {
  view3d.setDisplayMode(displayModeEl.value as DisplayMode);
});
view3d.setDisplayMode(displayModeEl.value as DisplayMode);

function setInteractionMode(mode: InteractionMode): void {
  view3d.setInteractionMode(mode);
  paintModeEl.checked = mode === 'paint';
  cutModeEl.checked = mode === 'cut';
}

paintModeEl.addEventListener('change', () => {
  if (paintModeEl.checked) {
    cutModeEl.checked = false;
    setInteractionMode('paint');
    setStatus('Paint mode: draw on the 3D view to project a stroke onto the mesh (red).');
  } else if (!cutModeEl.checked) {
    setInteractionMode('orbit');
  }
});

cutModeEl.addEventListener('change', () => {
  if (cutModeEl.checked) {
    paintModeEl.checked = false;
    setInteractionMode('cut');
    setStatus(
      'Cut mode: draw across the polygon so the stroke crosses the boundary twice (orange). Keeps the larger piece.',
    );
  } else if (!paintModeEl.checked) {
    setInteractionMode('orbit');
  }
});

function setStatus(message: string, type: 'ok' | 'error' | '' = ''): void {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

function applyPolygon(polygon: Vec2[], closed?: Vec2[]): void {
  const { mesh, error, polygon: closedPoly } = buildMeshFromPolygon(polygon);

  if (error || !mesh) {
    setStatus(error ?? 'Could not build mesh.', 'error');
    return;
  }

  view3d.setMesh(mesh, { preserveView: true });
  const ring = closed ?? closedPoly;
  lastClosed = ring;
  lastStroke = ring.slice(0, -1);
  drawCanvas.setClosedStroke(ring);

  setStatus(
    `Mesh updated — ${polygon.length} boundary vertices, ${mesh.faces.length} triangles.`,
    'ok'
  );
}

const drawCanvas = new DrawCanvas(drawCanvasEl, (raw, closed) => {
  lastStroke = raw;
  lastClosed = closed;
  generate();
});

function generate(): void {
  const stroke = lastClosed.length > 0 ? lastClosed : lastStroke;
  if (stroke.length < 3) {
    setStatus('Draw a closed shape first.', 'error');
    return;
  }

  setStatus('Triangulating polygon (CDT)…');
  const { mesh, error, polygon } = buildTeddyMesh(stroke);

  if (error || !mesh) {
    setStatus(error ?? 'Could not build mesh.', 'error');
    view3d.clear();
    return;
  }

  view3d.setMesh(mesh);
  setStatus(
    `3D model ready — ${polygon.length - 1} boundary vertices, ${mesh.faces.length} triangles.`,
    'ok'
  );
}

view3d.setOnCutComplete((cutPolyline) => {
  const polygon = view3d.getMeshPolygon();
  if (polygon.length < 3) {
    setStatus('No polygon to cut.', 'error');
    return false;
  }

  const result = cutPolygon(polygon, cutPolyline);
  if ('error' in result) {
    setStatus(result.error, 'error');
    return false;
  }

  applyPolygon(result.kept);
  setStatus(
    `Cut applied — kept ${result.kept.length} vertices (discarded ${result.discarded.length}). Re-triangulated.`,
    'ok'
  );
  return true;
});

btnGenerate.addEventListener('click', generate);

btnSquare.addEventListener('click', () => {
  const rect = drawCanvasEl.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const size = Math.min(rect.width, rect.height) * 0.45;
  const half = size / 2;
  const square: Vec2[] = [
    { x: cx - half, y: cy - half },
    { x: cx + half, y: cy - half },
    { x: cx + half, y: cy + half },
    { x: cx - half, y: cy + half },
    { x: cx - half, y: cy - half },
  ];
  lastStroke = square.slice(0, -1);
  lastClosed = square;
  drawCanvas.setClosedStroke(square);
  generate();
  setStatus('Test square created.', 'ok');
});

btnClear.addEventListener('click', () => {
  lastStroke = [];
  lastClosed = [];
  drawCanvas.clear();
  paintModeEl.checked = false;
  cutModeEl.checked = false;
  setInteractionMode('orbit');
  view3d.clear();
  setStatus('');
});
