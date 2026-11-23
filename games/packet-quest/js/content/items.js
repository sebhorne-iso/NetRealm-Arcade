// Consumables (used in battle) and gear (equipped). unlockZone = index of the zone that must be
// UNLOCKED before the shop stocks the item.
export const CONSUMABLES = [
  { id: 'ping-potion', name: 'Ping Potion', icon: '🧪', price: 20, unlockZone: 0, desc: 'Echo reply! Heals 35% of max HP.' },
  { id: 'packet-capture', name: 'Packet Capture', icon: '📡', price: 12, unlockZone: 0, desc: 'Sniff the wire: reveals a hint for the current question.' },
  { id: 'traceroute-scroll', name: 'Traceroute Scroll', icon: '📜', price: 25, unlockZone: 0, desc: 'Removes 2 wrong options. On typed questions, reveals the start of the answer; on order puzzles, places the first two items.' },
  { id: 'bandwidth-boost', name: 'Bandwidth Boost', icon: '📶', price: 30, unlockZone: 1, desc: 'Restores 50% of max BW.' },
  { id: 'firewall-rule', name: 'Firewall Rule', icon: '🧱', price: 35, unlockZone: 1, desc: 'deny any any: blocks the next hit completely.' },
  { id: 'energy-drink', name: 'Caffeine Overflow', icon: '🥤', price: 28, unlockZone: 2, desc: 'Your next correct answer is a guaranteed critical hit.' },
  { id: 'jumbo-frame', name: 'Jumbo Frame Potion', icon: '🍶', price: 55, unlockZone: 3, desc: 'MTU 9000 of healing: restores 75% of max HP.' },
  { id: 'snapshot', name: 'Snapshot Backup', icon: '💿', price: 90, unlockZone: 4, desc: 'Passive: if you are knocked out, restore from snapshot at 50% HP (consumed).' },
];

// effects: atk, hp, bw, crit, gold, xp, speed (seconds), dmg (multiplier), typeDmg {type: mult}
export const GEAR = [
  // Weapons
  { id: 'patch-whip', slot: 'weapon', name: 'Patch Cable Whip', icon: '➰', price: 60, unlockZone: 0, effects: { atk: 3 }, desc: 'Three feet of Cat5e and bad intentions.' },
  { id: 'crimper', slot: 'weapon', name: 'Crimping Tool', icon: '🔧', price: 160, unlockZone: 2, effects: { atk: 6 }, desc: 'T568B or bust.' },
  { id: 'fiber-blade', slot: 'weapon', name: 'Fiber Optic Blade', icon: '🗡️', price: 360, unlockZone: 4, effects: { atk: 10 }, desc: 'Cuts at the speed of light. Do not look into the business end.' },
  { id: 'mech-keyboard', slot: 'weapon', name: 'Mechanical Keyboard of Fury', icon: '⌨️', price: 720, unlockZone: 6, effects: { atk: 15 }, desc: 'Cherry MX Blues. Your enemies hear you coming.' },
  // Armor
  { id: 'hoodie', slot: 'armor', name: 'Conference Hoodie', icon: '🧥', price: 50, unlockZone: 0, effects: { hp: 20 }, desc: 'Free swag. Surprisingly durable.' },
  { id: 'cat6-mail', slot: 'armor', name: 'Cat6 Chainmail', icon: '🦺', price: 150, unlockZone: 2, effects: { hp: 45 }, desc: 'Woven from 1,000 shielded twisted pairs.' },
  { id: 'rack-plate', slot: 'armor', name: 'Rack-Mount Plate', icon: '🛡️', price: 350, unlockZone: 4, effects: { hp: 80 }, desc: '19 inches wide, 4U of pure protection.' },
  { id: 'faraday-armor', slot: 'armor', name: 'Faraday Cage Armor', icon: '⚙️', price: 700, unlockZone: 6, effects: { hp: 130 }, desc: 'Nothing gets in. Not even Wi-Fi.' },
  // Accessories
  { id: 'coffee-mug', slot: 'accessory', name: 'Bottomless Coffee Mug', icon: '☕', price: 70, unlockZone: 0, effects: { bw: 4 }, desc: '+4 BW. Fuel for on-call shifts.' },
  { id: 'rubber-duck-charm', slot: 'accessory', name: 'Rubber Duck Charm', icon: '🐥', price: 140, unlockZone: 1, effects: { crit: 0.06 }, desc: '+6% crit. It listens without judgement.' },
  { id: 'lucky-rj45', slot: 'accessory', name: 'Lucky RJ45', icon: '🔌', price: 200, unlockZone: 3, effects: { gold: 0.2 }, desc: '+20% gold. Clicked in on the first try.' },
  { id: 'nc-headphones', slot: 'accessory', name: 'Noise-Cancelling Headphones', icon: '🎧', price: 260, unlockZone: 5, effects: { speed: 3 }, desc: 'Speed-bonus window +3s. Open-plan offices fear them.' },
  { id: 'sticker-laptop', slot: 'accessory', name: 'Sticker-Covered Laptop', icon: '💻', price: 520, unlockZone: 6, effects: { bw: 8, crit: 0.05 }, desc: '+8 BW, +5% crit. Each sticker is a war story.' },
  // Boss loot (never sold)
  { id: 'encap-cloak', slot: 'armor', name: 'Encapsulation Cloak', icon: '🧣', loot: true, effects: { hp: 35, crit: 0.03 }, desc: 'Seven layers of protection. Headers on the outside.' },
  { id: 'vlsm-compass', slot: 'accessory', name: 'VLSM Compass', icon: '🧭', loot: true, effects: { typeDmg: { input: 1.25 } }, desc: '+25% damage on typed-answer questions. Always points to the right block size.' },
  { id: 'root-branch', slot: 'weapon', name: 'Root Bridge Branch', icon: '🌿', loot: true, effects: { atk: 8, crit: 0.05 }, desc: 'Lowest bridge ID in the forest. Everyone defers to it.' },
  { id: 'scrubbing-shield', slot: 'armor', name: 'Scrubbing Center Shield', icon: '🔰', loot: true, effects: { hp: 70, bw: 3 }, desc: 'Absorbs 400 Gbps and asks for more.' },
  { id: 'core-dump-dagger', slot: 'weapon', name: 'Core Dump Dagger', icon: '🔪', loot: true, effects: { atk: 12, typeDmg: { terminal: 1.2 } }, desc: '+20% terminal damage. Forged from the remains of a panicked kernel.' },
  { id: 'rebase-ring', slot: 'accessory', name: 'Ring of Rebase', icon: '💍', loot: true, effects: { crit: 0.1, xp: 0.1 }, desc: '+10% crit, +10% XP. A clean, linear history.' },
  { id: 'idempotence-amulet', slot: 'accessory', name: 'Idempotence Amulet', icon: '📿', loot: true, effects: { bw: 8, dmg: 0.15 }, desc: '+8 BW, +15% damage. Wear it once or a thousand times, same result.' },
  { id: 'elastic-plate', slot: 'armor', name: 'Elastic Plate', icon: '🥋', loot: true, effects: { hp: 150 }, desc: 'Auto-scales to absorb whatever you throw at it.' },
  { id: 'uptime-trophy', slot: 'accessory', name: 'Golden Uptime Trophy', icon: '🏆', loot: true, effects: { xp: 0.25, gold: 0.25, crit: 0.05 }, desc: '99.999%. The rarest artifact in the NetRealm.' },
];

export const ITEM_MAP = Object.fromEntries([...CONSUMABLES, ...GEAR].map((i) => [i.id, i]));

export function describeEffects(effects = {}) {
  const out = [];
  if (effects.atk) out.push(`+${effects.atk} ATK`);
  if (effects.hp) out.push(`+${effects.hp} HP`);
  if (effects.bw) out.push(`+${effects.bw} BW`);
  if (effects.crit) out.push(`+${Math.round(effects.crit * 100)}% crit`);
  if (effects.gold) out.push(`+${Math.round(effects.gold * 100)}% gold`);
  if (effects.xp) out.push(`+${Math.round(effects.xp * 100)}% XP`);
  if (effects.speed) out.push(`+${effects.speed}s speed window`);
  if (effects.dmg) out.push(`+${Math.round(effects.dmg * 100)}% damage`);
  for (const [t, m] of Object.entries(effects.typeDmg || {})) out.push(`+${Math.round((m - 1) * 100)}% ${t} damage`);
  return out.join(', ');
}
