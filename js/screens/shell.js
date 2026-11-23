// Shared in-game layout: HUD on top, content, tab bar at the bottom.
import { h, bar, fmtNum, spriteImg } from '../ui/dom.js';
import { spriteURL, heroPalette } from '../engine/sprites.js';
import { CLASSES, AVATAR_COLORS } from '../content/classes.js';
import { xpToNext, MAX_LEVEL } from '../engine/progression.js';
import { currentStreak } from '../content/quests.js';
import { openSettings } from './settings.js';

export const TABS = [
  { id: 'map', icon: '🗺️', label: 'Map' },
  { id: 'shop', icon: '🛒', label: 'Shop' },
  { id: 'skills', icon: '✨', label: 'Skills' },
  { id: 'codex', icon: '📖', label: 'Codex' },
  { id: 'quests', icon: '📜', label: 'Quests' },
  { id: 'awards', icon: '🏆', label: 'Awards' },
  { id: 'stats', icon: '📊', label: 'Stats' },
  { id: 'profile', icon: '👤', label: 'Profile' },
];

export function heroSprite(p) {
  const color = AVATAR_COLORS[p.color] || AVATAR_COLORS[0];
  return spriteURL(CLASSES[p.cls]?.sprite || 'knight', heroPalette(p.cls, color.c));
}

export function shell(root, game, active, title) {
  const p = game.profile();
  game.ensureDaily(p);
  const claimable = (p.daily?.quests || []).filter((q) => q.progress >= q.target && !q.claimed).length;
  const streak = currentStreak(p);
  const bugs = game.bugCount(p);
  const s = game.settings();

  const hud = h(
    'header.hud.window',
    {},
    h('div.hud-avatar', {}, spriteImg(heroSprite(p))),
    h(
      'div.hud-main',
      {},
      h('div.hud-name', {}, h('span', {}, p.name), p.hardcore ? h('span.badge.badge-hc', { title: 'Hardcore mode' }, '💀 HC') : null, p.title ? h('span.hud-title', {}, `«${p.title}»`) : null),
      h(
        'div.hud-row',
        {},
        h('span.hud-lv', {}, `Lv ${p.level}`),
        h('div.hud-xp', { title: `${fmtNum(p.xp)} / ${fmtNum(xpToNext(p.level))} XP` }, bar(p.level >= MAX_LEVEL ? 1 : p.xp, p.level >= MAX_LEVEL ? 1 : xpToNext(p.level), 'xp')),
        h('span.hud-stat.gold', { title: 'Gold' }, `💰 ${fmtNum(p.gold)}`),
        h('span.hud-stat', { title: 'Daily streak' }, `🔥 ${streak}`),
        bugs ? h('span.hud-stat.bugs', { title: 'Recurring Bugs due for review' }, `🐛 ${bugs}`) : null
      )
    ),
    h(
      'div.hud-buttons',
      {},
      h('button.icon-btn', { type: 'button', 'data-mute': '1', title: 'Toggle sound (M)', onclick: (e) => { s.muted = !s.muted; game.applySettings(); game.save(); e.currentTarget.textContent = s.muted ? '🔇' : '🔊'; } }, s.muted ? '🔇' : '🔊'),
      h('button.icon-btn', { type: 'button', title: 'Settings', onclick: () => openSettings(game) }, '⚙️')
    )
  );

  const nav = h(
    'nav.tabbar',
    {},
    TABS.map((t) => {
      let badge = null;
      if (t.id === 'skills' && p.sp > 0) badge = p.sp;
      if (t.id === 'quests' && claimable) badge = claimable;
      return h(
        'button.tab' + (t.id === active ? '.active' : ''),
        { type: 'button', onclick: () => t.id !== active && game.go(t.id), 'aria-current': t.id === active ? 'page' : null },
        h('span.tab-icon', {}, t.icon),
        h('span.tab-label', {}, t.label),
        badge ? h('span.tab-badge', {}, badge) : null
      );
    })
  );

  const main = h('main.content');
  if (title) main.append(h('h1.screen-title', {}, title));
  root.append(h('div.shell', {}, hud, main, nav));
  return main;
}
