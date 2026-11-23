// HP / Aruba: AOS-CX (CX switches), AOS-Switch (ProCurve / 2930 / 5400), ArubaOS controllers and the
// Aruba AP boot loader (apboot).
import { compile, ask, stream } from './engine.js';
import { model, resolveIf } from '../net/catalog.js';
import { ensureVlan, ensureSvi, ensureLag, newIf, saveStartup } from '../net/model.js';
import { S_, cfgOf, changed, configEnded, ping, trace, counters, sortedIfs, physIfs, uptimeMins, ipOnly, lenOf, optics, neighbours, macTable, macOfIf, arpTable, natCmp } from './common.js';
import { lookup, walk } from '../net/sim.js';
import { reload } from '../net/devops.js';
import { logEvent, recompute } from '../net/events.js';
import { ifStatusWord, duplexSpeed, stpInfo } from './ios.js';
import { cidr, n2ip, maskStr, maskLen, isIp, fmtDate, fmtVlans, parseVlans, padR, padL, hashStr, yearOf, macColon, macDash, upCisco, inNet } from '../core/util.js';

const sel = (s) => cfgOf(s).ifs[s.ctx.if];
const isL3 = (dev) => model(dev.model).feat.includes('l3');
const dur = (m) => {
  const sec = Math.max(0, Math.floor(m * 60));
  return `${String(Math.floor(sec / 3600)).padStart(2, '0')}h:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m:${String(sec % 60).padStart(2, '0')}s`;
};
function linuxPing(s, target, { count = 5, vrf = null, size = 100 } = {}) {
  if (!isIp(target)) return `ping: ${target}: Name or service not known`;
  const p = ping(s, target, { count, size: size + 28, vrf });
  const chunks = [{ d: 10, t: `PING ${target} (${target}) ${size}(${size + 28}) bytes of data.\n` }];
  p.res.forEach((x, k) => chunks.push({ d: x.ok ? 600 : 1000, t: x.ok ? `${size + 8} bytes from ${target}: icmp_seq=${k + 1} ttl=${p.r.toDevice ? 64 : 63} time=${(x.rtt * 0.3).toFixed(3)} ms\n` : '' }));
  chunks.push({ d: 0, t: `\n--- ${target} ping statistics ---\n${count} packets transmitted, ${p.recv} received, ${100 - p.pct}% packet loss, time ${count * 1000 + 89}ms\n${p.recv ? `rtt min/avg/max/mdev = ${(p.min * 0.3).toFixed(3)}/${(p.avg * 0.3).toFixed(3)}/${(p.max * 0.3).toFixed(3)}/0.009 ms\n` : ''}` });
  return stream(chunks);
}

// =============================================================================================
// AOS-CX
function cxRunning(s, cfg = s.dev.cfg) {
  const dev = s.dev;
  const L = [`Current configuration:`, '!', `!Version ArubaOS-CX ${String(dev.model).toUpperCase().startsWith('CX') ? 'GL' : 'FL'}.${dev.version}`, `!export-password: default`, `hostname ${cfg.hostname}`];
  for (const u of cfg.svc.users) L.push(`user ${u.name} group administrators password ciphertext AQBapW${hashStr(u.pw).toString(36)}${hashStr(u.pw + 'x').toString(36)}`);
  for (const n of cfg.svc.ntp) L.push(`ntp server ${n}`);
  if (cfg.svc.ntp.length) L.push('ntp enable');
  for (const h of cfg.svc.syslog) L.push(`logging ${h}`);
  if (cfg.svc.ssh) L.push('ssh server vrf mgmt', 'ssh server vrf default');
  if (cfg.svc.snmp) L.push(`snmp-server community ${cfg.svc.snmp}`);
  L.push('vlan 1');
  for (const v of Object.keys(cfg.vlans).map(Number).sort((a, b) => a - b)) if (v !== 1) L.push(`vlan ${v}`, `    name ${cfg.vlans[v]}`);
  if (cfg.stp.on) {
    L.push('spanning-tree');
    const prios = Object.values(cfg.stp.prio);
    if (prios.length) L.push(`spanning-tree priority ${Math.min(...prios) / 4096}`);
  }
  const ifb = (n) => {
    const i = cfg.ifs[n];
    const name = i.kind === 'svi' ? `interface vlan ${i.vlan}` : i.kind === 'lag' ? `interface lag ${i.lagId}` : i.kind === 'lo' ? `interface ${n}` : `interface ${n}`;
    const b = [name];
    if (i.desc) b.push(`    description ${i.desc}`);
    if (i.kind !== 'svi' && i.kind !== 'lo') b.push(i.on ? '    no shutdown' : '    shutdown');
    else if (!i.on) b.push('    shutdown');
    if (i.mgmt) {
      b.push(`    ip static ${i.ip}`);
      return b;
    }
    if (i.lag) {
      b.push(`    lag ${i.lag.id}`);
      return b;
    }
    if (i.mtu && i.mtu !== 1500) b.push(`    mtu ${i.mtu}`);
    if (i.speed !== 'auto' && i.kind === 'phys') b.push(`    speed ${i.speed}-${i.duplex === 'half' ? 'half' : 'full'}`);
    if (i.sw && i.kind !== 'svi') {
      b.push('    no routing');
      if (i.sw.mode === 'access') b.push(`    vlan access ${i.sw.vlan}`);
      else {
        b.push(`    vlan trunk native ${i.sw.native ?? 1}`);
        b.push(`    vlan trunk allowed ${i.sw.allowed === 'all' ? 'all' : fmtVlans(i.sw.allowed)}`);
      }
      if (i.stp?.edge) b.push('    spanning-tree port-type admin-edge');
      if (i.stp?.bpduguard) b.push('    spanning-tree bpdu-guard');
    } else if (i.ip) b.push(`    ip address ${i.ip}`);
    if (i.kind === 'lag') {
      const mem = Object.values(cfg.ifs).find((x) => x.lag?.id === i.lagId);
      if (mem && mem.lag.mode !== 'on') b.push(`    lacp mode ${mem.lag.mode}`);
    }
    for (const h of i.helper || []) b.push(`    ip helper-address ${h}`);
    if (i.fhrp) b.push(`    vrrp ${i.fhrp.grp} address-family ipv4`, `        address ${i.fhrp.vip} primary`, `        priority ${i.fhrp.prio}`, ...(i.fhrp.preempt ? [] : ['        no preempt']), '        no shutdown', '        exit');
    if (i.ospf?.area != null) {
      b.push(`    ip ospf ${cfg.ospf.pid} area ${i.ospf.area}`);
      if (i.ospf.passive) b.push('    ip ospf passive');
      if (i.ospf.cost) b.push(`    ip ospf cost ${i.ospf.cost}`);
      if (i.ospf.hello !== 10) b.push(`    ip ospf hello-interval ${i.ospf.hello}`);
      if (i.ospf.dead !== 40) b.push(`    ip ospf dead-interval ${i.ospf.dead}`);
    }
    return b;
  };
  for (const n of sortedIfs(dev, () => true)) L.push(...ifb(n));
  for (const r of cfg.static) L.push(`ip route ${r.pfx} ${r.iface === 'Null0' ? 'blackhole' : r.nh}${r.ad && r.ad !== 1 ? ` distance ${r.ad}` : ''}`);
  if (cfg.mgmtGw) L.push(`ip route 0.0.0.0/0 ${cfg.mgmtGw.ip} vrf mgmt`);
  if (cfg.ospf.on) {
    L.push(`router ospf ${cfg.ospf.pid}`);
    if (cfg.ospf.rid) L.push(`    router-id ${cfg.ospf.rid}`);
    if (cfg.ospf.defOrig) L.push(`    default-information originate${cfg.ospf.always ? ' always' : ''}`);
    L.push('    area 0.0.0.0');
  }
  L.push('https-server vrf mgmt');
  return L;
}
function cxIntBrief(s) {
  const dev = s.dev;
  const sep = '-'.repeat(104);
  const out = [sep, 'Port       Native  Mode   Type           Enabled Status  Reason                  Speed   Description', '           VLAN                                                                  (Mb/s)', sep];
  for (const n of physIfs(dev).filter((x) => dev.cfg.ifs[x].kind === 'phys')) {
    const i = dev.cfg.ifs[n];
    const w = ifStatusWord(s, dev, n);
    const ds = duplexSpeed(s, dev, n);
    const reason = w.short === 'disabled' ? 'Administratively down' : w.short === 'err-disabled' ? 'BPDU guard' : w.short === 'notconnect' ? 'Waiting for link' : w.short === 'suspended' ? 'LACP' : '';
    out.push(`${padR(n, 11)}${padR(i.sw ? (i.sw.mode === 'trunk' ? i.sw.native : i.sw.vlan) : '--', 8)}${padR(i.sw ? i.sw.mode : 'routed', 7)}${padR((i.hw?.speed || 1000) >= 10000 ? 'SFP+DA3' : '1GbT', 15)}${padR(i.on ? 'yes' : 'no', 8)}${padR(w.short === 'connected' ? 'up' : 'down', 8)}${padR(reason, 24)}${padR(ds.up ? ds.sp : '--', 8)}${i.desc || '--'}`);
  }
  return out;
}
function cxRoute(s, vrf) {
  const dev = s.dev;
  const rib = (S_(s.world).rib[dev.id]?.best || []).filter((r) => (r.vrf || null) === (vrf || null));
  const code = (r) => ({ connected: 'C', local: 'L', static: 'S', ospf: 'O', ospfE: 'O-E2', ebgp: 'B/E' })[r.proto];
  return ['', 'Displaying ipv4 routes selected for forwarding', '', 'Origin Codes: C - connected, S - static, L - local', '              R - RIP, B - BGP, O - OSPF, O-IA - OSPF Inter Area', '              O-E1  - OSPF External Type 1, O-E2  - OSPF External Type 2', '', `VRF: ${vrf || 'default'}`, '', 'Prefix              Nexthop          Interface     VRF(egress)       Origin/   Distance/    Age', '                                                                     Type      Metric', '-'.repeat(104), ...rib.map((r) => `${padR(r.pfx, 20)}${padR(r.nh || '-', 17)}${padR(r.discard ? '-' : r.oif.replace(/^vlan/, 'vlan'), 14)}${padR('-', 18)}${padR(code(r), 10)}${padR(`[${r.ad}/${r.metric}]`, 13)}${['connected', 'local'].includes(r.proto) ? '-' : dur((s.world.time.t - dev.run.boot) % 6000)}`)];
}
export function fmtEventCX(e, dev) {
  const ts = `${fmtDate(e.t, 'iso')}T${fmtDate(e.t, 'datetime').slice(11)}:00.${String(hashStr(String(e.t)) % 1000).padStart(3, '0')}+00:00 ${dev.cfg.hostname}`;
  switch (e.type) {
    case 'link':
      if (e.kind !== 'phys') return null;
      return `${ts} intfd[${700 + (hashStr(dev.id) % 300)}]: Event|403|LOG_INFO|AMM|1/1|Link status for interface ${e.if} is ${e.up ? 'up' : 'down'}`;
    case 'errdis':
      return `${ts} hpe-mstpd[${900 + (hashStr(dev.id) % 99)}]: Event|2016|LOG_WARN|AMM|1/1|Port ${e.if} disabled - BPDU received on protected port.`;
    case 'ospf':
      return `${ts} ospfv2d[${2000 + (hashStr(dev.id) % 99)}]: Event|4802|LOG_INFO|AMM|1/1|OSPF neighbor ${e.nbr} on interface ${e.if} changed state from ${e.from} to ${e.to}`;
    case 'fhrp':
      return `${ts} vrrpd[${3000 + (hashStr(dev.id) % 99)}]: Event|3001|LOG_INFO|AMM|1/1|VRRP ${e.grp} on ${e.if} transitioned to ${e.to === 'active' ? 'MASTER' : 'BACKUP'}`;
    case 'lacp':
      return `${ts} lacpd[${3100 + (hashStr(dev.id) % 99)}]: Event|1311|LOG_INFO|AMM|1/1|LACP partner ${e.state === 'P' ? 'in sync' : 'out of sync'} on interface ${e.if} of ${e.lag}`;
    case 'config':
      return `${ts} hpe-config[${1000 + (hashStr(dev.id) % 99)}]: Event|6801|LOG_INFO|AMM|1/1|Running configuration changed by ${e.by}`;
    case 'login':
      return `${ts} hpe-sshd[${4000 + (hashStr(dev.id) % 99)}]: Event|1201|LOG_INFO|AMM|1/1|User ${e.user} logged in from ${e.from} through SSH session.`;
    case 'authfail':
      return `${ts} hpe-sshd[${4000 + (hashStr(dev.id) % 99)}]: Event|1202|LOG_WARN|AMM|1/1|User ${e.user} failed to login from ${e.from}`;
    case 'psu':
      return `${ts} powerd[${500 + (hashStr(dev.id) % 99)}]: Event|503|LOG_CRIT|AMM|1/1|Power supply 1/${e.n} is ${e.ok ? 'OK' : 'Fault ACOK'}`;
    case 'fan':
      return `${ts} fand[${510 + (hashStr(dev.id) % 99)}]: Event|1906|LOG_CRIT|AMM|1/1|Fan 1/${e.n} has ${e.ok ? 'recovered' : 'failed'}`;
    case 'boot':
      return `${ts} hpe-sysmond[${300 + (hashStr(dev.id) % 99)}]: Event|4605|LOG_INFO|AMM|1/1|System booted, reason: ${dev.run.reloadReason || 'Power On'}`;
    case 'macflap':
      return `${ts} hpe-l2macd[${600 + (hashStr(dev.id) % 99)}]: Event|7006|LOG_WARN|AMM|1/1|MAC ${macColon(e.mac)} is moving between ports ${e.if1} and ${e.if2} on VLAN ${e.vlan}`;
    default:
      return null;
  }
}
export function makeAOSCX() {
  const KW = { show: 'Show running system information', configure: 'Enter the configuration context', ping: 'Send IPv4 ping request(s) to a device on the network', traceroute: 'Trace the IPv4 route to a device on the network', write: 'Write running configuration to memory', copy: 'Copy data or files to/from the switch', interface: 'Enter the Interface configuration context', vlan: 'VLAN configuration', 'no': 'Negate a command or set its defaults', shutdown: 'Disable an interface', routing: 'Configure interface as L3', exit: 'Exit current context', end: 'End current mode and change to enable mode' };
  const ifc = [
    { p: 'shutdown', run: (s) => ((sel(s).on = false), changed(s)) },
    { p: 'no shutdown', run: (s) => {
      sel(s).on = true;
      delete s.dev.run.errdis[s.ctx.if];
      changed(s);
    } },
    { p: 'description $line:d', run: (s, a) => ((sel(s).desc = a.d), changed(s)) },
    { p: 'no description', run: (s) => ((sel(s).desc = ''), changed(s)) },
    { p: 'no routing', run: (s) => {
      const i = sel(s);
      i.sw = i.sw || { mode: 'access', vlan: 1, native: 1, allowed: 'all' };
      i.ip = null;
      changed(s);
    } },
    { p: 'routing', run: (s) => (isL3(s.dev) ? ((sel(s).sw = null), changed(s)) : 'Invalid input: routing') },
    { p: 'vlan access $num(1-4094):v', run: (s, a) => {
      const i = sel(s);
      if (!i.sw) return 'Interface is not a Layer 2 port. Use "no routing" first.';
      if (!(a.v in cfgOf(s).vlans)) return `VLAN ${a.v} does not exist.`;
      Object.assign(i.sw, { mode: 'access', vlan: a.v });
      changed(s);
    } },
    { p: 'vlan trunk native $num(1-4094):v', run: (s, a) => (sel(s).sw ? (Object.assign(sel(s).sw, { mode: 'trunk', native: a.v }), changed(s)) : 'Interface is not a Layer 2 port.') },
    { p: 'vlan trunk allowed {all|$vlist:l}', run: (s, a) => {
      const i = sel(s);
      if (!i.sw) return 'Interface is not a Layer 2 port.';
      const add = a.l ? parseVlans(a.l) : 'all';
      i.sw.mode = 'trunk';
      i.sw.allowed = add === 'all' ? 'all' : [...new Set([...(i.sw.allowed === 'all' ? [] : i.sw.allowed), ...add])].sort((x, y) => x - y);
      changed(s);
    } },
    { p: 'no vlan trunk allowed $vlist:l', run: (s, a) => {
      const i = sel(s);
      const rm = parseVlans(a.l);
      i.sw.allowed = (i.sw.allowed === 'all' ? Object.keys(cfgOf(s).vlans).map(Number) : i.sw.allowed).filter((v) => !rm.includes(v));
      changed(s);
    } },
    { p: 'ip address $pfx:p', run: (s, a) => (sel(s).sw && sel(s).kind !== 'svi' ? 'Interface is not L3. Use "routing" to enable L3.' : ((sel(s).ip = a.p), changed(s))) },
    { p: 'no ip address [$pfx:p]', run: (s) => ((sel(s).ip = null), changed(s)) },
    { p: 'ip helper-address $ip:ip', run: (s, a) => ((sel(s).helper = [...new Set([...sel(s).helper, a.ip])]), changed(s)) },
    { p: 'no ip helper-address [$ip:ip]', run: (s, a) => ((sel(s).helper = a.ip ? sel(s).helper.filter((x) => x !== a.ip) : []), changed(s)) },
    { p: 'mtu $num(46-9198):m', run: (s, a) => ((sel(s).mtu = a.m), changed(s)) },
    { p: 'speed {auto|10-full|10-half|100-full|100-half|1000-full|10g-full}', run: (s, a) => {
      const v = a.kw[1];
      sel(s).speed = v === 'auto' ? 'auto' : v.startsWith('10g') ? 10000 : Number(v.split('-')[0]);
      sel(s).duplex = v === 'auto' ? 'auto' : v.endsWith('half') ? 'half' : 'full';
      changed(s);
    } },
    { p: 'lag $num(1-256):id', run: (s, a) => {
      const c = cfgOf(s);
      if (!c.ifs[`lag${a.id}`]) return `LAG ${a.id} does not exist.`;
      const mode = Object.values(c.ifs).find((x) => x.lag?.id === a.id)?.lag.mode || c.ifs[`lag${a.id}`].lacpMode || 'on';
      sel(s).lag = { id: a.id, mode };
      changed(s);
    } },
    { p: 'no lag $num:id', run: (s) => ((sel(s).lag = null), changed(s)) },
    { p: 'lacp mode {active|passive}', run: (s, a) => {
      const i = sel(s);
      if (i.kind !== 'lag') return 'Invalid input: lacp';
      i.lacpMode = a.kw[2];
      for (const m of Object.values(cfgOf(s).ifs)) if (m.lag?.id === i.lagId) m.lag.mode = a.kw[2];
      changed(s);
    } },
    { p: 'no lacp mode', run: (s) => {
      for (const m of Object.values(cfgOf(s).ifs)) if (m.lag?.id === sel(s).lagId) m.lag.mode = 'on';
      changed(s);
    } },
    { p: 'spanning-tree port-type admin-edge', run: (s) => ((sel(s).stp.edge = true), changed(s)) },
    { p: 'no spanning-tree port-type', run: (s) => ((sel(s).stp.edge = false), changed(s)) },
    { p: '[no] spanning-tree bpdu-guard', run: (s, a) => ((sel(s).stp.bpduguard = !a.has('no')), changed(s)) },
    { p: 'ip ospf $num(1-63):pid area $word:area', run: (s, a) => {
      const i = sel(s);
      i.ospf = i.ospf || { area: null, cost: null, hello: 10, dead: 40, passive: false };
      i.ospf.area = /^\d+$/.test(a.area) ? n2ip(Number(a.area)) : a.area;
      changed(s);
    } },
    { p: 'no ip ospf $num(1-63):pid area $word:area', run: (s) => (sel(s).ospf && (sel(s).ospf.area = null), changed(s)) },
    { p: '[no] ip ospf passive', run: (s, a) => (sel(s).ospf ? ((sel(s).ospf.passive = !a.has('no')), changed(s)) : 'OSPF is not enabled on this interface.') },
    { p: 'ip ospf {cost|hello-interval|dead-interval} $num(1-65535):v', run: (s, a) => {
      const i = sel(s);
      i.ospf = i.ospf || { area: null, cost: null, hello: 10, dead: 40, passive: false };
      i.ospf[a.has('cost') ? 'cost' : a.has('hello-interval') ? 'hello' : 'dead'] = a.v;
      changed(s);
    } },
    { p: 'no ip ospf {cost|hello-interval|dead-interval}', run: (s, a) => {
      const i = sel(s);
      if (i.ospf) i.ospf[a.has('cost') ? 'cost' : a.has('hello-interval') ? 'hello' : 'dead'] = a.has('cost') ? null : a.has('hello-interval') ? 10 : 40;
      changed(s);
    } },
    { p: 'vrrp $num(1-255):g address-family ipv4', run: (s, a) => {
      const i = sel(s);
      if (!i.fhrp || i.fhrp.grp !== a.g) i.fhrp = { proto: 'vrrp', grp: a.g, vip: null, prio: 100, preempt: true };
      s.mode = 'vrrp';
    } },
    { p: 'no vrrp $num(1-255):g address-family ipv4', run: (s) => ((sel(s).fhrp = null), changed(s)) },
  ];
  const vrrp = [
    { p: 'address $ip:ip primary', run: (s, a) => ((sel(s).fhrp.vip = a.ip), changed(s)) },
    { p: 'priority $num(1-254):p', run: (s, a) => ((sel(s).fhrp.prio = a.p), changed(s)) },
    { p: '[no] preempt', run: (s, a) => ((sel(s).fhrp.preempt = !a.has('no')), changed(s)) },
    { p: '[no] shutdown', run: () => '' },
  ];
  const g = [
    { p: 'hostname $word:h', run: (s, a) => ((cfgOf(s).hostname = a.h), (s.dev.hostname = a.h), changed(s)) },
    { p: 'interface $if:if', run: (s, a) => ((s.ctx = { if: a.if }), (s.mode = 'if'), '') },
    { p: 'interface vlan $num(1-4094):v', run: (s, a) => {
      const n = `vlan${a.v}`;
      if (!cfgOf(s).ifs[n]) ensureSvi(s.dev, a.v), changed(s);
      s.ctx = { if: n };
      s.mode = 'ifvlan';
    } },
    { p: 'no interface vlan $num(1-4094):v', run: (s, a) => (delete cfgOf(s).ifs[`vlan${a.v}`], changed(s)) },
    { p: 'interface lag $num(1-256):id', run: (s, a) => {
      const n = `lag${a.id}`;
      if (!cfgOf(s).ifs[n]) {
        ensureLag(s.dev, a.id);
        cfgOf(s).ifs[n].sw = null;
        changed(s);
      }
      s.ctx = { if: n };
      s.mode = 'iflag';
    } },
    { p: 'interface loopback $num(0-255):n', run: (s, a) => {
      const n = `loopback${a.n}`;
      if (!cfgOf(s).ifs[n]) cfgOf(s).ifs[n] = newIf('lo'), changed(s);
      s.ctx = { if: n };
      s.mode = 'iflo';
    } },
    { p: 'vlan $vlist:l', run: (s, a) => {
      const vl = parseVlans(a.l);
      vl.forEach((v) => ensureVlan(s.dev, v));
      changed(s);
      s.ctx = { vlans: vl };
      s.mode = 'vlan';
    } },
    { p: 'no vlan $vlist:l', run: (s, a) => {
      for (const v of parseVlans(a.l)) if (v !== 1) delete cfgOf(s).vlans[v];
      changed(s);
    } },
    { p: 'ip route $pfx:p {$ip:nh|blackhole} [distance $num(1-255):ad] [vrf $word:vrf]', run: (s, a) => {
      const c = cfgOf(s);
      if (a.vrf === 'mgmt') {
        c.mgmtGw = { vrf: 'mgmt', ip: a.nh };
        return changed(s);
      }
      const r = a.has('blackhole') ? { pfx: a.p, nh: null, iface: 'Null0', ad: a.ad || 1 } : { pfx: a.p, nh: a.nh, ad: a.ad || 1 };
      c.static = c.static.filter((x) => !(x.pfx === r.pfx && x.nh === r.nh));
      c.static.push(r);
      changed(s);
    } },
    { p: 'no ip route $pfx:p [$ip:nh]', run: (s, a) => ((cfgOf(s).static = cfgOf(s).static.filter((x) => !(x.pfx === a.p && (!a.nh || x.nh === a.nh)))), changed(s)) },
    { p: 'router ospf $num(1-63):pid', run: (s, a) => {
      const c = cfgOf(s);
      if (!c.ospf.on) Object.assign(c.ospf, { on: true, pid: a.pid }), changed(s);
      s.mode = 'ospf';
    } },
    { p: 'no router ospf $num(1-63):pid', run: (s) => {
      cfgOf(s).ospf.on = false;
      for (const i of Object.values(cfgOf(s).ifs)) i.ospf = null;
      changed(s);
    } },
    { p: '[no] spanning-tree', run: (s, a) => ((cfgOf(s).stp.on = !a.has('no')), changed(s)) },
    { p: 'spanning-tree priority $num(0-15):p', run: (s, a) => {
      for (const v of Object.keys(cfgOf(s).vlans)) cfgOf(s).stp.prio[v] = a.p * 4096;
      changed(s);
    } },
    { p: 'ntp server $ip:ip', run: (s, a) => ((cfgOf(s).svc.ntp = [...new Set([...cfgOf(s).svc.ntp, a.ip])]), changed(s)) },
    { p: 'logging $ip:ip', run: (s, a) => ((cfgOf(s).svc.syslog = [...new Set([...cfgOf(s).svc.syslog, a.ip])]), changed(s)) },
    { p: 'user $word:u group administrators password plaintext $word:pw', run: (s, a) => {
      const u = cfgOf(s).svc.users.find((x) => x.name === a.u);
      if (u) u.pw = a.pw;
      else cfgOf(s).svc.users.push({ name: a.u, pw: a.pw, priv: 15 });
      changed(s);
    } },
    { p: '[no] ssh server vrf {mgmt|default}', run: (s, a) => ((cfgOf(s).svc.ssh = !a.has('no')), changed(s)) },
  ];
  const ospf = [
    { p: 'router-id $ip:rid', run: (s, a) => ((cfgOf(s).ospf.rid = a.rid), changed(s)) },
    { p: 'area $word:a', run: () => '' },
    { p: 'default-information originate [always]', run: (s, a) => ((cfgOf(s).ospf.defOrig = true), (cfgOf(s).ospf.always = a.has('always')), changed(s)) },
    { p: 'no default-information originate', run: (s) => ((cfgOf(s).ospf.defOrig = false), changed(s)) },
    { p: 'passive-interface default', run: (s) => {
      for (const i of Object.values(cfgOf(s).ifs)) if (i.ospf) i.ospf.passive = true;
      changed(s);
    } },
  ];
  const show = [
    { p: 'show version', run: (s) => ['-'.repeat(80), 'ArubaOS-CX', '(c) Copyright 2017-' + yearOf(s.world.time.t) + ' Hewlett Packard Enterprise Development LP', '-'.repeat(80), `Version      : ${String(s.dev.model).startsWith('cx83') ? 'GL' : 'FL'}.${s.dev.version}`, `Build Date   : ${fmtDate(Math.max(0, s.dev.installed - 60000), 'iso')} 17:24:38 UTC`, 'Build ID     : ArubaOS-CX:' + hashStr(s.dev.version).toString(16), 'Build SHA    : ' + hashStr(s.dev.version + 'x').toString(16), 'Active Image : primary', '', `Service OS Version : ${s.dev.version}`, `BIOS Version       : ${s.dev.version.slice(0, 5)}-0011`] },
    { p: 'show system', run: (s) => [`Hostname           : ${s.dev.cfg.hostname}`, `System Description : ${s.dev.version}`, 'System Contact     : ', 'System Location    : ', '', `Product Name       : ${model(s.dev.model).name}`, `Chassis Serial Nbr : ${s.dev.hw.serial}`, `Base MAC Address   : ${macColon(macOfIf(s.dev, 'base'))}`, `ArubaOS-CX Version : ${s.dev.version}`, '', `Time Zone          : UTC`, '', `Up Time            : ${Math.floor(uptimeMins(s.world, s.dev) / 1440)} days, ${Math.floor((uptimeMins(s.world, s.dev) % 1440) / 60)} hours, ${Math.floor(uptimeMins(s.world, s.dev) % 60)} minutes`, `CPU Util (%)       : ${S_(s.world).stormSegs?.size ? 91 : 3}`, 'Memory Usage (%)   : 24'] },
    { p: 'show interface brief', run: cxIntBrief },
    { p: 'show interface $if:if', run: (s, a) => {
      const i = s.dev.cfg.ifs[a.if];
      const c = counters(s.world, s.dev, a.if);
      const w = ifStatusWord(s, s.dev, a.if);
      const ds = duplexSpeed(s, s.dev, a.if);
      return [`Interface ${a.if} is ${w.short === 'connected' ? 'up' : 'down'}`, ` Admin state is ${i.on ? 'up' : 'down'}`, ...(w.short === 'err-disabled' ? [' State information: Disabled by BPDU guard'] : w.short === 'notconnect' ? [' Link state: down for ' + dur(10)] : [` Link state: up for ${dur(uptimeMins(s.world, s.dev) % 3000)} (since ${fmtDate(s.dev.run.boot, 'long')})`, ` Link transitions: ${c.resets + 1}`]), ` Description: ${i.desc || ''}`, ` Hardware: Ethernet, MAC Address: ${macColon(macOfIf(s.dev, a.if))}`, ` MTU ${i.mtu || 1500}`, ` Type ${(i.hw?.speed || 1000) >= 10000 ? 'SFP+DA3' : '1GbT'}`, ` Full-duplex`.replace('Full', ds.dup === 'half' ? 'Half' : 'Full'), ` qos trust none`, ` Speed ${ds.up ? ds.sp : 0} Mb/s`, ' Auto-negotiation is on', ' Flow-control: off', ' Error-control: off', ` VLAN Mode: ${i.sw ? i.sw.mode : 'routed'}`, ...(i.sw ? [` ${i.sw.mode === 'trunk' ? `Native VLAN: ${i.sw.native}\n Allowed VLAN List: ${i.sw.allowed === 'all' ? 'all' : fmtVlans(i.sw.allowed)}` : `Access VLAN: ${i.sw.vlan}`}`] : []), ' Rate collection interval: 300 seconds', '', ' Rate                               RX                   TX        Total (RX+TX)', ' ---------------- -------------------- -------------------- --------------------', ` Mbits / sec      ${padL((c.rateIn / 1e6).toFixed(2), 20)} ${padL((c.rateOut / 1e6).toFixed(2), 20)} ${padL(((c.rateIn + c.rateOut) / 1e6).toFixed(2), 20)}`, '', ' Statistic                          RX                   TX                Total', ' ---------------- -------------------- -------------------- --------------------', ` Packets          ${padL(c.inP, 20)} ${padL(c.outP, 20)} ${padL(c.inP + c.outP, 20)}`, ` Bytes            ${padL(c.inB, 20)} ${padL(c.outB, 20)} ${padL(c.inB + c.outB, 20)}`, ` Errors           ${padL(c.inErr, 20)} ${padL(c.outErr, 20)} ${padL(c.inErr + c.outErr, 20)}`, ` CRC/FCS          ${padL(c.crc, 20)}                  n/a ${padL(c.crc, 20)}`, ` Collision                         n/a ${padL(c.coll, 20)} ${padL(c.coll, 20)}`];
    } },
    { p: 'show interface transceiver [detail]', run: (s) => ['', '-'.repeat(80), 'Port    Type            Product   Serial          Part', '                        Number    Number          Number', '-'.repeat(80), ...physIfs(s.dev).filter((n) => optics(s.dev, n)).map((n) => {
      const o = optics(s.dev, n);
      return `${padR(n, 8)}${padR(o.type.replace(/^SFP-/, ''), 16)}J9150D    ${padR(`CN${hashStr(n + s.dev.id) % 9999999}`, 16)}1990-4634\n        Rx power: ${o.rx.toFixed(2)} dBm${o.rx < -14 ? ' (low alarm)' : o.rx < -10.5 ? ' (low warning)' : ''}  Tx power: ${o.tx.toFixed(2)} dBm`;
    })] },
    { p: 'show ip interface brief', run: (s) => ['Interface       IP Address            Interface Status', '                                      link/admin', ...sortedIfs(s.dev, (i) => i.ip && !i.mgmt).map((n) => `${padR(n, 16)}${padR(s.dev.cfg.ifs[n].ip, 22)}${S_(s.world).ifs[s.dev.id][n]?.proto ? 'up' : 'down'}/${s.dev.cfg.ifs[n].on ? 'up' : 'down'}`)] },
    { p: 'show vlan [$num(1-4094):v]', run: (s, a) => {
      const dev = s.dev;
      const sep = '-'.repeat(104);
      const out = [sep, 'VLAN  Name                              Status  Reason          Type      Interfaces', sep];
      for (const v of Object.keys(dev.cfg.vlans).map(Number).sort((x, y) => x - y)) {
        if (a.v && v !== a.v) continue;
        const ports = sortedIfs(dev, (i) => i.sw && !i.lag && (i.sw.mode === 'access' ? i.sw.vlan === v : i.sw.native === v || i.sw.allowed === 'all' || i.sw.allowed.includes(v)));
        out.push(`${padR(v, 6)}${padR(v === 1 ? 'DEFAULT_VLAN_1' : dev.cfg.vlans[v], 34)}${padR(ports.length ? 'up' : 'down', 8)}${padR(ports.length ? 'ok' : 'no_member_port', 16)}${padR(v === 1 ? 'default' : 'static', 10)}${ports.join(',')}`);
      }
      return out;
    } },
    { p: 'show ip route [vrf $word:vrf]', run: (s, a) => cxRoute(s, a.vrf === 'mgmt' ? 'mgmt' : null) },
    { p: 'show ip ospf neighbors', run: (s) => [`VRF : default                          Process : ${s.dev.cfg.ospf.pid}`, '='.repeat(90), '', `Total Number of Neighbors : ${(S_(s.world).ospf[s.dev.id]?.nbrs || []).length}`, '', 'Neighbor ID      Priority  State             Nbr Address       Interface', '-'.repeat(73), ...(S_(s.world).ospf[s.dev.id]?.nbrs || []).map((n) => `${padR(n.rid, 17)}${padR(1, 10)}${padR(`${n.state}/DR`, 18)}${padR(n.ip, 18)}${n.if}`)] },
    { p: 'show ip ospf interface brief', run: (s) => ['Interface       Area            IP Address/Mask     Cost  State       Nbrs FC', ...sortedIfs(s.dev, (i) => i.ospf?.area != null).map((n) => {
      const i = s.dev.cfg.ifs[n];
      return `${padR(n, 16)}${padR(i.ospf.area, 16)}${padR(i.ip, 20)}${padR(i.ospf.cost || 1, 6)}${padR(!S_(s.world).ifs[s.dev.id][n]?.proto ? 'Down' : i.ospf.passive ? 'Passive' : 'DR', 12)}${(S_(s.world).ospf[s.dev.id]?.nbrs || []).filter((x) => x.if === n).length}`;
    })] },
    { p: 'show vrrp brief', run: (s) => ['Interface   VRRP-ID AFI   Pri    Owner  State      Master addr/Group addr', '----------- ------- ----- ------ ------ ---------- ----------------------------------', ...Object.entries(S_(s.world).fhrp[s.dev.id] || {}).map(([n, f]) => `${padR(n, 12)}${padR(f.grp, 8)}ipv4  ${padR(f.prio, 7)}No     ${padR(f.state === 'active' ? 'MASTER' : f.state === 'standby' ? 'BACKUP' : 'INIT', 11)}${f.state === 'active' ? ipOnly(s.dev.cfg.ifs[n].ip) : 'remote'}/${f.vip}`)] },
    { p: 'show lacp aggregates', run: (s) => sortedIfs(s.dev, (i) => i.kind === 'lag').flatMap((n) => {
      const L = S_(s.world).lags[s.dev.id]?.[n];
      return [`Aggregate name   : ${n}`, `Interfaces       : ${Object.keys(L?.members || {}).join(' ')}`, `Heartbeat rate   : Slow`, `Hash             : l3-src-dst`, `Aggregate mode   : ${Object.values(s.dev.cfg.ifs).find((x) => x.lag?.id === s.dev.cfg.ifs[n].lagId)?.lag.mode || 'off'}`, `Status           : ${L?.up ? 'Up' : 'Down'}`, ...Object.entries(L?.members || {}).map(([m, st]) => `  ${m}: ${st === 'P' ? 'In-Sync, Collecting, Distributing' : 'Out-of-Sync (Defaulted)'}`), ''];
    }) },
    { p: 'show spanning-tree', run: (s) => {
      if (!s.dev.cfg.stp.on) return 'Spanning-tree is disabled';
      const vs = Object.keys(s.dev.cfg.vlans).map(Number);
      const info = stpInfo(s, s.dev, vs.find((v) => v !== 1) || 1);
      return ['Spanning tree status         : Enabled Protocol: MSTP', 'MST0', `  Root ID    Priority   : ${(info.root.cfg.stp.prio[vs[1]] ?? 32768)}`, `             MAC-Address: ${macColon(macOfIf(info.root, 'base'))}`, info.isRoot ? '             This bridge is the root' : '             Hello time(in seconds):2  Max Age(in seconds):20', '', `  Bridge ID  Priority  : ${s.dev.cfg.stp.prio[vs[1]] ?? 32768}`, `             MAC-Address: ${macColon(macOfIf(s.dev, 'base'))}`, '', 'Port         Role           State      Cost    Priority   Type', '------------ -------------- ---------- ------- ---------- ----------', ...sortedIfs(s.dev, (i, n) => i.sw && !i.lag && (S_(s.world).ifs[s.dev.id][n]?.up || S_(s.world).lags[s.dev.id]?.[n]?.up)).map((n) => {
        const bl = S_(s.world).stp.blocked[s.dev.id]?.[n]?.size;
        return `${padR(n, 13)}${padR(bl ? 'Alternate' : info.rootPort === n ? 'Root' : 'Designated', 15)}${padR(bl ? 'Blocking' : 'Forwarding', 11)}${padR(20000, 8)}${padR(128, 11)}${s.dev.cfg.ifs[n].stp.edge ? 'P2P Edge' : 'P2P'}`;
      })];
    } },
    { p: 'show lldp neighbor-info', run: (s) => ['', 'LLDP Neighbor Information', '=========================', '', `Total Neighbor Entries          : ${neighbours(s.world, s.dev).length}`, '', 'LOCAL-PORT  CHASSIS-ID         PORT-ID        PORT-DESC      TTL      SYS-NAME', '-'.repeat(84), ...neighbours(s.world, s.dev).map((n) => `${padR(n.local, 12)}${padR(macColon(macOfIf(n.dev || s.dev, 'base')), 19)}${padR(n.port, 15)}${padR(n.port, 15)}${padR(120, 9)}${n.dev?.hostname || n.host?.name}`)] },
    { p: 'show mac-address-table', run: (s) => [`MAC age-time            : 300 seconds`, `Number of MAC addresses : ${macTable(s.world, s.dev).length}`, '', 'MAC Address          VLAN     Type                      Port', '--------------------------------------------------------------', ...macTable(s.world, s.dev).map((m) => `${padR(macColon(m.mac), 21)}${padR(m.vlan, 9)}${padR('dynamic', 26)}${m.port}`)] },
    { p: 'show arp', run: (s) => ['', 'IPv4 Address     MAC                Port         Physical Port                                      State', ...arpTable(s.world, s.dev).filter((x) => !x.self).map((x) => `${padR(x.ip, 17)}${padR(macColon(x.mac), 19)}${padR(x.if, 13)}${padR(x.if, 51)}reachable`)] },
    { p: 'show running-config [interface $if:if]', run: (s, a) => (a.if ? cxRunning(s).filter((l, i, arr) => arr.slice(0, i + 1).reverse().find((x) => !x.startsWith(' ')) === `interface ${a.if}`) : cxRunning(s)) },
    { p: 'show startup-config', run: (s) => (s.dev.startup ? cxRunning(s, s.dev.startup) : 'No saved configuration exists.') },
    { p: 'show checkpoint', run: (s) => ['NAME                        TYPE        WRITER      DATE(YYYY/MM/DD)      IMAGE VERSION', ...Object.entries(s.dev.run.checkpoints || {}).map(([n, c]) => `${padR(n, 28)}checkpoint  User        ${fmtDate(c.t, 'iso').replace(/-/g, '/')} ${fmtDate(c.t, 'datetime').slice(11)}:00  ${s.dev.version}`), `startup-config              startup     User        ${fmtDate(s.dev.run.savedAt ?? 0, 'iso').replace(/-/g, '/')}             ${s.dev.version}`] },
    { p: 'show {events|logging} [-r] [-n $num:n]', run: (s, a) => {
      const logs = s.dev.run.logs.map((e) => fmtEventCX(e, s.dev)).filter(Boolean);
      const list = a.line.includes('-r') ? logs.reverse() : logs;
      return ['---------------------------------------------------', 'Event logs from current boot', '---------------------------------------------------', ...(a.n ? list.slice(0, a.n) : list)];
    } },
    { p: 'show environment {fan|power-supply|temperature}', run: (s, a) => (a.has('fan') ? ['Fan information', '-'.repeat(60), 'Mbr/Fan       Product  Serial Number  Speed   Direction      Status', ...s.dev.hw.fans.map((ok, k) => `1/${k + 1}           JL669A   ${padR(`TW${hashStr(s.dev.id + k) % 9999999}`, 15)}${padR(ok ? 'normal' : 'n/a', 8)}front-to-back  ${ok ? 'ok' : 'fault'}`)] : a.has('power-supply') ? ['         Product  Serial            PSU            Input   Voltage    Wattage', 'Mbr/PSU  Number   Number            Status         Type    Range      Maximum', '-'.repeat(80), ...s.dev.hw.psus.map((ok, k) => `1/${k + 1}      JL085A   ${padR(`CN${hashStr(s.dev.id + 'p' + k) % 9999999}`, 18)}${padR(ok ? 'OK' : 'Fault ACOK', 15)}AC      100V-240V  250`)] : ['Temperature information', '-'.repeat(60), `1/1-CPU       ${Math.round(s.dev.hw.temp)}.00 C       ${s.dev.hw.temp > 60 ? 'critical' : 'normal'}`]) },
    { p: 'show clock', run: (s) => `${fmtDate(s.world.time.t, 'datetime')}:00 UTC` },
  ];
  const exec = [
    ...show,
    { p: 'configure [terminal]', run: (s) => ((s.mode = 'config'), '') },
    { p: 'write memory', run: (s) => (saveStartup(s.dev, s.world.time.t), stream([{ d: 10, t: 'Configuration changes will take time to process, please be patient.\n' }, { d: 900, t: '' }])) },
    { p: 'copy running-config startup-config', run: (s) => (saveStartup(s.dev, s.world.time.t), stream([{ d: 900, t: 'Success\n' }])) },
    { p: 'copy running-config checkpoint $word:name', run: (s, a) => {
      s.dev.run.checkpoints = s.dev.run.checkpoints || {};
      s.dev.run.checkpoints[a.name] = { t: s.world.time.t, cfg: JSON.parse(JSON.stringify(s.dev.cfg)) };
      return 'Success';
    } },
    { p: 'copy checkpoint $word:name running-config', run: (s, a) => {
      const cp = s.dev.run.checkpoints?.[a.name];
      if (!cp) return `Checkpoint ${a.name} does not exist.`;
      s.dev.cfg = JSON.parse(JSON.stringify(cp.cfg));
      changed(s);
      configEnded(s);
      return stream([{ d: 1200, t: 'Configuration changes will take time to process, please be patient.\nSuccess\n' }]);
    } },
    { p: 'ping $host:t [vrf $word:vrf] [repetitions $num(1-10000):n]', run: (s, a) => linuxPing(s, a.t, { count: a.n || 5, vrf: a.vrf && a.vrf !== 'default' ? a.vrf : null }) },
    { p: 'traceroute $host:t [vrf $word:vrf]', run: (s, a) => {
      const { hops } = trace(s, a.t, { vrf: a.vrf && a.vrf !== 'default' ? a.vrf : null });
      return stream([{ d: 10, t: `traceroute to ${a.t} (${a.t}), 1 hops min, 30 hops max, 3 sec. timeout, 3 probes\n` }, ...hops.flatMap((h, k) => (h.ok ? [{ d: 400, t: `  ${k + 1}   ${h.ip}  ${(0.3 + k).toFixed(3)}ms  ${(0.4 + k).toFixed(3)}ms  ${(0.3 + k).toFixed(3)}ms\n` }] : [1, 2, 3].map((x) => ({ d: 1500, t: `  ${k + x}   *  *  *\n` }))))]);
    } },
    { p: 'boot system', run: (s) => ask('Checking if the configuration needs to be saved...\nDo you want to save the current configuration (y/n)? ', (x) => {
      if (/^y/i.test(x)) saveStartup(s.dev, s.world.time.t);
      return ask('This will reboot the entire switch and render it unavailable\nuntil the process is complete.\nContinue (y/n)? ', (y) => {
        if (!/^y/i.test(y)) return '';
        reload(s.world, s.dev, { reason: 'Reboot requested by user' });
        if (s.via !== 'console') s.closed = true;
        return 'The system is going down for reboot.';
      }, { key: true });
    }, { key: true }) },
    { p: 'clear interface statistics', run: () => '' },
    { p: 'page', run: (s) => ((s.termLen = 24), '') },
    { p: 'no page', run: (s) => ((s.termLen = 0), '') },
    { p: '{exit|logout}', run: (s) => ((s.closed = true), '') },
  ];
  const common = [
    { p: 'end', run: (s) => ((s.mode = 'exec'), (s.ctx = {}), configEnded(s), '') },
    { p: 'exit', run: (s) => {
      if (s.mode === 'config') {
        s.mode = 'exec';
        configEnded(s);
      } else s.mode = s.mode === 'vrrp' ? 'ifvlan' : 'config';
      if (s.mode === 'config') s.ctx = {};
      return '';
    } },
  ];
  const tries = {
    exec: compile(exec, KW),
    config: compile([...g, ...show, ...common], KW),
    if: compile([...ifc, ...common], KW),
    ifvlan: compile([...ifc.filter((c) => /^(no )?(shutdown|description|ip |vrrp)/.test(c.p)), ...common], KW),
    iflag: compile([...ifc.filter((c) => /^(no )?(shutdown|description|routing|vlan|lacp|ip address|spanning)/.test(c.p)), ...common], KW),
    iflo: compile([...ifc.filter((c) => /^(no )?(description|ip address|ip ospf)/.test(c.p)), ...common], KW),
    vlan: compile([{ p: 'name $word:n', run: (s, a) => { for (const v of s.ctx.vlans) cfgOf(s).vlans[v] = a.n; changed(s); } }, ...common], KW),
    ospf: compile([...ospf, ...common], KW),
    vrrp: compile([...vrrp, ...common], KW),
  };
  const P = { config: 'config', if: 'config-if', ifvlan: 'config-if-vlan', iflag: 'config-lag-if', iflo: 'config-loopback-if', vlan: 'config-vlan', ospf: 'config-ospf', vrrp: 'config-if-vrrp' };
  return {
    id: 'aoscx',
    startMode: 'exec',
    pipes: ['include', 'exclude', 'begin', 'count'],
    defaultLen: 24,
    more: '-- MORE --, next page: Space, next line: Enter, quit: Control-C',
    consoleLogin: true,
    prompt: (s) => (s.dev.state !== 'up' ? '' : s.mode === 'exec' ? `${s.dev.cfg.hostname}# ` : `${s.dev.cfg.hostname}(${s.mode === 'vlan' ? `config-vlan-${s.ctx.vlans?.[0]}` : P[s.mode]})# `),
    greeting: (s) => `\nLast login: ${fmtDate(s.world.time.t - 1440, 'long')} from 10.250.0.10\nUser "${s.user}" has logged in 3 times in the past 30 days\n`,
    loginPrompt: (dev) => `\n${dev.cfg.hostname} login: `,
    consoleBanner: () => '',
    telnetBanner: () => '',
    closeMsg: (s) => (s.via === 'console' ? '\n[Disconnected from console server]\n' : `Connection to ${s.world.design.mgmt[s.dev.id]} closed.\n`),
    preprocess: (s) => (s.dev.state !== 'up' ? '' : undefined),
    trie: (s, m) => tries[m] || tries.exec,
    fallback: (s) => (s.mode !== 'exec' && s.mode !== 'config' ? ['config'] : []),
    matchIf(s, toks, i) {
      const v = toks[i].v;
      if (s.dev.cfg.ifs[v]) return { val: v, n: 1 };
      if (/^\d+\/\d+\/\d+$/.test(v)) return null;
      return null;
    },
    ifNames: (s) => Object.keys(s.dev.cfg.ifs).filter((n) => /^\d/.test(n)),
    helpFmt(s, items, cr) {
      const w = Math.max(...items.map(([k]) => k.length), 4) + 2;
      return [...items.map(([k, h]) => `  ${padR(k, w)}${h}`), ...(cr ? ['  <cr>'] : [])].join('\n');
    },
    error(s, kind, x) {
      if (kind === 'incomplete') return 'Command incomplete.';
      if (kind === 'ambiguous') return 'Ambiguous command.';
      return `Invalid input: ${x.toks?.[x.at]?.v ?? ''}`;
    },
    ctrlC: (s) => ((s.mode !== 'exec' ? ((s.mode = 'exec'), configEnded(s)) : 0), '\n'),
    ctrlZ: (s) => ((s.mode = 'exec'), configEnded(s), ''),
    fmtEvent: fmtEventCX,
  };
}

// =============================================================================================
// AOS-Switch (ProCurve)
const portList = (dev, spec) => {
  // "1-4,A1,Trk1" -> canonical names
  const out = [];
  for (const part of String(spec).split(',')) {
    const m = part.match(/^([A-Z]*)(\d+)-([A-Z]*)(\d+)$/i);
    if (m) {
      for (let k = Number(m[2]); k <= Number(m[4]); k++) {
        const n = `${m[1]}${k}`;
        if (dev.cfg.ifs[n]) out.push(n);
        else return null;
      }
    } else {
      const n = Object.keys(dev.cfg.ifs).find((x) => x.toLowerCase() === part.toLowerCase());
      if (!n) return null;
      out.push(n);
    }
  }
  return out;
};
const compress = (ports) => {
  const sorted = [...ports].sort(natCmp);
  const out = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    const pre = (x) => x.replace(/\d+$/, '');
    const num = (x) => Number(x.match(/\d+$/)?.[0]);
    while (j + 1 < sorted.length && pre(sorted[j + 1]) === pre(sorted[i]) && num(sorted[j + 1]) === num(sorted[j]) + 1) j++;
    out.push(j > i ? `${sorted[i]}-${sorted[j]}` : sorted[i]);
    i = j + 1;
  }
  return out.join(',');
};
function aossMembers(dev, cfg, v) {
  const unt = [];
  const tag = [];
  for (const [n, i] of Object.entries(cfg.ifs)) {
    if (!i.sw || i.lag || i.kind === 'svi') continue;
    if (i.sw.mode === 'access' ? i.sw.vlan === v : i.sw.native === v) unt.push(n);
    else if (i.sw.mode === 'trunk' && (i.sw.allowed === 'all' || i.sw.allowed.includes(v))) tag.push(n);
  }
  return { unt, tag };
}
function aossRunning(s, cfg = s.dev.cfg) {
  const dev = s.dev;
  const L = ['', 'Running configuration:', '', `; ${dev.model.toUpperCase()} Configuration Editor; Created on release #${dev.version}`, `; Ver #14:${(hashStr(dev.version) % 0xff).toString(16)}.f7.0c.7d.a8.c2.7f.ec.de.29.f2.cc.84.e6.fd.47.ac.bf.0f.ff.38:3c`, `hostname "${cfg.hostname}"`];
  const trks = Object.values(cfg.ifs).filter((i) => i.kind === 'lag');
  for (const t of trks) {
    const mem = Object.entries(cfg.ifs).filter(([, i]) => i.lag?.id === t.lagId).map(([n]) => n);
    if (mem.length) L.push(`trunk ${compress(mem)} trk${t.lagId} ${cfg.ifs[mem[0]].lag.mode === 'on' ? 'trunk' : 'lacp'}`);
  }
  for (const n of cfg.svc.ntp) L.push('timesync ntp', `ntp server ${n}`, 'ntp enable');
  for (const h of cfg.svc.syslog) L.push(`logging ${h}`);
  if (cfg.svc.snmp) L.push(`snmp-server community "${cfg.svc.snmp}" unrestricted`);
  for (const [n, i] of Object.entries(cfg.ifs).filter(([, x]) => x.kind === 'phys' && (x.desc || !x.on || x.speed !== 'auto')).sort((a, b) => natCmp(a[0], b[0]))) {
    L.push(`interface ${n}`);
    if (!i.on) L.push('   disable');
    if (i.desc) L.push(`   name "${i.desc}"`);
    if (i.speed !== 'auto') L.push(`   speed-duplex ${i.speed}-${i.duplex === 'half' ? 'half' : 'full'}`);
    L.push('   exit');
  }
  if (cfg.static.length) {
    L.push('ip routing');
    for (const r of cfg.static) L.push(`ip route ${n2ip(cidr(r.pfx).net)} ${maskStr(cidr(r.pfx).len)} ${r.nh}`);
  }
  if (cfg.defaultGw) L.push(`ip default-gateway ${cfg.defaultGw}`);
  const vl = Object.keys(cfg.vlans).map(Number).sort((a, b) => a - b);
  for (const v of vl) {
    const { unt, tag } = aossMembers(dev, cfg, v);
    L.push(`vlan ${v}`, `   name "${v === 1 ? 'DEFAULT_VLAN' : cfg.vlans[v]}"`);
    if (unt.length) L.push(`   untagged ${compress(unt)}`);
    if (tag.length) L.push(`   tagged ${compress(tag)}`);
    const svi = cfg.ifs[`VLAN${v}`];
    if (svi?.ip) L.push(`   ip address ${ipOnly(svi.ip)} ${maskStr(lenOf(svi.ip))}`);
    else L.push('   no ip address');
    if (v === 1 && unt.length) {
      const all = Object.keys(cfg.ifs).filter((n) => cfg.ifs[n].kind === 'phys');
      const notIn = all.filter((n) => !unt.includes(n) && !cfg.ifs[n].lag);
      if (notIn.length) L.push(`   no untagged ${compress(notIn)}`);
    }
    L.push('   exit');
  }
  if (cfg.stp.on) {
    L.push('spanning-tree');
    for (const [n, i] of Object.entries(cfg.ifs)) {
      if (i.stp?.edge) L.push(`spanning-tree ${n} admin-edge-port`);
      if (i.stp?.bpduguard) L.push(`spanning-tree ${n} bpdu-protection`);
    }
    const p = Math.min(...Object.values(cfg.stp.prio), 32768);
    if (p !== 32768) L.push(`spanning-tree priority ${p / 4096}`);
  }
  for (const u of cfg.svc.users) L.push(`password manager user-name "${u.name}" sha1 "${hashStr(u.pw).toString(16)}${hashStr(u.pw + 'q').toString(16)}"`);
  return L;
}
export function fmtEventAOSS(e, dev) {
  const d = fmtDate(e.t, 'datetime');
  const ts = `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(2, 4)} ${d.slice(11)}:00 ${String(70 + (hashStr(String(e.t) + e.type) % 900)).padStart(5, '0')}`;
  switch (e.type) {
    case 'link':
      return e.kind === 'phys' ? `I ${ts} ports: port ${e.if} is now ${e.up ? 'on-line' : 'off-line'}` : null;
    case 'errdis':
      return `W ${ts} ports: port ${e.if} is Disabled by STP BPDU protection.\nI ${ts} STP: port ${e.if} - BPDU received on BPDU protected port; port disabled`;
    case 'lacp':
      return `I ${ts} LACP: port ${e.if} ${e.state === 'P' ? 'added to' : 'removed from'} ${e.lag}`;
    case 'config':
      return `I ${ts} mgr: SME SSH from ${e.from || '10.250.0.10'} - MANAGER Mode`;
    case 'login':
      return `I ${ts} mgr: SME SSH from ${e.from} - MANAGER Mode`;
    case 'authfail':
      return `W ${ts} auth: Invalid user name/password on SSH session from ${e.from}`;
    case 'psu':
      return `W ${ts} chassis: Power Supply ${e.n} ${e.ok ? 'OK' : 'Failed'}`;
    case 'fan':
      return `W ${ts} chassis: Fan ${e.n} ${e.ok ? 'OK' : 'failure'}`;
    case 'boot':
      return `I ${ts} system: System went down: ${dev.run.reloadReason || 'Power failure'}\nI ${ts} system: System Booted`;
    case 'duplex':
      return `W ${ts} FFI: port ${e.if} - Excessive late collisions. See help.`;
    case 'macflap':
      return `W ${ts} FFI: port ${e.if1} - Excessive broadcasts. See help.\nI ${ts} STP: VLAN ${e.vlan} - loop detected`;
    case 'native':
      return null;
    default:
      return null;
  }
}
export function makeAOSS() {
  const KW = { show: 'Show switch operation information.', configure: 'Enter the Configuration context.', ping: 'Send IPv4 ping request(s) to a device on the network.', traceroute: 'Send traceroute to a device on the network.', write: 'View or save the running configuration of the switch.', interface: 'Enter the Interface Configuration Level, or execute one command for that level.', vlan: 'Add, delete, edit VLAN configuration or enter a VLAN context.', untagged: 'Assign ports to specified VLAN as untagged.', tagged: 'Assign ports to specified VLAN as tagged.', disable: 'Disable port(s).', enable: 'Enable port(s).', name: 'Set/unset a name for the port(s).', trunk: 'Configure port trunk groups.', 'spanning-tree': 'Enable/Configure the spanning tree protocol.' };
  const vsel = (s) => s.ctx.vlan;
  const setPortsVlan = (s, list, how, remove) => {
    const dev = s.dev;
    const c = cfgOf(s);
    const ports = portList(dev, list);
    if (!ports) return `Module not present for port or invalid port: ${list}`;
    const v = vsel(s);
    for (const n of ports) {
      const i = c.ifs[n];
      i.sw = i.sw || { mode: 'access', vlan: 1, native: 1, allowed: 'all' };
      if (how === 'untagged') {
        if (remove) {
          if (i.sw.mode === 'access') i.sw.vlan = v === 1 ? 1 : 1;
          else i.sw.native = v === i.sw.native ? null : i.sw.native;
        } else if (i.sw.mode === 'access') i.sw.vlan = v;
        else i.sw.native = v;
      } else {
        const cur = i.sw.mode === 'trunk' ? (i.sw.allowed === 'all' ? [] : i.sw.allowed) : [];
        if (remove) {
          const next = cur.filter((x) => x !== v);
          if (!next.length) Object.assign(i.sw, { mode: 'access', vlan: i.sw.native ?? 1, allowed: 'all' });
          else i.sw.allowed = next;
        } else {
          if (i.sw.mode === 'access') Object.assign(i.sw, { mode: 'trunk', native: i.sw.vlan, allowed: [] });
          i.sw.allowed = [...new Set([...(i.sw.allowed === 'all' ? [] : i.sw.allowed), v])].sort((x, y) => x - y);
        }
      }
    }
    changed(s);
    return '';
  };
  const vlanCmds = [
    { p: 'name $word:n', run: (s, a) => ((cfgOf(s).vlans[vsel(s)] = a.n.replace(/"/g, '')), changed(s)) },
    { p: '[no] untagged $word:ports', run: (s, a) => setPortsVlan(s, a.ports, 'untagged', a.has('no')) },
    { p: '[no] tagged $word:ports', run: (s, a) => setPortsVlan(s, a.ports, 'tagged', a.has('no')) },
    { p: 'ip address $ip:ip $mask:m', run: (s, a) => {
      const n = `VLAN${vsel(s)}`;
      if (!cfgOf(s).ifs[n]) ensureSvi(s.dev, vsel(s));
      cfgOf(s).ifs[n].ip = `${a.ip}/${maskLen(a.m)}`;
      changed(s);
    } },
    { p: 'ip address $pfx:p', run: (s, a) => {
      const n = `VLAN${vsel(s)}`;
      if (!cfgOf(s).ifs[n]) ensureSvi(s.dev, vsel(s));
      cfgOf(s).ifs[n].ip = a.p;
      changed(s);
    } },
    { p: 'no ip address', run: (s) => (cfgOf(s).ifs[`VLAN${vsel(s)}`] && (cfgOf(s).ifs[`VLAN${vsel(s)}`].ip = null), changed(s)) },
    { p: 'ip helper-address $ip:ip', run: (s, a) => (cfgOf(s).ifs[`VLAN${vsel(s)}`] ? ((cfgOf(s).ifs[`VLAN${vsel(s)}`].helper = [a.ip]), changed(s)) : 'Invalid input: ip') },
  ];
  const ifCmds = [
    { p: 'disable', run: (s) => {
      for (const n of s.ctx.ports) cfgOf(s).ifs[n].on = false;
      changed(s);
    } },
    { p: 'enable', run: (s) => {
      for (const n of s.ctx.ports) {
        cfgOf(s).ifs[n].on = true;
        delete s.dev.run.errdis[n];
      }
      changed(s);
    } },
    { p: 'name $line:n', run: (s, a) => {
      for (const n of s.ctx.ports) cfgOf(s).ifs[n].desc = a.n.replace(/"/g, '');
      changed(s);
    } },
    { p: 'no name', run: (s) => {
      for (const n of s.ctx.ports) cfgOf(s).ifs[n].desc = '';
      changed(s);
    } },
    { p: 'speed-duplex {auto|10-half|10-full|100-half|100-full|1000-full}', run: (s, a) => {
      const v = a.kw[1];
      for (const n of s.ctx.ports) Object.assign(cfgOf(s).ifs[n], { speed: v === 'auto' ? 'auto' : Number(v.split('-')[0]), duplex: v === 'auto' ? 'auto' : v.split('-')[1] });
      changed(s);
    } },
  ];
  const g = [
    { p: 'hostname $word:h', run: (s, a) => ((cfgOf(s).hostname = a.h.replace(/"/g, '')), (s.dev.hostname = cfgOf(s).hostname), changed(s)) },
    { p: 'vlan $num(1-4094):v', run: (s, a) => {
      ensureVlan(s.dev, a.v);
      changed(s);
      s.ctx = { vlan: a.v };
      s.mode = 'vlan';
    } },
    { p: 'vlan $num(1-4094):v {untagged|tagged} $word:ports', run: (s, a) => {
      ensureVlan(s.dev, a.v);
      s.ctx = { vlan: a.v };
      return setPortsVlan(s, a.ports, a.has('untagged') ? 'untagged' : 'tagged', false);
    } },
    { p: 'no vlan $num(2-4094):v', run: (s, a) => {
      delete cfgOf(s).vlans[a.v];
      for (const i of Object.values(cfgOf(s).ifs)) if (i.sw?.mode === 'access' && i.sw.vlan === a.v) i.sw.vlan = 1;
      changed(s);
    } },
    { p: 'interface $word:ports', run: (s, a) => {
      const ports = portList(s.dev, a.ports);
      if (!ports) return `Module not present for port or invalid port: ${a.ports}`;
      s.ctx = { ports };
      s.mode = 'if';
    } },
    { p: 'interface $word:ports {disable|enable}', run: (s, a) => {
      const ports = portList(s.dev, a.ports);
      if (!ports) return `Module not present for port or invalid port: ${a.ports}`;
      for (const n of ports) {
        cfgOf(s).ifs[n].on = a.has('enable');
        if (a.has('enable')) delete s.dev.run.errdis[n];
      }
      changed(s);
    } },
    { p: 'trunk $word:ports $word:trk {trunk|lacp}', run: (s, a) => {
      const ports = portList(s.dev, a.ports);
      if (!ports) return `Module not present for port or invalid port: ${a.ports}`;
      const id = Number(a.trk.replace(/\D/g, ''));
      const c = cfgOf(s);
      if (!c.ifs[`Trk${id}`]) {
        ensureLag(s.dev, id);
        c.ifs[`Trk${id}`].sw = c.ifs[ports[0]].sw ? JSON.parse(JSON.stringify(c.ifs[ports[0]].sw)) : { mode: 'access', vlan: 1, native: 1, allowed: 'all' };
      }
      for (const n of ports) c.ifs[n].lag = { id, mode: a.has('lacp') ? 'active' : 'on' };
      changed(s);
    } },
    { p: 'no trunk $word:ports', run: (s, a) => {
      for (const n of portList(s.dev, a.ports) || []) cfgOf(s).ifs[n].lag = null;
      changed(s);
    } },
    { p: '[no] spanning-tree', run: (s, a) => ((cfgOf(s).stp.on = !a.has('no')), changed(s)) },
    { p: 'spanning-tree priority $num(0-15):p', run: (s, a) => {
      for (const v of Object.keys(cfgOf(s).vlans)) cfgOf(s).stp.prio[v] = a.p * 4096;
      changed(s);
    } },
    { p: '[no] spanning-tree $word:ports {admin-edge-port|bpdu-protection}', run: (s, a) => {
      const ports = portList(s.dev, a.ports);
      if (!ports) return `Module not present for port or invalid port: ${a.ports}`;
      for (const n of ports) cfgOf(s).ifs[n].stp[a.has('admin-edge-port') ? 'edge' : 'bpduguard'] = !a.has('no');
      changed(s);
    } },
    { p: 'ip route $ip:net $mask:m $ip:nh', run: (s, a) => (cfgOf(s).static.push({ pfx: `${a.net}/${maskLen(a.m)}`, nh: a.nh, ad: 1 }), changed(s)) },
    { p: 'no ip route $ip:net $mask:m $ip:nh', run: (s, a) => ((cfgOf(s).static = cfgOf(s).static.filter((r) => !(r.pfx === `${a.net}/${maskLen(a.m)}` && r.nh === a.nh))), changed(s)) },
    { p: 'ip default-gateway $ip:gw', run: (s, a) => ((cfgOf(s).defaultGw = a.gw), changed(s)) },
    { p: '[no] ip routing', run: (s, a) => ((cfgOf(s).noRouting = a.has('no')), changed(s)) },
    { p: 'logging $ip:ip', run: (s, a) => ((cfgOf(s).svc.syslog = [...new Set([...cfgOf(s).svc.syslog, a.ip])]), changed(s)) },
    { p: 'password manager [user-name $word:u] [plaintext $word:pw]', run: (s, a) => (a.pw ? ((cfgOf(s).svc.users[0].pw = a.pw), changed(s)) : ask('New password for manager: ', (p1) => ask('Please retype new password for manager: ', (p2) => (p1 === p2 ? ((cfgOf(s).svc.users[0].pw = p1), changed(s), '') : 'Password mismatch.'), { hidden: true }), { hidden: true })) },
  ];
  const show = [
    { p: 'show interfaces brief', run: (s) => {
      const dev = s.dev;
      const out = ['', ' Status and Counters - Port Status', '', '                          | Intrusion                           MDI   Flow  Bcast', '  Port         Type       | Alert     Enabled Status Mode       Mode  Ctrl  Limit', '  ------------ ---------- + --------- ------- ------ ---------- ----- ----- ------'];
      for (const n of physIfs(dev).filter((x) => dev.cfg.ifs[x].kind === 'phys')) {
        const i = dev.cfg.ifs[n];
        const st = S_(s.world).ifs[dev.id][n];
        const ds = duplexSpeed(s, dev, n);
        const mode = ds.up ? `${ds.sp}${ds.dup === 'half' ? 'HDx' : 'FDx'}` : i.speed === 'auto' ? `${i.hw?.speed || 1000}FDx` : `${i.speed}${i.duplex === 'half' ? 'HDx' : 'FDx'}`;
        out.push(`  ${padR(`${n}${i.lag ? `-Trk${i.lag.id}` : ''}`, 13)}${padR((i.hw?.speed || 1000) >= 10000 ? 'SFP+SR' : (i.hw?.speed || 1000) >= 1000 ? '100/1000T' : '10/100TX', 11)}| No        ${padR(i.on ? 'Yes' : 'No', 8)}${padR(st?.up && !s.dev.run.errdis[n] ? 'Up' : 'Down', 7)}${padR(mode, 11)}${padR(st?.up ? 'MDIX' : 'Auto', 6)}off   0`);
      }
      return out;
    } },
    { p: 'show interfaces $word:p', run: (s, a) => {
      const n = portList(s.dev, a.p)?.[0];
      if (!n) return `Module not present for port or invalid port: ${a.p}`;
      const c = counters(s.world, s.dev, n);
      const i = s.dev.cfg.ifs[n];
      const st = S_(s.world).ifs[s.dev.id][n];
      return ['', ` Status and Counters - Port Counters for port ${n}`, '', `  Name  : ${i.desc}`, `  MAC Address      : ${macDash(macOfIf(s.dev, n))}`, `  Link Status      : ${st?.up ? 'Up' : 'Down'}`, `  Port Enabled     : ${i.on ? 'Yes' : 'No'}`, '  Totals (Since boot or last clear) :', `   Bytes Rx        : ${padL(c.inB, 20)}  Bytes Tx        : ${padL(c.outB, 20)}`, `   Unicast Rx      : ${padL(c.inP, 20)}  Unicast Tx      : ${padL(c.outP, 20)}`, `   Bcast/Mcast Rx  : ${padL(c.bcast + c.inMc, 20)}  Bcast/Mcast Tx  : ${padL(c.outMc, 20)}`, '  Errors (Since boot or last clear) :', `   FCS Rx          : ${padL(c.crc, 20)}  Drops Tx        : ${padL(0, 20)}`, `   Alignment Rx    : ${padL(Math.floor(c.crc / 7), 20)}  Collisions Tx   : ${padL(c.coll, 20)}`, `   Runts Rx        : ${padL(c.runts, 20)}  Late Colln Tx   : ${padL(c.late, 20)}`, `   Giants Rx       : ${padL(0, 20)}  Excessive Colln : ${padL(0, 20)}`, '  Rates (5 minute weighted average) :', `   Total Rx  (bps) : ${padL(c.rateIn, 20)}  Total Tx  (bps) : ${padL(c.rateOut, 20)}`];
    } },
    { p: 'show vlans', run: (s) => ['', ' Status and Counters - VLAN Information', '', '  Maximum VLANs to support : 256', '  Primary VLAN : DEFAULT_VLAN', '  Management VLAN :', '', '  VLAN ID Name                             | Status     Voice Jumbo', '  ------- -------------------------------- + ---------- ----- -----', ...Object.keys(s.dev.cfg.vlans).map(Number).sort((a, b) => a - b).map((v) => `  ${padR(v, 8)}${padR(v === 1 ? 'DEFAULT_VLAN' : s.dev.cfg.vlans[v], 33)}| Port-based No    No`)] },
    { p: 'show vlans $num(1-4094):v', run: (s, a) => {
      if (!(a.v in s.dev.cfg.vlans)) return `VLAN ${a.v} is not configured.`;
      const { unt, tag } = aossMembers(s.dev, s.dev.cfg, a.v);
      const row2 = (n, m) => `  ${padR(n, 17)}${padR(m, 9)}Learn        ${S_(s.world).ifs[s.dev.id][n]?.up && !s.dev.run.errdis[n] ? 'Up' : 'Down'}`;
      return ['', ` Status and Counters - VLAN Information - VLAN ${a.v}`, '', `  VLAN ID : ${a.v}`, `  Name : ${a.v === 1 ? 'DEFAULT_VLAN' : s.dev.cfg.vlans[a.v]}`, '  Status : Port-based', '  Voice : No', '  Jumbo : No', '', '  Port Information Mode     Unknown VLAN Status', '  ---------------- -------- ------------ ----------', ...unt.sort(natCmp).map((n) => row2(n, 'Untagged')), ...tag.sort(natCmp).map((n) => row2(n, 'Tagged'))];
    } },
    { p: 'show vlans ports $word:p detail', run: (s, a) => {
      const n = portList(s.dev, a.p)?.[0];
      if (!n) return `Module not present for port or invalid port: ${a.p}`;
      const i = s.dev.cfg.ifs[n];
      const list = Object.keys(s.dev.cfg.vlans).map(Number).filter((v) => (i.sw?.mode === 'access' ? i.sw.vlan === v : i.sw && (i.sw.native === v || i.sw.allowed === 'all' || i.sw.allowed.includes(v))));
      return ['', ` Status and Counters - VLAN Information - for ports ${n}`, '', '  VLAN ID Name                 | Status     Voice Jumbo Mode', '  ------- -------------------- + ---------- ----- ----- --------', ...list.map((v) => `  ${padR(v, 8)}${padR(v === 1 ? 'DEFAULT_VLAN' : s.dev.cfg.vlans[v], 21)}| Port-based No    No    ${(i.sw.mode === 'access' ? i.sw.vlan : i.sw.native) === v ? 'Untagged' : 'Tagged'}`)];
    } },
    { p: 'show trunks', run: (s) => ['', ' Load Balancing Method:  L3-based (default)', '', '  Port   | Name                             Type      | Group  Type', '  ------ + -------------------------------- --------- + ------ --------', ...Object.entries(s.dev.cfg.ifs).filter(([, i]) => i.lag).sort((a, b) => natCmp(a[0], b[0])).map(([n, i]) => `  ${padR(n, 7)}| ${padR(i.desc, 33)}${padR('100/1000T', 10)}| Trk${padR(i.lag.id, 4)}${i.lag.mode === 'on' ? 'Trunk' : 'LACP'}`)] },
    { p: 'show lacp', run: (s) => ['', '                           LACP', '', '   PORT   LACP      TRUNK     PORT      LACP      LACP', '   NUMB   ENABLED   GROUP     STATUS    PARTNER   STATUS', '   ----   -------   -------   -------   -------   -------', ...Object.entries(s.dev.cfg.ifs).filter(([, i]) => i.lag && i.lag.mode !== 'on').map(([n, i]) => {
      const st = S_(s.world).lags[s.dev.id]?.[`Trk${i.lag.id}`]?.members[n];
      return `   ${padR(n, 7)}Active    Trk${padR(i.lag.id, 7)}${padR(S_(s.world).ifs[s.dev.id][n]?.up ? 'Up' : 'Down', 10)}${padR(st === 'P' ? 'Yes' : 'No', 10)}${st === 'P' ? 'Success' : 'Failure'}`;
    })] },
    { p: 'show spanning-tree', run: (s) => (s.dev.cfg.stp.on ? ['', ' Multiple Spanning Tree (MST) Information', '', '  STP Enabled   : Yes', '  Force Version : MSTP-operation', '', `  Switch Priority    : ${Math.min(...Object.values(s.dev.cfg.stp.prio), 32768)}`, '', '  Port  Type      | Cost      Priority Role       State      Designated Bridge', '  ----- --------- + --------- -------- ---------- ---------- ------------------', ...physIfs(s.dev).filter((n) => s.dev.cfg.ifs[n].sw && S_(s.world).ifs[s.dev.id][n]?.up).map((n) => `  ${padR(n, 6)}100/1000T | 20000     128      ${padR(S_(s.world).stp.blocked[s.dev.id]?.[n] ? 'Alternate' : 'Designated', 11)}${padR(s.dev.run.errdis[n] ? 'Disabled' : S_(s.world).stp.blocked[s.dev.id]?.[n] ? 'Blocking' : 'Forwarding', 11)}${macDash(macOfIf(s.dev, 'base'))}`)] : ['', ' Multiple Spanning Tree (MST) Information', '', '  STP Enabled   : No']) },
    { p: 'show ip', run: (s) => ['', ' Internet (IP) Service', '', `  IP Routing : ${s.dev.cfg.noRouting || !isL3(s.dev) ? 'Disabled' : 'Enabled'}`, '', `  Default Gateway : ${s.dev.cfg.defaultGw || ''}`, '  Default TTL     : 64', '  Arp Age         : 20', '', '  VLAN                 | IP Config  IP Address      Subnet Mask', '  -------------------- + ---------- --------------- ---------------', ...Object.keys(s.dev.cfg.vlans).map(Number).map((v) => {
      const i = s.dev.cfg.ifs[`VLAN${v}`];
      return `  ${padR(v === 1 ? 'DEFAULT_VLAN' : s.dev.cfg.vlans[v], 21)}| ${padR(i?.ip ? 'Manual' : 'Disabled', 11)}${padR(ipOnly(i?.ip) || '', 16)}${i?.ip ? maskStr(lenOf(i.ip)) : ''}`;
    })] },
    { p: 'show ip route', run: (s) => ['', '                                IP Route Entries', '', '  Destination        Gateway         VLAN Type      Sub-Type   Metric     Dist.', '  ------------------ --------------- ---- --------- ---------- ---------- -----', ...(S_(s.world).rib[s.dev.id]?.best || []).filter((r) => r.proto !== 'local').map((r) => `  ${padR(r.pfx, 19)}${padR(r.nh || (r.oif ? r.oif.replace('VLAN', 'DEFAULT_VLAN'.slice(0, 0) + 'VLAN') : ''), 16)}${padR(String(r.oif).replace('VLAN', ''), 5)}${padR(r.proto === 'connected' ? 'connected' : r.proto, 10)}${padR('', 11)}${padR(r.metric, 11)}${r.ad}`)] },
    { p: 'show running-config', run: (s) => aossRunning(s) },
    { p: 'show config', run: (s) => (s.dev.startup ? aossRunning(s, s.dev.startup).map((l) => l.replace('Running configuration', 'Startup configuration')) : '') },
    { p: 'show log [-r] [$word:filter]', run: (s, a) => {
      const logs = s.dev.run.logs.map((e) => fmtEventAOSS(e, s.dev)).filter(Boolean);
      const list = a.line.includes('-r') ? logs.reverse() : logs;
      return [' Keys:   W=Warning   I=Information', '         M=Major     D=Debug E=Error', `----  ${a.line.includes('-r') ? 'Reverse event' : 'Event'} Log listing: Events Since Boot  ----`, ...(a.filter && a.filter !== '-r' ? list.filter((l) => l.includes(a.filter)) : list)];
    } },
    { p: 'show system [information]', run: (s) => ['', ' Status and Counters - General System Information', '', `  System Name        : ${s.dev.cfg.hostname}`, '  System Contact     :', '  System Location    :', '', `  MAC Age Time (sec) : 300`, '', `  Time Zone          : 0`, '  Daylight Time Rule : None', '', `  Software revision  : ${s.dev.version}        Base MAC Addr      : ${macDash(macOfIf(s.dev, 'base'))}`, `  ROM Version        : ${String(s.dev.version).split('.')[0]}.15.09         Serial Number      : ${s.dev.hw.serial}`, '', `  Up Time            : ${Math.floor(uptimeMins(s.world, s.dev) / 1440)} days         Memory   - Total   : 339,738,624`, `  CPU Util (%)       : ${S_(s.world).stormSegs?.size ? 98 : 2}               Free    : 187,012,480`] },
    { p: 'show version', run: (s) => ['Image stamp:    /ws/swbuildm/rel_' + String(s.dev.version).toLowerCase().replace(/\./g, '_'), `                ${fmtDate(Math.max(0, s.dev.installed - 90000), 'long')}`, `                ${s.dev.version}`, '                ' + hashStr(s.dev.version).toString(16), 'Boot Image:     Primary'] },
    { p: 'show lldp info remote-device', run: (s) => ['', ' LLDP Remote Devices Information', '', '  LocalPort | ChassisId                 PortId PortDescr SysName', '  --------- + ------------------------- ------ --------- ----------------------', ...neighbours(s.world, s.dev).map((n) => `  ${padR(n.local, 10)}| ${padR(macDash(macOfIf(n.dev || s.dev, 'base')), 26)}${padR(n.port, 7)}${padR(n.port, 10)}${n.dev?.hostname || n.host?.name}`)] },
    { p: 'show mac-address', run: (s) => ['', ' Status and Counters - Port Address Table', '', '  MAC Address   Port   VLAN', '  ------------- ------ ----', ...macTable(s.world, s.dev).map((m) => `  ${padR(macDash(m.mac), 14)}${padR(m.port, 7)}${m.vlan}`)] },
    { p: 'show arp', run: (s) => ['', ' IP ARP table', '', '  IP Address       MAC Address       Type    Port', '  ---------------  ----------------- ------- ----', ...arpTable(s.world, s.dev).filter((x) => !x.self).map((x) => `  ${padR(x.ip, 17)}${padR(macDash(x.mac), 18)}dynamic ${x.if}`)] },
    { p: 'show interfaces transceiver [detail]', run: (s) => physIfs(s.dev).filter((n) => optics(s.dev, n)).map((n) => `${padR(n, 6)}${optics(s.dev, n).type}  Rx: ${optics(s.dev, n).rx.toFixed(2)} dBm  Tx: ${optics(s.dev, n).tx.toFixed(2)} dBm${optics(s.dev, n).rx < -14 ? '  ALARM: Rx power low' : ''}`) },
  ];
  const exec = [
    ...show,
    { p: 'configure [terminal]', run: (s) => ((s.mode = 'config'), '') },
    { p: 'write memory', run: (s) => (saveStartup(s.dev, s.world.time.t), '') },
    { p: 'ping $host:t [repetitions $num(1-10000):n]', run: (s, a) => {
      const p = ping(s, a.t, { count: a.n || 1 });
      return stream([{ d: p.recv ? 300 : 3000, t: p.recv ? `${a.t} is alive, time = ${p.avg} ms\n` : `Request timed out.\n` }]);
    } },
    { p: 'traceroute $host:t', run: (s, a) => {
      const { hops } = trace(s, a.t);
      return stream([{ d: 10, t: `traceroute to ${a.t} \n      1 hop min, 30 hops max, 5 sec. timeout, 3 probes\n` }, ...hops.flatMap((h, k) => (h.ok ? [{ d: 400, t: `  ${k + 1}   ${h.ip}   ${k + 1} ms   ${k + 1} ms   ${k + 1} ms\n` }] : [1, 2, 3].map((x) => ({ d: 1500, t: `  ${k + x}   *   *   *\n` }))))]);
    } },
    { p: 'boot', run: (s) => ask('This will reboot the system.  Continue (y/n)? ', (x) => {
      if (!/^y/i.test(x)) return '';
      reload(s.world, s.dev, { reason: 'Reboot from Primary Image' });
      if (s.via !== 'console') s.closed = true;
      return '';
    }, { key: true }) },
    { p: 'reload', run: (s) => ask('Device will be rebooted, do you want to continue [y/n]? ', (x) => {
      if (!/^y/i.test(x)) return '';
      reload(s.world, s.dev, { reason: 'Reboot from Primary Image' });
      if (s.via !== 'console') s.closed = true;
      return '';
    }, { key: true }) },
    { p: 'no page', run: (s) => ((s.termLen = 0), '') },
    { p: 'page', run: (s) => ((s.termLen = 24), '') },
    { p: 'clear statistics $word:p', run: () => '' },
    { p: '{exit|logout}', run: (s) => ask('Do you want to log out [y/n]? ', (x) => (/^y/i.test(x) ? ((s.closed = true), '') : ''), { key: true }) },
  ];
  const common = [
    { p: 'end', run: (s) => ((s.mode = 'exec'), (s.ctx = {}), configEnded(s), '') },
    { p: 'exit', run: (s) => {
      if (s.mode === 'config') {
        s.mode = 'exec';
        configEnded(s);
      } else s.mode = 'config';
      s.ctx = {};
      return '';
    } },
  ];
  const tries = { exec: compile(exec, KW), config: compile([...g, ...show, { p: 'write memory', run: (s) => (saveStartup(s.dev, s.world.time.t), '') }, ...common], KW), vlan: compile([...vlanCmds, ...common], KW), if: compile([...ifCmds, ...common], KW) };
  return {
    id: 'aoss',
    startMode: 'exec',
    pipes: ['include', 'exclude', 'begin'],
    defaultLen: 22,
    more: '-- MORE --, next page: Space, next line: Enter, quit: Control-C',
    prompt: (s) => (s.dev.state !== 'up' ? '' : s.mode === 'exec' ? `${s.dev.cfg.hostname}# ` : s.mode === 'vlan' ? `${s.dev.cfg.hostname}(vlan-${s.ctx.vlan})# ` : s.mode === 'if' ? `${s.dev.cfg.hostname}(eth-${compress(s.ctx.ports || [])})# ` : `${s.dev.cfg.hostname}(config)# `),
    greeting: (s) => `\n${model(s.dev.model).name}\n\nSoftware revision ${s.dev.version}\n\n(C) Copyright ${yearOf(s.world.time.t)} Hewlett Packard Enterprise Development LP\n\n                   RESTRICTED RIGHTS LEGEND\n\nPress any key to continue\n\n`,
    loginPrompt: () => 'Username: ',
    telnetBanner: () => '',
    closeMsg: (s) => (s.via === 'console' ? '\n[Disconnected from console server]\n' : `Connection to ${s.world.design.mgmt[s.dev.id]} closed.\n`),
    preprocess: (s) => (s.dev.state !== 'up' ? '' : undefined),
    trie: (s, m) => tries[m] || tries.exec,
    fallback: (s) => (s.mode === 'vlan' || s.mode === 'if' ? ['config'] : []),
    ifNames: (s) => Object.keys(s.dev.cfg.ifs),
    helpFmt(s, items, cr) {
      const w = Math.max(...items.map(([k]) => k.length), 4) + 2;
      return [...items.map(([k, h]) => ` ${padR(k, w)}${h}`), ...(cr ? [' <cr>'] : [])].join('\n');
    },
    error(s, kind, x) {
      if (kind === 'incomplete') return `Incomplete input: ${x.line.trim().split(/\s+/).pop()}`;
      if (kind === 'ambiguous') return `Ambiguous input: ${x.toks?.[x.at]?.v}`;
      return `Invalid input: ${x.toks?.[x.at]?.v ?? ''}`;
    },
    ctrlC: () => '\n',
    fmtEvent: fmtEventAOSS,
  };
}

// =============================================================================================
// ArubaOS mobility controller
export function makeArubaOS() {
  const KW = { show: 'Show running system information', configure: 'Configuration Commands', ping: 'Send ICMP echo packets to a specified IP address.', aaa: 'Authentication, Authorization and Accounting', write: 'Write running configuration to memory', wlan: 'WLAN configuration' };
  const wl = (s) => cfgOf(s).wlc;
  const radiusTest = (s, name) => {
    const r = wl(s)?.radius.find((x) => x.name === name);
    if (!r) return `Server ${name} not found`;
    const host = Object.values(s.world.hosts).find((h) => h.role === 'radius');
    const p = ping(s, r.ip, { count: 1, proto: 'udp' });
    if (!host || host.ip !== r.ip || !p.r.ok) return stream([{ d: 5000, t: 'Authentication timed out\n' }]);
    if (r.key !== (host.key || 'R4dius-Key')) return stream([{ d: 600, t: 'Authentication failed\n' }]);
    return stream([{ d: 600, t: 'Authentication Successful\n' }]);
  };
  const show = [
    { p: 'show version', run: (s) => [`Aruba Operating System Software.`, `ArubaOS (MODEL: ${model(s.dev.model).name}), Version ${s.dev.version}`, `Website: http://www.arubanetworks.com`, `(c) Copyright ${yearOf(s.world.time.t)} Hewlett Packard Enterprise Development LP.`, `Compiled on ${fmtDate(Math.max(0, s.dev.installed - 90000), 'iso')} by p4build`, '', `ROM: System Bootstrap, Version CPBoot 1.2.1.0 (build 39183)`, `Switch uptime is ${Math.floor(uptimeMins(s.world, s.dev) / 1440)} days ${Math.floor((uptimeMins(s.world, s.dev) % 1440) / 60)} hours`, `Reboot Cause: ${s.dev.run.reloadReason ? 'User reboot' : 'Power Cycle'}`] },
    { p: 'show ap database [long]', run: (s) => {
      const S = S_(s.world);
      const aps = Object.values(s.world.devices).filter((d) => d.role === 'ap');
      return ['', 'AP Database', '-----------', 'Name   Group    AP Type  IP Address   Status          Flags  Switch IP    Standby IP', '----   -----    -------  ----------   ------          -----  ---------    ----------', ...aps.map((ap) => {
        const st = S.wifi.aps[ap.id];
        const status = st?.state === 'up' ? `Up ${dur(uptimeMins(s.world, ap) % 4000)}` : 'Down';
        return `${padR(ap.hostname, 7)}${padR('default', 9)}${padR(ap.model.replace(/^ap/, ''), 9)}${padR(st?.ip || '0.0.0.0', 13)}${padR(status, 16)}${padR(st?.state === 'up' ? '' : 'N', 7)}${padR('10.32.0.5', 13)}0.0.0.0`;
      }), '', `Flags: N = Duplicate name; ... ; X = Maintenance Mode`, '', `Total APs:${aps.length}`];
    } },
    { p: 'show ap active', run: (s) => {
      const S = S_(s.world);
      const aps = Object.values(s.world.devices).filter((d) => d.role === 'ap' && S.wifi.aps[d.id]?.state === 'up');
      return ['', 'Active AP Table', '---------------', 'Name   Group    IP Address   11g Clients  11g Ch/EIRP/MaxEIRP  11a Clients  11a Ch/EIRP/MaxEIRP  AP Type  Uptime', ...aps.map((ap) => `${padR(ap.hostname, 7)}${padR('default', 9)}${padR(S.wifi.aps[ap.id].ip, 13)}${padR(S.wifi.clients?.dhcp ? 4 : 0, 13)}AP:HT:6/18/24        ${padR(S.wifi.clients?.dhcp ? 7 : 0, 13)}AP:VHT:36E/21/24     ${padR(ap.model.replace(/^ap/, ''), 9)}${dur(uptimeMins(s.world, ap) % 4000)}`), '', `Num APs:${aps.length}`];
    } },
    { p: 'show user-table', run: (s) => {
      const c = S_(s.world).wifi.clients;
      const list = c?.dhcp ? [1, 2, 3, 4].map((k) => ({ ip: c.ip.replace(/\.100$/, `.${100 + k}`), mac: macColon(macOfIf(s.dev, `client${k}`)), name: ['jsmith', 'akhan', 'lchen', 'mrossi'][k - 1] })) : [];
      return ['', 'Users', '-----', '    IP              MAC            Name    Role      Age(d:h:m)  Auth     VPN link  AP name  Roaming  Essid/Bssid/Phy                     Profile', '----------  ------------       ------  ----      ----------  ----     --------  -------  -------  ---------------                     -------', ...list.map((u) => `${padR(u.ip, 12)}${padR(u.mac, 19)}${padR(u.name, 8)}${padR('staff', 10)}00:00:${String(hashStr(u.ip) % 60).padStart(2, '0')}    802.1x             ap1      Wireless ${c.ssid}/${u.mac.slice(0, 14)}0/a-VHT   default`), '', `User Entries: ${list.length}/${list.length}`];
    } },
    { p: 'show wlan ssid-profile [$word:n]', run: (s) => (wl(s)?.ssids || []).flatMap((x) => [`SSID Profile "${x.name}"`, '--------------------', 'Parameter                     Value', '---------                     -----', `ESSID                         ${x.essid}`, `Encryption                    ${x.auth === 'wpa2-ent' ? 'wpa2-aes' : 'opensystem'}`, `VLAN                          ${x.vlan}`, `Forward mode                  ${x.mode === 'bridge' ? 'bridge' : 'tunnel'}`, '']) },
    { p: 'show aaa authentication-server radius [$word:n]', run: (s) => (wl(s)?.radius || []).flatMap((r) => [`RADIUS Server "${r.name}"`, '----------------------', 'Parameter                Value', '---------                -----', `Host                     ${r.ip}`, `Key                      ********`, 'Auth Port                1812', 'Acct Port                1813', 'Retransmits              3', 'Timeout                  5 sec', '']) },
    { p: 'show aaa authentication-server all', run: (s) => ['Auth Server Table', '-----------------', 'Name   Type    FQDN  IP addr      AuthPort  AcctPort  Status  Requests', ...(wl(s)?.radius || []).map((r) => `${padR(r.name, 7)}Radius  n/a   ${padR(r.ip, 13)}1812      1813      ${ping(s, r.ip, { count: 1 }).r.ok ? 'Enabled' : 'Out-Of-Service'} ${hashStr(r.ip) % 9000}`)] },
    { p: 'show ip interface brief', run: (s) => ['', 'Interface                   IP Address / IP Netmask        Admin   Protocol', ...sortedIfs(s.dev, (i) => i.ip).map((n) => `${padR(n.replace(/^vlan/, 'vlan '), 28)}${padR(`${ipOnly(s.dev.cfg.ifs[n].ip)} / ${maskStr(lenOf(s.dev.cfg.ifs[n].ip))}`, 31)}${padR(s.dev.cfg.ifs[n].on ? 'up' : 'down', 8)}${S_(s.world).ifs[s.dev.id][n]?.proto ? 'up' : 'down'}`)] },
    { p: 'show vlan', run: (s) => ['', 'VLAN CONFIGURATION', '------------------', 'VLAN  Description  Ports                AAA Profile  Option-82', '----  -----------  -----                -----------  ---------', ...Object.keys(s.dev.cfg.vlans).map((v) => `${padR(v, 6)}${padR(s.dev.cfg.vlans[v], 13)}${padR(physIfs(s.dev).filter((n) => s.dev.cfg.ifs[n].sw && (s.dev.cfg.ifs[n].sw.mode === 'access' ? s.dev.cfg.ifs[n].sw.vlan === Number(v) : true)).slice(0, 3).join(' '), 21)}N/A          Disabled`)] },
    { p: 'show ip route', run: (s) => ['', 'Codes: C - connected, O - OSPF, R - RIP, S - static', '       M - mgmt, U - route usable, * - candidate default, V - RAPNG VPN, Ov - OSPF VPN', '', `Gateway of last resort is ${s.dev.cfg.static.find((r) => r.pfx === '0.0.0.0/0')?.nh || 'not set'} to network 0.0.0.0 at cost 1`, ...(S_(s.world).rib[s.dev.id]?.best || []).filter((r) => r.proto !== 'local').map((r) => `${r.proto === 'connected' ? 'C   ' : 'S*  '}  ${r.pfx} ${r.nh ? `[1/0] via ${r.nh}*` : `is directly connected, ${r.oif.replace('vlan', 'VLAN')}`}`)] },
    { p: 'show log {system|all|security} [$num:n]', run: (s, a) => s.dev.run.logs.slice(-(a.n || 40)).map((e) => fmtEventArubaOS(e, s.dev)).filter(Boolean) },
    { p: 'show running-config', run: (s) => {
      const c = s.dev.cfg;
      const L = ['Building Configuration...', `version ${String(s.dev.version).split('.').slice(0, 2).join('.')}`, `hostname "${c.hostname}"`, 'controller-ip vlan 32', ...Object.keys(c.vlans).filter((v) => v !== '1').map((v) => `vlan ${v}`)];
      for (const n of physIfs(s.dev)) {
        const i = c.ifs[n];
        L.push(`interface gigabitethernet ${n.replace(/^\D+/, '')}`, `    description "${i.desc}"`, ...(i.sw?.mode === 'trunk' ? ['    trusted', '    trusted vlan 1-4094', '    switchport mode trunk', `    switchport trunk allowed vlan ${i.sw.allowed === 'all' ? 'all' : fmtVlans(i.sw.allowed)}`] : []), ...(i.on ? [] : ['    shutdown']), '!');
      }
      for (const n of sortedIfs(s.dev, (i) => i.kind === 'svi')) L.push(`interface vlan ${c.ifs[n].vlan}`, ...(c.ifs[n].ip ? [`    ip address ${ipOnly(c.ifs[n].ip)} ${maskStr(lenOf(c.ifs[n].ip))}`] : []), '!');
      for (const r of c.static) L.push(`ip default-gateway ${r.nh}`);
      for (const r of c.wlc?.radius || []) L.push(`aaa authentication-server radius "${r.name}"`, `   host "${r.ip}"`, `   key ${hashStr(r.key).toString(16)}${hashStr(r.key + 'x').toString(16)}`, '!');
      for (const x of c.wlc?.ssids || []) L.push(`wlan ssid-profile "${x.name}"`, `   essid "${x.essid}"`, '   opmode wpa2-aes', '!', `wlan virtual-ap "${x.name}"`, `   aaa-profile "${x.name}"`, `   ssid-profile "${x.name}"`, `   vlan ${x.vlan}`, `   forward-mode ${x.mode}`, '!');
      L.push('end');
      return L;
    } },
  ];
  const exec = [
    ...show,
    { p: 'aaa test-server {pap|mschapv2} $word:server $word:user $word:pw', run: (s, a) => radiusTest(s, a.server) },
    { p: 'configure terminal', run: (s) => ((s.mode = 'config'), 'Enter Configuration commands, one per line. End with CNTL/Z') },
    { p: 'write memory', run: (s) => (saveStartup(s.dev, s.world.time.t), stream([{ d: 10, t: '\nSaving Configuration...\n' }, { d: 900, t: '\nConfiguration Saved.\n' }])) },
    { p: 'ping $host:t', run: (s, a) => {
      const p = ping(s, a.t, { count: 5 });
      return stream([{ d: 10, t: `Press 'q' to abort.\nSending 5, 92-byte ICMP Echos to ${a.t}, timeout is 2 seconds:\n` }, ...p.res.map((x) => ({ d: x.ok ? 100 : 700, t: x.ok ? '!' : '.' })), { d: 0, t: `\nSuccess rate is ${p.pct} percent (${p.recv}/5)${p.recv ? `, round-trip min/avg/max = ${p.min}/${p.avg}/${p.max} ms` : ''}\n` }]);
    } },
    { p: 'traceroute $host:t', run: (s, a) => {
      const { hops } = trace(s, a.t);
      return stream([{ d: 10, t: `\nTracing the route to ${a.t}\n\n` }, ...hops.map((h, k) => ({ d: 400, t: h.ok ? `  ${k + 1}  ${h.ip}  1 msec  1 msec  1 msec\n` : `  ${k + 1}  *  *  *\n` }))]);
    } },
    { p: 'apboot ap-name $word:ap', run: (s, a) => {
      const ap = Object.values(s.world.devices).find((d) => d.hostname === a.ap && d.role === 'ap');
      if (!ap) return `AP with name ${a.ap} not found.`;
      reload(s.world, ap, { reason: 'apboot from controller' });
      return '';
    } },
    { p: 'reload', run: (s) => ask('Do you really want to reset the system(y/n): ', (x) => {
      if (!/^y/i.test(x)) return '';
      reload(s.world, s.dev, { reason: 'User reboot' });
      if (s.via !== 'console') s.closed = true;
      return 'System will now restart!';
    }) },
    { p: 'no paging', run: (s) => ((s.termLen = 0), '') },
    { p: 'paging', run: (s) => ((s.termLen = 24), '') },
    { p: '{exit|logout}', run: (s) => ((s.closed = true), '') },
  ];
  const radiusCmds = [
    { p: 'host $ip:ip', run: (s, a) => ((s.ctx.radius.ip = a.ip), changed(s)) },
    { p: 'key $word:k', run: (s, a) => ((s.ctx.radius.key = a.k), changed(s)) },
  ];
  const ssidCmds = [{ p: 'essid $word:e', run: (s, a) => ((s.ctx.ssid.essid = a.e.replace(/"/g, '')), changed(s)) }];
  const vapCmds = [
    { p: 'vlan $num(1-4094):v', run: (s, a) => ((s.ctx.ssid.vlan = a.v), changed(s)) },
    { p: 'forward-mode {bridge|tunnel}', run: (s, a) => ((s.ctx.ssid.mode = a.kw[1]), changed(s)) },
  ];
  const g = [
    { p: 'aaa authentication-server radius $word:n', run: (s, a) => {
      const w = wl(s) || (cfgOf(s).wlc = { ssids: [], radius: [] });
      let r = w.radius.find((x) => x.name === a.n.replace(/"/g, ''));
      if (!r) w.radius.push((r = { name: a.n.replace(/"/g, ''), ip: null, key: '' }));
      s.ctx = { radius: r };
      s.mode = 'radius';
    } },
    { p: 'wlan ssid-profile $word:n', run: (s, a) => {
      const x = wl(s)?.ssids.find((y) => y.name === a.n.replace(/"/g, ''));
      if (!x) return `% SSID profile ${a.n} not found`;
      s.ctx = { ssid: x };
      s.mode = 'ssid';
    } },
    { p: 'wlan virtual-ap $word:n', run: (s, a) => {
      const x = wl(s)?.ssids.find((y) => y.name === a.n.replace(/"/g, ''));
      if (!x) return `% Virtual AP profile ${a.n} not found`;
      s.ctx = { ssid: x };
      s.mode = 'vap';
    } },
    { p: 'interface vlan $num(1-4094):v', run: (s, a) => {
      ensureSvi(s.dev, a.v);
      s.ctx = { if: `vlan${a.v}` };
      s.mode = 'if';
    } },
    { p: 'ip default-gateway $ip:gw', run: (s, a) => ((cfgOf(s).static = [{ pfx: '0.0.0.0/0', nh: a.gw, ad: 1 }]), changed(s)) },
    { p: 'hostname $word:h', run: (s, a) => ((cfgOf(s).hostname = a.h.replace(/"/g, '')), (s.dev.hostname = cfgOf(s).hostname), changed(s)) },
  ];
  const ifc = [
    { p: 'ip address $ip:ip $mask:m', run: (s, a) => ((sel(s).ip = `${a.ip}/${maskLen(a.m)}`), changed(s)) },
    { p: '[no] shutdown', run: (s, a) => ((sel(s).on = a.has('no')), changed(s)) },
  ];
  const common = [
    { p: 'end', run: (s) => ((s.mode = 'exec'), (s.ctx = {}), configEnded(s), '') },
    { p: 'exit', run: (s) => {
      if (s.mode === 'config') {
        s.mode = 'exec';
        configEnded(s);
      } else s.mode = 'config';
      return '';
    } },
  ];
  const tries = { exec: compile(exec, KW), config: compile([...g, ...common], KW), radius: compile([...radiusCmds, ...common], KW), ssid: compile([...ssidCmds, ...common], KW), vap: compile([...vapCmds, ...common], KW), if: compile([...ifc, ...common], KW) };
  const P = { config: 'config', radius: 'RADIUS Server', ssid: 'SSID Profile', vap: 'Virtual AP profile', if: 'config-subif' };
  return {
    id: 'arubaos',
    startMode: 'exec',
    pipes: ['include', 'exclude', 'begin'],
    defaultLen: 24,
    more: '--More-- (q) quit (u) pageup (/) search (n) repeat',
    prompt: (s) => (s.dev.state !== 'up' ? '' : s.mode === 'exec' ? `(${s.dev.cfg.hostname}) #` : `(${s.dev.cfg.hostname}) (${P[s.mode]}${s.ctx.radius ? ` "${s.ctx.radius.name}"` : s.ctx.ssid ? ` "${s.ctx.ssid.name}"` : ''}) #`),
    greeting: () => '',
    loginPrompt: () => 'User: ',
    closeMsg: (s) => (s.via === 'console' ? '\n[Disconnected from console server]\n' : `Connection to ${s.world.design.mgmt[s.dev.id]} closed.\n`),
    preprocess: (s) => (s.dev.state !== 'up' ? '' : undefined),
    trie: (s, m) => tries[m] || tries.exec,
    fallback: (s) => (s.mode !== 'exec' && s.mode !== 'config' ? ['config'] : []),
    helpFmt(s, items, cr) {
      const w = Math.max(...items.map(([k]) => k.length), 4) + 2;
      return [...items.map(([k, h]) => `${padR(k, w)}${h}`), ...(cr ? ['<cr>'] : [])].join('\n');
    },
    error(s, kind, x) {
      if (kind === 'incomplete') return '% Incomplete command.';
      if (kind === 'ambiguous') return `% Ambiguous command: "${x.line}"`;
      return `${' '.repeat(s.prompt.length + x.pos)}^\n% Invalid input detected at '^' marker.`;
    },
    ctrlC: () => '\n',
    fmtEvent: fmtEventArubaOS,
  };
}
export function fmtEventArubaOS(e, dev) {
  const ts = `${fmtDate(e.t, 'syslog')} :`;
  switch (e.type) {
    case 'ap':
      return e.up ? `${ts}311020:  <NOTI> |AP ${e.ap}@${e.ip} sapd|  An internal system error has occurred at file sapd_main.c function sapd_hello line 3043 error Up: AP is up`.replace(/An internal.*error /, '') : `${ts}311002:  <WARN> |AP ${e.ap}@${e.ip} sapd|  Rebooting: SAPD: Reboot after image upgrade/hello timeout to master ${'10.32.0.5'} (${e.why})`;
    case 'link':
      return e.kind === 'phys' ? `${ts}326277:  <NOTI> |stm|  Port ${e.if} link ${e.up ? 'up' : 'down'}` : null;
    case 'config':
      return `${ts}125023:  <NOTI> |mgmtd|  Configuration changed by ${e.by} from ${e.from || '10.250.0.10'}`;
    case 'login':
      return `${ts}125022:  <NOTI> |cli|  User ${e.user}@${e.from} connected using SSH`;
    case 'authfail':
      return `${ts}125024:  <WARN> |cli|  Authentication failed for user ${e.user}@${e.from}`;
    case 'radius':
      return `${ts}121031:  <WARN> |authmgr|  RADIUS server ${e.server}-${e.ip} ${e.why}`;
    case 'boot':
      return `${ts}303022:  <WARN> |nanny|  Reboot Reason: ${dev.run.reloadReason || 'Power Cycle'}`;
    default:
      return null;
  }
}

// =============================================================================================
// Aruba AP boot loader shell (console only)
export function makeAPBoot() {
  return {
    id: 'apos',
    startMode: 'boot',
    prompt: (s) => (s.dev.state !== 'up' ? '' : 'apboot> '),
    greeting: (s) => `\n\nAPBoot 1.5.5.7 (build 64925)\nBuilt: ${fmtDate(Math.max(0, s.dev.installed - 200000), 'long')}\n\nModel: AP-${s.dev.model.replace(/^ap/, '')}\nDRAM:  512 MB\nFlash: Detected MX25L25635F: total 32 MiB\nNet:   eth0\nHit <Enter> to stop autoboot:  0\n`,
    closeMsg: () => '\n[Disconnected from console server]\n',
    trie: () => ({ kws: new Map(), params: [], end: null }),
    helpFmt: () => '',
    error: () => '',
    preprocess(s, line) {
      const w = line.trim().split(/\s+/);
      const ap = s.dev.cfg.ap || {};
      s.vars.env = s.vars.env || { master: ap.ctrl || '', ipaddr: ap.ip || '', netmask: '255.255.255.0', gatewayip: (ap.ip || '').replace(/\.\d+$/, '.1'), name: s.dev.hostname };
      const env = s.vars.env;
      switch (w[0]) {
        case '':
          return '';
        case 'help':
        case '?':
          return ['boot     - boot the AP image from flash', 'printenv - print environment variables', 'setenv   - set environment variables', 'saveenv  - save environment variables to persistent storage', 'reset    - Perform RESET of the CPU', 'ping     - send ICMP ECHO_REQUEST to network host', 'version  - print monitor version'];
        case 'printenv':
          return [...Object.entries(env).map(([k, v]) => `${k}=${v}`), 'bootdelay=2', 'baudrate=9600', 'autoload=n', 'bootcmd=boot ap', '', `Environment size: 412/65532 bytes`];
        case 'setenv':
          if (!w[1]) return 'Usage: setenv name value';
          env[w[1]] = w.slice(2).join(' ');
          return '';
        case 'saveenv':
          s.dev.cfg.ap = { ...ap, ctrl: env.master || null, ip: env.ipaddr || ap.ip };
          return stream([{ d: 400, t: 'Saving Environment to Flash...\n' }, { d: 600, t: 'Erasing Flash...done\nWriting to Flash... done\n' }]);
        case 'ping': {
          const ok = (S_(s.world).bySeg.get(S_(s.world).eps.find((e) => e.dev === s.dev.id)?.seg) || []).some((e) => e.ip === w[1]) || (w[1] === env.gatewayip && S_(s.world).eps.some((e) => e.ip === w[1]));
          return stream([{ d: 1200, t: ok ? `host ${w[1]} is alive\n` : `ping failed; host ${w[1]} is not alive\n` }]);
        }
        case 'version':
          return 'APBoot 1.5.5.7 (build 64925)';
        case 'boot':
        case 'reset':
          s.dev.cfg.ap = { ...ap, ctrl: env.master || ap.ctrl, ip: env.ipaddr || ap.ip };
          reload(s.world, s.dev, { reason: 'apboot' });
          s.world.dirty = true;
          return stream([{ d: 500, t: 'Checking image @ 0x1e000000...\nCopying image from 0x1e000000\nChecking image @ 0x2000000\nVerifying checksum... OK\n' }, { d: 900, t: 'Uncompressing Kernel Image ... OK\n\nStarting kernel ...\n\n' }], { then: () => { s.closed = true; return '\n[AP is booting - console released]\n'; } });
        default:
          return `Unknown command '${w[0]}' - try 'help'`;
      }
    },
  };
}
void compile;
void resolveIf;
void lookup;
void walk;
void logEvent;
void recompute;
void inNet;
void upCisco;
void ensureLag;
