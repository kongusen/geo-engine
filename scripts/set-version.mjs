#!/usr/bin/env node
// 三个包统一改版本号。
//   pnpm version:set 0.2.0
//   pnpm version:set 0.2.0-beta.1
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PACKAGES } from "./packages.mjs";

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("用法:pnpm version:set <x.y.z[-pre]>");
  process.exit(1);
}

for (const dir of PACKAGES) {
  const file = fileURLToPath(new URL(`../packages/${dir}/package.json`, import.meta.url));
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  const from = pkg.version;
  pkg.version = version;
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`${pkg.name}: ${from} → ${version}`);
}
console.log(`\n下一步:git commit -am "chore: release v${version}" && git tag v${version} && git push origin main v${version}`);
