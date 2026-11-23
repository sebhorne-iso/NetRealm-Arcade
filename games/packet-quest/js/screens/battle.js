// Turn-based battle: each turn is a question. Correct = you hit, wrong = it hits you.
import { h, btn, modal, toast, bar, setBar, spriteImg, storyDialog, confirmDialog, fmtNum, rich } from '../ui/dom.js';
import { renderQuestion, renderFeedback, expectedText } from '../ui/question-view.js';
import { audio } from '../engine/audio.js';
import { makeRng } from '../engine/rng.js';
import { drawSprite, spriteURL } from '../engine/sprites.js';
import { instantiate, checkAnswer, selectQuestion, srsId, SPEED_WINDOW } from '../engine/questions.js';
import { recordAnswer, bugIds } from '../engine/srs.js';
import { playerStats, monsterStats, grantXp, xpPerCorrect } from '../engine/progression.js';
import { SKILL_MAP } from '../content/skills.js';
import { CONSUMABLES, ITEM_MAP, describeEffects } from '../content/items.js';
import { heroSprite } from './shell.js';
import { sagePortrait } from './map.js';

const recent = []; // ids asked recently this session (avoid repeats across battles)
const NET_ZONES = ['fundamentals', 'subnetting', 'routing', 'security'];
const OPS_ZONES = ['linux', 'cicd', 'automation', 'cloud'];

function bump(map, key, correct) {
  const e = map[key] || (map[key] = { a: 0, c: 0 });
  e.a++;
  if (correct) e.c++;
}

export function battleScreen(root, params, game) {
  const p = game.profile();
  if (!p || p.dead) return game.go('title');
  const kind = params.kind || 'normal';
  const rng = makeRng(Date.now() ^ Math.floor(Math.random() * 1e9));
  const settings = game.settings();
  const rm = settings.reduceMotion;
  const s = p.stats;

  // ---------- zone, pool and monster ----------
  const unlocked = game.data.zones.filter((z) => p.zones[z.id]?.unlocked);
  let zone;
  let pool = [];
  let monster;
  let bugQueue = null;
  if (kind === 'bug') {
    zone = unlocked[unlocked.length - 1];
    bugQueue = rng.shuffle(bugIds(p.q)).slice(0, 6).map((id) => game.rawById(id)).filter(Boolean);
    if (!bugQueue.length) {
      toast('No Recurring Bugs are due right now.', { icon: '🐛' });
      return game.go('map');
    }
    monster = {
      id: 'recurring-bug',
      name: `Recurring Bug ×${bugQueue.length}`,
      sprite: 'bug',
      palette: { b: '#e0394a', a: '#6a1430' },
      desc: 'A swarm of every question you got wrong. Squash each one by answering it correctly. Spaced repetition FTW!',
    };
  } else {
    zone = game.data.zoneById[params.zoneId];
    pool = game.pool(zone.id);
    monster = kind === 'boss' ? zone.boss : rng.weighted(zone.monsters, (m) => (p.bestiary[m.id] ? 1 : 3));
  }
  const zoneIndex = zone.index;
  const isFinal = zone.id === 'core' && kind === 'boss';
  const ms = monsterStats(zone, zoneIndex, kind, { count: bugQueue?.length, hardcore: p.hardcore, playerLevel: p.level });
  const bugChunk = bugQueue ? Math.ceil(ms.maxHp / bugQueue.length) : 0;
  const st = playerStats(p, kind === 'bug' ? null : zone.id);
  const me = { hp: st.maxHp, bw: st.maxBw };
  const fx = { rca: false, shield: 0, crit: false, parallel: false, lastHit: 0, lastWrong: null, lastWrongDmg: 0, graceful: false, canaryUsed: false, retry: null, retrying: false, itemUsed: false, skillsUsed: new Set(), tookDamage: false, enraged: false, phase: 1 };
  let combo = 0;
  let battleXp = 0;
  let correctCount = 0;
  let q = null;
  let raw = null;
  let view = null;
  let qStart = 0;
  let speedWindow = 10;
  let ended = false;
  const asked = new Set();

  audio.play(kind === 'boss' ? 'boss' : 'battle');

  // ---------- layout ----------
  const biome = zone.biome || ['#3a7a3a', '#5aa05a', '#2a5a2a'];
  const enemyCanvas = drawSprite(monster.sprite, monster.palette);
  enemyCanvas.className = 'sprite enemy-sprite' + (kind === 'boss' ? ' boss' : '') + (kind === 'bug' ? ' bug' : '');
  const enemyHp = bar(ms.hp, ms.maxHp, 'hp');
  const enemyHpText = h('span.hp-text', {}, `${ms.hp}/${ms.maxHp}`);
  const heroImg = spriteImg(heroSprite(p), 'hero-sprite');
  const heroHp = bar(me.hp, st.maxHp, 'hp');
  const heroBw = bar(me.bw, st.maxBw, 'bw');
  const heroHpText = h('span.hp-text', {}, `${me.hp}/${st.maxHp}`);
  const heroBwText = h('span.hp-text', {}, `${me.bw}/${st.maxBw}`);
  const comboEl = h('div.combo');
  const statusEl = h('div.status-icons');
  const fxLayer = h('div.fx-layer');
  const log = h('div.battle-log', { role: 'status' });

  const enemyBox = h(
    'div.combatant.enemy',
    {},
    h('div.info.window', {}, h('div.info-name', {}, monster.name, h('span.info-lv', {}, ` Lv${ms.level}`)), h('div.bar-row', {}, h('span.bar-label', {}, 'HP'), enemyHp, enemyHpText)),
    h('div.sprite-stage', {}, enemyCanvas, h('div.shadow'))
  );
  const heroBox = h(
    'div.combatant.hero',
    {},
    h('div.sprite-stage', {}, heroImg, h('div.shadow')),
    h(
      'div.info.window',
      {},
      h('div.info-name', {}, p.name, h('span.info-lv', {}, ` Lv${p.level}`)),
      h('div.bar-row', {}, h('span.bar-label', {}, 'HP'), heroHp, heroHpText),
      h('div.bar-row', {}, h('span.bar-label', {}, 'BW'), heroBw, heroBwText),
      h('div.row.tight', {}, comboEl, statusEl)
    )
  );
  const scene = h(
    'div.battle-scene' + (kind === 'boss' ? '.boss-scene' : ''),
    { style: { '--bg1': biome[2], '--bg2': biome[0], '--bg3': biome[1] } },
    h('div.zone-tag', {}, `${zone.icon} ${kind === 'bug' ? 'Bug Tracker' : zone.name}${st.zoneBonus ? ' · class bonus +20%' : ''}`),
    enemyBox,
    heroBox,
    fxLayer
  );
  const qPanel = h('section.window.question-panel', { 'aria-label': 'Question' });
  const skillBtn = h('button.btn.action', { type: 'button', onclick: () => openSkills() }, '✨ Skills');
  const itemBtn = h('button.btn.action', { type: 'button', onclick: () => openItems() }, '🎒 Items');
  const runBtn = h('button.btn.action', { type: 'button', onclick: () => run() }, kind === 'boss' ? '🏳️ Retreat' : '🏃 Run');
  if (p.hardcore) runBtn.disabled = true;
  const actions = h('div.battle-actions', {}, skillBtn, itemBtn, runBtn);

  root.append(h('div.battle', {}, scene, log, qPanel, actions));

  const say = (msg) => log.replaceChildren(rich(msg));
  say(kind === 'bug' ? `🐛 ${bugQueue.length} Recurring Bug${bugQueue.length > 1 ? 's' : ''} crawl out of the backlog!` : kind === 'boss' ? `👹 ${monster.name} attacks! ${monster.desc || ''}` : `A wild **${monster.name}** appears! ${monster.desc || ''}`);

  // ---------- helpers ----------
  function refresh() {
    setBar(enemyHp, ms.hp, ms.maxHp);
    enemyHpText.textContent = `${Math.max(0, ms.hp)}/${ms.maxHp}`;
    setBar(heroHp, me.hp, st.maxHp);
    heroHpText.textContent = `${Math.max(0, me.hp)}/${st.maxHp}`;
    setBar(heroBw, me.bw, st.maxBw);
    heroBwText.textContent = `${me.bw}/${st.maxBw}`;
    comboEl.textContent = combo >= 2 ? `🔥 ${combo}x combo` : '';
    const icons = [];
    if (fx.rca) icons.push('🔍×2');
    if (fx.shield) icons.push('🛡️');
    if (fx.crit) icons.push('🥤');
    if (fx.parallel) icons.push('🏹×2');
    if (p.inventory.snapshot) icons.push('💿');
    statusEl.textContent = icons.join(' ');
    const locked = !view || view.locked || ended;
    skillBtn.disabled = locked || !activeSkills().length;
    itemBtn.disabled = locked || fx.itemUsed || !usableItems().length;
    runBtn.disabled = p.hardcore || ended;
  }

  function floatText(target, text, cls) {
    const el = h('div.float-text.' + cls, {}, text);
    const rect = target.getBoundingClientRect();
    const srect = scene.getBoundingClientRect();
    el.style.left = rect.left - srect.left + rect.width / 2 + (Math.random() * 30 - 15) + 'px';
    el.style.top = rect.top - srect.top + rect.height * 0.25 + 'px';
    fxLayer.append(el);
    setTimeout(() => el.remove(), 1300);
  }

  function animate(el, cls, ms2 = 450) {
    if (rm) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), ms2);
  }

  function difficultyRange() {
    if (kind === 'boss') return fx.enraged || fx.phase >= 3 ? [3, 3] : [2, 3];
    if (zone.id === 'core') return [2, 3];
    return p.zones[zone.id].wins < 2 ? [1, 2] : [1, 3];
  }

  function currentPool() {
    if (!isFinal) return pool;
    if (fx.phase === 1) return pool.filter((x) => NET_ZONES.includes(x.zoneId));
    if (fx.phase === 2) return pool.filter((x) => OPS_ZONES.includes(x.zoneId));
    return pool;
  }

  // ---------- turn flow ----------
  function nextQuestion() {
    fx.itemUsed = false;
    fx.skillsUsed.clear();
    fx.retrying = false;
    if (fx.retry) {
      raw = fx.retry;
      fx.retry = null;
      fx.retrying = true;
    } else if (bugQueue) {
      raw = bugQueue[0];
    } else {
      const [minDiff, maxDiff] = difficultyRange();
      raw = selectQuestion(currentPool(), p.q, { rng, exclude: new Set([...asked, ...recent]), minDiff, maxDiff });
    }
    const id = srsId(raw);
    asked.add(id);
    recent.push(id);
    if (recent.length > 30) recent.shift();
    q = instantiate(raw, rng, { zoneId: raw.zoneId || zone.id });
    game.currentQuestion = q; // exposed for automated playtests
    speedWindow = (SPEED_WINDOW[q.type] || 12) + st.speedBonus;
    view?.destroy();
    view = renderQuestion(qPanel, q, { onAnswer: resolve, speedWindow, showTimer: settings.showTimer, reduceMotion: rm });
    qStart = performance.now();
    if (fx.retrying) view.showHint('🪄 sudo !! — retrying the question you missed. Get it right to refund the damage!');
    if (window.matchMedia('(pointer: fine)').matches || q.type === 'mc' || q.type === 'order') view.focus();
    refresh();
  }

  function resolve(response) {
    const elapsed = (performance.now() - qStart) / 1000;
    const { correct } = checkAnswer(q, response);
    view.showResult(correct);
    s.answered++;
    bump(s.byZone, q.zoneId, correct);
    bump(s.byType, q.type, correct);
    bump(s.byTopic, `${q.zoneId}|${q.topic || 'General'}`, correct);
    const srs = recordAnswer(p.q, q.srcId, correct);
    const extra = [];
    let crit = false;
    if (correct) {
      s.correct++;
      combo++;
      correctCount++;
      s.bestCombo = Math.max(s.bestCombo, combo);
      const fast = elapsed <= speedWindow && !view.usedHelp;
      crit = fast || fx.crit || rng.chance(st.crit);
      if (fast) s.crits++;
      if (q.type === 'terminal') s.terminalCorrect++;
      if (q.generated && /^gen:(subnet|wildcard)/.test(q.srcId)) s.subnetCorrect++;
      if (srs.squashed) {
        s.bugsSquashed++;
        extra.push(h('div.fb-extra', {}, '🐛 Recurring Bug squashed!'));
      }
      const mult = (1 + st.comboStep * Math.min(combo - 1, 5)) * st.dmgMult * (st.typeDmg[q.type] || 1) * (crit ? 1.5 : 1) * (fx.rca ? 2 : 1);
      let hit = Math.max(1, Math.round(st.atk * mult * rng.float(0.92, 1.08)));
      if (bugQueue) hit = bugChunk;
      let hits = fx.parallel ? 2 : 1;
      if (p.skills['cron-job'] && combo % 3 === 0) hits += 0.5;
      const total = Math.round(hit * hits);
      fx.rca = false;
      fx.crit = false;
      fx.parallel = false;
      ms.hp -= total;
      if (bugQueue) {
        bugQueue.shift();
        if (!bugQueue.length) ms.hp = 0;
      }
      battleXp += xpPerCorrect(zoneIndex);
      animate(heroBox, 'lunge');
      setTimeout(() => {
        animate(enemyCanvas, 'hit-flash', 400);
        animate(enemyBox, 'shake', 400);
        floatText(enemyCanvas, `-${total}`, crit ? 'crit' : 'dmg');
        if (fast) floatText(enemyCanvas, 'FAST! ⚡', 'tag');
        else if (crit) floatText(enemyCanvas, 'CRIT!', 'tag');
        if (hits > 1) floatText(enemyCanvas, hits >= 2 ? 'DOUBLE HIT' : 'CRON BONUS', 'tag');
        audio.sfx(crit ? 'crit' : 'hit');
        if (crit && !rm) animate(scene, 'screen-shake', 300);
        refresh();
      }, rm ? 0 : 180);
      audio.sfx('correct');
      let healed = 0;
      if (fx.retrying && fx.lastWrongDmg) {
        healed += fx.lastWrongDmg;
        extra.push(h('div.fb-extra', {}, `🪄 sudo !! refunded ${fx.lastWrongDmg} HP`));
        fx.lastWrongDmg = 0;
      }
      if (p.skills.fhrp) healed += Math.round(st.maxHp * 0.06);
      if (healed) {
        me.hp = Math.min(st.maxHp, me.hp + healed);
        setTimeout(() => floatText(heroImg, `+${healed}`, 'heal'), 300);
      }
      if (p.skills['cron-job']) me.bw = Math.min(st.maxBw, me.bw + 2);
      say(`You hit **${monster.name}** for **${total}**${crit ? (fast ? ' with a ⚡ speed crit' : ' with a critical hit') : ''}!${combo >= 2 ? ` 🔥 ${combo}x combo.` : ''}`);
    } else {
      combo = 0;
      if (bugQueue) bugQueue.push(bugQueue.shift());
      fx.lastWrong = raw;
      audio.sfx('wrong');
      let dmg = 0;
      if (p.skills.canary && !fx.canaryUsed) {
        fx.canaryUsed = true;
        say('🐤 Your canary deploy caught the failure. No damage!');
        extra.push(h('div.fb-extra', {}, '🐤 Canary Deploy absorbed this one.'));
      } else if (fx.shield > 0) {
        fx.shield--;
        audio.sfx('block');
        say(`🛡️ Blocked! ${monster.name}'s attack bounced off.`);
        setTimeout(() => floatText(heroImg, 'BLOCKED', 'tag'), 200);
      } else {
        dmg = Math.max(1, Math.round(ms.atk * (fx.enraged ? 1.2 : 1) * rng.float(0.85, 1.15)));
        me.hp -= dmg;
        fx.lastHit = dmg;
        fx.lastWrongDmg = dmg;
        fx.tookDamage = true;
        say(`**${monster.name}** strikes you for **${dmg}** damage!`);
        animate(enemyBox, 'enemy-lunge');
        setTimeout(() => {
          animate(heroBox, 'shake', 400);
          animate(heroImg, 'hit-flash', 400);
          floatText(heroImg, `-${dmg}`, 'hurt');
          audio.sfx('hurt');
          if (!rm) animate(scene, 'screen-shake', 300);
          refresh();
        }, rm ? 0 : 200);
      }
      if (me.hp <= 0) {
        if (p.skills.graceful && !fx.graceful) {
          fx.graceful = true;
          me.hp = 1;
          extra.push(h('div.fb-extra', {}, '🛟 Graceful Degradation: you cling on with 1 HP!'));
        } else if (p.inventory.snapshot > 0) {
          p.inventory.snapshot--;
          me.hp = Math.round(st.maxHp * 0.5);
          extra.push(h('div.fb-extra', {}, '💿 Restored from Snapshot Backup at 50% HP!'));
          audio.sfx('heal');
        }
      }
    }
    game.emit({ type: 'answer', correct, crit: correct && crit && elapsed <= speedWindow && !view.usedHelp, qtype: q.type, combo, squashed: srs.squashed, zoneId: q.zoneId });
    refresh();
    game.save();
    const label = ms.hp <= 0 ? 'Victory! ▶' : me.hp <= 0 ? 'Continue…' : 'Next question ▶';
    renderFeedback(view, { correct, expected: expectedText(q), explain: q.explain, extra, onContinue: afterTurn, continueLabel: label });
  }

  function afterTurn() {
    if (ended) return;
    if (ms.hp <= 0) return victory();
    if (me.hp <= 0) return defeat();
    // Boss phases
    if (kind === 'boss' && !isFinal && !fx.enraged && ms.hp <= ms.maxHp / 2) {
      fx.enraged = true;
      enemyCanvas.classList.add('enraged');
      bossTaunt(monster.taunts?.[1] || `${monster.name} is ENRAGED! Its attacks grow stronger and its questions harder!`);
    }
    if (isFinal) {
      const want = ms.hp <= ms.maxHp / 3 ? 3 : ms.hp <= (ms.maxHp * 2) / 3 ? 2 : 1;
      if (want > fx.phase) {
        fx.phase = want;
        fx.enraged = want === 3;
        enemyCanvas.classList.add('phase' + want);
        const msg = want === 2 ? monster.taunts?.[1] || 'Phase 2!' : monster.taunts?.[2] || 'Final phase!';
        bossTaunt(msg);
      }
    }
    nextQuestion();
  }

  function bossTaunt(msg) {
    audio.sfx('boss');
    say(`👹 ${msg}`);
    if (!rm) animate(scene, 'boss-flash', 900);
  }

  // ---------- skills & items ----------
  function activeSkills() {
    return Object.keys(p.skills)
      .map((id) => SKILL_MAP[id])
      .filter((sk) => sk && sk.type === 'active');
  }

  function canUseSkill(sk) {
    if (fx.skillsUsed.has(sk.id)) return 'Already used this turn';
    if (me.bw < sk.bw) return `Needs ${sk.bw} BW`;
    if (sk.id === 'rollback' && !fx.lastHit) return 'No hit to roll back';
    if (sk.id === 'sudo-bang' && (!fx.lastWrong || fx.retrying)) return 'No failed command to retry';
    if (sk.id === 'rubber-duck' && q.type === 'order' && view.lockedPrefix) return 'Already placed';
    if (sk.id === 'hotfix' && me.hp >= st.maxHp) return 'HP is full';
    return null;
  }

  function useSkill(sk, close) {
    if (canUseSkill(sk) || view.locked) return;
    me.bw -= sk.bw;
    fx.skillsUsed.add(sk.id);
    audio.sfx('skill');
    close();
    switch (sk.id) {
      case 'rubber-duck':
        if (q.type === 'mc' || q.type === 'order') view.eliminate(2);
        else view.showHint(view.autoHint());
        say('🦆 You explain the problem to your rubber duck... and it helps!');
        break;
      case 'rca':
        fx.rca = true;
        say('🔍 Root Cause Analysis: your next correct answer deals DOUBLE damage.');
        break;
      case 'rollback':
        me.hp = Math.min(st.maxHp, me.hp + fx.lastHit);
        floatText(heroImg, `+${fx.lastHit}`, 'heal');
        say(`⏪ Rolled back the last hit: +${fx.lastHit} HP.`);
        fx.lastHit = 0;
        break;
      case 'hotfix': {
        const amt = Math.round(st.maxHp * 0.3);
        me.hp = Math.min(st.maxHp, me.hp + amt);
        floatText(heroImg, `+${amt}`, 'heal');
        say(`🩹 Hotfix deployed: +${amt} HP.`);
        break;
      }
      case 'spanning-shield':
        fx.shield++;
        say('🛡️ Spanning Shield raised: the next hit will be blocked.');
        break;
      case 'parallel-jobs':
        fx.parallel = true;
        say('🏹 Parallel Jobs: your next correct answer hits twice.');
        break;
      case 'sudo-bang':
        asked.delete(srsId(raw));
        fx.retry = fx.lastWrong;
        say('🪄 sudo !! — re-running your last failed command with privileges...');
        nextQuestion();
        return;
    }
    refresh();
    view.focus();
  }

  function openSkills() {
    const list = activeSkills();
    modal(
      (close) =>
        h(
          'div.menu-list',
          {},
          h('p.muted.small', {}, `Bandwidth: ${me.bw}/${st.maxBw} BW. Each skill can be used once per turn.`),
          list.map((sk) => {
            const why = canUseSkill(sk);
            return h(
              'button.menu-item',
              { type: 'button', disabled: !!why, onclick: () => useSkill(sk, close) },
              h('span.menu-icon', {}, sk.icon),
              h('span.menu-main', {}, h('strong', {}, sk.name), h('small.block', {}, why || sk.desc)),
              h('span.menu-cost', {}, `${sk.bw} BW`)
            );
          })
        ),
      { title: '✨ Skills' }
    );
  }

  function usableItems() {
    return CONSUMABLES.filter((it) => p.inventory[it.id] > 0 && it.id !== 'snapshot');
  }

  function useItem(it, close) {
    if (fx.itemUsed || view.locked || !(p.inventory[it.id] > 0)) return;
    p.inventory[it.id]--;
    fx.itemUsed = true;
    close();
    switch (it.id) {
      case 'ping-potion':
      case 'jumbo-frame': {
        const amt = Math.round(st.maxHp * (it.id === 'ping-potion' ? 0.35 : 0.75));
        me.hp = Math.min(st.maxHp, me.hp + amt);
        floatText(heroImg, `+${amt}`, 'heal');
        audio.sfx('heal');
        say(`${it.icon} ${it.name}: +${amt} HP.`);
        break;
      }
      case 'bandwidth-boost': {
        const amt = Math.round(st.maxBw * 0.5);
        me.bw = Math.min(st.maxBw, me.bw + amt);
        audio.sfx('heal');
        say(`📶 +${amt} BW.`);
        break;
      }
      case 'packet-capture':
        view.showHint(view.autoHint());
        audio.sfx('skill');
        say('📡 You capture some packets and spot a clue...');
        break;
      case 'traceroute-scroll':
        view.eliminate(2);
        audio.sfx('skill');
        say('📜 The Traceroute Scroll reveals part of the path.');
        break;
      case 'firewall-rule':
        fx.shield++;
        audio.sfx('block');
        say('🧱 deny any any: the next hit will be blocked.');
        break;
      case 'energy-drink':
        fx.crit = true;
        audio.sfx('skill');
        say('🥤 Caffeine Overflow! Your next correct answer is a guaranteed crit.');
        break;
    }
    game.save();
    refresh();
    view.focus();
  }

  function openItems() {
    const list = usableItems();
    modal(
      (close) =>
        h(
          'div.menu-list',
          {},
          h('p.muted.small', {}, 'One item per turn.'),
          list.map((it) =>
            h(
              'button.menu-item',
              { type: 'button', onclick: () => useItem(it, close) },
              h('span.menu-icon', {}, it.icon),
              h('span.menu-main', {}, h('strong', {}, it.name), h('small.block', {}, it.desc)),
              h('span.menu-cost', {}, `×${p.inventory[it.id]}`)
            )
          )
        ),
      { title: '🎒 Items' }
    );
  }

  async function run() {
    if (p.hardcore || ended) return;
    if (!(await confirmDialog(kind === 'boss' ? 'Retreat from the boss? You keep XP from correct answers.' : 'Run back to the map? You keep XP from correct answers.', { yes: 'Run', no: 'Stay' }))) return;
    ended = true;
    const levels = grantXp(p, Math.round(battleXp * st.xpMult));
    game.save();
    if (levels) toast(`Level up! You are now Lv ${p.level}.`, { icon: '⭐', kind: 'gold' });
    game.go('map');
  }

  // ---------- endings ----------
  function rollDrop() {
    const shop = CONSUMABLES.filter((c) => c.unlockZone <= zoneIndex && c.id !== 'snapshot');
    return rng.weighted(shop, (c) => 100 / c.price);
  }

  function victory() {
    ended = true;
    view?.destroy();
    audio.stop();
    audio.sfx('victory');
    enemyCanvas.classList.add('defeated');
    const xpGain = Math.round((battleXp + ms.xp) * st.xpMult);
    const goldGain = Math.round(ms.gold * st.goldMult * rng.float(0.9, 1.1));
    const levels = grantXp(p, xpGain);
    p.gold += goldGain;
    s.goldEarned += goldGain;
    s.battlesWon++;
    const flawless = !fx.tookDamage;
    if (flawless) s.flawless++;
    if (me.hp / st.maxHp < 0.1) s.clutch++;
    if (kind !== 'bug') p.bestiary[monster.id] = (p.bestiary[monster.id] || 0) + 1;
    const zst = p.zones[zone.id];
    const drops = [];
    let loot = null;
    let firstClear = false;
    let newZone = null;
    if (kind === 'normal') zst.wins++;
    if (kind === 'boss') {
      s.bossesDefeated++;
      if (flawless) s.flawlessBoss++;
      if (!zst.bossDefeated) {
        firstClear = true;
        zst.bossDefeated = true;
        if (monster.loot && ITEM_MAP[monster.loot]) {
          loot = ITEM_MAP[monster.loot];
          p.owned[loot.id] = true;
          if (!p.gear[loot.slot]) p.gear[loot.slot] = loot.id;
        }
        newZone = game.data.zones[zoneIndex + 1] || null;
        if (newZone && !p.zones[newZone.id]) p.zones[newZone.id] = { unlocked: true, wins: 0, bossDefeated: false };
      }
      drops.push(ITEM_MAP['ping-potion'], rollDrop());
    } else if (rng.chance(0.3)) drops.push(rollDrop());
    for (const d of drops) p.inventory[d.id] = (p.inventory[d.id] || 0) + 1;
    game.emit({ type: 'win', zoneId: zone.id, boss: kind === 'boss', flawless, kind });
    game.save();

    if (levels) setTimeout(() => audio.sfx('levelup'), 700);
    const rewards = h(
      'div.rewards',
      {},
      h('div.reward', {}, `⭐ +${fmtNum(xpGain)} XP`, st.streakBonus ? h('small.muted', {}, ` (incl. 🔥 +${Math.round(st.streakBonus * 100)}% streak)`) : null),
      h('div.reward', {}, `💰 +${fmtNum(goldGain)} gold`),
      drops.map((d) => h('div.reward', {}, `${d.icon} ${d.name}`)),
      flawless ? h('div.reward.gold', {}, '✨ Flawless! No damage taken.') : null,
      levels ? h('div.reward.levelup', {}, `LEVEL UP! You are now Lv ${p.level} (+${levels} skill point${levels > 1 ? 's' : ''})`) : null,
      loot ? h('div.loot', {}, h('div.loot-title', {}, 'BOSS LOOT'), h('div', {}, `${loot.icon} ${loot.name}`), h('small.muted', {}, describeEffects(loot.effects)), h('small.block', {}, loot.desc)) : null,
      kind === 'normal' && !zst.bossDefeated && zst.wins === zone.battlesToBoss ? h('div.reward.danger', {}, `👹 ${zone.boss.name} has awoken! Challenge it from the zone menu.`) : null
    );
    const acc = `${correctCount} correct this battle`;
    modal(
      (close) =>
        h(
          'div.result.victory',
          {},
          h('div.result-title', {}, kind === 'boss' ? 'BOSS DEFEATED!' : kind === 'bug' ? 'BUGS SQUASHED!' : 'VICTORY!'),
          h('p.center.muted', {}, `${monster.name} was defeated · ${acc}`),
          rewards,
          h(
            'div.row.center.wrap',
            {},
            firstClear
              ? btn('Continue ▶', () => { close(); afterBoss(newZone); }, 'primary big')
              : [
                  kind === 'bug'
                    ? game.bugCount(p) ? btn('🐛 More bugs', () => { close(); game.go('battle', { kind: 'bug' }); }, 'primary') : null
                    : btn('⚔️ Fight again', () => { close(); game.go('battle', { zoneId: zone.id, kind: 'normal' }); }, 'primary'),
                  kind === 'normal' && zst.wins >= zone.battlesToBoss && !zst.bossDefeated
                    ? btn('👹 Fight the boss', () => { close(); game.go('map', { openZone: zone.id }); }, 'danger')
                    : null,
                  btn('🗺️ Map', () => { close(); game.go('map'); }),
                ]
          )
        ),
      { closable: false }
    );
  }

  async function afterBoss(newZone) {
    await storyDialog(zone.outro || ['Well done!'], { portrait: sagePortrait(), reduceMotion: rm });
    if (zone.id === 'core') {
      p.finished = true;
      game.save();
      return game.go('ending');
    }
    if (newZone) toast(`New zone unlocked: ${newZone.icon} ${newZone.name}`, { icon: '🗺️', kind: 'gold', ms: 5000 });
    game.go('map', { openZone: newZone?.id });
  }

  function defeat() {
    ended = true;
    view?.destroy();
    audio.stop();
    audio.sfx('defeat');
    const xpGain = Math.round(battleXp * st.xpMult);
    const levels = grantXp(p, xpGain);
    s.battlesLost++;
    heroImg.classList.add('defeated');
    if (p.hardcore) {
      p.dead = true;
      game.save();
      modal(
        h(
          'div.result.defeat',
          {},
          h('div.result-title', {}, '💀 DECOMMISSIONED'),
          h('p.center', {}, `${p.name} fell to ${monster.name} at level ${p.level}. In Hardcore mode there are no second chances.`),
          h('p.center.muted', {}, 'Your profile stays on the leaderboard as a memorial. Start a new engineer to try again!'),
          h('div.row.center', {}, btn('View final stats', () => game.go('profile'), 'primary'), btn('Title screen', () => game.go('title')))
        ),
        { closable: false }
      );
      return;
    }
    game.emit({ type: 'lose' });
    game.save();
    modal(
      (close) =>
        h(
          'div.result.defeat',
          {},
          h('div.result-title', {}, '📡 CONNECTION LOST'),
          h('p.center', {}, `${monster.name} took you offline. No penalty: you keep the ${fmtNum(xpGain)} XP from your correct answers${levels ? ` and reached Lv ${p.level}` : ''}.`),
          h('p.center.muted', {}, 'Questions you missed are now 🐛 Recurring Bugs. Tip: read the Codex for this zone, buy potions in the Shop, or learn skills.'),
          h(
            'div.row.center.wrap',
            {},
            btn('🔁 Retry', () => { close(); kind === 'boss' ? game.go('map', { openZone: zone.id }) : game.go('battle', params); }, 'primary'),
            btn('📖 Codex', () => { close(); game.go('codex', { zoneId: zone.id }); }),
            btn('🗺️ Map', () => { close(); game.go('map'); })
          )
        ),
      { closable: false }
    );
  }

  nextQuestion();
  return () => view?.destroy();
}
