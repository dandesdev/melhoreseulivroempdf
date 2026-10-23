// Copies the pdf.js decoders (JBIG2 and CCITT scans need them) and fonts
// into public/, so Vite serves them in dev and ships them in the build.
import { cpSync, mkdirSync, rmSync } from "node:fs";

const src = "node_modules/pdfjs-dist";
const dest = "public/pdfjs";
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(`${src}/wasm`, `${dest}/wasm`, {
  recursive: true,
  filter: (path) => !path.includes("quickjs"),
});
cpSync(`${src}/standard_fonts`, `${dest}/standard_fonts`, { recursive: true });
