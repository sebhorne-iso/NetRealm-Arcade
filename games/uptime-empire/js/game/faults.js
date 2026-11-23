// Fault catalog. Each template is written once against the vendor-neutral model, so it can strike
// any OS. A fault knows how to break the network, how to tell that it has been fixed, what the
// customer says when it happens, the true root cause (for RCA scoring) and the fix as an abstract
// "op" that js/game/recipes.js turns into exact commands for the device's OS.
import { model, OS } from '../net/catalog.js';
import { ensureVlan } from '../net/model.js';
import { SVC, OFFICE, PUBLIC, vlanNet } from '../net/builder.js';
import { recompute } from '../net/events.js';
import { checks } from '../net/sim.js';
import { syncListen } from '../cli/linux.js';
import { reload } from '../net/devops.js';
import { ip2n, n2ip, cidr } from '../core/util.js';

export const TIERS = { entry: 1, associate: 2, professional: 3, expert: 4 };
export const CATS = {
  physical: 'Physical layer / cabling',
  config: 'Switching configuration',
  routing: 'Routing configuration',
  security: 'Firewall / NAT / ACL',
  server: 'Server / application',
  hardware: 'Hardware failure',
  facility: 'Power / cooling',
  software: 'Software defect (firmware)',
  change: 'Unplanned change (human error)',
};

const D = (w, id) => w.devices[id];
const H = (w, id) => w.hosts[id];
const ifOf = (w, devId, n) => w.devices[devId]?.cfg.ifs[n];
const custOfHost = (w, hid) => w.design.customers.find((c) => c.servers.includes(hid));
const custOfVlan = (w, v) => w.design.customers.find((c) => c.vlan === v);
const roleDevs = (w, r) => (w.design.roles[r] || []).map((id) => w.devices[id]).filter(Boolean);
const up = (w, dev) => dev && dev.state === 'up';
const hasOs = (dev, ...os) => os.includes(dev.os);
const isSw = (dev) => model(dev.model).feat.includes('l2');

// ---------- target finders ----------
export function serverPorts(w) {
  const out = [];
  for (const l of w.links) {
    if (l.purpose !== 'server') continue;
    const h = H(w, l.a.host);
    const dev = D(w, l.b.dev);
    if (!h || !dev || h.kind !== 'server') continue;
    const cust = custOfHost(w, h.id);
    if (cust?.pending) continue;
    out.push({ h, dev, if: l.b.if, link: l, cust });
  }
  return out;
}
const uplinks = (w, purposes = ['uplink']) => w.links.filter((l) => purposes.includes(l.purpose) && l.a.dev && l.b.dev && D(w, l.a.dev) && D(w, l.b.dev));
const transitOspf = (w) => uplinks(w, ['transit']).filter((l) => ifOf(w, l.a.dev, l.a.if)?.ospf?.area != null && ifOf(w, l.b.dev, l.b.if)?.ospf?.area != null);
function custSvis(w) {
  const out = [];
  for (const dev of [...roleDevs(w, 'core'), ...roleDevs(w, 'edge')]) {
    for (const [n, i] of Object.entries(dev.cfg.ifs)) {
      const v = i.kind === 'svi' ? i.vlan : i.kind === 'sub' ? i.vlan : null;
      const c = v && custOfVlan(w, v);
      if (c && !c.pending && i.ip) out.push({ dev, if: n, cust: c, vlan: v });
    }
  }
  return out;
}
const fws = (w) => roleDevs(w, 'fw').slice(0, 1);
const bgpEdges = (w) => roleDevs(w, 'edge').filter((e) => e.cfg.bgp?.on && e.cfg.bgp.nbrs.length);
const fiberPorts = (w) => uplinks(w, ['uplink', 'transit', 'isl']).flatMap((l) => [l.a, l.b].filter((e) => /sfp|qsfp/.test(ifOf(w, e.dev, e.if)?.hw?.media || '')).map((e) => ({ dev: D(w, e.dev), if: e.if, link: l })));

// =============================================================================================
export const FAULTS = [
  {
    id: 'port-shutdown', tier: 1, cat: 'config', sev: 2, name: 'Server switchport administratively shut down',
    targets: (w) => serverPorts(w).filter((p) => ifOf(w, p.dev.id, p.if).on),
    inject(w, t) {
      ifOf(w, t.dev.id, t.if).on = false;
      return { dev: t.dev.id, if: t.if, host: t.h.id, cust: t.cust?.id };
    },
    fixed: (w, r) => ifOf(w, r.dev, r.if).on && !D(w, r.dev).run.errdis[r.if],
    rca: (w, r) => ({ dev: r.dev, cat: 'config', keys: ['shutdown', 'admin', 'disabled', r.if.toLowerCase()] }),
    ticket: (w, r) => ({ title: `${H(w, r.host).name} unreachable`, text: [`Monitoring: ${H(w, r.host).name} (${H(w, r.host).ip}) is down. It connects to ${D(w, r.dev).hostname} ${r.if}.`, `${custName(w, r)} says their server ${H(w, r.host).name} has gone offline.`, `${custName(w, r)}: "our server just dropped off the network about an hour ago"`, `${custName(w, r)}: "Nothing works. Did you change something?"`] }),
    hints: (w, r) => [`Find which switch port ${H(w, r.host).name} is patched into (Docs > Patching schedule).`, `Check the port status on ${D(w, r.dev).hostname} - look for "disabled" / "administratively down".`, `Enable ${r.if} on ${D(w, r.dev).hostname}.`],
    ops: (w, r) => [{ op: 'ifUp', dev: r.dev, if: r.if }],
  },
  {
    id: 'cable-unplugged', tier: 1, cat: 'physical', sev: 2, name: 'Patch cable unplugged',
    targets: (w) => serverPorts(w).filter((p) => p.link.cable?.ok !== false),
    inject(w, t) {
      t.link.cable.ok = false;
      return { link: t.link.id, dev: t.dev.id, if: t.if, host: t.h.id, cust: t.cust?.id };
    },
    fixed: (w, r) => w.links.find((l) => l.id === r.link)?.cable.ok !== false,
    rca: (w, r) => ({ dev: r.dev, cat: 'physical', keys: ['cable', 'unplugged', 'reseat', 'patch', 'physical'] }),
    ticket: (w, r) => ({ title: `${H(w, r.host).name} unreachable`, text: [`Monitoring: ${H(w, r.host).name} is down; ${D(w, r.dev).hostname} ${r.if} shows no link (notconnect). A contractor was working in the room this morning.`, `${custName(w, r)} reports ${H(w, r.host).name} is offline.`, `${custName(w, r)}: "website down. again."`, `${custName(w, r)}: "is your datacentre on fire?"`] }),
    hints: (w, r) => [`A port showing "notconnect"/"down" with no admin shutdown points to layer 1.`, `Walk to rack ${D(w, r.dev).rack} and inspect ${D(w, r.dev).hostname} port ${r.if}.`, 'Reseat the patch cable.'],
    ops: (w, r) => [{ op: 'phys', action: 'reseat', link: r.link }],
  },
  {
    id: 'nginx-crash', tier: 1, cat: 'server', sev: 2, name: 'Web server process killed (out of memory)',
    targets: (w) => w.design.customers.filter((c) => c.web && !c.pending && H(w, c.servers[0])).map((c) => ({ h: H(w, c.servers[0]), cust: c })),
    inject(w, t) {
      syncListen(t.h);
      t.h.svcs.nginx = 'failed';
      t.h.svcWhy = { ...(t.h.svcWhy || {}), nginx: 'oom-kill' };
      t.h.svcSince = { ...(t.h.svcSince || {}), nginx: w.time.t };
      syncListen(t.h);
      return { host: t.h.id, cust: t.cust.id };
    },
    fixed: (w, r) => H(w, r.host)?.svcs?.nginx === 'active',
    rca: (w, r) => ({ dev: r.host, cat: 'server', keys: ['nginx', 'memory', 'oom', 'service', 'process'] }),
    ticket: (w, r) => ({ title: `${custName(w, r)} website down`, text: [`Monitoring: HTTPS to ${w.design.customers.find((c) => c.id === r.cust).vip} fails with "connection refused", but ${H(w, r.host).name} still answers ping.`, `${custName(w, r)} says their website shows an error.`, `${custName(w, r)}: "site's dead"`, `${custName(w, r)}: "Your network is broken, our site won't load."`] }),
    hints: (w, r) => ['Ping works but HTTPS is refused: the network delivers the packet, nothing is listening.', `Open the server console: console ${H(w, r.host).name} (from jump01).`, 'systemctl status nginx, then journalctl -u nginx', 'systemctl start nginx'],
    ops: (w, r) => [{ op: 'server', host: r.host, cmds: ['systemctl start nginx'] }],
  },
  {
    id: 'psu-failed', tier: 1, cat: 'hardware', sev: 3, service: false, name: 'Redundant power supply failed',
    targets: (w) => Object.values(w.devices).filter((d) => d.hw.psus.length > 1 && d.hw.psus.every(Boolean) && up(w, d)).map((dev) => ({ dev })),
    inject(w, t) {
      t.dev.hw.psus[1] = false;
      return { dev: t.dev.id };
    },
    fixed: (w, r) => D(w, r.dev)?.hw.psus.every(Boolean),
    rca: (w, r) => ({ dev: r.dev, cat: 'hardware', keys: ['power supply', 'psu', 'replace'] }),
    ticket: (w, r) => ({ title: `Power supply alarm on ${D(w, r.dev).hostname}`, text: [`Monitoring: ${D(w, r.dev).hostname} reports power supply 2 failed. The device is running on one PSU.`, `Alarm: ${D(w, r.dev).hostname} environmental alarm.`, `Alarm: ${D(w, r.dev).hostname} chassis alarm.`, 'Facilities: "one of your boxes has a red light on the back"'] }),
    hints: (w, r) => [`Check the device's environment / chassis alarms.`, `Replace the failed PSU on ${D(w, r.dev).hostname} (rack view, needs a spare).`],
    ops: (w, r) => [{ op: 'phys', action: 'replace-psu', dev: r.dev }],
  },
  {
    id: 'fan-failure', tier: 1, cat: 'hardware', sev: 3, service: false, name: 'Fan tray failure',
    targets: (w) => Object.values(w.devices).filter((d) => d.hw.fans.length && d.hw.fans.every(Boolean) && up(w, d)).map((dev) => ({ dev })),
    inject(w, t) {
      t.dev.hw.fans[0] = false;
      t.dev.hw.temp += 17;
      return { dev: t.dev.id };
    },
    fixed: (w, r) => D(w, r.dev)?.hw.fans.every(Boolean),
    rca: (w, r) => ({ dev: r.dev, cat: 'hardware', keys: ['fan', 'temperature', 'replace'] }),
    ticket: (w, r) => ({ title: `Temperature warning on ${D(w, r.dev).hostname}`, text: [`Monitoring: ${D(w, r.dev).hostname} fan 1 failed and temperature is rising.`, `Alarm: ${D(w, r.dev).hostname} temperature high.`, `Alarm: ${D(w, r.dev).hostname} environment.`, 'Facilities: "that switch sounds different"'] }),
    hints: () => ['Check the environment output (fans, temperature).', 'Replace the fan tray (rack view, needs a spare).'],
    ops: (w, r) => [{ op: 'phys', action: 'replace-fan', dev: r.dev }],
  },
  {
    id: 'wrong-access-vlan', tier: 1, cat: 'config', sev: 2, name: 'Server port moved to the wrong VLAN',
    targets: (w) => serverPorts(w).filter((p) => ifOf(w, p.dev.id, p.if).sw?.mode === 'access'),
    inject(w, t) {
      const i = ifOf(w, t.dev.id, t.if);
      const good = i.sw.vlan;
      const others = Object.keys(t.dev.cfg.vlans).map(Number).filter((v) => v !== good && v !== 999);
      const bad = others.find((v) => v !== 1) || 1;
      i.sw.vlan = bad;
      return { dev: t.dev.id, if: t.if, host: t.h.id, cust: t.cust?.id, good, bad };
    },
    fixed: (w, r) => ifOf(w, r.dev, r.if).sw?.vlan === r.good && ifOf(w, r.dev, r.if).sw?.mode === 'access',
    rca: (w, r) => ({ dev: r.dev, cat: 'config', keys: ['vlan', String(r.good), String(r.bad), 'access'] }),
    ticket: (w, r) => ({ title: `${H(w, r.host).name} unreachable after change`, text: [`Monitoring: ${H(w, r.host).name} unreachable. Last night's change ticket moved some ports on ${D(w, r.dev).hostname}.`, `${custName(w, r)} reports ${H(w, r.host).name} unreachable since this morning.`, `${custName(w, r)}: "can't reach our box"`, `${custName(w, r)}: "server can ping itself but nothing else"`] }),
    hints: (w, r) => ['The port is up but the server cannot reach its gateway: check which VLAN the port is in.', `Compare ${D(w, r.dev).hostname} ${r.if} with the VLAN for ${custName(w, r)} in IPAM.`, `Put ${r.if} back into access VLAN ${r.good}.`],
    ops: (w, r) => [{ op: 'accessVlan', dev: r.dev, if: r.if, vlan: r.good }],
  },
  {
    id: 'vlan-deleted', tier: 2, cat: 'config', sev: 1, name: 'Customer VLAN deleted from an access switch',
    targets: (w) => roleDevs(w, 'access').flatMap((dev) => Object.keys(dev.cfg.vlans).map(Number).filter((v) => custOfVlan(w, v) && !custOfVlan(w, v).pending && !['junos', 'evo'].includes(dev.os)).map((v) => ({ dev, vlan: v }))),
    inject(w, t) {
      const name = t.dev.cfg.vlans[t.vlan];
      delete t.dev.cfg.vlans[t.vlan];
      return { dev: t.dev.id, vlan: t.vlan, name, cust: custOfVlan(w, t.vlan)?.id };
    },
    fixed: (w, r) => r.vlan in D(w, r.dev).cfg.vlans,
    rca: (w, r) => ({ dev: r.dev, cat: 'config', keys: ['vlan', String(r.vlan), 'deleted', 'missing'] }),
    ticket: (w, r) => ({ title: `${custName(w, r)}: all servers down`, text: [`Monitoring: every ${custName(w, r)} server behind ${D(w, r.dev).hostname} is down. Ports show "inactive" or "VLAN/BD is down".`, `${custName(w, r)} reports all of their servers are offline.`, `${custName(w, r)}: "everything is down"`, `${custName(w, r)}: "total outage. escalating to my CEO."`] }),
    hints: (w, r) => ['All servers of one customer on one switch at once: think VLAN, not port.', `Look at the VLAN table on ${D(w, r.dev).hostname}.`, `Recreate VLAN ${r.vlan} (${r.name}).`],
    ops: (w, r) => [{ op: 'createVlan', dev: r.dev, vlan: r.vlan, name: r.name }],
  },
  {
    id: 'trunk-prune', tier: 2, cat: 'config', sev: 1, name: 'Customer VLAN removed from an uplink trunk',
    targets: (w) => uplinks(w).flatMap((l) => [l.a, l.b].map((e) => ({ dev: D(w, e.dev), if: e.if, link: l }))).filter((t) => {
      const i = ifOf(w, t.dev.id, t.if);
      return i?.sw?.mode === 'trunk' && Array.isArray(i.sw.allowed) && i.sw.allowed.some((v) => custOfVlan(w, v)) && !['aoss', 'junos', 'evo'].includes(t.dev.os) && t.dev.role === 'access';
    }),
    inject(w, t, R) {
      const i = ifOf(w, t.dev.id, t.if);
      const vs = i.sw.allowed.filter((v) => custOfVlan(w, v));
      const v = R.pick(vs);
      // with two cores the access switch has two uplinks: prune both so it is an outage
      const touched = [];
      for (const l of uplinks(w)) for (const e of [l.a, l.b]) {
        const x = ifOf(w, e.dev, e.if);
        if (e.dev === t.dev.id && x?.sw?.mode === 'trunk' && Array.isArray(x.sw.allowed) && x.sw.allowed.includes(v)) {
          x.sw.allowed = x.sw.allowed.filter((y) => y !== v);
          touched.push(e.if);
        }
      }
      return { dev: t.dev.id, ifs: touched, vlan: v, cust: custOfVlan(w, v)?.id };
    },
    fixed: (w, r) => r.ifs.every((n) => {
      const sw = ifOf(w, r.dev, n)?.sw;
      return sw && (sw.allowed === 'all' || sw.allowed.includes(r.vlan));
    }),
    rca: (w, r) => ({ dev: r.dev, cat: 'config', keys: ['trunk', 'allowed', 'vlan', String(r.vlan), 'pruned'] }),
    ticket: (w, r) => ({ title: `${custName(w, r)}: total outage`, text: [`Monitoring: all ${custName(w, r)} servers on ${D(w, r.dev).hostname} lost their gateway. Other customers on the same switch are fine.`, `${custName(w, r)} reports a total outage.`, `${custName(w, r)}: "nothing loads"`, `${custName(w, r)}: "we pay for 99.9%. this is not 99.9%."`] }),
    hints: (w, r) => ['Other customers on the same switch work: the uplink is fine, one VLAN is not crossing it.', `Check which VLANs are allowed on the trunk(s) on ${D(w, r.dev).hostname} ${r.ifs.join(', ')}.`, `Add VLAN ${r.vlan} back to the allowed list (add, don't replace!).`],
    ops: (w, r) => r.ifs.map((n) => ({ op: 'trunkAdd', dev: r.dev, if: n, vlan: r.vlan })),
  },
  {
    id: 'bpdu-rogue', tier: 2, cat: 'physical', sev: 2, name: 'Customer plugged in a switch: BPDU guard err-disabled the port',
    targets: (w) => serverPorts(w).filter((p) => ifOf(w, p.dev.id, p.if).stp?.bpduguard && !p.h.rogueSwitch),
    inject(w, t) {
      t.h.rogueSwitch = true;
      return { dev: t.dev.id, if: t.if, host: t.h.id, cust: t.cust?.id };
    },
    fixed: (w, r) => !H(w, r.host).rogueSwitch && !D(w, r.dev).run.errdis[r.if] && ifOf(w, r.dev, r.if).on,
    rca: (w, r) => ({ dev: r.dev, cat: 'physical', keys: ['bpdu', 'err-disabled', 'errdisable', 'rogue', 'switch', 'guard'] }),
    ticket: (w, r) => ({ title: `${H(w, r.host).name} offline`, text: [`Monitoring: ${D(w, r.dev).hostname} ${r.if} is err-disabled. ${custName(w, r)}'s engineer visited the cage today.`, `${custName(w, r)}: "we added a little switch for our new server and now nothing works"`, `${custName(w, r)}: "server offline since our visit"`, `${custName(w, r)}: "our server is down, we didn't touch anything"`] }),
    hints: (w, r) => [`Check the port status on ${D(w, r.dev).hostname}: err-disabled ports say why in the logs.`, `Remove the unknown device from ${H(w, r.host).name}'s cable (rack view).`, `Bounce ${r.if} (shutdown / no shutdown) to recover it from err-disable.`],
    ops: (w, r) => [{ op: 'phys', action: 'remove-rogue', host: r.host }, { op: 'ifBounce', dev: r.dev, if: r.if }],
  },
  {
    id: 'duplex-mismatch', tier: 2, cat: 'config', sev: 3, name: 'Speed/duplex hard-coded on one side',
    targets: (w) => serverPorts(w).filter((p) => ifOf(w, p.dev.id, p.if).speed === 'auto' && (ifOf(w, p.dev.id, p.if).hw?.speed || 1000) >= 100 && !['fortiswitch'].includes(p.dev.os)),
    inject(w, t) {
      Object.assign(ifOf(w, t.dev.id, t.if), { speed: 100, duplex: 'full' });
      return { dev: t.dev.id, if: t.if, host: t.h.id, cust: t.cust?.id, link: t.link.id };
    },
    fixed: (w, r) => {
      recompute(w);
      return w.sim.links[r.link]?.duplex !== 'mismatch';
    },
    rca: (w, r) => ({ dev: r.dev, cat: 'config', keys: ['duplex', 'speed', 'mismatch', 'auto', 'negotiation', 'collisions'] }),
    ticket: (w, r) => ({ title: `${custName(w, r)}: slow website`, text: [`Monitoring: 8% packet loss to ${H(w, r.host).name}; ${D(w, r.dev).hostname} ${r.if} counts late collisions.`, `${custName(w, r)} reports their site is very slow and uploads fail.`, `${custName(w, r)}: "site is crawling"`, `${custName(w, r)}: "it's slow. not down, just... slow. sometimes."`] }),
    hints: (w, r) => ['Packet loss on one host only, with CRC/late collisions on its port: duplex.', `Compare ${D(w, r.dev).hostname} ${r.if} speed/duplex with ethtool eth0 on the server.`, `Set ${r.if} back to auto speed and duplex.`],
    ops: (w, r) => [{ op: 'duplexAuto', dev: r.dev, if: r.if }],
  },
  {
    id: 'svi-shutdown', tier: 2, cat: 'config', sev: 1, name: 'Customer gateway interface shut down',
    targets: (w) => custSvis(w).filter((t) => t.dev.cfg.ifs[t.if].on && t.dev.role === 'core'),
    inject(w, t) {
      const devs = custSvis(w).filter((x) => x.vlan === t.vlan);
      for (const x of devs) x.dev.cfg.ifs[x.if].on = false;
      return { devs: devs.map((x) => ({ dev: x.dev.id, if: x.if })), vlan: t.vlan, cust: t.cust.id, dev: t.dev.id, if: t.if };
    },
    fixed: (w, r) => r.devs.every((x) => ifOf(w, x.dev, x.if)?.on),
    rca: (w, r) => ({ dev: r.dev, cat: 'config', keys: ['svi', 'gateway', 'shutdown', `vlan${r.vlan}`, String(r.vlan), 'irb', 'interface vlan'] }),
    ticket: (w, r) => ({ title: `${custName(w, r)}: cannot reach gateway`, text: [`Monitoring: ${custName(w, r)} servers cannot reach their gateway ${vlanNet(w, r.vlan)}.1; the layer 2 path is fine.`, `${custName(w, r)} reports their servers have no internet.`, `${custName(w, r)}: "can't get out"`, `${custName(w, r)}: "is the internet down?"`] }),
    hints: (w, r) => [`Servers can reach each other but not the gateway ${vlanNet(w, r.vlan)}.1.`, `Check the VLAN ${r.vlan} gateway interface on the core switch(es).`, 'Bring the gateway interface(s) back up.'],
    ops: (w, r) => r.devs.map((x) => ({ op: 'ifUp', dev: x.dev, if: x.if })),
  },
  {
    id: 'server-wrong-gw', tier: 2, cat: 'server', sev: 2, name: 'Server default gateway typo',
    targets: (w) => serverPorts(w).filter((p) => p.h.gw).map((p) => ({ h: p.h, cust: p.cust })),
    inject(w, t) {
      const good = t.h.gw;
      t.h.gw = good.replace(/\.\d+$/, '.254');
      return { host: t.h.id, good, bad: t.h.gw, cust: t.cust?.id };
    },
    fixed: (w, r) => H(w, r.host).gw === r.good,
    rca: (w, r) => ({ dev: r.host, cat: 'server', keys: ['gateway', 'default route', r.bad, 'typo'] }),
    ticket: (w, r) => ({ title: `${H(w, r.host).name} unreachable after reboot`, text: [`Monitoring: ${H(w, r.host).name} unreachable from other subnets; reachable from its own VLAN. Customer rebuilt the server last night.`, `${custName(w, r)}: "we rebuilt ${H(w, r.host).name} and now it can't reach anything"`, `${custName(w, r)}: "server is up but unreachable"`, `${custName(w, r)}: "your network ate our server"`] }),
    hints: (w, r) => ['Reachable from its own VLAN only: check the host\'s default route.', `console ${H(w, r.host).name}, then ip route`, `ip route replace default via ${r.good}`],
    ops: (w, r) => [{ op: 'server', host: r.host, cmds: [`ip route replace default via ${r.good}`] }],
  },
  {
    id: 'static-route-typo', tier: 2, cat: 'routing', sev: 1, name: 'Static default route points at the wrong next hop',
    targets: (w) => (w.design.routing === 'static' ? [...roleDevs(w, 'core'), ...fws(w)].filter((d) => d.cfg.static.some((r) => r.pfx === '0.0.0.0/0' && r.nh)).map((dev) => ({ dev })) : []),
    inject(w, t) {
      const r = t.dev.cfg.static.find((x) => x.pfx === '0.0.0.0/0' && x.nh);
      const good = r.nh;
      r.nh = good.replace(/\.(\d+)$/, (m, n) => `.${(Number(n) + 100) % 250}`);
      return { dev: t.dev.id, good, bad: r.nh };
    },
    fixed: (w, r) => D(w, r.dev).cfg.static.some((x) => x.pfx === '0.0.0.0/0' && x.nh === r.good) && !D(w, r.dev).cfg.static.some((x) => x.pfx === '0.0.0.0/0' && x.nh === r.bad),
    rca: (w, r) => ({ dev: r.dev, cat: 'routing', keys: ['static', 'default', 'route', 'next-hop', 'next hop', r.bad] }),
    ticket: () => ({ title: 'All customers: no internet', text: ['Monitoring: every customer has lost internet access; internal traffic is fine. A change to routing was made last night.', 'Many customers report no internet access.', 'Phones ringing off the hook: "internet down"', 'Everyone: "INTERNET IS DOWN"'] }),
    hints: (w, r) => ['Internal works, internet does not: follow the default route hop by hop (traceroute).', `Check the default route on ${D(w, r.dev).hostname}: is the next hop reachable?`, `Point the default route at ${r.good}.`],
    ops: (w, r) => [{ op: 'staticFix', dev: r.dev, pfx: '0.0.0.0/0', bad: r.bad, good: r.good }],
  },
  {
    id: 'dhcp-relay-missing', tier: 2, cat: 'config', sev: 3, name: 'DHCP relay (helper) missing on the Wi-Fi gateway',
    targets: (w) => (w.design.office.on ? roleDevs(w, 'core').map((dev) => ({ dev, if: Object.keys(dev.cfg.ifs).find((n) => dev.cfg.ifs[n].kind === 'svi' && dev.cfg.ifs[n].vlan === OFFICE.wifi && dev.cfg.ifs[n].helper?.length) })).filter((t) => t.if) : []),
    inject(w, t) {
      const devs = roleDevs(w, 'core').map((d) => ({ d, n: Object.keys(d.cfg.ifs).find((n) => d.cfg.ifs[n].kind === 'svi' && d.cfg.ifs[n].vlan === OFFICE.wifi) })).filter((x) => x.n);
      for (const x of devs) x.d.cfg.ifs[x.n].helper = [];
      return { devs: devs.map((x) => ({ dev: x.d.id, if: x.n })), dev: t.dev.id, if: t.if };
    },
    fixed: (w, r) => r.devs.every((x) => ifOf(w, x.dev, x.if)?.helper?.includes(SVC.dhcp)),
    rca: (w, r) => ({ dev: r.dev, cat: 'config', keys: ['dhcp', 'relay', 'helper', 'ip helper-address'] }),
    ticket: () => ({ title: 'Office Wi-Fi: connected, no internet', text: ['Monitoring: Wi-Fi clients associate and authenticate but get 169.254.x.x addresses.', 'Staff: "Wi-Fi says connected, no internet"', 'Staff: "Wi-Fi broken"', 'CEO: "fix the wifi."'] }),
    hints: () => ['Clients authenticate but get APIPA addresses: DHCP is not reaching them.', `The DHCP server (${SVC.dhcp}) is in another subnet: the gateway must relay.`, `Add the DHCP relay/helper ${SVC.dhcp} on the Wi-Fi VLAN gateway.`],
    ops: (w, r) => r.devs.map((x) => ({ op: 'helper', dev: x.dev, if: x.if, ip: SVC.dhcp })),
  },
  {
    id: 'optic-dirty', tier: 2, cat: 'physical', sev: 3, name: 'Dirty fibre connector (low receive power)',
    targets: (w) => fiberPorts(w).filter((t) => !t.dev.hw.optics[t.if]),
    inject(w, t) {
      t.dev.hw.optics[t.if] = { rx: -12.9 };
      return { dev: t.dev.id, if: t.if, link: t.link.id };
    },
    fixed: (w, r) => !(D(w, r.dev).hw.optics[r.if]?.rx < -10.5),
    rca: (w, r) => ({ dev: r.dev, cat: 'physical', keys: ['optic', 'fibre', 'fiber', 'rx power', 'dirty', 'crc', 'light'] }),
    ticket: (w, r) => ({ title: 'Intermittent packet loss', text: [`Monitoring: ~17% loss across ${D(w, r.dev).hostname} ${r.if}; CRC errors incrementing.`, 'Several customers report intermittent timeouts.', 'Customers: "it keeps dropping"', 'A customer: "flaky. sometimes fine, sometimes not."'] }),
    hints: (w, r) => ['Loss without a down link: look for interface errors (CRC) and optical levels.', `Check the optics/transceiver receive power on ${D(w, r.dev).hostname} ${r.if}.`, 'Clean (or replace) the optic in the rack view.'],
    ops: (w, r) => [{ op: 'phys', action: 'clean-optic', dev: r.dev, if: r.if }],
  },
  {
    id: 'native-mismatch', tier: 3, cat: 'config', sev: 1, name: 'Native VLAN mismatch on a trunk',
    targets: (w) => uplinks(w).map((l) => ({ dev: D(w, l.a.dev), if: l.a.if, peer: l.b, link: l })).filter((t) => {
      const i = ifOf(w, t.dev.id, t.if);
      return t.dev.role === 'access' && i?.sw?.mode === 'trunk' && Array.isArray(i.sw.allowed) && i.sw.allowed.some((v) => custOfVlan(w, v)) && !['aoss', 'fortiswitch'].includes(t.dev.os) && roleDevs(w, 'core').length === 1;
    }),
    inject(w, t) {
      const i = ifOf(w, t.dev.id, t.if);
      const v = i.sw.allowed.find((x) => custOfVlan(w, x));
      i.sw.native = v;
      return { dev: t.dev.id, if: t.if, vlan: v, cust: custOfVlan(w, v)?.id };
    },
    fixed: (w, r) => (ifOf(w, r.dev, r.if).sw?.native ?? 1) !== r.vlan,
    rca: (w, r) => ({ dev: r.dev, cat: 'config', keys: ['native', 'vlan', 'trunk', 'mismatch', String(r.vlan)] }),
    ticket: (w, r) => ({ title: `${custName(w, r)}: outage`, text: [`Monitoring: ${custName(w, r)} servers on ${D(w, r.dev).hostname} lost connectivity; CDP/LLDP logs mention VLAN mismatches.`, `${custName(w, r)} reports an outage.`, `${custName(w, r)}: "down"`, `${custName(w, r)}: "your stuff broke our stuff"`] }),
    hints: (w, r) => ['Read the switch logs: neighbours complain about mismatches.', `Compare the native VLAN on both ends of ${D(w, r.dev).hostname} ${r.if}.`, `Set the native VLAN on ${r.if} back to 1.`],
    ops: (w, r) => [{ op: 'native', dev: r.dev, if: r.if, vlan: 1 }],
  },
  {
    id: 'ospf-hello', tier: 3, cat: 'routing', sev: 1, name: 'OSPF hello/dead timer mismatch',
    targets: (w) => transitOspf(w).map((l) => ({ dev: D(w, l.a.dev), if: l.a.if, link: l })).filter((t) => !['asa'].includes(t.dev.os)),
    inject(w, t) {
      Object.assign(ifOf(w, t.dev.id, t.if).ospf, { hello: 30, dead: 120 });
      return { dev: t.dev.id, if: t.if };
    },
    fixed: (w, r) => {
      const o = ifOf(w, r.dev, r.if).ospf;
      return o && (o.hello ?? 10) === 10 && (o.dead ?? 40) === 40;
    },
    rca: (w, r) => ({ dev: r.dev, cat: 'routing', keys: ['ospf', 'hello', 'dead', 'timer', 'interval', 'adjacency'] }),
    ticket: () => ({ title: 'Routing outage', text: ['Monitoring: an OSPF adjacency is down and routes have disappeared. A "tuning" change was applied last night.', 'Multiple customers report outages.', 'Customers: "nothing works"', 'NOC: "it was working yesterday"'] }),
    hints: (w, r) => ['Find which OSPF neighbour is missing (compare both ends).', `The interface is up but the neighbour never forms: compare OSPF timers on ${D(w, r.dev).hostname} ${r.if} with its peer.`, 'Put hello/dead back to 10/40.'],
    ops: (w, r) => [{ op: 'ospfTimers', dev: r.dev, if: r.if }],
  },
  {
    id: 'ospf-area', tier: 3, cat: 'routing', sev: 1, name: 'OSPF area mismatch',
    targets: (w) => transitOspf(w).map((l) => ({ dev: D(w, l.b.dev), if: l.b.if, link: l })),
    inject(w, t) {
      ifOf(w, t.dev.id, t.if).ospf.area = '0.0.0.1';
      return { dev: t.dev.id, if: t.if };
    },
    fixed: (w, r) => ifOf(w, r.dev, r.if).ospf?.area === '0.0.0.0',
    rca: (w, r) => ({ dev: r.dev, cat: 'routing', keys: ['ospf', 'area', 'mismatch'] }),
    ticket: () => ({ title: 'Routing outage', text: ['Monitoring: OSPF adjacency lost after a change; logs mention mismatched area.', 'Customers report outages.', 'Customers: "down"', 'NOC: "the routing broke"'] }),
    hints: (w, r) => ['Look for OSPF errors in the logs of both neighbours.', `Check the OSPF area on ${D(w, r.dev).hostname} ${r.if}.`, 'Put the interface back in area 0.'],
    ops: (w, r) => [{ op: 'ospfArea', dev: r.dev, if: r.if, area: '0.0.0.0' }],
  },
  {
    id: 'ospf-mtu', tier: 3, cat: 'routing', sev: 1, name: 'MTU mismatch: OSPF stuck in EXSTART',
    targets: (w) => transitOspf(w).map((l) => ({ dev: D(w, l.a.dev), if: l.a.if, link: l })).filter((t) => !['aoss', 'arubaos'].includes(t.dev.os)),
    inject(w, t) {
      ifOf(w, t.dev.id, t.if).mtu = 9000;
      return { dev: t.dev.id, if: t.if };
    },
    fixed: (w, r) => (ifOf(w, r.dev, r.if).mtu ?? 1500) === 1500,
    rca: (w, r) => ({ dev: r.dev, cat: 'routing', keys: ['mtu', 'exstart', 'ospf', 'jumbo'] }),
    ticket: () => ({ title: 'Routing outage after jumbo frame change', text: ['Monitoring: OSPF neighbour stuck in EXSTART/EXCHANGE after jumbo frames were enabled on one link.', 'Customers report outages after maintenance.', 'Customers: "down since your maintenance"', 'NOC: "OSPF looks up?? but no routes"'] }),
    hints: (w, r) => ['A neighbour that never gets past EXSTART usually means an MTU mismatch.', `Compare the MTU on ${D(w, r.dev).hostname} ${r.if} with its neighbour.`, 'Set the MTU back to 1500 (or match both sides).'],
    ops: (w, r) => [{ op: 'mtu', dev: r.dev, if: r.if, mtu: 1500 }],
  },
  {
    id: 'ospf-passive', tier: 3, cat: 'routing', sev: 1, name: 'Transit interface made OSPF passive',
    targets: (w) => transitOspf(w).map((l) => ({ dev: D(w, l.b.dev), if: l.b.if, link: l })).filter((t) => !ifOf(w, t.dev.id, t.if).ospf.passive),
    inject(w, t) {
      ifOf(w, t.dev.id, t.if).ospf.passive = true;
      return { dev: t.dev.id, if: t.if };
    },
    fixed: (w, r) => !ifOf(w, r.dev, r.if).ospf?.passive,
    rca: (w, r) => ({ dev: r.dev, cat: 'routing', keys: ['passive', 'ospf', 'hello'] }),
    ticket: () => ({ title: 'Routing outage', text: ['Monitoring: OSPF adjacency down after "passive-interface default" was added.', 'Customers report outages.', 'Customers: "down"', 'NOC: "someone was hardening the routers..."'] }),
    hints: (w, r) => ['A passive interface sends no hellos.', `Check whether ${D(w, r.dev).hostname} ${r.if} is passive.`, 'Make the transit interface non-passive again.'],
    ops: (w, r) => [{ op: 'ospfPassiveOff', dev: r.dev, if: r.if }],
  },
  {
    id: 'lacp-mismatch', tier: 3, cat: 'config', sev: 3, service: false, name: 'Port-channel mode mismatch (static vs LACP)',
    targets: (w) => roleDevs(w, 'core').filter((d) => Object.values(d.cfg.ifs).some((i) => i.lag?.mode === 'active') && !['aoss', 'fortiswitch'].includes(d.os)).map((dev) => ({ dev })),
    inject(w, t) {
      const mem = Object.keys(t.dev.cfg.ifs).filter((n) => t.dev.cfg.ifs[n].lag?.mode === 'active');
      for (const n of mem) t.dev.cfg.ifs[n].lag.mode = 'on';
      return { dev: t.dev.id, ifs: mem, lag: t.dev.cfg.ifs[mem[0]].lag.id };
    },
    fixed: (w, r) => r.ifs.every((n) => ['active', 'passive'].includes(ifOf(w, r.dev, n).lag?.mode)),
    rca: (w, r) => ({ dev: r.dev, cat: 'config', keys: ['lacp', 'port-channel', 'lag', 'mode', 'suspended', 'bundle'] }),
    ticket: (w, r) => ({ title: `Redundancy lost: ${D(w, r.dev).hostname} inter-switch link down`, text: [`Monitoring: the port-channel between the core switches is down; members suspended.`, 'Monitoring: core redundancy degraded.', 'Alarm: port-channel down.', 'Alarm: something about bundles.'] }),
    hints: (w, r) => ['Members "suspended" means the two ends disagree about LACP.', `Compare the channel mode on ${D(w, r.dev).hostname} with its peer.`, 'Set the members back to LACP active.'],
    ops: (w, r) => [{ op: 'lagMode', dev: r.dev, ifs: r.ifs, id: r.lag, mode: 'active' }],
  },
  {
    id: 'fw-policy-disabled', tier: 3, cat: 'security', sev: 1, name: 'Firewall rule for a customer website removed/disabled',
    targets: (w) => fws(w).flatMap((fw) => w.design.customers.filter((c) => c.web && !c.pending && (fw.os === 'asa' ? (fw.cfg.acls.OUTSIDE_IN || []).some((e) => e.cust === c.id) : fw.cfg.fw.pol.some((p) => p.cust === c.id && p.on))).map((c) => ({ dev: fw, cust: c }))),
    inject(w, t) {
      const fw = t.dev.cfg.fw;
      if (t.dev.os === 'asa') {
        const list = t.dev.cfg.acls.OUTSIDE_IN || [];
        const idx = list.findIndex((e) => e.cust === t.cust.id);
        const [e] = list.splice(idx, 1);
        return { dev: t.dev.id, cust: t.cust.id, ace: e };
      }
      const p = fw.pol.find((x) => x.cust === t.cust.id);
      p.on = false;
      return { dev: t.dev.id, cust: t.cust.id, pol: p.id, name: p.name };
    },
    fixed: (w, r) => {
      recompute(w);
      const c = checks(w).find((x) => x.id === `web:${r.cust}`);
      return !!c?.ok;
    },
    rca: (w, r) => ({ dev: r.dev, cat: 'security', keys: ['policy', 'rule', 'access-list', 'acl', 'disabled', 'firewall', r.name || 'outside_in'] }),
    ticket: (w, r) => ({ title: `${custName(w, r)} website unreachable from the internet`, text: [`Monitoring: HTTPS to ${custVip(w, r)} times out from the internet; the server is fine internally. The security team "cleaned up unused rules" yesterday.`, `${custName(w, r)}: "customers can't reach our website, but it works from inside your network"`, `${custName(w, r)}: "website down"`, `${custName(w, r)}: "is it DNS? it's always DNS"`] }),
    hints: (w, r) => ['Works inside, fails from outside: follow the path through the firewall.', `Use the firewall's packet trace (packet-tracer / diagnose debug flow / show security policies) for ${custVip(w, r)}:443.`, 'Restore the permit rule for the customer website.'],
    ops: (w, r) => [{ op: 'fwPermit', dev: r.dev, cust: r.cust, ace: r.ace, pol: r.pol, name: r.name }],
  },
  {
    id: 'vip-wrong', tier: 3, cat: 'security', sev: 1, name: 'Static NAT/VIP points at the old server',
    targets: (w) => [...fws(w), ...(fws(w).length ? [] : roleDevs(w, 'edge').filter((e) => e.cfg.nat?.statics?.length))].flatMap((dev) => w.design.customers.filter((c) => c.web && !c.pending && (dev.cfg.fw?.vip?.some((x) => x.cust === c.id) || dev.cfg.nat?.statics?.some((x) => x.cust === c.id))).map((c) => ({ dev, cust: c }))),
    inject(w, t) {
      const web = H(w, w.design.customers.find((c) => c.id === t.cust.id).servers[0]);
      const bad = web.ip.replace(/\.(\d+)$/, '.99');
      const v = t.dev.cfg.fw?.vip?.find((x) => x.cust === t.cust.id) || t.dev.cfg.nat?.statics?.find((x) => x.cust === t.cust.id);
      v.int = bad;
      if (t.dev.os === 'asa') for (const e of t.dev.cfg.acls.OUTSIDE_IN || []) if (e.cust === t.cust.id && e.dst === `${web.ip}/32`) e.dst = `${bad}/32`;
      return { dev: t.dev.id, cust: t.cust.id, good: web.ip, bad };
    },
    fixed: (w, r) => {
      recompute(w);
      return !!checks(w).find((x) => x.id === `web:${r.cust}`)?.ok;
    },
    rca: (w, r) => ({ dev: r.dev, cat: 'security', keys: ['nat', 'vip', 'static', 'mapped', r.bad, 'translation'] }),
    ticket: (w, r) => ({ title: `${custName(w, r)} website down after server migration`, text: [`Monitoring: inbound HTTPS to ${custVip(w, r)} is translated to ${r.bad}, which no longer exists. ${custName(w, r)} migrated to a new server last week.`, `${custName(w, r)}: "we moved to a new server and now the website is down from outside"`, `${custName(w, r)}: "site unreachable"`, `${custName(w, r)}: "worked fine before the migration, so it must be you"`] }),
    hints: (w, r) => ['Check what the public address is translated to.', `Look at the NAT/VIP for ${custVip(w, r)} on ${D(w, r.dev).hostname}.`, `Map ${custVip(w, r)} to ${r.good}.`],
    ops: (w, r) => [{ op: 'vipFix', dev: r.dev, cust: r.cust, good: r.good, bad: r.bad }],
  },
  {
    id: 'snat-disabled', tier: 3, cat: 'security', sev: 1, name: 'Outbound NAT disabled',
    targets: (w) => (w.design.customers.some((c) => c.servers.length > 1) ? (fws(w).length ? fws(w) : roleDevs(w, 'edge').filter((e) => e.cfg.nat?.overload)).map((dev) => ({ dev })) : []),
    inject(w, t) {
      if (t.dev.cfg.fw?.pol?.length || t.dev.os === 'asa') {
        if (t.dev.os === 'fortios') for (const p of t.dev.cfg.fw.pol) if (p.to === 'outside') p.nat = false;
        t.dev.cfg.fw.snat.forEach((x) => (x.on = false));
      } else t.dev.cfg.nat.overload = false;
      return { dev: t.dev.id };
    },
    fixed: (w) => {
      recompute(w);
      return checks(w).filter((x) => x.kind === 'out').every((x) => x.ok);
    },
    rca: (w, r) => ({ dev: r.dev, cat: 'security', keys: ['nat', 'snat', 'overload', 'pat', 'source nat', 'translation'] }),
    ticket: () => ({ title: 'Customers cannot reach the internet', text: ['Monitoring: outbound connections from customer servers fail; ISP reports packets with private source addresses being dropped.', 'Several customers: servers cannot download updates.', 'Customers: "no internet from our servers"', 'Customer: "apt update hangs"'] }),
    hints: () => ['Traceroute from a server dies right after your edge: the ISP drops private (RFC 1918) sources.', 'Check the source NAT / PAT configuration on the firewall or edge router.', 'Re-enable source NAT (PAT to the outside interface).'],
    ops: (w, r) => [{ op: 'natEnable', dev: r.dev }],
  },
  {
    id: 'acl-web-block', tier: 3, cat: 'security', sev: 1, name: 'ACL on the customer gateway blocks HTTPS',
    targets: (w) => custSvis(w).filter((t) => t.dev.role === 'core' && hasOs(t.dev, 'ios', 'iosxe', 'nxos') && t.cust.web && roleDevs(w, 'core').length === 1),
    inject(w, t) {
      const web = H(w, t.cust.servers[0]);
      t.dev.cfg.acls[`CUST-${t.cust.slug.toUpperCase()}-OUT`] = [{ act: 'deny', proto: 'tcp', src: 'any', dst: `${web.ip}/32`, dport: 443 }, { act: 'permit', proto: 'ip', src: 'any', dst: 'any' }];
      t.dev.cfg.ifs[t.if].acl.out = `CUST-${t.cust.slug.toUpperCase()}-OUT`;
      return { dev: t.dev.id, if: t.if, cust: t.cust.id, acl: `CUST-${t.cust.slug.toUpperCase()}-OUT` };
    },
    fixed: (w, r) => {
      recompute(w);
      return !!checks(w).find((x) => x.id === `web:${r.cust}`)?.ok;
    },
    rca: (w, r) => ({ dev: r.dev, cat: 'security', keys: ['acl', 'access-list', 'access-group', r.acl.toLowerCase(), '443', 'deny'] }),
    ticket: (w, r) => ({ title: `${custName(w, r)}: website down, ping works`, text: [`Monitoring: ${custVip(w, r)} answers ping but HTTPS times out. An ACL was applied to the VLAN gateway for "PCI compliance".`, `${custName(w, r)}: "website times out but we can ping it"`, `${custName(w, r)}: "https broken"`, `${custName(w, r)}: "the site is up, our monitoring says so, but nobody can load it"`] }),
    hints: (w, r) => ['Ping works but one port does not: think filtering.', `Check access lists applied to ${D(w, r.dev).hostname} ${r.if}.`, `Remove ${r.acl} from the interface (or permit 443).`],
    ops: (w, r) => [{ op: 'aclRemove', dev: r.dev, if: r.if, dir: 'out', acl: r.acl }],
  },
  {
    id: 'no-ip-routing', tier: 3, cat: 'routing', sev: 1, name: '"no ip routing" on the core',
    targets: (w) => roleDevs(w, 'core').filter((d) => hasOs(d, 'ios', 'iosxe') && roleDevs(w, 'core').length === 1).map((dev) => ({ dev })),
    inject(w, t) {
      t.dev.cfg.noRouting = true;
      return { dev: t.dev.id };
    },
    fixed: (w, r) => !D(w, r.dev).cfg.noRouting,
    rca: (w, r) => ({ dev: r.dev, cat: 'routing', keys: ['ip routing', 'routing', 'disabled'] }),
    ticket: () => ({ title: 'Everything is down', text: ['Monitoring: the core no longer routes between VLANs (an engineer pasted a template for an access switch onto the core).', 'All customers report outages.', 'Everyone: "down"', 'CEO: "WHAT HAPPENED"'] }),
    hints: (w, r) => ['Inter-VLAN routing stopped everywhere at once: check the core itself.', `Look at the routing table on ${D(w, r.dev).hostname}.`, 'Turn IP routing back on.'],
    ops: (w, r) => [{ op: 'ipRouting', dev: r.dev }],
  },
  {
    id: 'stp-loop', tier: 4, cat: 'physical', sev: 1, name: 'Second uplink cable + STP disabled = broadcast storm',
    targets: (w) => roleDevs(w, 'access').filter((a) => roleDevs(w, 'core').length === 1 && !['junos', 'evo', 'aoss', 'fortiswitch'].includes(a.os) && !['junos', 'evo', 'aoss', 'fortiswitch'].includes(roleDevs(w, 'core')[0].os) && freePort(w, a) && freePort(w, roleDevs(w, 'core')[0])).map((dev) => ({ dev, core: roleDevs(w, 'core')[0] })),
    inject(w, t) {
      const pa = freePort(w, t.dev);
      const pc = freePort(w, t.core);
      const up0 = uplinks(w).find((l) => l.a.dev === t.dev.id && l.b.dev === t.core.id);
      const tpl = ifOf(w, t.dev.id, up0.a.if).sw;
      Object.assign(t.dev.cfg.ifs[pa], { on: true, sw: JSON.parse(JSON.stringify(tpl)), desc: '' });
      Object.assign(t.core.cfg.ifs[pc], { on: true, sw: JSON.parse(JSON.stringify(ifOf(w, t.core.id, up0.b.if).sw)), desc: '' });
      const id = `Lloop${w.time.t | 0}`;
      w.links.push({ id, a: { dev: t.dev.id, if: pa }, b: { dev: t.core.id, if: pc }, cable: { ok: true, type: 'cat6', id: 'C-UNKNOWN' }, purpose: 'uplink', rogue: true });
      t.dev.cfg.stp.on = false;
      t.core.cfg.stp.on = false;
      return { dev: t.dev.id, core: t.core.id, link: id };
    },
    fixed: (w, r) => !w.links.some((l) => l.id === r.link) || (D(w, r.dev).cfg.stp.on && D(w, r.core).cfg.stp.on),
    rca: (w, r) => ({ dev: r.dev, cat: 'physical', keys: ['loop', 'spanning-tree', 'stp', 'storm', 'broadcast', 'cable'] }),
    ticket: () => ({ title: 'Massive packet loss everywhere', text: ['Monitoring: switch CPUs at 100%, MAC flapping logged, ~85% loss. Spanning tree was disabled "temporarily" and someone added a second uplink cable.', 'Every customer reports severe packet loss.', 'Customers: "everything is crawling"', 'NOC: "the lights on the switches are all blinking like crazy"'] }),
    hints: () => ['MAC flapping + high CPU + everything slow = layer 2 loop.', 'Look for two links between the same pair of switches and check spanning-tree status.', 'Remove the extra cable or re-enable spanning tree.'],
    ops: (w, r) => [{ op: 'stpEnable', dev: r.dev }, { op: 'stpEnable', dev: r.core }],
  },
  {
    id: 'bgp-shutdown', tier: 3, cat: 'routing', sev: 1, name: 'BGP neighbour administratively shut down',
    targets: (w) => (bgpEdges(w).length === 1 ? bgpEdges(w) : []).map((dev) => ({ dev })),
    inject(w, t) {
      for (const n of t.dev.cfg.bgp.nbrs) n.shut = true;
      return { dev: t.dev.id, ips: t.dev.cfg.bgp.nbrs.map((n) => n.ip) };
    },
    fixed: (w, r) => D(w, r.dev).cfg.bgp.nbrs.filter((n) => r.ips.includes(n.ip)).every((n) => !n.shut),
    rca: (w, r) => ({ dev: r.dev, cat: 'routing', keys: ['bgp', 'shutdown', 'neighbor', 'neighbour', 'admin'] }),
    ticket: () => ({ title: 'No internet', text: ['Monitoring: BGP session to the ISP is Idle (Admin). Someone was "testing failover".', 'All customers report no internet.', 'Everyone: "internet down"', 'ISP: "we see no session from you"'] }),
    hints: (w, r) => ['Check the BGP summary on the edge.', 'Idle (Admin) means it was shut down locally.', `Re-enable the neighbour(s) on ${D(w, r.dev).hostname}.`],
    ops: (w, r) => r.ips.map((ip) => ({ op: 'bgpNoShut', dev: r.dev, ip })),
  },
  {
    id: 'bgp-remote-as', tier: 4, cat: 'routing', sev: 1, name: 'BGP remote-AS typo',
    targets: (w) => (bgpEdges(w).length === 1 ? bgpEdges(w) : []).map((dev) => ({ dev })),
    inject(w, t) {
      const n = t.dev.cfg.bgp.nbrs[0];
      const good = n.ras;
      n.ras = Number(String(good).split('').reverse().join('')) === good ? good + 10 : Number(String(good).split('').reverse().join(''));
      return { dev: t.dev.id, ip: n.ip, good, bad: n.ras };
    },
    fixed: (w, r) => D(w, r.dev).cfg.bgp.nbrs.find((n) => n.ip === r.ip)?.ras === r.good,
    rca: (w, r) => ({ dev: r.dev, cat: 'routing', keys: ['bgp', 'remote-as', 'as', 'peer-as', String(r.bad), 'notification'] }),
    ticket: () => ({ title: 'No internet after ISP re-provisioning', text: ['Monitoring: BGP session flaps with OPEN errors (bad peer AS) since an engineer re-typed the neighbour config.', 'All customers: no internet.', 'Everyone: "down"', 'ISP: "your router keeps sending us NOTIFICATIONs"'] }),
    hints: (w, r) => ['Read the BGP notification in the logs.', `"Bad Peer AS": compare the configured remote AS with the ISP's AS (Docs > IPAM / ISP contract: AS${r.good}).`, `Set the remote AS to ${r.good}.`],
    ops: (w, r) => [{ op: 'bgpRemoteAs', dev: r.dev, ip: r.ip, as: r.good, bad: r.bad }],
  },
  {
    id: 'bgp-maxpfx', tier: 4, cat: 'routing', sev: 1, name: 'ISP sends full table; tight maximum-prefix tears the session down',
    targets: (w) => (bgpEdges(w).length === 1 ? bgpEdges(w) : []).map((dev) => ({ dev })),
    inject(w, t) {
      const n = t.dev.cfg.bgp.nbrs[0];
      n.maxpfx = 1000;
      const isp = Object.values(w.hosts).find((h) => h.kind === 'isp' && h.ip === n.ip);
      if (isp) isp.sendsFullTable = true;
      return { dev: t.dev.id, ip: n.ip, isp: isp?.id };
    },
    fixed: (w, r) => {
      recompute(w);
      return !!w.sim.bgp[r.dev]?.find((b) => b.ip === r.ip)?.up;
    },
    rca: (w, r) => ({ dev: r.dev, cat: 'routing', keys: ['maximum-prefix', 'prefix-limit', 'full table', 'bgp', 'max-prefix'] }),
    ticket: () => ({ title: 'No internet: ISP changed something', text: ['Monitoring: BGP session down "maximum-prefix exceeded". The ISP moved us from default-only to full routes without telling anyone.', 'All customers: no internet.', 'Everyone: "down"', 'ISP: "our side is fine"'] }),
    hints: (w, r) => ['BGP logs say why the session dropped.', `The ISP now sends the full table (~950,000 prefixes); the limit on ${D(w, r.dev).hostname} is 1000.`, 'Raise or remove the maximum-prefix limit (or ask the ISP for default-only).'],
    ops: (w, r) => [{ op: 'bgpMaxpfx', dev: r.dev, ip: r.ip }],
  },
  {
    id: 'xr-policy-missing', tier: 4, cat: 'routing', sev: 1, name: 'IOS XR eBGP neighbour without route-policy',
    targets: (w) => bgpEdges(w).filter((d) => d.os === 'iosxr' && bgpEdges(w).length === 1).map((dev) => ({ dev })),
    inject(w, t) {
      const n = t.dev.cfg.bgp.nbrs[0];
      const pol = n.rplIn;
      n.rplIn = null;
      return { dev: t.dev.id, ip: n.ip, pol };
    },
    fixed: (w, r) => {
      const n = D(w, r.dev).cfg.bgp.nbrs.find((x) => x.ip === r.ip);
      return !!(n?.rplIn && D(w, r.dev).cfg.rpl?.[n.rplIn]);
    },
    rca: (w, r) => ({ dev: r.dev, cat: 'routing', keys: ['route-policy', 'rpl', 'policy', 'nopolicy', 'inbound'] }),
    ticket: () => ({ title: 'No default route from the ISP', text: ['Monitoring: BGP is Established but no routes are installed - the session shows (NoPolicy).', 'Customers report no internet.', 'Everyone: "down"', 'ISP: "the session is up, we send you a default route"'] }),
    hints: () => ['The session is up but no routes arrive.', 'IOS XR rejects all eBGP routes unless a route-policy is attached.', 'Attach the inbound route-policy and commit.'],
    ops: (w, r) => [{ op: 'xrPolicy', dev: r.dev, ip: r.ip, pol: r.pol || 'TRANSIT-IN' }],
  },
  {
    id: 'dup-rid', tier: 4, cat: 'routing', sev: 1, name: 'Duplicate OSPF router-id',
    targets: (w) => transitOspf(w).map((l) => ({ a: D(w, l.a.dev), b: D(w, l.b.dev) })).filter((t) => t.a.cfg.ospf.rid && t.b.cfg.ospf.rid && !['fortios', 'asa', 'aoscx'].includes(t.b.os)),
    inject(w, t) {
      const good = t.b.cfg.ospf.rid;
      t.b.cfg.ospf.rid = t.a.cfg.ospf.rid;
      return { dev: t.b.id, good, bad: t.a.cfg.ospf.rid, peer: t.a.id };
    },
    fixed: (w, r) => D(w, r.dev).cfg.ospf.rid !== r.bad,
    rca: (w, r) => ({ dev: r.dev, cat: 'routing', keys: ['router-id', 'router id', 'duplicate', 'ospf', r.bad] }),
    ticket: () => ({ title: 'Routing outage after cloning a config', text: ['Monitoring: OSPF adjacency will not form; a device was built from a copy of another device\'s config.', 'Customers report outages.', 'Customers: "down"', 'NOC: "the new box is configured exactly like the old one, what could go wrong"'] }),
    hints: (w, r) => ['Debug/log output mentions a duplicate router ID.', `Compare the OSPF router-id on ${D(w, r.dev).hostname} and ${D(w, r.peer).hostname}.`, `Give ${D(w, r.dev).hostname} its own router-id (${r.good}) and reset OSPF.`],
    ops: (w, r) => [{ op: 'ospfRid', dev: r.dev, rid: r.good }],
  },
  {
    id: 'null-route', tier: 4, cat: 'routing', sev: 1, name: 'Forgotten static route to Null0 hijacks a customer subnet',
    targets: (w) => [...fws(w), ...roleDevs(w, 'edge')].filter((d) => d.cfg.ospf?.on && !['asa'].includes(d.os)).flatMap((dev) => w.design.customers.filter((c) => !c.pending).map((c) => ({ dev, cust: c }))).slice(0, 6),
    inject(w, t) {
      const pfx = `10.100.${t.cust.k}.0/24`;
      t.dev.cfg.static.push({ pfx, nh: null, iface: 'Null0', ad: 1, fault: true });
      return { dev: t.dev.id, pfx, cust: t.cust.id };
    },
    fixed: (w, r) => !D(w, r.dev).cfg.static.some((x) => x.pfx === r.pfx && x.iface === 'Null0'),
    rca: (w, r) => ({ dev: r.dev, cat: 'routing', keys: ['null0', 'null', 'discard', 'blackhole', 'static', r.pfx] }),
    ticket: (w, r) => ({ title: `${custName(w, r)} unreachable from outside`, text: [`Monitoring: traffic to ${custName(w, r)} dies at ${D(w, r.dev).hostname}. A DDoS mitigation route was added there last month and "removed".`, `${custName(w, r)}: "our customers can't reach us"`, `${custName(w, r)}: "site down"`, `${custName(w, r)}: "inside works, outside doesn't, fix it"`] }),
    hints: (w, r) => ['Traceroute from outside stops at one router.', `Look up ${r.pfx} in the routing table on ${D(w, r.dev).hostname}: what wins?`, 'Remove the stale static route to Null0/discard.'],
    ops: (w, r) => [{ op: 'staticRemove', dev: r.dev, pfx: r.pfx }],
  },
  {
    id: 'mtu-blackhole', tier: 4, cat: 'routing', sev: 2, name: 'Path MTU black hole',
    targets: (w) => uplinks(w, ['transit']).filter((l) => D(w, l.a.dev).role === 'edge' && !['aoss', 'arubaos', 'fortios', 'asa'].includes(D(w, l.a.dev).os) && !['aoss', 'arubaos', 'asa'].includes(D(w, l.b.dev).os)).map((l) => ({ l })),
    inject(w, t) {
      for (const e of [t.l.a, t.l.b]) ifOf(w, e.dev, e.if).mtu = 1400;
      return { ends: [t.l.a, t.l.b], dev: t.l.a.dev, if: t.l.a.if };
    },
    fixed: (w, r) => r.ends.every((e) => (ifOf(w, e.dev, e.if).mtu ?? 1500) >= 1500),
    rca: (w, r) => ({ dev: r.dev, cat: 'routing', keys: ['mtu', 'fragmentation', 'df', 'pmtu', '1400'] }),
    ticket: () => ({ title: 'Websites half-load', text: ['Monitoring: small requests work, large HTTPS responses stall. The MTU on an edge transit link was lowered for a "new encapsulation".', 'Customers: pages start loading then hang; ping works.', 'Customers: "site loads text but no images"', 'Customer: "it\'s like the internet is half there"'] }),
    hints: () => ['Ping works, large transfers hang: test with large packets and DF set (ping size 1500, df-bit / do-not-fragment).', 'Find the link with a smaller MTU along the path.', 'Restore MTU 1500 on both ends.'],
    ops: (w, r) => r.ends.map((e) => ({ op: 'mtu', dev: e.dev, if: e.if, mtu: 1500 })),
  },
  {
    id: 'breaker-trip', tier: 2, cat: 'facility', sev: 1, name: 'PDU breaker tripped on feed A',
    targets: (w) => (w.facility?.racks || []).filter((rk) => !rk.trippedA && Object.values(w.devices).some((d) => d.rack === rk.id && d.hw.psus.length === 1)).map((rack) => ({ rack })),
    inject(w, t) {
      t.rack.trippedA = true;
      return { rack: t.rack.id, dev: Object.values(w.devices).find((d) => d.rack === t.rack.id && d.hw.psus.length === 1)?.id };
    },
    fixed: (w, r) => !w.facility.racks.find((x) => x.id === r.rack)?.trippedA,
    rca: (w, r) => ({ dev: r.dev, cat: 'facility', keys: ['breaker', 'pdu', 'power', 'tripped', 'feed', 'overload'] }),
    ticket: (w, r) => ({ title: `Rack ${r.rack}: several devices down`, text: [`Monitoring: every single-PSU device in rack ${r.rack} is down at the same moment. Dual-PSU devices log "power supply lost".`, `Multiple devices in rack ${r.rack} unreachable.`, 'Customers: "down"', 'Facilities: "we heard a click"'] }),
    hints: (w, r) => ['Many devices in one rack at once: think power.', `Go to rack ${r.rack} and check the PDU breakers.`, 'Reset the breaker (and check the rack is not overloaded).'],
    ops: (w, r) => [{ op: 'phys', action: 'reset-breaker', rack: r.rack }],
  },
  {
    id: 'crac-failure', tier: 3, cat: 'facility', sev: 2, name: 'Cooling unit failure',
    targets: (w) => (w.facility?.cooling || []).filter((c) => c.ok).map((unit) => ({ unit })),
    inject(w, t) {
      t.unit.ok = false;
      return { unit: t.unit.uid };
    },
    fixed: (w, r) => !!w.facility.cooling.find((c) => c.uid === r.unit)?.ok,
    rca: () => ({ dev: null, cat: 'facility', keys: ['cooling', 'crac', 'air', 'temperature', 'hvac'] }),
    ticket: () => ({ title: 'Room temperature rising', text: ['Monitoring: inlet temperatures climbing across all racks; one cooling unit reports a compressor fault.', 'Alarm: high temperature in the data hall.', 'Alarm: environmental.', 'Facilities: "it\'s like a sauna in there"'] }),
    hints: () => ['Every device warms up at once: the room, not a device.', 'Check the cooling units on the floor view.', 'Repair the failed unit before devices start shutting themselves down.'],
    ops: (w, r) => [{ op: 'phys', action: 'repair-cooling', unit: r.unit }],
  },
  {
    id: 'firmware-crash', tier: 3, cat: 'software', sev: 2, name: 'Known firmware bug crashes a device',
    targets: (w) => Object.values(w.devices).filter((d) => up(w, d) && (w.advisoryHits?.[d.id] || []).some((a) => (a.effect === 'crash' || a.effect === 'leak') && a.fixAvail)).map((dev) => ({ dev })),
    inject(w, t) {
      const adv = w.advisoryHits[t.dev.id].find((a) => (a.effect === 'crash' || a.effect === 'leak') && a.fixAvail);
      reload(w, t.dev, { reason: adv.effect === 'leak' ? 'Software forced reload (memory exhausted)' : 'Software forced crash' });
      if (t.dev.os.startsWith('ios')) t.dev.run.crashinfo = adv.id;
      return { dev: t.dev.id, adv: adv.id, fixed: adv.fixed };
    },
    fixed: (w, r) => !(w.advisoryHits?.[r.dev] || []).some((a) => a.id === r.adv),
    rca: (w, r) => ({ dev: r.dev, cat: 'software', keys: ['bug', 'firmware', 'upgrade', 'advisory', 'crash', r.adv.toLowerCase()] }),
    ticket: (w, r) => ({ title: `${D(w, r.dev).hostname} rebooted unexpectedly`, text: [`Monitoring: ${D(w, r.dev).hostname} reloaded on its own. Its firmware ${D(w, r.dev).version} is listed in advisory ${r.adv}.`, `${D(w, r.dev).hostname} reloaded unexpectedly; customers saw a short outage.`, 'Customers: "blip"', 'NOC: "it came back by itself, close the ticket?"'] }),
    hints: (w, r) => ['Check the uptime and last reload reason.', 'Compare the running firmware with the open advisories (Docs > Patch calendar).', `Schedule a firmware upgrade to ${r.fixed} or later in a maintenance window.`],
    ops: (w, r) => [{ op: 'firmware', dev: r.dev }],
    autoRestore: true,
  },
];
export const FAULT_BY_ID = Object.fromEntries(FAULTS.map((f) => [f.id, f]));

function custName(w, r) {
  return w.design.customers.find((c) => c.id === r.cust)?.name || 'A customer';
}
function custVip(w, r) {
  return w.design.customers.find((c) => c.id === r.cust)?.vip || '';
}
function freePort(w, dev) {
  const used = new Set(w.links.flatMap((l) => [l.a, l.b]).filter((e) => e.dev === dev.id).map((e) => e.if));
  return Object.keys(dev.cfg.ifs).find((n) => dev.cfg.ifs[n].kind === 'phys' && dev.cfg.ifs[n].sw && !used.has(n) && dev.cfg.ifs[n].hw?.media !== 'serial');
}

// Inject a random fault appropriate for the difficulty. Returns the fault record or null.
export function injectRandom(w, R, { maxTier, only = null } = {}) {
  const pool = FAULTS.filter((f) => (only ? only.includes(f.id) : f.tier <= maxTier));
  for (let tries = 0; tries < 12; tries++) {
    const f = R.weighted(pool, (x) => (x.tier === maxTier ? 2 : 1) * (x.cat === 'facility' ? 0.5 : 1));
    const targets = f.targets(w).filter(Boolean);
    if (!targets.length) continue;
    const t = R.pick(targets);
    const rec = f.inject(w, t, R);
    if (!rec) continue;
    return startFault(w, f, rec);
  }
  return null;
}
export function startFault(w, f, rec) {
  const fault = { id: `F${(w.nextFault = (w.nextFault || 0) + 1)}`, tpl: f.id, rec, t: w.time.t, active: true };
  w.faults = w.faults || [];
  w.faults.push(fault);
  w.dirty = true;
  recompute(w);
  return fault;
}
export function injectById(w, id, R, pick = 0) {
  const f = FAULT_BY_ID[id];
  const targets = f.targets(w).filter(Boolean);
  if (!targets.length) return null;
  const t = typeof pick === 'number' ? targets[pick % targets.length] : R.pick(targets);
  const rec = f.inject(w, t, R);
  return rec ? startFault(w, f, rec) : null;
}
export const faultFixed = (w, fault) => FAULT_BY_ID[fault.tpl].fixed(w, fault.rec);
export { CATS as FAULT_CATS, cidr };
void PUBLIC;
void OS;
void isSw;
void ensureVlan;
