// Fortinet FortiOS (FortiGate), FortiSwitchOS (standalone FortiSwitch) and the FortiAP shell.
// FortiOS has its own object model: config <section> / edit <key> / set|unset / next / end,
// with unique-prefix abbreviations ("get sys stat", "conf fire pol").
import { Session, stream, genStream, ask, tokenize } from './engine.js';
import { model } from '../net/catalog.js';
import { saveStartup } from '../net/model.js';
import { S_, cfgOf, changed, configEnded, ping, trace, counters, sortedIfs, physIfs, uptimeMins, ipOnly, lenOf, neighbours, macTable, macOfIf, arpTable } from './common.js';
import { lookup, walk } from '../net/sim.js';
import { reload } from '../net/devops.js';
import { logEvent, recompute } from '../net/events.js';
import { cidr, n2ip, maskStr, maskLen, isIp, isMask, inNet, fmtDate, fmtVlans, parseVlans, padR, padL, hashStr, yearOf, macColon } from '../core/util.js';

const qq = (v) => `"${v}"`;
const IPM = (c) => (c ? `${ipOnly(c)} ${maskStr(lenOf(c))}` : '0.0.0.0 0.0.0.0');
const SPEEDS = ['auto', '10half', '10full', '100half', '100full', '1000full', '10000full', '25000full', '40000full', '100000full'];
const zoneIfs = (cfg, z) => Object.keys(cfg.ifs).filter((n) => cfg.ifs[n].zone === z);
const fail = (tok, code = -61) => `command parse error before '${tok}'\nCommand fail. Return code ${code}`;
const valFail = (tok, code = -8) => `value parse error before '${tok}'\nCommand fail. Return code ${code}`;

function pick(word, options) {
  const w = String(word || '').toLowerCase();
  if (options.includes(w)) return w;
  const hits = options.filter((o) => o.startsWith(w));
  return hits.length === 1 ? hits[0] : hits.length > 1 ? { ambiguous: hits } : null;
}

// =============================================================================================
// Sections: list entries from canonical config, save edited objects back
const SECTIONS = {
  'system interface': {
    table: true,
    fields: { ip: 'Interface IPv4 address and subnet mask', status: 'Bring the interface up or shut the interface down', alias: 'Alias will be displayed with the interface name', allowaccess: 'Permitted types of management access to this interface', mtu: 'MTU value for this interface', 'mtu-override': 'Enable to set a custom MTU for this interface', speed: 'Interface speed', role: 'Interface role', vdom: 'Interface is in this virtual domain (VDOM)', type: 'Interface type', description: 'Description' },
    list: (cfg) => Object.keys(cfg.ifs).filter((n) => ['phys', 'mgmt', 'lag', 'lo', 'svi'].includes(cfg.ifs[n].kind)),
    get(s, cfg, k) {
      const i = cfg.ifs[k];
      if (!i) return null;
      return { vdom: 'root', ip: i.ip ? IPM(i.ip) : null, allowaccess: i.mgmt ? 'ping https ssh snmp' : i.zone === 'outside' ? 'ping' : i.ip ? 'ping' : null, status: i.on ? null : 'down', type: i.kind === 'lag' ? 'aggregate' : i.kind === 'svi' ? 'vlan' : i.kind === 'lo' ? 'loopback' : 'physical', alias: i.desc || null, role: i.zone === 'outside' ? 'wan' : i.zone === 'inside' ? 'lan' : null, 'mtu-override': i.mtu !== 1500 ? 'enable' : null, mtu: i.mtu !== 1500 ? i.mtu : null, speed: i.speed === 'auto' ? null : `${i.speed}${i.duplex === 'half' ? 'half' : 'full'}`, 'snmp-index': Object.keys(cfg.ifs).indexOf(k) + 1 };
    },
    save(s, cfg, k, o) {
      const i = cfg.ifs[k];
      if (!i) return `entry not found in datasource\n${valFail(k, -3)}`;
      if (o.ip) {
        const [ip, m] = o.ip.split(' ');
        const len = m.includes('.') ? maskLen(m) : Number(m);
        i.ip = ip === '0.0.0.0' ? null : `${ip}/${len}`;
      } else i.ip = null;
      i.on = o.status !== 'down';
      i.desc = o.alias || '';
      i.mtu = o['mtu-override'] === 'enable' ? Number(o.mtu || 1500) : 1500;
      if (o.speed) {
        i.speed = o.speed === 'auto' ? 'auto' : Number(o.speed.match(/^\d+/)[0]);
        i.duplex = o.speed === 'auto' ? 'auto' : o.speed.endsWith('half') ? 'half' : 'full';
      } else {
        i.speed = 'auto';
        i.duplex = 'auto';
      }
      if (o.role === 'wan') i.zone = 'outside';
      else if (o.role === 'lan') i.zone = 'inside';
      return null;
    },
    check: (field, v) => {
      if (field === 'ip') {
        const [ip, m] = v;
        if (!isIp(ip || '')) return `invalid ip address\n${valFail(ip)}`;
        if (m && !isMask(m) && !/^\d+$/.test(m)) return `invalid netmask\n${valFail(m)}`;
        if (!m && !ip.includes('/')) return `invalid ip address\n${valFail(ip)}`;
      }
      if (field === 'status' && !['up', 'down'].includes(v[0])) return valFail(v[0]);
      if (field === 'speed' && !SPEEDS.includes(v[0])) return valFail(v[0]);
      return null;
    },
  },
  'firewall policy': {
    table: true,
    fields: { name: 'Policy name', srcintf: 'Incoming (ingress) interface', dstintf: 'Outgoing (egress) interface', srcaddr: 'Source IPv4 address and address group names', dstaddr: 'Destination IPv4 address and address group names', action: 'Policy action (accept/deny/ipsec)', service: 'Service and service group names', schedule: 'Schedule name', nat: 'Enable/disable source NAT', status: 'Enable or disable this policy', logtraffic: 'Enable or disable logging' },
    list: (cfg) => cfg.fw.pol.map((p) => String(p.id)),
    get(s, cfg, k) {
      const p = cfg.fw.pol.find((x) => String(x.id) === String(k));
      if (!p) return null;
      return { name: p.name, uuid: `${hashStr(p.name).toString(16)}-a5f2-51ee-${(hashStr(String(p.id)) % 65535).toString(16)}-d4b1c0e5c2f1`, srcintf: zoneIfs(cfg, p.from).map(qq).join(' ') || '"any"', dstintf: zoneIfs(cfg, p.to).map(qq).join(' ') || '"any"', action: p.act === 'accept' ? 'accept' : null, srcaddr: qq(p.src === 'all' ? 'all' : p.src), dstaddr: qq(p.dst === 'all' ? 'all' : p.dst), schedule: '"always"', service: qq(p.svc === 'ALL' ? 'ALL' : p.svc), status: p.on ? null : 'disable', nat: p.nat ? 'enable' : null, logtraffic: 'all' };
    },
    save(s, cfg, k, o) {
      const fw = cfg.fw;
      let p = fw.pol.find((x) => String(x.id) === String(k));
      if (!p) fw.pol.push((p = { id: Number(k), name: '', from: null, to: null, src: 'all', dst: 'all', svc: 'ALL', act: 'deny', nat: false, on: true }));
      const zoneOf = (v) => {
        const n = String(v || '').split(' ')[0]?.replace(/"/g, '');
        return cfg.ifs[n]?.zone || null;
      };
      p.name = (o.name || '').replace(/"/g, '');
      p.from = zoneOf(o.srcintf);
      p.to = zoneOf(o.dstintf);
      p.src = (o.srcaddr || '"all"').replace(/"/g, '').split(' ')[0];
      p.dst = (o.dstaddr || '"all"').replace(/"/g, '').split(' ')[0];
      p.svc = (o.service || '"ALL"').replace(/"/g, '').split(' ')[0];
      p.act = o.action === 'accept' ? 'accept' : 'deny';
      p.nat = o.nat === 'enable';
      p.on = o.status !== 'disable';
      if (!o.srcintf || !o.dstintf) return 'Attribute \'srcintf\' MUST be set.\nCommand fail. Return code -56';
      return null;
    },
  },
  'firewall vip': {
    table: true,
    fields: { extip: 'IP address or address range on the external interface', mappedip: 'IP address or address range on the destination network', extintf: 'Interface connected to the source network', portforward: 'Enable/disable port forwarding', comment: 'Comment' },
    list: (cfg) => cfg.fw.vip.map((v) => v.name),
    get(s, cfg, k) {
      const v = cfg.fw.vip.find((x) => x.name === k);
      if (!v) return null;
      return { uuid: `${hashStr(v.name).toString(16)}-b2c1-51ee-9e2a-d4b1c0e5c2f1`, extip: v.ext, mappedip: qq(v.int), extintf: qq(zoneIfs(cfg, 'outside')[0] || 'any') };
    },
    save(s, cfg, k, o) {
      let v = cfg.fw.vip.find((x) => x.name === k);
      if (!v) cfg.fw.vip.push((v = { name: k, ext: null, int: null }));
      v.ext = o.extip || null;
      v.int = (o.mappedip || '').replace(/"/g, '').split('-')[0] || null;
      return null;
    },
  },
  'router static': {
    table: true,
    fields: { dst: 'Destination IP and mask for this route', gateway: 'Gateway IP for this route', device: 'Gateway out interface or tunnel', distance: 'Administrative distance', status: 'Enable/disable this static route', blackhole: 'Enable/disable black hole' },
    list: (cfg) => cfg.static.map((_, i) => String(i + 1)),
    get(s, cfg, k) {
      const r = cfg.static[Number(k) - 1];
      if (!r) return null;
      const oif = Object.keys(cfg.ifs).find((n) => cfg.ifs[n].ip && r.nh && inNet(r.nh, cfg.ifs[n].ip));
      return { dst: r.pfx === '0.0.0.0/0' ? null : IPM(r.pfx), gateway: r.nh, device: oif ? qq(oif) : null, blackhole: r.iface === 'Null0' ? 'enable' : null, distance: r.ad && r.ad !== 1 && r.ad !== 10 ? r.ad : null };
    },
    save(s, cfg, k, o) {
      const idx = Number(k) - 1;
      const [ip, m] = (o.dst || '0.0.0.0 0.0.0.0').split(' ');
      const r = { pfx: `${ip}/${m.includes('.') ? maskLen(m) : Number(m)}`, nh: o.blackhole === 'enable' ? null : o.gateway || null, iface: o.blackhole === 'enable' ? 'Null0' : null, ad: o.distance ? Number(o.distance) : 10 };
      if (o.status === 'disable') {
        if (cfg.static[idx]) cfg.static.splice(idx, 1);
        return null;
      }
      cfg.static[idx] = r;
      cfg.static = cfg.static.filter(Boolean);
      return null;
    },
  },
  'router ospf': {
    table: false,
    fields: { 'router-id': 'Router ID', 'default-information-originate': 'Enable/disable generation of default route', 'passive-interface': 'Passive interface configuration' },
    subs: ['area', 'ospf-interface', 'network'],
    get(s, cfg) {
      return { 'router-id': cfg.ospf.rid || '0.0.0.0', 'default-information-originate': cfg.ospf.defOrig ? (cfg.ospf.always ? 'always' : 'enable') : null, 'passive-interface': Object.entries(cfg.ifs).filter(([, i]) => i.ospf?.passive && i.ospf.area != null).map(([n]) => qq(n)).join(' ') || null };
    },
    save(s, cfg, k, o) {
      cfg.ospf.rid = o['router-id'] && o['router-id'] !== '0.0.0.0' ? o['router-id'] : null;
      cfg.ospf.defOrig = ['enable', 'always'].includes(o['default-information-originate']);
      cfg.ospf.always = o['default-information-originate'] === 'always';
      const pas = (o['passive-interface'] || '').replace(/"/g, '').split(' ').filter(Boolean);
      for (const [n, i] of Object.entries(cfg.ifs)) if (i.ospf) i.ospf.passive = pas.includes(n);
      if (cfg.ospf.rid || Object.values(cfg.ifs).some((i) => i.ospf?.area != null)) cfg.ospf.on = true;
      return null;
    },
  },
  'router ospf area': { table: true, fields: { type: 'Area type setting' }, list: () => ['0.0.0.0'], get: () => ({}), save: () => null },
  'router ospf ospf-interface': {
    table: true,
    fields: { interface: 'Configuration interface name', 'hello-interval': 'Time between sending hello packets', 'dead-interval': 'Dead interval', cost: 'Cost of the interface', authentication: 'Authentication type', 'authentication-key': 'Authentication key', mtu: 'MTU for database description packets' },
    list: (cfg) => Object.entries(cfg.ifs).filter(([, i]) => i.ospf?.area != null && (i.ospf.cost || i.ospf.hello !== 10 || i.ospf.dead !== 40 || i.ospf.auth)).map(([n]) => n),
    get(s, cfg, k) {
      const i = cfg.ifs[k];
      if (!i?.ospf) return { interface: qq(k) };
      return { interface: qq(k), cost: i.ospf.cost, 'hello-interval': i.ospf.hello !== 10 ? i.ospf.hello : null, 'dead-interval': i.ospf.dead !== 40 ? i.ospf.dead : null, authentication: i.ospf.auth ? 'text' : null, 'authentication-key': i.ospf.auth ? 'ENC ' + hashStr(i.ospf.auth).toString(36) : null };
    },
    save(s, cfg, k, o) {
      const n = (o.interface || qq(k)).replace(/"/g, '');
      const i = cfg.ifs[n];
      if (!i) return `entry not found in datasource\n${valFail(n, -3)}`;
      i.ospf = i.ospf || { area: null, cost: null, hello: 10, dead: 40, passive: false };
      i.ospf.cost = o.cost ? Number(o.cost) : null;
      i.ospf.hello = o['hello-interval'] ? Number(o['hello-interval']) : 10;
      i.ospf.dead = o['dead-interval'] ? Number(o['dead-interval']) : 40;
      if (o['authentication-key'] && !String(o['authentication-key']).startsWith('ENC')) i.ospf.auth = o['authentication-key'];
      if (o.authentication === 'none') i.ospf.auth = null;
      return null;
    },
  },
  'router ospf network': {
    table: true,
    fields: { prefix: 'Prefix', area: 'Attach the network to area' },
    list: (cfg) => Object.entries(cfg.ifs).filter(([, i]) => i.ospf?.area != null && i.ip).map((_, k) => String(k + 1)),
    get(s, cfg, k) {
      const e = Object.entries(cfg.ifs).filter(([, i]) => i.ospf?.area != null && i.ip)[Number(k) - 1];
      if (!e) return null;
      return { prefix: `${n2ip(cidr(e[1].ip).net)} ${maskStr(cidr(e[1].ip).len)}`, area: e[1].ospf.area === '0.0.0.0' ? null : e[1].ospf.area };
    },
    save(s, cfg, k, o) {
      if (!o.prefix) return 'Attribute \'prefix\' MUST be set.\nCommand fail. Return code -56';
      const [ip, m] = o.prefix.split(' ');
      const pfx = `${ip}/${m.includes('.') ? maskLen(m) : Number(m)}`;
      cfg.ospf.on = true;
      for (const i of Object.values(cfg.ifs)) if (i.ip && inNet(ipOnly(i.ip), pfx)) {
        i.ospf = i.ospf || { area: null, cost: null, hello: 10, dead: 40, passive: false };
        i.ospf.area = o.area || '0.0.0.0';
      }
      return null;
    },
    del(s, cfg, k) {
      const e = Object.entries(cfg.ifs).filter(([, i]) => i.ospf?.area != null && i.ip)[Number(k) - 1];
      if (e) e[1].ospf.area = null;
    },
  },
  'router bgp': {
    table: false,
    fields: { as: 'Router AS number', 'router-id': 'Router ID' },
    subs: ['neighbor', 'network'],
    get: (s, cfg) => ({ as: cfg.bgp.asn || 0, 'router-id': cfg.bgp.rid || null }),
    save(s, cfg, k, o) {
      cfg.bgp.asn = Number(o.as) || null;
      cfg.bgp.rid = o['router-id'] || null;
      cfg.bgp.on = !!cfg.bgp.asn;
      return null;
    },
  },
  'router bgp neighbor': {
    table: true,
    fields: { 'remote-as': 'AS number of neighbor', shutdown: 'Enable/disable shutdown this neighbor', 'maximum-prefix': 'Maximum number of IPv4 prefixes to accept from this peer', description: 'Description' },
    list: (cfg) => cfg.bgp.nbrs.map((n) => n.ip),
    get(s, cfg, k) {
      const n = cfg.bgp.nbrs.find((x) => x.ip === k);
      if (!n) return null;
      return { 'remote-as': n.ras, description: n.desc ? qq(n.desc) : null, shutdown: n.shut ? 'enable' : null, 'maximum-prefix': n.maxpfx };
    },
    save(s, cfg, k, o) {
      let n = cfg.bgp.nbrs.find((x) => x.ip === k);
      if (!n) cfg.bgp.nbrs.push((n = { ip: k, ras: null, shut: false, desc: '', maxpfx: null }));
      n.ras = Number(o['remote-as']) || null;
      n.shut = o.shutdown === 'enable';
      n.maxpfx = o['maximum-prefix'] ? Number(o['maximum-prefix']) : null;
      n.desc = (o.description || '').replace(/"/g, '');
      return null;
    },
    del: (s, cfg, k) => (cfg.bgp.nbrs = cfg.bgp.nbrs.filter((x) => x.ip !== k)),
  },
  'router bgp network': {
    table: true,
    fields: { prefix: 'Network prefix' },
    list: (cfg) => cfg.bgp.nets.map((_, i) => String(i + 1)),
    get: (s, cfg, k) => (cfg.bgp.nets[Number(k) - 1] ? { prefix: IPM(cfg.bgp.nets[Number(k) - 1]) } : null),
    save(s, cfg, k, o) {
      const [ip, m] = (o.prefix || '').split(' ');
      if (!ip) return null;
      cfg.bgp.nets[Number(k) - 1] = `${ip}/${m.includes('.') ? maskLen(m) : Number(m)}`;
      cfg.bgp.nets = cfg.bgp.nets.filter(Boolean);
      return null;
    },
    del: (s, cfg, k) => cfg.bgp.nets.splice(Number(k) - 1, 1),
  },
  'system global': {
    table: false,
    fields: { hostname: 'FortiGate unit\'s hostname', timezone: 'Number corresponding to your time zone from 00 to 86', 'admin-sport': 'Administrative access port for HTTPS', 'admin-ssh-port': 'Administrative access port for SSH' },
    get: (s, cfg) => ({ hostname: qq(cfg.hostname), timezone: '00', 'admin-ssh-port': cfg.svc.ssh ? null : 0 }),
    save(s, cfg, k, o) {
      cfg.hostname = (o.hostname || cfg.hostname).replace(/"/g, '');
      s.dev.hostname = cfg.hostname;
      return null;
    },
  },
  'system ntp': {
    table: false,
    fields: { ntpsync: 'Enable/disable setting the FortiGate system time by synchronizing with an NTP Server', type: 'Use the FortiGuard NTP server or a custom NTP server', server: 'NTP server' },
    get: (s, cfg) => ({ ntpsync: cfg.svc.ntp.length ? 'enable' : null, type: cfg.svc.ntp.length ? 'custom' : null, server: cfg.svc.ntp[0] || null }),
    save(s, cfg, k, o) {
      cfg.svc.ntp = o.ntpsync === 'enable' && o.server ? [o.server] : [];
      return null;
    },
  },
  'log syslogd setting': {
    table: false,
    fields: { status: 'Enable/disable remote syslog logging', server: 'Address of remote syslog server' },
    get: (s, cfg) => ({ status: cfg.svc.syslog.length ? 'enable' : null, server: cfg.svc.syslog[0] ? qq(cfg.svc.syslog[0]) : null }),
    save(s, cfg, k, o) {
      cfg.svc.syslog = o.status === 'enable' && o.server ? [o.server.replace(/"/g, '')] : [];
      return null;
    },
  },
  'system admin': {
    table: true,
    fields: { accprofile: 'Access profile for this administrator', password: 'Admin user password', vdom: 'Virtual domain(s) that the administrator can access' },
    list: (cfg) => cfg.svc.users.map((u) => u.name),
    get: (s, cfg, k) => (cfg.svc.users.find((u) => u.name === k) ? { accprofile: '"super_admin"', vdom: '"root"', password: `ENC SH2${hashStr(k).toString(36)}${hashStr(k + 'p').toString(36)}=` } : null),
    save(s, cfg, k, o) {
      let u = cfg.svc.users.find((x) => x.name === k);
      if (!u) cfg.svc.users.push((u = { name: k, pw: '', priv: 15 }));
      if (o.password && !String(o.password).startsWith('ENC')) u.pw = o.password;
      return null;
    },
    del: (s, cfg, k) => (cfg.svc.users = cfg.svc.users.filter((u) => u.name !== k)),
  },
  // ---- FortiSwitch ----
  'switch interface': {
    table: true,
    fields: { 'native-vlan': 'Native (untagged) VLAN', 'allowed-vlans': 'Allowed VLANs', 'stp-state': 'Enable/disable STP state', 'edge-port': 'Enable/disable configuring the port as an edge port', 'stp-bpdu-guard': 'Enable/disable STP BPDU guard', description: 'Description', 'untagged-vlans': 'Configure VLANs permitted to be transmitted without VLAN tags' },
    list: (cfg) => Object.keys(cfg.ifs).filter((n) => cfg.ifs[n].sw),
    get(s, cfg, k) {
      const i = cfg.ifs[k];
      if (!i?.sw) return null;
      const allowed = i.sw.mode === 'trunk' ? (i.sw.allowed === 'all' ? '1-4094' : fmtVlans(i.sw.allowed, ' ')) : null;
      return { 'native-vlan': i.sw.mode === 'trunk' ? i.sw.native : i.sw.vlan, 'allowed-vlans': allowed, 'edge-port': i.stp.edge ? 'enable' : null, 'stp-bpdu-guard': i.stp.bpduguard ? 'enabled' : null, description: i.desc ? qq(i.desc) : null, 'snmp-index': Object.keys(cfg.ifs).indexOf(k) + 1 };
    },
    save(s, cfg, k, o) {
      const i = cfg.ifs[k];
      if (!i) return `entry not found in datasource\n${valFail(k, -3)}`;
      const native = Number(o['native-vlan'] || 1);
      const allowed = o['allowed-vlans'] ? parseVlans(String(o['allowed-vlans']).replace(/ /g, ',')) : null;
      if (allowed && allowed.length) i.sw = { mode: 'trunk', vlan: 1, native, allowed: allowed.length >= 4094 ? 'all' : allowed.filter((v) => v !== native) };
      else i.sw = { mode: 'access', vlan: native, native: 1, allowed: 'all' };
      i.stp.edge = o['edge-port'] === 'enable';
      i.stp.bpduguard = o['stp-bpdu-guard'] === 'enabled';
      i.desc = (o.description || '').replace(/"/g, '');
      return null;
    },
  },
  'switch physical-port': {
    table: true,
    fields: { status: 'Administrative status', speed: 'Speed', description: 'Description' },
    list: (cfg) => Object.keys(cfg.ifs).filter((n) => cfg.ifs[n].kind === 'phys'),
    get(s, cfg, k) {
      const i = cfg.ifs[k];
      if (!i) return null;
      return { status: i.on ? null : 'down', speed: i.speed === 'auto' ? null : `${i.speed}${i.duplex === 'half' ? 'half' : 'full'}`, description: i.desc ? qq(i.desc) : null };
    },
    save(s, cfg, k, o) {
      const i = cfg.ifs[k];
      if (!i) return `entry not found in datasource\n${valFail(k, -3)}`;
      i.on = o.status !== 'down';
      if (s.dev.run.errdis[k] && i.on) delete s.dev.run.errdis[k];
      if (o.speed) {
        i.speed = o.speed === 'auto' ? 'auto' : Number(o.speed.match(/^\d+/)[0]);
        i.duplex = o.speed === 'auto' ? 'auto' : o.speed.endsWith('half') ? 'half' : 'full';
      } else {
        i.speed = 'auto';
        i.duplex = 'auto';
      }
      i.desc = (o.description || '').replace(/"/g, '');
      return null;
    },
  },
  'switch vlan': {
    table: true,
    fields: { description: 'Description' },
    list: (cfg) => Object.keys(cfg.vlans).filter((v) => v !== '1'),
    get: (s, cfg, k) => (k in cfg.vlans ? { description: qq(cfg.vlans[k]) } : null),
    save(s, cfg, k, o) {
      cfg.vlans[k] = (o.description || `VLAN${k}`).replace(/"/g, '');
      return null;
    },
    del: (s, cfg, k) => delete cfg.vlans[k],
  },
};
const FGT_SECTIONS = ['system interface', 'system global', 'system admin', 'system ntp', 'firewall policy', 'firewall vip', 'router static', 'router ospf', 'router bgp', 'log syslogd setting'];
const FSW_SECTIONS = ['system interface', 'system global', 'system admin', 'system ntp', 'switch interface', 'switch physical-port', 'switch vlan', 'router static', 'log syslogd setting'];

function renderSection(s, cfg, name, key = null, depth = 0, full = false) {
  const sec = SECTIONS[name];
  const pad = '    '.repeat(depth);
  const out = [`${pad}config ${name.split(' ').slice(depth ? -1 : 0).join(' ')}`];
  const fieldLines = (o, p) => Object.entries(o).filter(([, v]) => v != null || full).map(([k, v]) => `${p}set ${k} ${v ?? ''}`.trimEnd());
  if (sec.table) {
    for (const k of sec.list(cfg)) {
      if (key && k !== key) continue;
      const o = sec.get(s, cfg, k);
      if (!o) continue;
      out.push(`${pad}    edit ${/^\d+$/.test(k) ? k : qq(k)}`, ...fieldLines(o, `${pad}        `), `${pad}    next`);
    }
  } else {
    out.push(...fieldLines(sec.get(s, cfg), `${pad}    `));
    for (const sub of sec.subs || []) {
      const child = renderSection(s, cfg, `${name} ${sub}`, null, depth + 1, full);
      if (child.length > 2 || full) out.push(...child);
    }
  }
  out.push(`${pad}end`);
  return out;
}

// =============================================================================================
// Operational output
function sysStatus(s) {
  const dev = s.dev;
  const m = model(dev.model);
  const fsw = dev.os === 'fortiswitch';
  return [`Version: ${fsw ? 'FortiSwitch' : 'FortiGate'}-${m.name.replace(/^Forti(Gate|Switch)[ -]?/, '')} v${dev.version},build${1000 + (hashStr(dev.version) % 900)},${fmtDate(Math.max(0, dev.installed - 100000), 'iso').replace(/-/g, '').slice(2)} (GA)`, 'Firmware Signature: certified', ...(fsw ? [] : [`Virus-DB: ${90 + (yearOf(s.world.time.t) % 5)}.0${hashStr(String(Math.floor(s.world.time.t / 1440))) % 9000}(${fmtDate(s.world.time.t - 300, 'datetime')})`, 'IPS-DB: 27.00720(2024-02-29 01:02)']), `Serial-Number: ${dev.hw.serial}`, `BIOS version: 0500000${hashStr(dev.model) % 9}`, 'Log hard disk: Available', `Hostname: ${dev.cfg.hostname}`, 'Operation Mode: NAT', 'Current virtual domain: root', 'Max number of virtual domains: 10', 'Virtual domains status: 1 in NAT mode, 0 in TP mode', 'Virtual domain configuration: disable', 'FIPS-CC mode: disable', 'Current HA mode: standalone', `Branch point: ${1000 + (hashStr(dev.version) % 900)}`, 'Release Version Information: GA', `System time: ${fmtDate(s.world.time.t, 'long')} ${fmtDate(s.world.time.t, 'datetime').slice(11)}:00`, `Last reboot reason: ${dev.run.reloadReason ? 'warm reboot' : 'power cycle'}`];
}
function ifPhysical(s) {
  const dev = s.dev;
  const S = S_(s.world);
  const out = ['System Interface Physical Info', '== [onboard]'];
  for (const n of physIfs(dev)) {
    const i = dev.cfg.ifs[n];
    const st = S.ifs[dev.id][n];
    const L = st?.link ? S.links[st.link] : null;
    out.push(`        ==[${n}]`, `                mode: static`, `                ip: ${i.ip ? IPM(i.ip) : '0.0.0.0 0.0.0.0'}`, '                ipv6: ::/0', `                status: ${st?.up ? 'up' : 'down'}`, `                speed: ${st?.up ? `${L.speed}Mbps (Duplex: ${L.duplex === 'mismatch' && i.duplex === 'auto' ? 'half' : 'full'})` : 'n/a (Duplex: n/a)'}`, '                FEC: none', '                FEC_cap: none');
  }
  return out;
}
function routingTable(s, filter) {
  const dev = s.dev;
  const S = S_(s.world);
  const rib = (S.rib[dev.id]?.best || []).filter((r) => !r.vrf && r.proto !== 'local');
  const code = (r) => ({ connected: 'C', static: 'S', ospf: 'O', ospfE: 'O E2', ebgp: 'B', ibgp: 'B' })[r.proto];
  const list = filter ? rib.filter((r) => (filter === 'ospf' ? r.proto.startsWith('ospf') : filter === 'static' ? r.proto === 'static' : filter === 'connected' ? r.proto === 'connected' : filter === 'bgp' ? r.proto.endsWith('bgp') : true)) : rib;
  const out = ['Codes: K - kernel, C - connected, S - static, R - RIP, B - BGP', '       O - OSPF, IA - OSPF inter area', '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2', '       E1 - OSPF external type 1, E2 - OSPF external type 2', '       i - IS-IS, L1 - IS-IS level-1, L2 - IS-IS level-2, ia - IS-IS inter area', '       V - BGP VPNv4', '       * - candidate default', '', 'Routing table for VRF=0'];
  for (const r of list) {
    const c = code(r) + (r.pfx === '0.0.0.0/0' ? '*' : '');
    if (r.proto === 'connected') out.push(`${padR(c, 8)}${r.pfx} is directly connected, ${r.oif}`);
    else if (r.discard) out.push(`${padR(c, 8)}${r.pfx} [${r.ad}/0] is a summary, Null`);
    else out.push(`${padR(c, 8)}${r.pfx} [${r.ad}/${r.metric}] via ${r.nh}, ${r.oif}${r.proto === 'static' ? ', [1/0]' : `, ${fmtDate(s.world.time.t, 'datetime').slice(11)}:00`}`);
  }
  return out;
}
function flowTrace(s) {
  const dev = s.dev;
  const W = s.world;
  const addr = s.vars.flowAddr;
  const n = s.vars.flowCount || 10;
  const out = [];
  let id = 1;
  const fw = dev.cfg.fw;
  const flows = [];
  const isp = Object.values(W.hosts).find((h) => h.kind === 'isp');
  for (const c of W.design.customers) {
    const web = W.hosts[c.servers[0]];
    if (c.web && isp && (!addr || addr === c.vip || addr === web?.ip)) flows.push({ src: '198.51.100.77', sport: 51234, dst: c.vip, dport: 443, from: isp, proto: 6 });
    if (web && (!addr || addr === web.ip || addr === '8.8.8.8')) flows.push({ src: web.ip, sport: 40000 + (hashStr(web.id) % 9000), dst: '8.8.8.8', dport: 443, from: web, proto: 6 });
  }
  for (const f of flows.slice(0, n)) {
    const r = walk(W, { host: f.from.id }, f.dst, { proto: 'tcp', dport: f.dport });
    const seen = r.hops.find((h) => h.dev === dev.id);
    if (!seen) continue;
    const tid = id++;
    const L = (fn, line, msg) => out.push(`id=20085 trace_id=${tid} func=${fn} line=${line} msg="${msg}"`);
    L('print_pkt_detail', 5888, `vd-root:0 received a packet(proto=${f.proto}, ${f.src}:${f.sport}->${f.dst}:${f.dport}) tun_id=0.0.0.0 from ${seen.inIf}. flag [S], seq ${hashStr(f.src + tid)}, ack 0, win 64240`);
    L('init_ip_session_common', 6070, `allocate a new session-00${(hashStr(f.dst + tid) % 0xffffff).toString(16)}, tun_id=0.0.0.0`);
    const v = fw.vip.find((x) => x.ext === f.dst);
    if (v) {
      L('iprope_dnat_check', 5326, `in-[${seen.inIf}], out-[]`);
      L('iprope_dnat_tree_check', 830, 'len=1');
      L('get_new_addr', 1219, `find DNAT: IP-${v.int}, port-${f.dport}(fixed port)`);
    }
    const rt = lookup(W, dev, v ? v.int : f.dst);
    if (!rt) {
      L('vf_ip_route_input_common', 2605, 'reverse path check fail, drop');
      continue;
    }
    L('vf_ip_route_input_common', 2605, `find a route: flag=00000000 gw-${rt.nh || (v ? v.int : f.dst)} via ${rt.oif}`);
    L('iprope_fwd_check', 799, `in-[${seen.inIf}], out-[${rt.oif}], skb_flags-02000000, vid-0, app_id: 0, url_cat_id: 0`);
    if (r.at === dev.id && /policy/.test(r.reason || '')) {
      L('__iprope_tree_check', 543, 'gnum-100004, use addr/intf hash, len=2');
      L('fw_forward_handler', 930, `Denied by forward policy check (policy ${(r.reason.match(/policy (\d+)/) || [0, 0])[1]})`);
    } else {
      const p = fw.pol.find((x) => x.on && x.from === dev.cfg.ifs[seen.inIf]?.zone && x.to === dev.cfg.ifs[rt.oif]?.zone);
      L('__iprope_check_one_policy', 2033, `checked gnum-100004 policy-${p?.id || 0}, ret-matched, act-accept`);
      L('fw_forward_handler', 930, `Allowed by Policy-${p?.id || 0}:${p?.nat ? ' SNAT' : ''}`);
      if (p?.nat) L('__ip_session_run_tuple', 3486, `SNAT ${f.src}->${ipOnly(dev.cfg.ifs[rt.oif]?.ip)}:${62000 + tid}`);
    }
  }
  return out;
}
function sniffer(s, args) {
  const dev = s.dev;
  const W = s.world;
  const iface = args[0] || 'any';
  const filt = (args[1] || '').replace(/^'|'$/g, '');
  const verbose = Number(args[2] || 1);
  const count = Number(args[3] || 0) || Infinity;
  const lines = [];
  const host = filt.match(/host (\d+\.\d+\.\d+\.\d+)/)?.[1];
  const S = S_(W);
  const isp = Object.values(W.hosts).find((h) => h.kind === 'isp');
  for (const c of W.design.customers.filter((x) => x.web)) {
    if (host && host !== c.vip && host !== W.hosts[c.servers[0]]?.ip && host !== '198.51.100.77') continue;
    const r = isp && walk(W, { host: isp.id }, c.vip, { proto: 'tcp', dport: 443 });
    const at = r?.hops.find((h) => h.dev === dev.id);
    if (!at) continue;
    if (iface === 'any' || iface === at.inIf) lines.push(`${iface === 'any' ? `${at.inIf} in ` : ''}198.51.100.77.51234 -> ${c.vip}.443: syn ${hashStr(c.id)}`);
    if (r.ok || r.at !== dev.id) {
      const v = dev.cfg.fw.vip.find((x) => x.ext === c.vip);
      const outIf = v ? lookup(W, dev, v.int)?.oif : null;
      if (outIf && (iface === 'any' || iface === outIf)) lines.push(`${iface === 'any' ? `${outIf} out ` : ''}198.51.100.77.51234 -> ${v.int}.443: syn ${hashStr(c.id)}`);
      if (r.ok && (iface === 'any' || iface === outIf)) lines.push(`${iface === 'any' ? `${outIf} in ` : ''}${v.int}.443 -> 198.51.100.77.51234: syn ${hashStr(c.vip)} ack ${hashStr(c.id) + 1}`);
    }
  }
  if (!lines.length && S.ospf[dev.id]?.nbrs.length) for (const nb of S.ospf[dev.id].nbrs) lines.push(`${iface === 'any' ? `${nb.if} in ` : ''}${nb.ip} -> 224.0.0.5:  ip-proto-89 48`);
  let k = 0;
  let shown = 0;
  let head = false;
  const t0 = 0.3;
  return genStream(() => {
    if (!head) {
      head = true;
      return { d: 200, t: `interfaces=[${iface}]\nfilters=[${filt}]\n` };
    }
    if (shown >= count) return { d: 0, t: `\n${shown} packets received by filter\n0 packets dropped by kernel\n`, last: true };
    if (!lines.length) return { d: 1000, t: '' };
    const l = lines[k++ % lines.length];
    shown++;
    return { d: 600, t: `${(t0 + shown * 0.731).toFixed(6)} ${l}\n${verbose >= 3 ? '0x0000\t 0050 56a1 0b2c 0090 0b4e 1f20 0800 4500\t.PV..,.....N....\n' : ''}` };
  }, () => `^C\n${shown} packets received by filter\n0 packets dropped by kernel\n`);
}
function finiteGen(st) {
  let done = false;
  return { stream: true, next() {
    if (done) return null;
    const c = st.next();
    if (c?.last) done = true;
    return c;
  }, interrupt: () => st.interrupt() };
}

export function fmtEventFortiOS(e, dev) {
  const d = fmtDate(e.t, 'datetime');
  const h = `date=${d.slice(0, 10)} time=${d.slice(11)}:00 devname="${dev.cfg.hostname}" devid="${dev.hw.serial}" logid=`;
  switch (e.type) {
    case 'link':
      if (e.kind !== 'phys' && e.kind !== 'mgmt') return null;
      return `${h}"0100020009" type="event" subtype="system" level="${e.up ? 'information' : 'warning'}" vd="root" logdesc="Interface status changed" action="interface-stat-change" status="${e.up ? 'UP' : 'DOWN'}" msg="Link monitor: Interface ${e.if} was turned ${e.up ? 'up' : 'down'}"`;
    case 'config':
      return `${h}"0100044547" type="event" subtype="system" level="information" vd="root" logdesc="Object attribute configured" user="${e.by}" ui="ssh(${e.from || '10.250.0.10'})" action="Edit" msg="Edit configuration"`;
    case 'login':
      return `${h}"0100032001" type="event" subtype="system" level="information" vd="root" logdesc="Admin login successful" user="${e.user}" ui="ssh(${e.from})" method="ssh" srcip=${e.from} action="login" status="success" msg="Administrator ${e.user} logged in successfully from ssh(${e.from})"`;
    case 'authfail':
      return `${h}"0100032002" type="event" subtype="system" level="alert" vd="root" logdesc="Admin login failed" user="${e.user}" ui="ssh(${e.from})" method="ssh" srcip=${e.from} action="login" status="failed" reason="passwd_invalid" msg="Administrator ${e.user} login failed from ssh(${e.from}) because of invalid password"`;
    case 'ospf':
      return `${h}"0103020301" type="event" subtype="router" level="notice" vd="root" logdesc="Routing log" msg="OSPF: neighbor ${e.nbr} on ${e.if} changed state from ${e.from} to ${e.to}"`;
    case 'bgp':
      return `${h}"0103020300" type="event" subtype="router" level="${e.up ? 'information' : 'warning'}" vd="root" logdesc="BGP neighbor status changed" msg="BGP: %BGP-5-ADJCHANGE: VRF 0 neighbor ${e.nbr} ${e.up ? 'Up' : `Down ${e.why || 'BGP Notification FSM-ERR'}`}"`;
    case 'deny':
      return `${h}"0000000013" type="traffic" subtype="forward" level="notice" vd="root" srcip=${e.src} srcport=${e.sport} srcintf="${e.inIf}" dstip=${e.dst} dstport=${e.dport} dstintf="${e.outIf}" proto=6 action="deny" policyid=0 policytype="policy" service="HTTPS" msg="Denied by forward policy check"`;
    case 'psu':
      return `${h}"0100022106" type="event" subtype="system" level="critical" vd="root" logdesc="Power supply failure" msg="Power supply ${e.n} ${e.ok ? 'restored' : 'failure'}"`;
    case 'fan':
      return `${h}"0100022107" type="event" subtype="system" level="critical" vd="root" logdesc="Fan anomaly" msg="Fan ${e.n} ${e.ok ? 'OK' : 'is spinning too slowly'}"`;
    case 'temp':
      return `${h}"0100022108" type="event" subtype="system" level="critical" vd="root" logdesc="Temperature too high" msg="Temperature ${e.temp}C"`;
    case 'boot':
      return `${h}"0100032009" type="event" subtype="system" level="critical" vd="root" logdesc="Device rebooted" action="reboot" msg="${dev.run.reloadReason || 'User admin rebooted the device from ssh(10.250.0.10).'}"`;
    case 'errdis':
      return `${h}"0100020011" type="event" subtype="switch-controller" level="warning" vd="root" msg="port ${e.if} is in STP BPDU guard err-disabled state"`;
    default:
      return null;
  }
}

// =============================================================================================
export function makeFortiOS(variant = 'fortigate') {
  const fsw = variant === 'fortiswitch';
  const SECS = fsw ? FSW_SECTIONS : FGT_SECTIONS;
  const sectionWords = [...new Set(SECS.map((x) => x.split(' ')[0]))];
  const resolveSection = (words, base = '') => {
    // words: ['sys', 'int'] -> 'system interface'
    const pool = base ? Object.keys(SECTIONS).filter((k) => k.startsWith(`${base} `)).map((k) => k.slice(base.length + 1)).filter((k) => !k.includes(' ')) : SECS;
    const lvl1 = [...new Set(pool.map((x) => x.split(' ')[0]))];
    const a = pick(words[0], lvl1);
    if (!a || a.ambiguous) return { err: words[0] };
    const lvl2 = [...new Set(pool.filter((x) => x.split(' ')[0] === a).map((x) => x.split(' ').slice(1).join(' ')).filter(Boolean))];
    if (!lvl2.length) return { name: base ? `${base} ${a}` : a, used: 1 };
    const b = pick(words[1], lvl2);
    if (!b || b.ambiguous) return { err: words[1] || a };
    return { name: base ? `${base} ${a} ${b}` : `${a} ${b}`, used: 2 };
  };
  const frame = (s) => s.ctx.stack?.[s.ctx.stack.length - 1];
  const promptName = (s) => {
    const f = frame(s);
    if (!f) return '';
    if (f.key != null) return f.key;
    return f.section.split(' ').pop();
  };
  function enterEdit(s, key) {
    const f = frame(s);
    const sec = SECTIONS[f.section];
    const cfg = cfgOf(s);
    key = key.replace(/^"|"$/g, '');
    if (!sec.table) return fail('edit');
    let obj = sec.get(s, cfg, key);
    if (!obj) {
      if (f.section === 'system interface' || f.section === 'switch physical-port' || f.section === 'switch interface') return `entry not found in datasource\n${valFail(key, -3)}`;
      obj = {};
      s.ctx.created = true;
    }
    f.key = key;
    f.obj = { ...obj };
    return '';
  }
  function saveEdit(s) {
    const f = frame(s);
    if (!f || f.key == null) return null;
    const sec = SECTIONS[f.section];
    const e = sec.save(s, cfgOf(s), f.key, f.obj);
    if (e) return e;
    changed(s);
    f.key = null;
    f.obj = null;
    return null;
  }
  function doSet(s, words, unset) {
    const f = frame(s);
    const sec = SECTIONS[f.section];
    const target = f.key != null ? f.obj : (f.single = f.single || { ...sec.get(s, cfgOf(s)) });
    if (sec.table && f.key == null) return fail(words[0]);
    const field = pick(words[0], Object.keys(sec.fields));
    if (!field || field.ambiguous) return fail(words[0]);
    if (unset) {
      target[field] = null;
      return '';
    }
    const vals = words.slice(1);
    if (!vals.length) return `value parse error before '${field}'\nCommand fail. Return code -651`;
    const chk = sec.check?.(field, vals);
    if (chk) return chk;
    if (field === 'ip' && vals[0].includes('/')) target.ip = `${vals[0].split('/')[0]} ${maskStr(Number(vals[0].split('/')[1]))}`;
    else target[field] = vals.map((v) => (/^(srcintf|dstintf|srcaddr|dstaddr|service|mappedip|extintf|description|alias|passive-interface|interface|server)$/.test(field) ? qq(v.replace(/"/g, '')) : v)).join(' ');
    if (field === 'alias') target.alias = vals.join(' ').replace(/"/g, '');
    return '';
  }
  function endFrame(s) {
    const f = frame(s);
    if (!f) return fail('end');
    if (f.key != null) {
      const e = saveEdit(s);
      if (e) return e;
    }
    if (f.single) {
      const e = SECTIONS[f.section].save(s, cfgOf(s), null, f.single);
      if (e) return e;
      changed(s);
    }
    s.ctx.stack.pop();
    if (!s.ctx.stack.length) {
      configEnded(s);
      s.mode = 'top';
    }
    return '';
  }
  function cfgLine(s, words, raw) {
    const f = frame(s);
    const v = pick(words[0], ['set', 'unset', 'edit', 'next', 'end', 'abort', 'show', 'get', 'delete', 'config', 'rename', 'move', 'purge', 'append', 'select', 'unselect']);
    if (!v || v.ambiguous) return fail(words[0]);
    switch (v) {
      case 'set':
        return doSet(s, words.slice(1), false);
      case 'unset':
        return doSet(s, words.slice(1), true);
      case 'append': {
        const r = doSet(s, words.slice(1), false);
        return r;
      }
      case 'edit':
        if (f.key != null) {
          const e = saveEdit(s);
          if (e) return e;
        }
        if (!words[1]) return fail('edit', -61);
        return enterEdit(s, raw.split(/\s+/).slice(1).join(' '));
      case 'next': {
        const e = saveEdit(s);
        return e || '';
      }
      case 'abort':
        s.ctx.stack.pop();
        if (!s.ctx.stack.length) s.mode = 'top';
        return '';
      case 'end':
        return endFrame(s);
      case 'delete': {
        const sec = SECTIONS[f.section];
        const key = (words[1] || '').replace(/"/g, '');
        if (!sec.table || !key) return fail('delete');
        if (f.section === 'firewall policy') cfgOf(s).fw.pol = cfgOf(s).fw.pol.filter((p) => String(p.id) !== key);
        else if (f.section === 'firewall vip') cfgOf(s).fw.vip = cfgOf(s).fw.vip.filter((p) => p.name !== key);
        else if (f.section === 'router static') cfgOf(s).static.splice(Number(key) - 1, 1);
        else if (sec.del) sec.del(s, cfgOf(s), key);
        else return fail('delete');
        changed(s);
        return '';
      }
      case 'show':
      case 'get': {
        if (f.key != null) {
          const o = f.obj;
          if (v === 'get') return Object.entries(o).map(([k, x]) => `${padR(k, 21)}: ${x ?? ''}`.replace(/"/g, ''));
          return [`config ${f.section}`, `    edit ${/^\d+$/.test(f.key) ? f.key : qq(f.key)}`, ...Object.entries(o).filter(([, x]) => x != null).map(([k, x]) => `        set ${k} ${x}`), '    next', 'end'];
        }
        return renderSection(s, cfgOf(s), f.section, null, 0, words[0] === 'show' && words[1] === 'full-configuration');
      }
      case 'config': {
        const sec = SECTIONS[f.section];
        const sub = pick(words[1], sec.subs || []);
        if (!sub || sub.ambiguous) return fail(words[1] || 'config');
        s.ctx.stack.push({ section: `${f.section} ${sub}`, key: null });
        return '';
      }
      case 'move': {
        if (f.section !== 'firewall policy') return fail('move');
        const pol = cfgOf(s).fw.pol;
        const [id, where, other] = [words[1], words[2], words[3]];
        const a = pol.findIndex((p) => String(p.id) === id);
        if (a < 0) return 'entry not found\nCommand fail. Return code -3';
        const [p] = pol.splice(a, 1);
        let b = pol.findIndex((x) => String(x.id) === other);
        if (b < 0) b = pol.length;
        pol.splice(where === 'after' ? b + 1 : b, 0, p);
        changed(s);
        return '';
      }
      default:
        return fail(words[0]);
    }
  }

  // ---- top level ----
  const GET = {
    'system status': sysStatus,
    'system interface physical': ifPhysical,
    'system interface': (s) => physIfs(s.dev).map((n) => `== [ ${n} ]\nname: ${n}   mode: static    ip: ${s.dev.cfg.ifs[n].ip ? IPM(s.dev.cfg.ifs[n].ip) : '0.0.0.0 0.0.0.0'}   status: ${s.dev.cfg.ifs[n].on ? 'up' : 'down'}    netbios-forward: disable    type: physical   ${s.dev.cfg.ifs[n].desc ? `alias: ${s.dev.cfg.ifs[n].desc}` : ''}`),
    'system performance status': (s) => [`CPU states: ${S_(s.world).stormSegs?.size ? '0% user 94% system 0% nice 6% idle' : '0% user 1% system 0% nice 99% idle 0% iowait 0% irq 0% softirq'}`, `Memory: ${8000000 + (hashStr(s.dev.id) % 900000)}k total, 2231016k used (27.2%), 5731568k free (70.0%), 222152k freeable (2.8%)`, `Average network usage: ${4000 + (s.world.time.t % 900)} / ${3000 + (s.world.time.t % 700)} kbps in 1 minute`, `Average sessions: ${200 + (s.world.time.t % 300)} sessions in 1 minute`, `Uptime: ${Math.floor(uptimeMins(s.world, s.dev) / 1440)} days,  ${Math.floor((uptimeMins(s.world, s.dev) % 1440) / 60)} hours,  ${Math.floor(uptimeMins(s.world, s.dev) % 60)} minutes`],
    'system arp': (s) => ['Address           Age(min)   Hardware Addr      Interface', ...arpTable(s.world, s.dev).filter((x) => !x.self).map((x) => `${padR(x.ip, 18)}${padR(x.age, 11)}${padR(macColon(x.mac), 19)}${x.if}`)],
    'system ha status': () => ['HA Health Status: OK', 'Model: FortiGate', 'Mode: standalone'],
    'router info routing-table all': (s) => routingTable(s),
    'router info routing-table ospf': (s) => routingTable(s, 'ospf'),
    'router info routing-table static': (s) => routingTable(s, 'static'),
    'router info routing-table connected': (s) => routingTable(s, 'connected'),
    'router info routing-table bgp': (s) => routingTable(s, 'bgp'),
    'router info ospf neighbor': (s) => (s.dev.cfg.ospf.on ? ['OSPF process 0, VRF 0:', 'Neighbor ID     Pri   State           Dead Time   Address         Interface', ...(S_(s.world).ospf[s.dev.id]?.nbrs || []).map((n) => `${padR(n.rid, 16)}${padL(1, 3)}   ${padR(`${n.state === 'FULL' ? 'Full' : 'ExStart'}/DR`, 16)}00:00:3${hashStr(n.rid) % 9}    ${padR(n.ip, 16)}${n.if}`)] : ''),
    'router info ospf interface': (s) => Object.entries(s.dev.cfg.ifs).filter(([, i]) => i.ospf?.area != null).flatMap(([n, i]) => [`${n} is ${S_(s.world).ifs[s.dev.id][n]?.proto ? 'up' : 'down'}, line protocol is ${S_(s.world).ifs[s.dev.id][n]?.proto ? 'up' : 'down'}`, `  Internet Address ${i.ip}, Area ${i.ospf.area}, MTU ${i.mtu || 1500}`, `  Process ID 0, VRF 0, Router ID ${s.dev.cfg.ospf.rid || '0.0.0.0'}, Network Type BROADCAST, Cost: ${i.ospf.cost || 1}`, `  Timer intervals configured, Hello ${i.ospf.hello || 10}, Dead ${i.ospf.dead || 40}, Wait ${i.ospf.dead || 40}, Retransmit 5`, ...(i.ospf.passive ? ['    No Hellos (Passive interface)'] : []), `  Neighbor Count is ${(S_(s.world).ospf[s.dev.id]?.nbrs || []).filter((x) => x.if === n).length}`]),
    'router info bgp summary': (s) => {
      const b = s.dev.cfg.bgp;
      if (!b.on) return '';
      const recs = S_(s.world).bgp[s.dev.id] || [];
      return [`VRF 0 BGP router identifier ${b.rid || '0.0.0.0'}, local AS number ${b.asn}`, 'BGP table version is 3', '1 BGP AS-PATH entries', '0 BGP community entries', '', 'Neighbor     V         AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd', ...recs.map((r) => `${padR(r.ip, 13)}4 ${padL(r.ras, 10)} ${padL(r.up ? 1234 : 0, 7)} ${padL(r.up ? 1240 : 0, 7)}        2    0    0 ${padR(r.up ? '1d02h03m' : 'never', 9)}${r.up ? padL(r.pfx, 8) : r.state}`), '', `Total number of neighbors ${recs.length}`];
    },
    'hardware nic': (s, rest) => nicInfo(s, rest[0]),
    'switch lldp neighbors-summary': (s) => ['Capability codes:', '        R:Router, B:Bridge, T:Telephone, C:DOCSIS Cable Device', '        W:WLAN Access Point, P:Repeater, S:Station, O:Other', 'MED type codes:', '        Generic:Generic Endpoint (Class 1), Media:Media Endpoint (Class 2)', '', '  Portname     Status Device-name              TTL  Capability  MED-type     Port-ID', '  __________   ______ ____________________    ___  __________  ________     _______', ...neighbours(s.world, s.dev).map((n) => `  ${padR(n.local, 13)}Up     ${padR(n.dev?.hostname || n.host?.name, 25)}120  ${padR(n.host ? 'S' : 'BR', 12)}-            ${n.port}`)],
  };
  function nicInfo(s, n) {
    const i = s.dev.cfg.ifs[n];
    if (!i) return `Command fail. Return code -1`;
    const S = S_(s.world);
    const st = S.ifs[s.dev.id][n];
    const L = st?.link ? S.links[st.link] : null;
    const c = counters(s.world, s.dev, n);
    return ['Name:            ' + n, 'Driver:          ixgbe', 'Version:         5.2.4', `Admin:           ${i.on ? 'up' : 'down'}`, `Current_HWaddr   ${macColon(macOfIf(s.dev, n))}`, `Permanent_HWaddr ${macColon(macOfIf(s.dev, n))}`, `Link:            ${st?.up ? 'up' : 'down'}`, `Speed:           ${st?.up ? `${L.speed}Mbps` : 'Unknown'}`, `Duplex:          ${st?.up ? (L.duplex === 'mismatch' && i.duplex === 'auto' ? 'Half' : 'Full') : 'Unknown'}`, `Rx_Packets:      ${c.inP}`, `Tx_Packets:      ${c.outP}`, `Rx_Bytes:        ${c.inB}`, `Tx_Bytes:        ${c.outB}`, `rx_crc_errors:   ${c.crc}`, `rx_errors:       ${c.inErr}`, `tx_errors:       ${c.outErr}`, `collisions:      ${c.coll}`];
  }
  function topLine(s, line) {
    const words = tokenize(line).map((t) => t.v);
    if (!words.length) return '';
    const raw = line.trim();
    if (s.mode !== 'top') return cfgLine(s, words, raw);
    const verb = pick(words[0], ['config', 'get', 'show', 'execute', 'diagnose', 'exit', 'end']);
    if (!verb) return 'Unknown action 0';
    if (verb.ambiguous) return `Ambiguous command: ${verb.ambiguous.join(', ')}`;
    if (verb === 'exit') {
      s.closed = true;
      return '';
    }
    if (verb === 'end') return 'Unknown action 0';
    if (verb === 'config') {
      const r = resolveSection(words.slice(1));
      if (r.err) return fail(r.err);
      s.mode = 'cfg';
      s.ctx.stack = [{ section: r.name, key: null }];
      return '';
    }
    if (verb === 'show') {
      if (pick(words[1], ['full-configuration']) === 'full-configuration') return ['#config-version=FGT1HD-7.2.8-FW-build1639-240313:opmode=0:vdom=0:user=admin', `#conf_file_ver=${hashStr(JSON.stringify(s.dev.cfg)) % 999999}`, '#buildno=1639', '#global_vdom=1', ...SECS.flatMap((x) => renderSection(s, s.dev.cfg, x))];
      if (!words[1]) return SECS.flatMap((x) => renderSection(s, s.dev.cfg, x));
      const r = resolveSection(words.slice(1));
      if (r.err) return fail(r.err);
      const key = words[1 + r.used]?.replace(/"/g, '') || null;
      return renderSection(s, s.dev.cfg, r.name, key);
    }
    if (verb === 'get') {
      const keys = Object.keys(GET);
      const want = words.slice(1);
      let best = null;
      for (const k of keys) {
        const kw = k.split(' ');
        if (kw.length > want.length && k !== 'hardware nic') continue;
        let ok = true;
        for (let i = 0; i < kw.length; i++) {
          const opts = [...new Set(keys.filter((x) => x.split(' ').slice(0, i).join(' ') === kw.slice(0, i).join(' ')).map((x) => x.split(' ')[i]).filter(Boolean))];
          const p = pick(want[i], opts);
          if (p !== kw[i]) {
            ok = false;
            break;
          }
        }
        if (ok && (!best || kw.length > best.split(' ').length)) best = k;
      }
      if (!best) return fail(want[want.length - 1] || 'get');
      return GET[best](s, want.slice(best.split(' ').length));
    }
    if (verb === 'execute') {
      const sub = pick(words[1], ['ping', 'ping-options', 'traceroute', 'reboot', 'log', 'backup', 'telnet', 'ssh', 'shutdown', 'date', 'time']);
      if (!sub || sub.ambiguous) return fail(words[1] || 'execute');
      if (sub === 'ping') return fgtPing(s, words[2]);
      if (sub === 'ping-options') {
        const o = pick(words[2], ['source', 'repeat-count', 'data-size', 'df-bit', 'reset', 'view-settings']);
        s.vars.pingOpt = s.vars.pingOpt || {};
        if (o === 'reset') s.vars.pingOpt = {};
        else if (o === 'view-settings') return [`Ping Options:`, `   Repeat Count: ${s.vars.pingOpt['repeat-count'] || 5}`, `   Data Size: ${s.vars.pingOpt['data-size'] || 56}`, `   Source Address: ${s.vars.pingOpt.source || 'auto'}`, `   Don't Fragment: ${s.vars.pingOpt['df-bit'] || 'no'}`];
        else if (o && !o.ambiguous) s.vars.pingOpt[o] = words[3];
        return '';
      }
      if (sub === 'traceroute') {
        const { hops } = trace(s, words[2]);
        return stream([{ d: 10, t: `traceroute to ${words[2]} (${words[2]}), 32 hops max, 3 probe packets per hop, 84 byte packets\n` }, ...hops.flatMap((h, k) => (h.ok ? [{ d: 400, t: ` ${k + 1}  ${h.ip}  ${(0.4 + k).toFixed(3)} ms  ${(0.5 + k).toFixed(3)} ms  ${(0.3 + k).toFixed(3)} ms\n` }] : [1, 2, 3].map((x) => ({ d: 1500, t: ` ${k + x}  * * *\n` }))))]);
      }
      if (sub === 'reboot') return ask('This operation will reboot the system !\nDo you want to continue? (y/n)', (x) => {
        if (!/^y/i.test(x)) return '\nCommand aborted.';
        reload(s.world, s.dev, { reason: `User ${s.user} rebooted the device from ssh(10.250.0.10).` });
        if (s.via !== 'console') s.closed = true;
        return '\n\nSystem is rebooting...';
      }, { key: true });
      if (sub === 'log') {
        const what = pick(words[2], ['display', 'filter', 'delete']);
        if (what === 'display') {
          const logs = s.dev.run.logs.map((e) => fmtEventFortiOS(e, s.dev)).filter(Boolean).reverse();
          return [`${logs.length} logs found.`, `${Math.min(10, logs.length)} logs returned.`, ...logs.slice(0, 10).map((l, k) => `\n${k + 1}: ${l}`)];
        }
        return '';
      }
      return '';
    }
    if (verb === 'diagnose') {
      const sub = pick(words[1], ['sniffer', 'debug', 'hardware', 'sys', 'switch', 'stp', 'netlink', 'ip']);
      if (!sub || sub.ambiguous) return fail(words[1] || 'diagnose');
      if (sub === 'sniffer') {
        const rest = tokenize(raw).map((t) => t.v).slice(3);
        const st = sniffer(s, rest);
        return rest[3] ? finiteGen(st) : st;
      }
      if (sub === 'debug') {
        const a = pick(words[2], ['flow', 'enable', 'disable', 'reset', 'info', 'console']);
        if (a === 'flow') {
          const b = pick(words[3], ['filter', 'trace', 'show']);
          if (b === 'filter') {
            const c = pick(words[4], ['addr', 'clear', 'saddr', 'daddr', 'port', 'proto']);
            if (c === 'clear') s.vars.flowAddr = null;
            else if (c && !c.ambiguous) s.vars.flowAddr = words[5];
            return '';
          }
          if (b === 'trace') {
            if (pick(words[4], ['start', 'stop']) === 'start') s.vars.flowCount = Number(words[5] || 10);
            return '';
          }
          return '';
        }
        if (a === 'enable') {
          if (!s.vars.flowCount) return '';
          const lines = flowTrace(s);
          s.vars.flowCount = 0;
          return stream(lines.map((l) => ({ d: 120, t: `${l}\n` })));
        }
        if (a === 'disable' || a === 'reset') {
          s.vars.flowCount = 0;
          return '';
        }
        return '';
      }
      if (sub === 'hardware') return nicInfo(s, words[4] || words[3]);
      if (sub === 'switch') {
        const c = pick(words[2], ['physical-ports', 'mac-address']);
        if (c === 'physical-ports') return ['Portname    Status  Tpid  Vlan  Duplex  Speed  Flags         Discard', '__________  ______  ____  ____  ______  _____  ____________  _________', ...physIfs(s.dev).map((n) => {
          const i = s.dev.cfg.ifs[n];
          const st = S_(s.world).ifs[s.dev.id][n];
          const L = st?.link ? S_(s.world).links[st.link] : null;
          return `${padR(n, 12)}${padR(s.dev.run.errdis[n] ? 'down' : st?.up ? 'up' : 'down', 8)}8100  ${padR(i.sw ? (i.sw.mode === 'access' ? i.sw.vlan : i.sw.native) : '', 6)}${padR(st?.up ? (L.duplex === 'mismatch' && i.duplex === 'auto' ? 'half' : 'full') : '-', 8)}${padR(st?.up ? (L.speed >= 1000 ? `${L.speed / 1000}G` : `${L.speed}M`) : '-', 7)}${padR(i.stp.edge ? 'QS,E' : 'QS', 14)}none`;
        })];
        if (c === 'mac-address') return ['MAC: ', ...macTable(s.world, s.dev).map((m) => `MAC: ${macColon(m.mac)}  VLAN: ${m.vlan} Port: ${m.port}(port-id ${Object.keys(s.dev.cfg.ifs).indexOf(m.port) + 1})\n  Flags: 0x00000440 [ used ]`)];
        return '';
      }
      if (sub === 'stp') return ['Instance Information:', `  Instance ID         : 0 (CST)`, `  Switch Priority     : ${Math.min(...Object.values(s.dev.cfg.stp.prio), 32768)}`, '', '  Port        Speed   Cost      Priority   Role         State       HelloTime  Flags', ...physIfs(s.dev).filter((n) => s.dev.cfg.ifs[n].sw && S_(s.world).ifs[s.dev.id][n]?.up).map((n) => `  ${padR(n, 12)}1G      20000     128        ${padR(S_(s.world).stp.blocked[s.dev.id]?.[n] ? 'ALTERNATE' : 'DESIGNATED', 13)}${padR(S_(s.world).stp.blocked[s.dev.id]?.[n] ? 'DISCARDING' : 'FORWARDING', 12)}2          ${s.dev.cfg.ifs[n].stp.edge ? 'ED' : ''}`)];
      return '';
    }
    return 'Unknown action 0';
  }
  function fgtPing(s, target) {
    if (!target) return fail('ping');
    if (!isIp(target)) return `Unable to resolve hostname.`;
    const o = s.vars.pingOpt || {};
    const count = Number(o['repeat-count'] || 5);
    const size = Number(o['data-size'] || 56);
    const p = ping(s, target, { count, size: size + 28, df: o['df-bit'] === 'yes', src: o.source && o.source !== 'auto' ? o.source : null });
    const chunks = [{ d: 10, t: `PING ${target} (${target}): ${size} data bytes\n` }];
    p.res.forEach((x, k) => chunks.push({ d: x.ok ? 300 : 1000, t: x.ok ? `${size + 8} bytes from ${target}: icmp_seq=${k} ttl=${p.r.toDevice ? 255 : 63} time=${(x.rtt * 0.4).toFixed(1)} ms\n` : '' }));
    chunks.push({ d: 0, t: `\n--- ${target} ping statistics ---\n${count} packets transmitted, ${p.recv} packets received, ${100 - p.pct}% packet loss\n${p.recv ? `round-trip min/avg/max = ${(p.min * 0.4).toFixed(1)}/${(p.avg * 0.4).toFixed(1)}/${(p.max * 0.4).toFixed(1)} ms\n` : ''}` });
    return stream(chunks);
  }
  // help for "?" (FortiOS prints the next possible words)
  function helpHook(s, line) {
    const words = tokenize(line).map((t) => t.v);
    const trailing = line.endsWith(' ') || !line;
    const partial = trailing ? '' : words.pop() || '';
    const fmt = (pairs) => pairs.filter(([k]) => k.startsWith(partial)).map(([k, h]) => `${padR(k, 18)}${h}`).join('\n');
    if (s.mode === 'top') {
      if (!words.length) return fmt([['config', 'Configure object.'], ['get', 'Get dynamic and system information.'], ['show', 'Show configuration.'], ['diagnose', 'Diagnose facility.'], ['execute', 'Execute static commands.'], ['exit', 'Exit the CLI.']]);
      const v = pick(words[0], ['config', 'get', 'show', 'execute', 'diagnose']);
      if (v === 'config' || v === 'show') {
        if (words.length === 1) return fmt(sectionWords.map((w) => [w, `Configure ${w}.`]));
        const lvl1 = pick(words[1], sectionWords);
        return fmt(SECS.filter((x) => x.startsWith(`${lvl1} `)).map((x) => [x.split(' ').slice(1).join(' '), `Configure ${x}.`]));
      }
      if (v === 'get') {
        const done = words.slice(1);
        const opts = new Map();
        for (const k of Object.keys(GET)) {
          const kw = k.split(' ');
          if (kw.slice(0, done.length).every((w, i) => pick(done[i], [w]) === w) && kw[done.length]) opts.set(kw[done.length], `${kw.slice(0, done.length + 1).join(' ')}`);
        }
        return fmt([...opts.entries()]);
      }
      if (v === 'execute') return fmt([['ping', 'PING command.'], ['ping-options', 'Set ping options.'], ['traceroute', 'Traceroute {IP|hostname}.'], ['reboot', 'Reboot the FortiGate.'], ['log', 'Log commands.']]);
      if (v === 'diagnose') return fmt([['sniffer', 'Sniffer.'], ['debug', 'Debug commands.'], ['hardware', 'Hardware commands.'], ['switch', 'Switch commands.'], ['stp', 'STP commands.']]);
      return '';
    }
    const f = frame(s);
    const sec = SECTIONS[f.section];
    if (!words.length) return fmt([...(sec.table ? [['edit', 'Add new entry/edit existing entry.'], ['delete', 'Delete table entry.']] : [['set', 'Modify value.'], ['unset', 'Set to default value.']]), ...(f.key != null ? [['set', 'Modify value.'], ['unset', 'Set to default value.'], ['next', 'Configure next table entry.']] : []), ...(sec.subs ? [['config', 'Configure object.']] : []), ['get', 'Get dynamic and system information.'], ['show', 'Show configuration.'], ['abort', 'End and discard last config.'], ['end', 'End and save last config.']]);
    const v = pick(words[0], ['set', 'unset', 'edit', 'config']);
    if (v === 'set' || v === 'unset') return fmt(Object.entries(sec.fields));
    if (v === 'edit') return fmt(sec.table ? sec.list(cfgOf(s)).map((k) => [k, '']) : []);
    if (v === 'config') return fmt((sec.subs || []).map((x) => [x, `Configure ${x}.`]));
    return '';
  }
  function completeHook(s, line) {
    const words = tokenize(line).map((t) => t.v);
    if (!words.length || line.endsWith(' ')) return { line, options: [] };
    const last = words[words.length - 1];
    let pool = [];
    if (s.mode === 'top') {
      if (words.length === 1) pool = ['config', 'get', 'show', 'execute', 'diagnose', 'exit'];
      else if (['config', 'show'].includes(pick(words[0], ['config', 'show']))) pool = words.length === 2 ? sectionWords : SECS.filter((x) => x.startsWith(`${pick(words[1], sectionWords)} `)).map((x) => x.split(' ')[1]);
      else if (pick(words[0], ['get']) === 'get') pool = [...new Set(Object.keys(GET).map((k) => k.split(' ')[words.length - 2]).filter(Boolean))];
      else if (pick(words[0], ['execute']) === 'execute') pool = ['ping', 'ping-options', 'traceroute', 'reboot', 'log'];
      else if (pick(words[0], ['diagnose']) === 'diagnose') pool = ['sniffer', 'debug', 'hardware', 'switch', 'stp'];
    } else {
      const sec = SECTIONS[frame(s).section];
      if (words.length === 1) pool = ['set', 'unset', 'edit', 'next', 'end', 'abort', 'show', 'get', 'delete', 'config'];
      else if (['set', 'unset'].includes(pick(words[0], ['set', 'unset']))) pool = Object.keys(sec.fields);
      else if (pick(words[0], ['edit']) === 'edit' && sec.table) pool = sec.list(cfgOf(s));
    }
    const opts = pool.filter((p) => p.startsWith(last));
    if (opts.length === 1) return { line: line.slice(0, line.length - last.length) + opts[0] + ' ', options: [] };
    return { line, options: opts };
  }
  return {
    id: variant,
    startMode: 'top',
    pipes: ['grep'],
    defaultLen: 25,
    more: '--More-- ',
    consoleLogin: true,
    prompt(s) {
      if (s.dev.state !== 'up') return '';
      const h = s.dev.cfg.hostname;
      if (s.mode === 'top') return `${h} # `;
      return `${h} (${promptName(s)}) # `;
    },
    greeting: () => '',
    loginPrompt: (dev) => `${dev.cfg.hostname} login: `,
    telnetBanner: () => '',
    consoleBanner: () => '',
    closeMsg: (s) => (s.via === 'console' ? '\n[Disconnected from console server]\n' : `Connection to ${s.world.design.mgmt[s.dev.id]} closed.\n`),
    preprocess(s, line) {
      if (s.dev.state !== 'up') return '';
      const { cmd, pipes } = s.splitPipes(line);
      const out = topLine(s, cmd);
      if (pipes.length && (typeof out === 'string' || Array.isArray(out))) {
        const lines = Array.isArray(out) ? out : out.split('\n');
        const g = tokenize(pipes[0]).map((t) => t.v);
        const inv = g.includes('-v');
        const ci = g.includes('-i');
        const pat = g.filter((x, i) => i > 0 && !x.startsWith('-')).join(' ');
        let re;
        try {
          re = new RegExp(pat, ci ? 'i' : '');
        } catch {
          re = { test: (x) => x.includes(pat) };
        }
        return lines.filter((l) => (inv ? !re.test(l) : re.test(l)));
      }
      return out;
    },
    trie: () => ({ kws: new Map(), params: [], end: null }),
    helpHook,
    completeHook,
    helpFmt: () => '',
    error: (s, kind, x) => fail(x.toks?.[x.at]?.v || ''),
    ctrlC: () => '\n',
    fmtEvent: fmtEventFortiOS,
  };
}

// =============================================================================================
// FortiAP shell (BusyBox based)
export function makeFortiAP() {
  return {
    id: 'fortiap',
    startMode: 'sh',
    consoleLogin: true,
    loginPrompt: (dev) => `${dev.cfg.hostname} login: `,
    consoleBanner: () => '',
    prompt: (s) => (s.dev.state !== 'up' ? '' : `${s.dev.cfg.hostname} # `),
    greeting: () => '\n\nBusyBox v1.31.1 (2024-01-11 09:12:44 UTC) built-in shell (ash)\n\n',
    closeMsg: () => '\n[Disconnected from console server]\n',
    trie: () => ({ kws: new Map(), params: [], end: null }),
    helpFmt: () => '',
    error: () => '',
    preprocess(s, line) {
      const w = tokenize(line).map((t) => t.v);
      const ap = s.dev.cfg.ap || {};
      const S = S_(s.world);
      switch (w[0]) {
        case undefined:
          return '';
        case 'cfg':
          if (w[1] === '-s') return [`BAUD_RATE:=9600`, `ADDR_MODE:=STATIC`, `AP_IPADDR:=${ap.ip || '192.168.1.2'}`, `AP_NETMASK:=255.255.255.0`, `IPGW:=${(ap.ip || '0.0.0.0').replace(/\.\d+$/, '.1')}`, `AP_MODE:=0`, `DNS_SERVER:=10.20.0.53`, `AC_DISCOVERY_TYPE:=1`, `AC_IPADDR_1:=${ap.ctrl || ''}`, `AC_CTL_PORT:=5246`, `AC_DATA_CHAN_SEC:=clear`];
          if (w[1] === '-a') {
            const [k, v] = (w[2] || '').split('=');
            s.vars.pend = { ...(s.vars.pend || {}), [k]: v };
            return '';
          }
          if (w[1] === '-c') {
            const p = s.vars.pend || {};
            s.dev.cfg.ap = { ...ap, ctrl: p.AC_IPADDR_1 ?? ap.ctrl, ip: p.AP_IPADDR ?? ap.ip };
            s.vars.pend = {};
            s.world.dirty = true;
            recompute(s.world);
            return '';
          }
          return 'Usage: cfg -s | -a VAR=VALUE | -c | -x';
        case 'cw_diag': {
          const st = S.wifi.aps[s.dev.id] || {};
          if (w[1] === '-c' && w[2] === 'wtp-cfg') return [`WTP Config:`, `    AC IP 1         : ${ap.ctrl || 'none'}`, `    AC discovery    : static`, `    current state   : ${st.state === 'up' ? 'RUN' : 'DISCOVERY'}`, `    reason          : ${st.why || ''}`];
          return [`cw_diag usage:`, `    cw_diag -c wtp-cfg      # show WTP config`, `    cw_diag help`];
        }
        case 'ifconfig':
          return [`br0       Link encap:Ethernet  HWaddr ${macColon(macOfIf(s.dev, 'base'))}`, `          inet addr:${ap.ip || '192.168.1.2'}  Bcast:0.0.0.0  Mask:255.255.255.0`, `          UP BROADCAST RUNNING MULTICAST  MTU:1500  Metric:1`];
        case 'ping': {
          const p = ping({ ...s, dev: null, host: { id: '__ap', ip: ap.ip } }, w[w.length - 1], { count: 3 });
          void p;
          const ok = S.wifi.aps[s.dev.id]?.state === 'up' || w[w.length - 1] === ap.ip;
          return stream([{ d: 10, t: `PING ${w[w.length - 1]} (${w[w.length - 1]}): 56 data bytes\n` }, ...(ok ? [1, 2, 3].map((k) => ({ d: 500, t: `64 bytes from ${w[w.length - 1]}: seq=${k - 1} ttl=64 time=0.${k}12 ms\n` })) : [{ d: 3000, t: '' }]), { d: 0, t: `\n--- ${w[w.length - 1]} ping statistics ---\n3 packets transmitted, ${ok ? 3 : 0} packets received, ${ok ? 0 : 100}% packet loss\n` }]);
        }
        case 'reboot':
          reload(s.world, s.dev, { reason: 'reboot' });
          s.closed = true;
          return 'The system is going down NOW!';
        case 'exit':
          s.closed = true;
          return '';
        default:
          return `-ash: ${w[0]}: not found`;
      }
    },
  };
}
void Session;
void cfgOf;
void model;
void sortedIfs;
void logEvent;
void saveStartup;
void maskLen;
