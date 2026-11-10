import type { LoadedDoc, PageView } from "./document";
import { openFile, pageBitmap } from "./document";
import { cleanBitmap, loadCleaner, type CleanOptions, type CleanPoint } from "./cleanup";
import { exportPng, exportSecure, exportVisual, type ExportProgress } from "./export";
import {
  clamp,
  clampCss,
  dedupePoints,
  eraseStroke,
  normalizeCss,
  normalizeHex,
  normalizeRotation,
  redactedFilename,
  smoothPoints,
  toArrayBuffer,
} from "./geometry";
import { icon, type IconName } from "./icons";
import type { CssRect, Dpi, HistoryState, Redaction, UserPoint } from "./types";
import { DEFAULT_DPI, DPI_CHOICES } from "./types";

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
const SVG_NS = "http://www.w3.org/2000/svg";

type Tool = "rect" | "brush" | "eraser" | "pan";

type Drag =
  | { type: "draw"; x0: number; y0: number }
  | { type: "move"; id: string; origin: CssRect; x: number; y: number }
  | { type: "resize"; id: string; handle: string; origin: CssRect; x: number; y: number }
  | { type: "brush"; points: UserPoint[]; width: number }
  | { type: "erase"; points: UserPoint[] };

const MARK = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#12161a"/><path d="M16 5.5l1.6 6.6L24 13.6l-6.4 1.7L16 22l-1.6-6.7L8 13.6l6.4-1.5L16 5.5z" fill="#e85d2c"/><rect x="8" y="24" width="16" height="2.2" rx="1" fill="#e7eeea"/></svg>`;

export function mountRedactor(root: HTMLElement): () => void {
  const app = new RedactorApp(root);
  return () => app.destroy();
}

class RedactorApp {
  private readonly ac = new AbortController();
  private doc: LoadedDoc | null = null;
  private view: PageView | null = null;
  private pageIndex = 0;
  private zoom = 1;
  private zoomMode: "fit-width" | "manual" = "fit-width";
  private redactions: Redaction[] = [];
  private rotations: number[] = [];
  private selectedId: string | null = null;
  private color = "#000000";
  private tool: Tool = "rect";
  private brushPx = 18;
  private busy = false;
  private exporting = false;
  private undo: string[] = [];
  private redo: string[] = [];
  private rasters: Array<ImageBitmap | null> = [];
  private scales: number[] = [];
  private rasterUndo: Array<Array<ImageBitmap | null>> = [];
  private rasterRedo: Array<Array<ImageBitmap | null>> = [];
  private gestureRasters: Array<ImageBitmap | null> | null = null;
  private jpegCleaned = true;
  private cleanToken = 0;
  private cleanOpen = false;
  private cleanOpts: CleanOptions = {
    whiten: true,
    strength: "medium",
    deskew: false,
    perspective: false,
    binary: false,
    threshold: 8,
    corners: null,
  };
  private cleanCorners: CleanPoint[] | null = null;
  private cleanMoved = false;
  private cleanHolding = false;
  private cleanSource: ImageBitmap | null = null;
  private cleanResult: ImageBitmap | null = null;
  private cleanTimer = 0;
  private gestureBefore: string | null = null;
  private drag: Drag | null = null;
  private mainToken = 0;
  private markToken = 0;
  private exportAbort: AbortController | null = null;
  private dpi: Dpi = DEFAULT_DPI;
  private thumbObs: IntersectionObserver | null = null;
  private modalResolver: (() => void) | null = null;
  private stickToTop = false;
  private printFrame: HTMLIFrameElement | null = null;

  private readonly fileInput: HTMLInputElement;
  private readonly openBtn: HTMLButtonElement;
  private readonly exportBtn: HTMLButtonElement;
  private readonly printBtn: HTMLButtonElement;
  private readonly thumbs: HTMLElement;
  private readonly toolbar: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly pageWrap: HTMLElement;
  private canvas: HTMLCanvasElement | null = null;
  private readonly overlay: HTMLElement;
  private readonly draft: HTMLElement;
  private readonly cursor: HTMLElement;
  private readonly status: HTMLElement;
  private readonly alert: HTMLElement;
  private readonly modalBack: HTMLElement;
  private readonly modal: HTMLElement;
  private readonly dropveil: HTMLElement;
  private readonly shell: HTMLElement;

  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private deleteBtn!: HTMLButtonElement;
  private zoomLabel!: HTMLButtonElement;
  private rectBtn!: HTMLButtonElement;
  private brushBtn!: HTMLButtonElement;
  private eraserBtn!: HTMLButtonElement;
  private panBtn!: HTMLButtonElement;
  private prevBtn!: HTMLButtonElement;
  private nextBtn!: HTMLButtonElement;
  private sizeInput!: HTMLInputElement;
  private sizeReadout!: HTMLElement;

  constructor(private readonly root: HTMLElement) {
    this.root.classList.add("redactor-host");
    this.root.replaceChildren();
    this.shell = document.createElement("div");
    this.shell.className = "fm-app is-empty";
    this.shell.dataset.tool = "rect";
    this.shell.innerHTML = `
      <header class="topbar glass">
        <div class="brand">${MARK}<h1>FlareMetal <span>PDF 編輯器</span></h1></div>
        <div class="top-actions">
          <button type="button" class="btn" data-open>${icon("folder")}<span class="full">開啟檔案</span><span class="short">開啟</span></button>
          <button type="button" class="btn" data-print disabled>${icon("print")}<span class="full">列印</span><span class="short">列印</span></button>
          <button type="button" class="btn primary" data-export disabled>${icon("download")}<span class="full">匯出</span><span class="short">匯出</span></button>
        </div>
      </header>
      <div class="workspace">
        <aside class="thumbs glass" aria-label="頁面縮圖"></aside>
        <div class="stage">
          <p class="alert" hidden></p>
          <div class="empty">
            <div class="empty-card glass">
              ${MARK}
              <h2>塗改檔案</h2>
              <p>拖放或選擇 PDF、JPG、PNG。檔案不會上傳。</p>
              <button type="button" class="btn primary" data-open-empty>${icon("folder")}選擇檔案</button>
            </div>
          </div>
          <div class="page-wrap" hidden>
            <div class="overlay">
              <div class="draft" hidden></div>
              <div class="brush-cursor" hidden></div>
            </div>
            <div class="page-rotate glass">
              <button type="button" class="btn icon" data-turn-page="-90" title="左轉" aria-label="左轉">${icon("turnLeft")}</button>
              <button type="button" class="btn icon" data-turn-page="90" title="右轉" aria-label="右轉">${icon("turnRight")}</button>
            </div>
          </div>
        </div>
      </div>
      <div class="dock-wrap">
        <footer class="status" role="status">尚未開啟檔案 · 不會上傳</footer>
        <div class="toolbar glass" role="toolbar" aria-label="塗改工具"></div>
      </div>
      <div class="clean-panel glass" hidden>
        <div class="clean-head">
          <h2>整理</h2>
          <button type="button" class="btn icon" data-clean-close aria-label="關閉整理">${icon("left")}</button>
        </div>
        <p class="clean-note">只在這台裝置上處理，不會上傳。建議先整理，再塗改。</p>
        <div class="clean-view">
          <div class="clean-source-wrap">
            <canvas class="clean-source" hidden></canvas>
            <div class="clean-corners" hidden></div>
          </div>
          <canvas class="clean-result"></canvas>
        </div>
        <p class="clean-status">開啟檔案後可預覽。</p>
        <div class="clean-progress" hidden><span></span></div>
      </div>
      <div class="dropveil glass" hidden>放開以開啟檔案</div>
      <div class="modal-back" hidden>
        <div class="modal glass" role="dialog" aria-modal="true" aria-labelledby="modal-title"></div>
      </div>
    `;
    this.root.append(this.shell);

    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.accept = ".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg";
    this.fileInput.hidden = true;
    this.root.append(this.fileInput);

    this.openBtn = this.shell.querySelector("[data-open]") as HTMLButtonElement;
    this.exportBtn = this.shell.querySelector("[data-export]") as HTMLButtonElement;
    this.printBtn = this.shell.querySelector("[data-print]") as HTMLButtonElement;
    this.thumbs = this.shell.querySelector(".thumbs") as HTMLElement;
    this.toolbar = this.shell.querySelector(".toolbar") as HTMLElement;
    this.stage = this.shell.querySelector(".stage") as HTMLElement;
    this.empty = this.shell.querySelector(".empty") as HTMLElement;
    this.pageWrap = this.shell.querySelector(".page-wrap") as HTMLElement;
    this.overlay = this.pageWrap.querySelector(".overlay") as HTMLElement;
    this.draft = this.overlay.querySelector(".draft") as HTMLElement;
    this.cursor = this.overlay.querySelector(".brush-cursor") as HTMLElement;
    this.status = this.shell.querySelector(".status") as HTMLElement;
    this.alert = this.shell.querySelector(".alert") as HTMLElement;
    this.modalBack = this.shell.querySelector(".modal-back") as HTMLElement;
    this.modal = this.shell.querySelector(".modal") as HTMLElement;
    this.dropveil = this.shell.querySelector(".dropveil") as HTMLElement;

    this.buildToolbar();
    this.buildCleanPanel();
    this.bind();
  }

  destroy(): void {
    this.exportAbort?.abort();
    this.thumbObs?.disconnect();
    this.doc?.close();
    this.releaseAllRasters();
    this.printFrame?.remove();
    this.ac.abort();
    this.root.replaceChildren();
  }

  private bind(): void {
    const signal = this.ac.signal;
    this.openBtn.addEventListener("click", () => this.fileInput.click(), { signal });
    this.shell.querySelector("[data-open-empty]")?.addEventListener("click", () => this.fileInput.click(), { signal });
    this.exportBtn.addEventListener("click", () => this.openOutput("download"), { signal });
    this.printBtn.addEventListener("click", () => this.openOutput("print"), { signal });
    this.fileInput.addEventListener("change", () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = "";
      if (file) void this.loadFile(file);
    }, { signal });

    this.pageWrap.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest("[data-turn-page]") : null;
      if (!(button instanceof HTMLElement) || !this.doc) return;
      this.turnPages(this.pageIndex, Number(button.dataset.turnPage));
    }, { signal });

    this.overlay.addEventListener("pointerdown", (event) => this.onPointerDown(event), { signal });
    this.overlay.addEventListener("pointermove", (event) => this.onPointerMove(event), { signal });
    this.overlay.addEventListener("pointerup", (event) => this.onPointerUp(event), { signal });
    this.overlay.addEventListener("pointercancel", (event) => this.onPointerUp(event), { signal });
    this.overlay.addEventListener("pointerleave", () => this.placeCursor(null), { signal });
    this.overlay.addEventListener("contextmenu", (event) => event.preventDefault(), { signal });

    window.addEventListener("keydown", (event) => this.onKey(event), { signal });
    window.addEventListener("resize", () => {
      if (this.doc && this.zoomMode === "fit-width") void this.renderMain();
    }, { signal });

    this.stage.addEventListener("wheel", (event) => {
      if (!this.doc || (!event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      this.setZoom(this.zoom * (event.deltaY < 0 ? 1.08 : 0.92), "manual");
    }, { signal, passive: false });

    let dragDepth = 0;
    window.addEventListener("dragenter", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      this.dropveil.hidden = false;
    }, { signal });
    window.addEventListener("dragover", (event) => {
      if (hasFiles(event)) event.preventDefault();
    }, { signal });
    window.addEventListener("dragleave", () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) this.dropveil.hidden = true;
    }, { signal });
    window.addEventListener("drop", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth = 0;
      this.dropveil.hidden = true;
      const files = [...(event.dataTransfer?.files ?? [])];
      const file = files[0];
      if (!file) return;
      if (files.length > 1) this.flash("一次只能開啟一個檔案，已使用第一個。");
      void this.loadFile(file);
    }, { signal });

    this.modalBack.addEventListener("click", (event) => {
      if (event.target === this.modalBack && !this.exporting) this.closeModal();
    }, { signal });
  }

  private buildToolbar(): void {
    const colorGroup = document.createElement("div");
    colorGroup.className = "group";
    for (const preset of [
      { color: "#000000", label: "黑色" },
      { color: "#ffffff", label: "白色" },
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "swatch";
      button.dataset.color = preset.color;
      button.style.background = preset.color;
      button.title = preset.label;
      button.setAttribute("aria-label", preset.label);
      button.addEventListener("click", () => this.applyColor(preset.color));
      colorGroup.append(button);
    }
    const custom = document.createElement("input");
    custom.type = "color";
    custom.className = "swatch custom";
    custom.value = "#c8c8c8";
    custom.title = "自訂顏色";
    custom.setAttribute("aria-label", "自訂顏色");
    custom.addEventListener("input", () => this.applyColor(custom.value));
    colorGroup.append(custom);

    const size = document.createElement("label");
    size.className = "size";
    const sizeHint = el("span", "hint", "粗細");
    this.sizeInput = document.createElement("input");
    this.sizeInput.type = "range";
    this.sizeInput.min = "4";
    this.sizeInput.max = "80";
    this.sizeInput.step = "1";
    this.sizeInput.value = String(this.brushPx);
    this.sizeInput.setAttribute("aria-label", "筆刷粗細");
    this.sizeReadout = el("span", "size-readout", String(this.brushPx));
    this.sizeInput.addEventListener("input", () => {
      this.brushPx = clamp(Number(this.sizeInput.value) || 18, 4, 80);
      this.sizeReadout.textContent = String(Math.round(this.brushPx));
    });
    size.append(sizeHint, this.sizeInput, this.sizeReadout);

    this.undoBtn = toolButton("undo", "復原");
    this.redoBtn = toolButton("redo", "重做");
    this.deleteBtn = toolButton("trash", "刪除");
    this.undoBtn.addEventListener("click", () => this.undoOnce());
    this.redoBtn.addEventListener("click", () => this.redoOnce());
    this.deleteBtn.addEventListener("click", () => this.deleteSelected());

    this.rectBtn = toolButton("rect", "矩形");
    this.brushBtn = toolButton("brush", "筆刷");
    this.eraserBtn = toolButton("eraser", "橡皮擦");
    this.panBtn = toolButton("pan", "平移");
    this.rectBtn.addEventListener("click", () => this.setTool("rect"));
    this.brushBtn.addEventListener("click", () => this.setTool("brush"));
    this.eraserBtn.addEventListener("click", () => this.setTool("eraser"));
    this.panBtn.addEventListener("click", () => this.setTool("pan"));
    const tidyBtn = toolButton("tidy", "整理");
    tidyBtn.addEventListener("click", () => this.toggleClean());

    const zoomOut = toolButton("minus", "縮小");
    const zoomIn = toolButton("plus", "放大");
    this.zoomLabel = document.createElement("button");
    this.zoomLabel.type = "button";
    this.zoomLabel.className = "btn ghost zoom-label";
    this.zoomLabel.title = "符合寬度";
    zoomOut.addEventListener("click", () => this.setZoom(this.zoom / 1.15, "manual"));
    zoomIn.addEventListener("click", () => this.setZoom(this.zoom * 1.15, "manual"));
    this.zoomLabel.addEventListener("click", () => {
      this.zoomMode = "fit-width";
      void this.renderMain();
    });
    const fit = toolButton("fit", "符合寬度");
    fit.addEventListener("click", () => {
      this.zoomMode = "fit-width";
      void this.renderMain();
    });

    this.prevBtn = toolButton("left", "上一頁");
    this.nextBtn = toolButton("right", "下一頁");
    this.prevBtn.addEventListener("click", () => this.goTo(this.pageIndex - 1));
    this.nextBtn.addEventListener("click", () => this.goTo(this.pageIndex + 1));
    const allLeft = toolButton("turnLeft", "全部左轉");
    const allRight = toolButton("turnRight", "全部右轉");
    allLeft.addEventListener("click", () => this.turnPages("all", -90));
    allRight.addEventListener("click", () => this.turnPages("all", 90));

    const tools = document.createElement("div");
    tools.className = "group";
    tools.append(this.rectBtn, this.brushBtn, this.eraserBtn, this.panBtn, tidyBtn);
    const history = document.createElement("div");
    history.className = "group";
    history.append(this.undoBtn, this.redoBtn, this.deleteBtn);
    const zoom = document.createElement("div");
    zoom.className = "group";
    zoom.append(zoomOut, this.zoomLabel, zoomIn, fit);
    const pages = document.createElement("div");
    pages.className = "group";
    pages.append(this.prevBtn, this.nextBtn, allLeft, allRight);

    this.toolbar.append(tools, sep(), size, sep(), colorGroup, sep(), history, sep(), zoom, sep(), pages);
    this.syncChrome();
  }

  private async loadFile(file: File): Promise<void> {
    if (this.busy) return;
    if (this.redactions.length) {
      const ok = await this.confirm("開啟新檔案會清掉目前的遮蓋。要繼續嗎？");
      if (!ok) return;
    }
    this.busy = true;
    this.syncChrome();
    this.hideAlert();
    this.setStatus("正在開啟檔案…");
    try {
      const next = await openFile(file, (ratio) => {
        this.setStatus(ratio == null ? "正在開啟檔案…" : `正在開啟檔案… ${Math.round(ratio * 100)}%`);
      });
      this.doc?.close();
      this.releaseAllRasters();
      this.doc = next;
      this.view = null;
      this.pageIndex = 0;
      this.zoomMode = "fit-width";
      this.redactions = [];
      this.rotations = Array.from({ length: next.pageCount }, () => 0);
      this.undo = [];
      this.redo = [];
      this.rasterUndo = [];
      this.rasterRedo = [];
      const handed = next.handoffBitmap();
      this.rasters = Array.from({ length: next.pageCount }, (_, index) => (index === 0 ? handed : null));
      this.scales = Array.from({ length: next.pageCount }, () => (next.kind === "image" ? 1 : 0));
      this.selectedId = null;
      this.shell.classList.remove("is-empty");
      this.empty.hidden = true;
      this.pageWrap.hidden = false;
      this.stickToTop = true;
      this.buildThumbs();
      await this.renderMain();
      this.stage.scrollTop = 0;
      this.stage.scrollLeft = 0;
      this.setStatus(this.statusLine());
    } catch (err) {
      this.showError(err instanceof Error ? err.message : "無法開啟檔案。");
    } finally {
      this.busy = false;
      this.syncChrome();
    }
  }

  private async pageView(index: number): Promise<PageView> {
    const doc = this.doc;
    if (!doc) throw new Error("尚未開啟檔案。");
    const view = await doc.getPage(index);
    view.setExtraRotation(normalizeRotation(this.rotations[index] ?? 0));
    return view;
  }

  private buildThumbs(): void {
    this.thumbObs?.disconnect();
    this.thumbs.replaceChildren();
    if (!this.doc) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = Number((entry.target as HTMLElement).dataset.page);
          void this.renderThumb(index);
        }
      },
      { root: this.thumbs, rootMargin: "240px" },
    );
    this.thumbObs = observer;
    for (let index = 0; index < this.doc.pageCount; index += 1) {
      const item = document.createElement("div");
      item.className = "thumb";
      item.dataset.page = String(index);
      const open = document.createElement("button");
      open.type = "button";
      open.className = "thumb-open";
      open.innerHTML = `<span class="thumb-frame"><span class="thumb-fit"><canvas></canvas><span class="marks"></span></span></span><span class="thumb-no"></span>`;
      const label = open.querySelector(".thumb-no");
      if (label) label.textContent = String(index + 1);
      open.setAttribute("aria-label", `第 ${index + 1} 頁`);
      open.addEventListener("click", () => this.goTo(index));
      const turns = document.createElement("div");
      turns.className = "thumb-turns";
      for (const delta of [-90, 90] as const) {
        const turn = document.createElement("button");
        turn.type = "button";
        turn.className = "thumb-turn";
        turn.dataset.turn = String(delta);
        turn.innerHTML = icon(delta < 0 ? "turnLeft" : "turnRight");
        turn.title = delta < 0 ? "左轉" : "右轉";
        turn.setAttribute("aria-label", delta < 0 ? "左轉" : "右轉");
        turn.addEventListener("click", (event) => {
          event.stopPropagation();
          this.turnPages(index, delta);
        });
        turns.append(turn);
      }
      item.append(open, turns);
      this.thumbs.append(item);
      observer.observe(item);
    }
    this.syncThumbActive();
  }

  private async renderMain(): Promise<void> {
    const doc = this.doc;
    if (!doc) return;
    const token = ++this.mainToken;
    const view = await this.pageView(this.pageIndex);
    if (token !== this.mainToken) return;
    this.view = view;
    const canvas = this.ensureCanvas();
    if (this.zoomMode === "fit-width") {
      if (this.stage.clientWidth < 40) {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      }
      const styles = getComputedStyle(this.stage);
      const padX = (Number.parseFloat(styles.paddingLeft) || 0) + (Number.parseFloat(styles.paddingRight) || 0);
      const avail = Math.max(160, this.stage.clientWidth - padX - 8);
      this.zoom = clamp(avail / view.metrics.width, 0.2, 4);
    }
    const cssW = view.metrics.width * this.zoom;
    const cssH = view.metrics.height * this.zoom;
    this.pageWrap.style.width = `${cssW}px`;
    this.pageWrap.style.height = `${cssH}px`;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    view.bump();
    let ok = false;
    try {
      ok = await view.render(canvas, this.zoom * dpr);
    } catch (err) {
      if (token === this.mainToken) this.showError(err instanceof Error ? err.message : "無法顯示這個頁面。");
      return;
    }
    if (!ok || token !== this.mainToken) return;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    this.syncMarks();
    this.syncChrome();
    this.copyThumbFromMain();
    if (this.stickToTop) {
      this.stickToTop = false;
      this.stage.scrollTop = 0;
      this.stage.scrollLeft = 0;
    }
    void this.syncThumbMarks();
  }

  private async renderThumb(index: number): Promise<void> {
    if (!this.doc || this.exporting || index === this.pageIndex) return;
    const button = this.thumbButton(index);
    if (!button || button.dataset.ready === "1" || button.dataset.ready === "pending") return;
    button.dataset.ready = "pending";
    try {
      const view = await this.pageView(index);
      if (this.exporting || !this.doc) {
        button.dataset.ready = "";
        return;
      }
      const canvas = button.querySelector("canvas");
      if (!(canvas instanceof HTMLCanvasElement)) return;
      const scale = Math.min(180 / view.metrics.width, 1.25);
      const ok = await view.render(canvas, scale);
      if (!ok) {
        button.dataset.ready = "";
        return;
      }
      placeThumbCanvas(canvas, view.metrics.width, view.metrics.height);
      button.dataset.ready = "1";
    } catch {
      button.dataset.ready = "";
    }
  }

  private copyThumbFromMain(): void {
    const button = this.thumbButton(this.pageIndex);
    const source = this.canvas;
    const thumb = button?.querySelector("canvas");
    if (!button || !source || source.width < 2 || !(thumb instanceof HTMLCanvasElement)) return;
    const scale = Math.min(180 / (this.view?.metrics.width ?? source.width), 1);
    const width = Math.max(1, Math.round((this.view?.metrics.width ?? 1) * scale));
    const height = Math.max(1, Math.round((this.view?.metrics.height ?? 1) * scale));
    thumb.width = width;
    thumb.height = height;
    thumb.getContext("2d")?.drawImage(source, 0, 0, width, height);
    placeThumbCanvas(thumb, this.view?.metrics.width ?? width, this.view?.metrics.height ?? height);
    button.dataset.ready = "1";
  }

  private async syncThumbMarks(): Promise<void> {
    const doc = this.doc;
    if (!doc) return;
    const token = ++this.markToken;
    for (let index = 0; index < doc.pageCount; index += 1) {
      const host = this.thumbButton(index)?.querySelector(".marks");
      if (!(host instanceof HTMLElement)) continue;
      const items = this.redactions.filter((item) => item.page === index);
      host.replaceChildren();
      if (!items.length) continue;
      const view = await this.pageView(index);
      if (token !== this.markToken) return;
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("viewBox", `0 0 ${view.metrics.width} ${view.metrics.height}`);
      svg.setAttribute("preserveAspectRatio", "none");
      for (const item of items) appendMark(svg, view, item, 1);
      host.append(svg);
    }
  }

  private syncMarks(): void {
    const view = this.view;
    for (const node of [...this.overlay.querySelectorAll(".box, .stroke")]) node.remove();
    if (!view) return;
    const pageWidth = view.metrics.width * this.zoom;
    const pageHeight = view.metrics.height * this.zoom;
    let depth = 1;
    for (const item of this.redactions) {
      if (item.page !== this.pageIndex) continue;
      if (item.kind === "rect") {
        const css = clampCss(view.userToCss(item.rect, this.zoom), pageWidth, pageHeight);
        const box = document.createElement("div");
        box.className = "box";
        box.dataset.redaction = item.id;
        box.style.zIndex = String(depth);
        if (item.id === this.selectedId) box.classList.add("is-selected");
        box.style.left = `${css.x}px`;
        box.style.top = `${css.y}px`;
        box.style.width = `${css.w}px`;
        box.style.height = `${css.h}px`;
        box.style.background = item.color;
        if (item.id === this.selectedId) {
          for (const handle of HANDLES) {
            const knob = document.createElement("span");
            knob.className = "handle";
            knob.dataset.handle = handle;
            box.append(knob);
          }
        }
        this.overlay.append(box);
      } else {
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("class", "stroke");
        svg.style.zIndex = String(depth);
        svg.setAttribute("viewBox", `0 0 ${pageWidth} ${pageHeight}`);
        appendMark(svg, view, item, this.zoom);
        this.overlay.append(svg);
      }
      depth += 1;
    }
    if (this.drag?.type === "brush" && this.drag.points.length) {
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("class", "stroke");
      svg.style.zIndex = "90";
      svg.setAttribute("viewBox", `0 0 ${pageWidth} ${pageHeight}`);
      appendStroke(svg, view, smoothPoints(this.drag.points), this.brushPx, this.color, this.zoom, true);
      this.overlay.append(svg);
    }
  }

  private onPointerDown(event: PointerEvent): void {
    if (!this.doc || !this.view || this.tool === "pan" || this.busy || event.button !== 0) return;
    event.preventDefault();
    const point = this.localPoint(event);
    this.placeCursor(point);
    const target = event.target instanceof Element ? event.target : null;
    try {
      this.overlay.setPointerCapture(event.pointerId);
    } catch {
      /* already released, or a synthetic event */
    }
    if (this.tool === "brush" || this.tool === "eraser") {
      this.selectedId = null;
      const samples = this.pointerSamples(event).map((sample) => this.view!.cssPointToUser(sample, this.zoom));
      if (this.tool === "brush") {
        this.drag = { type: "brush", points: samples, width: this.brushPx / this.zoom };
        this.syncMarks();
        return;
      }
      this.beginGesture();
      this.drag = { type: "erase", points: [] };
      this.appendUserSamples(this.drag.points, samples);
      this.replayErase();
      return;
    }
    const handle = target?.closest("[data-handle]");
    const box = target?.closest("[data-redaction]");
    if (handle instanceof HTMLElement && box instanceof HTMLElement) {
      const id = box.dataset.redaction ?? "";
      const item = this.redactions.find((entry) => entry.id === id && entry.kind === "rect");
      if (!item || item.kind !== "rect") return;
      this.selectedId = id;
      this.beginGesture();
      this.drag = {
        type: "resize",
        id,
        handle: handle.dataset.handle ?? "se",
        origin: this.view.userToCss(item.rect, this.zoom),
        x: point.x,
        y: point.y,
      };
      this.syncMarks();
      return;
    }
    if (box instanceof HTMLElement) {
      const id = box.dataset.redaction ?? "";
      const item = this.redactions.find((entry) => entry.id === id && entry.kind === "rect");
      if (!item || item.kind !== "rect") return;
      this.selectedId = id;
      this.beginGesture();
      this.drag = {
        type: "move",
        id,
        origin: this.view.userToCss(item.rect, this.zoom),
        x: point.x,
        y: point.y,
      };
      this.syncMarks();
      return;
    }
    this.selectedId = null;
    this.syncMarks();
    this.drag = { type: "draw", x0: point.x, y0: point.y };
    this.placeDraft(normalizeCss(point.x, point.y, point.x, point.y));
  }

  private onPointerMove(event: PointerEvent): void {
    const point = this.localPoint(event);
    if (this.tool === "brush" || this.tool === "eraser") this.placeCursor(point);
    const drag = this.drag;
    const view = this.view;
    if (!drag || !view) return;
    const pageW = view.metrics.width * this.zoom;
    const pageH = view.metrics.height * this.zoom;
    if (drag.type === "brush" || drag.type === "erase") {
      const samples = this.pointerSamples(event).map((sample) => view.cssPointToUser(sample, this.zoom));
      this.appendUserSamples(drag.points, samples);
      if (drag.type === "erase") this.replayErase();
      else this.syncMarks();
      return;
    }
    if (drag.type === "draw") {
      this.placeDraft(clampCss(normalizeCss(drag.x0, drag.y0, point.x, point.y), pageW, pageH));
      return;
    }
    const item = this.redactions.find((entry) => entry.id === drag.id && entry.kind === "rect");
    if (!item || item.kind !== "rect") return;
    const dx = point.x - drag.x;
    const dy = point.y - drag.y;
    const next =
      drag.type === "move"
        ? { ...drag.origin, x: drag.origin.x + dx, y: drag.origin.y + dy }
        : applyResize(drag.origin, drag.handle, dx, dy);
    item.rect = view.cssToUser(clampCss(next, pageW, pageH), this.zoom);
    this.syncMarks();
  }

  private onPointerUp(event: PointerEvent): void {
    if (!this.drag || !this.view) return;
    const drag = this.drag;
    this.drag = null;
    try {
      if (this.overlay.hasPointerCapture(event.pointerId)) this.overlay.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
    if (drag.type === "brush") {
      const points = smoothPoints(dedupePoints(drag.points, 0.15));
      if (points.length) {
        this.pushUndo();
        this.redactions = [
          ...this.redactions,
          {
            kind: "stroke",
            id: crypto.randomUUID(),
            page: this.pageIndex,
            color: this.color,
            width: drag.width,
            points,
          },
        ];
      }
      this.syncMarks();
      this.syncChrome();
      void this.syncThumbMarks();
      return;
    }
    if (drag.type === "erase") {
      this.endGesture();
      this.syncMarks();
      this.syncChrome();
      void this.syncThumbMarks();
      return;
    }
    if (drag.type === "draw") {
      this.draft.hidden = true;
      const point = this.localPoint(event);
      const pageW = this.view.metrics.width * this.zoom;
      const pageH = this.view.metrics.height * this.zoom;
      const css = clampCss(normalizeCss(drag.x0, drag.y0, point.x, point.y), pageW, pageH);
      if (css.w >= 4 && css.h >= 4) {
        this.pushUndo();
        const rect = this.view.cssToUser(css, this.zoom);
        const id = crypto.randomUUID();
        this.redactions = [...this.redactions, { kind: "rect", id, page: this.pageIndex, rect, color: this.color }];
        this.selectedId = id;
      }
      this.syncMarks();
      this.syncChrome();
      void this.syncThumbMarks();
      return;
    }
    this.endGesture();
    this.syncChrome();
    void this.syncThumbMarks();
  }

  private appendUserSamples(target: UserPoint[], samples: UserPoint[]): void {
    const gap = Math.max(this.brushPx / this.zoom, 0.8);
    for (const sample of samples) {
      const last = target[target.length - 1];
      if (!last) {
        target.push(sample);
        continue;
      }
      const distance = Math.hypot(sample.x - last.x, sample.y - last.y);
      if (distance < 0.08) continue;
      const steps = Math.ceil(distance / gap);
      if (steps <= 1) {
        target.push(sample);
        continue;
      }
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        target.push({
          x: last.x + (sample.x - last.x) * t,
          y: last.y + (sample.y - last.y) * t,
        });
      }
    }
  }

  private replayErase(): void {
    if (this.drag?.type !== "erase" || !this.gestureBefore) return;
    const base = JSON.parse(this.gestureBefore) as HistoryState;
    const eraser = this.drag.points;
    const next: Redaction[] = [];
    for (const item of base.redactions) {
      if (item.kind !== "stroke" || item.page !== this.pageIndex) {
        next.push(item);
        continue;
      }
      const radius = this.brushPx / this.zoom + item.width / 2;
      for (const points of eraseStroke(item.points, eraser, radius)) {
        next.push(points === item.points ? item : { ...item, id: crypto.randomUUID(), points });
      }
    }
    this.redactions = next;
    this.syncMarks();
  }

  private onKey(event: KeyboardEvent): void {
    const meta = event.ctrlKey || event.metaKey;
    if (meta && event.key.toLowerCase() === "p") {
      event.preventDefault();
      if (this.modalBack.hidden && this.doc && !this.busy) this.openOutput("print");
      return;
    }
    const target = event.target instanceof HTMLElement ? event.target : null;
    const field = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : null;
    if (field && field.type !== "range" && field.type !== "color") return;
    if (field?.type === "range" && event.key.startsWith("Arrow")) return;
    if (!this.modalBack.hidden) {
      if (event.key === "Escape" && !this.exporting) this.closeModal();
      if (event.key === "Escape" && this.exporting) this.exportAbort?.abort();
      return;
    }
    if (meta && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) this.redoOnce();
      else this.undoOnce();
      return;
    }
    if (meta && event.key.toLowerCase() === "y") {
      event.preventDefault();
      this.redoOnce();
      return;
    }
    if (!this.doc) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      this.deleteSelected();
      return;
    }
    if (event.key === "Escape") {
      this.selectedId = null;
      this.syncMarks();
      return;
    }
    if (event.key === "PageDown" || (event.key === "ArrowRight" && !this.selectedId)) {
      event.preventDefault();
      this.goTo(this.pageIndex + 1);
      return;
    }
    if (event.key === "PageUp" || (event.key === "ArrowLeft" && !this.selectedId)) {
      event.preventDefault();
      this.goTo(this.pageIndex - 1);
      return;
    }
    if (this.selectedId && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      this.nudge(event.key);
    }
  }

  private nudge(key: string): void {
    const view = this.view;
    const item = this.redactions.find((entry) => entry.id === this.selectedId && entry.kind === "rect");
    if (!view || !item || item.kind !== "rect") return;
    const css = view.userToCss(item.rect, this.zoom);
    const delta = eventStep(key);
    const pageW = view.metrics.width * this.zoom;
    const pageH = view.metrics.height * this.zoom;
    this.pushUndo();
    item.rect = view.cssToUser(
      clampCss({ ...css, x: css.x + delta.x, y: css.y + delta.y }, pageW, pageH),
      this.zoom,
    );
    this.syncMarks();
    void this.syncThumbMarks();
  }

  private goTo(index: number): void {
    if (!this.doc) return;
    const next = clamp(index, 0, this.doc.pageCount - 1);
    if (next === this.pageIndex) return;
    this.pageIndex = next;
    this.selectedId = null;
    this.stickToTop = true;
    this.syncThumbActive();
    void this.renderMain();
    this.scheduleClean();
  }

  private turnPages(target: number | "all", delta: number): void {
    if (!this.doc || this.busy) return;
    this.pushUndo();
    const indexes = target === "all" ? this.rotations.map((_, index) => index) : [target];
    for (const index of indexes) {
      this.rotations[index] = normalizeRotation((this.rotations[index] ?? 0) + delta);
      this.markThumbDirty(index);
    }
    this.stickToTop = true;
    void this.renderMain().then(() => {
      this.rerenderDirtyThumbs();
      this.scheduleClean();
    });
  }

  private markThumbDirty(index: number): void {
    const button = this.thumbButton(index);
    if (button) button.dataset.ready = "";
  }

  private rerenderDirtyThumbs(): void {
    const root = this.thumbs.getBoundingClientRect();
    for (const button of this.thumbs.querySelectorAll<HTMLElement>(".thumb")) {
      if (button.dataset.ready !== "") continue;
      const index = Number(button.dataset.page);
      if (index === this.pageIndex) continue;
      const box = button.getBoundingClientRect();
      const visible = box.bottom > root.top - 240 && box.top < root.bottom + 240;
      if (visible) void this.renderThumb(index);
    }
  }

  private setZoom(next: number, mode: "fit-width" | "manual"): void {
    if (!this.doc) return;
    this.zoomMode = mode;
    this.zoom = clamp(next, 0.2, 4);
    void this.renderMain();
  }

  private setTool(tool: Tool): void {
    this.tool = tool;
    this.shell.dataset.tool = tool;
    this.shell.classList.toggle("is-pan", tool === "pan");
    this.stage.classList.toggle("is-pan", tool === "pan");
    this.placeCursor(null);
    this.syncChrome();
  }

  private applyColor(value: string): void {
    const next = normalizeHex(value);
    this.color = next;
    const item = this.redactions.find((entry) => entry.id === this.selectedId);
    if (item && item.kind === "rect" && item.color !== next) {
      this.pushUndo();
      item.color = next;
      this.syncMarks();
      void this.syncThumbMarks();
    }
    this.syncChrome();
  }

  private deleteSelected(): void {
    if (!this.selectedId) return;
    this.pushUndo();
    this.redactions = this.redactions.filter((item) => item.id !== this.selectedId);
    this.selectedId = null;
    this.syncMarks();
    this.syncChrome();
    void this.syncThumbMarks();
  }

  private snapshot(): string {
    const state: HistoryState = { redactions: this.redactions, rotations: this.rotations, scales: this.scales };
    return JSON.stringify(state);
  }

  private pushUndo(): void {
    this.undo.push(this.snapshot());
    this.rasterUndo.push(this.rasters.slice());
    this.trimHistory();
    this.clearRedo();
  }

  private beginGesture(): void {
    this.gestureBefore = this.snapshot();
    this.gestureRasters = this.rasters.slice();
  }

  private endGesture(): void {
    if (this.gestureBefore == null) return;
    const now = this.snapshot();
    if (now !== this.gestureBefore) {
      this.undo.push(this.gestureBefore);
      this.rasterUndo.push(this.gestureRasters ?? this.rasters.slice());
      this.trimHistory();
      this.clearRedo();
    }
    this.gestureBefore = null;
    this.gestureRasters = null;
  }

  private trimHistory(): void {
    while (this.undo.length > 80) {
      this.undo.shift();
      this.releaseList(this.rasterUndo.shift() ?? []);
    }
  }

  private clearRedo(): void {
    const dropped = this.rasterRedo.flat();
    this.redo = [];
    this.rasterRedo = [];
    this.releaseList(dropped);
  }

  private releaseList(list: Array<ImageBitmap | null>): void {
    for (const bitmap of list) {
      if (bitmap && !this.rasterReferenced(bitmap)) bitmap.close();
    }
  }

  private rasterReferenced(bitmap: ImageBitmap): boolean {
    if (this.rasters.includes(bitmap)) return true;
    if (this.cleanSource === bitmap || this.cleanResult === bitmap) return true;
    for (const row of this.rasterUndo) if (row.includes(bitmap)) return true;
    for (const row of this.rasterRedo) if (row.includes(bitmap)) return true;
    return false;
  }

  private releaseAllRasters(): void {
    const seen = new Set<ImageBitmap>();
    const lists = [this.rasters, ...this.rasterUndo, ...this.rasterRedo];
    for (const list of lists) {
      for (const bitmap of list) {
        if (bitmap && !seen.has(bitmap)) {
          seen.add(bitmap);
          bitmap.close();
        }
      }
    }
    this.rasters = [];
    this.rasterUndo = [];
    this.rasterRedo = [];
    this.closeCleanBitmaps();
  }

  private restore(raw: string, rasters: Array<ImageBitmap | null>): void {
    const state = JSON.parse(raw) as HistoryState;
    this.redactions = state.redactions;
    this.rotations = state.rotations ?? this.rotations;
    this.scales = state.scales ?? this.scales;
    this.rasters = rasters.slice();
    const doc = this.doc;
    if (doc) {
      for (let index = 0; index < doc.pageCount; index += 1) {
        doc.setRaster(index, this.rasters[index] ?? null, this.scales[index] || 1);
      }
    }
    this.selectedId = null;
    for (let index = 0; index < this.rotations.length; index += 1) this.markThumbDirty(index);
    this.stickToTop = true;
    void this.renderMain().then(() => {
      this.rerenderDirtyThumbs();
      this.syncChrome();
      this.scheduleClean();
    });
  }

  private undoOnce(): void {
    const previous = this.undo.pop();
    const previousRasters = this.rasterUndo.pop();
    if (!previous || !previousRasters) return;
    this.redo.push(this.snapshot());
    this.rasterRedo.push(this.rasters.slice());
    this.restore(previous, previousRasters);
  }

  private redoOnce(): void {
    const next = this.redo.pop();
    const nextRasters = this.rasterRedo.pop();
    if (!next || !nextRasters) return;
    this.undo.push(this.snapshot());
    this.rasterUndo.push(this.rasters.slice());
    this.restore(next, nextRasters);
  }

  private syncChrome(): void {
    const hasDoc = Boolean(this.doc);
    this.exportBtn.disabled = !hasDoc || this.busy;
    this.printBtn.disabled = !hasDoc || this.busy;
    this.undoBtn.disabled = this.undo.length === 0 || this.busy;
    this.redoBtn.disabled = this.redo.length === 0 || this.busy;
    this.deleteBtn.disabled = !this.selectedId || this.busy;
    this.prevBtn.disabled = !hasDoc || this.pageIndex <= 0 || this.busy;
    this.nextBtn.disabled = !hasDoc || !this.doc || this.pageIndex >= this.doc.pageCount - 1 || this.busy;
    this.rectBtn.classList.toggle("is-on", this.tool === "rect");
    this.brushBtn.classList.toggle("is-on", this.tool === "brush");
    this.eraserBtn.classList.toggle("is-on", this.tool === "eraser");
    this.panBtn.classList.toggle("is-on", this.tool === "pan");
    this.rectBtn.setAttribute("aria-pressed", String(this.tool === "rect"));
    this.brushBtn.setAttribute("aria-pressed", String(this.tool === "brush"));
    this.eraserBtn.setAttribute("aria-pressed", String(this.tool === "eraser"));
    this.panBtn.setAttribute("aria-pressed", String(this.tool === "pan"));
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    for (const swatch of this.toolbar.querySelectorAll<HTMLElement>("[data-color]")) {
      swatch.classList.toggle("is-on", normalizeHex(swatch.dataset.color ?? "") === this.color);
    }
    if (hasDoc) this.setStatus(this.statusLine());
    this.syncThumbActive();
  }

  private syncThumbActive(): void {
    for (const button of this.thumbs.querySelectorAll<HTMLElement>(".thumb")) {
      const active = Number(button.dataset.page) === this.pageIndex;
      button.classList.toggle("is-active", active);
      const open = button.querySelector(".thumb-open");
      if (active) open?.setAttribute("aria-current", "page");
      else open?.removeAttribute("aria-current");
    }
  }

  private statusLine(): string {
    if (!this.doc) return "尚未開啟檔案 · 不會上傳";
    const turned = normalizeRotation(this.rotations[this.pageIndex] ?? 0);
    const angle = turned ? ` · 已轉 ${turned}°` : "";
    return `第 ${this.pageIndex + 1} / ${this.doc.pageCount} 頁${angle}`;
  }

  private setStatus(text: string): void {
    this.status.textContent = text;
  }

  private showError(text: string): void {
    this.alert.hidden = false;
    this.alert.textContent = text;
    this.setStatus(text);
  }

  private hideAlert(): void {
    this.alert.hidden = true;
    this.alert.textContent = "";
  }

  private flash(text: string): void {
    this.setStatus(text);
  }

  private localPoint(event: PointerEvent): { x: number; y: number } {
    const rect = this.overlay.getBoundingClientRect();
    return {
      x: clamp(event.clientX - rect.left, 0, rect.width),
      y: clamp(event.clientY - rect.top, 0, rect.height),
    };
  }

  private pointerSamples(event: PointerEvent): Array<{ x: number; y: number }> {
    const list = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    const events = list.length ? list : [event];
    return events.map((sample) => this.localPoint(sample));
  }

  private placeCursor(point: { x: number; y: number } | null): void {
    const show = Boolean(point) && (this.tool === "brush" || this.tool === "eraser");
    this.cursor.hidden = !show;
    if (!point || !show) return;
    this.cursor.style.width = `${this.brushPx}px`;
    this.cursor.style.height = `${this.brushPx}px`;
    this.cursor.style.left = `${point.x}px`;
    this.cursor.style.top = `${point.y}px`;
  }

  private placeDraft(rect: CssRect): void {
    this.draft.hidden = false;
    this.draft.style.left = `${rect.x}px`;
    this.draft.style.top = `${rect.y}px`;
    this.draft.style.width = `${rect.w}px`;
    this.draft.style.height = `${rect.h}px`;
    this.draft.style.background = this.color;
  }

  private ensureCanvas(): HTMLCanvasElement {
    if (this.canvas) return this.canvas;
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-label", "文件頁面");
    this.pageWrap.prepend(canvas);
    this.canvas = canvas;
    return canvas;
  }

  private thumbButton(index: number): HTMLElement | null {
    return this.thumbs.querySelector(`[data-page="${index}"]`);
  }

  private openOutput(target: "download" | "print"): void {
    const doc = this.doc;
    if (!doc || this.busy) return;
    const printing = target === "print";
    this.showModal((body) => {
      body.innerHTML = "";
      const title = el("h2", "", printing ? "列印" : "匯出");
      title.id = "modal-title";
      const lead = el(
        "p",
        "lead",
        printing
          ? "預設安全列印，被遮內容無法還原。"
          : this.redactions.length
            ? `將下載 ${redactedFilename(doc.filename, "pdf")}`
            : "尚未畫遮蓋，仍可匯出副本。",
      );
      const choices = document.createElement("div");
      choices.className = "choices";

      const secure = document.createElement("section");
      secure.className = "choice";
      const secureTitle = el("h3", "", printing ? "安全列印" : "安全匯出");
      const secureCopy = el("p", "", "每一頁會變成圖片，被遮內容無法還原。");
      const dpiRow = document.createElement("div");
      dpiRow.className = "dpi";
      dpiRow.setAttribute("role", "group");
      dpiRow.setAttribute("aria-label", "解析度");
      for (const value of DPI_CHOICES) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn";
        button.textContent = `${value} DPI`;
        button.classList.toggle("is-on", value === this.dpi);
        button.addEventListener("click", () => {
          this.dpi = value;
          for (const peer of dpiRow.querySelectorAll("button")) peer.classList.toggle("is-on", peer === button);
        });
        dpiRow.append(button);
      }
      const secureBtn = document.createElement("button");
      secureBtn.type = "button";
      secureBtn.className = "btn primary";
      secureBtn.textContent = printing ? "安全列印" : "安全匯出";
      secureBtn.addEventListener("click", () => this.startOutput("secure", target));
      secure.append(secureTitle, secureCopy, dpiRow, secureBtn);

      const visual = document.createElement("section");
      visual.className = "choice is-warn";
      const visualTitle = el("h3", "", printing ? "一般列印" : "一般匯出");
      const visualCopy = document.createElement("p");
      visualCopy.innerHTML =
        "<strong>警告：</strong>只是蓋上色塊或線條，底下的文字仍可複製或還原，不適合隱藏機密。";
      const visualBtn = document.createElement("button");
      visualBtn.type = "button";
      visualBtn.className = "btn";
      visualBtn.textContent = printing ? "一般列印" : "一般匯出";
      visualBtn.addEventListener("click", () => this.startOutput("visual", target));
      visual.append(visualTitle, visualCopy, visualBtn);

      choices.append(secure, visual);

      if (!printing && doc.kind === "image") {
        const png = document.createElement("section");
        png.className = "choice";
        const pngTitle = el("h3", "", "匯出 PNG");
        const pngCopy = el("p", "", "輸出成圖片，遮蓋無法還原。");
        const pngBtn = document.createElement("button");
        pngBtn.type = "button";
        pngBtn.className = "btn";
        pngBtn.textContent = "匯出 PNG";
        pngBtn.addEventListener("click", () => this.startOutput("png", "download"));
        png.append(pngTitle, pngCopy, pngBtn);
        choices.append(png);
      }

      const progress = document.createElement("div");
      progress.className = "progress";
      progress.hidden = true;
      progress.dataset.progress = "1";
      const bar = document.createElement("span");
      progress.append(bar);
      const progressLabel = el("p", "lead", "");
      progressLabel.dataset.progressLabel = "1";
      progressLabel.hidden = true;

      const actions = document.createElement("div");
      actions.className = "modal-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn ghost";
      cancel.textContent = "關閉";
      cancel.dataset.cancel = "1";
      cancel.addEventListener("click", () => {
        if (this.exporting) this.exportAbort?.abort();
        else this.closeModal();
      });
      actions.append(cancel);

      body.append(title, lead, choices, progress, progressLabel, actions);
      secureBtn.focus();
    });
  }

  private startOutput(kind: "secure" | "visual" | "png", target: "download" | "print"): void {
    let printWindow: Window | null = null;
    if (target === "print" && wantsPrintTab()) {
      printWindow = window.open("about:blank", "_blank");
      if (!printWindow) {
        this.flash("瀏覽器擋下了新分頁。請允許彈出視窗後再列印。");
        return;
      }
      try {
        printWindow.document.title = "準備列印";
        printWindow.document.body.textContent = "正在準備列印檔…";
      } catch {
        /* about:blank 偶爾不能寫入，仍可稍後改網址 */
      }
    }
    void this.runExport(kind, target, printWindow);
  }

  private async runExport(
    kind: "secure" | "visual" | "png",
    target: "download" | "print" = "download",
    printWindow: Window | null = null,
  ): Promise<void> {
    const doc = this.doc;
    if (!doc || this.exporting) return;
    this.exporting = true;
    this.busy = true;
    this.exportAbort = new AbortController();
    const signal = this.exportAbort.signal;
    this.setExportUi(true, { page: 0, total: doc.pageCount, label: target === "print" ? "準備列印…" : "準備匯出…" });
    let statusAfter = "";
    let printed = false;
    try {
      const onProgress = (progress: ExportProgress) => this.setExportUi(true, progress);
      const rotations = this.rotations;
      const result =
        kind === "secure"
          ? await exportSecure({
              doc,
              redactions: this.redactions,
              rotations,
              dpi: this.dpi,
              jpegCleaned: this.jpegCleaned,
              signal,
              onProgress,
            })
          : kind === "visual"
            ? await exportVisual({
                doc,
                redactions: this.redactions,
                rotations,
                jpegCleaned: this.jpegCleaned,
                signal,
                onProgress,
              })
            : await exportPng({ doc, redactions: this.redactions, rotations, signal, onProgress });
      const note = result.capped ? "有頁面超過瀏覽器畫布上限，已自動降低解析度。" : "";
      if (target === "print") {
        const how = await printPdf(result.bytes, (frame) => {
          this.printFrame?.remove();
          this.printFrame = frame;
        }, printWindow);
        printed = true;
        this.showPrintReady(how, note);
        statusAfter = how === "tab" ? `已在新分頁開啟 PDF，請在那一頁列印。${note}` : `已送出列印。${note}`;
      } else {
        const ext = kind === "png" ? "png" : "pdf";
        const filename = redactedFilename(doc.filename, ext);
        download(result.bytes, filename, result.mime);
        this.showDownloadReady(result.bytes, filename, result.mime, note);
        statusAfter = `已下載 ${filename}。${note}`;
      }
    } catch (err) {
      if (!printed && printWindow && !printWindow.closed) printWindow.close();
      if (err instanceof DOMException && err.name === "AbortError" && signal.aborted) {
        this.setExportUi(false, null);
        statusAfter = target === "print" ? "已取消列印。" : "已取消匯出。";
      } else {
        const message = err instanceof Error ? err.message : target === "print" ? "列印失敗。" : "匯出失敗。";
        this.setExportUi(false, null);
        const label = this.modal.querySelector<HTMLElement>("[data-progress-label]");
        if (label) {
          label.hidden = false;
          label.textContent = message;
        }
        statusAfter = message;
      }
    } finally {
      this.exporting = false;
      this.busy = false;
      this.exportAbort = null;
      this.syncChrome();
      if (statusAfter) this.setStatus(statusAfter);
      if (this.doc) void this.renderMain();
    }
  }

  private showDownloadReady(bytes: Uint8Array, filename: string, mime: string, note: string): void {
    this.modal.replaceChildren();
    const title = el("h2", "", "匯出完成");
    title.id = "modal-title";
    const copy = el(
      "p",
      "lead",
      note ? `已準備 ${filename}。${note}可再按一次下載。` : `已準備 ${filename}，可再按一次下載。`,
    );
    const again = document.createElement("button");
    again.type = "button";
    again.className = "btn primary";
    again.textContent = "下載檔案";
    again.addEventListener("click", () => download(bytes, filename, mime));
    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn";
    close.textContent = "關閉";
    close.addEventListener("click", () => this.closeModal());
    const actions = document.createElement("div");
    actions.className = "modal-actions";
    actions.append(close, again);
    this.modal.append(title, copy, actions);
    again.focus();
  }

  private showPrintReady(how: "iframe" | "tab", note: string): void {
    this.modal.replaceChildren();
    const title = el("h2", "", how === "tab" ? "已開啟 PDF" : "已送出列印");
    title.id = "modal-title";
    const copy = el(
      "p",
      "lead",
      how === "tab"
        ? `這個瀏覽器不能在畫面裡直接列印，已改在新分頁開啟 PDF。請用那一頁的列印功能。${note}`
        : `列印對話框應已出現。頁面尺寸和方向沿用塗改後的 PDF，不會多出這層網頁的邊框。${note}`,
    );
    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn primary";
    close.textContent = "關閉";
    close.addEventListener("click", () => this.closeModal());
    const actions = document.createElement("div");
    actions.className = "modal-actions";
    actions.append(close);
    this.modal.append(title, copy, actions);
    close.focus();
  }

  private setExportUi(running: boolean, progress: ExportProgress | null): void {
    const box = this.modal.querySelector<HTMLElement>("[data-progress]");
    const label = this.modal.querySelector<HTMLElement>("[data-progress-label]");
    const bar = box?.querySelector("span");
    if (box) box.hidden = !running;
    if (label) {
      label.hidden = !running;
      label.textContent = progress?.label ?? "";
    }
    if (bar && progress && progress.total > 0) {
      const ratio = Math.max(0, Math.min(1, (progress.page - (running ? 0.15 : 0)) / progress.total));
      bar.style.width = `${Math.round(ratio * 100)}%`;
    }
    for (const button of this.modal.querySelectorAll("button")) {
      if (button.dataset.cancel === "1") {
        button.textContent = running ? "取消" : "關閉";
        button.disabled = false;
      } else button.disabled = running;
    }
  }

  private confirm(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolve(value);
        this.closeModal();
      };
      this.showModal((body) => {
        const title = el("h2", "", "開啟新檔案");
        title.id = "modal-title";
        const copy = el("p", "lead", message);
        const actions = document.createElement("div");
        actions.className = "modal-actions";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "btn";
        cancel.textContent = "取消";
        cancel.addEventListener("click", () => finish(false));
        const ok = document.createElement("button");
        ok.type = "button";
        ok.className = "btn primary";
        ok.textContent = "繼續";
        ok.addEventListener("click", () => finish(true));
        actions.append(cancel, ok);
        body.append(title, copy, actions);
        ok.focus();
      }, () => finish(false));
    });
  }

  private showModal(build: (body: HTMLElement) => void, onDismiss?: () => void): void {
    this.modal.replaceChildren();
    build(this.modal);
    this.modalBack.hidden = false;
    this.modalResolver = onDismiss ?? null;
  }

  private closeModal(): void {
    if (this.exporting) return;
    this.modalBack.hidden = true;
    this.modal.replaceChildren();
    const resolve = this.modalResolver;
    this.modalResolver = null;
    resolve?.();
  }

  private buildCleanPanel(): void {
    const panel = this.shell.querySelector(".clean-panel") as HTMLElement;
    const controls = document.createElement("div");
    controls.className = "clean-controls";
    const toggles: Array<[keyof CleanOptions, string]> = [
      ["whiten", "底色變白"],
      ["deskew", "自動轉正"],
      ["perspective", "找四角拉平"],
      ["binary", "黑白高對比"],
    ];
    for (const [key, label] of toggles) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn clean-toggle";
      button.dataset.clean = key;
      button.textContent = label;
      button.addEventListener("click", () => {
        if (key === "whiten" || key === "deskew" || key === "perspective" || key === "binary") {
          this.cleanOpts = { ...this.cleanOpts, [key]: !this.cleanOpts[key] };
          if (key === "perspective") this.cleanMoved = false;
          this.syncCleanControls();
          this.scheduleClean();
        }
      });
      controls.append(button);
    }
    const strength = document.createElement("div");
    strength.className = "clean-strength";
    strength.dataset.cleanStrength = "1";
    for (const [id, label] of [
      ["light", "輕"],
      ["medium", "中"],
      ["strong", "強"],
    ] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn";
      button.dataset.strength = id;
      button.textContent = label;
      button.addEventListener("click", () => {
        this.cleanOpts = { ...this.cleanOpts, strength: id };
        this.syncCleanControls();
        this.scheduleClean();
      });
      strength.append(button);
    }
    const threshold = document.createElement("label");
    threshold.className = "clean-threshold";
    threshold.dataset.cleanThreshold = "1";
    threshold.textContent = "門檻";
    const range = document.createElement("input");
    range.type = "range";
    range.min = "2";
    range.max = "21";
    range.value = "8";
    range.addEventListener("input", () => {
      this.cleanOpts = { ...this.cleanOpts, threshold: Number(range.value) || 8 };
      this.scheduleClean();
    });
    threshold.append(range);
    const jpeg = document.createElement("label");
    jpeg.className = "clean-jpeg";
    const jpegInput = document.createElement("input");
    jpegInput.type = "checkbox";
    jpegInput.checked = true;
    jpegInput.addEventListener("change", () => {
      this.jpegCleaned = jpegInput.checked;
    });
    jpeg.append(jpegInput, document.createTextNode("整理後的頁面用 JPEG 壓縮"));
    const hold = document.createElement("button");
    hold.type = "button";
    hold.className = "btn";
    hold.textContent = "按住看原圖";
    hold.addEventListener("pointerdown", () => {
      this.cleanHolding = true;
      this.paintCleanPreview();
    });
    const release = () => {
      this.cleanHolding = false;
      this.paintCleanPreview();
    };
    hold.addEventListener("pointerup", release);
    hold.addEventListener("pointerleave", release);
    const actions = document.createElement("div");
    actions.className = "clean-actions";
    const one = document.createElement("button");
    one.type = "button";
    one.className = "btn primary";
    one.textContent = "套用到本頁";
    one.addEventListener("click", () => void this.applyClean("page"));
    const all = document.createElement("button");
    all.type = "button";
    all.className = "btn";
    all.textContent = "套用到全部頁面";
    all.addEventListener("click", () => void this.applyClean("all"));
    actions.append(one, all);
    const view = panel.querySelector(".clean-view") as HTMLElement;
    view.insertAdjacentElement("afterend", controls);
    controls.after(strength, threshold, jpeg, hold, actions);
    panel.querySelector("[data-clean-close]")?.addEventListener("click", () => this.toggleClean(false));
    this.syncCleanControls();
  }

  private toggleClean(force?: boolean): void {
    if (!this.doc) return;
    const panel = this.shell.querySelector(".clean-panel") as HTMLElement;
    this.cleanOpen = force ?? !this.cleanOpen;
    panel.hidden = !this.cleanOpen;
    if (!this.cleanOpen) return;
    this.cleanMoved = false;
    this.setStatus("正在載入整理工具…");
    void loadCleaner()
      .then(() => {
        this.setStatus(this.statusLine());
        this.scheduleClean();
      })
      .catch((err: unknown) => {
        this.showError(err instanceof Error ? err.message : "無法載入整理工具。");
      });
  }

  private syncCleanControls(): void {
    const panel = this.shell.querySelector(".clean-panel");
    if (!panel) return;
    for (const button of panel.querySelectorAll<HTMLButtonElement>("[data-clean]")) {
      const key = button.dataset.clean as keyof CleanOptions;
      const on = Boolean(this.cleanOpts[key]);
      button.classList.toggle("is-on", on);
      button.setAttribute("aria-pressed", String(on));
    }
    const strength = panel.querySelector<HTMLElement>("[data-clean-strength]");
    if (strength) strength.hidden = !this.cleanOpts.whiten;
    for (const button of panel.querySelectorAll<HTMLButtonElement>("[data-strength]")) {
      button.classList.toggle("is-on", button.dataset.strength === this.cleanOpts.strength);
    }
    const threshold = panel.querySelector<HTMLElement>("[data-clean-threshold]");
    if (threshold) threshold.hidden = !this.cleanOpts.binary;
  }

  private scheduleClean(): void {
    if (!this.cleanOpen || !this.doc) return;
    window.clearTimeout(this.cleanTimer);
    this.cleanTimer = window.setTimeout(() => void this.runCleanPreview(), 180);
  }

  private async runCleanPreview(): Promise<void> {
    const doc = this.doc;
    if (!doc || !this.cleanOpen) return;
    const token = ++this.cleanToken;
    const status = this.shell.querySelector(".clean-status");
    if (status) status.textContent = "正在預覽…";
    try {
      await loadCleaner();
      const view = await this.pageView(this.pageIndex);
      const full = cleanupScale(view, doc.kind === "pdf" && !doc.isRaster(this.pageIndex));
      const edge = Math.max(view.metrics.width, view.metrics.height) * full;
      const previewScale = edge > 900 ? full * (900 / edge) : full;
      const rendered = await pageBitmap(view, previewScale);
      if (token !== this.cleanToken) return;
      const source = await createImageBitmap(rendered.canvas);
      rendered.canvas.width = 1;
      rendered.canvas.height = 1;
      const corners =
        this.cleanOpts.perspective && this.cleanMoved && this.cleanCorners
          ? this.cleanCorners.map((point) => ({ ...point }))
          : null;
      const result = await cleanBitmap(source, { ...this.cleanOpts, corners });
      if (token !== this.cleanToken) {
        source.close();
        result.bitmap.close();
        return;
      }
      this.cleanSource?.close();
      this.cleanResult?.close();
      this.cleanSource = source;
      this.cleanResult = result.bitmap;
      if (!this.cleanMoved) this.cleanCorners = result.corners;
      if (status) {
        const bits = [
          this.cleanOpts.perspective ? (result.foundQuad ? "已找到紙張四角" : "沒找到紙張，可自行拖角") : "",
          this.cleanOpts.deskew ? `轉正 ${result.angle.toFixed(1)}°` : "",
        ].filter(Boolean);
        status.textContent = bits.join(" · ") || "預覽已更新";
      }
      this.paintCleanPreview();
    } catch (err) {
      if (token !== this.cleanToken) return;
      if (status) status.textContent = err instanceof Error ? err.message : "預覽失敗。";
    }
  }

  private paintCleanPreview(): void {
    const panel = this.shell.querySelector(".clean-panel");
    if (!panel) return;
    const sourceCanvas = panel.querySelector("canvas.clean-source") as HTMLCanvasElement;
    const resultCanvas = panel.querySelector("canvas.clean-result") as HTMLCanvasElement;
    const result = this.cleanHolding ? this.cleanSource : this.cleanResult ?? this.cleanSource;
    if (result) drawBitmap(resultCanvas, result);
    const showCorners = Boolean(this.cleanOpts.perspective && !this.cleanHolding && this.cleanSource && this.cleanCorners);
    const wrap = panel.querySelector(".clean-source-wrap") as HTMLElement;
    wrap.hidden = !showCorners;
    sourceCanvas.hidden = !showCorners;
    if (showCorners && this.cleanSource) drawBitmap(sourceCanvas, this.cleanSource);
    const layer = panel.querySelector(".clean-corners") as HTMLElement;
    layer.hidden = !showCorners;
    layer.replaceChildren();
    if (!showCorners || !this.cleanCorners || !this.cleanSource) return;
    const width = this.cleanSource.width;
    const height = this.cleanSource.height;
    this.cleanCorners.forEach((point, index) => {
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "clean-handle";
      handle.style.left = `${(point.x / width) * 100}%`;
      handle.style.top = `${(point.y / height) * 100}%`;
      handle.title = "拖曳角點";
      handle.setAttribute("aria-label", `角點 ${index + 1}`);
      handle.addEventListener("pointerdown", (event) => this.dragCorner(event, index));
      layer.append(handle);
    });
  }

  private dragCorner(event: PointerEvent, index: number): void {
    const layer = this.shell.querySelector(".clean-corners") as HTMLElement;
    const source = this.cleanSource;
    const corners = this.cleanCorners;
    if (!source || !corners) return;
    event.preventDefault();
    event.stopPropagation();
    const move = (next: PointerEvent) => {
      const rect = layer.getBoundingClientRect();
      const x = clamp(((next.clientX - rect.left) / Math.max(rect.width, 1)) * source.width, 0, source.width - 1);
      const y = clamp(((next.clientY - rect.top) / Math.max(rect.height, 1)) * source.height, 0, source.height - 1);
      corners[index] = { x, y };
      this.cleanCorners = corners;
      this.cleanMoved = true;
      const handle = layer.children[index] as HTMLElement | undefined;
      if (handle) {
        handle.style.left = `${(x / source.width) * 100}%`;
        handle.style.top = `${(y / source.height) * 100}%`;
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this.scheduleClean();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private async applyClean(scope: "page" | "all"): Promise<void> {
    const doc = this.doc;
    if (!doc || this.busy) {
      this.setStatus(this.busy ? "還在處理上一項工作。" : "尚未開啟檔案。");
      return;
    }
    this.setStatus("開始整理…");
    const indexes = scope === "all" ? Array.from({ length: doc.pageCount }, (_, index) => index) : [this.pageIndex];
    const geometry = this.cleanOpts.perspective || this.cleanOpts.deskew;
    const marked = indexes.some((index) => this.redactions.some((item) => item.page === index));
    if (geometry && marked) {
      const ok = await this.confirm("裁切或轉正會改變頁面形狀，這些頁面上的遮蓋會被清掉。建議先整理，再塗改。要繼續嗎？");
      if (!ok) return;
    }
    this.busy = true;
    this.syncChrome();
    const bar = this.shell.querySelector(".clean-progress") as HTMLElement;
    const fill = bar.querySelector("span") as HTMLElement;
    bar.hidden = false;
    try {
      await loadCleaner();
      this.pushUndo();
      for (let step = 0; step < indexes.length; step += 1) {
        const index = indexes[step];
        fill.style.width = `${Math.round((step / indexes.length) * 100)}%`;
        this.setStatus(`正在整理第 ${index + 1} / ${doc.pageCount} 頁`);
        const view = await this.pageView(index);
        const fromPdf = doc.kind === "pdf" && !doc.isRaster(index);
        const scale = cleanupScale(view, fromPdf);
        const rendered = await pageBitmap(view, scale);
        const source = await createImageBitmap(rendered.canvas);
        const canvasH = rendered.canvas.height;
        rendered.canvas.width = 1;
        rendered.canvas.height = 1;
        let corners: CleanPoint[] | null = null;
        if (this.cleanOpts.perspective && index === this.pageIndex && this.cleanCorners && this.cleanSource) {
          const sx = source.width / this.cleanSource.width;
          const sy = source.height / this.cleanSource.height;
          corners = this.cleanCorners.map((point) => ({ x: point.x * sx, y: point.y * sy }));
        }
        const result = await cleanBitmap(source, { ...this.cleanOpts, corners });
        const sourceW = source.width;
        const sourceH = source.height;
        source.close();
        const quad = corners ?? result.corners;
        const changed =
          (this.cleanOpts.perspective && !cornersNearEdge(quad, sourceW, sourceH)) ||
          (this.cleanOpts.deskew && Math.abs(result.angle) > 0.3);
        if (changed) this.redactions = this.redactions.filter((item) => item.page !== index);
        else this.redactions = remapMarks(view, rendered.scale, canvasH, index, this.redactions);
        const px = fromPdf ? scale : this.scales[index] || 1;
        this.rasters[index] = result.bitmap;
        this.scales[index] = px;
        this.rotations[index] = 0;
        doc.setRaster(index, result.bitmap, px);
        this.markThumbDirty(index);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      fill.style.width = "100%";
      this.cleanMoved = false;
      this.stickToTop = true;
      await this.renderMain();
      this.rerenderDirtyThumbs();
      this.setStatus(`已整理 ${indexes.length} 頁。`);
      this.scheduleClean();
    } catch (err) {
      this.showError(err instanceof Error ? err.message : "整理失敗。");
    } finally {
      bar.hidden = true;
      this.busy = false;
      this.syncChrome();
    }
  }

  private closeCleanBitmaps(): void {
    this.cleanSource?.close();
    this.cleanResult?.close();
    this.cleanSource = null;
    this.cleanResult = null;
  }
}

function cleanupScale(view: PageView, fromPdf: boolean): number {
  const edge = Math.max(view.metrics.width, view.metrics.height, 1);
  if (!fromPdf) return Math.min(1, 2200 / edge);
  return Math.min(170 / 72, 2200 / Math.max(view.metrics.width, 1));
}

function cornersNearEdge(corners: CleanPoint[], width: number, height: number): boolean {
  if (corners.length !== 4) return false;
  const edges = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 },
    { x: 0, y: height - 1 },
  ];
  const slack = Math.max(width, height) * 0.04;
  return corners.every((point, index) => Math.hypot(point.x - edges[index].x, point.y - edges[index].y) <= slack);
}

function drawBitmap(canvas: HTMLCanvasElement, bitmap: ImageBitmap): void {
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
}

function remapMarks(
  view: PageView,
  scale: number,
  canvasHeight: number,
  page: number,
  marks: Redaction[],
): Redaction[] {
  const toNew = (point: UserPoint): UserPoint => {
    const css = view.userPointToCss(point, scale);
    return { x: css.x, y: canvasHeight - css.y };
  };
  return marks.map((item) => {
    if (item.page !== page) return item;
    if (item.kind === "stroke") {
      return { ...item, width: item.width * scale, points: item.points.map(toNew) };
    }
    const a = toNew({ x: item.rect.x, y: item.rect.y });
    const b = toNew({ x: item.rect.x + item.rect.w, y: item.rect.y + item.rect.h });
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { ...item, rect: { x, y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) } };
  });
}

function appendMark(svg: SVGSVGElement, view: PageView, item: Redaction, scale: number): void {
  if (item.kind === "rect") {
    const css = view.userToCss(item.rect, scale);
    const node = document.createElementNS(SVG_NS, "rect");
    node.setAttribute("x", String(css.x));
    node.setAttribute("y", String(css.y));
    node.setAttribute("width", String(css.w));
    node.setAttribute("height", String(css.h));
    node.setAttribute("fill", item.color);
    svg.append(node);
    return;
  }
  appendStroke(svg, view, item.points, item.width * scale, item.color, scale, false);
}

function appendStroke(
  svg: SVGSVGElement,
  view: PageView,
  points: UserPoint[],
  widthPx: number,
  color: string,
  scale: number,
  widthIsPx: boolean,
): void {
  if (!points.length) return;
  const width = widthIsPx ? widthPx : widthPx;
  if (points.length === 1) {
    const point = view.userPointToCss(points[0], scale);
    const node = document.createElementNS(SVG_NS, "circle");
    node.setAttribute("cx", String(point.x));
    node.setAttribute("cy", String(point.y));
    node.setAttribute("r", String(Math.max(width / 2, 0.4)));
    node.setAttribute("fill", color);
    svg.append(node);
    return;
  }
  const node = document.createElementNS(SVG_NS, "polyline");
  node.setAttribute(
    "points",
    points
      .map((point) => {
        const css = view.userPointToCss(point, scale);
        return `${css.x},${css.y}`;
      })
      .join(" "),
  );
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", color);
  node.setAttribute("stroke-width", String(Math.max(width, 0.4)));
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  svg.append(node);
}

function placeThumbCanvas(canvas: HTMLCanvasElement, pageW: number, pageH: number): void {
  const frame = canvas.closest(".thumb-frame");
  const box = frame instanceof HTMLElement && frame.clientWidth > 0 ? frame.clientWidth : 120;
  const scale = Math.min(box / Math.max(pageW, 1), box / Math.max(pageH, 1));
  canvas.style.width = `${pageW * scale}px`;
  canvas.style.height = `${pageH * scale}px`;
}

function toolButton(name: IconName, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn icon";
  button.innerHTML = icon(name);
  button.title = label;
  button.setAttribute("aria-label", label);
  return button;
}

function sep(): HTMLElement {
  const node = document.createElement("span");
  node.className = "sep";
  return node;
}

function el(tag: string, className: string, text: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

function applyResize(origin: CssRect, handle: string, dx: number, dy: number): CssRect {
  let left = origin.x;
  let top = origin.y;
  let right = origin.x + origin.w;
  let bottom = origin.y + origin.h;
  if (handle.includes("w")) left += dx;
  if (handle.includes("e")) right += dx;
  if (handle.includes("n")) top += dy;
  if (handle.includes("s")) bottom += dy;
  if (right - left < 8) {
    if (handle.includes("w")) left = right - 8;
    else right = left + 8;
  }
  if (bottom - top < 8) {
    if (handle.includes("n")) top = bottom - 8;
    else bottom = top + 8;
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function eventStep(key: string): { x: number; y: number } {
  if (key === "ArrowLeft") return { x: -2, y: 0 };
  if (key === "ArrowRight") return { x: 2, y: 0 };
  if (key === "ArrowUp") return { x: 0, y: -2 };
  if (key === "ArrowDown") return { x: 0, y: 2 };
  return { x: 0, y: 0 };
}

function hasFiles(event: DragEvent): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes("Files");
}

function download(bytes: Uint8Array, filename: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([toArrayBuffer(bytes)], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function wantsPrintTab(): boolean {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

async function printPdf(
  bytes: Uint8Array,
  keep: (frame: HTMLIFrameElement | null) => void,
  preset: Window | null,
): Promise<"iframe" | "tab"> {
  const url = URL.createObjectURL(new Blob([toArrayBuffer(bytes)], { type: "application/pdf" }));
  const releaseLater = () => {
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  };
  const showIn = (popup: Window): "tab" => {
    if (popup.closed) {
      URL.revokeObjectURL(url);
      throw new Error("列印分頁已關閉。");
    }
    try {
      popup.location.replace(url);
    } catch {
      popup.close();
      URL.revokeObjectURL(url);
      throw new Error("無法開啟列印分頁。");
    }
    keep(null);
    releaseLater();
    return "tab";
  };
  if (preset) return showIn(preset);
  if (wantsPrintTab()) {
    const opened = window.open("about:blank", "_blank");
    if (!opened) {
      URL.revokeObjectURL(url);
      throw new Error("瀏覽器擋下了新分頁。請允許彈出視窗後再列印。");
    }
    return showIn(opened);
  }

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.title = "列印";
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;pointer-events:none";
  document.body.append(iframe);
  keep(iframe);
  let timer = 0;
  let rejectLoad: ((err: Error) => void) | null = null;
  const onViolation = (event: SecurityPolicyViolationEvent) => {
    if (event.effectiveDirective === "frame-src" || event.effectiveDirective === "child-src") {
      window.clearTimeout(timer);
      rejectLoad?.(new Error("CSP"));
    }
  };
  document.addEventListener("securitypolicyviolation", onViolation);
  try {
    await new Promise<void>((resolve, reject) => {
      rejectLoad = reject;
      timer = window.setTimeout(() => resolve(), 2500);
      iframe.onload = () => {
        window.clearTimeout(timer);
        resolve();
      };
      iframe.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error("無法載入列印檔"));
      };
      iframe.src = url;
    });
    await new Promise((resolve) => window.setTimeout(resolve, 200));
    const win = iframe.contentWindow;
    if (!win) throw new Error("無法載入列印檔");
    win.focus();
    win.print();
    setTimeout(() => {
      iframe.remove();
      URL.revokeObjectURL(url);
    }, 60_000);
    return "iframe";
  } catch (err) {
    iframe.remove();
    const opened = window.open("about:blank", "_blank");
    if (!opened) {
      URL.revokeObjectURL(url);
      if (err instanceof Error && err.message.includes("彈出視窗")) throw err;
      throw new Error("瀏覽器擋下了新分頁。請允許彈出視窗後再列印。");
    }
    return showIn(opened);
  } finally {
    document.removeEventListener("securitypolicyviolation", onViolation);
  }
}
