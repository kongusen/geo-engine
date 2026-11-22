import { bboxContainsPoint, pointInMultiPolygon, samplePoints } from "./geometry";
import { toRegion } from "./ingest";
import type { GeoIssue, Position, Region, RegionInput } from "./types";

export interface AddRegionsOptions {
  /**
   * 缺少父级时按空间包含关系推断父级(默认 true)。
   * 子区域内部采样点落入候选父区域的比例 ≥ containment 即视为包含,多个候选取面积最小者(最近一级)。
   */
  inferParents?: boolean;
  /** 包含判定阈值,默认 0.9(容忍边界数据不完全吻合)。 */
  containment?: number;
}

const normalizeName = (name: string) => name.replace(/\s+/g, "").toLowerCase();

/**
 * 区域树:任意深度,叶子即"最小级"。按编码维护父子关系,支持名称/别名解析、
 * 路径(面包屑)查询、点定位,以及无编码数据的空间包含推断。
 */
export class RegionTree {
  private regions = new Map<string, Region>();
  private childIds = new Map<string | null, string[]>();
  private nameIndex = new Map<string, string[]>();

  constructor(inputs: RegionInput[] = [], options?: AddRegionsOptions) {
    if (inputs.length) this.add(inputs, options);
  }

  get size(): number {
    return this.regions.size;
  }

  get(id: string): Region | undefined {
    return this.regions.get(id);
  }

  has(id: string): boolean {
    return this.regions.has(id);
  }

  all(): Region[] {
    return [...this.regions.values()];
  }

  roots(): Region[] {
    return this.children(null);
  }

  children(id: string | null): Region[] {
    return (this.childIds.get(id) ?? []).map((cid) => this.regions.get(cid)!);
  }

  parent(id: string): Region | undefined {
    const parentId = this.regions.get(id)?.parentId;
    return parentId ? this.regions.get(parentId) : undefined;
  }

  /** 根 → 自身的路径,用于面包屑。 */
  path(id: string): Region[] {
    const out: Region[] = [];
    let cur = this.regions.get(id);
    const guard = new Set<string>();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      out.unshift(cur);
      cur = cur.parentId ? this.regions.get(cur.parentId) : undefined;
    }
    return out;
  }

  /** 根节点深度为 0。 */
  depth(id: string): number {
    return this.path(id).length - 1;
  }

  /** 叶子 = 没有已加载的子级,且未标记 expandable。 */
  isLeaf(id: string): boolean {
    return !(this.childIds.get(id)?.length) && !this.regions.get(id)?.expandable;
  }

  hasLoadedChildren(id: string): boolean {
    return !!this.childIds.get(id)?.length;
  }

  isAncestor(ancestorId: string, id: string): boolean {
    return this.path(id).some((r) => r.id === ancestorId && r.id !== id);
  }

  descendants(id: string | null): Region[] {
    const out: Region[] = [];
    const stack = [...(this.childIds.get(id) ?? [])];
    while (stack.length) {
      const cid = stack.pop()!;
      out.push(this.regions.get(cid)!);
      stack.push(...(this.childIds.get(cid) ?? []));
    }
    return out;
  }

  /** 按编码、名称、别名解析(名称忽略空白与大小写);重名时可用 withinId 限定祖先范围。 */
  resolve(key: string, withinId?: string): Region | undefined {
    const byId = this.regions.get(key);
    if (byId) return byId;
    const ids = this.nameIndex.get(normalizeName(key)) ?? [];
    const candidates = ids.map((id) => this.regions.get(id)!);
    if (withinId) return candidates.find((r) => r.id === withinId || this.isAncestor(withinId, r.id));
    return candidates[0];
  }

  /** 点定位:返回包含该点的最深区域(可限定从某个区域开始向下找)。 */
  locate(point: Position, fromId: string | null = null): Region | undefined {
    let found: Region | undefined;
    let level = this.children(fromId);
    while (level.length) {
      const hit = level.find((r) => bboxContainsPoint(r.bbox, point) && pointInMultiPolygon(point, r.polygons));
      if (!hit) break;
      found = hit;
      level = this.children(hit.id);
    }
    return found;
  }

  /** 添加区域。可分批添加(懒加载子级)。返回建树过程中的问题。 */
  add(inputs: RegionInput[], options: AddRegionsOptions = {}): GeoIssue[] {
    const issues: GeoIssue[] = [];
    const added: Region[] = [];
    for (const input of inputs) {
      if (this.regions.has(input.id)) {
        // 重复添加视为更新几何/属性,保留原有父子关系
        const prev = this.regions.get(input.id)!;
        const next = toRegion({ ...input, parentId: input.parentId ?? prev.parentId });
        this.regions.set(input.id, next);
        this.unindex(prev);
        this.index(next);
        continue;
      }
      const region = toRegion(input);
      this.regions.set(region.id, region);
      this.index(region);
      added.push(region);
    }

    // 父级不存在的,先清空等待推断
    for (const region of added) {
      if (region.parentId && !this.regions.has(region.parentId)) {
        issues.push({
          severity: options.inferParents === false ? "warning" : "info",
          code: "missing-parent",
          message: `${region.name}:父级 ${region.parentId} 不存在${options.inferParents === false ? ",作为根节点" : ",尝试空间推断"}`,
          regionId: region.id,
        });
        region.parentId = null;
      }
    }

    if (options.inferParents !== false) {
      const orphans = added.filter((r) => r.parentId === null);
      issues.push(...this.inferParents(orphans, options.containment ?? 0.9));
    }

    this.rebuildChildren();
    return issues;
  }

  remove(id: string): void {
    for (const region of [this.regions.get(id)!, ...this.descendants(id)].filter(Boolean)) {
      this.unindex(region);
      this.regions.delete(region.id);
    }
    this.rebuildChildren();
  }

  private inferParents(orphans: Region[], threshold: number): GeoIssue[] {
    const issues: GeoIssue[] = [];
    if (!orphans.length) return issues;
    const candidates = [...this.regions.values()].sort((a, b) => a.areaKm2 - b.areaKm2);
    for (const region of orphans) {
      const samples = samplePoints(region.polygons);
      const parent = candidates.find((candidate) => {
        if (candidate.id === region.id || candidate.areaKm2 <= region.areaKm2) return false;
        if (!bboxContainsPoint(candidate.bbox, region.anchor)) return false;
        if (this.wouldCycle(candidate.id, region.id)) return false;
        const inside = samples.filter((p) => pointInMultiPolygon(p, candidate.polygons)).length;
        return inside / samples.length >= threshold;
      });
      if (parent) {
        region.parentId = parent.id;
        issues.push({ severity: "info", code: "parent-inferred", message: `${region.name} → ${parent.name}(空间推断)`, regionId: region.id });
      }
    }
    // 新加入的大区域可能包含原有根节点(例如先加载乡镇、后加载县),对原根节点再推断一次
    const orphanIds = new Set(orphans.map((r) => r.id));
    const oldRoots = [...this.regions.values()].filter((r) => r.parentId === null && !orphanIds.has(r.id));
    if (oldRoots.length && orphans.length) {
      const newCandidates = orphans.slice().sort((a, b) => a.areaKm2 - b.areaKm2);
      for (const root of oldRoots) {
        const samples = samplePoints(root.polygons);
        const parent = newCandidates.find(
          (c) =>
            c.areaKm2 > root.areaKm2 &&
            bboxContainsPoint(c.bbox, root.anchor) &&
            !this.wouldCycle(c.id, root.id) &&
            samples.filter((p) => pointInMultiPolygon(p, c.polygons)).length / samples.length >= threshold,
        );
        if (parent) {
          root.parentId = parent.id;
          issues.push({ severity: "info", code: "parent-inferred", message: `${root.name} → ${parent.name}(空间推断)`, regionId: root.id });
        }
      }
    }
    return issues;
  }

  /** candidate 若是 child 的后代,则把 candidate 设为 child 的父级会成环。 */
  private wouldCycle(candidateId: string, childId: string): boolean {
    let cur = this.regions.get(candidateId);
    const guard = new Set<string>();
    while (cur && !guard.has(cur.id)) {
      if (cur.id === childId) return true;
      guard.add(cur.id);
      cur = cur.parentId ? this.regions.get(cur.parentId) : undefined;
    }
    return false;
  }

  private rebuildChildren(): void {
    this.childIds.clear();
    for (const region of this.regions.values()) {
      const key = region.parentId && this.regions.has(region.parentId) ? region.parentId : null;
      const list = this.childIds.get(key) ?? [];
      list.push(region.id);
      this.childIds.set(key, list);
    }
  }

  private index(region: Region): void {
    for (const name of [region.name, ...region.aliases]) {
      const key = normalizeName(name);
      const list = this.nameIndex.get(key) ?? [];
      if (!list.includes(region.id)) list.push(region.id);
      this.nameIndex.set(key, list);
    }
  }

  private unindex(region: Region): void {
    for (const name of [region.name, ...region.aliases]) {
      const key = normalizeName(name);
      const list = (this.nameIndex.get(key) ?? []).filter((id) => id !== region.id);
      if (list.length) this.nameIndex.set(key, list);
      else this.nameIndex.delete(key);
    }
  }
}
