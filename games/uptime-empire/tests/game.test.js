// Headless playthroughs: the tycoon loop runs for months, incidents open tickets, the hinted
// fixes resolve them, RCAs score, money flows, and saves round-trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson, runOn } from './helpers.mjs';
import * as G from '../js/game/game.js';
import { FAULT_BY_ID } from '../js/game/faults.js';
import { recipe } from '../js/game/recipes.js';
import { physAction } from '../js/game/facility.js';
import { tOfDate } from '../js/core/util.js';

G.setData({ devices: readJson('data/devices.json'), facilities: readJson('data/facilities.json'), advisories: readJson('data/advisories.json'), campaign: readJson('data/campaign.json') });

function autoFix(w, t) {
  for (const fid of t.faults) {
    const f = w.faults.find((x) => x.id === fid);
    const tpl = FAULT_BY_ID[f.tpl];
    for (const st of recipe(w, tpl.ops(w, f.rec))) {
      if (st.where === 'physical') {
        const op = tpl.ops(w, f.rec).find((o) => o.op === 'phys');
        physAction(w, op.action, op);
      } else if (st.where === 'server') runOn(w, st.device, st.lines.slice(1, -1));
      else if (st.where === 'device' && st.lines) runOn(w, st.device, st.lines);
      else if (st.where === 'change') {
        const dev = w.devices[f.rec.dev];
        const v = G.firmwareOptions(w, dev).pop();
        if (v) {
          G.scheduleFirmware(w, dev.id, v);
          G.runChange(w, w.changes[w.changes.length - 1].id, { now: true });
        }
      }
    }
  }
}

for (const difficulty of ['entry', 'associate', 'professional', 'expert']) {
  test(`campaign chapter 1 runs for four months on ${difficulty}`, () => {
    const w = G.newGame({ mode: 'campaign', difficulty, chapter: 0, seed: `t-${difficulty}` });
    w.time.speed = 4;
    let resolved = 0;
    const end = w.time.t + 120 * 1440;
    for (let i = 0; i < 4000 && w.time.t < end && !w.gameOver; i++) {
      G.tick(w, 1);
      for (const t of w.tickets.filter((x) => x.status === 'open' && x.kind === 'fault')) {
        autoFix(w, t);
        for (let k = 0; k < 4; k++) G.tick(w, 30);
        const r = G.tryResolve(w, t.id);
        assert.ok(r.ok, `${t.id} (${t.faults.map((f) => w.faults.find((x) => x.id === f).tpl)}) not resolvable: ${r.msg}`);
        const truth = G.rcaTruth(w, t)[0];
        const s = G.submitRca(w, t.id, { dev: truth.dev, cat: truth.cat, summary: truth.keys.join(' ') });
        assert.ok(s.score >= 85, `RCA scored ${s.score}`);
        resolved++;
      }
      for (const l of [...w.leads]) G.acceptLead(w, l.id);
      for (const t of w.tickets.filter((x) => x.status === 'open' && x.kind !== 'fault')) {
        const r = G.tryResolve(w, t.id);
        if (r.ok) G.submitRca(w, t.id, { dev: null, cat: 'change', summary: 'change' });
      }
    }
    assert.ok(w.history.length >= 3, 'months were booked');
    assert.ok(resolved >= 2, `expected some incidents, got ${resolved}`);
    assert.ok(w.design.customers.length >= 2, 'leads were signed');
    const txt = G.serialize(w);
    const w2 = G.deserialize(txt);
    assert.equal(Object.keys(w2.devices).length, Object.keys(w.devices).length);
  });
}

test('every campaign chapter can start', () => {
  const chs = readJson('data/campaign.json').chapters;
  chs.forEach((ch, i) => {
    const w = G.newGame({ mode: 'campaign', difficulty: 'associate', chapter: i, seed: `ch${i}` });
    assert.ok(Object.keys(w.devices).length >= 3, ch.title);
    assert.ok(G.goals(w).length >= 2);
  });
});

test('set pieces: slammer is blocked by an ACL on the edge', () => {
  const w = G.newGame({ mode: 'campaign', difficulty: 'associate', chapter: 2, seed: 'worm' });
  w.time.t = w.clock.step = tOfDate(2003, 1, 24, 23, 0);
  w.clock.hour = Math.floor(w.time.t / 60);
  w.clock.day = Math.floor(w.time.t / 1440);
  w.campaign.startT -= 60 * 1440;
  for (let i = 0; i < 400 && !w.worm; i++) G.tick(w, 1);
  assert.ok(w.worm, 'worm started');
  const edge = Object.values(w.devices).find((d) => d.role === 'edge');
  const out = Object.keys(edge.cfg.ifs).find((n) => /transit/.test(edge.cfg.ifs[n].desc));
  runOn(w, edge.hostname, ['configure terminal', 'ip access-list extended BLOCK-WORM', 'deny udp any any eq 1434', 'permit ip any any', 'exit', `interface ${out}`, 'ip access-group BLOCK-WORM in', 'end']);
  G.tick(w, 61);
  assert.equal(w.worm.blocked, true);
});
