import { parseFilter } from './lib/filter-parser.js';
import { compileNetworkRules } from './lib/dnr-compiler.js';
import { compileCosmetic, CosmeticEngine, hostSuffixes } from './lib/cosmetic.js';
import { COMMUNITY_LISTS, downloadList } from './lib/lists.js';
import { collectSnapshot, collectCookieInfo } from './lib/debug-snapshot.js';
import { compilePopupFilters, PopupMatcher } from './lib/popup-matcher.js';

const dnr = chrome.declarativeNetRequest;

// Dynamic rule ids: 1 is the "paused sites" rule, list rules start at 1000.
const PAUSED_RULE_ID = 1;
const LIST_RULE_BASE = 1000;
const PAUSED_PRIORITY = 100; // above every list priority
const UPDATE_ALARM = 'update-lists';
const UPDATE_PERIOD_MINUTES = 24 * 60;

let engine = null;
let popups = null;
let pausedHosts = null;

// ------------------------------------------------------------------ state

async function getEngine() {
  if (!engine) {
    const { cosmetic } = await chrome.storage.local.get('cosmetic');
    if (cosmetic) engine = new CosmeticEngine(cosmetic);
  }
  return engine;
}

async function getPopupMatcher() {
  if (!popups) {
    const { popupIndex } = await chrome.storage.local.get('popupIndex');
    if (popupIndex) popups = new PopupMatcher(popupIndex);
  }
  return popups;
}

async function getPaused() {
  if (!pausedHosts) {
    const { paused = [] } = await chrome.storage.local.get('paused');
    pausedHosts = new Set(paused);
  }
  return pausedHosts;
}

function isPaused(paused, hostname) {
  return hostSuffixes(hostname).some((h) => paused.has(h));
}

// ---------------------------------------------------------- list updates

let updating = null;

// Downloads every list, then recompiles from whatever copies we have. A list
// that fails to download keeps its previous copy rather than disappearing.
function updateLists() {
  updating ??= (async () => {
    const { listText = {}, listStatus = {} } = await chrome.storage.local.get(['listText', 'listStatus']);
    for (const list of COMMUNITY_LISTS) {
      try {
        listText[list.id] = await downloadList(list);
        listStatus[list.id] = { updatedAt: Date.now(), error: null };
      } catch (err) {
        listStatus[list.id] = { ...listStatus[list.id], error: err.message };
      }
    }
    await chrome.storage.local.set({ listText, listStatus });
    await compileAndApply(listText);
  })().finally(() => {
    updating = null;
  });
  return updating;
}

// Our own list ships inside the extension; community lists are downloaded.
async function builtinList() {
  return (await fetch(chrome.runtime.getURL('filters/uniblock.txt'))).text();
}

async function compileAndApply(listText) {
  const network = [];
  const cosmetic = [];
  let unsupported = 0;
  for (const text of [await builtinList(), ...Object.values(listText)]) {
    for (const line of text.split('\n')) {
      const f = parseFilter(line);
      if (f.kind === 'network') network.push(f);
      else if (f.kind === 'cosmetic') cosmetic.push(f);
      else if (f.kind === 'unsupported') unsupported++;
    }
  }

  const maxRules = (dnr.MAX_NUMBER_OF_DYNAMIC_RULES ?? 5000) - LIST_RULE_BASE;
  const maxRegexRules = dnr.MAX_NUMBER_OF_REGEX_RULES ?? 1000;
  const compiled = compileNetworkRules(network, { maxRules, maxRegexRules });

  // Chrome accepts a smaller regex dialect than the lists are written in.
  const rules = [];
  for (const rule of compiled.rules) {
    if (rule.condition.regexFilter) {
      const { isSupported } = await dnr.isRegexSupported({
        regex: rule.condition.regexFilter,
        isCaseSensitive: !!rule.condition.isUrlFilterCaseSensitive,
      });
      if (!isSupported) continue;
    }
    rules.push(rule);
  }

  const applied = await replaceListRules(rules);

  const index = compileCosmetic(cosmetic, compiled.hideSwitches);
  engine = new CosmeticEngine(index);
  const popupIndex = compilePopupFilters(compiled.popupFilters);
  popups = new PopupMatcher(popupIndex);
  await chrome.storage.local.set({
    cosmetic: index,
    popupIndex,
    stats: {
      compiledAt: Date.now(),
      networkRules: applied,
      popupFilters: compiled.popupFilters.length,
      cosmeticFilters: cosmetic.length,
      unsupported,
      skipped: compiled.skipped,
    },
  });
}

// Chrome rejects the whole batch if any single rule is invalid. When that
// happens, drop the rule it names and try again rather than applying nothing.
async function replaceListRules(rules) {
  const existing = await dnr.getDynamicRules();
  const removeRuleIds = existing.filter((r) => r.id >= LIST_RULE_BASE).map((r) => r.id);
  let candidates = rules.map((rule, i) => ({ id: LIST_RULE_BASE + i, ...rule }));

  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await dnr.updateDynamicRules({ removeRuleIds, addRules: candidates });
      return candidates.length;
    } catch (err) {
      const id = Number(/id (\d+)/i.exec(err.message)?.[1]);
      if (!id) throw err;
      console.warn('uniblock: dropping rule Chrome rejected', id, err.message);
      candidates = candidates.filter((r) => r.id !== id);
    }
  }
  throw new Error('too many invalid rules');
}

// --------------------------------------------------- YouTube page script

// sites/youtube-main.js has to run in the page's own JS world, which can't
// read extension storage. So instead of checking the pause itself, it is
// registered only while YouTube isn't paused. Same pages as sites/youtube.js.
const YOUTUBE_MAIN_ID = 'youtube-main';
const COOKIE_HIDE_ID = 'cookie-hide';

// Keeps known consent banners from being painted while a cookie mode is on.
async function syncCookieHiding() {
  const { cookieMode = 'off' } = await chrome.storage.local.get('cookieMode');
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [COOKIE_HIDE_ID] });
  if (cookieMode === 'off' && registered.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [COOKIE_HIDE_ID] });
  } else if (cookieMode !== 'off' && !registered.length) {
    await chrome.scripting.registerContentScripts([{
      id: COOKIE_HIDE_ID,
      matches: ['http://*/*', 'https://*/*'],
      css: ['sites/cookie-hide.css'],
      runAt: 'document_start',
      allFrames: true,
    }]);
  }
}

async function syncYouTubeMainScript() {
  const { matches } = chrome.runtime.getManifest().content_scripts
    .find((c) => c.js.includes('sites/youtube.js'));
  const off = isPaused(await getPaused(), 'www.youtube.com');
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [YOUTUBE_MAIN_ID] });
  if (off && registered.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [YOUTUBE_MAIN_ID] });
  } else if (!off && !registered.length) {
    await chrome.scripting.registerContentScripts([{
      id: YOUTUBE_MAIN_ID,
      matches,
      js: ['sites/youtube-main.js'],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true,
    }]);
  }
}

// ------------------------------------------------------------ paused sites

async function setPaused(hostname, paused) {
  const hosts = await getPaused();
  if (paused) hosts.add(hostname);
  else hosts.delete(hostname);
  await chrome.storage.local.set({ paused: [...hosts] });

  const addRules = hosts.size
    ? [{
        id: PAUSED_RULE_ID,
        priority: PAUSED_PRIORITY,
        action: { type: 'allowAllRequests' },
        condition: { requestDomains: [...hosts], resourceTypes: ['main_frame', 'sub_frame'] },
      }]
    : [];
  await dnr.updateDynamicRules({ removeRuleIds: [PAUSED_RULE_ID], addRules });
  await syncYouTubeMainScript();
}

// ----------------------------------------------------------------- pop-ups

// Tabs opened by another tab are checked against the $popup filters. Tabs the
// user opens themselves have no opener and are never touched. No extra
// permission: host access to all sites already exposes a new tab's URL.
const POPUP_WATCH_MS = 3000;

async function checkPopup(tabId, url, openerTabId) {
  const matcher = await getPopupMatcher();
  if (!matcher || !url) return false;
  const opener = await chrome.tabs.get(openerTabId).catch(() => null);
  if (!opener?.url || !/^https?:/.test(opener.url)) return false;
  if (isPaused(await getPaused(), new URL(opener.url).hostname)) return false;
  if (matcher.match(url, opener.url) !== 'block') return false;
  const popup = await chrome.tabs.get(tabId).catch(() => null);
  await chrome.tabs.remove(tabId).catch(() => {});
  // Put the viewer back where they were.
  if (popup?.active) await chrome.tabs.update(openerTabId, { active: true }).catch(() => {});
  const { popupsBlocked = 0 } = await chrome.storage.local.get('popupsBlocked');
  await chrome.storage.local.set({ popupsBlocked: popupsBlocked + 1 });
  return true;
}

// A pop-up often starts as about:blank and navigates a moment later, so keep
// watching each new opened tab briefly.
const watching = new Map(); // tabId → { openerTabId, until }

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId === undefined) return;
  const url = tab.pendingUrl || tab.url;
  watching.set(tab.id, { openerTabId: tab.openerTabId, until: Date.now() + POPUP_WATCH_MS });
  if (url && !url.startsWith('about:')) {
    checkPopup(tab.id, url, tab.openerTabId).then((closed) => closed && watching.delete(tab.id));
  }
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  const w = watching.get(tabId);
  if (!w || !change.url) return;
  if (Date.now() > w.until) {
    watching.delete(tabId);
    return;
  }
  checkPopup(tabId, change.url, w.openerTabId).then((closed) => closed && watching.delete(tabId));
});

chrome.tabs.onRemoved.addListener((tabId) => watching.delete(tabId));

// --------------------------------------------------------------- messages

async function injectCosmetic(sender) {
  const { tab, frameId, url } = sender;
  if (!tab || !url?.startsWith('http')) return;
  const hostname = new URL(url).hostname;
  if (isPaused(await getPaused(), hostname)) return;
  const css = (await getEngine())?.cssFor(hostname);
  if (!css) return;
  await chrome.scripting.insertCSS({
    target: { tabId: tab.id, frameIds: [frameId] },
    css,
    origin: 'USER', // user-origin !important can't be overridden by the page
  });
}

async function popupState(hostname) {
  const [{ listStatus = {}, stats = null, videoAdsStopped = 0, jevEnabled = false, jevStats = null, sponsoredHidden = 0, wallsRemoved = 0, adSecondsSaved = 0, popupsBlocked = 0, cookieMode = 'off', cookiesHandled = 0 }, paused] = await Promise.all([
    chrome.storage.local.get(['listStatus', 'stats', 'videoAdsStopped', 'jevEnabled', 'jevStats', 'sponsoredHidden', 'wallsRemoved', 'adSecondsSaved', 'popupsBlocked', 'cookieMode', 'cookiesHandled']),
    getPaused(),
  ]);
  return {
    paused: hostname ? isPaused(paused, hostname) : false,
    pausedByParent: hostname ? isPaused(paused, hostname) && !paused.has(hostname) : false,
    updating: !!updating,
    stats,
    videoAdsStopped,
    sponsoredHidden,
    wallsRemoved,
    adSecondsSaved,
    popupsBlocked,
    cookieMode,
    cookiesHandled,
    jev: { enabled: jevEnabled, stats: jevStats, proxyUp: await jevProxyUp() },
    lists: COMMUNITY_LISTS.map(({ id, name, homepage, license }) => ({
      id, name, homepage, license, ...listStatus[id],
    })),
  };
}

async function countVideoAdStopped() {
  const { videoAdsStopped = 0 } = await chrome.storage.local.get('videoAdsStopped');
  await chrome.storage.local.set({ videoAdsStopped: videoAdsStopped + 1 });
}

// ------------------------------------------ experimental: Jev classifier

// Local prototype proxy that holds the TypeSafe key (backend/jev-proxy).
const JEV_PROXY = 'http://127.0.0.1:8787/classify';

async function jevClassify(posts) {
  const res = await fetch(JEV_PROXY, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ posts }),
  });
  if (!res.ok) throw new Error(`jev-proxy ${res.status}`);
  const { results } = await res.json();
  const hidden = results.filter((r) => r.verdict && r.verdict !== 'content').length;
  const { jevStats = { classified: 0, hidden: 0, shownByUser: 0 } } = await chrome.storage.local.get('jevStats');
  jevStats.classified += results.length;
  jevStats.hidden += hidden;
  await chrome.storage.local.set({ jevStats });
  return results;
}

async function jevFeedback() {
  const { jevStats = { classified: 0, hidden: 0, shownByUser: 0 } } = await chrome.storage.local.get('jevStats');
  jevStats.shownByUser += 1;
  await chrome.storage.local.set({ jevStats });
}

async function jevProxyUp() {
  try {
    return (await fetch(JEV_PROXY.replace('/classify', '/health'))).ok;
  } catch {
    return false;
  }
}

async function countSponsoredHidden() {
  const { sponsoredHidden = 0 } = await chrome.storage.local.get('sponsoredHidden');
  await chrome.storage.local.set({ sponsoredHidden: sponsoredHidden + 1 });
}

// Dev tool: capture the active tab's structure and save it via the local proxy.
async function debugSnapshot(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: collectSnapshot });
  const frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: collectCookieInfo }).catch((e) => [{ result: { error: e.message } }]);
  result.cookies = frames.map((f) => f.result);
  const { cookieMode = 'off' } = await chrome.storage.local.get('cookieMode');
  result.cookieMode = cookieMode;
  // What the user actually sees: markup can be scrambled, pixels can't.
  const tab = await chrome.tabs.get(tabId);
  result.screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }).catch((e) => `failed: ${e.message}`);
  const res = await fetch(JEV_PROXY.replace('/classify', '/debug'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(result),
  });
  if (!res.ok) throw new Error(`jev-proxy ${res.status}`);
  return (await res.json()).saved;
}

async function countWallRemoved() {
  const { wallsRemoved = 0 } = await chrome.storage.local.get('wallsRemoved');
  await chrome.storage.local.set({ wallsRemoved: wallsRemoved + 1 });
}

async function addAdTimeSaved(seconds) {
  if (!(seconds > 0 && seconds < 3600)) return;
  const { adSecondsSaved = 0 } = await chrome.storage.local.get('adSecondsSaved');
  await chrome.storage.local.set({ adSecondsSaved: adSecondsSaved + seconds });
}

// ------------------------------------------------------- cookie banners

// Jev answers for banners the local patterns can't read, cached per site and
// banner (a site's banner rarely changes), so each costs at most one call.
async function cookieAsk(kind, host, payload) {
  const key = `cookieJev:${kind}:${host}:${JSON.stringify(payload).slice(0, 400)}`;
  const usefulAnswer = (r) => (Array.isArray(r) ? r.length > 0 : Object.values(r ?? {}).some((v) => v !== null));
  const cached = (await chrome.storage.local.get(key))[key];
  if (cached && usefulAnswer(cached)) return cached;
  if (!(await jevProxyUp())) return null;
  const res = await fetch(JEV_PROXY.replace('/classify', `/cookie/${kind}`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) return null;
  const { result } = await res.json();
  // Cache only answers that found something; an empty answer might come from
  // reading the wrong element, and shouldn't stick for the site.
  if (usefulAnswer(result)) await chrome.storage.local.set({ [key]: result });
  return result;
}

async function countCookieHandled() {
  const { cookiesHandled = 0 } = await chrome.storage.local.get('cookiesHandled');
  await chrome.storage.local.set({ cookiesHandled: cookiesHandled + 1 });
}

const handlers = {
  cookieAsk: (msg) => cookieAsk('buttons', msg.host, { heading: msg.heading, buttons: msg.buttons }),
  cookieToggles: (msg) => cookieAsk('toggles', msg.host, { toggles: msg.toggles }),
  cookieHandled: () => countCookieHandled(),
  cookiePayOrOk: () => undefined, // reserved: surface "this site asks you to pay to refuse" in the popup
  setCookieMode: async (msg) => {
    await chrome.storage.local.set({ cookieMode: msg.mode });
    await syncCookieHiding();
  },
  adTimeSaved: (msg) => addAdTimeSaved(Number(msg.seconds)),
  wallRemoved: () => countWallRemoved(),
  debugSnapshot: (msg) => debugSnapshot(msg.tabId),
  sponsoredHidden: () => countSponsoredHidden(),
  jevClassify: (msg) => jevClassify(msg.posts),
  jevFeedback: () => jevFeedback(),
  setJev: (msg) => chrome.storage.local.set({ jevEnabled: !!msg.enabled }),
  videoAdStopped: () => countVideoAdStopped(),
  cosmetic: (_msg, sender) => injectCosmetic(sender),
  state: (msg) => popupState(msg.hostname),
  setPaused: (msg) => setPaused(msg.hostname, msg.paused),
  update: () => updateLists(),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve(handler(msg, sender))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => {
      console.error('uniblock:', msg.type, err);
      sendResponse({ ok: false, error: err.message });
    });
  return true; // keep the channel open for the async reply
});

// -------------------------------------------------------------- lifecycle

// Chrome only injects content scripts into pages loaded after install, so
// after an install or update, pages that were already open get them now.
async function injectIntoOpenTabs() {
  for (const script of chrome.runtime.getManifest().content_scripts) {
    const tabs = await chrome.tabs.query({ url: script.matches });
    for (const tab of tabs) {
      chrome.scripting
        .executeScript({ target: { tabId: tab.id, allFrames: !!script.all_frames }, files: script.js })
        .catch(() => {}); // discarded or restricted tabs
    }
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  dnr.setExtensionActionOptions({ displayActionCountAsBadgeText: true });
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: UPDATE_PERIOD_MINUTES });
  await syncYouTubeMainScript();
  await syncCookieHiding();
  await updateLists();
  await injectIntoOpenTabs();
});

chrome.runtime.onStartup.addListener(async () => {
  dnr.setExtensionActionOptions({ displayActionCountAsBadgeText: true });
  await syncYouTubeMainScript();
  await syncCookieHiding();
  const { stats } = await chrome.storage.local.get('stats');
  if (!stats || Date.now() - stats.compiledAt > UPDATE_PERIOD_MINUTES * 60_000) {
    await updateLists();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) updateLists();
});
