// Profile: shareable score card (image + text), save export, profile management.
import { h, btn, toast, confirmDialog, spriteImg, fmtNum } from '../ui/dom.js';
import { shell, heroSprite } from './shell.js';
import { audio } from '../engine/audio.js';
import * as store from '../engine/state.js';
import { CLASSES } from '../content/classes.js';
import { currentStreak } from '../content/quests.js';
import { ACHIEVEMENTS } from '../content/achievements.js';

const SITE = () => location.href.split('#')[0].split('?')[0].replace(/index\.html$/, '');

export function scoreText(p, game) {
  const s = p.stats;
  const acc = s.answered ? Math.round((s.correct / s.answered) * 100) : 0;
  const cleared = game.data.zones.filter((z) => p.zones[z.id]?.bossDefeated).length;
  const lines = [
    `⚔️ PACKET QUEST: ${p.name}, the ${CLASSES[p.cls].name}${p.hardcore ? ' 💀HC' : ''}${p.dead ? ' (decommissioned)' : ''}`,
    `${p.title ? `🏷️ «${p.title}» | ` : ''}Lv ${p.level} | 🔥 ${currentStreak(p)}-day streak (best ${p.streak.best})`,
    `🗺️ Zones cleared: ${cleared}/9 | 🎯 Accuracy: ${acc}% (${s.correct}/${s.answered}) | 🏆 ${Object.keys(p.achievements).length}/${ACHIEVEMENTS.length}`,
  ];
  for (const z of game.data.zones) {
    if (z.id === 'core') continue;
    const m = game.zoneMastery(p, z.id);
    const filled = Math.round(m * 10);
    lines.push(`${z.icon} ${z.name.padEnd(17, ' ')} ${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${Math.round(m * 100)}%`);
  }
  lines.push(`Play: ${SITE()}`);
  return lines.join('\n');
}

async function drawCard(p, game) {
  try {
    await document.fonts.load('16px "Press Start 2P"');
    await document.fonts.load('20px VT323');
  } catch {}
  const W = 640;
  const H = 432;
  const scale = 2;
  const c = document.createElement('canvas');
  c.width = W * scale;
  c.height = H * scale;
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = false;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#2b3595');
  g.addColorStop(1, '#10164a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#e6e6f0';
  ctx.lineWidth = 4;
  ctx.strokeRect(8, 8, W - 16, H - 16);
  ctx.strokeStyle = '#10102a';
  ctx.strokeRect(14, 14, W - 28, H - 28);
  // avatar
  const img = new Image();
  img.src = heroSprite(p);
  await img.decode().catch(() => {});
  ctx.fillStyle = '#0b0b1e';
  ctx.fillRect(28, 28, 120, 120);
  ctx.drawImage(img, 30, 30, 116, 116);
  const s = p.stats;
  const acc = s.answered ? Math.round((s.correct / s.answered) * 100) : 0;
  const cleared = game.data.zones.filter((z) => p.zones[z.id]?.bossDefeated).length;
  ctx.fillStyle = '#ffd447';
  ctx.font = '10px "Press Start 2P", monospace';
  ctx.fillText('PACKET QUEST · SCORE CARD', 168, 42);
  ctx.fillStyle = '#ffffff';
  ctx.font = '20px "Press Start 2P", monospace';
  ctx.fillText(p.name.slice(0, 14), 168, 76);
  ctx.font = '24px VT323, monospace';
  ctx.fillStyle = '#c9d0ff';
  ctx.fillText(`Lv ${p.level} ${CLASSES[p.cls].name}${p.hardcore ? '  💀 HARDCORE' : ''}`, 168, 104);
  if (p.title) {
    ctx.fillStyle = '#ffd447';
    ctx.fillText(`«${p.title}»`, 168, 128);
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`🎯 ${acc}%   🗺️ ${cleared}/9   🔥 ${currentStreak(p)}d   🏆 ${Object.keys(p.achievements).length}`, 168, 152);
  // zone mastery bars
  let y = 182;
  ctx.font = '20px VT323, monospace';
  for (const z of game.data.zones) {
    if (z.id === 'core') continue;
    const m = game.zoneMastery(p, z.id);
    ctx.fillStyle = '#e6e6f0';
    ctx.fillText(`${z.name}`, 32, y + 13);
    ctx.fillStyle = '#0b0b1e';
    ctx.fillRect(220, y, 360, 14);
    ctx.fillStyle = p.zones[z.id]?.bossDefeated ? '#ffd447' : '#4db8ff';
    ctx.fillRect(222, y + 2, Math.round(356 * m), 10);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`${Math.round(m * 100)}%`, 588, y + 13);
    y += 24;
  }
  ctx.fillStyle = '#9aa3d6';
  ctx.font = '18px VT323, monospace';
  ctx.fillText(`Mastery by zone (gold bar = boss defeated) · ${fmtNum(s.answered)} questions answered`, 32, H - 26);
  return c;
}

export function profileScreen(root, _params, game) {
  const p = game.profile();
  if (!p) return game.go('title');
  audio.play('map');
  let main;
  if (p.dead) {
    main = h('main.content.standalone');
    root.append(main);
    main.append(h('h1.screen-title', {}, '💀 In Memoriam'), h('p.center', {}, `${p.name} was decommissioned in Hardcore mode at Lv ${p.level}. Their legend lives on.`));
  } else main = shell(root, game, 'profile', '👤 Profile & Sharing');

  const cardHolder = h('div.card-holder', {}, h('p.muted', {}, 'Drawing score card…'));
  const text = scoreText(p, game);
  drawCard(p, game).then((c) => {
    c.className = 'score-card';
    cardHolder.replaceChildren(c);
  });

  const copy = async (str, what) => {
    try {
      await navigator.clipboard.writeText(str);
      audio.sfx('coin');
      toast(`${what} copied to clipboard!`, { icon: '📋', kind: 'good' });
    } catch {
      toast('Could not access the clipboard. Select the text and copy it manually.', { icon: '⚠️', kind: 'bad' });
    }
  };

  const saveCode = store.exportProfile(p);
  main.append(
    h('h2.section', {}, '📸 Score card'),
    cardHolder,
    h(
      'div.row.center.wrap',
      {},
      btn('📋 Copy text version', () => copy(text, 'Score card')),
      btn('🖼️ Download image', async () => {
        const c = cardHolder.querySelector('canvas') || (await drawCard(p, game));
        const a = h('a', { href: c.toDataURL('image/png'), download: `packet-quest-${p.name.replace(/\W+/g, '-')}.png` });
        a.click();
      }),
      navigator.share
        ? btn('📤 Share', async () => {
            try {
              const c = cardHolder.querySelector('canvas');
              const blob = c ? await new Promise((r) => c.toBlob(r)) : null;
              const file = blob ? new File([blob], 'packet-quest.png', { type: 'image/png' }) : null;
              if (file && navigator.canShare?.({ files: [file] })) await navigator.share({ text, files: [file] });
              else await navigator.share({ text });
            } catch {}
          })
        : null
    ),
    h('pre.score-text', {}, text),
    h('h2.section', {}, '💾 Save code'),
    h('p.small', {}, 'Copy this code to move your progress to another device or keep a backup. Import it from the title screen.'),
    h('textarea.save-code', { readonly: true, rows: 3, onclick: (e) => e.target.select() }, saveCode),
    h('div.row.center.wrap', {}, btn('📋 Copy save code', () => copy(saveCode, 'Save code'), 'primary'), btn('⬇️ Download save file', () => {
      const a = h('a', { href: URL.createObjectURL(new Blob([saveCode], { type: 'text/plain' })), download: `packet-quest-save-${p.name.replace(/\W+/g, '-')}.txt` });
      a.click();
    })),
    h('h2.section', {}, '👥 Profiles'),
    h(
      'div.row.center.wrap',
      {},
      btn('🔀 Switch engineer (title screen)', () => { game.save(); game.go('title'); }),
      btn('🏆 Leaderboard', () => game.go('leaderboard')),
      btn('🗑️ Delete this profile', async () => {
        if (await confirmDialog(`Delete ${p.name} forever? Copy your save code first if you want a backup.`, { yes: 'Delete', danger: true })) {
          store.deleteProfile(p.id);
          game.go('title');
        }
      }, 'danger')
    )
  );
  if (p.dead) main.append(h('div.row.center', {}, btn('◀ Title screen', () => game.go('title'), 'primary')));
}

export function leaderboardScreen(root, _params, game) {
  audio.play('title');
  const profiles = store.listProfiles().sort((a, b) => (b.totalXp || 0) - (a.totalXp || 0));
  const rows = profiles.map((p, i) => {
    const s = p.stats;
    const acc = s.answered ? Math.round((s.correct / s.answered) * 100) : 0;
    const cleared = game.data.zones.filter((z) => p.zones[z.id]?.bossDefeated).length;
    return { p, i, acc, cleared };
  });
  const text = ['🏆 PACKET QUEST LEADERBOARD', ...rows.map(({ p, i, acc, cleared }) => `${i + 1}. ${p.name}${p.hardcore ? ' 💀' : ''} · Lv ${p.level} ${CLASSES[p.cls].name} · ${cleared}/9 zones · ${acc}% acc · best streak ${p.streak.best}d`)].join('\n');
  root.append(
    h(
      'main.content.standalone',
      {},
      h('h1.screen-title', {}, '🏆 Leaderboard'),
      h('p.center.muted', {}, 'Every engineer on this device, ranked by total XP. Share it with your study group!'),
      rows.length
        ? h(
            'div.table-wrap',
            {},
            h(
              'table.leaderboard',
              {},
              h('thead', {}, h('tr', {}, ['#', '', 'Engineer', 'Lv', 'Zones', 'Accuracy', 'Answered', 'Best 🔥', 'Duels'].map((c) => h('th', {}, c)))),
              h(
                'tbody',
                {},
                rows.map(({ p, i, acc, cleared }) =>
                  h(
                    'tr' + (p.dead ? '.dead' : ''),
                    {},
                    h('td.rank', {}, ['🥇', '🥈', '🥉'][i] || i + 1),
                    h('td', {}, spriteImg(heroSprite(p), 'mini-sprite')),
                    h('td', {}, h('strong', {}, p.name), p.hardcore ? ' 💀' : '', h('small.block.muted', {}, `${CLASSES[p.cls].name}${p.title ? ` «${p.title}»` : ''}`)),
                    h('td', {}, p.level),
                    h('td', {}, `${cleared}/9`),
                    h('td', {}, `${acc}%`),
                    h('td', {}, fmtNum(p.stats.answered)),
                    h('td', {}, `${p.streak.best}d`),
                    h('td', {}, `${p.stats.duelWins}/${p.stats.duelsPlayed}`)
                  )
                )
              )
            )
          )
        : h('p.center', {}, 'No engineers yet!'),
      h(
        'div.row.center.wrap',
        {},
        btn('◀ Back', () => game.go('title')),
        rows.length
          ? btn('📋 Copy leaderboard', async () => {
              try {
                await navigator.clipboard.writeText(text);
                toast('Leaderboard copied!', { icon: '📋', kind: 'good' });
              } catch {
                toast('Clipboard unavailable', { kind: 'bad' });
              }
            })
          : null
      )
    )
  );
}

export function endingScreen(root, _params, game) {
  const p = game.profile();
  audio.play('title');
  const s = p.stats;
  const acc = s.answered ? Math.round((s.correct / s.answered) * 100) : 0;
  root.append(
    h(
      'div.ending',
      {},
      h('div.title-stars'),
      h('h1.logo', {}, h('span.logo-top', {}, 'UPTIME'), h('span.logo-bottom', {}, 'RESTORED')),
      spriteImg(heroSprite(p), 'ending-hero'),
      h(
        'div.window.ending-text',
        {},
        h('p', {}, `THE GREAT OUTAGE is no more. Packets flow, pipelines are green and every pod is Running. The NetRealm is at 99.999% uptime thanks to ${p.name}, ${p.title ? `«${p.title}»` : `the ${CLASSES[p.cls].name}`}.`),
        h('p', {}, `Final stats: Lv ${p.level} · ${fmtNum(s.answered)} questions · ${acc}% accuracy · ${s.bossesDefeated} bosses defeated · best combo ${s.bestCombo}.`),
        h('p', {}, 'But a good engineer never stops learning. Keep your streak alive, squash your Recurring Bugs, raise your mastery in every zone, and challenge your study group to a Quiz Duel. When you are ready, go book that exam. You\'ve got this.'),
        h('p.muted.center', {}, '— Old Man Ping (TTL: 255)')
      ),
      h('div.row.center.wrap', {}, btn('🗺️ Keep playing', () => game.go('map'), 'primary big'), btn('👤 Share my score card', () => game.go('profile')), btn('🏠 Title', () => game.go('title')))
    )
  );
}
