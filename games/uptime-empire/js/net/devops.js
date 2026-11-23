// Device lifecycle operations shared by the CLI and the game: reload/boot, power, firmware.
import { logEvent, recompute } from './events.js';
import { model } from './catalog.js';

const BOOT_MINS = { ios: 1, iosxe: 1.5, nxos: 2, asa: 1.2, iosxr: 2.5, junos: 2, evo: 2.5, aoscx: 1.5, aoss: 0.8, arubaos: 1.5, fortios: 1, fortiswitch: 1, fortiap: 0.8, apos: 0.8 };
export const bootMins = (dev) => BOOT_MINS[dev.os] ?? 1;

export function reload(world, dev, { reason = 'Reload command', version = null } = {}) {
  dev.state = 'booting';
  dev.bootUntil = world.time.t + bootMins(dev);
  if (version) dev.version = version;
  if (dev.startup) dev.cfg = JSON.parse(JSON.stringify(dev.startup));
  dev.run.errdis = {};
  dev.run.fhrp = {};
  dev.run.arp = {};
  dev.run.reloadReason = reason;
  world.dirty = true;
  recompute(world);
}
export function powerOff(world, dev) {
  dev.state = 'off';
  world.dirty = true;
  recompute(world);
}
export function powerOn(world, dev, reason = 'power-on') {
  if (dev.state !== 'off') return;
  reload(world, dev, { reason });
}
// Called by the game loop
export function tickDevices(world) {
  let changed = false;
  for (const dev of Object.values(world.devices)) {
    // Junos "commit confirmed" that nobody confirmed: roll back automatically
    if (dev.run.confirmUntil && world.time.t >= dev.run.confirmUntil && dev.run.rollback[0]) {
      dev.cfg = JSON.parse(JSON.stringify(dev.run.rollback[0].cfg));
      dev.run.confirmUntil = null;
      logEvent(world, dev.id, { type: 'autorollback' });
      changed = true;
    }
    if (dev.state === 'booting' && world.time.t >= dev.bootUntil) {
      dev.state = 'up';
      dev.run.boot = world.time.t;
      dev.run.counters = {};
      changed = true;
      logEvent(world, dev.id, { type: 'boot', reason: dev.run.reloadReason || 'power-on', version: dev.version });
    }
  }
  if (changed) {
    world.dirty = true;
    recompute(world);
  }
  return changed;
}
export const isRouterish = (dev) => model(dev.model).feat.includes('l3');
