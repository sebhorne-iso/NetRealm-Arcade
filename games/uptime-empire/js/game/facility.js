// The data hall: racks with A/B power feeds, UPS, generator, cooling and temperatures, plus the
// hands-on physical actions (reseat cables, swap PSUs, clean optics, reset breakers...).
import { model } from '../net/catalog.js';
import { powerOff, powerOn } from '../net/devops.js';
import { logEvent, recompute } from '../net/events.js';
import { yearOf } from '../core/util.js';

let FAC = null;
export const setFacilities = (j) => (FAC = j);
export const facilities = () => FAC;
const item = (list, id) => FAC[list].find((x) => x.id === id);

export function initFacility(world) {
  const y = yearOf(world.time.t);
  world.facility = {
    slots: FAC.floor.startSlots,
    racks: [],
    cooling: [{ uid: 'K1', id: y >= 1995 ? 'split5' : 'split5', ok: true }],
    ups: [{ uid: 'U1', id: 'ups3', health: 1, charge: 1 }],
    generator: null,
    mains: true,
    roomTemp: 22,
    nextRack: 1,
  };
  addRack(world);
  world.spares = { psu: 1, fan: 1, optic: 2, cable: 10 };
}
export function addRack(world, pdu = 'pdu16') {
  const f = world.facility;
  if (f.racks.length >= f.slots) return null;
  const used = new Set(f.racks.map((r) => r.slot));
  let slot = 0;
  while (used.has(slot)) slot++;
  const r = { id: `R${f.nextRack++}`, slot, pdu, trippedA: false, trippedB: false };
  f.racks.push(r);
  return r;
}
export const devWatts = (dev) => (dev.state === 'off' ? 0 : model(dev.model).watts || 100);
export function rackDevices(world, rackId) {
  return Object.values(world.devices).filter((d) => d.rack === rackId).sort((a, b) => b.u - a.u);
}
export function rackLoad(world, rack) {
  let a = 0;
  let b = 0;
  for (const d of rackDevices(world, rack.id)) {
    const w = devWatts(d);
    if (d.hw.psus.length > 1) {
      a += w / 2;
      b += w / 2;
    } else a += w;
  }
  const cap = item('pdus', rack.pdu).amps * FAC.power.voltage;
  return { a, b, cap, total: a + b };
}
// First free U range that fits the device, in a rack with enough power headroom
export function placeDevice(world, dev) {
  const m = model(dev.model);
  const need = Math.max(1, m.u || 1);
  for (const r of world.facility.racks) {
    const occ = new Set();
    for (const d of rackDevices(world, r.id)) for (let k = 0; k < Math.max(1, model(d.model).u || 1); k++) occ.add(d.u + k);
    const load = rackLoad(world, r);
    if (load.a + (m.watts || 100) > load.cap * 0.95) continue;
    for (let u = 40; u >= 1; u--) {
      let ok = true;
      for (let k = 0; k < need; k++) if (occ.has(u + k) || u + k > 42) ok = false;
      if (ok) {
        dev.rack = r.id;
        dev.u = u;
        return r;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Power & cooling (called by the game loop with minutes elapsed)
export function heatKw(world) {
  const dev = Object.values(world.devices).reduce((s, d) => s + devWatts(d), 0);
  const srv = Object.values(world.hosts).filter((h) => h.kind === 'server' || h.kind === 'svc').reduce((s, h) => s + (h.watts || 200), 0);
  return (dev + srv) / 1000;
}
export const coolingKw = (world) => world.facility.cooling.filter((c) => c.ok).reduce((s, c) => s + item('cooling', c.id).kw, 0);
export const upsKw = (world) => world.facility.ups.reduce((s, u) => s + item('ups', u.id).kw * u.health, 0);

export function tickFacility(world, mins) {
  const f = world.facility;
  let changed = false;
  // UPS / generator
  const load = heatKw(world);
  let feedsLive = true;
  if (!f.mains) {
    if (f.generator && f.generator.fuel > 0 && f.generator.ok !== false) {
      f.generator.fuel = Math.max(0, f.generator.fuel - mins / 60);
    } else {
      const ups = f.ups[0];
      const cap = upsKw(world);
      if (ups && cap >= Math.min(load, cap)) {
        const runtime = item('ups', ups.id).minutes * ups.health * Math.min(2, cap / Math.max(0.5, load));
        ups.charge = Math.max(0, ups.charge - mins / Math.max(1, runtime));
        if (ups.charge <= 0) feedsLive = false;
      } else feedsLive = false;
    }
  } else for (const u of f.ups) u.charge = Math.min(1, u.charge + mins / 240);
  f.feedsLive = feedsLive;
  // Room temperature drifts towards an equilibrium set by heat vs cooling
  const cool = coolingKw(world);
  const target = 21 + Math.max(0, (load - cool) * 4.5) + (cool === 0 ? 20 : 0);
  f.roomTemp += (target - f.roomTemp) * Math.min(1, mins / 45);
  // Device power + temperature
  for (const d of Object.values(world.devices)) {
    const r = f.racks.find((x) => x.id === d.rack);
    const aLive = feedsLive && !(r?.trippedA);
    const bLive = feedsLive && !(r?.trippedB);
    const psus = d.hw.psus;
    const powered = psus.length > 1 ? (psus[0] && aLive) || (psus[1] && bLive) : psus[0] && aLive;
    const fanPenalty = d.hw.fans.filter((x) => !x).length * 17;
    d.hw.temp = f.roomTemp + 8 + fanPenalty;
    if (!powered && d.state !== 'off') {
      powerOff(world, d);
      d.offReason = 'power';
      changed = true;
    } else if (powered && d.state === 'off' && (d.offReason === 'power' || d.offReason === 'thermal') && d.hw.temp < 55) {
      d.offReason = null;
      powerOn(world, d, 'power-on');
      changed = true;
    }
    if (d.state === 'up' && d.hw.temp > 68) {
      logEvent(world, d.id, { type: 'temp', temp: Math.round(d.hw.temp), limit: 68 });
      powerOff(world, d);
      d.offReason = 'thermal';
      changed = true;
    } else if (d.state === 'up' && d.hw.temp > 50 && Math.random() < mins / 120) logEvent(world, d.id, { type: 'temp', temp: Math.round(d.hw.temp), limit: 50 });
    // PSU alarms
    for (let k = 0; k < psus.length; k++) {
      const live = psus[k] && (k === 0 ? aLive : bLive);
      const key = `psu${k}`;
      d.run.alarm = d.run.alarm || {};
      if (d.state === 'up' && d.run.alarm[key] !== !live) {
        if (!live || d.run.alarm[key]) logEvent(world, d.id, { type: 'psu', n: k + 1, ok: live });
        d.run.alarm[key] = !live;
      }
    }
  }
  if (changed) {
    world.dirty = true;
    recompute(world);
  }
  return changed;
}

// ---------------------------------------------------------------------------------------------
// Physical actions. Each returns a message for the UI.
const spend = (world, what) => {
  if ((world.spares[what] || 0) > 0) {
    world.spares[what]--;
    return true;
  }
  const s = FAC.spares.find((x) => x.id === what);
  if (world.cash >= s.price * 2) {
    world.cash -= s.price * 2;
    (world.ledger = world.ledger || []).push({ t: world.time.t, kind: 'spares', amount: -s.price * 2, note: `Emergency ${s.name} (courier)` });
    return true;
  }
  return false;
};
export const PHYS = {
  reseat(world, { link }) {
    const l = world.links.find((x) => x.id === link);
    if (!l) return 'No such cable.';
    if (l.cable.ok !== false) return `Cable ${l.cable.id} was already seated. Click.`;
    l.cable.ok = true;
    world.dirty = true;
    recompute(world);
    return `You reseat cable ${l.cable.id}. The port LED turns green.`;
  },
  'replace-psu'(world, { dev }) {
    const d = world.devices[dev];
    if (d.hw.psus.every(Boolean)) return 'Both power supplies show a green LED.';
    if (!spend(world, 'psu')) return 'No spare PSU and not enough cash for an emergency courier.';
    d.hw.psus = d.hw.psus.map(() => true);
    if (d.state === 'off' && d.offReason !== 'thermal') {
      d.offReason = 'power';
    }
    return `Hot-swapped the failed power supply in ${d.hostname}.`;
  },
  'replace-fan'(world, { dev }) {
    const d = world.devices[dev];
    if (d.hw.fans.every(Boolean)) return 'All fans are spinning.';
    if (!spend(world, 'fan')) return 'No spare fan tray and not enough cash for an emergency courier.';
    d.hw.fans = d.hw.fans.map(() => true);
    return `Replaced the fan tray in ${d.hostname}.`;
  },
  'remove-rogue'(world, { host }) {
    const h = world.hosts[host];
    if (!h?.rogueSwitch) return 'Nothing unexpected on this cable.';
    h.rogueSwitch = false;
    world.dirty = true;
    recompute(world);
    return `You find a little unmanaged desktop switch between ${h.name} and the patch panel and remove it. (The switch port is still err-disabled.)`;
  },
  'clean-optic'(world, { dev, if: ifn }) {
    const d = world.devices[dev];
    if (!d.hw.optics[ifn]) return 'The optic end face looks clean.';
    if (!spend(world, 'optic')) return 'No cleaning kit/spare optic available.';
    delete d.hw.optics[ifn];
    world.dirty = true;
    recompute(world);
    return `Cleaned the fibre connectors on ${d.hostname} ${ifn}. Receive power is back to normal.`;
  },
  'reset-breaker'(world, { rack }) {
    const r = world.facility.racks.find((x) => x.id === rack);
    if (!r.trippedA && !r.trippedB) return 'Both breakers are on.';
    const load = rackLoad(world, r);
    r.trippedA = false;
    r.trippedB = false;
    world.dirty = true;
    tickFacility(world, 0);
    return load.a > load.cap ? `Breaker reset - but feed A is overloaded (${Math.round(load.a)} W of ${load.cap} W). It will trip again.` : `Breaker reset on rack ${rack}. Devices are booting.`;
  },
  'repair-cooling'(world, { unit }) {
    const c = world.facility.cooling.find((x) => x.uid === unit);
    if (c.ok) return 'The unit is running normally.';
    const cost = Math.round(item('cooling', c.id).price * 0.08);
    world.cash -= cost;
    (world.ledger = world.ledger || []).push({ t: world.time.t, kind: 'repairs', amount: -cost, note: `Cooling repair ${c.uid}` });
    c.ok = true;
    return `HVAC engineer replaced the compressor contactor on ${c.uid} ($${cost}).`;
  },
  'power-cycle'(world, { dev }) {
    const d = world.devices[dev];
    powerOff(world, d);
    d.offReason = 'manual';
    powerOn(world, d, 'power-on');
    d.state = 'booting';
    return `Pulled the power on ${d.hostname} and plugged it back in. Unsaved configuration is lost.`;
  },
};
export function physAction(world, action, args) {
  const fn = PHYS[action];
  return fn ? fn(world, args) : 'Unknown action.';
}
