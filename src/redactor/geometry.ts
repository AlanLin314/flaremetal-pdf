import type { CssRect, UserRect } from "./types";

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
