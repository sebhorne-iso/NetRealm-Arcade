// Cisco IOS / IOS XE (routers + Catalyst switches). Also the base for ArubaOS controller output style.
import { compile, merge, ask, stream } from './engine.js';
import { model, OS, resolveIf, shortIf, splitIf, ifTypesPresent } from '../net/catalog.js';
import { ensureIf, ensureVlan, ensureSvi, ensureLag, newIf, saveStartup, unsaved } from '../net/model.js';
import { S_, cfgOf, changed, configEnded, ping, trace, counters, clearCounters, optics, sortedIfs, physIfs, neighbours, arpTable, macTable, macOfIf, devMac, uptimeMins, ipOnly, lenOf, natCmp } from './common.js';
import { lookup } from '../net/sim.js';
import { reload } from '../net/devops.js';
import { logEvent, recompute } from '../net/events.js';
import { cidr, n2ip, ip2n, maskStr, wildStr, maskLen, isIp, inNet, parseVlans, fmtVlans, vlanIn, fmtDate, upCisco, macCisco, padR, padL, row, yearOf, hashStr, MONTHS } from '../core/util.js';

// ---------------------------------------------------------------------------------------------
export const KW = {
  show: 'Show running system information', configure: 'Enter configuration mode', ping: 'Send echo messages', traceroute: 'Trace route to destination',
  enable: 'Turn on privileged commands', disable: 'Turn off privileged commands', exit: 'Exit from the EXEC', logout: 'Exit from the EXEC', quit: 'Exit from the EXEC',
  copy: 'Copy from one file to another', write: 'Write running configuration to memory, network, or terminal', reload: 'Halt and perform a cold restart',
  clear: 'Reset functions', terminal: 'Set terminal line parameters', debug: "Debugging functions (see also 'undebug')", undebug: "Disable debugging functions (see also 'debug')",
  interfaces: 'Interface status and configuration', ip: 'IP information', 'running-config': 'Current operating configuration', 'startup-config': 'Contents of startup configuration',
  version: 'System hardware and software status', vlan: 'VTP VLAN status', 'spanning-tree': 'Spanning tree topology', etherchannel: 'EtherChannel information',
  standby: 'HSRP information', vrrp: 'VRRP information', logging: 'Show the contents of logging buffers', clock: 'Display the system clock', arp: 'ARP table', mac: 'MAC configuration',
  'address-table': 'MAC forwarding table', cdp: 'CDP information', lldp: 'LLDP information', environment: 'Environmental monitoring', inventory: 'Show the physical inventory',
  processes: 'Active process statistics', 'access-lists': 'List access lists', route: 'IP routing table', ospf: 'OSPF information', bgp: 'BGP information', nat: 'IP NAT information',
  brief: 'Brief summary', status: 'Show interface line status', trunk: 'Show interface trunk information', counters: 'Show interface counters', description: 'Interface specific description',
  transceiver: 'Show interface transceiver', neighbor: 'Neighbor list', neighbors: 'CDP/LLDP neighbor entries', summary: 'Summary of neighbor status', detail: 'Show detailed information',
  interface: 'Select an interface to configure', hostname: "Set system's network name", router: 'Enable a routing process', shutdown: 'Shutdown the selected interface', no: 'Negate a command or set its defaults',
  switchport: 'Set switching mode characteristics', mode: 'Set trunking mode of the interface', access: 'Set access mode characteristics of the interface', allowed: 'Set allowed VLAN characteristics when interface is in trunking mode',
  native: 'Set trunking native characteristics when interface is in trunking mode', speed: 'Configure speed operation.', duplex: 'Configure duplex operation.', address: 'Set the IP address of an interface',
  'helper-address': 'Specify a destination address for UDP broadcasts', 'access-group': 'Specify access control for packets', 'channel-group': 'Etherchannel/port bundling configuration',
  end: 'Exit from configure mode', do: 'To run exec commands in config mode', network: 'Enable routing on an IP network', 'router-id': 'router-id for this OSPF process',
  'passive-interface': 'Suppress routing updates on an interface', 'default-information': 'Control distribution of default information', 'remote-as': 'Specify a BGP neighbor',
  'maximum-prefix': 'Maximum number of prefixes accepted from this peer', mtu: 'Set the interface Maximum Transmission Unit (MTU)', portfast: 'Spanning tree portfast options', bpduguard: "Don't accept BPDUs on this interface",
  errors: 'Show interface error counters', 'access-list': 'Add an access list entry', username: 'Establish User Name Authentication', secret: 'Specify the secret for the user', password: 'Specify the password for the user',
  line: 'Configure a terminal line', transport: 'Define transport protocols for line', input: 'Define which protocols to use when connecting to the terminal server', ntp: 'Configure NTP',
  'snmp-server': 'Modify SNMP engine parameters', banner: 'Define a login banner', encapsulation: 'Set encapsulation type for an interface', helper: 'Specify a destination address for UDP broadcasts',
  priority: 'Priority level', preempt: 'Overthrow lower priority Active routers', name: 'Ascii name of the VLAN', 'hello-interval': 'Time between HELLO packets', 'dead-interval': 'Interval after which a neighbor is declared dead',
  cost: 'Interface cost', area: 'Set the OSPF area ID', archive: 'Archive functions', flash: 'display information about flash: file system', length: 'Set number of lines on a screen', monitor: 'Copy debug output to the current terminal line',
  users: 'Display information about terminal lines', history: 'Display the session command history', interface_: '', protocols: 'IP routing protocol process parameters', translations: 'Translation entries',
  statistics: 'Translation statistics', blockedports: 'Show blocked ports', 'err-disabled': 'Show interfaces in err-disabled state', switchport_: '', dir: 'List files on a filesystem',
  crypto: 'Encryption module', key: 'Long term key operations', generate: 'Generate new keys', rsa: 'Generate RSA keys', 'domain-lookup': 'Enable IP Domain Name System hostname translation',
  domain: 'IP DNS Resolver', lookup: 'Enable IP Domain Name System hostname translation', routing: 'Enable IP routing', default: 'Set a command to its defaults',
};

const CMD_DESC = { phys: 'Ethernet', serial: 'Serial', lo: 'Loopback interface', svi: 'Ethernet SVI', lag: 'EtherChannel', sub: 'Ethernet sub-interface', mgmt: 'Ethernet' };
const isSw = (dev) => model(dev.model).feat.includes('l2');
const hasFeat = (dev, f) => model(dev.model).feat.includes(f);
const areaDec = (a) => (a == null ? '0' : /^\d+$/.test(String(a)) ? String(a) : (() => {
  const n = ip2n(String(a));
  return n < 256 * 256 * 256 ? String(n) : String(a);
})());
const areaDot = (a) => (/^\d+$/.test(String(a)) ? n2ip(Number(a)) : String(a));
const shortType = (dev, n) => shortIf(dev, n);
const SW_MODES = ['access', 'trunk'];
const verMajor = (dev) => Number(String(dev.version).split('.')[0]) || 12;
const hasLocalRoutes = (dev) => dev.os === 'iosxe' || verMajor(dev) >= 15;

// =============================================================================================
// Running configuration
export function aclLines(name, entries, std) {
  const out = [];
  const spec = (x) => (!x || x === 'any' ? 'any' : x.endsWith('/32') ? `host ${x.split('/')[0]}` : `${n2ip(cidr(x).net)} ${wildStr(cidr(x).len)}`);
  for (const e of entries) {
    if (e.remark) {
      out.push(` remark ${e.remark}`);
      continue;
    }
    if (std) out.push(` ${e.act} ${e.src === 'any' ? 'any' : spec(e.src)}`);
    else out.push(` ${e.act} ${e.proto || 'ip'} ${spec(e.src)} ${spec(e.dst)}${e.dport ? ` eq ${portName(e.dport)}` : ''}${e.log ? ' log' : ''}`);
  }
  return out;
}
const PORT_NAMES = { 443: '443', 80: 'www', 22: '22', 23: 'telnet', 53: 'domain', 3306: '3306', 161: 'snmp' };
const portName = (p) => PORT_NAMES[p] || String(p);
const isStdAcl = (name, entries) => /^\d+$/.test(name) ? Number(name) < 100 : entries.every((e) => e.std);

export function runningConfig(s, dev, cfg = dev.cfg, { iface = null } = {}) {
  const W = s.world;
  const xe = dev.os === 'iosxe';
  const L = [];
  const ifBlock = (n) => {
    const i = cfg.ifs[n];
    const b = [`interface ${n}`];
    if (i.desc) b.push(` description ${i.desc}`);
    if (i.kind === 'sub') b.push(` encapsulation dot1Q ${i.vlan}`);
    if (i.vrf && i.mgmt) b.push(xe ? ` vrf forwarding ${i.vrf}` : ` ip vrf forwarding ${i.vrf}`);
    if (i.sw && isSw(dev) && i.kind !== 'svi' && i.kind !== 'lo') {
      if (i.sw.mode === 'trunk') {
        if (['cat3550', 'cat3560', 'cat3750g', 'cat3750x', 'cat6509', 'cat4500x', 'cat6880'].includes(dev.model)) b.push(' switchport trunk encapsulation dot1q');
        if (i.sw.native !== 1 && i.sw.native != null) b.push(` switchport trunk native vlan ${i.sw.native}`);
        if (i.sw.allowed !== 'all') b.push(` switchport trunk allowed vlan ${i.sw.allowed.length ? fmtVlans(i.sw.allowed) : 'none'}`);
        b.push(' switchport mode trunk');
      } else {
        if (i.sw.vlan !== 1) b.push(` switchport access vlan ${i.sw.vlan}`);
        if (i.sw.explicit !== false && (i.sw.vlan !== 1 || i.stp?.edge)) b.push(' switchport mode access');
      }
    } else if (isSw(dev) && ['phys', 'lag'].includes(i.kind) && !i.sw) b.push(' no switchport');
    if (i.ip) b.push(` ip address ${ipOnly(i.ip)} ${maskStr(lenOf(i.ip))}`);
    else if (!i.sw && i.kind !== 'svi' && !(i.kind === 'phys' && i.sw)) {
      if (!(isSw(dev) && i.kind === 'phys' && i.sw)) if (i.kind !== 'lag' || !i.sw) b.push(' no ip address');
    } else if (i.kind === 'svi') b.push(' no ip address');
    for (const h of i.helper || []) b.push(` ip helper-address ${h}`);
    if (i.acl?.in) b.push(` ip access-group ${i.acl.in} in`);
    if (i.acl?.out) b.push(` ip access-group ${i.acl.out} out`);
    if (cfg.nat?.inside?.includes(n)) b.push(' ip nat inside');
    if (cfg.nat?.outside?.includes(n)) b.push(' ip nat outside');
    if (i.ospf && i.ospf.area != null && i.ospf.ifLevel) b.push(` ip ospf ${cfg.ospf.pid} area ${areaDec(i.ospf.area)}`);
    if (i.ospf?.cost) b.push(` ip ospf cost ${i.ospf.cost}`);
    if (i.ospf?.hello && i.ospf.hello !== 10) b.push(` ip ospf hello-interval ${i.ospf.hello}`);
    if (i.ospf?.dead && i.ospf.dead !== 40 && i.ospf.dead !== (i.ospf.hello || 10) * 4) b.push(` ip ospf dead-interval ${i.ospf.dead}`);
    if (i.ospf?.auth) b.push(` ip ospf authentication-key ${i.ospf.auth}`);
    if (i.fhrp) {
      const k = i.fhrp.proto === 'vrrp' ? 'vrrp' : 'standby';
      if (k === 'standby' && i.fhrp.v2 === false) b.push(' standby version 2');
      b.push(` ${k} ${i.fhrp.grp} ip ${i.fhrp.vip}`);
      if (i.fhrp.prio !== 100) b.push(` ${k} ${i.fhrp.grp} priority ${i.fhrp.prio}`);
      if (k === 'standby' && i.fhrp.preempt) b.push(` ${k} ${i.fhrp.grp} preempt`);
      if (k === 'vrrp' && !i.fhrp.preempt) b.push(` no ${k} ${i.fhrp.grp} preempt`);
    }
    if (i.kind === 'serial') {
      if (i.encap && i.encap !== 'hdlc') b.push(` encapsulation ${i.encap}`);
    }
    if (i.mtu && i.mtu !== 1500 && i.kind !== 'svi') b.push(` mtu ${i.mtu}`);
    if (i.kind === 'phys' || i.kind === 'mgmt') {
      if (!isSw(dev) || !i.sw) {
        if (xe && i.kind !== 'serial') {
          if (i.speed !== 'auto') b.push(` speed ${i.speed}`);
          if (i.duplex !== 'auto') b.push(` duplex ${i.duplex}`);
          if (i.speed === 'auto' && i.duplex === 'auto') b.push(' negotiation auto');
        } else {
          b.push(` duplex ${i.duplex}`, ` speed ${i.speed}`);
        }
      } else {
        if (i.speed !== 'auto') b.push(` speed ${i.speed}`);
        if (i.duplex !== 'auto') b.push(` duplex ${i.duplex}`);
      }
    }
    if (i.lag) b.push(` channel-group ${i.lag.id} mode ${i.lag.mode}`);
    if (i.stp?.edge && i.sw) b.push(i.sw.mode === 'trunk' ? ' spanning-tree portfast trunk' : ' spanning-tree portfast');
    if (i.stp?.bpduguard && i.sw) b.push(' spanning-tree bpduguard enable');
    if (!i.on) b.push(' shutdown');
    return b;
  };
  if (iface) return ['Building configuration...', '', `Current configuration : ${ifBlock(iface).join('\n').length + 2} bytes`, '!', ...ifBlock(iface), 'end'];
  const dt = fmtDate(dev.run.lastCfg, 'clock').replace(/\.\d+/, '');
  L.push('!', `! Last configuration change at ${dt} by ${dev.run.lastCfgBy || 'admin'}`);
  if (dev.run.savedAt != null) L.push(`! NVRAM config last updated at ${fmtDate(dev.run.savedAt, 'clock').replace(/\.\d+/, '')} by admin`);
  L.push('!', `version ${String(dev.version).split('(')[0].split('.').slice(0, 2).join('.')}`, 'service timestamps debug datetime msec', 'service timestamps log datetime msec');
  L.push(cfg.svc.encrypt ? 'service password-encryption' : 'no service password-encryption', '!', `hostname ${cfg.hostname}`, '!', 'boot-start-marker', 'boot-end-marker', '!');
  if (cfg.svc.enable) L.push(`enable secret 5 $1$${hashStr(cfg.svc.enable).toString(36).slice(0, 4)}$${hashStr(`e${cfg.svc.enable}`).toString(36)}${hashStr(cfg.svc.enable + 'x').toString(36)}/`, '!');
  L.push('no aaa new-model', '!');
  if (xe && Object.values(cfg.ifs).some((i) => i.vrf === 'Mgmt-vrf')) L.push('vrf definition Mgmt-vrf', ' !', ' address-family ipv4', ' exit-address-family', '!');
  if (cfg.svc.domain) L.push(`ip domain${xe || verMajor(dev) >= 15 ? ' ' : '-'}name ${cfg.svc.domain}`);
  if (!cfg.svc.domainLookup) L.push(xe || verMajor(dev) >= 15 ? 'no ip domain lookup' : 'no ip domain-lookup');
  if (cfg.noRouting) L.push('no ip routing');
  else if (isSw(dev) && hasFeat(dev, 'l3')) L.push('ip routing');
  L.push('!');
  for (const u of cfg.svc.users) L.push(`username ${u.name} privilege ${u.priv} secret 5 $1$${hashStr(u.pw).toString(36).slice(0, 4)}$${hashStr(`u${u.pw}`).toString(36)}${hashStr(u.pw + 'z').toString(36)}.`);
  L.push('!');
  if (isSw(dev)) {
    L.push(`spanning-tree mode ${cfg.stp.mode}`);
    const byPrio = {};
    for (const [v, p] of Object.entries(cfg.stp.prio)) (byPrio[p] = byPrio[p] || []).push(Number(v));
    for (const [p, vl] of Object.entries(byPrio)) L.push(`spanning-tree vlan ${fmtVlans(vl)} priority ${p}`);
    if (cfg.stp.off?.length) L.push(`no spanning-tree vlan ${fmtVlans(cfg.stp.off)}`);
    if (!cfg.stp.on) L.push('no spanning-tree vlan 1-4094');
    L.push('spanning-tree extend system-id', '!');
    for (const v of Object.keys(cfg.vlans).map(Number).sort((a, b) => a - b)) {
      if (v === 1) continue;
      L.push(`vlan ${v}`);
      if (cfg.vlans[v] && cfg.vlans[v] !== `VLAN${String(v).padStart(4, '0')}`) L.push(` name ${cfg.vlans[v]}`);
      L.push('!');
    }
  }
  for (const n of sortedIfs(dev, (i) => true).filter((n) => cfg.ifs[n])) L.push(...ifBlock(n), '!');
  if (cfg.ospf.on) {
    L.push(`router ospf ${cfg.ospf.pid}`);
    if (cfg.ospf.rid) L.push(` router-id ${cfg.ospf.rid}`);
    if (cfg.ospf.ref && cfg.ospf.ref !== 100) L.push(` auto-cost reference-bandwidth ${cfg.ospf.ref}`);
    for (const [n, i] of Object.entries(cfg.ifs)) if (i.ospf?.passive && i.ospf.area != null) L.push(` passive-interface ${n}`);
    for (const [n, i] of Object.entries(cfg.ifs)) if (i.ospf && i.ospf.area != null && !i.ospf.ifLevel && i.ip) L.push(` network ${ipOnly(i.ip)} 0.0.0.0 area ${areaDec(i.ospf.area)}`);
    if (cfg.ospf.defOrig) L.push(` default-information originate${cfg.ospf.always ? ' always' : ''}`);
    L.push('!');
  }
  if (cfg.bgp.on) {
    L.push(`router bgp ${cfg.bgp.asn}`);
    if (cfg.bgp.rid) L.push(` bgp router-id ${cfg.bgp.rid}`);
    L.push(' bgp log-neighbor-changes');
    for (const n of cfg.bgp.nets) L.push(` network ${n2ip(cidr(n).net)} mask ${maskStr(cidr(n).len)}`);
    for (const nb of cfg.bgp.nbrs) {
      L.push(` neighbor ${nb.ip} remote-as ${nb.ras}`);
      if (nb.desc) L.push(` neighbor ${nb.ip} description ${nb.desc}`);
      if (nb.shut) L.push(` neighbor ${nb.ip} shutdown`);
      if (nb.maxpfx) L.push(` neighbor ${nb.ip} maximum-prefix ${nb.maxpfx}`);
    }
    L.push('!');
  }
  if (cfg.nat?.overload && (cfg.nat.inside.length || cfg.nat.outside.length)) L.push(`ip nat inside source list ${cfg.nat.list || 'NAT-INSIDE'} interface ${cfg.nat.outside[0] || 'Null0'} overload`);
  for (const st of cfg.nat?.statics || []) L.push(`ip nat inside source static ${st.int} ${st.ext}`);
  for (const r of cfg.static) {
    const [p, l] = r.pfx.split('/');
    L.push(`ip route ${p} ${maskStr(Number(l))} ${r.iface ? r.iface : ''}${r.iface && r.nh ? ' ' : ''}${r.nh || ''}${r.ad && r.ad !== 1 ? ` ${r.ad}` : ''}${r.vrf ? '' : ''}`.replace(/\s+$/, ''));
  }
  if (cfg.mgmtGw) L.push(`ip route vrf ${cfg.mgmtGw.vrf} 0.0.0.0 0.0.0.0 ${cfg.mgmtGw.ip}`);
  if (cfg.defaultGw) L.push(`ip default-gateway ${cfg.defaultGw}`);
  L.push('!');
  const acls = { ...cfg.acls };
  if (cfg.nat?.overload && !acls[cfg.nat.list || 'NAT-INSIDE']) acls[cfg.nat.list || 'NAT-INSIDE'] = [{ act: 'permit', src: '10.0.0.0/8', std: true }];
  for (const [name, entries] of Object.entries(acls)) {
    const std = isStdAcl(name, entries);
    if (/^\d+$/.test(name)) for (const l of aclLines(name, entries, std)) L.push(`access-list ${name}${l}`);
    else L.push(`ip access-list ${std ? 'standard' : 'extended'} ${name}`, ...aclLines(name, entries, std), '!');
  }
  for (const h of cfg.svc.syslog) L.push(`logging host ${h}`);
  if (cfg.svc.snmp) L.push(`snmp-server community ${cfg.svc.snmp} RO`);
  L.push('!');
  if (cfg.svc.motd) L.push('banner motd ^C', cfg.svc.motd, '^C');
  L.push('!', 'line con 0', ' logging synchronous', 'line vty 0 4', ' login local');
  const ti = cfg.svc.ssh && cfg.svc.telnet ? 'ssh telnet' : cfg.svc.ssh ? 'ssh' : cfg.svc.telnet ? 'telnet' : 'none';
  L.push(` transport input ${ti}`, '!');
  for (const n of cfg.svc.ntp) L.push(`ntp server ${n}`);
  L.push('!', 'end');
  const body = L.join('\n');
  return ['Building configuration...', '', `Current configuration : ${body.length} bytes`, ...L];
}

// =============================================================================================
// show commands
function ifStatusWord(s, dev, n) {
  const S = S_(s.world);
  const st = S.ifs[dev.id][n];
  const ifc = dev.cfg.ifs[n];
  if (!ifc.on) return { st: 'administratively down', pr: 'down', short: 'disabled' };
  if (dev.run.errdis[n]) return { st: 'down', pr: 'down', short: 'err-disabled', errd: true };
  if (!st) return { st: 'down', pr: 'down', short: 'notconnect' };
  if (ifc.sw && ifc.sw.mode === 'access' && !(ifc.sw.vlan in dev.cfg.vlans) && st.up) return { st: 'up', pr: 'down', short: 'inactive' };
  if (ifc.lag && st.up) {
    const lag = Object.keys(dev.cfg.ifs).find((x) => dev.cfg.ifs[x].kind === 'lag' && dev.cfg.ifs[x].lagId === ifc.lag.id);
    const mem = S.lags[dev.id]?.[lag]?.members[n];
    if (mem === 's') return { st: 'up', pr: 'down', short: 'suspended' };
  }
  return { st: st.up ? 'up' : 'down', pr: st.proto ? 'up' : 'down', short: st.up ? 'connected' : 'notconnect' };
}
function showIpIntBrief(s) {
  const dev = s.dev;
  const out = [row(['Interface', 23], ['IP-Address', 16], ['OK?', 4], ['Method', 7], ['Status', 22], ['Protocol'])];
  for (const n of sortedIfs(dev)) {
    const i = dev.cfg.ifs[n];
    const w = ifStatusWord(s, dev, n);
    out.push(row([n, 23], [ipOnly(i.ip) || 'unassigned', 16], ['YES', 4], [i.ip ? (dev.startup?.ifs[n]?.ip === i.ip ? 'NVRAM' : 'manual') : 'unset', 7], [w.st, 22], [w.pr]));
  }
  return out;
}
function mediaType(ifc) {
  const sp = ifc.hw?.speed || 1000;
  const m = ifc.hw?.media || 'rj45';
  if (m === 'serial') return 'Serial';
  if (/sfp|qsfp/.test(m)) return sp >= 100000 ? '100GBase-SR4' : sp >= 40000 ? '40GBase-SR4' : sp >= 25000 ? 'SFP-25GBase-SR' : sp >= 10000 ? 'SFP-10GBase-SR' : '1000BaseSX SFP';
  return sp >= 1000 ? '10/100/1000BaseTX' : sp >= 100 ? '10/100BaseTX' : '10BaseT';
}
function duplexSpeed(s, dev, n) {
  const S = S_(s.world);
  const ifc = dev.cfg.ifs[n];
  const st = S.ifs[dev.id][n];
  const L = st?.link ? S.links[st.link] : null;
  const up = L?.up && ifc.on;
  const dup = ifc.duplex !== 'auto' ? ifc.duplex : up ? (L.duplex === 'mismatch' ? 'half' : 'full') : 'auto';
  const sp = ifc.speed !== 'auto' ? ifc.speed : up ? L.speed : 'auto';
  return { dup, sp, up, auto: ifc.speed === 'auto', autoD: ifc.duplex === 'auto' };
}
function showIntStatus(s, filter) {
  const dev = s.dev;
  const out = ['', row(['Port', 10], ['Name', 19], ['Status', 13], ['Vlan', 11], ['Duplex', 7], ['Speed', 7], ['Type'])];
  for (const n of physIfs(dev).concat(sortedIfs(dev, (i) => i.kind === 'lag'))) {
    const i = dev.cfg.ifs[n];
    if (i.kind === 'mgmt' || i.kind === 'serial') continue;
    const w = ifStatusWord(s, dev, n);
    if (filter === 'err-disabled' && !w.errd) continue;
    const ds = duplexSpeed(s, dev, n);
    const vlan = !i.sw ? 'routed' : i.sw.mode === 'trunk' ? 'trunk' : String(i.sw.vlan);
    const dup = ds.up ? `${ds.autoD ? 'a-' : ''}${ds.dup}` : ds.dup;
    const sp = ds.up ? `${ds.auto ? 'a-' : ''}${ds.sp}` : ds.sp;
    if (filter === 'err-disabled') out.push(row([shortType(dev, n), 10], [i.desc.slice(0, 18), 19], ['err-disabled', 13], [dev.run.errdis[n]]));
    else out.push(row([shortType(dev, n), 10], [i.desc.slice(0, 18), 19], [w.short, 13], [vlan, 11], [padL(dup, 6), 7], [padL(sp, 6), 7], [i.kind === 'lag' ? '' : mediaType(i)]));
  }
  if (filter === 'err-disabled') out[1] = row(['Port', 10], ['Name', 19], ['Status', 13], ['Reason']);
  return out;
}
function showInterfaces(s, n) {
  const dev = s.dev;
  const list = n ? [n] : sortedIfs(dev);
  const out = [];
  for (const x of list) {
    const i = dev.cfg.ifs[x];
    if (!i) continue;
    const w = ifStatusWord(s, dev, x);
    const c = counters(s.world, dev, x);
    const ds = duplexSpeed(s, dev, x);
    const tag = isSw(dev) && (i.kind === 'phys' || i.kind === 'lag') ? ` (${w.short})` : '';
    out.push(`${x} is ${w.st}, line protocol is ${w.pr}${tag}`);
    const mac = macCisco(macOfIf(dev, x));
    const hwName = i.kind === 'serial' ? 'HD64570' : i.kind === 'lo' ? 'Loopback' : i.kind === 'svi' ? 'Ethernet SVI' : i.kind === 'lag' ? 'EtherChannel' : (i.hw?.speed || 1000) >= 10000 ? 'Ten Gigabit Ethernet' : (i.hw?.speed || 1000) >= 1000 ? 'Gigabit Ethernet' : (i.hw?.speed || 100) >= 100 ? 'Fast Ethernet' : 'Lance';
    out.push(i.kind === 'lo' || i.kind === 'serial' ? `  Hardware is ${hwName}` : `  Hardware is ${hwName}, address is ${mac} (bia ${mac})`);
    if (i.desc) out.push(`  Description: ${i.desc}`);
    if (i.ip) out.push(`  Internet address is ${i.ip}`);
    const bw = i.kind === 'lo' ? 8000000 : i.kind === 'serial' ? 1544 : (ds.up ? Number(ds.sp) : i.hw?.speed || 1000) * 1000;
    out.push(`  MTU ${i.kind === 'lo' ? 1514 : i.mtu || 1500} bytes, BW ${bw} Kbit/sec, DLY ${i.kind === 'lo' ? 5000 : 10} usec,`);
    const load = Math.min(255, Math.max(1, Math.round(((c.rateIn || 0) / (bw * 1000)) * 255)));
    out.push(`     reliability ${c.crc ? Math.max(180, 255 - Math.min(75, Math.floor(c.crc / 50))) : 255}/255, txload ${Math.max(1, Math.round(load * 0.6))}/255, rxload ${load}/255`);
    if (i.kind === 'serial') out.push(`  Encapsulation ${(i.encap || 'hdlc').toUpperCase()}, loopback not set`, '  Keepalive set (10 sec)');
    else if (i.kind !== 'lo') out.push('  Encapsulation ARPA, loopback not set', '  Keepalive set (10 sec)');
    if (i.kind === 'phys' || i.kind === 'mgmt') out.push(`  ${ds.dup === 'auto' ? 'Auto-duplex' : ds.dup === 'half' ? 'Half-duplex' : 'Full-duplex'}, ${ds.sp === 'auto' ? 'Auto-speed' : `${ds.sp}Mb/s`}, media type is ${mediaType(i)}`);
    if (i.kind === 'lag') {
      const mem = Object.entries(S_(s.world).lags[dev.id]?.[x]?.members || {});
      out.push(`  Members in this channel: ${mem.filter(([, st]) => st === 'P').map(([m]) => shortType(dev, m)).join(' ') || 'none'}`);
    }
    out.push('  ARP type: ARPA, ARP Timeout 04:00:00');
    out.push(`  Last input ${w.pr === 'up' ? '00:00:00' : 'never'}, output ${w.pr === 'up' ? '00:00:00' : 'never'}, output hang never`);
    out.push(`  Last clearing of "show interface" counters ${c.lastClear > dev.run.boot ? upCisco(s.world.time.t - c.lastClear) : 'never'}`);
    out.push(`  Input queue: 0/75/${c.drops}/0 (size/max/drops/flushes); Total output drops: ${Math.floor(c.drops / 3)}`);
    out.push('  Queueing strategy: fifo', '  Output queue: 0/40 (size/max)');
    out.push(`  5 minute input rate ${c.rateIn} bits/sec, ${c.ppsIn} packets/sec`, `  5 minute output rate ${c.rateOut} bits/sec, ${c.ppsOut} packets/sec`);
    out.push(`     ${c.inP} packets input, ${c.inB} bytes, 0 no buffer`, `     Received ${c.bcast} broadcasts (${c.inMc} multicasts)`);
    out.push(`     ${c.runts} runts, 0 giants, 0 throttles`, `     ${c.inErr} input errors, ${c.crc} CRC, ${Math.floor(c.crc / 4)} frame, 0 overrun, 0 ignored`);
    out.push(`     0 watchdog, ${c.inMc} multicast, 0 pause input`, '     0 input packets with dribble condition detected');
    out.push(`     ${c.outP} packets output, ${c.outB} bytes, 0 underruns`, `     ${c.outErr} output errors, ${c.coll} collisions, ${c.resets + 1} interface resets`);
    out.push('     0 unknown protocol drops', `     0 babbles, ${c.late} late collision, ${Math.floor(c.coll / 2)} deferred`);
    out.push(`     0 lost carrier, ${w.st === 'up' ? 0 : 1} no carrier, 0 pause output`, '     0 output buffer failures, 0 output buffers swapped out');
  }
  return out;
}
function showIntTrunk(s) {
  const dev = s.dev;
  const S = S_(s.world);
  const trunks = sortedIfs(dev, (i, n) => i.sw?.mode === 'trunk' && !i.lag && (S.ifs[dev.id][n]?.up || S.lags[dev.id]?.[n]?.up));
  if (!trunks.length) return [''];
  const enc = ['cat3550', 'cat3560', 'cat3750g', 'cat3750x', 'cat6509'].includes(dev.model) ? '802.1q' : '802.1q';
  const allowed = (n) => (dev.cfg.ifs[n].sw.allowed === 'all' ? '1-4094' : fmtVlans(dev.cfg.ifs[n].sw.allowed));
  const active = (n) => {
    const a = dev.cfg.ifs[n].sw.allowed === 'all' ? Object.keys(dev.cfg.vlans).map(Number) : dev.cfg.ifs[n].sw.allowed.filter((v) => v in dev.cfg.vlans);
    return a.sort((x, y) => x - y);
  };
  const out = ['', row(['Port', 12], ['Mode', 17], ['Encapsulation', 15], ['Status', 14], ['Native vlan'])];
  for (const n of trunks) out.push(row([shortType(dev, n), 12], ['on', 17], [enc, 15], ['trunking', 14], [String(dev.cfg.ifs[n].sw.native ?? 1)]));
  out.push('', row(['Port', 12], ['Vlans allowed on trunk']));
  for (const n of trunks) out.push(row([shortType(dev, n), 12], [allowed(n)]));
  out.push('', row(['Port', 12], ['Vlans allowed and active in management domain']));
  for (const n of trunks) out.push(row([shortType(dev, n), 12], [fmtVlans(active(n))]));
  out.push('', row(['Port', 12], ['Vlans in spanning tree forwarding state and not pruned']));
  for (const n of trunks) {
    const bl = S.stp.blocked[dev.id]?.[n] || new Set();
    out.push(row([shortType(dev, n), 12], [fmtVlans(active(n).filter((v) => !bl.has(v)))]));
  }
  return out;
}
function showSwitchport(s, n) {
  const dev = s.dev;
  const i = dev.cfg.ifs[n];
  if (!i.sw) return [`Name: ${shortType(dev, n)}`, 'Switchport: Disabled'];
  const op = i.sw.mode === 'trunk' ? 'trunk' : 'static access';
  return [
    `Name: ${shortType(dev, n)}`, 'Switchport: Enabled', `Administrative Mode: ${i.sw.mode === 'trunk' ? 'trunk' : 'static access'}`, `Operational Mode: ${S_(s.world).ifs[dev.id][n]?.up ? op : 'down'}`,
    'Administrative Trunking Encapsulation: dot1q', `Operational Trunking Encapsulation: ${i.sw.mode === 'trunk' ? 'dot1q' : 'native'}`, 'Negotiation of Trunking: Off',
    `Access Mode VLAN: ${i.sw.vlan} (${dev.cfg.vlans[i.sw.vlan] ?? 'Inactive'})`, `Trunking Native Mode VLAN: ${i.sw.native ?? 1} (${dev.cfg.vlans[i.sw.native ?? 1] ?? 'Inactive'})`,
    'Administrative Native VLAN tagging: enabled', 'Voice VLAN: none', `Trunking VLANs Enabled: ${i.sw.allowed === 'all' ? 'ALL' : fmtVlans(i.sw.allowed)}`, 'Pruning VLANs Enabled: 2-1001', 'Capture Mode Disabled',
    'Protected: false', 'Unknown unicast blocked: disabled', 'Unknown multicast blocked: disabled', 'Appliance trust: none',
  ];
}
function showIntDesc(s) {
  const dev = s.dev;
  const out = [row(['Interface', 31], ['Status', 15], ['Protocol', 9], ['Description'])];
  for (const n of sortedIfs(dev)) {
    const w = ifStatusWord(s, dev, n);
    out.push(row([shortType(dev, n), 31], [w.st === 'administratively down' ? 'admin down' : w.st, 15], [w.pr, 9], [dev.cfg.ifs[n].desc]));
  }
  return out;
}
function showCountersErrors(s) {
  const dev = s.dev;
  const out = ['', row(['Port', 11], ['Align-Err', 14], ['FCS-Err', 14], ['Xmit-Err', 14], ['Rcv-Err', 14], ['UnderSize', 12], ['OutDiscards'])];
  for (const n of physIfs(dev)) {
    if (dev.cfg.ifs[n].kind !== 'phys') continue;
    const c = counters(s.world, dev, n);
    out.push(row([shortType(dev, n), 11], [padL(Math.floor(c.crc / 7), 10), 14], [padL(c.crc, 10), 14], [padL(c.outErr, 10), 14], [padL(c.inErr, 10), 14], [padL(c.runts, 10), 12], [padL(Math.floor(c.drops / 5), 12)]));
  }
  out.push('', row(['Port', 11], ['Single-Col', 11], ['Multi-Col', 11], ['Late-Col', 11], ['Excess-Col', 11], ['Carri-Sen', 11], ['Runts', 11], ['Giants']));
  for (const n of physIfs(dev)) {
    if (dev.cfg.ifs[n].kind !== 'phys') continue;
    const c = counters(s.world, dev, n);
    out.push(row([shortType(dev, n), 11], [padL(Math.floor(c.coll * 0.7), 10), 11], [padL(Math.floor(c.coll * 0.3), 10), 11], [padL(c.late, 10), 11], [padL(0, 10), 11], [padL(0, 10), 11], [padL(c.runts, 10), 11], [padL(0, 10)]));
  }
  return out;
}
function showTransceiver(s, n, detail) {
  const dev = s.dev;
  const list = n ? [n] : physIfs(dev);
  const rows = [];
  for (const x of list) {
    const o = optics(dev, x);
    if (o) rows.push([x, o]);
  }
  if (!rows.length) return n ? [`% No transceiver is present on ${n}`] : [''];
  const flag = (v, hi, lo) => (v >= hi ? '++' : v <= lo ? '--' : '  ');
  const out = ['If device is externally calibrated, only calibrated values are printed.', '++ : high alarm, +  : high warning, -  : low warning, -- : low alarm.', 'NA or N/A: not applicable, Tx: transmit, Rx: receive.', 'mA: milliamperes, dBm: decibels (milliwatts).', ''];
  out.push('                                 Optical   Optical', '           Temperature  Voltage  Tx Power  Rx Power', 'Port       (Celsius)    (Volts)  (dBm)     (dBm)', '---------  -----------  -------  --------  --------');
  for (const [x, o] of rows) out.push(row([shortType(dev, x), 11], [padL(o.temp.toFixed(1), 9), 13], [padL(o.volt.toFixed(2), 7), 9], [padL(o.tx.toFixed(1), 6), 10], [`${padL(o.rx <= -40 ? '-40.0' : o.rx.toFixed(1), 6)} ${flag(-o.rx, 14, -99).trim() ? '--' : o.rx < -10.5 ? '- ' : ''}`]));
  if (detail) {
    out.push('', '                                High Alarm  High Warn  Low Warn   Low Alarm', '           Rx Power             Threshold   Threshold  Threshold  Threshold', 'Port       (dBm)                (dBm)       (dBm)      (dBm)      (dBm)', '---------  -----------------    ----------  ---------  ---------  ---------');
    for (const [x, o] of rows) out.push(row([shortType(dev, x), 11], [padL(o.rx <= -40 ? '-40.0' : o.rx.toFixed(1), 8), 21], [padL('1.0', 9), 12], [padL('-1.0', 8), 11], [padL('-10.5', 8), 11], [padL('-14.0', 8)]));
  }
  return out;
}

// ----- routing -----
const PROTO_CODE = { connected: 'C', local: 'L', static: 'S', ospf: 'O', ospfE: 'O E2', ebgp: 'B', ibgp: 'B' };
function routeLine(s, r) {
  const dev = s.dev;
  const age = upCisco((s.world.time.t - dev.run.boot) % 20000);
  const code = r.pfx === '0.0.0.0/0' ? PROTO_CODE[r.proto].replace(/^(\w)/, '$1*').replace('* ', '*') : PROTO_CODE[r.proto];
  if (r.proto === 'connected') return `${padR(code, 9)}${r.pfx} is directly connected, ${r.oif}`;
  if (r.proto === 'local') return `${padR(code, 9)}${r.pfx} is directly connected, ${r.oif}`;
  if (r.discard) return `${padR(code, 9)}${r.pfx} is directly connected, Null0`;
  if (r.proto === 'static') return `${padR(code, 9)}${r.pfx} [${r.ad}/0] via ${r.nh}`;
  const hops = r.ecmp || [{ nh: r.nh, oif: r.oif }];
  const lines = [`${padR(code, 9)}${r.pfx} [${r.ad}/${r.metric}] via ${hops[0].nh}, ${age}${r.proto.startsWith('ospf') ? `, ${hops[0].oif}` : ''}`];
  for (const h of hops.slice(1)) lines.push(`${' '.repeat(9 + r.pfx.length)} [${r.ad}/${r.metric}] via ${h.nh}, ${age}, ${h.oif}`);
  return lines.join('\n');
}
function showIpRoute(s, a) {
  const dev = s.dev;
  const S = S_(s.world);
  const vrf = a.vrf || null;
  const rib = (S.rib[dev.id]?.best || []).filter((r) => (r.vrf || null) === vrf && (hasLocalRoutes(dev) || r.proto !== 'local'));
  let list = rib;
  if (a.proto) list = rib.filter((r) => (a.proto === 'connected' ? ['connected', 'local'].includes(r.proto) : a.proto === 'ospf' ? r.proto.startsWith('ospf') : a.proto === 'bgp' ? r.proto.endsWith('bgp') : r.proto === a.proto));
  if (a.ip) {
    const r = lookup(s.world, dev, a.ip, vrf);
    if (!r) return ['% Network not in table'];
    const via = r.nh ? `  * ${r.nh}${r.proto.startsWith('ospf') ? `, from ${r.nh}, ${upCisco(60)} ago, via ${r.oif}` : ''}` : `  * directly connected, via ${r.oif}`;
    return [`Routing entry for ${r.pfx}`, `  Known via "${r.proto.startsWith('ospf') ? `ospf ${dev.cfg.ospf.pid}` : r.proto === 'ebgp' ? `bgp ${dev.cfg.bgp.asn}` : r.proto}", distance ${r.ad}, metric ${r.metric}${r.pfx === '0.0.0.0/0' ? ', candidate default path' : ''}`, '  Routing Descriptor Blocks:', via, `      Route metric is ${r.metric}, traffic share count is 1`];
  }
  const out = [];
  if (!a.proto) {
    out.push('Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP', '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area', '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2', '       E1 - OSPF external type 1, E2 - OSPF external type 2', '       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2', '       ia - IS-IS inter area, * - candidate default, U - per-user static route', '       o - ODR, P - periodic downloaded static route, H - NHRP, l - LISP', '       + - replicated route, % - next hop override', '');
    const def = rib.find((r) => r.pfx === '0.0.0.0/0');
    out.push(def ? `Gateway of last resort is ${def.nh || '0.0.0.0'} to network 0.0.0.0` : 'Gateway of last resort is not set', '');
  }
  // group by classful major network
  const major = (p) => {
    const o = Number(p.split('.')[0]);
    const n = ip2n(p.split('/')[0]);
    const len = o < 128 ? 8 : o < 192 ? 16 : 24;
    return `${n2ip((n & (0xffffffff << (32 - len))) >>> 0)}/${len}`;
  };
  const groups = new Map();
  for (const r of list) {
    const m = r.pfx === '0.0.0.0/0' ? '0' : major(r.pfx);
    if (!groups.has(m)) groups.set(m, []);
    groups.get(m).push(r);
  }
  for (const [m, rs] of groups) {
    if (m !== '0' && !(rs.length === 1 && rs[0].pfx === m)) {
      const masks = new Set(rs.map((r) => r.pfx.split('/')[1]));
      out.push(masks.size > 1 ? `      ${m} is variably subnetted, ${rs.length} subnets, ${masks.size} masks` : `      ${m} is subnetted, ${rs.length} subnets`);
    }
    for (const r of rs) out.push(routeLine(s, r));
  }
  return out;
}
function ospfRole(s, nb) {
  const mine = S_(s.world).ospf[s.dev.id];
  void mine;
  const myRid = s.dev.cfg.ospf.rid || '0.0.0.0';
  return ip2n(nb.rid || '0.0.0.0') > ip2n(myRid) ? 'DR' : 'BDR';
}
function showOspfNbr(s) {
  const o = S_(s.world).ospf[s.dev.id];
  const out = ['', row(['Neighbor ID', 16], ['Pri', 6], ['State', 16], ['Dead Time', 12], ['Address', 16], ['Interface'])];
  if (!s.dev.cfg.ospf.on) return [''];
  for (const nb of o?.nbrs || []) out.push(row([nb.rid, 16], [padL(nb.pri, 3), 6], [`${nb.state}/${ospfRole(s, nb)}`, 16], [`00:00:${String(30 + (hashStr(nb.rid + s.world.time.t) % 10)).padStart(2, '0')}`, 12], [nb.ip, 16], [nb.if]));
  return out;
}
function showOspfInt(s, brief) {
  const dev = s.dev;
  const S = S_(s.world);
  if (!dev.cfg.ospf.on) return [''];
  const list = sortedIfs(dev, (i) => i.ospf && i.ospf.area != null && i.ip);
  if (brief) {
    const out = [row(['Interface', 11], ['PID', 6], ['Area', 16], ['IP Address/Mask', 19], ['Cost', 6], ['State', 6], ['Nbrs F/C'])];
    for (const n of list) {
      const i = dev.cfg.ifs[n];
      const nb = (S.ospf[dev.id]?.nbrs || []).filter((x) => x.if === n);
      const up = S.ifs[dev.id][n]?.proto;
      out.push(row([shortType(dev, n), 11], [dev.cfg.ospf.pid, 6], [areaDec(i.ospf.area), 16], [i.ip, 19], [i.ospf.cost || (i.kind === 'lo' ? 1 : 1), 6], [!up ? 'DOWN' : i.kind === 'lo' ? 'LOOP' : nb.length ? 'DR' : 'DR', 6], [`${nb.filter((x) => x.state === 'FULL').length}/${nb.length}`]));
    }
    return out;
  }
  const out = [];
  for (const n of list) {
    const i = dev.cfg.ifs[n];
    const up = S.ifs[dev.id][n]?.proto;
    const nb = (S.ospf[dev.id]?.nbrs || []).filter((x) => x.if === n);
    out.push(`${n} is ${up ? 'up' : 'down'}, line protocol is ${up ? 'up' : 'down'}`, `  Internet Address ${i.ip}, Area ${areaDec(i.ospf.area)}, Attached via Network Statement`, `  Process ID ${dev.cfg.ospf.pid}, Router ID ${dev.cfg.ospf.rid || '0.0.0.0'}, Network Type ${i.kind === 'lo' ? 'LOOPBACK' : 'BROADCAST'}, Cost: ${i.ospf.cost || 1}`);
    if (i.kind !== 'lo') {
      out.push(`  Timer intervals configured, Hello ${i.ospf.hello || 10}, Dead ${i.ospf.dead || 40}, Wait ${i.ospf.dead || 40}, Retransmit 5`);
      if (i.ospf.passive) out.push('    No Hellos (Passive interface)');
      else out.push(`    Hello due in 00:00:0${hashStr(n) % 9}`);
      out.push(`  Neighbor Count is ${nb.length}, Adjacent neighbor count is ${nb.filter((x) => x.state === 'FULL').length}`);
      for (const x of nb.filter((y) => y.state === 'FULL')) out.push(`    Adjacent with neighbor ${x.rid}  (Designated Router)`);
    } else out.push('  Loopback interface is treated as a stub Host');
  }
  return out;
}
function showBgpSum(s) {
  const dev = s.dev;
  const b = dev.cfg.bgp;
  if (!b.on) return ['% BGP not active'];
  const S = S_(s.world);
  const recs = S.bgp[dev.id] || [];
  const up = upCisco(Math.min(20000, s.world.time.t - dev.run.boot));
  const pfx = recs.reduce((a, r) => a + (r.up ? r.pfx : 0), 0) + b.nets.length;
  const out = [`BGP router identifier ${b.rid || '0.0.0.0'}, local AS number ${b.asn}`, `BGP table version is ${pfx + 3}, main routing table version ${pfx + 3}`, `${pfx} network entries using ${pfx * 248} bytes of memory`, `${pfx} path entries using ${pfx * 136} bytes of memory`, '', row(['Neighbor', 16], ['V', 12], ['AS', 0]).replace(/AS$/, '') + padL('AS', 0)];
  out.length = 4;
  out.push('', 'Neighbor        V           AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd');
  for (const r of recs) {
    const st = r.up ? padL(r.pfx, 12) : padL(r.state, 12);
    out.push(`${padR(r.ip, 16)}4 ${padL(r.ras, 12)} ${padL(r.up ? 1200 + (hashStr(r.ip) % 900) : 0, 7)} ${padL(r.up ? 1210 + (hashStr(r.ip) % 800) : 0, 7)} ${padL(r.up ? pfx + 3 : 1, 8)}    0    0 ${padR(r.up ? up : 'never', 8)}${st}`);
  }
  return out;
}
function showBgp(s) {
  const dev = s.dev;
  if (!dev.cfg.bgp.on) return ['% BGP not active'];
  const S = S_(s.world);
  const out = [`BGP table version is 5, local router ID is ${dev.cfg.bgp.rid || '0.0.0.0'}`, 'Status codes: s suppressed, d damped, h history, * valid, > best, i - internal,', '              r RIB-failure, S Stale, m multipath, b backup-path, f RT-Filter,', '              x best-external, a additional-path, c RIB-compressed,', 'Origin codes: i - IGP, e - EGP, ? - incomplete', 'RPKI validation codes: V valid, I invalid, N Not found', '', '     Network          Next Hop            Metric LocPrf Weight Path'];
  for (const r of S.bgp[dev.id] || []) if (r.up) out.push(` *>  0.0.0.0          ${padR(r.ip, 20)}     0             0 ${r.ras} i`);
  for (const n of dev.cfg.bgp.nets) {
    const inRib = S.rib[dev.id].best.some((r) => r.pfx === n && !r.proto.endsWith('bgp'));
    out.push(`${inRib ? ' *>' : '   '}  ${padR(n, 17)}0.0.0.0                  0         32768 i`);
  }
  return out;
}
function showIpProtocols(s) {
  const dev = s.dev;
  const out = ['*** IP Routing is NSF aware ***', ''];
  if (dev.cfg.ospf.on) {
    out.push(`Routing Protocol is "ospf ${dev.cfg.ospf.pid}"`, '  Outgoing update filter list for all interfaces is not set', '  Incoming update filter list for all interfaces is not set', `  Router ID ${dev.cfg.ospf.rid || '0.0.0.0'}`, '  Number of areas in this router is 1. 1 normal 0 stub 0 nssa', '  Maximum path: 4', '  Routing for Networks:');
    for (const i of Object.values(dev.cfg.ifs)) if (i.ospf?.area != null && i.ip) out.push(`    ${ipOnly(i.ip)} 0.0.0.0 area ${areaDec(i.ospf.area)}`);
    const pas = Object.entries(dev.cfg.ifs).filter(([, i]) => i.ospf?.passive);
    if (pas.length) out.push('  Passive Interface(s):', ...pas.map(([n]) => `    ${n}`));
    out.push('  Routing Information Sources:', '    Gateway         Distance      Last Update');
    for (const nb of S_(s.world).ospf[dev.id]?.nbrs || []) out.push(`    ${padR(nb.rid, 16)}${padL(110, 8)}      00:0${hashStr(nb.rid) % 9}:12`);
    out.push('  Distance: (default is 110)', '');
  }
  if (dev.cfg.bgp.on) out.push(`Routing Protocol is "bgp ${dev.cfg.bgp.asn}"`, '  Outgoing update filter list for all interfaces is not set', '  IGP synchronization is disabled', '  Automatic route summarization is disabled', '  Neighbor(s):', '    Address          FiltIn FiltOut DistIn DistOut Weight RouteMap', ...dev.cfg.bgp.nbrs.map((n) => `    ${n.ip}`), '  Maximum path: 1', '  Distance: external 20 internal 200 local 200', '');
  return out;
}

// ----- switching -----
function showVlan(s, brief) {
  const dev = s.dev;
  const out = ['', row(['VLAN', 5], ['Name', 33], ['Status', 10], ['Ports']), '---- -------------------------------- --------- -------------------------------'];
  const ports = (v) => physIfs(dev).filter((n) => {
    const i = dev.cfg.ifs[n];
    return i.sw && i.sw.mode === 'access' && i.sw.vlan === v && !i.lag;
  }).map((n) => shortType(dev, n));
  for (const v of Object.keys(dev.cfg.vlans).map(Number).sort((a, b) => a - b)) {
    const p = ports(v);
    const chunks = [];
    for (let i = 0; i < p.length; i += 4) chunks.push(p.slice(i, i + 4).join(', '));
    out.push(row([v, 5], [dev.cfg.vlans[v], 33], ['active', 10], [chunks[0] || '']));
    for (const c of chunks.slice(1)) out.push(`${' '.repeat(48)}${c}`);
  }
  out.push(row([1002, 5], ['fddi-default', 33], ['act/unsup', 10], ['']), row([1003, 5], ['token-ring-default', 33], ['act/unsup', 10], ['']), row([1004, 5], ['fddinet-default', 33], ['act/unsup', 10], ['']), row([1005, 5], ['trnet-default', 33], ['act/unsup', 10], ['']));
  if (!brief) out.push('', 'VLAN Type  SAID       MTU   Parent RingNo BridgeNo Stp  BrdgMode Trans1 Trans2', '---- ----- ---------- ----- ------ ------ -------- ---- -------- ------ ------', ...Object.keys(dev.cfg.vlans).map((v) => `${padR(v, 5)}enet  ${padR(100000 + Number(v), 11)}1500  -      -      -        -    -        0      0`));
  return out;
}
export function stpInfo(s, dev, v) {
  const S = S_(s.world);
  const key = Object.keys(S.stp.root).find((k) => k.startsWith(`${v}|`) && k.split('|')[1].split(',').includes(`${dev.id}#${v}`));
  const rootId = key ? S.stp.root[key] : dev.id;
  return { root: s.world.devices[rootId], isRoot: rootId === dev.id, rootPort: S.stp.rootPort[dev.id]?.[v] || null };
}
function showStp(s, vlanArg, blockedOnly) {
  const dev = s.dev;
  const S = S_(s.world);
  const out = [];
  if (!dev.cfg.stp.on) return ['No spanning tree instances exist.'];
  const vlans = vlanArg ? [vlanArg] : Object.keys(dev.cfg.vlans).map(Number).filter((v) => !(dev.cfg.stp.off || []).includes(v));
  if (blockedOnly) {
    const out2 = ['', 'Name                 Blocked Interfaces List', '-------------------- ------------------------------------'];
    let n = 0;
    for (const v of vlans) {
      const b = Object.entries(S.stp.blocked[dev.id] || {}).filter(([, set]) => set.has(v)).map(([x]) => shortType(dev, x));
      if (b.length) {
        out2.push(`${padR(`VLAN${String(v).padStart(4, '0')}`, 21)}${b.join(', ')}`);
        n += b.length;
      }
    }
    out2.push('', `Number of blocked ports (segments) in the system : ${n}`);
    return out2;
  }
  for (const v of vlans) {
    if (!(v in dev.cfg.vlans)) return [`Spanning tree instance(s) for vlan ${v} does not exist.`];
    const ports = sortedIfs(dev, (i, n) => i.sw && !i.lag && (S.ifs[dev.id][n]?.up || S.lags[dev.id]?.[n]?.up) && (i.sw.mode === 'access' ? i.sw.vlan === v : (i.sw.native === v || vlanIn(i.sw.allowed, v))));
    if (!ports.length) continue;
    const info = stpInfo(s, dev, v);
    const prio = (d) => (d.cfg.stp.prio[v] ?? 32768) + v;
    const rmac = macCisco(macOfIf(info.root, 'base'));
    out.push(`VLAN${String(v).padStart(4, '0')}`, `  Spanning tree enabled protocol ${dev.cfg.stp.mode === 'rapid-pvst' ? 'rstp' : dev.cfg.stp.mode === 'mst' ? 'mstp' : 'ieee'}`);
    out.push(`  Root ID    Priority    ${prio(info.root)}`, `             Address     ${rmac}`);
    if (info.isRoot) out.push('             This bridge is the root');
    else out.push(`             Cost        ${4 + (hashStr(dev.id) % 3) * 4}`, `             Port        ${(info.rootPort || '').match(/(\d+)$/)?.[1] || 1} (${info.rootPort})`);
    out.push('             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec', '');
    out.push(`  Bridge ID  Priority    ${prio(dev)}  (priority ${dev.cfg.stp.prio[v] ?? 32768} sys-id-ext ${v})`, `             Address     ${macCisco(macOfIf(dev, 'base'))}`, '             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec', '             Aging Time  300 sec', '');
    out.push(row(['Interface', 20], ['Role', 5], ['Sts', 4], ['Cost', 10], ['Prio.Nbr', 9], ['Type']), '------------------- ---- --- --------- -------- --------------------------------');
    for (const n of ports) {
      const i = dev.cfg.ifs[n];
      const blocked = S.stp.blocked[dev.id]?.[n]?.has(v);
      const role = blocked ? 'Altn' : info.rootPort === n ? 'Root' : 'Desg';
      const sp = S.links[S.ifs[dev.id][n]?.link]?.speed || 1000;
      const cost = sp >= 10000 ? 2 : sp >= 1000 ? 4 : 19;
      out.push(row([shortType(dev, n), 20], [role, 5], [blocked ? 'BLK' : 'FWD', 4], [cost, 10], [`128.${(n.match(/(\d+)$/) || [0, 1])[1]}`, 9], [`P2p${i.stp?.edge ? ' Edge' : ''}`]));
    }
    out.push('');
  }
  return out.length ? out : [`No spanning tree instance exists.`];
}
function showEtherchannel(s) {
  const dev = s.dev;
  const S = S_(s.world);
  const lags = sortedIfs(dev, (i) => i.kind === 'lag');
  const out = ['Flags:  D - down        P - bundled in port-channel', '        I - stand-alone s - suspended', '        H - Hot-standby (LACP only)', '        R - Layer3      S - Layer2', '        U - in use      f - failed to allocate aggregator', '', '        M - not in use, minimum links not met', '        u - unsuitable for bundling', '        w - waiting to be aggregated', '        d - default port', '', '', `Number of channel-groups in use: ${lags.length}`, `Number of aggregators:           ${lags.length}`, '', 'Group  Port-channel  Protocol    Ports', '------+-------------+-----------+-----------------------------------------------'];
  for (const n of lags) {
    const i = dev.cfg.ifs[n];
    const L = S.lags[dev.id]?.[n];
    const mem = Object.keys(dev.cfg.ifs).filter((x) => dev.cfg.ifs[x].lag?.id === i.lagId);
    const mode = dev.cfg.ifs[mem[0]]?.lag?.mode;
    const proto = ['active', 'passive'].includes(mode) ? 'LACP' : ['desirable', 'auto'].includes(mode) ? 'PAgP' : '-';
    out.push(`${padR(i.lagId, 7)}${padR(`${shortType(dev, n)}(${i.sw ? 'S' : 'R'}${L?.up ? 'U' : 'D'})`, 14)}${padR(proto, 12)}${mem.map((m) => `${shortType(dev, m)}(${L?.members[m] || 'D'})`).join('  ')}`);
  }
  return out;
}
function showStandby(s, brief) {
  const dev = s.dev;
  const S = S_(s.world);
  const list = Object.entries(S.fhrp[dev.id] || {}).filter(([, f]) => f.proto === 'hsrp');
  if (!list.length) return [''];
  const peerIp = (n, f) => {
    const ep = S.eps.find((e) => e.dev === dev.id && e.if === n);
    const o = (S.bySeg.get(ep?.seg) || []).find((e) => e.dev && e.dev !== dev.id && s.world.devices[e.dev].cfg.ifs[e.if]?.fhrp?.grp === f.grp && !e.vip);
    return o?.ip || 'unknown';
  };
  if (brief) {
    const out = ['                     P indicates configured to preempt.', '                     |', row(['Interface', 12], ['Grp', 6], ['Pri', 4], ['P', 2], ['State', 8], ['Active', 16], ['Standby', 16], ['Virtual IP'])];
    for (const [n, f] of list) {
      const st = { active: 'Active', standby: 'Standby', init: 'Init' }[f.state];
      out.push(row([shortType(dev, n), 12], [f.grp, 6], [f.prio, 4], [f.preempt ? 'P' : ' ', 2], [st, 8], [f.state === 'active' ? 'local' : f.peers > 1 ? peerIp(n, f) : 'unknown', 16], [f.state === 'standby' ? 'local' : f.peers > 1 ? peerIp(n, f) : 'unknown', 16], [f.vip]));
    }
    return out;
  }
  const out = [];
  for (const [n, f] of list) out.push(`${n} - Group ${f.grp}`, `  State is ${{ active: 'Active', standby: 'Standby', init: 'Init' }[f.state]}`, `  Virtual IP address is ${f.vip}`, `  Active virtual MAC address is 0000.0c07.ac${(f.grp % 256).toString(16).padStart(2, '0')}`, '  Hello time 3 sec, hold time 10 sec', `  Preemption ${f.preempt ? 'enabled' : 'disabled'}`, `  Active router is ${f.state === 'active' ? 'local' : peerIp(n, f)}`, `  Standby router is ${f.state === 'standby' ? 'local' : f.peers > 1 ? peerIp(n, f) : 'unknown'}`, `  Priority ${f.prio} (${f.prio === 100 ? 'default 100' : 'configured ' + f.prio})`, `  Group name is "hsrp-${shortType(dev, n)}-${f.grp}" (default)`);
  return out;
}
function showVrrp(s) {
  const dev = s.dev;
  const list = Object.entries(S_(s.world).fhrp[dev.id] || {}).filter(([, f]) => f.proto === 'vrrp');
  const out = [row(['Interface', 15], ['Grp', 4], ['Pri', 4], ['Time', 5], ['Own', 4], ['Pre', 4], ['State', 7], ['Master addr', 16], ['Group addr'])];
  for (const [n, f] of list) out.push(row([shortType(dev, n), 15], [f.grp, 4], [f.prio, 4], ['3609', 5], ['', 4], [f.preempt ? 'Y' : 'N', 4], [f.state === 'active' ? 'Master' : f.state === 'standby' ? 'Backup' : 'Init', 7], [f.state === 'active' ? ipOnly(dev.cfg.ifs[n].ip) : 'unknown', 16], [f.vip]));
  return out;
}

// ----- misc -----
function showVersion(s) {
  const dev = s.dev;
  const m = model(dev.model);
  const W = s.world;
  const xe = dev.os === 'iosxe';
  const up = upCisco(uptimeMins(W, dev)).replace(/(\d+)w(\d+)d/, '$1 weeks, $2 days').replace(/(\d+)d(\d+)h/, '$1 days, $2 hours').replace(/^(\d\d):(\d\d):\d\d$/, '$1 hours, $2 minutes');
  const plat = m.name.replace(/^Cisco /, '');
  const out = [];
  if (xe) out.push(`Cisco IOS XE Software, Version ${dev.version}`, `Cisco IOS Software [${['Amsterdam', 'Bengaluru', 'Cupertino', 'Dublin', 'Gibraltar', 'Fuji', 'Everest'][hashStr(dev.version) % 7]}], ${plat} Software (${m.u > 1 ? 'X86_64_LINUX_IOSD-UNIVERSALK9-M' : 'CAT9K_IOSXE'}), Version ${dev.version}, RELEASE SOFTWARE (fc2)`);
  else out.push(`Cisco IOS Software, ${plat} Software (${isSw(dev) ? 'C3560-IPSERVICESK9-M' : 'C2800NM-ADVIPSERVICESK9-M'}), Version ${dev.version}, RELEASE SOFTWARE (fc1)`);
  out.push('Technical Support: http://www.cisco.com/techsupport', `Copyright (c) 1986-${yearOf(W.time.t)} by Cisco Systems, Inc.`, `Compiled ${fmtDate(Math.max(0, dev.installed - 200000), 'long').slice(4)} by prod_rel_team`, '', `ROM: Bootstrap program is ${xe ? 'IOS-XE ROMMON' : 'System Bootstrap, Version 12.4(13r)T'}`, '');
  out.push(`${dev.cfg.hostname} uptime is ${up}`, `Uptime for this control processor is ${up}`, `System returned to ROM by ${dev.run.reloadReason ? 'reload' : 'power-on'}`, `System image file is "${xe ? 'bootflash:packages.conf' : `flash:${dev.model}-advipservicesk9-mz.${String(dev.version).replace(/[().]/g, '')}.bin`}"`, `Last reload reason: ${dev.run.reloadReason || 'PowerOn'}`, '');
  out.push(`cisco ${plat} (${xe ? 'X86' : 'MPC860'}) processor with ${m.u > 1 ? '3755444K/6147K' : '262144K/12288K'} bytes of memory.`, `Processor board ID ${dev.hw.serial}`, `${physIfs(dev).length} Gigabit Ethernet interfaces`, '32768K bytes of non-volatile configuration memory.', '', `Configuration register is 0x2102`, '');
  return out;
}
function showEnv(s) {
  const dev = s.dev;
  const out = [];
  dev.hw.fans.forEach((ok, i) => out.push(`FAN ${i + 1} is ${ok ? 'OK' : 'FAULTY'}`));
  out.push(`SYSTEM TEMPERATURE is ${dev.hw.temp > 60 ? 'CRITICAL' : dev.hw.temp > 48 ? 'WARNING' : 'OK'}`, `System Temperature Value: ${Math.round(dev.hw.temp)} Degree Celsius`, 'System Temperature State: ' + (dev.hw.temp > 48 ? 'YELLOW' : 'GREEN'), `Yellow Threshold : 48 Degree Celsius`, 'Red Threshold    : 60 Degree Celsius', '');
  out.push('SW  PID                 Serial#     Status           Sys Pwr  PoE Pwr  Watts', '--  ------------------  ----------  ---------------  -------  -------  -----');
  dev.hw.psus.forEach((ok, i) => out.push(`1${String.fromCharCode(65 + i)}  PWR-C1-${model(dev.model).watts > 300 ? 1100 : 715}WAC    ${dev.hw.serial.slice(0, 3)}${1000 + i * 7}${String(hashStr(dev.id) % 100).padStart(2, '0')}  ${padR(ok ? 'OK' : 'No Input Power', 17)}${padR(ok ? 'Good' : 'Bad', 9)}${padR('n/a', 9)}${model(dev.model).watts > 300 ? 1100 : 715}`));
  return out;
}
function showInventory(s) {
  const dev = s.dev;
  const m = model(dev.model);
  const out = [`NAME: "${m.name}", DESCR: "${m.desc || m.name}"`, `PID: ${dev.model.toUpperCase()}           , VID: V01  , SN: ${dev.hw.serial}`, ''];
  dev.hw.psus.forEach((ok, i) => out.push(`NAME: "Power Supply ${i + 1}", DESCR: "AC Power Supply"`, `PID: PWR-${m.watts}W-AC     , VID: V02  , SN: ${dev.hw.serial.slice(0, 3)}${2000 + i}`, ''));
  for (const n of physIfs(dev)) {
    const o = optics(dev, n);
    if (o) out.push(`NAME: "${n}", DESCR: "${o.type}"`, `PID: ${o.type.replace(/ /g, '-')}     , VID: V03  , SN: AVD${(hashStr(dev.id + n) % 1e7).toString().padStart(7, '0')}`, '');
  }
  return out;
}
function showCdp(s, detail) {
  const dev = s.dev;
  const nbs = neighbours(s.world, dev).filter((n) => n.dev && n.dev.vendor === 'Cisco' && !['asa', 'iosxr'].includes(n.dev.os) && !n.lldpOnly);
  if (detail) {
    const out = [];
    for (const n of nbs) out.push('-------------------------', `Device ID: ${n.dev.hostname}.${n.dev.cfg.svc.domain || 'dc.local'}`, 'Entry address(es): ', `  IP address: ${n.ip || 'unknown'}`, `Platform: cisco ${n.platform.replace(/^Cisco /, '')},  Capabilities: ${n.caps.includes('R') ? 'Router ' : ''}${n.caps.includes('S') ? 'Switch ' : ''}IGMP `, `Interface: ${n.local},  Port ID (outgoing port): ${n.port}`, 'Holdtime : 151 sec', '', 'Version :', `Cisco IOS Software, Version ${n.dev.version}`, '', 'advertisement version: 2', `Native VLAN: ${n.dev.cfg.ifs[n.port]?.sw?.native ?? 1}`, `Duplex: ${duplexSpeed(s, n.dev, n.port).dup}`, '');
    return out;
  }
  const out = ['Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge', '                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone,', '                  D - Remote, C - CVTA, M - Two-port Mac Relay', '', 'Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID'];
  for (const n of nbs) out.push(`${padR(`${n.dev.hostname}`, 17)}${padR(shortType(dev, n.local).replace(/^(Gi|Te|Fa)/, (x) => ({ Gi: 'Gig ', Te: 'Ten ', Fa: 'Fas ' })[x]), 18)}${padL(150 + (hashStr(n.local) % 30), 7)}${padL(n.caps, 15)}  ${padR(n.dev.model.toUpperCase().slice(0, 9), 10)}${shortIf(n.dev, n.port).replace(/^(Gi|Te|Fa)/, (x) => ({ Gi: 'Gig ', Te: 'Ten ', Fa: 'Fas ' })[x])}`);
  out.push('', `Total cdp entries displayed : ${nbs.length}`);
  return out;
}
function showLldp(s) {
  const dev = s.dev;
  const nbs = neighbours(s.world, dev);
  const out = ['Capability codes:', '    (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device', '    (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other', '', 'Device ID           Local Intf     Hold-time  Capability      Port ID'];
  for (const n of nbs) out.push(`${padR((n.dev?.hostname || n.host?.name || '').slice(0, 20), 20)}${padR(shortType(dev, n.local), 15)}${padR(120, 11)}${padR(n.host ? 'S' : n.caps.includes('R') ? 'B,R' : 'B', 16)}${n.port}`);
  out.push('', `Total entries displayed: ${nbs.length}`);
  return out;
}
function showArp(s) {
  const dev = s.dev;
  const out = ['Protocol  Address          Age (min)  Hardware Addr   Type   Interface'];
  for (const a of arpTable(s.world, dev)) out.push(`Internet  ${padR(a.ip, 17)}${padL(a.self ? '-' : a.age, 9)}   ${macCisco(Array.isArray(a.mac) ? a.mac : a.mac.split ? a.mac.match(/[0-9a-f]{2}/g) : a.mac)}  ARPA   ${a.if}`);
  return out;
}
function showMac(s, a) {
  const dev = s.dev;
  let rows = macTable(s.world, dev);
  if (a.vlan) rows = rows.filter((r) => r.vlan === a.vlan);
  if (a.if) rows = rows.filter((r) => r.port === a.if);
  const out = ['          Mac Address Table', '-------------------------------------------', '', 'Vlan    Mac Address       Type        Ports', '----    -----------       --------    -----'];
  for (const r of rows) out.push(`${padL(r.vlan, 4)}    ${macCisco(r.mac)}    ${padR(r.type, 12)}${shortType(dev, r.port)}`);
  out.push(`Total Mac Addresses for this criterion: ${rows.length}`);
  return out;
}
function showAcl(s) {
  const dev = s.dev;
  const out = [];
  for (const [name, entries] of Object.entries(dev.cfg.acls)) {
    const std = isStdAcl(name, entries);
    out.push(`${std ? 'Standard' : 'Extended'} IP access list ${name}`);
    let seq = 10;
    for (const l of aclLines(name, entries, std)) {
      out.push(`    ${seq}${l}${hashStr(name + seq) % 3 === 0 ? ` (${hashStr(name + seq) % 5000} matches)` : ''}`);
      seq += 10;
    }
  }
  return out;
}
function showNat(s, stats) {
  const dev = s.dev;
  const nat = dev.cfg.nat;
  if (stats) return [`Total active translations: ${nat.statics.length + 14} (${nat.statics.length} static, 14 dynamic; 14 extended)`, `Outside interfaces:`, `  ${nat.outside.join(', ')}`, 'Inside interfaces: ', `  ${nat.inside.join(', ')}`, `Hits: ${s.world.time.t * 3 % 99999}  Misses: 0`];
  const out = ['Pro Inside global         Inside local          Outside local         Outside global'];
  for (const st of nat.statics) out.push(`--- ${padR(st.ext, 22)}${padR(st.int, 22)}---                   ---`);
  if (nat.overload) {
    const S = S_(s.world);
    const outIp = (S.epsByDev.get(dev.id) || []).find((e) => nat.outside.includes(e.if))?.ip;
    for (const c of s.world.design.customers.slice(0, 4)) {
      const h = s.world.hosts[c.servers[0]];
      if (h && outIp) out.push(`tcp ${padR(`${outIp}:${1024 + (hashStr(h.id) % 6000)}`, 22)}${padR(`${h.ip}:${40000 + (hashStr(h.ip) % 9000)}`, 22)}${padR('8.8.8.8:443', 22)}8.8.8.8:443`);
    }
  }
  return out;
}
function showLogging(s) {
  const dev = s.dev;
  const D = s.dialect;
  const logs = dev.run.logs.map((e) => D.fmtEvent(e, dev, s.world)).filter(Boolean);
  return [`Syslog logging: enabled (0 messages dropped, 0 messages rate-limited, 0 flushes, 0 overruns, xml disabled, filtering disabled)`, '', 'No Active Message Discriminator.', '', '    Console logging: level debugging, ' + logs.length + ' messages logged, xml disabled,', '    Monitor logging: level debugging, 0 messages logged, xml disabled,', '    Buffer logging:  level debugging, ' + logs.length + ' messages logged, xml disabled,', ...dev.cfg.svc.syslog.map((h) => `    Logging to ${h}  (udp port 514, audit disabled,\n              link up),\n              ${logs.length} message lines logged`), '', `Log Buffer (8192 bytes):`, '', ...logs];
}
function showClock(s) {
  const synced = s.dev.cfg.svc.ntp.length && s.world.sim && walkOk(s, s.dev.cfg.svc.ntp[0]);
  return [`${synced ? '' : '*'}${fmtDate(s.world.time.t, 'clock')}`];
}
function walkOk(s, ip) {
  return ping(s, ip, { count: 1 }).r.ok;
}
function showProc(s) {
  const dev = s.dev;
  const cpu = Math.min(99, 4 + Math.round((S_(s.world).stormSegs?.size ? 85 : 0) + (hashStr(String(Math.floor(s.world.time.t))) % 5)));
  return [`CPU utilization for five seconds: ${cpu}%/${Math.floor(cpu / 3)}%; one minute: ${cpu}%; five minutes: ${Math.max(3, cpu - 2)}%`, ' PID Runtime(ms)     Invoked      uSecs   5Sec   1Min   5Min TTY Process', `  ${S_(s.world).stormSegs?.size ? '88   98234123    1844823      53245 72.15% 70.33% 68.12%   0 ARP Input' : ' 4      198123      12344      16050  0.47%  0.32%  0.30%   0 Check heaps'}`, '  93      102331     998734        102  0.31%  0.22%  0.21%   0 IP Input', '  12       12334      23411        526  0.07%  0.04%  0.05%   0 OSPF-1 Hello', void dev].filter((x) => x !== undefined);
}

// =============================================================================================
// Config handlers
const err = (msg) => msg;
function ifSel(s) {
  return cfgOf(s).ifs[s.ctx.if];
}
function setIp(s, ip, mask, secondary) {
  const dev = s.dev;
  const i = ifSel(s);
  const len = maskLen(mask);
  if (len < 0) return `Bad mask 0x${ip2n(mask).toString(16).toUpperCase()} for address ${ip}`;
  if (i.sw && isSw(dev) && (i.kind === 'phys' || i.kind === 'lag')) return '% IP addresses may not be configured on L2 links.';
  const c = cidr(`${ip}/${len}`);
  if (len < 31 && (c.n === c.net || c.n === c.bc)) return 'Bad mask /' + len + ' for address ' + ip;
  for (const [n, o] of Object.entries(cfgOf(s).ifs)) {
    if (n === s.ctx.if || !o.ip || o.vrf !== i.vrf) continue;
    const oc = cidr(o.ip);
    const ml = Math.min(oc.len, len);
    if (((oc.n >>> (32 - ml)) === (c.n >>> (32 - ml))) && ml > 0) return `% ${n2ip(c.net)} overlaps with ${n}`;
  }
  void secondary;
  i.ip = `${ip}/${len}`;
  changed(s);
  return '';
}
function parseAddrSpec(tok, i) {
  // returns [cidr|'any', consumed]
  const t = tok[i];
  if (!t) return [null, 0];
  if (t === 'any') return ['any', 1];
  if (t === 'host') return isIp(tok[i + 1] || '') ? [`${tok[i + 1]}/32`, 2] : [null, 0];
  if (isIp(t)) {
    const w = tok[i + 1];
    if (w && isIp(w)) {
      const len = maskLen(n2ip(~ip2n(w) >>> 0));
      if (len < 0) return [null, 0];
      return [`${n2ip((ip2n(t) & ip2n(maskStr(len))) >>> 0)}/${len}`, 2];
    }
    return [`${t}/32`, 1];
  }
  return [null, 0];
}
const PORTS = { www: 80, http: 80, https: 443, ssh: 22, telnet: 23, domain: 53, snmp: 161, ftp: 21, smtp: 25, ntp: 123 };
export function parseAce(words, std) {
  const [act, ...r] = words;
  if (!['permit', 'deny'].includes(act)) return null;
  if (std) {
    const [src, n] = parseAddrSpec(r, 0);
    if (!src || r.length > n + (r[n] === 'log' ? 1 : 0)) return null;
    return { act, proto: 'ip', src, dst: 'any', std: true };
  }
  const proto = r[0];
  if (!['ip', 'tcp', 'udp', 'icmp'].includes(proto)) return null;
  let i = 1;
  const [src, a] = parseAddrSpec(r, i);
  if (!src) return null;
  i += a;
  if (r[i] === 'eq') i += 2;
  const [dst, b] = parseAddrSpec(r, i);
  if (!dst) return null;
  i += b;
  let dport = null;
  if (r[i] === 'eq') {
    dport = PORTS[r[i + 1]] ?? Number(r[i + 1]);
    if (!dport) return null;
    i += 2;
  }
  const log = r[i] === 'log';
  return { act, proto, src, dst, dport, log };
}

function ifCmds(xe) {
  return [
    { p: 'description $line:text', run: (s, a) => ((ifSel(s).desc = a.text.slice(0, 240)), changed(s)), help: { $text: 'Up to 240 characters describing this interface' } },
    { p: 'no description', run: (s) => ((ifSel(s).desc = ''), changed(s)) },
    { p: 'shutdown', run: (s) => ((ifSel(s).on = false), changed(s)) },
    {
      p: 'no shutdown',
      run: (s) => {
        const i = ifSel(s);
        i.on = true;
        if (s.dev.run.errdis[s.ctx.if]) delete s.dev.run.errdis[s.ctx.if];
        changed(s);
      },
    },
    {
      p: 'switchport',
      run: (s) => {
        if (!isSw(s.dev)) return '% Invalid input detected';
        const i = ifSel(s);
        if (!i.sw) {
          i.sw = { mode: 'access', vlan: 1, native: 1, allowed: 'all' };
          i.ip = null;
          changed(s);
        }
      },
    },
    {
      p: 'no switchport',
      run: (s) => {
        if (!hasFeat(s.dev, 'l3')) return '% Command rejected: Layer 3 interfaces are not supported on this switch';
        const i = ifSel(s);
        i.sw = null;
        changed(s);
      },
    },
    { p: 'switchport mode {access|trunk}', run: (s, a) => swMode(s, a.has('trunk') ? 'trunk' : 'access') },
    { p: 'switchport mode dynamic {auto|desirable}', run: (s) => swMode(s, 'access') },
    { p: 'switchport nonegotiate', run: () => '' },
    { p: 'switchport trunk encapsulation {dot1q|isl|negotiate}', run: (s, a) => (a.has('isl') ? '% ISL is not supported on this platform' : '') },
    {
      p: 'switchport access vlan $num(1-4094):vlan',
      run: (s, a) => {
        const i = ifSel(s);
        if (!i.sw) return '% Command rejected: interface is not a switchport';
        i.sw.vlan = a.vlan;
        let msg = '';
        if (!(a.vlan in cfgOf(s).vlans)) {
          ensureVlan(s.dev, a.vlan);
          msg = `% Access VLAN does not exist. Creating vlan ${a.vlan}`;
        }
        changed(s);
        return msg;
      },
      help: { $vlan: 'VLAN ID of the VLAN when this port is in access mode' },
    },
    { p: 'no switchport access vlan', run: (s) => ((ifSel(s).sw.vlan = 1), changed(s)) },
    { p: 'switchport trunk native vlan $num(1-4094):vlan', run: (s, a) => ((ifSel(s).sw.native = a.vlan), changed(s)), help: { $vlan: 'VLAN ID of the native VLAN when this port is in trunking mode' } },
    { p: 'no switchport trunk native vlan', run: (s) => ((ifSel(s).sw.native = 1), changed(s)) },
    { p: 'switchport trunk allowed vlan {all|none}', run: (s, a) => trunkAllowed(s, a.has('all') ? 'all' : 'none', null) },
    { p: 'switchport trunk allowed vlan $vlist:list', run: (s, a) => trunkAllowed(s, 'set', a.list), help: { $list: 'VLAN IDs of the allowed VLANs when this port is in trunking mode' } },
    { p: 'switchport trunk allowed vlan {add|remove|except} $vlist:list', run: (s, a) => trunkAllowed(s, a.kw.find((k) => ['add', 'remove', 'except'].includes(k)), a.list) },
    { p: 'no switchport trunk allowed vlan', run: (s) => trunkAllowed(s, 'all', null) },
    {
      p: 'speed {10|100|1000|10000|auto}',
      run: (s, a) => {
        const i = ifSel(s);
        const v = a.kw[1];
        if (v !== 'auto' && Number(v) > (i.hw?.speed || 1000)) return '% Invalid input detected';
        i.speed = v === 'auto' ? 'auto' : Number(v);
        changed(s);
      },
    },
    { p: 'no speed', run: (s) => ((ifSel(s).speed = 'auto'), changed(s)) },
    { p: 'duplex {auto|full|half}', run: (s, a) => ((ifSel(s).duplex = a.kw[1]), changed(s)) },
    { p: 'no duplex', run: (s) => ((ifSel(s).duplex = 'auto'), changed(s)) },
    { p: 'negotiation auto', run: (s) => ((ifSel(s).speed = 'auto'), (ifSel(s).duplex = 'auto'), changed(s)) },
    { p: 'mtu $num(1500-9216):mtu', run: (s, a) => ((ifSel(s).mtu = a.mtu), changed(s)), help: { $mtu: 'MTU size in bytes' } },
    { p: 'no mtu', run: (s) => ((ifSel(s).mtu = 1500), changed(s)) },
    { p: 'ip address $ip:ip $mask:mask', run: (s, a) => setIp(s, a.ip, a.mask), help: { $ip: 'IP address', $mask: 'IP subnet mask' } },
    { p: 'ip address $ip:ip $mask:mask secondary', run: (s, a) => setIp(s, a.ip, a.mask, true) },
    { p: 'no ip address', run: (s) => ((ifSel(s).ip = null), changed(s)) },
    { p: 'ip address dhcp', run: () => '% DHCP client is not supported on this interface in Uptime Empire' },
    { p: 'ip helper-address $ip:ip', run: (s, a) => (ifSel(s).helper.includes(a.ip) ? '' : (ifSel(s).helper.push(a.ip), changed(s))), help: { $ip: 'IP destination address' } },
    { p: 'no ip helper-address [$ip:ip]', run: (s, a) => ((ifSel(s).helper = a.ip ? ifSel(s).helper.filter((x) => x !== a.ip) : []), changed(s)) },
    { p: 'ip access-group $word:acl {in|out}', run: (s, a) => ((ifSel(s).acl[a.has('in') ? 'in' : 'out'] = a.acl), changed(s)), help: { $acl: 'Access-list name' } },
    { p: 'no ip access-group [$word:acl] {in|out}', run: (s, a) => ((ifSel(s).acl[a.has('in') ? 'in' : 'out'] = null), changed(s)) },
    { p: 'ip nat {inside|outside}', run: (s, a) => natSide(s, a.has('inside') ? 'inside' : 'outside', true) },
    { p: 'no ip nat {inside|outside}', run: (s, a) => natSide(s, a.has('inside') ? 'inside' : 'outside', false) },
    { p: 'ip ospf cost $num(1-65535):cost', run: (s, a) => ospfIf(s, { cost: a.cost }) },
    { p: 'no ip ospf cost', run: (s) => ospfIf(s, { cost: null }) },
    { p: 'ip ospf hello-interval $num(1-65535):sec', run: (s, a) => ospfIf(s, { hello: a.sec, dead: ifSel(s).ospf?.deadSet ? ifSel(s).ospf.dead : a.sec * 4 }) },
    { p: 'no ip ospf hello-interval', run: (s) => ospfIf(s, { hello: 10, dead: ifSel(s).ospf?.deadSet ? ifSel(s).ospf.dead : 40 }) },
    { p: 'ip ospf dead-interval $num(1-65535):sec', run: (s, a) => ospfIf(s, { dead: a.sec, deadSet: true }) },
    { p: 'no ip ospf dead-interval', run: (s) => ospfIf(s, { dead: (ifSel(s).ospf?.hello || 10) * 4, deadSet: false }) },
    { p: 'ip ospf $num(1-65535):pid area $word:area', run: (s, a) => ospfIf(s, { area: areaDot(a.area), ifLevel: true }) },
    { p: 'no ip ospf $num(1-65535):pid area [$word:area]', run: (s) => ospfIf(s, { area: null, ifLevel: false }) },
    { p: 'ip ospf authentication-key $word:key', run: (s, a) => ospfIf(s, { auth: a.key }) },
    { p: 'no ip ospf authentication-key', run: (s) => ospfIf(s, { auth: null }) },
    { p: 'ip ospf network point-to-point', run: (s) => ospfIf(s, { p2p: true }) },
    { p: 'standby $num(0-4095):grp ip $ip:ip', run: (s, a) => fhrp(s, 'hsrp', a.grp, { vip: a.ip }) },
    { p: 'standby $num(0-4095):grp priority $num(0-255):prio', run: (s, a) => fhrp(s, 'hsrp', a.grp, { prio: a.prio }) },
    { p: 'standby $num(0-4095):grp preempt', run: (s, a) => fhrp(s, 'hsrp', a.grp, { preempt: true }) },
    { p: 'no standby $num(0-4095):grp preempt', run: (s, a) => fhrp(s, 'hsrp', a.grp, { preempt: false }) },
    { p: 'no standby $num(0-4095):grp priority', run: (s, a) => fhrp(s, 'hsrp', a.grp, { prio: 100 }) },
    { p: 'no standby $num(0-4095):grp [ip]', run: (s) => ((ifSel(s).fhrp = null), changed(s)) },
    { p: 'standby version {1|2}', run: () => '' },
    { p: 'vrrp $num(1-255):grp ip $ip:ip', run: (s, a) => fhrp(s, 'vrrp', a.grp, { vip: a.ip }) },
    { p: 'vrrp $num(1-255):grp priority $num(1-254):prio', run: (s, a) => fhrp(s, 'vrrp', a.grp, { prio: a.prio }) },
    { p: 'vrrp $num(1-255):grp preempt', run: (s, a) => fhrp(s, 'vrrp', a.grp, { preempt: true }) },
    { p: 'no vrrp $num(1-255):grp preempt', run: (s, a) => fhrp(s, 'vrrp', a.grp, { preempt: false }) },
    { p: 'no vrrp $num(1-255):grp', run: (s) => ((ifSel(s).fhrp = null), changed(s)) },
    { p: 'channel-group $num(1-128):id mode {active|passive|on|desirable|auto}', run: (s, a) => channelGroup(s, a.id, a.kw[a.kw.length - 1]) },
    { p: 'no channel-group', run: (s) => ((ifSel(s).lag = null), changed(s)) },
    { p: 'spanning-tree portfast [trunk]', run: (s) => ((ifSel(s).stp.edge = true), changed(s), '%Warning: portfast should only be enabled on ports connected to a single\n host. Connecting hubs, concentrators, switches, bridges, etc... to this\n interface  when portfast is enabled, can cause temporary bridging loops.\n Use with CAUTION') },
    { p: 'no spanning-tree portfast', run: (s) => ((ifSel(s).stp.edge = false), changed(s)) },
    { p: 'spanning-tree bpduguard {enable|disable}', run: (s, a) => ((ifSel(s).stp.bpduguard = a.has('enable')), changed(s)) },
    { p: 'no spanning-tree bpduguard', run: (s) => ((ifSel(s).stp.bpduguard = false), changed(s)) },
    { p: 'encapsulation dot1Q $num(1-4094):vlan', run: (s, a) => (ifSel(s).kind !== 'sub' ? '% Configuring IEEE 802.1Q encapsulation on the main interface is not permitted' : ((ifSel(s).vlan = a.vlan), changed(s))) },
    { p: 'encapsulation {hdlc|ppp|frame-relay}', run: (s, a) => (ifSel(s).kind !== 'serial' ? '% Invalid input detected' : ((ifSel(s).encap = a.kw[1]), changed(s))) },
    { p: 'clock rate $num:rate', run: () => '' },
    { p: 'bandwidth $num:kbps', run: () => '' },
    { p: 'load-interval $num(30-600):sec', run: () => '' },
    { p: '[no] cdp enable', run: () => '' },
    { p: '[no] lldp {transmit|receive}', run: () => '' },
    { p: 'ip ospf priority $num(0-255):p', run: () => '' },
    { p: 'no ip redirects', run: () => '' },
    { p: 'no ip proxy-arp', run: () => '' },
    ...(xe ? [{ p: 'vrf forwarding $word:vrf', run: (s, a) => ((ifSel(s).vrf = a.vrf), (ifSel(s).ip = null), changed(s)) }] : [{ p: 'ip vrf forwarding $word:vrf', run: (s, a) => ((ifSel(s).vrf = a.vrf), (ifSel(s).ip = null), changed(s)) }]),
  ];
}
function swMode(s, mode) {
  const i = ifSel(s);
  if (!i.sw) {
    if (!isSw(s.dev)) return '% Invalid input detected';
    i.sw = { mode, vlan: 1, native: 1, allowed: 'all' };
    i.ip = null;
  }
  i.sw.mode = mode;
  changed(s);
  return '';
}
function trunkAllowed(s, op, list) {
  const i = ifSel(s);
  if (!i.sw) return '% Command rejected: interface is not a switchport';
  const vl = list ? parseVlans(list) : [];
  if (vl === null) return '% Invalid input detected';
  const cur = i.sw.allowed === 'all' ? null : new Set(i.sw.allowed);
  const ALL = () => new Set(Array.from({ length: 4094 }, (_, k) => k + 1));
  if (op === 'all') i.sw.allowed = 'all';
  else if (op === 'none') i.sw.allowed = [];
  else if (op === 'set') i.sw.allowed = vl;
  else if (op === 'add') {
    if (cur) {
      vl.forEach((v) => cur.add(v));
      i.sw.allowed = [...cur].sort((a, b) => a - b);
    }
  } else if (op === 'remove') {
    const base = cur || ALL();
    vl.forEach((v) => base.delete(v));
    i.sw.allowed = base.size === 4094 ? 'all' : [...base].sort((a, b) => a - b);
  } else if (op === 'except') {
    const base = ALL();
    vl.forEach((v) => base.delete(v));
    i.sw.allowed = [...base];
  }
  changed(s);
  return '';
}
function natSide(s, side, on) {
  const cfg = cfgOf(s);
  if (!hasFeat(s.dev, 'nat')) return '% Invalid input detected';
  cfg.nat = cfg.nat || { inside: [], outside: [], overload: false, statics: [] };
  const other = side === 'inside' ? 'outside' : 'inside';
  cfg.nat[side] = cfg.nat[side].filter((x) => x !== s.ctx.if);
  if (on) {
    cfg.nat[other] = cfg.nat[other].filter((x) => x !== s.ctx.if);
    cfg.nat[side].push(s.ctx.if);
  }
  changed(s);
  return '';
}
function ospfIf(s, patch) {
  const i = ifSel(s);
  i.ospf = i.ospf || { area: null, cost: null, hello: 10, dead: 40, passive: false };
  Object.assign(i.ospf, patch);
  changed(s);
  return '';
}
function fhrp(s, proto, grp, patch) {
  const i = ifSel(s);
  if (!hasFeat(s.dev, 'l3')) return '% Invalid input detected';
  if (!i.fhrp || i.fhrp.grp !== grp || i.fhrp.proto !== proto) i.fhrp = { proto, grp, vip: i.fhrp?.vip || null, prio: 100, preempt: proto === 'vrrp' };
  Object.assign(i.fhrp, patch);
  if (!i.fhrp.vip) return '';
  changed(s);
  return '';
}
function channelGroup(s, id, mode) {
  const dev = s.dev;
  if (!hasFeat(dev, 'lacp') && ['active', 'passive'].includes(mode)) return '% Invalid input detected';
  const i = ifSel(s);
  const cfg = cfgOf(s);
  const lagName = OS[dev.os].lag(id);
  const existing = cfg.ifs[lagName];
  const otherMode = Object.values(cfg.ifs).find((x) => x.lag?.id === id && x !== i)?.lag?.mode;
  if (otherMode && (otherMode === 'on') !== (mode === 'on')) return `Command rejected (Port-channel${id}, ${s.ctx.if}): Invalid etherchnl mode`;
  i.lag = { id, mode };
  let msg = '';
  if (!existing) {
    ensureLag(dev, id);
    cfg.ifs[lagName].sw = i.sw ? JSON.parse(JSON.stringify(i.sw)) : null;
    msg = `Creating a port-channel interface Port-channel ${id}\n`;
  }
  changed(s);
  return msg;
}

// ----- global config -----
function enterIf(s, name) {
  const dev = s.dev;
  const cfg = cfgOf(s);
  if (!cfg.ifs[name]) {
    const [t, num] = splitIf(name);
    if (/\.\d+$/.test(name)) {
      const parent = name.replace(/\.\d+$/, '');
      if (!cfg.ifs[parent] || cfg.ifs[parent].sw) return '% Invalid input detected';
      cfg.ifs[name] = { ...newIf('sub'), parent, vlan: null };
    } else if (t === 'Vlan') {
      if (!hasFeat(dev, 'l3') && Number(num) !== Number(Object.values(cfg.ifs).find((i) => i.kind === 'svi')?.vlan) && Object.values(cfg.ifs).some((i) => i.kind === 'svi' && i.on && i.ip)) {
        // L2 switches can have many SVIs, but only one may be up in old IOS: allow it anyway
      }
      ensureSvi(dev, Number(num));
    } else if (t === 'Loopback') cfg.ifs[name] = newIf('lo');
    else if (t === 'Port-channel') ensureLag(dev, Number(num));
    else if (t === 'Tunnel') cfg.ifs[name] = newIf('lo');
    else return '% Invalid input detected';
    changed(s);
  }
  s.ctx = { if: name };
  s.mode = cfg.ifs[name].kind === 'sub' ? 'subif' : 'if';
  return '';
}
function ospfNetwork(s, a, add) {
  const cfg = cfgOf(s);
  const wl = maskLen(n2ip(~ip2n(a.wild) >>> 0));
  if (wl < 0) return '% OSPF: Invalid wildcard mask';
  const net = `${n2ip((ip2n(a.ip) & ip2n(maskStr(wl))) >>> 0)}/${wl}`;
  let hits = 0;
  for (const i of Object.values(cfg.ifs)) {
    if (!i.ip || !inNet(ipOnly(i.ip), net)) continue;
    hits++;
    if (add) {
      i.ospf = i.ospf || { area: null, cost: null, hello: 10, dead: 40, passive: false };
      i.ospf.area = areaDot(a.area);
      i.ospf.ifLevel = false;
    } else if (i.ospf) i.ospf.area = null;
  }
  changed(s);
  return hits || !add ? '' : '';
}
function passiveIf(s, name, on) {
  const cfg = cfgOf(s);
  if (name === 'default') {
    for (const i of Object.values(cfg.ifs)) if (i.ospf) i.ospf.passive = on;
    changed(s);
    return '';
  }
  const i = cfg.ifs[name];
  i.ospf = i.ospf || { area: null, cost: null, hello: 10, dead: 40, passive: false };
  i.ospf.passive = on;
  changed(s);
  return '';
}

const globalCfg = (xe) => [
  { p: 'hostname $word:name', run: (s, a) => ((cfgOf(s).hostname = a.name), (s.dev.hostname = a.name), changed(s)), help: { $name: "This system's network name" } },
  { p: 'interface $ifc:if', run: (s, a) => enterIf(s, a.if) },
  { p: 'no interface $ifc:if', run: (s, a) => (['lo', 'svi', 'lag', 'sub'].includes(cfgOf(s).ifs[a.if]?.kind) ? (delete cfgOf(s).ifs[a.if], changed(s)) : '% Physical interfaces cannot be deleted') },
  { p: 'default interface $if:if', run: (s, a) => {
    const old = cfgOf(s).ifs[a.if];
    const fresh = newIf(old.kind, { hw: old.hw });
    if (isSw(s.dev) && old.kind === 'phys') fresh.sw = { mode: 'access', vlan: 1, native: 1, allowed: 'all' };
    if (old.encap) fresh.encap = 'hdlc';
    cfgOf(s).ifs[a.if] = fresh;
    changed(s);
    return `Interface ${a.if} set to default configuration`;
  } },
  { p: 'vlan $vlist:list', run: (s, a) => {
    if (!isSw(s.dev)) return '% Invalid input detected';
    const vl = parseVlans(a.list);
    for (const v of vl) ensureVlan(s.dev, v);
    changed(s);
    s.ctx = { vlans: vl };
    s.mode = 'vlan';
  } },
  { p: 'no vlan $vlist:list', run: (s, a) => {
    for (const v of parseVlans(a.list)) if (v !== 1) delete cfgOf(s).vlans[v];
    changed(s);
    return parseVlans(a.list).includes(1) ? '%Default VLAN 1 may not be deleted.' : '';
  } },
  { p: 'ip route $ip:pfx $mask:mask $ip:nh [$num(1-255):ad]', run: (s, a) => staticRoute(s, a, true) },
  { p: 'ip route $ip:pfx $mask:mask $if:iface [$ip:nh] [$num(1-255):ad]', run: (s, a) => staticRoute(s, a, true) },
  { p: 'no ip route $ip:pfx $mask:mask [$ip:nh]', run: (s, a) => staticRoute(s, a, false) },
  { p: 'no ip route $ip:pfx $mask:mask $if:iface [$ip:nh]', run: (s, a) => staticRoute(s, a, false) },
  { p: 'ip default-gateway $ip:gw', run: (s, a) => ((cfgOf(s).defaultGw = a.gw), changed(s)) },
  { p: 'no ip default-gateway', run: (s) => ((cfgOf(s).defaultGw = null), changed(s)) },
  { p: 'ip routing', run: (s) => (hasFeat(s.dev, 'l3') ? ((cfgOf(s).noRouting = false), changed(s)) : '% Invalid input detected') },
  { p: 'no ip routing', run: (s) => ((cfgOf(s).noRouting = true), changed(s)) },
  { p: 'router ospf $num(1-65535):pid', run: (s, a) => {
    if (!hasFeat(s.dev, 'ospf')) return '% Invalid input detected';
    const c = cfgOf(s);
    if (c.ospf.on && c.ospf.pid !== a.pid) return `% OSPF: Process ${c.ospf.pid} is already running; only one process is supported`;
    if (!c.ospf.on) {
      c.ospf.on = true;
      c.ospf.pid = a.pid;
      changed(s);
    }
    s.mode = 'ospf';
    s.ctx = {};
  } },
  { p: 'no router ospf $num(1-65535):pid', run: (s) => {
    const c = cfgOf(s);
    c.ospf.on = false;
    for (const i of Object.values(c.ifs)) i.ospf = null;
    changed(s);
  } },
  { p: 'router bgp $num(1-4294967295):asn', run: (s, a) => {
    if (!hasFeat(s.dev, 'bgp')) return '% Invalid input detected';
    const c = cfgOf(s);
    if (c.bgp.on && c.bgp.asn !== a.asn) return `% BGP is already running; AS is ${c.bgp.asn}`;
    if (!c.bgp.on) Object.assign(c.bgp, { on: true, asn: a.asn, nbrs: [], nets: [] }), changed(s);
    s.mode = 'bgp';
  } },
  { p: 'no router bgp $num:asn', run: (s) => ((cfgOf(s).bgp = { on: false, asn: null, rid: null, nbrs: [], nets: [] }), changed(s)) },
  { p: 'ip access-list {extended|standard} $word:name', run: (s, a) => {
    const c = cfgOf(s);
    c.acls[a.name] = c.acls[a.name] || [];
    s.ctx = { acl: a.name, std: a.has('standard') };
    s.mode = a.has('standard') ? 'stdacl' : 'extacl';
  } },
  { p: 'no ip access-list {extended|standard} $word:name', run: (s, a) => (delete cfgOf(s).acls[a.name], changed(s)) },
  { p: 'access-list $num(1-2699):n $line:rest', run: (s, a) => {
    const std = a.n < 100 || (a.n >= 1300 && a.n < 2000);
    const e = parseAce(a.rest.split(/\s+/), std);
    if (!e) return '% Invalid input detected';
    const c = cfgOf(s);
    (c.acls[String(a.n)] = c.acls[String(a.n)] || []).push(e);
    changed(s);
  } },
  { p: 'no access-list $num(1-2699):n', run: (s, a) => (delete cfgOf(s).acls[String(a.n)], changed(s)) },
  { p: 'ip nat inside source list $word:acl interface $if:if overload', run: (s, a) => {
    const c = cfgOf(s);
    if (!hasFeat(s.dev, 'nat')) return '% Invalid input detected';
    c.nat = c.nat || { inside: [], outside: [], overload: false, statics: [] };
    c.nat.overload = true;
    c.nat.list = a.acl;
    changed(s);
  } },
  { p: 'no ip nat inside source list $word:acl [interface $if:if overload]', run: (s) => ((cfgOf(s).nat.overload = false), changed(s)) },
  { p: 'ip nat inside source static $ip:int $ip:ext', run: (s, a) => {
    const c = cfgOf(s);
    c.nat = c.nat || { inside: [], outside: [], overload: false, statics: [] };
    if (c.nat.statics.some((x) => x.ext === a.ext)) return `% ${a.ext} already mapped (${c.nat.statics.find((x) => x.ext === a.ext).int} -> ${a.ext})`;
    c.nat.statics.push({ int: a.int, ext: a.ext });
    changed(s);
  } },
  { p: 'no ip nat inside source static $ip:int $ip:ext', run: (s, a) => ((cfgOf(s).nat.statics = cfgOf(s).nat.statics.filter((x) => !(x.int === a.int && x.ext === a.ext))), changed(s)) },
  { p: 'spanning-tree mode {pvst|rapid-pvst|mst}', run: (s, a) => ((cfgOf(s).stp.mode = a.kw[2]), changed(s)) },
  { p: 'spanning-tree vlan $vlist:list priority $num(0-61440):prio', run: (s, a) => {
    if (a.prio % 4096) return '% Bridge Priority must be in increments of 4096.\n% Allowed values are: \n  0     4096  8192  12288 16384 20480 24576 28672\n  32768 36864 40960 45056 49152 53248 57344 61440';
    for (const v of parseVlans(a.list)) cfgOf(s).stp.prio[v] = a.prio;
    changed(s);
  } },
  { p: 'spanning-tree vlan $vlist:list root primary', run: (s, a) => {
    for (const v of parseVlans(a.list)) cfgOf(s).stp.prio[v] = 24576;
    changed(s);
  } },
  { p: 'no spanning-tree vlan $vlist:list priority', run: (s, a) => {
    for (const v of parseVlans(a.list)) delete cfgOf(s).stp.prio[v];
    changed(s);
  } },
  { p: 'no spanning-tree vlan $vlist:list', run: (s, a) => {
    const c = cfgOf(s);
    const vl = parseVlans(a.list);
    if (vl.length >= 4094) c.stp.on = false;
    else c.stp.off = [...new Set([...(c.stp.off || []), ...vl])].sort((x, y) => x - y);
    changed(s);
  } },
  { p: 'spanning-tree vlan $vlist:list', run: (s, a) => {
    const c = cfgOf(s);
    const vl = parseVlans(a.list);
    if (vl.length >= 4094) c.stp.on = true;
    c.stp.on = true;
    c.stp.off = (c.stp.off || []).filter((v) => !vl.includes(v));
    changed(s);
  } },
  { p: 'spanning-tree extend system-id', run: () => '' },
  { p: 'username $word:name [privilege $num(0-15):priv] {secret|password} [$num(0-7):enc] $word:pw', run: (s, a) => {
    const c = cfgOf(s);
    const u = c.svc.users.find((x) => x.name === a.name);
    if (u) Object.assign(u, { pw: a.pw, priv: a.priv ?? u.priv });
    else c.svc.users.push({ name: a.name, pw: a.pw, priv: a.priv ?? 1 });
    changed(s);
  } },
  { p: 'no username $word:name', run: (s, a) => ((cfgOf(s).svc.users = cfgOf(s).svc.users.filter((x) => x.name !== a.name)), changed(s)) },
  { p: 'enable {secret|password} [$num(0-7):enc] $word:pw', run: (s, a) => ((cfgOf(s).svc.enable = a.pw), changed(s)) },
  { p: xe ? 'ip domain lookup' : 'ip domain-lookup', run: (s) => ((cfgOf(s).svc.domainLookup = true), changed(s)) },
  { p: xe ? 'no ip domain lookup' : 'no ip domain-lookup', run: (s) => ((cfgOf(s).svc.domainLookup = false), changed(s)) },
  { p: xe ? 'ip domain name $word:d' : 'ip domain-name $word:d', run: (s, a) => ((cfgOf(s).svc.domain = a.d), changed(s)) },
  { p: 'ntp server $ip:ip', run: (s, a) => (cfgOf(s).svc.ntp.includes(a.ip) ? '' : (cfgOf(s).svc.ntp.push(a.ip), changed(s))) },
  { p: 'no ntp server $ip:ip', run: (s, a) => ((cfgOf(s).svc.ntp = cfgOf(s).svc.ntp.filter((x) => x !== a.ip)), changed(s)) },
  { p: 'logging [host] $ip:ip', run: (s, a) => (cfgOf(s).svc.syslog.includes(a.ip) ? '' : (cfgOf(s).svc.syslog.push(a.ip), changed(s))) },
  { p: 'no logging [host] $ip:ip', run: (s, a) => ((cfgOf(s).svc.syslog = cfgOf(s).svc.syslog.filter((x) => x !== a.ip)), changed(s)) },
  { p: 'logging {buffered|console|monitor|trap} [$word:lvl]', run: () => '' },
  { p: 'snmp-server community $word:c {RO|RW}', run: (s, a) => ((cfgOf(s).svc.snmp = a.c), changed(s)) },
  { p: 'no snmp-server community $word:c', run: (s) => ((cfgOf(s).svc.snmp = null), changed(s)) },
  { p: 'banner motd $line:text', run: (s, a) => {
    const d = a.text[0];
    const body = a.text.slice(1);
    const end = body.indexOf(d);
    if (end >= 0) {
      cfgOf(s).svc.motd = body.slice(0, end);
      changed(s);
      return '';
    }
    return ask('', (more) => {
      const e = more.indexOf(d);
      cfgOf(s).svc.motd = (body + '\n' + (e >= 0 ? more.slice(0, e) : more)).trim();
      changed(s);
      return '';
    }, { pre: `Enter TEXT message.  End with the character '${d}'.` });
  } },
  { p: 'no banner motd', run: (s) => ((cfgOf(s).svc.motd = null), changed(s)) },
  { p: 'service password-encryption', run: (s) => ((cfgOf(s).svc.encrypt = true), changed(s)) },
  { p: 'no service password-encryption', run: (s) => ((cfgOf(s).svc.encrypt = false), changed(s)) },
  { p: 'service timestamps {debug|log} datetime [msec]', run: () => '' },
  { p: 'ip ssh version {1|2}', run: () => '' },
  { p: 'crypto key generate rsa [modulus $num(360-4096):bits]', run: (s, a) => {
    const gen = (bits) => {
      s.dev.key = `SHA256:${hashStr(`${s.dev.id}:${s.world.time.t}:${bits}`).toString(36)}${hashStr(String(s.world.time.t)).toString(36)}Qk${hashStr(s.dev.hostname).toString(36)}`;
      cfgOf(s).svc.ssh = true;
      changed(s);
      return `% The key modulus size is ${bits} bits\n% Generating ${bits} bit RSA keys, keys will be non-exportable...\n[OK] (elapsed time was 1 seconds)\n`;
    };
    if (a.bits) return gen(a.bits);
    return ask('How many bits in the modulus [1024]: ', (x) => gen(Number(x) || 1024), { pre: `The name for the keys will be: ${cfgOf(s).hostname}.${cfgOf(s).svc.domain || ''}\nChoose the size of the key modulus in the range of 360 to 4096 for your\n  General Purpose Keys. Choosing a key modulus greater than 512 may take\n  a few minutes.\n` });
  } },
  { p: 'line {vty|con|console} $num(0-15):a [$num(0-15):b]', run: (s, a) => {
    s.ctx = { line: a.has('vty') ? 'vty' : 'con' };
    s.mode = 'line';
  } },
  { p: 'cdp run', run: () => '' },
  { p: 'no cdp run', run: () => '' },
  { p: 'lldp run', run: () => '' },
  { p: 'archive', run: () => '' },
];

function staticRoute(s, a, add) {
  const cfg = cfgOf(s);
  const len = maskLen(a.mask);
  if (len < 0) return '%Inconsistent address and mask';
  const pfx = `${n2ip((ip2n(a.pfx) & ip2n(a.mask)) >>> 0)}/${len}`;
  if (n2ip((ip2n(a.pfx) & ip2n(a.mask)) >>> 0) !== a.pfx) return '%Inconsistent address and mask';
  if (add) {
    if (a.iface && /^Null/i.test(a.iface)) {
      cfg.static = cfg.static.filter((r) => !(r.pfx === pfx && r.iface === 'Null0'));
      cfg.static.push({ pfx, nh: null, iface: 'Null0', ad: a.ad ?? 1 });
    } else {
      cfg.static = cfg.static.filter((r) => !(r.pfx === pfx && r.nh === (a.nh || null)));
      cfg.static.push({ pfx, nh: a.nh || null, iface: a.iface || null, ad: a.ad ?? 1 });
    }
  } else {
    const before = cfg.static.length;
    cfg.static = cfg.static.filter((r) => !(r.pfx === pfx && (!a.nh || r.nh === a.nh) && (!a.iface || r.iface === a.iface || (r.iface === 'Null0' && /^Null/i.test(a.iface)))));
    if (cfg.static.length === before) return '%No matching route to delete';
  }
  changed(s);
  return '';
}

const ospfCfg = [
  { p: 'router-id $ip:rid', run: (s, a) => ((cfgOf(s).ospf.rid = a.rid), changed(s), '% OSPF: Reload or use "clear ip ospf process" command, for this to take effect') },
  { p: 'no router-id', run: (s) => ((cfgOf(s).ospf.rid = null), changed(s)) },
  { p: 'network $ip:ip $wild:wild area $word:area', run: (s, a) => ospfNetwork(s, a, true) },
  { p: 'no network $ip:ip $wild:wild area $word:area', run: (s, a) => ospfNetwork(s, a, false) },
  { p: 'passive-interface default', run: (s) => passiveIf(s, 'default', true) },
  { p: 'no passive-interface default', run: (s) => passiveIf(s, 'default', false) },
  { p: 'passive-interface $if:if', run: (s, a) => passiveIf(s, a.if, true) },
  { p: 'no passive-interface $if:if', run: (s, a) => passiveIf(s, a.if, false) },
  { p: 'default-information originate [always]', run: (s, a) => ((cfgOf(s).ospf.defOrig = true), (cfgOf(s).ospf.always = a.has('always')), changed(s)) },
  { p: 'no default-information originate', run: (s) => ((cfgOf(s).ospf.defOrig = false), changed(s)) },
  { p: 'auto-cost reference-bandwidth $num(1-4294967):bw', run: (s, a) => ((cfgOf(s).ospf.ref = a.bw), changed(s), '% OSPF: Reference bandwidth is changed.\n        Please ensure reference bandwidth is consistent across all routers.') },
  { p: 'log-adjacency-changes [detail]', run: () => '' },
  { p: 'area $word:area authentication [message-digest]', run: () => '' },
  { p: 'redistribute {static|connected} [subnets]', run: () => '' },
];
const bgpCfg = [
  { p: 'bgp router-id $ip:rid', run: (s, a) => ((cfgOf(s).bgp.rid = a.rid), changed(s)) },
  { p: 'bgp log-neighbor-changes', run: () => '' },
  { p: 'neighbor $ip:ip remote-as $num(1-4294967295):as', run: (s, a) => {
    const b = cfgOf(s).bgp;
    const n = b.nbrs.find((x) => x.ip === a.ip);
    if (n) n.ras = a.as;
    else b.nbrs.push({ ip: a.ip, ras: a.as, shut: false, desc: '', maxpfx: null });
    changed(s);
  } },
  { p: 'no neighbor $ip:ip [remote-as $num:as]', run: (s, a) => ((cfgOf(s).bgp.nbrs = cfgOf(s).bgp.nbrs.filter((x) => x.ip !== a.ip)), changed(s)) },
  { p: '[no] neighbor $ip:ip shutdown', run: (s, a) => nbr(s, a.ip, { shut: !a.has('no') }) },
  { p: 'neighbor $ip:ip description $line:d', run: (s, a) => nbr(s, a.ip, { desc: a.d }) },
  { p: 'neighbor $ip:ip maximum-prefix $num(1-4294967295):max [$num(1-100):thr] [warning-only]', run: (s, a) => nbr(s, a.ip, { maxpfx: a.has('warning-only') ? null : a.max }) },
  { p: 'no neighbor $ip:ip maximum-prefix', run: (s, a) => nbr(s, a.ip, { maxpfx: null }) },
  { p: 'neighbor $ip:ip {update-source|route-map|password|ebgp-multihop|next-hop-self|soft-reconfiguration} [$line:x]', run: () => '' },
  { p: 'network $ip:ip mask $mask:mask', run: (s, a) => {
    const p = `${a.ip}/${maskLen(a.mask)}`;
    if (!cfgOf(s).bgp.nets.includes(p)) cfgOf(s).bgp.nets.push(p);
    changed(s);
  } },
  { p: 'no network $ip:ip mask $mask:mask', run: (s, a) => ((cfgOf(s).bgp.nets = cfgOf(s).bgp.nets.filter((x) => x !== `${a.ip}/${maskLen(a.mask)}`)), changed(s)) },
  { p: 'address-family ipv4 [unicast]', run: () => '' },
  { p: 'exit-address-family', run: () => '' },
];
function nbr(s, ip, patch) {
  const n = cfgOf(s).bgp.nbrs.find((x) => x.ip === ip);
  if (!n) return `% Specify remote-as or peer-group commands first`;
  Object.assign(n, patch);
  changed(s);
  return '';
}
const aclCfg = (std) => [
  { p: '[$num(1-2147483647):seq] {permit|deny} $line:rest', run: (s, a) => {
    const e = parseAce([a.kw[0], ...a.rest.split(/\s+/)], std);
    if (!e) return '% Invalid input detected';
    const list = cfgOf(s).acls[s.ctx.acl];
    if (a.seq) {
      const idx = Math.min(list.length, Math.max(0, Math.floor(a.seq / 10) - 1));
      list.splice(idx, 0, e);
    } else list.push(e);
    changed(s);
  } },
  { p: 'no $num(1-2147483647):seq', run: (s, a) => {
    const list = cfgOf(s).acls[s.ctx.acl];
    const idx = Math.floor(a.seq / 10) - 1;
    if (!list[idx]) return '';
    list.splice(idx, 1);
    changed(s);
  } },
  { p: 'no {permit|deny} $line:rest', run: (s, a) => {
    const e = parseAce([a.kw[1], ...a.rest.split(/\s+/)], std);
    const list = cfgOf(s).acls[s.ctx.acl];
    const idx = list.findIndex((x) => JSON.stringify({ ...x, log: !!x.log }) === JSON.stringify({ ...e, log: !!e?.log }));
    if (idx >= 0) list.splice(idx, 1), changed(s);
  } },
  { p: 'remark $line:r', run: (s, a) => (cfgOf(s).acls[s.ctx.acl].push({ remark: a.r }), changed(s)) },
];
const lineCfg = [
  { p: 'transport input {ssh|telnet|all|none}', run: (s, a) => {
    if (s.ctx.line !== 'vty') return '';
    const v = a.kw[2];
    const c = cfgOf(s).svc;
    c.ssh = v === 'ssh' || v === 'all';
    c.telnet = v === 'telnet' || v === 'all';
    changed(s);
  } },
  { p: 'transport input ssh telnet', run: (s) => ((cfgOf(s).svc.ssh = true), (cfgOf(s).svc.telnet = true), changed(s)) },
  { p: 'transport input telnet ssh', run: (s) => ((cfgOf(s).svc.ssh = true), (cfgOf(s).svc.telnet = true), changed(s)) },
  { p: 'login [local]', run: () => '' },
  { p: 'password $word:pw', run: () => '' },
  { p: 'exec-timeout $num:m [$num:s]', run: () => '' },
  { p: 'logging synchronous', run: () => '' },
  { p: 'access-class $word:acl in', run: () => '' },
];

// =============================================================================================
// Exec commands
function pingCmd(s, a) {
  const ip = a.target;
  if (!isIp(ip)) {
    return '% Unrecognized host or address, or protocol not running.';
  }
  const count = a.repeat || 5;
  const size = a.size || 100;
  const p = ping(s, ip, { count, size, df: a.has('df-bit'), src: a.source ? resolveSrc(s, a.source) : null, vrf: a.vrf || null });
  const chunks = [{ d: 10, t: `Type escape sequence to abort.\nSending ${count}, ${size}-byte ICMP Echos to ${ip}, timeout is 2 seconds:\n` }];
  if (a.source) chunks.push({ d: 0, t: `Packet sent with a source address of ${p.srcIp}\n` });
  const remote = p.r.at && p.r.at !== s.dev.id && /no route|unreachable|not a router|denied by ACL/.test(p.r.reason || '');
  let line = '';
  p.res.forEach((x, i) => {
    const ch = x.ok ? '!' : remote && i % 2 === 0 ? 'U' : p.r.reason?.startsWith('fragmentation') ? 'M' : '.';
    line += ch;
    chunks.push({ d: x.ok || ch === 'U' || ch === 'M' ? 60 + (x.rtt || 1) * 2 : 700, t: ch });
    if (line.length % 70 === 0) chunks.push({ d: 0, t: '\n' });
  });
  chunks.push({ d: 0, t: `\nSuccess rate is ${p.pct} percent (${p.recv}/${p.sent})${p.recv ? `, round-trip min/avg/max = ${p.min}/${p.avg}/${p.max} ms` : ''}\n` });
  return stream(chunks, { onInterrupt: () => `\nSuccess rate is ${p.pct} percent (${p.recv}/${p.sent})\n` });
}
function resolveSrc(s, src) {
  if (isIp(src)) return src;
  const n = resolveIf(s.dev, src);
  return n ? ipOnly(s.dev.cfg.ifs[n].ip) : null;
}
function traceCmd(s, a) {
  if (!isIp(a.target)) return '% Unrecognized host or address, or protocol not running.';
  const { hops } = trace(s, a.target, { vrf: a.vrf || null });
  const chunks = [{ d: 10, t: `Type escape sequence to abort.\nTracing the route to ${a.target}\nVRF info: (vrf in name/id, vrf out name/id)\n` }];
  let n = 0;
  for (const h of hops) {
    n++;
    if (h.ok) chunks.push({ d: 300, t: `  ${n} ${h.ip} ${n} msec ${n} msec ${n + 1} msec\n` });
    else {
      for (let k = n; k < n + 5; k++) chunks.push({ d: 1200, t: `  ${k}  *  *  * \n` });
      break;
    }
  }
  return stream(chunks);
}

function doWrite(s) {
  saveStartup(s.dev, s.world.time.t);
  logEvent(s.world, s.dev.id, { type: 'save', by: s.user });
  return stream([{ d: 10, t: 'Building configuration...\n' }, { d: 700, t: '[OK]\n' }]);
}
function doReload(s) {
  const go = () => {
    const dev = s.dev;
    reload(s.world, dev, { reason: 'Reload Command' });
    if (s.via === 'console') {
      const lines = [`\n${fmtDate(s.world.time.t, 'cisco')}: %SYS-5-RELOAD: Reload requested by ${s.user} on console. Reload Reason: Reload Command.`, '', 'System Bootstrap, Version 15.0(1r)M15, RELEASE SOFTWARE (fc1)', 'Technical Support: http://www.cisco.com/techsupport', 'Copyright (c) 2011 by cisco Systems, Inc.', '', 'Initializing memory for ECC', '..........', `c${dev.model} platform with 524288 Kbytes of main memory`, 'Main memory is configured to 72 bit mode with ECC enabled', '', 'Readonly ROMMON initialized', `program load complete, entry point: 0x80803000, size: 0x1b340`, '', '##########################################################################', '', '              Restricted Rights Legend', '', 'Use, duplication, or disclosure by the Government is', 'subject to restrictions as set forth in subparagraph', '(c) of the Commercial Computer Software - Restricted', '', `Cisco IOS Software, Version ${dev.version}, RELEASE SOFTWARE`];
      s.booting = true;
      return stream(lines.map((t, i) => ({ d: i < 3 ? 400 : 250, t: t + '\n' })), { then: () => '\n\nPress RETURN to get started!\n' });
    }
    s.closed = true;
    return `\n${fmtDate(s.world.time.t, 'cisco')}: %SYS-5-RELOAD: Reload requested by ${s.user} on vty0 (10.250.0.10). Reload Reason: Reload Command.\nConnection to ${s.world.design.mgmt[dev.id]} closed by remote host.`;
  };
  const confirm = () => ask('Proceed with reload? [confirm]', (x) => (x.trim() === '' || /^y/i.test(x) ? go() : ''));
  if (unsaved(s.dev)) return ask('System configuration has been modified. Save? [yes/no]: ', (x) => {
    if (/^y/i.test(x.trim())) {
      saveStartup(s.dev, s.world.time.t);
      return { ...confirm(), pre: 'Building configuration...\n[OK]\n' };
    }
    if (/^n/i.test(x.trim())) return confirm();
    return '% Please answer \'yes\' or \'no\'.';
  });
  return confirm();
}
function showCheckpoints(s) {
  const dev = s.dev;
  const files = Object.entries(dev.run.checkpoints || {});
  const out = [`Directory of flash:/`, '', `    1  -rw-    ${String(48000000 + (hashStr(dev.version) % 9000000)).padStart(10)}  ${fmtDate(dev.installed, 'human')}  ${dev.model}-universalk9.${String(dev.version).replace(/[()]/g, '.')}.bin`];
  files.forEach(([n, c], i) => out.push(`    ${i + 2}  -rw-    ${String(JSON.stringify(c.cfg).length).padStart(10)}  ${fmtDate(c.t, 'human')}  ${n}`));
  out.push('', '128000000 bytes total (64003072 bytes free)');
  return out;
}

export function buildExec(xe) {
  const show = [
    { p: 'show version', run: (s) => showVersion(s) },
    { p: 'show clock [detail]', run: (s) => showClock(s) },
    { p: 'show users', run: (s) => ['    Line       User       Host(s)              Idle       Location', `*  2 vty 0     ${padR(s.user, 11)}idle                 00:00:00 ${s.via === 'console' ? '' : '10.250.0.10'}`, '', '  Interface    User               Mode         Idle     Peer Address'] },
    { p: 'show history', run: (s) => s.term.history.slice(-20).map((x) => `  ${x}`) },
    { p: 'show interfaces [$if:if]', run: (s, a) => showInterfaces(s, a.if) },
    { p: 'show interfaces status [err-disabled]', run: (s, a) => (isSw(s.dev) ? showIntStatus(s, a.has('err-disabled') ? 'err-disabled' : null) : '% Invalid input detected') },
    { p: 'show interfaces trunk', run: (s) => showIntTrunk(s) },
    { p: 'show interfaces $if:if switchport', run: (s, a) => showSwitchport(s, a.if) },
    { p: 'show interfaces $if:if {status|trunk}', run: (s, a) => (a.has('status') ? showIntStatus(s).filter((l, i) => i < 2 || l.startsWith(shortType(s.dev, a.if) + ' ')) : showIntTrunk(s)) },
    { p: 'show interfaces description', run: (s) => showIntDesc(s) },
    { p: 'show interfaces counters errors', run: (s) => showCountersErrors(s) },
    { p: 'show interfaces [$if:if] transceiver [detail]', run: (s, a) => showTransceiver(s, a.if, a.has('detail')) },
    { p: 'show ip interface brief', run: (s) => showIpIntBrief(s) },
    { p: 'show ip interface [$if:if]', run: (s, a) => sortedIfs(s.dev, (i, n) => !a.if || n === a.if).flatMap((n) => {
      const i = s.dev.cfg.ifs[n];
      const w = ifStatusWord(s, s.dev, n);
      return [`${n} is ${w.st}, line protocol is ${w.pr}`, i.ip ? `  Internet address is ${i.ip}` : '  Internet protocol processing disabled', ...(i.ip ? [`  Broadcast address is 255.255.255.255`, `  MTU is ${i.mtu || 1500} bytes`, `  Helper address is ${i.helper?.length ? i.helper.join(', ') : 'not set'}`, `  Outgoing Common access list is not set`, `  Outgoing access list is ${i.acl?.out || 'not set'}`, `  Inbound Common access list is not set`, `  Inbound  access list is ${i.acl?.in || 'not set'}`, '  Proxy ARP is enabled', `  IP fast switching is enabled`] : [])];
    }) },
    { p: 'show ip route [vrf $word:vrf] [{connected|static|ospf|bgp}]', run: (s, a) => showIpRoute(s, { vrf: a.vrf, proto: a.kw.find((k) => ['connected', 'static', 'ospf', 'bgp'].includes(k)) }) },
    { p: 'show ip route [vrf $word:vrf] $ip:ip', run: (s, a) => showIpRoute(s, { vrf: a.vrf, ip: a.ip }) },
    { p: 'show ip route summary', run: (s) => ['IP routing table name is default (0x0)', `Route Source    Networks    Subnets     Replicates  Overhead    Memory (bytes)`, ...['connected', 'static', 'ospf', 'bgp'].map((p) => `${padR(p, 16)}${padR(0, 12)}${padR((S_(s.world).rib[s.dev.id]?.best || []).filter((r) => r.proto.startsWith(p.slice(0, 4)) || (p === 'connected' && r.proto === 'local')).length, 12)}0           0           0`)] },
    { p: 'show ip protocols', run: (s) => showIpProtocols(s) },
    { p: 'show ip ospf', run: (s) => (s.dev.cfg.ospf.on ? [` Routing Process "ospf ${s.dev.cfg.ospf.pid}" with ID ${s.dev.cfg.ospf.rid || '0.0.0.0'}`, ' Start time: 00:00:12.345, Time elapsed: ' + upCisco(uptimeMins(s.world, s.dev)), ' Supports only single TOS(TOS0) routes', ` Reference bandwidth unit is ${s.dev.cfg.ospf.ref || 100} mbps`, '    Area BACKBONE(0)', `        Number of interfaces in this area is ${Object.values(s.dev.cfg.ifs).filter((i) => i.ospf?.area != null).length}`, '        Area has no authentication'] : ['%OSPF: Router process not running']) },
    { p: 'show ip ospf neighbor [detail]', run: (s) => showOspfNbr(s) },
    { p: 'show ip ospf interface [brief]', run: (s, a) => showOspfInt(s, a.has('brief')) },
    { p: 'show ip ospf interface $if:if', run: (s, a) => showOspfInt(s, false).join('\n').split(/\n(?=\S)/).filter((b) => b.startsWith(a.if + ' ')).join('\n') || [`%OSPF: OSPF not enabled on ${a.if}`] },
    { p: 'show ip ospf database', run: (s) => [`            OSPF Router with ID (${s.dev.cfg.ospf.rid}) (Process ID ${s.dev.cfg.ospf.pid})`, '', '                Router Link States (Area 0)', '', 'Link ID         ADV Router      Age         Seq#       Checksum Link count', ...Object.values(S_(s.world).ospf).filter(Boolean).map((_, i) => `${padR(`10.255.0.${i + 1}`, 16)}${padR(`10.255.0.${i + 1}`, 16)}${padR(300 + i * 17, 12)}0x80000${String(10 + i).padStart(3, '0')} 0x00${(4000 + i * 991).toString(16)}   ${3 + i}`)] },
    { p: 'show ip bgp summary', run: (s) => showBgpSum(s) },
    { p: 'show ip bgp', run: (s) => showBgp(s) },
    { p: 'show ip bgp neighbors [$ip:ip]', run: (s, a) => (S_(s.world).bgp[s.dev.id] || []).filter((r) => !a.ip || r.ip === a.ip).flatMap((r) => [`BGP neighbor is ${r.ip},  remote AS ${r.ras}, external link`, `  BGP version 4, remote router ID ${r.up ? r.ip : '0.0.0.0'}`, `  BGP state = ${r.state}${r.up ? `, up for ${upCisco(600)}` : ''}`, ...(r.reason ? [`  Last reset never, due to ${r.reason}`] : []), ...(r.notify ? [`  Notification received: ${r.notify}`] : []), '']) },
    { p: 'show ip arp', run: (s) => showArp(s) },
    { p: 'show arp', run: (s) => showArp(s) },
    { p: 'show ip nat translations', run: (s) => (s.dev.cfg.nat ? showNat(s) : ['']) },
    { p: 'show ip nat statistics', run: (s) => (s.dev.cfg.nat ? showNat(s, true) : ['']) },
    { p: 'show access-lists [$word:name]', run: (s) => showAcl(s) },
    { p: 'show ip access-lists [$word:name]', run: (s) => showAcl(s) },
    { p: 'show vlan [brief]', run: (s, a) => (isSw(s.dev) ? showVlan(s, a.has('brief')) : '% Invalid input detected') },
    { p: 'show vlan id $num(1-4094):v', run: (s, a) => showVlan(s, true).filter((l, i) => i < 3 || l.startsWith(`${a.v} `)) },
    { p: 'show spanning-tree [vlan $num(1-4094):v]', run: (s, a) => (isSw(s.dev) ? showStp(s, a.v) : '% Invalid input detected') },
    { p: 'show spanning-tree blockedports', run: (s) => showStp(s, null, true) },
    { p: 'show spanning-tree summary', run: (s) => [`Switch is in ${s.dev.cfg.stp.mode} mode`, `Root bridge for: ${Object.keys(s.dev.cfg.vlans).filter((v) => stpInfo(s, s.dev, Number(v)).isRoot).map((v) => `VLAN${String(v).padStart(4, '0')}`).join(', ') || 'none'}`, 'EtherChannel misconfig guard            is enabled', 'Extended system ID                      is enabled', 'Portfast Default                        is disabled', `PortFast BPDU Guard Default             is disabled`, 'Loopguard Default                       is disabled'] },
    { p: 'show etherchannel summary', run: (s) => showEtherchannel(s) },
    { p: 'show standby [brief]', run: (s, a) => showStandby(s, a.has('brief')) },
    { p: 'show vrrp [brief]', run: (s) => showVrrp(s) },
    { p: 'show mac address-table [{dynamic|static}] [vlan $num(1-4094):vlan] [interface $if:if]', run: (s, a) => showMac(s, a) },
    { p: 'show mac address-table interface $if:if', run: (s, a) => showMac(s, a) },
    { p: 'show cdp neighbors [detail]', run: (s, a) => showCdp(s, a.has('detail')) },
    { p: 'show lldp neighbors [detail]', run: (s) => showLldp(s) },
    { p: 'show environment [all]', run: (s) => showEnv(s) },
    { p: 'show inventory', run: (s) => showInventory(s) },
    { p: 'show processes cpu [sorted] [history]', run: (s) => showProc(s) },
    { p: 'show logging', run: (s) => showLogging(s) },
    { p: 'show terminal', run: (s) => [`Line 2, Location: "", Type: "XTERM"`, `Length: ${s.termLen} lines, Width: 80 columns`] },
    { p: 'show debugging', run: (s) => (s.vars.debug?.length ? s.vars.debug.map((d) => `OSPF ${d} debugging is on`) : ['']) },
    { p: 'show ip ssh', run: (s) => [`SSH ${s.dev.cfg.svc.ssh ? 'Enabled' : 'Disabled'} - version 2.0`, 'Authentication methods:publickey,keyboard-interactive,password', 'Authentication timeout: 120 secs; Authentication retries: 3'] },
    { p: 'show ntp status', run: (s) => (s.dev.cfg.svc.ntp.length && ping(s, s.dev.cfg.svc.ntp[0], { count: 1 }).r.ok ? [`Clock is synchronized, stratum 3, reference is ${s.dev.cfg.svc.ntp[0]}`, 'nominal freq is 250.0000 Hz, actual freq is 250.0001 Hz, precision is 2**10'] : ['Clock is unsynchronized, stratum 16, no reference clock']) },
    { p: 'show ntp associations', run: (s) => ['  address         ref clock       st   when   poll reach  delay  offset   disp', ...s.dev.cfg.svc.ntp.map((n) => (ping(s, n, { count: 1 }).r.ok ? `*~${padR(n, 16)}.GPS.            2     36     64   377  1.023   0.112  0.893` : ` ~${padR(n, 16)}.INIT.          16      -     64     0  0.000   0.000 15937.`)), ' * sys.peer, # selected, + candidate, - outlyer, x falseticker, ~ configured'] },
    { p: 'show flash: [all]', run: (s) => showCheckpoints(s) },
  ];
  const userExec = [
    ...show.filter((c) => !/running|startup|logging|access-lists|debugging/.test(c.p)),
    { p: 'enable', run: (s) => {
      if ((s.priv ?? 15) >= 15 || s.via === 'console' && !s.dev.cfg.svc.enable) {
        s.mode = 'priv';
        return '';
      }
      let tries = 0;
      const chk = (pw) => {
        if (pw === s.dev.cfg.svc.enable) {
          s.mode = 'priv';
          return '';
        }
        tries++;
        if (tries >= 3) return '% Bad secrets\n';
        return ask('Password: ', chk, { hidden: true });
      };
      if (!s.dev.cfg.svc.enable) return '% No password set';
      return ask('Password: ', chk, { hidden: true });
    } },
    { p: '{exit|logout|quit}', run: (s) => ((s.closed = true), '') },
    { p: 'ping [vrf $word:vrf] $host:target [repeat $num(1-2147483647):repeat] [size $num(36-18024):size] [df-bit] [source $word:source]', run: pingCmd, help: { $target: 'Ping destination address or hostname' } },
    { p: 'traceroute [vrf $word:vrf] $host:target', run: traceCmd },
    { p: 'terminal length $num(0-512):n', run: (s, a) => ((s.termLen = a.n), '') },
    { p: 'terminal monitor', run: (s) => ((s.monitor = true), '') },
    { p: 'terminal no monitor', run: (s) => ((s.monitor = s.via === 'console'), '') },
    { p: 'show privilege', run: (s) => `Current privilege level is ${s.mode === 'priv' ? 15 : 1}` },
  ];
  const priv = [
    ...show,
    { p: 'show running-config [all]', run: (s) => runningConfig(s, s.dev) },
    { p: 'show running-config interface $if:if', run: (s, a) => runningConfig(s, s.dev, s.dev.cfg, { iface: a.if }) },
    { p: 'show running-config | section $line:x', run: (s) => runningConfig(s, s.dev), hidden: true },
    { p: 'show startup-config', run: (s) => (s.dev.startup ? ['Using ' + JSON.stringify(s.dev.startup).length + ' out of 524288 bytes', ...runningConfig(s, s.dev, s.dev.startup).slice(3)] : 'startup-config is not present') },
    { p: 'show archive', run: (s) => ['The maximum archive configurations allowed is 10.', 'There are currently ' + Object.keys(s.dev.run.checkpoints || {}).length + ' archive configurations saved.', 'Archive #  Name', ...Object.keys(s.dev.run.checkpoints || {}).map((n, i) => `   ${i + 1}       flash:${n}`)] },
    { p: 'dir [flash:]', run: (s) => showCheckpoints(s) },
    { p: 'disable', run: (s) => ((s.mode = 'user'), '') },
    { p: 'configure [terminal]', run: (s) => {
      s.mode = 'config';
      s.ctx = {};
      return 'Enter configuration commands, one per line.  End with CNTL/Z.';
    } },
    { p: 'copy running-config startup-config', run: (s) => ask('Destination filename [startup-config]? ', () => doWrite(s)) },
    { p: 'copy running-config flash:$word:file', run: (s, a) => ask(`Destination filename [${a.file}]? `, () => {
      s.dev.run.checkpoints = s.dev.run.checkpoints || {};
      s.dev.run.checkpoints[a.file] = { t: s.world.time.t, cfg: JSON.parse(JSON.stringify(s.dev.cfg)) };
      return `${JSON.stringify(s.dev.cfg).length} bytes copied in 0.412 secs`;
    }) },
    { p: 'copy startup-config running-config', run: (s) => ask('Destination filename [running-config]? ', () => {
      if (!s.dev.startup) return '%Error opening nvram:/startup-config (No such file or directory)';
      s.dev.cfg = JSON.parse(JSON.stringify(s.dev.startup));
      changed(s);
      configEnded(s);
      return `${JSON.stringify(s.dev.startup).length} bytes copied in 0.208 secs`;
    }) },
    { p: 'configure replace flash:$word:file [force]', run: (s, a) => {
      const cp = s.dev.run.checkpoints?.[a.file];
      if (!cp) return `%Error opening flash:${a.file} (No such file or directory)`;
      const apply = () => {
        s.dev.cfg = JSON.parse(JSON.stringify(cp.cfg));
        changed(s);
        configEnded(s);
        return 'Total number of passes: 1\nRollback Done';
      };
      if (a.has('force')) return apply();
      return ask('This will apply all necessary additions and deletions\nto replace the current running configuration with the\ncontents of the specified configuration file, which is\nassumed to be a complete configuration, not a partial\nconfiguration. Enter Y if you are sure you want to proceed. ? [no]: ', (x) => (/^y/i.test(x) ? apply() : ''));
    } },
    { p: 'write [memory]', run: (s) => doWrite(s) },
    { p: 'write erase', run: (s) => ask('Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]', (x) => {
      if (x.trim() && !/^y/i.test(x)) return '';
      s.dev.startup = null;
      return '[OK]\nErase of nvram: complete';
    }) },
    { p: 'write terminal', run: (s) => runningConfig(s, s.dev) },
    { p: 'reload', run: (s) => doReload(s) },
    { p: 'clear counters [$if:if]', run: (s, a) => ask(`Clear "show interface" counters on ${a.if ? 'this interface' : 'all interfaces'} [confirm]`, () => (clearCounters(s.world, s.dev, a.if || null), '')) },
    { p: 'clear ip ospf process', run: (s) => ask('Reset ALL OSPF processes? [no]: ', (x) => {
      if (!/^y/i.test(x)) return '';
      for (const nb of S_(s.world).ospf[s.dev.id]?.nbrs || []) logEvent(s.world, s.dev.id, { type: 'ospf', if: nb.if, nbr: nb.rid, from: 'FULL', to: 'DOWN', why: 'Interface down or detached' });
      s.world.lastSnap = null;
      recompute(s.world);
      return '';
    }) },
    { p: 'clear ip bgp {*|$ip:ip} [soft]', run: (s) => {
      s.world.lastSnap = null;
      recompute(s.world);
      return '';
    } },
    { p: 'clear arp-cache', run: (s) => ((s.dev.run.arp = {}), '') },
    { p: 'clear mac address-table dynamic', run: () => '' },
    { p: 'clear logging', run: (s) => ask('Clear logging buffer [confirm]', () => ((s.dev.run.logs = []), '')) },
    { p: 'debug ip ospf {adj|hello|events}', run: (s, a) => debugOspf(s, a.kw[3]) },
    { p: '{undebug|no debug} all', run: (s) => ((s.vars.debug = []), 'All possible debugging has been turned off') },
    { p: 'undebug all', run: (s) => ((s.vars.debug = []), 'All possible debugging has been turned off') },
    { p: 'no debug all', run: (s) => ((s.vars.debug = []), 'All possible debugging has been turned off') },
    { p: 'show tech-support', run: (s) => [...showVersion(s), ...runningConfig(s, s.dev)] },
  ];
  return { userExec, priv };
}
function debugOspf(s, what) {
  s.vars.debug = [...new Set([...(s.vars.debug || []), what === 'adj' ? 'adjacency events' : what === 'hello' ? 'hello events' : 'events'])];
  const out = [`OSPF ${what === 'adj' ? 'adjacency events' : what === 'hello' ? 'hello events' : 'events'} debugging is on`];
  const dev = s.dev;
  const S = S_(s.world);
  const ts = () => fmtDate(s.world.time.t, 'cisco');
  for (const p of S.ospf[dev.id]?.problems || []) {
    const ifc = dev.cfg.ifs[p.if];
    const peerEp = S.eps.find((e) => e.ip === p.peer);
    const pIf = peerEp ? s.world.devices[peerEp.dev]?.cfg.ifs[peerEp.if] : null;
    if (/hello/.test(p.why) && what !== 'adj') out.push(`${ts()}: OSPF-1 HELLO ${shortType(dev, p.if)}: Rcv hello from ${p.peer} area ${areaDec(ifc.ospf.area)} ${p.peer}`, `${ts()}: OSPF-1 HELLO ${shortType(dev, p.if)}: Mismatched hello parameters from ${p.peer}`, `${ts()}: OSPF-1 HELLO ${shortType(dev, p.if)}: Dead R ${pIf?.ospf?.dead ?? 40} C ${ifc.ospf.dead ?? 40}, Hello R ${pIf?.ospf?.hello ?? 10} C ${ifc.ospf.hello ?? 10}  Mask R ${maskStr(lenOf(pIf?.ip || ifc.ip))} C ${maskStr(lenOf(ifc.ip))}`);
    if (/area/.test(p.why)) out.push(`${ts()}: OSPF-1 ADJ   ${shortType(dev, p.if)}: Rcv pkt from ${p.peer}, area ${areaDot(ifc.ospf.area)}, mismatched area ${areaDot(pIf?.ospf?.area ?? '0')} in the header`);
    if (/authentication/.test(p.why)) out.push(`${ts()}: OSPF-1 ADJ   ${shortType(dev, p.if)}: Rcv pkt from ${p.peer} : Mismatched Authentication Key - Clear Text`);
    if (/router-id/.test(p.why)) out.push(`${ts()}: %OSPF-4-DUP_RTRID_NBR: OSPF detected duplicate router-id ${dev.cfg.ospf.rid} from ${p.peer} on interface ${p.if}`);
  }
  for (const nb of S.ospf[dev.id]?.nbrs || []) if (nb.state === 'EXSTART' && what !== 'hello') out.push(`${ts()}: OSPF-1 ADJ   ${shortType(dev, nb.if)}: Nbr ${nb.rid} has larger interface MTU`, `${ts()}: OSPF-1 ADJ   ${shortType(dev, nb.if)}: Send DBD to ${nb.rid} seq 0x${(hashStr(nb.rid) % 65535).toString(16)} opt 0x52 flag 0x7 len 32`, `${ts()}: OSPF-1 ADJ   ${shortType(dev, nb.if)}: Retransmitting DBD to ${nb.rid} [${1 + (s.world.time.t % 9)}]`);
  return out;
}

// =============================================================================================
// Event formatting (syslog)
const UPDN = (b) => (b ? 'up' : 'down');
export function fmtEventIOS(e, dev, world) {
  const ts = `${fmtDate(e.t, 'cisco')}: `;
  const sh = (n) => (n ? shortIf(dev, n) : '');
  switch (e.type) {
    case 'link':
      if (e.kind === 'svi' || e.kind === 'lo') return null;
      return e.admin ? `${ts}%LINK-5-CHANGED: Interface ${e.if}, changed state to administratively down` : `${ts}%LINK-3-UPDOWN: Interface ${e.if}, changed state to ${UPDN(e.up)}`;
    case 'proto':
      return `${ts}%LINEPROTO-5-UPDOWN: Line protocol on Interface ${e.if}, changed state to ${UPDN(e.up)}`;
    case 'errdis':
      return `${ts}%SPANTREE-2-BLOCK_BPDUGUARD: Received BPDU on port ${e.if} with BPDU Guard enabled. Disabling port.\n${ts}%PM-4-ERR_DISABLE: bpduguard error detected on ${sh(e.if)}, putting ${sh(e.if)} in err-disable state`;
    case 'ospf':
      return `${ts}%OSPF-5-ADJCHG: Process ${dev.cfg.ospf.pid}, Nbr ${e.nbr} on ${e.if} from ${e.from} to ${e.to}, ${e.to === 'FULL' ? 'Loading Done' : e.why || 'Neighbor Down: Dead timer expired'}`;
    case 'ospfErr':
      return /area/.test(e.why) ? `${ts}%OSPF-4-ERRRCV: Received invalid packet: mismatched area ID from backbone area must be virtual-link but not found from ${e.from}, ${e.if}` : `${ts}%OSPF-4-ERRRCV: Received invalid packet: Bad authentication from ${e.from}, ${e.if}`;
    case 'bgp':
      if (e.up) return `${ts}%BGP-5-ADJCHANGE: neighbor ${e.nbr} Up `;
      if (/maximum-prefix/.test(e.why)) return `${ts}%BGP-4-MAXPFX: Number of prefixes received from ${e.nbr} (afi 0) reaches ${e.why.match(/\d+/)?.[0]}, max ${e.why.match(/\d+/)?.[0]}\n${ts}%BGP-3-MAXPFXEXCEED: Number of prefixes received from ${e.nbr} (afi 0): ${e.why.match(/\((\d+)/)?.[1]} exceeds limit ${e.why.match(/\d+/)?.[0]}\n${ts}%BGP-5-ADJCHANGE: neighbor ${e.nbr} Down BGP Notification sent\n${ts}%BGP-3-NOTIFICATION: sent to neighbor ${e.nbr} 6/1 (Maximum Number of Prefixes Reached) 7 bytes 00010100 0000`;
      if (e.notify) return `${ts}%BGP-3-NOTIFICATION: received from neighbor ${e.nbr} active 2/2 (peer in wrong AS) 2 bytes ${(e.ras || 0).toString(16).toUpperCase().padStart(4, '0')}\n${ts}%BGP-5-ADJCHANGE: neighbor ${e.nbr} Down BGP Notification received`;
      return `${ts}%BGP-5-ADJCHANGE: neighbor ${e.nbr} Down ${e.why ? e.why.replace(/^./, (c) => c.toUpperCase()) : 'Peer closed the session'}`;
    case 'fhrp': {
      const cap = (x) => ({ active: 'Active', standby: 'Standby', init: 'Init' })[x] || x;
      if (e.proto === 'vrrp') return `${ts}%VRRP-6-STATECHANGE: ${sh(e.if)} Grp ${e.grp} state ${e.from === 'active' ? 'Master' : 'Backup'} -> ${e.to === 'active' ? 'Master' : 'Backup'}`;
      return `${ts}%HSRP-5-STATECHANGE: ${e.if} Grp ${e.grp} state ${cap(e.from)} -> ${cap(e.to)}`;
    }
    case 'lacp':
      return e.state === 'P' ? `${ts}%EC-5-BUNDLE: Interface ${sh(e.if)} joined port-channel ${sh(e.lag)}` : e.state === 's' ? `${ts}%EC-5-L3DONTBNDL2: ${sh(e.if)} suspended: LACP currently not enabled on the remote port.` : `${ts}%EC-5-UNBUNDLE: Interface ${sh(e.if)} left the port-channel ${sh(e.lag)}`;
    case 'config':
      return `${ts}%SYS-5-CONFIG_I: Configured from ${e.via === 'console' ? 'console by ' + (e.by || 'console') + ' on console' : `console by ${e.by} on vty0 (${e.from || '10.250.0.10'})`}`;
    case 'save':
      return null;
    case 'login':
      return `${ts}%SEC_LOGIN-5-LOGIN_SUCCESS: Login Success [user: ${e.user}] [Source: ${e.from}] [localport: ${e.proto === 'telnet' ? 23 : 22}] at ${fmtDate(e.t, 'clock').replace(/\.\d+/, '')}`;
    case 'authfail':
      return `${ts}%SEC_LOGIN-4-LOGIN_FAILED: Login failed [user: ${e.user}] [Source: ${e.from}] [localport: ${e.proto === 'telnet' ? 23 : 22}] [Reason: Login Authentication Failed] at ${fmtDate(e.t, 'clock').replace(/\.\d+/, '')}`;
    case 'duplex':
      if (!e.peer) return null;
      return `${ts}%CDP-4-DUPLEX_MISMATCH: duplex mismatch discovered on ${e.if} (not ${e.theirs} duplex), with ${e.peer} ${e.peerIf} (${e.theirs} duplex).`;
    case 'native':
      return `${ts}%CDP-4-NATIVE_VLAN_MISMATCH: Native VLAN mismatch discovered on ${e.if} (${e.mine}), with ${e.peer} ${e.peerIf} (${e.theirs}).`;
    case 'macflap':
      return `${ts}%SW_MATM-4-MACFLAP_NOTIF: Host ${macCisco(e.mac)} in vlan ${e.vlan} is flapping between port ${sh(e.if1)} and port ${sh(e.if2)}`;
    case 'psu':
      return e.ok ? `${ts}%PLATFORM_ENV-6-FRU_PS_OIR: FRU Power Supply ${e.n} inserted` : `${ts}%PLATFORM_ENV-1-FRU_PS_FAIL: FRU Power Supply ${e.n} failure: No Input Power`;
    case 'fan':
      return e.ok ? `${ts}%PLATFORM_ENV-6-FAN_OK: Fan ${e.n} OK` : `${ts}%PLATFORM_ENV-1-FAN_NOT_PRESENT: Fan ${e.n} failure`;
    case 'temp':
      return `${ts}%ENVMON-1-CPU_WARNING_OVERTEMP: CPU temperature ${e.temp}C exceeds threshold ${e.limit}C. Please resolve system cooling to prevent system damage.`;
    case 'boot':
      return `${ts}%SYS-5-RESTART: System restarted --\nCisco IOS Software, Version ${e.version}\n${ts}%SNMP-5-COLDSTART: SNMP agent on host ${dev.hostname} is undergoing a cold start`;
    case 'optic':
      return `${ts}%SFF8472-5-THRESHOLD_VIOLATION: ${sh(e.if)}: Rx power low alarm; Operating value: ${e.rx.toFixed(1)} dBm, Threshold value: -14.0 dBm.`;
    case 'crash':
      return `${ts}%SYS-2-MALLOCFAIL: Memory allocation of 65536 bytes failed from 0x6034A8B0, alignment 0\nPool: Processor  Free: 12344  Cause: Memory fragmentation\n${ts}%SYS-3-CPUHOG: Task is running for (2004)msecs, more than (2000)msecs (0/0),process = IP Input.`;
    default:
      return null;
  }
}

// =============================================================================================
// Dialect
export function makeIOS(xe) {
  const { userExec, priv } = buildExec(xe);
  const kw = KW;
  const ifc = ifCmds(xe);
  const g = globalCfg(xe);
  const common = [
    { p: 'end', run: (s) => ((s.mode = 'priv'), (s.ctx = {}), configEnded(s), '') },
    { p: 'exit', run: (s) => {
      if (s.mode === 'config') {
        s.mode = 'priv';
        configEnded(s);
      } else s.mode = 'config';
      s.ctx = {};
      return '';
    } },
    { p: 'do $line:cmd', run: (s, a) => {
      const keep = s.mode;
      const ctx = s.ctx;
      s.mode = 'priv';
      const r = s.exec(a.cmd);
      if (s.mode === 'priv') s.mode = keep;
      s.ctx = ctx;
      return r.stream || r.ask ? r.stream || r.ask : r.text.replace(/\n$/, '');
    } },
  ];
  const tries = {
    user: compile(userExec, kw),
    priv: compile(priv.concat(userExec.filter((c) => !/^enable|show/.test(c.p))), kw),
    config: compile([...g, ...common], kw),
    if: compile([...ifc, ...common], kw),
    subif: compile([...ifc.filter((c) => /^(no )?(description|shutdown|ip |encapsulation|standby|vrrp)/.test(c.p)), ...common], kw),
    vlan: compile([{ p: 'name $word:name', run: (s, a) => { for (const v of s.ctx.vlans) cfgOf(s).vlans[v] = a.name; changed(s); } }, { p: 'no name', run: (s) => { for (const v of s.ctx.vlans) cfgOf(s).vlans[v] = `VLAN${String(v).padStart(4, '0')}`; changed(s); } }, ...common], kw),
    ospf: compile([...ospfCfg, ...common], kw),
    bgp: compile([...bgpCfg, ...common], kw),
    extacl: compile([...aclCfg(false), ...common], kw),
    stdacl: compile([...aclCfg(true), ...common], kw),
    line: compile([...lineCfg, ...common], kw),
  };
  const PROMPT = { config: '(config)', if: '(config-if)', subif: '(config-subif)', vlan: '(config-vlan)', ospf: '(config-router)', bgp: '(config-router)', extacl: '(config-ext-nacl)', stdacl: '(config-std-nacl)', line: '(config-line)' };
  return {
    id: xe ? 'iosxe' : 'ios',
    startMode: 'user',
    pipes: ['include', 'exclude', 'begin', 'section', 'count'],
    defaultLen: 24,
    more: ' --More-- ',
    init(s) {
      s.mode = s.via !== 'console' && (s.priv ?? 1) >= 15 ? 'priv' : 'user';
    },
    prompt(s) {
      if (s.dev.state !== 'up') return '';
      const h = s.dev.cfg.hostname;
      if (s.mode === 'user') return `${h}>`;
      if (s.mode === 'priv') return `${h}#`;
      return `${h}${PROMPT[s.mode] || '(config)'}#`;
    },
    greeting(s) {
      const motd = s.dev.cfg.svc.motd ? `\n${s.dev.cfg.svc.motd}\n` : '';
      return motd;
    },
    telnetBanner(dev) {
      return `${dev.cfg.svc.motd ? `\n${dev.cfg.svc.motd}\n` : ''}\n\nUser Access Verification\n\n`;
    },
    loginPrompt: () => 'Username: ',
    closeMsg(s) {
      if (s.via === 'console') return '\n[Disconnected from console server]\n';
      return `Connection to ${s.world.design.mgmt[s.dev.id] || s.dev.hostname} closed.\n`;
    },
    preprocess(s, line) {
      if (s.dev.state === 'off') return '';
      if (s.dev.state === 'booting') return '';
      if (s.booting) {
        s.booting = false;
        s.mode = 'user';
        return '';
      }
      if (line.trim() === '~.') {
        s.closed = true;
        return '';
      }
      return undefined;
    },
    emptyLine: () => '',
    trie: (s, mode) => tries[mode] || tries.priv,
    fallback(s) {
      if (['if', 'subif', 'vlan', 'ospf', 'bgp', 'extacl', 'stdacl', 'line'].includes(s.mode)) return ['config'];
      return [];
    },
    matchIf(s, toks, i, create) {
      const dev = s.dev;
      const v = toks[i].v;
      const sub = v.match(/^(.*)\.(\d+)$/);
      if (sub && create) {
        const base = resolveIf(dev, sub[1]);
        if (base) return { val: `${base}.${sub[2]}`, n: 1 };
      }
      let r = resolveIf(dev, v, { allowCreate: create });
      if (r) return { val: r, n: 1 };
      if (/^[A-Za-z-]+$/.test(v) && toks[i + 1] && /^\d/.test(toks[i + 1].v)) {
        r = resolveIf(dev, v + toks[i + 1].v, { allowCreate: create });
        if (r) return { val: r, n: 2 };
        const sub2 = toks[i + 1].v.match(/^(.*)\.(\d+)$/);
        if (sub2 && create) {
          const base = resolveIf(dev, v + sub2[1]);
          if (base) return { val: `${base}.${sub2[2]}`, n: 2 };
        }
      }
      if (/^null0?$/i.test(v)) return { val: 'Null0', n: 1 };
      return null;
    },
    ifTypeHelp(s, create) {
      const types = create ? ifTypesPresent(s.dev) : [...new Set(Object.keys(s.dev.cfg.ifs).map((n) => splitIf(n)[0]))];
      const H = { Ethernet: 'IEEE 802.3', FastEthernet: 'FastEthernet IEEE 802.3', GigabitEthernet: 'GigabitEthernet IEEE 802.3z', TenGigabitEthernet: 'Ten Gigabit Ethernet', TwentyFiveGigE: 'Twenty Five Gigabit Ethernet', FortyGigabitEthernet: 'Forty Gigabit Ethernet', HundredGigE: 'Hundred Gigabit Ethernet', Serial: 'Serial', Vlan: 'Catalyst Vlans', Loopback: 'Loopback interface', 'Port-channel': 'Ethernet Channel of interfaces', Tunnel: 'Tunnel interface', Null: 'Null interface' };
      return types.map((t) => [t, H[t] || t]);
    },
    ifNames: (s) => Object.keys(s.dev.cfg.ifs),
    helpFmt(s, items, cr, partial) {
      if (partial && !items.length) return '% Unrecognized command';
      const w = Math.max(...items.map(([k]) => k.length), 4) + 2;
      if (partial) {
        // "sh?" style: list words on one line
        return items.map(([k]) => k).join('  ');
      }
      const out = items.map(([k, h]) => `  ${padR(k, w)}${h}`);
      if (cr) out.push('  <cr>');
      return out.join('\n');
    },
    error(s, kind, x) {
      const promptLen = s.prompt.length;
      if (kind === 'ambiguous') return `% Ambiguous command:  "${x.line}"`;
      if (kind === 'incomplete') return '% Incomplete command.\n';
      if (kind === 'pipe') return '% Invalid input detected at \'^\' marker.';
      return `${' '.repeat(promptLen + x.pos)}^\n% Invalid input detected at '^' marker.\n`;
    },
    onUnknown(s, line, toks, res) {
      // IOS treats a single unknown word at exec level as a hostname to telnet to
      if ((s.mode === 'user' || s.mode === 'priv') && toks.length === 1 && res.kind === 'invalid' && res.at === 0) {
        const name = toks[0].v;
        if (s.dev.cfg.svc.domainLookup) return stream([{ d: 10, t: `Translating "${name}"...domain server (255.255.255.255)\n` }, { d: 4500, t: ' (255.255.255.255)\nTranslating "' + name + '"...domain server (255.255.255.255)\n' }, { d: 4500, t: '% Bad IP address or host name\n% Unknown command or computer name, or unable to find computer address\n' }], { onInterrupt: () => '% Unknown command or computer name, or unable to find computer address\n' });
        return `Translating "${name}"\n% Unknown command or computer name, or unable to find computer address`;
      }
      return undefined;
    },
    ctrlC(s) {
      if (!['user', 'priv'].includes(s.mode)) {
        s.mode = 'priv';
        s.ctx = {};
        configEnded(s);
      }
      return '^C\n';
    },
    ctrlZ(s) {
      if (!['user', 'priv'].includes(s.mode)) {
        s.mode = 'priv';
        s.ctx = {};
        configEnded(s);
        return '^Z\n';
      }
      return '';
    },
    internalError: (s, e) => `%Software-forced reload (internal error: ${e.message})`,
    fmtEvent: fmtEventIOS,
    consoleLogin: false,
  };
}
export { showIpIntBrief, showInterfaces, showIntStatus, showIpRoute, showVlan, showStp, showEtherchannel, showLogging, showCdp, showLldp, showArp, showMac, showTransceiver, showOspfNbr, showBgpSum, ifStatusWord, duplexSpeed, ifCmds, globalCfg, ospfCfg, bgpCfg, aclCfg, lineCfg, pingCmd, traceCmd, doWrite, doReload, enterIf, setIp };
