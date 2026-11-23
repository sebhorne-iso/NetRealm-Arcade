// Skill tree.
import { h, btn, toast } from '../ui/dom.js';
import { shell } from './shell.js';
import { audio } from '../engine/audio.js';
import { skillsForClass, canLearn, SKILL_MAP } from '../content/skills.js';
import { CLASSES } from '../content/classes.js';

export function skillsScreen(root, _params, game) {
  const p = game.profile();
  if (p.dead) return game.go('profile');
  audio.play('map');
  const main = shell(root, game, 'skills', '✨ Skill Tree');
  const skills = skillsForClass(p.cls);
  main.append(
    h('p.center', {}, h('span.sp-pill', {}, `${p.sp} skill point${p.sp === 1 ? '' : 's'}`), ' · You earn 1 skill point per level. Active skills cost Bandwidth (BW) in battle.')
  );

  const node = (sk) => {
    const learned = !!p.skills[sk.id];
    const check = canLearn(p, sk);
    return h(
      'div.skill-node' + (learned ? '.learned' : check.ok ? '.available' : '.locked') + (sk.cls ? '.class-skill' : ''),
      {},
      h('div.skill-icon', {}, sk.icon),
      h('div.skill-name', {}, sk.name),
      h('div.skill-type', {}, sk.type === 'active' ? `ACTIVE · ${sk.bw} BW` : 'PASSIVE'),
      h('p.small', {}, sk.desc),
      sk.req ? h('div.skill-req.muted.small', {}, `Requires: ${SKILL_MAP[sk.req].name}`) : null,
      learned
        ? h('div.badge.badge-gold', {}, 'LEARNED')
        : check.ok
          ? btn(`Learn (${sk.cost} SP)`, () => {
              p.sp -= sk.cost;
              p.skills[sk.id] = true;
              audio.sfx('levelup');
              toast(`Learned ${sk.icon} ${sk.name}!`, { kind: 'gold' });
              game.checkAchievements();
              game.save();
              game.go('skills');
            }, 'primary')
          : h('div.muted.small', {}, `🔒 ${check.why}`)
    );
  };

  const universal = skills.filter((s) => !s.cls);
  const cls = skills.filter((s) => s.cls);
  const tiers = [1, 2, 3];
  main.append(
    h('h2.section', {}, 'Universal skills'),
    h('div.skill-tree', {}, tiers.map((t) => h('div.skill-tier', {}, h('div.tier-label', {}, `Tier ${t}`), universal.filter((s) => s.tier === t).map(node)))),
    h('h2.section', {}, `${CLASSES[p.cls].name} skills`),
    h('div.skill-tree.class-tree', {}, tiers.map((t) => h('div.skill-tier', {}, h('div.tier-label', {}, `Tier ${t}`), cls.filter((s) => s.tier === t).map(node))))
  );
}
