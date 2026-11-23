import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCatalog, scaffoldGame, findAbsolutePaths, slugify, readCatalog } from '../tools/lib/catalog.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

// A throwaway copy of the bits of the repo the tooling needs.
function sandbox(games = []) {
  const root = mkdtempSync(join(tmpdir(), 'arcade-test-'));
  mkdirSync(join(root, 'tools'), { recursive: true });
  cpSync(join(repo, 'tools', 'starter-game'), join(root, 'tools', 'starter-game'), { recursive: true });
  mkdirSync(join(root, 'games'));
  writeFileSync(join(root, 'games.json'), JSON.stringify({ site: { title: 'Test Arcade' }, games }, null, 2));
  return root;
}

function addGameFolder(root, id, html = '<!DOCTYPE html><title>x</title>') {
  mkdirSync(join(root, 'games', id), { recursive: true });
  writeFileSync(join(root, 'games', id, 'index.html'), html);
}

test('the real games.json is valid', () => {
  const { errors, games } = validateCatalog(repo);
  assert.deepEqual(errors, []);
  assert.ok(games.some((g) => g.id === 'packet-quest'));
});

test('scaffolding creates a playable game folder and a catalog entry', () => {
  const root = sandbox();
  const { dir, entry } = scaffoldGame(root, { title: 'Port <Blaster> "Deluxe"', icon: '🚀', tags: ['Ports'], today: '2026-11-23' });
  assert.equal(entry.id, 'port-blaster-deluxe');
  assert.ok(existsSync(join(dir, 'index.html')) && existsSync(join(dir, 'main.js')));
  for (const f of readdirSync(dir)) assert.ok(!readFileSync(join(dir, f), 'utf8').includes('__GAME_'), `${f} still has placeholders`);
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  assert.ok(html.includes('Port &lt;Blaster&gt; &quot;Deluxe&quot;'), 'title is HTML-escaped');
  assert.ok(readFileSync(join(dir, 'main.js'), 'utf8').includes("'arcade.port-blaster-deluxe.v1'"), 'storage key is namespaced');
  const cat = readCatalog(root);
  assert.equal(cat.games.length, 1);
  assert.deepEqual(cat.games[0].tags, ['Ports']);
  assert.equal(cat.games[0].added, '2026-11-23');
  const { errors, warnings } = validateCatalog(root);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes('thumbnail')));
});

test('scaffolding refuses bad or duplicate ids', () => {
  const root = sandbox();
  scaffoldGame(root, { id: 'quiz', title: 'Quiz' });
  assert.throws(() => scaffoldGame(root, { id: 'quiz', title: 'Quiz again' }), /already exists/);
  assert.throws(() => scaffoldGame(root, { id: 'Bad_ID', title: 'Bad' }), /not a valid game id/);
  assert.throws(() => scaffoldGame(root, { id: '_hidden', title: 'Hidden' }), /not a valid game id/);
  assert.throws(() => scaffoldGame(root, { title: '   ' }), /title is required/);
});

test('validator catches missing folders, bad fields, duplicates and unlisted games', () => {
  const root = sandbox([
    { id: 'ok', title: 'OK', description: 'fine' },
    { id: 'ok', title: 'Dup', description: 'dup' },
    { id: 'ghost', title: 'Ghost', description: 'no folder' },
    { id: 'colorful', title: 'C', description: 'd', color: 'red', added: 'yesterday', tags: 'a,b', thumbnail: 'games/colorful/nope.png' },
    { title: 'No id' },
  ]);
  addGameFolder(root, 'ok');
  addGameFolder(root, 'colorful');
  addGameFolder(root, 'unlisted');
  const { errors, warnings } = validateCatalog(root);
  const has = (re) => errors.some((e) => re.test(e));
  assert.ok(has(/duplicate id "ok"/));
  assert.ok(has(/games\/ghost\/index\.html not found/));
  assert.ok(has(/"color" must look like/));
  assert.ok(has(/"added" must be a date/));
  assert.ok(has(/"tags" must be a list/));
  assert.ok(has(/thumbnail .* not found/));
  assert.ok(has(/missing "id"/));
  assert.ok(warnings.some((w) => w.includes('games/unlisted/')));
});

test('absolute paths inside a game are flagged; relative and protocol-relative ones are fine', () => {
  const root = sandbox([{ id: 'paths', title: 'P', description: 'd' }]);
  addGameFolder(root, 'paths', '<link href="/css/a.css"><script src="js/ok.js"></script><a href="../../">home</a><img src="//cdn.example.com/x.png">');
  writeFileSync(join(root, 'games', 'paths', 'app.js'), "fetch('/data/levels.json');\nfetch('data/ok.json');\nimport x from '/lib/x.js';");
  writeFileSync(join(root, 'games', 'paths', 'style.css'), "body { background: url('/img/bg.png'); }\n.ok { background: url(img/ok.png); }");
  const problems = findAbsolutePaths(root, join(root, 'games', 'paths'));
  assert.equal(problems.length, 4, problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('index.html:1')));
  assert.ok(problems.some((p) => p.includes('app.js:1')) && problems.some((p) => p.includes('app.js:3')));
  assert.ok(problems.some((p) => p.includes('style.css:1')));
});

test('slugify makes folder-safe ids', () => {
  assert.equal(slugify('Packet Quest: The Great Outage!'), 'packet-quest-the-great-outage');
  assert.equal(slugify('  Subnet   Sprint  '), 'subnet-sprint');
  assert.equal(slugify('Café Réseau'), 'cafe-reseau');
});
