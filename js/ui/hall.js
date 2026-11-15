// Схема зала: вид сверху, 12–80 мест, президиум из двух кресел, часы, сводка.

import { get, SEAT_DEFAULT } from '../store.js';
import {
  openVoting, chairmanAt, quorumInfo, currentSpeaker, isSeatedChairman, chairSlotLabel,
  tallyFor,
} from '../rules.js';
import {
  $, esc, pad2, truncate, initials, icon, dateLabel,
} from '../utils.js';
import { getImageUrl } from '../idb.js';
import { toast } from './modal.js';
import { openSeatPicker, openDiplomatCard, openChairmanPicker } from './diplomats.js';
import { openLiveSheet, openLatestSheet } from './viewers.js';

// Дуги вокруг центра, вынесенного вниз за пределы сцены.
const HALL = { width: 1200, height: 800, center: { x: 600, y: 1260 } };

const CHAIR_X = { 1: 470, 2: 730 };
const CHAIR_Y = 752;

const VOTE_FILL = {
  for: '#7d8a5e',
  against: '#8e4640',
  abstain: '#b08d4f',
};

let renderSeq = 0;
let zoom = 1;

function seatRows(total) {
  const count = Math.max(12, Math.min(80, Number(total) || SEAT_DEFAULT));
  const radii = count <= 52 ? [700, 800, 900, 1000] : [620, 710, 810, 910, 1010];
  const base = Math.floor(count / radii.length);
  const extra = count - base * radii.length;
  return radii.map((radius, idx) => {
    const rowCount = base + (idx < extra ? 1 : 0);
    return { radius, count: rowCount, spread: Math.min(58, 4 * (rowCount - 1)) };
  });
}

function seatPositions(total) {
  const seats = [];
  let n = 0;
  for (const row of seatRows(total)) {
    for (let i = 0; i < row.count; i += 1) {
      const t = row.count === 1 ? 0.5 : i / (row.count - 1);
      const angle = (-row.spread + t * row.spread * 2) * (Math.PI / 180);
      seats.push({
        id: `s${pad2((n += 1))}`,
        x: +(HALL.center.x + row.radius * Math.sin(angle)).toFixed(1),
        y: +(HALL.center.y - row.radius * Math.cos(angle)).toFixed(1),
      });
    }
  }
  return seats;
}

function seatMarkup(seat, diplomat, {
  voting, activeId, avatarUrl, speakerId, queueIds,
}) {
  const empty = !diplomat;
  const classes = ['seat'];
  if (empty) classes.push('empty');
  if (diplomat?.role === 'observer') classes.push('observer');
  if (diplomat?.id === activeId) classes.push('me');
  if (diplomat?.id === speakerId) classes.push('speaking');

  const desk = `
    <rect class="seat-desk" x="-21" y="1" width="42" height="15" rx="3"></rect>
    <rect class="seat-plate" x="-15" y="2.4" width="30" height="8.2" rx="1"></rect>
    <text class="seat-desk-num" x="0" y="6.9">№${pad2(Number(seat.id.slice(1)))}</text>`;

  const chair = `<rect class="seat-chair" x="-15" y="-19" width="30" height="22" rx="7"></rect>`;

  let person = '';
  if (diplomat) {
    const ring = `<circle class="avatar-ring" cx="0" cy="-8" r="14"></circle>`;
    const face = avatarUrl
      ? `<clipPath id="clip-${seat.id}"><circle cx="0" cy="-8" r="12.5"></circle></clipPath>
         <image href="${esc(avatarUrl)}" x="-12.5" y="-20.5" width="25" height="25"
                clip-path="url(#clip-${seat.id})" preserveAspectRatio="xMidYMid slice"></image>`
      : `<text class="avatar-initials" x="0" y="-8">${esc(initials(diplomat.fullName))}</text>`;

    let dot = '';
    if (voting && diplomat.canVote && diplomat.role !== 'observer') {
      const ballot = voting.ballots?.[diplomat.country];
      if (ballot) {
        dot = `<circle class="vote-dot" cx="13" cy="-18" r="4.4" fill="${VOTE_FILL[ballot.vote]}"></circle>`;
      } else {
        dot = `<circle class="vote-dot" cx="13" cy="-18" r="4.4" fill="#2a221c" stroke="#8a7c69"></circle>`;
      }
    }

    const activeRing = diplomat.id === activeId
      ? `<circle cx="0" cy="-8" r="18" fill="none" stroke="#b2965f" stroke-width="1.2" stroke-dasharray="2 3"></circle>`
      : '';

    const speakingMark = diplomat.id === speakerId
      ? `<text class="speak-mark" y="-31">${esc('СЛОВО')}</text>`
      : queueIds?.has(diplomat.id)
        ? `<text class="speak-mark" y="-31" opacity=".65">${esc('В ОЧЕРЕДИ')}</text>`
        : '';

    person = `
      ${ring}${face}${dot}${activeRing}${speakingMark}
      <text class="seat-name" y="28">${esc(truncate(diplomat.fullName, 19))}</text>`;
  } else {
    person = `<text class="seat-num" x="0" y="-4" text-anchor="middle">свободно</text>`;
  }

  return `
    <g class="${classes.join(' ')}" transform="translate(${seat.x} ${seat.y})"
       data-seat="${seat.id}" ${diplomat ? `data-diplomat="${diplomat.id}"` : ''}
       ${diplomat ? `<title>${esc(`${diplomat.fullName} — ${diplomat.country}${diplomat.role === 'observer' ? ' (наблюдатель)' : ''}`)}</title>` : '<title>Свободное место</title>'}>
      ${chair}${desk}${person}
    </g>`;
}

function chairSlotMarkup(state, slot, avatars) {
  const chair = chairmanAt(state, slot);
  const activeId = state.activeDiplomatId;
  const x = CHAIR_X[slot];
  const avatarUrl = chair ? avatars[chair.id] : null;
  const seated = chair && isSeatedChairman(chair);

  if (!chair) {
    return `
      <g class="chair-seat chair-hover" data-chair-vacant="${slot}" style="cursor:pointer">
        <title>${slot === 2 ? 'Сопредседатель' : 'Председатель'} не назначен</title>
        <rect class="chair-plate-brass" x="${x - 62}" y="706" width="124" height="16" rx="2"></rect>
        <text class="chair-plate-text" x="${x}" y="717">${slot === 2 ? 'СОПРЕДСЕДАТЕЛЬ' : 'ПРЕДСЕДАТЕЛЬ'}</text>
        <circle class="chair-empty" cx="${x}" cy="${CHAIR_Y}" r="22"></circle>
        <text class="chair-empty-label" x="${x}" y="${CHAIR_Y + 2}">место свободно</text>
        <text class="chair-empty-label" x="${x}" y="${CHAIR_Y + 30}">назначить — нажмите</text>
      </g>`;
  }

  return `
    <g class="chair-seat chair-hover" data-chair-di="${chair.id}" data-chair-slot="${slot}" style="cursor:pointer">
      <title>${esc(`${chair.fullName} — ${chair.country} · ${chairSlotLabel(slot)}`)}</title>
      <rect class="chair-plate-brass" x="${x - 66}" y="706" width="132" height="16" rx="2"></rect>
      <text class="chair-plate-text" x="${x}" y="717">${slot === 2 ? 'СОПРЕДСЕДАТЕЛЬ' : 'ПРЕДСЕДАТЕЛЬ'}${seated ? '' : ' · ВНЕ КРЕСЛА'}</text>
      <circle class="avatar-ring ${seated ? '' : 'observer'}" cx="${x}" cy="${CHAIR_Y}" r="22"></circle>
      ${avatarUrl
    ? `<clipPath id="clip-chair-${slot}"><circle cx="${x}" cy="${CHAIR_Y}" r="19.5"></circle></clipPath>
           <image href="${esc(avatarUrl)}" x="${x - 19.5}" y="${CHAIR_Y - 19.5}" width="39" height="39"
                  clip-path="url(#clip-chair-${slot})" preserveAspectRatio="xMidYMid slice"></image>`
    : `<text class="avatar-initials" x="${x}" y="${CHAIR_Y}">${esc(initials(chair.fullName))}</text>`}
      ${chair.id === activeId ? `<circle cx="${x}" cy="${CHAIR_Y}" r="27" fill="none" stroke="#b2965f" stroke-width="1.2" stroke-dasharray="2 3"></circle>` : ''}
      <text class="seat-name chair-name" x="${x}" y="${CHAIR_Y + 34}">${esc(truncate(chair.fullName, 24))}</text>
      <text class="chair-role-sub chair-country" x="${x}" y="${CHAIR_Y + 47}">${esc(chair.country)}</text>
    </g>`;
}

function presidiumZone(state, voting, avatars) {
  const q = quorumInfo(state);
  const sheetInfo = (() => {
    if (voting) {
      const t = tallyFor(voting, state);
      return {
        label: 'ГОЛОСОВАНИЕ ИДЁТ',
        line1: `ЗА ${t.for} · ПРОТИВ ${t.against} · ВОЗД. ${t.abstain}`,
        line2: 'нажмите, чтобы открыть сводку',
      };
    }
    const sheet = state.archive.filter((d) => d.kind === 'ballot-sheet')[0];
    if (sheet) {
      return {
        label: 'СВОДКА ИТОГОВ ГОЛОСОВАНИЯ',
        line1: `Резолюция № ${sheet.number}`,
        line2: 'нажмите, чтобы открыть лист',
      };
    }
    return {
      label: 'СВОДКА ИТОГОВ ГОЛОСОВАНИЯ',
      line1: 'лист ещё не сформирован',
      line2: 'проводится после голосования',
    };
  })();

  return `
    <g class="presidium-zone">
      <rect class="chair-desk" x="392" y="640" width="416" height="66" rx="7"></rect>
      <rect class="chair-desk-shade" x="392" y="640" width="416" height="66" rx="7"></rect>
      <rect class="chair-edge" x="400" y="647" width="400" height="52" rx="4"></rect>
      <text class="chair-label" x="600" y="632">ПРЕЗИДИУМ АСАМБЛЕИ</text>
      <text class="chair-role-sub" x="600" y="698">ПРЕДСЕДАТЕЛЬ · СОПРЕДСЕДАТЕЛЬ · РЕГЛАМЕНТ · ГОЛОСОВАНИЯ</text>

      <g class="desk-sheet" data-sheet-click="1">
        <title>Сводка итогов голосования</title>
        <g transform="translate(600 668) rotate(-1.2)">
          <rect class="sheet-paper" x="-106" y="-22" width="212" height="44" rx="1"></rect>
          <text class="sheet-label" y="-11">${esc(sheetInfo.label)}</text>
          <line x1="-90" y1="-5" x2="90" y2="-5" stroke="#b5a88e" stroke-width=".5"></line>
          <text class="sheet-empty" y="4">${esc(sheetInfo.line1)}</text>
          <text class="sheet-empty" y="14" opacity=".72">${esc(sheetInfo.line2)}</text>
        </g>
      </g>

      <g class="gavel" transform="translate(438 660) rotate(-18)" opacity=".55">
        <line x1="-12" y1="10" x2="6" y2="-8"></line>
        <rect x="2" y="-14" width="16" height="10" rx="2"></rect>
      </g>
      <text class="chair-role-sub" x="1084" y="724" text-anchor="end">КВОРУМ ${q.present}/${q.total} · НУЖНО ${q.required}</text>

      ${chairSlotMarkup(state, 1, avatars)}
      ${chairSlotMarkup(state, 2, avatars)}
    </g>`;
}

function wallClock() {
  return `
    <g transform="translate(1076 46)" class="wall-clock-group">
      <rect class="wall-panel" x="-34" y="-32" width="68" height="66" rx="3"></rect>
      <circle class="wall-clock" cx="0" cy="-2" r="20"></circle>
      <circle cx="0" cy="-2" r="1.4" fill="#3a2f24"></circle>
      <line class="wall-clock-tick" x1="0" y1="-19" x2="0" y2="-16"></line>
      <line class="wall-clock-tick" x1="0" y1="12" x2="0" y2="15"></line>
      <line class="wall-clock-tick" x1="-17" y1="-2" x2="-14" y2="-2"></line>
      <line class="wall-clock-tick" x1="14" y1="-2" x2="17" y2="-2"></line>
      <line id="wall-hour" class="wall-clock-hand" x1="0" y1="2" x2="0" y2="-9" transform="rotate(300)"></line>
      <line id="wall-minute" class="wall-clock-hand" x1="0" y1="3" x2="0" y2="-14" transform="rotate(60)"></line>
      <line id="wall-second" x1="0" y1="4" x2="0" y2="-15" stroke="#8d453f" stroke-width=".7" transform="rotate(180)"></line>
      <text class="wall-sub" y="30" style="font-size:4.4px;letter-spacing:.12em">ВРЕМЯ ЗАСЕДАНИЯ</text>
    </g>`;
}

export async function renderHall() {
  const host = $('#hall-stage');
  if (!host) return;

  const seq = (renderSeq += 1);
  const state = get();
  const voting = openVoting(state);
  const avatars = {};
  await Promise.all(state.diplomats.map(async (d) => {
    avatars[d.id] = await getImageUrl(d.avatarId);
  }));
  if (seq !== renderSeq) return;

  const seated = state.diplomats.filter((d) => d.seatId && !String(d.seatId).startsWith('chair'));
  const occupiedBySeat = new Map(seated.map((d) => [d.seatId, d]));
  const seatTotal = Number(state.settings?.seatCount) || SEAT_DEFAULT;
  const seats = seatPositions(seatTotal);
  const speaker = currentSpeaker(state);
  const queueIds = new Set(
    (state.speeches || []).filter((s) => s.status === 'waiting').map((s) => s.diplomatId),
  );

  const seatSvg = seats.map((s) => seatMarkup(s, occupiedBySeat.get(s.id), {
    voting,
    activeId: state.activeDiplomatId,
    avatarUrl: avatars[occupiedBySeat.get(s.id)?.id],
    speakerId: speaker?.diplomatId,
    queueIds,
  })).join('');

  host.innerHTML = `
    <div class="hall-zoom" id="hall-zoom">
      <svg class="hall-svg" viewBox="0 0 ${HALL.width} ${HALL.height}"
           preserveAspectRatio="xMidYMid meet" role="img" aria-label="Схема зала Ассамблеи ОМБ">
        <defs>
          <radialGradient id="floorGrad" cx="50%" cy="118%" r="88%">
            <stop offset="0%" stop-color="#4a3d31"></stop>
            <stop offset="58%" stop-color="#332a22"></stop>
            <stop offset="100%" stop-color="#241c17"></stop>
          </radialGradient>
          <linearGradient id="wallGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#4b3d31"></stop>
            <stop offset="100%" stop-color="#2d251f"></stop>
          </linearGradient>
          <linearGradient id="deskGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#514337"></stop>
            <stop offset="100%" stop-color="#3b3027"></stop>
          </linearGradient>
          <linearGradient id="brassGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#d8bf86"></stop>
            <stop offset="55%" stop-color="#b2965f"></stop>
            <stop offset="100%" stop-color="#8d7345"></stop>
          </linearGradient>
          <pattern id="chairWood" width="260" height="160" patternUnits="userSpaceOnUse">
            <image href="images/wood-dark.jpg" width="260" height="160" preserveAspectRatio="xMidYMid slice"></image>
          </pattern>
        </defs>

        <rect x="0" y="0" width="${HALL.width}" height="${HALL.height}" fill="url(#floorGrad)" opacity=".62"></rect>

        <g class="back-wall">
          <rect x="0" y="0" width="${HALL.width}" height="94" fill="url(#wallGrad)" opacity=".66"></rect>
          <line x1="0" y1="94" x2="${HALL.width}" y2="94" stroke="#6a5a47" stroke-width="1"></line>
          <rect class="banner-flag" x="34" y="14" width="34" height="68" rx="1"></rect>
          <rect class="banner-flag" x="80" y="14" width="34" height="68" rx="1" opacity=".75"></rect>
          <rect class="banner-flag" x="1086" y="14" width="34" height="68" rx="1"></rect>
          <rect class="banner-flag" x="1040" y="14" width="34" height="68" rx="1" opacity=".75"></rect>
        </g>

        ${wallClock()}

        <image href="assets/emblem.svg" x="452" y="240" width="296" height="296" opacity=".05"></image>

        <circle class="floor-line" cx="600" cy="1260" r="660"></circle>
        <circle class="floor-line" cx="600" cy="1260" r="1050"></circle>

        <text class="wall-title" x="600" y="54">АСАМБЛЕЯ ОМБ</text>
        <text class="wall-sub" x="600" y="74">ОРГАНИЗАЦИЯ МИРОВОЙ БЕЗОПАСНОСТИ · ЗАЛ ЗАСЕДАНИЙ</text>

        ${seatSvg}
        ${presidiumZone(state, voting, avatars)}
      </svg>
    </div>
    <div class="hall-secret">Секретно<small>только для делегаций</small></div>
    <div class="hall-plate">${esc(state.settings.sessionName)} · ${esc(dateLabel(state.settings.sessionDate))}</div>`;

  applyZoom();
  renderLegend(state, voting, speaker);
  bindHall(host);
}

function bindHall(host) {
  const svg = host.querySelector('.hall-svg');
  if (!svg) return;
  svg.addEventListener('click', (event) => {
    if (event.target.closest('[data-sheet-click]')) {
      const current = openVoting(get());
      if (current) openLiveSheet(current.id);
      else openLatestSheet();
      return;
    }
    const vacant = event.target.closest('[data-chair-vacant]');
    if (vacant) {
      openChairmanPicker(Number(vacant.dataset.chairVacant));
      return;
    }
    const chairEl = event.target.closest('[data-chair-di]');
    if (chairEl) {
      openDiplomatCard(chairEl.dataset.chairDi);
      return;
    }
    const seat = event.target.closest('.seat');
    if (!seat) return;
    const diplomatId = seat.dataset.diplomat;
    if (diplomatId) {
      openDiplomatCard(diplomatId);
      return;
    }
    if (openVoting(get())) {
      toast('Идёт голосование — посадка новых участников заблокирована.', { kind: 'warn' });
      return;
    }
    openSeatPicker(seat.dataset.seat);
  });
}

function renderLegend(state, voting, speaker) {
  const host = $('#hall-legend');
  if (!host) return;

  const seated = state.diplomats.filter((d) => d.seatId && !String(d.seatId).startsWith('chair'));
  const observers = seated.filter((d) => d.role === 'observer').length;
  const seatTotal = Number(state.settings?.seatCount) || SEAT_DEFAULT;
  const free = Math.max(0, seatTotal - seated.length);
  const q = quorumInfo(state);
  const chairs = [chairmanAt(state, 1), chairmanAt(state, 2)].filter(Boolean);
  const chairNames = chairs.length
    ? chairs.map((c) => `<b>${esc(c.fullName)}</b> (${esc(c.country)})`).join(' · ')
    : 'не назначен';

  host.innerHTML = `
    <span class="legend-item"><span class="legend-dot busy"></span>В зале ${seated.length} / ${seatTotal}</span>
    <span class="legend-item"><span class="legend-dot free"></span>Свободно ${free}</span>
    <span class="legend-item"><span class="legend-dot eye"></span>Наблюдатели ${observers}</span>
    <span class="legend-item legend-chairs"><span class="legend-dot chair"></span>Президиум ${chairs.length} / 2: ${chairNames}</span>
    ${speaker ? `<span class="legend-item"><span class="legend-dot speaking"></span>Слово: ${esc(speaker.snapshot?.name || '')}</span>` : ''}
    <span class="legend-item hint">${voting
    ? `${icon('i-ballot')} Голосование идёт — бюллетени принимаются`
    : `${icon('i-gavel')} ${q.met ? 'Кворум есть — можно голосовать' : 'Кворум не собран'}`}</span>
    <span class="legend-right">
      <span class="legend-item">Заседание <b style="color:#c9b795">${esc(state.settings.sessionName)}</b></span>
    </span>`;
}

/* ------------------------------------------------------------------ */
/* Масштаб и полноэкранный режим                                       */
/* ------------------------------------------------------------------ */

function applyZoom() {
  const el = document.getElementById('hall-zoom');
  if (el) el.style.transform = `scale(${zoom})`;
}

function setZoom(next) {
  zoom = Math.min(2.2, Math.max(0.7, Math.round(next * 100) / 100));
  applyZoom();
}

export function setupHallTools() {
  const host = $('#hall-tools');
  if (!host || host.dataset.ready) return;
  host.dataset.ready = '1';
  host.innerHTML = `
    <button type="button" class="icon-btn" id="hall-zoom-in" title="Приблизить">${icon('i-plus')}</button>
    <button type="button" class="icon-btn" id="hall-zoom-out" title="Отдалить">${icon('i-minus')}</button>
    <button type="button" class="icon-btn" id="hall-zoom-reset" title="Масштаб 100%">${icon('i-reset')}</button>
    <button type="button" class="icon-btn" id="hall-fullscreen" title="Во весь экран">${icon('i-expand')}</button>`;

  host.querySelector('#hall-zoom-in').addEventListener('click', () => setZoom(zoom + 0.12));
  host.querySelector('#hall-zoom-out').addEventListener('click', () => setZoom(zoom - 0.12));
  host.querySelector('#hall-zoom-reset').addEventListener('click', () => setZoom(1));
  host.querySelector('#hall-fullscreen').addEventListener('click', async () => {
    const view = $('#hall-view');
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await view.requestFullscreen();
    } catch {
      toast('Полноэкранный режим недоступен в этом браузере.', { kind: 'warn' });
    }
  });
}
