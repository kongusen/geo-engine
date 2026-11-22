// 自动化脚本公用:构建并静态托管 playground、启动浏览器、画面像素统计。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLAYGROUND = join(ROOT, "playground");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json" };

export function parseArgs(defaults) {
  const args = { ...defaults };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (!(key in defaults)) throw new Error(`未知参数 --${key};可用:${Object.keys(defaults).map((k) => `--${k}`).join(" ")}`);
    const value = argv[i + 1];
    args[key] = typeof defaults[key] === "number" ? Number(value) : typeof defaults[key] === "boolean" ? value !== "false" : value;
    i++;
  }
  return args;
}

/** 构建 playground 并在随机端口托管,返回 { url, close }。 */
export async function servePlayground() {
  await build({ entryPoints: [join(PLAYGROUND, "main.ts")], bundle: true, format: "iife", outdir: join(PLAYGROUND, "dist"), logLevel: "warning" });
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    const file = join(PLAYGROUND, path.endsWith("/") ? `${path}index.html` : path);
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * 启动浏览器:优先本机 Chrome(真实 GPU 路径,与大屏一致),没有时用 Playwright 自带 Chromium
 * (需先 `pnpm exec playwright install chromium`)。GEO_BROWSER=chromium 可强制使用后者。
 */
export async function launch(extraArgs = []) {
  const args = ["--enable-precise-memory-info", "--js-flags=--expose-gc", ...extraArgs];
  if (process.env.GEO_BROWSER !== "chromium") {
    try {
      return await chromium.launch({ channel: "chrome", args });
    } catch (error) {
      console.warn("未找到本机 Chrome,改用 Playwright Chromium:", error.message.split("\n")[0]);
    }
  }
  return chromium.launch({ args });
}

/**
 * 画面统计(在页面内解码截图):
 * - variance:亮度方差,接近 0 即纯色画面(黑屏 / 白屏);
 * - white:近白像素占比(效果被放大成满屏光斑时很高);
 * - content:与主色(出现最多的颜色)明显不同的像素占比,过低即"什么都没画出来"。
 */
export async function frameStats(page, png) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const w = 192;
    const h = Math.round((img.height / img.width) * w);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const n = w * h;
    const counts = new Map();
    let sum = 0;
    let sum2 = 0;
    let white = 0;
    const lum = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      lum[i] = l;
      sum += l;
      sum2 += l * l;
      if (l > 0.9) white++;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let mode = 0;
    let best = -1;
    for (const [key, c] of counts) if (c > best) [best, mode] = [c, key];
    const mr = ((mode >> 8) & 15) * 16 + 8;
    const mg = ((mode >> 4) & 15) * 16 + 8;
    const mb = (mode & 15) * 16 + 8;
    let content = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(data[i * 4] - mr) + Math.abs(data[i * 4 + 1] - mg) + Math.abs(data[i * 4 + 2] - mb);
      if (d > 36) content++;
    }
    const mean = sum / n;
    return { variance: sum2 / n - mean * mean, white: white / n, content: content / n, mean };
  }, png.toString("base64"));
}

export async function mapBox(page) {
  return page.locator("#map").boundingBox();
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
