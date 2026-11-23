// Skill tree. Active skills cost Bandwidth (BW) during battle; passives apply automatically.
// tier: 1-3 column in the tree; req: prerequisite skill id; minLevel: player level needed.
export const SKILLS = [
  // ---- Universal ----
  { id: 'rubber-duck', name: 'Rubber Duck Debugging', icon: '🦆', tier: 1, cost: 1, minLevel: 2, type: 'active', bw: 3, desc: 'Explain the problem to a duck. Removes 2 wrong options (or reveals a hint on typed questions).' },
  { id: 'rca', name: 'Root Cause Analysis', icon: '🔍', tier: 1, cost: 1, minLevel: 2, type: 'active', bw: 4, desc: 'Your next correct answer deals DOUBLE damage.' },
  { id: 'redundant-psu', name: 'Redundant PSU', icon: '🔋', tier: 1, cost: 1, minLevel: 2, type: 'passive', desc: '+15% max HP.' },
  { id: 'caching', name: 'Caching Layer', icon: '💾', tier: 1, cost: 1, minLevel: 2, type: 'passive', desc: '+20% gold from battles.' },
  { id: 'rollback', name: 'Rollback', icon: '⏪', tier: 2, cost: 2, minLevel: 5, req: 'rubber-duck', type: 'active', bw: 5, desc: 'Revert the last hit you took and restore that HP.' },
  { id: 'hotfix', name: 'Hotfix', icon: '🩹', tier: 2, cost: 2, minLevel: 5, req: 'redundant-psu', type: 'active', bw: 4, desc: 'Heal 30% of your max HP.' },
  { id: 'overclock', name: 'Overclock', icon: '⚡', tier: 2, cost: 2, minLevel: 5, req: 'rca', type: 'passive', desc: '+8% critical hit chance.' },
  { id: 'low-latency', name: 'Low Latency', icon: '⏱️', tier: 2, cost: 2, minLevel: 5, req: 'caching', type: 'passive', desc: 'Speed-bonus window is 4 seconds longer.' },
  { id: 'pipelining', name: 'Combo Pipelining', icon: '🔗', tier: 3, cost: 3, minLevel: 10, req: 'overclock', type: 'passive', desc: 'Each combo stack adds +15% damage instead of +10%.' },
  { id: 'graceful', name: 'Graceful Degradation', icon: '🛟', tier: 3, cost: 3, minLevel: 10, req: 'hotfix', type: 'passive', desc: 'Once per battle, survive a knockout blow with 1 HP.' },

  // ---- Network Knight ----
  { id: 'spanning-shield', cls: 'knight', name: 'Spanning Shield', icon: '🛡️', tier: 1, cost: 1, minLevel: 3, type: 'active', bw: 4, desc: 'Block the next hit completely, like STP blocking a looped port.' },
  { id: 'etherchannel', cls: 'knight', name: 'EtherChannel', icon: '🧶', tier: 2, cost: 2, minLevel: 7, req: 'spanning-shield', type: 'passive', desc: 'Bundle your links: all correct answers deal +15% damage.' },
  { id: 'fhrp', cls: 'knight', name: 'First Hop Redundancy', icon: '♻️', tier: 3, cost: 3, minLevel: 12, req: 'etherchannel', type: 'passive', desc: 'Every correct answer heals 6% of your max HP.' },

  // ---- Shell Sorcerer ----
  { id: 'sudo-bang', cls: 'sorcerer', name: 'sudo !!', icon: '🪄', tier: 1, cost: 1, minLevel: 3, type: 'active', bw: 5, desc: 'Re-run your last wrong answer with privileges: retry that question, and if you get it right, the damage you took is refunded.' },
  { id: 'tab-completion', cls: 'sorcerer', name: 'Tab Completion', icon: '⇥', tier: 2, cost: 2, minLevel: 7, req: 'sudo-bang', type: 'passive', desc: '+30% damage on terminal and typed-answer questions.' },
  { id: 'cron-job', cls: 'sorcerer', name: 'Cron Job', icon: '⏰', tier: 3, cost: 3, minLevel: 12, req: 'tab-completion', type: 'passive', desc: 'Every correct answer restores 2 BW, and every 3rd one in a row fires a bonus hit.' },

  // ---- Pipeline Ranger ----
  { id: 'parallel-jobs', cls: 'ranger', name: 'Parallel Jobs', icon: '🏹', tier: 1, cost: 1, minLevel: 3, type: 'active', bw: 5, desc: 'Your next correct answer hits twice.' },
  { id: 'artifact-cache', cls: 'ranger', name: 'Artifact Cache', icon: '📦', tier: 2, cost: 2, minLevel: 7, req: 'parallel-jobs', type: 'passive', desc: '+25% gold and +15% XP.' },
  { id: 'canary', cls: 'ranger', name: 'Canary Deploy', icon: '🐤', tier: 3, cost: 3, minLevel: 12, req: 'artifact-cache', type: 'passive', desc: 'The first wrong answer in each battle is caught by the canary and deals no damage.' },
];

export const SKILL_MAP = Object.fromEntries(SKILLS.map((s) => [s.id, s]));

export function skillsForClass(cls) {
  return SKILLS.filter((s) => !s.cls || s.cls === cls);
}

export function canLearn(profile, skill) {
  if (profile.skills[skill.id]) return { ok: false, why: 'Already learned' };
  if (skill.cls && skill.cls !== profile.cls) return { ok: false, why: 'Different class' };
  if (profile.level < skill.minLevel) return { ok: false, why: `Requires level ${skill.minLevel}` };
  if (skill.req && !profile.skills[skill.req]) return { ok: false, why: `Requires ${SKILL_MAP[skill.req].name}` };
  if (profile.sp < skill.cost) return { ok: false, why: `Needs ${skill.cost} skill point${skill.cost > 1 ? 's' : ''}` };
  return { ok: true };
}
