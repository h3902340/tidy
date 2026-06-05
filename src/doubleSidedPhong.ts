import * as THREE from 'three';

const PROGRAM_CACHE_KEY = 'doubleSidedPhongLighting';

/** Match sceneView / SurfacePainter — both sides visible, consistent lighting. */
export const DOUBLE_SIDED = THREE.DoubleSide;

const NORMAL_FLIP = `if ( ! gl_FrontFacing ) {
  normal = -normal;
}`;

function patchFragmentShader(fragmentShader: string): string {
  if (fragmentShader.includes('gl_FrontFacing ) {\n  normal = -normal')) {
    return fragmentShader;
  }

  for (const marker of [
    '#include <normal_fragment_begin>',
    '#include <normal_fragment_maps>',
  ]) {
    if (fragmentShader.includes(marker)) {
      return fragmentShader.replace(marker, `${marker}\n${NORMAL_FLIP}`);
    }
  }

  return fragmentShader.replace(
    /vec3 normal = normalize\( vNormal \);/,
    `vec3 normal = normalize( vNormal );
${NORMAL_FLIP}`
  );
}

/** Flip shaded normals on back faces so double-sided triangles match front-face lighting. */
export function applyDoubleSidedLightingFix(material: THREE.MeshPhongMaterial): void {
  const prior = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prior?.(shader, renderer);
    shader.fragmentShader = patchFragmentShader(shader.fragmentShader);
  };
  material.customProgramCacheKey = () => PROGRAM_CACHE_KEY;
}

export function createDoubleSidedPhongMaterial(
  params: THREE.MeshPhongMaterialParameters = {}
): THREE.MeshPhongMaterial {
  const material = new THREE.MeshPhongMaterial({
    ...params,
    side: DOUBLE_SIDED,
  });
  applyDoubleSidedLightingFix(material);
  return material;
}
