// Dev tool: captures the structure of the current page around what's on
// screen, so a developer can see what uniblock saw on a real, logged-in page.
// Injected with chrome.scripting.executeScript({ func: collectSnapshot }); it
// must be self-contained. Saved only to the local dev proxy (never uploaded).
export function collectSnapshot() {
  const vw = innerWidth;
  const vh = innerHeight;
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
  };
  const describe = (el) => {
    const attrs = {};
    for (const a of el.attributes) {
      if (a.name === 'class') attrs.class = `(${el.classList.length} classes)`;
      else if (/^(id|role|aria-|data-|href|title|alt|dir|tabindex|attributionsrc)/.test(a.name)) {
        attrs[a.name] = a.value.slice(0, 80);
      }
    }
    return { tag: el.tagName.toLowerCase(), attrs, rect: rect(el), kids: el.children.length };
  };
  const chain = (el) => {
    const out = [];
    for (let e = el; e && e !== document.documentElement && out.length < 45; e = e.parentElement) out.push(describe(e));
    return out;
  };

  // The markup of an element with images, scripts and long text cut down.
  const cleanHTML = (el, limit = 150_000) => {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('script, style, noscript').forEach((n) => n.remove());
    clone.querySelectorAll('path').forEach((n) => n.removeAttribute('d'));
    clone.querySelectorAll('[src], [srcset]').forEach((n) => {
      n.removeAttribute('srcset');
      if (n.getAttribute('src')) n.setAttribute('src', n.getAttribute('src').slice(0, 40));
    });
    clone.querySelectorAll('[style]').forEach((n) => n.setAttribute('style', n.getAttribute('style').slice(0, 120)));
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeValue.length > 60) n.nodeValue = n.nodeValue.slice(0, 60) + '…';
    }
    return clone.outerHTML.slice(0, limit);
  };

  // 1. What's under the middle of the screen, top to bottom.
  const probes = [];
  for (const fy of [0.2, 0.35, 0.5, 0.65]) {
    const el = document.elementFromPoint(vw / 2, vh * fy);
    if (el) probes.push({ at: [Math.round(vw / 2), Math.round(vh * fy)], chain: chain(el) });
  }

  // 2. The post in view: the widest ancestor that still fits the feed column.
  let post = null;
  const center = document.elementFromPoint(vw / 2, vh * 0.35);
  for (let e = center; e && e !== document.body; e = e.parentElement) {
    const [, , w, h] = rect(e);
    if (w < vw * 0.6 && h > 200 && h < 5000) post = e;
  }

  // 3. Every place the page says "Ad"/"Sponsored" in any form.
  const LABEL = /^(ad|ads|sponsored|promoted|paid partnership)$/i;
  const labels = [];
  for (const el of document.querySelectorAll('body *')) {
    if (labels.length >= 60) break;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('').trim();
    const hits = {
      ownText: LABEL.test(own) ? own : null,
      aria: /sponsor|^ad$|^ads$/i.test(el.getAttribute('aria-label') ?? '') ? el.getAttribute('aria-label') : null,
      title: /sponsor/i.test(el.getAttribute('title') ?? '') ? el.getAttribute('title') : null,
      use: null,
    };
    if (el.tagName.toLowerCase() === 'use') {
      const ref = el.getAttribute('href') ?? el.getAttribute('xlink:href');
      const target = ref?.startsWith('#') ? document.getElementById(ref.slice(1)) : null;
      if (target && /sponsor|^\s*ad\s*$/i.test(target.textContent)) hits.use = `${ref} → ${target.textContent.trim().slice(0, 40)}`;
    }
    if (hits.ownText || hits.aria || hits.title || hits.use) {
      labels.push({
        hits,
        visible: el.checkVisibility?.() ?? null,
        fontSize: getComputedStyle(el).fontSize,
        chain: chain(el).slice(0, 14),
        html: cleanHTML(el.parentElement ?? el, 2000),
      });
    }
  }

  // 4. Feed items near the middle of the screen: the ancestor that sits among
  // same-width siblings. For each, its markup and every text fragment in its
  // top 120 px with the styles that decide whether a person can see it.
  const feedItemOf = (el) => {
    for (let e = el; e && e.parentElement && e.parentElement !== document.body; e = e.parentElement) {
      const [, , w, h] = rect(e);
      if (h < 150) continue;
      const peers = [...e.parentElement.children].filter((c) => c !== e && Math.abs(rect(c)[2] - w) <= w * 0.1 && rect(c)[3] > 150);
      if (peers.length >= 1) return e;
    }
    return null;
  };
  const items = new Set();
  for (const fy of [0.15, 0.4, 0.65, 0.9]) {
    const el = document.elementFromPoint(vw * 0.45, vh * fy);
    const item = el && feedItemOf(el);
    if (item) items.add(item);
  }
  const feedItems = [...items].slice(0, 3).map((item) => {
    const top = item.getBoundingClientRect().top;
    const fragments = [];
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && fragments.length < 250; n = walker.nextNode()) {
      if (!n.nodeValue.trim()) continue;
      const p = n.parentElement;
      const r = p.getBoundingClientRect();
      if (r.top - top > 120) continue;
      const s = getComputedStyle(p);
      fragments.push({
        text: n.nodeValue.slice(0, 30),
        rect: rect(p),
        tag: p.tagName.toLowerCase(),
        style: [s.display, s.visibility, s.opacity, s.position, s.fontSize, s.color, s.clipPath !== 'none' ? `clip-path:${s.clipPath}` : '', s.order !== '0' ? `order:${s.order}` : ''].filter(Boolean).join(' '),
        visible: p.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
        ariaHidden: !!p.closest('[aria-hidden="true"]'),
      });
    }
    // Everything that could draw glyphs without text: pseudo-element content,
    // background images and masks, for each element inside the header links.
    const glyphSources = [];
    for (const a of item.querySelectorAll('a')) {
      if (a.getBoundingClientRect().top - top > 120) continue;
      for (const el of [a, ...a.querySelectorAll('*')]) {
        if (glyphSources.length >= 80) break;
        const s = getComputedStyle(el);
        const before = getComputedStyle(el, '::before');
        const after = getComputedStyle(el, '::after');
        glyphSources.push({
          tag: el.tagName.toLowerCase(),
          classes: el.getAttribute('class') ?? '',
          attrs: [...el.attributes].filter((x) => x.name !== 'class' && x.name !== 'href').map((x) => `${x.name}=${x.value.slice(0, 60)}`),
          rect: rect(el),
          text: el.textContent.slice(0, 20),
          before: before.content !== 'none' && before.content !== 'normal' ? `${before.content} ${before.width} ${before.backgroundImage.slice(0, 80)}` : null,
          after: after.content !== 'none' && after.content !== 'normal' ? `${after.content} ${after.width} ${after.backgroundImage.slice(0, 80)}` : null,
          background: s.backgroundImage !== 'none' ? s.backgroundImage.slice(0, 200) : null,
          mask: (s.maskImage && s.maskImage !== 'none') ? s.maskImage.slice(0, 200) : null,
          font: `${s.fontFamily.slice(0, 40)} ${s.fontSize}`,
        });
      }
    }
    return { describe: describe(item), fragments, glyphSources, html: cleanHTML(item, 60_000) };
  });

  // 5. Video players: each video's state, and every visible text in its
  // player overlay with class names (where ad countdowns live).
  const AD_UI = ['.atv-player-ad-time-remaining', '[class*="atvwebplayersdk-ad-timer"]',
    '[class*="atvwebplayersdk-adtimeindicator"]', '.atvwebplayersdk-ad-resume-message'];
  const videos = [...document.querySelectorAll('video')].slice(0, 4).map((v) => {
    const vr = v.getBoundingClientRect();
    let player = v.parentElement;
    for (let e = player; e && e !== document.body; e = e.parentElement) {
      const r = e.getBoundingClientRect();
      if (r.width > vr.width * 1.3 || r.height > vr.height * 1.5) break;
      player = e;
    }
    const texts = [];
    const walker = document.createTreeWalker(player ?? v, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && texts.length < 150; n = walker.nextNode()) {
      const t = n.nodeValue.trim();
      if (!t || t.length > 80) continue;
      const p = n.parentElement;
      const s = getComputedStyle(p);
      texts.push({
        text: t,
        classes: (p.getAttribute('class') ?? '').slice(0, 120),
        parentClasses: (p.parentElement?.getAttribute('class') ?? '').slice(0, 120),
        rect: rect(p),
        shown: s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05 && rect(p)[2] > 0,
      });
    }
    return {
      rect: rect(v),
      src: (v.currentSrc || v.src || '').slice(0, 60),
      state: { t: v.currentTime, dur: v.duration, rate: v.playbackRate, muted: v.muted, paused: v.paused, ready: v.readyState },
      dataset: { ...v.dataset },
      visible: v.checkVisibility?.() ?? null,
      player: player ? describe(player) : null,
      adUiMatches: AD_UI.map((sel) => ({ sel, found: [...(player ?? document).querySelectorAll(sel)].map((e) => ({ text: e.textContent.trim().slice(0, 40), rect: rect(e) })) })),
      texts,
      adClassElements: [...(player ?? v).querySelectorAll('[class*="ad" i]')].filter((e) => /(^|[-_\s])ad([-_\s]|s?$)|advert|adtime|ad-timer|adtimer/i.test(e.getAttribute('class') ?? '')).slice(0, 30)
        .map((e) => ({ classes: (e.getAttribute('class') ?? '').slice(0, 120), text: e.textContent.trim().slice(0, 40), rect: rect(e) })),
    };
  });

  return {
    host: location.hostname,
    feedItems,
    videos,
    url: location.origin + location.pathname,
    viewport: [vw, vh],
    at: new Date().toISOString(),
    probes,
    post: post ? { describe: describe(post), chain: chain(post).slice(0, 12), html: cleanHTML(post) } : null,
    labels,
    marked: {
      sponsored: [...document.querySelectorAll('[data-uniblock-sponsored]')].map((e) => ({ kind: e.dataset.uniblockSponsored, ...describe(e), text: e.innerText.slice(0, 80) })),
      jev: [...document.querySelectorAll('[data-uniblock-jev]')].map((e) => ({ verdict: e.dataset.uniblockJev, ...describe(e), text: e.innerText.slice(0, 80) })),
    },
  };
}

// Cookie-banner diagnosis, run in every frame (banners can live in iframes).
// Runs in the extension's isolated world, so it can open closed shadow roots
// and read the cookie script's own recent decisions.
export function collectCookieInfo() {
  // chrome.dom.openOrClosedShadowRoot throws on non-HTML elements (SVG, which
  // nearly every page has); one throw used to abort the whole scan.
  const shadowOf = (el) => {
    if (el.shadowRoot) return el.shadowRoot;
    if (!(el instanceof HTMLElement)) return null;
    try {
      return chrome.dom?.openOrClosedShadowRoot?.(el) ?? null;
    } catch {
      return null;
    }
  };
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
  };
  const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 50);
  const hosts = [];
  const walk = (root, depth) => {
    for (const el of root.querySelectorAll('*')) {
      const sr = shadowOf(el);
      if (!sr) continue;
      const buttons = [...sr.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]')]
        .slice(0, 12).map((b) => ({ label: label(b), rect: rect(b), visible: b.checkVisibility?.() ?? null }));
      hosts.push({
        tag: el.tagName.toLowerCase(), id: el.id, depth, rect: rect(el),
        mode: el.shadowRoot ? 'open' : 'closed',
        text: [...sr.children].map((c) => c.innerText ?? c.textContent ?? '').join(' ').replace(/\s+/g, ' ').slice(0, 160),
        buttons,
      });
      if (depth < 4) walk(sr, depth + 1);
    }
  };
  walk(document, 0);
  // What's under the middle of the screen, following into shadow roots.
  const chain = [];
  let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  for (let i = 0; el && i < 6; i++) {
    const sr = shadowOf(el);
    const inner = sr?.elementFromPoint?.(innerWidth / 2, innerHeight / 2);
    chain.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${sr ? (el.shadowRoot ? ' [open]' : ' [closed]') : ''}`);
    if (!inner || inner === el) break;
    el = inner;
  }
  let path = [];
  for (let e = el; e && path.length < 20; e = e.parentElement ?? (e.getRootNode() instanceof ShadowRoot ? e.getRootNode().host : null)) {
    path.push(`${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''} ${getComputedStyle(e).position}`);
  }
  return {
    frame: location.href.slice(0, 120),
    top: window === top,
    cookieScript: globalThis.__uniblockCookiesDiagnose?.() ?? 'not running in this frame',
    shadowHosts: hosts.filter((h) => /cookie|consent|privacy|deny|accept/i.test(h.text + h.buttons.map((b) => b.label).join(' '))).slice(0, 10),
    shadowHostCount: hosts.length,
    center: { chain, path },
    iframes: [...document.querySelectorAll('iframe')].map((f) => ({ src: (f.src || '').slice(0, 80), rect: rect(f) })).filter((f) => f.rect[2] > 50),
  };
}
