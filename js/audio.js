// Гонг собрания: синтез WebAudio, без аудиофайлов.

import { get } from './store.js';

let ctx = null;
let lastPlayed = 0;

function ensureContext() {
  if (!ctx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    ctx = new AudioCtx();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/**
 * Удар гонга. kind: 'vote-open' | 'vote-close' | 'timer' | 'soft'
 */
export function playGong(kind = 'vote-open') {
  const state = get();
  if (!state.settings.soundOn) return;

  const audio = ensureContext();
  if (!audio) return;

  const now = audio.currentTime;
  if (now - lastPlayed < 0.35) return; // защита от двойных ударов
  lastPlayed = now;

  const strikes = kind === 'vote-close' ? [0, 0.55] : [0];
  const baseFreq = kind === 'timer' ? 131 : kind === 'vote-close' ? 110 : 147;

  const master = audio.createGain();
  master.gain.value = kind === 'soft' ? 0.16 : 0.3;
  master.connect(audio.destination);

  for (const offset of strikes) {
    const t0 = now + offset;
    const partials = [
      { ratio: 1, gain: 0.55, decay: 2.6 },
      { ratio: 2.01, gain: 0.22, decay: 2.0 },
      { ratio: 2.98, gain: 0.14, decay: 1.6 },
      { ratio: 4.05, gain: 0.07, decay: 1.1 },
    ];
    for (const p of partials) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = baseFreq * p.ratio;
      osc.detune.value = (Math.random() - 0.5) * 6;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(p.gain, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + p.decay);
      osc.connect(gain).connect(master);
      osc.start(t0);
      osc.stop(t0 + p.decay + 0.05);
    }
  }
}

export function unlockAudio() {
  ensureContext();
}
