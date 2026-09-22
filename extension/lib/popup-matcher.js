// Matches pop-up tabs against $popup filters: "if a page opens a new tab to
// this address, close it". Chrome's request rules can't express that, so the
// background worker checks each tab another tab opened (lib/../background.js).
//
// Filters use the list syntax: ||host^, |, ^, *, plus domain= (the opener's
// site), third-party and exceptions (@@). Plain ||host^ filters, almost all of
// them, are a hostname lookup; the rest become regular expressions.

const HOST_ONLY = /^\|\|([a-z0-9.-]+)\^?$/;

// ABP pattern → regex source.
export function patternToRegex(pattern) {
  let p = pattern;
  let prefix = '';
  let suffix = '';
  if (p.startsWith('||')) {
    prefix = '^[a-z][a-z0-9+.-]*://([^/?#]*\\.)?';
    p = p.slice(2);
  } else if (p.startsWith('|')) {
    prefix = '^';
    p = p.slice(1);
  }
  if (p.endsWith('|')) {
    suffix = '$';
    p = p.slice(0, -1);
  }
  const body = p
    .replace(/[.+?${}()[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\^/g, '(?:[^a-zA-Z0-9_.%-]|$)');
  return prefix + body + suffix;
}

// Parsed $popup filters → a JSON-safe index for storage.
export function compilePopupFilters(filters) {
  const index = { blockHosts: [], allowHosts: [], rules: [] };
  for (const f of filters) {
    if (!f.popup) continue;
    const scoped = f.initiatorDomains.length || f.excludedInitiatorDomains.length || f.thirdParty !== null;
    const host = f.pattern && HOST_ONLY.exec(f.pattern)?.[1];
    if (host && !scoped && !f.matchCase) {
      (f.allow ? index.allowHosts : index.blockHosts).push(host);
      continue;
    }
    const source = f.regex ?? (f.pattern ? patternToRegex(f.pattern) : null);
    if (source === null && !f.initiatorDomains.length) continue; // would match every pop-up
    index.rules.push({
      allow: f.allow,
      source: source ?? '',
      flags: f.matchCase ? '' : 'i',
      domains: f.initiatorDomains,
      excludedDomains: f.excludedInitiatorDomains,
      thirdParty: f.thirdParty,
    });
  }
  return index;
}

// Hostname and its parent domains: a.b.example.com → [a.b.example.com, b.example.com, example.com, com]
function suffixes(host) {
  const out = [];
  for (let h = host; h; h = h.slice(h.indexOf('.') + 1)) {
    out.push(h);
    if (!h.includes('.')) break;
  }
  return out;
}

// Approximate "same site": last two labels. Wrong for two-part suffixes
// (example.co.uk); good enough for the few filters that use third-party.
const siteOf = (host) => host.split('.').slice(-2).join('.');

export class PopupMatcher {
  constructor(index) {
    this.blockHosts = new Set(index.blockHosts);
    this.allowHosts = new Set(index.allowHosts);
    this.rules = index.rules.map((r) => {
      try {
        return { ...r, re: new RegExp(r.source, r.flags) };
      } catch {
        return null;
      }
    }).filter(Boolean);
  }

  // 'block' | 'allow' | null for a pop-up to `url` opened by a page at `openerUrl`.
  match(url, openerUrl) {
    let target;
    let opener;
    try {
      target = new URL(url);
      opener = openerUrl ? new URL(openerUrl) : null;
    } catch {
      return null;
    }
    if (!/^https?:$/.test(target.protocol)) return null;
    const hosts = suffixes(target.hostname);
    const openerHosts = opener ? suffixes(opener.hostname) : [];

    let block = hosts.some((h) => this.blockHosts.has(h));
    let allow = hosts.some((h) => this.allowHosts.has(h));
    for (const r of this.rules) {
      if ((r.allow ? allow : block) || !this.applies(r, target, opener, openerHosts)) continue;
      if (r.allow) allow = true;
      else block = true;
    }
    if (allow) return 'allow';
    return block ? 'block' : null;
  }

  applies(r, target, opener, openerHosts) {
    if (r.domains.length && !openerHosts.some((h) => r.domains.includes(h))) return false;
    if (r.excludedDomains.length && openerHosts.some((h) => r.excludedDomains.includes(h))) return false;
    if (r.thirdParty !== null && opener) {
      const third = siteOf(target.hostname) !== siteOf(opener.hostname);
      if (third !== r.thirdParty) return false;
    }
    return r.source === '' || r.re.test(target.href);
  }
}
