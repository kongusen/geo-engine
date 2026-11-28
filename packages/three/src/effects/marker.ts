import * as THREE from "three";
import type { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { LayerSpec, MarkerDatum, MarkerLayerData, MarkerShape } from "@geodive/core";
import { defineOverlay, disposeTree } from "../overlay";

export type { MarkerDatum, MarkerLayerData, MarkerShape };

const MAX_ICON_CACHE = 256;
const iconCache = new Map<string, THREE.Texture>();

function getCachedTexture(key: string, create: () => THREE.Texture): THREE.Texture {
  const cached = iconCache.get(key);
  if (cached) {
    // 简单 LRU 刷新
    iconCache.delete(key);
    iconCache.set(key, cached);
    return cached;
  }
  const tex = create();
  if (iconCache.size >= MAX_ICON_CACHE) {
    const oldest = iconCache.keys().next().value;
    if (oldest !== undefined) {
      iconCache.get(oldest)?.dispose();
      iconCache.delete(oldest);
    }
  }
  iconCache.set(key, tex);
  return tex;
}

function fallbackTexture(): THREE.Texture {
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

function loadImageTexture(src: string): THREE.Texture {
  if (typeof document === "undefined" || typeof Image === "undefined") return fallbackTexture();
  const img = new Image();
  const trimmed = src.trim();
  const isSvg = trimmed.startsWith("<svg");
  if (!isSvg && !trimmed.startsWith("data:") && !trimmed.startsWith("blob:")) img.crossOrigin = "anonymous";
  const tex = new THREE.Texture(img);
  tex.colorSpace = THREE.SRGBColorSpace;
  img.onload = () => {
    tex.needsUpdate = true;
  };
  img.src = isSvg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(trimmed)}` : trimmed;
  return tex;
}

function drawShapeCanvas(shape: MarkerShape, color: string, badge?: string, active = false): THREE.Texture {
  if (typeof document === "undefined") return fallbackTexture();
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const c = canvas.getContext("2d");
  if (!c) return fallbackTexture();

  c.clearRect(0, 0, size, size);
  const cx = size / 2;
  const cy = shape === "pin" ? size * 0.42 : size / 2;

  if (active) {
    c.save();
    c.beginPath();
    c.arc(cx, cy, size * 0.36, 0, Math.PI * 2);
    c.strokeStyle = "rgba(255, 255, 255, 0.85)";
    c.lineWidth = 6;
    c.stroke();
    c.restore();
  }

  c.save();
  c.fillStyle = color;
  c.strokeStyle = "#ffffff";
  c.lineWidth = 6;
  c.lineJoin = "round";

  if (shape === "pin") {
    const r = size * 0.26;
    c.beginPath();
    c.arc(cx, cy, r, Math.PI * 0.82, Math.PI * 0.18, false);
    c.quadraticCurveTo(cx + r * 0.9, cy + r * 0.9, cx, size * 0.94);
    c.quadraticCurveTo(cx - r * 0.9, cy + r * 0.9, cx - r * Math.cos(Math.PI * 0.18), cy + r * Math.sin(Math.PI * 0.18));
    c.closePath();
    c.fill();
    c.stroke();
    c.beginPath();
    c.arc(cx, cy, r * 0.38, 0, Math.PI * 2);
    c.fillStyle = "#ffffff";
    c.fill();
  } else if (shape === "circle") {
    c.beginPath();
    c.arc(cx, cy, size * 0.28, 0, Math.PI * 2);
    c.fill();
    c.stroke();
  } else if (shape === "diamond") {
    const r = size * 0.3;
    c.beginPath();
    c.moveTo(cx, cy - r);
    c.lineTo(cx + r, cy);
    c.lineTo(cx, cy + r);
    c.lineTo(cx - r, cy);
    c.closePath();
    c.fill();
    c.stroke();
  } else if (shape === "square") {
    const s = size * 0.48;
    const x0 = cx - s / 2;
    const y0 = cy - s / 2;
    c.beginPath();
    c.roundRect(x0, y0, s, s, 10);
    c.fill();
    c.stroke();
  } else if (shape === "triangle") {
    const r = size * 0.32;
    c.beginPath();
    c.moveTo(cx, cy - r);
    c.lineTo(cx + r * 0.92, cy + r * 0.78);
    c.lineTo(cx - r * 0.92, cy + r * 0.78);
    c.closePath();
    c.fill();
    c.stroke();
  }
  c.restore();

  if (badge) {
    c.save();
    const label = badge.slice(0, 4);
    c.font = "bold 24px system-ui, sans-serif";
    const textW = c.measureText(label).width;
    const pw = Math.max(34, textW + 18);
    const ph = 32;
    const px = size - pw - 4;
    const py = 4;
    c.fillStyle = "#ef4444";
    c.strokeStyle = "#ffffff";
    c.lineWidth = 3;
    c.beginPath();
    c.roundRect(px, py, pw, ph, ph / 2);
    c.fill();
    c.stroke();
    c.fillStyle = "#ffffff";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(label, px + pw / 2, py + ph / 2 + 1);
    c.restore();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function markerTexture(marker: MarkerDatum, data: MarkerLayerData, fallbackColor: string): { texture: THREE.Texture; isPin: boolean; texKey: string } {
  const icon = marker.icon ?? data.icon;
  if (icon) {
    const texKey = `icon:${icon}`;
    return {
      texture: getCachedTexture(texKey, () => loadImageTexture(icon)),
      isPin: false,
      texKey,
    };
  }
  const shape = marker.shape ?? data.shape ?? "pin";
  const color = marker.color ?? data.color ?? fallbackColor;
  const badge = marker.badge ?? "";
  const active = !!marker.active;
  const texKey = `shape:${shape}|${color}|${badge}|${active ? 1 : 0}`;
  return {
    texture: getCachedTexture(texKey, () => drawShapeCanvas(shape, color, marker.badge, active)),
    isPin: shape === "pin",
    texKey,
  };
}

interface MarkerEntry {
  marker: MarkerDatum;
  sprite: THREE.Sprite;
  label: CSS2DObject | null;
  localUp: THREE.Vector3;
  sizePx: number;
  isActive: boolean;
  isPin: boolean;
  texKey: string;
  posKey: string;
  labelText: string | undefined;
}

export const markerLayer = defineOverlay<MarkerLayerData>({
  type: "marker",
  modes: ["plane", "globe"],
  create(ctx, spec) {
    let data = spec.data ?? { markers: [] };
    const group = new THREE.Group();
    group.name = "markers";
    ctx.group.add(group);

    const entryMap = new Map<string, MarkerEntry>();
    let entries: MarkerEntry[] = [];
    let hoveredId: string | null = null;
    let opacity = 1;

    const createLabel = (marker: MarkerDatum, isPin: boolean) => {
      const label = ctx.label(marker.label!, {
        fontSize: "13px",
        color: marker.color ?? data.color ?? ctx.theme.label,
        transform: isPin ? "translateY(-18px)" : "translateY(-14px)",
      });
      label.position.set(0, isPin ? 1.05 : 0.65, 0);
      label.element.style.opacity = String(opacity);
      const inner = label.element.firstElementChild as HTMLElement | null;
      if (inner) inner.style.visibility = !data.labelOnHover || marker.active || hoveredId === marker.id ? "visible" : "hidden";
      return label;
    };

    const posKeyOf = (m: MarkerDatum) => `${m.position[0]},${m.position[1]},${m.zOffset ?? 0}`;

    const createEntry = (marker: MarkerDatum): MarkerEntry => {
      const { texture, isPin, texKey } = markerTexture(marker, data, ctx.theme.point);
      const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        opacity,
        depthTest: false,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.name = `marker:${marker.id}`;
      sprite.renderOrder = 8;
      sprite.center.set(0.5, isPin ? 0 : 0.5);
      const zLift = (marker.zOffset ?? 0) + ctx.unitHeight * 0.08;
      sprite.position.copy(ctx.position(marker.position, zLift));
      sprite.userData.marker = marker;

      const label = marker.label ? createLabel(marker, isPin) : null;
      if (label) sprite.add(label);

      group.add(sprite);
      return {
        marker,
        sprite,
        label,
        localUp: ctx.up(marker.position).clone().normalize(),
        sizePx: marker.sizePx ?? data.sizePx ?? 28,
        isActive: !!marker.active,
        isPin,
        texKey,
        posKey: posKeyOf(marker),
        labelText: marker.label,
      };
    };

    const worldPos = new THREE.Vector3();
    const worldUp = new THREE.Vector3();
    const toCamera = new THREE.Vector3();

    const syncScales = () => {
      const camera = ctx.camera();
      const { height } = ctx.resolution();
      const tanHalfFov = Math.tan((camera.fov * Math.PI) / 360);
      group.updateWorldMatrix(true, false);
      for (const entry of entries) {
        entry.sprite.getWorldPosition(worldPos);
        if (ctx.mode === "globe") {
          worldUp.copy(entry.localUp).transformDirection(group.matrixWorld).normalize();
          toCamera.copy(camera.position).sub(worldPos).normalize();
          const front = worldUp.dot(toCamera) > 0.1;
          entry.sprite.visible = front;
          if (entry.label) entry.label.visible = front;
          if (!front) continue;
        }
        const dist = Math.max(1e-4, camera.position.distanceTo(worldPos));
        const worldPerPx = (2 * dist * tanHalfFov) / Math.max(1, height);
        const mul = hoveredId === entry.marker.id ? 1.22 : entry.isActive ? 1.15 : 1;
        const worldSize = Math.max(ctx.scale * 0.004, entry.sizePx * mul * worldPerPx);
        entry.sprite.scale.set(worldSize, worldSize, 1);
      }
    };

    const syncMarkers = (nextData: MarkerLayerData) => {
      data = nextData;
      const wanted = data.clipToRegions ? data.markers.filter((m) => ctx.contains(m.position)) : data.markers;
      const keep = new Set(wanted.map((m) => m.id));
      for (const [id, entry] of entryMap) {
        if (keep.has(id)) continue;
        entry.sprite.removeFromParent();
        disposeTree(entry.sprite);
        entryMap.delete(id);
      }
      const nextEntries: MarkerEntry[] = [];
      for (const marker of wanted) {
        const existing = entryMap.get(marker.id);
        if (!existing) {
          const created = createEntry(marker);
          entryMap.set(marker.id, created);
          nextEntries.push(created);
          continue;
        }
        existing.marker = marker;
        existing.sprite.userData.marker = marker;
        existing.sizePx = marker.sizePx ?? data.sizePx ?? 28;
        existing.isActive = !!marker.active;

        const { texture, isPin, texKey } = markerTexture(marker, data, ctx.theme.point);
        if (texKey !== existing.texKey) {
          existing.sprite.material.map = texture;
          existing.sprite.material.needsUpdate = true;
          existing.sprite.center.set(0.5, isPin ? 0 : 0.5);
          existing.texKey = texKey;
        }

        const posKey = posKeyOf(marker);
        if (posKey !== existing.posKey) {
          const zLift = (marker.zOffset ?? 0) + ctx.unitHeight * 0.08;
          existing.sprite.position.copy(ctx.position(marker.position, zLift));
          existing.localUp.copy(ctx.up(marker.position)).normalize();
          existing.posKey = posKey;
        }

        if (marker.label) {
          if (!existing.label || existing.labelText !== marker.label || existing.isPin !== isPin) {
            if (existing.label) {
              existing.sprite.remove(existing.label);
              existing.label.element.remove();
            }
            existing.label = createLabel(marker, isPin);
            existing.sprite.add(existing.label);
            existing.labelText = marker.label;
          } else {
            const inner = existing.label.element.firstElementChild as HTMLElement | null;
            if (inner) {
              inner.style.color = marker.color ?? data.color ?? ctx.theme.label;
              inner.style.visibility = !data.labelOnHover || existing.isActive || hoveredId === marker.id ? "visible" : "hidden";
            }
          }
        } else if (existing.label) {
          existing.sprite.remove(existing.label);
          existing.label.element.remove();
          existing.label = null;
          existing.labelText = undefined;
        }
        existing.isPin = isPin;
        nextEntries.push(existing);
      }
      entries = nextEntries;
      syncScales();
    };

    syncMarkers(data);

    return {
      update(next: LayerSpec) {
        syncMarkers((next.data as MarkerLayerData | undefined) ?? { markers: [] });
        return true;
      },
      tick() {
        syncScales();
      },
      setOpacity(k) {
        opacity = k;
        for (const entry of entries) {
          entry.sprite.material.opacity = opacity;
          if (entry.label) entry.label.element.style.opacity = String(opacity);
        }
      },
      pick(raycaster) {
        const targets = entries.filter((e) => e.sprite.visible).map((e) => e.sprite);
        if (!targets.length) return null;
        const hit = raycaster.intersectObjects(targets, false)[0];
        const marker = hit?.object.userData.marker as MarkerDatum | undefined;
        return marker ? { item: marker, position: marker.position, distance: hit.distance } : null;
      },
      onHover(hit) {
        hoveredId = (hit?.item as MarkerDatum | undefined)?.id ?? null;
        for (const entry of entries) {
          if (entry.label && data.labelOnHover) {
            const show = entry.isActive || entry.marker.id === hoveredId;
            const inner = entry.label.element.firstElementChild as HTMLElement | null;
            if (inner) inner.style.visibility = show ? "visible" : "hidden";
          }
        }
        syncScales();
      },
      dispose() {
        entryMap.clear();
        entries = [];
        disposeTree(group);
      },
    };
  },
});
