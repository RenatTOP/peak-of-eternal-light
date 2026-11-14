import { useEffect, useState, type RefObject } from "react";

export interface CanvasSize {
  w: number;
  h: number;
  dpr: number;
}

/** Sizes the canvas to its container, honouring devicePixelRatio. */
export function useCanvas(ref: RefObject<HTMLCanvasElement | null>): CanvasSize {
  const [size, setSize] = useState<CanvasSize>({ w: 0, h: 0, dpr: 1 });
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const update = () => {
      const r = cv.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(r.width * dpr);
      cv.height = Math.round(r.height * dpr);
      setSize({ w: r.width, h: r.height, dpr });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}
