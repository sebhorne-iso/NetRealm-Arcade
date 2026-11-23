// Shared logic for the game library: reading/validating games.json and scaffolding new games.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, cpSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REQUIRED = ['id', 'title', 'description'];
// Folders inside a game that only matter for development and aren't scanned for path problems.
const DEV_DIRS = new Set(['node_modules', 'tests', 'tools', '.git']);

export function readCatalog(root) {
  return JSON.parse(readFileSync(join(root, 'games.json'), 'utf8'));
}

export function writeCatalog(root, catalog) {
  writeFileSync(join(root, 'games.json'), JSON.stringify(catalog, null, 2) + '\n');
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!DEV_DIRS.has(name)) walk(p, out);
    } else out.push(p);
  }
  return out;
}

// Games are served from /games/<id>/ (and on github.io under /<repo>/games/<id>/), so links that
// start with "/" would escape to the wrong place. Everything must be relative.
const ABSOLUTE_PATTERNS = {
  '.html': [/(?:src|href|action)\s*=\s*["']\/(?!\/)/i],
  '.css': [/url\(\s*["']?\/(?!\/)/i],
  '.js': [/(?:fetch|import)\s*\(\s*["'`]\/(?!\/)/, /\bfrom\s+["']\/(?!\/)/],
  '.mjs': [/(?:fetch|import)\s*\(\s*["'`]\/(?!\/)/, /\bfrom\s+["']\/(?!\/)/],
};

export function findAbsolutePaths(root, gameDir) {
  const problems = [];
  for (const file of walk(gameDir)) {
    const pats = ABSOLUTE_PATTERNS[extname(file).toLowerCase()];
    if (!pats) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (pats.some((re) => re.test(line))) problems.push(`${relative(root, file)}:${i + 1}: uses an absolute path ("/..."); use a relative path like "css/style.css" or "../../" instead`);
    });
  }
  return problems;
}

export function validateCatalog(root) {
  const errors = [];
  const warnings = [];
  let catalog;
  try {
    catalog = readCatalog(root);
  } catch (e) {
    return { errors: [`games.json: ${e.message}`], warnings, games: [] };
  }
  if (!catalog.site?.title) warnings.push('games.json: "site.title" is missing, so the hub will use its default title');
  if (!Array.isArray(catalog.games)) return { errors: ['games.json: "games" must be an array'], warnings, games: [] };

  const ids = new Set();
  catalog.games.forEach((g, i) => {
    const where = `games.json → games[${i}]${g?.id ? ` (${g.id})` : ''}`;
    if (!g || typeof g !== 'object') {
      errors.push(`${where}: must be an object`);
      return;
    }
    for (const k of REQUIRED) if (typeof g[k] !== 'string' || !g[k].trim()) errors.push(`${where}: missing "${k}"`);
    if (typeof g.id !== 'string') return;
    if (!ID_RE.test(g.id)) errors.push(`${where}: "id" must be lowercase letters, numbers and dashes (it's also the folder name under games/)`);
    if (ids.has(g.id)) errors.push(`${where}: duplicate id "${g.id}"`);
    ids.add(g.id);
    const dir = join(root, 'games', g.id);
    if (!existsSync(join(dir, 'index.html'))) errors.push(`${where}: games/${g.id}/index.html not found`);
    if (g.thumbnail !== undefined) {
      if (typeof g.thumbnail !== 'string' || !existsSync(join(root, g.thumbnail))) errors.push(`${where}: thumbnail "${g.thumbnail}" not found`);
      else if (g.thumbnail.startsWith('/')) errors.push(`${where}: thumbnail must be a relative path like "games/${g.id}/thumbnail.png"`);
    } else warnings.push(`${where}: no "thumbnail"; the hub will draw a placeholder card`);
    if (g.tags !== undefined && !(Array.isArray(g.tags) && g.tags.every((t) => typeof t === 'string' && t.trim()))) errors.push(`${where}: "tags" must be a list of strings`);
    if (g.color !== undefined && !COLOR_RE.test(g.color)) errors.push(`${where}: "color" must look like #ffd447`);
    if (g.added !== undefined && (!DATE_RE.test(g.added) || Number.isNaN(Date.parse(g.added)))) errors.push(`${where}: "added" must be a date like 2026-11-23`);
    if (g.featured !== undefined && typeof g.featured !== 'boolean') errors.push(`${where}: "featured" must be true or false`);
    if (existsSync(dir)) errors.push(...findAbsolutePaths(root, dir));
  });

  const gamesDir = join(root, 'games');
  if (existsSync(gamesDir)) {
    for (const d of readdirSync(gamesDir)) {
      if (statSync(join(gamesDir, d)).isDirectory() && !ids.has(d)) warnings.push(`games/${d}/ is not listed in games.json, so it won't appear in the hub`);
    }
  }
  return { errors, warnings, games: catalog.games };
}

// ---------- scaffolding ----------
const TEXT_EXT = new Set(['.html', '.css', '.js', '.mjs', '.json', '.md', '.txt', '.svg']);

function escapeFor(ext, value) {
  if (ext === '.html' || ext === '.svg') return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  if (ext === '.js' || ext === '.mjs' || ext === '.json') return JSON.stringify(value).slice(1, -1);
  if (ext === '.css') return value.replace(/\*\//g, '* /');
  return value;
}

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function scaffoldGame(root, { id, title, description, icon = '🎮', tags = [], color = '#7fd0ff', today = new Date().toISOString().slice(0, 10) }) {
  if (!title || !String(title).trim()) throw new Error('A game title is required.');
  id = id || slugify(title);
  if (!ID_RE.test(id)) throw new Error(`"${id}" is not a valid game id. Use lowercase letters, numbers and dashes, e.g. "port-blaster".`);
  const dest = join(root, 'games', id);
  if (existsSync(dest)) throw new Error(`games/${id}/ already exists. Pick another id.`);
  const catalog = readCatalog(root);
  if (catalog.games.some((g) => g.id === id)) throw new Error(`games.json already has a game with id "${id}".`);
  if (!COLOR_RE.test(color)) throw new Error('Color must look like #7fd0ff.');
  description = description || `A new study game in the arcade. Describe ${title} here!`;

  const template = join(root, 'tools', 'starter-game');
  cpSync(template, dest, { recursive: true });
  const values = { __GAME_ID__: id, __GAME_TITLE__: title, __GAME_DESCRIPTION__: description, __GAME_ICON__: icon };
  for (const file of walk(dest)) {
    const ext = extname(file).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    let text = readFileSync(file, 'utf8');
    for (const [key, val] of Object.entries(values)) text = text.split(key).join(escapeFor(ext, val));
    writeFileSync(file, text);
  }

  const entry = { id, title, description, icon, color, genre: 'Quiz', players: '1', tags, added: today };
  catalog.games.push(entry);
  writeCatalog(root, catalog);
  return { dir: dest, entry };
}
