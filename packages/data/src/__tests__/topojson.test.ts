import { describe, expect, it } from "vitest";
import { topologyToFeatures, type Topology } from "../topojson";

describe("topojson", () => {
  it("解码量化 + 差分编码的共享边", () => {
    // 两个相邻正方形 [0,0]-[1,1] 与 [1,0]-[2,1],共享边 x=1
    const topology: Topology = {
      type: "Topology",
      transform: { scale: [1, 1], translate: [0, 0] },
      arcs: [
        [[1, 0], [0, 1]], // 共享边 (1,0)->(1,1)
        [[1, 1], [-1, 0], [0, -1], [1, 0]], // (1,1)->(0,1)->(0,0)->(1,0)
        [[1, 0], [1, 0], [0, 1], [-1, 0]], // (1,0)->(2,0)->(2,1)->(1,1)
      ],
      objects: {
        regions: {
          type: "GeometryCollection",
          geometries: [
            { type: "Polygon", arcs: [[0, 1]], properties: { name: "西" } },
            { type: "Polygon", arcs: [[2, ~0]], properties: { name: "东" } },
          ],
        },
      },
    };
    const features = topologyToFeatures(topology);
    expect(features.map((f) => f.properties?.name)).toEqual(["西", "东"]);
    expect(features[0].geometry?.coordinates).toEqual([[[1, 0], [1, 1], [0, 1], [0, 0], [1, 0]]]);
    expect(features[1].geometry?.coordinates).toEqual([[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]]);
  });
});
