// Runs in YouTube's own JavaScript world at document_start, before any of
// YouTube's scripts. Background and measurements: docs/notes/youtube.md.
//   1. Server-driven streams (almost all videos now): the server plans the
//      ads, and editing the response only makes the stream wait them out.
//      Stopping and reloading the video through the player's own API the
//      moment an ad starts plays the video instead (measured: first frame
//      3.2-3.4 s in 4 of 4, vs ~18.5 s with the pre-roll).
//   2. Client-decided streams (older path): remove the ad schedule from the
//      response before the player reads it.
//   3. If YouTube shows an error anyway, reload once through the player API.
//   4. Let a scripted press of the Skip button count, for anything that leaks.
// Registered by the background worker, which unregisters it on paused sites.
(() => {
  if (window.__uniblockMain) return;
  window.__uniblockMain = true;

  const AD_KEYS = ['adPlacements', 'playerAds', 'adSlots'];
  const SKIP_SELECTOR = '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern';

  // Tells our isolated-world script (which can message the extension) that a
  // video's ads were stopped, so the popup can count it.
  const report = (videoId) => {
    document.dispatchEvent(new CustomEvent('uniblock:ads-removed', { detail: videoId ?? '' }));
  };

  function currentVideoId() {
    return new URLSearchParams(location.search).get('v')
      ?? document.getElementById('movie_player')?.getVideoData?.().video_id;
  }

  // ------------------------------------------------------ reload via the API
  // Stopping the video and loading it again through the player's own API
  // starts it without the ad. Triggered the instant an ad starts: acting
  // earlier raced the player's own load and lost about half the time.
  // Each video is reloaded at most once per purpose, so a reload whose own
  // response still lists ads can't start a loop.
  const reloaded = { ads: new Set(), error: new Set() };
  let lastContentTime = 0;

  function reload(id, why) {
    const player = document.getElementById('movie_player');
    if (!id || reloaded[why].has(id) || typeof player?.loadVideoById !== 'function') return false;
    reloaded[why].add(id);
    player.stopVideo?.(); // loading the video that's already loaded is a no-op
    player.loadVideoById(id, Math.floor(lastContentTime));
    return true;
  }

  function watchPlayer(player) {
    new MutationObserver(() => {
      if (player.classList.contains('ad-showing')) {
        const id = currentVideoId();
        if (reload(id, 'ads')) report(id);
      }
    }).observe(player, { attributes: true, attributeFilter: ['class'] });
    // Remember where the real video was, so a mid-roll reload resumes there.
    player.addEventListener('timeupdate', (e) => {
      if (!player.classList.contains('ad-showing')) lastContentTime = e.target.currentTime;
    }, true);
  }

  const findPlayer = setInterval(() => {
    const player = document.getElementById('movie_player');
    if (!player) return;
    clearInterval(findPlayer);
    watchPlayer(player);
  }, 20);
  // A new video starts from its beginning (or its ?t=).
  document.addEventListener('yt-navigate-start', () => {
    lastContentTime = Number(new URLSearchParams(location.search).get('t')) || 0;
  });

  // --------------------------------------------------------------- responses
  function isPlayerResponse(o) {
    return !!o && typeof o === 'object' && ('streamingData' in o || 'playabilityStatus' in o);
  }

  const BLOCKING_STATUSES = new Set(['UNPLAYABLE', 'ERROR']);

  function inspect(value) {
    if (!value || typeof value !== 'object') return value;
    for (const pr of [value, value.playerResponse]) {
      if (!isPlayerResponse(pr)) continue;
      const id = pr.videoDetails?.videoId;
      if (!id) continue;
      if (BLOCKING_STATUSES.has(pr.playabilityStatus?.status) && pr.playabilityStatus?.errorScreen) {
        reload(id, 'error');
        continue;
      }
      // Server-driven streams are left alone here: editing their schedule
      // makes the stream wait out the ads. Their ads are cut when they start.
      if (!AD_KEYS.some((k) => k in pr) || pr.streamingData?.serverAbrStreamingUrl) continue;
      for (const k of AD_KEYS) delete pr[k];
      report(id);
    }
    return value;
  }

  // The response embedded in the page: `var ytInitialPlayerResponse = {…}`.
  // An accessor on window turns that assignment into a call we can inspect.
  let initial;
  Object.defineProperty(window, 'ytInitialPlayerResponse', {
    configurable: true,
    get: () => initial,
    set: (v) => {
      initial = inspect(v);
    },
  });

  // Responses fetched later (next video, autoplay). Proxies keep the
  // originals' native appearance.
  JSON.parse = new Proxy(JSON.parse, {
    apply: (target, self, args) => inspect(Reflect.apply(target, self, args)),
  });
  Response.prototype.json = new Proxy(Response.prototype.json, {
    apply: (target, self, args) => Reflect.apply(target, self, args).then(inspect),
  });

  // Errors can also surface from the stream rather than a response.
  setInterval(() => {
    const error = document.querySelector('#movie_player > .ytp-error');
    if (error?.innerText.trim()) reload(currentVideoId(), 'error');
  }, 500);

  // ------------------------------------------------------------- Skip button
  // Hand Skip-button handlers an event that reports isTrusted: true when the
  // event came from our own script. Only click/pointer/mouse listeners are
  // wrapped, and only events aimed at the Skip button are altered.
  const POINTER_TYPES = new Set([
    'click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'pointerover',
  ]);
  const wrappers = new WeakMap(); // listener → Map(type|capture → wrapper)
  const keyOf = (type, options) =>
    `${type}|${typeof options === 'boolean' ? options : !!options?.capture}`;

  const trustedView = (event) =>
    new Proxy(event, {
      get(target, prop) {
        if (prop === 'isTrusted') return true;
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });

  const aimedAtSkip = (event) => event.target instanceof Element && !!event.target.closest(SKIP_SELECTOR);

  const addListener = EventTarget.prototype.addEventListener;
  const removeListener = EventTarget.prototype.removeEventListener;

  EventTarget.prototype.addEventListener = new Proxy(addListener, {
    apply(target, self, args) {
      const [type, listener, options] = args;
      if (!POINTER_TYPES.has(type) || !listener) return Reflect.apply(target, self, args);
      let byKey = wrappers.get(listener);
      if (!byKey) wrappers.set(listener, (byKey = new Map()));
      const key = keyOf(type, options);
      let wrapper = byKey.get(key);
      if (!wrapper) {
        wrapper = function (event) {
          const e = !event.isTrusted && aimedAtSkip(event) ? trustedView(event) : event;
          return typeof listener === 'function' ? listener.call(this, e) : listener.handleEvent(e);
        };
        byKey.set(key, wrapper);
      }
      return Reflect.apply(target, self, [type, wrapper, options]);
    },
  });

  EventTarget.prototype.removeEventListener = new Proxy(removeListener, {
    apply(target, self, args) {
      const [type, listener, options] = args;
      const wrapper = listener && wrappers.get(listener)?.get(keyOf(type, options));
      return Reflect.apply(target, self, wrapper ? [type, wrapper, options] : args);
    },
  });
})();
