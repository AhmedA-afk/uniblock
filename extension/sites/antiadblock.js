// Removes "please disable your ad blocker" walls on any site: finds an
// overlay that talks about ad blockers, removes it and the backdrop behind
// it, and gives the page its scrolling back. Runs locally.
//
// Vendor-agnostic on purpose: walls come from many vendors (Admiral, Google
// ad-blocking recovery, Sourcepoint, homegrown), but all have to tell the
// reader, in words, what they want.
(() => {
  if (globalThis.__uniblockAntiAdblock) return;
  globalThis.__uniblockAntiAdblock = true;

  // A wall mentions ad blocking AND asks for something. Either alone is too
  // common (articles about ad blockers, "allow notifications" prompts).
  const MENTIONS = /ad[\s-]?block(er|ing)?|ad blocker|adblocker|ad-blocker|bloqueur de pub|werbeblocker|bloqueador de anuncios|bloccare la pubblicità|блокировщик рекламы/i;
  const ASKS = /disable|turn off|pause|whitelist|allowlist|allow ads|detected|support us|deaktivier|désactiv|desactiv|disattiv|отключ|continue without/i;

  const covers = (r) => r.width * r.height > innerWidth * innerHeight * 0.08;

  // Positioned layers: fixed/sticky, or absolute with a stacking order.
  function isOverlay(el) {
    const s = getComputedStyle(el);
    if (s.position === 'fixed' || s.position === 'sticky') return true;
    return s.position === 'absolute' && Number(s.zIndex) >= 100;
  }

  // The wall: the outermost overlay around text that mentions ad blocking
  // and asks the reader to act.
  function findWalls(root) {
    const walls = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue;
      if (text.length < 6 || !MENTIONS.test(text)) continue;
      let wall = null;
      for (let el = n.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
        if (el.matches('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]') || isOverlay(el)) wall = el;
      }
      if (!wall || !ASKS.test(wall.textContent)) continue;
      if (wall.textContent.length > 4000) continue; // an article, not a prompt
      walls.add(wall);
    }
    return [...walls];
  }

  // Full-screen layers with little or no text: the dimmed backdrop.
  function backdrops() {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!isOverlay(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < innerWidth * 0.9 || r.height < innerHeight * 0.9) continue;
      if (el.textContent.trim().length > 40 || el.querySelector('video, iframe:not([src=""])')) continue;
      out.push(el);
    }
    return out;
  }

  // Walls usually lock scrolling and sometimes blur or fade the article.
  function restorePage() {
    for (const el of [document.documentElement, document.body]) {
      const s = getComputedStyle(el);
      if (s.overflow === 'hidden' || s.overflowY === 'hidden') el.style.setProperty('overflow', 'auto', 'important');
      if (s.position === 'fixed') el.style.setProperty('position', 'static', 'important');
    }
    for (const el of document.querySelectorAll('body > *, main, article')) {
      const s = getComputedStyle(el);
      if (s.filter.includes('blur')) el.style.setProperty('filter', 'none', 'important');
      if (s.pointerEvents === 'none' && el.tagName !== 'SCRIPT') el.style.setProperty('pointer-events', 'auto', 'important');
    }
  }

  let removed = 0;
  function sweep(root = document.body) {
    if (!root) return;
    const walls = findWalls(root);
    if (!walls.length) return;
    for (const wall of walls) {
      wall.remove();
      removed++;
    }
    for (const b of backdrops()) b.remove();
    restorePage();
    chrome.runtime.sendMessage({ type: 'wallRemoved', count: walls.length }).catch(() => {});
  }

  // Walls often appear a few seconds after load, and some come back after
  // removal, so keep watching (debounced, only changed subtrees).
  const pending = new Set();
  let timer = null;
  const observer = new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) pending.add(n);
    timer ??= setTimeout(() => {
      timer = null;
      const roots = [...pending].filter((n) => n.isConnected);
      pending.clear();
      for (const root of roots) sweep(root);
    }, 100);
  });

  async function start() {
    const { paused = [] } = await chrome.storage.local.get('paused');
    const host = location.hostname;
    if (paused.some((h) => host === h || host.endsWith('.' + h))) return;
    sweep();
    observer.observe(document.documentElement, { childList: true, subtree: true });
    // Some walls are revealed by a style change on an element already present.
    const recheck = setInterval(() => sweep(), 2000);
    setTimeout(() => clearInterval(recheck), 30_000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
