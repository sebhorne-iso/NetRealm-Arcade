import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as g from '../js/engine/generators.js';
import { normalize, iosMatch, checkAnswer, instantiate, selectQuestion, validateQuestion } from '../js/engine/questions.js';
import { recordAnswer, isBug, mastery, INTERVALS, WRONG_DELAY } from '../js/engine/srs.js';
import { makeRng } from '../js/engine/rng.js';
import { grantXp, xpToNext, playerStats, monsterStats } from '../js/engine/progression.js';
import { newProfile, migrateProfile } from '../js/engine/state.js';
import { ensureDaily, questEvent, updateStreak, currentStreak, dayKey, prevDayKey } from '../js/content/quests.js';
import { checkAchievements } from '../js/content/achievements.js';
import { canLearn, SKILL_MAP } from '../js/content/skills.js';

test('subnet math: known values', () => {
  assert.equal(g.networkOf('172.16.45.200', 20), '172.16.32.0');
  assert.equal(g.broadcastOf('172.16.45.200', 20), '172.16.47.255');
  assert.equal(g.networkOf('192.168.10.70', 26), '192.168.10.64');
  assert.equal(g.broadcastOf('192.168.10.70', 26), '192.168.10.127');
  assert.equal(g.firstHost('10.1.1.70', 26), '10.1.1.65');
  assert.equal(g.lastHost('10.1.1.70', 26), '10.1.1.126');
  assert.equal(g.networkOf('10.200.3.4', 9), '10.128.0.0');
  assert.equal(g.broadcastOf('10.0.0.1', 8), '10.255.255.255');
  assert.equal(g.prefixToMask(21), '255.255.248.0');
  assert.equal(g.prefixToMask(32), '255.255.255.255');
  assert.equal(g.prefixToMask(0), '0.0.0.0');
  assert.equal(g.maskToPrefix('255.255.240.0'), 20);
  assert.equal(g.wildcardFor(22), '0.0.3.255');
  assert.equal(g.wildcardFor(32), '0.0.0.0');
  assert.equal(g.usableHosts(24), 254);
  assert.equal(g.usableHosts(30), 2);
  assert.equal(g.usableHosts(16), 65534);
  assert.equal(g.smallestPrefixFor(50), 26);
  assert.equal(g.smallestPrefixFor(62), 26);
  assert.equal(g.smallestPrefixFor(63), 25);
  assert.equal(g.smallestPrefixFor(2), 30);
  assert.equal(g.ipClass('172.20.1.1'), 'B');
  assert.equal(g.ipClass('223.1.1.1'), 'C');
  assert.equal(g.isPrivate('172.31.0.1'), true);
  assert.equal(g.isPrivate('172.32.0.1'), false);
  assert.equal(g.isPrivate('192.169.1.1'), false);
  assert.equal(g.toBin8(192), '11000000');
});

test('every generator produces self-consistent questions across difficulties', () => {
  const rng = makeRng('gen-test');
  for (const [name, gen] of Object.entries(g.GENERATORS)) {
    for (const d of [1, 2, 3]) {
      for (let i = 0; i < 200; i++) {
        const q = gen.make(rng, d);
        assert.ok(q.q && q.explain, `${name} missing text`);
        if (q.type === 'mc') {
          assert.equal(new Set(q.choices).size, q.choices.length, `${name} duplicate choices`);
          assert.ok(q.answer >= 0 && q.answer < q.choices.length);
        } else {
          assert.ok(q.answers.length > 0);
        }
      }
    }
  }
});

test('generated subnet questions never use network/broadcast as the host', () => {
  const rng = makeRng('host-check');
  for (let i = 0; i < 500; i++) {
    const q = g.GENERATORS['subnet-network'].make(rng, (i % 3) + 1);
    const [, ip, prefix] = q.q.match(/of (\S+)\/(\d+)\?/);
    assert.notEqual(ip, g.networkOf(ip, +prefix), q.q);
    assert.notEqual(ip, g.broadcastOf(ip, +prefix), q.q);
    assert.equal(q.answers[0], g.networkOf(ip, +prefix));
  }
});

test('same-subnet generator answers correctly', () => {
  const rng = makeRng('same');
  for (let i = 0; i < 300; i++) {
    const q = g.GENERATORS['same-subnet'].make(rng, 2);
    const [, a, p, b] = q.q.match(/Are (\S+)\/(\d+) and (\S+)\/\d+/);
    const same = g.networkOf(a, +p) === g.networkOf(b, +p);
    assert.equal(q.answer, same ? 0 : 1);
  }
});

test('ip-private generator has exactly one private choice', () => {
  const rng = makeRng('priv');
  for (let i = 0; i < 300; i++) {
    const q = g.GENERATORS['ip-private'].make(rng, 1);
    assert.equal(q.choices.filter(g.isPrivate).length, 1, q.choices.join(','));
    assert.ok(g.isPrivate(q.choices[q.answer]));
  }
});

test('normalize forgives case, spacing, quotes and a trailing full stop', () => {
  assert.equal(normalize('  Show   IP  Route  '), 'show ip route');
  assert.equal(normalize('1500.'), '1500');
  assert.equal(normalize('git add .'), 'git add .');
  assert.equal(normalize('“quoted”'), '"quoted"');
});

test('IOS abbreviation matching', () => {
  assert.ok(iosMatch('sh ip int br', 'show ip interface brief'));
  assert.ok(iosMatch('conf t', 'configure terminal'));
  assert.ok(iosMatch('copy run start', 'copy running-config startup-config'));
  assert.ok(iosMatch('ip ro 0.0.0.0 0.0.0.0 203.0.113.1', 'ip route 0.0.0.0 0.0.0.0 203.0.113.1'));
  assert.ok(iosMatch('int g0/1', 'interface gigabitethernet0/1'));
  assert.ok(!iosMatch('ip ro 0.0.0.0 0.0.0.0 203.0.113', 'ip route 0.0.0.0 0.0.0.0 203.0.113.1'), 'IP addresses must be exact');
  assert.ok(!iosMatch('s ip route', 'show ip route'), 'one-letter abbreviations are too ambiguous');
  assert.ok(!iosMatch('show ip route extra', 'show ip route'));
});

test('checkAnswer handles every question type', () => {
  const rng = makeRng('check');
  const mc = instantiate({ id: 'x', type: 'mc', q: 'q', explain: 'e', topic: 't', choices: ['right', 'w1', 'w2', 'w3'], answer: 0 }, rng);
  assert.equal(mc.choices[mc.answer], 'right');
  assert.ok(checkAnswer(mc, mc.answer).correct);
  assert.ok(!checkAnswer(mc, (mc.answer + 1) % 4).correct);

  const order = instantiate({ id: 'o', type: 'order', q: 'q', explain: 'e', topic: 't', items: ['a', 'b', 'c', 'd'] }, rng);
  assert.notDeepEqual(order.items, ['a', 'b', 'c', 'd']);
  assert.ok(checkAnswer(order, ['a', 'b', 'c', 'd']).correct);
  assert.ok(!checkAnswer(order, ['b', 'a', 'c', 'd']).correct);

  const input = { type: 'input', answers: ['/26', '26'] };
  assert.ok(checkAnswer(input, ' /26 ').correct);
  assert.ok(checkAnswer(input, '26').correct);
  assert.ok(!checkAnswer(input, '27').correct);
  assert.ok(checkAnswer({ type: 'input', answers: ['65534'] }, '65,534').correct);

  const term = { type: 'terminal', answers: ['systemctl restart nginx'], patterns: [] };
  assert.ok(checkAnswer(term, 'sudo systemctl restart nginx').correct, 'sudo prefix is forgiven');
  const ios = { type: 'terminal', ios: true, answers: ['show ip route'] };
  assert.ok(checkAnswer(ios, 'sh ip ro').correct);
  const pat = { type: 'terminal', answers: ['ping 8.8.8.8'], patterns: ['ping( -c ?\\d+)* 8\\.8\\.8\\.8'] };
  assert.ok(checkAnswer(pat, 'ping -c 4 8.8.8.8').correct);
  assert.ok(!checkAnswer(pat, 'ping 8.8.4.4').correct);
});

test('validateQuestion catches common authoring mistakes', () => {
  assert.deepEqual(validateQuestion({ id: 'ok', type: 'mc', q: 'q', explain: 'long enough explanation', topic: 't', choices: ['a', 'b'], answer: 1 }), []);
  assert.ok(validateQuestion({ id: 'bad', type: 'mc', q: 'q', topic: 't', choices: ['a', 'b'], answer: 2 }).length >= 2);
  assert.ok(validateQuestion({ id: 'bad', type: 'terminal', q: 'q', explain: 'e', topic: 't', answers: ['x'] }).some((e) => e.includes('prompt')));
  assert.ok(validateQuestion({ id: 'bad', type: 'gen', generator: 'nope' }).length === 1);
});

test('spaced repetition: wrong answers become bugs until answered correctly, then keep climbing boxes', () => {
  const qmap = {};
  const t0 = 1_000_000;
  let r = recordAnswer(qmap, 'q1', false, t0);
  assert.ok(r.becameBug);
  assert.equal(qmap.q1.d, t0 + WRONG_DELAY);
  r = recordAnswer(qmap, 'q1', true, t0 + 1);
  assert.ok(r.squashed, 'next correct answer squashes the bug');
  assert.ok(!isBug(qmap.q1));
  assert.equal(qmap.q1.d, t0 + 1 + INTERVALS[1], 'but it comes back for review soon');
  r = recordAnswer(qmap, 'q1', true, t0 + 2);
  assert.ok(!r.squashed);
  assert.equal(qmap.q1.d, t0 + 2 + INTERVALS[2]);
  recordAnswer(qmap, 'q1', false, t0 + 3);
  assert.ok(isBug(qmap.q1), 'missing it again makes it a bug again');
  recordAnswer(qmap, 'q1', true, t0 + 4);
  recordAnswer(qmap, 'q1', true, t0 + 5);
  recordAnswer(qmap, 'q2', true, t0);
  assert.ok(!isBug(qmap.q2), 'never-missed questions are not bugs');
  assert.equal(mastery(qmap, ['q1', 'q2', 'q3']), (2 / 4 + 1 / 4 + 0) / 3);
});

test('selection prefers unseen/due questions and respects exclusions', () => {
  const rng = makeRng('sel');
  const pool = [{ id: 'a', type: 'mc', difficulty: 1 }, { id: 'b', type: 'mc', difficulty: 1 }, { id: 'c', type: 'mc', difficulty: 3 }];
  const now = Date.now();
  const qmap = { a: { b: 5, d: now + 1e9, s: 5, c: 5, w: 0 } };
  const counts = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 2000; i++) counts[selectQuestion(pool, qmap, { rng, now, maxDiff: 2 }).id]++;
  assert.equal(counts.c, 0, 'difficulty filter respected');
  assert.ok(counts.b > counts.a * 5, 'unseen question strongly preferred over mastered one');
  assert.equal(selectQuestion(pool, qmap, { rng, exclude: new Set(['a', 'b']), maxDiff: 2 }).id, 'c', 'falls back when filters exhaust the pool');
});

test('levelling grants skill points and carries XP over', () => {
  const p = newProfile({ name: 'T', cls: 'knight' });
  const gained = grantXp(p, xpToNext(1) + xpToNext(2) + 5);
  assert.equal(gained, 2);
  assert.equal(p.level, 3);
  assert.equal(p.sp, 2);
  assert.equal(p.xp, 5);
});

test('class, gear and skills affect player stats', () => {
  const k = newProfile({ name: 'K', cls: 'knight' });
  const s = newProfile({ name: 'S', cls: 'sorcerer' });
  assert.ok(playerStats(k).maxHp > playerStats(s).maxHp);
  assert.ok(playerStats(s).maxBw > playerStats(k).maxBw);
  assert.ok(playerStats(k, 'routing').dmgMult > playerStats(k, 'linux').dmgMult);
  const before = playerStats(k).atk;
  k.gear.weapon = 'crimper';
  assert.equal(playerStats(k).atk, before + 6);
  k.skills['redundant-psu'] = true;
  assert.ok(playerStats(k).maxHp > Math.round((100 + 0) * 1.2));
  const z = { id: 'routing', recLevel: 5 };
  const normal = monsterStats(z, 2, 'normal');
  const boss = monsterStats(z, 2, 'boss');
  assert.ok(boss.hp > normal.hp * 2 && boss.xp > normal.xp);
});

test('skill prerequisites and level gates', () => {
  const p = newProfile({ name: 'P', cls: 'ranger' });
  p.sp = 10;
  assert.equal(canLearn(p, SKILL_MAP['rubber-duck']).ok, false, 'level 2 required');
  p.level = 6;
  assert.equal(canLearn(p, SKILL_MAP['rubber-duck']).ok, true);
  assert.equal(canLearn(p, SKILL_MAP.rollback).ok, false, 'needs rubber duck first');
  assert.equal(canLearn(p, SKILL_MAP['spanning-shield']).ok, false, 'wrong class');
  assert.equal(canLearn(p, SKILL_MAP['parallel-jobs']).ok, true);
});

test('daily quests are deterministic and track progress; streaks count consecutive days', () => {
  const zones = [{ id: 'fundamentals', name: 'Packet Plains' }];
  const p = newProfile({ name: 'Q', cls: 'knight' });
  const d1 = ensureDaily(p, zones, { today: '2026-11-23' });
  const copy = JSON.parse(JSON.stringify(d1));
  p.daily = null;
  assert.deepEqual(ensureDaily(p, zones, { today: '2026-11-23' }), copy, 'same quests for the same day');
  assert.equal(d1.quests.length, 3);
  const winQuest = p.daily.quests.find((q) => q.kind === 'win' || q.kind === 'zone' || q.kind === 'flawless');
  if (winQuest) {
    for (let i = 0; i < 5; i++) questEvent(p, { type: 'win', zoneId: 'fundamentals', flawless: true });
    assert.equal(winQuest.progress, winQuest.target);
  }
  assert.equal(prevDayKey('2026-03-01'), '2026-02-28');
  assert.equal(prevDayKey('2026-01-01'), '2025-12-31');
  updateStreak(p, '2026-11-21');
  updateStreak(p, '2026-11-22');
  updateStreak(p, '2026-11-22');
  assert.equal(p.streak.count, 2);
  assert.equal(currentStreak(p, '2026-11-23'), 2, 'still alive the next day');
  assert.equal(currentStreak(p, '2026-11-25'), 0, 'broken after a missed day');
  updateStreak(p, '2026-11-25');
  assert.equal(p.streak.count, 1);
  assert.equal(p.streak.best, 2);
  assert.match(dayKey(new Date(2026, 0, 5)), /^2026-01-05$/);
});

test('achievements unlock once and save migration fills missing fields', () => {
  const p = newProfile({ name: 'A', cls: 'sorcerer' });
  p.stats.battlesWon = 1;
  const fresh = checkAchievements(p, null);
  assert.ok(fresh.some((a) => a.id === 'hello-world'));
  assert.equal(checkAchievements(p, null).length, 0);
  const old = { id: 'p1', name: 'Old', cls: 'ranger', level: 4, stats: { answered: 10 } };
  const m = migrateProfile(old);
  assert.equal(m.stats.answered, 10);
  assert.equal(m.stats.bestCombo, 0);
  assert.ok(m.zones.fundamentals.unlocked);
  assert.deepEqual(m.gear, { weapon: null, armor: null, accessory: null });
});
