// Shared test helpers: load data, build worlds, drive terminals like a player would.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setCatalog } from '../js/net/catalog.js';
import * as B from '../js/net/builder.js';
import { tOfDate } from '../js/core/util.js';
import '../js/cli/index.js';
import { Terminal } from '../js/cli/engine.js';
import { jumpSession, openConsole } from '../js/cli/linux.js';
import { recompute } from '../js/net/events.js';
import { setFacilities, initFacility, placeDevice } from '../js/game/facility.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
setCatalog(readJson('data/devices.json'));
setFacilities(readJson('data/facilities.json'));

// spec: { year, devs: [[model, role], ...], customers: n, office, isps }
export function buildWorld(spec) {
  const w = { seed: spec.seed || 'test', difficulty: spec.difficulty || 'entry', time: { t: tOfDate(spec.year, 3, 1) }, devices: {}, hosts: {}, links: [], design: B.newDesign(), cash: 100000 };
  if (spec.isps) w.design.isps = spec.isps;
  initFacility(w);
  for (const [m, role] of spec.devs) {
    const d = B.installDevice(w, m, { role });
    if (!placeDevice(w, d)) {
      w.facility.slots++;
      const { addRack } = facilityMod;
      addRack(w);
      placeDevice(w, d);
    }
  }
  if (spec.office) w.design.office.on = true;
  for (let i = 0; i < (spec.customers ?? 2); i++) B.addCustomer(w, { name: ['Acme', 'Blue Fern', 'Cobalt', 'Delta', 'Echo'][i], servers: 2 });
  B.provision(w);
  recompute(w);
  return w;
}
import * as facilityMod from '../js/game/facility.js';

// Run commands through a console session on a device or server; returns the transcript.
export function runOn(w, name, lines) {
  const term = new Terminal(w, null);
  term.push(jumpSession(w, term));
  const s = openConsole(w, term, name, term.top);
  if (!s) throw new Error(`no console for ${name}`);
  term.push(s);
  let out = '';
  const feed = (line) => {
    out += `${term.prompt}${line}\n`;
    let r = term.input(line);
    out += r.text || '';
    let guard = 0;
    while (r.stream && guard++ < 3000) {
      const c = r.stream.next();
      if (!c) break;
      out += c.t || '';
    }
    while (term.pager) out += term.pagerKey(' ').text;
  };
  if (s.dev && ['ios', 'iosxe', 'asa'].includes(s.dev.os) && s.mode === 'user') {
    feed('enable');
    if (term.top?.pending) feed(w.design.vault[s.dev.id]?.enable || '');
  }
  for (const l of lines) {
    feed(l);
    // answer confirmation prompts with defaults
    let n = 0;
    while (term.top?.pending && n++ < 3) feed(/\[yes,no\]|\(yes\/no/.test(term.prompt) ? 'yes' : '');
  }
  return out;
}
export { B };
