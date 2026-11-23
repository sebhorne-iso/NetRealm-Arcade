// CLI engine shared by every vendor dialect: pattern grammar -> keyword trie, abbreviation and
// ambiguity rules, "?" help, Tab completion, output pipes, a pager, interactive prompts,
// long-running streamed commands (ping, reload) and a stack of nested sessions (jump host -> ssh).
import { isIp, isMask, cidr, parseVlans } from '../core/util.js';

// ---------------------------------------------------------------------------------------------
// Tokenizer (keeps character offsets so errors can draw a caret under the bad token)
export function tokenize(line, quotes = true) {
  const toks = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && line[i] === ' ') i++;
    if (i >= line.length) break;
    const s = i;
    let v = '';
    if (quotes && (line[i] === '"' || line[i] === "'")) {
      const q = line[i++];
      while (i < line.length && line[i] !== q) v += line[i++];
      i++;
      toks.push({ v, s, e: i, q: true });
      continue;
    }
    while (i < line.length && line[i] !== ' ') v += line[i++];
    toks.push({ v, s, e: i });
  }
  return toks;
}

// ---------------------------------------------------------------------------------------------
// Pattern grammar: "show interfaces [$if] {status|trunk}" ; params: $type, $type(lo-hi), $type:name
function parsePattern(src) {
  const t = src.replace(/([[\]{}|])/g, ' $1 ').split(/\s+/).filter(Boolean);
  let i = 0;
  const atom = (x) => {
    if (x[0] !== '$' || x.length === 1) return { kw: x };
    const m = x.match(/^\$(\w+)(?:\((-?\d+)-(\d+)\))?(?::([\w-]+))?$/);
    if (!m) return { kw: x };
    return { type: m[1], lo: m[2] != null ? Number(m[2]) : null, hi: m[3] != null ? Number(m[3]) : null, name: m[4] || m[1] };
  };
  const seq = (stop) => {
    const items = [];
    while (i < t.length && !stop.includes(t[i])) {
      const x = t[i++];
      if (x === '[') {
        const s = alts(']');
        i++;
        items.push({ opt: s });
      } else if (x === '{') {
        const s = alts('}');
        i++;
        items.push({ alt: s });
      } else items.push(atom(x));
    }
    return items;
  };
  const alts = (close) => {
    const list = [seq(['|', close])];
    while (t[i] === '|') {
      i++;
      list.push(seq(['|', close]));
    }
    return list;
  };
  return seq([]);
}
function expand(items) {
  let out = [[]];
  for (const it of items) {
    if (it.opt) {
      const v = it.opt.flatMap(expand);
      out = out.flatMap((o) => [o, ...v.map((a) => [...o, ...a])]);
    } else if (it.alt) {
      const v = it.alt.flatMap(expand);
      out = out.flatMap((o) => v.map((a) => [...o, ...a]));
    } else out = out.map((o) => [...o, it]);
  }
  return out;
}
const node = () => ({ kws: new Map(), params: [], end: null, help: null });

// defs: [{ p: 'pattern', run(s, a), help: {kw|param: text}, hidden, alias }]
export function compile(defs, kwHelp = {}) {
  const root = node();
  for (const def of defs) {
    for (const variant of expand(parsePattern(def.p))) {
      let n = root;
      for (const tk of variant) {
        if (tk.kw) {
          const k = tk.kw.toLowerCase();
          if (!n.kws.has(k)) n.kws.set(k, { ...node(), raw: tk.kw, hidden: !!def.hidden });
          const child = n.kws.get(k);
          if (!def.hidden) child.hidden = false;
          child.help = child.help || def.help?.[tk.kw] || kwHelp[tk.kw] || '';
          n = child;
        } else {
          const key = `${tk.type}|${tk.lo}|${tk.hi}|${tk.name}`;
          let p = n.params.find((x) => x.key === key);
          if (!p) {
            p = { ...tk, key, node: node(), help: def.help?.[`$${tk.name}`] || def.help?.[tk.name] || '' };
            n.params.push(p);
          } else if (!p.help) p.help = def.help?.[`$${tk.name}`] || def.help?.[tk.name] || '';
          n = p.node;
        }
      }
      n.end = def;
      n.endHelp = def.cr;
    }
  }
  return root;
}
export function merge(...roots) {
  const out = node();
  const mergeInto = (dst, src) => {
    for (const [k, c] of src.kws) {
      if (!dst.kws.has(k)) dst.kws.set(k, { ...node(), raw: c.raw, help: c.help, hidden: c.hidden });
      const d = dst.kws.get(k);
      d.help = d.help || c.help;
      d.hidden = d.hidden && c.hidden;
      mergeInto(d, c);
    }
    for (const p of src.params) {
      let d = dst.params.find((x) => x.key === p.key);
      if (!d) {
        d = { ...p, node: node() };
        dst.params.push(d);
      }
      mergeInto(d.node, p.node);
    }
    if (src.end) dst.end = src.end;
  };
  for (const r of roots) if (r) mergeInto(out, r);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Parameter types
export const PARAM = {
  ip: { m: (v) => isIp(v), h: 'A.B.C.D' },
  mask: { m: (v) => isMask(v), h: 'A.B.C.D' },
  wild: { m: (v) => isIp(v), h: 'A.B.C.D' },
  pfx: { m: (v) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(v) && !!cidr(v), h: 'A.B.C.D/LEN' },
  ipp: { m: (v) => isIp(v) || (/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(v) && !!cidr(v)), h: 'A.B.C.D[/LEN]' },
  num: { m: (v, p) => /^\d+$/.test(v) && (p.lo == null || (Number(v) >= p.lo && Number(v) <= p.hi)), h: (p) => (p.lo != null ? `<${p.lo}-${p.hi}>` : '<0-4294967295>') },
  word: { m: (v) => v.length > 0, h: 'WORD' },
  str: { m: (v) => v.length > 0, h: 'WORD' },
  vlist: { m: (v) => parseVlans(v) !== null && v !== 'all', h: 'WORD' },
  host: { m: (v) => /^[A-Za-z0-9._:-]+$/.test(v), h: 'WORD' },
  line: { rest: true, h: 'LINE' },
  any: { m: () => true, h: '<value>' },
  if: { iface: true, h: 'Interface' },
  ifc: { iface: true, create: true, h: 'Interface' },
};
function paramHelpLabel(p) {
  const P = PARAM[p.type];
  if (!P) return 'WORD';
  return typeof P.h === 'function' ? P.h(p) : P.h;
}
function matchParam(p, toks, i, s) {
  const P = PARAM[p.type];
  if (!P) return null;
  const v = toks[i].v;
  if (P.rest) return { val: toks.slice(i).map((t) => t.v).join(' '), n: toks.length - i };
  if (P.iface) return s.dialect.matchIf ? s.dialect.matchIf(s, toks, i, !!P.create) : { val: v, n: 1 };
  return P.m(v, p) ? { val: p.type === 'num' ? Number(v) : v, n: 1 } : null;
}

// ---------------------------------------------------------------------------------------------
// Matcher
function walkTrie(s, root, toks) {
  let best = { kind: 'invalid', at: 0 };
  const rank = { ok: 4, incomplete: 3, ambiguous: 2, invalid: 1 };
  const better = (r) => {
    if (r.kind === 'ok') return true;
    if (best.kind === 'ok') return false;
    if (r.at > best.at) return true;
    if (r.at === best.at && rank[r.kind] > rank[best.kind]) return true;
    return false;
  };
  const go = (n, i, args) => {
    if (i >= toks.length) {
      const r = n.end ? { kind: 'ok', def: n.end, args, node: n } : { kind: 'incomplete', at: i, node: n };
      if (better(r)) best = r;
      return r.kind === 'ok';
    }
    const lower = toks[i].v.toLowerCase();
    const exact = toks[i].q ? null : n.kws.get(lower);
    const kws = exact ? [lower] : toks[i].q ? [] : [...n.kws.keys()].filter((k) => k.startsWith(lower) && !n.kws.get(k).hiddenAbbrev);
    const visible = kws.filter((k) => !n.kws.get(k).hidden || k === lower);
    const cand = visible.length ? visible : kws;
    if (cand.length > 1 && !exact) {
      // Is there a parameter that also takes this token? (e.g. hostnames) - keywords still win in IOS
      const r = { kind: 'ambiguous', at: i, options: cand };
      if (better(r)) best = r;
      return false;
    }
    if (cand.length === 1) {
      const kw = n.kws.get(cand[0]).raw;
      if (go(n.kws.get(cand[0]), i + 1, { ...args, kw: [...args.kw, kw.toLowerCase()] })) return true;
      if (exact || !n.params.length) return false;
    }
    let any = false;
    for (const p of n.params) {
      const m = matchParam(p, toks, i, s);
      if (!m) continue;
      any = true;
      const na = { ...args, [p.name]: m.val, kw: [...args.kw] };
      if (args[p.name] !== undefined) na[`${p.name}2`] = m.val, (na[p.name] = args[p.name]);
      if (go(p.node, i + m.n, na)) return true;
    }
    if (!any && !cand.length) {
      const r = { kind: 'invalid', at: i };
      if (better(r)) best = r;
    }
    return false;
  };
  go(root, 0, { kw: [] });
  return best;
}

// Nodes reachable after consuming all tokens (for ? and Tab)
function reach(s, root, toks) {
  const out = [];
  const go = (n, i) => {
    if (i >= toks.length) {
      out.push(n);
      return;
    }
    const lower = toks[i].v.toLowerCase();
    const exact = n.kws.get(lower);
    const kws = exact ? [lower] : [...n.kws.keys()].filter((k) => k.startsWith(lower));
    if (kws.length === 1) go(n.kws.get(kws[0]), i + 1);
    if (exact) return;
    for (const p of n.params) {
      const m = matchParam(p, toks, i, s);
      if (m && i + m.n <= toks.length) go(p.node, i + m.n);
    }
  };
  go(root, 0);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Output pipes
export function applyPipes(lines, pipes, dialect) {
  let out = lines;
  for (const p of pipes) {
    const [cmdRaw, ...rest] = tokenize(p).map((t) => t.v);
    const cmd = (cmdRaw || '').toLowerCase();
    const arg = rest.join(' ');
    const re = (() => {
      try {
        return new RegExp(arg, cmd === 'grep' && rest[0] === '-i' ? 'i' : '');
      } catch {
        return { test: (x) => x.includes(arg) };
      }
    })();
    const name = dialect.pipeAlias?.[cmd] || Object.keys(PIPES).find((k) => k.startsWith(cmd) && (dialect.pipes || []).includes(k));
    if (!name || !(dialect.pipes || []).includes(name)) return { error: cmd };
    out = PIPES[name](out, re, rest, arg);
  }
  return { lines: out };
}
const PIPES = {
  include: (l, re) => l.filter((x) => re.test(x)),
  exclude: (l, re) => l.filter((x) => !re.test(x)),
  begin: (l, re) => {
    const i = l.findIndex((x) => re.test(x));
    return i < 0 ? [] : l.slice(i);
  },
  section: (l, re) => {
    const out = [];
    let on = false;
    for (const x of l) {
      if (!/^\s/.test(x)) on = re.test(x);
      if (on) out.push(x);
    }
    return out;
  },
  count: (l, re, rest) => [rest.length ? `Number of lines which match regexp = ${l.filter((x) => re.test(x)).length}` : `Count: ${l.length} lines`],
  match: (l, re) => l.filter((x) => re.test(x)),
  except: (l, re) => l.filter((x) => !re.test(x)),
  grep: (l, re, rest) => {
    const inv = rest.includes('-v');
    const args = rest.filter((x) => !x.startsWith('-'));
    let r2 = re;
    try {
      r2 = new RegExp(args.join(' '), rest.includes('-i') ? 'i' : '');
    } catch {
      /* keep */
    }
    return l.filter((x) => (inv ? !r2.test(x) : r2.test(x)));
  },
  'no-more': (l) => l,
  last: (l, re, rest) => l.slice(-(Number(rest[0]) || 10)),
  head: (l, re, rest) => l.slice(0, Number(String(rest[0] || '').replace('-n', '').replace('-', '') || rest[1]) || 10),
  tail: (l, re, rest) => l.slice(-(Number(String(rest[0] || '').replace('-n', '').replace('-', '') || rest[1]) || 10)),
  wc: (l) => [String(l.length)],
  less: (l) => l,
  more: (l) => l,
  display: (l) => l,
  compare: (l) => l,
  json: (l) => l,
  sort: (l) => [...l].sort(),
};

// ---------------------------------------------------------------------------------------------
// Streams: long-running commands that print over time and can be interrupted with Ctrl+C
export function stream(chunks, { onInterrupt, then } = {}) {
  let i = 0;
  return {
    stream: true,
    next() {
      if (i < chunks.length) return chunks[i++];
      if (then) {
        const t = then;
        then = null;
        const r = t();
        if (r && typeof r === 'object' && r.stream) {
          chunks = chunks.concat([]);
          return { d: 0, t: '', chain: r };
        }
        return r != null ? { d: 0, t: Array.isArray(r) ? r.join('\n') + '\n' : r } : null;
      }
      return null;
    },
    interrupt() {
      i = chunks.length;
      then = null;
      return onInterrupt ? onInterrupt() : '^C\n';
    },
  };
}
// Infinite/generated stream: gen() returns {d,t} or null
export function genStream(gen, onInterrupt) {
  let done = false;
  return {
    stream: true,
    next() {
      if (done) return null;
      const c = gen();
      if (!c) done = true;
      return c;
    },
    interrupt() {
      done = true;
      return onInterrupt ? onInterrupt() : '^C\n';
    },
  };
}
export const ask = (prompt, cb, opts = {}) => ({ ask: true, prompt, cb, hidden: !!opts.hidden, key: !!opts.key, pre: opts.pre || '' });

// ---------------------------------------------------------------------------------------------
// A session on one device (or host) speaking one dialect
export class Session {
  constructor(term, { world, dialect, dev = null, host = null, via = 'console', user = 'admin', from = null, priv = 15 }) {
    this.term = term;
    this.world = world;
    this.dialect = dialect;
    this.dev = dev;
    this.host = host;
    this.via = via;
    this.user = user;
    this.from = from;
    this.priv = priv;
    this.mode = dialect.startMode || 'exec';
    this.ctx = {};
    this.termLen = dialect.defaultLen ?? 24;
    this.pending = null;
    this.monitor = via === 'console';
    this.closed = false;
    this.vars = {};
    dialect.init?.(this);
  }
  get prompt() {
    if (this.pending) return this.pending.prompt;
    return this.dialect.prompt(this);
  }
  get trie() {
    return this.dialect.trie(this, this.mode);
  }
  splitPipes(line) {
    if (this.dialect.noPipes) return { cmd: line, pipes: [] };
    const parts = [];
    let cur = '';
    let q = null;
    for (const ch of line) {
      if (q) {
        if (ch === q) q = null;
        cur += ch;
      } else if (ch === '"' || ch === "'") {
        q = ch;
        cur += ch;
      } else if (ch === '|') {
        parts.push(cur);
        cur = '';
      } else cur += ch;
    }
    parts.push(cur);
    return { cmd: parts[0], pipes: parts.slice(1).map((x) => x.trim()).filter(Boolean) };
  }
  // Execute a line; returns output object {text, stream?, ask?}
  exec(line) {
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      return this.finish(p.cb(line, this), []);
    }
    const D = this.dialect;
    if (D.preprocess) {
      const r = D.preprocess(this, line);
      if (r !== undefined) return this.finish(r, []);
    }
    const { cmd, pipes } = this.splitPipes(line);
    if (!cmd.trim()) return { text: D.emptyLine ? D.emptyLine(this) : '' };
    const toks = tokenize(cmd, D.quotes !== false);
    let res = walkTrie(this, this.trie, toks);
    let modeUsed = this.mode;
    if (res.kind !== 'ok' && D.fallback) {
      // IOS-style: a global-config command typed in a sub-mode drops back to the parent mode
      for (const m of D.fallback(this)) {
        const r2 = walkTrie(this, D.trie(this, m), toks);
        if (r2.kind === 'ok') {
          res = r2;
          modeUsed = m;
          break;
        }
      }
    }
    if (res.kind !== 'ok') {
      if (D.onUnknown) {
        const r = D.onUnknown(this, cmd, toks, res);
        if (r !== undefined) return this.finish(r, []);
      }
      const e = D.error(this, res.kind, { line: cmd, toks, at: res.at, pos: toks[res.at]?.s ?? cmd.length, options: res.options });
      return { text: e && !e.endsWith('\n') ? e + '\n' : e };
    }
    if (modeUsed !== this.mode) {
      this.mode = modeUsed;
      this.ctx = {};
    }
    const a = res.args;
    a.has = (k) => a.kw.includes(k);
    a.line = cmd;
    a.pipes = pipes;
    a.toks = toks;
    let out;
    try {
      out = res.def.run(this, a);
    } catch (e) {
      console.error(e);
      out = D.internalError ? D.internalError(this, e) : `% Internal error: ${e.message}`;
    }
    return this.finish(out, pipes, res.def);
  }
  finish(out, pipes, def) {
    if (out == null) return { text: '' };
    if (typeof out === 'object' && !Array.isArray(out)) return this.finishObj(out, pipes, def);
    return this.finishLines(out, pipes, def);
  }
  finishObj(out, pipes, def) {
    if (out.clear) return { text: '', clear: true };
    if (out.ask) {
      this.pending = out;
      return { text: out.pre || '', ask: out };
    }
    if (out.stream) return { text: '', stream: out };
    if (out.push) return { text: out.text || '', push: out.push };
    return this.finishLines(String(out.text ?? ''), pipes, def);
  }
  finishLines(out, pipes, def) {
    let lines = Array.isArray(out) ? out : String(out).split('\n');
    if (typeof out === 'string' && out.endsWith('\n')) lines = lines.slice(0, -1);
    if (out === '' || (lines.length === 1 && lines[0] === '' && !Array.isArray(out))) return { text: '' };
    if (pipes.length && !def?.rawPipes) {
      const r = applyPipes(lines, pipes, this.dialect);
      if (r.error) return { text: this.dialect.error(this, 'pipe', { line: '', pipe: r.error, pos: 0 }) };
      lines = r.lines;
    }
    const noMore = pipes.some((p) => /^no-more/.test(p));
    return { text: lines.length ? lines.join('\n') + '\n' : '', page: !noMore };
  }
  // "?" help: returns lines to print (the line stays in the input box)
  help(line) {
    const D = this.dialect;
    if (D.helpHook) {
      const r = D.helpHook(this, line);
      if (r !== undefined) return r;
    }
    const { cmd } = this.splitPipes(line);
    const toks = tokenize(cmd, D.quotes !== false);
    const trailing = cmd === '' || cmd.endsWith(' ');
    const consumed = trailing ? toks : toks.slice(0, -1);
    const partial = trailing ? '' : (toks[toks.length - 1]?.v || '').toLowerCase();
    let nodes = reach(this, this.trie, consumed);
    if (!nodes.length && D.fallback) for (const m of D.fallback(this)) if (!nodes.length) nodes = reach(this, D.trie(this, m), consumed);
    const items = new Map();
    let cr = false;
    for (const n of nodes) {
      for (const [k, c] of n.kws) if (!c.hidden && k.startsWith(partial)) items.set(c.raw, c.help || '');
      for (const p of n.params) {
        const isIf = p.type === 'if' || p.type === 'ifc';
        if (isIf && D.ifTypeHelp) {
          for (const [k, h] of D.ifTypeHelp(this, p.type === 'ifc')) if (k.toLowerCase().startsWith(partial)) items.set(k, h);
          continue;
        }
        if (trailing) items.set(paramHelpLabel(p), p.help || D.paramHelp?.(p) || '');
      }
      if (trailing && n.end) cr = true;
    }
    if (!items.size && !cr) {
      if (partial) {
        // Maybe the partial token is a parameter value being typed
        const nodes2 = reach(this, this.trie, toks);
        if (nodes2.length) return D.helpFmt(this, [], true, true);
      }
      return D.error(this, toks.length ? 'invalid' : 'invalid', { line: cmd, toks, at: Math.max(0, toks.length - 1), pos: toks.length ? toks[toks.length - 1].s : 0, help: true });
    }
    return D.helpFmt(this, [...items.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en', { sensitivity: 'base' })), cr, !trailing);
  }
  // Tab: returns {line, options}
  complete(line) {
    const D = this.dialect;
    if (D.completeHook) {
      const r = D.completeHook(this, line);
      if (r) return r;
    }
    const toks = tokenize(line, D.quotes !== false);
    if (!toks.length || line.endsWith(' ')) return { line, options: [] };
    const last = toks[toks.length - 1];
    let nodes = reach(this, this.trie, toks.slice(0, -1));
    if (!nodes.length && D.fallback) for (const m of D.fallback(this)) if (!nodes.length) nodes = reach(this, D.trie(this, m), toks.slice(0, -1));
    const opts = new Set();
    for (const n of nodes) for (const [k, c] of n.kws) if (k.startsWith(last.v.toLowerCase()) && !c.hidden) opts.add(c.raw);
    // interface names
    if (D.ifNames && this.dev) {
      for (const n of nodes) if (n.params.some((p) => p.type === 'if' || p.type === 'ifc')) for (const nm of D.ifNames(this)) if (nm.toLowerCase().startsWith(last.v.toLowerCase())) opts.add(nm);
    }
    const list = [...opts];
    if (list.length === 1) return { line: line.slice(0, last.s) + list[0] + ' ', options: [] };
    if (list.length > 1) {
      // longest common prefix
      let pre = list[0];
      for (const x of list) while (!x.toLowerCase().startsWith(pre.toLowerCase())) pre = pre.slice(0, -1);
      return { line: line.slice(0, last.s) + (pre.length > last.v.length ? pre : last.v), options: list.sort() };
    }
    return { line, options: [] };
  }
}

// ---------------------------------------------------------------------------------------------
// Terminal: a stack of sessions (jump host -> ssh -> ...), pager and stream plumbing
export class Terminal {
  constructor(world, root, { title } = {}) {
    this.world = world;
    this.stack = [];
    this.title = title;
    this.pager = null;
    this.history = [];
    this.listeners = new Set();
    if (root) this.push(root);
  }
  get top() {
    return this.stack[this.stack.length - 1];
  }
  get prompt() {
    if (this.pager) return this.pager.prompt;
    return this.top ? this.top.prompt : '';
  }
  get hidden() {
    return !!this.top?.pending?.hidden;
  }
  get keyMode() {
    return !!this.top?.pending?.key || !!this.pager;
  }
  push(sess) {
    sess.term = this;
    this.stack.push(sess);
  }
  // Handle one line of input. Returns {text, stream}
  input(line) {
    const s = this.top;
    if (!s) return { text: '' };
    if (!s.pending && line.trim() && !s.dialect.noHistory) this.history.push(line);
    const r = s.exec(line);
    return this.post(r);
  }
  post(r) {
    const s = this.top;
    let text = r.text || '';
    if (r.push) {
      this.push(r.push);
      const greet = r.push.dialect.greeting?.(r.push);
      if (greet) text += greet;
    }
    if (s && s.closed) {
      this.stack.pop();
      text += s.dialect.closeMsg ? s.dialect.closeMsg(s) : '';
      if (this.top && s.from) this.top.dialect.onChildClose?.(this.top, s);
    }
    if (r.page && text && this.top) {
      const len = this.top.termLen;
      const lines = text.split('\n');
      if (len > 0 && lines.length > len) {
        this.pager = { rest: lines.slice(len - 1), prompt: this.top.dialect.more || ' --More-- ' };
        text = lines.slice(0, len - 1).join('\n') + '\n';
      }
    }
    return { text, stream: r.stream || null, clear: !!r.clear };
  }
  // Pager keys: ' ' next page, Enter next line, q / Ctrl+C quit
  pagerKey(key) {
    const p = this.pager;
    if (!p) return { text: '' };
    const len = this.top?.termLen || 24;
    let n = 0;
    if (key === ' ') n = len - 1;
    else if (key === 'Enter') n = 1;
    else {
      this.pager = null;
      return { text: '' };
    }
    const chunk = p.rest.splice(0, n);
    if (!p.rest.length || (p.rest.length === 1 && p.rest[0] === '')) this.pager = null;
    return { text: chunk.join('\n') + (chunk.length ? '\n' : '') };
  }
  help(line) {
    return this.top ? this.top.help(line) : '';
  }
  complete(line) {
    return this.top ? this.top.complete(line) : { line, options: [] };
  }
  interrupt() {
    const s = this.top;
    if (!s) return '';
    if (s.pending) {
      s.pending = null;
      return s.dialect.ctrlC ? s.dialect.ctrlC(s) : '^C\n';
    }
    return s.dialect.ctrlC ? s.dialect.ctrlC(s) : '^C\n';
  }
  ctrlZ() {
    const s = this.top;
    return s?.dialect.ctrlZ ? s.dialect.ctrlZ(s) : '';
  }
  // Asynchronous log lines (console logging / terminal monitor)
  notify(text) {
    for (const l of this.listeners) l(text);
  }
}
