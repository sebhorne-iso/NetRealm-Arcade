// Tiny chiptune engine on the Web Audio API: pulse/triangle/noise channels, a look-ahead
// sequencer for looping music, and synthesized sound effects. No audio files needed.

const NOTE_INDEX = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

export function noteFreq(name) {
  const m = /^([A-G](?:#|b)?)(-?\d)$/.exec(name);
  if (!m) return null;
  const midi = 12 * (Number(m[2]) + 1) + NOTE_INDEX[m[1]];
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function parseSeq(str) {
  return str
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      const [n, d] = tok.split(':');
      return { n, d: Number(d || 1) };
    });
}

export function seqLength(str) {
  return parseSeq(str).reduce((s, x) => s + x.d, 0);
}

// ---------- songs (durations in 16th-note steps) ----------
const rep = (s, n) => Array(n).fill(s).join(' ');
export const SONGS = {
  title: {
    bpm: 112,
    lead: `E5:4 G5:4 C6:6 B5:2 A5:4 G5:4 E5:6 D5:2 C5:4 E5:4 A5:6 G5:2 F5:4 A5:4 G5:8
           E5:4 G5:4 C6:6 D6:2 E6:4 D6:4 B5:6 G5:2 A5:4 C6:4 F5:4 A5:4 G5:12 -:4`,
    bass: `${rep('C3:2 G3:2', 4)} ${rep('G2:2 D3:2', 4)} ${rep('A2:2 E3:2', 4)} ${rep('F2:2 C3:2', 4)}
           ${rep('C3:2 G3:2', 4)} ${rep('G2:2 D3:2', 4)} ${rep('F2:2 C3:2', 4)} ${rep('G2:2 D3:2', 4)}`,
    drums: rep('k:2 h:2 s:2 h:2 k:2 h:2 s:2 h:2', 8),
  },
  map: {
    bpm: 104,
    lead: `A4:2 C5:2 F5:4 E5:2 D5:2 C5:4 G4:2 C5:2 E5:4 D5:2 C5:2 G4:4 A4:2 D5:2 F5:4 E5:2 F5:2 A5:4 Bb5:4 A5:2 G5:2 F5:4 D5:4
           A4:2 C5:2 F5:4 G5:2 A5:2 C6:4 Bb5:2 A5:2 G5:4 E5:2 G5:2 C5:4 D5:2 F5:2 A5:4 G5:2 F5:2 D5:4 C5:4 A4:4 F4:8`,
    bass: `${rep('F2:4 C3:4', 2)} ${rep('C3:4 G2:4', 2)} ${rep('D3:4 A2:4', 2)} ${rep('Bb2:4 F2:4', 2)}
           ${rep('F2:4 C3:4', 2)} ${rep('C3:4 G2:4', 2)} ${rep('D3:4 A2:4', 2)} ${rep('C3:4 G2:4', 1)} F2:8`,
    drums: rep('k:4 h:4 s:4 h:2 h:2', 8),
  },
  battle: {
    bpm: 150,
    lead: `A4:2 C5:2 E5:2 A5:2 G5:2 E5:2 C5:2 E5:2 A4:2 C5:2 E5:2 A5:2 B5:2 A5:2 G5:2 E5:2
           F5:2 A5:2 C6:2 A5:2 F5:2 A5:2 C6:4 G5:2 B5:2 D6:2 B5:2 G5:4 D5:4
           A5:3 G5:1 E5:4 A5:3 G5:1 E5:4 C6:2 B5:2 A5:2 G5:2 E5:4 -:4
           F5:2 E5:2 F5:2 A5:2 C6:4 A5:4 G#5:4 B5:4 E6:6 -:2`,
    bass: `${rep('A2:2', 8)} ${rep('A2:2', 8)} ${rep('F2:2', 8)} ${rep('G2:2', 8)} ${rep('A2:2', 8)} ${rep('A2:2', 8)} ${rep('F2:2', 8)} ${rep('E2:2', 8)}`,
    drums: rep('k:2 h:2 s:2 h:2 k:2 k:2 s:2 h:2', 8),
  },
  boss: {
    bpm: 164,
    lead: `E5:1 -:1 E5:1 -:1 G5:2 E5:2 B5:4 A#5:2 A5:2 G5:2 F#5:2 E5:2 D#5:2 E5:4 B4:4
           C5:2 E5:2 G5:2 C6:2 B5:2 G5:2 E5:4 D#5:2 F#5:2 B5:2 D#6:2 B5:4 F#5:4
           E6:2 D6:2 B5:2 G5:2 E5:4 G5:4 F#5:2 G5:2 A5:2 B5:2 E5:8
           C6:2 B5:2 A5:2 G5:2 E5:2 G5:2 C6:4 B5:4 A#5:4 B5:4 D#6:4`,
    bass: `${rep('E2:2 E3:2', 4)} ${rep('E2:2 E3:2', 4)} ${rep('C2:2 C3:2', 4)} ${rep('B1:2 B2:2', 4)}
           ${rep('E2:2 E3:2', 4)} ${rep('E2:2 E3:2', 4)} ${rep('C2:2 C3:2', 4)} ${rep('B1:2 B2:2', 4)}`,
    drums: rep('k:1 k:1 h:2 s:2 h:2 k:2 h:2 s:2 h:2', 8),
  },
};

class Chip {
  constructor() {
    this.ctx = null;
    this.musicVol = 0.45;
    this.sfxVol = 0.7;
    this.muted = false;
    this.current = null;
    this.timer = null;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return true;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.musicGain = this.ctx.createGain();
    this.sfxGain = this.ctx.createGain();
    this.musicGain.connect(this.master);
    this.sfxGain.connect(this.master);
    this.applyVolumes();
    this.pulse25 = this.makePulse(0.25);
    this.pulse125 = this.makePulse(0.125);
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      this.play(p);
    }
    return true;
  }

  makePulse(duty) {
    const n = 64;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    for (let i = 1; i < n; i++) real[i] = (2 / (i * Math.PI)) * Math.sin(i * Math.PI * duty);
    return this.ctx.createPeriodicWave(real, imag);
  }

  setVolumes({ music, sfx, muted }) {
    if (music != null) this.musicVol = music;
    if (sfx != null) this.sfxVol = sfx;
    if (muted != null) this.muted = muted;
    this.applyVolumes();
  }

  applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 1, t, 0.02);
    this.musicGain.gain.setTargetAtTime(this.musicVol * 0.35, t, 0.02);
    this.sfxGain.gain.setTargetAtTime(this.sfxVol * 0.5, t, 0.02);
  }

  tone({ freq, type = 'square', wave, start, dur, vol = 0.3, dest, slideTo, attack = 0.005, release = 0.05 }) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    if (wave) osc.setPeriodicWave(wave);
    else osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), start + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(vol, start + attack);
    g.gain.setValueAtTime(vol, Math.max(start + attack, start + dur - release));
    g.gain.linearRampToValueAtTime(0, start + dur);
    osc.connect(g).connect(dest || this.sfxGain);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  noiseHit({ start, dur, vol = 0.3, filter = 'highpass', freq = 6000, dest }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, start);
    g.gain.exponentialRampToValueAtTime(0.001, start + dur);
    src.connect(f).connect(g).connect(dest || this.sfxGain);
    src.start(start, Math.random() * 0.5);
    src.stop(start + dur + 0.02);
  }

  // ---------- music ----------
  play(name) {
    if (this.current?.name === name) return;
    this.stop();
    if (!this.ctx) {
      this.pending = name;
      return;
    }
    const song = SONGS[name];
    if (!song) return;
    const step = 60 / song.bpm / 4;
    const start = this.ctx.currentTime + 0.08;
    const chans = ['lead', 'bass', 'drums'].map((ch) => ({ ch, seq: parseSeq(song[ch]), i: 0, t: start }));
    this.current = { name, chans, step };
    this.timer = setInterval(() => this.schedule(), 40);
    this.schedule();
  }

  stop() {
    this.pending = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.current = null;
  }

  schedule() {
    if (!this.current || !this.ctx) return;
    const ahead = this.ctx.currentTime + 0.2;
    const { chans, step } = this.current;
    for (const c of chans) {
      // If the tab was hidden for a while, skip ahead instead of firing a burst of notes.
      if (c.t < this.ctx.currentTime - 0.5) c.t = this.ctx.currentTime + 0.05;
      while (c.t < ahead) {
        const ev = c.seq[c.i];
        const dur = ev.d * step;
        if (ev.n !== '-') this.musicNote(c.ch, ev.n, c.t, dur);
        c.t += dur;
        c.i = (c.i + 1) % c.seq.length;
      }
    }
  }

  musicNote(ch, n, t, dur) {
    const dest = this.musicGain;
    if (ch === 'drums') {
      if (n === 'k') this.tone({ freq: 150, slideTo: 40, type: 'sine', start: t, dur: 0.12, vol: 0.7, dest });
      else if (n === 's') this.noiseHit({ start: t, dur: 0.1, vol: 0.35, filter: 'bandpass', freq: 1800, dest });
      else if (n === 'h') this.noiseHit({ start: t, dur: 0.035, vol: 0.18, filter: 'highpass', freq: 7000, dest });
      return;
    }
    const f = noteFreq(n);
    if (!f) return;
    if (ch === 'lead') this.tone({ freq: f, wave: this.pulse25, start: t, dur: dur * 0.92, vol: 0.16, dest, release: 0.04 });
    else this.tone({ freq: f, type: 'triangle', start: t, dur: dur * 0.85, vol: 0.4, dest, release: 0.03 });
  }

  // ---------- sound effects ----------
  sfx(name) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + 0.01;
    const seq = (notes, d, opts = {}) => notes.forEach((n, i) => this.tone({ freq: noteFreq(n), wave: this.pulse25, start: t + i * d, dur: d * (opts.hold && i === notes.length - 1 ? 4 : 1), vol: opts.vol || 0.22 }));
    switch (name) {
      case 'select':
        this.tone({ freq: 880, wave: this.pulse125, start: t, dur: 0.04, vol: 0.12 });
        break;
      case 'confirm':
        seq(['E6', 'B6'], 0.05, { vol: 0.14 });
        break;
      case 'type':
        this.tone({ freq: 1200 + Math.random() * 400, type: 'square', start: t, dur: 0.012, vol: 0.03 });
        break;
      case 'correct':
        seq(['C6', 'E6', 'G6', 'C7'], 0.055, { vol: 0.18 });
        break;
      case 'wrong':
        this.tone({ freq: 260, type: 'sawtooth', slideTo: 90, start: t, dur: 0.3, vol: 0.18 });
        break;
      case 'hit':
        this.noiseHit({ start: t, dur: 0.12, vol: 0.5, filter: 'lowpass', freq: 2500 });
        this.tone({ freq: 220, type: 'square', slideTo: 60, start: t, dur: 0.12, vol: 0.2 });
        break;
      case 'crit':
        this.noiseHit({ start: t, dur: 0.18, vol: 0.6, filter: 'lowpass', freq: 3500 });
        this.tone({ freq: 330, type: 'square', slideTo: 60, start: t, dur: 0.15, vol: 0.22 });
        this.tone({ freq: 1760, wave: this.pulse25, start: t + 0.08, dur: 0.18, vol: 0.12 });
        break;
      case 'hurt':
        this.tone({ freq: 400, type: 'square', slideTo: 80, start: t, dur: 0.25, vol: 0.2 });
        this.noiseHit({ start: t, dur: 0.15, vol: 0.3, filter: 'bandpass', freq: 900 });
        break;
      case 'block':
        this.tone({ freq: 1000, type: 'triangle', start: t, dur: 0.05, vol: 0.3 });
        this.tone({ freq: 1500, type: 'triangle', start: t + 0.05, dur: 0.12, vol: 0.2 });
        break;
      case 'heal':
        seq(['G5', 'C6', 'E6', 'G6'], 0.06, { vol: 0.14 });
        break;
      case 'skill':
        this.tone({ freq: 300, wave: this.pulse25, slideTo: 1800, start: t, dur: 0.25, vol: 0.14 });
        break;
      case 'coin':
        this.tone({ freq: noteFreq('B5'), type: 'square', start: t, dur: 0.07, vol: 0.12 });
        this.tone({ freq: noteFreq('E6'), type: 'square', start: t + 0.07, dur: 0.22, vol: 0.12 });
        break;
      case 'levelup':
        seq(['C5', 'E5', 'G5', 'C6', 'E6', 'G6', 'C7'], 0.06, { vol: 0.18, hold: true });
        break;
      case 'victory':
        seq(['G5', 'G5', 'G5', 'E5', 'C6'], 0.1, { vol: 0.2, hold: true });
        break;
      case 'defeat':
        ['G4', 'E4', 'C4', 'G3'].forEach((n, i) => this.tone({ freq: noteFreq(n), type: 'triangle', start: t + i * 0.22, dur: 0.24, vol: 0.35 }));
        break;
      case 'achievement':
        seq(['A5', 'C#6', 'E6', 'A6'], 0.07, { vol: 0.16, hold: true });
        break;
      case 'boss':
        this.tone({ freq: 55, type: 'sawtooth', slideTo: 40, start: t, dur: 1.2, vol: 0.3 });
        this.noiseHit({ start: t, dur: 1.0, vol: 0.3, filter: 'lowpass', freq: 400 });
        break;
    }
  }
}

export const audio = new Chip();
