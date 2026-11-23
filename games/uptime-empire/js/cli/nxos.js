// Cisco NX-OS (Nexus). Reuses the IOS configuration grammar where NX-OS is compatible and adds
// NX-OS specifics: feature gating, prefix-length addressing, hsrp/ospf interface syntax, checkpoints.
import { compile, ask, stream } from './engine.js';
import { model, OS, resolveIf, shortIf, splitIf } from '../net/catalog.js';
import { ensureSvi, newIf, saveStartup, unsaved } from '../net/model.js';
import { S_, cfgOf, changed, configEnded, ping, trace, counters, sortedIfs, physIfs, uptimeMins, ipOnly, lenOf, optics } from './common.js';
import { KW, ifCmds, globalCfg, aclCfg, showVlan, showStp, showMac, showCdp, showLldp, showArp, showTransceiver, ifStatusWord, duplexSpeed, doReload, parseAce, aclLines } from './ios.js';
import { logEvent, recompute } from '../net/events.js';
import { cidr, n2ip, maskStr, maskLen, fmtVlans, fmtDate, upCisco, upJunos, padR, padL, row, hashStr, isIp, yearOf, macCisco, ip2n } from '../core/util.js';

const sh = (dev, n) => shortIf(dev, n);
const feats = (cfg) => {
  const f = new Set(cfg.features || []);
  if (cfg.ospf.on) f.add('ospf');
  if (cfg.bgp.on) f.add('bgp');
  if (Object.values(cfg.ifs).some((i) => i.kind === 'svi')) f.add('interface-vlan');
  if (Object.values(cfg.ifs).some((i) => i.fhrp?.proto === 'hsrp')) f.add('hsrp');
  if (Object.values(cfg.ifs).some((i) => i.fhrp?.proto === 'vrrp')) f.add('vrrp');
  if (Object.values(cfg.ifs).some((i) => ['active', 'passive'].includes(i.lag?.mode))) f.add('lacp');
  if (Object.values(cfg.ifs).some((i) => i.helper?.length)) f.add('dhcp');
  return [...f].sort();
};
const need = (s, f) => (feats(cfgOf(s)).includes(f) ? null : `% Invalid command at '^' marker.`);

// ---------------------------------------------------------------------------------------------
function running(s, cfg = s.dev.cfg, only = null) {
  const dev = s.dev;
  const L = [];
  const ifBlock = (n) => {
    const i = cfg.ifs[n];
    const b = [`interface ${n}`];
    if (i.desc) b.push(`  description ${i.desc}`);
    if (i.sw && i.kind !== 'svi') {
      if (i.sw.mode === 'trunk') {
        b.push('  switchport mode trunk');
        if (i.sw.native !== 1 && i.sw.native != null) b.push(`  switchport trunk native vlan ${i.sw.native}`);
        if (i.sw.allowed !== 'all') b.push(`  switchport trunk allowed vlan ${i.sw.allowed.length ? fmtVlans(i.sw.allowed) : 'none'}`);
      } else if (i.sw.vlan !== 1) b.push(`  switchport access vlan ${i.sw.vlan}`);
      if (i.stp?.edge) b.push(i.sw.mode === 'trunk' ? '  spanning-tree port type edge trunk' : '  spanning-tree port type edge');
      if (i.stp?.bpduguard) b.push('  spanning-tree bpduguard enable');
    } else if (i.kind === 'phys') b.push('  no switchport');
    if (i.speed !== 'auto' && i.kind === 'phys') b.push(`  speed ${i.speed}`);
    if (i.duplex !== 'auto' && i.kind === 'phys') b.push(`  duplex ${i.duplex}`);
    if (i.mtu && i.mtu !== 1500) b.push(`  mtu ${i.mtu}`);
    if (i.lag) b.push(`  channel-group ${i.lag.id} mode ${i.lag.mode}`);
    if (i.vrf) b.push(`  vrf member ${i.vrf}`);
    if (i.acl?.in) b.push(`  ip access-group ${i.acl.in} in`);
    if (i.ip) b.push(`  ip address ${i.ip}`);
    if (i.ospf?.area != null) {
      if (i.ospf.cost) b.push(`  ip ospf cost ${i.ospf.cost}`);
      if (i.ospf.hello && i.ospf.hello !== 10) b.push(`  ip ospf hello-interval ${i.ospf.hello}`);
      if (i.ospf.dead && i.ospf.dead !== 40) b.push(`  ip ospf dead-interval ${i.ospf.dead}`);
      if (i.ospf.passive) b.push('  ip ospf passive-interface');
      if (i.ospf.auth) b.push(`  ip ospf authentication-key 3 ${i.ospf.auth}`);
      b.push(`  ip router ospf ${cfg.ospf.pid} area ${i.ospf.area}`);
    }
    for (const h of i.helper || []) b.push(`  ip dhcp relay address ${h}`);
    if (i.fhrp?.proto === 'hsrp') {
      b.push(`  hsrp ${i.fhrp.grp}`);
      if (i.fhrp.preempt) b.push('    preempt');
      if (i.fhrp.prio !== 100) b.push(`    priority ${i.fhrp.prio}`);
      b.push(`    ip ${i.fhrp.vip}`);
    }
    if (i.fhrp?.proto === 'vrrp') b.push(`  vrrp ${i.fhrp.grp}`, `    priority ${i.fhrp.prio}`, `    address ${i.fhrp.vip}`, '    no shutdown');
    const defaultUp = !!i.sw && i.kind === 'phys';
    if (!i.on && (defaultUp || i.kind !== 'phys')) b.push('  shutdown');
    else if (i.on && !defaultUp && i.kind !== 'lo') b.push('  no shutdown');
    return b;
  };
  if (only) return ['', `!Command: show running-config interface ${only}`, `!Time: ${fmtDate(s.world.time.t, 'long')}`, '', `version ${dev.version}`, '', ...ifBlock(only)];
  L.push(`!Command: show running-config`, `!Running configuration last done at: ${fmtDate(dev.run.lastCfg, 'long')} ${fmtDate(dev.run.lastCfg, 'datetime').slice(11)}:00`, `!Time: ${fmtDate(s.world.time.t, 'long')}`, '', `version ${dev.version} Bios:version 05.45`, `hostname ${cfg.hostname}`, '');
  for (const f of feats(cfg)) L.push(`feature ${f}`);
  L.push('');
  for (const u of cfg.svc.users) L.push(`username ${u.name} password 5 $5$${hashStr(u.pw).toString(36)}$${hashStr(u.pw + 'n').toString(36)}  role network-admin`);
  if (!cfg.svc.domainLookup) L.push('no ip domain-lookup');
  L.push(`ip domain-name ${cfg.svc.domain}`);
  if (cfg.svc.snmp) L.push(`snmp-server community ${cfg.svc.snmp} group network-operator`);
  for (const n of cfg.svc.ntp) L.push(`ntp server ${n} use-vrf management`);
  for (const h of cfg.svc.syslog) L.push(`logging server ${h} 6 use-vrf management`);
  L.push('');
  for (const [name, entries] of Object.entries(cfg.acls)) {
    L.push(`ip access-list ${name}`);
    aclLines(name, entries, false).forEach((l, k) => L.push(`  ${(k + 1) * 10}${l.replace(/(\d+\.\d+\.\d+\.\d+) (\d+\.\d+\.\d+\.\d+)/g, (m, a, w) => `${a}/${maskLen(n2ip(~ip2n(w) >>> 0))}`)}`));
  }
  for (const r of cfg.static) L.push(`ip route ${r.pfx} ${r.iface === 'Null0' ? 'Null0' : r.nh}${r.ad && r.ad !== 1 ? ` ${r.ad}` : ''}`);
  const vl = Object.keys(cfg.vlans).map(Number).sort((a, b) => a - b);
  L.push(`vlan ${fmtVlans(vl)}`);
  for (const v of vl) if (v !== 1) L.push(`vlan ${v}`, `  name ${cfg.vlans[v]}`);
  L.push('');
  const byPrio = {};
  for (const [v, p] of Object.entries(cfg.stp.prio)) (byPrio[p] = byPrio[p] || []).push(Number(v));
  for (const [p, l] of Object.entries(byPrio)) L.push(`spanning-tree vlan ${fmtVlans(l)} priority ${p}`);
  if (cfg.stp.off?.length) L.push(`no spanning-tree vlan ${fmtVlans(cfg.stp.off)}`);
  L.push('vrf context management');
  if (cfg.mgmtGw) L.push(`  ip route 0.0.0.0/0 ${cfg.mgmtGw.ip}`);
  L.push('');
  for (const n of sortedIfs(dev, () => true)) if (cfg.ifs[n]) L.push('', ...ifBlock(n));
  L.push('line console', 'line vty');
  if (cfg.ospf.on) {
    L.push(`router ospf ${cfg.ospf.pid}`);
    if (cfg.ospf.rid) L.push(`  router-id ${cfg.ospf.rid}`);
    if (cfg.ospf.defOrig) L.push(`  default-information originate${cfg.ospf.always ? ' always' : ''}`);
  }
  if (cfg.bgp.on) {
    L.push(`router bgp ${cfg.bgp.asn}`);
    if (cfg.bgp.rid) L.push(`  router-id ${cfg.bgp.rid}`);
    L.push('  address-family ipv4 unicast', ...cfg.bgp.nets.map((n) => `    network ${n}`));
    for (const nb of cfg.bgp.nbrs) {
      L.push(`  neighbor ${nb.ip}`, `    remote-as ${nb.ras}`);
      if (nb.desc) L.push(`    description ${nb.desc}`);
      if (nb.shut) L.push('    shutdown');
      L.push('    address-family ipv4 unicast');
      if (nb.maxpfx) L.push(`      maximum-prefix ${nb.maxpfx}`);
    }
  }
  return L;
}

// ---------------------------------------------------------------------------------------------
function reasonOf(s, dev, n) {
  const w = ifStatusWord(s, dev, n);
  if (w.short === 'disabled') return ['down', 'Administratively down'];
  if (w.short === 'err-disabled') return ['down', 'BPDUGuard errDisable'];
  if (w.short === 'inactive') return ['down', 'VLAN/BD is down'];
  if (w.short === 'suspended') return ['down', 'suspended(no LACP PDUs)'];
  if (w.short === 'notconnect') return ['down', 'Link not connected'];
  return ['up', 'none'];
}
function showIntBrief(s) {
  const dev = s.dev;
  const S = S_(s.world);
  const sep = '-'.repeat(80);
  const out = ['', sep, 'Ethernet      VLAN    Type Mode   Status  Reason                   Speed     Port', 'Interface                                                                    Ch #', sep];
  for (const n of physIfs(dev).filter((x) => dev.cfg.ifs[x].kind === 'phys')) {
    const i = dev.cfg.ifs[n];
    const [st, why] = reasonOf(s, dev, n);
    const ds = duplexSpeed(s, dev, n);
    const sp = ds.up ? `${ds.sp >= 1000 ? `${ds.sp / 1000}G` : ds.sp}(D)` : 'auto(D)';
    out.push(`${padR(sh(dev, n), 14)}${padR(i.sw ? (i.sw.mode === 'trunk' ? i.sw.native : i.sw.vlan) : '--', 8)}eth  ${padR(i.sw ? i.sw.mode : 'routed', 7)}${padR(st, 8)}${padR(why, 24)}${padL(sp, 9)}  ${i.lag ? i.lag.id : '--'}`);
  }
  const lags = sortedIfs(dev, (i) => i.kind === 'lag');
  if (lags.length) {
    out.push('', sep, 'Port-channel VLAN    Type Mode   Status  Reason                    Speed   Protocol', 'Interface', sep);
    for (const n of lags) {
      const i = dev.cfg.ifs[n];
      const up = S.lags[dev.id]?.[n]?.up;
      out.push(`${padR(sh(dev, n), 13)}${padR(i.sw ? i.sw.native : '--', 8)}eth  ${padR(i.sw ? i.sw.mode : 'routed', 7)}${padR(up ? 'up' : 'down', 8)}${padR(up ? 'none' : 'No operational members', 25)}${padR(up ? 'a-100G(D)' : 'auto(I)', 10)} lacp`);
    }
  }
  const mg = dev.meta.mgmtIf;
  if (mg) out.push('', sep, 'Port   VRF          Status IP Address                              Speed    MTU', sep, `${padR(mg, 7)}--           ${padR(S.ifs[dev.id][mg]?.up ? 'up' : 'down', 7)}${padR(ipOnly(dev.cfg.ifs[mg].ip) || '--', 40)}1000     1500`);
  const svis = sortedIfs(dev, (i) => i.kind === 'svi' || i.kind === 'lo');
  if (svis.length) {
    out.push('', sep, 'Interface                Secondary VLAN(Type)                    Status Reason', sep);
    for (const n of svis) {
      const st = S.ifs[dev.id][n];
      out.push(`${padR(n, 25)}--                                      ${padR(st?.proto ? 'up' : 'down', 7)}${st?.proto ? '--' : dev.cfg.ifs[n].on ? 'VLAN/BD is down' : 'Administratively down'}`);
    }
  }
  return out;
}
function showIpIntBrief(s, vrf) {
  const dev = s.dev;
  const S = S_(s.world);
  const out = [`IP Interface Status for VRF "${vrf || 'default'}"(${vrf === 'management' ? 2 : 1})`, 'Interface            IP Address      Interface Status'];
  for (const n of sortedIfs(dev, (i) => i.ip && (i.vrf || 'default') === (vrf || 'default'))) {
    const i = dev.cfg.ifs[n];
    const st = S.ifs[dev.id][n];
    out.push(`${padR(sh(dev, n), 21)}${padR(ipOnly(i.ip), 16)}protocol-${st?.proto ? 'up' : 'down'}/link-${st?.up ? 'up' : 'down'}/admin-${i.on ? 'up' : 'down'}`);
  }
  return out;
}
function showIntOne(s, n) {
  const dev = s.dev;
  const i = dev.cfg.ifs[n];
  const c = counters(s.world, dev, n);
  const [st, why] = reasonOf(s, dev, n);
  const ds = duplexSpeed(s, dev, n);
  const mac = macCisco(dev.run.mac || [0, 0x2a, 0x6a, (hashStr(dev.id) % 255), 0x1b, 0x3c].map((x) => x.toString(16).padStart(2, '0')));
  const out = [`${n} is ${st}${st === 'down' ? ` (${why})` : ''}`, `admin state is ${i.on ? 'up' : 'down'}, Dedicated Interface`];
  if (i.kind === 'svi' || i.kind === 'lo') out.splice(1, 1, `admin state is ${i.on ? 'up' : 'down'},`);
  out.push(`  Hardware: ${i.kind === 'svi' ? 'EtherSVI' : `${(i.hw?.speed || 1000) >= 1000 ? (i.hw?.speed || 1000) / 1000 : 1}0000/${i.hw?.speed >= 40000 ? '100000' : '25000'} Ethernet`}, address: ${mac} (bia ${mac})`);
  if (i.desc) out.push(`  Description: ${i.desc}`);
  if (i.ip) out.push(`  Internet Address is ${i.ip}`);
  out.push(`  MTU ${i.mtu || 1500} bytes, BW ${(ds.up ? ds.sp : i.hw?.speed || 1000) * 1000} Kbit, DLY 10 usec`, '  reliability 255/255, txload 1/255, rxload 1/255', '  Encapsulation ARPA, medium is broadcast');
  if (i.kind === 'phys') out.push(`  Port mode is ${i.sw ? i.sw.mode : 'routed'}`, `  ${ds.dup === 'half' ? 'half' : 'full'}-duplex, ${ds.up ? `${ds.sp / 1000} Gb/s` : 'auto-speed'}${optics(dev, n) ? `, media type is ${ds.sp >= 10000 ? '10G' : '1G'}` : ''}`, '  Beacon is turned off', '  Auto-Negotiation is turned on  FEC mode is Auto', '  Input flow-control is off, output flow-control is off', '  Auto-mdix is turned off', '  Rate mode is dedicated', '  Switchport monitor is off', '  EtherType is 0x8100');
  out.push(`  Last link flapped ${upCisco(Math.max(0, s.world.time.t - dev.run.boot) % 9000)}`, `  Last clearing of "show interface" counters ${c.lastClear > dev.run.boot ? upCisco(s.world.time.t - c.lastClear) : 'never'}`, `  ${c.resets + 1} interface resets`, '  30 seconds input rate ' + c.rateIn + ' bits/sec, ' + c.ppsIn + ' packets/sec', '  30 seconds output rate ' + c.rateOut + ' bits/sec, ' + c.ppsOut + ' packets/sec');
  out.push('  RX', `    ${c.inP - c.inMc - c.bcast} unicast packets  ${c.inMc} multicast packets  ${c.bcast} broadcast packets`, `    ${c.inP} input packets  ${c.inB} bytes`, `    0 jumbo packets  0 storm suppression bytes`, `    ${c.runts} runts  0 giants  ${c.crc} CRC  0 no buffer`, `    ${c.inErr} input error  0 short frame  0 overrun   0 underrun  0 ignored`, `    0 watchdog  0 bad etype drop  0 bad proto drop  0 if down drop`, `    0 input with dribble  ${c.drops} input discard`, '    0 Rx pause');
  out.push('  TX', `    ${c.outP} unicast packets  ${Math.floor(c.outMc)} multicast packets  0 broadcast packets`, `    ${c.outP} output packets  ${c.outB} bytes`, '    0 jumbo packets', `    ${c.outErr} output error  ${c.coll} collision  0 deferred  ${c.late} late collision`, '    0 lost carrier  0 no carrier  0 babble  0 output discard', '    0 Tx pause');
  return out;
}
function showRoute(s, vrf, ipArg) {
  const dev = s.dev;
  const S = S_(s.world);
  const rib = (S.rib[dev.id]?.best || []).filter((r) => (r.vrf || 'default') === (vrf || 'default'));
  const age = upCisco((s.world.time.t - dev.run.boot) % 50000);
  const out = [`IP Route Table for VRF "${vrf || 'default'}"`, "'*' denotes best ucast next-hop", "'**' denotes best mcast next-hop", "'[x/y]' denotes [preference/metric]", "'%<string>' in via output denotes VRF <string>", ''];
  let list = rib;
  if (ipArg) {
    const hits = rib.filter((r) => ipArg.includes('/') ? r.pfx === ipArg : cidr(r.pfx) && ((ip2n(ipArg) & cidr(r.pfx).mask) >>> 0) === cidr(r.pfx).net);
    hits.sort((a, b) => Number(b.pfx.split('/')[1]) - Number(a.pfx.split('/')[1]));
    list = hits.slice(0, 1);
    if (!list.length) return [...out, `Route not found`];
  }
  for (const r of list) {
    const att = ['connected', 'local'].includes(r.proto);
    out.push(`${r.pfx}, ubest/mbest: ${(r.ecmp || [1]).length}/0${att ? ', attached' : ''}`);
    const src = r.proto === 'connected' ? 'direct' : r.proto === 'local' ? 'local' : r.proto === 'static' ? 'static' : r.proto.startsWith('ospf') ? `ospf-${dev.cfg.ospf.pid}, ${r.ospfType === 'E2' ? 'type-2' : 'intra'}` : `bgp-${dev.cfg.bgp.asn}, external, tag ${r.peer ? '65001' : ''}`;
    for (const h of r.ecmp || [{ nh: r.nh, oif: r.oif }]) out.push(`    *via ${h.nh || ipOnly(dev.cfg.ifs[r.oif]?.ip) || '0.0.0.0'}${r.discard ? ', Null0' : `, ${sh(dev, h.oif || r.oif)}`}, [${r.ad}/${r.metric}], ${age}, ${src}`);
  }
  return out;
}
function showOspfNbrs(s) {
  const dev = s.dev;
  if (!dev.cfg.ospf.on) return ['Note: process currently not running'];
  const nbs = S_(s.world).ospf[dev.id]?.nbrs || [];
  return [` OSPF Process ID ${dev.cfg.ospf.pid} VRF default`, ` Total number of neighbors: ${nbs.length}`, ' Neighbor ID     Pri State            Up Time  Address         Interface', ...nbs.map((n) => ` ${padR(n.rid, 15)} ${padL(n.pri, 3)} ${padR(`${n.state}/${ip2n(n.rid) > ip2n(dev.cfg.ospf.rid || '0.0.0.0') ? 'DR' : 'BDR'}`, 16)} ${upJunos(600).slice(-8)} ${padR(n.ip, 15)} ${sh(dev, n.if)}`)];
}
function showOspfIntBrief(s) {
  const dev = s.dev;
  const S = S_(s.world);
  const list = sortedIfs(dev, (i) => i.ospf?.area != null && i.ip);
  return [` OSPF Process ID ${dev.cfg.ospf.pid} VRF default`, ` Total number of interface: ${list.length}`, ' Interface               ID     Area            Cost   State    Neighbors Status', ...list.map((n, k) => {
    const i = dev.cfg.ifs[n];
    const nb = (S.ospf[dev.id]?.nbrs || []).filter((x) => x.if === n).length;
    return ` ${padR(sh(dev, n), 23)} ${padR(k + 1, 6)} ${padR(i.ospf.area, 15)} ${padR(i.ospf.cost || (i.kind === 'lo' ? 1 : 40), 6)} ${padR(!S.ifs[dev.id][n]?.proto ? 'DOWN' : i.kind === 'lo' ? 'LOOPBACK' : i.ospf.passive ? 'DR' : nb ? 'BDR' : 'DR', 8)} ${padR(nb, 9)} ${S.ifs[dev.id][n]?.proto ? 'up' : 'down'}`;
  })];
}
function showHsrp(s) {
  const dev = s.dev;
  const S = S_(s.world);
  const list = Object.entries(S.fhrp[dev.id] || {});
  return ['*:IPv6 group   #:group belongs to a bundle', '                     P indicates configured to preempt.', '                     |', ' Interface   Grp  Prio P State    Active addr      Standby addr     Group addr', ...list.map(([n, f]) => `  ${padR(n, 11)}${padR(f.grp, 5)}${padR(f.prio, 5)}${f.preempt ? 'P' : ' '} ${padR({ active: 'Active', standby: 'Standby', init: 'Initial' }[f.state], 9)}${padR(f.state === 'active' ? 'local' : f.peers > 1 ? 'remote' : 'unknown', 17)}${padR(f.state === 'standby' ? 'local' : f.peers > 1 ? 'remote' : 'unknown', 17)}${f.vip}      (conf)`)];
}
function showPortChannel(s) {
  const dev = s.dev;
  const S = S_(s.world);
  const sep = '-'.repeat(80);
  const out = ['Flags:  D - Down        P - Up in port-channel (members)', '        I - Individual  H - Hot-standby (LACP only)', '        s - Suspended   r - Module-removed', '        b - BFD Session Wait', '        S - Switched    R - Routed', '        U - Up (port-channel)', '        p - Up in delay-lacp mode (member)', '        M - Not in use. Min-links not met', sep, 'Group Port-       Type     Protocol  Member Ports', '      Channel', sep];
  for (const n of sortedIfs(dev, (i) => i.kind === 'lag')) {
    const i = dev.cfg.ifs[n];
    const L = S.lags[dev.id]?.[n];
    const mem = Object.keys(dev.cfg.ifs).filter((x) => dev.cfg.ifs[x].lag?.id === i.lagId);
    out.push(`${padR(i.lagId, 6)}${padR(`${sh(dev, n)}(${i.sw ? 'S' : 'R'}${L?.up ? 'U' : 'D'})`, 12)}Eth      ${padR(['active', 'passive'].includes(dev.cfg.ifs[mem[0]]?.lag?.mode) ? 'LACP' : 'NONE', 10)}${mem.map((m) => `${sh(dev, m)}(${L?.members[m] || 'D'})`).join('   ')}`);
  }
  return out;
}
function showVersion(s) {
  const dev = s.dev;
  const m = model(dev.model);
  return ['Cisco Nexus Operating System (NX-OS) Software', 'TAC support: http://www.cisco.com/tac', `Copyright (C) 2002-${yearOf(s.world.time.t)}, Cisco and/or its affiliates.`, 'All rights reserved.', '', 'Software', '  BIOS: version 05.45', `  NXOS: version ${dev.version}`, `  NXOS image file is: bootflash:///nxos.${dev.version.replace(/[()]/g, '.')}.bin`, '', 'Hardware', `  cisco ${m.name.replace(/^Cisco /, '')} Chassis`, `  Intel(R) Xeon(R) CPU  @ 2.40GHz with 24631568 kB of memory.`, `  Processor Board ID ${dev.hw.serial}`, '', `  Device name: ${dev.cfg.hostname}`, '  bootflash:   53298520 kB', `Kernel uptime is ${upCisco(uptimeMins(s.world, dev)).replace(/(\d+)w(\d+)d/, '$1 week(s), $2 day(s)').replace(/(\d+)d(\d+)h/, '$1 day(s), $2 hour(s)')}`, '', `Last reset ${dev.run.reloadReason ? 'at ' + fmtDate(dev.run.boot, 'long') : ''}`, `  Reason: ${dev.run.reloadReason || 'Unknown'}`, `  System version: ${dev.version}`];
}
function showLogging(s) {
  const dev = s.dev;
  return dev.run.logs.map((e) => fmtEventNX(e, dev)).filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
export function fmtEventNX(e, dev) {
  const ts = `${fmtDate(e.t, 'iso').slice(0, 4)} ${fmtDate(e.t, 'syslog')} ${dev.cfg.hostname} `;
  switch (e.type) {
    case 'link':
      if (e.kind === 'svi' || e.kind === 'lo') return null;
      if (e.up) return `${ts}%ETHPORT-5-IF_UP: Interface ${e.if} is up in mode ${dev.cfg.ifs[e.if]?.sw ? dev.cfg.ifs[e.if].sw.mode : 'routed'}`;
      return e.admin ? `${ts}%ETHPORT-5-IF_DOWN_ADMIN_DOWN: Interface ${e.if} is down (Administratively down)` : `${ts}%ETHPORT-5-IF_DOWN_LINK_FAILURE: Interface ${e.if} is down (Link failure)`;
    case 'proto':
      return e.kind === 'svi' ? `${ts}%ETHPORT-5-IF_${e.up ? 'UP' : 'DOWN_INTERFACE_REMOVED'}: Interface ${e.if} is ${e.up ? 'up' : 'down (Interface removed)'}` : null;
    case 'errdis':
      return `${ts}%STP-2-BLOCK_BPDUGUARD: Received BPDU on port ${e.if} with BPDU Guard enabled. Disabling port.\n${ts}%ETHPORT-2-IF_DOWN_ERROR_DISABLED: Interface ${e.if} is down (Error disabled. Reason:BPDUGuard)`;
    case 'ospf':
      return `${ts}%OSPF-5-ADJCHANGE:  ospf-${dev.cfg.ospf.pid} [${4000 + (hashStr(dev.id) % 5000)}]  Nbr ${e.nbr} on ${e.if} went ${e.to === 'FULL' ? 'FULL' : 'DOWN'}`;
    case 'ospfErr':
      return `${ts}%OSPF-4-AREA_MISMATCH:  ospf-${dev.cfg.ospf.pid} [${4000 + (hashStr(dev.id) % 5000)}]  Received packet from ${e.from} on ${e.if} with area mismatch`;
    case 'fhrp':
      return `${ts}%HSRP_ENGINE-5-STATECHANGE: Interface ${e.if} Grp ${e.grp} state change from ${e.from} to ${e.to}`.replace(/active/g, 'Active').replace(/standby/g, 'Standby').replace(/init/g, 'Initial');
    case 'lacp':
      return e.state === 's' ? `${ts}%ETH_PORT_CHANNEL-5-PORT_SUSPENDED: ${e.if}: ${e.if} is suspended` : e.state === 'P' ? `${ts}%ETH_PORT_CHANNEL-5-PORT_UP: ${e.lag}: ${e.if} is up` : `${ts}%ETH_PORT_CHANNEL-5-PORT_DOWN: ${e.lag}: ${e.if} is down`;
    case 'config':
      return `${ts}%VSHD-5-VSHD_SYSLOG_CONFIG_I: Configured from vty by ${e.by} on ${e.from || '10.250.0.10'}@pts/0`;
    case 'commit':
      return `${ts}%VSHD-5-VSHD_SYSLOG_CONFIG_I: Configured from vty by ${e.by} on 10.250.0.10@pts/0`;
    case 'login':
      return `${ts}%AUTHPRIV-6-SYSTEMMSG: pam_unix(aaa:session): session opened for user ${e.user} by (uid=0) - dcos_sshd[${3000 + (hashStr(String(e.t)) % 9000)}]`;
    case 'authfail':
      return `${ts}%AUTHPRIV-3-SYSTEMMSG: pam_aaa:Authentication failed for user ${e.user} from ${e.from} - dcos_sshd[${3000 + (hashStr(String(e.t)) % 9000)}]`;
    case 'native':
      return `${ts}%CDP-4-NATIVE_VLAN_MISMATCH: Native VLAN mismatch discovered on ${e.if} (${e.mine}), with ${e.peer} ${e.peerIf} (${e.theirs})`;
    case 'duplex':
      return null;
    case 'macflap':
      return `${ts}%L2FM-2-L2FM_MAC_FLAP_DISABLE_LEARN_N3K: Loops detected in the network for mac ${macCisco(e.mac)} among ports ${sh(dev, e.if1)} and ${sh(dev, e.if2)} vlan ${e.vlan} - Disabling dynamic learning notifications for a period between 120 and 240 seconds on vlan ${e.vlan}`;
    case 'psu':
      return e.ok ? `${ts}%PLATFORM-2-PS_OK: Power supply ${e.n} ok` : `${ts}%PLATFORM-2-PS_FAIL: Power supply ${e.n} failed or shut down (Serial number ${dev.hw.serial.slice(0, 5)}${e.n}A3X)`;
    case 'fan':
      return e.ok ? `${ts}%PLATFORM-5-FAN_STATUS: Fan module ${e.n} current-status is FAN_OK` : `${ts}%PLATFORM-2-FAN_REMOVED: Fan module ${e.n} (Serial number ) Fan${e.n}(sys_fan${e.n}) failed`;
    case 'temp':
      return `${ts}%PLATFORM-1-PFM_ALERT: Temperature sensor 1 on module 1 crossed major threshold ${e.limit}C (current ${e.temp}C)`;
    case 'boot':
      return `${ts}%KERN-0-SYSTEM_MSG: [    0.000000] Initializing cgroup subsys cpuset - kernel\n${ts}%PLATFORM-2-MOD_PWRUP: Module 1 powered up (Serial number ${dev.hw.serial})\n${ts}%VDC_MGR-2-VDC_ONLINE: vdc 1 has come online`;
    case 'bgp':
      return `${ts}%BGP-5-ADJCHANGE:  bgp-${dev.cfg.bgp.asn} [${5000 + (hashStr(dev.id) % 5000)}] (default) neighbor ${e.nbr} ${e.up ? 'Up' : `Down - ${e.why || 'holdtimer expired error'}`}`;
    case 'optic':
      return `${ts}%ETHPORT-3-IF_SFP_ALARM: Interface ${e.if}, Low Rx Power Alarm`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
function nxPing(s, a) {
  const target = a.target;
  if (!isIp(target)) return `% Invalid host/interface ${target}`;
  const count = a.count || 5;
  const size = a.size || 56;
  const p = ping(s, target, { count, size: size + 28, df: a.has('df-bit'), vrf: a.vrf === 'default' ? null : a.vrf || null, src: a.source || null });
  const chunks = [{ d: 10, t: `PING ${target} (${target}): ${size} data bytes\n` }];
  p.res.forEach((x, k) => chunks.push(x.ok ? { d: 200, t: `${size + 8} bytes from ${target}: icmp_seq=${k} ttl=${p.r.toDevice ? 254 : 63} time=${(x.rtt * 0.41).toFixed(3)} ms\n` } : { d: 1200, t: `Request ${k} timed out\n` }));
  chunks.push({ d: 0, t: `\n--- ${target} ping statistics ---\n${count} packets transmitted, ${p.recv} packets received, ${(100 - p.pct).toFixed(2)}% packet loss\n${p.recv ? `round-trip min/avg/max = ${(p.min * 0.41).toFixed(3)}/${(p.avg * 0.41).toFixed(3)}/${(p.max * 0.41).toFixed(3)} ms\n` : ''}` });
  return stream(chunks, { onInterrupt: () => `\n--- ${target} ping statistics ---\n` });
}
function nxTrace(s, a) {
  const { hops } = trace(s, a.target, { vrf: a.vrf || null });
  const chunks = [{ d: 10, t: `traceroute to ${a.target} (${a.target}), 30 hops max, 40 byte packets\n` }];
  let n = 0;
  for (const h of hops) {
    n++;
    if (h.ok) chunks.push({ d: 300, t: ` ${n}  ${h.ip} (${h.ip})  ${(0.6 * n).toFixed(3)} ms  ${(0.7 * n).toFixed(3)} ms  ${(0.5 * n).toFixed(3)} ms\n` });
    else {
      for (let k = n; k < n + 4; k++) chunks.push({ d: 1000, t: ` ${k}  * * *\n` });
      break;
    }
  }
  return stream(chunks);
}

export function makeNXOS() {
  // IOS interface grammar + NX-OS extras
  const base = ifCmds(false).filter((c) => !/^(no )?(standby|vrrp|ip ospf \$num|ip helper|ip nat|encapsulation|clock|duplex auto|ip ospf network)/.test(c.p));
  const nxIf = [
    ...base,
    { p: 'ip address $pfx:pfx', run: (s, a) => {
      const i = cfgOf(s).ifs[s.ctx.if];
      if (i.sw && i.kind === 'phys') return 'ERROR: Ethernet interface is a Layer 2 port, IP address cannot be configured';
      i.ip = a.pfx;
      changed(s);
    } },
    { p: 'ip router ospf $num(1-65535):pid area $word:area', run: (s, a) => {
      const e = need(s, 'ospf');
      if (e) return e;
      const i = cfgOf(s).ifs[s.ctx.if];
      i.ospf = i.ospf || { area: null, cost: null, hello: 10, dead: 40, passive: false };
      i.ospf.area = /^\d+$/.test(a.area) ? n2ip(Number(a.area)) : a.area;
      changed(s);
    } },
    { p: 'no ip router ospf $num(1-65535):pid area $word:area', run: (s) => (cfgOf(s).ifs[s.ctx.if].ospf && (cfgOf(s).ifs[s.ctx.if].ospf.area = null), changed(s)) },
    { p: '[no] ip ospf passive-interface', run: (s, a) => {
      const i = cfgOf(s).ifs[s.ctx.if];
      i.ospf = i.ospf || { area: null, cost: null, hello: 10, dead: 40, passive: false };
      i.ospf.passive = !a.has('no');
      changed(s);
    } },
    { p: 'ip dhcp relay address $ip:ip', run: (s, a) => need(s, 'dhcp') || ((cfgOf(s).ifs[s.ctx.if].helper = [...new Set([...cfgOf(s).ifs[s.ctx.if].helper, a.ip])]), changed(s)) },
    { p: 'no ip dhcp relay address [$ip:ip]', run: (s, a) => ((cfgOf(s).ifs[s.ctx.if].helper = a.ip ? cfgOf(s).ifs[s.ctx.if].helper.filter((x) => x !== a.ip) : []), changed(s)) },
    { p: 'hsrp $num(0-4095):grp', run: (s, a) => {
      const e = need(s, 'hsrp');
      if (e) return e;
      const i = cfgOf(s).ifs[s.ctx.if];
      if (!i.fhrp || i.fhrp.grp !== a.grp) i.fhrp = { proto: 'hsrp', grp: a.grp, vip: null, prio: 100, preempt: false };
      s.ctx.grp = a.grp;
      s.mode = 'hsrp';
    } },
    { p: 'no hsrp $num(0-4095):grp', run: (s) => ((cfgOf(s).ifs[s.ctx.if].fhrp = null), changed(s)) },
    { p: 'spanning-tree port type edge [trunk]', run: (s) => ((cfgOf(s).ifs[s.ctx.if].stp.edge = true), changed(s), 'Warning: Edge port type (portfast) should only be enabled on ports connected to a single\n host. Connecting hubs, concentrators, switches, bridges, etc...  to this\n interface when edge port type (portfast) is enabled, can cause temporary bridging loops.\n Use with CAUTION') },
    { p: 'no spanning-tree port type edge', run: (s) => ((cfgOf(s).ifs[s.ctx.if].stp.edge = false), changed(s)) },
    { p: 'vrf member $word:vrf', run: (s, a) => ((cfgOf(s).ifs[s.ctx.if].vrf = a.vrf === 'default' ? null : a.vrf), (cfgOf(s).ifs[s.ctx.if].ip = null), changed(s), `Warning: Deleted all L3 config on interface ${s.ctx.if}`) },
    { p: 'duplex {full|half|auto}', run: (s, a) => ((cfgOf(s).ifs[s.ctx.if].duplex = a.kw[1]), changed(s)) },
  ];
  const hsrpCmds = [
    { p: 'ip $ip:ip', run: (s, a) => ((cfgOf(s).ifs[s.ctx.if].fhrp.vip = a.ip), changed(s)) },
    { p: 'priority $num(0-255):p', run: (s, a) => ((cfgOf(s).ifs[s.ctx.if].fhrp.prio = a.p), changed(s)) },
    { p: 'no priority', run: (s) => ((cfgOf(s).ifs[s.ctx.if].fhrp.prio = 100), changed(s)) },
    { p: '[no] preempt', run: (s, a) => ((cfgOf(s).ifs[s.ctx.if].fhrp.preempt = !a.has('no')), changed(s)) },
  ];
  const g = globalCfg(true).filter((c) => !/^(no )?(ip domain|ip route|router ospf|router bgp|ip access-list|access-list|spanning-tree mode|banner|crypto|line|ip nat|enable|logging|username)/.test(c.p));
  const nxGlobal = [
    ...g,
    { p: 'feature {ospf|bgp|hsrp|vrrp|lacp|interface-vlan|dhcp|lldp|nxapi|scp-server}', run: (s, a) => {
      const c = cfgOf(s);
      c.features = [...new Set([...(c.features || []), a.kw[1]])];
      changed(s);
    } },
    { p: 'no feature {ospf|bgp|hsrp|vrrp|lacp|interface-vlan|dhcp|lldp|nxapi|scp-server}', run: (s, a) => {
      const c = cfgOf(s);
      const f = a.kw[2];
      c.features = (c.features || []).filter((x) => x !== f);
      if (f === 'ospf') {
        c.ospf.on = false;
        for (const i of Object.values(c.ifs)) i.ospf = null;
      }
      if (f === 'bgp') c.bgp = { on: false, asn: null, rid: null, nbrs: [], nets: [] };
      if (f === 'hsrp' || f === 'vrrp') for (const i of Object.values(c.ifs)) if (i.fhrp?.proto === f) i.fhrp = null;
      if (f === 'interface-vlan') for (const [n, i] of Object.entries(c.ifs)) if (i.kind === 'svi') delete c.ifs[n];
      if (f === 'lacp') for (const i of Object.values(c.ifs)) if (['active', 'passive'].includes(i.lag?.mode)) i.lag = null;
      if (f === 'dhcp') for (const i of Object.values(c.ifs)) i.helper = [];
      changed(s);
    } },
    { p: 'interface $ifc:if', run: (s, a) => {
      const c = cfgOf(s);
      if (!c.ifs[a.if]) {
        const [t, num] = splitIf(a.if);
        if (t === 'Vlan') {
          const e = need(s, 'interface-vlan');
          if (e) return e;
          ensureSvi(s.dev, Number(num));
        } else if (t === 'loopback') c.ifs[a.if] = newIf('lo');
        else if (t === 'port-channel') c.ifs[a.if] = { ...newIf('lag', { lagId: Number(num) }), sw: { mode: 'access', vlan: 1, native: 1, allowed: 'all' } };
        else return "% Invalid command at '^' marker.";
        changed(s);
      }
      s.ctx = { if: a.if };
      s.mode = 'if';
    } },
    { p: 'ip route $pfx:pfx $ip:nh [$num(1-255):ad]', run: (s, a) => {
      const c = cfgOf(s);
      c.static = c.static.filter((r) => !(r.pfx === netPfx(a.pfx) && r.nh === a.nh));
      c.static.push({ pfx: netPfx(a.pfx), nh: a.nh, ad: a.ad || 1 });
      changed(s);
    } },
    { p: 'ip route $pfx:pfx Null0 [$num(1-255):ad]', run: (s, a) => (cfgOf(s).static.push({ pfx: netPfx(a.pfx), nh: null, iface: 'Null0', ad: a.ad || 1 }), changed(s)) },
    { p: 'no ip route $pfx:pfx [$ip:nh]', run: (s, a) => ((cfgOf(s).static = cfgOf(s).static.filter((r) => !(r.pfx === netPfx(a.pfx) && (!a.nh || r.nh === a.nh)))), changed(s)) },
    { p: 'router ospf $word:tag', run: (s, a) => {
      const e = need(s, 'ospf');
      if (e) return e;
      const c = cfgOf(s);
      if (!c.ospf.on) Object.assign(c.ospf, { on: true, pid: Number(a.tag) || 1 }), changed(s);
      s.mode = 'ospf';
    } },
    { p: 'no router ospf $word:tag', run: (s) => ((cfgOf(s).ospf.on = false), changed(s)) },
    { p: 'router bgp $num(1-4294967295):asn', run: (s, a) => {
      const e = need(s, 'bgp');
      if (e) return e;
      const c = cfgOf(s);
      if (c.bgp.on && c.bgp.asn !== a.asn) return `% BGP is already running; AS is ${c.bgp.asn}`;
      if (!c.bgp.on) Object.assign(c.bgp, { on: true, asn: a.asn, nbrs: [], nets: [] }), changed(s);
      s.mode = 'bgp';
    } },
    { p: 'ip access-list $word:name', run: (s, a) => {
      cfgOf(s).acls[a.name] = cfgOf(s).acls[a.name] || [];
      s.ctx = { acl: a.name };
      s.mode = 'acl';
    } },
    { p: 'no ip access-list $word:name', run: (s, a) => (delete cfgOf(s).acls[a.name], changed(s)) },
    { p: 'username $word:name password [$num(0-5):enc] $word:pw [role $word:role]', run: (s, a) => {
      const u = cfgOf(s).svc.users.find((x) => x.name === a.name);
      if (u) u.pw = a.pw;
      else cfgOf(s).svc.users.push({ name: a.name, pw: a.pw, priv: 15 });
      changed(s);
    } },
    { p: '[no] ip domain-lookup', run: (s, a) => ((cfgOf(s).svc.domainLookup = !a.has('no')), changed(s)) },
    { p: 'logging server $ip:ip [$num(0-7):lvl] [use-vrf $word:vrf]', run: (s, a) => (cfgOf(s).svc.syslog.includes(a.ip) ? '' : (cfgOf(s).svc.syslog.push(a.ip), changed(s))) },
    { p: 'vrf context $word:vrf', run: (s, a) => {
      s.ctx = { vrf: a.vrf };
      s.mode = 'vrf';
    } },
    { p: 'spanning-tree mode {rapid-pvst|mst}', run: (s, a) => ((cfgOf(s).stp.mode = a.kw[2]), changed(s)) },
  ];
  const ospf = [
    { p: 'router-id $ip:rid', run: (s, a) => ((cfgOf(s).ospf.rid = a.rid), changed(s)) },
    { p: 'no router-id', run: (s) => ((cfgOf(s).ospf.rid = null), changed(s)) },
    { p: 'default-information originate [always]', run: (s, a) => ((cfgOf(s).ospf.defOrig = true), (cfgOf(s).ospf.always = a.has('always')), changed(s)) },
    { p: 'no default-information originate', run: (s) => ((cfgOf(s).ospf.defOrig = false), changed(s)) },
    { p: 'log-adjacency-changes [detail]', run: () => '' },
    { p: 'auto-cost reference-bandwidth $num:bw [{Gbps|Mbps}]', run: (s, a) => ((cfgOf(s).ospf.ref = a.bw), changed(s)) },
  ];
  const bgp = [
    { p: 'router-id $ip:rid', run: (s, a) => ((cfgOf(s).bgp.rid = a.rid), changed(s)) },
    { p: 'neighbor $ip:ip [remote-as $num(1-4294967295):as]', run: (s, a) => {
      const b = cfgOf(s).bgp;
      let n = b.nbrs.find((x) => x.ip === a.ip);
      if (!n) b.nbrs.push((n = { ip: a.ip, ras: a.as || null, shut: false, desc: '', maxpfx: null }));
      if (a.as) n.ras = a.as;
      changed(s);
      s.ctx = { nbr: a.ip };
      s.mode = 'bgpnbr';
    } },
    { p: 'no neighbor $ip:ip', run: (s, a) => ((cfgOf(s).bgp.nbrs = cfgOf(s).bgp.nbrs.filter((x) => x.ip !== a.ip)), changed(s)) },
    { p: 'address-family ipv4 unicast', run: () => '' },
    { p: 'network $pfx:p', run: (s, a) => (cfgOf(s).bgp.nets.includes(a.p) ? '' : (cfgOf(s).bgp.nets.push(a.p), changed(s))) },
  ];
  const nbrSel = (s) => cfgOf(s).bgp.nbrs.find((x) => x.ip === s.ctx.nbr);
  const bgpNbr = [
    { p: 'remote-as $num(1-4294967295):as', run: (s, a) => ((nbrSel(s).ras = a.as), changed(s)) },
    { p: '[no] shutdown', run: (s, a) => ((nbrSel(s).shut = !a.has('no')), changed(s)) },
    { p: 'description $line:d', run: (s, a) => ((nbrSel(s).desc = a.d), changed(s)) },
    { p: 'address-family ipv4 unicast', run: () => '' },
    { p: 'maximum-prefix $num(1-4294967295):m [warning-only]', run: (s, a) => ((nbrSel(s).maxpfx = a.has('warning-only') ? null : a.m), changed(s)) },
    { p: 'no maximum-prefix', run: (s) => ((nbrSel(s).maxpfx = null), changed(s)) },
  ];
  const vrfCmds = [{ p: 'ip route $pfx:pfx $ip:nh', run: (s, a) => ((cfgOf(s).mgmtGw = { vrf: s.ctx.vrf, ip: a.nh }), changed(s)) }];
  const nxAcl = [
    { p: '[$num(1-4294967295):seq] {permit|deny} $line:rest', run: (s, a) => {
      const words = a.rest.replace(/(\d+\.\d+\.\d+\.\d+)\/(\d+)/g, (m, ip, l) => (l === '32' ? `host ${ip}` : `${ip} ${n2ip(~(0xffffffff << (32 - Number(l))) >>> 0)}`)).split(/\s+/);
      const e = parseAce([a.kw.find((k) => k === 'permit' || k === 'deny'), ...words], false);
      if (!e) return "% Invalid command at '^' marker.";
      cfgOf(s).acls[s.ctx.acl].push(e);
      changed(s);
    } },
    { p: 'no $num(1-4294967295):seq', run: (s, a) => (cfgOf(s).acls[s.ctx.acl].splice(Math.floor(a.seq / 10) - 1, 1), changed(s)) },
    { p: 'statistics per-entry', run: () => '' },
  ];
  const common = [
    { p: 'end', run: (s) => ((s.mode = 'exec'), (s.ctx = {}), configEnded(s), '') },
    { p: 'exit', run: (s) => {
      const up = { config: 'exec', hsrp: 'if', bgpnbr: 'bgp' }[s.mode] || 'config';
      if (up === 'exec') configEnded(s);
      if (up !== 'if' && up !== 'bgp') s.ctx = {};
      s.mode = up;
      return '';
    } },
    { p: 'where', run: (s) => `  conf; ${s.mode === 'if' ? `interface ${s.ctx.if}` : s.mode}      ${s.user}@${s.dev.cfg.hostname}` },
  ];
  const show = [
    { p: 'show version', run: showVersion },
    { p: 'show interface brief', run: showIntBrief },
    { p: 'show interface [$if:if]', run: (s, a) => (a.if ? showIntOne(s, a.if) : sortedIfs(s.dev).flatMap((n) => [...showIntOne(s, n), ''])) },
    { p: 'show interface status [err-disabled]', run: (s, a) => {
      const dev = s.dev;
      const out = ['', '-'.repeat(80), 'Port          Name               Status    Vlan      Duplex  Speed   Type', '-'.repeat(80)];
      for (const n of physIfs(dev).filter((x) => dev.cfg.ifs[x].kind === 'phys')) {
        const i = dev.cfg.ifs[n];
        const w = ifStatusWord(s, dev, n);
        if (a.has('err-disabled') && !w.errd) continue;
        const ds = duplexSpeed(s, dev, n);
        out.push(`${padR(sh(dev, n), 14)}${padR(i.desc.slice(0, 18), 19)}${padR(w.short === 'err-disabled' ? 'errDisabl' : w.short === 'notconnect' ? 'notconnec' : w.short === 'disabled' ? 'disabled' : w.short === 'inactive' ? 'inactive' : w.short === 'suspended' ? 'suspnd' : 'connected', 10)}${padR(!i.sw ? 'routed' : i.sw.mode === 'trunk' ? 'trunk' : i.sw.vlan, 10)}${padR(ds.dup, 8)}${padR(ds.sp, 8)}${(i.hw?.speed || 1000) >= 10000 ? '10Gbase-SR' : '1000base-T'}`);
      }
      return out;
    } },
    { p: 'show interface trunk', run: (s) => {
      const dev = s.dev;
      const S = S_(s.world);
      const tr = sortedIfs(dev, (i, n) => i.sw?.mode === 'trunk' && !i.lag && (S.ifs[dev.id][n]?.up || S.lags[dev.id]?.[n]?.up));
      const sep = '-'.repeat(80);
      return ['', sep, 'Port          Native  Status        Port', '              Vlan                  Channel', sep, ...tr.map((n) => `${padR(sh(dev, n), 14)}${padR(dev.cfg.ifs[n].sw.native ?? 1, 8)}${padR('trunking', 14)}--`), '', sep, 'Port          Vlans Allowed on Trunk', sep, ...tr.map((n) => `${padR(sh(dev, n), 14)}${dev.cfg.ifs[n].sw.allowed === 'all' ? '1-4094' : fmtVlans(dev.cfg.ifs[n].sw.allowed)}`), '', sep, 'Port          STP Forwarding', sep, ...tr.map((n) => {
        const bl = S.stp.blocked[dev.id]?.[n] || new Set();
        const act = (dev.cfg.ifs[n].sw.allowed === 'all' ? Object.keys(dev.cfg.vlans).map(Number) : dev.cfg.ifs[n].sw.allowed.filter((v) => v in dev.cfg.vlans)).filter((v) => !bl.has(v));
        return `${padR(sh(dev, n), 14)}${fmtVlans(act)}`;
      })];
    } },
    { p: 'show interface $if:if transceiver [details]', run: (s, a) => showTransceiver(s, a.if, a.has('details')) },
    { p: 'show interface counters errors', run: (s) => ['', '-'.repeat(80), 'Port          Align-Err    FCS-Err   Xmit-Err    Rcv-Err  UnderSize OutDiscards', '-'.repeat(80), ...physIfs(s.dev).filter((n) => s.dev.cfg.ifs[n].kind === 'phys').map((n) => {
      const c = counters(s.world, s.dev, n);
      return `${padR(sh(s.dev, n), 13)}${padL(Math.floor(c.crc / 7), 10)} ${padL(c.crc, 10)} ${padL(c.outErr, 10)} ${padL(c.inErr, 10)} ${padL(c.runts, 10)} ${padL(Math.floor(c.drops / 5), 11)}`;
    })] },
    { p: 'show ip interface brief [vrf $word:vrf]', run: (s, a) => showIpIntBrief(s, a.vrf) },
    { p: 'show ip route [vrf $word:vrf] [$ipp:ip]', run: (s, a) => showRoute(s, a.vrf === 'default' ? null : a.vrf, a.ip) },
    { p: 'show ip ospf neighbors', run: showOspfNbrs },
    { p: 'show ip ospf interface brief', run: showOspfIntBrief },
    { p: 'show ip ospf', run: (s) => (s.dev.cfg.ospf.on ? [` Routing Process ${s.dev.cfg.ospf.pid} with ID ${s.dev.cfg.ospf.rid || '0.0.0.0'} VRF default`, ' Stateful High Availability enabled', ` Reference Bandwidth is ${s.dev.cfg.ospf.ref * 1000 || 40000} Mbps`, ' Area BACKBONE(0.0.0.0)', `        Area has existed for ${upCisco(uptimeMins(s.world, s.dev))}`, `        Interfaces in this area: ${Object.values(s.dev.cfg.ifs).filter((i) => i.ospf?.area != null).length} Active interfaces: ${Object.values(s.dev.cfg.ifs).filter((i) => i.ospf?.area != null && !i.ospf.passive).length}`] : ['Note: process currently not running']) },
    { p: 'show ip bgp summary', run: (s) => bgpSum(s) },
    { p: 'show bgp ipv4 unicast summary', run: (s) => bgpSum(s) },
    { p: 'show hsrp [brief]', run: showHsrp },
    { p: 'show port-channel summary', run: showPortChannel },
    { p: 'show vlan [brief]', run: (s, a) => showVlan(s, a.has('brief')).filter((l) => !/^100[2-5]/.test(l)) },
    { p: 'show spanning-tree [vlan $num(1-4094):v]', run: (s, a) => showStp(s, a.v) },
    { p: 'show spanning-tree blockedports', run: (s) => showStp(s, null, true) },
    { p: 'show mac address-table [vlan $num(1-4094):vlan] [interface $if:if]', run: (s, a) => showMac(s, a).map((l) => l.replace('Mac Address Table', 'Legend: * - primary entry, G - Gateway MAC, (R) - Routed MAC')) },
    { p: 'show cdp neighbors [detail]', run: (s, a) => showCdp(s, a.has('detail')) },
    { p: 'show lldp neighbors', run: showLldp },
    { p: 'show ip arp [vrf $word:vrf]', run: (s) => ['', 'Flags: * - Adjacencies learnt on non-active FHRP router', '', `IP ARP Table for context default`, 'Address         Age       MAC Address     Interface', ...showArp(s).slice(1).map((l) => {
      const p = l.split(/\s+/);
      return `${padR(p[1], 16)}${padR(p[2] === '-' ? '   -' : `00:0${p[2] % 9}:${String(p[2] % 60).padStart(2, '0')}`, 10)}${padR(p[3], 16)}${sh(s.dev, p[5])}`;
    })] },
    { p: 'show ip access-lists [$word:name]', run: (s) => Object.entries(s.dev.cfg.acls).flatMap(([n, e]) => [`IP access list ${n}`, ...aclLines(n, e, false).map((l, k) => `        ${(k + 1) * 10}${l}`), '']) },
    { p: 'show running-config [all]', run: (s) => running(s) },
    { p: 'show running-config interface $if:if', run: (s, a) => running(s, s.dev.cfg, a.if) },
    { p: 'show startup-config', run: (s) => (s.dev.startup ? running(s, s.dev.startup) : 'No startup configuration') },
    { p: 'show feature', run: (s) => ['Feature Name          Instance  State', '--------------------  --------  --------', ...['bgp', 'dhcp', 'hsrp', 'interface-vlan', 'lacp', 'lldp', 'ospf', 'vrrp'].map((f) => `${padR(f, 22)}${padR(1, 10)}${feats(s.dev.cfg).includes(f) ? 'enabled' : 'disabled'}`)] },
    { p: 'show logging [{logfile|last $num(1-9999):n}]', run: (s, a) => (a.n ? showLogging(s).slice(-a.n) : showLogging(s)) },
    { p: 'show environment [power|fan|temperature]', run: (s) => ['Power Supply:', 'Voltage: 12.0 Volts', 'Power                              Actual        Actual        Total', 'Supply    Model                    Output     Input        Capacity    Status', '-------  -------------------  -----------  -----------  -----------  -----------', ...s.dev.hw.psus.map((ok, k) => `${k + 1}        NXA-PAC-650W-PE         ${ok ? ' 132 W' : '   0 W'}       ${ok ? ' 140 W' : '   0 W'}         650 W    ${ok ? 'Ok' : 'Fail/Shutdown'}`), '', 'Fan:', '---------------------------------------------------------------------------', 'Fan             Model                Hw     Direction       Status', '---------------------------------------------------------------------------', ...s.dev.hw.fans.map((ok, k) => `Fan${k + 1}(sys_fan${k + 1})  NXA-FAN-30CFM-B      --     front-to-back   ${ok ? 'Ok' : 'Failure'}`), '', 'Temperature:', `1        FRONT           80              70          ${Math.round(s.dev.hw.temp)}         ${s.dev.hw.temp > 70 ? 'Major' : 'Ok'}`] },
    { p: 'show module', run: (s) => ['Mod Ports             Module-Type                      Model           Status', '--- ----- ------------------------------------- --------------------- ---------', `1    ${padR(physIfs(s.dev).length, 5)} ${padR(model(s.dev.model).name, 37)} ${padR(s.dev.model.toUpperCase(), 21)} active *`] },
    { p: 'show checkpoint summary', run: (s) => Object.entries(s.dev.run.checkpoints || {}).flatMap(([n, c], k) => [`${k + 1}) ${n}:`, `Created by ${s.user}`, `Created at ${fmtDate(c.t, 'long')}`, `Size is ${JSON.stringify(c.cfg).length} bytes`, '']) },
    { p: 'show clock', run: (s) => `${fmtDate(s.world.time.t, 'clock').replace('UTC ', 'UTC ')}` },
    { p: 'show users', run: (s) => ['NAME     LINE         TIME             IDLE          PID COMMENT', `${padR(s.user, 9)}pts/0        ${fmtDate(s.world.time.t, 'datetime')}   .         ${3000 + (hashStr(s.user) % 9000)} (10.250.0.10) *`] },
    { p: 'show system resources', run: (s) => [`Load average:   1 minute: 0.42   5 minutes: 0.39   15 minutes: 0.38`, `CPU states  :   ${S_(s.world).stormSegs?.size ? '92.11' : '3.21'}% user,   1.12% kernel,   ${S_(s.world).stormSegs?.size ? '6.77' : '95.67'}% idle`, 'Memory usage:   24631568K total,  8434124K used, 16197444K free'] },
  ];
  const exec = [
    ...show,
    { p: 'configure [terminal]', run: (s) => ((s.mode = 'config'), 'Enter configuration commands, one per line. End with CNTL/Z.') },
    { p: 'copy running-config startup-config', run: (s) => {
      saveStartup(s.dev, s.world.time.t);
      return stream([{ d: 300, t: '[#                                       ]   1%\r' }, { d: 600, t: '[########################################] 100%\n' }, { d: 200, t: 'Copy complete, now saving to disk (please wait)...\nCopy complete.\n' }]);
    } },
    { p: 'checkpoint $word:name', run: (s, a) => {
      s.dev.run.checkpoints = s.dev.run.checkpoints || {};
      s.dev.run.checkpoints[a.name] = { t: s.world.time.t, cfg: JSON.parse(JSON.stringify(s.dev.cfg)) };
      return stream([{ d: 900, t: '.......Done\n' }]);
    } },
    { p: 'rollback running-config checkpoint $word:name', run: (s, a) => {
      const cp = s.dev.run.checkpoints?.[a.name];
      if (!cp) return `ERROR: Checkpoint ${a.name} does not exist`;
      s.dev.cfg = JSON.parse(JSON.stringify(cp.cfg));
      changed(s);
      configEnded(s);
      return stream([{ d: 400, t: 'Note: Applying config parallelly may fail Rollback verification\nCollecting Running-Config\n' }, { d: 800, t: '#Generating Rollback Patch\nExecuting Rollback Patch\n' }, { d: 900, t: 'Generating Running-config for verification\nVerification is Successful.\n\nRollback completed successfully.\n' }]);
    } },
    { p: 'reload', run: (s) => doReload(s) },
    { p: 'clear counters [interface $if:if]', run: () => '' },
    { p: 'clear ip ospf neighbor *', run: (s) => ((s.world.lastSnap = null), recompute(s.world), '') },
    { p: 'clear ip bgp *', run: (s) => ((s.world.lastSnap = null), recompute(s.world), '') },
    { p: 'ping $host:target [vrf $word:vrf] [count $num(1-655350):count] [packet-size $num(1-65468):size] [df-bit] [source $ip:source]', run: nxPing },
    { p: 'traceroute $host:target [vrf $word:vrf]', run: nxTrace },
    { p: 'terminal length $num(0-511):n', run: (s, a) => ((s.termLen = a.n), '') },
    { p: 'terminal monitor', run: (s) => ((s.monitor = true), '') },
    { p: '{exit|logout}', run: (s) => ((s.closed = true), '') },
  ];
  const tries = {
    exec: compile(exec, KW),
    config: compile([...nxGlobal, ...common], KW),
    if: compile([...nxIf, ...common], KW),
    hsrp: compile([...hsrpCmds, ...common], KW),
    vlan: compile([{ p: 'name $word:name', run: (s, a) => { for (const v of s.ctx.vlans) cfgOf(s).vlans[v] = a.name; changed(s); } }, ...common], KW),
    ospf: compile([...ospf, ...common], KW),
    bgp: compile([...bgp, ...common], KW),
    bgpnbr: compile([...bgpNbr, ...common], KW),
    vrf: compile([...vrfCmds, ...common], KW),
    acl: compile([...nxAcl, ...common], KW),
  };
  const P = { config: 'config', if: 'config-if', hsrp: 'config-if-hsrp', vlan: 'config-vlan', ospf: 'config-router', bgp: 'config-router', bgpnbr: 'config-router-neighbor', vrf: 'config-vrf', acl: 'config-acl' };
  return {
    id: 'nxos',
    startMode: 'exec',
    pipes: ['include', 'exclude', 'begin', 'section', 'count', 'grep', 'last', 'no-more', 'json', 'head'],
    pipeAlias: { i: 'include', inc: 'include', ex: 'exclude', b: 'begin', sec: 'section' },
    defaultLen: 31,
    more: ' --More-- ',
    consoleLogin: true,
    prompt: (s) => (s.dev.state !== 'up' ? '' : s.mode === 'exec' ? `${s.dev.cfg.hostname}# ` : `${s.dev.cfg.hostname}(${P[s.mode]})# `),
    greeting: (s) => `Cisco Nexus Operating System (NX-OS) Software\nTAC support: http://www.cisco.com/tac\nCopyright (C) 2002-${yearOf(s.world.time.t)}, Cisco and/or its affiliates.\nAll rights reserved.\n`,
    loginPrompt: (dev) => `${dev.cfg.hostname} login: `,
    consoleBanner: (dev) => `\nUser Access Verification\n`,
    telnetBanner: () => '\nUser Access Verification\n',
    closeMsg: (s) => (s.via === 'console' ? '\n[Disconnected from console server]\n' : `Connection to ${s.world.design.mgmt[s.dev.id]} closed.\n`),
    preprocess: (s) => (s.dev.state !== 'up' ? '' : undefined),
    trie: (s, m) => tries[m] || tries.exec,
    fallback: (s) => (['if', 'hsrp', 'vlan', 'ospf', 'bgp', 'bgpnbr', 'vrf', 'acl'].includes(s.mode) ? ['config'] : []),
    matchIf(s, toks, i, create) {
      const v = toks[i].v;
      const tryName = (x) => {
        const m = x.match(/^(e|et|eth|ethernet)(\d.*)$/i);
        if (m) return resolveIf(s.dev, `Ethernet${m[2]}`);
        const lo = x.match(/^(lo|loopback)(\d+)$/i);
        if (lo) return create || s.dev.cfg.ifs[`loopback${lo[2]}`] ? `loopback${lo[2]}` : null;
        const po = x.match(/^(po|port-channel)(\d+)$/i);
        if (po) return create || s.dev.cfg.ifs[`port-channel${po[2]}`] ? `port-channel${po[2]}` : null;
        const vl = x.match(/^(vl|vlan)(\d+)$/i);
        if (vl) return create || s.dev.cfg.ifs[`Vlan${vl[2]}`] ? `Vlan${vl[2]}` : null;
        if (/^mgmt0$/i.test(x)) return 'mgmt0';
        return resolveIf(s.dev, x);
      };
      let r = tryName(v);
      if (r) return { val: r, n: 1 };
      if (/^[A-Za-z-]+$/.test(v) && toks[i + 1] && /^\d/.test(toks[i + 1].v)) {
        r = tryName(v + toks[i + 1].v);
        if (r) return { val: r, n: 2 };
      }
      return null;
    },
    ifTypeHelp: (s, create) => [['ethernet', 'Ethernet IEEE 802.3z'], ['loopback', 'Loopback interface'], ['mgmt', 'Management interface'], ['port-channel', 'Port Channel interface'], ...(create || Object.values(s.dev.cfg.ifs).some((i) => i.kind === 'svi') ? [['vlan', 'Vlan interface']] : [])],
    ifNames: (s) => Object.keys(s.dev.cfg.ifs),
    helpFmt(s, items, cr) {
      const w = Math.max(...items.map(([k]) => k.length), 4) + 2;
      const out = items.map(([k, h]) => `  ${padR(k, w)}${h}`);
      if (cr) out.push('  <CR>');
      return out.join('\n');
    },
    error(s, kind, x) {
      const caret = `${' '.repeat(s.prompt.length + x.pos)}^\n`;
      if (kind === 'ambiguous') return `${caret}% Ambiguous command at '^' marker.`;
      if (kind === 'incomplete') return `${' '.repeat(s.prompt.length + x.line.length)}^\n% Incomplete command at '^' marker.`;
      return `${caret}% Invalid command at '^' marker.`;
    },
    ctrlC: (s) => ((s.mode !== 'exec' ? ((s.mode = 'exec'), configEnded(s)) : 0), '\n'),
    ctrlZ: (s) => ((s.mode = 'exec'), configEnded(s), ''),
    fmtEvent: fmtEventNX,
  };
}
const netPfx = (p) => {
  const c = cidr(p);
  return `${n2ip(c.net)}/${c.len}`;
};
function bgpSum(s) {
  const dev = s.dev;
  if (!dev.cfg.bgp.on) return ['Note: process currently not running'];
  const recs = S_(s.world).bgp[dev.id] || [];
  return [`BGP summary information for VRF default, address family IPv4 Unicast`, `BGP router identifier ${dev.cfg.bgp.rid || '0.0.0.0'}, local AS number ${dev.cfg.bgp.asn}`, `BGP table version is 7, IPv4 Unicast config peers ${recs.length}, capable peers ${recs.filter((r) => r.up).length}`, '', 'Neighbor        V    AS    MsgRcvd    MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd', ...recs.map((r) => `${padR(r.ip, 16)}4 ${padL(r.ras, 5)} ${padL(r.up ? 980 : 0, 10)} ${padL(r.up ? 991 : 0, 10)} ${padL(7, 8)}    0    0 ${padR(r.up ? '1d02h' : 'never', 9)}${r.up ? r.pfx : r.state}`)];
}
void maskStr;
void lenOf;
void unsaved;
void ask;
void OS;
