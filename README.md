# uniblock

Ad and tracker blocker. Proprietary — see [docs/LICENSING.md](docs/LICENSING.md)
before reading or reusing anything from `reference/`.

```
extension/   Chrome MV3 extension (the product users install)
backend/     accounts, licensing, the uniblock list, Jev pipeline (not started)
test/        unit tests (node:test) and a browser end-to-end test
scripts/     dev tools
reference/   third-party GPL sources, study only, gitignored
```

## Run it

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → pick `extension/`.
2. On first install it downloads EasyList and EasyPrivacy and compiles them
   (about 2 s). The popup shows list status and lets you pause a site.

## Test

```bash
npm test            # unit tests, no network
npm run test:e2e    # real browser; downloads the live lists
npm run coverage:lists   # how much of reference/easylist we can use, and why not the rest
```

## How blocking works

1. **Lists are fetched on the user's machine** from their official URLs, never
   bundled (`extension/lib/lists.js`).
2. **`filter-parser.js`** turns each line into a typed network or cosmetic
   filter, or marks it unsupported with a reason. Filters whose options we
   can't honour (`$popup`, `$redirect`, `$csp`, …) are skipped whole rather than
   applied partially, which would over-block.
3. **`dnr-compiler.js`** turns network filters into `declarativeNetRequest`
   rules. Priorities encode list precedence (block < exception < important).
   Plain `||host^` filters sharing the same conditions are merged into
   `requestDomains` rules: ~109k filters become ~12.8k rules, under Chrome's
   30k dynamic-rule cap. Exceptions are kept first if the cap is ever hit.
4. **`cosmetic.js`** builds a per-site stylesheet from element-hiding filters.
   The content script asks the background worker, which injects it with
   `insertCSS` at user origin so the page can't override it.

Current coverage of EasyList + EasyPrivacy: 99.5% of filters used. `$popup`
filters (~2.8k) are matched against tabs a page opens (`lib/popup-matcher.js`);
the main remaining gap is procedural selectors like `:has-text()` (~280).

## Next

- Blocked-count check with a real toolbar click (needs `activeTab`, which
  automation can't grant)
- Procedural selectors (`:has-text`, `:upward`) in the content script
- Firefox build (`background.scripts` instead of a service worker)
- Backend: accounts + licensing, then the uniblock list and the Jev pipeline
