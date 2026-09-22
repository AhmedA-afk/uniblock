import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFilter } from '../extension/lib/filter-parser.js';
import { compileNetworkRules } from '../extension/lib/dnr-compiler.js';
import { compilePopupFilters, PopupMatcher, patternToRegex } from '../extension/lib/popup-matcher.js';

const matcher = (lines) => {
  const { popupFilters } = compileNetworkRules(lines.map(parseFilter));
  return new PopupMatcher(JSON.parse(JSON.stringify(compilePopupFilters(popupFilters))));
};

test('popup-only filters make no request rules', () => {
  const out = compileNetworkRules(['||adnet.example^$popup', '||ads.example^'].map(parseFilter));
  assert.equal(out.popupFilters.length, 1);
  assert.equal(out.rules.length, 1);
  assert.equal(out.rules[0].condition.urlFilter, '||ads.example^');
});

test('popup filter with other types keeps its request rule too', () => {
  const out = compileNetworkRules(['||x.example^$script,popup'].map(parseFilter));
  assert.equal(out.popupFilters.length, 1);
  assert.deepEqual(out.rules[0].condition.resourceTypes, ['script']);
});

test('host filters match the host and its subdomains', () => {
  const m = matcher(['||adnet.example^$popup']);
  assert.equal(m.match('https://adnet.example/click?id=1', 'https://news.example/'), 'block');
  assert.equal(m.match('https://go.adnet.example/x', 'https://news.example/'), 'block');
  assert.equal(m.match('https://notadnet.example/x', 'https://news.example/'), null);
  assert.equal(m.match('https://adnet.example.org/x', 'https://news.example/'), null);
});

test('patterns, domain scoping, third-party and exceptions', () => {
  const m = matcher([
    '/redirect/*?aff=$popup',
    '||tracker.example^$popup,domain=streams.example',
    '||cdn.example^$popup,third-party',
    '||adnet.example^$popup',
    '@@||adnet.example/login^$popup',
  ]);
  assert.equal(m.match('https://x.example/redirect/abc?aff=9', 'https://a.example/'), 'block');
  assert.equal(m.match('https://tracker.example/', 'https://www.streams.example/watch'), 'block');
  assert.equal(m.match('https://tracker.example/', 'https://other.example/'), null);
  assert.equal(m.match('https://cdn.example/x', 'https://cdn.example/page'), null); // first-party
  assert.equal(m.match('https://cdn.example/x', 'https://site.example/'), 'block');
  assert.equal(m.match('https://adnet.example/login', 'https://site.example/'), 'allow');
});

test('non-web pop-ups are never matched', () => {
  const m = matcher(['||adnet.example^$popup']);
  assert.equal(m.match('about:blank', 'https://site.example/'), null);
  assert.equal(m.match('chrome://settings', 'https://site.example/'), null);
});

test('pattern to regex', () => {
  assert.ok(new RegExp(patternToRegex('||a.example^')).test('https://sub.a.example/path'));
  assert.ok(!new RegExp(patternToRegex('||a.example^')).test('https://a.example.evil/'));
  assert.ok(new RegExp(patternToRegex('|https://x.example/*.php|')).test('https://x.example/go/ad.php'));
});
