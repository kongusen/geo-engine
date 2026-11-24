import type { BBox, Position } from "./types";

/**
 * 栅格瓦片底图描述。只描述"瓦片在哪、是什么坐标",怎么选瓦片、怎么画由渲染层负责。
 * 天地图 / 高德 / 任意 XYZ 服务都归一为这个结构;也可以用 load 接管请求(鉴权、离线包、自绘)。
 */
export interface TileSource {
  id: string;
  /** 地址模板({z} {x} {y} {s})或函数。 */
  url: string | ((z: number, x: number, y: number) => string);
  /** {s} 轮换的子域。 */
  subdomains?: string[];
  /** 瓦片矩阵:webmercator(EPSG:3857,最常见)或 geographic(经纬度,天地图 _c 系列)。缺省 webmercator。 */
  matrix?: "webmercator" | "geographic";
  /** 行号方向:xyz 自上而下(缺省),tms 自下而上。 */
  scheme?: "xyz" | "tms";
  tileSize?: number;
  minZoom?: number;
  maxZoom?: number;
  /**
   * 瓦片内容的坐标系。高德 / 腾讯为 gcj02,渲染时逐顶点纠偏,才能与 WGS84 的区域边界对齐。
   * 天地图(CGCS2000)与 WGS84 差异在厘米级,按 wgs84 处理。
   */
  crs?: "wgs84" | "gcj02";
  /** 数据版权 / 审图号,显示在画面角标。 */
  attribution?: string;
  /** 自定义加载(返回可作纹理的图像)。缺省按 url 以 CORS 方式请求。 */
  load?: (tile: TileCoord, signal: AbortSignal) => Promise<TexImageSource>;
}

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

/** 浏览器 / OffscreenCanvas 都可用的图像类型。 */
export type TexImageSource = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas;

const MAX_LAT = 85.0511287798066;
const DEG = Math.PI / 180;

/** 瓦片地址(处理模板与子域轮换)。 */
export function tileUrl(source: TileSource, { z, x, y }: TileCoord): string {
  const row = source.scheme === "tms" ? tileRows(source, z) - 1 - y : y;
  if (typeof source.url === "function") return source.url(z, x, row);
  const subs = source.subdomains ?? [];
  const s = subs.length ? subs[Math.abs(x + row) % subs.length] : "";
  return source.url.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(row)).replace("{s}", s);
}

function tileCols(source: TileSource, z: number): number {
  return 2 ** z;
}

function tileRows(source: TileSource, z: number): number {
  return source.matrix === "geographic" ? Math.max(1, 2 ** (z - 1)) : 2 ** z;
}

/** 瓦片内归一化坐标 (u, v)(左上为 0,0)→ 经纬度(瓦片自身坐标系,未纠偏)。 */
export function tileToLngLat(source: TileSource, { z, x, y }: TileCoord, u = 0, v = 0): Position {
  const fx = (x + u) / tileCols(source, z);
  const fy = (y + v) / tileRows(source, z);
  const lng = fx * 360 - 180;
  if (source.matrix === "geographic") return [lng, 90 - fy * 180];
  const n = Math.PI * (1 - 2 * fy);
  return [lng, Math.atan(Math.sinh(n)) / DEG];
}

/** 经纬度 → 所在瓦片(浮点,整数部分为瓦片号)。 */
export function lngLatToTile(source: TileSource, [lng, lat]: Position, z: number): [number, number] {
  const fx = ((lng + 180) / 360) * tileCols(source, z);
  if (source.matrix === "geographic") return [fx, ((90 - lat) / 180) * tileRows(source, z)];
  const phi = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * DEG;
  const fy = ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * tileRows(source, z);
  return [fx, fy];
}

/** 覆盖 bbox 的瓦片列表(按与中心的距离排序,近处先加载)。 */
export function tilesInBBox(source: TileSource, bbox: BBox, z: number): TileCoord[] {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const [x0, y0] = lngLatToTile(source, [minLng, maxLat], z);
  const [x1, y1] = lngLatToTile(source, [maxLng, minLat], z);
  const cols = tileCols(source, z);
  const rows = tileRows(source, z);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const out: TileCoord[] = [];
  for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(rows - 1, Math.floor(y1)); y++) {
    for (let x = Math.floor(x0); x <= Math.floor(x1); x++) out.push({ z, x: ((x % cols) + cols) % cols, y });
  }
  return out.sort((a, b) => Math.hypot(a.x + 0.5 - cx, a.y + 0.5 - cy) - Math.hypot(b.x + 0.5 - cx, b.y + 0.5 - cy));
}

/**
 * 让瓦片像素约等于屏幕像素的缩放级别(浮点)。
 * metersPerPixel 为屏幕上每 CSS 像素对应的地面米数,lat 为该处纬度。
 */
export function zoomForResolution(source: TileSource, metersPerPixel: number, lat: number): number {
  const size = source.tileSize ?? 256;
  const circumference = 2 * Math.PI * 6378137;
  const scale = source.matrix === "geographic" ? 1 : Math.cos(lat * DEG);
  return Math.log2((circumference * scale) / (size * Math.max(1e-9, metersPerPixel)));
}

// ── 服务商 ───────────────────────────────────────────────────────────────

export type TiandituLayer = "vec" | "img" | "ter";

export interface TiandituOptions {
  /** 天地图开发者 key(浏览器端 key 需在控制台配置域名白名单)。 */
  key: string;
  /** vec 矢量(缺省)/ img 影像 / ter 地形。 */
  layer?: TiandituLayer;
  /** 叠加对应的注记层(缺省 true)。 */
  label?: boolean;
  /** w = 球面墨卡托(缺省),c = 经纬度。 */
  matrix?: "w" | "c";
  /** 角标文字。公开发布须按天地图当年公布的审图号填写,如 "© 天地图 GS(XXXX)XXXX号"。 */
  attribution?: string;
}

const TIANDITU_LABEL: Record<TiandituLayer, string> = { vec: "cva", img: "cia", ter: "cta" };

/** 天地图(底图 + 可选注记,返回自下而上的图层栈)。 */
export function tianditu(options: TiandituOptions): TileSource[] {
  const layer = options.layer ?? "vec";
  const m = options.matrix ?? "w";
  const make = (name: string): TileSource => ({
    id: `tianditu-${name}_${m}`,
    url: `https://t{s}.tianditu.gov.cn/${name}_${m}/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${name}&STYLE=default&TILEMATRIXSET=${m}&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${encodeURIComponent(options.key)}`,
    subdomains: ["0", "1", "2", "3", "4", "5", "6", "7"],
    matrix: m === "c" ? "geographic" : "webmercator",
    minZoom: 1,
    maxZoom: 18,
    crs: "wgs84",
    attribution: options.attribution ?? "© 天地图",
  });
  const stack = [make(layer)];
  if (options.label ?? true) stack.push({ ...make(TIANDITU_LABEL[layer]), attribution: undefined });
  return stack;
}

export interface AmapOptions {
  /** vec 矢量(缺省)/ img 影像(无注记)。 */
  layer?: "vec" | "img";
  attribution?: string;
}

/** 高德瓦片(GCJ-02,渲染时自动纠偏)。商用前请确认高德的服务条款。 */
export function amapTiles(options: AmapOptions = {}): TileSource[] {
  const img = options.layer === "img";
  return [
    {
      id: img ? "amap-img" : "amap-vec",
      url: img
        ? "https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}"
        : "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
      subdomains: ["1", "2", "3", "4"],
      minZoom: 3,
      maxZoom: 18,
      crs: "gcj02",
      attribution: options.attribution ?? "© 高德地图",
    },
  ];
}

/** 任意 XYZ 服务。 */
export function xyzTiles(url: string, options: Omit<TileSource, "id" | "url"> & { id?: string } = {}): TileSource[] {
  return [{ id: options.id ?? "xyz", url, ...options }];
}
