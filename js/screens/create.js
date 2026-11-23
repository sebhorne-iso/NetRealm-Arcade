// Character creation: name, class, avatar color, hardcore toggle.
import { h, btn, spriteImg, toast } from '../ui/dom.js';
import * as store from '../engine/state.js';
import { CLASSES, AVATAR_COLORS } from '../content/classes.js';
import { spriteURL, heroPalette } from '../engine/sprites.js';

export function createScreen(root, _params, game) {
  let cls = 'knight';
  let color = 0;
  let hardcore = false;
  const nameInput = h('input.text-input', { type: 'text', maxlength: 18, placeholder: 'Your name', value: '', autocomplete: 'off', 'aria-label': 'Character name' });

  const classRow = h('div.class-row');
  const colorRow = h('div.color-row');
  const preview = h('div.class-preview');

  const draw = () => {
    classRow.replaceChildren(
      ...Object.values(CLASSES).map((c) =>
        h(
          'button.class-card' + (c.id === cls ? '.selected' : ''),
          { type: 'button', onclick: () => { cls = c.id; draw(); } },
          spriteImg(spriteURL(c.sprite, heroPalette(c.id, AVATAR_COLORS[color].c)), 'class-sprite'),
          h('div.class-name', {}, c.name)
        )
      )
    );
    colorRow.replaceChildren(
      ...AVATAR_COLORS.map((c, i) =>
        h('button.color-swatch' + (i === color ? '.selected' : ''), { type: 'button', title: c.name, 'aria-label': c.name, style: { background: c.c[0] }, onclick: () => { color = i; draw(); } })
      )
    );
    const c = CLASSES[cls];
    preview.replaceChildren(h('p', {}, c.blurb), h('ul', {}, c.perks.map((x) => h('li', {}, x))));
  };
  draw();

  const hc = h('input', { type: 'checkbox', onchange: (e) => (hardcore = e.target.checked) });

  root.append(
    h(
      'div.create-screen',
      {},
      h(
        'div.window.create-window',
        {},
        h('div.window-title', {}, 'Create your engineer'),
        h('label.field', {}, h('span', {}, 'Name'), nameInput),
        h('div.field', {}, h('span', {}, 'Class'), classRow),
        preview,
        h('div.field', {}, h('span', {}, 'Color'), colorRow),
        h(
          'label.setting.toggle.hardcore-toggle',
          {},
          hc,
          h('span', {}, '💀 Hardcore mode', h('small.muted.block', {}, '1.5× XP and gold, monsters hit 25% harder, no running from battle, and ONE defeat ends the run for good. For bragging rights only.'))
        ),
        h(
          'div.row.end',
          {},
          btn('◀ Back', () => game.go('title')),
          btn(
            'Begin Quest ▶',
            () => {
              const name = nameInput.value.trim();
              if (!name) {
                toast('Give your engineer a name first!', { icon: '✏️', kind: 'bad' });
                nameInput.focus();
                return;
              }
              const p = store.newProfile({ name, cls, color, hardcore });
              store.addProfile(p);
              game.sessionStart = Date.now();
              game.go('map');
            },
            'primary big'
          )
        )
      )
    )
  );
  setTimeout(() => nameInput.focus(), 50);
}
