# Tidy — Teddy Sketch to 3D

Web app that turns a hand-drawn 2D silhouette into an inflated 3D polygonal mesh using the **Teddy** algorithm from *Teddy: A Sketching Interface for 3D Freeform Design* (Igarashi, Matsuoka, Tanaka, SIGGRAPH 1999).

## Features

- **2D sketch canvas** — draw a freeform closed loop with pen or mouse
- **Auto-close tolerance** — if start and end are within 40px, the stroke snaps closed; otherwise a closing segment is added
- **Uniform resampling** — stroke is resampled to even edge length before meshing
- **Constrained Delaunay triangulation (CDT)** — `cdt2d` on the polygon boundary
- **Flat 3D polygon** — CDT fills the interior; all vertices lie in the sketch plane (z = 0)
- **3D viewer** — orbit (drag), zoom (scroll) via Three.js

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
```

## Usage

1. Draw a simple closed shape on the left (blob, star, animal silhouette).
2. Release the pointer — the loop auto-closes when endpoints are close enough.
3. Click **Generate 3D**.
4. Rotate and zoom the result on the right.

Avoid self-intersecting outlines; the paper’s algorithm assumes a simple closed polygon.

## Reference

- Paper: [siggraph99.pdf](https://www-ui.is.s.u-tokyo.ac.jp/~takeo/papers/siggraph99.pdf)
- Original Teddy: http://www-ui.is.s.u-tokyo.ac.jp/~takeo/teddy/teddy.htm
