// Просмотр документов: лист итогов (PNG) и документ резолюции (PNG / печать).

import { get } from '../store.js';
import { api } from '../api.js';
import {
  buildSheetPayload, buildSheetCanvas, downloadSheetPng,
  buildResolutionDocCanvas, downloadDocPng, renderResolutionDocHTML, renderProtocolHTML,
  protocolText, ensureFonts,
} from '../export.js';
import { downloadResolutionDocx, downloadProtocolDocx, downloadProtocolPng } from '../docx.js';
import { $, esc, icon, fmtDateTime } from '../utils.js';
import { openModal, toast } from './modal.js';

const REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)');

// Заголовок документа печатается посимвольно с мигающим курсором.
function typeDocTitle(paper) {
  const title = paper?.querySelector('.doc-title');
  if (!title || REDUCED_MOTION?.matches) return;

  const parts = [...title.childNodes].map((node) => (
    node.nodeType === Node.TEXT_NODE
      ? { text: node.textContent.replace(/\s+/g, ' ').replace(/^ | $/g, '') }
      : { br: true }
  )).filter((p) => p.br || p.text);

  title.textContent = '';
  const caret = document.createElement('span');
  caret.className = 'tw-caret';
  title.appendChild(caret);

  let delay = 240;
  const typeText = (text, done) => {
    let i = 0;
    const tick = () => {
      if (!title.isConnected) return;
      if (i >= text.length) {
        delay = 90;
        done();
        return;
      }
      const char = text[i];
      caret.before(document.createTextNode(char));
      i += 1;
      setTimeout(tick, char === ' ' ? 14 : 24);
    };
    tick();
  };

  const next = (index) => {
    if (index >= parts.length) {
      setTimeout(() => caret.remove(), 1100);
      return;
    }
    const part = parts[index];
    if (part.br) {
      setTimeout(() => {
        if (!title.isConnected) return;
        caret.before(document.createElement('br'));
        next(index + 1);
      }, delay);
      return;
    }
    setTimeout(() => typeText(part.text, () => next(index + 1)), 0);
  };
  next(0);
}

/* ------------------------------------------------------------------ */
/* Лист итогов голосования                                             */
/* ------------------------------------------------------------------ */

async function showSheet(payload, { title, note = '' } = {}) {
  await ensureFonts();
  const canvas = await buildSheetCanvas(payload, 2);
  canvas.style.width = '100%';
  canvas.style.height = 'auto';
  canvas.style.display = 'block';

  const frame = document.createElement('div');
  frame.style.cssText = 'background:#14100d;border:1px solid #55493d;padding:8px;box-shadow:0 10px 30px rgba(0,0,0,.45)';
  frame.appendChild(canvas);

  const body = document.createElement('div');
  body.innerHTML = `
    <div class="mini-note" style="margin-bottom:10px">${note || 'Лист итогов сформирован по данным голосования.'}</div>
    <div class="kv" style="grid-template-columns:auto 1fr;margin-bottom:12px">
      <dt>Резолюция</dt><dd>№ ${esc(payload.resolutionNumber)}</dd>
      <dt>Предмет</dt><dd>${esc(payload.targetLabel)}</dd>
      <dt>Статус</dt><dd>${esc(payload.statusLabel)}</dd>
      <dt>Кворум</dt><dd>${payload.quorum.present} / ${payload.quorum.required}
        — ${payload.quorum.met ? 'соблюдён' : 'не соблюдён'}</dd>
    </div>`;
  body.appendChild(frame);

  const footer = document.createElement('div');
  footer.className = 'btn-row';
  footer.style.width = '100%';
  footer.innerHTML = `
    <span class="mini-note" style="flex:1">Формат референса · 16:9 · PNG</span>
    <button type="button" class="btn ghost" data-close-viewer>Закрыть</button>
    <button type="button" class="btn paper" id="sheet-png">${icon('i-download')} Скачать PNG</button>`;

  const modal = openModal({
    title: title || 'Сводка итогов голосования',
    body,
    footer,
    size: 'xl',
  });

  modal.overlay.querySelector('[data-close-viewer]').addEventListener('click', () => modal.close());
  modal.overlay.querySelector('#sheet-png').addEventListener('click', async () => {
    const btn = modal.overlay.querySelector('#sheet-png');
    btn.disabled = true;
    try {
      const name = await downloadSheetPng(payload);
      toast(`Файл сохранён: ${name}`, { kind: 'ok' });
    } catch {
      toast('Не удалось сохранить PNG.', { kind: 'bad' });
    } finally {
      btn.disabled = false;
    }
  });
}

export async function openSheetViewer(docId) {
  const doc = api.archive.get(docId);
  if (!doc) return toast('Документ не найден в архиве.', { kind: 'bad' });
  if (doc.kind === 'resolution-doc') return openDocViewer(docId);

  const note = `Лист от ${fmtDateTime(doc.createdAt)} · ${doc.payload.sessionName}, ${doc.payload.sessionDateLabel}.`;
  return showSheet(doc.payload, { note });
}

export function openLiveSheet(votingId) {
  const state = get();
  const voting = state.votings.find((v) => v.id === votingId);
  if (!voting) return toast('Голосование не найдено.', { kind: 'bad' });

  const payload = buildSheetPayload(voting, state);
  const note = voting.status === 'open'
    ? 'Промежуточный лист: голосование ещё идёт. Итоговая версия сохранится в архиве после закрытия.'
    : 'Лист итогов этого голосования.';
  return showSheet(payload, { title: 'Сводка итогов (текущая)', note });
}

export function openLatestSheet() {
  const doc = api.archive.latestSheet();
  if (!doc) {
    return toast('В архиве пока нет листов итогов. Лист формируется после первого голосования.', { kind: 'info' });
  }
  return openSheetViewer(doc.id);
}

/* ------------------------------------------------------------------ */
/* Документ резолюции                                                  */
/* ------------------------------------------------------------------ */

export function openDocViewer(docId) {
  const doc = api.archive.get(docId);
  if (!doc) return toast('Документ не найден в архиве.', { kind: 'bad' });
  if (doc.kind === 'ballot-sheet') return openSheetViewer(docId);

  const payload = doc.payload;
  const body = document.createElement('div');
  body.style.cssText = 'background:#2a231d;margin:-16px;padding:16px';
  body.innerHTML = renderResolutionDocHTML(payload);
  body.firstElementChild?.classList.add('doc-appear');
  typeDocTitle(body.firstElementChild);

  const footer = document.createElement('div');
  footer.className = 'btn-row';
  footer.style.width = '100%';
  footer.innerHTML = `
    <span class="mini-note" style="flex:1">${esc(payload.docNo)} · A4 · PNG, DOCX или печать в PDF</span>
    <button type="button" class="btn ghost" data-close-viewer>Закрыть</button>
    <button type="button" class="btn" id="doc-print">${icon('i-print')} Печать / PDF</button>
    <button type="button" class="btn" id="doc-docx">${icon('i-file')} DOCX</button>
    <button type="button" class="btn paper" id="doc-png">${icon('i-download')} Скачать PNG</button>`;

  const modal = openModal({ title: `Документ ${payload.docNo}`, body, footer, size: 'lg' });
  const root = modal.overlay;

  root.querySelector('[data-close-viewer]').addEventListener('click', () => modal.close());

  root.querySelector('#doc-print').addEventListener('click', () => {
    printPaperDocument(renderResolutionDocHTML(payload));
  });

  root.querySelector('#doc-docx').addEventListener('click', () => {
    try {
      const name = downloadResolutionDocx(payload);
      toast(`Файл сохранён: ${name}`, { kind: 'ok' });
    } catch (err) {
      console.error(err);
      toast('Не удалось сохранить DOCX.', { kind: 'bad' });
    }
  });

  root.querySelector('#doc-png').addEventListener('click', async () => {
    const btn = root.querySelector('#doc-png');
    btn.disabled = true;
    try {
      await ensureFonts();
      const name = await downloadDocPng(payload);
      toast(`Файл сохранён: ${name}`, { kind: 'ok' });
    } catch {
      toast('Не удалось сохранить PNG.', { kind: 'bad' });
    } finally {
      btn.disabled = false;
    }
  });
}

/* ------------------------------------------------------------------ */
/* Протокол заседания                                                  */
/* ------------------------------------------------------------------ */

export function openProtoViewer(docId) {
  const doc = api.archive.get(docId);
  if (!doc) return toast('Протокол не найден в архиве.', { kind: 'bad' });
  if (doc.kind === 'session-protocol') return showProtocol(doc);
  return toast('Этот документ не является протоколом.', { kind: 'warn' });
}

function showProtocol(doc) {
  const payload = doc.payload;
  const body = document.createElement('div');
  body.style.cssText = 'background:#2a231d;margin:-16px;padding:16px';
  body.innerHTML = renderProtocolHTML(payload);
  const paper = body.firstElementChild;
  paper?.classList.add('doc-appear');
  typeDocTitle(paper);

  if (paper) {
    const entries = [...paper.querySelectorAll('.protocol-entry')];
    entries.forEach((entry, index) => {
      entry.style.opacity = '0';
      entry.style.transition = 'opacity .28s ease, transform .28s ease';
      entry.style.transform = 'translateY(4px)';
      setTimeout(() => {
        entry.style.opacity = '1';
        entry.style.transform = '';
      }, 120 + Math.min(index, 60) * 24);
    });
  }

  const footer = document.createElement('div');
  footer.className = 'btn-row';
  footer.style.width = '100%';
  footer.innerHTML = `
    <span class="mini-note" style="flex:1">${esc(payload.docNo)} · ${esc(fmtDateTime(payload.generatedAt))} · только для внутреннего архива</span>
    <button type="button" class="btn ghost" data-close-protocol>Закрыть</button>
    <button type="button" class="btn" id="proto-copy">${icon('i-file')} Копировать текст</button>
    <button type="button" class="btn" id="proto-print">${icon('i-print')} Печать / PDF</button>
    <button type="button" class="btn" id="proto-docx">${icon('i-archive')} DOCX</button>
    <button type="button" class="btn paper" id="proto-png">${icon('i-download')} PNG</button>`;

  const modal = openModal({ title: `Протокол ${payload.docNo}`, body, footer, size: 'lg' });
  const root = modal.overlay;

  root.querySelector('[data-close-protocol]').addEventListener('click', () => modal.close());

  root.querySelector('#proto-print').addEventListener('click', () => {
    printPaperDocument(renderProtocolHTML(payload));
  });

  root.querySelector('#proto-docx').addEventListener('click', () => {
    try {
      const name = downloadProtocolDocx(payload);
      toast(`Файл сохранён: ${name}`, { kind: 'ok' });
    } catch (err) {
      console.error(err);
      toast('Не удалось сохранить DOCX.', { kind: 'bad' });
    }
  });

  root.querySelector('#proto-png').addEventListener('click', async () => {
    const btn = root.querySelector('#proto-png');
    btn.disabled = true;
    try {
      const name = await downloadProtocolPng(payload);
      toast(`Файл сохранён: ${name}`, { kind: 'ok' });
    } catch (err) {
      console.error(err);
      toast('Не удалось сохранить PNG.', { kind: 'bad' });
    } finally {
      btn.disabled = false;
    }
  });

  root.querySelector('#proto-copy').addEventListener('click', async () => {
    const text = protocolText(payload);
    try {
      await navigator.clipboard.writeText(text);
      toast('Текст протокола скопирован.', { kind: 'ok' });
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand?.('copy');
      ta.remove();
      toast(ok ? 'Текст протокола скопирован.' : 'Не удалось скопировать текст.',
        { kind: ok ? 'ok' : 'bad' });
    }
  });
}

export function printPaperDocument(html) {
  const root = $('#print-root');
  if (!root) return;
  root.innerHTML = html;

  const cleanup = () => {
    root.innerHTML = '';
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);

  window.print();
  // Страховка для сред, где afterprint не приходит
  setTimeout(cleanup, 4000);
}

/* Резервный холст документа — на случай, если понадобится превью без DOM */
export async function buildDocPreviewCanvas(payload) {
  await ensureFonts();
  return buildResolutionDocCanvas(payload, 1);
}
