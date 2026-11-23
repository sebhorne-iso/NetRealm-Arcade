// Codex (cheat-sheet study notes per zone) and Bestiary.
import { h, rich, spriteImg } from '../ui/dom.js';
import { shell } from './shell.js';
import { audio } from '../engine/audio.js';
import { spriteURL } from '../engine/sprites.js';

export function renderBlocks(blocks) {
  return (blocks || []).map((b) => {
    if (typeof b === 'string') return h('p', {}, rich(b));
    if (b.p) return h('p', {}, rich(b.p));
    if (b.h) return h('h3', {}, b.h);
    if (b.list) return h('ul', {}, b.list.map((li) => h('li', {}, rich(li))));
    if (b.steps) return h('ol', {}, b.steps.map((li) => h('li', {}, rich(li))));
    if (b.code) return h('pre.code-block', {}, b.code);
    if (b.tip) return h('div.tip', {}, h('strong', {}, '💡 '), rich(b.tip));
    if (b.table)
      return h(
        'div.table-wrap',
        {},
        h('table', {}, h('thead', {}, h('tr', {}, b.table.head.map((c) => h('th', {}, rich(c))))), h('tbody', {}, b.table.rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, rich(String(c))))))))
      );
    return null;
  });
}

export function codexScreen(root, params, game) {
  const p = game.profile();
  audio.play('map');
  const tab = params.tab || 'codex';
  const main = shell(root, game, 'codex', '📖 The Codex');
  const zones = game.data.zones;
  const entries = game.data.codex.entries;
  const unlocked = (z) => !!p.zones[z.id]?.unlocked;
  let zoneId = params.zoneId && unlocked(game.data.zoneById[params.zoneId]) ? params.zoneId : zones.find(unlocked).id;

  main.append(
    h(
      'div.subtabs',
      {},
      h('button.subtab' + (tab === 'codex' ? '.active' : ''), { type: 'button', onclick: () => game.go('codex', { tab: 'codex', zoneId }) }, '📖 Study notes'),
      h('button.subtab' + (tab === 'bestiary' ? '.active' : ''), { type: 'button', onclick: () => game.go('codex', { tab: 'bestiary' }) }, '👾 Bestiary')
    )
  );

  if (tab === 'bestiary') {
    for (const z of zones) {
      const list = [...z.monsters, z.boss];
      main.append(
        h('h2.section', {}, `${z.icon} ${z.name}`),
        h(
          'div.card-grid.bestiary',
          {},
          list.map((m) => {
            const seen = p.bestiary[m.id];
            return h(
              'div.card.beast' + (seen ? '' : '.unseen') + (m === z.boss ? '.boss-card' : ''),
              {},
              spriteImg(spriteURL(m.sprite, seen ? m.palette : { b: '#2a2a40', a: '#22223a', e: '#2a2a40', p: '#2a2a40', w: '#2a2a40', r: '#2a2a40', k: '#2a2a40', y: '#2a2a40' }), 'beast-sprite'),
              h('div.item-name', {}, seen ? m.name : '???'),
              h('p.small', {}, seen ? m.desc : 'Defeat this foe to learn about it.'),
              seen ? h('div.muted.small', {}, `Defeated ×${seen}`) : null
            );
          })
        )
      );
    }
    return;
  }

  const side = h(
    'div.codex-zones',
    {},
    zones.map((z) =>
      h(
        'button.codex-zone' + (z.id === zoneId ? '.active' : '') + (unlocked(z) ? '' : '.locked'),
        { type: 'button', disabled: !unlocked(z), onclick: () => game.go('codex', { zoneId: z.id }) },
        `${unlocked(z) ? z.icon : '🔒'} ${z.name}`
      )
    )
  );
  const zoneEntries = entries.filter((e) => e.zone === zoneId);
  const body = h('div.codex-body');
  const z = game.data.zoneById[zoneId];
  body.append(h('h2.section', {}, `${z.icon} ${z.name}: ${z.topic}`));
  if (!zoneEntries.length) body.append(h('p.muted', {}, 'The final zone mixes everything. Review the other chapters!'));
  for (const e of zoneEntries) {
    const read = !!p.codexRead[e.id];
    const content = h('div.codex-content');
    const det = h(
      'details.codex-entry' + (read ? '.read' : ''),
      {
        ontoggle: () => {
          if (det.open && !content.childElementCount) content.append(...renderBlocks(e.body));
          if (det.open && !p.codexRead[e.id]) {
            p.codexRead[e.id] = Date.now();
            det.classList.add('read');
            game.emit({ type: 'codex', id: e.id });
            game.save();
          }
        },
      },
      h('summary', {}, h('span', {}, e.title), h('span.codex-read', {}, read ? '✔ read' : 'NEW')),
      content
    );
    body.append(det);
  }
  main.append(h('div.codex', {}, side, body));
}
