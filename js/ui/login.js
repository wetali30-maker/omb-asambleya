// Вход по логину и паролю. Пароли проверяются по PBKDF2-хэшу.

import { get } from '../store.js';
import { api } from '../api.js';
import { loginDiplomat, passwordProblem } from '../auth.js';
import { esc, icon } from '../utils.js';
import { openModal, closeModal, toast } from './modal.js';

export function openLoginModal({ diplomatId = null, onSuccess = null } = {}) {
  const state = get();
  const target = diplomatId ? state.diplomats.find((d) => d.id === diplomatId) : null;
  const body = `
    <div id="login-error"></div>
    <div class="mini-note" style="margin-bottom:12px">
      ${target ? `Вход в личное дело: <b>${esc(target.fullName)}</b> (${esc(target.country)}).` : 'Вход в аккаунт дипломата.'}
      Пароль хранится только в виде хэша и нигде не отображается.
    </div>
    <div class="field">
      <label class="label" for="login-name">Логин</label>
      <input id="login-name" class="input" autocomplete="username" maxlength="24"
        value="${esc(target?.login || '')}" placeholder="ваш логин">
    </div>
    <div class="field">
      <label class="label" for="login-pass">Пароль</label>
      <input id="login-pass" class="input" type="password" autocomplete="current-password"
        maxlength="128" placeholder="••••••">
    </div>`;

  const footer = document.createElement('div');
  footer.className = 'btn-row';
  footer.style.width = '100%';
  footer.innerHTML = `
    <span class="spacer" style="flex:1"></span>
    <button type="button" class="btn ghost" data-login-cancel>Отмена</button>
    <button type="button" class="btn primary" data-login-submit>${icon('i-user')} Войти</button>`;

  const modal = openModal({ title: 'Вход', body, footer, size: 'sm' });
  const root = modal.overlay;
  const errorBox = root.querySelector('#login-error');
  const showError = (text) => {
    errorBox.innerHTML = `<div class="form-note error">${esc(text)}</div>`;
  };

  const submit = async () => {
    errorBox.innerHTML = '';
    const login = root.querySelector('#login-name').value.trim();
    const password = root.querySelector('#login-pass').value;
    if (!login || !password) {
      showError('Введите логин и пароль.');
      return;
    }
    const btn = root.querySelector('[data-login-submit]');
    btn.disabled = true;
    const result = await loginDiplomat(login, password);
    btn.disabled = false;
    if (!result.ok) {
      showError(result.reason);
      return;
    }
    if (target && result.diplomat.id !== target.id) {
      showError('Этот логин принадлежит другому дипломату.');
      return;
    }
    const set = api.session.setActive(result.diplomat.id);
    if (!set.ok) {
      showError(set.reason);
      return;
    }
    try { sessionStorage.setItem('omb.auth.user', result.diplomat.id); } catch { /* noop */ }
    closeModal();
    toast(`Вход выполнен: ${result.diplomat.fullName} (${result.diplomat.country}).`, { kind: 'ok' });
    if (onSuccess) onSuccess(result.diplomat);
  };

  root.querySelector('[data-login-cancel]').addEventListener('click', closeModal);
  root.querySelector('[data-login-submit]').addEventListener('click', submit);
  root.querySelector('#login-pass').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });
  setTimeout(() => root.querySelector('#login-pass')?.focus({ preventScroll: true }), 120);
}

export function openPasswordForm(diplomatId) {
  const diplomat = get().diplomats.find((d) => d.id === diplomatId);
  if (!diplomat) return;

  const body = `
    <div id="pass-error"></div>
    <div class="mini-note" style="margin-bottom:12px">
      Новый пароль для <b>${esc(diplomat.fullName)}</b> (${esc(diplomat.country)}).
      Сохраняется только хэш; восстановить старый пароль нельзя.
    </div>
    <div class="field">
      <label class="label" for="pass-next">Новый пароль</label>
      <input id="pass-next" class="input" type="password" autocomplete="new-password" maxlength="128" placeholder="не короче 6 символов">
    </div>
    <div class="field">
      <label class="label" for="pass-repeat">Повторите пароль</label>
      <input id="pass-repeat" class="input" type="password" autocomplete="new-password" maxlength="128" placeholder="••••••">
    </div>`;

  const footer = document.createElement('div');
  footer.className = 'btn-row';
  footer.style.width = '100%';
  footer.innerHTML = `
    <span class="spacer" style="flex:1"></span>
    <button type="button" class="btn ghost" data-pass-cancel>Отмена</button>
    <button type="button" class="btn primary" data-pass-save>${icon('i-key')} Сменить пароль</button>`;

  const modal = openModal({ title: 'Смена пароля', body, footer, size: 'sm' });
  const root = modal.overlay;
  const errorBox = root.querySelector('#pass-error');
  const showError = (text) => {
    errorBox.innerHTML = `<div class="form-note error">${esc(text)}</div>`;
  };

  root.querySelector('[data-pass-cancel]').addEventListener('click', closeModal);
  root.querySelector('[data-pass-save]').addEventListener('click', async () => {
    errorBox.innerHTML = '';
    const next = root.querySelector('#pass-next').value;
    const repeat = root.querySelector('#pass-repeat').value;
    const problem = passwordProblem(next);
    if (problem) return showError(problem);
    if (next !== repeat) return showError('Пароли не совпадают.');
    const result = await api.diplomats.setPassword(diplomat.id, next);
    if (!result.ok) return showError(result.reason);
    closeModal();
    toast('Пароль изменён.', { kind: 'ok' });
  });
}
