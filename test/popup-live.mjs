// Browser check of pop-up blocking with the real extension and the live
// EasyList (needs network for the lists). Ad hosts are mapped to a local
// server, so no ad site is ever contacted.
//   npm run test:popup
import puppeteer from 'puppeteer';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('../extension', import.meta.url));
const AD = 'http://11x11.com/landing'; // only in easylist_adservers_popup.txt, as ||11x11.com^$popup
const GOOD = 'http://help.uniblock.test/';
const PAGE = `<!doctype html><title>opener</title>
<button id="direct" onclick="window.open('${AD}?direct')">ad popup</button>
<button id="under" onclick="const w = window.open('about:blank'); setTimeout(() => w.location = '${AD}?under', 300)">popunder</button>
<button id="good" onclick="window.open('${GOOD}')">normal popup</button>`;

const server = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(q.headers.host.includes('opener') ? PAGE : `<title>${q.headers.host}</title>landing`); });
await new Promise((ok) => server.listen(8775, '127.0.0.1', ok));
const browser = await puppeteer.launch({
  headless: true, enableExtensions: [EXT],
  args: ['--no-sandbox', '--host-resolver-rules=MAP 11x11.com 127.0.0.1:8775, MAP help.uniblock.test 127.0.0.1:8775, MAP opener.uniblock.test 127.0.0.1:8775'],
});
const swt = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
const sw = await swt.worker();
for (let i = 0; i < 90 && !(await sw.evaluate(async () => (await chrome.storage.local.get('popupIndex')).popupIndex)); i++) {
  await new Promise((r) => setTimeout(r, 1000));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const openTabs = async () => (await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.pendingUrl || t.url)));

const page = await browser.newPage();
await page.goto('http://opener.uniblock.test/', { waitUntil: 'load' });
for (const id of ['direct', 'under', 'good']) {
  await page.click(`#${id}`);
  await sleep(1500);
}
// A tab the user opens directly to the same ad host (typed URL, Ctrl+T): no
// opener, never closed. Created by the extension, because Puppeteer's own
// tabs always carry an opener.
await sw.evaluate((url) => chrome.tabs.create({ url }), AD + '?typed');
await sleep(1500);

const tabs = await openTabs();
const blocked = await sw.evaluate(async () => (await chrome.storage.local.get('popupsBlocked')).popupsBlocked ?? 0);
const has = (s) => tabs.some((u) => u?.includes(s));
const checks = [
  ['ad pop-up closed', !has('?direct')],
  ['pop-under (blank, then navigated) closed', !has('?under')],
  ['normal pop-up kept', has('help.uniblock.test')],
  ['tab the user opened kept', has('?typed')],
  ['counter = 2', blocked === 2],
];
let ok = true;
for (const [name, pass] of checks) { ok &&= pass; console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`); }
console.log('open tabs:', JSON.stringify(tabs));
console.log(ok ? 'POPUP PASS' : 'POPUP FAIL');
await browser.close();
server.close();
process.exit(ok ? 0 : 1);
