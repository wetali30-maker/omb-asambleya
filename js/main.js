// Точка входа: шапка, зал, левая панель делегаций, рабочий стол, лента, маршруты.

import { get, subscribe } from './store.js';
import {
  activeDiplomat, chairmenOf, chairmanAt, isChairman, isSeatedChairman,
  quorumInfo, openVoting, speechQueue, currentSpeaker, speechStatusFor,
} from './rules.js';
import {
  $, esc, icon, dateLabel, fmtClock, fmtElapsed, fmtTime, roleLabel, pluralRu, avatarHtml,
} from './utils.js';
import { getImageUrl } from './idb.js';
import { openModal, closeModal, confirmDialog, toast } from './ui/modal.js';
import { render as renderHeader } from './ui/header.js';
import { renderHall, setupHallTools } from './ui/hall.js';
import { renderVotingBand } from './ui/voting.js';
import { renderChat } from './ui/chat.js';
import { renderResolutions } from './ui/resolutions.js';
import { renderJournal } from './ui/journal.js';
import { renderArchive } from './ui/archive.js';
import { openDiplomatForm, openDiplomatCard, openChairmanPicker } from './ui/diplomats.js';
import { openLoginModal } from './ui/login.js';
import { openProtoViewer } from './ui/viewers.js';
import { openNetworkModal } from './ui/network.js';
import { initNet, netInfo } from './net.js';
import { api } from './api.js';
import { unlockAudio } from './audio.js';

/* ------------------------------------------------------------------ */
/* Маршрутизация                                                       */
/* ------------------------------------------------------------------ */

function isArchiveRoute() {
  return location.hash.startsWith('#/archive');
}

function applyRoute() {
  const archive = isArchiveRoute();
  const hallView = $('#hall-view');
  const archiveView = $('#archive-view');
  const leftPanel = $('#left-panel');
  const side = $('#side');
  if (hallView) hallView.hidden = archive;
  if (archiveView) archiveView.hidden = !archive;
  if (leftPanel) leftPanel.hidden = archive;
  if (side) side.hidden = archive;
  if (archive) {
    closeDrawers();
    renderArchive();
  }
}

/* ------------------------------------------------------------------ */
/* Шторки на планшете и телефоне                                       */
/* ------------------------------------------------------------------ */

function closeDrawers() {
  $('#left-panel')?.classList.remove('open');
  $('#side')?.classList.remove('open');
  const scrim = $('#drawer-scrim');
  if (scrim) scrim.hidden = true;
  document.body.classList.remove('drawer-open');
  syncMobileNav();
}

function openDrawer(which) {
  const left = $('#left-panel');
  const side = $('#side');
  if (!left || !side) return;
  if (which === 'left') {
    side.classList.remove('open');
    left.classList.add('open');
  } else {
    left.classList.remove('open');
    side.classList.add('open');
  }
  const scrim = $('#drawer-scrim');
  if (scrim) scrim.hidden = false;
  document.body.classList.add('drawer-open');
  syncMobileNav();
}

function syncMobileNav() {
  const sideOpen = $('#side')?.classList.contains('open');
  const leftOpen = $('#left-panel')?.classList.contains('open');
  let active = 'hall';
  if (isArchiveRoute()) active = 'more';
  else if (sideOpen) active = activeTab === 'chat' ? 'chat' : activeTab === 'resolutions' ? 'resolutions' : 'more';
  else if (leftOpen) active = 'more';
  document.querySelectorAll('.mnav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mnav === active);
  });
}

/* ------------------------------------------------------------------ */
/* Быстрые действия и мобильное меню                                    */
/* ------------------------------------------------------------------ */

function renderQuickActions() {
  const host = $('#quick-actions');
  if (!host) return;
  const state = get();
  const actor = activeDiplomat(state);
  const voting = openVoting(state);
  const isChair = isChairman(actor);

  const seatLabel = !actor
    ? 'Сесть на место'
    : isChair
      ? (isSeatedChairman(actor) ? 'Пульт' : 'Занять кресло')
      : actor.seatId ? 'Покинуть место' : 'Сесть на место';
  const seatIcon = isChair ? 'i-gavel' : actor?.seatId ? 'i-x' : 'i-plus';
  const myVote = voting && actor ? voting.ballots?.[actor.country]?.vote : null;

  host.innerHTML = `
    <button type="button" class="quick-btn primary" data-qaction="seat">
      ${icon(seatIcon)}<span>${seatLabel}</span>
    </button>
    <button type="button" class="quick-btn" data-qaction="write">
      ${icon('i-send')}<span>Написать</span>
    </button>
    <button type="button" class="quick-btn" data-qaction="resolution">
      ${icon('i-file')}<span>Резолюция</span>
    </button>
    <button type="button" class="quick-btn ${voting && !myVote ? 'primary' : ''}" data-qaction="vote">
      ${icon('i-ballot')}<span>Голосовать</span>
      ${voting ? `<span class="q-note">${myVote ? 'голос отдан' : 'голосование идёт'}</span>` : '<span class="q-note">нет голосования</span>'}
    </button>`;

  host.querySelectorAll('[data-qaction]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.qaction;
      if (action === 'write') {
        openChatWithFocus();
      } else if (action === 'resolution') {
        activeTab = 'resolutions';
        renderSide();
        if (window.innerWidth <= 1140) openDrawer('right');
        else syncMobileNav();
      } else if (action === 'vote') {
        if (!openVoting(get())) {
          toast('Сейчас нет активного голосования. Оно открывается из президиума.', { kind: 'info' });
          return;
        }
        const band = $('#voting-band');
        band?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        band?.classList.add('flash');
        setTimeout(() => band?.classList.remove('flash'), 1200);
      } else {
        const act = activeDiplomat(get());
        if (!act) {
          openDiplomatForm({ first: !get().diplomats.length });
          return;
        }
        if (isChairman(act)) {
          if (isSeatedChairman(act)) document.getElementById('left-chair-panel')?.click();
          else document.getElementById('left-chair-seat')?.click();
        } else if (act.seatId) {
          document.getElementById('left-vacate')?.click();
        } else {
          document.getElementById('left-seat')?.click();
        }
      }
    });
  });
}

function openChatWithFocus() {
  activeTab = 'chat';
  renderSide();
  if (window.innerWidth <= 1140) openDrawer('right');
  setTimeout(() => {
    document.getElementById('chat-input')?.focus({ preventScroll: true });
    syncMobileNav();
  }, 260);
}

function openSpeechRequest() {
  const state = get();
  const actor = activeDiplomat(state);
  if (!actor) {
    toast('Сначала выберите дипломата.', { kind: 'warn' });
    return;
  }
  if (actor.role === 'observer') {
    toast('Наблюдатели не запрашивают слово.', { kind: 'warn' });
    return;
  }
  if (currentSpeaker(state)?.diplomatId === actor.id) {
    toast('Вы уже выступаете.', { kind: 'info' });
    return;
  }
  const mine = speechStatusFor(state, actor.id);
  if (mine?.status === 'waiting') {
    toast(`Вы уже в очереди №${speechQueue(state).findIndex((x) => x.id === mine.id) + 1}.`, { kind: 'info' });
    return;
  }

  const body = `
    <div class="field">
      <label class="label" for="speech-note">Тема выступления</label>
      <textarea class="input" id="speech-note" rows="3" maxlength="240"
        placeholder="Коротко: о чём хотите сказать"></textarea>
    </div>
    <div class="mini-note">Президиум увидит запрос в очереди и передаст вам слово.</div>`;
  const footer = document.createElement('div');
  footer.className = 'btn-row';
  footer.style.width = '100%';
  footer.innerHTML = `
    <span class="spacer" style="flex:1"></span>
    <button type="button" class="btn ghost" data-speech-cancel-request>Отмена</button>
    <button type="button" class="btn primary" data-speech-send>${icon('i-mic')} Запросить слово</button>`;
  const modal = openModal({ title: 'Запрос слова', body, footer, size: 'md' });
  modal.overlay.querySelector('[data-speech-cancel-request]').addEventListener('click', closeModal);
  modal.overlay.querySelector('[data-speech-send]').addEventListener('click', () => {
    const note = modal.overlay.querySelector('#speech-note').value.trim();
    const result = api.speeches.request(note);
    if (!result.ok) return toast(result.reason, { kind: 'warn' });
    closeModal();
    toast('Запрос отправлен президиуму. Позиция в очереди появится слева.', { kind: 'ok' });
  });
}

function openMobileMore() {
  const state = get();
  const actor = activeDiplomat(state);
  const voting = openVoting(state);
  const net = netInfo();
  const body = `
    <div class="mobile-more-grid">
      <button type="button" class="mmore-btn" data-mmore="people">${icon('i-users')}Делегации<small>список и президиум</small></button>
      <button type="button" class="mmore-btn" data-mmore="net">${icon('i-globe')}Общий зал<small>${net.room ? `код ${esc(net.room)}` : 'игра с друзьями'}</small></button>
      <button type="button" class="mmore-btn" data-mmore="journal">${icon('i-clock')}Журнал<small>события заседания</small></button>
      <button type="button" class="mmore-btn" data-mmore="archive">${icon('i-archive')}Архив<small>документы и протоколы</small></button>
      <button type="button" class="mmore-btn" data-mmore="summary">${icon('i-eye')}Сводка<small>состояние зала</small></button>
      <button type="button" class="mmore-btn" data-mmore="speech">${icon('i-mic')}Попросить слово<small>очередь у президиума</small></button>
      <button type="button" class="mmore-btn" data-mmore="profile">${icon('i-user')}${actor ? 'Личное дело' : 'Профиль'}<small>${actor ? esc(actor.fullName) : 'регистрация'}</small></button>
      <button type="button" class="mmore-btn" data-mmore="login">${icon('i-key')}Вход<small>логин и пароль</small></button>
      <button type="button" class="mmore-btn" data-mmore="settings">${icon('i-gear')}Настройки<small>заседание и регламент</small></button>
      <button type="button" class="mmore-btn" data-mmore="sound">${icon(state.settings.soundOn ? 'i-sound' : 'i-mute')}Звук<small>${state.settings.soundOn ? 'включён' : 'выключен'}</small></button>
    </div>
    ${voting ? '<div class="mini-note" style="margin-top:10px">Идёт голосование: кнопки «За / Против / Воздержаться» находятся в зале.</div>' : ''}`;
  const footer = document.createElement('div');
  footer.className = 'btn-row';
  footer.style.width = '100%';
  footer.innerHTML = '<span class="spacer" style="flex:1"></span><button type="button" class="btn ghost" data-mmore-close>Закрыть</button>';
  const modal = openModal({ title: 'Ещё', body, footer, size: 'md' });
  modal.overlay.querySelector('[data-mmore-close]').addEventListener('click', closeModal);
  modal.overlay.querySelectorAll('[data-mmore]').forEach((btn) => {
    btn.addEventListener('click', () => {
      closeModal();
      const action = btn.dataset.mmore;
      if (action === 'archive') { location.hash = '#/archive'; return; }
      if (action === 'net') { openNetworkModal(); return; }
      if (action === 'speech') { openSpeechRequest(); return; }
      if (action === 'summary') { openSessionSummary(); return; }
      if (action === 'profile') { document.getElementById('profile-btn')?.click(); return; }
      if (action === 'login') {
        if (!get().diplomats.some((d) => d.login)) {
          toast('Аккаунтов пока нет — зарегистрируйте дипломата с логином и паролем.', { kind: 'info' });
          openDiplomatForm({ first: true });
          return;
        }
        openLoginModal({ onSuccess: () => renderHeader() });
        return;
      }
      if (action === 'settings') { document.getElementById('settings-btn')?.click(); return; }
      if (action === 'sound') { document.getElementById('sound-btn')?.click(); return; }
      if (action === 'journal') {
        activeTab = 'journal';
        renderSide();
        openDrawer('right');
        return;
      }
      if (action === 'people') { openDrawer('left'); }
    });
  });
}


/* ------------------------------------------------------------------ */
/* Боковая панель                                                      */
/* ------------------------------------------------------------------ */

let activeTab = 'chat';

function renderTabs() {
  const host = $('#side-tabs');
  if (!host) return;
  const state = get();
  const voting = openVoting(state);
  const tabs = [
    { id: 'chat', label: 'Канал', icon: 'i-send', count: state.chat.length },
    { id: 'resolutions', label: 'Резолюции', icon: 'i-file', count: state.resolutions.length },
    { id: 'journal', label: 'Журнал', icon: 'i-clock', count: state.journal.length, dot: voting },
  ];
  host.innerHTML = tabs.map((t) => `
    <button type="button" class="side-tab ${activeTab === t.id ? 'active' : ''}" data-tab="${t.id}">
      ${icon(t.icon)}<span>${t.label}</span>
      ${t.dot ? '<span class="tab-dot" title="Идёт голосование"></span>' : `<span class="tab-count">${t.count}</span>`}
    </button>`).join('');
}

function renderSide() {
  if (isArchiveRoute()) return;
  renderTabs();
  if (activeTab === 'chat') renderChat();
  else if (activeTab === 'resolutions') renderResolutions();
  else renderJournal();
}

/* ------------------------------------------------------------------ */
/* Левая панель: заседание, президиум, делегации, очередь слова        */
/* ------------------------------------------------------------------ */

let leftSeq = 0;

function seatLabel(d) {
  if (!d?.seatId) return 'вне зала';
  if (String(d.seatId).startsWith('chair')) {
    return Number(d.chairSlot) === 2 ? 'кресло сопредседателя' : 'кресло председателя';
  }
  return `место №${Number(String(d.seatId).slice(1))}`;
}

function freeSeat(state) {
  const total = Number(state.settings?.seatCount) || 46;
  for (let i = 1; i <= total; i += 1) {
    const id = `s${String(i).padStart(2, '0')}`;
    if (!state.seating?.[id]) return id;
  }
  return null;
}

async function renderLeftPanel() {
  const host = $('#left-body');
  if (!host) return;
  const seq = (leftSeq += 1);
  const state = get();
  const actor = activeDiplomat(state);
  const chairs = [chairmanAt(state, 1), chairmanAt(state, 2)];
  const q = quorumInfo(state);
  const voting = openVoting(state);
  const queue = speechQueue(state);
  const speaker = currentSpeaker(state);
  const mySpeech = actor ? speechStatusFor(state, actor.id) : null;
  const myQueuePos = mySpeech?.status === 'waiting'
    ? queue.findIndex((item) => item.id === mySpeech.id) + 1
    : null;
  const seatedCount = state.diplomats.filter((d) => d.seatId && !String(d.seatId).startsWith('chair')).length;
  const seatTotal = Number(state.settings?.seatCount) || 46;

  const avatars = {};
  await Promise.all(state.diplomats.map(async (d) => {
    avatars[d.id] = await getImageUrl(d.avatarId);
  }));
  if (seq !== leftSeq || !host.isConnected) return;

  const fillPct = q.total ? Math.min(100, Math.round((q.present / q.total) * 100)) : 0;

  const chairPlate = (slot) => {
    const d = chairs[slot - 1];
    if (!d) {
      return `<button type="button" class="sc-chair vacant" data-chair-vacant="${slot}">
        <span class="ch-slot">${slot === 2 ? 'Сопредседатель' : 'Председатель'}</span>
        <span class="ch-name">не назначен</span>
        <span class="ch-country">нажмите, чтобы назначить</span>
      </button>`;
    }
    return `<button type="button" class="sc-chair" data-chair-id="${d.id}">
      <span class="ch-slot">${slot === 2 ? 'Сопредседатель' : 'Председатель'}</span>
      <span class="ch-name">${esc(d.fullName)}</span>
      <span class="ch-country">${esc(d.country)}</span>
    </button>`;
  };

  const voteMark = (d) => {
    if (!voting || !d.canVote) return '';
    const ballot = voting.ballots?.[d.country];
    if (!ballot) return '<span class="badge plain" title="Голос не отдан">—</span>';
    if (ballot.vote === 'for') return '<span class="badge ok">за</span>';
    if (ballot.vote === 'against') return '<span class="badge bad">против</span>';
    return '<span class="badge warn">возд.</span>';
  };

  const sorted = state.diplomats.slice().sort((a, b) => {
    const aChair = isChairman(a) ? 0 : 1;
    const bChair = isChairman(b) ? 0 : 1;
    if (aChair !== bChair) return aChair - bChair;
    if (a.id === actor?.id) return -1;
    if (b.id === actor?.id) return 1;
    return a.fullName.localeCompare(b.fullName, 'ru');
  });

  const delegationRows = sorted.map((d) => {
    const inQueue = speechQueue(state).find((x) => x.diplomatId === d.id);
    const speaking = speaker?.diplomatId === d.id;
    const isActive = d.id === actor?.id;
    return `
      <div class="deleg-row ${isActive ? 'active' : ''}" data-diplomat-row="${d.id}" title="Выбрать дипломата">
        ${avatarHtml(d.fullName, avatars[d.id], {
    cls: `${isChairman(d) ? (Number(d.chairSlot) === 2 ? 'role-vice' : 'role-chair') : ''} ${d.role === 'observer' ? 'observer' : ''}`,
    eye: d.role === 'observer',
    eyeTitle: 'Наблюдатель',
    chairSlot: isChairman(d) ? d.chairSlot : null,
  })}
        <div class="deleg-main">
          <div class="deleg-name">${esc(d.fullName)}</div>
          <div class="deleg-sub">
            <span class="seat-label">${esc(d.country)} · ${esc(seatLabel(d))}</span>
          </div>
        </div>
        <div class="deleg-side">
          ${speaking ? `<span class="mic" title="Выступает">${icon('i-mic')}</span>` : ''}
          ${!speaking && inQueue ? `<span class="badge warn" title="В очереди на слово">слово</span>` : ''}
          ${voteMark(d)}
          <button type="button" class="head-act" data-open-card="${d.id}" aria-label="Личное дело" title="Личное дело">${icon('i-user')}</button>
        </div>
      </div>`;
  }).join('');

  const status = spellStatus(state);
  const speechButton = status
    ? `<span class="badge ${status.kind}">${esc(status.label)}</span>`
    : `<button type="button" class="head-act" id="speech-request" title="Запросить слово">${icon('i-mic')}</button>`;

  const queueRows = [];
  if (speaker) {
    const isMine = speaker.diplomatId === actor?.id;
    const canManage = actor && (isMine || (isChairman(actor) && isSeatedChairman(actor)));
    queueRows.push(`<div class="speech-item now">
      <span class="sp-num">${icon('i-mic')}</span>
      <span class="sp-name">${esc(speaker.snapshot?.name || '—')} · ${esc(speaker.snapshot?.country || '')}</span>
      ${canManage ? `<button type="button" class="sp-act" data-speech-finish="${speaker.id}" title="Завершить">${icon('i-check')}</button>` : ''}
    </div>`);
  }
  for (const item of queue) {
    const isMine = item.diplomatId === actor?.id;
    const canCancel = actor && (isMine || (isChairman(actor) && isSeatedChairman(actor)));
    const canGrant = isChairman(actor) && isSeatedChairman(actor);
    queueRows.push(`<div class="speech-item${isMine ? ' mine' : ''}">
      <span class="sp-num">${queue.indexOf(item) + 1}.</span>
      <span class="sp-name">${esc(item.snapshot?.name || '—')} · ${esc(item.snapshot?.country || '')}</span>
      ${isMine ? '<span class="sp-you">вы</span>' : ''}
      ${canGrant ? `<button type="button" class="sp-act" data-speech-grant="${item.id}" title="Предоставить слово">${icon('i-gavel')}</button>` : ''}
      ${canCancel ? `<button type="button" class="sp-act" data-speech-cancel="${item.id}" title="Снять">${icon('i-x')}</button>` : ''}
    </div>`);
  }

  const speechMine = !mySpeech ? '' : `
    <div class="speech-mine">
      ${mySpeech.status === 'speaking'
    ? '<b>Вы выступаете.</b> Регламент идёт.'
    : `<b>Вы в очереди №${myQueuePos} из ${queue.length}.</b> Ждите, президиум передаст слово.`}
      ${mySpeech.note ? `<span class="sp-note">Тема: ${esc(mySpeech.note)}</span>` : ''}
    </div>`;

  const actionSeat = (() => {
    if (!actor) {
      return `<button type="button" class="btn small primary" id="left-seat">${icon('i-user')} Выбрать дипломата</button>`;
    }
    if (isChairman(actor)) {
      return isSeatedChairman(actor)
        ? `<button type="button" class="btn small brass" id="left-chair-panel">${icon('i-gavel')} Пульт президиума</button>`
        : `<button type="button" class="btn small brass" id="left-chair-seat">${icon('i-gavel')} Занять кресло</button>`;
    }
    if (actor.seatId) {
      return `<button type="button" class="btn small ghost" id="left-vacate">${icon('i-x')} Покинуть место</button>`;
    }
    return `<button type="button" class="btn small primary" id="left-seat">${icon('i-plus')} Занять место</button>`;
  })();

  host.innerHTML = `
    <article class="session-card">
      <div class="sc-top">
        <span class="sc-org">ОМБ · ${esc(dateLabel(state.settings.sessionDate))}</span>
        <span class="sc-secret">Секретно</span>
      </div>
      <h3 class="sc-name">${esc(state.settings.sessionName)}</h3>
      <div class="sc-date">Зал Ассамблеи · пленарное заседание</div>
      <div class="sc-clock-row">
        <span class="sc-clock" id="sess-clock">${fmtClock()}</span>
        <span class="sc-elapsed">заседание идёт<b id="sess-elapsed">${fmtElapsed(state.sessionStartedAt)}</b></span>
      </div>
      <div class="sc-quorum ${q.met ? '' : 'no'}">
        <div class="sq-row"><span>Кворум · в зале</span><b>${q.present} / ${q.total} · нужно ${q.required}</b></div>
        <div class="sq-bar"><div class="sq-fill" style="width:${fillPct}%"></div></div>
      </div>
      <div class="sc-chairs">${chairPlate(1)}${chairPlate(2)}</div>
      <div class="sc-actions">${actionSeat}
        <button type="button" class="btn small ghost" id="left-summary">${icon('i-eye')} Сводка</button>
      </div>
    </article>

    <div class="mini-stats">
      <div class="mini-stat"><b>${seatedCount}<span style="font-size:9px;color:#8a7c67">/${seatTotal}</span></b><span>в зале</span></div>
      <div class="mini-stat"><b>${state.resolutions.length}</b><span>резолюций</span></div>
      <div class="mini-stat"><b>${state.archive.length}</b><span>документов</span></div>
    </div>
    ${speechMine}

    <div class="left-sec-head">
      <span>Делегации · ${state.diplomats.length}</span>
      <span class="count">${q.present} с голосом</span>
      <button type="button" class="head-act" id="left-add" title="Новый дипломат">${icon('i-plus')}</button>
    </div>
    <div class="deleg-list">${delegationRows || `<div class="deleg-empty">Зал пуст.<br>Зарегистрируйте первого дипломата.</div>`}</div>

    <div class="left-sec-head">
      <span>Очередь слова</span>
      <span class="count">${queue.length + (speaker ? 1 : 0)}</span>
      ${speechButton}
    </div>
    <div class="speech-queue">
      ${queueRows.join('') || '<div class="deleg-empty" style="padding:8px 4px">Очередь пуста. Слово запрашивается кнопкой с микрофоном.</div>'}
    </div>

    <div class="left-foot">
      <button type="button" class="btn small ghost" id="left-journal">${icon('i-clock')} Журнал заседания</button>
    </div>`;

  const changeActive = (id) => {
    api.session.setActive(id);
  };

  host.querySelectorAll('[data-diplomat-row]').forEach((row) => {
    row.addEventListener('click', (event) => {
      if (event.target.closest('[data-open-card]')) return;
      const id = row.dataset.diplomatRow;
      if (get().activeDiplomatId === id) openDiplomatCard(id);
      else changeActive(id);
    });
  });
  host.querySelectorAll('[data-open-card]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      openDiplomatCard(btn.dataset.openCard);
    });
  });
  host.querySelectorAll('[data-chair-id]').forEach((btn) => {
    btn.addEventListener('click', () => openDiplomatCard(btn.dataset.chairId));
  });
  host.querySelectorAll('[data-chair-vacant]').forEach((btn) => {
    btn.addEventListener('click', () => openChairmanPicker(Number(btn.dataset.chairVacant)));
  });

  host.querySelector('#left-add')?.addEventListener('click', () => openDiplomatForm());
  host.querySelector('#left-summary')?.addEventListener('click', openSessionSummary);
  host.querySelector('#left-journal')?.addEventListener('click', () => {
    activeTab = 'journal';
    renderSide();
    if (window.innerWidth <= 1140) openDrawer('right');
  });

  host.querySelector('#left-seat')?.addEventListener('click', async () => {
    const s = get();
    const act = activeDiplomat(s);
    if (!act) {
      toast('Сначала зарегистрируйте или выберите дипломата.', { kind: 'warn' });
      openDiplomatForm({ first: !s.diplomats.length });
      return;
    }
    if (isChairman(act)) {
      toast('Председатель занимает кресло президиума автоматически.', { kind: 'info' });
      return;
    }
    if (act.seatId) {
      toast(`${act.fullName} уже занимает ${seatLabel(act)}.`, { kind: 'info' });
      return;
    }
    const seat = freeSeat(s);
    if (!seat) return toast('Свободных мест нет.', { kind: 'warn' });
    const num = Number(seat.slice(1));
    const yes = await confirmDialog(
      `Посадить <b>${esc(act.fullName)} (${esc(act.country)})</b> на место №${num}?`,
      { title: 'Занять место', confirmLabel: 'Занять', danger: false },
    );
    if (!yes) return;
    const result = api.seats.occupy(seat, act.id);
    if (!result.ok) return toast(result.reason, { kind: 'warn' });
    toast(`${act.fullName} занял(а) место №${num}.`, { kind: 'ok' });
  });

  host.querySelector('#left-vacate')?.addEventListener('click', async () => {
    const act = activeDiplomat(get());
    if (!act?.seatId) return;
    const yes = await confirmDialog(
      `${esc(act.fullName)} освобождает ${seatLabel(act)}?`,
      { title: 'Покинуть место', confirmLabel: 'Встать', danger: true },
    );
    if (!yes) return;
    const result = api.seats.vacate(act.seatId);
    if (!result.ok) return toast(result.reason, { kind: 'warn' });
  });

  host.querySelector('#left-chair-panel')?.addEventListener('click', async () => {
    const { openChairmanPanel } = await import('./ui/chairman.js');
    openChairmanPanel();
  });

  host.querySelector('#left-chair-seat')?.addEventListener('click', () => {
    const act = activeDiplomat(get());
    openChairmanPicker(Number(act?.chairSlot) || 1);
  });

  host.querySelector('#speech-request')?.addEventListener('click', openSpeechRequest);

  host.querySelectorAll('[data-speech-grant]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const result = api.speeches.grant(btn.dataset.speechGrant);
      if (!result.ok) return toast(result.reason, { kind: 'warn' });
      toast('Слово предоставлено.', { kind: 'ok' });
    });
  });
  host.querySelectorAll('[data-speech-finish]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const result = api.speeches.finish(btn.dataset.speechFinish);
      if (!result.ok) return toast(result.reason, { kind: 'warn' });
      toast('Выступление завершено.', { kind: 'info' });
    });
  });
  host.querySelectorAll('[data-speech-cancel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const result = api.speeches.cancel(btn.dataset.speechCancel);
      if (!result.ok) return toast(result.reason, { kind: 'warn' });
    });
  });

  host.querySelectorAll('.sc-chair').forEach((el) => {
    if (el.dataset.chairId) {
      el.addEventListener('dblclick', () => openDiplomatCard(el.dataset.chairId));
    }
  });
}

function spellStatus(state) {
  const actor = activeDiplomat(state);
  if (!actor) return null;
  if (actor.role === 'observer') return { kind: 'info', label: 'наблюдатель — без слова' };
  const speaking = currentSpeaker(state);
  if (speaking?.diplomatId === actor.id) return { kind: 'warn', label: 'вы выступаете' };
  const mine = speechStatusFor(state, actor.id);
  if (mine?.status === 'waiting') {
    const pos = speechQueue(state).findIndex((s) => s.id === mine.id) + 1;
    return { kind: 'warn', label: `в очереди №${pos}` };
  }
  if (!actor.seatId) return { kind: '', label: 'вне зала' };
  return null;
}

/* ------------------------------------------------------------------ */
/* Лента событий                                                       */
/* ------------------------------------------------------------------ */

const TICKER_TYPE = {
  voting: 'голосование',
  resolution: 'резолюция',
  amendment: 'правка',
  archive: 'архив',
  session: 'сессия',
  timer: 'регламент',
  seat: 'места',
  diplomat: 'дипломаты',
  chairman: 'президиум',
  speech: 'слово',
  system: 'канцелярия',
};

function renderTicker() {
  const host = $('#ticker');
  if (!host) return;
  const state = get();
  const events = (state.journal || []).slice(-18).reverse();

  let items;
  if (events.length) {
    items = events.map((e) => `<span class="ticker-item">
      <span class="t-time">${fmtTime(e.ts)}</span>
      <b>${esc(TICKER_TYPE[e.type] || e.type)}</b>
      ${esc(e.message)}
    </span>`).join('');
  } else {
    items = `
      <span class="ticker-item"><b>канцелярия</b>Заседание открыто. Зал ожидает дипломатов.</span>
      <span class="ticker-item"><b>президиум</b>Председатели назначаются паролем президиума в настройках заседания.</span>
      <span class="ticker-item"><b>регламент</b>Одна страна — один голос. Наблюдатели не голосуют.</span>`;
  }

  const half = items.repeat(events.length && events.length < 7 ? 2 : 1);
  host.innerHTML = `
    <span class="ticker-label">${icon('i-newspaper')}<span>Лента Асамблеи</span></span>
    <div class="ticker-viewport"><div class="ticker-track">
      <div class="ticker-group">${half}</div>
      <div class="ticker-group">${half}</div>
    </div></div>`;
}

/* ------------------------------------------------------------------ */
/* Статус-строка                                                       */
/* ------------------------------------------------------------------ */

function renderStatusbar() {
  const host = $('#statusbar');
  if (!host) return;
  const state = get();
  const chairs = chairmenOf(state);
  const actor = activeDiplomat(state);
  const seated = state.diplomats.filter((d) => d.seatId && !String(d.seatId).startsWith('chair')).length;
  const voting = openVoting(state);
  const q = quorumInfo(state);
  const net = netInfo();
  const netClass = net.status === 'online' ? 'ok' : net.status === 'idle' ? '' : 'warn';
  const netLabel = net.status === 'online'
    ? `Зал ${esc(net.room)} · ${net.online}`
    : net.status === 'connecting'
      ? 'Зал: подключение…'
      : net.status === 'offline' ? 'Зал: переподключение…' : 'Общий зал';

  host.innerHTML = `
    <span class="sb-live">Заседание идёт · <b id="status-elapsed">${fmtElapsed(state.sessionStartedAt)}</b></span>
    <span class="sb-hide-m">Президиум: <b>${chairs.length ? chairs.map((c) => esc(c.fullName)).join(' · ') : 'не назначен'}</b></span>
    <span class="sb-hide-m">Активный: <b>${actor ? esc(`${actor.fullName} (${actor.country})`) : 'не выбран'}</b></span>
    <span class="sb-right">
      <button type="button" class="sb-net ${netClass}" id="net-chip" title="Общий зал: заседание для друзей">
        ${icon('i-globe')} ${netLabel}
      </button>
      <span>${voting ? '<b style="color:#d8a79f">Идёт голосование</b>' : `Кворум ${q.met ? 'есть' : 'нет'}`}</span>
      <span>В зале <b>${seated}/${Number(state.settings?.seatCount) || 46}</b></span>
      <span>Резолюций <b>${state.resolutions.length}</b></span>
      <span>Документов <b>${state.archive.length}</b></span>
      <span>${state.settings.soundOn ? 'Звук: вкл' : 'Звук: выкл'}</span>
    </span>`;
}

/* ------------------------------------------------------------------ */
/* Живые часы                                                          */
/* ------------------------------------------------------------------ */

function updateClocks() {
  const now = new Date();
  const state = get();
  for (const id of ['sess-clock', 'header-clock']) {
    const el = document.getElementById(id);
    if (el) el.textContent = fmtClock(now);
  }
  const elapsed = document.getElementById('sess-elapsed');
  if (elapsed) elapsed.textContent = fmtElapsed(state.sessionStartedAt);
  const sbElapsed = document.getElementById('status-elapsed');
  if (sbElapsed) sbElapsed.textContent = fmtElapsed(state.sessionStartedAt);

  const h = now.getHours() % 12;
  const m = now.getMinutes();
  const s = now.getSeconds();
  const hourHand = document.getElementById('wall-hour');
  const minuteHand = document.getElementById('wall-minute');
  const secondHand = document.getElementById('wall-second');
  if (hourHand) hourHand.setAttribute('transform', `rotate(${(h + m / 60) * 30})`);
  if (minuteHand) minuteHand.setAttribute('transform', `rotate(${m * 6 + s * 0.1})`);
  if (secondHand) secondHand.setAttribute('transform', `rotate(${s * 6})`);
}

/* ------------------------------------------------------------------ */
/* Сводка зала и протокол                                              */
/* ------------------------------------------------------------------ */

function openSessionSummary() {
  const state = get();
  const q = quorumInfo(state);
  const chairs = chairmenOf(state);
  const speaker = currentSpeaker(state);
  const queue = speechQueue(state);
  const seated = state.diplomats.filter((d) => d.seatId && !String(d.seatId).startsWith('chair')).length;
  const observerCount = state.diplomats.filter((d) => d.role === 'observer').length;
  const adopted = state.resolutions.filter((r) => r.status === 'adopted').length;
  const rejected = state.resolutions.filter((r) => r.status === 'rejected').length;
  const recent = state.journal.filter((e) => e.sessionId === state.sessionId).slice(-10).reverse();
  const actor = activeDiplomat(state);
  const canProtocol = actor && isChairman(actor) && isSeatedChairman(actor);

  const body = `
    <div class="profile-stats">
      <div class="profile-stat"><b>${seated}<span style="font-size:9px;color:var(--text-dim)">/${Number(state.settings?.seatCount) || 46}</span></b><span>в зале</span></div>
      <div class="profile-stat"><b>${q.present}/${q.total}</b><span>кворум</span></div>
      <div class="profile-stat"><b>${fmtElapsed(state.sessionStartedAt)}</b><span>длится</span></div>
    </div>
    <div class="mini-stats" style="margin-bottom:12px">
      <div class="mini-stat"><b>${state.diplomats.length}</b><span>дипломатов</span></div>
      <div class="mini-stat"><b>${observerCount}</b><span>наблюдателей</span></div>
      <div class="mini-stat"><b>${state.chat.filter((m) => m.sessionId === state.sessionId).length}</b><span>сообщений</span></div>
      <div class="mini-stat"><b>${adopted}</b><span>принято</span></div>
      <div class="mini-stat"><b>${rejected}</b><span>отклонено</span></div>
      <div class="mini-stat"><b>${state.archive.length}</b><span>в архиве</span></div>
    </div>

    <div class="section-label">Президиум</div>
    <div class="paper-note" style="margin-bottom:10px">
      ${chairs.length
    ? chairs.map((c) => `<div>${Number(c.chairSlot) === 2 ? 'Сопредседатель' : 'Председатель'}: <b>${esc(c.fullName)}</b> (${esc(c.country)})${isSeatedChairman(c) ? '' : ' — вне кресла'}</div>`).join('')
    : 'Президиум не назначен.'}
    </div>

    <div class="section-label">Слово</div>
    <div class="mini-note" style="margin-bottom:10px">
      ${speaker ? `Выступает: <b>${esc(speaker.snapshot?.name || '')}</b> (${esc(speaker.snapshot?.country || '')}).` : 'Сейчас никто не выступает.'}
      ${queue.length ? `<br>В очереди: ${queue.map((s) => esc(s.snapshot?.name || '')).join(', ')}.` : ''}
    </div>

    <div class="section-label">Последние события</div>
    <div class="journal-list journal-log-paper">
      ${recent.map((e) => `<div class="journal-row">
        <span class="j-icon">${icon('i-clock')}</span>
        <div class="j-body"><div class="j-type">${esc(TICKER_TYPE[e.type] || e.type)}</div><div>${esc(e.message)}</div></div>
        <span class="j-time">${fmtTime(e.ts)}</span>
      </div>`).join('') || '<div class="mini-note" style="padding:8px">Событий пока нет.</div>'}
    </div>`;

  const footer = document.createElement('div');
  footer.className = 'btn-row';
  footer.style.width = '100%';
  footer.innerHTML = `
    <button type="button" class="btn ghost" id="sum-journal">Открыть журнал</button>
    <span class="spacer" style="flex:1"></span>
    ${canProtocol ? `<button type="button" class="btn primary" id="sum-protocol">${icon('i-archive')} Протокол заседания</button>` : ''}
    <button type="button" class="btn" data-close-summary>Закрыть</button>`;

  const modal = openModal({ title: 'Сводка зала', body, footer, size: 'lg' });
  modal.overlay.querySelector('[data-close-summary]').addEventListener('click', closeModal);
  modal.overlay.querySelector('#sum-journal').addEventListener('click', () => {
    closeModal();
    activeTab = 'journal';
    renderSide();
    if (window.innerWidth <= 1140) openDrawer('right');
  });
  modal.overlay.querySelector('#sum-protocol')?.addEventListener('click', () => {
    const result = api.archive.createProtocol();
    if (!result.ok) return toast(result.reason, { kind: 'bad' });
    closeModal();
    toast(`Протокол ${result.data.payload.docNo} сформирован и отправлен в архив.`, {
      kind: 'ok',
      timeout: 7000,
      actions: [{ label: 'Открыть', onClick: () => openProtoViewer(result.data.id) }],
    });
  });
}

/* ------------------------------------------------------------------ */
/* Приветствие первого запуска                                         */
/* ------------------------------------------------------------------ */

function maybeShowWelcome() {
  const state = get();
  if (state.diplomats.length) return;
  if (netInfo().room) return;
  try {
    if (sessionStorage.getItem('omb.welcomeSeen')) return;
    sessionStorage.setItem('omb.welcomeSeen', '1');
  } catch { /* приватный режим */ }

  const body = `
    <div style="display:flex;gap:14px;align-items:flex-start">
      <img src="assets/emblem.jpg" alt="Эмблема" style="width:64px;height:64px;object-fit:cover;border:1px solid var(--line)">
      <div style="font-size:12.5px;line-height:1.65">
        <b>Добро пожаловать в Асамблею Организации Мировой Безопасности.</b><br>
        Зал пуст. Зарегистрируйте делегации, посадите их за места — и откройте заседание.
      </div>
    </div>
    <div class="divider-line"></div>
    <ol style="margin:0;padding-left:18px;font-size:12px;line-height:1.75;color:var(--text)">
      <li><b>Дипломат</b> — регистрируется по логину и паролю, садится в зал, говорит, выдвигает резолюции и голосует от страны.</li>
      <li><b>Наблюдатель</b> — присутствует и говорит, но не голосует.</li>
      <li><b>Два председателя</b> — ведут регламент, открывают и закрывают голосования, модерируют чат и документы, отправляют документы в архив.</li>
    </ol>
    <div class="mini-note" style="margin-top:10px">
      Правило зала: одна страна — один голос. Данные хранятся в этом браузере; чтобы вести заседание
      вместе с друзьями, создайте «Общий зал» внизу экрана или в меню «Ещё».
    </div>`;

  const footer = document.createElement('div');
  footer.className = 'btn-row';
  footer.style.width = '100%';
  footer.innerHTML = `
    <button type="button" class="btn ghost" id="welcome-chairs">${icon('i-gavel')} Назначить президиум</button>
    <span style="flex:1"></span>
    <button type="button" class="btn ghost" id="welcome-skip">Осмотреть зал</button>
    <button type="button" class="btn primary" id="welcome-register">${icon('i-plus')} Регистрация</button>`;

  const modal = openModal({ title: 'Заседание открыто', body, footer, size: 'md' });
  modal.overlay.querySelector('#welcome-skip').addEventListener('click', closeModal);
  modal.overlay.querySelector('#welcome-register').addEventListener('click', () => {
    closeModal();
    openDiplomatForm({ first: true });
  });
  modal.overlay.querySelector('#welcome-chairs').addEventListener('click', () => {
    closeModal();
    openChairmanPicker(1);
  });
}

/* ------------------------------------------------------------------ */
/* Общий цикл обновления                                               */
/* ------------------------------------------------------------------ */

let busy = false;
let dirty = false;
let lastRoute = null;

async function refreshAll() {
  if (busy) { dirty = true; return; }
  busy = true;
  try {
    const route = location.hash || '#/hall';
    if (route !== lastRoute) {
      lastRoute = route;
      closeDrawers();
    }
    applyRoute();
    await renderHeader();
    renderQuickActions();
    if (!isArchiveRoute()) {
      renderHall();
      renderVotingBand();
      renderSide();
      await renderLeftPanel();
    } else {
      renderVotingBand();
    }
    renderTicker();
    renderStatusbar();
    updateClocks();
    syncMobileNav();
  } finally {
    busy = false;
    if (dirty) {
      dirty = false;
      refreshAll();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Запуск                                                              */
/* ------------------------------------------------------------------ */

function hideBootLoader() {
  const loader = document.getElementById('boot-loader');
  if (!loader) return;
  loader.classList.add('is-done');
  setTimeout(() => loader.remove(), 480);
}

function openSideTab(tab) {
  const apply = () => {
    activeTab = tab;
    renderSide();
    if (window.innerWidth <= 1140) openDrawer('right');
    syncMobileNav();
    if (tab === 'chat') {
      setTimeout(() => document.getElementById('chat-input')?.focus({ preventScroll: true }), 260);
    }
  };
  if (isArchiveRoute()) {
    location.hash = '#/hall';
    setTimeout(apply, 240);
  } else {
    apply();
  }
}

function boot() {
  if (!location.hash) {
    try { history.replaceState(null, '', '#/hall'); } catch { /* noop */ }
  }

  // Аккаунт с паролем не должен открываться сам после перезагрузки.
  try {
    const state = get();
    const active = state.diplomats.find((d) => d.id === state.activeDiplomatId);
    const verified = sessionStorage.getItem('omb.auth.user');
    if (state.activeDiplomatId && (!active || (active.login && verified !== active.id))) {
      api.session.setActive(null);
    }
  } catch { /* приватный режим */ }

  const bootStarted = Date.now();
  refreshAll().finally(() => {
    const wait = Math.max(0, 850 - (Date.now() - bootStarted));
    setTimeout(hideBootLoader, wait);
  });
  setTimeout(hideBootLoader, 8000);

  window.addEventListener('omb:open-tab', (event) => {
    openSideTab(event.detail || 'chat');
  });

  $('#side-tabs')?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-tab]');
    if (!btn) return;
    activeTab = btn.dataset.tab;
    renderTabs();
    renderSide();
    syncMobileNav();
  });

  $('#mobile-nav')?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-mnav]');
    if (!btn) return;
    const action = btn.dataset.mnav;
    if (action === 'hall') {
      closeDrawers();
      if (isArchiveRoute()) location.hash = '#/hall';
      else refreshAll();
      syncMobileNav();
    } else if (action === 'chat' || action === 'resolutions') {
      openSideTab(action);
    } else {
      openMobileMore();
    }
  });

  $('#left-toggle')?.addEventListener('click', () => openDrawer('left'));
  $('#right-toggle')?.addEventListener('click', () => openDrawer('right'));
  $('#left-close')?.addEventListener('click', closeDrawers);
  $('#right-close')?.addEventListener('click', closeDrawers);
  $('#drawer-scrim')?.addEventListener('click', closeDrawers);

  window.addEventListener('hashchange', () => refreshAll());
  subscribe(() => { refreshAll(); });

  window.addEventListener('omb:net', () => { refreshAll(); });

  $('#statusbar')?.addEventListener('click', (event) => {
    if (event.target.closest('#net-chip')) openNetworkModal();
  });

  window.addEventListener('omb:storage-error', () => {
    toast('Не удалось сохранить данные в браузере. Проверьте свободное место и приватный режим.', {
      kind: 'bad',
      timeout: 9000,
    });
  });

  window.addEventListener('storage', (event) => {
    if (netInfo().status === 'online') return;
    if (event.key === 'omb.state.v1' && event.newValue) {
      toast('Состояние заседания изменено в другой вкладке. Обновите страницу, чтобы синхронизироваться.', {
        kind: 'warn',
        timeout: 9000,
      });
    }
  });

  const unlock = () => {
    unlockAudio();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  setupHallTools();
  setInterval(updateClocks, 1000);
  initNet();
  setTimeout(maybeShowWelcome, 420);
}

boot();
