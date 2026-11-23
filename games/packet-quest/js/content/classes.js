// The three playable classes. zoneBonus zones get +20% damage.
export const CLASSES = {
  knight: {
    id: 'knight',
    name: 'Network Knight',
    sprite: 'knight',
    blurb: 'A stalwart defender of the wire. More HP, and +20% damage in the four networking zones.',
    perks: ['+20% max HP', '+20% damage in Packet Plains, Subnet Swamp, Routing Ridge and Firewall Fortress', 'Class skills: Spanning Shield, EtherChannel, First Hop Redundancy'],
    hpMult: 1.2,
    bwMult: 1.0,
    goldMult: 1.0,
    critBonus: 0,
    zoneBonus: ['fundamentals', 'subnetting', 'routing', 'security'],
  },
  sorcerer: {
    id: 'sorcerer',
    name: 'Shell Sorcerer',
    sprite: 'sorcerer',
    blurb: 'Bends machines to their will with arcane one-liners. Extra Bandwidth for skills, +20% damage in Linux Caverns and API Archipelago.',
    perks: ['+50% max Bandwidth (BW)', '+20% damage in Linux Caverns and API Archipelago', 'Class skills: sudo !!, Tab Completion, Cron Job'],
    hpMult: 1.0,
    bwMult: 1.5,
    goldMult: 1.0,
    critBonus: 0,
    zoneBonus: ['linux', 'automation'],
  },
  ranger: {
    id: 'ranger',
    name: 'Pipeline Ranger',
    sprite: 'ranger',
    blurb: 'Ships fast and hits precisely. More gold and crits, +20% damage in Pipeline Forge and Cloud Citadel.',
    perks: ['+25% gold', '+7% critical hit chance', '+20% damage in Pipeline Forge and Cloud Citadel', 'Class skills: Parallel Jobs, Artifact Cache, Canary Deploy'],
    hpMult: 1.0,
    bwMult: 1.0,
    goldMult: 1.25,
    critBonus: 0.07,
    zoneBonus: ['cicd', 'cloud'],
  },
};

// Avatar tints chosen at character creation [main, light, dark].
export const AVATAR_COLORS = [
  { name: 'Cobalt', c: ['#3b6fe0', '#7fa6ff', '#1d3a8a'] },
  { name: 'Crimson', c: ['#d63a4a', '#ff7a86', '#7a1424'] },
  { name: 'Emerald', c: ['#2fa85a', '#6fe08f', '#145a2c'] },
  { name: 'Amethyst', c: ['#8a4fd6', '#c09cff', '#45207a'] },
  { name: 'Amber', c: ['#e08a1e', '#ffc06a', '#7a4410'] },
  { name: 'Teal', c: ['#1fa3a3', '#6fe6e0', '#0e5454'] },
];
