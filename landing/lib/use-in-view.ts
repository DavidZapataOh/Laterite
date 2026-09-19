"use client";

import { useEffect, useRef, useState } from "react";
import { useHydrated } from "./use-hydrated";

/**
 * True once the element has entered the viewport; it never flips back.
 * Before hydration it reports true, so everything that waits on it renders in
 * its settled pose and the page is complete without JavaScript.
 */
export function useInView<T extends Element>(threshold = 0.35) {
  const ref = useRef<T>(null);
  const hydrated = useHydrated();
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setInView(true);
      },
      { threshold },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [inView, threshold]);

  return [ref, !hydrated || inView] as const;
}
