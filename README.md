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
3. Use **Paint** or **Cut** modes for further edits.

Avoid self-intersecting outlines; the paper’s algorithm assumes a simple closed polygon.

## Reference

- Paper: [siggraph99.pdf](https://www-ui.is.s.u-tokyo.ac.jp/~takeo/papers/siggraph99.pdf)
- Original Teddy: http://www-ui.is.s.u-tokyo.ac.jp/~takeo/teddy/teddy.htm
- Inflation port reference: [zeyap/teddy](https://github.com/zeyap/teddy)
