// Packet Quest bootstrap: loads data, owns the router and the shared game context.
import { audio } from './engine/audio.js';
import * as store from './engine/state.js';
import { validateQuestion, srsId } from './engine/questions.js';
import { mastery, bugIds } from './engine/srs.js';
import { checkAchievements } from './content/achievements.js';
import { questEvent, ensureDaily, updateStreak } from './content/quests.js';
import { clear, toast, anyModalOpen } from './ui/dom.js';
import { SCREENS } from './screens/index.js';

window.__PQ_BOOTED__ = true;

const app = document.getElementById('app');

async function fetchJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function loadData() {
  const zonesDoc = await fetchJson('data/zones.json');
  const codex = await fetchJson('data/codex.json');
  const zones = zonesDoc.zones;
  const questions = {};
  const seen = new Set();
  await Promise.all(
    zones
      .filter((z) => z.questions)
      .map(async (z) => {
        const doc = await fetchJson(`data/questions/${z.questions}`);
        const list = [];
        for (const q of doc.questions || []) {
          const errs = validateQuestion(q);
          if (errs.length) {
            console.warn(`Skipping question ${q.id} in ${z.questions}:`, errs.join('; '));
            continue;
          }
          const sid = srsId(q);
          if (q.type !== 'gen' && seen.has(sid)) {
            console.warn(`Duplicate question id ${sid} in ${z.questions}`);
            continue;
          }
          seen.add(sid);
          list.push({ ...q, zoneId: z.id });
        }
        questions[z.id] = list;
      })
  );
  const all = Object.values(questions).flat();
  zones.forEach((z, i) => (z.index = i));
  const zoneById = Object.fromEntries(zones.map((z) => [z.id, z]));
  const byId = new Map();
  for (const q of all) if (!byId.has(srsId(q))) byId.set(srsId(q), q);
  return { zones, zoneById, codex, questions, all, byId };
}

function applySettings() {
  const s = store.settings();
  document.body.classList.toggle('readable', !!s.readableFont);
  document.body.classList.toggle('large-text', !!s.largeText);
  document.body.classList.toggle('reduce-motion', !!s.reduceMotion);
  audio.setVolumes({ music: s.music, sfx: s.sfx, muted: s.muted });
}

const game = {
  data: null,
  screen: null,
  params: null,
  cleanup: null,
  sessionStart: Date.now(),

  profile: () => store.activeProfile(),
  settings: () => store.settings(),
  save() {
    const p = store.activeProfile();
    if (p) {
      const now = Date.now();
      p.stats.playMs += now - game.sessionStart;
      game.sessionStart = now;
      p.lastPlayed = now;
    }
    store.saveStore();
  },
  applySettings,

  go(name, params = {}) {
    const screen = SCREENS[name];
    if (!screen) throw new Error(`No screen ${name}`);
    try {
      game.cleanup?.();
    } catch (e) {
      console.warn(e);
    }
    game.cleanup = null;
    clear(app);
    document.getElementById('modal-root').replaceChildren();
    game.screen = name;
    game.params = params;
    app.dataset.screen = name;
    window.scrollTo(0, 0);
    const cleanup = screen(app, params, game);
    if (typeof cleanup === 'function') game.cleanup = cleanup;
  },

  // Question pool for a zone. The final zone draws from everything.
  pool(zoneId) {
    const z = game.data.zoneById[zoneId];
    if (z?.pool === 'all') return game.data.all.filter((q) => q.type !== 'gen' || q.difficulty >= 2);
    return game.data.questions[zoneId] || [];
  },
  rawById(id) {
    return game.data.byId.get(id) || null;
  },
  poolIds(zoneId) {
    return [...new Set(game.pool(zoneId).map(srsId))];
  },
  zoneMastery(p, zoneId) {
    return mastery(p.q, game.poolIds(zoneId));
  },
  bugCount(p, dueOnly = true) {
    return bugIds(p.q, Date.now(), { dueOnly }).length;
  },
  achievementCtx(p) {
    return { zoneMasteries: () => game.data.zones.filter((z) => z.id !== 'core').map((z) => game.zoneMastery(p, z.id)) };
  },
  ensureDaily(p) {
    return ensureDaily(p, game.data.zones, { bugCount: game.bugCount(p, false) });
  },

  // Central event hook: daily quests, streaks and achievements.
  emit(ev) {
    const p = store.activeProfile();
    if (!p) return;
    game.ensureDaily(p);
    if (ev.type === 'win') {
      if (updateStreak(p)) toast(`Streak: ${p.streak.count} day${p.streak.count === 1 ? '' : 's'}!`, { icon: '🔥', kind: 'good' });
    }
    for (const q of questEvent(p, ev)) {
      toast(`Quest complete: ${q.text}. Claim it on the Quests tab!`, { icon: '📜', kind: 'good', ms: 4000 });
      audio.sfx('coin');
    }
    game.checkAchievements();
  },
  checkAchievements() {
    const p = store.activeProfile();
    if (!p) return [];
    const fresh = checkAchievements(p, game.achievementCtx(p));
    fresh.forEach((a, i) =>
      setTimeout(() => {
        audio.sfx('achievement');
        toast(`Achievement: ${a.name}${a.title ? ` (title unlocked: "${a.title}")` : ''}`, { icon: a.icon, kind: 'gold', ms: 4500 });
      }, 400 + i * 700)
    );
    return fresh;
  },
};

window.addEventListener('pointerdown', () => audio.init(), { once: false, passive: true });
window.addEventListener('keydown', () => audio.init(), { passive: true });
window.addEventListener('beforeunload', () => game.save());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) game.save();
});
// Global shortcut: M toggles sound (when not typing).
window.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  if (e.key === 'm' && !e.ctrlKey && !e.metaKey && !anyModalOpen()) {
    const s = store.settings();
    s.muted = !s.muted;
    store.saveStore();
    applySettings();
    toast(s.muted ? 'Sound off' : 'Sound on', { icon: s.muted ? '🔇' : '🔊', ms: 1200 });
    document.querySelectorAll('[data-mute]').forEach((b) => (b.textContent = s.muted ? '🔇' : '🔊'));
  }
});

async function boot() {
  store.loadStore();
  applySettings();
  try {
    game.data = await loadData();
  } catch (e) {
    console.error(e);
    const msg = document.getElementById('boot-msg');
    if (msg) msg.innerHTML = `Failed to load game data (${e.message}).<br><br>If you opened index.html directly from disk, run <code>python3 -m http.server 8000</code> in the repository's top folder and open <code>http://localhost:8000</code>.`;
    return;
  }
  window.PQ = game; // handy for debugging in the console
  game.go('title');
}

boot();
