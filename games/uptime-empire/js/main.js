// Uptime Empire - app shell: data loading, title screen, top bar, navigation, game loop, saves.
import './cli/index.js';
import { h, fill, btn, modal, toastUI, money } from './ui/dom.js';
import { TermDock } from './ui/terminal.js';
import * as G from './game/game.js';
import { FloorView, NetworkView } from './views/infra.js';
import { TicketsView, NocView, slaLeft } from './views/ops.js';
import { DocsView } from './views/docs.js';
import { ShopView, CustomersView, ChangesView, FinanceView, GoalsView } from './views/biz.js';
import { fmtDate, dateOf } from './core/util.js';

const VIEWS = { floor: FloorView, network: NetworkView, tickets: TicketsView, noc: NocView, docs: DocsView, changes: ChangesView, shop: ShopView, customers: CustomersView, finance: FinanceView, goals: GoalsView };
const NAV = [['floor', '🏢', 'Data hall'], ['network', '🕸', 'Network'], ['tickets', '🎫', 'Tickets'], ['noc', '📈', 'NOC'], ['docs', '📚', 'Docs'], ['changes', '🛠', 'Changes'], ['shop', '🛒', 'Shop'], ['customers', '🤝', 'Customers'], ['finance', '💰', 'Finance'], ['goals', '🏆', 'Goals']];
const DIFF_KEYS = ['entry', 'associate', 'professional', 'expert'];
const DIFF_TEXT = {
  entry: 'Tickets say where to look. Accurate docs. Step-by-step hints with the exact commands. The SLA clock pauses while you type in a terminal, and the bank bails you out. Layer 1-2 basics, one fault at a time.',
  associate: 'Customers describe symptoms, not causes. Hints cost a little reputation. Docs are mostly right. 20-minute SLA. Switching, routing basics, servers, optics and power.',
  professional: 'Vague tickets, stale docs, two hints at most, 12-minute SLA, change windows enforced, occasionally two faults at once - and real bankruptcy. OSPF, NAT, firewalls and LACP join the party.',
  expert: '"It\'s broken." No hints, documentation drift, red-herring logs, 8-minute SLA, compound faults across BGP, OSPF, NAT and MTU. A real on-call night.',
};

const app = {
  w: null,
  data: null,
  dock: null,
  state: {},
  view: null,
  viewName: 'floor',
  say(text, kind = 'info') {
    toastUI(text, kind);
  },
  refresh() {
    renderTop();
    renderNav();
  },
  go(name) {
    this.viewName = name;
    this.view = VIEWS[name];
    const main = document.getElementById('view');
    main.scrollTop = 0;
    this.view.mount(this, main);
    renderNav();
  },
};
window.__ue = app; // handy for debugging in the console

async function loadData() {
  const get = (p) => fetch(p).then((r) => {
    if (!r.ok) throw new Error(`${p}: ${r.status}`);
    return r.json();
  });
  const [devices, facilities, advisories, campaign] = await Promise.all([get('data/devices.json'), get('data/facilities.json'), get('data/advisories.json'), get('data/campaign.json')]);
  app.data = { devices, facilities, advisories, campaign };
  G.setData(app.data);
}

// =============================================================================================
// Title screen
function title() {
  document.body.className = 'ue title-mode';
  const root = fill(document.getElementById('app'));
  let saved = null;
  try {
    saved = localStorage.getItem(G.SAVE_KEY);
  } catch {
    /* storage blocked */
  }
  let meta = null;
  if (saved) {
    try {
      const w = JSON.parse(saved);
      meta = `${w.company} · ${fmtDate(w.time.t, 'human')} · ${w.design.customers.length} customers · ${G.DIFF[w.difficulty].label}`;
    } catch {
      meta = null;
    }
  }
  const panel = h('div.titlecard.arcade-window', {}, h('h1.logo', {}, 'UPTIME', h('br'), 'EMPIRE'), h('p.tag', {}, 'Build a datacentre from a 1995 garage to a hyperscale campus. Every switch, router and firewall has a real CLI. Every outage is yours to fix.'), h('div.menu', {}, meta ? btn(`Continue: ${meta}`, () => start(G.loadGame()), 'primary big') : null, btn('New campaign', () => setup('campaign'), meta ? 'big' : 'primary big'), btn('Sandbox', () => setup('sandbox'), 'big'), btn('How to play', () => help(), 'big'), h('a.btn.big', { href: '../../' }, '← NetRealm Arcade')), h('p.small.muted', {}, 'Cisco IOS · IOS XE · NX-OS · ASA · IOS XR · Junos · Junos Evolved · AOS-CX · AOS-Switch · ArubaOS · FortiOS · FortiSwitch · FortiAP · Linux'), h('p.small.muted', {}, 'Vendor names are used to describe the simulated platforms. Not affiliated with or endorsed by any vendor; device behaviour is a simplified simulation.'));
  root.append(h('div.titlewrap', {}, panel));
}
function setup(mode) {
  const chapters = app.data.campaign.chapters;
  const company = h('input', { value: 'Uptime Empire Ltd', maxlength: 40, 'aria-label': 'Company name' });
  const diff = h('input', { type: 'range', min: 0, max: 3, step: 1, value: 0, 'aria-label': 'Difficulty' });
  const dlabel = h('div.dlabel');
  const dtext = h('p.dtext');
  const upd = () => {
    const k = DIFF_KEYS[Number(diff.value)];
    fill(dlabel, DIFF_KEYS.map((x) => h(`span${x === k ? '.on' : ''}`, {}, G.DIFF[x].label)));
    dtext.textContent = DIFF_TEXT[k];
  };
  diff.addEventListener('input', upd);
  upd();
  const ch = h('select', { 'aria-label': 'Chapter' }, chapters.map((c, i) => h('option', { value: i }, `${i + 1}. ${c.year} - ${c.title}`)));
  const year = h('input', { type: 'number', min: 1995, max: 2025, value: 2005, 'aria-label': 'Start year' });
  const cash = h('select', { 'aria-label': 'Starting cash' }, [[60000, '$60,000 (tight)'], [250000, '$250,000'], [1000000, '$1,000,000'], [10000000, '$10,000,000 (creative)']].map(([v, l]) => h('option', { value: v }, l)));
  const body = h('div.setup', {}, h('label', {}, 'Company name ', company), h('div.diffbox', {}, h('div', {}, 'Difficulty'), diff, dlabel, dtext), mode === 'campaign' ? h('label', {}, 'Start at chapter ', ch) : h('div', {}, h('label', {}, 'Start year ', year), h('label', {}, 'Starting cash ', cash)));
  modal(mode === 'campaign' ? 'New campaign' : 'Sandbox', body, {
    actions: [['Start', () => {
      const w = G.newGame({ mode, difficulty: DIFF_KEYS[Number(diff.value)], company: company.value.trim() || 'Uptime Empire Ltd', chapter: Number(ch.value), year: Math.max(1995, Math.min(2025, Number(year.value) || 2005)), cash: mode === 'sandbox' ? Number(cash.value) : null });
      start(w);
    }, 'primary'], ['Cancel', () => {}]],
  });
}
function help() {
  modal('How to play', h('div.help', {}, h('h3', {}, 'The job'), h('p', {}, 'You run a colocation and hosting business. Sign customers, rack equipment, keep every service inside its SLA, and grow from a single router in 1995 to a modern data centre. Things break - by themselves, because of old firmware, because of facilities, and sometimes because of you.'), h('h3', {}, 'Your tools'), h('ul', {}, h('li', {}, 'Terminal (bottom): you start on jump01, the NOC jump host on the out-of-band network. cat /etc/hosts, then ssh admin@<device>. Passwords are in Docs > Vault. console <name> reaches any device or customer server through the console server - even when the network is down.'), h('li', {}, 'Every device speaks its own CLI: abbreviations, ? help, Tab completion, | include / | match, --More--, configure/commit, write memory... exactly where you would expect them.'), h('li', {}, 'Data hall: walk up to racks for physical inspection - cables, optics, PSUs, fans, breakers.'), h('li', {}, 'Network, NOC, Docs: topology, monitoring, central syslog, IPAM, patching schedule, config backups with diffs, patch calendar, runbooks and a cross-vendor command reference.')), h('h3', {}, 'Incidents'), h('p', {}, 'When something breaks a ticket opens, the calendar freezes and the clock drops into real time: the SLA timer is running. Find the root cause, fix it properly, press "It\'s fixed", then write the RCA. Workarounds that hide the symptom are caught.'), h('h3', {}, 'Growing'), h('p', {}, 'Sign leads in Customers, buy equipment in Shop. New equipment and customers are integrated by a provisioning change that runs in the 02:00 maintenance window (or Run now). Remember: a reload loads the startup config - save your work.'), h('h3', {}, 'Keys'), h('p', {}, 'Terminal: Enter, Tab, ?, ↑/↓ history, Ctrl+C interrupt, Ctrl+Z leave config mode, Ctrl+L clear, Ctrl+U/W/A/E line editing, paste multi-line configs. Space = next page at --More--.')), { wide: true, actions: [['Got it', () => {}]] });
}

// =============================================================================================
// Game shell
let loop = null;
let lastToast = 0;
let lastSave = 0;
let viewTick = 0;
function start(w) {
  if (!w) return;
  app.w = w;
  app.state = {};
  document.body.className = 'ue game-mode';
  const root = fill(document.getElementById('app'));
  root.append(h('header#top.top'), h('div#banner.banner'), h('nav#nav.side', { 'aria-label': 'Screens' }), h('main#view.view'));
  app.dock = new TermDock(w, root, { onActivity: () => app.refresh() });
  lastToast = w.toasts.length ? w.toasts[w.toasts.length - 1].id : 0;
  for (const t of w.toasts.slice(-2)) toastUI(t.text, t.kind, 12000);
  app.go('floor');
  renderTop();
  clearInterval(loop);
  let last = performance.now();
  loop = setInterval(() => {
    const now = performance.now();
    const dt = Math.min(1, (now - last) / 1000);
    last = now;
    frame(dt);
  }, 250);
}
function frame(dt) {
  const w = app.w;
  try {
    G.tick(w, dt, { terminalFocused: app.dock.focused() });
  } catch (e) {
    console.error(e);
  }
  if (w.logQueue?.length) {
    const evs = w.logQueue.splice(0);
    app.dock.deliver(evs);
  }
  for (const t of w.toasts) if (t.id > lastToast) {
    lastToast = t.id;
    toastUI(t.text, t.kind === 'incident' ? 'bad' : t.kind, t.kind === 'story' ? 15000 : 7000);
  }
  renderTop();
  if (++viewTick % 4 === 0) {
    renderNav();
    try {
      app.view?.tick?.(app);
    } catch (e) {
      console.error(e);
    }
  }
  if (performance.now() - lastSave > 30000) {
    G.saveGame(w);
    lastSave = performance.now();
  }
  if (w.gameOver && !w.gameOverShown) {
    w.gameOverShown = true;
    modal('Game over', h('p', {}, w.gameOver.reason), { actions: [['Back to title', () => (clearInterval(loop), localStorage.removeItem(G.SAVE_KEY), title())]] });
  }
}
function renderTop() {
  const w = app.w;
  const top = document.getElementById('top');
  if (!top) return;
  const inc = G.openIncidents(w);
  const d = dateOf(w.time.t);
  const up = w.stats.monthTotal ? 100 - (100 * (w.stats.monthDown || 0)) / w.stats.monthTotal : 100;
  const speedBtn = (s, label, tip) => h(`button.spd${w.time.speed === s && !w.time.paused ? '.on' : ''}`, { type: 'button', title: tip, 'aria-label': tip, onclick: () => ((w.time.paused = false), (w.time.speed = s), renderTop()) }, label);
  fill(top, h('div.brand', {}, h('span.logo-s', {}, 'UPTIME EMPIRE'), h('span.co', {}, w.company)), h('div.clock', {}, h('span.date', {}, fmtDate(w.time.t, 'human')), h('span.time', {}, `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`), inc.length ? h('span.rt', {}, 'REAL-TIME') : null), h('div.speeds', {}, h(`button.spd${w.time.paused ? '.on' : ''}`, { type: 'button', title: 'Pause', 'aria-label': 'Pause', onclick: () => ((w.time.paused = !w.time.paused), renderTop()) }, '❚❚'), speedBtn(1, '▶', 'Normal speed'), speedBtn(2, '▶▶', 'Fast'), speedBtn(3, '▶▶▶', 'Faster'), speedBtn(4, '⏩', 'Fastest')), h('div.stats', {}, stat('Cash', money(w.cash), w.cash < 0 ? 'bad' : ''), stat('Reputation', `${Math.round(w.rep)}`, w.rep < 40 ? 'bad' : ''), stat('Uptime', `${up.toFixed(2)}%`, up < 99.5 ? 'bad' : ''), stat('Customers', w.design.customers.length, ''), stat(G.DIFF[w.difficulty].label, '', 'diff')), h('div.menu', {}, btn('Save', () => app.say(G.saveGame(w) ? 'Game saved.' : 'Save failed (storage full?).'), 'small'), btn('?', () => help(), 'small'), btn('Title', () => {
    G.saveGame(w);
    clearInterval(loop);
    title();
  }, 'small')));
  const ban = document.getElementById('banner');
  if (inc.length) {
    const t = inc[0];
    const left = slaLeft(t);
    fill(ban, h('div.inc', { onclick: () => ((app.state.ticket = t.id), app.go('tickets')) }, h('b', {}, `🚨 ${t.id} P${t.sev}: ${t.title}`), ` · ${left != null ? (t.breached ? 'SLA BREACHED' : `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')} to restore service`) : ''}${inc.length > 1 ? ` · +${inc.length - 1} more` : ''} · calendar frozen, clock in real time`));
    ban.classList.add('on');
  } else {
    fill(ban);
    ban.classList.remove('on');
  }
}
const stat = (l, v, cls) => h(`div.stat${cls ? `.${cls}` : ''}`, {}, h('span.sl', {}, l), h('span.sv', {}, String(v)));
function renderNav() {
  const w = app.w;
  const nav = document.getElementById('nav');
  if (!nav || !w) return;
  const badge = { tickets: w.tickets.filter((t) => t.status === 'open' || t.status === 'rca').length, changes: w.changes.filter((c) => c.status === 'queued').length, customers: w.leads.length, goals: w.campaign && G.goals(w).every((g) => g.done) ? '!' : 0 };
  fill(nav, NAV.map(([k, icon, label]) => h(`button.navb${k === app.viewName ? '.on' : ''}`, { type: 'button', onclick: () => app.go(k), 'aria-current': k === app.viewName ? 'page' : null }, h('span.ni', { 'aria-hidden': 'true' }, icon), h('span.nl', {}, label), badge[k] ? h('span.badge', {}, String(badge[k])) : null)));
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && app.w) G.saveGame(app.w);
});
window.addEventListener('beforeunload', () => {
  if (app.w) G.saveGame(app.w);
});

loadData().then(title).catch((e) => {
  console.error(e);
  fill(document.getElementById('app'), h('div.titlewrap', {}, h('div.titlecard.arcade-window', {}, h('h1', {}, 'Could not load game data'), h('p', {}, String(e.message)), h('p', {}, 'Serve the repository over HTTP (npm start) rather than opening the file directly.'))));
});
