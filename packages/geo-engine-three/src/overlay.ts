import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { LayerSpec, Position, Region } from "@yaoyu/geo-engine";
import type { SceneTheme } from "./theme";

export type OverlayMode = "plane" | "globe";

/**
 * 叠加图层的运行上下文。插件只通过它与场景交互,同一份插件代码可同时用于平面与地球:
 * - 平面:group 为当前层级的地图坐标(x 东、y 北、z 上),position 落在板块顶面;
 * - 地球:group 为球体局部坐标(球心为原点),position 落在球面,up 为法线。
 */
export interface OverlayContext {
  mode: OverlayMode;
  /** 插件对象挂载点;插件 dispose 时需自行移除并释放。 */
  group: THREE.Group;
  theme: SceneTheme;
  /** 特征长度:平面为当前层级外形半径,地球为球半径。用于按比例确定尺寸。 */
  scale: number;
  /** 板块基准高度(平面)/ 球面 2% 半径(地球)。 */
  unitHeight: number;
  /** 地表位置(平面:所在板块顶面;地球:球面),再沿 up 方向抬高 height。 */
  position(p: Position, height?: number): THREE.Vector3;
  /** 该点的"向上"方向(平面恒为 +z,地球为法线)。 */
  up(p: Position): THREE.Vector3;
  /** 点是否落在当前显示的区域内(地球恒为 true)。 */
  contains(p: Position): boolean;
  /** 平面坐标(仅平面模式)。 */
  planeXY(p: Position): [number, number] | null;
  /** 当前层级平面范围(仅平面模式)。 */
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** 当前板块的最高顶面 z(仅平面模式,地球为 0)。 */
  maxSurface: number;
  /** 板块底面 z(仅平面模式,地球为 0)。 */
  baseHeight: number;
  /** 平面坐标 → 经纬度(仅平面模式)。 */
  unproject(x: number, y: number): Position | null;
  /** 场景相机(按视野选取瓦片等需要)。插件不应修改它。 */
  camera(): THREE.PerspectiveCamera;
  /** 按 id 查找区域(用于以区域锚点定位的数据)。 */
  region(id: string): Region | undefined;
  /** 画布像素尺寸(粗线宽度等需要)。 */
  resolution(): { width: number; height: number };
  /** 创建一个跟随 3D 位置的文字标签。 */
  label(text: string, style?: Partial<CSSStyleDeclaration>): CSS2DObject;
}

export interface OverlayInstance {
  /** 同一图层数据更新;返回 false(或未实现)时场景会销毁后重建。 */
  update?(spec: LayerSpec): boolean;
  /** 每帧调用:t 为场景启动以来秒数,dt 为帧间隔秒数。 */
  tick?(t: number, dt: number): void;
  /** 整体透明度(转场淡入淡出)。 */
  setOpacity?(k: number): void;
  dispose(): void;
}

/** 叠加图层插件:按 LayerSpec.type 匹配,声明支持的模式。 */
export interface OverlayPlugin<TData = unknown> {
  type: string;
  modes: OverlayMode[];
  /** 镜头拉近时是否随 overlayZoomFade 淡出(缺省 true);底图等背景类图层应设为 false。 */
  zoomFade?: boolean;
  create(ctx: OverlayContext, spec: LayerSpec<TData>): OverlayInstance;
}

export function defineOverlay<TData>(plugin: OverlayPlugin<TData>): OverlayPlugin<TData> {
  return plugin;
}

// ── 插件共用工具 ──────────────────────────────────────────────────────────

/** 自定义着色器需要的对数深度缓冲片段(场景开启了 logarithmicDepthBuffer)。 */
export const LOGDEPTH = {
  vertexPars: "#include <common>\n#include <logdepthbuf_pars_vertex>",
  vertex: "#include <logdepthbuf_vertex>",
  fragmentPars: "#include <logdepthbuf_pars_fragment>",
  fragment: "#include <logdepthbuf_fragment>",
};

export function makeLabel(theme: SceneTheme, text: string, style: Partial<CSSStyleDeclaration> = {}): CSS2DObject {
  const outer = document.createElement("div");
  const inner = document.createElement("div");
  inner.textContent = text;
  Object.assign(inner.style, {
    fontFamily: theme.fontFamily,
    color: theme.label,
    fontSize: "15px",
    fontWeight: "800",
    whiteSpace: "nowrap",
    textShadow: `0 0 4px ${theme.labelShadow}, 0 0 10px ${theme.labelShadow}`,
    ...style,
  });
  outer.append(inner);
  outer.style.pointerEvents = "none";
  return new CSS2DObject(outer);
}

/** 让对象的局部 +Z 轴对齐到 up 方向。 */
export function alignToUp(object: THREE.Object3D, up: THREE.Vector3): void {
  object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), up.clone().normalize());
}

export function disposeTree(object: THREE.Object3D): void {
  object.removeFromParent();
  object.traverse((o) => {
    if (o instanceof CSS2DObject) o.element.remove();
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const mats = mesh.material;
    if (mats) for (const m of [mats].flat()) m.dispose();
  });
}

/** 把一组材质的透明度按各自初始值等比缩放(ShaderMaterial 使用 uOpacity)。 */
export function scaleOpacity(object: THREE.Object3D, k: number): void {
  object.traverse((o) => {
    if (o instanceof CSS2DObject) {
      o.element.style.opacity = String(k);
      return;
    }
    const mats = (o as THREE.Mesh).material;
    if (!mats) return;
    for (const m of [mats].flat()) {
      if (m instanceof THREE.ShaderMaterial && m.uniforms.uOpacity) {
        m.userData.baseOpacity ??= m.uniforms.uOpacity.value;
        m.uniforms.uOpacity.value = m.userData.baseOpacity * k;
      } else {
        m.userData.baseOpacity ??= m.opacity;
        m.opacity = m.userData.baseOpacity * k;
      }
    }
  });
}
