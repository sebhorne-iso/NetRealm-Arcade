// Achievements. check(profile, ctx) -> boolean. Achievements with `title` unlock a selectable title.
const zoneClear = (id) => (p) => !!p.zones[id]?.bossDefeated;

export const ACHIEVEMENTS = [
  { id: 'hello-world', icon: '👋', name: 'Hello, World!', desc: 'Win your first battle.', check: (p) => p.stats.battlesWon >= 1 },
  { id: 'incident-commander', icon: '🚨', name: 'Incident Commander', desc: 'Defeat your first boss.', check: (p) => p.stats.bossesDefeated >= 1 },

  { id: 'clear-fundamentals', icon: '📦', name: 'Packet Pusher', desc: 'Clear Packet Plains.', title: 'Packet Pusher', check: zoneClear('fundamentals') },
  { id: 'clear-subnetting', icon: '🧮', name: 'Address Architect', desc: 'Clear Subnet Swamp.', title: 'Address Architect', check: zoneClear('subnetting') },
  { id: 'clear-routing', icon: '🌳', name: 'The Root Bridge', desc: 'Clear Routing Ridge.', title: 'The Root Bridge', check: zoneClear('routing') },
  { id: 'clear-security', icon: '🏰', name: 'Firewall Warden', desc: 'Clear Firewall Fortress.', title: 'Firewall Warden', check: zoneClear('security') },
  { id: 'clear-linux', icon: '🐧', name: 'Superuser', desc: 'Clear Linux Caverns.', title: 'Superuser', check: zoneClear('linux') },
  { id: 'clear-cicd', icon: '🔀', name: 'Merge Master', desc: 'Clear Pipeline Forge.', title: 'Merge Master', check: zoneClear('cicd') },
  { id: 'clear-automation', icon: '🤖', name: 'Automation Archmage', desc: 'Clear API Archipelago.', title: 'Automation Archmage', check: zoneClear('automation') },
  { id: 'clear-cloud', icon: '☁️', name: 'Kubernetes Kaptain', desc: 'Clear Cloud Citadel.', title: 'Kubernetes Kaptain', check: zoneClear('cloud') },
  { id: 'clear-core', icon: '👑', name: 'Distinguished Engineer', desc: 'Defeat THE GREAT OUTAGE.', title: 'Distinguished Engineer', check: zoneClear('core') },

  { id: 'combo-5', icon: '🔥', name: 'In the Zone', desc: 'Reach a 5-answer combo.', check: (p) => p.stats.bestCombo >= 5 },
  { id: 'combo-9', icon: '9️⃣', name: 'Five Nines', desc: 'Reach a 9-answer combo.', title: 'Five Nines', check: (p) => p.stats.bestCombo >= 9 },
  { id: 'combo-15', icon: '💯', name: 'Zero Downtime', desc: 'Reach a 15-answer combo.', title: 'Zero Downtime', check: (p) => p.stats.bestCombo >= 15 },

  { id: 'subnet-sniper', icon: '🎯', name: 'Subnet Sniper', desc: 'Correctly answer 25 generated subnetting calculations.', title: 'Subnet Sniper', check: (p) => p.stats.subnetCorrect >= 25 },
  { id: 'terminal-velocity', icon: '⌨️', name: 'Terminal Velocity', desc: 'Nail 15 terminal challenges.', title: 'Terminal Velocity', check: (p) => p.stats.terminalCorrect >= 15 },
  { id: 'speed-demon', icon: '⚡', name: 'Low-Latency Legend', desc: 'Land 25 speed crits.', title: 'Low-Latency Legend', check: (p) => p.stats.crits >= 25 },

  { id: 'bug-squasher', icon: '🐛', name: 'Bug Squasher', desc: 'Squash 10 Recurring Bugs.', check: (p) => p.stats.bugsSquashed >= 10 },
  { id: 'exterminator', icon: '🪲', name: 'Exterminator', desc: 'Squash 50 Recurring Bugs.', title: 'Exterminator', check: (p) => p.stats.bugsSquashed >= 50 },

  { id: 'streak-3', icon: '📟', name: 'On-Call', desc: 'Keep a 3-day streak.', check: (p) => p.streak.best >= 3 },
  { id: 'streak-7', icon: '📆', name: 'Pager Duty', desc: 'Keep a 7-day streak.', title: 'On-Call Hero', check: (p) => p.streak.best >= 7 },
  { id: 'streak-30', icon: '🏅', name: 'SRE Legend', desc: 'Keep a 30-day streak.', title: 'SRE Legend', check: (p) => p.streak.best >= 30 },

  { id: 'level-5', icon: '⭐', name: 'Junior No More', desc: 'Reach level 5.', check: (p) => p.level >= 5 },
  { id: 'level-10', icon: '🌟', name: 'Senior Engineer', desc: 'Reach level 10.', title: 'Senior Engineer', check: (p) => p.level >= 10 },
  { id: 'level-20', icon: '💫', name: 'Principal Engineer', desc: 'Reach level 20.', title: 'Principal Engineer', check: (p) => p.level >= 20 },

  { id: 'answered-100', icon: '💬', name: 'Centurion', desc: 'Answer 100 questions.', check: (p) => p.stats.answered >= 100 },
  { id: 'answered-500', icon: '🌩️', name: 'Packet Storm', desc: 'Answer 500 questions.', title: 'Packet Storm', check: (p) => p.stats.answered >= 500 },

  { id: 'flawless', icon: '✨', name: 'Zero Packet Loss', desc: 'Win a battle without taking any damage.', check: (p) => p.stats.flawless >= 1 },
  { id: 'flawless-boss', icon: '🐒', name: 'Chaos Engineer', desc: 'Defeat a boss without taking any damage.', title: 'Chaos Engineer', check: (p) => p.stats.flawlessBoss >= 1 },
  { id: 'clutch', icon: '😅', name: 'Hotfix in Prod', desc: 'Win a battle with less than 10% HP left.', check: (p) => p.stats.clutch >= 1 },

  { id: 'rtfm', icon: '📖', name: 'RTFM', desc: 'Read 10 Codex entries.', title: 'Reads The Fine Manual', check: (p) => Object.keys(p.codexRead).length >= 10 },
  { id: 'shopaholic', icon: '🛒', name: 'Procurement Approved', desc: 'Buy 10 items.', check: (p) => p.stats.itemsBought >= 10 },
  { id: 'rich', icon: '💰', name: 'Budget Surplus', desc: 'Hold 1,000 gold at once.', check: (p) => p.gold >= 1000 },
  { id: 'fully-provisioned', icon: '🧰', name: 'Fully Provisioned', desc: 'Equip a weapon, armor and accessory.', check: (p) => !!(p.gear.weapon && p.gear.armor && p.gear.accessory) },
  { id: 'upskilled', icon: '🎓', name: 'Upskilled', desc: 'Learn 5 skills.', check: (p) => Object.keys(p.skills).length >= 5 },
  { id: 'duelist', icon: '🤺', name: 'Duelist', desc: 'Win a Quiz Duel.', title: 'Duelist', check: (p) => p.stats.duelWins >= 1 },
  { id: 'iron-engineer', icon: '💀', name: 'Iron Engineer', desc: 'Clear a zone in Hardcore mode.', title: 'Iron Engineer', check: (p) => p.hardcore && p.stats.bossesDefeated >= 1 },
  {
    id: 'sme',
    icon: '🧠',
    name: 'Subject Matter Expert',
    desc: 'Reach 80% mastery in any zone.',
    title: 'Subject Matter Expert',
    check: (p, ctx) => !!ctx && ctx.zoneMasteries().some((m) => m >= 0.8),
  },
];

export const ACH_MAP = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));

// Returns newly unlocked achievements (and records them on the profile).
export function checkAchievements(profile, ctx) {
  const fresh = [];
  for (const a of ACHIEVEMENTS) {
    if (profile.achievements[a.id]) continue;
    let ok = false;
    try {
      ok = a.check(profile, ctx);
    } catch {
      ok = false;
    }
    if (ok) {
      profile.achievements[a.id] = Date.now();
      fresh.push(a);
    }
  }
  return fresh;
}

export function unlockedTitles(profile) {
  return ACHIEVEMENTS.filter((a) => a.title && profile.achievements[a.id]).map((a) => a.title);
}
