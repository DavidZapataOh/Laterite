import Image from "next/image";
import { site } from "@/lib/site";
import styles from "./footer.module.css";

export function Footer() {
  const links = site.links.filter((link) => link.href);

  return (
    <footer className={`${styles.footer} on-dark`}>
      <div className={styles.logo}>
        <Image src="/brand/symbol-terracotta.svg" alt="" width={200} height={200} className={styles.symbol} unoptimized />
        <Image src="/brand/wordmark-cream.svg" alt="Laterite" width={454} height={74} className={styles.wordmark} unoptimized />
      </div>
      <div className={styles.aside}>
        {links.length > 0 ? (
          <ul className={`${styles.links} mono`}>
            {links.map((link) => (
              <li key={link.label}>
                <a href={link.href} className={styles.link}>
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        <p className={styles.small}>
          Running on Solana devnet. Tokenized stocks are not available in every country.
        </p>
      </div>
    </footer>
  );
}
