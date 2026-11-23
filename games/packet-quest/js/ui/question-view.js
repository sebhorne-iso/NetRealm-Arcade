// Renders one question (mc / input / terminal / order) and reports the player's response.
import { h, rich, clear } from './dom.js';
import { audio } from '../engine/audio.js';

const TYPE_LABEL = { mc: 'MULTIPLE CHOICE', input: 'TYPE THE ANSWER', terminal: 'TERMINAL', order: 'PUT IN ORDER' };
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

export function renderQuestion(root, q, { onAnswer, speedWindow = 10, showTimer = true, reduceMotion = false } = {}) {
  clear(root);
  root.classList.remove('answered');
  let locked = false;
  let response = null;
  const keyHandlers = [];

  const timer = h('div.speed-timer', { title: 'Answer before the bar empties for a speed crit!' }, h('div.speed-fill'), h('span.speed-label', {}, '⚡'));
  const header = h(
    'div.q-header',
    {},
    h('span.q-type.q-type-' + q.type, {}, TYPE_LABEL[q.type] || q.type),
    q.topic ? h('span.q-topic', {}, q.topic) : null,
    showTimer ? timer : null
  );
  const prompt = h('div.q-prompt', {}, rich(q.q));
  const hintBox = h('div.q-hint.hidden');
  const answerArea = h('div.q-answer');
  const feedback = h('div.q-feedback.hidden');
  root.append(header, prompt, hintBox, answerArea, feedback);

  if (showTimer) {
    const fill = timer.querySelector('.speed-fill');
    fill.style.animationDuration = speedWindow + 's';
    if (reduceMotion) fill.classList.add('static');
  }

  const submit = (r) => {
    if (locked) return;
    locked = true;
    response = r;
    root.classList.add('answered');
    timer.classList.add('stopped');
    onAnswer?.(r);
  };

  const api = {
    q,
    get locked() {
      return locked;
    },
    showHint(text) {
      hintBox.classList.remove('hidden');
      hintBox.replaceChildren(h('span.hint-icon', {}, '💡 '), rich(text));
    },
    eliminate: () => {},
    focus: () => {},
    showResult: () => {},
    feedback,
    destroy() {
      keyHandlers.forEach((fn) => window.removeEventListener('keydown', fn));
    },
  };
  const onKey = (fn) => {
    keyHandlers.push(fn);
    window.addEventListener('keydown', fn);
  };

  // ---------------- multiple choice ----------------
  if (q.type === 'mc') {
    const list = h('div.choices' + (q.choices.length <= 2 ? '.two' : ''));
    const buttons = q.choices.map((c, i) =>
      h(
        'button.choice',
        {
          type: 'button',
          onclick: () => {
            audio.sfx('select');
            submit(i);
          },
        },
        h('span.choice-key', {}, LETTERS[i]),
        h('span.choice-text', {}, rich(c))
      )
    );
    list.append(...buttons);
    answerArea.append(list);
    onKey((e) => {
      if (locked || e.target.tagName === 'INPUT' || document.querySelector('.overlay')) return;
      const k = e.key.toUpperCase();
      let idx = LETTERS.indexOf(k);
      if (idx < 0 && /^[1-6]$/.test(k)) idx = Number(k) - 1;
      if (idx >= 0 && idx < buttons.length && !buttons[idx].disabled) {
        e.preventDefault();
        buttons[idx].click();
      }
    });
    api.eliminate = (n = 2) => {
      const wrong = buttons.map((b, i) => i).filter((i) => i !== q.answer && !buttons[i].disabled);
      wrong.sort(() => Math.random() - 0.5);
      wrong.slice(0, Math.min(n, Math.max(0, buttons.length - 2))).forEach((i) => {
        buttons[i].disabled = true;
        buttons[i].classList.add('eliminated');
      });
    };
    api.autoHint = () => {
      const wrong = q.choices.filter((_, i) => i !== q.answer);
      return q.hint || `It is NOT "${wrong[Math.floor(Math.random() * wrong.length)]}".`;
    };
    api.showResult = (correct) => {
      buttons.forEach((b, i) => {
        b.disabled = true;
        if (i === q.answer) b.classList.add('right');
        else if (i === response) b.classList.add('wrong');
      });
    };
    api.focus = () => buttons.find((b) => !b.disabled)?.focus({ preventScroll: true });
  }

  // ---------------- typed input ----------------
  if (q.type === 'input') {
    const input = h('input.text-input', { type: 'text', placeholder: q.placeholder || 'Type your answer', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, enterkeyhint: 'go', 'aria-label': 'Your answer' });
    const go = h('button.btn.primary', { type: 'button', onclick: () => input.value.trim() && submit(input.value) }, 'Submit ⏎');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        e.preventDefault();
        submit(input.value);
      }
    });
    answerArea.append(h('div.input-row', {}, input, go));
    api.focus = () => input.focus({ preventScroll: true });
    api.eliminate = () => api.showHint(`Starts with: \`${revealPrefix(q.answers[0])}\``);
    api.autoHint = () => q.hint || `The answer starts with "${String(q.answers[0])[0]}".`;
    api.showResult = (correct) => {
      input.disabled = true;
      go.disabled = true;
      input.classList.add(correct ? 'right' : 'wrong');
    };
  }

  // ---------------- terminal ----------------
  if (q.type === 'terminal') {
    const screen = h('div.terminal-screen');
    for (const line of (q.context || '').split('\n').filter(Boolean)) screen.append(h('div.term-line.term-out', {}, line));
    const input = h('input.term-input', { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, enterkeyhint: 'go', 'aria-label': 'Terminal command' });
    const promptLine = h('div.term-line.term-prompt-line', {}, h('span.term-prompt', {}, q.prompt + ' '), input, h('span.term-cursor', {}, '█'));
    screen.append(promptLine);
    const term = h('div.terminal', { onclick: () => input.focus() }, h('div.terminal-bar', {}, h('span', {}, '● ● ●'), h('span.terminal-title', {}, q.host || 'console')), screen);
    const go = h('button.btn.primary.term-go', { type: 'button', onclick: () => input.value.trim() && submit(input.value) }, 'Run ⏎');
    answerArea.append(term, h('div.row.end.term-actions', {}, h('span.muted.small', {}, 'Type ? + Enter for a hint'), go));
    input.addEventListener('input', () => audio.sfx('type'));
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      if (v === '?' || v === 'help' || v === '--help') {
        screen.insertBefore(h('div.term-line.term-out', {}, `${q.prompt} ${v}`), promptLine);
        screen.insertBefore(h('div.term-line.term-hint', {}, q.hint || `Hint: the command starts with "${q.answers[0].split(' ')[0]}"`), promptLine);
        input.value = '';
        api.usedHelp = true;
        return;
      }
      submit(v);
    });
    api.focus = () => input.focus({ preventScroll: true });
    api.eliminate = () => api.showHint(`Starts with: \`${revealPrefix(q.answers[0])}\``);
    api.autoHint = () => q.hint || `The command starts with "${q.answers[0].split(' ')[0]}".`;
    api.showResult = (correct) => {
      input.disabled = true;
      go.disabled = true;
      promptLine.querySelector('.term-cursor')?.remove();
      const out = correct
        ? q.output || ''
        : q.ios
          ? `% Invalid input detected at '^' marker.\n! Expected: ${q.answers[0]}`
          : `${String(response).split(' ')[0]}: that didn't do it.\n# Expected: ${q.answers[0]}`;
      const lines = out.split('\n').filter((l) => l.length);
      let i = 0;
      const addLine = () => {
        if (i >= lines.length) return;
        screen.append(h('div.term-line.' + (correct ? 'term-out' : 'term-err'), {}, lines[i]));
        screen.scrollTop = screen.scrollHeight;
        i++;
        if (reduceMotion) addLine();
        else setTimeout(addLine, 45);
      };
      addLine();
    };
  }

  // ---------------- ordering ----------------
  if (q.type === 'order') {
    const placed = [];
    const poolEl = h('div.order-pool');
    const answerEl = h('ol.order-answer');
    const go = h('button.btn.primary', { type: 'button', disabled: true, onclick: () => submit(placed.slice()) }, 'Submit order ✔');
    const reset = h('button.btn', { type: 'button', onclick: () => { placed.length = 0; draw(); } }, 'Reset');
    const draw = () => {
      clear(poolEl);
      clear(answerEl);
      q.items.forEach((it) => {
        if (placed.includes(it)) return;
        poolEl.append(
          h('button.chip', { type: 'button', disabled: locked, onclick: () => { audio.sfx('select'); placed.push(it); draw(); } }, rich(it))
        );
      });
      placed.forEach((it, i) => {
        answerEl.append(
          h('li', {}, h('button.chip.placed', { type: 'button', disabled: locked || i < (api.lockedPrefix || 0), onclick: () => { placed.splice(i, 1); draw(); } }, h('span.chip-num', {}, i + 1), rich(it)))
        );
      });
      if (!placed.length) answerEl.append(h('li.order-empty', {}, 'Tap items below in the correct order'));
      go.disabled = locked || placed.length !== q.items.length;
    };
    answerArea.append(answerEl, poolEl, h('div.row.end', {}, reset, go));
    draw();
    api.eliminate = () => {
      placed.length = 0;
      placed.push(...q.correctOrder.slice(0, 2));
      api.lockedPrefix = 2;
      draw();
    };
    api.autoHint = () => q.hint || `The first item is "${q.correctOrder[0]}".`;
    api.showResult = () => {
      draw();
      answerEl.querySelectorAll('li').forEach((li, i) => li.classList.add(placed[i] === q.correctOrder[i] ? 'right' : 'wrong'));
    };
    api.focus = () => poolEl.querySelector('button')?.focus({ preventScroll: true });
    onKey((e) => {
      if (!locked && e.key === 'Enter' && !go.disabled && !document.querySelector('.overlay')) go.click();
    });
  }

  return api;
}

// How to display the correct answer in feedback.
export function expectedText(q) {
  if (q.type === 'mc') return q.choices[q.answer];
  if (q.type === 'order') return q.correctOrder.map((s, i) => `${i + 1}. ${s}`).join('  →  ');
  return '`' + String(q.answers[0]).replace(/`/g, "'") + '`';
}

function revealPrefix(ans) {
  const s = String(ans);
  return s.slice(0, Math.max(1, Math.ceil(s.length * 0.4))) + '…';
}

export function renderFeedback(api, { correct, expected, explain, extra = [], onContinue, continueLabel = 'Continue ▶' }) {
  const fb = api.feedback;
  fb.classList.remove('hidden');
  fb.classList.toggle('good', correct);
  fb.classList.toggle('bad', !correct);
  const cont = h('button.btn.primary.continue-btn', { type: 'button', onclick: () => { audio.sfx('select'); cleanup(); onContinue?.(); } }, continueLabel);
  const onKey = (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !document.querySelector('.overlay')) {
      e.preventDefault();
      cont.click();
    }
  };
  const cleanup = () => window.removeEventListener('keydown', onKey);
  fb.replaceChildren(
    ...[
      h('div.fb-title', {}, correct ? '✔ CORRECT!' : '✘ NOT QUITE'),
      !correct && expected != null ? h('div.fb-expected', {}, 'Answer: ', rich(expected)) : null,
      ...extra,
      explain ? h('div.fb-explain', {}, rich(explain)) : null,
      h('div.row.end', {}, cont),
    ].filter(Boolean)
  );
  // Delay binding so the Enter that submitted the answer doesn't also skip the explanation.
  setTimeout(() => window.addEventListener('keydown', onKey), 350);
  setTimeout(() => cont.focus({ preventScroll: true }), 60);
  fb.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  return cleanup;
}
