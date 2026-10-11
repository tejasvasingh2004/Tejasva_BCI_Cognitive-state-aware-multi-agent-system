// Generates src/content/changelog.json from the commit history (conventional commit subjects), so
// the changelog page always reflects what actually shipped. Without git history it writes [].
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../src/content/changelog.json');
const LABELS = { feat: 'Feature', fix: 'Fix', perf: 'Performance', ci: 'Infrastructure', docs: 'Docs' };

let entries = [];
try {
  const log = execFileSync('git', ['log', '--no-merges', '--date=short', '--pretty=format:%h%x1f%ad%x1f%s', '-n', '300'], { encoding: 'utf8' });
  const byDate = new Map();
  for (const line of log.split('\n').filter(Boolean)) {
    const [hash, date, subject] = line.split('\x1f');
    const m = /^(feat|fix|perf|ci|docs)(?:\(([^)]+)\))?!?:\s*(.+)$/.exec(subject ?? '');
    if (!m) continue;
    const item = { hash, type: LABELS[m[1]], scope: m[2] ?? null, title: m[3] };
    byDate.set(date, [...(byDate.get(date) ?? []), item]);
  }
  entries = [...byDate.entries()].map(([date, items]) => ({ date, items }));
} catch {
  entries = [];
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(entries, null, 2) + '\n');
