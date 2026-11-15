// Лист итогов голосования (по референсу) и документ резолюции:
// построение неизменяемых снапшотов, canvas-рендер для PNG,
// DOM-версия документа для просмотра и печати в PDF.

import {
  dateLabel, pad3, wrapCanvasText, fitText, fileNameSafe, downloadBlob, downloadDataUrl,
  esc, fmtDateTime, fmtTime, fmtDuration,
} from './utils.js';
import { tallyFor, chairmenOf } from './rules.js';

function chairList(state) {
  return chairmenOf(state).map((d) => ({
    name: d.fullName,
    country: d.country,
    role: Number(d.chairSlot) === 2 ? 'Сопредседатель' : 'Председатель',
  }));
}

/* ------------------------------------------------------------------ */
/* Снапшоты                                                            */
/* ------------------------------------------------------------------ */

export function buildSheetPayload(voting, state) {
  const res = state.resolutions.find((r) => r.id === voting.resolutionId) || null;
  const amendment = voting.targetType === 'amendment'
    ? res?.amendments.find((a) => a.id === voting.targetId)
    : null;
  const tally = voting.tally || tallyFor(voting, state);
  const chairs = chairList(state);
  const topic = res?.topic?.trim() || (res?.text || '').split('\n')[0] || '—';

  return {
    kind: 'ballot-sheet',
    votingId: voting.id,
    orgName: 'Организация Мировой Безопасности',
    orgShort: 'Асамблея ОМБ',
    sessionName: state.settings.sessionName,
    sessionDateLabel: dateLabel(state.settings.sessionDate),
    statusLabel: voting.status === 'open' ? 'Идёт голосование' : 'Голосование окончено',
    targetType: voting.targetType,
    targetLabel: voting.targetType === 'amendment'
      ? `Правка №${amendment?.order ?? '?'}`
      : 'Резолюция',
    resolutionNumber: res?.number || '—',
    topic,
    countries: voting.eligible
      .slice()
      .sort((a, b) => a.localeCompare(b, 'ru'))
      .map((country) => ({ name: country, vote: voting.ballots[country]?.vote || 'none' })),
    tally,
    quorum: {
      present: voting.eligible.length,
      required: tally.required,
      met: tally.quorumMet,
    },
    chairman: chairs[0]?.name || null,
    chairs,
    openedAt: voting.openedAt,
    closedAt: voting.closedAt,
  };
}

export function buildResolutionDocPayload(res, voting, state) {
  const tally = voting.tally || tallyFor(voting, state);
  const chairs = chairList(state);
  const amendments = res.amendments
    .filter((a) => a.status === 'adopted')
    .sort((a, b) => a.order - b.order);
  const seq = state.archive.filter((d) => d.kind === 'resolution-doc').length + 1;
  const topic = res.topic?.trim() || (res.text || '').split('\n')[0] || '—';

  return {
    kind: 'resolution-doc',
    votingId: voting.id,
    docNo: `АСМ-${state.settings.sessionDate.year}-${pad3(seq)}`,
    result: res.status, // adopted | rejected
    number: res.number,
    topic,
    text: res.text,
    author: res.authorSnapshot,
    amendments: amendments.map((a) => ({
      n: a.order,
      text: a.text,
      author: a.authorSnapshot.name,
      country: a.authorSnapshot.country,
    })),
    withAmendments: res.status === 'adopted' && amendments.length > 0,
    amendmentsCount: amendments.length,
    tally,
    quorum: {
      present: voting.eligible.length,
      required: tally.required,
      met: tally.quorumMet,
    },
    chairman: chairs[0]?.name || null,
    chairs,
    sessionName: state.settings.sessionName,
    sessionDateLabel: dateLabel(state.settings.sessionDate),
    createdAt: Date.now(),
  };
}

/* ------------------------------------------------------------------ */
/* Общие помощники canvas                                              */
/* ------------------------------------------------------------------ */

const MONO = '"PT Mono", "Courier New", monospace';
const DISPLAY = '"Oswald", "Arial Narrow", Arial, sans-serif';
const font = (size, weight = '400', family = MONO) => `${weight} ${size}px ${family}`;

const imageCache = new Map();

function loadImage(src) {
  if (!imageCache.has(src)) {
    imageCache.set(src, new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    }));
  }
  return imageCache.get(src);
}

export async function ensureFonts() {
  try {
    await document.fonts.ready;
    await Promise.all([
      document.fonts.load('14px "PT Mono"'),
      document.fonts.load('600 14px "Oswald"'),
    ]);
  } catch { /* шрифт не критичен для работы приложения */ }
}

function withSpacing(ctx, px) {
  try { ctx.letterSpacing = `${px}px`; } catch { /* не поддерживается */ }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOTE_RU = { for: 'за', against: 'против', abstain: 'воздержался', none: 'не голосовал' };

/* ------------------------------------------------------------------ */
/* Лист итогов (референс: тёмный ретро-терминал 1200×675)              */
/* ------------------------------------------------------------------ */

const SHEET = {
  bg: '#14100d',
  text: '#d8cfbc',
  dim: '#948974',
  band: '#6d3632',
  bandText: '#ecdfc7',
  for: '#7d8a5e',
  against: '#8e4640',
  abstain: '#b08d4f',
  neutral: '#d9cdb0',
  slot: '#41382f',
  darkText: '#161210',
};

export async function buildSheetCanvas(payload, scale = 2) {
  await ensureFonts();
  const W = 1200;
  const H = 675;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  // Фон терминала, виньетка, строчная развёртка
  ctx.fillStyle = SHEET.bg;
  ctx.fillRect(0, 0, W, H);
  for (let y = 0; y < H; y += 3) {
    ctx.fillStyle = 'rgba(255, 246, 228, 0.012)';
    ctx.fillRect(0, y, W, 1);
  }
  const vignette = ctx.createRadialGradient(W / 2, H / 2, 180, W / 2, H / 2, 760);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);

  // Водяной знак-эмблема
  const emblem = await loadImage('assets/emblem.svg');
  if (emblem) {
    ctx.save();
    ctx.globalAlpha = 0.09;
    ctx.drawImage(emblem, W / 2 - 215, H / 2 - 235, 430, 430);
    ctx.restore();
  }

  // Верхняя строка
  ctx.fillStyle = SHEET.text;
  ctx.font = font(12.5, '700');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(payload.orgName, 20, 24);

  // Лента заголовков
  const bandY = 34;
  const bandH = 30;
  const gap = 4;
  const cells = [
    payload.statusLabel,
    payload.orgShort,
    payload.sessionDateLabel,
    payload.targetLabel,
  ];
  const widths = [0.245, 0.265, 0.25, 0.24];
  const totalW = W - 40 - gap * 3;
  let bx = 20;
  cells.forEach((text, i) => {
    const cellW = totalW * widths[i];
    ctx.fillStyle = SHEET.band;
    ctx.fillRect(bx, bandY, cellW, bandH);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(bx, bandY + bandH - 2, cellW, 2);
    ctx.fillStyle = SHEET.bandText;
    ctx.font = font(14, '700');
    ctx.textAlign = 'center';
    ctx.fillText(fitText(ctx, text, cellW - 16), bx + cellW / 2, bandY + 21);
    bx += cellW + gap;
  });

  // Строка резолюции
  ctx.textAlign = 'left';
  ctx.fillStyle = SHEET.text;
  withSpacing(ctx, 0.5);
  ctx.font = font(16.5, '700');
  const resLine = `Резолюция №${payload.resolutionNumber}  |  Тема: ${payload.topic}`;
  ctx.fillText(fitText(ctx, resLine, W - 40), 20, 94);
  withSpacing(ctx, 0);

  // Сетка стран: 7 колонок, заполнение по столбцам, как в референсе
  const cols = 7;
  const gridTop = 116;
  const gridWidth = W - 40;
  const colW = gridWidth / cols;
  const rows = Math.max(6, Math.ceil(payload.countries.length / cols));
  const rowH = 23;

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const idx = c * rows + r;
      const x = 20 + c * colW;
      const y = gridTop + r * rowH;
      const country = payload.countries[idx];
      const sq = 15;

      if (!country) {
        ctx.strokeStyle = SHEET.slot;
        ctx.lineWidth = 1.2;
        ctx.strokeRect(x + 0.5, y + 0.5, sq, sq);
        continue;
      }

      const color = country.vote === 'for' ? SHEET.for
        : country.vote === 'against' ? SHEET.against
          : country.vote === 'abstain' ? SHEET.abstain
            : SHEET.neutral;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, sq, sq);
      if (country.vote === 'none') {
        ctx.strokeStyle = 'rgba(20,16,13,0.7)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, sq - 1, sq - 1);
      }

      ctx.fillStyle = SHEET.text;
      ctx.font = font(13, '700');
      ctx.textAlign = 'left';
      ctx.fillText(fitText(ctx, country.name, colW - sq - 14), x + sq + 9, y + 12);
    }
  }

  // Кворум и сумма неголосовавших
  ctx.font = font(11);
  ctx.fillStyle = SHEET.dim;
  ctx.textAlign = 'left';
  const quorumText = `Кворум: ${payload.quorum.met ? 'соблюдён' : 'НЕ СОБЛЮДЁН'}`
    + ` (присутствуют ${payload.quorum.present}, требуется ${payload.quorum.required})`;
  ctx.fillText(quorumText, 20, H - 64);
  ctx.textAlign = 'right';
  ctx.fillText(`Не голосовали: ${payload.tally.notVoted}`, W - 20, H - 64);

  // Итоговые полосы
  const bars = [
    { label: 'Поддержали', count: payload.tally.for, color: SHEET.for, text: SHEET.darkText },
    { label: 'Не поддержали', count: payload.tally.against, color: SHEET.against, text: '#f0e4d2' },
    { label: 'Воздержались', count: payload.tally.abstain, color: SHEET.abstain, text: SHEET.darkText },
  ];
  const barY = H - 50;
  const barH = 27;
  const barGap = 12;
  const groupW = (W - 40 - barGap * 2) / 3;
  bars.forEach((bar, i) => {
    const x = 20 + i * (groupW + barGap);
    ctx.fillStyle = bar.color;
    ctx.fillRect(x, barY, 26, barH);
    ctx.fillRect(x + 32, barY, groupW - 32, barH);
    ctx.fillStyle = bar.text;
    ctx.font = font(14, '700');
    ctx.textAlign = 'left';
    ctx.fillText(`${bar.label}: ${bar.count}`, x + 44, barY + 19);
  });

  return canvas;
}

export async function buildSheetDataUrl(payload, width = 600) {
  const canvas = await buildSheetCanvas(payload, 1);
  const thumb = document.createElement('canvas');
  const scale = width / canvas.width;
  thumb.width = width;
  thumb.height = Math.round(canvas.height * scale);
  const ctx = thumb.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, thumb.width, thumb.height);
  return thumb.toDataURL('image/png');
}

export async function downloadSheetPng(payload) {
  const canvas = await buildSheetCanvas(payload, 2);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const name = `OMB_лист_${fileNameSafe(payload.resolutionNumber)}_${fileNameSafe(payload.targetLabel)}.png`;
  if (blob) {
    const { downloadBlob } = await import('./utils.js');
    downloadBlob(blob, name);
  }
  return name;
}

/* ------------------------------------------------------------------ */
/* Документ резолюции (A4: 1240×1754)                                  */
/* ------------------------------------------------------------------ */

const DOC = {
  paper: '#e6dcc3',
  ink: '#2b2620',
  dim: '#6b6154',
  line: 'rgba(43,38,32,0.55)',
  olive: '#5c6a44',
  brick: '#7b3530',
};

let paperTexture = null;

function drawPaper(ctx, W, H) {
  ctx.fillStyle = DOC.paper;
  ctx.fillRect(0, 0, W, H);

  if (paperTexture) {
    ctx.save();
    ctx.globalAlpha = 0.34;
    ctx.globalCompositeOperation = 'multiply';
    const scale = Math.max(W / paperTexture.width, H / paperTexture.height);
    const dw = paperTexture.width * scale;
    const dh = paperTexture.height * scale;
    ctx.drawImage(paperTexture, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();
  }

  const glow = ctx.createRadialGradient(W / 2, 210, 80, W / 2, H / 2, H * 0.85);
  glow.addColorStop(0, 'rgba(255,252,240,0.35)');
  glow.addColorStop(0.7, 'rgba(255,252,240,0)');
  glow.addColorStop(1, 'rgba(110,90,60,0.14)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  const rand = mulberry32(1983);
  for (let i = 0; i < 1500; i += 1) {
    const x = rand() * W;
    const y = rand() * H;
    ctx.fillStyle = `rgba(43,38,32,${0.015 + rand() * 0.03})`;
    ctx.fillRect(x, y, 1 + rand() * 1.6, 1 + rand() * 1.4);
  }

  ctx.strokeStyle = 'rgba(43,38,32,0.13)';
  ctx.lineWidth = 1;
  ctx.strokeRect(18.5, 18.5, W - 37, H - 37);
}

function sectionLabel(ctx, x, y, width, text) {
  ctx.fillStyle = DOC.ink;
  ctx.font = font(10.5, '700');
  withSpacing(ctx, 1.4);
  ctx.textAlign = 'left';
  ctx.fillText(text.toUpperCase(), x, y);
  withSpacing(ctx, 0);
  ctx.strokeStyle = 'rgba(43,38,32,0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + 6);
  ctx.lineTo(x + width, y + 6);
  ctx.stroke();
  return y + 24;
}

function metaValue(ctx, label, value, x, y, maxWidth) {
  ctx.font = font(9, '400');
  ctx.fillStyle = DOC.dim;
  withSpacing(ctx, 0.8);
  ctx.textAlign = 'left';
  ctx.fillText(label.toUpperCase(), x, y);
  withSpacing(ctx, 0);
  ctx.font = font(12, '700');
  ctx.fillStyle = DOC.ink;
  const lines = wrapCanvasText(ctx, value || '—', maxWidth);
  ctx.fillText(lines[0] || '—', x, y + 17);
  if (lines.length > 1) {
    ctx.font = font(11, '400');
    ctx.fillText(lines[1], x, y + 32);
  }
  return y + 26;
}

function drawStamp(ctx, x, y, payload) {
  const adopted = payload.result === 'adopted';
  const color = adopted ? DOC.olive : DOC.brick;
  const text = adopted ? 'ПРИНЯТА' : 'ОТКЛОНЕНА';

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.14);
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = 'rgba(230,220,195,0.35)';
  ctx.fillRect(-140, -46, 280, 92);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.strokeRect(-140, -46, 280, 92);
  ctx.lineWidth = 1.2;
  ctx.strokeRect(-132, -38, 264, 76);

  ctx.fillStyle = color;
  ctx.font = `600 26px ${DISPLAY}`;
  withSpacing(ctx, 7);
  ctx.textAlign = 'center';
  ctx.fillText(text, 4, 4);
  withSpacing(ctx, 0);
  ctx.font = font(8.5);
  withSpacing(ctx, 1.6);
  ctx.fillText('АСАМБЛЕЯ ОМБ', 0, 25);
  ctx.fillText('ОФИЦИАЛЬНЫЙ ДОКУМЕНТ', 0, 37);
  withSpacing(ctx, 0);
  ctx.restore();
}

function drawVoteTable(ctx, x, y, width, payload) {
  const cols = [212, 74, width - 286];
  const fs = 11;
  const rowPad = 7;
  const rows = [
    { label: 'Поддержали', count: payload.tally.for, list: payload.tally.byVote.for, kind: 'for' },
    { label: 'Не поддержали', count: payload.tally.against, list: payload.tally.byVote.against, kind: 'against' },
    { label: 'Воздержались', count: payload.tally.abstain, list: payload.tally.byVote.abstain, kind: 'abstain' },
    { label: 'Не голосовали', count: payload.tally.notVoted, list: payload.tally.byVote.notVoted, kind: 'none' },
    {
      label: 'Принята с правками',
      count: payload.withAmendments ? `ДА (${payload.amendmentsCount})` : 'НЕТ',
      list: payload.withAmendments
        ? ['Принятые правки включены в текст резолюции.']
        : ['Правки не принимались.'],
      kind: 'amend',
      emphasize: true,
    },
  ];

  ctx.font = font(fs);
  const heights = rows.map((row) => {
    const text = row.list.length ? row.list.join(', ') : '—';
    const lines = wrapCanvasText(ctx, text, cols[2] - rowPad * 2);
    return Math.max(26, lines.length * 17 + rowPad * 2);
  });

  // Заголовок
  ctx.fillStyle = 'rgba(43,38,32,0.08)';
  ctx.fillRect(x, y, width, 24);
  ctx.strokeStyle = DOC.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, width - 1, 24);
  ctx.fillStyle = DOC.ink;
  ctx.font = font(9, '700');
  withSpacing(ctx, 0.8);
  ctx.textAlign = 'left';
  ctx.fillText('КАТЕГОРИЯ', x + rowPad, y + 16);
  ctx.fillText('ГОЛОСОВ', x + cols[0] + rowPad, y + 16);
  ctx.fillText('СТРАНЫ', x + cols[0] + cols[1] + rowPad, y + 16);
  withSpacing(ctx, 0);

  let cy = y + 24;
  rows.forEach((row, i) => {
    const h = heights[i];
    if (row.emphasize) {
      ctx.fillStyle = 'rgba(92,106,68,0.12)';
      ctx.fillRect(x, cy, width, h);
    }
    ctx.strokeStyle = DOC.line;
    ctx.strokeRect(x + 0.5, cy + 0.5, width - 1, h);
    ctx.beginPath();
    ctx.moveTo(x + cols[0], cy);
    ctx.lineTo(x + cols[0], cy + h);
    ctx.moveTo(x + cols[0] + cols[1], cy);
    ctx.lineTo(x + cols[0] + cols[1], cy + h);
    ctx.stroke();

    ctx.fillStyle = DOC.ink;
    ctx.font = font(11, row.emphasize ? '700' : '400');
    ctx.textAlign = 'left';
    ctx.fillText(fitText(ctx, row.label, cols[0] - rowPad * 2), x + rowPad, cy + 18);

    ctx.textAlign = 'center';
    const countX = x + cols[0] + cols[1] / 2;
    ctx.fillText(String(row.count), countX, cy + 18);

    ctx.textAlign = 'left';
    const text = row.list.length ? row.list.join(', ') : '—';
    const lines = wrapCanvasText(ctx, text, cols[2] - rowPad * 2);
    lines.forEach((line, li) => {
      ctx.fillText(line, x + cols[0] + cols[1] + rowPad, cy + 18 + li * 17);
    });

    cy += h;
  });

  return cy;
}

function drawResolutionDoc(ctx, payload, W, H, fs, maxBodyLines = Infinity) {
  const margin = 92;
  const width = W - margin * 2;
  let y = 62;

  const emblem = imageCacheResolved.get('assets/emblem.jpg');
  if (emblem) {
    const ew = 84;
    const eh = Math.round((emblem.height / emblem.width) * ew) || 62;
    ctx.drawImage(emblem, W / 2 - ew / 2, y, ew, eh);
    ctx.strokeStyle = 'rgba(43,38,32,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(W / 2 - ew / 2 - 0.5, y - 0.5, ew + 1, eh + 1);
    y += eh + 18;
  } else {
    y += 10;
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = DOC.ink;
  ctx.font = font(15, '700');
  withSpacing(ctx, 2.2);
  ctx.fillText('ОРГАНИЗАЦИЯ МИРОВОЙ БЕЗОПАСНОСТИ', W / 2, y);
  withSpacing(ctx, 0);
  y += 18;
  ctx.font = font(10.5);
  withSpacing(ctx, 6);
  ctx.fillStyle = DOC.dim;
  ctx.fillText('АСАМБЛЕЯ ОМБ', W / 2, y);
  withSpacing(ctx, 0);
  y += 18;

  ctx.strokeStyle = 'rgba(43,38,32,0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(margin, y);
  ctx.lineTo(W - margin, y);
  ctx.moveTo(margin, y + 4);
  ctx.lineTo(W - margin, y + 4);
  ctx.stroke();
  y += 30;

  ctx.fillStyle = DOC.ink;
  const title = `ДОКУМЕНТ ${payload.docNo} ${payload.result === 'adopted' ? 'О ПРИНЯТИИ' : 'ОБ ОТКЛОНЕНИИ'} РЕЗОЛЮЦИИ`;
  ctx.font = font(16.5, '700');
  withSpacing(ctx, 0.8);
  ctx.fillText(fitText(ctx, title, width), W / 2, y);
  withSpacing(ctx, 0);
  y += 18;
  ctx.font = font(10);
  ctx.fillStyle = DOC.dim;
  withSpacing(ctx, 1);
  ctx.fillText(`${payload.sessionName} · ${payload.sessionDateLabel}`, W / 2, y);
  withSpacing(ctx, 0);
  y += 26;

  // Метаданные
  const col2 = margin + 470;
  let metaY = y;
  metaValue(ctx, 'Резолюция №', payload.number, margin, metaY, 300);
  metaValue(ctx, 'Заседание', payload.sessionName, col2, metaY, 560);
  metaY += 34;
  metaValue(ctx, 'Дата', payload.sessionDateLabel, margin, metaY, 300);
  const topicLines = (() => {
    ctx.font = font(12, '700');
    return wrapCanvasText(ctx, payload.topic, 560);
  })();
  metaValue(ctx, 'Тема', topicLines[0], col2, metaY, 560);
  if (topicLines.length > 1) {
    ctx.font = font(11);
    ctx.fillStyle = DOC.ink;
    ctx.textAlign = 'left';
    ctx.fillText(fitText(ctx, topicLines.slice(1).join(' '), 560), col2, metaY + 32);
    metaY += 17;
  }
  metaY += 34;
  metaValue(ctx, 'Выдвинул(а)', `${payload.author.name}, ${payload.author.country}`, margin, metaY, 640);
  y = metaY + 42;

  ctx.strokeStyle = 'rgba(43,38,32,0.35)';
  ctx.beginPath();
  ctx.moveTo(margin, y - 16);
  ctx.lineTo(W - margin, y - 16);
  ctx.stroke();

  // Текст резолюции
  y = sectionLabel(ctx, margin, y + 4, width, 'Текст резолюции');
  ctx.font = font(fs);
  ctx.fillStyle = DOC.ink;
  ctx.textAlign = 'left';
  const lh = Math.round(fs * 1.72);
  let bodyLines = wrapCanvasText(ctx, payload.text || '—', width);
  let truncated = false;
  if (bodyLines.length > maxBodyLines) {
    bodyLines = bodyLines.slice(0, maxBodyLines);
    truncated = true;
  }
  for (const line of bodyLines) {
    ctx.fillText(line, margin, y);
    y += lh;
  }
  if (truncated) {
    ctx.font = font(10);
    ctx.fillStyle = DOC.dim;
    ctx.fillText('[Текст сокращён при экспорте — полная версия доступна в архиве.]', margin, y);
    y += 16;
  }
  y += 10;

  // Принятые правки
  y = sectionLabel(ctx, margin, y + 6, width, 'Принятые правки');
  if (!payload.amendments.length) {
    ctx.fillStyle = DOC.dim;
    ctx.font = font(11.5);
    ctx.fillText('Правки не принимались.', margin, y);
    y += 24;
  } else {
    ctx.font = font(11.5);
    ctx.fillStyle = DOC.ink;
    for (const amendment of payload.amendments) {
      const prefix = `${amendment.n}. `;
      ctx.font = font(11.5, '700');
      const prefixW = ctx.measureText(prefix).width;
      ctx.fillText(prefix, margin, y);
      ctx.font = font(11.5);
      const lines = wrapCanvasText(ctx, amendment.text, width - prefixW - 6);
      lines.forEach((line, i) => {
        ctx.fillText(line, margin + prefixW + (i === 0 ? 0 : 0), y + i * 19);
      });
      y += lines.length * 19;
      ctx.font = font(10);
      ctx.fillStyle = DOC.dim;
      ctx.fillText(`— предложил(а): ${amendment.author} (${amendment.country})`, margin + prefixW, y + 2);
      ctx.fillStyle = DOC.ink;
      y += 20;
    }
    y += 2;
  }

  // Таблица итогов
  y = sectionLabel(ctx, margin, y + 8, width, 'Итоги голосования');
  y = drawVoteTable(ctx, margin, y, width, payload);
  y += 12;

  ctx.font = font(10.5);
  ctx.fillStyle = DOC.dim;
  ctx.textAlign = 'left';
  ctx.fillText(
    `Кворум: ${payload.quorum.met ? 'соблюдён' : 'не соблюдён'} (присутствуют ${payload.quorum.present}, требуется ${payload.quorum.required}).`,
    margin,
    y,
  );
  y += 20;

  const resultText = payload.result === 'adopted'
    ? (payload.withAmendments
      ? `РЕЗУЛЬТАТ: РЕЗОЛЮЦИЯ ПРИНЯТА С ПРАВКАМИ (${payload.amendmentsCount})`
      : 'РЕЗУЛЬТАТ: РЕЗОЛЮЦИЯ ПРИНЯТА')
    : 'РЕЗУЛЬТАТ: РЕЗОЛЮЦИЯ ОТКЛОНЕНА';
  ctx.font = font(13, '700');
  withSpacing(ctx, 0.6);
  ctx.fillStyle = payload.result === 'adopted' ? DOC.olive : DOC.brick;
  ctx.fillText(resultText, margin, y);
  withSpacing(ctx, 0);
  y += 16;

  // Подписи президиума
  const signY = y + 46;
  const chairs = payload.chairs?.length
    ? payload.chairs
    : (payload.chairman ? [{ name: payload.chairman, role: 'Председатель' }] : []);
  const blocks = chairs.slice(0, 2);
  const blockW = 300;
  blocks.forEach((chair, i) => {
    const x = i === 0 ? margin : W - margin - blockW;
    ctx.textAlign = 'left';
    ctx.fillStyle = DOC.dim;
    ctx.font = font(9.5);
    withSpacing(ctx, 1);
    ctx.fillText(`${chair.role || 'Председатель'} Асамблеи ОМБ`.toUpperCase(), x, signY);
    withSpacing(ctx, 0);
    ctx.strokeStyle = 'rgba(43,38,32,0.75)';
    ctx.beginPath();
    ctx.moveTo(x, signY + 34);
    ctx.lineTo(x + blockW - 20, signY + 34);
    ctx.stroke();
    ctx.fillStyle = DOC.ink;
    ctx.font = font(11.5, '700');
    ctx.fillText(chair.name || '—', x, signY + 52);
    ctx.font = font(9.5);
    ctx.fillStyle = DOC.dim;
    ctx.fillText('подпись / расшифровка', x, signY + 66);
  });
  if (!blocks.length) {
    ctx.fillStyle = DOC.dim;
    ctx.font = font(10);
    ctx.fillText('Президиум не сформирован.', margin, signY + 34);
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = DOC.dim;
  ctx.font = font(9.5);
  ctx.fillText(`Дата: ${payload.sessionDateLabel}`, margin, signY + 88);

  drawStamp(ctx, W / 2, signY - 8, payload);

  // Нижний колонтитул
  ctx.font = font(8.5);
  ctx.fillStyle = DOC.dim;
  withSpacing(ctx, 1);
  ctx.strokeStyle = 'rgba(43,38,32,0.3)';
  ctx.beginPath();
  ctx.moveTo(margin, H - 58);
  ctx.lineTo(W - margin, H - 58);
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.fillText('СФОРМИРОВАН АВТОМАТИЧЕСКИ · АРХИВ АСАМБЛЕИ ОМБ', margin, H - 40);
  ctx.textAlign = 'right';
  ctx.fillText('ФОРМА А-1', W - margin, H - 40);
  withSpacing(ctx, 0);

  return signY + 110;
}

const imageCacheResolved = new Map();

export async function buildResolutionDocCanvas(payload, scale = 2) {
  await ensureFonts();
  const W = 1240;
  const H = 1754;
  const [emblem, texture] = await Promise.all([
    loadImage('assets/emblem.jpg'),
    loadImage('images/paper-texture.jpg'),
  ]);
  if (emblem) imageCacheResolved.set('assets/emblem.jpg', emblem);
  paperTexture = texture;

  const scratch = document.createElement('canvas');
  scratch.width = W;
  scratch.height = H;
  const sctx = scratch.getContext('2d');

  const fits = (fs, maxLines) => {
    drawPaper(sctx, W, H);
    const endY = drawResolutionDoc(sctx, payload, W, H, fs, maxLines);
    return endY <= H - 80;
  };

  let fs = 13;
  let maxLines = Infinity;
  let ok = false;
  for (const candidate of [13, 12.5, 12, 11.5, 11, 10.5]) {
    fs = candidate;
    if (fits(fs, maxLines)) { ok = true; break; }
  }
  if (!ok) {
    let limit = 60;
    while (limit > 6 && !fits(fs, limit)) limit -= 4;
    maxLines = limit;
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  drawPaper(ctx, W, H);
  drawResolutionDoc(ctx, payload, W, H, fs, maxLines);
  return canvas;
}

export async function downloadDocPng(payload) {
  const canvas = await buildResolutionDocCanvas(payload, 2);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const name = `OMB_документ_${fileNameSafe(payload.docNo)}.png`;
  if (blob) {
    const { downloadBlob } = await import('./utils.js');
    downloadBlob(blob, name);
  }
  return name;
}

/* ------------------------------------------------------------------ */
/* DOM-версия документа (просмотр и печать в PDF)                      */
/* ------------------------------------------------------------------ */

export function renderResolutionDocHTML(payload) {
  const adopted = payload.result === 'adopted';
  const chairs = payload.chairs?.length
    ? payload.chairs
    : (payload.chairman ? [{ name: payload.chairman, role: 'Председатель' }] : []);
  const countriesText = (list) => (list.length ? list.join(' · ') : '—');
  const amendmentsHTML = payload.amendments.length
    ? `<ol class="doc-amendments">${payload.amendments.map((a) => `
        <li><span class="num">${a.n}.</span>${esc(a.text)}
        <div class="proposer">— предложил(а): ${esc(a.author)} (${esc(a.country)})</div></li>`).join('')}
      </ol>`
    : '<div class="doc-text" style="color:#6b6154">Правки не принимались.</div>';

  return `
  <div class="paper-doc">
    <div class="doc-header">
      <img class="doc-emblem" src="assets/emblem.jpg" alt="Эмблема ОМБ">
      <div class="doc-org">Организация Мировой Безопасности</div>
      <div class="doc-org-sub">Асамблея ОМБ</div>
      <hr class="doc-rule">
    </div>

    <div class="doc-title">Документ ${esc(payload.docNo)}<br>
      ${adopted ? 'о принятии резолюции' : 'об отклонении резолюции'}</div>
    <div class="doc-title-sub">${esc(payload.sessionName)} · ${esc(payload.sessionDateLabel)}</div>

    <dl class="doc-meta">
      <dt>Резолюция №</dt><dd>${esc(payload.number)}</dd>
      <dt>Тема</dt><dd>${esc(payload.topic)}</dd>
      <dt>Выдвинул(а)</dt><dd>${esc(payload.author.name)}, ${esc(payload.author.country)}</dd>
      <dt>Президиум</dt><dd>${chairs.length
    ? chairs.map((c) => `${esc(c.name)} <span class="doc-chair-role">(${esc(c.role || 'Председатель')})</span>`).join('<br>')
    : '—'}</dd>
    </dl>
    <hr class="doc-rule single">

    <div class="doc-section-label">Текст резолюции</div>
    <div class="doc-text">${esc(payload.text)}</div>

    <div class="doc-section-label">Принятые правки</div>
    ${amendmentsHTML}

    <div class="doc-section-label">Итоги голосования</div>
    <table class="doc-table">
      <thead><tr><th>Категория</th><th>Голосов</th><th>Страны</th></tr></thead>
      <tbody>
        <tr><td>Поддержали</td><td class="c">${payload.tally.for}</td><td class="countries">${esc(countriesText(payload.tally.byVote.for))}</td></tr>
        <tr><td>Не поддержали</td><td class="c">${payload.tally.against}</td><td class="countries">${esc(countriesText(payload.tally.byVote.against))}</td></tr>
        <tr><td>Воздержались</td><td class="c">${payload.tally.abstain}</td><td class="countries">${esc(countriesText(payload.tally.byVote.abstain))}</td></tr>
        <tr><td>Не голосовали</td><td class="c">${payload.tally.notVoted}</td><td class="countries">${esc(countriesText(payload.tally.byVote.notVoted))}</td></tr>
        <tr style="background:rgba(92,106,68,.1);font-weight:700">
          <td>Принята с правками</td>
          <td class="c">${payload.withAmendments ? `ДА (${payload.amendmentsCount})` : 'НЕТ'}</td>
          <td class="countries">${payload.withAmendments
            ? 'Принятые правки включены в текст резолюции.'
            : 'Правки не принимались.'}</td>
        </tr>
      </tbody>
    </table>

    <div class="doc-quorum">Кворум: ${payload.quorum.met ? 'соблюдён' : 'не соблюдён'}
      (присутствуют ${payload.quorum.present}, требуется ${payload.quorum.required}).</div>

    <div class="doc-result-line ${adopted ? 'adopted' : 'rejected'}">
      ${adopted
        ? (payload.withAmendments
          ? `Результат: резолюция принята с правками (${payload.amendmentsCount})`
          : 'Результат: резолюция принята')
        : 'Результат: резолюция отклонена'}
    </div>

    <div class="doc-sign">
      ${chairs.length ? chairs.slice(0, 2).map((c) => `
        <div class="sign-block">
          <div class="sign-line"></div>
          <div class="sign-role">${esc(c.role || 'Председатель')} Асамблеи ОМБ</div>
          <div class="sign-name">${esc(c.name)}</div>
        </div>`).join('') : '<div class="sign-block"><div class="sign-role">Президиум не сформирован</div></div>'}
    </div>
    <div class="doc-sign-date">Дата: ${esc(payload.sessionDateLabel)}</div>

    <div class="doc-stamp ${adopted ? '' : 'rejected'}">${adopted ? 'Принята' : 'Отклонена'}
      <span class="st-sub">Асамблея ОМБ</span>
    </div>
    <div class="doc-stamp secret on-paper">Секретно<span class="st-sub">Для служебного пользования</span></div>
    <div class="doc-stamp archive on-paper">Архив<span class="st-sub">${esc(payload.docNo)}</span></div>

    <div class="doc-footer">
      <span>Сформирован автоматически · Архив Асамблеи ОМБ</span>
      <span>${esc(fmtDateTime(payload.createdAt))}</span>
    </div>
  </div>`;
}

export function sheetVoteLabel(vote) {
  return VOTE_RU[vote] || '—';
}

/* ------------------------------------------------------------------ */
/* Протокол заседания (DOM / печать / текст)                           */
/* ------------------------------------------------------------------ */

const EVENT_LABEL = {
  voting: 'Голосование',
  resolution: 'Резолюция',
  amendment: 'Правка',
  archive: 'Архив',
  session: 'Заседание',
  timer: 'Регламент',
  seat: 'Места',
  diplomat: 'Дипломаты',
  chairman: 'Президиум',
  speech: 'Слово',
  system: 'Система',
};

export function renderProtocolHTML(payload) {
  const chairs = payload.chairs || [];
  const entries = payload.entries || [];
  const duration = Math.max(0, (payload.generatedAt || Date.now()) - (payload.sessionStartedAt || Date.now()));
  return `
  <div class="paper-doc protocol-doc">
    <div class="doc-header">
      <img class="doc-emblem" src="assets/emblem.jpg" alt="Эмблема ОМБ">
      <div class="doc-org">Организация Мировой Безопасности</div>
      <div class="doc-org-sub">Асамблея ОМБ · Секретариат</div>
      <hr class="doc-rule">
    </div>

    <div class="doc-title">Протокол заседания ${esc(payload.docNo)}</div>
    <div class="doc-title-sub">${esc(payload.sessionName)} · ${esc(payload.sessionDateLabel)}</div>

    <dl class="doc-meta">
      <dt>Открыто</dt><dd>${esc(fmtDateTime(payload.sessionStartedAt))}</dd>
      <dt>Длительность</dt><dd>${esc(fmtDuration(duration))}</dd>
      <dt>Протокол составил</dt><dd>${esc(payload.preparedBy?.name || '—')} (${esc(payload.preparedBy?.country || '—')})</dd>
      <dt>Президиум</dt><dd>${chairs.length
    ? chairs.map((c) => `${esc(c.name)} — ${esc(c.role)}`).join('<br>')
    : '—'}</dd>
    </dl>
    <hr class="doc-rule single">

    <div class="doc-section-label">Состав и статистика</div>
    <table class="doc-table">
      <tbody>
        <tr><td>Зарегистрировано дипломатов</td><td class="c">${payload.stats?.diplomats ?? 0}</td></tr>
        <tr><td>Присутствовало в зале</td><td class="c">${payload.stats?.present ?? 0}</td></tr>
        <tr><td>Наблюдатели</td><td class="c">${payload.stats?.observers ?? 0}</td></tr>
        <tr><td>Резолюции (принято / отклонено)</td><td class="c">${payload.stats?.resolutions ?? 0} (${payload.stats?.adopted ?? 0} / ${payload.stats?.rejected ?? 0})</td></tr>
        <tr><td>Голосований · документов</td><td class="c">${payload.stats?.votings ?? 0} · ${payload.stats?.documents ?? 0}</td></tr>
        <tr><td>Сообщений в канале</td><td class="c">${payload.stats?.messages ?? 0}</td></tr>
      </tbody>
    </table>

    <div class="doc-section-label">Хроника заседания</div>
    ${entries.length ? `<div class="protocol-log">${entries.map((e) => `
      <div class="protocol-entry">
        <span class="pe-time">${esc(fmtTime(e.ts))}</span>
        <span class="pe-type">${esc(EVENT_LABEL[e.type] || e.type)}</span>
        <span class="pe-text">${esc(e.message)}</span>
      </div>`).join('')}</div>` : '<div class="doc-text">События не зафиксированы.</div>'}

    <div class="doc-sign">
      ${chairs.length ? chairs.slice(0, 2).map((c) => `
        <div class="sign-block">
          <div class="sign-line"></div>
          <div class="sign-role">${esc(c.role)} Асамблеи ОМБ</div>
          <div class="sign-name">${esc(c.name)}</div>
        </div>`).join('') : '<div class="sign-block"><div class="sign-role">Президиум не сформирован</div></div>'}
    </div>
    <div class="doc-sign-date">Дата: ${esc(payload.sessionDateLabel)}</div>

    <div class="doc-stamp archive on-paper">Архив<span class="st-sub">${esc(payload.docNo)}</span></div>
    <div class="doc-stamp secret on-paper">Секретно<span class="st-sub">Протокол заседания</span></div>

    <div class="doc-footer">
      <span>Сформирован в Асамблее ОМБ · ${esc(fmtDateTime(payload.generatedAt))}</span>
      <span>Форма П-1</span>
    </div>
  </div>`;
}

export function protocolText(payload) {
  const chairs = (payload.chairs || []).map((c) => `${c.role}: ${c.name}`).join('\n');
  const lines = [
    'АСАМБЛЕЯ ОМБ — ПРОТОКОЛ ЗАСЕДАНИЯ',
    `Документ: ${payload.docNo}`,
    `${payload.sessionName} · ${payload.sessionDateLabel}`,
    `Открыто: ${fmtDateTime(payload.sessionStartedAt)}`,
    `Составил: ${payload.preparedBy?.name || '—'} (${payload.preparedBy?.country || '—'})`,
    chairs,
    '',
    'ХРОНИКА:',
    ...(payload.entries || []).map((e) => `[${fmtTime(e.ts)}] ${EVENT_LABEL[e.type] || e.type}: ${e.message}`),
    '',
    'Сформировано автоматически · Архив Асамблеи ОМБ',
  ];
  return lines.join('\n');
}
