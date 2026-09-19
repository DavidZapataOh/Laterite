"use client";

import { useInView } from "@/lib/use-in-view";
import styles from "./story.module.css";

const LIMITS = [
  "Move more than your cap",
  "Send it anywhere but your wallet",
  "Hold your stocks",
  "Stop you from leaving",
];

export function Cannot() {
  const [ref, inView] = useInView<HTMLElement>();

  return (
    <section ref={ref} className={`${styles.band} ${styles.cantBand} ${styles.blush}`} aria-labelledby="cannot-title">
      <div className={`${styles.copy} ${styles.lays}`} data-in={inView}>
        <h2 id="cannot-title" className={styles.headline}>
          What Laterite can&rsquo;t do.
        </h2>
      </div>

      <ul className={`${styles.cant} ${styles.lays}`} data-in={inView}>
        {LIMITS.map((limit) => (
          <li key={limit}>
            <svg viewBox="0 0 20 20" className={styles.cross} aria-hidden="true">
              <path d="M3 3l14 14M17 3L3 17" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="square" />
            </svg>
            {limit}
          </li>
        ))}
      </ul>
    </section>
  );
}
