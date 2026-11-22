export interface DensityPoint {
  x: number;
  y: number;
  weight?: number;
}

export interface DensityGrid {
  cols: number;
  rows: number;
  /** 行优先,第 0 行对应 minY。 */
  values: Float32Array;
  max: number;
}

/**
 * 高斯核密度网格(热力图底层数据)。坐标与 radius 同单位(平面坐标),
 * radius 为核的 3σ 截断半径;超出范围的贡献忽略。
 */
export function densityGrid(
  points: DensityPoint[],
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  cols: number,
  rows: number,
  radius: number,
): DensityGrid {
  const values = new Float32Array(cols * rows);
  const cw = (bounds.maxX - bounds.minX) / cols;
  const ch = (bounds.maxY - bounds.minY) / rows;
  const sigma = radius / 3;
  const inv = 1 / (2 * sigma * sigma);
  for (const p of points) {
    const w = p.weight ?? 1;
    const c0 = Math.max(0, Math.floor((p.x - radius - bounds.minX) / cw));
    const c1 = Math.min(cols - 1, Math.ceil((p.x + radius - bounds.minX) / cw));
    const r0 = Math.max(0, Math.floor((p.y - radius - bounds.minY) / ch));
    const r1 = Math.min(rows - 1, Math.ceil((p.y + radius - bounds.minY) / ch));
    for (let r = r0; r <= r1; r++) {
      const cy = bounds.minY + (r + 0.5) * ch;
      for (let c = c0; c <= c1; c++) {
        const cx = bounds.minX + (c + 0.5) * cw;
        const d2 = (cx - p.x) ** 2 + (cy - p.y) ** 2;
        if (d2 > radius * radius) continue;
        values[r * cols + c] += w * Math.exp(-d2 * inv);
      }
    }
  }
  let max = 0;
  for (const v of values) if (v > max) max = v;
  return { cols, rows, values, max };
}
