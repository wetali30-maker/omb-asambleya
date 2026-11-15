// Пароли и сессии. В открытом виде секреты не хранятся: только PBKDF2-SHA256.
// В статической сборке это защита от случайного просмотра; полноценная
// серверная проверка описана в docs/SPEC.md.

import { get } from './store.js';

const PBKDF2_ITER = 120000;
const PBKDF2_BITS = 256;
const ADMIN_KEY = 'omb.admin.session';
const ADMIN_TTL = 4 * 60 * 60 * 1000;

const enc = new TextEncoder();

function toB64(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 1) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

function fromB64(text) {
  const raw = atob(String(text || ''));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export function randomSalt(length = 16) {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  return toB64(buf);
}

export async function hashSecret(secret, saltB64) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Браузер не поддерживает защищённое хэширование.');
  const key = await subtle.importKey('raw', enc.encode(String(secret)), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: fromB64(saltB64), iterations: PBKDF2_ITER, hash: 'SHA-256' },
    key,
    PBKDF2_BITS,
  );
  return toB64(bits);
}

export function passwordProblem(password) {
  const value = String(password || '');
  if (value.length < 6) return 'Пароль — не короче 6 символов.';
  if (value.length > 128) return 'Пароль слишком длинный.';
  return null;
}

export function loginProblem(login) {
  const value = String(login || '').trim();
  if (!/^[A-Za-z0-9_.-]{3,24}$/.test(value)) {
    return 'Логин: 3–24 символа, латиница, цифры, точка, дефис или подчёркивание.';
  }
  return null;
}

export function loginTaken(login, ignoreDiplomatId = null) {
  const value = String(login || '').trim().toLowerCase();
  const state = get();
  if ((state.admins || []).some((a) => a.login.toLowerCase() === value)) return true;
  return state.diplomats.some(
    (d) => d.id !== ignoreDiplomatId && String(d.login || '').toLowerCase() === value,
  );
}

export async function verifyChairPassword(code) {
  const s = get().settings;
  if (!s.chairSalt || !s.chairHash) return false;
  try {
    const hash = await hashSecret(code, s.chairSalt);
    return hash === s.chairHash;
  } catch {
    return false;
  }
}

export async function verifyDiplomatPassword(diplomat, password) {
  if (!diplomat?.passSalt || !diplomat?.passHash) return false;
  try {
    const hash = await hashSecret(password, diplomat.passSalt);
    return hash === diplomat.passHash;
  } catch {
    return false;
  }
}

export async function loginDiplomat(login, password) {
  const value = String(login || '').trim().toLowerCase();
  if (!value) return { ok: false, reason: 'Введите логин.' };
  const state = get();
  const diplomat = state.diplomats.find((d) => String(d.login || '').toLowerCase() === value);
  if (!diplomat) return { ok: false, reason: 'Неверный логин или пароль.' };
  if (diplomat.banned) return { ok: false, reason: 'Аккаунт заблокирован председателем.' };
  const ok = await verifyDiplomatPassword(diplomat, password);
  if (!ok) return { ok: false, reason: 'Неверный логин или пароль.' };
  return { ok: true, diplomat };
}

/* ------------------------------------------------------------------ */
/* Сессия администратора                                                */
/* ------------------------------------------------------------------ */

function readAdminSession() {
  try {
    const raw = sessionStorage.getItem(ADMIN_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data?.adminId || !Number.isFinite(data.until) || data.until < Date.now()) {
      sessionStorage.removeItem(ADMIN_KEY);
      return null;
    }
    const admin = (get().admins || []).find((a) => a.id === data.adminId);
    if (!admin) {
      sessionStorage.removeItem(ADMIN_KEY);
      return null;
    }
    return { adminId: admin.id, login: admin.login, name: admin.name, until: data.until };
  } catch {
    return null;
  }
}

let adminSession = readAdminSession();

export function adminSessionActive() {
  adminSession = readAdminSession();
  return adminSession;
}

export function isAdminSession() {
  return Boolean(adminSessionActive());
}

export function startAdminSession(admin, remember = true) {
  adminSession = {
    adminId: admin.id,
    login: admin.login,
    name: admin.name,
    until: Date.now() + ADMIN_TTL,
  };
  if (remember) {
    try {
      sessionStorage.setItem(ADMIN_KEY, JSON.stringify({ adminId: admin.id, until: adminSession.until }));
    } catch { /* приватный режим */ }
  }
}

export function endAdminSession() {
  adminSession = null;
  try { sessionStorage.removeItem(ADMIN_KEY); } catch { /* noop */ }
}

export async function adminLogin(login, password) {
  const value = String(login || '').trim().toLowerCase();
  const state = get();
  const admin = (state.admins || []).find((a) => a.login.toLowerCase() === value);
  if (!admin) return { ok: false, reason: 'Неверный логин или пароль.' };
  let hash = '';
  try {
    hash = await hashSecret(password, admin.salt);
  } catch {
    return { ok: false, reason: 'Браузер не поддерживает защищённое хэширование.' };
  }
  if (hash !== admin.hash) return { ok: false, reason: 'Неверный логин или пароль.' };
  startAdminSession(admin);
  return { ok: true, admin };
}
