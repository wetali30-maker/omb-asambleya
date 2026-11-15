// Пульт председателя: регламент, слово, кворум, голосования и протокол.

import { get } from '../store.js';
import { api } from '../api.js';
import {
  activeDiplomat, chairmenOf, chairSlotLabel, openVoting, quorumInfo,
  chairmanCanOpenResolution, tallyFor, pendingAmendments, isChairman, isSeatedChairman,
  speechQueue, currentSpeaker,
} from '../rules.js';
import { esc, icon, fmtDuration, avatarHtml } from '../utils.js';
import { openModal, confirmDialog, toast } from './modal.js';
import { openSheetViewer, openDocViewer, openLiveSheet, openProtoViewer } from './viewers.js';

export function openChairmanPanel() {
  const actor = activeDiplomat(get());
  if (!isChairman(actor)) {
    return toast('Пульт доступен председателю. Назначьте президиум по коду администратора.', { kind: 'warn' });
  }

  const modal = openModal({
    title: 'Пульт председателя',
    body: '<div id="chair-panel"></div>',
    size: 'lg',
    refresh: () => draw(),
  });
  const root = modal.overlay;
  const container = root.querySelector('#chair-panel');
  const bodyEl = root.querySelector('.modal-body');

  function draw() {
    if (!container.isConnected) return;
    const state = get();
    const chairs = chairmenOf(state);
    const seated = chairs.filter(isSeatedChairman);
    const manage = isSeatedChairman(activeDiplomat(state));
    const q = quorumInfo(state);
    const voting = openVoting(state);
    const scrollTop = bodyEl.scrollTop;
    const timer = state.timer;
    const remaining = timer.running ? Math.max(0, timer.endsAt - Date.now()) : timer.remainingMs;

    const timerControls = timer.running
      ? `<button type="button" class="btn small" data-act="timer-pause">${icon('i-pause')} Пауза</button>
         <button type="button" class="btn small ghost" data-act="timer-reset">${icon('i-reset')} Сброс</button>`
      : remaining > 0
        ? `<button type="button" class="btn small primary" data-act="timer-resume">${icon('i-play')} Продолжить</button>
           <button type="button" class="btn small" data-act="timer-start">${icon('i-reset')} Заново</button>
           <button type="button" class="btn small ghost" data-act="timer-reset">${icon('i-x')} Сброс</button>`
        : `<button type="button" class="btn small primary" data-act="timer-start">${icon('i-play')} Запустить</button>
           <button type="button" class="btn small ghost" data-act="timer-reset">${icon('i-reset')} Сброс</button>`;

    let votingHtml = '';
    if (voting) {
      const t = tallyFor(voting, state);
      votingHtml = `
        <div class="result-banner pending">
          <div class="vb-kicker" style="color:#d8a79f">Идёт голосование · ${voting.targetType === 'amendment' ? 'правка' : 'резолюция'}</div>
          <b>${esc(voting.label)}</b><br>
          За ${t.for} · Против ${t.against} · Воздержались ${t.abstain} · Не голосовали ${t.notVoted}<br>
          Кворум: ${t.quorumMet ? 'соблюдён' : 'НЕ соблюдён'} (${t.present}/${t.required}).
          <div class="btn-row" style="margin-top:9px">
            <button type="button" class="btn small primary" data-act="close-vote" ${manage ? '' : 'disabled'}>
              ${icon('i-gavel')} Закрыть и подвести итог
            </button>
            <button type="button" class="btn small" data-act="live-sheet" data-id="${voting.id}">
              ${icon('i-file')} Текущая сводка
            </button>
          </div>
          ${manage ? '' : '<div class="mini-note" style="margin-top:6px">Закрыть голосование может только председатель, занимающий кресло в президиуме.</div>'}
        </div>`;
    } else if (!q.met) {
      votingHtml = `<div class="result-banner rejected" style="border-left-color:var(--warn)">
        Кворум не соблюдён: в зале ${q.present} из ${q.total} стран с правом голоса, требуется ${q.required}.
        Голосования открыть нельзя. Попросите дипломатов занять места.
      </div>`;
    } else {
      const drafts = state.resolutions
        .filter((r) => r.status === 'draft')
        .sort((a, b) => a.createdAt - b.createdAt);

      if (!drafts.length) {
        votingHtml = `<div class="mini-note">Нет резолюций в работе. Дипломаты могут выдвинуть резолюцию
          во вкладке «Резолюции».</div>`;
      } else {
        votingHtml = drafts.map((res) => {
          const pending = pendingAmendments(res);
          const check = chairmanCanOpenResolution(state, res);
          const blocked = !check.ok || !manage;
          const amdHtml = res.amendments
            .filter((a) => a.status === 'proposed')
            .map((a) => `
              <div style="display:flex;gap:8px;align-items:flex-start;margin-top:7px">
                <div style="flex:1;min-width:0;font-size:12px;line-height:1.5">
                  <span class="badge plain">Правка № ${a.order}</span>
                  ${esc(a.text.length > 160 ? `${a.text.slice(0, 160)}…` : a.text)}
                  <span class="mini-note"> — ${esc(a.authorSnapshot?.name || '')} (${esc(a.authorSnapshot?.country || '')})</span>
                </div>
                <button type="button" class="btn tiny-btn paper" data-act="open-amd" data-id="${a.id}" data-res="${res.id}"
                  ${!manage ? 'disabled' : ''}>
                  ${icon('i-gavel')} Голосовать
                </button>
              </div>`).join('');

          return `
            <div class="card" style="margin-bottom:8px">
              <div class="card-head">
                <div style="flex:1;min-width:0">
                  <div class="card-title">Резолюция № ${esc(res.number)}${res.topic ? ` — ${esc(res.topic)}` : ''}</div>
                  <div class="card-meta">
                    <span>${esc(res.authorSnapshot?.name || '—')} (${esc(res.authorSnapshot?.country || '—')})</span>
                    <span class="sep">·</span>
                    <span>правок: ${res.amendments.length}</span>
                  </div>
                </div>
              </div>
              ${pending.length
    ? `${amdHtml}<div class="mini-note" style="margin-top:6px">Сначала завершите голосование по правкам (${pending.length}).</div>`
    : amdHtml}
              <div class="btn-row" style="margin-top:9px">
                <button type="button" class="btn small primary" data-act="open-res" data-id="${res.id}"
                  ${blocked ? 'disabled' : ''} title="${esc(check.ok ? 'Открыть голосование по резолюции' : check.reason)}">
                  ${icon('i-gavel')} Голосовать резолюцию
                </button>
                ${check.ok ? '' : `<span class="mini-note">${esc(check.reason)}</span>`}
              </div>
            </div>`;
        }).join('');
      }
    }

    const speaker = currentSpeaker(state);
    const queue = speechQueue(state);
    const speechHtml = `
      ${speaker ? `
        <div class="card" style="margin-bottom:8px;border-color:rgba(178,150,95,.4)">
          <div class="card-head">
            <div style="flex:1;min-width:0">
              <div class="card-title">${icon('i-mic')} Слово: ${esc(speaker.snapshot?.name || '')}
                · ${esc(speaker.snapshot?.country || '')}</div>
              <div class="card-meta"><span>${esc(speaker.note || 'выступление')}</span></div>
            </div>
            <button type="button" class="btn small" data-act="speech-finish" data-id="${speaker.id}" ${manage ? '' : 'disabled'}>
              ${icon('i-check')} Завершить
            </button>
          </div>
        </div>` : ''}
      ${queue.length ? queue.map((s, i) => `
        <div class="card" style="margin-bottom:6px">
          <div class="card-head">
            <span class="sp-num" style="width:22px;text-align:center;font-family:var(--font-doc);font-size:11px;color:var(--brass-light)">${i + 1}</span>
            <div style="flex:1;min-width:0">
              <div class="card-title">${esc(s.snapshot?.name || '')} · ${esc(s.snapshot?.country || '')}</div>
              <div class="card-meta"><span>${esc(s.note || 'без темы')}</span></div>
            </div>
            <button type="button" class="btn small paper" data-act="speech-grant" data-id="${s.id}" ${manage ? '' : 'disabled'}>
              ${icon('i-mic')} Слово
            </button>
            <button type="button" class="btn small ghost" data-act="speech-cancel" data-id="${s.id}" title="Снять запрос">
              ${icon('i-x')}
            </button>
          </div>
        </div>`).join('') : ''}
      ${!speaker && !queue.length ? '<div class="mini-note">Очередь выступлений пуста. Дипломаты запрашивают слово из личного дела.</div>' : ''}`;

    container.innerHTML = `
      <div style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap">
        <div style="flex:1;min-width:220px">
          <div class="display" style="font-size:17px;color:var(--paper-light)">${esc(state.settings.sessionName)}</div>
          <div class="mini-note" style="margin-top:4px">
            ${chairs.length
    ? chairs.map((c) => `${esc(chairSlotLabel(c.chairSlot))}: ${esc(c.fullName)} (${esc(c.country)})${isSeatedChairman(c) ? '' : ' · вне кресла'}`).join('<br>')
    : 'Президиум не назначен.'}
          </div>
        </div>
        <div class="badge ${q.met ? 'ok' : 'warn'}">
          Кворум ${q.present}/${q.total} · нужно ${q.required}
        </div>
      </div>

      ${manage ? '' : `<div class="form-note" style="margin-top:10px">
        <b>Вы не в кресле президиума.</b> Управление открыто только председателю, который занимает место за столом.
        ${seated.length ? `Сейчас ведёт: ${esc(seated[0].fullName)}.` : 'Кресла президиума свободны.'}
      </div>`}

      <div class="section-label">Регламент выступления</div>
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
        <div style="text-align:center;min-width:130px">
          <div class="display" id="timer-big" style="font-size:34px;color:${remaining <= 0 ? 'var(--text-dim)' : 'var(--paper-light)'};letter-spacing:.08em">
            ${fmtDuration(remaining)}
          </div>
          <div class="mini-note" id="timer-state">${timer.running ? 'идёт отсчёт' : remaining > 0 ? 'пауза' : 'не запущен'}</div>
        </div>
        <div class="field" style="width:110px;margin:0">
          <label class="label">Минут</label>
          <input id="chair-minutes" class="input" type="number" min="1" max="60" value="${state.settings.speechMinutes}">
        </div>
        <div class="btn-row">${timerControls}</div>
      </div>

      <div class="section-label">Слово</div>
      ${speechHtml}

      <div class="section-label">Голосования</div>
      ${votingHtml}

      <div class="section-label">Документы заседания</div>
      <div class="btn-row">
        <button type="button" class="btn small paper" data-act="protocol" ${voting || !manage ? 'disabled' : ''}>
          ${icon('i-file')} Сформировать протокол
        </button>
        <span class="mini-note" style="align-self:center">
          ${voting ? 'Сначала закройте голосование.' : 'Хроника заседания уйдёт в архив с номером ПРТ.'}
        </span>
      </div>

      <div class="section-label">Порядок ведения</div>
      <ol style="margin:0;padding-left:18px;font-size:11.5px;line-height:1.7;color:var(--text-dim)">
        <li>Проверьте кворум: страны с правом голоса должны занимать места в зале.</li>
        <li>Слово предоставляет председатель из очереди запросов.</li>
        <li>Правки голосуются по одной, до общей резолюции.</li>
        <li>После закрытия голосования документ автоматически уходит в архив.</li>
      </ol>`;

    bodyEl.scrollTop = scrollTop;
  }

  draw();

  root.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    const state = get();

    if (act === 'timer-start') {
      const minutes = Number(root.querySelector('#chair-minutes')?.value || state.settings.speechMinutes);
      const result = api.timer.start(minutes);
      if (!result.ok) toast(result.reason, { kind: 'warn' });
      return;
    }
    if (act === 'timer-pause') { api.timer.pause(); return; }
    if (act === 'timer-resume') { api.timer.resume(); return; }
    if (act === 'timer-reset') { api.timer.reset(); return; }

    if (act === 'live-sheet') {
      openLiveSheet(btn.dataset.id);
      return;
    }

    if (act === 'speech-grant') {
      const result = api.speeches.grant(btn.dataset.id);
      if (!result.ok) return toast(result.reason, { kind: 'warn' });
      toast('Слово предоставлено. Регламент пошёл.', { kind: 'ok' });
      return;
    }

    if (act === 'speech-finish') {
      const result = api.speeches.finish(btn.dataset.id);
      if (!result.ok) return toast(result.reason, { kind: 'warn' });
      toast('Выступление завершено.', { kind: 'info' });
      return;
    }

    if (act === 'speech-cancel') {
      const result = api.speeches.cancel(btn.dataset.id);
      if (!result.ok) return toast(result.reason, { kind: 'warn' });
      return;
    }

    if (act === 'protocol') {
      const result = api.archive.createProtocol();
      if (!result.ok) return toast(result.reason, { kind: 'bad' });
      const doc = result.data;
      toast(`Протокол ${doc.payload.docNo} сформирован и отправлен в архив.`, {
        kind: 'ok',
        timeout: 9000,
        actions: [{ label: 'Открыть протокол', onClick: () => openProtoViewer(doc.id) }],
      });
      return;
    }

    if (act === 'open-res') {
      const res = state.resolutions.find((r) => r.id === btn.dataset.id);
      if (!res) return;
      const check = chairmanCanOpenResolution(state, res);
      if (!check.ok) return toast(check.reason, { kind: 'warn' });
      const yes = await confirmDialog(
        `Открыть голосование по резолюции № <b>${esc(res.number)}</b>?`,
        { title: 'Открытие голосования', confirmLabel: 'Открыть', danger: false },
      );
      if (!yes) return;
      const result = api.voting.open('resolution', res.id);
      if (!result.ok) return toast(result.reason, { kind: 'bad' });
      toast('Голосование по резолюции открыто.', { kind: 'ok' });
      return;
    }

    if (act === 'open-amd') {
      const res = state.resolutions.find((r) => r.id === btn.dataset.res);
      const amd = res?.amendments.find((a) => a.id === btn.dataset.id);
      const yes = await confirmDialog(
        `Открыть голосование по правке № <b>${amd?.order ?? '?'}</b>?<br><br>${esc(amd?.text || '')}`,
        { title: 'Голосование по правке', confirmLabel: 'Открыть', danger: false },
      );
      if (!yes) return;
      const result = api.voting.open('amendment', btn.dataset.id);
      if (!result.ok) return toast(result.reason, { kind: 'bad' });
      toast('Голосование по правке открыто.', { kind: 'ok' });
      return;
    }

    if (act === 'close-vote') {
      const current = openVoting(get());
      if (!current) return;
      const t = tallyFor(current, get());
      const yes = await confirmDialog(
        `Закрыть голосование?<br><br>За: <b>${t.for}</b> · Против: <b>${t.against}</b> · `
        + `Воздержались: <b>${t.abstain}</b> · Не голосовали: <b>${t.notVoted}</b><br>`
        + `${t.quorumMet ? 'Кворум соблюдён.' : 'Кворум НЕ соблюдён — решение будет отклонено.'}`,
        { title: 'Закрытие голосования', confirmLabel: 'Закрыть и подвести итог' },
      );
      if (!yes) return;

      const result = api.voting.close();
      if (!result.ok) return toast(result.reason, { kind: 'bad' });
      const data = result.data;
      const actions = [];
      if (data.doc) actions.push({ label: 'Документ', onClick: () => openDocViewer(data.doc.id) });
      if (data.sheet) actions.push({ label: 'Сводка', onClick: () => openSheetViewer(data.sheet.id) });
      toast(
        `Итог: ${data.adopted ? 'ПРИНЯТО' : 'ОТКЛОНЕНО'} · за ${data.tally.for}, против ${data.tally.against}.`,
        { kind: data.adopted ? 'ok' : 'warn', timeout: 8000, actions },
      );
    }
  });
}
