import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { datavSource } from "@yaoyu/geo-data";
import { describe, expect, it, vi } from "vitest";
import { GeoEngine } from "../engine";

const sample: Record<string, unknown> = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../fixtures/datav-sample.json", import.meta.url)), "utf8"));

function engineWithDatav() {
  const fetch = vi.fn(async (url: string) => {
    const file = url.split("/").pop()!.replace(/\.json$/, "");
    if (!(file in sample)) throw new Error(`HTTP 404:${url}`);
    return sample[file];
  });
  const engine = new GeoEngine({ sources: [datavSource({ fetch })], load: { retries: 0 } });
  return { engine, fetch, files: () => fetch.mock.calls.map(([url]) => url.split("/").pop()) };
}

describe("DataV 懒加载 + 深链接", () => {
  it("URL 恢复直达区县,区县是叶子,不请求不存在的 _full", async () => {
    const { engine, files } = engineWithDatav();
    await engine.start();
    // restore 走 jump,可以直接定位到叶子(聚焦后显示区域自身)
    expect(await engine.drill.restore("522633")).toBe(true);
    expect(engine.drill.state.path.map((r) => r.name)).toEqual(["中华人民共和国", "贵州省", "黔东南苗族侗族自治州", "从江县"]);
    expect(engine.frame().regions.map((r) => r.id)).toEqual(["522633"]);
    expect(engine.isLeaf("522633")).toBe(true);
    expect(files()).not.toContain("522633_full.json");
    // 链上没有虚级时,各级文件只请求一次
    expect(files().filter((f) => f === "520000_full.json")).toHaveLength(1);
  });

  it("直辖市:跳过推导出的 110100 虚级", async () => {
    const { engine } = engineWithDatav();
    await engine.start();
    const path = await engine.ensurePath("110101");
    expect(path.map((r) => r.name)).toEqual(["中华人民共和国", "北京市", "东城区"]);
  });

  it("省直辖县级市:跳过推导出的 429000 虚级", async () => {
    const { engine } = engineWithDatav();
    await engine.start();
    const path = await engine.ensurePath("429004");
    expect(path.map((r) => r.name)).toEqual(["中华人民共和国", "湖北省", "仙桃市"]);
    expect(engine.isLeaf("429004")).toBe(true);
  });
});
