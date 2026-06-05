# Tidy — Teddy Sketch to 3D

Web app that turns a hand-drawn 2D silhouette into an inflated 3D polygonal mesh using the **Teddy** algorithm from *Teddy: A Sketching Interface for 3D Freeform Design* (Igarashi, Matsuoka, Tanaka, SIGGRAPH 1999).

## Features

- **2D sketch canvas** — draw a freeform closed loop with pen or mouse
- **Auto-close tolerance** — if start and end are within 40px, the stroke snaps closed; otherwise a closing segment is added
- **Uniform resampling** — stroke is resampled to even edge length before meshing
- **Constrained Delaunay triangulation (CDT)** — `cdt2d` on the polygon boundary
- **Teddy inflation** — inflation pipeline ported from [zeyap/teddy](https://github.com/zeyap/teddy): terminal pruning, spine growth, quarter-oval elevation (SIGGRAPH ’99 §5.1), mirrored back face, and rim stitching
- **Single 3D panel** — draw the silhouette on the view plane; mesh appears where you drew
- **Paint & cut** — projected onto the 3D mesh after the silhouette is locked
- **Extrude** (SIGGRAPH ’99 §5.3) — two-stroke sweep: a closed loop on the front surface, then a second stroke defining the extrusion silhouette. The enclosed surface is removed; the base ring is swept along the projected stroke into triangulated layers.

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

### Create a shape

1. Draw a closed loop on the canvas, or click a preset (**circle**, **oval**, **triangle**, **square**, **star**).
2. Release the pointer — the loop auto-closes and inflates into a 3D mesh.
3. **Clear** resets the session so you can start a new shape.

Avoid self-intersecting outlines; the algorithm assumes a simple closed polygon.

### View (orbit)

After inflation, **View** is the default tool:

| Action | Control |
|--------|---------|
| Rotate | Drag |
| Zoom | Scroll |
| Pan | Right-drag |

**Top view** (toolbar) snaps the camera back to the initial top-down drawing angle.

### Paint

1. Switch to **Paint**.
2. Pick a color and brush size from the palette (top-left of the canvas).
3. **Left-drag** on the surface to paint.

Paint mode shares the canvas with the camera:

| Action | Control |
|--------|---------|
| Paint | Left-drag |
| Rotate | Right-drag |
| Zoom | Scroll |
| Pan | Middle-drag |

### Cut

**Through cut** — draw an **open** stroke across the object (it must cross the visible silhouette). The smaller side is removed and the section is capped.

**Loop cut** — draw a **closed** loop on the surface to remove the enclosed patch (small endpoint gaps auto-close).

| Action | Control |
|--------|---------|
| Draw cut | Left-drag |
| Rotate | Right-drag |
| Zoom | Scroll |
| Pan | Middle-drag |

Use **Top view** before a through cut if the stroke does not line up with the silhouette.

With **Debug mode** enabled, a through cut pauses after front/back projection: press **Next: Apply cut** on the canvas overlay to commit, or **Discard cut** to cancel. A loop cut in debug mode steps through imprint → remove triangles → fill hole via **Next**.

While reviewing a pending cut in debug mode: **drag** rotates, **scroll** zooms, **right-drag** pans.

### Extrude (two strokes)

1. Switch to **Extrude** and draw a **closed loop** on the object’s front surface. Small gaps auto-close; if any part misses the surface the loop is rejected — redraw it.
2. The loop locks as a red ring. **Rotate** the view to the desired orientation, then click **Confirm orientation** (top-right of the canvas).
3. Draw the **second stroke** across the red loop. The enclosed surface is swept outward along that stroke.

During orientation: **drag** rotates, **scroll** zooms, **right-drag** pans.

### Edit tools

- **Undo / Redo** — toolbar buttons, or ⌘Z / ⌘⇧Z (Ctrl+Z / Ctrl+Shift+Z on Windows)
- **Display** — solid, wireframe, or both
- **Sketch** — pencil-style stipple rendering with silhouette outline

### Debug mode

Enable **Debug mode** in the header to step through the inflation pipeline with **Next step**:

1. **Classified** — CDT mesh with T (terminal), S (side), J (join) triangle colors
2. **Fan** — terminal fan triangles (green overlay)
3. **Spine** — chordal-axis spine on the fan mesh
4. **Elevated** — spine raised with height labels (no quarter-ovals yet)
5. **Inflated** — full Teddy inflation

In **Cut** mode with debug on, cut operations use the overlay controls (**Next**, **Discard cut**) instead of applying immediately.

## Reference

- Paper: [siggraph99.pdf](https://www-ui.is.s.u-tokyo.ac.jp/~takeo/papers/siggraph99.pdf)
- Original Teddy: http://www-ui.is.s.u-tokyo.ac.jp/~takeo/teddy/teddy.htm
- Inflation port reference: [zeyap/teddy](https://github.com/zeyap/teddy)
