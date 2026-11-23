// Cisco IOS XR (ASR 9000, NCS 540, 8000). Two-stage configuration: changes go to a target
// configuration and only take effect on "commit"; "rollback configuration last N" undoes commits.
// eBGP needs route-policies (no policy = no routes accepted or advertised).
import { compile, ask, stream } from './engine.js';
import { model, resolveIf, splitIf } from '../net/catalog.js';
import { newIf, ensureLag } from '../net/model.js';
import { S_, cfgOf, ping, trace, counters, sortedIfs, physIfs, uptimeMins, ipOnly, lenOf, commitApply, neighbours, arpTable, macOfIf, optics } from './common.js';
import { reload } from '../net/devops.js';
import { cidr, n2ip, maskStr, maskLen, isIp, fmtDate, upCisco, padR, padL, hashStr, yearOf, deep, macCisco, ip2n } from '../core/util.js';

const stamp = (s) => {
  const d = fmtDate(s.world.time.t, 'clock');
  const [time, , day, mon, dd, yy] = d.split(' ');
  return `${day} ${mon} ${String(dd).padStart(2, ' ')} ${time} UTC${yy ? '' : ''}`;
};
const ts = (s, lines) => [stamp(s), ...(Array.isArray(lines) ? lines : String(lines).split('\n'))];
const sel = (s) => cfgOf(s).ifs[s.ctx.if];
const nb = (s) => cfgOf(s).bgp.nbrs.find((x) => x.ip === s.ctx.nbr);
const dirty = (s) => {
  s.candDirty = true;
  return '';
};

function running(s, cfg = s.dev.cfg) {
  const dev = s.dev;
  const L = ['Building configuration...', `!! IOS XR Configuration ${dev.version}`, `!! Last configuration change at ${fmtDate(dev.run.lastCfg, 'long')} by ${dev.run.lastCfgBy || 'admin'}`, '!', `hostname ${cfg.hostname}`];
  for (const h of cfg.svc.syslog) L.push(`logging ${h} vrf default severity info`);
  for (const u of cfg.svc.users) L.push(`username ${u.name}`, ' group root-lr', ' group cisco-support', ` secret 10 $6$${hashStr(u.pw).toString(36)}$${hashStr(u.pw + 'r').toString(36)}`, '!');
  if (cfg.svc.domain) L.push(`domain name ${cfg.svc.domain}`);
  for (const n of sortedIfs(dev, () => true)) {
    const i = cfg.ifs[n];
    L.push(`interface ${n}`);
    if (i.desc) L.push(` description ${i.desc}`);
    if (i.ip) L.push(` ipv4 address ${ipOnly(i.ip)} ${maskStr(lenOf(i.ip))}`);
    if (i.mtu && i.mtu !== 1500) L.push(` mtu ${i.mtu + 14}`);
    if (i.lag) L.push(` bundle id ${i.lag.id} mode ${i.lag.mode}`);
    if (i.vrf) L.push(` vrf ${i.vrf}`);
    if (!i.on) L.push(' shutdown');
    L.push('!');
  }
  for (const [name, body] of Object.entries(cfg.rpl || {})) L.push(`route-policy ${name}`, ...body.split('\n').map((l) => `  ${l}`), 'end-policy', '!');
  if (cfg.static.length) {
    L.push('router static', ' address-family ipv4 unicast');
    for (const r of cfg.static) L.push(`  ${r.pfx} ${r.iface === 'Null0' ? 'Null0' : r.nh}${r.ad && r.ad !== 1 ? ` ${r.ad}` : ''}`);
    L.push(' !', '!');
  }
  if (cfg.ospf.on) {
    L.push(`router ospf ${cfg.ospf.pid}`);
    if (cfg.ospf.rid) L.push(` router-id ${cfg.ospf.rid}`);
    if (cfg.ospf.defOrig) L.push(` default-information originate${cfg.ospf.always ? ' always' : ''}`);
    const areas = [...new Set(Object.values(cfg.ifs).filter((i) => i.ospf?.area != null).map((i) => i.ospf.area))];
    for (const a of areas) {
      L.push(` area ${a === '0.0.0.0' ? 0 : a}`);
      for (const [n, i] of Object.entries(cfg.ifs)) {
        if (i.ospf?.area !== a) continue;
        L.push(`  interface ${n}`);
        if (i.ospf.passive) L.push('   passive enable');
        if (i.ospf.cost) L.push(`   cost ${i.ospf.cost}`);
        if (i.ospf.hello !== 10) L.push(`   hello-interval ${i.ospf.hello}`);
        if (i.ospf.dead !== 40) L.push(`   dead-interval ${i.ospf.dead}`);
        L.push('  !');
      }
      L.push(' !');
    }
    L.push('!');
  }
  if (cfg.bgp.on) {
    L.push(`router bgp ${cfg.bgp.asn}`);
    if (cfg.bgp.rid) L.push(` bgp router-id ${cfg.bgp.rid}`);
    L.push(' address-family ipv4 unicast', ...cfg.bgp.nets.map((n) => `  network ${n}`), ' !');
    for (const n of cfg.bgp.nbrs) {
      L.push(` neighbor ${n.ip}`, `  remote-as ${n.ras}`);
      if (n.desc) L.push(`  description ${n.desc}`);
      if (n.shut) L.push('  shutdown');
      L.push('  address-family ipv4 unicast');
      if (n.rplIn) L.push(`   route-policy ${n.rplIn} in`);
      if (n.rplOut) L.push(`   route-policy ${n.rplOut} out`);
      if (n.maxpfx) L.push(`   maximum-prefix ${n.maxpfx} 75`);
      L.push('  !', ' !');
    }
    L.push('!');
  }
  if (cfg.svc.ssh) L.push('ssh server v2', 'ssh server vrf default');
  L.push('end');
  return L;
}
function diffCfg(s) {
  const a = running(s, s.dev.cfg).slice(3);
  const b = running(s, s.cand).slice(3);
  const sa = new Set(a);
  const sb = new Set(b);
  const out = ['Building configuration...', `!! IOS XR Configuration ${s.dev.version}`];
  for (const l of b) if (!sa.has(l) && l !== '!' && !/^ ?!$/.test(l)) out.push(l);
  for (const l of a) if (!sb.has(l) && l.trim() && !/^ *!$/.test(l)) out.push(`no ${l.trim()}`);
  out.push('end');
  return out;
}

function ifBrief(s) {
  const dev = s.dev;
  const S = S_(s.world);
  return ['', 'Interface                      IP-Address      Status          Protocol Vrf-Name', ...sortedIfs(dev, () => true).map((n) => {
    const i = dev.cfg.ifs[n];
    const st = S.ifs[dev.id][n] || {};
    const status = !i.on ? 'Shutdown' : st.up || i.kind === 'lo' ? 'Up' : 'Down';
    return `${padR(n, 31)}${padR(ipOnly(i.ip) || 'unassigned', 16)}${padR(status, 16)}${padR(st.proto || (i.kind === 'lo' && i.on) ? 'Up' : 'Down', 9)}${i.vrf || 'default'}`;
  })];
}
function xrRoute(s, ipArg) {
  const dev = s.dev;
  const rib = (S_(s.world).rib[dev.id]?.best || []).filter((r) => !r.vrf);
  const age = upCisco(Math.max(0, s.world.time.t - dev.run.boot) % 60000);
  const code = (r) => ({ connected: 'C', local: 'L', static: 'S', ospf: 'O', ospfE: 'O E2', ebgp: 'B' })[r.proto] + (r.pfx === '0.0.0.0/0' ? '*' : '');
  let list = rib;
  if (ipArg) {
    const hits = rib.filter((r) => ((ip2n(ipArg.split('/')[0]) & cidr(r.pfx).mask) >>> 0) === cidr(r.pfx).net).sort((a, b) => Number(b.pfx.split('/')[1]) - Number(a.pfx.split('/')[1]));
    if (!hits.length) return ['', '% Network not in table'];
    const r = hits[0];
    return ['', `Routing entry for ${r.pfx}`, `  Known via "${r.proto === 'ebgp' ? `bgp ${dev.cfg.bgp.asn}` : r.proto.startsWith('ospf') ? `ospf ${dev.cfg.ospf.pid}` : r.proto}", distance ${r.ad}, metric ${r.metric}${r.pfx === '0.0.0.0/0' ? ', candidate default path' : ''}`, `  Installed ${fmtDate(dev.run.boot, 'long')} for ${age}`, '  Routing Descriptor Blocks', `    ${r.nh || 'directly connected'}, from ${r.nh || '0.0.0.0'}${r.oif ? `, via ${r.oif}` : ''}`, `      Route metric is ${r.metric}`];
  }
  const def = rib.find((r) => r.pfx === '0.0.0.0/0');
  return ['', 'Codes: C - connected, S - static, R - RIP, B - BGP, (>) - Diversion path', '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area', '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2', '       E1 - OSPF external type 1, E2 - OSPF external type 2, E - EGP', '       i - ISIS, L1 - IS-IS level-1, L2 - IS-IS level-2', '       ia - IS-IS inter area, su - IS-IS summary null, * - candidate default', '       U - per-user static route, o - ODR, L - local, G  - DAGR, l - LISP', '       A - access/subscriber, a - Application route', '       M - mobile route, r - RPL, t - Traffic Engineering, (!) - FRR Backup path', '', def ? `Gateway of last resort is ${def.nh} to network 0.0.0.0` : 'Gateway of last resort is not set', '', ...list.map((r) => (['connected', 'local'].includes(r.proto) ? `${padR(code(r), 5)}${r.pfx} is directly connected, ${age}, ${r.oif}` : r.discard ? `${padR(code(r), 5)}${r.pfx} is directly connected, ${age}, Null0` : `${padR(code(r), 5)}${r.pfx} [${r.ad}/${r.metric}] via ${r.nh}, ${age}${r.proto.startsWith('ospf') ? `, ${r.oif}` : ''}`))];
}
function bgpSum(s) {
  const dev = s.dev;
  if (!dev.cfg.bgp.on) return ['', '% BGP instance \'default\' not active'];
  const recs = S_(s.world).bgp[dev.id] || [];
  return ['', `BGP router identifier ${dev.cfg.bgp.rid || '0.0.0.0'}, local AS number ${dev.cfg.bgp.asn}`, 'BGP generic scan interval 60 secs', 'Non-stop routing is enabled', 'BGP table state: Active', 'Table ID: 0xe0000000   RD version: 5', 'BGP main routing table version 5', 'BGP NSR Initial initsync version 2 (Reached)', 'BGP NSR/ISSU Sync-Group versions 0/0', 'BGP scan interval 60 secs', '', 'BGP is operating in STANDALONE mode.', '', '', 'Process       RcvTblVer   bRIB/RIB   LabelVer  ImportVer  SendTblVer  StandbyVer', 'Speaker               5          5          5          5           5           0', '', 'Neighbor        Spk    AS MsgRcvd MsgSent   TblVer  InQ OutQ  Up/Down  St/PfxRcd', ...recs.map((r) => `${padR(r.ip, 16)}  0 ${padL(r.ras, 5)} ${padL(r.up ? 1234 : 0, 7)} ${padL(r.up ? 1240 : 0, 7)} ${padL(5, 8)}    0    0 ${padR(r.up ? '1d02h' : '00:00:00', 9)}${r.up ? (r.noPolicy ? '(NoPolicy)' : padL(r.pfx, 11)) : r.state.replace(' (Admin)', '').replace(' (PfxCt)', '')}`)];
}
function bgpNbrShow(s, ip) {
  const dev = s.dev;
  return (S_(s.world).bgp[dev.id] || []).filter((r) => !ip || r.ip === ip).flatMap((r) => {
    const c = dev.cfg.bgp.nbrs.find((x) => x.ip === r.ip) || {};
    return ['', `BGP neighbor is ${r.ip}`, ` Remote AS ${r.ras}, local AS ${dev.cfg.bgp.asn}, external link`, ` Description: ${c.desc || ''}`, ` Remote router ID ${r.up ? r.ip : '0.0.0.0'}`, `  BGP state = ${r.up ? `Established, up for ${upCisco(600)}` : r.state}`, ...(r.reason ? [`  Last reset 00:01:12, due to ${r.notify || r.reason}`] : []), ' For Address Family: IPv4 Unicast', `  Policy for incoming advertisements is ${c.rplIn || 'not set'}`, `  Policy for outgoing advertisements is ${c.rplOut || 'not set'}`, `  ${r.up ? r.pfx : 0} accepted prefixes, ${r.accepted ?? 0} are bestpaths`, `  Prefix advertised ${r.adv?.length || 0}, suppressed 0, withdrawn 0`, ...(c.maxpfx ? [`  Maximum prefixes allowed ${c.maxpfx}`, '  Threshold for warning message 75%, restart interval 0 min'] : []), ...(r.noPolicy ? ['  No inbound policy so routes will not be accepted', '  An EoR was not received during read-only mode'] : []), ...(r.up && !c.rplOut ? ['  No outbound policy so routes will not be advertised'] : [])];
  });
}
export function fmtEventXR(e, dev) {
  const t = `RP/0/RSP0/CPU0:${fmtDate(e.t, 'cisco')} UTC: `;
  switch (e.type) {
    case 'link':
      if (e.kind === 'lo' || e.kind === 'svi') return null;
      return e.admin ? `${t}ifmgr[${200 + (hashStr(dev.id) % 50)}]: %PKT_INFRA-LINK-5-CHANGED : Interface ${e.if}, changed state to Administratively Down` : `${t}ifmgr[${200 + (hashStr(dev.id) % 50)}]: %PKT_INFRA-LINK-3-UPDOWN : Interface ${e.if}, changed state to ${e.up ? 'Up' : 'Down'}`;
    case 'proto':
      return `${t}ifmgr[${200 + (hashStr(dev.id) % 50)}]: %PKT_INFRA-LINEPROTO-5-UPDOWN : Line protocol on Interface ${e.if}, changed state to ${e.up ? 'Up' : 'Down'}`;
    case 'ospf':
      return `${t}ospf[${1000 + (hashStr(dev.id) % 50)}]: %ROUTING-OSPF-5-ADJCHG : Process ${dev.cfg.ospf.pid}, Nbr ${e.nbr} on ${e.if} in area 0 from ${e.from} to ${e.to}, ${e.to === 'FULL' ? 'Loading Done' : e.why || 'Neighbor Down: dead timer expired'}`;
    case 'bgp':
      return e.up ? `${t}bgp[${1050 + (hashStr(dev.id) % 50)}]: %ROUTING-BGP-5-ADJCHANGE : neighbor ${e.nbr} Up (VRF: default) (AS: ${e.ras})` : `${t}bgp[${1050 + (hashStr(dev.id) % 50)}]: %ROUTING-BGP-5-ADJCHANGE : neighbor ${e.nbr} Down - ${e.why || 'BGP Notification received, hold time expired'} (VRF: default) (AS: ${e.ras})`;
    case 'commit':
    case 'config':
      return `${t}config[${65700 + (hashStr(String(e.t)) % 99)}]: %MGBL-CONFIG-6-DB_COMMIT : Configuration committed by user '${e.by}'. Use 'show configuration commit changes ${1000000000 + (hashStr(String(e.t)) % 999)}' to view the changes.`;
    case 'login':
      return `${t}exec[${65600 + (hashStr(String(e.t)) % 99)}]: %SECURITY-LOGIN-6-AUTHEN_SUCCESS : Successfully authenticated user '${e.user}' from '${e.from}' on 'vty0'`;
    case 'authfail':
      return `${t}exec[${65600 + (hashStr(String(e.t)) % 99)}]: %SECURITY-LOGIN-4-AUTHEN_FAILED : Failed authentication attempt by user '${e.user}' from '${e.from}' on 'vty0'`;
    case 'psu':
      return `${t}envmon[${170 + (hashStr(dev.id) % 9)}]: %PLATFORM-ENVMON-2-PWR_SUPPLY_FAIL : Power supply ${e.n} ${e.ok ? 'OK' : 'failure detected'}`;
    case 'fan':
      return `${t}envmon[${170 + (hashStr(dev.id) % 9)}]: %PLATFORM-ENVMON-2-FAN_FAIL : Fan tray ${e.n} ${e.ok ? 'OK' : 'failure'}`;
    case 'boot':
      return `${t}init[65540]: %OS-INIT-7-MBI_STARTED : total time 6.132 seconds\n${t}shelfmgr[${190}]: %PLATFORM-SHELFMGR-6-NODE_STATE_CHANGE : 0/RSP0/CPU0 changed state to IOS XR RUN`;
    default:
      return null;
  }
}

export function makeIOSXR() {
  const KW = { show: 'Show running system information', configure: 'Enter configuration mode', commit: 'Commit the target configuration to the active (running) configuration', abort: 'Discard the configuration and exit to exec mode', rollback: 'Roll back configuration changes', ping: 'Send echo messages', traceroute: 'Trace route to destination', interface: 'Select an interface to configure', router: 'Enable a routing process', 'route-policy': 'Define a route policy', ipv4: 'IPv4 address and configuration', address: 'IPv4 address', shutdown: 'shutdown the given interface', neighbor: 'Specify a neighbor router', 'remote-as': 'Set remote AS', 'address-family': 'Enter Address Family command mode', area: 'Enter the OSPF area configuration submode', passive: 'Enable/Disable passive', bgp: 'BGP information', route: 'IP routing table', ospf: 'OSPF information' };
  const exec = [
    { p: 'show version', run: (s) => ts(s, ['', `Cisco IOS XR Software, Version ${s.dev.version}`, `Copyright (c) 2013-${yearOf(s.world.time.t)} by Cisco Systems, Inc.`, '', 'Build Information:', ` Built By     : ingunawa`, ` Built On     : ${fmtDate(Math.max(0, s.dev.installed - 90000), 'long')}`, ` Version      : ${s.dev.version}`, ` Location     : /opt/cisco/XR/packages/`, '', `cisco ${model(s.dev.model).name.replace(/^Cisco /, '')} () processor`, `System uptime is ${upCisco(uptimeMins(s.world, s.dev)).replace(/(\d+)w(\d+)d/, '$1 weeks $2 days').replace(/(\d+)d(\d+)h/, '$1 days $2 hours')}`]) },
    { p: 'show ipv4 interface brief', run: (s) => ts(s, ifBrief(s)) },
    { p: 'show interfaces brief', run: (s) => ts(s, ['', '               Intf       Intf        LineP              Encap  MTU        BW', '               Name       State       State               Type (byte)    (Kbps)', '--------------------------------------------------------------------------------', ...sortedIfs(s.dev, () => true).map((n) => {
      const i = s.dev.cfg.ifs[n];
      const st = S_(s.world).ifs[s.dev.id][n] || {};
      return `${padL(n.replace('TenGigE', 'Te').replace('HundredGigE', 'Hu').replace('GigabitEthernet', 'Gi').replace('Bundle-Ether', 'BE').replace('Loopback', 'Lo').replace('MgmtEth', 'Mg'), 19)}${padL(!i.on ? 'admin-down' : st.up || i.kind === 'lo' ? 'up' : 'down', 12)}${padL(!i.on ? 'admin-down' : st.proto || i.kind === 'lo' ? 'up' : 'down', 12)}${padL(i.kind === 'lo' ? 'Loopback' : 'ARPA', 19)}  ${padL((i.mtu || 1500) + 14, 5)}  ${padL((i.hw?.speed || 1000) * 1000, 9)}`;
    })]) },
    { p: 'show interfaces $if:if', run: (s, a) => {
      const i = s.dev.cfg.ifs[a.if];
      const st = S_(s.world).ifs[s.dev.id][a.if] || {};
      const c = counters(s.world, s.dev, a.if);
      return ts(s, [`${a.if} is ${!i.on ? 'administratively down' : st.up ? 'up' : 'down'}, line protocol is ${!i.on ? 'administratively down' : st.proto ? 'up' : 'down'}`, `  Interface state transitions: ${c.resets + 1}`, `  Hardware is ${(i.hw?.speed || 1000) >= 100000 ? 'HundredGigE' : 'TenGigE'}, address is ${macCisco(macOfIf(s.dev, a.if))} (bia ${macCisco(macOfIf(s.dev, a.if))})`, ...(i.desc ? [`  Description: ${i.desc}`] : []), ...(i.ip ? [`  Internet address is ${i.ip}`] : ['  Internet address is Unknown']), `  MTU ${(i.mtu || 1500) + 14} bytes, BW ${(i.hw?.speed || 1000) * 1000} Kbit (Max: ${(i.hw?.speed || 1000) * 1000} Kbit)`, '     reliability 255/255, txload 0/255, rxload 0/255', '  Encapsulation ARPA,', `  Full-duplex, ${(i.hw?.speed || 1000) / 1000}Gb/s, link type is force-up`, `  output flow control is off, input flow control is off`, `  Last link flapped ${upCisco(Math.max(1, s.world.time.t - s.dev.run.boot) % 9000)}`, `  Last input 00:00:00, output 00:00:00`, '  Last clearing of "show interface" counters never', `  5 minute input rate ${c.rateIn} bits/sec, ${c.ppsIn} packets/sec`, `  5 minute output rate ${c.rateOut} bits/sec, ${c.ppsOut} packets/sec`, `     ${c.inP} packets input, ${c.inB} bytes, 0 total input drops`, `     Received ${c.bcast} broadcast packets, ${c.inMc} multicast packets`, `     ${c.runts} runts, 0 giants, 0 throttles, 0 parity`, `     ${c.inErr} input errors, ${c.crc} CRC, 0 frame, 0 overrun, 0 ignored, 0 abort`, `     ${c.outP} packets output, ${c.outB} bytes, 0 total output drops`, `     ${c.outErr} output errors, 0 underruns, 0 applique, 0 resets`, `     ${c.resets} carrier transitions`]);
    } },
    { p: 'show controllers $if:if phy', run: (s, a) => {
      const o = optics(s.dev, a.if);
      return ts(s, o ? ['', `Port: ${a.if}`, `  Xcvr Type: Optical (${o.type})`, `  Temperature: ${o.temp} C`, `  Tx Power: ${o.tx.toFixed(2)} dBm`, `  Rx Power: ${o.rx.toFixed(2)} dBm${o.rx < -14 ? '  (Alarm: Rx LOS)' : o.rx < -10.5 ? '  (Warning: Rx power low)' : ''}`] : ['', 'No transceiver present']);
    } },
    { p: 'show route [ipv4] [unicast] [$ipp:ip]', run: (s, a) => ts(s, xrRoute(s, a.ip)) },
    { p: 'show bgp [ipv4 unicast] summary', run: (s) => ts(s, bgpSum(s)) },
    { p: 'show bgp [ipv4 unicast] neighbors [$ip:ip]', run: (s, a) => ts(s, bgpNbrShow(s, a.ip)) },
    { p: 'show bgp [ipv4 unicast]', run: (s) => ts(s, ['', `BGP router identifier ${s.dev.cfg.bgp.rid}, local AS number ${s.dev.cfg.bgp.asn}`, 'Status codes: s suppressed, d damped, h history, * valid, > best', '              i - internal, r RIB-failure, S stale, N Nexthop-discard', 'Origin codes: i - IGP, e - EGP, ? - incomplete', '   Network            Next Hop            Metric LocPrf Weight Path', ...(S_(s.world).bgp[s.dev.id] || []).filter((r) => r.up && !r.noPolicy).map((r) => `*> 0.0.0.0/0          ${padR(r.ip, 20)}     0             0 ${r.ras} i`), ...s.dev.cfg.bgp.nets.map((n) => `*> ${padR(n, 19)}0.0.0.0                  0         32768 i`)]) },
    { p: 'show bundle [$if:if]', run: (s, a) => ts(s, sortedIfs(s.dev, (i, n) => i.kind === 'lag' && (!a.if || n === a.if)).flatMap((n) => {
      const L = S_(s.world).lags[s.dev.id]?.[n];
      const mem = Object.entries(L?.members || {});
      return ['', n, `  Status:                                    ${L?.up ? 'Up' : 'Down'}`, `  Local links <active/standby/configured>:   ${mem.filter(([, x]) => x === 'P').length} / 0 / ${mem.length}`, `  Local bandwidth <effective/available>:     ${mem.filter(([, x]) => x === 'P').length * 10000000} (${mem.filter(([, x]) => x === 'P').length * 10000000}) kbps`, '  LACP:                                      Operational', '', '  Port                  Device           State        Port ID         B/W, kbps', '  --------------------  ---------------  -----------  --------------  ----------', ...mem.map(([m, x], k) => `  ${m.replace('TenGigE', 'Te').padEnd(22)}Local            ${(x === 'P' ? 'Active' : 'Configured').padEnd(13)}0x8000, 0x000${k + 1}    10000000${x === 'P' ? '' : '\n      Partner is not Synchronized and Collecting'}`)];
    })) },
    { p: 'show ospf neighbor', run: (s) => ts(s, ['', '* Indicates MADJ interface', '# Indicates Neighbor awaiting BFD session up', '', `Neighbors for OSPF ${s.dev.cfg.ospf.pid}`, '', 'Neighbor ID     Pri   State           Dead Time   Address         Interface', ...(S_(s.world).ospf[s.dev.id]?.nbrs || []).map((n) => `${padR(n.rid, 16)}${padR(1, 6)}${padR(`${n.state}/  -`, 16)}00:00:3${hashStr(n.rid) % 9}    ${padR(n.ip, 16)}${n.if}`), `    Neighbor is up for ${upCisco(600)}`, '', `Total neighbor count: ${(S_(s.world).ospf[s.dev.id]?.nbrs || []).length}`]) },
    { p: 'show ospf interface brief', run: (s) => ts(s, ['', '* Indicates MADJ interface, (P) Indicates fast detect hold down state', '', 'Interfaces for OSPF ' + s.dev.cfg.ospf.pid, '', 'Interface          PID   Area            IP Address/Mask    Cost  State Nbrs F/C', ...sortedIfs(s.dev, (i) => i.ospf?.area != null).map((n) => {
      const i = s.dev.cfg.ifs[n];
      const nbs = (S_(s.world).ospf[s.dev.id]?.nbrs || []).filter((x) => x.if === n);
      return `${padR(n.replace('TenGigE', 'Te').replace('Loopback', 'Lo'), 19)}${padR(s.dev.cfg.ospf.pid, 6)}${padR(i.ospf.area === '0.0.0.0' ? 0 : i.ospf.area, 16)}${padR(i.ip, 19)}${padR(i.ospf.cost || 1, 6)}${padR(i.kind === 'lo' ? 'LOOP' : S_(s.world).ifs[s.dev.id][n]?.proto ? 'DR' : 'DOWN', 6)}${nbs.filter((x) => x.state === 'FULL').length}/${nbs.length}`;
    })]) },
    { p: 'show running-config [{router|interface|route-policy} [$line:x]]', run: (s, a) => {
      const all = running(s);
      if (!a.kw.find((k) => ['router', 'interface', 'route-policy'].includes(k))) return all;
      const key = `${a.kw[2]}${a.x ? ` ${a.x}` : ''}`;
      const out = [];
      let on = false;
      for (const l of all) {
        if (!/^[ !]/.test(l)) on = l.startsWith(key);
        if (on) out.push(l);
      }
      return ts(s, out.length ? out : ['% No such configuration item(s)']);
    } },
    { p: 'show configuration commit list', run: (s) => ts(s, ['', 'SNo. Label/ID              User      Line                Client      Time Stamp', '~~~~ ~~~~~~~~              ~~~~      ~~~~                ~~~~~~      ~~~~~~~~~~', ...s.dev.run.rollback.map((r, k) => `${padR(k + 1, 5)}${padR(1000000000 + (hashStr(String(r.t) + k) % 999), 22)}${padR(r.by || 'admin', 10)}${padR('vty0:node0_RSP0_CPU0', 20)}${padR('CLI', 12)}${fmtDate(r.t, 'long')}`)]) },
    { p: 'show rpl route-policy $word:n', run: (s, a) => (s.dev.cfg.rpl?.[a.n] ? ts(s, ['', `route-policy ${a.n}`, ...s.dev.cfg.rpl[a.n].split('\n').map((l) => `  ${l}`), 'end-policy', '!']) : ts(s, ['% Policy object route-policy ' + a.n + ' not found'])) },
    { p: 'show logging', run: (s) => ts(s, ['Syslog logging: enabled (0 messages dropped, 0 flushes, 0 overruns)', `    Buffer logging: level debugging, ${s.dev.run.logs.length} messages logged`, '', 'Log Buffer (2097152 bytes):', '', ...s.dev.run.logs.map((e) => fmtEventXR(e, s.dev)).filter(Boolean)]) },
    { p: 'show lldp neighbors', run: (s) => ts(s, ['Capability codes:', '        (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device', '        (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other', '', 'Device ID       Local Intf               Hold-time  Capability     Port ID', ...neighbours(s.world, s.dev).map((n) => `${padR(n.dev?.hostname || n.host?.name, 16)}${padR(n.local, 25)}${padR(120, 11)}${padR(n.dev ? 'R' : 'S', 15)}${n.port}`)]) },
    { p: 'show arp', run: (s) => ts(s, ['', '-------------------------------------------------------------------------------', '0/RSP0/CPU0', '-------------------------------------------------------------------------------', 'Address         Age        Hardware Addr   State      Type  Interface', ...arpTable(s.world, s.dev).map((x) => `${padR(x.ip, 16)}${padR(x.self ? '-' : `00:0${hashStr(x.ip) % 9}:2${hashStr(x.ip) % 9}`, 11)}${padR(macCisco(x.mac), 16)}${padR(x.self ? 'Interface' : 'Dynamic', 11)}ARPA  ${x.if}`)]) },
    { p: 'show environment [all]', run: (s) => ts(s, ['', 'Power Module   Status', ...s.dev.hw.psus.map((ok, k) => `0/PS0/M${k}/SP   ${ok ? 'OK' : 'FAILED'}`), '', 'Fan Tray       Status', ...s.dev.hw.fans.map((ok, k) => `0/FT${k}         ${ok ? 'OK' : 'FAILED'}`)]) },
    { p: 'ping $host:t [vrf $word:vrf] [count $num(1-2147483647):n] [size $num(36-18024):size] [donnotfrag]', run: (s, a) => {
      if (!isIp(a.t)) return '% Unrecognized host or address, or protocol not running.';
      const n = a.n || 5;
      const p = ping(s, a.t, { count: n, size: a.size || 100, vrf: a.vrf || null, df: a.has('donnotfrag') });
      return stream([{ d: 10, t: `${stamp(s)}\nType escape sequence to abort.\nSending ${n}, ${a.size || 100}-byte ICMP Echos to ${a.t}, timeout is 2 seconds:\n` }, ...p.res.map((x) => ({ d: x.ok ? 80 : 700, t: x.ok ? '!' : '.' })), { d: 0, t: `\nSuccess rate is ${p.pct} percent (${p.recv}/${n})${p.recv ? `, round-trip min/avg/max = ${p.min}/${p.avg}/${p.max} ms` : ''}\n` }]);
    } },
    { p: 'traceroute $host:t [vrf $word:vrf]', run: (s, a) => {
      const { hops } = trace(s, a.t, { vrf: a.vrf || null });
      return stream([{ d: 10, t: `${stamp(s)}\n\nType escape sequence to abort.\nTracing the route to ${a.t}\n\n` }, ...hops.map((h, k) => ({ d: h.ok ? 300 : 1200, t: h.ok ? ` ${k + 1}  ${h.ip} 2 msec  1 msec  1 msec\n` : ` ${k + 1}  *  *  * \n` }))]);
    } },
    { p: 'configure [terminal]', run: (s) => {
      s.mode = 'config';
      s.ctx = {};
      s.cand = deep(s.dev.cfg);
      return '';
    } },
    { p: 'rollback configuration last $num(1-100):n', run: (s, a) => {
      const r = s.dev.run.rollback[a.n - 1];
      if (!r) return `${stamp(s)}\n\n% Failed to rollback: no such commit`;
      s.cand = deep(r.cfg);
      commitApply(s, s.cand, `rollback last ${a.n}`);
      s.cand = null;
      return stream([{ d: 300, t: `${stamp(s)}\n\nLoading Rollback Changes.\n` }, { d: 600, t: 'Loaded Rollback Changes in 1 sec\nCommitting.\n' }, { d: 600, t: '3 items committed in 1 sec (2)items/sec\nUpdating.\nUpdated Commit database in 1 sec\nConfiguration successfully rolled back ' + a.n + ' commits.\n' }]);
    } },
    { p: 'reload [location all]', run: (s) => ask('Proceed with reload? [confirm]', (x) => {
      if (x.trim() && !/^y/i.test(x)) return '';
      reload(s.world, s.dev, { reason: 'Reload requested by user' });
      if (s.via !== 'console') s.closed = true;
      return '';
    }) },
    { p: 'clear counters [$if:if]', run: () => '' },
    { p: 'terminal length $num(0-512):n', run: (s, a) => ((s.termLen = a.n), '') },
    { p: '{exit|logout}', run: (s) => ((s.closed = true), '') },
  ];
  // ----- configuration -----
  const g = [
    { p: 'hostname $word:h', run: (s, a) => ((cfgOf(s).hostname = a.h), dirty(s)) },
    { p: 'interface $ifc:if', run: (s, a) => {
      const c = cfgOf(s);
      if (!c.ifs[a.if]) {
        const [t, num] = splitIf(a.if);
        if (t === 'Loopback') c.ifs[a.if] = newIf('lo');
        else if (t === 'Bundle-Ether') c.ifs[a.if] = { ...newIf('lag', { lagId: Number(num) }), sw: null };
        else return "% Invalid input detected at '^' marker.";
        dirty(s);
      }
      s.ctx = { if: a.if };
      s.mode = 'if';
    } },
    { p: 'no interface $ifc:if', run: (s, a) => {
      const c = cfgOf(s);
      const i = c.ifs[a.if];
      if (!i) return '';
      if (['lo', 'lag'].includes(i.kind)) delete c.ifs[a.if];
      else c.ifs[a.if] = { ...newIf(i.kind, { hw: i.hw }), on: false };
      return dirty(s);
    } },
    { p: 'router static', run: (s) => ((s.mode = 'static'), '') },
    { p: 'router ospf $word:pid', run: (s, a) => {
      const c = cfgOf(s);
      if (!c.ospf.on) Object.assign(c.ospf, { on: true, pid: Number(a.pid) || 1 });
      s.mode = 'ospf';
      return dirty(s);
    } },
    { p: 'no router ospf $word:pid', run: (s) => {
      cfgOf(s).ospf.on = false;
      for (const i of Object.values(cfgOf(s).ifs)) i.ospf = null;
      return dirty(s);
    } },
    { p: 'router bgp $num(1-4294967295):asn', run: (s, a) => {
      const c = cfgOf(s);
      if (c.bgp.on && c.bgp.asn !== a.asn) return `% BGP instance with AS ${c.bgp.asn} already configured`;
      if (!c.bgp.on) Object.assign(c.bgp, { on: true, asn: a.asn, nbrs: [], nets: [] });
      s.mode = 'bgp';
      return dirty(s);
    } },
    { p: 'route-policy $word:n', run: (s, a) => {
      s.ctx = { rpl: a.n, body: [] };
      s.mode = 'rpl';
    } },
    { p: 'no route-policy $word:n', run: (s, a) => (cfgOf(s).rpl && delete cfgOf(s).rpl[a.n], dirty(s)) },
    { p: 'logging $ip:ip [vrf $word:v] [severity $word:sev]', run: (s, a) => ((cfgOf(s).svc.syslog = [...new Set([...cfgOf(s).svc.syslog, a.ip])]), dirty(s)) },
    { p: '[no] ssh server v2', run: (s, a) => ((cfgOf(s).svc.ssh = !a.has('no')), dirty(s)) },
  ];
  const ifc = [
    { p: 'ipv4 address $ip:ip $mask:m', run: (s, a) => ((sel(s).ip = `${a.ip}/${maskLen(a.m)}`), dirty(s)) },
    { p: 'ipv4 address $pfx:p', run: (s, a) => ((sel(s).ip = a.p), dirty(s)) },
    { p: 'no ipv4 address', run: (s) => ((sel(s).ip = null), dirty(s)) },
    { p: 'shutdown', run: (s) => ((sel(s).on = false), dirty(s)) },
    { p: 'no shutdown', run: (s) => ((sel(s).on = true), dirty(s)) },
    { p: 'description $line:d', run: (s, a) => ((sel(s).desc = a.d), dirty(s)) },
    { p: 'no description', run: (s) => ((sel(s).desc = ''), dirty(s)) },
    { p: 'mtu $num(64-9646):m', run: (s, a) => ((sel(s).mtu = a.m - 14), dirty(s)) },
    { p: 'no mtu', run: (s) => ((sel(s).mtu = 1500), dirty(s)) },
    { p: 'bundle id $num(1-65535):id mode {active|passive|on}', run: (s, a) => {
      const c = cfgOf(s);
      if (!c.ifs[`Bundle-Ether${a.id}`]) c.ifs[`Bundle-Ether${a.id}`] = { ...newIf('lag', { lagId: a.id }), sw: null };
      sel(s).lag = { id: a.id, mode: a.kw[a.kw.length - 1] };
      return dirty(s);
    } },
    { p: 'no bundle id', run: (s) => ((sel(s).lag = null), dirty(s)) },
  ];
  const stat = [
    { p: 'address-family ipv4 unicast', run: (s) => ((s.mode = 'staticaf'), '') },
  ];
  const statAf = [
    { p: '$pfx:p {$ip:nh|Null0} [$num(1-254):ad]', run: (s, a) => {
      const c = cfgOf(s);
      const r = a.has('null0') ? { pfx: a.p, nh: null, iface: 'Null0', ad: a.ad || 1 } : { pfx: a.p, nh: a.nh, ad: a.ad || 1 };
      c.static = c.static.filter((x) => !(x.pfx === r.pfx && x.nh === r.nh && x.iface === r.iface));
      c.static.push(r);
      return dirty(s);
    } },
    { p: 'no $pfx:p [$ip:nh]', run: (s, a) => ((cfgOf(s).static = cfgOf(s).static.filter((x) => !(x.pfx === a.p && (!a.nh || x.nh === a.nh)))), dirty(s)) },
  ];
  const ospf = [
    { p: 'router-id $ip:rid', run: (s, a) => ((cfgOf(s).ospf.rid = a.rid), dirty(s)) },
    { p: 'default-information originate [always]', run: (s, a) => ((cfgOf(s).ospf.defOrig = true), (cfgOf(s).ospf.always = a.has('always')), dirty(s)) },
    { p: 'no default-information originate', run: (s) => ((cfgOf(s).ospf.defOrig = false), dirty(s)) },
    { p: 'area $word:a', run: (s, a) => ((s.ctx.area = /^\d+$/.test(a.a) ? n2ip(Number(a.a)) : a.a), (s.mode = 'ospfar'), '') },
  ];
  const ospfAr = [
    { p: 'interface $if:if', run: (s, a) => {
      const i = cfgOf(s).ifs[a.if];
      i.ospf = i.ospf || { area: null, cost: null, hello: 10, dead: 40, passive: false };
      i.ospf.area = s.ctx.area;
      s.ctx.if = a.if;
      s.mode = 'ospfif';
      return dirty(s);
    } },
    { p: 'no interface $if:if', run: (s, a) => (cfgOf(s).ifs[a.if].ospf && (cfgOf(s).ifs[a.if].ospf.area = null), dirty(s)) },
  ];
  const ospfIf = [
    { p: 'passive {enable|disable}', run: (s, a) => ((sel(s).ospf.passive = a.has('enable')), dirty(s)) },
    { p: 'no passive', run: (s) => ((sel(s).ospf.passive = false), dirty(s)) },
    { p: 'cost $num(1-65535):c', run: (s, a) => ((sel(s).ospf.cost = a.c), dirty(s)) },
    { p: 'hello-interval $num(1-65535):v', run: (s, a) => ((sel(s).ospf.hello = a.v), dirty(s)) },
    { p: 'dead-interval $num(1-65535):v', run: (s, a) => ((sel(s).ospf.dead = a.v), dirty(s)) },
    { p: 'no {cost|hello-interval|dead-interval}', run: (s, a) => {
      const k = a.kw[1];
      sel(s).ospf[k === 'cost' ? 'cost' : k === 'hello-interval' ? 'hello' : 'dead'] = k === 'cost' ? null : k === 'hello-interval' ? 10 : 40;
      return dirty(s);
    } },
  ];
  const bgp = [
    { p: 'bgp router-id $ip:rid', run: (s, a) => ((cfgOf(s).bgp.rid = a.rid), dirty(s)) },
    { p: 'address-family ipv4 unicast', run: (s) => ((s.mode = 'bgpaf'), '') },
    { p: 'neighbor $ip:ip', run: (s, a) => {
      const b = cfgOf(s).bgp;
      if (!b.nbrs.find((x) => x.ip === a.ip)) b.nbrs.push({ ip: a.ip, ras: null, shut: false, desc: '', maxpfx: null, rplIn: null, rplOut: null });
      s.ctx = { nbr: a.ip };
      s.mode = 'bgpnbr';
      return dirty(s);
    } },
    { p: 'no neighbor $ip:ip', run: (s, a) => ((cfgOf(s).bgp.nbrs = cfgOf(s).bgp.nbrs.filter((x) => x.ip !== a.ip)), dirty(s)) },
  ];
  const bgpAf = [
    { p: 'network $pfx:p', run: (s, a) => (cfgOf(s).bgp.nets.includes(a.p) ? '' : (cfgOf(s).bgp.nets.push(a.p), dirty(s))) },
    { p: 'no network $pfx:p', run: (s, a) => ((cfgOf(s).bgp.nets = cfgOf(s).bgp.nets.filter((x) => x !== a.p)), dirty(s)) },
  ];
  const bgpNbr = [
    { p: 'remote-as $num(1-4294967295):as', run: (s, a) => ((nb(s).ras = a.as), dirty(s)) },
    { p: 'description $line:d', run: (s, a) => ((nb(s).desc = a.d), dirty(s)) },
    { p: '[no] shutdown', run: (s, a) => ((nb(s).shut = !a.has('no')), dirty(s)) },
    { p: 'address-family ipv4 unicast', run: (s) => ((s.mode = 'bgpnbraf'), '') },
  ];
  const bgpNbrAf = [
    { p: 'route-policy $word:p {in|out}', run: (s, a) => ((nb(s)[a.has('in') ? 'rplIn' : 'rplOut'] = a.p), dirty(s)) },
    { p: 'no route-policy $word:p {in|out}', run: (s, a) => ((nb(s)[a.has('in') ? 'rplIn' : 'rplOut'] = null), dirty(s)) },
    { p: 'maximum-prefix $num(1-4294967295):m [$num(1-100):t] [warning-only]', run: (s, a) => ((nb(s).maxpfx = a.has('warning-only') ? null : a.m), dirty(s)) },
    { p: 'no maximum-prefix', run: (s) => ((nb(s).maxpfx = null), dirty(s)) },
  ];
  const validate = (s) => {
    const c = s.cand;
    const seen = new Map();
    for (const [n, i] of Object.entries(c.ifs)) {
      if (!i.ip || i.vrf) continue;
      const k = `${n2ip(cidr(i.ip).net)}/${lenOf(i.ip)}`;
      if (seen.has(k) && lenOf(i.ip) < 32) return `!! SEMANTIC ERRORS: This configuration was rejected by \n!! the system due to semantic errors. The individual \n!! errors with each failed configuration command can be \n!! found below.\n\ninterface ${n}\n ipv4 address ${ipOnly(i.ip)} ${maskStr(lenOf(i.ip))}\n!!% 'IP-ADDR-MGR' detected the 'warning' condition 'The address conflicts with an existing address on ${seen.get(k)}'\n!\nend`;
      seen.set(k, n);
    }
    for (const n of c.bgp.nbrs) if (!n.ras) return `!! SEMANTIC ERRORS: This configuration was rejected by\n!! the system due to semantic errors.\n\nrouter bgp ${c.bgp.asn}\n neighbor ${n.ip}\n!!% Invalid argument: AS number must be configured for neighbor ${n.ip}\n!\nend`;
    for (const n of c.bgp.nbrs) for (const p of [n.rplIn, n.rplOut]) if (p && !c.rpl?.[p]) return `!! SEMANTIC ERRORS: This configuration was rejected by\n!! the system due to semantic errors.\n\nrouter bgp ${c.bgp.asn}\n neighbor ${n.ip}\n  address-family ipv4 unicast\n   route-policy ${p} in\n!!% Policy [${p}] uses the 'route-policy' attach point, but has not been defined\n!\nend`;
    return null;
  };
  const doCommit = (s, a) => {
    const pending = JSON.stringify(s.cand) !== JSON.stringify(s.dev.cfg);
    if (!pending) return `${stamp(s)}\n% No configuration changes to commit.`;
    const err = validate(s);
    if (err) {
      s.vars.failed = err;
      return `${stamp(s)}\n\n% Failed to commit one or more configuration items during a pseudo-atomic operation. All changes made have been reverted. Please issue 'show configuration failed [inheritance]' from this session to view the errors`;
    }
    commitApply(s, s.cand, a.comment || null);
    s.cand = deep(s.dev.cfg);
    return stamp(s);
  };
  const common = [
    { p: 'commit [comment $line:comment]', run: doCommit },
    { p: 'abort', run: (s) => {
      s.mode = 'exec';
      s.cand = null;
      s.ctx = {};
      return '';
    } },
    { p: 'show configuration [running]', run: (s, a) => (a.has('running') ? running(s) : diffCfg(s)) },
    { p: 'show configuration failed', run: (s) => s.vars.failed || '' },
    { p: 'root', run: (s) => ((s.mode = 'config'), (s.ctx = {}), '') },
    { p: 'exit', run: (s) => {
      const up = { if: 'config', static: 'config', staticaf: 'static', ospf: 'config', ospfar: 'ospf', ospfif: 'ospfar', bgp: 'config', bgpaf: 'bgp', bgpnbr: 'bgp', bgpnbraf: 'bgpnbr' }[s.mode];
      if (up) {
        s.mode = up;
        return '';
      }
      return exitCfg(s);
    } },
    { p: 'end', run: (s) => exitCfg(s) },
    { p: 'do $line:cmd', run: (s, a) => {
      const keep = s.mode;
      s.mode = 'exec';
      const r = s.exec(a.cmd);
      s.mode = keep;
      return r.stream || r.ask || r.text.replace(/\n$/, '');
    } },
  ];
  function exitCfg(s) {
    if (JSON.stringify(s.cand) !== JSON.stringify(s.dev.cfg)) {
      return ask('Uncommitted changes found, commit them before exiting(yes/no/cancel)? [cancel]:', (x) => {
        const v = x.trim().toLowerCase();
        if (v.startsWith('y')) {
          const r = doCommit(s, { comment: null });
          if (/Failed/.test(r)) return r;
          s.mode = 'exec';
          s.cand = null;
          return r;
        }
        if (v.startsWith('n')) {
          s.mode = 'exec';
          s.cand = null;
          return '';
        }
        return '';
      });
    }
    s.mode = 'exec';
    s.cand = null;
    return '';
  }
  const rplCmds = [{ p: '$line:x', run: (s, a) => {
    if (a.x.trim() === 'end-policy') {
      const c = cfgOf(s);
      c.rpl = c.rpl || {};
      c.rpl[s.ctx.rpl] = s.ctx.body.join('\n') || 'pass';
      s.mode = 'config';
      return dirty(s);
    }
    s.ctx.body.push(a.x.trim());
    return '';
  } }];
  const tries = {
    exec: compile(exec, KW),
    config: compile([...g, ...common], KW),
    if: compile([...ifc, ...common], KW),
    static: compile([...stat, ...common], KW),
    staticaf: compile([...statAf, ...common], KW),
    ospf: compile([...ospf, ...common], KW),
    ospfar: compile([...ospfAr, ...common], KW),
    ospfif: compile([...ospfIf, ...common], KW),
    bgp: compile([...bgp, ...common], KW),
    bgpaf: compile([...bgpAf, ...common], KW),
    bgpnbr: compile([...bgpNbr, ...common], KW),
    bgpnbraf: compile([...bgpNbrAf, ...common], KW),
    rpl: compile(rplCmds, KW),
  };
  const P = { config: 'config', if: 'config-if', static: 'config-static', staticaf: 'config-static-afi', ospf: 'config-ospf', ospfar: 'config-ospf-ar', ospfif: 'config-ospf-ar-if', bgp: 'config-bgp', bgpaf: 'config-bgp-af', bgpnbr: 'config-bgp-nbr', bgpnbraf: 'config-bgp-nbr-af', rpl: 'config-rpl' };
  const node = (dev) => (/RP0/.test(dev.meta.mgmtIf || '') ? 'RP/0/RP0/CPU0' : 'RP/0/RSP0/CPU0');
  return {
    id: 'iosxr',
    startMode: 'exec',
    pipes: ['include', 'exclude', 'begin', 'count', 'file'],
    defaultLen: 24,
    more: ' --More-- ',
    prompt: (s) => (s.dev.state !== 'up' ? '' : s.mode === 'exec' ? `${node(s.dev)}:${s.dev.cfg.hostname}#` : `${node(s.dev)}:${(s.cand || s.dev.cfg).hostname}(${P[s.mode]})#`),
    greeting: (s) => `\n\n${s.dev.cfg.svc.motd ? `${s.dev.cfg.svc.motd}\n\n` : ''}`,
    loginPrompt: () => 'Username: ',
    telnetBanner: () => '\nUser Access Verification\n\n',
    closeMsg: (s) => (s.via === 'console' ? '\n[Disconnected from console server]\n' : `Connection to ${s.world.design.mgmt[s.dev.id]} closed.\n`),
    preprocess: (s) => (s.dev.state !== 'up' ? '' : undefined),
    trie: (s, m) => tries[m] || tries.exec,
    fallback: (s) => (!['exec', 'config', 'rpl'].includes(s.mode) ? ['config'] : []),
    matchIf(s, toks, i, create) {
      const v = toks[i].v;
      let r = resolveIf(s.dev, v, { allowCreate: create });
      if (r) return { val: r, n: 1 };
      if (/^[A-Za-z-]+$/.test(v) && toks[i + 1] && /^\d/.test(toks[i + 1].v)) {
        r = resolveIf(s.dev, v + toks[i + 1].v, { allowCreate: create });
        if (r) return { val: r, n: 2 };
      }
      return null;
    },
    ifTypeHelp: (s, create) => [...new Set([...Object.keys(s.dev.cfg.ifs).map((n) => splitIf(n)[0]), ...(create ? ['Loopback', 'Bundle-Ether'] : [])])].map((t) => [t, `${t} interface(s) | short name is ${t.slice(0, 2)}`]),
    ifNames: (s) => Object.keys(s.dev.cfg.ifs),
    helpFmt(s, items, cr) {
      const w = Math.max(...items.map(([k]) => k.length), 4) + 2;
      return [...items.map(([k, h]) => `  ${padR(k, w)}${h}`), ...(cr ? ['  <cr>'] : [])].join('\n');
    },
    error(s, kind, x) {
      if (kind === 'ambiguous') return `% Ambiguous command:  "${x.line}"`;
      if (kind === 'incomplete') return '% Incomplete command.';
      return `${' '.repeat(s.prompt.length + x.pos)}^\n% Invalid input detected at '^' marker.`;
    },
    ctrlC: () => '\n',
    ctrlZ: (s) => (s.mode !== 'exec' ? exitCfg(s) : ''),
    fmtEvent: fmtEventXR,
  };
}
void ensureLag;
void physIfs;
