export type CleanStrength = "light" | "medium" | "strong";

export type CleanPoint = { x: number; y: number };

export type CleanOptions = {
  whiten: boolean;
  strength: CleanStrength;
  deskew: boolean;
  perspective: boolean;
  binary: boolean;
  threshold: number;
  /** Corners in the same pixel space as the bitmap. Null asks the worker to detect them. */
  corners: CleanPoint[] | null;
};

export type CleanResult = {
  bitmap: ImageBitmap;
  corners: CleanPoint[];
  foundQuad: boolean;
  angle: number;
};

type WorkerResult = {
  type: "result";
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  corners: CleanPoint[];
  foundQuad: boolean;
  angle: number;
};

let workerPromise: Promise<Worker> | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (value: WorkerResult) => void; reject: (err: Error) => void }>();
let chain: Promise<unknown> = Promise.resolve();

function workerUrl(): string {
  return new URL("/cleanup-worker.js", window.location.href).toString();
}

export function loadCleaner(): Promise<void> {
  return ensureWorker().then(() => undefined);
}

function ensureWorker(): Promise<Worker> {
  if (workerPromise) return workerPromise;
  workerPromise = new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl());
    const timer = window.setTimeout(() => {
      reject(new Error("整理工具載入逾時。"));
    }, 30000);
    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; id?: number; message?: string };
      if (data.type === "ready") {
        window.clearTimeout(timer);
        resolve(worker);
        return;
      }
      if (data.type === "fatal") {
        window.clearTimeout(timer);
        reject(new Error(data.message || "無法載入 OpenCV。"));
        return;
      }
      if (typeof data.id !== "number") return;
      const job = pending.get(data.id);
      if (!job) return;
      pending.delete(data.id);
      if (data.type === "error") job.reject(new Error(data.message || "整理失敗。"));
      else job.resolve(event.data as WorkerResult);
    };
    worker.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error("整理工具無法啟動。"));
    };
  });
  workerPromise.catch(() => {
    workerPromise = null;
  });
  return workerPromise;
}

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(job, job);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function cleanBitmap(source: ImageBitmap, options: CleanOptions): Promise<CleanResult> {
  return enqueue(() => cleanNow(source, options));
}

async function cleanNow(source: ImageBitmap, options: CleanOptions): Promise<CleanResult> {
  const worker = await ensureWorker();
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("瀏覽器無法建立畫布。");
  ctx.drawImage(source, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const id = nextId;
  nextId += 1;
  const result = await new Promise<WorkerResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage(
      {
        type: "process",
        id,
        width: canvas.width,
        height: canvas.height,
        buffer: pixels.data.buffer,
        options,
      },
      [pixels.data.buffer],
    );
  });
  const out = document.createElement("canvas");
  out.width = result.width;
  out.height = result.height;
  const outCtx = out.getContext("2d");
  if (!outCtx) throw new Error("瀏覽器無法建立畫布。");
  outCtx.putImageData(new ImageData(new Uint8ClampedArray(result.buffer), result.width, result.height), 0, 0);
  const bitmap = await createImageBitmap(out);
  return { bitmap, corners: result.corners, foundQuad: result.foundQuad, angle: result.angle };
}
