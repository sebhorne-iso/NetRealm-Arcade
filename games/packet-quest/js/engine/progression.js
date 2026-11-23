// Levels, derived player stats, monster scaling and rewards.
import { CLASSES } from '../content/classes.js';
import { ITEM_MAP } from '../content/items.js';
import { currentStreak } from '../content/quests.js';

export const MAX_LEVEL = 30;

export function xpToNext(level) {
  return 60 + 40 * (level - 1);
}

export function baseHp(level) {
  return 100 + 14 * (level - 1);
}
export function baseAtk(level) {
  return Math.round(10 + 2.5 * (level - 1));
}
export function baseBw(level) {
  return Math.round(10 + 1.5 * (level - 1));
}

// Add XP and process level-ups. Returns number of levels gained.
export function grantXp(profile, amount) {
  let gained = 0;
  profile.xp += amount;
  profile.totalXp = (profile.totalXp || 0) + amount;
  while (profile.level < MAX_LEVEL && profile.xp >= xpToNext(profile.level)) {
    profile.xp -= xpToNext(profile.level);
    profile.level++;
    profile.sp++;
    gained++;
  }
  if (profile.level >= MAX_LEVEL) profile.xp = Math.min(profile.xp, xpToNext(MAX_LEVEL));
  return gained;
}

export function playerStats(profile, zoneId = null) {
  const L = profile.level;
  const cls = CLASSES[profile.cls] || CLASSES.knight;
  const has = (id) => !!profile.skills[id];
  const s = {
    maxHp: baseHp(L) * cls.hpMult,
    atk: baseAtk(L),
    maxBw: baseBw(L) * cls.bwMult,
    crit: 0.05 + cls.critBonus,
    goldMult: cls.goldMult,
    xpMult: 1,
    speedBonus: 0,
    dmgMult: 1,
    typeDmg: {},
    comboStep: has('pipelining') ? 0.15 : 0.1,
    zoneBonus: false,
  };
  for (const slot of ['weapon', 'armor', 'accessory']) {
    const item = ITEM_MAP[profile.gear[slot]];
    if (!item) continue;
    const e = item.effects || {};
    s.atk += e.atk || 0;
    s.maxHp += e.hp || 0;
    s.maxBw += e.bw || 0;
    s.crit += e.crit || 0;
    s.goldMult += e.gold || 0;
    s.xpMult += e.xp || 0;
    s.speedBonus += e.speed || 0;
    s.dmgMult += e.dmg || 0;
    for (const [t, m] of Object.entries(e.typeDmg || {})) s.typeDmg[t] = (s.typeDmg[t] || 1) * m;
  }
  if (has('redundant-psu')) s.maxHp *= 1.15;
  if (has('caching')) s.goldMult += 0.2;
  if (has('overclock')) s.crit += 0.08;
  if (has('low-latency')) s.speedBonus += 4;
  if (has('etherchannel')) s.dmgMult += 0.15;
  if (has('tab-completion')) {
    s.typeDmg.terminal = (s.typeDmg.terminal || 1) * 1.3;
    s.typeDmg.input = (s.typeDmg.input || 1) * 1.3;
  }
  if (has('artifact-cache')) {
    s.goldMult += 0.25;
    s.xpMult += 0.15;
  }
  if (zoneId && cls.zoneBonus.includes(zoneId)) {
    s.dmgMult *= 1.2;
    s.zoneBonus = true;
  }
  if (zoneId === 'core') s.dmgMult *= 1.1;
  const streak = currentStreak(profile);
  s.streakBonus = Math.min(0.2, streak * 0.02);
  s.xpMult += s.streakBonus;
  if (profile.hardcore) {
    s.xpMult *= 1.5;
    s.goldMult *= 1.5;
  }
  s.maxHp = Math.round(s.maxHp);
  s.maxBw = Math.round(s.maxBw);
  s.crit = Math.min(0.6, s.crit);
  return s;
}

// kind: 'normal' | 'boss' | 'bug'
// Monsters are tuned to the zone's recommended level, partially catching up with over-levelled
// players so battles stay meaty (and keep asking questions). The 1.5 factor accounts for the
// average combo + speed-crit bonus of a player who knows their stuff.
export function monsterStats(zone, zoneIndex, kind = 'normal', { count = 4, hardcore = false, playerLevel = 1 } = {}) {
  const rec = zone.recLevel || 1;
  const scaled = Math.round(rec + Math.max(0, playerLevel - rec) * 0.5);
  const refAtk = baseAtk(scaled);
  const refHp = baseHp(scaled);
  const isFinal = zone.id === 'core';
  const hits = kind === 'boss' ? (isFinal ? 18 : 12) : kind === 'bug' ? count : isFinal ? 5 : 4;
  const hp = Math.round(refAtk * hits * (kind === 'bug' ? 1 : 1.5));
  let atk = Math.round(refHp * (kind === 'boss' ? 0.25 : 0.22));
  if (hardcore) atk = Math.round(atk * 1.25);
  const lvl = scaled + (kind === 'boss' ? 2 : 0);
  let xp = 25 + 14 * zoneIndex;
  let gold = 12 + 7 * zoneIndex;
  if (kind === 'boss') {
    xp *= 4;
    gold *= 5;
  }
  if (kind === 'bug') {
    xp = Math.round(xp * 0.6 + count * 6);
    gold = Math.round(gold * 0.6 + count * 4);
  }
  return { hp, maxHp: hp, atk, level: lvl, xp, gold };
}

export function xpPerCorrect(zoneIndex) {
  return 3 + zoneIndex;
}
