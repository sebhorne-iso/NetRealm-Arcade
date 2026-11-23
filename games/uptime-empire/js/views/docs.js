// Documentation: IPAM, patching schedule, password vault, config backups (with diffs), patch
// calendar, runbooks and a cross-vendor command reference. At higher difficulties some records are
// stale (see builder.makeDocErrors) - just like real documentation.
import { h, fill, btn, table, pill } from '../ui/dom.js';
import { model, OS } from '../net/catalog.js';
import { SVC, ISP_DEFS, vlanNet, vlanName, MGMT_VLAN } from '../net/builder.js';
import { configText, advisoryDate } from '../game/game.js';
import { diffLines, fmtDate } from '../core/util.js';

const TABS = ['IPAM', 'Patching', 'Vault', 'Config backups', 'Patch calendar', 'Runbooks', 'Command reference'];

export const DocsView = {
  title: 'Docs',
  mount(app, el) {
    this.app = app;
    this.tab = app.state.docTab || 'IPAM';
    this.body = h('div.docbody');
    this.tabs = h('div.tabs');
    fill(el, h('div.viewhead', {}, h('h2', {}, 'Documentation'), h('span.muted', {}, app.w.difficulty === 'entry' ? 'Accurate and up to date.' : 'Maintained by humans. Trust, but verify.')), this.tabs, this.body);
    this.render();
  },
  render() {
    fill(this.tabs, TABS.map((t) => h(`button.tab${t === this.tab ? '.on' : ''}`, { type: 'button', onclick: () => ((this.tab = t), (this.app.state.docTab = t), this.render()) }, t)));
    const fn = { IPAM: ipam, Patching: patching, Vault: vault, 'Config backups': backups, 'Patch calendar': patches, Runbooks: runbooks, 'Command reference': rosetta }[this.tab];
    fill(this.body, fn(this.app, this));
  },
};

function errFor(w, pred) {
  return (w.design.docErrors || []).find(pred);
}
function ipam(app) {
  const w = app.w;
  const d = w.design;
  const nets = [[d.roles.oob.length ? MGMT_VLAN : '-', 'OOB-MGMT', '10.250.0.0/24', '-', 'Out-of-band management, jump01 = .10'], [20, 'SERVICES', '10.20.0.0/24', `${SVC.net}.1`, `dns ${SVC.dns} · ntp ${SVC.ntp} · syslog ${SVC.syslog} · nms ${SVC.nms} · dhcp ${SVC.dhcp} · radius ${SVC.radius}`]];
  if (d.office.on) for (const v of [30, 31, 32]) nets.push([v, vlanName(w, v), `${vlanNet(w, v)}.0/24`, `${vlanNet(w, v)}.1`, v === 32 ? 'Access points + controller 10.32.0.5' : 'Office']);
  for (const c of d.customers) {
    const e = errFor(w, (x) => x.doc === 'ipam' && x.kind === 'vlan' && x.cust === c.id);
    nets.push([e ? e.wrong : c.vlan, vlanName(w, c.vlan), `10.100.${c.k}.0/24`, `10.100.${c.k}.1`, `${c.name}${c.pending ? ' (onboarding)' : ''}: ${c.servers.map((s) => `${w.hosts[s]?.name} ${w.hosts[s]?.ip}`).join(', ')}${c.vip ? ` · public ${c.vip}` : ''}`]);
  }
  const mg = Object.entries(d.mgmt).filter(([id]) => w.devices[id]).map(([id, ip]) => {
    const e = errFor(w, (x) => x.doc === 'ipam' && x.kind === 'mgmt' && x.dev === id);
    const dev = w.devices[id];
    return [dev.hostname, e ? e.wrong : ip, model(dev.model).name, dev.role, d.lo[id] || '-'];
  });
  const isps = ISP_DEFS.filter((x) => d.isps.includes(x.id)).map((x) => [x.name, `AS${x.asn}`, `${x.net}/30`, x.peer, x.ours]);
  return [h('h3', {}, 'Networks & VLANs'), table(['VLAN', 'Name', 'Subnet', 'Gateway', 'Notes'], nets), h('h3', {}, 'Device management & loopbacks'), table(['Device', 'Mgmt IP', 'Model', 'Role', 'Loopback'], mg), h('h3', {}, 'Upstream'), table(['ISP', 'AS', 'Link', 'ISP address', 'Our address'], isps), h('p.muted', {}, `Our AS: ${d.asn}${d.bgp ? '' : ' (not yet used: single-homed with a static default)'} · public block 192.0.2.0/24 · routing: ${d.routing || 'static'}`)];
}
function patching(app) {
  const w = app.w;
  const end = (e) => (e.dev ? `${w.devices[e.dev]?.hostname || '?'} ${e.if}` : w.hosts[e.host]?.name || e.host);
  const rows = w.links.filter((l) => !l.rogue).map((l) => {
    const e = errFor(w, (x) => x.doc === 'patch' && x.link === l.id);
    const tp = errFor(w, (x) => x.doc === 'topo' && x.link === l.id && x.kind === 'wrongport');
    const bEnd = tp && l.b.dev ? `${w.devices[l.b.dev]?.hostname} ${l.b.if.replace(/\d+$/, (n) => Number(n) + 1)}` : end(l.b);
    return [l.cable?.id || '-', end(l.a), bEnd, l.panel ? `${l.panel.id}:${e ? e.wrong : l.panel.port}` : '-', l.type || l.cable?.type || '', l.purpose || ''];
  });
  return [h('p.muted', {}, 'Cable patching schedule. Every cable has a label at both ends.'), table(['Cable', 'A end', 'B end', 'Patch panel', 'Media', 'Purpose'], rows)];
}
function vault(app, view) {
  const w = app.w;
  view.reveal = view.reveal || false;
  const rows = Object.entries(w.design.vault).filter(([id]) => w.devices[id]).map(([id, v]) => [w.devices[id].hostname, v.user, view.reveal ? v.pw : '••••••••', ['ios', 'iosxe', 'asa'].includes(w.devices[id].os) ? (view.reveal ? v.enable : '••••••••') : '-']);
  return [h('p.muted', {}, 'Credentials for device CLI access. Customer servers are reached through the console server (console <name> on jump01).'), btn(view.reveal ? 'Hide' : 'Reveal passwords', () => ((view.reveal = !view.reveal), view.render())), table(['Device', 'User', 'Password', 'Enable secret'], rows)];
}
function backups(app, view) {
  const w = app.w;
  const devs = Object.values(w.devices).filter((d) => (w.backups[d.id] || []).length);
  view.bdev = view.bdev && w.backups[view.bdev] ? view.bdev : devs[0]?.id;
  const sel = h('select', { onchange: (e) => ((view.bdev = e.target.value), view.render()) }, devs.map((d) => h('option', { value: d.id, selected: d.id === view.bdev }, d.hostname)));
  const list = w.backups[view.bdev] || [];
  const out = h('pre.diff');
  const show = (txt) => (out.textContent = txt);
  const diffNow = () => {
    const dev = w.devices[view.bdev];
    const cur = configText(w, dev);
    const last = list[list.length - 1];
    if (!cur || !last) return show('Device unreachable.');
    const d = diffLines(last.text, cur).filter((x, i, arr) => x.op !== ' ' || arr.slice(Math.max(0, i - 2), i + 3).some((y) => y.op !== ' '));
    while (out.firstChild) out.removeChild(out.firstChild);
    if (!d.some((x) => x.op !== ' ')) return show(`No changes since the backup of ${fmtDate(last.t, 'datetime')}.`);
    for (const x of d) out.append(h(`span.${x.op === '+' ? 'add' : x.op === '-' ? 'del' : 'ctx'}`, {}, `${x.op} ${x.line}\n`));
  };
  return [h('p.muted', {}, 'Nightly backups at 02:00 (kept when the config changed, last 5). Diff the running config against the last backup to find what someone changed.'), h('div.btnrow', {}, 'Device ', sel, btn('Diff running vs last backup', diffNow, 'primary')), table(['Taken', 'Size', ''], list.map((b) => [fmtDate(b.t, 'datetime'), `${b.text.length} bytes`, h('td', {}, btn('View', () => show(b.text), 'small'))]).reverse()), out];
}
function patches(app) {
  const w = app.w;
  const rows = [];
  for (const a of app.data.advisories.advisories) {
    if (advisoryDate(a) > w.time.t) continue;
    const hit = Object.entries(w.advisoryHits || {}).filter(([, hs]) => hs.some((x) => x.id === a.id)).map(([id]) => w.devices[id]).filter(Boolean);
    rows.push([fmtDate(advisoryDate(a), 'iso'), a.id, pill(a.severity, a.severity === 'critical' ? 'bad' : a.severity === 'high' ? 'warn' : 'off'), `${a.title} (${a.effect})`, a.os === '*' ? 'all' : OS[a.os]?.label || a.os, a.fixed || `${a.fixedYear}+ releases`, hit.length ? hit.map((d) => `${d.hostname} ${d.version}`).join(', ') : h('span.muted', {}, 'none')]);
  }
  rows.reverse();
  return [h('p.muted', {}, 'Vendor advisories (simulated). Upgrade affected devices from the device panel or Changes; upgrades run in the 02:00 maintenance window and reload the device.'), rows.length ? table(['Published', 'ID', 'Severity', 'Title', 'OS', 'Fixed in', 'Your affected devices'], rows) : h('p', {}, 'No advisories published yet.')];
}

// ---------------------------------------------------------------------------------------------
const KB = [
  ['Method: work the layers', ['Start from the symptom and the scope: one host, one customer, one VLAN, everyone?', 'Layer 1: link lights, cable state, optics RX power, interface errors (CRC, late collisions).', 'Layer 2: port mode and VLAN, trunk allowed list and native VLAN, VLAN exists, STP state (blocking, err-disabled, BPDU guard), MAC table.', 'Layer 3: addresses and masks, gateway (SVI/irb up?), routing table, OSPF/BGP neighbours, static routes and next hops.', 'Policy: ACLs, firewall rules, NAT/VIPs. Use packet-tracer (ASA), diagnose debug flow (FortiGate), show security flow (SRX).', 'Prove it before you change it. Then write the RCA with the exact evidence.']],
  ['Layer 1', ['notconnect / down with no admin shutdown: cable, optic, far end powered off.', 'err-disabled: the switch shut the port (BPDU guard, port-security). Fix the cause, then shut / no shut (or Junos: clear the bpdu error).', 'CRC errors climbing with a link up: dirty fibre, bad cable or a duplex mismatch.', 'Late collisions: one side half duplex. Never hard-code speed/duplex on one side only.', 'Optics: RX power below about -10 dBm is suspicious; below -14 dBm the link drops.']],
  ['VLANs & trunks', ['Access port in the wrong VLAN: the host is up but can only see its own neighbours.', 'A VLAN missing from the trunk allowed list (or deleted from the switch) takes out every host of that VLAN behind the trunk.', 'IOS: switchport trunk allowed vlan ADD 103 - without "add" you replace the whole list!', 'Native VLAN mismatches leak traffic between VLANs; CDP/LLDP logs complain.', 'Juniper EX: vlan members on unit 0 family ethernet-switching; HP ProCurve: vlan X untagged/tagged ports.']],
  ['Spanning tree & loops', ['Symptoms of a loop: MAC flapping logs, CPU at 100%, broadcast storms, everything slow.', 'Look for two paths between the same switches and for spanning tree disabled.', 'BPDU guard on edge ports protects you from customers plugging in switches.']],
  ['Port-channels / LAG', ['Both ends must agree: LACP active/passive with at least one active, or static "on" on both sides.', 'Members "suspended"/"defaulted" = the peer is not speaking LACP.']],
  ['OSPF', ['Neighbours must agree on area, hello/dead timers, subnet/mask, authentication and MTU, and have unique router IDs.', 'Stuck in EXSTART/EXCHANGE = MTU mismatch.', 'Passive interfaces send no hellos: never make a transit link passive.', 'Junos uses preference 10 internal / 150 external; Cisco uses AD 110.']],
  ['BGP', ['Check the summary: Idle (Admin) = shut locally, Active = no TCP session, Idle (PfxCt) = maximum-prefix tripped.', 'Bad peer AS notifications: the remote-as/peer-as is wrong.', 'IOS XR drops all eBGP routes unless a route-policy is attached in both directions.', 'A full table is ~950,000 prefixes: set maximum-prefix limits that make sense.']],
  ['NAT & firewalls', ['Private sources reaching the ISP are dropped: outbound needs source NAT/PAT.', 'Inbound web needs a static NAT/VIP AND a permit rule. ASA 8.3+ ACLs use the real (inside) IP; before 8.3 they use the mapped (public) IP.', 'ASA: packet-tracer input outside tcp 198.51.100.77 1234 <public ip> 443', 'FortiGate: diagnose debug flow filter addr <ip> / diagnose debug flow trace start 10 / diagnose debug enable', 'SRX: show security policies, show security nat static rule all.']],
  ['Wi-Fi & DHCP', ['Clients associate but get 169.254.x.x: DHCP is not reaching them - check the relay (ip helper-address / dhcp-relay) on the VLAN gateway.', 'Clients fail 802.1X: check the RADIUS server address and shared secret on the controller (aaa test-server on ArubaOS).', 'APs down: AP VLAN reachability and the controller address (Aruba AP boot: setenv master).']],
  ['Servers', ['Ping works, HTTPS refused: the application is not listening (systemctl status nginx, ss -tlnp, journalctl -u nginx).', 'Reachable only from its own subnet: check the default route (ip route).', 'Slow and lossy: ethtool eth0 for speed/duplex, top for CPU.']],
  ['Power & cooling', ['Several devices in one rack down at once: check the PDU breakers and the rack load.', 'Room temperature rising: a cooling unit has failed. Devices shut down above ~68 C.', 'Dual power supplies on A and B feeds survive a single breaker trip.']],
  ['Change management', ['Save your work: IOS write memory, NX-OS copy run start, AOS write memory. Junos and IOS XR commit; FortiOS saves immediately.', 'Reloads load the startup configuration: unsaved changes are gone.', 'Use commit confirmed (Junos) or checkpoints (NX-OS, AOS-CX) when you might lock yourself out.', 'Config backups (02:00 nightly) let you diff what changed.']],
];
function runbooks() {
  return KB.map(([title, lines]) => h('details.kb', {}, h('summary', {}, title), h('ul', {}, lines.map((l) => h('li', {}, l)))));
}
const ROS = [
  ['Interface status', 'show ip interface brief / show interfaces status', 'show interface brief', 'show interface ip brief / show nameif', 'show ipv4 interface brief', 'show interfaces terse', 'show interface brief', 'show interfaces brief', 'get system interface physical / diagnose switch physical-ports summary'],
  ['One interface + errors', 'show interfaces Gi1/0/1', 'show interface e1/1', 'show interface Gi0/0', 'show interfaces Te0/0/0/0', 'show interfaces ge-0/0/1 extensive', 'show interface 1/1/1', 'show interfaces 1', 'diagnose hardware deviceinfo nic port1'],
  ['VLANs', 'show vlan brief', 'show vlan brief', '-', '-', 'show vlans', 'show vlan', 'show vlans / show vlans 101', 'show switch vlan (FortiSwitch)'],
  ['Trunks', 'show interfaces trunk', 'show interface trunk', '-', '-', 'show ethernet-switching interface', 'show interface 1/1/49', 'show vlans ports 25 detail', 'show switch interface'],
  ['Spanning tree', 'show spanning-tree vlan 101', 'show spanning-tree', '-', '-', 'show spanning-tree interface', 'show spanning-tree', 'show spanning-tree', 'diagnose stp instance list'],
  ['LAG / LACP', 'show etherchannel summary', 'show port-channel summary', '-', 'show bundle', 'show lacp interfaces', 'show lacp aggregates', 'show lacp / show trunks', '-'],
  ['Routing table', 'show ip route', 'show ip route', 'show route', 'show route', 'show route', 'show ip route', 'show ip route', 'get router info routing-table all'],
  ['OSPF neighbours', 'show ip ospf neighbor', 'show ip ospf neighbors', 'show ospf neighbor', 'show ospf neighbor', 'show ospf neighbor', 'show ip ospf neighbors', '-', 'get router info ospf neighbor'],
  ['BGP', 'show ip bgp summary', 'show ip bgp summary', '-', 'show bgp summary', 'show bgp summary', '-', '-', 'get router info bgp summary'],
  ['FHRP', 'show standby brief / show vrrp', 'show hsrp brief', '-', '-', 'show vrrp summary', 'show vrrp brief', '-', '-'],
  ['Logs', 'show logging', 'show logging logfile', 'show logging', 'show logging', 'show log messages', 'show events -r', 'show log -r', 'execute log display'],
  ['Config', 'show running-config', 'show running-config', 'show running-config', 'show running-config', 'show configuration [| display set]', 'show running-config', 'show running-config', 'show / show full-configuration'],
  ['Save / commit', 'write memory', 'copy running-config startup-config', 'write memory', 'commit', 'commit [confirmed 5]', 'write memory', 'write memory', '(automatic)'],
  ['Ping / trace', 'ping 10.0.0.1 / traceroute', 'ping 10.0.0.1 vrf management', 'ping 10.0.0.1 / packet-tracer', 'ping 10.0.0.1', 'ping 10.0.0.1 count 5 / traceroute', 'ping 10.0.0.1 vrf mgmt', 'ping 10.0.0.1', 'execute ping 10.0.0.1'],
  ['Packet capture', '-', '-', 'capture CAP interface outside match ...', '-', 'monitor traffic interface ge-0/0/0', '-', '-', "diagnose sniffer packet any 'host 1.2.3.4' 4"],
];
function rosetta() {
  return [h('p.muted', {}, 'The same job on every platform in the empire.'), table(['Task', 'Cisco IOS / IOS XE', 'NX-OS', 'ASA', 'IOS XR', 'Junos / EVO', 'AOS-CX', 'AOS-Switch', 'FortiOS / FortiSwitch'], ROS, { cls: 'ros' })];
}
