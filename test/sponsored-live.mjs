// Browser check of label-first sponsored hiding on a Facebook-like mock page
// (test/sponsored.test-page.html). No network needed.
//   npm run test:sponsored
import puppeteer from 'puppeteer';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('../extension', import.meta.url));
const PAGE = readFileSync(new URL('./sponsored.test-page.html', import.meta.url));
const EXPECT = {
  friend: 'visible', 'ad-plain': 'hidden', 'ad-labelledby': 'hidden', 'ad-wordjoiner': 'hidden', 'organic-timestamp': 'visible', 'ad-mention': 'visible', 'ad-split': 'hidden',
  news: 'visible', 'ad-late': 'hidden', 'rail-sponsored': 'hidden', 'rail-friends': 'visible',
};

const server = http.createServer((q, r) => { r.setHeader('content-type', 'text/html; charset=utf-8'); r.end(PAGE); });
await new Promise((ok) => server.listen(8767, '127.0.0.1', ok));
const browser = await puppeteer.launch({ headless: true, enableExtensions: [EXT], args: ['--no-sandbox', '--window-size=1200,900'] });
await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 900 });
// Served as www.facebook.com (intercepted, never hits the network) so
// Facebook-scoped signals apply.
await page.setRequestInterception(true);
page.on('request', (req) => {
  if (req.url() === 'https://www.facebook.com/') {
    req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE });
  } else if (req.url().startsWith('https://www.facebook.com/')) {
    req.respond({ status: 204, body: '' });
  } else req.continue();
});
await page.goto('https://www.facebook.com/', { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 2500)); // includes the late post
const got = await page.evaluate((ids) => Object.fromEntries(ids.map((id) => {
  const el = document.getElementById(id);
  const hiddenSelfOrAncestor = el && !el.checkVisibility();
  return [id, hiddenSelfOrAncestor ? 'hidden' : 'visible'];
})), Object.keys(EXPECT));
let ok = true;
for (const [id, want] of Object.entries(EXPECT)) {
  const pass = got[id] === want;
  ok &&= pass;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${id.padEnd(15)} want ${want.padEnd(8)} got ${got[id]}`);
}
console.log(ok ? 'SPONSORED PASS' : 'SPONSORED FAIL');
await browser.close();
server.close();
process.exit(ok ? 0 : 1);
