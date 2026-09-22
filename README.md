# uniblock

A free, open-source ad and tracker blocker for Chrome. Every feature is
included, with no account and nothing to pay.

- **Ads and trackers** blocked with EasyList, EasyPrivacy and the Adblock
  Warning Removal List, downloaded from their authors and compiled on your
  computer
- **Leftover ad space** hidden with styles the page can't override
- **Pop-up ad tabs** closed, and you're put back where you were
- **"Turn off your ad blocker" walls** removed
- **Video ads fast-forwarded** on YouTube and streaming players, behind a
  cover so you don't sit through them
- **Sponsored posts** hidden in social feeds and search results
- **Cookie banners** answered for you: reject all, keep only essential
  cookies, or accept (off until you pick one)
- **Pause on any site** from the toolbar

Website: https://uniblock-web.vercel.app

## Install

uniblock isn't on the Chrome Web Store. Install it from this repo:

1. Download it: **Code → Download ZIP** on GitHub, then unzip it. Or clone it
   with `git clone https://github.com/AhmedA-afk/uniblock.git`.
2. Open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `extension` folder.

On first run it downloads the filter lists and compiles them (about 2 s).
The toolbar button shows what's blocked on the current page, when the lists
last updated, and lets you pause a site. Lists update daily.

To update uniblock, download it again (or `git pull`) and click the reload
icon on its card in `chrome://extensions`.

## Privacy

Blocking happens inside Chrome. uniblock has no server: no page you visit and
nothing about your browsing is sent anywhere. The only network requests it
makes are for the filter lists, straight from their authors.

The one exception is the **experimental Jev feed classifier**, which is off
by default. When you switch it on, the text of feed posts goes to a proxy you
run yourself, and from there to TypeSafe's API with your own key (see below).

## Layout

```
extension/   the Chrome MV3 extension
backend/     jev-proxy: optional local proxy for the experimental Jev classifier
test/        unit tests (node:test) and browser tests (Puppeteer)
scripts/     dev tools
docs/        licensing notes, research notes
```

## Develop

```bash
npm install
npm test                 # unit tests, no network
npm run test:e2e         # real Chrome; downloads the live lists
npm run test:youtube     # also: sponsored, video-ads, cookies, antiadblock, popup
```

`npm run coverage:lists` reports how many EasyList filters uniblock can use;
it reads a local copy of the lists in `reference/easylist` (not committed).

### Experimental: Jev feed classifier

Some ads are written to look like ordinary posts. This mode asks
[TypeSafe](https://typesafe.ai)'s Jev model whether a feed post is an ad,
and it also helps read cookie banners the built-in patterns can't. It needs
your own TypeSafe API key and a local proxy that keeps the key out of the
extension:

```bash
TYPESAFE_API_KEY=... node backend/jev-proxy/server.mjs   # listens on 127.0.0.1:8787
```

Then switch on **Experimental: Jev feed classifier** in the popup. See
[backend/jev-proxy/README.md](backend/jev-proxy/README.md).

## How blocking works

1. **Lists are fetched on the user's machine** from their official URLs,
   never bundled (`extension/lib/lists.js`).
2. **`filter-parser.js`** turns each line into a typed network or cosmetic
   filter, or marks it unsupported with a reason. Filters whose options we
   can't honour (`$redirect`, `$csp`, …) are skipped whole rather than
   applied partially, which would over-block.
3. **`dnr-compiler.js`** turns network filters into `declarativeNetRequest`
   rules. Priorities encode list precedence (block < exception < important).
   Plain `||host^` filters sharing the same conditions are merged into
   `requestDomains` rules: ~109k filters become ~13k rules, under Chrome's
   30k dynamic-rule cap. Exceptions are kept first if the cap is ever hit.
4. **`cosmetic.js`** builds a per-site stylesheet from element-hiding filters.
   The content script asks the background worker, which injects it with
   `insertCSS` at user origin so the page can't override it.

Current coverage of EasyList + EasyPrivacy: 99.5% of filters used. `$popup`
filters (~2.8k) are matched against tabs a page opens (`lib/popup-matcher.js`);
the main remaining gap is procedural selectors like `:has-text()` (~280).

## Contributing

Issues and pull requests are welcome. Run `npm test` before sending a change,
and the browser test for whatever you touched. By contributing, you agree
your work is licensed under the GPL (below).

Good places to start:

- Procedural selectors (`:has-text`, `:upward`) in the content script
- Firefox build (`background.scripts` instead of a service worker)
- Blocked-count check with a real toolbar click (needs `activeTab`, which
  automation can't grant)

## Licence

uniblock is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License, version 3 or (at your option)
any later version. See [LICENSE](LICENSE) and
[docs/LICENSING.md](docs/LICENSING.md).

The filter lists are by their own authors and keep their own licences
(EasyList, EasyPrivacy and the Adblock Warning Removal List: GPLv3 or
CC BY-SA 3.0). uniblock downloads them unmodified; it doesn't redistribute them.
