// Скрытая админ-панель: ровно три администратора, схема зала, президиум,
// пользователи, архив и пароли. Пароли хранятся только хэшами.

import { get, hardReset } from '../store.js';
import { api } from '../api.js';
import {
  adminLogin, adminSessionActive, endAdminSession, isAdminSession, passwordProblem,
} from '../auth.js';
import { chairmenOf, isChairman } from '../rules.js';
import {
  esc, icon, fmtDateTime, fmtTime,
} from '../utils.js';
import { clearImages } from '../idb.js';
import { openModal, closeModal, toast, confirmDialog } from './modal.js';

export function openAdminLogin() {
  if (isAdminSession()) return openAdminPanel();

  const body = `
    <div id="admin-login-error"></div>
    <div class="mini-note" style="margin-bottom:12px">
      Служебный вход организаторов. Доступ есть только у трёх администраторов.
    </div>
    <div class="field">
      <label class="label" for="admin-login">Логин</label>
      <input id="admin-login" class="input" autocomplete="username" maxlength="24" placeholder="логин администратора">
    </div>
    <div class="field">
      <label class="label" for="admin-pass">Пароль</label>
      <input id="admin-pass" class="input" type="password" autocomplete="current-password" maxlength="128" placeholder="••••••">
    </div>`;

  const footer = document.createElement('div');
  footer.className = 'btn-row';
  footer.style.width = '100%';
  footer.innerHTML = `
    <span class="spacer" style="flex:1"></span>
    <button type="button" class="btn ghost" data-admin-cancel>Отмена</button>
    <button type="button" class="btn primary" data-admin-submit>${icon('i-key')} Войти</button>`;

  const modal = openModal({ title: 'Служебный вход', body, footer, size: 'sm' });
  const root = modal.overlay;
  const errorBox = root.querySelector('#admin-login-error');
  const showError = (text) => {
    errorBox.innerHTML = `<div class="form-note error">${esc(text)}</div>`;
  };

  const submit = async () => {
    errorBox.innerHTML = '';
    const login = root.querySelector('#admin-login').value.trim();
    const password = root.querySelector('#admin-pass').value;
    if (!login || !password) return showError('Введите логин и пароль.');
    const btn = root.querySelector('[data-admin-submit]');
    btn.disabled = true;
    const result = await adminLogin(login, password);
    btn.disabled = false;
    if (!result.ok) return showError(result.reason);
    closeModal();
    toast(`Вход администратора: ${result.admin.login}.`, { kind: 'ok' });
    openAdminPanel();
  };

  root.querySelector('[data-admin-cancel]').addEventListener('click', closeModal);
  root.querySelector('[data-admin-submit]').addEventListener('click', submit);
  root.querySelector('#admin-pass').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });
}

export function openAdminPanel() {
  const session = adminSessionActive();
  if (!session) return openAdminLogin();

  const modal = openModal({
    title: 'Администрирование Асамблеи',
    body: '<div id="admin-panel-body"></div>',
    size: 'xl',
    refresh: () => draw(),
  });
  const root = modal.overlay;
  const host = root.querySelector('#admin-panel-body');
  const bodyEl = root.querySelector('.modal-body');

  function draw() {
    if (!host.isConnected) return;
    if (!isAdminSession()) {
      closeModal();
      openAdminLogin();
      return;
    }
    const state = get();
    const sessionNow = adminSessionActive();
    const scrollTop = bodyEl.scrollTop;
    const chairs = [1, 2].map((slot) => chairmenOf(state).find((c) => Number(c.chairSlot) === slot) || null);
    const candidates = state.diplomats
      .filter((d) => d.type === 'country' && d.isPrimary && !d.banned)
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru'));
    const occupied = state.diplomats.filter((d) => d.seatId && !String(d.seatId).startsWith('chair')).length;
    const docs = state.archive.slice().sort((a, b) => b.createdAt - a.createdAt);

    const userRows = state.diplomats
      .slice()
      .sort((a, b) => Number(a.banned) - Number(b.banned) || a.fullName.localeCompare(b.fullName, 'ru'))
      .map((d) => `
        <div class="admin-row">
          <div class="admin-row-main">
            <b>${esc(d.fullName)}</b> <span class="mini-note">${esc(d.country)}</span>
            <div class="mini-note">
              логин: <span class="mono">${d.login ? esc(d.login) : 'нет аккаунта'}</span>
              · ${isChairman(d) ? 'президиум' : d.role === 'observer' ? 'наблюдатель' : 'дипломат'}
              ${d.banned ? ' · <b style="color:#d8a79f">заблокирован</b>' : ''}
            </div>
          </div>
          <div class="admin-row-actions">
            <button type="button" class="btn tiny-btn ${d.banned ? 'paper' : 'ghost'}" data-ban="${d.id}" data-value="${d.banned ? '0' : '1'}">
              ${d.banned ? 'Разблокировать' : 'Забанить'}
            </button>
            <button type="button" class="btn tiny-btn danger" data-del-user="${d.id}">${icon('i-trash')}</button>
          </div>
        </div>`).join('');

    const docRows = docs.slice(0, 40).map((doc) => `
      <div class="admin-row">
        <div class="admin-row-main">
          <b>${esc(doc.number || '—')}</b> <span class="mini-note">${esc(doc.kind)}</span>
          <div class="mini-note">${esc(fmtDateTime(doc.createdAt))}${doc.topic ? ` · ${esc(doc.topic)}` : ''}</div>
        </div>
        <div class="admin-row-actions">
          <button type="button" class="btn tiny-btn danger" data-del-doc="${doc.id}" title="Удалить документ">${icon('i-trash')}</button>
        </div>
      </div>`).join('');

    const adminRows = state.admins.map((a) => `
      <div class="admin-row">
        <div class="admin-row-main">
          <b>${esc(a.name)}</b>
          <div class="mini-note">логин: <span class="mono">${esc(a.login)}</span></div>
        </div>
        <span class="badge ${a.id === sessionNow?.adminId ? 'ok' : 'plain'}">${a.id === sessionNow?.adminId ? 'эта сессия' : 'администратор'}</span>
      </div>`).join('');

    const chairRows = [0, 1].map((index) => {
      const slot = index + 1;
      const chair = chairs[index];
      return `<div class="admin-row">
        <div class="admin-row-main">
          <b>${slot === 2 ? 'Сопредседатель' : 'Председатель'}</b>
          <div class="mini-note">${chair ? `${esc(chair.fullName)} (${esc(chair.country)})` : 'не назначен'}</div>
        </div>
        <div class="admin-row-actions">
          ${chair ? `<button type="button" class="btn tiny-btn danger" data-release-chair="${chair.id}">Освободить</button>` : ''}
        </div>
      </div>`;
    }).join('');

    host.innerHTML = `
      <div class="form-note" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <span>Сессия: <b>${esc(sessionNow?.login || '—')}</b> · до ${esc(fmtTime(sessionNow?.until || Date.now()))}</span>
        <span style="flex:1"></span>
        <button type="button" class="btn small ghost" data-logout>${icon('i-x')} Выйти</button>
      </div>

      <div class="section-label">Схема зала</div>
      <div class="form-grid">
        <div class="field">
          <label class="label" for="admin-seats">Мест в зале (${SEAT_HINT})</label>
          <input id="admin-seats" class="input" type="number" min="12" max="80" value="${state.settings.seatCount}">
          <span class="hint">сейчас занято: ${occupied}</span>
        </div>
        <div class="field" style="justify-content:flex-end">
          <button type="button" class="btn" data-seats-apply>${icon('i-check')} Применить схему</button>
        </div>
      </div>

      <div class="section-label">Президиум</div>
      ${chairRows}
      <div class="form-grid" style="margin-top:8px">
        <div class="field">
          <label class="label" for="admin-chair-diplomat">Глава страны</label>
          <select id="admin-chair-diplomat" class="select">
            ${candidates.map((d) => `<option value="${d.id}">${esc(d.fullName)} · ${esc(d.country)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label class="label" for="admin-chair-slot">Кресло</label>
          <select id="admin-chair-slot" class="select">
            <option value="1">Председатель</option>
            <option value="2">Сопредседатель</option>
          </select>
        </div>
      </div>
      <button type="button" class="btn small paper" data-appoint-chair ${candidates.length ? '' : 'disabled'}>
        ${icon('i-gavel')} Назначить в президиум
      </button>

      <div class="section-label">Пароль президиума</div>
      <div class="mini-note" style="margin-bottom:8px">
        Известен только председателям. На сайте не отображается и не подсказывается; здесь можно задать новый.
      </div>
      <div class="form-grid">
        <div class="field">
          <label class="label" for="admin-chair-pass">Новый пароль (от 6 символов)</label>
          <input id="admin-chair-pass" class="input" type="password" autocomplete="new-password" maxlength="128">
        </div>
        <div class="field">
          <label class="label" for="admin-chair-pass2">Повторите</label>
          <input id="admin-chair-pass2" class="input" type="password" autocomplete="new-password" maxlength="128">
        </div>
      </div>
      <button type="button" class="btn small primary" data-chair-pass-save>${icon('i-key')} Сохранить пароль президиума</button>

      <div class="section-label">Пользователи · ${state.diplomats.length}</div>
      <div class="admin-list">${userRows || '<div class="mini-note">Пользователей пока нет.</div>'}</div>

      <div class="section-label">Администраторы · ровно три</div>
      <div class="admin-list">${adminRows}</div>
      <div class="form-grid" style="margin-top:8px">
        <div class="field">
          <label class="label" for="admin-account">Аккаунт</label>
          <select id="admin-account" class="select">
            ${state.admins.map((a) => `<option value="${a.id}">${esc(a.login)} · ${esc(a.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label class="label" for="admin-account-pass">Новый пароль</label>
          <input id="admin-account-pass" class="input" type="password" autocomplete="new-password" maxlength="128">
        </div>
      </div>
      <button type="button" class="btn small primary" data-admin-pass-save>${icon('i-key')} Сменить пароль администратора</button>

      <div class="section-label">Архив · ${docs.length}</div>
      <div class="admin-list">${docRows || '<div class="mini-note">Архив пуст.</div>'}</div>
      ${docs.length ? `<button type="button" class="btn small danger" style="margin-top:8px" data-clear-archive>${icon('i-trash')} Очистить архив</button>` : ''}

      <div class="section-label">Заседание</div>
      <div class="btn-row">
        <button type="button" class="btn small" data-new-meeting>${icon('i-gavel')} Новое заседание</button>
        <button type="button" class="btn small danger" data-full-reset>${icon('i-trash')} Полный сброс</button>
      </div>
      <div class="mini-note" style="margin-top:8px">
        Полный сброс удаляет дипломатов, чат, резолюции, архив и возвращает админ-аккаунты
        и пароль президиума к исходным значениям.
      </div>`;

    bodyEl.scrollTop = scrollTop;
  }

  draw();

  root.addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-logout],[data-seats-apply],[data-appoint-chair],[data-chair-pass-save],[data-admin-pass-save],[data-clear-archive],[data-new-meeting],[data-full-reset],[data-ban],[data-del-user],[data-del-doc],[data-release-chair]');
    if (!btn || btn.disabled) return;

    if (btn.hasAttribute('data-logout')) {
      endAdminSession();
      closeModal();
      toast('Сеанс администратора завершён.', { kind: 'info' });
      return;
    }

    if (btn.hasAttribute('data-seats-apply')) {
      const value = Number(root.querySelector('#admin-seats').value);
      const result = api.admin.setSeatCount(value);
      if (!result.ok) return toast(result.reason, { kind: 'bad' });
      toast(`Схема зала: ${result.data} мест.`, { kind: 'ok' });
      draw();
      return;
    }

    if (btn.hasAttribute('data-appoint-chair')) {
      const diplomatId = root.querySelector('#admin-chair-diplomat').value;
      const slot = Number(root.querySelector('#admin-chair-slot').value);
      const result = api.admin.appointChair(diplomatId, slot);
      if (!result.ok) return toast(result.reason, { kind: 'bad' });
      toast('Президиум обновлён.', { kind: 'ok' });
      draw();
      return;
    }

    if (btn.hasAttribute('data-chair-pass-save')) {
      const next = root.querySelector('#admin-chair-pass').value;
      const repeat = root.querySelector('#admin-chair-pass2').value;
      const problem = passwordProblem(next);
      if (problem) return toast(problem, { kind: 'warn' });
      if (next !== repeat) return toast('Пароли не совпадают.', { kind: 'warn' });
      const result = await api.admin.setChairPassword(next);
      if (!result.ok) return toast(result.reason, { kind: 'bad' });
      toast('Пароль президиума изменён.', { kind: 'ok' });
      draw();
      return;
    }

    if (btn.hasAttribute('data-admin-pass-save')) {
      const adminId = root.querySelector('#admin-account').value;
      const next = root.querySelector('#admin-account-pass').value;
      const problem = passwordProblem(next);
      if (problem) return toast(problem, { kind: 'warn' });
      const result = await api.admin.setAdminPassword(adminId, next);
      if (!result.ok) return toast(result.reason, { kind: 'bad' });
      toast('Пароль администратора изменён.', { kind: 'ok' });
      draw();
      return;
    }

    if (btn.hasAttribute('data-ban')) {
      const id = btn.dataset.ban;
      const banned = btn.dataset.value === '1';
      const result = api.admin.setBanned(id, banned);
      if (!result.ok) return toast(result.reason, { kind: 'bad' });
      toast(banned ? 'Пользователь заблокирован.' : 'Пользователь разблокирован.', { kind: banned ? 'warn' : 'ok' });
      draw();
      return;
    }

    if (btn.hasAttribute('data-del-user')) {
      const id = btn.dataset.delUser;
      const d = get().diplomats.find((x) => x.id === id);
      const yes = await confirmDialog(
        `Удалить пользователя <b>${esc(d?.fullName || '')}</b> (${esc(d?.country || '')})?`,
        { title: 'Удаление пользователя', confirmLabel: 'Удалить' },
      );
      if (!yes) return;
      const result = api.diplomats.remove(id);
      if (!result.ok) return toast(result.reason, { kind: 'bad' });
      toast('Пользователь удалён.', { kind: 'warn' });
      draw();
      return;
    }

    if (btn.hasAttribute('data-del-doc')) {
      const result = api.archive.remove(btn.dataset.delDoc);
      if (!result.ok) return toast(result.reason, { kind: 'bad' });
      toast('Документ удалён из архива.', { kind: 'info' });
      draw();
      return;
    }

    if (btn.hasAttribute('data-release-chair')) {
      const result = api.admin.releaseChair(btn.dataset.releaseChair);
      if (!result.ok) return toast(result.reason, { kind: 'bad' });
      toast('Кресло президиума освобождено.', { kind: 'warn' });
      draw();
      return;
    }

    if (btn.hasAttribute('data-clear-archive')) {
      const yes = await confirmDialog(
        'Удалить все документы архива? Дипломаты и заседание останутся.',
        { title: 'Очистка архива', confirmLabel: 'Очистить' },
      );
      if (!yes) return;
      const result = api.archive.clear();
      if (!result.ok) return toast(result.reason, { kind: 'bad' });
      toast('Архив очищен.', { kind: 'warn' });
      draw();
      return;
    }

    if (btn.hasAttribute('data-new-meeting')) {
      const yes = await confirmDialog(
        'Открыть новое заседание? Зал освободится, архив сохранится.',
        { title: 'Новое заседание', confirmLabel: 'Открыть', danger: false },
      );
      if (!yes) return;
      const result = api.session.newMeeting();
      if (!result.ok) return toast(result.reason, { kind: 'bad' });
      toast('Открыто новое заседание.', { kind: 'ok' });
      draw();
      return;
    }

    if (btn.hasAttribute('data-full-reset')) {
      const yes = await confirmDialog(
        '<b>ВНИМАНИЕ.</b> Полный сброс удалит дипломатов, чат, резолюции, голосования и архив. '
        + 'Админ-аккаунты и пароль президиума вернутся к исходным. Продолжить?',
        { title: 'Полный сброс', confirmLabel: 'Удалить всё' },
      );
      if (!yes) return;
      closeModal();
      hardReset();
      await clearImages();
      toast('Все данные удалены. Система в исходном состоянии.', { kind: 'warn' });
    }
  });
}

const SEAT_HINT = '12–80';
