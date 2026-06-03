import './style.css';
import { cutPolygon } from './cutPolygon';
import { SceneView, type DisplayMode, type InteractionMode } from './sceneView';
import { buildMeshFromPolygon, buildTeddyMesh } from './teddy';
import type { Vec2 } from './math';

const sceneEl = document.querySelector<HTMLElement>('#scene-view')!;
const hintEl = document.querySelector<HTMLElement>('#canvas-hint')!;
const statusEl = document.querySelector<HTMLElement>('#status')!;
const btnClear = document.querySelector<HTMLButtonElement>('#btn-clear')!;
const btnSquare = document.querySelector<HTMLButtonElement>('#btn-square')!;
const displayModeEl = document.querySelector<HTMLSelectElement>('#display-mode')!;
const paintModeEl = document.querySelector<HTMLInputElement>('#paint-mode')!;
const cutModeEl = document.querySelector<HTMLInputElement>('#cut-mode')!;

let polygonReady = false;

const sceneView = new SceneView(sceneEl);
sceneView.setInteractionMode('silhouette');

function setStatus(message: string, type: 'ok' | 'error' | '' = ''): void {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

function setInteractionMode(mode: InteractionMode): void {
  sceneView.setInteractionMode(mode);
  paintModeEl.checked = mode === 'paint';
  cutModeEl.checked = mode === 'cut';
}

function updateHint(): void {
  if (!polygonReady) {
    hintEl.textContent = 'Draw one closed loop on the 3D plane';
    return;
  }
  if (paintModeEl.checked) {
    hintEl.textContent = 'Paint on surface (red)';
    return;
  }
  if (cutModeEl.checked) {
    hintEl.textContent = 'Cut: cross boundary twice (orange)';
    return;
  }
  hintEl.textContent = 'Drag to rotate · scroll to zoom · right-drag to pan';
}

function showPolygon(mesh: ReturnType<typeof buildTeddyMesh>['mesh']): void {
  if (!mesh) return;
  polygonReady = true;
  sceneView.setMesh(mesh);
  displayModeEl.disabled = false;
  paintModeEl.disabled = false;
  cutModeEl.disabled = false;
  setInteractionMode('orbit');
  updateHint();
}

function applyMeshFromPolygon(ring: Vec2[]): boolean {
  const { mesh, error } = buildMeshFromPolygon(ring);
  if (error || !mesh) {
    setStatus(error ?? 'Could not build mesh.', 'error');
    return false;
  }
  sceneView.setMesh(mesh);
  setStatus(
    `Polygon updated — ${mesh.vertices.length} vertices, ${mesh.faces.length} triangles.`,
    'ok'
  );
  setInteractionMode('orbit');
  updateHint();
  return true;
}

sceneView.setOnSilhouetteComplete((closed) => {
  setStatus('Triangulating polygon (CDT)…');
  const { mesh, error, polygon } = buildTeddyMesh(closed);

  if (error || !mesh) {
    setStatus(error ?? 'Could not build mesh.', 'error');
    sceneView.setInteractionMode('silhouette');
    return;
  }

  showPolygon(mesh);
  setStatus(
    `Polygon created — ${polygon.length - 1} boundary vertices, ${mesh.faces.length} triangles.`,
    'ok'
  );
});

sceneView.setOnCutComplete((cutPolyline) => {
  const polygon = sceneView.getMeshPolygon();
  if (polygon.length < 3) {
    setStatus('No polygon to cut.', 'error');
    return false;
  }

  const result = cutPolygon(polygon, cutPolyline);
  if ('error' in result) {
    setStatus(result.error, 'error');
    return false;
  }

  applyMeshFromPolygon(result.kept);
  setStatus(
    `Cut applied — kept ${result.kept.length} vertices (discarded ${result.discarded.length}).`,
    'ok'
  );
  return true;
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
    setStatus(
      'Cut mode: draw across the polygon; stroke must cross the boundary twice (orange).',
    );
  } else if (!paintModeEl.checked) {
    setInteractionMode('orbit');
    setStatus('Drag to rotate · scroll to zoom · right-drag to pan.');
  }
  updateHint();
});

btnSquare.addEventListener('click', () => {
  if (polygonReady) {
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
  const square = sceneView.projectScreenToMeshPlane(screenSquare);
  setStatus('Triangulating polygon (CDT)…');
  const { mesh, error, polygon } = buildTeddyMesh(square);
  if (error || !mesh) {
    setStatus(error ?? 'Could not build mesh.', 'error');
    return;
  }
  showPolygon(mesh);
  setStatus(
    `Test square — ${polygon.length - 1} vertices, ${mesh.faces.length} triangles.`,
    'ok'
  );
});

btnClear.addEventListener('click', () => {
  polygonReady = false;
  sceneView.clear();
  paintModeEl.checked = false;
  cutModeEl.checked = false;
  displayModeEl.disabled = true;
  paintModeEl.disabled = true;
  cutModeEl.disabled = true;
  setStatus('Cleared. Draw a new closed loop on the 3D plane.');
  updateHint();
});

setStatus('Draw a closed loop on the 3D view (once). It triangulates when you release.');
updateHint();
