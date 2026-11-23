# ⚔️ Packet Quest: The Great Outage

A retro pixel-art RPG for studying **networking (CCNA / Network+)**, **Linux**, **Git & CI/CD**, **network automation**, **containers** and **infrastructure as code**. Every battle is a question. Answer right to strike, answer wrong and the monster hits back.

It runs entirely in the browser (no install, no server, no accounts) and works on desktop and mobile.

## 🎮 The game

The NetRealm has been corrupted by **THE GREAT OUTAGE**. Guided by Old Man Ping (who has been replying to echo requests since 1983), you fight your way through nine zones:

| # | Zone | Topics |
|---|------|--------|
| 1 | 📦 Packet Plains | OSI/TCP-IP models, encapsulation, TCP vs UDP, ports, Ethernet, cabling |
| 2 | 🧮 Subnet Swamp | Binary, CIDR, subnetting (endless generated drills), VLSM, private ranges, IPv6 |
| 3 | 🔀 Routing Ridge | VLANs, trunking, STP, routing tables, AD, OSPF, EtherChannel, FHRP, Cisco IOS CLI |
| 4 | 🏰 Firewall Fortress | DNS, DHCP, NAT/PAT, ACLs, wildcards, AAA, Layer 2 security, wireless, VPNs, attacks |
| 5 | 🐧 Linux Caverns | Shell navigation, permissions, pipes, processes, systemd, logs, networking commands |
| 6 | ⚒️ Pipeline Forge | Git, branching, PRs, merge conflicts, CI/CD, GitHub Actions, deployment strategies |
| 7 | 🤖 API Archipelago | Python, JSON/YAML/XML, REST & HTTP codes, NETCONF/RESTCONF/YANG, Ansible, SDN |
| 8 | ☁️ Cloud Citadel | Docker, Kubernetes, Terraform, IaC, VPCs/subnets/security groups, cloud models |
| 9 | 💠 The Core | Final exam: everything, against a three-phase final boss |

### Features

- **Four challenge types:** multiple choice, typed answers, a **simulated terminal** (Linux shell, Python REPL and Cisco IOS, where abbreviations like `sh ip int br` work and `?` gives a hint) and **ordering puzzles**.
- **420+ hand-written questions**, each with an explanation, plus **procedural generators** for endless subnetting, binary, wildcard and port-number drills.
- **RPG progression:** 3 classes (Network Knight, Shell Sorcerer, Pipeline Ranger), levels, a skill tree with active and passive skills, gear, consumables, a shop and unique boss loot.
- **Combat feel:** ⚡ speed crits for fast answers (never a penalty for slow ones), combo multipliers, enraged bosses and a multi-phase final boss.
- **Built-in learning:** an explanation after every answer, **spaced repetition** (missed questions come back as 🐛 *Recurring Bugs*), a **Codex** of cheat sheets for every zone, a Bestiary, and a **weak-spot stats** screen that tells you what to study next.
- **Habit building:** daily quests, a 🔥 streak with an XP bonus, 38 achievements and unlockable titles.
- **Study group mode:** multiple profiles per device, a local leaderboard, **hot-seat Quiz Duel** for two players, shareable **score cards** (image + text) and **save codes** to move progress between devices.
- Chiptune music and sound effects generated in the browser, plus accessibility settings (readable font, larger text, reduced motion, timer toggle).
- Optional 💀 **Hardcore mode:** 1.5× rewards, tougher monsters, no running, and one defeat ends the run.

## ▶️ Play it

### On GitHub Pages
This repo deploys itself with GitHub Actions. One-time setup:

1. Merge to `main`.
2. Go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. The *Test & Deploy* workflow validates the questions, runs the tests and publishes the game at `https://<your-user>.github.io/<repo-name>/`.

### Locally
The game loads its data with `fetch`, so it needs a tiny web server (opening `index.html` straight from disk won't work):

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. (`npm start` does the same thing.)

### Controls
- **1–4** or **A–D** answer multiple choice · **Enter** submits and continues · **M** toggles sound · **Esc** closes dialogs.
- Everything is also tap-friendly on phones.

Progress is saved in your browser's local storage. Use **Profile → Save code** to back it up or move it to another device.

## ✍️ Adding questions

All questions live in plain JSON files in [`data/questions/`](data/questions/), one per zone. Your study group can add questions with a pull request. See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the format.

```bash
npm run validate   # checks every question (also runs in CI)
npm test           # unit tests for the game engine
```

## 🗂️ Project structure

```
index.html            entry point
css/style.css         retro UI styling
js/main.js            bootstrap, router, game events
js/engine/            pure logic: questions, generators, spaced repetition, progression, saves, sprites, audio
js/content/           classes, skills, items, achievements, daily quests
js/screens/           one module per screen (map, battle, shop, codex, duel, ...)
js/ui/                DOM helpers and the shared question renderer
data/zones.json       zones, monsters, bosses and story text
data/codex.json       study notes / cheat sheets
data/questions/*.json the question bank
tools/validate.mjs    data validator used by CI
tests/                node:test unit tests
```

No frameworks and no build step: just ES modules, Canvas and the Web Audio API.

## Credits

- Fonts: [Press Start 2P](https://fonts.google.com/specimen/Press+Start+2P) and [VT323](https://fonts.google.com/specimen/VT323), both under the SIL Open Font License (see `assets/fonts/`).
- All pixel art, music and sound effects are generated in code.
- Vendor and certification names (Cisco, CCNA, CompTIA Network+, AWS, Kubernetes, Terraform, ...) belong to their owners. This is an independent study aid.
