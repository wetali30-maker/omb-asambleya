// Окно общего зала: создание комнаты, вход по коду и ссылка-приглашение.

import {
  get,
} from '../store.js';
import { activeDiplomat } from '../rules.js';
import {
  joinRoom, leaveRoom, netInfo, subscribeNet, randomRoomCode, normalizeRoom,
} from '../net.js';
import { openModal, closeModal, toast, confirmDialog } from './modal.js';
import { esc, icon } from '../utils.js';

let unwatch = null;

export function openNetworkModal() {
  if (netInfo().room) renderRoom();
  else renderEntry();
}

function stopWatch() {
  if (unwatch) {
    unwatch();
    unwatch = null;
  }
}

function copyInvite() {
  const input = document.getElementById('net-link');
  const text = input?.value || netInfo().invite;
  if (!text) return;
  const done = () => toast('Ссылка-приглашение скопирована.', { kind: 'ok' });
  const fallback = () => {
    try {
      input?.select();
      if (document.execCommand('copy')) { done(); return; }
    } catch { /* noop */ }
    toast('Скопируйте ссылку из поля вручную.', { kind: 'info' });
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(fallback);
  } else {
    fallback();
  }
}

function peersHtml(info) {
  const rows = info.peers.map((p) => `<span class="net-peer${p.self ? ' self' : ''}">${esc(p.nick)}${p.self ? ' · вы' : ''}</span>`);
  return rows.join('') || '<span class="mini-note">Пока никого нет. Пригласите друзей.</span>';
}

function statusText(info) {
  if (info.status === 'online') return `на связи · в зале ${info.online}`;
  if (info.status === 'connecting') return 'подключение…';
  return 'переподключение…';
}

function renderEntry(prefill = '') {
  stopWatch();
  const actor = activeDiplomat(get());
  const nick = actor ? actor.fullName : 'Гость';

  const body = `
    <div class="form-note" style="margin-bottom:12px">
      <b>Зал общий для всех друзей.</b> Создайте зал и отправьте ссылку-приглашение:
      друзья увидят тот же зал, чат, резолюции и голосования в реальном времени.
    </div>
    <div class="form-grid">
      <div class="field">
        <label class="label" for="net-nick">Ваше имя в зале</label>
        <input id="net-nick" class="input" maxlength="40" value="${esc(nick)}" placeholder="Как вас видят друзья">
      </div>
      <div class="field">
        <label class="label" for="net-code">Код зала</label>
        <input id="net-code" class="input" maxlength="12" value="${esc(prefill)}"
               placeholder="Например, KREMLIN7" autocapitalize="characters"
               autocomplete="off" spellcheck="false">
      </div>
    </div>
    <div class="mini-note" style="margin-top:10px">
      Код — от 4 до 12 латинских букв или цифр. Зал защищён только кодом: не используйте
      настоящие пароли и не публикуйте код в открытых местах. Данные идут через публичный MQTT-брокер.
    </div>`;

  const footer = document.createElement('div');
  footer.className = 'btn-row';
  footer.style.width = '100%';
  footer.innerHTML = `
    <span class="spacer" style="flex:1"></span>
    <button type="button" class="btn ghost" data-net-cancel>Отмена</button>
    <button type="button" class="btn" data-net-join>${icon('i-key')} Войти по коду</button>
    <button type="button" class="btn primary" data-net-create>${icon('i-users')} Создать зал</button>`;

  const modal = openModal({ title: 'Общий зал', body, footer, size: 'md' });
  const root = modal.overlay;
  const codeInput = root.querySelector('#net-code');
  const nickInput = root.querySelector('#net-nick');

  codeInput.addEventListener('input', () => {
    codeInput.value = normalizeRoom(codeInput.value);
  });

  const enter = (code) => {
    const result = joinRoom(code, { nick: nickInput.value });
    if (!result.ok) {
      toast(result.reason, { kind: 'warn' });
      return false;
    }
    renderRoom();
    return true;
  };

  root.querySelector('[data-net-cancel]').addEventListener('click', closeModal);

  root.querySelector('[data-net-create]').addEventListener('click', () => {
    const code = randomRoomCode();
    if (enter(code)) toast(`Зал ${code} создан. Подключение…`, { kind: 'ok' });
  });

  root.querySelector('[data-net-join]').addEventListener('click', () => {
    const code = normalizeRoom(codeInput.value);
    if (code.length < 4) {
      toast('Введите код зала: 4–12 латинских букв или цифр.', { kind: 'warn' });
      return;
    }
    if (enter(code)) toast(`Входим в зал ${code}…`, { kind: 'info' });
  });
}

function renderRoom() {
  stopWatch();
  const info = netInfo();

  const body = `
    <div class="net-card">
      <div class="net-card-head">
        <span class="section-label">Код зала</span>
        <span class="net-code">${esc(info.room)}</span>
        <span class="net-state ${info.status === 'online' ? 'ok' : 'wait'}" id="net-state">${statusText(info)}</span>
      </div>
      <div class="mini-note">Отправьте друзьям ссылку — они попадут в этот же зал.</div>
      <div class="net-copy">
        <input class="input net-link" id="net-link" readonly value="${esc(info.invite)}">
        <button type="button" class="btn small primary" data-net-copy>${icon('i-send')} Скопировать</button>
      </div>
      <div class="net-peers" id="net-peers">${peersHtml(info)}</div>
    </div>
    <div class="divider-line"></div>
    <div class="mini-note">
      Действия в зале, чат, аккаунты дипломатов (пароли — только в виде хэшей) и голосования
      синхронизируются между устройствами. Перед входом в чужой зал локальный зал сохраняется
      в резервную копию браузера.
    </div>`;

  const footer = document.createElement('div');
  footer.className = 'btn-row';
  footer.style.width = '100%';
  footer.innerHTML = `
    <button type="button" class="btn ghost" data-net-leave>Покинуть зал</button>
    <span class="spacer" style="flex:1"></span>
    <button type="button" class="btn" data-net-close>Закрыть</button>`;

  const modal = openModal({ title: 'Общий зал', body, footer, size: 'md', onClose: stopWatch });
  const root = modal.overlay;

  root.querySelector('[data-net-copy]').addEventListener('click', copyInvite);
  root.querySelector('[data-net-close]').addEventListener('click', closeModal);
  root.querySelector('[data-net-leave]').addEventListener('click', async () => {
    const yes = await confirmDialog(
      `Покинуть общий зал <b>${esc(info.room)}</b>?<br>Заседание останется в этом браузере, но перестанет синхронизироваться.`,
      { title: 'Покинуть зал', confirmLabel: 'Покинуть', danger: true },
    );
    if (!yes) return;
    leaveRoom();
    closeModal();
    toast('Вы вышли из общего зала. Заседание продолжается локально.', { kind: 'info' });
  });

  unwatch = subscribeNet((next) => {
    if (!root.isConnected) {
      stopWatch();
      return;
    }
    const stateEl = root.querySelector('#net-state');
    if (stateEl) {
      stateEl.textContent = statusText(next);
      stateEl.classList.toggle('ok', next.status === 'online');
      stateEl.classList.toggle('wait', next.status !== 'online');
    }
    const peersEl = root.querySelector('#net-peers');
    if (peersEl) peersEl.innerHTML = peersHtml(next);
  });
}
