// Source of truth -> network. Wires devices by role, renders every device's canonical config,
// onboards customers and produces the documentation the player troubleshoots with.
import { model, expandPorts, OS } from './catalog.js';
import { createDevice, newIf, ensureVlan, ensureSvi, ensureLag, setAccess, setTrunk, setRouted, saveStartup } from './model.js';
import { n2ip, ip2n, maskStr, rng, yearOf, hashStr } from '../core/util.js';

export const MGMT_NET = '10.250.0';
export const SVC = { vlan: 20, net: '10.20.0', dns: '10.20.0.53', ntp: '10.20.0.123', syslog: '10.20.0.14', nms: '10.20.0.20', dhcp: '10.20.0.67', radius: '10.20.0.18' };
export const OFFICE = { wired: 30, wifi: 31, aps: 32 };
export const MGMT_VLAN = 999;
export const PUBLIC = '192.0.2';
export const PROBE = '198.51.100.77';
export const ISP_DEFS = [
  { id: 'ispA', name: 'Northlink Transit', asn: 65001, net: '203.0.113.0', peer: '203.0.113.1', ours: '203.0.113.2' },
  { id: 'ispB', name: 'Meridian Fibre', asn: 65002, net: '203.0.113.4', peer: '203.0.113.5', ours: '203.0.113.6' },
];
const ROLE_PREFIX = { edge: 'edge', fw: 'fw', core: 'core', access: 'acc', oob: 'oob', wlc: 'wlc', ap: 'ap' };
const WORDS = ['Copper', 'Falcon', 'Quartz', 'Harbor', 'Cobalt', 'Maple', 'Orbit', 'Velvet', 'Summit', 'Tundra', 'Ember', 'Pixel', 'Granite', 'Lumen', 'Cedar', 'Nimbus'];

export function newDesign() {
  return {
    asn: 64512,
    roles: { edge: [], fw: [], core: [], access: [], oob: [], wlc: [], ap: [] },
    isps: [ISP_DEFS[0].id],
    bgp: false,
    customers: [],
    ports: {},
    transit: {},
    lo: {},
    mgmt: {},
    vault: {},
    office: { on: false, essid: 'Uptime-Staff', ssid: 'staff' },
    nextK: 1,
    warnings: [],
    docErrors: [],
  };
}

// ---------- naming / allocation ----------
export function nextHostname(world, role) {
  const used = new Set(Object.values(world.devices).map((d) => d.hostname));
  for (let i = 1; ; i++) {
    const h = `${ROLE_PREFIX[role] || role}${i}`;
    if (!used.has(h)) return h;
  }
}

function vaultFor(world, dev) {
  const d = world.design;
  if (!d.vault[dev.id]) {
    const r = rng(`vault:${world.seed}:${dev.id}`);
    d.vault[dev.id] = { user: 'admin', pw: `${r.pick(WORDS)}-${r.pick(WORDS)}-${r.int(10, 99)}`, enable: `${r.pick(WORDS)}${r.int(100, 999)}!` };
  }
  return d.vault[dev.id];
}

function mgmtIpFor(world, devId) {
  const d = world.design;
  if (!d.mgmt[devId]) {
    const used = new Set(Object.values(d.mgmt));
    for (let i = 11; i < 250; i++) {
      const ip = `${MGMT_NET}.${i}`;
      if (!used.has(ip)) {
        d.mgmt[devId] = ip;
        break;
      }
    }
  }
  return d.mgmt[devId];
}

function loFor(world, devId) {
  const d = world.design;
  if (!d.lo[devId]) {
    const used = new Set(Object.values(d.lo));
    for (let i = 1; i < 250; i++) {
      const ip = `10.255.0.${i}`;
      if (!used.has(ip)) {
        d.lo[devId] = ip;
        break;
      }
    }
  }
  return d.lo[devId];
}

// Stable /30 per device pair
function transitFor(world, a, b) {
  const d = world.design;
  const key = [a, b].sort().join('|');
  if (!d.transit[key]) {
    const used = new Set(Object.values(d.transit).map((x) => x.net));
    for (let i = 0; i < 64; i++) {
      const net = `10.0.0.${i * 4}`;
      if (!used.has(net)) {
        const [lo, hi] = [a, b].sort();
        d.transit[key] = { net, [lo]: `10.0.0.${i * 4 + 1}`, [hi]: `10.0.0.${i * 4 + 2}` };
        break;
      }
    }
  }
  return d.transit[key];
}

// Edge <-> firewall links use public /30s so the firewall's outside address can be used for PAT
function publicTransitFor(world, a, b) {
  const d = world.design;
  d.ptransit = d.ptransit || {};
  const key = [a, b].sort().join('|');
  if (!d.ptransit[key]) {
    const used = new Set(Object.values(d.ptransit).map((x) => x.net));
    for (const base of [248, 252, 240, 244]) {
      const net = `${PUBLIC}.${base}`;
      if (!used.has(net)) {
        const [lo, hi] = [a, b].sort();
        d.ptransit[key] = { net, [lo]: `${PUBLIC}.${base + 1}`, [hi]: `${PUBLIC}.${base + 2}` };
        break;
      }
    }
  }
  return d.ptransit[key];
}

// Port pools: downlinks from the bottom, uplinks from the fastest/highest ports
function portPool(dev) {
  const m = model(dev.model);
  const mg = dev.meta.mgmtIf;
  return expandPorts(m).filter((p) => p.name !== mg && p.media !== 'serial');
}
function allocPort(world, dev, purpose, { up = false, serial = false } = {}) {
  const d = world.design;
  const mine = (d.ports[dev.id] = d.ports[dev.id] || {});
  if (mine[purpose] && dev.cfg.ifs[mine[purpose]]) return mine[purpose];
  const taken = new Set(Object.values(mine));
  let pool = serial ? expandPorts(model(dev.model)).filter((p) => p.media === 'serial') : portPool(dev);
  if (!pool.length) pool = portPool(dev);
  if (up) {
    const maxSpeed = Math.max(...pool.map((p) => p.speed));
    pool = [...pool.filter((p) => p.speed === maxSpeed).reverse(), ...pool.filter((p) => p.speed !== maxSpeed).reverse()];
  }
  const p = pool.find((x) => !taken.has(x.name));
  if (!p) return null;
  mine[purpose] = p.name;
  return p.name;
}
const freePorts = (world, dev) => {
  const taken = new Set(Object.values(world.design.ports[dev.id] || {}));
  return portPool(dev).filter((p) => !taken.has(p.name)).length;
};

// ---------- devices ----------
export function installDevice(world, modelId, { role, rack = null, u = null, hostname } = {}) {
  const id = `d${(world.nextDevId = (world.nextDevId || 0) + 1)}`;
  const dev = createDevice({ id, modelId, hostname: hostname || nextHostname(world, role), year: yearOf(world.time.t), t: world.time.t });
  dev.role = role;
  dev.rack = rack;
  dev.u = u;
  world.devices[id] = dev;
  world.design.roles[role].push(id);
  return dev;
}

export function removeDevice(world, devId) {
  const d = world.design;
  for (const r of Object.keys(d.roles)) d.roles[r] = d.roles[r].filter((x) => x !== devId);
  delete d.ports[devId];
  for (const k of Object.keys(d.transit)) if (k.split('|').includes(devId)) delete d.transit[k];
  delete world.devices[devId];
  world.links = world.links.filter((l) => l.a.dev !== devId && l.b.dev !== devId);
}

// ---------- customers ----------
export function addCustomer(world, { name, servers = 1, web = true, sla = 99.9, tier = 'standard', speed = 100 }) {
  const d = world.design;
  const k = d.nextK++;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 8);
  const c = { id: `c${k}`, k, name, slug, vlan: 100 + k, net: `10.100.${k}.0`, servers: [], web, vip: web ? `${PUBLIC}.${(9 + k) % 250}` : null, sla, tier, speed };
  for (let i = 1; i <= servers; i++) {
    const hid = `h-${slug}${k}-${i}`;
    world.hosts[hid] = { id: hid, name: `${slug}-${web && i === 1 ? 'web' : 'srv'}${String(i).padStart(2, '0')}`, kind: 'server', cust: c.id, ip: `10.100.${k}.${10 + i - 1}`, len: 24, gw: `10.100.${k}.1`, listen: web && i === 1 ? [22, 80, 443] : [22, 3306], nic: { up: true, speed: 'auto', duplex: 'auto' }, watts: 250, mtu: 1500 };
    c.servers.push(hid);
  }
  d.customers.push(c);
  return c;
}
export function removeCustomer(world, cid) {
  const d = world.design;
  const c = d.customers.find((x) => x.id === cid);
  if (!c) return;
  for (const h of c.servers) delete world.hosts[h];
  d.customers = d.customers.filter((x) => x.id !== cid);
  for (const dev of Object.values(d.ports)) for (const k of Object.keys(dev)) if (c.servers.some((h) => k === `srv:${h}`)) delete dev[k];
}

// Capacity check for onboarding: free access ports
export function accessCapacity(world) {
  return world.design.roles.access.reduce((s, id) => s + Math.max(0, freePorts(world, world.devices[id]) - 2), 0);
}

// ---------- provisioning ----------
function link(world, a, b, extra = {}) {
  const id = `L${hashStr(`${a.dev || a.host}:${a.if}|${b.dev || b.host}:${b.if}`).toString(36)}`;
  const prev = world._oldLinks?.get(id);
  const l = prev ? { ...prev, a, b, ...extra, intended: { a, b } } : { id, a, b, cable: { ok: true, type: extra.type || 'cat6', id: `C-${String(world.links.length + 1).padStart(4, '0')}` }, intended: { a, b }, ...extra };
  if (prev?.cable) l.cable = prev.cable;
  world.links.push(l);
  return l;
}

const roleDevs = (world, r) => world.design.roles[r].map((id) => world.devices[id]).filter(Boolean);
const has = (dev, f) => model(dev.model).feat.includes(f);
const fhrpFor = (devs) => (devs.every((d) => ['ios', 'iosxe', 'nxos'].includes(d.os)) ? 'hsrp' : 'vrrp');

function resetCfg(dev, world) {
  // Keep hardware-derived interfaces; rebuild configuration from intent.
  const fresh = createDevice({ id: dev.id, modelId: dev.model, hostname: dev.hostname, year: yearOf(world.time.t), t: world.time.t });
  dev.cfg = fresh.cfg;
  dev.meta = fresh.meta;
  const v = vaultFor(world, dev);
  dev.cfg.svc.users = [{ name: v.user, pw: v.pw, priv: ['ios', 'iosxe', 'asa'].includes(dev.os) ? 1 : 15 }];
  dev.cfg.svc.enable = v.enable;
  dev.cfg.svc.ntp = [SVC.ntp];
  dev.cfg.svc.dns = [SVC.dns];
  dev.cfg.svc.syslog = [SVC.syslog];
  dev.cfg.svc.snmp = 'nms-r0';
  dev.cfg.svc.domainLookup = false;
  const y = yearOf(world.time.t);
  dev.cfg.svc.ssh = y >= 2000 || !['ios', 'aoss'].includes(dev.os);
  dev.cfg.svc.telnet = !dev.cfg.svc.ssh;
  dev.cfg.svc.motd = 'Authorised access only. All activity is logged.';
}

function configMgmt(world, dev, oob) {
  const ip = mgmtIpFor(world, dev.id);
  const mg = dev.meta.mgmtIf;
  if (mg) {
    const ifc = dev.cfg.ifs[mg];
    setRouted(ifc, `${ip}/24`);
    ifc.on = true;
    ifc.desc = 'OOB management';
    if (dev.os === 'asa') Object.assign(ifc, { nameif: 'management', seclvl: 100, zone: 'management' });
    if (oob) link(world, { dev: dev.id, if: mg }, { dev: oob.id, if: allocPort(world, oob, `mgmt:${dev.id}`) }, { type: 'cat6', purpose: 'mgmt' });
    return;
  }
  if (!dev.meta.inband) return;
  // In-band management: a port in VLAN 999 cabled to the OOB switch + SVI
  ensureVlan(dev, MGMT_VLAN, 'MGMT');
  const p = allocPort(world, dev, 'mgmt', { up: false });
  const pi = dev.cfg.ifs[p];
  setAccess(pi, MGMT_VLAN);
  pi.on = true;
  pi.desc = 'OOB management';
  const svi = ensureSvi(dev, MGMT_VLAN);
  dev.cfg.ifs[svi].ip = `${ip}/24`;
  dev.cfg.ifs[svi].on = true;
  dev.cfg.ifs[svi].desc = 'Management';
  dev.meta.mgmtSvi = svi;
  if (oob && oob.id !== dev.id) link(world, { dev: dev.id, if: p }, { dev: oob.id, if: allocPort(world, oob, `mgmt:${dev.id}`) }, { type: 'cat6', purpose: 'mgmt' });
}

export function provision(world) {
  const d = world.design;
  d.warnings = [];
  world._oldLinks = new Map((world.links || []).map((l) => [l.id, l]));
  world.links = [];
  const edges = roleDevs(world, 'edge');
  const fws = roleDevs(world, 'fw').slice(0, 1);
  const cores = roleDevs(world, 'core').slice(0, 2);
  const accs = roleDevs(world, 'access');
  const oob = roleDevs(world, 'oob')[0] || null;
  const wlcs = roleDevs(world, 'wlc').slice(0, 1);
  const aps = roleDevs(world, 'ap');
  const all = Object.values(world.devices);
  for (const dev of all) resetCfg(dev, world);
  for (const extra of roleDevs(world, 'fw').slice(1)) d.warnings.push(`${extra.hostname} is installed as a cold-standby spare (one active firewall is supported).`);

  // Routing protocol choice
  const l3chain = [...edges, ...fws, ...cores];
  const ospf = l3chain.length > 1 && l3chain.every((x) => has(x, 'ospf'));
  d.routing = ospf ? 'ospf' : 'static';
  if (edges.length > 1 && !cores.length) d.warnings.push('A second edge router needs a Layer 3 core to be useful.');
  const isps = d.isps.map((id) => ISP_DEFS.find((x) => x.id === id)).filter(Boolean);
  d.bgp = isps.length > 1 || d.bgp;
  const natDev = fws[0] || edges[0];
  if (natDev && !has(natDev, 'nat')) d.warnings.push(`${natDev.hostname} can't do NAT, so customers have no internet access. Add a firewall or a NAT-capable edge router.`);
  const gwDev = cores[0] || edges[0];
  const vlansAll = [SVC.vlan, ...d.customers.map((c) => c.vlan), ...(d.office.on && cores.length ? [OFFICE.wired, OFFICE.wifi, OFFICE.aps] : [])];

  // Hosts: services + jump + ISPs
  ensureInfraHosts(world, isps);

  // ---- OOB ----
  if (oob) {
    ensureVlan(oob, 1, 'default');
    const svi = ensureSvi(oob, 1);
    oob.cfg.ifs[svi].ip = `${mgmtIpFor(world, oob.id)}/24`;
    oob.cfg.ifs[svi].on = true;
    oob.meta.mgmtSvi = svi;
    for (const n of Object.keys(oob.cfg.ifs)) if (oob.cfg.ifs[n].sw) oob.cfg.ifs[n].on = true;
    link(world, { host: 'jump', if: 'eth0' }, { dev: oob.id, if: allocPort(world, oob, 'jump') }, { type: 'cat6', purpose: 'mgmt' });
    world.hosts.jump.attach = 'oob';
  } else d.warnings.push('No out-of-band management switch: devices are reachable by console only.');
  for (const dev of all) if (dev !== oob && !['ap'].includes(dev.role)) configMgmt(world, dev, oob);

  // ---- Edge ----
  edges.forEach((e, i) => {
    e.cfg.static = [];
    const loName = OS[e.os].lo(0);
    e.cfg.ifs[loName] = { ...newIf('lo'), ip: `${loFor(world, e.id)}/32`, desc: 'Router ID' };
    const myIsps = edges.length === 1 ? isps : isps.filter((_, j) => j === i);
    for (const isp of myIsps) {
      const hasSerial = expandPorts(model(e.model)).some((p) => p.media === 'serial');
      const serial = hasSerial && (yearOf(world.time.t) < 2003 || portPool(e).length < 2);
      const p = allocPort(world, e, `isp:${isp.id}`, { up: !serial, serial });
      const ifc = e.cfg.ifs[p];
      setRouted(ifc, `${isp.ours}/30`);
      ifc.on = true;
      ifc.desc = `${isp.name} transit (AS${isp.asn})`;
      if (natDev === e) ifc.zone = 'outside';
      link(world, { dev: e.id, if: p }, { host: isp.id, if: 'Gi0/0/0' }, { type: ifc.kind === 'serial' ? 'v35' : 'smf', purpose: 'wan' });
      if (!d.bgp) e.cfg.static.push({ pfx: '0.0.0.0/0', nh: isp.peer, ad: 1 });
    }
    if (d.bgp) {
      e.cfg.bgp = { on: true, asn: d.asn, rid: loFor(world, e.id), nbrs: myIsps.map((isp) => ({ ip: isp.peer, ras: isp.asn, shut: false, desc: isp.name, maxpfx: null, rplIn: e.os === 'iosxr' ? 'TRANSIT-IN' : null, rplOut: e.os === 'iosxr' ? 'TRANSIT-OUT' : null })), nets: [`${PUBLIC}.0/24`] };
      if (e.os === 'iosxr') e.cfg.rpl = { 'TRANSIT-IN': 'pass', 'TRANSIT-OUT': `if destination in (${PUBLIC}.0/24) then\n  pass\nendif` };
      e.cfg.static.push({ pfx: `${PUBLIC}.0/24`, nh: null, iface: 'Null0', ad: 254 });
    }
    // South side
    if (!cores.length && !fws.length && i === 0) routerOnAStick(world, e, accs[0], vlansAll);
  });

  // ---- Firewall ----
  const fw = fws[0];
  if (fw) {
    fw.cfg.fw = { pol: [], vip: [], snat: [], zones: { outside: [], inside: [] } };
    edges.forEach((e) => {
      const t = publicTransitFor(world, e.id, fw.id);
      const pe = allocPort(world, e, `down:${fw.id}`, { up: true });
      const pf = allocPort(world, fw, `up:${e.id}`, { up: true });
      routedPair(world, e, pe, fw, pf, t, `to-${fw.hostname}`, `to-${e.hostname}`);
      fw.cfg.ifs[pf].zone = 'outside';
      fw.cfg.ifs[pf].seclvl = 0;
      fw.cfg.fw.zones.outside.push(pf);
      if (d.routing === 'static') {
        e.cfg.static.push({ pfx: '10.0.0.0/8', nh: t[fw.id], ad: 1 });
        e.cfg.static.push({ pfx: `${PUBLIC}.0/24`, nh: t[fw.id], ad: 1 });
      } else e.cfg.static.push({ pfx: `${PUBLIC}.0/24`, nh: t[fw.id], ad: 1 });
      if (d.routing === 'static' && e === edges[0]) fw.cfg.static.push({ pfx: '0.0.0.0/0', nh: t[e.id], ad: 1 });
    });
    if (!cores.length) d.warnings.push('Install a Layer 3 core switch: the firewall sits between the edge and the core.');
    cores.forEach((c, j) => {
      const t = transitFor(world, fw.id, c.id);
      const pf = allocPort(world, fw, `down:${c.id}`, { up: true });
      const pc = allocPort(world, c, `up:${fw.id}`, { up: true });
      routedPair(world, fw, pf, c, pc, t, `to-${c.hostname}`, `to-${fw.hostname}`);
      fw.cfg.ifs[pf].zone = 'inside';
      fw.cfg.ifs[pf].seclvl = 100;
      fw.cfg.fw.zones.inside.push(pf);
      if (d.routing === 'static') {
        if (j === 0) fw.cfg.static.push({ pfx: '10.0.0.0/8', nh: t[c.id], ad: 1 });
        c.cfg.static.push({ pfx: '0.0.0.0/0', nh: t[fw.id], ad: 1 });
      }
    });
    if (d.routing === 'ospf') fw.cfg.static = fw.cfg.static.filter((s) => s.pfx !== '0.0.0.0/0');
    // Policies, NAT, VIPs
    fw.cfg.fw.pol.push({ id: 1, name: 'inside-to-internet', from: 'inside', to: 'outside', src: 'all', dst: 'all', svc: 'ALL', act: 'accept', nat: true, on: true });
    let pid = 2;
    for (const c of d.customers.filter((x) => x.web)) {
      const web = world.hosts[c.servers[0]];
      fw.cfg.fw.vip.push({ name: `VIP-${c.slug.toUpperCase()}`, ext: c.vip, int: web.ip, cust: c.id });
      fw.cfg.fw.pol.push({ id: pid++, name: `web-${c.slug}`, from: 'outside', to: 'inside', src: 'all', dst: `VIP-${c.slug.toUpperCase()}`, svc: 'HTTPS', act: 'accept', nat: false, on: true, cust: c.id });
    }
    fw.cfg.fw.snat.push({ from: 'inside', to: 'outside', on: true });
    if (fw.os === 'asa') {
      // ASA: inbound access-list on the outside interface, written against real (post-NAT) addresses
      const [maj, min] = String(fw.version).split(/[.(]/).map(Number);
      const legacy = maj < 8 || (maj === 8 && min < 3);
      fw.cfg.acls.OUTSIDE_IN = d.customers.filter((x) => x.web).map((c) => ({ act: 'permit', proto: 'tcp', src: 'any', dst: `${legacy ? c.vip : world.hosts[c.servers[0]].ip}/32`, dport: 443, cust: c.id }));
      for (const n of fw.cfg.fw.zones.outside) fw.cfg.ifs[n].acl.in = 'OUTSIDE_IN';
      for (const n of fw.cfg.fw.zones.outside) fw.cfg.ifs[n].nameif = 'outside';
      fw.cfg.fw.zones.inside.forEach((n, i) => (fw.cfg.ifs[n].nameif = i ? `inside${i + 1}` : 'inside'));
    }
  } else if (edges[0] && (cores.length || accs.length)) {
    // Edge router does NAT
    const e = edges[0];
    if (has(e, 'nat')) {
      const keepInside = cores.length ? [] : e.cfg.nat?.inside || [];
      e.cfg.nat = { inside: keepInside, outside: Object.keys(e.cfg.ifs).filter((n) => e.cfg.ifs[n].zone === 'outside'), overload: true, statics: [] };
      for (const c of d.customers.filter((x) => x.web)) e.cfg.nat.statics.push({ int: world.hosts[c.servers[0]].ip, ext: c.vip, cust: c.id });
    }
  }

  // ---- Edge <-> core (no firewall) ----
  if (!fw && cores.length) {
    edges.forEach((e) => {
      cores.forEach((c, j) => {
        const t = transitFor(world, e.id, c.id);
        const pe = allocPort(world, e, `down:${c.id}`, { up: true });
        const pc = allocPort(world, c, `up:${e.id}`, { up: true });
        routedPair(world, e, pe, c, pc, t, `to-${c.hostname}`, `to-${e.hostname}`);
        if (e.cfg.nat) e.cfg.nat.inside.push(pe);
        if (d.routing === 'static') {
          if (j === 0) e.cfg.static.push({ pfx: '10.0.0.0/8', nh: t[c.id], ad: 1 });
          if (e === edges[0]) c.cfg.static.push({ pfx: '0.0.0.0/0', nh: t[e.id], ad: 1 });
        }
      });
    });
  }

  // ---- Core ----
  const fh = fhrpFor(cores);
  cores.forEach((c, j) => {
    c.cfg.ifs[OS[c.os].lo(0)] = { ...newIf('lo'), ip: `${loFor(world, c.id)}/32`, desc: 'Router ID' };
    c.cfg.stp.prio = {};
    for (const v of vlansAll) {
      ensureVlan(c, v, vlanName(world, v));
      c.cfg.stp.prio[v] = j === 0 ? 4096 : 8192;
      const svi = ensureSvi(c, v);
      const net = vlanNet(world, v);
      const ifc = c.cfg.ifs[svi];
      ifc.on = true;
      ifc.desc = vlanName(world, v);
      if (cores.length === 1) ifc.ip = `${net}.1/24`;
      else {
        ifc.ip = `${net}.${2 + j}/24`;
        ifc.fhrp = { proto: fh, grp: v % 255 || 1, vip: `${net}.1`, prio: j === 0 ? 110 : 100, preempt: true };
      }
      if ([OFFICE.wired, OFFICE.wifi, OFFICE.aps].includes(v)) ifc.helper = [SVC.dhcp];
    }
    ensureVlan(c, 1, 'default');
  });
  if (cores.length === 2) {
    const [c1, c2] = cores;
    const lagId = 1;
    const l1 = ensureLag(c1, lagId);
    const l2 = ensureLag(c2, lagId);
    setTrunk(c1.cfg.ifs[l1], vlansAll.slice(), 1);
    setTrunk(c2.cfg.ifs[l2], vlansAll.slice(), 1);
    c1.cfg.ifs[l1].desc = `ISL to ${c2.hostname}`;
    c2.cfg.ifs[l2].desc = `ISL to ${c1.hostname}`;
    for (const k of [1, 2]) {
      const p1 = allocPort(world, c1, `isl:${k}`, { up: true });
      const p2 = allocPort(world, c2, `isl:${k}`, { up: true });
      for (const [dev, p, peer] of [[c1, p1, c2], [c2, p2, c1]]) {
        const ifc = dev.cfg.ifs[p];
        setTrunk(ifc, vlansAll.slice(), 1);
        ifc.on = true;
        ifc.lag = { id: lagId, mode: 'active' };
        ifc.desc = `ISL to ${peer.hostname}`;
      }
      link(world, { dev: c1.id, if: p1 }, { dev: c2.id, if: p2 }, { type: 'dac', purpose: 'isl' });
    }
  }

  // ---- Access ----
  const custByAcc = assignCustomers(world, accs);
  accs.forEach((a, idx) => {
    const local = new Set([...(custByAcc.get(a.id) || []).map((c) => c.vlan)]);
    if (idx === 0) local.add(SVC.vlan);
    if (d.office.on && cores.length && idx === 0) [OFFICE.wired, OFFICE.wifi, OFFICE.aps].forEach((v) => local.add(v));
    if (!cores.length && idx === 0) vlansAll.forEach((v) => local.add(v));
    const vl = [...local].sort((x, y) => x - y);
    for (const v of vl) ensureVlan(a, v, vlanName(world, v));
    if (cores.length) {
      cores.forEach((c) => {
        const pa = allocPort(world, a, `up:${c.id}`, { up: true });
        const pc = allocPort(world, c, `down:${a.id}`, { up: false });
        for (const [dev, p, peer] of [[a, pa, c], [c, pc, a]]) {
          setTrunk(dev.cfg.ifs[p], vl.slice(), 1);
          dev.cfg.ifs[p].on = true;
          dev.cfg.ifs[p].desc = `uplink ${peer.hostname}`;
        }
        link(world, { dev: a.id, if: pa }, { dev: c.id, if: pc }, { type: 'om4', purpose: 'uplink' });
      });
    } else if (idx > 0 && accs[0]) {
      // Star from the first access switch
      const a0 = accs[0];
      const pa = allocPort(world, a, `up:${a0.id}`, { up: true });
      const p0 = allocPort(world, a0, `down:${a.id}`, { up: true });
      for (const [dev, p, peer] of [[a, pa, a0], [a0, p0, a]]) {
        setTrunk(dev.cfg.ifs[p], vlansAll.slice(), 1);
        dev.cfg.ifs[p].on = true;
        dev.cfg.ifs[p].desc = `link ${peer.hostname}`;
      }
      for (const v of vlansAll) ensureVlan(a, v, vlanName(world, v));
      link(world, { dev: a.id, if: pa }, { dev: a0.id, if: p0 }, { type: 'cat6', purpose: 'uplink' });
    }
    // Hosts
    const attach = (hid, vlan, purpose) => {
      const h = world.hosts[hid];
      const p = allocPort(world, a, purpose);
      if (!p) {
        d.warnings.push(`${a.hostname} is out of ports for ${h.name}.`);
        return;
      }
      const ifc = a.cfg.ifs[p];
      setAccess(ifc, vlan);
      ifc.on = true;
      ifc.desc = h.name;
      ifc.stp = { edge: true, bpduguard: true };
      const panel = { id: `PP-${a.hostname.toUpperCase()}`, port: Number(String(p).match(/(\d+)$/)?.[1] || 0) };
      link(world, { host: hid, if: 'eth0' }, { dev: a.id, if: p }, { type: 'cat6', purpose: 'server', panel });
      h.attach = a.id;
    };
    if (idx === 0) for (const hid of Object.keys(world.hosts).filter((x) => world.hosts[x].kind === 'svc')) attach(hid, SVC.vlan, `srv:${hid}`);
    for (const c of custByAcc.get(a.id) || []) for (const hid of c.servers) attach(hid, c.vlan, `srv:${hid}`);
  });

  // ---- Customer gateway on an edge router (no core) ----
  // (handled by routerOnAStick)

  // ---- Routing: OSPF ----
  if (d.routing === 'ospf') {
    for (const dev of [...edges, ...fws, ...cores]) {
      dev.cfg.ospf = { on: true, pid: 1, rid: loFor(world, dev.id), defOrig: dev.role === 'edge', ref: 100 };
      for (const [n, ifc] of Object.entries(dev.cfg.ifs)) {
        if (!ifc.ip || ifc.mgmt || ifc.vrf || n === dev.meta.mgmtSvi) continue;
        if (dev.role === 'edge' && /transit \(AS/.test(ifc.desc)) continue;
        const transit = ifc.kind !== 'svi' && ifc.kind !== 'lo';
        ifc.ospf = { area: '0.0.0.0', cost: null, hello: 10, dead: 40, passive: !transit };
      }
    }
  }

  // ---- Office / wireless ----
  if (d.office.on && cores.length && accs.length) {
    const wlc = wlcs[0];
    if (wlc) {
      ensureVlan(wlc, OFFICE.aps, 'AP-MGMT');
      ensureVlan(wlc, OFFICE.wifi, 'WIFI-STAFF');
      const p = allocPort(world, wlc, `up:${cores[0].id}`, { up: true });
      setTrunk(wlc.cfg.ifs[p], [OFFICE.wifi, OFFICE.aps], 1);
      wlc.cfg.ifs[p].on = true;
      wlc.cfg.ifs[p].desc = `uplink ${cores[0].hostname}`;
      const pc = allocPort(world, cores[0], `down:${wlc.id}`);
      setTrunk(cores[0].cfg.ifs[pc], [OFFICE.wifi, OFFICE.aps], 1);
      cores[0].cfg.ifs[pc].on = true;
      cores[0].cfg.ifs[pc].desc = `uplink ${wlc.hostname}`;
      link(world, { dev: wlc.id, if: p }, { dev: cores[0].id, if: pc }, { type: 'om4', purpose: 'uplink' });
      const svi = ensureSvi(wlc, OFFICE.aps);
      wlc.cfg.ifs[svi].ip = `10.32.0.5/24`;
      wlc.cfg.static.push({ pfx: '0.0.0.0/0', nh: '10.32.0.1', ad: 1 });
      wlc.cfg.wlc = { ssids: [{ name: d.office.ssid, essid: d.office.essid, vlan: OFFICE.wifi, auth: 'wpa2-ent', radius: 'RAD-1', mode: 'bridge' }], radius: [{ name: 'RAD-1', ip: SVC.radius, key: 'R4dius-Key' }] };
    }
    const a0 = accs[0];
    aps.forEach((ap, i) => {
      const p = allocPort(world, a0, `ap:${ap.id}`);
      setTrunk(a0.cfg.ifs[p], [OFFICE.wifi, OFFICE.aps], OFFICE.aps);
      a0.cfg.ifs[p].on = true;
      a0.cfg.ifs[p].desc = ap.hostname;
      const apPort = Object.keys(ap.cfg.ifs)[0];
      ap.cfg.ifs[apPort].on = true;
      ap.cfg.ap = { ctrl: wlc ? '10.32.0.5' : null, group: 'default', ip: `10.32.0.${50 + i}` };
      link(world, { dev: ap.id, if: apPort }, { dev: a0.id, if: p }, { type: 'cat6', purpose: 'ap' });
    });
    if (!wlc && aps.length) d.warnings.push('Access points need a wireless controller.');
  }

  // Unused physical ports stay as they were (default state). Save every config as startup.
  for (const dev of all) saveStartup(dev, world.time.t);
  delete world._oldLinks;
  world.dirty = true;
  makeDocErrors(world);
  return d.warnings;
}

function routedPair(world, a, pa, b, pb, t, descA, descB) {
  for (const [dev, p, desc] of [[a, pa, descA], [b, pb, descB]]) {
    const ifc = dev.cfg.ifs[p];
    setRouted(ifc, `${t[dev.id]}/30`);
    ifc.on = true;
    ifc.desc = desc;
  }
  link(world, { dev: a.id, if: pa }, { dev: b.id, if: pb }, { type: 'om4', purpose: 'transit' });
}

function routerOnAStick(world, e, acc, vlans) {
  if (!acc) return;
  const p = allocPort(world, e, `down:${acc.id}`, { up: true });
  const pa = allocPort(world, acc, `up:${e.id}`, { up: true });
  const base = e.cfg.ifs[p];
  setRouted(base, null);
  base.on = true;
  base.desc = `trunk to ${acc.hostname}`;
  if (e.cfg.nat) e.cfg.nat.inside = [];
  for (const v of vlans) {
    const sub = OS[e.os].sub(p, v);
    e.cfg.ifs[sub] = { ...newIf('sub'), parent: p, vlan: v, ip: `${vlanNet(world, v)}.1/24`, desc: vlanName(world, v) };
  }
  setTrunk(acc.cfg.ifs[pa], vlans.slice(), 1);
  acc.cfg.ifs[pa].on = true;
  acc.cfg.ifs[pa].desc = `uplink ${e.hostname}`;
  link(world, { dev: e.id, if: p }, { dev: acc.id, if: pa }, { type: 'cat6', purpose: 'uplink' });
  e.meta.subParent = p;
  // NAT inside = all sub-interfaces
  if (model(e.model).feat.includes('nat')) {
    e.cfg.nat = e.cfg.nat || { inside: [], outside: [], overload: true, statics: [] };
    e.cfg.nat.inside = vlans.map((v) => OS[e.os].sub(p, v));
    e.cfg.nat.outside = Object.keys(e.cfg.ifs).filter((n) => e.cfg.ifs[n].zone === 'outside' || /transit/.test(e.cfg.ifs[n].desc));
    e.cfg.nat.overload = true;
    e.cfg.nat.statics = world.design.customers.filter((c) => c.web).map((c) => ({ int: world.hosts[c.servers[0]].ip, ext: c.vip, cust: c.id }));
  }
}

function assignCustomers(world, accs) {
  const map = new Map(accs.map((a) => [a.id, []]));
  if (!accs.length) return map;
  const per = accs.map((a) => ({ a, free: portPool(a).length - 4 }));
  for (const c of world.design.customers) {
    // Keep previous placement if still valid
    const prev = Object.entries(world.design.ports).find(([dev, ports]) => map.has(dev) && ports[`srv:${c.servers[0]}`]);
    const slot = prev ? per.find((x) => x.a.id === prev[0]) : per.find((x) => x.free >= c.servers.length);
    const target = slot || per[per.length - 1];
    map.get(target.a.id).push(c);
    target.free -= c.servers.length;
  }
  return map;
}

export function vlanNet(world, v) {
  if (v === SVC.vlan) return SVC.net;
  if (v === OFFICE.wired) return '10.30.0';
  if (v === OFFICE.wifi) return '10.31.0';
  if (v === OFFICE.aps) return '10.32.0';
  const c = world.design.customers.find((x) => x.vlan === v);
  return c ? `10.100.${c.k}` : `10.${Math.floor(v / 256)}.${v % 256}.0`.split('.').slice(0, 3).join('.');
}
export function vlanName(world, v) {
  if (v === SVC.vlan) return 'SERVICES';
  if (v === OFFICE.wired) return 'OFFICE-WIRED';
  if (v === OFFICE.wifi) return 'WIFI-STAFF';
  if (v === OFFICE.aps) return 'AP-MGMT';
  if (v === MGMT_VLAN) return 'MGMT';
  const c = world.design.customers.find((x) => x.vlan === v);
  return c ? `CUST-${c.slug.toUpperCase()}` : `VLAN${String(v).padStart(4, '0')}`;
}

function ensureInfraHosts(world, isps) {
  const H = world.hosts;
  H.jump = H.jump || { id: 'jump', name: 'jump01', kind: 'jump', ip: `${MGMT_NET}.10`, len: 24, gw: null, listen: [22], nic: { up: true, speed: 'auto', duplex: 'auto' } };
  const svc = [
    ['dns', 'dns01', SVC.dns, [53]],
    ['ntp', 'ntp01', SVC.ntp, [123]],
    ['syslog', 'log01', SVC.syslog, [514]],
    ['nms', 'nms01', SVC.nms, [161, 443]],
    ['dhcp', 'dhcp01', SVC.dhcp, [67]],
    ['radius', 'radius01', SVC.radius, [1812]],
  ];
  for (const [id, name, ip, listen] of svc) H[`svc-${id}`] = H[`svc-${id}`] || { id: `svc-${id}`, name, kind: 'svc', role: id, ip, len: 24, gw: `${SVC.net}.1`, listen, nic: { up: true, speed: 'auto', duplex: 'auto' }, watts: 200 };
  for (const isp of ISP_DEFS) {
    if (isps.includes(isp)) H[isp.id] = H[isp.id] || { id: isp.id, name: isp.name, kind: 'isp', ip: isp.peer, len: 30, asn: isp.asn, ours: isp.ours, nic: { up: true, speed: 'auto', duplex: 'auto' }, bgpUp: true, sendsFullTable: false };
    else delete H[isp.id];
  }
}

// ---------- documentation drift (wrong/stale records scale with difficulty) ----------
const DOC_ERR_RATE = { entry: 0, associate: 0.04, professional: 0.1, expert: 0.18 };
export function makeDocErrors(world) {
  const d = world.design;
  const rate = DOC_ERR_RATE[world.difficulty] ?? 0;
  const r = rng(`docs:${world.seed}:${d.customers.length}:${Object.keys(world.devices).length}`);
  const errs = [];
  if (rate > 0) {
    for (const [devId, ip] of Object.entries(d.mgmt)) if (r.chance(rate)) errs.push({ doc: 'ipam', kind: 'mgmt', dev: devId, wrong: ip.replace(/\.(\d+)$/, (_, n) => `.${(Number(n) % 200) + 30}`) });
    for (const c of d.customers) if (r.chance(rate)) errs.push({ doc: 'ipam', kind: 'vlan', cust: c.id, wrong: c.vlan + (r.chance(0.5) ? 1 : 10) });
    for (const l of world.links) if (l.purpose === 'server' && r.chance(rate)) errs.push({ doc: 'patch', link: l.id, wrong: r.int(1, 24) });
    for (const l of world.links) if (['uplink', 'transit'].includes(l.purpose) && r.chance(rate / 2)) errs.push({ doc: 'topo', link: l.id, kind: r.chance(0.5) ? 'missing' : 'wrongport' });
  }
  d.docErrors = errs;
}

export const vaultOf = (world, devId) => world.design.vault[devId];
export const maskOf = (len) => maskStr(len);
export const ipNum = ip2n;
export const numIp = n2ip;
