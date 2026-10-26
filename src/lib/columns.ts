// Reflow for pages printed in two or more columns (journal articles,
// magazines). The page is cut into blocks in reading order, then the blocks
// are restacked one column wide, so each output page is as narrow as a
// column and the text fills a phone screen. Pure, like scan.ts: it only
// plans where each piece goes; the worker draws them.
import { dropLongRuns, dropSpecks, type Rect } from "./scan";

/** One piece of the source copied onto an output page, in analysis pixels. */
export type Draw = { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number };
export type Reflowed = { w: number; h: number; draws: Draw[] };

/** A leaf of the cut and the column it sits in, which sets its scale. */
type Block = Rect & { col: Rect; foot?: boolean };

/** Output page height over width: a phone screen minus the reader's toolbars. */
const RATIO = 1.6;

/**
 * Plans the output pages for one page's ink mask, or returns null when the
 * page is a single column and reads fine as it is.
 */
export function reflowColumns(mask: Uint8Array, w: number, h: number): Reflowed[] | null {
  let m = dropLongRuns(mask, w, h, Math.round(w * 0.03), Math.round(h * 0.04));
  m = dropSpecks(m, w, h, Math.max(4, Math.round((w * h) / 80000)));
  const { line, gap } = lineMetrics(m, w, h);
  const root = trim(m, w, { x: 0, y: 0, w, h });
  if (!root) return null;

  const blocks: Block[] = [];
  xyCut(m, w, root, root, blocks, {
    // Wider than the space between lines, so baselines lined up across
    // columns never read as a break between rows of the page.
    minH: Math.max(4, Math.round(Math.max(gap * 2.2, line * 0.6))),
    minV: Math.max(4, Math.round(Math.max(line * 0.5, w * 0.008))),
    minSide: root.w * 0.18,
    minTall: (line + gap) * 2.5,
  });
  // Page numbers and running feet sit under one column and would land in
  // the middle of a sentence; they go last instead, if there is room.
  const body: Block[] = [];
  const feet: Block[] = [];
  for (const b of blocks) {
    if (b.y + b.h < root.y + root.h - line) {
      body.push(b);
    } else if (b.h <= line * 1.6 && b.w < b.col.w * 0.6) {
      feet.push({ ...b, foot: true });
    } else {
      const parts = splitFoot(m, w, b);
      if (parts) {
        body.push(parts[0]);
        feet.push({ ...parts[1], foot: true });
      } else {
        body.push(b);
      }
    }
  }
  blocks.splice(0, blocks.length, ...body, ...feet);

  const narrow = blocks.filter((b) => b.col.w < root.w * 0.7);
  const area = (list: Block[]) => list.reduce((s, b) => s + b.w * b.h, 0);
  if (!narrow.length || area(narrow) < area(blocks) * 0.3) return null;
  const width = weightedMedian(narrow.map((b) => ({ v: b.col.w, weight: b.h })));
  return paginate(m, w, blocks, width, line + gap);
}

type CutOpts = { minH: number; minV: number; minSide: number; minTall: number };

/**
 * Recursive XY-cut. Rows of the page come first: a wide gap across every
 * column ends one story or band before the next starts. Only then are
 * columns split apart, read left to right.
 */
function xyCut(m: Uint8Array, w: number, r: Rect, col: Rect, out: Block[], o: CutOpts) {
  const t = trim(m, w, r);
  if (!t) return;
  const rows = profile(m, w, t, "rows");
  const hcuts = gaps(rows, o.minH, Math.floor(t.w * 0.002)).map((g) => t.y + g);
  if (hcuts.length) {
    for (const [a, b] of spans(t.y, t.y + t.h, hcuts)) xyCut(m, w, { x: t.x, y: a, w: t.w, h: b - a }, col, out, o);
    return;
  }
  if (t.h >= o.minTall && t.w >= o.minSide * 2) {
    const cols = profile(m, w, t, "cols");
    const vcuts: number[] = [];
    let left = t.x;
    for (const g of gaps(cols, o.minV, Math.floor(t.h * 0.002))) {
      const x = t.x + g;
      // Both sides must be as wide as a column; narrower gaps are table
      // cells or a figure beside its caption.
      if (x - left >= o.minSide && t.x + t.w - x >= o.minSide) {
        vcuts.push(x);
        left = x;
      }
    }
    if (vcuts.length) {
      for (const [a, b] of spans(t.x, t.x + t.w, vcuts)) {
        const piece = trim(m, w, { x: a, y: t.y, w: b - a, h: t.h });
        if (piece) xyCut(m, w, piece, piece, out, o);
      }
      return;
    }
  }
  out.push({ ...t, col });
}

function spans(start: number, end: number, cuts: number[]): [number, number][] {
  const edges = [start, ...cuts, end];
  return edges.slice(1).map((b, i) => [edges[i], b]);
}

/** Ink count per row (or per column) inside r. */
function profile(m: Uint8Array, w: number, r: Rect, dir: "rows" | "cols"): Int32Array {
  const p = new Int32Array(dir === "rows" ? r.h : r.w);
  for (let y = 0; y < r.h; y++) {
    for (let x = 0, i = (r.y + y) * w + r.x; x < r.w; x++, i++) {
      if (m[i]) p[dir === "rows" ? y : x]++;
    }
  }
  return p;
}

/** Centers of the runs of at most tol ink that are at least min long. */
function gaps(p: Int32Array, min: number, tol: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < p.length; ) {
    if (p[i] > tol) {
      i++;
      continue;
    }
    const a = i;
    while (i < p.length && p[i] <= tol) i++;
    if (a > 0 && i < p.length && i - a >= min) out.push(Math.round((a + i) / 2));
  }
  return out;
}

/** Shrinks r to the ink inside it, or null when there is none. */
function trim(m: Uint8Array, w: number, r: Rect): Rect | null {
  const rows = profile(m, w, r, "rows");
  const cols = profile(m, w, r, "cols");
  let y0 = 0;
  let y1 = rows.length - 1;
  let x0 = 0;
  let x1 = cols.length - 1;
  while (y0 <= y1 && !rows[y0]) y0++;
  while (y1 >= y0 && !rows[y1]) y1--;
  while (x0 <= x1 && !cols[x0]) x0++;
  while (x1 >= x0 && !cols[x1]) x1--;
  if (y0 > y1 || x0 > x1) return null;
  return { x: r.x + x0, y: r.y + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Typical text line height and the space between lines, from narrow
 * vertical strips so each strip sees a single column.
 */
function lineMetrics(m: Uint8Array, w: number, h: number): { line: number; gap: number } {
  const strips = 16;
  const sw = Math.floor(w / strips);
  const lines: number[] = [];
  const spaces: number[] = [];
  for (let s = 0; s < strips; s++) {
    const p = profile(m, w, { x: s * sw, y: 0, w: sw, h }, "rows");
    let y = 0;
    let lastEnd = -1;
    while (y < h) {
      if (!p[y]) {
        y++;
        continue;
      }
      const a = y;
      while (y < h && p[y]) y++;
      if (y - a >= 2) {
        lines.push(y - a);
        if (lastEnd >= 0) spaces.push(a - lastEnd);
        lastEnd = y;
      }
    }
  }
  const line = lines.length ? median(lines) : Math.round(h / 80);
  return { line, gap: spaces.length ? median(spaces) : Math.round(line / 2) };
}

function median(a: number[]): number {
  return [...a].sort((x, y) => x - y)[a.length >> 1];
}

function weightedMedian(items: { v: number; weight: number }[]): number {
  items.sort((a, b) => a.v - b.v);
  const half = items.reduce((s, i) => s + i.weight, 0) / 2;
  let acc = 0;
  for (const i of items) {
    acc += i.weight;
    if (acc >= half) return i.v;
  }
  return items[items.length - 1].v;
}

/**
 * Stacks the blocks onto pages one column wide. Blocks break only between
 * text lines; a piece too tall for a page (a big figure) is shrunk to fit.
 */
function paginate(m: Uint8Array, w: number, blocks: Block[], width: number, pitch: number): Reflowed[] {
  const pad = Math.round(width * 0.04);
  const pageW = width + 2 * pad;
  const pageH = Math.round(pageW * RATIO);
  const room = pageH - 2 * pad;
  const pages: Reflowed[] = [];
  let draws: Draw[] = [];
  let y = 0;
  const flush = () => {
    if (draws.length) pages.push({ w: pageW, h: y + 2 * pad, draws });
    draws = [];
    y = 0;
  };

  let prev: Block | null = null;
  for (const b of blocks) {
    const s = Math.min(1, width / b.col.w);
    const sameCol = prev && prev.col === b.col && b.y >= prev.y + prev.h;
    let space = prev ? (sameCol ? (b.y - prev.y - prev.h) * s : pitch) : 0;
    prev = b;
    let last: Draw | null = null;
    for (const [a, z] of lineBreaks(m, w, b)) {
      let sh = (z - a) * s;
      // A page of its own just for a page number is not worth a swipe.
      if (b.foot && y + space + sh > room) break;
      if (draws.length && y + space + sh > room) {
        flush();
        last = null;
      }
      if (!draws.length) space = 0;
      let k = s;
      if (sh > room) {
        k = (s * room) / sh;
        sh = room;
      }
      const dx = pad + (b.x - b.col.x) * k;
      if (last && k === s) {
        // Next line of the same block: grow the draw instead of adding one.
        last.sh += z - a;
        last.dh += sh;
      } else {
        last = { sx: b.x, sy: a, sw: b.w, sh: z - a, dx, dy: pad + y + space, dw: b.w * k, dh: sh };
        draws.push(last);
      }
      y += space + sh;
      space = 0;
      if (k !== s) {
        flush();
        last = null;
      }
    }
  }
  flush();
  return pages;
}

/**
 * Splits a page number or running foot off the bottom of a block: a short
 * line in smaller type, set further apart than the lines above it.
 */
function splitFoot(m: Uint8Array, w: number, b: Block): [Block, Block] | null {
  const rows = profile(m, w, b, "rows");
  const tol = Math.floor(b.w * 0.002);
  const runs: [number, number][] = [];
  for (let y = 0; y < rows.length; ) {
    if (rows[y] <= tol) {
      y++;
      continue;
    }
    const a = y;
    while (y < rows.length && rows[y] > tol) y++;
    runs.push([a, y]);
  }
  if (runs.length < 4) return null;
  const [a, z] = runs[runs.length - 1];
  const above = runs[runs.length - 2][1];
  const text = runs.slice(0, -1);
  const lineH = median(text.map(([p, q]) => q - p));
  const space = median(text.slice(1).map(([p], i) => p - text[i][1]));
  if (a - above < Math.max(3, space * 2.5) || z - a > lineH * 0.85) return null;
  const foot = trim(m, w, { x: b.x, y: b.y + a, w: b.w, h: z - a });
  const rest = trim(m, w, { x: b.x, y: b.y, w: b.w, h: above });
  if (!foot || !rest || foot.w >= b.col.w * 0.6) return null;
  return [
    { ...rest, col: b.col },
    { ...foot, col: b.col },
  ];
}

/** Splits a block into runs of rows that can go on separate pages. */
function lineBreaks(m: Uint8Array, w: number, b: Block): [number, number][] {
  const rows = profile(m, w, b, "rows");
  const cuts = gaps(rows, 1, Math.floor(b.w * 0.002)).map((g) => b.y + g);
  return spans(b.y, b.y + b.h, cuts);
}
