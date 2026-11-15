// Резолюции, правки и запуск голосований председателем.

import { get } from '../store.js';
import { api } from '../api.js';
import {
  activeDiplomat, chairmenOf, isChairman, isSeatedChairman, openVoting,
  chairmanCanOpenResolution, pendingAmendments, tallyFor,
} from '../rules.js';
import {
  $, esc, icon, fmtDateTime, pad2,
} from '../utils.js';
import { openModal, closeModal, confirmDialog, toast } from './modal.js';
import { openSheetViewer, openDocViewer, openLiveSheet } from './viewers.js';
import { isAdminSession } from '../auth.js';

const STATUS = {
  draft: { label: 'Черновик', cls: '' },
  voting: { label: 'Голосуется', cls: 'warn' },
  adopted: { label: 'Принята', cls: 'ok' },
  rejected: { label: 'Отклонена', cls: 'bad' },
};

const AMD_STATUS = {
  proposed: { label: 'Предложена', cls: '' },
  voting: { label: 'Голосуется', cls: 'warn' },
  adopted: { label: 'Принята', cls: 'ok' },
  rejected: { label: 'Отклонена', cls: 'bad' },
  withdrawn: { label: 'Отозвана', cls: '' },
};

let listFilter = 'all';

/* ------------------------------------------------------------------ */
/* Боковая панель                                                      */
/* ------------------------------------------------------------------ */

export function renderResolutions() {
  const host = $('#side-body');
  if (!host) return;

  const state = get();
  const actor = activeDiplomat(state);
  const voting = openVoting(state);
  const all = state.resolutions.slice().sort((a, b) => b.createdAt - a.createdAt);
  const list = all.filter((r) => listFilter === 'all' || r.status === listFilter);
  const checkCreate = !voting && Boolean(actor) && actor.role !== 'observer';

  const cards = list.map((res) => {
    const st = STATUS[res.status] || STATUS.draft;
    const adoptedAmd = res.amendments.filter((a) => a.status === 'adopted').length;
    const pending = pendingAmendments(res).length;
    const isVotingHere = voting && voting.resolutionId === res.id;
    return `
      <div class="card clickable" data-res-card="${res.id}" style="margin-bottom:8px">
        <div class="card-head">
          <div style="flex:1;min-width:0">
            <div class="card-title">№ ${esc(res.number)}${res.topic ? ` — ${esc(res.topic)}` : ''}</div>
            <div class="card-meta">
              <span>${esc(res.authorSnapshot?.name || '—')}</span>
              <span class="sep">·</span>
              <span>${esc(res.authorSnapshot?.country || '—')}</span>
              <span class="sep">·</span>
              <span>${fmtDateTime(res.createdAt)}</span>
            </div>
            <div class="card-meta" style="margin-top:4px">
              <span>Правок: ${res.amendments.length}</span>
              ${adoptedAmd ? `<span class="sep">·</span><span>принято: ${adoptedAmd}</span>` : ''}
              ${pending ? `<span class="sep">·</span><span>ожидают: ${pending}</span>` : ''}
              ${isVotingHere ? '<span class="sep">·</span><span>голосование идёт</span>' : ''}
            </div>
          </div>
          <span class="badge ${st.cls}">${st.label}</span>
        </div>
      </div>`;
  }).join('');

  const filterOptions = [
    ['all', 'Все'],
    ['draft', 'Черновики'],
    ['voting', 'Голосуются'],
    ['adopted', 'Принятые'],
    ['rejected', 'Отклонённые'],
  ];

  host.innerHTML = `
    <div class="panel-head">
      <span class="panel-title">Резолюции · ${all.length}</span>
      <span class="spacer"></span>
      <select class="select" id="res-filter" style="width:auto;font-size:10px;padding:4px 6px">
        ${filterOptions.map(([v, l]) => `<option value="${v}" ${listFilter === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <button type="button" class="btn small primary" id="res-new" ${checkCreate ? '' : 'disabled'}
        title="${voting ? 'Идёт голосование'
    : !actor ? 'Сначала выберите дипломата'
      : actor.role === 'observer' ? 'Наблюдатели не вносят резолюции'
        : 'Выдвинуть резолюцию'}">
        ${icon('i-plus')} Выдвинуть
      </button>
    </div>
    <div class="panel-scroll">
      ${cards || `<div class="empty">
        <span class="empty-icon">${icon('i-file')}</span>
        ${listFilter === 'all' ? 'Резолюций пока нет. Первый документ — за дипломатами.' : 'Нет резолюций в этом состоянии.'}
      </div>`}
    </div>`;

  host.querySelector('#res-filter')?.addEventListener('change', (event) => {
    listFilter = event.target.value;
    renderResolutions();
  });
  host.querySelector('#res-new')?.addEventListener('click', () => openResolutionForm());
  host.querySelectorAll('[data-res-card]').forEach((card) => {
    card.addEventListener('click', () => openResolutionModal(card.dataset.resCard));
  });
}

/* ------------------------------------------------------------------ */
/* Детальная карточка резолюции                                        */
/* ------------------------------------------------------------------ */

export function openResolutionModal(id) {
  const modal = openModal({
    title: 'Резолюция',
    body: '<div id="res-detail"></div>',
    size: 'xl',
    refresh: () => draw(),
  });
  const root = modal.overlay;
  const container = root.querySelector('#res-detail');
  const bodyEl = root.querySelector('.modal-body');

  function draw() {
    const state = get();
    const res = state.resolutions.find((r) => r.id === id);
    if (!res) { closeModal(); return; }

    const scrollTop = bodyEl.scrollTop;
    const actor = activeDiplomat(state);
    const chairs = chairmenOf(state);
    const voting = openVoting(state);
    const check = chairmanCanOpenResolution(state, res);
    const st = STATUS[res.status] || STATUS.draft;
    const adoptedAmd = res.amendments.filter((a) => a.status === 'adopted');
    const actorIsChair = isChairman(actor);
    const manage = actorIsChair && isSeatedChairman(actor);
    const canModerate = manage || isAdminSession();
    const canEdit = res.status === 'draft' && actor && (actor.id === res.authorId || actorIsChair);
    const canPropose = res.status === 'draft' && actor?.seatId && actor.role !== 'observer' && !voting;

    const votingForRes = res.status === 'voting'
      ? state.votings.find((v) => v.id === res.votingId) || voting
      : res.resultId ? state.votings.find((v) => v.id === res.resultId) : null;

    const sheetDoc = votingForRes
      ? state.archive.find((d) => d.kind === 'ballot-sheet' && d.payload.votingId === votingForRes.id)
      : null;
    const resDoc = votingForRes
      ? state.archive.find((d) => d.kind === 'resolution-doc' && d.payload.votingId === votingForRes.id)
      : null;

    const amendmentsHtml = res.amendments.length
      ? res.amendments.slice().sort((a, b) => a.order - b.order).map((a) => {
        const ast = AMD_STATUS[a.status] || AMD_STATUS.proposed;
        const v = a.votingId ? state.votings.find((x) => x.id === a.votingId) : null;
        const t = v ? (v.tally || tallyFor(v, state)) : null;
        const canWithdraw = a.status === 'proposed' && actor?.id === a.authorId;
        const canOpen = manage && a.status === 'proposed' && !voting && res.status === 'draft';
        const amdSheet = v
          ? state.archive.find((d) => d.kind === 'ballot-sheet' && d.payload.votingId === v.id)
          : null;
        return `
          <div class="card" style="margin-bottom:8px">
            <div class="card-head">
              <div style="flex:1;min-width:0">
                <div class="card-title">Правка № ${a.order} · <span class="badge ${ast.cls}">${ast.label}</span></div>
                <div class="card-meta">
                  <span>${esc(a.authorSnapshot?.name || '—')}</span>
                  <span class="sep">·</span>
                  <span>${esc(a.authorSnapshot?.country || '—')}</span>
                  <span class="sep">·</span>
                  <span>${fmtDateTime(a.createdAt)}</span>
                </div>
                <div class="card-body" style="white-space:pre-wrap">${esc(a.text)}</div>
                ${t ? `<div class="card-meta" style="margin-top:6px">
                  <span class="vchip for" style="padding:1px 6px">За <b>${t.for}</b></span>
                  <span class="vchip against" style="padding:1px 6px">Против <b>${t.against}</b></span>
                  <span class="vchip abstain" style="padding:1px 6px">Возд. <b>${t.abstain}</b></span>
                  ${t.quorumMet ? '' : '<span class="badge warn">кворум не соблюдён</span>'}
                </div>` : ''}
              </div>
              <div class="btn-row" style="flex-direction:column;align-items:stretch">
                ${canOpen ? `<button type="button" class="btn tiny-btn paper" data-act="open-amd" data-id="${a.id}" data-res="${res.id}">${icon('i-gavel')} Голосование</button>` : ''}
                ${a.status === 'voting' ? `<button type="button" class="btn tiny-btn" data-act="live-sheet" data-id="${v?.id || ''}">${icon('i-file')} Сводка</button>` : ''}
                ${a.status !== 'voting' && amdSheet ? `<button type="button" class="btn tiny-btn" data-act="sheet" data-id="${amdSheet.id}">${icon('i-download')} Лист</button>` : ''}
                ${canWithdraw ? `<button type="button" class="btn tiny-btn danger" data-act="withdraw" data-id="${a.id}" data-res="${res.id}">${icon('i-x')} Отозвать</button>` : ''}
              </div>
            </div>
          </div>`;
      }).join('')
      : '<div class="mini-note">Правки не предлагались.</div>';

    const liveHtml = voting && voting.resolutionId === res.id
      ? (() => {
        const t = tallyFor(voting, state);
        return `<div class="result-banner pending">
          <b>Идёт голосование по резолюции.</b>
          За ${t.for} · Против ${t.against} · Воздержались ${t.abstain} · Не голосовали ${t.notVoted}.
          <div class="btn-row" style="margin-top:8px">
            <button type="button" class="btn small" data-act="live-sheet" data-id="${voting.id}">${icon('i-file')} Текущая сводка</button>
          </div>
        </div>`;
      })()
      : '';

    const resultHtml = (() => {
      if (!votingForRes || votingForRes.status !== 'closed') return '';
      const t = votingForRes.tally || tallyFor(votingForRes, state);
      const adopted = res.status === 'adopted';
      return `
        <div class="section-label">Итоги голосования</div>
        <div class="result-banner ${adopted ? '' : 'rejected'}">
          <b>${adopted
    ? (adoptedAmd.length ? `Резолюция принята с правками (${adoptedAmd.length}).` : 'Резолюция принята.')
    : 'Резолюция отклонена.'}</b>
          Кворум ${t.quorumMet ? 'соблюдён' : 'не соблюдён'} (${t.present}/${t.required}).
          <div class="btn-row" style="margin-top:8px">
            ${sheetDoc ? `<button type="button" class="btn small" data-act="sheet" data-id="${sheetDoc.id}">${icon('i-file')} Лист итогов (PNG)</button>` : ''}
            ${resDoc ? `<button type="button" class="btn small" data-act="doc" data-id="${resDoc.id}">${icon('i-archive')} Документ (PNG/PDF)</button>` : ''}
          </div>
        </div>
        <table class="vote-table">
          <thead><tr><th>Категория</th><th>Голоса</th><th>Страны</th></tr></thead>
          <tbody>
            <tr><td class="v-for">Поддержали</td><td class="num">${t.for}</td>
              <td><div class="country-chips">${t.byVote.for.map((c) => `<span class="country-chip for">${esc(c)}</span>`).join('') || '—'}</div></td></tr>
            <tr><td class="v-against">Не поддержали</td><td class="num">${t.against}</td>
              <td><div class="country-chips">${t.byVote.against.map((c) => `<span class="country-chip against">${esc(c)}</span>`).join('') || '—'}</div></td></tr>
            <tr><td class="v-abstain">Воздержались</td><td class="num">${t.abstain}</td>
              <td><div class="country-chips">${t.byVote.abstain.map((c) => `<span class="country-chip abstain">${esc(c)}</span>`).join('') || '—'}</div></td></tr>
            <tr><td>Не голосовали</td><td class="num">${t.notVoted}</td>
              <td><div class="country-chips">${t.byVote.notVoted.map((c) => `<span class="country-chip none">${esc(c)}</span>`).join('') || '—'}</div></td></tr>
          </tbody>
        </table>`;
    })();

    container.innerHTML = `
      <div style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap">
        <div style="flex:1;min-width:240px">
          <div class="display" style="font-size:20px;color:var(--paper-light)">Резолюция № ${esc(res.number)}</div>
          ${res.topic ? `<div style="font-family:var(--font-doc);font-size:12px;color:var(--text-dim);letter-spacing:.04em;margin-top:4px">${esc(res.topic)}</div>` : ''}
          <div class="card-meta" style="margin-top:8px">
            <span>Выдвинул(а): ${esc(res.authorSnapshot?.name || '—')} (${esc(res.authorSnapshot?.country || '—')})</span>
            <span class="sep">·</span>
            <span>${fmtDateTime(res.createdAt)}</span>
            <span class="sep">·</span>
            <span>Правок: ${res.amendments.length}${adoptedAmd.length ? `, принято ${adoptedAmd.length}` : ''}</span>
          </div>
        </div>
        <span class="badge ${st.cls}" style="font-size:12px;padding:4px 10px">${st.label}</span>
      </div>

      <div class="btn-row" style="margin:12px 0">
        ${canEdit ? `<button type="button" class="btn small" data-act="edit">${icon('i-edit')} Редактировать</button>` : ''}
        ${canPropose ? `<button type="button" class="btn small paper" data-act="propose">${icon('i-plus')} Предложить правку</button>` : ''}
        ${canModerate ? `<button type="button" class="btn small danger" data-act="delete-res">${icon('i-x')} Удалить резолюцию</button>` : ''}
        ${actorIsChair && res.status === 'draft'
    ? `<button type="button" class="btn small primary" data-act="open-res"
              ${check.ok && manage ? '' : 'disabled'}
              title="${esc(!manage ? 'Открыть голосование может только председатель в кресле президиума.' : check.ok ? 'Открыть голосование по резолюции' : check.reason)}">
              ${icon('i-gavel')} Открыть голосование по резолюции</button>` : ''}
        ${res.status === 'draft' && actorIsChair && (!check.ok || !manage)
    ? `<span class="mini-note">${esc(!manage ? 'Председатель должен занимать кресло в президиуме.' : check.reason)}</span>` : ''}
      </div>

      ${liveHtml}

      <div class="section-label">Текст резолюции</div>
      <div style="background:#2b241e;border:1px solid var(--line);border-left:2px solid var(--line);
                  padding:12px 14px;font-family:var(--font-doc);font-size:12.5px;line-height:1.65;
                  white-space:pre-wrap;word-break:break-word">${esc(res.text)}</div>

      <div class="section-label">Правки к резолюции</div>
      ${amendmentsHtml}

      ${resultHtml}

      <div class="mini-note" style="margin-top:10px">
        Порядок: сначала голосуются правки, затем — резолюция целиком.
        Принятые правки включаются в итоговый документ.
      </div>`;

    bodyEl.scrollTop = scrollTop;
  }

  draw();

  root.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    const state = get();
    const res = state.resolutions.find((r) => r.id === id);
    if (!res) return;

    if (act === 'edit') {
      openResolutionForm({ editId: res.id, onSaved: () => openResolutionModal(res.id) });
    }

    if (act === 'propose') {
      openAmendmentForm(res.id, { onSaved: () => openResolutionModal(res.id) });
    }

    if (act === 'delete-res') {
      const yes = await confirmDialog(
        `Удалить резолюцию № <b>${esc(res.number)}</b>?<br><br>Правки и документы по ней останутся в архиве, но резолюция исчезнет из списка.`,
        { title: 'Удаление резолюции', confirmLabel: 'Удалить', danger: true },
      );
      if (!yes) return;
      const result = api.resolutions.remove(res.id);
      if (!result.ok) return toast(result.reason, { kind: 'bad' });
      closeModal();
      toast('Резолюция удалена.', { kind: 'warn' });
    }

    if (act === 'open-res') {
      const stateNow = get();
      const actorNow = activeDiplomat(stateNow);
      if (!isSeatedChairman(actorNow)) {
        return toast('Открыть голосование может только председатель в кресле президиума.', { kind: 'warn' });
      }
      const check = chairmanCanOpenResolution(stateNow, res);
      if (!check.ok) return toast(check.reason, { kind: 'warn' });
      const chairNames = chairmenOf(stateNow).map((c) => esc(c.fullName)).join(' и ') || '—';
      const yes = await confirmDialog(
        `Открыть голосование по резолюции № <b>${esc(res.number)}</b>?<br><br>`
        + `Президиум: ${chairNames}. Голосование закроется только по команде председателя.`,
        { title: 'Открытие голосования', confirmLabel: 'Открыть', danger: false },
      );
      if (!yes) return;
      const result = api.voting.open('resolution', res.id);
      if (!result.ok) return toast(result.reason, { kind: 'bad' });
      toast('Голосование по резолюции открыто. Дипломаты могут голосовать.', { kind: 'ok' });
    }

    if (act === 'open-amd') {
      if (!isSeatedChairman(activeDiplomat(get()))) {
        return toast('Открыть голосование может только председатель в кресле президиума.', { kind: 'warn' });
      }
      const amdId = btn.dataset.id;
      const amd = res.amendments.find((a) => a.id === amdId);
      const yes = await confirmDialog(
        `Открыть голосование по правке № <b>${amd?.order ?? '?'}</b>?<br><br>`
        + `Правка: ${esc(amd?.text || '')}<br><br>После завершения голосования по правке можно будет открыть следующую.`,
        { title: 'Голосование по правке', confirmLabel: 'Открыть', danger: false },
      );
      if (!yes) return;
      const result = api.voting.open('amendment', amdId);
      if (!result.ok) return toast(result.reason, { kind: 'bad' });
      toast('Голосование по правке открыто.', { kind: 'ok' });
    }

    if (act === 'withdraw') {
      const yes = await confirmDialog(
        'Отозвать эту правку? Она больше не будет вынесена на голосование.',
        { title: 'Отзыв правки', confirmLabel: 'Отозвать' },
      );
      if (!yes) return;
      const result = api.amendments.withdraw(res.id, btn.dataset.id);
      if (!result.ok) return toast(result.reason, { kind: 'bad' });
      toast('Правка отозвана.', { kind: 'warn' });
    }

    if (act === 'live-sheet' && btn.dataset.id) {
      openLiveSheet(btn.dataset.id);
    }

    if (act === 'sheet') {
      openSheetViewer(btn.dataset.id);
    }

    if (act === 'doc') {
      openDocViewer(btn.dataset.id);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Форма резолюции                                                     */
/* ------------------------------------------------------------------ */

export function openResolutionForm({ editId = null, onSaved = null } = {}) {
  const state = get();
  const edit = editId ? state.resolutions.find((r) => r.id === editId) : null;
  if (editId && !edit) return toast('Резолюция не найдена.', { kind: 'bad' });

  if (!edit) {
    if (openVoting(state)) return toast('Идёт голосование — выдвижение новых резолюций заблокировано.', { kind: 'warn' });
    if (!activeDiplomat(state)) return toast('Сначала выберите дипломата в шапке.', { kind: 'warn' });
  }

  const year = state.settings.sessionDate.year;
  const placeholder = `${year}/${pad2(state.resolutions.length + 1)}`;

  const body = `
    <div id="res-form-error"></div>
    <div class="form-grid">
      <div class="field">
        <label class="label">Номер резолюции</label>
        <input id="res-number" class="input" maxlength="24"
          value="${esc(edit?.number || '')}" placeholder="${esc(placeholder)}">
      </div>
      <div class="field">
        <label class="label">Тема</label>
        <input id="res-topic" class="input" maxlength="120"
          value="${esc(edit?.topic || '')}" placeholder="Краткая тема документа">
      </div>
    </div>
    <div class="field">
      <label class="label">Текст резолюции <b>*</b></label>
      <textarea id="res-text" class="textarea" rows="11"
        placeholder="Полный текст резолюции. Машинописный документ будет сформирован автоматически.">${esc(edit?.text || '')}</textarea>
    </div>
    <div class="mini-note">
      ${edit
    ? 'Редактировать черновик может автор или председатель.'
    : 'После выдвижения резолюция попадает в список. Правки принимаются до открытия голосования.'}
      Номер можно изменить вручную.
    </div>`;

  const footer = document.createElement('div');
  footer.className = 'btn-row';
  footer.style.width = '100%';
  footer.innerHTML = `
    <span style="flex:1"></span>
    <button type="button" class="btn ghost" id="res-cancel">Отмена</button>
    <button type="button" class="btn primary" id="res-save">${icon('i-check')} ${edit ? 'Сохранить' : 'Выдвинуть'}</button>`;

  const modal = openModal({
    title: edit ? `Редактирование резолюции № ${edit.number}` : 'Новая резолюция',
    body,
    footer,
    size: 'lg',
  });
  const root = modal.overlay;
  const errorBox = root.querySelector('#res-form-error');
  const showError = (text) => { errorBox.innerHTML = `<div class="form-note error">${esc(text)}</div>`; };

  root.querySelector('#res-cancel').addEventListener('click', closeModal);

  const save = () => {
    errorBox.innerHTML = '';
    const number = root.querySelector('#res-number').value.trim();
    const topic = root.querySelector('#res-topic').value.trim();
    const text = root.querySelector('#res-text').value.trim();
    if (!text) return showError('Введите текст резолюции.');

    if (edit) {
      const result = api.resolutions.update(edit.id, { number, topic, text });
      if (!result.ok) return showError(result.reason);
      closeModal();
      toast('Резолюция обновлена.', { kind: 'ok' });
      if (onSaved) onSaved();
      return;
    }

    const result = api.resolutions.create({ number, topic, text });
    if (!result.ok) return showError(result.reason);
    closeModal();
    toast(`Резолюция № ${result.data.number} выдвинута.`, { kind: 'ok' });
    if (onSaved) onSaved();
  };

  root.querySelector('#res-save').addEventListener('click', save);
  root.querySelector('#res-text').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      save();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Форма правки                                                        */
/* ------------------------------------------------------------------ */

export function openAmendmentForm(resolutionId, { onSaved = null } = {}) {
  const res = get().resolutions.find((r) => r.id === resolutionId);
  if (!res) return toast('Резолюция не найдена.', { kind: 'bad' });

  const body = `
    <div id="amd-form-error"></div>
    <div class="mini-note" style="margin-bottom:10px">
      Правка к резолюции № <b>${esc(res.number)}</b>${res.topic ? ` «${esc(res.topic)}»` : ''}.
      Каждая правка голосуется отдельно. Принятая правка включается в итоговый документ.
    </div>
    <div class="field">
      <label class="label">Текст правки <b>*</b></label>
      <textarea id="amd-text" class="textarea" rows="7"
        placeholder="Что именно изменить в тексте резолюции"></textarea>
    </div>`;

  const footer = document.createElement('div');
  footer.className = 'btn-row';
  footer.style.width = '100%';
  footer.innerHTML = `
    <span style="flex:1"></span>
    <button type="button" class="btn ghost" id="amd-cancel">Отмена</button>
    <button type="button" class="btn primary" id="amd-save">${icon('i-check')} Предложить</button>`;

  const modal = openModal({ title: 'Предложить правку', body, footer, size: 'md' });
  const root = modal.overlay;
  const errorBox = root.querySelector('#amd-form-error');
  const showError = (text) => { errorBox.innerHTML = `<div class="form-note error">${esc(text)}</div>`; };

  root.querySelector('#amd-cancel').addEventListener('click', closeModal);
  root.querySelector('#amd-save').addEventListener('click', () => {
    errorBox.innerHTML = '';
    const text = root.querySelector('#amd-text').value.trim();
    if (!text) return showError('Введите текст правки.');
    const result = api.amendments.propose(resolutionId, text);
    if (!result.ok) return showError(result.reason);
    closeModal();
    toast(`Правка № ${result.data.order} предложена.`, { kind: 'ok' });
    if (onSaved) onSaved();
  });
}
