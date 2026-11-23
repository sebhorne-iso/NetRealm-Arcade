// Operations: incident tickets (SLA, hints, resolve, RCA) and the NOC (monitoring, alarms, syslog).
import { h, fill, btn, table, pill, money } from '../ui/dom.js';
import { DIFF, hint, tryResolve, submitRca, openIncidents, CATS } from '../game/game.js';
import { checks } from '../net/sim.js';
import { recompute } from '../net/events.js';
import { getDialect } from '../cli/registry.js';
import { fmtDate } from '../core/util.js';

const mmss = (s) => `${s < 0 ? '-' : ''}${String(Math.floor(Math.abs(s) / 60)).padStart(2, '0')}:${String(Math.floor(Math.abs(s) % 60)).padStart(2, '0')}`;
export function slaLeft(t) {
  return t.slaTotal ? t.slaTotal - t.slaUsed : null;
}

export const TicketsView = {
  title: 'Tickets',
  mount(app, el) {
    this.app = app;
    this.list = h('div.tlist');
    this.detail = h('div.tdetail');
    fill(el, h('div.split', {}, this.list, this.detail));
    const w = app.w;
    this.sel = app.state.ticket || w.tickets.find((t) => t.status !== 'closed')?.id || w.tickets[0]?.id;
    this.renderList();
    this.renderDetail();
  },
  tick() {
    this.renderList();
    const t = this.app.w.tickets.find((x) => x.id === this.sel);
    if (t && this.slaEl) this.slaEl.textContent = slaText(this.app.w, t);
    if (t && this.lastStatus !== t.status) this.renderDetail();
    if (t && this.impactEl && this.n++ % 3 === 0) fill(this.impactEl, impactRows(this.app.w, t));
  },
  n: 0,
  renderList() {
    const w = this.app.w;
    const order = { open: 0, rca: 1, closed: 2 };
    const ts = [...w.tickets].sort((a, b) => order[a.status] - order[b.status] || a.sev - b.sev || b.t - a.t).slice(0, 60);
    fill(this.list, h('div.viewhead', {}, h('h2', {}, 'Tickets'), h('span.muted', {}, `${w.tickets.filter((t) => t.status === 'open').length} open`)), ts.length ? ts.map((t) => h(`button.trow${t.id === this.sel ? '.on' : ''}.p${t.sev}.${t.status}`, { type: 'button', onclick: () => ((this.sel = t.id), (this.app.state.ticket = t.id), this.renderList(), this.renderDetail()) }, h('span.tid', {}, `${t.id} P${t.sev}`), h('span.ttitle', {}, t.title), h('span.tsla', {}, t.status === 'open' ? slaText(w, t) : t.status === 'rca' ? 'RCA due' : t.rca ? `RCA ${t.rca.score}` : 'closed'))) : h('p.muted', {}, 'No tickets yet. Enjoy the quiet.'));
  },
  renderDetail() {
    const w = this.app.w;
    const t = w.tickets.find((x) => x.id === this.sel);
    this.lastStatus = t?.status;
    this.slaEl = null;
    this.impactEl = null;
    if (!t) return fill(this.detail, h('p.muted', {}, 'Select a ticket.'));
    const D = DIFF[w.difficulty];
    const cust = w.design.customers.find((c) => c.id === t.cust);
    this.slaEl = h('span.sla', {}, slaText(w, t));
    this.impactEl = h('div', {}, impactRows(w, t));
    const parts = [h('div.viewhead', {}, h('h2', {}, `${t.id}: ${t.title}`), pill(`P${t.sev}`, t.sev <= 2 ? 'bad' : 'warn'), ' ', pill(t.status, t.status === 'open' ? 'bad' : t.status === 'rca' ? 'warn' : 'good')), h('div.tmeta', {}, `Opened ${fmtDate(t.t, 'datetime')}${cust ? ` · ${cust.name} (${cust.tier}, ${cust.sla}% SLA)` : ''} · `, this.slaEl), h('blockquote.ttext', {}, t.text), t.impact.length ? h('div', {}, h('h3', {}, 'Monitoring'), this.impactEl) : null];
    if (t.notes.length) parts.push(h('ul.notes', {}, t.notes.map((n) => h('li', {}, `${fmtDate(n.t, 'datetime')} ${n.text}`))));
    if (t.status === 'open') {
      const hints = (t.shown = t.shown || []);
      parts.push(h('div.hints', {}, hints.map((x) => hintEl(this.app, x))));
      const btns = h('div.btnrow', {}, D.hints > 0 && hints.length < D.hints ? btn(`Hint${D.hintCost ? ` (-${D.hintCost} rep)` : ''}`, () => {
        const x = hint(w, t.id);
        if (x) hints.push(x);
        this.renderDetail();
      }) : h('span.muted', {}, D.hints === 0 ? 'Expert: no hints.' : 'No more hints.'), btn("It's fixed - confirm with the customer", () => {
        const r = tryResolve(w, t.id);
        this.app.say(r.msg, r.ok ? 'good' : 'bad');
        this.renderDetail();
        this.renderList();
      }, 'primary'));
      parts.push(btns);
    } else if (t.status === 'rca') parts.push(rcaForm(this, t));
    else if (t.rca) parts.push(rcaResult(w, t));
    fill(this.detail, parts);
  },
};
function slaText(w, t) {
  if (t.status !== 'open') return t.breached ? 'SLA breached' : '';
  const left = slaLeft(t);
  if (left != null) return t.breached ? `SLA BREACHED (${mmss(-left)} over)` : `${mmss(left)} left to restore service${DIFF[w.difficulty].pauseInTerminal ? ' (paused while you type)' : ''}`;
  if (t.due) return `due ${fmtDate(t.due, 'datetime')}`;
  return '';
}
function impactRows(w, t) {
  recompute(w);
  const idx = Object.fromEntries(checks(w).map((c) => [c.id, c]));
  return table(['', 'Check', 'Now'], t.impact.map((id) => idx[id]).filter(Boolean).map((c) => [pill(c.ok ? (c.degraded ? 'slow' : 'ok') : 'down', c.ok ? (c.degraded ? 'warn' : 'good') : 'bad'), c.name, c.ok ? (c.degraded ? c.reason : `${Math.round(c.rtt || 1)} ms`) : c.reason]));
}
function hintEl(app, x) {
  if (!x.recipe) return h('div.hint', {}, '💡 ', x.text);
  return h('div.hint', {}, '🛠 ', x.text, x.recipe.map((st) => (st.lines ? h('div.recipe', {}, h('div.rhead', {}, `${st.where === 'server' ? 'Server' : 'Device'} ${st.device}${st.os ? ` (${getDialect(st.os)?.id || st.os})` : ''}`, btn('Copy', () => navigator.clipboard?.writeText(st.lines.join('\n')).then(() => app.say('Copied - paste it into a terminal.')), 'small')), h('pre', {}, st.lines.join('\n'))) : h('div.recipe', {}, st.text || `No scripted fix for ${st.device}: work it out from the docs.`))));
}
function rcaForm(view, t) {
  const w = view.app.w;
  const devs = [...Object.values(w.devices).map((d) => [d.id, `${d.hostname} (${d.role})`]), ...Object.values(w.hosts).filter((x) => x.kind === 'server').map((x) => [x.id, `${x.name} (server)`])];
  const dev = h('select', {}, h('option', { value: '' }, '- none / not a device -'), devs.map(([v, l]) => h('option', { value: v }, l)));
  const cat = h('select', {}, Object.entries(CATS).map(([k, l]) => h('option', { value: k }, l)));
  const sum = h('textarea', { rows: 3, placeholder: 'What exactly was wrong, and how did you prove it? (e.g. "VLAN 103 was missing from the allowed list on acc1 Gi0/24, seen with show interfaces trunk")' });
  const prev = h('textarea', { rows: 2, placeholder: 'How do we stop it happening again?' });
  return h('div.rca', {}, h('h3', {}, 'Root-cause analysis'), h('p.muted', {}, 'Service is restored. Your RCA is scored on the device, the category and the technical detail.'), h('label', {}, 'Root-cause device ', dev), h('label', {}, 'Category ', cat), h('label', {}, 'Summary', sum), h('label', {}, 'Prevention', prev), btn('Submit RCA', () => {
    const r = submitRca(w, t.id, { dev: dev.value || null, cat: cat.value, summary: sum.value, prevention: prev.value });
    if (r) view.app.say(`RCA scored ${r.score}/100${r.bonus ? ` · bonus ${money(r.bonus)}` : ''}`, r.score >= 70 ? 'good' : 'bad');
    view.renderDetail();
    view.renderList();
  }, 'primary'));
}
function rcaResult(w, t) {
  const r = t.rca;
  const truth = r.parts.map((p) => p.truth);
  return h('div.rca', {}, h('h3', {}, `RCA score ${r.score}/100`), table(['', 'You said', 'Actually'], [['Device', w.devices[r.dev]?.hostname || w.hosts[r.dev]?.name || '-', truth.map((x) => w.devices[x.dev]?.hostname || w.hosts[x.dev]?.name || '-').join(', ')], ['Category', CATS[r.cat] || r.cat, truth.map((x) => CATS[x.cat]).join(', ')], ['Key terms', r.summary.slice(0, 80) || '-', truth.flatMap((x) => x.keys).slice(0, 6).join(', ')]]));
}

// =============================================================================================
export const NocView = {
  title: 'NOC',
  mount(app, el) {
    this.app = app;
    this.filter = app.state.logFilter || '';
    this.box = h('div');
    this.logBox = h('pre.syslog');
    const f = h('input', { type: 'search', placeholder: 'filter syslog (regex)', value: this.filter, oninput: (e) => ((this.filter = e.target.value), (app.state.logFilter = this.filter), this.renderLogs()) });
    fill(el, h('div.viewhead', {}, h('h2', {}, 'Network Operations Centre'), h('span.muted', {}, 'Monitoring from nms01 (10.20.0.20) and central syslog on log01.')), this.box, h('h3', {}, 'Central syslog ', f), this.logBox);
    this.render();
    this.renderLogs();
  },
  tick() {
    if (this.n++ % 2 === 0) {
      this.render();
      this.renderLogs();
    }
  },
  n: 0,
  render() {
    const w = this.app.w;
    recompute(w);
    const cks = checks(w);
    const bad = cks.filter((c) => !c.ok);
    const deg = cks.filter((c) => c.degraded);
    const up = w.stats.monthTotal ? 100 - (100 * (w.stats.monthDown || 0)) / w.stats.monthTotal : 100;
    const alarms = [];
    for (const d of Object.values(w.devices)) {
      if (d.state !== 'up') alarms.push([d.hostname, d.state === 'booting' ? 'booting' : `powered off${d.offReason ? ` (${d.offReason})` : ''}`]);
      if (!d.hw.psus.every(Boolean)) alarms.push([d.hostname, 'power supply failure']);
      if (!d.hw.fans.every(Boolean)) alarms.push([d.hostname, 'fan failure']);
      if (d.hw.temp > 50) alarms.push([d.hostname, `temperature ${Math.round(d.hw.temp)} C`]);
      for (const a of w.advisoryHits?.[d.id] || []) if (a.severity === 'critical') alarms.push([d.hostname, `critical advisory ${a.id}`]);
    }
    if (!w.facility.mains) alarms.push(['facility', 'utility power lost']);
    for (const c of w.facility.cooling) if (!c.ok) alarms.push(['facility', `cooling unit ${c.uid} fault`]);
    const links = Object.entries(w.sim.links).map(([id, L]) => ({ id, L, l: w.links.find((x) => x.id === id) })).filter((x) => x.l && x.L.up).sort((a, b) => (b.L.pct || 0) - (a.L.pct || 0)).slice(0, 6);
    const name = (e) => (e.dev ? `${w.devices[e.dev]?.hostname} ${e.if}` : w.hosts[e.host]?.name);
    fill(this.box, h('div.tiles', {}, tile('Services', `${cks.length - bad.length}/${cks.length}`, bad.length ? 'bad' : 'good'), tile('Degraded', deg.length, deg.length ? 'warn' : 'good'), tile('Uptime (month)', `${up.toFixed(3)}%`, up < 99.5 ? 'bad' : 'good'), tile('Open incidents', openIncidents(w).length, openIncidents(w).length ? 'bad' : 'good'), tile('Alarms', alarms.length, alarms.length ? 'warn' : 'good')), h('div.cols2', {}, h('div', {}, h('h3', {}, 'Service checks'), table(['', 'Check', 'Result'], [...bad, ...deg, ...cks.filter((c) => c.ok && !c.degraded)].slice(0, 40).map((c) => [pill(c.ok ? (c.degraded ? 'warn' : 'ok') : 'down', c.ok ? (c.degraded ? 'warn' : 'good') : 'bad'), c.name, c.ok ? (c.degraded ? c.reason : `${Math.round(c.rtt || 1)} ms`) : c.reason]))), h('div', {}, h('h3', {}, 'Alarms'), alarms.length ? table(['Source', 'Alarm'], alarms) : h('p.muted', {}, 'No active alarms.'), h('h3', {}, 'Busiest links'), table(['Link', 'Load'], links.map((x) => [`${name(x.l.a)} ↔ ${name(x.l.b)}`, h('td', {}, h('span.bar', {}, h('i', { style: { width: `${Math.min(100, x.L.pct || 0)}%` } })), ` ${(x.L.pct || 0).toFixed(1)}% of ${x.L.speed >= 1000 ? `${x.L.speed / 1000}G` : `${x.L.speed}M`}`)])))));
  },
  renderLogs() {
    const w = this.app.w;
    let re = null;
    try {
      re = this.filter ? new RegExp(this.filter, 'i') : null;
    } catch {
      re = { test: (x) => x.toLowerCase().includes(this.filter.toLowerCase()) };
    }
    const lines = [];
    const logs = w.syslog || [];
    for (let i = logs.length - 1; i >= 0 && lines.length < 250; i--) {
      const e = logs[i];
      const dev = w.devices[e.dev];
      if (!dev) continue;
      const D = getDialect(dev.os);
      const txt = D?.fmtEvent?.(e, dev, w);
      if (!txt) continue;
      for (const l of txt.split('\n')) {
        const line = `${dev.hostname.padEnd(7)} ${l}`;
        if (!re || re.test(line)) lines.push(line);
      }
    }
    this.logBox.textContent = lines.length ? lines.join('\n') : 'No log messages.';
  },
};
const tile = (label, value, kind) => h(`div.tile.${kind}`, {}, h('div.tv', {}, String(value)), h('div.tl', {}, label));
