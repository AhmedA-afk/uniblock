// Element hiding: builds the per-site stylesheet that hides ad containers the
// network rules can't stop (ads served from the site's own domain, leftover
// placeholders, and so on).

const HIDE = '{display:none!important}';

// Folds parsed cosmetic filters and hide switches into a plain, JSON-safe index
// that can be persisted to storage and loaded back into a CosmeticEngine.
export function compileCosmetic(filters, hideSwitches = []) {
  const generic = new Set();
  const genericExcluded = {};
  const specific = {};
  const exceptions = {};
  const globalExceptions = new Set();
  const switches = {};

  const add = (map, host, selector) => {
    (map[host] ??= new Set()).add(selector);
  };

  for (const f of filters) {
    if (f.exception) {
      if (!f.domains.length) globalExceptions.add(f.selector);
      for (const host of f.domains) add(exceptions, host, f.selector);
      continue;
    }
    if (f.domains.length) {
      for (const host of f.domains) add(specific, host, f.selector);
      // `a.com,~sub.a.com##.x` — hide on a.com except that one subdomain.
      for (const host of f.excludedDomains) add(exceptions, host, f.selector);
    } else {
      generic.add(f.selector);
      for (const host of f.excludedDomains) add(genericExcluded, host, f.selector);
    }
  }

  for (const { host, type } of hideSwitches) {
    // elemhide is the stronger switch; never downgrade it.
    if (switches[host] !== 'elemhide') switches[host] = type;
  }

  const toArrays = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, [...v]]));
  return {
    generic: [...generic],
    genericExcluded: toArrays(genericExcluded),
    specific: toArrays(specific),
    exceptions: toArrays(exceptions),
    globalExceptions: [...globalExceptions],
    switches,
  };
}

export class CosmeticEngine {
  constructor(index) {
    this.index = index;
    this.generic = new Set(index.generic);
    this.globalExceptions = new Set(index.globalExceptions);
    // The generic sheet is the same for almost every site, so build it once.
    this.genericCss = toCss(index.generic.filter((s) => !this.globalExceptions.has(s)));
  }

  // Returns the stylesheet to inject into a page on `hostname`.
  cssFor(hostname) {
    const suffixes = hostSuffixes(hostname);
    const { specific, exceptions, genericExcluded, switches } = this.index;

    let generichide = false;
    for (const host of suffixes) {
      if (switches[host] === 'elemhide') return '';
      if (switches[host] === 'generichide') generichide = true;
    }

    const blocked = new Set(this.globalExceptions);
    for (const host of suffixes) {
      for (const s of exceptions[host] ?? []) blocked.add(s);
      for (const s of genericExcluded[host] ?? []) blocked.add(s);
    }

    const own = [];
    for (const host of suffixes) {
      for (const s of specific[host] ?? []) if (!blocked.has(s)) own.push(s);
    }
    const ownCss = toCss(own);
    if (generichide) return ownCss;

    // Rebuild the generic sheet only for the rare site that opts out of part of it.
    let genericCss = this.genericCss;
    let touchesGeneric = false;
    for (const s of blocked) {
      if (this.generic.has(s) && !this.globalExceptions.has(s)) {
        touchesGeneric = true;
        break;
      }
    }
    if (touchesGeneric) genericCss = toCss(this.index.generic.filter((s) => !blocked.has(s)));

    return genericCss + ownCss;
  }
}

// www.news.example.com → [www.news.example.com, news.example.com, example.com, com]
export function hostSuffixes(hostname) {
  const out = [];
  let h = hostname.toLowerCase().replace(/\.$/, '');
  while (h) {
    out.push(h);
    const dot = h.indexOf('.');
    if (dot === -1) break;
    h = h.slice(dot + 1);
  }
  return out;
}

// One rule per selector: a single invalid selector in a grouped rule would
// silently disable every other selector in that group.
function toCss(selectors) {
  let css = '';
  for (const s of selectors) css += s + HIDE + '\n';
  return css;
}
