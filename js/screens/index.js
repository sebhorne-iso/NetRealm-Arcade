import { titleScreen } from './title.js';
import { createScreen } from './create.js';
import { mapScreen } from './map.js';
import { battleScreen } from './battle.js';
import { shopScreen } from './shop.js';
import { skillsScreen } from './skills.js';
import { codexScreen } from './codex.js';
import { questsScreen } from './quests.js';
import { awardsScreen } from './awards.js';
import { statsScreen } from './stats.js';
import { profileScreen, leaderboardScreen, endingScreen } from './profile.js';
import { duelScreen } from './duel.js';

export const SCREENS = {
  title: titleScreen,
  create: createScreen,
  map: mapScreen,
  battle: battleScreen,
  shop: shopScreen,
  skills: skillsScreen,
  codex: codexScreen,
  quests: questsScreen,
  awards: awardsScreen,
  stats: statsScreen,
  profile: profileScreen,
  leaderboard: leaderboardScreen,
  ending: endingScreen,
  duel: duelScreen,
};
