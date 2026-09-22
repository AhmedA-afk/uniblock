// Hides sponsored posts and "Sponsored" sections on any site by finding the
// ad label itself ("Ad", "Sponsored", "Promoted", …) and hiding the post or
// section it belongs to. Runs locally; nothing is sent anywhere.
//
// Label-first because feeds like Facebook's use generated class names and no
// stable post markup, but must still show users a readable ad label.
(() => {
  if (globalThis.__uniblockSponsored) return;
  globalThis.__uniblockSponsored = true;

  // Exact label texts, compared after normalising (lower-case, letters only),
  // so "Ad ·", "S p o n s o r e d" and "Sponsored" all match.
  const LABELS = new Set([
    'ad', 'ads', 'sponsored', 'promoted', 'paidpartnership', 'promotedpost',
    'sponsorisé', 'sponsorisee', 'gesponsert', 'anzeige', 'patrocinado', 'publicidad',
    'sponsorizzato', 'reklama', 'реклама', 'publicité', 'annonce', 'gesponsord',
    'प्रायोजित', 'विज्ञापन', '広告', '赞助', '贊助', '광고',
  ]);
  const normalise = (s) => s.toLowerCase().normalize('NFC').replace(/[^\p{L}]/gu, '');
  const isLabel = (s) => s.length <= 40 && LABELS.has(normalise(s));

  // ------------------------------------------------------------- labels
  // Text a person actually sees in `el`: skips hidden or zero-size pieces and
  // orders the rest left to right, which undoes letters split into shuffled
  // spans.
  function visibleText(el) {
    const parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue;
      if (!text.trim()) continue;
      const parent = n.parentElement;
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      const r = parent.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || parseFloat(style.fontSize) < 4) continue;
      parts.push([r.left, r.top, text]);
    }
    parts.sort((a, b) => (Math.abs(a[1] - b[1]) > 4 ? a[1] - b[1] : a[0] - b[0]));
    return parts.map((p) => p[2]).join('');
  }

  // Text of the elements an aria-labelledby attribute points to.
  const labelledText = (el) => (el.getAttribute('aria-labelledby') ?? '').split(/\s+/)
    .map((id) => (id ? document.getElementById(id)?.textContent ?? '' : '')).join(' ');

  // Small elements whose own visible text is an ad label.
  //
  // Facebook (seen 2026-09-19) draws its "Ad" label from an empty
  // <span aria-labelledby="…"> whose text lives in a hidden element elsewhere
  // on the page; the post itself only holds an invisible U+2060. So labels
  // are also found through aria-labelledby, from either end.
  function findLabels(root) {
    const found = new Set();
    const scope = root.nodeType === Node.ELEMENT_NODE ? root : document.body;
    for (const el of [scope, ...scope.querySelectorAll('[aria-labelledby]')]) {
      if (el.hasAttribute?.('aria-labelledby') && isLabel(labelledText(el))) found.add(el);
    }
    // Facebook also draws "Ad" with no text or reference at all. Its label is
    // then a link whose only text is an invisible U+2060 (seen on 3 of 3 ads
    // across four snapshots, 2026-09-19); ordinary posts' timestamp links
    // don't have it. Scoped to Facebook until seen on more posts.
    if (/(^|\.)facebook\.com$/.test(location.hostname)) {
      for (const a of scope.querySelectorAll('a')) {
        if (a.textContent.replace(/\s/g, '') === '\u2060') found.add(a);
      }
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue.trim();
      if (!text || text.length > 40) continue;
      // A label can be one text node ("Sponsored") or split across tiny
      // siblings ("S","p","o"…); test the node, then its parent's whole text.
      const el = n.parentElement;
      if (!el || el.closest('[data-uniblock-sponsored], input, textarea, [contenteditable="true"]')) continue;
      if (isLabel(text)) {
        found.add(el);
        // A hidden label text may be the target of a visible labelled element.
        const id = el.closest('[id]')?.id;
        if (id) {
          for (const ref of document.querySelectorAll(`[aria-labelledby~="${CSS.escape(id)}"]`)) found.add(ref);
        }
        continue;
      }
      const holder = el.parentElement;
      if (holder && text.length <= 2 && holder.textContent.length <= 60 && isLabel(visibleText(holder))) {
        found.add(holder);
      }
    }
    return [...found].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.height < 60 && r.width < 400;
    });
  }

  // ---------------------------------------------------------- containers
  const HEADING = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
  const KNOWN_POST = 'article,[role="article"],div[aria-posinset],[data-testid="tweet"],shreddit-ad-post,shreddit-post,.feed-shared-update-v2';

  function looksLikeHeading(el) {
    if (el.closest(HEADING)) return true;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    return fs >= 16 && getComputedStyle(el).fontWeight >= 600;
  }

  // The post a label belongs to: a known post element, or the ancestor that
  // sits in a list of similarly wide, tall siblings (a feed). Two such
  // siblings are preferred: inside a single post, the media block and the
  // comment box can look like one "peer", which would hide half a post.
  function feedItem(label) {
    const known = label.closest(KNOWN_POST);
    if (known) return known;
    let el = label;
    let fallback = null;
    for (let i = 0; i < 30 && el.parentElement && el.parentElement !== document.body; i++) {
      const parent = el.parentElement;
      const r = el.getBoundingClientRect();
      if (r.height > 120 && r.height < 4000) {
        const peers = [...parent.children].filter((c) => {
          if (c === el) return false;
          const cr = c.getBoundingClientRect();
          return cr.height > 120 && Math.abs(cr.width - r.width) <= r.width * 0.1;
        }).length;
        if (peers >= 2) return el;
        if (peers === 1) fallback ??= el;
      }
      el = parent;
    }
    return fallback;
  }

  // A "Sponsored" heading's section: grow upwards while the block still
  // contains no other heading (so "Friend requests" below stays visible).
  function section(label) {
    let el = label;
    while (el.parentElement && el.parentElement !== document.body) {
      const parent = el.parentElement;
      const headings = [...parent.querySelectorAll(`${HEADING}, span, div`)].filter(
        (h) => h !== label && !label.contains(h) && !h.contains(label) && h.children.length === 0
          && h.textContent.trim().length > 2 && h.textContent.trim().length < 40 && looksLikeHeading(h),
      );
      if (headings.length) break;
      el = parent;
    }
    return el === label ? null : el;
  }

  // An "Ad" label overlaid on a video player (Prime Video's "Ad 1:19 Learn
  // more") belongs to a video ad, which video-ads.js fast-forwards. Hiding it
  // here removed the ad UI and player controls while the ad kept playing, and
  // blinded video-ads.js (seen 2026-09-19). A sponsored *post* that contains
  // a video is different: its label sits in the post header, in normal flow
  // above the video, so it is still hidden.
  function onVideoPlayer(label) {
    const lr = label.getBoundingClientRect();
    let overlaid = false;
    for (let el = label.parentElement, i = 0; el && el !== document.body && i < 20; el = el.parentElement, i++) {
      const pos = getComputedStyle(el).position;
      if (pos === 'absolute' || pos === 'fixed') overlaid = true;
      const video = el.querySelector('video');
      if (!video) continue;
      const vr = video.getBoundingClientRect();
      const overlapsVideo = lr.left < vr.right && vr.left < lr.right && lr.top < vr.bottom && vr.top < lr.bottom;
      return overlapsVideo || overlaid;
    }
    return false;
  }

  // --------------------------------------------------------------- hide
  function hide(el, kind) {
    if (el.dataset.uniblockSponsored) return;
    el.dataset.uniblockSponsored = kind;
    el.style.setProperty('display', 'none', 'important');
    chrome.runtime.sendMessage({ type: 'sponsoredHidden', kind }).catch(() => {});
  }

  function scan(root = document.body) {
    if (!root) return;
    for (const label of findLabels(root)) {
      if (label.closest('[data-uniblock-sponsored]') || onVideoPlayer(label)) continue;
      if (looksLikeHeading(label)) {
        const s = section(label);
        if (s) hide(s, 'section');
      } else {
        const post = feedItem(label);
        if (post && post !== document.body && !post.contains(document.querySelector('[role="main"]') ?? null)) {
          hide(post, 'post');
        }
      }
    }
  }

  // Feeds load as you scroll. After the first full pass, only the parts of
  // the page that changed are scanned (a full pass on Facebook walks tens of
  // thousands of text nodes).
  const pending = new Set();
  let timer = null;
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      const target = r.type === 'characterData' ? r.target.parentElement : r.target;
      if (target) pending.add(target);
    }
    timer ??= setTimeout(() => {
      timer = null;
      const roots = [...pending].filter((el) => el.isConnected);
      pending.clear();
      // Skip roots already covered by another pending root.
      for (const root of roots) {
        if (!roots.some((other) => other !== root && other.contains(root))) scan(root);
      }
    }, 150);
  });

  async function start() {
    const { paused = [] } = await chrome.storage.local.get('paused');
    const host = location.hostname;
    if (paused.some((h) => host === h || host.endsWith('.' + h))) return;
    scan();
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
