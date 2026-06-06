# Tidy LaTeX Report (Overleaf)

Thesis-style technical report (~10 pages) for the **Tidy** web application.

**Author:** Jia-Ho Jian

## Import into Overleaf

1. In Overleaf, choose **New Project → Upload Project**.
2. Zip this `report/` folder (all files below) and upload the archive,  
   **or** upload these files manually keeping the same structure:

```
report/
  main.tex              ← set as main document
  references.bib
  figures/
    tidy-overview.png   ← introduction screenshot
  sections/
    abstract.tex
    introduction.tex
    background.tex
    functionality.tex
    algorithms.tex
    implementation.tex
    future_work.tex
    conclusion.tex
  README.md
```

3. Set the compiler to **pdfLaTeX**.
4. Recompile; run **BibTeX** if citations show as `(?)` (Overleaf usually does this automatically on Recompile).

## Local build (optional)

```bash
cd report
pdflatex main.tex
bibtex main
pdflatex main.tex
pdflatex main.tex
```

Requires a TeX distribution (MacTeX, TeX Live, etc.).

## Contents

| Section | Topic |
|---------|--------|
| Abstract | Summary of Tidy and contributions |
| Introduction | Motivation and scope |
| Background | Teddy (SIGGRAPH 1999) and related methods |
| Functionality | User-facing features |
| Algorithms | Inflation, cut, loop cut, extrude, paint |
| Implementation | Stack, architecture, testing |
| Future work | Spine smoothness, hole filling, extrusion, genus-0, animation |
| Conclusion | Summary |
| References | Bibliography (`references.bib`) |

## Primary reference

Igarashi, Matsuoka & Tanaka, *Teddy: A Sketching Interface for 3D Freeform Design*, SIGGRAPH 1999.

Additional citations: Delaunay triangulation, Shewchuk (CDT), Newell (plane fitting), Liepa/Botsch (hole filling), Blum (medial axis), Lewis et al. (pose-space deformation for future animation), Three.js, cdt2d.
