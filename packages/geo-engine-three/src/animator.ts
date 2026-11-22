import { easeInOutCubic } from "@yaoyu/geo-engine";

export interface Tween {
  duration: number;
  delay?: number;
  ease?: (t: number) => number;
  update(t: number): void;
  done?(): void;
}

interface Running extends Tween {
  start: number;
  cancelled: boolean;
}

/** 由渲染循环驱动的补间队列;同一个 key 的新补间会取消旧的(避免相机/高亮动画互相打架)。 */
export class Animator {
  private running = new Set<Running>();
  private keyed = new Map<string, Running>();

  constructor(private now: () => number = () => performance.now()) {}

  get busy(): boolean {
    return this.running.size > 0;
  }

  add(tween: Tween, key?: string): () => void {
    if (key) this.cancel(key);
    const item: Running = { ...tween, start: this.now() + (tween.delay ?? 0), cancelled: false };
    this.running.add(item);
    if (key) this.keyed.set(key, item);
    return () => {
      item.cancelled = true;
      this.running.delete(item);
    };
  }

  cancel(key: string): void {
    const prev = this.keyed.get(key);
    if (prev) {
      prev.cancelled = true;
      this.running.delete(prev);
      this.keyed.delete(key);
    }
  }

  tick(time = this.now()): void {
    for (const item of [...this.running]) {
      if (item.cancelled) continue;
      if (time < item.start) continue;
      const raw = item.duration <= 0 ? 1 : Math.min(1, (time - item.start) / item.duration);
      item.update((item.ease ?? easeInOutCubic)(raw));
      if (raw >= 1) {
        this.running.delete(item);
        for (const [k, v] of this.keyed) if (v === item) this.keyed.delete(k);
        item.done?.();
      }
    }
  }

  clear(): void {
    this.running.clear();
    this.keyed.clear();
  }
}

export const easeOutBack = (t: number) => {
  const c1 = 1.4;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};
export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
