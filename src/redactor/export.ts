import { PDFDocument, rgb } from "pdf-lib";
import type { LoadedDoc, PageView } from "./document";
import { pageBitmap } from "./document";
import { hexToRgb01, normalizeHex } from "./geometry";
import type { Dpi, Redaction } from "./types";

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
  ctx.imageSmoothingEnabled = false;
  for (const item of redactions) {
    if (item.page !== pageIndex || item.rect.w <= 0.25 || item.rect.h <= 0.25) continue;
    const css = page.userToCss(item.rect, scale);
    const x = Math.floor(css.x) - 1;
    const y = Math.floor(css.y) - 1;
    const w = Math.ceil(css.w) + 2;
    const h = Math.ceil(css.h) + 2;
    ctx.fillStyle = normalizeHex(item.color);
    ctx.fillRect(x, y, w, h);
  }
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
  doc.setProducer("FlareMetal PDF 塗改器");
  doc.setCreator("FlareMetal PDF 塗改器");
  const now = new Date();
  doc.setCreationDate(now);
  doc.setModificationDate(now);
}

function drawVectorRects(page: import("pdf-lib").PDFPage, redactions: Redaction[], pageIndex: number): void {
  for (const item of redactions) {
    if (item.page !== pageIndex || item.rect.w <= 0 || item.rect.h <= 0) continue;
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

export async function exportSecure(options: {
  doc: LoadedDoc;
  redactions: Redaction[];
  dpi: Dpi;
  signal: AbortSignal;
  onProgress: (progress: ExportProgress) => void;
}): Promise<ExportResult> {
  const { doc, redactions, dpi, signal, onProgress } = options;
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
    view.bump();
    const requested = doc.kind === "pdf" ? dpi / 72 : 1;
    const rendered = await pageBitmap(view, requested);
    if (rendered.capped) capped = true;
    throwIfAborted(signal);
    paintRedactions(rendered.canvas, view, redactions, index, rendered.scale);
    const jpeg = new Uint8Array(await (await canvasToBlob(rendered.canvas, "image/jpeg", JPEG_QUALITY)).arrayBuffer());
    release(rendered.canvas);
    const image = await out.embedJpg(jpeg);
    const width = doc.kind === "pdf" ? view.metrics.width : (view.metrics.width * 72) / dpi;
    const height = doc.kind === "pdf" ? view.metrics.height : (view.metrics.height * 72) / dpi;
    const page = out.addPage([width, height]);
    page.drawImage(image, { x: 0, y: 0, width, height });
    await yieldFrame();
  }

  onProgress({ page: doc.pageCount, total: doc.pageCount, label: "正在組成 PDF" });
  const bytes = await out.save();
  return { bytes, mime: "application/pdf", capped };
}

export async function exportVisual(options: {
  doc: LoadedDoc;
  redactions: Redaction[];
  signal: AbortSignal;
  onProgress: (progress: ExportProgress) => void;
}): Promise<ExportResult> {
  const { doc, redactions, signal, onProgress } = options;
  throwIfAborted(signal);
  onProgress({ page: 1, total: doc.pageCount, label: "正在寫入遮蓋" });

  if (doc.kind === "pdf") {
    if (!doc.pdfBytes) throw new Error("找不到原始 PDF。");
    let pdf: PDFDocument;
    try {
      pdf = await PDFDocument.load(doc.pdfBytes);
    } catch {
      throw new Error("這個 PDF 無法用一般匯出保留原檔。請改用安全匯出。");
    }
    const pages = pdf.getPages();
    if (pages.length !== doc.pageCount) {
      throw new Error("頁數和畫面不一致，請改用安全匯出。");
    }
    pages.forEach((page, index) => drawVectorRects(page, redactions, index));
    const bytes = await pdf.save();
    return { bytes, mime: "application/pdf", capped: false };
  }

  const view = await doc.getPage(0);
  const rendered = await pageBitmap(view, 1);
  const pngBlob = await canvasToBlob(rendered.canvas, "image/png");
  release(rendered.canvas);
  const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
  const pdf = await PDFDocument.create();
  scrubMetadata(pdf);
  const image = await pdf.embedPng(pngBytes);
  const page = pdf.addPage([view.metrics.width, view.metrics.height]);
  page.drawImage(image, { x: 0, y: 0, width: view.metrics.width, height: view.metrics.height });
  drawVectorRects(page, redactions, 0);
  const bytes = await pdf.save();
  return { bytes, mime: "application/pdf", capped: rendered.capped };
}

export async function exportPng(options: {
  doc: LoadedDoc;
  redactions: Redaction[];
  signal: AbortSignal;
  onProgress: (progress: ExportProgress) => void;
}): Promise<ExportResult> {
  if (options.doc.kind !== "image") throw new Error("只有圖片可以匯出成 PNG。");
  options.onProgress({ page: 1, total: 1, label: "正在畫上遮蓋" });
  throwIfAborted(options.signal);
  const view = await options.doc.getPage(0);
  const rendered = await pageBitmap(view, 1);
  paintRedactions(rendered.canvas, view, options.redactions, 0, rendered.scale);
  const blob = await canvasToBlob(rendered.canvas, "image/png");
  release(rendered.canvas);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, mime: "image/png", capped: rendered.capped };
}
