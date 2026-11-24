import { pointInMultiPolygon, type BBox, type Position, type Region } from "@yaoyu/geo-data";

/**
 * 坐标约定(与 three.js 一致,y 轴向上):
 * - 球面:单位球,lng=0,lat=0 朝向 +z,北极 +y,东经 90° 朝向 +x。
 * - 平面:以 center 为原点的方位等距投影(单位:地球半径),x 向东、y 向北。
 *   方位投影本质上就是"把球面在切点处摊开",与球面位置做插值即可得到 地球 ↔ 平面 的变形动画。
 * - 局部坐标始终相对当前聚焦区域中心(RTC),保证下钻到地块级别时 float32 仍有足够精度。
 */

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

export function lngLatToSphere([lng, lat]: Position, radius = 1): Vec3 {
  const l = lng * DEG;
  const p = lat * DEG;
  return [radius * Math.cos(p) * Math.sin(l), radius * Math.sin(p), radius * Math.cos(p) * Math.cos(l)];
}

export function sphereToLngLat([x, y, z]: Vec3): Position {
  const r = Math.hypot(x, y, z);
  return [Math.atan2(x, z) / DEG, Math.asin(y / r) / DEG];
}

/** 两点间大圆角距(弧度)。 */
export function angularDistance(a: Position, b: Position): number {
  const [l1, p1] = [a[0] * DEG, a[1] * DEG];
  const [l2, p2] = [b[0] * DEG, b[1] * DEG];
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function distanceMeters(a: Position, b: Position): number {
  return angularDistance(a, b) * EARTH_RADIUS_M;
}

/** 大圆插值,t ∈ [0,1](球面飞线、相机沿球面飞行)。 */
export function greatCircle(a: Position, b: Position, t: number): Position {
  const d = angularDistance(a, b);
  if (d === 0) return a;
  const va = lngLatToSphere(a);
  const vb = lngLatToSphere(b);
  const s = Math.sin(d);
  const ka = Math.sin((1 - t) * d) / s;
  const kb = Math.sin(t * d) / s;
  return sphereToLngLat([ka * va[0] + kb * vb[0], ka * va[1] + kb * vb[1], ka * va[2] + kb * vb[2]]);
}

/** 切点处的局部正交基:east / north / up(单位向量)。 */
export function tangentFrame(center: Position): { east: Vec3; north: Vec3; up: Vec3 } {
  const l = center[0] * DEG;
  const p = center[1] * DEG;
  return {
    east: [Math.cos(l), 0, -Math.sin(l)],
    north: [-Math.sin(p) * Math.sin(l), Math.cos(p), -Math.sin(p) * Math.cos(l)],
    up: lngLatToSphere(center),
  };
}

export interface LocalProjection {
  center: Position;
  /** 经纬度 → 平面坐标(单位:地球半径)。 */
  forward(p: Position): Vec2;
  inverse(v: Vec2): Position;
  /** 平面坐标对应的 3D 切平面位置(球面坐标系中,切于 center)。 */
  toTangent3D(v: Vec2, radius?: number): Vec3;
}

/** 以 center 为切点的方位等距投影。 */
export function createLocalProjection(center: Position): LocalProjection {
  const l0 = center[0] * DEG;
  const p0 = center[1] * DEG;
  const sinP0 = Math.sin(p0);
  const cosP0 = Math.cos(p0);
  const frame = tangentFrame(center);

  const forward = ([lng, lat]: Position): Vec2 => {
    const l = lng * DEG - l0;
    const p = lat * DEG;
    const cosC = sinP0 * Math.sin(p) + cosP0 * Math.cos(p) * Math.cos(l);
    const c = Math.acos(Math.max(-1, Math.min(1, cosC)));
    const k = c === 0 ? 1 : c / Math.sin(c);
    return [k * Math.cos(p) * Math.sin(l), k * (cosP0 * Math.sin(p) - sinP0 * Math.cos(p) * Math.cos(l))];
  };

  const inverse = ([x, y]: Vec2): Position => {
    const c = Math.hypot(x, y);
    if (c === 0) return [center[0], center[1]];
    const sinC = Math.sin(c);
    const cosC = Math.cos(c);
    const p = Math.asin(cosC * sinP0 + (y * sinC * cosP0) / c);
    const l = l0 + Math.atan2(x * sinC, c * cosP0 * cosC - y * sinP0 * sinC);
    return [l / DEG, p / DEG];
  };

  const toTangent3D = ([x, y]: Vec2, radius = 1): Vec3 => {
    const { east, north, up } = frame;
    return [
      radius * (up[0] + east[0] * x + north[0] * y),
      radius * (up[1] + east[1] * x + north[1] * y),
      radius * (up[2] + east[2] * x + north[2] * y),
    ];
  };

  return { center, forward, inverse, toTangent3D };
}

/** 球面 ↔ 切平面 变形插值,t=0 为球面、t=1 为平面。着色器中等价于 mix(spherePos, planePos, t)。 */
export function morph(sphere: Vec3, plane: Vec3, t: number): Vec3 {
  return [sphere[0] + (plane[0] - sphere[0]) * t, sphere[1] + (plane[1] - sphere[1]) * t, sphere[2] + (plane[2] - sphere[2]) * t];
}

// ── 视角 ──────────────────────────────────────────────────────────────────

export type SceneKind = "globe" | "plane";

export interface ViewTarget {
  scene: SceneKind;
  center: Position;
  /** 区域角半径(弧度),渲染器据此计算相机距离。 */
  angularRadius: number;
}

export interface SceneThresholds {
  /** 区域角半径超过该值(度)使用球面场景,默认 40°:国家尺度(中国约 31°)用平面板块,洲际以上用地球。 */
  globeAboveDegrees?: number;
}

/** bbox 的视觉中心与角半径(按四角与边中点到中心的最大角距估算)。 */
export function bboxView(bbox: BBox): { center: Position; angularRadius: number } {
  const [minX, minY, maxX, maxY] = bbox;
  const center: Position = [(minX + maxX) / 2, (minY + maxY) / 2];
  const probes: Position[] = [
    [minX, minY],
    [minX, maxY],
    [maxX, minY],
    [maxX, maxY],
    [center[0], minY],
    [center[0], maxY],
    [minX, center[1]],
    [maxX, center[1]],
  ];
  return { center, angularRadius: Math.max(...probes.map((p) => angularDistance(center, p))) };
}

/** 根据区域大小决定使用球面还是平面场景。focus 为 null(全球)时总是球面。 */
export function viewFor(bbox: BBox | null, thresholds: SceneThresholds = {}): ViewTarget {
  if (!bbox) return { scene: "globe", center: [105, 30], angularRadius: Math.PI / 2 };
  const { center, angularRadius } = bboxView(bbox);
  const limit = (thresholds.globeAboveDegrees ?? 40) * DEG;
  return { scene: angularRadius > limit ? "globe" : "plane", center, angularRadius };
}

/**
 * 区域的视图目标。外接矩形中心落在区域之外时(如美国含阿拉斯加、夏威夷,外接矩形中心在太平洋),
 * 改用面积加权质心;质心也在区域外时用内部点。角半径按新中心重新估算。
 */
export function viewForRegion(region: Pick<Region, "bbox" | "polygons" | "centroid" | "anchor">, thresholds: SceneThresholds = {}): ViewTarget {
  const base = viewFor(region.bbox, thresholds);
  if (pointInMultiPolygon(base.center, region.polygons)) return base;
  const center = pointInMultiPolygon(region.centroid, region.polygons) ? region.centroid : region.anchor;
  const [minX, minY, maxX, maxY] = region.bbox;
  const probes: Position[] = [
    [minX, minY],
    [minX, maxY],
    [maxX, minY],
    [maxX, maxY],
    [center[0], minY],
    [center[0], maxY],
    [minX, center[1]],
    [maxX, center[1]],
  ];
  const angularRadius = Math.max(...probes.map((p) => angularDistance(center, p)));
  const limit = (thresholds.globeAboveDegrees ?? 40) * DEG;
  return { scene: angularRadius > limit ? "globe" : "plane", center, angularRadius };
}

/**
 * 透视相机到目标的距离,使半径为 r 的区域刚好填满视口(fovY 为垂直视场角,度)。
 * 平面场景中 r 为平面坐标半径;球面场景返回的是相机到球心的距离。
 */
export function cameraDistance(radius: number, fovYDeg: number, aspect: number, padding = 1.1, scene: SceneKind = "plane"): number {
  const fovY = fovYDeg * DEG;
  const fovX = 2 * Math.atan(Math.tan(fovY / 2) * aspect);
  const fov = Math.min(fovX, fovY);
  if (scene === "globe") {
    // 单位球上角半径为 radius 的球冠:可见弦半宽 sin(r),距球面 1-cos(r)
    const half = Math.sin(Math.min(radius, Math.PI / 2)) * padding;
    return half / Math.tan(fov / 2) + Math.cos(Math.min(radius, Math.PI / 2));
  }
  return (radius * padding) / Math.tan(fov / 2);
}

/** 缓动 */
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
