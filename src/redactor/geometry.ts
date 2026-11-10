import type { CssRect, UserPoint, UserRect } from "./types";

export const MAX_CANVAS_EDGE = 8192;
export const MAX_CANVAS_AREA = 16_000_000;

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function normalizeHex(input: string): string {
  const raw = input.trim().toLowerCase().replace("#", "");
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  if (!/^[0-9a-f]{6}$/.test(full)) return "#000000";
  return `#${full}`;
}

export function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  const n = Number.parseInt(normalizeHex(hex).slice(1), 16);
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
  };
}

export function normalizeRotation(angle: number): 0 | 90 | 180 | 270 {
  const n = ((Math.round(angle) % 360) + 360) % 360;
  if (n === 90 || n === 180 || n === 270) return n;
  return 0;
}

/** pdf.js convertToViewportRectangle does not order the corners. */
export function viewportCornersToCss(corners: ArrayLike<number>): CssRect {
  const a = Number(corners[0]);
  const b = Number(corners[1]);
  const c = Number(corners[2]);
  const d = Number(corners[3]);
  return {
    x: Math.min(a, c),
    y: Math.min(b, d),
    w: Math.abs(c - a),
    h: Math.abs(d - b),
  };
}

export function normalizeCss(x0: number, y0: number, x1: number, y1: number): CssRect {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0),
    h: Math.abs(y1 - y0),
  };
}

export function clampCss(rect: CssRect, width: number, height: number): CssRect {
  let { x, y, w, h } = rect;
  w = clamp(w, 1, width);
  h = clamp(h, 1, height);
  x = clamp(x, 0, width - w);
  y = clamp(y, 0, height - h);
  return { x, y, w, h };
}

/** Image user space: origin bottom-left, y up, unit = source pixel. */
export function imageUserToCss(rect: UserRect, pageHeight: number, scale: number): CssRect {
  return {
    x: rect.x * scale,
    y: (pageHeight - rect.y - rect.h) * scale,
    w: rect.w * scale,
    h: rect.h * scale,
  };
}

export function imageCssToUser(rect: CssRect, pageHeight: number, scale: number): UserRect {
  const w = rect.w / scale;
  const h = rect.h / scale;
  const x = rect.x / scale;
  const yTop = rect.y / scale;
  return { x, y: pageHeight - yTop - h, w, h };
}

/**
 * Map an unrotated user-space point (origin bottom-left, y up) into visual
 * CSS pixels (origin top-left, y down). Matches pdf.js viewport rotation.
 */
export function imageUserPointToCss(
  point: UserPoint,
  sourceWidth: number,
  sourceHeight: number,
  rotation: 0 | 90 | 180 | 270,
  scale: number,
): UserPoint {
  const { x, y } = point;
  const W = sourceWidth;
  const H = sourceHeight;
  let vx = x;
  let vy = H - y;
  if (rotation === 90) {
    vx = y;
    vy = x;
  } else if (rotation === 180) {
    vx = W - x;
    vy = y;
  } else if (rotation === 270) {
    vx = H - y;
    vy = W - x;
  }
  return { x: vx * scale, y: vy * scale };
}

export function imageCssPointToUser(
  point: UserPoint,
  sourceWidth: number,
  sourceHeight: number,
  rotation: 0 | 90 | 180 | 270,
  scale: number,
): UserPoint {
  const vx = point.x / (scale || 1);
  const vy = point.y / (scale || 1);
  const W = sourceWidth;
  const H = sourceHeight;
  if (rotation === 90) return { x: vy, y: vx };
  if (rotation === 180) return { x: W - vx, y: vy };
  if (rotation === 270) return { x: W - vy, y: H - vx };
  return { x: vx, y: H - vy };
}

export function boundsOfPoints(points: UserPoint[]): UserRect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (!points.length) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function pointDistance(a: UserPoint, b: UserPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function dedupePoints(points: UserPoint[], minDist = 0.25): UserPoint[] {
  if (!points.length) return [];
  const out: UserPoint[] = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    if (pointDistance(out[out.length - 1], points[index]) >= minDist) out.push(points[index]);
  }
  const last = points[points.length - 1];
  if (pointDistance(out[out.length - 1], last) > 0.01) out.push(last);
  return out;
}

function sampleQuad(p0: UserPoint, p1: UserPoint, p2: UserPoint, steps: number): UserPoint[] {
  const sampled: UserPoint[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const u = 1 - t;
    sampled.push({
      x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
      y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
    });
  }
  return sampled;
}

/** Quadratic smoothing that keeps the first and last sample on the pointer. */
export function smoothPoints(points: UserPoint[]): UserPoint[] {
  if (points.length < 3) return points.map((point) => ({ ...point }));
  const out: UserPoint[] = [];
  const push = (point: UserPoint) => {
    const prev = out[out.length - 1];
    if (!prev || pointDistance(prev, point) > 0.12) out.push(point);
  };
  push(points[0]);
  for (let index = 1; index < points.length - 1; index += 1) {
    const prev = points[index - 1];
    const curr = points[index];
    const next = points[index + 1];
    const midA = { x: (prev.x + curr.x) / 2, y: (prev.y + curr.y) / 2 };
    const midB = { x: (curr.x + next.x) / 2, y: (curr.y + next.y) / 2 };
    if (index === 1) push(midA);
    for (const point of sampleQuad(midA, curr, midB, 3)) push(point);
  }
  push(points[points.length - 1]);
  return out;
}

function nearCircle(point: UserPoint, eraser: UserPoint[], radiusSq: number): boolean {
  for (const sample of eraser) {
    const dx = point.x - sample.x;
    const dy = point.y - sample.y;
    if (dx * dx + dy * dy <= radiusSq) return true;
  }
  return false;
}

/**
 * Remove parts of a stroke covered by the eraser. Returns the original point
 * array (same reference) when nothing was hit, so callers can skip copies.
 * Leftover pieces keep enough points to stroke with round caps.
 */
export function eraseStroke(points: UserPoint[], eraser: UserPoint[], radius: number): UserPoint[][] {
  if (!points.length) return [];
  if (!eraser.length || radius <= 0) return [points];
  const radiusSq = radius * radius;
  if (points.length === 1) return nearCircle(points[0], eraser, radiusSq) ? [] : [points];
  const step = Math.max(radius / 4, 0.35);
  const samples: Array<{ point: UserPoint; dead: boolean }> = [];
  const push = (point: UserPoint) => samples.push({ point, dead: nearCircle(point, eraser, radiusSq) });
  push(points[0]);
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    const length = pointDistance(from, to);
    const count = Math.max(1, Math.ceil(length / step));
    for (let sample = 1; sample <= count; sample += 1) {
      const t = sample / count;
      push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    }
  }
  if (samples.every((sample) => !sample.dead)) return [points];
  const groups: UserPoint[][] = [];
  let current: UserPoint[] = [];
  const flush = () => {
    if (current.length >= 2) groups.push(current);
    current = [];
  };
  for (const sample of samples) {
    if (sample.dead) {
      flush();
      continue;
    }
    const prev = current[current.length - 1];
    if (!prev || pointDistance(prev, sample.point) > 0.05) current.push(sample.point);
  }
  flush();
  return groups;
}

export function capScale(
  pageW: number,
  pageH: number,
  scale: number,
  maxEdge = MAX_CANVAS_EDGE,
  maxArea = MAX_CANVAS_AREA,
): number {
  if (pageW <= 0 || pageH <= 0 || scale <= 0) return scale;
  let s = scale;
  const edge = Math.max(pageW, pageH) * s;
  if (edge > maxEdge) s *= maxEdge / edge;
  const area = pageW * pageH * s * s;
  if (area > maxArea) s *= Math.sqrt(maxArea / area);
  return s;
}

export function redactedFilename(name: string, ext: "pdf" | "png"): string {
  const trimmed = name.trim() || "document";
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const base = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const safe = stem.replace(/[^\w.\- ()\u3400-\u9fff]+/g, "_") || "document";
  return `${safe}_redacted.${ext}`;
}

export function detectKind(
  bytes: Uint8Array,
  mime: string,
  filename: string,
): "pdf" | "jpeg" | "png" | null {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return "pdf";
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  const type = mime.toLowerCase();
  const name = filename.toLowerCase();
  if (type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (type === "image/png" || name.endsWith(".png")) return "png";
  if (type === "image/jpeg" || name.endsWith(".jpg") || name.endsWith(".jpeg")) return "jpeg";
  return null;
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
