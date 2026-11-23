// Business screens: shop (network + facilities + services), customers & leads, changes,
// finance and campaign goals.
import { h, fill, btn, table, pill, money, modal } from '../ui/dom.js';
import { model, OS, expandPorts, VENDOR_COLORS } from '../net/catalog.js';
import { shopModels, buyDevice, devicePrice, buyFacility, addIsp, openOffice, acceptLead, declineLead, runChange, cancelChange, monthlyCosts, monthlyRevenue, offerLoan, DIFF, TIERS, goals, nextChapter, ROLE_LIMIT, scheduleFirmware, firmwareOptions } from '../game/game.js';
import { facilities, rackLoad } from '../game/facility.js';
import { fmtDate, yearOf } from '../core/util.js';

const ROLE_LABEL = { edge: 'Edge routers', fw: 'Firewalls', core: 'Core switches', access: 'Access switches', oob: 'OOB switch', wlc: 'Wi-Fi controller', ap: 'Access points' };
function portSummary(m) {
  const groups = {};
  for (const p of expandPorts(m)) {
    const k = `${p.speed >= 1000 ? `${p.speed / 1000}G` : `${p.speed}M`}${p.media === 'serial' ? ' serial' : /sfp|qsfp/.test(p.media) ? ' optic' : ''}`;
    groups[k] = (groups[k] || 0) + 1;
  }
  return Object.entries(groups).map(([k, n]) => `${n}×${k}`).join(', ');
}

export const ShopView = {
  title: 'Shop',
  mount(app, el) {
    this.app = app;
    this.el = el;
    this.role = app.state.shopRole || 'access';
    this.render();
  },
  render() {
    const w = this.app.w;
    const y = yearOf(w.time.t);
    const roles = Object.keys(ROLE_LABEL);
    const tabs = h('div.tabs', {}, [...roles.map((r) => h(`button.tab${r === this.role ? '.on' : ''}`, { type: 'button', onclick: () => ((this.role = r), (this.app.state.shopRole = r), this.render()) }, `${ROLE_LABEL[r]} (${(w.design.roles[r] || []).length})`)), h(`button.tab${this.role === 'facility' ? '.on' : ''}`, { type: 'button', onclick: () => ((this.role = 'facility'), this.render()) }, 'Facilities & services')]);
    let body;
    if (this.role === 'facility') body = facilityShop(this);
    else {
      const ms = shopModels(w, this.role);
      body = h('div.cards', {}, ms.length ? ms.map((m) => {
        const price = devicePrice(w, m);
        const col = VENDOR_COLORS[m.vendor];
        return h('div.card', { style: { borderTopColor: col?.trim } }, h('div.cvendor', { style: { background: col?.face } }, m.vendor), h('h3', {}, m.name), h('div.muted', {}, m.desc || ''), h('div.spec', {}, `${OS[m.os]?.label || m.os} · ${m.year}${m.eos ? ` · EoS ${m.eos}` : ''}${m.eol ? ` · EoL ${m.eol}` : ''}`), h('div.spec', {}, `${portSummary(m)} · ${m.u}U · ${m.watts} W · ${m.psus} PSU${m.psus > 1 ? 's' : ''}`), h('div.spec', {}, m.feat.join(' · ')), h('div.price', {}, money(price)), btn('Buy & rack', () => {
          const err = buyDevice(w, m.id, this.role);
          if (err) this.app.say(err, 'bad');
          this.render();
          this.app.refresh();
        }, w.cash >= price ? 'primary' : ''));
      }) : h('p', {}, `Nothing available for this role in ${y}.`));
    }
    fill(this.el, h('div.viewhead', {}, h('h2', {}, 'Shop'), h('span.muted', {}, `${y} catalogue · cash ${money(w.cash)} · role limits: ${Object.entries(ROLE_LIMIT).map(([r, n]) => `${r} ${n}`).join(', ')}`)), tabs, body);
  },
};
function facilityShop(view) {
  const w = view.app.w;
  const F = facilities();
  const y = yearOf(w.time.t);
  const buy = (kind, id, arg) => {
    const err = buyFacility(w, kind, id, arg);
    view.app.say(err || 'Purchased.', err ? 'bad' : 'good');
    view.render();
    view.app.refresh();
  };
  const row = (name, price, onclick, note = '') => [name, note, money(price), h('td', {}, btn('Buy', onclick, 'small'))];
  const rows = [row(`Floor space (${w.facility.slots}/${F.floor.slots} rack positions)`, F.floor.slotPrice, () => buy('slot'), 'One more rack position'), ...F.racks.map((r) => row(r.name, r.price, () => buy('rack', r.id), `${w.facility.racks.length} racks`)), ...F.ups.filter((u) => u.year <= y).map((u) => row(u.name, u.price, () => buy('ups', u.id), `${u.kw} kW, ~${u.minutes} min`)), ...F.cooling.filter((c) => c.year <= y).map((c) => row(c.name, c.price, () => buy('cooling', c.id), `+${c.kw} kW cooling`)), ...F.generators.filter((g) => g.year <= y).map((g) => row(g.name, g.price, () => buy('generator', g.id), w.facility.generator ? 'installed' : 'not installed')), ...F.spares.map((s) => row(`${s.name} ×1`, s.price, () => buy('spare', s.id, 1), `in stock: ${w.spares[s.id] || 0}`))];
  const pduRows = w.facility.racks.map((r) => {
    const load = rackLoad(w, r);
    return [r.id, F.pdus.find((p) => p.id === r.pdu).name, `A ${Math.round(load.a)} W · B ${Math.round(load.b)} W of ${load.cap} W`, h('td', {}, F.pdus.filter((p) => p.id !== r.pdu && p.year <= y).map((p) => btn(`Upgrade to ${p.amps} A (${money(p.price)})`, () => buy('pdu', p.id, r.id), 'small')))];
  });
  return [h('h3', {}, 'Facilities'), table(['Item', 'Notes', 'Price', ''], rows), h('h3', {}, 'Rack power'), table(['Rack', 'PDU', 'Load', ''], pduRows), h('h3', {}, 'Services'), h('div.btnrow', {}, btn(`Second ISP + BGP (${w.design.isps.length}/2)`, () => view.app.say(addIsp(w) || 'Ordered.', 'info')), btn(`Open office floor with staff Wi-Fi ($15,000)${w.design.office.on ? ' ✓' : ''}`, () => view.app.say(openOffice(w) || 'Office fit-out ordered; network change queued.', 'info')))];
}

export const CustomersView = {
  title: 'Customers',
  mount(app, el) {
    this.app = app;
    this.el = el;
    this.render();
  },
  tick() {
    if (this.n++ % 5 === 0) this.render();
  },
  n: 0,
  render() {
    const w = this.app.w;
    const cs = w.design.customers;
    const leads = w.leads;
    fill(this.el, h('div.viewhead', {}, h('h2', {}, 'Customers'), h('span.muted', {}, `${cs.length} customers · ${money(monthlyRevenue(w))}/month · reputation ${Math.round(w.rep)}/100`)), h('h3', {}, 'Leads'), leads.length ? table(['Company', 'Plan', 'Servers', 'Website', 'Fee', 'Expires', ''], leads.map((l) => [l.name, `${TIERS[l.tier].label} (${l.sla}%)`, l.servers, l.web ? 'yes' : 'no', `${money(l.fee)}/mo`, fmtDate(l.expires, 'iso'), h('td', {}, btn('Sign', () => {
      const err = acceptLead(w, l.id);
      if (err) this.app.say(err, 'bad');
      this.render();
    }, 'small primary'), btn('Decline', () => (declineLead(w, l.id), this.render()), 'small'))])) : h('p.muted', {}, 'No leads right now. Good reputation brings more.'), h('h3', {}, 'Contracts'), table(['Customer', 'Plan', 'VLAN', 'Servers', 'Fee', 'Uptime (month)', 'Satisfaction'], cs.map((c) => {
      const up = c.mTotal ? 100 - (100 * c.mDown) / c.mTotal : 100;
      return [c.name + (c.pending ? ' (onboarding)' : ''), `${TIERS[c.tier]?.label || c.tier} ${c.sla}%`, c.vlan, c.servers.length, money(c.fee), h('td', {}, pill(`${up.toFixed(3)}%`, up < c.sla ? 'bad' : 'good')), h('td', {}, h('span.bar', {}, h('i', { style: { width: `${c.sat}%`, background: c.sat < 40 ? 'var(--bad)' : c.sat < 65 ? 'var(--warn)' : 'var(--good)' } })))];
    })));
  },
};

export const ChangesView = {
  title: 'Changes',
  mount(app, el) {
    this.app = app;
    this.el = el;
    this.render();
  },
  tick() {
    if (this.n++ % 5 === 0) this.render();
  },
  n: 0,
  render() {
    const w = this.app.w;
    const q = w.changes.filter((c) => c.status === 'queued');
    const done = w.changes.filter((c) => c.status !== 'queued').slice(-15).reverse();
    const D = DIFF[w.difficulty];
    const fwDevs = Object.values(w.devices).filter((d) => firmwareOptions(w, d).length);
    const devSel = h('select', {}, fwDevs.map((d) => h('option', { value: d.id }, `${d.hostname} (${d.version})`)));
    fill(this.el, h('div.viewhead', {}, h('h2', {}, 'Change management'), h('span.muted', {}, 'Queued changes run in the nightly maintenance window at 02:00. Provisioning re-renders every device config from the source of truth (manual changes that are not in the design are overwritten).')), h('h3', {}, 'Queued'), q.length ? table(['ID', 'Change', 'Raised', ''], q.map((c) => [c.id, c.title, fmtDate(c.created, 'datetime'), h('td', {}, btn('Run now', () => {
      const err = runChange(w, c.id, { now: true });
      this.app.say(err || c.result || 'Done.', err ? 'bad' : 'good');
      this.render();
      this.app.refresh();
    }, 'small'), btn('Cancel', () => (cancelChange(w, c.id), this.render()), 'small'))])) : h('p.muted', {}, 'Nothing queued.'), D.unauthorized ? h('p.warnline', {}, 'Professional/Expert: running a change outside 00:00-06:00 costs reputation.') : null, h('h3', {}, 'Firmware upgrade'), fwDevs.length ? h('div.btnrow', {}, devSel, btn('Choose release…', () => {
      const d = w.devices[devSel.value];
      const vs = firmwareOptions(w, d);
      const v = h('select', {}, vs.map((x) => h('option', { value: x }, x)));
      modal(`Upgrade ${d.hostname}`, h('label', {}, `${d.version} → `, v), { actions: [['Queue', () => (scheduleFirmware(w, d.id, v.value), this.render())], ['Cancel', () => {}]] });
    })) : h('p.muted', {}, 'Every device runs the newest release available this year.'), h('h3', {}, 'Recent'), done.length ? table(['ID', 'Change', 'Ran', 'Result'], done.map((c) => [c.id, c.title, c.ran ? fmtDate(c.ran, 'datetime') : '-', `${c.status}: ${c.result || ''}`])) : h('p.muted', {}, 'No history yet.'));
  },
};

export const FinanceView = {
  title: 'Finance',
  mount(app, el) {
    this.app = app;
    this.el = el;
    this.render();
  },
  render() {
    const w = this.app.w;
    const costs = monthlyCosts(w);
    const rev = monthlyRevenue(w);
    const total = Object.values(costs).reduce((a, b) => a + b, 0);
    const D = DIFF[w.difficulty];
    const cv = h('canvas.chart', { width: 640, height: 160, 'aria-label': 'Cash history' });
    setTimeout(() => chart(cv, w.history.slice(-36)), 0);
    fill(this.el, h('div.viewhead', {}, h('h2', {}, 'Finance'), h('span.muted', {}, `Cash ${money(w.cash)}`)), h('div.cols2', {}, h('div', {}, h('h3', {}, 'Monthly run-rate'), table(['', 'Per month'], [['Hosting revenue', money(rev)], ...Object.entries(costs).map(([k, v]) => [{ staff: 'Salaries', transit: 'IP transit', rent: 'Rack space', power: 'Electricity', loans: 'Loan repayments' }[k], money(-v)]), [h('b', {}, 'Net'), h('b', {}, money(rev - total))]]), D.loans ? btn('Take a $50,000 loan', () => (offerLoan(w, 50000), this.render(), this.app.refresh())) : h('p.muted', {}, 'No bank will lend at this difficulty. Stay in the black.'), w.loans.length ? table(['Loan', 'Monthly', 'Months left'], w.loans.map((l) => [money(l.amount), money(l.monthly), l.left])) : null), h('div', {}, h('h3', {}, 'Cash (last 36 months)'), cv)), h('h3', {}, 'Ledger'), table(['Date', 'Item', 'Amount'], w.ledger.slice(-25).reverse().map((l) => [fmtDate(l.t, 'iso'), l.note, h('td', { class: l.amount < 0 ? 'neg' : 'pos' }, money(l.amount))])));
  },
};
function chart(cv, hist) {
  const c = cv.getContext('2d');
  c.fillStyle = '#0d1020';
  c.fillRect(0, 0, cv.width, cv.height);
  if (!hist.length) {
    c.fillStyle = '#8890c0';
    c.font = '14px VT323, monospace';
    c.fillText('No full months yet.', 20, 80);
    return;
  }
  const vals = hist.map((x) => x.cash);
  const max = Math.max(...vals, 1);
  const min = Math.min(...vals, 0);
  const bw = cv.width / hist.length;
  hist.forEach((x, i) => {
    const y = cv.height - 20 - ((x.cash - min) / (max - min || 1)) * (cv.height - 40);
    const y0 = cv.height - 20 - ((0 - min) / (max - min || 1)) * (cv.height - 40);
    c.fillStyle = x.cash < 0 ? '#ff4d5e' : '#3ddc84';
    c.fillRect(i * bw + 2, Math.min(y, y0), bw - 4, Math.max(2, Math.abs(y0 - y)));
  });
}

export const GoalsView = {
  title: 'Goals',
  mount(app, el) {
    this.app = app;
    this.el = el;
    this.render();
  },
  tick() {
    if (this.n++ % 4 === 0) this.render();
  },
  n: 0,
  render() {
    const w = this.app.w;
    if (!w.campaign) return fill(this.el, h('div.viewhead', {}, h('h2', {}, 'Sandbox')), h('p', {}, 'No goals in sandbox mode. Build the datacentre you always wanted - and keep it running.'));
    const ch = this.app.data.campaign.chapters[w.campaign.chapter];
    const gs = goals(w);
    const all = gs.every((g) => g.done);
    fill(this.el, h('div.viewhead', {}, h('h2', {}, `Chapter ${w.campaign.chapter + 1}: ${ch.title}`), h('span.muted', {}, String(ch.year))), h('p.story', {}, ch.story), h('ul.goals', {}, gs.map((g) => h(`li.${g.done ? 'done' : 'todo'}`, {}, g.done ? '✔ ' : '○ ', g.text, g.prog ? h('span.muted', {}, ` (${g.prog})`) : null))), all ? btn(w.campaign.chapter + 1 < this.app.data.campaign.chapters.length ? 'Advance to the next chapter' : 'Finish the campaign', () => {
      const err = nextChapter(w);
      this.app.say(err || 'Onwards!', err ? 'bad' : 'good');
      this.app.refresh();
      this.render();
    }, 'primary') : h('p.muted', {}, 'Complete every goal to unlock the next chapter.'), h('h3', {}, 'Chapters'), h('ol.chapters', {}, this.app.data.campaign.chapters.map((c, i) => h(`li${i === w.campaign.chapter ? '.on' : i < w.campaign.chapter ? '.past' : ''}`, {}, `${c.year} - ${c.title}`))));
  },
};
void model;
