import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFilter } from '../extension/lib/filter-parser.js';

test('every entry in the built-in list is supported', () => {
  const lines = readFileSync(new URL('../extension/filters/uniblock.txt', import.meta.url), 'utf8').split('\n');
  const bad = lines.map((l) => [l, parseFilter(l)]).filter(([, f]) => f.kind === 'unsupported');
  assert.deepEqual(bad, []);
});
