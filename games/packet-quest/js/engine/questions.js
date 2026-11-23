// Question instantiation, answer checking and spaced-repetition-aware selection.
import { GENERATORS } from './generators.js';
import { weight } from './srs.js';

export const TYPES = ['mc', 'input', 'terminal', 'order', 'gen'];

// Base time (seconds) to earn the speed bonus, per question type.
export const SPEED_WINDOW = { mc: 9, input: 22, terminal: 20, order: 25 };

export function srsId(q) {
  return q.type === 'gen' ? `gen:${q.generator}` : q.id;
}

export function normalize(s) {
  return String(s ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/−/g, '-')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/(\w)[.;]$/, '$1') // forgive a trailing full stop ("1500."), but keep "git add ."
    .toLowerCase();
}

// Turn a raw JSON question into a playable instance (shuffled choices, generated content, ...).
export function instantiate(raw, rng, { zoneId } = {}) {
  const base = {
    srcId: srsId(raw),
    zoneId: raw.zoneId || zoneId,
    topic: raw.topic,
    difficulty: raw.difficulty || 1,
    hint: raw.hint,
  };
  if (raw.type === 'gen') {
    const g = GENERATORS[raw.generator];
    if (!g) throw new Error(`Unknown generator ${raw.generator}`);
    const made = g.make(rng, raw.difficulty || 1);
    const inst = { ...base, ...made, topic: raw.topic || g.topic, generated: true };
    return finishInstance(inst, rng);
  }
  return finishInstance({ ...base, ...raw, ...base }, rng);
}

function finishInstance(q, rng) {
  if (q.type === 'mc') {
    const order = q.choices.map((_, i) => i);
    const shuffled = q.noShuffle || q.shuffle === false ? order : rng.shuffle(order);
    q.choices = shuffled.map((i) => q.choices[i]);
    q.answer = shuffled.indexOf(q.answer);
  }
  if (q.type === 'order') {
    q.correctOrder = q.items.slice();
    let shuffled = rng.shuffle(q.items);
    // Make sure the puzzle doesn't start already solved.
    for (let tries = 0; tries < 5 && shuffled.every((v, i) => v === q.items[i]); tries++) shuffled = rng.shuffle(q.items);
    q.items = shuffled;
  }
  return q;
}

function numericEqual(a, b) {
  const clean = (x) => x.replace(/,/g, '').replace(/^\//, '');
  const na = clean(a);
  const nb = clean(b);
  return /^-?\d+(\.\d+)?$/.test(na) && /^-?\d+(\.\d+)?$/.test(nb) && Number(na) === Number(nb);
}

function patternMatch(patterns, input) {
  return (patterns || []).some((p) => {
    try {
      return new RegExp(`^(?:${p})$`, 'i').test(input);
    } catch {
      return false;
    }
  });
}

// Cisco IOS accepts unambiguous abbreviations: "sh ip int br" == "show ip interface brief".
export function iosMatch(input, full) {
  const a = normalize(input).split(' ');
  const b = normalize(full).split(' ');
  if (a.length !== b.length) return false;
  return a.every((tok, i) => iosTokenMatch(tok, b[i]));
}

function iosTokenMatch(tok, full) {
  if (tok === full) return true;
  if (/\d/.test(full)) {
    // Interface names: "g0/1" matches "gigabitethernet0/1", but numbers/IPs must be exact.
    const fm = full.match(/^([a-z-]+)([\d/.:]+)$/);
    const tm = tok.match(/^([a-z-]+)([\d/.:]+)$/);
    return !!(fm && tm && fm[2] === tm[2] && fm[1].startsWith(tm[1]) && tm[1].length >= 1);
  }
  if (full === 'terminal' && tok === 't') return true;
  return tok.length >= 2 && full.startsWith(tok);
}

export function checkAnswer(q, response) {
  switch (q.type) {
    case 'mc':
      return { correct: response === q.answer, expected: q.choices[q.answer] };
    case 'order': {
      const correct = Array.isArray(response) && response.length === q.correctOrder.length && response.every((v, i) => v === q.correctOrder[i]);
      return { correct, expected: q.correctOrder.join(' → ') };
    }
    case 'input': {
      const r = normalize(response);
      const correct = q.answers.some((a) => normalize(a) === r || numericEqual(normalize(a), r)) || patternMatch(q.patterns, r);
      return { correct, expected: q.answers[0] };
    }
    case 'terminal': {
      const r = normalize(response).replace(/^(sudo )/, q.allowSudo === false ? '$1' : '');
      const correct =
        q.answers.some((a) => normalize(a) === r || normalize(a) === normalize(response) || (q.ios && iosMatch(r, a))) ||
        patternMatch(q.patterns, r) ||
        patternMatch(q.patterns, normalize(response));
      return { correct, expected: q.answers[0] };
    }
    default:
      return { correct: false, expected: '' };
  }
}

// Weighted pick that prefers due/unseen questions and avoids repeats.
export function selectQuestion(pool, qmap, { rng, now = Date.now(), exclude = new Set(), minDiff = 1, maxDiff = 3, bugsOnly = false } = {}) {
  let candidates = pool.filter((q) => !exclude.has(srsId(q)) && (q.difficulty || 1) >= minDiff && (q.difficulty || 1) <= maxDiff);
  if (!candidates.length) candidates = pool.filter((q) => !exclude.has(srsId(q)));
  if (!candidates.length) candidates = pool.slice();
  if (!candidates.length) return null;
  return rng.weighted(candidates, (q) => {
    const w = weight(qmap[srsId(q)], now);
    return bugsOnly ? w : w * (q.type === 'gen' ? 0.7 : 1);
  });
}

// Lightweight validation shared by the browser loader and the CI validator.
export function validateQuestion(q) {
  const errs = [];
  if (!q || typeof q !== 'object') return ['not an object'];
  if (!q.id || typeof q.id !== 'string') errs.push('missing string "id"');
  if (!TYPES.includes(q.type)) errs.push(`"type" must be one of ${TYPES.join(', ')}`);
  if (q.difficulty != null && ![1, 2, 3].includes(q.difficulty)) errs.push('"difficulty" must be 1, 2 or 3');
  if (q.type !== 'gen') {
    if (!q.q || typeof q.q !== 'string') errs.push('missing question text "q"');
    if (!q.explain || typeof q.explain !== 'string') errs.push('missing "explain" (every question needs an explanation)');
    if (!q.topic) errs.push('missing "topic"');
  }
  if (q.type === 'mc') {
    if (!Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 6) errs.push('"choices" must have 2-6 entries');
    else if (new Set(q.choices).size !== q.choices.length) errs.push('"choices" contain duplicates');
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= (q.choices || []).length) errs.push('"answer" must be a valid choice index');
  }
  if (q.type === 'input' || q.type === 'terminal') {
    if (!Array.isArray(q.answers) || !q.answers.length) errs.push('"answers" must be a non-empty array of accepted answers');
    for (const p of q.patterns || []) {
      try {
        new RegExp(p);
      } catch {
        errs.push(`bad regex pattern ${p}`);
      }
    }
  }
  if (q.type === 'terminal' && !q.prompt) errs.push('terminal questions need a "prompt" like "R1#" or "user@host:~$"');
  if (q.type === 'order' && (!Array.isArray(q.items) || q.items.length < 3 || q.items.length > 8)) errs.push('"items" must have 3-8 entries in the correct order');
  if (q.type === 'order' && Array.isArray(q.items) && new Set(q.items).size !== q.items.length) errs.push('"items" contain duplicates');
  if (q.type === 'gen' && !GENERATORS[q.generator]) errs.push(`unknown generator "${q.generator}"`);
  return errs;
}
