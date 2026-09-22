// Browser check of cookie-banner answering on mock banners
// (test/cookies.test-page.html). The "odd" banner needs the Jev proxy
// (backend/jev-proxy); without it that case is reported as skipped.
//   npm run test:cookies
import puppeteer from 'puppeteer';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('../extension', import.meta.url));
const PAGE = readFileSync(new URL('./cookies.test-page.html', import.meta.url));
const server = http.createServer((q, r) => { r.setHeader('content-type', 'text/html; charset=utf-8'); r.end(PAGE); });
await new Promise((ok) => server.listen(8777, '127.0.0.1', ok));
const browser = await puppeteer.launch({ headless: true, enableExtensions: [EXT], args: ['--no-sandbox'] });
const swt = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
const sw = await swt.worker();
const proxyUp = await fetch('http://127.0.0.1:8787/health').then((r) => r.ok).catch(() => false);

const cases = [
  // [mode, banner, expected consent]
  ['essential', 'simple', 'reject-all'],
  ['accept', 'simple', 'accept-all'],
  ['off', 'simple', null],
  ['essential', 'settings', 'need,li'], // statistics + marketing off, legitimate interest left
  ['reject', 'settings', 'need'], // legitimate interest off too
  ['accept', 'settings', 'accept-all'],
  ['essential', 'odd', 'essentials', { needsJev: true }],
  ['accept', 'odd', 'accept-all', { needsJev: true }],
  ['reject', 'shadow', 'deny'], // closed shadow root, filled after the host appears
  ['accept', 'shadow', 'accept-all'],
  ['essential', 'onetrust-pc', 'need'], // settings open in a separate panel
  ['reject', 'payorok', null], // never press "reject and subscribe"
  ['accept', 'payorok', 'accept-all', { needsJev: true }], // "Acepto y continúo gratis" needs Jev
  ['essential', 'news', null], // not a cookie banner
];

// ONLY=onetrust-pc runs just that banner; DEBUG=1 prints the script's log.
const only = process.env.ONLY;
if (process.env.DEBUG) await sw.evaluate(() => chrome.storage.local.set({ cookieDebug: true }));
let ok = true;
for (const [mode, banner, want, opts = {}] of cases.filter(([, b]) => !only || b === only)) {
  const name = `${mode.padEnd(9)} × ${banner.padEnd(8)} → ${want ?? 'untouched'}`;
  if (opts.needsJev && !proxyUp) {
    console.log(`skip ${name}  (Jev proxy not running)`);
    continue;
  }
  await sw.evaluate((m) => chrome.storage.local.set({ cookieMode: m }), mode);
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => m.text().includes('[uniblock cookies]') && logs.push(m.text().slice(0, 300)));
  await page.goto(`http://127.0.0.1:8777/?b=${banner}`, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, opts.needsJev ? 7000 : 3000));
  const got = await page.evaluate(() => ({
    consent: window.consent,
    bannerLeft: !!document.querySelector('.bar, .panel, #usercentrics-cmp-ui'),
    seenMs: Math.round(window.seen.ms),
  }));
  // The reader should not see a banner uniblock answers. A banner it declines
  // to answer (pay-or-OK, or not a cookie banner) is meant to stay visible.
  const answered = want !== null;
  const quiet = !answered || got.seenMs < 400;
  const pass = got.consent === want && (answered ? !got.bannerLeft : true) && quiet;
  ok &&= pass;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}  (seen ${got.seenMs} ms)${pass ? '' : `  got ${JSON.stringify(got)}`}`);
  if (!pass && logs.length) console.log(logs.map((l) => `     ${l}`).join('\n'));
  await page.close();
}
console.log(ok ? 'COOKIES PASS' : 'COOKIES FAIL');
await browser.close();
server.close();
process.exit(ok ? 0 : 1);
