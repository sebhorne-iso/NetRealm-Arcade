// Pixel-art sprites drawn from character grids. Half-width templates are mirrored so creatures are
// symmetric. Outlines and top-left lighting / bottom-right shading are added automatically.
//
// Legend: . transparent | b body | a accent | e eye white | p pupil | k black | w white
//         r red | y gold | g grey (or per-sprite override) | s skin | h hair

const T = {};

// ---------- monsters (half templates, 8 columns mirrored to 16) ----------
T.slime = { half: true, rows: [
  '........', '........', '........', '........', '.......b', '.....bbb', '....bbbb', '...bbbbb',
  '...bbeeb', '..bbbepb', '..bbbbbb', '..bbbbbr', '..bbbbbb', '...bbbbb', '........', '........'] };

T.ghost = { half: true, rows: [
  '........', '.....bbb', '....bbbb', '...bbbbb', '..bbbbbb', '..bbkkbb', '..bbkkbb', '..bbbbbb',
  '..bbbbbk', '..bbbbbb', '.bbbbbbb', 'bb.bbbbb', '...bbbbb', '..b.bb.b', '........', '........'] };

T.bat = { half: true, rows: [
  '........', '........', '........', '.....b..', 'b....bb.', 'bb...bbb', 'bbb..bbb', 'bbbbbebb',
  'bbbbbbpb', '.bbbbbbb', '..b.bbbb', '.....bbw', '......b.', '........', '........', '........'] };

T.golem = { half: true, rows: [
  '........', '........', '....bbbb', '....bbbb', '....baab', '....bbbb', '.bbbbbbb', 'bbbbbbbb',
  'bbb.bbbb', 'bbb.bbaa', 'bb..bbbb', '....bbbb', '....bb..', '...bbb..', '...bbb..', '........'] };

T.skull = { half: true, rows: [
  '........', '........', '....bbbb', '...bbbbb', '..bbbbbb', '..bbbbbb', '..bkkkbb', '..bkakbb',
  '..bbbbbk', '...bbbbb', '....bbbb', '....wkwk', '....bbbb', '........', '........', '........'] };

T.eye = { half: true, rows: [
  '........', '........', '.....bbb', '...bbbbb', '..bbbbbb', '..bbeeee', '.bbeeeaa', '.bbeeaap',
  '.bbeeaap', '.bbeeeaa', '..bbeeee', '..bbbbbb', '...bbbbb', '....b.bb', '...b..b.', '........'] };

T.imp = { half: true, rows: [
  '........', '...a....', '...aa...', '....bbbb', '...bbbbb', '...bepbb', '...bbbbb', '...bbwkw',
  '....bbbb', '..bbbbbb', '.b..bbbb', '....bbbb', '....bb..', '...bb...', '........', '........'] };

T.crab = { half: true, rows: [
  '........', '........', '........', '.a......', 'aa....e.', 'aa....b.', '.a..bbbb', '.abbbbbb',
  '..bbbbbb', '..bbbbbb', '..bbbbkk', '.b.bbbbb', 'b.b.b...', '........', '........', '........'] };

T.tree = { half: true, rows: [
  '....aaaa', '..aaaaaa', '.aaaaaaa', 'aaaaaaaa', 'aaaaaaaa', '.aaaaaaa', '...aabbb', '....bbbb',
  '....bebb', '....bbbb', '....bbkk', '..bbbbbb', '.b..bbbb', '...bbbbb', '..bb..bb', '........'] };

T.hydra = { half: true, rows: [
  '........', '.bb..bbb', 'beb..beb', 'bbb..bbb', '.b....bb', '.b....b.', '..b..bb.', '..bbbbbb',
  '...bbbbb', '..bbbbaa', '.bbbbbaa', '.bbbbbbb', 'bbb..bbb', 'bb....bb', '........', '........'] };

T.dragon = { half: true, rows: [
  '........', 'a....b..', 'aa...bb.', 'aaa..bbb', 'aaaa.bbb', 'aaaabepb', 'aaaabbbb', '.aaabbbw',
  '..aabbbb', '...bbbbb', '...bbbaa', '..bbbbaa', '..bb.bbb', '.bbb..bb', '........', '........'] };

T.robot = { half: true, rows: [
  '........', '.......a', '.......k', '....bbbb', '...bbbbb', '...bbabb', '...bbbbb', '...bkkkk',
  '....bbbb', '.bbbbbbb', 'b.bbaaab', 'b.bbbbbb', 'g.bbbbbb', '...bb.bb', '...bb...', '..bbb...'] };

T.bug = { half: true, rows: [
  '........', '...k....', '....k...', '....bbbb', '....bebb', '....bbbb', '.k.aaaak', '..aaaaak',
  '.kaaaaak', 'k.aaaaak', '..aaaaak', '.kaaaaak', '...aaaak', '..k.....', '........', '........'] };

T.mimic = { half: true, rows: [
  '........', '........', '........', '..bbbbbb', '.bbbepbb', '.bbbbbby', '.kwkwkwk', '.krkrrrr',
  '.kkkkkkk', '.wkwkwkw', '.bbbbbbb', '.bbbbbbb', '.bbyybbb', '.bbbbbbb', '........', '........'] };

T.cloud = { half: true, rows: [
  '........', '........', '....bb..', '...bbbbb', '.bbbbbbb', 'bbbbbbbb', 'bbbebbbb', 'bbbpbbbb',
  'bbbbbkkk', '.bbbbbbb', '..y...y.', '...y...y', '..y...y.', '...y....', '........', '........'] };

T.orb = { half: true, rows: [
  '........', '........', '.....aaa', '...aaabb', '..aabbbb', '..abbkkk', '.aabkkkk', '.abbkkek',
  '.abbkkkk', '.aabkkkk', '..abbkkk', '..aabbbb', '...aaabb', '.....aaa', '........', '........'] };

// ---------- full-width templates ----------
T.fish = { rows: [
  '................', '................', '................', '.......bb.......', '.....bbbbbb.....', '...bbbbbbbbb..a.',
  '..bbebbbbbbbbaa.', '.bbbpbbbbbbbbaaa', '.rbbbbbbbbbbbaa.', '..bbbbbbbbbbb.a.', '...bbbbbbbbb....', '.....bbbbbb.....',
  '.......bb.......', '................', '................', '................'] };

T.bomb = { rows: [
  '................', '...........y.y..', '............y...', '...........a.y..', '..........a.....', '......bbba......',
  '....bbbbbbbb....', '...bbbbbbbbbb...', '..bbbebbbbebbb..', '..bbbpbbbbpbbb..', '..bbbbbbbbbbbb..', '..bbbbkkkkbbbb..',
  '...bbbbbbbbbb...', '....bbbbbbbb....', '......bbbb......', '................'] };

T.serpent = { rows: [
  '................', '..........bbb...', '.........bbebb..', '.........bbbbbr.', '..........bbb..r', '.........bbb....',
  '........bbb.....', '...bbbbbbb......', '..bbaaaabbb.....', '.bbabbbbabbb....', '.bbabbbbbabb....', '.bbbaaaaabbb....',
  '..bbbbbbbbb.....', '...bbbbbbb......', '................', '................'] };

// ---------- heroes & NPCs ----------
T.knight = { rows: [
  '................', '.......aa.......', '......gaag......', '.....gggggg.....', '....gggggggg....', '....gspsspsg....',
  '..w.gssssssg....', '..w..gssssg.....', '..w.bbbbbbb.yy..', '.gggbbbabbbyaay.', '..s.bbbbbbbyaay.', '....bbbbbbbyaay.',
  '....bb...bb.yy..', '....bb...bb.....', '...kkk...kkk....', '................'] };

T.sorcerer = { rows: [
  '........a.......', '.......aa.......', '......aya.......', '.....aaaaa...y..', '....aaaaaaa.yay.', '...aaaaaaaaa.y..',
  '.....spssps..g..', '.....ssssss..g..', '.....hhhhhh..g..', '....bbhhhhbb.s..', '...bbbbhhbbbbg..', '...bbbbbbbbb.g..',
  '...bbbbybbbb.g..', '..bbbbbbbbbbbg..', '..kkk.....kkk...', '................'] };

T.ranger = { rows: [
  '................', '......bbbb....y.', '.....bbbbbb...yw', '....bbbbbbbb.y.w', '....bbsssssb.y.w', '....bspsspsb.y.w',
  '....bbssssbb.y.w', '.....gaaaag..s.w', '....aaaaaaaa.y.w', '...saaaaaaaas.yw', '....aaayyaaa..y.', '....aaaaaaaa....',
  '....aa....aa....', '....kk....kk....', '...kkk....kkk...', '................'] };

T.sage = { rows: [
  '................', '.y....ssss......', 'yay..ssssss.....', '.y..gspsspsg....', '.g..gssssssg....', '.g..wwwwwwww....',
  '.g.wwwwwwwwww...', '.g.bwwwwwwwwb...', '.s.bbwwwwwwbbb..', '.g.bbbwwwwbbbb..', '.g.bbbbwwbbbbb..', '.g.bbbbbbbbbbb..',
  '.g.bbbbbbbbbbb..', '.g..bbbbbbbbb...', '...kkk....kkk...', '................'] };

export const SPRITE_NAMES = Object.keys(T);

// ---------- color helpers ----------
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
export function shade(hex, amt) {
  const [r, g, b] = hexToRgb(hex);
  if (amt >= 0) return rgbToHex([r + (255 - r) * amt, g + (255 - g) * amt, b + (255 - b) * amt]);
  return rgbToHex([r * (1 + amt), g * (1 + amt), b * (1 + amt)]);
}

const FIXED = {
  e: '#ffffff', p: '#1a1a2e', k: '#1a1a2e', w: '#f4f4f4', r: '#e0394a', y: '#ffd447', g: '#9aa3b5', s: '#f2c49b', h: '#7a4a2a',
};

function expand(tpl) {
  if (!tpl.half) return tpl.rows;
  return tpl.rows.map((r) => r + r.split('').reverse().join(''));
}

// palette: { b: body, a: accent, ...overrides }
export function drawSprite(name, palette = {}, { outline = '#0d0d1a', flash = false } = {}) {
  const tpl = T[name] || T.slime;
  const rows = expand(tpl);
  const W = 18;
  const H = 18;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const body = palette.b || '#5ac85a';
  const accent = palette.a || shade(body, -0.35);
  const colors = { ...FIXED, ...palette, b: body, a: accent };
  const at = (x, y) => (y >= 0 && y < 16 && x >= 0 && x < 16 ? rows[y][x] : '.');
  const opaque = (x, y) => at(x, y) !== '.';
  // outline pass
  for (let y = -1; y <= 16; y++) {
    for (let x = -1; x <= 16; x++) {
      if (opaque(x, y)) continue;
      if (opaque(x - 1, y) || opaque(x + 1, y) || opaque(x, y - 1) || opaque(x, y + 1)) {
        ctx.fillStyle = outline;
        ctx.fillRect(x + 1, y + 1, 1, 1);
      }
    }
  }
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const c = at(x, y);
      if (c === '.') continue;
      let col = colors[c] || '#ff00ff';
      if (c === 'b' || c === 'a') {
        const lit = !opaque(x, y - 1) || !opaque(x - 1, y);
        const dark = !opaque(x, y + 1) || !opaque(x + 1, y);
        if (lit && !dark) col = shade(col, 0.28);
        else if (dark && !lit) col = shade(col, -0.3);
      }
      if (flash) col = '#ffffff';
      ctx.fillStyle = col;
      ctx.fillRect(x + 1, y + 1, 1, 1);
    }
  }
  return canvas;
}

const urlCache = new Map();
export function spriteURL(name, palette = {}) {
  const key = name + JSON.stringify(palette);
  if (!urlCache.has(key)) urlCache.set(key, drawSprite(name, palette).toDataURL());
  return urlCache.get(key);
}

// Hero palette from avatar color triplet [main, light, dark]
export function heroPalette(cls, colorTriplet) {
  const [main, , dark] = colorTriplet;
  if (cls === 'sorcerer') return { b: main, a: dark };
  if (cls === 'ranger') return { b: main, a: '#3f6b3a' };
  if (cls === 'sage') return { b: '#5a4fb0', g: '#8b5a2b' };
  return { b: main, a: dark };
}
