# Tidy — A Sketch-Based 3D Freeform Modeling System

### A Technical Report on a Browser Implementation of the *Teddy* Algorithm

---

**Project:** Tidy — Based on Teddy System by Takeo Igarashi (1999)
**Domain:** Interactive computer graphics / geometric modeling
**Primary reference:** Igarashi, Matsuoka & Tanaka, *Teddy: A Sketching Interface for 3D Freeform Design*, SIGGRAPH 1999
**Implementation:** TypeScript + Three.js, single-page web application

---

## Table of Contents

1. Executive Summary
2. Introduction and Background
3. Technology Stack and Project Layout
4. System Architecture
5. The Inflation Pipeline (Creating a Shape)
6. Interaction Model and Rendering
7. Surface Editing I — Painting and Cutting
8. Surface Editing II — Loop Cut and Imprinting
9. Surface Editing III — Extrusion
10. Non-Photorealistic "Pencil Sketch" Rendering
11. Mesh Integrity, Winding, and Testing
12. Engineering Challenges and Lessons Learned
13. Limitations and Future Work
14. Conclusion
15. References and Appendix

---

## 1. Executive Summary

Tidy is a browser-based 3D modeling application that reproduces the core ideas of the
landmark *Teddy* system, which pioneered the idea of "inflating" a hand-drawn 2D outline into
a plausible rounded 3D model. A user draws a single closed stroke; the system triangulates that
outline, computes its medial (chordal) axis, lifts the interior into a smooth dome, mirrors it to
form a closed watertight solid, and presents it in an interactive 3D viewport. From there the user
can refine the model through gesture-based editing — **surface paint** (draw and erase),
**cut** (through-cut or loop cut, chosen automatically from the stroke shape), and
**extrude** — each projected from screen space onto the 3D surface. **Undo and redo** restore
both mesh geometry and painted surface lines. A stylized "pencil sketch" rendering mode imitates
the look of the original Teddy demo.

The system is written entirely in TypeScript and runs client-side with no server component. It
uses Three.js for rendering and interaction, the `cdt2d` library for constrained Delaunay
triangulation, and a custom geometry layer (roughly 14,000 lines of source across 26 modules) that
implements the inflation algorithm, screen-to-surface projection, surface-line painting, and the
editing operations. A Vitest suite (28 tests across three files) guards mesh winding and cut logic.

This report documents the architecture, the algorithms behind each feature, the coordinate-system
conventions that tie the 2D drawing surface to the 3D world, the engineering challenges that arose
(particularly around robust surface editing and smooth extrusion sweeps), and directions for future
work.

---

## 2. Introduction and Background

### 2.1 The Teddy idea

Traditional 3D modeling tools demand precise, deliberate manipulation of vertices, edges, and
control points. The 1999 *Teddy* paper proposed a radically more fluid alternative: the user
**sketches** the silhouette of an object as if doodling on paper, and the system infers a full 3D
form. The central insight is that a closed 2D outline contains enough information to suggest a
rounded volume — parts of the silhouette that are "thick" (far from the shape's central axis)
should bulge out more than "thin" parts. By computing the distance from the interior to the
boundary and using it as an elevation, a flat outline becomes a smooth, inflated body reminiscent of
a balloon or a stuffed toy (hence "Teddy").

Beyond creation, Teddy defined a family of gesture-based editing operations — extrusion, cutting,
smoothing, and bending — all driven by simple strokes rather than menus or numeric entry. Tidy
implements the creation pipeline and Teddy's stroke-driven editing gestures — through-cut, loop cut,
extrude, and surface painting.

### 2.2 Goals of the Tidy project

- Faithfully reproduce the Teddy **inflation** algorithm in a modern web environment.
- Provide a **single unified 3D canvas**: the user draws directly on the view plane and the model
  appears where they drew, then can be orbited, zoomed, and panned.
- Support **stroke-driven editing** that operates on the actual surface mesh (not a separate
  overlay), keeping the mesh watertight after each operation.
- Provide **undo/redo** over mesh edits and surface paint so users can experiment safely.
- Offer an optional **stylized rendering** mode that evokes the hand-drawn aesthetic of the
  original paper's figures and demo video.
- Run **entirely client-side** so it can be deployed as a static site (GitHub Pages).

### 2.3 Relationship to prior implementations

The inflation core is a careful TypeScript implementation of the SIGGRAPH 1999 Teddy algorithm,
adapted to Tidy's data structures and extended with additional winding-correction passes. The
editing operations (loop cut, extrusion, and the cut tool) and the entire interaction/rendering
layer are original to this project, as is the non-photorealistic shader.

---

## 3. Technology Stack and Project Layout

### 3.1 Dependencies

| Layer | Choice | Role |
|-------|--------|------|
| Language | TypeScript (~6.0) | Static typing across the geometry and UI code |
| Rendering | Three.js (0.184) | WebGL scene graph, camera, raycasting, controls |
| Triangulation | `cdt2d` (1.0) | Constrained Delaunay triangulation of the outline |
| Build | Vite (8.0) | Dev server, bundling, static build |
| Tests | Vitest (4.1) | Unit tests for mesh winding and cut logic |
| Deploy | GitHub Actions → Pages | Automatic static deployment on push to `main` |

The runtime dependency footprint is intentionally small: Three.js, `cdt2d`, and the project's own
code. No UI framework is used — the interface is hand-written DOM plus two canvases (a 2D overlay
and the WebGL canvas).

### 3.2 Source modules

The `src/` directory contains the following modules, grouped here by responsibility:

**Geometry / math foundations**
- `math.ts` — vector types, distance, cross products, winding-number point-in-polygon test.
- `cdt.ts` — wrapper over `cdt2d` that triangulates the outline and classifies each triangle as
  Terminal / Sleeve / Junction (T/S/J) by counting boundary edges.
- `stroke.ts` — stroke closing (auto-snap tolerance), uniform resampling, self-intersection test.

**Inflation pipeline**
- `teddyInflation.ts` (≈ 2,770 lines) — the heart of the creation algorithm: pruning, chordal-axis
  spine growth, quarter-oval elevation, back-face mirroring, and rim stitching.
- `teddyPipeline.ts` — orchestrates the inflation stages and exposes intermediate meshes for the
  step-by-step UI.
- `teddy.ts` — thin public facade over the pipeline.
- `meshWinding.ts` (≈ 559 lines) — face-orientation utilities that keep the solid's normals
  consistently outward.

**Interaction and rendering**
- `sceneView.ts` (≈ 2,700 lines) — the central controller: Three.js scene, camera, orbit controls,
  pointer handling, all interaction modes, overlay drawing, and painted-line meshes.
- `main.ts` (≈ 1,500 lines) — DOM wiring, tool tabs, preset shapes, edit history, debug stepping,
  status messaging.
- `screenSilhouette.ts`, `renderSilhouette.ts` — projecting mesh vertices to screen and computing
  view-dependent silhouettes.
- `surfaceProjection.ts` — raycasting screen strokes onto the 3D surface (paired front/back hits,
  face normals, surface-aligned lift for paint).
- `surfaceLines.ts` — Teddy-style surface paint: ribbon geometry, carve/erase clipping, silhouette
  validation.
- `editHistory.ts` — undo/redo snapshots (`Mesh3D` + optional painted surface lines).
- `sketchShader.ts` — the non-photorealistic stipple + outline materials.

**Editing operations**
- `cutPolygon.ts`, `meshCut.ts` — the Teddy §5.4 through-cut (remove a side, cap the hole).
- `loopImprint.ts` — imprint a closed screen loop onto the mesh and remove the enclosed surface
  (loop cut and extrusion base).
- `extrude.ts` (≈ 583 lines) — the §5.3 extrusion sweep built on top of loop imprinting.

**Tests**
- `meshWinding.test.ts`, `meshCut.test.ts`, `teddyInflation.test.ts`.

---

## 4. System Architecture

### 4.1 High-level data flow

```
 2D stroke (pointer events)
      │  close + resample (stroke.ts)
      ▼
 simple closed polygon
      │  constrained Delaunay (cdt.ts → cdt2d)
      ▼
 triangulated outline + T/S/J classification
      │  prune to wedges, grow chordal axis (teddyInflation.ts)
      ▼
 elevated top fan (quarter-oval heights)
      │  mirror back face + stitch silhouette rim
      ▼
 watertight inflated Mesh3D  ───────────────►  SceneView (Three.js)
      ▲                                              │
      │   edited Mesh3D + surface lines              │ pointer strokes
      └──── editHistory (undo/redo) ◄────────────────┘
            cut / loop cut / extrude / paint
```

The fundamental data structure passed between every stage is the deliberately minimal `Mesh3D`:

```29:32:src/teddyPipeline.ts
export interface Mesh3D {
  vertices: Vec3[];
  faces: [number, number, number][];
}
```

Everything — inflation output, cut results, extrusion output — is expressed as this
vertices-plus-triangles pair. Keeping the interchange format trivial means each module can be
understood and tested in isolation, and the renderer only ever has to know how to draw one thing.

### 4.2 Separation of concerns

The project draws a firm line between **pure geometry** (no Three.js, no DOM — operates on plain
`Vec2`/`Vec3` and `Mesh3D`) and **interaction/rendering** (Three.js objects, cameras, pointer
events). The inflation pipeline, the cut/loop-cut/extrude geometry kernels, and the math utilities
are all pure; they can be unit-tested headlessly, which is exactly what the Vitest suite does.

`SceneView` is the bridge. It owns the Three.js scene and translates user gestures into calls into
the pure geometry layer, then feeds the resulting `Mesh3D` back into the renderer. `main.ts` sits
above `SceneView`, wiring HTML controls (display mode, mode checkboxes, action buttons) to its
public methods and reflecting status back to the user.

### 4.3 The coordinate-system convention

One subtle but pervasive design decision deserves emphasis because it underlies most of the editing
code. The inflation pipeline works in a 2D-image-like coordinate frame (y increases downward, as in
screen and canvas space). To display this naturally in a right-handed 3D world, the renderer applies
a **(1, −1, 1) scale** to the mesh object — flipping y so "down" on the drawing becomes "down" in
the world.

This means there are two coordinate spaces in constant use:

- **Mesh storage space** — the raw `Vec3` values stored in `Mesh3D.vertices`.
- **Render/world space** — those values with y negated, i.e. `(x, −y, z)`.

Any code that projects a vertex to the screen, raycasts against the surface, or reasons about the
camera must do so in render space, and any geometry it computes there must be converted back to
storage space (negating y again) before being written into a `Mesh3D`. Helper functions such as
`meshVertexToWorld`, `worldHitToMeshVertex`, and `mesh3DToRaycastObject` encapsulate this flip.
Getting this convention wrong is a recurring source of bugs (see §12), so it is centralized as much
as possible.

---

## 5. The Inflation Pipeline (Creating a Shape)

This is the algorithmic centerpiece — the transformation from a flat outline to a rounded solid. It
is implemented across `stroke.ts`, `cdt.ts`, `teddyInflation.ts`, and `teddyPipeline.ts`, and it
proceeds in the following stages.

### 5.1 Stroke acquisition and normalization

The first stroke is captured on a transparent 2D overlay atop the WebGL canvas as a list of pointer
positions, sampled whenever the pointer moves more than 2 px. Shape presets (circle, oval,
triangle, square, star) can skip freehand drawing. On release, the stroke is
**auto-closed**: if the start and end points are within a 40 px tolerance the loop is snapped shut,
otherwise a closing segment is appended.

```3:21:src/stroke.ts
export const CLOSE_TOLERANCE = 40;
export const RESAMPLE_STEP = 8;

/** Close an open stroke if start/end are within tolerance; always returns a closed ring. */
export function closeStroke(points: Vec2[], tolerance = CLOSE_TOLERANCE): Vec2[] {
  if (points.length < 3) return [...points];

  const first = points[0];
  const last = points[points.length - 1];
  const gap = dist(first, last);

  if (gap <= tolerance) {
    const closed = points.slice(0, -1);
    closed.push({ ...first });
    return closed;
  }

  return [...points, { ...first }];
}
```

The closed polygon is then **uniformly resampled** to roughly 8 px edge length, so the
triangulation sees evenly spaced vertices regardless of how fast the user drew, and is checked for
**self-intersection** — Teddy's algorithm assumes a simple (non-self-crossing) polygon, so a
figure-eight outline is rejected with an explanatory message rather than producing garbage.

### 5.2 Constrained Delaunay triangulation and triangle classification

The clean polygon is triangulated with `cdt2d`, constrained so the polygon's own edges are
preserved and only the interior is filled (`interior: true, exterior: false`). Each resulting
triangle is then classified by how many of its edges lie on the original boundary:

- **Terminal (T)** — two boundary edges; sits at a "tip" of the shape.
- **Sleeve (S)** — one boundary edge; forms the body of a limb.
- **Junction (J)** — zero boundary edges; where limbs meet.

This T/S/J taxonomy comes directly from the paper and drives the next stage. It is computed simply
by testing each triangle edge for membership in the boundary-edge set.

### 5.3 Chordal-axis spine and pruning

Connecting the midpoints of every triangle's interior edges yields the **chordal axis** — a
discrete approximation of the shape's medial axis (its "skeleton"). Raw chordal axes are noisy:
terminal triangles produce spurious little spurs. The pipeline therefore **prunes** terminal
triangles, fanning them into wedges that connect the boundary directly to a spine endpoint, and
merges the surviving sleeve/junction triangles into a branched spine. The result is a set of
**wedges** (boundary-to-spine fan triangles) and a set of **axis segments** (the pruned skeleton),
both exposed for visualization.

`teddyInflation.ts` contains a substantial amount of careful bookkeeping here — ensuring that every
terminal corner actually receives fan triangles, that orphaned fan tips get linked back to the axis,
and that doubly-defined edges are removed — because these edge cases are exactly where holes and
non-manifold geometry would otherwise creep in.

### 5.4 Elevation: turning distance into height

The defining step. Each spine vertex is lifted out of the plane by an amount proportional to its
distance from the boundary (mediated by an `ELEVATION_FACTOR` of 0.5), and the fan triangles between
the boundary (height 0) and the elevated spine are subdivided along **quarter-oval** profiles rather
than straight ramps. The quarter-oval gives the characteristic smooth, bulging cross-section — a
limb's profile rises steeply from the silhouette and flattens toward the spine, exactly as a
rounded tube would. This corresponds to §5.1 of the paper.

### 5.5 Closing the solid: back face and rim

The elevated fan is only the *top* half of the model. To make a closed solid, the pipeline mirrors
the top across the z = 0 plane to produce a **back face** (`drawBackface`), then **stitches the
silhouette rim** — the loop of boundary vertices shared by both halves — so that front and back are
joined into a single watertight surface (`stitchSilhouetteRim`). After this step the mesh is, in
principle, a closed two-manifold.

### 5.6 Winding correction

In practice, mirroring and stitching can leave individual triangles wound inconsistently (some
facing inward), which produces visible holes and shading artifacts under back-face culling. The
final stage runs several passes from `meshWinding.ts`:

```118:128:src/teddyPipeline.ts
  const interior = teddyInteriorReference(polygon, vertices);
  const windingOpts = {
    skipBoundaryFaces: true,
    boundaryVertexCount: polygon.length,
    topVertexCount,
    referencePoint: interior,
  };

  enforceOutwardSolidWinding(vertices, faces, interior);
  enforceBoundaryCapWinding(vertices, faces, polygon.length, topVertexCount);
  fixInwardFaces(vertices, faces, windingOpts);
```

These passes use an interior reference point to decide, for each triangle, whether its normal points
away from the solid's center (outward) and flip the ones that don't. The boundary-cap pass handles
the special case of silhouette-adjacent faces, which is where holes most commonly appeared during
development. Mesh winding is considered important enough to be the focus of the automated test suite
(§11).

### 5.7 Staged output for the UI

`teddyPipeline.ts` does not just return the final mesh; it returns a `TeddyPipelineMeshes` bundle
containing every intermediate artifact — the classified CDT, the terminal-prune fans, the flat 2D
fan, the spine segments, the elevated solid, and the fully inflated mesh. This lets the UI present a
**"Next step"** walkthrough (T/S/J → fans → spine → elevation → full inflation), which is both an
educational feature and an invaluable debugging aid.

---

## 6. Interaction Model and Rendering

### 6.1 The unified 3D canvas

Rather than splitting drawing and viewing into separate panes, Tidy uses a single 3D viewport for
everything. The initial silhouette is drawn on a transparent 2D overlay; the stroke is projected
onto the camera's view plane so the inflated model appears *where the user drew it*. After
creation, paint, cut, and extrude strokes are captured on the **WebGL canvas** so the right mouse
button can reach `OrbitControls` while the left button draws. Only the silhouette phase uses the
interactive overlay.

`SceneView` maintains an `interactionMode` state machine — `silhouette`, `orbit` (View),
`paint`, `cut`, `extrude` — and routes pointer events accordingly. **Cut** is unified: a closed
stroke triggers a loop cut; an open stroke crossing the silhouette triggers a through-cut (§7.2,
§8). The active tool **persists** after paint, cut, extrude, undo, and redo (the UI does not
force a return to View).

### 6.1.1 Camera controls

**Right mouse always rotates** in every mode. Other bindings depend on context:

| Context | Rotate | Pan | Zoom |
|---------|--------|-----|------|
| View, cut review, extrude orient | Right-drag | Left-drag | Scroll |
| Paint / cut / extrude (drawing) | Right-drag | Middle-drag | Scroll |

Orbit damping is disabled so the camera stops immediately when the user releases the mouse.

### 6.1.2 Status feedback

Validation errors (stroke outside silhouette, failed cut, etc.) appear in a **bottom-left overlay**
on the canvas and **auto-dismiss after five seconds**. In production mode the dashed silhouette
guide is hidden; it is shown only when **Debug mode** is enabled, though paint/cut validation still
uses the computed outline.

### 6.2 Rendering setup

The scene uses a `MeshPhongMaterial` for the solid, an optional `WireframeGeometry` overlay, ambient
plus directional lighting, and a faint ground grid for spatial reference. A "Display" selector
toggles between solid, wireframe, and both. The mesh object carries the (1, −1, 1) scale described in
§4.3; the wireframe and any overlay geometry carry the same scale so they register exactly with the
solid.

### 6.3 Screen-to-surface projection

Every editing operation begins as a 2D screen stroke and must be lifted onto the 3D surface. This is
done by **raycasting**: for each densified stroke sample, a ray is built from the camera through the
sample's normalized device coordinates and intersected with a raycast proxy of the mesh.
`surfaceProjection.ts` provides the variants used throughout:

- `projectScreenStrokeFrontBackPaired` — aligned front/back hits for cut-through quads.
- `projectScreenStrokeWithNormals` — front-surface hits with face normals for surface paint.
- `validateClosedLoopOnSurface` — a lenient on-surface check that tolerates a loop bulging slightly
  past the silhouette (needed for loops drawn around corners).

Because raycasting must happen in render/world space, the raycast proxy is built to match the
displayed mesh exactly, including the y-flip scale.

---

## 7. Surface Editing I — Painting and Cutting

### 7.1 Surface painting (Teddy surface lines)

Paint mode projects 2D strokes onto the mesh front surface and renders them as **ribbon meshes**
lying in each sample's tangent plane — a thin layer of paint, not a volumetric tube and not a
per-triangle texture atlas (a texture-atlas approach was prototyped and abandoned because
resampling after topology edits was too slow).

**Projection (`surfaceProjection.ts`).** Each densified screen sample is raycast against the mesh.
The hit point is offset ~1 px along the **face normal** (toward the camera) for z-fighting relief,
not along the view ray, so ribbons stay flush on curved surfaces. Face normals are stored per
vertex for ribbon framing.

**Ribbon build (`surfaceLines.ts`).** At each sample, stroke tangent is projected onto the tangent
plane; lateral width follows `normal × tangent`, with brush diameter measured in screen pixels.
`MeshBasicMaterial` ribbons use `depthWrite: false` and stacked `renderOrder` so newer strokes
paint over older ones.

**Crossing strokes.** Before a new stroke is committed, existing strokes are **carved** under the
new brush corridor: each ribbon cross-section is clipped in screen space so cut edges follow the
crossing angle (a clean "X" rather than a rectangular notch). **Erase** reuses the same lateral
clip against a scribble path, trimming ribbons rather than deleting whole strokes.

**Persistence.** Painted lines live in `PaintedSurfaceLine` records (points, normals, color,
linewidth, optional per-vertex clip scales). They survive `setMesh` after cut and extrude and are
included in **undo/redo** snapshots (`editHistory.ts`). Paint must stay inside the view silhouette
(Teddy §5 validation via winding number).

### 7.2 Cutting (Teddy §5.4)

The cut tool slices the model with a stroke that crosses the silhouette twice (in one side, out the
other). The implementation (`meshCut.ts`, `cutPolygon.ts`) proceeds in two phases, mirroring the
paper:

1. **Remove a side.** The cutting stroke is projected to a front path and a back path, defining a
   cut surface through the solid. Triangles are partitioned by which side of the cut they fall on,
   and the side with fewer vertices is discarded, leaving an open hole.
2. **Cap the hole.** New triangles are generated between the front and back cut paths to seal the
   opening, yielding a closed mesh again.

The cut is validated before execution: the stroke must genuinely cross the rendered silhouette
boundary twice (`validateCutCrossesBoundary`), otherwise it is rejected. A view-dependent silhouette
is computed from the current camera (`renderSilhouette.ts` / `screenSilhouette.ts`) and refreshed as
the camera orbits, so the crossing test reflects exactly what the user sees.

In **production mode**, through-cuts apply immediately after the stroke; loop cuts run automatically
through imprint → remove → fill. In **debug mode**, both cut types can be stepped and discarded via
overlay controls.

---

## 8. Surface Editing II — Loop Cut and Imprinting

### 8.1 Motivation

The cut tool removes an entire side of the model. A more surgical operation is needed for the
extrusion feature and for removing localized bumps: the ability to draw a **closed loop on the
surface** and remove exactly the enclosed patch, leaving a hole whose boundary follows the drawn
loop precisely. This is the **loop cut**, implemented in `loopImprint.ts`.

### 8.2 The imprinting algorithm

Loop cut is staged into three inspectable phases so each can be verified independently: project the
loop, remove the enclosed triangles, and fill the hole. The geometric kernel, `imprintLoop`, works as
follows:

1. **Inside/outside classification.** Each mesh vertex is projected to screen space and tested
   against the drawn loop with a winding-number point-in-polygon test. This labels every vertex as
   inside or outside the loop.
2. **Edge splitting.** For every triangle that straddles the loop (some vertices in, some out), the
   exact crossing points where its edges cross the loop are found by **bisection** in screen space —
   bisection rather than linear interpolation because perspective makes the screen position a
   non-linear function of the edge parameter. A crossing vertex is inserted, and crucially it is
   **cached per original edge** so both triangles sharing that edge reference the *same* new vertex,
   keeping the mesh watertight.
3. **Re-triangulation.** Each straddling triangle is split: the outside portion (original outside
   vertices plus the two crossings) is fan-triangulated and kept; the inside portion is dropped.
   Triangles fully inside are removed; triangles fully outside are kept unchanged.
4. **Boundary extraction.** After removal, the open boundary loops are recovered by collecting edges
   used by exactly one face and chaining them into ordered vertex loops. The loop richest in
   inserted (crossing) vertices is treated as the primary opening — that is the imprinted loop the
   user drew.

The result is an `ExtrusionBase` describing the kept faces, the opening boundary (both as vertex
indices and as world-space positions, the "base ring"), and diagnostic counts.

### 8.3 Hole filling

To turn the cut into a finished, closed surface, `extrude.ts`'s `fillLoopHole` caps each opening.
Rather than a naive centroid fan (which overlaps or leaves slivers on concave openings), it projects
each boundary loop into its **best-fit plane** (area-weighted Newell normal) and triangulates it with
a **constrained Delaunay** triangulation, falling back to a fan only if the CDT degenerates. The new
cap faces are oriented outward using the solid's centroid as a reference.

### 8.4 The front/back classification problem

A persistent difficulty (discussed further in §12) is deciding *which* enclosed surface to remove
when the loop, projected onto screen, encloses both the near (visible) sheet and the far (occluded)
sheet behind it. The system must remove the near sheet the user is looking at and keep the far one.
Two strategies were explored — a per-ray occlusion test (compare each face's depth against the
near/far hit midpoint) and a face-orientation test (front-facing vs. back-facing normals). Each
handles a different family of loops well, and the trade-off between them is the subject of ongoing
refinement.

---

## 9. Surface Editing III — Extrusion

Extrusion (`extrude.ts`) is the most elaborate operation and the one most directly tied to §5.3 of
the paper. It is a two-stroke gesture: a closed loop on the surface (the base ring, imprinted as in
§8) followed by a stroke that defines the silhouette of the swept-out form.

### 9.1 Mapping to the paper's algorithm

The paper specifies four steps, and the implementation follows them directly:

1. **Find the projection plane.** A plane is constructed through the base ring's center of gravity,
   parallel to the ring's normal, oriented to face the camera as much as possible. The ring normal
   uses the signed-area formula from the paper's footnote 2; the plane normal is the view direction
   with its component along the ring normal removed.

```176:192:src/extrude.ts
  const G = centroid(ring0);

  // Ring normal via the signed-area formula in the paper's footnote 2.
  let N = ringNormal(ring0);
  if (N.lengthSq() < 1e-9) return { error: 'Base loop has no well-defined normal.' };
  N.normalize();

  // Orient the normal toward the camera so the extrusion grows outward (front-facing).
  const camPos = camera.getWorldPosition(new THREE.Vector3());
  const viewDir = camPos.clone().sub(G).normalize();
  if (N.dot(viewDir) < 0) N.negate();

  // Projection plane: through G, containing N, facing the camera as much as possible.
  let P = viewDir.clone().addScaledVector(N, -viewDir.dot(N));
  if (P.lengthSq() < 1e-9) P = perpendicular(N);
  P.normalize();
  const W = new THREE.Vector3().crossVectors(N, P).normalize();
```

2. **Project the stroke onto the plane.** View rays through the stroke samples are intersected with
   that plane to produce a 3D extruding stroke.

3. **Two-pointer rib sweep.** The paper places copies of the base ring along the stroke, kept
   roughly perpendicular to the extrusion direction and resized to fit the stroke width. This is done
   by walking two pointers inward from both ends of the stroke; at each step the algorithm advances
   whichever pointer keeps the connecting rib most perpendicular to the local stroke direction
   (the "goodness" score of fig. 18a). The midpoints of these ribs form the centerline and their
   lengths give the local width.

4. **Delete and sew.** The surface enclosed by the base ring is already removed (by imprinting), and
   consecutive ring copies are sewn into quads and triangulated, welding directly onto the opening.

### 9.2 Enhancements beyond the paper

The raw algorithm produces a faithful but rough sweep. Several refinements were added for quality:

- **Centerline resampling and smoothing.** The two-pointer medial profile is resampled to a modest,
  evenly spaced number of layers (kept deliberately sparse — a target of 14 layers, capped at 24 —
  so the rings are not overly dense) and lightly smoothed.
- **Rotation-minimizing frame.** Each ring's cross-section orientation is carried along the
  centerline with a quaternion that rotates the previous frame onto the new tangent, avoiding twist.
- **Anti-submerge miter clamp.** When the sweep bends, a tilted ring's vertices on the concave
  (inside) side of the bend tend to move *backward* relative to the previous ring and sink into it,
  creating surface wrinkles. To prevent this, every vertex is required to make a minimum forward
  progress along the local sweep direction; vertices that fall short are pushed forward, turning the
  fold into a smooth miter:

```294:295:src/extrude.ts
      const adv = world.clone().sub(prevWorld[j]).dot(tangents[i]);
      if (adv < minStep) world.addScaledVector(tangents[i], minStep - adv);
```

- **Base-doming blend.** The imprinted base rim is rarely perfectly planar; its out-of-plane height
  is blended into the first few swept layers and faded out, so the weld between the existing surface
  and the new sweep is smooth rather than creased — directly addressing the "insufficiently planar
  base" caveat noted in the paper.
- **Clean conical tip.** The ring radius follows the stroke's own width taper (which naturally
  narrows toward the tip as the two pointers converge), and the final layer collapses to a single
  apex placed a clear step ahead of the last ring along the curve, so the tip closes as a convex
  point with no recessed cavity.

Each of these was driven by a specific visual artifact observed during testing — wrinkles on bends,
a hollow near the tip, creasing at the base — and the comments in `extrude.ts` document the
reasoning so the trade-offs are not lost.

---

## 10. Non-Photorealistic "Pencil Sketch" Rendering

To evoke the look of the original Teddy demo — where shapes appear hand-drawn with stippled shading
and an inked outline — Tidy includes an optional **sketch shader**, toggled from the UI
(`sketchShader.ts`). It comprises two custom GLSL materials plus a per-frame uniform updater.

### 10.1 Stipple fill

The fill material renders the object as plain white "paper" and conveys shading entirely through
**screen-space stipple dots** whose size grows with darkness. Lighting is evaluated in view space
using Three.js's `normalMatrix` (which correctly accounts for the mesh's y-flip), and the resulting
tone drives a jittered dot pattern computed from `gl_FragCoord`. Because the pattern lives in screen
space (normalized by device pixel ratio), the dots stay a constant size as the camera orbits — like
ink on paper rather than a texture glued to the surface. A second finer dot layer fills in the
darkest regions for denser shadow.

A deliberate design choice is that the key light is fixed in **view space** (camera-relative),
coming from the upper-left-front. Because the user orbits the camera around a stationary object, a
world-fixed light would keep the same faces shaded regardless of viewpoint; a camera-relative light
instead makes the lit and shaded regions sweep across the surface as the user orbits, so the model
visibly catches light from different directions.

### 10.2 Silhouette outline

A dark contour is drawn with the classic **inverted-hull** technique: a back-face-only shell of the
same geometry, slightly inflated along its normals, rendered behind the mesh. It is visible only at
silhouette edges, producing a clean inked outline without any post-processing pass.

### 10.3 Integration and lifecycle

Toggling sketch mode swaps the mesh's Phong material for the stipple material, adds the outline
shell, hides the wireframe and grid, and switches the background to paper cream. Critically, the
original Phong material is **kept aside** (not disposed) so that toggling the mode off restores the
normal appearance exactly. The material lifecycle is handled carefully so that the shared sketch
materials and the outline's shared geometry are never disposed out from under one another when the
mesh is rebuilt by an editing operation.

---

## 11. Mesh Integrity, Winding, and Testing

### 11.1 Why winding matters

Under back-face culling, a triangle wound the wrong way becomes invisible from outside, appearing as
a hole. Across inflation (mirroring, stitching) and every editing operation (cutting, imprinting,
sweeping, capping), it is easy to introduce inconsistently wound faces. The project therefore treats
**consistent outward winding** as a first-class invariant and provides a dedicated module,
`meshWinding.ts`, with utilities to compute face normals, flip triangles, derive an interior
reference point, and enforce outward orientation relative to it.

### 11.2 The test suite

The automated tests focus on this invariant and on the cut logic:

- `meshWinding.test.ts` — verifies that interior faces point outward from the solid and that
  silhouette-adjacent faces on the top cap point upward (historically the most common hole source).
- `teddyInflation.test.ts` — exercises the inflation stages.
- `meshCut.test.ts` — checks cut behavior.

All 28 tests across three files pass (`npm test`). The suite is intentionally narrow but targets the
highest-risk area; the step-by-step pipeline visualization serves as the primary "test" for the more
visual aspects of inflation.

---

## 12. Engineering Challenges and Lessons Learned

The development history (visible in the commit log) reveals that the hardest problems were not the
textbook algorithms themselves but the **robustness of screen-to-surface editing** and the
**smoothness of generated geometry**. A few themes recurred:

**The y-flip is a sharp edge.** The (1, −1, 1) render scale means there is a constant translation
between mesh storage space and the world space the camera and rays live in. Several bugs traced back
to performing a projection or a raycast in the wrong space, or flipping y one too many or too few
times. The mitigation is to funnel every conversion through a small set of named helpers and to keep
the raycast proxy geometry built identically to the displayed mesh.

**Near-vs-far surface selection is genuinely ambiguous.** When a loop drawn on screen encloses both
the visible sheet and the sheet behind it, no single local test is perfect. An occlusion-based test
(per-face depth vs. the near/far midpoint) handles loops that wrap around a silhouette but fragments
on crumpled surfaces where a front face is locally occluded by a neighboring fold. A normal-based
front-facing test is stable on crumpled fronts but mis-handles loops that straddle the silhouette.
The lesson is that a robust solution likely needs to **combine** both signals rather than rely on
either alone — a known area for future work. During development this manifested as a cycle of
fixes and reverts, and the pragmatic resolution was to keep the variant that worked for the broadest
set of user gestures while documenting the trade-off.

**Sweeping a cross-section along a curve self-intersects on bends.** This is a classic problem: when
the path's radius of curvature is smaller than the cross-section's extent, consecutive rings overlap
on the concave side. The minimum-forward-progress clamp (§9.2) resolves the visible wrinkles by
converting the fold into a miter, without distorting the convex side or the overall silhouette.

**Tip and base artifacts come from over-correction.** Early attempts to clean up the noisy tip
(aggressive smoothing plus a forced radius collapse) introduced a *new* artifact — a pinched neck and
a hollow cavity — because two tapers compounded. The fix was to do *less*: trust the stroke's natural
width taper, smooth only lightly and only the width near the tip, and place the apex explicitly ahead
along the curve. "Smooth the symptom" can be worse than understanding the cause.

**Toggle/lifecycle correctness matters for UX.** The sketch shader initially failed to turn off
because the original material had been disposed when entering sketch mode. Treating UI toggles as
reversible state — keeping what you will need to restore — avoided a class of "stuck mode" bugs.

**Surface paint is a 2D carving problem on 3D ribbons.** Crossing strokes required clipping each
ribbon cross-section in screen space (not just deleting centerline samples), and keeping fully
clipped vertices so the mesh tapers through intersections. Lifting samples along the view ray rather
than the face normal made ribbons appear tilted off the surface; tangent-plane framing and
normal-aligned offset fixed that.

**Consistent camera controls reduce mode friction.** Extrude initially blocked rotation because
drawing used a pointer-blocking overlay and orbit controls were disabled during loop/curve phases.
Moving extrude strokes to the WebGL canvas and standardizing on right-drag rotate (left pan in View)
aligned behavior across tools.

---

## 13. Limitations and Future Work

- **Loop-cut near/far robustness.** As discussed, a combined occlusion + orientation classifier
  (front-facing as the primary test, with an occlusion check used only to keep the far sheet when a
  loop straddles the silhouette) would unify the two regimes and is the highest-value next step.
- **Self-intersecting strokes.** Both creation and editing assume simple polygons; figure-eight and
  other self-crossing inputs are rejected rather than handled.
- **Undo depth.** Undo/redo covers mesh geometry and surface paint after inflation, but not
  pre-inflation debug stepping; **Clear** still resets the entire session.
- **Smoothing and bending gestures.** The paper defines additional editing operations (smoothing a
  region, bending along a stroke) that are not yet implemented.
- **Performance on large meshes.** Several operations are O(n) per stroke sample with per-face
  raycasts; very dense meshes would benefit from spatial acceleration structures.
- **Export.** There is currently no mesh export (OBJ/GLTF); adding one would make Tidy useful as a
  front end to other tools.
- **Bundle size.** The production bundle exceeds the 500 kB warning threshold (dominated by
  Three.js); code-splitting could improve initial load.

---

## 14. Conclusion

Tidy demonstrates that the expressive, low-friction modeling paradigm introduced by Teddy in 1999
maps naturally onto today's web platform. With nothing more than a browser, a user can sketch a
closed outline and immediately obtain a rounded, watertight 3D solid, then refine it through
intuitive stroke gestures — painting it, cutting it, punching holes, and extruding new limbs —
with undo/redo for safe iteration, and finally view it in a stylized hand-drawn aesthetic that pays
homage to the original system.

The project's value lies as much in its engineering discipline as in its features: a minimal mesh
interchange type, a clean split between pure geometry and rendering, a centralized coordinate
convention, staged and inspectable pipelines, and a focused test suite around the riskiest
invariant. The most instructive challenges — surface-edit robustness, sweep self-intersection, and
tip/base smoothness — were resolved not by more elaborate machinery but by understanding the
underlying geometry and applying the smallest correct intervention. Those lessons, and the
documented trade-offs that remain open, form a solid foundation for the future work outlined above.

---

## 15. References and Appendix

### References

1. T. Igarashi, S. Matsuoka, H. Tanaka. *Teddy: A Sketching Interface for 3D Freeform Design.*
   SIGGRAPH 1999. https://www-ui.is.s.u-tokyo.ac.jp/~takeo/papers/siggraph99.pdf
2. Original Teddy project page. http://www-ui.is.s.u-tokyo.ac.jp/~takeo/teddy/teddy.htm
3. Three.js. https://threejs.org
4. `cdt2d` — constrained Delaunay triangulation. https://www.npmjs.com/package/cdt2d

### Appendix A — Module reference

| Module | Lines | Responsibility |
|--------|------:|----------------|
| `teddyInflation.ts` | 2,767 | Inflation: pruning, spine, elevation, back face, rim |
| `sceneView.ts` | 2,717 | Three.js scene, interaction modes, paint ribbons, orchestration |
| `main.ts` | 1,524 | DOM wiring, presets, edit history, debug stepping, status |
| `meshCut.ts` | 888 | Teddy §5.4 through-cut (remove side, cap hole) |
| `extrude.ts` | 583 | §5.3 extrusion sweep + hole fill |
| `meshWinding.ts` | 572 | Outward-winding enforcement utilities |
| `loopImprint.ts` | 637 | Imprint closed loop, remove enclosed surface |
| `surfaceProjection.ts` | 465 | Raycast strokes, normals, surface-aligned paint lift |
| `surfaceLines.ts` | 430 | Surface paint ribbons, carve, erase, validation |
| `screenSilhouette.ts` | 362 | Mesh-vertex-to-screen projection, silhouette |
| `teddyPipeline.ts` | 356 | Stage orchestration, intermediate meshes |
| `renderSilhouette.ts` | 272 | View-dependent silhouette from render |
| `cutPolygon.ts` | 267 | Cut-stroke / silhouette crossing validation |
| `sketchShader.ts` | 144 | Stipple fill + inverted-hull outline materials |
| `editHistory.ts` | 77 | Undo/redo snapshots (mesh + surface lines) |
| `stroke.ts` | 109 | Close, resample, self-intersection |
| `math.ts` | 80 | Vector math, winding-number test |
| `cdt.ts` | 73 | CDT wrapper + T/S/J classification |
| `teddy.ts` | 58 | Public facade |
| *(tests)* | ≈1,200 | `meshWinding`, `meshCut`, `teddyInflation` (28 tests) |

### Appendix B — Build and run

```bash
npm install     # install dependencies
npm run dev     # start the Vite dev server (http://localhost:5173)
npm run build   # type-check and produce a static build in dist/
npm run preview # serve the production build locally
npm test        # run the Vitest suite (28 tests)
```

### Appendix C — User workflow at a glance

1. Draw a closed shape (freehand or preset); release to inflate it into a 3D solid.
2. **View** — right-drag rotate, left-drag pan, scroll zoom; **Top view** resets the camera.
3. **Paint** — draw/erase surface strokes; **Cut** — open stroke (through-cut) or closed loop
   (loop cut); **Extrude** — base loop, orient, then sweeping stroke.
4. **Undo / redo** (toolbar or ⌘Z / ⌘⇧Z) for mesh and paint; tools stay active after each operation.
5. Toggle **Sketch** for stippled hand-drawn rendering; **Display** for solid/wireframe/both.
6. **Clear** to start a new shape. Enable **Debug mode** to step through inflation or staged cuts.

---

*End of report.*
