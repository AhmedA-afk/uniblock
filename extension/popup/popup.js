const $ = (id) => document.getElementById(id);

const send = async (msg) => {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res?.ok) throw new Error(res?.error ?? 'no response');
  return res.result;
};

function ago(ts) {
  if (!ts) return 'never';
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
let hostname = null;
try {
  const url = new URL(tab?.url ?? '');
  if (url.protocol === 'http:' || url.protocol === 'https:') hostname = url.hostname;
} catch {}

// Opening the popup grants activeTab, which lets us read which rules matched
// on this tab without the broader feedback permission.
async function blockedCount() {
  try {
    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ tabId: tab.id });
    const ids = [...new Set(rulesMatchedInfo.map((m) => m.rule.ruleId))];
    if (!ids.length) return '0';
    const rules = await chrome.declarativeNetRequest.getDynamicRules({ ruleIds: ids });
    const blocking = new Set(rules.filter((r) => r.action.type === 'block').map((r) => r.id));
    return String(rulesMatchedInfo.filter((m) => blocking.has(m.rule.ruleId)).length);
  } catch {
    return '—';
  }
}

async function render() {
  const state = await send({ type: 'state', hostname });

  $('host').textContent = hostname ?? 'Not a web page';
  $('blocked').textContent = hostname ? await blockedCount() : '0';

  $('site-toggle').hidden = !hostname;
  const toggle = $('enabled');
  toggle.checked = hostname ? !state.paused : false;
  toggle.disabled = !hostname || state.pausedByParent;
  $('enabled-label').textContent = hostname
    ? (state.paused ? 'Paused on this site' : 'Blocking on this site')
    : 'Nothing to block here';
  $('note').hidden = !state.pausedByParent;
  $('note').textContent = state.pausedByParent ? 'Paused for a parent domain of this site.' : '';

  $('lists').replaceChildren(...state.lists.map((l) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = l.name;
    const when = document.createElement('span');
    when.className = l.error && !l.updatedAt ? 'error' : 'when';
    when.textContent = l.error && !l.updatedAt ? 'download failed' : ago(l.updatedAt);
    if (l.error) when.title = l.error;
    li.append(name, when);
    return li;
  }));

  const s = state.stats;
  $('meta').textContent = s
    ? `${s.networkRules.toLocaleString()} network rules · ${s.cosmeticFilters.toLocaleString()} hiding filters`
    : 'Lists not loaded yet.';

  const n = state.videoAdsStopped;
  const sp = state.sponsoredHidden;
  const bits = [];
  if (n) bits.push(`${n.toLocaleString()} video ad ${n === 1 ? 'break' : 'breaks'} stopped`);
  if (sp) bits.push(`${sp.toLocaleString()} sponsored ${sp === 1 ? 'post' : 'posts'} hidden`);
  const pb = state.popupsBlocked;
  if (pb) bits.push(`${pb.toLocaleString()} pop-up ${pb === 1 ? 'tab' : 'tabs'} closed`);
  const w = state.wallsRemoved;
  if (w) bits.push(`${w.toLocaleString()} ad-blocker ${w === 1 ? 'wall' : 'walls'} removed`);
  $('skipped').hidden = !bits.length;
  $('skipped').textContent = `${bits.join(' · ')} so far`;
  const saved = Math.round(state.adSecondsSaved ?? 0);
  $('saved').hidden = saved < 1;
  $('saved').textContent = `${saved >= 60 ? `${Math.floor(saved / 60)} min ${saved % 60} s` : `${saved} s`} of video ads skipped`;

  $('cookie-mode').value = state.cookieMode;
  $('cookie-note').textContent = {
    off: 'uniblock leaves cookie banners alone.',
    essential: 'Keeps only cookies a site needs to work.',
    reject: 'Also switches off "legitimate interest" tracking.',
    accept: 'Accepts every cookie banner.',
  }[state.cookieMode] + (state.cookiesHandled ? ` ${state.cookiesHandled} answered so far.` : '');

  $('jev').checked = state.jev.enabled;
  const js = state.jev.stats;
  $('jev-note').textContent = !state.jev.enabled
    ? 'Sends feed post text to the local Jev proxy, which forwards it to TypeSafe.'
    : !state.jev.proxyUp
      ? 'Proxy not running: start backend/jev-proxy. Posts are left alone until it is.'
      : `${js?.classified ?? 0} posts checked · ${js?.hidden ?? 0} hidden · ${js?.shownByUser ?? 0} un-hidden by you`;

  // Only for development: shown while the local proxy is running.
  $('dev').hidden = !(hostname && state.jev.proxyUp);

  $('update').disabled = state.updating;
  $('update').textContent = state.updating ? 'Updating…' : 'Update now';

  $('credits').replaceChildren(...state.lists.flatMap((l, i) => {
    const a = document.createElement('a');
    a.href = l.homepage;
    a.target = '_blank';
    a.textContent = `${l.name} (${l.license})`;
    return i ? [', ', a] : [a];
  }));
}

$('enabled').addEventListener('change', async (e) => {
  await send({ type: 'setPaused', hostname, paused: !e.target.checked });
  await chrome.tabs.reload(tab.id);
  await render();
});

$('cookie-mode').addEventListener('change', async (e) => {
  await send({ type: 'setCookieMode', mode: e.target.value });
  await render();
});

$('jev').addEventListener('change', async (e) => {
  await send({ type: 'setJev', enabled: e.target.checked });
  await render();
});

$('snapshot').addEventListener('click', async () => {
  $('snapshot').disabled = true;
  $('snapshot-note').textContent = 'Capturing…';
  try {
    const saved = await send({ type: 'debugSnapshot', tabId: tab.id });
    $('snapshot-note').textContent = `Saved ${saved.split('/').pop()}`;
  } catch (e) {
    $('snapshot-note').textContent = `Failed: ${e.message}`;
  } finally {
    $('snapshot').disabled = false;
  }
});

$('update').addEventListener('click', async () => {
  $('update').disabled = true;
  $('update').textContent = 'Updating…';
  try {
    await send({ type: 'update' });
  } finally {
    await render();
  }
});

await render();
