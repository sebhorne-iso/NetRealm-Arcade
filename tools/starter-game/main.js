// __GAME_TITLE__: starter template.
// This is a tiny working quiz so you can see the pieces fit together. Replace it with your game!
//
// Arcade rules of thumb:
//  • Every game in the arcade shares ONE browser localStorage, so prefix your keys with your game id.
//  • Keep all paths relative (e.g. "data/levels.json", never "/data/levels.json").

const STORAGE_KEY = 'arcade.__GAME_ID__.v1';

const QUESTIONS = [
  { q: 'Which port does SSH use by default?', choices: ['22', '23', '80', '443'], answer: 0, explain: 'SSH runs on TCP 22. Telnet (23) is its insecure, clear-text ancestor.' },
  { q: 'At which OSI layer do routers forward packets?', choices: ['Layer 3: Network', 'Layer 2: Data Link', 'Layer 4: Transport', 'Layer 7: Application'], answer: 0, explain: 'Routers make decisions using IP addresses, which live at Layer 3.' },
  { q: 'How many usable hosts are in a /29 subnet?', choices: ['6', '8', '14', '30'], answer: 0, explain: '32 − 29 = 3 host bits → 2³ = 8 addresses, minus network and broadcast = 6.' },
  { q: 'Which command creates a new Git branch and switches to it?', choices: ['git switch -c feature', 'git merge feature', 'git push -u feature', 'git stash feature'], answer: 0, explain: '`git switch -c <name>` (or the classic `git checkout -b <name>`).' },
];

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { best: 0 };
  } catch {
    return { best: 0 };
  }
}

function save(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* storage can be disabled; the game still works */
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const root = document.getElementById('game');
const data = load();
let index = 0;
let score = 0;

function showQuestion() {
  if (index >= QUESTIONS.length) return showResults();
  const item = QUESTIONS[index];
  root.replaceChildren();
  root.append(el('p', 'starter-progress', `Question ${index + 1} / ${QUESTIONS.length} · Score ${score}`), el('h2', 'starter-question', item.q));
  const choices = el('div', 'starter-choices');
  for (const k of shuffle(item.choices.map((_, i) => i))) {
    const btn = el('button', 'arcade-btn secondary', item.choices[k]);
    btn.type = 'button';
    btn.addEventListener('click', () => answer(k === item.answer, btn, choices, item));
    choices.append(btn);
  }
  root.append(choices);
  choices.querySelector('button').focus();
}

function answer(correct, btn, choices, item) {
  if (correct) score++;
  choices.querySelectorAll('button').forEach((b) => (b.disabled = true));
  btn.classList.add(correct ? 'right' : 'wrong');
  const feedback = el('div', 'starter-feedback ' + (correct ? 'good' : 'bad'));
  feedback.append(el('strong', null, correct ? '✔ Correct! ' : `✘ Not quite. Answer: ${item.choices[item.answer]}. `), el('span', null, item.explain));
  const next = el('button', 'arcade-btn', index + 1 < QUESTIONS.length ? 'Next ▶' : 'Results ▶');
  next.type = 'button';
  next.addEventListener('click', () => {
    index++;
    showQuestion();
  });
  root.append(feedback, next);
  next.focus();
}

function showResults() {
  const newBest = score > data.best;
  if (newBest) {
    data.best = score;
    save(data);
  }
  root.replaceChildren(
    el('h2', 'starter-question', `You scored ${score} / ${QUESTIONS.length}`),
    el('p', 'arcade-muted', newBest ? '🏆 New best score!' : `Best: ${data.best} / ${QUESTIONS.length}`)
  );
  const again = el('button', 'arcade-btn', 'Play again ↻');
  again.type = 'button';
  again.addEventListener('click', () => {
    index = 0;
    score = 0;
    showQuestion();
  });
  root.append(again);
  again.focus();
}

showQuestion();
