// Device model: creation from the catalog + canonical (vendor-neutral) config helpers.
import { model, expandPorts, versionFor, OS } from './catalog.js';
import { deep, hashStr } from '../core/util.js';

export function emptyCfg(hostname) {
  return {
    hostname,
    ifs: {},
    vlans: { 1: 'default' },
    stp: { on: true, mode: 'rapid-pvst', prio: {} },
    static: [],
    ospf: { on: false, pid: 1, rid: null, defOrig: false, ref: 100 },
    bgp: { on: false, asn: null, rid: null, nbrs: [], nets: [] },
    acls: {},
    fw: { pol: [], vip: [], snat: [], zones: {} },
    nat: { inside: [], outside: [], overload: null, statics: [] },
    svc: { ntp: [], dns: [], domain: 'dc.local', snmp: 'public', syslog: [], domainLookup: true, ssh: true, telnet: false, users: [], enable: null, motd: null },
    wlc: null,
    ap: null,
  };
}

function defaultEnabled(m, kind) {
  if (kind !== 'phys') return true;
  if (m.os === 'aoscx') return false; // AOS-CX ports ship administratively down
  if ((m.os === 'ios' || m.os === 'iosxe') && m.roles.includes('edge')) return false; // IOS router ports default "shutdown"
  if (m.os === 'asa') return false;
  return true;
}

export function newIf(kind, extra = {}) {
  return {
    kind,
    on: true,
    desc: '',
    sw: null,
    ip: null,
    vrf: null,
    fhrp: null,
    ospf: null,
    mtu: 1500,
    speed: 'auto',
    duplex: 'auto',
    lag: null,
    stp: { edge: false, bpduguard: false },
    helper: [],
    acl: { in: null, out: null },
    ...extra,
  };
}

export function createDevice({ id, modelId, hostname, year, t = 0 }) {
  const m = model(modelId);
  if (!m) throw new Error(`Unknown model ${modelId}`);
  const cfg = emptyCfg(hostname);
  const l2 = m.feat.includes('l2');
  for (const p of expandPorts(m)) {
    const ifc = newIf(p.media === 'serial' ? 'serial' : 'phys', { hw: { speed: p.speed, media: p.media } });
    ifc.on = defaultEnabled(m, ifc.kind);
    if (l2 && p.media !== 'serial') ifc.sw = { mode: 'access', vlan: 1, native: 1, allowed: 'all' };
    if (m.os === 'aoscx' && m.roles.includes('core') && !m.roles.includes('access')) ifc.sw = null; // 8xxx default routed
    if (ifc.kind === 'serial') ifc.encap = 'hdlc';
    cfg.ifs[p.name] = ifc;
  }
  let mgmtIf = null;
  if (m.mgmt && m.mgmt !== 'inband' && m.mgmt !== 'none') {
    mgmtIf = m.mgmt;
    if (!cfg.ifs[mgmtIf]) cfg.ifs[mgmtIf] = newIf('mgmt', { hw: { speed: 1000, media: 'rj45' } });
    else cfg.ifs[mgmtIf].sw = null;
    cfg.ifs[mgmtIf].mgmt = true;
    cfg.ifs[mgmtIf].on = true;
    const vrf = OS[m.os]?.mgmtVrf;
    if (vrf && cfg.ifs[mgmtIf].kind === 'mgmt') cfg.ifs[mgmtIf].vrf = vrf;
  }
  if (!['fortiap', 'apos'].includes(m.os)) cfg.svc.users.push({ name: 'admin', pw: 'admin', priv: 15 });
  return {
    id,
    model: modelId,
    os: m.os,
    vendor: m.vendor,
    version: versionFor(m.os, year, m),
    hostname,
    role: null,
    rack: null,
    u: null,
    state: 'up',
    bootUntil: 0,
    installed: t,
    cfg,
    startup: null,
    hw: { psus: Array(Math.max(1, m.psus)).fill(true), fans: Array(m.fans).fill(true), optics: {}, temp: 28, serial: serialFor(id, m) },
    run: { boot: t, logs: [], counters: {}, errdis: {}, fhrp: {}, cfgChanges: 0, lastCfg: t, lastCfgBy: null, rollback: [], checkpoints: {} },
    meta: { mgmtIf, inband: m.mgmt === 'inband' },
    key: `SHA256:${btoaSafe(`${id}:${t}`)}`,
  };
}

function serialFor(id, m) {
  const h = hashStr(`${id}:${m.id}`).toString(36).toUpperCase().padStart(7, '0').slice(0, 7);
  const pre = { Cisco: 'FOC', Juniper: 'JN', 'HP / Aruba': 'SG', Fortinet: 'FG' }[m.vendor] || 'SN';
  return `${pre}${h}${(hashStr(id) % 900) + 100}`;
}
function btoaSafe(s) {
  let x = hashStr(s);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < 43; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += chars[x % 64];
  }
  return out;
}

// ---------- canonical config helpers ----------
export const snapshot = (dev) => deep(dev.cfg);
export function saveStartup(dev, t) {
  dev.startup = snapshot(dev);
  dev.run.savedAt = t;
}
export const unsaved = (dev) => !dev.startup || JSON.stringify(dev.startup) !== JSON.stringify(dev.cfg);

export function ensureIf(dev, name, kind, extra = {}) {
  if (!dev.cfg.ifs[name]) dev.cfg.ifs[name] = newIf(kind, extra);
  return dev.cfg.ifs[name];
}
export function ensureVlan(dev, id, name) {
  if (!(id in dev.cfg.vlans)) dev.cfg.vlans[id] = name || `VLAN${String(id).padStart(4, '0')}`;
  else if (name) dev.cfg.vlans[id] = name;
}
export function ensureSvi(dev, vlan) {
  const name = OS[dev.os].svi(vlan);
  const ifc = ensureIf(dev, name, 'svi', { vlan });
  ifc.vlan = vlan;
  return name;
}
export function ensureLo(dev, n = 0) {
  const name = OS[dev.os].lo(n);
  ensureIf(dev, name, 'lo');
  return name;
}
export function ensureLag(dev, n) {
  const name = OS[dev.os].lag(n);
  const ifc = ensureIf(dev, name, 'lag', { lagId: n });
  ifc.lagId = n;
  return name;
}
export function setAccess(ifc, vlan) {
  ifc.sw = { mode: 'access', vlan, native: 1, allowed: 'all' };
  ifc.ip = null;
}
export function setTrunk(ifc, allowed = 'all', native = 1) {
  ifc.sw = { mode: 'trunk', vlan: 1, native, allowed };
  ifc.ip = null;
}
export function setRouted(ifc, ip) {
  ifc.sw = null;
  ifc.ip = ip || null;
}
export function lagMembers(dev, lagName) {
  const id = dev.cfg.ifs[lagName]?.lagId;
  return Object.keys(dev.cfg.ifs).filter((n) => dev.cfg.ifs[n].lag && dev.cfg.ifs[n].lag.id === id);
}

// Record a configuration change (for logs, the "unauthorised change" check and docs drift).
export function touch(dev, world, by = 'admin', via = 'vty0') {
  dev.run.cfgChanges++;
  dev.run.lastCfg = world?.time?.t ?? 0;
  dev.run.lastCfgBy = by;
  if (world) {
    world.dirty = true;
    world.cfgEvents = world.cfgEvents || [];
    world.cfgEvents.push({ dev: dev.id, t: world.time.t, by, via });
  }
}

// Interfaces that carry Layer-3 addressing
export const l3Ifs = (dev) => Object.entries(dev.cfg.ifs).filter(([, i]) => i.ip);

// Which interface owns an IP (exact address match, ignoring prefix length)
export function ifByIp(dev, ip) {
  for (const [n, i] of Object.entries(dev.cfg.ifs)) if (i.ip && i.ip.split('/')[0] === ip) return n;
  return null;
}
