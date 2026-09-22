import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFilter } from '../extension/lib/filter-parser.js';
import { compileNetworkRule, compileNetworkRules, PRIORITY } from '../extension/lib/dnr-compiler.js';

const compile = (line) => compileNetworkRule(parseFilter(line));

test('block rule', () => {
  assert.deepEqual(compile('||Ads.Example.com^$script,third-party,domain=news.com').rule, {
    priority: PRIORITY.block,
    action: { type: 'block' },
    condition: {
      urlFilter: '||ads.example.com^',
      initiatorDomains: ['news.com'],
      domainType: 'thirdParty',
      resourceTypes: ['script'],
    },
  });
});

test('match-case keeps case', () => {
  const { rule } = compile('/Banner/$match-case');
  assert.equal(rule.condition.regexFilter, 'Banner');
  assert.equal(rule.condition.isUrlFilterCaseSensitive, true);
});

test('priorities follow list precedence', () => {
  assert.equal(compile('||a.com^').rule.priority, PRIORITY.block);
  assert.equal(compile('@@||a.com^').rule.priority, PRIORITY.allow);
  assert.equal(compile('||a.com^$important').rule.priority, PRIORITY.importantBlock);
  assert.equal(compile('@@||a.com^$important').rule.priority, PRIORITY.importantAllow);
  assert.ok(PRIORITY.block < PRIORITY.allow && PRIORITY.allow < PRIORITY.importantBlock);
});

test('$document exception allows the whole page', () => {
  const { rule } = compile('@@||bank.example^$document');
  assert.equal(rule.action.type, 'allowAllRequests');
  assert.deepEqual(rule.condition.resourceTypes, ['main_frame', 'sub_frame']);
});

test('$document block targets the page itself', () => {
  assert.deepEqual(compile('||malware.example^$document').rule.condition.resourceTypes, ['main_frame']);
});

test('negated types keep main_frame excluded', () => {
  assert.deepEqual(compile('||a.com^$~image').rule.condition.excludedResourceTypes, ['image', 'main_frame']);
});

test('$all includes every type', () => {
  assert.ok(compile('||bad.example^$all').rule.condition.resourceTypes.includes('main_frame'));
});

test('invalid for Chrome → skipped, not emitted', () => {
  assert.equal(compile('/ad(?!min)/').skip, 'regex-not-re2');
  assert.equal(compile('foo|bar').skip, 'bad-anchor');
  assert.equal(compile('$script').skip, 'too-broad');
  assert.equal(compile('||a.com^$image,~image').skip, 'no-resource-types');
});

test('empty pattern is fine when scoped to a site', () => {
  const { rule } = compile('$script,third-party,domain=example.com');
  assert.equal(rule.condition.urlFilter, undefined);
  assert.deepEqual(rule.condition.initiatorDomains, ['example.com']);
});

test('hide switches come out separately', () => {
  assert.deepEqual(compile('@@||example.com^$elemhide').hide, { host: 'example.com', type: 'elemhide' });
});

test('ruleset: dedupe, exceptions first, caps', () => {
  const filters = ['/ads/a', '/ads/a', '/ads/b', '@@||c.com^', '/x\\d/', '/y\\d/'].map(parseFilter);
  const out = compileNetworkRules(filters, { maxRules: 3, maxRegexRules: 1 });
  assert.equal(out.rules.length, 3);
  assert.equal(out.rules[0].action.type, 'allow');
  assert.equal(out.skipped.duplicate, 1);
  assert.equal(out.skipped['over-cap'], 2);
});

test('host-only rules with the same conditions merge into requestDomains', () => {
  const filters = ['||a.com^', '||b.com^', '||c.com^$script', '||d.com/path', '@@||e.com^'].map(parseFilter);
  const { rules } = compileNetworkRules(filters);
  const merged = rules.find((r) => r.condition.requestDomains);
  assert.deepEqual(merged.condition.requestDomains, ['a.com', 'b.com']);
  assert.equal(merged.condition.urlFilter, undefined);
  // Different conditions, a path, or a different action stay separate.
  assert.ok(rules.some((r) => r.condition.urlFilter === '||c.com^' && r.condition.resourceTypes));
  assert.ok(rules.some((r) => r.condition.urlFilter === '||d.com/path'));
  assert.ok(rules.some((r) => r.condition.urlFilter === '||e.com^' && r.action.type === 'allow'));
});
