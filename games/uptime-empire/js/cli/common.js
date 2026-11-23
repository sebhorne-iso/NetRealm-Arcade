// Helpers shared by every dialect: reachability tests, interface counters/optics, natural sorting,
// configuration bookkeeping and lookups.
import { walk, two, compute } from '../net/sim.js';
import { touch, saveStartup } from '../net/model.js';
import { model, OS } from '../net/catalog.js';
import { rng, hashStr, macFor, cidr } from '../core/util.js';
import { logEvent, recompute } from '../net/events.js';

export const S_ = (world) => {
  if (world.dirty || !world.sim) recompute(world);
  return world.sim;
};

// Natural sort for interface names: Gi1/0/2 < Gi1/0/10
export function natCmp(a, b) {
  const ax = String(a).split(/(\d+)/);
  const bx = String(b).split(/(\d+)/);
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const x = ax[i] ?? '';
    const y = bx[i] ?? '';
    if (x === y) continue;
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny) && x !== '' && y !== '') return nx - ny;
    return x < y ? -1 : 1;
  }
  return 0;
}
const KIND_ORDER = { mgmt: 0, phys: 1, serial: 1, lag: 2, lo: 3, svi: 4, sub: 1 };
export function sortedIfs(dev, filter = () => true) {
  return Object.keys(dev.cfg.ifs)
    .filter((n) => filter(dev.cfg.ifs[n], n))
    .sort((a, b) => (KIND_ORDER[dev.cfg.ifs[a].kind] ?? 5) - (KIND_ORDER[dev.cfg.ifs[b].kind] ?? 5) || natCmp(a, b));
}
export const physIfs = (dev) => sortedIfs(dev, (i) => ['phys', 'serial', 'mgmt'].includes(i.kind));

// The configuration a session edits (candidate for commit-model OSes, running otherwise)
export const cfgOf = (s) => s.cand || s.dev.cfg;

// Record a change made through the CLI on the running config
export function changed(s) {
  if (s.cand) {
    s.candDirty = true;
    return;
  }
  touch(s.dev, s.world, s.user, s.via === 'console' ? 'console' : 'vty0');
  s.world.dirty = true;
  s.cfgTouched = true;
  // FortiOS writes every change straight to flash; there is no separate startup configuration
  if (['fortios', 'fortiswitch'].includes(s.dev.os)) saveStartup(s.dev, s.world.time.t);
}
// Called when a configuration session ends (IOS "end", Junos "commit" ...)
export function configEnded(s) {
  if (!s.cfgTouched) return;
  s.cfgTouched = false;
  logEvent(s.world, s.dev.id, { type: 'config', by: s.user, via: s.via, from: s.from?.host?.ip || s.world.hosts.jump?.ip });
  recompute(s.world);
}
export function commitApply(s, cfg, comment) {
  const dev = s.dev;
  dev.run.rollback.unshift({ t: s.world.time.t, by: s.user, cfg: JSON.parse(JSON.stringify(dev.cfg)), comment: comment || null, via: s.via });
  if (dev.run.rollback.length > 49) dev.run.rollback.pop();
  dev.cfg = JSON.parse(JSON.stringify(cfg));
  saveStartup(dev, s.world.time.t); // commit-model platforms: a commit is persistent
  touch(dev, s.world, s.user, s.via);
  logEvent(s.world, dev.id, { type: 'commit', by: s.user, via: s.via, comment });
  recompute(s.world);
}

// ---------------------------------------------------------------------------------------------
// Reachability (ping / traceroute data); every dialect formats it in its own way
let pingSeq = 0;
export function ping(s, dst, { count = 5, size = 100, df = false, src = null, vrf = null, proto = 'icmp', dport = null } = {}) {
  S_(s.world);
  const from = s.dev ? { dev: s.dev.id, ip: src, vrf } : { host: s.host.id };
  const r = two(s.world, from, dst, { size, df, proto, dport });
  const R = rng(`ping:${s.world.time.t}:${pingSeq++}:${dst}`);
  const res = [];
  let arpMiss = false;
  if (r.ok && s.dev) {
    s.dev.run.arp = s.dev.run.arp || {};
    const key = `${dst}`;
    const seen = s.dev.run.arp[key];
    if ((!seen || s.world.time.t - seen > 240) && OS[s.dev.os]?.family === 'cisco' && r.hops.length <= 1) arpMiss = true;
    s.dev.run.arp[key] = s.world.time.t;
  }
  for (let i = 0; i < count; i++) {
    if (!r.ok) res.push({ ok: false });
    else if (i === 0 && arpMiss) res.push({ ok: false });
    else if (R.next() * 100 < r.loss) res.push({ ok: false });
    else res.push({ ok: true, rtt: Math.max(1, Math.round(r.rtt + R.next() * r.rtt * 0.6 + (r.loss ? R.int(0, 40) : 0))) });
  }
  const oks = res.filter((x) => x.ok);
  const rtts = oks.map((x) => x.rtt);
  return {
    r,
    res,
    sent: count,
    recv: oks.length,
    pct: Math.round((oks.length / count) * 100),
    min: rtts.length ? Math.min(...rtts) : 0,
    max: rtts.length ? Math.max(...rtts) : 0,
    avg: rtts.length ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length) : 0,
    unreach: !r.ok && /no route|unreachable|not a router/.test(r.reason) ? r.reason : null,
    srcIp: r.pkt?.src || src,
  };
}
// Hops for traceroute: [{ip, name, ok}]; stops at failure
export function trace(s, dst, opts = {}) {
  S_(s.world);
  const from = s.dev ? { dev: s.dev.id, vrf: opts.vrf || null } : { host: s.host.id };
  const r = walk(s.world, from, dst, opts);
  const hops = [];
  for (const h of r.hops) {
    if (h.isp) {
      hops.push({ ip: h.ip, name: h.name, ok: true });
      continue;
    }
    if (h.dev && s.dev && h.dev === s.dev.id) continue;
    hops.push({ ip: h.ip, name: s.world.devices[h.dev]?.hostname, ok: true, dev: h.dev });
  }
  if (r.ok) {
    if (r.at === 'internet') {
      hops.push({ ip: '100.64.12.1', name: 'core1.transit.example', ok: true });
      hops.push({ ip: dst, name: null, ok: true });
    } else if (!r.toDevice || hops[hops.length - 1]?.ip !== dst) hops.push({ ip: dst, ok: true });
  } else hops.push({ ok: false, reason: r.reason });
  // Back path must also work for replies to arrive
  if (r.ok) {
    const back = two(s.world, from, dst, opts);
    if (!back.ok) {
      hops.length = 0;
      hops.push({ ok: false, reason: back.reason });
    }
  }
  return { r, hops };
}

// ---------------------------------------------------------------------------------------------
// Interface counters derived from utilisation, errors and time since "clear counters"
export function counters(world, dev, ifn) {
  const S = S_(world);
  const st = S.ifs[dev.id]?.[ifn];
  const link = st?.link ? S.links[st.link] : null;
  const c = (dev.run.counters[ifn] = dev.run.counters[ifn] || { clear: dev.run.boot, crcBase: 0 });
  const mins = Math.max(0, world.time.t - Math.max(c.clear, dev.run.boot));
  const util = link?.up ? Math.max(0.05, link.util || 0.2) : 0;
  const h = hashStr(`${dev.id}:${ifn}`) % 1000;
  const inB = Math.floor(util * 1e6 * 60 * mins * 0.08 * (0.9 + h / 5000));
  const outB = Math.floor(inB * (0.55 + (h % 37) / 100));
  const err = link?.up ? link.errors || 0 : 0;
  const crc = (c.crcBase || 0) + Math.floor(err * mins * (11 + (h % 13)));
  const pps = link?.up ? Math.round(util * 1e6 / 8 / 700) : 0;
  return {
    inB,
    outB,
    inP: Math.floor(inB / 640),
    outP: Math.floor(outB / 610),
    inMc: Math.floor(mins * 3.1),
    outMc: Math.floor(mins * 2.2),
    bcast: Math.floor(mins * 0.6),
    crc,
    inErr: crc + Math.floor(crc / 9),
    outErr: link?.duplex === 'mismatch' ? Math.floor(crc / 3) : 0,
    coll: link?.duplex === 'mismatch' ? Math.floor(crc * 1.7) : 0,
    late: link?.duplex === 'mismatch' ? Math.floor(crc / 2) : 0,
    runts: link?.duplex === 'mismatch' ? Math.floor(crc / 4) : 0,
    drops: S.stormSegs?.size ? Math.floor(mins * 400) : 0,
    rateIn: Math.round(util * 1e6 * (link?.up ? 1 : 0)),
    rateOut: Math.round(util * 1e6 * 0.62 * (link?.up ? 1 : 0)),
    ppsIn: pps,
    ppsOut: Math.round(pps * 0.7),
    resets: c.resets || 0,
    lastClear: c.clear,
    mins,
  };
}
export function clearCounters(world, dev, ifn = null) {
  for (const n of ifn ? [ifn] : Object.keys(dev.cfg.ifs)) dev.run.counters[n] = { clear: world.time.t, crcBase: 0 };
}
// DOM optics for a port (dBm)
export function optics(dev, ifn) {
  const ifc = dev.cfg.ifs[ifn];
  const media = ifc?.hw?.media || 'rj45';
  if (!/sfp|qsfp|xfp|gbic|fiber|smf|mmf/i.test(media)) return null;
  const o = dev.hw.optics?.[ifn] || {};
  const h = hashStr(`${dev.id}:${ifn}`) % 100;
  return { temp: o.temp ?? 31 + (h % 9), volt: 3.29, bias: o.bias ?? 6.1 + (h % 20) / 10, tx: o.tx ?? -2.2 + (h % 10) / 10, rx: o.dead ? -40 : o.rx ?? -2.9 - (h % 15) / 10, dead: !!o.dead, type: speedOptic(ifc.hw.speed, media) };
}
function speedOptic(speed, media) {
  if (speed >= 400000) return 'QSFP-DD-400G-DR4';
  if (speed >= 100000) return 'QSFP-100G-SR4';
  if (speed >= 40000) return 'QSFP-40G-SR4';
  if (speed >= 25000) return 'SFP-25G-SR-S';
  if (speed >= 10000) return 'SFP-10G-SR';
  return /smf|lx/i.test(media) ? '1000BASE-LX' : '1000BASE-SX';
}

// Who owns an IP (device interface, mgmt address or host)
export function ownerOf(world, ip) {
  for (const dev of Object.values(world.devices)) for (const [n, i] of Object.entries(dev.cfg.ifs)) if (i.ip && i.ip.split('/')[0] === ip) return { dev, if: n };
  for (const dev of Object.values(world.devices)) if (dev.cfg.ap?.ip === ip) return { dev, if: null };
  for (const h of Object.values(world.hosts)) if (h.ip === ip) return { host: h };
  return null;
}
export const peerName = (world, end) => (end?.dev ? world.devices[end.dev]?.hostname : world.hosts[end?.host]?.name);

// Neighbour discovery (CDP / LLDP): directly cabled devices whose link is up
export function neighbours(world, dev) {
  const S = S_(world);
  const out = [];
  for (const [n, st] of Object.entries(S.ifs[dev.id] || {})) {
    if (!st.up || !st.peer) continue;
    const p = st.peer;
    if (p.dev) {
      const pd = world.devices[p.dev];
      out.push({ local: n, dev: pd, port: p.if, platform: model(pd.model).name, caps: pd.role === 'access' || pd.role === 'oob' ? 'S I' : pd.role === 'core' ? 'R S I' : 'R', ip: world.design.mgmt[pd.id] || null });
    } else if (p.host) {
      const h = world.hosts[p.host];
      if (h.kind === 'server' || h.kind === 'svc') out.push({ local: n, host: h, port: 'eth0', platform: 'Linux', caps: 'H', ip: h.ip, lldpOnly: true });
    }
  }
  return out;
}

export const macOfIf = (dev, ifn) => macFor(`${dev.id}:${ifn}`);
export const macOfHost = (h) => macFor(`host:${h.id}`);
export const devMac = (dev) => macFor(`${dev.id}:base`);

// Connected L3 neighbours (ARP table entries) for a device
export function arpTable(world, dev) {
  const S = S_(world);
  const out = [];
  for (const ep of S.epsByDev.get(dev.id) || []) {
    if (!ep.up || ep.vip || ep.ap) continue;
    out.push({ ip: ep.ip, mac: macOfIf(dev, ep.if), if: ep.if, age: '-', self: true });
    for (const o of S.bySeg.get(ep.seg) || []) {
      if (o === ep || (o.dev === dev.id)) continue;
      if (dev.run.arp && !dev.run.arp[o.ip] && !o.vip && hashStr(o.ip) % 3 === 0) continue;
      out.push({ ip: o.ip, mac: o.host ? macOfHost(world.hosts[o.host]) : o.vip ? `0000.0c07.ac${(o.ip.split('.')[2] % 255).toString(16).padStart(2, '0')}` : macOfIf(world.devices[o.dev], o.if), if: ep.if, age: String(hashStr(o.ip + dev.id) % 200) });
    }
  }
  return out;
}

// MAC address table for a switch
export function macTable(world, dev) {
  const S = S_(world);
  const out = [];
  for (const [n, st] of Object.entries(S.ifs[dev.id] || {})) {
    const ifc = dev.cfg.ifs[n];
    if (!st.up || !ifc?.sw || ifc.lag) continue;
    const vl = ifc.sw.mode === 'access' ? [ifc.sw.vlan] : [];
    const p = st.peer;
    if (p?.host) {
      const h = world.hosts[p.host];
      out.push({ vlan: ifc.sw.mode === 'access' ? ifc.sw.vlan : ifc.sw.native, mac: macOfHost(h), port: n, type: 'DYNAMIC' });
    } else if (p?.dev) {
      const pd = world.devices[p.dev];
      for (const v of ifc.sw.mode === 'trunk' ? (ifc.sw.allowed === 'all' ? Object.keys(dev.cfg.vlans).map(Number) : ifc.sw.allowed).slice(0, 6) : vl) if (v in dev.cfg.vlans) out.push({ vlan: v, mac: devMac(pd), port: n, type: 'DYNAMIC' });
    }
  }
  for (const [n, ifc] of Object.entries(dev.cfg.ifs)) if (ifc.kind === 'lag' && S.lags[dev.id]?.[n]?.up) out.push({ vlan: 1, mac: macFor(`lagpeer:${dev.id}:${n}`), port: n, type: 'DYNAMIC' });
  return out.sort((a, b) => a.vlan - b.vlan);
}

export function uptimeMins(world, dev) {
  return Math.max(0, world.time.t - dev.run.boot);
}

export const ipOnly = (x) => (x ? String(x).split('/')[0] : null);
export const lenOf = (x) => (x ? Number(String(x).split('/')[1] ?? 32) : null);
export const netOf = (x) => {
  const c = cidr(x);
  return c ? c : null;
};
export { compute };
