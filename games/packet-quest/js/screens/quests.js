// Daily quests and streak.
import { h, btn, bar, toast } from '../ui/dom.js';
import { shell } from './shell.js';
import { audio } from '../engine/audio.js';
import { grantXp } from '../engine/progression.js';
import { currentStreak } from '../content/quests.js';
import { CONSUMABLES } from '../content/items.js';

const MILESTONES = [3, 7, 14, 30, 60, 100];

export function questsScreen(root, _params, game) {
  const p = game.profile();
  if (p.dead) return game.go('profile');
  audio.play('map');
  const main = shell(root, game, 'quests', '📜 Daily Quests');
  const d = game.ensureDaily(p);
  const streak = currentStreak(p);

  const claim = (q) => {
    q.claimed = true;
    p.gold += q.gold;
    const lv = grantXp(p, q.xp);
    audio.sfx('coin');
    toast(`+${q.gold} gold, +${q.xp} XP`, { icon: '📜', kind: 'good' });
    if (lv) {
      audio.sfx('levelup');
      toast(`Level up! Lv ${p.level}`, { icon: '⭐', kind: 'gold' });
    }
    game.checkAchievements();
    game.save();
    game.go('quests');
  };

  const allClaimed = d.quests.every((q) => q.claimed);
  const claimBonus = () => {
    d.bonusClaimed = true;
    const unlockedIdx = Math.max(...game.data.zones.filter((z) => p.zones[z.id]?.unlocked).map((z) => z.index));
    const pool = CONSUMABLES.filter((c) => c.unlockZone <= unlockedIdx);
    const picks = [pool[Math.floor(Math.random() * pool.length)], pool[Math.floor(Math.random() * pool.length)]];
    picks.forEach((c) => (p.inventory[c.id] = (p.inventory[c.id] || 0) + 1));
    const gold = 50 + 15 * unlockedIdx;
    p.gold += gold;
    audio.sfx('victory');
    toast(`Bonus chest: ${picks.map((c) => c.icon + ' ' + c.name).join(', ')} and ${gold} gold!`, { icon: '🎁', kind: 'gold', ms: 5000 });
    game.save();
    game.go('quests');
  };

  main.append(
    h(
      'div.window.streak-box',
      {},
      h('div.streak-flame' + (streak ? '' : '.out'), {}, '🔥'),
      h(
        'div',
        {},
        h('div.streak-count', {}, `${streak}-day streak`),
        h('div.muted', {}, `Best: ${p.streak.best} days · Win at least one battle a day to keep it alive.`),
        h('div.muted', {}, `Streak bonus: +${Math.min(20, streak * 2)}% XP (max +20%)`),
        h('div.milestones', {}, MILESTONES.map((m) => h('span.milestone' + (p.streak.best >= m ? '.hit' : ''), {}, `${m}d`)))
      )
    ),
    h('p.muted.center', {}, 'New quests every day at midnight.'),
    h(
      'div.quest-list',
      {},
      d.quests.map((q) => {
        const done = q.progress >= q.target;
        return h(
          'div.card.quest' + (q.claimed ? '.claimed' : done ? '.done' : ''),
          {},
          h('div.quest-text', {}, q.text),
          h('div.bar-row', {}, bar(q.progress, q.target, 'xp'), h('span.hp-text', {}, `${q.progress}/${q.target}`)),
          h(
            'div.item-foot',
            {},
            h('span.muted.small', {}, `💰 ${q.gold} · ⭐ ${q.xp} XP`),
            q.claimed ? h('span.badge', {}, 'CLAIMED') : done ? btn('Claim!', () => claim(q), 'primary') : h('span.muted.small', {}, 'In progress')
          )
        );
      })
    ),
    h(
      'div.card.quest.bonus' + (d.bonusClaimed ? '.claimed' : ''),
      {},
      h('div.quest-text', {}, '🎁 Bonus chest: claim all 3 quests today'),
      h('div.item-foot', {}, d.bonusClaimed ? h('span.badge', {}, 'CLAIMED') : allClaimed ? btn('Open chest!', claimBonus, 'primary') : h('span.muted.small', {}, `${d.quests.filter((q) => q.claimed).length}/3 claimed`))
    )
  );
}
