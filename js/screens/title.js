// Title screen: profile slots, new game, duel, leaderboard, import, settings.
import { h, btn, modal, toast, confirmDialog, spriteImg } from '../ui/dom.js';
import * as store from '../engine/state.js';
import { audio } from '../engine/audio.js';
import { CLASSES } from '../content/classes.js';
import { heroSprite } from './shell.js';
import { openSettings } from './settings.js';
import { spriteURL } from '../engine/sprites.js';

export function titleScreen(root, _params, game) {
  audio.play('title');
  const profiles = store.listProfiles();
  const monsters = ['slime', 'bat', 'ghost', 'dragon', 'robot', 'hydra'];
  const parade = h(
    'div.title-parade',
    {},
    monsters.map((m, i) => spriteImg(spriteURL(m, { b: ['#5ac85a', '#8a4fd6', '#b0b8ff', '#d63a4a', '#8899aa', '#3fa85a'][i], a: '#ffd447' }), 'parade-sprite'))
  );

  const slotList = h('div.slots');
  if (!profiles.length) slotList.append(h('p.muted.center', {}, 'No engineers yet. Start a new game!'));
  for (const p of profiles) {
    slotList.append(
      h(
        'div.slot' + (p.dead ? '.dead' : ''),
        {},
        spriteImg(heroSprite(p), 'slot-sprite'),
        h(
          'div.slot-info',
          {},
          h('div.slot-name', {}, p.name, p.hardcore ? ' 💀' : ''),
          h('div.slot-meta', {}, `Lv ${p.level} ${CLASSES[p.cls]?.name || ''}`),
          h('div.slot-meta.muted', {}, p.dead ? 'DECOMMISSIONED' : `${Object.values(p.zones).filter((z) => z.bossDefeated).length}/9 zones cleared`)
        ),
        h(
          'div.slot-actions',
          {},
          p.dead
            ? btn('View', () => { store.setActive(p.id); game.go('profile'); })
            : btn('Play ▶', () => { store.setActive(p.id); game.sessionStart = Date.now(); game.go('map'); }, 'primary'),
          h(
            'button.icon-btn',
            {
              type: 'button',
              title: 'Delete profile',
              onclick: async () => {
                if (await confirmDialog(`Delete ${p.name} forever? Export a save code first if you want a backup.`, { yes: 'Delete', danger: true })) {
                  store.deleteProfile(p.id);
                  game.go('title');
                }
              },
            },
            '🗑️'
          )
        )
      )
    );
  }

  root.append(
    h(
      'div.title-screen',
      {},
      h('div.title-stars'),
      h('h1.logo', {}, h('span.logo-top', {}, 'PACKET'), h('span.logo-bottom', {}, 'QUEST')),
      h('p.subtitle', {}, 'THE GREAT OUTAGE'),
      parade,
      h('p.tagline', {}, 'A retro RPG for CCNA, Network+ and DevOps study'),
      h(
        'div.window.title-menu',
        {},
        h('div.window-title', {}, 'Engineers on this device'),
        slotList,
        h(
          'div.title-buttons',
          {},
          btn('✚ New Game', () => game.go('create'), 'primary big'),
          btn('🤺 Quiz Duel', () => game.go('duel')),
          btn('🏆 Leaderboard', () => game.go('leaderboard')),
          btn('📥 Import Save', () => importDialog(game)),
          btn('⚙️ Settings', () => openSettings(game)),
          btn('❔ How to Play', () => howToPlay())
        )
      ),
      !store.isStorageOk() ? h('p.warn', {}, 'Warning: your browser is blocking local storage, so progress will not be saved. Use Profile → Export Save to back up.') : null,
      h('p.footer-note', {}, 'Click or press any key to enable sound · M to mute')
    )
  );
}

function importDialog(game) {
  const ta = h('textarea.save-code', { placeholder: 'Paste a PQ1.… save code here', rows: 5 });
  modal(
    (close) =>
      h(
        'div',
        {},
        h('p', {}, 'Paste a save code exported from Profile → Export Save on another device.'),
        ta,
        h(
          'div.row.end',
          {},
          btn('Cancel', close),
          btn(
            'Import',
            async () => {
              try {
                const p = store.parseSaveCode(ta.value);
                const existing = store.getStore().profiles[p.id];
                if (existing && !(await confirmDialog(`This will overwrite the existing save for ${existing.name} (Lv ${existing.level}). Continue?`, { yes: 'Overwrite', danger: true }))) return;
                store.addProfile(p);
                close();
                toast(`Imported ${p.name} (Lv ${p.level})`, { icon: '📥', kind: 'good' });
                game.go('title');
              } catch (e) {
                toast(e.message, { icon: '⚠️', kind: 'bad', ms: 5000 });
              }
            },
            'primary'
          )
        )
      ),
    { title: '📥 Import Save' }
  );
}

export function howToPlay() {
  modal(
    h(
      'div.howto',
      {},
      h('h3', {}, '⚔️ Battles'),
      h('p', {}, 'Every turn is a question. Answer correctly to hit the monster; answer wrong and it hits you. Answer before the ⚡ bar empties for a SPEED CRIT (1.5× damage). Consecutive correct answers build a COMBO for extra damage.'),
      h('h3', {}, '🧠 Question types'),
      h('ul', {}, h('li', {}, 'Multiple choice: press 1-4 or A-D.'), h('li', {}, 'Typed answers: subnet IDs, port numbers, masks and so on.'), h('li', {}, 'Terminal: type real commands. Cisco IOS abbreviations like "sh ip int br" work. Type ? for a hint.'), h('li', {}, 'Ordering: tap the items in the right sequence.')),
      h('h3', {}, '🗺️ Progress'),
      h('p', {}, 'Win battles in a zone to unlock its boss. Beat the boss to open the next zone. Nine zones lead to THE GREAT OUTAGE.'),
      h('h3', {}, '🐛 Recurring Bugs'),
      h('p', {}, 'Questions you miss come back later as Recurring Bugs (spaced repetition). Squash them from the map to lock in what you learned.'),
      h('h3', {}, '📈 Growth'),
      h('p', {}, 'Level up for skill points, buy gear and potions in the Shop, complete daily quests to keep your 🔥 streak, and read the Codex cheat sheets.'),
      h('h3', {}, '💀 Hardcore'),
      h('p', {}, 'Optional at character creation: 1.5× XP and gold, stronger monsters, no running, and one loss ends the run.')
    ),
    { title: '❔ How to Play', wide: true }
  );
}
