// Reports how much of a filter list uniblock can use, and why the rest is
// skipped. Reads local copies only (default: reference/easylist, gitignored).
//   node scripts/list-coverage.js [dir-or-file ...]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseFilter } from '../extension/lib/filter-parser.js';
import { compileNetworkRules } from '../extension/lib/dnr-compiler.js';
import { compileCosmetic, CosmeticEngine } from '../extension/lib/cosmetic.js';

const targets = process.argv.slice(2);
if (!targets.length) targets.push('reference/easylist/easylist', 'reference/easylist/easyprivacy');

const files = targets.flatMap((t) =>
  statSync(t).isDirectory()
    ? readdirSync(t).filter((f) => f.endsWith('.txt')).map((f) => join(t, f))
    : [t]);

const counts = {};
const unsupported = {};
const network = [];
const cosmetic = [];
for (const file of files) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const f = parseFilter(line);
    counts[f.kind] = (counts[f.kind] ?? 0) + 1;
    if (f.kind === 'network') network.push(f);
    else if (f.kind === 'cosmetic') cosmetic.push(f);
    else if (f.kind === 'unsupported') {
      const r = f.reason.replace(/:.*/, (m) => (f.reason.startsWith('unknown') ? m : m));
      unsupported[r] = (unsupported[r] ?? 0) + 1;
    }
  }
}

const net = compileNetworkRules(network);
const cos = compileCosmetic(cosmetic, net.hideSwitches);
const engine = new CosmeticEngine(cos);
const top = (o, n = 12) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);

const filters = (counts.network ?? 0) + (counts.cosmetic ?? 0) + (counts.unsupported ?? 0);
console.log(`files: ${files.length}  filters: ${filters}`);
console.log(`parsed  network: ${counts.network ?? 0}  cosmetic: ${counts.cosmetic ?? 0}  unsupported: ${counts.unsupported ?? 0}`);
console.log(`usable: ${(((counts.network ?? 0) + (counts.cosmetic ?? 0)) / filters * 100).toFixed(1)}%`);
console.log(`\nDNR rules: ${net.rules.length}  (regex: ${net.rules.filter((r) => r.condition.regexFilter).length})  hide switches: ${net.hideSwitches.length}`);
console.log('compile skips:', top(net.skipped));
console.log('parse skips:', top(unsupported));
console.log(`\ncosmetic  generic: ${cos.generic.length}  specific hosts: ${Object.keys(cos.specific).length}`);
console.log(`generic sheet: ${(engine.genericCss.length / 1024).toFixed(0)} KB`);
const t0 = performance.now();
for (let i = 0; i < 1000; i++) engine.cssFor('www.example.com');
console.log(`cssFor(): ${((performance.now() - t0) / 1000).toFixed(3)} ms/call`);
