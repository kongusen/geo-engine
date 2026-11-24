import type { BBox, MultiPolygonCoords, PolygonCoords, Position, Ring } from "./types";

const DEG = Math.PI / 180;
const EARTH_RADIUS_KM = 6371.0088;

/** 平面有符号面积(鞋带公式):正值为逆时针。 */
export function signedRingArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

export function isRingClosed(ring: Ring): boolean {
  if (ring.length === 0) return false;
  const a = ring[0];
  const b = ring[ring.length - 1];
  return a[0] === b[0] && a[1] === b[1];
}

export function closeRing(ring: Ring): Ring {
  return isRingClosed(ring) ? ring : [...ring, [ring[0][0], ring[0][1]]];
}

/** 将环调整为指定方向(ccw=true 为逆时针)。 */
export function orientRing(ring: Ring, ccw: boolean): Ring {
  const isCcw = signedRingArea(ring) > 0;
  return isCcw === ccw ? ring : [...ring].reverse();
}

/** RFC 7946:外环逆时针、洞顺时针。 */
export function rewindPolygon(polygon: PolygonCoords): PolygonCoords {
  return polygon.map((ring, index) => orientRing(ring, index === 0));
}

export function bboxOf(polygons: MultiPolygonCoords): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const polygon of polygons) {
    for (const [x, y] of polygon[0] ?? []) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return [minX, minY, maxX, maxY];
}

export function bboxUnion(boxes: BBox[]): BBox {
  return boxes.reduce<BBox>(
    (acc, b) => [Math.min(acc[0], b[0]), Math.min(acc[1], b[1]), Math.max(acc[2], b[2]), Math.max(acc[3], b[3])],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
}

export function bboxContainsPoint(bbox: BBox, [x, y]: Position): boolean {
  return x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3];
}

/** 射线法:点是否在环内(边界上的点结果不稳定,调用方不应依赖)。 */
export function pointInRing([x, y]: Position, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(point: Position, polygon: PolygonCoords): boolean {
  if (!polygon.length || !pointInRing(point, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i++) if (pointInRing(point, polygon[i])) return false;
  return true;
}

export function pointInMultiPolygon(point: Position, polygons: MultiPolygonCoords): boolean {
  return polygons.some((polygon) => pointInPolygon(point, polygon));
}

/** 单个多边形的净平面面积(外环减洞),单位:度²。 */
function planarPolygonArea(polygon: PolygonCoords): number {
  return polygon.reduce((sum, ring, i) => sum + (i === 0 ? 1 : -1) * Math.abs(signedRingArea(ring)), 0);
}

/** 近似球面面积(km²):按环的平均纬度做 cos 修正。对行政区尺度误差 <1%。 */
export function areaKm2(polygons: MultiPolygonCoords): number {
  let total = 0;
  for (const polygon of polygons) {
    const ring = polygon[0];
    if (!ring?.length) continue;
    const meanLat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    const k = (EARTH_RADIUS_KM * DEG) ** 2 * Math.cos(meanLat * DEG);
    total += planarPolygonArea(polygon) * k;
  }
  return total;
}

/** 面积加权质心(含洞扣减),可能落在凹多边形外部。 */
export function centroidOf(polygons: MultiPolygonCoords): Position {
  let cx = 0;
  let cy = 0;
  let total = 0;
  for (const polygon of polygons) {
    polygon.forEach((ring, ringIndex) => {
      const area = signedRingArea(ring);
      if (area === 0) return;
      let sx = 0;
      let sy = 0;
      for (let i = 0, n = ring.length - 1; i < n; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        const cross = x1 * y2 - x2 * y1;
        sx += (x1 + x2) * cross;
        sy += (y1 + y2) * cross;
      }
      const weight = (ringIndex === 0 ? 1 : -1) * Math.abs(area);
      cx += (sx / (6 * area)) * weight;
      cy += (sy / (6 * area)) * weight;
      total += weight;
    });
  }
  if (total === 0) {
    const ring = polygons[0]?.[0] ?? [];
    const n = Math.max(1, ring.length);
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / total, cy / total];
}

/** 水平扫描线与多边形外环/洞的交点 x 坐标(已排序)。 */
function scanlineIntersections(polygon: PolygonCoords, y: number): number[] {
  const xs: number[] = [];
  for (const ring of polygon) {
    for (let i = 0, n = ring.length - 1; i < n; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      if (y1 > y !== y2 > y) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
    }
  }
  return xs.sort((a, b) => a - b);
}

/**
 * 保证落在区域内部的锚点:质心在内就用质心;否则在若干条扫描线上取最宽内段的中点。
 * 用于标签位置、点击落点和空间包含推断。
 */
export function interiorPoint(polygons: MultiPolygonCoords): Position {
  const centroid = centroidOf(polygons);
  if (pointInMultiPolygon(centroid, polygons)) return centroid;
  // 取面积最大的多边形
  const main = [...polygons].sort((a, b) => planarPolygonArea(b) - planarPolygonArea(a))[0];
  if (!main) return centroid;
  const [, minY, , maxY] = bboxOf([main]);
  let best: { width: number; point: Position } | null = null;
  const lines = 15;
  for (let k = 1; k <= lines; k++) {
    const y = minY + ((maxY - minY) * k) / (lines + 1);
    const xs = scanlineIntersections(main, y);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const width = xs[i + 1] - xs[i];
      if (!best || width > best.width) best = { width, point: [(xs[i] + xs[i + 1]) / 2, y] };
    }
  }
  return best?.point ?? centroid;
}

/** 在区域内部均匀取样点(网格 + 锚点),用于空间包含推断。 */
export function samplePoints(polygons: MultiPolygonCoords, grid = 12): Position[] {
  const [minX, minY, maxX, maxY] = bboxOf(polygons);
  const out: Position[] = [];
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      const p: Position = [minX + ((maxX - minX) * (i + 0.5)) / grid, minY + ((maxY - minY) * (j + 0.5)) / grid];
      if (pointInMultiPolygon(p, polygons)) out.push(p);
    }
  }
  if (out.length < 4) out.push(interiorPoint(polygons));
  return out;
}

function perpendicularDistance([x, y]: Position, [x1, y1]: Position, [x2, y2]: Position): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(x - x1, y - y1);
  return Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1) / Math.hypot(dx, dy);
}

/** Douglas–Peucker 抽稀。闭合环在离起点最远处切成两段分别抽稀;结果退化(<4 点)则返回原环。 */
export function simplifyRing(ring: Ring, tolerance: number): Ring {
  if (tolerance <= 0 || ring.length <= 4) return ring;
  let result: Ring;
  if (isRingClosed(ring)) {
    let far = 0;
    let farIndex = 1;
    for (let i = 1; i < ring.length - 1; i++) {
      const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
      if (d > far) {
        far = d;
        farIndex = i;
      }
    }
    result = [...simplifyOpen(ring.slice(0, farIndex + 1), tolerance), ...simplifyOpen(ring.slice(farIndex), tolerance).slice(1)];
  } else {
    result = simplifyOpen(ring, tolerance);
  }
  return result.length >= 4 ? result : ring;
}

/** 开放折线 DP。 */
function simplifyOpen(line: Position[], tolerance: number): Position[] {
  if (line.length <= 2) return line;
  let maxDist = 0;
  let index = 0;
  for (let i = 1; i < line.length - 1; i++) {
    const d = perpendicularDistance(line[i], line[0], line[line.length - 1]);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist <= tolerance) return [line[0], line[line.length - 1]];
  return [...simplifyOpen(line.slice(0, index + 1), tolerance).slice(0, -1), ...simplifyOpen(line.slice(index), tolerance)];
}

export function simplifyPolygons(polygons: MultiPolygonCoords, tolerance: number): MultiPolygonCoords {
  if (tolerance <= 0) return polygons;
  return polygons.map((polygon) => polygon.map((ring) => simplifyRing(ring, tolerance)));
}

/** 跨 180° 经线的环展开为连续经度(可 >180 或 <-180),避免横贯全球的错误面。返回是否有改动。 */
export function unwrapRing(ring: Ring): { ring: Ring; changed: boolean } {
  let offset = 0;
  let changed = false;
  const out: Ring = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const prev = ring[i - 1][0];
    const cur = ring[i][0];
    if (cur - prev > 180) {
      offset -= 360;
      changed = true;
    } else if (prev - cur > 180) {
      offset += 360;
      changed = true;
    }
    out.push([cur + offset, ring[i][1]]);
  }
  return { ring: out, changed };
}

/**
 * 外轮廓线:去掉相邻多边形之间的共享边(出现两次的边),只保留外边界,并串成折线。
 * 用于由下级区域合成的上级区域(县 = 各乡镇之和、国家 = 各省之和)的描边。
 * decimals 为判定"同一点"的小数位(经纬度),默认 6(约 0.1m)。
 */
export function boundaryLines(polygons: MultiPolygonCoords, decimals = 6): Position[][] {
  const key = (p: Position) => `${p[0].toFixed(decimals)},${p[1].toFixed(decimals)}`;
  const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const count = new Map<string, number>();
  const edges: Array<[Position, Position, string, string]> = [];
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let i = 0; i + 1 < ring.length; i++) {
        const ka = key(ring[i]);
        const kb = key(ring[i + 1]);
        if (ka === kb) continue;
        const ek = edgeKey(ka, kb);
        count.set(ek, (count.get(ek) ?? 0) + 1);
        edges.push([ring[i], ring[i + 1], ka, kb]);
      }
    }
  }
  const outer = edges.filter(([, , ka, kb]) => count.get(edgeKey(ka, kb)) === 1);
  // 按端点串联成折线
  const byStart = new Map<string, Array<(typeof outer)[number]>>();
  for (const edge of outer) {
    const list = byStart.get(edge[2]) ?? [];
    list.push(edge);
    byStart.set(edge[2], list);
  }
  const used = new Set<(typeof outer)[number]>();
  const lines: Position[][] = [];
  for (const edge of outer) {
    if (used.has(edge)) continue;
    used.add(edge);
    const line: Position[] = [edge[0], edge[1]];
    let tail = edge[3];
    for (;;) {
      const next = byStart.get(tail)?.find((e) => !used.has(e));
      if (!next) break;
      used.add(next);
      line.push(next[1]);
      tail = next[3];
    }
    lines.push(line);
  }
  return lines;
}

/**
 * 外轮廓线(栅格法):把全部多边形栅格化为"是否在区域内"的网格,
 * 只保留法线一侧落在区域外的边。不要求相邻多边形共享顶点,
 * 适用于各自简化过、边界不完全吻合的数据(如各省合成国家、各国合成陆地海岸线)。
 * cells 为长边方向的网格数,越大越精细(默认 800)。
 */
export function outerOutline(polygons: MultiPolygonCoords, options: { cells?: number } = {}): Position[][] {
  if (!polygons.length) return [];
  const [minX, minY, maxX, maxY] = bboxOf(polygons);
  const cell = Math.max(maxX - minX, maxY - minY) / (options.cells ?? 800) || 1e-9;
  const ox = minX - 2 * cell;
  const oy = minY - 2 * cell;
  const cols = Math.ceil((maxX - minX) / cell) + 5;
  const rows = Math.ceil((maxY - minY) / cell) + 5;
  const grid = new Uint8Array(cols * rows);
  for (const polygon of polygons) {
    const [, pMinY, , pMaxY] = bboxOf([polygon]);
    const r0 = Math.max(0, Math.floor((pMinY - oy) / cell));
    const r1 = Math.min(rows - 1, Math.ceil((pMaxY - oy) / cell));
    for (let r = r0; r <= r1; r++) {
      const xs = scanlineIntersections(polygon, oy + (r + 0.5) * cell);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const c0 = Math.max(0, Math.ceil((xs[i] - ox) / cell - 0.5));
        const c1 = Math.min(cols - 1, Math.floor((xs[i + 1] - ox) / cell - 0.5));
        for (let c = c0; c <= c1; c++) grid[r * cols + c] = 1;
      }
    }
  }
  const inside = (x: number, y: number) => {
    const c = Math.floor((x - ox) / cell);
    const r = Math.floor((y - oy) / cell);
    return c >= 0 && r >= 0 && c < cols && r < rows && grid[r * cols + c] === 1;
  };
  const off = cell * 1.5;
  const lines: Position[][] = [];
  for (const polygon of polygons) {
    for (const ring of polygon) {
      let run: Position[] = [];
      for (let i = 0; i + 1 < ring.length; i++) {
        const a = ring[i];
        const b = ring[i + 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len === 0) continue;
        const nx = -(b[1] - a[1]) / len;
        const ny = (b[0] - a[0]) / len;
        const mx = (a[0] + b[0]) / 2;
        const my = (a[1] + b[1]) / 2;
        const exterior = !inside(mx + nx * off, my + ny * off) || !inside(mx - nx * off, my - ny * off);
        if (exterior) {
          if (!run.length) run.push(a);
          run.push(b);
        } else if (run.length) {
          lines.push(run);
          run = [];
        }
      }
      if (run.length) lines.push(run);
    }
  }
  return lines;
}
