// Terminal widget on top of js/cli/engine.js: line editing, history, Tab, "?" help, Ctrl+C/Z/L,
// pager, hidden password input, streamed output and asynchronous console log messages.
import { h, clear } from './dom.js';
import { Terminal } from '../cli/engine.js';
import { jumpSession, openConsole } from '../cli/linux.js';

const MAX_LINES = 3000;
const LIST_ON_TAB = new Set(['linux', 'junos', 'evo', 'fortigate', 'fortiswitch', 'aoss', 'aoscx']);

export class TermView {
  constructor(world, { title, consoleOf = null, onActivity = null } = {}) {
    this.world = world;
    this.title = title;
    this.onActivity = onActivity;
    this.term = new Terminal(world, null, { title });
    this.term.push(jumpSession(world, this.term));
    this.buf = '';
    this.cur = 0;
    this.hist = -1;
    this.busy = null;
    this.queue = [];
    this.el = h('div.term', { tabindex: 0, role: 'textbox', 'aria-label': `Terminal ${title}`, 'aria-multiline': 'true' });
    this.out = h('div.term-out');
    this.line = h('div.term-line');
    this.el.append(this.out, this.line);
    this.el.addEventListener('keydown', (e) => this.key(e));
    this.el.addEventListener('paste', (e) => {
      e.preventDefault();
      this.paste(e.clipboardData.getData('text'));
    });
    this.el.addEventListener('mouseup', () => {
      if (!window.getSelection()?.toString()) this.el.focus();
    });
    this.write(`${title}\n`);
    if (consoleOf) {
      const r = this.term.input(`console ${consoleOf}`);
      this.handle(r);
    } else this.write('Type help for the jump host cheat sheet.\n\n');
    this.render();
  }
  get session() {
    return this.term.top;
  }
  write(text) {
    if (!text) return;
    const parts = String(text).split('\r');
    let last = this.out.lastChild;
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        // carriage return: rewrite the current (last) line
        if (last && last.nodeType === 3) {
          const s = last.data;
          last.data = s.slice(0, s.lastIndexOf('\n') + 1);
        }
      }
      if (!parts[i]) continue;
      if (last && last.nodeType === 3) last.data += parts[i];
      else {
        last = document.createTextNode(parts[i]);
        this.out.append(last);
      }
    }
    // trim scrollback
    const txt = this.out.textContent;
    const n = (txt.match(/\n/g) || []).length;
    if (n > MAX_LINES) {
      const cut = txt.split('\n').slice(n - MAX_LINES).join('\n');
      clear(this.out).append(document.createTextNode(cut));
    }
    this.scroll();
  }
  scroll() {
    this.el.scrollTop = this.el.scrollHeight;
  }
  render() {
    clear(this.line);
    if (this.busy) {
      this.line.append(h('span.caret.idle', {}, ' '));
      return this.scroll();
    }
    if (this.term.pager) {
      this.line.append(h('span.more', {}, this.term.prompt), h('span.caret', {}, ' '));
      return this.scroll();
    }
    if (!this.term.top) {
      this.line.append(h('span.closed', {}, '[session closed - press Enter for a new jump host shell]'));
      return this.scroll();
    }
    const prompt = this.term.prompt;
    const shown = this.term.hidden ? '' : this.buf;
    const c = this.term.hidden ? 0 : this.cur;
    this.line.append(h('span.prompt', {}, prompt), shown.slice(0, c), h('span.caret', {}, shown[c] || ' '), shown.slice(c + 1));
    this.scroll();
  }
  echo(extra = '') {
    this.write(`${this.term.prompt}${this.term.hidden ? '' : this.buf}${extra}\n`);
  }
  submit() {
    if (!this.term.top) {
      this.term.push(jumpSession(this.world, this.term));
      this.buf = '';
      return this.render();
    }
    const line = this.buf;
    this.echo();
    this.buf = '';
    this.cur = 0;
    this.hist = -1;
    const r = this.term.input(line);
    this.handle(r);
    this.onActivity?.();
  }
  handle(r) {
    if (r.clear) clear(this.out);
    this.write(r.text || '');
    if (r.stream) this.run(r.stream);
    this.render();
  }
  run(st) {
    this.busy = st;
    const stepFn = () => {
      if (this.busy !== st) return;
      const c = st.next();
      if (!c) {
        this.busy = null;
        this.render();
        this.drain();
        return;
      }
      if (c.chain) {
        st = c.chain;
        this.busy = st;
      }
      this.write(c.t || '');
      setTimeout(stepFn, Math.min(1500, (c.d || 0) * 0.8));
    };
    setTimeout(stepFn, 0);
    this.render();
  }
  drain() {
    if (this.queue.length && !this.busy) {
      this.buf = this.queue.shift();
      this.cur = this.buf.length;
      this.submit();
      if (this.queue.length) setTimeout(() => this.drain(), 30);
    }
  }
  paste(text) {
    const lines = text.replace(/\r/g, '').split('\n');
    const first = lines.shift();
    this.buf = this.buf.slice(0, this.cur) + first + this.buf.slice(this.cur);
    this.cur += first.length;
    if (lines.length) {
      this.queue.push(...lines.slice(0, lines.length - (lines[lines.length - 1] === '' ? 1 : 0)));
      this.submit();
      this.drain();
    }
    this.render();
  }
  type(lines) {
    // used by "copy to terminal" buttons
    this.queue.push(...lines);
    if (!this.busy) this.drain();
  }
  notify(text) {
    // console log lines appear above the input line, like a real console
    this.write(`${text}\n`);
    this.render();
  }
  key(e) {
    const T = this.term;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key === 'c' && window.getSelection()?.toString()) return; // allow copy
    if (this.busy) {
      if (ctrl && (e.key === 'c' || e.key === '6')) {
        e.preventDefault();
        const st = this.busy;
        this.busy = null;
        this.write(st.interrupt());
        this.render();
      }
      return;
    }
    if (T.pager) {
      e.preventDefault();
      const k = e.key === ' ' ? ' ' : e.key === 'Enter' ? 'Enter' : 'q';
      const r = T.pagerKey(k);
      this.write(r.text);
      return this.render();
    }
    if (T.keyMode && e.key.length === 1 && !ctrl) {
      e.preventDefault();
      this.buf = e.key;
      return this.submit();
    }
    const D = T.top?.dialect;
    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        return this.submit();
      case 'Backspace':
        e.preventDefault();
        if (this.cur > 0) {
          this.buf = this.buf.slice(0, this.cur - 1) + this.buf.slice(this.cur);
          this.cur--;
        }
        return this.render();
      case 'Delete':
        e.preventDefault();
        this.buf = this.buf.slice(0, this.cur) + this.buf.slice(this.cur + 1);
        return this.render();
      case 'ArrowLeft':
        e.preventDefault();
        this.cur = Math.max(0, this.cur - 1);
        return this.render();
      case 'ArrowRight':
        e.preventDefault();
        this.cur = Math.min(this.buf.length, this.cur + 1);
        return this.render();
      case 'Home':
        e.preventDefault();
        this.cur = 0;
        return this.render();
      case 'End':
        e.preventDefault();
        this.cur = this.buf.length;
        return this.render();
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        if (T.hidden) return;
        const H = T.history;
        if (!H.length) return;
        if (e.key === 'ArrowUp') this.hist = this.hist < 0 ? H.length - 1 : Math.max(0, this.hist - 1);
        else this.hist = this.hist < 0 ? -1 : this.hist + 1;
        if (this.hist >= H.length) this.hist = -1;
        this.buf = this.hist < 0 ? '' : H[this.hist];
        this.cur = this.buf.length;
        return this.render();
      }
      case 'Tab': {
        e.preventDefault();
        if (T.hidden || !T.top) return;
        const r = T.complete(this.buf);
        if (r.options?.length > 1 && LIST_ON_TAB.has(D?.id)) {
          this.echo();
          this.write(`${r.options.join('  ')}\n`);
        }
        this.buf = r.line;
        this.cur = this.buf.length;
        return this.render();
      }
      default:
        break;
    }
    if (e.key === '?' && !T.hidden && T.top && D?.id !== 'linux' && D?.id !== 'apos') {
      e.preventDefault();
      this.echo('?');
      const out = T.help(this.buf);
      this.write(out ? `${out}\n` : '');
      return this.render();
    }
    if (ctrl) {
      const k = e.key.toLowerCase();
      if (k === 'c') {
        e.preventDefault();
        this.echo('^C');
        this.write(T.interrupt().replace(/^\^C\n?/, ''));
        this.buf = '';
        this.cur = 0;
        return this.render();
      }
      if (k === 'z') {
        e.preventDefault();
        const r = T.top?.dialect.ctrlZ?.(T.top);
        this.echo('^Z');
        if (typeof r === 'string') this.write(r.replace(/^\^Z\n?/, ''));
        this.buf = '';
        this.cur = 0;
        return this.render();
      }
      if (k === 'l') {
        e.preventDefault();
        clear(this.out);
        return this.render();
      }
      if (k === 'a') {
        e.preventDefault();
        this.cur = 0;
        return this.render();
      }
      if (k === 'e') {
        e.preventDefault();
        this.cur = this.buf.length;
        return this.render();
      }
      if (k === 'u') {
        e.preventDefault();
        this.buf = this.buf.slice(this.cur);
        this.cur = 0;
        return this.render();
      }
      if (k === 'w') {
        e.preventDefault();
        const left = this.buf.slice(0, this.cur).replace(/\S+\s*$/, '');
        this.buf = left + this.buf.slice(this.cur);
        this.cur = left.length;
        return this.render();
      }
      return;
    }
    if (e.key.length === 1 && !e.altKey) {
      e.preventDefault();
      this.buf = this.buf.slice(0, this.cur) + e.key + this.buf.slice(this.cur);
      this.cur++;
      this.hist = -1;
      this.render();
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Dock with tabs at the bottom of the screen
export class TermDock {
  constructor(world, host, { onActivity } = {}) {
    this.world = world;
    this.onActivity = onActivity;
    this.tabs = [];
    this.active = null;
    this.n = 0;
    this.el = h('section.dock', { 'aria-label': 'Terminals' });
    this.grip = h('div.dock-grip', { title: 'Drag to resize' });
    this.bar = h('div.dock-tabs');
    this.body = h('div.dock-body');
    this.el.append(this.grip, this.bar, this.body);
    host.append(this.el);
    this.height = Number(localStorage.getItem('arcade.uptime-empire.dock') || 300);
    this.min = false;
    this.applyHeight();
    let start = null;
    this.grip.addEventListener('pointerdown', (e) => {
      start = { y: e.clientY, hgt: this.height };
      this.grip.setPointerCapture(e.pointerId);
    });
    this.grip.addEventListener('pointermove', (e) => {
      if (!start) return;
      this.height = Math.max(120, Math.min(window.innerHeight - 160, start.hgt + (start.y - e.clientY)));
      this.applyHeight();
    });
    this.grip.addEventListener('pointerup', () => {
      start = null;
      localStorage.setItem('arcade.uptime-empire.dock', String(this.height));
    });
    this.open();
  }
  applyHeight() {
    this.el.style.height = this.min ? '34px' : `${this.height}px`;
    document.documentElement.style.setProperty('--dock', this.min ? '34px' : `${this.height}px`);
  }
  renderTabs() {
    clear(this.bar);
    for (const t of this.tabs) {
      const b = h(`button.dtab${t === this.active ? '.on' : ''}`, { type: 'button', onclick: () => this.show(t) }, t.title, h('span.dx', { onclick: (e) => (e.stopPropagation(), this.close(t)), title: 'Close tab' }, '×'));
      this.bar.append(b);
    }
    this.bar.append(h('button.dtab.add', { type: 'button', onclick: () => this.open(), title: 'New jump host session' }, '+ jump01'), h('button.dtab.min', { type: 'button', onclick: () => ((this.min = !this.min), this.applyHeight()), title: 'Minimise' }, this.min ? '▲' : '▼'));
  }
  open(consoleOf = null) {
    const title = consoleOf ? `console: ${consoleOf}` : `jump01 #${++this.n}`;
    const t = new TermView(this.world, { title, consoleOf, onActivity: this.onActivity });
    this.tabs.push(t);
    this.show(t);
    return t;
  }
  show(t) {
    this.active = t;
    clear(this.body).append(t.el);
    if (this.min) {
      this.min = false;
      this.applyHeight();
    }
    this.renderTabs();
    setTimeout(() => t.el.focus(), 0);
  }
  close(t) {
    this.tabs = this.tabs.filter((x) => x !== t);
    if (this.active === t) {
      if (this.tabs.length) this.show(this.tabs[this.tabs.length - 1]);
      else this.open();
    } else this.renderTabs();
  }
  focused() {
    return !!this.active && document.activeElement === this.active.el;
  }
  // deliver device log events to console sessions / terminal monitor
  deliver(events) {
    for (const t of this.tabs) {
      const s = t.term.top;
      if (!s?.dev || !s.monitor || s.dev.state !== 'up') continue;
      for (const e of events) if (e.dev === s.dev.id && s.dialect.fmtEvent) {
        const txt = s.dialect.fmtEvent(e, s.dev, this.world);
        if (txt) t.notify(txt);
      }
    }
  }
  setWorld(w) {
    this.world = w;
    for (const t of this.tabs) t.world = w;
  }
}
export { openConsole };
