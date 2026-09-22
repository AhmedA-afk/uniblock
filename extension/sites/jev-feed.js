// EXPERIMENTAL, off by default: finds feed posts on any site, sends a compact
// text summary of each to the local Jev proxy (backend/jev-proxy), and hides
// the ones Jev judges to be ads. Post text leaves the browser in this mode
// (to the proxy on this machine, then to TypeSafe), which is why it's opt-in.
(() => {
  if (globalThis.__uniblockJevFeed) return;
  globalThis.__uniblockJevFeed = true;

  // Common shapes of a feed post across sites (Facebook, X, LinkedIn, Reddit,
  // Instagram and generic <article> feeds). Nested matches (quoted posts) are
  // folded into their outermost post.
  const POST_SELECTOR = [
    'div[aria-posinset]', '[role="article"]', 'article', '[data-testid="tweet"]',
    'shreddit-post', 'shreddit-ad-post', '.feed-shared-update-v2', '[data-id^="urn:li:activity"]',
  ].join(',');
  const MIN_HEIGHT = 80;
  const BATCH_MS = 150;
  const BATCH_MAX = 10;

  const seen = new WeakSet();
  const queue = [];
  let flushTimer = null;
  let enabled = false;

  // ---------------------------------------------------------- extraction
  // Text a person would read in `el`, in lines. Skips decoys: Facebook pads
  // posts with repeated "Facebook" spans that are aria-hidden and parked far
  // off-screen (seen 2026-09-19). Adds text that elements take from
  // aria-labelledby, which is how Facebook draws its "Ad" label.
  function lines(el) {
    const out = [];
    let line = '';
    let lastTop = null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      let text = '';
      let host = n;
      if (n.nodeType === Node.ELEMENT_NODE) {
        const ids = n.getAttribute('aria-labelledby');
        if (!ids || n.textContent.replace(/[\s\u2060]/g, '')) continue;
        text = ids.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
      } else {
        text = n.nodeValue.replace(/\u2060/g, '');
        host = n.parentElement;
      }
      if (!text.trim() || !host || host.closest('[aria-hidden="true"]')) continue;
      const r = host.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.right < -500 || r.left > innerWidth + 500) continue;
      if (lastTop !== null && Math.abs(r.top - lastTop) > 6 && line.trim()) {
        out.push(line.trim());
        line = '';
      }
      line += (line && !/\s$/.test(line) ? ' ' : '') + text;
      lastTop = r.top;
    }
    if (line.trim()) out.push(line.trim());
    return out;
  }

  function linkDomain(a) {
    try {
      let u = new URL(a.href, location.href);
      // Outbound links are often wrapped in a redirector (?u= / ?url=).
      const wrapped = u.searchParams.get('u') ?? u.searchParams.get('url');
      if (wrapped?.startsWith('http')) u = new URL(wrapped);
      return u.hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  }

  function summarize(post) {
    const all = lines(post);
    const buttons = [...new Set([...post.querySelectorAll('a, button, [role="button"]')]
      .map((b) => (b.innerText.trim() || b.getAttribute('aria-label') || '').replace(/\s+/g, ' '))
      .filter((t) => t.length > 0 && t.length <= 30))].slice(0, 12);
    const here = location.hostname.replace(/^www\./, '');
    const linkDomains = [...new Set([...post.querySelectorAll('a[href]')]
      .map(linkDomain)
      .filter((d) => d && !d.endsWith(here) && !here.endsWith(d)))].slice(0, 6);
    return {
      site: here,
      header: all.slice(0, 3).join(' · ').slice(0, 300),
      text: all.slice(3).join('\n').slice(0, 1200),
      buttons,
      linkDomains,
    };
  }

  // ------------------------------------------------------------- hiding
  function hide(post, result) {
    const s = result.scores;
    const bar = document.createElement('div');
    bar.style.cssText = 'font:13px system-ui,sans-serif;padding:8px 12px;margin:4px 0;'
      + 'border:1px dashed #8886;border-radius:8px;color:#888;display:flex;gap:8px;align-items:center';
    const label = document.createElement('span');
    label.textContent = `uniblock hid ${result.verdict === 'ad' ? 'a sponsored post' : 'a likely ad'} `
      + `(Jev: label ${s.label.toFixed(2)}, promo ${s.promo.toFixed(2)}, cta ${s.cta.toFixed(2)})`;
    const show = document.createElement('button');
    show.textContent = 'Show';
    show.style.cssText = 'font:inherit;cursor:pointer;background:none;border:1px solid #8886;border-radius:6px;color:inherit;padding:1px 8px';
    show.addEventListener('click', () => {
      post.style.removeProperty('display');
      bar.remove();
      chrome.runtime.sendMessage({ type: 'jevFeedback', verdict: result.verdict, shownByUser: true }).catch(() => {});
    });
    bar.append(label, show);
    post.before(bar);
    post.style.setProperty('display', 'none', 'important');
  }

  // --------------------------------------------------------- classifying
  async function flush() {
    flushTimer = null;
    const batch = queue.splice(0, BATCH_MAX);
    if (queue.length) flushTimer = setTimeout(flush, 0);
    if (!batch.length || !enabled) return;
    const res = await chrome.runtime
      .sendMessage({ type: 'jevClassify', posts: batch.map((b) => b.summary) })
      .catch(() => null);
    if (!res?.ok) return; // proxy down: leave posts as they are
    res.result.forEach((r, i) => {
      const { post } = batch[i];
      post.dataset.uniblockJev = r.error ? 'error' : r.verdict;
      if (!r.error && r.verdict !== 'content') hide(post, r);
    });
  }

  function enqueue(post) {
    if (seen.has(post)) return;
    seen.add(post);
    const summary = summarize(post);
    if (!summary.header && !summary.text) return;
    queue.push({ post, summary });
    flushTimer ??= setTimeout(flush, BATCH_MS);
  }

  // Classify posts a little before they scroll into view, to hide them in time.
  const nearViewport = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      nearViewport.unobserve(e.target);
      enqueue(e.target);
    }
  }, { rootMargin: '1200px 0px' });

  // Only feeds: a page with a single post-shaped element (a news article, a
  // blog post) is left alone, so its text is never sent anywhere.
  const MIN_POSTS = 2;

  function scan(root = document) {
    const candidates = root.querySelectorAll(POST_SELECTOR);
    if (candidates.length < MIN_POSTS) return;
    for (const el of candidates) {
      if (seen.has(el) || el.parentElement?.closest(POST_SELECTOR)) continue;
      if (el.getBoundingClientRect().height < MIN_HEIGHT) continue;
      nearViewport.observe(el);
    }
  }

  let scanTimer = null;
  const observer = new MutationObserver(() => {
    scanTimer ??= setTimeout(() => {
      scanTimer = null;
      scan();
    }, 250);
  });

  async function start() {
    const { jevEnabled = false, paused = [] } = await chrome.storage.local.get(['jevEnabled', 'paused']);
    const host = location.hostname;
    enabled = jevEnabled && !paused.some((h) => host === h || host.endsWith('.' + h));
    if (!enabled) return;
    scan();
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  chrome.storage.onChanged.addListener((changes) => {
    if ('jevEnabled' in changes) {
      observer.disconnect();
      start();
    }
  });

  start();
})();
