import { Emitter } from "./events";
import type { RegionTree } from "./region-tree";
import type { Region } from "./types";

/** 当前聚焦的区域;null 表示最顶层(如整个地球 / 未设根时的全部根节点)。 */
export interface DrillState {
  /** 当前区域 id。 */
  focusId: string | null;
  /** 从 rootId(不含)到 focus(含)的区域路径,用于面包屑。 */
  path: Region[];
  /** 相对 rootId 的深度,顶层为 0。 */
  depth: number;
}

export type DrillDirection = "down" | "up" | "jump" | "reset";

export interface DrillChange {
  from: DrillState;
  to: DrillState;
  direction: DrillDirection;
}

export interface DrillGuardContext {
  target: Region | null;
  from: DrillState;
  direction: DrillDirection;
}

/** 返回 false 阻止下钻(如无数据区域不允许进入)。 */
export type DrillGuard = (ctx: DrillGuardContext) => boolean | Promise<boolean>;

export interface DrillOptions {
  /** 顶层区域;null 表示从树的根开始(地球)。 */
  rootId?: string | null;
  /** 最大下钻深度(相对 rootId)。 */
  maxDepth?: number;
  /** 进入某区域前确保其子级已加载(懒加载数据源)。 */
  loadChildren?: (id: string) => Promise<void>;
  guards?: DrillGuard[];
  /** 允许把叶子作为下钻目标(聚焦单个最小级区域以切换图层,如乡镇 → 乡镇内点位)。默认 false。 */
  allowLeafFocus?: boolean;
}

type DrillEvents = {
  change: DrillChange;
  loading: { targetId: string | null; loading: boolean };
  blocked: { targetId: string | null; reason: "guard" | "max-depth" | "leaf" | "out-of-root" | "unknown" | "error"; error?: unknown };
};

/**
 * 下钻状态机。状态即"当前聚焦区域",路径由区域树推导,所以 drillTo 可以直接跳到任意深度
 * (面包屑、URL 恢复、自动巡游)。并发下钻时只有最后一次生效。
 */
export class DrillController {
  readonly events = new Emitter<DrillEvents>();
  private focus: string | null;
  private token = 0;
  private guards: DrillGuard[];

  constructor(
    private tree: RegionTree,
    private options: DrillOptions = {},
  ) {
    this.focus = options.rootId ?? null;
    this.guards = [...(options.guards ?? [])];
  }

  get rootId(): string | null {
    return this.options.rootId ?? null;
  }

  get state(): DrillState {
    return this.stateFor(this.focus);
  }

  addGuard(guard: DrillGuard): () => void {
    this.guards.push(guard);
    return () => {
      this.guards = this.guards.filter((g) => g !== guard);
    };
  }

  /** 能否继续向下:在根范围内、未超过最大深度、不是叶子。 */
  canDrillInto(id: string): boolean {
    const region = this.tree.get(id);
    if (!region || !this.withinRoot(id)) return false;
    const depth = this.stateFor(id).depth;
    if (this.options.maxDepth !== undefined && depth > this.options.maxDepth) return false;
    return true;
  }

  /** 进入当前区域的某个子级(或更深的后代)。 */
  drillDown(id: string): Promise<boolean> {
    return this.go(id, "down");
  }

  drillTo(id: string | null): Promise<boolean> {
    return this.go(id, "jump");
  }

  /** 返回上一级;已在顶层则返回 false。 */
  drillUp(): Promise<boolean> {
    if (this.focus === this.rootId) return Promise.resolve(false);
    const parent = this.focus ? this.tree.get(this.focus)?.parentId ?? null : null;
    return this.go(parent && this.withinRoot(parent) ? parent : this.rootId, "up");
  }

  reset(): Promise<boolean> {
    return this.go(this.rootId, "reset");
  }

  /** 序列化当前状态(用于 URL ?region=)。 */
  serialize(): string {
    return this.focus ?? "";
  }

  restore(serialized: string | null | undefined): Promise<boolean> {
    return this.drillTo(serialized ? serialized : this.rootId);
  }

  private withinRoot(id: string | null): boolean {
    if (id === null) return this.rootId === null;
    if (this.rootId === null) return this.tree.has(id);
    return id === this.rootId || this.tree.isAncestor(this.rootId, id);
  }

  private stateFor(id: string | null): DrillState {
    const full = id ? this.tree.path(id) : [];
    const rootIndex = this.rootId ? full.findIndex((r) => r.id === this.rootId) : -1;
    const path = full.slice(rootIndex + 1);
    return { focusId: id, path, depth: path.length };
  }

  private async go(id: string | null, direction: DrillDirection): Promise<boolean> {
    if (id === this.focus) return false;
    const token = ++this.token;
    const from = this.state;

    const target = id ? this.tree.get(id) ?? null : null;
    if (id !== null && !target) {
      this.events.emit("blocked", { targetId: id, reason: "unknown" });
      return false;
    }
    if (!this.withinRoot(id)) {
      this.events.emit("blocked", { targetId: id, reason: "out-of-root" });
      return false;
    }
    const toState = this.stateFor(id);
    if (this.options.maxDepth !== undefined && toState.depth > this.options.maxDepth) {
      this.events.emit("blocked", { targetId: id, reason: "max-depth" });
      return false;
    }
    // 叶子不能作为"下钻"目标(没有下一级可展示),但可以通过 jump 定位(选中叶子时由业务处理)
    if (direction === "down" && id && this.tree.isLeaf(id) && !this.options.allowLeafFocus) {
      this.events.emit("blocked", { targetId: id, reason: "leaf" });
      return false;
    }

    // 守卫或数据加载出错时不抛出(点击处理多为 fire-and-forget),以 blocked(reason: "error") 报告,状态保持不变
    try {
      for (const guard of this.guards) {
        const ok = await guard({ target, from, direction });
        if (token !== this.token) return false;
        if (!ok) {
          this.events.emit("blocked", { targetId: id, reason: "guard" });
          return false;
        }
      }
    } catch (error) {
      if (token === this.token) this.events.emit("blocked", { targetId: id, reason: "error", error });
      return false;
    }

    if (id && this.options.loadChildren && !this.tree.hasLoadedChildren(id) && !this.tree.isLeaf(id)) {
      this.events.emit("loading", { targetId: id, loading: true });
      try {
        await this.options.loadChildren(id);
      } catch (error) {
        if (token === this.token) this.events.emit("blocked", { targetId: id, reason: "error", error });
        return false;
      } finally {
        this.events.emit("loading", { targetId: id, loading: false });
      }
      if (token !== this.token) return false;
    }

    this.focus = id;
    this.events.emit("change", { from, to: this.stateFor(id), direction });
    return true;
  }
}
