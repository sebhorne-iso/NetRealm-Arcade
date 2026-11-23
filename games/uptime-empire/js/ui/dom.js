// Tiny DOM toolkit: safe element builder (text is never parsed as HTML), modals and toasts.
export function h(tag, attrs = {}, ...kids) {
  const m = tag.match(/^([a-z0-9-]*)(?:#([\w-]+))?((?:\.[\w-]+)*)$/i) || [null, tag, null, ''];
  const el = document.createElement(m[1] || 'div');
  if (m[2]) el.id = m[2];
  if (m[3]) el.className = m[3].slice(1).split('.').join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className += ` ${v}`;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  add(el, kids);
  return el;
}
function add(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
export const clear = (el) => {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
};
export const fill = (el, ...kids) => {
  clear(el);
  add(el, kids);
  return el;
};
export const btn = (label, onclick, cls = '') => h(`button.btn${cls ? `.${cls.trim().split(/\s+/).join('.')}` : ''}`, { onclick, type: 'button' }, label);

export function modal(title, body, { actions = [], wide = false } = {}) {
  const back = h('div.modal-back');
  const close = () => back.remove();
  const box = h(`div.modal${wide ? '.wide' : ''}`, { role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('div.modal-head', {}, h('h2', {}, title), h('button.x', { onclick: close, 'aria-label': 'Close', type: 'button' }, '×')), h('div.modal-body', {}, body), actions.length ? h('div.modal-foot', {}, actions.map(([label, fn, cls]) => btn(label, () => (fn() === false ? 0 : close()), cls))) : null);
  back.append(box);
  back.addEventListener('mousedown', (e) => e.target === back && close());
  back.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  document.body.append(back);
  setTimeout(() => box.querySelector('input,select,textarea,button:not(.x)')?.focus(), 0);
  return { close, box };
}
export function alertBox(title, text) {
  return modal(title, h('p', {}, text), { actions: [['OK', () => {}]] });
}

let toastHost = null;
export function toastUI(text, kind = 'info', ms = 6000) {
  if (!toastHost) {
    toastHost = h('div.toasts', { 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const el = h(`div.toast.${kind}`, {}, text);
  toastHost.prepend(el);
  while (toastHost.children.length > 5) toastHost.lastChild.remove();
  setTimeout(() => el.classList.add('fade'), ms);
  setTimeout(() => el.remove(), ms + 600);
}
export const money = (n) => `${n < 0 ? '-' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
export function table(cols, rows, { cls = '' } = {}) {
  return h(`table.grid${cls ? `.${cls}` : ''}`, {}, h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c)))), h('tbody', {}, rows.map((r) => (r instanceof Node ? r : h('tr', {}, r.map((c) => (c instanceof Node && c.tagName === 'TD' ? c : h('td', {}, c))))))));
}
export const pill = (text, kind) => h(`span.pill.${kind}`, {}, text);
