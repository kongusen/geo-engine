#!/usr/bin/env node
// 长时间运行巡检:在 playground 里用快速自动巡游反复下钻 / 上卷,每轮回到地球时记录资源占用,判断是否泄漏。
//   pnpm --filter @yaoyu/geo-engine-three soak --minutes 30 [--dwell 2500] [--lose-every 0] [--out 目录]
// 大屏上线前建议在 M4 mini 上跑一晚(--minutes 600)。--lose-every N 表示每 N 轮模拟一次 WebGL 上下文丢失。
// 判定:同一视图(地球)下几何体 / 纹理 / 标签 DOM 数不应随轮数增长,JS 堆在 GC 后不应持续上涨。失败退出码为 1。
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, parseArgs, servePlayground, sleep } from "./lib.mjs";

const args = parseArgs({ minutes: 10, dwell: 2500, "lose-every": 0, out: join(tmpdir(), `geo-soak-${Date.now()}`) });

await mkdir(args.out, { recursive: true });
const server = await servePlayground();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const samples = [];
const startedAt = Date.now();
try {
  await page.goto(server.url);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 20000 });
  // 打开全部效果,覆盖面最大
  await page.evaluate(() => {
    for (const key of Object.keys(window.LAYERS)) window.enabled.add(key);
    window.apply();
  });
  await page.evaluate((dwell) => {
    window.__soak = { cycles: 0 };
    window.__geo.startTour(dwell);
    window.__geo.engine.on("drill", ({ to }) => {
      if (to.focusId === null) window.__soak.cycles++;
    });
  }, args.dwell);

  let lastCycle = 0;
  const deadline = startedAt + args.minutes * 60_000;
  while (Date.now() < deadline) {
    await sleep(500);
    const cycles = await page.evaluate(() => window.__soak.cycles);
    if (cycles === lastCycle) continue;
    lastCycle = cycles;
    // 等回到地球的转场结束,GC 后取样
    await page.waitForFunction(() => window.__geo.idle(), null, { timeout: 15000 }).catch(() => {});
    await sleep(600);
    const sample = await page.evaluate(() => {
      window.gc?.();
      const mem = performance.memory;
      return { ...window.__geo.host.stats(), heapMB: mem ? Math.round((mem.usedJSHeapSize / 1048576) * 10) / 10 : null, domNodes: document.getElementsByTagName("*").length };
    });
    sample.cycle = cycles;
    sample.minute = Math.round(((Date.now() - startedAt) / 60000) * 10) / 10;
    samples.push(sample);
    console.log(
      `#${cycles} ${sample.minute}min fps=${sample.fps} geo=${sample.geometries} tex=${sample.textures} prog=${sample.programs} labels=${sample.labelNodes} dom=${sample.domNodes} heap=${sample.heapMB}MB builds=${sample.builds}`,
    );
    if (args["lose-every"] > 0 && cycles % args["lose-every"] === 0) await page.evaluate(() => window.__geo.loseContext());
  }
} finally {
  await browser.close();
  await server.close();
}

// ── 判定 ───────────────────────────────────────────────────────────────
const failures = [];
if (samples.length < 4) failures.push(`有效轮数太少(${samples.length}),请加长 --minutes 或缩短 --dwell`);
else {
  // 跳过前两轮(首次编译着色器、缓存预热)
  const steady = samples.slice(2);
  const avg = (list, key) => list.reduce((a, s) => a + s[key], 0) / list.length;
  const head = steady.slice(0, 3);
  const tail = steady.slice(-3);
  for (const key of ["geometries", "textures", "programs", "labelNodes", "domNodes"]) {
    const from = avg(head, key);
    const to = avg(tail, key);
    // 允许少量抖动(取样时机差异),前后三轮均值明显上升才算泄漏
    if (to - from > Math.max(8, from * 0.05)) failures.push(`${key} 前 3 轮均值 ${from.toFixed(0)} → 后 3 轮 ${to.toFixed(0)}(共 ${steady.length} 轮)`);
  }
  const heaps = steady.map((s) => s.heapMB).filter((v) => v !== null);
  if (heaps.length >= 4) {
    // 最小二乘斜率:MB / 轮
    const n = heaps.length;
    const mx = (n - 1) / 2;
    const my = heaps.reduce((a, b) => a + b, 0) / n;
    const slope = heaps.reduce((acc, y, x) => acc + (x - mx) * (y - my), 0) / heaps.reduce((acc, _, x) => acc + (x - mx) ** 2, 0);
    console.log(`JS 堆趋势:${slope.toFixed(3)} MB/轮`);
    if (slope > 0.3) failures.push(`JS 堆持续增长 ${slope.toFixed(2)} MB/轮`);
  }
  const fps = steady.map((s) => s.fps);
  console.log(`帧率:最低 ${Math.min(...fps)},最高 ${Math.max(...fps)}`);
}
for (const e of errors) failures.push(`页面错误:${e}`);

await writeFile(join(args.out, "samples.json"), JSON.stringify({ args, samples, failures }, null, 2));
await writeFile(
  join(args.out, "samples.csv"),
  ["cycle,minute,fps,geometries,textures,programs,labelNodes,domNodes,heapMB,builds", ...samples.map((s) => [s.cycle, s.minute, s.fps, s.geometries, s.textures, s.programs, s.labelNodes, s.domNodes, s.heapMB, s.builds].join(","))].join("\n"),
);
console.log(`\n${samples.length} 轮,记录:${join(args.out, "samples.csv")}`);
if (failures.length) {
  console.error(`✗ ${failures.length} 项未通过:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("✓ 未发现资源持续增长");
