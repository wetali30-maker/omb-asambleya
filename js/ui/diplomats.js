// Дипломаты: анкета, личное дело, посадка, назначение двух председателей по коду.

import { get } from '../store.js';
import { api } from '../api.js';
import {
  chairmanAt, chairmenOf, openVoting, activeDiplomat, isChairman, isSeatedChairman,
  speechStatusFor, currentSpeaker,
} from '../rules.js';
import {
  esc, icon, avatarHtml, roleLabel,
} from '../utils.js';
import { getImageUrl, prepareImage, putImage } from '../idb.js';
import {
  openModal, closeModal, toast, confirmDialog,
} from './modal.js';
import { openPasswordForm } from './login.js';
import { isAdminSession, loginProblem, passwordProblem } from '../auth.js';

/* ------------------------------------------------------------------ */
/* Анкета                                                              */
/* ------------------------------------------------------------------ */

export async function openDiplomatForm({ first = false, editId = null } = {}) {
  const state = get();
  const edit = editId ? state.diplomats.find((d) => d.id === editId) : null;
  if (editId && !edit) return toast('Дипломат не найден.', { kind: 'bad' });

  let flagId = edit?.flagId || null;
  let avatarId = edit?.avatarId || null;
  const previewUrls = {
    flag: await getImageUrl(flagId),
    avatar: await getImageUrl(avatarId),
  };

  const flagPreview = previewUrls.flag ? `<img src="${previewUrls.flag}" alt="">` : 'ФЛАГ';
  const avatarPreview = previewUrls.avatar ? `<img src="${previewUrls.avatar}" alt="">` : 'АВАТАР';

  const body = `
    <div id="dip-form-error"></div>

    <div class="form-grid">
      <div class="field">
        <label class="label" for="dip-name">ФИО <b>*</b></label>
        <input id="dip-name" class="input" maxlength="80" placeholder="Например: Аркадий Л. Ветров"
               value="${esc(edit?.fullName || '')}">
      </div>
      <div class="field">
        <label class="label" for="dip-country">Страна / организация <b>*</b></label>
        <input id="dip-country" class="input" maxlength="60" placeholder="Например: Борделиния"
               value="${esc(edit?.country || '')}" ${edit ? 'disabled' : ''}>
      </div>
      <div class="field span2">
        <label class="label" for="dip-type">Роль на заседании</label>
        <select id="dip-type" class="select" ${edit ? 'disabled' : ''}>
          <option value="country" ${edit?.type !== 'organization' ? 'selected' : ''}>
            Дипломат — глава страны, право голоса (1 страна = 1 голос)
          </option>
          <option value="organization" ${edit?.type === 'organization' ? 'selected' : ''}>
            Наблюдатель — организация или альянс, без права голоса
          </option>
        </select>
      </div>
    </div>

    <div class="img-upload">
      <div class="preview wide" id="flag-preview">${flagPreview}</div>
      <div class="u-body">
        <div class="u-title">Флаг</div>
        <div class="u-actions">
          <button type="button" class="btn small" data-upload="flag">Загрузить флаг</button>
          <span class="u-file" id="flag-file"></span>
          <input type="file" id="flag-input" accept="image/png,image/jpeg,image/webp">
        </div>
        <div class="mini-note">PNG, JPEG или WebP до 2 МБ. Превью появится сразу.</div>
      </div>
    </div>

    <div class="img-upload">
      <div class="preview" id="avatar-preview" style="border-radius:50%">${avatarPreview}</div>
      <div class="u-body">
        <div class="u-title">Аватар</div>
        <div class="u-actions">
          <button type="button" class="btn small" data-upload="avatar">Загрузить аватар</button>
          <span class="u-file" id="avatar-file"></span>
          <input type="file" id="avatar-input" accept="image/png,image/jpeg,image/webp">
        </div>
        <div class="mini-note">Круглый аватар виден на месте в зале, в чате и на документах.</div>
      </div>
    </div>

    <div class="field">
      <label class="label" for="dip-desc">Описание</label>
      <textarea id="dip-desc" class="textarea" rows="3"
        placeholder="Должность, характер, краткая биография дипломата">${esc(edit?.description || '')}</textarea>
    </div>

    <div class="field">
      <label class="label" for="dip-nick">Ник автора <b>*</b></label>
      <input id="dip-nick" class="input" maxlength="60" placeholder="Кто играет за этого дипломата"
             value="${esc(edit?.authorNick || '')}">
    </div>

    <div class="form-grid">
      <div class="field">
        <label class="label" for="dip-login">Логин для входа <b>*</b></label>
        <input id="dip-login" class="input" maxlength="24" autocomplete="username"
               placeholder="латиница и цифры" value="${esc(edit?.login || '')}" ${edit ? 'disabled' : ''}>
      </div>
      ${edit ? '' : `<div class="field">
        <label class="label" for="dip-pass">Пароль <b>*</b></label>
        <input id="dip-pass" class="input" type="password" autocomplete="new-password" maxlength="128"
               placeholder="не короче 6 символов">
      </div>`}
    </div>
    ${edit
    ? `<div class="mini-note">Пароль не отображается. Сменить его можно в личном деле.</div>`
    : `<div class="mini-note">Логин и пароль нужны для входа с телефона. На сервере хранится только хэш пароля.</div>`}

    <div class="form-note hidden" id="delegation-note">
      <b>Страна уже занята.</b> Второй голос от страны невозможен.
      <label class="check" style="margin:8px 0 0;border:none;background:none;padding:0">
        <input type="checkbox" id="dip-delegation">
        <span class="check-text">Создать как члена делегации без права голоса</span>
      </label>
    </div>

    <div class="form-note">
      <b>Президиум назначается отдельно.</b> Председатель и сопредседатель выбираются из глав стран
      по паролю президиума. Пароль известен только председателям и на сайте не отображается.
    </div>

    <div class="mini-note">
      Правило зала: 1 страна = 1 голос. Наблюдатели присутствуют и говорят, но не голосуют.
      ${edit ? 'Страна и тип после регистрации не изменяются.' : ''}
    </div>`;

  const footer = document.createElement('div');
  footer.className = 'btn-row';
  footer.style.width = '100%';
  footer.innerHTML = `
    ${edit ? `<button type="button" class="btn danger" id="dip-delete">${icon('i-trash')} Удалить</button>` : ''}
    <span style="flex:1"></span>
    <button type="button" class="btn ghost" id="dip-cancel">Отмена</button>
    <button type="button" class="btn primary" id="dip-save">${icon('i-check')} Сохранить</button>`;

  const modal = openModal({
    title: edit ? 'Анкета дипломата' : first ? 'Регистрация первого дипломата' : 'Новый дипломат',
    body,
    footer,
    size: 'lg',
  });
  const root = modal.overlay;

  const errorBox = root.querySelector('#dip-form-error');
  const showError = (text, kind = 'error') => {
    errorBox.innerHTML = `<div class="form-note ${kind}">${esc(text)}</div>`;
    errorBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const clearError = () => { errorBox.innerHTML = ''; };

  const pendingUploads = new Set();

  function handleFile(kind, file) {
    const task = (async () => {
      try {
        const blob = await prepareImage(file, kind === 'flag' ? 480 : 320, kind === 'flag' ? 300 : 320);
        const id = await putImage(blob);
        if (kind === 'flag') flagId = id; else avatarId = id;

        if (previewUrls[kind]?.startsWith('blob:')) URL.revokeObjectURL(previewUrls[kind]);
        previewUrls[kind] = URL.createObjectURL(blob);

        const preview = root.querySelector(`#${kind}-preview`);
        preview.innerHTML = `<img src="${previewUrls[kind]}" alt="">`;
        root.querySelector(`#${kind}-file`).textContent = file.name;
      } catch (err) {
        showError(err.message || 'Не удалось загрузить изображение.');
      }
    })();
    pendingUploads.add(task);
    task.finally(() => pendingUploads.delete(task));
  }

  for (const kind of ['flag', 'avatar']) {
    const input = root.querySelector(`#${kind}-input`);
    root.querySelector(`[data-upload="${kind}"]`).addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) handleFile(kind, file);
    });
  }

  root.querySelector('#dip-cancel').addEventListener('click', closeModal);

  root.querySelector('#dip-save').addEventListener('click', async () => {
    clearError();
    if (pendingUploads.size) await Promise.all([...pendingUploads]);
    const fullName = root.querySelector('#dip-name').value.trim();
    const country = root.querySelector('#dip-country').value.trim();
    const type = root.querySelector('#dip-type').value;
    const description = root.querySelector('#dip-desc').value.trim();
    const authorNick = root.querySelector('#dip-nick').value.trim();
    const login = root.querySelector('#dip-login').value.trim();
    const password = root.querySelector('#dip-pass')?.value || '';

    if (!fullName || !country || !authorNick) {
      showError('Заполните ФИО, страну и ник автора.');
      return;
    }

    if (!edit) {
      const loginErr = loginProblem(login);
      if (loginErr) return showError(loginErr);
      const passErr = passwordProblem(password);
      if (passErr) return showError(passErr);
    }

    if (edit) {
      const result = api.diplomats.update(edit.id, {
        fullName, description, authorNick, flagId, avatarId,
      });
      if (!result.ok) return showError(result.reason);
      closeModal();
      toast('Анкета дипломата обновлена.', { kind: 'ok' });
      return;
    }

    const delegation = root.querySelector('#dip-delegation')?.checked;
    const saveBtn = root.querySelector('#dip-save');
    saveBtn.disabled = true;
    const result = await api.diplomats.create({
      fullName, country, type, description, authorNick, flagId, avatarId, asDelegation: delegation,
      login, password,
    });
    saveBtn.disabled = false;

    if (!result.ok) {
      if (result.code === 'COUNTRY_TAKEN') {
        root.querySelector('#delegation-note').classList.remove('hidden');
      }
      if (result.code === 'LOGIN_TAKEN') showError('Этот логин уже занят. Выберите другой.');
      else showError(result.reason);
      return;
    }

    try { sessionStorage.setItem('omb.auth.user', result.data.id); } catch { /* noop */ }
    closeModal();
    const extra = result.data.role === 'observer'
      ? ' Наблюдатель без права голоса.'
      : result.data.isPrimary ? '' : ' Член делегации без права голоса.';
    const actions = chairmenOf(get()).length < 2
      ? [{ label: 'Назначить президиум', onClick: () => openChairmanPicker(1) }]
      : [];
    toast(
      `${result.data.fullName} (${result.data.country}) зарегистрирован(а).${extra} Выберите свободное место в зале.`,
      { kind: 'ok', timeout: 8500, actions },
    );
  });

  root.querySelector('#dip-delete')?.addEventListener('click', async () => {
    const yes = await confirmDialog(
      `Удалить дипломата <b>${esc(edit.fullName)} (${esc(edit.country)})</b>? `
      + 'История чата и архивные документы сохранятся.',
      { title: 'Удаление дипломата', confirmLabel: 'Удалить', danger: true },
    );
    if (!yes) return;
    const result = api.diplomats.remove(edit.id);
    if (!result.ok) return showError(result.reason);
    closeModal();
    toast('Дипломат удалён.', { kind: 'warn' });
  });
}

/* ------------------------------------------------------------------ */
/* Личное дело                                                         */
/* ------------------------------------------------------------------ */

function seatLabelOf(d) {
  if (!d?.seatId) return 'Вне зала';
  if (String(d.seatId).startsWith('chair')) {
    return Number(d.chairSlot) === 2 ? 'Кресло сопредседателя' : 'Кресло председателя';
  }
  return `Место №${Number(String(d.seatId).slice(1))}`;
}

export async function openDiplomatCard(id) {
  const state = get();
  const d = state.diplomats.find((x) => x.id === id);
  if (!d) return;

  const [avatarUrl, flagUrl] = await Promise.all([
    getImageUrl(d.avatarId),
    getImageUrl(d.flagId),
  ]);
  const voting = openVoting(state);
  const actor = activeDiplomat(state);
  const seatLabel = seatLabelOf(d);
  const membership = d.type === 'organization'
    ? 'Организация / альянс'
    : d.isPrimary ? 'Глава делегации страны' : 'Член делегации без права голоса';
  const speech = speechStatusFor(state, d.id);
  const speaking = currentSpeaker(state);
  const authored = state.resolutions.filter((r) => r.authorId === d.id).length;
  const speechCount = (state.speeches || []).filter((s) => s.diplomatId === d.id).length;
  const votesCast = state.votings.filter((v) => v.ballots?.[d.country]).length;

  const roleBadge = isChairman(d)
    ? `<span class="role-chip chair">${icon('i-gavel')} ${esc(roleLabel(d.role, d.canVote, d.chairSlot))}</span>`
    : d.role === 'observer'
      ? `<span class="role-chip obs">${icon('i-eye')} Наблюдатель</span>`
      : `<span class="role-chip dip">${icon('i-user')} ${esc(roleLabel(d.role, d.canVote, d.chairSlot))}</span>`;

  const body = `
    <div class="profile-head">
      ${avatarHtml(d.fullName, avatarUrl, {
    cls: `lg ${isChairman(d) ? (Number(d.chairSlot) === 2 ? 'role-vice' : 'role-chair') : ''} ${d.role === 'observer' ? 'observer' : ''}`,
    eye: d.role === 'observer',
    eyeTitle: 'Наблюдатель',
    chairSlot: isChairman(d) ? d.chairSlot : null,
  })}
      <div style="flex:1;min-width:0">
        <div class="profile-name">${esc(d.fullName)}</div>
        <div class="profile-country">
          ${flagUrl ? `<img src="${flagUrl}" alt="Флаг" style="width:24px;height:16px;object-fit:cover;border:1px solid var(--line);vertical-align:-3px;margin-right:6px">` : ''}
          ${esc(d.country)}
        </div>
        <div class="profile-role">${roleBadge}
          ${d.type === 'country' && !d.isPrimary ? '<span class="badge">без голоса</span>' : ''}
          ${d.banned ? '<span class="badge bad">заблокирован</span>' : ''}
          ${speaking?.diplomatId === d.id ? `<span class="badge warn">${icon('i-mic')} выступает</span>` : ''}
        </div>
      </div>
    </div>

    <div class="profile-stats">
      <div class="profile-stat"><b>${speechCount}</b><span>выступлений</span></div>
      <div class="profile-stat"><b>${authored}</b><span>резолюций</span></div>
      <div class="profile-stat"><b>${votesCast}</b><span>голосований</span></div>
    </div>

    ${d.description ? `<div style="font-size:12.5px;line-height:1.65;white-space:pre-wrap;margin-bottom:10px">${esc(d.description)}</div>` : ''}

    <dl class="kv">
      <dt>Роль</dt><dd>${esc(roleLabel(d.role, d.canVote, d.chairSlot))}</dd>
      <dt>Место</dt><dd>${esc(seatLabel)}</dd>
      <dt>Право голоса</dt><dd>${d.canVote ? 'да — один голос от страны' : 'нет'}</dd>
      <dt>Делегация</dt><dd>${esc(membership)}</dd>
      <dt>Ник автора</dt><dd>${esc(d.authorNick)}</dd>
      <dt>Логин</dt><dd>${d.login ? esc(d.login) : 'нет аккаунта'}</dd>
    </dl>

    ${voting ? '<div class="mini-note" style="margin-top:10px">Идёт голосование — пересадка, назначения и удаление заблокированы.</div>' : ''}`;

  const modal = openModal({ title: 'Личное дело дипломата', body, size: 'md' });
  const root = modal.overlay;
  const bodyEl = root.querySelector('.modal-body');

  const canSpeech = actor?.id === d.id && d.role !== 'observer' && d.seatId;
  const speechAction = (() => {
    if (!canSpeech) return '';
    if (speech?.status === 'speaking') {
      return `<button type="button" class="btn small" data-act="speech">${icon('i-check')} Завершить слово</button>`;
    }
    if (speech?.status === 'waiting') {
      return `<button type="button" class="btn small" data-act="speech-cancel">${icon('i-x')} Снять запрос</button>`;
    }
    return `<button type="button" class="btn small" data-act="speech-request">${icon('i-mic')} Запросить слово</button>`;
  })();

  const isSelf = actor?.id === d.id;
  const canModerate = isSelf
    || (actor && isChairman(actor) && isSeatedChairman(actor))
    || isAdminSession();

  const actions = document.createElement('div');
  actions.className = 'btn-row';
  actions.style.marginTop = '14px';
  actions.innerHTML = `
    ${isChairman(d)
    ? `<button type="button" class="btn brass" data-act="presidium">${icon('i-gavel')} Президиум</button>`
    : `<button type="button" class="btn" data-act="presidium" ${voting ? 'disabled' : ''}>${icon('i-gavel')} В президиум</button>`}
    ${speechAction}
    ${d.seatId && !isChairman(d) ? `<button type="button" class="btn" data-act="unseat" ${voting ? 'disabled' : ''}>${icon('i-x')} Покинуть место</button>` : ''}
    ${isSelf ? `<button type="button" class="btn" data-act="password">${icon('i-key')} Сменить пароль</button>` : ''}
    <button type="button" class="btn" data-act="edit">${icon('i-edit')} Анкета</button>
    ${canModerate && !isSelf ? `<button type="button" class="btn" data-act="ban">${icon('i-eye')} ${d.banned ? 'Разблокировать' : 'Забанить'}</button>` : ''}
    <button type="button" class="btn danger" data-act="delete" ${voting ? 'disabled' : ''}>${icon('i-trash')} Удалить</button>`;
  bodyEl.appendChild(actions);

  root.querySelector('[data-act="presidium"]')?.addEventListener('click', () => {
    closeModal();
    if (isChairman(d)) openChairmanPicker(Number(d.chairSlot) || 1);
    else openChairmanPicker(d.id);
  });

  root.querySelector('[data-act="unseat"]')?.addEventListener('click', () => {
    const result = api.seats.vacate(d.seatId);
    if (!result.ok) return toast(result.reason, { kind: 'warn' });
    closeModal();
    toast(`${d.fullName} покинул(а) место.`, { kind: 'info' });
  });

  root.querySelector('[data-act="speech-request"]')?.addEventListener('click', () => {
    const note = window.prompt('Тема выступления (необязательно):', '') ?? null;
    if (note === null) return;
    const result = api.speeches.request(note);
    if (!result.ok) return toast(result.reason, { kind: 'warn' });
    closeModal();
    toast('Запрос на слово отправлен.', { kind: 'ok' });
  });

  root.querySelector('[data-act="speech-cancel"]')?.addEventListener('click', () => {
    const result = api.speeches.cancel(speech.id);
    if (!result.ok) return toast(result.reason, { kind: 'warn' });
    closeModal();
  });

  root.querySelector('[data-act="speech"]')?.addEventListener('click', () => {
    const result = api.speeches.finish(speech.id);
    if (!result.ok) return toast(result.reason, { kind: 'warn' });
    closeModal();
    toast('Выступление завершено.', { kind: 'info' });
  });

  root.querySelector('[data-act="password"]')?.addEventListener('click', () => {
    closeModal();
    openPasswordForm(d.id);
  });

  root.querySelector('[data-act="ban"]')?.addEventListener('click', async () => {
    const next = !d.banned;
    const yes = await confirmDialog(
      next
        ? `Заблокировать <b>${esc(d.fullName)}</b>? Он(а) не сможет войти, писать и голосовать.`
        : `Разблокировать <b>${esc(d.fullName)}</b>?`,
      { title: next ? 'Блокировка' : 'Разблокировка', confirmLabel: next ? 'Забанить' : 'Разблокировать', danger: next },
    );
    if (!yes) return;
    const result = api.diplomats.ban(d.id, next);
    if (!result.ok) return toast(result.reason, { kind: 'warn' });
    closeModal();
    toast(next ? 'Пользователь заблокирован.' : 'Пользователь разблокирован.', { kind: next ? 'warn' : 'ok' });
  });

  root.querySelector('[data-act="edit"]').addEventListener('click', () => {
    closeModal();
    openDiplomatForm({ editId: d.id });
  });

  root.querySelector('[data-act="delete"]')?.addEventListener('click', async () => {
    const yes = await confirmDialog(
      `Удалить дипломата <b>${esc(d.fullName)}</b>? История чата и архив не пострадают.`,
      { title: 'Удаление дипломата', confirmLabel: 'Удалить', danger: true },
    );
    if (!yes) return;
    const result = api.diplomats.remove(d.id);
    if (!result.ok) return toast(result.reason, { kind: 'warn' });
    closeModal();
    toast('Дипломат удалён.', { kind: 'warn' });
  });
}

/* ------------------------------------------------------------------ */
/* Посадка в зал                                                       */
/* ------------------------------------------------------------------ */

export async function openSeatPicker(seatId) {
  const state = get();
  const seatNo = Number(String(seatId || '').slice(1));
  if (!seatNo) return;

  const candidates = state.diplomats
    .filter((d) => !isChairman(d))
    .sort((a, b) => {
      const act = state.activeDiplomatId;
      if (a.id === act) return -1;
      if (b.id === act) return 1;
      const seatedA = Boolean(a.seatId);
      const seatedB = Boolean(b.seatId);
      if (seatedA !== seatedB) return seatedA ? 1 : -1;
      return a.fullName.localeCompare(b.fullName, 'ru');
    });

  const avatarUrls = {};
  await Promise.all(candidates.map(async (d) => {
    avatarUrls[d.id] = await getImageUrl(d.avatarId);
  }));

  const rowsHtml = candidates.map((d) => {
    const current = d.seatId ? `сейчас: ${seatLabelOf(d).toLowerCase()}` : 'вне зала';
    return `
      <div class="card" style="margin-bottom:8px">
        <div class="card-head">
          ${avatarHtml(d.fullName, avatarUrls[d.id], {
    cls: d.role === 'observer' ? 'observer' : '',
    eye: d.role === 'observer',
    chairSlot: isChairman(d) ? d.chairSlot : null,
  })}
          <div style="flex:1;min-width:0">
            <div class="card-title">${esc(d.fullName)}</div>
            <div class="card-meta">
              <span>${esc(d.country)}</span><span class="sep">·</span>
              <span>${esc(roleLabel(d.role, d.canVote, d.chairSlot))}</span><span class="sep">·</span>
              <span>${current}</span>
            </div>
          </div>
          <button type="button" class="btn small paper" data-seat-diplomat="${d.id}">Посадить</button>
        </div>
      </div>`;
  }).join('');

  const body = `
    <div class="mini-note" style="margin-bottom:10px">
      Место №${seatNo}. Выберите дипломата — он займёт место. Если дипломат уже сидит,
      он будет перемещён. Наблюдатели тоже занимают места, но не голосуют.
    </div>
    <div class="field">
      <input class="input" id="seat-search" placeholder="Поиск по имени или стране">
    </div>
    <div id="seat-list">${rowsHtml || ''}</div>
    ${candidates.length ? '' : `
      <div class="empty">
        <span class="empty-icon">${icon('i-users')}</span>
        В зале пока нет дипломатов.<br>Зарегистрируйте первого.
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button type="button" class="btn primary" id="seat-new">${icon('i-plus')} Новый дипломат</button>
      </div>`}`;

  const modal = openModal({ title: `Посадить на место №${seatNo}`, body, size: 'md' });
  const root = modal.overlay;

  root.querySelectorAll('[data-seat-diplomat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const result = api.seats.occupy(seatId, btn.dataset.seatDiplomat);
      if (!result.ok) return toast(result.reason, { kind: 'warn' });
      const d = get().diplomats.find((x) => x.id === btn.dataset.seatDiplomat);
      closeModal();
      toast(`${d.fullName} (${d.country}) занял(а) место №${seatNo}.`, { kind: 'ok' });
    });
  });

  root.querySelector('#seat-new')?.addEventListener('click', () => {
    closeModal();
    openDiplomatForm();
  });

  const search = root.querySelector('#seat-search');
  search?.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    root.querySelectorAll('#seat-list .card').forEach((card) => {
      card.style.display = card.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
}

/* ------------------------------------------------------------------ */
/* Президиум: два председателя по коду администратора                  */
/* ------------------------------------------------------------------ */

export function openChairmanPicker(slotOrId = 1) {
  const state = get();
  const voting = openVoting(state);
  let slot = Number(slotOrId) === 2 ? 2 : 1;
  const preselectId = typeof slotOrId === 'string' ? slotOrId : null;

  const chairs = [chairmanAt(state, 1), chairmanAt(state, 2)];
  const candidates = state.diplomats
    .filter((d) => d.type === 'country' && d.isPrimary && d.role !== 'observer')
    .sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru'));

  const chairRows = chairs.map((c, index) => {
    const s = index + 1;
    if (!c) {
      return `<div class="card" style="margin-bottom:8px">
        <div class="card-head">
          <div style="flex:1;min-width:0">
            <div class="card-title">${s === 2 ? 'Сопредседатель' : 'Председатель'} — вакансия</div>
            <div class="card-meta"><span>кресло ${s} свободно</span></div>
          </div>
          <button type="button" class="btn small paper" data-slot="${s}">Заполнить</button>
        </div>
      </div>`;
    }
    return `<div class="card" style="margin-bottom:8px">
      <div class="card-head">
        <div style="flex:1;min-width:0">
          <div class="card-title">${s === 2 ? 'Сопредседатель' : 'Председатель'} · ${esc(c.fullName)}</div>
          <div class="card-meta">
            <span>${esc(c.country)}</span><span class="sep">·</span>
            <span>${isSeatedChairman(c) ? 'в кресле' : 'вне кресла'}</span>
          </div>
        </div>
        <button type="button" class="btn small danger" data-release="${c.id}" ${voting ? 'disabled' : ''}>Сложить полномочия</button>
      </div>
    </div>`;
  }).join('');

  const candidateRows = candidates.map((d) => {
    const already = isChairman(d) ? `сейчас: ${roleLabel(d.role, d.canVote, d.chairSlot).toLowerCase()}` : seatLabelOf(d).toLowerCase();
    const isPreselect = d.id === preselectId;
    return `
      <div class="card" style="margin-bottom:6px;${isPreselect ? 'border-color:var(--brass);box-shadow:0 0 0 1px rgba(178,150,95,.35)' : ''}">
        <div class="card-head">
          <div style="flex:1;min-width:0">
            <div class="card-title">${esc(d.fullName)} · ${esc(d.country)}</div>
            <div class="card-meta"><span>${esc(already)}</span>
              ${isChairman(d) ? '<span class="sep">·</span><span>в президиуме</span>' : ''}</div>
          </div>
          <button type="button" class="btn small paper" data-appoint="${d.id}" ${voting ? 'disabled' : ''}>Назначить</button>
        </div>
      </div>`;
  }).join('');

  const body = `
    <div id="chair-picker-error"></div>
    <div class="mini-note" style="margin-bottom:10px">
      В президиуме ровно два места: <b>председатель</b> и <b>сопредседатель</b>.
      Они ведут регламент, открывают и закрывают голосования и отправляют документы в архив.
      ${voting ? '<br><b style="color:#d8a79f">Идёт голосование — кадровые изменения заблокированы.</b>' : ''}
    </div>

    <div class="btn-row" style="margin-bottom:10px">
      <button type="button" class="btn small ${slot === 1 ? 'primary' : ''}" data-choose-slot="1">${icon('i-gavel')} Председатель</button>
      <button type="button" class="btn small ${slot === 2 ? 'primary' : ''}" data-choose-slot="2">${icon('i-gavel')} Сопредседатель</button>
      <span class="mini-note" id="chair-slot-note" style="align-self:center">Выбрано: ${slot === 2 ? 'сопредседатель' : 'председатель'}</span>
    </div>

    <div class="section-label" style="margin-top:4px">Сейчас в президиуме</div>
    ${chairRows}

    <div class="section-label">Назначить в кресло</div>
    <div class="field">
      <label class="label" for="chair-code">Пароль президиума <b>*</b></label>
      <input id="chair-code" class="input code-input" type="password" autocomplete="off" maxlength="128" placeholder="••••••">
      <span class="hint">Известен только председателям. На сайте не отображается и не подсказывается.</span>
    </div>
    ${candidateRows || '<div class="empty">Нет глав стран, доступных для назначения.</div>'}`;

  const footer = document.createElement('div');
  footer.className = 'btn-row';
  footer.style.width = '100%';
  footer.innerHTML = `
    <span class="mini-note" style="flex:1">Одна страна — один голос; председатель сохраняет голос своей страны.</span>
    <button type="button" class="btn ghost" data-close-picker>Закрыть</button>`;

  const modal = openModal({ title: 'Президиум Асамблеи', body, footer, size: 'lg' });
  const root = modal.overlay;
  const errorBox = root.querySelector('#chair-picker-error');
  const showError = (text) => {
    errorBox.innerHTML = `<div class="form-note error">${esc(text)}</div>`;
    errorBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  root.querySelector('[data-close-picker]').addEventListener('click', closeModal);

  root.querySelectorAll('[data-choose-slot]').forEach((btn) => {
    btn.addEventListener('click', () => {
      slot = Number(btn.dataset.chooseSlot) === 2 ? 2 : 1;
      root.querySelectorAll('[data-choose-slot]').forEach((b) => {
        b.classList.toggle('primary', Number(b.dataset.chooseSlot) === slot);
      });
      root.querySelector('#chair-slot-note').textContent = `Выбрано: ${slot === 2 ? 'сопредседатель' : 'председатель'}`;
    });
  });

  root.querySelectorAll('[data-slot]').forEach((btn) => {
    btn.addEventListener('click', () => {
      slot = Number(btn.dataset.slot) === 2 ? 2 : 1;
      root.querySelectorAll('[data-choose-slot]').forEach((b) => {
        b.classList.toggle('primary', Number(b.dataset.chooseSlot) === slot);
      });
      root.querySelector('#chair-slot-note').textContent = `Выбрано: ${slot === 2 ? 'сопредседатель' : 'председатель'}`;
      root.querySelector('#chair-code').focus();
    });
  });

  root.querySelectorAll('[data-appoint]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      errorBox.innerHTML = '';
      const code = root.querySelector('#chair-code').value;
      if (!code) {
        showError('Введите пароль президиума.');
        root.querySelector('#chair-code').focus();
        return;
      }
      const target = get().diplomats.find((d) => d.id === btn.dataset.appoint);
      btn.disabled = true;
      const result = await api.chairman.appoint(btn.dataset.appoint, code, slot);
      btn.disabled = false;
      if (!result.ok) return showError(result.reason);
      closeModal();
      toast(
        `${target.fullName} (${target.country}) назначен(а) ${slot === 2 ? 'сопредседателем' : 'председателем'} Асамблеи.`,
        { kind: 'ok' },
      );
    });
  });

  root.querySelectorAll('[data-release]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      errorBox.innerHTML = '';
      const code = root.querySelector('#chair-code').value;
      if (!code) {
        showError('Для отставки введите пароль президиума.');
        root.querySelector('#chair-code').focus();
        return;
      }
      const target = get().diplomats.find((d) => d.id === btn.dataset.release);
      const yes = await confirmDialog(
        `Освободить <b>${esc(target?.fullName || '')}</b> от должности в президиуме?`,
        { title: 'Отставка председателя', confirmLabel: 'Освободить', danger: true },
      );
      if (!yes) return;
      btn.disabled = true;
      const result = await api.chairman.release(btn.dataset.release, code);
      btn.disabled = false;
      if (!result.ok) return showError(result.reason);
      closeModal();
      toast('Полномочия сложены. Кресло свободно.', { kind: 'warn' });
    });
  });
}
