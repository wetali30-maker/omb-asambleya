// Общие утилиты: DOM, идентификаторы, форматирование, экранирование.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-5)}`;
}

export function esc(value = '') {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

export const pad2 = (n) => String(n).padStart(2, '0');
export const pad3 = (n) => String(n).padStart(3, '0');

export function dateLabel({ month, year }) {
  const m = MONTHS[Number(month)];
  return `${m ? m : '—'} ${year}`;
}

export function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fmtDateTime(ts) {
  const d = new Date(ts);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} · ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fmtClock(date = new Date()) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function fmtElapsed(fromTs) {
  const total = Math.max(0, Math.floor((Date.now() - Number(fromTs || Date.now())) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h} ч ${pad2(m)} мин` : `${m} мин`;
}

export function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${pad2(m)}:${pad2(s)}`;
}

export function initials(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((p) => p[0]).join('').toUpperCase() || 'ОМБ';
}

export function truncate(text = '', max = 40) {
  const s = String(text);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function debounce(fn, ms = 220) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function icon(id, cls = '') {
  return `<svg class="icon ${cls}" aria-hidden="true"><use href="#${id}"></use></svg>`;
}

export function avatarHtml(name, url, {
  cls = '', eye = false, eyeTitle = 'Наблюдатель', chairSlot = null,
} = {}) {
  const inner = url ? `<img src="${url}" alt="">` : esc(initials(name));
  const pin = chairSlot
    ? `<span class="role-pin ${Number(chairSlot) === 2 ? 'vice' : 'chair'}">${Number(chairSlot) === 2 ? 'С' : 'П'}</span>`
    : '';
  return `<span class="avatar-wrap">`
    + `<span class="avatar ${cls}">${inner}</span>`
    + pin
    + (eye ? `<span class="eye-badge" title="${esc(eyeTitle)}">${icon('i-eye')}</span>` : '')
    + '</span>';
}

export function roleLabel(role, canVote = true, chairSlot = 1) {
  if (role === 'chairman') return Number(chairSlot) === 2 ? 'Сопредседатель' : 'Председатель';
  if (role === 'observer') return 'Наблюдатель';
  return canVote ? 'Дипломат' : 'Делегация без голоса';
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function fileNameSafe(value = '') {
  return String(value).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '_').slice(0, 80) || 'документ';
}

export function pluralRu(n, one, few, many) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

export function normalizeCountry(name = '') {
  return String(name).trim().replace(/\s+/g, ' ').toLowerCase();
}

// Перенос текста по словам для canvas; сохраняет явные переводы строк.
export function wrapCanvasText(ctx, text, maxWidth) {
  const paragraphs = String(text ?? '').split('\n');
  const lines = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width <= maxWidth || !line) {
        line = test;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

export function fitText(ctx, text, maxWidth) {
  const s = String(text ?? '');
  if (ctx.measureText(s).width <= maxWidth) return s;
  let cut = s;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
