// Бизнес-правила: роли, право голоса, кворум, подсчёт итогов.
// Все функции чистые — не изменяют состояние.

import { normalizeCountry } from './utils.js';

export const CHAIR_SEATS = { 1: 'chair1', 2: 'chair2' };

export const isVotingCountry = (d) => d.type === 'country' && d.isPrimary;
export const isChairman = (d) => d?.role === 'chairman';
export const isObserver = (d) => d?.role === 'observer';

export function votingCountries(state) {
  return state.diplomats.filter(isVotingCountry);
}

export function presentVotingCountries(state) {
  // Председатели в своих креслах также представляют страну и сохраняют голос.
  return votingCountries(state).filter((d) => Boolean(d.seatId));
}

export function countryPrimary(state, country) {
  return state.diplomats.find(
    (d) => d.type === 'country' && d.isPrimary && normalizeCountry(d.country) === normalizeCountry(country),
  );
}

/* ------------------------------------------------------------------ */
/* Президиум: ровно два председателя                                   */
/* ------------------------------------------------------------------ */

export function chairmenOf(state) {
  return state.diplomats
    .filter(isChairman)
    .sort((a, b) => (a.chairSlot || 9) - (b.chairSlot || 9));
}

export function chairmanOf(state) {
  return chairmenOf(state)[0] || null;
}

export function chairmanAt(state, slot) {
  return chairmenOf(state).find((d) => Number(d.chairSlot) === Number(slot)) || null;
}

export function isSeatedChairman(diplomat) {
  return Boolean(diplomat && isChairman(diplomat)
    && diplomat.seatId === CHAIR_SEATS[Number(diplomat.chairSlot) || 1]);
}

export function seatedChairmen(state) {
  return chairmenOf(state).filter(isSeatedChairman);
}

export function chairSlotLabel(slot) {
  return Number(slot) === 2 ? 'Сопредседатель' : 'Председатель';
}

/* ------------------------------------------------------------------ */
/* Кворум и голосование                                                */
/* ------------------------------------------------------------------ */

export function requiredQuorum(state) {
  const total = votingCountries(state).length;
  if (!total) return 0;
  const settings = state.settings;
  if (settings.quorumMode === 'fixed') {
    return Math.min(total, Math.max(1, Number(settings.quorumValue) || 1));
  }
  const pct = Math.min(100, Math.max(1, Number(settings.quorumValue) || 50));
  return Math.floor((total * pct) / 100) + 1;
}

export function quorumInfo(state) {
  const total = votingCountries(state).length;
  const present = presentVotingCountries(state).length;
  const required = requiredQuorum(state);
  return { total, present, required, met: total > 0 && present >= required };
}

export function openVoting(state) {
  return state.votings.find((v) => v.status === 'open') || null;
}

export function activeDiplomat(state) {
  return state.diplomats.find((d) => d.id === state.activeDiplomatId) || null;
}

export function eligibleCountries(state) {
  return presentVotingCountries(state)
    .map((d) => d.country)
    .sort((a, b) => a.localeCompare(b, 'ru'));
}

export function canCastVote(state, diplomat) {
  const voting = openVoting(state);
  if (!voting || !diplomat) return { ok: false, reason: 'Нет открытого голосования.' };
  if (!diplomat.canVote) return { ok: false, reason: 'Дипломат не имеет права голоса.' };
  if (!diplomat.seatId) return { ok: false, reason: 'Дипломат не находится в зале.' };
  if (isObserver(diplomat)) return { ok: false, reason: 'Наблюдатели не голосуют.' };
  if (!voting.eligible.some((c) => normalizeCountry(c) === normalizeCountry(diplomat.country))) {
    return { ok: false, reason: 'Страна не участвует в этом голосовании.' };
  }
  return { ok: true };
}

// Текущий подсчёт по снапшоту eligible: так закрытие и «живой» лист совпадают.
export function tallyFor(voting, state) {
  const counts = { for: 0, against: 0, abstain: 0, notVoted: 0 };
  const byVote = { for: [], against: [], abstain: [], notVoted: [] };
  for (const country of voting.eligible) {
    const ballot = voting.ballots[country];
    const key = ballot ? ballot.vote : 'notVoted';
    counts[key] += 1;
    byVote[key].push(country);
  }
  const required = requiredQuorum(state);
  const present = voting.eligible.length;
  const quorumMet = required > 0 && present >= required;
  const adopted = quorumMet && counts.for > counts.against;
  return {
    ...counts,
    byVote,
    required,
    present,
    quorumMet,
    adopted,
    tie: quorumMet && counts.for === counts.against,
  };
}

// Идут ли по резолюции нерешённые правки.
export function pendingAmendments(resolution) {
  return resolution.amendments.filter((a) => a.status === 'proposed' || a.status === 'voting');
}

export function chairmanCanOpenResolution(state, resolution) {
  const chairs = seatedChairmen(state);
  if (!chairs.length) return { ok: false, reason: 'Ни один председатель не занимает место в президиуме.' };
  if (openVoting(state)) return { ok: false, reason: 'Уже идёт другое голосование.' };
  if (!resolution || resolution.status !== 'draft') return { ok: false, reason: 'Резолюция уже рассмотрена.' };
  const pending = pendingAmendments(resolution);
  if (pending.length) {
    return { ok: false, reason: `Сначала завершите голосование по правкам (${pending.length}).` };
  }
  const q = quorumInfo(state);
  if (!q.met) return { ok: false, reason: `Кворум не соблюдён: ${q.present}/${q.total}, нужно ${q.required}.` };
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Очередь выступающих                                                 */
/* ------------------------------------------------------------------ */

export function speechQueue(state) {
  return (state.speeches || [])
    .filter((s) => s.status === 'waiting')
    .sort((a, b) => a.ts - b.ts);
}

export function currentSpeaker(state) {
  return (state.speeches || []).find((s) => s.status === 'speaking') || null;
}

export function speechStatusFor(state, diplomatId) {
  return (state.speeches || []).find(
    (s) => s.diplomatId === diplomatId && (s.status === 'waiting' || s.status === 'speaking'),
  ) || null;
}
