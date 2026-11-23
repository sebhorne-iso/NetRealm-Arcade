// Achievements and title selection.
import { h, toast } from '../ui/dom.js';
import { shell } from './shell.js';
import { audio } from '../engine/audio.js';
import { ACHIEVEMENTS, unlockedTitles } from '../content/achievements.js';

export function awardsScreen(root, _params, game) {
  const p = game.profile();
  audio.play('map');
  const main = shell(root, game, 'awards', '🏆 Achievements');
  const titles = unlockedTitles(p);
  const got = ACHIEVEMENTS.filter((a) => p.achievements[a.id]).length;

  const select = h(
    'select.title-select',
    {
      'aria-label': 'Displayed title',
      onchange: (e) => {
        p.title = e.target.value || null;
        game.save();
        audio.sfx('confirm');
        toast(p.title ? `You are now known as "${p.title}"` : 'Title removed', { icon: '🏷️' });
        game.go('awards');
      },
    },
    h('option', { value: '' }, '(no title)'),
    titles.map((t) => h('option', { value: t, selected: p.title === t }, t))
  );

  main.append(
    h('div.window.title-box', {}, h('label', {}, h('span', {}, '🏷️ Display title: '), select), h('div.muted.small', {}, `${titles.length} title${titles.length === 1 ? '' : 's'} unlocked. Titles show in your HUD, on the leaderboard and on your score card.`)),
    h('p.center', {}, `${got} / ${ACHIEVEMENTS.length} unlocked`),
    h(
      'div.card-grid.ach-grid',
      {},
      ACHIEVEMENTS.map((a) => {
        const when = p.achievements[a.id];
        return h(
          'div.card.ach' + (when ? '.got' : '.locked'),
          {},
          h('div.ach-icon', {}, when ? a.icon : '🔒'),
          h('div.item-name', {}, a.name),
          h('p.small', {}, a.desc),
          a.title ? h('div.small.ach-title', {}, `Title: «${a.title}»`) : null,
          when ? h('div.muted.small', {}, new Date(when).toLocaleDateString()) : null
        );
      })
    )
  );
}
