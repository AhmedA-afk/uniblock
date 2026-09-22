// Parses one line of an Adblock Plus-style filter list into a typed rule.
//
// Written from the public syntax documentation (Adblock Plus, AdGuard), not
// from any other blocker's source. See docs/LICENSING.md.
//
// Returned shapes:
//   { kind: 'network', allow, pattern, regex, matchCase, important,
//     resourceTypes, excludedResourceTypes, thirdParty, initiatorDomains,
//     excludedInitiatorDomains, excludedRequestDomains, requestMethods,
//     excludedRequestMethods, document, all, popup, generichide, elemhide }
//   { kind: 'cosmetic', exception, selector, domains, excludedDomains }
//   { kind: 'comment' } | { kind: 'empty' }
//   { kind: 'unsupported', reason }

const RESOURCE_TYPES = {
  script: 'script',
  image: 'image',
  stylesheet: 'stylesheet',
  css: 'stylesheet',
  object: 'object',
  xmlhttprequest: 'xmlhttprequest',
  xhr: 'xmlhttprequest',
  subdocument: 'sub_frame',
  frame: 'sub_frame',
  ping: 'ping',
  media: 'media',
  font: 'font',
  websocket: 'websocket',
  other: 'other',
};

// Options that change what a request match does, which we cannot express as a
// plain block/allow rule. A filter carrying any of these is skipped whole:
// applying it without the option would block more than the author intended.
const UNSUPPORTED_OPTIONS = new Set([
  'csp', 'redirect', 'redirect-rule', 'rewrite', 'removeparam',
  'queryprune', 'header', 'permissions', 'replace', 'cookie', 'hls', 'jsonprune',
  'urltransform', 'badfilter', 'empty', 'mp4', 'network', 'stealth', 'content',
  'jsinject', 'urlblock', 'extension', 'specifichide', 'genericblock', 'inline-script',
  'inline-font', 'to', 'from', 'strict1p', 'strict3p', 'webrtc', 'sitekey',
  'app', 'referrerpolicy', 'ehide', 'ghide', 'shide', 'uritransform',
]);

const METHODS = new Set(['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put']);

// Selectors using these pseudo-classes need script-driven matching, not CSS.
const PROCEDURAL = /:(?:-abp-[\w-]+|has-text|contains|matches-[\w-]+|min-text-length|others|upward|xpath|remove|remove-attr|remove-class|style|watch-attr|nth-ancestor|if|if-not|shadow|watch-attrs|spath)\(/;

export function parseFilter(raw) {
  const line = raw.trim();
  if (!line) return { kind: 'empty' };
  if (line.startsWith('!') || line.startsWith('[')) return { kind: 'comment' };
  // uBO-style preprocessor directives (!#if, !#include) start with '!' and are
  // caught above; '#' alone at the start is a hosts-file style comment.
  if (line.startsWith('# ') || line === '#') return { kind: 'comment' };

  const cosmetic = parseCosmetic(line);
  if (cosmetic) return cosmetic;
  return parseNetwork(line);
}

// ---------------------------------------------------------------- cosmetic

const COSMETIC_SEPARATOR = /#@?[?$%]?@?#/;

function parseCosmetic(line) {
  const match = COSMETIC_SEPARATOR.exec(line);
  if (!match) return null;
  // A network filter can legitimately contain '#' (e.g. `||x.com/#ad`), but
  // never the '##' family of separators, so the first match decides.
  const sep = match[0];
  const domainPart = line.slice(0, match.index);
  let selector = line.slice(match.index + sep.length).trim();

  if (sep.includes('$') || sep.includes('%')) {
    return { kind: 'unsupported', reason: 'css-or-script-injection' };
  }
  if (selector.startsWith('+js(') || selector.startsWith('^')) {
    return { kind: 'unsupported', reason: 'scriptlet-or-html-filter' };
  }
  if (!selector) return { kind: 'unsupported', reason: 'empty-selector' };
  if (/[{}]/.test(selector) || selector.endsWith('\\')) {
    return { kind: 'unsupported', reason: 'unsafe-selector' };
  }
  if (PROCEDURAL.test(selector)) {
    return { kind: 'unsupported', reason: 'procedural-selector' };
  }

  const { domains, excludedDomains, ok } = parseDomainList(domainPart, ',');
  if (!ok) return { kind: 'unsupported', reason: 'unsupported-domain' };

  return {
    kind: 'cosmetic',
    exception: sep.includes('@'),
    selector,
    domains,
    excludedDomains,
  };
}

// ----------------------------------------------------------------- network

function parseNetwork(line) {
  let body = line;
  let allow = false;
  if (body.startsWith('@@')) {
    allow = true;
    body = body.slice(2);
  }

  const { pattern, options } = splitOptions(body);

  const rule = {
    kind: 'network',
    allow,
    pattern: null,
    regex: null,
    matchCase: false,
    important: false,
    resourceTypes: [],
    excludedResourceTypes: [],
    thirdParty: null,
    initiatorDomains: [],
    excludedInitiatorDomains: [],
    excludedRequestDomains: [],
    requestMethods: [],
    excludedRequestMethods: [],
    document: false,
    all: false,
    popup: false,
    generichide: false,
    elemhide: false,
  };

  for (const rawOption of options) {
    const eq = rawOption.indexOf('=');
    const name = (eq === -1 ? rawOption : rawOption.slice(0, eq)).toLowerCase();
    const value = eq === -1 ? '' : rawOption.slice(eq + 1);
    const negated = name.startsWith('~');
    const key = negated ? name.slice(1) : name;

    if (key in RESOURCE_TYPES) {
      (negated ? rule.excludedResourceTypes : rule.resourceTypes).push(RESOURCE_TYPES[key]);
    } else if (key === 'third-party' || key === '3p') {
      rule.thirdParty = !negated;
    } else if (key === 'first-party' || key === '1p') {
      rule.thirdParty = negated;
    } else if (key === 'match-case') {
      rule.matchCase = !negated;
    } else if (key === 'important') {
      rule.important = true;
    } else if (key === 'document' || key === 'doc') {
      if (negated) return { kind: 'unsupported', reason: 'negated-document' };
      rule.document = true;
    } else if (key === 'popup') {
      // Matched against pop-up tabs, not requests; see lib/popup-matcher.js.
      if (negated) return { kind: 'unsupported', reason: 'negated-popup' };
      rule.popup = true;
    } else if (key === 'generichide') {
      rule.generichide = true;
    } else if (key === 'elemhide') {
      rule.elemhide = true;
    } else if (key === 'all') {
      // Every resource type, including the page itself.
      rule.all = true;
    } else if (key === 'domain') {
      const parsed = parseDomainList(value, '|');
      if (!parsed.ok) return { kind: 'unsupported', reason: 'unsupported-domain' };
      rule.initiatorDomains.push(...parsed.domains);
      rule.excludedInitiatorDomains.push(...parsed.excludedDomains);
    } else if (key === 'denyallow') {
      const parsed = parseDomainList(value, '|');
      if (!parsed.ok || parsed.excludedDomains.length) {
        return { kind: 'unsupported', reason: 'unsupported-domain' };
      }
      rule.excludedRequestDomains.push(...parsed.domains);
    } else if (key === 'method') {
      for (const m of value.toLowerCase().split('|')) {
        const neg = m.startsWith('~');
        const method = neg ? m.slice(1) : m;
        if (!METHODS.has(method)) return { kind: 'unsupported', reason: 'unknown-method' };
        (neg ? rule.excludedRequestMethods : rule.requestMethods).push(method);
      }
    } else if (UNSUPPORTED_OPTIONS.has(key)) {
      return { kind: 'unsupported', reason: `option:${key}` };
    } else {
      return { kind: 'unsupported', reason: `unknown-option:${key}` };
    }
  }

  if (rule.generichide || rule.elemhide) {
    // These only switch off element hiding; they never block or allow requests.
    if (!allow) return { kind: 'unsupported', reason: 'hide-option-on-block' };
  }

  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    rule.regex = pattern.slice(1, -1);
    return rule;
  }

  const normalized = normalizePattern(pattern);
  if (normalized === null) return { kind: 'unsupported', reason: 'bad-pattern' };
  rule.pattern = normalized;
  return rule;
}

// Splits `pattern$opt1,opt2` at the last '$' that is followed by something
// shaped like an option list. A trailing '$' inside a regex (`/ads$/`) is not.
const OPTION_LIST = /^~?[a-z0-9_-]+(=[^,]*)?(,~?[a-z0-9_-]+(=[^,]*)?)*$/i;

function splitOptions(body) {
  const idx = body.lastIndexOf('$');
  if (idx > 0 || (idx === 0 && body.length > 1)) {
    const tail = body.slice(idx + 1);
    if (OPTION_LIST.test(tail)) {
      return { pattern: body.slice(0, idx), options: tail.split(',') };
    }
  }
  return { pattern: body, options: [] };
}

function normalizePattern(pattern) {
  let p = pattern;
  // Hosts-file lines ("0.0.0.0 ads.example.com") are a common list format.
  const hosts = /^(?:0\.0\.0\.0|127\.0\.0\.1)\s+([\w.-]+)$/.exec(p);
  if (hosts) p = `||${hosts[1]}^`;

  if (p.includes('$')) return null; // option split failed; don't guess
  if (/\s/.test(p)) return null;
  // '||*' is not a valid anchor; the wildcard makes the anchor meaningless.
  if (p.startsWith('||*')) p = p.slice(2);
  // Leading and trailing wildcards add nothing to a substring match.
  p = p.replace(/^\*+/, '').replace(/\*+$/, '');
  if (p === '|' || p === '||') p = '';
  return p;
}

// Parses `a.com,~b.com` (cosmetic) or `a.com|~b.com` (network) domain lists.
// Entity wildcards (`example.*`) and regex domains need per-request logic we
// don't have, so a list containing them is reported as not ok.
export function parseDomainList(value, separator) {
  const domains = [];
  const excludedDomains = [];
  if (!value) return { domains, excludedDomains, ok: true };
  for (const rawEntry of value.split(separator)) {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    const negated = entry.startsWith('~');
    const name = negated ? entry.slice(1) : entry;
    if (name.endsWith('.*') || name.startsWith('/') || name.includes('*')) {
      return { domains, excludedDomains, ok: false };
    }
    const host = toAsciiHost(name);
    if (!host) return { domains, excludedDomains, ok: false };
    (negated ? excludedDomains : domains).push(host);
  }
  return { domains, excludedDomains, ok: true };
}

// Converts an internationalised hostname to its punycode form.
export function toAsciiHost(name) {
  if (/^[a-z0-9.-]+$/.test(name)) return name;
  try {
    const host = new URL(`http://${name}/`).hostname;
    return /^[a-z0-9.-]+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}
