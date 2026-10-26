// Main-thread side: renders PDF pages with pdf.js, hands them to the worker,
// orders the results and writes the final PDF with pdf-lib.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { PDFDocument } from "pdf-lib";
import type { Hint } from "./scan";
import type { JobOptions, JobRequest, JobResult } from "../worker";
import { pageFrame, placePage } from "./frame";
import type { Page, Sheet } from "./order";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export type Quality = "normal" | "high";

export type Progress = { done: number; total: number };

const SHORT_SIDE: Record<Quality, number> = { normal: 1800, high: 2600 };
// A column ends up as wide as the phone screen, so it needs more pixels.
const COLUMNS_SCALE = 1.5;
// iOS Safari refuses canvases above ~16.7M pixels.
const MAX_PIXELS = 15_000_000;

export async function processPdf(
  file: File,
  opts: JobOptions & { quality: Quality },
  onProgress: (p: Progress) => void,
  signal: AbortSignal,
): Promise<Sheet[]> {
  const base = import.meta.env.BASE_URL;
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    wasmUrl: `${base}pdfjs/wasm/`,
    standardFontDataUrl: `${base}pdfjs/standard_fonts/`,
  });
  const pdf = await task.promise;
  const worker = new Worker(new URL("../worker.ts", import.meta.url), { type: "module" });
  const total = pdf.numPages;
  const sheets: Sheet[] = [];
  const deferred: number[] = [];
  const confident: { k: number; split: number | null }[] = [];
  let nextId = 0;

  const run = (req: Omit<JobRequest, "id">) =>
    new Promise<JobResult>((resolve) => {
      const id = nextId++;
      const onMessage = (e: MessageEvent<JobResult>) => {
        if (e.data.id !== id) return;
        worker.removeEventListener("message", onMessage);
        resolve(e.data);
      };
      worker.addEventListener("message", onMessage);
      worker.postMessage({ ...req, id }, [req.bitmap]);
    });

  const processPage = async (index: number, hint: Hint | undefined, force: boolean) => {
    const { bitmap, ptPerPx } = await renderPage(pdf, index + 1, SHORT_SIDE[opts.quality] * (opts.columns ? COLUMNS_SCALE : 1));
    const res = await run({ bitmap, ptPerPx, opts, hint, force });
    if ("error" in res) throw new Error(res.error);
    if (res.deferred) return false;
    if (res.kConf >= 0.5 && res.splitConf >= 0.5) confident.push({ k: res.k, split: res.split });
    sheets.push({
      index,
      pages: res.pages.map((p, side) => ({
        ...p,
        id: `${index}-${side}`,
        thumbUrl: URL.createObjectURL(p.thumb),
        sheet: index,
        side,
      })),
    });
    return true;
  };

  try {
    let done = 0;
    for (let i = 0; i < total; i++) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const ok = await processPage(i, documentHint(confident), false);
      if (ok) onProgress({ done: ++done, total });
      else deferred.push(i);
    }
    // Pages that could not decide alone (covers, blank pages) follow the rest.
    for (const i of deferred) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      await processPage(i, documentHint(confident), true);
      onProgress({ done: ++done, total });
    }
  } finally {
    worker.terminate();
    await task.destroy();
  }
  return sheets.sort((a, b) => a.index - b.index);
}

async function renderPage(pdf: pdfjs.PDFDocumentProxy, n: number, shortSide: number) {
  const page = await pdf.getPage(n);
  const vp1 = page.getViewport({ scale: 1 });
  let scale = shortSide / Math.min(vp1.width, vp1.height);
  const pixels = vp1.width * vp1.height * scale * scale;
  if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
  const bitmap = await createImageBitmap(canvas);
  canvas.width = canvas.height = 0;
  page.cleanup();
  return { bitmap, ptPerPx: 1 / scale };
}

/** Most common orientation and median split among the pages we trust. */
function documentHint(confident: { k: number; split: number | null }[]): Hint | undefined {
  if (!confident.length) return undefined;
  const counts = [0, 0, 0, 0];
  for (const c of confident) counts[c.k]++;
  const k = counts.indexOf(Math.max(...counts));
  const splits = confident.map((c) => c.split).filter((s): s is number => s !== null);
  if (splits.length * 2 < confident.length) return { k, split: null };
  splits.sort((a, b) => a - b);
  return { k, split: splits[Math.floor(splits.length / 2)] };
}

export async function buildPdf(pages: Page[]): Promise<Blob> {
  const doc = await PDFDocument.create();
  const frame = pageFrame(pages);
  for (const p of pages) {
    const img = await doc.embedJpg(await p.image.arrayBuffer());
    const page = doc.addPage([frame.w, frame.h]);
    const at = placePage(p, frame);
    // PDF coordinates start at the bottom left.
    page.drawImage(img, { x: at.x, y: frame.h - at.y - at.h, width: at.w, height: at.h });
  }
  const bytes = await doc.save();
  return new Blob([bytes as BlobPart], { type: "application/pdf" });
}
