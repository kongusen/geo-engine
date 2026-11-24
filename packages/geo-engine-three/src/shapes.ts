import { BufferAttribute, BufferGeometry, ExtrudeGeometry, Path, Shape, Vector2 } from "three";
import { createLocalProjection, type MultiPolygonCoords, type Position, type Ring } from "@yaoyu/geo-engine";

/**
 * 平面映射:经纬度 → 场景平面坐标(x 向东、y 向北,单位为场景单位)。
 * 以 center 为切点的方位等距投影再乘以 unitsPerRadian;坐标始终相对中心(RTC),下钻到地块级别也不丢精度。
 */
export interface PlaneMapper {
  center: Position;
  unitsPerRadian: number;
  project(p: Position): [number, number];
  /** 平面坐标 → 经纬度。 */
  unproject(x: number, y: number): Position;
}

export function createPlaneMapper(center: Position, unitsPerRadian: number): PlaneMapper {
  const projection = createLocalProjection(center);
  return {
    center,
    unitsPerRadian,
    project(p) {
      const [x, y] = projection.forward(p);
      return [x * unitsPerRadian, y * unitsPerRadian];
    },
    unproject(x, y) {
      return projection.inverse([x / unitsPerRadian, y / unitsPerRadian]);
    },
  };
}

function ringPoints(ring: Ring, mapper: PlaneMapper): Vector2[] {
  // 闭合环最后一点与首点相同,three 的 Shape 不需要重复点
  const open = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
  return open.map((p) => {
    const [x, y] = mapper.project(p);
    return new Vector2(x, y);
  });
}

/** 区域多边形 → three Shape(含洞)。退化多边形被忽略。 */
export function regionShapes(polygons: MultiPolygonCoords, mapper: PlaneMapper): Shape[] {
  const shapes: Shape[] = [];
  for (const polygon of polygons) {
    const outer = ringPoints(polygon[0] ?? [], mapper);
    if (outer.length < 3) continue;
    const shape = new Shape(outer);
    shape.holes = polygon
      .slice(1)
      .map((ring) => ringPoints(ring, mapper))
      .filter((points) => points.length >= 3)
      .map((points) => new Path(points));
    shapes.push(shape);
  }
  return shapes;
}

/** 外环折线(闭合)的扁平坐标 [x,y,z, ...],用于 Line2 描边。 */
export function outlinePositions(polygons: MultiPolygonCoords, mapper: PlaneMapper, z: number): number[][] {
  return polygons
    .map((polygon) => polygon[0] ?? [])
    .filter((ring) => ring.length >= 4)
    .map((ring) => {
      const flat: number[] = [];
      for (const p of ring) {
        const [x, y] = mapper.project(p);
        flat.push(x, y, z);
      }
      return flat;
    });
}

/** 折线(经纬度)→ Line2 扁平坐标。 */
export function linePositions(lines: Position[][], mapper: PlaneMapper, z: number): number[][] {
  return lines
    .filter((line) => line.length >= 2)
    .map((line) => {
      const flat: number[] = [];
      for (const p of line) {
        const [x, y] = mapper.project(p);
        flat.push(x, y, z);
      }
      return flat;
    });
}

/**
 * 板块挤出几何(深度 1,由 mesh.scale.z 决定实际高度)。
 * 尺寸小于 fullSize 的部件(细小岛礁、飞地)按尺寸比例降低挤出深度(不低于 minDepth),
 * 否则整块按同一高度挤出后,小部件会变成又细又高的"针"。材质分组(0 顶/底面、1 侧面)保持不变。
 */
export function plateGeometry(shapes: Shape[], fullSize: number, minDepth = 0.12): BufferGeometry {
  const buckets = new Map<number, Shape[]>();
  for (const shape of shapes) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of shape.getPoints()) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const size = Math.max(maxX - minX, maxY - minY);
    // 量化到 0.1,同一深度的部件合并成一次挤出
    const depth = size >= fullSize ? 1 : Math.max(minDepth, Math.round((size / fullSize) * 10) / 10);
    buckets.set(depth, [...(buckets.get(depth) ?? []), shape]);
  }
  const parts = [...buckets].map(([depth, group]) => new ExtrudeGeometry(group, { depth, bevelEnabled: false }));
  if (parts.length === 1) return parts[0];
  const merged = mergeKeepingGroups(parts);
  for (const part of parts) part.dispose();
  return merged;
}

/** 合并非索引几何,保留各自的材质分组索引(BufferGeometryUtils.mergeGeometries 会按几何重新编组)。 */
function mergeKeepingGroups(parts: BufferGeometry[]): BufferGeometry {
  const out = new BufferGeometry();
  const names = Object.keys(parts[0].attributes);
  const total = parts.reduce((n, g) => n + g.attributes.position.count, 0);
  for (const name of names) {
    const itemSize = parts[0].attributes[name].itemSize;
    const array = new Float32Array(total * itemSize);
    let offset = 0;
    for (const g of parts) {
      array.set(g.attributes[name].array as Float32Array, offset * itemSize);
      offset += g.attributes[name].count;
    }
    out.setAttribute(name, new BufferAttribute(array, itemSize));
  }
  let offset = 0;
  for (const g of parts) {
    for (const group of g.groups) out.addGroup(offset + group.start, group.count, group.materialIndex);
    offset += g.attributes.position.count;
  }
  return out;
}
