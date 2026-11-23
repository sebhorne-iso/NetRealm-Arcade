# Contributing to NetRealm Arcade

There are two ways to help:

- **Add a new game** to the arcade (this guide).
- **Add questions to Packet Quest**: see [`games/packet-quest/CONTRIBUTING.md`](games/packet-quest/CONTRIBUTING.md).

## Adding a game, step by step

### 1. Scaffold it

From the repository's top folder:

```bash
npm run new-game -- "Port Blaster" --icon 🚀 --color "#ff5c6c" --tags "Ports,Network+" --description "Blast the right port numbers before they reach your firewall!"
```

Only the title is required. Options:

| Option | Default | Meaning |
|---|---|---|
| `--id` | made from the title (`port-blaster`) | Folder name and URL: lowercase letters, numbers, dashes |
| `--icon` | 🎮 | Emoji shown on the card (and as placeholder art) |
| `--color` | `#7fd0ff` | Card accent color |
| `--tags` | none | Comma-separated topics, used by the hub's filters |
| `--description` | a placeholder | One or two sentences for the card |

This creates `games/port-blaster/` (a copy of `tools/starter-game/`) and appends the game's card to `games.json`.

### 2. Build your game

Edit the files in `games/<id>/`. The starter is a tiny working quiz (`index.html`, `main.js`, `style.css`) so you can see how it fits together. Replace it with whatever you like: canvas, DOM, a library you vendor into the folder, anything static.

**The four arcade rules** (the validator enforces the first one):

1. **Relative paths only.** Write `css/style.css`, `data/levels.json`, `../../shared/arcade.css`, never `/css/style.css`. The site may live under `/<repo>/` on github.io *or* at a custom domain's root, and absolute paths break one of them.
2. **Keep a way home.** Include the back link to the hub: `<a class="arcade-back" href="../../">◀ Arcade</a>` (styled by `shared/arcade.css`), or your own button that goes to `../../`.
3. **Namespace your saves.** Every game shares the browser's `localStorage` on the same domain, so prefix keys with your game id, e.g. `arcade.port-blaster.v1` (the starter already does).
4. **Stay inside your folder.** Everything your game needs lives in `games/<id>/`. It may *optionally* use `../../shared/` (fonts and retro styles); nothing else in the repo should depend on your game.

### 3. Fill in the card

Edit your entry in [`games.json`](games.json):

```json
{
  "id": "port-blaster",
  "title": "Port Blaster",
  "description": "Blast the right port numbers before they reach your firewall!",
  "thumbnail": "games/port-blaster/thumbnail.png",
  "icon": "🚀",
  "color": "#ff5c6c",
  "genre": "Arcade",
  "players": "1",
  "tags": ["Ports", "Network+"],
  "added": "2026-11-23",
  "featured": false
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | ✔ | Must match the folder name `games/<id>/` |
| `title` | ✔ | |
| `description` | ✔ | Shown on the card; searchable |
| `thumbnail` | recommended | 16:9 image (e.g. 640×360 PNG). Without one, the hub draws a placeholder from `icon` and `color` |
| `icon`, `color` | | Emoji and `#rrggbb` accent |
| `genre`, `players` | | Shown in the card footer, e.g. "RPG · 1–2 players" |
| `tags` | | Topics for filtering (search and filters appear once there are 4+ games) |
| `added` | | `YYYY-MM-DD`; cards get a **NEW** badge for 30 days |
| `featured` | | `true` pins the game to the front |

The order of games in `games.json` is the order in the hub (featured games first).

### 4. Optional: tests and data checks

- Put `*.test.js` files (Node's built-in `node:test`) in `games/<id>/tests/`. `npm test` finds them automatically.
- If your game has data files (questions, levels...), add `games/<id>/tools/validate.mjs` that exits non-zero on problems. `npm run validate` and CI run it automatically.

Packet Quest has examples of both.

### 5. Check and preview

```bash
npm run check                 # validates games.json, your folder and all game data, then runs every test
python3 -m http.server 8000   # then open http://localhost:8000 and click your card
```

### 6. Open a pull request

Checklist:

- [ ] `npm run check` passes
- [ ] The game loads from the hub, and **◀ Arcade** returns to it
- [ ] It works on a phone-sized screen (or the description says it's desktop-only)
- [ ] There's a thumbnail
- [ ] Optionally, a row in the README's games table

## Adding a game by hand (no scaffolder)

1. Create `games/<id>/index.html` (plus whatever else your game needs).
2. Add an entry to `games.json` as above.
3. Run `npm run check`.

## Removing or renaming a game

- **Remove:** delete `games/<id>/` and its entry in `games.json`.
- **Rename:** the `id` is part of the URL, so changing it breaks old links and resets players' "last played" status. Prefer changing just the `title`.
