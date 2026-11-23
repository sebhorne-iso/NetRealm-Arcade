// Juniper Junos OS / Junos OS Evolved (MX, PTX, ACX, EX, QFX, SRX).
// Canonical config <-> "set" statements; hierarchical view is built from the set statements.
// Candidate configuration with commit / commit confirmed / rollback / show | compare.
import { compile, ask, stream, genStream, tokenize } from './engine.js';
import { model } from '../net/catalog.js';
import { ensureVlan, newIf } from '../net/model.js';
import { S_, cfgOf, ping, trace, counters, optics, sortedIfs, physIfs, uptimeMins, ipOnly, lenOf, commitApply, neighbours, arpTable, macTable, macOfIf } from './common.js';
import { lookup, walk } from '../net/sim.js';
import { reload } from '../net/devops.js';
import { logEvent } from '../net/events.js';
import { cidr, n2ip, ip2n, isIp, inNet, fmtDate, upJunos, padR, padL, hashStr, yearOf, macColon, parseVlans, diffLines, deep } from '../core/util.js';

const isSw = (dev) => model(dev.model).feat.includes('l2');
const isFw = (dev) => model(dev.model).feat.includes('fw');
const Z = (z) => (z === 'inside' ? 'trust' : z === 'outside' ? 'untrust' : z);
const ZC = (z) => (z === 'trust' ? 'inside' : z === 'untrust' ? 'outside' : z);
const q = (s) => (/[\s;{}]/.test(s) ? `"${s}"` : s);
const PRIO = (p) => (p % 1024 === 0 && p >= 4096 ? `${p / 1024}k` : String(p));
const unPrio = (x) => (/k$/.test(x) ? Number(x.slice(0, -1)) * 1024 : Number(x));
const ifu = (dev, n) => {
  const i = dev.cfg.ifs[n] || {};
  if (i.kind === 'svi' || i.kind === 'sub') return n.includes('.') ? n : `${n}.0`;
  return `${n}.0`;
};
function canon(dev, cfg, name) {
  if (cfg.ifs[name]) return name;
  const base = name.replace(/\.0$/, '');
  if (cfg.ifs[base]) return base;
  return null;
}
const vlanName = (cfg, v) => (v === 1 ? 'default' : cfg.vlans[v] || `VLAN${v}`);
const vlanId = (cfg, name) => {
  if (/^\d+$/.test(name)) return Number(name);
  if (name === 'default') return 1;
  const hit = Object.entries(cfg.vlans).find(([, n]) => n === name);
  return hit ? Number(hit[0]) : null;
};

// =============================================================================================
// canonical -> set statements
export function toSet(dev, cfg) {
  const L = [];
  const add = (x) => L.push(x);
  add(`version ${dev.version}`);
  add(`system host-name ${cfg.hostname}`);
  add('system root-authentication encrypted-password "$6$rounds=5000$' + hashStr(dev.id).toString(36) + '"');
  for (const u of cfg.svc.users) {
    add(`system login user ${u.name} uid ${2000 + cfg.svc.users.indexOf(u)}`);
    add(`system login user ${u.name} class super-user`);
    add(`system login user ${u.name} authentication encrypted-password "$6$${hashStr(u.pw).toString(36)}$${hashStr(u.pw + 'j').toString(36)}"`);
  }
  if (cfg.svc.ssh) add('system services ssh root-login deny');
  if (cfg.svc.telnet) add('system services telnet');
  add('system services netconf ssh');
  if (cfg.svc.domain) add(`system domain-name ${cfg.svc.domain}`);
  for (const d of cfg.svc.dns) add(`system name-server ${d}`);
  for (const h of cfg.svc.syslog) add(`system syslog host ${h} any notice`);
  add('system syslog file messages any notice');
  add('system syslog file interactive-commands interactive-commands any');
  for (const n of cfg.svc.ntp) add(`system ntp server ${n}`);
  const lags = Object.values(cfg.ifs).filter((i) => i.kind === 'lag');
  if (lags.length) add(`chassis aggregated-devices ethernet device-count ${lags.length}`);
  const swFamily = (n, i, unit = 0) => {
    if (i.sw.mode === 'trunk' && i.sw.native != null && i.sw.native !== 1) add(`interfaces ${n} native-vlan-id ${i.sw.native}`);
    add(`interfaces ${n} unit ${unit} family ethernet-switching interface-mode ${i.sw.mode}`);
    const mem = i.sw.mode === 'access' ? [vlanName(cfg, i.sw.vlan)] : i.sw.allowed === 'all' ? ['all'] : i.sw.allowed.map((v) => vlanName(cfg, v));
    add(`interfaces ${n} unit ${unit} family ethernet-switching vlan members ${mem.length > 1 ? `[ ${mem.join(' ')} ]` : mem[0] || 'none'}`);
  };
  for (const n of sortedIfs(dev, () => true)) {
    const i = cfg.ifs[n];
    if (!i) continue;
    if (i.kind === 'svi') {
      const u = i.vlan;
      if (i.desc) add(`interfaces irb unit ${u} description ${q(i.desc)}`);
      if (!i.on) add(`interfaces irb unit ${u} disable`);
      if (i.ip) {
        add(`interfaces irb unit ${u} family inet address ${i.ip}`);
        if (i.fhrp) {
          const b = `interfaces irb unit ${u} family inet address ${i.ip} vrrp-group ${i.fhrp.grp}`;
          add(`${b} virtual-address ${i.fhrp.vip}`);
          add(`${b} priority ${i.fhrp.prio}`);
          if (!i.fhrp.preempt) add(`${b} no-preempt`);
          add(`${b} accept-data`);
        }
      }
      if (i.acl?.in) add(`interfaces irb unit ${u} family inet filter input ${i.acl.in}`);
      continue;
    }
    if (i.kind === 'sub') {
      add(`interfaces ${i.parent} vlan-tagging`);
      add(`interfaces ${i.parent} unit ${i.vlan} vlan-id ${i.vlan}`);
      if (i.ip) add(`interfaces ${i.parent} unit ${i.vlan} family inet address ${i.ip}`);
      continue;
    }
    if (i.desc) add(`interfaces ${n} description ${q(i.desc)}`);
    if (!i.on) add(`interfaces ${n} disable`);
    if (i.mtu && i.mtu !== 1500) add(`interfaces ${n} mtu ${i.mtu}`);
    if (i.kind === 'phys' && i.speed !== 'auto') add(isSw(dev) ? `interfaces ${n} ether-options speed ${i.speed >= 1000 ? `${i.speed / 1000}g` : `${i.speed}m`}` : `interfaces ${n} speed ${i.speed >= 1000 ? `${i.speed / 1000}g` : `${i.speed}m`}`);
    if (i.kind === 'phys' && i.duplex !== 'auto') add(`interfaces ${n} ${isSw(dev) ? 'ether-options ' : ''}link-mode ${i.duplex}-duplex`);
    if (i.lag) {
      add(`interfaces ${n} ${isSw(dev) ? 'ether-options' : 'gigether-options'} 802.3ad ae${i.lag.id}`);
      continue;
    }
    if (i.kind === 'lag') {
      const mem = Object.values(cfg.ifs).find((x) => x.lag?.id === i.lagId);
      if (mem && mem.lag.mode !== 'on') add(`interfaces ${n} aggregated-ether-options lacp ${mem.lag.mode === 'passive' ? 'passive' : 'active'}`);
    }
    if (i.sw && isSw(dev) && i.kind !== 'mgmt') swFamily(n, i);
    else if (i.ip) {
      add(`interfaces ${n} unit 0 family inet address ${i.ip}`);
      if (i.acl?.in) add(`interfaces ${n} unit 0 family inet filter input ${i.acl.in}`);
      if (i.acl?.out) add(`interfaces ${n} unit 0 family inet filter output ${i.acl.out}`);
    }
  }
  if (Object.values(cfg.ifs).some((i) => i.helper?.length)) {
    const servers = [...new Set(Object.values(cfg.ifs).flatMap((i) => i.helper || []))];
    for (const h of servers) add(`forwarding-options dhcp-relay server-group DHCP ${h}`);
    add('forwarding-options dhcp-relay group RELAY active-server-group DHCP');
    for (const [n, i] of Object.entries(cfg.ifs)) if (i.helper?.length) add(`forwarding-options dhcp-relay group RELAY interface ${ifu(dev, n)}`);
  }
  if (cfg.svc.snmp) add(`snmp community ${cfg.svc.snmp} authorization read-only`);
  for (const [name, entries] of Object.entries(cfg.acls)) entries.forEach((e, k) => {
    const t = `firewall family inet filter ${name} term t${(k + 1) * 10}`;
    if (e.src && e.src !== 'any') add(`${t} from source-address ${e.src}`);
    if (e.dst && e.dst !== 'any') add(`${t} from destination-address ${e.dst}`);
    if (e.proto && e.proto !== 'ip') add(`${t} from protocol ${e.proto}`);
    if (e.dport) add(`${t} from destination-port ${e.dport}`);
    add(`${t} then ${e.act === 'permit' ? 'accept' : 'discard'}`);
  });
  const rid = cfg.ospf.rid || cfg.bgp.rid;
  if (rid) add(`routing-options router-id ${rid}`);
  if (cfg.bgp.on) add(`routing-options autonomous-system ${cfg.bgp.asn}`);
  for (const r of cfg.static) {
    if (r.iface === 'Null0' || r.iface === 'discard') add(`routing-options static route ${r.pfx} discard`);
    else add(`routing-options static route ${r.pfx} next-hop ${r.nh}`);
    if (r.ad && ![1, 5, 254].includes(r.ad)) add(`routing-options static route ${r.pfx} preference ${r.ad}`);
  }
  if (cfg.mgmtGw) add(`routing-instances mgmt_junos routing-options static route 0.0.0.0/0 next-hop ${cfg.mgmtGw.ip}`);
  if (cfg.ospf.on) {
    if (cfg.ospf.defOrig) add('protocols ospf export DEFAULT-ORIGINATE');
    for (const [n, i] of Object.entries(cfg.ifs)) {
      if (i.ospf?.area == null) continue;
      const b = `protocols ospf area ${i.ospf.area} interface ${ifu(dev, n)}`;
      const extra = [];
      if (i.ospf.passive) extra.push('passive');
      if (i.ospf.cost) extra.push(`metric ${i.ospf.cost}`);
      if (i.ospf.hello && i.ospf.hello !== 10) extra.push(`hello-interval ${i.ospf.hello}`);
      if (i.ospf.dead && i.ospf.dead !== 40) extra.push(`dead-interval ${i.ospf.dead}`);
      if (i.ospf.auth) extra.push(`authentication simple-password "${i.ospf.auth}"`);
      if (i.ospf.p2p) extra.push('interface-type p2p');
      if (!extra.length) add(b);
      for (const x of extra) add(`${b} ${x}`);
    }
  }
  if (cfg.bgp.on) {
    add('protocols bgp group TRANSIT type external');
    if (cfg.bgp.nets.length) add('protocols bgp group TRANSIT export ADVERTISE');
    for (const nb of cfg.bgp.nbrs) {
      const b = `protocols bgp group TRANSIT neighbor ${nb.ip}`;
      if (nb.desc) add(`${b} description ${q(nb.desc)}`);
      if (nb.maxpfx) {
        add(`${b} family inet unicast prefix-limit maximum ${nb.maxpfx}`);
        add(`${b} family inet unicast prefix-limit teardown`);
      }
      add(`${b} peer-as ${nb.ras}`);
    }
  }
  if (isSw(dev) && cfg.stp.on) {
    const prios = Object.values(cfg.stp.prio);
    add('protocols rstp');
    if (prios.length) add(`protocols rstp bridge-priority ${PRIO(Math.min(...prios))}`);
    for (const [n, i] of Object.entries(cfg.ifs)) if (i.stp?.edge && i.sw) add(`protocols rstp interface ${n} edge`);
  }
  for (const [n, i] of Object.entries(cfg.ifs)) if (i.stp?.bpduguard && i.sw) add(`protocols layer2-control bpdu-block interface ${n}`);
  add('protocols lldp interface all');
  if (cfg.ospf.defOrig) {
    add('policy-options policy-statement DEFAULT-ORIGINATE term 1 from route-filter 0.0.0.0/0 exact');
    add('policy-options policy-statement DEFAULT-ORIGINATE term 1 then accept');
  }
  if (cfg.bgp.on && cfg.bgp.nets.length) {
    for (const n of cfg.bgp.nets) add(`policy-options policy-statement ADVERTISE term 1 from route-filter ${n} exact`);
    add('policy-options policy-statement ADVERTISE term 1 then accept');
  }
  if (isFw(dev)) {
    const fw = cfg.fw;
    for (const v of fw.vip) add(`security address-book global address ${v.name} ${v.int}/32`);
    const snat = fw.snat.find((x) => x.on);
    if (snat) {
      add('security nat source rule-set trust-to-untrust from zone trust');
      add('security nat source rule-set trust-to-untrust to zone untrust');
      add('security nat source rule-set trust-to-untrust rule snat match source-address 0.0.0.0/0');
      add('security nat source rule-set trust-to-untrust rule snat then source-nat interface');
    }
    if (fw.vip.length) add('security nat static rule-set STATIC from zone untrust');
    for (const v of fw.vip) {
      const r = v.name.toLowerCase().replace(/^vip-/, '');
      add(`security nat static rule-set STATIC rule ${r} match destination-address ${v.ext}/32`);
      add(`security nat static rule-set STATIC rule ${r} then static-nat prefix ${v.int}/32`);
    }
    for (const p of fw.pol) {
      const b = `security policies from-zone ${Z(p.from)} to-zone ${Z(p.to)} policy ${p.name}`;
      add(`${b} match source-address any`);
      add(`${b} match destination-address ${p.dst === 'all' ? 'any' : p.dst}`);
      add(`${b} match application ${p.svc === 'HTTPS' ? 'junos-https' : p.svc === 'SSH' ? 'junos-ssh' : 'any'}`);
      add(`${b} then ${p.act === 'accept' ? 'permit' : 'deny'}`);
    }
    for (const z of ['trust', 'untrust']) {
      add(`security zones security-zone ${z} host-inbound-traffic system-services ${z === 'trust' ? 'all' : 'ping'}`);
      for (const [n, i] of Object.entries(cfg.ifs)) if (Z(i.zone) === z) add(`security zones security-zone ${z} interfaces ${ifu(dev, n)}`);
    }
  }
  if (isSw(dev)) for (const v of Object.keys(cfg.vlans).map(Number).sort((a, b) => a - b)) {
    if (v === 1) continue;
    add(`vlans ${vlanName(cfg, v)} vlan-id ${v}`);
    if (cfg.ifs[`irb.${v}`]) add(`vlans ${vlanName(cfg, v)} l3-interface irb.${v}`);
  }
  // inactive statements
  const deact = [];
  for (const nb of cfg.bgp.on ? cfg.bgp.nbrs : []) if (nb.shut) deact.push(`protocols bgp group TRANSIT neighbor ${nb.ip}`);
  for (const p of isFw(dev) ? cfg.fw.pol : []) if (!p.on) deact.push(`security policies from-zone ${Z(p.from)} to-zone ${Z(p.to)} policy ${p.name}`);
  return { set: L, deact };
}

// set statements -> hierarchical text
const NAMED = new Set(['unit', 'family', 'address', 'vrrp-group', 'area', 'interface', 'group', 'neighbor', 'route', 'policy-statement', 'term', 'security-zone', 'from-zone', 'to-zone', 'policy', 'rule-set', 'rule', 'filter', 'community', 'user', 'host', 'server', 'file', 'server-group', 'security-zone', 'routing-instances', 'vlans', 'interfaces']);
const TOP_LIST = new Set(['interfaces', 'vlans', 'routing-instances']);
export function hier(setLines, deact = []) {
  const root = { kids: new Map() };
  const ins = (toks, inactive) => {
    let n = root;
    let i = 0;
    while (i < toks.length) {
      const t = toks[i];
      const rest = toks.length - i - 1;
      let key;
      let leaf = false;
      if (t === '[') {
        key = toks.slice(i).join(' ');
        leaf = true;
        i = toks.length;
      } else if (rest === 0) {
        key = t;
        leaf = true;
        i++;
      } else if ((NAMED.has(t) && !(t === 'interfaces' && n === root) && !(t === 'vlans' && n === root)) || (TOP_LIST.has(n.name) && n.parent === root)) {
        if (TOP_LIST.has(n.name) && n.parent === root) {
          key = t;
          i++;
        } else if (rest === 1 && !['address', 'unit', 'family', 'area', 'interface', 'neighbor', 'route', 'security-zone', 'term'].includes(t)) {
          key = `${t} ${toks[i + 1]}`;
          leaf = true;
          i += 2;
        } else {
          key = `${t} ${toks[i + 1]}`;
          i += 2;
        }
      } else if (rest === 1 || (rest >= 1 && toks[i + 1] === '[')) {
        key = toks.slice(i).join(' ');
        leaf = true;
        i = toks.length;
      } else if (/^"/.test(toks[i + 1] || '') && toks[toks.length - 1].endsWith('"')) {
        key = toks.slice(i).join(' ');
        leaf = true;
        i = toks.length;
      } else {
        key = t;
        i++;
      }
      if (!n.kids.has(key)) n.kids.set(key, { name: key, kids: new Map(), leaf, parent: n });
      n = n.kids.get(key);
      if (leaf) break;
    }
    if (inactive) n.inactive = true;
  };
  const split = (line) => {
    const out = [];
    const re = /"[^"]*"|\S+/g;
    let m;
    while ((m = re.exec(line))) out.push(m[0]);
    return out;
  };
  for (const l of setLines) ins(split(l));
  for (const l of deact) ins(split(l), true);
  const out = [];
  const pr = (n, d) => {
    for (const [, c] of n.kids) {
      const pad = '    '.repeat(d);
      const ina = c.inactive ? 'inactive: ' : '';
      if (c.leaf || !c.kids.size) out.push(`${pad}${ina}${c.name};`);
      else {
        out.push(`${pad}${ina}${c.name} {`);
        pr(c, d + 1);
        out.push(`${pad}}`);
      }
    }
  };
  pr(root, 0);
  return out;
}
function configText(dev, cfg, path = [], displaySet = false) {
  const { set, deact } = toSet(dev, cfg);
  const pre = path.join(' ');
  const pick = (l) => !pre || l === pre || l.startsWith(`${pre} `);
  if (displaySet) return [...set.filter(pick).map((l) => `set ${l}`), ...deact.filter(pick).map((l) => `deactivate ${l}`)];
  const sub = set.filter(pick).map((l) => (pre ? l.slice(pre.length).trim() : l)).filter(Boolean);
  const subD = deact.filter(pick).map((l) => (pre ? l.slice(pre.length).trim() : l)).filter(Boolean);
  if (!sub.length && pre) return [];
  const head = pre ? [] : [`## Last commit: ${fmtDate(dev.run.lastCfg, 'datetime')}:00 UTC by ${dev.run.lastCfgBy || 'admin'}`];
  return [...head, ...hier(sub, subD)];
}
function compare(dev, a, b) {
  const A = toSet(dev, a);
  const B = toSet(dev, b);
  const sa = [...A.set, ...A.deact.map((x) => `inactive: ${x}`)];
  const sb = [...B.set, ...B.deact.map((x) => `inactive: ${x}`)];
  const setA = new Set(sa);
  const setB = new Set(sb);
  const removed = sa.filter((x) => !setB.has(x));
  const added = sb.filter((x) => !setA.has(x));
  const groups = new Map();
  const put = (line, sign) => {
    const toks = line.match(/"[^"]*"|\S+/g);
    const head = toks.slice(0, Math.max(1, toks.length - (toks.length > 3 ? 2 : 1))).join(' ');
    const leaf = toks.slice(head.split(' ').length).join(' ');
    if (!groups.has(head)) groups.set(head, []);
    groups.get(head).push(`${sign}   ${leaf};`);
  };
  removed.forEach((l) => put(l, '-'));
  added.forEach((l) => put(l, '+'));
  const out = [];
  for (const [h, ls] of groups) out.push(`[edit ${h}]`, ...ls);
  return out;
}

// =============================================================================================
// set / delete grammar (operates on the candidate)
function I(s, name) {
  const c = cfgOf(s);
  const n = canon(s.dev, c, name);
  return n ? c.ifs[n] : null;
}
const noIf = (name) => `\nerror: interface ${name} not found`;
function irb(s, u, create = true) {
  const c = cfgOf(s);
  const n = `irb.${u}`;
  if (!c.ifs[n] && create) c.ifs[n] = { ...newIf('svi'), vlan: Number(u) };
  return c.ifs[n];
}
function setSw(s, name, fn) {
  const i = I(s, name);
  if (!i) return noIf(name);
  if (!isSw(s.dev)) return '\nerror: family ethernet-switching not supported on this platform';
  i.sw = i.sw || { mode: 'access', vlan: 1, native: 1, allowed: 'all' };
  i.ip = null;
  fn(i);
  s.candDirty = true;
  return '';
}
const members = (s, words) => {
  const c = cfgOf(s);
  const list = words.replace(/[[\]]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (list.includes('all')) return 'all';
  const ids = [];
  for (const w of list) {
    const v = vlanId(c, w);
    if (v == null) {
      const r = parseVlans(w);
      if (r && r !== 'all') ids.push(...r);
      else return null;
    } else ids.push(v);
  }
  return ids;
};
const dirty = (s) => {
  s.candDirty = true;
  return '';
};
function ospfI(s, name) {
  const c = cfgOf(s);
  const n = canon(s.dev, c, name.replace(/^irb\.(\d+)$/, 'irb.$1'));
  if (!n) return null;
  const i = c.ifs[n];
  i.ospf = i.ospf || { area: null, cost: null, hello: 10, dead: 40, passive: false };
  return i;
}
function bgpN(s, ip, create = true) {
  const b = cfgOf(s).bgp;
  let n = b.nbrs.find((x) => x.ip === ip);
  if (!n && create) {
    if (!b.on) Object.assign(b, { on: true, asn: b.asn || null, nbrs: [], nets: b.nets || [] });
    b.nbrs.push((n = { ip, ras: null, shut: false, desc: '', maxpfx: null }));
  }
  return n;
}
function polFind(s, from, to, name, create = true) {
  const fw = cfgOf(s).fw;
  let p = fw.pol.find((x) => x.name === name && Z(x.from) === from && Z(x.to) === to);
  if (!p && create) fw.pol.push((p = { id: fw.pol.length + 1, name, from: ZC(from), to: ZC(to), src: 'all', dst: 'all', svc: 'ALL', act: 'accept', nat: ZC(to) === 'outside', on: true }));
  return p;
}
const SPEED = (x) => (/g$/.test(x) ? Number(x.slice(0, -1)) * 1000 : /m$/.test(x) ? Number(x.slice(0, -1)) : 'auto');

const SET = [
  ['system host-name $word:h', (s, a, del) => ((cfgOf(s).hostname = del ? 'Amnesiac' : a.h), dirty(s))],
  ['system services {ssh|telnet} [root-login deny]', (s, a, del) => ((cfgOf(s).svc[a.has('ssh') ? 'ssh' : 'telnet'] = !del), dirty(s))],
  ['system services', (s, a, del) => (del ? ((cfgOf(s).svc.ssh = false), (cfgOf(s).svc.telnet = false), dirty(s)) : '')],
  ['system ntp server $ip:ip', (s, a, del) => ((cfgOf(s).svc.ntp = del ? cfgOf(s).svc.ntp.filter((x) => x !== a.ip) : [...new Set([...cfgOf(s).svc.ntp, a.ip])]), dirty(s))],
  ['system syslog host $ip:ip [any {any|notice|info}]', (s, a, del) => ((cfgOf(s).svc.syslog = del ? cfgOf(s).svc.syslog.filter((x) => x !== a.ip) : [...new Set([...cfgOf(s).svc.syslog, a.ip])]), dirty(s))],
  ['system name-server $ip:ip', (s, a, del) => ((cfgOf(s).svc.dns = del ? cfgOf(s).svc.dns.filter((x) => x !== a.ip) : [...new Set([...cfgOf(s).svc.dns, a.ip])]), dirty(s))],
  ['system domain-name $word:d', (s, a) => ((cfgOf(s).svc.domain = a.d), dirty(s))],
  ['system login user $word:u class $word:c', (s, a, del) => {
    const c = cfgOf(s);
    if (del) c.svc.users = c.svc.users.filter((x) => x.name !== a.u);
    else if (!c.svc.users.find((x) => x.name === a.u)) c.svc.users.push({ name: a.u, pw: '', priv: 15 });
    return dirty(s);
  }],
  ['system login user $word:u', (s, a, del) => (del ? ((cfgOf(s).svc.users = cfgOf(s).svc.users.filter((x) => x.name !== a.u)), dirty(s)) : '')],
  ['system login user $word:u authentication plain-text-password', (s, a) => {
    const c = cfgOf(s);
    let u = c.svc.users.find((x) => x.name === a.u);
    if (!u) c.svc.users.push((u = { name: a.u, pw: '', priv: 15 }));
    return ask('New password:', (p1) => ask('Retype new password:', (p2) => {
      if (p1 !== p2) return 'error: passwords do not match';
      u.pw = p1;
      return dirty(s);
    }, { hidden: true }), { hidden: true });
  }],
  ['chassis aggregated-devices ethernet device-count $num:n', () => ''],
  ['interfaces $if:if description $line:d', (s, a, del) => (I(s, a.if) ? ((I(s, a.if).desc = del ? '' : a.d.replace(/^"|"$/g, '')), dirty(s)) : noIf(a.if))],
  ['interfaces $if:if disable', (s, a, del) => {
    const i = I(s, a.if);
    if (!i) return noIf(a.if);
    i.on = !!del;
    if (del) delete s.dev.run.errdis[canon(s.dev, cfgOf(s), a.if)];
    return dirty(s);
  }],
  ['interfaces $if:if mtu $num(256-9216):m', (s, a, del) => (I(s, a.if) ? ((I(s, a.if).mtu = del ? 1500 : a.m), dirty(s)) : noIf(a.if))],
  ['interfaces $if:if [ether-options] speed {10m|100m|1g|10g|25g|40g|100g|auto}', (s, a, del) => (I(s, a.if) ? ((I(s, a.if).speed = del ? 'auto' : SPEED(a.kw[a.kw.length - 1])), dirty(s)) : noIf(a.if))],
  ['interfaces $if:if [ether-options] link-mode {full-duplex|half-duplex|automatic}', (s, a, del) => (I(s, a.if) ? ((I(s, a.if).duplex = del || a.has('automatic') ? 'auto' : a.has('half-duplex') ? 'half' : 'full'), dirty(s)) : noIf(a.if))],
  ['interfaces $if:if {ether-options|gigether-options} 802.3ad $word:ae', (s, a, del) => {
    const i = I(s, a.if);
    if (!i) return noIf(a.if);
    if (del) i.lag = null;
    else {
      const id = Number(a.ae.replace(/^ae/, ''));
      const c = cfgOf(s);
      if (!c.ifs[`ae${id}`]) c.ifs[`ae${id}`] = { ...newIf('lag', { lagId: id }), sw: i.sw ? deep(i.sw) : null };
      const other = Object.values(c.ifs).find((x) => x.lag?.id === id);
      i.lag = { id, mode: other?.lag.mode || 'on' };
    }
    return dirty(s);
  }],
  ['interfaces $if:if aggregated-ether-options lacp {active|passive}', (s, a, del) => {
    const i = I(s, a.if);
    if (!i || i.kind !== 'lag') return noIf(a.if);
    for (const m of Object.values(cfgOf(s).ifs)) if (m.lag?.id === i.lagId) m.lag.mode = del ? 'on' : a.kw[a.kw.length - 1];
    return dirty(s);
  }],
  ['interfaces $if:if native-vlan-id $num(1-4094):v', (s, a, del) => setSw(s, a.if, (i) => (i.sw.native = del ? 1 : a.v))],
  ['interfaces $if:if unit 0 family ethernet-switching interface-mode {access|trunk}', (s, a) => setSw(s, a.if, (i) => (i.sw.mode = a.kw[a.kw.length - 1]))],
  ['interfaces $if:if unit 0 family ethernet-switching vlan members $line:m', (s, a, del) => {
    const ids = members(s, a.m);
    if (ids === null) return `\nerror: vlan '${a.m}' does not exist`;
    return setSw(s, a.if, (i) => {
      if (i.sw.mode === 'access') {
        i.sw.vlan = del ? 1 : ids === 'all' ? 1 : ids[0];
      } else if (del) i.sw.allowed = ids === 'all' ? [] : (i.sw.allowed === 'all' ? [] : i.sw.allowed).filter((v) => !ids.includes(v));
      else i.sw.allowed = ids === 'all' ? 'all' : [...new Set([...(i.sw.allowed === 'all' ? [] : i.sw.allowed), ...ids])].sort((x, y) => x - y);
    });
  }],
  ['interfaces $if:if unit 0 family ethernet-switching', (s, a, del) => (del ? (I(s, a.if) && (I(s, a.if).sw = null), dirty(s)) : setSw(s, a.if, () => {}))],
  ['interfaces $if:if unit 0 family inet address $pfx:p', (s, a, del) => {
    const i = I(s, a.if);
    if (!i) return noIf(a.if);
    if (i.sw && isSw(s.dev) && !del) return `\nerror: family inet and ethernet-switching are mutually exclusive on ${a.if}.0`;
    i.ip = del ? null : a.p;
    return dirty(s);
  }],
  ['interfaces $if:if unit 0 family inet filter {input|output} $word:f', (s, a, del) => (I(s, a.if) ? ((I(s, a.if).acl[a.has('input') ? 'in' : 'out'] = del ? null : a.f), dirty(s)) : noIf(a.if))],
  ['interfaces irb unit $num(0-16385):u description $line:d', (s, a) => ((irb(s, a.u).desc = a.d), dirty(s))],
  ['interfaces irb unit $num(0-16385):u disable', (s, a, del) => ((irb(s, a.u).on = !!del), dirty(s))],
  ['interfaces irb unit $num(0-16385):u', (s, a, del) => (del ? (delete cfgOf(s).ifs[`irb.${a.u}`], dirty(s)) : (irb(s, a.u), dirty(s)))],
  ['interfaces irb unit $num(0-16385):u family inet address $pfx:p', (s, a, del) => ((irb(s, a.u).ip = del ? null : a.p), del && (irb(s, a.u).fhrp = null), dirty(s))],
  ['interfaces irb unit $num(0-16385):u family inet address $pfx:p vrrp-group $num(0-255):g virtual-address $ip:vip', (s, a, del) => {
    const i = irb(s, a.u);
    if (del) i.fhrp = null;
    else i.fhrp = { proto: 'vrrp', grp: a.g, vip: a.vip, prio: i.fhrp?.prio ?? 100, preempt: i.fhrp?.preempt ?? true };
    return dirty(s);
  }],
  ['interfaces irb unit $num(0-16385):u family inet address $pfx:p vrrp-group $num(0-255):g priority $num(1-255):pr', (s, a, del) => (irb(s, a.u).fhrp ? ((irb(s, a.u).fhrp.prio = del ? 100 : a.pr), dirty(s)) : '\nerror: vrrp-group: virtual-address is required')],
  ['interfaces irb unit $num(0-16385):u family inet address $pfx:p vrrp-group $num(0-255):g {preempt|no-preempt}', (s, a, del) => (irb(s, a.u).fhrp ? ((irb(s, a.u).fhrp.preempt = a.has('no-preempt') ? !!del : !del), dirty(s)) : '')],
  ['interfaces irb unit $num(0-16385):u family inet address $pfx:p vrrp-group $num(0-255):g accept-data', () => ''],
  ['interfaces irb unit $num(0-16385):u family inet filter input $word:f', (s, a, del) => ((irb(s, a.u).acl.in = del ? null : a.f), dirty(s))],
  ['interfaces lo0 unit 0 family inet address $pfx:p', (s, a, del) => {
    const c = cfgOf(s);
    c.ifs.lo0 = c.ifs.lo0 || newIf('lo');
    c.ifs.lo0.ip = del ? null : a.p;
    return dirty(s);
  }],
  ['interfaces $if:if', (s, a, del) => {
    if (!del) return '';
    const i = I(s, a.if);
    if (!i) return noIf(a.if);
    const fresh = newIf(i.kind, { hw: i.hw });
    if (isSw(s.dev) && i.kind === 'phys') fresh.sw = null;
    cfgOf(s).ifs[canon(s.dev, cfgOf(s), a.if)] = fresh;
    return dirty(s);
  }],
  ['vlans $word:name vlan-id $num(1-4094):v', (s, a, del) => {
    const c = cfgOf(s);
    if (del) delete c.vlans[a.v];
    else {
      for (const [k, n] of Object.entries(c.vlans)) if (n === a.name && Number(k) !== a.v) delete c.vlans[k];
      ensureVlan({ cfg: c }, a.v, a.name);
    }
    return dirty(s);
  }],
  ['vlans $word:name l3-interface $word:irb', () => ''],
  ['vlans $word:name', (s, a, del) => {
    if (!del) return '';
    const c = cfgOf(s);
    const v = vlanId(c, a.name);
    if (v == null) return `\nwarning: statement not found`;
    delete c.vlans[v];
    return dirty(s);
  }],
  ['routing-options router-id $ip:rid', (s, a, del) => ((cfgOf(s).ospf.rid = del ? null : a.rid), (cfgOf(s).bgp.rid = del ? null : a.rid), dirty(s))],
  ['routing-options autonomous-system $num:asn', (s, a) => ((cfgOf(s).bgp.asn = a.asn), dirty(s))],
  ['routing-options static route $pfx:p next-hop $ip:nh', (s, a, del) => {
    const c = cfgOf(s);
    c.static = c.static.filter((r) => !(r.pfx === a.p && r.nh === a.nh));
    if (!del) c.static.push({ pfx: a.p, nh: a.nh, ad: 5 });
    return dirty(s);
  }],
  ['routing-options static route $pfx:p {discard|reject}', (s, a, del) => {
    const c = cfgOf(s);
    c.static = c.static.filter((r) => !(r.pfx === a.p && r.iface === 'Null0'));
    if (!del) c.static.push({ pfx: a.p, nh: null, iface: 'Null0', ad: 5 });
    return dirty(s);
  }],
  ['routing-options static route $pfx:p preference $num(0-255):ad', (s, a, del) => {
    for (const r of cfgOf(s).static) if (r.pfx === a.p) r.ad = del ? 5 : a.ad;
    return dirty(s);
  }],
  ['routing-options static route $pfx:p', (s, a, del) => (del ? ((cfgOf(s).static = cfgOf(s).static.filter((r) => r.pfx !== a.p)), dirty(s)) : '')],
  ['protocols ospf area $word:area interface $word:i', (s, a, del) => {
    const i = ospfI(s, a.i);
    if (!i) return noIf(a.i);
    cfgOf(s).ospf.on = true;
    i.ospf.area = del ? null : /^\d+$/.test(a.area) ? n2ip(Number(a.area)) : a.area;
    return dirty(s);
  }],
  ['protocols ospf area $word:area interface $word:i passive', (s, a, del) => {
    const i = ospfI(s, a.i);
    if (!i) return noIf(a.i);
    cfgOf(s).ospf.on = true;
    if (i.ospf.area == null) i.ospf.area = /^\d+$/.test(a.area) ? n2ip(Number(a.area)) : a.area;
    i.ospf.passive = !del;
    return dirty(s);
  }],
  ['protocols ospf area $word:area interface $word:i {hello-interval|dead-interval|metric} $num(1-65535):v', (s, a, del) => {
    const i = ospfI(s, a.i);
    if (!i) return noIf(a.i);
    if (i.ospf.area == null) i.ospf.area = /^\d+$/.test(a.area) ? n2ip(Number(a.area)) : a.area;
    const k = a.has('hello-interval') ? 'hello' : a.has('dead-interval') ? 'dead' : 'cost';
    i.ospf[k] = del ? { hello: 10, dead: 40, cost: null }[k] : a.v;
    return dirty(s);
  }],
  ['protocols ospf area $word:area interface $word:i authentication simple-password $word:k', (s, a, del) => {
    const i = ospfI(s, a.i);
    if (!i) return noIf(a.i);
    i.ospf.auth = del ? null : a.k.replace(/"/g, '');
    return dirty(s);
  }],
  ['protocols ospf area $word:area interface $word:i interface-type p2p', (s, a, del) => ((ospfI(s, a.i).ospf.p2p = !del), dirty(s))],
  ['protocols ospf export $word:pol', (s, a, del) => ((cfgOf(s).ospf.defOrig = !del && /DEFAULT/i.test(a.pol)), dirty(s))],
  ['protocols ospf', (s, a, del) => {
    if (!del) return '';
    const c = cfgOf(s);
    c.ospf.on = false;
    for (const i of Object.values(c.ifs)) i.ospf = null;
    return dirty(s);
  }],
  ['protocols bgp group $word:g type {external|internal}', () => ''],
  ['protocols bgp group $word:g export $word:p', () => ''],
  ['protocols bgp group $word:g neighbor $ip:ip peer-as $num:as', (s, a, del) => {
    const n = bgpN(s, a.ip);
    if (del) n.ras = null;
    else n.ras = a.as;
    return dirty(s);
  }],
  ['protocols bgp group $word:g neighbor $ip:ip description $line:d', (s, a) => ((bgpN(s, a.ip).desc = a.d.replace(/"/g, '')), dirty(s))],
  ['protocols bgp group $word:g neighbor $ip:ip family inet unicast prefix-limit maximum $num:m', (s, a, del) => ((bgpN(s, a.ip).maxpfx = del ? null : a.m), dirty(s))],
  ['protocols bgp group $word:g neighbor $ip:ip family inet unicast prefix-limit teardown', () => ''],
  ['protocols bgp group $word:g neighbor $ip:ip', (s, a, del) => (del ? ((cfgOf(s).bgp.nbrs = cfgOf(s).bgp.nbrs.filter((x) => x.ip !== a.ip)), dirty(s)) : (bgpN(s, a.ip), dirty(s)))],
  ['protocols rstp', (s, a, del) => ((cfgOf(s).stp.on = !del), dirty(s))],
  ['protocols rstp bridge-priority $word:p', (s, a, del) => {
    const c = cfgOf(s);
    const p = unPrio(a.p);
    if (!del && (Number.isNaN(p) || p % 4096)) return `\nerror: bridge-priority: '${a.p}': Value must be a multiple of 4k`;
    for (const v of Object.keys(c.vlans)) if (del) delete c.stp.prio[v];
    else c.stp.prio[v] = p;
    return dirty(s);
  }],
  ['protocols rstp interface $if:if edge', (s, a, del) => (I(s, a.if) ? ((I(s, a.if).stp.edge = !del), dirty(s)) : noIf(a.if))],
  ['protocols layer2-control bpdu-block interface $if:if', (s, a, del) => (I(s, a.if) ? ((I(s, a.if).stp.bpduguard = !del), dirty(s)) : noIf(a.if))],
  ['protocols lldp interface all', () => ''],
  ['forwarding-options dhcp-relay server-group $word:g $ip:ip', (s) => dirty(s)],
  ['forwarding-options dhcp-relay group $word:g active-server-group $word:sg', () => ''],
  ['forwarding-options dhcp-relay group $word:g interface $word:i', (s, a, del) => {
    const i = I(s, a.i);
    if (!i) return noIf(a.i);
    i.helper = del ? [] : ['10.20.0.67'];
    return dirty(s);
  }],
  ['snmp community $word:c authorization {read-only|read-write}', (s, a, del) => ((cfgOf(s).svc.snmp = del ? null : a.c), dirty(s))],
  ['firewall family inet filter $word:f term $word:t {from|then} $line:x', (s, a, del) => {
    const c = cfgOf(s);
    const list = (c.acls[a.f] = c.acls[a.f] || []);
    const idx = Number(String(a.t).replace(/\D/g, '')) || list.length + 1;
    let e = list.find((x) => x.term === a.t);
    if (!e) {
      e = { term: a.t, act: 'permit', proto: 'ip', src: 'any', dst: 'any', dport: null, idx };
      list.push(e);
      list.sort((x, y) => x.idx - y.idx);
    }
    if (del) {
      c.acls[a.f] = list.filter((x) => x !== e);
      return dirty(s);
    }
    const [k, v] = a.x.split(/\s+/);
    if (a.has('then')) e.act = /accept/.test(k) ? 'permit' : 'deny';
    else if (k === 'source-address') e.src = v;
    else if (k === 'destination-address') e.dst = v;
    else if (k === 'protocol') e.proto = v;
    else if (k === 'destination-port') e.dport = Number(v) || { https: 443, http: 80, ssh: 22 }[v];
    return dirty(s);
  }],
  ['security zones security-zone $word:z interfaces $word:i', (s, a, del) => {
    const i = I(s, a.i);
    if (!i) return noIf(a.i);
    i.zone = del ? null : ZC(a.z);
    return dirty(s);
  }],
  ['security zones security-zone $word:z host-inbound-traffic system-services $word:svc', () => ''],
  ['security address-book global address $word:n $pfx:p', (s, a, del) => {
    const fw = cfgOf(s).fw;
    const v = fw.vip.find((x) => x.name === a.n);
    if (del && v) fw.vip = fw.vip.filter((x) => x !== v);
    else if (v) v.int = ipOnly(a.p);
    else fw.vip.push({ name: a.n, int: ipOnly(a.p), ext: null });
    return dirty(s);
  }],
  ['security policies from-zone $word:f to-zone $word:t policy $word:p match {source-address|destination-address|application} $word:v', (s, a, del) => {
    const p = polFind(s, a.f, a.t, a.p);
    if (a.has('destination-address')) p.dst = del || a.v === 'any' ? 'all' : a.v;
    if (a.has('application')) p.svc = a.v === 'junos-https' ? 'HTTPS' : a.v === 'junos-ssh' ? 'SSH' : 'ALL';
    return dirty(s);
  }],
  ['security policies from-zone $word:f to-zone $word:t policy $word:p then {permit|deny|reject}', (s, a) => ((polFind(s, a.f, a.t, a.p).act = a.has('permit') ? 'accept' : 'deny'), dirty(s))],
  ['security policies from-zone $word:f to-zone $word:t policy $word:p', (s, a, del) => (del ? ((cfgOf(s).fw.pol = cfgOf(s).fw.pol.filter((x) => !(x.name === a.p && Z(x.from) === a.f))), dirty(s)) : '')],
  ['security nat source rule-set $word:rs {from|to} zone $word:z', () => ''],
  ['security nat source rule-set $word:rs rule $word:r match source-address $pfx:p', () => ''],
  ['security nat source rule-set $word:rs rule $word:r then source-nat {interface|off}', (s, a, del) => {
    const fw = cfgOf(s).fw;
    if (!fw.snat.length) fw.snat.push({ from: 'inside', to: 'outside', on: true });
    fw.snat.forEach((x) => (x.on = !del && a.has('interface')));
    return dirty(s);
  }],
  ['security nat source', (s, a, del) => (del ? (cfgOf(s).fw.snat.forEach((x) => (x.on = false)), dirty(s)) : '')],
  ['security nat static rule-set $word:rs from zone $word:z', () => ''],
  ['security nat static rule-set $word:rs rule $word:r match destination-address $pfx:p', (s, a, del) => {
    const fw = cfgOf(s).fw;
    let v = fw.vip.find((x) => x.name.toLowerCase().replace(/^vip-/, '') === a.r);
    if (!v) fw.vip.push((v = { name: `VIP-${a.r.toUpperCase()}`, int: null, ext: null }));
    v.ext = del ? null : ipOnly(a.p);
    return dirty(s);
  }],
  ['security nat static rule-set $word:rs rule $word:r then static-nat prefix $pfx:p', (s, a, del) => {
    const fw = cfgOf(s).fw;
    let v = fw.vip.find((x) => x.name.toLowerCase().replace(/^vip-/, '') === a.r);
    if (!v) fw.vip.push((v = { name: `VIP-${a.r.toUpperCase()}`, int: null, ext: null }));
    v.int = del ? null : ipOnly(a.p);
    return dirty(s);
  }],
];
const ACTIVATE = [
  ['protocols bgp group $word:g neighbor $ip:ip', (s, a, off) => (bgpN(s, a.ip, false) ? ((bgpN(s, a.ip).shut = off), dirty(s)) : '\nwarning: statement not found')],
  ['security policies from-zone $word:f to-zone $word:t policy $word:p', (s, a, off) => {
    const p = polFind(s, a.f, a.t, a.p, false);
    if (!p) return '\nwarning: statement not found';
    p.on = !off;
    return dirty(s);
  }],
  ['interfaces $if:if', (s, a, off) => (I(s, a.if) ? ((I(s, a.if).on = !off), dirty(s)) : noIf(a.if))],
];

// =============================================================================================
// Operational output
function terse(s, filter) {
  const dev = s.dev;
  const S = S_(s.world);
  const out = ['Interface               Admin Link Proto    Local                 Remote'];
  const st = (n) => S.ifs[dev.id][n] || {};
  const phys = sortedIfs(dev, (i, n) => (!filter || n === filter || n.startsWith(filter)) && i.kind !== 'svi' && i.kind !== 'sub');
  for (const n of phys) {
    const i = dev.cfg.ifs[n];
    const up = st(n).up || (i.kind === 'lo' && i.on);
    out.push(`${padR(n, 24)}${padR(i.on ? 'up' : 'down', 6)}${padR(up ? 'up' : 'down', 5)}`);
    if (i.sw && isSw(dev)) out.push(`${padR(`${n}.0`, 24)}${padR('up', 6)}${padR(up ? 'up' : 'down', 5)}eth-switch`);
    else if (i.ip) out.push(`${padR(`${n}.0`, 24)}${padR('up', 6)}${padR(up ? 'up' : 'down', 5)}${padR('inet', 9)}${i.kind === 'lo' ? `${ipOnly(i.ip)}${' '.repeat(Math.max(1, 22 - ipOnly(i.ip).length))}--> 0/0` : i.ip}`);
    else if (i.lag) out.push(`${padR(`${n}.0`, 24)}${padR('up', 6)}${padR(up ? 'up' : 'down', 5)}aenet    --> ae${i.lag.id}.0`);
  }
  const irbs = sortedIfs(dev, (i, n) => i.kind === 'svi' && (!filter || filter === 'irb' || n === filter));
  if (irbs.length) {
    out.push(`${padR('irb', 24)}${padR('up', 6)}${padR('up', 5)}`);
    for (const n of irbs) {
      const i = dev.cfg.ifs[n];
      out.push(`${padR(n, 24)}${padR(i.on ? 'up' : 'down', 6)}${padR(st(n).proto ? 'up' : 'down', 5)}${i.ip ? `${padR('inet', 9)}${i.ip}` : ''}`);
    }
  }
  return out;
}
function showIf(s, n, ext) {
  const dev = s.dev;
  const i = dev.cfg.ifs[n];
  const S = S_(s.world);
  const st = S.ifs[dev.id][n] || {};
  const c = counters(s.world, dev, n);
  const L = st.link ? S.links[st.link] : null;
  const sp = L?.up ? L.speed : i.hw?.speed || 1000;
  const out = [`Physical interface: ${n}, ${i.on ? 'Enabled' : 'Administratively down'}, Physical link is ${st.up ? 'Up' : 'Down'}`, `  Interface index: ${150 + Object.keys(dev.cfg.ifs).indexOf(n)}, SNMP ifIndex: ${500 + Object.keys(dev.cfg.ifs).indexOf(n)}`];
  if (i.desc) out.push(`  Description: ${i.desc}`);
  out.push(`  Link-level type: Ethernet, MTU: ${(i.mtu || 1500) + 14}, LAN-PHY mode, Speed: ${sp >= 1000 ? `${sp / 1000}Gbps` : `${sp}mbps`}, BPDU Error: ${dev.run.errdis[n] ? 'Detected' : 'None'}, Loop Detect PDU Error: None,`, `  Link-mode: ${L?.duplex === 'mismatch' && i.duplex === 'auto' ? 'Half-duplex' : 'Full-duplex'}, MAC-REWRITE Error: None, Loopback: Disabled, Source filtering: Disabled, Flow control: Enabled`, '  Device flags   : Present Running', `  Interface flags: ${st.up ? 'SNMP-Traps Internal: 0x4000' : 'Hardware-Down SNMP-Traps Internal: 0x4000'}`, `  Current address: ${macColon(macOfIf(dev, n))}, Hardware address: ${macColon(macOfIf(dev, n))}`, `  Last flapped   : ${fmtDate(Math.max(dev.run.boot, s.world.time.t - (hashStr(n) % 3000)), 'datetime')}:00 UTC (${upJunos(hashStr(n) % 3000)} ago)`, `  Input rate     : ${c.rateIn} bps (${c.ppsIn} pps)`, `  Output rate    : ${c.rateOut} bps (${c.ppsOut} pps)`);
  if (ext) out.push('  Input errors:', `    Errors: ${c.inErr}, Drops: ${c.drops}, Framing errors: ${c.crc}, Runts: ${c.runts}, Policed discards: 0, L3 incompletes: 0, L2 channel errors: 0, L2 mismatch timeouts: 0, FIFO errors: 0, Resource errors: 0`, '  Output errors:', `    Carrier transitions: ${c.resets + 1}, Errors: ${c.outErr}, Drops: 0, Collisions: ${c.coll}, Aged packets: 0, FIFO errors: 0, HS link CRC errors: 0, MTU errors: 0, Resource errors: 0`, '  MAC statistics:                      Receive         Transmit', `    Total octets                   ${padL(c.inB, 14)}   ${padL(c.outB, 14)}`, `    Total packets                  ${padL(c.inP, 14)}   ${padL(c.outP, 14)}`, `    CRC/Align errors               ${padL(c.crc, 14)}                0`, `    FIFO errors                                 0                0`);
  out.push(`  Active alarms  : ${st.up ? 'None' : 'LINK'}`, `  Active defects : ${st.up ? 'None' : 'LINK'}`);
  if (i.ip || i.sw) out.push('', `  Logical interface ${n}.0 (Index 340) (SNMP ifIndex 520)`, '    Flags: Up SNMP-Traps 0x4004000 Encapsulation: ENET2', `    Input packets : ${c.inP}`, `    Output packets: ${c.outP}`, i.ip ? `    Protocol inet, MTU: ${i.mtu || 1500}` : '    Protocol eth-switch, MTU: 1514', ...(i.ip ? ['      Flags: Sendbcast-pkt-to-re', '      Addresses, Flags: Is-Preferred Is-Primary', `        Destination: ${n2ip(cidr(i.ip).net)}/${lenOf(i.ip)}, Local: ${ipOnly(i.ip)}, Broadcast: ${n2ip(cidr(i.ip).bc)}`] : []));
  return out;
}
const PROTO = { connected: 'Direct', local: 'Local', static: 'Static', ospf: 'OSPF', ospfE: 'OSPF', ebgp: 'BGP', ibgp: 'BGP' };
function showRoute(s, a) {
  const dev = s.dev;
  const S = S_(s.world);
  const vrf = a.table === 'mgmt_junos' || a.inst === 'mgmt_junos' ? dev.cfg.ifs[dev.meta.mgmtIf]?.vrf || null : null;
  let rib = (S.rib[dev.id]?.best || []).filter((r) => (r.vrf || null) === vrf);
  if (a.proto) rib = rib.filter((r) => PROTO[r.proto].toLowerCase() === a.proto.toLowerCase());
  if (a.ip) {
    const r = lookup(s.world, dev, ipOnly(a.ip), vrf);
    rib = r ? [r] : [];
  }
  const tbl = vrf ? 'mgmt_junos.inet.0' : 'inet.0';
  const all = S.rib[dev.id]?.best || [];
  const out = ['', `${tbl}: ${all.length} destinations, ${all.length + 1} routes (${all.length} active, 0 holddown, 0 hidden)`, '+ = Active Route, - = Last Active, * = Both', ''];
  const age = upJunos(Math.max(0, s.world.time.t - dev.run.boot) % 100000).replace(/^(\d+d) /, '$1 ');
  for (const r of rib) {
    out.push(`${padR(r.pfx, 19)}*[${PROTO[r.proto]}/${r.ad}] ${age}${r.proto.startsWith('ospf') ? `, metric ${r.metric}` : r.proto === 'ebgp' ? ', localpref 100' : ''}`);
    if (r.proto === 'ebgp') out.push(`                      AS path: ${s.world.hosts[Object.values(s.world.hosts).find((h) => h.ip === r.nh)?.id]?.asn || 65001} I, validation-state: unverified`);
    if (r.discard) out.push('                       Discard');
    else if (r.proto === 'local') out.push(`                       Local via ${ifu(dev, r.oif)}`);
    else if (r.proto === 'connected') out.push(`                    >  via ${ifu(dev, r.oif)}`);
    else for (const h of r.ecmp || [{ nh: r.nh, oif: r.oif }]) out.push(`                    >  to ${h.nh} via ${ifu(dev, h.oif)}`);
  }
  return out;
}
function bgpSummary(s) {
  const dev = s.dev;
  if (!dev.cfg.bgp.on) return 'BGP is not running';
  const recs = S_(s.world).bgp[dev.id] || [];
  const out = ['Threading mode: BGP I/O', 'Default eBGP mode: advertise - accept, receive - accept', `Groups: 1 Peers: ${recs.length} Down peers: ${recs.filter((r) => !r.up).length}`, 'Table          Tot Paths  Act Paths Suppressed    History Damp State    Pending', 'inet.0               ', `                       ${recs.reduce((x, r) => x + r.pfx, 0)}          ${recs.filter((r) => r.up).length}          0          0          0          0`, 'Peer                     AS      InPkt     OutPkt    OutQ   Flaps Last Up/Dwn State|#Active/Received/Accepted/Damped...'];
  for (const r of recs) {
    const st = r.up ? 'Establ' : { 'Idle (Admin)': 'Idle', 'Idle (PfxCt)': 'Idle', Active: 'Active', Idle: 'Idle' }[r.state] || 'Active';
    out.push(`${padR(r.ip, 25)}${padL(r.ras, 5)} ${padL(r.up ? 1234 : 0, 10)} ${padL(r.up ? 1240 : 3, 10)}       0       ${r.up ? 0 : 1} ${padL(r.up ? '1d 2:03:04' : '5:12', 11)} ${st}`);
    if (r.up) out.push(`  inet.0: ${r.pfx}/${r.pfx}/${r.pfx}/0`);
  }
  return out;
}
function ospfNbr(s) {
  const dev = s.dev;
  const nb = S_(s.world).ospf[dev.id]?.nbrs || [];
  return ['Address          Interface              State           ID               Pri  Dead', ...nb.map((n) => `${padR(n.ip, 17)}${padR(ifu(dev, n.if), 23)}${padR(n.state === 'FULL' ? 'Full' : n.state === 'EXSTART' ? 'ExStart' : 'Init', 16)}${padR(n.rid, 17)}${padL(128, 3)}    3${hashStr(n.rid) % 9}`)];
}
function ospfInt(s) {
  const dev = s.dev;
  const S = S_(s.world);
  return ['Interface           State   Area            DR ID           BDR ID          Nbrs', ...sortedIfs(dev, (i) => i.ospf?.area != null && i.ip).map((n) => {
    const i = dev.cfg.ifs[n];
    const nbs = (S.ospf[dev.id]?.nbrs || []).filter((x) => x.if === n).length;
    const st = !S.ifs[dev.id][n]?.proto ? 'Down' : i.ospf.passive || i.kind === 'lo' ? 'DRother' : nbs ? 'BDR' : 'DR';
    return `${padR(ifu(dev, n), 20)}${padR(st, 8)}${padR(i.ospf.area, 16)}${padR(nbs ? '10.255.0.5' : '0.0.0.0', 16)}${padR(nbs ? dev.cfg.ospf.rid || '0.0.0.0' : '0.0.0.0', 16)}${padL(nbs, 4)}`;
  })];
}
function vrrpSummary(s) {
  const dev = s.dev;
  const S = S_(s.world);
  const out = ['Interface     State       Group   VR state VR Mode   Type   Address'];
  for (const [n, f] of Object.entries(S.fhrp[dev.id] || {})) {
    out.push(`${padR(n, 14)}${padR(S.ifs[dev.id][n]?.proto ? 'up' : 'down', 12)}${padL(f.grp, 5)}   ${padR({ active: 'master', standby: 'backup', init: 'init' }[f.state], 9)}Active    lcl    ${ipOnly(dev.cfg.ifs[n].ip)}`);
    out.push(`${' '.repeat(53)}vip    ${f.vip}`);
  }
  return out;
}
function lacpIf(s) {
  const dev = s.dev;
  const S = S_(s.world);
  const out = [];
  for (const n of sortedIfs(dev, (i) => i.kind === 'lag')) {
    const L = S.lags[dev.id]?.[n];
    out.push(`Aggregated interface: ${n}`, '    LACP state:       Role   Exp   Def  Dist  Col  Syn  Aggr  Timeout  Activity');
    for (const [m, st] of Object.entries(L?.members || {})) {
      const ok = st === 'P';
      out.push(`      ${padR(m, 14)}Actor    No    ${ok ? 'No ' : 'Yes'}  ${ok ? 'Yes' : ' No'}  ${ok ? 'Yes' : ' No'}  ${ok ? 'Yes' : ' No'}   Yes     Fast    Active`, `      ${padR(m, 12)}Partner    No    ${ok ? 'No ' : 'Yes'}  ${ok ? 'Yes' : ' No'}  ${ok ? 'Yes' : ' No'}  ${ok ? 'Yes' : ' No'}   Yes     Fast   ${ok ? ' Active' : 'Passive'}`);
    }
    out.push('    LACP protocol:        Receive State  Transmit State          Mux State');
    for (const [m, st] of Object.entries(L?.members || {})) out.push(`      ${padR(m, 22)}${padR(st === 'P' ? 'Current' : 'Defaulted', 15)}${padR('Fast periodic', 24)}${st === 'P' ? 'Collecting distributing' : 'Detached'}`);
  }
  return out.length ? out : ['warning: lacp subsystem not running - not needed by configuration.'];
}
function showVlans(s) {
  const dev = s.dev;
  const out = ['', 'Routing instance        VLAN name             Tag          Interfaces'];
  for (const v of Object.keys(dev.cfg.vlans).map(Number).sort((a, b) => a - b)) {
    out.push(`${padR('default-switch', 24)}${padR(vlanName(dev.cfg, v), 22)}${padR(v, 13)}`);
    for (const [n, i] of Object.entries(dev.cfg.ifs)) {
      if (!i.sw || i.lag) continue;
      const inV = i.sw.mode === 'access' ? i.sw.vlan === v : i.sw.allowed === 'all' || i.sw.allowed.includes(v) || i.sw.native === v;
      if (inV) out.push(`${' '.repeat(59)}${n}.0${S_(s.world).ifs[dev.id][n]?.up ? '*' : ''}`);
    }
  }
  return out;
}
function showLog(s) {
  return s.dev.run.logs.map((e) => fmtEventJunos(e, s.dev)).filter(Boolean);
}
export function fmtEventJunos(e, dev) {
  const ts = `${fmtDate(e.t, 'syslog')}  ${dev.cfg.hostname} `;
  const pid = 1000 + (hashStr(dev.id) % 8000);
  switch (e.type) {
    case 'link':
      if (e.kind === 'svi' || e.kind === 'lo') return null;
      return `${ts}mib2d[${pid}]: SNMP_TRAP_LINK_${e.up ? 'UP' : 'DOWN'}: ifIndex ${500 + (hashStr(e.if) % 100)}, ifAdminStatus ${e.admin ? 'down(2)' : 'up(1)'}, ifOperStatus ${e.up ? 'up(1)' : 'down(2)'}, ifName ${e.if}`;
    case 'proto':
      return null;
    case 'errdis':
      return `${ts}l2ald[${pid + 3}]: L2ALD_BPDU_BLOCK_ERROR_DETECTED: Bpdu-block: ${e.if}.0 disabled due to BPDU received on blocked interface\n${ts}eswd[${pid + 4}]: ESWD_BPDU_BLOCK_ERROR_DISABLED: ${e.if}: bpdu-block disabled port`;
    case 'ospf':
      return `${ts}rpd[${pid + 7}]: RPD_OSPF_NBRDOWN: OSPF neighbor ${e.nbr} (realm ospf-v2 ${ifu(dev, e.if)} area 0.0.0.0) state changed from ${e.from === 'FULL' ? 'Full' : e.from} to ${e.to === 'FULL' ? 'Full' : 'Init'} due to ${e.to === 'FULL' ? 'LoadDone' : /dead|Dead/.test(e.why || 'Dead') ? 'InActiveTimer (event reason: BFD session timed out and neighbor was declared dead)' : 'KillNbr (event reason: interface went down)'}`.replace('RPD_OSPF_NBRDOWN', e.to === 'FULL' ? 'RPD_OSPF_NBRUP' : 'RPD_OSPF_NBRDOWN');
    case 'ospfErr':
      return `${ts}rpd[${pid + 7}]: RPD_OSPF_AREA_MISMATCH: OSPF packet ignored: area mismatch from ${e.from} on intf ${ifu(dev, e.if)} area 0.0.0.0`;
    case 'bgp':
      return e.up ? `${ts}rpd[${pid + 7}]: BGP_PREFIX_THRESH_EXCEEDED: ${e.nbr} (External AS ${e.ras}): Configured maximum prefix-limit threshold(100) exceeded for inet-unicast nlri: 1 (instance master)`.replace(/BGP_PREFIX.*$/, `bgp_event: peer ${e.nbr} (External AS ${e.ras}) old state OpenConfirm event RecvKeepAlive new state Established`) : /maximum-prefix/.test(e.why) ? `${ts}rpd[${pid + 7}]: BGP_PREFIX_LIMIT_EXCEEDED: ${e.nbr} (External AS ${e.ras}): Configured maximum prefix-limit(${e.why.match(/\d+/)?.[0]}) exceeded for inet-unicast nlri: ${e.why.match(/\((\d+)/)?.[1]} (instance master)` : `${ts}rpd[${pid + 7}]: bgp_event: peer ${e.nbr} (External AS ${e.ras}) old state Established event ${e.notify ? 'RecvNotify' : 'HoldTime'} new state Idle${e.why ? ` (${e.why})` : ''}`;
    case 'fhrp':
      return `${ts}vrrpd[${pid + 9}]: VRRPD_NEW_${e.to === 'active' ? 'MASTER' : 'BACKUP'}: Interface ${e.if} (local address ${ipOnly(dev.cfg.ifs[e.if]?.ip)}) became VRRP ${e.to === 'active' ? 'master' : 'backup'} for group ${e.grp}`;
    case 'lacp':
      return `${ts}lacpd[${pid + 11}]: LACPD_TIMEOUT: ${e.if}: lacp current while timer expired current Receive State: ${e.state === 'P' ? 'CURRENT' : 'DEFAULTED'}`;
    case 'config':
    case 'commit':
      return `${ts}mgd[${pid + 13}]: UI_COMMIT: User '${e.by}' requested 'commit' operation (comment: ${e.comment || 'none'})`;
    case 'login':
      return `${ts}sshd[${pid + 15}]: Accepted password for ${e.user} from ${e.from} port ${40000 + (hashStr(String(e.t)) % 9999)} ssh2`;
    case 'authfail':
      return `${ts}sshd[${pid + 15}]: SSHD_LOGIN_FAILED: Login failed for user '${e.user}' from host '${e.from}'`;
    case 'psu':
      return `${ts}chassisd[${pid + 17}]: CHASSISD_PSU_FAILURE: Power Supply ${e.n - 1} ${e.ok ? 'OK' : 'failure: Input failure'}`;
    case 'fan':
      return `${ts}chassisd[${pid + 17}]: CHASSISD_FAN_FAILED: Fan Tray ${e.n - 1} Fan 0 ${e.ok ? 'OK' : 'failed'}`;
    case 'temp':
      return `${ts}chassisd[${pid + 17}]: CHASSISD_TEMP_HOT_NOTICE: Temperature of FPC 0 is ${e.temp} degrees C (hot)`;
    case 'boot':
      return `${ts}init: Junos OS ${dev.version} booting\n${ts}chassisd[${pid + 17}]: CHASSISD_SNMP_TRAP7: SNMP trap generated: Power Supply OK`;
    case 'native':
      return null;
    case 'macflap':
      return `${ts}l2ald[${pid + 3}]: L2ALD_MAC_MOVE_NOTIFICATION: MAC ${macColon(e.mac)} moved from ${e.if1}.0 to ${e.if2}.0 in vlan ${e.vlan}`;
    case 'autorollback':
      return `${ts}mgd[${pid + 13}]: UI_COMMIT_CONFIRMED_TIMED: commit confirmed rollback in effect; reverted to rollback 1`;
    case 'optic':
      return `${ts}fpc0 PFE: Rx loss of signal on ${e.if}`;
    default:
      return null;
  }
}

function junosPing(s, a) {
  const target = a.host;
  if (!isIp(target)) return `ping: cannot resolve ${target}: Host name lookup failure`;
  const vrf = a.inst === 'mgmt_junos' ? s.dev.cfg.ifs[s.dev.meta.mgmtIf]?.vrf || null : null;
  const count = a.count || Infinity;
  const size = a.size || 56;
  const r0 = lookup(s.world, s.dev, target, vrf);
  if (!r0) return stream([{ d: 10, t: `PING ${target} (${target}): ${size} data bytes\n` }, { d: 500, t: 'ping: sendto: No route to host\n' }]);
  if (a.has('rapid')) {
    const n = Number.isFinite(count) ? count : 5;
    const p = ping(s, target, { count: n, size: size + 28, df: a.has('do-not-fragment'), vrf });
    return stream([{ d: 10, t: `PING ${target} (${target}): ${size} data bytes\n` }, ...p.res.map((x) => ({ d: 60, t: x.ok ? '!' : '.' })), { d: 0, t: `\n--- ${target} ping statistics ---\n${n} packets transmitted, ${p.recv} packets received, ${100 - p.pct}% packet loss\n${p.recv ? `round-trip min/avg/max/stddev = ${(p.min * 0.4).toFixed(3)}/${(p.avg * 0.4).toFixed(3)}/${(p.max * 0.4).toFixed(3)}/0.104 ms\n` : ''}` }]);
  }
  let sent = 0;
  let recv = 0;
  const rtts = [];
  let started = false;
  const summary = () => `\n--- ${target} ping statistics ---\n${sent} packets transmitted, ${recv} packets received, ${sent ? Math.round(((sent - recv) / sent) * 100) : 0}% packet loss\n${recv ? `round-trip min/avg/max/stddev = ${Math.min(...rtts).toFixed(3)}/${(rtts.reduce((x, y) => x + y, 0) / rtts.length).toFixed(3)}/${Math.max(...rtts).toFixed(3)}/0.112 ms\n` : ''}`;
  let done = false;
  return genStream(() => {
    if (!started) {
      started = true;
      return { d: 10, t: `PING ${target} (${target}): ${size} data bytes\n` };
    }
    if (done) return null;
    if (sent >= count) {
      done = true;
      return { d: 0, t: summary() };
    }
    const p = ping(s, target, { count: 1, size: size + 28, df: a.has('do-not-fragment'), vrf });
    const k = sent++;
    if (p.recv) {
      recv++;
      const t = p.res[0].rtt * 0.4;
      rtts.push(t);
      return { d: k ? 1000 : 50, t: `${size + 8} bytes from ${target}: icmp_seq=${k} ttl=${p.r.toDevice ? 64 : 63} time=${t.toFixed(3)} ms\n` };
    }
    return { d: 1000, t: '' };
  }, () => `^C${summary()}`);
}

function monitorTraffic(s, a) {
  const dev = s.dev;
  const n = canon(dev, dev.cfg, a.if);
  if (!n) return `error: interface ${a.if} not found`;
  const W = s.world;
  const lines = [];
  const S = S_(W);
  const st = S.ifs[dev.id][n];
  for (const nb of S.ospf[dev.id]?.nbrs || []) if (nb.if === n) lines.push(`In  IP ${nb.ip} > 224.0.0.5: OSPFv2, Hello, length 48`, `Out IP ${ipOnly(dev.cfg.ifs[n].ip)} > 224.0.0.5: OSPFv2, Hello, length 48`);
  for (const p of S.ospf[dev.id]?.problems || []) if (p.if === n) lines.push(`In  IP ${p.peer} > 224.0.0.5: OSPFv2, Hello, length 44 [${p.why}]`);
  for (const r of S.bgp[dev.id] || []) lines.push(r.up ? `In  IP ${r.ip}.179 > ${ipOnly(dev.cfg.ifs[n]?.ip)}.62044: Flags [P.], seq 1:20, ack 1, win 16384, length 19: BGP, length: 19` : `Out IP ${ipOnly(dev.cfg.ifs[n]?.ip)}.62044 > ${r.ip}.179: Flags [S], seq 0, win 16384, length 0`);
  for (const c of W.design.customers.filter((x) => x.web)) {
    const isp = Object.values(W.hosts).find((h) => h.kind === 'isp');
    const r = isp && walk(W, { host: isp.id }, c.vip, { proto: 'tcp', dport: 443 });
    if (r && r.linksUsed.includes(st?.link)) lines.push(`In  IP 198.51.100.77.${40000 + (hashStr(c.id) % 9999)} > ${c.vip}.443: Flags [S], seq 0, win 64240, length 0`);
  }
  const head = `verbose output suppressed, use <detail> or <extensive> for full protocol decode\nAddress resolution is ON. Use <no-resolve> to avoid any reverse lookup delay.\nAddress resolution timeout is 4s.\nListening on ${n}, capture size 96 bytes\n\n`;
  let k = 0;
  let started = false;
  let shown = 0;
  return genStream(() => {
    if (!started) {
      started = true;
      return { d: 100, t: head };
    }
    if (!lines.length) return { d: 1000, t: '' };
    const l = lines[k++ % lines.length];
    shown++;
    return { d: 500, t: `${fmtDate(W.time.t, 'datetime').slice(11)}:${String(k % 60).padStart(2, '0')}.${String(hashStr(l + k) % 999999).padStart(6, '0')} ${l}\n` };
  }, () => `^C\n${shown} packets received by filter\n0 packets dropped by kernel\n`);
}

// =============================================================================================
export function makeJunos(evo) {
  const H = {
    show: 'Show system information', configure: 'Manipulate software configuration information', ping: 'Ping remote target', traceroute: 'Trace route to remote host', request: 'Make system-level requests', monitor: 'Show real-time debugging information', clear: 'Clear information in the system', set: 'Set a configuration parameter', delete: 'Delete a data element', edit: 'Edit a sub-element', commit: 'Commit current set of changes', rollback: 'Roll back to previous committed configuration', run: 'Run an operational-mode command', top: 'Exit to top level of configuration', up: 'Exit one level of configuration', exit: 'Exit from this level', quit: 'Exit from this level', compare: 'Compare configuration changes with prior version', interfaces: 'Show interface information', route: 'Show routing table information', ospf: 'Show information about OSPF', bgp: 'Show BGP information', vrrp: 'Show Virtual Router Redundancy Protocol information', lacp: 'Show Link Aggregation Control Protocol information', vlans: 'Show VLAN information', configuration: 'Show current configuration', log: 'Show contents of log file', system: 'Show system information', chassis: 'Show chassis information', version: 'Show software process revision levels', terse: 'Display terse output', extensive: 'Display extensive output', summary: 'Display summary output', neighbor: 'Show OSPF neighbor information', security: 'Show security information', lldp: 'Show Link Layer Discovery Protocol information', arp: 'Show system Address Resolution Protocol table entries', 'ethernet-switching': 'Show Ethernet-switching information', 'spanning-tree': 'Show spanning tree information', deactivate: 'Remove the inactive tag from a statement'.replace('Remove', 'Add'), activate: 'Remove the inactive tag from a statement',
  };
  const op = [
    { p: 'show version [detail]', run: (s) => [`Hostname: ${s.dev.cfg.hostname}`, `Model: ${s.dev.model}`, `Junos: ${s.dev.version}`, evo ? `JUNOS OS Kernel 64-bit  [${s.dev.version}]` : `JUNOS OS Kernel 64-bit  [20${String(s.dev.version).slice(0, 2)}${hashStr(s.dev.version) % 9}0101.cd5fbd5_builder_stable_11]`, `JUNOS OS libs [${s.dev.version}]`, `JUNOS ${evo ? 'Evolved ' : ''}Routing Software Suite [${s.dev.version}]`] },
    { p: 'show system uptime', run: (s) => [`Current time: ${fmtDate(s.world.time.t, 'datetime')}:00 UTC`, `Time Source:  ${s.dev.cfg.svc.ntp.length ? 'NTP CLOCK' : 'LOCAL CLOCK'}`, `System booted: ${fmtDate(s.dev.run.boot, 'datetime')}:00 UTC (${upJunos(uptimeMins(s.world, s.dev))} ago)`, `Last configured: ${fmtDate(s.dev.run.lastCfg, 'datetime')}:00 UTC (${upJunos(s.world.time.t - s.dev.run.lastCfg)} ago) by ${s.dev.run.lastCfgBy || 'root'}`] },
    { p: 'show system alarms', run: (s) => {
      const al = [...s.dev.hw.psus.map((ok, k) => (!ok ? `Major  PEM ${k} Not OK` : null)), ...s.dev.hw.fans.map((ok, k) => (!ok ? `Major  Fan Tray ${k} Failure` : null)), s.dev.hw.temp > 60 ? 'Major  FPC 0 Temperature Hot' : null, !s.dev.startup ? 'Minor  Rescue configuration is not set' : null].filter(Boolean);
      return al.length ? [`${al.length} alarms currently active`, 'Alarm time               Class  Description', ...al.map((x) => `${fmtDate(s.world.time.t - 30, 'datetime')}:00 UTC  ${x}`)] : 'No alarms currently active';
    } },
    { p: 'show chassis alarms', run: (s) => (s.dev.hw.psus.every(Boolean) && s.dev.hw.fans.every(Boolean) ? 'No alarms currently active' : [`1 alarms currently active`, 'Alarm time               Class  Description', `${fmtDate(s.world.time.t - 30, 'datetime')}:00 UTC  Major  ${!s.dev.hw.psus.every(Boolean) ? `PEM ${s.dev.hw.psus.indexOf(false)} Not OK` : 'Fan Tray Failure'}`]) },
    { p: 'show chassis environment', run: (s) => ['Class Item                           Status     Measurement', ...s.dev.hw.psus.map((ok, k) => `Power ${padR(`PEM ${k}`, 31)}${ok ? 'OK' : 'Check'}`), `Temp  ${padR('FPC 0 CPU', 31)}${padR(s.dev.hw.temp > 60 ? 'Check' : 'OK', 11)}${Math.round(s.dev.hw.temp)} degrees C / ${Math.round(s.dev.hw.temp * 1.8 + 32)} degrees F`, ...s.dev.hw.fans.map((ok, k) => `Fans  ${padR(`Fan Tray ${k} Fan 0`, 31)}${padR(ok ? 'OK' : 'Failed', 11)}${ok ? 'Spinning at normal speed' : ''}`)] },
    { p: 'show chassis hardware', run: (s) => ['Hardware inventory:', 'Item             Version  Part number  Serial number     Description', `Chassis                                ${padR(s.dev.hw.serial, 18)}${s.dev.model.toUpperCase()}`, ...s.dev.hw.psus.map((ok, k) => `PEM ${k}            Rev 02   740-041741   ${padR(`1EDB${hashStr(s.dev.id + k) % 99999}`, 18)}AC 650W PSU`), 'FPC 0            REV 10   650-044931   ' + padR(s.dev.hw.serial.slice(2), 18) + s.dev.model.toUpperCase()] },
    { p: 'show interfaces terse [$word:if]', run: (s, a) => terse(s, a.if ? a.if.replace(/\.0$/, '') : null) },
    { p: 'show interfaces [$word:if] [{extensive|detail|brief}]', run: (s, a) => {
      if (!a.if) return physIfs(s.dev).flatMap((n) => [...showIf(s, n, a.has('extensive')), '']);
      const n = canon(s.dev, s.dev.cfg, a.if);
      if (!n) return `error: device ${a.if} not found`;
      return showIf(s, n, a.has('extensive'));
    } },
    { p: 'show interfaces diagnostics optics [$word:if]', run: (s, a) => physIfs(s.dev).filter((n) => !a.if || n === a.if).flatMap((n) => {
      const o = optics(s.dev, n);
      if (!o) return [];
      const mw = (d) => (10 ** (d / 10)).toFixed(4);
      return [`Physical interface: ${n}`, `    Laser bias current                        :  ${o.bias.toFixed(3)} mA`, `    Laser output power                        :  ${mw(o.tx)} mW / ${o.tx.toFixed(2)} dBm`, `    Module temperature                        :  ${o.temp} degrees C / ${Math.round(o.temp * 1.8 + 32)} degrees F`, `    Module voltage                            :  ${o.volt.toFixed(4)} V`, `    Receiver signal average optical power     :  ${mw(o.rx)} mW / ${o.rx.toFixed(2)} dBm`, `    Laser bias current high alarm             :  Off`, `    Laser output power low alarm              :  Off`, `    Laser rx power low alarm                  :  ${o.rx < -14 ? 'On' : 'Off'}`, `    Laser rx power low warning                :  ${o.rx < -10.5 ? 'On' : 'Off'}`, ''];
    }) },
    { p: 'show route [$word:ip] [protocol $word:proto] [table $word:table] [{detail|extensive|terse}]', run: (s, a) => showRoute(s, a) },
    { p: 'show route forwarding-table destination $ip:ip', run: (s, a) => {
      const r = lookup(s.world, s.dev, a.ip);
      return ['Routing table: default.inet', 'Internet:', 'Destination        Type RtRef Next hop           Type Index    NhRef Netif', r ? `${padR(r.pfx, 19)}user     0 ${padR(r.nh || '', 19)}ucst  1734     5 ${ifu(s.dev, r.oif)}` : `default            perm     0                    rjct    36     1`];
    } },
    { p: 'show ospf neighbor [{detail|extensive}]', run: (s) => (s.dev.cfg.ospf.on ? ospfNbr(s) : 'OSPF instance is not running') },
    { p: 'show ospf interface [{detail|extensive}]', run: (s) => (s.dev.cfg.ospf.on ? ospfInt(s) : 'OSPF instance is not running') },
    { p: 'show ospf database', run: (s) => ['', '    OSPF database, Area 0.0.0.0', ' Type       ID               Adv Rtr           Seq      Age  Opt  Cksum  Len', ...Object.keys(S_(s.world).ospf).map((d, k) => `Router  ${k === 0 ? '*' : ' '}${padR(s.world.devices[d].cfg.ospf.rid || '0.0.0.0', 17)}${padR(s.world.devices[d].cfg.ospf.rid || '0.0.0.0', 17)}0x8000000${k + 2}  ${padL(300 + k * 41, 4)}  0x22 0x${(hashStr(d) % 65535).toString(16)}  ${48 + k * 12}`)] },
    { p: 'show bgp summary', run: bgpSummary },
    { p: 'show bgp neighbor [$ip:ip]', run: (s, a) => (S_(s.world).bgp[s.dev.id] || []).filter((r) => !a.ip || r.ip === a.ip).flatMap((r) => [`Peer: ${r.ip}+179 AS ${r.ras}   Local: ${ipOnly(Object.values(s.dev.cfg.ifs).find((i) => i.ip && inNet(r.ip, i.ip))?.ip || '0.0.0.0')}+62044 AS ${s.dev.cfg.bgp.asn}`, `  Group: TRANSIT                Routing-Instance: master`, `  Type: External    State: ${r.up ? 'Established' : r.state.replace(/ \(.*/, '')}    Flags: <${r.up ? 'Sync' : r.state.includes('PfxCt') ? 'PrefixLimitExceeded' : 'ImportEval'}>`, ...(r.reason ? [`  Last Error: ${r.notify || r.reason}`] : []), `  Peer ID: ${r.up ? r.ip : '0.0.0.0'}       Local ID: ${s.dev.cfg.bgp.rid || '0.0.0.0'}       Active Holdtime: 90`, ...(r.up ? [`  Table inet.0 Bit: 20000`, `    Active prefixes:              ${r.pfx}`, `    Received prefixes:            ${r.pfx}`, `    Accepted prefixes:            ${r.pfx}`, `    Advertised prefixes:          ${r.adv?.length || 0}`] : []), '']) },
    { p: 'show route advertising-protocol bgp $ip:ip', run: (s, a) => {
      const r = (S_(s.world).bgp[s.dev.id] || []).find((x) => x.ip === a.ip);
      return ['', 'inet.0: routes', '  Prefix                  Nexthop              MED     Lclpref    AS path', ...(r?.adv || []).map((p) => `* ${padR(p, 24)}Self                                    I`)];
    } },
    { p: 'show route receive-protocol bgp $ip:ip', run: (s, a) => {
      const r = (S_(s.world).bgp[s.dev.id] || []).find((x) => x.ip === a.ip);
      return ['', 'inet.0: routes', '  Prefix                  Nexthop              MED     Lclpref    AS path', ...(r?.up ? [`* 0.0.0.0/0               ${padR(r.ip, 21)}                    ${r.ras} I`] : [])];
    } },
    { p: 'show vrrp [summary]', run: vrrpSummary },
    { p: 'show lacp interfaces [$word:if]', run: lacpIf },
    { p: 'show vlans [$word:v]', run: showVlans },
    { p: 'show ethernet-switching table', run: (s) => ['', 'MAC flags (S - static MAC, D - dynamic MAC, L - locally learned, P - Persistent static', '           SE - statistics enabled, NM - non configured MAC, R - remote PE MAC, O - ovsdb MAC)', '', `Ethernet switching table : ${macTable(s.world, s.dev).length} entries, ${macTable(s.world, s.dev).length} learned`, 'Routing instance : default-switch', '   Vlan                MAC                 MAC         Age    Logical                NH        RTR', '   name                address             flags              interface              Index     ID', ...macTable(s.world, s.dev).map((m) => `   ${padR(vlanName(s.dev.cfg, m.vlan), 20)}${padR(macColon(m.mac), 20)}D             -   ${padR(`${m.port}.0`, 23)}0         0`)] },
    { p: 'show ethernet-switching interface [$word:if]', run: (s) => ['Routing Instance Name : default-switch', 'Logical Interface flags (DL - disable learning, AD - packet action drop,', '                         LH - MAC limit hit, DN - interface down,', '                         MMAS - Mac-move action shutdown, AS - Autostate-exclude enabled,', '                         SCTL - shutdown by Storm-control, MI - MAC+IP limit hit)', '', 'Logical         Vlan          TAG     MAC         MAC+IP  STP         Logical           Tagging', 'interface       members               limit       limit   state       interface flags', ...sortedIfs(s.dev, (i) => i.sw && !i.lag).map((n) => {
      const i = s.dev.cfg.ifs[n];
      const bl = S_(s.world).stp.blocked[s.dev.id]?.[n];
      const errd = s.dev.run.errdis[n];
      return `${padR(`${n}.0`, 16)}${padR('', 14)}${padR('', 8)}294912      0       ${padR(errd ? 'Discarding' : bl ? 'Blocking' : 'Forwarding', 12)}${padR(errd ? 'DN,MMAS' : S_(s.world).ifs[s.dev.id][n]?.up ? '' : 'DN', 18)}${i.sw.mode === 'trunk' ? 'tagged' : 'untagged'}\n${' '.repeat(16)}${(i.sw.mode === 'access' ? [i.sw.vlan] : i.sw.allowed === 'all' ? Object.keys(s.dev.cfg.vlans).map(Number) : i.sw.allowed).map((v) => `${padR(vlanName(s.dev.cfg, v), 14)}${padR(v, 8)}`).join(`\n${' '.repeat(16)}`)}`;
    })] },
    { p: 'show spanning-tree bridge', run: (s) => (s.dev.cfg.stp.on ? ['', 'STP bridge parameters ', 'Routing instance name               : GLOBAL', 'Context ID                          : 0', 'Enabled protocol                    : RSTP', `  Root ID                           : ${PRIO(Math.min(...Object.values(s.dev.cfg.stp.prio), 32768))}.${macColon(macOfIf(s.dev, 'base'))}`, '  Hello time                        : 2 seconds', '  Maximum age                       : 20 seconds', '  Forward delay                     : 15 seconds', `  Local bridge ID                   : ${PRIO(Math.min(...Object.values(s.dev.cfg.stp.prio), 32768))}.${macColon(macOfIf(s.dev, 'base'))}`] : 'STP is not enabled') },
    { p: 'show spanning-tree interface', run: (s) => ['', 'Spanning tree interface parameters for instance 0', '', 'Interface    Port ID    Designated      Designated         Port    State  Role', '                         port ID        bridge ID          Cost', ...sortedIfs(s.dev, (i, n) => i.sw && !i.lag && S_(s.world).ifs[s.dev.id][n]?.up).map((n) => {
      const bl = S_(s.world).stp.blocked[s.dev.id]?.[n]?.size;
      return `${padR(n, 13)}${padR(`128:${(hashStr(n) % 500) + 1}`, 11)}${padR(`128:${(hashStr(n) % 500) + 1}`, 16)}32768.${macColon(macOfIf(s.dev, 'base')).slice(0, 14)}  ${padR(20000, 8)}${padR(bl ? 'BLK' : 'FWD', 7)}${bl ? 'ALT' : 'DESG'}`;
    })] },
    { p: 'show lldp neighbors', run: (s) => ['Local Interface    Parent Interface    Chassis Id          Port info          System Name', ...neighbours(s.world, s.dev).map((n) => `${padR(n.local, 19)}${padR('-', 20)}${padR(macColon(macOfIf(n.dev || s.dev, 'base')), 20)}${padR(n.port, 19)}${n.dev?.hostname || n.host?.name}`)] },
    { p: 'show arp [no-resolve]', run: (s) => ['MAC Address       Address         Name                      Interface               Flags', ...arpTable(s.world, s.dev).filter((x) => !x.self).map((x) => `${padR(macColon(x.mac), 18)}${padR(x.ip, 16)}${padR(x.ip, 26)}${padR(ifu(s.dev, x.if), 24)}none`), `Total entries: ${arpTable(s.world, s.dev).filter((x) => !x.self).length}`] },
    { p: 'show log messages', run: showLog },
    { p: 'show configuration [$line:path]', run: (s, a) => configText(s.dev, s.dev.cfg, (a.path || '').split(/\s+/).filter(Boolean), a.pipes.some((p) => /^display set/.test(p))), rawPipes: false },
    { p: 'show system commit', run: (s) => [`0   ${fmtDate(s.dev.run.lastCfg, 'datetime')}:00 UTC by ${s.dev.run.lastCfgBy || 'root'} via cli`, ...s.dev.run.rollback.map((r, k) => `${k + 1}   ${fmtDate(r.t, 'datetime')}:00 UTC by ${r.by || 'root'} via ${r.via === 'console' ? 'cli' : 'cli'}${r.comment ? `\n    ${r.comment}` : ''}`)] },
    { p: 'show security policies', run: (s) => (isFw(s.dev) ? s.dev.cfg.fw.pol.flatMap((p, k) => [`From zone: ${Z(p.from)}, To zone: ${Z(p.to)}`, `  Policy: ${p.name}, State: ${p.on ? 'enabled' : 'disabled'}, Index: ${k + 4}, Scope Policy: 0, Sequence number: 1`, `    Source addresses: any`, `    Destination addresses: ${p.dst === 'all' ? 'any' : p.dst}`, `    Applications: ${p.svc === 'HTTPS' ? 'junos-https' : 'any'}`, `    Action: ${p.act === 'accept' ? 'permit' : 'deny'}`]) : 'error: the security subsystem is not running') },
    { p: 'show security nat source summary', run: (s) => (isFw(s.dev) ? ['Total port number usage for port translation pool: 0', 'Maximum port number for port translation pool: 33554432', 'Total pools: 0', '', 'Total rules: ' + (s.dev.cfg.fw.snat.some((x) => x.on) ? 1 : 0), 'Rule name          Rule set       From              To                   Action', ...(s.dev.cfg.fw.snat.some((x) => x.on) ? ['snat               trust-to-untrust trust          untrust              interface'] : [])] : '') },
    { p: 'show security nat static rule all', run: (s) => (isFw(s.dev) ? [`Total static-nat rules: ${s.dev.cfg.fw.vip.length}`, ...s.dev.cfg.fw.vip.flatMap((v) => ['', `Static NAT rule: ${v.name.toLowerCase().replace(/^vip-/, '')}       Rule-set: STATIC`, '  Rule-Id                    : 1', '  From zone                  : untrust', `  Destination addresses      : ${v.ext}`, `  Host addresses             : ${v.int}`, '  Netmask                    : 32', `  Translation hits           : ${hashStr(v.name) % 9000}`])] : '') },
    { p: 'show security flow session [summary]', run: (s) => (isFw(s.dev) ? [`Valid sessions: ${30 + (s.world.time.t % 50)}`, 'Pending sessions: 0', 'Invalidated sessions: 0', 'Sessions in other states: 0', `Total sessions: ${30 + (s.world.time.t % 50)}`] : '') },
    { p: 'show security zones', run: (s) => (isFw(s.dev) ? ['trust', 'untrust'].flatMap((z) => ['', `Security zone: ${z}`, '  Send reset for non-SYN session TCP packets: Off', '  Policy configurable: Yes', `  Interfaces bound: ${Object.values(s.dev.cfg.ifs).filter((i) => Z(i.zone) === z).length}`, '  Interfaces:', ...Object.entries(s.dev.cfg.ifs).filter(([, i]) => Z(i.zone) === z).map(([n]) => `    ${n}.0`)]) : '') },
    { p: 'show system users', run: (s) => [` ${fmtDate(s.world.time.t, 'datetime').slice(11)}  up ${upJunos(uptimeMins(s.world, s.dev))}, 1 user, load averages: 0.21, 0.18, 0.16`, 'USER     TTY      FROM                              LOGIN@  IDLE WHAT', `${padR(s.user, 9)}pts/0    10.250.0.10                      ${fmtDate(s.world.time.t, 'datetime').slice(11)}       - -cli (cli)`] },
    { p: 'show cli', run: (s) => ['CLI complete-on-space set to on', 'CLI idle-timeout disabled', 'CLI restart-on-upgrade set to on', `CLI screen-length set to ${s.termLen}`, 'CLI screen-width set to 80', 'CLI terminal is \'xterm\''] },
    { p: 'ping $host:host [count $num(1-2000000000):count] [rapid] [size $num(0-65468):size] [do-not-fragment] [routing-instance $word:inst] [source $ip:source]', run: junosPing },
    { p: 'traceroute $host:host [routing-instance $word:inst]', run: (s, a) => {
      const vrf = a.inst === 'mgmt_junos' ? s.dev.cfg.ifs[s.dev.meta.mgmtIf]?.vrf || null : null;
      const { hops } = trace(s, a.host, { vrf });
      return stream([{ d: 10, t: `traceroute to ${a.host} (${a.host}), 30 hops max, 52 byte packets\n` }, ...hops.flatMap((h, k) => (h.ok ? [{ d: 400, t: ` ${k + 1}  ${h.ip} (${h.ip})  ${(0.5 + k).toFixed(3)} ms  ${(0.6 + k).toFixed(3)} ms  ${(0.4 + k).toFixed(3)} ms\n` }] : [1, 2, 3, 4].map((x) => ({ d: 1500, t: ` ${k + x}  * * *\n` }))))]);
    } },
    { p: 'monitor traffic interface $word:if [no-resolve] [matching $line:m]', run: monitorTraffic },
    { p: 'monitor interface $word:if', run: (s, a) => {
      const n = canon(s.dev, s.dev.cfg, a.if);
      const c = counters(s.world, s.dev, n);
      return [`${s.dev.cfg.hostname}                  Seconds: 3                   Time: ${fmtDate(s.world.time.t, 'datetime').slice(11)}:03`, '', `Interface: ${n}, Enabled, Link is ${S_(s.world).ifs[s.dev.id][n]?.up ? 'Up' : 'Down'}`, `Input bytes:              ${c.inB} (${c.rateIn} bps)`, `Output bytes:             ${c.outB} (${c.rateOut} bps)`, `Input errors:             ${c.inErr}`, `Framing errors:           ${c.crc}`];
    } },
    { p: 'clear ethernet-switching bpdu-error interface $word:if', run: (s, a) => {
      const n = canon(s.dev, s.dev.cfg, a.if);
      if (!n) return `error: interface ${a.if} not found`;
      delete s.dev.run.errdis[n];
      s.world.dirty = true;
      return '';
    } },
    { p: 'clear interfaces statistics {all|$word:if}', run: (s) => {
      for (const n of Object.keys(s.dev.cfg.ifs)) s.dev.run.counters[n] = { clear: s.world.time.t, crcBase: 0 };
      return '';
    } },
    { p: 'request system reboot', run: (s) => ask('Reboot the system ? [yes,no] (no) ', (x) => {
      if (!/^y/i.test(x)) return '';
      reload(s.world, s.dev, { reason: 'Router rebooted after a normal shutdown.' });
      if (s.via !== 'console') s.closed = true;
      return `\n*** FINAL System shutdown message from ${s.user}@${s.dev.cfg.hostname} ***\n\nSystem going down IMMEDIATELY\n\nShutdown NOW!\n[pid ${hashStr(String(s.world.time.t)) % 90000}]\n`;
    }) },
    { p: 'request system configuration rescue save', run: () => '' },
    { p: 'set cli screen-length $num(0-100000):n', run: (s, a) => ((s.termLen = a.n), `Screen length set to ${a.n}`) },
    { p: 'configure [{exclusive|private}]', run: (s) => {
      s.mode = 'cfg';
      s.ctx.path = [];
      s.cand = s.dev.run.cand ? s.dev.run.cand : deep(s.dev.cfg);
      s.dev.run.cand = s.cand;
      const changed = JSON.stringify(s.cand) !== JSON.stringify(s.dev.cfg);
      return `Entering configuration mode${changed ? '\nThe configuration has been changed but not committed' : ''}`;
    } },
    { p: '{exit|quit}', run: (s) => ((s.closed = true), '') },
  ];
  const doCommit = (s, a) => {
    if (JSON.stringify(s.cand) === JSON.stringify(s.dev.cfg) && !a.has('confirmed')) return 'commit complete';
    if (a.has('check')) return 'configuration check succeeds';
    const v = validate(s);
    if (v) return v;
    const conf = a.has('confirmed') ? a.mins || 10 : null;
    commitApply(s, s.cand, a.comment || null);
    s.cand = deep(s.dev.cfg);
    s.dev.run.cand = null;
    if (conf) s.dev.run.confirmUntil = s.world.time.t + conf;
    else s.dev.run.confirmUntil = null;
    const msg = conf ? `configuration check succeeds\ncommit confirmed will be automatically rolled back in ${conf} minutes unless confirmed\ncommit complete\n\n# commit confirmed will be rolled back in ${conf} minutes` : 'configuration check succeeds\ncommit complete';
    if (a.has('and-quit')) {
      s.mode = 'op';
      s.cand = null;
      return `${msg}\nExiting configuration mode`;
    }
    return stream([{ d: 900, t: msg + '\n' }]);
  };
  const cfgCmds = [
    { p: 'set $line:rest', run: (s, a) => setDel(s, a.rest, false) },
    { p: 'delete [$line:rest]', run: (s, a) => (a.rest ? setDel(s, a.rest, true) : ask('Delete everything under this level? [yes,no] (no) ', () => 'warning: deleting everything is disabled in Uptime Empire')) },
    { p: '{deactivate|activate} $line:rest', run: (s, a) => activate(s, a.rest, a.has('deactivate')) },
    { p: 'edit [$line:rest]', run: (s, a) => {
      const toks = (a.rest || '').split(/\s+/).filter(Boolean);
      if (toks.length && !['interfaces', 'protocols', 'routing-options', 'system', 'vlans', 'security', 'firewall', 'policy-options', 'forwarding-options', 'snmp', 'chassis'].includes(toks[0]) && !s.ctx.path.length) return `${' '.repeat(s.prompt.split('\n').pop().length + 5)}^\nsyntax error.`;
      s.ctx.path = [...s.ctx.path, ...toks];
      return '';
    } },
    { p: 'top [$line:rest]', run: (s, a) => {
      s.ctx.path = [];
      return a.rest ? s.dialect.trie(s, 'cfg') && s.exec(a.rest).text : '';
    } },
    { p: 'up [$num:n]', run: (s, a) => {
      s.ctx.path = s.ctx.path.slice(0, Math.max(0, s.ctx.path.length - (a.n || 1) - (/^(unit|area|group|neighbor|interface|vlan|route|policy|security-zone)$/.test(s.ctx.path[s.ctx.path.length - 2] || '') ? 1 : 0)));
      return '';
    } },
    { p: 'show [$line:path]', run: (s, a) => {
      const pipes = a.pipes || [];
      if (pipes.some((p) => /^compare/.test(p))) {
        const m = pipes.find((p) => /^compare/.test(p)).match(/rollback (\d+)/);
        const base = m ? s.dev.run.rollback[Number(m[1]) - 1]?.cfg || s.dev.cfg : s.dev.cfg;
        return compare(s.dev, base, s.cand);
      }
      const path = [...s.ctx.path, ...(a.path || '').split(/\s+/).filter(Boolean)];
      const out = configText(s.dev, s.cand, path, pipes.some((p) => /^display set/.test(p)));
      return out.length ? out : '';
    }, rawPipes: false },
    { p: 'commit [check] [confirmed [$num(1-65535):mins]] [comment $word:comment] [and-quit]', run: doCommit },
    { p: 'rollback [$num(0-49):n]', run: (s, a) => {
      const n = a.n || 0;
      if (n === 0) s.cand = deep(s.dev.cfg);
      else {
        const r = s.dev.run.rollback[n - 1];
        if (!r) return `error: Cannot access rollback ${n} (no such file or directory)`;
        s.cand = deep(r.cfg);
      }
      s.dev.run.cand = s.cand;
      return 'load complete';
    } },
    { p: 'run $line:cmd', run: (s, a) => {
      const keep = s.mode;
      s.mode = 'op';
      const r = s.exec(a.cmd);
      s.mode = keep;
      return r.stream || r.ask || r.text.replace(/\n$/, '');
    } },
    { p: '{exit|quit} [configuration-mode]', run: (s, a) => {
      if (s.ctx.path.length && !a.has('configuration-mode')) {
        s.ctx.path = [];
        return '';
      }
      const leave = () => {
        s.mode = 'op';
        s.cand = null;
        return 'Exiting configuration mode';
      };
      if (JSON.stringify(s.cand) !== JSON.stringify(s.dev.cfg)) return ask('The configuration has been changed but not committed\nExit with uncommitted changes? [yes,no] (yes) ', (x) => (/^n/i.test(x.trim()) ? '' : leave()));
      return leave();
    } },
    { p: 'status', run: (s) => ['Users currently editing the configuration:', `  ${s.user} terminal p0 (pid ${hashStr(s.user) % 90000}) on since ${fmtDate(s.world.time.t, 'datetime')}:00 UTC`, `      [edit${s.ctx.path.length ? ` ${s.ctx.path.join(' ')}` : ''}]`] },
  ];
  const setTrie = compile(SET.map(([p, fn]) => ({ p, run: (s, a) => fn(s, a, s.vars.del) })), {});
  const actTrie = compile(ACTIVATE.map(([p, fn]) => ({ p, run: (s, a) => fn(s, a, s.vars.off) })), {});
  function runPath(s, trie, rest) {
    const full = [...s.ctx.path, rest].join(' ').trim();
    const sub = { ...s, mode: 'x', dialect: { ...s.dialect, trie: () => trie, fallback: null, onUnknown: null, preprocess: null, error: (ss, kind) => kind } };
    Object.setPrototypeOf(sub, Object.getPrototypeOf(s));
    sub.dialect = { ...s.dialect, trie: () => trie, fallback: null, onUnknown: null, preprocess: null, error: (ss, kind, x) => `ERR:${kind}:${x.pos}` };
    const r = sub.exec(full);
    s.candDirty = s.candDirty || sub.candDirty;
    if (sub.pending) s.pending = sub.pending;
    return r;
  }
  function setDel(s, rest, del) {
    s.vars.del = del;
    const r = runPath(s, setTrie, rest);
    if (r.ask) return r.ask;
    const t = r.text || '';
    if (t.startsWith('ERR:')) {
      const [, kind, pos] = t.trim().split(':');
      const off = s.prompt.split('\n').pop().length + (del ? 7 : 4) + Math.max(0, Number(pos) - (s.ctx.path.join(' ').length + (s.ctx.path.length ? 1 : 0)));
      if (kind === 'incomplete') return 'error: statement incomplete';
      if (kind === 'ambiguous') return `${' '.repeat(off)}^\nsyntax error, ambiguous.`;
      return `${' '.repeat(off)}^\nsyntax error.`;
    }
    if (del && !t.trim()) return '';
    return t.replace(/\n$/, '');
  }
  function activate(s, rest, off) {
    s.vars.off = off;
    const r = runPath(s, actTrie, rest);
    const t = r.text || '';
    if (t.startsWith('ERR:')) return 'warning: statement not found';
    return t.replace(/\n$/, '');
  }
  function validate(s) {
    const c = s.cand;
    for (const [n, i] of Object.entries(c.ifs)) if (i.fhrp && !i.ip) return `[edit interfaces ${n}]\n  'vrrp-group ${i.fhrp.grp}'\n    Missing mandatory statement: 'address'\nerror: configuration check-out failed`;
    if (c.bgp.on && c.bgp.nbrs.length && !c.bgp.asn) return "[edit protocols bgp]\n  'group TRANSIT'\n    Error in neighbor: local AS is not configured\nerror: configuration check-out failed";
    for (const nb of c.bgp.nbrs) if (!nb.ras) return `[edit protocols bgp group TRANSIT neighbor ${nb.ip}]\n  'peer-as'\n    Missing mandatory statement: 'peer-as'\nerror: configuration check-out failed`;
    for (const [, i] of Object.entries(c.ifs)) if (i.sw?.mode === 'access' && !(i.sw.vlan in c.vlans) && i.sw.vlan !== 1) return `[edit interfaces]\n  'unit 0'\n    Referenced vlan ${i.sw.vlan} does not exist\nerror: configuration check-out failed`;
    return null;
  }
  const tries = { op: compile(op, H), cfg: compile(cfgCmds, H) };
  return {
    id: evo ? 'evo' : 'junos',
    startMode: 'op',
    pipes: ['match', 'except', 'count', 'no-more', 'last', 'display', 'compare'],
    pipeAlias: { m: 'match', e: 'except' },
    defaultLen: 40,
    more: '---(more)---',
    consoleLogin: true,
    prompt: (s) => (s.dev.state !== 'up' ? '' : s.mode === 'op' ? `${s.user}@${s.dev.cfg.hostname}> ` : `\n[edit${s.ctx.path?.length ? ` ${s.ctx.path.join(' ')}` : ''}]\n${s.user}@${s.dev.cfg.hostname}# `),
    greeting: (s) => `Last login: ${fmtDate(s.world.time.t - 2880, 'long')} from 10.250.0.10\n--- JUNOS ${s.dev.version} Kernel 64-bit  ${evo ? 'JNPR-EVO' : 'JNPR-12.1-20200731.1d8df1a_buil'}\n`,
    loginPrompt: (dev) => `${dev.cfg.hostname} (ttyu0)\n\nlogin: `,
    telnetBanner: () => '',
    consoleBanner: () => '',
    closeMsg: (s) => (s.via === 'console' ? '\n[Disconnected from console server]\n' : `Connection to ${s.world.design.mgmt[s.dev.id]} closed.\n`),
    preprocess: (s) => (s.dev.state !== 'up' ? '' : undefined),
    trie: (s, m) => tries[m] || tries.op,
    matchIf(s, toks, i) {
      const v = toks[i].v;
      const c = cfgOf(s);
      const n = canon(s.dev, c, v);
      return n ? { val: n, n: 1 } : null;
    },
    ifNames: (s) => Object.keys(s.dev.cfg.ifs),
    helpFmt(s, items, cr) {
      const out = ['Possible completions:'];
      if (cr) out.push('  <[Enter]>            Execute this command');
      for (const [k, h] of items) out.push(`  ${padR(k, 21)}${h}`);
      if (s.mode === 'op') out.push('  |                    Pipe through a command');
      return out.join('\n');
    },
    error(s, kind, x) {
      const off = s.prompt.split('\n').pop().length + x.pos;
      if (kind === 'ambiguous') return `${' '.repeat(off)}^\n'${x.toks[x.at].v}' is ambiguous.\nPossible completions:\n${x.options.map((o) => `  ${padR(o, 21)}${H[o] || ''}`).join('\n')}`;
      if (kind === 'incomplete') return `${' '.repeat(s.prompt.split('\n').pop().length + x.line.length)}^\nsyntax error, expecting <command>.`;
      if (kind === 'pipe') return 'syntax error, expecting <command>.';
      return `${' '.repeat(off)}^\n${x.at === 0 ? 'unknown command.' : 'syntax error, expecting <command>.'}`;
    },
    ctrlC: () => '\n',
    fmtEvent: fmtEventJunos,
  };
}
export { toSet as junosSet };
void tokenize;
void yearOf;
void ip2n;
void diffLines;
void logEvent;
