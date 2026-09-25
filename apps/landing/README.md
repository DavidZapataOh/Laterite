# Laterite landing

The marketing page at laterite.cash: English at `/`, Spanish (Argentina) at `/es`. `PRODUCT.md` holds what the page may claim and `DESIGN.md` how it looks; the copy lives in the `landing` namespace of `packages/i18n`.

```bash
just build-landing                    # production build, both locales and their social cards
just landing-test                     # build, then the locale, link and metadata tests (Chromium)
just test-visual                      # build, then compare both locales with the macOS screenshot baselines
pnpm --filter @laterite/landing dev   # development server
```
