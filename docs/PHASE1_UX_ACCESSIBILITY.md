# Phase 1 / Stage 7 — UX, Accessibility & Performance

## Focus

Polish without architecture rewrite. Stages 1–6 contracts remain frozen.

## UX

- Horizontal overflow guards on `html`/`body`/`#main`
- Cover/poster aspect-ratio to reduce layout shift
- Reader images max-width 100%
- `.ux-state` pattern for empty/error blocks
- Existing empty/loading/error patterns retained

## Accessibility

- `.sr-only` utility
- `#a11y-status` polite live region
- `announceStatus()` + toast dual announcement
- Existing focus-visible, 44px hit targets, safe-area, reduced-motion preserved
- Reader keyboard controller unchanged

## Performance

- Chapter list still gated by `seriesChapterLimit` / Show more
- Reader still uses lazy images + ReaderPageService
- No new full-list eager rendering

## Out of scope

Downloads, social, Phase 2, browser/device verification.
