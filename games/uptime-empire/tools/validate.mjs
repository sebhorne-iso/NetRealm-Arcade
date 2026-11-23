#!/usr/bin/env node
// Validates Uptime Empire's game data: device catalog, facilities, advisories and campaign.
// Usage: node tools/validate.mjs   (exits non-zero on any error; used by `npm run validate` and CI)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);
const read = (rel) => {
  try {
    return JSON.parse(readFileSync(join(root, rel), 'utf8'));
  } catch (e) {
    err(rel, `invalid JSON: ${e.message}`);
    return null;
  }
};
const dev = read('data/devices.json');
const fac = read('data/facilities.json');
const adv = read('data/advisories.json');
const camp = read('data/campaign.json');

const ROLES = new Set(['edge', 'fw', 'core', 'access', 'oob', 'wlc', 'ap']);
const FEATS = new Set(['l2', 'l3', 'stp', 'lacp', 'ospf', 'bgp', 'hsrp', 'vrrp', 'nat', 'fw', 'wlc', 'ap', 'serial']);
const VENDORS = new Set(['Cisco', 'Juniper', 'HP / Aruba', 'Fortinet']);
if (dev) {
  for (const [os, o] of Object.entries(dev.os)) {
    if (!Array.isArray(o.versions) || !o.versions.length) err(`devices.json os.${os}`, 'needs a versions list');
    let last = 0;
    for (const [v, y] of o.versions || []) {
      if (typeof v !== 'string' || !Number.isInteger(y)) err(`devices.json os.${os}`, `bad version entry ${v}/${y}`);
      if (y < last) err(`devices.json os.${os}`, `versions must be in date order (${v})`);
      last = y;
    }
  }
  const ids = new Set();
  for (const m of dev.models) {
    const where = `devices.json model ${m.id}`;
    if (ids.has(m.id)) err(where, 'duplicate id');
    ids.add(m.id);
    if (!dev.os[m.os]) err(where, `unknown os "${m.os}"`);
    if (!VENDORS.has(m.vendor)) err(where, `unknown vendor "${m.vendor}"`);
    for (const r of m.roles || []) if (!ROLES.has(r)) err(where, `unknown role "${r}"`);
    for (const f of m.feat || []) if (!FEATS.has(f)) err(where, `unknown feature "${f}"`);
    for (const k of ['year', 'price', 'u', 'watts', 'psus']) if (typeof m[k] !== 'number') err(where, `"${k}" must be a number`);
    if (m.eos && m.eos < m.year) err(where, 'end-of-sale before release');
    if (m.eol && m.eos && m.eol < m.eos) err(where, 'end-of-life before end-of-sale');
    if (!Array.isArray(m.ports) || !m.ports.length) err(where, 'needs ports');
    const names = new Set();
    for (const g of m.ports || []) {
      const list = g.names || (g.fmt ? Array.from({ length: g.to - g.from + 1 }, (_, k) => g.fmt.replace('{n}', g.from + k)) : []);
      if (!list.length) err(where, 'port group with no ports');
      for (const n of list) {
        if (names.has(n)) err(where, `duplicate port ${n}`);
        names.add(n);
      }
    }
    if (!m.mgmt) err(where, 'needs a "mgmt" port, "inband" or "none"');
    if ((m.roles || []).includes('access') && !(m.feat || []).includes('l2')) err(where, 'access switches need l2');
    if ((m.roles || []).includes('fw') && !(m.feat || []).includes('fw')) err(where, 'firewalls need the fw feature');
  }
  const y0 = 1995;
  for (const role of ['edge', 'access', 'oob']) if (!dev.models.some((m) => m.roles.includes(role) && m.year <= y0)) err('devices.json', `no ${role} model available in ${y0}`);
}
if (fac) {
  for (const k of ['racks', 'pdus', 'ups', 'cooling', 'generators', 'spares']) if (!Array.isArray(fac[k]) || !fac[k].length) err('facilities.json', `"${k}" must be a non-empty list`);
  if (!(fac.floor?.slots >= fac.floor?.startSlots)) err('facilities.json', 'floor.slots must be >= floor.startSlots');
}
if (adv && dev) {
  const ids = new Set();
  for (const a of adv.advisories) {
    const where = `advisories.json ${a.id}`;
    if (ids.has(a.id)) err(where, 'duplicate id');
    ids.add(a.id);
    if (!['crash', 'leak', 'security'].includes(a.effect)) err(where, `unknown effect ${a.effect}`);
    if (!['critical', 'high', 'medium', 'low'].includes(a.severity)) err(where, `unknown severity ${a.severity}`);
    if (a.os === '*') {
      if (!a.fromYear || !a.fixedYear) err(where, 'wildcard advisories need fromYear and fixedYear');
      continue;
    }
    const vs = dev.os[a.os]?.versions.map(([v]) => v);
    if (!vs) err(where, `unknown os ${a.os}`);
    else {
      if (!vs.includes(a.from)) err(where, `"from" ${a.from} is not a known ${a.os} version`);
      if (!vs.includes(a.fixed)) err(where, `"fixed" ${a.fixed} is not a known ${a.os} version`);
      if (vs.indexOf(a.fixed) <= vs.indexOf(a.from)) err(where, 'fixed version must be newer than the first affected version');
    }
  }
}
if (camp && dev) {
  const modelIds = new Set(dev.models.map((m) => m.id));
  camp.chapters.forEach((c, i) => {
    const where = `campaign.json chapter ${i + 1}`;
    if (!c.title || !c.year || !c.story) err(where, 'needs title, year and story');
    if (i && c.year < camp.chapters[i - 1].year) err(where, 'chapters must be in date order');
    for (const [m, r] of c.start || []) {
      if (!modelIds.has(m)) err(where, `unknown start model ${m}`);
      if (!ROLES.has(r)) err(where, `unknown role ${r}`);
    }
    for (const g of c.goals || []) if (!['customers', 'resolved', 'cash', 'role', 'uptime', 'event', 'office', 'patched', 'isps'].includes(g.kind)) err(where, `unknown goal kind ${g.kind}`);
    if (c.event && !camp.events[c.event]) err(where, `unknown event ${c.event}`);
  });
}
warnings.forEach((w) => console.warn(`⚠ ${w}`));
errors.forEach((e) => console.error(`✖ ${e}`));
if (errors.length) {
  console.error(`\nUptime Empire data: ${errors.length} error(s).`);
  process.exit(1);
}
console.log(`✔ Uptime Empire data is valid: ${dev.models.length} device models across ${Object.keys(dev.os).length} operating systems, ${adv.advisories.length} advisories, ${camp.chapters.length} chapters.`);
