// Diagnoses what YouTube notices about uniblock. Loads the same videos with
// and without the extension and records, per video: time until the real video
// is playing, whether an ad showed, YouTube's error / "interruptions" UI,
// requests we blocked on the page, and ad-status globals YouTube may read.
//   node test/youtube-diagnose.mjs [runs-per-mode]
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('../extension', import.meta.url));
const VIDEOS = ['hUZNPCSZDaQ', 'dQw4w9WgXcQ', 'kJQP7kiw5Fk', 'yGWEuxaaMNw'];
const RUNS = Number(process.argv[2] ?? 1);
// Modes: without, with, with+allow-all-yt (no network blocking on YouTube),
// with+no-main (youtube-main.js not registered).
const MODES = (process.argv[3] ?? 'without,with').split(',');
const HOPS = Number(process.argv[4] ?? 0);

async function launch(mode) {
  const withExtension = mode !== 'without';
  const browser = await puppeteer.launch({
    headless: true,
    ...(withExtension ? { enableExtensions: [EXT] } : {}),
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,900'],
  });
  if (withExtension) {
    const t = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
    const sw = await t.worker();
    for (let i = 0; i < 60 && !(await sw.evaluate(async () => (await chrome.storage.local.get('stats')).stats)); i++) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (mode.includes('allow-all-yt')) {
      await sw.evaluate(() => chrome.declarativeNetRequest.updateSessionRules({ addRules: [{
        id: 1, priority: 1000, action: { type: 'allowAllRequests' },
        condition: { requestDomains: ['youtube.com'], resourceTypes: ['main_frame', 'sub_frame'] },
      }] }));
    }
    if (mode.includes('no-main')) {
      await sw.evaluate(() => chrome.scripting.unregisterContentScripts({ ids: ['youtube-main'] }));
    }
  }
  return browser;
}

async function probe(browser, id) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const blocked = [];
  page.on('requestfailed', (req) => {
    if (req.failure()?.errorText === 'net::ERR_BLOCKED_BY_CLIENT') blocked.push(req.url().slice(0, 110));
  });
  const t0 = Date.now();
  await page.goto(`https://www.youtube.com/watch?v=${id}`, { waitUntil: 'domcontentloaded' });
  const results = [{ id, via: 'load', ...(await page.evaluate(WATCH, t0)), blocked: [...blocked] }];
  // In-app navigation: the player data comes from a client request instead.
  for (let hop = 0; hop < HOPS; hop++) {
    blocked.length = 0;
    const clicked = await page.evaluate(() => {
      const cur = new URLSearchParams(location.search).get('v');
      const a = [...document.querySelectorAll('#related a[href^="/watch?v="], ytd-watch-next-secondary-results-renderer a[href^="/watch?v="]')]
        .find((x) => !x.href.includes(cur));
      if (!a) return null;
      a.click();
      return a.href;
    });
    if (!clicked) break;
    const t1 = Date.now();
    await page.waitForFunction((h) => location.href === h || location.search.includes(new URL(h).searchParams.get('v')), { timeout: 10000 }, clicked).catch(() => {});
    results.push({ id: new URL(clicked).searchParams.get('v'), via: `hop${hop + 1}`, ...(await page.evaluate(WATCH, t1)), blocked: [...blocked] });
  }
  await page.close();
  return results;
}

const WATCH = async (navStart) => {
    const since = () => Date.now() - navStart;
    await new Promise((r) => setTimeout(r, 300)); // let the old video tear down after a hop
    let p;
    while (!(p = document.querySelector('#movie_player')) && since() < 15000) await new Promise((r) => setTimeout(r, 50));
    let sawAd = false, firstFrameMs = null, outcome = 'timeout';
    const texts = new Set();
    while (since() < 30000) {
      await new Promise((r) => setTimeout(r, 100));
      const v = p.querySelector('video');
      if (v?.paused) { v.muted = true; v.play().catch(() => {}); }
      if (p.classList.contains('ad-showing')) sawAd = true;
      for (const el of document.querySelectorAll('tp-yt-paper-toast, yt-notification-action-renderer, .ytp-error, ytd-enforcement-message-view-model, tp-yt-paper-dialog, .ytp-tooltip-text, #toast')) {
        const t = el.innerText?.replace(/\s+/g, ' ').trim();
        if (t && el.getBoundingClientRect().height > 0) texts.add(t.slice(0, 90));
      }
      if (p.querySelector('.ytp-error')) { outcome = 'error'; break; }
      if (!p.classList.contains('ad-showing') && v && v.currentTime > 0.2 && v.duration > 30 && firstFrameMs === null) firstFrameMs = since();
      if (firstFrameMs !== null && since() - firstFrameMs > 4000) { outcome = 'playing'; break; }
    }
    // Scan the whole page too: the interruptions notice may render elsewhere.
    const body = document.body.innerText;
    for (const phrase of ['Experiencing interruptions', 'Something went wrong', 'Ad blockers', 'ad blocker']) {
      if (body.includes(phrase)) texts.add(`[page text] ${phrase}`);
    }
    const live = p.getPlayerResponse?.();
    return {
      outcome, sawAd, firstFrameMs,
      adsInResponse: live ? ['adPlacements', 'playerAds', 'adSlots'].filter((k) => k in live).length : null,
      sabr: !!live?.streamingData?.serverAbrStreamingUrl,
      ui: [...texts],
      google_ad_status: typeof window.google_ad_status === 'undefined' ? 'undefined' : window.google_ad_status,
    };
};

for (const mode of MODES) {
  console.log(`\n===== ${mode} =====`);
  for (let run = 0; run < RUNS; run++) {
    const browser = await launch(mode);
    for (const id of VIDEOS) {
      for (const r of await probe(browser, id)) console.log(JSON.stringify(r));
    }
    await browser.close();
  }
}
