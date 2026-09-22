// Answers cookie banners for the user, with the choice they set in the popup:
//   accept    — accept all
//   essential — keep only strictly necessary cookies
//   reject    — same, and also switch off "legitimate interest" toggles,
//               which a plain Reject button often leaves on
//
// Local first: find the banner and sort its buttons with patterns in several
// languages. If the banner only offers Accept + Customize, open the settings,
// switch off every optional toggle and save. Only when the patterns can't
// tell which button is which does the extension ask Jev, with just the
// banner heading and button labels (never page content), cached per site.
(() => {
  if (globalThis.__uniblockCookies) return;
  globalThis.__uniblockCookies = true;

  // Containers of common consent platforms; the generic check covers the rest.
  const CMP_ROOTS = [
    '#onetrust-banner-sdk', '#onetrust-pc-sdk', '#CybotCookiebotDialog', '#didomi-host',
    '.qc-cmp2-container', '#usercentrics-root', '#usercentrics-cmp-ui', '#truste-consent-track',
    '#truste-consent-content', '[id^="sp_message_container"]', '.cky-consent-container',
    '.cky-preference-center', '.cmplz-cookiebanner', '.osano-cm-window', '.fc-consent-root',
    '#cookiebanner', '#cookie-banner', '#cookie-consent', '.cookie-banner', '.cookie-consent',
    '[aria-label*="cookie" i]', '[aria-label*="consent" i]',
  ].join(',');

  const ABOUT_COOKIES = /cookie|consent|gdpr|privacy|tracking|datenschutz|einwillig|consentement|consentimiento|privacidad|confidentialit/i;

  // Button meanings. Order matters: more specific first.
  const KINDS = [
    ['reject', /^(reject|decline|deny|refuse|disagree|reject all|decline all|deny all|refuse all|reject (all )?(optional|non-essential|additional) cookies|i (do not|don't) (accept|agree)|no,? thanks|disagree (and|&) close|deny (and|&) close|reject (and|&) close|alle ablehnen|ablehnen|tout refuser|refuser|rechazar( todo)?|rifiuta( tutto)?|weigeren|alles weigeren|odrzuć( wszystko)?)$/i],
    ['essential', /(only|just|use) (strictly )?(necessary|essential|required)( cookies)?|necessary( cookies)? only|essential( cookies)? only|accept (only )?(necessary|essential|required)|continue without (accepting|agreeing|consent)|nur (notwendige|erforderliche|essenzielle)|uniquement (les )?(nécessaires|essentiels)|solo (necesarias|esenciales|necessari)/i],
    ['settings', /^(customi[sz]e|manage|settings|preferences|options|more options|cookie settings|manage (cookies|settings|preferences|options|choices)|let me choose|show purposes|einstellungen|anpassen|personnaliser|paramètres|configurar|preferencias|gestisci|impostazioni)/i],
    ['save', /^(save|confirm|submit|apply|done|save (and|&) (exit|close)|save (my )?(choices|preferences|settings)|confirm (my )?choices|allow selection|accept selected|speichern|auswahl (speichern|bestätigen)|enregistrer|confirmer|guardar|salva|conferma)/i],
    ['accept', /^(accept|agree|allow|ok|okay|got it|i agree|i accept|accept (all|cookies|all cookies)|allow (all|cookies|all cookies)|agree (and|&) (close|continue)|alle akzeptieren|akzeptieren|zustimmen|tout accepter|accepter|aceptar( todo)?|accetta( tutto)?|accepteren|alles accepteren)/i],
  ];
  // "Pay or OK": refusing means subscribing (seen on marca.com: "Rechazo y me
  // suscribo"). Such a button is never pressed automatically.
  const PAYS = /subscri|suscri|abonn|abonnier|\babo\b|pur-abo|\bpay\b|\bpaid\b|payment|ad-free|werbefrei|sans pub|sin publicidad|senza pubblicità|buy|kaufen|acheter|comprar/i;
  const LEGITIMATE_INTEREST = /legitimate interest|berechtigtes interesse|intérêt légitime|interés legítimo|legittimo interesse/i;
  // Categories that are clearly optional: switched off without asking Jev.
  const OPTIONAL = /analytic|performance|statistic|measure|marketing|target|advertis|\bads?\b|personali[sz]|social media|tracking|audience|statistik|werbung|mesure|publicit|publicidad|estad[ií]stic|pubblicit|statistich/i;
  const NECESSARY = /strictly necessary|necessary|essential|required|always active|unbedingt erforderlich|notwendig|essenziell|nécessaire|necesari|necessari/i;

  // Our own hiding (sites/cookie-hide.css, or hideOnSight below) doesn't make
  // a banner "not there": it still has a size and its buttons still work.
  const HIDDEN_BY_US = '[data-uniblock-cookie="hidden"]';
  // Crosses shadow boundaries, which Element.closest does not: a banner we
  // hid is often a shadow host with the buttons inside it.
  function closestDeep(el, selector) {
    for (let e = el; e; e = e.parentElement ?? (e.getRootNode() instanceof ShadowRoot ? e.getRootNode().host : null)) {
      if (e.matches?.(selector)) return e;
    }
    return null;
  }
  const ourHiding = (el) => !!closestDeep(el, HIDDEN_BY_US)
    || (!document.documentElement.classList.contains('uniblock-cookie-reveal') && !!closestDeep(el, CMP_ROOTS));

  const visible = (el) => {
    if (!el?.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none') return false;
    if (ourHiding(el)) return true;
    return s.visibility !== 'hidden' && Number(s.opacity) > 0.05;
  };

  // Take the banner off screen the moment it's found, before answering it.
  // Known platforms are already invisible via sites/cookie-hide.css.
  function hideOnSight(el) {
    if (el.dataset.uniblockCookie) return;
    el.dataset.uniblockCookie = 'hidden';
    el.style.setProperty('visibility', 'hidden', 'important');
  }

  // Give the page back its banner: we couldn't answer it, so the reader must.
  function reveal(banner) {
    document.documentElement.classList.add('uniblock-cookie-reveal');
    if (banner?.dataset.uniblockCookie) {
      delete banner.dataset.uniblockCookie;
      banner.style.removeProperty('visibility');
    }
  }
  // innerText is empty for anything invisible, including banners we hide
  // ourselves, so fall back to the raw text.
  const textIn = (el) => el.innerText || el.textContent || '';
  const label = (el) => (textIn(el) || el.value || el.getAttribute('aria-label') || el.title || '').replace(/\s+/g, ' ').trim();

  // Shadow roots, including closed ones: Usercentrics draws its banner in a
  // closed shadow root that page scripts can't see into (seen 2026-09-19);
  // extensions can, through chrome.dom.
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

  // All elements under root, including inside shadow roots.
  function* deep(root, selector) {
    yield* root.querySelectorAll(selector);
    for (const el of root.querySelectorAll('*')) {
      const sr = shadowOf(el);
      if (sr) yield* deep(sr, selector);
    }
  }

  // Visible text of an element, including text inside its shadow roots
  // (innerText stops at a shadow host).
  function textOf(el) {
    let text = textIn(el);
    const sr = shadowOf(el);
    if (sr) text += ' ' + [...sr.children].map(textOf).join(' ');
    for (const child of el.querySelectorAll('*')) {
      const csr = shadowOf(child);
      if (csr) text += ' ' + [...csr.children].map(textOf).join(' ');
    }
    return text;
  }

  // The element under a point, looking inside shadow roots.
  function deepElementAt(x, y) {
    let el = document.elementFromPoint(x, y);
    for (let i = 0; el && i < 10; i++) {
      const sr = shadowOf(el);
      const inner = sr?.elementFromPoint?.(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  // Parent element, stepping out of a shadow root to its host.
  const parentOf = (el) => el.parentElement ?? (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);

  const isLayer = (el) => {
    const pos = getComputedStyle(el).position;
    return pos === 'fixed' || pos === 'sticky' || el.matches('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]');
  };

  // A banner: a known platform container, or the overlay (fixed/sticky layer
  // or dialog) under one of a few points where banners sit, that talks about
  // cookies and has buttons. A platform's host element can be 0 px tall with
  // its dialog positioned inside, so visibility is judged by the buttons.
  function findBanner() {
    for (const el of deep(document, CMP_ROOTS)) {
      if (ABOUT_COOKIES.test(textOf(el)) && buttonsIn(el).length) return el;
    }
    const W = innerWidth;
    const H = innerHeight;
    const points = [[0.5, 0.5], [0.5, 0.92], [0.15, 0.92], [0.85, 0.92], [0.5, 0.08], [0.15, 0.5], [0.85, 0.5]];
    for (const [fx, fy] of points) {
      let best = null;
      for (let el = deepElementAt(W * fx, H * fy), i = 0; el && el !== document.body && i < 30; el = parentOf(el), i++) {
        if (!isLayer(el)) continue;
        const text = textOf(el);
        if (text.length > 3000) break;
        if (/cookie|consent|privacy/i.test(text) && buttonsIn(el).length) best = el;
      }
      if (best) return best;
    }
    return null;
  }

  // Clickable things that stay on the page (links to other pages are not
  // buttons: never navigate the user away).
  function buttonsIn(root) {
    const sr = root.nodeType === Node.ELEMENT_NODE ? shadowOf(root) : null;
    const selector = 'button, [role="button"], input[type="button"], input[type="submit"], a';
    const all = [...deep(root, selector), ...(sr ? deep(sr, selector) : [])];
    return all.filter((el) => {
      if (!visible(el) || el.disabled) return false;
      const text = label(el);
      if (!text || text.length > 60) return false;
      if (el.tagName === 'A') {
        const href = el.getAttribute('href') ?? '';
        if (href && !href.startsWith('#') && !href.startsWith('javascript:')) return false;
      }
      return true;
    });
  }

  const kindOf = (text) => KINDS.find(([, re]) => re.test(text))?.[0] ?? null;

  function sortButtons(root) {
    const found = {};
    for (const el of buttonsIn(root)) {
      if (PAYS.test(label(el))) continue;
      const k = kindOf(label(el));
      if (k && !found[k]) found[k] = el;
    }
    return found;
  }

  function press(el) {
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      el.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, { ...at, pointerType: 'mouse' }) : new MouseEvent(type, at));
    }
    el.click();
  }

  // Optional-category toggles in a settings panel: checkboxes and switches
  // that aren't locked on as necessary.
  function toggles(root) {
    const out = [];
    for (const el of deep(root, 'input[type="checkbox"], [role="switch"], [role="checkbox"]')) {
      const box = el.closest('label, li, tr, [class*="category" i], [class*="purpose" i], [class*="toggle" i], div') ?? el.parentElement;
      const text = (box ? textIn(box) : label(el)).replace(/\s+/g, ' ').trim().slice(0, 120);
      const on = el.matches('input') ? el.checked : el.getAttribute('aria-checked') === 'true';
      const locked = el.disabled || el.getAttribute('aria-disabled') === 'true';
      out.push({ el, text, on, locked });
    }
    return out;
  }

  function switchOff(t) {
    if (!t.on || t.locked) return false;
    // Click the control (sites listen for clicks, not property changes).
    const target = t.el.matches('input') ? (t.el.closest('label') ?? t.el) : t.el;
    press(target);
    if (t.el.matches('input') && t.el.checked) {
      t.el.checked = false;
      t.el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  }

  // ---------------------------------------------------------------- Jev
  // Asks the background (which asks the local Jev proxy) which buttons mean
  // what, when the patterns found no usable button. Only labels leave.
  async function askJev(banner, candidates) {
    const heading = textOf(banner).replace(/\s+/g, ' ').trim().slice(0, 300);
    const res = await chrome.runtime.sendMessage({
      type: 'cookieAsk',
      host: location.hostname,
      heading,
      buttons: candidates.map(label),
    }).catch(() => null);
    if (!res?.ok || !res.result) return {};
    const out = {};
    for (const [kind, index] of Object.entries(res.result)) {
      if (index !== null && candidates[index] && !PAYS.test(label(candidates[index]))) out[kind] = candidates[index];
    }
    return out;
  }

  async function askJevToggles(items) {
    const res = await chrome.runtime.sendMessage({ type: 'cookieToggles', host: location.hostname, toggles: items.map((t) => t.text) })
      .catch(() => null);
    return res?.ok ? res.result : null; // [probability the category is strictly necessary]
  }

  // ------------------------------------------------------------ answering
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Developer aid: set chrome.storage.local.cookieDebug = true to log what
  // the script sees and does on each page (in the page's console).
  let debug = false;
  // The last few decisions are always kept (not only in debug mode) so the
  // popup's debug snapshot can show what happened on a real page.
  const recent = [];
  const log = (...args) => {
    const line = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
    recent.push(`${Math.round(performance.now())}ms ${line}`.slice(0, 400));
    if (recent.length > 40) recent.shift();
    if (debug) console.debug('[uniblock cookies]', location.hostname, line);
  };
  globalThis.__uniblockCookiesDiagnose = () => ({ recent: [...recent], done, busy });
  let busy = false;
  let done = false;

  // After opening settings: the panel may replace the banner or open beside
  // it while the banner stays (OneTrust's #onetrust-pc-sdk next to its
  // banner, seen on theverge.com). Prefer a container other than the banner
  // that has toggles or a save button.
  function findPanel(banner) {
    const candidates = [...deep(document, CMP_ROOTS), findBanner()].filter(Boolean);
    const useful = (el) => toggles(el).length || sortButtons(el).save;
    return candidates.find((el) => el !== banner && !banner.contains(el) && useful(el))
      ?? candidates.find(useful)
      ?? document.body;
  }

  async function settleSettings(mode, banner) {
    // Watch for the panel instead of waiting a fixed time: it must be hidden
    // the moment it appears, or the reader sees it.
    let panel = document.body;
    for (let i = 0; i < 30; i++) {
      await sleep(30);
      const found = findPanel(banner);
      if (found !== document.body && (toggles(found).length || sortButtons(found).save)) {
        panel = found;
        break;
      }
    }
    if (panel !== document.body) hideOnSight(panel); // the reader shouldn't see this either
    log('panel', panel.id || panel.className?.toString().slice(0, 40), 'toggles', toggles(panel).map((t) => `${t.text.slice(0, 30)}${t.locked ? ' (locked)' : ''}${t.on ? ' on' : ' off'}`));
    const optional = toggles(panel).filter((t) => {
      if (t.locked || !t.on) return false;
      if (LEGITIMATE_INTEREST.test(t.text)) return mode === 'reject';
      return !NECESSARY.test(t.text);
    });
    // Clearly optional categories go off at once. Categories named otherwise
    // ("Security", "Load balancing") could still be necessary: only those wait
    // for Jev (~1 s), and go off unless Jev says they're necessary.
    const known = (t) => OPTIONAL.test(t.text) || LEGITIMATE_INTEREST.test(t.text);
    const unclear = optional.filter((t) => !known(t));
    optional.filter(known).forEach(switchOff);
    const necessary = unclear.length ? await askJevToggles(unclear) : null;
    unclear.forEach((t, i) => {
      if (!necessary || !(necessary[i] >= 0.6)) switchOff(t);
    });
    // "Object to all" for legitimate interest, then save.
    if (mode === 'reject') {
      const object = buttonsIn(panel).find((b) => /object (to )?all|reject all legitimate/i.test(label(b)));
      if (object) press(object);
    }
    const buttons = sortButtons(panel);
    const save = buttons.save ?? buttons.reject ?? buttons.essential;
    if (save) press(save);
    return !!save;
  }

  async function answer(mode) {
    const banner = findBanner();
    if (!banner) {
      log('no banner found');
      return false;
    }
    hideOnSight(banner);
    log('banner', banner.tagName, banner.id, banner.className?.toString().slice(0, 60),
      'buttons', buttonsIn(banner).map((b) => `${label(b)} → ${kindOf(label(b))}`));
    let buttons = sortButtons(banner);
    const recognised = mode === 'accept' ? buttons.accept : (buttons.reject || buttons.essential || buttons.settings);
    if (!recognised) {
      buttons = { ...buttons, ...(await askJev(banner, buttonsIn(banner))) };
    }

    let acted = false;
    if (mode === 'accept' && buttons.accept) {
      press(buttons.accept);
      acted = true;
    } else if (mode !== 'accept') {
      // "Reject all" on the banner covers consent; "reject" mode still goes
      // through settings when there is one, to reach legitimate interest.
      const rejectButton = buttons.reject ?? buttons.essential;
      if (rejectButton && !(mode === 'reject' && buttons.settings && LEGITIMATE_INTEREST.test(textOf(banner)))) {
        press(rejectButton);
        acted = true;
      } else if (buttons.settings) {
        press(buttons.settings);
        acted = await settleSettings(mode, banner);
      }
    }
    log('acted', acted, Object.fromEntries(Object.entries(buttons).map(([k, v]) => [k, label(v)])));
    if (!acted && mode !== 'accept' && buttonsIn(banner).some((b) => PAYS.test(label(b)))) {
      log('pay-or-ok: refusing needs a subscription; leaving the choice to the user');
      reveal(banner);
      chrome.runtime.sendMessage({ type: 'cookiePayOrOk', host: location.hostname }).catch(() => {});
      return true; // answered as far as we will: don't keep retrying
    }
    if (!acted) {
      log('could not answer; revealing the banner for the reader');
      reveal(banner);
      return false;
    }

    await sleep(500);
    // If the site left its banner on screen, take it off (and any scroll lock).
    const left = findBanner();
    if (left && left === banner) {
      banner.style.setProperty('display', 'none', 'important');
      for (const el of [document.documentElement, document.body]) {
        if (getComputedStyle(el).overflow === 'hidden') el.style.setProperty('overflow', 'auto', 'important');
      }
    }
    chrome.runtime.sendMessage({ type: 'cookieHandled', mode, host: location.hostname }).catch(() => {});
    return true;
  }

  async function run() {
    if (busy || done) return;
    busy = true;
    try {
      const { cookieMode = 'off', paused = [], cookieDebug = false } = await chrome.storage.local.get(['cookieMode', 'paused', 'cookieDebug']);
      debug = cookieDebug;
      log('run', cookieMode, 'frame', window === top ? 'top' : location.href.slice(0, 60));
      const host = location.hostname;
      if (cookieMode === 'off' || paused.some((h) => host === h || host.endsWith('.' + h))) return;
      done = await answer(cookieMode);
    } finally {
      busy = false;
    }
  }

  // Banners usually arrive a moment after load; watch for them for a while.
  // Changes inside shadow roots don't reach a document observer, so also
  // check every second.
  // Fast at first (a banner hidden from the reader must be answered quickly),
  // then slower for late ones.
  let poll = setInterval(run, 100);
  setTimeout(() => {
    clearInterval(poll);
    poll = setInterval(run, 1000);
    setTimeout(() => clearInterval(poll), 20_000);
  }, 6000);
  // Nothing stays invisible for long without an answer.
  setTimeout(() => {
    if (!done) {
      log('giving up: revealing any banner we hid');
      reveal(document.querySelector(HIDDEN_BY_US));
    }
  }, 8000);
  let timer = null;
  const observer = new MutationObserver(() => {
    timer ??= setTimeout(() => {
      timer = null;
      run();
    }, 40);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 20_000);
  run();
})();
