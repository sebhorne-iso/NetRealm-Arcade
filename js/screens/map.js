// World map: procedurally drawn pixel terrain, zone nodes, zone detail panel, Recurring Bugs.
import { h, btn, modal, storyDialog, spriteImg, bar, toast } from '../ui/dom.js';
import { shell, heroSprite } from './shell.js';
import { audio } from '../engine/audio.js';
import { makeRng } from '../engine/rng.js';
import { spriteURL, shade } from '../engine/sprites.js';
import { nextBugDue } from '../engine/srs.js';
import { CLASSES } from '../content/classes.js';

const W = 192;
const H = 120;

function valueNoise(seed) {
  const rng = makeRng(seed);
  const G = 16;
  const grid = Array.from({ length: (G + 1) * (G + 1) }, () => rng.next());
  const at = (x, y) => grid[(y % (G + 1)) * (G + 1) + (x % (G + 1))];
  const smooth = (t) => t * t * (3 - 2 * t);
  const sample = (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const tx = smooth(x - xi);
    const ty = smooth(y - yi);
    const a = at(xi, yi) * (1 - tx) + at(xi + 1, yi) * tx;
    const b = at(xi, yi + 1) * (1 - tx) + at(xi + 1, yi + 1) * tx;
    return a * (1 - ty) + b * ty;
  };
  return (x, y) => 0.65 * sample(x / 14, y / 14) + 0.35 * sample(x / 5 + 3.1, y / 5 + 7.7);
}

function mix(hexA, hexB, t) {
  const pa = hexA.match(/\w\w/g).map((x) => parseInt(x, 16));
  const pb = hexB.match(/\w\w/g).map((x) => parseInt(x, 16));
  return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

export function drawWorld(canvas, zones, profile) {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const noise = valueNoise('netrealm');
  const nodes = zones.map((z) => ({ z, x: z.map.x * W, y: z.map.y * H, unlocked: !!profile.zones[z.id]?.unlocked }));
  const img = ctx.createImageData(W, H);
  const put = (x, y, hex) => {
    const i = (y * W + x) * 4;
    img.data[i] = parseInt(hex.slice(1, 3), 16);
    img.data[i + 1] = parseInt(hex.slice(3, 5), 16);
    img.data[i + 2] = parseInt(hex.slice(5, 7), 16);
    img.data[i + 3] = 255;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const n = noise(x, y);
      let best = null;
      let bd = Infinity;
      for (const nd of nodes) {
        const d = Math.hypot((x - nd.x) * 0.9, y - nd.y);
        if (d < bd) {
          bd = d;
          best = nd;
        }
      }
      const R = 17 + n * 12;
      let col;
      if (bd < R) {
        const b = best.z.biome;
        col = n < 0.42 ? b[0] : n < 0.6 ? b[1] : b[2];
        if ((x * 7 + y * 13) % 11 === 0 && n > 0.5) col = shade(col, -0.18);
        if (bd > R - 1.6) col = '#e8d8a0'; // beach
        if (!best.unlocked) col = mix(col, '#151527', 0.62);
      } else {
        const depth = Math.min(1, (bd - R) / 18);
        col = mix('#3f7fd0', '#183a7a', depth);
        if ((x + y * 3) % 17 === 0 && n > 0.55) col = '#6fa8ee'; // wave sparkle
      }
      put(x, y, col);
    }
  }
  ctx.putImageData(img, 0, 0);
  // dotted roads between consecutive zones
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
    const lit = a.unlocked && b.unlocked;
    for (let s = 0; s <= steps; s += 2) {
      const t = s / steps;
      const x = Math.round(a.x + (b.x - a.x) * t + Math.sin(t * Math.PI * 2) * 3);
      const y = Math.round(a.y + (b.y - a.y) * t);
      ctx.fillStyle = lit ? '#fff3c4' : '#5a5a72';
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

function zoneState(p, z) {
  const st = p.zones[z.id];
  if (!st?.unlocked) return 'locked';
  if (st.bossDefeated) return 'cleared';
  return 'open';
}

function currentZone(game, p) {
  const zones = game.data.zones;
  const remembered = p.lastZone && p.zones[p.lastZone]?.unlocked ? p.lastZone : null;
  if (remembered) return game.data.zoneById[remembered];
  const open = zones.filter((z) => p.zones[z.id]?.unlocked);
  return open.find((z) => !p.zones[z.id].bossDefeated) || open[open.length - 1];
}

export function mapScreen(root, params, game) {
  const p = game.profile();
  if (p.dead) return game.go('profile');
  audio.play('map');
  const main = shell(root, game, 'map');
  const zones = game.data.zones;

  const canvas = h('canvas.world-canvas', { 'aria-hidden': 'true' });
  drawWorld(canvas, zones, p);
  const nodesLayer = h('div.world-nodes');
  const cur = currentZone(game, p);

  zones.forEach((z, i) => {
    const st = zoneState(p, z);
    const node = h(
      'button.zone-node.zone-' + st + (cur && cur.id === z.id ? '.current' : ''),
      {
        type: 'button',
        style: { left: z.map.x * 100 + '%', top: z.map.y * 100 + '%' },
        onclick: () => openZone(game, z),
        'aria-label': `${z.name}: ${st}`,
      },
      h('span.zone-icon', {}, st === 'locked' ? '🔒' : z.icon),
      h('span.zone-label', {}, h('span.zone-num', {}, i + 1 + '. '), z.name),
      st === 'cleared' ? h('span.zone-check', {}, '★') : null
    );
    nodesLayer.append(node);
  });
  if (cur) {
    nodesLayer.append(h('div.world-hero', { style: { left: cur.map.x * 100 + '%', top: cur.map.y * 100 + '%' } }, spriteImg(heroSprite(p))));
  }

  const daily = game.ensureDaily(p);
  const qDone = daily.quests.filter((q) => q.progress >= q.target).length;
  const bugs = game.bugCount(p);
  const allBugs = game.bugCount(p, false);
  const nextDue = nextBugDue(p.q);

  const toolbar = h(
    'div.map-toolbar',
    {},
    cur ? btn(`⚔️ Fight in ${cur.name}`, () => startBattle(game, cur.id, 'normal'), 'primary') : null,
    btn(
      bugs ? `🐛 Squash ${bugs} Recurring Bug${bugs === 1 ? '' : 's'}` : allBugs ? `🐛 Bugs: next in ${minsUntil(nextDue)}` : '🐛 No bugs!',
      () => {
        if (!bugs) {
          toast(allBugs ? `Your ${allBugs} recurring bug${allBugs === 1 ? '' : 's'} will resurface in ${minsUntil(nextDue)}. Spaced repetition works best with a gap!` : 'No recurring bugs. Questions you miss will show up here for review.', { icon: '🐛' });
          return;
        }
        startBattle(game, null, 'bug');
      },
      bugs ? 'danger' : ''
    ),
    btn(`📜 Daily ${qDone}/${daily.quests.length}`, () => game.go('quests'))
  );

  main.append(
    toolbar,
    h('div.world.window', {}, canvas, nodesLayer),
    h('p.muted.center.small', {}, 'Tap a zone to explore. Clear its boss to open the road to the next one.')
  );

  if (!p.seenIntro) {
    p.seenIntro = true;
    game.save();
    setTimeout(() => introStory(game).then(() => openZone(game, zones[0])), 300);
  } else if (params.openZone) {
    setTimeout(() => openZone(game, game.data.zoneById[params.openZone]), 100);
  }
}

function minsUntil(ts) {
  if (!ts) return '—';
  const m = Math.max(1, Math.round((ts - Date.now()) / 60000));
  return m >= 60 ? `${Math.round(m / 60)}h` : `${m} min`;
}

export function sagePortrait() {
  return spriteImg(spriteURL('sage', { b: '#5a4fb0', g: '#8b5a2b' }), 'portrait');
}

function introStory(game) {
  const p = game.profile();
  return storyDialog(
    [
      `Ah! A new junior engineer. Welcome to the NetRealm, ${p.name}. I'm Old Man Ping. I've been replying to echo requests since 1983.`,
      'Something terrible has happened. THE GREAT OUTAGE has corrupted every layer of the realm. Broadcast storms rage, zombie processes roam, and somebody committed secrets to a public repo.',
      `As a ${CLASSES[p.cls].name}, you'll fight these incidents with KNOWLEDGE. Every battle is a question. Answer right and you strike. Answer wrong and... well, it's always DNS.`,
      'Answer FAST for a ⚡ speed crit. String correct answers together for a combo. Anything you miss comes back later as a 🐛 Recurring Bug, so nothing slips through the cracks.',
      "Your journey starts in **Packet Plains**. Win battles there to draw out its boss. Off you go, and remember: have you tried turning it off and on again?",
    ],
    { portrait: sagePortrait(), reduceMotion: game.settings().reduceMotion }
  );
}

export function openZone(game, z) {
  const p = game.profile();
  const st = p.zones[z.id];
  if (!st?.unlocked) {
    const prev = game.data.zones[z.index - 1];
    audio.sfx('wrong');
    toast(`Locked. Defeat ${prev?.boss?.name || 'the previous boss'} in ${prev?.name} first.`, { icon: '🔒', kind: 'bad' });
    return;
  }
  p.lastZone = z.id;
  game.save();
  const go = () => {
    const mastery = game.zoneMastery(p, z.id);
    const pool = game.pool(z.id);
    const need = z.battlesToBoss;
    const bossReady = st.wins >= need;
    const seenMonsters = [...z.monsters, z.boss].filter((m) => p.bestiary[m.id]);
    modal(
      (close) =>
        h(
          'div.zone-panel',
          {},
          h('div.zone-head', {}, h('span.zone-big-icon', {}, z.icon), h('div', {}, h('div.zone-topic', {}, z.topic), h('div.muted', {}, `Recommended level ${z.recLevel} · ${pool.length} questions`))),
          h('p', {}, z.desc),
          h('div.zone-progress', {},
            h('div', {}, `Battles won: ${st.wins}`, st.bossDefeated ? ' · Boss defeated ★' : bossReady ? ' · BOSS AWAKE!' : ` · ${need - st.wins} more to wake the boss`),
            bar(Math.min(st.wins, need), need, 'xp'),
            h('div', {}, `Mastery: ${Math.round(mastery * 100)}%`),
            bar(mastery, 1, 'bw')
          ),
          seenMonsters.length ? h('div.zone-monsters', {}, seenMonsters.map((m) => spriteImg(spriteURL(m.sprite, m.palette), 'mini-sprite'))) : null,
          h(
            'div.zone-actions',
            {},
            btn('⚔️ Explore (battle)', () => { close(); startBattle(game, z.id, 'normal'); }, 'primary big'),
            bossReady || st.bossDefeated
              ? btn(st.bossDefeated ? `👑 Rematch ${z.boss.name}` : `👹 Challenge ${z.boss.name}`, () => { close(); startBattle(game, z.id, 'boss'); }, st.bossDefeated ? '' : 'danger big')
              : h('button.btn', { type: 'button', disabled: true }, `👹 Boss sleeps (${st.wins}/${need})`),
            btn('📖 Study the Codex', () => { close(); game.go('codex', { zoneId: z.id }); })
          )
        ),
      { title: `${z.icon} ${z.name}`, wide: true }
    );
  };
  if (!p.seenZoneIntro[z.id] && z.intro?.length) {
    p.seenZoneIntro[z.id] = true;
    game.save();
    storyDialog(z.intro, { portrait: sagePortrait(), reduceMotion: game.settings().reduceMotion }).then(go);
  } else go();
}

export function startBattle(game, zoneId, kind) {
  const p = game.profile();
  if (kind === 'boss') {
    const z = game.data.zoneById[zoneId];
    audio.sfx('boss');
    storyDialog(z.bossIntro || [`${z.boss.name} blocks your path!`], {
      speaker: z.boss.name,
      portrait: spriteImg(spriteURL(z.boss.sprite, z.boss.palette), 'portrait boss-portrait'),
      reduceMotion: game.settings().reduceMotion,
    }).then(() => game.go('battle', { zoneId, kind }));
    return;
  }
  if (p.dead) return;
  game.go('battle', { zoneId, kind });
}
