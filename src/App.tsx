import { useEffect, useRef, useState, type ReactNode } from "react";
import { Nav } from "./components/Nav";
import { Viewer } from "./components/Viewer";
import { usePreferences } from "./context/preferences";
import type { Mode } from "./lib/enhance";
import { orderPages, type Layout, type Page, type Sheet } from "./lib/order";
import type { Quality } from "./lib/pipeline";

// pdf.js and pdf-lib are big; load them when the first file is picked.
const loadPipeline = () => import("./lib/pipeline");
import cn from "./utils/cn";

type Settings = { layout: Layout; mode: Mode; crop: boolean; dropBlank: boolean; quality: Quality };
type Status =
  | { kind: "idle" }
  | { kind: "working"; done: number; total: number }
  | { kind: "ready" }
  | { kind: "error"; message: string };

const DEFAULTS: Settings = { layout: "ltr", mode: "enhanced", crop: true, dropBlank: false, quality: "normal" };

const primaryBtn =
  "flex items-center justify-center gap-1 px-4 py-2 rounded-sm font-fira font-bold text-lg text-background hover:text-primary bg-primary hover:bg-transparent outline-dashed outline-2 outline-transparent hover:outline-primary shadow-lg cursor-pointer focus-visible:outline-offset-2 focus-visible:outline-text group transition-all duration-300 ease-in-out disabled:opacity-50 disabled:pointer-events-none";
const secondaryBtn =
  "flex items-center justify-center gap-1 px-4 py-2 rounded-sm font-fira font-bold text-lg text-primary hover:text-background hover:bg-primary bg-transparent outline-dashed outline-2 outline-offset-[-2px] outline-primary hover:outline-transparent shadow-lg cursor-pointer focus-visible:outline-offset-2 focus-visible:outline-text transition-all duration-300 ease-in-out disabled:opacity-50 disabled:pointer-events-none";

function App() {
  const { t } = usePreferences();
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [pages, setPages] = useState<Page[]>([]);
  const [usedSettings, setUsedSettings] = useState<Settings | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [building, setBuilding] = useState(false);
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Order and blank-page choices are cheap: re-run them on the existing pages.
  useEffect(() => {
    const ordered = orderPages(sheets, settings.layout);
    setPages(settings.dropBlank ? ordered.filter((p) => !p.blank) : ordered);
  }, [sheets, settings.layout, settings.dropBlank]);

  const revoke = (list: Sheet[]) => list.forEach((s) => s.pages.forEach((p) => URL.revokeObjectURL(p.thumbUrl)));

  const start = async (f: File, s: Settings) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setFile(f);
    setSelected(null);
    setStatus({ kind: "working", done: 0, total: 0 });
    try {
      const { processPdf } = await loadPipeline();
      const result = await processPdf(
        f,
        { mode: s.mode, crop: s.crop, quality: s.quality },
        (p) => setStatus({ kind: "working", ...p }),
        ctrl.signal,
      );
      if (ctrl.signal.aborted) return;
      setSheets((old) => {
        revoke(old);
        return result;
      });
      setUsedSettings(s);
      setStatus({ kind: "ready" });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      console.error(err);
      const bad = err instanceof Error && /Invalid PDF|PasswordException|InvalidPDF/i.test(err.name + err.message);
      setStatus({ kind: "error", message: bad ? t.errorRead : t.errorGeneric });
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    setStatus(sheets.length ? { kind: "ready" } : { kind: "idle" });
  };

  const restart = () => {
    abortRef.current?.abort();
    revoke(sheets);
    setSheets([]);
    setFile(null);
    setUsedSettings(null);
    setStatus({ kind: "idle" });
  };

  const onFiles = (list: FileList | null) => {
    const f = list?.[0];
    if (f) start(f, settings);
  };

  const outputName = () => (file?.name.replace(/\.pdf$/i, "") || "documento") + "-mobile.pdf";

  const download = async () => {
    setBuilding(true);
    try {
      const { buildPdf } = await loadPipeline();
      const blob = await buildPdf(pages);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = outputName();
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } finally {
      setBuilding(false);
    }
  };

  const canShare = typeof navigator.canShare === "function";
  const share = async () => {
    setBuilding(true);
    try {
      const { buildPdf } = await loadPipeline();
      const out = new File([await buildPdf(pages)], outputName(), { type: "application/pdf" });
      if (navigator.canShare?.({ files: [out] })) await navigator.share({ files: [out] });
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) console.error(err);
    } finally {
      setBuilding(false);
    }
  };

  const update = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));
  const needsReprocess =
    status.kind === "ready" &&
    usedSettings !== null &&
    (usedSettings.mode !== settings.mode || usedSettings.crop !== settings.crop || usedSettings.quality !== settings.quality);
  const working = status.kind === "working";

  return (
    <>
      <div className="background-vfx" aria-hidden="true" />
      <Nav />
      <main className="mx-auto max-w-[640px] px-6 pt-20 pb-16 font-fira text-text flex flex-col gap-8">
        <header className="flex flex-col gap-3">
          <h1 className="font-bold text-3xl">{t.appName}</h1>
          <p className="font-bold text-xl">{t.tagline}</p>
          <p className="text-text/80 text-sm leading-relaxed">{t.intro}</p>
        </header>

        {(status.kind === "idle" || status.kind === "error") && (
          <section
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              onFiles(e.dataTransfer.files);
            }}
            className={cn(
              "flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-6 py-10 transition-colors duration-300",
              dragging ? "border-primary bg-primary/10" : "border-neutral/40",
            )}
          >
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(e) => {
                onFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button className={primaryBtn} onClick={() => inputRef.current?.click()}>
              <span className="group-hover:rotate-90 transition-transform duration-300 ease-in-out">{">"}</span>
              <span className="pl-1">{t.pick}</span>
            </button>
            <span className="text-sm text-text/60 hidden sm:block">{t.drop}</span>
            {status.kind === "error" && <p className="text-accent text-sm text-center">{status.message}</p>}
          </section>
        )}

        {working && (
          <section className="flex flex-col gap-3" aria-live="polite">
            <p className="text-sm">{status.total ? t.processing(status.done + 1 > status.total ? status.total : status.done + 1, status.total) : t.reading}</p>
            <div className="h-2 w-full rounded-full bg-neutral/20 overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: status.total ? `${(100 * status.done) / status.total}%` : "4%" }}
              />
            </div>
            <button className="self-start text-sm text-accent hover:underline cursor-pointer" onClick={cancel}>
              {t.cancel}
            </button>
          </section>
        )}

        <Options settings={settings} update={update} disabled={working} />

        {status.kind === "ready" && (
          <section className="flex flex-col gap-4">
            {needsReprocess && file && (
              <button className={secondaryBtn} onClick={() => start(file, settings)}>
                {t.reprocess}
              </button>
            )}
            <div className="flex flex-col gap-1">
              <span className="font-bold">{t.pages(pages.length)}</span>
              <span className="text-xs text-text/60">{t.tapHint}</span>
            </div>
            <ul className="grid grid-cols-3 sm:grid-cols-4 gap-3">
              {pages.map((p, i) => (
                <li key={p.id}>
                  <button
                    onClick={() => setSelected(i)}
                    className="relative block w-full cursor-pointer rounded-sm overflow-hidden border border-neutral/30 bg-white shadow-md hover:scale-[1.03] transition-transform duration-300"
                  >
                    <img src={p.thumbUrl} alt={t.pageOf(i + 1, pages.length)} className="block w-full h-auto" />
                    <span className="absolute bottom-0 left-0 px-1.5 py-0.5 text-[10px] bg-background/80 text-text">{i + 1}</span>
                    {p.blank && (
                      <span className="absolute top-0 right-0 px-1.5 py-0.5 text-[10px] bg-accent text-background">{t.blank}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-4 pt-2">
              <button className={primaryBtn} onClick={download} disabled={building || !pages.length}>
                <span className="group-hover:translate-y-0.5 transition-transform duration-300">↓</span>
                <span className="pl-1">{building ? t.building : t.download}</span>
              </button>
              {canShare && (
                <button className={secondaryBtn} onClick={share} disabled={building || !pages.length}>
                  {t.share}
                </button>
              )}
              <button className="text-sm text-accent hover:underline cursor-pointer px-2" onClick={restart}>
                {t.restart}
              </button>
            </div>
          </section>
        )}
      </main>

      <footer className="pb-10 px-6 text-center font-fira text-xs text-text/60">
        {t.footer}{" "}
        <a className="text-accent hover:underline" href="https://dandesdev.github.io/portfolio/" target="_blank" rel="noopener noreferrer">
          Daniel
        </a>
        {" · "}
        <a className="text-accent hover:underline" href="https://github.com/dandesdev/bettermobilepdf" target="_blank" rel="noopener noreferrer">
          {t.source}
        </a>
      </footer>

      {selected !== null && pages[selected] && (
        <Viewer pages={pages} index={selected} setIndex={setSelected} setPages={setPages} onClose={() => setSelected(null)} />
      )}
    </>
  );
}

function Options({
  settings,
  update,
  disabled,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  disabled: boolean;
}) {
  const { t } = usePreferences();
  return (
    <details className="group/opts rounded-lg border border-neutral/30 bg-background/40 shadow-md" open>
      <summary className="cursor-pointer select-none px-4 py-3 font-bold list-none flex items-center gap-2">
        <span className="inline-block transition-transform duration-300 group-open/opts:rotate-90">{">"}</span>
        {t.options}
      </summary>
      <fieldset disabled={disabled} className="flex flex-col gap-5 px-4 pb-5 disabled:opacity-60">
        <Choice
          label={t.layout}
          value={settings.layout}
          onChange={(layout) => update({ layout })}
          options={[
            { value: "ltr", label: t.layoutLtr, hint: t.layoutLtrHint },
            { value: "rtl", label: t.layoutRtl, hint: t.layoutRtlHint },
            { value: "booklet", label: t.layoutBooklet, hint: t.layoutBookletHint },
          ]}
        />
        <Choice
          label={t.look}
          value={settings.mode}
          onChange={(mode) => update({ mode })}
          options={[
            { value: "enhanced", label: t.lookEnhanced },
            { value: "bw", label: t.lookBw },
            { value: "original", label: t.lookOriginal },
          ]}
        />
        <div className="grid grid-cols-2 gap-5">
          <Choice
            label={t.crop}
            value={settings.crop ? "on" : "off"}
            onChange={(v) => update({ crop: v === "on" })}
            options={[
              { value: "on", label: t.on },
              { value: "off", label: t.off },
            ]}
          />
          <Choice
            label={t.quality}
            value={settings.quality}
            onChange={(quality) => update({ quality })}
            options={[
              { value: "normal", label: t.qualityNormal },
              { value: "high", label: t.qualityHigh },
            ]}
          />
        </div>
        <Choice
          label={t.dropBlank}
          value={settings.dropBlank ? "on" : "off"}
          onChange={(v) => update({ dropBlank: v === "on" })}
          options={[
            { value: "on", label: t.on },
            { value: "off", label: t.off },
          ]}
        />
      </fieldset>
    </details>
  );
}

function Choice<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; hint?: ReactNode }[];
}) {
  const current = options.find((o) => o.value === value);
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm text-text/80">{label}</span>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            onClick={() => onChange(o.value)}
            className={cn(
              "px-3 py-1.5 rounded-sm text-sm cursor-pointer transition-all duration-300 outline-dashed outline-2 outline-offset-[-2px]",
              o.value === value
                ? "bg-primary text-background outline-transparent"
                : "bg-transparent text-text/80 outline-neutral/40 hover:outline-primary hover:text-primary",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      {current?.hint && <span className="text-xs text-text/60">{current.hint}</span>}
    </div>
  );
}

export default App;
