// Every fault, on every vendor mix: inject it, prove it breaks something, then type the fix the
// game would hint into the real simulated CLI and prove the network recovers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, runOn } from './helpers.mjs';
import { FAULTS, startFault } from '../js/game/faults.js';
import { recipe } from '../js/game/recipes.js';
import { physAction, tickFacility } from '../js/game/facility.js';
import { tickDevices } from '../js/net/devops.js';
import { checks } from '../js/net/sim.js';
import { recompute } from '../js/net/events.js';
import { rng } from '../js/core/util.js';

const TOPOS = {
  'ios-1995': { year: 1995, devs: [['c2514', 'edge'], ['cat1924', 'access'], ['cat1924', 'oob']], customers: 2 },
  'asa-legacy-2006': { year: 2006, devs: [['c2821', 'edge'], ['asa5510', 'fw'], ['cat3560', 'core'], ['cat2960', 'access'], ['cat2960', 'oob']] },
  'ios-edge-nat-2010': { year: 2010, devs: [['c2911', 'edge'], ['cat3750x', 'core'], ['cat2960', 'access'], ['cat2960', 'oob']] },
  'juniper-2013': { year: 2013, devs: [['mx104', 'edge'], ['srx550', 'fw'], ['ex4200', 'core'], ['ex2200', 'access'], ['ex2200', 'oob']] },
  'mixed-2017': { year: 2017, devs: [['isr4331', 'edge'], ['fg100e', 'fw'], ['n9372', 'core'], ['aruba2930f', 'access'], ['hp2920', 'oob'], ['aruba7030', 'wlc'], ['ap225', 'ap']], office: true },
  'xr-cx-2022': { year: 2022, devs: [['asr9001', 'edge'], ['fpr2110', 'fw'], ['cx8325', 'core'], ['fs248e', 'access'], ['cx6200f', 'oob']] },
  'dual-2022': { year: 2022, isps: ['ispA', 'ispB'], devs: [['mx204', 'edge'], ['c8300', 'edge'], ['fg400f', 'fw'], ['n93180yc', 'core'], ['n93180yc', 'core'], ['cx6300m', 'access'], ['ex3400', 'oob'], ['aruba9004', 'wlc'], ['ap515', 'ap']], office: true },
  'evo-2024': { year: 2024, devs: [['acx7100', 'edge'], ['srx4100', 'fw'], ['qfx5130', 'core'], ['ex4400', 'access'], ['ex3400', 'oob']] },
  'cx-dual-2022': { year: 2022, devs: [['c8300', 'edge'], ['fg200f', 'fw'], ['cx8325', 'core'], ['cx8325', 'core'], ['cx6300m', 'access'], ['cx6200f', 'oob']] },
};
const SKIP = new Set(['firmware-crash']);

for (const [topo, spec] of Object.entries(TOPOS)) {
  test(`${topo}: healthy network passes every monitoring check`, () => {
    const w = buildWorld(spec);
    const bad = checks(w).filter((c) => !c.ok);
    assert.deepEqual(bad.map((c) => `${c.name}: ${c.reason}`), []);
  });
  for (const f of FAULTS) {
    if (SKIP.has(f.id)) continue;
    test(`${topo}: ${f.id} can be diagnosed and fixed through the CLI`, (t) => {
      const probe = buildWorld(spec);
      const n = f.targets(probe).length;
      if (!n) return t.skip('not applicable to this topology');
      for (const pick of [...new Set([0, n - 1])]) {
        const w = buildWorld(spec);
        const before = new Set(checks(w).filter((c) => c.ok).map((c) => c.id));
        const tg = f.targets(w)[pick];
        const rec = f.inject(w, tg, rng(`${topo}:${f.id}`));
        startFault(w, f, rec);
        tickFacility(w, 5);
        assert.equal(f.fixed(w, rec), false, 'fault should be active after injection');
        const steps = recipe(w, f.ops(w, rec));
        const log = [];
        for (const st of steps) {
          if (st.where === 'physical') {
            const op = f.ops(w, rec).find((o) => o.op === 'phys');
            log.push(physAction(w, op.action, op));
            tickFacility(w, 5);
          } else if (st.where === 'server' || st.where === 'device') {
            assert.ok(st.lines, `no recipe for ${st.device} (${st.os})`);
            const lines = st.where === 'server' ? st.lines.slice(1, -1) : st.lines;
            log.push(runOn(w, st.device, lines));
          }
        }
        // devices that had to reboot come back after a few minutes
        w.time.t += 5;
        tickFacility(w, 5);
        tickDevices(w);
        recompute(w);
        assert.equal(f.fixed(w, rec), true, `fault not fixed. Transcript:\n${log.join('\n')}`);
        const broken = checks(w).filter((c) => before.has(c.id) && !c.ok);
        assert.deepEqual(broken.map((c) => `${c.name}: ${c.reason}`), [], `service not restored. Transcript:\n${log.join('\n')}`);
      }
    });
  }
}
