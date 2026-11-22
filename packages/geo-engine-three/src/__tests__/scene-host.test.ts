import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeoSceneOptions, SceneStats } from "../geo-scene";
import { SceneHost, type HostedScene, type SceneHostStatus } from "../scene-host";

type Fake = HostedScene & { options: GeoSceneOptions; disposed: boolean; accent: string[]; labels: boolean[]; overlays: string[] };

function factory(failures: number[] = []) {
  const created: Fake[] = [];
  let call = 0;
  const createScene = (options: GeoSceneOptions): Fake => {
    if (failures.includes(call++)) throw new Error("Error creating WebGL context");
    const scene: Fake = {
      options,
      disposed: false,
      accent: [],
      labels: [],
      overlays: [],
      setAccent: (a) => scene.accent.push(a),
      setLabelsVisible: (v) => scene.labels.push(v),
      registerOverlay: (p) => scene.overlays.push(p.type),
      stats: () => ({ fps: 60 }) as SceneStats,
      dispose: () => void (scene.disposed = true),
    };
    created.push(scene);
    return scene;
  };
  return { created, createScene };
}

const base = { container: {} as HTMLElement, engine: {} as GeoSceneOptions["engine"], theme: { accent: "#10b981" } };

describe("SceneHost", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("上下文丢失后等待恢复,超时在新画布上重建,并恢复主色 / 标签 / 自定义效果", () => {
    const { created, createScene } = factory();
    const statuses: SceneHostStatus[] = [];
    const host = new SceneHost(base, { createScene, restoreWaitMs: 2000, onStatus: (s) => statuses.push(s) });
    host.setAccent("#f59e0b");
    host.setLabelsVisible(false);
    host.registerOverlay({ type: "custom", modes: ["plane"], create: () => ({ dispose() {} }) });

    created[0].options.onContextLost!();
    expect(host.state).toBe("recovering");
    vi.advanceTimersByTime(1999);
    expect(created).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(created).toHaveLength(2);
    expect(created[0].disposed).toBe(true);
    expect(created[1].options.theme?.accent).toBe("#f59e0b");
    expect(created[1].labels).toEqual([false]);
    expect(created[1].overlays).toEqual(["custom"]);
    expect(statuses).toEqual(["ready", "recovering", "ready"]);
    expect(host.builds).toBe(2);
  });

  it("浏览器发出 restored 时立即重建;旧场景迟到的事件被忽略", () => {
    const { created, createScene } = factory();
    const host = new SceneHost(base, { createScene });
    const stale = created[0].options;
    stale.onContextLost!();
    stale.onContextRestored!();
    expect(created).toHaveLength(2);
    expect(host.state).toBe("ready");
    stale.onContextLost!(); // 已被替换的场景
    expect(host.state).toBe("ready");
    vi.advanceTimersByTime(10000);
    expect(created).toHaveLength(2);
  });

  it("创建失败按退避重试,用尽后 failed,之后低频重试成功回到 ready", () => {
    const { created, createScene } = factory([0, 1, 2]);
    const statuses: SceneHostStatus[] = [];
    const host = new SceneHost(base, { createScene, retryDelaysMs: [100, 200], failedRetryMs: 5000, onStatus: (s) => statuses.push(s) });
    expect(host.state).toBe("recovering");
    vi.advanceTimersByTime(100); // 第 2 次失败
    vi.advanceTimersByTime(200); // 第 3 次失败 → failed
    expect(host.state).toBe("failed");
    vi.advanceTimersByTime(5000); // 第 4 次成功
    expect(host.state).toBe("ready");
    expect(created).toHaveLength(1);
    expect(statuses).toEqual(["recovering", "recovering", "failed", "ready"]);
  });

  it("dispose 后不再重建", () => {
    const { created, createScene } = factory();
    const host = new SceneHost(base, { createScene });
    created[0].options.onContextLost!();
    host.dispose();
    vi.advanceTimersByTime(60000);
    expect(created).toHaveLength(1);
    expect(created[0].disposed).toBe(true);
  });
});
