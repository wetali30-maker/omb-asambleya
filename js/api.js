// Слой данных: все операции с состоянием, проверки правил и запись в журнал.
// UI вызывает только эти методы; напрямую в store не пишет.

import {
  get, commit, replaceState, CHAIR_SEATS, SEAT_MIN, SEAT_MAX,
} from './store.js';
import {
  uid, pad2, pad3, normalizeCountry, downloadBlob, dateLabel,
} from './utils.js';
import {
  hashSecret, randomSalt, verifyChairPassword, isAdminSession,
  loginProblem, passwordProblem, loginTaken,
} from './auth.js';
import {
  countryPrimary, chairmenOf, chairmanAt, openVoting, requiredQuorum, quorumInfo,
  eligibleCountries, isVotingCountry, chairmanCanOpenResolution, tallyFor,
  activeDiplomat, isChairman, isSeatedChairman, chairSlotLabel,
  speechQueue, currentSpeaker,
} from './rules.js';
import { buildSheetPayload, buildResolutionDocPayload } from './export.js';
import { exportImages, importImages } from './idb.js';
import { playGong } from './audio.js';

const ok = (data = null) => ({ ok: true, data });
const fail = (reason, code = null) => ({ ok: false, reason, code });

const VOTE_LABEL = { for: 'ЗА', against: 'ПРОТИВ', abstain: 'ВОЗДЕРЖАЛСЯ' };

function logEvent(state, type, message, actorId = null) {
  state.journal.push({
    id: uid('evt'),
    ts: Date.now(),
    sessionId: state.sessionId,
    type,
    actorId,
    message,
  });
}

function requireActive(state) {
  return activeDiplomat(state);
}

function bannedReason(actor) {
  return actor?.banned ? 'Аккаунт заблокирован председателем.' : null;
}

function votingBlocked(state) {
  return openVoting(state)
    ? 'Идёт голосование — изменения состава зала и регистрация заблокированы.'
    : null;
}

function requireChairman(state) {
  const actor = activeDiplomat(state);
  if (!actor || !isChairman(actor)) return { actor: null, reason: 'Действие доступно только председателю.' };
  if (!isSeatedChairman(actor)) return { actor: null, reason: 'Председатель должен занимать место в президиуме.' };
  if (actor.banned) return { actor: null, reason: 'Аккаунт заблокирован.' };
  return { actor, reason: null };
}

// Модерация: председатель в кресле или администратор.
function requireModerator(state) {
  if (isAdminSession()) return { actor: activeDiplomat(state), admin: true, reason: null };
  const chair = requireChairman(state);
  return { ...chair, admin: false };
}

function requireSessionManager(state) {
  if (isAdminSession()) return { ok: true, reason: null };
  const actor = activeDiplomat(state);
  if (actor && isChairman(actor) && isSeatedChairman(actor) && !actor.banned) {
    return { ok: true, reason: null };
  }
  return { ok: false, reason: 'Заседанием управляет председатель в кресле президиума.' };
}

function requireParticipant(state, { seated = false } = {}) {
  const actor = activeDiplomat(state);
  if (!actor) return { actor: null, reason: 'Сначала выберите дипломата.' };
  if (actor.banned) return { actor: null, reason: 'Аккаунт заблокирован председателем.' };
  if (actor.role === 'observer') return { actor: null, reason: 'Наблюдатели не вносят резолюции и правки.' };
  if (seated && !actor.seatId) return { actor: null, reason: 'Действие доступно только из зала.' };
  return { actor, reason: null };
}

/* ------------------------------------------------------------------ */
/* Дипломаты                                                           */
/* ------------------------------------------------------------------ */

const diplomats = {
  list() {
    return get().diplomats.slice();
  },

  async create(data = {}) {
    const state = get();
    const blocked = votingBlocked(state);
    if (blocked) return fail(blocked);

    const fullName = String(data.fullName || '').trim();
    const country = String(data.country || '').trim();
    const authorNick = String(data.authorNick || '').trim();
    const login = String(data.login || '').trim();
    const password = String(data.password || '');
    const type = data.type === 'organization' ? 'organization' : 'country';

    if (!fullName || !country || !authorNick) {
      return fail('Заполните ФИО, страну и ник автора.');
    }
    const loginErr = loginProblem(login);
    if (loginErr) return fail(loginErr);
    if (loginTaken(login)) return fail('Этот логин уже занят.', 'LOGIN_TAKEN');
    const passErr = passwordProblem(password);
    if (passErr) return fail(passErr);

    let passSalt;
    let passHash;
    try {
      passSalt = randomSalt();
      passHash = await hashSecret(password, passSalt);
    } catch {
      return fail('Браузер не поддерживает защищённое хэширование пароля.');
    }

    let isPrimary = false;
    let role = 'delegate';
    let canVote = false;

    if (type === 'country') {
      const taken = countryPrimary(state, country);
      if (taken && !data.asDelegation) {
        return fail(
          `Страна «${country}» уже представлена дипломатом ${taken.fullName}. `
          + 'Повторная регистрация возможна только как член делегации без права голоса.',
          'COUNTRY_TAKEN',
        );
      }
      isPrimary = !taken;
      canVote = isPrimary;
      role = 'delegate';
    } else {
      role = 'observer';
    }

    const diplomat = {
      id: uid('dip'),
      fullName,
      country,
      type,
      flagId: data.flagId || null,
      avatarId: data.avatarId || null,
      description: String(data.description || '').trim(),
      authorNick,
      login,
      passSalt,
      passHash,
      banned: false,
      isPrimary,
      canVote,
      role,
      chairSlot: null,
      seatId: null,
      createdAt: Date.now(),
    };

    commit((s) => {
      s.diplomats.push(diplomat);
      if (!s.activeDiplomatId) s.activeDiplomatId = diplomat.id;
      logEvent(
        s, 'diplomat',
        `Зарегистрирован(а) ${fullName} (${country})${type === 'organization' ? ' — наблюдатель' : isPrimary ? '' : ' — член делегации без права голоса'}.`,
      );
    });

    return ok(diplomat);
  },

  update(id, patch = {}) {
    const state = get();
    const diplomat = state.diplomats.find((d) => d.id === id);
    if (!diplomat) return fail('Дипломат не найден.');

    const allowed = {};
    if (patch.fullName !== undefined) {
      allowed.fullName = String(patch.fullName).trim();
      if (!allowed.fullName) return fail('ФИО не может быть пустым.');
    }
    if (patch.authorNick !== undefined) {
      allowed.authorNick = String(patch.authorNick).trim();
      if (!allowed.authorNick) return fail('Ник автора не может быть пустым.');
    }
    if (patch.description !== undefined) allowed.description = String(patch.description).trim();
    if (patch.flagId !== undefined) allowed.flagId = patch.flagId || null;
    if (patch.avatarId !== undefined) allowed.avatarId = patch.avatarId || null;

    commit((s) => {
      const target = s.diplomats.find((d) => d.id === id);
      Object.assign(target, allowed);
      logEvent(s, 'diplomat', `Изменена анкета дипломата ${target.fullName} (${target.country}).`, id);
    });
    return ok(get().diplomats.find((d) => d.id === id));
  },

  remove(id) {
    const state = get();
    const blocked = votingBlocked(state);
    if (blocked) return fail(blocked);

    const diplomat = state.diplomats.find((d) => d.id === id);
    if (!diplomat) return fail('Дипломат не найден.');

    const actor = activeDiplomat(state);
    const self = actor?.id === id;
    if (!self) {
      const mod = requireModerator(state);
      if (mod.reason) return fail(mod.reason);
      if (isChairman(diplomat) && !mod.admin) {
        return fail('Удалить председателя может только администратор.');
      }
    }

    commit((s) => {
      const target = s.diplomats.find((d) => d.id === id);
      if (target.seatId && s.seating[target.seatId] === id) delete s.seating[target.seatId];
      if (isChairman(target)) {
        target.chairSlot = null;
        logEvent(s, 'chairman', `${target.fullName} выбыл(а) из президиума. Место председателя вакантно.`);
      }
      s.speeches = (s.speeches || []).filter((sp) => sp.diplomatId !== id || sp.status === 'done');
      s.diplomats = s.diplomats.filter((d) => d.id !== id);
      if (s.activeDiplomatId === id) s.activeDiplomatId = s.diplomats[0]?.id || null;

      // Если ушёл глава делегации страны — право голоса переходит
      // самому раннему члену делегации этой страны.
      if (target.type === 'country' && target.isPrimary) {
        const successor = s.diplomats
          .filter((d) => d.type === 'country' && normalizeCountry(d.country) === normalizeCountry(target.country) && !d.isPrimary)
          .sort((a, b) => a.createdAt - b.createdAt)[0];
        if (successor) {
          successor.isPrimary = true;
          successor.canVote = true;
          logEvent(s, 'diplomat', `Право голоса страны «${target.country}» перешло к ${successor.fullName}.`);
        }
      }

      logEvent(s, 'diplomat', `Дипломат ${target.fullName} (${target.country}) удалён.`);
    });
    return ok();
  },

  ban(id, banned = true) {
    const state = get();
    const mod = requireModerator(state);
    if (mod.reason) return fail(mod.reason);
    const target = state.diplomats.find((d) => d.id === id);
    if (!target) return fail('Дипломат не найден.');
    if (target.id === mod.actor?.id) return fail('Нельзя заблокировать самого себя.');
    if (isChairman(target) && !mod.admin) {
      return fail('Заблокировать председателя может только администратор.');
    }

    commit((s) => {
      const d = s.diplomats.find((x) => x.id === id);
      d.banned = Boolean(banned);
      if (banned && d.seatId && !String(d.seatId).startsWith('chair')) {
        delete s.seating[d.seatId];
        d.seatId = null;
      }
      logEvent(
        s, 'diplomat',
        banned
          ? `${d.fullName} (${d.country}) заблокирован(а) председателем: вход и действия в зале закрыты.`
          : `${d.fullName} (${d.country}) разблокирован(а).`,
        mod.actor?.id || null,
      );
    });
    return ok();
  },

  async setPassword(id, password) {
    const state = get();
    const actor = activeDiplomat(state);
    const self = actor?.id === id;
    if (!self && requireModerator(state).reason) {
      return fail('Пароль может сменить сам дипломат или председатель.');
    }
    const target = state.diplomats.find((d) => d.id === id);
    if (!target) return fail('Дипломат не найден.');
    const problem = passwordProblem(password);
    if (problem) return fail(problem);
    let passSalt;
    let passHash;
    try {
      passSalt = randomSalt();
      passHash = await hashSecret(password, passSalt);
    } catch {
      return fail('Браузер не поддерживает защищённое хэширование пароля.');
    }
    commit((s) => {
      const d = s.diplomats.find((x) => x.id === id);
      d.passSalt = passSalt;
      d.passHash = passHash;
      logEvent(s, 'diplomat', `Сменён пароль входа: ${d.fullName} (${d.country}).`, actor?.id || null);
    });
    return ok();
  },
};

/* ------------------------------------------------------------------ */
/* Места и председатель                                                */
/* ------------------------------------------------------------------ */

const seats = {
  occupy(seatId, diplomatId) {
    const state = get();
    const blocked = votingBlocked(state);
    if (blocked) return fail(blocked);

    const match = /^s(\d{1,2})$/.exec(String(seatId));
    const num = match ? Number(match[1]) : 0;
    if (!num || num > Number(state.settings.seatCount || 46)) return fail('Неверный номер места.');

    const diplomat = state.diplomats.find((d) => d.id === diplomatId);
    if (!diplomat) return fail('Дипломат не найден.');
    if (diplomat.banned) return fail('Аккаунт заблокирован председателем.');
    if (diplomat.role === 'chairman') {
      return fail('Председатель занимает отдельное место за столом.');
    }
    if (state.seating[seatId] && state.seating[seatId] !== diplomatId) {
      return fail('Это место уже занято.');
    }

    commit((s) => {
      const d = s.diplomats.find((x) => x.id === diplomatId);
      if (d.seatId && s.seating[d.seatId] === diplomatId) delete s.seating[d.seatId];
      s.seating[seatId] = diplomatId;
      d.seatId = seatId;
      logEvent(s, 'seat', `${d.fullName} (${d.country}) занял(а) место №${num}.`, diplomatId);
    });
    return ok();
  },

  vacate(seatId) {
    const state = get();
    const blocked = votingBlocked(state);
    if (blocked) return fail(blocked);

    if (String(seatId).startsWith('chair')) {
      return fail('Кресло президиума освобождается через отставку председателя.');
    }
    const occupantId = state.seating[seatId];
    if (!occupantId) return fail('Место свободно.');
    const diplomat = state.diplomats.find((d) => d.id === occupantId);

    commit((s) => {
      delete s.seating[seatId];
      const d = s.diplomats.find((x) => x.id === occupantId);
      if (d) {
        const oldSeat = d.seatId;
        d.seatId = null;
        logEvent(s, 'seat', `${d.fullName} (${d.country}) покинул(а) место${oldSeat === 'chair' ? ' председателя' : ''}.`, d.id);
      }
    });
    return ok(diplomat);
  },
};

const chairman = {
  async appoint(diplomatId, code, slot) {
    const state = get();
    if (!(await verifyChairPassword(code))) {
      return fail('Неверный пароль президиума.', 'BAD_CODE');
    }
    const blocked = votingBlocked(state);
    if (blocked) return fail(blocked);

    const target = state.diplomats.find((d) => d.id === diplomatId);
    if (!target) return fail('Дипломат не найден.');
    if (target.banned) return fail('Аккаунт дипломата заблокирован.');
    if (target.type !== 'country' || !target.isPrimary) {
      return fail('В президиум назначается только глава делегации страны с правом голоса.');
    }
    const wantedSlot = Number(slot) === 2 ? 2 : 1;
    if (isChairman(target) && Number(target.chairSlot) === wantedSlot) return ok();

    commit((s) => {
      const occupant = s.diplomats.find(
        (d) => isChairman(d) && Number(d.chairSlot) === wantedSlot && d.id !== target.id,
      );
      if (occupant) {
        occupant.role = 'delegate';
        occupant.chairSlot = null;
        if (occupant.seatId && occupant.seatId.startsWith('chair')) occupant.seatId = null;
        delete s.seating[CHAIR_SEATS[wantedSlot - 1]];
        logEvent(s, 'chairman', `${occupant.fullName} освобождён(а) от должности ${wantedSlot === 2 ? 'сопредседателя' : 'председателя'}.`);
      }

      const d = s.diplomats.find((x) => x.id === diplomatId);
      if (isChairman(d) && d.chairSlot && Number(d.chairSlot) !== wantedSlot) {
        delete s.seating[CHAIR_SEATS[Number(d.chairSlot) - 1]];
      }
      if (d.seatId && s.seating[d.seatId] === d.id) delete s.seating[d.seatId];
      d.role = 'chairman';
      d.chairSlot = wantedSlot;
      d.seatId = CHAIR_SEATS[wantedSlot - 1];
      s.seating[d.seatId] = d.id;
      logEvent(
        s, 'chairman',
        `${d.fullName} (${d.country}) назначен(а) ${wantedSlot === 2 ? 'сопредседателем' : 'председателем'} Асамблеи.`,
        d.id,
      );
    });
    return ok(get().diplomats.find((d) => d.id === diplomatId));
  },

  async release(diplomatId, code) {
    const state = get();
    if (!(await verifyChairPassword(code))) {
      return fail('Неверный пароль президиума.', 'BAD_CODE');
    }
    const blocked = votingBlocked(state);
    if (blocked) return fail(blocked);

    const diplomat = state.diplomats.find((d) => d.id === diplomatId);
    if (!diplomat || !isChairman(diplomat)) return fail('Этот дипломат не входит в президиум.');

    commit((s) => {
      const d = s.diplomats.find((x) => x.id === diplomatId);
      const slot = Number(d.chairSlot) || 1;
      delete s.seating[CHAIR_SEATS[slot - 1]];
      d.role = 'delegate';
      d.chairSlot = null;
      d.seatId = null;
      logEvent(s, 'chairman', `${d.fullName} (${d.country}) сложил(а) полномочия председателя.`);
    });
    return ok();
  },

  async verify(code) {
    return (await verifyChairPassword(code)) ? ok() : fail('Неверный пароль президиума.', 'BAD_CODE');
  },
};

/* ------------------------------------------------------------------ */
/* Активный дипломат и чат                                             */
/* ------------------------------------------------------------------ */

const session = {
  setActive(id) {
    const state = get();
    const diplomat = state.diplomats.find((d) => d.id === id);
    if (id && !diplomat) return fail('Дипломат не найден.');
    if (diplomat?.banned) return fail('Аккаунт заблокирован председателем.');
    commit((s) => { s.activeDiplomatId = id || null; });
    return ok();
  },

  newMeeting() {
    const state = get();
    const allowed = requireSessionManager(state);
    if (!allowed.ok) return fail(allowed.reason);
    const blocked = votingBlocked(state);
    if (blocked) return fail('Нельзя начать новое заседание при открытом голосовании.');

    commit((s) => {
      const match = /№\s*(\d+)/.exec(s.settings.sessionName || '');
      const next = match ? Number(match[1]) + 1 : 1;
      s.settings.sessionName = `Заседание №${next}`;
      s.sessionId = uid('ses');
      s.sessionStartedAt = Date.now();
      s.seating = {};
      s.speeches = [];
      s.timer = { endsAt: null, remainingMs: 0, running: false };
      for (const d of s.diplomats) {
        d.seatId = null;
      }
      for (const chair of chairmenOf(s)) {
        const slot = Number(chair.chairSlot) || 1;
        chair.seatId = CHAIR_SEATS[slot - 1];
        s.seating[chair.seatId] = chair.id;
      }
      logEvent(s, 'session', `Открыто новое заседание: ${s.settings.sessionName}. Зал освобождён, президиум на местах.`);
    });
    return ok();
  },
};

const chat = {
  list() {
    return get().chat.slice();
  },

  send(text, { toId = null } = {}) {
    const state = get();
    const diplomat = requireActive(state);
    if (!diplomat) return fail('Сначала выберите или зарегистрируйте дипломата.');
    if (bannedReason(diplomat)) return fail(bannedReason(diplomat));
    const body = String(text || '').trim();
    if (!body) return fail('Сообщение пустое.');
    if (body.length > 1200) return fail('Сообщение слишком длинное (макс. 1200 символов).');

    let recipient = null;
    if (toId) {
      recipient = state.diplomats.find((d) => d.id === toId);
      if (!recipient) return fail('Получатель шёпота не найден.');
      if (recipient.id === diplomat.id) return fail('Нельзя шептать самому себе.');
    }

    const message = {
      id: uid('msg'),
      diplomatId: diplomat.id,
      snapshot: {
        name: diplomat.fullName,
        country: diplomat.country,
        avatarId: diplomat.avatarId,
        flagId: diplomat.flagId,
        role: diplomat.role,
        canVote: diplomat.canVote,
        chairSlot: diplomat.chairSlot || null,
        authorNick: diplomat.authorNick,
      },
      visibility: recipient ? 'whisper' : 'public',
      toId: recipient?.id || null,
      toSnapshot: recipient ? {
        name: recipient.fullName,
        country: recipient.country,
        avatarId: recipient.avatarId,
      } : null,
      text: body,
      ts: Date.now(),
      sessionId: state.sessionId,
      sessionName: state.settings.sessionName,
    };

    commit((s) => { s.chat.push(message); });
    return ok(message);
  },

  remove(id) {
    const state = get();
    const message = state.chat.find((m) => m.id === id);
    if (!message) return fail('Сообщение не найдено.');
    const actor = activeDiplomat(state);
    const own = actor?.id === message.diplomatId;
    const mod = requireModerator(state);
    if (!own && mod.reason) return fail(mod.reason);

    commit((s) => {
      const msg = s.chat.find((m) => m.id === id);
      const author = s.diplomats.find((d) => d.id === msg.diplomatId);
      s.chat = s.chat.filter((m) => m.id !== id);
      logEvent(
        s, 'system',
        `Сообщение ${author?.fullName || msg.snapshot?.name || 'дипломата'} удалено${msg.visibility === 'whisper' ? ' (шёпот)' : ''}${own ? ' автором' : ' председателем'}.`,
        actor?.id || null,
      );
    });
    return ok();
  },
};

/* ------------------------------------------------------------------ */
/* Очередь выступающих                                                 */
/* ------------------------------------------------------------------ */

const speeches = {
  request(note = '') {
    const state = get();
    const { actor, reason } = requireParticipant(state, { seated: true });
    if (!actor) return fail(reason);
    if (currentSpeaker(state)?.diplomatId === actor.id) {
      return fail('Вы уже выступаете. Передайте слово следующему.');
    }
    if (speechQueue(state).some((s) => s.diplomatId === actor.id)) {
      return fail('Вы уже в очереди на выступление.');
    }
    const text = String(note || '').trim().slice(0, 240);
    const entry = {
      id: uid('spc'),
      diplomatId: actor.id,
      snapshot: {
        name: actor.fullName,
        country: actor.country,
        role: actor.role,
        chairSlot: actor.chairSlot || null,
        avatarId: actor.avatarId,
      },
      note: text,
      status: 'waiting',
      ts: Date.now(),
      sessionId: state.sessionId,
    };
    commit((s) => {
      s.speeches.push(entry);
      logEvent(s, 'speech', `${actor.fullName} (${actor.country}) запросил(а) слово${text ? `: «${text}»` : ''}.`, actor.id);
    });
    return ok(entry);
  },

  cancel(id) {
    const state = get();
    const entry = (state.speeches || []).find((s) => s.id === id);
    if (!entry) return fail('Запись в очереди не найдена.');
    const actor = activeDiplomat(state);
    if (!actor || (actor.id !== entry.diplomatId && !isChairman(actor))) {
      return fail('Снять запрос может сам выступающий или председатель.');
    }
    if (entry.status !== 'waiting') return fail('Этот запрос уже обработан.');
    commit((s) => {
      const target = s.speeches.find((x) => x.id === id);
      target.status = 'cancelled';
      logEvent(s, 'speech', `${target.snapshot.name} снял(а) запрос на слово.`, actor.id);
    });
    return ok();
  },

  grant(id) {
    const state = get();
    const { actor, reason } = requireChairman(state);
    if (!actor) return fail(reason);
    const entry = (state.speeches || []).find((s) => s.id === id && s.status === 'waiting');
    if (!entry) return fail('Выступающий не найден в очереди.');
    commit((s) => {
      for (const sp of s.speeches) if (sp.status === 'speaking') sp.status = 'done';
      const target = s.speeches.find((x) => x.id === id);
      target.status = 'speaking';
      target.startedAt = Date.now();
      const mins = Math.min(60, Math.max(1, Number(s.settings.speechMinutes) || 5));
      s.timer = { endsAt: Date.now() + mins * 60000, remainingMs: mins * 60000, running: true };
      logEvent(s, 'speech', `Слово предоставлено: ${target.snapshot.name} (${target.snapshot.country}). Регламент: ${mins} мин.`, actor.id);
    });
    return ok();
  },

  finish(id) {
    const state = get();
    const entry = (state.speeches || []).find((s) => s.id === id);
    if (!entry) return fail('Выступление не найдено.');
    const actor = activeDiplomat(state);
    if (!actor || (actor.id !== entry.diplomatId && !isChairman(actor))) {
      return fail('Завершить выступление может выступающий или председатель.');
    }
    if (entry.status !== 'speaking') return fail('Это выступление ещё не начато.');
    commit((s) => {
      const target = s.speeches.find((x) => x.id === id);
      target.status = 'done';
      target.finishedAt = Date.now();
      s.timer = { endsAt: null, remainingMs: 0, running: false };
      logEvent(s, 'speech', `Выступление завершено: ${target.snapshot.name}.`, actor.id);
    });
    return ok();
  },
};

/* ------------------------------------------------------------------ */
/* Резолюции и правки                                                  */
/* ------------------------------------------------------------------ */

const resolutions = {
  list() {
    return get().resolutions.slice();
  },

  create(data = {}) {
    const state = get();
    if (openVoting(state)) return fail('Идёт голосование — новую резолюцию выдвинуть нельзя.');
    const { actor: diplomat, reason } = requireParticipant(state);
    if (!diplomat) return fail(reason);

    const text = String(data.text || '').trim();
    if (!text) return fail('Введите текст резолюции.');
    const number = String(data.number || '').trim()
      || `${state.settings.sessionDate.year}/${pad2(state.resolutions.length + 1)}`;
    const topic = String(data.topic || '').trim();

    const resolution = {
      id: uid('res'),
      number,
      topic,
      authorId: diplomat.id,
      authorSnapshot: { name: diplomat.fullName, country: diplomat.country },
      text,
      status: 'draft',
      amendments: [],
      votingId: null,
      resultId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId: state.sessionId,
    };

    commit((s) => {
      s.resolutions.push(resolution);
      logEvent(s, 'resolution', `Выдвинута резолюция №${number}${topic ? ` «${topic}»` : ''} — ${diplomat.fullName} (${diplomat.country}).`, diplomat.id);
    });
    return ok(resolution);
  },

  update(id, patch = {}) {
    const state = get();
    const res = state.resolutions.find((r) => r.id === id);
    if (!res) return fail('Резолюция не найдена.');
    if (res.status !== 'draft') return fail('Редактировать можно только черновик резолюции.');

    const actor = requireActive(state);
    if (bannedReason(actor)) return fail(bannedReason(actor));
    if (!actor || (actor.id !== res.authorId && !isChairman(actor))) {
      return fail('Редактировать резолюцию может автор или председатель.');
    }

    const next = {};
    if (patch.number !== undefined) {
      next.number = String(patch.number).trim() || res.number;
    }
    if (patch.topic !== undefined) next.topic = String(patch.topic).trim();
    if (patch.text !== undefined) {
      next.text = String(patch.text).trim();
      if (!next.text) return fail('Текст резолюции не может быть пустым.');
    }

    commit((s) => {
      const target = s.resolutions.find((r) => r.id === id);
      Object.assign(target, next, { updatedAt: Date.now() });
      logEvent(s, 'resolution', `Резолюция №${target.number} отредактирована.`, actor.id);
    });
    return ok();
  },

  remove(id) {
    const state = get();
    const res = state.resolutions.find((r) => r.id === id);
    if (!res) return fail('Резолюция не найдена.');
    const mod = requireModerator(state);
    if (mod.reason) return fail('Удалить резолюцию может председатель в кресле президиума.');
    if (openVoting(state)?.resolutionId === id) {
      return fail('Сначала закройте голосование по этой резолюции.');
    }
    if (res.status === 'voting') return fail('Сначала закройте голосование по этой резолюции.');

    commit((s) => {
      s.resolutions = s.resolutions.filter((r) => r.id !== id);
      logEvent(
        s, 'resolution',
        `Резолюция №${res.number}${res.topic ? ` «${res.topic}»` : ''} удалена председателем.`,
        mod.actor?.id || null,
      );
    });
    return ok();
  },
};

const amendments = {
  propose(resolutionId, text) {
    const state = get();
    if (openVoting(state)) return fail('Идёт голосование — предложить правку нельзя.');
    const res = state.resolutions.find((r) => r.id === resolutionId);
    if (!res) return fail('Резолюция не найдена.');
    if (res.status !== 'draft') return fail('Правки принимаются только к черновику.');

    const { actor, reason } = requireParticipant(state, { seated: true });
    if (!actor) return fail(reason);

    const body = String(text || '').trim();
    if (!body) return fail('Введите текст правки.');

    const amendment = {
      id: uid('amd'),
      resolutionId,
      authorId: actor.id,
      authorSnapshot: { name: actor.fullName, country: actor.country },
      text: body,
      status: 'proposed',
      order: (res.amendments.reduce((max, a) => Math.max(max, a.order), 0) || 0) + 1,
      votingId: null,
      createdAt: Date.now(),
    };

    commit((s) => {
      s.resolutions.find((r) => r.id === resolutionId).amendments.push(amendment);
      logEvent(s, 'amendment', `К резолюции №${res.number} предложена правка №${amendment.order} — ${actor.fullName} (${actor.country}).`, actor.id);
    });
    return ok(amendment);
  },

  withdraw(resolutionId, amendmentId) {
    const state = get();
    const res = state.resolutions.find((r) => r.id === resolutionId);
    const amendment = res?.amendments.find((a) => a.id === amendmentId);
    if (!res || !amendment) return fail('Правка не найдена.');
    if (amendment.status !== 'proposed') return fail('Отозвать можно только предложенную правку.');
    const actor = requireActive(state);
    if (!actor || actor.id !== amendment.authorId) return fail('Отозвать правку может только её автор.');

    commit((s) => {
      const target = s.resolutions.find((r) => r.id === resolutionId).amendments.find((a) => a.id === amendmentId);
      target.status = 'withdrawn';
      logEvent(s, 'amendment', `Правка №${target.order} к резолюции №${res.number} отозвана автором.`, actor.id);
    });
    return ok();
  },
};

/* ------------------------------------------------------------------ */
/* Голосования                                                         */
/* ------------------------------------------------------------------ */

const voting = {
  open(targetType, targetId) {
    const state = get();
    const { actor, reason } = requireChairman(state);
    if (!actor) return fail(reason);
    if (openVoting(state)) return fail('Уже идёт голосование.');

    const q = quorumInfo(state);
    if (!q.met) return fail(`Кворум не соблюдён: присутствуют ${q.present} из ${q.total}, требуется ${q.required}.`);

    let resolution = null;
    let amendment = null;
    let label = '';

    if (targetType === 'amendment') {
      resolution = state.resolutions.find((r) => r.amendments.some((a) => a.id === targetId));
      amendment = resolution?.amendments.find((a) => a.id === targetId);
      if (!resolution || !amendment) return fail('Правка не найдена.');
      if (resolution.status !== 'draft') return fail('Резолюция уже рассмотрена.');
      if (amendment.status !== 'proposed') return fail('По этой правке нельзя открыть голосование.');
      label = `Правка №${amendment.order} к резолюции №${resolution.number}`;
    } else {
      resolution = state.resolutions.find((r) => r.id === targetId);
      if (!resolution) return fail('Резолюция не найдена.');
      const check = chairmanCanOpenResolution(state, resolution);
      if (!check.ok) return fail(check.reason);
      label = `Резолюция №${resolution.number}`;
    }

    const eligible = eligibleCountries(state);
    if (!eligible.length) return fail('В зале нет стран с правом голоса.');

    const votingRecord = {
      id: uid('vot'),
      targetType,
      targetId,
      resolutionId: resolution.id,
      label,
      status: 'open',
      openedBy: actor.id,
      openedAt: Date.now(),
      closedAt: null,
      eligible,
      ballots: {},
      tally: null,
    };

    commit((s) => {
      s.votings.push(votingRecord);
      const res = s.resolutions.find((r) => r.id === resolution.id);
      if (targetType === 'amendment') {
        res.amendments.find((a) => a.id === targetId).status = 'voting';
        res.amendments.find((a) => a.id === targetId).votingId = votingRecord.id;
      } else {
        res.status = 'voting';
        res.votingId = votingRecord.id;
      }
      logEvent(s, 'voting', `Голосование открыто: ${label}.`, actor.id);
    });

    playGong('vote-open');
    return ok(votingRecord);
  },

  cast(choice) {
    const state = get();
    const current = openVoting(state);
    if (!current) return fail('Нет открытого голосования.');
    if (!['for', 'against', 'abstain'].includes(choice)) return fail('Неверный вариант голоса.');

    const actor = requireActive(state);
    if (!actor) return fail('Сначала выберите дипломата.');
    if (actor.banned) return fail('Аккаунт заблокирован председателем.');
    if (!actor.canVote) return fail('Наблюдатели и члены делегаций без права голоса не голосуют.');
    if (!actor.seatId) return fail('Голосовать можно только из зала.');
    if (!current.eligible.some((c) => normalizeCountry(c) === normalizeCountry(actor.country))) {
      return fail('Ваша страна не участвует в этом голосовании.');
    }
    if (current.ballots[actor.country]?.vote === choice) return ok();

    commit((s) => {
      const v = s.votings.find((x) => x.id === current.id);
      v.ballots[actor.country] = {
        vote: choice,
        diplomatId: actor.id,
        country: actor.country,
        ts: Date.now(),
      };
      logEvent(s, 'voting', `${actor.country}: голос — ${VOTE_LABEL[choice]}.`, actor.id);
    });
    return ok();
  },

  close() {
    const state = get();
    const current = openVoting(state);
    if (!current) return fail('Нет открытого голосования.');
    const { actor, reason } = requireChairman(state);
    if (!actor) return fail(reason);

    const tally = tallyFor(current, state);
    const resolution = state.resolutions.find((r) => r.id === current.resolutionId);
    if (!resolution) return fail('Резолюция не найдена.');

    let amendment = null;
    if (current.targetType === 'amendment') {
      amendment = resolution.amendments.find((a) => a.id === current.targetId);
    }

    commit((s) => {
      const v = s.votings.find((x) => x.id === current.id);
      v.status = 'closed';
      v.closedAt = Date.now();
      v.tally = tally;

      const res = s.resolutions.find((r) => r.id === current.resolutionId);
      if (current.targetType === 'amendment') {
        const am = res.amendments.find((a) => a.id === current.targetId);
        am.status = tally.adopted ? 'adopted' : 'rejected';
      } else {
        res.status = tally.adopted ? 'adopted' : 'rejected';
        res.resultId = v.id;
        res.updatedAt = Date.now();
      }

      // Лист итогов — в архив при каждом закрытии
      const sheetPayload = buildSheetPayload(v, s);
      s.archive.push({
        id: uid('doc'),
        kind: 'ballot-sheet',
        resolutionId: res.id,
        number: res.number,
        topic: sheetPayload.topic,
        result: tally.adopted ? 'adopted' : 'rejected',
        withAmendments: false,
        amendmentsCount: 0,
        createdAt: Date.now(),
        sessionId: s.sessionId,
        payload: sheetPayload,
      });

      if (current.targetType === 'resolution') {
        const docPayload = buildResolutionDocPayload(res, v, s);
        s.archive.push({
          id: uid('doc'),
          kind: 'resolution-doc',
          resolutionId: res.id,
          number: res.number,
          topic: docPayload.topic,
          result: res.status,
          withAmendments: docPayload.withAmendments,
          amendmentsCount: docPayload.amendmentsCount,
          createdAt: Date.now(),
          sessionId: s.sessionId,
          payload: docPayload,
        });
        logEvent(s, 'archive', `Документ ${docPayload.docNo} отправлен в архив (резолюция №${res.number}).`);
      }

      const summary = `ЗА ${tally.for}, ПРОТИВ ${tally.against}, ВОЗДЕРЖАЛИСЬ ${tally.abstain}`
        + `${tally.quorumMet ? '' : ' — кворум не соблюдён'}`;
      logEvent(
        s, 'voting',
        `Голосование закрыто: ${v.label} — ${tally.adopted ? 'ПРИНЯТО' : 'ОТКЛОНЕНО'} (${summary}).`,
        actor.id,
      );
    });

    playGong('vote-close');
    const doc = get().archive.filter((d) => d.kind === 'resolution-doc' && d.payload.votingId === current.id)[0] || null;
    const sheet = get().archive.filter((d) => d.kind === 'ballot-sheet' && d.payload.votingId === current.id)[0] || null;
    return ok({
      adopted: tally.adopted,
      targetType: current.targetType,
      resolutionId: current.resolutionId,
      doc,
      sheet,
      tally,
    });
  },
};

/* ------------------------------------------------------------------ */
/* Таймер регламента                                                   */
/* ------------------------------------------------------------------ */

const timer = {
  start(minutes) {
    const state = get();
    const { actor, reason } = requireChairman(state);
    if (!actor) return fail(reason || 'Таймером управляет президиум.');
    const mins = Math.min(60, Math.max(1, Number(minutes) || state.settings.speechMinutes || 5));
    const ms = mins * 60000;
    commit((s) => {
      s.timer = { endsAt: Date.now() + ms, remainingMs: ms, running: true };
      logEvent(s, 'timer', `Регламент выступления: ${mins} мин. Отсчёт запущен.`, actor.id);
    });
    return ok(get().timer);
  },

  pause() {
    const state = get();
    const { actor, reason } = requireChairman(state);
    if (!actor) return fail(reason || 'Таймером управляет президиум.');
    if (!state.timer.running) return ok();
    commit((s) => {
      s.timer.remainingMs = Math.max(0, s.timer.endsAt - Date.now());
      s.timer.running = false;
      s.timer.endsAt = null;
      logEvent(s, 'timer', 'Отсчёт регламента приостановлен.', actor.id);
    });
    return ok(get().timer);
  },

  resume() {
    const state = get();
    const { actor, reason } = requireChairman(state);
    if (!actor) return fail(reason || 'Таймером управляет президиум.');
    if (state.timer.running) return ok(get().timer);
    if (!state.timer.remainingMs) return fail('Нет приостановленного отсчёта.');
    commit((s) => {
      s.timer.endsAt = Date.now() + s.timer.remainingMs;
      s.timer.running = true;
      logEvent(s, 'timer', 'Отсчёт регламента продолжен.', actor.id);
    });
    return ok(get().timer);
  },

  reset() {
    const state = get();
    const { actor, reason } = requireChairman(state);
    if (!actor) return fail(reason || 'Таймером управляет президиум.');
    commit((s) => {
      s.timer = { endsAt: null, remainingMs: 0, running: false };
      logEvent(s, 'timer', 'Таймер регламента сброшен.', actor.id);
    });
    return ok();
  },

  complete() {
    const state = get();
    if (!state.timer.running) return ok();
    commit((s) => {
      s.timer = { endsAt: null, remainingMs: 0, running: false };
      logEvent(s, 'timer', 'Регламент выступления истёк.');
    });
    playGong('timer');
    return ok();
  },
};

/* ------------------------------------------------------------------ */
/* Настройки, архив, журнал, бэкап                                     */
/* ------------------------------------------------------------------ */

const settings = {
  update(patch = {}) {
    const state = get();
    const changesSession = Object.keys(patch).some((key) => key !== 'soundOn');
    if (changesSession && !requireSessionManager(state).ok) {
      return fail('Параметры заседания меняет председатель в кресле президиума.');
    }
    const s = state.settings;
    const next = {};

    if (patch.sessionName !== undefined) {
      const name = String(patch.sessionName).trim().slice(0, 80);
      if (name) next.sessionName = name;
    }
    if (patch.sessionDate) {
      const month = Number(patch.sessionDate.month);
      const year = Number(patch.sessionDate.year);
      if (month >= 0 && month <= 11 && year >= 1900 && year <= 2100) {
        next.sessionDate = { month, year };
      }
    }
    if (patch.quorumMode !== undefined) {
      next.quorumMode = patch.quorumMode === 'fixed' ? 'fixed' : 'percent';
    }
    if (patch.quorumValue !== undefined) {
      next.quorumValue = Math.max(1, Math.min(100, Number(patch.quorumValue) || 50));
    }
    if (patch.speechMinutes !== undefined) {
      next.speechMinutes = Math.max(1, Math.min(60, Number(patch.speechMinutes) || 5));
    }
    if (patch.soundOn !== undefined) next.soundOn = Boolean(patch.soundOn);

    commit((st) => { Object.assign(st.settings, next); });
    return ok(get().settings);
  },

};

const archive = {
  list() {
    return get().archive.slice().sort((a, b) => b.createdAt - a.createdAt);
  },
  get(id) {
    return get().archive.find((d) => d.id === id) || null;
  },
  latestSheet() {
    return get().archive
      .filter((d) => d.kind === 'ballot-sheet')
      .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  },
  forResolution(resolutionId) {
    return get().archive.filter((d) => d.resolutionId === resolutionId);
  },

  remove(id) {
    if (!isAdminSession()) return fail('Удалять архивные документы может только администратор.');
    const state = get();
    const doc = state.archive.find((d) => d.id === id);
    if (!doc) return fail('Документ не найден.');
    commit((s) => {
      s.archive = s.archive.filter((d) => d.id !== id);
      logEvent(s, 'archive', `Архивный документ ${doc.number || doc.id} удалён администратором.`);
    });
    return ok();
  },

  clear() {
    if (!isAdminSession()) return fail('Очищать архив может только администратор.');
    const count = get().archive.length;
    commit((s) => {
      s.archive = [];
      logEvent(s, 'archive', `Архив очищен администратором (документов: ${count}).`);
    });
    return ok();
  },

  createProtocol() {
    const state = get();
    const { actor, reason } = requireChairman(state);
    if (!actor) return fail(reason);
    if (openVoting(state)) return fail('Сначала закройте идущее голосование.');

    const seq = state.archive.filter((d) => d.kind === 'session-protocol').length + 1;
    const docNo = `ПРТ-${state.settings.sessionDate.year}-${pad3(seq)}`;
    const chairs = chairmenOf(state).map((d) => ({
      name: d.fullName,
      country: d.country,
      role: Number(d.chairSlot) === 2 ? 'Сопредседатель' : 'Председатель',
    }));
    const present = state.diplomats.filter((d) => d.seatId).length;
    const entries = state.journal
      .filter((e) => e.sessionId === state.sessionId)
      .slice(-160)
      .map((e) => ({ ts: e.ts, type: e.type, message: e.message }));

    const payload = {
      kind: 'session-protocol',
      docNo,
      sessionName: state.settings.sessionName,
      sessionDateLabel: dateLabel(state.settings.sessionDate),
      sessionStartedAt: state.sessionStartedAt,
      generatedAt: Date.now(),
      chairs,
      preparedBy: { name: actor.fullName, country: actor.country, role: chairSlotLabel(actor.chairSlot) },
      stats: {
        diplomats: state.diplomats.length,
        present,
        seated: state.diplomats.filter((d) => d.seatId && !String(d.seatId).startsWith('chair')).length,
        observers: state.diplomats.filter((d) => d.role === 'observer').length,
        resolutions: state.resolutions.length,
        adopted: state.resolutions.filter((r) => r.status === 'adopted').length,
        rejected: state.resolutions.filter((r) => r.status === 'rejected').length,
        votings: state.votings.length,
        documents: state.archive.length,
        messages: state.chat.filter((m) => m.sessionId === state.sessionId).length,
      },
      entries,
    };

    const doc = {
      id: uid('doc'),
      kind: 'session-protocol',
      resolutionId: null,
      number: docNo,
      topic: 'Протокол заседания',
      result: null,
      withAmendments: false,
      amendmentsCount: 0,
      createdAt: Date.now(),
      sessionId: state.sessionId,
      payload,
    };

    commit((s) => {
      s.archive.push(doc);
      logEvent(s, 'archive', `Сформирован протокол заседания ${docNo} и отправлен в архив.`, actor.id);
    });
    return ok(doc);
  },
};

const journal = {
  list() {
    return get().journal.slice().reverse();
  },
};

/* ------------------------------------------------------------------ */
/* Администратор: зал, президиум, пароли, модерация                    */
/* ------------------------------------------------------------------ */

const admin = {
  setSeatCount(value) {
    if (!isAdminSession()) return fail('Требуется вход администратора.');
    const count = Math.round(Number(value) || 0);
    if (count < SEAT_MIN || count > SEAT_MAX) {
      return fail(`Мест в зале: от ${SEAT_MIN} до ${SEAT_MAX}.`);
    }
    const state = get();
    if (openVoting(state)) return fail('Идёт голосование — схему зала менять нельзя.');
    let freed = 0;
    commit((s) => {
      s.settings.seatCount = count;
      for (const [seatId, id] of Object.entries(s.seating)) {
        const match = /^s(\d+)$/.exec(seatId);
        if (!match || Number(match[1]) <= count) continue;
        delete s.seating[seatId];
        const d = s.diplomats.find((x) => x.id === id);
        if (d) d.seatId = null;
        freed += 1;
      }
      logEvent(
        s, 'system',
        `Схема зала изменена: ${count} мест${freed ? `, освобождено мест за пределами схемы: ${freed}` : ''}.`,
      );
    });
    return ok(get().settings.seatCount);
  },

  async setChairPassword(next) {
    if (!isAdminSession()) return fail('Требуется вход администратора.');
    const problem = passwordProblem(next);
    if (problem) return fail(problem);
    let salt;
    let hash;
    try {
      salt = randomSalt();
      hash = await hashSecret(next, salt);
    } catch {
      return fail('Браузер не поддерживает защищённое хэширование.');
    }
    commit((s) => {
      s.settings.chairSalt = salt;
      s.settings.chairHash = hash;
      logEvent(s, 'system', 'Пароль президиума изменён администратором (хранится только хэш).');
    });
    return ok();
  },

  async setAdminPassword(adminId, next) {
    if (!isAdminSession()) return fail('Требуется вход администратора.');
    const state = get();
    const target = state.admins.find((a) => a.id === adminId);
    if (!target) return fail('Администратор не найден.');
    const problem = passwordProblem(next);
    if (problem) return fail(problem);
    let salt;
    let hash;
    try {
      salt = randomSalt();
      hash = await hashSecret(next, salt);
    } catch {
      return fail('Браузер не поддерживает защищённое хэширование.');
    }
    commit((s) => {
      const a = s.admins.find((x) => x.id === adminId);
      a.salt = salt;
      a.hash = hash;
      logEvent(s, 'system', `Пароль администратора ${a.login} изменён.`);
    });
    return ok();
  },

  appointChair(diplomatId, slot) {
    if (!isAdminSession()) return fail('Требуется вход администратора.');
    const state = get();
    if (openVoting(state)) return fail('Идёт голосование — состав президиума менять нельзя.');
    const target = state.diplomats.find((d) => d.id === diplomatId);
    if (!target) return fail('Дипломат не найден.');
    if (target.banned) return fail('Аккаунт дипломата заблокирован.');
    if (target.type !== 'country' || !target.isPrimary) {
      return fail('В президиум назначается только глава делегации страны с правом голоса.');
    }
    const wantedSlot = Number(slot) === 2 ? 2 : 1;

    commit((s) => {
      const occupant = s.diplomats.find(
        (d) => isChairman(d) && Number(d.chairSlot) === wantedSlot && d.id !== target.id,
      );
      if (occupant) {
        occupant.role = 'delegate';
        occupant.chairSlot = null;
        if (occupant.seatId && occupant.seatId.startsWith('chair')) occupant.seatId = null;
        delete s.seating[CHAIR_SEATS[wantedSlot - 1]];
        logEvent(s, 'chairman', `${occupant.fullName} освобождён(а) от должности ${wantedSlot === 2 ? 'сопредседателя' : 'председателя'}.`);
      }
      const d = s.diplomats.find((x) => x.id === diplomatId);
      if (isChairman(d) && d.chairSlot && Number(d.chairSlot) !== wantedSlot) {
        delete s.seating[CHAIR_SEATS[Number(d.chairSlot) - 1]];
      }
      if (d.seatId && s.seating[d.seatId] === d.id) delete s.seating[d.seatId];
      d.role = 'chairman';
      d.chairSlot = wantedSlot;
      d.seatId = CHAIR_SEATS[wantedSlot - 1];
      s.seating[d.seatId] = d.id;
      logEvent(
        s, 'chairman',
        `${d.fullName} (${d.country}) назначен(а) ${wantedSlot === 2 ? 'сопредседателем' : 'председателем'} администратором.`,
        d.id,
      );
    });
    return ok();
  },

  releaseChair(diplomatId) {
    if (!isAdminSession()) return fail('Требуется вход администратора.');
    const state = get();
    if (openVoting(state)) return fail('Идёт голосование — состав президиума менять нельзя.');
    const diplomat = state.diplomats.find((d) => d.id === diplomatId);
    if (!diplomat || !isChairman(diplomat)) return fail('Этот дипломат не входит в президиум.');

    commit((s) => {
      const d = s.diplomats.find((x) => x.id === diplomatId);
      const slot = Number(d.chairSlot) || 1;
      delete s.seating[CHAIR_SEATS[slot - 1]];
      d.role = 'delegate';
      d.chairSlot = null;
      d.seatId = null;
      logEvent(s, 'chairman', `${d.fullName} (${d.country}) освобождён(а) от должности администратором.`);
    });
    return ok();
  },

  setBanned(id, banned) {
    if (!isAdminSession()) return fail('Требуется вход администратора.');
    return diplomats.ban(id, banned);
  },
};

const backup = {
  async exportJson() {
    const state = get();
    const images = await exportImages();
    const data = JSON.stringify({
      app: 'omb-assembly',
      version: 1,
      exportedAt: new Date().toISOString(),
      state,
      images,
    }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    downloadBlob(blob, `OMB_архив_${new Date().toISOString().slice(0, 10)}.json`);
    return ok();
  },

  async importJson(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail('Файл не является корректным JSON.');
    }
    const incoming = parsed.state || parsed;
    if (!incoming || !Array.isArray(incoming.diplomats) || !Array.isArray(incoming.archive)) {
      return fail('Это не файл резервной копии Асамблеи ОМБ.');
    }
    replaceState(incoming);
    if (parsed.images) await importImages(parsed.images);

    const state = get();
    if (state.activeDiplomatId && !state.diplomats.some((d) => d.id === state.activeDiplomatId)) {
      commit((s) => { s.activeDiplomatId = s.diplomats[0]?.id || null; });
    }
    commit((s) => {
      logEvent(s, 'system', 'Импортирован резервный архив (JSON).');
    });
    return ok();
  },
};

/* ------------------------------------------------------------------ */
/* Публичный API                                                       */
/* ------------------------------------------------------------------ */

export const api = {
  diplomats,
  seats: {
    ...seats,
    vacate: seats.vacate,
  },
  chairman,
  session,
  chat,
  speeches,
  resolutions,
  voting,
  amendments: {
    propose: amendments.propose,
    withdraw: amendments.withdraw,
  },
  timer,
  settings,
  archive,
  journal,
  admin,
  backup,
  helpers: {
    quorumInfo,
    requiredQuorum,
    chairmenOf,
    chairmanAt,
    isChairman,
    isSeatedChairman,
    openVoting,
    eligibleCountries,
    isVotingCountry,
    tallyFor,
    activeDiplomat,
    speechQueue,
    currentSpeaker,
  },
};
