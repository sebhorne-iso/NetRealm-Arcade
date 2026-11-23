#!/usr/bin/env node
// Validates the arcade: games.json, every game folder, and runs each game's own validator
// (games/<id>/tools/validate.mjs) if it has one. Used by `npm run validate` and CI.
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateCatalog } from './lib/catalog.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { errors, warnings, games } = validateCatalog(root);

console.log(`🕹️  Arcade catalog: ${games.length} game${games.length === 1 ? '' : 's'} listed in games.json`);
for (const g of games) console.log(`   • ${g.id}: ${g.title}`);
warnings.forEach((w) => console.warn(`⚠ ${w}`));
errors.forEach((e) => console.error(`✖ ${e}`));

let failed = errors.length > 0;
for (const g of games) {
  const script = join(root, 'games', String(g.id), 'tools', 'validate.mjs');
  if (!existsSync(script)) continue;
  console.log(`\n▶ Running games/${g.id}/tools/validate.mjs`);
  const r = spawnSync(process.execPath, [script], { stdio: 'inherit', cwd: root });
  if (r.status !== 0) {
    failed = true;
    console.error(`✖ games/${g.id}: its validator failed`);
  }
}

if (failed) {
  console.error('\nValidation failed.');
  process.exit(1);
}
console.log('\n✔ Arcade catalog and all game data are valid.');
