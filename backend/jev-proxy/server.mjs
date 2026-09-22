// Prototype: classifies feed posts as ads with Jev (TypeSafe), for the
// extension's experimental "Jev classifier" mode. Runs on the user's machine
// and holds the TypeSafe key, which must never ship inside the extension.
//
//   node --env-file=<file with TYPESAFE_API_KEY> backend/jev-proxy/server.mjs
//
// Design (TypeSafe guidance: narrow judgments, decisions in code):
//   one request per post, state = only that post, three Nouls —
//     label: the header carries a paid-promotion label (possibly scrambled)
//     promo: the post mainly promotes a product/service/offer
//     cta:   its buttons include a commercial call to action
//   decide(): label alone is enough; promo + cta together is "likely ad".
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const PORT = Number(process.env.JEV_PROXY_PORT ?? 8787);
const KEY = process.env.TYPESAFE_API_KEY;
const MODEL = process.env.JEV_MODEL ?? 'jev-1.13.0'; // pinned: thresholds are tuned per version
if (!KEY) {
  console.error('TYPESAFE_API_KEY is not set');
  process.exit(1);
}

const QUESTIONS = {
  label: {
    type: 'noul',
    instructions:
      'Does `post.header` contain a label saying the post is paid or sponsored, such as "Sponsored", '
      + '"Promoted", "Ad", or "Paid partnership"? The label may be in another language, or have its '
      + 'letters split apart, repeated, or mixed with stray characters.',
    criteria: {
      true: 'A paid-promotion label is present in `post.header`, even if garbled.',
      false: 'No paid-promotion label; the header only names the author, time, or audience.',
    },
  },
  promo: {
    type: 'noul',
    instructions:
      'Is `post.text` mainly promoting a product, service, app, course, or offer to the reader?',
    criteria: {
      true: 'The main purpose of the text is to get the reader to buy, sign up, install, or visit.',
      false: 'The text is news, opinion, a personal update, or discussion, even if it mentions a brand.',
    },
  },
  cta: {
    type: 'noul',
    instructions:
      'Does `post.buttons` contain a commercial call to action such as "Shop now", "Sign up", '
      + '"Install", "Learn more", "Book now", "Get offer", or "Download"?',
    criteria: {
      true: 'At least one button invites a purchase, sign-up, install, or visit to an advertiser.',
      false: 'Only ordinary social actions such as Like, Comment, Share, Follow, Reply, or Repost.',
    },
  },
};

// Starting thresholds, to be evaluated on real labelled posts, not trusted.
export function decide({ label, promo, cta }) {
  if (label >= 0.8) return 'ad';
  if (promo >= 0.8 && cta >= 0.8) return 'likely-ad';
  return 'content';
}

const cache = new Map(); // post fingerprint → result (bounded)
const CACHE_MAX = 5000;

async function classify(post) {
  const state = {
    post: {
      site: post.site,
      header: post.header.slice(0, 300),
      text: post.text.slice(0, 1200),
      buttons: post.buttons.slice(0, 12),
      link_domains: post.linkDomains.slice(0, 6),
    },
  };
  const fp = createHash('sha256').update(JSON.stringify(state)).digest('hex');
  if (cache.has(fp)) return cache.get(fp);

  const t0 = performance.now();
  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, state, questions: QUESTIONS }),
  });
  if (!res.ok) throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const scores = Object.fromEntries(Object.keys(QUESTIONS).map((k) => [k, body.answers[k].noul]));
  const result = {
    scores,
    verdict: decide(scores),
    ms: Math.round(performance.now() - t0),
    tokens: body.usage?.input_tokens ?? null,
    model: body.model,
  };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(fp, result);
  return result;
}

// Cookie banners: which of the banner's buttons does what. One Choice per
// intent over the button labels, plus "none"; code keeps confident answers.
const COOKIE_INTENTS = {
  accept: 'accept all cookies',
  reject: 'refuse all optional cookies, so that only strictly necessary ones are used',
  settings: 'open detailed cookie settings where categories can be chosen one by one',
  save: 'save the choices currently selected in the cookie settings and close them',
};
const COOKIE_CONFIDENT = 0.6;

async function systemOne(state, questions) {
  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, state, questions }),
  });
  if (!res.ok) throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function cookieButtons({ heading, buttons }) {
  const criteria = Object.fromEntries(buttons.map((b, i) => [`b${i}`, `The button labelled "${b}"`]));
  criteria.none = 'None of these buttons does this.';
  const questions = Object.fromEntries(Object.entries(COOKIE_INTENTS).map(([k, intent]) => [k, {
    type: 'choice',
    instructions: `On the cookie banner in \`banner\`, which button does a visitor press to ${intent}?`,
    criteria,
  }]));
  const body = await systemOne({ banner: { text: heading, buttons } }, questions);
  const result = {};
  for (const k of Object.keys(COOKIE_INTENTS)) {
    const a = body.answers[k];
    result[k] = a.choice !== 'none' && a.confidence >= COOKIE_CONFIDENT ? Number(a.choice.slice(1)) : null;
  }
  console.log(JSON.stringify({ cookie: 'buttons', heading: heading.slice(0, 80), buttons, result }));
  return result;
}

async function cookieToggles({ toggles }) {
  const questions = Object.fromEntries(toggles.map((t, i) => [`t${i}`, {
    type: 'noul',
    instructions: `Is the cookie category described in \`categories[${i}]\` strictly necessary for the website to work (security, login, load balancing, remembering this consent choice), rather than analytics, personalisation or advertising?`,
  }]));
  const body = await systemOne({ categories: toggles }, questions);
  const result = toggles.map((_, i) => body.answers[`t${i}`].noul);
  console.log(JSON.stringify({ cookie: 'toggles', n: toggles.length, result }));
  return result;
}

function isPost(p) {
  return p && typeof p.header === 'string' && typeof p.text === 'string'
    && Array.isArray(p.buttons) && Array.isArray(p.linkDomains);
}

const server = http.createServer(async (req, res) => {
  const reply = (status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true, model: MODEL });

  // Dev only: page-structure snapshots from the extension's debug button,
  // saved locally so a developer can see what uniblock saw on a real page.
  if (req.method === 'POST' && req.url === '/debug') {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 5_000_000) return reply(413, { error: 'too large' });
    }
    const dir = new URL('./snapshots/', import.meta.url);
    mkdirSync(dir, { recursive: true });
    const snap = JSON.parse(raw);
    const base = `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(snap.host ?? 'page').replace(/[^\w.-]/g, '_')}`;
    if (typeof snap.screenshot === 'string' && snap.screenshot.startsWith('data:image/png;base64,')) {
      writeFileSync(new URL(`${base}.png`, dir), Buffer.from(snap.screenshot.split(',')[1], 'base64'));
      snap.screenshot = `${base}.png`;
    }
    const file = new URL(`${base}.json`, dir);
    writeFileSync(file, JSON.stringify(snap));
    console.log(JSON.stringify({ snapshot: file.pathname }));
    return reply(200, { saved: file.pathname });
  }
  if (req.method === 'POST' && (req.url === '/cookie/buttons' || req.url === '/cookie/toggles')) {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 50_000) return reply(413, { error: 'too large' });
    }
    try {
      const body = JSON.parse(raw);
      if (req.url === '/cookie/buttons') {
        if (!Array.isArray(body.buttons) || !body.buttons.length || body.buttons.length > 12) return reply(400, { error: 'buttons: 1-12 labels' });
        return reply(200, { result: await cookieButtons(body) });
      }
      if (!Array.isArray(body.toggles) || !body.toggles.length || body.toggles.length > 30) return reply(400, { error: 'toggles: 1-30 labels' });
      return reply(200, { result: await cookieToggles(body) });
    } catch (e) {
      return reply(502, { error: e.message });
    }
  }
  if (req.method !== 'POST' || req.url !== '/classify') return reply(404, { error: 'not found' });

  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 200_000) return reply(413, { error: 'too large' });
  }
  let posts;
  try {
    ({ posts } = JSON.parse(raw));
  } catch {
    return reply(400, { error: 'bad json' });
  }
  if (!Array.isArray(posts) || !posts.every(isPost) || posts.length > 20) {
    return reply(400, { error: 'expected { posts: [...] } with at most 20 posts' });
  }
  // Posts are independent: one request each, in parallel.
  const results = await Promise.all(posts.map((p) => classify(p).catch((e) => ({ error: e.message }))));
  for (const [i, r] of results.entries()) {
    console.log(JSON.stringify({ site: posts[i].site, ...r }));
  }
  reply(200, { results });
});

// Only reachable from this machine.
server.listen(PORT, '127.0.0.1', () => console.log(`jev-proxy on http://127.0.0.1:${PORT} (model ${MODEL})`));
