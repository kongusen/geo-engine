import type { LoadContext, RegionSource } from "./source";

export interface LoadPolicy {
  /** 失败后重试次数,默认 2。 */
  retries?: number;
  /** 首次重试前等待(毫秒),之后每次翻倍,默认 600。 */
  retryDelayMs?: number;
  /** 单次加载超时(毫秒),默认 15000;0 为不限。 */
  timeoutMs?: number;
}

/** 给数据源的 children / ancestors 加上重试与超时。中止(ctx.signal)后不再重试。 */
export function withPolicy(source: RegionSource, policy: LoadPolicy = {}): RegionSource {
  const { retries = 2, retryDelayMs = 600, timeoutMs = 15000 } = policy;
  const run = async <T>(label: string, ctx: LoadContext, task: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await withTimeout(Promise.resolve().then(task), timeoutMs, label);
      } catch (error) {
        if (attempt >= retries || ctx.signal.aborted) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** attempt));
      }
    }
  };
  const ancestors = source.ancestors;
  const region = source.region;
  return {
    ...source,
    handles: source.handles?.bind(source),
    owns: source.owns?.bind(source),
    children: (parentId, ctx) => run(parentId ?? "顶层", ctx, () => source.children(parentId, ctx)),
    ancestors: ancestors ? (id, ctx) => run(`${id} 的祖先`, ctx, () => ancestors.call(source, id, ctx)) : undefined,
    region: region ? (id, ctx) => run(id, ctx, () => region.call(source, id, ctx)) : undefined,
  };
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (!ms) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`加载区域数据超时(${label},${ms}ms)`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
