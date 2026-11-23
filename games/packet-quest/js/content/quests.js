// Daily quests and streak tracking. Quests are generated deterministically per profile per day.
import { makeRng } from '../engine/rng.js';

export function dayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function prevDayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return dayKey(dt);
}

const TEMPLATES = [
  { kind: 'win', n: 3, text: (n) => `Win ${n} battles` },
  { kind: 'correct', n: 15, text: (n) => `Answer ${n} questions correctly` },
  { kind: 'crit', n: 5, text: (n) => `Land ${n} speed crits (answer fast!)` },
  { kind: 'terminal', n: 3, text: (n) => `Nail ${n} terminal challenges` },
  { kind: 'typed', n: 5, text: (n) => `Answer ${n} typed-answer questions correctly` },
  { kind: 'combo', n: 5, text: (n) => `Reach a ${n}x combo` },
  { kind: 'bugs', n: 3, text: (n) => `Squash ${n} Recurring Bugs`, needsBugs: true },
  { kind: 'codex', n: 2, text: (n) => `Read ${n} Codex entries` },
  { kind: 'flawless', n: 1, text: () => 'Win a battle without taking damage' },
  { kind: 'zone', n: 1, text: (n, zoneName) => `Win a battle in ${zoneName}`, needsZone: true },
];

export function ensureDaily(profile, zones, { bugCount = 0, today = dayKey() } = {}) {
  if (profile.daily && profile.daily.date === today) return profile.daily;
  const rng = makeRng(`${profile.id}:${today}`);
  const unlocked = zones.filter((z) => profile.zones[z.id]?.unlocked);
  const pool = TEMPLATES.filter((t) => (!t.needsBugs || bugCount >= 3) && (!t.needsZone || unlocked.length > 0));
  const chosen = rng.shuffle(pool).slice(0, 3);
  const tier = Math.max(1, unlocked.length);
  profile.daily = {
    date: today,
    bonusClaimed: false,
    quests: chosen.map((t, i) => {
      const zone = t.needsZone ? rng.pick(unlocked) : null;
      return {
        id: `${today}-${i}`,
        kind: t.kind,
        target: t.n,
        zoneId: zone?.id ?? null,
        text: t.text(t.n, zone?.name),
        progress: 0,
        claimed: false,
        gold: 25 + 10 * tier,
        xp: 30 + 15 * tier,
      };
    }),
  };
  return profile.daily;
}

// Apply a gameplay event to today's quests. Returns quests that just became completable.
export function questEvent(profile, ev) {
  const d = profile.daily;
  if (!d) return [];
  const done = [];
  for (const q of d.quests) {
    if (q.progress >= q.target) continue;
    const before = q.progress;
    switch (q.kind) {
      case 'win':
        if (ev.type === 'win') q.progress++;
        break;
      case 'correct':
        if (ev.type === 'answer' && ev.correct) q.progress++;
        break;
      case 'crit':
        if (ev.type === 'answer' && ev.correct && ev.crit) q.progress++;
        break;
      case 'terminal':
        if (ev.type === 'answer' && ev.correct && ev.qtype === 'terminal') q.progress++;
        break;
      case 'typed':
        if (ev.type === 'answer' && ev.correct && ev.qtype === 'input') q.progress++;
        break;
      case 'combo':
        if (ev.type === 'answer' && ev.correct) q.progress = Math.max(q.progress, Math.min(q.target, ev.combo));
        break;
      case 'bugs':
        if (ev.type === 'answer' && ev.squashed) q.progress++;
        break;
      case 'codex':
        if (ev.type === 'codex') q.progress++;
        break;
      case 'flawless':
        if (ev.type === 'win' && ev.flawless) q.progress++;
        break;
      case 'zone':
        if (ev.type === 'win' && ev.zoneId === q.zoneId) q.progress++;
        break;
    }
    q.progress = Math.min(q.progress, q.target);
    if (before < q.target && q.progress >= q.target) done.push(q);
  }
  return done;
}

export function updateStreak(profile, today = dayKey()) {
  const s = profile.streak;
  if (s.lastDay === today) return false;
  s.count = s.lastDay === prevDayKey(today) ? s.count + 1 : 1;
  s.lastDay = today;
  s.best = Math.max(s.best, s.count);
  return true;
}

export function currentStreak(profile, today = dayKey()) {
  const s = profile.streak;
  if (!s.lastDay) return 0;
  if (s.lastDay === today || s.lastDay === prevDayKey(today)) return s.count;
  return 0;
}
