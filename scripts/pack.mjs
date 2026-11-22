#!/usr/bin/env node
// 构建并打出可分发的 .tgz,供其他项目以 file: 方式引用。
//   pnpm pack:to <目标目录>      例:pnpm pack:to ../yaoyu-data/vendor/geo
// 先跑类型检查和测试,任一失败即中止;打包时 workspace:* 依赖会被替换为实际版本号,exports 切换到 dist。
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dest = process.argv[2];
if (!dest) {
  console.error("用法:pnpm pack:to <目标目录>");
  process.exit(1);
}
const out = resolve(process.env.INIT_CWD ?? process.cwd(), dest);
mkdirSync(out, { recursive: true });

const run = (args, cwd = root) => execFileSync("pnpm", args, { cwd, stdio: "inherit" });
if (!process.argv.includes("--skip-checks")) {
  run(["-r", "typecheck"]);
  run(["-r", "test"]);
}
for (const pkg of ["geo-engine", "geo-engine-three"]) run(["pack", "--pack-destination", out], resolve(root, "packages", pkg));
console.log(`\n已输出到 ${out}:\n  ${readdirSync(out).filter((f) => f.endsWith(".tgz")).join("\n  ")}`);
