import { site } from "@/lib/site";
import { HeroBrick } from "./hero-brick";
import styles from "./hero.module.css";

const CHIPS = ["Non-custodial", "You set the cap", "Revoke in one tap"];

export function Hero() {
  return (
    <section className={styles.hero} aria-labelledby="hero-title">
      <div className={styles.wall}>
        <h1 id="hero-title" className={styles.type}>
          <span className={styles.course}>
            <span className={styles.word}>Get</span>{" "}
            <span className={styles.word}>paid.</span>
          </span>{" "}
          <span className={styles.course}>Lay a</span>{" "}
          <span className={styles.course}>brick.</span>
        </h1>

        <HeroBrick />
      </div>

      <div className={styles.base}>
        <div className={styles.pitch}>
          <p className={styles.sentence}>
            Every payday, a slice of your dollars becomes S&amp;P&nbsp;500. From
            your own wallet.
          </p>
          <div className={styles.actions}>
            <a href={site.appUrl} className={styles.cta}>
              Lay the first brick
            </a>
            <ul className={styles.chips}>
              {CHIPS.map((chip) => (
                <li key={chip} className={`${styles.chip} mono`}>
                  {chip}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <a href="#how-it-works" className={`${styles.next} mono`}>
          01 · The cap
          <svg viewBox="0 0 16 24" aria-hidden="true" className={styles.nextArrow}>
            <path d="M8 1v20M2 15l6 7 6-7" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
        </a>
      </div>
    </section>
  );
}
