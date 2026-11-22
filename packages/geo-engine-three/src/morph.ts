import type { Material, ShaderMaterial } from "three";
import type { LineMaterial } from "three/addons/lines/LineMaterial.js";

/**
 * 球面 ↔ 平面 变形。
 *
 * 场景世界坐标以"锚点在地球表面的切点"为原点:+X 向东、-Z 向北、+Y 沿法线向上,地球球心在 (0, -R, 0)。
 * 平面内容使用以锚点为中心的方位等距投影(每弧度 R 个单位),所以平面上到原点的距离 d 恰好等于球面弧长 R·θ。
 * 因此"把平面卷回球面"有解析式:沿同方向在球面上走 d/R 弧度,高度 h 变为离球面 h。
 * 顶点着色器中: worldPos = mix(curved(worldPos), worldPos, uMorph),uMorph=1 为平面、0 为贴合球面。
 */
export interface MorphUniforms {
  uMorph: { value: number };
  uGlobeRadius: { value: number };
}

export function createMorphUniforms(radius: number, morph = 1): MorphUniforms {
  return { uMorph: { value: morph }, uGlobeRadius: { value: radius } };
}

export const MORPH_GLSL = /* glsl */ `
uniform float uMorph;
uniform float uGlobeRadius;
vec3 geoMorph(vec3 p) {
  if (uMorph >= 0.9999) return p;
  float d = length(p.xz);
  vec2 dir = d > 1e-9 ? p.xz / d : vec2(0.0);
  float a = d / uGlobeRadius;
  float r = uGlobeRadius + p.y;
  vec3 curved = vec3(dir.x * sin(a) * r, r * cos(a) - uGlobeRadius, dir.y * sin(a) * r);
  return mix(curved, p, uMorph);
}
`;

const PROJECT_MORPH = /* glsl */ `
vec4 geoWorld = modelMatrix * vec4( transformed, 1.0 );
geoWorld.xyz = geoMorph( geoWorld.xyz );
vec4 mvPosition = viewMatrix * geoWorld;
gl_Position = projectionMatrix * mvPosition;
`;

/** 为内置材质(MeshBasicMaterial 等)注入变形。 */
export function applyMorph<T extends Material>(material: T, uniforms: MorphUniforms): T {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${MORPH_GLSL}`)
      .replace("#include <project_vertex>", PROJECT_MORPH);
  };
  material.customProgramCacheKey = () => "geo-morph";
  return material;
}

/** 为粗线材质(Line2)注入变形:线段端点先变形再进入屏幕空间加宽。 */
export function applyLineMorph(material: LineMaterial, uniforms: MorphUniforms): LineMaterial {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${MORPH_GLSL}`)
      .replace(
        "vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );",
        "vec4 start = viewMatrix * vec4( geoMorph( ( modelMatrix * vec4( instanceStart, 1.0 ) ).xyz ), 1.0 );",
      )
      .replace(
        "vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );",
        "vec4 end = viewMatrix * vec4( geoMorph( ( modelMatrix * vec4( instanceEnd, 1.0 ) ).xyz ), 1.0 );",
      );
  };
  material.customProgramCacheKey = () => "geo-morph-line";
  return material;
}

/** 自定义 ShaderMaterial(侧壁渐变)直接在源码中使用 MORPH_GLSL;这里只合并 uniforms。 */
export function bindMorphUniforms(material: ShaderMaterial, uniforms: MorphUniforms): ShaderMaterial {
  Object.assign(material.uniforms, uniforms);
  return material;
}
