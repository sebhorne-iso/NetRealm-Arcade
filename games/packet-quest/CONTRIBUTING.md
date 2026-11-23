# Contributing questions & content to Packet Quest

> Want to add a whole new game to the arcade instead? See the [main CONTRIBUTING guide](../../CONTRIBUTING.md).

Thanks for helping your study group level up! Most contributions are **new questions**. They're plain JSON, so no coding is needed.

## Where things live

All paths are relative to `games/packet-quest/`.

| File | What it holds |
|------|---------------|
| `data/questions/01-fundamentals.json` … `08-cloud.json` | The question bank, one file per zone |
| `data/codex.json` | Study notes shown in the in-game Codex |
| `data/zones.json` | Zones, monsters, bosses and story text |

The final zone (*The Core*) automatically draws from every other zone, so it has no file of its own.

## Question format

Every question needs a unique `id`, a `type`, a `topic` (used by the weak-spot stats), a `difficulty` (1 = easy, 2 = medium, 3 = hard), the question text `q` and an `explain`ation that is shown after the player answers, right or wrong. Explanations are what make the game a study tool, so make them teach something!

You can use `` `code` `` and `**bold**` inside text.

### Multiple choice (`mc`)

```json
{
  "id": "rt-099",
  "type": "mc",
  "difficulty": 2,
  "topic": "OSPF",
  "q": "Which OSPF area is the backbone?",
  "choices": ["Area 0", "Area 1", "Area 51", "Area 255"],
  "answer": 0,
  "explain": "Area 0 is the backbone; all other areas must connect to it."
}
```

`answer` is the index of the correct choice. Choices are shuffled in game, so put the correct one wherever you like. Add `"noShuffle": true` if the order matters (e.g. Yes/No).

### Typed answer (`input`)

```json
{
  "id": "sub-099",
  "type": "input",
  "difficulty": 2,
  "topic": "Subnetting",
  "q": "How many usable hosts are in a /27?",
  "answers": ["30"],
  "placeholder": "number",
  "explain": "32 − 27 = 5 host bits → 2^5 − 2 = 30."
}
```

Matching ignores case, extra spaces and a trailing full stop, and numbers match numerically (`65,534` = `65534`). List every acceptable spelling in `answers`, or add regex `patterns` (they're anchored automatically).

### Terminal (`terminal`)

```json
{
  "id": "lx-099",
  "type": "terminal",
  "difficulty": 1,
  "topic": "Navigation",
  "host": "netrealm-srv01",
  "prompt": "user@netrealm:~$",
  "q": "List the files in the current directory.",
  "answers": ["ls"],
  "patterns": ["ls( -[a-z]+)?"],
  "hint": "Two letters.",
  "output": "notes.txt  scripts  backups",
  "explain": "`ls` lists directory contents. Add -l for details and -a for hidden files."
}
```

- `answers[0]` is shown as the correct answer when the player gets it wrong.
- `patterns` accept command variants (flags in a different order, etc.).
- `"ios": true` enables Cisco-style abbreviations, so `sh ip int br` matches `show ip interface brief` (IP addresses and numbers must still be exact).
- A leading `sudo ` is forgiven automatically.
- `output` is printed after a correct answer; `context` lines (optional) are shown above the prompt.

### Ordering (`order`)

```json
{
  "id": "fund-099",
  "type": "order",
  "difficulty": 1,
  "topic": "DHCP",
  "q": "Order the DHCP messages.",
  "items": ["Discover", "Offer", "Request", "Acknowledge"],
  "explain": "DORA!"
}
```

Write `items` in the **correct** order (3–8 items). The game shuffles them.

### Generated (`gen`)

```json
{ "id": "gen-sub-net-4", "type": "gen", "generator": "subnet-network", "difficulty": 3 }
```

Generators create a fresh question every time. Available generators: `subnet-network`, `subnet-broadcast`, `subnet-first-last`, `subnet-hosts`, `subnet-mask`, `subnet-prefix`, `subnet-fit`, `subnet-count`, `wildcard-mask`, `same-subnet`, `ip-class`, `ip-private`, `bin-to-dec`, `dec-to-bin`, `port-number`, `port-protocol` (see `js/engine/generators.js`).

## Before you open a pull request

From the repository's top folder:

```bash
npm run validate
npm test
```

The validator checks the JSON syntax, required fields, duplicate ids and regex patterns, and confirms that every listed answer is actually accepted by the game's answer checker. CI runs the same checks on every pull request.

Then play your questions locally to see how they look: run `python3 -m http.server 8000` in the repository's top folder and open <http://localhost:8000/games/packet-quest/>.

## Style tips

- Aim for exam-style accuracy (CCNA / Network+ level for networking zones).
- Wrong choices should be plausible: common misconceptions make the best distractors.
- Keep the tone friendly; puns are encouraged in monster descriptions and story text.
- Avoid "All of the above" / "None of the above" since choices are shuffled.
