// Turns changes in the simulated network into abstract log events. Each vendor dialect renders
// them in its own syslog format (show logging, show log messages, execute log display ...).
import { compute } from './sim.js';
import { macFor } from '../core/util.js';

const MAX_LOGS = 500;

export function logEvent(world, devId, ev) {
  const dev = world.devices[devId];
  if (!dev) return;
  const e = { t: world.time.t, dev: devId, ...ev };
  dev.run.logs.push(e);
  if (dev.run.logs.length > MAX_LOGS) dev.run.logs.splice(0, dev.run.logs.length - MAX_LOGS);
  world.logQueue = world.logQueue || [];
  world.logQueue.push(e);
  // Central syslog server keeps everything (the NOC "Logs" view)
  world.syslog = world.syslog || [];
  world.syslog.push(e);
  if (world.syslog.length > 4000) world.syslog.splice(0, world.syslog.length - 4000);
}

export function snapshot(world) {
  const S = world.sim;
  const snap = { ifs: {}, ospf: {}, bgp: {}, fhrp: {}, lag: {}, blocked: {}, wifi: {} };
  for (const [d, m] of Object.entries(S.ifs)) for (const [n, st] of Object.entries(m)) snap.ifs[`${d}|${n}`] = { up: !!st.up, proto: !!st.proto, reason: st.reason };
  for (const [d, o] of Object.entries(S.ospf)) for (const nb of o.nbrs) snap.ospf[`${d}|${nb.if}|${nb.rid}`] = nb.state;
  for (const [d, list] of Object.entries(S.bgp)) for (const b of list) snap.bgp[`${d}|${b.ip}`] = b.state;
  for (const [d, m] of Object.entries(S.fhrp)) for (const [n, f] of Object.entries(m)) snap.fhrp[`${d}|${n}`] = f.state;
  for (const [d, m] of Object.entries(S.lags)) for (const [n, l] of Object.entries(m)) for (const [mem, st] of Object.entries(l.members)) snap.lag[`${d}|${n}|${mem}`] = st;
  for (const [d, m] of Object.entries(S.stp.blocked)) for (const [n, set] of Object.entries(m)) for (const v of set) snap.blocked[`${d}|${n}|${v}`] = true;
  for (const [d, a] of Object.entries(S.wifi.aps || {})) snap.wifi[d] = a.state;
  return snap;
}

// Recompute and log every difference since the previous snapshot
export function recompute(world) {
  const prev = world.lastSnap || null;
  compute(world);
  const cur = snapshot(world);
  world.lastSnap = cur;
  if (!prev) return;
  const D = world.devices;
  const S = world.sim;
  for (const [k, st] of Object.entries(cur.ifs)) {
    const [d, n] = k.split('|');
    const was = prev.ifs[k];
    const ifc = D[d]?.cfg.ifs[n];
    if (!ifc || ifc.kind === 'lo') continue;
    if (!was) continue;
    if (was.up !== st.up) logEvent(world, d, { type: 'link', if: n, up: st.up, admin: st.reason === 'admin', kind: ifc.kind });
    if (was.proto !== st.proto) logEvent(world, d, { type: 'proto', if: n, up: st.proto, kind: ifc.kind });
  }
  for (const e of S.errdis) logEvent(world, e.dev, { type: 'errdis', if: e.if, reason: e.reason, mac: macFor(`rogue:${e.dev}:${e.if}`) });
  S.errdis = [];
  const keys = new Set([...Object.keys(prev.ospf), ...Object.keys(cur.ospf)]);
  for (const k of keys) {
    if (prev.ospf[k] === cur.ospf[k]) continue;
    const [d, n, rid] = k.split('|');
    const why = (S.ospf[d]?.problems || []).find((p) => p.if === n)?.why;
    logEvent(world, d, { type: 'ospf', if: n, nbr: rid, from: prev.ospf[k] || 'DOWN', to: cur.ospf[k] || 'DOWN', why: cur.ospf[k] ? '' : why || 'Dead timer expired' });
  }
  for (const k of new Set([...Object.keys(prev.bgp), ...Object.keys(cur.bgp)])) {
    if (prev.bgp[k] === cur.bgp[k]) continue;
    const [d, ip] = k.split('|');
    const rec = (S.bgp[d] || []).find((b) => b.ip === ip);
    const up = cur.bgp[k] === 'Established';
    const wasUp = prev.bgp[k] === 'Established';
    if (up !== wasUp) logEvent(world, d, { type: 'bgp', nbr: ip, up, why: rec?.reason || '', notify: rec?.notify || null, ras: rec?.ras });
  }
  for (const [k, st] of Object.entries(cur.fhrp)) {
    if (prev.fhrp[k] && prev.fhrp[k] !== st) {
      const [d, n] = k.split('|');
      const f = S.fhrp[d][n];
      logEvent(world, d, { type: 'fhrp', if: n, grp: f.grp, from: prev.fhrp[k], to: st, proto: f.proto });
    }
  }
  for (const [k, st] of Object.entries(cur.lag)) {
    if (prev.lag[k] && prev.lag[k] !== st) {
      const [d, lag, mem] = k.split('|');
      logEvent(world, d, { type: 'lacp', if: mem, lag, state: st });
    }
  }
  for (const k of Object.keys(cur.blocked)) if (!prev.blocked[k]) {
    const [d, n, v] = k.split('|');
    logEvent(world, d, { type: 'stp', if: n, vlan: Number(v), state: 'blocking' });
  }
  for (const k of Object.keys(prev.blocked)) if (!cur.blocked[k]) {
    const [d, n, v] = k.split('|');
    if (D[d]) logEvent(world, d, { type: 'stp', if: n, vlan: Number(v), state: 'forwarding' });
  }
  for (const [d, st] of Object.entries(cur.wifi)) if (prev.wifi[d] && prev.wifi[d] !== st && S.wifi.ctrl) logEvent(world, S.wifi.ctrl, { type: 'ap', ap: D[d]?.hostname, ip: S.wifi.aps[d].ip, up: st === 'up', why: S.wifi.aps[d].why });
}

// Periodic "nagging" messages a real network repeats while a condition persists (CDP mismatches, MAC flaps)
export function periodic(world) {
  const S = world.sim;
  if (!S) return;
  const D = world.devices;
  for (const L of world.links) {
    if (!L.a.dev || !L.b.dev) continue;
    const st = S.links[L.id];
    if (!st?.up) continue;
    const A = D[L.a.dev];
    const B = D[L.b.dev];
    const ia = A?.cfg.ifs[L.a.if];
    const ib = B?.cfg.ifs[L.b.if];
    if (!ia || !ib) continue;
    if (st.duplex === 'mismatch') {
      for (const [x, ix, y, iy, me, them] of [[A, ia, B, ib, L.a, L.b], [B, ib, A, ia, L.b, L.a]]) {
        void iy;
        logEvent(world, x.id, { type: 'duplex', if: me.if, peer: y.hostname, peerIf: them.if, mine: ix.duplex === 'auto' ? 'half' : ix.duplex, theirs: 'full' });
      }
    }
    if (ia.sw?.mode === 'trunk' && ib.sw?.mode === 'trunk' && ia.sw.native !== ib.sw.native) {
      logEvent(world, A.id, { type: 'native', if: L.a.if, mine: ia.sw.native, theirs: ib.sw.native, peer: B.hostname, peerIf: L.b.if });
      logEvent(world, B.id, { type: 'native', if: L.b.if, mine: ib.sw.native, theirs: ia.sw.native, peer: A.hostname, peerIf: L.a.if });
    }
  }
  for (const node of S.stp.storm) {
    const [d, v] = node.split('#');
    const dev = D[d];
    if (!dev) continue;
    const ports = Object.keys(dev.cfg.ifs).filter((n) => dev.cfg.ifs[n].sw && S.ifs[d][n]?.up).slice(0, 2);
    if (ports.length === 2) logEvent(world, d, { type: 'macflap', vlan: Number(v), mac: macFor(`flap:${d}:${v}`), if1: ports[0], if2: ports[1] });
  }
  for (const [d, o] of Object.entries(S.ospf)) for (const p of o.problems || []) if (/area|authentication/.test(p.why)) logEvent(world, d, { type: 'ospfErr', if: p.if, from: p.peer, why: p.why });
}
