import { Path, Shape, Vector2 } from "three";
import { createLocalProjection, type MultiPolygonCoords, type Position, type Ring } from "@yaoyu/geo-engine";

/**
 * 平面映射:经纬度 → 场景平面坐标(x 向东、y 向北,单位为场景单位)。
 * 以 center 为切点的方位等距投影再乘以 unitsPerRadian;坐标始终相对中心(RTC),下钻到地块级别也不丢精度。
 */
export interface PlaneMapper {
  center: Position;
  unitsPerRadian: number;
  project(p: Position): [number, number];
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
