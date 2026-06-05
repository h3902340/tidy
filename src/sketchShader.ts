/**
 * Hand-drawn "pencil sketch" look from the Teddy demo (Igarashi et al., SIGGRAPH 1999):
 *  - a paper-coloured fill,
 *  - shadows rendered as screen-space stipple dots (denser/larger where it is darker), and
 *  - a dark silhouette outline drawn with an inverted-hull shell.
 *
 * The stipple is computed in screen space so the dot size stays constant as the camera orbits
 * (like ink on paper rather than a texture glued to the surface). Lighting is evaluated in view
 * space using THREE's `normalMatrix`, so the mesh's (1, -1, 1) render flip is handled correctly.
 */
import * as THREE from 'three';

/**
 * Key-light direction in *view space* (camera-relative), pointing toward the light. Keeping the
 * light fixed to the camera — coming from the upper-left-front — means that as you orbit the
 * stationary object the lit and shaded sides sweep across the surface, so you see it lit from
 * different directions. (A world-fixed light would keep the same faces shaded while orbiting.)
 */
const LIGHT_VIEW_DIR = new THREE.Vector3(-0.4, 0.5, 0.78).normalize();

export interface SketchMaterials {
  fill: THREE.ShaderMaterial;
  outline: THREE.ShaderMaterial;
  /** Per-frame uniform update (pixel ratio for the screen-space stipple). Call before render. */
  update: (camera: THREE.Camera, renderer: THREE.WebGLRenderer) => void;
}

const fillVertex = /* glsl */ `
  varying vec3 vViewNormal;
  varying vec2 vUv;
  void main() {
    vViewNormal = normalize(normalMatrix * normal);
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fillFragment = /* glsl */ `
  precision highp float;

  uniform vec3 uPaper;        // fallback fill colour (lit paper)
  uniform vec3 uInk;          // stipple / shadow ink colour
  uniform vec3 uLightDir;     // view-space direction toward the light
  uniform float uAmbient;     // ambient floor [0..1]
  uniform float uDotScale;    // dot cell size, in CSS pixels
  uniform float uPixelRatio;  // device pixel ratio
  uniform sampler2D uColorMap; // baked surface colour (painted texture)
  uniform float uHasColorMap;  // 1 when uColorMap is the surface texture

  varying vec3 vViewNormal;
  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  // One layer of jittered dots. Returns ink coverage [0..1]; dot radius grows with tone.
  float stippleLayer(vec2 px, float tone, float cell, vec2 seed) {
    vec2 id = floor(px / cell) + seed;
    vec2 local = fract(px / cell) - 0.5;
    vec2 jit = (vec2(hash(id), hash(id + 17.3)) - 0.5) * 0.55;
    float d = length(local - jit);
    float r = 0.52 * sqrt(tone);   // 0 when lit, ~0.52 cell when fully dark
    float aa = 0.09;
    return 1.0 - smoothstep(r - aa, r + aa, d);
  }

  void main() {
    vec3 N = normalize(vViewNormal);
    if (!gl_FrontFacing) N = -N;             // mesh is rendered double-sided

    float diff = max(dot(N, normalize(uLightDir)), 0.0);
    float light = clamp(uAmbient + (1.0 - uAmbient) * diff, 0.0, 1.0);
    float tone = pow(clamp(1.0 - light, 0.0, 1.0), 0.85); // desired ink coverage

    vec2 px = gl_FragCoord.xy / max(uPixelRatio, 0.001);

    float ink = 0.0;
    if (tone > 0.04) {
      ink = stippleLayer(px, tone, uDotScale, vec2(0.0));
      // A finer, offset layer fills in the darkest regions for a denser shadow.
      if (tone > 0.5) {
        float t2 = (tone - 0.5) * 2.0;
        ink = max(ink, stippleLayer(px, t2, uDotScale * 0.62, vec2(31.7, 11.3)));
      }
    }

    // Paper tone reflects the greyscale of the surface colour: a white surface stays white paper,
    // while painted (coloured) areas read as the corresponding grey value under the pencil shading.
    vec3 paper = uPaper;
    if (uHasColorMap > 0.5) {
      vec3 surf = texture2D(uColorMap, vUv).rgb;
      float lum = dot(surf, vec3(0.299, 0.587, 0.114));
      paper = vec3(lum);
    }

    vec3 col = mix(paper, uInk, ink);
    gl_FragColor = vec4(col, 1.0);
  }
`;

const outlineVertex = /* glsl */ `
  uniform float uOutline; // shell thickness in view-space units
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    mv.xyz += n * uOutline;
    gl_Position = projectionMatrix * mv;
  }
`;

const outlineFragment = /* glsl */ `
  precision highp float;
  uniform vec3 uInk;
  void main() {
    gl_FragColor = vec4(uInk, 1.0);
  }
`;

export const PAPER_COLOR = 0xf4f1e6;
const INK_COLOR = 0x2b2a26;

/** Build the sketch fill + outline materials and an updater for their per-frame uniforms. */
export function createSketchMaterials(fillColor = PAPER_COLOR): SketchMaterials {
  const ink = new THREE.Color(INK_COLOR);

  // 1x1 white texture so the sampler is always bound even before a surface texture is supplied.
  const whiteTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  whiteTex.needsUpdate = true;

  const fill = new THREE.ShaderMaterial({
    uniforms: {
      uPaper: { value: new THREE.Color(fillColor) },
      uInk: { value: ink.clone() },
      uLightDir: { value: LIGHT_VIEW_DIR.clone() },
      uAmbient: { value: 0.4 },
      uDotScale: { value: 5.5 },
      uPixelRatio: { value: 1 },
      uColorMap: { value: whiteTex },
      uHasColorMap: { value: 0 },
    },
    vertexShader: fillVertex,
    fragmentShader: fillFragment,
    side: THREE.DoubleSide,
  });

  const outline = new THREE.ShaderMaterial({
    uniforms: {
      uInk: { value: ink.clone() },
      uOutline: { value: 1.6 },
    },
    vertexShader: outlineVertex,
    fragmentShader: outlineFragment,
    side: THREE.BackSide,
  });

  // The light is fixed in view space (set once above), so `update` only needs the pixel ratio,
  // which the screen-space stipple uses to keep the dots a constant size across DPRs.
  const update = (_camera: THREE.Camera, renderer: THREE.WebGLRenderer): void => {
    fill.uniforms.uPixelRatio.value = renderer.getPixelRatio();
  };

  return { fill, outline, update };
}
