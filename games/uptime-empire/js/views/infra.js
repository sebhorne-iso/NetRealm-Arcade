// Floor (pixel data hall), rack elevations, device panel with physical inspection, and the
// network topology diagram.
import { h, fill, btn, modal, money, table, pill } from '../ui/dom.js';
import { model, VENDOR_COLORS, shortIf } from '../net/catalog.js';
import { rackDevices, rackLoad, heatKw, coolingKw, physAction, facilities } from '../game/facility.js';
import { firmwareOptions, scheduleFirmware, scheduleDecom, DIFF } from '../game/game.js';
import { optics } from '../cli/common.js';
import { unsaved } from '../net/model.js';
import { recompute } from '../net/events.js';

const SLOT_W = 92;
const SLOT_H = 170;

// =============================================================================================
export const FloorView = {
  title: 'Data hall',
  mount(app, el) {
    this.app = app;
    this.canvas = h('canvas.floor', { width: 8 * SLOT_W + 40, height: 2 * SLOT_H + 150, 'aria-label': 'Data hall floor plan: click a rack' });
    this.side = h('div.rackpane');
    this.canvas.addEventListener('click', (e) => this.click(e));
    fill(el, h('div.floorwrap', {}, h('div.floorleft', {}, h('div.viewhead', {}, h('h2', {}, 'Data hall'), h('span.muted', {}, 'Click a rack to open its elevation; click a cooling unit to inspect it.')), this.canvas, h('div.legend', {}, legend())), this.side));
    this.sel = app.state.rack || app.w.facility.racks[0]?.id;
    this.renderRack();
    this.draw();
  },
  tick() {
    this.draw();
    if (this.frame++ % 4 === 0) this.renderRack();
  },
  frame: 0,
  slotXY(slot) {
    return { x: 20 + (slot % 8) * SLOT_W, y: 20 + Math.floor(slot / 8) * SLOT_H };
  },
  draw() {
    const w = this.app.w;
    const c = this.canvas.getContext('2d');
    c.imageSmoothingEnabled = false;
    const W = this.canvas.width;
    const H = this.canvas.height;
    // raised floor tiles
    c.fillStyle = '#1a1d33';
    c.fillRect(0, 0, W, H);
    for (let x = 0; x < W; x += 20) for (let y = 0; y < H; y += 20) {
      c.fillStyle = (x / 20 + y / 20) % 2 ? '#1f2340' : '#1c2039';
      c.fillRect(x, y, 20, 20);
    }
    const blink = Math.floor(Date.now() / 400) % 2;
    const F = facilities();
    for (let s = 0; s < F.floor.slots; s++) {
      const { x, y } = this.slotXY(s);
      const rack = w.facility.racks.find((r) => r.slot === s);
      if (s >= w.facility.slots) {
        c.fillStyle = 'rgba(0,0,0,0.45)';
        c.fillRect(x + 4, y + 4, SLOT_W - 16, SLOT_H - 30);
        c.fillStyle = '#4b4f72';
        c.font = '10px "Press Start 2P", monospace';
        c.fillText('LEASE', x + 14, y + 70);
        continue;
      }
      if (!rack) {
        c.strokeStyle = '#3d4370';
        c.setLineDash([4, 4]);
        c.strokeRect(x + 6, y + 6, SLOT_W - 20, SLOT_H - 34);
        c.setLineDash([]);
        continue;
      }
      // rack frame
      const sel = rack.id === this.sel;
      c.fillStyle = sel ? '#ffd447' : '#0c0d16';
      c.fillRect(x + 2, y + 2, SLOT_W - 12, SLOT_H - 26);
      c.fillStyle = '#23263a';
      c.fillRect(x + 6, y + 6, SLOT_W - 20, SLOT_H - 34);
      const uh = (SLOT_H - 40) / 42;
      for (const d of rackDevices(w, rack.id)) {
        const m = model(d.model);
        const col = VENDOR_COLORS[d.vendor] || VENDOR_COLORS.Cisco;
        const top = y + 8 + (42 - (d.u + (m.u || 1) - 1)) * uh;
        const hgt = Math.max(2, (m.u || 1) * uh - 1);
        c.fillStyle = d.state === 'off' ? '#2a2a2a' : col.face;
        c.fillRect(x + 8, top, SLOT_W - 24, hgt);
        c.fillStyle = col.trim;
        c.fillRect(x + 8, top, 3, hgt);
        // LEDs
        const S = w.sim;
        const st = S?.ifs[d.id] || {};
        const ports = Object.keys(d.cfg.ifs).filter((n) => d.cfg.ifs[n].kind === 'phys').slice(0, 12);
        ports.forEach((n, k) => {
          const p = st[n];
          c.fillStyle = d.state !== 'up' ? '#333' : d.run.errdis[n] ? '#ffb020' : p?.up ? (blink && (k + Math.floor(Date.now() / 300)) % 3 ? '#38ff7a' : '#1d8f45') : '#111';
          c.fillRect(x + 14 + k * 5, top + Math.max(0, hgt / 2 - 1), 3, 2);
        });
        const alarm = !d.hw.psus.every(Boolean) || !d.hw.fans.every(Boolean) || d.state === 'off';
        c.fillStyle = d.state === 'booting' ? (blink ? '#ffd447' : '#554') : alarm ? (blink ? '#ff3b4f' : '#611') : '#38ff7a';
        c.fillRect(x + SLOT_W - 22, top + 1, 3, 2);
      }
      // PDU strip status
      c.fillStyle = rack.trippedA || rack.trippedB ? (blink ? '#ff3b4f' : '#400') : '#3b8';
      c.fillRect(x + SLOT_W - 14, y + 10, 2, SLOT_H - 44);
      c.fillStyle = '#c9cbe0';
      c.font = '8px "Press Start 2P", monospace';
      c.fillText(rack.id, x + 10, y + SLOT_H - 12);
      const load = rackLoad(w, rack);
      c.fillStyle = load.a > load.cap * 0.85 ? '#ff7b5c' : '#8890c0';
      c.fillText(`${(load.total / 1000).toFixed(1)}kW`, x + 36, y + SLOT_H - 12);
    }
    // plant row
    const py = 2 * SLOT_H + 30;
    c.font = '8px "Press Start 2P", monospace';
    this.plant = [];
    w.facility.cooling.forEach((u, k) => {
      const x = 20 + k * 110;
      c.fillStyle = u.ok ? '#5a7fa8' : '#6b3940';
      c.fillRect(x, py, 96, 60);
      c.fillStyle = '#0d1020';
      c.beginPath();
      c.arc(x + 28, py + 30, 18, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = u.ok ? '#bfe3ff' : '#ff3b4f';
      const a = u.ok ? Date.now() / 120 : 0;
      for (let b = 0; b < 3; b++) {
        c.beginPath();
        c.moveTo(x + 28, py + 30);
        c.lineTo(x + 28 + Math.cos(a + (b * 2 * Math.PI) / 3) * 15, py + 30 + Math.sin(a + (b * 2 * Math.PI) / 3) * 15);
        c.stroke();
      }
      c.fillStyle = '#fff';
      c.fillText(u.uid, x + 54, py + 20);
      c.fillStyle = u.ok ? '#9f9' : blink ? '#f55' : '#a33';
      c.fillText(u.ok ? 'OK' : 'FAULT', x + 54, py + 40);
      this.plant.push({ x, y: py, w: 96, h: 60, kind: 'cooling', id: u.uid });
    });
    const ux = 20 + w.facility.cooling.length * 110;
    for (const u of w.facility.ups) {
      c.fillStyle = '#3a3f5c';
      c.fillRect(ux, py, 70, 60);
      c.fillStyle = '#0d1020';
      c.fillRect(ux + 10, py + 38, 50, 10);
      c.fillStyle = u.charge > 0.5 ? '#38ff7a' : '#ffb020';
      c.fillRect(ux + 11, py + 39, 48 * u.charge, 8);
      c.fillStyle = '#fff';
      c.fillText('UPS', ux + 20, py + 22);
    }
    if (w.facility.generator) {
      const gx = ux + 90;
      c.fillStyle = '#5c5a30';
      c.fillRect(gx, py, 90, 60);
      c.fillStyle = '#fff';
      c.fillText('GENSET', gx + 12, py + 22);
      c.fillText(`${w.facility.generator.fuel.toFixed(1)}h`, gx + 18, py + 44);
    }
    c.fillStyle = w.facility.roomTemp > 30 ? '#ff7b5c' : '#c9cbe0';
    c.fillText(`ROOM ${w.facility.roomTemp.toFixed(1)}C  HEAT ${heatKw(w).toFixed(1)}kW / COOL ${coolingKw(w)}kW  MAINS ${w.facility.mains ? 'ON' : 'OFF'}`, 20, H - 12);
  },
  click(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) * this.canvas.width) / r.width;
    const y = ((e.clientY - r.top) * this.canvas.height) / r.height;
    for (const p of this.plant || []) if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) return coolingPanel(this.app, p.id);
    const w = this.app.w;
    for (const rack of w.facility.racks) {
      const { x: rx, y: ry } = this.slotXY(rack.slot);
      if (x >= rx && x <= rx + SLOT_W - 10 && y >= ry && y <= ry + SLOT_H - 24) {
        this.sel = rack.id;
        this.app.state.rack = rack.id;
        this.renderRack();
        this.draw();
        return;
      }
    }
  },
  renderRack() {
    const w = this.app.w;
    const rack = w.facility.racks.find((r) => r.id === this.sel);
    if (!rack) return fill(this.side, h('p.muted', {}, 'No rack selected.'));
    const load = rackLoad(w, rack);
    const rows = [];
    const devs = rackDevices(w, rack.id);
    const at = new Map();
    for (const d of devs) at.set(d.u + (model(d.model).u || 1) - 1, d);
    for (let u = 42; u >= 1; u--) {
      const d = at.get(u);
      if (d) {
        const m = model(d.model);
        const col = VENDOR_COLORS[d.vendor] || VENDOR_COLORS.Cisco;
        rows.push(h('div.ru.dev', { style: { height: `${(m.u || 1) * 15}px`, background: d.state === 'off' ? '#2b2b2b' : col.face, borderLeft: `5px solid ${col.trim}` }, onclick: () => devicePanel(this.app, d.id), title: `${d.hostname} - ${m.name}` }, h('span.ulabel', {}, `U${d.u}`), h('span.dname', {}, d.hostname), h('span.dmodel', {}, m.name), portLeds(w, d), h('span.dstate', {}, d.state === 'up' ? '' : d.state.toUpperCase())));
        u -= (m.u || 1) - 1;
      } else rows.push(h('div.ru.empty', {}, h('span.ulabel', {}, `U${u}`)));
    }
    const F = facilities();
    const pdu = F.pdus.find((p) => p.id === rack.pdu);
    fill(this.side, h('div.viewhead', {}, h('h3', {}, `Rack ${rack.id}`), h('span.muted', {}, `${pdu.name}`)), h('div.rackinfo', {}, h('div', {}, `Feed A: ${Math.round(load.a)} W / ${load.cap} W `, rack.trippedA ? pill('TRIPPED', 'bad') : pill('on', 'good')), h('div', {}, `Feed B: ${Math.round(load.b)} W / ${load.cap} W `, rack.trippedB ? pill('TRIPPED', 'bad') : pill('on', 'good')), rack.trippedA || rack.trippedB ? btn('Reset PDU breaker', () => (this.app.say(physAction(w, 'reset-breaker', { rack: rack.id })), this.app.refresh()), 'warn') : null), h('div.rack', {}, rows));
  },
};
function legend() {
  return [h('span.lg.g', {}, 'link up'), h('span.lg.a', {}, 'err-disabled'), h('span.lg.r', {}, 'alarm'), h('span.lg.y', {}, 'booting')];
}
function portLeds(w, d) {
  const st = w.sim?.ifs[d.id] || {};
  const ports = Object.keys(d.cfg.ifs).filter((n) => ['phys', 'mgmt', 'serial'].includes(d.cfg.ifs[n].kind)).slice(0, 52);
  return h('span.leds', {}, ports.map((n) => h(`i.${d.state !== 'up' ? 'off' : d.run.errdis[n] ? 'amber' : st[n]?.up ? 'on' : 'off'}`, { title: n })));
}
function coolingPanel(app, uid) {
  const w = app.w;
  const u = w.facility.cooling.find((c) => c.uid === uid);
  const it = facilities().cooling.find((c) => c.id === u.id);
  modal(`Cooling unit ${u.uid}`, h('div', {}, h('p', {}, `${it.name}. Status: `, u.ok ? pill('running', 'good') : pill('compressor fault', 'bad')), h('p.muted', {}, `Room ${w.facility.roomTemp.toFixed(1)} C. Heat load ${heatKw(w).toFixed(1)} kW, working cooling ${coolingKw(w)} kW.`)), { actions: u.ok ? [['Close', () => {}]] : [['Call HVAC engineer', () => app.say(physAction(w, 'repair-cooling', { unit: uid }))], ['Close', () => {}]] });
}

// =============================================================================================
// Device panel: identity, physical inspection, hands-on actions
export function devicePanel(app, devId) {
  const w = app.w;
  const d = w.devices[devId];
  if (!d) return;
  const m = model(d.model);
  recompute(w);
  const S = w.sim;
  const D = DIFF[w.difficulty];
  const ports = Object.keys(d.cfg.ifs).filter((n) => ['phys', 'mgmt', 'serial'].includes(d.cfg.ifs[n].kind));
  const rows = [];
  for (const n of ports) {
    const st = S.ifs[d.id][n] || {};
    const link = w.links.find((l) => (l.a.dev === d.id && l.a.if === n) || (l.b.dev === d.id && l.b.if === n));
    if (!link && !st.up) continue;
    const peer = link ? (link.a.dev === d.id && link.a.if === n ? link.b : link.a) : null;
    const peerName = peer?.dev ? `${w.devices[peer.dev]?.hostname} ${peer.if}` : peer?.host ? w.hosts[peer.host]?.name : '';
    const o = optics(d, n);
    const cableState = link ? (link.cable?.ok === false ? 'loose - not clicked in!' : 'seated') : 'no cable';
    const rogue = peer?.host && w.hosts[peer.host]?.rogueSwitch;
    const led = d.state !== 'up' ? 'off' : d.run.errdis[n] ? 'amber' : st.up ? 'green' : 'off';
    const acts = [];
    if (link?.cable?.ok === false) acts.push(btn('Reseat', () => act('reseat', { link: link.id }), 'small'));
    if (o && d.hw.optics[n]) acts.push(btn('Clean optic', () => act('clean-optic', { dev: d.id, if: n }), 'small'));
    if (rogue) acts.push(btn('Remove unknown device', () => act('remove-rogue', { host: peer.host }), 'small warn'));
    rows.push([n, pill(led, led === 'green' ? 'good' : led === 'amber' ? 'warn' : 'off'), link?.cable?.id || '-', cableState + (rogue ? ' + an unmanaged desktop switch spliced in' : ''), peerName, o ? `${o.type} RX ${o.rx <= -40 ? 'LOS' : `${o.rx.toFixed(1)} dBm`}${o.rx < -10.5 ? ' (dirty?)' : ''}` : '', h('td', {}, acts)]);
  }
  function act(a, args) {
    const msg = physAction(w, a, args);
    app.say(msg);
    box.close();
    devicePanel(app, devId);
    app.refresh();
  }
  const fw = firmwareOptions(w, d);
  const adv = w.advisoryHits?.[d.id] || [];
  const info = h('div.devinfo', {}, h('div.devhead', { style: { borderLeftColor: VENDOR_COLORS[d.vendor]?.trim } }, h('div', {}, h('b', {}, d.hostname), ` ${m.name}`), h('div.muted', {}, `${d.vendor} · ${m.desc || ''}`), h('div', {}, `Role ${d.role} · Rack ${d.rack} U${d.u} · Serial ${d.hw.serial}`), h('div', {}, `Firmware ${d.version}${adv.length ? ` · ${adv.length} open advisor${adv.length > 1 ? 'ies' : 'y'}` : ''} · Mgmt ${w.design.mgmt[d.id] || 'none'} · `, d.state === 'up' ? pill('up', 'good') : pill(d.state, 'bad'), unsaved(d) ? pill('unsaved config', 'warn') : null), h('div', {}, 'PSUs ', d.hw.psus.map((ok, k) => pill(`PSU${k + 1} ${ok ? 'OK' : 'FAIL'}`, ok ? 'good' : 'bad')), ' Fans ', d.hw.fans.every(Boolean) ? pill('OK', 'good') : pill('FAIL', 'bad'), ` ${Math.round(d.hw.temp)} °C`), m.eol && m.eol < new Date(Date.UTC(1995, 0, 1) + w.time.t * 60000).getUTCFullYear() ? h('div.warnline', {}, `End of life since ${m.eol}: no more firmware or support.`) : null));
  const actions = h('div.btnrow', {}, btn('Console', () => (box.close(), app.dock.open(d.hostname)), 'primary'), d.role !== 'ap' ? btn('SSH from jump01', () => {
    box.close();
    const t = app.dock.open();
    t.type([`ssh admin@${d.hostname}`]);
  }) : null, !d.hw.psus.every(Boolean) ? btn(`Replace PSU (${w.spares.psu || 0} spare)`, () => act('replace-psu', { dev: d.id }), 'warn') : null, !d.hw.fans.every(Boolean) ? btn(`Replace fan (${w.spares.fan || 0} spare)`, () => act('replace-fan', { dev: d.id }), 'warn') : null, btn('Power cycle', () => {
    if (confirm(`Pull the power on ${d.hostname}? Anything not saved to startup is lost.`)) act('power-cycle', { dev: d.id });
  }), fw.length ? btn('Schedule firmware upgrade', () => {
    const sel = h('select', {}, fw.map((v) => h('option', { value: v }, v)));
    modal(`Upgrade ${d.hostname}`, h('div', {}, h('p', {}, `Running ${d.version}. The device reloads into the new image during the next maintenance window (02:00). Save the configuration first - a reload loads the startup config.`), h('label', {}, 'Target release ', sel)), { actions: [['Schedule', () => (scheduleFirmware(w, d.id, sel.value), app.say('Upgrade queued in Changes.'), app.refresh())], ['Cancel', () => {}]] });
  }) : null, btn('Decommission', () => {
    if (confirm(`Decommission ${d.hostname}? It will be removed in the next maintenance window.`)) {
      scheduleDecom(w, d.id);
      app.say('Decommission queued in Changes.');
    }
  }, 'danger'));
  const box = modal(`${d.hostname}`, h('div', {}, info, actions, h('h3', {}, 'Physical inspection'), h('p.muted', {}, D.label === 'Expert' ? 'You are standing in front of the rack. What do you see?' : 'Port LEDs, cable labels and optics as seen at the rack.'), rows.length ? table(['Port', 'LED', 'Cable', 'Cable state', 'Patched to', 'Optic', ''], rows) : h('p', {}, 'Nothing cabled.')), { wide: true });
}

// =============================================================================================
// Network topology diagram (SVG)
const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
};
export const NetworkView = {
  title: 'Network',
  mount(app, el) {
    this.app = app;
    this.el = el;
    this.render();
  },
  tick() {
    if (this.n++ % 3 === 0) this.render();
  },
  n: 0,
  render() {
    const w = this.app.w;
    recompute(w);
    const S = w.sim;
    const expert = w.difficulty === 'expert';
    const docErr = new Map((w.design.docErrors || []).filter((e) => e.doc === 'topo').map((e) => [e.link, e.kind]));
    const layers = [['isp'], ['edge'], ['fw'], ['core', 'wlc'], ['access', 'ap'], ['server']];
    const pos = {};
    const nodes = [];
    const Wd = 1100;
    const rowY = (i) => 40 + i * 92;
    const isps = Object.values(w.hosts).filter((x) => x.kind === 'isp');
    const place = (items, y, kind) => items.forEach((it, k) => {
      const x = (Wd * (k + 1)) / (items.length + 1);
      pos[it.id] = { x, y };
      nodes.push({ ...it, x, y, kind });
    });
    place(isps.map((x) => ({ id: x.id, name: x.name, sub: `AS${x.asn}` })), rowY(0), 'isp');
    let row = 1;
    for (const roles of layers.slice(1, 5)) {
      const devs = roles.flatMap((r) => (w.design.roles[r] || []).map((id) => w.devices[id]).filter(Boolean));
      if (!devs.length) continue;
      place(devs.map((d) => ({ id: d.id, name: d.hostname, sub: model(d.model).name, dev: d })), rowY(row++), 'dev');
    }
    const srvRow = row;
    const servers = Object.values(w.hosts).filter((x) => (x.kind === 'server' || x.kind === 'svc') && x.attach);
    servers.forEach((s, k) => {
      const a = pos[s.attach] || { x: 60, y: rowY(srvRow - 1) };
      const sib = servers.filter((x) => x.attach === s.attach);
      const idx = sib.indexOf(s);
      pos[s.id] = { x: a.x - (sib.length - 1) * 20 + idx * 40, y: rowY(srvRow) + (idx % 2) * 26 };
      nodes.push({ id: s.id, name: s.name, x: pos[s.id].x, y: pos[s.id].y, kind: 'host', host: s });
      void k;
    });
    const svg = sv('svg', { viewBox: `0 0 ${Wd} ${rowY(srvRow) + 50}`, class: 'topo', role: 'img', 'aria-label': 'Network topology' });
    for (const l of w.links) {
      if (l.purpose === 'mgmt') continue;
      if (docErr.get(l.id) === 'missing') continue;
      const A = pos[l.a.dev || l.a.host];
      const Bp = pos[l.b.dev || l.b.host];
      if (!A || !Bp) continue;
      const st = S.links[l.id];
      const col = expert ? '#7a80a8' : !st?.up ? '#ff4d5e' : st.loss > 0 || st.errors ? '#ffb020' : '#3ddc84';
      svg.append(sv('line', { x1: A.x, y1: A.y, x2: Bp.x, y2: Bp.y, stroke: col, 'stroke-width': l.purpose === 'isl' ? 4 : 2, 'stroke-dasharray': l.rogue ? '4 3' : null }));
      if (l.a.dev && l.b.dev) {
        const mx = (A.x * 0.8 + Bp.x * 0.2);
        const my = (A.y * 0.8 + Bp.y * 0.2);
        const lbl = docErr.get(l.id) === 'wrongport' ? `${l.a.if.replace(/\d+$/, (n) => Number(n) + 1)}` : shortIf(w.devices[l.a.dev], l.a.if);
        svg.append(sv('text', { x: mx + 4, y: my - 2, class: 'plabel' }, lbl));
      }
    }
    for (const n of nodes) {
      if (n.kind === 'isp') {
        svg.append(sv('g', { class: 'node isp' }, sv('ellipse', { cx: n.x, cy: n.y, rx: 70, ry: 22 }), sv('text', { x: n.x, y: n.y - 2, 'text-anchor': 'middle' }, n.name), sv('text', { x: n.x, y: n.y + 12, 'text-anchor': 'middle', class: 'sub' }, n.sub)));
      } else if (n.kind === 'dev') {
        const col = VENDOR_COLORS[n.dev.vendor] || VENDOR_COLORS.Cisco;
        const bad = n.dev.state !== 'up';
        const g = sv('g', { class: `node dev${bad ? ' bad' : ''}`, tabindex: 0, role: 'button', 'aria-label': n.name }, sv('rect', { x: n.x - 62, y: n.y - 20, width: 124, height: 40, rx: 4, fill: col.face, stroke: bad ? '#ff4d5e' : col.trim, 'stroke-width': 3 }), sv('text', { x: n.x, y: n.y - 3, 'text-anchor': 'middle' }, n.name), sv('text', { x: n.x, y: n.y + 12, 'text-anchor': 'middle', class: 'sub' }, n.sub.slice(0, 22)));
        g.addEventListener('click', () => devicePanel(this.app, n.id));
        g.addEventListener('keydown', (e) => e.key === 'Enter' && devicePanel(this.app, n.id));
        svg.append(g);
      } else {
        const hst = n.host;
        svg.append(sv('g', { class: 'node host' }, sv('rect', { x: n.x - 17, y: n.y - 9, width: 34, height: 18, rx: 2, fill: hst.kind === 'svc' ? '#3b3f66' : '#2e5a43' }), sv('title', {}, `${hst.name} ${hst.ip}`), sv('text', { x: n.x, y: n.y + 4, 'text-anchor': 'middle', class: 'tiny' }, hst.name.slice(0, 7))));
      }
    }
    fill(this.el, h('div.viewhead', {}, h('h2', {}, 'Network topology'), h('span.muted', {}, expert ? 'Expert: this is the documented topology. There is no live status map - use your tools.' : 'Live link status from monitoring (green up, amber errors/loss, red down). Click a device.')), h('div.topowrap', {}, svg), w.design.warnings?.length ? h('div.warnbox', {}, h('b', {}, 'Design warnings: '), w.design.warnings.join(' ')) : null);
  },
};
export { money };
