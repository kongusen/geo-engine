import type { Position } from "./types";

/**
 * 支持的输入坐标系:
 * - wgs84:经纬度(CGCS2000 / EPSG:4490 与之差异 <0.1m,视为相同)
 * - gcj02:高德/腾讯"火星坐标",需要纠偏
 * - epsg3857:Web 墨卡托米制坐标
 * - affine:本地坐标(如从 SVG 描出的边界),由控制点配准得到仿射参数
 */
export type CrsSpec = "auto" | "wgs84" | "gcj02" | "epsg3857" | { affine: Affine };
export type DetectedCrs = "wgs84" | "epsg3857" | "unknown";

/** x' = a*x + b*y + c ; y' = d*x + e*y + f */
export type Affine = [number, number, number, number, number, number];

const R_MERC = 6378137;
const DEG = Math.PI / 180;

export function webMercatorToLngLat([x, y]: Position): Position {
  return [(x / R_MERC) / DEG, (2 * Math.atan(Math.exp(y / R_MERC)) - Math.PI / 2) / DEG];
}

export function lngLatToWebMercator([lng, lat]: Position): Position {
  return [lng * DEG * R_MERC, Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2)) * R_MERC];
}

// ── GCJ-02 ───────────────────────────────────────────────────────────────
const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;

function outOfChina([lng, lat]: Position): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  ret += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  ret += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return ret;
}

export function wgs84ToGcj02(p: Position): Position {
  if (outOfChina(p)) return p;
  const [lng, lat] = p;
  let dLat = transformLat(lng - 105, lat - 35);
  let dLng = transformLng(lng - 105, lat - 35);
  const radLat = lat * DEG;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [lng + dLng, lat + dLat];
}

/** 迭代反解,精度约 1e-7 度(厘米级)。 */
export function gcj02ToWgs84(p: Position): Position {
  if (outOfChina(p)) return p;
  let guess: Position = [p[0], p[1]];
  for (let i = 0; i < 10; i++) {
    const g = wgs84ToGcj02(guess);
    const dx = g[0] - p[0];
    const dy = g[1] - p[1];
    guess = [guess[0] - dx, guess[1] - dy];
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) break;
  }
  return guess;
}

// ── 仿射配准 ──────────────────────────────────────────────────────────────

export function applyAffine([a, b, c, d, e, f]: Affine, [x, y]: Position): Position {
  return [a * x + b * y + c, d * x + e * y + f];
}

function solve3(m: number[][], v: number[]): [number, number, number] {
  const det = (q: number[][]) =>
    q[0][0] * (q[1][1] * q[2][2] - q[1][2] * q[2][1]) -
    q[0][1] * (q[1][0] * q[2][2] - q[1][2] * q[2][0]) +
    q[0][2] * (q[1][0] * q[2][1] - q[1][1] * q[2][0]);
  const D = det(m);
  if (Math.abs(D) < 1e-12) throw new Error("控制点共线或重复,无法求解仿射参数");
  const col = (k: number) => m.map((row, i) => row.map((val, j) => (j === k ? v[i] : val)));
  return [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
}

export type ControlPoint = { source: Position; target: Position };

/**
 * 由 ≥3 个控制点(本地坐标 → 经纬度)最小二乘拟合仿射参数,并返回残差(度)。
 * 用于把 SVG / CAD 等本地坐标描出的边界配准到真实经纬度。
 */
export function fitAffine(points: ControlPoint[]): { affine: Affine; maxResidual: number } {
  if (points.length < 3) throw new Error("至少需要 3 个控制点");
  const ata = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const atx = [0, 0, 0];
  const aty = [0, 0, 0];
  for (const { source: [x, y], target: [tx, ty] } of points) {
    const row = [x, y, 1];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) ata[i][j] += row[i] * row[j];
      atx[i] += row[i] * tx;
      aty[i] += row[i] * ty;
    }
  }
  const [a, b, c] = solve3(ata, atx);
  const [d, e, f] = solve3(ata, aty);
  const affine: Affine = [a, b, c, d, e, f];
  const maxResidual = Math.max(
    ...points.map(({ source, target }) => {
      const [px, py] = applyAffine(affine, source);
      return Math.hypot(px - target[0], py - target[1]);
    }),
  );
  return { affine, maxResidual };
}

// ── 检测与转换 ────────────────────────────────────────────────────────────

/** 从 GeoJSON 旧式 crs 成员读取坐标系名称。 */
export function crsFromGeoJsonMember(crs: unknown): DetectedCrs | null {
  const name = (crs as { properties?: { name?: unknown } } | undefined)?.properties?.name;
  if (typeof name !== "string") return null;
  if (/3857|900913|3785/.test(name)) return "epsg3857";
  if (/4326|4490|CRS84|4610/.test(name)) return "wgs84";
  return "unknown";
}

/**
 * 根据坐标数值范围推断坐标系。GCJ-02 与 WGS84 数值上无法区分,需显式声明。
 * 绝对值 <1e5 且超出经纬度范围的,视为本地坐标(unknown),要求提供仿射配准。
 */
export function detectCrs(positions: Iterable<Position>): DetectedCrs {
  let maxAbsX = 0;
  let maxAbsY = 0;
  let count = 0;
  for (const [x, y] of positions) {
    maxAbsX = Math.max(maxAbsX, Math.abs(x));
    maxAbsY = Math.max(maxAbsY, Math.abs(y));
    count++;
  }
  if (count === 0) return "unknown";
  if (maxAbsX <= 540 && maxAbsY <= 90) return "wgs84"; // 允许展开后的经度
  if (maxAbsX <= 20037508.35 * 1.5 && maxAbsY <= 20037508.35 * 1.5 && Math.max(maxAbsX, maxAbsY) >= 1e5) return "epsg3857";
  return "unknown";
}

export function converterFor(crs: Exclude<CrsSpec, "auto"> | DetectedCrs): ((p: Position) => Position) | null {
  if (crs === "wgs84") return (p) => p;
  if (crs === "gcj02") return gcj02ToWgs84;
  if (crs === "epsg3857") return webMercatorToLngLat;
  if (typeof crs === "object") return (p) => applyAffine(crs.affine, p);
  return null;
}
