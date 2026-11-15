// Дипломатический канал: история сообщений с аватарами и формой отправки.

import { get } from '../store.js';
import { api } from '../api.js';
import { activeDiplomat, openVoting, isChairman, isSeatedChairman } from '../rules.js';
import { isAdminSession } from '../auth.js';
import {
  $, esc, fmtTime, icon, avatarHtml, roleLabel,
} from '../utils.js';

const PHRASES = [
  'Прошу слова.',
  'К порядку ведения.',
  'Призываю к сдержанности.',
  'Заявляю решительный протест.',
  'Предлагаю поправку к резолюции.',
];
import { getImageUrl } from '../idb.js';
import { toast, confirmDialog } from './modal.js';
import { openDiplomatForm } from './diplomats.js';

let renderSeq = 0;
let suppressRestore = false;
let focusAfterRender = false;
let chatMode = 'channel';
let switchingMode = false;
let whisperTo = '';
const drafts = { channel: '', whisper: '' };

export async function renderChat() {
  const host = $('#side-body');
  if (!host) return;

  const seq = (renderSeq += 1);
  const state = get();
  const actor = activeDiplomat(state);
  const voting = openVoting(state);
  const canModerate = isAdminSession() || Boolean(actor && isChairman(actor) && isSeatedChairman(actor));
  const mode = actor && chatMode === 'whisper' ? 'whisper' : 'channel';

  const oldWrap = host.querySelector('.chat-wrap');
  const oldLog = oldWrap?.querySelector('.chat-log');
  const wasAtBottom = oldLog
    ? oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 40
    : true;
  const oldScroll = oldLog?.scrollTop || 0;
  const oldInput = oldWrap?.querySelector('textarea');
  const oldText = suppressRestore ? '' : switchingMode ? drafts[mode] : (oldInput?.value ?? drafts[mode]);
  switchingMode = false;
  const hadFocus = oldInput && document.activeElement === oldInput;

  const allMessages = state.chat || [];
  const messages = allMessages.filter((m) => (mode === 'whisper'
    ? m.visibility === 'whisper' && (m.diplomatId === actor?.id || m.toId === actor?.id)
    : m.visibility !== 'whisper'));
  const whisperTargets = state.diplomats
    .filter((d) => d.id !== actor?.id)
    .sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru'));
  if (!whisperTargets.some((d) => d.id === whisperTo)) whisperTo = whisperTargets[0]?.id || '';

  const urls = {};
  await Promise.all(messages.map(async (m) => {
    const [av, fl] = await Promise.all([
      getImageUrl(m.snapshot?.avatarId),
      getImageUrl(m.snapshot?.flagId),
    ]);
    urls[m.id] = { avatar: av, flag: fl };
  }));
  if (seq !== renderSeq) return;

  let listHtml = '';
  let lastSession = null;
  for (const m of messages) {
    if (m.sessionId !== lastSession) {
      lastSession = m.sessionId;
      const date = new Date(m.ts).toLocaleDateString('ru-RU');
      listHtml += `<div class="chat-session-divider">${esc(m.sessionName || 'Сессия')} · ${esc(date)}</div>`;
    }
    const snap = m.snapshot || { name: 'Дипломат', country: '—' };
    const isObserver = snap.role === 'observer';
    const isChairman = snap.role === 'chairman';
    const isVice = isChairman && Number(snap.chairSlot) === 2;
    const isWhisper = m.visibility === 'whisper';
    const whisperLine = isWhisper
      ? (m.diplomatId === actor?.id
        ? `<span class="msg-whisper-badge">шёпот</span><span class="msg-whisper-to">→ ${esc(m.toSnapshot?.name || '—')}</span>`
        : `<span class="msg-whisper-badge">шёпот</span><span class="msg-whisper-to">лично вам</span>`)
      : '';
    const roleText = roleLabel(snap.role, snap.canVote !== false, snap.chairSlot || 1);
    listHtml += `
      <div class="chat-msg${isChairman ? ' chair' : ''}${isObserver ? ' observer' : ''}${isWhisper ? ' whisper' : ''}">
        ${avatarHtml(snap.name, urls[m.id]?.avatar, {
    cls: `sm${isObserver ? ' observer' : ''}${isChairman ? (isVice ? ' role-vice' : ' role-chair') : ''}`,
    eye: isObserver,
    eyeTitle: 'Наблюдатель',
    chairSlot: isChairman ? (snap.chairSlot || 1) : null,
  })}
        <div class="msg-main">
          <div class="msg-head">
            <span class="msg-name">${esc(snap.name)}</span>
            <span class="msg-country">${esc(snap.country)}</span>
            ${urls[m.id]?.flag ? `<img class="msg-flag" src="${urls[m.id].flag}" alt="Флаг">` : ''}
            <span class="msg-role ${isChairman ? 'chair' : isObserver ? 'obs' : 'dip'}">${isChairman ? icon('i-gavel') : ''}${esc(roleText)}</span>
            ${whisperLine}
            <span class="msg-time">${fmtTime(m.ts)}</span>
            ${canModerate ? `<button type="button" class="msg-del" data-del-msg="${m.id}" title="Удалить сообщение" aria-label="Удалить сообщение">×</button>` : ''}
          </div>
          <div class="msg-text${isObserver ? ' observer-note' : ''}">${esc(m.text)}</div>
        </div>
      </div>`;
  }

  const emptyState = !messages.length
    ? mode === 'whisper'
      ? `<div class="chat-empty-whisper">${icon('i-eye')}<br>Личных сообщений пока нет.<br>Выберите дипломата и напишите шёпотом.</div>`
      : `<div class="empty">
           <span class="empty-icon">${icon('i-send')}</span>
           Канал пуст. Первое слово — за вами.
         </div>`
    : '';

  const recipientName = whisperTargets.find((d) => d.id === whisperTo)?.fullName;
  const placeholder = actor
    ? mode === 'whisper'
      ? `Шёпот для ${recipientName || 'дипломата'}…`
      : voting ? 'Идёт голосование. Сообщение в канал…' : 'Обращение к Асамблее…'
    : 'Сначала выберите дипломата…';

  const modeBar = actor && state.diplomats.length > 1
    ? `<div class="chat-mode-bar" role="tablist">
         <button type="button" class="chat-mode-btn ${mode === 'channel' ? 'active' : ''}" data-chat-mode="channel">
           ${icon('i-send')} Канал
         </button>
         <button type="button" class="chat-mode-btn ${mode === 'whisper' ? 'active' : ''}" data-chat-mode="whisper">
           ${icon('i-eye')} Шёпот
         </button>
       </div>`
    : '';

  const whisperBar = mode === 'whisper'
    ? `<div class="chat-whisper-bar">
         <span>Кому</span>
         <select id="whisper-to" aria-label="Получатель шёпота">
           ${whisperTargets.map((d) => `<option value="${d.id}" ${d.id === whisperTo ? 'selected' : ''}>${esc(d.fullName)} · ${esc(d.country)}</option>`).join('')}
         </select>
       </div>`
    : '';

  const compose = !state.diplomats.length
    ? `<div class="chat-compose" style="justify-content:center">
         <button type="button" class="btn primary" data-register>${icon('i-plus')} Зарегистрировать дипломата</button>
       </div>`
    : `${mode === 'channel' ? `<div class="chat-phrases" aria-label="Быстрые фразы">
         ${PHRASES.map((p) => `<button type="button" class="phrase-chip" data-phrase="${esc(p)}">${esc(p)}</button>`).join('')}
       </div>` : ''}
       ${whisperBar}
       <form class="chat-compose" id="chat-form">
         <textarea id="chat-input" rows="1" maxlength="1200"
           placeholder="${esc(placeholder)}" ${actor && (mode === 'channel' || whisperTo) ? '' : 'disabled'}></textarea>
         <button type="submit" class="btn primary" id="chat-send" ${actor && (mode === 'channel' || whisperTo) ? '' : 'disabled'}
           title="Отправить (Enter)">${icon('i-send')}</button>
       </form>`;

  host.innerHTML = `
    <div class="chat-wrap">
      ${modeBar}
      <div class="chat-log" id="chat-log">${listHtml}${emptyState}</div>
      ${compose}
    </div>`;

  const log = host.querySelector('#chat-log');
  if (log) {
    log.scrollTop = wasAtBottom || suppressRestore ? log.scrollHeight : oldScroll;
  }

  host.querySelectorAll('[data-chat-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.chatMode === mode) return;
      chatMode = btn.dataset.chatMode;
      switchingMode = true;
      suppressRestore = false;
      focusAfterRender = true;
      renderChat();
    });
  });

  host.querySelector('#whisper-to')?.addEventListener('change', (event) => {
    whisperTo = event.target.value;
    const input = host.querySelector('#chat-input');
    if (input) input.placeholder = `Шёпот для ${whisperTargets.find((d) => d.id === whisperTo)?.fullName || 'дипломата'}…`;
  });

  const input = host.querySelector('#chat-input');
  if (input) {
    if (oldText) {
      input.value = oldText;
      drafts[mode] = oldText;
    }
    const autoGrow = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(112, Math.max(38, input.scrollHeight))}px`;
    };
    autoGrow();
    if (hadFocus || focusAfterRender) {
      focusAfterRender = false;
      setTimeout(() => {
        try {
          input.focus({ preventScroll: true });
          input.setSelectionRange(input.value.length, input.value.length);
        } catch { /* noop */ }
      }, 0);
    }
    input.addEventListener('input', () => {
      drafts[mode] = input.value;
      autoGrow();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage(host, mode);
      }
    });
  }

  host.querySelectorAll('[data-phrase]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!input) return;
      const phrase = btn.dataset.phrase;
      const sep = input.value && !/\s$/.test(input.value) ? ' ' : '';
      input.value = `${input.value}${sep}${phrase}`;
      drafts[mode] = input.value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    });
  });

  host.querySelector('#chat-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    sendMessage(host, mode);
  });

  host.querySelector('[data-register]')?.addEventListener('click', () => openDiplomatForm({ first: true }));

  host.querySelectorAll('[data-del-msg]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const yes = await confirmDialog(
        'Удалить это сообщение из канала? Действие увидит вся Ассамблея.',
        { title: 'Удаление сообщения', confirmLabel: 'Удалить', danger: true },
      );
      if (!yes) return;
      const result = api.chat.remove(btn.dataset.delMsg);
      if (!result.ok) toast(result.reason, { kind: 'bad' });
    });
  });

  suppressRestore = false;
}

function sendMessage(host, mode = 'channel') {
  const input = host.querySelector('#chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  if (mode === 'whisper' && !whisperTo) {
    toast('Выберите получателя шёпота.', { kind: 'warn' });
    return;
  }

  suppressRestore = true;
  focusAfterRender = true;
  const result = mode === 'whisper'
    ? api.chat.send(text, { toId: whisperTo })
    : api.chat.send(text);
  if (!result.ok) {
    suppressRestore = false;
    focusAfterRender = false;
    toast(result.reason, { kind: 'warn' });
    return;
  }
  input.value = '';
  drafts[mode] = '';
  input.style.height = '38px';
}
