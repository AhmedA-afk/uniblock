// Browser check of the generic anti-adblock wall remover on a mock page
// (test/antiadblock.test-page.html). No network needed.
//   npm run test:antiadblock
import puppeteer from 'puppeteer';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('../extension', import.meta.url));
const PAGE = readFileSync(new URL('./antiadblock.test-page.html', import.meta.url));
const server = http.createServer((q, r) => { r.setHeader('content-type', 'text/html; charset=utf-8'); r.end(PAGE); });
await new Promise((ok) => server.listen(8770, '127.0.0.1', ok));
const browser = await puppeteer.launch({ headless: true, enableExtensions: [EXT], args: ['--no-sandbox'] });
await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 900 });
await page.goto('http://127.0.0.1:8770/', { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 2500));
const got = await page.evaluate(() => ({
  wall: !!document.getElementById('wall'),
  backdrop: !!document.getElementById('backdrop'),
  scrollable: getComputedStyle(document.body).overflow !== 'hidden',
  article: !!document.getElementById('about'),
  cookies: !!document.getElementById('cookies'),
}));
const want = { wall: false, backdrop: false, scrollable: true, article: true, cookies: true };
let ok = true;
for (const [k, v] of Object.entries(want)) {
  const pass = got[k] === v;
  ok &&= pass;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${k.padEnd(11)} want ${v} got ${got[k]}`);
}
console.log(ok ? 'ANTIADBLOCK PASS' : 'ANTIADBLOCK FAIL');
await browser.close();
server.close();
process.exit(ok ? 0 : 1);
