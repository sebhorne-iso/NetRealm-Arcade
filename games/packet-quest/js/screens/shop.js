// Shop (consumables + gear) and equipment management.
import { h, btn, toast, fmtNum } from '../ui/dom.js';
import { shell } from './shell.js';
import { audio } from '../engine/audio.js';
import { CONSUMABLES, GEAR, ITEM_MAP, describeEffects } from '../content/items.js';
import { playerStats } from '../engine/progression.js';

export function shopScreen(root, params, game) {
  const p = game.profile();
  if (p.dead) return game.go('profile');
  audio.play('map');
  const tab = params.tab || 'buy';
  const main = shell(root, game, 'shop', '🛒 The Patch Panel Bazaar');
  const highest = Math.max(...game.data.zones.filter((z) => p.zones[z.id]?.unlocked).map((z) => z.index));
  const st = playerStats(p);

  main.append(
    h('p.shopkeeper', {}, '"Welcome, engineer! Everything here is rack-mounted and fully warrantied. Mostly." Gear unlocks as you open new zones.'),
    h(
      'div.subtabs',
      {},
      h('button.subtab' + (tab === 'buy' ? '.active' : ''), { type: 'button', onclick: () => game.go('shop', { tab: 'buy' }) }, '🛍️ Buy'),
      h('button.subtab' + (tab === 'gear' ? '.active' : ''), { type: 'button', onclick: () => game.go('shop', { tab: 'gear' }) }, '🧰 Equipment & Bag')
    ),
    h('div.stat-strip', {}, [`❤️ ${st.maxHp} HP`, `⚔️ ${st.atk} ATK`, `📶 ${st.maxBw} BW`, `🎯 ${Math.round(st.crit * 100)}% crit`, `💰 ${fmtNum(p.gold)} gold`].map((t) => h('span', {}, t)))
  );

  const buy = (item, isGear) => {
    if (p.gold < item.price) {
      audio.sfx('wrong');
      toast('Not enough gold. Win more battles or finish daily quests!', { icon: '💸', kind: 'bad' });
      return;
    }
    p.gold -= item.price;
    p.stats.itemsBought++;
    if (isGear) {
      p.owned[item.id] = true;
      if (!p.gear[item.slot]) p.gear[item.slot] = item.id;
    } else p.inventory[item.id] = (p.inventory[item.id] || 0) + 1;
    audio.sfx('coin');
    toast(`Bought ${item.icon} ${item.name}`, { kind: 'good' });
    game.checkAchievements();
    game.save();
    game.go('shop', { tab });
  };

  if (tab === 'buy') {
    const consumables = CONSUMABLES.filter((c) => c.unlockZone <= highest);
    const gear = GEAR.filter((g) => !g.loot && g.unlockZone <= highest);
    const lockedGear = GEAR.filter((g) => !g.loot && g.unlockZone > highest).length;
    main.append(
      h('h2.section', {}, 'Consumables'),
      h(
        'div.card-grid',
        {},
        consumables.map((c) =>
          h(
            'div.card.item-card',
            {},
            h('div.item-icon', {}, c.icon),
            h('div.item-name', {}, c.name),
            h('p.small', {}, c.desc),
            h('div.item-foot', {}, h('span.muted.small', {}, `Owned: ${p.inventory[c.id] || 0}`), btn(`💰 ${c.price}`, () => buy(c, false), p.gold >= c.price ? 'primary' : ''))
          )
        )
      ),
      h('h2.section', {}, 'Gear'),
      h(
        'div.card-grid',
        {},
        gear.map((g) =>
          h(
            'div.card.item-card' + (p.owned[g.id] ? '.owned' : ''),
            {},
            h('div.item-icon', {}, g.icon),
            h('div.item-name', {}, g.name),
            h('div.item-slot', {}, g.slot.toUpperCase()),
            h('div.item-effects', {}, describeEffects(g.effects)),
            h('p.small.muted', {}, g.desc),
            h('div.item-foot', {}, p.owned[g.id] ? h('span.badge', {}, 'OWNED') : btn(`💰 ${g.price}`, () => buy(g, true), p.gold >= g.price ? 'primary' : ''))
          )
        )
      ),
      lockedGear ? h('p.muted.center', {}, `🔒 ${lockedGear} more gear item${lockedGear > 1 ? 's' : ''} unlock in later zones. Bosses drop unique loot too!`) : null
    );
  } else {
    const slots = ['weapon', 'armor', 'accessory'];
    main.append(
      h('h2.section', {}, 'Equipped'),
      h(
        'div.card-grid',
        {},
        slots.map((slot) => {
          const it = ITEM_MAP[p.gear[slot]];
          return h(
            'div.card.item-card.equipped',
            {},
            h('div.item-slot', {}, slot.toUpperCase()),
            it ? [h('div.item-icon', {}, it.icon), h('div.item-name', {}, it.name), h('div.item-effects', {}, describeEffects(it.effects))] : h('p.muted', {}, 'Empty slot'),
            it ? h('div.item-foot', {}, btn('Unequip', () => { p.gear[slot] = null; game.save(); game.go('shop', { tab }); })) : null
          );
        })
      ),
      h('h2.section', {}, 'Owned gear'),
      Object.keys(p.owned).length
        ? h(
            'div.card-grid',
            {},
            Object.keys(p.owned)
              .map((id) => ITEM_MAP[id])
              .filter(Boolean)
              .map((g) =>
                h(
                  'div.card.item-card' + (g.loot ? '.loot-card' : ''),
                  {},
                  h('div.item-icon', {}, g.icon),
                  h('div.item-name', {}, g.name, g.loot ? h('span.badge.badge-gold', {}, 'LOOT') : null),
                  h('div.item-slot', {}, g.slot.toUpperCase()),
                  h('div.item-effects', {}, describeEffects(g.effects)),
                  h(
                    'div.item-foot',
                    {},
                    p.gear[g.slot] === g.id
                      ? h('span.badge', {}, 'EQUIPPED')
                      : btn('Equip', () => {
                          p.gear[g.slot] = g.id;
                          audio.sfx('confirm');
                          game.checkAchievements();
                          game.save();
                          game.go('shop', { tab });
                        }, 'primary')
                  )
                )
              )
          )
        : h('p.muted', {}, 'No gear yet. Buy some in the shop or defeat bosses for loot.'),
      h('h2.section', {}, 'Bag'),
      h(
        'div.bag',
        {},
        CONSUMABLES.filter((c) => p.inventory[c.id] > 0).map((c) => h('div.bag-item', { title: c.desc }, `${c.icon} ${c.name} ×${p.inventory[c.id]}`)),
        !CONSUMABLES.some((c) => p.inventory[c.id] > 0) ? h('p.muted', {}, 'Your bag is empty.') : null
      )
    );
  }
}
