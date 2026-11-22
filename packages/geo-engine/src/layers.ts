import type { DrillState } from "./drill";
import type { SceneKind } from "./projection";

/** 图层在哪些下钻状态下可见。所有条件同时满足才可见;不配置即始终可见。 */
export interface LayerVisibility {
  minDepth?: number;
  maxDepth?: number;
  /** 当前聚焦区域的 level 标签(如 "county")。顶层(地球)的 level 为 "root"。 */
  levels?: string[];
  scenes?: SceneKind[];
  /** 自定义条件。 */
  when?: (ctx: LayerContext) => boolean;
}

export interface LayerContext {
  drill: DrillState;
  scene: SceneKind;
}

/**
 * 声明式图层描述。同一份描述在不同场景(球面 / 平面 / SVG)中由各自渲染器的实现解释,
 * 例如 choropleth 在球面是贴片、在平面是挤出板块、在 SVG 是平面填色。
 */
export interface LayerSpec<TData = unknown, TStyle = Record<string, unknown>> {
  id: string;
  /** 图层类型,对应渲染器中注册的实现(choropleth / outline / label / point / flow / heat ...)。 */
  type: string;
  zIndex?: number;
  visible?: LayerVisibility;
  data?: TData;
  style?: TStyle;
  /** 交互:是否可拾取(悬停/点击)。 */
  pickable?: boolean;
}

export function levelOf(drill: DrillState): string {
  return drill.path[drill.path.length - 1]?.level ?? (drill.path.length ? "unknown" : "root");
}

export function isLayerVisible(spec: LayerSpec, ctx: LayerContext): boolean {
  const v = spec.visible;
  if (!v) return true;
  const depth = ctx.drill.depth;
  if (v.minDepth !== undefined && depth < v.minDepth) return false;
  if (v.maxDepth !== undefined && depth > v.maxDepth) return false;
  if (v.levels && !v.levels.includes(levelOf(ctx.drill))) return false;
  if (v.scenes && !v.scenes.includes(ctx.scene)) return false;
  if (v.when && !v.when(ctx)) return false;
  return true;
}

export function activeLayers(specs: LayerSpec[], ctx: LayerContext): LayerSpec[] {
  return specs.filter((spec) => isLayerVisible(spec, ctx)).sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
}

export interface LayerDiff {
  /** 新出现的图层(淡入)。 */
  enter: LayerSpec[];
  /** 消失的图层(淡出)。 */
  exit: LayerSpec[];
  /** 两次都存在的图层(只更新数据/样式)。 */
  update: LayerSpec[];
}

/** 下钻切换时计算图层差量,渲染器据此做过渡而不是整体重建。 */
export function diffLayers(prev: LayerSpec[], next: LayerSpec[]): LayerDiff {
  const prevIds = new Set(prev.map((l) => l.id));
  const nextIds = new Set(next.map((l) => l.id));
  return {
    enter: next.filter((l) => !prevIds.has(l.id)),
    exit: prev.filter((l) => !nextIds.has(l.id)),
    update: next.filter((l) => prevIds.has(l.id)),
  };
}
