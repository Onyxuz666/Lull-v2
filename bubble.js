// Lull bubble: the stage visual, drawn from the live sound.
//
// - Skin: a sphere of points with real thin-film interference colors. The root partial makes the
//   whole bubble breathe; each higher partial drives one spherical-harmonic vibration mode.
//   Night mode shows the film under a single amber wavelength (a sodium lamp), so no blue light.
// - Bouncing tones: one ball per pulse ring, bouncing inside the bubble. A ball bouncing in a sphere
//   stays in one plane, so n evenly spaced hits per lap trace a polygon or a star {n/p}. Each hit
//   sends a ripple across the skin that refocuses at the opposite point, and each ball leaves an
//   afterimage of its last lap.
// - Knot: the drone's partials as a 3D harmonograph, grown until it presses on the skin. Strikes pluck
//   it, voice shells light it.
// - Voice echoes: each copy of the voice, while it speaks, sends a shell out from the centre.
// - Haze: the noise waves, swelling once per cycle.
//
// Nothing here flashes faster than about once a second, and the beats are never drawn.

import { RHYTHMS, CHORDS, fieldRates, droneAmps, shapePower } from './engine.js';

const TAU = Math.PI * 2;
const mod = (a, n) => ((a % n) + n) % n;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const gcd = (x, y) => (y ? gcd(y, x % y) : x);

// one spherical-harmonic mode per partial (degree l, order m): higher partials, finer modes
const MODES = [
  [2, 2],
  [3, 1],
  [4, 0],
  [5, 5],
  [6, 3],
  [7, 0],
];

// OKLCH to sRGB (0..255), with chroma reduced until the color is in gamut
export function oklchToRgb(L, C, h) {
  const conv = (c) => {
    const a = c * Math.cos((h * Math.PI) / 180);
    const b = c * Math.sin((h * Math.PI) / 180);
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
  };
  let lo = 0;
  let hi = C;
  let v = conv(C);
  const ok = (x) => x.every((q) => q >= -0.0005 && q <= 1.0005);
  if (!ok(v)) {
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) / 2;
      if (ok(conv(mid))) lo = mid;
      else hi = mid;
    }
    v = conv(lo);
  }
  return v.map((x) => {
    x = clamp01(x);
    const g = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    return Math.round(g * 255);
  });
}

// associated Legendre function P_l^m(x)
function legendre(l, m, x) {
  let pmm = 1;
  if (m > 0) {
    const sq = Math.sqrt(Math.max(0, (1 - x) * (1 + x)));
    let f = 1;
    for (let i = 1; i <= m; i++) {
      pmm *= -f * sq;
      f += 2;
    }
  }
  if (l === m) return pmm;
  let pmm1 = x * (2 * m + 1) * pmm;
  if (l === m + 1) return pmm1;
  let pll = 0;
  for (let ll = m + 2; ll <= l; ll++) {
    pll = (x * (2 * ll - 1) * pmm1 - (ll + m - 1) * pmm) / (ll - m);
    pmm = pmm1;
    pmm1 = pll;
  }
  return pll;
}

// Fibonacci sphere with a small fixed jitter, plus the vibration modes evaluated at each point
function makePoints(N) {
  const px = new Float32Array(N);
  const py = new Float32Array(N);
  const pz = new Float32Array(N);
  const tf = new Float32Array(N);
  const tp = new Float32Array(N);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const jit = 1.6 / Math.sqrt(N);
  for (let i = 0; i < N; i++) {
    const j1 = (((i * 0.569840291) % 1) - 0.5) * jit;
    const j2 = (((i * 0.8191725134) % 1) - 0.5) * jit;
    const y = Math.max(-1, Math.min(1, 1 - (2 * (i + 0.5)) / N + j1));
    const rr = Math.sqrt(1 - y * y);
    const ph = i * golden + j2 / Math.max(0.2, rr);
    px[i] = Math.cos(ph) * rr;
    py[i] = y;
    pz[i] = Math.sin(ph) * rr;
    tf[i] = 0.4 + ((i * 0.6180339887) % 1) * 1.1;
    tp[i] = ((i * 0.7548776662) % 1) * TAU;
  }
  const Sc = [];
  const Ss = [];
  MODES.forEach(([l, m]) => {
    const a = new Float32Array(N);
    const b = new Float32Array(N);
    let mx = 1e-9;
    for (let i = 0; i < N; i++) {
      const P = legendre(l, m, py[i]);
      const phi = Math.atan2(pz[i], px[i]);
      a[i] = P * Math.cos(m * phi);
      b[i] = m ? P * Math.sin(m * phi) : 0;
      if (Math.abs(P) > mx) mx = Math.abs(P);
    }
    for (let i = 0; i < N; i++) {
      a[i] /= mx;
      b[i] /= mx;
    }
    Sc.push(a);
    Ss.push(b);
  });
  return { N, px, py, pz, tf, tp, Sc, Ss };
}

export class Bubble {
  constructor() {
    this._pts = null;
    this._c = null;
    this._key = null;
    this._grads = null;
    this._off = null;
  }

  // st: sound state (cycle, rhythm, chord, root, drone, pulse, voice, noise)
  _cfg(st, o, size) {
    const wind = Math.round(clamp01(o.wind || 0) * 200) / 200;
    const key = [o.mode, o.hueFrom, st.rhythm, st.chord, st.root, st.pulse.register, st.pulse.density, st.drone.depth, st.drone.shape, wind, size, o.star].join('|');
    if (this._key === key && this._c) return this._c;
    const r = RHYTHMS[st.rhythm] || RHYTHMS['3:4:5'];
    const ch = CHORDS[st.chord] || CHORDS.overtone;
    const field = ch.field;
    const rates = fieldRates(st.rhythm, field.length);
    const amps = droneAmps(st.chord);
    // just-intonation ratios as whole numbers (1.5 : 2 becomes 3 : 4)
    const den = (x) => {
      for (let d = 1; d <= 24; d++) if (Math.abs(x * d - Math.round(x * d)) < 1e-6) return d;
      return 1;
    };
    let D = 1;
    field.forEach((f) => {
      const d = den(f);
      D = (D * d) / gcd(D, d);
    });
    let ks = field.map((f) => Math.round(f * D));
    const g = ks.reduce((x, y) => gcd(x, y));
    ks = ks.map((k) => k / g);
    // the key sets the starting hue, by the circle of fifths
    const midi = Math.round(69 + 12 * Math.log2(st.root / 440));
    const pc = mod(midi, 12);
    const hue0 = o.hueFrom === 'fixed' ? 25 : 25 + ((pc * 7) % 12) * 30;
    const wheel = o.mode === 'wheel';
    const lk = 1 - 0.42 * wind;
    const ck = 1 - 0.55 * wind;
    // hue at angle a (radians, 0 = top). Night keeps to the ember band.
    const hueAt = wheel ? (a) => hue0 + (a * 180) / Math.PI : (a) => 46 + 14 * Math.cos(a);
    const col = (a, L, C) => oklchToRgb(L * lk, C * ck, hueAt(a));
    const starStep = (n) => {
      if (o.star === false) return 1;
      let q = Math.min(Math.floor((n - 1) / 2), Math.ceil(n / 3.5));
      while (q > 1 && gcd(n, q) !== 1) q--;
      return Math.max(1, q);
    };
    const nv = r.length;
    const voices = r.map((n0, i) => {
      const n = n0 * st.pulse.density;
      // each ball bounces in its own plane through the vertical axis, so all meet at the top
      const beta = (Math.PI * (i + 0.5)) / nv;
      const ex = Math.cos(beta);
      const ez = Math.sin(beta);
      const verts = [];
      for (let k = 0; k < n; k++) {
        const a = (TAU * k) / n;
        verts.push({ a, x: Math.sin(a) * ex, y: Math.cos(a), z: Math.sin(a) * ez });
      }
      const ratio = ch.pulse[i % ch.pulse.length];
      const freq = st.root * st.pulse.register * ratio;
      const u = clamp01(Math.log2(freq / 196) / 2.5);
      const step = starStep(n);
      let pinv = 1;
      while ((pinv * step) % n !== 1 % n && pinv < n) pinv++;
      return { n, p: step, pinv, verts, L: 0.56 + 0.22 * u, sz: 1.25 - 0.5 * u, kh: Math.max(2, Math.round(ratio)) };
    });
    this._c = { field, rates, amps, ks, voices, wheel, wind, col, hue0, kmax: Math.max(...ks), shapeP: shapePower(st.drone.shape), depth: st.drone.depth };
    this._key = key;
    this._grads = null;
    return this._c;
  }

  // Draw one frame.
  // o = {
  //   st,        sound state
  //   t,         seconds since the cycle origin (engine.time - engine.t0)
  //   mode,      'night' | 'wheel'
  //   hueFrom,   'key' | 'fixed'
  //   alpha,     overall brightness (1 = normal)
  //   wind,      0..1 progress of the wind-down
  //   layers,    { skin, balls, star, knot, echoes, haze } booleans
  //   hitVel,    (voiceIndex, strikeIndex) => velocity, 0 for a dropped strike (optional)
  //   shells,    [{ k, n, u, env }] voice copies speaking now (u = progress through the words)
  // }
  draw(cv, o) {
    if (!cv || !cv.getContext) return;
    const size = cv.clientWidth || 300;
    const dpr = Math.min(2, 900 / size, window.devicePixelRatio || 1);
    const W = Math.round(size * dpr);
    if (cv.width !== W || cv.height !== W) {
      cv.width = W;
      cv.height = W;
      this._grads = null;
    }
    const ctx = cv.getContext('2d');
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, W, W);
    if (!o.alpha) return;

    const st = o.st;
    const L = o.layers || {};
    const c = this._cfg(st, { mode: o.mode, hueFrom: o.hueFrom, wind: o.wind, star: L.star }, size);
    const N = Math.round(Math.min(4200, Math.max(1800, 1600 + size * 4)));
    if (!this._pts || this._pts.N !== N) this._pts = makePoints(N);
    const P = this._pts;
    const T = st.cycle;
    const t = o.t;
    const cx = W / 2;
    const cy = W / 2;
    const R = W * 0.4;
    const s = W / 600;
    const ga = o.alpha * (1 - 0.3 * c.wind);
    const rgba = (v, a) => `rgba(${v[0]},${v[1]},${v[2]},${clamp01(a * ga)})`;
    const droneOn = st.drone.on && st.drone.level > 0.01;
    const pulseOn = st.pulse.on && st.pulse.level > 0.01;
    const noiseOn = st.noise.on && st.noise.level > 0.01;
    if (!this._grads) {
      const gr = ctx.createConicGradient(-Math.PI / 2, cx, cy);
      const Lf = c.wheel ? 0.82 : 0.78;
      const Cf = c.wheel ? 0.13 : 0.14;
      for (let i = 0; i <= 36; i++) {
        const v = c.col((i / 36) * TAU, Lf, Cf);
        gr.addColorStop(i / 36, `rgb(${v[0]},${v[1]},${v[2]})`);
      }
      this._grads = { fig: gr };
    }

    // drone swells (same law as the engine's LFOs): fsw = pure swell 0..1, sw = partial's level
    const depth = droneOn ? c.depth : 0;
    const fsw = c.field.map((_, j) => Math.pow((1 + Math.cos((TAU * c.rates[j] * t) / T)) / 2, c.shapeP));
    const sw = fsw.map((f, j) => {
      const d = c.depth * (j === 0 ? 0.4 : 1);
      return 1 - d + d * f;
    });

    // the bubble turns slowly about the vertical, tilted so its top faces us a little
    const spin = (TAU * t) / (T * 4);
    const sA = Math.sin(spin);
    const cA = Math.cos(spin);
    const sT = Math.sin(0.36);
    const cT = Math.cos(0.36);
    const F = 5;
    const toScreen = (x, y, z, rad) => {
      const x1 = x * cA + z * sA;
      const z1 = -x * sA + z * cA;
      const yw = y * cT - z1 * sT;
      const zw = y * sT + z1 * cT;
      const k = F / (F - zw * rad);
      return [cx + x1 * R * rad * k, cy - yw * R * rad * k, zw];
    };
    // the root partial makes the whole bubble breathe
    const breath = 0.035 * depth * (fsw[0] - 0.5);

    // strikes: every impact of the last few seconds, with the ripple it sent across the skin
    const events = [];
    if (pulseOn) {
      c.voices.forEach((vo, vi) => {
        const n = vo.n;
        const dtH = T / n;
        const mNow = Math.floor(t / dtH + 1e-9);
        for (let b = 0; b < n * 4; b++) {
          const m = mNow - b;
          const tau = t - m * dtH;
          if (tau > 3.4) break;
          const mm = mod(m, n);
          let vel = o.hitVel ? o.hitVel(vi, m) : null;
          if (vel == null) vel = mm === 0 ? 1 : 0.62;
          if (!vel) continue; // a strike the variation dropped: the ball bounces silently
          const V = vo.verts[(mm * vo.p) % n];
          const gf = Math.PI * Math.min(1, tau / 2.3);
          let amp = (vel * 0.45 * Math.exp(-tau / 2.4)) / Math.sqrt(0.2 + Math.sin(gf));
          if (tau > 2.3) amp *= Math.exp(-(tau - 2.3) / 0.35);
          events.push({ x: V.x, y: V.y, z: V.z, a: V.a, tau, vel, gf, amp, L: vo.L, kh: vo.kh });
        }
      });
    }

    // voice shells (they also light the knot)
    const shells = L.echoes === false ? [] : (o.shells || []).map((sh) => ({ ...sh, r: (0.12 + 0.86 * sh.u) * (1 + breath) }));

    // the knot: a 3D harmonograph, partials shared between the three axes
    let knot = null;
    let contacts = [];
    if (L.knot !== false && droneOn) {
      const Nk = Math.min(2400, 140 * c.kmax + 240);
      const ph = c.rates.map((rt) => (TAU * rt * t) / T);
      const A = c.amps.map((a, j) => a * sw[j]);
      const nrm = [0, 0, 0];
      const liv = [0, 0, 0];
      c.amps.forEach((a, j) => (nrm[j % 3] += a));
      A.forEach((a, j) => (liv[j % 3] += a));
      for (let q = 0; q < 3; q++) nrm[q] *= Math.pow(liv[q] / nrm[q], 0.45);
      const Rk = 0.85 * (1 - 0.12 * c.wind);
      // each recent strike plucks the knot, which rings for a moment: more ripples for higher tones
      const plucks = [];
      events.forEach((E) => {
        if (E.tau < 1.6) plucks.push({ k: E.kh * 2, a: 0.06 * E.vel * Math.exp(-E.tau / 0.55) * Math.cos(TAU * 1.2 * E.tau), o: E.a });
      });
      const r0 = 0.6;
      const rmax = 0.94;
      const kx = new Float32Array(Nk + 1);
      const ky = new Float32Array(Nk + 1);
      const kz = new Float32Array(Nk + 1);
      const kr = new Float32Array(Nk + 1);
      for (let i = 0; i <= Nk; i++) {
        const th = (TAU * i) / Nk;
        let x = 0;
        let y = 0;
        let z = 0;
        for (let j = 0; j < A.length; j++) {
          const v = A[j] * Math.sin(c.ks[j] * th + ph[j]);
          const ax = j % 3;
          if (ax === 0) x += v;
          else if (ax === 1) y += v;
          else z += v;
        }
        x = (x / nrm[0]) * Rk;
        y = (y / nrm[1]) * Rk;
        z = (z / nrm[2]) * Rk;
        const r = Math.sqrt(x * x + y * y + z * z) + 1e-9;
        let f = 1;
        for (let q = 0; q < plucks.length; q++) f += plucks[q].a * Math.sin(plucks[q].k * th + plucks[q].o);
        const rp = r * f;
        // a soft wall: past r0 the knot is squeezed so it never pokes through the skin
        const r2 = rp < r0 ? rp : r0 + (rmax - r0) * Math.tanh((rp - r0) / (rmax - r0));
        const sc = r2 / r;
        kx[i] = x * sc;
        ky[i] = y * sc;
        kz[i] = z * sc;
        kr[i] = r2;
      }
      // where the knot reaches the skin, it touches it
      const stride = Math.max(1, Math.floor(Nk / 160));
      for (let i = 0; i < Nk; i += stride) {
        if (kr[i] > 0.8) contacts.push({ x: kx[i] / kr[i], y: ky[i] / kr[i], z: kz[i] / kr[i], w: (kr[i] - 0.8) / (rmax - 0.8) });
      }
      if (contacts.length > 28) contacts = contacts.sort((a, b) => b.w - a.w).slice(0, 28);
      knot = { Nk, kx, ky, kz, kr, lv: Math.min(1.3, st.drone.level / 0.6) };
    }

    ctx.globalCompositeOperation = 'lighter';

    // noise waves: a haze around the bubble that swells once per cycle
    if (L.haze !== false && noiseOn && st.noise.waves > 0.01) {
      const nw = Math.pow((1 + Math.cos((TAU * t) / T)) / 2, 1.66);
      const k = Math.min(1, st.noise.waves * 1.6);
      const hv = c.wheel ? oklchToRgb(0.5, 0.03, 290) : c.col(0, 0.5, 0.1);
      const hz = ctx.createRadialGradient(cx, cy, R * 0.95, cx, cy, R * 1.24);
      hz.addColorStop(0, rgba(hv, 0));
      hz.addColorStop(0.3, rgba(hv, (0.05 + 0.1 * nw) * k));
      hz.addColorStop(1, rgba(hv, 0));
      ctx.fillStyle = hz;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.24, 0, TAU);
      ctx.fill();
    }

    // the skin: thin-film interference on a vibrating sphere of points
    if (L.skin !== false) {
      const Ws = Math.max(64, Math.round(W * 0.5));
      if (!this._off || this._off.width !== Ws) {
        this._off = document.createElement('canvas');
        this._off.width = Ws;
        this._off.height = Ws;
        this._octx = this._off.getContext('2d');
        this._img = this._octx.createImageData(Ws, Ws);
        this._acc = new Float32Array(Ws * Ws * 3);
      }
      const acc = this._acc;
      acc.fill(0);
      const cs = Ws / 2;
      const Rs = R * (Ws / W);
      const night = !c.wheel;
      const nModes = Math.min(MODES.length, c.field.length - 1);
      const mc = [];
      const ms = [];
      for (let j = 0; j < nModes; j++) {
        const cj = 0.042 * depth * Math.sqrt(c.amps[j + 1] / c.amps[1]) * fsw[j + 1];
        const psi = (TAU * c.rates[j + 1] * t) / T / 4;
        mc.push(cj * Math.cos(psi));
        ms.push(cj * Math.sin(psi));
      }
      const { px, py, pz, tf, tp, Sc, Ss } = P;
      const wd = c.wind;
      const gain = 1.8 * ga * (1 - 0.7 * wd);
      const ev = events;
      for (let i = 0; i < N; i++) {
        const x = px[i];
        const y = py[i];
        const z = pz[i];
        let d = breath;
        for (let j = 0; j < nModes; j++) d += mc[j] * Sc[j][i] + ms[j] * Ss[j][i];
        let rp = 0;
        for (let e = 0; e < ev.length; e++) {
          const E = ev[e];
          let dot = x * E.x + y * E.y + z * E.z;
          dot = dot > 1 ? 1 : dot < -1 ? -1 : dot;
          const q = (Math.acos(dot) - E.gf) * 5;
          if (q > -3 && q < 3) rp += E.amp * Math.exp(-q * q);
        }
        // the knot pressing on the skin from inside: a glowing, slightly raised patch
        let tc = 0;
        for (let e = 0; e < contacts.length; e++) {
          const C = contacts[e];
          const dd = 1 - (x * C.x + y * C.y + z * C.z);
          if (dd < 0.12) tc += C.w * Math.exp(-dd * 32);
        }
        if (tc > 1.5) tc = 1.5;
        const rad = 1 + d + 0.035 * rp + 0.03 * tc;
        const x1 = x * cA + z * sA;
        const z1 = -x * sA + z * cA;
        const yw = y * cT - z1 * sT;
        const zw = y * sT + z1 * cT;
        const kp = F / (F - zw * rad);
        const sx = cs + x1 * Rs * rad * kp;
        const sy = cs - yw * Rs * rad * kp;
        // film thickness in nm: drains toward the bottom, swirls, stretched by the vibration
        let h = 470 - 230 * yw + 140 * Math.sin(3.7 * x + 2.1 * y - 0.23 * t) * Math.sin(2.9 * z - 1.7 * y + 0.19 * t) + 1100 * d + 260 * rp + 200 * tc - wd * 260 * (0.6 + 0.4 * yw);
        if (h < 12) h = 12;
        const ci = zw < 0 ? -zw : zw;
        const ct = Math.sqrt(1 - (1 - ci * ci) / 1.7689);
        const opd = TAU * 1.33 * h * ct;
        let cr;
        let cg;
        let cb;
        if (night) {
          // a bubble under a sodium lamp: one wavelength, amber fringes only
          const q = Math.sin(opd / 589);
          const I = 0.05 + 0.95 * q * q;
          cr = I;
          cg = 0.6 * I;
          cb = 0.24 * I;
        } else {
          const a1 = Math.sin(opd / 630);
          const a2 = Math.sin(opd / 532);
          const a3 = Math.sin(opd / 465);
          cr = 0.1 + 0.9 * a1 * a1;
          cg = 0.1 + 0.9 * a2 * a2;
          cb = 0.1 + 0.9 * a3 * a3;
        }
        const fres = 0.26 + 0.74 * Math.pow(1 - ci, 1.7);
        const tw = 0.7 + 0.3 * Math.sin(tf[i] * t + tp[i]);
        // the ripple carries its own light, so it shows on the clear face of the bubble too
        const a = gain * (zw < 0 ? 0.5 : 1) * (fres * tw * (1 + rp) + 2 * rp + 2.6 * tc);
        const ix = Math.floor(sx);
        const iy = Math.floor(sy);
        if (ix < 0 || iy < 0 || ix >= Ws - 1 || iy >= Ws - 1) continue;
        const fx = sx - ix;
        const fy = sy - iy;
        const w00 = (1 - fx) * (1 - fy) * a;
        const w10 = fx * (1 - fy) * a;
        const w01 = (1 - fx) * fy * a;
        const w11 = fx * fy * a;
        let k = (iy * Ws + ix) * 3;
        acc[k] += cr * w00;
        acc[k + 1] += cg * w00;
        acc[k + 2] += cb * w00;
        acc[k + 3] += cr * w10;
        acc[k + 4] += cg * w10;
        acc[k + 5] += cb * w10;
        k += Ws * 3;
        acc[k] += cr * w01;
        acc[k + 1] += cg * w01;
        acc[k + 2] += cb * w01;
        acc[k + 3] += cr * w11;
        acc[k + 4] += cg * w11;
        acc[k + 5] += cb * w11;
      }
      const data = this._img.data;
      for (let q = 0, k = 0, j = 0; q < Ws * Ws; q++, k += 3, j += 4) {
        const r_ = acc[k];
        const g_ = acc[k + 1];
        const b_ = acc[k + 2];
        data[j] = (255 * r_) / (1 + r_);
        data[j + 1] = (255 * g_) / (1 + g_);
        data[j + 2] = (255 * b_) / (1 + b_);
        data[j + 3] = 255;
      }
      this._octx.putImageData(this._img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this._off, 0, 0, W, W);

      // a faint continuous rim, where a real film reflects most
      const rimR = R * (1 + breath);
      const rc = night ? [255, 158, 92] : oklchToRgb(0.84, 0.04, 300);
      const rim = ctx.createRadialGradient(cx, cy, rimR * 0.86, cx, cy, rimR * 1.07);
      rim.addColorStop(0, rgba(rc, 0));
      rim.addColorStop(0.62, rgba(rc, 0.07));
      rim.addColorStop(0.74, rgba(rc, 0.13));
      rim.addColorStop(1, rgba(rc, 0));
      ctx.fillStyle = rim;
      ctx.beginPath();
      ctx.arc(cx, cy, rimR * 1.07, 0, TAU);
      ctx.fill();
    }

    // the voice shells: translucent spheres, clear in the middle, brightest at the edge
    shells.forEach((sh) => {
      const rr = R * sh.r;
      const env = sh.env;
      const v = c.wheel ? oklchToRgb(0.84, 0.07, c.hue0 + (sh.k * 360) / sh.n) : c.col(0, 0.8, 0.1);
      const sg = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr * 1.04);
      sg.addColorStop(0, rgba(v, 0));
      sg.addColorStop(0.7, rgba(v, 0.025 * env));
      sg.addColorStop(0.93, rgba(v, 0.16 * env));
      sg.addColorStop(1, rgba(v, 0));
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.arc(cx, cy, rr * 1.04, 0, TAU);
      ctx.fill();
    });

    // the knot: lit where your voice passes through it, glowing where it presses the skin,
    // and brightening for a moment with every strike
    if (knot) {
      const { Nk, kx, ky, kz, kr } = knot;
      const pts = [];
      for (let i = 0; i <= Nk; i++) pts.push(toScreen(kx[i], ky[i], kz[i], 1));
      let hit = 0;
      events.forEach((E) => (hit += E.vel * Math.exp(-E.tau / 0.4)));
      ctx.strokeStyle = this._grads.fig;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      const chunk = Math.ceil(Nk / 90);
      for (let s0 = 0; s0 < Nk; s0 += chunk) {
        const en = Math.min(Nk, s0 + chunk);
        const mi = (s0 + en) >> 1;
        const dep = 0.3 + 0.7 * clamp01(pts[mi][2] + 0.5);
        const rr = kr[mi];
        let lit = 0;
        shells.forEach((sh) => {
          const q = (rr - sh.r) / 0.07;
          lit += sh.env * Math.exp(-q * q);
        });
        const touch = Math.max(0, (rr - 0.84) / 0.1);
        const kb = (1 + 0.3 * hit + 1.5 * lit + 0.8 * touch) * dep;
        ctx.beginPath();
        ctx.moveTo(pts[s0][0], pts[s0][1]);
        for (let i = s0 + 1; i <= en; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        [
          [7, 0.03],
          [3, 0.085],
          [1.1, 0.58],
        ].forEach(([w, a]) => {
          ctx.globalAlpha = Math.min(1, a * knot.lv * ga * kb);
          ctx.lineWidth = w * s;
          ctx.stroke();
        });
      }
      ctx.globalAlpha = 1;
    }

    // the rhythm: one ball per ring, bouncing inside the bubble from strike to strike
    if (L.balls !== false && pulseOn) {
      const rB = 0.965 * (1 + breath);
      const pl = Math.min(1.3, st.pulse.level / 0.5);
      c.voices.forEach((vo) => {
        const n = vo.n;
        const V = (k) => vo.verts[mod(k, n)];
        const S = (q) => toScreen(q.x, q.y, q.z, rB);
        const dep = (z) => 0.45 + 0.55 * clamp01((z + 1) / 2);
        const dtH = T / n;
        const mNow = Math.floor(t / dtH + 1e-9);
        const fr = t / dtH - mNow;
        // afterimage: every edge crossed in the last lap stays lit, fading with age,
        // so the whole crystal stays in view and is re-inked each time the ball comes round
        for (let k = n; k >= 1; k--) {
          const m = mNow - k;
          const A = V(m * vo.p);
          const B = V((m + 1) * vo.p);
          const age = t - (m + 1) * dtH;
          const e = pl * (0.28 + 0.72 * Math.exp(-age / (0.35 * T)));
          const a = S(A);
          const b = S(B);
          const v = c.col(B.a, Math.min(0.84, vo.L + 0.06), 0.13);
          const dz = dep((a[2] + b[2]) / 2);
          ctx.beginPath();
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
          ctx.strokeStyle = rgba(v, 0.1 * e * dz);
          ctx.lineWidth = 5 * s;
          ctx.stroke();
          ctx.strokeStyle = rgba(v, 0.75 * e * dz);
          ctx.lineWidth = 1.15 * s;
          ctx.stroke();
        }
        // each point keeps an afterglow from its last strike
        for (let k = 0; k < n; k++) {
          const mk = mNow - mod(mNow - k * vo.pinv, n);
          const glow = Math.exp(-(t - mk * dtH) / (0.25 * T));
          const q = S(V(k));
          const v = c.col(V(k).a, Math.min(0.86, vo.L + 0.1 * glow), 0.14);
          ctx.fillStyle = rgba(v, (0.4 + 0.55 * glow) * dep(q[2]));
          ctx.beginPath();
          ctx.arc(q[0], q[1], (1.5 + 1.4 * glow + (k === 0 ? 0.6 : 0)) * s, 0, TAU);
          ctx.fill();
        }
        // the ball, on its straight path from the last strike to the next
        const A = V(mNow * vo.p);
        const B = V((mNow + 1) * vo.p);
        const pos = { x: A.x + (B.x - A.x) * fr, y: A.y + (B.y - A.y) * fr, z: A.z + (B.z - A.z) * fr };
        const a = S(A);
        const b = S(pos);
        const v = c.col(B.a, Math.min(0.86, vo.L + 0.12), 0.13);
        const tg = ctx.createLinearGradient(a[0], a[1], b[0], b[1]);
        tg.addColorStop(0, rgba(v, 0));
        tg.addColorStop(1, rgba(v, 0.9 * dep(b[2])));
        ctx.strokeStyle = tg;
        ctx.lineWidth = 1.6 * s;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
        const gz = 11 * s * vo.sz;
        const bg = ctx.createRadialGradient(b[0], b[1], 0, b[0], b[1], gz);
        bg.addColorStop(0, rgba(v, 0.75 * dep(b[2])));
        bg.addColorStop(1, rgba(v, 0));
        ctx.fillStyle = bg;
        ctx.beginPath();
        ctx.arc(b[0], b[1], gz, 0, TAU);
        ctx.fill();
        ctx.fillStyle = rgba(v, dep(b[2]));
        ctx.beginPath();
        ctx.arc(b[0], b[1], 2.6 * s * vo.sz, 0, TAU);
        ctx.fill();
      });
      // a flash where each tone strikes the skin
      events.forEach((E) => {
        if (E.tau > 1.4) return;
        const q = toScreen(E.x, E.y, E.z, rB);
        const e = Math.exp(-E.tau / 0.45) * E.vel;
        const v = c.col(E.a, Math.min(0.88, E.L + 0.16), 0.12);
        const rr = 22 * s;
        const fg = ctx.createRadialGradient(q[0], q[1], 0, q[0], q[1], rr);
        fg.addColorStop(0, rgba(v, 0.8 * e));
        fg.addColorStop(1, rgba(v, 0));
        ctx.fillStyle = fg;
        ctx.beginPath();
        ctx.arc(q[0], q[1], rr, 0, TAU);
        ctx.fill();
      });
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
}
