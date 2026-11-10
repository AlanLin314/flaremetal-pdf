import { LineCapStyle, PDFDocument, degrees, rgb, type PDFPage } from "pdf-lib";
import type { LoadedDoc, PageView } from "./document";
import { pageBitmap } from "./document";
import { hexToRgb01, normalizeHex, normalizeRotation } from "./geometry";
import type { Dpi, Redaction, StrokeMark } from "./types";

export type ExportProgress = {
  page: number;
  total: number;
  label: string;
};

export type ExportResult = {
  bytes: Uint8Array;
  mime: string;
  capped: boolean;
};

const JPEG_QUALITY = 0.92;

function paintRedactions(
  canvas: HTMLCanvasElement,
  page: PageView,
  redactions: Redaction[],
  pageIndex: number,
  scale: number,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("瀏覽器無法建立畫布。");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const item of redactions) {
    if (item.page !== pageIndex) continue;
    if (item.kind === "stroke") paintStroke(ctx, page, item, scale, true);
    else paintRect(ctx, page, item, scale);
  }
}

function paintRect(
  ctx: CanvasRenderingContext2D,
  page: PageView,
  item: Extract<Redaction, { kind: "rect" }>,
  scale: number,
): void {
  if (item.rect.w <= 0.25 || item.rect.h <= 0.25) return;
  const css = page.userToCss(item.rect, scale);
  const x = Math.floor(css.x) - 1;
  const y = Math.floor(css.y) - 1;
  const w = Math.ceil(css.w) + 2;
  const h = Math.ceil(css.h) + 2;
  ctx.fillStyle = normalizeHex(item.color);
  ctx.fillRect(x, y, w, h);
}

function paintStroke(
  ctx: CanvasRenderingContext2D,
  page: PageView,
  item: StrokeMark,
  scale: number,
  inflate: boolean,
): void {
  if (!item.points.length) return;
  const color = normalizeHex(item.color);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  const width = Math.max(1, item.width * scale + (inflate ? 2 : 0));
  if (item.points.length === 1) {
    const point = page.userPointToCss(item.points[0], scale);
    ctx.beginPath();
    ctx.arc(point.x, point.y, width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.lineWidth = width;
  ctx.beginPath();
  const first = page.userPointToCss(item.points[0], scale);
  ctx.moveTo(first.x, first.y);
  for (let index = 1; index < item.points.length; index += 1) {
    const point = page.userPointToCss(item.points[index], scale);
    ctx.lineTo(point.x, point.y);
  }
  ctx.stroke();
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) reject(new Error("無法把頁面轉成圖片。"));
        else resolve(blob);
      },
      type,
      quality,
    );
  });
}

function release(canvas: HTMLCanvasElement): void {
  canvas.width = 1;
  canvas.height = 1;
}

function yieldFrame(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("已取消匯出", "AbortError");
}

function scrubMetadata(doc: PDFDocument): void {
  doc.setTitle("");
  doc.setAuthor("");
  doc.setSubject("");
  doc.setKeywords([]);
  doc.setProducer("FlareMetal PDF 編輯器");
  doc.setCreator("FlareMetal PDF 編輯器");
  const now = new Date();
  doc.setCreationDate(now);
  doc.setModificationDate(now);
}

function drawVectorRects(page: PDFPage, redactions: Redaction[], pageIndex: number): void {
  for (const item of redactions) {
    if (item.kind !== "rect" || item.page !== pageIndex || item.rect.w <= 0 || item.rect.h <= 0) continue;
    const color = hexToRgb01(item.color);
    page.drawRectangle({
      x: item.rect.x,
      y: item.rect.y,
      width: item.rect.w,
      height: item.rect.h,
      color: rgb(color.r, color.g, color.b),
      borderWidth: 0,
    });
  }
}

function drawVectorStrokes(page: PDFPage, redactions: Redaction[], pageIndex: number): void {
  for (const item of redactions) {
    if (item.kind !== "stroke" || item.page !== pageIndex || !item.points.length) continue;
    const color = hexToRgb01(item.color);
    const ink = rgb(color.r, color.g, color.b);
    const width = Math.max(item.width, 0.4);
    if (item.points.length === 1) {
      page.drawCircle({
        x: item.points[0].x,
        y: item.points[0].y,
        size: width / 2,
        color: ink,
      });
      continue;
    }
    for (let index = 1; index < item.points.length; index += 1) {
      const start = item.points[index - 1];
      const end = item.points[index];
      if (Math.hypot(end.x - start.x, end.y - start.y) < 0.05) continue;
      page.drawLine({
        start,
        end,
        thickness: width,
        color: ink,
        lineCap: LineCapStyle.Round,
      });
    }
  }
}

function scaleForRaster(item: Redaction, factor: number): Redaction {
  if (factor === 1) return item;
  if (item.kind === "stroke") {
    return {
      ...item,
      width: item.width * factor,
      points: item.points.map((point) => ({ x: point.x * factor, y: point.y * factor })),
    };
  }
  return {
    ...item,
    rect: {
      x: item.rect.x * factor,
      y: item.rect.y * factor,
      w: item.rect.w * factor,
      h: item.rect.h * factor,
    },
  };
}

async function embedCanvas(pdf: PDFDocument, canvas: HTMLCanvasElement, jpeg: boolean) {
  const blob = await canvasToBlob(canvas, jpeg ? "image/jpeg" : "image/png", jpeg ? 0.86 : undefined);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return jpeg ? pdf.embedJpg(bytes) : pdf.embedPng(bytes);
}

export async function exportSecure(options: {
  doc: LoadedDoc;
  redactions: Redaction[];
  rotations: readonly number[];
  dpi: Dpi;
  jpegCleaned?: boolean;
  signal: AbortSignal;
  onProgress: (progress: ExportProgress) => void;
}): Promise<ExportResult> {
  const { doc, redactions, rotations, dpi, signal, onProgress } = options;
  const jpegCleaned = options.jpegCleaned !== false;
  const out = await PDFDocument.create();
  scrubMetadata(out);
  let capped = false;

  for (let index = 0; index < doc.pageCount; index += 1) {
    throwIfAborted(signal);
    onProgress({
      page: index + 1,
      total: doc.pageCount,
      label: `正在把第 ${index + 1} / ${doc.pageCount} 頁轉成圖片`,
    });
    const view = await doc.getPage(index);
    view.setExtraRotation(normalizeRotation(rotations[index] ?? 0));
    view.bump();
    const raster = doc.isRaster(index);
    const requested = doc.kind === "pdf" && !raster ? dpi / 72 : 1;
    const rendered = await pageBitmap(view, requested);
    if (rendered.capped) capped = true;
    throwIfAborted(signal);
    paintRedactions(rendered.canvas, view, redactions, index, rendered.scale);
    const useJpeg = !raster || jpegCleaned;
    const blob = await canvasToBlob(rendered.canvas, useJpeg ? "image/jpeg" : "image/png", useJpeg ? JPEG_QUALITY : undefined);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    release(rendered.canvas);
    const image = useJpeg ? await out.embedJpg(bytes) : await out.embedPng(bytes);
    const px = doc.rasterScale(index) || 1;
    const width = raster ? view.metrics.width / px : doc.kind === "pdf" ? view.metrics.width : (view.metrics.width * 72) / dpi;
    const height = raster ? view.metrics.height / px : doc.kind === "pdf" ? view.metrics.height : (view.metrics.height * 72) / dpi;
    const page = out.addPage([width, height]);
    page.drawImage(image, { x: 0, y: 0, width, height });
    await yieldFrame();
  }

  onProgress({ page: doc.pageCount, total: doc.pageCount, label: "正在組成 PDF" });
  const bytes = await out.save();
  return { bytes, mime: "application/pdf", capped };
}

async function addRasterPage(
  pdf: PDFDocument,
  doc: LoadedDoc,
  index: number,
  redactions: Redaction[],
  extra: number,
  jpeg: boolean,
): Promise<boolean> {
  const view = await doc.getPage(index);
  const px = doc.rasterScale(index) || 1;
  view.setExtraRotation(0);
  view.bump();
  const rendered = await pageBitmap(view, 1);
  const image = await embedCanvas(pdf, rendered.canvas, jpeg);
  release(rendered.canvas);
  const pageW = view.metrics.sourceWidth / px;
  const pageH = view.metrics.sourceHeight / px;
  const page = pdf.addPage([pageW, pageH]);
  page.drawImage(image, { x: 0, y: 0, width: pageW, height: pageH });
  const factor = 1 / px;
  const scaled = redactions.map((item) => scaleForRaster(item, factor));
  drawVectorRects(page, scaled, index);
  drawVectorStrokes(page, scaled, index);
  if (extra !== 0) page.setRotation(degrees(extra));
  view.setExtraRotation(normalizeRotation(extra));
  return rendered.capped;
}

function applyPageRotation(page: PDFPage, extra: number): void {
  const total = normalizeRotation(page.getRotation().angle + extra);
  page.setRotation(degrees(total));
}

export async function exportVisual(options: {
  doc: LoadedDoc;
  redactions: Redaction[];
  rotations: readonly number[];
  jpegCleaned?: boolean;
  signal: AbortSignal;
  onProgress: (progress: ExportProgress) => void;
}): Promise<ExportResult> {
  const { doc, redactions, rotations, signal, onProgress } = options;
  const jpegCleaned = options.jpegCleaned !== false;
  throwIfAborted(signal);
  onProgress({ page: 1, total: doc.pageCount, label: "正在寫入遮蓋" });

  if (doc.kind === "pdf") {
    if (!doc.pdfBytes) throw new Error("找不到原始 PDF。");
    const anyRaster = Array.from({ length: doc.pageCount }, (_, index) => doc.isRaster(index)).some(Boolean);
    let pdf: PDFDocument;
    try {
      pdf = await PDFDocument.load(doc.pdfBytes);
    } catch {
      throw new Error("這個 PDF 無法用一般匯出保留原檔。請改用安全匯出。");
    }
    if (!anyRaster) {
      const pages = pdf.getPages();
      if (pages.length !== doc.pageCount) {
        throw new Error("頁數和畫面不一致，請改用安全匯出。");
      }
      pages.forEach((page, index) => {
        applyPageRotation(page, rotations[index] ?? 0);
        drawVectorRects(page, redactions, index);
        drawVectorStrokes(page, redactions, index);
      });
      const bytes = await pdf.save();
      return { bytes, mime: "application/pdf", capped: false };
    }
    const out = await PDFDocument.create();
    scrubMetadata(out);
    let capped = false;
    for (let index = 0; index < doc.pageCount; index += 1) {
      throwIfAborted(signal);
      onProgress({ page: index + 1, total: doc.pageCount, label: `正在寫入第 ${index + 1} / ${doc.pageCount} 頁` });
      if (doc.isRaster(index)) {
        if (await addRasterPage(out, doc, index, redactions, normalizeRotation(rotations[index] ?? 0), jpegCleaned)) {
          capped = true;
        }
      } else {
        const [copied] = await out.copyPages(pdf, [index]);
        out.addPage(copied);
        applyPageRotation(copied, rotations[index] ?? 0);
        drawVectorRects(copied, redactions, index);
        drawVectorStrokes(copied, redactions, index);
      }
      await yieldFrame();
    }
    const bytes = await out.save();
    return { bytes, mime: "application/pdf", capped };
  }

  const view = await doc.getPage(0);
  const extra = normalizeRotation(rotations[0] ?? 0);
  const px = doc.isRaster(0) ? doc.rasterScale(0) || 1 : 1;
  const sourceW = view.metrics.sourceWidth / px;
  const sourceH = view.metrics.sourceHeight / px;
  view.setExtraRotation(0);
  try {
    const rendered = await pageBitmap(view, 1);
    const jpeg = doc.isRaster(0) && jpegCleaned;
    const pdf = await PDFDocument.create();
    scrubMetadata(pdf);
    const image = await embedCanvas(pdf, rendered.canvas, jpeg);
    release(rendered.canvas);
    const page = pdf.addPage([sourceW, sourceH]);
    page.drawImage(image, { x: 0, y: 0, width: sourceW, height: sourceH });
    const scaled = redactions.map((item) => scaleForRaster(item, 1 / px));
    drawVectorRects(page, scaled, 0);
    drawVectorStrokes(page, scaled, 0);
    if (extra !== 0) page.setRotation(degrees(extra));
    const bytes = await pdf.save();
    return { bytes, mime: "application/pdf", capped: rendered.capped };
  } finally {
    view.setExtraRotation(extra);
  }
}

export async function exportPng(options: {
  doc: LoadedDoc;
  redactions: Redaction[];
  rotations: readonly number[];
  signal: AbortSignal;
  onProgress: (progress: ExportProgress) => void;
}): Promise<ExportResult> {
  if (options.doc.kind !== "image") throw new Error("只有圖片可以匯出成 PNG。");
  options.onProgress({ page: 1, total: 1, label: "正在畫上遮蓋" });
  throwIfAborted(options.signal);
  const view = await options.doc.getPage(0);
  view.setExtraRotation(normalizeRotation(options.rotations[0] ?? 0));
  const rendered = await pageBitmap(view, 1);
  paintRedactions(rendered.canvas, view, options.redactions, 0, rendered.scale);
  const blob = await canvasToBlob(rendered.canvas, "image/png");
  release(rendered.canvas);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, mime: "image/png", capped: rendered.capped };
}
