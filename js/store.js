// Состояние приложения, персистентность в localStorage, миграции, pub/sub.

import { uid } from './utils.js';

const KEY = 'omb.state.v1';
export const CHAIR_SEATS = ['chair1', 'chair2'];
export const SEAT_MIN = 12;
export const SEAT_MAX = 80;
export const SEAT_DEFAULT = 46;

// Только хэши. Сами пароли в коде и в состоянии не хранятся.
const DEFAULT_CHAIR_SALT = 'b21iLWNoYWlyLXNhbHQtMQ==';
const DEFAULT_CHAIR_HASH = 'wPWDkiHRGXduaZsx3ZCPqC7P7YBweEh1tmFeSm5QZ0Y=';

const DEFAULT_ADMINS = [
  { id: 'adm1', login: 'acta', name: 'Acta', salt: 'BP8EMTZxNstT8RdaP5IimA==', hash: 'KxoDVZa9c3jBLRAxYbIP0qJxw1FxFYnQM6YDYiQ85Xs=' },
  { id: 'adm2', login: 'anon', name: 'Anon', salt: 's5yAZR9qjYJNLkecnUtF+A==', hash: 'WS4WL59oBsQJkUmfHivcFIiW3ReBj+48MB3JpQOnceM=' },
  { id: 'adm3', login: 'maslo', name: 'Maslo', salt: '5Y5hcvyp1E8nKl6+hWNvUQ==', hash: 'YE9V5XXgjLvcMT1exWN/tcgGvXuW3jY28NHuUvg3bb4=' },
].map((a) => ({ ...a, createdAt: 0 }));

// Старые аккаунты организаторов: заменяются, только если пароль не меняли.
const LEGACY_ADMINS = [
  { id: 'adm1', login: 'admin1', hash: 'dT4Yo9MSiTkAU+OotWNHejZgP98/38LQw2qILV1kthE=' },
  { id: 'adm2', login: 'admin2', hash: 'KHK2cGIdPc8chf1+TAEjSoRx3THJOgbrtUx15vRz2ic=' },
  { id: 'adm3', login: 'admin3', hash: 'f4+gHMR0yqRpSjqrH94dW5SD4+uiHEV8X4IAc9MivXA=' },
];

function cloneAdmins() {
  return DEFAULT_ADMINS.map((a) => ({ ...a }));
}

export function defaultState() {
  const now = new Date();
  return {
    version: 4,
    sessionId: uid('ses'),
    sessionStartedAt: Date.now(),
    activeDiplomatId: null,
    diplomats: [],
    seating: {},
    chat: [],
    resolutions: [],
    votings: [],
    archive: [],
    journal: [],
    speeches: [],
    admins: cloneAdmins(),
    settings: {
      sessionName: 'Заседание №1',
      sessionDate: { month: now.getMonth(), year: now.getFullYear() },
      quorumMode: 'percent', // percent | fixed
      quorumValue: 50,
      speechMinutes: 5,
      soundOn: true,
      seatCount: SEAT_DEFAULT,
      chairSalt: DEFAULT_CHAIR_SALT,
      chairHash: DEFAULT_CHAIR_HASH,
    },
    timer: { endsAt: null, remainingMs: 0, running: false },
  };
}

function clampSeatCount(value) {
  const n = Math.round(Number(value) || SEAT_DEFAULT);
  return Math.min(SEAT_MAX, Math.max(SEAT_MIN, n));
}

// Приводит президиум к модели «ровно два председателя, места chair1/chair2».
function normalizeChairs(state) {
  for (const d of state.diplomats) {
    if (d.seatId === 'chair') d.seatId = 'chair1';
    if (!('chairSlot' in d)) d.chairSlot = null;
    if (d.seatId && /^chair[12]$/.test(d.seatId) && d.role !== 'chairman') d.seatId = null;
  }
  if (state.seating.chair) {
    state.seating.chair1 = state.seating.chair;
    delete state.seating.chair;
  }

  let chairs = state.diplomats
    .filter((d) => d.role === 'chairman')
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  for (const extra of chairs.slice(2)) {
    extra.role = extra.type === 'organization' ? 'observer' : 'delegate';
    extra.chairSlot = null;
    if (extra.seatId && extra.seatId.startsWith('chair')) extra.seatId = null;
  }
  chairs = chairs.slice(0, 2);

  // Сохраняем уже выданные кресла, свободные слоты раздаём по порядку.
  const usedSlots = new Set();
  for (const d of chairs) {
    d.role = 'chairman';
    const slot = Number(d.chairSlot);
    if ((slot === 1 || slot === 2) && !usedSlots.has(slot)) {
      d.chairSlot = slot;
      usedSlots.add(slot);
    } else {
      d.chairSlot = null;
    }
  }
  for (const d of chairs) {
    if (!d.chairSlot) {
      const slot = usedSlots.has(1) ? 2 : 1;
      d.chairSlot = slot;
      usedSlots.add(slot);
    }
    d.seatId = CHAIR_SEATS[d.chairSlot - 1];
    state.seating[d.seatId] = d.id;
  }

  for (const key of CHAIR_SEATS) {
    const occupant = state.diplomats.find((d) => d.id === state.seating[key]);
    if (!occupant || occupant.role !== 'chairman' || occupant.seatId !== key) {
      delete state.seating[key];
    }
  }
  for (const [seatId, id] of Object.entries(state.seating)) {
    if (!state.diplomats.some((d) => d.id === id)) delete state.seating[seatId];
  }
  for (const d of state.diplomats) {
    if (d.seatId && !d.seatId.startsWith('chair') && state.seating[d.seatId] !== d.id) {
      d.seatId = null;
    }
  }
}

function migrate(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  const prevVersion = Number(raw.version) || 0;
  const state = {
    ...base,
    ...raw,
    settings: { ...base.settings, ...(raw.settings || {}) },
    timer: { ...base.timer, ...(raw.timer || {}) },
  };
  for (const key of ['diplomats', 'chat', 'resolutions', 'votings', 'archive', 'journal', 'speeches']) {
    if (!Array.isArray(state[key])) state[key] = [];
  }
  if (!state.seating || typeof state.seating !== 'object') state.seating = {};
  if (state.settings.sessionDate && typeof state.settings.sessionDate !== 'object') {
    state.settings.sessionDate = base.settings.sessionDate;
  }
  if (!state.sessionId) state.sessionId = uid('ses');
  if (!Number.isFinite(state.sessionStartedAt)) state.sessionStartedAt = Date.now();

  // v3: коды в открытом виде удалены, остались только хэши.
  delete state.settings.adminCode;
  delete state.settings.codeSeen;
  if (!state.settings.chairSalt || !state.settings.chairHash) {
    state.settings.chairSalt = DEFAULT_CHAIR_SALT;
    state.settings.chairHash = DEFAULT_CHAIR_HASH;
  }
  state.settings.seatCount = clampSeatCount(state.settings.seatCount);

  if (!Array.isArray(state.admins)) state.admins = [];

  // v4: служебные логины acta/anon/maslo. Аккаунты с изменённым паролем не трогаем.
  if (prevVersion < 4) {
    for (const a of state.admins) {
      const legacy = LEGACY_ADMINS.find((x) => x.login === String(a?.login || '').toLowerCase() && x.hash === a?.hash);
      if (!legacy) continue;
      const fresh = DEFAULT_ADMINS.find((x) => x.id === legacy.id);
      a.id = fresh.id;
      a.login = fresh.login;
      a.name = fresh.name;
      a.salt = fresh.salt;
      a.hash = fresh.hash;
    }
  }

  const admins = state.admins
    .filter((a) => a && typeof a.login === 'string' && a.salt && a.hash)
    .slice(0, 3);
  for (const fallback of DEFAULT_ADMINS) {
    if (admins.length >= 3) break;
    if (!admins.some((a) => a.login.toLowerCase() === fallback.login)) admins.push({ ...fallback });
  }
  while (admins.length < 3) admins.push({ ...DEFAULT_ADMINS[admins.length] });
  state.admins = admins;

  for (const d of state.diplomats) {
    d.banned = Boolean(d.banned);
    if (typeof d.login !== 'string') d.login = '';
    if (typeof d.passSalt !== 'string') d.passSalt = '';
    if (typeof d.passHash !== 'string') d.passHash = '';
  }

  normalizeChairs(state);

  // Места за пределами текущей схемы освобождаются.
  for (const [seatId, id] of Object.entries(state.seating)) {
    const match = /^s(\d+)$/.exec(seatId);
    if (match && Number(match[1]) > state.settings.seatCount) {
      delete state.seating[seatId];
      const d = state.diplomats.find((x) => x.id === id);
      if (d) d.seatId = null;
    }
  }

  state.version = 4;
  return state;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultState();
    return migrate(JSON.parse(raw));
  } catch (err) {
    console.warn('Не удалось прочитать сохранение, создаём новое состояние.', err);
    return defaultState();
  }
}

let state = load();
// Фиксируем миграции (кресла президиума, код администратора) сразу после загрузки.
save();
const subscribers = new Set();
const changeHooks = new Set();
let applyingRemote = false;

export function get() {
  return state;
}

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (err) {
    console.error('Ошибка сохранения состояния', err);
    window.dispatchEvent(new CustomEvent('omb:storage-error'));
  }
}

export function emit() {
  for (const fn of subscribers) {
    try { fn(state); } catch (err) { console.error(err); }
  }
}

export function commit(mutator) {
  mutator(state);
  save();
  emit();
  if (!applyingRemote) notifyChange();
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// Сетевой слой подписывается здесь, чтобы публиковать только локальные действия.
export function onLocalChange(fn) {
  changeHooks.add(fn);
  return () => changeHooks.delete(fn);
}

function notifyChange() {
  for (const fn of changeHooks) {
    try { fn(state); } catch (err) { console.error('Ошибка синхронизации', err); }
  }
}

// Изменение, пришедшее из сети: сохраняем и перерисовываем, но обратно не публикуем.
export function applyRemote(mutator) {
  applyingRemote = true;
  try {
    mutator(state);
    save();
    emit();
  } finally {
    applyingRemote = false;
  }
}

// Снимок общего зала целиком заменяет локальное состояние.
export function adoptRemote(next) {
  applyingRemote = true;
  try {
    state = migrate(next);
    save();
    emit();
  } finally {
    applyingRemote = false;
  }
}

export function replaceState(next) {
  state = migrate(next);
  save();
  emit();
  if (!applyingRemote) notifyChange();
}

export function hardReset() {
  state = defaultState();
  save();
  emit();
  if (!applyingRemote) notifyChange();
}
