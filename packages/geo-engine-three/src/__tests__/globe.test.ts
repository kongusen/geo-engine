import { describe, expect, it } from "vitest";
import { spherePatchPositions, sphereSegments } from "../globe";
import { MORPH_GLSL, createMorphUniforms } from "../morph";

describe("globe geometry", () => {
  it("大面细分后所有顶点都在球面上", () => {
    const square: [number, number][] = [[80, 20], [120, 20], [120, 50], [80, 50], [80, 20]];
    const positions = spherePatchPositions([[square]], 100, 3);
    expect(positions.length / 9).toBeGreaterThan(100); // 40°×30° 被细分成大量三角形
    for (let i = 0; i < positions.length; i += 3) {
      expect(Math.hypot(positions[i], positions[i + 1], positions[i + 2])).toBeCloseTo(100, 4);
    }
  });

  it("长线段按步长细分", () => {
    const segs = sphereSegments([[[0, 0], [10, 0]]], 1, 2);
    expect(segs.length / 6).toBe(5);
  });

  it("变形 uniforms 默认平面,着色器暴露 geoMorph", () => {
    const u = createMorphUniforms(100);
    expect(u.uMorph.value).toBe(1);
    expect(MORPH_GLSL).toContain("vec3 geoMorph(vec3 p)");
  });
});
