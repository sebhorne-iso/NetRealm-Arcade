import { h, modal, btn } from '../ui/dom.js';
import { audio } from '../engine/audio.js';

export function openSettings(game) {
  const s = game.settings();
  const save = () => {
    game.applySettings();
    game.save();
  };
  const slider = (label, key) =>
    h(
      'label.setting',
      {},
      h('span', {}, label),
      h('input', {
        type: 'range',
        min: 0,
        max: 1,
        step: 0.05,
        value: String(s[key]),
        oninput: (e) => {
          s[key] = Number(e.target.value);
          save();
        },
        onchange: () => audio.sfx('coin'),
      })
    );
  const toggle = (label, key, desc) =>
    h(
      'label.setting.toggle',
      {},
      h('input', {
        type: 'checkbox',
        checked: !!s[key],
        onchange: (e) => {
          s[key] = e.target.checked;
          save();
        },
      }),
      h('span', {}, label, desc ? h('small.muted.block', {}, desc) : null)
    );
  modal(
    (close) =>
      h(
        'div.settings',
        {},
        slider('🎵 Music volume', 'music'),
        slider('🔔 Effects volume', 'sfx'),
        toggle('🔇 Mute everything', 'muted', 'Shortcut: press M anywhere'),
        toggle('🔤 Readable font', 'readableFont', 'Swap the pixel font for a clean sans-serif in questions and text'),
        toggle('🔍 Larger text', 'largeText'),
        toggle('🧘 Reduce motion', 'reduceMotion', 'Turn off screen shake, flashing and typewriter effects'),
        toggle('⏱️ Show speed-bonus timer', 'showTimer', 'Hide the bar if it stresses you out. Fast answers still crit.'),
        h('div.row.end', {}, btn('Done', close, 'primary'))
      ),
    { title: '⚙️ Settings' }
  );
}
