import type { Page } from "./order";

/** Size every output page shares, in PDF points. */
export type Frame = { w: number; h: number };

/** Where a page image sits inside the frame, in points from the top left. */
export type Placement = { x: number; y: number; w: number; h: number };

/**
 * One page size for the whole document, so a short last page keeps the
 * blank space below its text instead of becoming a stubby page. The size
 * comes from the cropped pages; a few outliers above the 90th percentile
 * are shrunk to fit rather than adding margins to every other page.
 */
export function pageFrame(pages: Page[]): Frame {
  const sized = pages.some((p) => p.cropped) ? pages.filter((p) => p.cropped) : pages;
  if (!sized.length) return { w: 420, h: 595 };
  return { w: upper(sized.map((p) => p.widthPt)), h: upper(sized.map((p) => p.heightPt)) };
}

function upper(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)];
}

/**
 * Cropped pages keep their real size, centered across and aligned to the
 * top, so text lines up from page to page. Uncropped pages (blank pages,
 * crop turned off) and outliers are scaled to fit and centered.
 */
export function placePage(p: Page, frame: Frame): Placement {
  const fits = p.widthPt <= frame.w + 0.5 && p.heightPt <= frame.h + 0.5;
  if (p.cropped && fits) {
    return { x: (frame.w - p.widthPt) / 2, y: 0, w: p.widthPt, h: p.heightPt };
  }
  const s = Math.min(frame.w / p.widthPt, frame.h / p.heightPt, 1);
  const w = p.widthPt * s;
  const h = p.heightPt * s;
  return { x: (frame.w - w) / 2, y: p.cropped ? 0 : (frame.h - h) / 2, w, h };
}
