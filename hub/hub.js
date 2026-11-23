// NetRealm Arcade hub: reads games.json and renders the game library.
window.__ARCADE_BOOTED__ = true;

const STORE_KEY = 'arcade.hub.v1';
const NEW_DAYS = 30;

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') for (const [p, val] of Object.entries(v)) node.style.setProperty(p, val);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || { last: null, plays: {} };
  } catch {
    return { last: null, plays: {} };
  }
}

function recordPlay(id) {
  const s = loadState();
  s.last = id;
  s.plays[id] = { count: (s.plays[id]?.count || 0) + 1, ts: Date.now() };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {}
}

const gameUrl = (g) => `games/${encodeURIComponent(g.id)}/`;

function isNew(g) {
  if (!g.added) return false;
  const t = Date.parse(g.added);
  return Number.isFinite(t) && Date.now() - t < NEW_DAYS * 86400000;
}

function artFor(g) {
  const fallback = () =>
    el('div', { class: 'card-art-fallback', 'aria-hidden': 'true' }, el('span', { class: 'fallback-icon' }, g.icon || '🎮'));
  if (!g.thumbnail) return fallback();
  const img = el('img', { src: g.thumbnail, alt: '', loading: 'lazy', decoding: 'async' });
  img.addEventListener('error', () => img.replaceWith(fallback()));
  return img;
}

function card(g, state) {
  const played = state.plays[g.id];
  const badges = [];
  if (g.featured) badges.push(el('span', { class: 'badge badge-featured' }, '★ FEATURED'));
  if (isNew(g)) badges.push(el('span', { class: 'badge badge-new' }, 'NEW'));
  if (state.last === g.id) badges.push(el('span', { class: 'badge badge-last' }, 'LAST PLAYED'));
  const meta = [g.genre, g.players ? `${g.players} player${g.players === '1' ? '' : 's'}` : null].filter(Boolean).join(' · ');
  return el(
    'a',
    { class: 'game-card', href: gameUrl(g), style: g.color ? { '--card-color': g.color } : null, onclick: () => recordPlay(g.id), 'data-id': g.id },
    el('div', { class: 'card-art' }, artFor(g), el('div', { class: 'card-badges' }, badges)),
    el(
      'div',
      { class: 'card-body' },
      el('h2', { class: 'card-title' }, g.icon ? `${g.icon} ` : '', g.title),
      el('p', { class: 'card-desc' }, g.description),
      g.tags?.length ? el('div', { class: 'card-tags' }, g.tags.map((t) => el('span', { class: 'chip' }, t))) : null,
      el(
        'div',
        { class: 'card-foot' },
        el('span', { class: 'card-meta' }, meta, played ? el('span', { class: 'card-plays' }, ` · played ${played.count}×`) : null),
        el('span', { class: 'card-play' }, 'PLAY ▶')
      )
    )
  );
}

function addGameCard(site) {
  if (!site.repo) return null;
  return el(
    'a',
    { class: 'game-card add-card', href: `${site.repo.replace(/\/$/, '')}/blob/main/CONTRIBUTING.md`, target: '_blank', rel: 'noopener' },
    el('div', { class: 'add-plus', 'aria-hidden': 'true' }, '+'),
    el('div', { class: 'card-body' }, el('h2', { class: 'card-title' }, 'Add your own game'), el('p', { class: 'card-desc' }, 'Got an idea for a study game? One command scaffolds it, then add it here with a pull request.'), el('span', { class: 'card-play' }, 'HOW TO ▶'))
  );
}

function render(catalog) {
  const site = catalog.site || {};
  const games = (catalog.games || []).slice().sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0));
  const state = loadState();

  // Header
  if (site.title) {
    document.title = site.title;
    const words = site.title.trim().split(/\s+/);
    const logo = $('hub-logo');
    logo.replaceChildren(
      el('span', { class: 'logo-a' }, (words.length > 1 ? words.slice(0, -1).join(' ') : words[0]).toUpperCase()),
      words.length > 1 ? el('span', { class: 'logo-b' }, words[words.length - 1].toUpperCase()) : null
    );
  }
  $('hub-tagline').textContent = site.tagline || '';

  // Continue banner
  const last = games.find((g) => g.id === state.last);
  const cont = $('hub-continue');
  if (last) {
    cont.hidden = false;
    cont.replaceChildren(
      el('span', { class: 'continue-label' }, 'CONTINUE'),
      el('span', { class: 'continue-title' }, `${last.icon || '🎮'} ${last.title}`),
      el('a', { class: 'arcade-btn', href: gameUrl(last), onclick: () => recordPlay(last.id) }, 'PLAY ▶')
    );
  }

  // Filters
  const tags = [...new Set(games.flatMap((g) => g.tags || []))].sort((a, b) => a.localeCompare(b));
  let activeTag = null;
  let query = '';
  const tagBox = $('hub-tags');
  const drawTags = () =>
    tagBox.replaceChildren(
      ...[null, ...tags].map((t) =>
        el(
          'button',
          {
            type: 'button',
            class: 'tag-btn' + (t === activeTag ? ' active' : ''),
            'aria-pressed': String(t === activeTag),
            onclick: () => {
              activeTag = t;
              drawTags();
              drawGrid();
            },
          },
          t || 'All'
        )
      )
    );

  const grid = $('game-grid');
  const drawGrid = () => {
    const q = query.trim().toLowerCase();
    const shown = games.filter((g) => {
      if (activeTag && !(g.tags || []).includes(activeTag)) return false;
      if (!q) return true;
      return [g.title, g.description, g.genre, ...(g.tags || [])].filter(Boolean).join(' ').toLowerCase().includes(q);
    });
    const cards = shown.map((g) => card(g, state));
    if (!shown.length) cards.push(el('p', { class: 'hub-empty' }, 'No games match that search. Try another topic!'));
    if (!q && !activeTag) {
      const add = addGameCard(site);
      if (add) cards.push(add);
    }
    grid.replaceChildren(...cards);
    $('hub-count').textContent = `${shown.length} game${shown.length === 1 ? '' : 's'}${activeTag ? ` tagged “${activeTag}”` : ''}${q ? ` matching “${query.trim()}”` : ''}`;
  };

  const search = $('hub-search');
  search.addEventListener('input', () => {
    query = search.value;
    drawGrid();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== search) {
      e.preventDefault();
      search.focus();
    }
  });
  // Search and topic filters appear once the library is big enough to need them.
  document.querySelector('.hub-controls').hidden = games.length < 4;

  drawTags();
  drawGrid();

  // Footer
  $('hub-footer').replaceChildren(
    el('p', {}, `${games.length} game${games.length === 1 ? '' : 's'} in the library`),
    site.repo ? el('p', {}, el('a', { href: site.repo, target: '_blank', rel: 'noopener' }, 'Source on GitHub'), ' · ', el('a', { href: `${site.repo.replace(/\/$/, '')}/blob/main/CONTRIBUTING.md`, target: '_blank', rel: 'noopener' }, 'Add a game')) : null
  );
}

async function boot() {
  try {
    const res = await fetch('games.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`games.json: HTTP ${res.status}`);
    render(await res.json());
  } catch (e) {
    console.error(e);
    $('game-grid').replaceChildren(el('div', { class: 'hub-error arcade-window' }, `Could not load the game catalog (${e.message}).`));
  }
}

boot();
