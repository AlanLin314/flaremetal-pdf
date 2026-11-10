import type { PDFPageProxy, PageViewport, RenderTask } from "pdfjs-dist";
import {
  boundsOfPoints,
  capScale,
  detectKind,
  imageCssPointToUser,
  imageUserPointToCss,
  normalizeRotation,
  toArrayBuffer,
  viewportCornersToCss,
} from "./geometry";
import { errorName, loadPdfDocument } from "./pdfjs";
import type { CssRect, PageMetrics, UserPoint, UserRect } from "./types";

export class OpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenError";
  }
}

export interface PageView {
  readonly metrics: PageMetrics;
  /** Extra clockwise rotation on top of the file's own rotation. */
  setExtraRotation(extra: 0 | 90 | 180 | 270): void;
  /** Drop in-flight and queued renders of this page. */
  bump(): void;
  /** Draw the clean page (no redactions) at `scale` pixels per point/pixel. */
  render(canvas: HTMLCanvasElement, scale: number): Promise<boolean>;
  userToCss(rect: UserRect, scale: number): CssRect;
  cssToUser(rect: CssRect, scale: number): UserRect;
  userPointToCss(point: UserPoint, scale: number): UserPoint;
  cssPointToUser(point: UserPoint, scale: number): UserPoint;
}

export interface LoadedDoc {
  kind: "pdf" | "image";
  filename: string;
  pageCount: number;
  /** Original PDF bytes kept for visual-only export. */
  pdfBytes?: Uint8Array;
  getPage(index: number): Promise<PageView>;
  /** True when this page is a processed bitmap rather than the original PDF page. */
  isRaster(index: number): boolean;
  /** Pixels per PDF point for a raster page. Images use 1. */
  rasterScale(index: number): number;
  /** The bitmap currently shown for this page, if it is a raster. */
  liveBitmap(index: number): ImageBitmap | null;
  /**
   * Show `bitmap` for this page, or restore the original PDF page when null.
   * The document does not close bitmaps; the caller owns them.
   */
  setRaster(index: number, bitmap: ImageBitmap | null, pxPerPoint: number): void;
  /** Give bitmap lifetime to the caller. Images only. */
  handoffBitmap(): ImageBitmap | null;
  close(): void;
}

function isCancel(err: unknown): boolean {
  return errorName(err) === "RenderingCancelledException";
}

class PdfPageView implements PageView {
  metrics: PageMetrics;
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();
  private task: RenderTask | null = null;
  private dead = false;
  private extra: 0 | 90 | 180 | 270 = 0;
  private readonly baseRotation: 0 | 90 | 180 | 270;

  constructor(private readonly page: PDFPageProxy) {
    this.baseRotation = normalizeRotation(page.rotate);
    this.metrics = this.measure();
  }

  setExtraRotation(extra: 0 | 90 | 180 | 270): void {
    const next = normalizeRotation(extra);
    if (next === this.extra) return;
    this.extra = next;
    this.metrics = this.measure();
    this.bump();
  }

  bump(): void {
    this.generation += 1;
    try {
      this.task?.cancel();
    } catch {
      /* already finished */
    }
  }

  render(canvas: HTMLCanvasElement, scale: number): Promise<boolean> {
    const gen = this.generation;
    const job = this.tail.then(() => this.renderNow(canvas, scale, gen));
    this.tail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }

  private async renderNow(canvas: HTMLCanvasElement, scale: number, gen: number): Promise<boolean> {
    if (this.dead || gen !== this.generation) return false;
    const safe = capScale(this.metrics.width, this.metrics.height, scale);
    const viewport = this.viewport(safe);
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    if (gen !== this.generation) return false;
    const task = this.page.render({ canvas, viewport });
    this.task = task;
    try {
      await task.promise;
      return gen === this.generation && !this.dead;
    } catch (err) {
      if (isCancel(err) || gen !== this.generation) return false;
      throw err;
    } finally {
      if (this.task === task) this.task = null;
    }
  }

  userToCss(rect: UserRect, scale: number): CssRect {
    const viewport = this.viewport(scale);
    return viewportCornersToCss(
      viewport.convertToViewportRectangle([rect.x, rect.y, rect.x + rect.w, rect.y + rect.h]) as number[],
    );
  }

  cssToUser(rect: CssRect, scale: number): UserRect {
    const viewport = this.viewport(scale);
    const p1 = viewport.convertToPdfPoint(rect.x, rect.y) as [number, number];
    const p2 = viewport.convertToPdfPoint(rect.x + rect.w, rect.y + rect.h) as [number, number];
    const x = Math.min(p1[0], p2[0]);
    const y = Math.min(p1[1], p2[1]);
    return { x, y, w: Math.abs(p2[0] - p1[0]), h: Math.abs(p2[1] - p1[1]) };
  }

  userPointToCss(point: UserPoint, scale: number): UserPoint {
    const [x, y] = this.viewport(scale).convertToViewportPoint(point.x, point.y) as [number, number];
    return { x, y };
  }

  cssPointToUser(point: UserPoint, scale: number): UserPoint {
    const [x, y] = this.viewport(scale).convertToPdfPoint(point.x, point.y) as [number, number];
    return { x, y };
  }

  private totalRotation(): 0 | 90 | 180 | 270 {
    return normalizeRotation(this.baseRotation + this.extra);
  }

  private viewport(scale: number): PageViewport {
    return this.page.getViewport({ scale, rotation: this.totalRotation() });
  }

  private measure(): PageMetrics {
    const visual = this.viewport(1);
    const source = this.page.getViewport({ scale: 1, rotation: 0 });
    return {
      width: visual.width,
      height: visual.height,
      rotation: this.totalRotation(),
      sourceWidth: source.width,
      sourceHeight: source.height,
    };
  }

  dispose(): void {
    this.dead = true;
    this.bump();
    this.page.cleanup();
  }
}

class PdfDoc implements LoadedDoc {
  readonly kind = "pdf" as const;
  readonly pageCount: number;
  private readonly pages = new Map<number, PdfPageView>();
  private readonly rasters = new Map<number, { view: ImagePageView; bitmap: ImageBitmap; pxPerPoint: number }>();
  private closed = false;

  constructor(
    readonly filename: string,
    private readonly pdf: import("pdfjs-dist").PDFDocumentProxy,
    readonly pdfBytes: Uint8Array,
  ) {
    this.pageCount = pdf.numPages;
  }

  async getPage(index: number): Promise<PageView> {
    if (this.closed) throw new OpenError("檔案已關閉。");
    const raster = this.rasters.get(index);
    if (raster) return raster.view;
    const cached = this.pages.get(index);
    if (cached) return cached;
    const proxy = await this.pdf.getPage(index + 1);
    const view = new PdfPageView(proxy);
    this.pages.set(index, view);
    return view;
  }

  isRaster(index: number): boolean {
    return this.rasters.has(index);
  }

  rasterScale(index: number): number {
    return this.rasters.get(index)?.pxPerPoint ?? 1;
  }

  liveBitmap(index: number): ImageBitmap | null {
    return this.rasters.get(index)?.bitmap ?? null;
  }

  setRaster(index: number, bitmap: ImageBitmap | null, pxPerPoint: number): void {
    if (this.closed) return;
    if (!bitmap) {
      this.rasters.delete(index);
      return;
    }
    this.rasters.set(index, { view: new ImagePageView(bitmap), bitmap, pxPerPoint });
  }

  handoffBitmap(): ImageBitmap | null {
    return null;
  }

  close(): void {
    this.closed = true;
    for (const page of this.pages.values()) page.dispose();
    this.pages.clear();
    this.rasters.clear();
    void this.pdf.destroy();
  }
}

class ImagePageView implements PageView {
  metrics: PageMetrics;
  private extra: 0 | 90 | 180 | 270 = 0;

  constructor(private readonly bitmap: ImageBitmap) {
    this.metrics = this.measure();
  }

  setExtraRotation(extra: 0 | 90 | 180 | 270): void {
    const next = normalizeRotation(extra);
    if (next === this.extra) return;
    this.extra = next;
    this.metrics = this.measure();
  }

  bump(): void {
    /* raster draws are synchronous after the bitmap exists */
  }

  render(canvas: HTMLCanvasElement, scale: number): Promise<boolean> {
    const safe = capScale(this.metrics.width, this.metrics.height, scale);
    canvas.width = Math.max(1, Math.floor(this.metrics.width * safe));
    canvas.height = Math.max(1, Math.floor(this.metrics.height * safe));
    const ctx = canvas.getContext("2d");
    if (!ctx) return Promise.resolve(false);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const srcW = this.bitmap.width * safe;
    const srcH = this.bitmap.height * safe;
    ctx.save();
    if (this.extra === 90) {
      ctx.translate(canvas.width, 0);
      ctx.rotate(Math.PI / 2);
    } else if (this.extra === 180) {
      ctx.translate(canvas.width, canvas.height);
      ctx.rotate(Math.PI);
    } else if (this.extra === 270) {
      ctx.translate(0, canvas.height);
      ctx.rotate(-Math.PI / 2);
    }
    ctx.drawImage(this.bitmap, 0, 0, srcW, srcH);
    ctx.restore();
    return Promise.resolve(true);
  }

  userToCss(rect: UserRect, scale: number): CssRect {
    return boundsOfPoints([
      this.userPointToCss({ x: rect.x, y: rect.y }, scale),
      this.userPointToCss({ x: rect.x + rect.w, y: rect.y + rect.h }, scale),
    ]);
  }

  cssToUser(rect: CssRect, scale: number): UserRect {
    return boundsOfPoints([
      this.cssPointToUser({ x: rect.x, y: rect.y }, scale),
      this.cssPointToUser({ x: rect.x + rect.w, y: rect.y + rect.h }, scale),
    ]);
  }

  userPointToCss(point: UserPoint, scale: number): UserPoint {
    return imageUserPointToCss(point, this.bitmap.width, this.bitmap.height, this.extra, scale);
  }

  cssPointToUser(point: UserPoint, scale: number): UserPoint {
    return imageCssPointToUser(point, this.bitmap.width, this.bitmap.height, this.extra, scale);
  }

  private measure(): PageMetrics {
    const swap = this.extra === 90 || this.extra === 270;
    return {
      width: swap ? this.bitmap.height : this.bitmap.width,
      height: swap ? this.bitmap.width : this.bitmap.height,
      rotation: this.extra,
      sourceWidth: this.bitmap.width,
      sourceHeight: this.bitmap.height,
    };
  }
}

class ImageDoc implements LoadedDoc {
  readonly kind = "image" as const;
  readonly pageCount = 1;
  private view: ImagePageView;
  private bitmap: ImageBitmap;
  private readonly original: ImageBitmap;
  private pxPerPoint = 1;
  private replaced = false;
  private owns = true;
  private closed = false;

  constructor(
    readonly filename: string,
    bitmap: ImageBitmap,
  ) {
    this.original = bitmap;
    this.bitmap = bitmap;
    this.view = new ImagePageView(bitmap);
  }

  getPage(index: number): Promise<PageView> {
    if (this.closed || index !== 0) return Promise.reject(new OpenError("找不到這個頁面。"));
    return Promise.resolve(this.view);
  }

  isRaster(index: number): boolean {
    return index === 0 && this.replaced;
  }

  rasterScale(index: number): number {
    return index === 0 ? this.pxPerPoint : 1;
  }

  liveBitmap(index: number): ImageBitmap | null {
    return index === 0 ? this.bitmap : null;
  }

  setRaster(index: number, bitmap: ImageBitmap | null, pxPerPoint: number): void {
    if (this.closed || index !== 0) return;
    const next = bitmap ?? this.original;
    this.owns = false;
    this.bitmap = next;
    this.view = new ImagePageView(next);
    this.pxPerPoint = bitmap ? pxPerPoint || 1 : 1;
    this.replaced = next !== this.original;
  }

  handoffBitmap(): ImageBitmap | null {
    this.owns = false;
    return this.original;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.owns) this.bitmap.close();
  }
}

function pdfMessage(err: unknown): string {
  const name = errorName(err);
  if (name === "PasswordException") return "這個 PDF 有密碼保護。請先在別的工具解除密碼，再拿到這裡塗改。";
  if (name === "InvalidPDFException") return "無法讀取這個 PDF，檔案可能已損壞。";
  return "無法開啟這個 PDF。";
}

export async function openFile(
  file: File,
  onProgress?: (ratio: number | null) => void,
): Promise<LoadedDoc> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const kind = detectKind(bytes, file.type, file.name);
  if (!kind) throw new OpenError("請選擇 PDF、JPG 或 PNG。");

  if (kind === "pdf") {
    const kept = bytes.slice(0);
    try {
      const task = loadPdfDocument(bytes.slice(0), onProgress);
      const pdf = await task.promise;
      if (pdf.numPages < 1) {
        await pdf.destroy();
        throw new OpenError("這份 PDF 沒有頁面。");
      }
      return new PdfDoc(file.name || "document.pdf", pdf, kept);
    } catch (err) {
      if (err instanceof OpenError) throw err;
      throw new OpenError(pdfMessage(err));
    }
  }

  try {
    const blob = new Blob([toArrayBuffer(bytes)], {
      type: kind === "png" ? "image/png" : "image/jpeg",
    });
    const bitmap = await createImageBitmap(blob);
    if (bitmap.width < 1 || bitmap.height < 1) {
      bitmap.close();
      throw new OpenError("這張圖片是空的。");
    }
    return new ImageDoc(file.name || (kind === "png" ? "image.png" : "image.jpg"), bitmap);
  } catch (err) {
    if (err instanceof OpenError) throw err;
    throw new OpenError("無法讀取這張圖片。");
  }
}

export async function pageBitmap(
  page: PageView,
  scale: number,
): Promise<{ canvas: HTMLCanvasElement; scale: number; capped: boolean }> {
  const requested = scale;
  const safe = capScale(page.metrics.width, page.metrics.height, requested);
  const canvas = document.createElement("canvas");
  const ok = await page.render(canvas, safe);
  if (!ok) throw new DOMException("已取消", "AbortError");
  return { canvas, scale: safe, capped: safe < requested * 0.985 };
}
