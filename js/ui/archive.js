// Архив: листы итогов и документы резолюций с поиском и фильтрами.

import { get } from '../store.js';
import { api } from '../api.js';
import {
  $, esc, icon, fmtDateTime, debounce,
} from '../utils.js';
import { openSheetViewer, openDocViewer, openProtoViewer } from './viewers.js';
import { toast } from './modal.js';

let query = '';
let kindFilter = 'all';
let resultFilter = 'all';
let sortOrder = 'new';
let listScroll = 0;

export function renderArchive() {
  const host = $('#archive-view');
  if (!host) return;

  const docs = api.archive.list();
  const sessions = new Set(docs.map((d) => d.sessionId));
  const sheetsCount = docs.filter((d) => d.kind === 'ballot-sheet').length;
  const docsCount = docs.filter((d) => d.kind === 'resolution-doc').length;
  const protocolsCount = docs.filter((d) => d.kind === 'session-protocol').length;

  host.innerHTML = `
    <div class="archive-shell">
      <div class="archive-top">
        <div class="archive-title-row">
          <h2 class="display">Архив Асамблеи</h2>
          <span class="sub">${docs.length} ${pluralDocs(docs.length)} · сессий: ${sessions.size}</span>
        </div>
        <div class="archive-folder-strip">
          <button type="button" class="folder-tab ${kindFilter === 'all' ? 'active' : ''}" data-folder="all">
            ${icon('i-archive')} Все <span class="count">${docs.length}</span>
          </button>
          <button type="button" class="folder-tab ${kindFilter === 'sheet' ? 'active' : ''}" data-folder="sheet">
            ${icon('i-ballot')} Листы итогов <span class="count">${sheetsCount}</span>
          </button>
          <button type="button" class="folder-tab ${kindFilter === 'doc' ? 'active' : ''}" data-folder="doc">
            ${icon('i-file')} Резолюции <span class="count">${docsCount}</span>
          </button>
          <button type="button" class="folder-tab ${kindFilter === 'protocol' ? 'active' : ''}" data-folder="protocol">
            ${icon('i-newspaper')} Протоколы <span class="count">${protocolsCount}</span>
          </button>
        </div>
        <div class="archive-filters">
          <div class="search-wrap">
            ${icon('i-search')}
            <input class="input" id="arc-search" placeholder="Поиск по номеру, теме, сессии, документу"
                   value="${esc(query)}" autocomplete="off">
          </div>
          <select class="select" id="arc-kind">
            <option value="all" ${kindFilter === 'all' ? 'selected' : ''}>Все документы</option>
            <option value="sheet" ${kindFilter === 'sheet' ? 'selected' : ''}>Листы итогов</option>
            <option value="doc" ${kindFilter === 'doc' ? 'selected' : ''}>Резолюции</option>
            <option value="protocol" ${kindFilter === 'protocol' ? 'selected' : ''}>Протоколы</option>
          </select>
          <select class="select" id="arc-result">
            <option value="all" ${resultFilter === 'all' ? 'selected' : ''}>Любой итог</option>
            <option value="adopted" ${resultFilter === 'adopted' ? 'selected' : ''}>Принятые</option>
            <option value="rejected" ${resultFilter === 'rejected' ? 'selected' : ''}>Отклонённые</option>
          </select>
          <select class="select sort-select" id="arc-sort">
            <option value="new" ${sortOrder === 'new' ? 'selected' : ''}>Сначала новые</option>
            <option value="old" ${sortOrder === 'old' ? 'selected' : ''}>Сначала старые</option>
          </select>
        </div>
      </div>
      <div class="archive-list" id="arc-list"></div>
    </div>`;

  const listEl = host.querySelector('#arc-list');

  const drawList = () => {
    const state = get();
    const allDocs = api.archive.list();
    const q = query.trim().toLowerCase();

    const filtered = allDocs.filter((d) => {
      if (kindFilter === 'sheet' && d.kind !== 'ballot-sheet') return false;
      if (kindFilter === 'doc' && d.kind !== 'resolution-doc') return false;
      if (kindFilter === 'protocol' && d.kind !== 'session-protocol') return false;
      if (resultFilter !== 'all' && d.result !== resultFilter) return false;
      if (!q) return true;
      const haystack = [
        d.number,
        d.topic,
        d.payload?.docNo,
        d.payload?.number,
        d.payload?.topic,
        d.payload?.sessionName,
        d.payload?.targetLabel,
        d.payload?.preparedBy?.name,
        d.payload?.preparedBy?.country,
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });

    filtered.sort((a, b) => (sortOrder === 'new' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt));

    listEl.innerHTML = filtered.length
      ? filtered.map((d) => rowHtml(d, state)).join('')
      : `<div class="empty" style="margin-top:26px">
           <span class="empty-icon">${icon('i-archive')}</span>
           ${docs.length ? 'По запросу ничего не найдено. Измените фильтры.' : 'Архив пуст. Документы появятся после первого закрытого голосования.'}
         </div>`;

    listEl.scrollTop = listScroll;

    listEl.querySelectorAll('[data-doc]').forEach((row) => {
      row.addEventListener('click', () => {
        if (row.dataset.kind === 'ballot-sheet') openSheetViewer(row.dataset.doc);
        else if (row.dataset.kind === 'session-protocol') openProtoViewer(row.dataset.doc);
        else openDocViewer(row.dataset.doc);
      });
    });
  };

  const syncFolders = () => {
    host.querySelectorAll('[data-folder]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.folder === kindFilter);
    });
    const select = host.querySelector('#arc-kind');
    if (select) select.value = kindFilter;
  };

  host.querySelectorAll('[data-folder]').forEach((btn) => {
    btn.addEventListener('click', () => {
      kindFilter = btn.dataset.folder;
      syncFolders();
      drawList();
    });
  });

  host.querySelector('#arc-search').addEventListener('input', debounce((event) => {
    query = event.target.value;
    drawList();
  }, 160));

  host.querySelector('#arc-kind').addEventListener('change', (event) => {
    kindFilter = event.target.value;
    syncFolders();
    drawList();
  });
  host.querySelector('#arc-result').addEventListener('change', (event) => {
    resultFilter = event.target.value;
    drawList();
  });
  host.querySelector('#arc-sort').addEventListener('change', (event) => {
    sortOrder = event.target.value;
    drawList();
  });

  listEl.addEventListener('scroll', () => { listScroll = listEl.scrollTop; });

  drawList();
}

function rowHtml(doc, state) {
  const payload = doc.payload || {};
  const isSheet = doc.kind === 'ballot-sheet';
  const isProtocol = doc.kind === 'session-protocol';
  const title = isProtocol
    ? `Протокол ${payload.docNo || '—'} · ${payload.sessionName || 'Сессия'}`
    : isSheet
      ? `Лист итогов · Резолюция № ${doc.number} · ${payload.targetLabel || ''}`
      : `Документ ${payload.docNo || '—'} · Резолюция № ${doc.number}${doc.result === 'adopted' ? ' — принята' : doc.result === 'rejected' ? ' — отклонена' : ''}`;
  const topic = isProtocol
    ? `Составил: ${payload.preparedBy?.name || '—'} (${payload.preparedBy?.country || '—'})`
    : doc.topic || payload.topic || '—';

  const resultBadge = isProtocol
    ? '<span class="badge">Протокол заседания</span>'
    : doc.result === 'adopted'
      ? `<span class="badge ok">${isSheet ? 'Принято' : 'Принята'}</span>`
      : doc.result === 'rejected'
        ? `<span class="badge bad">${isSheet ? 'Отклонено' : 'Отклонена'}</span>`
        : `<span class="badge">${isSheet ? (payload.statusLabel || 'Лист') : '—'}</span>`;

  const amendBadge = doc.withAmendments
    ? `<span class="badge warn">с правками (${doc.amendmentsCount})</span>`
    : '';

  return `
    <div class="archive-row" data-doc="${doc.id}" data-kind="${doc.kind}" tabindex="0" role="button">
      <span class="a-kind ${isSheet ? 'sheet' : ''}${isProtocol ? ' protocol' : ''}">${icon(isProtocol ? 'i-newspaper' : isSheet ? 'i-ballot' : 'i-file')}</span>
      <div class="a-main">
        <div class="a-title">${esc(title)}</div>
        <div class="a-meta">
          <span>${esc(payload.sessionName || 'Сессия')}</span>
          <span>${esc(payload.sessionDateLabel || '')}</span>
          <span>${esc(topic)}</span>
          <span>${fmtDateTime(doc.createdAt)}</span>
        </div>
      </div>
      <div class="a-side">
        ${amendBadge}
        ${resultBadge}
        <span class="badge plain">${isSheet ? 'PNG' : isProtocol ? 'A4 · PDF' : 'A4 · PNG / PDF'}</span>
      </div>
    </div>`;
}

function pluralDocs(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'документ';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'документа';
  return 'документов';
}

export function resetArchiveFilters() {
  query = '';
  kindFilter = 'all';
  resultFilter = 'all';
  sortOrder = 'new';
  listScroll = 0;
}
