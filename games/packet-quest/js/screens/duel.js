// Hot-seat Quiz Duel: two players on one device take turns answering.
import { h, btn, modal, toast, bar, setBar, spriteImg } from '../ui/dom.js';
import { renderQuestion, renderFeedback, expectedText } from '../ui/question-view.js';
import { audio } from '../engine/audio.js';
import { makeRng } from '../engine/rng.js';
import * as store from '../engine/state.js';
import { instantiate, checkAnswer, selectQuestion, srsId, SPEED_WINDOW } from '../engine/questions.js';
import { recordAnswer } from '../engine/srs.js';
import { spriteURL, heroPalette } from '../engine/sprites.js';
import { AVATAR_COLORS } from '../content/classes.js';
import { checkAchievements } from '../content/achievements.js';
import { heroSprite } from './shell.js';

const MAX_HP = 100;
const HIT = 20;
const FAST_HIT = 30;
const SELF_DMG = 10;
const MAX_TURNS = 24;

export function duelScreen(root, params, game) {
  if (params.setup) return duelBattle(root, params.setup, game);
  audio.play('title');
  const profiles = store.listProfiles().filter((p) => !p.dead);
  const zones = game.data.zones.filter((z) => z.id !== 'core');
  const chosen = new Set(['fundamentals', 'subnetting']);

  const playerPicker = (n) => {
    const select = h('select.title-select', { 'aria-label': `Player ${n}` }, h('option', { value: '' }, `Guest player ${n}`), profiles.map((p) => h('option', { value: p.id }, `${p.name} (Lv ${p.level})`)));
    const name = h('input.text-input', { type: 'text', maxlength: 14, placeholder: `Player ${n} name`, value: `Player ${n}` });
    select.onchange = () => {
      name.style.display = select.value ? 'none' : '';
    };
    if (profiles[n - 1]) {
      select.value = profiles[n - 1].id;
      name.style.display = 'none';
    }
    return { el: h('div.duel-picker', {}, h('div.duel-p', {}, `P${n}`), select, name), get: () => ({ profileId: select.value || null, name: select.value ? store.getStore().profiles[select.value].name : name.value.trim() || `Player ${n}` }) };
  };
  const p1 = playerPicker(1);
  const p2 = playerPicker(2);

  const zoneBoxes = h(
    'div.zone-checks',
    {},
    zones.map((z) =>
      h('label.zone-check', {}, h('input', { type: 'checkbox', checked: chosen.has(z.id), onchange: (e) => (e.target.checked ? chosen.add(z.id) : chosen.delete(z.id)) }), ` ${z.icon} ${z.name}`)
    )
  );

  root.append(
    h(
      'main.content.standalone',
      {},
      h('h1.screen-title', {}, '🤺 Quiz Duel'),
      h('p.center', {}, 'Two engineers, one device. Take turns answering. Correct = 20 damage to your rival (30 if you answer fast ⚡). Wrong = you take 10. First to 0 HP loses!'),
      h('div.window.duel-setup', {}, h('div.duel-pickers', {}, p1.el, h('div.vs', {}, 'VS'), p2.el), h('h2.section', {}, 'Topics'), zoneBoxes),
      h(
        'div.row.center.wrap',
        {},
        btn('◀ Back', () => game.go('title')),
        btn(
          '⚔️ Start duel',
          () => {
            const a = p1.get();
            const b = p2.get();
            if (a.profileId && a.profileId === b.profileId) return toast('Pick two different engineers.', { kind: 'bad' });
            if (!chosen.size) return toast('Pick at least one topic.', { kind: 'bad' });
            game.go('duel', { setup: { players: [a, b], zones: [...chosen] } });
          },
          'primary big'
        )
      )
    )
  );
}

function duelBattle(root, setup, game) {
  audio.play('battle');
  const rng = makeRng(Date.now());
  const all = store.getStore().profiles;
  const pool = setup.zones.flatMap((z) => game.pool(z));
  const players = setup.players.map((pl, i) => {
    const prof = pl.profileId ? all[pl.profileId] : null;
    // Guests get a distinct look (crimson knight / emerald ranger) so they never mirror a profile.
    const guestCls = i === 0 ? 'knight' : 'ranger';
    const sprite = prof ? heroSprite(prof) : spriteURL(guestCls, heroPalette(guestCls, AVATAR_COLORS[i === 0 ? 1 : 2].c));
    return { ...pl, prof, sprite, hp: MAX_HP, correct: 0, answered: 0 };
  });
  let turn = 0;
  const asked = new Set();
  let view = null;

  const sideEls = players.map((pl, i) => {
    const hp = bar(MAX_HP, MAX_HP, 'hp');
    const text = h('span.hp-text', {}, `${MAX_HP}/${MAX_HP}`);
    const img = spriteImg(pl.sprite, 'duel-sprite' + (i === 1 ? ' flip' : ''));
    const el = h('div.duel-side', {}, img, h('div.info-name', {}, pl.name), h('div.bar-row', {}, hp, text), h('div.duel-score.muted.small', {}));
    return { el, hp, text, img };
  });
  const turnEl = h('div.duel-turn');
  const qPanel = h('section.window.question-panel');
  root.append(h('div.battle.duel', {}, h('div.duel-arena', {}, sideEls[0].el, h('div.vs', {}, 'VS'), sideEls[1].el), turnEl, qPanel));

  const refresh = () => {
    players.forEach((pl, i) => {
      setBar(sideEls[i].hp, pl.hp, MAX_HP);
      sideEls[i].text.textContent = `${Math.max(0, pl.hp)}/${MAX_HP}`;
      sideEls[i].el.classList.toggle('active', i === turn % 2);
      sideEls[i].el.querySelector('.duel-score').textContent = `${pl.correct}/${pl.answered} correct`;
    });
  };

  const ready = () => {
    const cur = players[turn % 2];
    refresh();
    turnEl.textContent = `Turn ${turn + 1}/${MAX_TURNS}`;
    qPanel.replaceChildren(
      h('div.duel-ready', {}, h('p', {}, `🎮 ${cur.name}'s turn! Pass the device.`), btn("I'm ready ▶", () => ask(), 'primary big'))
    );
    qPanel.querySelector('button').focus();
  };

  const ask = () => {
    const cur = players[turn % 2];
    const opp = players[(turn + 1) % 2];
    const raw = selectQuestion(pool, cur.prof?.q || {}, { rng, exclude: asked });
    asked.add(srsId(raw));
    const q = instantiate(raw, rng, {});
    game.currentQuestion = q; // exposed for automated playtests
    const win = SPEED_WINDOW[q.type] || 12;
    const t0 = performance.now();
    view?.destroy();
    view = renderQuestion(qPanel, q, {
      speedWindow: win,
      showTimer: game.settings().showTimer,
      reduceMotion: game.settings().reduceMotion,
      onAnswer: (resp) => {
        const { correct } = checkAnswer(q, resp);
        const fast = (performance.now() - t0) / 1000 <= win && !view.usedHelp;
        view.showResult(correct);
        cur.answered++;
        if (cur.prof) {
          recordAnswer(cur.prof.q, q.srcId, correct);
          cur.prof.stats.answered++;
          if (correct) cur.prof.stats.correct++;
        }
        if (correct) {
          cur.correct++;
          const dmg = fast ? FAST_HIT : HIT;
          opp.hp -= dmg;
          audio.sfx(fast ? 'crit' : 'hit');
        } else {
          cur.hp -= SELF_DMG;
          audio.sfx('hurt');
        }
        refresh(); // keep the current player highlighted while they read the explanation
        turn++;
        const over = players.some((pl) => pl.hp <= 0) || turn >= MAX_TURNS;
        renderFeedback(view, {
          correct,
          expected: expectedText(q),
          explain: q.explain,
          extra: [h('div.fb-extra', {}, correct ? `${cur.name} hits ${opp.name} for ${fast ? FAST_HIT + ' ⚡' : HIT}!` : `${cur.name} takes ${SELF_DMG} damage.`)],
          continueLabel: over ? 'Results ▶' : 'Next player ▶',
          onContinue: () => (over ? finish() : ready()),
        });
      },
    });
    view.focus();
  };

  const finish = () => {
    view?.destroy();
    audio.stop();
    audio.sfx('victory');
    const [a, b] = players;
    let winner = null;
    if (a.hp !== b.hp) winner = a.hp > b.hp ? a : b;
    else if (a.correct !== b.correct) winner = a.correct > b.correct ? a : b;
    for (const pl of players) {
      if (!pl.prof) continue;
      pl.prof.stats.duelsPlayed++;
      if (pl === winner) pl.prof.stats.duelWins++;
      checkAchievements(pl.prof);
    }
    store.saveStore();
    modal(
      h(
        'div.result.victory',
        {},
        h('div.result-title', {}, winner ? `🏆 ${winner.name} WINS!` : '🤝 DRAW!'),
        h('div.duel-summary', {}, players.map((pl) => h('div', {}, `${pl.name}: ${Math.max(0, pl.hp)} HP left · ${pl.correct}/${pl.answered} correct`))),
        h('div.row.center.wrap', {}, btn('🔁 Rematch', () => game.go('duel', { setup }), 'primary'), btn('⚙️ New duel', () => game.go('duel')), btn('🏠 Title', () => game.go('title')))
      ),
      { closable: false }
    );
  };

  ready();
  return () => view?.destroy();
}
