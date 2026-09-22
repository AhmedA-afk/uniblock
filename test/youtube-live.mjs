// Live check against YouTube (network, not part of `npm test`): loads the
// extension, opens videos, and confirms each one plays quickly with no error
// screen and no anti-adblock notice. Baseline without uniblock: ~2-3 s.
//   npm run test:youtube
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('../extension', import.meta.url));
const VIDEOS = ['hUZNPCSZDaQ', 'dQw4w9WgXcQ', 'kJQP7kiw5Fk'];

const browser = await puppeteer.launch({ headless: true, enableExtensions: [EXT], args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
const sw = await swTarget.worker();
for (let i = 0; i < 60 && !(await sw.evaluate(async () => (await chrome.storage.local.get('stats')).stats)); i++) {
  await new Promise((r) => setTimeout(r, 1000));
}
console.log('main-world script registered:', JSON.stringify(await sw.evaluate(async () =>
  (await chrome.scripting.getRegisteredContentScripts()).map((s) => ({ id: s.id, world: s.world, runAt: s.runAt })))));

let ok = true;
for (const id of VIDEOS) {
  const page = await browser.newPage();
  await page.goto(`https://www.youtube.com/watch?v=${id}`, { waitUntil: 'domcontentloaded' });
  const r = await page.evaluate(async () => {
    const t0 = performance.now();
    let p;
    while (!(p = document.querySelector('#movie_player')) && performance.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 100));
    let sawAd = false;
    let outcome = 'timeout';
    let firstFrameMs = null;
    while (performance.now() - t0 < 25000) {
      await new Promise((r) => setTimeout(r, 200));
      const v = p.querySelector('video');
      if (v?.paused) { v.muted = true; v.play().catch(() => {}); }
      if (p.classList.contains('ad-showing')) sawAd = true;
      if (p.querySelector('.ytp-error')) { outcome = 'error'; break; }
      if (!p.classList.contains('ad-showing') && v && v.currentTime > 0.2 && v.duration > 30) {
        firstFrameMs = Math.round(performance.now() - t0);
        outcome = 'playing';
        break;
      }
    }
    const notices = ['Experiencing interruptions', 'Ad blockers', 'Something went wrong']
      .filter((t) => document.body.innerText.includes(t));
    return { outcome, firstFrameMs, sawAd, notices };
  });
  console.log(id, JSON.stringify(r));
  // A single slow start is usually the network (measured: same video 3-4 s,
  // one outlier at 16 s), so it warns; errors and notices fail.
  if (r.outcome !== 'playing' || r.notices.length) ok = false;
  else if (r.firstFrameMs > 8000) console.log(`  warning: slow start (${r.firstFrameMs} ms)`);
  await page.close();
}
const stopped = await sw.evaluate(async () => (await chrome.storage.local.get('videoAdsStopped')).videoAdsStopped ?? 0);
console.log('popup counter (videoAdsStopped):', stopped);
console.log(ok ? 'YOUTUBE PASS' : 'YOUTUBE FAIL');
await browser.close();
process.exit(ok ? 0 : 1);
