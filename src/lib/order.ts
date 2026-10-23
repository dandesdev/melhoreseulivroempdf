import type { OutPage } from "../worker";

export type Layout = "ltr" | "rtl" | "booklet";
export type Page = OutPage & { id: string; thumbUrl: string; sheet: number; side: number };
/** One scanned sheet of the source PDF and the pages cut from it. */
export type Sheet = { index: number; pages: Page[] };

/**
 * Reading order. Book scans read left then right on each sheet (right then
 * left for manga and Arabic). Booklet sheets put page N next to page 1, so
 * their order comes from the page count alone.
 */
export function orderPages(sheets: Sheet[], layout: Layout): Page[] {
  const flat = (rtl: boolean) => sheets.flatMap((s) => (rtl ? [...s.pages].reverse() : s.pages));
  if (layout !== "booklet" || sheets.some((s) => s.pages.length !== 2)) return flat(layout === "rtl");
  const n = sheets.length * 2;
  const numbered: { no: number; page: Page }[] = [];
  sheets.forEach((s, j) => {
    const k = Math.floor(j / 2);
    const [left, right] = s.pages;
    if (j % 2 === 0) {
      numbered.push({ no: n - 2 * k, page: left }, { no: 2 * k + 1, page: right });
    } else {
      numbered.push({ no: 2 * k + 2, page: left }, { no: n - 2 * k - 1, page: right });
    }
  });
  return numbered.sort((a, b) => a.no - b.no).map((x) => x.page);
}
