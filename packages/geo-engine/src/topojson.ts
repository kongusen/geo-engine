import type { Position } from "./types";

/** TopoJSON 最小类型(只支持面要素需要的部分)。 */
export interface Topology {
  type: "Topology";
  arcs: Position[][];
  transform?: { scale: [number, number]; translate: [number, number] };
  objects: Record<string, TopoGeometry>;
}

export type TopoGeometry =
  | { type: "Polygon"; arcs: number[][]; id?: string | number; properties?: Record<string, unknown> }
  | { type: "MultiPolygon"; arcs: number[][][]; id?: string | number; properties?: Record<string, unknown> }
  | { type: "GeometryCollection"; geometries: TopoGeometry[]; id?: string | number; properties?: Record<string, unknown> }
  | { type: string; id?: string | number; properties?: Record<string, unknown>; [key: string]: unknown };

export type GeoJsonFeature = {
  type: "Feature";
  id?: string | number;
  properties: Record<string, unknown> | null;
  geometry: { type: string; coordinates?: unknown; geometries?: unknown[] } | null;
};

export function isTopology(input: unknown): input is Topology {
  return !!input && typeof input === "object" && (input as { type?: unknown }).type === "Topology";
}

/** 解码 arcs(处理量化 + 差分编码)。 */
function decodeArcs(topology: Topology): Position[][] {
  const t = topology.transform;
  if (!t) return topology.arcs;
  return topology.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * t.scale[0] + t.translate[0], y * t.scale[1] + t.translate[1]] as Position;
    });
  });
}

/** 把一组 arc 索引拼成环;负索引 ~i 表示反向使用第 i 条 arc。 */
function stitchRing(arcs: Position[][], indexes: number[]): Position[] {
  const ring: Position[] = [];
  for (const index of indexes) {
    const arc = index < 0 ? [...arcs[~index]].reverse() : arcs[index];
    arc.forEach((point, i) => {
      if (i === 0 && ring.length) return; // 相邻 arc 共享端点
      ring.push([point[0], point[1]]);
    });
  }
  return ring;
}

/** TopoJSON → GeoJSON Feature 列表。objectName 缺省时合并所有对象。 */
export function topologyToFeatures(topology: Topology, objectName?: string): GeoJsonFeature[] {
  const arcs = decodeArcs(topology);
  const names = objectName ? [objectName] : Object.keys(topology.objects);
  const features: GeoJsonFeature[] = [];

  const visit = (geom: TopoGeometry) => {
    const base = { type: "Feature" as const, id: geom.id, properties: geom.properties ?? {} };
    if (geom.type === "GeometryCollection") {
      (geom as { geometries: TopoGeometry[] }).geometries.forEach(visit);
    } else if (geom.type === "Polygon") {
      const rings = (geom as { arcs: number[][] }).arcs.map((r) => stitchRing(arcs, r));
      features.push({ ...base, geometry: { type: "Polygon", coordinates: rings } });
    } else if (geom.type === "MultiPolygon") {
      const polys = (geom as { arcs: number[][][] }).arcs.map((p) => p.map((r) => stitchRing(arcs, r)));
      features.push({ ...base, geometry: { type: "MultiPolygon", coordinates: polys } });
    } else {
      features.push({ ...base, geometry: { type: geom.type } });
    }
  };

  for (const name of names) {
    const object = topology.objects[name];
    if (!object) throw new Error(`TopoJSON 中不存在对象 "${name}"`);
    visit(object);
  }
  return features;
}
