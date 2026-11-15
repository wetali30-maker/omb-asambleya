// Шапка: бренд, заседание, кворум, регламент, активный дипломат, президиум, настройки.

import { get } from '../store.js';
import { api } from '../api.js';
import { isAdminSession } from '../auth.js';
import {
  activeDiplomat, chairmenOf, quorumInfo, isChairman, isSeatedChairman,
} from '../rules.js';
import {
  esc, icon, avatarHtml, fmtDuration, dateLabel, MONTHS, roleLabel,
} from '../utils.js';
import { getImageUrl } from '../idb.js';
import { openModal, closeModal, toast, confirmDialog } from './modal.js';
import { openDiplomatForm, openDiplomatCard, openChairmanPicker } from './diplomats.js';
import { openChairmanPanel } from './chairman.js';
import { openAdminLogin } from './admin.js';
import { openLoginModal } from './login.js';
import { playGong, unlockAudio } from '../audio.js';

let renderSeq = 0;

export async function render() {
  const seq = ++renderSeq;
  const state = get();
  const active = activeDiplomat(state);
  const chairs = chairmenOf(state);
  const q = quorumInfo(state);
  const avatarUrl = active ? await getImageUrl(active.avatarId) : null;
  if (seq !== renderSeq) return;

  const header = document.getElementById('app-header');
  if (!header) return;

  const fillPct = q.total ? Math.round((q.present / q.total) * 100) : 0;
  const activeChair = isChairman(active);

  const options = state.diplomats
    .slice()
    .sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru'))
    .map((d) => `<option value="${d.id}" ${d.id === active?.id ? 'selected' : ''}>`
      + `${esc(d.fullName)} · ${esc(d.country)} · ${esc(roleLabel(d.role, d.canVote, d.chairSlot))}</option>`)
    .join('');

  const activeHtml = state.diplomats.length
    ? `<div class="who" title="Действия выполняются от имени выбранного дипломата">
        ${avatarHtml(active?.fullName || '—', avatarUrl, {
    cls: `${isChairman(active) ? (Number(active?.chairSlot) === 2 ? 'role-vice' : 'role-chair') : ''} ${active?.role === 'observer' ? 'observer' : ''}`,
    eye: active?.role === 'observer',
    chairSlot: active && isChairman(active) ? active.chairSlot : null,
  })}
        <select class="who-select" id="who-select" aria-label="Активный дипломат">
          ${active ? '' : '<option value="">— выберите дипломата —</option>'}
          ${options}
        </select>
      </div>`
    : '';

  const profileBtn = active
    ? `<button type="button" class="btn header-btn profile-btn" id="profile-btn" title="Личное дело">
         ${avatarHtml(active.fullName, avatarUrl, {
    cls: `sm ${isChairman(active) ? (Number(active.chairSlot) === 2 ? 'role-vice' : 'role-chair') : ''}`,
    eye: active.role === 'observer',
    chairSlot: isChairman(active) ? active.chairSlot : null,
  })}
         <span class="btn-label">${esc(active.country)}</span>
       </button>`
    : `<button type="button" class="btn header-btn" id="profile-btn" title="Профиль">${icon('i-user')}<span class="btn-label">Профиль</span></button>`;

  header.innerHTML = `
    <a class="brand" href="#/hall" title="Асамблея ОМБ">
      <img class="brand-emblem" src="assets/emblem.jpg" alt="Эмблема ОМБ">
      <div>
        <div class="brand-title">Асамблея ОМБ</div>
        <div class="brand-sub">Организация Мировой Безопасности · 1984</div>
      </div>
    </a>

    <div class="header-meeting">
      <div class="hm-kicker">Заседание · ${chairs.length}/2 в президиуме</div>
      <div class="hm-name">${esc(state.settings.sessionName)}</div>
      <div class="hm-meta">
        <span>${esc(dateLabel(state.settings.sessionDate))}</span>
        <span class="dot">·</span>
        <span id="header-clock">--:--</span>
        <span class="dot">·</span>
        <span>Кворум ${q.present}/${q.total}</span>
      </div>
    </div>

    <div class="header-right">
      <div class="quorum-chip ${q.met ? 'ok' : ''}"
           title="Кворум: присутствуют ${q.present} из ${q.total} стран с правом голоса; требуется ${q.required}">
        <div class="q-row"><span>Кворум</span><span class="q-val">${q.present}/${q.total}</span></div>
        <div class="q-bar"><div class="q-fill" style="width:${Math.min(100, fillPct)}%"></div></div>
      </div>

      <div class="timer-chip" id="timer-chip" title="Регламент выступления">
        ${icon('i-clock')}<span class="timer-text">00:00</span>
      </div>

      ${activeHtml}

      <div class="header-buttons">
        <button type="button" class="btn header-btn accent" id="resolution-btn" title="Новая резолюция">
          ${icon('i-file')}<span class="btn-label">Резолюция</span>
        </button>
        <a class="btn header-btn" href="#/archive" id="archive-btn" title="Архив документов">
          ${icon('i-archive')}<span class="btn-label">Архив</span>
        </a>
        ${profileBtn}
        ${activeChair
    ? `<button type="button" class="btn header-btn brass" id="chair-btn">${icon('i-gavel')}<span class="btn-label">Пульт</span></button>`
    : ''}
        <button type="button" class="icon-btn ${state.settings.soundOn ? 'on' : ''}" id="sound-btn"
                title="${state.settings.soundOn ? 'Звук включён' : 'Звук выключен'}">
          ${icon(state.settings.soundOn ? 'i-sound' : 'i-mute')}
        </button>
        <button type="button" class="icon-btn" id="settings-btn" title="Настройки заседания">${icon('i-gear')}</button>
        <button type="button" class="icon-btn" id="right-toggle" title="Чат и журнал">${icon('i-send')}</button>
        <button type="button" class="icon-btn" id="left-toggle" title="Делегации и президиум">${icon('i-users')}</button>
      </div>
    </div>`;

  header.querySelector('#who-select')?.addEventListener('change', (e) => {
    const id = e.target.value || null;
    if (!id) {
      api.session.setActive(null);
      return;
    }
    const target = state.diplomats.find((d) => d.id === id);
    if (target?.banned) {
      e.target.value = state.activeDiplomatId || '';
      toast('Аккаунт заблокирован председателем.', { kind: 'warn' });
      return;
    }
    if (target?.login) {
      e.target.value = state.activeDiplomatId || '';
      openLoginModal({
        diplomatId: id,
        onSuccess: () => render(),
      });
      return;
    }
    const result = api.session.setActive(id);
    if (!result.ok) toast(result.reason, { kind: 'warn' });
    render();
  });

  bindHiddenAdminEntrance(header);

  header.querySelector('#sound-btn')?.addEventListener('click', () => {
    const next = !get().settings.soundOn;
    api.settings.update({ soundOn: next });
    if (next) {
      unlockAudio();
      playGong('soft');
      toast('Звук включён.', { kind: 'info', timeout: 2200 });
    } else {
      toast('Звук выключен.', { kind: 'info', timeout: 2200 });
    }
  });

  header.querySelector('#resolution-btn')?.addEventListener('click', () => {
    if (!get().diplomats.length) {
      toast('Сначала зарегистрируйте дипломата.', { kind: 'warn' });
      return;
    }
    window.dispatchEvent(new CustomEvent('omb:open-tab', { detail: 'resolutions' }));
  });

  header.querySelector('#profile-btn')?.addEventListener('click', () => {
    const actor = activeDiplomat(get());
    if (!actor) {
      openDiplomatForm({ first: !get().diplomats.length });
      return;
    }
    openDiplomatCard(actor.id);
  });

  header.querySelector('#chair-btn')?.addEventListener('click', () => openChairmanPanel());

  const timerChip = header.querySelector('#timer-chip');
  timerChip?.addEventListener('click', () => {
    const actor = activeDiplomat(get());
    const canManage = actor && isChairman(actor) && isSeatedChairman(actor);
    if (canManage) openChairmanPanel();
    else toast('Таймером управляет президиум.', { kind: 'warn' });
  });

  header.querySelector('#settings-btn')?.addEventListener('click', openSettings);

  updateTimerChip();
}

// Скрытый вход: семь быстрых нажатий по названию или удержание 1,6 с.
let adminTapCount = 0;
let adminTapLast = 0;

function bindHiddenAdminEntrance(header) {
  const brand = header.querySelector('.brand');
  if (!brand) return;
  let holdTimer = null;
  let longPressFired = false;

  brand.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    longPressFired = false;
    holdTimer = setTimeout(() => {
      holdTimer = null;
      longPressFired = true;
      openAdminLogin();
    }, 1600);
  });
  const cancelHold = () => {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  };
  brand.addEventListener('pointerup', cancelHold);
  brand.addEventListener('pointerleave', cancelHold);
  brand.addEventListener('click', (event) => {
    if (longPressFired) {
      longPressFired = false;
      event.preventDefault();
      return;
    }
    const now = Date.now();
    if (now - adminTapLast > 2500) adminTapCount = 0;
    adminTapLast = now;
    adminTapCount += 1;
    if (adminTapCount >= 7) {
      adminTapCount = 0;
      event.preventDefault();
      openAdminLogin();
    }
  });
}

export function updateTimerChip() {
  const chip = document.getElementById('timer-chip');
  if (!chip) return;
  const { timer } = get();
  const remaining = timer.running ? Math.max(0, timer.endsAt - Date.now()) : timer.remainingMs;

  const active = timer.running || remaining > 0;
  chip.classList.toggle('visible', active);

  const text = chip.querySelector('.timer-text');
  if (text) text.textContent = fmtDuration(remaining);
  chip.classList.toggle('expired', timer.running && remaining <= 0);

  if (timer.running && remaining <= 0) {
    api.timer.complete();
    toast('Регламент выступления истёк.', { kind: 'warn' });
  }

  const big = document.getElementById('timer-big');
  if (big) big.textContent = fmtDuration(remaining);
  const bigState = document.getElementById('timer-state');
  if (bigState) {
    bigState.textContent = timer.running ? 'идёт отсчёт' : remaining > 0 ? 'пауза' : 'не запущен';
  }
}

/* ------------------------------------------------------------------ */
/* Настройки                                                           */
/* ------------------------------------------------------------------ */

function chairRow(slot, diplomat) {
  return `<div class="sc-chair ${diplomat ? '' : 'vacant'}" style="cursor:default">
    <span class="ch-slot">${slot === 2 ? 'Сопредседатель' : 'Председатель'}</span>
    <span class="ch-name">${diplomat ? esc(diplomat.fullName) : 'не назначен'}</span>
    <span class="ch-country">${diplomat ? esc(diplomat.country) : 'вакансия'}</span>
  </div>`;
}

function openSettings() {
  const state = get();
  const s = state.settings;
  const q = quorumInfo(state);
  const chairs = [chairmenOf(state).find((c) => Number(c.chairSlot) === 1), chairmenOf(state).find((c) => Number(c.chairSlot) === 2)];
  const actor = activeDiplomat(state);
  const canManage = isAdminSession()
    || Boolean(actor && isChairman(actor) && isSeatedChairman(actor));

  const body = `
    ${canManage ? '' : `<div class="form-note" style="margin-bottom:10px">
      <b>Параметры заседания</b> меняет председатель в кресле президиума. Вам доступен только звук.
    </div>`}
    <section class="section-label">Заседание</section>
    <div class="form-grid">
      <div class="field span2">
        <label class="label" for="set-name">Название</label>
        <input id="set-name" class="input" value="${esc(s.sessionName)}" maxlength="80" ${canManage ? '' : 'disabled'}>
      </div>
      <div class="field">
        <label class="label" for="set-month">Месяц на документах</label>
        <select id="set-month" class="select" ${canManage ? '' : 'disabled'}>
          ${MONTHS.map((m, i) => `<option value="${i}" ${i === s.sessionDate.month ? 'selected' : ''}>${m}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label class="label" for="set-year">Год</label>
        <input id="set-year" class="input" type="number" min="1900" max="2100" value="${s.sessionDate.year}" ${canManage ? '' : 'disabled'}>
      </div>
    </div>

    <section class="section-label">Президиум · ровно два председателя</section>
    <div class="sc-chairs" style="margin-bottom:8px">
      ${chairRow(1, chairs[0])}
      ${chairRow(2, chairs[1])}
    </div>
    ${canManage ? `<div class="btn-row" style="margin-bottom:8px">
      <button type="button" class="btn small paper" data-appoint-slot="1">${icon('i-gavel')} ${chairs[0] ? 'Сменить председателя' : 'Назначить председателя'}</button>
      <button type="button" class="btn small paper" data-appoint-slot="2">${icon('i-gavel')} ${chairs[1] ? 'Сменить сопредседателя' : 'Назначить сопредседателя'}</button>
    </div>` : ''}
    <div class="mini-note" style="margin-bottom:12px">
      В президиум назначается только глава страны с правом голоса. Для назначения нужен пароль президиума.
    </div>

    <section class="section-label">Кворум</section>
    <div class="form-grid">
      <div class="field">
        <label class="label" for="set-qmode">Правило</label>
        <select id="set-qmode" class="select" ${canManage ? '' : 'disabled'}>
          <option value="percent" ${s.quorumMode === 'percent' ? 'selected' : ''}>Процент стран (половина + 1)</option>
          <option value="fixed" ${s.quorumMode === 'fixed' ? 'selected' : ''}>Фиксированное число</option>
        </select>
      </div>
      <div class="field">
        <label class="label" for="set-qval">Значение</label>
        <input id="set-qval" class="input" type="number" min="1" max="100" value="${s.quorumValue}" ${canManage ? '' : 'disabled'}>
      </div>
    </div>
    <div class="mini-note" style="margin-bottom:12px">
      Сейчас: стран с правом голоса — ${q.total}, в зале — ${q.present}, требуется — ${q.required}.
    </div>

    <section class="section-label">Регламент и звук</section>
    <div class="form-grid">
      <div class="field">
        <label class="label" for="set-speech">Минуты выступления</label>
        <input id="set-speech" class="input" type="number" min="1" max="60" value="${s.speechMinutes}" ${canManage ? '' : 'disabled'}>
      </div>
      <label class="check" style="margin-bottom:0">
        <input type="checkbox" id="set-sound" ${s.soundOn ? 'checked' : ''}>
        <span class="check-text">Звук гонга
          <small>Открытие и закрытие голосования, конец регламента.</small></span>
      </label>
    </div>

    ${canManage ? `
    <section class="section-label">Данные заседания</section>
    <div class="btn-row">
      <button type="button" class="btn" id="backup-export">${icon('i-download')} Экспорт JSON</button>
      <button type="button" class="btn" id="backup-import">${icon('i-archive')} Импорт JSON</button>
      <input type="file" id="backup-file" accept="application/json,.json" hidden>
    </div>
    <div class="btn-row" style="margin-top:8px">
      <button type="button" class="btn" id="new-meeting">${icon('i-gavel')} Новое заседание</button>
    </div>
    <div class="mini-note" style="margin-top:8px">
      «Новое заседание» освобождает зал, сохраняя дипломатов и архив.
      Резервная копия содержит хэши паролей — не публикуйте файл.
    </div>` : ''}`;

  const footer = document.createElement('div');
  footer.className = 'btn-row';
  footer.style.width = '100%';
  footer.innerHTML = `
    <span class="spacer" style="flex:1"></span>
    <button type="button" class="btn ghost" id="settings-cancel">Отмена</button>
    <button type="button" class="btn primary" id="settings-save">Сохранить</button>`;

  const modal = openModal({ title: 'Настройки заседания', body, footer, size: 'lg' });
  const root = modal.overlay;

  root.querySelector('#settings-cancel').addEventListener('click', closeModal);

  root.querySelectorAll('[data-appoint-slot]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const slot = Number(btn.dataset.appointSlot);
      closeModal();
      openChairmanPicker(slot);
    });
  });

  root.querySelector('#settings-save').addEventListener('click', () => {
    const patch = { soundOn: root.querySelector('#set-sound').checked };
    if (canManage) {
      patch.sessionName = root.querySelector('#set-name').value;
      patch.sessionDate = {
        month: Number(root.querySelector('#set-month').value),
        year: Number(root.querySelector('#set-year').value),
      };
      patch.quorumMode = root.querySelector('#set-qmode').value;
      patch.quorumValue = Number(root.querySelector('#set-qval').value);
      patch.speechMinutes = Number(root.querySelector('#set-speech').value);
    }
    const result = api.settings.update(patch);
    if (!result.ok) return toast(result.reason, { kind: 'bad' });
    closeModal();
    toast('Настройки сохранены.', { kind: 'ok' });
  });

  root.querySelector('#backup-export')?.addEventListener('click', async () => {
    await api.backup.exportJson();
    toast('Резервная копия сохранена в загрузки.', { kind: 'ok' });
  });

  const fileInput = root.querySelector('#backup-file');
  root.querySelector('#backup-import')?.addEventListener('click', () => fileInput.click());
  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const text = await file.text();
    const result = await api.backup.importJson(text);
    if (!result.ok) {
      toast(result.reason, { kind: 'bad' });
      fileInput.value = '';
      return;
    }
    closeModal();
    toast('Архив восстановлен из резервной копии.', { kind: 'ok' });
  });

  root.querySelector('#new-meeting')?.addEventListener('click', async () => {
    const yes = await confirmDialog(
      'Открыть новое заседание? Зал будет освобождён, дипломаты и президиум сохранятся, архив останется.',
      { title: 'Новое заседание', confirmLabel: 'Открыть заседание', danger: false },
    );
    if (!yes) return;
    const result = api.session.newMeeting();
    if (!result.ok) return toast(result.reason, { kind: 'warn' });
    closeModal();
    toast('Открыто новое заседание. Зал свободен, президиум на местах.', { kind: 'ok' });
  });
}
