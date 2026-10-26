/// <reference lib="webworker" />
// Turns one rendered PDF page into finished output pages: analyzes a small
// copy, then rotates, deskews, crops and enhances the full-size one.
import { reflowColumns } from "./lib/columns";
import { enhance, type Mode } from "./lib/enhance";
import { analyzePage, inkMask, normalizeBackground, rgbaToGray, type Half, type Hint } from "./lib/scan";

export type JobOptions = { mode: Mode; crop: boolean; columns: boolean };

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
  /** Trimmed to the text block, as opposed to the whole page area. */
  cropped: boolean;
  /** Which page of a spread it comes from, 0 for the left. */
  half: number;
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
    for (const [i, half] of plan.halves.entries()) {
      const canvas = renderHalf(bitmap, plan.k, half, aw, ah, f, req.opts);
      const narrow = req.opts.columns ? reflow(canvas) : null;
      if (narrow) {
        for (const part of narrow) pages.push(await encode(part(), req.ptPerPx, { blank: false, cropped: true, half: i }));
      } else {
        const { rect, box } = half;
        const cropped = req.opts.crop && (box.w < rect.w || box.h < rect.h);
        pages.push(await encode(canvas, req.ptPerPx, { blank: half.ink < 0.015, cropped, half: i }));
      }
    }
    ctx.postMessage({ ...summary, deferred: false, pages } satisfies JobResult);
  } catch (err) {
    ctx.postMessage({ id: req.id, error: String(err) } satisfies JobResult);
  } finally {
    bitmap.close();
  }
};

function renderHalf(
  bitmap: ImageBitmap,
  k: number,
  half: Half,
  aw: number,
  ah: number,
  f: number,
  opts: JobOptions,
): OffscreenCanvas {
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
  return canvas;
}

/**
 * For a page printed in columns, one function per narrow output page that
 * draws it; null for a single column. Drawn one at a time to save memory.
 */
function reflow(canvas: OffscreenCanvas): (() => OffscreenCanvas)[] | null {
  const s = Math.min(1, ANALYSIS_SIZE / Math.max(canvas.width, canvas.height));
  const aw = Math.round(canvas.width * s);
  const ah = Math.round(canvas.height * s);
  const small = new OffscreenCanvas(aw, ah);
  const sctx = small.getContext("2d")!;
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(canvas, 0, 0, aw, ah);
  const gray = rgbaToGray(sctx.getImageData(0, 0, aw, ah).data, aw, ah);
  const plan = reflowColumns(inkMask(normalizeBackground(gray, Math.max(8, Math.round(Math.max(aw, ah) / 40)))), aw, ah);
  if (!plan) return null;
  const f = canvas.width / aw;
  return plan.map((p) => () => {
    const out = new OffscreenCanvas(Math.round(p.w * f), Math.round(p.h * f));
    const c = out.getContext("2d")!;
    c.fillStyle = "#fff";
    c.fillRect(0, 0, out.width, out.height);
    c.imageSmoothingQuality = "high";
    for (const d of p.draws) {
      c.drawImage(canvas, d.sx * f, d.sy * f, d.sw * f, d.sh * f, d.dx * f, d.dy * f, d.dw * f, d.dh * f);
    }
    return out;
  });
}

async function encode(
  canvas: OffscreenCanvas,
  ptPerPx: number,
  meta: Pick<OutPage, "blank" | "cropped" | "half">,
): Promise<OutPage> {
  const ow = canvas.width;
  const oh = canvas.height;
  const image = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  const tw = Math.min(THUMB_WIDTH, ow);
  const th = Math.max(1, Math.round((oh * tw) / ow));
  const thumbCanvas = new OffscreenCanvas(tw, th);
  const tc = thumbCanvas.getContext("2d")!;
  tc.imageSmoothingQuality = "high";
  tc.drawImage(canvas, 0, 0, tw, th);
  const thumb = await thumbCanvas.convertToBlob({ type: "image/jpeg", quality: 0.75 });

  return { image, thumb, widthPt: ow * ptPerPx, heightPt: oh * ptPerPx, ...meta };
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
