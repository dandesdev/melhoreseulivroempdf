import type { CSSProperties } from "react";
import { placePage, type Frame } from "../lib/frame";
import type { Page } from "../lib/order";
import cn from "../utils/cn";

type Props = { page: Page; frame: Frame; src: string; alt?: string; className?: string; style?: CSSProperties };

/** A page drawn the way it lands in the PDF: same-size sheet, image placed on it. */
export const FramedPage = ({ page, frame, src, alt = "", className, style }: Props) => {
  const at = placePage(page, frame);
  return (
    <div className={cn("relative bg-white", className)} style={{ aspectRatio: `${frame.w} / ${frame.h}`, ...style }}>
      <img
        src={src}
        alt={alt}
        className="absolute block"
        style={{
          left: `${(100 * at.x) / frame.w}%`,
          top: `${(100 * at.y) / frame.h}%`,
          width: `${(100 * at.w) / frame.w}%`,
          height: `${(100 * at.h) / frame.h}%`,
        }}
      />
    </div>
  );
};
