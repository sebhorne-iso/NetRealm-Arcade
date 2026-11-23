// Weak-spot statistics: accuracy and mastery per zone, type and topic.
import { h, btn, bar, fmtNum } from '../ui/dom.js';
import { shell } from './shell.js';
import { audio } from '../engine/audio.js';

const TYPE_NAMES = { mc: 'Multiple choice', input: 'Typed answers', terminal: 'Terminal', order: 'Ordering' };

function pct(e) {
  return e && e.a ? Math.round((e.c / e.a) * 100) : null;
}

export function weakTopics(p, game, n = 6) {
  return Object.entries(p.stats.byTopic)
    .filter(([, e]) => e.a >= 3)
    .map(([key, e]) => {
      const [zoneId, topic] = key.split('|');
      return { zoneId, topic, acc: e.c / e.a, a: e.a, zone: game.data.zoneById[zoneId] };
    })
    .filter((t) => t.zone)
    .sort((a, b) => a.acc - b.acc || b.a - a.a)
    .slice(0, n);
}

export function statsScreen(root, _params, game) {
  const p = game.profile();
  audio.play('map');
  const main = shell(root, game, 'stats', '📊 Stats & Weak Spots');
  const s = p.stats;
  const acc = s.answered ? Math.round((s.correct / s.answered) * 100) : 0;
  const hours = Math.floor(s.playMs / 3600000);
  const mins = Math.round((s.playMs % 3600000) / 60000);

  main.append(
    h(
      'div.stat-cards',
      {},
      [
        ['🎯', `${acc}%`, 'accuracy'],
        ['💬', fmtNum(s.answered), 'questions answered'],
        ['⚔️', fmtNum(s.battlesWon), 'battles won'],
        ['👑', fmtNum(s.bossesDefeated), 'bosses defeated'],
        ['🔥', fmtNum(s.bestCombo), 'best combo'],
        ['⚡', fmtNum(s.crits), 'speed crits'],
        ['🐛', fmtNum(s.bugsSquashed), 'bugs squashed'],
        ['⏱️', `${hours}h ${mins}m`, 'time studied'],
      ].map(([i, v, l]) => h('div.stat-card', {}, h('div.stat-icon', {}, i), h('div.stat-value', {}, v), h('div.stat-label', {}, l)))
    )
  );

  const weak = weakTopics(p, game);
  main.append(h('h2.section', {}, '🩺 Study next (weakest topics)'));
  if (!weak.length) main.append(h('p.muted', {}, 'Answer at least 3 questions in a topic to see your weak spots here.'));
  else
    main.append(
      h(
        'div.weak-list',
        {},
        weak.map((t) =>
          h(
            'div.weak-row',
            {},
            h('div.weak-name', {}, `${t.zone.icon} ${t.topic}`, h('small.muted.block', {}, `${t.zone.name} · ${t.a} answered`)),
            h('div.weak-bar', {}, bar(t.acc, 1, t.acc < 0.5 ? 'hp low' : t.acc < 0.75 ? 'gold' : 'hp'), h('span.hp-text', {}, `${Math.round(t.acc * 100)}%`)),
            btn('📖', () => game.go('codex', { zoneId: t.zoneId }), 'small', { title: 'Open Codex' })
          )
        )
      )
    );

  main.append(h('h2.section', {}, '🗺️ By zone'));
  main.append(
    h(
      'div.zone-stats',
      {},
      game.data.zones.map((z) => {
        const e = s.byZone[z.id];
        const m = game.zoneMastery(p, z.id);
        const unlocked = p.zones[z.id]?.unlocked;
        return h(
          'div.zone-stat' + (unlocked ? '' : '.locked'),
          {},
          h('div.zone-stat-name', {}, `${unlocked ? z.icon : '🔒'} ${z.name}`),
          h('div.zone-stat-bars', {},
            h('div.bar-row', {}, h('span.bar-label', {}, 'ACC'), bar(e ? e.c : 0, e ? e.a : 1, 'hp'), h('span.hp-text', {}, e ? `${pct(e)}% (${e.c}/${e.a})` : '—')),
            h('div.bar-row', {}, h('span.bar-label', {}, 'MAS'), bar(m, 1, 'bw'), h('span.hp-text', {}, `${Math.round(m * 100)}%`))
          )
        );
      })
    ),
    h('p.muted.small', {}, 'ACC = accuracy of all your answers in the zone. MAS = mastery: how far each question has progressed through spaced repetition (answer it correctly over several days to master it).')
  );

  main.append(h('h2.section', {}, '🧩 By question type'));
  main.append(
    h(
      'div.zone-stats',
      {},
      Object.entries(TYPE_NAMES).map(([t, name]) => {
        const e = s.byType[t];
        return h('div.zone-stat', {}, h('div.zone-stat-name', {}, name), h('div.zone-stat-bars', {}, h('div.bar-row', {}, bar(e ? e.c : 0, e ? e.a : 1, 'hp'), h('span.hp-text', {}, e ? `${pct(e)}% (${e.c}/${e.a})` : '—'))));
      })
    )
  );
}
