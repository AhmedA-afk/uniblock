# Licensing rules for uniblock

uniblock is proprietary. The projects we learn from are not:

| Source | Licence | What it means for us |
|---|---|---|
| uBlock Origin (`reference/uBlock`) | GPLv3 | Copying any of its code makes uniblock GPLv3. Study only. |
| EasyList / EasyPrivacy (`reference/easylist`) | GPLv3 or CC BY-SA 3.0 | We may *use* the published lists; we may not fold them into our own list and keep it closed. |
| uBlock filters, uBO Lite rulesets | GPLv3 | Same as EasyList. |

Copyright protects code and text, not ideas, algorithms or file formats. We are
free to learn *how* an ad blocker works and build our own. We are not free to
copy, translate or closely paraphrase *their* implementation.

This is working policy, not legal advice. Have a lawyer review it before the
first paid release.

## 1. Code

- `reference/` is gitignored and must never be committed, bundled or shipped.
- Nothing from `reference/` is copied, ported, translated to another language,
  or rewritten line by line. That includes regexes, data tables, comments and
  test fixtures.
- **Specs come from public documentation, not from their source.** Filter syntax
  is a public format; implement it from:
  - Adblock Plus filter docs — https://help.adblockplus.org/hc/en-us/articles/360062733293
  - AdGuard filter syntax — https://adguard.com/kb/general/ad-filtering/create-own-filters/
  - uBO's wiki (documentation, not code) — https://github.com/gorhill/uBlock/wiki
  - Chrome `declarativeNetRequest` docs — https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest
- Reading uBO's source to understand an approach is fine. When you do, write down
  the *idea* in `docs/notes/` in your own words, then close the source before
  writing our implementation. Don't have their file open while writing ours.
- The same rule applies to AI assistants: don't paste uBO source into a prompt
  that is also generating uniblock code.
- Third-party dependencies must be MIT, BSD, Apache-2.0, ISC or similar
  permissive licences. No GPL, LGPL or AGPL packages in the shipped extension.

## 2. Filter lists

- **Community lists are fetched at runtime, not bundled.** The extension downloads
  EasyList etc. from their official URLs on the user's machine, and shows each
  list's name, licence and homepage in the settings page. We don't edit them.
- **The uniblock list is ours only if it is built independently.** Its entries
  come from our own sources: user reports, our AI classifier, our own review.
  Never seed it by copying EasyList, never merge EasyList entries into it, and
  never publish a "combined" list — that combination is a derivative work.
- Keep a provenance record for every entry in our list (source, date, how it was
  found). This is the evidence that the list is original if it is ever questioned.
- Do not train or evaluate our classifier on EasyList rules as labels until this
  has been checked with a lawyer. Label our own data instead.

## 3. What we can sell

The proprietary, paid parts are the things we build ourselves:

- the extension code (blocking engine, element hiding, UI)
- the uniblock filter list and its update service
- the AI classifier and the pipeline that grows the list
- ad fast-forward, tracker blocking, cookie cleaning

The free community lists stay free and credited. Users get them either way.
