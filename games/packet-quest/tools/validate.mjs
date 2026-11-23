#!/usr/bin/env node
// Validates all game data: zones, codex and every question file.
// Usage: node tools/validate.mjs   (exits non-zero on any error; used by CI)
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateQuestion, instantiate, checkAnswer, srsId } from '../js/engine/questions.js';
import { SPRITE_NAMES } from '../js/engine/sprites.js';
import { ITEM_MAP } from '../js/content/items.js';
import { makeRng } from '../js/engine/rng.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];
const err = (where, msg) => errors.push(`✖ ${where}: ${msg}`);
const warn = (where, msg) => warnings.push(`⚠ ${where}: ${msg}`);

function readJson(rel) {
  try {
    return JSON.parse(readFileSync(join(root, rel), 'utf8'));
  } catch (e) {
    err(rel, `invalid JSON: ${e.message}`);
    return null;
  }
}

// ---------- zones ----------
const zonesDoc = readJson('data/zones.json');
const zones = zonesDoc?.zones || [];
const zoneIds = new Set();
const monsterIds = new Set();
for (const z of zones) {
  const where = `zones.json:${z.id}`;
  if (zoneIds.has(z.id)) err(where, 'duplicate zone id');
  zoneIds.add(z.id);
  for (const k of ['name', 'topic', 'icon', 'desc', 'recLevel', 'battlesToBoss', 'map', 'biome', 'monsters', 'boss']) if (z[k] == null) err(where, `missing "${k}"`);
  if (!z.questions && z.pool !== 'all') err(where, 'needs "questions" (file name) or "pool": "all"');
  if (z.biome && (z.biome.length !== 3 || !z.biome.every((c) => /^#[0-9a-f]{6}$/i.test(c)))) err(where, 'biome must be three #rrggbb colors');
  for (const m of [...(z.monsters || []), z.boss].filter(Boolean)) {
    if (monsterIds.has(m.id)) err(where, `duplicate monster id ${m.id}`);
    monsterIds.add(m.id);
    if (!SPRITE_NAMES.includes(m.sprite)) err(where, `monster ${m.id} uses unknown sprite "${m.sprite}"`);
    if (!m.desc) err(where, `monster ${m.id} needs a desc`);
  }
  if (z.boss?.loot && !ITEM_MAP[z.boss.loot]) err(where, `boss loot "${z.boss.loot}" is not a known item`);
}

// ---------- codex ----------
const codex = readJson('data/codex.json');
const codexIds = new Set();
for (const e of codex?.entries || []) {
  if (codexIds.has(e.id)) err('codex.json', `duplicate entry id ${e.id}`);
  codexIds.add(e.id);
  if (!zoneIds.has(e.zone)) err('codex.json', `entry ${e.id} references unknown zone ${e.zone}`);
  if (!Array.isArray(e.body) || !e.body.length) err('codex.json', `entry ${e.id} has no body`);
}

// ---------- questions ----------
const files = readdirSync(join(root, 'data/questions')).filter((f) => f.endsWith('.json'));
const referenced = new Set(zones.map((z) => z.questions).filter(Boolean));
for (const f of files) if (!referenced.has(f)) warn(`questions/${f}`, 'not referenced by any zone in zones.json');
const seen = new Map();
const counts = {};
const rng = makeRng('validate');
for (const z of zones) {
  if (!z.questions) continue;
  const rel = `data/questions/${z.questions}`;
  const doc = readJson(rel);
  if (!doc) continue;
  if (!Array.isArray(doc.questions)) {
    err(rel, 'must contain a "questions" array');
    continue;
  }
  const byType = (counts[z.id] = { total: 0 });
  for (const q of doc.questions) {
    const where = `${z.questions}:${q.id || '(no id)'}`;
    for (const e of validateQuestion(q)) err(where, e);
    if (q.id) {
      if (seen.has(q.id)) err(where, `duplicate id (also in ${seen.get(q.id)})`);
      seen.set(q.id, z.questions);
    }
    byType[q.type] = (byType[q.type] || 0) + 1;
    byType.total++;
    // The canonical answer must be accepted by the game's own checker.
    try {
      const inst = instantiate(q, rng, { zoneId: z.id });
      if (q.type === 'mc') {
        if (!checkAnswer(inst, inst.answer).correct) err(where, 'correct choice not accepted after shuffling');
      } else if (q.type === 'order') {
        if (!checkAnswer(inst, inst.correctOrder).correct) err(where, 'correct order not accepted');
      } else if (q.type === 'input' || q.type === 'terminal') {
        for (const a of q.answers) if (!checkAnswer(inst, a).correct) err(where, `listed answer "${a}" is not accepted by the checker`);
      } else if (q.type === 'gen') {
        for (let i = 0; i < 25; i++) {
          const g = instantiate(q, rng, { zoneId: z.id });
          const resp = g.type === 'mc' ? g.answer : g.answers[0];
          if (!checkAnswer(g, resp).correct) err(where, `generated question not self-consistent: ${g.q}`);
          if (g.type === 'mc' && new Set(g.choices).size !== g.choices.length) err(where, `generated duplicate choices: ${g.choices.join(' | ')}`);
        }
      }
    } catch (e) {
      err(where, `failed to instantiate: ${e.message}`);
    }
    if (q.type !== 'gen' && q.explain && q.explain.length < 25) warn(where, 'explanation is very short');
    if (srsId(q) !== q.id && q.type !== 'gen') err(where, 'srs id mismatch');
  }
}

// ---------- report ----------
console.log('Question counts per zone:');
for (const [zone, c] of Object.entries(counts)) {
  const parts = Object.entries(c).filter(([k]) => k !== 'total').map(([k, v]) => `${k}:${v}`);
  console.log(`  ${zone.padEnd(13)} ${String(c.total).padStart(3)}  (${parts.join(', ')})`);
}
console.log(`  ${'TOTAL'.padEnd(13)} ${String(Object.values(counts).reduce((s, c) => s + c.total, 0)).padStart(3)}`);
console.log(`Codex entries: ${codexIds.size} · Monsters: ${monsterIds.size} · Zones: ${zoneIds.size}`);
warnings.forEach((w) => console.warn(w));
if (errors.length) {
  errors.forEach((e) => console.error(e));
  console.error(`\n${errors.length} error(s) found.`);
  process.exit(1);
}
console.log('\n✔ All game data is valid.');
