import type { GeoEngine, GeoPlugin } from "../engine";

export interface AutoTourOptions {
  /** 巡游站点:区域 id 序列(null 表示回到顶层)。 */
  stops: Array<string | null>;
  /** 每站停留时长(毫秒),默认 8000。 */
  dwellMs?: number;
  /** 人工操作(悬停 / 选中 / 非巡游触发的下钻)后多久恢复巡游(毫秒),默认 30000。 */
  resumeAfterMs?: number;
  /** 安装后立即开始,默认 true。 */
  autoStart?: boolean;
  /** 跑完一轮后是否循环,默认 true。 */
  loop?: boolean;
}

export interface AutoTourController extends GeoPlugin {
  start(): void;
  /** 暂停;resumeAfterMs 后自动恢复(传 false 则不自动恢复)。 */
  pause(autoResume?: boolean): void;
  stop(): void;
  readonly running: boolean;
  readonly index: number;
}

/**
 * 自动巡游:大屏无人值守时按站点序列依次下钻展示,有人操作时让位,空闲后从下一站继续。
 * 站点之间用 drillTo 跳转,引擎会按层级关系自动生成连续的转场。
 */
export function autoTour(options: AutoTourOptions): AutoTourController {
  const dwell = options.dwellMs ?? 8000;
  const resumeAfter = options.resumeAfterMs ?? 30000;
  let engine: GeoEngine | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let index = -1;
  let touring = false;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    clear();
    if (!running) return;
    timer = setTimeout(next, dwell);
  };
  const next = async () => {
    if (!engine || !running || !options.stops.length) return;
    const nextIndex = index + 1;
    if (nextIndex >= options.stops.length && options.loop === false) {
      running = false;
      return;
    }
    index = nextIndex % options.stops.length;
    touring = true;
    try {
      await engine.drill.drillTo(options.stops[index]);
    } finally {
      touring = false;
    }
    schedule();
  };

  const controller: AutoTourController = {
    name: "auto-tour",
    get running() {
      return running;
    },
    get index() {
      return index;
    },
    start() {
      if (resumeTimer) clearTimeout(resumeTimer);
      resumeTimer = null;
      running = true;
      void next();
    },
    pause(autoResume = true) {
      running = false;
      clear();
      if (resumeTimer) clearTimeout(resumeTimer);
      resumeTimer = autoResume ? setTimeout(() => controller.start(), resumeAfter) : null;
    },
    stop() {
      running = false;
      clear();
      if (resumeTimer) clearTimeout(resumeTimer);
      resumeTimer = null;
    },
    install(ctx) {
      engine = ctx.engine;
      const interrupt = () => {
        if (running || resumeTimer) controller.pause();
      };
      ctx.on("hover", ({ region }) => region && interrupt());
      ctx.on("select", interrupt);
      ctx.on("drill", () => {
        if (!touring) interrupt();
      });
      if (options.autoStart !== false) {
        running = true;
        schedule();
      }
      return () => {
        controller.stop();
        engine = null;
      };
    },
  };
  return controller;
}
