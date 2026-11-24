#!/usr/bin/env node
// 由 .github/workflows/release.yml 在推送 v* tag 时调用,也可本地 --dry-run 演练。
//   node scripts/release.mjs --tag v0.2.0 [--dry-run]
//
// 1. 校验 tag 与三个包的版本号一致
// 2. 按依赖顺序 pnpm pack(workspace:* 替换为实际版本,exports 切换到 dist)
// 3. 已发布的版本跳过(对同一 tag 重跑是安全的),其余 npm publish
//    认证由 npm 的 trusted publishing(GitHub OIDC)完成,不需要 token;provenance 随之自动生成
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGES } from "./packages.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const tag = args[args.indexOf("--tag") + 1] ?? process.env.GITHUB_REF_NAME;

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (!tag || !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) fail(`tag 应为 vX.Y.Z[-pre],实际:${tag ?? "(空)"}`);
const version = tag.slice(1);
// 预发布版本进 next,不影响 latest 的使用者
const distTag = version.includes("-") ? "next" : "latest";

const manifests = PACKAGES.map((dir) => ({ dir, ...JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8")) }));
const mismatched = manifests.filter((m) => m.version !== version);
if (mismatched.length) fail(`tag ${tag} 与包版本不一致:${mismatched.map((m) => `${m.name}@${m.version}`).join(", ")}。先运行 pnpm version:set ${version}`);

function published(name) {
  try {
    execFileSync("npm", ["view", `${name}@${version}`, "version"], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false; // 404:包或版本不存在
  }
}

const out = mkdtempSync(join(tmpdir(), "geodive-release-"));
console.log(`发布 ${tag} → dist-tag "${distTag}"${dryRun ? "(演练)" : ""}\n`);
for (const m of manifests) {
  // 演练不跳过:CI 每次都要把打包与清单完整校验一遍
  if (!dryRun && published(m.name)) {
    console.log(`- ${m.name}@${version} 已存在,跳过`);
    continue;
  }
  const before = new Set(readdirSync(out));
  execFileSync("pnpm", ["pack", "--pack-destination", out], { cwd: join(root, "packages", m.dir), stdio: ["ignore", "ignore", "inherit"] });
  const tarball = readdirSync(out).find((f) => !before.has(f));
  if (!tarball) fail(`${m.name} 打包失败`);
  const publishArgs = ["publish", join(out, tarball), "--access", "public", "--tag", distTag];
  // 演练时关掉 provenance:它需要 CI 的 OIDC 身份,本地生成不了
  publishArgs.push(...(dryRun ? ["--dry-run", "--provenance=false"] : ["--provenance"]));
  execFileSync("npm", publishArgs, { stdio: "inherit" });
  console.log(`✓ ${m.name}@${version}${dryRun ? "(演练)" : ""}\n`);
}
