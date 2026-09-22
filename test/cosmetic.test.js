import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFilter } from '../extension/lib/filter-parser.js';
import { compileCosmetic, CosmeticEngine, hostSuffixes } from '../extension/lib/cosmetic.js';

const engine = (lines, switches = []) =>
  new CosmeticEngine(compileCosmetic(lines.map(parseFilter), switches));
const has = (css, sel) => css.includes(sel + '{display:none!important}');

test('host suffixes', () => {
  assert.deepEqual(hostSuffixes('www.News.example.com'), ['www.news.example.com', 'news.example.com', 'example.com', 'com']);
});

test('generic selectors apply everywhere, specific only on their site and subdomains', () => {
  const e = engine(['##.ad', 'news.com##.promo']);
  assert.ok(has(e.cssFor('anything.org'), '.ad'));
  assert.ok(!has(e.cssFor('anything.org'), '.promo'));
  assert.ok(has(e.cssFor('www.news.com'), '.promo'));
});

test('exceptions remove selectors for one site', () => {
  const e = engine(['##.ad', 'news.com##.promo', 'shop.com#@#.ad', 'news.com#@#.promo']);
  assert.ok(!has(e.cssFor('shop.com'), '.ad'));
  assert.ok(has(e.cssFor('other.com'), '.ad'));
  assert.ok(!has(e.cssFor('news.com'), '.promo'));
});

test('negated domains', () => {
  const e = engine(['~wiki.org##.banner', 'site.com,~m.site.com##.side']);
  assert.ok(!has(e.cssFor('en.wiki.org'), '.banner'));
  assert.ok(has(e.cssFor('site.com'), '.side'));
  assert.ok(!has(e.cssFor('m.site.com'), '.side'));
});

test('generichide keeps site-specific hiding, elemhide switches all off', () => {
  const e = engine(['##.ad', 'a.com##.promo', 'b.com##.promo'], [
    { host: 'a.com', type: 'generichide' },
    { host: 'b.com', type: 'elemhide' },
  ]);
  const a = e.cssFor('a.com');
  assert.ok(!has(a, '.ad') && has(a, '.promo'));
  assert.equal(e.cssFor('b.com'), '');
});
