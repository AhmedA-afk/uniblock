// YouTube video ads come from YouTube's own servers inside the same player as
// the video, so there is no request to block. Instead, while the player is
// showing an ad we mute it and jump to its end. YouTube resets speed and mute
// for every ad in a pod, so this re-applies on each media event, not once.
// Findings behind this (DevTools, 2026-09-19): the player carries the class
// `ad-showing` during ads; seeking to the end ends that ad immediately.

// The background worker also injects this into already-open tabs after an
// install or update, so guard against running twice. A copy left over from
// before an extension reload loses its runtime connection; it doesn't count as
// running, and it switches itself off (see `alive`).
(() => {
  const alive = () => !!chrome.runtime?.id;
  if (globalThis.__uniblockYouTube?.alive()) return;
  globalThis.__uniblockYouTube = { alive };

  const AD_CLASS = 'ad-showing';
  const PLAYER = '#movie_player, .html5-video-player';
  const SKIP_BUTTONS = '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern';
  const MEDIA_EVENTS = ['loadedmetadata', 'durationchange', 'playing', 'timeupdate'];

  let enabled = true;
  let player = null;
  let inAd = false;
  // What the user had before the ad, so we can put it back afterwards.
  let userMuted = null;
  let userRate = null;
  let watchdog = null;

  function video() {
    return player?.querySelector('video') ?? null;
  }

  // YouTube ignored a bare .click() on its Skip button (observed 2026-09-19:
  // ~30 clicks, no effect). Send the full event sequence a real click makes.
  // youtube-main.js makes these count: it shows YouTube's Skip handlers an
  // event with isTrusted: true when the event targets the Skip button.
  let lastPress = 0;
  function pressLikeAUser(el) {
    const now = Date.now();
    if (now - lastPress < 1000) return;
    lastPress = now;
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window, button: 0,
      clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
    };
    const pointer = { ...base, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerover', pointer));
    el.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', pointer));
    el.dispatchEvent(new MouseEvent('mouseup', base));
    el.dispatchEvent(new MouseEvent('click', base));
  }

  function skipAd() {
    const v = video();
    if (!v) return;
    v.muted = true;
    // A paused ad never reaches its end, so start it (muted autoplay is allowed).
    if (v.paused) v.play().catch(() => {});
    const skip = player.querySelector(SKIP_BUTTONS);
    if (skip && skip.getBoundingClientRect().width > 0) pressLikeAUser(skip);
    if (Number.isFinite(v.duration) && v.duration > 0 && v.currentTime < v.duration - 0.2) {
      v.currentTime = v.duration - 0.1;
    }
    // Fallback when the ad won't take a seek: play it through as fast as allowed.
    if (v.playbackRate !== 16) v.playbackRate = 16;
  }

  // One count per ad break we stop, whether youtube-main.js removed it before
  // it could play or we skipped it here. Hover previews also carry ads but
  // don't have a real 11-character video id, so they aren't counted.
  const counted = new Set();
  function countStopped(videoId = location.href) {
    if (counted.has(videoId)) return;
    counted.add(videoId);
    chrome.runtime.sendMessage({ type: 'videoAdStopped' }).catch(() => {});
  }
  document.addEventListener('uniblock:ads-removed', (e) => {
    if (enabled && /^[\w-]{11}$/.test(e.detail)) countStopped(e.detail);
  });

  function update() {
    if (!alive()) enabled = false;
    if (!enabled || !player) return;
    const ad = player.classList.contains(AD_CLASS);
    if (ad) {
      if (!inAd) {
        inAd = true;
        countStopped();
        // A stalled ad stops firing media events, so keep nudging it.
        watchdog = setInterval(update, 500);
      }
      skipAd();
    } else if (inAd) {
      inAd = false;
      clearInterval(watchdog);
      const v = video();
      if (v) {
        if (userMuted !== null) v.muted = userMuted;
        if (userRate !== null && v.playbackRate !== userRate) v.playbackRate = userRate;
      }
    }
  }

  // Remember the user's own mute and speed choices, but only outside ads —
  // inside an ad, those values are ours or YouTube's.
  function rememberUserState(e) {
    if (inAd || player?.classList.contains(AD_CLASS)) return;
    const v = e.target;
    userMuted = v.muted;
    userRate = v.playbackRate;
  }

  function attach(p) {
    if (p === player) return;
    player = p;
    new MutationObserver(update).observe(p, { attributes: true, attributeFilter: ['class'] });
    // Media events don't bubble, but a capturing listener on the player still
    // sees them, which also covers YouTube swapping the <video> element.
    for (const type of MEDIA_EVENTS) p.addEventListener(type, update, true);
    p.addEventListener('volumechange', rememberUserState, true);
    p.addEventListener('ratechange', rememberUserState, true);
    const v = video();
    if (v && !p.classList.contains(AD_CLASS)) {
      userMuted = v.muted;
      userRate = v.playbackRate;
    }
    update();
  }

  function findPlayer() {
    const p = document.querySelector(PLAYER);
    if (p) attach(p);
    return !!p;
  }

  async function start() {
    const { paused = [] } = await chrome.storage.local.get('paused');
    const host = location.hostname;
    enabled = !paused.some((h) => host === h || host.endsWith('.' + h));
    if (!enabled) return;

    // The player appears after load and YouTube is a single-page app, so look
    // again on its navigation event and poll briefly until it shows up.
    document.addEventListener('yt-navigate-finish', findPlayer);
    const timer = setInterval(() => {
      if (findPlayer()) clearInterval(timer);
    }, 250);
    setTimeout(() => clearInterval(timer), 60_000);
  }

  start();
})();
