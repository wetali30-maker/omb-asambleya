// Общий зал: синхронизация заседания между устройствами в реальном времени.
// Транспорт — MQTT 3.1.1 поверх WebSocket к публичному брокеру без регистрации.
// Зал защищён кодом комнаты; данные видны всем, кто знает код.

import {
  get, save, emit, onLocalChange, applyRemote, adoptRemote,
} from './store.js';
import { activeDiplomat } from './rules.js';
import { getImage, blobToDataUrl, importImages } from './idb.js';
import { toast } from './ui/modal.js';

const CFG_KEY = 'omb.net.v1';
const TOMB_KEY = 'omb.net.tomb.v1';
const META_KEY = 'omb.net.meta.v1';
const BACKUP_KEY = 'omb.prejoin.v1';
const BROKER_KEY = 'omb.net.broker';
const TOPIC_BASE = 'omb/asambleya/v1';
const BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
];
const COLLECTIONS = ['diplomats', 'chat', 'resolutions', 'votings', 'archive', 'journal', 'speeches'];
const STAMP_KEYS = ['_syncAt', 'updatedAt', 'ts', 'createdAt', 'startedAt', 'finishedAt', 'openedAt', 'closedAt'];
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_IMAGE_DATA = 240000;
const MAX_RETAINED = 120000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/* ------------------------------------------------------------------ */
/* Код зала и настройки                                                */
/* ------------------------------------------------------------------ */

export function normalizeRoom(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

export function randomRoomCode(length = 6) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
  return out;
}

export function inviteUrl(code) {
  const base = location.protocol === 'file:'
    ? location.href.split('?')[0].split('#')[0]
    : `${location.origin}${location.pathname}`;
  return `${base}?room=${encodeURIComponent(code)}`;
}

function readConfig() {
  try {
    const raw = JSON.parse(localStorage.getItem(CFG_KEY) || '{}') || {};
    return {
      room: normalizeRoom(raw.room),
      nick: String(raw.nick || '').slice(0, 40),
      auto: raw.auto !== false,
    };
  } catch {
    return { room: '', nick: '', auto: true };
  }
}

let config = readConfig();

function writeConfig(patch) {
  config = { ...config, ...patch };
  try { localStorage.setItem(CFG_KEY, JSON.stringify(config)); } catch { /* приватный режим */ }
  return config;
}

let room = config.room;
let nick = config.nick;

function presenceNick() {
  if (nick) return nick;
  const actor = activeDiplomat(get());
  return actor ? actor.fullName : 'Гость';
}

/* ------------------------------------------------------------------ */
/* Состояние соединения                                                */
/* ------------------------------------------------------------------ */

const clientId = `omb_${randomRoomCode(10).toLowerCase()}`;
let socket = null;
let brokerCursor = 0;
let brokerFails = 0;
let currentBroker = '';
let status = room ? 'offline' : 'idle'; // idle | connecting | online | offline
let ready = false;
let roomReadyOnce = false;
let clone = null;
let lastMetaAt = 0;
let metaSeen = '';
let pendingMetaAt = 0;
let reconnectAttempt = 0;
let retryTimer = null;
let pingTimer = null;
let snapshotTimer = null;
let imageTimer = null;
let rx = new Uint8Array(0);
let imageChecked = new Set();
const peers = new Map();
const netSubs = new Set();

function cloneState(value = get()) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

function topic() {
  return `${TOPIC_BASE}/${room}`;
}

function notify() {
  const info = netInfo();
  for (const fn of netSubs) {
    try { fn(info); } catch (err) { console.error(err); }
  }
  try { window.dispatchEvent(new CustomEvent('omb:net')); } catch { /* noop */ }
}

export function subscribeNet(fn) {
  netSubs.add(fn);
  return () => netSubs.delete(fn);
}

export function netInfo() {
  const info = {
    room,
    status,
    ready,
    online: status === 'online' ? peers.size + 1 : 0,
    invite: room ? inviteUrl(room) : '',
    peers: [],
  };
  if (status === 'online') {
    info.peers.push({ id: clientId, nick: presenceNick(), self: true, at: Date.now() });
  }
  for (const [id, peer] of peers) info.peers.push({ id, nick: peer.nick, self: false, at: peer.at });
  return info;
}

/* ------------------------------------------------------------------ */
/* MQTT 3.1.1 (QoS 0) поверх WebSocket                                 */
/* ------------------------------------------------------------------ */

function encodeRemaining(n) {
  const bytes = [];
  let value = n;
  do {
    let digit = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) digit |= 0x80;
    bytes.push(digit);
  } while (value > 0);
  return Uint8Array.from(bytes);
}

function utf8(str) {
  const data = encoder.encode(String(str));
  const out = new Uint8Array(data.length + 2);
  out[0] = (data.length >> 8) & 0xff;
  out[1] = data.length & 0xff;
  out.set(data, 2);
  return out;
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function frame(header, body) {
  const remaining = encodeRemaining(body.length);
  const out = new Uint8Array(1 + remaining.length + body.length);
  out[0] = header;
  out.set(remaining, 1);
  out.set(body, 1 + remaining.length);
  return out;
}

function connectFrame() {
  const will = encoder.encode(JSON.stringify({ t: 'bye', id: clientId }));
  const payload = new Uint8Array(will.length + 2);
  payload[0] = (will.length >> 8) & 0xff;
  payload[1] = will.length & 0xff;
  payload.set(will, 2);
  return frame(0x10, concat([
    utf8('MQTT'),
    Uint8Array.of(4, 0x06, 0, 60), // протокол 4, clean session + will, keepalive 60 c
    utf8(clientId),
    utf8(topic()),
    payload,
  ]));
}

function subscribeFrame() {
  return frame(0x82, concat([Uint8Array.of(0, 1), utf8(topic()), Uint8Array.of(0)]));
}

function publishFrame(message, retain = false) {
  return frame(retain ? 0x31 : 0x30, concat([utf8(topic()), encoder.encode(JSON.stringify(message))]));
}

function sendRaw(bytes) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(bytes);
    return true;
  } catch {
    return false;
  }
}

function sendJson(message) {
  return sendRaw(publishFrame(message));
}

function parsePackets() {
  const packets = [];
  let offset = 0;
  while (offset < rx.length) {
    if (rx.length - offset < 2) break;
    let mult = 1;
    let length = 0;
    let i = offset + 1;
    let byte = 0;
    let complete = false;
    while (i < rx.length) {
      byte = rx[i];
      i += 1;
      length += (byte & 0x7f) * mult;
      mult *= 128;
      if (!(byte & 0x80)) { complete = true; break; }
      if (mult > 268435456) break;
    }
    if (!complete || rx.length < i + length) break;
    packets.push({ type: rx[offset] >> 4, flags: rx[offset] & 0x0f, body: rx.slice(i, i + length) });
    offset = i + length;
  }
  rx = rx.slice(offset);
  return packets;
}

/* ------------------------------------------------------------------ */
/* Подключение                                                         */
/* ------------------------------------------------------------------ */

export function initNet() {
  onLocalChange(() => {
    if (JSON.stringify(metaParts(get())) !== metaSeen) pendingMetaAt = Date.now();
    publishPatch();
  });
  metaSeen = JSON.stringify(metaParts(get()));

  window.addEventListener('pagehide', () => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      try { socket.send(publishFrame({ t: 'bye', id: clientId })); } catch { /* noop */ }
    }
    teardown();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !room) return;
    if (status === 'online') {
      sendRaw(Uint8Array.of(0xc0));
      sendJson({ t: 'hi', id: clientId, nick: presenceNick(), at: Date.now() });
      return;
    }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    openSocket();
  });

  const wanted = normalizeRoom(new URLSearchParams(location.search).get('room'));
  if (wanted.length >= 4) {
    joinRoom(wanted);
    return;
  }
  const saved = readConfig();
  if (saved.room && saved.auto) {
    room = saved.room;
    config = saved;
    nick = saved.nick;
    lastMetaAt = metaAtOf(saved.room);
    openSocket();
  }
}

export function joinRoom(code, options = {}) {
  const roomCode = normalizeRoom(code);
  if (roomCode.length < 4) return { ok: false, reason: 'Код зала: 4–12 латинских букв или цифр.' };
  if (options.nick !== undefined) {
    nick = String(options.nick).trim().slice(0, 40);
    writeConfig({ nick });
  }
  if (!nick) {
    const actor = activeDiplomat(get());
    if (actor) {
      nick = actor.fullName;
      writeConfig({ nick });
    }
  }
  room = roomCode;
  writeConfig({ room: roomCode, auto: true });
  teardown();
  peers.clear();
  ready = false;
  roomReadyOnce = false;
  clone = null;
  lastMetaAt = metaAtOf(roomCode);
  metaSeen = JSON.stringify(metaParts(get()));
  pendingMetaAt = 0;
  imageChecked = new Set();
  status = 'connecting';
  reconnectAttempt = 0;
  brokerFails = 0;
  notify();
  openSocket();
  return { ok: true, room: roomCode, invite: inviteUrl(roomCode) };
}

export function leaveRoom() {
  const old = room;
  teardown();
  room = '';
  ready = false;
  roomReadyOnce = false;
  clone = null;
  lastMetaAt = 0;
  peers.clear();
  status = 'idle';
  writeConfig({ room: '', auto: false });
  try {
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState(null, '', url.toString());
  } catch { /* noop */ }
  notify();
  return old;
}

function teardown() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (snapshotTimer) { clearTimeout(snapshotTimer); snapshotTimer = null; }
  if (imageTimer) { clearTimeout(imageTimer); imageTimer = null; }
  const ws = socket;
  socket = null;
  rx = new Uint8Array(0);
  if (ws) {
    try { ws.close(); } catch { /* noop */ }
  }
}

function preferredBroker() {
  try {
    return localStorage.getItem(BROKER_KEY) || '';
  } catch {
    return '';
  }
}

function rememberBroker(url) {
  try { localStorage.setItem(BROKER_KEY, url); } catch { /* noop */ }
}

function openSocket() {
  if (!room) return;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  status = 'connecting';
  notify();

  const url = preferredBroker() || BROKERS[brokerCursor % BROKERS.length];
  currentBroker = url;

  let ws;
  try {
    ws = new WebSocket(url, ['mqtt']);
  } catch {
    status = 'offline';
    notify();
    scheduleReconnect();
    return;
  }
  socket = ws;
  ws.binaryType = 'arraybuffer';

  const connTimer = setTimeout(() => {
    if (socket === ws && status !== 'online') {
      try { ws.close(); } catch { /* noop */ }
    }
  }, 9000);

  ws.onopen = () => {
    if (socket !== ws) return;
    try { ws.send(connectFrame()); } catch { /* noop */ }
  };

  ws.onmessage = (event) => {
    if (socket !== ws) return;
    const chunk = new Uint8Array(event.data);
    rx = rx.length ? concat([rx, chunk]) : chunk;
    for (const packet of parsePackets()) handlePacket(packet);
  };

  ws.onclose = () => {
    clearTimeout(connTimer);
    if (socket !== ws) return;
    socket = null;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    const wasOnline = status === 'online';
    status = 'offline';
    ready = false;
    if (!wasOnline) {
      brokerFails += 1;
      if (brokerFails >= 2) {
        brokerFails = 0;
        brokerCursor += 1;
        try { localStorage.removeItem(BROKER_KEY); } catch { /* noop */ }
      }
    }
    notify();
    if (wasOnline) {
      toast('Связь с общим залом потеряна. Переподключаемся…', { kind: 'warn', timeout: 6000 });
    }
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (!room || retryTimer) return;
  reconnectAttempt += 1;
  const delay = Math.min(20000, 1500 * 2 ** Math.min(reconnectAttempt, 4));
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (!room) return;
    openSocket();
  }, delay + Math.random() * 600);
}

function onConnected() {
  status = 'online';
  reconnectAttempt = 0;
  brokerFails = 0;
  rememberBroker(currentBroker);
  ready = false;
  imageChecked = new Set();
  rx = new Uint8Array(0);
  sendRaw(subscribeFrame());
  sendJson({ t: 'hi', id: clientId, nick: presenceNick(), at: Date.now() });
  notify();

  if (pingTimer) clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    sendRaw(Uint8Array.of(0xc0)); // PINGREQ
    sendJson({ t: 'hi', id: clientId, nick: presenceNick(), at: Date.now() });
    prunePeers();
  }, 20000);

  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    if (status !== 'online' || ready) return;
    const rivals = [...peers.keys()].sort();
    if (rivals.length && rivals[0] < clientId) {
      // Старший участник пришлёт снимок; на случай потери пакета — запасной срок.
      snapshotTimer = setTimeout(() => {
        snapshotTimer = null;
        if (status !== 'online' || ready) return;
        seedRoom();
      }, 5000);
      return;
    }
    seedRoom();
  }, 2400 + Math.random() * 700);
}

function seedRoom() {
  clone = cloneState();
  ready = true;
  roomReadyOnce = true;
  const metaAt = syncMetaStamp();
  const payload = {
    t: 'state', id: clientId, nick: presenceNick(), at: Date.now(), metaAt, state: get(), tombs: tombs[room] || {},
  };
  const sent = sendJson(payload);
  if (sent) {
    resetMetaSeen();
    maybeRetain(true);
  }
  ensureImages();
  notify();
}

// Снимок зала остаётся на брокере (retain): новый участник получает данные,
// даже если все прежние вкладки закрыты или спят.
let lastRetainAt = 0;

function maybeRetain(force = false) {
  if (!room || status !== 'online' || !ready) return;
  const now = Date.now();
  if (!force && now - lastRetainAt < 15000) return;
  const metaAt = syncMetaStamp();
  const count = COLLECTIONS.reduce((sum, key) => sum + (get()[key] || []).length, 0);
  if (count === 0 && metaAt === 0) return;
  const payload = {
    t: 'state', id: clientId, nick: presenceNick(), at: now, metaAt, state: get(), tombs: tombs[room] || {},
  };
  if (JSON.stringify(payload).length > MAX_RETAINED) return;
  if (sendRaw(publishFrame(payload, true))) {
    lastRetainAt = now;
    resetMetaSeen();
  }
}

function prunePeers() {
  const limit = Date.now() - 90000;
  let changed = false;
  for (const [id, peer] of peers) {
    if (peer.at < limit) { peers.delete(id); changed = true; }
  }
  if (changed) notify();
}

/* ------------------------------------------------------------------ */
/* Приём сообщений                                                     */
/* ------------------------------------------------------------------ */

function handlePacket(packet) {
  if (packet.type === 2) { // CONNACK
    if (packet.body[1] === 0) onConnected();
    else {
      try { socket?.close(); } catch { /* noop */ }
    }
    return;
  }
  if (packet.type !== 3) return; // нам нужны только PUBLISH

  const qos = (packet.flags >> 1) & 3;
  const body = packet.body;
  if (body.length < 2) return;
  const len = (body[0] << 8) | body[1];
  if (body.length < 2 + len) return;
  const name = decoder.decode(body.slice(2, 2 + len));
  if (name !== topic()) return;
  const offset = 2 + len + (qos > 0 ? 2 : 0);
  if (offset >= body.length) return;
  handleJson(body.slice(offset));
}

function handleJson(bytes) {
  let message;
  try { message = JSON.parse(decoder.decode(bytes)); } catch { return; }
  if (!message || typeof message !== 'object' || message.id === clientId) return;

  if (message.t === 'hi') {
    const known = peers.has(message.id);
    peers.set(message.id, {
      nick: String(message.nick || '—').slice(0, 40),
      at: Date.now(),
    });
    if (!known) {
      notify();
      scheduleSnapshot(message.id);
    }
    return;
  }

  if (message.t === 'bye') {
    if (peers.delete(message.id)) notify();
    return;
  }

  if (message.t === 'state') {
    if (message.to && message.to !== clientId) return;
    if (!message.state) return;
    peers.set(message.id, {
      nick: String(message.nick || peers.get(message.id)?.nick || '—').slice(0, 40),
      at: Date.now(),
    });
    receiveSnapshot(message);
    return;
  }

  if (message.t === 'p') {
    if (!ready) return;
    if (!peers.has(message.id) || message.nick) {
      peers.set(message.id, { nick: String(message.nick || peers.get(message.id)?.nick || '—').slice(0, 40), at: Date.now() });
    }
    applyPatch(message);
    return;
  }

  if (message.t === 'imgreq') {
    respondImages(message);
    return;
  }

  if (message.t === 'img') {
    receiveImage(message);
  }
}

function scheduleSnapshot(peerId) {
  if (status !== 'online' || !ready) return;
  const delay = 180 + Math.random() * 320;
  setTimeout(() => {
    if (status !== 'online' || !ready) return;
    if (!peers.has(peerId)) return;
    const rivals = [...peers.keys()].filter((id) => id !== peerId).sort();
    if (rivals.length && rivals[0] < clientId) return;
    const metaAt = syncMetaStamp();
    const sent = sendJson({
      t: 'state', id: clientId, to: peerId, nick: presenceNick(), at: Date.now(), metaAt, state: get(), tombs: tombs[room] || {},
    });
    if (sent) resetMetaSeen();
  }, delay);
}

function receiveSnapshot(message) {
  if (snapshotTimer) { clearTimeout(snapshotTimer); snapshotTimer = null; }
  if (!roomReadyOnce) adoptSnapshot(message);
  else mergeSnapshot(message);
}

function backupLocalOnce() {
  try {
    const prev = JSON.parse(localStorage.getItem(BACKUP_KEY) || 'null');
    if (!prev || prev.room !== room) {
      localStorage.setItem(BACKUP_KEY, JSON.stringify({ room, at: Date.now(), state: get() }));
    }
  } catch { /* нет места — пропускаем резервную копию */ }
}

function adoptSnapshot(message) {
  backupLocalOnce();
  const soundOn = get().settings?.soundOn;
  const activeId = get().activeDiplomatId;
  const next = cloneState(message.state);
  next.settings = { ...(next.settings || {}), soundOn };
  next.activeDiplomatId = (next.diplomats || []).some((d) => d.id === activeId) ? activeId : null;
  if (!next.activeDiplomatId) {
    try { sessionStorage.removeItem('omb.auth.user'); } catch { /* noop */ }
  }
  adoptRemote(next);
  clone = cloneState();
  stampMetaAt(Number(message.metaAt) || 0);
  resetMetaSeen();
  ready = true;
  roomReadyOnce = true;
  imageChecked = new Set();
  ensureImages();
  notify();
  toast(`Зал ${room}: данные заседания загружены.`, { kind: 'ok', timeout: 4500 });
}

function mergeSnapshot(message) {
  const remote = message.state;
  if (!remote || typeof remote !== 'object') return;
  backupLocalOnce();

  if (message.tombs && typeof message.tombs === 'object') {
    for (const [key, value] of Object.entries(message.tombs)) {
      const at = Number(value) || 0;
      if (at) addTomb(key, at);
    }
  }

  const activeId = get().activeDiplomatId;
  const soundOn = get().settings?.soundOn;
  const remoteMetaAt = Number(message.metaAt) || 0;
  const countOf = (value) => COLLECTIONS.reduce(
    (sum, key) => sum + (Array.isArray(value?.[key]) ? value[key].length : 0), 0,
  );
  const takeMeta = remoteMetaAt > lastMetaAt
    || (remoteMetaAt === lastMetaAt && countOf(remote) > countOf(get()));

  applyRemote((target) => {
    for (const collection of COLLECTIONS) {
      const localMap = new Map((target[collection] || []).map((record) => [record.id, record]));
      const remoteMap = new Map((Array.isArray(remote[collection]) ? remote[collection] : [])
        .map((record) => [record.id, record]));
      const merged = [];

      for (const [id, record] of remoteMap) {
        const local = localMap.get(id);
        localMap.delete(id);
        const value = local ? mergeRecords(collection, local, record) : record;
        if (!isTombed(`${collection}:${id}`, stampOf(value))) merged.push(value);
      }
      for (const [id, record] of localMap) {
        if (!isTombed(`${collection}:${id}`, stampOf(record))) merged.push(record);
      }
      target[collection] = merged;
    }

    if (takeMeta) {
      if (remote.settings) target.settings = { ...target.settings, ...remote.settings, soundOn };
      if (remote.sessionId) target.sessionId = remote.sessionId;
      if (Number.isFinite(Number(remote.sessionStartedAt))) target.sessionStartedAt = Number(remote.sessionStartedAt);
      if (Array.isArray(remote.admins)) target.admins = remote.admins;
      if (remote.timer && typeof remote.timer === 'object') target.timer = remote.timer;
    }
    mergeSeating(target, remote.seating);
    target.activeDiplomatId = target.diplomats.some((d) => d.id === activeId) ? activeId : null;
    sortState(target);
  });

  if (!get().activeDiplomatId) {
    try { sessionStorage.removeItem('omb.auth.user'); } catch { /* noop */ }
  }

  ready = true;
  roomReadyOnce = true;
  if (takeMeta) stampMetaAt(remoteMetaAt);
  // Исцеляем расхождение: отправляем то, чего нет у отправителя снимка.
  clone = cloneState(remote);
  persistTombs();
  publishPatch();
  resetMetaSeen();
  imageChecked = new Set();
  ensureImages();
  notify();
}

function mergeSeating(target, remoteSeating) {
  if (!remoteSeating || typeof remoteSeating !== 'object') return;
  const seating = { ...remoteSeating };
  for (const [seatId, id] of Object.entries(target.seating || {})) {
    if (seating[seatId]) continue;
    const diplomat = target.diplomats.find((item) => item.id === id);
    if (diplomat && diplomat.seatId === seatId) seating[seatId] = id;
  }
  target.seating = seating;
  for (const [seatId, id] of Object.entries(seating)) {
    const diplomat = target.diplomats.find((item) => item.id === id);
    if (!diplomat) {
      delete seating[seatId];
      continue;
    }
    if (!String(seatId).startsWith('chair')) diplomat.seatId = seatId;
  }
  for (const diplomat of target.diplomats) {
    if (diplomat.seatId && !String(diplomat.seatId).startsWith('chair') && !seating[diplomat.seatId]) {
      diplomat.seatId = null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Слияние изменений                                                   */
/* ------------------------------------------------------------------ */

function stampOf(record) {
  let best = 0;
  for (const key of STAMP_KEYS) {
    const value = Number(record?.[key]);
    if (Number.isFinite(value) && value > best) best = value;
  }
  return best;
}

function pickNewer(local, remote) {
  const a = stampOf(local);
  const b = stampOf(remote);
  if (b > a) return remote;
  if (b < a) return local;
  return JSON.stringify(remote) >= JSON.stringify(local) ? remote : local;
}

function mergeVoting(local, remote) {
  const base = pickNewer(local, remote);
  const other = base === remote ? local : remote;
  const ballots = { ...(other.ballots || {}) };
  for (const [country, ballot] of Object.entries(base.ballots || {})) {
    if (!ballots[country] || (Number(ballot.ts) || 0) >= (Number(ballots[country].ts) || 0)) {
      ballots[country] = ballot;
    }
  }
  if (base.status === 'closed' && Number.isFinite(Number(base.closedAt))) {
    for (const [country, ballot] of Object.entries(ballots)) {
      if ((Number(ballot.ts) || 0) > Number(base.closedAt)) delete ballots[country];
    }
  }
  return { ...base, ballots };
}

function mergeResolution(local, remote) {
  const base = pickNewer(local, remote);
  const other = base === remote ? local : remote;
  const amendments = new Map();
  for (const item of other.amendments || []) amendments.set(item.id, item);
  for (const item of base.amendments || []) {
    const prev = amendments.get(item.id);
    amendments.set(item.id, prev ? pickNewer(prev, item) : item);
  }
  return { ...base, amendments: [...amendments.values()].sort((a, b) => (a.order || 0) - (b.order || 0)) };
}

function mergeRecords(collection, local, remote) {
  if (collection === 'votings') return mergeVoting(local, remote);
  if (collection === 'resolutions') return mergeResolution(local, remote);
  return pickNewer(local, remote);
}

function sortState(target) {
  target.chat.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  target.journal.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  target.speeches.sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

function stripSound(settings = {}) {
  const { soundOn, ...rest } = settings;
  void soundOn;
  return rest;
}

function metaParts(value) {
  return {
    settings: stripSound(value?.settings),
    seating: value?.seating,
    timer: value?.timer,
    sessionId: value?.sessionId,
    sessionStartedAt: value?.sessionStartedAt,
    admins: value?.admins,
  };
}

function syncMetaStamp() {
  const at = Math.max(lastMetaAt, pendingMetaAt);
  if (at > lastMetaAt) stampMetaAt(at);
  return at;
}

function resetMetaSeen() {
  metaSeen = JSON.stringify(metaParts(get()));
  pendingMetaAt = 0;
}

function buildMeta(prev, next, at) {
  if (!prev) return null;
  const before = metaParts(prev);
  const after = metaParts(next);
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  return { ...after, at };
}

function applyMeta(target, meta) {
  stampMetaAt(Number(meta.at) || lastMetaAt);
  if (meta.settings) target.settings = { ...target.settings, ...meta.settings, soundOn: target.settings.soundOn };
  if (meta.seating && typeof meta.seating === 'object') target.seating = meta.seating;
  if (meta.timer && typeof meta.timer === 'object') target.timer = meta.timer;
  if (meta.sessionId) target.sessionId = meta.sessionId;
  if (Number.isFinite(Number(meta.sessionStartedAt))) target.sessionStartedAt = Number(meta.sessionStartedAt);
  if (Array.isArray(meta.admins)) target.admins = meta.admins;
}

function buildPatch() {
  const next = get();
  const prev = clone || get();
  const at = Date.now();
  const ops = [];

  for (const collection of COLLECTIONS) {
    const before = new Map((prev[collection] || []).map((record) => [record.id, record]));
    const after = new Map((next[collection] || []).map((record) => [record.id, record]));

    for (const [id, record] of after) {
      const old = before.get(id);
      if (old && JSON.stringify(old) === JSON.stringify(record)) continue;
      record._syncAt = at;
      ops.push({ c: collection, id, r: record });
    }
    for (const id of before.keys()) {
      if (after.has(id)) continue;
      addTomb(`${collection}:${id}`, at);
      ops.push({ c: collection, id, r: null, at });
    }
  }

  return { ops, meta: buildMeta(prev, next, at), at };
}

function publishPatch() {
  if (!room || status !== 'online' || !ready) return;
  const patch = buildPatch();
  if (!patch.ops.length && !patch.meta) return;
  if (patch.ops.length) save();
  const payload = { t: 'p', id: clientId, nick: presenceNick(), at: patch.at, ops: patch.ops, meta: patch.meta };
  if (!sendJson(payload)) return;
  if (patch.meta) {
    stampMetaAt(patch.meta.at);
    resetMetaSeen();
  }
  clone = cloneState();
  persistTombs();
  maybeRetain();
}

function applyPatch(message) {
  const at = Number(message.at) || Date.now();
  const ops = Array.isArray(message.ops) ? message.ops : [];
  let changed = false;

  applyRemote((target) => {
    for (const op of ops) {
      if (!COLLECTIONS.includes(op.c)) continue;
      const list = target[op.c];
      const key = `${op.c}:${op.id}`;

      if (op.r === null) {
        const deletedAt = Number(op.at) || at;
        const index = list.findIndex((record) => record.id === op.id);
        if (index >= 0 && stampOf(list[index]) <= deletedAt) {
          list.splice(index, 1);
          addTomb(key, deletedAt);
          changed = true;
        } else {
          addTomb(key, deletedAt);
        }
        continue;
      }

      if (!op.r || typeof op.r !== 'object' || op.r.id !== op.id) continue;
      if (tombOf(key) >= stampOf(op.r)) continue;

      const index = list.findIndex((record) => record.id === op.id);
      if (index < 0) {
        list.push(op.r);
        changed = true;
        continue;
      }
      const merged = mergeRecords(op.c, list[index], op.r);
      if (JSON.stringify(merged) !== JSON.stringify(list[index])) {
        list[index] = merged;
        changed = true;
      }
    }

    if (message.meta && Number(message.meta.at) >= lastMetaAt) {
      applyMeta(target, message.meta);
      changed = true;
    }
    if (changed) sortState(target);
  });

  if (changed) {
    clone = cloneState();
    persistTombs();
    resetMetaSeen();
    ensureImages();
    maybeRetain();
  }
}

/* ------------------------------------------------------------------ */
/* Могильные метки удалений                                            */
/* ------------------------------------------------------------------ */

let tombs = readTombs();
let metaStamps = readMetaMap();

function readMetaMap() {
  try {
    const raw = JSON.parse(localStorage.getItem(META_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function metaAtOf(code) {
  return Number(metaStamps[code]) || 0;
}

function stampMetaAt(at) {
  if (!room) return;
  lastMetaAt = Number(at) || 0;
  metaStamps[room] = lastMetaAt;
  try { localStorage.setItem(META_KEY, JSON.stringify(metaStamps)); } catch { /* noop */ }
}

function readTombs() {
  try {
    const raw = JSON.parse(localStorage.getItem(TOMB_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function tombOf(key) {
  return Number(tombs[room]?.[key]) || 0;
}

function isTombed(key, stamp) {
  return tombOf(key) >= stamp;
}

function addTomb(key, at) {
  if (!room) return;
  tombs[room] = tombs[room] || {};
  tombs[room][key] = Math.max(Number(at) || 0, Number(tombs[room][key]) || 0);
}

function persistTombs() {
  if (!room) return;
  const limit = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const bucket = tombs[room] || {};
  const entries = Object.entries(bucket)
    .filter(([, at]) => Number(at) >= limit)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 800);
  tombs[room] = Object.fromEntries(entries);
  try { localStorage.setItem(TOMB_KEY, JSON.stringify(tombs)); } catch { /* noop */ }
}

/* ------------------------------------------------------------------ */
/* Изображения (аватары и флаги)                                       */
/* ------------------------------------------------------------------ */

function ensureImages() {
  if (status !== 'online' || !ready) return;
  if (imageTimer) clearTimeout(imageTimer);
  imageTimer = setTimeout(async () => {
    if (status !== 'online') return;
    const ids = new Set();
    for (const diplomat of get().diplomats) {
      if (diplomat.avatarId) ids.add(diplomat.avatarId);
      if (diplomat.flagId) ids.add(diplomat.flagId);
    }
    const missing = [];
    for (const id of ids) {
      if (imageChecked.has(id)) continue;
      imageChecked.add(id);
      try {
        if (!(await getImage(id))) missing.push(id);
      } catch { /* считаем отсутствующим */ }
    }
    if (missing.length) sendJson({ t: 'imgreq', id: clientId, ids: missing.slice(0, 12) });
  }, 500);
}

async function respondImages(message) {
  if (status !== 'online') return;
  const ids = Array.isArray(message.ids) ? message.ids.slice(0, 12) : [];
  for (const id of ids) {
    try {
      const record = await getImage(id);
      if (!record) continue;
      const dataUrl = record.dataUrl || await blobToDataUrl(record.blob);
      if (!dataUrl || String(dataUrl).length > MAX_IMAGE_DATA) continue;
      sendJson({ t: 'img', id: clientId, to: message.id, imgId: id, dataUrl });
    } catch { /* пропускаем битое изображение */ }
  }
}

async function receiveImage(message) {
  if (message.to !== clientId) return;
  if (!message.imgId || !message.dataUrl) return;
  if (String(message.dataUrl).length > MAX_IMAGE_DATA) return;
  try {
    await importImages({ [message.imgId]: message.dataUrl });
    imageChecked.add(message.imgId);
    emit();
  } catch { /* пропускаем */ }
}
