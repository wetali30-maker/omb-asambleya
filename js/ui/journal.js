// Журнал событий заседания с фильтром по типу.

import { api } from '../api.js';
import { $, esc, fmtTime, icon } from '../utils.js';

const TYPES = {
  all: 'Все события',
  voting: 'Голосования',
  resolution: 'Резолюции',
  amendment: 'Правки',
  speech: 'Выступления',
  session: 'Заседание',
  archive: 'Архив',
};

const GROUP = {
  voting: 'voting',
  resolution: 'resolution',
  amendment: 'amendment',
  speech: 'speech',
  archive: 'archive',
  session: 'session',
  timer: 'session',
  seat: 'session',
  diplomat: 'session',
  chairman: 'session',
  system: 'session',
};

const TYPE_LABEL = {
  voting: 'Голосование',
  resolution: 'Резолюция',
  amendment: 'Правка',
  speech: 'Слово',
  archive: 'Архив',
  session: 'Сессия',
  timer: 'Регламент',
  seat: 'Места',
  diplomat: 'Дипломаты',
  chairman: 'Председатель',
  system: 'Система',
};

const TYPE_ICON = {
  voting: 'i-ballot',
  resolution: 'i-file',
  amendment: 'i-edit',
  speech: 'i-mic',
  archive: 'i-archive',
  session: 'i-reset',
  timer: 'i-clock',
  seat: 'i-users',
  diplomat: 'i-users',
  chairman: 'i-gavel',
  system: 'i-gear',
};

let filter = 'all';

export function renderJournal() {
  const host = $('#side-body');
  if (!host) return;

  const events = api.journal.list()
    .filter((e) => filter === 'all' || GROUP[e.type] === filter)
    .slice(0, 250);

  let rows = '';
  let lastDay = null;
  for (const e of events) {
    const day = new Date(e.ts).toLocaleDateString('ru-RU');
    if (day !== lastDay) {
      lastDay = day;
      rows += `<div class="chat-session-divider">${esc(day)}</div>`;
    }
    rows += `
      <div class="journal-row">
        <span class="j-icon">${icon(TYPE_ICON[e.type] || 'i-file')}</span>
        <div class="j-body">
          <div class="j-type">${esc(TYPE_LABEL[e.type] || e.type)}</div>
          <div>${esc(e.message)}</div>
        </div>
        <span class="j-time">${fmtTime(e.ts)}</span>
      </div>`;
  }

  host.innerHTML = `
    <div class="panel-head">
      <span class="panel-title">Журнал событий</span>
      <span class="spacer"></span>
      <select class="select" id="journal-filter" style="width:auto;font-size:10px;padding:4px 6px">
        ${Object.entries(TYPES).map(([value, label]) => `
          <option value="${value}" ${filter === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
    </div>
    <div class="panel-scroll">
      <div class="journal-list">
        ${rows || `<div class="empty">
          <span class="empty-icon">${icon('i-clock')}</span>
          ${filter === 'all' ? 'Журнал пока пуст.' : 'Событий этого типа нет.'}
        </div>`}
      </div>
    </div>`;

  host.querySelector('#journal-filter')?.addEventListener('change', (event) => {
    filter = event.target.value;
    renderJournal();
  });
}
