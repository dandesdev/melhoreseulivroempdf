// Page analysis for scanned books: orientation, spread split, deskew and
// content crop. Everything here is pure and works on small grayscale images,
// so it runs the same in a worker, in the browser or in Node tests.

export type Gray = { w: number; h: number; data: Uint8Array };
export type Rect = { x: number; y: number; w: number; h: number };

export type Half = {
  /** Page area inside the oriented image. */
  rect: Rect;
  /** Text line angle in radians. Rotating by -theta makes lines horizontal. */
  theta: number;
  /** Crop box in the deskewed half's own coordinates. */
  box: Rect;
  /** Text area inside the crop box; anything outside it is margin noise. */
  content: Rect;
  /** Fraction of the half covered by ink, used to spot blank pages. */
  ink: number;
};

export type Plan = {
  /** Quarter turns clockwise that make the text upright. */
  k: number;
  kConf: number;
  /** Split position as a fraction of the oriented width, or null for a single page. */
  split: number | null;
  splitConf: number;
  halves: Half[];
  debug?: { axis: number; up: number };
};

export type Hint = { k: number; split: number | null };

const DEG = Math.PI / 180;

export function rgbaToGray(rgba: Uint8ClampedArray, w: number, h: number): Gray {
  const data = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    data[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  return { w, h, data };
}

/** Rotates k quarter turns clockwise. */
export function rotate90(g: Gray, k: number): Gray {
  k = ((k % 4) + 4) % 4;
  if (k === 0) return g;
  const { w, h, data } = g;
  const nw = k === 2 ? w : h;
  const nh = k === 2 ? h : w;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number, ny: number;
      if (k === 1) {
        nx = h - 1 - y;
        ny = x;
      } else if (k === 2) {
        nx = w - 1 - x;
        ny = h - 1 - y;
      } else {
        nx = y;
        ny = w - 1 - x;
      }
      out[ny * nw + nx] = data[y * w + x];
    }
  }
  return { w: nw, h: nh, data: out };
}

/**
 * Divides the image by an estimate of the paper color. Yellowed paper,
 * gutter shadows and dark scanner borders all end up close to white,
 * while ink keeps its contrast.
 */
export function normalizeBackground(g: Gray, cell: number): Gray {
  const { w, h, data } = g;
  const gw = Math.ceil(w / cell);
  const gh = Math.ceil(h / cell);
  const grid = new Float32Array(gw * gh);
  const hist = new Uint32Array(64);
  const step = cell > 24 ? 2 : 1;

  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      hist.fill(0);
      const x0 = gx * cell;
      const y0 = gy * cell;
      const x1 = Math.min(w, x0 + cell);
      const y1 = Math.min(h, y0 + cell);
      let n = 0;
      for (let y = y0; y < y1; y += step) {
        for (let x = x0, i = y * w + x0; x < x1; x += step, i += step) {
          hist[data[i] >> 2]++;
          n++;
        }
      }
      // The 90th percentile is paper even in dense text.
      const target = n * 0.9;
      let acc = 0;
      let b = 0;
      for (; b < 63; b++) {
        acc += hist[b];
        if (acc >= target) break;
      }
      grid[gy * gw + gx] = b * 4 + 2;
    }
  }

  const bg = blur3(max3(grid, gw, gh), gw, gh);

  const out = new Uint8Array(w * h);
  const fxs = new Float32Array(w);
  const ix0 = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    const fx = Math.min(gw - 1, Math.max(0, x / cell - 0.5));
    ix0[x] = Math.min(gw - 2, Math.floor(fx));
    fxs[x] = gw > 1 ? fx - ix0[x] : 0;
    if (gw === 1) ix0[x] = 0;
  }
  for (let y = 0; y < h; y++) {
    const fy0 = Math.min(gh - 1, Math.max(0, y / cell - 0.5));
    const iy = gh > 1 ? Math.min(gh - 2, Math.floor(fy0)) : 0;
    const fy = gh > 1 ? fy0 - iy : 0;
    const r0 = iy * gw;
    const r1 = gh > 1 ? r0 + gw : r0;
    for (let x = 0, i = y * w; x < w; x++, i++) {
      const gx = ix0[x];
      const gx1 = gw > 1 ? gx + 1 : gx;
      const fx = fxs[x];
      const top = bg[r0 + gx] * (1 - fx) + bg[r0 + gx1] * fx;
      const bot = bg[r1 + gx] * (1 - fx) + bg[r1 + gx1] * fx;
      const b = Math.max(24, top * (1 - fy) + bot * fy);
      const v = (data[i] * 255) / b;
      out[i] = v > 255 ? 255 : v;
    }
  }
  return { w, h, data: out };
}

function max3(a: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(a.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          m = Math.max(m, a[yy * w + xx]);
        }
      }
      out[y * w + x] = m;
    }
  }
  return out;
}

function blur3(a: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(a.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          s += a[yy * w + xx];
          n++;
        }
      }
      out[y * w + x] = s / n;
    }
  }
  return out;
}

export function inkMask(g: Gray, threshold = 150): Uint8Array {
  const m = new Uint8Array(g.w * g.h);
  for (let i = 0; i < m.length; i++) m[i] = g.data[i] < threshold ? 1 : 0;
  return m;
}

function rotateMask(m: Uint8Array, w: number, h: number, k: number) {
  return rotate90({ w, h, data: m }, k);
}

/**
 * Positive when text lines run horizontally, negative when vertically.
 * Across text lines the ink profile jumps between line and gap; along
 * them it stays flat, so we compare how much each profile varies.
 */
export function lineAxisScore(m: Uint8Array, w: number, h: number): number {
  const tiles = 6;
  const tw = Math.floor(w / tiles);
  const th = Math.floor(h / tiles);
  if (tw < 8 || th < 8) return 0;
  const rows = new Float32Array(th);
  const cols = new Float32Array(tw);
  let score = 0;
  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      rows.fill(0);
      cols.fill(0);
      let ink = 0;
      for (let y = 0; y < th; y++) {
        const r = (ty * th + y) * w + tx * tw;
        for (let x = 0; x < tw; x++) {
          if (m[r + x]) {
            rows[y]++;
            cols[x]++;
            ink++;
          }
        }
      }
      const fill = ink / (tw * th);
      if (fill < 0.01 || fill > 0.4) continue;
      const cr = cv(rows);
      const cc = cv(cols);
      score += (cr - cc) / (cr + cc + 1e-6);
    }
  }
  return score;
}

function cv(p: Float32Array): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) s += p[i];
  const mean = s / p.length;
  if (mean === 0) return 0;
  let v = 0;
  for (let i = 0; i < p.length; i++) v += (p[i] - mean) ** 2;
  return Math.sqrt(v / p.length) / mean;
}

/**
 * Positive when horizontal text is upright, negative when upside down.
 * Latin script has more ink above the x-height band (ascenders, capitals,
 * accents, i-dots) than below it (descenders), so we compare the two.
 */
export function uprightScore(m: Uint8Array, w: number, rect: Rect): number {
  const strips = Math.max(1, Math.round(rect.w / 90));
  const sw = Math.floor(rect.w / strips);
  const p = new Float32Array(rect.h);
  let above = 0;
  let below = 0;
  for (let s = 0; s < strips; s++) {
    p.fill(0);
    let peak = 0;
    for (let y = 0; y < rect.h; y++) {
      const r = (rect.y + y) * w + rect.x + s * sw;
      let c = 0;
      for (let x = 0; x < sw; x++) c += m[r + x];
      p[y] = c;
      if (c > peak) peak = c;
    }
    if (peak < 4) continue;
    const low = Math.max(1, peak * 0.04);
    let y = 0;
    while (y < rect.h) {
      if (p[y] < low) {
        y++;
        continue;
      }
      const a = y;
      let lineMax = 0;
      while (y < rect.h && p[y] >= low) {
        lineMax = Math.max(lineMax, p[y]);
        y++;
      }
      const b = y - 1;
      if (b - a < 3 || lineMax < peak * 0.25) continue;
      const core = lineMax * 0.5;
      let c0 = a;
      while (p[c0] < core) c0++;
      let c1 = b;
      while (p[c1] < core) c1--;
      for (let i = a; i < c0; i++) above += p[i];
      for (let i = c1 + 1; i <= b; i++) below += p[i];
    }
  }
  if (above + below < 50) return 0;
  return (above - below) / (above + below);
}

/** Finds the gutter of a two-page spread. Returns null for single pages. */
export function findSplit(
  m: Uint8Array,
  w: number,
  h: number,
): { x: number; conf: number } | null {
  if (w < h * 1.15) return null;
  // Text produces many ink/paper transitions down each column; the gutter
  // produces almost none, even when the binding casts a shadow.
  const e = new Float32Array(w);
  for (let y = 1; y < h; y++) {
    const r = y * w;
    const p = r - w;
    for (let x = 0; x < w; x++) if (m[r + x] !== m[p + x]) e[x]++;
  }
  const es = boxSmooth(e, Math.max(2, Math.round(w / 200)));
  const ref = percentile(es, 0.75);
  if (ref <= 0) return { x: Math.round(w / 2), conf: 0 };
  const thr = ref * 0.12;
  const lo = Math.floor(w * 0.3);
  const hi = Math.ceil(w * 0.7);

  let best: { a: number; b: number; score: number } | null = null;
  for (let x = lo; x < hi; ) {
    if (es[x] > thr) {
      x++;
      continue;
    }
    const a = x;
    while (x < hi && es[x] <= thr) x++;
    const b = x - 1;
    const len = b - a + 1;
    const center = (a + b) / 2;
    const score = len - Math.abs(center - w / 2) * 0.5;
    if (!best || score > best.score) best = { a, b, score };
  }

  let x: number;
  if (best) {
    x = Math.round((best.a + best.b) / 2);
  } else {
    x = lo;
    for (let i = lo; i < hi; i++) if (es[i] < es[x]) x = i;
    // No quiet column at all: this is one wide page, not a spread.
    if (es[x] > ref * 0.4) return null;
  }

  // Trust the cut only when there is real text on both sides of it.
  let left = 0;
  let right = 0;
  for (let i = 0; i < x; i++) left += es[i];
  for (let i = x; i < w; i++) right += es[i];
  const balance = Math.min(left, right) / Math.max(left, right, 1);
  const conf = best ? Math.min(1, balance * 2.5) : 0.2;
  return { x, conf };
}

function boxSmooth(a: Float32Array, r: number): Float32Array {
  const out = new Float32Array(a.length);
  let s = 0;
  let n = 0;
  for (let i = 0; i < Math.min(r, a.length); i++) {
    s += a[i];
    n++;
  }
  for (let i = 0; i < a.length; i++) {
    if (i + r < a.length) {
      s += a[i + r];
      n++;
    }
    if (i - r - 1 >= 0) {
      s -= a[i - r - 1];
      n--;
    }
    out[i] = s / n;
  }
  return out;
}

function percentile(a: Float32Array, q: number): number {
  const sorted = Float32Array.from(a).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

/** Text line angle in radians, found by maximizing projection sharpness. */
export function estimateSkew(m: Uint8Array, w: number, rect: Rect): number {
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x, i = y * w + x; x < rect.x + rect.w; x++, i++) count += m[i];
  }
  if (count < 200) return 0;
  const stride = Math.max(1, Math.ceil(count / 60000));
  const xs = new Float32Array(Math.ceil(count / stride) + 1);
  const ys = new Float32Array(xs.length);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  let n = 0;
  let k = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x, i = y * w + x; x < rect.x + rect.w; x++, i++) {
      if (!m[i]) continue;
      if (k++ % stride === 0) {
        xs[n] = x - cx;
        ys[n] = y - cy;
        n++;
      }
    }
  }
  const size = Math.ceil(Math.hypot(rect.w, rect.h)) + 4;
  const bins = new Float32Array(size);
  const off = size / 2;
  const score = (t: number) => {
    bins.fill(0);
    const c = Math.cos(t);
    const s = Math.sin(t);
    for (let i = 0; i < n; i++) bins[(ys[i] * c - xs[i] * s + off) | 0]++;
    let sum = 0;
    for (let i = 0; i < size; i++) sum += bins[i] * bins[i];
    return sum;
  };
  let best = 0;
  let bestScore = -1;
  for (let d = -6; d <= 6.001; d += 0.25) {
    const sc = score(d * DEG);
    if (sc > bestScore) {
      bestScore = sc;
      best = d;
    }
  }
  const center = best;
  for (let d = center - 0.25; d <= center + 0.25; d += 0.05) {
    const sc = score(d * DEG);
    if (sc > bestScore) {
      bestScore = sc;
      best = d;
    }
  }
  return best * DEG;
}

/** Rotates the part of the mask inside rect by -theta around its center. */
export function deskewMask(m: Uint8Array, w: number, rect: Rect, theta: number): Uint8Array {
  const out = new Uint8Array(rect.w * rect.h);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const hw = rect.w / 2;
  const hh = rect.h / 2;
  for (let qy = 0; qy < rect.h; qy++) {
    for (let qx = 0; qx < rect.w; qx++) {
      const ux = qx + 0.5 - hw;
      const uy = qy + 0.5 - hh;
      const px = Math.floor(ux * c - uy * s + hw);
      const py = Math.floor(ux * s + uy * c + hh);
      if (px < 0 || py < 0 || px >= rect.w || py >= rect.h) continue;
      out[qy * rect.w + qx] = m[(rect.y + py) * w + rect.x + px];
    }
  }
  return out;
}

/**
 * Finds the text block. The core is the rectangle of the block grid with
 * the most text and the least empty space. Headers and page numbers near
 * it are added back; specks, edge shadows and thin bars are not.
 */
export function contentBox(m: Uint8Array, w: number, h: number): { box: Rect; content: Rect; ink: number } {
  const full = { x: 0, y: 0, w, h };
  m = dropLongRuns(m, w, h, Math.round(w * 0.03), Math.round(h * 0.04));
  m = dropSpecks(m, w, h, Math.max(4, Math.round((w * h) / 80000)));
  const b = Math.max(3, Math.round(Math.min(w, h) / 70));
  const gw = Math.ceil(w / b);
  const gh = Math.ceil(h / b);
  const text = new Uint8Array(gw * gh);
  let inkTotal = 0;
  let textBlocks = 0;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let c = 0;
      const x1 = Math.min(w, (gx + 1) * b);
      const y1 = Math.min(h, (gy + 1) * b);
      for (let y = gy * b; y < y1; y++) {
        for (let x = gx * b, i = y * w + x; x < x1; x++, i++) c += m[i];
      }
      inkTotal += c;
      const d = c / ((x1 - gx * b) * (y1 - gy * b));
      if (d > 0.01 && d < 0.45) {
        text[gy * gw + gx] = 1;
        textBlocks++;
      }
    }
  }
  const ink = inkTotal / (w * h);
  if (textBlocks < gw * gh * 0.03) return { box: full, content: full, ink };

  const core = densestRect(text, gw, gh);
  // A small core means a blank page with a stamp or a speck; keep it whole.
  if (!core || (core.x1 - core.x0 + 1) * (core.y1 - core.y0 + 1) < gw * gh * 0.12) {
    return { box: full, content: full, ink };
  }
  // Pixels from here on. Blocks are too coarse for the side edges: a
  // gutter line a few pixels from the text would land in the same block.
  const [cx0, cx1] = textColumns(m, w, core.y0 * b, Math.min(h, (core.y1 + 1) * b), core.x0 * b, Math.min(w, (core.x1 + 1) * b));
  let x0 = cx0;
  let x1 = cx1;
  let y0 = core.y0 * b;
  let y1 = Math.min(h, (core.y1 + 1) * b);
  // Headers, titles and page numbers sit above or below the text block.
  const near = Math.round(gh * 0.25);
  const close = Math.max(2, Math.round(gh * 0.04));
  const groups = blockGroups(text, gw, gh);
  for (const g of groups) {
    if (g.edge) continue;
    const gwid = g.x1 - g.x0 + 1;
    const ghei = g.y1 - g.y0 + 1;
    // Thin bars are usually the edge of the next page or a ruler, not text.
    if (Math.max(gwid, ghei) > 8 * Math.min(gwid, ghei)) continue;
    const dx = Math.max(0, core.x0 - g.x1, g.x0 - core.x1);
    const dy = Math.max(0, core.y0 - g.y1, g.y0 - core.y1);
    if (dx > 0 || dy === 0 || dy > near) continue;
    // Far from the text, a short mark counts only below it and alone, like a
    // date under the last line. Above it or in a row, it is a page edge.
    if (dy > close && gwid < (core.x1 - core.x0 + 1) * 0.2) {
      if (g.y1 < core.y0) continue;
      const row = groups.filter((o) => o !== g && o.y0 <= g.y1 && o.y1 >= g.y0 && (o.y1 < core.y0 || o.y0 > core.y1));
      if (row.length >= 2) continue;
    }
    x0 = Math.min(x0, g.x0 * b);
    y0 = Math.min(y0, g.y0 * b);
    x1 = Math.max(x1, Math.min(w, (g.x1 + 1) * b));
    y1 = Math.max(y1, Math.min(h, (g.y1 + 1) * b));
  }
  const pad = Math.round(Math.min(w, h) * 0.03);
  const bx0 = Math.max(0, x0 - pad);
  const by0 = Math.max(0, y0 - pad);
  const bx1 = Math.min(w, x1 + pad);
  const by1 = Math.min(h, y1 + pad);
  return {
    box: { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 },
    content: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    ink,
  };
}

type Box = { x0: number; y0: number; x1: number; y1: number };

/**
 * Left and right edges of the text between rows y0 and y1, searched within
 * [xa, xb). A text column has ink in every pixel column; stray lines and
 * shadows sit apart from it behind a clear vertical gap. Pages printed in
 * columns have several such runs of similar weight, and all of them stay.
 */
function textColumns(m: Uint8Array, w: number, y0: number, y1: number, xa: number, xb: number): [number, number] {
  const prof = new Float32Array(xb - xa);
  let peak = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = xa, i = y * w + xa; x < xb; x++, i++) prof[x - xa] += m[i];
  }
  for (const v of prof) peak = Math.max(peak, v);
  const thr = Math.max(1, peak * 0.03);
  const minGap = Math.max(3, Math.round(w * 0.012));
  const runs: { a: number; b: number; mass: number }[] = [];
  let x = 0;
  while (x < prof.length) {
    if (prof[x] < thr) {
      x++;
      continue;
    }
    const a = x;
    let mass = 0;
    let last = x;
    while (x < prof.length && x - last <= minGap) {
      if (prof[x] >= thr) {
        last = x;
        mass += prof[x];
      }
      x++;
    }
    runs.push({ a: xa + a, b: xa + last + 1, mass });
    x = last + 1;
  }
  if (!runs.length) return [xa, xb];
  const best = runs.reduce((p, r) => (r.mass > p.mass ? r : p));
  const columns = runs.filter((r) => r.mass >= best.mass * 0.25 && r.b - r.a >= (best.b - best.a) * 0.3);
  return [Math.min(...columns.map((r) => r.a)), Math.max(...columns.map((r) => r.b))];
}

/** Maximum-sum subrectangle where text blocks count +1 and empty ones -1. */
function densestRect(text: Uint8Array, gw: number, gh: number): Box | null {
  const col = new Int32Array(gw);
  let best = 0;
  let res: Box | null = null;
  for (let t = 0; t < gh; t++) {
    col.fill(0);
    for (let bot = t; bot < gh; bot++) {
      const r = bot * gw;
      for (let x = 0; x < gw; x++) col[x] += text[r + x] ? 1 : -1;
      let sum = 0;
      let start = 0;
      for (let x = 0; x < gw; x++) {
        if (sum <= 0) {
          sum = col[x];
          start = x;
        } else {
          sum += col[x];
        }
        if (sum > best) {
          best = sum;
          res = { x0: start, y0: t, x1: x, y1: bot };
        }
      }
    }
  }
  return res;
}

/** Groups of text blocks that touch, including diagonally. */
function blockGroups(text: Uint8Array, gw: number, gh: number) {
  const seen = new Uint8Array(gw * gh);
  const groups: (Box & { edge: boolean })[] = [];
  const stack: number[] = [];
  for (let start = 0; start < text.length; start++) {
    if (!text[start] || seen[start]) continue;
    const g = { x0: gw, y0: gh, x1: -1, y1: -1, edge: false };
    groups.push(g);
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      const gx = i % gw;
      const gy = (i - gx) / gw;
      g.x0 = Math.min(g.x0, gx);
      g.y0 = Math.min(g.y0, gy);
      g.x1 = Math.max(g.x1, gx);
      g.y1 = Math.max(g.y1, gy);
      // Near the border counts as touching it: deskewing leaves empty corners.
      if (gx < 3 || gy < 3 || gx >= gw - 3 || gy >= gh - 3) g.edge = true;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = gy + dy;
        if (yy < 0 || yy >= gh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = gx + dx;
          if (xx < 0 || xx >= gw) continue;
          const n = yy * gw + xx;
          if (text[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
  }
  return groups;
}

/**
 * Removes connected ink smaller than minArea pixels. Scanner shadows turn
 * into fields of such specks; letters are bigger.
 */
export function dropSpecks(m: Uint8Array, w: number, h: number, minArea: number): Uint8Array {
  const out = Uint8Array.from(m);
  const seen = new Uint8Array(m.length);
  const comp: number[] = [];
  for (let start = 0; start < m.length; start++) {
    if (!m[start] || seen[start]) continue;
    comp.length = 0;
    comp.push(start);
    seen[start] = 1;
    for (let k = 0; k < comp.length; k++) {
      const i = comp[k];
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const n = yy * w + xx;
          if (m[n] && !seen[n]) {
            seen[n] = 1;
            comp.push(n);
          }
        }
      }
    }
    if (comp.length < minArea) for (const i of comp) out[i] = 0;
  }
  return out;
}

/**
 * Removes ink that belongs to long straight runs: page edges, rulers,
 * gutter lines. Letters never produce runs this long.
 */
export function dropLongRuns(m: Uint8Array, w: number, h: number, maxH: number, maxV: number): Uint8Array {
  const out = Uint8Array.from(m);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; ) {
      if (!m[r + x]) {
        x++;
        continue;
      }
      const a = x;
      while (x < w && m[r + x]) x++;
      if (x - a > maxH) out.fill(0, r + a, r + x);
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; ) {
      if (!m[y * w + x]) {
        y++;
        continue;
      }
      const a = y;
      while (y < h && m[y * w + x]) y++;
      if (y - a > maxV) for (let i = a; i < y; i++) out[i * w + x] = 0;
    }
  }
  return out;
}

function analyzeOriented(m: Uint8Array, w: number, h: number, splitHint: number | null | undefined) {
  const found = findSplit(m, w, h);
  let split: number | null = found ? found.x / w : null;
  let splitConf = found ? found.conf : w < h * 1.15 ? 1 : 0.5;
  if (splitConf < 0.5 && splitHint !== undefined) {
    split = splitHint;
    splitConf = 0.5;
  }
  const rects: Rect[] = [];
  if (split === null) {
    rects.push({ x: 0, y: 0, w, h });
  } else {
    const sx = Math.round(split * w);
    rects.push({ x: 0, y: 0, w: sx, h }, { x: sx, y: 0, w: w - sx, h });
  }
  const halves = rects.map((rect) => {
    const theta = estimateSkew(m, w, rect);
    const dm = deskewMask(m, w, rect, theta);
    const { box, content, ink } = contentBox(dm, rect.w, rect.h);
    return { rect, theta, box, content, ink, dm };
  });
  return { split, splitConf, halves };
}

/**
 * Full analysis of one scanned page, given a small grayscale render.
 * A hint from other pages of the same document fills in whatever this
 * page cannot decide alone (blank pages, covers, photos).
 */
export function analyzePage(gray: Gray, hint?: Hint): Plan {
  const norm = normalizeBackground(gray, Math.max(8, Math.round(Math.max(gray.w, gray.h) / 40)));
  const mask = inkMask(norm);

  const axis = lineAxisScore(mask, gray.w, gray.h);
  let k0 = axis >= 0 ? 0 : 1;
  const axisConf = Math.min(1, Math.abs(axis));

  const run = (k: number) => {
    const r = rotateMask(mask, gray.w, gray.h, k);
    return { k, r, ...analyzeOriented(r.data, r.w, r.h, hint?.split) };
  };

  let res = run(k0);
  let up = 0;
  for (const half of res.halves) up += uprightScore(half.dm, half.rect.w, { x: 0, y: 0, w: half.rect.w, h: half.rect.h });
  const upConf = Math.min(1, Math.abs(up) / 0.1);
  let kConf = Math.min(axisConf, upConf);

  if (kConf < 0.5 && hint) {
    k0 = hint.k % 2;
    if (res.k !== hint.k) res = run(hint.k);
    kConf = 0.5;
  } else if (up < 0) {
    res = run(k0 + 2);
  }

  return {
    k: res.k % 4,
    kConf,
    debug: { axis, up },
    split: res.split,
    splitConf: res.splitConf,
    halves: res.halves.map(({ rect, theta, box, content, ink }) => ({ rect, theta, box, content, ink })),
  };
}
