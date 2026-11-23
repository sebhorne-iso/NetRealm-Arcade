// Minimal DOM helpers: element builder, modals, toasts, dialogs.
import { audio } from '../engine/audio.js';

export function h(tag, attrs = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val);
        else el.style[prop] = val;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  appendAll(el, children);
  return el;
}

function appendAll(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function btn(label, onClick, cls = '', attrs = {}) {
  return h(
    'button.btn' + (cls ? '.' + cls.split(' ').join('.') : ''),
    {
      type: 'button',
      ...attrs,
      onclick: (e) => {
        audio.sfx('select');
        onClick?.(e);
      },
    },
    label
  );
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Render a little inline markup: `code`, **bold**. Everything else is escaped.
export function rich(text) {
  const span = document.createElement('span');
  span.innerHTML = esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
  return span;
}

// ---------- toasts ----------
export function toast(msg, { icon = '', kind = 'info', ms = 3200 } = {}) {
  const root = document.getElementById('toasts');
  const t = h('div.toast.toast-' + kind, {}, icon ? h('span.toast-icon', {}, icon) : null, h('span', {}, msg));
  root.append(t);
  // Keep at most 3 on screen so they never bury the battle.
  while (root.children.length > 3) root.firstChild.remove();
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 400);
  }, ms);
}

// ---------- modal ----------
let modalStack = [];
export function modal(content, { title, onClose, wide = false, closable = true } = {}) {
  const root = document.getElementById('modal-root');
  const box = h('div.window.modal' + (wide ? '.modal-wide' : ''), { role: 'dialog', 'aria-modal': 'true' });
  const close = () => {
    overlay.remove();
    modalStack = modalStack.filter((m) => m !== api);
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && closable && modalStack[modalStack.length - 1] === api) {
      e.stopPropagation();
      close();
    }
  };
  if (title) box.append(h('div.window-title', {}, title));
  if (closable) box.append(h('button.modal-x', { type: 'button', 'aria-label': 'Close', onclick: close }, '✕'));
  const body = h('div.modal-body');
  appendAll(body, [typeof content === 'function' ? content(() => close()) : content]);
  box.append(body);
  const overlay = h('div.overlay', { onclick: (e) => closable && e.target === overlay && close() }, box);
  root.append(overlay);
  document.addEventListener('keydown', onKey, true);
  const api = { close, body, box };
  modalStack.push(api);
  setTimeout(() => (box.querySelector('[autofocus]') || box.querySelector('button:not(.modal-x), input, textarea'))?.focus(), 30);
  return api;
}

export function anyModalOpen() {
  return modalStack.length > 0;
}

export function confirmDialog(message, { yes = 'Yes', no = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const m = modal(
      (close) =>
        h(
          'div',
          {},
          h('p.dialog-text', {}, message),
          h(
            'div.row.end',
            {},
            btn(no, () => {
              answered = true;
              close();
              resolve(false);
            }),
            btn(
              yes,
              () => {
                answered = true;
                close();
                resolve(true);
              },
              danger ? 'danger' : 'primary'
            )
          )
        ),
      { onClose: () => !answered && resolve(false) }
    );
    return m;
  });
}

// ---------- story dialog with typewriter text ----------
export function storyDialog(lines, { speaker = 'Old Man Ping', portrait = null, reduceMotion = false } = {}) {
  return new Promise((resolve) => {
    let i = 0;
    let typing = null;
    const textEl = h('p.story-text');
    const nextBtn = h('button.btn.primary.story-next', { type: 'button' }, '▶');
    const box = h(
      'div.story',
      {},
      portrait ? h('div.story-portrait', {}, portrait) : null,
      h('div.story-main', {}, h('div.story-speaker', {}, speaker), textEl, h('div.row.end', {}, nextBtn))
    );
    const show = () => {
      const full = lines[i];
      textEl.textContent = '';
      if (reduceMotion) {
        textEl.replaceChildren(rich(full));
        return;
      }
      let n = 0;
      clearInterval(typing);
      typing = setInterval(() => {
        n += 2;
        textEl.textContent = full.slice(0, n).replace(/\*\*/g, '').replace(/`/g, '');
        if (n % 6 === 0) audio.sfx('type');
        if (n >= full.length) {
          clearInterval(typing);
          typing = null;
          textEl.replaceChildren(rich(full));
        }
      }, 18);
    };
    const advance = () => {
      if (typing) {
        clearInterval(typing);
        typing = null;
        textEl.replaceChildren(rich(lines[i]));
        return;
      }
      audio.sfx('select');
      i++;
      if (i >= lines.length) {
        m.close();
        return;
      }
      nextBtn.textContent = i === lines.length - 1 ? '✔' : '▶';
      show();
    };
    nextBtn.onclick = advance;
    box.addEventListener('click', (e) => {
      if (e.target !== nextBtn) advance();
    });
    const m = modal(box, { closable: true, onClose: () => { clearInterval(typing); resolve(); } });
    m.box.classList.add('story-modal');
    nextBtn.textContent = lines.length === 1 ? '✔' : '▶';
    show();
    nextBtn.focus();
  });
}

export function bar(value, max, cls = 'hp') {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return h('div.bar.bar-' + cls, {}, h('div.bar-fill', { style: { width: pct + '%' } }));
}

export function setBar(el, value, max) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  el.querySelector('.bar-fill').style.width = pct + '%';
  el.classList.toggle('low', pct <= 25);
}

export function fmtNum(n) {
  return Math.round(n).toLocaleString('en-US');
}

export function spriteImg(url, cls = '') {
  return h('img.sprite' + (cls ? '.' + cls : ''), { src: url, alt: '', draggable: false });
}
