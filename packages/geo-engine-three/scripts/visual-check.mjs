#!/usr/bin/env node
// 画面回归检查:在 playground 中跑关键转场,逐帧检查"不是黑屏 / 白屏 / 空画面",并输出对照图。
//   pnpm --filter @yaoyu/geo-engine-three visual-check [--out 目录]
// 失败时退出码为 1。截图与 index.html 对照页写到 --out(默认系统临时目录)。
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frameStats, launch, mapBox, parseArgs, servePlayground, sleep } from "./lib.mjs";

const args = parseArgs({ out: join(tmpdir(), `geo-visual-${Date.now()}`) });

/**
 * 截图判定阈值(经验值,按 192px 缩略图统计)。正常画面中最暗的是单个乡镇 / 县域缩在远处的帧(内容约 2.5%),
 * 黑屏帧只剩面包屑和角标(约 0.5%)。
 */
const LIMITS = { minVariance: 0.0002, maxWhite: 0.2, minContent: 0.012 };

/**
 * 帧缓冲探针:在每次输出到屏幕后用 readPixels 采样 7×7 网格,记录全暗的帧。
 * 截图大约每 200ms 一张,单帧闪黑(16ms)只有这种方式能稳定抓到。
 */
async function installFrameProbe(page) {
  await page.evaluate(() => {
    const scene = window.__geo.host.scene;
    const renderer = scene.renderer;
    if (renderer.__probed) return;
    renderer.__probed = true;
    const gl = renderer.getContext();
    const render = renderer.render.bind(renderer);
    const px = new Uint8Array(4);
    window.__frameProbe ??= { frames: 0, dark: [] };
    renderer.render = (s, c) => {
      render(s, c);
      if (renderer.getRenderTarget() !== null) return;
      const probe = window.__frameProbe;
      probe.frames++;
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      for (let i = 1; i < 8; i++) {
        for (let j = 1; j < 8; j++) {
          gl.readPixels(Math.floor((w * i) / 8), Math.floor((h * j) / 8), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          if (px[0] + px[1] + px[2] > 60) return;
        }
      }
      probe.dark.push({ frame: probe.frames, mode: scene.mode, focus: scene.lastFrame?.drill.focusId ?? null, busy: scene.busy });
    };
  });
}

async function checkFrameProbe(page, scenario) {
  const probe = await page.evaluate(() => {
    const p = window.__frameProbe;
    const out = { frames: p.frames, dark: p.dark.slice() };
    p.frames = 0;
    p.dark.length = 0;
    return out;
  });
  probes.push({ scenario, ...probe });
  if (probe.dark.length) failures.push(`[${scenario}] ${probe.frames} 帧中有 ${probe.dark.length} 帧全暗(帧缓冲采样):${JSON.stringify(probe.dark.slice(0, 3))}`);
}

const failures = [];
const shots = [];
const probes = [];

function judge(stats) {
  const problems = [];
  if (stats.variance < LIMITS.minVariance) problems.push(`纯色画面(方差 ${stats.variance.toFixed(5)})`);
  if (stats.white > LIMITS.maxWhite) problems.push(`过曝(近白像素 ${(stats.white * 100).toFixed(1)}%)`);
  if (stats.content < LIMITS.minContent) problems.push(`几乎没有内容(${(stats.content * 100).toFixed(1)}%)`);
  return problems;
}

async function capture(page, scenario, label) {
  const clip = await mapBox(page);
  const png = await page.screenshot({ clip });
  const stats = await frameStats(page, png);
  const file = `${scenario}-${String(shots.length).padStart(3, "0")}.png`;
  await writeFile(join(args.out, file), png);
  const problems = judge(stats);
  shots.push({ scenario, label, file, stats, problems });
  if (problems.length) failures.push(`[${scenario}] ${label}:${problems.join(",")}`);
  return stats;
}

/** 转场期间按固定间隔连续截图,直到场景空闲。 */
async function captureTransition(page, scenario, startLabel, maxMs = 8000) {
  const start = Date.now();
  await sleep(60);
  while (Date.now() - start < maxMs) {
    await capture(page, scenario, `${startLabel} +${Date.now() - start}ms`);
    if (await page.evaluate(() => window.__geo.idle())) break;
    await sleep(140);
  }
  await sleep(400);
  await capture(page, scenario, `${startLabel} 结束`);
}

async function crumbs(page) {
  return (await page.locator("#crumbs").textContent())?.trim() ?? "";
}

async function expect(condition, message) {
  if (!condition) failures.push(message);
}

await mkdir(args.out, { recursive: true });
const server = await servePlayground();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().includes("404") && errors.push(m.text()));

try {
  await page.goto(server.url);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 20000 });
  await sleep(1200);
  await installFrameProbe(page);
  await capture(page, "globe", "初始地球");

  // 1. 地球上点中国 → 一步直达杭州市(地球 → 平面跨级转场)
  await page.evaluate(() => window.__geo.engine.activate("CHN"));
  await captureTransition(page, "dive", "点击中国");
  await expect((await crumbs(page)).includes("杭州市"), `[dive] 面包屑应到杭州市,实际:${await crumbs(page)}`);
  await checkFrameProbe(page, "dive");

  // 2. 平面层级:市 → 区县(叶子)→ 返回市
  await page.evaluate(() => window.__geo.engine.drill.drillTo("330106"));
  await captureTransition(page, "plane", "进入西湖区");
  await page.evaluate(() => window.__geo.engine.drill.drillUp());
  await captureTransition(page, "plane", "返回杭州市");
  await checkFrameProbe(page, "plane");

  // 3. 市 → 地球(平面 → 地球跨级上卷)
  await page.evaluate(() => window.__geo.engine.drill.drillTo(null));
  await captureTransition(page, "rise", "返回地球");
  await checkFrameProbe(page, "rise");

  // 4. WebGL 上下文丢失:场景应在新画布上重建,画面恢复
  const before = await page.evaluate(() => window.__geo.host.builds);
  await page.evaluate(() => window.__geo.loseContext());
  await page.waitForFunction((n) => window.__geo.host.builds > n && window.__geo.host.state === "ready", before, { timeout: 15000 }).catch(() => {});
  const after = await page.evaluate(() => ({ builds: window.__geo.host.builds, state: window.__geo.host.state }));
  await expect(after.builds > before && after.state === "ready", `[context] 上下文丢失后未恢复:${JSON.stringify(after)}`);
  await sleep(1500);
  await installFrameProbe(page); // 新场景、新渲染器
  await capture(page, "context", "上下文丢失后重建");

  // 5. 重建后仍可下钻
  await page.evaluate(() => window.__geo.engine.activate("CHN"));
  await captureTransition(page, "context", "重建后再次下钻");
  await expect((await crumbs(page)).includes("杭州市"), "[context] 重建后下钻失败");
  await checkFrameProbe(page, "context");
} catch (error) {
  failures.push(`脚本异常:${error.message}`);
} finally {
  await browser.close();
  await server.close();
}

for (const e of errors.filter((e) => !/WebGL 上下文|CONTEXT_LOST|context lost/i.test(e))) failures.push(`页面错误:${e}`);

const rows = shots
  .map((s) => `<figure class="${s.problems.length ? "bad" : ""}"><img src="${s.file}"><figcaption>${s.scenario} · ${s.label}<br>${s.problems.join(",") || `内容 ${(s.stats.content * 100).toFixed(0)}% · 白 ${(s.stats.white * 100).toFixed(1)}%`}</figcaption></figure>`)
  .join("\n");
await writeFile(
  join(args.out, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>geo visual check</title><style>body{background:#111;color:#ccc;font:12px system-ui;display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:8px;padding:8px}img{width:100%}figure{margin:0}.bad{outline:3px solid #f43f5e}</style>${rows}`,
);
await writeFile(join(args.out, "result.json"), JSON.stringify({ failures, shots, probes }, null, 2));

console.log(`截图 ${shots.length} 张,帧缓冲采样 ${probes.reduce((a, p) => a + p.frames, 0)} 帧,对照页:${join(args.out, "index.html")}`);
if (failures.length) {
  console.error(`\n✗ ${failures.length} 项未通过:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("✓ 画面检查通过");
