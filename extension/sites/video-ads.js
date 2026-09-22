// Skips video ads on streaming sites (Prime Video, and any player that shows
// an ad countdown). YouTube has its own handling in youtube*.js.
//
// Streaming ads are usually stitched into the same stream as the show, so
// there's no request to block. What players can't hide is the ad UI they must
// show viewers ("Ad 1 of 2", "Ad · 0:15", "Your video will resume in…").
// While that UI sits on a playing video:
//   1. Try to seek past the whole ad (its length is on the countdown).
//   2. If the player refuses the seek, fast-forward it muted instead, and
//      remember that for this site.
//   3. Either way, cover the player so the viewer never watches the ad, with
//      real time left and a "Watch this ad" way out.
// Afterwards: restore speed, fade the sound back in, count the time saved.
(() => {
  if (globalThis.__uniblockVideoAds) return;
  if (/(^|\.)youtube(-nocookie)?\.com$/.test(location.hostname)) return;
  globalThis.__uniblockVideoAds = true;

  // Known ad-UI elements per site: a head start where we know the markup.
  // Everything else falls back to reading the player's text.
  const SITE_AD_UI = [
    // Prime Video / Amazon: ad timers and "will resume" message.
    '.atv-player-ad-time-remaining',
    '[class*="atvwebplayersdk-ad-timer"]',
    '[class*="atvwebplayersdk-adtimeindicator"]',
    '.atvwebplayersdk-ad-resume-message',
  ].join(',');

  const AD_TEXT = [
    /^(ad|ads|advert|advertisement|sponsored|commercial|anzeige|publicité|publicidad|विज्ञापन)$/i,
    /\bads?\s*\d+\s*(of|\/)\s*\d+\b/i, // Ad 1 of 2, Ads 2/3
    /^ads?\s*[·•:|-]?\s*\d{1,2}:\d{2}$/i, // Ad · 0:15
    /\bads?\s*(will\s*)?ends?\s*in\b/i, // Ad ends in 12
    /\b(video|show|content|episode|programme|program)\s+will\s+(resume|begin|start|play)\b/i,
    /\bwill\s+(resume|begin|play)\s+(in|after)\b/i,
    /\bad\s*break\b/i,
    /^skip\s*ads?\b/i,
  ];
  const SKIP_TEXT = /^(skip|skip ads?|skip ad now|skip this ad|anzeige überspringen|passer la pub|omitir anuncio|विज्ञापन छोड़ें)$/i;
  const FAST_RATE = 16; // Chrome's maximum; buffering sets the real ceiling
  const SEEK_CHECK_MS = 1500;
  const SEEK_BLOCKED_KEY = 'uniblock:seek-blocked';

  const visible = (el) => {
    if (!el?.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05;
  };
  const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  const seekBlocked = () => {
    try { return sessionStorage.getItem(SEEK_BLOCKED_KEY) === '1'; } catch { return false; }
  };
  const markSeekBlocked = () => {
    try { sessionStorage.setItem(SEEK_BLOCKED_KEY, '1'); } catch {}
  };

  // The player around a video: the highest ancestor still roughly its size,
  // which is where overlay controls and ad UI live.
  function playerOf(video) {
    const vr = video.getBoundingClientRect();
    let player = video.parentElement;
    for (let el = player; el && el !== document.body; el = el.parentElement) {
      const r = el.getBoundingClientRect();
      if (r.width > vr.width * 1.3 || r.height > vr.height * 1.5) break;
      player = el;
    }
    return player;
  }

  // Reads the ad UI: whether an ad is showing, seconds left on its
  // countdown, and its place in the break ("2 of 3").
  function readAd(video) {
    const player = playerOf(video);
    if (!player) return null;
    let label = null;
    for (const el of player.querySelectorAll(SITE_AD_UI)) {
      if (visible(el) && el.textContent.trim()) {
        label = el;
        break;
      }
    }
    if (!label) {
      const vr = video.getBoundingClientRect();
      const walker = document.createTreeWalker(player, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.nodeValue.trim();
        if (!text || text.length > 60 || !AD_TEXT.some((re) => re.test(text))) continue;
        const el = n.parentElement;
        if (visible(el) && overlaps(el.getBoundingClientRect(), vr)) {
          label = el;
          break;
        }
      }
    }
    if (!label) return null;
    // The ad UI block around the label: small enough to be just the ad UI,
    // not the player's own timeline.
    let block = label;
    while (block.parentElement && block.parentElement !== player && block.parentElement.textContent.length < 80) {
      block = block.parentElement;
    }
    const text = block.textContent;
    const clock = /(\d{1,2}):(\d{2})/.exec(text);
    const secs = /(\d{1,3})\s*(s|sec|secs|seconds)\b/i.exec(text);
    const pod = /(\d+)\s*(?:of|\/)\s*(\d+)/i.exec(text);
    return {
      player,
      remaining: clock ? Number(clock[1]) * 60 + Number(clock[2]) : secs ? Number(secs[1]) : null,
      pod: pod ? `${pod[1]} of ${pod[2]}` : null,
    };
  }

  function pressSkip(player) {
    for (const el of player.querySelectorAll('button, [role="button"], [class*="skip" i]')) {
      const text = (el.innerText || el.getAttribute('aria-label') || '').trim();
      if (!SKIP_TEXT.test(text) || !visible(el) || el.disabled) continue;
      const r = el.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        el.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, { ...at, pointerType: 'mouse' }) : new MouseEvent(type, at));
      }
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ cover
  const COVER_CSS = `
    :host { all: initial; }
    .cover { position: fixed; z-index: 2147483647; display: flex; align-items: center; justify-content: center;
      background: rgba(12, 12, 14, 0.9); backdrop-filter: blur(28px); color: #f2f2f4;
      font: 15px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; opacity: 0; transition: opacity 180ms ease; }
    .cover.on { opacity: 1; }
    .box { width: min(360px, 70%); text-align: center; }
    .title { font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
    .pod { color: #a4a6ad; font-weight: 400; }
    .bar { height: 4px; margin: 14px 0 8px; border-radius: 2px; background: #ffffff26; overflow: hidden; }
    .fill { height: 100%; width: 100%; background: #f2f2f4; transform: scaleX(0); transform-origin: left; transition: transform 250ms linear; }
    .left { color: #a4a6ad; font-size: 13px; font-variant-numeric: tabular-nums; }
    .watch { position: absolute; right: 16px; bottom: 14px; font: 13px system-ui, sans-serif; color: #c9cbd1;
      background: none; border: 1px solid #ffffff33; border-radius: 6px; padding: 5px 10px; cursor: pointer; }
    .watch:hover { color: #fff; border-color: #ffffff66; }
    .done .bar, .done .left, .done .watch { display: none; }
  `;

  function makeCover(onWatch) {
    const host = document.createElement('uniblock-ad-cover');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${COVER_CSS}</style>
      <div class="cover" part="cover"><div class="box">
        <div class="title">Skipping ad <span class="pod"></span></div>
        <div class="bar"><div class="fill"></div></div>
        <div class="left"></div>
      </div><button class="watch" type="button">Watch this ad ▸</button></div>`;
    root.querySelector('.watch').addEventListener('click', onWatch);
    return { host, root, el: root.querySelector('.cover') };
  }

  function placeCover(cover, video) {
    // In fullscreen only the fullscreen element's subtree is drawn.
    const parent = document.fullscreenElement?.contains(video) ? document.fullscreenElement : document.documentElement;
    if (cover.host.parentNode !== parent) parent.append(cover.host);
    const r = video.getBoundingClientRect();
    Object.assign(cover.el.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }

  const fmt = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.max(1, Math.round(s))}s`);

  function updateCover(st, info) {
    const { root } = st.cover;
    root.querySelector('.pod').textContent = info.pod ? `· ${info.pod}` : '';
    if (st.mode === 'seek') {
      root.querySelector('.left').textContent = 'Jumping past it…';
    } else if (st.firstRemaining && info.remaining != null) {
      const done = 1 - info.remaining / st.firstRemaining;
      root.querySelector('.fill').style.transform = `scaleX(${Math.min(1, Math.max(0.04, done))})`;
      root.querySelector('.left').textContent = `~${fmt(info.remaining / st.rate)} left`;
    } else {
      root.querySelector('.left').textContent = 'Fast-forwarding…';
    }
  }

  // ------------------------------------------------------------ per video
  const states = new WeakMap();

  function startAd(video, info) {
    const st = {
      wall: performance.now(),
      media: video.currentTime,
      firstRemaining: info.remaining,
      saved: { muted: video.muted, volume: video.volume, rate: video.playbackRate },
      mode: 'fast',
      rate: 1,
      lastWall: performance.now(),
      lastMedia: video.currentTime,
      watching: false,
      cover: null,
    };
    st.cover = makeCover(() => watchAd(video, st));
    states.set(video, st);
    chrome.runtime.sendMessage({ type: 'videoAdStopped' }).catch(() => {});

    video.muted = true;
    // 1. Seek past the whole ad, if the countdown says how long it is.
    const target = video.currentTime + (info.remaining ?? 0) + 0.3;
    if (!seekBlocked() && info.remaining && (!Number.isFinite(video.duration) || target < video.duration)) {
      st.mode = 'seek';
      st.seekTarget = target;
      video.currentTime = target;
    }
    placeCover(st.cover, video);
    requestAnimationFrame(() => st.cover.el.classList.add('on'));
    follow(video, st);
  }

  // Keep the cover glued to the video (scrolling, resizing, fullscreen).
  function follow(video, st) {
    if (states.get(video) !== st || st.watching) return;
    placeCover(st.cover, video);
    requestAnimationFrame(() => follow(video, st));
  }

  function duringAd(video, st, info) {
    if (st.watching) return;
    const now = performance.now();
    // Measured speed, for an honest "time left".
    const dWall = (now - st.lastWall) / 1000;
    if (dWall > 0.2) {
      const measured = (video.currentTime - st.lastMedia) / dWall;
      if (measured > 0 && measured < 40) st.rate = st.rate * 0.5 + measured * 0.5;
      st.lastWall = now;
      st.lastMedia = video.currentTime;
    }
    // 2. Seek refused: fast-forward. A refusal usually shows at once as the
    // playhead snapping back; otherwise give the seek SEEK_CHECK_MS to land.
    const snappedBack = now - st.wall > 300 && video.currentTime < st.seekTarget - 1;
    if (st.mode === 'seek' && (snappedBack || now - st.wall > SEEK_CHECK_MS)) {
      st.mode = 'fast';
      markSeekBlocked();
    }
    if (st.mode === 'fast') {
      video.muted = true;
      // Players often reset the speed between ads in a break; re-apply.
      if (video.playbackRate !== FAST_RATE) video.playbackRate = FAST_RATE;
      if (video.paused) video.play().catch(() => {});
      pressSkip(info.player);
    }
    updateCover(st, info);
  }

  function endAd(video, st) {
    states.delete(video);
    video.playbackRate = st.saved.rate;
    if (!st.watching) {
      // Time saved: the ad's length minus the time the viewer actually waited.
      const waited = (performance.now() - st.wall) / 1000;
      const adLength = st.firstRemaining ?? Math.max(0, video.currentTime - st.media);
      const saved = Math.max(0, adLength - waited);
      if (saved >= 1) chrome.runtime.sendMessage({ type: 'adTimeSaved', seconds: saved }).catch(() => {});
      fadeSoundIn(video, st.saved);
      // Say what happened, briefly, then fade out.
      const { root, el } = st.cover;
      el.classList.add('done');
      root.querySelector('.title').textContent = saved >= 1 ? `Skipped ${fmt(saved)} of ads` : 'Ad skipped';
      setTimeout(() => el.classList.remove('on'), 1400);
      setTimeout(() => st.cover.host.remove(), 1700);
    } else {
      st.cover.host.remove();
    }
  }

  function watchAd(video, st) {
    st.watching = true;
    video.playbackRate = st.saved.rate;
    video.muted = st.saved.muted;
    video.volume = st.saved.volume;
    st.cover.el.classList.remove('on');
    setTimeout(() => st.cover.host.remove(), 200);
  }

  function fadeSoundIn(video, saved) {
    if (saved.muted) {
      video.muted = true;
      return;
    }
    video.volume = 0;
    video.muted = false;
    const start = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / 600);
      video.volume = saved.volume * t;
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function tick() {
    for (const video of document.querySelectorAll('video')) {
      if (video.readyState < 1 || !visible(video)) continue;
      const info = readAd(video);
      const st = states.get(video);
      if (info && !st) startAd(video, info);
      else if (info && st) duringAd(video, st, info);
      else if (!info && st) endAd(video, st);
    }
  }

  async function start() {
    const { paused = [] } = await chrome.storage.local.get('paused');
    const host = location.hostname;
    if (paused.some((h) => host === h || host.endsWith('.' + h))) return;
    // Cheap until a video exists: most pages have none.
    setInterval(() => {
      if (document.querySelector('video')) tick();
    }, 250);
  }

  start();
})();
