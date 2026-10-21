import { Engine, RHYTHMS, CHORDS, makeCueData, SR_STORE, warmthHz } from './engine.js';
import { Bubble } from './bubble.js';
import * as store from './store.js';

const $ = (s, root = document) => root.querySelector(s);
const clone = (o) => JSON.parse(JSON.stringify(o));
const mod = (a, n) => ((a % n) + n) % n;

// ---------------------------------------------------------------- state

const DEFAULTS = {
  cycle: 16,
  rhythm: '3:4:5',
  root: 98,
  chord: 'overtone',
  voice: { on: true, level: 0.8, selected: [], gap: 5, rate: 0.9, copies: 2, drift: 0.3, warmth: 3800, echoMix: 0.22, echoTime: 0.42, echoFb: 0.42, reverb: 0.55, size: 6.5 },
  drone: { on: true, level: 0.6, depth: 0.75, shape: 0.45, bloom: 0.35 },
  pulse: { on: true, level: 0.5, tone: 'soft', register: 1, density: 1, ring: 3, variation: 0.2, space: 0.5, seed: 1 },
  beats: { on: true, level: 0.45, mode: 'binaural', carrier: 196, beat: 4, glide: true, glideTo: 2 },
  noise: { on: true, level: 0.45, color: 'brown', tone: 700, waves: 0.5 },
  sleep: { timer: 45, fade: 10, winddown: true, warmth: 0.75, lucid: false, lucidStart: 4.5, lucidEvery: 20, lucidCount: 4, lucidCue: 'chime', lucidLevel: 0.45, darkOrbit: false },
  visual: { on: true, level: 0.7, color: 'auto', hue: 'key', skin: true, balls: true, star: true, knot: true, echoes: true, haze: true },
};

const BUILTIN = [
  { name: 'Descent', note: 'Slow overtone swells, brown noise, two copies of your voice drifting apart. Fades over 45 minutes.', s: {} },
  {
    name: 'Lucid night',
    note: 'A 30-minute descent, then four soft cues from four and a half hours in.',
    s: { sleep: { timer: 30, lucid: true }, pulse: { tone: 'glass' } },
  },
  {
    name: 'Phase study',
    note: 'For awake listening. Four copies of your voice slide apart over open fifths in 2:3:5.',
    s: {
      cycle: 10,
      rhythm: '2:3:5',
      chord: 'fifths',
      root: 110,
      voice: { copies: 4, drift: 0.12, gap: 1.5, rate: 1, echoMix: 0.3, reverb: 0.4 },
      pulse: { tone: 'glass', density: 2, variation: 0.35 },
      beats: { on: false },
      noise: { color: 'pink', level: 0.3, tone: 2400, waves: 0.2 },
      sleep: { timer: 0, winddown: false },
    },
  },
  {
    name: 'Clear mind',
    note: 'Brighter bells in 4:5:7 over a pentatonic drone, with a pulsed beat that works on a speaker.',
    s: {
      cycle: 8,
      rhythm: '4:5:7',
      chord: 'penta',
      root: 123.47,
      drone: { depth: 0.6, shape: 0.3 },
      pulse: { tone: 'bell', register: 2, ring: 2, level: 0.45 },
      beats: { mode: 'pulsed', carrier: 247, beat: 6, glide: false },
      noise: { color: 'pink', tone: 3000, level: 0.3 },
      voice: { copies: 1, gap: 3, rate: 1 },
      sleep: { timer: 20, winddown: false },
    },
  },
  {
    name: 'Deep drone',
    note: 'No bells. A minor drone in long 5:7:9 swells with a sharper pulse to each one.',
    s: {
      cycle: 24,
      rhythm: '5:7:9',
      chord: 'minor',
      root: 73.42,
      drone: { level: 0.75, depth: 0.9, shape: 0.8, bloom: 0.5 },
      pulse: { on: false },
      beats: { on: false },
      noise: { level: 0.4, tone: 500 },
      voice: { rate: 0.85, gap: 8, reverb: 0.7, size: 8 },
    },
  },
];

function merge(base, over) {
  const out = clone(base);
  for (const k of Object.keys(over || {})) {
    const v = over[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') out[k] = merge(out[k], v);
    else out[k] = clone(v);
  }
  return out;
}

const LS = {
  get(k) {
    try {
      return JSON.parse(localStorage.getItem(k));
    } catch (e) {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch (e) {
      /* storage unavailable */
    }
  },
};

let state = merge(DEFAULTS, LS.get('lull.state') || {});
let userPresets = LS.get('lull.presets') || [];
let tab = LS.get('lull.tab') || 'voice';
const mantras = new Map();
const engine = new Engine();
let startedAt = 0;

const getP = (path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), state);
function setP(path, v) {
  const ks = path.split('.');
  let o = state;
  for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]];
  o[ks[ks.length - 1]] = v;
}

let saveT = null;
function saveSoon() {
  clearTimeout(saveT);
  saveT = setTimeout(() => LS.set('lull.state', state), 400);
}

// Parameters that glide smoothly; everything else rebuilds part of the sound, so it waits for the finger to settle.
const IMMEDIATE = new Set([
  'voice.level', 'voice.on', 'drone.level', 'drone.on', 'pulse.level', 'pulse.on', 'beats.level', 'beats.on', 'noise.level', 'noise.on',
  'voice.warmth', 'voice.echoMix', 'voice.echoTime', 'voice.echoFb', 'voice.reverb', 'drone.depth', 'drone.bloom', 'pulse.space',
  'beats.carrier', 'beats.beat', 'noise.tone', 'sleep.warmth', 'sleep.lucidLevel',
]);
const pending = {};
function change(path, v) {
  setP(path, v);
  saveSoon();
  afterChange(path);
  if (!engine.playing || path.startsWith('visual.')) return;
  if (IMMEDIATE.has(path)) engine.set(state, path);
  else {
    clearTimeout(pending[path]);
    pending[path] = setTimeout(() => engine.playing && engine.set(state, path), 280);
  }
}

function afterChange(path) {
  updateChips();
  updateTabs();
  refreshControls();
  updateClock();
  if (!engine.playing) drawStatic();
  if ((path === 'sleep.darkOrbit' || path.startsWith('visual.')) && !darkEl.hidden) drawDarkOnce();
}

// ---------------------------------------------------------------- formatting

const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const pct = (v) => `${Math.round(v * 100)}%`;
const hz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);
const secs = (v) => `${+v % 1 ? (+v).toFixed(1) : v} s`;
const midiOf = (f) => Math.round(69 + 12 * Math.log2(f / 440));
const freqOf = (m) => 440 * Math.pow(2, (m - 69) / 12);
const noteName = (f) => {
  const m = midiOf(f);
  return `${NAMES[mod(m, 12)]}${Math.floor(m / 12) - 1}`;
};
function hm(h) {
  const H = Math.floor(h);
  const M = Math.round((h - H) * 60);
  return M ? `${H} h ${M} min` : `${H} h`;
}
function clockStr(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return `${h ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
}
const rhythmLabel = (k) => k.split(':').join(' : ');

// ---------------------------------------------------------------- DOM helpers

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7z"/></svg>',
};

let ctls = []; // {el, when, sync}

function refreshControls() {
  for (const c of ctls) {
    if (c.when) c.el.classList.toggle('disabled', !c.when(state));
    if (c.sync) c.sync();
  }
  const layer = PANEL_LAYER[tab];
  panelEl.classList.toggle('off', !!layer && !state[layer].on);
}

function sliderCtl(def) {
  const wrap = el('div', 'ctl');
  const top = el('div', 'ctl-top');
  const id = 'c-' + def.path.replace('.', '-');
  const lab = el('label', 'ctl-label', def.label);
  lab.htmlFor = id;
  const val = el('span', 'ctl-val');
  top.append(lab, val);
  const input = el('input');
  input.type = 'range';
  input.id = id;
  const lo = def.min;
  const hi = def.max;
  if (def.log) {
    input.min = 0;
    input.max = 1000;
    input.step = 1;
  } else {
    input.min = lo;
    input.max = hi;
    input.step = def.step;
  }
  const toInput = (v) => (def.log ? (1000 * Math.log(v / lo)) / Math.log(hi / lo) : v);
  const fromInput = () => {
    const x = +input.value;
    return def.log ? Math.round(lo * Math.pow(hi / lo, x / 1000)) : x;
  };
  const paint = (v) => {
    val.textContent = def.fmt(v);
    const p = ((+input.value - +input.min) / (+input.max - +input.min)) * 100;
    input.style.setProperty('--p', `${p}%`);
  };
  const sync = () => {
    const v = getP(def.path);
    if (document.activeElement !== input) input.value = toInput(v);
    paint(v);
  };
  input.addEventListener('input', () => {
    const v = fromInput();
    paint(v);
    change(def.path, v);
  });
  wrap.append(top, input);
  sync();
  ctls.push({ el: wrap, when: def.when, sync });
  return wrap;
}

function segCtl(def) {
  const wrap = el('div', 'ctl');
  const top = el('div', 'ctl-top');
  top.append(el('span', 'ctl-label', def.label));
  const seg = el('div', 'seg');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', def.label);
  const btns = def.options.map(([v, label]) => {
    const b = el('button', null, label);
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => {
      change(def.path, v);
      if (def.after) def.after();
    });
    seg.append(b);
    return [v, b];
  });
  const sync = () => btns.forEach(([v, b]) => b.setAttribute('aria-checked', String(getP(def.path) === v)));
  wrap.append(top, seg);
  sync();
  ctls.push({ el: wrap, when: def.when, sync });
  return wrap;
}

function switchCtl(def, extraCls) {
  const row = el('div', 'switch-row ctl' + (extraCls ? ' ' + extraCls : ''));
  const lab = el('span', 'ctl-label', def.label);
  const sw = el('button', 'switch');
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-label', def.label);
  sw.addEventListener('click', () => change(def.path, !getP(def.path)));
  const sync = () => sw.setAttribute('aria-checked', String(!!getP(def.path)));
  row.append(lab, sw);
  sync();
  ctls.push({ el: row, when: def.when, sync });
  return row;
}

// ---------------------------------------------------------------- panels

const PANEL_LAYER = { voice: 'voice', drone: 'drone', pulse: 'pulse', beats: 'beats', noise: 'noise', visual: 'visual' };

const PANELS = {
  voice: () => [
    { k: 'layer', layer: 'voice', title: 'Voice' },
    { k: 'mantras' },
    { k: 'group', label: 'Loop' },
    { k: 'slider', path: 'voice.gap', label: 'Pause between repeats', min: 0, max: 20, step: 0.5, fmt: secs },
    { k: 'slider', path: 'voice.rate', label: 'Speed', min: 0.5, max: 1.1, step: 0.01, fmt: pct },
    { k: 'note', text: 'Slower also means lower, like tape.' },
    { k: 'group', label: 'Phasing' },
    { k: 'seg', path: 'voice.copies', label: 'Copies of your voice', options: [[1, '1'], [2, '2'], [3, '3'], [4, '4']] },
    { k: 'slider', path: 'voice.drift', label: 'Drift per repeat', min: 0, max: 1, step: 0.01, fmt: (v) => `${(+v).toFixed(2)} s`, when: (s) => s.voice.copies > 1 },
    { k: 'note', text: 'Each copy loops a little longer than the one before, so they slide out of sync and slowly back in, as in Steve Reich’s tape pieces.' },
    { k: 'group', label: 'Tone and space' },
    { k: 'slider', path: 'voice.warmth', label: 'Brightness', min: 400, max: 12000, log: true, fmt: hz },
    { k: 'slider', path: 'voice.reverb', label: 'Reverb', min: 0, max: 1, step: 0.01, fmt: pct },
    { k: 'slider', path: 'voice.size', label: 'Reverb size', min: 1.5, max: 9, step: 0.5, fmt: secs },
    { k: 'slider', path: 'voice.echoMix', label: 'Echo', min: 0, max: 1, step: 0.01, fmt: pct },
    { k: 'slider', path: 'voice.echoTime', label: 'Echo time', min: 0.08, max: 1.5, step: 0.01, fmt: (v) => `${(+v).toFixed(2)} s`, when: (s) => s.voice.echoMix > 0 },
    { k: 'slider', path: 'voice.echoFb', label: 'Echo repeats', min: 0, max: 0.85, step: 0.01, fmt: pct, when: (s) => s.voice.echoMix > 0 },
    { k: 'note', text: 'The echo bounces between left and right. The reverb is shared with the pulses, so its size sets the room for both.' },
  ],
  drone: () => [
    { k: 'layer', layer: 'drone', title: 'Drone' },
    { k: 'note', text: 'Partials of the key, each swelling at its own rate taken from the rhythm. They all peak together at the top of the cycle, then scatter.' },
    { k: 'slider', path: 'drone.depth', label: 'Swell depth', min: 0, max: 1, step: 0.01, fmt: pct },
    { k: 'slider', path: 'drone.shape', label: 'Swell shape', min: 0, max: 1, step: 0.01, fmt: (v) => (v < 0.25 ? 'Smooth' : v < 0.6 ? 'Rounded' : 'Pulsing') },
    { k: 'slider', path: 'drone.bloom', label: 'Reverb', min: 0, max: 1, step: 0.01, fmt: pct },
  ],
  pulse: () => [
    { k: 'layer', layer: 'pulse', title: 'Pulse' },
    { k: 'note', text: 'One ring per voice. With 3 : 4 : 5, the rings strike three, four and five times in the same cycle, each on a note of the harmony.' },
    { k: 'seg', path: 'pulse.tone', label: 'Sound', options: [['soft', 'Soft'], ['glass', 'Glass'], ['bell', 'Bell']] },
    { k: 'seg', path: 'pulse.register', label: 'Register', options: [[0.5, 'Low'], [1, 'Middle'], [2, 'High']] },
    { k: 'seg', path: 'pulse.density', label: 'Density', options: [[1, '×1'], [2, '×2'], [3, '×3'], [4, '×4']] },
    { k: 'slider', path: 'pulse.ring', label: 'Ring', min: 0.3, max: 6, step: 0.1, fmt: secs },
    { k: 'slider', path: 'pulse.variation', label: 'Variation', min: 0, max: 1, step: 0.01, fmt: pct },
    { k: 'note', text: 'Variation drops some strikes and softens others. The pattern then runs over up to four cycles before it repeats.' },
    { k: 'button', label: 'New variation', when: (s) => s.pulse.variation > 0, onClick: () => change('pulse.seed', 1 + Math.floor(Math.random() * 1e6)) },
    { k: 'slider', path: 'pulse.space', label: 'Reverb', min: 0, max: 1, step: 0.01, fmt: pct },
  ],
  beats: () => [
    { k: 'layer', layer: 'beats', title: 'Beats' },
    { k: 'seg', path: 'beats.mode', label: 'Type', options: [['binaural', 'Binaural'], ['monaural', 'Monaural'], ['pulsed', 'Pulsed']] },
    { k: 'slider', path: 'beats.carrier', label: 'Tone', min: 60, max: 500, log: true, fmt: (v) => `${hz(v)}  ${noteName(v)}` },
    { k: 'slider', path: 'beats.beat', label: 'Beat rate', min: 0.5, max: 14, step: 0.1, fmt: (v) => `${(+v).toFixed(1)} per second` },
    { k: 'switch', path: 'beats.glide', label: 'Glide during the sleep timer' },
    { k: 'slider', path: 'beats.glideTo', label: 'Glide to', min: 0.5, max: 14, step: 0.1, fmt: (v) => `${(+v).toFixed(1)} per second`, when: (s) => s.beats.glide && s.sleep.timer > 0 },
    {
      k: 'note',
      text: 'Binaural: each ear gets a slightly different tone and the beat exists only in your head, so it needs headphones. Monaural and pulsed are real beats in the air and work on a speaker. Evidence that beats change brainwaves is weak and mixed; treat them as rhythm and texture.',
    },
  ],
  noise: () => [
    { k: 'layer', layer: 'noise', title: 'Noise' },
    { k: 'seg', path: 'noise.color', label: 'Color', options: [['brown', 'Brown'], ['pink', 'Pink']] },
    { k: 'slider', path: 'noise.tone', label: 'Brightness', min: 150, max: 8000, log: true, fmt: hz },
    { k: 'slider', path: 'noise.waves', label: 'Waves', min: 0, max: 1, step: 0.01, fmt: pct },
    { k: 'note', text: 'Waves swell once per cycle, in step with the drone. Brown noise is deeper, like surf; pink is closer to rain.' },
  ],
  visual: () => [
    { k: 'layer', layer: 'visual', title: 'Visual', levelLabel: 'Brightness' },
    { k: 'seg', path: 'visual.color', label: 'Color', options: [['night', 'Night'], ['wheel', 'Full wheel'], ['auto', 'Auto']] },
    {
      k: 'note',
      text: 'Night shows the bubble as if under a sodium street lamp: one amber wavelength, so the film shows amber bands and no blue or green. Full wheel shows its real rainbow colors. Auto uses Night whenever the sleep timer is on.',
    },
    { k: 'group', label: 'What you see' },
    { k: 'switch', path: 'visual.skin', label: 'Bubble skin' },
    {
      k: 'note',
      text: 'A soap film made of points. The root makes the whole bubble breathe, and each higher partial sets off one of its natural vibration patterns, the sphere’s version of a string’s overtones. The colors come from light interfering inside the film, which drains thinner toward the top.',
    },
    { k: 'switch', path: 'visual.balls', label: 'Bouncing tones' },
    {
      k: 'note',
      text: 'One ball for each ring of the rhythm, bouncing inside the bubble. A tone sounds the moment its ball hits the skin. A ball bouncing in a sphere stays in one flat plane, so each traces a shape, and all of them meet at the top on the first beat of every cycle. Each ball leaves an afterimage of its last lap, so its whole shape stays lit and is redrawn as the ball comes round.',
    },
    { k: 'note', text: 'Every hit sends a ripple across the skin. It spreads, crosses the middle, and gathers again at the opposite point about two seconds later. Strikes the variation drops make no ripple; the ball just bounces on silently.' },
    { k: 'switch', path: 'visual.star', label: 'Star paths', when: (s) => s.visual.balls },
    { k: 'note', text: 'On: five, seven and eight hits trace stars instead of polygons. The sound is the same either way; only the order of the points changes.' },
    { k: 'switch', path: 'visual.knot', label: 'Harmonic knot' },
    {
      k: 'note',
      text: 'The drone drawn as a 3D harmonograph that fills the bubble: the partials take turns driving the three directions, so the line closes into a knot. It swells with the drone until it presses against the skin, which glows where it touches. Every strike plucks it, and your voice lights it where a shell passes through. Simple chords make open knots; minor and pentatonic weave dense ones.',
    },
    { k: 'switch', path: 'visual.echoes', label: 'Voice echoes' },
    {
      k: 'note',
      text: 'While a copy of your voice speaks, a faint shell grows out from the center. Each copy loops a little longer than the one before, so the shells drift apart into echoes and slowly back into one.',
    },
    { k: 'switch', path: 'visual.haze', label: 'Noise haze' },
    { k: 'note', text: 'A haze around the bubble that swells once per cycle, with the waves.' },
    { k: 'group', label: 'Full wheel' },
    { k: 'seg', path: 'visual.hue', label: 'Tone colors start at', options: [['key', 'The key'], ['fixed', 'A fixed color']], when: (s) => s.visual.color !== 'night' },
    {
      k: 'note',
      text: 'The key sets where the tone colors start, following the circle of fifths, so related keys get neighboring colors. Each bounce path takes its colors from the points it strikes: a triangle gives three, a square four. That part is a convention; the film’s colors are physics.',
    },
    { k: 'group', label: 'Calm by design' },
    {
      k: 'note',
      text: 'Nothing on the stage flashes faster than about once a second, and the beats are never drawn, so the picture never flickers at the beat rate. Across the sleep timer the film drains and darkens along with the sound.',
    },
    { k: 'group', label: 'Dark screen' },
    { k: 'switch', path: 'sleep.darkOrbit', label: 'Faint bubble on the dark screen' },
    { k: 'note', text: 'Drawn very dim on pure black, so almost every pixel stays off.' },
  ],
  sleep: () => [
    { k: 'title', text: 'Sleep' },
    { k: 'slider', path: 'sleep.timer', label: 'Sleep timer', min: 0, max: 180, step: 5, fmt: (v) => (v ? `${v} min` : 'Off') },
    { k: 'slider', path: 'sleep.fade', label: 'Fade-out', min: 1, max: 30, step: 1, fmt: (v) => `last ${v} min`, when: (s) => s.sleep.timer > 0 },
    { k: 'switch', path: 'sleep.winddown', label: 'Wind down', when: (s) => s.sleep.timer > 0 },
    { k: 'note', text: 'Across the whole timer, the sound slowly darkens and your voice recedes.' },
    { k: 'slider', path: 'sleep.warmth', label: 'Overall brightness', min: 0, max: 1, step: 0.01, fmt: (v) => hz(warmthHz(v)) },
    { k: 'group', label: 'Lucid dream cues' },
    {
      k: 'note',
      text: 'From targeted lucidity reactivation studies (Carr and colleagues, 2020): before sleep you link a cue to the thought “I am dreaming”, and the same cue plays softly late in the night, when REM sleep runs longest. The studies are small and early, so treat this as an experiment.',
    },
    { k: 'switch', path: 'sleep.lucid', label: 'Play cues' },
    { k: 'slider', path: 'sleep.lucidStart', label: 'First cue after', min: 1.5, max: 7.5, step: 0.25, fmt: hm, when: (s) => s.sleep.lucid },
    { k: 'slider', path: 'sleep.lucidEvery', label: 'Then every', min: 5, max: 60, step: 5, fmt: (v) => `${v} min`, when: (s) => s.sleep.lucid },
    { k: 'slider', path: 'sleep.lucidCount', label: 'Number of cues', min: 1, max: 10, step: 1, fmt: (v) => String(v), when: (s) => s.sleep.lucid },
    { k: 'cueSelect', when: (s) => s.sleep.lucid },
    { k: 'slider', path: 'sleep.lucidLevel', label: 'Cue volume', min: 0.05, max: 1, step: 0.01, fmt: pct, when: (s) => s.sleep.lucid },
    { k: 'button', label: 'Practice the cue', onClick: previewCue },
    {
      k: 'note',
      text: 'Before sleep, play the cue a few times. Each time, look around and think: next time I hear this, I will notice I am dreaming. Keep the phone charging, since the screen stays on (black) until the last cue.',
    },
    { k: 'group', label: 'Screen' },
    {
      k: 'note',
      text: 'iPhone stops a home-screen web app’s sound when the phone locks, so Lull keeps the screen awake while it plays. Go dark shows pure black, which switches the pixels off. When the session ends, the phone is free to lock again.',
    },
  ],
};

const panelEl = $('#panel');

function renderPanel() {
  ctls = [];
  panelEl.textContent = '';
  for (const def of PANELS[tab]()) {
    if (def.k === 'layer') {
      const head = el('div', 'layer-head');
      head.append(el('h2', 'layer-title', def.title));
      const sw = switchCtl({ path: `${def.layer}.on`, label: `${def.title} on` }, 'keep');
      sw.querySelector('.ctl-label').remove();
      sw.style.padding = '0';
      head.append(sw);
      panelEl.append(head);
      panelEl.append(sliderCtl({ path: `${def.layer}.level`, label: def.levelLabel || 'Level', min: 0, max: 1, step: 0.01, fmt: pct }));
    } else if (def.k === 'title') {
      const head = el('div', 'layer-head');
      head.append(el('h2', 'layer-title', def.text));
      panelEl.append(head);
    }
    else if (def.k === 'group') panelEl.append(el('h3', 'group', def.label));
    else if (def.k === 'note') panelEl.append(el('p', 'note', def.text));
    else if (def.k === 'slider') panelEl.append(sliderCtl(def));
    else if (def.k === 'seg') panelEl.append(segCtl(def));
    else if (def.k === 'switch') panelEl.append(switchCtl(def));
    else if (def.k === 'button') {
      const row = el('div', 'btn-row ctl');
      const b = el('button', 'btn', def.label);
      b.addEventListener('click', def.onClick);
      row.append(b);
      panelEl.append(row);
      ctls.push({ el: row, when: def.when });
    } else if (def.k === 'mantras') panelEl.append(mantraBlock());
    else if (def.k === 'cueSelect') panelEl.append(cueSelect(def));
  }
  refreshControls();
}

function cueSelect(def) {
  const wrap = el('div', 'ctl');
  const lab = el('label', 'ctl-label', 'Cue sound');
  lab.htmlFor = 'cueSel';
  const sel = el('select');
  sel.id = 'cueSel';
  const opts = [['chime', 'Chime (three rising tones)'], ...[...mantras.values()].map((m) => [m.id, m.name])];
  for (const [v, t] of opts) {
    const o = el('option', null, t);
    o.value = v;
    sel.append(o);
  }
  sel.value = state.sleep.lucidCue;
  sel.addEventListener('change', () => change('sleep.lucidCue', sel.value));
  wrap.append(lab, sel);
  ctls.push({ el: wrap, when: def.when, sync: () => (sel.value = state.sleep.lucidCue) });
  return wrap;
}

// ---------------------------------------------------------------- mantras

function durStr(pcm) {
  return secs(Math.round((pcm.length / SR_STORE) * 10) / 10);
}

let previewAudio = null;
let previewId = null;
function stopPreview() {
  if (previewAudio) {
    previewAudio.pause();
    URL.revokeObjectURL(previewAudio.src);
  }
  previewAudio = null;
  previewId = null;
}
function playPCM(pcm, id, onend) {
  stopPreview();
  const a = new Audio(URL.createObjectURL(store.wavBlob(pcm)));
  previewAudio = a;
  previewId = id;
  a.onended = () => {
    stopPreview();
    if (onend) onend();
  };
  a.play().catch(() => toast('Could not play the preview.'));
}

function mantraBlock() {
  const wrap = el('div', 'keep');
  ctls.push({ el: wrap });
  if (!mantras.size) {
    const box = el('div', 'empty');
    box.append(el('p', null, 'Record your first mantra.'), el('p', 'note', 'It stays on this phone and is never uploaded.'));
    box.append(recordButtons());
    wrap.append(box);
    return wrap;
  }
  const ul = el('ul', 'mantras');
  for (const m of mantras.values()) {
    const li = el('li', 'mantra');
    const pick = el('button', 'pick');
    pick.setAttribute('role', 'checkbox');
    pick.setAttribute('aria-label', `Include ${m.name} in the loop`);
    pick.setAttribute('aria-checked', String(state.voice.selected.includes(m.id)));
    pick.append(el('span'));
    pick.addEventListener('click', () => {
      const sel = state.voice.selected.slice();
      const i = sel.indexOf(m.id);
      if (i >= 0) sel.splice(i, 1);
      else sel.push(m.id);
      const order = [...mantras.keys()];
      sel.sort((a, b) => order.indexOf(a) - order.indexOf(b));
      change('voice.selected', sel);
      pick.setAttribute('aria-checked', String(sel.includes(m.id)));
    });
    const name = el('button', 'm-name', m.name);
    name.append(el('small', null, durStr(m.pcm)));
    name.setAttribute('aria-label', `Rename ${m.name}`);
    name.addEventListener('click', () => {
      const input = el('input', 'm-name-input');
      input.value = m.name;
      input.maxLength = 40;
      name.replaceWith(input);
      input.focus();
      input.select();
      const done = async () => {
        const v = input.value.trim();
        if (v && v !== m.name) {
          m.name = v;
          await store.saveMantra({ id: m.id, name: m.name, created: m.created, sr: SR_STORE, pcm: store.toInt16(m.pcm).buffer });
        }
        renderPanel();
      };
      input.addEventListener('blur', done, { once: true });
      input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
    });
    const prev = el('button', 'icon-btn');
    const paintPrev = () => {
      prev.innerHTML = previewId === m.id ? ICON.stop : ICON.play;
      prev.setAttribute('aria-label', previewId === m.id ? 'Stop preview' : `Play ${m.name}`);
    };
    paintPrev();
    prev.addEventListener('click', () => {
      if (previewId === m.id) stopPreview();
      else {
        playPCM(m.pcm, m.id, () => renderPanel());
        renderPanel();
        return;
      }
      paintPrev();
    });
    const del = el('button', 'icon-btn');
    del.innerHTML = ICON.trash;
    del.setAttribute('aria-label', `Delete ${m.name}`);
    del.addEventListener('click', async () => {
      if (!del.classList.contains('warn')) {
        del.classList.add('warn');
        del.textContent = 'Delete';
        setTimeout(() => {
          if (del.isConnected && del.classList.contains('warn')) {
            del.classList.remove('warn');
            del.innerHTML = ICON.trash;
          }
        }, 3000);
        return;
      }
      await store.deleteMantra(m.id);
      mantras.delete(m.id);
      if (state.sleep.lucidCue === m.id) setP('sleep.lucidCue', 'chime');
      setP('voice.selected', state.voice.selected.filter((x) => x !== m.id));
      saveSoon();
      afterChange('mantras');
      if (engine.playing) engine.set(state, 'mantras');
      renderPanel();
    });
    li.append(pick, name, prev, del);
    ul.append(li);
  }
  wrap.append(ul);
  wrap.append(el('p', 'note', 'Ticked recordings play in order, then the loop repeats. Tap a name to rename it.'));
  wrap.append(recordButtons());
  return wrap;
}

function recordButtons() {
  const row = el('div', 'btn-row');
  const rec = el('button', 'btn primary', 'Record a mantra');
  rec.addEventListener('click', openRecorder);
  const imp = el('button', 'btn', 'Import a file');
  imp.addEventListener('click', () => $('#importFile').click());
  row.append(rec, imp);
  return row;
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function addMantra(pcm, name) {
  const id = newId();
  const created = Date.now();
  await store.saveMantra({ id, name, created, sr: SR_STORE, pcm: store.toInt16(pcm).buffer });
  mantras.set(id, { id, name, created, pcm });
  setP('voice.selected', [...state.voice.selected, id]);
  saveSoon();
  afterChange('mantras');
  if (engine.playing) engine.set(state, 'mantras');
  if (tab === 'voice' || tab === 'sleep') renderPanel();
  return id;
}

$('#importFile').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    let pcm = await store.decodeToMono(await f.arrayBuffer());
    const max = SR_STORE * 300;
    let cut = false;
    if (pcm.length > max) {
      pcm = pcm.slice(0, max);
      cut = true;
    }
    const clean = store.cleanUp(pcm);
    if (!clean) return toast('That file seems to be silent.');
    const name = f.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Imported';
    await addMantra(clean, name);
    toast(cut ? `Added ${name}, trimmed to five minutes.` : `Added ${name}.`);
  } catch (err) {
    toast('This file could not be read. Try an m4a, mp3 or wav file.');
  }
});

// ---------------------------------------------------------------- recorder

const recScrim = $('#recScrim');
const recBtn = $('#recBtn');
const recTime = $('#recTime');
const recMsg = $('#recMsg');
let rec = null;

function openRecorder() {
  if (engine.playing) stopPlay(0.4);
  stopPreview();
  recScrim.hidden = false;
  recBtn.classList.remove('on');
  recBtn.setAttribute('aria-label', 'Start recording');
  recTime.textContent = '0:00';
  recMsg.textContent = 'Tap to start';
}

function closeRecorder() {
  if (rec) cancelRecording();
  recScrim.hidden = true;
}

$('#recClose').addEventListener('click', closeRecorder);
recScrim.addEventListener('click', (e) => e.target === recScrim && closeRecorder());

recBtn.addEventListener('click', () => {
  if (rec && rec.state === 'recording') finishRecording();
  else if (!rec) startRecording();
});

async function startRecording() {
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    recMsg.textContent = 'This browser cannot record. Use Import a file instead.';
    return;
  }
  // meter context must be created inside the tap so iOS lets it run
  let meterCtx = null;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    meterCtx = new AC();
    meterCtx.resume();
  } catch (e) {
    meterCtx = null;
  }
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'play-and-record';
  } catch (e) {
    /* ignore */
  }
  rec = { state: 'starting', meterCtx };
  recMsg.textContent = 'Waiting for the microphone…';
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (e) {
    rec = null;
    if (meterCtx) meterCtx.close();
    resetSession();
    recMsg.textContent = 'Lull needs the microphone. Allow it in the prompt, or in Settings › Safari › Microphone.';
    return;
  }
  if (!rec) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  mr.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
  Object.assign(rec, { state: 'recording', stream, mr, chunks, t0: performance.now() });
  mr.start();
  recBtn.classList.add('on');
  recBtn.setAttribute('aria-label', 'Stop recording');
  recMsg.textContent = 'Recording. Tap to stop.';

  if (meterCtx) {
    try {
      const src = meterCtx.createMediaStreamSource(stream);
      const an = meterCtx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      rec.an = an;
      // raw PCM capture: avoids codec quirks when decoding the compressed recording
      const proc = meterCtx.createScriptProcessor(4096, 1, 1);
      const sink = meterCtx.createGain();
      sink.gain.value = 0;
      src.connect(proc);
      proc.connect(sink);
      sink.connect(meterCtx.destination);
      rec.raw = [];
      rec.rawSr = meterCtx.sampleRate;
      proc.onaudioprocess = (e) => {
        if (rec && rec.state === 'recording') rec.raw.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      rec.proc = proc;
    } catch (e) {
      /* meter and raw capture are optional */
    }
  }
  const buf = new Float32Array(1024);
  const tick = () => {
    if (!rec || rec.state !== 'recording') return;
    const t = (performance.now() - rec.t0) / 1000;
    recTime.textContent = clockStr(t);
    if (rec.an) {
      rec.an.getFloatTimeDomainData(buf);
      let s = 0;
      for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      const db = 20 * Math.log10(Math.sqrt(s / buf.length) + 1e-6);
      const lvl = Math.max(0, Math.min(1, (db + 55) / 45));
      recBtn.style.setProperty('--lvl', String(0.92 + lvl * 0.28));
    }
    if (t >= 60) return finishRecording();
    rec.raf = requestAnimationFrame(tick);
  };
  tick();
}

function endStream() {
  if (!rec) return;
  if (rec.raf) cancelAnimationFrame(rec.raf);
  if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
  if (rec.meterCtx) rec.meterCtx.close().catch(() => {});
  resetSession();
}

function resetSession() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch (e) {
    /* ignore */
  }
}

function cancelRecording() {
  if (rec && rec.mr && rec.mr.state !== 'inactive') {
    rec.mr.onstop = null;
    rec.mr.stop();
  }
  endStream();
  rec = null;
}

function finishRecording() {
  const r = rec;
  if (!r || !r.mr) return;
  r.state = 'processing';
  recBtn.classList.remove('on');
  recMsg.textContent = 'Cleaning up…';
  r.mr.onstop = async () => {
    endStream();
    rec = null;
    try {
      let pcm = null;
      const rawLen = (r.raw || []).reduce((n, a) => n + a.length, 0);
      if (rawLen > (r.rawSr || 48000) * 0.3) {
        const all = new Float32Array(rawLen);
        let o = 0;
        for (const a of r.raw) {
          all.set(a, o);
          o += a.length;
        }
        pcm = store.resampleTo(all, r.rawSr);
        window.__lastRecPath = 'raw';
      } else {
        const blob = new Blob(r.chunks, { type: r.mr.mimeType || 'audio/mp4' });
        pcm = await store.decodeToMono(await blob.arrayBuffer());
        window.__lastRecPath = 'decoded';
      }
      const clean = store.cleanUp(pcm);
      if (!clean) {
        recMsg.textContent = 'Nothing was heard. Check the microphone and try again.';
        return;
      }
      const name = `Mantra ${mantras.size + 1}`;
      await addMantra(clean, name);
      recScrim.hidden = true;
      if (tab !== 'voice') switchTab('voice');
      toast(`Saved as ${name}. Tap its name to rename it.`);
    } catch (e) {
      recMsg.textContent = 'The recording could not be read. Try again.';
    }
  };
  r.mr.stop();
}

// ---------------------------------------------------------------- piece chips

const chipsEl = $('#chips');
const pieceEditor = $('#pieceEditor');
let openChip = null;

function updateChips() {
  $('#v-cycle').textContent = secs(state.cycle);
  $('#v-rhythm').textContent = state.rhythm;
  $('#v-root').textContent = noteName(state.root);
  $('#v-chord').textContent = (CHORDS[state.chord] || CHORDS.overtone).name;
}

function renderPieceEditor() {
  chipsEl.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-expanded', String(c.dataset.edit === openChip)));
  pieceEditor.textContent = '';
  pieceEditor.hidden = !openChip;
  ctls = ctls.filter((c) => document.body.contains(c.el));
  if (!openChip) return;
  let node;
  if (openChip === 'cycle') {
    node = sliderCtl({ path: 'cycle', label: 'Cycle length', min: 4, max: 40, step: 0.5, fmt: (v) => `${secs(v)} per turn` });
  } else if (openChip === 'rhythm') {
    node = segCtl({ path: 'rhythm', label: 'Strikes per cycle, one ring each', options: Object.keys(RHYTHMS).map((k) => [k, rhythmLabel(k)]) });
  } else if (openChip === 'chord') {
    node = segCtl({ path: 'chord', label: 'Harmony (just intonation)', options: Object.entries(CHORDS).map(([k, c]) => [k, c.name]) });
  } else if (openChip === 'root') {
    const wrap = el('div', 'ctl');
    const top = el('div', 'ctl-top');
    const lab = el('label', 'ctl-label', 'Key');
    lab.htmlFor = 'c-root';
    const val = el('span', 'ctl-val');
    top.append(lab, val);
    const input = el('input');
    input.type = 'range';
    input.id = 'c-root';
    input.min = 28;
    input.max = 55;
    input.step = 1;
    const paint = () => {
      val.textContent = `${noteName(state.root)}  ${state.root.toFixed(1)} Hz`;
      input.style.setProperty('--p', `${((+input.value - 28) / 27) * 100}%`);
    };
    input.value = midiOf(state.root);
    input.addEventListener('input', () => {
      change('root', Math.round(freqOf(+input.value) * 100) / 100);
      paint();
    });
    paint();
    wrap.append(top, input);
    node = wrap;
  }
  pieceEditor.append(node);
}

chipsEl.addEventListener('click', (e) => {
  const c = e.target.closest('.chip');
  if (!c) return;
  openChip = openChip === c.dataset.edit ? null : c.dataset.edit;
  renderPieceEditor();
});

// ---------------------------------------------------------------- tabs

const tabsEl = $('#tabs');
function updateTabs() {
  tabsEl.querySelectorAll('.tab').forEach((t) => {
    const k = t.dataset.tab;
    t.setAttribute('aria-selected', String(k === tab));
    const layer = PANEL_LAYER[k];
    t.classList.toggle('live', layer ? state[layer].on && state[layer].level > 0.01 : state.sleep.timer > 0 || state.sleep.lucid);
  });
}
function switchTab(k) {
  tab = k;
  LS.set('lull.tab', k);
  updateTabs();
  renderPanel();
  renderPieceEditor();
}
tabsEl.addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (t) switchTab(t.dataset.tab);
});

// ---------------------------------------------------------------- transport

const playBtn = $('#playBtn');
const stagePlay = $('#stagePlay');
const clockEl = $('#clock');

function setPlayingUI(on) {
  playBtn.textContent = on ? 'Stop' : 'Play';
  playBtn.setAttribute('aria-pressed', String(on));
  stagePlay.hidden = on;
  if (on) startLoop();
  else {
    stopLoop();
    setTimeout(drawStatic, 50);
  }
  updateClock();
}

function play(elapsed = 0) {
  finished = false;
  hideResume();
  stopPreview();
  engine.start(state, mantras, { elapsed });
  engine.onstate = (s) => {
    if (engine.playing && s !== 'running' && document.visibilityState === 'visible' && performance.now() - startedAt > 2500) showResume();
  };
  startedAt = performance.now();
  setPlayingUI(true);
  keepAwake();
  if (!mantras.size && state.voice.on) toast('Tip: record a mantra in Voice to hear it in the loop.');
}

function stopPlay(fade = 2.5) {
  engine.stop(fade);
  releaseAwake();
  setPlayingUI(false);
}

playBtn.addEventListener('click', () => (engine.playing ? stopPlay() : play()));
stagePlay.addEventListener('click', () => !engine.playing && play());

function updateClock() {
  let big;
  let small;
  const s = state.sleep;
  if (engine.playing && engine.ctx) {
    const t = engine.time;
    if (engine.timerEnd && t < engine.timerEnd) {
      big = clockStr(engine.timerEnd - t);
      small = 'left';
    } else if (engine.cueTimes && engine.cueTimes.some((c) => c > t)) {
      big = clockStr(engine.cueTimes.find((c) => c > t) - t);
      small = 'to the next cue';
    } else {
      big = clockStr(t - engine.sessionStart);
      small = 'playing';
    }
  } else {
    big = s.timer ? `${s.timer} min` : 'No timer';
    small = s.lucid ? 'with lucid cues' : s.timer ? 'sleep timer' : 'plays until stopped';
  }
  clockEl.innerHTML = '';
  clockEl.append(document.createTextNode(big), el('small', null, small));
  darkClock.textContent = engine.playing ? `${big} ${small}` : finished ? 'Session finished' : 'Not playing';
}

let finished = false;
function finishSession() {
  finished = true;
  engine.stop(0.5);
  releaseAwake();
  setPlayingUI(false);
}

setInterval(() => {
  updateClock();
  if (!engine.playing || !engine.ctx) return;
  const end = engine.sessionEnd;
  if (end != null && engine.time > end + 1) finishSession();
  else if (engine.ctx.state !== 'running' && document.visibilityState === 'visible' && performance.now() - startedAt > 2500) showResume();
}, 500);

// ---------------------------------------------------------------- wake lock & resume

let wake = null;
let warnedWake = false;
async function keepAwake() {
  if (!('wakeLock' in navigator)) {
    if (!warnedWake) toast('This iPhone cannot keep the screen awake from a web app. Set Auto-Lock to Never while listening.');
    warnedWake = true;
    return;
  }
  try {
    wake = await navigator.wakeLock.request('screen');
    wake.addEventListener('release', () => {
      wake = null;
      if (engine.playing && document.visibilityState === 'visible') showResume('The screen was allowed to sleep again, which would stop the sound.');
    });
  } catch (e) {
    if (!warnedWake) toast('The screen could not be kept awake. Low Power Mode can block it.');
    warnedWake = true;
  }
}
function releaseAwake() {
  const w = wake;
  wake = null;
  if (w) w.release().catch(() => {});
}

const resumeEl = $('#resume');
function showResume(msg) {
  $('#resumeMsg').textContent = msg || 'iPhone paused the sound when Lull left the screen.';
  resumeEl.hidden = false;
}
function hideResume() {
  resumeEl.hidden = true;
}
$('#resumeBtn').addEventListener('click', () => {
  if (!engine.playing) return hideResume();
  const ctx = engine.ctx;
  if (ctx && ctx.state !== 'running') {
    // a suspended iOS audio context is unreliable to resume; restart where the session was
    const elapsed = ctx.currentTime - engine.sessionStart;
    engine.stop(0.01);
    play(elapsed);
  } else {
    hideResume();
    keepAwake();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !engine.playing) return;
  setTimeout(() => {
    if (engine.playing && (!wake || (engine.ctx && engine.ctx.state !== 'running'))) showResume();
  }, 400);
});

// ---------------------------------------------------------------- dark screen

const darkEl = $('#dark');
const darkClock = $('#darkClock');
const darkHint = $('#darkHint');
const darkCanvas = $('#darkOrbit');
let hintT = null;
let lastTap = 0;

function showDarkHint() {
  darkHint.classList.remove('dim');
  darkClock.classList.remove('dim');
  clearTimeout(hintT);
  hintT = setTimeout(() => {
    darkHint.classList.add('dim');
    darkClock.classList.add('dim');
  }, 4000);
}
$('#darkBtn').addEventListener('click', () => {
  darkEl.hidden = false;
  showDarkHint();
  drawDarkOnce();
});
darkEl.addEventListener('click', () => {
  const now = performance.now();
  if (now - lastTap < 420) {
    darkEl.hidden = true;
    lastTap = 0;
    if (!engine.playing) drawStatic();
    return;
  }
  lastTap = now;
  showDarkHint();
});
function drawDarkOnce() {
  if (state.sleep.darkOrbit) drawBubble(darkBubble, darkCanvas, 0.45);
  else {
    const g = darkCanvas.getContext('2d');
    g.clearRect(0, 0, darkCanvas.width, darkCanvas.height);
  }
}

// ---------------------------------------------------------------- the bubble (stage visual)

const orbit = $('#orbit');
const stageBubble = new Bubble();
const darkBubble = new Bubble();

// velocity of strike m of pulse voice vi in the engine's actual pattern (0 = dropped by variation)
let hitPat = null;
let hitMap = null;
function hitVel(vi, m) {
  const pat = engine.pattern;
  if (!pat || !pat.voices[vi]) return null;
  if (pat !== hitPat) {
    hitPat = pat;
    hitMap = new Map();
    pat.hits.forEach((h) => hitMap.set(h.v * 1e6 + h.c * 1e3 + h.h, h.vel));
  }
  const n = pat.voices[vi].hits;
  const c = mod(Math.floor(m / n), pat.K);
  return hitMap.get(vi * 1e6 + c * 1e3 + mod(m, n)) || 0;
}

// which copies of the voice are speaking now, and how far through their words
function voiceShells(now) {
  const vi = engine.voiceInfo;
  const st = engine.state;
  if (!vi || !st.voice.on || st.voice.level < 0.01 || now < vi.start) return [];
  const out = [];
  vi.lens.forEach((len, k) => {
    const into = mod(now - vi.start, len);
    for (const [a, b] of vi.segs) {
      if (into >= a && into < b) {
        const u = (into - a) / Math.max(0.05, b - a);
        out.push({ k, n: vi.lens.length, u, env: Math.sin(Math.PI * u) * Math.min(1.2, st.voice.level / 0.8) });
        break;
      }
    }
  });
  return out;
}

function drawBubble(bub, canvas, alpha) {
  const v = state.visual;
  const playing = engine.playing && engine.ctx;
  const st = playing ? engine.state : state;
  const mode = v.color === 'auto' ? (state.sleep.timer > 0 ? 'night' : 'wheel') : v.color;
  let t = 0.3;
  let wind = 0;
  let shells = [];
  if (playing) {
    const now = engine.time;
    t = now - engine.t0;
    if (engine.timerEnd && st.sleep.winddown) wind = Math.min(1, Math.max(0, (now - engine.sessionStart) / (engine.timerEnd - engine.sessionStart)));
    shells = voiceShells(now);
  }
  bub.draw(canvas, {
    st,
    t,
    mode,
    hueFrom: v.hue,
    alpha: v.on ? (alpha * v.level) / 0.7 : 0,
    wind,
    layers: { skin: v.skin, balls: v.balls, star: v.star, knot: v.knot, echoes: v.echoes, haze: v.haze },
    hitVel: playing ? hitVel : null,
    shells,
  });
}

function drawStatic() {
  drawBubble(stageBubble, orbit, 1);
}

let raf = null;
let lastFrame = 0;
function frame(ts) {
  raf = requestAnimationFrame(frame);
  // the dark screen is drawn at half the rate to save battery
  if (ts - lastFrame < (darkEl.hidden ? 32 : 66)) return;
  lastFrame = ts;
  if (!darkEl.hidden) {
    if (state.sleep.darkOrbit) drawBubble(darkBubble, darkCanvas, 0.45);
  } else drawBubble(stageBubble, orbit, 1);
}
function startLoop() {
  if (!raf) raf = requestAnimationFrame(frame);
}
function stopLoop() {
  if (raf) cancelAnimationFrame(raf);
  raf = null;
}
window.addEventListener('resize', () => !engine.playing && drawStatic());

// ---------------------------------------------------------------- presets

const presetScrim = $('#presetScrim');
const presetList = $('#presetList');

function renderPresets() {
  presetList.textContent = '';
  const mk = (p, user) => {
    const row = el('div', 'preset');
    const main = el('button', 'preset-main');
    main.append(el('b', null, p.name));
    if (p.note) main.append(el('span', null, p.note));
    main.addEventListener('click', () => applyPreset(p.s, p.name));
    row.append(main);
    if (user) {
      const del = el('button', 'icon-btn');
      del.innerHTML = ICON.trash;
      del.setAttribute('aria-label', `Delete preset ${p.name}`);
      del.addEventListener('click', () => {
        userPresets = userPresets.filter((x) => x !== p);
        LS.set('lull.presets', userPresets);
        renderPresets();
      });
      row.append(del);
    }
    return row;
  };
  BUILTIN.forEach((p) => presetList.append(mk(p, false)));
  if (userPresets.length) {
    presetList.append(el('h3', 'group', 'Yours'));
    userPresets.forEach((p) => presetList.append(mk(p, true)));
  }
}

function applyPreset(s, name) {
  const keepSel = state.voice.selected.slice();
  const keepCue = state.sleep.lucidCue;
  const keepDarkOrbit = state.sleep.darkOrbit;
  const keepVisual = clone(state.visual);
  state = merge(DEFAULTS, s);
  // the visual is a viewing preference, so presets only change it if they say so
  state.visual = s.visual ? merge(keepVisual, s.visual) : keepVisual;
  const sel = (s.voice && s.voice.selected ? s.voice.selected : keepSel).filter((id) => mantras.has(id));
  state.voice.selected = sel.length || !(s.voice && s.voice.selected) ? sel : keepSel.filter((id) => mantras.has(id));
  if (!(s.sleep && s.sleep.lucidCue && mantras.has(s.sleep.lucidCue))) state.sleep.lucidCue = mantras.has(keepCue) ? keepCue : 'chime';
  if (!(s.sleep && 'darkOrbit' in s.sleep)) state.sleep.darkOrbit = keepDarkOrbit;
  LS.set('lull.state', state);
  presetScrim.hidden = true;
  updateChips();
  updateTabs();
  renderPanel();
  renderPieceEditor();
  if (engine.playing) {
    engine.stop(0.8);
    play();
  } else drawStatic();
  updateClock();
  toast(`${name} loaded.`);
}

$('#presetsBtn').addEventListener('click', () => {
  renderPresets();
  presetScrim.hidden = false;
});
presetScrim.addEventListener('click', (e) => {
  if (e.target === presetScrim || e.target.closest('[data-close]')) presetScrim.hidden = true;
});
$('#presetSave').addEventListener('click', () => {
  const input = $('#presetName');
  const name = input.value.trim() || `Sound ${userPresets.length + 1}`;
  userPresets.push({ name, note: '', s: clone(state) });
  LS.set('lull.presets', userPresets);
  input.value = '';
  renderPresets();
  toast(`Saved ${name}.`);
});

// ---------------------------------------------------------------- cue preview, toast

function previewCue() {
  const s = state.sleep;
  const m = s.lucidCue !== 'chime' ? mantras.get(s.lucidCue) : null;
  const data = makeCueData(m ? 'mantra' : 'chime', SR_STORE, state.root, m && m.pcm);
  const g = s.lucidLevel * s.lucidLevel * 1.2;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] * Math.min(1, g * 1.4);
  playPCM(out, 'cue');
}

let toastEl = null;
let toastT = null;
function toast(msg) {
  if (!toastEl) {
    toastEl = el('div', 'toast');
    toastEl.setAttribute('role', 'status');
    document.body.append(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (toastEl.hidden = true), 4200);
}

// ---------------------------------------------------------------- start

async function init() {
  updateChips();
  updateTabs();
  renderPanel();
  updateClock();
  requestAnimationFrame(drawStatic);
  store.requestPersistence();
  try {
    const rows = await store.listMantras();
    rows.forEach((r) => mantras.set(r.id, { id: r.id, name: r.name, created: r.created, pcm: store.toFloat32(new Int16Array(r.pcm)) }));
  } catch (e) {
    toast('Saved recordings could not be opened.');
  }
  state.voice.selected = state.voice.selected.filter((id) => mantras.has(id));
  if (state.sleep.lucidCue !== 'chime' && !mantras.has(state.sleep.lucidCue)) state.sleep.lucidCue = 'chime';
  renderPanel();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();

// exposed for testing
window.__lull = { engine, get state() { return state; }, mantras, addMantra };
