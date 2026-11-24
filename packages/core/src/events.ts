export type Unsubscribe = () => void;

/** 极简类型化事件总线。处理函数抛错不影响其他订阅者。 */
export class Emitter<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): Unsubscribe {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as (payload: never) => void);
    this.handlers.set(event, set);
    return () => set.delete(handler as (payload: never) => void);
  }

  once<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): Unsubscribe {
    const off = this.on(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      try {
        (handler as (payload: Events[K]) => void)(payload);
      } catch (error) {
        console.error(`[geodive] "${String(event)}" handler failed`, error);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
