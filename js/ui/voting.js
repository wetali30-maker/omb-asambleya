// Панель идущего голосования: счётчики, бюллетени, закрытие председателем.

import { get } from '../store.js';
import { api } from '../api.js';
import {
  openVoting, tallyFor, canCastVote, activeDiplomat, quorumInfo, isSeatedChairman,
} from '../rules.js';
import { $, esc, icon } from '../utils.js';
import { toast, confirmDialog } from './modal.js';
import { openSheetViewer, openDocViewer, openLiveSheet } from './viewers.js';

const CHOICES = [
  { key: 'for', label: 'За', cls: 'for' },
  { key: 'against', label: 'Против', cls: 'against' },
  { key: 'abstain', label: 'Воздержаться', cls: 'abstain' },
];

export function renderVotingBand() {
  const host = $('#voting-band');
  if (!host) return;

  const state = get();
  const voting = openVoting(state);
  if (!voting) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }

  host.hidden = false;
  host.classList.add('voting-band');

  const tally = tallyFor(voting, state);
  const q = quorumInfo(state);
  const actor = activeDiplomat(state);
  const eligibility = actor
    ? canCastVote(state, actor)
    : { ok: false, reason: 'Сначала выберите дипломата в шапке.' };
  const myVote = actor ? voting.ballots?.[actor.country]?.vote : null;
  const canClose = isSeatedChairman(actor);
  const kindLabel = voting.targetType === 'amendment' ? 'Правка' : 'Резолюция';

  const buttons = CHOICES.map((c) => `
    <button type="button" class="vote-btn ${c.cls} ${myVote === c.key ? 'active' : ''}"
      data-vote="${c.key}" ${eligibility.ok ? '' : 'disabled'}
      title="${eligibility.ok ? 'Отдать голос' : esc(eligibility.reason)}">
      ${c.label}${myVote === c.key ? ' ✓' : ''}
    </button>`).join('');

  const noteParts = [];
  if (!tally.quorumMet) {
    noteParts.push(`Кворум не соблюдён: ${tally.present} из ${tally.required} необходимых.`);
  } else {
    noteParts.push(`Кворум: ${tally.present} / ${tally.required}.`);
  }
  noteParts.push(`Не голосовали: ${tally.notVoted}.`);
  if (actor) {
    if (!eligibility.ok) noteParts.push(eligibility.reason);
    else if (myVote) noteParts.push(`Ваш голос: ${myVote === 'for' ? 'за' : myVote === 'against' ? 'против' : 'воздержался'} (1 страна = 1 голос).`);
    else noteParts.push(`${actor.country}: голос ещё не отдан.`);
  }

  host.innerHTML = `
    <div style="flex:1;min-width:220px">
      <div class="vb-kicker">Идёт голосование · ${kindLabel}</div>
      <div class="vb-label">${esc(voting.label)}</div>
    </div>
    <div class="vb-counts">
      <span class="vchip for">За <b>${tally.for}</b></span>
      <span class="vchip against">Против <b>${tally.against}</b></span>
      <span class="vchip abstain">Возд. <b>${tally.abstain}</b></span>
      <span class="vchip">Не голос. <b>${tally.notVoted}</b></span>
    </div>
    <div class="vote-buttons">${buttons}</div>
    <button type="button" class="btn small ghost" id="vote-live-sheet">${icon('i-file')} Сводка</button>
    ${canClose
    ? `<button type="button" class="btn small paper" id="vote-close">${icon('i-gavel')} Закрыть голосование</button>`
    : ''}
    <div class="voting-note">${esc(noteParts.join(' '))}
      ${!canClose && q.met ? 'Закрывает голосование только председатель в кресле президиума.' : ''}</div>`;

  host.querySelectorAll('[data-vote]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const result = api.voting.cast(btn.dataset.vote);
      if (!result.ok) toast(result.reason, { kind: 'warn' });
    });
  });

  host.querySelector('#vote-live-sheet')?.addEventListener('click', () => openLiveSheet(voting.id));

  host.querySelector('#vote-close')?.addEventListener('click', async () => {
    const current = tallyFor(openVoting(get()), get());
    const yes = await confirmDialog(
      `Закрыть голосование?<br><br>За: <b>${current.for}</b> · Против: <b>${current.against}</b> · `
      + `Воздержались: <b>${current.abstain}</b> · Не голосовали: <b>${current.notVoted}</b><br>`
      + `${current.quorumMet ? 'Кворум соблюдён.' : 'Кворум НЕ соблюдён — решение будет отклонено.'}`,
      { title: 'Закрытие голосования', confirmLabel: 'Закрыть и подвести итог' },
    );
    if (!yes) return;

    const result = api.voting.close();
    if (!result.ok) return toast(result.reason, { kind: 'bad' });

    const data = result.data;
    const actions = [];
    if (data.doc) {
      actions.push({ label: 'Документ', onClick: () => openDocViewer(data.doc.id) });
    }
    if (data.sheet) {
      actions.push({ label: 'Сводка', onClick: () => openSheetViewer(data.sheet.id) });
    }
    toast(
      `Итог: ${data.adopted ? 'ПРИНЯТО' : 'ОТКЛОНЕНО'} · за ${data.tally.for}, против ${data.tally.against}`
      + `${data.tally.quorumMet ? '' : ' (кворум не соблюдён)'}. ${data.doc ? 'Документ отправлен в архив.' : 'Лист итогов сохранён в архиве.'}`,
      { kind: data.adopted ? 'ok' : 'warn', timeout: 9000, actions },
    );
  });
}
