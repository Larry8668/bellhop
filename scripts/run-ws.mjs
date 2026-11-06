#!/usr/bin/env node
// Run an npm script in every workspace that exists and defines it.
// `npm run x --workspaces` errors when no workspace dirs exist yet; this doesn't.
// Usage: node scripts/run-ws.mjs <script>
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const script = process.argv[2];
if (!script) {
  console.error('usage: run-ws.mjs <script>');
  process.exit(2);
}

const root = JSON.parse(readFileSync('package.json', 'utf8'));
const targets = (root.workspaces ?? []).filter((dir) => {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  return Boolean(pkg.scripts?.[script]);
});

if (targets.length === 0) {
  console.log(`run-ws: no workspace defines "${script}" yet, skipping`);
  process.exit(0);
}

let failed = false;
for (const dir of targets) {
  console.log(`run-ws: ${dir} → ${script}`);
  const res = spawnSync('npm', ['run', script, '-w', dir], { stdio: 'inherit' });
  if (res.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
