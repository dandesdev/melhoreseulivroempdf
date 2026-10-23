import { normalizeBackground, type Gray } from "./scan";

export type Mode = "enhanced" | "bw" | "original";

/**
 * Makes a scanned page easier to read: flattens the paper to white, then
 * stretches the ink to black. "bw" goes all the way to two tones.
 */
export function enhance(g: Gray, mode: Mode): Gray {
  if (mode === "original") return g;
  const n = normalizeBackground(g, Math.max(16, Math.round(Math.max(g.w, g.h) / 40)));

  const hist = new Uint32Array(256);
  for (let i = 0; i < n.data.length; i++) hist[n.data[i]]++;
  // Black point: the darkest 0.5% of pixels, which is ink on any text page.
  let bp = 0;
  for (let acc = 0, target = n.data.length * 0.005; bp < 255; bp++) {
    acc += hist[bp];
    if (acc >= target) break;
  }
  bp = Math.min(bp, 110);
  const wp = 232;

  const lut = new Uint8Array(256);
  if (mode === "bw") {
    const t = bp + (wp - bp) * 0.6;
    for (let v = 0; v < 256; v++) lut[v] = v < t ? 0 : 255;
  } else {
    for (let v = 0; v < 256; v++) {
      const x = Math.min(1, Math.max(0, (v - bp) / (wp - bp)));
      // Gamma above 1 darkens the soft edges of letters, so text reads bolder.
      lut[v] = Math.round(255 * Math.pow(x, 1.6));
    }
  }
  const out = new Uint8Array(n.data.length);
  for (let i = 0; i < out.length; i++) out[i] = lut[n.data[i]];
  return { w: g.w, h: g.h, data: out };
}
