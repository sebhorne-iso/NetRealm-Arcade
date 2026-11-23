// Persistence: multiple profiles + global settings in localStorage, and portable save codes.
const KEY = 'packetquest.v1';
const SAVE_PREFIX = 'PQ1.';

export const DEFAULT_SETTINGS = {
  music: 0.45,
  sfx: 0.7,
  muted: false,
  readableFont: false,
  largeText: false,
  reduceMotion: false,
  showTimer: true,
};

export function newProfile({ name, cls, color = 0, hardcore = false }) {
  const now = Date.now();
  return {
    v: 1,
    id: 'p' + now.toString(36) + Math.random().toString(36).slice(2, 7),
    name: String(name || 'Junior Engineer').slice(0, 18),
    cls,
    color,
    hardcore: !!hardcore,
    dead: false,
    created: now,
    lastPlayed: now,
    level: 1,
    xp: 0,
    totalXp: 0,
    sp: 0,
    gold: 40,
    skills: {},
    inventory: { 'ping-potion': 2, 'packet-capture': 1 },
    gear: { weapon: null, armor: null, accessory: null },
    owned: {},
    zones: { fundamentals: { unlocked: true, wins: 0, bossDefeated: false } },
    q: {},
    stats: {
      answered: 0,
      correct: 0,
      battlesWon: 0,
      battlesLost: 0,
      bossesDefeated: 0,
      crits: 0,
      bestCombo: 0,
      bugsSquashed: 0,
      terminalCorrect: 0,
      subnetCorrect: 0,
      itemsBought: 0,
      duelWins: 0,
      duelsPlayed: 0,
      flawless: 0,
      flawlessBoss: 0,
      clutch: 0,
      playMs: 0,
      goldEarned: 0,
      byZone: {},
      byType: {},
      byTopic: {},
    },
    codexRead: {},
    bestiary: {},
    achievements: {},
    title: null,
    daily: null,
    streak: { count: 0, lastDay: null, best: 0 },
    seenIntro: false,
    seenZoneIntro: {},
    finished: false,
  };
}

// Fill in any fields missing from older saves.
export function migrateProfile(p) {
  const fresh = newProfile({ name: p.name, cls: p.cls || 'knight' });
  const out = { ...fresh, ...p };
  out.stats = { ...fresh.stats, ...(p.stats || {}) };
  out.streak = { ...fresh.streak, ...(p.streak || {}) };
  out.gear = { ...fresh.gear, ...(p.gear || {}) };
  for (const k of ['skills', 'inventory', 'owned', 'zones', 'q', 'codexRead', 'bestiary', 'achievements', 'seenZoneIntro']) {
    out[k] = p[k] && typeof p[k] === 'object' ? p[k] : fresh[k];
  }
  if (!out.zones.fundamentals) out.zones.fundamentals = { unlocked: true, wins: 0, bossDefeated: false };
  return out;
}

function emptyStore() {
  return { profiles: {}, activeId: null, settings: { ...DEFAULT_SETTINGS } };
}

let store = emptyStore();
let storageOk = true;

export function loadStore() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      store = { ...emptyStore(), ...parsed, settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) } };
      for (const id of Object.keys(store.profiles)) store.profiles[id] = migrateProfile(store.profiles[id]);
    }
  } catch (e) {
    console.warn('Could not load save data', e);
    storageOk = false;
  }
  return store;
}

export function saveStore() {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
    return true;
  } catch (e) {
    console.warn('Could not save', e);
    storageOk = false;
    return false;
  }
}

export const getStore = () => store;
export const isStorageOk = () => storageOk;
export const settings = () => store.settings;

export function activeProfile() {
  return store.activeId ? store.profiles[store.activeId] || null : null;
}

export function setActive(id) {
  store.activeId = id;
  if (store.profiles[id]) store.profiles[id].lastPlayed = Date.now();
  saveStore();
}

export function addProfile(p) {
  store.profiles[p.id] = p;
  store.activeId = p.id;
  saveStore();
  return p;
}

export function deleteProfile(id) {
  delete store.profiles[id];
  if (store.activeId === id) store.activeId = null;
  saveStore();
}

export function listProfiles() {
  return Object.values(store.profiles).sort((a, b) => b.lastPlayed - a.lastPlayed);
}

// ---------- save codes ----------
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function fromBase64(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function exportProfile(p) {
  return SAVE_PREFIX + toBase64(JSON.stringify(p));
}

export function parseSaveCode(code) {
  const clean = String(code || '').trim().replace(/\s+/g, '');
  if (!clean.startsWith(SAVE_PREFIX)) throw new Error('That does not look like a Packet Quest save code (it should start with PQ1.)');
  let obj;
  try {
    obj = JSON.parse(fromBase64(clean.slice(SAVE_PREFIX.length)));
  } catch {
    throw new Error('The save code is damaged. Make sure you copied all of it.');
  }
  if (!obj || typeof obj !== 'object' || !obj.id || !obj.cls || typeof obj.level !== 'number') throw new Error('The save code is missing profile data.');
  return migrateProfile(obj);
}
