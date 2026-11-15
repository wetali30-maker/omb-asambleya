// Экспорт документов в DOCX (собственный OOXML-архив) и протокола в PNG.

import {
  fileNameSafe, downloadBlob, downloadDataUrl, wrapCanvasText,
  fmtDateTime, fmtTime, fmtDuration,
} from './utils.js';

const MONO = '"PT Mono", "Courier New", monospace';
const DISPLAY = '"Oswald", "Arial Narrow", Arial, sans-serif';

const EVENT_LABEL = {
  voting: 'Голосование',
  resolution: 'Резолюция',
  amendment: 'Правка',
  archive: 'Архив',
  session: 'Сессия',
  timer: 'Регламент',
  seat: 'Места',
  diplomat: 'Дипломаты',
  chairman: 'Президиум',
  speech: 'Слово',
  system: 'Система',
};

const XML_ESC = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const asBytes = (value) => (typeof value === 'string' ? new TextEncoder().encode(value) : value);

function u16(value) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, value, true);
  return b;
}

function u32(value) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value >>> 0, true);
  return b;
}

function joinBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// ZIP без сжатия (stored): достаточно для OOXML, внешних библиотек не требует.
function zipStore(files) {
  const entries = files.map(([name, content]) => {
    const nameBytes = asBytes(name);
    const data = asBytes(content);
    return { nameBytes, data, crc: crc32(data), offset: 0 };
  });

  const chunks = [];
  let offset = 0;
  for (const entry of entries) {
    entry.offset = offset;
    const local = joinBytes([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(entry.crc), u32(entry.data.length), u32(entry.data.length),
      u16(entry.nameBytes.length), u16(0), entry.nameBytes, entry.data,
    ]);
    chunks.push(local);
    offset += local.length;
  }

  const central = [];
  let centralSize = 0;
  for (const entry of entries) {
    const header = joinBytes([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(entry.crc), u32(entry.data.length), u32(entry.data.length),
      u16(entry.nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(entry.offset), entry.nameBytes,
    ]);
    central.push(header);
    centralSize += header.length;
  }

  const end = joinBytes([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralSize), u32(offset), u16(0),
  ]);

  return new Blob([...chunks, ...central, end], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

function docxPackage(bodyXml) {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

  return zipStore([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rels],
    ['word/document.xml', documentXml],
  ]);
}

function docxPara(text, {
  bold = false, italic = false, caps = false, size = 22, align = 'both',
  color = '1f1a14', spaceAfter = 100, spaceBefore = 0,
} = {}) {
  const props = '<w:rPr><w:rFonts w:ascii="PT Mono" w:hAnsi="PT Mono" w:cs="PT Mono"/>'
    + `${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}${caps ? '<w:caps/>' : ''}`
    + `<w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>`;
  const runs = String(text ?? '').split('\n').map((line, index) => (
    `${index ? '<w:br/>' : ''}<w:t xml:space="preserve">${XML_ESC(line)}</w:t>`
  )).join('');
  return `<w:p><w:pPr><w:spacing w:after="${spaceAfter}" w:before="${spaceBefore}" w:line="264" w:lineRule="auto"/><w:jc w:val="${align}"/>${props}</w:pPr><w:r>${props}${runs}</w:r></w:p>`;
}

function docxRule() {
  return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="8a7c69"/></w:pBdr><w:spacing w:after="120"/></w:pPr></w:p>';
}

function docxTable(rows, { header = false } = {}) {
  const border = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="a89b86"/>`;
  const tablePr = `<w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders></w:tblPr>`;
  const body = rows.map((row, rowIndex) => `<w:tr>${row.map((cell) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${docxPara(cell, {
    bold: header && rowIndex === 0,
    size: 18,
    spaceAfter: 20,
    align: rowIndex === 0 ? 'center' : 'left',
  })}</w:tc>`).join('')}</w:tr>`).join('');
  return `<w:tbl>${tablePr}${body}</w:tbl>${docxPara('', { size: 8, spaceAfter: 60 })}`;
}

function docxHeader() {
  return docxPara('ОРГАНИЗАЦИЯ МИРОВОЙ БЕЗОПАСНОСТИ', { bold: true, size: 18, align: 'center', color: '6b5a3e', spaceAfter: 20 })
    + docxPara('Асамблея ОМБ · Секретариат', { size: 16, align: 'center', color: '6b5a3e', spaceAfter: 30 })
    + docxRule();
}

function docxSignatures(chairs, dateText) {
  const list = (chairs || []).slice(0, 2);
  const blocks = list.length
    ? list.map((c) => docxPara('________________________', { size: 18, align: 'left', spaceAfter: 10 })
      + docxPara(`${c.role || 'Председатель'} Асамблеи ОМБ`, { size: 16, color: '555555', align: 'left', spaceAfter: 4 })
      + docxPara(c.name, { bold: true, size: 18, align: 'left', spaceAfter: 120 })).join('')
    : docxPara('Президиум не сформирован', { size: 16, color: '555555', spaceAfter: 120 });
  return docxPara('', { size: 10, spaceAfter: 60 })
    + blocks
    + docxPara(`Дата: ${dateText}`, { size: 16, align: 'right', color: '555555', spaceAfter: 20 })
    + docxPara('Сформировано автоматически · Архив Асамблеи ОМБ · Секретно', { size: 14, align: 'center', color: '7a6d5c' });
}

export function downloadResolutionDocx(payload) {
  const adopted = payload.result === 'adopted';
  const chairs = payload.chairs?.length
    ? payload.chairs
    : (payload.chairman ? [{ name: payload.chairman, role: 'Председатель' }] : []);
  const countries = (list) => (list?.length ? list.join(' · ') : '—');
  const tally = payload.tally || { for: 0, against: 0, abstain: 0, notVoted: 0, byVote: {} };
  const byVote = tally.byVote || {};

  let body = docxHeader();
  body += docxPara(`Документ ${payload.docNo}`, { bold: true, size: 30, align: 'center', spaceAfter: 20 });
  body += docxPara(adopted ? 'о принятии резолюции' : 'об отклонении резолюции', { size: 22, align: 'center', spaceAfter: 40 });
  body += docxPara(`${payload.sessionName} · ${payload.sessionDateLabel}`, { size: 17, align: 'center', color: '555555', spaceAfter: 140 });
  body += docxPara(`Резолюция № ${payload.number}   ·   Тема: ${payload.topic}`, { size: 19, bold: true, spaceAfter: 40 });
  body += docxPara(`Выдвинул(а): ${payload.author?.name || '—'}, ${payload.author?.country || '—'}`, { size: 18, spaceAfter: 30 });
  body += docxPara(`Президиум: ${chairs.length ? chairs.map((c) => `${c.name} (${c.role || 'Председатель'})`).join('; ') : '—'}`, { size: 18, spaceAfter: 120 });
  body += docxPara('ТЕКСТ РЕЗОЛЮЦИИ', { bold: true, size: 18, caps: true, color: '6b5a3e', spaceAfter: 40 });
  body += docxPara(payload.text || '—', { size: 20, align: 'both', spaceAfter: 140 });
  body += docxPara('ПРИНЯТЫЕ ПРАВКИ', { bold: true, size: 18, caps: true, color: '6b5a3e', spaceAfter: 40 });
  if (payload.amendments?.length) {
    body += payload.amendments.map((a) => docxPara(`${a.n}. ${a.text}`, { size: 19, spaceAfter: 20 })
      + docxPara(`— предложил(а): ${a.author} (${a.country})`, { size: 16, color: '555555', spaceAfter: 60 })).join('');
  } else {
    body += docxPara('Правки не принимались.', { size: 18, color: '555555', spaceAfter: 100 });
  }
  body += docxPara('ИТОГИ ГОЛОСОВАНИЯ', { bold: true, size: 18, caps: true, color: '6b5a3e', spaceAfter: 40 });
  body += docxTable([
    ['Категория', 'Голосов', 'Страны'],
    ['Поддержали', String(tally.for ?? 0), countries(byVote.for)],
    ['Не поддержали', String(tally.against ?? 0), countries(byVote.against)],
    ['Воздержались', String(tally.abstain ?? 0), countries(byVote.abstain)],
    ['Не голосовали', String(tally.notVoted ?? 0), countries(byVote.notVoted)],
  ], { header: true });
  body += docxPara(`Кворум: ${payload.quorum?.met ? 'соблюдён' : 'не соблюдён'} (присутствуют ${payload.quorum?.present ?? 0}, требуется ${payload.quorum?.required ?? 0}).`, { size: 18, spaceAfter: 60 });
  body += docxPara(
    adopted
      ? (payload.withAmendments ? `Результат: резолюция принята с правками (${payload.amendmentsCount}).` : 'Результат: резолюция принята.')
      : 'Результат: резолюция отклонена.',
    { bold: true, size: 20, spaceAfter: 200 },
  );
  body += docxSignatures(chairs, payload.sessionDateLabel);

  const name = `OMB_документ_${fileNameSafe(payload.docNo)}.docx`;
  downloadBlob(docxPackage(body), name);
  return name;
}

export function downloadProtocolDocx(payload) {
  const chairs = payload.chairs || [];
  const entries = payload.entries || [];
  const stats = payload.stats || {};
  const duration = Math.max(0, (payload.generatedAt || Date.now()) - (payload.sessionStartedAt || Date.now()));

  let body = docxHeader();
  body += docxPara(`Протокол заседания ${payload.docNo}`, { bold: true, size: 28, align: 'center', spaceAfter: 20 });
  body += docxPara(`${payload.sessionName} · ${payload.sessionDateLabel}`, { size: 17, align: 'center', color: '555555', spaceAfter: 140 });
  body += docxPara(`Открыто: ${fmtDateTime(payload.sessionStartedAt)}`, { size: 18, spaceAfter: 20 });
  body += docxPara(`Длительность: ${fmtDuration(duration)}`, { size: 18, spaceAfter: 20 });
  body += docxPara(`Составил: ${payload.preparedBy?.name || '—'} (${payload.preparedBy?.country || '—'})`, { size: 18, spaceAfter: 20 });
  body += docxPara(`Президиум: ${chairs.length ? chairs.map((c) => `${c.name} — ${c.role}`).join('; ') : '—'}`, { size: 18, spaceAfter: 120 });
  body += docxPara('СОСТАВ И СТАТИСТИКА', { bold: true, size: 18, caps: true, color: '6b5a3e', spaceAfter: 40 });
  body += docxTable([
    ['Показатель', 'Значение'],
    ['Зарегистрировано дипломатов', String(stats.diplomats ?? 0)],
    ['Присутствовало в зале', String(stats.present ?? 0)],
    ['Наблюдатели', String(stats.observers ?? 0)],
    ['Резолюции (принято / отклонено)', `${stats.resolutions ?? 0} (${stats.adopted ?? 0} / ${stats.rejected ?? 0})`],
    ['Голосований · документов', `${stats.votings ?? 0} · ${stats.documents ?? 0}`],
    ['Сообщений в канале', String(stats.messages ?? 0)],
  ], { header: true });
  body += docxPara('ХРОНИКА ЗАСЕДАНИЯ', { bold: true, size: 18, caps: true, color: '6b5a3e', spaceAfter: 40 });
  if (entries.length) {
    body += entries.map((e) => docxPara(
      `[${fmtTime(e.ts)}] ${EVENT_LABEL[e.type] || e.type}: ${e.message}`,
      { size: 17, spaceAfter: 30, align: 'left' },
    )).join('');
  } else {
    body += docxPara('События не зафиксированы.', { size: 18, color: '555555', spaceAfter: 100 });
  }
  body += docxSignatures(chairs, payload.sessionDateLabel);

  const name = `OMB_протокол_${fileNameSafe(payload.docNo)}.docx`;
  downloadBlob(docxPackage(body), name);
  return name;
}

export async function downloadProtocolPng(payload) {
  try {
    await document.fonts.ready;
    await Promise.all([
      document.fonts.load('14px "PT Mono"'),
      document.fonts.load('600 14px "Oswald"'),
    ]);
  } catch { /* шрифт не критичен */ }

  const W = 1240;
  const margin = 84;
  const maxWidth = W - margin * 2;
  const chairs = payload.chairs || [];
  const entries = payload.entries || [];
  const stats = payload.stats || {};
  const duration = Math.max(0, (payload.generatedAt || Date.now()) - (payload.sessionStartedAt || Date.now()));

  const measure = document.createElement('canvas').getContext('2d');
  const blocks = [];
  const push = (text, opts = {}) => blocks.push({ text, h: 24, ...opts });
  const pushWrapped = (text, opts = {}, fontSpec = null, lineHeight = 24) => {
    measure.font = fontSpec || `400 14px ${MONO}`;
    for (const line of wrapCanvasText(measure, text, maxWidth - (opts.indent || 0))) {
      blocks.push({ ...opts, text: line, h: lineHeight, font: fontSpec || `400 14px ${MONO}`, size: opts.size || 14 });
    }
  };

  push('ОРГАНИЗАЦИЯ МИРОВОЙ БЕЗОПАСНОСТИ', { size: 14, weight: '700', color: '#6b5a3e', align: 'center', h: 26, font: DISPLAY, spacing: 2 });
  push('АСАМБЛЕЯ ОМБ · СЕКРЕТАРИАТ', { size: 13, color: '#6b5a3e', align: 'center', h: 28, font: DISPLAY });
  push('', { h: 18 });
  push(`ПРОТОКОЛ ЗАСЕДАНИЯ ${payload.docNo}`, { size: 30, weight: '600', align: 'center', h: 46, font: DISPLAY, color: '#1f1a14' });
  push(`${payload.sessionName} · ${payload.sessionDateLabel}`, { size: 15, align: 'center', h: 40, color: '#4a4034' });
  push('', { h: 14 });
  for (const line of [
    `Открыто: ${fmtDateTime(payload.sessionStartedAt)}`,
    `Длительность: ${fmtDuration(duration)}`,
    `Составил: ${payload.preparedBy?.name || '—'} (${payload.preparedBy?.country || '—'})`,
    `Президиум: ${chairs.length ? chairs.map((c) => `${c.name} — ${c.role}`).join('; ') : '—'}`,
  ]) pushWrapped(line, { color: '#332b22' }, `400 14px ${MONO}`, 26);
  push('', { h: 12 });
  push('СОСТАВ И СТАТИСТИКА', { size: 12, weight: '700', color: '#6b5a3e', h: 32, font: DISPLAY, spacing: 1.5 });
  for (const [label, value] of [
    ['Зарегистрировано дипломатов', stats.diplomats ?? 0],
    ['Присутствовало в зале', stats.present ?? 0],
    ['Наблюдатели', stats.observers ?? 0],
    ['Резолюции (принято / отклонено)', `${stats.resolutions ?? 0} (${stats.adopted ?? 0} / ${stats.rejected ?? 0})`],
    ['Голосований · документов', `${stats.votings ?? 0} · ${stats.documents ?? 0}`],
    ['Сообщений в канале', stats.messages ?? 0],
  ]) push(`${label}:  ${value}`, { size: 14, h: 24, color: '#332b22', font: `400 14px ${MONO}` });
  push('', { h: 12 });
  push('ХРОНИКА ЗАСЕДАНИЯ', { size: 12, weight: '700', color: '#6b5a3e', h: 32, font: DISPLAY, spacing: 1.5 });
  if (entries.length) {
    entries.forEach((e) => pushWrapped(
      `[${fmtTime(e.ts)}] ${EVENT_LABEL[e.type] || e.type}: ${e.message}`,
      { size: 13, color: '#2b241c' },
      `400 13px ${MONO}`,
      22,
    ));
  } else {
    pushWrapped('События не зафиксированы.', { color: '#555555' }, `400 14px ${MONO}`, 26);
  }
  push('', { h: 26 });
  push('______________________________', { size: 15, h: 26, color: '#332b22', font: `400 15px ${MONO}` });
  const blocksHeight = blocks.reduce((sum, b) => sum + (b.h || 24), 0);
  const H = Math.max(900, 120 + blocksHeight + 80);

  const canvas = document.createElement('canvas');
  const scale = 2;
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#f3ead8';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(120, 104, 80, .05)';
  for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);
  ctx.strokeStyle = 'rgba(120, 104, 80, .35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(margin / 2, margin / 2, W - margin, H - margin);

  let y = margin + 6;
  for (const block of blocks) {
    ctx.font = `${block.weight || '400'} ${block.size || 14}px ${block.font || MONO}`;
    ctx.fillStyle = block.color || '#2b241c';
    ctx.textAlign = block.align || 'left';
    try { ctx.letterSpacing = `${block.spacing || 0}px`; } catch { /* не поддерживается */ }
    const x = block.align === 'center' ? W / 2 : margin;
    if (block.text) ctx.fillText(block.text, x, y + (block.h || 24) - 9);
    y += block.h || 24;
  }
  try { ctx.letterSpacing = '0px'; } catch { /* noop */ }

  const name = `OMB_протокол_${fileNameSafe(payload.docNo)}.png`;
  downloadDataUrl(canvas.toDataURL('image/png'), name);
  return name;
}
