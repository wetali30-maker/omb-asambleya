// Модальные окна, подтверждения и тосты.

import { subscribe } from '../store.js';
import { esc, icon } from '../utils.js';

let current = null;
let keyHandler = null;

function modalRoot() {
  return document.getElementById('modal-root');
}

subscribe(() => {
  if (current?.refresh) {
    try { current.refresh(); } catch (err) { console.error('Ошибка обновления модалки', err); }
  }
});

export function openModal({
  title = 'Документ', body = '', size = 'md', footer = null, refresh = null, onClose = null,
} = {}) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal ${size}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head">
        <h3 class="modal-title">${esc(title)}</h3>
        <button type="button" class="icon-btn" data-close aria-label="Закрыть">${icon('i-x')}</button>
      </div>
      <div class="modal-body"></div>
      ${footer ? '<div class="modal-foot"></div>' : ''}
    </div>`;

  const bodyEl = overlay.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);

  if (footer) {
    const footEl = overlay.querySelector('.modal-foot');
    if (typeof footer === 'string') footEl.innerHTML = footer;
    else footEl.appendChild(footer);
  }

  modalRoot().appendChild(overlay);

  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeModal(); });
  overlay.querySelector('[data-close]').addEventListener('click', () => closeModal());

  keyHandler = (e) => { if (e.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', keyHandler);

  current = { overlay, bodyEl, refresh, onClose, close: closeModal };

  const focusTarget = overlay.querySelector('input:not([type=file]):not([type=checkbox]), textarea, select');
  if (focusTarget) setTimeout(() => { try { focusTarget.focus(); } catch { /* noop */ } }, 50);

  return current;
}

export function closeModal() {
  if (keyHandler) {
    document.removeEventListener('keydown', keyHandler);
    keyHandler = null;
  }
  const overlay = current?.overlay;
  const cb = current?.onClose;
  current = null;
  if (overlay) overlay.remove();
  if (cb) {
    try { cb(); } catch (err) { console.error(err); }
  }
}

export function currentModal() {
  return current;
}

export function confirmDialog(message, {
  title = 'Подтверждение', confirmLabel = 'Подтвердить', cancelLabel = 'Отмена', danger = true,
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.zIndex = '130';
    overlay.innerHTML = `
      <div class="modal sm" role="alertdialog" aria-modal="true">
        <div class="modal-head">
          <h3 class="modal-title">${esc(title)}</h3>
          <button type="button" class="icon-btn" data-no aria-label="Закрыть">${icon('i-x')}</button>
        </div>
        <div class="modal-body"><div style="font-size:13px;line-height:1.65">${message}</div></div>
        <div class="modal-foot">
          <button type="button" class="btn ghost" data-no>${esc(cancelLabel)}</button>
          <button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const done = (value) => {
      overlay.remove();
      document.removeEventListener('keydown', key);
      resolve(value);
    };
    const key = (e) => {
      if (e.key === 'Escape') done(false);
      if (e.key === 'Enter') done(true);
    };
    document.addEventListener('keydown', key);
    overlay.querySelectorAll('[data-no]').forEach((btn) => btn.addEventListener('click', () => done(false)));
    overlay.querySelector('[data-yes]').addEventListener('click', () => done(true));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(false); });
    setTimeout(() => overlay.querySelector('[data-yes]')?.focus(), 40);
  });
}

export function toast(message, { kind = 'info', actions = [], timeout = 5600 } = {}) {
  const rootEl = document.getElementById('toast-root');
  if (!rootEl) return { close() {} };

  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `
    <div class="t-body">${esc(message)}</div>
    <button type="button" class="t-close" aria-label="Скрыть">×</button>`;

  if (actions.length) {
    const actionsEl = document.createElement('div');
    actionsEl.className = 't-actions';
    for (const action of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn small';
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        el.remove();
        try { action.onClick?.(); } catch (err) { console.error(err); }
      });
      actionsEl.appendChild(btn);
    }
    el.querySelector('.t-body').appendChild(actionsEl);
  }

  const close = () => el.remove();
  el.querySelector('.t-close').addEventListener('click', close);
  rootEl.appendChild(el);
  if (timeout) setTimeout(close, timeout);
  return { close };
}
