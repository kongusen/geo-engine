import type { Position, TileSource } from "@geodive/data";
import type { ClassifyMethod } from "./binding";
import type { LayerSpec } from "./layers";

export type PlateMode = "solid" | "translucent" | "outline";

export interface PlateStyleOptions {
  /** 板块呈现模式:solid(实心统计板块)、translucent(半透明兼顾底图)、outline(镂空轮廓完整透出真实底图)。 */
  mode?: PlateMode;
  fillOpacity?: number;
  sideOpacity?: number;
  baseOpacity?: number;
  edgeOpacity?: number;
  hoverFillOpacity?: number;
  /** 是否压平板块与底板(outline 默认 true,便于精准对齐详图与点位)。 */
  flat?: boolean;
  /** 是否显示底部扫描环与参考网格(outline 默认 false)。 */
  showDecor?: boolean;
}

/** type: "choropleth" —— 板块填色 / 挤出。 */
export interface ChoroplethLayerData {
  /** 区域 id → 数值。 */
  values: Record<string, number>;
  unit?: string;
  /** 分级方式;缺省时 ≥5 个值用分位数(拉开色差),否则线性。 */
  method?: ClassifyMethod;
  /** 板块高度随数值变化(默认 true)。 */
  extrudeByValue?: boolean;
  /** 显式值域 [min, max],用于在稀疏或全部值相同时保持稳定色阶。 */
  domain?: [number, number];
  /** 无 domain 且所有有效数值相等时,归一化位置(0..1,默认 0.55)。 */
  flatPosition?: number;
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
  /** 单个点位尺寸倍率,默认 1。 */
  size?: number;
  /** 业务透传元数据(点击/悬停事件中原样回传)。 */
  meta?: Record<string, unknown>;
}

/** type: "point" —— 点位(企业、基地、门店)。平面场景只显示落在当前板块内的点。 */
export interface PointLayerData {
  points: PointDatum[];
  /** 图层点位整体尺寸倍率,默认 1。 */
  size?: number;
  /** 球头最小屏幕直径(CSS 像素,默认 8;0 表示不保底)。 */
  minPixelSize?: number;
}

/** type: "line" —— 线状装饰(如南海九段线),画在当前底板上。 */
export interface LineLayerData {
  lines: Position[][];
  color?: string;
  width?: number;
}

export interface FlowDatum {
  from: Position;
  to: Position;
  /** 数值:决定线宽(按本图层最大值归一)。 */
  value?: number;
  color?: string;
}

/** type: "flow" —— OD 飞线(原料调度、物流、客源),彗星拖尾沿弧线流动。 */
export interface FlowLayerData {
  flows: FlowDatum[];
  color?: string;
  /** 每秒流动圈数,默认 0.45。 */
  speed?: number;
  /** 弧高(相对两端距离),默认 0.28。 */
  arcHeight?: number;
  /** 线宽系数,默认 1。 */
  width?: number;
  /** 拖尾长度(占全程比例),默认 0.28。 */
  trail?: number;
  /** 终点涟漪,默认 true。 */
  endpoints?: boolean;
}

export interface BarDatum {
  /** 直接给位置,或给区域 id(取区域锚点)。 */
  position?: Position;
  regionId?: string;
  value: number;
  label?: string;
  color?: string;
}

/** type: "bar" —— 3D 数值柱(区域产值、企业规模)。 */
export interface BarLayerData {
  bars: BarDatum[];
  /** 最高柱高(相对特征长度),默认 0.32。 */
  maxHeight?: number;
  /** 柱宽(相对特征长度),默认 0.022。 */
  width?: number;
  color?: string;
  unit?: string;
  /** 柱顶显示数值,默认 true。 */
  showValue?: boolean;
  format?: (value: number, unit?: string) => string;
}

export interface HeatDatum {
  position: Position;
  weight?: number;
}

/** type: "heat" —— 核密度热力图(产量分布、客流密度),铺在当前层级上方。仅平面模式。 */
export interface HeatLayerData {
  points: HeatDatum[];
  /** 影响半径(相对特征长度),默认 0.12。 */
  radius?: number;
  /** 色带(由低到高);默认 主色 → 黄 → 橙 → 红。 */
  colors?: string[];
  /** 整体不透明度,默认 0.85。 */
  opacity?: number;
  /** 网格分辨率(长边格数),默认 220。 */
  resolution?: number;
}

export interface RippleDatum {
  position: Position;
  color?: string;
  /** 尺寸系数,默认 1。 */
  size?: number;
  label?: string;
}

/** type: "ripple" —— 扩散波纹(告警、重点区域强调)。 */
export interface RippleLayerData {
  points: RippleDatum[];
  /** 同时存在的波纹圈数,默认 3。 */
  rings?: number;
  /** 每秒扩散周期数,默认 0.5。 */
  speed?: number;
  color?: string;
}

export interface ClusterDatum {
  id: string;
  name?: string;
  position: Position;
  weight?: number;
}

/** type: "cluster" —— 点位聚合(企业 / 门店较密时),气泡大小与数量相关。 */
export interface ClusterLayerData {
  points: ClusterDatum[];
  /** 聚合格大小(相对特征长度),默认 0.12;下钻后特征长度变小,聚合自然展开。 */
  cellSize?: number;
  color?: string;
  /** 单点(未聚合)时显示名称,默认 false。 */
  showNames?: boolean;
}

/** 底图着色:把彩色瓦片调成与大屏主题协调的色调。所有分量 0~1。 */
export interface BasemapStyle {
  /** 整体不透明度,缺省 1。 */
  opacity?: number;
  /** 反相(浅色矢量底图配深色主题时用),缺省 0。 */
  invert?: number;
  /** 去色,缺省 0。 */
  grayscale?: number;
  /** 着色:颜色字符串,或 "accent" 跟随主题主色;null 不着色(缺省)。 */
  tint?: string | null;
  /** 着色强度,缺省 0.6。 */
  tintAmount?: number;
  /** 亮度系数,缺省 1。 */
  brightness?: number;
  /**
   * 输出亮度上限,缺省 0.6。场景泛光的阈值为 0.7,底图作为背景不应参与泛光,
   * 否则浅色底图会整片过曝;关闭泛光(bloom: false)的场景可设为 1。
   */
  maxLuminance?: number;
}

/** type: "basemap" —— 栅格瓦片底图(仅平面场景)。 */
export interface BasemapLayerData {
  /** 瓦片图层栈,自下而上(如天地图底图 + 注记)。 */
  sources: TileSource[];
  style?: BasemapStyle;
  /** 铺设范围:当前层级范围的倍数,缺省 3(大于视野时按视野裁剪)。 */
  extent?: number;
  /** 级别偏移:正数更清晰(瓦片更多),缺省 0。 */
  zoomOffset?: number;
  /** 每个图层每级最多瓦片数,超过时自动降级,缺省 80。 */
  maxTiles?: number;
  /** 当此底图图层激活且场景 plateStyle 为 "auto" 时使用的板块样式(缺省:有 choropleth 用 "translucent",否则 "outline")。 */
  plateStyle?: PlateMode | PlateStyleOptions;
}

export type MarkerShape = "pin" | "circle" | "diamond" | "square" | "triangle";

export interface MarkerDatum {
  id: string;
  position: Position;
  name?: string;
  /** 业务分类(如 "camera" / "bayonet" / "alarm"),便于业务层区分图标与筛选。 */
  category?: string;
  /** 自定义图标(图片 URL 或内联 SVG 字符串 `<svg...`)。 */
  icon?: string;
  /** 内置几何图标形状(未传 icon 时生效),默认 "pin"。 */
  shape?: MarkerShape;
  color?: string;
  /** 图标屏幕尺寸(CSS 像素),默认 28。 */
  sizePx?: number;
  /** 角标/简短文字(如数字或状态徽标)。 */
  badge?: string;
  label?: string;
  /** 地表之上的额外抬高(场景单位)。 */
  zOffset?: number;
  /** 激活/重点态(略微放大并高亮外环)。 */
  active?: boolean;
  /** 业务透传元数据(点击/悬停事件中原样回传)。 */
  meta?: Record<string, unknown>;
}

/** type: "marker" —— 可自定义图标/多分类交互点位(Sprite 渲染,支持点击/悬停拾取与固定屏幕像素尺寸)。 */
export interface MarkerLayerData {
  markers: MarkerDatum[];
  /** 图层默认图标 URL 或内联 SVG。 */
  icon?: string;
  /** 图层默认形状,默认 "pin"。 */
  shape?: MarkerShape;
  color?: string;
  /** 图层默认屏幕尺寸(CSS 像素),默认 28。 */
  sizePx?: number;
  /** 是否按当前板块边界裁剪点位;默认 false(详图底图模式下允许边界周边点位显示)。 */
  clipToRegions?: boolean;
  /** 仅在悬停或 active 时显示文字标签,默认 false。 */
  labelOnHover?: boolean;
}

export interface LayerDataMap {
  choropleth: ChoroplethLayerData;
  label: LabelLayerData;
  point: PointLayerData;
  marker: MarkerLayerData;
  line: LineLayerData;
  flow: FlowLayerData;
  bar: BarLayerData;
  heat: HeatLayerData;
  ripple: RippleLayerData;
  cluster: ClusterLayerData;
  basemap: BasemapLayerData;
}

export type BuiltinLayerSpec = {
  [K in keyof LayerDataMap]: LayerSpec<LayerDataMap[K]> & { type: K };
}[keyof LayerDataMap];

export type AnyLayerSpec = BuiltinLayerSpec | LayerSpec;

/** 创建强类型图层规格,写内置 type 时自动推断 data 类型;亦支持自定义插件 type。 */
export function createLayer<K extends keyof LayerDataMap>(
  type: K,
  spec: Omit<LayerSpec<LayerDataMap[K]>, "type">,
): LayerSpec<LayerDataMap[K]> & { type: K };
export function createLayer<TData = unknown, TStyle = Record<string, unknown>>(
  type: string,
  spec: Omit<LayerSpec<TData, TStyle>, "type">,
): LayerSpec<TData, TStyle>;
export function createLayer(type: string, spec: Omit<LayerSpec, "type">): LayerSpec {
  return { ...spec, type };
}
