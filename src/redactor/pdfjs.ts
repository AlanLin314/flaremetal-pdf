import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask } from "pdfjs-dist";

let workerReady = false;

export function ensurePdfWorker(): void {
  if (workerReady) return;
  GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();
  workerReady = true;
}

export function pdfAssetUrls(): {
  cMapUrl: string;
  standardFontDataUrl: string;
  wasmUrl: string;
} {
  const base = import.meta.env.BASE_URL || "/";
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return {
    cMapUrl: `${prefix}pdfjs/cmaps/`,
    standardFontDataUrl: `${prefix}pdfjs/standard_fonts/`,
    wasmUrl: `${prefix}pdfjs/wasm/`,
  };
}

export function loadPdfDocument(
  data: Uint8Array,
  onProgress?: (ratio: number | null) => void,
): PDFDocumentLoadingTask {
  ensurePdfWorker();
  const urls = pdfAssetUrls();
  const task = getDocument({
    data,
    cMapUrl: urls.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: urls.standardFontDataUrl,
    wasmUrl: urls.wasmUrl,
    useSystemFonts: true,
    enableXfa: false,
  });
  if (onProgress) {
    task.onProgress = (progress: { loaded: number; total: number }) => {
      onProgress(progress.total > 0 ? progress.loaded / progress.total : null);
    };
  }
  return task;
}

export function errorName(err: unknown): string {
  if (err && typeof err === "object" && "name" in err) return String((err as { name: string }).name);
  return "";
}
