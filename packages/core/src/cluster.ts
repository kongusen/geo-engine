import type { Position } from "@geodive/data";

export interface ClusterInput {
  id: string;
  position: Position;
  weight?: number;
}

export interface Cluster<T extends ClusterInput = ClusterInput> {
  /** 聚合中心(按权重加权平均)。 */
  position: Position;
  /** 成员数量。 */
  count: number;
  /** 权重之和(未提供权重时等于 count)。 */
  weight: number;
  members: T[];
}

/**
 * 网格聚合:按 cellSize(与坐标同单位)划分网格,同格点位合并为一个簇。
 * project 可把经纬度换算到平面坐标后再分格(避免高纬度经度方向格子过窄)。
 */
export function clusterPoints<T extends ClusterInput>(points: T[], cellSize: number, project: (p: Position) => [number, number] = (p) => p): Cluster<T>[] {
  if (cellSize <= 0) return points.map((p) => ({ position: p.position, count: 1, weight: p.weight ?? 1, members: [p] }));
  const cells = new Map<string, { sx: number; sy: number; weight: number; members: T[] }>();
  for (const point of points) {
    const [x, y] = project(point.position);
    const key = `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
    const w = point.weight ?? 1;
    const cell = cells.get(key) ?? { sx: 0, sy: 0, weight: 0, members: [] };
    cell.sx += point.position[0] * w;
    cell.sy += point.position[1] * w;
    cell.weight += w;
    cell.members.push(point);
    cells.set(key, cell);
  }
  return [...cells.values()].map((cell) => ({
    position: cell.weight ? [cell.sx / cell.weight, cell.sy / cell.weight] : cell.members[0].position,
    count: cell.members.length,
    weight: cell.weight,
    members: cell.members,
  }));
}
