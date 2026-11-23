// Leitner-style spaced repetition.
// Each question id maps to { b: box 0-5, d: due timestamp, s: seen, c: correct, w: wrong }.
// A question you get wrong becomes a "Recurring Bug" until you next answer it correctly; after that
// it keeps climbing the Leitner boxes through normal review.

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

// Delay before the question is due again, indexed by the NEW box after a correct answer.
export const INTERVALS = [0, 10 * MIN, 1 * DAY, 3 * DAY, 7 * DAY, 21 * DAY];
export const WRONG_DELAY = 3 * MIN;
export const MAX_BOX = 5;

export function getEntry(qmap, id) {
  return qmap[id];
}

export function recordAnswer(qmap, id, correct, now = Date.now()) {
  const e = qmap[id] || { b: 0, d: 0, s: 0, c: 0, w: 0 };
  const wasBug = isBug(e);
  e.s += 1;
  if (correct) {
    e.c += 1;
    e.b = Math.min(MAX_BOX, e.b + 1);
    e.d = now + INTERVALS[e.b];
  } else {
    e.w += 1;
    e.b = 0;
    e.d = now + WRONG_DELAY;
  }
  qmap[id] = e;
  return { entry: e, squashed: wasBug && !isBug(e), becameBug: !wasBug && isBug(e) };
}

export function isBug(e) {
  return !!e && e.w > 0 && e.b === 0;
}

export function isDue(e, now = Date.now()) {
  return !!e && e.d <= now;
}

export function isDueBug(e, now = Date.now()) {
  return isBug(e) && isDue(e, now);
}

// Selection weight: unseen and due questions are strongly preferred, mastered ones rarely come up.
export function weight(e, now = Date.now()) {
  if (!e) return 3;
  if (isDueBug(e, now)) return 5;
  if (isDue(e, now)) return 3.5;
  return Math.max(0.15, (MAX_BOX - e.b) * 0.3);
}

// 0..1 mastery across a set of question ids (unseen = 0, box 4+ = fully mastered).
export function mastery(qmap, ids) {
  if (!ids.length) return 0;
  let sum = 0;
  for (const id of ids) {
    const e = qmap[id];
    if (e) sum += Math.min(e.b, 4) / 4;
  }
  return sum / ids.length;
}

export function bugIds(qmap, now = Date.now(), { dueOnly = true } = {}) {
  return Object.keys(qmap).filter((id) => (dueOnly ? isDueBug(qmap[id], now) : isBug(qmap[id])));
}

export function nextBugDue(qmap) {
  let best = Infinity;
  for (const id of Object.keys(qmap)) {
    const e = qmap[id];
    if (isBug(e) && e.d < best) best = e.d;
  }
  return best === Infinity ? null : best;
}
