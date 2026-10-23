/// <reference lib="webworker" />
// Turns one rendered PDF page into finished output pages: analyzes a small
// copy, then rotates, deskews, crops and enhances the full-size one.
import { enhance, type Mode } from "./lib/enhance";
import { analyzePage, rgbaToGray, type Half, type Hint } from "./lib/scan";

export type JobOptions = { mode: Mode; crop: boolean };

export type JobRequest = {
  id: number;
  bitmap: ImageBitmap;
  /** PDF points per rendered pixel, to keep the real page size. */
  ptPerPx: number;
  opts: JobOptions;
  hint?: Hint;
  /** Process even when unsure and without a hint. */
  force?: boolean;
};

export type OutPage = {
  image: Blob;
  thumb: Blob;
  widthPt: number;
  heightPt: number;
  blank: boolean;
};

export type JobResult =
  | {
      id: number;
      k: number;
      kConf: number;
      split: number | null;
      splitConf: number;
      /** True when the page needs a hint from the rest of the document. */
      deferred: boolean;
      pages: OutPage[];
    }
  | { id: number; error: string };

const ANALYSIS_SIZE = 1800;
const THUMB_WIDTH = 240;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (e: MessageEvent<JobRequest>) => {
  const req = e.data;
  const { bitmap } = req;
  try {
    const s = Math.min(1, ANALYSIS_SIZE / Math.max(bitmap.width, bitmap.height));
    const aw = Math.round(bitmap.width * s);
    const ah = Math.round(bitmap.height * s);
    const small = new OffscreenCanvas(aw, ah);
    const sctx = small.getContext("2d")!;
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(bitmap, 0, 0, aw, ah);
    const plan = analyzePage(rgbaToGray(sctx.getImageData(0, 0, aw, ah).data, aw, ah), req.hint);

    const summary = { id: req.id, k: plan.k, kConf: plan.kConf, split: plan.split, splitConf: plan.splitConf };
    const unsure = plan.kConf < 0.5 || plan.splitConf < 0.5;
    if (unsure && !req.hint && !req.force) {
      ctx.postMessage({ ...summary, deferred: true, pages: [] } satisfies JobResult);
      return;
    }

    const f = bitmap.width / aw;
    const pages: OutPage[] = [];
    for (const half of plan.halves) {
      pages.push(await renderHalf(bitmap, plan.k, half, aw, ah, f, req.ptPerPx, req.opts));
    }
    ctx.postMessage({ ...summary, deferred: false, pages } satisfies JobResult);
  } catch (err) {
    ctx.postMessage({ id: req.id, error: String(err) } satisfies JobResult);
  } finally {
    bitmap.close();
  }
};

async function renderHalf(
  bitmap: ImageBitmap,
  k: number,
  half: Half,
  aw: number,
  ah: number,
  f: number,
  ptPerPx: number,
  opts: JobOptions,
): Promise<OutPage> {
  const { rect, theta, content } = half;
  const box = opts.crop ? half.box : { x: 0, y: 0, w: rect.w, h: rect.h };
  const ow = Math.max(1, Math.round(box.w * f));
  const oh = Math.max(1, Math.round(box.h * f));
  const canvas = new OffscreenCanvas(ow, oh);
  const c = canvas.getContext("2d")!;
  c.fillStyle = "#fff";
  c.fillRect(0, 0, ow, oh);
  c.imageSmoothingQuality = "high";

  // Same mapping the analysis used, written as canvas transforms in
  // analysis pixels and scaled up by f.
  c.scale(f, f);
  c.translate(-box.x, -box.y);
  if (opts.crop) {
    // Margins outside the text block are blanked: shadows, page edges, specks.
    const m = Math.min(rect.w, rect.h) * 0.012;
    c.beginPath();
    c.rect(content.x - m, content.y - m, content.w + 2 * m, content.h + 2 * m);
    c.clip();
  }
  c.translate(rect.w / 2, rect.h / 2);
  c.rotate(-theta);
  c.translate(-(rect.x + rect.w / 2), -(rect.y + rect.h / 2));
  c.beginPath();
  c.rect(rect.x, rect.y, rect.w, rect.h);
  c.clip();
  orient(c, k, aw, ah);
  c.drawImage(bitmap, 0, 0, aw, ah);
  c.setTransform(1, 0, 0, 1, 0, 0);

  if (opts.mode !== "original") {
    const img = c.getImageData(0, 0, ow, oh);
    const g = enhance(rgbaToGray(img.data, ow, oh), opts.mode);
    const d = img.data;
    for (let i = 0, j = 0; i < g.data.length; i++, j += 4) {
      d[j] = d[j + 1] = d[j + 2] = g.data[i];
      d[j + 3] = 255;
    }
    c.putImageData(img, 0, 0);
  }

  const image = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  const tw = Math.min(THUMB_WIDTH, ow);
  const th = Math.max(1, Math.round((oh * tw) / ow));
  const thumbCanvas = new OffscreenCanvas(tw, th);
  const tc = thumbCanvas.getContext("2d")!;
  tc.imageSmoothingQuality = "high";
  tc.drawImage(canvas, 0, 0, tw, th);
  const thumb = await thumbCanvas.convertToBlob({ type: "image/jpeg", quality: 0.75 });

  return { image, thumb, widthPt: ow * ptPerPx, heightPt: oh * ptPerPx, blank: half.ink < 0.015 };
}

/** Canvas transform that turns the source k quarter turns clockwise. */
function orient(c: OffscreenCanvasRenderingContext2D, k: number, w: number, h: number) {
  if (k === 1) {
    c.translate(h, 0);
    c.rotate(Math.PI / 2);
  } else if (k === 2) {
    c.translate(w, h);
    c.rotate(Math.PI);
  } else if (k === 3) {
    c.translate(0, w);
    c.rotate(-Math.PI / 2);
  }
}
