import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFilter } from '../extension/lib/filter-parser.js';

test('comments and blank lines', () => {
  assert.equal(parseFilter('! Title: EasyList').kind, 'comment');
  assert.equal(parseFilter('[Adblock Plus 2.0]').kind, 'comment');
  assert.equal(parseFilter('   ').kind, 'empty');
});

test('domain-anchored block filter with options', () => {
  const f = parseFilter('||ads.example.com^$script,third-party,domain=news.com|~blog.news.com');
  assert.equal(f.kind, 'network');
  assert.equal(f.allow, false);
  assert.equal(f.pattern, '||ads.example.com^');
  assert.deepEqual(f.resourceTypes, ['script']);
  assert.equal(f.thirdParty, true);
  assert.deepEqual(f.initiatorDomains, ['news.com']);
  assert.deepEqual(f.excludedInitiatorDomains, ['blog.news.com']);
});

test('exception, negated types, and aliases', () => {
  const f = parseFilter('@@||cdn.example.com/player.js$~image,xhr,1p');
  assert.equal(f.allow, true);
  assert.deepEqual(f.excludedResourceTypes, ['image']);
  assert.deepEqual(f.resourceTypes, ['xmlhttprequest']);
  assert.equal(f.thirdParty, false);
});

test('regex filter keeps a trailing $ inside the regex', () => {
  const f = parseFilter('/banner\\d+\\.gif$/');
  assert.equal(f.regex, 'banner\\d+\\.gif$');
  assert.equal(f.pattern, null);
});

test('regex filter with options', () => {
  const f = parseFilter('/ad[sx]?\\.js/$script');
  assert.equal(f.regex, 'ad[sx]?\\.js');
  assert.deepEqual(f.resourceTypes, ['script']);
});

test('unsupported options skip the whole filter', () => {
  assert.equal(parseFilter('||example.com^$redirect=noopjs').kind, 'unsupported');
  assert.equal(parseFilter('||example.com^$removeparam=/^utm_/').kind, 'unsupported');
  assert.equal(parseFilter('||example.com^$totallynew').reason, 'unknown-option:totallynew');
});

test('entity wildcard domains are not guessed at', () => {
  assert.equal(parseFilter('||ads.com^$domain=google.*').kind, 'unsupported');
  assert.equal(parseFilter('google.*##.ad').kind, 'unsupported');
});

test('hosts-file lines become domain anchors', () => {
  assert.equal(parseFilter('0.0.0.0 tracker.example.net').pattern, '||tracker.example.net^');
});

test('leading/trailing wildcards and ||* are normalised', () => {
  assert.equal(parseFilter('*/ads/*').pattern, '/ads/');
  assert.equal(parseFilter('||*.adnet.com^').pattern, '.adnet.com^');
});

test('internationalised domains become punycode', () => {
  const f = parseFilter('bücher.de##.ad');
  assert.deepEqual(f.domains, ['xn--bcher-kva.de']);
});

test('cosmetic filters', () => {
  assert.deepEqual(parseFilter('##.ad-banner'), {
    kind: 'cosmetic', exception: false, selector: '.ad-banner', domains: [], excludedDomains: [],
  });
  const f = parseFilter('example.com,~shop.example.com##div[id^="ad-"]');
  assert.deepEqual(f.domains, ['example.com']);
  assert.deepEqual(f.excludedDomains, ['shop.example.com']);
  assert.equal(parseFilter('example.com#@#.sponsored').exception, true);
});

test('native :has() is allowed, procedural selectors are not', () => {
  assert.equal(parseFilter('##div:has(> .ad-label)').kind, 'cosmetic');
  assert.equal(parseFilter('##div:has-text(Sponsored)').kind, 'unsupported');
  assert.equal(parseFilter('example.com#?#div:-abp-contains(Ad)').kind, 'unsupported');
  assert.equal(parseFilter('example.com##+js(set, x, 1)').kind, 'unsupported');
  assert.equal(parseFilter('example.com#$#body { overflow: auto }').kind, 'unsupported');
});

test('selectors that could inject CSS are rejected', () => {
  assert.equal(parseFilter('##.x{background:red}').kind, 'unsupported');
});

test('generichide / elemhide exceptions', () => {
  const f = parseFilter('@@||example.com^$generichide');
  assert.equal(f.generichide, true);
  assert.equal(parseFilter('||example.com^$generichide').kind, 'unsupported');
});

test('$popup filters are parsed, not skipped', () => {
  const f = parseFilter('||adnet.example^$popup,third-party');
  assert.equal(f.kind, 'network');
  assert.equal(f.popup, true);
  assert.equal(f.thirdParty, true);
});
