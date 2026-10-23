import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { usePreferences } from "../context/preferences";
import { pageFrame } from "../lib/frame";
import type { Page } from "../lib/order";
import { FramedPage } from "./FramedPage";

type Props = {
  pages: Page[];
  index: number;
  setIndex: (i: number | null) => void;
  setPages: Dispatch<SetStateAction<Page[]>>;
  onClose: () => void;
};

const actionBtn =
  "flex-1 min-w-0 px-2 py-2 rounded-sm text-sm cursor-pointer outline-dashed outline-2 outline-offset-[-2px] outline-neutral/40 hover:outline-primary hover:text-primary transition-all duration-300 disabled:opacity-30 disabled:pointer-events-none";

/** Full-size view of one page with move, rotate and delete actions. */
export const Viewer = ({ pages, index, setIndex, setPages, onClose }: Props) => {
  const { t } = usePreferences();
  const page = pages[index];
  const frame = useMemo(() => pageFrame(pages), [pages]);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const u = URL.createObjectURL(page.image);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [page.image]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const move = (delta: number) => {
    const to = index + delta;
    setPages((list) => {
      const next = [...list];
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });
    setIndex(to);
  };

  const rotate = async () => {
    const [image, thumb] = await Promise.all([rotate180(page.image), rotate180(page.thumb)]);
    const thumbUrl = URL.createObjectURL(thumb);
    setPages((list) => list.map((p) => (p.id === page.id ? { ...p, image, thumb, thumbUrl } : p)));
  };

  const remove = () => {
    setPages((list) => list.filter((p) => p.id !== page.id));
    if (pages.length <= 1) onClose();
    else setIndex(Math.min(index, pages.length - 2));
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-background/95 backdrop-blur-sm font-fira text-text"
      role="dialog"
      aria-modal="true"
      aria-label={t.pageOf(index + 1, pages.length)}
    >
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-sm">{t.pageOf(index + 1, pages.length)}</span>
        <button className="px-2 py-1 text-xl cursor-pointer text-text/70 hover:text-text" onClick={onClose} aria-label={t.close}>
          ×
        </button>
      </div>
      <div className="flex-1 min-h-0 px-4" style={{ containerType: "size" }}>
        {url && (
          <FramedPage
            page={page}
            frame={frame}
            src={url}
            className="mx-auto shadow-lg"
            // As large as fits both ways: container width, or height times the page ratio.
            style={{ width: `min(100cqw, calc(100cqh * ${frame.w / frame.h}))` }}
          />
        )}
      </div>
      <div className="flex gap-2 px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <button className={actionBtn} onClick={() => move(-1)} disabled={index === 0} aria-label={t.moveBack} title={t.moveBack}>
          ←
        </button>
        <button className={actionBtn} onClick={() => move(1)} disabled={index === pages.length - 1} aria-label={t.moveForward} title={t.moveForward}>
          →
        </button>
        <button className={actionBtn} onClick={rotate} title={t.rotate}>
          ⟲ 180°
        </button>
        <button className={`${actionBtn} text-accent`} onClick={remove}>
          {t.remove}
        </button>
      </div>
    </div>
  );
};

async function rotate180(blob: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const c = canvas.getContext("2d")!;
  c.translate(bmp.width, bmp.height);
  c.rotate(Math.PI);
  c.drawImage(bmp, 0, 0);
  bmp.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/jpeg", 0.9),
  );
}
