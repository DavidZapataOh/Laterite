"use client";

import Image from "next/image";
import type { CSSProperties } from "react";
import { useInView } from "@/lib/use-in-view";
import { slice, useScrollProgress } from "@/lib/use-scroll-progress";
import styles from "./story.module.css";

// Illustrative paydays: three laid, today's falling, one still ahead.
const PAYDAYS = [
  { date: "Sep 05", state: "laid" },
  { date: "Sep 12", state: "laid" },
  { date: "Sep 19", state: "laid" },
  { date: "Sep 26", state: "today" },
  { date: "Oct 03", state: "ahead" },
] as const;

export function Autopilot() {
  const [band, progress] = useScrollProgress<HTMLElement>();
  const [strip, inView] = useInView<HTMLOListElement>(0.5);
  const fall = slice(progress, 0.34, 0.66);

  return (
    <section
      ref={band}
      className={`${styles.band} ${styles.stripBand} ${styles.terracotta} on-dark`}
      aria-labelledby="autopilot-title"
    >
      <div className={styles.copy}>
        <h2 id="autopilot-title" className={styles.headline}>
          It runs itself.
        </h2>
        <p className={styles.line}>No deposits. No reminders. No app to open.</p>
      </div>

      <ol ref={strip} className={styles.strip} data-in={inView} aria-label="Example: one brick every payday">
        {PAYDAYS.map(({ date, state }, index) => (
          <li key={date} className={styles.payday}>
            {state === "ahead" ? (
              <span className={styles.ahead} aria-hidden="true" />
            ) : (
              <Image
                src="/body/brick-laid.png"
                alt={state === "today" ? "Today's brick, landing" : "A brick stamped LAID"}
                width={1090}
                height={506}
                sizes="(max-width: 720px) 24vw, 18vw"
                className={`${styles.stripBrick} ${state === "today" ? styles.falling : styles.dropped}`}
                style={
                  state === "today"
                    ? ({ "--fall": fall } as CSSProperties)
                    : { transitionDelay: `${index * 110}ms` }
                }
                draggable={false}
              />
            )}
            <span className={styles.date}>{date}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
