import * as THREE from "three";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import {
  angularDistance,
  cameraDistance,
  outerOutline,
  classify,
  easeInOutCubic,
  greatCircle,
  pointInMultiPolygon,
  type ClassifyMethod,
  type EngineFrame,
  type GeoEngine,
  type LayerSpec,
  type Position,
  type Region,
  type SceneAdapter,
  type Unsubscribe,
} from "@yaoyu/geo-engine";
import { Animator, easeOutBack, easeOutCubic } from "./animator";
import { GlobeLayer, type GlobeOptions } from "./globe";
import { applyLineMorph, applyMorph, bindMorphUniforms, createMorphUniforms, MORPH_GLSL, type MorphUniforms } from "./morph";
import { createPlaneMapper, linePositions, outlinePositions, plateGeometry, regionShapes, type PlaneMapper } from "./shapes";
import { createTheme, mixColor, type SceneTheme } from "./theme";
import { makeLabel, type OverlayContext, type OverlayInstance, type OverlayMode, type OverlayPlugin } from "./overlay";
import { flowLayer } from "./effects/flow";
import { barLayer } from "./effects/bar";
import { heatLayer } from "./effects/heat";
import { rippleLayer } from "./effects/ripple";
import { clusterLayer } from "./effects/cluster";
import { basemapLayer } from "./effects/basemap";

/** 内置效果插件:飞线、柱体、热力、涟漪、聚合、瓦片底图。 */
export const BUILTIN_OVERLAYS: OverlayPlugin[] = [flowLayer, barLayer, heatLayer, rippleLayer, clusterLayer, basemapLayer] as OverlayPlugin[];

// ── 图层数据约定(LayerSpec.data) ─────────────────────────────────────────

/** type: "choropleth" —— 板块填色 / 挤出。 */
export interface ChoroplethLayerData {
  /** 区域 id → 数值。 */
  values: Record<string, number>;
  unit?: string;
  /** 分级方式;缺省时 ≥5 个值用分位数(拉开色差),否则线性。 */
  method?: ClassifyMethod;
  /** 板块高度随数值变化(默认 true)。 */
  extrudeByValue?: boolean;
}

/** type: "label" —— 区域名称(及数值)标签。 */
export interface LabelLayerData {
  showValue?: boolean;
  format?: (value: number, unit?: string) => string;
}

export interface PointDatum {
  id: string;
  name: string;
  position: Position;
  /** 点位旁的文字(如"总部 · 华东区");缺省不显示。 */
  label?: string;
  color?: string;
}

/** type: "point" —— 点位(企业、基地、门店)。平面场景只显示落在当前板块内的点。 */
export interface PointLayerData {
  points: PointDatum[];
}

/** type: "line" —— 线状装饰(如南海九段线),画在当前底板上。 */
export interface LineLayerData {
  lines: Position[][];
  color?: string;
  width?: number;
}

export interface GeoSceneOptions {
  container: HTMLElement;
  engine: GeoEngine;
  theme?: Partial<SceneTheme>;
  /** 启用地球(全球层级显示为可旋转、可下钻的地球)。不启用时所有层级都按平面处理。 */
  globe?: GlobeOptions | false;
  /** 相机俯仰:与竖直方向夹角(度),0 为正俯视。默认 38。 */
  pitchDeg?: number;
  fovDeg?: number;
  /** 视口留白系数,默认 1.08。 */
  padding?: number;
  bloom?: boolean;
  /** 下钻转场时长(毫秒);地球 ↔ 平面转场约为其 1.9 倍。 */
  transitionMs?: number;
  /** 底部装饰(网格 + 扫描环)。 */
  decor?: boolean;
  /** 设备像素比上限,默认 2。 */
  maxPixelRatio?: number;
  /** 额外的叠加图层插件(与内置插件同 type 时覆盖内置)。 */
  overlays?: OverlayPlugin[];
  /**
   * 叠加效果按镜头远近淡出:效果按所在层级的尺寸绘制,镜头比该层级默认视距近很多时(如地球上的飞线在下钻途中)
   * 会被放大成满屏光斑。[完全显示, 完全隐藏] 为 "当前视距 / 默认视距" 的阈值,默认 [0.45, 0.2];false 关闭。
   */
  overlayZoomFade?: [number, number] | false;
  /** 平面场景单击空白处的行为:"drill-up" 上卷一级;默认 "none"(仅双击空白 / 右键上卷)。 */
  emptyClick?: "none" | "drill-up";
  /** 平面视口四周留白(CSS 像素),用于全屏底图四周存在浮层 HUD 时让 3D 板块居中适配中央可见窗口。 */
  viewportInset?: ViewportInset;
  /** 点击 3D 点位(球茎 / 球头或地球表面点位)时的回调。 */
  onPointClick?: (point: PointDatum) => void;
  /** 悬停 / 离开 3D 点位时的回调。 */
  onPointHover?: (point: PointDatum | null) => void;
  /**
   * 地图角标(审图号、数据来源、"边界为示意" 等),显示在画布右下角,不可交互。
   * 公开展示含中国国界的地图须有审图号,由业务侧配置。
   */
  attribution?: string | null;
  /** WebGL 上下文丢失(显卡重置、系统休眠等)。场景此后不再渲染,需由宿主重建(见 SceneHost)。 */
  onContextLost?: () => void;
  /** 浏览器恢复了上下文。GeoScene 不在原画布上恢复,由宿主决定重建。 */
  onContextRestored?: () => void;
}

/** 平面视口四周留白(CSS 像素),用于全屏底图四周存在浮层 HUD 时让 3D 板块居中适配中央可见窗口。 */
export interface ViewportInset {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

export interface SafeAreaNdc {
  cx: number;
  cy: number;
  halfW: number;
  halfH: number;
}

const MIN_SAFE_HALF = 0.15;

export function safeAreaNdc(width: number, height: number, inset?: ViewportInset): SafeAreaNdc {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const left = Math.max(0, inset?.left ?? 0);
  const right = Math.max(0, inset?.right ?? 0);
  const top = Math.max(0, inset?.top ?? 0);
  const bottom = Math.max(0, inset?.bottom ?? 0);
  const rawLeft = -1 + (2 * left) / w;
  const rawRight = 1 - (2 * right) / w;
  const rawTop = 1 - (2 * top) / h;
  const rawBottom = -1 + (2 * bottom) / h;
  const validX = rawRight - rawLeft >= MIN_SAFE_HALF * 2;
  const validY = rawTop - rawBottom >= MIN_SAFE_HALF * 2;
  const availLeft = validX ? rawLeft : -1;
  const availRight = validX ? rawRight : 1;
  const availTop = validY ? rawTop : 1;
  const availBottom = validY ? rawBottom : -1;
  return {
    cx: (availLeft + availRight) / 2,
    cy: (availTop + availBottom) / 2,
    halfW: (availRight - availLeft) / 2,
    halfH: (availTop - availBottom) / 2,
  };
}

function normalizeInset(inset?: ViewportInset): Required<ViewportInset> {
  return {
    top: Math.max(0, inset?.top ?? 0),
    right: Math.max(0, inset?.right ?? 0),
    bottom: Math.max(0, inset?.bottom ?? 0),
    left: Math.max(0, inset?.left ?? 0),
  };
}

function sameInset(a: Required<ViewportInset>, b: Required<ViewportInset>): boolean {
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

/** 运行状态快照(长时间运行巡检 / 内存泄漏排查用)。 */
export interface SceneStats {
  mode: "globe" | "plane" | null;
  focusId: string | null;
  busy: boolean;
  fps: number;
  geometries: number;
  textures: number;
  programs: number;
  drawCalls: number;
  triangles: number;
  /** 标签层 DOM 节点数。 */
  labelNodes: number;
  overlays: number;
  contextLost: boolean;
}

interface OverlayEntry {
  type: string;
  instance: OverlayInstance;
  /** 转场透明度与视距透明度分开记录,实际透明度为两者乘积。 */
  transition: number;
  zoom: number;
  applied: number;
  /** 是否参与视距淡出(插件声明 zoomFade: false 的不参与,如底图)。 */
  zoomFade: boolean;
}

/** @deprecated 使用 GeoSceneOptions */
export type PlaneSceneOptions = GeoSceneOptions;

interface Plate {
  region: Region;
  mesh: THREE.Mesh<THREE.ExtrudeGeometry, [THREE.MeshBasicMaterial, THREE.ShaderMaterial]>;
  lines: Line2[];
  label: CSS2DObject | null;
  height: number;
  color: THREE.Color;
  value: number | null;
  lift: number;
}

interface LevelView {
  uid: number;
  focusId: string | null;
  /** 聚焦的是叶子区域本身(没有下级):区域作为主体完整呈现,而不是"不可下钻的子级"。 */
  leafFocus: boolean;
  group: THREE.Group;
  plates: Map<string, Plate>;
  base: THREE.Mesh | null;
  baseLines: Line2[];
  extraLines: THREE.Group;
  points: THREE.Group;
  overlayGroup: THREE.Group;
  overlays: Map<string, OverlayEntry>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  decor: THREE.Group | null;
  morph: MorphUniforms;
  /** 标签整体透明度(变形过程中隐藏)。 */
  labelAlpha: number;
  halfWidth: number;
  halfHeight: number;
  radius: number;
  unitHeight: number;
  baseHeight: number;
  center: [number, number];
  fitPoints: THREE.Vector3[];
  /** 该层级默认视距(视距淡出的基准),按需计算,画布尺寸变化时清空。 */
  homeDistance?: number;
}

interface CameraPose {
  position: THREE.Vector3;
  target: THREE.Vector3;
  up: THREE.Vector3;
}

const SIDE_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
${MORPH_GLSL}
varying float vH;
void main() {
  vH = position.z;
  vec4 w = modelMatrix * vec4(position, 1.0);
  w.xyz = geoMorph(w.xyz);
  gl_Position = projectionMatrix * viewMatrix * w;
  #include <logdepthbuf_vertex>
}`;

const SIDE_FRAGMENT = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform vec3 uTop;
uniform vec3 uBottom;
uniform float uOpacity;
varying float vH;
void main() {
  #include <logdepthbuf_fragment>
  float h = clamp(vH, 0.0, 1.0);
  gl_FragColor = vec4(mix(uBottom, uTop, smoothstep(0.0, 1.0, h)), uOpacity * (0.45 + 0.55 * h));
  #include <colorspace_fragment>
}`;

const LABEL_COLLISION_EVERY = 6;
const PLANE_GLOBE_OPACITY = 0.22;
/**
 * 平面模式下地球背景(海陆轮廓)随视野尺度淡出的角半径区间(弧度)。地球数据是全球尺度的粗精度轮廓,
 * 区县 / 乡镇尺度下放大后只剩失真的锯齿线和错位的海岸,不再提供地理参照,此时应交给底图或留空。
 */
const BACKDROP_FADE: [number, number] = [0.004, 0.012];
let viewSeq = 0;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * 地理场景(three.js):
 * - 全球层级:风格化地球,自转、拖拽旋转、悬停高亮、点击可下钻区域;
 * - 区域层级:当前聚焦区域的子级渲染为 3D 挤出板块,父级为底板;
 * - 地球 → 平面:先把目标转到正面,再让板块从"贴合球面"摊平(顶点着色器插值),镜头下降;平面 → 地球反向;
 * - 平面层级间:被点中的板块保留、其余淡出,新层级由中心向外升起。
 *
 * 世界坐标以当前锚点的切点为原点(RTC),平面单位与地球半径一致,下钻到乡镇 / 地块也不丢精度。
 */
export class GeoScene implements SceneAdapter {
  private readonly theme: SceneTheme;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly labelRenderer: CSS2DRenderer;
  private readonly composer: EffectComposer | null;
  private readonly scene = new THREE.Scene();
  /** 地图平面(x 东、y 北、z 上)→ 世界坐标(y 上)的旋转容器。 */
  private readonly mapRoot = new THREE.Group();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly animator = new Animator();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly cameraTarget = new THREE.Vector3();
  private readonly resizeObserver: ResizeObserver;
  private readonly detach: Unsubscribe;
  private readonly offEngine: Unsubscribe[] = [];
  private readonly startedAt = performance.now();
  private readonly R: number;
  private readonly globe: GlobeLayer | null;
  private mode: "globe" | "plane" | null = null;
  private anchor: Position | null = null;
  private mapper: PlaneMapper | null = null;
  private view: LevelView | null = null;
  private hovered: string | null = null;
  private highlighted: string | null = null;
  private selected: string | null = null;
  private hoveredPoint: PointDatum | null = null;
  private viewportInset: Required<ViewportInset>;
  private insetDirty = false;
  private size = { width: 1, height: 1 };
  private disposed = false;
  private frameCount = 0;
  private lastTick = performance.now();
  private busy = false;
  private pending: EngineFrame | null = null;
  private lastFrame: EngineFrame | null = null;
  private readonly overlayPlugins = new Map<string, OverlayPlugin>();
  private readonly globeOverlays = new Map<string, OverlayEntry>();
  /** 平面内容在地球上对应的顶层区域(上卷回地球时它的球面块淡入)。 */
  private planeTopId: string | null = null;
  /** 地球模式下当前对准的区域(undefined 表示尚未对准过);大区域(如美国、俄罗斯)聚焦时仍停留在地球模式。 */
  private globeFocusId: string | null | undefined = undefined;
  private pointerDown: { x: number; y: number } | null = null;
  private contextLost = false;
  private attribution: HTMLDivElement | null = null;
  private fps = 0;
  private drag: { x: number; y: number; moved: boolean } | null = null;

  constructor(private readonly options: GeoSceneOptions) {
    const { container } = options;
    this.viewportInset = normalizeInset(options.viewportInset);
    this.theme = createTheme(options.theme);
    for (const plugin of [...BUILTIN_OVERLAYS, ...(options.overlays ?? [])]) this.overlayPlugins.set(plugin.type, plugin);
    this.R = 100;
    const transparent = this.theme.background === null;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: transparent, powerPreference: "high-performance", logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, options.maxPixelRatio ?? 2));
    this.renderer.setClearColor(0x000000, 0);
    // 背景走场景色彩管理;直接用 clearColor 在后期管线中会被二次 sRGB 编码而发灰
    if (!transparent) this.scene.background = new THREE.Color(this.theme.background!);
    Object.assign(this.renderer.domElement.style, { position: "absolute", inset: "0", width: "100%", height: "100%", display: "block", touchAction: "none" });
    this.renderer.domElement.dataset.geoScene = "true";

    this.labelRenderer = new CSS2DRenderer();
    Object.assign(this.labelRenderer.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none", overflow: "hidden" });

    if (getComputedStyle(container).position === "static") container.style.position = "relative";
    container.append(this.renderer.domElement, this.labelRenderer.domElement);
    {
      // 角标:固定文字(options.attribution)+ 帧中的数据版权 / 底图审图号,随层级更新
      this.attribution = document.createElement("div");
      this.attribution.textContent = options.attribution ?? "";
      this.attribution.dataset.geoAttribution = "true";
      Object.assign(this.attribution.style, {
        position: "absolute",
        right: "12px",
        bottom: "8px",
        pointerEvents: "none",
        fontFamily: this.theme.fontFamily,
        fontSize: "12px",
        letterSpacing: "0.02em",
        color: this.theme.label,
        opacity: "0.55",
        whiteSpace: "nowrap",
      });
      container.append(this.attribution);
    }

    this.camera = new THREE.PerspectiveCamera(options.fovDeg ?? 30, 1, 0.01, 10000);
    this.mapRoot.rotation.x = -Math.PI / 2;
    this.scene.add(this.mapRoot);

    if (options.globe) {
      this.globe = new GlobeLayer(this.R, this.theme, options.globe, this.size);
      this.scene.add(this.globe.group);
      this.globe.setAnchor(options.globe.initialView ?? [105, 18]);
      this.globe.group.visible = false;
    } else {
      this.globe = null;
    }

    if ((options.bloom ?? true) && !transparent) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.4, 0.7));
      this.composer.addPass(new OutputPass());
    } else {
      this.composer = null;
    }

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("click", this.onClick);
    canvas.addEventListener("dblclick", this.onDoubleClick);
    canvas.addEventListener("contextmenu", this.onContextMenu);
    canvas.addEventListener("webglcontextlost", this.onWebglLost);
    canvas.addEventListener("webglcontextrestored", this.onWebglRestored);
    document.addEventListener("visibilitychange", this.onVisibility);

    this.offEngine.push(options.engine.on("select", ({ region }) => this.setSelected(region?.id ?? null)));
    this.renderer.setAnimationLoop(this.loop);
    this.detach = options.engine.attach(this);
  }

  // ── SceneAdapter ───────────────────────────────────────────────────────

  update(frame: EngineFrame): void {
    if (this.disposed) return;
    this.lastFrame = frame;
    this.renderAttribution(frame);
    if (this.busy) {
      this.pending = frame;
      return;
    }

    if (frame.view.scene === "globe" && this.globe) {
      this.syncGlobe(frame);
      if (this.mode === "plane") this.toGlobe();
      else if (this.mode === null) {
        this.mode = "globe";
        this.globe.group.visible = true;
        this.applyPose(this.globePose());
        this.focusGlobe(frame, false);
      } else this.focusGlobe(frame, true);
      return;
    }

    const anchor = frame.anchor?.center ?? frame.view.center;
    if (this.mode === "globe") {
      this.toPlane(frame, anchor);
      return;
    }

    // 平面模式:锚点变化(换了国家 / 顶层区域)时整体重建
    if (!this.anchor || angularDistance(this.anchor, anchor) > 1e-7) {
      if (this.view) {
        this.disposeView(this.view);
        this.view = null;
      }
      this.setAnchor(anchor, 1);
    }
    if (this.mode === null && this.globe) {
      this.globe.group.visible = true;
      this.globe.setOpacity(PLANE_GLOBE_OPACITY);
      this.globe.setOverlayVisible(false);
    }
    this.mode = "plane";
    this.planeTopId = frame.drill.path[0]?.id ?? null;

    if (this.view && this.view.focusId === frame.drill.focusId) {
      this.applyData(this.view, frame, true);
      return;
    }
    const old = this.view;
    const next = this.buildView(frame);
    this.view = next;
    this.hovered = null;
    this.selected = null;
    this.setHoveredPoint(null);
    const tree = this.options.engine.tree;
    const goingUp =
      frame.direction === "up" ||
      frame.direction === "reset" ||
      (frame.direction === "jump" && !!old?.focusId && (frame.drill.focusId === null || tree.isAncestor(frame.drill.focusId, old.focusId)));
    if (old) this.exitView(old, goingUp, frame.drill.focusId);
    this.enterView(next, !!old, goingUp);
    this.flyTo(this.planePose(next), !!old);
    this.fadeBackdrop(this.backdropOpacity(next), !!old);
  }

  /** 注册叠加图层插件(同 type 覆盖)。已显示的图层在下一次数据更新时生效。 */
  registerOverlay(plugin: OverlayPlugin): void {
    this.overlayPlugins.set(plugin.type, plugin);
  }

  /** 显示 / 隐藏全部文字标签(如待机时地球只作装饰,避免与页面标题重叠)。 */
  setLabelsVisible(visible: boolean): void {
    // 用 display 而不是 visibility:内层标签会显式设置 visibility(避让 / 背面隐藏),会覆盖父级的 hidden
    this.labelRenderer.domElement.style.display = visible ? "" : "none";
  }

  /** 运行时切换主色(如按主题轮换配色)。当前平面层级的板块颜色同步刷新。 */
  setAccent(accent: string): void {
    if (!accent || accent === this.theme.accent) return;
    Object.assign(this.theme, createTheme({ ...this.options.theme, accent, background: this.theme.background }));
    this.globe?.applyTheme();
    if (this.view && this.lastFrame) this.applyData(this.view, this.lastFrame, true);
  }

  /** 动态调整平面视口四周留白(如周边浮层 HUD 显隐切换),平滑重新居中并缩放地图。 */
  setViewportInset(inset: ViewportInset, animate = true): void {
    const next = normalizeInset(inset);
    if (sameInset(this.viewportInset, next)) return;
    this.viewportInset = next;
    if (this.view) this.view.homeDistance = undefined;
    if (this.busy) {
      this.insetDirty = true;
      return;
    }
    this.insetDirty = false;
    if (this.mode === "plane" && this.view) this.flyTo(this.planePose(this.view), animate);
  }

  /** 从外部(如周边排行榜悬停)反向高亮指定区域板块 / 球面区块。 */
  setHighlight(id: string | null): void {
    if (id === this.highlighted) return;
    const prev = this.highlighted;
    this.highlighted = id;
    if (this.mode === "globe") this.globe?.setHighlight(id);
    else this.refresh([prev, id]);
  }

  /** 运行状态快照。 */
  stats(): SceneStats {
    const info = this.renderer.info;
    return {
      mode: this.mode,
      focusId: this.lastFrame?.drill.focusId ?? null,
      busy: this.busy,
      fps: Math.round(this.fps * 10) / 10,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      labelNodes: this.labelRenderer.domElement.getElementsByTagName("*").length,
      overlays: this.globeOverlays.size + (this.view?.overlays.size ?? 0),
      contextLost: this.contextLost,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    this.offEngine.forEach((off) => off());
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerleave", this.onPointerLeave);
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("click", this.onClick);
    canvas.removeEventListener("dblclick", this.onDoubleClick);
    canvas.removeEventListener("contextmenu", this.onContextMenu);
    canvas.removeEventListener("webglcontextlost", this.onWebglLost);
    canvas.removeEventListener("webglcontextrestored", this.onWebglRestored);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.animator.clear();
    for (const child of [...this.mapRoot.children]) {
      child.removeFromParent();
      disposeObject(child);
    }
    for (const entry of this.globeOverlays.values()) entry.instance.dispose();
    this.globeOverlays.clear();
    this.globe?.dispose();
    this.composer?.dispose();
    this.renderer.dispose();
    canvas.remove();
    this.labelRenderer.domElement.remove();
    this.attribution?.remove();
  }

  // ── 锚点与相机 ─────────────────────────────────────────────────────────

  private setAnchor(anchor: Position, sink?: number): void {
    this.anchor = anchor;
    this.mapper = createPlaneMapper(anchor, this.R);
    this.globe?.setAnchor(anchor, sink);
  }

  private globePose(zoom = 1): CameraPose {
    const fill = (this.globe ? (this.options.globe as GlobeOptions).fill : undefined) ?? 0.86;
    const fovY = (this.camera.fov * Math.PI) / 180;
    const aspect = this.size.width / this.size.height;
    const fovMin = Math.min(fovY, 2 * Math.atan(Math.tan(fovY / 2) * aspect));
    const distance = this.R / Math.sin((fovMin * fill * zoom) / 2);
    return {
      position: new THREE.Vector3(0, -this.R + distance, 0),
      target: new THREE.Vector3(0, -this.R, 0),
      up: new THREE.Vector3(0, 0, -1),
    };
  }

  /**
   * 地球模式下对准聚焦区域:转动地球使区域中心朝向相机,并按区域角半径拉近(不远于整球视距)。
   * 聚焦回到顶层时恢复整球视距。只在聚焦变化时执行,不打断用户拖拽后的视角。
   */
  private focusGlobe(frame: EngineFrame, animate: boolean): void {
    const globe = this.globe;
    const id = frame.drill.focusId;
    if (!globe || id === this.globeFocusId) return;
    this.globeFocusId = id;
    const home = this.globePose();
    let to = home;
    const center = id ? frame.view.center : null;
    if (center) {
      const aspect = this.size.width / this.size.height;
      const fit = cameraDistance(frame.view.angularRadius, this.camera.fov, aspect, 1.15, "globe") * this.R;
      const distance = Math.min(home.position.distanceTo(home.target), fit);
      to = { position: new THREE.Vector3(0, -this.R + distance, 0), target: home.target.clone(), up: home.up.clone() };
    }
    this.animator.cancel("camera");
    if (!animate) {
      if (center) this.setAnchor(center, 0);
      this.applyPose(to);
      return;
    }
    const from = this.currentPose();
    const start = globe.getAnchor();
    this.animator.add(
      {
        duration: Math.max(this.options.transitionMs ?? 1200, this.zoomDuration(this.options.transitionMs ?? 1200, from, to)),
        ease: easeInOutCubic,
        update: (k) => {
          if (center) this.setAnchor(greatCircle(start, center, k), 0);
          this.applyPose(this.lerpPose(from, to, k));
        },
      },
      "camera",
    );
  }

  private applyPose(pose: CameraPose): void {
    this.camera.position.copy(pose.position);
    this.cameraTarget.copy(pose.target);
    this.camera.up.copy(pose.up);
    this.camera.lookAt(this.cameraTarget);
    const distance = pose.position.distanceTo(pose.target);
    this.camera.near = Math.max(1e-5, distance * 0.005);
    this.camera.far = distance * 20 + this.R * 6;
    this.camera.updateProjectionMatrix();
  }

  private currentPose(): CameraPose {
    return { position: this.camera.position.clone(), target: this.cameraTarget.clone(), up: this.camera.up.clone() };
  }

  /**
   * 相机插值:视距按对数插值(画面缩放速度恒定,跨多级缩放如 地球 → 县 不会在末尾猛冲),
   * 目标点随视距变化的进度移动:拉近时先平移再推进,拉远时先退后再平移,避免近距离横扫。
   */
  private lerpPose(from: CameraPose, to: CameraPose, k: number): CameraPose {
    const fromOffset = from.position.clone().sub(from.target);
    const toOffset = to.position.clone().sub(to.target);
    const d0 = Math.max(1e-9, fromOffset.length());
    const d1 = Math.max(1e-9, toOffset.length());
    const distance = d0 * Math.pow(d1 / d0, k);
    const span = Math.abs(d1 - d0);
    const pan = span / Math.max(d0, d1) < 0.05 ? k : clamp01(Math.abs(distance - d0) / span);
    const target = from.target.clone().lerp(to.target, pan);
    const direction = fromOffset.normalize().lerp(toOffset.normalize(), k).normalize();
    return { position: target.clone().addScaledVector(direction, distance), target, up: from.up.clone().lerp(to.up, k).normalize() };
  }

  /** 视距缩放跨度越大,转场越长(每 10 倍约 +45%,最多 2.2 倍)。 */
  private zoomDuration(base: number, from: CameraPose, to: CameraPose): number {
    const ratio = from.position.distanceTo(from.target) / Math.max(1e-9, to.position.distanceTo(to.target));
    return base * Math.min(2.2, Math.max(1, 0.55 + 0.45 * Math.abs(Math.log10(ratio))));
  }

  /** 该层级下地球背景应有的透明度:城市及以上尺度保持,区县 / 乡镇尺度淡出。 */
  private backdropOpacity(view: LevelView): number {
    const angular = view.radius / this.R;
    const [lo, hi] = BACKDROP_FADE;
    const k = clamp01((angular - lo) / (hi - lo));
    return PLANE_GLOBE_OPACITY * k * k * (3 - 2 * k);
  }

  private fadeBackdrop(target: number, animate: boolean): void {
    const globe = this.globe;
    if (!globe) return;
    // 从实际透明度出发:上一次淡入 / 淡出可能还没走完(如进入区县途中立即返回)
    this.animator.cancel("backdrop");
    const from = globe.currentOpacity;
    if (!animate || Math.abs(target - from) < 1e-4) {
      globe.setOpacity(target);
      return;
    }
    // 上卷时快速恢复:旧层级板块退场、新层级尚未落下的间隙里背景不能是空的(否则闪一下全暗);下钻时随镜头慢慢淡出
    const T = this.options.transitionMs ?? 1200;
    this.animator.add({ duration: target > from ? T * 0.2 : T, update: (k) => globe.setOpacity(from + (target - from) * k) }, "backdrop");
  }

  private flyTo(pose: CameraPose, animate: boolean): void {
    this.animator.cancel("camera");
    if (!animate) {
      this.applyPose(pose);
      return;
    }
    const from = this.currentPose();
    this.animator.add({ duration: this.zoomDuration(this.options.transitionMs ?? 1200, from, pose), update: (k) => this.applyPose(this.lerpPose(from, pose, k)) }, "camera");
  }

  /**
   * 区域外形装入视口(支持 viewportInset 安全区留白):先按宽高估算距离,再把外形采样点投影到屏幕迭代修正距离与目标点,
   * 抵消透视下"近大远小"造成的南侧溢出,并让外形在安全区窗口中居中。
   */
  private planePose(view: LevelView): CameraPose {
    const pitch = ((this.options.pitchDeg ?? 38) * Math.PI) / 180;
    const padding = this.options.padding ?? 1.08;
    const fovY = (this.camera.fov * Math.PI) / 180;
    const aspect = this.size.width / this.size.height;
    const fovX = 2 * Math.atan(Math.tan(fovY / 2) * aspect);
    const safe = safeAreaNdc(this.size.width, this.size.height, this.viewportInset);
    let distance =
      Math.max(
        view.halfWidth / (Math.tan(fovX / 2) * safe.halfW),
        (view.halfHeight * Math.cos(pitch)) / (Math.tan(fovY / 2) * safe.halfH),
      ) * padding;
    const [cx, cy] = view.center;
    // 地图坐标 (x, y, z) → 世界坐标 (x, z, -y)
    const target = new THREE.Vector3(cx, view.baseHeight + view.unitHeight, -cy);
    const offset = (d: number) => new THREE.Vector3(0, Math.cos(pitch) * d, Math.sin(pitch) * d);
    const probe = new THREE.PerspectiveCamera(this.camera.fov, aspect, 0.001, 1e6);
    const v = new THREE.Vector3();
    for (let i = 0; i < 8 && view.fitPoints.length; i++) {
      probe.position.copy(target).add(offset(distance));
      probe.lookAt(target);
      probe.updateMatrixWorld();
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const p of view.fitPoints) {
        v.set(p.x, p.z, -p.y).project(probe);
        minX = Math.min(minX, v.x);
        maxX = Math.max(maxX, v.x);
        minY = Math.min(minY, v.y);
        maxY = Math.max(maxY, v.y);
      }
      const span = Math.max((maxX - minX) / (2 * safe.halfW), (maxY - minY) / (2 * safe.halfH)) * padding;
      const halfViewY = distance * Math.tan(fovY / 2);
      target.x += ((maxX + minX) / 2 - safe.cx) * halfViewY * aspect;
      target.z -= (((maxY + minY) / 2 - safe.cy) * halfViewY) / Math.cos(pitch);
      if (span > 0) distance *= span;
    }
    return { position: target.clone().add(offset(distance)), target, up: new THREE.Vector3(0, 1, 0) };
  }

  // ── 地球 ↔ 平面 ────────────────────────────────────────────────────────

  private hasChildren(id: string): boolean {
    const engine = this.options.engine;
    if (engine.isLeaf(id)) return false;
    return engine.tree.children(id).length > 0 || !!engine.tree.get(id)?.expandable;
  }

  private syncGlobe(frame: EngineFrame): void {
    const globe = this.globe!;
    globe.setRegions(frame.regions, (id) => this.hasChildren(id));
    const points = this.layer<PointLayerData>(frame, "point")?.data?.points ?? [];
    globe.setPoints(points.map((p) => ({ id: p.id, name: p.name, position: p.position, label: p.label, color: p.color })));
    this.syncOverlays(this.globeOverlays, frame, "globe", this.globeContext());
  }

  // ── 叠加图层 ───────────────────────────────────────────────────────────

  private renderAttribution(frame: EngineFrame): void {
    if (!this.attribution) return;
    const text = [...new Set([this.options.attribution, ...(frame.attributions ?? [])].filter((a): a is string => !!a))].join(" · ");
    if (this.attribution.textContent !== text) this.attribution.textContent = text;
    this.attribution.style.display = text ? "" : "none";
  }

  private globeContext(): OverlayContext {
    const globe = this.globe!;
    const R = this.R;
    const unit = (p: Position) => {
      const l = (p[0] * Math.PI) / 180;
      const b = (p[1] * Math.PI) / 180;
      return new THREE.Vector3(Math.cos(b) * Math.sin(l), Math.sin(b), Math.cos(b) * Math.cos(l));
    };
    return {
      mode: "globe",
      group: globe.overlayGroup,
      theme: this.theme,
      scale: R,
      unitHeight: R * 0.02,
      position: (p, h = 0) => unit(p).multiplyScalar(R * 1.004 + h),
      up: (p) => unit(p),
      contains: () => true,
      planeXY: () => null,
      bounds: null,
      maxSurface: 0,
      baseHeight: 0,
      unproject: () => null,
      camera: () => this.camera,
      region: (id) => this.options.engine.tree.get(id),
      resolution: () => this.size,
      label: (text, style) => makeLabel(this.theme, text, style),
    };
  }

  private planeContext(view: LevelView): OverlayContext {
    const mapper = this.mapper!;
    const plates = [...view.plates.values()];
    const plateAt = (p: Position) => plates.find((plate) => pointInMultiPolygon(p, plate.region.polygons));
    return {
      mode: "plane",
      group: view.overlayGroup,
      theme: this.theme,
      scale: view.radius,
      unitHeight: view.unitHeight,
      position: (p, h = 0) => {
        const [x, y] = mapper.project(p);
        const plate = plateAt(p);
        return new THREE.Vector3(x, y, view.baseHeight + (plate ? plate.height : 0) + h);
      },
      up: () => new THREE.Vector3(0, 0, 1),
      contains: (p) => !!plateAt(p),
      planeXY: (p) => mapper.project(p),
      bounds: view.bounds,
      maxSurface: view.baseHeight + Math.max(0, ...plates.map((p) => p.height)),
      baseHeight: view.baseHeight,
      unproject: (x, y) => mapper.unproject(x, y),
      camera: () => this.camera,
      region: (id) => this.options.engine.tree.get(id),
      resolution: () => this.size,
      label: (text, style) => makeLabel(this.theme, text, style),
    };
  }

  /** 按帧中的图层规格创建 / 更新 / 移除叠加图层实例。 */
  private syncOverlays(entries: Map<string, OverlayEntry>, frame: EngineFrame, mode: OverlayMode, ctx: OverlayContext): void {
    const wanted = frame.layers.filter((spec) => this.overlayPlugins.get(spec.type)?.modes.includes(mode));
    const keep = new Set(wanted.map((spec) => spec.id));
    for (const [id, entry] of entries) {
      if (keep.has(id)) continue;
      entry.instance.dispose();
      entries.delete(id);
    }
    for (const spec of wanted) {
      const existing = entries.get(spec.id);
      if (existing && existing.type === spec.type && existing.instance.update?.(spec)) continue;
      existing?.instance.dispose();
      try {
        const plugin = this.overlayPlugins.get(spec.type)!;
        const entry: OverlayEntry = { type: spec.type, instance: plugin.create(ctx, spec), transition: 1, zoom: 1, applied: 1, zoomFade: plugin.zoomFade !== false };
        // 重建的效果继承当前的淡出状态(如转场中途数据刷新)
        if (existing) this.setEntryOpacity(entry, existing.transition, existing.zoom);
        entries.set(spec.id, entry);
      } catch (error) {
        entries.delete(spec.id);
        console.error(`[geo-scene] 叠加图层 "${spec.id}"(${spec.type})创建失败`, error);
      }
    }
  }

  private toPlane(frame: EngineFrame, anchor: Position): void {
    this.globeFocusId = undefined;
    const globe = this.globe!;
    this.busy = true;
    this.setHoveredPoint(null);
    this.setHovered(null);
    const T = (this.options.transitionMs ?? 1200) * 1.9;
    const start = globe.getAnchor();
    const enteringId = frame.drill.path[0]?.id ?? null;
    this.planeTopId = enteringId;

    // 阶段一:转动地球,把目标转到正面并略微拉近
    this.animator.add({
      duration: T * 0.38,
      update: (k) => {
        this.setAnchor(greatCircle(start, anchor, k), 0);
        this.applyPose(this.globePose(1 + 0.12 * k));
      },
      done: () => {
        // 阶段二:平面板块从贴合球面开始摊平,镜头下降
        this.setAnchor(anchor, 0);
        const view = this.buildView(frame);
        this.view = view;
        view.morph.uMorph.value = 0;
        view.labelAlpha = 0;
        view.points.visible = false;
        view.overlayGroup.visible = false;
        this.setViewOpacity(view, 0);
        const from = this.currentPose();
        const to = this.planePose(view);
        const backdrop = this.backdropOpacity(view);
        globe.setMarkersVisible(false);
        this.animator.add({
          duration: this.zoomDuration(T * 0.62, from, to),
          ease: (t) => t,
          update: (t) => {
            const k = easeInOutCubic(t);
            this.applyPose(this.lerpPose(from, to, k));
            view.morph.uMorph.value = easeInOutCubic(clamp01((t - 0.12) / 0.88));
            this.setViewOpacity(view, clamp01(t * 3));
            if (enteringId) globe.setRegionFade(enteringId, 1 - clamp01(t * 2.5));
            globe.setOpacity(1 - (1 - backdrop) * k);
            globe.setAnchor(anchor, k);
          },
          done: () => {
            this.mode = "plane";
            globe.setOverlayVisible(false);
            view.labelAlpha = 1;
            view.points.visible = true;
            view.overlayGroup.visible = true;
            this.setViewOpacity(view, 1);
            this.finishTransition();
          },
        });
      },
    });
  }

  private toGlobe(): void {
    const globe = this.globe!;
    const view = this.view;
    this.busy = true;
    this.setHoveredPoint(null);
    this.setHovered(null);
    const T = (this.options.transitionMs ?? 1200) * 1.9;
    globe.setOverlayVisible(true);
    // 点位 / 效果按地球尺度绘制,镜头拉远到接近地球视角后再出现
    globe.setMarkersVisible(false);
    let markers = false;
    if (this.planeTopId) globe.setRegionFade(this.planeTopId, 0);
    const topId = this.planeTopId;
    if (view) {
      view.labelAlpha = 0;
      view.points.visible = false;
      view.overlayGroup.visible = false;
      this.setViewOpacity(view, 1);
    }
    const from = this.currentPose();
    const to = this.globePose();
    const anchor = this.anchor!;
    const d0 = from.position.distanceTo(from.target);
    const d1 = to.position.distanceTo(to.target);
    this.animator.cancel("backdrop");
    const backdrop = globe.currentOpacity;
    this.animator.add({
      duration: this.zoomDuration(T * 0.7, from, to),
      ease: (t) => t,
      update: (t) => {
        const k = easeInOutCubic(t);
        const pose = this.lerpPose(from, to, k);
        this.applyPose(pose);
        if (view) {
          // 卷曲进度跟随视距:从县 / 乡镇级别上卷时,先拉远再卷回球面,近处不会看到板块下沉
          const zoomed = d1 > d0 ? clamp01((pose.position.distanceTo(pose.target) - d0) / (d1 - d0)) : t;
          view.morph.uMorph.value = 1 - easeInOutCubic(clamp01(Math.max(zoomed, t - 0.5) / 0.8));
          this.setViewOpacity(view, 1 - clamp01((t - 0.55) / 0.45));
        }
        if (!markers && t > 0.75) {
          markers = true;
          globe.setMarkersVisible(true);
        }
        globe.setOpacity(backdrop + (1 - backdrop) * k);
        globe.setAnchor(anchor, 1 - k);
        if (topId) globe.setRegionFade(topId, clamp01((t - 0.45) / 0.55));
      },
      done: () => {
        if (!markers) globe.setMarkersVisible(true);
        if (view) this.disposeView(view);
        this.view = null;
        this.mode = "globe";
        // 转场停在整球视距;目标若是大区域(仍在地球模式),接着对准它
        this.globeFocusId = null;
        if (this.lastFrame?.view.scene === "globe") this.focusGlobe(this.lastFrame, true);
        this.finishTransition();
      },
    });
  }

  private finishTransition(): void {
    this.busy = false;
    const next = this.pending;
    this.pending = null;
    if (next) this.update(next);
    if (this.insetDirty && !this.busy) {
      this.insetDirty = false;
      if (this.mode === "plane" && this.view) this.flyTo(this.planePose(this.view), true);
    }
  }

  // ── 构建 ───────────────────────────────────────────────────────────────

  private layer<T>(frame: EngineFrame, type: string): LayerSpec<T> | undefined {
    return frame.layers.find((layer) => layer.type === type) as LayerSpec<T> | undefined;
  }

  private buildView(frame: EngineFrame): LevelView {
    const mapper = this.mapper!;
    const focus = frame.focus;
    const leafFocus = !!focus && frame.regions.length === 1 && frame.regions[0].id === focus.id;
    const morph = createMorphUniforms(this.R, 1);

    // 按投影后的真实外形计算范围(比经纬度 bbox 更贴合,相机适配更准)
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const outline: Array<[number, number]> = [];
    for (const region of focus && !leafFocus ? [focus] : frame.regions) {
      for (const polygon of region.polygons) {
        for (const p of polygon[0] ?? []) {
          const [x, y] = mapper.project(p);
          outline.push([x, y]);
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    }
    const halfWidth = Math.max(1e-6, (maxX - minX) / 2);
    const halfHeight = Math.max(1e-6, (maxY - minY) / 2);
    const radius = Math.max(halfWidth, halfHeight);
    const unitHeight = radius * 0.045;
    const baseHeight = focus && !leafFocus ? unitHeight * 0.8 : 0;
    const group = new THREE.Group();
    group.name = `level:${frame.drill.focusId ?? "root"}`;
    this.mapRoot.add(group);

    const view: LevelView = {
      uid: ++viewSeq,
      focusId: frame.drill.focusId,
      leafFocus,
      group,
      plates: new Map(),
      base: null,
      baseLines: [],
      extraLines: new THREE.Group(),
      points: new THREE.Group(),
      overlayGroup: new THREE.Group(),
      overlays: new Map(),
      bounds: { minX, minY, maxX, maxY },
      decor: null,
      morph,
      labelAlpha: 1,
      halfWidth,
      halfHeight,
      radius,
      unitHeight,
      baseHeight,
      center: [(minX + maxX) / 2, (minY + maxY) / 2],
      fitPoints: [],
    };
    // 采样外形点(最多约 600 个),高度取板块最高处,保证升起后的板块也在视口内
    const step = Math.max(1, Math.floor(outline.length / 600));
    for (let i = 0; i < outline.length; i += step) {
      const [x, y] = outline[i];
      view.fitPoints.push(new THREE.Vector3(x, y, 0), new THREE.Vector3(x, y, baseHeight + unitHeight * 2.4));
    }

    if (this.options.decor ?? true) view.decor = this.buildDecor(view);

    // 父级底板:描边用外轮廓(去掉下级之间的共享边)
    if (focus && !leafFocus) {
      const geometry = new THREE.ExtrudeGeometry(regionShapes(focus.polygons, mapper), { depth: 1, bevelEnabled: false });
      const base = new THREE.Mesh(geometry, [
        applyMorph(new THREE.MeshBasicMaterial({ color: this.theme.base, transparent: true, opacity: 0.95 }), morph),
        this.sideMaterial(this.theme.accent, this.theme.side, 0.9, morph),
      ]);
      base.scale.z = baseHeight;
      base.renderOrder = 1;
      group.add(base);
      view.base = base;
      for (const flat of linePositions(outerOutline(focus.polygons, { cells: 1000 }), mapper, 0)) {
        const glow = this.line(flat, this.theme.edge, 3, 1, morph);
        glow.position.z = baseHeight + view.unitHeight * 0.01;
        group.add(glow);
        view.baseLines.push(glow);
        const bottom = this.line(flat, this.theme.accent, 1.2, 0.5, morph);
        group.add(bottom);
        view.baseLines.push(bottom);
      }
    }

    // 子级板块
    for (const region of frame.regions) {
      const shapes = regionShapes(region.polygons, mapper);
      if (!shapes.length) continue;
      // 细小部件(岛礁、飞地)按尺寸降低挤出深度,避免成为细针
      const geometry = plateGeometry(shapes, unitHeight * 4);
      const top = applyMorph(new THREE.MeshBasicMaterial({ color: this.theme.plateEmpty, transparent: true, opacity: 0.96 }), morph);
      const mesh = new THREE.Mesh(geometry, [top, this.sideMaterial(this.theme.accent, this.theme.side, 0.95, morph)]) as Plate["mesh"];
      mesh.position.z = baseHeight;
      mesh.scale.z = unitHeight;
      mesh.userData.regionId = region.id;
      mesh.renderOrder = 2;
      const lines = outlinePositions(region.polygons, mapper, 1.002).map((flat) => {
        const line = this.line(flat, this.theme.edge, 1.4, 0.85, morph);
        mesh.add(line);
        return line;
      });
      group.add(mesh);
      view.plates.set(region.id, { region, mesh, lines, label: null, height: unitHeight, color: new THREE.Color(this.theme.plateEmpty), value: null, lift: 0 });
    }

    group.add(view.extraLines, view.points, view.overlayGroup);
    this.applyData(view, frame, false);
    return view;
  }

  private buildDecor(view: LevelView): THREE.Group {
    const decor = new THREE.Group();
    const r = Math.hypot(view.halfWidth, view.halfHeight) * 1.02;
    const [cx, cy] = view.center;
    decor.position.set(cx, cy, -view.unitHeight * 0.3);

    const ringMaterial = (opacity: number) =>
      new THREE.MeshBasicMaterial({ color: this.theme.accent, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false });
    const outer = new THREE.Mesh(new THREE.RingGeometry(r * 0.992, r, 160), ringMaterial(0.28));
    const scan = new THREE.Mesh(new THREE.RingGeometry(r * 0.955, r * 0.968, 96, 1, 0, Math.PI * 0.35), ringMaterial(0.42));
    scan.name = "scan";
    const inner = new THREE.Mesh(new THREE.RingGeometry(r * 0.86, r * 0.864, 160), ringMaterial(0.14));
    const grid = new THREE.GridHelper(r * 2.6, 26, this.theme.accent, this.theme.accent);
    grid.rotation.x = Math.PI / 2;
    for (const material of [grid.material].flat()) {
      material.transparent = true;
      material.opacity = 0.05;
      material.depthWrite = false;
    }
    decor.add(grid, inner, outer, scan);
    view.group.add(decor);
    return decor;
  }

  /** 写入数值:颜色、高度、标签、点位、线。animate 为 true 时颜色和高度做补间。 */
  private applyData(view: LevelView, frame: EngineFrame, animate: boolean): void {
    const choropleth = this.layer<ChoroplethLayerData>(frame, "choropleth")?.data;
    const labelSpec = this.layer<LabelLayerData>(frame, "label");
    const values = choropleth?.values ?? {};
    const present = [...view.plates.keys()].map((id) => values[id]).filter((v): v is number => Number.isFinite(v));
    const scale = classify(present, choropleth?.method ?? (present.length >= 5 ? "quantile" : "linear"), 5);
    const low = new THREE.Color(this.theme.plateLow);
    const high = new THREE.Color(this.theme.accent);
    const extrude = choropleth?.extrudeByValue ?? true;
    // 没有任何数值时,用颜色引导下钻:可继续下钻的区域高亮
    const guide = present.length === 0;

    for (const plate of view.plates.values()) {
      const raw = values[plate.region.id];
      const value = Number.isFinite(raw) ? raw : null;
      const t = value !== null ? scale.position(value) : 0;
      plate.value = value;
      if (guide) {
        // 聚焦叶子时它就是主体,按"可下钻"的醒目样式呈现,而不是作为暗淡的末级子块
        const drillable = view.leafFocus || this.hasChildren(plate.region.id);
        plate.color = new THREE.Color(mixColor(this.theme.plateLow, this.theme.accent, drillable ? 0.95 : 0.4));
        plate.height = view.unitHeight * (drillable ? 1.6 : 0.6);
      } else {
        plate.color = value !== null ? low.clone().lerp(high, 0.12 + 0.88 * t) : new THREE.Color(this.theme.plateEmpty);
        plate.height = view.unitHeight * (extrude && value !== null ? 0.6 + 1.8 * t : 0.6);
      }
      this.paint(plate, view, animate);
      if (animate) {
        const from = plate.mesh.scale.z;
        this.animator.add({ duration: 700, update: (k) => (plate.mesh.scale.z = from + (plate.height - from) * k) }, `${view.uid}:h:${plate.region.id}`);
      } else {
        plate.mesh.scale.z = plate.height;
      }

      if (labelSpec) {
        if (!plate.label) {
          // CSS2DRenderer 每帧会改写外层元素的 display,排版放在内层
          const outer = document.createElement("div");
          outer.append(document.createElement("div"));
          plate.label = new CSS2DObject(outer);
          plate.mesh.add(plate.label);
        }
        const [ax, ay] = this.mapper!.project(plate.region.anchor);
        plate.label.position.set(ax, ay, 1.05);
        this.renderLabel(plate, value, labelSpec.data, choropleth?.unit, view.plates.size === 1);
      } else if (plate.label) {
        plate.mesh.remove(plate.label);
        plate.label.element.remove();
        plate.label = null;
      }
    }

    this.buildPoints(view, this.layer<PointLayerData>(frame, "point")?.data?.points ?? []);
    this.buildExtraLines(view, this.layer<LineLayerData>(frame, "line")?.data);
    this.syncOverlays(view.overlays, frame, "plane", this.planeContext(view));
  }

  private renderLabel(plate: Plate, value: number | null, data: LabelLayerData | undefined, unit: string | undefined, focused: boolean): void {
    const outer = plate.label!.element as HTMLDivElement;
    outer.style.pointerEvents = "none";
    outer.dataset.regionId = plate.region.id;
    const el = outer.firstElementChild as HTMLDivElement;
    Object.assign(el.style, {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "1px",
      fontFamily: this.theme.fontFamily,
      color: this.theme.label,
      fontSize: focused ? "28px" : "16px",
      fontWeight: "700",
      letterSpacing: "0.04em",
      lineHeight: "1.15",
      whiteSpace: "nowrap",
      textShadow: `0 0 4px ${this.theme.labelShadow}, 0 0 10px ${this.theme.labelShadow}`,
    });
    const showValue = data?.showValue ?? true;
    const format = data?.format ?? ((v: number, u?: string) => `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(v)}${u ? ` ${u}` : ""}`);
    el.replaceChildren();
    const name = document.createElement("span");
    name.textContent = plate.region.name;
    el.append(name);
    if (showValue && value !== null) {
      const v = document.createElement("b");
      v.textContent = format(value, unit);
      Object.assign(v.style, { color: this.theme.labelValue, fontSize: focused ? "22px" : "14px", fontWeight: "800" });
      el.append(v);
    }
  }

  /** 标签避让:按数值(无数值时按面积)从大到小贪心放置,与已放置标签重叠的隐藏。 */
  private resolveLabelCollisions(): void {
    const view = this.view;
    if (!view || view.labelAlpha < 1) return;
    const placed: DOMRect[] = [];
    const pad = 2;
    const overlaps = (rect: DOMRect) => placed.some((r) => rect.left < r.right + pad && rect.right > r.left - pad && rect.top < r.bottom + pad && rect.bottom > r.top - pad);
    // 优先级:点位标签 > 叠加图层标签(柱顶数值、预警等) > 区域名称
    view.points.traverse((o) => {
      if (!(o instanceof CSS2DObject)) return;
      const rect = (o.element.firstElementChild as HTMLElement | null)?.getBoundingClientRect();
      if (rect?.width) placed.push(rect);
    });
    view.overlayGroup.traverse((o) => {
      if (!(o instanceof CSS2DObject) || !o.visible) return;
      const inner = o.element.firstElementChild as HTMLElement | null;
      if (!inner) return;
      inner.style.visibility = "visible";
      const rect = inner.getBoundingClientRect();
      if (!rect.width) return;
      if (overlaps(rect)) inner.style.visibility = "hidden";
      else placed.push(rect);
    });
    const plates = [...view.plates.values()]
      .filter((p) => p.label)
      .sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || b.region.areaKm2 - a.region.areaKm2);
    for (const plate of plates) {
      const inner = plate.label!.element.firstElementChild as HTMLElement | null;
      if (!inner) continue;
      inner.style.visibility = "visible";
      const rect = inner.getBoundingClientRect();
      if (!rect.width) continue;
      if (overlaps(rect)) inner.style.visibility = "hidden";
      else placed.push(rect);
    }
  }

  private buildPoints(view: LevelView, points: PointDatum[]): void {
    for (const child of [...view.points.children]) {
      view.points.remove(child);
      disposeObject(child);
    }
    const plates = [...view.plates.values()];
    const size = view.radius * 0.014;
    for (const point of points) {
      const plate = plates.find((p) => pointInMultiPolygon(point.position, p.region.polygons));
      if (!plate) continue;
      const [x, y] = this.mapper!.project(point.position);
      const color = new THREE.Color(point.color ?? this.theme.point);
      const g = new THREE.Group();
      g.name = `point:${point.id}`;
      g.userData = { plateId: plate.region.id, phase: hashPhase(point.id), point };
      const stemHeight = view.unitHeight * 2.2;
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(size * 0.12, size * 0.12, stemHeight, 8),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 }),
      );
      stem.rotation.x = Math.PI / 2;
      stem.position.z = stemHeight / 2;
      stem.userData.point = point;
      const head = new THREE.Mesh(new THREE.SphereGeometry(size * 0.42, 16, 12), new THREE.MeshBasicMaterial({ color }));
      head.position.z = stemHeight;
      head.userData.point = point;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(size * 0.7, size, 40),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }),
      );
      ring.name = "pulse";
      ring.position.z = 0.002 * view.unitHeight;
      g.add(stem, head, ring);
      if (point.label) {
        const outer = document.createElement("div");
        const inner = document.createElement("div");
        inner.textContent = point.label;
        Object.assign(inner.style, {
          fontFamily: this.theme.fontFamily,
          color: point.color ?? this.theme.point,
          fontSize: "17px",
          fontWeight: "800",
          whiteSpace: "nowrap",
          transform: "translateY(-16px)",
          textShadow: `0 0 4px ${this.theme.labelShadow}, 0 0 10px ${this.theme.labelShadow}`,
        });
        outer.append(inner);
        outer.style.pointerEvents = "none";
        const label = new CSS2DObject(outer);
        label.position.z = stemHeight * 1.1;
        g.add(label);
      }
      g.position.set(x, y, view.baseHeight + plate.height);
      view.points.add(g);
    }
  }

  private buildExtraLines(view: LevelView, data: LineLayerData | undefined): void {
    for (const child of [...view.extraLines.children]) {
      child.removeFromParent();
      disposeObject(child);
    }
    if (!data?.lines.length) return;
    for (const flat of linePositions(data.lines, this.mapper!, view.baseHeight + view.unitHeight * 0.05)) {
      view.extraLines.add(this.line(flat, data.color ?? this.theme.edge, data.width ?? 2, 0.9, view.morph));
    }
  }

  // ── 层级转场(平面内) ──────────────────────────────────────────────────

  private enterView(view: LevelView, animate: boolean, goingUp: boolean): void {
    if (!animate) return;
    const duration = this.options.transitionMs ?? 1200;
    const [cx, cy] = view.center;
    const dist = new Map<string, number>();
    let maxDist = 1e-6;
    for (const plate of view.plates.values()) {
      const [ax, ay] = this.mapper!.project(plate.region.anchor);
      const d = Math.hypot(ax - cx, ay - cy);
      dist.set(plate.region.id, d);
      maxDist = Math.max(maxDist, d);
    }
    // 下钻:板块由中心向外依次升起;上卷:从上方落下
    const startAt = goingUp ? duration * 0.2 : duration * 0.35;
    for (const plate of view.plates.values()) {
      const delay = startAt + (dist.get(plate.region.id)! / maxDist) * duration * 0.3;
      const target = plate.height;
      plate.mesh.scale.z = goingUp ? target * 3 : 0.0001;
      this.setPlateOpacity(plate, view, 0);
      this.animator.add(
        {
          duration: duration * 0.5,
          delay,
          ease: goingUp ? easeOutCubic : easeOutBack,
          update: (k) => {
            plate.mesh.scale.z = goingUp ? target * (3 - 2 * k) : Math.max(0.0001, target * k);
            this.setPlateOpacity(plate, view, Math.min(1, k * 1.6));
          },
        },
        `${view.uid}:h:${plate.region.id}`,
      );
    }
    view.points.visible = false;
    view.overlayGroup.visible = false;
    view.extraLines.visible = false;
    this.animator.add({
      duration: 1,
      delay: startAt + duration * 0.6,
      update: () => undefined,
      done: () => {
        view.points.visible = true;
        view.overlayGroup.visible = true;
        view.extraLines.visible = true;
      },
    });
    if (view.base) {
      const base = view.base;
      const h = view.baseHeight;
      setMaterialsOpacity(base, 0);
      base.scale.z = 0.0001;
      view.baseLines.forEach((l) => (l.material.opacity = 0));
      this.animator.add({
        duration: duration * 0.45,
        delay: startAt * 0.6,
        update: (k) => {
          base.scale.z = Math.max(0.0001, h * k);
          setMaterialsOpacity(base, k * 0.95);
          view.baseLines.forEach((l, i) => {
            l.material.opacity = k * (i % 2 ? 0.5 : 1);
            if (i % 2 === 0) l.position.z = h * k + view.unitHeight * 0.01;
          });
        },
      });
    }
    if (view.decor) {
      const decor = view.decor;
      decor.scale.setScalar(0.7);
      setMaterialsOpacity(decor, 0, true);
      this.animator.add({
        duration: duration * 0.9,
        delay: startAt * 0.5,
        update: (k) => {
          decor.scale.setScalar(0.7 + 0.3 * k);
          setMaterialsOpacity(decor, k, true);
        },
      });
    }
  }

  /** keepId:下钻目标在旧层级中的板块,保留到最后再淡出,形成"放大进入"的连续感。 */
  private exitView(view: LevelView, goingUp: boolean, keepId: string | null): void {
    const duration = this.options.transitionMs ?? 1200;
    for (const plate of view.plates.values()) {
      this.animator.cancel(`${view.uid}:h:${plate.region.id}`);
      this.animator.cancel(`${view.uid}:c:${plate.region.id}`);
    }
    view.points.visible = false;
    view.overlayGroup.visible = false;
    view.extraLines.visible = false;
    const heights = new Map([...view.plates.values()].map((p) => [p.region.id, p.mesh.scale.z]));
    this.animator.add({
      duration: duration * 0.6,
      update: (k) => {
        for (const plate of view.plates.values()) {
          const kept = plate.region.id === keepId;
          const local = kept ? Math.max(0, (k - 0.55) / 0.45) : Math.min(1, k * 1.5);
          const h = heights.get(plate.region.id)!;
          plate.mesh.scale.z = Math.max(0.0001, goingUp ? h * (1 - local) : kept ? h : h * (1 - local));
          this.setPlateOpacity(plate, view, 1 - local);
        }
        if (view.base) setMaterialsOpacity(view.base, 0.95 * (1 - k));
        view.baseLines.forEach((l, i) => (l.material.opacity = (i % 2 ? 0.5 : 1) * (1 - k)));
        if (view.decor) setMaterialsOpacity(view.decor, 1 - k, true);
      },
      done: () => this.disposeView(view),
    });
  }

  private setEntryOpacity(entry: OverlayEntry, transition: number, zoom: number): void {
    entry.transition = transition;
    entry.zoom = zoom;
    const k = transition * zoom;
    // 视距每帧都在变,只有明显变化(或到达端点)才下发,避免每帧遍历插件材质
    if (Math.abs(k - entry.applied) < 0.02 && k !== 0 && k !== 1) return;
    if (k === entry.applied) return;
    entry.applied = k;
    entry.instance.setOpacity?.(k);
  }

  /** 视距淡出:当前视距相对层级默认视距越近,叠加效果越淡。 */
  private applyZoomFade(): void {
    const fade = this.options.overlayZoomFade ?? [0.45, 0.2];
    if (!fade) return;
    const [full, gone] = fade;
    const distance = this.camera.position.distanceTo(this.cameraTarget);
    const factor = (home: number) => {
      const r = distance / Math.max(1e-9, home);
      const x = clamp01((r - gone) / Math.max(1e-6, full - gone));
      return x * x * (3 - 2 * x);
    };
    if (this.globe && this.globeOverlays.size) {
      const home = this.globePose();
      const k = factor(home.position.distanceTo(home.target));
      for (const entry of this.globeOverlays.values()) this.setEntryOpacity(entry, entry.transition, entry.zoomFade ? k : 1);
    }
    const view = this.view;
    if (view?.overlays.size) {
      view.homeDistance ??= (() => {
        const pose = this.planePose(view);
        return pose.position.distanceTo(pose.target);
      })();
      const k = factor(view.homeDistance);
      for (const entry of view.overlays.values()) this.setEntryOpacity(entry, entry.transition, entry.zoomFade ? k : 1);
    }
  }

  /** 整个层级视图的透明度(地球 ↔ 平面转场用)。 */
  private setViewOpacity(view: LevelView, k: number): void {
    for (const plate of view.plates.values()) this.setPlateOpacity(plate, view, k);
    for (const entry of view.overlays.values()) this.setEntryOpacity(entry, k, entry.zoom);
    if (view.base) setMaterialsOpacity(view.base, 0.95 * k);
    view.baseLines.forEach((l, i) => (l.material.opacity = (i % 2 ? 0.5 : 1) * k));
    view.extraLines.traverse((o) => {
      if (o instanceof Line2) o.material.opacity = 0.9 * k * view.labelAlpha;
    });
    if (view.decor) setMaterialsOpacity(view.decor, k * view.labelAlpha, true);
  }

  // ── 样式 ───────────────────────────────────────────────────────────────

  private sideMaterial(top: string, bottom: string, opacity: number, morph: MorphUniforms): THREE.ShaderMaterial {
    return bindMorphUniforms(
      new THREE.ShaderMaterial({
        vertexShader: SIDE_VERTEX,
        fragmentShader: SIDE_FRAGMENT,
        transparent: true,
        uniforms: {
          uTop: { value: new THREE.Color(top) },
          uBottom: { value: new THREE.Color(bottom) },
          uOpacity: { value: opacity },
        },
      }),
      morph,
    );
  }

  private line(flat: number[], color: string, width: number, opacity: number, morph: MorphUniforms): Line2 {
    const geometry = new LineGeometry();
    geometry.setPositions(flat);
    const material = applyLineMorph(
      new LineMaterial({ color: new THREE.Color(color).getHex(), linewidth: width, transparent: true, opacity, depthWrite: false }),
      morph,
    );
    material.resolution.set(this.size.width, this.size.height);
    const line = new Line2(geometry, material);
    line.computeLineDistances();
    line.renderOrder = 3;
    return line;
  }

  private paint(plate: Plate, view: LevelView, animate: boolean): void {
    const [top, side] = plate.mesh.material;
    const highlighted = plate.region.id === this.hovered || plate.region.id === this.selected || plate.region.id === this.highlighted;
    const target = highlighted ? plate.color.clone().lerp(new THREE.Color(this.theme.highlight), 0.4) : plate.color;
    const lift = highlighted ? view.unitHeight * 0.7 : 0;
    side.uniforms.uTop.value = new THREE.Color(highlighted ? this.theme.highlight : this.theme.accent);
    plate.lines.forEach((l) => {
      l.material.color = new THREE.Color(highlighted ? this.theme.highlight : this.theme.edge);
      l.material.linewidth = highlighted ? 2.6 : 1.4;
    });
    if (!animate) {
      top.color.copy(target);
      plate.lift = lift;
      plate.mesh.position.z = view.baseHeight + lift;
      return;
    }
    const fromColor = top.color.clone();
    const fromLift = plate.lift;
    this.animator.add(
      {
        duration: 260,
        update: (k) => {
          top.color.copy(fromColor).lerp(target, k);
          plate.lift = fromLift + (lift - fromLift) * k;
          plate.mesh.position.z = view.baseHeight + plate.lift;
        },
      },
      `${view.uid}:c:${plate.region.id}`,
    );
  }

  private setPlateOpacity(plate: Plate, view: LevelView, k: number): void {
    const [top, side] = plate.mesh.material;
    top.opacity = 0.96 * k;
    side.uniforms.uOpacity.value = 0.95 * k;
    plate.lines.forEach((l) => (l.material.opacity = 0.85 * k));
    if (plate.label) plate.label.element.style.opacity = String(k * view.labelAlpha);
  }

  private refresh(ids: Array<string | null>): void {
    const view = this.view;
    if (!view || this.mode !== "plane") return;
    for (const id of ids) {
      const plate = id ? view.plates.get(id) : undefined;
      if (plate) this.paint(plate, view, true);
    }
  }

  private updateCursor(): void {
    this.renderer.domElement.style.cursor = this.hovered || this.hoveredPoint ? "pointer" : this.mode === "globe" ? "grab" : "";
  }

  private setHoveredPoint(point: PointDatum | null): void {
    if ((point?.id ?? null) === (this.hoveredPoint?.id ?? null)) return;
    this.hoveredPoint = point;
    this.updateCursor();
    this.options.onPointHover?.(point);
  }

  private setHovered(id: string | null): void {
    if (id === this.hovered) return;
    const prev = this.hovered;
    this.hovered = id;
    if (this.mode === "globe") this.globe?.setHover(id);
    else this.refresh([prev, id]);
    this.updateCursor();
    this.options.engine.hover(id);
  }

  private setSelected(id: string | null): void {
    if (id === this.selected) return;
    const prev = this.selected;
    this.selected = id;
    this.refresh([prev, id]);
  }

  // ── 交互 ───────────────────────────────────────────────────────────────

  private setRay(event: MouseEvent): boolean {
    if (this.busy) return false;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    // 大屏画布整体按比例缩放:用实际显示尺寸换算 NDC
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return true;
  }

  private pickPoint(event: MouseEvent): PointDatum | null {
    if (!this.options.onPointClick && !this.options.onPointHover) return null;
    if (!this.setRay(event)) return null;
    if (this.mode === "globe") return this.globe?.pickPoint(this.raycaster) ?? null;
    if (!this.view || !this.view.points.visible) return null;
    const targets: THREE.Object3D[] = [];
    for (const g of this.view.points.children) {
      for (const child of g.children) {
        if (child.userData.point) targets.push(child);
      }
    }
    if (!targets.length) return null;
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    return (hit?.object.userData.point as PointDatum | undefined) ?? null;
  }

  private pick(event: MouseEvent): string | null {
    if (!this.setRay(event)) return null;
    if (this.mode === "globe") return this.globe?.pick(this.raycaster) ?? null;
    if (!this.view) return null;
    const meshes = [...this.view.plates.values()].map((p) => p.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    return (hit?.object.userData.regionId as string | undefined) ?? null;
  }

  private onPointerMove = (event: PointerEvent) => {
    if (this.drag && this.mode === "globe" && this.globe && !this.busy) {
      const dx = event.clientX - this.drag.x;
      const dy = event.clientY - this.drag.y;
      if (Math.hypot(dx, dy) > 3) this.drag.moved = true;
      if (this.drag.moved) {
        const [lng, lat] = this.globe.getAnchor();
        this.setAnchor([wrapLng(lng - dx * 0.3), Math.max(-60, Math.min(75, lat + dy * 0.3))], 0);
        this.drag.x = event.clientX;
        this.drag.y = event.clientY;
        return;
      }
    }
    if (this.options.onPointClick || this.options.onPointHover) this.setHoveredPoint(this.pickPoint(event));
    this.setHovered(this.pick(event));
  };
  private onPointerLeave = () => {
    this.setHoveredPoint(null);
    this.setHovered(null);
  };
  private onPointerDown = (event: PointerEvent) => {
    this.pointerDown = { x: event.clientX, y: event.clientY };
    if (this.mode === "globe") this.drag = { x: event.clientX, y: event.clientY, moved: false };
  };
  private onPointerUp = () => {
    this.drag = null;
  };
  private onClick = (event: MouseEvent) => {
    if (this.pointerDown && Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y) > 6) return;
    if (this.options.onPointClick) {
      const point = this.pickPoint(event);
      if (point) {
        this.options.onPointClick(point);
        return;
      }
    }
    const id = this.pick(event);
    if (id) void this.options.engine.activate(id);
    // 平面场景点空白处上卷(大屏 / 触屏上比右键、双击更易发现)
    else if (this.mode === "plane" && this.options.emptyClick === "drill-up") void this.options.engine.drill.drillUp();
  };
  private onDoubleClick = (event: MouseEvent) => {
    if (this.mode === "plane" && !(this.options.onPointClick && this.pickPoint(event)) && !this.pick(event)) void this.options.engine.drill.drillUp();
  };
  private onWebglLost = (event: Event) => {
    // 阻止默认行为,浏览器才会在条件允许时发出 restored
    event.preventDefault();
    if (this.contextLost) return;
    this.contextLost = true;
    console.warn("[geo-scene] WebGL 上下文丢失");
    this.options.onContextLost?.();
  };
  private onWebglRestored = () => {
    console.warn("[geo-scene] WebGL 上下文已恢复");
    this.options.onContextRestored?.();
  };
  /** 页面不可见(切到别的窗口 / 屏幕休眠)时停止渲染,恢复后时间轴不跳帧。 */
  private onVisibility = () => {
    if (this.disposed) return;
    if (document.hidden) {
      this.renderer.setAnimationLoop(null);
    } else {
      this.lastTick = performance.now();
      this.renderer.setAnimationLoop(this.loop);
    }
  };
  private onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    void this.options.engine.drill.drillUp();
  };

  // ── 渲染循环 ───────────────────────────────────────────────────────────

  private loop = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTick) / 1000);
    this.lastTick = now;
    const t = (now - this.startedAt) / 1000;
    if (dt > 0) this.fps = this.fps ? this.fps * 0.95 + (1 / dt) * 0.05 : 1 / dt;
    if (this.contextLost) return;
    this.animator.tick(now);
    this.applyZoomFade();

    if (this.globe && this.mode === "globe") {
      const speed = (this.options.globe as GlobeOptions).autoRotateDegPerSec ?? 6;
      // 聚焦某个区域时不自转,否则会把它转走
      if (speed && !this.busy && !this.drag && !this.hovered && !this.highlighted && !this.hoveredPoint && !this.globeFocusId) {
        const [lng, lat] = this.globe.getAnchor();
        this.setAnchor([wrapLng(lng + speed * dt), lat], 0);
      }
    }
    this.globe?.tick(t, this.camera);
    if (this.globe && (this.mode === "globe" || this.busy)) for (const entry of this.globeOverlays.values()) entry.instance.tick?.(t, dt);
    if (this.view?.overlayGroup.visible) for (const entry of this.view.overlays.values()) entry.instance.tick?.(t, dt);

    const view = this.view;
    if (view?.decor) {
      const scan = view.decor.getObjectByName("scan");
      if (scan) scan.rotation.z = -t * 0.5;
    }
    if (view) {
      for (const g of view.points.children) {
        const pulse = g.getObjectByName("pulse") as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | undefined;
        if (!pulse) continue;
        const k = (t * 0.7 + g.userData.phase) % 1;
        pulse.scale.setScalar(1 + k * 2.4);
        pulse.material.opacity = 0.75 * (1 - k);
        const plate = view.plates.get(g.userData.plateId);
        if (plate) g.position.z = view.baseHeight + plate.lift + plate.mesh.scale.z;
      }
    }
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
    if (++this.frameCount % LABEL_COLLISION_EVERY === 0) this.resolveLabelCollisions();
  };

  private resize(): void {
    const { clientWidth, clientHeight } = this.options.container;
    const width = Math.max(1, clientWidth);
    const height = Math.max(1, clientHeight);
    this.size = { width, height };
    this.renderer.setSize(width, height, false);
    this.labelRenderer.setSize(width, height);
    this.composer?.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.globe?.setResolution(width, height);
    if (this.view) this.view.homeDistance = undefined;
    this.scene.traverse((o) => {
      if (o instanceof Line2) o.material.resolution.set(width, height);
    });
    if (this.busy || this.animator.busy) return;
    if (this.mode === "globe") this.applyPose(this.globePose());
    else if (this.view) this.applyPose(this.planePose(this.view));
  }

  private disposeView(view: LevelView): void {
    for (const entry of view.overlays.values()) entry.instance.dispose();
    view.overlays.clear();
    for (const plate of view.plates.values()) {
      this.animator.cancel(`${view.uid}:h:${plate.region.id}`);
      this.animator.cancel(`${view.uid}:c:${plate.region.id}`);
    }
    view.group.removeFromParent();
    disposeObject(view.group);
  }
}

/** @deprecated 使用 GeoScene(不传 globe 即为纯平面场景)。 */
export const PlaneScene = GeoScene;

function wrapLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

function hashPhase(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((h >>> 0) % 1000) / 1000;
}

function setMaterialsOpacity(object: THREE.Object3D, k: number, relative = false): void {
  object.traverse((o) => {
    const mats = (o as THREE.Mesh).material;
    if (!mats) return;
    for (const m of [mats].flat()) {
      if (m instanceof THREE.ShaderMaterial && m.uniforms.uOpacity) {
        m.uniforms.uOpacity.value = k;
        continue;
      }
      if (relative) {
        m.userData.baseOpacity ??= m.opacity;
        m.opacity = m.userData.baseOpacity * k;
      } else {
        m.opacity = k;
      }
    }
  });
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((o) => {
    if (o instanceof CSS2DObject) o.element.remove();
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const mats = mesh.material;
    if (mats) for (const m of [mats].flat()) m.dispose();
  });
}
