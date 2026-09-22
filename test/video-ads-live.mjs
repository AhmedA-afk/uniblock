// Browser check of the video-ad skipper on a mock streaming player
// (test/video-ads.test-page.html). No network needed.
//   npm run test:video-ads
// Scenarios: a player that allows seeking (ad is jumped past), one that
// refuses seeks during ads (fast-forward fallback), and "Watch this ad".
import puppeteer from 'puppeteer';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('../extension', import.meta.url));
const PAGE = readFileSync(new URL('./video-ads.test-page.html', import.meta.url));
const CLIP = readFileSync(new URL('./fixtures/clip.webm', import.meta.url));
// Byte ranges, so the clip is seekable like a real stream.
const server = http.createServer((q, r) => {
  if (q.url.startsWith('/clip.webm')) {
    r.setHeader('content-type', 'video/webm');
    r.setHeader('accept-ranges', 'bytes');
    const m = /bytes=(\d*)-(\d*)/.exec(q.headers.range ?? '');
    if (!m) return r.end(CLIP);
    const start = Number(m[1] || 0);
    const end = m[2] ? Number(m[2]) : CLIP.length - 1;
    r.writeHead(206, { 'content-range': `bytes ${start}-${end}/${CLIP.length}`, 'content-length': end - start + 1 });
    return r.end(CLIP.subarray(start, end + 1));
  }
  r.setHeader('content-type', 'text/html; charset=utf-8');
  r.end(PAGE);
});
await new Promise((ok) => server.listen(8771, '127.0.0.1', ok));
const browser = await puppeteer.launch({ headless: true, enableExtensions: [EXT], args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const swt = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
const sw = await swt.worker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = (page) => page.evaluate(() => {
  const v1 = document.getElementById('v1'), v2 = document.getElementById('v2');
  const host = document.querySelector('uniblock-ad-cover');
  const cover = host?.shadowRoot?.querySelector('.cover');
  return {
    rate: v1.playbackRate, muted: v1.muted, volume: Number(v1.volume.toFixed(2)), t: v1.currentTime,
    adOn: !!document.getElementById('adui'), otherRate: v2.playbackRate, ...window.log,
    cover: cover ? { on: cover.classList.contains('on'), text: cover.innerText.replace(/\s+/g, ' ').trim() } : null,
    playerHidden: !document.getElementById('p1').checkVisibility(),
  };
});

let ok = true;
const check = (name, pass, detail = '') => { ok &&= pass; console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${pass ? '' : `  ${detail}`}`); };

async function scenario(query) {
  await sw.evaluate(() => chrome.storage.local.set({ adSecondsSaved: 0 }));
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 900 });
  await page.goto(`http://127.0.0.1:8771/${query}`, { waitUntil: 'load' });
  return page;
}

// 1. Seek allowed: the whole ad is jumped past almost at once.
{
  const page = await scenario('');
  await sleep(1200);
  const s1 = await state(page);
  await sleep(2500);
  const s2 = await state(page);
  const saved = await sw.evaluate(async () => (await chrome.storage.local.get('adSecondsSaved')).adSecondsSaved);
  console.log('\n[seek allowed]', JSON.stringify({ s1, s2, saved }));
  check('ad jumped past within ~1 s', s1.adOn === false && s1.skipped === false);
  check('speed restored to 1.25', s2.rate === 1.25);
  check('sound faded back in to 0.8', s2.muted === false && s2.volume === 0.8, JSON.stringify(s2));
  check('time saved counted (~7 s)', saved > 5, `saved=${saved}`);
  check('cover gone afterwards', !s2.cover);
  check('player not hidden', !s1.playerHidden);
  check('ordinary video untouched', s1.otherRate === 1 && s2.otherRate === 1);
  await page.close();
}

// 2. Seek refused: fall back to fast-forward, under the cover.
{
  const page = await scenario('?lock=1');
  await sleep(700);
  const s1 = await state(page); // before the 1.5 s seek check
  await sleep(1300);
  const s2 = await state(page); // fast-forwarding
  await sleep(2500);
  const s3 = await state(page); // done
  console.log('\n[seek refused]', JSON.stringify({ s1, s2, s3 }));
  check('cover shown during the ad', s1.cover?.on === true && /Skipping ad/.test(s1.cover.text), JSON.stringify(s1.cover));
  check('cover shows the break position', /1 of 2/.test(s1.cover?.text ?? ''));
  check('player refused the seek', s1.seekRefused >= 1);
  check('fell back to fast-forward, muted', (s2.rate === 16 && s2.muted) || s2.adOn === false, JSON.stringify(s2));
  check('ad over, speed and sound restored', s3.adOn === false && s3.rate === 1.25 && s3.muted === false);
  await page.close();
}

// 3. "Watch this ad": the viewer opts to see it; everything goes back to normal.
{
  const page = await scenario('?lock=1');
  await sleep(600);
  await page.evaluate(() => document.querySelector('uniblock-ad-cover').shadowRoot.querySelector('.watch').click());
  await sleep(1500);
  const s = await state(page);
  console.log('\n[watch this ad]', JSON.stringify(s));
  check('watching: normal speed, sound on, no cover', s.rate === 1.25 && s.muted === false && !s.cover?.on && s.adOn === true);
  await page.close();
}

console.log(ok ? '\nVIDEO-ADS PASS' : '\nVIDEO-ADS FAIL');
await browser.close();
server.close();
process.exit(ok ? 0 : 1);
