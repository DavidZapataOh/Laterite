"use client";

import Image from "next/image";
import { useCallback, useRef } from "react";
import styles from "./hero.module.css";

/**
 * The one photographic object on the page, and the whole mechanism in a
 * single picture: income arrives, a capped slice comes off, and it lands as
 * a brick of stock.
 *
 * The brick follows the pointer by a few pixels and can be laid again with a
 * click. Both are skipped when the visitor asks for reduced motion.
 */
export function HeroBrick() {
  const stage = useRef<HTMLDivElement>(null);

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const el = stage.current;
    if (!el || event.pointerType !== "mouse") return;
    const rect = el.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    el.style.setProperty("--px", x.toFixed(3));
    el.style.setProperty("--py", y.toFixed(3));
  }, []);

  const onPointerLeave = useCallback(() => {
    const el = stage.current;
    if (!el) return;
    el.style.setProperty("--px", "0");
    el.style.setProperty("--py", "0");
  }, []);

  const layAgain = useCallback(() => {
    const el = stage.current;
    if (!el) return;
    // restart the CSS animations by toggling the attribute across a reflow
    el.removeAttribute("data-laid");
    void el.offsetWidth;
    el.setAttribute("data-laid", "");
  }, []);

  return (
    <div
      ref={stage}
      className={styles.stage}
      data-laid=""
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      <ol className={`${styles.flow} mono`} aria-label="Example: how one payday becomes one brick">
        <li className={styles.step}>+$1,000 USDC</li>
        <li className={styles.step}>
          <Arrow />
          $25 cap
        </li>
        <li className={styles.step}>
          <Arrow />
          <span className={styles.ticker}>0.0412 SPYx</span>
        </li>
      </ol>

      <svg className={styles.leaders} viewBox="0 0 241 36" aria-hidden="true">
        <g fill="none" stroke="currentColor" strokeWidth="0.7" strokeLinecap="square">
          {LEADERS.map((d) => (
            <path key={d} className={styles.leader} d={d} />
          ))}
        </g>
      </svg>

      {/* Pointer-only: replaying the drop is a flourish, not a control, so it
          stays out of the tab order and the image keeps its own alt text. */}
      <div className={styles.brickButton} onClick={layAgain}>
        <Image
          src="/hero/brick-25.png"
          alt="A red laterite brick stamped with $25"
          width={1536}
          height={1024}
          sizes="(max-width: 720px) 92vw, 42vw"
          preload
          className={styles.brick}
          draggable={false}
        />
      </div>
    </div>
  );
}

/** A straight leader from (x1,y1) to a tip at (x2,y2) with a two-stroke head. */
function leader(x1: number, y1: number, x2: number, y2: number, head = 5.2) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const wing = (offset: number) => {
    const a = angle + Math.PI + offset;
    return `M${x2} ${y2} l${(Math.cos(a) * head).toFixed(2)} ${(Math.sin(a) * head).toFixed(2)}`;
  };
  return `M${x1} ${y1} L${x2} ${y2} ${wing(0.45)} ${wing(-0.45)}`;
}

// Tips stop just short of the brick's top-left corner, top edge and top-right
// corner. Units are hundredths of the course em.
const LEADERS = [leader(22, 0, 43, 7), leader(122, 0, 122, 16), leader(229, 3, 207, 29)];

function Arrow() {
  return (
    <svg viewBox="0 0 40 12" aria-hidden="true" className={styles.flowArrow}>
      <path d="M1 6h36M31 1l6 5-6 5" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
