# 🕹️ NetRealm Arcade

A library of retro study games for **networking (CCNA / Network+)**, **Linux**, **Git & CI/CD**, **network automation**, **containers** and **infrastructure as code**, all in one repo and one website.

Visiting the site's URL lands on the **arcade hub**, which lists every game as a card. It has a "Continue" button for your last game, plus search and topic filters once the library grows. Each game has a **◀ Arcade** button that leads back to the hub.

Everything is static HTML/CSS/JavaScript: no frameworks, no build step, no server and no accounts.

## 🎮 Games

| Game | What it is |
|------|------------|
| ⚔️ [**Packet Quest: The Great Outage**](games/packet-quest/) | A retro RPG where every battle is a question. Nine zones covering networking fundamentals through Kubernetes, with spaced repetition, a Codex, daily quests and a two-player Quiz Duel. [More →](games/packet-quest/README.md) |

The live list is [`games.json`](games.json); the hub reads it.

## ➕ Add a game (the short version)

```bash
npm run new-game -- "Subnet Sprint" --icon 🏃 --tags "Subnetting,CCNA"
```

That one command:

1. creates `games/subnet-sprint/` from a starter template (a tiny working quiz you then replace with your game), and
2. adds the game's card to `games.json`, so it shows up in the hub straight away.

Then build your game, add a `thumbnail.png`, run `npm run check` and open a pull request. The full guide, including the rules every game must follow, is in **[CONTRIBUTING.md](CONTRIBUTING.md)**.

You don't have to use the template: any self-contained HTML game in `games/<id>/` with an `index.html` works, as long as you add an entry to `games.json`.

## ▶️ Play locally

The hub and games load data with `fetch`, so they need a tiny local web server (opening `index.html` straight from disk won't work). From this folder:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. (`npm start` runs the same command.)

## 🚀 Publish to GitHub Pages

Two workflows live in [`.github/workflows/`](.github/workflows/):

- **`jekyll-gh-pages.yml`** builds the site with Jekyll and deploys it to GitHub Pages on every push to `main` (i.e. whenever a pull request is merged). Jekyll copies the hub and every game through unchanged.
- **`pages.yml` ("Test")** validates every game and runs all tests on each pull request and push to `main`.

One-time setup: repo **Settings → Pages → Build and deployment → Source: GitHub Actions**. The arcade appears at `https://<user>.github.io/<repo>/`, and each game at `…/games/<id>/`.

**Custom domain:** add your domain under **Settings → Pages → Custom domain** and point your DNS at GitHub (a `CNAME` record to `<user>.github.io` for a subdomain, or GitHub's `A`/`AAAA` records for an apex domain), then tick **Enforce HTTPS**. All links in the arcade are relative, so it works at a custom domain's root and under `/<repo>/` alike.

**Jekyll notes:** Jekyll skips files and folders whose names start with `_` or `.`, and it runs Liquid (`{{ }}`, `{% %}`) on Markdown files. Avoid both in game folders. Game ids can't start with `_` (the scaffolder enforces this), and JSON/JS/HTML files without front matter are copied untouched.

## 🧪 Checks

```bash
npm run validate   # games.json + every game's folder, plus each game's own tools/validate.mjs
npm test           # tests/*.test.js + every game's games/<id>/tests/*.test.js
npm run check      # both
```

CI runs the same checks on every pull request.

## 🗂️ Repository layout

```
index.html            the arcade hub (front page)
404.html              "Game not found" page that links back to the hub
games.json            the catalog: hub title + one entry per game
hub/                  hub styles and script
shared/               optional shared fonts + retro styles (shared/arcade.css) any game can use
games/<id>/           one folder per game, fully self-contained
  index.html          the game's entry point (required)
  thumbnail.png       16:9 card art for the hub (recommended)
  tests/              optional *.test.js, run by `npm test`
  tools/validate.mjs  optional data checks, run by `npm run validate`
tools/new-game.mjs    the scaffolding command
tools/starter-game/   the template new games are copied from
tools/validate-library.mjs, tools/lib/   catalog validation + scaffolding logic
tests/                tests for the arcade tooling
```

## Credits

- Fonts: [Press Start 2P](https://fonts.google.com/specimen/Press+Start+2P) and [VT323](https://fonts.google.com/specimen/VT323), SIL Open Font License (see `shared/fonts/`).
- Vendor and certification names (Cisco, CCNA, CompTIA Network+, AWS, Kubernetes, Terraform, ...) belong to their owners. These are independent study aids.
