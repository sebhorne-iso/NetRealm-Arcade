#!/usr/bin/env node
// Scaffold a new game: copies tools/starter-game/ to games/<id>/ and adds it to games.json.
//
//   npm run new-game -- "Port Blaster"
//   npm run new-game -- "Port Blaster" --id port-blaster --icon 🚀 --tags "Ports,Network+" --color "#ff5c6c" --description "Blast the right port numbers!"
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffoldGame } from './lib/catalog.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opts = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const [k, inline] = a.slice(2).split('=');
    opts[k] = inline !== undefined ? inline : args[++i];
  } else positional.push(a);
}

const title = opts.title || positional.join(' ');
if (!title || opts.help !== undefined) {
  console.log(`Create a new game in the arcade.

Usage:
  npm run new-game -- "My Game Title" [--id my-game] [--icon 🎮] [--color "#7fd0ff"]
                                      [--tags "Subnetting,CCNA"] [--description "One-line pitch"]
`);
  process.exit(title ? 0 : 1);
}

try {
  const { dir, entry } = scaffoldGame(root, {
    id: opts.id,
    title,
    description: opts.description,
    icon: opts.icon,
    color: opts.color,
    tags: opts.tags ? opts.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
  });
  const rel = relative(root, dir);
  console.log(`✔ Created ${rel}/ and added "${entry.id}" to games.json

Next steps:
  1. Build your game in ${rel}/ (start with main.js; the starter is a tiny working quiz).
  2. Add a 16:9 screenshot as ${rel}/thumbnail.png and set "thumbnail" in games.json.
  3. Preview it: python3 -m http.server 8000  →  http://localhost:8000
  4. Check everything: npm run check
  5. Open a pull request!`);
} catch (e) {
  console.error(`✖ ${e.message}`);
  process.exit(1);
}
