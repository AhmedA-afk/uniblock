// End-to-end check in Chrome for Testing: loads the unpacked extension, waits
// for the live lists to compile, then verifies an ad script is blocked, ad
// elements are hidden, real content is not, and pausing a site works.
//   npm run test:e2e   (needs network access to easylist.to)
import puppeteer from 'puppeteer';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('../extension', import.meta.url));
const PAGE = `<!doctype html><html><body>
<div class="ad-slot" id="a">AD SLOT</div>
<div class="sponsored-post" id="b">SPONSORED</div>
<div class="content" id="c">REAL CONTENT</div>
<script>window.adState='pending'</script>
<script src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"
  onload="window.adState='loaded'" onerror="window.adState='blocked'"></script>
</body></html>`;
const server = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(PAGE); });
await new Promise((ok) => server.listen(8765, '127.0.0.1', ok));

const browser = await puppeteer.launch({
  headless: true,
  enableExtensions: [EXT],
  args: ['--no-sandbox'],
});
const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
const sw = await swTarget.worker();
const extId = new URL(swTarget.url()).host;

const t0 = Date.now();
let stats;
while (!(stats = await sw.evaluate(async () => (await chrome.storage.local.get('stats')).stats))) {
  if (Date.now() - t0 > 90_000) throw new Error('lists never compiled');
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(`compiled in ${((Date.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify(stats));
console.log('dynamic rules:', await sw.evaluate(async () => (await chrome.declarativeNetRequest.getDynamicRules()).length));
console.log('list status:', JSON.stringify(await sw.evaluate(async () => (await chrome.storage.local.get('listStatus')).listStatus)));

async function check(label) {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8765/', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 500));
  const res = await page.evaluate(() => ({
    adScript: window.adState,
    adSlot: getComputedStyle(document.getElementById('a')).display,
    sponsored: getComputedStyle(document.getElementById('b')).display,
    content: getComputedStyle(document.getElementById('c')).display,
  }));
  console.log(label, JSON.stringify(res));
  await page.close();
  return res;
}

const on = await check('blocking ON :');

const popup = await browser.newPage();
await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'setPaused', hostname: '127.0.0.1', paused: true }));
const off = await check('paused     :');
await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'setPaused', hostname: '127.0.0.1', paused: false }));
const again = await check('resumed    :');

// Popup render on a real page tab
const tab = await browser.newPage();
await tab.goto('http://127.0.0.1:8765/', { waitUntil: 'networkidle0' });
await popup.bringToFront();
await popup.reload();
await new Promise((r) => setTimeout(r, 800));
await popup.setViewport({ width: 320, height: 420 });
await popup.screenshot({ path: 'test/popup.png' });

// Without a user click there is no activeTab grant, so this shows whether the
// popup's fallback path is what we'd see in automation.
console.log('getMatchedRules from worker:', await sw.evaluate(async (url) => {
  const [t] = await chrome.tabs.query({ url });
  try { return (await chrome.declarativeNetRequest.getMatchedRules({ tabId: t.id })).rulesMatchedInfo.length; }
  catch (e) { return 'error: ' + e.message; }
}, 'http://127.0.0.1:8765/*'));

const pass =
  on.adScript === 'blocked' && on.adSlot === 'none' && on.sponsored === 'none' && on.content === 'block' &&
  off.adScript !== 'blocked' && off.adSlot === 'block' &&
  again.adScript === 'blocked' && again.adSlot === 'none';
console.log(pass ? 'E2E PASS' : 'E2E FAIL');
await browser.close();
server.close();
process.exit(pass ? 0 : 1);
