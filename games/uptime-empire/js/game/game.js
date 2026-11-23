// The tycoon: clock, difficulty, economy, customers and leads, incidents/tickets/SLA/RCA,
// changes and maintenance windows, firmware advisories, campaign chapters and set pieces, saves.
import { setCatalog, model, models, nextVersions } from '../net/catalog.js';
import * as B from '../net/builder.js';
import { recompute, periodic, logEvent } from '../net/events.js';
import { checks, utilisation } from '../net/sim.js';
import { tickDevices, reload } from '../net/devops.js';
import { setFacilities, facilities, initFacility, addRack, placeDevice, tickFacility, rackLoad, heatKw, coolingKw } from './facility.js';
import { FAULTS, FAULT_BY_ID, injectRandom, startFault, CATS } from './faults.js';
import { recipe } from './recipes.js';
import { getDialect } from '../cli/registry.js';
import { Session } from '../cli/engine.js';
import { rng, tOfDate, yearOf, dateOf, hashStr, clamp } from '../core/util.js';

export const SAVE_KEY = 'arcade.uptime-empire.v1';
let DATA = null;
export function setData(d) {
  DATA = d;
  setCatalog(d.devices);
  setFacilities(d.facilities);
}
export const data = () => DATA;

export const DIFF = {
  entry: { label: 'Entry level', maxTier: 1, everyDays: 9, slaMin: 30, pauseInTerminal: true, hints: 99, hintCost: 0, showRecipe: true, loans: true, bankrupt: false, unauthorized: false, compound: 0, herrings: 0, ticketDetail: 0, faultCap: 1 },
  associate: { label: 'Associate', maxTier: 2, everyDays: 8, slaMin: 20, pauseInTerminal: false, hints: 99, hintCost: 1, showRecipe: true, loans: true, bankrupt: false, unauthorized: false, compound: 0, herrings: 0.2, ticketDetail: 1, faultCap: 1 },
  professional: { label: 'Professional', maxTier: 3, everyDays: 7, slaMin: 12, pauseInTerminal: false, hints: 2, hintCost: 3, showRecipe: false, loans: false, bankrupt: true, unauthorized: true, compound: 0.12, herrings: 0.5, ticketDetail: 2, faultCap: 2 },
  expert: { label: 'Expert', maxTier: 4, everyDays: 6, slaMin: 8, pauseInTerminal: false, hints: 0, hintCost: 0, showRecipe: false, loans: false, bankrupt: true, unauthorized: true, compound: 0.25, herrings: 1, ticketDetail: 3, faultCap: 2 },
};
export const SPEEDS = [0, 20, 60, 240, 720]; // game minutes per real second
export const TIERS = {
  basic: { label: 'Basic', sla: 99.0, base: 900 },
  standard: { label: 'Standard', sla: 99.5, base: 1700 },
  premium: { label: 'Premium', sla: 99.9, base: 3200 },
  enterprise: { label: 'Enterprise', sla: 99.99, base: 6000, redundancy: true },
};
const NAMES_A = ['Acme', 'Blue Fern', 'Cobalt', 'Delta', 'Ember', 'Falcon', 'Granite', 'Harbor', 'Iris', 'Kestrel', 'Lumen', 'Maple', 'Nimbus', 'Orbit', 'Pixel', 'Quartz', 'Riverbend', 'Summit', 'Tundra', 'Umbra', 'Velvet', 'Willow', 'Xenon', 'Yonder', 'Zephyr', 'Copperleaf', 'Northwind', 'Redwood', 'Silverline', 'Bright Owl'];
const NAMES_B = { 1995: ['Widgets', 'Web Design', 'Travel', 'Records', 'Bookshop', 'Florists'], 2003: ['Media', 'Hosting', 'Analytics', 'Games', 'Legal', 'Logistics'], 2012: ['Labs', 'Cloud', 'Health', 'Studios', 'Fintech', 'Apps'], 2020: ['AI', 'Robotics', 'Bio', 'Streaming', 'Security', 'Data'] };
const eraNames = (y) => Object.entries(NAMES_B).filter(([k]) => Number(k) <= y).flatMap(([, v]) => v);
const eraFactor = (y) => Math.max(0.4, 1 - (y - 1995) * 0.022);
const byYear = (tbl, y) => {
  const ks = Object.keys(tbl).map(Number).sort((a, b) => a - b);
  let v = tbl[ks[0]];
  for (const k of ks) if (k <= y) v = tbl[k];
  return v;
};

// =============================================================================================
// New game
export function starterKit(year) {
  const pick = (role, l2) => models().filter((m) => m.roles.includes(role) && m.year <= year && (!l2 || m.feat.includes('l2')) && m.year >= year - 9).sort((a, b) => a.price - b.price)[0] || models().filter((m) => m.roles.includes(role) && m.year <= year).sort((a, b) => b.year - a.year)[0];
  return [[pick('edge').id, 'edge'], [pick('access', true).id, 'access'], [pick('oob', true).id, 'oob']];
}
export function newGame({ mode = 'campaign', difficulty = 'entry', company = 'Uptime Empire Ltd', chapter = 0, year = 1995, cash = null, seed = null }) {
  const ch = mode === 'campaign' ? DATA.campaign.chapters[chapter] : null;
  const y = ch ? ch.year : year;
  const w = {
    v: 1,
    seed: seed || `ue${Date.now().toString(36)}`,
    mode,
    difficulty,
    company,
    time: { t: tOfDate(y, 1, 2, 9, 0), speed: 1, paused: false },
    devices: {},
    hosts: {},
    links: [],
    design: B.newDesign(),
    cash: cash ?? (ch ? ch.cash : 60000),
    rep: 60,
    loans: [],
    ledger: [],
    month: { revenue: 0, credits: 0, costs: {} },
    history: [],
    tickets: [],
    faults: [],
    changes: [],
    leads: [],
    backups: {},
    stats: { resolved: 0, breaches: 0, incidents: 0, hints: 0, rcaTotal: 0, rcaCount: 0, downMins: 0, totalMins: 0 },
    clock: null,
    toasts: [],
    campaign: ch ? { chapter, startT: 0, resolved0: 0, down: 0, total: 0, events: {}, done: false } : null,
    nextId: 1,
  };
  initFacility(w);
  const kit = ch?.start || starterKit(y);
  for (const [m, role] of kit) installAndPlace(w, m, role);
  const nCust = ch?.customers ?? 1;
  for (let i = 0; i < nCust; i++) addCust(w, makeLead(w, rng(`${w.seed}:c${i}`), 'basic'));
  for (const c of w.design.customers) c.pending = false;
  B.provision(w);
  recompute(w);
  w.clock = { step: Math.floor(w.time.t), hour: Math.floor(w.time.t / 60), day: Math.floor(w.time.t / 1440) };
  if (w.campaign) w.campaign.startT = w.time.t;
  nightlyBackups(w);
  refreshAdvisories(w);
  toast(w, `Welcome to ${company}. ${ch ? ch.story : 'Sandbox mode: build what you like.'}`, 'story');
  return w;
}
function installAndPlace(w, modelId, role) {
  const d = B.installDevice(w, modelId, { role });
  if (!placeDevice(w, d)) {
    if (w.facility.racks.length >= w.facility.slots) w.facility.slots++;
    addRack(w);
    placeDevice(w, d);
  }
  return d;
}

// =============================================================================================
// Money
export function money(w, amount, kind, note) {
  w.cash += amount;
  w.ledger.push({ t: w.time.t, kind, amount: Math.round(amount), note });
  if (w.ledger.length > 400) w.ledger.splice(0, w.ledger.length - 400);
  if (amount < 0) w.month.costs[kind] = (w.month.costs[kind] || 0) - amount;
}
export function monthlyCosts(w) {
  const y = yearOf(w.time.t);
  const F = facilities();
  const kw = heatKw(w);
  return {
    staff: byYear(F.staffMonth, y),
    transit: w.design.isps.length * byYear(F.ispFeeMonth, y),
    rent: w.facility.racks.length * F.rentPerRackMonth,
    power: Math.round(kw * 730 * F.power.pricePerKwh * F.power.pue),
    loans: w.loans.reduce((s, l) => s + l.monthly, 0),
  };
}
export const monthlyRevenue = (w) => w.design.customers.filter((c) => !c.pending).reduce((s, c) => s + c.fee, 0);

function monthEnd(w) {
  const rev = monthlyRevenue(w);
  const credits = Math.round(w.month.credits);
  money(w, rev, 'revenue', `Hosting fees (${w.design.customers.filter((c) => !c.pending).length} customers)`);
  if (credits) money(w, -credits, 'credits', 'SLA service credits');
  const costs = monthlyCosts(w);
  for (const [k, v] of Object.entries(costs)) if (v) money(w, -v, k, { staff: 'Salaries', transit: 'IP transit', rent: 'Rack space & building', power: 'Electricity', loans: 'Loan repayments' }[k]);
  for (const l of w.loans) l.left -= 1;
  w.loans = w.loans.filter((l) => l.left > 0);
  w.history.push({ t: w.time.t, revenue: rev, credits, costs: Object.values(costs).reduce((a, b) => a + b, 0), cash: Math.round(w.cash), customers: w.design.customers.length, uptime: w.stats.monthTotal ? 100 - (100 * w.stats.monthDown) / w.stats.monthTotal : 100 });
  if (w.history.length > 360) w.history.shift();
  for (const c of w.design.customers) {
    const up = c.mTotal ? 100 - (100 * c.mDown) / c.mTotal : 100;
    c.lastUptime = up;
    if (up < c.sla) {
      c.sat = clamp(c.sat - 12, 0, 100);
      toast(w, `${c.name} missed its ${c.sla}% SLA (${up.toFixed(2)}%).`, 'bad');
    } else c.sat = clamp(c.sat + 3, 0, 100);
    c.mDown = 0;
    c.mTotal = 0;
  }
  w.stats.monthDown = 0;
  w.stats.monthTotal = 0;
  w.month = { revenue: 0, credits: 0, costs: {} };
  const D = DIFF[w.difficulty];
  if (w.cash < 0) {
    if (D.loans) offerLoan(w, Math.ceil(-w.cash / 10000) * 10000 + 20000, true);
    else {
      w.debtMonths = (w.debtMonths || 0) + 1;
      if (w.debtMonths >= 2) {
        w.gameOver = { reason: 'Bankrupt: two months in the red. The bank has called in the receivers.' };
        toast(w, w.gameOver.reason, 'bad');
      } else toast(w, 'Your account is overdrawn. One more month in the red and the company goes under.', 'bad');
    }
  } else w.debtMonths = 0;
}
export function offerLoan(w, amount, auto = false) {
  const months = 24;
  const monthly = Math.round((amount * 1.12) / months);
  w.loans.push({ amount, monthly, left: months, t: w.time.t });
  money(w, amount, 'loan', `Bank loan (${months} months)`);
  toast(w, `${auto ? 'Overdrawn - the bank extended' : 'Took'} a $${amount.toLocaleString()} loan: $${monthly.toLocaleString()}/month for ${months} months.`, auto ? 'bad' : 'info');
}

// =============================================================================================
// Customers & leads
function makeLead(w, R, forceTier = null) {
  const y = yearOf(w.time.t);
  const used = new Set(w.design.customers.map((c) => c.name));
  let name;
  for (let k = 0; k < 20; k++) {
    name = `${R.pick(NAMES_A)} ${R.pick(eraNames(y))}`;
    if (!used.has(name)) break;
  }
  const redundant = w.design.roles.core.length >= 2;
  const tier = forceTier || R.weighted(Object.keys(TIERS), (t) => ({ basic: 4, standard: 4, premium: y > 2000 ? 2 : 0.5, enterprise: redundant ? 1.5 : 0 })[t]);
  const servers = R.int(1, tier === 'enterprise' ? 4 : 3);
  const fee = Math.round((TIERS[tier].base * eraFactor(y) * (0.8 + servers * 0.25)) / 10) * 10;
  return { id: `L${w.nextId++}`, name, tier, servers, web: R.chance(0.85), sla: TIERS[tier].sla, fee, expires: w.time.t + 14 * 1440, mbps: Math.round(R.int(2, 10) * (1 + (y - 1995) * 0.3)) };
}
function addCust(w, lead) {
  const c = B.addCustomer(w, { name: lead.name, servers: lead.servers, web: lead.web, sla: lead.sla, tier: lead.tier });
  Object.assign(c, { fee: lead.fee, sat: 70, joined: w.time.t, pending: true, mDown: 0, mTotal: 0, mbps: lead.mbps });
  return c;
}
export function acceptLead(w, id) {
  const lead = w.leads.find((l) => l.id === id);
  if (!lead) return 'That lead has gone.';
  const pendingServers = w.design.customers.filter((c) => c.pending).reduce((n, c) => n + c.servers.length, 0);
  if (B.accessCapacity(w) - pendingServers < lead.servers) return `Not enough free access switch ports for ${lead.servers} servers. Buy another access switch first.`;
  if (TIERS[lead.tier].redundancy && w.design.roles.core.length < 2) return 'Enterprise customers require a redundant core pair.';
  w.leads = w.leads.filter((l) => l !== lead);
  const c = addCust(w, lead);
  queueChange(w, { kind: 'provision', title: `Onboard ${c.name} (VLAN ${c.vlan}, ${c.servers.length} server${c.servers.length > 1 ? 's' : ''})` });
  toast(w, `Signed ${c.name} at $${c.fee.toLocaleString()}/month. Onboarding is queued for the next maintenance window (Changes).`, 'good');
  return null;
}
export const declineLead = (w, id) => (w.leads = w.leads.filter((l) => l.id !== id));

// =============================================================================================
// Changes (maintenance windows at 02:00 every night)
export function queueChange(w, ch) {
  const c = { id: `CHG${w.nextId++}`, status: 'queued', created: w.time.t, ...ch };
  w.changes.push(c);
  return c;
}
export function runChange(w, id, { now = false } = {}) {
  const c = w.changes.find((x) => x.id === id);
  if (!c || c.status !== 'queued') return 'Nothing to run.';
  const incident = openIncidents(w).length;
  if (now && incident && c.kind !== 'firmware') return 'Change freeze: resolve the open incident first.';
  const D = DIFF[w.difficulty];
  const hour = dateOf(w.time.t).getUTCHours();
  if (now && D.unauthorized && !(hour >= 0 && hour < 6)) {
    w.rep = clamp(w.rep - 2, 0, 100);
    toast(w, 'Change executed outside the maintenance window (00:00-06:00): -2 reputation.', 'bad');
  }
  try {
    if (c.kind === 'provision') {
      for (const cu of w.design.customers) cu.pending = false;
      const warn = B.provision(w);
      c.result = warn.length ? warn.join(' ') : 'Configurations rendered from the source of truth and pushed to every device.';
    } else if (c.kind === 'firmware') {
      const dev = w.devices[c.dev];
      reload(w, dev, { reason: `Image upgrade to ${c.version}`, version: c.version });
      refreshAdvisories(w);
      c.result = `${dev.hostname} upgraded to ${c.version} and reloading.`;
    } else if (c.kind === 'decom') {
      const dev = w.devices[c.dev];
      B.removeDevice(w, c.dev);
      money(w, Math.round(model(dev.model).price * 0.15), 'sales', `Sold ${dev.hostname} for scrap`);
      B.provision(w);
      c.result = `${dev.hostname} removed.`;
    }
    c.status = 'done';
    c.ran = w.time.t;
    w.dirty = true;
    recompute(w);
    w.graceUntil = w.time.t + 15;
  } catch (e) {
    console.error(e);
    c.status = 'failed';
    c.result = e.message;
  }
  return null;
}
export const cancelChange = (w, id) => (w.changes = w.changes.filter((c) => c.id !== id || c.status !== 'queued'));

// =============================================================================================
// Shop
export const ROLE_LIMIT = { edge: 2, fw: 2, core: 2, access: 40, oob: 1, wlc: 1, ap: 12 };
export function shopModels(w, role) {
  const y = yearOf(w.time.t);
  return models().filter((m) => m.roles.includes(role) && m.year <= y && (m.eos == null || m.eos >= y)).sort((a, b) => a.year - b.year || a.price - b.price);
}
export function buyDevice(w, modelId, role) {
  const m = model(modelId);
  const price = Math.round(m.price * eraPrice(w, m));
  if (w.cash < price) return `Not enough cash ($${price.toLocaleString()}).`;
  if ((w.design.roles[role] || []).length >= ROLE_LIMIT[role]) return `You already have the maximum number of ${role} devices.`;
  if (role === 'fw' && !w.design.roles.core.length) return 'Install a Layer 3 core switch first: the firewall sits between the edge and the core.';
  if ((role === 'wlc' || role === 'ap') && !w.design.office.on) return 'Open the office floor first (Shop > Facilities).';
  const d = B.installDevice(w, modelId, { role });
  if (!placeDevice(w, d)) {
    B.removeDevice(w, d.id);
    return 'No rack has the space or power for it. Buy a rack (Shop > Facilities).';
  }
  money(w, -price, 'capex', `${m.name} (${role})`);
  queueChange(w, { kind: 'provision', title: `Integrate ${d.hostname} (${m.name}) as ${role}` });
  toast(w, `${m.name} racked in ${d.rack} U${d.u}. Integration is queued (Changes).`, 'good');
  return null;
}
const eraPrice = (w, m) => Math.max(0.35, 1 - Math.max(0, yearOf(w.time.t) - m.year) * 0.06);
export const devicePrice = (w, m) => Math.round(m.price * eraPrice(w, m));
export function buyFacility(w, kind, id, arg) {
  const F = facilities();
  const it = kind === 'slot' ? { price: F.floor.slotPrice, name: 'Floor space' } : kind === 'spare' ? F.spares.find((s) => s.id === id) : F[{ rack: 'racks', pdu: 'pdus', ups: 'ups', cooling: 'cooling', generator: 'generators' }[kind]].find((x) => x.id === id);
  const price = it.price * (kind === 'spare' ? arg || 1 : 1);
  if (w.cash < price) return `Not enough cash ($${price.toLocaleString()}).`;
  const f = w.facility;
  if (kind === 'slot') {
    if (f.slots >= F.floor.slots) return 'The building is full.';
    f.slots++;
  } else if (kind === 'rack') {
    if (!addRack(w)) return 'No free floor slot. Buy more floor space first.';
  } else if (kind === 'pdu') f.racks.find((r) => r.id === arg).pdu = id;
  else if (kind === 'ups') f.ups = [{ uid: `U${w.nextId++}`, id, health: 1, charge: 1 }];
  else if (kind === 'cooling') f.cooling.push({ uid: `K${w.nextId++}`, id, ok: true });
  else if (kind === 'generator') f.generator = { id, fuel: F.generators.find((g) => g.id === id).hours, ok: true };
  else if (kind === 'spare') w.spares[id] = (w.spares[id] || 0) + (arg || 1);
  money(w, -price, 'capex', it.name);
  return null;
}
export function addIsp(w) {
  if (w.design.isps.length >= 2) return 'Two ISPs is the maximum.';
  const edges = w.design.roles.edge.map((id) => w.devices[id]);
  if (!edges.every((e) => model(e.model).feat.includes('bgp'))) return 'Your edge routers must support BGP.';
  if (w.design.roles.edge.length < 2 && !w.design.roles.core.length) return 'Dual-homing needs a Layer 3 core.';
  w.design.isps = ['ispA', 'ispB'];
  w.design.bgp = true;
  queueChange(w, { kind: 'provision', title: 'Bring up BGP to the second ISP (AS64512)' });
  toast(w, 'Contract signed with Meridian Fibre. BGP turn-up is queued (Changes).', 'good');
  return null;
}
export function openOffice(w) {
  if (w.design.office.on) return 'The office is already open.';
  if (!w.design.roles.core.length) return 'The office network needs a Layer 3 core switch.';
  const cost = 15000;
  if (w.cash < cost) return 'Not enough cash ($15,000).';
  money(w, -cost, 'capex', 'Office fit-out');
  w.design.office.on = true;
  queueChange(w, { kind: 'provision', title: 'Office VLANs 30-32 and staff Wi-Fi' });
  return null;
}
export function scheduleFirmware(w, devId, version) {
  const dev = w.devices[devId];
  queueChange(w, { kind: 'firmware', dev: devId, version, title: `Upgrade ${dev.hostname} ${dev.version} -> ${version} (reload)` });
}
export const firmwareOptions = (w, dev) => nextVersions(dev.os, dev.version, yearOf(w.time.t), model(dev.model));
export const scheduleDecom = (w, devId) => queueChange(w, { kind: 'decom', dev: devId, title: `Decommission ${w.devices[devId].hostname}` });

// =============================================================================================
// Advisories
function verIdx(os, v) {
  const list = DATA.devices.os[os]?.versions || [];
  const plain = String(v).replace(/^[A-Z]+\./, '');
  return list.findIndex(([x]) => x === plain);
}
function verYear(os, v) {
  const list = DATA.devices.os[os]?.versions || [];
  const plain = String(v).replace(/^[A-Z]+\./, '');
  return list.find(([x]) => x === plain)?.[1] ?? 0;
}
export function advisoryDate(a) {
  if (a.id === 'UE-EVENT-2014-HB') return tOfDate(2014, 4, 8);
  const h = hashStr(a.id);
  return tOfDate(a.year, 1 + (h % 11), 1 + (h % 27));
}
export function refreshAdvisories(w) {
  const pub = DATA.advisories.advisories.filter((a) => advisoryDate(a) <= w.time.t);
  w.advisoryHits = {};
  for (const dev of Object.values(w.devices)) {
    const hits = [];
    for (const a of pub) {
      const nowY = yearOf(w.time.t);
      if (a.os === '*') {
        const y = verYear(dev.os, dev.version);
        const fixAvail = (DATA.devices.os[dev.os]?.versions || []).some(([, vy]) => vy >= a.fixedYear && vy <= nowY);
        if (y >= a.fromYear && y < a.fixedYear && !['apos', 'fortiap'].includes(dev.os)) hits.push({ ...a, fixAvail });
      } else if (a.os === dev.os) {
        const i = verIdx(dev.os, dev.version);
        if (i >= 0 && i >= verIdx(a.os, a.from) && i < verIdx(a.os, a.fixed)) hits.push({ ...a, fixAvail: verYear(a.os, a.fixed) <= nowY });
      }
    }
    if (hits.length) w.advisoryHits[dev.id] = hits;
  }
  const known = new Set(w.knownAdvisories || []);
  for (const a of pub) if (!known.has(a.id)) {
    known.add(a.id);
    const n = Object.values(w.advisoryHits).filter((h) => h.some((x) => x.id === a.id)).length;
    if (n && w.clock) toast(w, `New ${a.severity} advisory ${a.id}: ${a.title} - affects ${n} of your devices (Docs > Patch calendar).`, a.severity === 'critical' ? 'bad' : 'info');
  }
  w.knownAdvisories = [...known];
}

// =============================================================================================
// Incidents, tickets, SLA, RCA
export const openIncidents = (w) => w.tickets.filter((t) => t.status === 'open' && t.sev <= 2);
export function toast(w, text, kind = 'info') {
  w.toasts.push({ id: w.nextId++, t: w.time.t, text, kind });
  if (w.toasts.length > 60) w.toasts.splice(0, w.toasts.length - 60);
}
function sevFor(w, impact, f) {
  if (f && f.service === false) return f.sev || 3;
  const custs = new Set(impact.map((id) => checksIndex(w)[id]?.cust).filter(Boolean));
  const premium = [...custs].some((c) => ['premium', 'enterprise'].includes(w.design.customers.find((x) => x.id === c)?.tier));
  if (impact.length === 0) return 3;
  if (custs.size > 1 || premium || impact.some((id) => id.startsWith('mgmt:'))) return custs.size > 1 || premium ? 1 : 2;
  return 2;
}
let ckCache = null;
function checksIndex(w) {
  if (!ckCache || ckCache.t !== w.time.t) ckCache = { t: w.time.t, map: Object.fromEntries(checks(w).map((c) => [c.id, c])) };
  return ckCache.map;
}
export function injectFault(w, R, opts = {}) {
  const D = DIFF[w.difficulty];
  recompute(w);
  const before = new Set(checks(w).filter((c) => c.ok).map((c) => c.id));
  const faults = [];
  const f1 = injectRandom(w, R, { maxTier: opts.maxTier || D.maxTier, only: opts.only || null });
  if (!f1) return null;
  faults.push(f1);
  if (!opts.only && R.chance(D.compound)) {
    const f2 = injectRandom(w, R, { maxTier: Math.min(D.maxTier, 3) });
    if (f2) faults.push(f2);
  }
  recompute(w);
  ckCache = null;
  const after = checks(w);
  const impact = after.filter((c) => (!c.ok || c.degraded) && before.has(c.id)).map((c) => c.id);
  for (const f of faults) f.impact = impact;
  const main = FAULT_BY_ID[f1.tpl];
  const tk = main.ticket(w, f1.rec);
  const detail = D.ticketDetail;
  const t = openTicket(w, { title: tk.title, text: tk.text[Math.min(detail, tk.text.length - 1)], cust: f1.rec.cust || null, sev: sevFor(w, impact, main), faults: faults.map((f) => f.id), impact });
  w.stats.incidents++;
  return t;
}
export function openTicket(w, { title, text, cust = null, sev = 2, faults = [], impact = [], kind = 'fault', event = null }) {
  const D = DIFF[w.difficulty];
  const t = { id: `INC${String(w.nextId++).padStart(4, '0')}`, t: w.time.t, title, text, cust, sev, faults, impact, kind, event, status: 'open', slaTotal: sev <= 2 ? D.slaMin * 60 : null, slaUsed: 0, due: sev >= 3 ? w.time.t + (sev === 3 ? 3 : 7) * 1440 : null, hints: 0, breached: false, notes: [] };
  w.tickets.unshift(t);
  if (w.tickets.length > 200) w.tickets.pop();
  toast(w, `${t.id} P${sev}: ${title}`, sev <= 2 ? 'incident' : 'info');
  return t;
}
export function hint(w, id) {
  const t = w.tickets.find((x) => x.id === id);
  const D = DIFF[w.difficulty];
  if (!t) return null;
  const all = ticketHints(w, t);
  if (t.hints >= Math.min(D.hints, all.length)) return { done: true, text: D.hints === 0 ? 'Expert mode: no hints. Use your tools.' : 'No more hints at this difficulty.' };
  const h = all[t.hints++];
  w.stats.hints++;
  if (D.hintCost) w.rep = clamp(w.rep - D.hintCost, 0, 100);
  return h;
}
export function ticketHints(w, t) {
  const D = DIFF[w.difficulty];
  if (t.kind === 'unplanned') return [{ text: 'Nothing broke by itself: look at the most recent configuration changes (Docs > Config backups shows a diff against last night).' }, { text: `Affected checks: ${t.impact.join(', ')}.` }];
  if (t.kind === 'event') return (t.eventHints || []).map((x) => ({ text: x }));
  const out = [];
  for (const fid of t.faults) {
    const f = w.faults.find((x) => x.id === fid);
    if (!f) continue;
    const tpl = FAULT_BY_ID[f.tpl];
    tpl.hints(w, f.rec).forEach((x) => out.push({ text: x }));
    if (D.showRecipe) out.push({ text: 'Exact fix:', recipe: recipe(w, tpl.ops(w, f.rec)) });
  }
  return out;
}
// Player says "fixed": verify the fault(s) and service
export function tryResolve(w, id) {
  const t = w.tickets.find((x) => x.id === id);
  if (!t || t.status !== 'open') return { ok: false, msg: 'Ticket is not open.' };
  recompute(w);
  ckCache = null;
  const idx = checksIndex(w);
  const stillDown = t.impact.filter((c) => idx[c] && (!idx[c].ok || idx[c].degraded));
  const faults = t.faults.map((fid) => w.faults.find((f) => f.id === fid)).filter(Boolean);
  const unfixed = faults.filter((f) => !FAULT_BY_ID[f.tpl].fixed(w, f.rec));
  if (ticketFixed(w, t) === false) return { ok: false, msg: 'Not yet: the underlying problem is still there.' };
  if (unfixed.length || stillDown.length) {
    t.notes.push({ t: w.time.t, text: 'Customer confirms the issue persists.' });
    w.rep = clamp(w.rep - 1, 0, 100);
    return { ok: false, msg: stillDown.length ? `Not yet: monitoring still fails (${stillDown.map((c) => idx[c].name).slice(0, 3).join('; ')}).` : 'Service looks fine, but the customer reports the original symptom again. Something is still not right - did you fix the root cause, or work around it?' };
  }
  for (const f of faults) {
    f.active = false;
    f.fixedAt = w.time.t;
  }
  t.status = 'rca';
  t.fixedAt = w.time.t;
  return { ok: true, msg: 'Service restored and confirmed by the customer. Now write the root-cause analysis.' };
}
export function rcaTruth(w, t) {
  if (t.kind === 'unplanned') return [{ dev: t.suspect || null, cat: 'change', keys: ['change', 'config', 'mistake', 'human', 'typo'] }];
  if (t.kind === 'event') return [{ dev: null, cat: t.rcaCat || 'software', keys: t.rcaKeys || [] }];
  return t.faults.map((fid) => w.faults.find((f) => f.id === fid)).filter(Boolean).map((f) => FAULT_BY_ID[f.tpl].rca(w, f.rec));
}
export function submitRca(w, id, { dev, cat, summary = '', prevention = '' }) {
  const t = w.tickets.find((x) => x.id === id);
  if (!t || t.status !== 'rca') return null;
  const truth = rcaTruth(w, t);
  const text = `${summary} ${prevention}`.toLowerCase();
  // Compound incidents: credit the best-matching root cause for device/category, words across all
  const parts = truth.map((tr) => {
    const devOk = !tr.dev || dev === tr.dev;
    const catOk = cat === tr.cat;
    return { dev: devOk ? 35 : 0, cat: catOk ? 35 : 0, truth: tr };
  });
  const best = parts.reduce((a, b) => (b.dev + b.cat > a.dev + a.cat ? b : a));
  const keys = [...new Set(truth.flatMap((tr) => tr.keys).filter(Boolean).map((k) => String(k).toLowerCase()))];
  const hits = keys.filter((k) => text.includes(k)).length;
  const words = hits >= Math.min(2 * truth.length, 4) ? 30 : hits >= 1 ? 15 : 0;
  parts.forEach((p) => (p.words = words));
  const score = best.dev + best.cat + words;
  const bonus = Math.round(score * 12 * (1 + Object.keys(DIFF).indexOf(w.difficulty) * 0.5));
  t.status = 'closed';
  t.rca = { dev, cat, summary, prevention, score, parts, closedAt: w.time.t };
  w.stats.resolved++;
  w.stats.rcaTotal += score;
  w.stats.rcaCount++;
  w.rep = clamp(w.rep + Math.round(score / 25) + (t.breached ? 0 : 1), 0, 100);
  if (bonus > 0) money(w, bonus, 'bonus', `Incident review bonus ${t.id} (RCA ${score}/100)`);
  return { score, parts, bonus, truth };
}

// =============================================================================================
// Set pieces
const EVT = {
  slammer: {
    start(w) {
      w.worm = { blocked: false, start: w.time.t };
      return openTicket(w, { title: 'Internet links saturated (UDP 1434 flood)', text: DATA.campaign.events.slammer.text, sev: 1, kind: 'event', event: 'slammer' });
    },
    hints: ['Look at interface rates on the ISP links: inbound is pinned at line rate.', 'The worm uses UDP port 1434 (MS SQL Server Resolution Service).', 'IOS: ip access-list extended BLOCK-WORM / deny udp any any eq 1434 / permit ip any any, then ip access-group BLOCK-WORM in on the ISP-facing interface. ASA: access-list OUTSIDE_IN extended deny udp any any eq 1434.'],
    cleared: (w) => !w.worm || w.worm.blocked,
    rca: { cat: 'security', keys: ['worm', '1434', 'udp', 'acl', 'slammer', 'filter'] },
  },
  leapsecond: {
    start(w) {
      for (const c of w.design.customers) for (const hid of c.servers) if (w.hosts[hid]) w.hosts[hid].cpuHog = true;
      w.dirty = true;
      return openTicket(w, { title: 'Customer servers at 100% CPU', text: DATA.campaign.events.leapsecond.text, sev: 1, kind: 'event', event: 'leapsecond' });
    },
    hints: ['The network is fine: ping the servers and look at the latency.', 'console <server> then top: everything spinning in user space since 00:00:00.', 'Kernel bug after the leap second: date -s "$(date)" on every affected server.'],
    cleared: (w) => !Object.values(w.hosts).some((h) => h.cpuHog),
    rca: { cat: 'software', keys: ['leap second', 'leap', 'kernel', 'futex', 'date', 'cpu'] },
  },
  heartbleed: {
    start(w) {
      refreshAdvisories(w);
      return openTicket(w, { title: 'Heartbleed: patch every affected device', text: DATA.campaign.events.heartbleed.text, sev: 3, kind: 'event', event: 'heartbleed' });
    },
    hints: ['Docs > Patch calendar lists the affected devices.', 'Changes > Firmware upgrade each affected device to a 2014+ release.'],
    cleared: (w) => !Object.values(w.advisoryHits || {}).some((h) => h.some((a) => a.id === 'UE-EVENT-2014-HB')),
    rca: { cat: 'software', keys: ['openssl', 'heartbleed', 'patch', 'upgrade', 'firmware'] },
  },
  routeleak: {
    start(w) {
      for (const h of Object.values(w.hosts)) if (h.kind === 'isp') h.sendsFullTable = true;
      w.leakUntil = w.time.t + 12 * 60;
      w.dirty = true;
      return openTicket(w, { title: 'ISP is announcing the full routing table', text: DATA.campaign.events.routeleak.text, sev: 2, kind: 'event', event: 'routeleak' });
    },
    hints: ['show bgp summary / show ip bgp summary on the edges.', 'A session torn down by maximum-prefix needs a higher limit (2,000,000) - or remove it.'],
    cleared: (w) => {
      recompute(w);
      return Object.values(w.sim.bgp || {}).flat().every((b) => b.up || b.state === 'Idle (Admin)');
    },
    rca: { cat: 'routing', keys: ['maximum-prefix', 'route leak', 'full table', 'bgp', 'prefix-limit'] },
  },
};
export const eventCleared = (w, ev) => EVT[ev].cleared(w);
function startEvent(w, ev) {
  const t = EVT[ev].start(w);
  t.eventHints = EVT[ev].hints;
  t.rcaCat = EVT[ev].rca.cat;
  t.rcaKeys = EVT[ev].rca.keys;
  w.campaign && (w.campaign.events[ev] = 'active');
  toast(w, `${DATA.campaign.events[ev].title}! ${DATA.campaign.events[ev].text}`, 'incident');
}
function wormBlocked(w) {
  for (const dev of Object.values(w.devices)) {
    if (!['edge', 'fw'].includes(dev.role)) continue;
    for (const ifc of Object.values(dev.cfg.ifs)) {
      const acl = ifc.acl?.in && dev.cfg.acls[ifc.acl.in];
      if (acl && acl.some((e) => e.act === 'deny' && e.proto === 'udp' && Number(e.dport) === 1434)) return true;
    }
  }
  return false;
}

// =============================================================================================
// Campaign goals
export function goals(w) {
  const ch = w.campaign && DATA.campaign.chapters[w.campaign.chapter];
  if (!ch) return [];
  return ch.goals.map((g) => {
    let done = false;
    let prog = '';
    if (g.kind === 'customers') {
      const n = w.design.customers.filter((c) => !c.pending).length;
      done = n >= g.n;
      prog = `${n}/${g.n}`;
    } else if (g.kind === 'resolved') {
      const n = w.stats.resolved - w.campaign.resolved0;
      done = n >= g.n;
      prog = `${n}/${g.n}`;
    } else if (g.kind === 'cash') {
      done = w.cash >= g.n;
      prog = `$${Math.round(w.cash).toLocaleString()} / $${g.n.toLocaleString()}`;
    } else if (g.kind === 'role') {
      const n = (w.design.roles[g.role] || []).filter((id) => w.devices[id] && w.links.some((l) => l.a.dev === id || l.b.dev === id)).length;
      done = n >= g.n;
      prog = `${n}/${g.n}`;
    } else if (g.kind === 'uptime') {
      const up = w.campaign.total ? 100 - (100 * w.campaign.down) / w.campaign.total : 100;
      done = w.campaign.total > 30 * 1440 && up >= g.n;
      prog = `${up.toFixed(3)}% (needs 30 days)`;
    } else if (g.kind === 'event') {
      done = w.campaign.events[g.event] === 'done';
      prog = w.campaign.events[g.event] || 'waiting';
    } else if (g.kind === 'office') {
      done = w.design.office.on && !!checks(w).find((c) => c.kind === 'wifi')?.ok;
    } else if (g.kind === 'patched') {
      done = !Object.values(w.advisoryHits || {}).some((h) => h.some((a) => a.severity === 'critical'));
    } else if (g.kind === 'isps') {
      done = w.design.isps.length >= g.n && Object.values(w.sim?.bgp || {}).flat().filter((b) => b.up).length >= g.n;
    }
    return { ...g, done, prog };
  });
}
export function nextChapter(w) {
  const chs = DATA.campaign.chapters;
  const c = w.campaign;
  if (!goals(w).every((g) => g.done)) return 'Finish every goal first.';
  if (c.chapter + 1 >= chs.length) {
    c.done = true;
    toast(w, 'Campaign complete! You built an empire. Keep playing in this world as long as you like.', 'good');
    return null;
  }
  const next = chs[c.chapter + 1];
  c.chapter++;
  const t = tOfDate(next.year, 1, 2, 9, 0);
  if (t > w.time.t) w.time.t = t;
  w.clock = { step: Math.floor(w.time.t), hour: Math.floor(w.time.t / 60), day: Math.floor(w.time.t / 1440) };
  Object.assign(c, { startT: w.time.t, resolved0: w.stats.resolved, down: 0, total: 0 });
  money(w, Math.round(next.cash * 0.5), 'investment', `Investor round: ${next.title}`);
  refreshAdvisories(w);
  toast(w, `${next.year}: ${next.title}. ${next.story}`, 'story');
  return null;
}

// =============================================================================================
// Nightly config backups (a git-style history of every device's config)
export function configText(w, dev) {
  const D = getDialect(dev.os);
  if (!D || ['apos', 'fortiap', 'linux'].includes(dev.os)) return null;
  const s = new Session(null, { world: w, dialect: D, dev, via: 'backup', user: 'backup', priv: 15 });
  s.termLen = 0;
  s.mode = { ios: 'priv', iosxe: 'priv', nxos: 'exec', asa: 'exec', iosxr: 'exec', junos: 'op', evo: 'op', aoscx: 'exec', aoss: 'exec', arubaos: 'exec', fortios: 'top', fortiswitch: 'top' }[dev.os] || s.mode;
  const cmd = { junos: 'show configuration', evo: 'show configuration', fortios: 'show', fortiswitch: 'show' }[dev.os] || 'show running-config';
  if (dev.state !== 'up') return null;
  const r = s.exec(cmd);
  return (r.text || '').replace(/^.*\d{2}:\d{2}:\d{2}\.\d{3} UTC\n/, '');
}
export function nightlyBackups(w) {
  for (const dev of Object.values(w.devices)) {
    const txt = configText(w, dev);
    if (!txt) continue;
    const list = (w.backups[dev.id] = w.backups[dev.id] || []);
    const norm = (x) => x.replace(/^.*(Last configuration change|NVRAM config last|Time:|Last commit|Running configuration last done|Cryptochecksum|!! Last configuration).*$/gm, '');
    if (!list.length || norm(list[list.length - 1].text) !== norm(txt)) list.push({ t: w.time.t, text: txt });
    if (list.length > 5) list.shift();
  }
}

// =============================================================================================
// The clock
export function tick(w, dtReal, { terminalFocused = false } = {}) {
  if (w.gameOver || w.time.paused) return;
  const D = DIFF[w.difficulty];
  let incident = openIncidents(w).length > 0;
  for (const t of openIncidents(w)) {
    if (!(D.pauseInTerminal && terminalFocused)) t.slaUsed += dtReal;
    if (!t.breached && t.slaUsed > t.slaTotal) breach(w, t);
  }
  w.time.frac = (w.time.frac || 0) + dtReal * (incident ? 1 / 60 : SPEEDS[w.time.speed] || 0);
  let guard = 0;
  for (;;) {
    const step = incident ? 1 : 60;
    if (w.time.frac < step || guard++ > 400) break;
    w.time.frac -= step;
    w.clock.step += step;
    w.time.t = w.clock.step;
    stepMinutes(w, step);
    if (!incident && openIncidents(w).length) {
      incident = true;
      w.time.frac = 0; // something broke: drop into real time
    } else if (incident && !openIncidents(w).length) incident = false;
  }
  w.time.t = w.clock.step + Math.min(w.time.frac, incident ? 0.999 : 59.9);
}
function breach(w, t) {
  t.breached = true;
  w.stats.breaches++;
  w.rep = clamp(w.rep - 5, 0, 100);
  const custs = t.cust ? [t.cust] : [...new Set(t.impact.map((id) => checksIndex(w)[id]?.cust).filter(Boolean))];
  for (const cid of custs) {
    const c = w.design.customers.find((x) => x.id === cid);
    if (!c) continue;
    const credit = Math.round(c.fee * (t.sev === 1 ? 0.25 : 0.1));
    w.month.credits += credit;
    c.sat = clamp(c.sat - 10, 0, 100);
  }
  toast(w, `${t.id} breached its SLA response time. Service credits will be paid and reputation suffers.`, 'bad');
}
function stepMinutes(w, mins) {
  tickDevices(w);
  tickFacility(w, mins);
  if (w.dirty) recompute(w);
  ckCache = null;
  // uptime sampling + unplanned outage detection
  const cks = checks(w);
  let down = 0;
  const failing = cks.filter((c) => !c.ok && c.kind !== 'mgmt');
  for (const c of w.design.customers) {
    if (c.pending) continue;
    const bad = cks.some((x) => x.cust === c.id && !x.ok);
    c.mTotal += mins;
    if (bad) {
      c.mDown += mins;
      down++;
    }
  }
  w.stats.totalMins += mins;
  w.stats.monthTotal = (w.stats.monthTotal || 0) + mins;
  if (down) {
    w.stats.downMins += mins;
    w.stats.monthDown = (w.stats.monthDown || 0) + mins;
  }
  if (w.campaign) {
    w.campaign.total += mins;
    if (down) w.campaign.down += mins;
  }
  detectUnplanned(w, failing);
  // auto-close unplanned tickets? no: the player must resolve them
  if (w.worm) {
    w.worm.blocked = wormBlocked(w);
    if (w.worm.blocked && w.campaign?.events.slammer === 'active') w.campaign.events.slammer = 'done';
  }
  if (w.leakUntil && w.time.t > w.leakUntil) {
    for (const h of Object.values(w.hosts)) if (h.kind === 'isp') h.sendsFullTable = false;
    w.leakUntil = null;
    w.dirty = true;
    if (w.campaign?.events.routeleak === 'active') w.campaign.events.routeleak = 'done';
    toast(w, 'The ISP fixed their route leak; full routes withdrawn.', 'info');
  }
  for (const [ev, st] of Object.entries(w.campaign?.events || {})) if (st === 'active' && EVT[ev].cleared(w) && ev !== 'routeleak') w.campaign.events[ev] = 'done';
  // hour / day boundaries
  const hour = Math.floor(w.time.t / 60);
  if (hour !== w.clock.hour) {
    w.clock.hour = hour;
    hourly(w);
  }
  const day = Math.floor(w.time.t / 1440);
  if (day !== w.clock.day) {
    const prevMonth = dateOf((day - 1) * 1440).getUTCMonth();
    w.clock.day = day;
    daily(w);
    if (dateOf(w.time.t).getUTCMonth() !== prevMonth) monthEnd(w);
  }
}
function detectUnplanned(w, failing) {
  const explained = new Set(w.faults.filter((f) => f.active).flatMap((f) => f.impact || []));
  for (const t of w.tickets) if (t.status === 'open') for (const id of t.impact) explained.add(id);
  const booting = Object.values(w.devices).some((d) => d.state === 'booting');
  const fresh = failing.filter((c) => !explained.has(c.id) && c.cust);
  if (!fresh.length || (w.graceUntil && w.time.t < w.graceUntil) || booting) {
    w.unplannedSince = null;
    return;
  }
  if (w.faults.some((f) => f.active && ['facility', 'hardware'].includes(FAULT_BY_ID[f.tpl].cat))) {
    // facility problems spread: attach to that ticket instead
    const ft = w.tickets.find((t) => t.status === 'open' && t.faults.some((fid) => w.faults.find((f) => f.id === fid && f.active)));
    if (ft) {
      ft.impact = [...new Set([...ft.impact, ...fresh.map((c) => c.id)])];
      ft.sev = Math.min(ft.sev, sevFor(w, ft.impact));
      if (ft.sev <= 2 && !ft.slaTotal) ft.slaTotal = DIFF[w.difficulty].slaMin * 60;
      return;
    }
  }
  w.unplannedSince = w.unplannedSince ?? w.time.t;
  if (w.time.t - w.unplannedSince < 3) return;
  const recent = (w.cfgEvents || []).filter((e) => e.t > w.time.t - 240).pop();
  const t = openTicket(w, { title: `Unplanned outage: ${fresh[0].name}${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''}`, text: `Monitoring detected an outage that no maintenance explains: ${fresh.map((c) => `${c.name} - ${c.reason}`).slice(0, 4).join('; ')}.${recent ? ` The last configuration change was on ${w.devices[recent.dev]?.hostname}.` : ''}`, sev: sevFor(w, fresh.map((c) => c.id)), impact: fresh.map((c) => c.id), kind: 'unplanned' });
  t.suspect = recent?.dev || null;
  w.unplannedSince = null;
  if (DIFF[w.difficulty].unauthorized) {
    w.rep = clamp(w.rep - 2, 0, 100);
    toast(w, 'Self-inflicted outage: -2 reputation. Change management exists for a reason.', 'bad');
  }
}
function hourly(w) {
  const h = dateOf(w.time.t).getUTCHours();
  utilisation(w, (c) => c.mbps || 5);
  if (h % 3 === 0) periodic(w);
  const D = DIFF[w.difficulty];
  const R = rng(`${w.seed}:h:${Math.floor(w.time.t / 60)}`);
  if (D.herrings && R.chance(D.herrings * 0.15)) herring(w, R);
  if (h === 2) {
    for (const c of w.changes.filter((x) => x.status === 'queued')) {
      if (openIncidents(w).length && c.kind !== 'firmware') continue;
      runChange(w, c.id);
      toast(w, `Maintenance window: ${c.title} - ${c.status}.`, 'info');
    }
    nightlyBackups(w);
  }
  // memory-leak advisories: long uptime eventually crashes
  for (const [devId, hits] of Object.entries(w.advisoryHits || {})) {
    const dev = w.devices[devId];
    if (!dev || dev.state !== 'up') continue;
    if (hits.some((a) => a.effect === 'leak') && w.time.t - dev.run.boot > 120 * 1440 && R.chance(0.01) && !openIncidents(w).length) injectFault(w, R, { only: ['firmware-crash'] });
  }
}
function herring(w, R) {
  const devs = Object.values(w.devices).filter((d) => d.state === 'up');
  if (!devs.length) return;
  const d = R.pick(devs);
  const ip = `${R.pick(['45.155.205', '185.220.101', '89.248.165', '193.32.162'])}.${R.int(2, 250)}`;
  if (R.chance(0.6)) logEvent(w, d.id, { type: 'authfail', user: R.pick(['root', 'admin', 'cisco', 'ubnt', 'test']), from: ip, proto: 'ssh' });
  else logEvent(w, d.id, { type: 'link', if: Object.keys(d.cfg.ifs).find((n) => d.cfg.ifs[n].kind === 'phys' && !d.cfg.ifs[n].on) || Object.keys(d.cfg.ifs)[0], up: false, admin: true, kind: 'phys' });
}
function daily(w) {
  const D = DIFF[w.difficulty];
  const day = Math.floor(w.time.t / 1440);
  const R = rng(`${w.seed}:d:${day}`);
  refreshAdvisories(w);
  // leads
  w.leads = w.leads.filter((l) => l.expires > w.time.t);
  const repFactor = 0.5 + w.rep / 100;
  if (w.leads.length < 4 && R.chance(0.16 * repFactor)) {
    const l = makeLead(w, R);
    w.leads.push(l);
    toast(w, `New lead: ${l.name} wants ${l.servers} server${l.servers > 1 ? 's' : ''} on a ${TIERS[l.tier].label} plan ($${l.fee.toLocaleString()}/mo).`, 'lead');
  }
  // churn
  for (const c of [...w.design.customers]) {
    if (!c.pending && c.sat < 25 && R.chance(0.04)) {
      toast(w, `${c.name} cancelled their contract (satisfaction ${Math.round(c.sat)}%).`, 'bad');
      B.removeCustomer(w, c.id);
      queueChange(w, { kind: 'provision', title: `Remove ${c.name} configuration` });
    }
  }
  // faults
  const active = w.faults.filter((f) => f.active).length;
  const size = 1 + Object.keys(w.devices).length / 12 + w.design.customers.length / 10;
  if (!openIncidents(w).length && active < D.faultCap && R.chance(Math.min(0.6, (size / D.everyDays) * 0.8))) injectFault(w, R);
  // firmware crash advisories
  for (const [devId, hits] of Object.entries(w.advisoryHits || {})) if (hits.some((a) => a.effect === 'crash') && R.chance(0.012) && !openIncidents(w).length && w.devices[devId]?.state === 'up') {
    injectFault(w, R, { only: ['firmware-crash'] });
    break;
  }
  // security advisories become a ticket if left open for too long
  for (const [devId, hits] of Object.entries(w.advisoryHits || {})) for (const a of hits) if (a.effect === 'security' && w.time.t - advisoryDate(a) > 90 * 1440 && !w.tickets.some((t) => t.adv === `${devId}:${a.id}`)) {
    const t = openTicket(w, { title: `Security audit: ${w.devices[devId].hostname} still vulnerable to ${a.id}`, text: `${a.title}. Customers' auditors flagged it. Upgrade to ${a.fixed || 'a fixed release'}.`, sev: 3, kind: 'event' });
    t.adv = `${devId}:${a.id}`;
    t.eventHints = ['Docs > Patch calendar', 'Changes > Firmware upgrade'];
    t.rcaCat = 'software';
    t.rcaKeys = ['patch', 'upgrade', 'firmware', a.id.toLowerCase()];
    t.checkFn = 'adv';
    w.rep = clamp(w.rep - 2, 0, 100);
  }
  // campaign set pieces
  if (w.campaign) {
    const ch = DATA.campaign.chapters[w.campaign.chapter];
    const ev = ch.event;
    if (ev && !w.campaign.events[ev]) {
      const [y, m, d] = DATA.campaign.events[ev].date;
      const at = tOfDate(y, m, d);
      const startAt = Math.max(at, w.campaign.startT + 20 * 1440);
      if (w.time.t >= startAt) startEvent(w, ev);
    }
  }
}
// Event tickets created for advisories resolve when the device is patched
const oldEventCleared = eventCleared;
export function ticketFixed(w, t) {
  if (t.adv) {
    const [devId, advId] = t.adv.split(':');
    return !(w.advisoryHits?.[devId] || []).some((a) => a.id === advId);
  }
  if (t.event) return oldEventCleared(w, t.event);
  return null;
}

// =============================================================================================
// Saves
export function serialize(w) {
  const skip = new Set(['sim', 'lastSnap', 'logQueue', 'dirty', 'simT', '_oldLinks']);
  return JSON.stringify(w, (k, v) => (skip.has(k) ? undefined : v));
}
export function deserialize(txt) {
  const w = JSON.parse(txt);
  w.dirty = true;
  recompute(w);
  refreshAdvisories(w);
  return w;
}
export function saveGame(w, storage = globalThis.localStorage) {
  try {
    if (w.syslog && w.syslog.length > 1500) w.syslog.splice(0, w.syslog.length - 1500);
    storage?.setItem(SAVE_KEY, serialize(w));
    return true;
  } catch (e) {
    console.warn('save failed', e);
    return false;
  }
}
export function loadGame(storage = globalThis.localStorage) {
  const txt = storage?.getItem(SAVE_KEY);
  return txt ? deserialize(txt) : null;
}
export { FAULTS, CATS, rackLoad, coolingKw, heatKw, startFault };
