// Live check of the experimental Jev feed classifier (needs the proxy:
// node --env-file=<key file> backend/jev-proxy/server.mjs). Serves a mock
// feed, enables the mode, and reports which posts got hidden.
//   npm run test:jev
import puppeteer from 'puppeteer';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('../extension', import.meta.url));
const post = (id, header, text, buttons) => `
  <div role="article" id="${id}" style="min-height:120px;border:1px solid #ccc;margin:8px;padding:8px">
    <div>${header}</div><div>${text}</div>
    <div>${buttons.map((b) => `<button>${b}</button>`).join('')}</div>
  </div>`;
// Facebook-style obfuscated label: letters in separate spans, with decoys.
const scrambled = 'Glow Skincare · <span>S</span><span>p</span><span>o</span><span>n</span><span>s</span><span>o</span><span>r</span><span>e</span><span>d</span>';
const EXPECT = { sponsored: 'hidden', scrambled: 'hidden', brand: 'visible', friend: 'visible', news: 'visible', group: 'visible' };
const PAGE = `<!doctype html><title>feed</title><div role="feed">
  ${post('sponsored', 'Acme Running Co<br>Sponsored', 'UltraGlide shoes 30% off this week only. Free shipping on every order!', ['Shop now', 'Like', 'Comment', 'Share'])}
  ${post('friend', 'Priya Shah<br>2h · Friends', 'Finally finished my first half marathon! Legs are dead but so happy.', ['Like', 'Comment', 'Share'])}
  ${post('scrambled', scrambled, 'Clear skin in 14 days or your money back. Join 50,000 happy customers.', ['Learn more', 'Like', 'Comment', 'Share'])}
  ${post('brand', 'Nike<br>3h', 'Congratulations to everyone who ran the Berlin marathon today. What a race!', ['Like', 'Comment', 'Share'])}
  ${post('news', 'The Hindu<br>1h', 'Monsoon rainfall in Gujarat is 12% above normal this season, the IMD said on Friday.', ['Like', 'Comment', 'Share'])}
  ${post('group', 'Ahmedabad Runners<br>Rahul posted', 'Anyone up for a 10k at Riverfront on Sunday, 6am?', ['Like', 'Comment', 'Share'])}
</div>`;

const server = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(PAGE); });
await new Promise((ok) => server.listen(8766, '127.0.0.1', ok));
const browser = await puppeteer.launch({ headless: true, enableExtensions: [EXT], args: ['--no-sandbox'] });
const t = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
const sw = await t.worker();
await sw.evaluate(() => chrome.storage.local.set({ jevEnabled: true }));

const page = await browser.newPage();
const t0 = Date.now();
await page.goto('http://127.0.0.1:8766/', { waitUntil: 'load' });
await page.waitForFunction(() => document.querySelectorAll('[data-uniblock-jev]').length >= 6, { timeout: 20000 }).catch(() => {});
const elapsed = Date.now() - t0;
const got = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[role="article"]')].map((p) => [
  p.id, { verdict: p.dataset.uniblockJev ?? 'unclassified', state: getComputedStyle(p).display === 'none' ? 'hidden' : 'visible' },
])));
let ok = true;
for (const [id, want] of Object.entries(EXPECT)) {
  const pass = got[id]?.state === want;
  ok &&= pass;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${id.padEnd(10)} want ${want.padEnd(8)} got ${got[id]?.state} (${got[id]?.verdict})`);
}
console.log(`all classified within ${elapsed} ms`);
console.log(ok ? 'JEV PASS' : 'JEV FAIL');
await browser.close();
server.close();
process.exit(ok ? 0 : 1);
