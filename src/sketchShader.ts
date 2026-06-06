/**
 * Hand-drawn "pencil sketch" look from the Teddy demo (Igarashi et al., SIGGRAPH 1999):
 *  - a paper-coloured fill,
 *  - shadows rendered as screen-space stipple dots (denser/larger where it is darker), and
 *  - a dark silhouette outline drawn with an inverted-hull shell.
 *
 * The stipple is computed in screen space so the dot size stays constant as the camera orbits
 * (like ink on paper rather than a texture glued to the surface). Lighting is evaluated in view
 * space with Blinn–Phong shading (matching the solid MeshPhongMaterial); back-face normals are
 * flipped so double-sided triangles shade consistently.
 */
import * as THREE from 'three';

/**
 * Key-light direction in *view space* (camera-relative), pointing toward the light. Keeping the
 * light fixed to the camera — coming from the upper-left-front — means that as you orbit the
 * stationary object the lit and shaded sides sweep across the surface, so you see it lit from
 * different directions. (A world-fixed light would keep the same faces shaded while orbiting.)
 */
/** View-space direction toward the key light (shared with solid Phong shading). */
export const LIGHT_VIEW_DIR = new THREE.Vector3(-0.4, 0.5, 0.78).normalize();

export interface SketchMaterials {
  fill: THREE.ShaderMaterial;
  outline: THREE.ShaderMaterial;
  /** Per-frame uniform update (pixel ratio for the screen-space stipple). Call before render. */
  update: (camera: THREE.Camera, renderer: THREE.WebGLRenderer) => void;
}

const fillVertex = /* glsl */ `
  varying vec3 vViewPos;
  varying vec3 vViewNormal;
  varying vec2 vUv;
  void main() {
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vViewPos = mvPos.xyz;
    vViewNormal = normalize(normalMatrix * normal);
    vUv = uv;
    gl_Position = projectionMatrix * mvPos;
  }
`;

const fillFragment = /* glsl */ `
  precision highp float;

  uniform vec3 uPaper;        // fallback fill colour (lit paper)
  uniform vec3 uInk;          // reserved (legacy); shadows keep hue via darkening
  uniform vec3 uSolidColor;   // per-mesh paint colour (surface ribbons)
  uniform float uUseSolidColor; // 1 when uSolidColor drives the base tone
  uniform vec3 uLightDir;     // view-space direction toward the light
  uniform float uAmbient;     // scene ambient weight (matches AmbientLight intensity)
  uniform float uDiffuse;     // directional diffuse weight (matches DirectionalLight intensity)
  uniform float uSpecular;      // specular reflectance (MeshPhong default ~0x111111)
  uniform float uShininess;     // Phong shininess exponent
  uniform float uDotScale;    // dot cell size, in CSS pixels
  uniform float uPixelRatio;  // device pixel ratio
  uniform sampler2D uColorMap; // baked surface colour (painted texture)
  uniform float uHasColorMap;  // 1 when uColorMap is the surface texture

  varying vec3 vViewPos;
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
    if (!gl_FrontFacing) N = -N;

    vec3 L = normalize(uLightDir);
    vec3 V = normalize(-vViewPos);
    vec3 H = normalize(L + V);

    float diff = max(dot(N, L), 0.0);
    float spec = pow(max(dot(N, H), 0.0), uShininess);

    // Base tone: paper, baked texture, or a solid paint colour (surface ribbons).
    vec3 paper = uPaper;
    if (uHasColorMap > 0.5) {
      paper = texture2D(uColorMap, vUv).rgb;
    } else if (uUseSolidColor > 0.5) {
      paper = uSolidColor;
    }

    // Blinn–Phong shading (same light weights as sceneView solid MeshPhongMaterial).
    vec3 ambient = uAmbient * paper;
    vec3 diffuse = uDiffuse * diff * paper;
    vec3 specular = uSpecular * spec * vec3(1.0);
    vec3 lit = ambient + diffuse + specular;

    float bright = dot(lit, vec3(0.299, 0.587, 0.114));
    float litRef =
      dot(paper, vec3(0.299, 0.587, 0.114)) * (uAmbient + uDiffuse) + uSpecular;
    float tone = pow(clamp(1.0 - bright / max(litRef, 0.001), 0.0, 1.0), 0.85);

    vec2 px = gl_FragCoord.xy / max(uPixelRatio, 0.001);

    float ink = 0.0;
    if (tone > 0.04) {
      ink = stippleLayer(px, tone, uDotScale, vec2(0.0));
      if (tone > 0.5) {
        float t2 = (tone - 0.5) * 2.0;
        ink = max(ink, stippleLayer(px, t2, uDotScale * 0.62, vec2(31.7, 11.3)));
      }
    }

    vec3 shadow = lit * 0.38;
    vec3 col = mix(lit, shadow, ink);
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
      uSolidColor: { value: new THREE.Color(0xffffff) },
      uUseSolidColor: { value: 0 },
      uLightDir: { value: LIGHT_VIEW_DIR.clone() },
      uAmbient: { value: 0.85 },
      uDiffuse: { value: 0.45 },
      uSpecular: { value: 17 / 255 },
      uShininess: { value: 30 },
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

  const update = (_camera: THREE.Camera, renderer: THREE.WebGLRenderer): void => {
    fill.uniforms.uPixelRatio.value = renderer.getPixelRatio();
  };

  return { fill, outline, update };
}

/** Sketch fill for a surface paint ribbon in a single colour. */
export function createColoredSketchFillMaterial(
  template: THREE.ShaderMaterial,
  color: number
): THREE.ShaderMaterial {
  const mat = template.clone();
  mat.uniforms = THREE.UniformsUtils.clone(template.uniforms);
  (mat.uniforms.uSolidColor.value as THREE.Color).setHex(color);
  mat.uniforms.uUseSolidColor.value = 1;
  mat.uniforms.uHasColorMap.value = 0;
  mat.depthTest = true;
  mat.depthWrite = false;
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -1;
  mat.polygonOffsetUnits = -1;
  return mat;
}

/** Keep screen-space stipple dot size consistent (call each frame before render). */
export function updateSketchFillPixelRatio(
  material: THREE.ShaderMaterial,
  renderer: THREE.WebGLRenderer
): void {
  material.uniforms.uPixelRatio.value = renderer.getPixelRatio();
}

