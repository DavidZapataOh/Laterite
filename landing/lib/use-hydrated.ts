"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * False on the server and during hydration, true afterwards. Scroll-driven
 * pieces render their finished state until this flips, so the page is complete
 * without JavaScript and nothing is hidden on first paint.
 */
export function useHydrated() {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
