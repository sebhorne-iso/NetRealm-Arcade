// Turns an abstract fix ("op") into the exact commands for a device's OS. Used for in-game hints
// and by the automated tests, which type these commands into the real simulated CLIs.
import { maskStr, n2ip, cidr } from '../core/util.js';

const ipOf = (dev, n) => dev.cfg.ifs[n]?.ip?.split('/')[0];
const ifu = (dev, n) => (dev.cfg.ifs[n]?.kind === 'svi' ? n : `${n}.0`);
const asn = (dev) => dev.cfg.bgp?.asn;
const vlanOfSvi = (dev, n) => dev.cfg.ifs[n]?.vlan;
const ospfPid = (dev) => dev.cfg.ospf?.pid || 1;

// Configuration-mode wrappers (enter, body, leave/save)
const WRAP = {
  ios: (b) => ['configure terminal', ...b, 'end', 'write memory'],
  iosxe: (b) => ['configure terminal', ...b, 'end', 'write memory'],
  nxos: (b) => ['configure terminal', ...b, 'end', 'copy running-config startup-config'],
  asa: (b) => ['configure terminal', ...b, 'end', 'write memory'],
  aoscx: (b) => ['configure terminal', ...b, 'end', 'write memory'],
  aoss: (b) => ['configure', ...b, 'end', 'write memory'],
  arubaos: (b) => ['configure terminal', ...b, 'end', 'write memory'],
  iosxr: (b) => ['configure', ...b, 'commit', 'end'],
  junos: (b) => ['configure', ...b, 'commit and-quit'],
  evo: (b) => ['configure', ...b, 'commit and-quit'],
  fortios: (b) => b,
  fortiswitch: (b) => b,
};
const IOSLIKE = ['ios', 'iosxe', 'nxos'];
const isJ = (os) => os === 'junos' || os === 'evo';

function body(w, dev, op) {
  const os = dev.os;
  const n = op.if;
  switch (op.op) {
    case 'ifUp':
      if (isJ(os)) return dev.cfg.ifs[n]?.kind === 'svi' ? [`delete interfaces irb unit ${vlanOfSvi(dev, n)} disable`] : [`delete interfaces ${n} disable`];
      if (os === 'aoss') return [`interface ${n} enable`];
      if (os === 'fortiswitch') return ['config switch physical-port', `edit ${n}`, 'set status up', 'next', 'end'];
      if (os === 'fortios') return ['config system interface', `edit ${n}`, 'set status up', 'next', 'end'];
      if (os === 'aoscx' && dev.cfg.ifs[n]?.kind === 'svi') return [`interface vlan ${vlanOfSvi(dev, n)}`, 'no shutdown'];
      return [`interface ${n}`, 'no shutdown'];
    case 'ifBounce':
      if (isJ(os)) return [`delete interfaces ${n} disable`];
      if (os === 'aoss') return [`interface ${n} disable`, `interface ${n} enable`];
      if (os === 'fortiswitch') return ['config switch physical-port', `edit ${n}`, 'set status down', 'next', `edit ${n}`, 'set status up', 'next', 'end'];
      return [`interface ${n}`, 'shutdown', 'no shutdown'];
    case 'accessVlan':
      if (IOSLIKE.includes(os)) return [`interface ${n}`, `switchport access vlan ${op.vlan}`];
      if (os === 'aoscx') return [`interface ${n}`, `vlan access ${op.vlan}`];
      if (os === 'aoss') return [`vlan ${op.vlan} untagged ${n}`];
      if (isJ(os)) return [`delete interfaces ${n} unit 0 family ethernet-switching vlan members`, `set interfaces ${n} unit 0 family ethernet-switching vlan members ${dev.cfg.vlans[op.vlan] || op.vlan}`];
      if (os === 'fortiswitch') return ['config switch interface', `edit ${n}`, `set native-vlan ${op.vlan}`, 'next', 'end'];
      return null;
    case 'createVlan':
      if (os === 'fortiswitch') return ['config switch vlan', `edit ${op.vlan}`, `set description "${op.name}"`, 'next', 'end'];
      return [`vlan ${op.vlan}`, `name ${op.name}`];
    case 'trunkAdd':
      if (IOSLIKE.includes(os)) return [`interface ${n}`, `switchport trunk allowed vlan add ${op.vlan}`];
      if (os === 'aoscx') return [`interface ${n}`, `vlan trunk allowed ${op.vlan}`];
      if (os === 'fortiswitch') {
        const cur = dev.cfg.ifs[n].sw.allowed;
        return ['config switch interface', `edit ${n}`, `set allowed-vlans ${[...new Set([...(cur === 'all' ? [] : cur), op.vlan])].sort((a, b) => a - b).join(' ')}`, 'next', 'end'];
      }
      return null;
    case 'duplexAuto':
      if (IOSLIKE.includes(os)) return [`interface ${n}`, 'speed auto', 'duplex auto'];
      if (os === 'aoscx') return [`interface ${n}`, 'speed auto'];
      if (os === 'aoss') return [`interface ${n}`, 'speed-duplex auto'];
      if (isJ(os)) return [`set interfaces ${n} ether-options speed auto`, `set interfaces ${n} ether-options link-mode automatic`];
      return null;
    case 'helper':
      if (os === 'nxos') return [`interface ${n}`, `ip dhcp relay address ${op.ip}`];
      if (os === 'aoscx') return [`interface vlan ${vlanOfSvi(dev, n)}`, `ip helper-address ${op.ip}`];
      if (os === 'aoss') return [`vlan ${vlanOfSvi(dev, n)}`, `ip helper-address ${op.ip}`];
      if (isJ(os)) return [`set forwarding-options dhcp-relay server-group DHCP ${op.ip}`, `set forwarding-options dhcp-relay group RELAY interface ${ifu(dev, n)}`];
      return [`interface ${n}`, `ip helper-address ${op.ip}`];
    case 'native':
      if (IOSLIKE.includes(os)) return [`interface ${n}`, `switchport trunk native vlan ${op.vlan}`];
      if (os === 'aoscx') return [`interface ${n}`, `vlan trunk native ${op.vlan}`];
      if (isJ(os)) return [`set interfaces ${n} native-vlan-id ${op.vlan}`];
      return null;
    case 'ospfTimers':
      if (os === 'iosxr') return [`router ospf ${ospfPid(dev)}`, `area ${areaOf(dev, n)}`, `interface ${n}`, 'no hello-interval', 'no dead-interval'];
      if (isJ(os)) return [`set protocols ospf area ${dev.cfg.ifs[n].ospf.area} interface ${ifu(dev, n)} hello-interval 10`, `set protocols ospf area ${dev.cfg.ifs[n].ospf.area} interface ${ifu(dev, n)} dead-interval 40`];
      if (os === 'fortios') return ['config router ospf', 'config ospf-interface', `edit "${n}"`, `set interface "${n}"`, 'set hello-interval 10', 'set dead-interval 40', 'next', 'end', 'end'];
      return [`interface ${n}`, 'no ip ospf hello-interval', 'no ip ospf dead-interval'];
    case 'ospfArea': {
      const ip = ipOf(dev, n);
      const c = cidr(dev.cfg.ifs[n].ip);
      if (os === 'ios' || os === 'iosxe') return [`router ospf ${ospfPid(dev)}`, `network ${ip} 0.0.0.0 area 0`];
      if (os === 'nxos') return [`interface ${n}`, `ip router ospf ${ospfPid(dev)} area 0.0.0.0`];
      if (os === 'aoscx') return [`interface ${n}`, `ip ospf ${ospfPid(dev)} area 0.0.0.0`];
      if (os === 'iosxr') return [`router ospf ${ospfPid(dev)}`, `area ${areaOf(dev, n)}`, `no interface ${n}`, 'exit', 'area 0', `interface ${n}`];
      if (isJ(os)) return [`delete protocols ospf area ${dev.cfg.ifs[n].ospf.area} interface ${ifu(dev, n)}`, `set protocols ospf area 0.0.0.0 interface ${ifu(dev, n)}`];
      if (os === 'asa') return [`router ospf ${ospfPid(dev)}`, `network ${n2ip(c.net)} ${maskStr(c.len)} area 0`];
      if (os === 'fortios') return ['config router ospf', 'config network', 'edit 99', `set prefix ${n2ip(c.net)} ${maskStr(c.len)}`, 'set area 0.0.0.0', 'next', 'end', 'end'];
      return null;
    }
    case 'mtu':
      if (os === 'asa') return [`mtu ${dev.cfg.ifs[n].nameif} ${op.mtu}`];
      if (os === 'iosxr') return [`interface ${n}`, 'no mtu'];
      if (isJ(os)) return [`set interfaces ${n} mtu ${op.mtu}`];
      if (os === 'fortios') return ['config system interface', `edit ${n}`, 'set mtu-override disable', 'next', 'end'];
      if (os === 'aoscx') return [`interface ${n}`, `mtu ${op.mtu}`];
      return [`interface ${n}`, `mtu ${op.mtu}`];
    case 'ospfPassiveOff':
      if (os === 'ios' || os === 'iosxe') return [`router ospf ${ospfPid(dev)}`, `no passive-interface ${n}`];
      if (os === 'nxos') return [`interface ${n}`, 'no ip ospf passive-interface'];
      if (os === 'aoscx') return [`interface ${n}`, 'no ip ospf passive'];
      if (os === 'iosxr') return [`router ospf ${ospfPid(dev)}`, `area ${areaOf(dev, n)}`, `interface ${n}`, 'passive disable'];
      if (isJ(os)) return [`delete protocols ospf area ${dev.cfg.ifs[n].ospf.area} interface ${ifu(dev, n)} passive`];
      if (os === 'asa') return [`router ospf ${ospfPid(dev)}`, `no passive-interface ${dev.cfg.ifs[n].nameif}`];
      if (os === 'fortios') {
        const keep = Object.entries(dev.cfg.ifs).filter(([x, i]) => x !== n && i.ospf?.passive && i.ospf.area != null).map(([x]) => `"${x}"`);
        return ['config router ospf', keep.length ? `set passive-interface ${keep.join(' ')}` : 'unset passive-interface', 'end'];
      }
      return null;
    case 'lagMode':
      if (IOSLIKE.includes(os)) return [...op.ifs.flatMap((m) => [`interface ${m}`, 'no channel-group']), ...op.ifs.flatMap((m) => [`interface ${m}`, `channel-group ${op.id} mode ${op.mode}`])];
      if (os === 'aoscx') return [`interface lag ${op.id}`, `lacp mode ${op.mode}`];
      if (isJ(os)) return [`set interfaces ae${op.id} aggregated-ether-options lacp ${op.mode}`];
      if (os === 'iosxr') return op.ifs.flatMap((m) => [`interface ${m}`, `bundle id ${op.id} mode ${op.mode}`]);
      return null;
    case 'fwPermit':
      if (os === 'asa') return [`access-list OUTSIDE_IN extended permit tcp any host ${op.ace.dst.split('/')[0]} eq https`];
      if (os === 'fortios') return ['config firewall policy', `edit ${op.pol}`, 'set status enable', 'next', 'end'];
      if (isJ(os)) return [`activate security policies from-zone untrust to-zone trust policy ${op.name}`];
      return null;
    case 'vipFix': {
      const v = dev.cfg.fw?.vip?.find((x) => x.cust === op.cust) || dev.cfg.nat?.statics?.find((x) => x.cust === op.cust);
      if (os === 'asa') {
        const legacy = (() => {
          const [maj, min] = String(dev.version).split(/[.(]/).map(Number);
          return maj < 8 || (maj === 8 && min < 3);
        })();
        if (legacy) return [`no static (inside,outside) ${v.ext} ${op.bad} netmask 255.255.255.255`, `static (inside,outside) ${v.ext} ${op.good} netmask 255.255.255.255`];
        return [`object network ${v.name}`, `host ${op.good}`, 'exit', `no access-list OUTSIDE_IN extended permit tcp any host ${op.bad} eq https`, `access-list OUTSIDE_IN extended permit tcp any host ${op.good} eq https`];
      }
      if (os === 'fortios') return ['config firewall vip', `edit "${v.name}"`, `set mappedip "${op.good}"`, 'next', 'end'];
      if (isJ(os)) return [`set security address-book global address ${v.name} ${op.good}/32`, `set security nat static rule-set STATIC rule ${v.name.toLowerCase().replace(/^vip-/, '')} then static-nat prefix ${op.good}/32`];
      if (IOSLIKE.includes(os)) return [`no ip nat inside source static ${op.bad} ${v.ext}`, `ip nat inside source static ${op.good} ${v.ext}`];
      return null;
    }
    case 'natEnable':
      if (os === 'asa') {
        const [maj, min] = String(dev.version).split(/[.(]/).map(Number);
        return maj < 8 || (maj === 8 && min < 3) ? ['global (outside) 1 interface'] : ['object network INSIDE-NETS', 'nat (inside,outside) dynamic interface'];
      }
      if (os === 'fortios') return ['config firewall policy', ...dev.cfg.fw.pol.filter((p) => p.to === 'outside').flatMap((p) => [`edit ${p.id}`, 'set nat enable', 'next']), 'end'];
      if (isJ(os)) return ['set security nat source rule-set trust-to-untrust rule snat then source-nat interface'];
      if (IOSLIKE.includes(os)) return [`ip nat inside source list ${dev.cfg.nat.list || 'NAT-INSIDE'} interface ${dev.cfg.nat.outside[0]} overload`];
      return null;
    case 'aclRemove':
      return [`interface ${n}`, `no ip access-group ${op.acl} ${op.dir}`];
    case 'ipRouting':
      return ['ip routing'];
    case 'stpEnable':
      if (os === 'aoscx') return ['spanning-tree'];
      return ['spanning-tree vlan 1-4094'];
    case 'bgpNoShut':
      if (os === 'ios' || os === 'iosxe') return [`router bgp ${asn(dev)}`, `no neighbor ${op.ip} shutdown`];
      if (os === 'nxos' || os === 'iosxr') return [`router bgp ${asn(dev)}`, `neighbor ${op.ip}`, 'no shutdown'];
      if (isJ(os)) return [`activate protocols bgp group TRANSIT neighbor ${op.ip}`];
      if (os === 'fortios') return ['config router bgp', 'config neighbor', `edit "${op.ip}"`, 'set shutdown disable', 'next', 'end', 'end'];
      return null;
    case 'bgpRemoteAs':
      if (os === 'ios' || os === 'iosxe') return [`router bgp ${asn(dev)}`, `neighbor ${op.ip} remote-as ${op.as}`];
      if (os === 'nxos' || os === 'iosxr') return [`router bgp ${asn(dev)}`, `neighbor ${op.ip}`, `remote-as ${op.as}`];
      if (isJ(os)) return [`set protocols bgp group TRANSIT neighbor ${op.ip} peer-as ${op.as}`];
      return null;
    case 'bgpMaxpfx':
      if (os === 'ios' || os === 'iosxe') return [`router bgp ${asn(dev)}`, `no neighbor ${op.ip} maximum-prefix`];
      if (os === 'nxos') return [`router bgp ${asn(dev)}`, `neighbor ${op.ip}`, 'no maximum-prefix'];
      if (os === 'iosxr') return [`router bgp ${asn(dev)}`, `neighbor ${op.ip}`, 'address-family ipv4 unicast', 'no maximum-prefix'];
      if (isJ(os)) return [`set protocols bgp group TRANSIT neighbor ${op.ip} family inet unicast prefix-limit maximum 2000000`];
      return null;
    case 'xrPolicy':
      return [`router bgp ${asn(dev)}`, `neighbor ${op.ip}`, 'address-family ipv4 unicast', `route-policy ${op.pol} in`];
    case 'ospfRid':
      if (isJ(os)) return [`set routing-options router-id ${op.rid}`];
      return [`router ospf ${ospfPid(dev)}`, `router-id ${op.rid}`];
    case 'staticFix': {
      if (os === 'ios' || os === 'iosxe' || os === 'aoss') return [`no ip route 0.0.0.0 0.0.0.0 ${op.bad}`, `ip route 0.0.0.0 0.0.0.0 ${op.good}`];
      if (os === 'nxos' || os === 'aoscx') return [`no ip route 0.0.0.0/0 ${op.bad}`, `ip route 0.0.0.0/0 ${op.good}`];
      if (isJ(os)) return [`delete routing-options static route 0.0.0.0/0 next-hop ${op.bad}`, `set routing-options static route 0.0.0.0/0 next-hop ${op.good}`];
      if (os === 'asa') return [`no route outside 0.0.0.0 0.0.0.0 ${op.bad} 1`, `route outside 0.0.0.0 0.0.0.0 ${op.good} 1`];
      if (os === 'fortios') {
        const idx = dev.cfg.static.findIndex((r) => r.pfx === '0.0.0.0/0' && r.nh === op.bad) + 1;
        return ['config router static', `edit ${idx}`, `set gateway ${op.good}`, 'next', 'end'];
      }
      return null;
    }
    case 'staticRemove': {
      const c = cidr(op.pfx);
      if (os === 'ios' || os === 'iosxe') return [`no ip route ${n2ip(c.net)} ${maskStr(c.len)} Null0`];
      if (os === 'nxos') return [`no ip route ${op.pfx}`];
      if (os === 'iosxr') return ['router static', 'address-family ipv4 unicast', `no ${op.pfx}`];
      if (isJ(os)) return [`delete routing-options static route ${op.pfx}`];
      if (os === 'fortios') return ['config router static', `delete ${dev.cfg.static.findIndex((r) => r.pfx === op.pfx) + 1}`, 'end'];
      if (os === 'aoscx') return [`no ip route ${op.pfx}`];
      return null;
    }
    default:
      return null;
  }
}
function areaOf(dev, n) {
  const a = dev.cfg.ifs[n]?.ospf?.area || '0.0.0.0';
  return a === '0.0.0.0' ? '0' : a;
}

const PHYS = {
  reseat: 'Floor > rack > device > port: "Reseat cable".',
  'replace-psu': 'Floor > rack > device: "Replace PSU" (uses a spare power supply).',
  'replace-fan': 'Floor > rack > device: "Replace fan tray" (uses a spare).',
  'remove-rogue': 'Floor > rack > device > port: "Remove unknown device" from the server cable.',
  'clean-optic': 'Floor > rack > device > port: "Clean optic" (or replace it with a spare).',
  'reset-breaker': 'Floor > rack: "Reset PDU breaker" - and check the rack load first.',
  'repair-cooling': 'Floor: click the failed cooling unit and "Repair".',
};

// Returns [{where, device, os, lines}] for a list of ops
export function recipe(w, ops) {
  const out = [];
  for (const op of ops) {
    if (op.op === 'phys') {
      out.push({ where: 'physical', text: PHYS[op.action] || op.action });
      continue;
    }
    if (op.op === 'server') {
      const h = w.hosts[op.host];
      out.push({ where: 'server', device: h?.name, lines: [`console ${h?.name}`, ...op.cmds, 'exit'] });
      continue;
    }
    if (op.op === 'firmware') {
      out.push({ where: 'change', text: 'Changes > New change > Firmware upgrade, then run it in a maintenance window.' });
      continue;
    }
    const dev = w.devices[op.dev];
    if (!dev) continue;
    const b = body(w, dev, op);
    if (!b) {
      out.push({ where: 'device', device: dev.hostname, os: dev.os, lines: null });
      continue;
    }
    const wrap = WRAP[dev.os] || WRAP.ios;
    out.push({ where: 'device', device: dev.hostname, os: dev.os, lines: wrap(b) });
  }
  // Merge consecutive steps on the same device into one session
  const merged = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && s.where === 'device' && last.where === 'device' && last.device === s.device && s.lines && last.lines) {
      const wrapLen = { iosxr: 2, junos: 1, evo: 1, fortios: 0, fortiswitch: 0 }[s.os] ?? 2;
      const skip = { fortios: 0, fortiswitch: 0 }[s.os] ?? 1;
      last.lines = [...last.lines.slice(0, last.lines.length - wrapLen), ...s.lines.slice(skip)];
    } else merged.push({ ...s });
  }
  return merged;
}
export { body as recipeBody, WRAP };
