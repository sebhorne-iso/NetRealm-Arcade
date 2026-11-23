// Shared helpers: IPv4 maths, VLAN lists, text formatting, RNG and game-time.

// ---------- RNG (mulberry32) ----------
export function hashStr(s) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}
export function rng(seed) {
  let a = (typeof seed === 'string' ? hashStr(seed) : seed) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    int: (lo, hi) => Math.floor(lo + next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    shuffle: (arr) => {
      const a2 = arr.slice();
      for (let i = a2.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a2[i], a2[j]] = [a2[j], a2[i]];
      }
      return a2;
    },
    weighted: (items, w) => {
      const ws = items.map(w);
      let tot = ws.reduce((s, x) => s + Math.max(0, x), 0);
      if (tot <= 0) return items[0];
      let x = next() * tot;
      for (let i = 0; i < items.length; i++) if ((x -= Math.max(0, ws[i])) <= 0) return items[i];
      return items[items.length - 1];
    },
  };
  return r;
}

// ---------- IPv4 ----------
export const ip2n = (ip) => ip.split('.').reduce((a, o) => ((a << 8) >>> 0) + Number(o), 0) >>> 0;
export const n2ip = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
export const lenMask = (len) => (len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0);
export const maskStr = (len) => n2ip(lenMask(len));
export const wildStr = (len) => n2ip(~lenMask(len) >>> 0);
export function maskLen(mask) {
  const n = ip2n(mask);
  let len = 0;
  for (let i = 31; i >= 0; i--) {
    if ((n >>> i) & 1) len++;
    else break;
  }
  return n2ip(lenMask(len)) === mask ? len : -1;
}
export function isIp(s) {
  return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split('.').every((o) => Number(o) <= 255);
}
export function isMask(s) {
  return isIp(s) && maskLen(s) >= 0;
}
// "10.1.2.3/24" -> { ip, len, net, bc }
export function cidr(s) {
  if (!s) return null;
  const [ip, l] = String(s).split('/');
  const len = l === undefined ? 32 : Number(l);
  if (!isIp(ip) || !(len >= 0 && len <= 32)) return null;
  const n = ip2n(ip);
  const m = lenMask(len);
  return { ip, len, n, net: (n & m) >>> 0, bc: (n | (~m >>> 0)) >>> 0, mask: m };
}
export const netStr = (s) => {
  const c = cidr(s);
  return c ? `${n2ip(c.net)}/${c.len}` : null;
};
export function inNet(ip, pfx) {
  const c = cidr(pfx);
  return !!c && ((ip2n(ip) & c.mask) >>> 0) === c.net;
}
export const sameNet = (a, b) => {
  const x = cidr(a);
  const y = cidr(b);
  return !!x && !!y && x.len === y.len && x.net === y.net;
};
export function isPrivate(ip) {
  return inNet(ip, '10.0.0.0/8') || inNet(ip, '172.16.0.0/12') || inNet(ip, '192.168.0.0/16') || inNet(ip, '169.254.0.0/16');
}

// ---------- VLAN lists ----------
export function parseVlans(s) {
  if (s === 'all' || s === undefined || s === null) return 'all';
  const out = new Set();
  for (const part of String(s).split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > 4094 || b < a) return null;
    if (b - a > 4094) return null;
    for (let v = a; v <= b; v++) out.add(v);
  }
  return [...out].sort((x, y) => x - y);
}
export function fmtVlans(list, sep = ',') {
  if (list === 'all') return '1-4094';
  if (!list || !list.length) return 'none';
  const s = [...list].sort((a, b) => a - b);
  const out = [];
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j > i ? `${s[i]}-${s[j]}` : `${s[i]}`);
    i = j + 1;
  }
  return out.join(sep);
}
export const vlanIn = (list, v) => list === 'all' || (Array.isArray(list) && list.includes(v));

// ---------- text ----------
export const padR = (s, n) => {
  s = String(s ?? '');
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
};
export const padL = (s, n) => {
  s = String(s ?? '');
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
};
// Fixed-width columns: cols = [[text, width], ...]; last column unpadded.
export const row = (...cols) => cols.map(([t, w], i) => (i === cols.length - 1 || w == null ? String(t ?? '') : padR(t, w))).join('');
export function macFor(seed) {
  const r = rng(`mac:${seed}`);
  const b = [0x00, r.int(0, 255), r.int(0, 255), r.int(0, 255), r.int(0, 255), r.int(0, 255)];
  b[0] = [0x00, 0x2c, 0x50, 0x84, 0xa4, 0xf0][r.int(0, 5)];
  return b.map((x) => x.toString(16).padStart(2, '0'));
}
export const macCisco = (m) => `${m[0]}${m[1]}.${m[2]}${m[3]}.${m[4]}${m[5]}`;
export const macColon = (m) => m.join(':');
export const macDash = (m) => `${m[0]}${m[1]}${m[2]}-${m[3]}${m[4]}${m[5]}`;

// ---------- game time ----------
export const EPOCH = Date.UTC(1995, 0, 1);
export const dateOf = (t) => new Date(EPOCH + Math.round(t) * 60000);
export const yearOf = (t) => dateOf(t).getUTCFullYear();
export const tOfDate = (y, m = 1, d = 1, hh = 0, mm = 0) => Math.round((Date.UTC(y, m - 1, d, hh, mm) - EPOCH) / 60000);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const two = (n) => String(n).padStart(2, '0');
export function fmtDate(t, style = 'iso') {
  const d = dateOf(t);
  const Y = d.getUTCFullYear();
  const M = d.getUTCMonth();
  const D = d.getUTCDate();
  const h = two(d.getUTCHours());
  const m = two(d.getUTCMinutes());
  const s = two(Math.floor((t * 60) % 60));
  switch (style) {
    case 'iso':
      return `${Y}-${two(M + 1)}-${two(D)}`;
    case 'datetime':
      return `${Y}-${two(M + 1)}-${two(D)} ${h}:${m}`;
    case 'syslog':
      return `${MON[M]} ${String(D).padStart(2, ' ')} ${h}:${m}:${s}`;
    case 'cisco':
      return `${MON[M]} ${String(D).padStart(2, ' ')} ${h}:${m}:${s}.${String(Math.floor((t * 60000) % 1000)).padStart(3, '0')}`;
    case 'long':
      return `${DAY[d.getUTCDay()]} ${MON[M]} ${D} ${Y}`;
    case 'clock':
      return `${h}:${m}:${s}.${String(Math.floor((t * 60000) % 1000)).padStart(3, '0')} UTC ${DAY[d.getUTCDay()]} ${MON[M]} ${D} ${Y}`;
    case 'human':
      return `${D} ${MON[M]} ${Y}`;
    default:
      return d.toISOString();
  }
}
export const MONTHS = MON;
// Cisco-style uptime: "2d03h", "1w2d", "00:14:22"
export function upCisco(mins) {
  const s = Math.max(0, Math.floor(mins * 60));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  if (d >= 7) return `${Math.floor(d / 7)}w${d % 7}d`;
  if (d >= 1) return `${d}d${two(h)}h`;
  return `${two(h)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}
// Long uptime: "2 weeks, 3 days, 4 hours, 5 minutes"
export function upLong(mins) {
  const total = Math.max(0, Math.floor(mins));
  const w = Math.floor(total / 10080);
  const d = Math.floor((total % 10080) / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  const parts = [];
  if (w) parts.push(`${w} week${w > 1 ? 's' : ''}`);
  if (d) parts.push(`${d} day${d > 1 ? 's' : ''}`);
  if (h) parts.push(`${h} hour${h > 1 ? 's' : ''}`);
  parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  return parts.join(', ');
}
export function upJunos(mins) {
  const s = Math.max(0, Math.floor(mins * 60));
  const d = Math.floor(s / 86400);
  return `${d ? `${d}d ` : ''}${two(Math.floor((s % 86400) / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}
export const fmtMoney = (n) => (n < 0 ? '-' : '') + '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const deep = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
export const uid = (p = 'id') => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
export const speedStr = (mbps) => (mbps >= 1000 ? `${mbps / 1000}G` : `${mbps}M`);

// Line-based diff (LCS) -> [{op:' '|'-'|'+', line}]
export function diffLines(a, b) {
  const A = a.split('\n');
  const B = b.split('\n');
  const n = A.length;
  const m = B.length;
  if (n * m > 4_000_000) return [...A.map((line) => ({ op: '-', line })), ...B.map((line) => ({ op: '+', line }))];
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ op: ' ', line: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: '-', line: A[i++] });
    else out.push({ op: '+', line: B[j++] });
  }
  while (i < n) out.push({ op: '-', line: A[i++] });
  while (j < m) out.push({ op: '+', line: B[j++] });
  return out;
}
