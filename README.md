# Tidy - Based on Teddy System by Takeo Igarashi (1999)

Web app that turns a hand-drawn 2D silhouette into an inflated 3D polygonal mesh using the **Teddy** algorithm from *Teddy: A Sketching Interface for 3D Freeform Design* (Igarashi, Matsuoka, Tanaka, SIGGRAPH 1999).

## Features

- **2D silhouette** — freehand loop or shape presets on the view plane
- **Teddy inflation** — CDT meshing, terminal pruning, spine growth, quarter-oval elevation, mirrored back face, and rim stitching (SIGGRAPH 1999 algorithm)
- **Single 3D viewport** — draw, orbit, paint, cut, and extrude in one panel
- **Surface paint** — Teddy-style strokes projected onto the mesh; erase by scribbling
- **Cut** — through-cut (open stroke) or loop cut (closed stroke on the surface)
- **Extrude** (SIGGRAPH ’99 §5.3) — closed base loop + extruding stroke sweep
- **Undo / redo** — mesh geometry and paint history

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

## Build & test

```bash
npm run build
npm run preview
npm test
```

`npm test` checks mesh winding: interior faces point outward from the solid, and silhouette-adjacent faces point up on the top cap.

---

## Mouse & camera controls

**Right mouse always rotates** the camera in every mode. Other bindings depend on whether you are drawing.

### View, cut review, extrude orient (not drawing)

| Action | Control |
|--------|---------|
| Rotate | **Right-drag** |
| Pan | **Left-drag** |
| Zoom | **Scroll** (middle mouse dolly) |

### Paint, cut (drawing), extrude loop/curve (drawing)

| Action | Control |
|--------|---------|
| Draw stroke | **Left-drag** |
| Rotate | **Right-drag** |
| Pan | **Middle-drag** |
| Zoom | **Scroll** |

After paint, cut, extrude, undo, or redo, the app **stays in the current tool** (it does not switch back to View automatically).

---

## Operations

### 1. Create a shape

**Draw a silhouette**

1. On first load, draw a **closed loop** on the canvas with the left mouse button.
2. Release — if the start and end are within 40px the stroke snaps closed; otherwise a closing segment is added.
3. The stroke is resampled and inflated into a 3D mesh.

**Shape presets** (toolbar icons)

Click any preset to skip freehand drawing:

| Button | Shape |
|--------|--------|
| Circle | Circle |
| Oval | Ellipse |
| Triangle | Equilateral triangle |
| Square | Axis-aligned square |
| Star | 5-point star |

Presets only work before a shape exists. If a mesh is already loaded, press **Clear** first.

**Tips**

- Use a **simple closed polygon** — self-intersecting outlines are rejected.
- The camera starts in a **top-down** view aligned with the drawing plane.

---

### 2. Clear

**Clear** resets the session: mesh, paint, edit history, and tools return to the initial silhouette-drawing state. Use this to start a completely new object.

---

### 3. View

After inflation, **View** is the default editing tool (toolbar tab).

- Orbit with **right-drag**, pan with **left-drag**, zoom with **scroll**.
- **Top view** (toolbar icon) snaps the camera back to the top-down drawing angle. Useful before a through-cut so the stroke lines up with the visible silhouette.

---

### 4. Display

The **Display** dropdown (toolbar) changes how the mesh is rendered:

| Mode | Description |
|------|-------------|
| **Solid** | Filled shaded mesh |
| **Wireframe** | Triangle edges only |
| **Both** | Solid fill plus wireframe overlay |

Available before and after inflation.

---

### 5. Sketch rendering

After inflation, enable **Sketch** in the edit toolbar for a pencil-style stipple fill and inked silhouette outline. Toggle off to return to standard Phong shading.

---

### 6. Paint

Switch to the **Paint** tab. A palette appears at the **top-left** of the canvas.

**Draw**

1. Choose **Draw** (default).
2. Pick a color from the swatches or the custom color picker.
3. Set **Brush** thickness with the slider (2–60 px).
4. **Left-drag** on the visible surface to paint.

Strokes are projected onto the mesh along view rays and rendered as surface ribbons. Paint must stay **inside the object outline** (in debug mode the dashed blue silhouette is shown as a guide; in normal use validation still applies from the computed outline).

**Erase**

1. Choose **Erase**.
2. **Left-drag** over painted areas to remove paint. Only the ribbon under the brush is clipped away — strokes can be split or thinned without deleting whole lines.

**Paint behavior**

- Crossing strokes carve the layer underneath so newer paint sits on top without z-fighting.
- Paint is stored on the mesh surface and **survives cut and extrude** (it is restored from history on undo/redo).
- Each successful paint or erase step is recorded for undo.

---

### 7. Cut

Switch to the **Cut** tab. One tool handles both cut types; the app picks the operation from your stroke shape.

#### Through cut (open stroke)

1. Draw an **open** stroke that crosses the object’s **visible silhouette** exactly twice (once on each side).
2. The mesh is split; the **smaller** piece is removed and the opening is **capped**.

If the stroke does not cross the outline correctly, an error appears at the **bottom-left** of the canvas (auto-hides after 5 seconds). Try **Top view** and redraw.

#### Loop cut (closed stroke)

1. Draw a **closed loop** on the front surface (small gaps at the endpoints auto-close).
2. The enclosed front patch is removed and the hole is **filled** with new triangles.

**Production mode** (debug off): loop cuts run automatically through imprint → remove → fill.

**Debug mode** (see below): loop cuts step through **Next: Remove triangles** → **Next: Fill hole**, with **Discard cut** to abort.

#### Through cut in debug mode

The front/back projection is shown first. Press **Next: Apply cut** to commit or **Discard cut** to cancel. While reviewing: **right-drag** rotates, **left-drag** pans, **scroll** zooms.

---

### 8. Extrude

Switch to the **Extrude** tab (SIGGRAPH ’99 §5.3 two-stroke sweep).

**Step 1 — Base loop**

- **Left-drag** a **closed loop** on the object’s front surface.
- The loop is validated and imprinted; a **red ring** marks the base.

**Step 2 — Orient**

- **Right-drag** to rotate the view to the desired extrusion direction.
- Click **Confirm orientation** (top-right of the canvas).

**Step 3 — Extruding stroke**

- **Left-drag** a second stroke from one side of the red loop to the other.
- The enclosed surface is swept along the projected stroke into layered triangles.

After a successful extrude, Extrude mode stays active and a **new** extrude gesture begins automatically.

You can **right-drag** to orbit during loop and curve drawing, same as Paint and Cut.

---

### 9. Undo & redo

| Action | Control |
|--------|---------|
| Undo | Toolbar undo button, or **⌘Z** / **Ctrl+Z** |
| Redo | Toolbar redo button, or **⌘⇧Z** / **Ctrl+Shift+Z** (or **Ctrl+Y** on Windows) |

Undo/redo restores **mesh geometry** and **surface paint**. The current tool mode is preserved.

History is seeded when inflation completes; **Clear** resets history.

---

### 10. Status messages

Validation errors (paint outside outline, failed cut, short stroke, etc.) appear in a **bottom-left** overlay on the canvas. Error messages **disappear automatically after 5 seconds**.

---

### 11. Debug mode

Enable **Debug mode** in the header.

**Silhouette guide** — dashed blue outline while drawing paint or cut strokes (hidden in normal use).

**Inflation pipeline** — after creating a shape, use **Next step** on the canvas overlay to walk through the full pipeline instead of jumping straight to the result:

1. **Classified** — CDT mesh with T (terminal), S (side), J (join) triangle colors  
2. **Terminal prune** — fig. 14 pruning steps (per-terminal fan wedges)  
3. **Fan triangles** — terminal fan overlay (green)  
4. **Spine** — chordal-axis spine on the fan mesh  
5. **Spine elevation** — incremental spine height steps  
6. **Elevated spine** — full elevated axis  
7. **Fan elevation** — wedge-by-wedge fan elevation  
8. **Quarter ovals** — outer fan quarter-oval patches  
9. **Internal triangles / quarter ovals** — interior wedge handling (when present)  
10. **Complete top surface** — finished top cap  
11. **Mirrored solid** — top + bottom shell  
12. **Done** — final inflated mesh  

Skip shortcuts: **Skip to fan triangles**, **Skip to elevated spine**, **Skip fan construction**, **Skip to result**.

**Cut / loop cut in debug** — stepped apply with **Next** and **Discard cut** (see Cut section).

---

## Toolbar reference

| Control | When available | Action |
|---------|----------------|--------|
| Circle / Oval / Triangle / Square / Star | Before first shape | Insert preset silhouette |
| Clear | Always | Reset session |
| Top view | Always | Snap to top-down camera |
| Display | Always | Solid / wireframe / both |
| View / Paint / Cut / Extrude | After inflation | Switch editing tool |
| Undo / Redo | After inflation | History |
| Sketch | After inflation | Pencil rendering toggle |
| Debug mode | Always | Pipeline + cut stepping + silhouette guide |
| Draw / Erase | Paint mode | Paint tool |
| Color swatches + picker | Paint mode | Stroke color |
| Brush slider | Paint mode | Stroke width |
| Confirm orientation | Extrude orient phase | Lock extrusion direction |
| Next step / Skip / Discard cut | Debug mode | Pipeline and cut controls |

---

## Reference

- Paper: [siggraph99.pdf](https://www-ui.is.s.u-tokyo.ac.jp/~takeo/papers/siggraph99.pdf)
- Original Teddy: http://www-ui.is.s.u-tokyo.ac.jp/~takeo/teddy/teddy.htm
