import { Color } from "three";

/** 风格化大屏主题。所有颜色接受 CSS 颜色字符串(hex / rgb())。 */
export interface SceneTheme {
  /** 主色:色阶高端、侧壁、点位。 */
  accent: string;
  /** 画布背景;null 表示透明(透明背景下自动关闭泛光)。 */
  background: string | null;
  /** 色阶低端(数值最小的板块顶面)。 */
  plateLow: string;
  /** 无数据板块顶面。 */
  plateEmpty: string;
  /** 板块侧壁底部颜色。 */
  side: string;
  /** 父级底板。 */
  base: string;
  /** 板块边线(默认:主色提亮)。 */
  edge: string;
  /** 悬停 / 聚焦高亮(未单独指定 highlightEdge / highlightFill 时同时作为描边与混合色)。 */
  highlight: string;
  /** 悬停 / 聚焦时顶面填充规则:"brighten"(同色系提亮,默认)、"none"(不变)或 CSS 颜色(40% 混合)。 */
  highlightFill?: string | "brighten" | "none";
  /** 悬停 / 聚焦时描边与侧壁顶部颜色(缺省取 highlight)。 */
  highlightEdge?: string;
  /** 点位颜色。 */
  point: string;
  label: string;
  /** 标签数值(默认:主色提亮)。 */
  labelValue: string;
  labelShadow: string;
  fontFamily: string;
}

export const DEFAULT_THEME: SceneTheme = {
  accent: "#22d3ee",
  background: "#07111f",
  plateLow: "#0d2b3a",
  plateEmpty: "#132236",
  side: "#030b16",
  base: "#0b1e33",
  edge: "#a5f3fc",
  highlight: "#fde68a",
  highlightFill: "brighten",
  point: "#fde68a",
  label: "#eef6ff",
  labelValue: "#a5f3fc",
  labelShadow: "rgba(0, 6, 16, 0.95)",
  fontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
};

/** 两个 CSS 颜色按 t 混合,返回 hex。 */
export function mixColor(a: string, b: string, t: number): string {
  return `#${new Color(a).lerp(new Color(b), t).getHexString()}`;
}

/** 计算板块 / 球面块高亮时的顶面填充色,避免冷青底色与暖黄 highlight 混合发灰。 */
export function resolveHighlightFill(base: Color, theme: SceneTheme): Color {
  const fill = theme.highlightFill ?? "brighten";
  if (fill === "none") return base.clone();
  if (fill === "brighten") return base.clone().offsetHSL(0, 0.05, 0.14);
  return base.clone().lerp(new Color(fill), 0.4);
}

/** 由主色派生主题:未显式给出的边线 / 数值颜色由主色提亮得到。 */
export function createTheme(partial: Partial<SceneTheme> = {}): SceneTheme {
  const accent = partial.accent || DEFAULT_THEME.accent;
  return {
    ...DEFAULT_THEME,
    edge: mixColor(accent, "#ffffff", 0.55),
    labelValue: mixColor(accent, "#ffffff", 0.45),
    ...Object.fromEntries(Object.entries(partial).filter(([, v]) => v !== undefined)),
    accent,
  };
}
