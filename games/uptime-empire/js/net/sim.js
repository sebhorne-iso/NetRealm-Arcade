// Network simulator: computes the live state of the network from every device's canonical config,
// traces packets end-to-end and evaluates monitoring checks.
import { model, OS } from './catalog.js';
import { cidr, inNet, ip2n, n2ip, isPrivate, vlanIn, macFor } from '../core/util.js';
import { SVC, PUBLIC, PROBE, OFFICE, ISP_DEFS } from './builder.js';

const K = (dev, ifn) => `${dev}|${ifn}`;
const isSwitchy = (dev) => model(dev.model).feat.includes('l2');
const isL3 = (dev) => model(dev.model).feat.includes('l3') && !dev.cfg.noRouting;
const LACP = ['active', 'passive'];
const PAGP = ['desirable', 'auto'];
export function lagCompatible(mine, theirs) {
  if (!mine || !theirs) return false;
  if (mine === 'on' || theirs === 'on') return mine === 'on' && theirs === 'on';
  if (LACP.includes(mine) && LACP.includes(theirs)) return mine === 'active' || theirs === 'active';
  if (PAGP.includes(mine) && PAGP.includes(theirs)) return mine === 'desirable' || theirs === 'desirable';
  return false;
}
// Administrative distance per OS family (Junos: static 5, OSPF 10/150, BGP 170)
const AD = {
  default: { connected: 0, local: 0, static: 1, ebgp: 20, ospf: 110, ospfE: 110, ibgp: 200 },
  junos: { connected: 0, local: 0, static: 5, ebgp: 170, ospf: 10, ospfE: 150, ibgp: 170 },
  fortios: { connected: 0, local: 0, static: 10, ebgp: 20, ospf: 110, ospfE: 110, ibgp: 200 },
};
export const adFor = (dev) => (['junos', 'evo'].includes(dev.os) ? AD.junos : dev.os === 'fortios' ? AD.fortios : AD.default);
const speedOf = (ifc) => (ifc.speed !== 'auto' ? Number(ifc.speed) : ifc.hw?.speed || 1000);

export function devUp(world, dev) {
  return dev && dev.state === 'up';
}

// ============================================================================================
export function compute(world) {
  const S = {
    t: world.time.t,
    ifs: {},
    links: {},
    lags: {},
    nodeSeg: {},
    vlanGraph: {},
    stp: { blocked: {}, root: {}, rootPort: {}, storm: new Set() },
    eps: [],
    rib: {},
    ospf: {},
    bgp: {},
    fhrp: {},
    errdis: [],
    portSeg: {},
    wifi: { aps: {}, clients: null },
  };
  world.sim = S;
  const D = world.devices;
  const H = world.hosts;

  // ---------- 1. physical layer ----------
  const peerOf = new Map();
  for (const l of world.links) {
    const a = l.a.dev ? K(l.a.dev, l.a.if) : `h:${l.a.host}`;
    const b = l.b.dev ? K(l.b.dev, l.b.if) : `h:${l.b.host}`;
    peerOf.set(a, { link: l, me: l.a, peer: l.b });
    peerOf.set(b, { link: l, me: l.b, peer: l.a });
  }
  S.peerOf = peerOf;

  const endUp = (e) => {
    if (e.host) {
      const h = H[e.host];
      return !!h && h.nic?.up !== false && h.power !== false;
    }
    const dev = D[e.dev];
    if (!devUp(world, dev)) return false;
    const ifc = dev.cfg.ifs[e.if];
    return !!ifc && ifc.on && !dev.run.errdis[e.if];
  };
  const endIfc = (e) => (e.host ? H[e.host]?.nic : D[e.dev]?.cfg.ifs[e.if]);
  const optic = (e) => (e.dev ? D[e.dev].hw.optics?.[e.if] : null);

  for (const l of world.links) {
    const A = endIfc(l.a);
    const B = endIfc(l.b);
    let up = endUp(l.a) && endUp(l.b) && l.cable?.ok !== false;
    let reason = up ? 'up' : 'down';
    let loss = 0;
    let errors = 0;
    let duplex = 'full';
    let speed = 1000;
    const oa = optic(l.a);
    const ob = optic(l.b);
    for (const o of [oa, ob]) {
      if (!o) continue;
      if (o.dead || o.rx < -14) {
        up = false;
        reason = 'optic';
      } else if (o.rx < -10.5) {
        loss += 4 + (-10.5 - o.rx) * 6;
        errors += 1;
      }
    }
    if (up && A && B) {
      const sa = A.speed ?? 'auto';
      const sb = B.speed ?? 'auto';
      const capA = A.hw?.speed ?? 1000;
      const capB = B.hw?.speed ?? 1000;
      if (sa !== 'auto' && sb !== 'auto' && Number(sa) !== Number(sb)) {
        up = false;
        reason = 'speed';
      } else {
        speed = Math.min(sa !== 'auto' ? Number(sa) : capA, sb !== 'auto' ? Number(sb) : capB, capA, capB);
        const da = A.duplex ?? 'auto';
        const db = B.duplex ?? 'auto';
        const fa = da === 'auto' ? (sa !== 'auto' && sb === 'auto' ? 'full' : 'full') : da;
        const fb = db === 'auto' ? (da !== 'auto' ? (sa !== 'auto' ? 'half' : 'full') : 'full') : db;
        const fa2 = da === 'auto' && db !== 'auto' && sb !== 'auto' ? 'half' : fa;
        if (fa2 !== fb) {
          duplex = 'mismatch';
          loss += 8;
          errors += 1;
        } else duplex = fa2;
      }
      if (A.encap && B.encap && A.encap !== B.encap) reason = 'encap';
    }
    S.links[l.id] = { up, reason, loss, errors, duplex, speed, util: 0 };
  }

  // Per-interface operational state
  for (const dev of Object.values(D)) {
    const m = {};
    S.ifs[dev.id] = m;
    for (const [n, ifc] of Object.entries(dev.cfg.ifs)) {
      const p = peerOf.get(K(dev.id, n));
      let st = { up: false, proto: false, reason: 'notconnect', peer: p?.peer || null, link: p?.link?.id || null };
      if (!devUp(world, dev)) st.reason = 'down';
      else if (!ifc.on) st.reason = 'admin';
      else if (dev.run.errdis[n]) st.reason = 'err-disabled';
      else if (ifc.kind === 'lo') st = { ...st, up: true, proto: true, reason: 'up' };
      else if (p) {
        const L = S.links[p.link.id];
        st.up = L.up;
        st.proto = L.up && L.reason !== 'encap';
        st.reason = L.up ? (L.reason === 'encap' ? 'encap' : 'up') : 'notconnect';
        st.speed = L.speed;
        st.duplex = L.duplex;
      }
      m[n] = st;
    }
  }

  // ---------- 2. LACP ----------
  for (const dev of Object.values(D)) {
    S.lags[dev.id] = {};
    for (const [n, ifc] of Object.entries(dev.cfg.ifs)) {
      if (ifc.kind !== 'lag') continue;
      const members = Object.keys(dev.cfg.ifs).filter((x) => dev.cfg.ifs[x].lag?.id === ifc.lagId);
      const mem = {};
      let anyUp = false;
      for (const x of members) {
        const st = S.ifs[dev.id][x];
        const p = peerOf.get(K(dev.id, x));
        let state = 'D';
        if (st.up && p?.peer.dev) {
          const pd = D[p.peer.dev];
          const pi = pd.cfg.ifs[p.peer.if];
          const mine = dev.cfg.ifs[x].lag.mode;
          const theirs = pi?.lag?.mode;
          const ok = lagCompatible(mine, theirs);
          state = ok ? 'P' : 's';
        } else if (st.up) state = 's';
        mem[x] = state;
        if (state === 'P') anyUp = true;
      }
      S.lags[dev.id][n] = { up: anyUp && ifc.on, members: mem };
      S.ifs[dev.id][n] = { up: anyUp && ifc.on, proto: anyUp && ifc.on, reason: !ifc.on ? 'admin' : anyUp ? 'up' : 'down', lag: true };
    }
  }
  const bundled = (devId, n) => {
    const ifc = D[devId].cfg.ifs[n];
    if (!ifc?.lag) return false;
    const lagName = Object.keys(D[devId].cfg.ifs).find((x) => D[devId].cfg.ifs[x].kind === 'lag' && D[devId].cfg.ifs[x].lagId === ifc.lag.id);
    return lagName ? S.lags[devId][lagName]?.members[n] === 'P' : false;
  };
  const lagOf = (devId, n) => {
    const ifc = D[devId].cfg.ifs[n];
    return Object.keys(D[devId].cfg.ifs).find((x) => D[devId].cfg.ifs[x].kind === 'lag' && D[devId].cfg.ifs[x].lagId === ifc.lag?.id);
  };

  // ---------- 3. L2 graph ----------
  // A "port" is a forwarding interface: an up physical switchport (not a bundled member) or an up LAG.
  const portVlans = (dev, n) => {
    const ifc = dev.cfg.ifs[n];
    if (!ifc?.sw) return null;
    const exists = (v) => v in dev.cfg.vlans;
    if (ifc.sw.mode === 'access') return { u: exists(ifc.sw.vlan) ? ifc.sw.vlan : null, t: [] };
    const allowed = ifc.sw.allowed === 'all' ? Object.keys(dev.cfg.vlans).map(Number) : ifc.sw.allowed;
    return { u: exists(ifc.sw.native) ? ifc.sw.native : null, t: allowed.filter((v) => exists(v) && v !== ifc.sw.native) };
  };
  const adj = new Map(); // node -> [{to, link, a:{dev,if}, b}]
  const nodeKey = (devId, v) => `${devId}#${v}`;
  const addEdge = (x, y, info) => {
    if (!adj.has(x)) adj.set(x, []);
    if (!adj.has(y)) adj.set(y, []);
    adj.get(x).push({ to: y, ...info });
    adj.get(y).push({ to: x, ...info, rev: true });
  };
  const ports = []; // {dev, if, lag?, peer}
  for (const dev of Object.values(D)) {
    if (!devUp(world, dev)) continue;
    for (const [n, ifc] of Object.entries(dev.cfg.ifs)) {
      if (ifc.kind === 'lag') {
        if (!S.lags[dev.id][n]?.up || !ifc.sw) continue;
        // peer LAG = LAG on the device at the other end of any bundled member
        const mem = Object.entries(S.lags[dev.id][n].members).find(([, s]) => s === 'P');
        const p = peerOf.get(K(dev.id, mem[0]));
        const peerLag = lagOf(p.peer.dev, p.peer.if);
        ports.push({ dev: dev.id, if: n, peer: { dev: p.peer.dev, if: peerLag }, link: p.link.id, lag: true });
      } else if ((ifc.kind === 'phys' || ifc.kind === 'mgmt') && S.ifs[dev.id][n].up) {
        if (ifc.lag) continue; // members never forward on their own
        const p = peerOf.get(K(dev.id, n));
        if (p) ports.push({ dev: dev.id, if: n, peer: p.peer, link: p.link.id });
      }
    }
  }
  // BPDU guard: an edge port that hears a switch running STP is err-disabled
  let newErr = false;
  for (const pt of ports) {
    const dev = D[pt.dev];
    const ifc = dev.cfg.ifs[pt.if];
    if (!ifc.sw || !ifc.stp?.bpduguard) continue;
    const pd = pt.peer.dev ? D[pt.peer.dev] : null;
    const peerSendsBpdu = (pd && isSwitchy(pd) && pd.cfg.stp.on && pd.cfg.ifs[pt.peer.if]?.sw && pd.role !== 'ap') || (pt.peer.host && H[pt.peer.host]?.rogueSwitch);
    if (peerSendsBpdu && !dev.run.errdis[pt.if]) {
      dev.run.errdis[pt.if] = 'bpduguard';
      S.errdis.push({ dev: dev.id, if: pt.if, reason: 'bpduguard' });
      newErr = true;
    }
  }
  if (newErr) return compute(world);

  const swPorts = ports.filter((p) => D[p.dev].cfg.ifs[p.if].sw);
  const portMap = new Map(ports.map((p) => [K(p.dev, p.if), p]));
  for (const pt of swPorts) {
    const dev = D[pt.dev];
    const pv = portVlans(dev, pt.if);
    if (!pv) continue;
    if (pt.peer.dev) {
      const pd = D[pt.peer.dev];
      const pi = pd.cfg.ifs[pt.peer.if];
      if (!pi) continue;
      if (pi.sw) {
        if (K(pt.peer.dev, pt.peer.if) < K(pt.dev, pt.if)) continue; // add each pair once
        if (!portMap.has(K(pt.peer.dev, pt.peer.if))) continue;
        const qv = portVlans(pd, pt.peer.if);
        if (!qv) continue;
        if (pv.u && qv.u) addEdge(nodeKey(pt.dev, pv.u), nodeKey(pt.peer.dev, qv.u), { link: pt.link, a: pt, b: { dev: pt.peer.dev, if: pt.peer.if } });
        for (const v of pv.t) if (qv.t.includes(v)) addEdge(nodeKey(pt.dev, v), nodeKey(pt.peer.dev, v), { link: pt.link, a: pt, b: { dev: pt.peer.dev, if: pt.peer.if } });
      }
    }
  }
  // STP per VLAN component
  const vlans = new Set();
  for (const k of adj.keys()) vlans.add(Number(k.split('#')[1]));
  const blocked = new Set(); // edge identity "nodeA|nodeB|link"
  const edgeId = (x, e) => [x, e.to].sort().join('|') + '|' + e.link;
  for (const v of vlans) {
    const nodes = [...adj.keys()].filter((k) => Number(k.split('#')[1]) === v);
    const seen = new Set();
    for (const start of nodes) {
      if (seen.has(start)) continue;
      const comp = [];
      const q = [start];
      seen.add(start);
      while (q.length) {
        const x = q.shift();
        comp.push(x);
        for (const e of adj.get(x) || []) if (!seen.has(e.to)) {
          seen.add(e.to);
          q.push(e.to);
        }
      }
      const edges = new Set();
      for (const x of comp) for (const e of adj.get(x)) edges.add(edgeId(x, e));
      if (edges.size < comp.length) continue; // tree, no loop
      const allStp = comp.every((x) => D[x.split('#')[0]].cfg.stp.on && !(D[x.split('#')[0]].cfg.stp.off || []).includes(v));
      if (!allStp) {
        comp.forEach((x) => S.stp.storm.add(x));
        continue;
      }
      // root = lowest priority, then lowest MAC
      const prio = (x) => {
        const [devId] = x.split('#');
        return (D[devId].cfg.stp.prio[v] ?? 32768) * 1e6 + (ip2n(macFor(devId).slice(2).map((h) => parseInt(h, 16)).join('.')) % 1e6);
      };
      const root = comp.reduce((a, b) => (prio(b) < prio(a) ? b : a));
      S.stp.root[`${v}|${comp.join(',')}`] = root.split('#')[0];
      // Dijkstra on cost by link speed
      const dist = new Map([[root, 0]]);
      const par = new Map();
      const pend = new Set([root]);
      while (pend.size) {
        let x = null;
        for (const y of pend) if (x === null || dist.get(y) < dist.get(x) || (dist.get(y) === dist.get(x) && prio(y) < prio(x))) x = y;
        pend.delete(x);
        for (const e of adj.get(x)) {
          const L = S.links[e.link];
          const c = (L?.speed >= 10000 ? 2 : L?.speed >= 1000 ? 4 : L?.speed >= 100 ? 19 : 100) / (e.a && portMap.get(K(e.a.dev, e.a.if))?.lag ? 2 : 1);
          const nd = dist.get(x) + c;
          if (!dist.has(e.to) || nd < dist.get(e.to)) {
            dist.set(e.to, nd);
            par.set(e.to, { from: x, e });
            pend.add(e.to);
          }
        }
      }
      const treeEdges = new Set([...par.entries()].map(([to, { from, e }]) => edgeId(from, e)));
      for (const x of comp) for (const e of adj.get(x)) {
        const id = edgeId(x, e);
        if (!treeEdges.has(id)) {
          blocked.add(id);
          // the blocked side is the bridge farther from root (higher cost, then higher id)
          const [na, nb] = [x, e.to];
          const farther = (dist.get(na) > dist.get(nb) || (dist.get(na) === dist.get(nb) && prio(na) > prio(nb))) ? na : nb;
          const side = farther === x ? (e.rev ? e.b : e.a) : (e.rev ? e.a : e.b);
          const devId = farther.split('#')[0];
          const ifn = side.dev === devId ? side.if : (e.a.dev === devId ? e.a.if : e.b.if);
          (S.stp.blocked[devId] = S.stp.blocked[devId] || {})[ifn] = (S.stp.blocked[devId][ifn] || new Set()).add(v);
        }
      }
      for (const [to, { from, e }] of par.entries()) {
        const devId = to.split('#')[0];
        const ifn = e.a.dev === devId ? e.a.if : e.b.if;
        (S.stp.rootPort[devId] = S.stp.rootPort[devId] || {})[v] = ifn;
      }
    }
  }
  // Union-find segments over non-blocked edges
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const unite = (a, b) => parent.set(find(a), find(b));
  for (const [x, es] of adj) {
    find(x);
    for (const e of es) if (!blocked.has(edgeId(x, e))) unite(x, e.to);
  }
  S.vlanGraph = { adj, blocked, edgeId };
  // Node exists for every (dev, vlan) that has any up port in that vlan or an SVI
  const segOfNode = (devId, v) => `vl:${find(nodeKey(devId, v))}`;
  const nodeHasPort = (devId, v) => {
    const dev = D[devId];
    return ports.some((p) => {
      if (p.dev !== devId) return false;
      const pv = portVlans(dev, p.if);
      const bl = S.stp.blocked[devId]?.[p.if]?.has(v);
      return pv && !bl && (pv.u === v || pv.t.includes(v));
    });
  };

  // ---------- 4. L3 endpoints & segments ----------
  const eps = [];
  const addEp = (ep) => eps.push(ep);
  // segment for whatever is plugged into (dev, if) as an untagged/tagged attachment
  const segViaPort = (pt, vlan) => {
    // pt: {dev, if} of a switchport; vlan: the frame's VLAN as seen by that switch (or null = untagged)
    const dev = D[pt.dev];
    const pv = portVlans(dev, pt.if);
    if (!pv || S.ifs[pt.dev][pt.if]?.up === false) return null;
    if (dev.run.errdis[pt.if]) return null;
    const v = vlan == null ? pv.u : pv.t.includes(vlan) ? vlan : null;
    if (v == null) return null;
    if (S.stp.blocked[pt.dev]?.[pt.if]?.has(v)) return null;
    find(nodeKey(pt.dev, v));
    return segOfNode(pt.dev, v);
  };
  for (const dev of Object.values(D)) {
    if (!devUp(world, dev)) continue;
    for (const [n, ifc] of Object.entries(dev.cfg.ifs)) {
      if (!ifc.ip && !(dev.role === 'ap')) continue;
      const st = S.ifs[dev.id][n];
      let seg = null;
      let up = false;
      if (ifc.kind === 'lo') {
        seg = `lo:${dev.id}:${n}`;
        up = ifc.on;
      } else if (ifc.kind === 'svi') {
        const v = ifc.vlan;
        up = ifc.on && v in dev.cfg.vlans && nodeHasPort(dev.id, v);
        seg = up ? segOfNode(dev.id, v) : null;
        S.ifs[dev.id][n] = { up: ifc.on && v in dev.cfg.vlans, proto: up, reason: !ifc.on ? 'admin' : up ? 'up' : 'down', svi: true };
      } else if (ifc.kind === 'sub') {
        const par = dev.cfg.ifs[ifc.parent];
        const pst = S.ifs[dev.id][ifc.parent];
        up = ifc.on && par?.on && pst?.up;
        const p = peerOf.get(K(dev.id, ifc.parent));
        if (up && p) seg = p.peer.dev && D[p.peer.dev].cfg.ifs[p.peer.if]?.sw ? segViaPort(p.peer, ifc.vlan) : `sub:${p.link.id}:${ifc.vlan}`;
        S.ifs[dev.id][n] = { up: !!up, proto: !!(up && seg), reason: up ? 'up' : 'down' };
        up = up && !!seg;
      } else if (ifc.kind === 'lag') {
        up = st?.up;
        seg = up ? `lag:${dev.id}:${n}` : null;
      } else {
        // routed physical / serial / mgmt
        up = st?.up && st?.proto;
        const p = peerOf.get(K(dev.id, n));
        if (up && p) {
          if (p.peer.dev && D[p.peer.dev].cfg.ifs[p.peer.if]?.sw) seg = segViaPort(p.peer, null);
          else seg = `p2p:${p.link.id}`;
        }
        up = up && !!seg;
      }
      if (ifc.ip) {
        const c = cidr(ifc.ip);
        addEp({ dev: dev.id, if: n, ip: c.ip, len: c.len, seg, up: !!up, vrf: ifc.vrf || null });
      }
    }
  }
  for (const h of Object.values(H)) {
    if (!h.ip) continue;
    const p = peerOf.get(`h:${h.id}`);
    let seg = null;
    if (p && S.links[p.link.id]?.up) {
      if (p.peer.dev && D[p.peer.dev].cfg.ifs[p.peer.if]?.sw) seg = segViaPort(p.peer, h.vlanTag ?? null);
      else seg = `p2p:${p.link.id}`;
    }
    addEp({ host: h.id, ip: h.ip, len: h.len || 24, seg, up: !!seg });
  }
  // APs: management address in the native VLAN of their switchport
  for (const dev of Object.values(D).filter((x) => x.role === 'ap' && x.cfg.ap?.ip)) {
    if (!devUp(world, dev)) continue;
    const pn = Object.keys(dev.cfg.ifs)[0];
    const p = peerOf.get(K(dev.id, pn));
    const seg = p && S.links[p.link.id]?.up ? segViaPort(p.peer, null) : null;
    addEp({ dev: dev.id, if: pn, ip: dev.cfg.ap.ip, len: 24, seg, up: !!seg, ap: true });
  }
  // Storm segments
  S.stormSegs = new Set([...S.stp.storm].map((x) => `vl:${find(x)}`));
  S.eps = eps;

  // ---------- 5. FHRP ----------
  const groups = new Map();
  for (const ep of eps) {
    if (!ep.dev || !ep.up) continue;
    const ifc = D[ep.dev].cfg.ifs[ep.if];
    if (!ifc.fhrp) continue;
    const key = `${ep.seg}|${ifc.fhrp.grp}|${ifc.fhrp.vip}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ep, f: ifc.fhrp });
  }
  for (const [, members] of groups) {
    const cur = members.find((m) => D[m.ep.dev].run.fhrp[m.ep.if] === 'active');
    const best = members.reduce((a, b) => (b.f.prio > a.f.prio || (b.f.prio === a.f.prio && ip2n(b.ep.ip) > ip2n(a.ep.ip)) ? b : a));
    let active = cur || best;
    if (cur && best !== cur && best.f.preempt && best.f.prio > cur.f.prio) active = best;
    for (const m of members) {
      const st = m === active ? 'active' : 'standby';
      const prev = D[m.ep.dev].run.fhrp[m.ep.if];
      D[m.ep.dev].run.fhrp[m.ep.if] = st;
      (S.fhrp[m.ep.dev] = S.fhrp[m.ep.dev] || {})[m.ep.if] = { state: st, vip: m.f.vip, grp: m.f.grp, proto: m.f.proto, prio: m.f.prio, preempt: m.f.preempt, peers: members.length, changed: prev && prev !== st };
    }
    eps.push({ dev: active.ep.dev, if: active.ep.if, ip: active.f.vip, len: active.ep.len, seg: active.ep.seg, up: true, vip: true });
  }
  // FHRP interfaces whose group lost all peers drop their state
  for (const dev of Object.values(D)) for (const [n, ifc] of Object.entries(dev.cfg.ifs)) if (ifc.fhrp && !S.fhrp[dev.id]?.[n]) {
    (S.fhrp[dev.id] = S.fhrp[dev.id] || {})[n] = { state: 'init', vip: ifc.fhrp.vip, grp: ifc.fhrp.grp, proto: ifc.fhrp.proto, prio: ifc.fhrp.prio, preempt: ifc.fhrp.preempt, peers: 0 };
  }

  // ---------- 6. Routing ----------
  const epsByDev = new Map();
  for (const ep of eps) if (ep.dev) (epsByDev.get(ep.dev) || epsByDev.set(ep.dev, []).get(ep.dev)).push(ep);
  S.epsByDev = epsByDev;
  const bySeg = new Map();
  for (const ep of eps) if (ep.up && ep.seg) (bySeg.get(ep.seg) || bySeg.set(ep.seg, []).get(ep.seg)).push(ep);
  S.bySeg = bySeg;

  const routable = Object.values(D).filter((d) => devUp(world, d));
  for (const dev of routable) {
    const ad = adFor(dev);
    const rib = [];
    for (const ep of epsByDev.get(dev.id) || []) {
      if (!ep.up || ep.vip || ep.ap) continue;
      const c = cidr(`${ep.ip}/${ep.len}`);
      rib.push({ pfx: `${n2ip(c.net)}/${c.len}`, proto: 'connected', ad: 0, metric: 0, nh: null, oif: ep.if, vrf: ep.vrf });
      if (c.len < 32) rib.push({ pfx: `${ep.ip}/32`, proto: 'local', ad: 0, metric: 0, nh: null, oif: ep.if, vrf: ep.vrf });
    }
    S.rib[dev.id] = rib;
  }
  const resolveNh = (dev, nh, vrf = null) => {
    const conn = S.rib[dev.id].filter((r) => r.proto === 'connected' && (r.vrf || null) === vrf && inNet(nh, r.pfx));
    return conn[0] || null;
  };
  for (const dev of routable) {
    for (const s of dev.cfg.static) {
      if (s.iface === 'Null0' || s.iface === 'discard') {
        S.rib[dev.id].push({ pfx: s.pfx, proto: 'static', ad: s.ad ?? adFor(dev).static, metric: 0, nh: null, oif: 'Null0', discard: true });
        continue;
      }
      const c = resolveNh(dev, s.nh, s.vrf || null);
      if (c) S.rib[dev.id].push({ pfx: s.pfx, proto: 'static', ad: s.ad === 1 || s.ad == null ? adFor(dev).static : s.ad, metric: 0, nh: s.nh, oif: c.oif, vrf: s.vrf || null });
    }
  }
  // ---- BGP ----
  const ownerOfIp = (ip) => eps.find((e) => e.ip === ip && e.up && !e.vip);
  for (const dev of routable) {
    const b = dev.cfg.bgp;
    if (!b?.on) continue;
    S.bgp[dev.id] = [];
    for (const nb of b.nbrs) {
      const rec = { ip: nb.ip, ras: nb.ras, state: 'Idle', up: false, pfx: 0, reason: '', desc: nb.desc };
      const conn = resolveNh(dev, nb.ip);
      const owner = ownerOfIp(nb.ip);
      if (nb.shut) rec.state = 'Idle (Admin)';
      else if (!conn) rec.reason = 'no route to peer';
      else if (owner?.host && H[owner.host].kind === 'isp') {
        const isp = H[owner.host];
        const mySrc = (epsByDev.get(dev.id) || []).find((e) => e.ip === isp.ours);
        if (!isp.bgpUp) rec.state = 'Active';
        else if (!mySrc) {
          rec.state = 'Active';
          rec.reason = 'peer expects a different source address';
        } else if (nb.ras !== isp.asn) {
          rec.state = 'Idle';
          rec.reason = `bad remote-as (peer is AS${isp.asn})`;
          rec.notify = 'OPEN Message Error/Bad Peer AS';
        } else if (b.asn !== world.design.asn) {
          rec.state = 'Idle';
          rec.reason = 'peer rejected our AS';
          rec.notify = 'OPEN Message Error/Bad Peer AS';
        } else {
          const count = isp.sendsFullTable ? 948213 : 1;
          if (nb.maxpfx && count > nb.maxpfx) {
            rec.state = 'Idle (PfxCt)';
            rec.reason = `maximum-prefix ${nb.maxpfx} exceeded (${count} received)`;
          } else {
            rec.state = 'Established';
            rec.up = true;
            rec.pfx = count;
            // IOS XR rejects every eBGP route unless an inbound route-policy is attached
            const xrNoIn = dev.os === 'iosxr' && !(nb.rplIn && dev.cfg.rpl?.[nb.rplIn]);
            rec.accepted = xrNoIn ? 0 : count;
            if (xrNoIn) rec.noPolicy = true;
            else S.rib[dev.id].push({ pfx: '0.0.0.0/0', proto: 'ebgp', ad: adFor(dev).ebgp, metric: 0, nh: nb.ip, oif: conn.oif, peer: nb.ip });
          }
        }
        rec.isp = isp.id;
        // what we advertise
        const xrNoOut = dev.os === 'iosxr' && !(nb.rplOut && dev.cfg.rpl?.[nb.rplOut]);
        rec.adv = rec.up && !xrNoOut ? b.nets.filter((n) => S.rib[dev.id].some((r) => r.pfx === n && r.proto !== 'ebgp')) : [];
      } else if (owner?.dev) {
        const pd = D[owner.dev];
        const back = pd.cfg.bgp?.on ? pd.cfg.bgp.nbrs.find((x) => (epsByDev.get(dev.id) || []).some((e) => e.ip === x.ip)) : null;
        if (back && !back.shut && back.ras === b.asn && nb.ras === pd.cfg.bgp.asn) {
          rec.state = 'Established';
          rec.up = true;
        } else rec.state = 'Active';
      } else rec.state = 'Active';
      S.bgp[dev.id].push(rec);
    }
  }
  // ---- OSPF ----
  const ospfDevs = routable.filter((d) => d.cfg.ospf?.on);
  const adjs = [];
  for (const dev of ospfDevs) S.ospf[dev.id] = { nbrs: [], ifs: [] };
  const rid = (dev) => dev.cfg.ospf.rid || [...(epsByDev.get(dev.id) || [])].filter((e) => !e.vip).map((e) => e.ip).sort((a, b) => ip2n(b) - ip2n(a))[0];
  const rids = new Map();
  for (const dev of ospfDevs) {
    const r = rid(dev);
    rids.set(dev.id, r);
  }
  const dupRid = new Set([...rids.values()].filter((r, i, arr) => arr.indexOf(r) !== i));
  for (const [seg, list] of bySeg) {
    const os = list.filter((e) => e.dev && !e.vip && D[e.dev].cfg.ospf?.on && D[e.dev].cfg.ifs[e.if]?.ospf?.area != null);
    for (const e of os) S.ospf[e.dev].ifs.push(e);
    for (let i = 0; i < os.length; i++) for (let j = i + 1; j < os.length; j++) {
      const a = os[i];
      const bq = os[j];
      if (a.dev === bq.dev) continue;
      const A = D[a.dev].cfg.ifs[a.if];
      const B = D[bq.dev].cfg.ifs[bq.if];
      if (A.ospf.passive || B.ospf.passive) continue;
      let state = 'FULL';
      let why = '';
      if (cidr(`${a.ip}/${a.len}`).net !== cidr(`${bq.ip}/${bq.len}`).net || a.len !== bq.len) {
        state = null;
        why = 'subnet mismatch';
      } else if (A.ospf.area !== B.ospf.area) {
        state = null;
        why = `area mismatch (${A.ospf.area} vs ${B.ospf.area})`;
      } else if ((A.ospf.hello ?? 10) !== (B.ospf.hello ?? 10) || (A.ospf.dead ?? 40) !== (B.ospf.dead ?? 40)) {
        state = null;
        why = 'hello/dead interval mismatch';
      } else if ((A.ospf.auth || null) !== (B.ospf.auth || null)) {
        state = null;
        why = 'authentication mismatch';
      } else if (dupRid.has(rids.get(a.dev)) && rids.get(a.dev) === rids.get(bq.dev)) {
        state = null;
        why = 'duplicate router-id';
      } else if ((A.mtu ?? 1500) !== (B.mtu ?? 1500)) {
        state = 'EXSTART';
        why = 'MTU mismatch';
      }
      for (const [x, y, X] of [[a, bq, A], [bq, a, B]]) {
        S.ospf[x.dev].nbrs.push({ rid: rids.get(y.dev), ip: y.ip, if: x.if, state: state || 'DOWN', why, pri: 1, dev: y.dev, cost: X.ospf.cost ?? Math.max(1, Math.floor(100 / Math.max(1, (S.ifs[x.dev][x.if]?.speed || speedOf(X)) / 1)))});
        if (!state) S.ospf[x.dev].nbrs.pop();
        if (!state && why) (S.ospf[x.dev].problems = S.ospf[x.dev].problems || []).push({ if: x.if, peer: y.ip, why });
      }
      if (state === 'FULL') adjs.push([a, bq]);
    }
  }
  // advertised prefixes per OSPF router
  const lsdb = new Map();
  for (const dev of ospfDevs) {
    const list = [];
    for (const ep of epsByDev.get(dev.id) || []) {
      const ifc = dev.cfg.ifs[ep.if];
      if (!ep.up || ep.vip || ifc?.ospf?.area == null) continue;
      const c = cidr(`${ep.ip}/${ep.len}`);
      list.push({ pfx: `${n2ip(c.net)}/${c.len}`, cost: ifc.ospf.cost ?? 1, type: 'intra' });
    }
    if (dev.cfg.ospf.defOrig && (dev.cfg.ospf.always || S.rib[dev.id].some((r) => r.pfx === '0.0.0.0/0' && r.proto !== 'ospf'))) list.push({ pfx: '0.0.0.0/0', cost: 1, type: 'E2' });
    lsdb.set(dev.id, list);
  }
  const g = new Map();
  for (const [a, b2] of adjs) {
    const ca = D[a.dev].cfg.ifs[a.if].ospf.cost ?? 1;
    const cb = D[b2.dev].cfg.ifs[b2.if].ospf.cost ?? 1;
    (g.get(a.dev) || g.set(a.dev, []).get(a.dev)).push({ to: b2.dev, cost: ca, nh: b2.ip, oif: a.if });
    (g.get(b2.dev) || g.set(b2.dev, []).get(b2.dev)).push({ to: a.dev, cost: cb, nh: a.ip, oif: b2.if });
  }
  for (const dev of ospfDevs) {
    const dist = new Map([[dev.id, 0]]);
    const first = new Map([[dev.id, []]]);
    const pend = new Set([dev.id]);
    while (pend.size) {
      let x = null;
      for (const y of pend) if (x === null || dist.get(y) < dist.get(x)) x = y;
      pend.delete(x);
      for (const e of g.get(x) || []) {
        const nd = dist.get(x) + e.cost;
        const hop = x === dev.id ? [{ nh: e.nh, oif: e.oif }] : first.get(x);
        if (!dist.has(e.to) || nd < dist.get(e.to)) {
          dist.set(e.to, nd);
          first.set(e.to, hop.slice());
          pend.add(e.to);
        } else if (nd === dist.get(e.to)) {
          for (const h of hop) if (!first.get(e.to).some((z) => z.nh === h.nh)) first.get(e.to).push(h);
        }
      }
    }
    const have = new Set(S.rib[dev.id].filter((r) => r.proto === 'connected').map((r) => r.pfx));
    for (const p of lsdb.get(dev.id) || []) have.add(p.pfx); // never install routes to our own LSAs
    const best = new Map();
    for (const [rtr, d0] of dist) {
      if (rtr === dev.id) continue;
      for (const p of lsdb.get(rtr) || []) {
        if (have.has(p.pfx)) continue;
        const metric = p.type === 'E2' ? 1 : d0 + p.cost;
        const cur = best.get(p.pfx);
        if (!cur || metric < cur.metric || (metric === cur.metric && p.type === 'E2' && d0 < cur.d)) best.set(p.pfx, { metric, hops: first.get(rtr), type: p.type, d: d0 });
        else if (metric === cur.metric && (p.type !== 'E2' || d0 === cur.d)) for (const h of first.get(rtr)) if (!cur.hops.some((z) => z.nh === h.nh)) cur.hops.push(h);
      }
    }
    for (const [pfx, r] of best) S.rib[dev.id].push({ pfx, proto: r.type === 'E2' ? 'ospfE' : 'ospf', ad: r.type === 'E2' ? adFor(dev).ospfE : adFor(dev).ospf, metric: r.metric, nh: r.hops[0].nh, oif: r.hops[0].oif, ecmp: r.hops, ospfType: r.type });
  }
  // ---- best path selection ----
  for (const dev of routable) {
    const by = new Map();
    for (const r of S.rib[dev.id]) {
      const key = `${r.vrf || ''}|${r.pfx}`;
      const cur = by.get(key);
      if (!cur || r.ad < cur.ad || (r.ad === cur.ad && r.metric < cur.metric)) by.set(key, r);
    }
    S.rib[dev.id] = { all: S.rib[dev.id], best: [...by.values()].sort((a, b) => ip2n(a.pfx.split('/')[0]) - ip2n(b.pfx.split('/')[0]) || Number(a.pfx.split('/')[1]) - Number(b.pfx.split('/')[1])) };
  }
  // Public prefix reachability from the internet: advertised via BGP, or statically routed by a single ISP
  S.inbound = [];
  for (const isp of Object.values(H).filter((h) => h.kind === 'isp')) {
    const edgeEp = eps.find((e) => e.ip === isp.ours && e.up);
    if (!edgeEp) continue;
    const advertised = Object.values(S.bgp).flat().some((b) => b.isp === isp.id && b.up && b.adv?.includes(`${PUBLIC}.0/24`));
    if (advertised || !world.design.bgp) S.inbound.push({ isp: isp.id, to: edgeEp });
  }

  world.dirty = false;
  world.simT = world.time.t;
  // ---------- 7. Wireless ----------
  computeWifi(world, S);
  return S;
}

// ============================================================================================
// Route lookup on a device
export function lookup(world, dev, dst, vrf = null) {
  const S = world.sim;
  const rib = S.rib[dev.id];
  if (!rib) return null;
  let best = null;
  for (const r of rib.best) {
    if ((r.vrf || null) !== vrf) continue;
    if (!inNet(dst, r.pfx)) continue;
    const len = Number(r.pfx.split('/')[1]);
    if (!best || len > Number(best.pfx.split('/')[1])) best = r;
  }
  return best;
}

function natDevice(dev) {
  return (dev.cfg.fw && (dev.cfg.fw.pol.length || dev.cfg.fw.vip.length)) || (dev.cfg.nat && (dev.cfg.nat.inside.length || dev.cfg.nat.statics.length));
}

function aclPermit(dev, name, pkt) {
  const acl = dev.cfg.acls[name];
  if (!acl) return true; // undefined ACL permits (IOS behaviour)
  for (const e of acl) {
    if (e.proto && e.proto !== 'ip' && e.proto !== pkt.proto && !(e.proto === 'tcp' && pkt.proto === 'tcp')) continue;
    if (e.src && e.src !== 'any' && !inNet(pkt.src, e.src)) continue;
    if (e.dst && e.dst !== 'any' && !inNet(pkt.dst, e.dst)) continue;
    if (e.dport && pkt.dport && Number(e.dport) !== Number(pkt.dport)) continue;
    return e.act === 'permit';
  }
  return false; // implicit deny
}

const SVCPORT = { HTTPS: [443], HTTP: [80], SSH: [22], ALL: null, PING: [] };
function policyCheck(world, dev, inIf, outIf, pkt) {
  const fw = dev.cfg.fw;
  const zIn = dev.cfg.ifs[inIf]?.zone;
  const zOut = dev.cfg.ifs[outIf]?.zone;
  if (!zIn || !zOut || zIn === zOut) return { ok: true };
  if (dev.os === 'asa') {
    const lin = dev.cfg.ifs[inIf].seclvl ?? 0;
    const lout = dev.cfg.ifs[outIf].seclvl ?? 0;
    const acl = dev.cfg.ifs[inIf].acl?.in;
    // Before ASA 8.3, access-lists reference the mapped (public) address of a static NAT
    const [maj, min] = String(dev.version).split(/[.(]/).map(Number);
    const legacy = maj < 8 || (maj === 8 && min < 3);
    const p2 = legacy && pkt.dnatFrom ? { ...pkt, dst: pkt.dnatFrom } : pkt;
    if (acl) return aclPermit(dev, acl, p2) ? { ok: true, rule: acl } : { ok: false, rule: acl, why: `access-list ${acl} implicit or explicit deny`, acl };
    return lin > lout ? { ok: true, rule: 'security-level' } : { ok: false, rule: 'security-level', why: 'implicit deny (lower to higher security level)' };
  }
  for (const p of fw.pol) {
    if (!p.on || p.from !== zIn || p.to !== zOut) continue;
    if (p.dst !== 'all') {
      const vip = fw.vip.find((v) => v.name === p.dst);
      const addr = vip ? vip.int : p.dst;
      if (!(pkt.dnatFrom ? pkt.dst === addr || pkt.dnatFrom === vip?.ext : inNet(pkt.dst, addr.includes('/') ? addr : `${addr}/32`))) continue;
    }
    if (p.src !== 'all' && !inNet(pkt.src, p.src.includes('/') ? p.src : `${p.src}/32`)) continue;
    const ports = SVCPORT[p.svc];
    if (ports && ports.length && pkt.proto === 'tcp' && !ports.includes(pkt.dport)) continue;
    if (ports && ports.length && pkt.proto !== 'tcp') continue;
    return p.act === 'accept' ? { ok: true, rule: p.id, nat: p.nat } : { ok: false, rule: p.id, why: `denied by policy ${p.id}` };
  }
  return { ok: false, rule: 0, why: 'Denied by forward policy check (policy 0)' };
}

// ============================================================================================
// Packet walk. src: {host} | {dev, vrf, ip?}. Returns {ok, hops, reason, at, loss, rtt}
export function walk(world, src, dst, opts = {}) {
  if (world.dirty || !world.sim) compute(world);
  const S = world.sim;
  const D = world.devices;
  const H = world.hosts;
  const pkt = { src: null, dst, proto: opts.proto || 'icmp', dport: opts.dport || null, size: opts.size || 100, df: !!opts.df };
  const hops = [];
  const linksUsed = [];
  let loss = 0;
  let rtt = 0.2;
  const xlat = [];
  const fail = (reason, at) => ({ ok: false, hops, reason, at, loss: 100, rtt, linksUsed, xlat });

  // Starting point
  let cur; // {kind:'host'|'dev', id, inIf, seg}
  if (src.host) {
    const ep = S.eps.find((e) => e.host === src.host);
    if (!ep || !ep.up) return fail('source host offline', src.host);
    pkt.src = ep.ip;
    cur = { kind: 'host', id: src.host, ep };
  } else {
    const dev = D[src.dev];
    if (!devUp(world, dev)) return fail('device down', src.dev);
    let ep = null;
    if (src.ip) ep = S.eps.find((e) => e.dev === src.dev && e.ip === src.ip && e.up);
    const r = lookup(world, dev, dst, src.vrf || null);
    if (!ep && r) ep = S.eps.find((e) => e.dev === src.dev && e.if === r.oif && e.up && !e.vip) || null;
    pkt.src = ep?.ip || src.ip || '0.0.0.0';
    cur = { kind: 'dev', id: src.dev, inIf: null, vrf: src.vrf || null, origin: true };
  }

  for (let ttl = 0; ttl < 32; ttl++) {
    // ----- deliver checks -----
    const tgt = S.eps.find((e) => e.ip === pkt.dst && e.up);
    if (cur.kind === 'host') {
      const h = H[cur.id];
      if (h.kind === 'isp') {
        // Internet side
        if (!inNet(pkt.dst, `${PUBLIC}.0/24`) && !isPrivate(pkt.dst) && !(cur.ispIn)) {
          if (isPrivate(pkt.src)) return fail('dropped by ISP: private source address (missing NAT)', h.id);
          rtt += 14;
          hops.push({ isp: h.id, ip: h.ip, name: h.name });
          return { ok: true, hops, reason: 'delivered', at: 'internet', loss, rtt, linksUsed, xlat, pkt };
        }
      }
      if (h.ip === pkt.dst && !cur.origin) {
        // leap-second style CPU hog: the box answers, slowly and not always
        if (h.cpuHog) {
          loss += 35;
          rtt += 900;
        }
        if (pkt.proto === 'tcp' && pkt.dport && !(h.listen || []).includes(pkt.dport)) return fail(`port ${pkt.dport} closed`, h.id);
        return { ok: true, hops, reason: 'delivered', at: h.id, loss, rtt, linksUsed, xlat, pkt };
      }
      // forward from host: same subnet or gateway
      const ep = cur.ep || S.eps.find((e) => e.host === h.id);
      if (!ep?.seg) return fail('host has no link', h.id);
      let nextIp = inNet(pkt.dst, `${ep.ip}/${ep.len}`) ? pkt.dst : h.gw;
      if (h.kind === 'isp') {
        // ISP routes our public block to the edge that advertises it
        const inb = S.inbound.find((x) => x.isp === h.id);
        if (!inb) return fail('ISP has no route to destination', h.id);
        nextIp = inb.to.ip;
      }
      if (!nextIp) return fail('no default gateway', h.id);
      const nxt = (S.bySeg.get(ep.seg) || []).find((e) => e.ip === nextIp && e.up);
      if (!nxt) return fail(nextIp === pkt.dst ? 'destination host unreachable (no ARP reply)' : `gateway ${nextIp} unreachable`, h.id);
      loss += segLoss(S, ep.seg);
      l2links(world, ep, nxt, linksUsed);
      if (nxt.host) {
        cur = { kind: 'host', id: nxt.host, ep: nxt, origin: false, ispIn: H[nxt.host]?.kind === 'isp' && h.kind !== 'isp' };
        if (H[nxt.host].kind === 'isp') continue;
        continue;
      }
      cur = { kind: 'dev', id: nxt.dev, inIf: nxt.if, inIp: nxt.ip, vrf: nxt.vrf };
      continue;
    }
    // ----- at a device -----
    const dev = D[cur.id];
    if (!devUp(world, dev)) return fail('device down', dev.id);
    if (cur.inIf) hops.push({ dev: dev.id, ip: cur.inIp, inIf: cur.inIf });
    rtt += 0.4;
    // DNAT / static NAT (inbound)
    if (cur.inIf && natDevice(dev)) {
      const z = dev.cfg.ifs[cur.inIf]?.zone;
      const outsideIn = z === 'outside' || dev.cfg.nat?.outside?.includes(cur.inIf);
      if (outsideIn) {
        const v = dev.cfg.fw.vip.find((x) => x.ext === pkt.dst) || dev.cfg.nat?.statics.find((x) => x.ext === pkt.dst);
        if (v) {
          xlat.push({ dev: dev.id, type: 'dnat', from: pkt.dst, to: v.int });
          pkt.dnatFrom = pkt.dst;
          pkt.dst = v.int;
        }
      }
    }
    // delivered to the device itself?
    const own = (S.epsByDev.get(dev.id) || []).find((e) => e.ip === pkt.dst && e.up);
    if (own && !cur.origin) return { ok: true, hops, reason: 'delivered', at: dev.id, loss, rtt, linksUsed, xlat, pkt, toDevice: true };
    if (cur.origin && own && own.ip === pkt.dst) return { ok: true, hops, reason: 'local', at: dev.id, loss, rtt, linksUsed, xlat, pkt, toDevice: true };
    // Ingress ACL
    const inIfc = cur.inIf ? dev.cfg.ifs[cur.inIf] : null;
    if (inIfc?.acl?.in && dev.os !== 'asa' && !aclPermit(dev, inIfc.acl.in, pkt)) return fail(`denied by ACL ${inIfc.acl.in} on ${cur.inIf}`, dev.id);
    if (!isL3(dev) && !cur.origin) return fail('not a router', dev.id);
    const r = lookup(world, dev, pkt.dst, cur.vrf || null);
    if (!r) return fail('no route to host', dev.id);
    if (r.discard) return fail('discarded (route to Null0)', dev.id);
    const outIf = r.oif;
    // Firewall policy
    if (cur.inIf && dev.cfg.fw && (dev.cfg.fw.pol.length || dev.os === 'asa') && !opts.ret) {
      const pc = policyCheck(world, dev, cur.inIf, outIf, pkt);
      if (!pc.ok) return fail(pc.why, dev.id);
      // source NAT on the way out
      const zOut = dev.cfg.ifs[outIf]?.zone;
      const zIn = dev.cfg.ifs[cur.inIf]?.zone;
      if (zOut === 'outside' && zIn !== 'outside' && isPrivate(pkt.src)) {
        const vip = dev.cfg.fw.vip.find((v) => v.int === pkt.src);
        const snatOk = dev.os === 'fortios' ? pc.nat : dev.cfg.fw.snat.some((s) => s.on && s.from === zIn && s.to === zOut);
        if (vip) {
          xlat.push({ dev: dev.id, type: 'snat', from: pkt.src, to: vip.ext });
          pkt.src = vip.ext;
        } else if (snatOk) {
          const oip = (S.epsByDev.get(dev.id) || []).find((e) => e.if === outIf && !e.vip)?.ip;
          xlat.push({ dev: dev.id, type: 'snat', from: pkt.src, to: oip });
          pkt.src = oip;
        }
      }
    }
    // Router NAT (IOS ip nat)
    if (cur.inIf && dev.cfg.nat && dev.cfg.nat.inside.includes(cur.inIf) && dev.cfg.nat.outside.includes(outIf) && isPrivate(pkt.src)) {
      const st = dev.cfg.nat.statics.find((x) => x.int === pkt.src);
      if (st) {
        xlat.push({ dev: dev.id, type: 'snat', from: pkt.src, to: st.ext });
        pkt.src = st.ext;
      } else if (dev.cfg.nat.overload) {
        const oip = (S.epsByDev.get(dev.id) || []).find((e) => e.if === outIf && !e.vip)?.ip;
        xlat.push({ dev: dev.id, type: 'snat', from: pkt.src, to: oip });
        pkt.src = oip;
      }
    }
    const outIfc = dev.cfg.ifs[outIf];
    if (outIfc?.acl?.out && dev.os !== 'asa' && !aclPermit(dev, outIfc.acl.out, pkt)) return fail(`denied by ACL ${outIfc.acl.out} on ${outIf}`, dev.id);
    if (pkt.df && pkt.size > (outIfc?.mtu || 1500)) return fail(`fragmentation needed (MTU ${outIfc.mtu} on ${outIf})`, dev.id);
    const outEp = (S.epsByDev.get(dev.id) || []).find((e) => e.if === outIf && e.up && !e.vip);
    if (!outEp) return fail(`egress interface ${outIf} down`, dev.id);
    const nhIp = r.nh || pkt.dst;
    const nxt = (S.bySeg.get(outEp.seg) || []).find((e) => e.ip === nhIp && e.up && e !== outEp);
    if (!nxt) return fail(r.nh ? `next hop ${r.nh} unreachable` : 'destination host unreachable (no ARP reply)', dev.id);
    loss += segLoss(S, outEp.seg);
    // worm outbreak: links towards the ISPs are saturated unless the worm's port is filtered
    if (world.worm && nxt.host && H[nxt.host]?.kind === 'isp' && !world.worm.blocked) loss += 70;
    l2links(world, outEp, nxt, linksUsed);
    if (nxt.host) {
      const h = H[nxt.host];
      cur = { kind: 'host', id: nxt.host, ep: nxt, origin: false, ispIn: false };
      if (h.kind === 'isp') {
        hops.push({ isp: h.id, ip: h.ip, name: h.name });
        rtt += 9;
        if (inNet(pkt.dst, `${PUBLIC}.0/24`)) return fail('routing loop via ISP', h.id);
        if (isPrivate(pkt.src)) return fail('dropped by ISP: private source address (missing NAT)', h.id);
        rtt += 5;
        return { ok: true, hops, reason: 'delivered', at: 'internet', loss, rtt, linksUsed, xlat, pkt };
      }
      continue;
    }
    cur = { kind: 'dev', id: nxt.dev, inIf: nxt.if, inIp: nxt.ip, vrf: nxt.vrf };
  }
  return fail('TTL exceeded (routing loop)', cur.id);
}

function segLoss(S, seg) {
  return S.stormSegs?.has(seg) ? 85 : 0;
}

// Record the physical links a frame crosses inside an L2 segment (for utilisation + quality)
function l2links(world, from, to, out) {
  const S = world.sim;
  const a = from.dev || `h:${from.host}`;
  const b = to.dev || `h:${to.host}`;
  if (from.seg?.startsWith('p2p:')) {
    out.push(from.seg.slice(4));
    return;
  }
  const attachOf = (ep) => {
    if (ep.host) {
      const p = S.peerOf.get(`h:${ep.host}`);
      return p ? { node: p.peer.dev, link: p.link.id } : null;
    }
    const ifc = world.devices[ep.dev].cfg.ifs[ep.if];
    if (ifc?.kind === 'svi') return { node: ep.dev, link: null };
    const p = S.peerOf.get(`${ep.dev}|${ifc?.kind === 'sub' ? ifc.parent : ep.if}`);
    return p ? { node: p.peer.dev, link: p.link.id } : null;
  };
  const A = attachOf(from);
  const B = attachOf(to);
  if (!A || !B) return;
  if (A.link) out.push(A.link);
  if (B.link) out.push(B.link);
  if (A.node === B.node || !A.node || !B.node) return;
  // BFS across switches over unblocked VLAN edges (any VLAN; good enough for utilisation)
  const { adj, blocked, edgeId } = S.vlanGraph;
  const q = [...adj.keys()].filter((k) => k.startsWith(`${A.node}#`));
  const prev = new Map(q.map((k) => [k, null]));
  while (q.length) {
    const x = q.shift();
    if (x.startsWith(`${B.node}#`)) {
      let y = x;
      while (prev.get(y)) {
        out.push(prev.get(y).link);
        y = prev.get(y).from;
      }
      return;
    }
    for (const e of adj.get(x) || []) if (!blocked.has(edgeId(x, e)) && !prev.has(e.to)) {
      prev.set(e.to, { from: x, link: e.link });
      q.push(e.to);
    }
  }
}

// ============================================================================================
// Wireless: AP join + client DHCP/auth state
function computeWifi(world, S) {
  const D = world.devices;
  const aps = Object.values(D).filter((d) => d.role === 'ap');
  const ctrl = Object.values(D).find((d) => d.cfg.wlc);
  S.wifi = { aps: {}, ctrl: ctrl?.id || null, clients: null };
  if (!aps.length) return;
  for (const ap of aps) {
    const ep = S.eps.find((e) => e.dev === ap.id && e.ap);
    let state = 'down';
    let why = '';
    if (!devUp(world, ap)) why = 'AP powered off';
    else if (!ep?.up) why = 'no link / no IP in AP VLAN';
    else if (!ctrl) why = 'no controller';
    else {
      const ctrlIps = (S.epsByDev.get(ctrl.id) || []).filter((e) => e.up).map((e) => e.ip);
      if (!ap.cfg.ap.ctrl || !ctrlIps.includes(ap.cfg.ap.ctrl)) why = `controller ${ap.cfg.ap.ctrl || '(none)'} not found`;
      else {
        const nxtOk = (S.bySeg.get(ep.seg) || []).some((e) => e.ip === ap.cfg.ap.ctrl) || !!lookupFromSeg(world, ep, ap.cfg.ap.ctrl);
        if (nxtOk) state = 'up';
        else why = 'controller unreachable';
      }
    }
    S.wifi.aps[ap.id] = { state, why, ip: ap.cfg.ap?.ip };
  }
  // Clients: on the first joined AP, in the SSID's VLAN
  const ssid = ctrl?.cfg.wlc?.ssids?.[0];
  const joined = aps.filter((a) => S.wifi.aps[a.id].state === 'up');
  const c = { ssid: ssid?.essid, vlan: ssid?.vlan, assoc: false, auth: false, dhcp: false, why: '' };
  if (!ssid) c.why = 'no SSID configured';
  else if (!joined.length) c.why = 'no access points joined';
  else {
    c.assoc = true;
    if (ssid.auth === 'wpa2-ent') {
      const rad = ctrl.cfg.wlc.radius.find((r) => r.name === ssid.radius);
      const radHost = Object.values(world.hosts).find((h) => h.role === 'radius');
      const reach = rad && radHost && rad.ip === radHost.ip && reachFromDev(world, ctrl, rad.ip);
      if (!rad) c.why = 'RADIUS server profile missing';
      else if (!reach) c.why = `RADIUS server ${rad.ip} unreachable`;
      else if (rad.key !== (radHost.key || 'R4dius-Key')) c.why = 'RADIUS shared secret mismatch (Access-Reject / bad authenticator)';
      else c.auth = true;
    } else c.auth = true;
    if (c.auth) {
      // client lands in ssid.vlan at the AP's switch; needs a gateway with a DHCP relay
      const apDev = joined[0];
      const p = S.peerOf.get(`${apDev.id}|${Object.keys(apDev.cfg.ifs)[0]}`);
      const sw = p ? world.devices[p.peer.dev] : null;
      const pi = sw?.cfg.ifs[p.peer.if];
      const carries = pi?.sw && (pi.sw.mode === 'trunk' ? vlanIn(pi.sw.allowed, ssid.vlan) && ssid.vlan in sw.cfg.vlans : pi.sw.vlan === ssid.vlan);
      if (!carries) c.why = `VLAN ${ssid.vlan} not carried on ${sw?.hostname || 'switch'} ${p?.peer.if || ''}`;
      else {
        const gw = S.eps.find((e) => e.dev && e.up && world.devices[e.dev].cfg.ifs[e.if]?.kind === 'svi' && world.devices[e.dev].cfg.ifs[e.if].vlan === ssid.vlan && !e.vip);
        const gwIf = gw && world.devices[gw.dev].cfg.ifs[gw.if];
        if (!gw) c.why = `no gateway for VLAN ${ssid.vlan}`;
        else if (!gwIf.helper?.includes(SVC.dhcp)) c.why = `no DHCP relay (ip helper-address) on ${gw.if}`;
        else if (!reachFromDev(world, world.devices[gw.dev], SVC.dhcp, gw.ip)) c.why = 'DHCP server unreachable from relay';
        else {
          c.dhcp = true;
          c.ip = `${gw.ip.split('.').slice(0, 3).join('.')}.100`;
          c.gw = `${gw.ip.split('.').slice(0, 3).join('.')}.1`;
          c.seg = gw.seg;
        }
      }
    }
  }
  S.wifi.clients = c;
}
function lookupFromSeg(world, ep, ip) {
  const gwEp = (world.sim.bySeg.get(ep.seg) || []).find((e) => e.ip.endsWith('.1') && e.dev);
  if (!gwEp) return null;
  return reachFromDev(world, world.devices[gwEp.dev], ip, gwEp.ip) ? gwEp : null;
}
function reachFromDev(world, dev, ip, srcIp) {
  const r = walk(world, { dev: dev.id, ip: srcIp }, ip, {});
  return r.ok;
}

// ============================================================================================
// Monitoring checks
export function checks(world) {
  if (world.dirty || !world.sim) compute(world);
  // results only change when the network is recomputed; reuse them until then
  if (world.sim._checks) return world.sim._checks.map((c) => ({ ...c }));
  const out = [];
  const H = world.hosts;
  const nms = Object.values(H).find((h) => h.role === 'nms');
  const add = (c) => out.push(c);
  for (const c of world.design.customers) {
    if (c.pending) continue;
    for (const hid of c.servers) {
      const h = H[hid];
      if (!h) continue;
      const r = nms ? two(world, { host: nms.id }, h.ip, {}) : { ok: false, reason: 'no NMS' };
      add({ id: `reach:${hid}`, cust: c.id, kind: 'reach', name: `${h.name} reachable`, target: h.ip, ...r });
    }
    if (c.web) {
      const isp = Object.values(H).find((h) => h.kind === 'isp');
      const r = isp ? inboundWeb(world, isp, c.vip) : { ok: false, reason: 'no ISP' };
      add({ id: `web:${c.id}`, cust: c.id, kind: 'web', name: `${c.name} website (HTTPS ${c.vip})`, target: c.vip, ...r });
    }
    // outbound test from the last server (the web server may have its own static NAT)
    const web = H[c.servers[c.servers.length - 1]];
    if (web) {
      const r = two(world, { host: web.id }, '8.8.8.8', {});
      add({ id: `out:${c.id}`, cust: c.id, kind: 'out', name: `${c.name} internet access`, target: '8.8.8.8', ...r });
    }
  }
  const jump = H.jump;
  for (const dev of Object.values(world.devices)) {
    if (dev.role === 'ap') continue;
    const ip = world.design.mgmt[dev.id];
    if (!ip) continue;
    const r = two(world, { host: jump.id }, ip, {});
    add({ id: `mgmt:${dev.id}`, dev: dev.id, kind: 'mgmt', name: `${dev.hostname} management (${ip})`, target: ip, ...r });
  }
  for (const c of out) {
    const loss = Math.round(c.loss || 0);
    if (c.ok && loss >= 25) Object.assign(c, { ok: false, reason: `timeouts (${Math.min(100, loss)}% packet loss)` });
    else if (c.ok && loss >= 5) Object.assign(c, { degraded: true, reason: `${loss}% packet loss` });
  }
  if (world.design.office.on && world.sim.wifi.clients) {
    const c = world.sim.wifi.clients;
    add({ id: 'wifi:clients', kind: 'wifi', name: `Office Wi-Fi "${c.ssid || '-'}"`, ok: c.dhcp, reason: c.dhcp ? 'clients online' : c.why, loss: c.dhcp ? 0 : 100 });
  }
  world.sim._checks = out;
  return out.map((c) => ({ ...c }));
}

// Two-way reachability (forward + return)
export function two(world, src, dst, opts) {
  const f = walk(world, src, dst, opts);
  if (!f.ok) return f;
  if (f.at === 'internet' || f.toDevice) return f;
  // return path from destination host back to the translated source
  const back = walk(world, { host: f.at }, f.pkt.src, { ...opts, ret: true });
  if (!back.ok) return { ...back, reason: `return path: ${back.reason}` };
  return { ...f, loss: Math.min(100, f.loss + back.loss), rtt: f.rtt + back.rtt, linksUsed: [...f.linksUsed, ...back.linksUsed] };
}

function inboundWeb(world, isp, vip) {
  const S = world.sim;
  const pseudo = { kind: 'isp' };
  if (!S.inbound.find((x) => x.isp === isp.id) && !Object.values(world.hosts).some((h) => h.kind === 'isp' && S.inbound.find((x) => x.isp === h.id))) return { ok: false, reason: 'public prefix not reachable from the internet (not advertised)' };
  for (const h of Object.values(world.hosts).filter((x) => x.kind === 'isp')) {
    if (!S.inbound.find((x) => x.isp === h.id)) continue;
    const orig = h.ip;
    const r = walk(world, { host: h.id }, vip, { proto: 'tcp', dport: 443 });
    void orig;
    void pseudo;
    if (r.ok) return { ...r, reason: 'HTTP 200 OK' };
    if (h === Object.values(world.hosts).filter((x) => x.kind === 'isp').slice(-1)[0]) return r;
  }
  return { ok: false, reason: 'unreachable' };
}

// ============================================================================================
// Utilisation: customer traffic demand along their paths
export function utilisation(world, demandMbps) {
  const S = world.sim;
  for (const L of Object.values(S.links)) L.util = 0;
  for (const c of world.design.customers) {
    const web = world.hosts[c.servers[0]];
    if (!web) continue;
    const r = walk(world, { host: web.id }, '8.8.8.8', {});
    if (!r.ok) continue;
    const mbps = demandMbps(c);
    for (const id of new Set(r.linksUsed)) if (S.links[id]) S.links[id].util += mbps;
  }
  for (const [id, L] of Object.entries(S.links)) {
    L.pct = L.speed ? Math.min(100, (L.util / L.speed) * 100) : 0;
    const lagged = world.links.find((x) => x.id === id);
    void lagged;
  }
}

export function macOf(world, devId, ifn) {
  return macFor(`${devId}:${ifn}`);
}
export const ispList = () => ISP_DEFS;
export { PROBE, OFFICE };
