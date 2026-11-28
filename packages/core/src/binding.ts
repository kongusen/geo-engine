import type { RegionTree } from "./region-tree";

export interface BindOptions<T> {
  /** 行的区域键:编码、名称或别名均可。 */
  key: (row: T) => string | null | undefined;
  value: (row: T) => number | null | undefined;
  /** 只在此区域的后代中匹配(解决不同县有同名乡镇)。 */
  withinId?: string;
}

export interface BoundValue<T> {
  regionId: string;
  value: number;
  row: T;
}

export interface BindResult<T> {
  values: Map<string, BoundValue<T>>;
  /** 匹配不上区域的行,供数据质量报告。 */
  unmatched: T[];
}

/** 把业务数据按编码/名称/别名关联到区域。同一区域多行时数值累加。 */
export function bindData<T>(tree: RegionTree, rows: T[], options: BindOptions<T>): BindResult<T> {
  const values = new Map<string, BoundValue<T>>();
  const unmatched: T[] = [];
  for (const row of rows) {
    const key = options.key(row);
    const region = key ? tree.resolve(key, options.withinId) : undefined;
    const value = options.value(row);
    if (!region) {
      unmatched.push(row);
      continue;
    }
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    const prev = values.get(region.id);
    values.set(region.id, { regionId: region.id, value: (prev?.value ?? 0) + value, row });
  }
  return { values, unmatched };
}

// ── 分级 ──────────────────────────────────────────────────────────────────

export type ClassifyMethod = "linear" | "equal" | "quantile" | "jenks";

export interface ClassifyOptions {
  /** 显式值域 [min, max],用于在稀疏或全部值相同时保持稳定色阶映射。 */
  domain?: [number, number];
}

export interface Classification {
  method: ClassifyMethod;
  /** 分级断点(升序,长度 = classes + 1,首尾为最小/最大值)。linear 时只有 [min, max]。 */
  breaks: number[];
  /** 0..1 的归一化位置(linear 连续;分级方法返回所在级的中心)。 */
  position(value: number): number;
  /** 所在级序号(0 起);linear 时返回 -1。 */
  classOf(value: number): number;
}

function quantileBreaks(sorted: number[], k: number): number[] {
  const breaks = [sorted[0]];
  for (let i = 1; i < k; i++) {
    const pos = (sorted.length - 1) * (i / k);
    const lo = Math.floor(pos);
    breaks.push(sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (pos - lo));
  }
  breaks.push(sorted[sorted.length - 1]);
  return breaks;
}

/** Jenks 自然断点(Fisher 动态规划),适合样本量 < 数千的行政区数据。 */
function jenksBreaks(sorted: number[], k: number): number[] {
  const n = sorted.length;
  const lower = Array.from({ length: n + 1 }, () => new Array<number>(k + 1).fill(0));
  const variance = Array.from({ length: n + 1 }, () => new Array<number>(k + 1).fill(Infinity));
  for (let j = 1; j <= k; j++) {
    lower[1][j] = 1;
    variance[1][j] = 0;
  }
  for (let l = 2; l <= n; l++) {
    let sum = 0;
    let sumSq = 0;
    let w = 0;
    let v = 0;
    for (let m = 1; m <= l; m++) {
      const i3 = l - m + 1;
      const val = sorted[i3 - 1];
      w++;
      sum += val;
      sumSq += val * val;
      v = sumSq - (sum * sum) / w;
      const i4 = i3 - 1;
      if (i4 !== 0) {
        for (let j = 2; j <= k; j++) {
          if (variance[l][j] >= v + variance[i4][j - 1]) {
            lower[l][j] = i3;
            variance[l][j] = v + variance[i4][j - 1];
          }
        }
      }
    }
    lower[l][1] = 1;
    variance[l][1] = v;
  }
  const breaks = new Array<number>(k + 1);
  breaks[k] = sorted[n - 1];
  breaks[0] = sorted[0];
  let idx = n;
  for (let j = k; j >= 2; j--) {
    const id = lower[idx][j] - 2;
    breaks[j - 1] = sorted[Math.max(0, id)];
    idx = lower[idx][j] - 1;
  }
  return breaks;
}

/** 对数值分级,用于填色、挤出高度、气泡大小和图例。 */
export function classify(values: number[], method: ClassifyMethod = "linear", classes = 5, options?: ClassifyOptions): Classification {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const hasDomain = !!options?.domain && Number.isFinite(options.domain[0]) && Number.isFinite(options.domain[1]) && options.domain[1] > options.domain[0];
  if (!sorted.length && !hasDomain) {
    return { method, breaks: [], position: () => 0, classOf: () => -1 };
  }
  const min = hasDomain ? options!.domain![0] : sorted[0];
  const max = hasDomain ? options!.domain![1] : sorted[sorted.length - 1];
  if (method === "linear" || min === max) {
    return {
      method: "linear",
      breaks: [min, max],
      position: (v) => (max === min ? 1 : Math.min(1, Math.max(0, (v - min) / (max - min)))),
      classOf: () => -1,
    };
  }
  if ((method === "quantile" || method === "jenks") && (sorted.length === 0 || new Set(sorted).size < 2)) {
    return {
      method: "linear",
      breaks: [min, max],
      position: (v) => Math.min(1, Math.max(0, (v - min) / (max - min))),
      classOf: () => -1,
    };
  }
  const k = hasDomain && method === "equal" ? Math.max(1, classes) : Math.max(1, Math.min(classes, new Set(sorted).size));
  const breaks =
    method === "equal"
      ? Array.from({ length: k + 1 }, (_, i) => min + ((max - min) * i) / k)
      : method === "quantile"
        ? quantileBreaks(sorted, k)
        : jenksBreaks(sorted, k);
  const classOf = (v: number) => {
    for (let i = 1; i < breaks.length; i++) if (v <= breaks[i]) return i - 1;
    return breaks.length - 2;
  };
  return {
    method,
    breaks,
    classOf,
    position: (v) => (k === 1 ? 1 : (classOf(v) + 0.5) / k),
  };
}

// ── 颜色 ──────────────────────────────────────────────────────────────────

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

const toHex = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");

/** 在多个色标之间线性插值,t ∈ [0,1]。 */
export function interpolateColors(stops: string[], t: number): string {
  if (stops.length === 1) return stops[0];
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const a = parseHex(stops[i]);
  const b = parseHex(stops[i + 1]);
  const f = x - i;
  return `#${toHex(a[0] + (b[0] - a[0]) * f)}${toHex(a[1] + (b[1] - a[1]) * f)}${toHex(a[2] + (b[2] - a[2]) * f)}`;
}

export interface LegendItem {
  color: string;
  from: number;
  to: number;
}

/** 由分级结果生成图例项。 */
export function legendFor(classification: Classification, stops: string[], steps = 5): LegendItem[] {
  const { breaks } = classification;
  if (breaks.length < 2) return [];
  if (classification.method === "linear") {
    const [min, max] = breaks;
    return Array.from({ length: steps }, (_, i) => ({
      color: interpolateColors(stops, (i + 0.5) / steps),
      from: min + ((max - min) * i) / steps,
      to: min + ((max - min) * (i + 1)) / steps,
    }));
  }
  return breaks.slice(0, -1).map((from, i) => ({
    color: interpolateColors(stops, (i + 0.5) / (breaks.length - 1)),
    from,
    to: breaks[i + 1],
  }));
}
