# Tidy — Teddy Sketch to 3D

Web app that turns a hand-drawn 2D silhouette into an inflated 3D polygonal mesh using the **Teddy** algorithm from *Teddy: A Sketching Interface for 3D Freeform Design* (Igarashi, Matsuoka, Tanaka, SIGGRAPH 1999).

## Features

- **2D sketch canvas** — draw a freeform closed loop with pen or mouse
- **Auto-close tolerance** — if start and end are within 40px, the stroke snaps closed; otherwise a closing segment is added
- **Uniform resampling** — stroke is resampled to even edge length before meshing
- **Constrained Delaunay triangulation (CDT)** — `cdt2d` on the polygon boundary
- **Teddy inflation** — inflation pipeline ported from [zeyap/teddy](https://github.com/zeyap/teddy): terminal pruning, spine growth, quarter-oval elevation (SIGGRAPH ’99 §5.1), mirrored back face, and rim stitching
- **Single 3D panel** — draw the silhouette on the view plane; mesh appears where you drew with **rotate**, **zoom**, and **pan**
- **Paint & cut** — projected onto the 3D mesh after the silhouette is locked
- **Extrude** (SIGGRAPH ’99 §5.3) — two-stroke sweep: a closed loop projected onto the **front** surface only (auto-closed, must lie fully on the object), rotate to orient, then a second stroke whose silhouette the extrusion follows. The surface **enclosed by the loop is deleted**; the **base ring is the loop you drew** (projected onto the surface — its shape is preserved exactly, not snapped to triangle edges), and a short collar stitches the mesh-edge opening to the base ring. The base ring is then **swept** along the projected stroke into evenly-spaced layers that are connected and triangulated (ring-normal plane projection from footnote 2, two-pointer rib sweep from fig. 18).

## Live demo (GitHub Pages)

After the repo is on GitHub with Pages enabled (**Settings → Pages → Source: GitHub Actions**), the app is published at:

**https://h3902340.github.io/tidy/**

Each push to `main` rebuilds and deploys automatically.

## Run locally

```bash
npm install
npm run dev
```

Open the URL shown in the terminal (typically `http://localhost:5173`).

## Build

```bash
npm run build
npm run preview
npm test
```

`npm test` checks mesh winding: interior faces point outward from the solid, and **silhouette-adjacent** faces point up on the top cap (the usual hole source).

## Usage

1. Draw a simple closed shape on the canvas (blob, star, animal silhouette) — **only once** per session until **Clear**.
2. Release the pointer — the loop auto-closes and an inflated 3D shape appears (drag to rotate, scroll to zoom, right-drag to pan).
3. Use **Paint**, **Cut**, or **Extrude** modes for further edits.

### Extrude (two strokes)

1. Tick **Extrude** and draw a **closed loop** on the object’s front surface. Small gaps auto-close; if any part of the loop misses the surface it is rejected — redraw it.
2. The loop locks as a red ring. **Rotate** the view (drag) to the desired orientation, then click **Confirm orientation**.
3. Draw the **second stroke** starting on one side of the red loop and ending on the other. The enclosed surface is swept outward along that stroke (perpendicular to the surface), and the extrusion’s silhouette matches the stroke.

Avoid self-intersecting outlines; the paper’s algorithm assumes a simple closed polygon.

## Reference

- Paper: [siggraph99.pdf](https://www-ui.is.s.u-tokyo.ac.jp/~takeo/papers/siggraph99.pdf)
- Original Teddy: http://www-ui.is.s.u-tokyo.ac.jp/~takeo/teddy/teddy.htm
- Inflation port reference: [zeyap/teddy](https://github.com/zeyap/teddy)
