# Licensing

uniblock is licensed under the **GNU General Public License v3.0 or later**
([LICENSE](../LICENSE)). Anyone may use, study, change and share it; anyone
who distributes it, changed or not, must do so under the same licence and
with its source.

This is working policy, not legal advice.

## Code from other projects

GPLv3 lets us reuse code from GPL-compatible projects, including uBlock
Origin (GPLv3). When we do:

- Keep the original copyright notice and say where the code came from, in a
  comment at the top of the file or the copied block.
- Only take code under GPL-compatible licences (GPLv3, LGPL, MIT, BSD,
  Apache-2.0, ISC, MPL-2.0 and similar). No GPLv2-only code, and nothing
  without a licence.
- Third-party npm dependencies must be GPL-compatible too.

`reference/` (gitignored) holds local copies of third-party sources for
study. It stays out of the repo so this one only carries our code and what
we've deliberately brought in with credit.

## Filter lists

- **Community lists are downloaded at runtime, not bundled.** The extension
  fetches EasyList and the others from their official URLs on the user's
  machine, uses them unmodified, and credits each one in the popup, with its
  licence and homepage.
- **`extension/filters/uniblock.txt`** is our own small list and ships under
  our licence. Entries in it are written by us, not copied from other lists.
  If an entry ever comes from another list, it must be compatible
  (EasyList: GPLv3 or CC BY-SA 3.0) and credited.

## Contributions

Contributions are accepted under the same licence, GPLv3 or later. There is
no separate contributor agreement.
