// Cisco ASA / PIX / Firepower (ASA code). nameif + security levels, object NAT (8.3+) or legacy NAT,
// access-groups, packet-tracer and captures.
import { compile, ask, stream } from './engine.js';
import { model, resolveIf } from '../net/catalog.js';
import { saveStartup } from '../net/model.js';
import { S_, cfgOf, changed, configEnded, ping, trace, counters, sortedIfs, physIfs, uptimeMins, ipOnly, lenOf } from './common.js';
import { KW, parseAce, doReload, ifStatusWord } from './ios.js';
import { lookup, walk } from '../net/sim.js';
import { logEvent } from '../net/events.js';
import { cidr, n2ip, ip2n, maskStr, maskLen, isIp, fmtDate, upCisco, padR, padL, hashStr, yearOf, inNet } from '../core/util.js';

const legacyNat = (dev) => {
  const [maj, min] = String(dev.version).split(/[.(]/).map(Number);
  return maj < 8 || (maj === 8 && min < 3);
};
export const asaLegacy = legacyNat;
const nameOf = (dev, n) => dev.cfg.ifs[n]?.nameif || '';
const ifByName = (dev, name) => Object.keys(dev.cfg.ifs).find((n) => dev.cfg.ifs[n].nameif === name);
const PN = { 443: 'https', 80: 'www', 22: 'ssh', 23: 'telnet', 53: 'domain' };
const spec = (x) => (!x || x === 'any' ? 'any' : x.endsWith('/32') ? `host ${x.split('/')[0]}` : `${n2ip(cidr(x).net)} ${maskStr(cidr(x).len)}`);
const aceText = (e) => `${e.act} ${e.proto || 'ip'} ${spec(e.src)} ${spec(e.dst)}${e.dport ? ` eq ${PN[e.dport] || e.dport}` : ''}`;

function running(s, cfg = s.dev.cfg) {
  const dev = s.dev;
  const m = model(dev.model);
  const L = [': Saved', ':', `: Serial Number: ${dev.hw.serial}`, `: Hardware:   ${dev.model.toUpperCase()}, ${m.u > 1 ? 4096 : 1024} MB RAM, CPU Pentium 4 Celeron 1600 MHz`, ':', `${dev.model.startsWith('pix') ? 'PIX' : 'ASA'} Version ${dev.version} `, '!', `hostname ${cfg.hostname}`, `domain-name ${cfg.svc.domain}`];
  L.push(`enable password ${hashStr(cfg.svc.enable || 'x').toString(36).padEnd(16, 'X').slice(0, 16)} encrypted`, 'names', '!');
  for (const n of sortedIfs(dev, (i) => ['phys', 'mgmt', 'sub'].includes(i.kind))) {
    const i = cfg.ifs[n];
    L.push(`interface ${n}`);
    if (i.desc) L.push(` description ${i.desc}`);
    if (!i.on) L.push(' shutdown');
    if (i.nameif) L.push(` nameif ${i.nameif}`, ` security-level ${i.seclvl ?? 0}`);
    else L.push(' no nameif', ' no security-level');
    L.push(i.ip ? ` ip address ${ipOnly(i.ip)} ${maskStr(lenOf(i.ip))} ` : ' no ip address');
    if (i.kind === 'mgmt') L.push(' management-only');
    L.push('!');
  }
  L.push('ftp mode passive', `dns domain-lookup ${ifByName(dev, 'inside') ? 'inside' : 'outside'}`);
  for (const [name, entries] of Object.entries(cfg.acls)) for (const e of entries) L.push(`access-list ${name} extended ${aceText(e)} `);
  L.push('pager lines 24', 'logging enable', 'logging timestamp', 'logging buffered informational');
  for (const h of cfg.svc.syslog) L.push(`logging host ${ifByName(dev, 'inside') ? 'inside' : 'management'} ${h}`);
  for (const n of Object.keys(cfg.ifs)) if (cfg.ifs[n].nameif) L.push(`mtu ${cfg.ifs[n].nameif} ${cfg.ifs[n].mtu || 1500}`);
  L.push('icmp unreachable rate-limit 1 burst-size 1', 'arp timeout 14400');
  const fw = cfg.fw;
  if (legacyNat(dev)) {
    if (fw.snat.some((x) => x.on)) L.push('global (outside) 1 interface', 'nat (inside) 1 10.0.0.0 255.0.0.0');
    for (const v of fw.vip) L.push(`static (inside,outside) ${v.ext} ${v.int} netmask 255.255.255.255 `);
  } else {
    for (const v of fw.vip) L.push(`object network ${v.name}`, ` host ${v.int}`);
    if (fw.snat.some((x) => x.on)) L.push('object network INSIDE-NETS', ' subnet 10.0.0.0 255.0.0.0');
    for (const v of fw.vip) L.push(`object network ${v.name}`, ` nat (inside,outside) static ${v.ext}`);
    if (fw.snat.some((x) => x.on)) L.push('object network INSIDE-NETS', ' nat (inside,outside) dynamic interface');
  }
  for (const n of Object.keys(cfg.ifs)) if (cfg.ifs[n].acl?.in) L.push(`access-group ${cfg.ifs[n].acl.in} in interface ${cfg.ifs[n].nameif}`);
  if (cfg.ospf.on) {
    L.push(`router ospf ${cfg.ospf.pid}`);
    if (cfg.ospf.rid) L.push(` router-id ${cfg.ospf.rid}`);
    for (const i of Object.values(cfg.ifs)) if (i.ospf?.area != null && i.ip) L.push(` network ${n2ip(cidr(i.ip).net)} ${maskStr(lenOf(i.ip))} area ${i.ospf.area === '0.0.0.0' ? 0 : i.ospf.area}`);
    for (const i of Object.values(cfg.ifs)) if (i.ospf?.passive && i.nameif) L.push(` passive-interface ${i.nameif}`);
    if (cfg.ospf.defOrig) L.push(' default-information originate');
    L.push(' log-adj-changes', '!');
  }
  for (const r of cfg.static) {
    const oif = Object.keys(cfg.ifs).find((n) => cfg.ifs[n].ip && r.nh && inNet(r.nh, cfg.ifs[n].ip));
    L.push(`route ${oif ? cfg.ifs[oif].nameif : 'outside'} ${n2ip(cidr(r.pfx).net)} ${maskStr(cidr(r.pfx).len)} ${r.nh} ${r.ad || 1}`);
  }
  L.push('timeout xlate 3:00:00', 'timeout conn 1:00:00 half-closed 0:10:00 udp 0:02:00', 'user-identity default-domain LOCAL', 'aaa authentication ssh console LOCAL');
  if (cfg.svc.snmp) L.push(`snmp-server host management 10.20.0.20 community ${cfg.svc.snmp}`);
  L.push('ssh 10.250.0.0 255.255.255.0 management', 'ssh timeout 5', 'ssh version 2', 'console timeout 0');
  for (const n of cfg.svc.ntp) L.push(`ntp server ${n} source management`);
  for (const u of cfg.svc.users) L.push(`username ${u.name} password ${hashStr(u.pw).toString(36).padEnd(16, 'q').slice(0, 16)} encrypted privilege ${u.priv}`);
  L.push('!', 'class-map inspection_default', ' match default-inspection-traffic', '!', 'policy-map global_policy', ' class inspection_default', '  inspect dns ', '  inspect ftp ', '  inspect icmp ', '!', 'service-policy global_policy global', `Cryptochecksum:${hashStr(JSON.stringify(cfg)).toString(16)}${hashStr(cfg.hostname).toString(16)}`, ': end');
  return L;
}

// ---------------------------------------------------------------------------------------------
function asaRoute(s) {
  const dev = s.dev;
  const S = S_(s.world);
  const rib = S.rib[dev.id]?.best || [];
  const nm = (oif) => nameOf(dev, oif) || oif;
  const out = ['', 'Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP', '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area ', '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2', '       E1 - OSPF external type 1, E2 - OSPF external type 2, V - VPN', '       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2', '       ia - IS-IS inter area, * - candidate default, U - per-user static route', '       o - ODR, P - periodic downloaded static route, + - replicated route', ''];
  const def = rib.find((r) => r.pfx === '0.0.0.0/0');
  out.push(def ? `Gateway of last resort is ${def.nh} to network 0.0.0.0` : 'Gateway of last resort is not set', '');
  for (const r of rib) {
    const c = cidr(r.pfx);
    const pm = `${n2ip(c.net)} ${maskStr(c.len)}`;
    const code0 = { connected: 'C', local: 'L', static: 'S', ospf: 'O', ospfE: 'O E2', ebgp: 'B' }[r.proto];
    const code = r.pfx === '0.0.0.0/0' ? code0.replace(/^(\w) ?/, '$1*') : code0;
    if (r.proto === 'connected' || r.proto === 'local') {
      if (r.proto === 'local' && legacyNat(dev)) continue;
      out.push(`${padR(code, 9)}${pm} is directly connected, ${nm(r.oif)}`);
    } else out.push(`${padR(code, 9)}${pm} [${r.ad}/${r.metric}] via ${r.nh}${r.proto.startsWith('ospf') ? `, ${upCisco(600)}` : ''}, ${nm(r.oif)}`);
  }
  return out;
}

function packetTracer(s, a) {
  const dev = s.dev;
  const S = S_(s.world);
  const inIf = ifByName(dev, a.ifname);
  if (!inIf) return `ERROR: interface '${a.ifname}' not found`;
  const proto = a.proto;
  const pkt = { src: a.src, dst: a.dst, proto, dport: a.dport || null };
  const phases = [];
  let n = 0;
  const phase = (type, sub, result, config, info) => phases.push(`Phase: ${++n}`, `Type: ${type}`, `Subtype: ${sub}`, `Result: ${result}`, 'Config:', ...(config ? config.split('\n') : []), 'Additional Information:', ...(info ? info.split('\n') : []), '');
  const fw = dev.cfg.fw;
  const vip = fw.vip.find((v) => v.ext === pkt.dst) || null;
  const zIn = dev.cfg.ifs[inIf].zone;
  let realDst = pkt.dst;
  if (vip && zIn === 'outside') {
    realDst = vip.int;
    phase('UN-NAT', 'static', 'ALLOW', legacyNat(dev) ? `static (inside,outside) ${vip.ext} ${vip.int} netmask 255.255.255.255` : `object network ${vip.name}\n nat (inside,outside) static ${vip.ext}`, `NAT divert to egress interface inside\nUntranslate ${vip.ext}/${pkt.dport || 0} to ${vip.int}/${pkt.dport || 0}`);
  }
  const r = lookup(s.world, dev, realDst);
  const outIf = r?.oif;
  phase('ROUTE-LOOKUP', 'Resolve Egress Interface', r ? 'ALLOW' : 'DROP', '', r ? `found next-hop ${r.nh || realDst} using egress ifc  ${nameOf(dev, outIf)}` : `no route to host ${realDst}`);
  let action = r ? 'allow' : 'drop';
  let drop = r ? '' : '(no-route) No route to host';
  if (r) {
    const acl = dev.cfg.ifs[inIf].acl?.in;
    const lin = dev.cfg.ifs[inIf].seclvl ?? 0;
    const lout = dev.cfg.ifs[outIf]?.seclvl ?? 0;
    const target = legacyNat(dev) ? pkt.dst : realDst;
    if (acl) {
      const entries = dev.cfg.acls[acl] || [];
      const hit = entries.find((e) => (e.proto === 'ip' || e.proto === proto) && (e.src === 'any' || inNet(pkt.src, e.src)) && (e.dst === 'any' || inNet(target, e.dst)) && (!e.dport || e.dport === pkt.dport));
      if (hit && hit.act === 'permit') phase('ACCESS-LIST', '', 'ALLOW', `access-group ${acl} in interface ${a.ifname}\naccess-list ${acl} extended ${aceText(hit)}`, '');
      else {
        phase('ACCESS-LIST', '', 'DROP', hit ? `access-group ${acl} in interface ${a.ifname}\naccess-list ${acl} extended ${aceText(hit)}` : 'Implicit Rule', '');
        action = 'drop';
        drop = '(acl-drop) Flow is denied by configured rule';
      }
    } else if (lin <= lout) {
      phase('ACCESS-LIST', '', 'DROP', 'Implicit Rule', '');
      action = 'drop';
      drop = '(acl-drop) Flow is denied by configured rule';
    } else phase('ACCESS-LIST', '', 'ALLOW', 'Implicit Rule', '');
    if (action === 'allow') {
      phase('INSPECT', 'np-inspect', 'ALLOW', 'class-map inspection_default\n match default-inspection-traffic\npolicy-map global_policy\n class inspection_default\n  inspect icmp \nservice-policy global_policy global', '');
      if (!vip && dev.cfg.ifs[outIf]?.zone === 'outside' && fw.snat.some((x) => x.on)) phase('NAT', '', 'ALLOW', legacyNat(dev) ? 'nat (inside) 1 10.0.0.0 255.0.0.0\nglobal (outside) 1 interface' : 'object network INSIDE-NETS\n nat (inside,outside) dynamic interface', `Dynamic translate ${pkt.src}/${a.sport || 0} to ${ipOnly(dev.cfg.ifs[outIf].ip)}/${a.sport || 0}`);
      const st = S.ifs[dev.id][outIf];
      if (!st?.proto) {
        action = 'drop';
        drop = '(ifc-down) Interface is down';
      } else phase('FLOW-CREATION', '', 'ALLOW', '', `New flow created with id ${hashStr(pkt.src + pkt.dst) % 99999}, packet dispatched to next module`);
    }
  }
  const outName = outIf ? nameOf(dev, outIf) : '';
  const st = (x) => (S.ifs[dev.id][x]?.up ? 'up' : 'down');
  phases.push('Result:', `input-interface: ${a.ifname}`, `input-status: ${st(inIf)}`, `input-line-status: ${st(inIf)}`, ...(outIf ? [`output-interface: ${outName}`, `output-status: ${st(outIf)}`, `output-line-status: ${st(outIf)}`] : []), `Action: ${action}`, ...(drop ? [`Drop-reason: ${drop}`] : []));
  return phases;
}

function captureShow(s, name) {
  const dev = s.dev;
  const cap = dev.run.captures?.[name];
  if (!cap) return `ERROR: Capture <${name}> does not exist`;
  const W = s.world;
  const lines = [];
  const isp = Object.values(W.hosts).find((h) => h.kind === 'isp');
  const ifn = ifByName(dev, cap.ifname);
  let k = 0;
  for (const c of W.design.customers.filter((x) => x.web)) {
    if (cap.host && cap.host !== c.vip && cap.host !== W.hosts[c.servers[0]]?.ip) continue;
    const r = isp ? walk(W, { host: isp.id }, c.vip, { proto: 'tcp', dport: 443 }) : null;
    if (!r) continue;
    const seen = r.hops.some((h) => h.dev === dev.id && (h.inIf === ifn || r.linksUsed.length));
    const passed = r.ok || (r.at !== dev.id && r.hops.some((h) => h.dev === dev.id));
    for (let i = 0; i < 3; i++) {
      const src = `198.51.100.${77 + i}`;
      const sp = 40000 + (hashStr(src + c.id + i) % 20000);
      const dst = cap.ifname === 'outside' ? c.vip : W.hosts[c.servers[0]]?.ip;
      if (cap.ifname === 'outside' && seen) lines.push(`${++k}: ${fmtDate(W.time.t, 'datetime').slice(11)}:${String(10 + i * 7).padStart(2, '0')}.${hashStr(src) % 999999} ${src}.${sp} > ${dst}.443: S ${hashStr(src + i)}:${hashStr(src + i)}(0) win 64240 <mss 1460,sackOK,timestamp>`);
      else if (cap.ifname !== 'outside' && passed && r.ok) {
        lines.push(`${++k}: ${fmtDate(W.time.t, 'datetime').slice(11)}:${String(10 + i * 7).padStart(2, '0')}.${hashStr(src) % 999999} ${src}.${sp} > ${dst}.443: S ${hashStr(src + i)}:${hashStr(src + i)}(0) win 64240`);
        lines.push(`${++k}: ${fmtDate(W.time.t, 'datetime').slice(11)}:${String(10 + i * 7).padStart(2, '0')}.${(hashStr(src) % 999999) + 412} ${dst}.443 > ${src}.${sp}: S ${hashStr(dst + i)}:${hashStr(dst + i)}(0) ack ${hashStr(src + i) + 1} win 65160`);
      }
    }
  }
  return [`${lines.length} packet${lines.length === 1 ? '' : 's'} captured`, '', ...lines, `${lines.length} packet${lines.length === 1 ? '' : 's'} shown`];
}

export function fmtEventASA(e, dev) {
  const ts = `${fmtDate(e.t, 'syslog').replace(/^(\w+) +(\d+)/, '$1 $2 ' + fmtDate(e.t, 'iso').slice(0, 4))}: `;
  const nm = (n) => dev.cfg.ifs[n]?.nameif || n;
  switch (e.type) {
    case 'link':
      return e.kind === 'phys' || e.kind === 'mgmt' ? `${ts}%ASA-4-411001: Line protocol on Interface ${e.if}, changed state to ${e.up ? 'up' : 'down'}`.replace('411001', e.up ? '411001' : '411002') : null;
    case 'proto':
      return null;
    case 'ospf':
      return `${ts}%ASA-5-503001: Process ${dev.cfg.ospf.pid}, Nbr ${e.nbr} on ${nm(e.if)} from ${e.from} to ${e.to}, ${e.to === 'FULL' ? 'LOADING_DONE' : e.why || 'Neighbor Down: Dead timer expired'}`;
    case 'config':
      return `${ts}%ASA-5-111008: User '${e.by}' executed the 'configure terminal' command.\n${ts}%ASA-5-111010: User '${e.by}', running 'CLI' from IP ${e.from || '10.250.0.10'}, executed 'end'`;
    case 'login':
      return `${ts}%ASA-6-605005: Login permitted from ${e.from}/${40000 + (hashStr(String(e.t)) % 9999)} to management:${dev.cfg.ifs[dev.meta.mgmtIf]?.ip?.split('/')[0]}/ssh for user "${e.user}"`;
    case 'authfail':
      return `${ts}%ASA-6-113015: AAA user authentication Rejected : reason = Invalid password : local database : user = ${e.user} : user IP = ${e.from}`;
    case 'deny':
      return `${ts}%ASA-4-106023: Deny tcp src ${e.inIf}:${e.src}/${e.sport} dst ${e.outIf}:${e.dst}/${e.dport} by access-group "${e.acl}" [0x0, 0x0]`;
    case 'psu':
      return `${ts}%ASA-1-735005: Power Supply Unit Redundancy ${e.ok ? 'OK' : 'Lost'}`;
    case 'fan':
      return `${ts}%ASA-1-735002: Cooling Fan ${e.n}: ${e.ok ? 'OK' : 'Failure Detected'}`;
    case 'temp':
      return `${ts}%ASA-1-735011: CPU ${e.temp} C: Temperature Critical`;
    case 'boot':
      return `${ts}%ASA-6-199002: Startup completed.  Beginning operation.\n${ts}%ASA-6-199018: ${dev.cfg.hostname} reloaded. Reason: ${dev.run.reloadReason || 'power-on'}`;
    case 'save':
      return `${ts}%ASA-5-111008: User '${e.by}' executed the 'write memory' command.`;
    default:
      return null;
  }
}

function asaPing(s, a) {
  const target = a.target;
  if (!isIp(target)) return `ERROR: % Invalid Hostname`;
  const p = ping(s, target, { count: a.repeat || 5, size: a.size || 100, src: a.ifname ? ipOnly(s.dev.cfg.ifs[ifByName(s.dev, a.ifname)]?.ip) : null });
  const chunks = [{ d: 10, t: `Type escape sequence to abort.\nSending ${a.repeat || 5}, ${a.size || 100}-byte ICMP Echos to ${target}, timeout is 2 seconds:\n` }];
  for (const x of p.res) chunks.push({ d: x.ok ? 80 : 700, t: x.ok ? '!' : '?'.replace('?', '.') });
  chunks.push({ d: 0, t: `\nSuccess rate is ${p.pct} percent (${p.recv}/${p.sent})${p.recv ? `, round-trip min/avg/max = ${p.min}/${p.avg}/${p.max} ms` : ''}\n` });
  return stream(chunks);
}

export function makeASA() {
  const sel = (s) => cfgOf(s).ifs[s.ctx.if];
  const ifc = [
    { p: 'nameif $word:name', run: (s, a) => {
      const i = sel(s);
      i.nameif = a.name;
      i.zone = /^inside/.test(a.name) ? 'inside' : a.name === 'outside' ? 'outside' : a.name;
      if (i.seclvl == null) i.seclvl = a.name === 'inside' ? 100 : 0;
      changed(s);
      return a.name === 'inside' ? 'INFO: Security level for "inside" set to 100 by default.' : a.name === 'outside' ? 'INFO: Security level for "outside" set to 0 by default.' : '';
    } },
    { p: 'no nameif', run: (s) => ((sel(s).nameif = null), (sel(s).zone = null), changed(s)) },
    { p: 'security-level $num(0-100):lvl', run: (s, a) => ((sel(s).seclvl = a.lvl), changed(s)) },
    { p: 'ip address $ip:ip $mask:mask [standby $ip:sb]', run: (s, a) => ((sel(s).ip = `${a.ip}/${maskLen(a.mask)}`), changed(s)) },
    { p: 'no ip address', run: (s) => ((sel(s).ip = null), changed(s)) },
    { p: 'shutdown', run: (s) => ((sel(s).on = false), changed(s)) },
    { p: 'no shutdown', run: (s) => ((sel(s).on = true), changed(s)) },
    { p: 'description $line:d', run: (s, a) => ((sel(s).desc = a.d), changed(s)) },
    { p: 'speed {10|100|1000|auto}', run: (s, a) => ((sel(s).speed = a.kw[1] === 'auto' ? 'auto' : Number(a.kw[1])), changed(s)) },
    { p: 'duplex {full|half|auto}', run: (s, a) => ((sel(s).duplex = a.kw[1]), changed(s)) },
    { p: 'management-only', run: () => '' },
  ];
  const objNet = [
    { p: 'host $ip:ip', run: (s, a) => {
      const fw = cfgOf(s).fw;
      let v = fw.vip.find((x) => x.name === s.ctx.obj);
      if (!v) fw.vip.push((v = { name: s.ctx.obj, int: a.ip, ext: null }));
      v.int = a.ip;
      changed(s);
    } },
    { p: 'subnet $ip:ip $mask:mask', run: (s) => ((s.ctx.subnet = true), '') },
    { p: 'nat (inside,outside) static $ip:ext', run: (s, a) => {
      const fw = cfgOf(s).fw;
      const v = fw.vip.find((x) => x.name === s.ctx.obj);
      if (!v) return 'ERROR: object must contain a host before NAT can be configured';
      v.ext = a.ext;
      changed(s);
    } },
    { p: 'nat (inside,outside) dynamic interface', run: (s) => {
      const fw = cfgOf(s).fw;
      if (!fw.snat.length) fw.snat.push({ from: 'inside', to: 'outside', on: true });
      fw.snat.forEach((x) => (x.on = true));
      changed(s);
    } },
    { p: 'no nat [(inside,outside)] [{static|dynamic}] [$word:x]', run: (s) => {
      const fw = cfgOf(s).fw;
      const v = fw.vip.find((x) => x.name === s.ctx.obj);
      if (v) v.ext = null;
      else fw.snat.forEach((x) => (x.on = false));
      changed(s);
    } },
  ];
  const g = [
    { p: 'hostname $word:h', run: (s, a) => ((cfgOf(s).hostname = a.h), (s.dev.hostname = a.h), changed(s)) },
    { p: 'interface $if:if', run: (s, a) => ((s.ctx = { if: a.if }), (s.mode = 'if'), '') },
    { p: 'access-list $word:name extended $line:rest', run: (s, a) => {
      const words = a.rest.split(/\s+/).map((w) => (w === 'https' ? '443' : w === 'www' ? '80' : w));
      const e = parseAce(words, false);
      if (!e) return "ERROR: % Invalid input detected at '^' marker.";
      (cfgOf(s).acls[a.name] = cfgOf(s).acls[a.name] || []).push(e);
      changed(s);
    } },
    { p: 'no access-list $word:name extended $line:rest', run: (s, a) => {
      const list = cfgOf(s).acls[a.name] || [];
      const e = parseAce(a.rest.split(/\s+/).map((w) => (w === 'https' ? '443' : w)), false);
      const k = list.findIndex((x) => x.act === e?.act && x.dst === e?.dst && x.src === e?.src && (x.dport || null) === (e?.dport || null));
      if (k < 0) return `ERROR: entry not found`;
      list.splice(k, 1);
      changed(s);
    } },
    { p: 'clear configure access-list $word:name', run: (s, a) => (delete cfgOf(s).acls[a.name], changed(s)) },
    { p: 'access-group $word:acl in interface $word:ifname', run: (s, a) => {
      const n = ifByName(s.dev, a.ifname);
      if (!n) return `ERROR: % interface ${a.ifname} not found`;
      cfgOf(s).ifs[n].acl.in = a.acl;
      changed(s);
    } },
    { p: 'no access-group $word:acl in interface $word:ifname', run: (s, a) => {
      const n = ifByName(s.dev, a.ifname);
      if (n) cfgOf(s).ifs[n].acl.in = null;
      changed(s);
    } },
    { p: 'object network $word:name', run: (s, a) => ((s.ctx = { obj: a.name }), (s.mode = 'obj'), '') },
    { p: 'no object network $word:name', run: (s, a) => ((cfgOf(s).fw.vip = cfgOf(s).fw.vip.filter((v) => v.name !== a.name)), changed(s)) },
    { p: 'static (inside,outside) $ip:ext $ip:int [netmask $mask:m]', run: (s, a) => {
      const fw = cfgOf(s).fw;
      fw.vip = fw.vip.filter((v) => v.ext !== a.ext);
      fw.vip.push({ name: `STATIC-${a.ext}`, ext: a.ext, int: a.int });
      changed(s);
    } },
    { p: 'no static (inside,outside) $ip:ext $ip:int [netmask $mask:m]', run: (s, a) => ((cfgOf(s).fw.vip = cfgOf(s).fw.vip.filter((v) => v.ext !== a.ext)), changed(s)) },
    { p: 'global (outside) $num:id interface', run: (s) => ((cfgOf(s).fw.snat = [{ from: 'inside', to: 'outside', on: true }]), changed(s)) },
    { p: 'no global (outside) $num:id interface', run: (s) => ((cfgOf(s).fw.snat = []), changed(s)) },
    { p: 'nat (inside) $num:id $ip:ip $mask:m', run: () => '' },
    { p: 'route $word:ifname $ip:net $mask:mask $ip:nh [$num(1-255):ad]', run: (s, a) => {
      const c = cfgOf(s);
      const pfx = `${a.net}/${maskLen(a.mask)}`;
      c.static = c.static.filter((r) => !(r.pfx === pfx && r.nh === a.nh));
      c.static.push({ pfx, nh: a.nh, ad: a.ad || 1 });
      changed(s);
    } },
    { p: 'no route $word:ifname $ip:net $mask:mask $ip:nh [$num:ad]', run: (s, a) => ((cfgOf(s).static = cfgOf(s).static.filter((r) => !(r.pfx === `${a.net}/${maskLen(a.mask)}` && r.nh === a.nh))), changed(s)) },
    { p: 'router ospf $num(1-65535):pid', run: (s, a) => {
      const c = cfgOf(s);
      if (!c.ospf.on) Object.assign(c.ospf, { on: true, pid: a.pid }), changed(s);
      s.mode = 'ospf';
    } },
    { p: 'no router ospf $num:pid', run: (s) => ((cfgOf(s).ospf.on = false), changed(s)) },
    { p: 'username $word:u password $word:pw [privilege $num(0-15):p]', run: (s, a) => {
      const u = cfgOf(s).svc.users.find((x) => x.name === a.u);
      if (u) u.pw = a.pw;
      else cfgOf(s).svc.users.push({ name: a.u, pw: a.pw, priv: a.p ?? 2 });
      changed(s);
    } },
    { p: 'enable password $word:pw', run: (s, a) => ((cfgOf(s).svc.enable = a.pw), changed(s)) },
    { p: 'logging host $word:ifname $ip:ip', run: (s, a) => (cfgOf(s).svc.syslog.includes(a.ip) ? '' : (cfgOf(s).svc.syslog.push(a.ip), changed(s))) },
    { p: 'ssh $ip:ip $mask:m $word:ifname', run: () => '' },
    { p: 'mtu $word:ifname $num(64-9198):mtu', run: (s, a) => {
      const n = ifByName(s.dev, a.ifname);
      if (n) cfgOf(s).ifs[n].mtu = a.mtu;
      changed(s);
    } },
  ];
  const ospf = [
    { p: 'network $ip:ip $mask:mask area $word:area', run: (s, a) => {
      const len = maskLen(a.mask);
      if (len < 0) return 'ERROR: OSPF: Invalid address/mask combination (discontiguous mask)';
      for (const i of Object.values(cfgOf(s).ifs)) if (i.ip && inNet(ipOnly(i.ip), `${a.ip}/${len}`)) {
        i.ospf = i.ospf || { area: null, cost: null, hello: 10, dead: 40, passive: false };
        i.ospf.area = /^\d+$/.test(a.area) ? n2ip(Number(a.area)) : a.area;
      }
      changed(s);
    } },
    { p: 'no network $ip:ip $mask:mask area $word:area', run: (s, a) => {
      for (const i of Object.values(cfgOf(s).ifs)) if (i.ip && i.ospf && inNet(ipOnly(i.ip), `${a.ip}/${maskLen(a.mask)}`)) i.ospf.area = null;
      changed(s);
    } },
    { p: 'router-id $ip:rid', run: (s, a) => ((cfgOf(s).ospf.rid = a.rid), changed(s)) },
    { p: '[no] passive-interface $word:ifname', run: (s, a) => {
      const n = ifByName(s.dev, a.ifname);
      if (!n) return `ERROR: interface ${a.ifname} not found`;
      const i = cfgOf(s).ifs[n];
      i.ospf = i.ospf || { area: null, cost: null, hello: 10, dead: 40, passive: false };
      i.ospf.passive = !a.has('no');
      changed(s);
    } },
    { p: 'log-adj-changes [detail]', run: () => '' },
    { p: '[no] default-information originate [always]', run: (s, a) => ((cfgOf(s).ospf.defOrig = !a.has('no')), changed(s)) },
  ];
  const showCmds = [
    { p: 'show version', run: (s) => [`Cisco Adaptive Security Appliance Software Version ${s.dev.version} `, `Device Manager Version 7.${hashStr(s.dev.version) % 20}(1)`, '', `Compiled on ${fmtDate(Math.max(0, s.dev.installed - 300000), 'long')} by builders`, `System image file is "disk0:/asa${String(s.dev.version).replace(/[().]/g, '')}-k8.bin"`, `Config file at boot was "startup-config"`, '', `${s.dev.cfg.hostname} up ${upCisco(uptimeMins(s.world, s.dev)).replace(/(\d+)d(\d+)h/, '$1 days $2 hours')}`, '', `Hardware:   ${s.dev.model.toUpperCase()}, 1024 MB RAM, CPU Pentium 4 Celeron 1600 MHz`, ...physIfs(s.dev).map((n, k) => ` ${k}: Ext: ${padR(n, 20)}: address is 0027.0d${(k + 16).toString(16)}.${(hashStr(s.dev.id) % 65535).toString(16).padStart(4, '0')}, irq 9`), '', 'Licensed features for this platform:', 'Maximum Physical Interfaces       : Unlimited      perpetual', 'Failover                          : Active/Active  perpetual', '', `Serial Number: ${s.dev.hw.serial}`, `Configuration last modified by ${s.dev.run.lastCfgBy || 'enable_15'} at ${fmtDate(s.dev.run.lastCfg, 'clock')}`] },
    { p: 'show interface ip brief', run: (s) => ['Interface                  IP-Address      OK? Method Status                Protocol', ...sortedIfs(s.dev, (i) => ['phys', 'mgmt', 'sub'].includes(i.kind)).map((n) => {
      const w = ifStatusWord(s, s.dev, n);
      return `${padR(n, 27)}${padR(ipOnly(s.dev.cfg.ifs[n].ip) || 'unassigned', 16)}YES ${padR(s.dev.cfg.ifs[n].ip ? 'CONFIG' : 'unset', 7)}${padR(w.st, 22)}${w.pr}`;
    })] },
    { p: 'show nameif', run: (s) => ['Interface                Name                     Security', ...sortedIfs(s.dev, (i) => !!i.nameif).map((n) => `${padR(n, 25)}${padR(s.dev.cfg.ifs[n].nameif, 25)}${padL(s.dev.cfg.ifs[n].seclvl ?? 0, 3)}`)] },
    { p: 'show interface [$if:if]', run: (s, a) => sortedIfs(s.dev, (i, n) => (a.if ? n === a.if : ['phys', 'mgmt'].includes(i.kind))).flatMap((n) => {
      const i = s.dev.cfg.ifs[n];
      const w = ifStatusWord(s, s.dev, n);
      const c = counters(s.world, s.dev, n);
      return [`Interface ${n} "${i.nameif || ''}", is ${w.st}, line protocol is ${w.pr}`, `  Hardware is i82546GB rev03, BW ${i.hw?.speed || 1000} Mbps, DLY 10 usec`, `\tAuto-Duplex(${i.duplex === 'auto' ? 'Full-duplex' : i.duplex}), Auto-Speed(${i.hw?.speed || 1000} Mbps)`, ...(i.desc ? [`\tDescription: ${i.desc}`] : []), `\tMAC address 0027.0d${String(hashStr(n) % 99).padStart(2, '0')}.${(hashStr(s.dev.id + n) % 65535).toString(16).padStart(4, '0')}, MTU ${i.mtu || 1500}`, `\tIP address ${ipOnly(i.ip) || 'unassigned'}, subnet mask ${i.ip ? maskStr(lenOf(i.ip)) : ''}`, `\t${c.inP} packets input, ${c.inB} bytes, 0 no buffer`, `\tReceived ${c.bcast} broadcasts, 0 runts, 0 giants`, `\t${c.inErr} input errors, ${c.crc} CRC, 0 frame, 0 overrun, 0 ignored, 0 abort`, `\t${c.outP} packets output, ${c.outB} bytes, 0 underruns`, `\t${c.outErr} output errors, ${c.coll} collisions, 0 interface resets`, ''];
    }) },
    { p: 'show route [$ip:ip]', run: (s) => asaRoute(s) },
    { p: 'show access-list [$word:name]', run: (s, a) => ['access-list cached ACL log flows: total 0, denied 0 (deny-flow-max 4096)', '            alert-interval 300', ...Object.entries(s.dev.cfg.acls).filter(([n]) => !a.name || n === a.name).flatMap(([n, e]) => [`access-list ${n}; ${e.length} elements; name hash: 0x${hashStr(n).toString(16)}`, ...e.map((x, k) => `access-list ${n} line ${k + 1} extended ${aceText(x)} (hitcnt=${hashStr(n + k + Math.floor(s.world.time.t / 60)) % 9000}) 0x${hashStr(n + k).toString(16)}`)])] },
    { p: 'show nat [detail]', run: (s) => {
      const fw = s.dev.cfg.fw;
      const out = [];
      let k = 0;
      if (legacyNat(s.dev)) return fw.vip.map((v) => `static (inside,outside) ${v.ext} ${v.int} netmask 255.255.255.255`);
      out.push('Auto NAT Policies (Section 2)');
      for (const v of fw.vip) out.push(`${++k} (inside) to (outside) source static ${v.name} ${v.ext}  `, `    translate_hits = ${hashStr(v.name) % 4000}, untranslate_hits = ${hashStr(v.ext) % 9000}`);
      if (fw.snat.some((x) => x.on)) out.push(`${++k} (inside) to (outside) source dynamic INSIDE-NETS interface  `, `    translate_hits = ${s.world.time.t % 99999}, untranslate_hits = ${Math.floor((s.world.time.t % 99999) / 3)}`);
      return out;
    } },
    { p: 'show xlate', run: (s) => {
      const fw = s.dev.cfg.fw;
      return [`${fw.vip.length + (fw.snat.some((x) => x.on) ? 3 : 0)} in use, 112 most used`, 'Flags: D - DNS, e - extended, I - identity, i - dynamic, r - portmap,', '       s - static, T - twice, N - net-to-net', ...fw.vip.map((v) => `NAT from inside:${v.int} to outside:${v.ext}\n    flags s idle 0:00:${String(hashStr(v.name) % 59).padStart(2, '0')} timeout 0:00:00`)];
    } },
    { p: 'show conn [count]', run: (s, a) => (a.has('count') ? `${12 + (s.world.time.t % 40)} in use, 2341 most used` : [`${12 + (s.world.time.t % 40)} in use, 2341 most used`]) },
    { p: 'show ospf neighbor', run: (s) => ['', 'Neighbor ID     Pri   State           Dead Time   Address         Interface', ...(S_(s.world).ospf[s.dev.id]?.nbrs || []).map((n) => `${padR(n.rid, 16)}${padL(1, 3)}   ${padR(`${n.state}/DR`, 16)}0:00:3${hashStr(n.rid) % 9}     ${padR(n.ip, 16)}${nameOf(s.dev, n.if)}`)] },
    { p: 'show running-config', run: (s) => running(s) },
    { p: 'show running-config {access-list|access-group|nat|route|object|interface|router}', run: (s, a) => {
      const key = a.kw[2];
      const all = running(s);
      if (key === 'interface') return all.filter((l, k) => /^interface|^ /.test(l) && all.slice(0, k + 1).reverse().find((x) => !x.startsWith(' ')).startsWith('interface'));
      if (key === 'object' || key === 'nat') return all.filter((l, k) => (l.startsWith('object') || l.startsWith(' host') || l.startsWith(' subnet') || l.startsWith(' nat') || l.startsWith('static') || l.startsWith('global')) && k > 0);
      return all.filter((l) => l.startsWith(key === 'router' ? 'router' : key));
    } },
    { p: 'show startup-config', run: (s) => (s.dev.startup ? running(s, s.dev.startup) : 'No Configuration') },
    { p: 'show capture [$word:name]', run: (s, a) => (a.name ? captureShow(s, a.name) : Object.entries(s.dev.run.captures || {}).map(([n, c]) => `capture ${n} type raw-data interface ${c.ifname}${c.host ? ` match ip any host ${c.host}` : ''} [Capturing - ${hashStr(n) % 9000} bytes]`)) },
    { p: 'show failover', run: () => ['Failover Off', 'Failover unit Primary', 'Failover LAN Interface: not Configured', 'Reconnect timeout 0:00:00'] },
    { p: 'show logging', run: (s) => ['Syslog logging: enabled', '    Facility: 20', '    Timestamp logging: enabled', `    Buffer logging: level informational, ${s.dev.run.logs.length} messages logged`, ...s.dev.cfg.svc.syslog.map((h) => `    Trap logging: level informational, facility 20, ${s.dev.run.logs.length} messages logged\n        Logging to inside ${h}`), ...s.dev.run.logs.map((e) => fmtEventASA(e, s.dev)).filter(Boolean)] },
    { p: 'show clock', run: (s) => fmtDate(s.world.time.t, 'clock') },
    { p: 'show environment', run: (s) => ['Cooling Fans:', ...s.dev.hw.fans.map((ok, k) => `  Chassis Fan ${k + 1}  : ${ok ? '7680 RPM - OK' : '0 RPM - FAILED'}`), 'Power Supplies:', ...s.dev.hw.psus.map((ok, k) => `  Power Supply ${k + 1} : ${ok ? 'OK' : 'Failure'}`), 'Temperature:', `  CPU             : ${Math.round(s.dev.hw.temp + 8)} C - ${s.dev.hw.temp > 55 ? 'Critical' : 'OK'}`] },
    { p: 'show arp', run: (s) => (S_(s.world).bySeg ? sortedIfs(s.dev, (i) => !!i.nameif && i.ip).flatMap((n) => {
      const ep = S_(s.world).eps.find((e) => e.dev === s.dev.id && e.if === n);
      return (S_(s.world).bySeg.get(ep?.seg) || []).filter((o) => o !== ep && o.dev !== s.dev.id).map((o) => `\t${s.dev.cfg.ifs[n].nameif} ${o.ip} 0050.56${String(hashStr(o.ip) % 99).padStart(2, '0')}.${(hashStr(o.ip) % 65535).toString(16).padStart(4, '0')} ${hashStr(o.ip) % 300}`);
    }) : []) },
  ];
  const exec = [
    ...showCmds,
    { p: 'configure terminal', run: (s) => ((s.mode = 'config'), '') },
    { p: 'write memory', run: (s) => (saveStartup(s.dev, s.world.time.t), logEvent(s.world, s.dev.id, { type: 'save', by: s.user }), stream([{ d: 10, t: 'Building configuration...\n' }, { d: 600, t: `Cryptochecksum: ${hashStr(JSON.stringify(s.dev.cfg)).toString(16)} ${hashStr(s.dev.id).toString(16)} 7d6c5b4a ${hashStr(String(s.world.time.t)).toString(16)} \n\n${JSON.stringify(s.dev.cfg).length} bytes copied in 0.330 secs\n[OK]\n` }])) },
    { p: 'copy running-config startup-config', run: (s) => ask('Source filename [running-config]? ', () => (saveStartup(s.dev, s.world.time.t), stream([{ d: 600, t: `Cryptochecksum: ${hashStr(JSON.stringify(s.dev.cfg)).toString(16)}\n\n${JSON.stringify(s.dev.cfg).length} bytes copied in 0.330 secs\n` }]))) },
    { p: 'reload', run: (s) => doReload(s) },
    { p: 'ping [$word:ifname] $host:target [repeat $num:repeat] [size $num:size]', run: asaPing },
    { p: 'traceroute $host:target', run: (s, a) => {
      const { hops } = trace(s, a.target);
      return stream([{ d: 10, t: `\nType escape sequence to abort.\nTracing the route to ${a.target}\n\n` }, ...hops.map((h, k) => ({ d: 400, t: h.ok ? ` ${k + 1} ${h.ip} 0 msec 0 msec 0 msec\n` : ` ${k + 1}  *  *  * \n` }))]);
    } },
    { p: 'packet-tracer input $word:ifname {tcp|udp} $ip:src $num(0-65535):sport $ip:dst $num(0-65535):dport [detailed]', run: (s, a) => packetTracer(s, { ...a, proto: a.has('tcp') ? 'tcp' : 'udp' }) },
    { p: 'packet-tracer input $word:ifname icmp $ip:src $num:type $num:code $ip:dst [detailed]', run: (s, a) => packetTracer(s, { ...a, proto: 'icmp' }) },
    { p: 'clear capture $word:name', run: () => '' },
    { p: 'capture $word:name interface $word:ifname [match $line:m]', run: (s, a) => {
      s.dev.run.captures = s.dev.run.captures || {};
      const host = a.m?.match(/host (\d+\.\d+\.\d+\.\d+)/)?.[1] || null;
      s.dev.run.captures[a.name] = { ifname: a.ifname, host, t: s.world.time.t };
      return '';
    } },
    { p: 'no capture $word:name', run: (s, a) => (delete s.dev.run.captures?.[a.name], '') },
    { p: 'clear xlate', run: () => '' },
    { p: 'terminal pager $num(0-2147483647):n', run: (s, a) => ((s.termLen = a.n), '') },
    { p: 'disable', run: (s) => ((s.mode = 'user'), '') },
    { p: '{exit|quit|logout}', run: (s) => ((s.closed = true), 'Logoff\n') },
  ];
  const user = [
    ...showCmds.filter((c) => /version|interface ip|clock/.test(c.p)),
    { p: 'enable', run: (s) => {
      let tries = 0;
      const chk = (pw) => {
        if (pw === (s.dev.cfg.svc.enable || '') || s.via === 'console') {
          s.mode = 'exec';
          return '';
        }
        tries++;
        return tries >= 3 ? 'Invalid password\n' : { ...ask('Password: ', chk, { hidden: true }), pre: 'Invalid password\n' };
      };
      return ask('Password: ', chk, { hidden: true });
    } },
    { p: '{exit|quit|logout}', run: (s) => ((s.closed = true), 'Logoff\n') },
    { p: 'ping [$word:ifname] $host:target', run: asaPing },
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
    { p: 'do $line:cmd', run: () => "ERROR: % Invalid input detected at '^' marker." },
  ];
  const tries = {
    user: compile(user, KW),
    exec: compile(exec, KW),
    config: compile([...g, ...exec.filter((c) => /^show|^write|^copy|^ping|^packet-tracer|^clear/.test(c.p)), ...common], KW),
    if: compile([...ifc, ...common], KW),
    obj: compile([...objNet, ...common], KW),
    ospf: compile([...ospf, ...common], KW),
  };
  const P = { config: 'config', if: 'config-if', obj: 'config-network-object', ospf: 'config-router' };
  return {
    id: 'asa',
    startMode: 'user',
    pipes: ['include', 'exclude', 'begin', 'grep'],
    defaultLen: 24,
    more: '<--- More --->',
    prompt: (s) => (s.dev.state !== 'up' ? '' : s.mode === 'user' ? `${s.dev.cfg.hostname}> ` : s.mode === 'exec' ? `${s.dev.cfg.hostname}# ` : `${s.dev.cfg.hostname}(${P[s.mode]})# `),
    greeting: (s) => `Type help or '?' for a list of available commands.\n`,
    loginPrompt: () => 'Username: ',
    closeMsg: (s) => (s.via === 'console' ? '\n[Disconnected from console server]\n' : `Connection to ${s.world.design.mgmt[s.dev.id]} closed.\n`),
    preprocess: (s) => (s.dev.state !== 'up' ? '' : undefined),
    trie: (s, m) => tries[m] || tries.exec,
    fallback: (s) => (['if', 'obj', 'ospf'].includes(s.mode) ? ['config'] : []),
    matchIf(s, toks, i) {
      const v = toks[i].v;
      let r = resolveIf(s.dev, v);
      if (r) return { val: r, n: 1 };
      if (/^[A-Za-z-]+$/.test(v) && toks[i + 1] && /^\d/.test(toks[i + 1].v)) {
        r = resolveIf(s.dev, v + toks[i + 1].v);
        if (r) return { val: r, n: 2 };
      }
      return null;
    },
    ifTypeHelp: (s) => [...new Set(Object.keys(s.dev.cfg.ifs).map((n) => n.replace(/[\d/.]+$/, '')))].map((t) => [t, `${t} interface`]),
    ifNames: (s) => Object.keys(s.dev.cfg.ifs),
    helpFmt(s, items, cr) {
      const w = Math.max(...items.map(([k]) => k.length), 4) + 2;
      return [...items.map(([k, h]) => `  ${padR(k, w)}${h}`), ...(cr ? ['  <cr>'] : [])].join('\n');
    },
    error(s, kind, x) {
      if (kind === 'incomplete') return 'ERROR: % Incomplete command';
      if (kind === 'ambiguous') return `ERROR: % Ambiguous command:  "${x.line}"`;
      return `${' '.repeat(s.prompt.length + x.pos)}^\nERROR: % Invalid input detected at '^' marker.`;
    },
    ctrlC: (s) => ((['config', 'if', 'obj', 'ospf'].includes(s.mode) ? ((s.mode = 'exec'), configEnded(s)) : 0), '^C\n'),
    ctrlZ: (s) => ((s.mode = 'exec'), configEnded(s), ''),
    fmtEvent: fmtEventASA,
  };
}
void ip2n;
void yearOf;
