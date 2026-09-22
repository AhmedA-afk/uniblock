// Dev tool: which real sites show a cookie banner from this network, and
// whether uniblock ("Reject non-essential") handles it. Loads each site twice
// in fresh browsers. The "banner" check is a heuristic: it can flag a consent
// host that has nothing on screen, so confirm failures with cookieDebug logs.
//   node scripts/cookie-survey.mjs [url ...]
import puppeteer from 'puppeteer';
const EXT = new URL('../extension', import.meta.url).pathname;
const SITES = process.argv.length > 2 ? process.argv.slice(2) : [
  'https://askubuntu.com', 'https://serverfault.com', 'https://cooking.stackexchange.com', 'https://mathoverflow.net',
  'https://www.reuters.com', 'https://www.economist.com', 'https://www.ft.com', 'https://www.dw.com/en',
  'https://www.euronews.com', 'https://www.independent.co.uk', 'https://www.lemonde.fr', 'https://www.elpais.com',
  'https://www.heise.de', 'https://www.golem.de', 'https://www.derstandard.at', 'https://nos.nl',
  'https://www.marca.com', 'https://www.corriere.it', 'https://www.ikea.com/in/en/', 'https://www.booking.com',
  'https://www.deepl.com/translator', 'https://www.trustpilot.com', 'https://gitlab.com', 'https://www.atlassian.com',
  'https://www.hubspot.com', 'https://www.cookiebot.com', 'https://www.onetrust.com', 'https://www.didomi.io',
  'https://usercentrics.com', 'https://www.cookieyes.com', 'https://www.osano.com', 'https://complianz.io',
  'https://arstechnica.com', 'https://www.theverge.com', 'https://www.notion.so', 'https://www.figma.com',
];
const CMPS = {
  OneTrust: '#onetrust-banner-sdk', Cookiebot: '#CybotCookiebotDialog', Didomi: '#didomi-host', Quantcast: '.qc-cmp2-container',
  Usercentrics: '#usercentrics-root, #usercentrics-cmp-ui', TrustArc: '#truste-consent-track', Sourcepoint: '[id^="sp_message_container"]',
  CookieYes: '.cky-consent-container', Complianz: '.cmplz-cookiebanner', Osano: '.osano-cm-window', Google: '.fc-consent-root',
};
const detect = (cmps) => {
  const found = Object.entries(cmps).filter(([, sel]) => [...document.querySelectorAll(sel)].some((e) => e.checkVisibility())).map(([n]) => n);
  if (found.length) return found.join('+');
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el);
    if (!(s.position === 'fixed' || s.position === 'sticky' || el.matches('[role="dialog"],dialog[open]')) || !el.checkVisibility()) continue;
    const t = el.innerText ?? '';
    if (t.length < 3000 && /cookie/i.test(t) && el.querySelector('button,[role="button"]')) return 'generic';
  }
  return document.querySelector('iframe[src*="consent"], iframe[id^="sp_message_iframe"]') ? 'consent-iframe' : null;
};
async function visit(browser, sw, mode, url) {
  await sw.evaluate((m) => chrome.storage.local.set({ cookieMode: m }), mode);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 8000));
    return await page.evaluate(detect, CMPS);
  } catch (e) {
    return `error: ${e.message.slice(0, 40)}`;
  } finally {
    await page.close();
  }
}
const launch = async () => {
  const browser = await puppeteer.launch({ headless: true, enableExtensions: [EXT], args: ['--no-sandbox', '--window-size=1280,900'] });
  const swt = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
  return { browser, sw: await swt.worker() };
};
const rows = [];
for (const url of SITES) {
  // Fresh browser per mode so the first visit's consent cookie doesn't hide the banner.
  const a = await launch();
  const banner = await visit(a.browser, a.sw, 'off', url);
  await a.browser.close();
  let after = '-';
  if (banner && !banner.startsWith('error')) {
    const b = await launch();
    after = (await visit(b.browser, b.sw, 'essential', url)) ?? 'handled';
    await b.browser.close();
  }
  rows.push([url, banner ?? 'none', after]);
  console.log(`${url.padEnd(42)} banner: ${String(banner ?? 'none').padEnd(22)} with uniblock: ${after}`);
}
