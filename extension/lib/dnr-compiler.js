// Compiles parsed network filters into Chrome declarativeNetRequest rules.
// Reference: https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest
//
// Priorities reproduce the filter-list precedence rules:
//   block < exception < important block < important exception
export const PRIORITY = { block: 1, allow: 2, importantBlock: 3, importantAllow: 4 };

const ALL_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport',
  'webbundle', 'other',
];

// Lookarounds and backreferences are not RE2 and are rejected by Chrome.
const NON_RE2 = /\(\?[=!<]|\\[1-9]/;

// Returns { rule } with a DNR rule minus its id, { hide } for an element-hiding
// switch, { popup } for a pop-up-only filter, or { skip: reason }.
export function compileNetworkRule(f) {
  // A $popup filter targets tabs a page opens, which Chrome's request rules
  // can't express. With no other resource type it goes to the pop-up matcher
  // only; with others, those still get a request rule (and the pop-up part is
  // collected by compileNetworkRules).
  if (f.popup && !f.resourceTypes.length && !f.all) return { popup: f };

  if (f.generichide || f.elemhide) {
    const host = anchoredHost(f.pattern);
    if (!host) return { skip: 'hide-switch-not-host' };
    return { hide: { host, type: f.elemhide ? 'elemhide' : 'generichide' } };
  }

  const condition = {};

  if (f.regex !== null) {
    if (NON_RE2.test(f.regex) || !isAscii(f.regex)) return { skip: 'regex-not-re2' };
    condition.regexFilter = f.regex;
  } else if (f.pattern) {
    if (!isAscii(f.pattern)) return { skip: 'non-ascii-pattern' };
    if (!validAnchors(f.pattern)) return { skip: 'bad-anchor' };
    condition.urlFilter = f.matchCase ? f.pattern : f.pattern.toLowerCase();
  }
  if (f.matchCase) condition.isUrlFilterCaseSensitive = true;

  if (!condition.urlFilter && !condition.regexFilter && !f.initiatorDomains.length) {
    return { skip: 'too-broad' };
  }

  if (f.initiatorDomains.length) condition.initiatorDomains = f.initiatorDomains;
  if (f.excludedInitiatorDomains.length) condition.excludedInitiatorDomains = f.excludedInitiatorDomains;
  if (f.excludedRequestDomains.length) condition.excludedRequestDomains = f.excludedRequestDomains;
  if (f.requestMethods.length) condition.requestMethods = f.requestMethods;
  if (f.excludedRequestMethods.length) condition.excludedRequestMethods = f.excludedRequestMethods;
  if (f.thirdParty !== null) condition.domainType = f.thirdParty ? 'thirdParty' : 'firstParty';

  let actionType = f.allow ? 'allow' : 'block';

  if (f.allow && f.document) {
    // A page-level exception switches off blocking for everything the page loads.
    actionType = 'allowAllRequests';
    condition.resourceTypes = ['main_frame', 'sub_frame'];
  } else {
    const excluded = new Set(f.excludedResourceTypes);
    let types = null;
    if (f.all) types = ALL_TYPES;
    else if (f.resourceTypes.length) types = [...new Set(f.resourceTypes)];
    if (f.document && !f.all) types = [...(types ?? []), 'main_frame'];

    if (types) {
      const kept = types.filter((t) => !excluded.has(t));
      if (!kept.length) return { skip: 'no-resource-types' };
      condition.resourceTypes = kept;
    } else if (excluded.size) {
      // Once excludedResourceTypes is set, Chrome stops excluding the page
      // itself by default, so keep main_frame out explicitly.
      condition.excludedResourceTypes = [...excluded, 'main_frame'];
    }
  }

  const priority = f.allow
    ? (f.important ? PRIORITY.importantAllow : PRIORITY.allow)
    : (f.important ? PRIORITY.importantBlock : PRIORITY.block);

  return { rule: { priority, action: { type: actionType }, condition } };
}

// Compiles a whole parsed list. Exceptions go first so that, if we hit Chrome's
// rule cap, we drop blocking rules rather than the rules that prevent breakage.
export function compileNetworkRules(filters, { maxRules = Infinity, maxRegexRules = 1000 } = {}) {
  const allowRules = [];
  const blockRules = [];
  const hideSwitches = [];
  const popupFilters = [];
  const skipped = {};
  const seen = new Set();

  for (const f of filters) {
    if (f.popup) popupFilters.push(f);
    const out = compileNetworkRule(f);
    if (out.popup) continue;
    if (out.skip) {
      skipped[out.skip] = (skipped[out.skip] ?? 0) + 1;
      continue;
    }
    if (out.hide) {
      hideSwitches.push(out.hide);
      continue;
    }
    const key = JSON.stringify(out.rule);
    if (seen.has(key)) {
      skipped.duplicate = (skipped.duplicate ?? 0) + 1;
      continue;
    }
    seen.add(key);
    (out.rule.action.type === 'block' ? blockRules : allowRules).push(out.rule);
  }

  const rules = [];
  const merged = [...mergeHostRules(allowRules), ...mergeHostRules(blockRules)];
  let regexCount = 0;
  let overCap = 0;
  for (const rule of merged) {
    if (rule.condition.regexFilter) {
      if (regexCount >= maxRegexRules) {
        overCap++;
        continue;
      }
      regexCount++;
    }
    if (rules.length >= maxRules) {
      overCap++;
      continue;
    }
    rules.push(rule);
  }
  if (overCap) skipped['over-cap'] = overCap;

  return { rules, hideSwitches, popupFilters, skipped };
}

// Most list entries are `||host^`: "any request to this host or its
// subdomains". That is exactly what a `requestDomains` condition matches, so
// host-only rules that share every other condition collapse into one rule.
// Chunked so no single rule gets unreasonably large.
const HOST_ONLY = /^\|\|([a-z0-9.-]+)\^$/;
const HOSTS_PER_RULE = 1000;

function mergeHostRules(rules) {
  const groups = new Map();
  const rest = [];
  for (const rule of rules) {
    const m = HOST_ONLY.exec(rule.condition.urlFilter ?? '');
    if (!m || rule.condition.isUrlFilterCaseSensitive) {
      rest.push(rule);
      continue;
    }
    const { urlFilter, ...condition } = rule.condition;
    const key = JSON.stringify([rule.priority, rule.action, condition]);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { rule: { ...rule, condition }, hosts: new Set() }));
    group.hosts.add(m[1]);
  }

  const out = [];
  for (const { rule, hosts } of groups.values()) {
    const list = [...hosts];
    if (list.length === 1) {
      out.push({ ...rule, condition: { urlFilter: `||${list[0]}^`, ...rule.condition } });
      continue;
    }
    for (let i = 0; i < list.length; i += HOSTS_PER_RULE) {
      out.push({ ...rule, condition: { requestDomains: list.slice(i, i + HOSTS_PER_RULE), ...rule.condition } });
    }
  }
  return [...out, ...rest];
}

function isAscii(s) {
  return /^[\x20-\x7e]*$/.test(s);
}

// Chrome only accepts '||' or '|' at the start and '|' at the end.
function validAnchors(p) {
  const inner = p.replace(/^\|\|?/, '').replace(/\|$/, '');
  return !inner.includes('|') && inner.length > 0;
}

// `||example.com^` or `||example.com` → example.com
function anchoredHost(pattern) {
  const m = /^\|\|([a-z0-9.-]+)\^?$/i.exec(pattern ?? '');
  return m ? m[1].toLowerCase() : null;
}
