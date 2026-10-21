// Lull audio engine — Web Audio, fully offline.
// Every rhythmic element is either an oscillator or a looped buffer on the audio
// clock, so nothing depends on JavaScript timers once a session is running.

export const RHYTHMS = {
  '2:3': [2, 3],
  '3:4': [3, 4],
  '2:3:5': [2, 3, 5],
  '3:4:5': [3, 4, 5],
  '4:5:7': [4, 5, 7],
  '5:7:9': [5, 7, 9],
  '3:5:7:8': [3, 5, 7, 8],
};

// Harmony sets. `field` = drone partials (ratios of the key), `pulse` = pulse-voice pitches.
export const CHORDS = {
  overtone: { name: 'Overtone', field: [1, 2, 3, 4, 5, 6, 7], pulse: [4, 5, 6, 7] },
  fifths: { name: 'Open fifths', field: [1, 1.5, 2, 3, 4, 6], pulse: [3, 4, 4.5, 6] },
  minor: { name: 'Minor', field: [1, 1.5, 2, 2.4, 3, 3.6], pulse: [3, 3.6, 4.5, 4.8] },
  penta: { name: 'Pentatonic', field: [1, 1.5, 2, 2.25, 3, 10 / 3], pulse: [3, 10 / 3, 4, 4.5] },
};

// Pulse timbres: [frequency multiple, relative amplitude, decay multiple]
export const TONES = {
  soft: { attack: 0.025, partials: [[1, 1, 1], [2, 0.12, 0.45]] },
  glass: { attack: 0.012, partials: [[1, 1, 1], [2, 0.3, 0.8], [3, 0.12, 0.6]] },
  bell: { attack: 0.004, partials: [[1, 1, 1], [2.756, 0.32, 0.45], [5.404, 0.12, 0.22], [0.5, 0.15, 1.2]] },
};

export const PANS = { 1: [0], 2: [-0.7, 0.7], 3: [-0.8, 0, 0.8], 4: [-0.9, -0.3, 0.3, 0.9] };

const TAU = Math.PI * 2;
const mod = (a, n) => ((a % n) + n) % n;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const SR_STORE = 48000; // all mantras are stored at this rate

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- shared math (also used by the visualizer) ----------

// Swell rate of each drone partial, in cycles per rhythm cycle.
export function fieldRates(rhythm, n) {
  const r = RHYTHMS[rhythm] || RHYTHMS['3:4:5'];
  const out = [1];
  for (let j = 1; j < n; j++) {
    const base = r[(j - 1) % r.length];
    out.push(j - 1 >= r.length ? base / 2 : base);
  }
  return out;
}

export function shapePower(shape) {
  return 1 + shape * 11;
}

export function droneAmps(chord) {
  const f = (CHORDS[chord] || CHORDS.overtone).field;
  const a = f.map((_, j) => 1 / (1 + 0.55 * j));
  const s = a.reduce((x, y) => x + y, 0);
  return a.map((x) => x / s);
}

export function droneDepth(depth, j) {
  return depth * (j === 0 ? 0.4 : 1);
}

export function pulseVoices(st) {
  const r = RHYTHMS[st.rhythm] || RHYTHMS['3:4:5'];
  const chord = CHORDS[st.chord] || CHORDS.overtone;
  return r.map((n, i) => ({
    hits: n * st.pulse.density,
    freq: st.root * st.pulse.register * chord.pulse[i % chord.pulse.length],
    pan: r.length === 1 ? 0 : -0.75 + (1.5 * i) / (r.length - 1),
  }));
}

export function pulseCycles(st) {
  return st.pulse.variation > 0.001 ? clamp(Math.floor(40 / st.cycle), 1, 4) : 1;
}

// Pattern of hits (no audio) — used by the visualizer when stopped and by the renderer.
export function pulsePattern(st) {
  const voices = pulseVoices(st);
  const K = pulseCycles(st);
  const T = st.cycle;
  const rand = mulberry32(st.pulse.seed || 1);
  const v = st.pulse.variation;
  const hits = [];
  voices.forEach((vo, vi) => {
    for (let c = 0; c < K; c++) {
      for (let h = 0; h < vo.hits; h++) {
        const r1 = rand();
        const r2 = rand();
        const down = h === 0;
        if (!down && r1 < v * 0.45) continue;
        const vel = (down ? 1 : 0.6) * (1 - v * 0.35 * r2);
        hits.push({ v: vi, h, c, t: c * T + (h * T) / vo.hits, vel });
      }
    }
  });
  return { voices, K, T, length: K * T, hits };
}

function addNote(Lb, Rb, sr, t, f, amp, tone, ring, gl, gr) {
  const N = Lb.length;
  const start = Math.round(t * sr);
  const att = Math.max(1, Math.round(tone.attack * sr));
  for (const [mult, pa, dm] of tone.partials) {
    const fr = f * mult;
    if (fr > sr * 0.45 || fr < 20) continue;
    const tau = Math.max(0.02, (ring * dm) / 6.9);
    const dur = Math.min(N, att + Math.round(ring * dm * 1.15 * sr));
    const dec = Math.exp(-1 / (tau * sr));
    const w = (TAU * fr) / sr;
    const k = 2 * Math.cos(w);
    let y1 = Math.sin(-w);
    let y2 = Math.sin(-2 * w);
    let envd = 1;
    const a = amp * pa;
    let idx = start % N;
    for (let n = 0; n < dur; n++) {
      const y = k * y1 - y2;
      y2 = y1;
      y1 = y;
      let e;
      if (n < att) e = n / att;
      else {
        e = envd;
        envd *= dec;
      }
      const s = y * e * a;
      Lb[idx] += s * gl;
      Rb[idx] += s * gr;
      idx++;
      if (idx === N) idx = 0;
    }
  }
}

export function renderPulse(sr, st) {
  const pat = pulsePattern(st);
  const L = Math.max(1, Math.round(pat.length * sr));
  const Lb = new Float32Array(L);
  const Rb = new Float32Array(L);
  const tone = TONES[st.pulse.tone] || TONES.soft;
  for (const h of pat.hits) {
    const vo = pat.voices[h.v];
    const ang = ((vo.pan + 1) * Math.PI) / 4;
    addNote(Lb, Rb, sr, h.t, vo.freq, h.vel * 0.2, tone, st.pulse.ring, Math.cos(ang), Math.sin(ang));
  }
  let peak = 0;
  for (let i = 0; i < L; i++) {
    const a = Math.abs(Lb[i]);
    const b = Math.abs(Rb[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  if (peak > 0.9) {
    const g = 0.9 / peak;
    for (let i = 0; i < L; i++) {
      Lb[i] *= g;
      Rb[i] *= g;
    }
  }
  return { ...pat, L: Lb, R: Rb, length: L / sr };
}

function noiseChannel(color, n, rand) {
  const out = new Float32Array(n);
  if (color === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = rand() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    }
  } else {
    let b = 0;
    for (let i = 0; i < n; i++) {
      const w = rand() * 2 - 1;
      b = (b + 0.02 * w) / 1.02;
      out[i] = b;
    }
  }
  let ss = 0;
  for (let i = 0; i < n; i++) ss += out[i] * out[i];
  const g = 0.12 / Math.sqrt(ss / n || 1);
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

export function makeNoiseData(color, sr, seconds = 12, seed = 7) {
  const L = Math.round(sr * seconds);
  const F = Math.round(sr * 1);
  const rand = mulberry32(seed);
  const chans = [];
  for (let ch = 0; ch < 2; ch++) {
    const raw = noiseChannel(color, L + F, rand);
    const out = new Float32Array(L);
    for (let i = 0; i < L; i++) {
      if (i < F) {
        const x = i / F;
        out[i] = raw[i] * Math.sqrt(x) + raw[L + i] * Math.sqrt(1 - x);
      } else out[i] = raw[i];
    }
    chans.push(out);
  }
  return chans;
}

export function makeIRData(sr, seconds, seed = 3) {
  const pre = Math.round(sr * 0.02);
  const L = Math.round(sr * seconds);
  const rand = mulberry32(seed);
  const chans = [];
  for (let ch = 0; ch < 2; ch++) {
    const d = new Float32Array(pre + L);
    let lp = 0;
    const fadeIn = Math.round(sr * 0.004);
    for (let i = 0; i < L; i++) {
      const t = i / sr;
      const env = Math.exp((-6.9 * t) / seconds);
      const coeff = 0.08 + 0.85 * Math.min(1, t / seconds); // tail gets darker
      const w = rand() * 2 - 1;
      lp += (w - lp) * (1 - coeff);
      const fi = i < fadeIn ? i / fadeIn : 1;
      d[pre + i] = lp * env * fi;
    }
    chans.push(d);
  }
  return chans;
}

// Lucid cue sound as mono PCM at `sr`.
export function makeCueData(kind, sr, root, mantraPCM) {
  if (kind !== 'chime' && mantraPCM && mantraPCM.length) {
    // mantra with a soft baked-in echo and gentle low-pass
    const d1 = Math.round(sr * 0.38);
    const d2 = Math.round(sr * 0.76);
    const n = mantraPCM.length + d2 + Math.round(sr * 0.5);
    const out = new Float32Array(n);
    for (let i = 0; i < mantraPCM.length; i++) {
      out[i] += mantraPCM[i];
      out[i + d1] += mantraPCM[i] * 0.35;
      out[i + d2] += mantraPCM[i] * 0.15;
    }
    let lp = 0;
    for (let i = 0; i < n; i++) {
      lp += (out[i] - lp) * 0.35;
      out[i] = lp * 0.8;
    }
    const fade = Math.round(sr * 0.08);
    for (let i = 0; i < fade && i < n; i++) out[i] *= i / fade;
    return out;
  }
  const n = Math.round(sr * 7);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  let base = root;
  while (base < 330) base *= 2;
  [1, 5 / 4, 3 / 2].forEach((m, i) => addNote(L, R, sr, 0.05 + i * 0.55, base * m, 0.35, TONES.glass, 4.5, 0.7, 0.7));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (L[i] + R[i]) * 0.5;
  return out;
}

// ---------- engine ----------

function G(ctx, v = 1) {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

function smooth(param, value, ctx, tc = 0.06) {
  const now = ctx.currentTime;
  param.cancelScheduledValues(now);
  param.setTargetAtTime(value, now, tc);
}

function fadeOutAndStop(ctx, gainNode, sources, dur) {
  const now = ctx.currentTime;
  const gp = gainNode.gain;
  gp.cancelScheduledValues(now);
  gp.setTargetAtTime(0, now, dur / 4);
  for (const s of sources) {
    try {
      s.stop(now + dur + 0.1);
    } catch (e) {
      /* already stopped */
    }
  }
  setTimeout(() => {
    try {
      gainNode.disconnect();
    } catch (e) {
      /* ignore */
    }
  }, (dur + 0.4) * 1000);
}

function fadeIn(ctx, gainNode, at, dur, to = 1) {
  gainNode.gain.setValueAtTime(0, at);
  gainNode.gain.linearRampToValueAtTime(to, at + dur);
}

export const LAYER_MAX = { voice: 0.62, drone: 0.6, pulse: 1.4, beats: 0.16, noise: 1.0 };

export function warmthHz(w) {
  // 0..1 → 900 Hz .. 20 kHz (log)
  return 900 * Math.pow(20000 / 900, w);
}

export class Engine {
  constructor() {
    this.ctx = null;
    this.playing = false;
    this.onstate = null;
    this.cueSources = [];
  }

  // Call synchronously from a tap. `mantras` = Map(id → {pcm: Float32Array @48k}).
  start(state, mantras, opts = {}) {
    if (this.playing) this.stop(0.05);
    if (!opts.context && typeof navigator !== 'undefined' && navigator.audioSession) {
      try {
        navigator.audioSession.type = 'playback';
      } catch (e) {
        /* older iOS */
      }
    }
    const AC = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
    const ctx = opts.context || new AC({ latencyHint: 'playback' });
    this.ctx = ctx;
    this.offline = !!opts.context;
    if (ctx.resume && !this.offline) ctx.resume().catch(() => {});
    if (!this.offline) {
      ctx.onstatechange = () => ctx === this.ctx && this.onstate && this.onstate(ctx.state);
    }
    this.state = JSON.parse(JSON.stringify(state));
    this.mantras = mantras || new Map();
    this.playing = true;

    const now = ctx.currentTime;
    this.t0 = now + 0.06;
    this.sessionStart = now - (opts.elapsed || 0);
    this._prevCycle = this.state.cycle;

    // master chain
    this.out = G(ctx, 0);
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;
    this.masterLP = ctx.createBiquadFilter();
    this.masterLP.type = 'lowpass';
    this.masterLP.Q.value = 0;
    this.masterLP.frequency.value = warmthHz(this.state.sleep.warmth);
    this.windLP = ctx.createBiquadFilter();
    this.windLP.type = 'lowpass';
    this.windLP.Q.value = 0;
    this.windLP.frequency.value = 20000;
    this.masterSum = G(ctx, 1);
    this.masterSum.connect(this.masterLP);
    this.masterLP.connect(this.windLP);
    this.windLP.connect(this.limiter);
    this.limiter.connect(this.out);
    this.out.connect(ctx.destination);
    this.out.gain.setValueAtTime(0, now);
    this.out.gain.linearRampToValueAtTime(1, now + 4);

    this.sessionGain = G(ctx, 1);
    this.sessionGain.connect(this.masterSum);
    this.cueBus = G(ctx, 1);
    this.cueBus.connect(this.masterSum);

    // keep-alive: inaudible noise (~-74 dB) so iOS never sees a silent session
    const ka = this._noiseSource('brown');
    const kag = G(ctx, 0.0002);
    ka.connect(kag);
    kag.connect(this.masterSum);
    ka.start(now);
    this.keepAlive = ka;

    this.revIn = G(ctx, 1);
    this.rev = null;
    this._buildReverb(0);

    this._buildDrone();
    this._buildPulse();
    this._buildBeats();
    this._buildNoise();
    this._buildVoice();
    this._applyLevels(true);
    this.scheduleSession();
    return ctx;
  }

  stop(fade = 2.5) {
    if (!this.ctx || !this.playing) return;
    const ctx = this.ctx;
    this.playing = false;
    const now = ctx.currentTime;
    const g = this.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + fade);
    if (!this.offline) {
      setTimeout(() => {
        try {
          ctx.close();
        } catch (e) {
          /* ignore */
        }
      }, (fade + 0.3) * 1000);
    }
    this.ctx = ctx; // keep reference for visualizer until closed
  }

  resume() {
    if (this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed') return this.ctx.resume();
    return Promise.resolve();
  }

  get time() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  // ---------- reverb ----------
  _buildReverb(fade) {
    const ctx = this.ctx;
    const size = this.state.voice.size;
    const conv = ctx.createConvolver();
    const data = makeIRData(ctx.sampleRate, size);
    const buf = ctx.createBuffer(2, data[0].length, ctx.sampleRate);
    buf.getChannelData(0).set(data[0]);
    buf.getChannelData(1).set(data[1]);
    conv.buffer = buf;
    const ret = G(ctx, fade ? 0 : 1);
    this.revIn.connect(conv);
    conv.connect(ret);
    ret.connect(this.sessionGain);
    if (fade && this.rev) {
      const old = this.rev;
      const now = ctx.currentTime;
      fadeIn(ctx, ret, now, fade);
      old.ret.gain.cancelScheduledValues(now);
      old.ret.gain.setValueAtTime(old.ret.gain.value, now);
      old.ret.gain.linearRampToValueAtTime(0, now + fade);
      setTimeout(() => {
        try {
          this.revIn.disconnect(old.conv);
        } catch (e) {
          /* ignore */
        }
        try {
          old.conv.disconnect();
          old.ret.disconnect();
        } catch (e) {
          /* ignore */
        }
      }, (fade + 0.5) * 1000);
    }
    this.rev = { conv, ret };
  }

  // ---------- drone ----------
  _buildDrone() {
    const ctx = this.ctx;
    const d = { level: G(ctx, 0), bus: G(ctx, 1), send: G(ctx, 0), group: null };
    d.bus.connect(d.level);
    d.level.connect(this.sessionGain);
    d.level.connect(d.send);
    d.send.connect(this.revIn);
    d.send.gain.value = this.state.drone.bloom * 0.9;
    this.drone = d;
    this._droneGroup(0);
  }

  _shapeCurve(shape) {
    const p = shapePower(shape);
    const n = 1025;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = -1 + (2 * i) / (n - 1);
      c[i] = Math.pow((1 + x) / 2, p);
    }
    return c;
  }

  // cosine LFO whose phase lines up with the shared cycle origin t0
  _lfoWave(rateHz, startAt) {
    const phi = TAU * rateHz * (startAt - this.t0);
    return this.ctx.createPeriodicWave(new Float32Array([0, Math.cos(phi)]), new Float32Array([0, -Math.sin(phi)]));
  }

  _droneGroup(fade) {
    const ctx = this.ctx;
    const st = this.state;
    const chord = (CHORDS[st.chord] || CHORDS.overtone).field;
    const amps = droneAmps(st.chord);
    const rates = fieldRates(st.rhythm, chord.length);
    const curve = this._shapeCurve(st.drone.shape);
    const ts = Math.max(ctx.currentTime + 0.03, this.t0);
    const out = G(ctx, fade ? 0 : 1);
    const parts = chord.map((ratio, j) => {
      const osc = ctx.createOscillator();
      osc.frequency.value = st.root * ratio;
      const depth = droneDepth(st.drone.depth, j);
      const vca = G(ctx, amps[j] * (1 - depth));
      const lfo = ctx.createOscillator();
      const rate = rates[j] / st.cycle;
      lfo.setPeriodicWave(this._lfoWave(rate, ts));
      lfo.frequency.value = rate;
      const shaper = ctx.createWaveShaper();
      shaper.curve = curve;
      const dg = G(ctx, amps[j] * depth);
      lfo.connect(shaper);
      shaper.connect(dg);
      dg.connect(vca.gain);
      const pan = ctx.createStereoPanner();
      pan.pan.value = j === 0 ? 0 : (j % 2 ? -1 : 1) * (0.2 + (0.6 * j) / chord.length);
      osc.connect(vca);
      vca.connect(pan);
      pan.connect(out);
      osc.start(ts);
      lfo.start(ts);
      return { osc, lfo, vca, dg, shaper, ratio, amp: amps[j], j };
    });
    out.connect(this.drone.bus);
    const old = this.drone.group;
    if (fade) {
      fadeIn(ctx, out, ts, fade);
      if (old) fadeOutAndStop(ctx, old.out, old.parts.flatMap((p) => [p.osc, p.lfo]), fade);
    }
    this.drone.group = { out, parts };
  }

  _droneDepthShape(swapShape) {
    const ctx = this.ctx;
    const st = this.state;
    const grp = this.drone.group;
    if (!grp) return;
    const curve = swapShape ? this._shapeCurve(st.drone.shape) : null;
    for (const p of grp.parts) {
      const depth = droneDepth(st.drone.depth, p.j);
      smooth(p.vca.gain, p.amp * (1 - depth), ctx, 0.1);
      if (swapShape) {
        const sh = ctx.createWaveShaper();
        sh.curve = curve;
        const dg2 = G(ctx, 0);
        p.lfo.connect(sh);
        sh.connect(dg2);
        dg2.connect(p.vca.gain);
        const now = ctx.currentTime;
        dg2.gain.setValueAtTime(0, now);
        dg2.gain.linearRampToValueAtTime(p.amp * depth, now + 0.4);
        const oldDg = p.dg;
        const oldSh = p.shaper;
        oldDg.gain.cancelScheduledValues(now);
        oldDg.gain.setValueAtTime(oldDg.gain.value, now);
        oldDg.gain.linearRampToValueAtTime(0, now + 0.4);
        setTimeout(() => {
          try {
            p.lfo.disconnect(oldSh);
          } catch (e) {
            /* ignore */
          }
          try {
            oldSh.disconnect();
            oldDg.disconnect();
          } catch (e) {
            /* ignore */
          }
        }, 700);
        p.dg = dg2;
        p.shaper = sh;
      } else {
        smooth(p.dg.gain, p.amp * depth, ctx, 0.1);
      }
    }
  }

  // ---------- pulse ----------
  _buildPulse() {
    const ctx = this.ctx;
    const p = { level: G(ctx, 0), send: G(ctx, this.state.pulse.space * 1.1), cur: null };
    p.level.connect(this.sessionGain);
    p.level.connect(p.send);
    p.send.connect(this.revIn);
    this.pulse = p;
    this._pulseRender(0);
  }

  _pulseRender(fade) {
    const ctx = this.ctx;
    const r = renderPulse(ctx.sampleRate, this.state);
    const buf = ctx.createBuffer(2, r.L.length, ctx.sampleRate);
    buf.getChannelData(0).set(r.L);
    buf.getChannelData(1).set(r.R);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = G(ctx, fade ? 0 : 1);
    src.connect(g);
    g.connect(this.pulse.level);
    const ts = Math.max(ctx.currentTime + 0.04, this.t0);
    src.start(ts, mod(ts - this.t0, r.length));
    const old = this.pulse.cur;
    if (fade) {
      fadeIn(ctx, g, ts, fade);
      if (old) fadeOutAndStop(ctx, old.g, [old.src], fade);
    }
    this.pulse.cur = { src, g };
    this.pattern = { voices: r.voices, K: r.K, T: r.T, length: r.length, hits: r.hits };
  }

  // ---------- beats ----------
  _buildBeats() {
    const ctx = this.ctx;
    this.beats = { level: G(ctx, 0), group: null };
    this.beats.level.connect(this.sessionGain);
    this._beatsGroup(0);
  }

  _beatsGroup(fade) {
    const ctx = this.ctx;
    const b = this.state.beats;
    const out = G(ctx, fade ? 0 : 1);
    const ts = ctx.currentTime + 0.03;
    const srcs = [];
    const grp = { out, mode: b.mode };
    if (b.mode === 'pulsed') {
      const osc = ctx.createOscillator();
      osc.frequency.value = b.carrier;
      const vca = G(ctx, 0);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = b.beat;
      const sh = ctx.createWaveShaper();
      sh.curve = this._shapeCurve(0.15);
      const dg = G(ctx, 1);
      lfo.connect(sh);
      sh.connect(dg);
      dg.connect(vca.gain);
      osc.connect(vca);
      vca.connect(out);
      srcs.push(osc, lfo);
      grp.osc = osc;
      grp.lfo = lfo;
    } else {
      const a = ctx.createOscillator();
      const c = ctx.createOscillator();
      a.frequency.value = b.carrier - b.beat / 2;
      c.frequency.value = b.carrier + b.beat / 2;
      if (b.mode === 'binaural') {
        const m = ctx.createChannelMerger(2);
        a.connect(m, 0, 0);
        c.connect(m, 0, 1);
        m.connect(out);
      } else {
        const h = G(ctx, 0.5);
        a.connect(h);
        c.connect(h);
        h.connect(out);
      }
      srcs.push(a, c);
      grp.a = a;
      grp.c = c;
    }
    srcs.forEach((s) => s.start(ts));
    grp.srcs = srcs;
    out.connect(this.beats.level);
    const old = this.beats.group;
    if (fade) {
      fadeIn(ctx, out, ts, fade);
      if (old) fadeOutAndStop(ctx, old.out, old.srcs, fade);
    }
    this.beats.group = grp;
    this._beatFreqs();
  }

  _beatFreqs() {
    const ctx = this.ctx;
    const g = this.beats && this.beats.group;
    if (!g) return;
    const b = this.state.beats;
    const now = ctx.currentTime;
    const set = (beatNow, beatEnd, tEnd) => {
      const pairs =
        g.mode === 'pulsed'
          ? [[g.osc.frequency, () => b.carrier], [g.lfo.frequency, (x) => x]]
          : [[g.a.frequency, (x) => b.carrier - x / 2], [g.c.frequency, (x) => b.carrier + x / 2]];
      for (const [param, fn] of pairs) {
        param.cancelScheduledValues(now);
        param.setValueAtTime(param.value, now);
        param.linearRampToValueAtTime(fn(beatNow), now + 0.15);
        if (tEnd) param.linearRampToValueAtTime(fn(beatEnd), tEnd);
      }
    };
    if (b.glide && this.timerEnd && this.timerEnd > now + 1) {
      this._beatGlideFrom = b.beat;
      this._beatGlideT = now;
      set(b.beat, b.glideTo, this.timerEnd);
    } else {
      this._beatGlideFrom = null;
      this._beatGlideT = null;
      set(b.beat, null, null);
    }
  }

  // ---------- noise ----------
  _noiseSource(color) {
    const ctx = this.ctx;
    const data = makeNoiseData(color, ctx.sampleRate, color === 'brown' ? 10 : 12, color === 'brown' ? 11 : 7);
    const buf = ctx.createBuffer(2, data[0].length, ctx.sampleRate);
    buf.getChannelData(0).set(data[0]);
    buf.getChannelData(1).set(data[1]);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    return src;
  }

  _buildNoise() {
    const ctx = this.ctx;
    const st = this.state;
    const n = { level: G(ctx, 0), lp: ctx.createBiquadFilter(), vca: G(ctx, 1), src: null, srcG: null, wave: null };
    n.lp.type = 'lowpass';
    n.lp.Q.value = 0;
    n.lp.frequency.value = st.noise.tone;
    n.lp.connect(n.vca);
    n.vca.connect(n.level);
    n.level.connect(this.sessionGain);
    this.noise = n;
    this._noiseSrc(0);
    this._noiseWaves(0);
  }

  _noiseSrc(fade) {
    const ctx = this.ctx;
    const src = this._noiseSource(this.state.noise.color);
    const g = G(ctx, fade ? 0 : 1);
    src.connect(g);
    g.connect(this.noise.lp);
    const ts = ctx.currentTime + 0.03;
    src.start(ts);
    const old = this.noise.srcG ? { g: this.noise.srcG, src: this.noise.src } : null;
    if (fade) {
      fadeIn(ctx, g, ts, fade);
      if (old) fadeOutAndStop(ctx, old.g, [old.src], fade);
    }
    this.noise.src = src;
    this.noise.srcG = g;
  }

  _noiseWaves(fade) {
    const ctx = this.ctx;
    const st = this.state;
    const depth = st.noise.waves * 0.85;
    const rate = 1 / st.cycle;
    const ts = Math.max(ctx.currentTime + 0.03, this.t0);
    const lfo = ctx.createOscillator();
    lfo.setPeriodicWave(this._lfoWave(rate, ts));
    lfo.frequency.value = rate;
    const sh = ctx.createWaveShaper();
    sh.curve = this._shapeCurve(0.06);
    const dg = G(ctx, fade ? 0 : depth);
    lfo.connect(sh);
    sh.connect(dg);
    dg.connect(this.noise.vca.gain);
    lfo.start(ts);
    smooth(this.noise.vca.gain, 1 - depth, ctx, 0.1);
    const old = this.noise.wave;
    if (fade) {
      const now = ctx.currentTime;
      dg.gain.setValueAtTime(0, now);
      dg.gain.linearRampToValueAtTime(depth, now + fade);
      if (old) {
        old.dg.gain.cancelScheduledValues(now);
        old.dg.gain.setValueAtTime(old.dg.gain.value, now);
        old.dg.gain.linearRampToValueAtTime(0, now + fade);
        try {
          old.lfo.stop(now + fade + 0.1);
        } catch (e) {
          /* ignore */
        }
      }
    }
    this.noise.wave = { lfo, dg };
  }

  // ---------- voice ----------
  _buildVoice() {
    const ctx = this.ctx;
    const st = this.state.voice;
    const v = {};
    v.in = G(ctx, 1);
    v.hp = ctx.createBiquadFilter();
    v.hp.type = 'highpass';
    v.hp.frequency.value = 90;
    v.lp = ctx.createBiquadFilter();
    v.lp.type = 'lowpass';
    v.lp.Q.value = 0;
    v.lp.frequency.value = st.warmth;
    v.dry = G(ctx, 1);
    v.echoSend = G(ctx, 0);
    v.dl = ctx.createDelay(2.5);
    v.dr = ctx.createDelay(2.5);
    v.elp = ctx.createBiquadFilter();
    v.elp.type = 'lowpass';
    v.elp.frequency.value = 2800;
    v.fb = G(ctx, st.echoFb);
    v.merge = ctx.createChannelMerger(2);
    v.echoWet = G(ctx, 1);
    v.out = G(ctx, 1);
    v.recede = G(ctx, 1);
    v.level = G(ctx, 0);
    v.revSend = G(ctx, 0);

    v.in.connect(v.hp);
    v.hp.connect(v.lp);
    v.lp.connect(v.dry);
    v.dry.connect(v.out);
    // ping-pong echo with darkening feedback
    v.lp.connect(v.echoSend);
    v.echoSend.connect(v.dl);
    v.dl.connect(v.elp);
    v.elp.connect(v.merge, 0, 0);
    v.elp.connect(v.dr);
    v.dr.connect(v.merge, 0, 1);
    v.dr.connect(v.fb);
    v.fb.connect(v.dl);
    v.merge.connect(v.echoWet);
    v.echoWet.connect(v.out);
    v.out.connect(v.recede);
    v.recede.connect(v.level);
    v.level.connect(this.sessionGain);
    v.level.connect(v.revSend);
    v.revSend.connect(this.revIn);
    v.copies = null;
    this.voice = v;
    this._voiceFx();
    this._voiceCopies(3, 0);
  }

  _voiceFx() {
    const ctx = this.ctx;
    const st = this.state.voice;
    const v = this.voice;
    smooth(v.lp.frequency, st.warmth, ctx);
    smooth(v.echoSend.gain, st.echoMix * 0.9, ctx);
    smooth(v.dry.gain, 1 - st.echoMix * 0.35, ctx);
    smooth(v.fb.gain, st.echoFb, ctx);
    smooth(v.dl.delayTime, st.echoTime, ctx, 0.15);
    smooth(v.dr.delayTime, st.echoTime, ctx, 0.15);
    smooth(v.revSend.gain, st.reverb * 1.6, ctx);
  }

  _phrase() {
    const st = this.state.voice;
    const list = (st.selected || []).map((id) => this.mantras.get(id)).filter((m) => m && m.pcm && m.pcm.length);
    if (!list.length) return null;
    const rate = st.rate;
    const gapS = Math.round(st.gap * rate * SR_STORE);
    const n = st.copies;
    const extraMax = Math.round((n - 1) * st.drift * rate * SR_STORE);
    let len = 0;
    list.forEach((m) => (len += m.pcm.length + gapS));
    const total = len + extraMax;
    const pcm = new Float32Array(Math.max(total, 1));
    const segs = [];
    let o = 0;
    list.forEach((m) => {
      pcm.set(m.pcm, o);
      segs.push([o, o + m.pcm.length]);
      o += m.pcm.length + gapS;
    });
    return { pcm, base: len, rate, segs };
  }

  _voiceCopies(delay, fade) {
    const ctx = this.ctx;
    const st = this.state.voice;
    const v = this.voice;
    const old = v.copies;
    if (old) fadeOutAndStop(ctx, old.bus, old.srcs, fade || 0.3);
    v.copies = null;
    this.voiceInfo = null;
    const ph = this._phrase();
    if (!ph) return;
    const buf = ctx.createBuffer(1, ph.pcm.length, SR_STORE);
    buf.getChannelData(0).set(ph.pcm);
    const bus = G(ctx, 0);
    bus.connect(v.in);
    const n = st.copies;
    const pans = PANS[n] || [0];
    const ts = ctx.currentTime + delay;
    const srcs = [];
    for (let k = 0; k < n; k++) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.loopStart = 0;
      const extra = Math.round(k * st.drift * ph.rate * SR_STORE);
      src.loopEnd = Math.max(0.05, (ph.base + extra) / SR_STORE);
      src.playbackRate.value = ph.rate;
      const cg = G(ctx, 1 / Math.sqrt(n));
      const pan = ctx.createStereoPanner();
      pan.pan.value = pans[k];
      src.connect(cg);
      cg.connect(pan);
      pan.connect(bus);
      src.start(ts);
      srcs.push(src);
    }
    bus.gain.setValueAtTime(0, ctx.currentTime);
    bus.gain.setValueAtTime(0, ts);
    bus.gain.linearRampToValueAtTime(1, ts + 0.08);
    v.copies = { bus, srcs };
    // loop timing for the visual, in real seconds: when the copies start, each copy's loop
    // length, and where the words fall within a loop
    const sec = SR_STORE * ph.rate;
    this.voiceInfo = {
      start: ts,
      lens: srcs.map((_, k) => (ph.base + Math.round(k * st.drift * ph.rate * SR_STORE)) / sec),
      segs: ph.segs.map(([a, b]) => [a / sec, b / sec]),
    };
  }

  // ---------- levels & session ----------
  _applyLevels(initial) {
    const ctx = this.ctx;
    const st = this.state;
    const lv = (k) => (st[k].on ? st[k].level * st[k].level * LAYER_MAX[k] : 0);
    const tc = initial ? 0.01 : 0.12;
    smooth(this.voice.level.gain, lv('voice'), ctx, tc);
    smooth(this.drone.level.gain, lv('drone'), ctx, tc);
    smooth(this.pulse.level.gain, lv('pulse'), ctx, tc);
    smooth(this.beats.level.gain, lv('beats'), ctx, tc);
    smooth(this.noise.level.gain, lv('noise'), ctx, tc);
  }

  // Sleep timer fade, wind-down and lucid cues, all as audio-clock automation.
  scheduleSession() {
    const ctx = this.ctx;
    const s = this.state.sleep;
    const now = ctx.currentTime;
    const timerSec = s.timer * 60;
    this.timerEnd = timerSec > 0 ? this.sessionStart + timerSec : null;
    const floor = 0.0005;
    const fadeSec = Math.min(s.fade * 60, timerSec || 0);

    // session fade
    const sg = this.sessionGain.gain;
    sg.cancelScheduledValues(now);
    if (this.timerEnd) {
      const fs = this.timerEnd - fadeSec;
      const at = (t) => (t < fs ? 1 : Math.max(floor, Math.exp((Math.log(floor) * (t - fs)) / Math.max(fadeSec, 0.01))));
      sg.setValueAtTime(at(now), now);
      if (now < fs) sg.setValueAtTime(1, fs);
      if (now < this.timerEnd) sg.exponentialRampToValueAtTime(floor, this.timerEnd);
    } else {
      sg.setValueAtTime(sg.value < 0.99 ? sg.value : 1, now);
      sg.linearRampToValueAtTime(1, now + 2);
    }

    // wind-down: darken and lower the voice over the whole session
    const wl = this.windLP.frequency;
    const vr = this.voice.recede.gain;
    wl.cancelScheduledValues(now);
    vr.cancelScheduledValues(now);
    if (this.timerEnd && s.winddown && this.timerEnd > now + 1) {
      const T = this.timerEnd - this.sessionStart;
      const x = clamp((now - this.sessionStart) / T, 0, 1);
      const lpAt = (y) => 20000 * Math.pow(1100 / 20000, y);
      const vAt = (y) => Math.pow(0.32, y);
      wl.setValueAtTime(lpAt(x), now);
      wl.exponentialRampToValueAtTime(lpAt(1), this.timerEnd);
      vr.setValueAtTime(vAt(x), now);
      vr.exponentialRampToValueAtTime(vAt(1), this.timerEnd);
    } else {
      wl.setValueAtTime(wl.value, now);
      wl.exponentialRampToValueAtTime(20000, now + 1.5);
      vr.setValueAtTime(vr.value, now);
      vr.linearRampToValueAtTime(1, now + 1.5);
    }

    this._beatFreqs();
    this.scheduleCues();
  }

  scheduleCues() {
    const ctx = this.ctx;
    const s = this.state.sleep;
    const now = ctx.currentTime;
    for (const src of this.cueSources) {
      try {
        src.stop();
      } catch (e) {
        /* ignore */
      }
    }
    this.cueSources = [];
    this.cueTimes = [];
    smooth(this.cueBus.gain, s.lucidLevel * s.lucidLevel * 1.2, ctx, 0.05);
    if (!s.lucid) {
      this.lastCueEnd = null;
      return;
    }
    const m = s.lucidCue !== 'chime' ? this.mantras.get(s.lucidCue) : null;
    const data = makeCueData(m ? 'mantra' : 'chime', SR_STORE, this.state.root, m && m.pcm);
    const buf = ctx.createBuffer(1, data.length, SR_STORE);
    buf.getChannelData(0).set(data);
    const first = this.sessionStart + s.lucidStart * 3600;
    let last = null;
    for (let k = 0; k < s.lucidCount; k++) {
      const when = first + k * s.lucidEvery * 60;
      if (when < now + 0.05) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.cueBus);
      src.start(when);
      this.cueSources.push(src);
      this.cueTimes.push(when);
      last = when + buf.duration;
    }
    this.lastCueEnd = last;
  }

  // when the whole session (fade + cues) is finished, in context time; null = open-ended
  get sessionEnd() {
    const s = this.state.sleep;
    if (s.lucid) {
      if (!this.timerEnd) return null;
      return Math.max(this.timerEnd, this.lastCueEnd || 0);
    }
    return this.timerEnd;
  }

  // ---------- live updates ----------
  set(state, path) {
    if (!this.playing || !this.ctx) return;
    this.state = JSON.parse(JSON.stringify(state));
    const ctx = this.ctx;
    const st = this.state;
    const [grp, key] = path.split('.');
    if (path === 'cycle' || path === 'rhythm') {
      if (path === 'cycle' && this._prevCycle) {
        // keep the hand where it is: preserve the phase within the cycle
        const q = mod((ctx.currentTime - this.t0) / this._prevCycle, 1);
        this.t0 = ctx.currentTime - q * st.cycle;
      }
      this._droneGroup(2.5);
      this._pulseRender(0.25);
      this._noiseWaves(2.5);
    } else if (path === 'root') {
      for (const p of this.drone.group.parts) smooth(p.osc.frequency, st.root * p.ratio, ctx, 0.12);
      this._pulseRender(0.25);
      if (st.sleep.lucid && st.sleep.lucidCue === 'chime') this.scheduleCues();
    } else if (path === 'chord') {
      this._droneGroup(2.5);
      this._pulseRender(0.3);
    } else if (key === 'on' || key === 'level') {
      this._applyLevels(false);
    } else if (grp === 'drone') {
      if (key === 'depth') this._droneDepthShape(false);
      else if (key === 'shape') this._droneDepthShape(true);
      else if (key === 'bloom') smooth(this.drone.send.gain, st.drone.bloom * 0.9, ctx);
    } else if (grp === 'pulse') {
      if (key === 'space') smooth(this.pulse.send.gain, st.pulse.space * 1.1, ctx);
      else this._pulseRender(0.25);
    } else if (grp === 'beats') {
      if (key === 'mode') this._beatsGroup(0.6);
      else this._beatFreqs();
    } else if (grp === 'noise') {
      if (key === 'color') this._noiseSrc(1.2);
      else if (key === 'tone') smooth(this.noise.lp.frequency, st.noise.tone, ctx, 0.1);
      else if (key === 'waves') this._noiseWaves(1);
    } else if (grp === 'voice') {
      if (key === 'size') this._buildReverb(1.5);
      else if (['selected', 'gap', 'rate', 'copies', 'drift'].includes(key)) this._voiceCopies(0.9, 0.4);
      else this._voiceFx();
    } else if (grp === 'sleep') {
      if (key === 'warmth') smooth(this.masterLP.frequency, warmthHz(st.sleep.warmth), ctx, 0.1);
      else if (key.startsWith('lucid')) this.scheduleCues();
      else this.scheduleSession();
    } else if (path === 'mantras') {
      this._voiceCopies(0.9, 0.4);
      this.scheduleCues();
    }
    this._prevCycle = st.cycle;
  }

  setMantras(mantras) {
    this.mantras = mantras;
  }
}
